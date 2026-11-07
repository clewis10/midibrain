"""Headless snapshot actions, musical timing and deterministic MOD sources.

Rigs start with three MODs; the patch canvas may add more (up to MAX_MODS).
Several MODs may drive one parameter: contributions sum, then clamp. MODs can
also modulate other MODs' rate, amount, phase/slew or release (acyclic)."""
import copy
import json
import math
import random
import time
from collections import defaultdict
from .profile import number

MAX_SLOTS = 32
BAR_WINDOWS = (1, 2, 4, 8, 16)
MAX_MODS = 16
MOD_PARAMETERS_MODULATABLE = ('rate', 'amount', 'phase', 'release')


def ref_key(ref):
    if not isinstance(ref, list) or len(ref) != 3 or not isinstance(ref[0], str) or not isinstance(ref[2], str):
        raise ValueError('Invalid parameter reference')
    cid = ref[1]
    if isinstance(cid, list):
        if len(cid) != 2: raise ValueError('Invalid parameter channel')
        cid = tuple(number(c, 1, 16, 'Parameter channel', True) for c in cid)
    else: number(cid, 1, 16, 'Parameter channel', True)
    return ref[0], cid, ref[2]


# Keyboard (note route) settings that MODs and CC knobs can drive live.
# name -> (lowest, highest, MOD span either way at full amount). A knob sweeps lowest..highest.
NOTE_PARAMS = {'transpose': (-24, 24, 24), 'low': (0, 127, 63), 'high': (0, 127, 63), 'velocity': (-63, 63, 63), 'channel': (1, 16, 8), 'root': (0, 11, 6),
               # Expression, added to what the keyboard sends: pitch bend (14-bit), channel aftertouch, mod wheel (CC 1), sustain (CC 64).
               'bend': (-8192, 8191, 8191), 'pressure': (0, 127, 127), 'modwheel': (0, 127, 127), 'sustain': (0, 127, 127)}
NOTE_ACTIONS = {f'note_{name}': name for name in NOTE_PARAMS}


def note_base(route, name):
    scale = route.get('scale')
    return {'transpose': route.get('transpose', 0), 'low': route.get('low', 0), 'high': route.get('high', 127), 'velocity': 0,
            'channel': route['out_channel'], 'root': scale['root'] if scale else None, 'bend': 0, 'pressure': 0, 'modwheel': 0, 'sustain': 0}[name]


def default_mod(index):
    return dict(name=f'MOD {index + 1}', shape='sidechain' if index == 0 else 'sine',
                enabled=index == 0, timing='free', rate=1., beats=1., playback='loop',
                phase=0., slew=0., amount=1., attack_ms=0., release_ms=250., trigger=None, targets=[], bank_targets=[], destinations=[], velocity=True, velocity_exponent=1., max_hold_ms=30000., mod_targets=[], note_targets=[])


def defaults():
    return dict(version=1, beats_per_bar=4, beat_unit=4, shift=None, actions=[],
                slots=[dict(name=f'Snapshot {i + 1}', banks=[]) for i in range(8)],
                mods=[default_mod(i) for i in range(3)], operators=[])


def parameters(setup):
    from .banks import expanded_channels
    devices = {d['id']: d for d in setup['devices']}
    result = {}
    for (did, cid), ch in expanded_channels(setup).items():
        for key, param in ch['parameters'].items():
            result[did, cid, key] = (param, [devices[did].get('output') or did, param['channel'], param['cc'],
                                           param.get('min', 0), param.get('max', 127)])
    return result


