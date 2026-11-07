import tempfile
import time
import unittest
from pathlib import Path

import mido
from fastapi.testclient import TestClient

from midibrain.performance.engine import Event, MixerEngine
from midibrain.performance.profile import demo_profile as default_demo_profile, load, save, template_profile, validate
from midibrain.performance.runtime import Session, from_mido, run
from midibrain.performance.web import create_app


def demo_profile():
    # Keep the test fixture's one-to-one routing independent of rig defaults.
    profile = default_demo_profile()
    profile["twister"]["columns"] = [[1], [2], [3], [4]]
    return profile


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.profile = demo_profile()
        self.sent = []
        self.engine = MixerEngine(self.profile, self.sent.append)
        self.engine.initialize(0)
        self.sent.clear()

    def note(self, kind, velocity=127, note=60, now=0, channel=5):
        self.engine.handle("a4", Event(kind, channel, note=note, velocity=velocity), now)
        self.engine.tick(now)

    def test_hold_velocity_depth_and_release(self):
        self.note("note_on", velocity=127)
        self.assertEqual(self.engine.snapshot()["channels"][1]["volume_cc"], 50)
        self.engine.tick(10)
        self.assertEqual(self.engine.envelope, 1)
        self.note("note_off", now=10)
        self.engine.tick(10.125)
        self.assertEqual(self.engine.snapshot()["channels"][1]["volume_cc"], 75)
        self.engine.tick(10.25)
        self.assertEqual(self.engine.snapshot()["channels"][1]["volume_cc"], 100)
        self.note("note_on", velocity=64, now=11)
        self.assertAlmostEqual(self.engine.envelope, 64 / 127)

    def test_live_depth_is_independent_per_channel(self):
        self.note("note_on")
        self.engine.set_depth(1, 0)
        self.engine.set_depth(2, 1)
        self.engine.tick(0)
        state = self.engine.snapshot()["channels"]
        self.assertEqual(state[1]["volume_cc"], 100)
        self.assertEqual(state[2]["volume_cc"], 0)
        self.assertEqual(state[3]["volume_cc"], 50)

    def test_zero_velocity_is_note_off(self):
        self.note("note_on")
        self.note("note_on", velocity=0, now=1)
        self.engine.tick(1.25)
        self.assertEqual(self.engine.envelope, 0)

    def test_other_channels_sources_notes_and_clock_do_not_trigger(self):
        self.note("note_on", channel=1)
        self.engine.handle("twister", Event("note_on", 5, velocity=127), 0)
        self.engine.handle("a4", Event("clock"), 0)
        self.assertEqual(self.engine.envelope, 0)
        self.engine.profile["trigger"]["note"] = 36
        self.note("note_on", note=60)
        self.assertEqual(self.engine.envelope, 0)
        self.note("note_on", note=36)
        self.assertEqual(self.engine.envelope, 1)

    def test_overlapping_notes_and_duplicate_pitch_are_balanced(self):
        self.note("note_on", velocity=64)
        self.note("note_on", note=61, velocity=127)
        self.note("note_on", note=61, velocity=100)
        self.note("note_off", note=61)
        self.assertAlmostEqual(self.engine.envelope, 100 / 127)
        self.note("note_off", note=61)
        self.assertAlmostEqual(self.engine.envelope, 64 / 127)
        self.note("note_off", note=99)
        self.assertEqual(self.engine.snapshot()["held_notes"], 1)

    def test_retrigger_during_release(self):
        self.note("note_on")
        self.note("note_off", now=1)
        self.engine.tick(1.125)
        self.note("note_on", now=1.125)
        self.assertEqual(self.engine.envelope, 1)
        self.assertIsNone(self.engine.release_start)

    def test_missing_note_off_expires_and_releases(self):
        self.note("note_on")
        self.engine.tick(30)
        self.engine.tick(30.25)
        self.assertEqual(self.engine.envelope, 0)
        self.assertEqual(self.engine.expired_notes, 1)

    def test_stop_and_panic_restore_unity_without_resetting_depth(self):
        self.note("note_on")
        self.engine.handle("a4", Event("stop"), 1)
        self.assertEqual(self.engine.envelope, 0)
        self.assertEqual(self.engine.depths[1], 0.5)
        self.assertEqual(self.sent[-1].value, 100)

    def test_all_notes_off_only_on_trigger_channel(self):
        self.note("note_on")
        self.engine.handle("a4", Event("control_change", 1, control=123), 0)
        self.assertEqual(self.engine.envelope, 1)
        self.engine.handle("a4", Event("control_change", 5, control=123), 0)
        self.assertEqual(self.engine.envelope, 0)

    def test_mixer_reset_preserves_active_duck_and_depth(self):
        self.note("note_on")
        self.engine.handle("twister", Event("control_change", 1, control=8, value=110), 0)
        self.sent.clear()
        self.engine.reset_mixer(1)
        self.assertEqual(self.engine.values[1]["aux1"], 0)
        self.assertEqual(self.engine.depths[1], 0.5)
        self.assertEqual(self.engine.envelope, 1)
        self.assertFalse(any(msg.destination == "l6" and msg.control == 6 for msg in self.sent))
        self.assertTrue(any(msg.destination == "twister" and msg.control == 8 and msg.value == 0
                            for msg in self.sent))

    def test_exact_user_layout_across_all_four_columns(self):
        expected = (("low", "mid"), ("high", None), ("aux1", "efx"), ("aux2", "depth"))
        for column in range(4):
            for row in range(4):
                for layer, midi_channel in enumerate((1, 5)):
                    parameter = expected[row][layer]
                    self.sent.clear()
                    value = 80 + row + column
                    self.engine.handle("twister", Event("control_change", midi_channel,
                                                        control=row * 4 + column, value=value), 0)
                    if parameter == "depth":
                        self.assertAlmostEqual(self.engine.depths[column + 1], value / 127)
                    elif parameter is not None:
                        self.assertEqual(self.engine.values[column + 1][parameter], value)
                    else:
                        self.assertFalse(any(msg.destination == "l6" for msg in self.sent))

    def test_normal_and_alternate_values_are_independent(self):
        self.engine.handle("twister", Event("control_change", 1, control=0, value=100), 0)
        self.engine.handle("twister", Event("control_change", 5, control=0, value=22), 0)
        self.assertEqual(self.engine.values[1]["low"], 100)
        self.assertEqual(self.engine.values[1]["mid"], 22)

    def test_release_adjustment_is_continuous(self):
        self.note("note_on")
        self.note("note_off", now=1)
        self.engine.set_release(1000, 1.125)
        self.assertEqual(self.engine.envelope, 0.5)
        self.engine.tick(1.625)
        self.assertAlmostEqual(self.engine.envelope, 0.25)
        self.engine.tick(2.125)
        self.assertEqual(self.engine.envelope, 0)

    def test_duplicate_ccs_suppressed_and_curve_calibration_used(self):
        self.note("note_on")
        self.sent.clear()
        for index in range(100):
            self.engine.tick(index / 100)
        self.assertEqual(self.sent, [])
        self.engine.channels[1]["volume_curve"] = [[0, 100], [0.5, 80], [1, 0]]
        self.assertEqual(self.engine.volume_cc(1, 0.25), 90)
        self.assertEqual(self.engine.volume_cc(1, 0.75), 40)

    def test_configured_reset_button_acts_on_rising_edge(self):
        profile = demo_profile()
        profile["twister"]["resets"] = [{"channel": 4, "cc": 8, "scope": 1}]
        engine = MixerEngine(profile, self.sent.append)
        engine.initialize(0)
        engine.handle("twister", Event("control_change", 4, control=8, value=127), 0)
        self.sent.clear()
        engine.handle("twister", Event("control_change", 4, control=8, value=127), 0)
        self.assertEqual(self.sent, [])
        engine.handle("twister", Event("control_change", 4, control=8, value=0), 0)
        engine.handle("twister", Event("control_change", 4, control=8, value=127), 0)
        self.assertTrue(self.sent)


