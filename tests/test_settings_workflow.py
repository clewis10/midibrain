"""Combined saves, legacy input migration and all three bank MOD controls."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.banks import migrate
from midibrain.performance.engine import Event
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.profile import demo_profile
from midibrain.performance.runtime import Session, run
from midibrain.performance.web import create_app


class SettingsWorkflowTests(unittest.TestCase):
    def session(self, path=None):
        profile = rig_demo_profile()
        profile['ports']['a4_input'] = 'L6:L6 MIDI I/O'
        profile['bank_setup']['devices'][0].update(input='Midi Fighter Twister:Control', feedback_output='Midi Fighter Twister:Control')
        profile['bank_setup']['devices'][1]['output'] = 'L6:L6 Mixer Control'
        session = Session(profile, demo=True, config_path=path)
        session.running = True
        session.engine.initialize(0)
        if path:
            session.demo = False
            path.write_text(json.dumps(session.engine.settings_profile()))
        return session

    def test_combined_controller_and_trigger_save_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'profile.json'
            s = self.session(path)
            original = s.engine
            setup = s.bank_snapshot()['draft']
            setup['devices'].append(dict(id='keys', name='Keys', kind='controller', input='Digitone II:MIDI',
                                         feedback_output=None, controls_per_bank=1, layers=['normal']))
            config = copy.deepcopy(s.engine.features.config)
            config['mods'][0]['trigger']['controller'] = 'keys'
            response = TestClient(create_app(s)).post('/api/settings', json={'banks': setup, 'performance': config})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()['restart_required'])
            self.assertIs(s.engine, original)
            self.assertEqual(s.engine.features.config['mods'][0]['trigger']['controller'], 'a4')
            self.assertEqual(s.performance_snapshot()['draft_config']['mods'][0]['trigger']['controller'], 'keys')
            restored = Session(json.loads(path.read_text()), demo=True)
            self.assertEqual(restored.engine.features.config['mods'][0]['trigger']['controller'], 'keys')
            # A subsequent save must preserve the pending setup and MOD configuration.
            s.save_settings({})
            self.assertEqual(json.loads(path.read_text())['performance']['mods'][0]['trigger']['controller'], 'keys')

    def test_invalid_combined_save_changes_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'profile.json'
            s = self.session(path)
            before = path.read_bytes()
            active = s.engine.settings_profile()
            setup = s.bank_snapshot()['draft']; setup['banks'][0]['name'] = 'Edited'
            config = copy.deepcopy(s.engine.features.config); config['mods'][0]['trigger']['controller'] = 'missing'
            response = TestClient(create_app(s)).post('/api/settings', json={'banks':setup,'performance':config})
            self.assertEqual(response.status_code, 400)
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(s.engine.settings_profile(), active)
            self.assertIsNone(s.next_bank_setup)

    def test_write_failure_does_not_apply_mod_edit(self):
        with tempfile.TemporaryDirectory() as folder:
            s = self.session(Path(folder)/'profile.json')
            active = copy.deepcopy(s.engine.features.config)
            config = copy.deepcopy(active); config['mods'][0]['release_ms'] = 777
            with patch('midibrain.performance.runtime.save', side_effect=OSError('full')):
                response = TestClient(create_app(s)).post('/api/settings', json={'performance':config})
            self.assertEqual(response.status_code, 500)
            self.assertEqual(s.engine.features.config, active)

    def test_mod_only_save_applies_and_persists(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'profile.json'; s = self.session(path)
            config = copy.deepcopy(s.engine.features.config); config['mods'][0]['release_ms'] = 777
            self.assertFalse(s.save_settings({'performance':config})['restart_required'])
            self.assertEqual(s.engine.features.config['mods'][0]['release_ms'], 777)
            self.assertEqual(json.loads(path.read_text())['performance']['mods'][0]['release_ms'], 777)

    def test_simulation_does_not_write_hardware_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'profile.json'; s = self.session(); s.config_path = path
            setup = s.bank_snapshot()['draft']; setup['banks'][0]['name'] = 'Simulated'
            result = s.save_settings({'banks':setup})
            self.assertTrue(result['demo']); self.assertFalse(result['restart_required'])
            self.assertEqual(s.engine.banks['bank-1']['name'], 'Simulated')
            self.assertFalse(path.exists())

    def test_all_mod_amounts_map_from_bank_encoders_and_send_feedback(self):
        for index, parameter in enumerate(('depth', 'mod_depth_2', 'mod_depth_3')):
            with self.subTest(index=index):
                profile = rig_demo_profile()
                profile['bank_setup']['devices'][0]['feedback_output'] = 'Midi Fighter Twister:Control'
                binding = profile['bank_setup']['banks'][0]['controls'][0]['normal']
                binding['parameter'] = parameter
                sent = []; engine = BankEngine(profile, sent.append); engine.initialize(0); sent.clear()
                source = binding['source']; feedback = binding['feedback']
                engine.handle('twister', Event('control_change', source['channel'], control=source['cc'], value=83), 1)
                self.assertAlmostEqual(engine.bank_mod_depth(engine.banks['bank-1'], index), 83/127)
                self.assertTrue(any(m.destination == 'feedback:twister' and m.channel == feedback['channel'] and m.control == feedback['cc'] and m.value == 83 for m in sent))

    def test_migration_is_idempotent_and_trigger_port_belongs_to_controller(self):
        profile = demo_profile(); profile['ports']['a4_input'] = 'Legacy trigger'
        profile['bank_setup'] = migrate(profile)
        engine = BankEngine(profile, lambda _: None)
        saved = engine.settings_profile()
        trigger = next(d for d in saved['bank_setup']['devices'] if d['id'] == 'a4')
        trigger['input'] = 'New trigger'
        restored = BankEngine(saved, lambda _: None)
        self.assertEqual(restored.devices['a4']['input'], 'New trigger')
        self.assertEqual(sum(d['id']=='a4' for d in migrate(saved)['devices']), 1)
        restored.features.config['mods'][0]['trigger'] = None
        saved = restored.settings_profile()
        saved['bank_setup']['devices'] = [d for d in saved['bank_setup']['devices'] if d['id'] != 'a4']
        self.assertNotIn('a4', BankEngine(saved, lambda _: None).devices)

    def test_runtime_uses_controller_port_instead_of_obsolete_trigger_port(self):
        import mido
        from test_patchbay import Port
        seed = self.session()
        profile = seed.engine.settings_profile()
        profile['ports']['a4_input'] = 'Obsolete unplugged port'
        profile['bank_setup']['devices'][-1]['input'] = 'Digitone II:MIDI'
        inputs = {'Midi Fighter Twister:Control': Port(), 'Digitone II:MIDI': Port()}
        outputs = {'Midi Fighter Twister:Control': Port(), 'L6:L6 Mixer Control': Port()}
        class Backend:
            Message = mido.Message
            def get_input_names(self): return list(inputs)
            def get_output_names(self): return list(outputs)
            def open_input(self, name): return inputs[name]
            def open_output(self, name): return outputs[name]
        session = Session(profile, allow_unverified=True)
        run(session, backend=Backend(), duration=.01)
        self.assertIsNone(session.error)
        self.assertEqual(session.active_ports['a4_input'], 'Digitone II:MIDI')
