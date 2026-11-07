import copy
import math
import random
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from fastapi.testclient import TestClient
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.engine import Event
from midibrain.performance.features import defaults, validate_config, ModSource, MusicalClock
from midibrain.performance.profile import validate
from midibrain.performance.banks import validate_setup
from midibrain.performance.snapshot_store import SnapshotStore
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


def button(number, kind='recall', **kwargs):
    return dict(controller='twister', type='cc', channel=16, number=number, action=kind, slot=0, **kwargs)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.profile = rig_demo_profile()
        self.sent = []
        self.engine = BankEngine(self.profile, self.sent.append)
        self.engine.initialize(0)
        self.f = self.engine.features
        self.ref = ('l6', 1, 'low')

    def configure(self, **kwargs):
        c = copy.deepcopy(self.f.config); c.update(kwargs); self.f.configure(c, 0)

    def cc(self, cc, value, now=0):
        self.engine.handle('twister', Event('control_change', 16, control=cc, value=value), now)

    def test_unknown_defaults_are_not_captured(self):
        self.profile['bank_setup']['devices'][1]['initialize'] = False
        e = BankEngine(self.profile, lambda _: None); e.initialize(0)
        e.features.capture(0)
        self.assertEqual(e.features.captures[0]['values'], [])
        self.assertGreater(e.features.captures[0]['unknown'], 0)
        e.set_base(self.ref, 91); e.features.capture(0)
        self.assertEqual(len(e.features.captures[0]['values']), 1)

    def test_mixed_values_scope_and_recall(self):
        c = copy.deepcopy(self.f.config); c['slots'][0]['banks'] = ['bank-1']; self.f.configure(c, 0)
        self.engine.set_base(self.ref, 22); self.engine.set_base(('l6', 3, 'low'), 99)
        self.f.capture(0)
        self.engine.reset_bank('bank-1')
        self.f.request(dict(action='recall', slot=0), 1)
        self.assertEqual(self.engine.bank_values[self.ref], 22)
        self.assertEqual(self.engine.bank_values['l6', 3, 'low'], 99)
        self.assertEqual({r['ref'][1] for r in self.f.captures[0]['values']}, {1, 3})

    def test_reset_and_snapshot_exclusions_independent(self):
        p = self.engine.parameter_info(self.ref)[0]
        self.engine.set_base(self.ref, 88); self.f.capture(0)
        p['include_reset'] = False
        self.engine.reset_bank('bank-1'); self.assertEqual(self.engine.bank_values[self.ref], 88)
        p['include_snapshot'] = False
        self.engine.set_base(self.ref, 31); self.f.recall(self.f.captures[0])
        self.assertEqual(self.engine.bank_values[self.ref], 31)
        self.f.capture(1)
        self.assertNotIn(list(self.ref), [r['ref'] for r in self.f.captures[1]['values']])

    def test_atomic_incompatible_recall(self):
        self.engine.set_base(self.ref, 80); self.f.capture(0)
        self.engine.set_base(self.ref, 7)
        self.f.captures[0]['values'][-1]['signature'][2] += 1
        with self.assertRaises(ValueError): self.f.recall(self.f.captures[0])
        self.assertEqual(self.engine.bank_values[self.ref], 7)

    def test_optional_depth_capture_and_reset(self):
        bank = self.engine.banks['bank-1']
        bank.update(depth_include_snapshot=True, depth_include_reset=True)
        self.engine.set_bank_depth('bank-1', .72); self.f.capture(0)
        self.engine.reset_bank('bank-1'); self.assertEqual(bank['depth'], 0)
        self.f.recall(self.f.captures[0]); self.assertEqual(bank['depth'], .72)

    def test_recall_does_not_release_held_notes(self):
        self.f.capture(0)
        self.engine.handle('a4', Event('note_on', self.profile['trigger']['channel'], note=60, velocity=127), .1)
        before = self.engine.envelope
        self.f.recall(self.f.captures[0]); self.assertEqual(self.engine.envelope, before)
        self.assertTrue(self.engine.notes)

    def test_shift_exclusive_and_latched_on_press(self):
        self.configure(shift=dict(controller='twister', type='cc', channel=16, number=119, mode='momentary'),
                       actions=[button(110, 'recall', shift='off'), button(110, 'capture', shift='on')])
        self.engine.set_base(self.ref, 90); self.f.capture(0); self.engine.set_base(self.ref, 12)
        self.cc(119, 127); self.cc(110, 127)
        self.assertEqual(self.engine.bank_values[self.ref], 12)
        self.cc(119, 0); self.engine.set_base(self.ref, 45); self.cc(110, 127); self.cc(110, 0)
        self.assertEqual(self.engine.bank_values[self.ref], 45)
        self.cc(110, 127); self.assertEqual(self.engine.bank_values[self.ref], 12)

    def test_toggle_shift_and_save_hold(self):
        self.configure(shift=dict(controller='twister', type='cc', channel=16, number=119, mode='toggle'),
                       actions=[button(110, 'capture', shift='on', hold_ms=700)])
        self.cc(119, 127); self.cc(119, 0); self.assertTrue(self.f.shift)
        self.cc(110, 127, .1); self.engine.tick(.5); self.assertIsNone(self.f.captures[0])
        self.cc(110, 0, .6); self.engine.tick(1); self.assertIsNone(self.f.captures[0])
        self.cc(110, 127, 1.1); self.engine.tick(1.9); self.assertIsNotNone(self.f.captures[0])
        revision = self.f.revision; self.engine.tick(3); self.cc(110, 0, 3.1)
        self.assertEqual(self.f.revision, revision)
        self.cc(119, 127, 3.2); self.assertFalse(self.f.shift)

    def test_conflicts_rejected_but_shift_variants_allowed(self):
        c = copy.deepcopy(self.f.config); c['actions'] = [button(110), button(110)]
        with self.assertRaises(ValueError): validate_config(c, self.engine.setup)
        c['actions'] = [dict(button(8), channel=4)]
        with self.assertRaises(ValueError): validate_config(c, self.engine.setup)
        c['actions'] = [button(110, shift='on')]
        with self.assertRaises(ValueError): validate_config(c, self.engine.setup)

    def start_clock(self):
        self.f.clock_event(SimpleNamespace(type='start'), 0)
        self.f.clock_event(SimpleNamespace(type='clock'), 0)
        self.f.clock_event(SimpleNamespace(type='clock'), .02)

    def test_bar_recall_immutable_and_exact_boundary(self):
        self.start_clock()
        self.engine.set_base(self.ref, 20); self.f.capture(0)
        self.f.request(dict(action='recall', slot=0, when='bar'), .02)
        self.engine.set_base(self.ref, 90); self.f.capture(0)
        for pulse in range(2, 96): self.f.clock_event(SimpleNamespace(type='clock'), pulse * .02)
        self.assertEqual(self.engine.bank_values[self.ref], 90)
        self.f.clock_event(SimpleNamespace(type='clock'), 96 * .02)
        self.assertEqual(self.engine.bank_values[self.ref], 20)
        self.assertIsNone(self.f.pending)

    def test_a_snapshot_can_recall_on_the_one_every_n_bars(self):
        self.start_clock()
        slots = copy.deepcopy(self.f.config['slots']); slots[0].update(node=True, targets=[dict(type='all')], quantize_bars=2)
        self.configure(slots=slots)
        self.engine.set_base(self.ref, 20); self.f.capture(0)
        self.engine.set_base(self.ref, 90)
        self.f.request(dict(action='recall', slot=0), .02)          # the button asks for an instant recall; the snapshot's own timing wins
        self.assertEqual(self.f.pending['bars'], 2)
        self.assertEqual(self.f.pending['at'], 192)
        for pulse in range(2, 192): self.f.clock_event(SimpleNamespace(type='clock'), pulse * .02)
        self.assertEqual(self.engine.bank_values[self.ref], 90)      # one bar in: still waiting
        self.f.clock_event(SimpleNamespace(type='clock'), 192 * .02)
        self.assertEqual(self.engine.bank_values[self.ref], 20)
        slots[0]['quantize_bars'] = 3
        with self.assertRaisesRegex(ValueError, 'Recall timing'): self.configure(slots=slots)
        slots[0]['quantize_bars'] = 0
        self.configure(slots=slots)
        self.f.request(dict(action='recall', slot=0, when='bar', bars=4), .02)
        self.assertEqual(self.f.pending['at'], 384)

    def test_bar_reset_and_clock_loss_cancel(self):
        with self.assertRaises(ValueError): self.f.request(dict(action='reset', when='bar'), 0)
        self.start_clock(); self.f.request(dict(action='reset', when='bar'), .02)
        self.engine.tick(2); self.assertIsNone(self.f.pending)
        self.start_clock(); self.f.request(dict(action='reset', when='bar'), .02)
        self.f.clock_event(SimpleNamespace(type='stop'), .03); self.assertIsNone(self.f.pending)

    def test_alias_policies_must_agree(self):
        setup = copy.deepcopy(self.engine.setup)
        ch = setup['devices'][1]['channels'][0]
        ch['parameters']['alias'] = dict(ch['parameters']['low'], alias=True, include_snapshot=False)
        with self.assertRaises(ValueError): validate_setup(setup)


