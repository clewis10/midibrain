import unittest

import mido

from midibrain.performance.routing import PortRouter, empty_routing, quantize_note, required_ports, validate_routing


class Out:
    def __init__(self): self.sent = []
    def send(self, message): self.sent.append(message)


def routing(*notes):
    return {**empty_routing(), 'notes': list(notes)}


def route(**changes):
    return {'source': 'Keys', 'channel': 1, 'port': 'Synth', 'out_channel': 3, **changes}


def play(router, outputs, *messages):
    for message in messages: router.handle('Keys', message, outputs, 0)


def on(note, velocity=100, channel=0): return mido.Message('note_on', channel=channel, note=note, velocity=velocity)
def off(note, channel=0): return mido.Message('note_off', channel=channel, note=note)


class NoteRouteTests(unittest.TestCase):
    def setUp(self):
        self.synth, self.bass = Out(), Out()
        self.outputs = {'Synth': self.synth, 'Bass': self.bass}

    def test_notes_are_remapped_to_the_output_channel(self):
        router = PortRouter(routing(route()))
        play(router, self.outputs, on(60, 90), off(60))
        self.assertEqual([(m.type, m.channel, m.note, m.velocity) for m in self.synth.sent], [('note_on', 2, 60, 90), ('note_off', 2, 60, 0)])

    def test_other_channels_and_ports_are_ignored(self):
        router = PortRouter(routing(route()))
        play(router, self.outputs, on(60, channel=4))
        router.handle('Pad', on(60), self.outputs, 0)
        self.assertEqual(self.synth.sent, [])

    def test_key_range_makes_a_split(self):
        router = PortRouter(routing(route(high=59, port='Bass', out_channel=1), route(low=60)))
        play(router, self.outputs, on(48), on(72))
        self.assertEqual([(m.channel, m.note) for m in self.bass.sent], [(0, 48)])
        self.assertEqual([(m.channel, m.note) for m in self.synth.sent], [(2, 72)])

    def test_transpose_and_scale_quantise(self):
        router = PortRouter(routing(route(transpose=2, scale={'root': 0, 'mode': 'major'})))
        play(router, self.outputs, on(60), on(61))  # 62 stays; 63 snaps down to 62
        self.assertEqual([m.note for m in self.synth.sent], [62, 62])
        self.assertEqual(quantize_note(61, 0, 'major'), 60)
        self.assertEqual(quantize_note(66, 9, 'pentatonic_minor'), 67)  # A minor pentatonic: G is the nearest degree

    def test_fixed_velocity(self):
        router = PortRouter(routing(route(fixed_velocity=100)))
        play(router, self.outputs, on(60, 20))
        self.assertEqual(self.synth.sent[0].velocity, 100)

    def test_note_off_releases_what_was_played_even_if_the_rule_changes(self):
        router = PortRouter(routing(route(transpose=12)))
        play(router, self.outputs, on(60))
        router.routing = validate_routing(routing(route(transpose=-12, out_channel=9)))
        play(router, self.outputs, off(60))
        self.assertEqual([(m.type, m.channel, m.note) for m in self.synth.sent], [('note_on', 2, 72), ('note_off', 2, 72)])

    def test_velocity_zero_note_on_is_a_release(self):
        router = PortRouter(routing(route()))
        play(router, self.outputs, on(60), on(60, 0))
        self.assertEqual([m.type for m in self.synth.sent], ['note_on', 'note_off'])

    def test_release_all_lets_go_of_held_notes(self):
        router = PortRouter(routing(route(), route(port='Bass', out_channel=1)))
        play(router, self.outputs, on(60))
        router.release_all(self.outputs)
        self.assertEqual([m.type for m in self.synth.sent], ['note_on', 'note_off'])
        self.assertEqual([m.type for m in self.bass.sent], ['note_on', 'note_off'])
        router.release_all(self.outputs)
        self.assertEqual(len(self.synth.sent), 2)

    def test_pitch_bend_and_mod_wheel_pass_through_when_enabled(self):
        router = PortRouter(routing(route(), route(passthrough=False, port='Bass', out_channel=1)))
        play(router, self.outputs, mido.Message('pitchwheel', pitch=200), mido.Message('control_change', control=1, value=50), mido.Message('control_change', control=7, value=50))
        self.assertEqual([m.type for m in self.synth.sent], ['pitchwheel', 'control_change'])
        self.assertEqual(self.bass.sent, [])

    def test_validation(self):
        validate_routing(routing(route(scale={'root': 2, 'mode': 'dorian'}, transpose=-12, low=36, high=60)))
        for bad in (route(low=70, high=60), route(transpose=60), route(scale={'root': 0, 'mode': 'nope'}), route(out_channel=0),
                    route(port='Keys'), route(fixed_velocity=0), route(extra=1)):
            with self.assertRaises(ValueError): validate_routing(routing(bad))
        with self.assertRaises(ValueError): validate_routing({**empty_routing(), 'notes': 'x'})
        self.assertEqual(validate_routing(empty_routing()), empty_routing())

    def test_required_ports_include_note_routes(self):
        inputs, outputs = required_ports(routing(route()))
        self.assertEqual((inputs, outputs), ({'Keys'}, {'Synth'}))


