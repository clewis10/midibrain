"""Create a host-specific profile without opening MIDI ports or changing the source."""
import copy
import json
from pathlib import Path

from .profile import load, validate


def choose(names, fragment, role):
    matches = [name for name in names if fragment.casefold() in name.casefold()]
    if len(matches) != 1:
        raise ValueError(f"{role}: expected one port containing {fragment!r}, found {matches}. "
                         "Run ports and use the corresponding exact-name override.")
    return matches[0]


def create_profile(source, destination, trigger_source, backend, overrides=None):
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve() or destination.exists():
        raise ValueError(f"Refusing to replace {destination}; choose a new output filename.")
    profile = copy.deepcopy(load(source))
    inputs, outputs = backend.get_input_names(), backend.get_output_names()
    defaults = {
        'a4_input': (inputs, 'L6 MIDI I/O' if trigger_source == 'l6-midi' else 'Analog Four'),
        'twister_input': (inputs, 'Midi Fighter Twister'),
        'l6_output': (outputs, 'Mixer Control'),
        'twister_output': (outputs, 'Midi Fighter Twister'),
    }
    for role, (names, fragment) in defaults.items():
        override = (overrides or {}).get(role)
        if override is not None and override not in names:
            raise ValueError(f"{role}: port {override!r} is not available; run ports.")
        profile['ports'][role] = override if override is not None else choose(names, fragment, role)
    validate(profile, live=True, allow_unverified=True)
    # Exclusive creation also protects against another process creating the file.
    with destination.open('x') as output:
        output.write(json.dumps(profile, indent=2) + '\n')
    return profile
