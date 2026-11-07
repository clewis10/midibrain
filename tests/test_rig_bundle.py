import copy
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.routing import empty_routing
from midibrain.performance.web import create_app
from midibrain.performance.rigs import fresh_profile
from midibrain.performance.runtime import run


def hardware_profile():
    profile = rig_demo_profile(page2=True)
    for device in profile['bank_setup']['devices']:
        if device['kind'] == 'controller': device['input'] = f"Input {device['id']}"
        else: device['output'] = f"Output {device['id']}"
    for route in profile['routing']['cc']:
        route['source'] = next(device['input'] for device in profile['bank_setup']['devices'] if device['id'] == route['controller'])
    return profile


class RigBundleTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(rig_demo_profile(page2=True), demo=True)
        self.session.running = True
        self.client = TestClient(create_app(self.session))

    def test_init_is_a_silent_validated_draft_until_apply(self):
        before = self.client.get('/api/patch/state').json()
        result = self.client.post('/api/patch/rig/init', json={})
        self.assertEqual(result.status_code, 200, result.text)
        profile = result.json()['profile']
        self.assertEqual(profile['bank_setup'], dict(devices=[], banks=[], resets=[]))
        self.assertEqual(profile['performance']['mods'], [])
        self.assertEqual(profile['performance']['actions'], [])
        self.assertEqual(profile['routing'], empty_routing())
        self.assertEqual(self.client.get('/api/patch/state').json(), before)
        applied = self.client.post('/api/patch/apply', json=dict(instance_id=before['instance_id'], revision=before['revision'], changes={'profile': profile}))
        self.assertEqual(applied.status_code, 200, applied.text)
        self.session.engine.tick(self.session.engine.last_time + .01)
        for path in ('/', '/api/status', '/api/patch/live', '/api/patch/system', '/api/performance'):
            self.assertEqual(self.client.get(path).status_code, 200, path)
        self.assertEqual(self.session.pending, {})

    def test_fresh_hardware_patch_discovers_ports_without_opening_or_sending(self):
        class Backend:
            def get_input_names(self): return ['Twister input']
            def get_output_names(self): return ['L6 output']
            def open_input(self, name): raise AssertionError('Empty patch must not open inputs')
            def open_output(self, name): raise AssertionError('Empty patch must not open outputs')
        session = Session(fresh_profile(), allow_unverified=True)
        run(session, backend=Backend(), duration=.025, allow_missing=True)
        self.assertEqual(session.sent_count, 0)
        self.assertEqual(session.available_ports, dict(inputs=['Twister input'], outputs=['L6 output']))
        self.assertEqual(session.engine.setup['devices'], [])
        self.assertEqual(session.engine.features.sources, [])

    def test_init_hardware_apply_is_persisted_and_staged_without_touching_active_rig(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rig.json'
            session = Session(hardware_profile(), config_path=path, allow_unverified=True)
            client = TestClient(create_app(session))
            state = client.get('/api/patch/state').json()
            profile = client.post('/api/patch/rig/init', json={}).json()['profile']
            result = client.post('/api/patch/apply', json=dict(instance_id=state['instance_id'], revision=state['revision'], changes={'profile': profile}))
            self.assertEqual(result.status_code, 200, result.text)
            self.assertTrue(result.json()['restart_required'])
            self.assertTrue(session.engine.setup['devices'])
            self.assertEqual(json.loads(path.read_text())['bank_setup']['devices'], [])
            restarted = Session(json.loads(path.read_text()), config_path=path, allow_unverified=True)
            restarted.engine.initialize(0)
            restarted.engine.tick(.01)
            self.assertEqual(restarted.pending, {})

    def test_page_two_demo_matches_saved_pi_routing_without_altering_page_one(self):
        profile = self.session.engine.settings_profile()
        routes = profile['routing']['cc']
        self.assertEqual(len(routes), 16)
        for index, route in enumerate(routes):
            self.assertEqual((route['page'], route['channel'], route['cc']), ('Page 2', 1, 16 + index))
            self.assertEqual(route['destinations'], [dict(port='L6:L6 MIDI I/O', channel=16, cc=70 + index)])
        legacy = rig_demo_profile()
        self.assertEqual(profile['bank_setup']['banks'], legacy['bank_setup']['banks'])
        self.assertFalse(any(binding['cc'] == 12 and binding['channel'] == 4 for binding in profile['bank_setup']['resets']))

    def test_full_profile_and_canvas_validate_without_changing_runtime_then_apply(self):
        state = self.client.get('/api/patch/state').json()
        profile = copy.deepcopy(state['profile'])
        profile.update(update_hz=80, rig_name='Full round trip')
        profile['ports']['a4_input'] = 'Another trigger port'
        layout = dict(version=1, nodes={'ctl:twister': dict(x=10, y=20)}, inputs={}, pages=[], controls={'bank-1:0': dict(kind='fader', centerDetent=False, fillFromCenter=True)})
        bundle = dict(format='midibrain-rig', version=2, profile=profile, layout=layout)
        before = self.session.engine.settings_profile()
        result = self.client.post('/api/patch/rig/validate', json=bundle)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['layout'], layout)
        self.assertEqual(self.session.engine.settings_profile(), before)
        result = self.client.post('/api/patch/apply', json=dict(instance_id=state['instance_id'], revision=state['revision'], changes={'profile': result.json()['profile']}))
        self.assertEqual(result.status_code, 200, result.text)
        exported = self.client.get('/api/patch/state').json()['profile']
        self.assertEqual(exported['rig_name'], 'Full round trip')
        self.assertEqual(exported['update_hz'], 80)
        self.assertEqual(exported['ports']['a4_input'], 'Another trigger port')
        self.assertEqual(exported['routing'], profile['routing'])
        self.assertEqual(self.session.next_ports, exported['ports'])

    def test_invalid_bundle_or_workspace_design_cannot_replace_the_rig(self):
        before = self.session.engine.settings_profile()
        for body in ({'version': 3, 'modules': []}, {'format': 'midibrain-rig', 'version': 2, 'profile': before, 'layout': {'version': 1, 'nodes': []}}, {'version': 1}):
            response = self.client.post('/api/patch/rig/validate', json=body)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(self.session.engine.settings_profile(), before)
        for layout in ({'version': 1, 'nodes': {'ctl:twister': 'bad'}}, {'version': 1, 'nodes': {}, 'controls': []}, {'version': 1, 'nodes': {}, 'inputs': {'twister': 'bad'}}, {'version': 1, 'nodes': {}, 'pages': [None]}):
            response = self.client.post('/api/patch/rig/validate', json=dict(format='midibrain-rig', version=2, profile=before, layout=layout))
            self.assertEqual(response.status_code, 400, response.text)
            self.assertEqual(self.session.engine.settings_profile(), before)

    def test_files_from_an_older_version_are_refused_with_a_clear_message(self):
        before = self.session.engine.settings_profile()
        for body in (copy.deepcopy(before), dict(format='midibrain-rig', version=1, profile=before, layout=None)):
            response = self.client.post('/api/patch/rig/validate', json=body)
            self.assertEqual(response.status_code, 400)
            self.assertIn('older version', response.json()['detail'])
        self.assertEqual(self.session.engine.settings_profile(), before)

    def test_legacy_profile_without_routing_validates_and_applies_in_demo(self):
        for validate_first in (False, True):
            with self.subTest(validate_first=validate_first):
                state = self.client.get('/api/patch/state').json()
                imported = copy.deepcopy(state['profile'])
                imported.pop('routing')
                imported['bank_setup']['banks'][0]['name'] = f'Legacy strip {validate_first}'
                if validate_first:
                    validated = self.client.post('/api/patch/rig/validate', json=dict(format='midibrain-rig', version=2, profile=imported))
                    self.assertEqual(validated.status_code, 200, validated.text)
                    imported = validated.json()['profile']
                    self.assertEqual(imported['routing'], empty_routing())
                self.assertEqual(self.client.get('/api/patch/state').json()['profile'], state['profile'])
                result = self.client.post('/api/patch/apply', json=dict(instance_id=state['instance_id'], revision=state['revision'], changes={'profile': imported}))
                self.assertEqual(result.status_code, 200, result.text)
                self.assertFalse(result.json()['restart_required'])
                exported = self.client.get('/api/patch/state').json()['profile']
                self.assertEqual(exported['routing'], empty_routing())
                self.assertEqual(exported['bank_setup']['banks'][0]['name'], f'Legacy strip {validate_first}')
                self.assertEqual(self.session.next_routing, empty_routing())

    def test_legacy_profile_without_routing_saves_and_stages_before_hardware_restart(self):
        for validate_first in (False, True):
            with self.subTest(validate_first=validate_first), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'rig.json'
                session = Session(hardware_profile(), config_path=path, allow_unverified=True)
                client = TestClient(create_app(session))
                state = client.get('/api/patch/state').json()
                active = session.engine.settings_profile()
                imported = copy.deepcopy(state['profile'])
                imported.pop('routing')
                imported['bank_setup']['banks'][0]['name'] = 'Legacy imported strip'
                if validate_first:
                    validated = client.post('/api/patch/rig/validate', json=dict(format='midibrain-rig', version=2, profile=imported))
                    self.assertEqual(validated.status_code, 200, validated.text)
                    imported = validated.json()['profile']
                result = client.post('/api/patch/apply', json=dict(instance_id=state['instance_id'], revision=state['revision'], changes={'profile': imported}))
                self.assertEqual(result.status_code, 200, result.text)
                self.assertTrue(result.json()['restart_required'])
                self.assertEqual(session.engine.settings_profile(), active)
                saved = json.loads(path.read_text())
                self.assertEqual(saved['routing'], empty_routing())
                self.assertEqual(saved['bank_setup']['banks'][0]['name'], 'Legacy imported strip')
                self.assertEqual(session.next_profile, saved)
                self.assertEqual(client.get('/api/patch/state').json()['profile'], saved)

    def test_invalid_routing_import_never_saves_or_stages_partial_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rig.json'
            session = Session(hardware_profile(), config_path=path, allow_unverified=True)
            client = TestClient(create_app(session))
            state = client.get('/api/patch/state').json()
            path.write_text(json.dumps(state['profile']))
            original = path.read_text()
            imported = copy.deepcopy(state['profile'])
            imported['routing'] = None
            imported['bank_setup']['banks'][0]['name'] = 'Must not save'
            result = client.post('/api/patch/apply', json=dict(instance_id=state['instance_id'], revision=state['revision'], changes={'profile': imported}))
            self.assertEqual(result.status_code, 400, result.text)
            self.assertEqual(path.read_text(), original)
            self.assertEqual(client.get('/api/patch/state').json(), state)
            self.assertIsNone(session.next_bank_setup)
            self.assertIsNone(session.next_performance)
            self.assertIsNone(getattr(session, 'next_profile', None))

    def test_hardware_import_stages_complete_profile_and_later_edits_preserve_it(self):
        profile = hardware_profile()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rig.json'
            session = Session(profile, config_path=path, allow_unverified=True)
            client = TestClient(create_app(session))
            state = client.get('/api/patch/state').json()
            imported = state['profile']
            imported.update(update_hz=80, rig_name='Preserve all fields')
            imported['performance']['mods'][1]['enabled'] = True
            validated = client.post('/api/patch/rig/validate', json=dict(format='midibrain-rig', version=2, profile=imported))
            self.assertEqual(validated.status_code, 200, validated.text)
            self.assertTrue(validated.json()['profile']['performance']['mods'][1]['enabled'])
            result = client.post('/api/patch/apply', json=dict(instance_id=state['instance_id'], revision=state['revision'], changes={'profile': imported}))
            self.assertEqual(result.status_code, 200, result.text)
            self.assertTrue(result.json()['restart_required'])
            self.assertEqual(session.engine.profile['update_hz'], 100)
            performance = copy.deepcopy(session.next_performance)
            performance['mods'][1]['name'] = 'Subsequent edit'
            session.save_settings({'performance': performance})
            saved = json.loads(path.read_text())
            self.assertEqual(saved['update_hz'], 80)
            self.assertEqual(saved['rig_name'], 'Preserve all fields')
            self.assertTrue(saved['performance']['mods'][1]['enabled'])
            exported = client.get('/api/patch/state').json()['profile']
            self.assertEqual(exported['update_hz'], 80)
            self.assertEqual(exported['performance']['mods'][1]['name'], 'Subsequent edit')
            session.running = True
            session.command('save')
            self.assertEqual(json.loads(path.read_text())['rig_name'], 'Preserve all fields')


if __name__ == '__main__':
    unittest.main()