class ModTests(unittest.TestCase):
    def source(self, **kwargs):
        c = defaults()['mods'][1]; c.update(enabled=True, **kwargs)
        return ModSource(c, 0, random.Random(7))

    def test_phase_one_shot_and_note_off_independence(self):
        clock = MusicalClock(); source = self.source(playback='one_shot', phase=90)
        self.assertEqual(source.sample(0, clock), 0)
        source.trigger(0, 0); self.assertAlmostEqual(source.sample(0, clock), 1)
        source.trigger(.1, 0, on=False)
        self.assertAlmostEqual(source.sample(.25, clock), 0, places=6)
        self.assertEqual(source.sample(1, clock), 0); self.assertFalse(source.active)

    def test_random_shared_sequence_independent_of_tick_rate(self):
        clock = MusicalClock(); a = self.source(shape='random'); b = self.source(shape='random')
        for t in [0, .1, .8, 1, 1.1, 1.5, 2]: a.sample(t, clock)
        b.sample(0, clock)
        self.assertEqual(a.sample(2.2, clock), b.sample(2.2, clock))
        self.assertEqual(a.sample(2.2, clock), a.sample(2.8, clock))

    def test_random_slew(self):
        c = MusicalClock(); s = self.source(shape='random', slew=1)
        self.assertEqual(s.sample(0, c), 0)
        halfway = s.sample(.5, c); self.assertAlmostEqual(halfway, s.target * .5)
        self.assertAlmostEqual(s.sample(1, c), s.previous)

    def test_gate_release_and_overlapping_notes(self):
        c = MusicalClock(); s = self.source(shape='envelope', playback='gate', release_ms=100)
        s.trigger(0, 0, .4, key='a'); self.assertEqual(s.sample(0, c), .4)
        s.trigger(.1, 0, 1., key='b'); self.assertEqual(s.sample(.1, c), 1)
        s.trigger(.2, 0, key='b', on=False); self.assertAlmostEqual(s.sample(.3, c), .4)
        s.trigger(.4, 0, key='a', on=False); self.assertAlmostEqual(s.sample(.45, c), .2)
        self.assertAlmostEqual(s.sample(.5, c), 0)

    def test_gate_missing_off_expires(self):
        s = self.source(shape='envelope', playback='gate', release_ms=0)
        s.trigger(0, 0); s.sample(0, MusicalClock())
        self.assertEqual(s.sample(31, MusicalClock()), 0)

    def test_sync_one_shot_and_clock_stop(self):
        c = MusicalClock(); c.handle(SimpleNamespace(type='start'), 0)
        c.handle(SimpleNamespace(type='clock'), 0); c.handle(SimpleNamespace(type='clock'), .02)
        s = self.source(timing='sync', playback='one_shot', phase=90)
        s.trigger(.02, c.position(.02)); self.assertAlmostEqual(s.sample(.02, c), 1)
        c.handle(SimpleNamespace(type='stop'), .03); self.assertEqual(s.sample(.03, c), 0)
        self.assertFalse(s.active)

    def test_engine_composes_manual_capture_recall_and_bypass(self):
        p = rig_demo_profile()
        p['bank_setup']['devices'][1]['channels'][0]['parameters']['low']['continuous'] = True
        sent=[]; e=BankEngine(p, sent.append); e.initialize(0)
        c=copy.deepcopy(e.features.config); c['mods'][1].update(enabled=True, phase=90, targets=[dict(ref=['l6',1,'low'],amount=.25)])
        e.features.configure(c,0); e.set_base(('l6',1,'low'),64); e.tick(0)
        self.assertEqual(e.bank_values['l6',1,'low'],64)
        addr=e.parameter_info(('l6',1,'low'))[0]
        self.assertEqual(e.last_output['l6',addr['channel'],addr['cc']],96)
        e.features.capture(0); e.set_base(('l6',1,'low'),100); e.features.recall(e.features.captures[0])
        self.assertEqual(e.bank_values['l6',1,'low'],64)
        e.features.stop_mods(.1)
        self.assertEqual(e.last_output['l6',addr['channel'],addr['cc']],64)

    def test_enabled_sources_load_bypassed_except_sidechain(self):
        p=rig_demo_profile(); p['performance']=defaults(); p['performance']['mods'][1]['enabled']=True
        e=BankEngine(p,lambda _:None)
        self.assertFalse(e.features.config['mods'][1]['enabled']); self.assertTrue(e.features.sidechain_enabled())

    def test_malformed_or_duplicate_mod_target_rejected(self):
        p=rig_demo_profile(); p['bank_setup']['devices'][1]['channels'][0]['parameters']['low']['continuous']=False
        c=defaults(); c['mods'][1]['targets']=[dict(ref=['l6',1,'low'],amount=.2)]
        with self.assertRaises(ValueError): validate_config(c,p['bank_setup'])
        p['bank_setup']['devices'][1]['channels'][0]['parameters']['low']['continuous']=True
        c['mods'][2]['targets']=copy.deepcopy(c['mods'][1]['targets'])
        validate_config(c,p['bank_setup'])  # Several MODs may share a destination; they sum.
        c['mods'][2]['targets']=c['mods'][1]['targets']*2
        with self.assertRaises(ValueError): validate_config(c,p['bank_setup'])
        c['mods'][2]['targets']=[]; c['mods'][1]['rate']=float('nan')
        with self.assertRaises(ValueError): validate_config(c,p['bank_setup'])