if __name__ == '__main__':
    unittest.main()


class NoteModulationTests(unittest.TestCase):
    def performance(self):
        from midibrain.performance.engine import Event
        from midibrain.performance.features import Performance, defaults, validate_config
        from midibrain.performance.banks import validate_setup  # noqa: F401
        return Performance, defaults, validate_config, Event

    def test_validation_of_note_targets_and_knob_actions(self):
        from midibrain.performance.presets import rig_demo_profile
        from midibrain.performance.features import validate_config
        profile = rig_demo_profile(page2=True)
        from midibrain.performance.bank_engine import BankEngine
        import copy
        config = copy.deepcopy(BankEngine(profile, lambda cc: None).features.config)
        config['mods'][1]['note_targets'] = [{'route': 'n1', 'parameter': 'transpose', 'amount': .5}]
        config['actions'].append({'controller': 'twister', 'type': 'cc', 'channel': 4, 'number': 99, 'action': 'note_velocity', 'route': 'n1', 'shift': 'any', 'when': 'instant'})
        self.assertEqual(validate_config(config, profile['bank_setup'])['mods'][1]['note_targets'][0]['route'], 'n1')
        for bad in ({'route': 'n1', 'parameter': 'nope', 'amount': .5}, {'route': 'n1', 'parameter': 'low', 'amount': 2}, {'route': '', 'parameter': 'low', 'amount': .1}):
            config['mods'][1]['note_targets'] = [bad]
            with self.assertRaises(ValueError): validate_config(config, profile['bank_setup'])
        config['mods'][1]['note_targets'] = [{'route': 'n1', 'parameter': 'low', 'amount': .1}] * 2
        with self.assertRaises(ValueError): validate_config(config, profile['bank_setup'])

    def test_live_values_from_mods_and_knobs_change_the_notes_played(self):
        class Fake:  # the router only needs the computed live values
            pass
        route_one = route(id='n1', transpose=0, scale={'root': 0, 'mode': 'major'}, low=0, high=127)
        router = PortRouter(routing(route_one)); synth = Out(); outputs = {'Synth': synth}
        router.live = {'n1': {'transpose': 12.4, 'channel': 5.6, 'velocity': -20.2}}
        play(router, outputs, on(60, 100))
        self.assertEqual([(m.channel, m.note, m.velocity) for m in synth.sent], [(5, 72, 80)])
        play(router, outputs, off(60))
        synth.sent.clear()
        router.live = {'n1': {'low': 80, 'high': 70}}   # crossed values still make a valid 70..80 range
        play(router, outputs, on(60), on(76), off(76))
        self.assertEqual([(m.type, m.note) for m in synth.sent], [('note_on', 76), ('note_off', 76)])
        synth.sent.clear()
        router.live = {'n1': {'root': 1.2}}              # scale key follows the knob: C-sharp major
        play(router, outputs, on(62))
        self.assertEqual(synth.sent[-1].note, 61)

    def test_note_live_combines_base_knob_and_mod_offsets(self):
        from midibrain.performance.features import Performance
        from midibrain.performance.presets import rig_demo_profile
        from midibrain.performance.bank_engine import BankEngine
        profile = rig_demo_profile(page2=True)
        engine = BankEngine(profile, lambda cc: None)
        features = engine.features
        config = features.config
        config['mods'][1].update(enabled=True, note_targets=[{'route': 'n1', 'parameter': 'transpose', 'amount': .5}])
        features.configure(config, 0.)
        features.values[1] = 1.
        routes = [route(id='n1', transpose=2), route()]
        live = features.note_live(routes)
        self.assertAlmostEqual(live['n1']['transpose'], 2 + 1 * features.sources[1].effective_amount() * .5 * 24)
        self.assertEqual(set(live), {'n1'})
        features.note_knobs[('n1', 'channel')] = 9.
        self.assertEqual(features.note_live(routes)['n1']['channel'], 9.)


