import copy
import unittest
from midibrain.performance.banks import migrate,validate_setup,controller_layers
from midibrain.performance.profile import demo_profile
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event

class ControllerLayersTests(unittest.TestCase):
    def test_legacy_layers_unchanged(self):
        setup=migrate(demo_profile())
        self.assertEqual(controller_layers(setup['devices'][0]),['normal','alternate'])
        self.assertEqual(validate_setup(setup),setup)

    def test_eight_layers_sixty_four_controls_and_high_layer_routing(self):
        profile=demo_profile();setup=migrate(profile);profile['bank_setup']=setup
        controller=setup['devices'][0];controller['layers']=['normal','alternate']+['layer'+str(i) for i in range(3,9)]
        controller['controls_per_bank']=64
        setup['banks']=setup['banks'][:1];bank=setup['banks'][0]
        original=copy.deepcopy(bank['controls'])
        while len(bank['controls'])<64:bank['controls'].append({})
        for c in bank['controls']:
            for layer in controller['layers']:c.setdefault(layer,dict(source=None,feedback=None,parameter=None))
        binding=bank['controls'][63]['layer8'];binding.update(source={'channel':8,'cc':63},parameter='low',label='Final control')
        sent=[];engine=BankEngine(profile,sent.append);engine.initialize(0);sent.clear()
        engine.handle('twister',Event('control_change',8,control=63,value=99),.01)
        self.assertEqual(engine.bank_values['l6',1,'low'],99)
        saved=engine.settings_profile()['bank_setup'];validate_setup(saved)
        self.assertEqual(saved['banks'][0]['controls'][63]['layer8']['label'],'Final control')
        for i,c in enumerate(original):
            for layer in c:self.assertEqual(saved['banks'][0]['controls'][i][layer],c[layer])
        controller['layers'].append('layer9')
        with self.assertRaises(ValueError):validate_setup(setup)
        controller['layers'].pop();controller['layers'][7]='normal'
        with self.assertRaises(ValueError):validate_setup(setup)