class StorageAndAPITests(unittest.TestCase):
    def test_atomic_store_roundtrip_and_latest_capture_wins(self):
        with tempfile.TemporaryDirectory() as d:
            store=SnapshotStore(Path(d)/'rig.json')
            for i in range(10): store.submit([dict(values=[],depths=[],unknown=i)]+[None]*7,i+1)
            store.flush()
            self.assertEqual(store.load()[0]['unknown'],9)
            self.assertEqual(store.status()['saved_revision'],10)
            self.assertFalse((Path(d)/'rig.json').exists())

    def test_api_capture_and_configuration_errors(self):
        s=Session(rig_demo_profile(),demo=True); s.running=True; s.engine.initialize(0)
        with TestClient(create_app(s)) as c:
            self.assertEqual(c.get('/api/performance').status_code,200)
            self.assertEqual(c.post('/api/performance/action',json={'action':'capture','slot':0}).status_code,200)
            self.assertTrue(c.get('/api/performance').json()['slots'][0]['saved'])
            self.assertEqual(c.post('/api/performance/action',json={}).status_code,400)
            self.assertEqual(c.post('/api/performance/action',json={'action':'recall','slot':9}).status_code,400)
            config=defaults();config['mods'][0]['rate']=-1
            self.assertEqual(c.post('/api/performance/config',json=config).status_code,400)
            self.assertEqual(c.post('/api/performance/delete',json={'slot':0}).status_code,200)
            self.assertFalse(c.get('/api/performance').json()['slots'][0]['saved'])
            self.assertEqual(c.get('/performance.js').status_code,200)

    def test_note_learn(self):
        s=Session(rig_demo_profile(),demo=True); s.demo=False
        s.running=True; s.open_input_names={'controller'}
        token=s.arm_learn('controller','note')['id']
        s.observe_learn('controller',Event('note_on',3,note=45,velocity=0))
        self.assertEqual(s.learn_status(token)['state'],'listening')
        s.observe_learn('controller',Event('note_on',3,note=45,velocity=80))
        self.assertEqual(s.learn_status(token)['number'],45)

    def test_profile_rejects_feature_configuration_for_missing_bank(self):
        p=rig_demo_profile();p['performance']=defaults();p['performance']['slots'][0]['banks']=['gone']
        with self.assertRaises(ValueError): validate(p)