def validate_config(value, setup, trigger_input=None, trigger_config=None, sidechain=None):
    value = copy.deepcopy(value)
    if isinstance(value, dict): value.setdefault('operators', [])
    # Upgrade the first prototype's special sidechain shape to a normal envelope.
    if isinstance(value, dict) and isinstance(value.get('mods'), list):
        for i, mod in enumerate(value['mods']):
            if not isinstance(mod, dict): continue
            for field in ('destinations', 'bank_targets', 'velocity', 'velocity_exponent', 'max_hold_ms', 'mod_targets', 'note_targets'):
                mod.setdefault(field, copy.deepcopy(default_mod(i)[field]))
            if mod.get('shape') == 'sidechain':
                trig = trigger_config or {'channel': 1, 'note': None}
                sc = sidechain or {'release_ms': mod.get('release_ms', 250), 'velocity_exponent': 1., 'max_hold_ms': 30000}
                mod.update(shape='envelope', playback='gate', trigger=dict(controller='a4', type='note', channel=trig['channel'], number=trig['note']),
                           release_ms=sc['release_ms'], velocity_exponent=sc['velocity_exponent'], max_hold_ms=sc['max_hold_ms'])
                if mod.get('name') == 'MOD 1': mod['name'] = 'Sidechain'
                from .banks import expanded_channels, bank_targets
                channels = expanded_channels(setup)
                devices_by_id = {d['id']: d for d in setup['devices']}
                mod['bank_targets'] = [dict(bank=b['id'], parameter='volume') for b in setup['banks']
                    if bank_targets(b, devices_by_id[b['destination']]) and all(channels[b['destination'], c].get('volume') for c in bank_targets(b, devices_by_id[b['destination']]))]

    if not isinstance(value, dict) or set(value) != set(defaults()) or value.get('version') != 1:
        raise ValueError('Invalid performance configuration')
    number(value['beats_per_bar'], 1, 16, 'Beats per bar', True)
    if value['beat_unit'] not in (2, 4, 8, 16): raise ValueError('Beat unit must be 2, 4, 8 or 16')
    devices = {d['id']: d for d in setup['devices'] if d['kind'] == 'controller'}
    bank_ids = {b['id'] for b in setup['banks']}
    params = parameters(setup)
    def input_key(binding, any_note=False):
        if not isinstance(binding, dict) or not isinstance(binding.get('controller'), str) or binding.get('controller') not in devices:
            raise ValueError('Choose an active controller input')
        kind = binding.get('type', 'cc')
        if kind not in ('cc', 'note'): raise ValueError('Input type must be CC or note')
        number(binding.get('channel'), 1, 16, 'Input channel', True)
        if not (any_note and kind == 'note' and binding.get('number') is None):
            number(binding.get('number'), 0, 119 if kind == 'cc' else 127, 'Input number', True)
        d = devices[binding['controller']]
        if 'page' in binding and binding['page'] not in d.get('pages', ['Page 1']): raise ValueError('Action refers to an unknown controller page')
        return d.get('input') or d['id'], kind, binding['channel'], binding['number']
    mod_count = len(value['mods']) if isinstance(value.get('mods'), list) else 0
    used = set()
    for bank in setup['banks']:
        d = devices[bank['controller']]
        for control in bank['controls']:
            for b in control.values():
                if b.get('source'): used.add((d.get('input') or d['id'], 'cc', b['source']['channel'], b['source']['cc']))
    for b in setup['resets']:
        d = devices[b['controller']]
        used.add((d.get('input') or d['id'], 'cc', b['channel'], b['cc']))
    for device in devices.values():
        switch = device.get('layer_switch') if device.get('layer_mode') == 'software' else None
        if switch:
            key = (device.get('input') or device['id'], switch['type'], switch['channel'], switch['number'])
            if key in used: raise ValueError('Layer switch conflicts with an existing control')
            used.add(key)
    shift = value['shift']
    if shift is not None:
        key = input_key(shift)
        if shift.get('mode') not in ('momentary', 'toggle'): raise ValueError('Choose a Shift mode')
        if key in used: raise ValueError('Shift conflicts with an existing control')
        used.add(key)
    if not isinstance(value['slots'], list) or not 8 <= len(value['slots']) <= MAX_SLOTS: raise ValueError(f'Use 8 to {MAX_SLOTS} snapshot slots')
    device_ids = {d['id'] for d in setup['devices'] if d['kind'] == 'destination'}
    for slot in value['slots']:
        if not isinstance(slot, dict) or not {'name', 'banks'} <= set(slot) or set(slot) - {'name', 'banks', 'node', 'targets', 'quantize_bars'}: raise ValueError('Invalid snapshot slot')
        if not isinstance(slot['name'], str) or not 1 <= len(slot['name']) <= 80: raise ValueError('Snapshot name must be 1..80 characters')
        if not isinstance(slot['banks'], list) or any(not isinstance(b, str) or b not in bank_ids for b in slot['banks']) or len(set(slot['banks'])) != len(slot['banks']):
            raise ValueError('Snapshot scope refers to a missing or duplicate bank')
        if 'node' in slot and type(slot['node']) is not bool: raise ValueError('Snapshot node flag must be on/off')
        if slot.get('quantize_bars', 0) not in (0, *BAR_WINDOWS) or type(slot.get('quantize_bars', 0)) is not int: raise ValueError('Recall timing must be instant or 1, 2, 4, 8 or 16 bars')
        targets = slot.get('targets', [])
        if not isinstance(targets, list) or len(targets) > 128: raise ValueError('Invalid snapshot scope')
        for target in targets:
            kind = target.get('type') if isinstance(target, dict) else None
            if kind == 'all' and set(target) == {'type'}: continue
            if kind == 'bank' and set(target) == {'type', 'bank'} and target['bank'] in bank_ids: continue
            if kind == 'device' and set(target) == {'type', 'device'} and target['device'] in device_ids: continue
            if kind == 'channel' and set(target) == {'type', 'device', 'channel'} and target['device'] in device_ids and type(target['channel']) is int: continue
            raise ValueError('Snapshot scope refers to something that no longer exists')
    if not isinstance(value['actions'], list) or len(value['actions']) > 128: raise ValueError('Up to 128 performance actions')
    conditions = defaultdict(set)
    for action in value['actions']:
        key = input_key(action)
        if key in used: raise ValueError('Performance action conflicts with a bank control, Brain action or Shift')
        condition = action.get('shift', 'any')
        if condition not in ('any', 'on', 'off'): raise ValueError('Invalid Shift condition')
        if condition != 'any' and shift is None: raise ValueError('Configure Shift before using a Shift condition')
        if condition in conditions[key]: raise ValueError('Duplicate performance action input/Shift condition')
        conditions[key].add(condition)
        kind = action.get('action')
        if kind not in ('capture', 'recall', 'reset', 'cancel', 'align', 'mod_trigger', 'mod_enable', 'mod_rate', 'mod_amount', 'mod_phase', 'mod_stop', 'mod_depth', 'mod_release', 'panic', *NOTE_ACTIONS):
            raise ValueError('Unknown performance action')
        if kind in ('capture', 'recall'): number(action.get('slot'), 0, len(value['slots']) - 1, 'Snapshot slot', True)
        if kind == 'reset' and action.get('bank') is not None and (not isinstance(action['bank'], str) or action['bank'] not in bank_ids): raise ValueError('Unknown reset bank')
        if kind == 'reset' and action.get('layer') is not None:
            if action.get('bank') is not None: raise ValueError('Reset a strip or a layer, not both')
            owner = next((d for d in setup['devices'] if d['id'] == action.get('layer_controller') and d['kind'] == 'controller'), None)
            if owner is None: raise ValueError('Choose the controller whose layer to reset')
            layers = owner.get('layers') or (['normal', 'alternate'] if owner.get('alternate') else ['normal'])
            if action['layer'] not in layers: raise ValueError('Unknown layer to reset')
        if kind == 'mod_depth' and action.get('bank') not in bank_ids: raise ValueError('Choose a bank for MOD amount')
        if kind.startswith('mod_') and kind != 'mod_stop': number(action.get('mod'), 0, max(0, mod_count - 1), 'MOD slot', True)
        if action.get('when', 'instant') not in ('instant', 'bar'): raise ValueError('Choose Instant or Next bar')
        if action.get('bars', 1) not in BAR_WINDOWS or type(action.get('bars', 1)) is not int: raise ValueError('Choose 1, 2, 4, 8 or 16 bars')
        hold = number(action.get('hold_ms', 0), 0, 5000, 'Save hold')
        if hold and kind != 'capture': raise ValueError('Hold is only supported for Save snapshot')
        if kind in ('mod_rate', 'mod_amount', 'mod_phase', 'mod_depth', 'mod_release', *NOTE_ACTIONS) and action.get('type', 'cc') != 'cc': raise ValueError('Continuous controls require CC input')
        if kind in NOTE_ACTIONS and (not isinstance(action.get('route'), str) or not 1 <= len(action['route']) <= 32): raise ValueError('Choose a keyboard route to control')
    mods = value['mods']
    if not isinstance(mods, list) or not 0 <= len(mods) <= MAX_MODS: raise ValueError(f'Use 0..{MAX_MODS} MOD sources')
    graph = {}
    for i, mod in enumerate(mods):
        if not isinstance(mod, dict) or set(mod) != set(default_mod(i)): raise ValueError('Invalid MOD definition')
        if not isinstance(mod['name'], str) or not 1 <= len(mod['name']) <= 80: raise ValueError('MOD name must be 1..80 characters')
        if type(mod['enabled']) is not bool: raise ValueError('MOD enabled must be on/off')
        if mod['shape'] not in ('sine', 'triangle', 'saw_up', 'saw_down', 'square', 'random', 'envelope'): raise ValueError('Unknown MOD shape')
        if mod['timing'] not in ('free', 'sync') or mod['playback'] not in ('loop', 'triggered', 'one_shot', 'gate'): raise ValueError('Invalid MOD timing/playback')
        if mod['shape'] == 'envelope' and mod['playback'] != 'gate': raise ValueError('Envelope shape uses Gate playback')
        if mod['playback'] == 'gate' and mod['shape'] not in ('envelope',): raise ValueError('Gate playback uses Envelope shape')
        for field, lo, hi in [('rate', .01, 20), ('beats', .0625, 64), ('phase', 0, 360), ('slew', 0, 1), ('amount', 0, 1), ('attack_ms', 0, 10000), ('release_ms', 0, 10000), ('velocity_exponent', .1, 8), ('max_hold_ms', 100, 600000)]:
            number(mod[field], lo, hi, field)
        if type(mod['velocity']) is not bool: raise ValueError('Velocity response must be on/off')
        if mod['trigger'] is not None:
            key = input_key(mod['trigger'], any_note=True)
            if any(key[:3] == other[:3] and (key[3] is None or key[3] == other[3]) for other in used | set(conditions)): raise ValueError('MOD trigger conflicts with a control; use a MOD trigger action instead')
            # Different MODs may intentionally share a trigger.
        if not isinstance(mod['targets'], list) or len(mod['targets']) > 32: raise ValueError('Use up to 32 MOD destinations')
        if not isinstance(mod['bank_targets'], list) or len(mod['bank_targets']) > 32: raise ValueError('Use up to 32 bank destinations')
        from .banks import bank_targets, expanded_channels
        channels = expanded_channels(setup)
        by_id = {d['id']: d for d in setup['devices']}
        seen_banks = set()
        for route in mod['bank_targets']:
            if not isinstance(route, dict) or set(route) != {'bank', 'parameter'} or route.get('bank') not in bank_ids: raise ValueError('Invalid MOD bank destination')
            if route['bank'] in seen_banks: raise ValueError('Choose one destination parameter per bank and MOD')
            seen_banks.add(route['bank'])
            bank = next(b for b in setup['banks'] if b['id'] == route['bank'])
            for cid in bank_targets(bank, by_id[bank['destination']]):
                ch = channels[bank['destination'], cid]
                if route['parameter'] == 'volume':
                    if not ch.get('volume'): raise ValueError('Bank volume modulation needs volume curves')
                elif route['parameter'] not in ch['parameters'] or not ch['parameters'][route['parameter']].get('continuous', False):
                    raise ValueError('Bank MOD destination must be a continuous parameter on every selected channel')
        from .mod_destinations import expand
        expand(mod, setup)
        direct_addresses = set()
        for target in mod['targets']:
            if not isinstance(target, dict) or set(target) != {'ref', 'amount'}: raise ValueError('Invalid MOD destination')
            ref = ref_key(target['ref'])
            if ref not in params: raise ValueError('MOD destination is not in the active banks/devices')
            p, signature = params[ref]
            if not p.get('continuous', False): raise ValueError('Mark the destination Continuous in Devices before assigning MOD')
            addr = tuple(signature[:3])
            if addr in direct_addresses: raise ValueError('Duplicate MOD destination')
            direct_addresses.add(addr)
            number(target['amount'], -1, 1, 'MOD destination amount')
        if not isinstance(mod['mod_targets'], list) or len(mod['mod_targets']) > 32: raise ValueError('Use up to 32 MOD-to-MOD connections')
        seen_mod_targets = set()
        for target in mod['mod_targets']:
            if not isinstance(target, dict) or set(target) != {'mod', 'parameter', 'amount'}: raise ValueError('Invalid MOD-to-MOD connection')
            j = number(target['mod'], 0, len(mods) - 1, 'Modulated MOD', True)
            if j == i: raise ValueError('A MOD cannot modulate itself')
            if target['parameter'] not in MOD_PARAMETERS_MODULATABLE: raise ValueError('MODs can modulate rate, amount, phase/slew or release')
            if (j, target['parameter']) in seen_mod_targets: raise ValueError('Duplicate MOD-to-MOD connection')
            seen_mod_targets.add((j, target['parameter']))
            number(target['amount'], -1, 1, 'MOD-to-MOD amount')
            graph.setdefault(i, set()).add(j)
    mod_order(len(mods), graph)
    for mod in mods:
        if not isinstance(mod['note_targets'], list) or len(mod['note_targets']) > 64: raise ValueError('Use up to 64 keyboard modulation targets')
        seen_note_targets = set()
        for target in mod['note_targets']:
            if not isinstance(target, dict) or set(target) != {'route', 'parameter', 'amount'} or not isinstance(target['route'], str) or not 1 <= len(target['route']) <= 32:
                raise ValueError('Invalid keyboard modulation target')
            if target['parameter'] not in NOTE_PARAMS: raise ValueError('MODs can modulate transpose, low/high key, velocity, channel or scale key')
            if (target['route'], target['parameter']) in seen_note_targets: raise ValueError('Duplicate keyboard modulation target')
            seen_note_targets.add((target['route'], target['parameter']))
            number(target['amount'], -1, 1, 'Keyboard modulation amount')
    from . import operators as ops
    ops.validate(value['operators'], len(mods), set(devices))
    from .mod_destinations import expand as expand_destinations
    for op in value['operators']:
        expand_destinations(dict(destinations=op['targets']), setup)
        if any(route.get('scale_by_bank') for route in op['targets']): raise ValueError('Operators do not scale by strip amount; wire a knob to the operator instead')
    return copy.deepcopy(value)


