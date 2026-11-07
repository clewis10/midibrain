"""Patch canvas: routes, any number of MODs, summing and MOD-to-MOD modulation."""
import copy
import unittest

from fastapi.testclient import TestClient

from midibrain.performance.bank_engine import BankEngine
from midibrain.performance.features import MAX_MODS, default_mod, validate_config
from midibrain.performance.presets import rig_demo_profile
from midibrain.performance.runtime import Session
from midibrain.performance.web import create_app


def engine_with(mods_edit):
    profile = rig_demo_profile()
    engine = BankEngine(profile, lambda message: None)
    config = copy.deepcopy(engine.features.config)
    mods_edit(config['mods'])
    engine.features.configure(config, 0)
    return engine


def sine(index, **values):
    mod = default_mod(index)
    mod.update({'shape': 'sine', 'enabled': True, 'playback': 'loop', **values})
    return mod


class PatchRouteTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(rig_demo_profile(), demo=True)
        self.session.running = True
        self.client = TestClient(create_app(self.session))

    def test_page_and_assets_are_served_alongside_workspace(self):
        page = self.client.get('/patch')
        self.assertEqual(page.status_code, 200)
        self.assertIn('src="/patch.js"', page.text)
        for path, kind in [('/patch.js', 'javascript'), ('/patch-model.mjs', 'javascript'), ('/patch.css', 'css')]:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertIn(kind, response.headers['content-type'])
        self.assertEqual(self.client.get('/workspace').status_code, 200)

    def test_live_payload_reports_offline_ports_and_snapshot_save_times(self):
        self.assertEqual(self.client.get('/api/patch/live').json()['offline_ports'], [])
        self.session.connection_status = dict(discovery_error=None, endpoints=[
            dict(direction='input', configured='Twister', resolved=None, state='unavailable', detail='not found'),
            dict(direction='output', configured='L6', resolved='L6 USB', state='connected', detail=None)])
        live = self.client.get('/api/patch/live').json()
        self.assertEqual(live['offline_ports'], [dict(direction='input', port='Twister', state='unavailable', detail='not found')])
        self.assertEqual(live['snapshots_info'][0], None)
        self.session.engine.features.capture(0)
        info = self.client.get('/api/patch/live').json()['snapshots_info'][0]
        self.assertGreater(info['saved_at'], 1e9)
        self.assertIsInstance(info['values'], int)

    def test_state_and_live_payloads(self):
        state = self.client.get('/api/patch/state').json()
        self.assertTrue(state['native'])
        self.assertEqual(len(state['performance']['draft']['mods']), 3)
        self.assertIn('mod_targets', state['performance']['draft']['mods'][0])
        live = self.client.get('/api/patch/live').json()
        self.assertEqual(len(live['mods']), 3)
        self.assertTrue(live['controls'])
        self.assertEqual(live['definitions_revision'], state['definitions_revision'])
        self.assertTrue(live['running'])
        self.assertFalse(live['staged'])
        self.assertTrue(live['native'])

    def test_apply_checks_revision_atomically_and_never_overwrites_another_editor(self):
        state = self.client.get('/api/patch/state').json()
        performance = copy.deepcopy(state['performance']['draft'])
        performance['mods'][1]['name'] = 'Node edit'
        body = dict(instance_id=state['instance_id'], revision=state['revision'], changes={'performance': performance})
        self.assertEqual(self.client.post('/api/patch/apply', json=body).status_code, 200)
        other = copy.deepcopy(performance)
        other['mods'][1]['name'] = 'Other editor'
        self.session.save_settings({'performance': other})
        before = self.session.engine.settings_profile()
        self.assertEqual(self.client.post('/api/patch/apply', json=body).status_code, 409)
        self.assertEqual(self.session.engine.settings_profile(), before)
        current = self.client.get('/api/patch/state').json()
        body.update(revision=current['revision'], instance_id='old-process')
        self.assertEqual(self.client.post('/api/patch/apply', json=body).status_code, 409)
        self.assertEqual(self.client.post('/api/patch/apply', json={'changes': {}}).status_code, 400)

    def test_patch_playback_uses_workspace_server_guards(self):
        state = self.client.get('/api/patch/state').json()
        live = self.client.get('/api/patch/live').json()
        control = live['controls'][0]
        body = dict(bank=control['bank'], index=control['index'], layer=control['layer'], value=64,
                    expected=control['identity'], runtime_instance=live['instance_id'], definitions_revision=live['definitions_revision'])
        self.assertEqual(self.client.post('/api/bank-control', json=body).status_code, 200)
        for changes in [dict(runtime_instance='old'), dict(definitions_revision='old')]:
            self.assertEqual(self.client.post('/api/bank-control', json={**body, **changes}).status_code, 409)
        self.session.next_performance = state['performance']['draft']
        self.assertTrue(self.client.get('/api/patch/live').json()['staged'])
        self.assertEqual(self.client.post('/api/bank-control', json=body).status_code, 409)
        self.session.next_performance = None
        self.session.running = False
        self.assertEqual(self.client.post('/api/bank-control', json=body).status_code, 409)

    def test_validate_is_dry(self):
        before = self.session.engine.settings_profile()
        performance = copy.deepcopy(self.client.get('/api/patch/state').json()['performance']['draft'])
        performance['mods'].append(sine(3, destinations=[dict(device='l6', parameter='low', channels=[1], banks=[], amount=.5, scale_by_bank=False)]))
        performance['mods'][1]['mod_targets'] = [dict(mod=3, parameter='rate', amount=.5)]
        self.assertEqual(self.client.post('/api/patch/validate', json={'performance': performance}).status_code, 200)
        self.assertEqual(self.session.engine.settings_profile(), before)
        performance['mods'][3]['mod_targets'] = [dict(mod=1, parameter='amount', amount=.5)]
        response = self.client.post('/api/patch/validate', json={'performance': performance})
        self.assertEqual(response.status_code, 400)
        self.assertIn('loop', response.json()['detail'])
        self.assertEqual(self.client.post('/api/patch/validate', json={'bogus': {}}).status_code, 400)

    def test_layout_round_trip_in_memory_for_simulation(self):
        self.assertIsNone(self.client.get('/api/patch/layout').json()['layout'])
        layout = {'version': 1, 'nodes': {'mod:0': {'x': 10, 'y': 20}}, 'pages': [], 'inputs': {}}
        self.assertEqual(self.client.post('/api/patch/layout', json=layout).json()['stored'], 'memory')
        self.assertEqual(self.client.get('/api/patch/layout').json()['layout'], layout)
        self.assertEqual(self.client.post('/api/patch/layout', json={'version': 2, 'nodes': {}}).status_code, 400)

    def test_rig_layout_accepts_node_widths_and_rejects_bad_ones(self):
        from midibrain.performance.patch_routes import validate_layout
        layout = {'version': 1, 'nodes': {}, 'widths': {'ctl:twister': 420}}
        self.assertEqual(validate_layout(layout), layout)
        for bad in ({'ctl:twister': 'wide'}, {'ctl:twister': 5}, {'ctl:twister': True}, ['x']):
            with self.assertRaises(ValueError):
                validate_layout({**layout, 'widths': bad})

    def test_note_routes_validate_and_round_trip_through_the_patch_api(self):
        state = self.client.get('/api/patch/state').json()
        routing = copy.deepcopy(state['routing']['draft'])
        routing['notes'] = [dict(source='Keys', channel=1, port='Synth', out_channel=2, low=0, high=59, transpose=-12, scale=dict(root=0, mode='major'))]
        self.assertEqual(self.client.post('/api/patch/validate', json={'routing': routing}).status_code, 200)
        routing['notes'][0]['scale'] = dict(root=0, mode='nope')
        self.assertEqual(self.client.post('/api/patch/validate', json={'routing': routing}).status_code, 400)

    def test_missing_destination_port_names_the_device(self):
        from midibrain.performance.banks import validate_setup
        setup = copy.deepcopy(self.client.get('/api/patch/state').json()['banks']['draft'])
        device = next(item for item in setup['devices'] if item['kind'] == 'destination')
        device['output'] = None; device['name'] = 'My synth'
        for controller in setup['devices']:
            if controller['kind'] == 'controller': controller['input'] = 'In'
        validate_setup(setup)
        with self.assertRaisesRegex(ValueError, 'My synth.*needs a port'):
            validate_setup(setup, live=True)

    def test_applying_keeps_mod_on_off_state(self):
        performance = copy.deepcopy(self.client.get('/api/patch/state').json()['performance']['draft'])
        performance['mods'][1].update(enabled=True, destinations=[dict(device='l6', parameter='low', channels=[1], banks=[], amount=.5, scale_by_bank=False)])
        self.assertEqual(self.client.post('/api/settings', json={'performance': performance}).status_code, 200)
        self.assertTrue(self.session.engine.features.config['mods'][1]['enabled'])


