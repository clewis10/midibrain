"""Deterministic performance logic, independent of MIDI drivers and web servers."""
from __future__ import annotations

import copy
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Callable

from .profile import PARAMETERS, ROWS, column_groups, number, validate


@dataclass(frozen=True)
class Event:
    type: str
    channel: int = 1
    control: int = 0
    value: int = 0
    note: int = 0
    velocity: int = 0


@dataclass(frozen=True)
class CC:
    destination: str
    channel: int
    control: int
    value: int


class MixerEngine:
    def __init__(self, profile: dict, send: Callable[[CC], None]):
        self.profile = copy.deepcopy(validate(profile))
        self.send = send
        self.channels = {item["id"]: item for item in self.profile["channels"]}
        self.values = {
            cid: {name: data["reset"] for name, data in channel["parameters"].items()
                  if name != "volume"}
            for cid, channel in self.channels.items()
        }
        self.depths = {cid: channel["depth"] for cid, channel in self.channels.items()}
        self.notes = defaultdict(deque)
        self.envelope = 0.0
        self.release_start = None
        self.release_level = 0.0
        self.last_time = 0.0
        self.expired_notes = 0
        self.last_output = {}
        self.reset_pressed = set()
        self.bindings = {}
        self.feedback = {}
        self.active_layers = ["normal"] * 16
        twister = self.profile["twister"]
        twister["columns"] = column_groups(twister["columns"], self.channels)
        for layer_index, layer in enumerate(("normal", "alternate")):
            for index, source in enumerate(twister[layer]["input"]):
                column = index % 4
                parameter = ROWS[index // 4][layer_index]
                key = source["channel"], source["cc"]
                self.bindings[key] = (column, parameter, index, layer)
                if parameter is not None:
                    self.feedback[column, parameter] = twister[layer]["feedback"][index]
        self.resets = {(item["channel"], item["cc"]): item["scope"]
                       for item in twister.get("resets", [])}

    def _emit(self, destination, target, value, *, force=False):
        value = max(0, min(127, round(value)))
        key = destination, target["channel"], target["cc"]
        if force or self.last_output.get(key) != value:
            self.send(CC(*key, value))
            self.last_output[key] = value

    def _feedback(self, cid, parameter, value, *, force=False):
        for column, group in enumerate(self.profile["twister"]["columns"]):
            if cid in group:
                self._column_feedback(column, parameter, force=force)

    def _column_feedback(self, column, parameter, *, force=False):
        group = self.profile["twister"]["columns"][column]
        target = self.feedback.get((column, parameter))
        if target is not None:
            # One encoder cannot display several values. Use the first member
            # as the reference until a turn assigns a shared absolute value.
            value = (self.depths[group[0]] * 127 if parameter == "depth"
                     else self.values[group[0]][parameter]) if group else 0
            self._emit("twister", target, value, force=force)

    def set_columns(self, columns):
        groups = column_groups(columns, self.channels)
        self.profile["twister"]["columns"] = groups
        for column, parameter in self.feedback:
            self._column_feedback(column, parameter, force=True)

    def set_trigger(self, channel, note, now):
        number(channel, 1, 16, "trigger.channel", True)
        if note is not None:
            number(note, 0, 127, "trigger.note", True)
        # Old note-offs may no longer match after changing the filter.
        self.panic(now)
        self.profile["trigger"] = {"channel": channel, "note": note}

    def routing_snapshot(self):
        controls = []
        for (channel, cc), (column, parameter, index, layer) in self.bindings.items():
            targets = []
            if parameter is not None:
                for cid in self.profile["twister"]["columns"][column]:
                    targets.append({"channel_id": cid, "parameter": parameter,
                                    "address": None if parameter == "depth" else
                                    dict(self.channels[cid]["parameters"][parameter])})
            controls.append({"index": index, "column": column + 1, "layer": layer,
                             "source": {"channel": channel, "cc": cc}, "targets": targets})
        return {"trigger": dict(self.profile["trigger"]), "controls": controls}

    def reset_column(self, column):
        number(column, 1, 4, "column", True)
        for cid in self.profile["twister"]["columns"][column - 1]:
            self.reset_mixer(cid)

    def initialize(self, now):
        self.last_time = now
        self.panic(now)
        self.reset_mixer()
        for column, parameter in self.feedback:
            self._column_feedback(column, parameter, force=True)

    def reset_mixer(self, cid=None):
        """Mixer reset never changes sidechain depth, held notes, or volume."""
        ids = list(self.channels) if cid is None else [cid]
        if any(item not in self.channels for item in ids):
            raise ValueError("Unknown mixer channel")
        for item in ids:
            for parameter in PARAMETERS:
                target = self.channels[item]["parameters"][parameter]
                value = target["reset"]
                self.values[item][parameter] = value
                self._emit("l6", target, value, force=True)
                self._feedback(item, parameter, value, force=True)

    def set_depth(self, cid, depth):
        if cid not in self.channels:
            raise ValueError("Unknown mixer channel")
        number(depth, 0, 1, "depth")
        self.depths[cid] = depth
        self._feedback(cid, "depth", depth * 127)

    def set_release(self, milliseconds, now):
        number(milliseconds, 0, 10000, "release_ms")
        self.tick(now)
        self.profile["sidechain"]["release_ms"] = milliseconds
        if self.release_start is not None:
            self.release_start = now
            self.release_level = self.envelope

    def handle(self, source: str, event: Event, now: float):
        self.tick(now)
        if source == "twister" and event.type == "control_change":
            key = event.channel, event.control
            if key in self.resets:
                if event.value > 0 and key not in self.reset_pressed:
                    scope = self.resets[key]
                    if isinstance(scope, dict):
                        self.reset_column(scope["column"])
                    else:
                        self.reset_mixer(None if scope == "all" else scope)
                    self.reset_pressed.add(key)
                elif event.value == 0:
                    self.reset_pressed.discard(key)
                return
            binding = self.bindings.get(key)
            if binding is None:
                return
            column, parameter, index, layer = binding
            self.active_layers[index] = layer
            for cid in self.profile["twister"]["columns"][column]:
                if parameter == "depth":
                    self.set_depth(cid, event.value / 127)
                elif parameter is not None:
                    self.values[cid][parameter] = event.value
                    self._emit("l6", self.channels[cid]["parameters"][parameter], event.value)
                    self._feedback(cid, parameter, event.value)
            return
        if source != "a4":
            return
        if event.type in ("stop", "reset"):
            self.panic(now)
            return
        trigger = self.profile["trigger"]
        if event.channel != trigger["channel"]:
            return
        if event.type == "control_change" and event.control in (120, 123):
            self.panic(now)
            return
        if trigger["note"] is not None and event.note != trigger["note"]:
            return
        if event.type == "note_on" and event.velocity > 0:
            self.notes[event.note].append((event.velocity, now))
            self._retarget(now)
        elif event.type == "note_off" or (event.type == "note_on" and event.velocity == 0):
            held = self.notes.get(event.note)
            if held:
                held.popleft()
                if not held:
                    del self.notes[event.note]
                self._retarget(now)

    def _retarget(self, now):
        velocities = [velocity for notes in self.notes.values() for velocity, _ in notes]
        if velocities:
            self.envelope = (max(velocities) / 127) ** self.profile["sidechain"]["velocity_exponent"]
            self.release_start = None
        elif self.release_start is None and self.envelope > 0:
            self.release_start, self.release_level = now, self.envelope

    def tick(self, now):
        if now < self.last_time:
            raise ValueError("Engine time must be monotonic")
        self.last_time = now
        timeout = self.profile["sidechain"]["max_hold_ms"] / 1000
        expired = False
        for note, held in list(self.notes.items()):
            while held and now - held[0][1] >= timeout:
                held.popleft()
                self.expired_notes += 1
                expired = True
            if not held:
                del self.notes[note]
        if expired:
            self._retarget(now)
        if self.release_start is not None:
            duration = self.profile["sidechain"]["release_ms"] / 1000
            fraction = min(1.0, (now - self.release_start) / duration) if duration else 1.0
            self.envelope = self.release_level * (1 - fraction)
            if fraction >= 1:
                self.release_start = None
        for cid, channel in self.channels.items():
            attenuation = self.envelope * self.depths[cid]
            self._emit("l6", channel["parameters"]["volume"], self.volume_cc(cid, attenuation))

    def volume_cc(self, cid, attenuation):
        curve = self.channels[cid]["volume_curve"]
        for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
            if attenuation <= x1:
                return round(y0 + (y1 - y0) * (attenuation - x0) / (x1 - x0))
        return curve[-1][1]

    def panic(self, now):
        """Restore unity immediately; retain all configured sidechain depths."""
        self.notes.clear()
        self.envelope = 0.0
        self.release_start = None
        self.last_time = now
        for cid, channel in self.channels.items():
            self._emit("l6", channel["parameters"]["volume"], self.volume_cc(cid, 0), force=True)

    def snapshot(self):
        return {
            "envelope": self.envelope,
            "held_notes": sum(map(len, self.notes.values())),
            "expired_notes": self.expired_notes,
            "release_ms": self.profile["sidechain"]["release_ms"],
            "columns": copy.deepcopy(self.profile["twister"]["columns"]),
            "last_observed_layers": list(self.active_layers),
            "channels": {cid: {"depth": self.depths[cid], "values": dict(self.values[cid]),
                               "volume_cc": self.volume_cc(cid, self.envelope * self.depths[cid])}
                         for cid in self.channels},
        }

    def settings_profile(self):
        result = copy.deepcopy(self.profile)
        for channel in result["channels"]:
            channel["depth"] = self.depths[channel["id"]]
        return result
