"""The unified workspace reuses the runtime without replacing the classic UI."""
import unittest
import copy

from fastapi.testclient import TestClient

from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


class SurfacesTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(rig_demo_profile(), demo=True)
        self.client = TestClient(create_app(self.session))

    def test_patch_replaces_workspace_and_surface_entrypoints(self):
        original = self.client.get('/')
        lab = self.client.get('/surfaces')
        self.assertEqual(original.status_code, 200)
        self.assertIn('src="/patch.js"', original.text)
        self.assertEqual(lab.status_code, 200)
        self.assertEqual(lab.text, original.text)
        self.assertEqual(self.client.get('/workspace').text, lab.text)
        self.assertNotIn('href="/workspace"', original.text)
        self.assertNotIn('>Classic</a>', original.text)

    def test_assets_are_explicit_and_read_only(self):
        before = self.session.engine.settings_profile()
        for path, content_type in [
            ('/surfaces.js', 'text/javascript'),
            ('/surface-model.mjs', 'text/javascript'),
            ('/surface-runtime.mjs', 'text/javascript'),
            ('/surfaces.css', 'text/css'),
            ('/workspace-tools.css', 'text/css'),
        ]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertIn(content_type, response.headers['content-type'])
            self.assertGreater(len(response.content), 100)
            self.assertEqual(self.client.post(path, json={}).status_code, 405)
        self.assertEqual(self.session.engine.settings_profile(), before)
        self.assertEqual(self.client.get('/../profile.py').status_code, 404)

    def test_definition_endpoint_uses_active_not_staged_devices_without_writes(self):
        before = self.session.engine.settings_profile()
        self.session.next_bank_setup = {'devices': [{'id': 'staged'}]}
        response = self.client.get('/api/surfaces/devices')
        self.assertEqual(response.status_code, 200)
        devices = response.json()['devices']
        self.assertTrue(any(device['id'] == 'l6' for device in devices))
        self.assertFalse(any(device['id'] == 'staged' for device in devices))
        self.assertEqual(self.session.engine.settings_profile(), before)
        self.assertEqual(self.client.post('/api/surfaces/devices', json={}).status_code, 405)

    def test_canvas_only_uses_guarded_live_control_not_configuration_writes(self):
        script = self.client.get('/surfaces.js').text
        self.assertIn("fetch('/api/surfaces/devices'", script)
        self.assertIn("fetch('/api/bank-control'", script)
        self.assertIn('canUseLive(module, current)', script)
        self.assertIn('liveCommand(current, runtimeSnapshot)', script)
        for forbidden in ('XMLHttpRequest', 'requestMIDIAccess', 'WebSocket', '/api/settings', "fetch('/api/banks', { method: 'POST'"):
            self.assertNotIn(forbidden, script)

    def test_embedded_tools_share_the_existing_editors_without_another_sidebar(self):
        before = self.session.engine.settings_profile()
        embedded = self.client.get('/tools?embedded=true')
        self.assertEqual(embedded.status_code, 200)
        for marker in ('id="modEditor"', 'id="snapshotEditor"', 'id="bankEditor"', 'id="ccRoutes"', 'id="deviceEditor"', 'id="events"', 'midibrain:stage-strip', 'event.origin!==location.origin', 'hasSettingsEdits()'):
            self.assertIn(marker, embedded.text)
        self.assertNotIn('midibrain:stage-strip', self.client.get('/').text)
        self.assertIn("snapshotWorkspace.id='workspace-snapshots'", embedded.text)
        self.assertIn("goToMapping(bankDraft.banks[index]", embedded.text)
        self.assertEqual(self.session.engine.settings_profile(), before)

    def test_runtime_projection_is_atomic_read_only_and_includes_restart_guards(self):
        before = self.session.engine.settings_profile()
        response = self.client.get('/api/surfaces/runtime')
        self.assertEqual(response.status_code, 200)
        state = response.json()
        self.assertEqual(state['instance_id'], self.session.instance_id)
        self.assertEqual(state['active'], self.session.bank_snapshot()['active'])
        self.assertTrue(state['performance']['native'])
        self.assertEqual(len(state['performance']['mods']), 3)
        self.assertFalse(state['staged'])
        self.session.next_performance = {'pending': True}
        self.assertTrue(self.client.get('/api/surfaces/runtime').json()['staged'])
        self.assertEqual(self.client.post('/api/surfaces/runtime', json={}).status_code, 405)
        self.assertEqual(self.session.engine.settings_profile(), before)

    def test_strip_validation_reuses_full_runtime_validation_without_mutation(self):
        before = self.session.engine.settings_profile()
        state = self.client.get('/api/surfaces/runtime').json()
        bank = state['active']['banks'][0]
        replacement = copy.deepcopy(bank)
        replacement['channels'] = [1]
        replacement['depth_overrides'] = {'1': bank['depth']}
        payload = {'bank': bank['id'], 'expected': bank, 'replacement': replacement}
        self.assertEqual(self.client.post('/api/surfaces/validate-strip', json=payload).status_code, 200)
        self.assertEqual(self.session.engine.settings_profile(), before)
        self.assertIsNone(self.session.next_bank_setup)
        replacement['controls'][0]['normal']['parameter'] = 'missing'
        self.assertEqual(self.client.post('/api/surfaces/validate-strip', json=payload).status_code, 400)
        payload['expected'] = {}
        self.assertEqual(self.client.post('/api/surfaces/validate-strip', json=payload).status_code, 409)
        self.assertEqual(self.session.engine.settings_profile(), before)

    def test_live_surface_guards_reject_definition_and_runtime_changes_atomically(self):
        self.session.running = True
        state = self.client.get('/api/surfaces/runtime').json()
        control = state['controls'][0]
        payload = {'bank': control['bank'], 'index': control['index'], 'layer': control['layer'], 'value': 64,
                   'expected': control['identity'], 'runtime_instance': state['instance_id'], 'definitions_revision': state['definitions_revision']}
        payload['runtime_instance'] = 'stale'
        self.assertEqual(self.client.post('/api/bank-control', json=payload).status_code, 409)
        payload['runtime_instance'] = state['instance_id']
        payload['definitions_revision'] = 'stale'
        self.assertEqual(self.client.post('/api/bank-control', json=payload).status_code, 409)
        payload['definitions_revision'] = state['definitions_revision']
        self.assertEqual(self.client.post('/api/bank-control', json=payload).status_code, 200)


if __name__ == '__main__':
    unittest.main()