class ModGraphTests(unittest.TestCase):
    def test_more_than_three_mods_up_to_the_limit(self):
        engine = engine_with(lambda mods: mods.extend(sine(i) for i in range(3, MAX_MODS)))
        self.assertEqual(len(engine.features.sources), MAX_MODS)
        engine.tick(.5)
        self.assertEqual(len(engine.features.values), MAX_MODS)
        config = copy.deepcopy(engine.features.config)
        config['mods'].append(sine(MAX_MODS))
        with self.assertRaisesRegex(ValueError, 'MOD sources'):
            engine.features.configure(config, 0)

    def test_actions_and_bank_amounts_address_added_mods(self):
        engine = engine_with(lambda mods: mods.append(sine(3)))
        engine.set_bank_mod_depth('bank-1', 3, .4)
        self.assertEqual(engine.bank_mod_depth(engine.banks['bank-1'], 3), .4)
        self.assertEqual(engine.bank_mod_depth(engine.banks['bank-2'], 3), 0.)
        engine.set_bank_mod_depth('bank-2', 3, 0.)
        self.assertEqual(len(engine.banks['bank-2'].get('mod_depths', [0, 0, 0])), 3)
        engine.features.request(dict(action='mod_enable', mod=3), 0)
        self.assertFalse(engine.features.config['mods'][3]['enabled'])

    def test_mod_modulates_another_mods_rate(self):
        # Reference: MOD 2 alone at 1 Hz.
        plain = engine_with(lambda mods: mods[1].update(sine(1, rate=1.)))
        # MOD 3 is a constant +1 square at phase 0 for the first half cycle at 0.1 Hz.
        bent = engine_with(lambda mods: (mods[1].update(sine(1, rate=1.)), mods[2].update(sine(2, shape='square', rate=.1, mod_targets=[dict(mod=1, parameter='rate', amount=.5)]))))
        for engine in (plain, bent):
            for step in range(1, 11): engine.tick(step * .01)
        # +0.5 offset -> rate x 2**2 = 4 Hz, so four times the phase advance.
        self.assertAlmostEqual(plain.features.sources[1].elapsed, .1, places=6)
        self.assertAlmostEqual(bent.features.sources[1].elapsed, .4, places=6)
        self.assertEqual(bent.features.order.index(2) < bent.features.order.index(1), True)
        # Config is never rewritten by modulation.
        self.assertEqual(bent.features.config['mods'][1]['rate'], 1.)

    def test_mod_to_mod_amount_and_validation(self):
        engine = engine_with(lambda mods: (mods[1].update(sine(1, amount=.5)), mods[2].update(sine(2, shape='square', rate=.1, mod_targets=[dict(mod=1, parameter='amount', amount=1.)]))))
        engine.tick(.01)
        self.assertEqual(engine.features.sources[1].effective_amount(), 1.)
        profile = rig_demo_profile()
        setup = BankEngine(profile, lambda message: None).setup
        config = copy.deepcopy(engine.features.config)
        for bad, message in [([dict(mod=2, parameter='rate', amount=.5)], 'itself'), ([dict(mod=1, parameter='trigger', amount=.5)], 'rate, amount'),
                             ([dict(mod=9, parameter='rate', amount=.5)], 'Modulated MOD'), ([dict(mod=1, parameter='rate', amount=2)], 'amount')]:
            config['mods'][2]['mod_targets'] = bad
            with self.assertRaisesRegex(ValueError, message): validate_config(config, setup)
        config['mods'][2]['mod_targets'] = [dict(mod=1, parameter='rate', amount=.5)]
        config['mods'][1]['mod_targets'] = [dict(mod=2, parameter='amount', amount=.5)]
        with self.assertRaisesRegex(ValueError, 'loop'): validate_config(config, setup)

    def test_sidechain_edited_on_the_canvas_ducks_the_same(self):
        from midibrain.performance.runtime import Event
        def duck(edit):
            profile = rig_demo_profile()
            engine = BankEngine(profile, lambda message: None)
            engine.initialize(0)
            config = copy.deepcopy(engine.features.config)
            edit(config['mods'][0])
            engine.features.configure(config, 0)
            trigger = config['mods'][0]['trigger']
            engine.handle('a4', Event('note_on', trigger['channel'], note=60, velocity=127), .01)
            engine.tick(.02)
            volume = lambda cid: engine.last_output[('l6', engine.destinations['l6', cid]['volume']['channel'], engine.destinations['l6', cid]['volume']['cc'])]
            return volume(1), volume(2)
        original = duck(lambda mod: None)
        # The canvas converts legacy bank_targets to one destination when a strip is removed.
        edited = duck(lambda mod: mod.update(bank_targets=[], destinations=[dict(device='l6', parameter='volume', channels=[], banks=['bank-1', 'bank-3', 'bank-4'], amount=1., scale_by_bank=True)]))
        self.assertEqual(edited[0], original[0])
        self.assertLess(original[1], edited[1])

    def test_existing_configs_without_mod_targets_still_load(self):
        profile = rig_demo_profile()
        engine = BankEngine(profile, lambda message: None)
        config = copy.deepcopy(engine.features.config)
        for mod in config['mods']: del mod['mod_targets']
        engine.features.configure(config, 0)
        self.assertEqual([m['mod_targets'] for m in engine.features.config['mods']], [[], [], []])


if __name__ == '__main__':
    unittest.main()
