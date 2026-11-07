import copy
import unittest

from fastapi.testclient import TestClient

from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.banks import validate_setup
from midibrain.performance.engine import Event
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


def software_profile(mode='cycle', kind='cc'):
    profile = rig_demo_profile()
    setup = profile['bank_setup']
    controller = setup['devices'][0]
    controller.update(layer_mode='software', initial_layer='normal', feedback_output='Twister feedback',
                      layer_switch=dict(type=kind, channel=4, number=119, mode=mode))
    for bank in setup['banks']:
        for control in bank['controls']:
            control['alternate']['source'] = copy.deepcopy(control['normal']['source'])
            control['alternate']['feedback'] = copy.deepcopy(control['normal']['feedback'])
    return profile


class SoftwareLayersTests(unittest.TestCase):
    def test_shared_addresses_follow_one_active_layer_across_every_strip(self):
        sent = []
        engine = BankEngine(software_profile(), sent.append)
        engine.initialize(0)
        for bank in engine.banks.values():
            normal, alternate = bank['controls'][0]['normal'], bank['controls'][0]['alternate']
            source = normal['source']
            engine.handle('twister', Event('control_change', source['channel'], source['cc'], 90), .1)
            for channel in engine.targets(bank):
                self.assertEqual(engine.bank_values[bank['destination'], channel, normal['parameter']], 90)
                self.assertNotEqual(engine.bank_values[bank['destination'], channel, alternate['parameter']], 90)
        engine.handle('twister', Event('control_change', 4, 119, 127), .2)
        self.assertEqual(engine.active_layers['twister'], 'alternate')
        engine.handle('twister', Event('control_change', 4, 119, 127), .3)
        self.assertEqual(engine.active_layers['twister'], 'alternate')
        for bank in engine.banks.values():
            binding = bank['controls'][0]['alternate']
            source = binding['source']
            engine.handle('twister', Event('control_change', source['channel'], source['cc'], 33), .4)
            for channel in engine.targets(bank):
                self.assertEqual(engine.bank_values[bank['destination'], channel, binding['parameter']], 33)
        engine.handle('twister', Event('control_change', 4, 119, 0), .5)
        engine.handle('twister', Event('control_change', 4, 119, 127), .6)
        self.assertEqual(engine.active_layers['twister'], 'normal')

    def test_feedback_only_emits_active_layer_and_refreshes_on_switch(self):
        sent = []
        engine = BankEngine(software_profile(), sent.append)
        engine.initialize(0)
        bank = engine.banks['bank-1']
        normal, alternate = bank['controls'][0]['normal'], bank['controls'][0]['alternate']
        for channel in engine.targets(bank):
            engine.bank_values[bank['destination'], channel, normal['parameter']] = 23
            engine.bank_values[bank['destination'], channel, alternate['parameter']] = 105
        sent.clear()
        engine.refresh_feedback()
        address = normal['feedback']
        values = [message.value for message in sent if (message.destination, message.channel, message.control) == ('feedback:twister', address['channel'], address['cc'])]
        self.assertEqual(values, [23])
        sent.clear()
        engine.select_layer('twister', 'alternate')
        self.assertEqual([message.value for message in sent if (message.destination, message.channel, message.control) == ('feedback:twister', address['channel'], address['cc'])], [105])

    def test_momentary_note_release_and_disconnect_restore_previous_layer(self):
        engine = BankEngine(software_profile('momentary', 'note'), lambda message: None)
        engine.handle('twister', Event('note_on', 4, note=119, velocity=127), 0)
        self.assertEqual(engine.active_layers['twister'], 'alternate')
        engine.handle('twister', Event('note_on', 4, note=119, velocity=0), .1)
        self.assertEqual(engine.active_layers['twister'], 'normal')
        engine.handle('twister', Event('note_on', 4, note=119, velocity=127), .2)
        engine.features.release_controller('twister', .3)
        self.assertEqual(engine.active_layers['twister'], 'normal')

    def test_cc_value_selection_and_startup_layer(self):
        profile = software_profile('value')
        profile['bank_setup']['devices'][0]['initial_layer'] = 'alternate'
        engine = BankEngine(profile, lambda message: None)
        self.assertEqual(engine.active_layers['twister'], 'alternate')
        for value, layer in [(0, 'normal'), (63, 'normal'), (64, 'alternate'), (127, 'alternate')]:
            engine.handle('twister', Event('control_change', 4, 119, value), .1)
            self.assertEqual(engine.active_layers['twister'], layer)

    def test_clashes_remain_invalid_within_a_layer_or_in_hardware_mode(self):
        profile = software_profile()
        validate_setup(profile['bank_setup'])
        duplicate = copy.deepcopy(profile['bank_setup'])
        duplicate['banks'][1]['controls'][0]['normal']['source'] = copy.deepcopy(duplicate['banks'][0]['controls'][0]['normal']['source'])
        with self.assertRaises(ValueError): validate_setup(duplicate)
        profile['bank_setup']['devices'][0]['layer_mode'] = 'hardware'
        with self.assertRaises(ValueError): validate_setup(profile['bank_setup'])

    def test_layer_switch_conflicts_with_controls_actions_shift_and_triggers(self):
        for role in ('control', 'action', 'shift', 'trigger'):
            profile = software_profile()
            engine = BankEngine(profile, lambda message: None)
            profile = engine.settings_profile()
            if role == 'control': profile['bank_setup']['devices'][0]['layer_switch'].update(channel=1, number=0)
            if role == 'action': profile['performance']['actions'].append(dict(controller='twister', type='cc', channel=4, number=119, action='panic'))
            if role == 'shift': profile['performance']['shift'] = dict(controller='twister', type='cc', channel=4, number=119, mode='momentary')
            if role == 'trigger': profile['performance']['mods'][1]['trigger'] = dict(controller='twister', type='cc', channel=4, number=119)
            with self.subTest(role=role), self.assertRaises(ValueError): BankEngine(profile, lambda message: None)

    def test_canvas_switches_are_guarded_and_inactive_control_writes_are_rejected(self):
        session = Session(software_profile(), demo=True)
        session.running = True
        session.engine.initialize(0)
        client = TestClient(create_app(session))
        live = client.get('/api/patch/live').json()
        guard = dict(runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
        control = next(item for item in live['controls'] if item['layer'] == 'alternate' and item['assigned'])
        command = dict(bank=control['bank'], index=control['index'], layer=control['layer'], value=90, expected=control['identity'], **guard)
        self.assertEqual(client.post('/api/bank-control', json=command).status_code, 400)
        self.assertEqual(client.post('/api/patch/layer', json=dict(controller='twister', layer='alternate', **guard)).status_code, 200)
        self.assertEqual(client.post('/api/bank-control', json=command).status_code, 200)
        self.assertEqual(client.post('/api/patch/layer', json=dict(controller='twister', layer='normal', **{**guard, 'runtime_instance': 'stale'})).status_code, 409)
        self.assertEqual(client.post('/api/patch/input', json=dict(controller='twister', type='cc', channel=4, number=119, value=127, **guard)).status_code, 200)
        self.assertEqual(session.engine.active_layers['twister'], 'normal')
        self.assertEqual(client.post('/api/patch/input', json=dict(controller='twister', type='cc', channel=1, number=118, value=127, **guard)).status_code, 400)

    def test_release_is_allowed_after_another_editor_stages_settings(self):
        session = Session(software_profile('momentary'), demo=True)
        session.running = True
        client = TestClient(create_app(session))
        live = client.get('/api/patch/live').json()
        command = dict(controller='twister', type='cc', channel=4, number=119, value=127,
                       runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
        self.assertEqual(client.post('/api/patch/input', json=command).status_code, 200)
        session.next_bank_setup = copy.deepcopy(session.engine.setup)
        self.assertEqual(client.post('/api/patch/input', json=command).status_code, 409)
        self.assertEqual(client.post('/api/patch/input', json={**command, 'value': 0}).status_code, 200)
        self.assertEqual(session.engine.active_layers['twister'], 'normal')

    def test_staged_zero_cannot_write_continuous_inputs_or_select_a_layer(self):
        for action in ('depth', 'release', 'mod_rate', 'mod_amount', 'mod_phase', 'mod_depth', 'mod_release', 'value'):
            with self.subTest(action=action):
                profile = BankEngine(software_profile('value' if action == 'value' else 'cycle'), lambda message: None).settings_profile()
                control = 119 if action == 'value' else 118
                binding = dict(controller='twister', channel=4)
                if action in ('depth', 'release'):
                    profile['bank_setup']['resets'].append(dict(binding, cc=control, action=action, bank='bank-1') if action == 'depth' else dict(binding, cc=control, action=action, min_ms=100, max_ms=3100))
                elif action != 'value':
                    profile['performance']['actions'].append(dict(binding, type='cc', number=control, action=action, mod=1, bank='bank-1'))
                session = Session(profile, demo=True)
                session.running = True
                client = TestClient(create_app(session))
                live = client.get('/api/patch/live').json()
                command = dict(binding, type='cc', number=control, value=127,
                               runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
                self.assertEqual(client.post('/api/patch/input', json=command).status_code, 200)
                before = session.engine.settings_profile()
                layers = dict(session.engine.active_layers)
                session.next_bank_setup = copy.deepcopy(session.engine.setup)
                self.assertEqual(client.post('/api/patch/input', json={**command, 'value': 0}).status_code, 409)
                self.assertEqual(session.engine.settings_profile(), before)
                self.assertEqual(session.engine.active_layers, layers)

    def test_staged_release_requires_a_matching_held_button_or_gate(self):
        for role in ('layer', 'reset', 'shift', 'action', 'gate'):
            with self.subTest(role=role):
                profile = BankEngine(software_profile('momentary'), lambda message: None).settings_profile()
                binding = dict(controller='twister', type='cc', channel=4, number=118)
                if role == 'layer': binding['number'] = 119
                elif role == 'reset': binding['number'] = 8
                elif role == 'shift': profile['performance']['shift'] = dict(binding, mode='momentary')
                elif role == 'action': profile['performance']['actions'].append(dict(binding, action='mod_trigger', mod=0))
                elif role == 'gate':
                    binding['type'] = 'note'
                    profile['performance']['mods'][0]['trigger'] = binding
                session = Session(profile, demo=True)
                session.running = True
                client = TestClient(create_app(session))
                live = client.get('/api/patch/live').json()
                command = dict(binding, value=127, runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
                session.next_bank_setup = copy.deepcopy(session.engine.setup)
                self.assertEqual(client.post('/api/patch/input', json={**command, 'value': 0}).status_code, 409)
                session.next_bank_setup = None
                self.assertEqual(client.post('/api/patch/input', json=command).status_code, 200)
                session.next_bank_setup = copy.deepcopy(session.engine.setup)
                self.assertEqual(client.post('/api/patch/input', json={**command, 'value': 0}).status_code, 200)
                self.assertEqual(client.post('/api/patch/input', json={**command, 'value': 0}).status_code, 409)
                self.assertFalse(session.engine.layer_pressed)
                self.assertFalse(session.engine.reset_pressed)
                self.assertFalse(session.engine.features.pressed)
                self.assertFalse(session.engine.features.shift)
                self.assertTrue(all(not source.gates for source in session.engine.features.sources))

    def test_device_sync_does_not_activate_an_inactive_layer_mapping(self):
        profile = software_profile()
        setup = profile['bank_setup']
        setup['devices'][1]['input'] = 'Device feedback'
        binding = setup['banks'][0]['controls'][0]['alternate']
        binding['device_sync'] = 'link'
        engine = BankEngine(profile, lambda message: None)
        engine.initialize(0)
        parameter = setup['devices'][1]['channels'][0]['parameters'][binding['parameter']]
        event = Event('control_change', parameter['channel'], parameter['cc'], 105)
        engine.handle('l6', event, .1)
        self.assertEqual(engine.bank_values['l6', 1, binding['parameter']], 64)
        engine.select_layer('twister', 'alternate')
        engine.handle('l6', event, .2)
        self.assertEqual(engine.bank_values['l6', 1, binding['parameter']], 105)


if __name__ == '__main__':
    unittest.main()