def mod_order(count, graph):
    """Evaluation order: modulators before the MODs they modulate. Rejects cycles."""
    order, state = [], {}
    def visit(i):
        if state.get(i) == 1: raise ValueError('MOD-to-MOD connections form a loop')
        if state.get(i) == 2: return
        state[i] = 1
        for j in graph.get(i, ()): visit(j)
        state[i] = 2; order.append(i)
    for i in range(count): visit(i)
    return order[::-1]


def mod_graph(mods):
    return {i: {t['mod'] for t in m.get('mod_targets', [])} for i, m in enumerate(mods)}


class MusicalClock:
    """24 PPQN, explicit transport/alignment, interpolation without event replay."""
    def __init__(self):
        self.running = False
        self.aligned = False
        self.pulses = 0
        self.last_tick = None
        self.period = None
        self.first = True

    def handle(self, message, now):
        kind = message.type
        if kind == 'start':
            self.running = self.aligned = True
            self.pulses = 0; self.first = True; self.last_tick = None; self.period = None
        elif kind == 'continue': self.running = True; self.last_tick = None
        elif kind == 'stop': self.running = False
        elif kind == 'songpos':
            self.pulses = message.pos * 6; self.aligned = True; self.first = True
        elif kind == 'clock':
            if self.last_tick is not None:
                gap = now - self.last_tick
                if gap >= 1: self.aligned = False; self.period = None
                if 0 < gap < .5: self.period = gap if self.period is None else self.period * .8 + gap * .2
            self.last_tick = now
            if self.running:
                if not self.first: self.pulses += 1
                self.first = False

    def valid(self, now):
        return self.running and self.aligned and self.last_tick is not None and now - self.last_tick < 1.

    def position(self, now):
        fraction = min(1., max(0., (now - self.last_tick) / self.period)) if self.period and self.last_tick is not None else 0.
        return (self.pulses + fraction) / 24

    def align(self, now):
        if self.last_tick is None or now - self.last_tick >= 1: raise ValueError('Set the one needs incoming clock')
        self.pulses = 0; self.aligned = self.running = True; self.first = True


