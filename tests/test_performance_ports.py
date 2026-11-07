import unittest
from midibrain.performance.runtime import resolve_port


class PortResolutionTests(unittest.TestCase):
    def test_alsa_renumbering(self):
        self.assertEqual(resolve_port('L6:L6 MIDI I/O Port 28:0',
                         ['L6:L6 MIDI I/O Port 32:0', 'L6:L6 Mixer Control Port 32:1'], 'input'),
                         'L6:L6 MIDI I/O Port 32:0')

    def test_exact_match_takes_precedence(self):
        self.assertEqual(resolve_port('Twister 24:0', ['Twister 24:0', 'Twister 28:0'], 'input'),
                         'Twister 24:0')

    def test_ambiguous_missing_and_wrong_endpoint_rejected(self):
        for available in ([], ['L6:L6 Mixer Control Port 32:1'],
                          ['L6:L6 MIDI I/O Port 32:0', 'L6:L6 MIDI I/O Port 36:0']):
            with self.subTest(available=available), self.assertRaises(ValueError):
                resolve_port('L6:L6 MIDI I/O Port 28:0', available, 'input')

    def test_mac_exact_name(self):
        self.assertEqual(resolve_port('L6 MIDI I/O Port', ['L6 MIDI I/O Port'], 'input'),
                         'L6 MIDI I/O Port')
