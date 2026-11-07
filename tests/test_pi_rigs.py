"""Keep the downloadable Pi acceptance rigs importable and their checks truthful."""
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event
from midibrain.performance.rigs import fresh_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app

RIGS = Path(__file__).parent / 'pi-rigs'


def profile(name):
    return json.loads((RIGS / name).read_text())['profile']


class PiAcceptanceRigsTests(unittest.TestCase):
    def test_all_bundles_import_without_changing_the_active_patch(self):
        session = Session(fresh_profile(), demo=True)
        client = TestClient(create_app(session))
        before = client.get('/api/patch/state').json()
        files = sorted(RIGS.glob('*.json'))
        self.assertEqual(len(files), 4)
        for path in files:
            with self.subTest(rig=path.name):
                response = client.post('/api/patch/rig/validate', json=json.loads(path.read_text()))
                self.assertEqual(response.status_code, 200, response.text)
                sent = []
                engine = BankEngine(response.json()['profile'], sent.append)
                engine.initialize(0)
                engine.tick(.01)
                self.assertEqual(sent, [], 'Test rigs must not initialize hardware values')
        self.assertEqual(client.get('/api/patch/state').json(), before)

    def test_layers_use_the_same_knob_without_changing_both_parameters(self):
        e = BankEngine(profile('01-routing-layers.json'), lambda _: None)
        e.handle('twister', Event('control_change', 1, control=0, value=30), .1)
        self.assertEqual(e.bank_values['l6', 1, 'low'], 30)
        self.assertIsNone(e.bank_values['l6', 2, 'low'])
        e.select_layer('twister', 'alternate')
        e.handle('twister', Event('control_change', 1, control=0, value=90), .2)
        self.assertEqual(e.bank_values['l6', 1, 'mid'], 90)
        self.assertEqual(e.bank_values['l6', 1, 'low'], 30)

    def test_operator_ducks_known_level_and_returns_to_it(self):
        sent = []
        e = BankEngine(profile('02-ducking-operators.json'), sent.append)
        e.initialize(0)
        e.handle('twister', Event('control_change', 5, control=4, value=80), .1)
        e.handle('trigger', Event('note_on', 10, note=60, velocity=127), .2)
        e.tick(.21)
        values = lambda: [m.value for m in sent if m.destination == 'l6' and m.control == 83]
        self.assertLess(values()[-1], 80)
        e.handle('trigger', Event('note_off', 10, note=60, velocity=0), .3)
        for i in range(31, 101): e.tick(i / 100)
        self.assertEqual(values()[-1], 80)

    def test_operator_knob_receives_runtime_controller_id(self):
        sent = []
        e = BankEngine(profile('02-ducking-operators.json'), sent.append)
        e.initialize(0)
        e.set_base(('l6', 1, 'level'), 80)
        values = lambda: [m.value for m in sent if m.destination == 'l6' and m.control == 83]
        e.handle('twister', Event('control_change', 1, control=12, value=0), 1.1)
        e.handle('trigger', Event('note_on', 10, note=60, velocity=127), 1.2)
        e.tick(1.21)
        self.assertEqual(values()[-1], 80)

    def test_global_operator_knob_accepts_canvas_input_and_reports_hardware_values(self):
        session = Session(profile('02-ducking-operators.json'), demo=True)
        session.running = True
        client = TestClient(create_app(session))
        live = client.get('/api/patch/live').json()
        body = dict(controller='twister', type='cc', channel=1, number=12, value=0,
                    runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
        response = client.post('/api/patch/input', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        session.engine.handle('twister', Event('control_change', 1, control=12, value=100), session.engine.last_time + .1)
        self.assertIn(dict(controller='twister', type='cc', channel=1, number=12, value=100), client.get('/api/patch/live').json()['inputs'])
        session.engine.handle('twister', Event('control_change', 1, control=13, value=50), session.engine.last_time + .1)
        self.assertEqual(client.post('/api/patch/input', json={**body, 'number': 13}).status_code, 400)
        self.assertEqual(client.post('/api/patch/input', json={**body, 'runtime_instance': 'old'}).status_code, 409)

    def test_operator_signal_input_is_playable_without_an_action_binding(self):
        candidate = profile('02-ducking-operators.json')
        operator = candidate['performance']['operators'][0]
        operator['inputs'] = [dict(type='cc', controller='twister', channel=1, number=13)]
        session = Session(candidate, demo=True)
        session.running = True
        client = TestClient(create_app(session))
        live = client.get('/api/patch/live').json()
        response = client.post('/api/patch/input', json=dict(controller='twister', type='cc', channel=1, number=13, value=127,
                                                           runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision']))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(session.engine.features.op_values, [.5])

    def test_clocked_eq_fixture_reaches_both_ends_and_returns_to_base(self):
        sent = []
        engine = BankEngine(profile('03-snapshots-clock.json'), sent.append)
        engine.initialize(0)
        engine.set_base(('l6', 1, 'low'), 64)
        features = engine.features
        features.request(dict(action='mod_enable', mod=0), 0)
        features.clock_event(SimpleNamespace(type='start'), 0)
        for pulse in range(193):
            now = pulse / 48
            features.clock_event(SimpleNamespace(type='clock'), now)
            engine.tick(now)
        values = [message.value for message in sent if message.destination == 'l6' and message.control == 33]
        self.assertLessEqual(min(values), 1)
        self.assertEqual(max(values), 127)
        features.clock_event(SimpleNamespace(type='stop'), 4.1)
        engine.tick(4.11)
        self.assertEqual([message.value for message in sent if message.destination == 'l6' and message.control == 33][-1], 64)

    def test_snapshot_scope_leaves_channel_two_alone(self):
        e = BankEngine(profile('03-snapshots-clock.json'), lambda _: None)
        e.set_base(('l6', 1, 'low'), 30)
        e.set_base(('l6', 2, 'low'), 55)
        e.features.capture(0)
        e.set_base(('l6', 1, 'low'), 90)
        e.set_base(('l6', 2, 'low'), 77)
        e.features.recall(e.features.captures[0])
        self.assertEqual(e.bank_values['l6', 1, 'low'], 30)
        self.assertEqual(e.bank_values['l6', 2, 'low'], 77)

    def test_strip_snapshot_restores_control_readout_and_controller_feedback(self):
        sent = []
        engine = BankEngine(profile('03-snapshots-clock.json'), sent.append)
        engine.set_base(('l6', 1, 'low'), 30)
        engine.handle('twister', Event('control_change', 2, control=0, value=127), .1)
        engine.handle('twister', Event('control_change', 2, control=0, value=0), .2)
        engine.handle('twister', Event('control_change', 1, control=0, value=90), .3)
        sent.clear()
        engine.handle('twister', Event('control_change', 2, control=1, value=127), .4)
        control = next(item for item in engine.control_states() if item['bank'] == 'bank-1' and item['index'] == 0 and item['layer'] == 'normal')
        self.assertEqual(control['value'], 30)
        self.assertTrue(any(message.destination == 'feedback:twister' and message.control == 0 and message.value == 30 for message in sent))


if __name__ == '__main__':
    unittest.main()
