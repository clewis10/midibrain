"""Output scaling and the unified destination model must preserve saved rig behavior."""
import copy
import unittest

import mido
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.banks import validate_setup
from midibrain.performance.engine import Event
from midibrain.performance.features import validate_config
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.routing import PortRouter, validate_routing


class MappingModelTests(unittest.TestCase):
    def setUp(self):
        self.profile = rig_demo_profile()
        self.sent = []
        self.e = BankEngine(self.profile, self.sent.append)
        self.e.initialize(0)

    def route(self, parameter='volume', **fields):
        return dict(device='l6', parameter=parameter, channels=[], banks=['bank-1'], amount=1., scale_by_bank=True, **fields)

    def configure(self, destinations, index=0):
        config = copy.deepcopy(self.e.features.config)
        config['mods'][index]['targets'] = []
        config['mods'][index]['bank_targets'] = []
        config['mods'][index]['destinations'] = destinations
        self.e.features.configure(config, 0)
        self.e.features.values[index] = 1.

    def test_bank_scaled_volume_preserves_curve_and_depth_overrides(self):
        self.e.features.values[0] = 1.
        legacy = [self.e.features.volume_value('l6', c, self.e.destinations['l6', c]['volume']['curve']) for c in (1, 3)]
        self.configure([self.route(min=0, max=100)])
        self.assertEqual(legacy, [self.e.features.volume_value('l6', c, self.e.destinations['l6', c]['volume']['curve']) for c in (1, 3)])
        self.e.features.values[0] = 1.
        self.e.banks['bank-1'].update(depth=.5, depth_overrides={'1': .25, '3': .75})
        self.assertEqual(self.e.features.volume_value('l6', 1, [[0,100],[1,0]]), 75)
        self.assertEqual(self.e.features.volume_value('l6', 3, [[0,100],[1,0]]), 25)

    def test_multiple_parameters_share_one_bank_amount(self):
        self.configure([self.route('low', min=10, max=110), self.route('high', min=10, max=110)])
        self.e.set_bank_mod_depth('bank-1', 0, .25)
        for key in ('low', 'high'):
            self.assertEqual(self.e.features.output(('l6', 1, key), 50), 81.75)
        self.e.set_bank_mod_depth('bank-1', 0, 0.)
        self.assertEqual(self.e.features.output(('l6', 1, 'low'), 50), 50)

    def test_fixed_destination_ignores_bank_depth_and_clamps_range(self):
        route=self.route('low', min=20, max=80)
        route.update(banks=[], channels=[1], scale_by_bank=False, amount=.5)
        self.configure([route]);self.e.set_bank_mod_depth('bank-1',0,0.)
        self.assertEqual(self.e.features.output(('l6',1,'low'),50),80)
        self.assertEqual(self.e.features.output(('l6',3,'low'),50),50)

    def test_unscaled_bank_scope_does_not_apply_bank_amount(self):
        route=self.route('low');route['scale_by_bank']=False
        self.configure([route]);self.e.set_bank_mod_depth('bank-1',0,0.)
        self.assertEqual(self.e.features.output(('l6',1,'low'),0),127)

    def test_volume_output_limits(self):
        self.configure([self.route(min=30,max=90)])
        self.e.set_bank_mod_depth('bank-1',0,1.)
        self.assertEqual(self.e.features.volume_value('l6',1,[[0,100],[1,0]]),30)
        self.e.features.values[0]=0.
        self.assertEqual(self.e.features.volume_value('l6',1,[[0,100],[1,0]]),90)

    def test_invalid_destinations_are_rejected(self):
        for bad in [self.route(min=100,max=20), self.route(parameter='missing'), self.route(bogus=1)]:
            config=copy.deepcopy(self.e.features.config);config['mods'][0]['destinations']=[bad]
            with self.assertRaises(ValueError):validate_config(config,self.e.setup)
        route=self.route();route.update(banks=[],channels=[1])
        config=copy.deepcopy(self.e.features.config);config['mods'][0]['destinations']=[route]
        with self.assertRaises(ValueError):validate_config(config,self.e.setup)

    def test_native_mapping_scales_and_inverts_feedback(self):
        setup=self.profile['bank_setup'];binding=setup['banks'][0]['controls'][0]['normal']
        binding.update(min=20,max=100,invert=True)
        e=BankEngine(self.profile,self.sent.append);e.initialize(0)
        source=binding['source'];e.handle('twister',Event('control_change',source['channel'],control=source['cc'],value=127),.1)
        self.assertEqual(e.bank_values['l6',1,'low'],20)
        e.handle('twister',Event('control_change',source['channel'],control=source['cc'],value=0),.2)
        self.assertEqual(e.bank_values['l6',1,'low'],100)

    def test_direct_route_scales_all_endpoints_and_reset_values(self):
        routing=dict(clock=dict(source=None,destinations=[],transport=True),cc=[dict(source='Twister',page='Page 2',channel=1,cc=16,destinations=[dict(port='L6 DIN',channel=16,cc=70,min=20,max=100,invert=True)])])
        router=PortRouter(routing);sent=[]
        class Port:
            def send(self,message):sent.append(message)
        for value,expected in [(0,100),(127,20),(64,60)]:
            router.handle('Twister',mido.Message('control_change',channel=0,control=16,value=value),{'L6 DIN':Port()},0)
            self.assertEqual(sent[-1].value,expected);self.assertEqual(sent[-1].channel,15)
        self.assertEqual(router.routing['cc'][0]['page'],'Page 2')
        routing['cc'][0]['destinations'][0]['max']=0
        with self.assertRaises(ValueError):validate_routing(routing)

    def test_controller_pages_are_metadata_with_optional_alternate_inputs(self):
        setup=copy.deepcopy(self.e.setup);controller=next(d for d in setup['devices'] if d['id']=='twister')
        controller['pages']=['Mixer','Synth'];setup['banks'][0]['controls'][0]['normal']['page']='Mixer'
        self.assertEqual(validate_setup(setup)['banks'][0]['controls'][0]['normal']['source'],self.e.setup['banks'][0]['controls'][0]['normal']['source'])
        setup['banks'][0]['controls'][0]['normal']['page']='Unknown'
        with self.assertRaises(ValueError):validate_setup(setup)

    def test_new_model_survives_profile_roundtrip(self):
        self.configure([self.route('low',min=10,max=110)])
        restored=BankEngine(self.e.settings_profile(),lambda _:None)
        self.assertEqual(restored.features.config['mods'][0]['destinations'],self.e.features.config['mods'][0]['destinations'])

    def test_legacy_migration_preserves_envelope_and_direct_destinations(self):
        from midibrain.performance.mod_destinations import migrate
        f=self.e.features;config=copy.deepcopy(f.config)
        config['mods'][1]['targets']=[dict(ref=['l6',1,'low'],amount=.2)]
        f.configure(config,0);f.values=[1.,1.,0.]
        before=[f.volume_value('l6',c,[[0,100],[1,0]]) for c in range(1,7)]
        output=f.output(('l6',1,'low'),50)
        config['mods']=[migrate(m,self.e.setup) for m in config['mods']]
        f.configure(config,0);f.values=[1.,1.,0.]
        self.assertEqual(before,[f.volume_value('l6',c,[[0,100],[1,0]]) for c in range(1,7)])
        self.assertEqual(output,f.output(('l6',1,'low'),50))
        self.assertEqual([migrate(m,self.e.setup) for m in config['mods']],config['mods'])
