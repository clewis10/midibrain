"""Controller templates: reusable hardware layouts for the patch canvas.

A template is plain JSON (``midibrain.controller`` v1) describing a controller's
shape and input addresses, not a rig: its name, controls per strip, input
layers, the strips' controller-side CC/feedback addresses, global inputs and the
canvas look of each control. Parameter mappings are optional and only meaningful
on a rig that has the same destination devices.

Built-ins are generated here from data already in the repo (the Twister layout
this rig uses, and ``config/controller_maps.json`` for the Launch Control XL 3).
Templates a user saves live in one sidecar file beside the profile. Nothing
here touches the MIDI engine.
"""
import json
import os
import re
import tempfile
from pathlib import Path

FORMAT = 'midibrain.controller'
VERSION = 1
LIMIT = 512 * 1024
MAX_TEMPLATES = 64


def _input(channel, cc):
    return {'channel': channel, 'cc': cc}


def twister():
    """MIDI Fighter Twister as this rig uses it: 4 strips of 4 encoders, the shift
    (encoder-click) layer on channel 5, side buttons as global inputs."""
    strips = []
    for strip in range(4):
        controls = []
        for index in range(4):
            cc = strip * 4 + index
            controls.append({'normal': {'source': _input(1, cc), 'feedback': _input(1, cc)},
                             'alternate': {'source': _input(5, cc), 'feedback': _input(5, cc)}})
        strips.append({'name': f'Bank {strip + 1}', 'controls': controls})
    side = [{'type': 'cc', 'channel': 4, 'number': 8 + i, 'label': f'Side button {i + 1}'} for i in range(6)]
    return {
        'format': FORMAT, 'version': VERSION, 'name': 'MIDI Fighter Twister', 'manufacturer': 'DJ TechTools', 'builtin': True,
        'description': '16 encoders as 4 strips of 4 on channel 1 (CC 0–15), encoder-click layer on channel 5, side buttons on channel 4.',
        'controller': {'name': 'MIDI Fighter Twister', 'controls_per_bank': 4, 'layers': ['normal', 'alternate']},
        'strips': strips, 'inputs': side,
        'appearance': {'arrangement': {'bankLayout': 'columns', 'columns': 4}, 'controls': {}, 'globals': {}},
    }


def launch_control_xl3():
    """Launch Control XL 3, factory Mode 16 (Novation LCXL3 appendix): 8 columns of 3 knobs,
    a fader and 2 buttons on MIDI channel 16. Knobs CC 13-36, faders CC 5-12, buttons CC 37-52."""
    channel, kinds = 16, ['knob', 'knob', 'knob', 'fader', 'button', 'button']
    strips = []
    for column in range(8):
        numbers = [13 + column, 21 + column, 29 + column, 5 + column, 37 + column, 45 + column]
        labels = [f'K{1 + column}', f'K{9 + column}', f'K{17 + column}', f'F{1 + column}', f'B{1 + column}', f'B{9 + column}']
        strips.append({'name': f'Column {column + 1}', 'controls': [{'normal': {'source': _input(channel, number), 'label': label}} for number, label in zip(numbers, labels)]})
    return {
        'format': FORMAT, 'version': VERSION, 'name': 'Launch Control XL 3 (Mode 16)', 'manufacturer': 'Novation', 'builtin': True,
        'description': 'Factory Mode 16: encoders CC 13-36, faders CC 5-12, buttons CC 37-52 on MIDI channel 16.',
        'controller': {'name': 'Launch Control XL 3', 'controls_per_bank': len(kinds), 'layers': ['normal']},
        'strips': strips, 'inputs': [],
        'appearance': {'arrangement': {'bankLayout': 'columns', 'columns': 6},
                       'controls': {str(index): {'kind': kind, 'centerDetent': False} for index, kind in enumerate(kinds)}, 'globals': {}},
    }


def _generic(name, description, controls, strips, inputs=(), kinds=None, columns=4):
    kinds = kinds or ['knob'] * controls
    return {
        'format': FORMAT, 'version': VERSION, 'name': name, 'manufacturer': 'Generic', 'builtin': True,
        'description': description + ' A starting point: set the channel and CC numbers to match your hardware.',
        'controller': {'name': name.split(' (')[0], 'controls_per_bank': max(1, controls), 'layers': ['normal']},
        'strips': strips, 'inputs': list(inputs),
        'appearance': {'arrangement': {'bankLayout': 'columns', 'columns': columns},
                       'controls': {str(i): {'kind': kind, 'centerDetent': False} for i, kind in enumerate(kinds)}, 'globals': {}},
    }


