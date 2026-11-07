import copy
import json
import unittest

from midibrain.performance.catalog import Catalogue, parse_csv
from midibrain.performance.banks import migrate, validate_setup, expanded_channels
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event
from midibrain.performance.profile import demo_profile

CSV = '''manufacturer,device,section,parameter_name,cc_msb,cc_lsb,cc_min_value,cc_max_value,cc_default_value,nrpn_msb
Example,Synth,Filter,Cutoff,74,,0,127,64,
Example,Synth,Filter,Alternate cutoff,74,,0,127,,
Example,Synth,Track,Mute,94,,0,1,0,1
Example,Synth,Track,Unknown default,20,,10,90,,
Example,Synth,Track,High resolution,1,33,0,16383,,
Example,Synth,Track,NRPN only,,,,,,1
Example,Synth,Track,Channel mode,123,,0,127,,
'''


class CatalogueTests(unittest.TestCase):
    def test_lazy_index_only_and_selected_csv_cache(self):
        calls=[]
        def fetch(url):
            calls.append(url)
            if '/git/trees/' in url:
                return json.dumps({'sha':'abc123','truncated':False,'tree':[
                    {'path':'Example/Synth.csv','type':'blob'}, {'path':'Other/Untouched.csv','type':'blob'},
                    {'path':'template.csv','type':'blob'}]})
            return CSV
        catalogue=Catalogue(fetch)
        self.assertEqual(calls, [])
        self.assertEqual(len(catalogue.index()['paths']), 2)
        self.assertEqual(len(calls),1)
        preview=catalogue.preview('Example/Synth.csv')
        self.assertEqual(len(calls),2)
        self.assertIn('/abc123/',calls[-1])
        self.assertEqual(len(preview['skipped']),3)
        device=catalogue.device('Example/Synth.csv',[0,2,3])
        self.assertEqual(len(calls),2)
        self.assertEqual(device['channel_mode'],'selectable')
        self.assertFalse(device['initialize'])
        self.assertIsNone(device['channels'][0]['parameters']['cc20']['reset'])
        self.assertIn('Pencil Research',device['provenance']['attribution'])
        aliases = catalogue.device('Example/Synth.csv',[0,1])
        self.assertEqual(len(aliases['channels'][0]['parameters']), 2)
        self.assertTrue(all(p['alias'] and p['reset'] is None for p in aliases['channels'][0]['parameters'].values()))
        with self.assertRaises(ValueError): catalogue.preview('../secret.csv')
        self.assertEqual(len(calls),2)

    def test_bad_schema_and_ranges_not_imported(self):
        with self.assertRaises(ValueError): parse_csv('note,name\n60,foo')
        self.assertEqual(parse_csv('parameter_name,cc_msb,cc_min_value,cc_max_value\nX,7,foo,127\nY,8,20,10\n')['parameters'], [])


class TemplateTests(unittest.TestCase):
    def profile(self):
        profile=demo_profile(); setup=migrate(profile); profile['bank_setup']=setup
        destination=setup['devices'][1]
        destination['channel_mode']='selectable'; destination['initialize']=False
        destination['channels']=destination['channels'][:1]
        setup['banks']=setup['banks'][:1]
        bank=setup['banks'][0]; bank.update(channels=[1],midi_channels=[2,9],depth=.7,depth_overrides={})
        return profile

    def test_template_sends_to_selected_channels_and_bank_envelope(self):
        profile=self.profile(); messages=[]; engine=BankEngine(profile,messages.append); engine.initialize(0); messages.clear()
        engine.handle('twister',Event('control_change',1,control=0,value=90),.01)
        values=[m for m in messages if m.destination=='l6' and m.control==0]
        self.assertEqual({(m.channel,m.value) for m in values},{(2,90),(9,90)})
        self.assertEqual(engine.destination_depth('l6',(1,9)),.7)
        self.assertNotIn(('l6',(1,1)),engine.destinations)
        engine.handle('a4',Event('note_on',5,note=60,velocity=127),.02)
        engine.tick(.02)
        duck=[m for m in messages if m.destination=='l6' and m.control==6]
        self.assertEqual({(m.channel,m.value) for m in duck[-2:]},{(2,30),(9,30)})
        self.assertEqual(engine.settings_profile()['bank_setup']['devices'][1]['channels'][0]['parameters']['low']['channel'],1)

    def test_range_scaling_and_unknown_reset(self):
        profile=self.profile(); param=profile['bank_setup']['devices'][1]['channels'][0]['parameters']['low']
        param.update(min=10,max=90,reset=None)
        sent=[]; engine=BankEngine(profile,sent.append); engine.initialize(0)
        self.assertFalse(any(m.destination=='l6' and m.control==0 for m in sent))
        engine.handle('twister',Event('control_change',1,control=0,value=127),.01)
        self.assertEqual(engine.bank_values['l6',(1,2),'low'],90)
        sent.clear(); engine.reset_bank('bank-1')
        self.assertFalse(any(m.destination=='l6' and m.control==0 for m in sent))

    def test_selected_template_collisions_are_rejected(self):
        profile=self.profile(); setup=profile['bank_setup']
        template=copy.deepcopy(setup['devices'][1]['channels'][0]);template['id']=2
        setup['devices'][1]['channels'].append(template)
        setup['banks'][0]['channels']=[1,2]
        with self.assertRaisesRegex(ValueError,'overlap'):
            validate_setup(setup)
        setup['banks'][0]['channels']=[1]; setup['banks'][0]['midi_channels']=[True]
        with self.assertRaises(ValueError): validate_setup(setup)


