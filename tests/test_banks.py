import copy
import tempfile
import time
import unittest
from pathlib import Path
import mido
from fastapi.testclient import TestClient
from midibrain.performance.banks import migrate, validate_setup
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import MixerEngine, Event
from midibrain.performance.profile import demo_profile, load, validate
from midibrain.performance.runtime import Session, run
from midibrain.performance.web import create_app


class BankTests(unittest.TestCase):
    def test_legacy_trigger_controller_uses_hardware_name_without_changing_identity(self):
        profile = demo_profile()
        profile['bank_setup'] = migrate(profile)
        device = next(d for d in profile['bank_setup']['devices'] if d['id'] == 'a4')
        device.update(name='Trigger source', input='L6:L6 MIDI I/O Port 28:0')
        updated = next(d for d in migrate(profile)['devices'] if d['id'] == 'a4')
        self.assertEqual(updated['name'], 'L6')
        self.assertEqual(updated['input'], device['input'])
        self.assertEqual(device['name'], 'Trigger source')

    def profile(self):
        profile = demo_profile()
        profile['bank_setup'] = migrate(profile)
        return profile

    def test_migration_preserves_addresses_parameter_names_and_unequal_depths(self):
        profile = demo_profile(); profile['channels'][2]['depth'] = .8
        old = MixerEngine(profile, lambda m: None)
        profile['bank_setup'] = migrate(profile)
        new = BankEngine(profile, lambda m: None)
        old.initialize(0); new.initialize(0)
        for ch in profile['channels']:
            self.assertEqual(new.destination_depth('l6', ch['id']), ch['depth'])
        for channel, cc in [(1, 0), (5, 0), (1, 8), (5, 8), (1, 15)]:
            event = Event('control_change', channel, control=cc, value=93)
            old.handle('twister', event, .01); new.handle('twister', event, .01)
        for cid in old.values:
            for key, value in old.values[cid].items():
                self.assertEqual(new.bank_values['l6', cid, key], value)
        new.set_bank_depth('bank-1', .2)
        self.assertEqual(new.destination_depth('l6', 3), .2)
        self.assertEqual(new.banks['bank-1']['depth_overrides'], {})

    def test_duplicate_rebind_remove_and_overlap(self):
        profile = self.profile(); setup = profile['bank_setup']
        clone = copy.deepcopy(setup['banks'][0]); clone['id'] = 'copied'
        clone['channels'] = [2]; clone['depth'] = .9; clone['depth_overrides'] = {}
        for control in clone['controls']:
            for layer, binding in control.items():
                binding['source']['channel'] = 2 if layer == 'normal' else 6
                binding['feedback']['channel'] = binding['source']['channel']
        setup['banks'].append(clone)
        engine = BankEngine(profile, lambda m: None); engine.initialize(0)
        engine.handle('twister', Event('control_change', 2, control=0, value=111), .01)
        self.assertEqual(engine.bank_values['l6', 2, 'low'], 111)
        self.assertEqual(engine.bank_values['l6', 1, 'low'], 64)
        self.assertEqual(engine.destination_depth('l6', 2), .9)
        setup['banks'] = [clone]; engine = BankEngine(profile, lambda m: None)
        self.assertEqual(engine.destination_depth('l6', 1), 0)
        setup['banks'] = []; engine = BankEngine(profile, lambda m: None)
        self.assertEqual(engine.destination_depth('l6', 2), 0)

    def test_variable_layout_and_destination_count_validate(self):
        profile = self.profile(); setup = profile['bank_setup']
        controller, destination = setup['devices'][:2]
        controller['controls_per_bank'] = 2; controller['alternate'] = False
        for bank in setup['banks']:
            bank['controls'] = [{'normal': c['normal']} for c in bank['controls'][:2]]
        channel = copy.deepcopy(destination['channels'][0]); channel.update(id=7, name='Seventh')
        for param in channel['parameters'].values(): param['channel'] = 2
        channel['volume']['channel'] = 2
        destination['channels'].append(channel)
        setup['banks'][0]['channels'] = [7]; setup['banks'][0]['depth_overrides'] = {}
        validate(profile)
        engine = BankEngine(profile, lambda m: None); engine.initialize(0)
        engine.handle('twister', Event('control_change', 1, control=0, value=99), .01)
        self.assertEqual(engine.bank_values['l6', 7, 'low'], 99)

    def test_conflicts_and_volume_requirements(self):
        setup = self.profile()['bank_setup']
        duplicate = copy.deepcopy(setup['banks'][0]); duplicate['id'] = 'duplicate'
        setup['banks'].append(duplicate)
        with self.assertRaisesRegex(ValueError, 'Duplicate controller'):
            validate_setup(setup)
        setup = self.profile()['bank_setup']; setup['devices'][1]['channels'][0]['volume'] = None
        with self.assertRaisesRegex(ValueError, 'volume mapping'):
            validate_setup(setup)

    def test_api_demo_apply_and_bank_depth_roundtrip(self):
        session = Session(demo_profile(), demo=True); session.running = True
        client = TestClient(create_app(session))
        setup = client.get('/api/banks').json()['draft']
        self.assertEqual(client.post('/api/banks', json=setup).status_code, 200)
        self.assertIsInstance(session.engine, BankEngine)
        self.assertEqual(client.post('/api/bank-depth', json={'bank':'bank-1','depth':.7}).status_code, 200)
        with tempfile.TemporaryDirectory() as folder:
            session.demo = False; session.config_path = Path(folder)/'banks.json'
            self.assertEqual(client.post('/api/save').status_code, 200)
            self.assertEqual(load(session.config_path)['bank_setup']['banks'][0]['depth'], .7)
        before = session.engine.settings_profile()
        setup['banks'][0]['controls'][0]['normal']['source']['channel'] = 99
        self.assertEqual(client.post('/api/banks', json=setup).status_code, 400)
        self.assertEqual(before, session.engine.settings_profile())
        self.assertEqual(client.post('/api/bank-depth', json={'bank':[],'depth':.2}).status_code, 400)

    def test_live_staging_preserves_active_engine_and_file_until_saved(self):
        import json
        profile = demo_profile()
        profile['ports'] = {'a4_input':'Trigger','twister_input':'Controller',
                            'l6_output':'Destination','twister_output':'Controller'}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'live.json'; path.write_text(json.dumps(profile))
            before = path.read_bytes()
            session = Session(profile, config_path=path, allow_unverified=True)
            session.running = True
            session.available_ports = {'inputs':['Trigger','Controller'], 'outputs':['Destination','Controller']}
            client = TestClient(create_app(session)); setup = client.get('/api/banks').json()['draft']
            setup['banks'][0]['name'] = 'Renamed bank'
            self.assertEqual(client.post('/api/banks', json=setup).status_code, 200)
            self.assertNotIsInstance(session.engine, BankEngine)
            self.assertEqual(path.read_bytes(), before)
            state = client.get('/api/banks').json()
            self.assertTrue(state['staged']); self.assertFalse(state['saved'])
            self.assertEqual(client.post('/api/bank-depth', json={'bank':'bank-1','depth':.8}).status_code, 400)
            self.assertEqual(client.post('/api/save').status_code, 200)
            self.assertTrue(client.get('/api/banks').json()['saved'])
            restored = Session(load(path, live=True, allow_unverified=True), allow_unverified=True)
            self.assertIsInstance(restored.engine, BankEngine)
            self.assertEqual(restored.engine.banks['bank-1']['name'], 'Renamed bank')

    def test_envelope_output_and_shutdown_use_defined_ports(self):
        from test_patchbay import Port
        profile = self.profile()
        profile['ports'] = {'a4_input':'Trigger','twister_input':'Old input','l6_output':'Old output','twister_output':'Old feedback'}
        profile['bank_setup']['devices'][0].update(input='Controller', feedback_output='Controller')
        profile['bank_setup']['devices'][1]['output'] = 'Destination'
        inputs = {'Trigger':Port([mido.Message('note_on',channel=4,note=60,velocity=127)]), 'Controller':Port()}
        outputs = {'Controller':Port(),'Destination':Port()}
        class Backend:
            Message = mido.Message
            def get_input_names(self): return list(inputs)
            def get_output_names(self): return list(outputs)
            def open_input(self, name): return inputs[name]
            def open_output(self, name): return outputs[name]
        session = Session(profile, allow_unverified=True)
        run(session,backend=Backend(),duration=.02)
        self.assertTrue(any(m.control==6 and m.value==50 for m in outputs['Destination'].sent))
        self.assertEqual([m.value for m in outputs['Destination'].sent[-6:]],[100]*6)
        self.assertTrue(all(p.closed for p in [*inputs.values(),*outputs.values()]))

class SlotLabelTests(unittest.TestCase):
    def test_label_persists_without_changing_target(self):
        profile=demo_profile();profile['bank_setup']=migrate(profile)
        binding=profile['bank_setup']['banks'][0]['controls'][0]['normal']
        binding['label']='Tone'
        engine=BankEngine(profile,lambda message:None)
        saved=engine.settings_profile()['bank_setup']['banks'][0]['controls'][0]['normal']
        self.assertEqual(saved['label'],'Tone')
        self.assertEqual(saved['parameter'],'low')
        binding['label']=False
        with self.assertRaisesRegex(ValueError,'Slot name'):validate_setup(profile['bank_setup'])