class ProfileTests(unittest.TestCase):
    def test_unverified_profiles_cannot_run_live(self):
        with self.assertRaisesRegex(ValueError, "unverified"):
            validate(demo_profile(), live=True)

    def test_template_is_deliberately_incomplete(self):
        with self.assertRaises(ValueError):
            validate(template_profile())

    def test_duplicate_l6_mapping_rejected(self):
        profile = demo_profile()
        profile["channels"][0]["parameters"]["low"]["cc"] = 1
        with self.assertRaisesRegex(ValueError, "Duplicate L6"):
            validate(profile)

    def test_bad_release_curve_columns_and_controller_collisions(self):
        changes = [
            lambda p: p["sidechain"].update(release_ms=float("nan")),
            lambda p: p["channels"][0].update(volume_curve=[[0, 0], [1, 100]]),
            lambda p: p["twister"].update(columns=[[1, 1], [2], [3], [4]]),
            lambda p: p["twister"]["alternate"].update(input=p["twister"]["normal"]["input"]),
        ]
        for change in changes:
            profile = demo_profile()
            change(profile)
            with self.assertRaises(ValueError):
                validate(profile)

    def test_atomic_save_roundtrip_and_nan_failure_preserve_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "profile.json"
            save(path, demo_profile())
            original = path.read_bytes()
            self.assertEqual(load(path), demo_profile())
            with self.assertRaises(ValueError):
                save(path, {"bad": float("nan")})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(len(list(Path(directory).iterdir())), 1)


