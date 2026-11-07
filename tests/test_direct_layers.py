import copy
import unittest

from fastapi.testclient import TestClient
from mido import Message

from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import CC, Event
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.profile import validate
from midibrain.performance.routing import PortRouter
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


class DirectLayerTests(unittest.TestCase):
    def test_page_two_is_a_direct_layer_without_bank_bindings(self):
        profile = rig_demo_profile(page2=True)
        controller = profile['bank_setup']['devices'][0]
        self.assertEqual(controller['layers'], ['normal', 'alternate', 'page2'])
        self.assertEqual(controller['layer_types'], {'page2': 'direct'})
        self.assertTrue(all(set(control) == {'normal', 'alternate'} for bank in profile['bank_setup']['banks'] for control in bank['controls']))
        sent = []
        engine = BankEngine(profile, sent.append)
        engine.initialize(0)
        before = copy.deepcopy(engine.bank_values)
        sent.clear()
        engine.set_direct_control(0, 81)
        self.assertEqual(sent, [CC('L6:L6 MIDI I/O', 16, 70, 81)])
        self.assertEqual(engine.bank_values, before)
        engine.banks['bank-1']['channels'] = [2, 6]
        engine.reset_bank('bank-1')
        self.assertEqual(engine.direct_values, {0: 81})
        sent.clear()
        engine.set_direct_control(0, 32)
        self.assertEqual(sent, [CC('L6:L6 MIDI I/O', 16, 70, 32)])
        engine.handle('twister', Event('control_change', 1, control=16, value=99), .1)
        self.assertEqual(engine.direct_values[0], 99)

    def test_direct_routes_obey_software_layer_switching_and_range(self):
        profile = rig_demo_profile(page2=True)
        profile['bank_setup']['devices'][0]['layer_mode'] = 'software'
        target = profile['routing']['cc'][0]['destinations'][0]
        target.update(min=20, max=100, invert=True)
        sent = []
        engine = BankEngine(profile, sent.append)
        with self.assertRaisesRegex(ValueError, 'inactive'): engine.set_direct_control(0, 0)
        engine.select_layer('twister', 'page2')
        sent.clear()
        engine.set_direct_control(0, 0)
        self.assertEqual(sent, [CC('L6:L6 MIDI I/O', 16, 70, 100)])
        class Output:
            def send(self, message): sent.append(message)
        router = PortRouter(profile['routing'])
        message = Message('control_change', channel=0, control=16, value=0)
        outputs = {'L6:L6 MIDI I/O': Output()}
        sent.clear()
        router.handle(profile['routing']['cc'][0]['source'], message, outputs, .1, {'twister': 'normal'})
        self.assertEqual(sent, [])
        router.handle(profile['routing']['cc'][0]['source'], message, outputs, .2, {'twister': 'page2'})
        self.assertEqual(len(sent), 1)
        self.assertEqual((sent[0].channel, sent[0].control, sent[0].value), (15, 70, 100))

    def test_direct_playback_checks_route_identity_staging_and_active_layer(self):
        profile = rig_demo_profile(page2=True)
        profile['bank_setup']['devices'][0]['layer_mode'] = 'software'
        session = Session(profile, demo=True)
        session.running = True
        client = TestClient(create_app(session))
        live = client.get('/api/patch/live').json()
        command = dict(index=0, value=127, expected=live['direct_controls'][0]['identity'], runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
        self.assertEqual(client.post('/api/patch/thru-control', json=command).status_code, 400)
        session.engine.select_layer('twister', 'page2')
        self.assertEqual(client.post('/api/patch/thru-control', json={**command, 'expected': {}}).status_code, 409)
        self.assertEqual(client.post('/api/patch/thru-control', json={**command, 'runtime_instance': 'old'}).status_code, 409)
        self.assertFalse(session.pending)
        self.assertEqual(client.post('/api/patch/thru-control', json=command).status_code, 200)
        self.assertEqual(session.pending[('L6:L6 MIDI I/O', 16, 70)].value, 127)
        self.assertEqual(client.get('/api/patch/live').json()['direct_controls'][0]['value'], 127)
        session.next_bank_setup = copy.deepcopy(session.engine.setup)
        self.assertEqual(client.post('/api/patch/thru-control', json={**command, 'value': 0}).status_code, 409)
        self.assertEqual(session.engine.direct_values[0], 127)

    def test_invalid_direct_layer_ownership_and_hardware_collisions_are_rejected(self):
        for change in ({'layer': 'normal'}, {'controller': 'missing'}, {'source': 'Other input'}, {'cc': 0}, {'channel': 4, 'cc': 8}):
            with self.subTest(change=change):
                profile = rig_demo_profile(page2=True)
                profile['routing']['cc'][0].update(change)
                with self.assertRaises(ValueError): validate(profile)
        profile = rig_demo_profile(page2=True)
        profile['bank_setup']['devices'][0]['layer_mode'] = 'software'
        profile['routing']['cc'][0]['cc'] = 0
        validate(profile)

    def test_legacy_page_routes_upgrade_in_memory_without_changing_original(self):
        profile = rig_demo_profile(page2=True)
        controller = profile['bank_setup']['devices'][0]
        controller['layers'].remove('page2')
        del controller['layer_types']
        for route in profile['routing']['cc']:
            del route['layer'], route['controller']
        before = copy.deepcopy(profile)
        session = Session(profile, demo=True)
        upgraded = session.engine.settings_profile()
        self.assertEqual(profile, before)
        self.assertEqual(upgraded['bank_setup']['devices'][0]['layer_types'], {'page-2': 'direct'})
        self.assertTrue(all(route['layer'] == 'page-2' for route in upgraded['routing']['cc']))
        self.assertEqual(len(session.engine.direct_routes), 16)


if __name__ == '__main__':
    unittest.main()
