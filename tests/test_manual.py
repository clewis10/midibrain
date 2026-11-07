import unittest

from fastapi.testclient import TestClient

from midibrain.performance.manual import manual_bundle
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


class ManualTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(rig_demo_profile(page2=True), demo=True)
        self.client = TestClient(create_app(self.session))

    def test_manual_bundle_assets_and_source_are_bundled_and_read_only(self):
        before = self.client.get('/api/patch/state').json()
        pending = dict(self.session.pending)
        count = self.session.sent_count
        response = self.client.get('/api/manual')
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['version'], 1)
        self.assertEqual(len(data['pages']), len(manual_bundle()['pages']))
        self.assertIn('redirects', data)
        self.assertTrue(any(page['id'] == 'sidechain' and page['parent'] == 'modulation'
                            and page['kind'] == 'example' for page in data['pages']))
        for page in data['pages']:
            source = self.client.get(f"/manual/source/{page['id']}.md")
            self.assertEqual(source.status_code, 200)
            self.assertEqual(source.text, page['markdown'])
            self.assertTrue(source.headers['content-type'].startswith('text/markdown'))
        for path, content_type in [('/manual', 'text/html'), ('/manual.js', 'text/javascript'),
                                   ('/manual-model.mjs', 'text/javascript'), ('/manual-context.mjs', 'text/javascript'),
                                   ('/manual.css', 'text/css')]:
            asset = self.client.get(path)
            self.assertEqual(asset.status_code, 200, path)
            self.assertTrue(asset.headers['content-type'].startswith(content_type), path)
        self.assertEqual(self.client.get('/api/patch/state').json(), before)
        self.assertEqual(self.session.pending, pending)
        self.assertEqual(self.session.sent_count, count)

    def test_unknown_sources_do_not_resolve_arbitrary_files(self):
        for path in ['/manual/source/missing.md', '/manual/source/manifest.md', '/manual/source/..%2Fprofile.md']:
            self.assertEqual(self.client.get(path).status_code, 404, path)
        self.assertEqual(self.client.post('/api/manual', json={}).status_code, 405)
        self.assertEqual(self.client.get('/manual.js?name=../__init__.py&media=text/plain').text,
                         self.client.get('/manual.js').text)

    def test_patch_exposes_context_help_and_a_separate_manual_panel(self):
        for path in ['/', '/patch']:
            page = self.client.get(path).text
            self.assertIn('id="inspectorManual"', page)
            self.assertIn('data-tab="manual"', page)
            self.assertIn('id="manualFrame"', page)
        self.assertIn('rel="noopener noreferrer"', self.client.get('/manual').text)


if __name__ == '__main__':
    unittest.main()