def generic_templates():
    knobs = lambda first, count, channel=1: [{'normal': {'source': _input(channel, first + i)}} for i in range(count)]
    eight = _generic('8 knobs (CC 21–28)', 'One strip of eight knobs on channel 1.', 8, [{'name': 'Knobs', 'controls': knobs(21, 8)}], columns=4)
    sixteen = _generic('16 knobs (CC 1–16)', 'Four strips of four knobs on channel 1.', 4, [{'name': f'Bank {b + 1}', 'controls': knobs(1 + b * 4, 4)} for b in range(4)], columns=4)
    mixer_kinds = ['fader', 'button']
    mixer = _generic('8 faders + 8 buttons', 'Eight strips, each a fader (CC 1–8) and a button (CC 21–28) on channel 1.', 2,
                     [{'name': f'Channel {c + 1}', 'controls': [{'normal': {'source': _input(1, 1 + c)}}, {'normal': {'source': _input(1, 21 + c)}}]} for c in range(8)], kinds=mixer_kinds, columns=2)
    keys = _generic('Keyboard (notes)', 'A note keyboard on channel 1: global input only, no strips.', 1, [], inputs=[{'type': 'note', 'channel': 1, 'number': None, 'label': 'Keys'}])
    pads = _generic('16 pads (notes 36–51)', 'Sixteen pad buttons on channel 10, notes 36–51.', 1, [],
                    inputs=[{'type': 'note', 'channel': 10, 'number': 36 + i, 'label': f'Pad {i + 1}'} for i in range(16)])
    return [eight, sixteen, mixer, keys, pads]


def builtin_templates(maps_path=None):
    """``maps_path`` is accepted for older callers; the built-ins no longer need it."""
    return [twister(), launch_control_xl3(), *generic_templates()]


def _int(value, low, high, what):
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f'{what} must be a whole number {low}–{high}')
    return value


def _address(value, what, key):
    if not isinstance(value, dict):
        raise ValueError(f'{what} needs an address')
    _int(value.get('channel'), 1, 16, f'{what} channel')
    _int(value.get(key), 0, 127, f'{what} number')


def validate_template(template):
    """Structural checks only; the canvas re-validates everything when it is applied to a rig."""
    if not isinstance(template, dict) or template.get('format') != FORMAT or template.get('version') != VERSION:
        raise ValueError('Not a MIDIBRAIN controller template')
    if len(json.dumps(template)) > LIMIT:
        raise ValueError('Controller template is too large')
    name = template.get('name')
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError('A template needs a name (1–80 characters)')
    if template.get('manufacturer') is not None and (not isinstance(template['manufacturer'], str) or not 1 <= len(template['manufacturer'].strip()) <= 80):
        raise ValueError('Manufacturer must be 1–80 characters')
    controller = template.get('controller')
    if not isinstance(controller, dict):
        raise ValueError('Template has no controller section')
    _int(controller.get('controls_per_bank'), 1, 64, 'Controls per strip')
    layers = controller.get('layers')
    if not isinstance(layers, list) or not 1 <= len(layers) <= 8 or any(not isinstance(item, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,32}', item) for item in layers) or len(set(layers)) != len(layers):
        raise ValueError('Template layers must be 1–8 distinct names')
    strips = template.get('strips', [])
    if not isinstance(strips, list) or len(strips) > 32:
        raise ValueError('A template holds up to 32 strips')
    for strip in strips:
        if not isinstance(strip, dict) or not isinstance(strip.get('name'), str) or not isinstance(strip.get('controls'), list) or len(strip['controls']) != controller['controls_per_bank']:
            raise ValueError('Each template strip needs a name and one entry per control')
        for control in strip['controls']:
            if not isinstance(control, dict):
                raise ValueError('Invalid template control')
            for layer, binding in control.items():
                if layer not in layers or not isinstance(binding, dict):
                    raise ValueError('Template control refers to an unknown layer')
                if binding.get('source') is not None:
                    _address(binding['source'], 'Template input', 'cc')
                if binding.get('feedback') is not None:
                    _address(binding['feedback'], 'Template feedback', 'cc')
    inputs = template.get('inputs', [])
    if not isinstance(inputs, list) or len(inputs) > 256:
        raise ValueError('Template inputs must be a list')
    for item in inputs:
        if not isinstance(item, dict) or item.get('type') not in ('cc', 'note'):
            raise ValueError('Invalid template global input')
        _int(item.get('channel'), 1, 16, 'Template input channel')
        if item.get('number') is not None:
            _int(item['number'], 0, 127, 'Template input number')
    return template


class TemplateLibrary:
    """Built-in templates plus the ones a user saved (one JSON sidecar, written atomically)."""

    def __init__(self, path=None, maps_path=None):
        self.path = Path(path) if path else None
        self.maps_path = maps_path
        self.memory = {}

    def saved(self):
        if self.path is None:
            return dict(self.memory)
        try:
            data = json.loads(self.path.read_text())
        except FileNotFoundError:
            return {}
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def listing(self):
        items = [dict(item, source='built-in') for item in builtin_templates(self.maps_path)]
        items += [dict(template, source='saved') for template in self.saved().values()]
        return items

    def save(self, template):
        validate_template(template)
        template = dict(template, builtin=False)
        store = self.saved()
        key = template['name'].strip()
        if key not in store and len(store) >= MAX_TEMPLATES:
            raise ValueError(f'Up to {MAX_TEMPLATES} saved controller templates')
        store[key] = template
        self._write(store)
        return key

    def delete(self, name):
        store = self.saved()
        if name not in store:
            raise KeyError(name)
        del store[name]
        self._write(store)

    def _write(self, store):
        if self.path is None:
            self.memory = store
            return
        encoded = json.dumps(store, separators=(',', ':'))
        fd, temporary = tempfile.mkstemp(dir=self.path.parent, prefix='.controller-templates-')
        try:
            with os.fdopen(fd, 'w') as handle:
                handle.write(encoded)
            os.replace(temporary, self.path)
        except OSError:
            Path(temporary).unlink(missing_ok=True)
            raise
