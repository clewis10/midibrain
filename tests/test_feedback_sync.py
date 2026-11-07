"""Bi-directional MIDI: which channel feedback shows, and opt-in device sync.

Device sync lets a destination that transmits its own changes (on its `input`
port) update MIDIBRAIN's value and the controller feedback. It is off unless a
mapping chooses `track` (update this channel) or `link` (also copy the change
to the mapping's other channels and sends).
"""
import copy
import unittest

import mido
from fastapi.testclient import TestClient

from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.banks import validate_setup
from midibrain.performance.engine import CC, Event
from midibrain.performance.features import default_mod
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session, run
from midibrain.performance.web import create_app
from test_patchbay import Port

LOW_1, LOW_3 = 33, 35  # L6 low-EQ CCs for channels 1 and 3 (MIDI channel 1)


def profile(sync=None, feedback_from=None, device_input='Mixer In'):
    p = rig_demo_profile()
    p['ports']['a4_input'] = 'A4'  # live validation needs every controller input named
    devices = p['bank_setup']['devices']
    devices[0].update(input='Twister', feedback_output='Twister')
    devices[1].update(output='Mixer', input=device_input)
    binding = p['bank_setup']['banks'][0]['controls'][0]['normal']  # Bank 1 (ch 1+3) · Low
    if sync: binding['device_sync'] = sync
    if feedback_from is not None: binding['feedback_from'] = feedback_from
    return p


def engine(**options):
    sent = []
    result = BankEngine(profile(**options), sent.append)
    result.initialize(0.)
    sent.clear()
    return result, sent


def device_cc(cc, value):
    return Event('control_change', 1, cc, value)


def feedback(sent):
    return [m for m in sent if m.destination == 'feedback:twister' and m.value is not None and (m.channel, m.control) == (1, 0)]


class FeedbackChannelTests(unittest.TestCase):
    # What the controller's ring for Bank 1 · Low currently shows.
    def shown(self, e):
        return e.last_output['feedback:twister', 1, 0]

    def test_feedback_follows_the_first_channel_by_default_and_a_chosen_one_when_set(self):
        for chosen, expected in [(None, 64), (3, 100)]:
            e, sent = engine(feedback_from=chosen)
            e.set_base(('l6', 3, 'low'), 100)
            e.refresh_feedback()
            self.assertEqual(self.shown(e), expected, chosen)

    def test_a_feedback_channel_that_left_the_strip_falls_back_to_the_first(self):
        e, sent = engine(feedback_from=6)
        e.set_base(('l6', 3, 'low'), 100)
        e.refresh_feedback()
        self.assertEqual(self.shown(e), 64)

    def test_validation(self):
        good = profile(sync='link', feedback_from=3)['bank_setup']
        validate_setup(good)
        for field, value in [('device_sync', 'both'), ('feedback_from', 'ch3'), ('feedback_from', 17)]:
            setup = copy.deepcopy(good)
            setup['banks'][0]['controls'][0]['normal'][field] = value
            with self.assertRaises(ValueError, msg=(field, value)):
                validate_setup(setup)
        setup = copy.deepcopy(good)
        setup['devices'][1]['input'] = ''
        with self.assertRaises(ValueError):
            validate_setup(setup)


class DeviceSyncTests(unittest.TestCase):
    def test_off_by_default_ignores_device_changes(self):
        e, sent = engine()
        self.assertEqual(e.device_sync, {})
        e.handle('l6', device_cc(LOW_1, 100), 1.)
        self.assertEqual(e.bank_values['l6', 1, 'low'], 64)

    def test_track_updates_only_that_channel_and_feedback_without_echoing(self):
        e, sent = engine(sync='track')
        e.handle('l6', device_cc(LOW_1, 100), 1.)
        self.assertEqual(e.bank_values['l6', 1, 'low'], 100)
        self.assertEqual(e.bank_values['l6', 3, 'low'], 64)
        self.assertFalse([m for m in sent if m.destination == 'l6' and m.value is not None], 'nothing is sent back to the device')
        self.assertEqual(feedback(sent)[-1].value, 100)
        self.assertEqual(e.last_output['l6', 1, LOW_1], 100)
        # MIDIBRAIN later moving the control is not suppressed by stale dedup state.
        sent.clear()
        e.handle('twister', Event('control_change', 1, 0, 100), 2.)
        self.assertEqual([(m.control, m.value) for m in sent if m.destination == 'l6'], [(LOW_3, 100)])

    def test_link_copies_the_change_to_the_other_channels(self):
        e, sent = engine(sync='link')
        e.handle('l6', device_cc(LOW_3, 20), 1.)
        self.assertEqual(e.bank_values['l6', 1, 'low'], 20)
        self.assertEqual(e.bank_values['l6', 3, 'low'], 20)
        self.assertEqual([(m.control, m.value) for m in sent if m.destination == 'l6' and m.value is not None], [(LOW_1, 20)])

    def test_echoes_of_our_own_output_are_ignored(self):
        e, sent = engine(sync='link')
        e.handle('l6', device_cc(LOW_1, 64), 1.)
        self.assertEqual(sent, [])

    def test_modulated_parameters_are_not_folded_into_the_base_value(self):
        p = profile(sync='track')
        mod = default_mod(1)
        mod.update(shape='sine', enabled=True, playback='loop', destinations=[dict(device='l6', parameter='low', channels=[1], banks=[], amount=.5, scale_by_bank=False)])
        p['performance'] = copy.deepcopy(BankEngine(p, lambda m: None).features.config)
        p['performance']['mods'][1] = mod
        e = BankEngine(p, lambda m: None)
        e.initialize(0.)
        e.features.sources[1].config['enabled'] = True
        e.handle('l6', device_cc(LOW_1, 110), 1.)
        self.assertEqual(e.bank_values['l6', 1, 'low'], 64)

    def test_device_input_never_triggers_actions_or_panic(self):
        e, sent = engine(sync='track')
        e.features.sources[0].trigger(0., 0.)
        e.handle('l6', Event('control_change', 1, 123, 0), 1.)
        e.handle('l6', Event('stop'), 1.)
        self.assertTrue(e.features.sources[0].gates)

    def test_a_newer_device_value_withdraws_a_stale_queued_value(self):
        session = Session(profile(sync='track'), demo=True)
        session.engine.set_base(('l6', 1, 'low'), 30)
        self.assertEqual(session.pending['l6', 1, LOW_1].value, 30)
        session.engine.handle('l6', device_cc(LOW_1, 100), 1.)
        self.assertNotIn(('l6', 1, LOW_1), session.pending)


