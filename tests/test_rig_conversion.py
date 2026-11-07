import unittest

from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.profile import validate
from midibrain.performance.rig_conversion import sidechain_to_operators


def ducked_volume(profile, depth_cc_value=None, steps=40, knob=(1, 3)):
    sent = []
    engine = BankEngine(profile, sent.append); engine.initialize(0)
    if depth_cc_value is not None:
        engine.handle(next(d for d in engine.setup['devices'] if d['id'] == 'twister').get('input') or 'twister', Event('control_change', knob[0], control=knob[1], value=depth_cc_value), .001)
    engine.handle('a4', Event('note_on', 5, note=60, velocity=127), .01)
    values = []
    for step in range(1, steps):
        engine.tick(.01 + step * .005)
        values.append(engine.features.volume_value('l6', 1, engine.destinations['l6', 1]['volume']['curve']))
    return values


class SidechainOperatorTests(unittest.TestCase):
    def test_conversion_creates_one_scale_operator_per_strip_and_validates(self):
        converted = sidechain_to_operators(rig_demo_profile(page2=True))
        operators = converted['performance']['operators']
        self.assertEqual(len(operators), 4)
        first = next(op for op in operators if op['name'].startswith('Bank 1 '))
        self.assertEqual((first['kind'], first['inputs']), ('scale', [{'type': 'mod', 'index': 0}]))
        amount = first['links']['amount']
        self.assertEqual(amount['controller'], 'twister')
        knob_layer = next(layer for layer, binding in rig_demo_profile(page2=True)['bank_setup']['banks'][0]['controls'][3].items() if binding.get('parameter') == 'depth')
        self.assertEqual((amount['channel'], amount['number']), tuple(rig_demo_profile(page2=True)['bank_setup']['banks'][0]['controls'][3][knob_layer]['source'].values()))
        self.assertEqual(first['targets'][0]['parameter'], 'volume')
        self.assertEqual((first['targets'][0]['banks'], first['targets'][0]['channels']), (['bank-1'], []))
        self.assertEqual(converted['performance']['mods'][0]['bank_targets'], [])
        knob = converted['bank_setup']['banks'][0]['controls'][3][knob_layer]
        self.assertIsNone(knob['parameter']); self.assertEqual(knob['source'], rig_demo_profile(page2=True)['bank_setup']['banks'][0]['controls'][3][knob_layer]['source'])
        validate(converted)

    def test_the_operator_ducks_exactly_like_the_strip_amount_did(self):
        original = rig_demo_profile(page2=True)
        converted = sidechain_to_operators(rig_demo_profile(page2=True))
        before, after = ducked_volume(original), ducked_volume(converted)
        self.assertEqual(before, after)
        self.assertLess(max(after), 100, 'the channel really is ducked')
        # Moving the knob changes the depth in the converted rig; at zero nothing ducks.
        link = next(op for op in converted['performance']['operators'] if op['name'].startswith('Bank 1 '))['links']['amount']
        knob = (link['channel'], link['number'])
        self.assertEqual(set(ducked_volume(converted, depth_cc_value=0, knob=knob)), {100})
        louder = min(ducked_volume(converted, depth_cc_value=127, knob=knob))
        self.assertLess(louder, min(after), 'a full-depth knob ducks deeper than the half-depth default')


if __name__ == '__main__':
    unittest.main()
