"""The page 2 setup must preserve the rig and pass native reset values unchanged."""
import copy
import importlib.util
import unittest
from pathlib import Path

import mido
from midibrain.performance.profile import demo_profile, validate
from midibrain.performance.banks import migrate
from midibrain.performance.routing import PortRouter

spec = importlib.util.spec_from_file_location('page2', Path(__file__).parents[1]/'scripts/configure_twister_page2.py')
page2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(page2)


class TwisterPage2Tests(unittest.TestCase):
    def test_routes_reset_values_and_preserves_page_one(self):
        profile = demo_profile()
        profile['ports']['twister_input'] = 'Twister'
        profile['routing'] = {'clock': {'source': None, 'destinations': [], 'transport': True}, 'cc': []}
        profile['twister']['resets'] = [{'channel': 4, 'cc': cc, 'scope': 'all'} for cc in (9, 12)]
        profile['bank_setup'] = migrate(profile)
        before = copy.deepcopy(profile)
        result = page2.configure(profile, 'L6 MIDI I/O')
        validate(result, allow_unverified=True)
        self.assertEqual(profile, before)
        self.assertEqual(result['bank_setup']['banks'], before['bank_setup']['banks'])
        self.assertEqual([r['cc'] for r in result['twister']['resets']], [9])
        self.assertEqual([r['cc'] for r in result['bank_setup']['resets']], [9])
        self.assertEqual(page2.configure(result, 'L6 MIDI I/O'), result)
        sent = []
        class Output:
            def send(self, message): sent.append(message)
        router = PortRouter(result['routing'])
        for cc in range(16, 32):
            for value in (0, 64, 127):
                router.handle(profile['ports']['twister_input'], mido.Message('control_change', channel=0, control=cc, value=value), {'L6 MIDI I/O': Output()}, 1.)
                self.assertEqual(sent[-1], mido.Message('control_change', channel=15, control=cc+54, value=value))
        count = len(sent)
        router.handle(profile['ports']['twister_input'], mido.Message('control_change', channel=0, control=0, value=50), {'L6 MIDI I/O': Output()}, 2.)
        self.assertEqual(len(sent), count)

    def test_conflicting_route_is_not_overwritten(self):
        profile = demo_profile()
        profile['ports']['twister_input'] = 'Twister'
        profile['routing'] = {'clock': {'source': None, 'destinations': [], 'transport': True}, 'cc': [dict(source=profile['ports']['twister_input'], channel=1, cc=16, destinations=[dict(port='Other', channel=2, cc=3)])]}
        before = copy.deepcopy(profile)
        with self.assertRaises(ValueError): page2.configure(profile, 'L6 MIDI I/O')
        self.assertEqual(profile, before)

    def test_updated_profile_can_restart_with_curve_and_explicit_mod_target(self):
        from fastapi.testclient import TestClient
        from midibrain.performance.presets import rig_demo_profile
        from midibrain.performance.runtime import Session
        from midibrain.performance.web import create_app
        session = Session(rig_demo_profile(), demo=True)
        setup = session.bank_snapshot()['draft']
        l6 = next(d for d in setup['devices'] if d['id'] == 'l6')
        channel = l6['channels'][0]
        channel['parameters']['eq_mid_freq']['continuous'] = True
        channel['volume']['curve'] = [[0, 108], [.5, 40], [1, 0]]
        config = copy.deepcopy(session.engine.features.config)
        config['mods'][1]['targets'] = [dict(ref=['l6', 1, 'eq_mid_freq'], amount=.3)]
        response = TestClient(create_app(session)).post('/api/settings', json=dict(banks=setup, performance=config))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(session.engine.features.config['mods'][1]['targets'], config['mods'][1]['targets'])
        self.assertEqual(session.engine.destinations['l6', 1]['volume']['curve'], [[0, 108], [.5, 40], [1, 0]])
        self.assertEqual(session.engine.curve_value(channel['volume']['curve'], .25), 74)
