import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from midibrain.performance.engine import Event
from midibrain.performance.profile import demo_profile, load
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(demo_profile(), demo=True)
        self.session.engine.initialize(time.monotonic())
        self.session.running = True
        self.client = TestClient(create_app(self.session))

    def test_filter_change_releases_old_notes_and_matches_new_filter(self):
        engine = self.session.engine
        engine.handle('a4', Event('note_on', 5, note=60, velocity=127), time.monotonic())
        self.assertEqual(engine.snapshot()['held_notes'], 1)
        response = self.client.post('/api/trigger', json={'channel': 7, 'note': 36})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(engine.snapshot()['held_notes'], 0)
        self.assertEqual(engine.envelope, 0)
        for channel, note in [(5, 60), (7, 60), (7, 36)]:
            engine.handle('a4', Event('note_on', channel, note=note, velocity=127), time.monotonic())
        self.assertEqual(engine.snapshot()['held_notes'], 1)
        for body in [{'channel': 0}, {'channel': True}, {'channel': 17}, {'channel': 7, 'note': 128}]:
            self.assertEqual(self.client.post('/api/trigger', json=body).status_code, 422)
        self.assertEqual(engine.profile['trigger'], {'channel': 7, 'note': 36})

    def test_inspector_uses_applied_groups_and_handles_internal_depth(self):
        self.client.post('/api/columns', json={'columns': [[2, 6], [], [1], [3]]})
        routing = self.client.get('/api/routing').json()
        low = next(c for c in routing['controls'] if c['index'] == 0 and c['layer'] == 'normal')
        self.assertEqual([t['channel_id'] for t in low['targets']], [2, 6])
        self.assertEqual(low['targets'][0]['address'], self.session.engine.channels[2]['parameters']['low'])
        depth = next(c for c in routing['controls'] if c['index'] == 12 and c['layer'] == 'alternate')
        self.assertEqual(depth['targets'][0]['parameter'], 'depth')
        self.assertIsNone(depth['targets'][0]['address'])

    def test_ports_stage_save_and_roundtrip_without_changing_live_routes(self):
        s = self.session
        s.demo = False
        s.available_ports = {'inputs': ['Trigger', 'Twister in'], 'outputs': ['Mixer', 'Twister out']}
        ports = dict(zip(('a4_input', 'twister_input', 'l6_output', 'twister_output'),
                         ('Trigger', 'Twister in', 'Mixer', 'Twister out')))
        before = dict(s.engine.profile['ports'])
        with tempfile.TemporaryDirectory() as directory:
            s.config_path = Path(directory) / 'profile.json'
            self.assertEqual(self.client.post('/api/ports', json=ports).status_code, 200)
            self.assertEqual(s.engine.profile['ports'], before)
            self.assertTrue(self.client.get('/api/routing').json()['restart_required'])
            self.assertFalse(s.config_path.exists())
            self.client.post('/api/trigger', json={'channel': 8, 'note': None})
            self.assertEqual(self.client.post('/api/save').status_code, 200)
            saved = load(s.config_path, live=True, allow_unverified=True)
            self.assertEqual(saved['ports'], ports)
            self.assertEqual(saved['trigger']['channel'], 8)
        for invalid in [{**ports, 'a4_input': 'missing'}, {**ports, 'a4_input': ports['twister_input']}]:
            self.assertEqual(self.client.post('/api/ports', json=invalid).status_code, 400)
            self.assertEqual(s.next_ports, ports)
        self.assertEqual(self.client.post('/api/trigger', json={'channel': 9},
                                         headers={'origin': 'https://elsewhere.test'}).status_code, 403)