class ModSource:
    def __init__(self, config, now, rng=None):
        self.config = config
        self.rng = rng or random.Random()
        self.start = now
        self.beat_start = 0.
        self.phase = config['phase'] / 360
        self.active = config['enabled'] and config['playback'] == 'loop'
        self.elapsed = 0.
        self.last_sample = now
        self.last_beat = None
        self.cycle = -1
        self.previous = self.target = 0.
        self.gates = {}
        self.level = 0.
        self.expired_notes = 0
        self.transition = (now, 0., 0.)
        # Offsets from other MODs, refreshed every tick; never written to config.
        self.offsets = {}

    def effective_amount(self):
        return max(0., min(1., self.config['amount'] + self.offsets.get('amount', 0.)))

    def effective_rate(self):
        # +/-1 offset spans four octaves either way, within the editor's limits.
        return max(.01, min(20., self.config['rate'] * 2 ** (4 * self.offsets.get('rate', 0.))))

    def effective_release_ms(self):
        return max(0., min(10000., self.config['release_ms'] + 2000 * self.offsets.get('release', 0.)))

    def trigger(self, now, beat, strength=1., key='manual', on=True):
        c = self.config
        if c['playback'] == 'gate':
            if on:
                strength = strength ** c['velocity_exponent'] if c['velocity'] else 1.
                self.gates.setdefault(key, []).append((strength, now))
            elif key in self.gates:
                self.gates[key].pop(0)
                if not self.gates[key]: del self.gates[key]
            goal = max((v for values in self.gates.values() for v, _ in values), default=0.)
            self.transition = (now, self.level, goal)
            self.active = True
        elif on:
            self.start = now; self.beat_start = beat; self.phase = c['phase'] / 360
            self.active = True; self.cycle = -1; self.previous = self.target = 0.
            self.elapsed = 0.; self.last_sample = now; self.last_beat = beat

    def sample(self, now, clock):
        c = self.config
        if not c['enabled'] or not self.active: return 0.
        if c['timing'] == 'sync' and (not clock.valid(now) or not clock.period):
            self.gates.clear(); self.active = c['playback'] == 'loop'; self.level = 0.
            return 0.
        if c['playback'] == 'gate':
            expired = False
            for key, values in list(self.gates.items()):
                kept = [(v, t) for v, t in values if now - t < c['max_hold_ms'] / 1000]
                self.expired_notes += len(values) - len(kept)
                expired |= kept != values
                if kept: self.gates[key] = kept
                else: self.gates.pop(key)
            if expired:
                goal = max((v for vs in self.gates.values() for v, _ in vs), default=0.)
                self.transition = (now, self.level, goal)
            start, initial, goal = self.transition
            duration = (c['attack_ms'] if self.gates else self.effective_release_ms()) / 1000
            if c['timing'] == 'sync': duration *= c['beats'] * clock.period * 24
            fraction = min(1., (now - start) / duration) if duration else 1.
            self.level = initial + (goal - initial) * fraction
            return self.level
        if c['timing'] == 'free':
            self.elapsed += max(0., now - self.last_sample) * self.effective_rate()
        else:
            beat = clock.position(now)
            self.elapsed += max(0., beat - (self.last_beat if self.last_beat is not None else beat)) / c['beats']
            self.last_beat = beat
        self.last_sample = now
        elapsed = self.elapsed
        if c['playback'] == 'loop' and c['timing'] == 'sync': elapsed = clock.position(now) / c['beats']
        if c['playback'] == 'one_shot' and elapsed >= 1:
            self.active = False
            return 0.
        elapsed = max(0., elapsed)
        phase = (elapsed + self.phase + .5 * self.offsets.get('phase', 0.)) % 1
        shape = c['shape']
        if shape == 'random':
            cycle = int(elapsed)
            if cycle != self.cycle:
                # Catch up exactly once per musical cycle, never per scheduler tick.
                for _ in range(min(cycle - self.cycle, 4096)):
                    self.previous, self.target = self.target, self.rng.uniform(-1, 1)
                self.cycle = cycle
            slew = max(0., min(1., c['slew'] + self.offsets.get('phase', 0.)))
            return self.previous + (self.target - self.previous) * min(1., (elapsed % 1) / slew) if slew else self.target
        return {'sine': lambda: math.sin(2 * math.pi * phase),
                'triangle': lambda: 1 - 4 * abs(phase - .5),
                'saw_up': lambda: phase * 2 - 1,
                'saw_down': lambda: 1 - phase * 2,
                'square': lambda: 1. if phase < .5 else -1.}[shape]()