class ExpressionTests(unittest.TestCase):
    def setUp(self):
        self.synth = Out(); self.outputs = {'Synth': self.synth}
        self.router = PortRouter(routing(route(id='n1')))

    def test_modulation_is_added_to_what_the_keyboard_sends(self):
        self.router.live = {'n1': {'modwheel': 20, 'bend': 1000}}
        play(self.router, self.outputs, mido.Message('control_change', control=1, value=50), mido.Message('pitchwheel', pitch=500))
        self.assertEqual([(m.type, getattr(m, 'control', None), m.value if m.type == 'control_change' else m.pitch) for m in self.synth.sent],
                         [('control_change', 1, 70), ('pitchwheel', None, 1500)])
        self.assertTrue(all(m.channel == 2 for m in self.synth.sent))

    def test_emit_live_sends_only_changes_and_restores_the_keyboard_value(self):
        self.router.live = {'n1': {'modwheel': 30}}
        self.router.emit_live(self.outputs, 1.0)
        self.router.emit_live(self.outputs, 1.5)                      # unchanged: nothing sent
        self.assertEqual([m.value for m in self.synth.sent], [30])
        self.router.live = {'n1': {'modwheel': 60}}
        self.router.emit_live(self.outputs, 1.505)                    # inside the 10 ms limit: held back
        self.router.emit_live(self.outputs, 1.6)
        self.assertEqual([m.value for m in self.synth.sent], [30, 60])
        self.router.live = {}
        self.router.emit_live(self.outputs, 2.0)                      # modulation removed: back to neutral
        self.assertEqual(self.synth.sent[-1].value, 0)
        self.router.emit_live(self.outputs, 2.5)
        self.assertEqual(len(self.synth.sent), 3)

    def test_sustain_switches_at_half_and_bend_is_clamped(self):
        self.router.live = {'n1': {'sustain': 90, 'bend': 9000}}
        self.router.emit_live(self.outputs, 1.0)
        values = {(m.type, getattr(m, 'control', None)): (m.value if m.type == 'control_change' else m.pitch) for m in self.synth.sent}
        self.assertEqual(values, {('control_change', 64): 127, ('pitchwheel', None): 8191})

    def test_release_all_centres_modulated_expression(self):
        self.router.live = {'n1': {'bend': 4000}}
        self.router.emit_live(self.outputs, 1.0)
        self.router.release_all(self.outputs)
        self.assertEqual((self.synth.sent[-1].type, self.synth.sent[-1].pitch), ('pitchwheel', 0))


class ControlLinkTests(unittest.TestCase):
    def test_a_banked_knob_can_also_move_a_keyboard_setting(self):
        import copy
        from midibrain.performance.banks import validate_setup
        from midibrain.performance.bank_engine import BankEngine
        from midibrain.performance.engine import Event
        from midibrain.performance.presets import rig_demo_profile
        profile = rig_demo_profile(page2=True)
        binding = profile['bank_setup']['banks'][0]['controls'][0]['normal']
        source = binding['source']
        binding['note_links'] = [{'route': 'n1', 'parameter': 'transpose'}]
        validate_setup(copy.deepcopy(profile['bank_setup']))
        for bad in ([{'route': 'n1', 'parameter': 'nope'}], [{'route': '', 'parameter': 'low'}], [{'route': 'n1', 'parameter': 'low'}] * 2, 'x'):
            broken = copy.deepcopy(profile['bank_setup']); broken['banks'][0]['controls'][0]['normal']['note_links'] = bad
            with self.assertRaises(ValueError): validate_setup(broken)
        engine = BankEngine(profile, lambda cc: None)
        engine.handle(profile['bank_setup']['banks'][0]['controller'], Event('control_change', source['channel'], control=source['cc'], value=127), 0.)
        self.assertEqual(engine.features.note_knobs['n1', 'transpose'], 24)
        engine.handle(profile['bank_setup']['banks'][0]['controller'], Event('control_change', source['channel'], control=source['cc'], value=0), 0.)
        self.assertEqual(engine.features.note_knobs['n1', 'transpose'], -24)
