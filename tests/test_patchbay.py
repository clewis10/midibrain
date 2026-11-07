import copy
import tempfile
import time
import unittest
from pathlib import Path
from collections import deque

import mido
from fastapi.testclient import TestClient

from midibrain.performance.profile import demo_profile, load, validate
from midibrain.performance.routing import empty_routing, validate_routing, PortRouter
from midibrain.performance.runtime import Session, run
from midibrain.performance.web import create_app


def routes():
    return {'clock': {'source': 'L6 MIDI I/O', 'destinations': ['Synth A', 'Synth B'], 'transport': True},
            'cc': [{'source': 'Twister', 'channel': 1, 'cc': 12, 'destinations': [
                {'port': 'Synth A', 'channel': 3, 'cc': 74},
                {'port': 'Synth B', 'channel': 9, 'cc': 20}]}]}


class Port:
    def __init__(self, messages=()):
        self.messages = deque(messages)
        self.sent = []
        self.closed = False
    def send(self, message):
        self.sent.append(message)
    def poll(self):
        return self.messages.popleft() if self.messages else None
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.closed = True


class PatchbayTests(unittest.TestCase):
    def test_clock_monitor_distinguishes_clock_from_transport_and_other_sources(self):
        config = routes(); config['clock']['transport'] = False
        router = PortRouter(config)
        outputs = {name: Port() for name in config['clock']['destinations']}
        for kind, now in [('clock', 1.), ('clock', 1.02), ('stop', 1.03), ('clock', 1.04)]:
            router.handle(config['clock']['source'], mido.Message(kind), outputs, now)
        router.handle('Other', mido.Message('stop'), outputs, 1.05)
        status = router.clock_status(1.1)
        self.assertTrue(status['receiving'])
        self.assertEqual(status['transport_counts'], {'stop': 1})
        self.assertFalse(status['transport_events'][0]['forwarded'])
        self.assertAlmostEqual(status['max_tick_gap_ms'], 20)
        self.assertEqual([m.type for m in outputs['Synth A'].sent], ['clock'] * 3)

    def test_clock_order_transport_and_cc_fanout(self):
        router = PortRouter(routes())
        outputs = {name: Port() for name in ['Synth A', 'Synth B']}
        messages = [mido.Message('start'), *[mido.Message('clock') for _ in range(24)],
                    mido.Message('songpos', pos=123), mido.Message('continue'), mido.Message('stop')]
        for message in messages:
            router.handle('L6 MIDI I/O', message, outputs, time.monotonic())
        for output in outputs.values():
            self.assertEqual(output.sent, messages)
        self.assertEqual(router.clock_ticks, 24)
        router.handle('Other', mido.Message('clock'), outputs, time.monotonic())
        router.handle('Twister', mido.Message('control_change', channel=1, control=12, value=90), outputs, time.monotonic())
        self.assertEqual(len(outputs['Synth A'].sent), len(messages))
        source = mido.Message('control_change', channel=0, control=12, value=90)
        router.handle('Twister', source, outputs, time.monotonic())
        self.assertEqual(outputs['Synth A'].sent[-1], source.copy(channel=2, control=74))
        self.assertEqual(outputs['Synth B'].sent[-1], source.copy(channel=8, control=20))
        self.assertEqual(source.control, 12)
        config = routes(); config['clock']['transport'] = False
        router = PortRouter(config); output = Port()
        for message in messages:
            router.handle('L6 MIDI I/O', message, {'Synth A': output, 'Synth B': Port()}, 0)
        self.assertEqual([m.type for m in output.sent], ['clock'] * 24)

    def test_validation_rejects_cycles_duplicates_and_bad_addresses(self):
        invalid = []
        c = routes(); c['cc'][0]['channel'] = True; invalid.append(c)
        c = routes(); c['cc'][0]['destinations'][0]['cc'] = 120; invalid.append(c)
        c = routes(); c['cc'][0]['destinations'] = []; invalid.append(c)
        c = routes(); c['clock']['destinations'] = ['L6 MIDI I/O']; invalid.append(c)
        c = routes(); c['clock']['source'] = None; invalid.append(c)
        c = routes(); c['cc'].append(copy.deepcopy(c['cc'][0])); invalid.append(c)
        c = routes(); c['cc'].append({'source': 'Synth A', 'channel': 3, 'cc': 74,
                                    'destinations': [{'port': 'Twister', 'channel': 1, 'cc': 12}]}); invalid.append(c)
        for c in invalid:
            with self.subTest(c=c), self.assertRaises(ValueError):
                validate_routing(c)
        self.assertEqual(validate_routing(empty_routing()), empty_routing())

    def test_staging_does_not_change_live_router_and_save_roundtrips(self):
        session = Session(demo_profile(), demo=True)
        session.demo = False
        session.running = True
        session.available_ports = {'inputs': ['L6 MIDI I/O', 'Twister'], 'outputs': ['Synth A', 'Synth B']}
        client = TestClient(create_app(session))
        self.assertEqual(client.post('/api/routing', json=routes()).status_code, 200)
        self.assertEqual(session.port_router.routing, empty_routing())
        self.assertTrue(client.get('/api/routing').json()['restart_required'])
        with tempfile.TemporaryDirectory() as folder:
            session.config_path = Path(folder) / 'test.json'
            self.assertEqual(client.post('/api/save').status_code, 200)
            self.assertEqual(load(session.config_path)['routing'], routes())
        c = routes(); c['clock']['source'] = 'Disconnected'
        self.assertEqual(client.post('/api/routing', json=c).status_code, 400)
        self.assertEqual(session.next_routing, routes())
        self.assertEqual(client.post('/api/routing', json=routes(), headers={'Origin': 'https://other.test'}).status_code, 403)
        self.assertEqual(client.get('/patchbay.js').status_code, 200)

    def test_preserves_preset_and_opens_shared_endpoints_once(self):
        profile = demo_profile()
        profile['ports'] = {'a4_input': 'L6 MIDI I/O', 'twister_input': 'Twister',
                            'l6_output': 'Mixer', 'twister_output': 'Twister'}
        profile['routing'] = routes()
        inputs = {'L6 MIDI I/O': Port([mido.Message('clock') for _ in range(24)]),
                  'Twister': Port([mido.Message('control_change', channel=0, control=12, value=90)])}
        outputs = {name: Port() for name in ['Mixer', 'Twister', 'Synth A', 'Synth B']}
        opened = []
        class Backend:
            Message = mido.Message
            def get_input_names(self): return list(inputs)
            def get_output_names(self): return list(outputs)
            def open_input(self, name): opened.append(('in', name)); return inputs[name]
            def open_output(self, name): opened.append(('out', name)); return outputs[name]
        session = Session(profile, allow_unverified=True)
        run(session, backend=Backend(), duration=.025)
        self.assertEqual(len(opened), len(set(opened)))
        self.assertEqual(len(outputs['Synth A'].sent), 25)
        self.assertEqual(outputs['Synth A'].sent[-1].control, 74)
        self.assertEqual(session.engine.values[1]['aux2'], 90)
        self.assertEqual(session.engine.values[3]['aux2'], 90)
        self.assertTrue(all(p.closed for p in [*inputs.values(), *outputs.values()]))
        self.assertTrue(outputs['Mixer'].sent)

    def test_additional_input_is_opened_and_missing_route_port_sends_nothing(self):
        profile = demo_profile()
        profile['ports'] = {'a4_input': 'Trigger', 'twister_input': 'Twister',
                            'l6_output': 'Mixer', 'twister_output': 'Twister'}
        profile['routing'] = routes()
        profile['routing']['cc'][0]['source'] = 'Extra controller'
        inputs = {'Trigger': Port(), 'Twister': Port(),
                  'L6 MIDI I/O': Port([mido.Message('clock')]),
                  'Extra controller': Port([mido.Message('control_change', control=12, value=50)])}
        outputs = {name: Port() for name in ['Mixer', 'Twister', 'Synth A', 'Synth B']}
        class Backend:
            Message = mido.Message
            def get_input_names(self): return list(inputs)
            def get_output_names(self): return list(outputs)
            def open_input(self, name): return inputs[name]
            def open_output(self, name): return outputs[name]
        run(Session(profile, allow_unverified=True), backend=Backend(), duration=.02)
        self.assertEqual([m.type for m in outputs['Synth A'].sent], ['control_change', 'clock'])
        self.assertEqual(outputs['Synth A'].sent[0].value, 50)
        outputs['Synth A'].sent.clear()
        outputs['Mixer'].sent.clear()
        del inputs['Extra controller']
        with self.assertRaisesRegex(ValueError, 'Missing MIDI input'):
            run(Session(profile, allow_unverified=True), backend=Backend(), duration=.02)
        self.assertEqual(outputs['Mixer'].sent, [])
        self.assertEqual(outputs['Synth A'].sent, [])

    def test_preset_mixer_addresses_cannot_be_overwritten(self):
        profile = demo_profile()
        profile['ports']['l6_output'] = 'Mixer'
        profile['routing'] = routes()
        profile['routing']['cc'][0]['destinations'] = [{'port': 'Mixer', 'channel': 1, 'cc': 6}]
        with self.assertRaisesRegex(ValueError, 'performance preset'):
            validate(profile)
