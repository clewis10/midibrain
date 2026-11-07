import copy
import math
import unittest

from midibrain.performance import operators as ops
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event
from midibrain.performance.features import validate_config


def run(kind, values, now=0., state=None, **params):
    merged = ops.defaults_for(kind); merged.update(params)
    return ops.apply_kind(kind, merged, values, {} if state is None else state, now)


class OperatorMathTests(unittest.TestCase):
    def test_combining_kinds(self):
        self.assertAlmostEqual(run('sum', [.25, .5]), .75)
        self.assertAlmostEqual(run('sum', [.25, .5], gain=2), 1.5)
        self.assertAlmostEqual(run('average', [.2, .6]), .4)
        self.assertAlmostEqual(run('multiply', [.5, .5]), .25)
        self.assertEqual((run('min', [.2, -.5]), run('max', [.2, -.5])), (-.5, .2))
        self.assertEqual((run('sum', []), run('average', []), run('multiply', [])), (0., 0., 0.))

    def test_shaping_kinds(self):
        self.assertAlmostEqual(run('scale', [1.], amount=.25), .25)       # a knob caps what a MOD can send
        self.assertAlmostEqual(run('scale', [.5], amount=.5, offset=.1), .35)
        self.assertEqual((run('invert', [.3]), run('abs', [-.3])), (-.3, .3))
        self.assertLess(run('curve', [.5], curve=1), .5)                  # exponential: slow start
        self.assertGreater(run('curve', [.5], curve=-1), .5)              # logarithmic: fast start
        self.assertAlmostEqual(run('curve', [-.5], curve=0), -.5)
        self.assertAlmostEqual(run('quantize', [.37], steps=4), .25)
        self.assertAlmostEqual(run('quantize', [-.37], steps=4), -.25)

    def test_quantize_to_a_musical_scale(self):
        # 61/127 is C#4 (61): C major has no C#, so it snaps to C (60) or D (62).
        value = run('quantize', [61 / 127], scale=1, root=0) * 127
        self.assertIn(round(value), (60, 62))
        value = run('quantize', [61 / 127], scale=1, root=1) * 127   # same note in C# major: kept
        self.assertEqual(round(value), 61)

    def test_logic_and_smoothing(self):
        self.assertEqual(run('threshold', [.6], level=.5), 1.)
        self.assertEqual(run('threshold', [.4], level=.5), 0.)
        self.assertEqual([run('and', [1, 1]), run('and', [1, 0]), run('or', [0, 1]), run('or', [0, 0]), run('xor', [1, 1]), run('xor', [1, 0]), run('not', [1]), run('not', [0])], [1, 0, 1, 0, 0, 1, 0, 1])
        state = {}
        run('smooth', [0.], now=0., state=state, time_ms=100)
        first = run('smooth', [1.], now=.1, state=state, time_ms=100)
        self.assertAlmostEqual(first, 1 - math.exp(-1), places=6)
        self.assertGreater(run('smooth', [1.], now=1., state=state, time_ms=100), .99)


class OperatorValidationTests(unittest.TestCase):
    def operator(self, **changes):
        op = ops.default_operator(0, 'sum'); op['inputs'] = [{'type': 'mod', 'index': 1}]; op.update(changes); return op

    def test_valid_and_invalid_operators(self):
        ops.validate([self.operator()], 3, {'twister'})
        for broken, message in [
            (self.operator(kind='nope'), 'Unknown operator kind'),
            (self.operator(inputs=[{'type': 'mod', 'index': 9}]), 'missing MOD'),
            (self.operator(inputs=[{'type': 'mod', 'index': 1}, {'type': 'mod', 'index': 1}]), 'twice'),
            (self.operator(params={'gain': 99}), 'gain'),
            (self.operator(links={'amount': {'controller': 'twister', 'channel': 1, 'number': 1}}), 'setting that exists'),
            (self.operator(links={'gain': {'controller': 'ghost', 'channel': 1, 'number': 1}}), 'missing controller'),
            (self.operator(inputs=[{'type': 'op', 'index': 0}]), 'missing operator'),
        ]:
            with self.assertRaisesRegex(ValueError, message): ops.validate([broken], 3, {'twister'})

    def test_loops_between_operators_are_refused(self):
        a, b = self.operator(inputs=[{'type': 'op', 'index': 1}]), self.operator(inputs=[{'type': 'op', 'index': 0}])
        with self.assertRaisesRegex(ValueError, 'loop'): ops.validate([a, b], 3, set())
        b['inputs'] = []
        ops.validate([a, b], 3, set())