class Backend:
    Message = mido.Message

    def __init__(self):
        self.inputs = {'Twister': Port(), 'Mixer In': Port(), 'A4': Port()}
        self.outputs = {'Twister': Port(), 'Mixer': Port()}

    def get_input_names(self): return list(self.inputs)
    def get_output_names(self): return list(self.outputs)
    def open_input(self, name): return self.inputs[name]
    def open_output(self, name): return self.outputs[name]


class RuntimeSyncTests(unittest.TestCase):
    def test_runtime_opens_the_device_input_and_routes_its_changes(self):
        backend = Backend()
        backend.inputs['Mixer In'].messages.append(mido.Message('control_change', channel=0, control=LOW_1, value=100))
        session = Session(profile(sync='track'), allow_unverified=True)
        run(session, backend=backend, duration=.05, allow_missing=True)
        endpoint = next(e for e in session.connection_status['endpoints'] if e['configured'] == 'Mixer In')
        self.assertEqual((endpoint['direction'], endpoint['state']), ('input', 'connected'))
        self.assertEqual(session.engine.bank_values['l6', 1, 'low'], 100)
        self.assertFalse([m for m in backend.outputs['Mixer'].sent if m.type == 'control_change' and m.control == LOW_1 and m.value == 100])
        self.assertIn(100, [m.value for m in backend.outputs['Twister'].sent if m.type == 'control_change' and m.channel == 0 and m.control == 0])
        self.assertTrue(any(event.get('input') == 'Mixer In' and 'at' in event for event in session.events))

    def test_strict_runtime_resolves_the_device_input_too(self):
        backend = Backend()
        session = Session(profile(sync='track'), allow_unverified=True)
        run(session, backend=backend, duration=.02)
        self.assertEqual(session.active_ports.get('l6_input'), 'Mixer In')


class SystemEndpointTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(rig_demo_profile(), demo=True)
        self.session.running = True
        self.session.engine.initialize(0.)
        self.client = TestClient(create_app(self.session))

    def test_system_payload(self):
        self.client.post('/api/demo-note', json={'note': 60, 'velocity': 100})
        system = self.client.get('/api/patch/system').json()
        for key in ('running', 'demo', 'uptime', 'connections', 'available', 'events', 'update_hz', 'output_limits', 'clock', 'tracked', 'known', 'mods', 'device_sync', 'snapshots'):
            self.assertIn(key, system)
        self.assertTrue(system['demo'])
        self.assertIsNone(system['config_path'])
        self.assertEqual(system['output_limits']['per_second'], 500)
        inbound = [event for event in system['events'] if 'input' in event]
        self.assertEqual(inbound[-1]['note'], 60)
        self.assertIn('at', inbound[-1])

    def test_live_payload_is_compact_and_cached(self):
        live = self.client.get('/api/patch/live').json()
        self.assertEqual(set(live), {'instance_id', 'running', 'native', 'definitions_revision', 'staged', 'controls', 'inputs', 'mods', 'sources', 'clock', 'shift', 'error', 'active_layers', 'direct_controls', 'note_live', 'snapshots_saved', 'snapshots_info', 'offline_ports', 'operators', 'queued_slot', 'queued_at_bar'})
        state = self.client.get('/api/patch/state').json()
        self.assertEqual(live['definitions_revision'], state['definitions_revision'])
        engine = self.session.engine
        self.assertIs(self.session._patch_definitions[0], engine)
        self.assertEqual(self.client.get('/api/patch/live').json()['definitions_revision'], live['definitions_revision'])


if __name__ == '__main__':
    unittest.main()