class RigAndFanoutTests(unittest.TestCase):
    def test_csv_enrichment_preserves_every_existing_rig_control_and_envelope(self):
        from pathlib import Path
        from midibrain.performance.engine import MixerEngine
        profile = json.loads((Path(__file__).parents[1] / 'config/performance.trial.json').read_text())
        old_messages, new_messages = [], []
        old = MixerEngine(profile, old_messages.append)
        profile['bank_setup'] = migrate(profile)
        new = BankEngine(profile, new_messages.append)
        self.assertIn('provenance', new.devices['l6'])
        self.assertEqual(len(new.devices['l6']['channels']), 7)
        old.initialize(0); new.initialize(0)
        def l6(messages):
            return [(m.channel,m.control,m.value) for m in messages if m.destination == 'l6']
        self.assertEqual(sorted(l6(old_messages)), sorted(l6(new_messages)))
        for layer in ('normal', 'alternate'):
            for address in profile['twister'][layer]['input']:
                old_messages.clear(); new_messages.clear()
                event = Event('control_change', address['channel'], control=address['cc'], value=93)
                old.handle('twister',event,.01); new.handle('twister',event,.01)
                self.assertEqual(l6(old_messages), l6(new_messages))
        for event, now in [(Event('note_on',5,note=60,velocity=100),.02),(Event('note_off',5,note=60),.03)]:
            old_messages.clear(); new_messages.clear()
            old.handle('a4',event,now); new.handle('a4',event,now)
            old.tick(now+.01); new.tick(now+.01)
            self.assertEqual(l6(old_messages),l6(new_messages))

    def test_cross_device_fanout_and_invalid_destination(self):
        profile=demo_profile(); setup=migrate(profile); profile['bank_setup']=setup
        setup['devices'].append(dict(id='synth',name='Synth',kind='destination',output=None,initialize=False,
            channel_mode='selectable',channels=[dict(id=1,name='Track',volume=None,
            parameters={'cutoff':dict(label='Cutoff',channel=1,cc=74,min=10,max=90,reset=None)})]))
        binding=setup['banks'][0]['controls'][0]['normal']
        binding['sends']=[dict(device='synth',set=1,midi_channel=3,parameter='cutoff'),
                          dict(device='synth',set=1,midi_channel=8,parameter='cutoff')]
        sent=[]; engine=BankEngine(profile,sent.append); engine.initialize(0);sent.clear()
        engine.handle('twister',Event('control_change',1,control=0,value=127),.01)
        self.assertEqual({(m.channel,m.control,m.value) for m in sent if m.destination=='synth'}, {(3,74,90),(8,74,90)})
        self.assertTrue(any(m.destination=='l6' and m.control==0 and m.value==127 for m in sent))
        binding['sends'][0]['parameter']='missing'
        with self.assertRaisesRegex(ValueError,'Choose a parameter'):validate_setup(setup)

    def test_elektron_sections_and_aliases_import_together(self):
        data=CSV.replace('Example,Synth,Filter,','Elektron,Synth,Synth: FM,') + 'Elektron,Synth,FX,Delay,85,,0,127,0,\n'
        c=Catalogue(lambda url:json.dumps({'sha':'abc','tree':[{'type':'blob','path':'Elektron/Synth.csv'}]}) if '/git/trees/' in url else data)
        preview=c.preview('Elektron/Synth.csv');device=c.device(preview['path'],[p['id'] for p in preview['parameters']])
        self.assertEqual([ch['name'] for ch in device['channels']],['Track','FX'])
        setup=migrate(demo_profile());setup['devices'].append(device);validate_setup(setup)
        self.assertEqual(len(device['channels'][0]['parameters']),4)
