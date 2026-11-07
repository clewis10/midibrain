import copy
import tempfile
import unittest
from pathlib import Path

from midibrain.performance.profile import load, save, template_profile, validate
from midibrain.performance.runtime import Session


class HardwareTrialTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(__file__).resolve().parents[1] / 'config/performance.trial.json'

    def test_trial_requires_explicit_opt_in(self):
        with self.assertRaisesRegex(ValueError, 'unverified'):
            load(self.path, live=True)
        profile = load(self.path, live=True, allow_unverified=True)
        self.assertFalse(profile['hardware_verified'])
        self.assertEqual(profile['trigger']['channel'], 10)
        self.assertEqual(profile['twister']['columns'], [[1, 3], [2], [4, 5], [6]])
        self.assertTrue(all(ch['depth'] == 0 for ch in profile['channels']))

    def test_override_still_rejects_missing_ports_and_invalid_mappings(self):
        profile = load(self.path)
        for mutate in (
            lambda p: p['ports'].update(l6_output=None),
            lambda p: p['channels'][0]['parameters']['volume'].update(cc=None),
            lambda p: p['channels'][0]['parameters']['high'].update(cc=33),
        ):
            invalid = copy.deepcopy(profile)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate(invalid, live=True, allow_unverified=True)
        with self.assertRaises(ValueError):
            validate(template_profile(), live=True, allow_unverified=True)

    def test_session_save_does_not_mark_hardware_verified(self):
        profile = load(self.path)
        with self.assertRaisesRegex(ValueError, 'unverified'):
            Session(profile)
        session = Session(profile, allow_unverified=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'saved.json'
            save(path, session.engine.settings_profile())
            self.assertFalse(load(path)['hardware_verified'])


if __name__ == '__main__':
    unittest.main()
