"""Validated, portable setup for the L6/Twister performance project.

All profile MIDI channels are human-facing 1..16, never mido's 0..15.
An incomplete profile is editable, but cannot be used to open MIDI outputs.
"""
from __future__ import annotations

import copy
import json
import math
import os
import tempfile
from pathlib import Path

PARAMETERS = ("low", "high", "aux1", "aux2", "mid", "efx")
ROWS = (("low", "mid"), ("high", None), ("aux1", "efx"), ("aux2", "depth"))


def number(value, low, high, label, integer=False):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not math.isfinite(value) or not low <= value <= high
            or (integer and not isinstance(value, int))):
        raise ValueError(f"{label} must be {'an integer' if integer else 'a number'} in {low}..{high}")
    return value


def address(value, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain channel and cc")
    number(value.get("channel"), 1, 16, f"{label}.channel", True)
    number(value.get("cc"), 0, 119, f"{label}.cc", True)
    return value["channel"], value["cc"]


def column_groups(columns, channel_ids):
    """Accept old one-channel columns; normalize to four independent target lists."""
    if not isinstance(columns, list) or len(columns) != 4:
        raise ValueError("twister.columns must contain four channel groups")
    groups = []
    for column in columns:
        group = [column] if type(column) is int else column
        if (not isinstance(group, list)
                or any(type(cid) is not int or cid not in channel_ids for cid in group)
                or len(set(group)) != len(group)):
            raise ValueError("Each column must list distinct configured L6 channel ids")
        groups.append(list(group))
    return groups


def validate(profile, *, live=False, allow_unverified=False):
    """Validate structure/ports; an explicit trial may use unverified values."""
    if not isinstance(profile, dict) or profile.get("version") != 1:
        raise ValueError("profile.version must be 1")
    if live and not allow_unverified and profile.get("hardware_verified") is not True:
        raise ValueError("Hardware mapping is unverified; capture and verify it before live run")
    if live and "bank_setup" not in profile:
        ports = profile.get("ports", {})
        for role in ("a4_input", "twister_input", "l6_output", "twister_output"):
            if not isinstance(ports.get(role), str) or not ports[role].strip():
                raise ValueError(f"ports.{role} must name an exact MIDI port")
        if ports["a4_input"] == ports["twister_input"]:
            raise ValueError("A4 and Twister must have distinct input ports")
        if ports["l6_output"] == ports["twister_output"]:
            raise ValueError("L6 and Twister must have distinct output ports")
    sc = profile.get("sidechain", {})
    number(sc.get("release_ms"), 0, 10000, "sidechain.release_ms")
    number(sc.get("max_hold_ms"), 100, 600000, "sidechain.max_hold_ms")
    number(sc.get("velocity_exponent"), 0.1, 8, "sidechain.velocity_exponent")
    number(profile.get("update_hz"), 10, 200, "update_hz")
    trigger = profile.get("trigger", {})
    number(trigger.get("channel"), 1, 16, "trigger.channel", True)
    if trigger.get("note") is not None:
        number(trigger["note"], 0, 127, "trigger.note", True)
    channels = profile.get("channels")
    if not isinstance(channels, list) or not 1 <= len(channels) <= 6:
        raise ValueError("channels must contain 1..6 configured L6 channels")
    ids, outputs = set(), set()
    for channel in channels:
        cid = number(channel.get("id"), 1, 6, "channel.id", True)
        if cid in ids:
            raise ValueError("Duplicate L6 channel id")
        ids.add(cid)
        number(channel.get("depth"), 0, 1, "channel.depth")
        mappings = channel.get("parameters", {})
        for param in (*PARAMETERS, "volume"):
            target = mappings.get(param)
            key = address(target, f"channel {cid}.{param}")
            if key in outputs:
                raise ValueError(f"Duplicate L6 target {key}")
            outputs.add(key)
            if param != "volume":
                number(target.get("reset"), 0, 127, f"{param}.reset", True)
        curve = channel.get("volume_curve")
        if not isinstance(curve, list) or len(curve) < 2:
            raise ValueError("volume_curve needs at least [0, unity CC] and [1, minimum CC]")
        previous_x, previous_y = -1, 128
        for point in curve:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError("volume_curve points must be [attenuation, CC]")
            x = number(point[0], 0, 1, "curve attenuation")
            y = number(point[1], 0, 127, "curve CC", True)
            if x <= previous_x or y > previous_y:
                raise ValueError("volume_curve attenuation must increase and CC must not increase")
            previous_x, previous_y = x, y
        if curve[0][0] != 0 or curve[-1][0] != 1:
            raise ValueError("volume_curve must cover attenuation 0..1")
    twister = profile.get("twister", {})
    column_groups(twister.get("columns"), ids)
    keys, feedback = set(), set()
    for layer in ("normal", "alternate"):
        mapping = twister.get(layer, {})
        for direction, used in (("input", keys), ("feedback", feedback)):
            controls = mapping.get(direction)
            if not isinstance(controls, list) or len(controls) != 16:
                raise ValueError(f"twister.{layer}.{direction} must contain 16 CC addresses in row order")
            for index, control in enumerate(controls):
                key = address(control, f"twister.{layer}.{direction}[{index}]")
                if key in used:
                    raise ValueError(f"Duplicate Twister {direction} address {key}")
                used.add(key)
    for binding in twister.get("resets", []):
        key = address(binding, "reset binding")
        if key in keys:
            raise ValueError("Reset binding conflicts with a Twister control")
        keys.add(key)
        scope = binding.get("scope")
        if isinstance(scope, dict):
            if set(scope) != {"column"}:
                raise ValueError("Column reset scope must contain only 'column'")
            number(scope["column"], 1, 4, "reset column", True)
        elif scope != "all" and (type(scope) is not int or scope not in ids):
            raise ValueError("Reset scope must be 'all', an L6 channel id, or {column: 1..4}")
    if "bank_setup" in profile:
        from .banks import validate_setup, migrate
        validate_setup(migrate(profile), live=live)
    if "routing" in profile:
        from .routing import validate_routing, validate_preset_targets
        validate_routing(profile["routing"])
        validate_preset_targets(profile)
    if 'performance' in profile:
        if 'bank_setup' not in profile: raise ValueError('Snapshots and MOD require bank setup')
        from .features import validate_config
        validate_config(profile['performance'], migrate(profile), profile['ports'].get('a4_input'), profile['trigger'], profile['sidechain'])
    if 'bank_setup' in profile:
        from .routing import validate_layer_routes
        validate_layer_routes(profile)
    return profile


def load(path, *, live=False, allow_unverified=False):
    with Path(path).open() as handle:
        return validate(json.load(handle), live=live, allow_unverified=allow_unverified)


def save(path, profile):
    """Replace atomically so a power interruption cannot leave half a JSON file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(profile, handle, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def demo_profile():
    """Synthetic addresses for simulation/tests, NOT an L6/Twister factory map."""
    channels = []
    for cid in range(1, 7):
        channels.append({
            "id": cid, "depth": 0.5,
            "parameters": {
                param: {"channel": 1, "cc": (cid - 1) * 7 + index,
                        **({"reset": 64 if param in ("low", "mid", "high") else 0}
                           if param != "volume" else {})}
                for index, param in enumerate((*PARAMETERS, "volume"))
            },
            "volume_curve": [[0, 100], [1, 0]],
        })
    return {
        "version": 1, "hardware_verified": False,
        "ports": dict.fromkeys(("a4_input", "twister_input", "l6_output", "twister_output")),
        "update_hz": 100,
        "trigger": {"channel": 5, "note": None},
        "sidechain": {"release_ms": 250, "max_hold_ms": 30000, "velocity_exponent": 1},
        "channels": channels,
        "twister": {
            "columns": [[1, 3], [2], [4, 5], [6]],
            **{layer: {
                direction: [{"channel": channel, "cc": index} for index in range(16)]
                for direction in ("input", "feedback")
            } for layer, channel in (("normal", 1), ("alternate", 5))},
            "resets": [],
        },
    }


def template_profile():
    profile = copy.deepcopy(demo_profile())
    profile["trigger"]["channel"] = None
    for channel in profile["channels"]:
        channel["depth"] = 0
        channel["volume_curve"] = [[0, None], [1, None]]
        for target in channel["parameters"].values():
            for key in target:
                target[key] = None
    for layer in ("normal", "alternate"):
        for direction in ("input", "feedback"):
            for target in profile["twister"][layer][direction]:
                target.update(channel=None, cc=None)
    return profile
