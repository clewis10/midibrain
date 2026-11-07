import re
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app

HERE = Path(__file__).resolve().parents[1] / 'src' / 'midibrain' / 'performance'


class PatchAssetTests(unittest.TestCase):
    def test_every_module_the_canvas_imports_is_served(self):
        client = TestClient(create_app(Session(rig_demo_profile(page2=True), demo=True)))
        seen, queue = set(), ['/patch.js']
        while queue:
            path = queue.pop()
            if path in seen: continue
            seen.add(path)
            response = client.get(path)
            self.assertEqual(response.status_code, 200, f'{path} is imported but not served')
            for name in re.findall(r"""from\s+['"]\.?/?([\w.-]+\.m?js)['"]""", response.text):
                queue.append('/' + name)
        self.assertIn('/patch-operators.mjs', seen)
        self.assertIn('/patch-snapshots.mjs', seen)
        self.assertIn('/patch-templates.mjs', seen)


if __name__ == '__main__':
    unittest.main()