class IntegrationTests(unittest.TestCase):
    def test_configuration_only_edit_preserves_held_sidechain(self):
        p=rig_demo_profile(); e=BankEngine(p,lambda _:None); e.initialize(0)
        e.handle('a4',Event('note_on',p['trigger']['channel'],note=60,velocity=100),.1)
        c=copy.deepcopy(e.features.config);c['slots'][0]['name']='Home';e.features.configure(c,.2)
        self.assertTrue(e.notes);self.assertGreater(e.envelope,0)

    def test_source_amount_preserves_per_target_ratios(self):
        p=rig_demo_profile()
        for ch in p['bank_setup']['devices'][1]['channels'][:2]: ch['parameters']['low']['continuous']=True
        e=BankEngine(p,lambda _:None);e.initialize(0);c=copy.deepcopy(e.features.config)
        c['mods'][1].update(targets=[dict(ref=['l6',1,'low'],amount=-.2),dict(ref=['l6',2,'low'],amount=.5)])
        c['actions']=[button(110,'mod_amount',mod=1)]
        e.features.configure(c,0)
        e.handle('twister',Event('control_change',16,control=110,value=0),.1)
        e.handle('twister',Event('control_change',16,control=110,value=127),.2)
        self.assertEqual([t['amount'] for t in e.features.config['mods'][1]['targets']],[-.2,.5])

    def test_sidechain_mod_trigger_action_and_note_off(self):
        e=BankEngine(rig_demo_profile(),lambda _:None);e.initialize(0)
        c=copy.deepcopy(e.features.config);c['actions']=[button(110,'mod_trigger',mod=0)]
        e.features.configure(c,0)
        e.handle('twister',Event('control_change',16,control=110,value=127),.1)
        self.assertEqual(e.envelope,1)
        e.handle('twister',Event('control_change',16,control=110,value=0),.2)
        e.tick(1);self.assertEqual(e.envelope,0)

    def test_rate_edit_does_not_recalculate_entire_elapsed_phase(self):
        c=defaults()['mods'][1];c.update(enabled=True,shape='saw_up')
        s=ModSource(c,0);clock=MusicalClock();s.sample(.25,clock)
        c['rate']=2
        self.assertAlmostEqual(s.sample(.25,clock),-.5)
        self.assertAlmostEqual(s.sample(.5,clock),.5)

    def test_disk_error_reported_and_can_retry(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            store=SnapshotStore(Path(d)/'rig.json')
            with patch('midibrain.performance.snapshot_store.save',side_effect=OSError('disk full')):
                store.submit([None]*8,1);store.flush()
            self.assertEqual(store.status()['error'],'disk full')
            self.assertEqual(store.saved_revision,0)
            store.submit([None]*8,2);store.flush()
            self.assertIsNone(store.status()['error']);self.assertEqual(store.saved_revision,2)

    def test_runtime_consumes_clock_without_forwarding_and_routes_note_trigger(self):
        from collections import deque
        import mido
        from midibrain.performance.runtime import run
        class Port:
            def __init__(self, messages=()): self.messages=deque(messages);self.sent=[]
            def poll(self): return self.messages.popleft() if self.messages else None
            def send(self,m): self.sent.append(m)
            def __enter__(self): return self
            def __exit__(self,*a): pass
        p=rig_demo_profile();p['ports']=dict(a4_input='Trigger',twister_input='Twister',l6_output='Mixer',twister_output='Twister')
        p['bank_setup']['devices'][0].update(input='Twister',feedback_output='Twister')
        p['bank_setup']['devices'][1]['output']='Mixer'
        p['performance']=defaults()
        p['performance']['actions']=[button(110,'capture')]
        p['routing']=dict(clock=dict(source='Clock',destinations=[],transport=False),cc=[])
        inputs={'Trigger':Port(),'Twister':Port([mido.Message('control_change',channel=15,control=110,value=127)]),
                'Clock':Port([mido.Message('start')]+[mido.Message('clock') for _ in range(24)])}
        outputs={'Mixer':Port(),'Twister':Port()}
        class Backend:
            Message=mido.Message
            def get_input_names(self):return list(inputs)
            def get_output_names(self):return list(outputs)
            def open_input(self,n):return inputs[n]
            def open_output(self,n):return outputs[n]
        s=Session(p,allow_unverified=True);run(s,backend=Backend(),duration=.05)
        self.assertTrue(s.engine.features.clock.aligned)
        self.assertEqual(s.engine.features.clock.pulses,23)
        self.assertIsNotNone(s.engine.features.captures[0])
        self.assertTrue(all(m.type=='control_change' for p in outputs.values() for m in p.sent))
        # Startup parameter output and best-effort shutdown restoration both occur.
        self.assertTrue(outputs['Mixer'].sent)

class ClockEdgeTests(unittest.TestCase):
    def test_continue_advances_next_pulse_and_songpos_sets_origin(self):
        c=MusicalClock();c.handle(SimpleNamespace(type='start'),0)
        c.handle(SimpleNamespace(type='clock'),0);c.handle(SimpleNamespace(type='clock'),.02)
        c.handle(SimpleNamespace(type='stop'),.03);c.handle(SimpleNamespace(type='continue'),.1)
        c.handle(SimpleNamespace(type='clock'),.12);self.assertEqual(c.pulses,2)
        c.handle(SimpleNamespace(type='songpos',pos=8),.13)
        c.handle(SimpleNamespace(type='clock'),.14);self.assertEqual(c.pulses,48)

    def test_clock_loss_requires_alignment_before_new_scheduled_actions(self):
        c=MusicalClock();c.handle(SimpleNamespace(type='start'),0);c.handle(SimpleNamespace(type='clock'),0)
        c.handle(SimpleNamespace(type='clock'),2)
        self.assertFalse(c.valid(2));c.align(2);self.assertTrue(c.valid(2))


class UnifiedModTests(unittest.TestCase):
    def setUp(self):
        self.engine = BankEngine(rig_demo_profile(), lambda _: None)
        self.engine.initialize(0)
        self.f = self.engine.features

    def test_three_independent_envelopes_and_bank_amounts(self):
        config = copy.deepcopy(self.f.config)
        for i, mod in enumerate(config['mods']):
            mod.update(shape='envelope', playback='gate', timing='free', enabled=True,
                       release_ms=100*(i+1), velocity=False,
                       trigger=dict(controller='a4', type='note', channel=i+1, number=None),
                       bank_targets=[dict(bank='bank-1', parameter='volume')])
            self.engine.set_bank_mod_depth('bank-1', i, .2*(i+1))
        self.f.configure(config, 0)
        for i in range(3):
            self.engine.handle('a4', Event('note_on', i+1, note=60+i, velocity=50), 0)
        self.assertEqual(self.f.values, [1., 1., 1.])
        self.assertAlmostEqual(self.f.volume_attenuation('l6', 1), .6)
        for i in range(3):
            self.engine.handle('a4', Event('note_off', i+1, note=60+i, velocity=0), 0)
        self.engine.tick(.1)
        for actual, expected in zip(self.f.values, [0., .5, 2/3]):
            self.assertAlmostEqual(actual, expected)
        self.assertAlmostEqual(self.f.volume_attenuation('l6', 1), .4)
        self.engine.tick(.31)
        self.assertEqual(self.f.values, [0., 0., 0.])

    def test_midi_amount_release_and_persistence(self):
        config = copy.deepcopy(self.f.config)
        config['actions'] = [button(110, 'mod_depth', mod=2, bank='bank-1'), button(111, 'mod_release', mod=2)]
        self.f.configure(config, 0)
        for cc, value in [(110, 127), (111, 64)]:
            self.engine.handle('twister', Event('control_change', 16, control=cc, value=value), 0)
        self.assertEqual(self.engine.bank_mod_depth(self.engine.banks['bank-1'], 2), 1.)
        self.assertAlmostEqual(self.f.config['mods'][2]['release_ms'], 64/127*2000)
        restored = BankEngine(self.engine.settings_profile(), lambda _: None)
        self.assertEqual(restored.bank_mod_depth(restored.banks['bank-1'], 2), 1.)
        self.assertEqual(restored.features.config['mods'][2]['release_ms'], self.f.config['mods'][2]['release_ms'])

    def test_snapshot_and_reset_policies_cover_all_amounts(self):
        bank = self.engine.banks['bank-1']
        for i in range(3): self.engine.set_bank_mod_depth('bank-1', i, .3)
        self.engine.reset_bank('bank-1')
        self.assertEqual([self.engine.bank_mod_depth(bank, i) for i in range(3)], [.3]*3)
        bank['depth_include_snapshot'] = True
        bank['depth_include_reset'] = True
        self.f.capture(0)
        self.engine.reset_bank('bank-1')
        self.assertEqual([self.engine.bank_mod_depth(bank, i) for i in range(3)], [0.]*3)
        self.f.recall(self.f.captures[0])
        self.assertEqual([self.engine.bank_mod_depth(bank, i) for i in range(3)], [.3]*3)
        bank['depth_include_snapshot'] = False
        self.engine.reset_bank('bank-1')
        self.f.recall(self.f.captures[0])
        self.assertEqual([self.engine.bank_mod_depth(bank, i) for i in range(3)], [0.]*3)

    def test_bank_parameter_output_preserves_base_and_ownership(self):
        config = copy.deepcopy(self.f.config)
        config['mods'][1].update(enabled=True, phase=90, bank_targets=[dict(bank='bank-1', parameter='low')])
        self.engine.set_bank_mod_depth('bank-1', 1, .25)
        self.f.configure(config, 0)
        self.engine.tick(0)
        ref = ('l6', 1, 'low')
        addr = self.engine.parameter_info(ref)[0]
        self.assertEqual(self.engine.bank_values[ref], 64)
        self.assertEqual(self.engine.last_output['l6', addr['channel'], addr['cc']], 96)
        # A second MOD on the same parameter sums with the first, then clamps.
        config['mods'][2].update(enabled=True, phase=90, bank_targets=[dict(bank='bank-1', parameter='low')])
        self.engine.set_bank_mod_depth('bank-1', 2, .25)
        self.f.configure(config, 0)
        self.engine.tick(0)
        self.assertEqual(self.engine.bank_values[ref], 64)
        self.assertEqual(self.engine.last_output['l6', addr['channel'], addr['cc']], 127)
        self.engine.set_bank_mod_depth('bank-1', 2, .1)
        self.engine.tick(0)
        self.assertEqual(self.engine.last_output['l6', addr['channel'], addr['cc']], 108)

    def test_any_note_trigger_cannot_shadow_an_action(self):
        config = copy.deepcopy(self.f.config)
        config['actions'] = [dict(controller='a4', type='note', channel=5, number=60, action='capture', slot=0)]
        with self.assertRaisesRegex(ValueError, 'trigger conflicts'):
            self.f.configure(config, 0)

    def test_activity_status_exposes_each_source_and_clock_tempo(self):
        state = self.f.state(0)
        self.assertEqual(len(state['sources']), 3)
        self.assertEqual(set(state['sources'][0]), {'active', 'held', 'expired'})
        self.assertIsNone(state['clock']['bpm'])
        self.f.clock.period = 60 / (120 * 24)
        self.assertAlmostEqual(self.f.state(0)['clock']['bpm'], 120)

    def test_compact_activity_snapshot(self):
        session = Session(rig_demo_profile(), demo=True)
        session.engine.initialize(0)
        session.running = True
        activity = session.activity_snapshot()
        self.assertEqual(len(activity['performance']['sources']), 3)
        self.assertEqual(len(activity['banks']['active']['banks']), 4)
        self.assertEqual(activity['performance']['target_counts']['tracked'], len(session.engine.bank_values))
        self.assertEqual(activity['performance']['targets'], [])


class CanvasSnapshotTests(unittest.TestCase):
    """Snapshot nodes on the patch canvas: more than 8, scoped only by what they are wired to."""

    def setUp(self):
        self.profile = rig_demo_profile()
        self.engine = BankEngine(self.profile, lambda message: None)
        self.engine.initialize(0)
        self.f = self.engine.features

    def slots(self, *extra, count=8):
        slots = copy.deepcopy(self.f.config['slots'])
        while len(slots) < count: slots.append(dict(name=f'Snapshot {len(slots) + 1}', banks=[]))
        for index, slot in extra: slots[index] = dict(name=slots[index]['name'], banks=[], node=True, **slot)
        config = copy.deepcopy(self.f.config); config['slots'] = slots; self.f.configure(config, 0)

    def set_param(self, ref, value):
        self.engine.set_base(ref, value)

    def test_a_node_with_no_wires_captures_nothing(self):
        self.slots((0, dict(targets=[])))
        self.f.capture(0)
        self.assertEqual(self.f.captures[0]['values'], [])

    def test_strip_channel_device_and_all_scopes(self):
        self.slots((0, dict(targets=[dict(type='bank', bank='bank-2')])),
                   (1, dict(targets=[dict(type='channel', device='l6', channel=1)])),
                   (2, dict(targets=[dict(type='device', device='l6')])),
                   (3, dict(targets=[dict(type='all')])))
        for slot in range(4): self.f.capture(slot)
        refs = lambda slot: {tuple(row['ref'][:2]) for row in self.f.captures[slot]['values']}
        self.assertEqual({channel for _, channel in refs(0)}, {2})
        self.assertEqual(refs(1) and {channel for _, channel in refs(1)}, {1})
        self.assertTrue(refs(0) < refs(2) and refs(1) < refs(2))
        self.assertEqual(refs(2), refs(3))

    def test_recall_restores_only_the_scoped_parameters(self):
        self.slots((0, dict(targets=[dict(type='channel', device='l6', channel=1)])))
        self.set_param(('l6', 1, 'low'), 20); self.set_param(('l6', 2, 'low'), 30)
        self.f.capture(0)
        self.set_param(('l6', 1, 'low'), 100); self.set_param(('l6', 2, 'low'), 110)
        self.f.recall(self.f.captures[0])
        self.assertEqual(self.engine.bank_values['l6', 1, 'low'], 20)
        self.assertEqual(self.engine.bank_values['l6', 2, 'low'], 110)

    def test_more_than_eight_snapshots_and_actions_can_use_them(self):
        self.slots((11, dict(targets=[dict(type='all')])), count=12)
        self.assertEqual(len(self.f.captures), 12)
        config = copy.deepcopy(self.f.config)
        config['actions'].append(dict(controller='twister', type='cc', channel=16, number=40, action='recall', slot=11, shift='any', when='instant'))
        validate_config(config, self.engine.setup)
        config['actions'][-1]['slot'] = 12
        with self.assertRaises(ValueError): validate_config(config, self.engine.setup)

    def test_invalid_scope_is_rejected_and_legacy_slots_still_mean_the_whole_rig(self):
        config = copy.deepcopy(self.f.config)
        config['slots'][0] = dict(name='x', banks=[], node=True, targets=[dict(type='bank', bank='gone')])
        with self.assertRaisesRegex(ValueError, 'no longer exists'): validate_config(config, self.engine.setup)
        config['slots'][0] = dict(name='x', banks=[], node=True, targets=[dict(type='channel', device='l6', channel=1, extra=1)])
        with self.assertRaises(ValueError): validate_config(config, self.engine.setup)
        self.f.capture(0)
        self.assertGreater(len(self.f.captures[0]['values']), 10)

    def test_snapshot_file_round_trip_with_extra_slots(self):
        with tempfile.TemporaryDirectory() as folder:
            store = SnapshotStore(Path(folder) / 'rig.json')
            store.submit([None] * 12, 1); store.flush()
            self.assertEqual(len(store.load()), 12)
