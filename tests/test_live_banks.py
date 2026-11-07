"""Live bank controls share hardware scaling and reject stale mappings."""
import copy
import unittest

from fastapi.testclient import TestClient
from midibrain.performance.engine import Event
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


class LiveBanksTests(unittest.TestCase):
    def setUp(self):
        self.s = Session(rig_demo_profile(), demo=True)
        self.s.running = True
        self.s.engine.initialize(0)
        self.client = TestClient(create_app(self.s))

    def state(self, bank='bank-1', index=0, layer='normal'):
        return next(x for x in self.client.get('/api/banks').json()['controls']
                    if (x['bank'],x['index'],x['layer']) == (bank,index,layer))

    def send(self,value=64,**overrides):
        state=self.state()
        body=dict(bank='bank-1',index=0,layer='normal',value=value,expected=state['identity'])
        body.update(overrides)
        return self.client.post('/api/bank-control',json=body)

    def test_virtual_and_hardware_control_use_same_group_and_scaling(self):
        binding=self.s.engine.banks['bank-1']['controls'][0]['normal']
        binding.update(min=20,max=100,invert=True)
        response=self.send(127)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual([self.s.engine.bank_values['l6',c,'low'] for c in (1,3)],[20,20])
        self.assertEqual(self.state()['value'],127)
        source=binding['source']
        self.s.engine.handle('twister',Event('control_change',source['channel'],control=source['cc'],value=0),self.s.engine.last_time)
        self.assertEqual([self.s.engine.bank_values['l6',c,'low'] for c in (1,3)],[100,100])
        self.assertEqual(self.state()['value'],0)

    def test_mixed_and_unknown_values_are_not_misreported(self):
        e=self.s.engine;e.set_base(('l6',1,'low'),10);e.set_base(('l6',3,'low'),70)
        self.assertTrue(self.state()['mixed']);self.assertIsNone(self.state()['value'])
        e.bank_values['l6',3,'low']=None
        self.assertTrue(self.state()['mixed']);self.assertTrue(self.state()['unknown'])
        e.bank_values['l6',1,'low']=None
        self.assertTrue(self.state()['unknown']);self.assertIsNone(self.state()['value'])

    def test_invalid_staged_and_stale_requests_do_not_change_outputs(self):
        before=copy.deepcopy(self.s.engine.bank_values)
        for changes in [dict(value=128),dict(value=True),dict(index=999),dict(layer='missing'),dict(expected={}),dict(expected=None)]:
            self.assertEqual(self.send(**changes).status_code,400)
            self.assertEqual(before,self.s.engine.bank_values)
        state=self.state();self.s.engine.banks['bank-1']['controls'][0]['normal']['parameter']='high'
        self.assertEqual(self.send(30,expected=state['identity']).status_code,400)
        self.s.next_bank_setup=copy.deepcopy(self.s.engine.setup)
        self.assertEqual(self.send(30).status_code,400)

    def test_mod_bank_knob_and_mixed_depths(self):
        e=self.s.engine;bank=e.banks['bank-1'];bank['depth_overrides']={'1':.2,'3':.8}
        s=self.state(index=3,layer='alternate');self.assertTrue(s['mixed'])
        body=dict(bank='bank-1',index=3,layer='alternate',value=127,expected=s['identity'])
        self.assertEqual(self.client.post('/api/bank-control',json=body).status_code,200)
        self.assertEqual(bank['depth'],1);self.assertEqual(bank['depth_overrides'],{})

    def test_continuous_action_uses_hardware_mapping_and_rejects_stale_identity(self):
        f=self.s.engine.features;config=copy.deepcopy(f.config)
        config['actions']=[dict(controller='twister',type='cc',channel=16,number=110,shift='any',action='mod_rate',mod=1,slot=0,bank=None,when='instant',hold_ms=0)]
        f.configure(config,0);binding=copy.deepcopy(f.config['actions'][0])
        response=self.client.post('/api/performance/control',json=dict(index=0,kind='mod_rate',value=127,expected=binding))
        self.assertEqual(response.status_code,200,response.text);self.assertAlmostEqual(f.sources[1].config['rate'],20)
        prior=f.sources[1].config['rate'];binding['mod']=2
        self.assertEqual(self.client.post('/api/performance/control',json=dict(index=0,kind='mod_rate',value=0,expected=binding)).status_code,400)
        self.assertEqual(f.sources[1].config['rate'],prior)
        self.assertEqual(self.client.post('/api/performance/control',json=dict(index=99,kind='mod_rate',value=0,expected=binding)).status_code,400)

    def test_browser_shift_composes_with_physical_shift_and_stale_guard(self):
        f=self.s.engine.features;config=copy.deepcopy(f.config)
        config['shift']=dict(controller='twister',type='cc',channel=16,number=119,mode='momentary')
        config['actions']=[dict(controller='twister',type='cc',channel=16,number=110,shift='on',action='mod_amount',mod=1,slot=0,bank=None,when='instant',hold_ms=0)]
        f.configure(config,0);shift=copy.deepcopy(f.config['shift'])
        self.assertEqual(self.client.post('/api/performance/action',json=dict(action='shift',on=True,expected=shift)).status_code,200)
        self.assertTrue(f.state(0)['shift'])
        f.handle('twister',Event('control_change',16,control=110,value=127),.1)
        self.assertEqual(f.sources[1].config['amount'],1.)
        f.handle('twister',Event('control_change',16,control=119,value=127),.2)
        self.assertEqual(self.client.post('/api/performance/action',json=dict(action='shift',on=False,expected=shift)).status_code,200)
        self.assertTrue(f.state(0)['shift'])  # physical button remains held
        f.handle('twister',Event('control_change',16,control=119,value=0),.3)
        self.assertFalse(f.state(0)['shift'])
        shift['channel']=15
        self.assertEqual(self.client.post('/api/performance/action',json=dict(action='shift',on=True,expected=shift)).status_code,400)
        self.assertFalse(f.state(0)['shift'])
