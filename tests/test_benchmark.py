import unittest
from unittest.mock import patch

from midibrain.performance.benchmark import assess, distribution, engine_case, fixture, runtime_case


class BenchmarkTests(unittest.TestCase):
    def test_nearest_rank_percentiles_and_empty_samples(self):
        self.assertIsNone(distribution([])['p99_ms'])
        result = distribution(range(1, 101))
        self.assertEqual((result['p50_ms'], result['p95_ms'], result['p99_ms']), (50, 95, 99))

    def test_engine_fixtures_have_repeatable_message_streams(self):
        for dense in (False, True):
            first, second = [engine_case(fixture(dense), 30) for _ in range(2)]
            self.assertEqual(first['output_sha256'], second['output_sha256'])
            self.assertEqual(first['emitted_messages'], second['emitted_messages'])
            self.assertEqual(first['tick_cost']['count'], 30)

    def test_explicit_timing_budgets_and_incomplete_delivery_fail(self):
        runtime = dict(clock=True, ui_reader=False, expected_probes=10, delivered_probes=9,
                       remaining_input_messages=1, direct_route_delivery_lateness={'p99_ms': 3.})
        report = dict(runs=[dict(repeat=0, scenario='test', engine={'tick_cost': {'p99_ms': 2.}}, runtime=[runtime])])
        result = assess(report, 1., 2.)
        self.assertFalse(result['passed'])
        self.assertEqual(len(result['failures']), 3)
        runtime.update(delivered_probes=10, remaining_input_messages=0)
        self.assertTrue(assess(report)['passed'])

    def test_runtime_uses_only_memory_ports_and_delivers_all_probes(self):
        with patch('mido.open_input', side_effect=AssertionError('Physical input opened')), \
             patch('mido.open_output', side_effect=AssertionError('Physical output opened')), \
             patch('mido.get_input_names', side_effect=AssertionError('Hardware discovery')):
            result = runtime_case(fixture(True), 1., clock=True, ui=True)
        self.assertGreater(result['expected_probes'], 0)
        self.assertEqual(result['delivered_probes'], result['expected_probes'])
        self.assertEqual(result['remaining_input_messages'], 0)
        self.assertGreater(result['ui_read_cost']['count'], 0)
        self.assertGreaterEqual(result['direct_route_delivery_lateness']['min_ms'], 0)


if __name__ == '__main__': unittest.main()
