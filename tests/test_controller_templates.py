import copy
import json
import tempfile
import unittest
from pathlib import Path

from midibrain.performance.controller_templates import TemplateLibrary, builtin_templates, validate_template


MAPS = None


class ControllerTemplateTests(unittest.TestCase):
    def test_built_ins_are_valid_and_complete(self):
        templates = builtin_templates(MAPS)
        names = [t['name'] for t in templates]
        self.assertIn('MIDI Fighter Twister', names)
        self.assertTrue(any('Launch Control XL 3' in name for name in names))
        for template in templates:
            validate_template(template)
        twister = next(t for t in templates if t['name'] == 'MIDI Fighter Twister')
        self.assertEqual(len(twister['strips']), 4)
        self.assertEqual(twister['strips'][3]['controls'][3]['normal']['source'], {'channel': 1, 'cc': 15})
        self.assertEqual(twister['strips'][0]['controls'][0]['alternate']['source'], {'channel': 5, 'cc': 0})
        xl3 = next(t for t in templates if 'Launch Control XL 3' in t['name'])
        self.assertEqual((len(xl3['strips']), xl3['controller']['controls_per_bank']), (8, 6))
        self.assertEqual(xl3['strips'][0]['controls'][3]['normal']['source'], {'channel': 16, 'cc': 5})

    def test_saved_templates_round_trip_and_are_listed_after_built_ins(self):
        with tempfile.TemporaryDirectory() as folder:
            library = TemplateLibrary(Path(folder) / 'controller-templates.json', MAPS)
            template = copy.deepcopy(builtin_templates(MAPS)[0]); template['name'] = 'My Twister'; template.pop('builtin', None)
            self.assertEqual(library.save(template), 'My Twister')
            listing = library.listing()
            self.assertEqual(listing[-1]['name'], 'My Twister')
            self.assertEqual(listing[-1]['source'], 'saved')
            self.assertEqual(json.loads((Path(folder) / 'controller-templates.json').read_text())['My Twister']['strips'], template['strips'])
            library.delete('My Twister')
            self.assertTrue(all(item['source'] == 'built-in' for item in library.listing()))
            with self.assertRaises(KeyError): library.delete('My Twister')

    def test_invalid_templates_are_rejected(self):
        template = copy.deepcopy(builtin_templates(MAPS)[0])
        for mutate, message in [
            (lambda t: t.update(format='nope'), 'Not a MIDIBRAIN'),
            (lambda t: t.update(name=''), 'name'),
            (lambda t: t['controller'].update(layers=['normal', 'normal']), 'layers'),
            (lambda t: t['strips'][0]['controls'][0]['normal']['source'].update(channel=17), 'channel'),
            (lambda t: t['strips'][0]['controls'][0].update(ghost={'source': {'channel': 1, 'cc': 1}}), 'unknown layer'),
            (lambda t: t['strips'][0].update(controls=t['strips'][0]['controls'][:1]), 'one entry per control'),
        ]:
            broken = copy.deepcopy(template); mutate(broken)
            with self.assertRaisesRegex(ValueError, message):
                validate_template(broken)


if __name__ == '__main__':
    unittest.main()