class FakePort:
    def __init__(self, messages=(), fail_send=False):
        self.messages = list(messages)
        self.sent = []
        self.closed = False
        self.fail_send = fail_send
        self.fail_poll = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.closed = True

    def poll(self):
        if self.fail_poll:
            raise OSError("input failed")
        return self.messages.pop(0) if self.messages else None

    def send(self, message):
        if self.fail_send:
            raise OSError("output failed")
        self.sent.append(message)


class FakeBackend:
    Message = staticmethod(mido.Message)

    def __init__(self):
        self.inputs = {"a4": FakePort(), "twister": FakePort()}
        self.outputs = {"l6": FakePort(), "twister": FakePort()}
        self.missing = False

    def get_input_names(self):
        return list(self.inputs)

    def get_output_names(self):
        return [] if self.missing else list(self.outputs)

    def open_input(self, name):
        return self.inputs[name]

    def open_output(self, name):
        return self.outputs[name]


def hardware_profile():
    profile = demo_profile()
    profile["hardware_verified"] = True
    profile["ports"] = {"a4_input": "a4", "twister_input": "twister", "l6_output": "l6",
                        "twister_output": "twister"}
    return profile


class RuntimeTests(unittest.TestCase):
    def test_mido_channel_conversion(self):
        self.assertEqual(from_mido(mido.Message("note_on", channel=4, note=60, velocity=127)).channel, 5)

    def test_simultaneous_inputs_are_translated_and_shutdown_restores_unity(self):
        backend = FakeBackend()
        backend.inputs["a4"].messages = [mido.Message("note_on", channel=4, velocity=127)]
        backend.inputs["twister"].messages = [mido.Message("control_change", channel=0, control=8, value=90)]
        session = Session(hardware_profile())
        run(session, backend=backend, duration=0.02)
        sent = backend.outputs["l6"].sent
        self.assertTrue(any(msg.control == 6 and msg.value == 50 for msg in sent))
        self.assertTrue(any(msg.control == 2 and msg.value == 90 for msg in sent))
        self.assertEqual([msg.value for msg in sent[-6:]], [100] * 6)
        self.assertTrue(all(port.closed for port in [*backend.inputs.values(), *backend.outputs.values()]))
        self.assertTrue(all(msg.type == "control_change" for msg in sent))

    def test_missing_port_sends_nothing(self):
        backend = FakeBackend()
        backend.missing = True
        with self.assertRaisesRegex(ValueError, "Missing MIDI output"):
            run(Session(hardware_profile()), backend=backend)
        self.assertEqual(backend.outputs["l6"].sent, [])

    def test_input_failure_restores_and_closes_all_ports(self):
        backend = FakeBackend()
        backend.inputs["a4"].fail_poll = True
        session = Session(hardware_profile())
        with self.assertRaisesRegex(OSError, "input failed"):
            run(session, backend=backend)
        self.assertEqual([m.value for m in backend.outputs["l6"].sent], [100] * 6)
        self.assertTrue(all(port.closed for port in [*backend.inputs.values(), *backend.outputs.values()]))
        self.assertEqual(session.error, "input failed")

    def test_twister_failure_still_restores_l6(self):
        backend = FakeBackend()
        backend.outputs["twister"].fail_send = True
        with self.assertRaisesRegex(OSError, "output failed"):
            run(Session(hardware_profile()), backend=backend)
        self.assertEqual([m.value for m in backend.outputs["l6"].sent[-6:]], [100] * 6)

    def test_burst_queue_is_bounded_and_latest_value_wins(self):
        session = Session(demo_profile(), demo=True)
        for value in range(128):
            session.engine.handle("twister", Event("control_change", 1, control=0, value=value), 0)
        self.assertLessEqual(len(session.pending), 8)
        self.assertEqual(session.pending["l6", 1, 0].value, 127)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.session = Session(demo_profile(), demo=True)
        self.session.engine.initialize(time.monotonic())
        self.session.running = True
        self.client = TestClient(create_app(self.session))

    def test_page_and_settings(self):
        page = self.client.get("/tools").text
        self.assertIn("<h2>Banks</h2>", page)
        self.assertIn("<h2>Activity</h2>", page)
        self.assertLess(page.index('<div id="group-controls"'), page.index('id="actionsSection"'))
        self.assertEqual(self.client.get('/activity.js').status_code, 200)
        activity = self.client.get('/api/activity').json()
        self.assertFalse(activity['performance']['native'])
        self.assertEqual(self.client.post("/api/release", json={"release_ms": 700}).status_code, 200)
        self.assertEqual(self.client.post("/api/depth", json={"channel": 1, "depth": 0.8}).status_code, 200)
        self.client.post("/api/reset", json={})
        state = self.client.get("/api/status").json()
        self.assertEqual(state["release_ms"], 700)
        self.assertEqual(state["channels"]["1"]["depth"], 0.8)

    def test_validation_cross_origin_and_stopped_runtime(self):
        self.assertEqual(self.client.post("/api/release", json={"release_ms": -1}).status_code, 422)
        self.assertEqual(self.client.post("/api/reset", json={"channel": True}).status_code, 422)
        self.assertEqual(self.client.post("/api/reset", json={}, headers={"Origin": "https://other.example"}).status_code, 403)
        self.session.running = False
        self.assertEqual(self.client.post("/api/panic").status_code, 400)

    def test_demo_cannot_save_and_live_cannot_inject_notes(self):
        self.assertEqual(self.client.post("/api/save").status_code, 400)
        self.assertEqual(self.client.post("/api/demo-note", json={"velocity": 127}).status_code, 200)
        self.assertEqual(self.client.get("/api/status").json()["held_notes"], 1)
        self.client.post("/api/demo-note", json={"velocity": 0})
        self.assertEqual(self.client.get("/api/status").json()["held_notes"], 0)
        self.session.demo = False
        self.assertEqual(self.client.post("/api/demo-note", json={"velocity": 127}).status_code, 400)

    def test_live_settings_persist_independently_of_eq(self):
        with tempfile.TemporaryDirectory() as directory:
            self.session.demo = False
            self.session.config_path = Path(directory) / "profile.json"
            self.client.post("/api/release", json={"release_ms": 500})
            self.client.post("/api/depth", json={"channel": 2, "depth": 0.7})
            self.assertEqual(self.client.post("/api/save").status_code, 200)
            profile = load(self.session.config_path)
            self.assertEqual(profile["sidechain"]["release_ms"], 500)
            self.assertEqual(profile["channels"][1]["depth"], 0.7)


class GroupTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        profile = demo_profile()
        profile['twister']['columns'] = [[1, 2], [3], [4, 5], []]
        profile['twister']['resets'] = [{'channel': 4, 'cc': 8, 'scope': {'column': 1}}]
        self.engine = MixerEngine(profile, self.sent.append)
        self.engine.initialize(0)
        self.sent.clear()

    def turn(self, cc, value, channel=1):
        self.engine.handle('twister', Event('control_change', channel, control=cc, value=value), 0)

    def test_group_broadcasts_normal_alternate_and_depth(self):
        for cc, channel, parameter in [(0, 1, 'low'), (0, 5, 'mid'), (8, 1, 'aux1'), (8, 5, 'efx')]:
            self.turn(cc, 88, channel)
            self.assertEqual(self.engine.values[1][parameter], 88)
            self.assertEqual(self.engine.values[2][parameter], 88)
            self.assertNotEqual(self.engine.values[3][parameter], 88)
        self.turn(12, 100, 5)
        self.assertEqual(self.engine.depths[1], 100 / 127)
        self.assertEqual(self.engine.depths[2], 100 / 127)
        self.assertEqual(self.engine.depths[3], 0.5)
        self.engine.handle('a4', Event('note_on', 5, note=60, velocity=127), 0)
        self.engine.tick(0)
        state = self.engine.snapshot()['channels']
        self.assertEqual(state[1]['volume_cc'], state[2]['volume_cc'])
        self.assertNotEqual(state[1]['volume_cc'], state[3]['volume_cc'])

    def test_empty_column_and_unassigned_alternate_send_nothing(self):
        self.turn(3, 88)
        self.turn(15, 99, 5)
        self.turn(4, 44, 5)
        self.assertEqual(self.sent, [])

    def test_reassignment_preserves_values_and_updates_routing_immediately(self):
        self.turn(0, 88)
        self.engine.set_depth(3, 0.2)
        self.sent.clear()
        self.engine.set_columns([[3, 6], [1, 2], [], [4, 5]])
        self.assertTrue(self.sent)
        self.assertTrue(all(message.destination == 'twister' for message in self.sent))
        self.assertEqual(self.engine.depths[3], 0.2)
        self.assertEqual(self.engine.values[1]['low'], 88)
        self.turn(0, 90)
        self.assertEqual(self.engine.values[3]['low'], 90)
        self.assertEqual(self.engine.values[6]['low'], 90)
        self.assertEqual(self.engine.values[1]['low'], 88)

    def test_side_reset_follows_group_after_remapping_and_preserves_depth(self):
        self.engine.set_columns([[3, 6], [1, 2], [], [4, 5]])
        self.turn(0, 90)
        self.turn(1, 100)
        self.turn(12, 120, 5)
        self.turn(8, 127, 4)
        self.assertEqual(self.engine.values[3]['low'], 64)
        self.assertEqual(self.engine.values[6]['low'], 64)
        self.assertEqual(self.engine.values[1]['low'], 100)
        self.assertEqual(self.engine.depths[3], 120 / 127)
        self.assertEqual(self.engine.depths[6], 120 / 127)

    def test_overlap_synchronizes_reference_feedback_in_both_columns(self):
        self.engine.set_columns([[1, 2], [1, 3], [], []])
        self.sent.clear()
        self.turn(1, 90)
        self.assertEqual(self.engine.values[1]['low'], 90)
        self.assertEqual(self.engine.values[3]['low'], 90)
        self.assertEqual(self.engine.values[2]['low'], 64)
        feedback = {(m.channel, m.control): m.value for m in self.sent if m.destination == 'twister'}
        self.assertEqual(feedback[1, 0], 90)
        self.assertEqual(feedback[1, 1], 90)

    def test_legacy_profiles_normalize_and_saved_groups_roundtrip(self):
        profile = demo_profile()
        profile['twister']['columns'] = [1, 2, 3, 4]
        legacy = MixerEngine(profile, self.sent.append)
        self.assertEqual(legacy.snapshot()['columns'], [[1], [2], [3], [4]])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'grouped.json'
            save(path, self.engine.settings_profile())
            restored = MixerEngine(load(path), self.sent.append)
            self.assertEqual(restored.snapshot()['columns'], [[1, 2], [3], [4, 5], []])

    def test_api_mapping_validation_reset_and_save(self):
        session = Session(demo_profile(), demo=True)
        session.engine.initialize(time.monotonic())
        session.running = True
        client = TestClient(create_app(session))
        groups = [[1, 2], [3], [4, 5], [6]]
        self.assertEqual(client.post('/api/columns', json={'columns': groups}).status_code, 200)
        self.assertEqual(client.get('/api/status').json()['columns'], groups)
        for invalid in [[[1, 1], [2], [3], [4]], [[7], [], [], []], [[True], [], [], []], [[], []]]:
            self.assertGreaterEqual(client.post('/api/columns', json={'columns': invalid}).status_code, 400)
        self.assertEqual(session.engine.snapshot()['columns'], groups)
        session.engine.values[1]['aux1'] = 90
        session.engine.values[2]['aux1'] = 90
        self.assertEqual(client.post('/api/reset-column', json={'column': 1}).status_code, 200)
        self.assertEqual(session.engine.values[1]['aux1'], 0)
        self.assertEqual(session.engine.values[2]['aux1'], 0)
        self.assertEqual(session.engine.depths[1], 0.5)
        with tempfile.TemporaryDirectory() as directory:
            session.demo = False
            session.config_path = Path(directory) / 'saved.json'
            self.assertEqual(client.post('/api/save').status_code, 200)
            self.assertEqual(load(session.config_path)['twister']['columns'], groups)


if __name__ == "__main__":
    unittest.main()