class OperatorEngineTests(unittest.TestCase):
    def setUp(self):
        self.profile = rig_demo_profile()
        self.sent = []
        self.engine = BankEngine(self.profile, self.sent.append)
        self.engine.initialize(0)
        self.f = self.engine.features

    def configure(self, operators, mods=None):
        config = copy.deepcopy(self.f.config); config['operators'] = operators
        if mods is not None: config['mods'] = mods
        self.f.configure(config, 0)

    def lfo(self, **changes):
        mod = copy.deepcopy(self.f.config['mods'][1]); mod.update(enabled=True, shape='square', playback='loop', rate=1., amount=1., timing='free', destinations=[]); mod.update(changes)
        mods = copy.deepcopy(self.f.config['mods']); mods[1] = mod
        return mods

    def target(self, amount=1.):
        return dict(device='l6', parameter='low', channels=[1], banks=[], amount=amount, scale_by_bank=False)

    def test_a_scale_operator_caps_what_a_mod_delivers_and_a_knob_sets_the_cap(self):
        self.engine.set_base(('l6', 1, 'low'), 0)
        op = ops.default_operator(0, 'scale'); op['inputs'] = [{'type': 'mod', 'index': 1}]; op['targets'] = [self.target()]
        self.configure([op], self.lfo())
        peaks = []
        for step in range(1, 200):
            self.engine.tick(step * .01)
            peaks.append(self.f.output(('l6', 1, 'low'), 0))
        full = max(peaks)
        self.assertGreater(full, 100)
        # A knob (Twister ch 3 CC 30) becomes the operator's amount: halfway = half the swing.
        op['links'] = {'amount': {'controller': 'twister', 'channel': 3, 'number': 30}}
        self.configure([op], self.lfo())
        self.engine.handle('twister', Event('control_change', 3, control=30, value=64), 2.)
        peaks = []
        for step in range(1, 200):
            self.engine.tick(2. + step * .01)
            peaks.append(self.f.output(('l6', 1, 'low'), 0))
        self.assertAlmostEqual(max(peaks) / full, 64 / 127, delta=.05)
        self.engine.handle('twister', Event('control_change', 3, control=30, value=0), 5.)
        self.engine.tick(5.01)
        self.assertEqual(self.f.output(('l6', 1, 'low'), 0), 0)

    def test_operators_can_chain_and_sum_two_sources(self):
        self.engine.set_base(('l6', 1, 'low'), 0)
        mods = self.lfo()
        mods[2] = dict(copy.deepcopy(mods[2]), enabled=True, shape='square', playback='loop', rate=1., amount=1., timing='free', destinations=[])
        total = ops.default_operator(0, 'sum'); total['inputs'] = [{'type': 'mod', 'index': 1}, {'type': 'mod', 'index': 2}]
        half = ops.default_operator(1, 'scale'); half['inputs'] = [{'type': 'op', 'index': 0}]; half['params']['amount'] = .5; half['targets'] = [self.target()]
        self.configure([total, half], mods)
        self.engine.tick(.01)
        direct = self.f.signal(1) + self.f.signal(2)
        self.assertAlmostEqual(self.f.op_values[1], direct * .5, places=6)
        self.assertAlmostEqual(self.f.output(('l6', 1, 'low'), 0), max(0, min(127, direct * .5 * 127)), delta=1)

    def test_operator_configuration_survives_validation_and_old_configs_load(self):
        config = copy.deepcopy(self.f.config)
        validate_config(config, self.engine.setup)
        config.pop('operators')
        self.assertEqual(validate_config(config, self.engine.setup)['operators'], [])
        op = ops.default_operator(0, 'scale'); op['targets'] = [dict(self.target(), banks=['bank-1'], channels=[], scale_by_bank=True)]
        config['operators'] = [op]
        with self.assertRaises(ValueError): validate_config(config, self.engine.setup)


if __name__ == '__main__':
    unittest.main()


class OperatorKnobTests(unittest.TestCase):
    def test_a_strip_knob_that_only_feeds_an_operator_is_playable_and_reads_back(self):
        from midibrain.performance.rig_conversion import sidechain_to_operators
        profile = sidechain_to_operators(rig_demo_profile(page2=True))
        engine = BankEngine(profile, lambda message: None); engine.initialize(0)
        op = next(o for o in engine.features.config['operators'] if o['name'].startswith('Bank 1 '))
        link = op['links']['amount']
        bank = engine.banks['bank-1']
        index, layer = next((i, l) for i, c in enumerate(bank['controls']) for l, b in c.items() if b.get('source') and (b['source']['channel'], b['source']['cc']) == (link['channel'], link['number']))
        state = lambda: next(c for c in engine.control_states() if (c['bank'], c['index'], c['layer']) == ('bank-1', index, layer))
        self.assertTrue(state()['assigned'])
        self.assertIsNone(state()['value'])
        engine.set_control('bank-1', index, layer, 0)
        self.assertEqual(engine.features.cc_values[link['controller'], link['channel'], link['number']], 0)
        self.assertEqual(state()['value'], 0)
        engine.handle('a4', Event('note_on', 5, note=60, velocity=127), .01)
        engine.tick(.02)
        self.assertEqual(engine.features.op_values[engine.features.config['operators'].index(op)], 0.0)


