"""Partial rigs must boot, remain editable, and recover without losing the UI."""
import copy
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import mido
from fastapi.testclient import TestClient

from midibrain.performance import cli
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session, run
from midibrain.performance.web import create_app
from test_patchbay import Port


class Backend:
    Message = mido.Message

    def __init__(self):
        self.inputs = {'Twister': Port()}
        self.outputs = {'Twister': Port(), 'Mixer': Port()}

    def get_input_names(self): return list(self.inputs)
    def get_output_names(self): return list(self.outputs)
    def open_input(self, name): return self.inputs[name]
    def open_output(self, name): return self.outputs[name]


def profile():
    p = rig_demo_profile()
    p['bank_setup']['devices'][0].update(input='Twister', feedback_output='Twister')
    p['bank_setup']['devices'][1]['output'] = 'Mixer'
    p['ports']['a4_input'] = 'Absent A4'
    p['routing'] = {'clock': {'source': 'Twister', 'destinations': ['Move', 'Mixer'], 'transport': True},
                    'cc': []}
    return p


class RecoveryTests(unittest.TestCase):
    def offline(self, session):
        return [e['configured'] for e in session.connection_status['endpoints'] if e['state'] != 'connected']

    def test_missing_controller_and_clock_target_do_not_block_mixer(self):
        backend = Backend()
        backend.inputs['Twister'].messages.append(mido.Message('clock'))
        session = Session(profile(), allow_unverified=True)
        saved = copy.deepcopy(session.engine.settings_profile())
        run(session, backend=backend, duration=.03, allow_missing=True)
        self.assertIn('Absent A4', self.offline(session))
        self.assertIsNone(session.error)
        self.assertIn('Move', self.offline(session))
        self.assertTrue(any(m.type == 'control_change' for m in backend.outputs['Mixer'].sent))
        self.assertTrue(any(m.type == 'clock' for m in backend.outputs['Mixer'].sent))
        self.assertEqual(session.engine.settings_profile(), saved)
        self.assertEqual(session.port_router.routing['clock']['destinations'], ['Mixer'])
        self.assertEqual(session.next_routing['clock']['destinations'], ['Move', 'Mixer'])

    def test_no_usb_devices_still_runs_and_sends_nothing(self):
        backend = Backend(); backend.inputs.clear(); backend.outputs.clear()
        session = Session(profile(), allow_unverified=True)
        run(session, backend=backend, duration=.01, allow_missing=True)
        self.assertEqual(session.sent_count, 0)
        self.assertEqual(session.pending, {})
        self.assertIn('Mixer', self.offline(session))

    def test_feedback_write_failure_does_not_interrupt_controller_or_mixer(self):
        backend = Backend()
        def broken(message): raise OSError('feedback unavailable')
        backend.outputs['Twister'].send = broken
        backend.inputs['Twister'].messages.append(mido.Message('control_change', control=0, value=89))
        session = Session(profile(), allow_unverified=True)
        run(session, backend=backend, duration=.03, allow_missing=True)
        self.assertTrue(any(m.type == 'control_change' and m.control == 33 and m.value == 89
                            for m in backend.outputs['Mixer'].sent))
        endpoints = session.connection_status['endpoints']
        self.assertEqual(next(e for e in endpoints if e['configured']=='Twister' and e['direction']=='input')['state'], 'connected')
        self.assertEqual(next(e for e in endpoints if e['configured']=='Twister' and e['direction']=='output')['state'], 'retrying')
        self.assertIsNone(session.error)

    def test_backend_temporary_ports_do_not_trigger_reconnection(self):
        backend = Backend()
        calls = 0
        def inventory():
            nonlocal calls
            calls += 1
            return list(backend.inputs) + (['RtMidi Input Client:temporary 128:0'] if calls > 1 else [])
        backend.get_input_names = inventory
        session = Session(profile(), allow_unverified=True)
        run(session, backend=backend, duration=1.05, allow_missing=True)
        self.assertGreater(calls, 1)
        self.assertGreater(session.sent_count, 0)
        self.assertIn('Absent A4', self.offline(session))
        self.assertIsNone(session.error)

    def test_inventory_change_recovers_without_reopening_healthy_ports(self):
        backend = Backend()
        original = backend.get_input_names
        calls = 0
        def inventory():
            nonlocal calls
            calls += 1
            if calls == 2:
                backend.inputs['Absent A4'] = Port()
                backend.outputs['Move'] = Port()
            return original()
        backend.get_input_names = inventory
        session = Session(profile(), allow_unverified=True)
        opened = []
        open_input, open_output = backend.open_input, backend.open_output
        def tracked_input(name):
            opened.append(('input', name)); return open_input(name)
        def tracked_output(name):
            opened.append(('output', name)); return open_output(name)
        backend.open_input, backend.open_output = tracked_input, tracked_output
        with patch.object(session.engine, 'initialize', wraps=session.engine.initialize) as initialize:
            run(session, backend=backend, duration=1.2, allow_missing=True)
        self.assertEqual(initialize.call_count, 1)
        self.assertEqual(opened.count(('input', 'Twister')), 1)
        self.assertEqual(opened.count(('output', 'Mixer')), 1)
        self.assertIsNone(session.error)
        self.assertIn('Absent A4', session.active_ports.values())
        self.assertEqual(session.port_router.routing['clock']['destinations'], ['Move', 'Mixer'])

    def test_retry_keeps_same_setup_app_and_recovers(self):
        session = Session(profile(), allow_unverified=True)
        client = TestClient(create_app(session))
        instance = session.instance_id
        calls = []
        def attempt(s, **kwargs):
            calls.append(kwargs)
            self.assertEqual(client.get('/').status_code, 200)
            self.assertEqual(client.get('/api/status').json()['instance_id'], instance)
            if len(calls) == 1:
                raise OSError('USB disappeared while opening')
            run(s, backend=Backend(), duration=.01, allow_missing=True)
        with patch.object(cli, 'run', attempt):
            cli.run_resilient(session, duration=3)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(c['allow_missing'] for c in calls))
        self.assertGreater(session.sent_count, 0)

    def test_offline_settings_save_and_restart_are_available(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'profile.json'
            session = Session(profile(), config_path=path, allow_unverified=True)
            setup = session.bank_snapshot()['draft']
            setup['banks'][0]['name'] = 'Offline edit'
            client = TestClient(create_app(session))
            response = client.post('/api/settings', json={'banks': setup})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(json.loads(path.read_text())['bank_setup']['banks'][0]['name'], 'Offline edit')
            with patch('midibrain.performance.runtime.threading.Timer'):
                self.assertEqual(client.post('/api/restart').status_code, 200)


class EndpointIsolationTests(unittest.TestCase):
    def setUp(self):
        from midibrain.performance.connections import Connections
        self.backend = Backend()
        self.session = Session(profile(), allow_unverified=True)
        self.connections = Connections(self.session, self.backend)
        self.addCleanup(self.connections.close)
        self.connections.refresh()
        self.session.engine.initialize(0)
        self.session.running = True
        self.drain()

    def drain(self):
        for key, message in list(self.session.pending.items()):
            output = self.connections.outputs.get(message.destination)
            if output:
                output.send(mido.Message('control_change', channel=message.channel-1,
                                         control=message.control, value=message.value))
            self.session.pending.pop(key, None)

    def test_failed_output_replays_current_values_without_resetting_other_ports(self):
        from midibrain.performance.engine import CC
        twister = self.connections.outputs['feedback:twister']
        twister_messages = list(self.backend.outputs['Twister'].sent)
        before = self.session.instance_id
        self.session.engine.last_output['l6', 1, 33] = 91
        self.session._queue(CC('l6', 1, 33, 91))
        bad = self.backend.outputs['Mixer']
        def broken(message): raise OSError('USB write failed')
        bad.send = broken
        self.drain()
        self.assertTrue(bad.closed)
        self.assertNotIn('l6', self.connections.outputs)
        self.assertIs(self.connections.outputs['feedback:twister'], twister)
        replacement = Port()
        self.backend.outputs['Mixer'] = replacement
        # The backoff applies only to the failed physical output.
        self.connections.refresh()
        self.assertNotIn('l6', self.connections.outputs)
        with patch('midibrain.performance.connections.time.monotonic', return_value=10**12):
            self.connections.refresh()
        self.drain()
        values = {m.control: m.value for m in replacement.sent}
        self.assertEqual(values[33], 91)
        self.assertEqual(self.backend.outputs['Twister'].sent, twister_messages)
        self.assertEqual(self.session.instance_id, before)
        self.assertTrue(self.session.running)

    def test_bad_clock_destination_does_not_drop_healthy_fanout(self):
        self.backend.outputs['Move'] = Port()
        self.connections.refresh()
        def broken(message): raise RuntimeError('output disconnected')
        self.backend.outputs['Move'].send = broken
        good = self.backend.outputs['Mixer']; good.sent.clear()
        router = self.session.port_router
        router.handle('Twister', mido.Message('clock'), self.connections.all_outputs, 1.)
        self.assertEqual([m.type for m in good.sent], ['clock'])
        self.assertEqual(router.forwarded, 1)
        self.assertTrue(self.session.running)
        self.assertEqual(router.routing['clock']['destinations'], ['Mixer'])

    def test_input_read_failure_releases_only_its_gates_and_preserves_mixer(self):
        self.backend.inputs['Absent A4'] = Port()
        self.connections.refresh()
        engine = self.session.engine
        source = engine.features.sources[0]
        source.trigger(time.monotonic(), 0, key=('a4', 'note', 5, 60))
        source.trigger(time.monotonic(), 0, key=('twister', 'note', 5, 62))
        mixer = self.connections.outputs['l6']
        def broken(): raise OSError('input disconnected')
        self.backend.inputs['Absent A4'].poll = broken
        self.assertIsNone(self.connections.inputs['Absent A4'].poll())
        self.assertNotIn(('a4', 'note', 5, 60), source.gates)
        self.assertIn(('twister', 'note', 5, 62), source.gates)
        self.assertTrue(source.config['enabled'])
        self.assertIs(self.connections.outputs['l6'], mixer)
        self.assertFalse(mixer.port.closed)
        self.assertNotIn('Absent A4', self.session.open_input_names)
        self.assertTrue(self.session.running)

    def test_discovery_failure_keeps_open_connections_and_clears_after_recovery(self):
        mixer = self.connections.outputs['l6']
        with patch.object(self.backend, 'get_input_names', side_effect=OSError('ALSA busy')):
            self.connections.refresh()
        self.assertEqual(self.session.connection_status['discovery_error'], 'ALSA busy')
        self.assertIs(self.connections.outputs['l6'], mixer)
        self.assertTrue(mixer.send(mido.Message('clock')))
        self.connections.refresh()
        self.assertIsNone(self.session.connection_status['discovery_error'])
        self.assertIs(self.connections.outputs['l6'], mixer)

    def test_failed_open_does_not_close_working_outputs(self):
        self.backend.outputs['Move'] = Port()
        original = self.backend.open_output
        def open_output(name):
            if name == 'Move': raise ValueError('MIDI port busy')
            return original(name)
        self.backend.open_output = open_output
        mixer = self.connections.outputs['l6']
        self.connections.refresh()
        self.assertIs(self.connections.outputs['l6'], mixer)
        endpoint = next(e for e in self.session.connection_status['endpoints'] if e['configured'] == 'Move')
        self.assertEqual(endpoint['state'], 'retrying')
        self.assertEqual(endpoint['detail'], 'MIDI port busy')
        self.assertIsNone(self.session.error)

    def test_ambiguous_device_is_not_guessed(self):
        self.connections.close()
        from midibrain.performance.connections import Connections
        p = profile(); p['bank_setup']['devices'][0]['input'] = 'Twister 20:0'
        self.backend.inputs = {'Twister 24:0': Port(), 'Twister 28:0': Port()}
        session = Session(p, allow_unverified=True)
        connections = Connections(session, self.backend)
        try:
            connections.refresh()
            self.assertNotIn('twister_input', session.active_ports)
            self.assertIn('l6_output', session.active_ports)
            endpoint = next(e for e in session.connection_status['endpoints'] if e['configured'] == 'Twister 20:0')
            self.assertEqual(endpoint['state'], 'unavailable')
            self.assertIn('ambiguous', endpoint['detail'])
        finally:
            connections.close()

    def test_physical_endpoint_shared_by_roles_and_routes_opens_once(self):
        self.assertIs(self.connections.outputs['l6'], self.connections.all_outputs['Mixer'])
        self.assertIs(self.connections.inputs['Twister'], self.connections.handles['input', 'Twister'])
        self.assertEqual(len(self.connections.handles), 3)

    def test_disconnected_clock_does_not_stop_free_modulation(self):
        features = self.session.engine.features
        source = features.sources[1]
        source.config.update(enabled=True, timing='free', playback='loop')
        source.active = True
        features.pending = {'kind': 'reset', 'at': 96, 'payload': None}
        del self.backend.inputs['Twister']
        self.connections.refresh()
        self.assertTrue(source.active)
        self.assertTrue(source.config['enabled'])
        self.assertIsNone(features.pending)
        self.assertIsNone(self.session.port_router.routing['clock']['source'])
        self.assertIn('l6', self.connections.outputs)

    def test_unplug_replug_resolves_new_alsa_number_without_resetting_other_outputs(self):
        self.backend.outputs['Move 36:3'] = Port()
        self.connections.routing['clock']['destinations'] = ['Move 36:3', 'Mixer']
        self.connections.requested.discard(('output', 'Move'))
        self.connections.requested.add(('output', 'Move 36:3'))
        self.connections.refresh()
        old = self.backend.outputs.pop('Move 36:3')
        self.backend.outputs['Move 40:3'] = Port()
        mixer = self.connections.outputs['l6']
        self.connections.refresh()
        self.assertTrue(old.closed)
        self.assertIs(self.connections.outputs['l6'], mixer)
        self.assertEqual(self.session.port_router.routing['clock']['destinations'], ['Move 40:3', 'Mixer'])
