import unittest
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.banks import validate_setup
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event


class BrainActionsTests(unittest.TestCase):
    def test_twister_side_buttons_preserved_and_press_edges(self):
        profile=rig_demo_profile();setup=profile['bank_setup']
        self.assertEqual([(r['channel'],r['cc'],r['bank']) for r in setup['resets']],
            [(4,8,'bank-1'),(4,9,None),(4,10,'bank-2'),(4,11,'bank-3'),(4,12,None),(4,13,'bank-4')])
        sent=[];engine=BankEngine(profile,sent.append);engine.initialize(0)
        engine.set_bank_depth('bank-1',.6)
        engine.handle('twister',Event('control_change',1,control=0,value=110),.01)
        self.assertEqual(engine.bank_values['l6',1,'low'],110)
        engine.handle('twister',Event('control_change',4,control=8,value=127),.02)
        self.assertEqual(engine.bank_values['l6',1,'low'],64)
        self.assertEqual(engine.banks['bank-1']['depth'],.6)
        engine.handle('twister',Event('control_change',1,control=0,value=99),.03)
        engine.handle('twister',Event('control_change',4,control=8,value=127),.04)
        self.assertEqual(engine.bank_values['l6',1,'low'],99)
        engine.handle('twister',Event('control_change',4,control=8,value=0),.05)
        engine.handle('twister',Event('control_change',4,control=8,value=127),.06)
        self.assertEqual(engine.bank_values['l6',1,'low'],64)

    def test_continuous_actions_persist_and_panic_keeps_depth(self):
        profile=rig_demo_profile();setup=profile['bank_setup']
        setup['resets'] += [dict(controller='twister',channel=3,cc=20,action='depth',bank='bank-1'),
                           dict(controller='twister',channel=3,cc=21,action='release',min_ms=100,max_ms=3100),
                           dict(controller='twister',channel=3,cc=22,action='panic')]
        engine=BankEngine(profile,lambda m:None);engine.initialize(0)
        engine.handle('twister',Event('control_change',3,control=20,value=127),.01)
        self.assertEqual(engine.banks['bank-1']['depth'],1)
        engine.handle('twister',Event('control_change',3,control=21,value=127),.02)
        self.assertEqual(engine.settings_profile()['sidechain']['release_ms'],3100)
        engine.handle('twister',Event('control_change',3,control=21,value=0),.03)
        self.assertEqual(engine.settings_profile()['sidechain']['release_ms'],100)
        engine.handle('a4',Event('note_on',5,note=60,velocity=127),.04)
        engine.handle('twister',Event('control_change',3,control=22,value=127),.05)
        self.assertEqual(engine.envelope,0)
        self.assertEqual(engine.banks['bank-1']['depth'],1)
        validate_setup(engine.settings_profile()['bank_setup'])
        setup['resets'][-1]['action']='unknown'
        with self.assertRaisesRegex(ValueError,'Unknown MIDIBRAIN action'):validate_setup(setup)
        setup['resets'].pop();setup['resets'][-1]['max_ms']=20000
        with self.assertRaises(ValueError):validate_setup(setup)


class ResetLayerTests(unittest.TestCase):
    def rig(self):
        from midibrain.performance.features import validate_config
        profile = rig_demo_profile()
        return profile, profile['bank_setup'], validate_config

    def test_reset_layer_resets_only_that_layers_parameters(self):
        profile, setup, _ = self.rig()
        engine = BankEngine(profile, lambda m: None); engine.initialize(0)
        engine.handle('twister', Event('control_change', 1, control=0, value=110), .01)      # normal: bank-1 low
        engine.handle('twister', Event('control_change', 5, control=0, value=17), .02)       # alternate: bank-1 mid
        self.assertEqual(engine.bank_values['l6', 1, 'low'], 110)
        self.assertEqual(engine.bank_values['l6', 1, 'mid'], 17)
        engine.reset_layer('twister', 'alternate')
        self.assertEqual(engine.bank_values['l6', 1, 'mid'], 64)
        self.assertEqual(engine.bank_values['l6', 1, 'low'], 110)
        engine.reset_layer('twister', 'normal')
        self.assertEqual(engine.bank_values['l6', 1, 'low'], 64)

    def test_reset_layer_action_validates_its_target(self):
        profile, setup, validate_config = self.rig()
        action = dict(controller='twister', type='cc', channel=3, number=30, action='reset', layer='alternate', layer_controller='twister', shift='any', when='instant')
        from midibrain.performance.features import defaults
        config = profile.get('performance') or defaults(); config['actions'].append(action)
        validate_config(config, setup)
        action['layer'] = 'nope'
        with self.assertRaisesRegex(ValueError, 'Unknown layer'): validate_config(config, setup)
        action['layer'] = 'normal'; action['bank'] = 'bank-1'
        with self.assertRaisesRegex(ValueError, 'not both'): validate_config(config, setup)
