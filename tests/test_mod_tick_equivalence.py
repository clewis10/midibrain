"""Compare the optimized tick to an independent traversal with output clamps."""
import copy
import types
import unittest

from midibrain.performance.benchmark import fixture, make_engine
from midibrain.performance.features import ref_key


def reference_output(self, ref, value, **_):
    _, signature = self.engine.parameter_info(ref)
    low, high = signature[3], signature[4]
    span = high - low
    for i, source in enumerate(self.sources):
        for target in self.routes(source):
            _, other = self.engine.parameter_info(ref_key(target['ref']))
            if signature[:3] == other[:3]:
                low, high = max(low, target.get('min', low)), min(high, target.get('max', high))
                value += self.values[i] * source.config['amount'] * target['amount'] * span
    return max(low, min(high, value))


class ModTickEquivalenceTests(unittest.TestCase):
    def test_message_stream_matches_original_with_live_changes_and_aliases(self):
        for bank_scaled in (False, True):
            profile = fixture(True)
            l6 = next(d for d in profile['bank_setup']['devices'] if d['id'] == 'l6')
            channel = l6['channels'][0]
            channel['parameters']['low_alias'] = copy.deepcopy(channel['parameters']['low'])
            channel['parameters']['low_alias']['alias'] = True
            if bank_scaled:
                for mod in profile['performance']['mods']:
                    for destination in mod['destinations']:
                        destination.update(channels=[], banks=['bank-1', 'bank-2'], scale_by_bank=True,
                                           min=10, max=110)
            streams = [[], []]
            actual, reference = [make_engine(copy.deepcopy(profile), output.append) for output in streams]
            reference.features.output = types.MethodType(reference_output, reference.features)
            # The reference still uses the indexed tick's emission order, but its
            # output ignores the index and fully rebuilds routes for every value.
            # Compare streams through changing depths, aliases, unknown values,
            # snapshot recalls, configuration changes and direct output commands.
            for step in range(80):
                now = (step + 1) / 100
                for engine in (actual, reference):
                    if step % 7 == 0: engine.set_bank_mod_depth('bank-1', 0, (step % 10) / 10)
                    if step % 9 == 0: engine.set_base(('l6', 1, 'low_alias'), step % 128)
                    if step == 10: engine.features.capture(0)
                    if step == 15: engine.features.recall(engine.features.captures[0])
                    if step == 20: engine.bank_values['l6', 2, 'mid'] = None
                    if step == 30:
                        config = copy.deepcopy(engine.features.config)
                        config['mods'][0]['amount'] = .77
                        engine.features.configure(config, now)
                    engine.tick(now)
                self.assertEqual(streams[0], streams[1], (bank_scaled, step))
                self.assertEqual(actual.bank_values, reference.bank_values)
                self.assertEqual(actual.last_output, reference.last_output)

    def test_tick_expands_each_source_once(self):
        engine = make_engine(fixture(True), lambda _: None)
        calls = []
        original = engine.features.routes
        def observed(source):
            calls.append(source)
            return original(source)
        engine.features.routes = observed
        engine.tick(.1)
        self.assertEqual(len(calls), 3)
        engine.set_bank_mod_depth('bank-1', 0, .25)
        # Outside a tick there is no retained index to invalidate.
        engine.features.output(('l6', 1, 'low'), 20)
        self.assertEqual(len(calls), 6)


if __name__ == '__main__': unittest.main()