class Performance:
    def __init__(self, engine):
        self.engine = engine
        self.config = validate_config(engine.profile.get('performance', defaults()), engine.setup, engine.profile['ports'].get('a4_input'), engine.profile['trigger'], engine.profile['sidechain'])
        from .mod_destinations import expand
        self.expanded_destinations = [expand(m, engine.setup) for m in self.config['mods']]
        self.build_operators()
        self.clock = MusicalClock()
        self.captures = [None] * len(self.config['slots'])
        self.revision = 0
        self.shift = False
        self.virtual_shift = False
        self.pressed = {}
        self.note_knobs = {}
        self.pending = None
        self.error = None
        self.sources = [ModSource(m, 0) for m in self.config['mods']]
        self.values = [0.] * len(self.sources)
        self.order = mod_order(len(self.sources), mod_graph(self.config['mods']))
        # Existing sidechain survives migration; generated sources start bypassed.
        for source in self.sources:
            if source.config['playback'] != 'gate':
                source.config['enabled'] = False; source.active = False

    def build_operators(self):
        from .operators import OperatorGraph
        from .mod_destinations import expand
        self.operator_graph = OperatorGraph(self.config['operators'])
        self.expanded_operators = [expand(dict(destinations=op['targets']), self.engine.setup) for op in self.config['operators']]
        self.op_values = [0.] * len(self.config['operators'])
        self.cc_values = getattr(self, 'cc_values', {})
        self.assumed_sent = set()
        self.port_controllers = {}
        for device in self.engine.setup['devices']:
            if device['kind'] == 'controller':
                for source in dict.fromkeys((device['id'], device.get('input') or device['id'])):
                    self.port_controllers.setdefault(source, []).append(device['id'])

    def operator_reads(self, controller, source):
        """True when an operator takes this controller CC as a signal or to set one of its settings."""
        if not source: return False
        key = (controller, source['channel'], source['cc'])
        for op in self.config['operators']:
            if any(link['controller'] == key[0] and (link['channel'], link['number']) == key[1:] for link in op['links'].values()): return True
            if any(i['type'] == 'cc' and i['controller'] == key[0] and (i['channel'], i['number']) == key[1:] for i in op['inputs']): return True
        return False

    def signal(self, i):
        """Current output of a modulation source: an int is a MOD, ('op', j) is an operator."""
        if isinstance(i, tuple): return self.op_values[i[1]]
        return self.values[i] * self.sources[i].effective_amount()

    def operator_routes(self):
        routes = []
        for j, expanded in enumerate(self.expanded_operators):
            for route in expanded:
                routes.append((('op', j), dict(ref=route['ref'], amount=route['amount'], min=route['min'], max=route['max'])))
        return routes

    def configure(self, value, now):
        config = validate_config(value, self.engine.setup, self.engine.profile['ports'].get('a4_input'), self.engine.profile['trigger'], self.engine.profile['sidechain'])
        previous_targets = {ref_key(t['ref']) for source in self.sources for t in self.routes(source)}
        sources, values = [], []
        for i, mod in enumerate(config['mods']):
            old = self.sources[i] if i < len(self.sources) else None
            if old is not None and old.config == mod:
                old.config = mod
                sources.append(old); values.append(self.values[i])
            else:
                sources.append(ModSource(mod, now)); values.append(0.)
        self.config = config
        self.fit_captures()
        from .mod_destinations import expand
        self.expanded_destinations = [expand(m, self.engine.setup) for m in config['mods']]
        previous_operator_targets = {ref_key(route['ref']) for _, route in self.operator_routes()}
        self.build_operators()
        self.sources = sources
        self.values = values
        self.order = mod_order(len(sources), mod_graph(config['mods']))
        self.shift = False; self.virtual_shift = False; self.pressed.clear(); self.pending = None
        for ref in previous_targets | previous_operator_targets:
            if ref in self.engine.bank_values and self.engine.bank_values[ref] is not None: self.engine.emit_base(ref)
        self.engine.profile['performance'] = copy.deepcopy(config)

    def sidechain_enabled(self):
        if not self.config['mods']: return False
        m = self.config['mods'][0]
        return m['shape'] == 'envelope' and m['playback'] == 'gate' and m['enabled']

    def fit_captures(self):
        """Captured values are stored by slot index; the list always matches the slot count."""
        count = len(self.config['slots'])
        if len(self.captures) < count: self.captures = list(self.captures) + [None] * (count - len(self.captures))
        elif len(self.captures) > count: self.captures = list(self.captures[:count])

    def slot_banks(self, slot):
        """Banks a slot covers, or None for every bank. A canvas snapshot (node) with no scope covers nothing."""
        if not slot.get('node'):
            return set(slot['banks']) or None
        banks = set()
        for target in slot.get('targets', []):
            kind = target['type']
            if kind == 'all': return None
            if kind == 'bank': banks.add(target['bank'])
            elif kind == 'device': banks.update(b['id'] for b in self.engine.banks.values() if b['destination'] == target['device'])
            elif kind == 'channel':
                banks.update(b['id'] for b in self.engine.banks.values() if b['destination'] == target['device'] and any((c[0] if isinstance(c, tuple) else c) == target['channel'] for c in self.engine.targets(b)))
        return banks

    def slot_refs(self, slot):
        """Every parameter a slot captures and recalls."""
        if not slot.get('node'):
            banks = slot['banks']
            if not banks: return set(self.engine.bank_values)
            result = set()
            for bid in banks:
                if bid not in self.engine.banks: raise ValueError('Unknown snapshot bank')
                result.update(self.engine.bank_refs(self.engine.banks[bid]))
            return result
        result = set()
        for target in slot.get('targets', []):
            kind = target['type']
            if kind == 'all': return set(self.engine.bank_values)
            if kind == 'bank':
                if target['bank'] not in self.engine.banks: raise ValueError('Unknown snapshot bank')
                result.update(self.engine.bank_refs(self.engine.banks[target['bank']]))
            elif kind == 'device': result.update(ref for ref in self.engine.bank_values if ref[0] == target['device'])
            elif kind == 'channel':
                result.update(ref for ref in self.engine.bank_values if ref[0] == target['device'] and (ref[1][0] if isinstance(ref[1], tuple) else ref[1]) == target['channel'])
        return result

    def scoped_refs(self, banks):
        return self.slot_refs(dict(banks=banks))

    def capture(self, slot):
        number(slot, 0, len(self.config['slots']) - 1, 'Snapshot slot', True)
        config = self.config['slots'][slot]
        rows, unknown, seen = [], 0, set()
        for ref in sorted(self.slot_refs(config), key=str):
            p, signature = self.engine.parameter_info(ref)
            if not p.get('include_snapshot', True): continue
            addr = tuple(signature[:3])
            if addr in seen: continue
            seen.add(addr)
            value = self.engine.bank_values[ref]
            if value is None: unknown += 1; continue
            rows.append(dict(ref=json.loads(json.dumps(ref)), signature=copy.deepcopy(signature), value=value))
        depths, scope = [], self.slot_banks(config)
        for bank in self.engine.banks.values():
            if scope is not None and bank['id'] not in scope: continue
            if bank.get('depth_include_snapshot', False):
                depths.append(dict(bank=bank['id'], depth=bank['depth'], mod_depths=[self.engine.bank_mod_depth(bank, i) for i in range(len(self.sources))], overrides=copy.deepcopy(bank.get('depth_overrides', {})),
                                   targets=json.loads(json.dumps(self.engine.targets(bank))), destination=bank['destination']))
        self.captures[slot] = dict(values=rows, depths=depths, unknown=unknown, saved_at=round(time.time(), 3))
        self.revision += 1

    def validate_capture(self, capture):
        if not isinstance(capture, dict) or not isinstance(capture.get('values'), list) or not isinstance(capture.get('depths'), list): raise ValueError('Invalid snapshot data')
        if len(capture['values']) > 80000: raise ValueError('Snapshot is too large')
        changes, depths = [], []
        for row in capture['values']:
            if not isinstance(row, dict): raise ValueError('Invalid snapshot value')
            ref = ref_key(row.get('ref'))
            if ref not in self.engine.bank_values: raise ValueError('Snapshot has a removed destination; recapture it')
            p, signature = self.engine.parameter_info(ref)
            if not p.get('include_snapshot', True): continue
            if row.get('signature') != signature: raise ValueError('Snapshot destination changed; recapture it')
            number(row.get('value'), p.get('min', 0), p.get('max', 127), 'Snapshot value', True)
            changes.append((ref, row['value']))
        for row in capture['depths']:
            if not isinstance(row, dict): raise ValueError('Invalid snapshot depth')
            if not isinstance(row.get('bank'), str): raise ValueError('Invalid snapshot bank')
            bank = self.engine.banks.get(row.get('bank'))
            if bank is None: raise ValueError('Snapshot MOD bank was removed')
            if not bank.get('depth_include_snapshot', False): continue
            if row.get('targets') != json.loads(json.dumps(self.engine.targets(bank))) or row.get('destination') != bank['destination']: raise ValueError('Snapshot MOD bank destinations changed')
            number(row.get('depth'), 0, 1, 'Snapshot depth')
            if 'mod_depths' in row:
                if not isinstance(row['mod_depths'], list) or not 1 <= len(row['mod_depths']) <= MAX_MODS: raise ValueError('Invalid snapshot MOD amounts')
                for value in row['mod_depths']: number(value, 0, 1, 'Snapshot MOD amount')
            overrides = row.get('overrides')
            if not isinstance(overrides, dict) or any(k not in map(str, bank['channels']) for k in overrides): raise ValueError('Invalid snapshot depth overrides')
            for v in overrides.values(): number(v, 0, 1, 'Snapshot depth override')
            depths.append((bank, row))
        return changes, depths

    def recall(self, capture):
        changes, depths = self.validate_capture(capture)
        for ref, value in changes: self.engine.set_base(ref, value)
        for bank, row in depths:
            bank['depth'] = row['depth']; bank['depth_overrides'] = copy.deepcopy(row['overrides'])
            if 'mod_depths' in row: bank['mod_depths'] = copy.deepcopy(row['mod_depths'])
        self.engine.refresh_feedback()

    def request(self, action, now):
        if not isinstance(action, dict): raise ValueError('Invalid performance action')
        kind = action.get('action')
        if not isinstance(kind, str): raise ValueError('Choose a performance action')
        if kind == 'shift':
            binding = self.config['shift']
            if binding is None or action.get('expected') != binding: raise ValueError('Shift mapping changed; refresh the page')
            on = action.get('on')
            if type(on) is not bool: raise ValueError('Shift state must be on/off')
            if binding['mode'] == 'toggle':
                if on: self.virtual_shift = not self.virtual_shift
            else: self.virtual_shift = on
            return
        if kind == 'capture': self.capture(action.get('slot')); return
        if kind == 'cancel': self.pending = None; return
        if kind == 'align': self.clock.align(now); self.pending = None; return
        if kind == 'mod_stop': self.stop_mods(now); return
        if kind == 'panic': self.engine.panic(now); return
        if kind.startswith('mod_'):
            i = number(action.get('mod'), 0, len(self.sources) - 1, 'MOD slot', True)
            source = self.sources[i]
            if kind == 'mod_trigger':
                key = action.get('key', 'manual')
                if not isinstance(key, (str, tuple)): raise ValueError('Invalid MOD gate identifier')
                strength = number(action.get('strength', 1.), 0, 1, 'Trigger strength')
                if type(action.get('on', True)) is not bool: raise ValueError('Gate state must be on/off')
                source.trigger(now, self.clock.position(now), strength, key=key, on=action.get('on', True))
            elif kind == 'mod_enable':
                source.config['enabled'] = not source.config['enabled']
                source.gates.clear()
                source.active = source.config['enabled'] and source.config['playback'] == 'loop'
                if source.active: source.trigger(now, self.clock.position(now))
            else: raise ValueError('Use a CC binding for continuous MOD control')
            return
        if kind == 'recall':
            slot = number(action.get('slot'), 0, len(self.config['slots']) - 1, 'Snapshot slot', True)
            payload = copy.deepcopy(self.captures[slot])
            if payload is None: raise ValueError('Snapshot slot is empty')
            self.validate_capture(payload)
        elif kind == 'reset':
            bank = action.get('bank')
            if bank is not None and (not isinstance(bank, str) or bank not in self.engine.banks): raise ValueError('Unknown bank')
            payload = bank
            if bank is None and action.get('layer') is not None: payload = ('layer', action.get('layer_controller'), action['layer'])
        else: raise ValueError('Unknown performance command')
        when = action.get('when', 'instant')
        if when not in ('instant', 'bar'): raise ValueError('Choose Instant or Next bar')
        bars = action.get('bars', 1)
        slot_index = action.get('slot') if kind in ('capture', 'recall') else None
        # A canvas snapshot can carry its own recall timing: on the 1, every 1/2/4/8/16 bars.
        if kind == 'recall' and slot_index is not None and self.config['slots'][slot_index].get('quantize_bars'):
            when, bars = 'bar', self.config['slots'][slot_index]['quantize_bars']
        if bars not in BAR_WINDOWS: raise ValueError('Choose 1, 2, 4, 8 or 16 bars')
        if when == 'bar':
            if not self.clock.valid(now): raise ValueError('Next bar needs running, aligned MIDI clock; start transport or Set the one')
            pulses = self.config['beats_per_bar'] * 96 // self.config['beat_unit'] * bars
            self.pending = dict(kind=kind, payload=payload, at=(self.clock.pulses // pulses + 1) * pulses, slot=slot_index, bars=bars)
        else: self.execute(kind, payload)

    def execute(self, kind, payload):
        if kind == 'recall': self.recall(payload)
        elif payload is None: self.engine.reset_mixer()
        elif isinstance(payload, tuple): self.engine.reset_layer(payload[1], payload[2])
        else: self.engine.reset_bank(payload)

    def clock_event(self, message, now):
        if message.type in ('start', 'stop', 'songpos'): self.pending = None
        self.clock.handle(message, now)
        if message.type == 'start':
            for source in self.sources:
                if source.config['timing'] == 'sync':
                    source.active = source.config['enabled'] and source.config['playback'] == 'loop'
                    source.phase = source.config['phase'] / 360
                    source.cycle = -1
        self.tick(now)

    def match(self, b, source, event):
        if b is None or b['controller'] != source or b['channel'] != event.channel: return False
        return (b.get('type', 'cc') == 'cc' and event.type == 'control_change' and b['number'] == event.control or
                b.get('type') == 'note' and event.type in ('note_on', 'note_off') and (b['number'] is None or b['number'] == event.note))

    def apply_continuous(self, action, value):
        number(value, 0, 127, 'Control value', True)
        a = action
        if a.get('action') not in ('mod_rate', 'mod_amount', 'mod_phase', 'mod_depth', 'mod_release'):
            raise ValueError('Action is not a continuous MOD control')
        c = self.sources[a['mod']].config; fraction = value / 127
        if a['action'] == 'mod_rate':
            if c['timing'] == 'free': c['rate'] = .01 * 2000 ** fraction
            else: c['beats'] = [.0625, .125, .25, .5, 1, 2, 4, 8, 16, 32, 64][round(fraction * 10)]
        elif a['action'] == 'mod_depth': self.engine.set_bank_mod_depth(a['bank'], a['mod'], fraction)
        elif a['action'] == 'mod_release': c['release_ms'] = fraction * 2000
        elif a['action'] == 'mod_phase': c['slew' if c['shape'] == 'random' else 'phase'] = fraction if c['shape'] == 'random' else fraction * 360
        else: c['amount'] = fraction

    def handle(self, source, event, now):
        if event.type == 'control_change' and self.cc_values is not None:
            for controller in self.port_controllers.get(source, ()): self.cc_values[controller, event.channel, event.control] = event.value
        if event.type not in ('control_change', 'note_on', 'note_off'): return False
        on = event.value > 0 if event.type == 'control_change' else event.type == 'note_on' and event.velocity > 0
        strength = event.velocity / 127 if event.type == 'note_on' else 1.
        key = (source, 'cc' if event.type == 'control_change' else 'note', event.channel, event.control if event.type == 'control_change' else event.note)
        shift = self.config['shift']
        if self.match(shift, source, event):
            if on and key not in self.pressed:
                self.shift = not self.shift if shift['mode'] == 'toggle' else True
                self.pressed[key] = None
            elif not on:
                self.pressed.pop(key, None)
                if shift['mode'] == 'momentary': self.shift = False
            return True
        matches = [a for a in self.config['actions'] if self.match(a, source, event)]
        if matches:
            condition = 'on' if self.shift or self.virtual_shift else 'off'
            a = next((a for a in matches if a.get('shift', 'any') == condition), next((a for a in matches if a.get('shift', 'any') == 'any'), None))
            if a and a['action'] in NOTE_ACTIONS:
                number(event.value, 0, 127, 'Control value', True)
                low, high, _ = NOTE_PARAMS[NOTE_ACTIONS[a['action']]]
                self.note_knobs[a['route'], NOTE_ACTIONS[a['action']]] = low + event.value / 127 * (high - low)
                return True
            if a and a['action'] in ('mod_rate', 'mod_amount', 'mod_phase', 'mod_depth', 'mod_release'):
                self.apply_continuous(a, event.value)
                return True
            if on and key not in self.pressed:
                chosen = copy.deepcopy(a)
                if chosen: chosen.update(key=key, strength=strength)
                self.pressed[key] = (now, chosen)
                if chosen and not chosen.get('hold_ms'): self.safe_request(chosen, now)
            elif not on:
                held = self.pressed.pop(key, None)
                if held and held[1] and held[1]['action'] == 'mod_trigger':
                    self.safe_request(dict(held[1], on=False), now)
            return True
        handled = False
        for mod in self.sources:
            if self.match(mod.config['trigger'], source, event):
                mod.trigger(now, self.clock.position(now), strength, key, on)
                handled = True
        return handled

    def release_controller(self, controller, now):
        """Release only this input's gates and buttons after losing its port."""
        self.engine.release_layer_switch(controller)
        for key in list(self.pressed):
            if isinstance(key, tuple) and key[0] == controller:
                self.pressed.pop(key)
        shift = self.config['shift']
        if shift and shift['controller'] == controller:
            self.shift = False
        for source in self.sources:
            removed = False
            for key in list(source.gates):
                if isinstance(key, tuple) and key[0] == controller:
                    source.gates.pop(key)
                    removed = True
            if removed:
                goal = max((v for values in source.gates.values() for v, _ in values), default=0.)
                source.transition = (now, source.level, goal)

    def note_live(self, routes):
        """Effective values for keyboard routes that a knob or MOD is moving: {route id: {name: value}}."""
        offsets = {}
        for i, source in enumerate(self.sources):
            for target in source.config.get('note_targets', ()):
                span = NOTE_PARAMS[target['parameter']][2]
                key = target['route'], target['parameter']
                offsets[key] = offsets.get(key, 0.) + self.values[i] * source.effective_amount() * target['amount'] * span
        result = {}
        for route in routes:
            rid = route.get('id')
            if not rid: continue
            for name, (low, high, _) in NOTE_PARAMS.items():
                knob, offset = self.note_knobs.get((rid, name)), offsets.get((rid, name))
                base = note_base(route, name)
                if (knob is None and offset is None) or base is None: continue
                result.setdefault(rid, {})[name] = max(low, min(high, (base if knob is None else knob) + (offset or 0.)))
        return result

    def safe_request(self, action, now):
        try: self.request(action, now); self.error = None
        except ValueError as exc: self.error = str(exc)

    def tick(self, now):
        if not self.clock.valid(now): self.pending = None
        if self.pending and self.clock.pulses >= self.pending['at']:
            pending, self.pending = self.pending, None
            try: self.execute(pending['kind'], pending['payload']); self.error = None
            except ValueError as exc: self.error = str(exc)
        for key, held in list(self.pressed.items()):
            if held and held[1] and held[1].get('hold_ms') and now - held[0] >= held[1]['hold_ms'] / 1000:
                self.safe_request(held[1], now); self.pressed[key] = None
        self.values = self.sample_sources(now)
        if self.operator_graph.operators:
            self.op_values = list(self.operator_graph.evaluate([self.signal(i) for i in range(len(self.sources))], self.cc_values, now))
        # Resolve changing bank amounts once per tick, then look up contributions
        # by physical address instead of rebuilding/scanning all routes for every
        # target. This index is local: live edits, recalls and depth changes cannot
        # leave a stale cache behind. Preserve route/source order and alias rules.
        source_routes = [self.routes(source) for source in self.sources]
        routes_by_address = {}
        for i, routes in enumerate(source_routes):
            for target in routes:
                _, signature = self.engine.parameter_info(ref_key(target['ref']))
                routes_by_address.setdefault(tuple(signature[:3]), []).append((i, target))
        operator_routes = self.operator_routes()
        operator_routes = [(source_id, target) for source_id, target in operator_routes if target['ref'][2] != 'volume']
        for source_id, target in operator_routes:
            _, signature = self.engine.parameter_info(ref_key(target['ref']))
            routes_by_address.setdefault(tuple(signature[:3]), []).append((source_id, target))
        for routes in source_routes:
            for t in routes: self.emit_modulated(ref_key(t['ref']), routes_by_address)
        for _, t in operator_routes: self.emit_modulated(ref_key(t['ref']), routes_by_address)

    def emit_modulated(self, ref, routes_by_address):
        """Modulate a known base or explicit reset, never an invented hardware value."""
        engine = self.engine
        if engine.bank_values.get(ref) is not None:
            engine.emit_base(ref, routes_by_address=routes_by_address); return
        param, _ = engine.parameter_info(ref)
        assumed = param.get('reset')
        if assumed is None: return
        value = self.output(ref, assumed, routes_by_address=routes_by_address)
        sent = self.assumed_sent
        if value != assumed or ref in sent:
            sent.add(ref); engine._emit(ref[0], param, value)

    def sample_sources(self, now):
        """Sample modulators first so MOD-to-MOD offsets apply in the same tick."""
        values = [0.] * len(self.sources)
        incoming = {}
        for i, source in enumerate(self.sources):
            for target in source.config.get('mod_targets', ()):
                incoming.setdefault(target['mod'], []).append((i, target))
        for i in self.order:
            source = self.sources[i]
            offsets = {}
            for k, target in incoming.get(i, ()):
                modulator = self.sources[k]
                offsets[target['parameter']] = offsets.get(target['parameter'], 0.) + values[k] * modulator.effective_amount() * target['amount']
            source.offsets = offsets
            values[i] = source.sample(now, self.clock)
        return values

    def routes(self, source):
        i = self.sources.index(source)
        routes = list(source.config['targets'])
        for target in source.config['bank_targets']:
            if target['parameter'] == 'volume': continue
            bank = self.engine.banks[target['bank']]
            amount = self.engine.bank_mod_depth(bank, i)
            for cid in self.engine.targets(bank):
                routes.append(dict(ref=[bank['destination'], list(cid) if isinstance(cid, tuple) else cid, target['parameter']], amount=amount))
        for route in self.expanded_destinations[i]:
            if route['ref'][2] == 'volume': continue
            amount = route['amount'] * (self.engine.bank_mod_depth(self.engine.banks[route['bank']], i) if route['bank'] else 1.)
            routes.append(dict(ref=route['ref'], amount=amount, min=route['min'], max=route['max']))
        # Overlapping banks use greatest depth, never duplicate the same source.
        merged = {}
        for route in routes:
            ref = ref_key(route['ref'])
            key = tuple(self.engine.parameter_info(ref)[1][:3])
            if key not in merged or abs(route['amount']) > abs(merged[key]['amount']): merged[key] = route
        return list(merged.values())

    def volume_attenuation(self, did, cid):
        attenuation = 0.
        for i, source in enumerate(self.sources):
            depth = 0.
            for target in source.config['bank_targets']:
                bank = self.engine.banks[target['bank']]
                if target['parameter'] == 'volume' and bank['destination'] == did and cid in self.engine.targets(bank):
                    amount = self.engine.bank_mod_depth(bank, i)
                    if i == 0: amount = bank.get('depth_overrides', {}).get(str(cid[0] if isinstance(cid, tuple) else cid), amount)
                    depth = max(depth, amount)
            # Calibrated volume is attenuation only; bipolar negative halves rest at base.
            attenuation = max(attenuation, max(0., self.values[i]) * source.effective_amount() * depth)
        return min(1., attenuation)

    def volume_value(self, did, cid, curve):
        value = self.engine.curve_value(curve, self.volume_attenuation(did, cid))
        for i, source in enumerate(self.sources):
            for route in self.expanded_destinations[i]:
                if ref_key(route['ref']) != (did, cid, 'volume'): continue
                depth = route['amount']
                if route['bank']:
                    bank = self.engine.banks[route['bank']]
                    amount = self.engine.bank_mod_depth(bank, i)
                    if i == 0: amount = bank.get('depth_overrides', {}).get(str(cid[0] if isinstance(cid, tuple) else cid), amount)
                    depth *= amount
                attenuation = max(0., self.values[i]) * source.effective_amount() * depth
                output = self.engine.curve_value(curve, attenuation)
                value = min(value, max(route['min'], min(route['max'], output)))
        for j, expanded in enumerate(self.expanded_operators):
            for route in expanded:
                if ref_key(route['ref']) != (did, cid, 'volume'): continue
                attenuation = max(0., self.op_values[j]) * route['amount']
                value = min(value, max(route['min'], min(route['max'], self.engine.curve_value(curve, attenuation))))
        return value

    def release_gates(self, now):
        for source in self.sources:
            source.gates.clear(); source.level = 0.; source.transition = (now, 0., 0.)
            if source.config['playback'] == 'gate': source.active = False
        self.values = [0. if s.config['playback'] == 'gate' else v for s, v in zip(self.sources, self.values)]

    def output(self, ref, value, *, routes_by_address=None):
        _, signature = self.engine.parameter_info(ref)
        low, high = signature[3], signature[4]
        span = high - low
        if routes_by_address is None:
            # Commands outside a tick must read current amounts immediately.
            contributions = [(i, target) for i, source in enumerate(self.sources)
                             for target in self.routes(source)
                             if signature[:3] == self.engine.parameter_info(ref_key(target['ref']))[1][:3]]
            contributions += [(i, target) for i, target in self.operator_routes()
                              if target['ref'][2] != 'volume' and signature[:3] == self.engine.parameter_info(ref_key(target['ref']))[1][:3]]
        else:
            contributions = routes_by_address.get(tuple(signature[:3]), ())
        for i, target in contributions:
            low, high = max(low, target.get('min', low)), min(high, target.get('max', high))
            value += self.signal(i) * target['amount'] * span
        return max(low, min(high, value))

    def stop_mods(self, now):
        for source in self.sources:
            source.config['enabled'] = False; source.active = False; source.gates.clear()
        self.values = [0.] * len(self.sources)
        for source in self.sources:
            source.offsets = {}
            for target in self.routes(source):
                ref = ref_key(target['ref'])
                if self.engine.bank_values[ref] is not None: self.engine.emit_base(ref)
        self.engine.panic(now)

    def state(self, now):
        captures = []
        for capture in self.captures:
            error = None
            if capture:
                try: self.validate_capture(capture)
                except ValueError as exc: error = str(exc)
            captures.append(dict(saved=capture is not None, count=len(capture['values']) if capture else 0,
                                 unknown=capture.get('unknown', 0) if capture else 0, error=error))
        source_status = [dict(active=source.active,
                              held=sum(len(notes) for notes in source.gates.values()),
                              expired=source.expired_notes)
                         for source in self.sources]
        bpm = 60 / (self.clock.period * 24) if self.clock.period else None
        return dict(config=copy.deepcopy(self.config), slots=captures, shift=self.shift or self.virtual_shift, pending=copy.deepcopy(self.pending),
                    error=self.error, values=list(self.values), sources=source_status,
                    clock=dict(running=self.clock.running, aligned=self.clock.aligned,
                    receiving=self.clock.valid(now), quarter=self.clock.position(now), bpm=bpm), revision=self.revision)