class UnknownBaseDuckingTests(unittest.TestCase):
    def test_a_negative_operator_waits_for_a_known_base_then_restores_it(self):
        profile = rig_demo_profile(page2=True)
        engine = BankEngine(profile, lambda message: None); engine.initialize(0)
        sent = []; engine.send = sent.append
        param = engine.parameter_info(('l6', 1, 'low'))[0]
        param['reset'] = None; param.pop('max', None)
        engine.bank_values['l6', 1, 'low'] = None
        for alias in engine.alias_refs[tuple(engine.parameter_info(('l6', 1, 'low'))[1][:3])]: engine.bank_values[alias] = None
        op = ops.default_operator(0, 'scale'); op['inputs'] = [{'type': 'mod', 'index': 0}]
        op['targets'] = [dict(device='l6', parameter='low', channels=[1], banks=[], amount=-1.0, scale_by_bank=False)]
        config = copy.deepcopy(engine.features.config); config['operators'] = [op]
        engine.features.configure(config, 0)
        engine.tick(.01); engine.tick(.02)
        mine = lambda: [m for m in sent if m.control == param['cc'] and m.channel == param['channel']]
        self.assertEqual(mine(), [], 'loading the rig and idling sends nothing')
        engine.handle('a4', Event('note_on', 5, note=60, velocity=127), .03)
        engine.tick(.04)
        self.assertEqual(mine(), [], 'an unread fader must not be assumed to rest at 127')
        engine.set_base(('l6', 1, 'low'), 92)
        for step in range(1, 20): engine.tick(.04 + step * .01)
        self.assertEqual(mine()[-1].value, 0, 'a full sidechain can reach zero from the known level')
        engine.handle('a4', Event('note_off', 5, note=60), .25)
        for step in range(1, 120): engine.tick(.25 + step * .01)
        self.assertEqual(mine()[-1].value, 92, 'release restores the known base, not the output maximum')
        self.assertEqual(engine.bank_values['l6', 1, 'low'], 92)

    def test_output_limits_do_not_reduce_depth_or_set_the_resting_level(self):
        engine = BankEngine(rig_demo_profile(page2=True), lambda message: None); engine.initialize(0)
        features = engine.features
        op = ops.default_operator(0, 'scale')
        target = dict(device='l6', parameter='low', channels=[1], banks=[], amount=-1., scale_by_bank=False)
        op['targets'] = [target]
        config = copy.deepcopy(features.config); config['operators'] = [op]
        features.configure(config, 0)
        ref = ('l6', 1, 'low')
        for ceiling in (100, 127):
            for base in (64, 100, 127):
                with self.subTest(ceiling=ceiling, base=base):
                    route = dict(ref=['l6', 1, 'low'], amount=-1., min=0, max=ceiling)
                    routes = {tuple(engine.parameter_info(ref)[1][:3]): [(('op', 0), route)]}
                    features.op_values[0] = 1.
                    self.assertEqual(features.output(ref, base, routes_by_address=routes), 0)
                    features.op_values[0] = 0.
                    self.assertEqual(features.output(ref, base, routes_by_address=routes), min(base, ceiling))

    def test_an_explicit_reset_can_supply_the_base_without_sending_while_idle(self):
        engine = BankEngine(rig_demo_profile(page2=True), lambda message: None); engine.initialize(0)
        ref = ('l6', 1, 'low')
        param, signature = engine.parameter_info(ref)
        param['reset'] = 84
        for alias in engine.alias_refs[tuple(signature[:3])]: engine.bank_values[alias] = None
        op = ops.default_operator(0, 'scale')
        op['targets'] = [dict(device='l6', parameter='low', channels=[1], banks=[], amount=-1., scale_by_bank=False)]
        features = engine.features
        config = copy.deepcopy(features.config); config['operators'] = [op]
        features.configure(config, 0)
        sent = []; engine.send = sent.append
        routes = {tuple(signature[:3]): [(('op', 0), dict(ref=list(ref), amount=-1.))]}
        features.emit_modulated(ref, routes)
        self.assertEqual(sent, [])
        features.op_values[0] = 1.
        features.emit_modulated(ref, routes)
        self.assertEqual(sent[-1].value, 0)
        features.op_values[0] = 0.
        features.emit_modulated(ref, routes)
        self.assertEqual(sent[-1].value, 84)

    def test_a_positive_amount_on_an_unknown_value_still_waits_for_a_known_base(self):
        profile = rig_demo_profile(page2=True)
        engine = BankEngine(profile, lambda message: None); engine.initialize(0)
        sent = []; engine.send = sent.append
        for alias in engine.alias_refs[tuple(engine.parameter_info(('l6', 1, 'low'))[1][:3])]: engine.bank_values[alias] = None
        engine.parameter_info(('l6', 1, 'low'))[0]['reset'] = None
        op = ops.default_operator(0, 'scale'); op['inputs'] = [{'type': 'mod', 'index': 0}]
        op['targets'] = [dict(device='l6', parameter='low', channels=[1], banks=[], amount=0.5, scale_by_bank=False)]
        config = copy.deepcopy(engine.features.config); config['operators'] = [op]
        engine.features.configure(config, 0)
        engine.handle('a4', Event('note_on', 5, note=60, velocity=127), .03)
        engine.tick(.04)
        self.assertEqual([m for m in sent if m.control == 33], [])
