import json
import tempfile
import unittest
from pathlib import Path

from midibrain.performance.setup import create_profile


class Ports:
    def get_input_names(self):
        return ['L6 MIDI I/O Port', 'Midi Fighter Twister', 'Elektron Analog Four']

    def get_output_names(self):
        return ['L6 Mixer Control Port', 'Midi Fighter Twister']


class SetupTests(unittest.TestCase):
    def test_both_routes_preserve_settings_and_source(self):
        source = Path(__file__).resolve().parents[1] / 'config/performance.trial.json'
        before = source.read_bytes()
        for route, port in [('l6-midi', 'L6 MIDI I/O Port'), ('a4-usb', 'Elektron Analog Four')]:
            with self.subTest(route=route), tempfile.TemporaryDirectory() as folder:
                destination = Path(folder) / 'local.json'
                profile = create_profile(source, destination, route, Ports())
                self.assertEqual(profile['ports']['a4_input'], port)
                self.assertEqual(profile['ports']['l6_output'], 'L6 Mixer Control Port')
                expected = json.loads(before)
                expected['ports'] = profile['ports']
                self.assertEqual(json.loads(destination.read_text()), expected)
                with self.assertRaises(ValueError):
                    create_profile(source, destination, route, Ports())
                self.assertEqual(source.read_bytes(), before)

    def test_missing_or_ambiguous_ports_write_nothing(self):
        source = Path(__file__).resolve().parents[1] / 'config/performance.trial.json'
        for inputs in [[], ['L6 MIDI I/O Port A', 'L6 MIDI I/O Port B', 'Midi Fighter Twister']]:
            with tempfile.TemporaryDirectory() as folder:
                backend = Ports()
                backend.get_input_names = lambda: inputs
                destination = Path(folder) / 'local.json'
                with self.assertRaises(ValueError):
                    create_profile(source, destination, 'l6-midi', backend)
                self.assertFalse(destination.exists())

    def test_exact_override_resolves_ambiguity(self):
        source = Path(__file__).resolve().parents[1] / 'config/performance.trial.json'
        with tempfile.TemporaryDirectory() as folder:
            backend = Ports()
            backend.get_input_names = lambda: ['L6 MIDI I/O A', 'L6 MIDI I/O B', 'Midi Fighter Twister']
            profile = create_profile(source, Path(folder) / 'local.json', 'l6-midi', backend,
                                     {'a4_input': 'L6 MIDI I/O B'})
            self.assertEqual(profile['ports']['a4_input'], 'L6 MIDI I/O B')
