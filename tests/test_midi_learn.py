import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from midibrain.performance.runtime import Session
from midibrain.performance.profile import demo_profile
from midibrain.performance.engine import Event
from midibrain.performance.web import create_app

class MidiLearnTests(unittest.TestCase):
    def setUp(self):
        self.session=Session(demo_profile(),demo=True)
        self.session.demo=False;self.session.running=True
        self.session.open_input_names={'Twister','Other'}
        self.client=TestClient(create_app(self.session))

    def arm(self):
        response=self.client.post('/api/learn',json={'port':'Twister'})
        self.assertEqual(response.status_code,200)
        return response.json()['id']

    def test_selected_port_cc_only_first_message_and_no_profile_change(self):
        before=self.session.engine.settings_profile();token=self.arm()
        self.session.observe_learn('Other',Event('control_change',2,control=33,value=64))
        self.session.observe_learn('Twister',Event('note_on',2,note=60,velocity=127))
        self.session.observe_learn('Twister',Event('control_change',2,control=123,value=0))
        self.assertEqual(self.client.get('/api/learn/'+token).json()['state'],'listening')
        self.session.observe_learn('Twister',Event('control_change',5,control=10,value=0))
        self.session.observe_learn('Twister',Event('control_change',5,control=11,value=127))
        result=self.client.get('/api/learn/'+token).json()
        self.assertEqual((result['state'],result['channel'],result['cc'],result['value']),('captured',5,10,0))
        self.assertEqual(before,self.session.engine.settings_profile())

    def test_cancel_timeout_supersede_stop_and_demo(self):
        token=self.arm();self.client.post('/api/learn/'+token+'/cancel')
        self.assertEqual(self.session.learn_status(token)['state'],'cancelled')
        token=self.arm()
        with patch('midibrain.performance.runtime.time.monotonic',return_value=self.session.learn['expires']+1):
            self.assertEqual(self.session.learn_status(token)['state'],'expired')
        newer=self.arm();self.assertEqual(self.session.learn_status(token)['state'],'superseded')
        self.session.running=False;self.assertEqual(self.session.learn_status(newer)['state'],'cancelled')
        self.assertEqual(self.client.post('/api/learn',json={'port':'Twister'}).status_code,400)
        self.session.running=True;self.session.demo=True
        self.assertEqual(self.client.post('/api/learn',json={'port':'Twister'}).status_code,400)

    def test_unknown_input_and_cross_origin_rejected(self):
        self.assertEqual(self.client.post('/api/learn',json={'port':'Unknown'}).status_code,400)
        self.assertEqual(self.client.post('/api/learn',json={'port':'Twister'},headers={'origin':'https://elsewhere.invalid'}).status_code,403)

    def test_backend_channel_conversion_and_port_renumbering(self):
        import mido
        from midibrain.performance.runtime import from_mido
        self.session.open_input_names={'Twister 42:0'}
        armed=self.session.arm_learn('Twister 24:0')
        self.session.observe_learn('Twister 42:0',from_mido(mido.Message('control_change',channel=0,control=17,value=64)))
        result=self.session.learn_status(armed['id'])
        self.assertEqual((result['channel'],result['cc']), (1,17))
