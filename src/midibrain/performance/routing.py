"""Explicit port-to-port routes; absent configuration preserves the mixer rig."""
import copy
import re
from collections import Counter, deque

import mido

from .profile import number


def empty_routing():
    return {'clock': {'source': None, 'destinations': [], 'transport': True}, 'cc': []}


# Note routes (keyboards): source port/channel -> destination port/channel, with a
# key range (for splits), transposition, optional scale quantising and fixed velocity.
SCALES = {
    'major': (0, 2, 4, 5, 7, 9, 11), 'minor': (0, 2, 3, 5, 7, 8, 10), 'dorian': (0, 2, 3, 5, 7, 9, 10),
    'phrygian': (0, 1, 3, 5, 7, 8, 10), 'lydian': (0, 2, 4, 6, 7, 9, 11), 'mixolydian': (0, 2, 4, 5, 7, 9, 10),
    'locrian': (0, 1, 3, 5, 6, 8, 10), 'harmonic_minor': (0, 2, 3, 5, 7, 8, 11), 'melodic_minor': (0, 2, 3, 5, 7, 9, 11),
    'pentatonic_major': (0, 2, 4, 7, 9), 'pentatonic_minor': (0, 3, 5, 7, 10), 'blues': (0, 3, 5, 6, 7, 10),
    'whole_tone': (0, 2, 4, 6, 8, 10),
}
NOTE_ROUTE_KEYS = {'id', 'source', 'channel', 'low', 'high', 'port', 'out_channel', 'transpose', 'scale', 'fixed_velocity', 'passthrough', 'controller'}


EXPRESSION = ('bend', 'pressure', 'modwheel', 'sustain')


def expression_name(message):
    if message.type == 'pitchwheel': return 'bend'
    if message.type == 'aftertouch': return 'pressure'
    if message.type == 'control_change': return {1: 'modwheel', 64: 'sustain'}.get(message.control)
    return None


def expression_raw(message):
    return message.pitch if message.type == 'pitchwheel' else message.value


def expression_total(name, incoming, offset):
    total = incoming + offset
    if name == 'bend': return int(max(-8192, min(8191, round(total))))
    value = int(max(0, min(127, round(total))))
    return (127 if value >= 64 else 0) if name == 'sustain' else value


def expression_message(factory, name, channel, value):
    """channel is 0-based. factory is a mido Message class (or an instance's type)."""
    if name == 'bend': return factory('pitchwheel', channel=channel, pitch=value)
    if name == 'pressure': return factory('aftertouch', channel=channel, value=value)
    return factory('control_change', channel=channel, control=1 if name == 'modwheel' else 64, value=value)


def quantize_note(note, root, mode):
    """Snap a note to the nearest degree of the scale (ties go down)."""
    degrees = {(root + step) % 12 for step in SCALES[mode]}
    for distance in range(12):
        for candidate in (note - distance, note + distance):
            if 0 <= candidate <= 127 and candidate % 12 in degrees:
                return candidate
    return note


def map_note(route, note):
    """Transpose, then quantise, so the output always lands in the chosen scale."""
    result = max(0, min(127, note + route.get('transpose', 0)))
    scale = route.get('scale')
    return quantize_note(result, scale['root'], scale['mode']) if scale else result


def port_name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError('Choose a MIDI port')
    return value


def port_stem(value):
    return re.sub(r' \d+:\d+$', '', value)


def validate_routing(value):
    if not isinstance(value, dict) or not {'clock', 'cc'} <= set(value) or set(value) - {'clock', 'cc', 'notes'}:
        raise ValueError('Routing must contain clock and cc')
    clock = value['clock']
    if not isinstance(clock, dict) or set(clock) != {'source', 'destinations', 'transport'}:
        raise ValueError('Clock needs a source, destinations and transport switch')
    if type(clock['transport']) is not bool:
        raise ValueError('Clock transport must be true or false')
    if clock['source'] is not None:
        port_name(clock['source'])
    if not isinstance(clock['destinations'], list) or len(clock['destinations']) > 32:
        raise ValueError('Clock accepts up to 32 destinations')
    seen = set()
    for destination in clock['destinations']:
        port_name(destination)
        if clock['source'] is None:
            raise ValueError('Choose a clock source before its destinations')
        key = port_stem(destination)
        if key == port_stem(clock['source']) or key in seen:
            raise ValueError('Duplicate clock destination or return to the source port')
        seen.add(key)
    if not isinstance(value['cc'], list) or len(value['cc']) > 64:
        raise ValueError('Up to 64 CC routes are supported')
    sources = {}
    graph = {}
    for route in value['cc']:
        if not isinstance(route, dict) or not {'source', 'channel', 'cc', 'destinations'} <= set(route) or set(route) - {'source', 'channel', 'cc', 'destinations', 'page', 'controller', 'layer'}:
            raise ValueError('CC routes need source, channel, cc and destinations')
        if 'page' in route and (not isinstance(route['page'], str) or not 1 <= len(route['page']) <= 80): raise ValueError('Page must be a name up to 80 characters')
        port_name(route['source'])
        number(route['channel'], 1, 16, 'Source channel', True)
        number(route['cc'], 0, 119, 'Source CC', True)
        source = (port_stem(route['source']), route['channel'], route['cc'])
        if ('controller' in route) != ('layer' in route) or ('layer' in route and (not isinstance(route['layer'], str) or not isinstance(route['controller'], str))):
            raise ValueError('A direct layer route needs its controller and layer')
        scope = (route['controller'], route['layer']) if 'layer' in route else None
        scopes = sources.setdefault(source, set())
        if scopes and (scope is None or None in scopes or scope in scopes):
            raise ValueError('Combine destinations under one route for each source CC')
        scopes.add(scope)
        if not isinstance(route['destinations'], list) or not 1 <= len(route['destinations']) <= 32:
            raise ValueError('Each CC route needs 1..32 destinations')
        targets = set()
        for target in route['destinations']:
            if not isinstance(target, dict) or not {'port', 'channel', 'cc'} <= set(target) or set(target) - {'port', 'channel', 'cc', 'min', 'max', 'invert'}:
                raise ValueError('Each destination needs port, channel and cc')
            lo = number(target.get('min', 0), 0, 127, 'Destination minimum', True)
            number(target.get('max', 127), lo, 127, 'Destination maximum', True)
            if type(target.get('invert', False)) is not bool: raise ValueError('Invert must be on/off')
            port_name(target['port'])
            number(target['channel'], 1, 16, 'Destination channel', True)
            number(target['cc'], 0, 119, 'Destination CC', True)
            key = (port_stem(target['port']), target['channel'], target['cc'])
            if key in targets or key[0] == source[0]:
                raise ValueError('Duplicate destination or return to the source port')
            targets.add(key)
            graph.setdefault(source, set()).add(key)
    notes = value.get('notes', [])
    if not isinstance(notes, list) or len(notes) > 64:
        raise ValueError('Up to 64 note routes are supported')
    note_ids = set()
    for route in notes:
        if not isinstance(route, dict) or not {'source', 'channel', 'port', 'out_channel'} <= set(route) or set(route) - NOTE_ROUTE_KEYS:
            raise ValueError('Note routes need a source, channel, port and output channel')
        port_name(route['source']); port_name(route['port'])
        number(route['channel'], 1, 16, 'Note source channel', True)
        number(route['out_channel'], 1, 16, 'Note output channel', True)
        low = number(route.get('low', 0), 0, 127, 'Lowest note', True)
        number(route.get('high', 127), low, 127, 'Highest note', True)
        number(route.get('transpose', 0), -48, 48, 'Transpose', True)
        if route.get('fixed_velocity') is not None: number(route['fixed_velocity'], 1, 127, 'Fixed velocity', True)
        if type(route.get('passthrough', True)) is not bool: raise ValueError('Pass-through must be on/off')
        if route.get('controller') is not None and not isinstance(route['controller'], str): raise ValueError('Note route controller must be text')
        if 'id' in route:
            if not isinstance(route['id'], str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,32}', route['id']): raise ValueError('Note route ids use letters, numbers, - or _')
            if route['id'] in note_ids: raise ValueError('Duplicate note route id')
            note_ids.add(route['id'])
        scale = route.get('scale')
        if scale is not None:
            if not isinstance(scale, dict) or set(scale) != {'root', 'mode'} or scale['mode'] not in SCALES:
                raise ValueError('Scale needs a root note and a known mode')
            number(scale['root'], 0, 11, 'Scale root', True)
        if port_stem(route['port']) == port_stem(route['source']):
            raise ValueError('A note route cannot return to its source port')
    complete = set()
    def visit(node, path):
        if node in path:
            raise ValueError('CC routes form a MIDI feedback cycle')
        if node in complete:
            return
        for target in graph.get(node, ()):
            visit(target, path | {node})
        complete.add(node)
    for source in sources:
        visit(source, set())
    return copy.deepcopy(value)


def validate_preset_targets(profile):
    """The preset owns its mixer addresses, including sidechain volume."""
    if 'bank_setup' in profile:
        from .banks import expanded_channels
        devices = {d['id']: d for d in profile['bank_setup']['devices']}
        reserved = {(port_stem(devices[did]['output']), param['channel'], param['cc'])
                    for (did, cid), channel in expanded_channels(profile['bank_setup']).items() if devices[did].get('output')
                    for param in [*channel['parameters'].values(), *([channel['volume']] if channel.get('volume') else [])]}
        for route in profile.get('routing', empty_routing())['cc']:
            for target in route['destinations']:
                if (port_stem(target['port']), target['channel'], target['cc']) in reserved:
                    raise ValueError('This address belongs to a device definition; assign it through a bank')
        return
    mixer = profile['ports'].get('l6_output')
    if not mixer:
        return
    reserved = {(p['channel'], p['cc']) for ch in profile['channels']
                for p in ch['parameters'].values()}
    for route in profile.get('routing', empty_routing())['cc']:
        for target in route['destinations']:
            if (port_stem(target['port']) == port_stem(mixer) and
                    (target['channel'], target['cc']) in reserved):
                raise ValueError('This L6 address is managed by the performance preset; use the channel matrix')


def required_ports(routing):
    inputs, outputs = set(), set(routing['clock']['destinations'])
    if routing['clock']['source']:
        inputs.add(routing['clock']['source'])
    for route in routing['cc']:
        inputs.add(route['source'])
        outputs.update(target['port'] for target in route['destinations'])
    for route in routing.get('notes', []):
        inputs.add(route['source']); outputs.add(route['port'])
    return inputs, outputs


def upgrade_layer_routes(profile):
    result = copy.deepcopy(profile)
    setup, routing = result.get('bank_setup'), result.get('routing')
    if not isinstance(setup, dict) or not isinstance(setup.get('devices'), list) or not isinstance(routing, dict) or not isinstance(routing.get('cc'), list): return result
    from .banks import controller_layers
    for route in result.get('routing', {}).get('cc', []):
        if not isinstance(route, dict) or route.get('layer') or not isinstance(route.get('page'), str): continue
        controller = next((device for device in setup['devices'] if isinstance(device, dict) and device.get('kind') == 'controller' and device.get('input') == route.get('source')), None)
        if not controller: continue
        key = re.sub(r'[^a-zA-Z0-9_-]+', '-', route['page']).strip('-').lower()[:32]
        if not key: continue
        keys = controller_layers(controller)
        if key in keys and controller.get('layer_types', {}).get(key) != 'direct': continue
        if key not in keys and len(keys) >= 8: continue
        controller['layers'] = list(dict.fromkeys([*keys, key]))
        controller.setdefault('layer_types', {})[key] = 'direct'
        route.update(controller=controller['id'], layer=key)
    return result


def validate_layer_routes(profile):
    from .banks import migrate, controller_layers
    setup = migrate(profile)
    controllers = {device['id']: device for device in setup['devices'] if device['kind'] == 'controller'}
    claimed = {}
    for bank in setup['banks']:
        device = controllers[bank['controller']]
        for control in bank['controls']:
            for layer, binding in control.items():
                if binding.get('source'):
                    source = binding['source']
                    claimed.setdefault((device.get('input'), source['channel'], source['cc']), []).append((device['id'], layer))
    for route in profile.get('routing', {}).get('cc', []):
        if 'layer' not in route: continue
        device = controllers.get(route['controller'])
        if not device or route['source'] != device.get('input') or route['layer'] not in controller_layers(device) or device.get('layer_types', {}).get(route['layer']) != 'direct':
            raise ValueError('Direct routes must belong to a direct layer on their source controller')
        key = route['source'], route['channel'], route['cc']
        for other, layer in claimed.get(key, []):
            if other != device['id'] or device.get('layer_mode') != 'software' or layer == route['layer']:
                raise ValueError('Direct control conflicts with another controller input')
        claimed.setdefault(key, []).append((device['id'], route['layer']))
        bindings = [dict(item, number=item['cc']) for item in setup['resets']]
        performance = profile.get('performance') or {}
        bindings += performance.get('actions', [])
        bindings += [performance['shift']] if performance.get('shift') else []
        bindings += [mod['trigger'] for mod in performance.get('mods', []) if mod.get('trigger')]
        if device.get('layer_switch'): bindings.append(dict(device['layer_switch'], controller=device['id']))
        for binding in bindings:
            owner = controllers.get(binding['controller'])
            if owner and owner.get('input') == route['source'] and binding.get('type', 'cc') == 'cc' and (binding['channel'], binding['number']) == (route['channel'], route['cc']):
                raise ValueError('Direct control conflicts with a button, action or layer switch')


class PortRouter:
    def __init__(self, routing):
        self.routing = validate_routing(routing)
        self.clock_ticks = 0
        self.last_tick = None
        self.forwarded = 0
        self.transport_counts = Counter()
        self.transport_events = deque(maxlen=16)
        self.max_tick_gap_ms = 0.
        # (source, channel, note) -> sent notes, so a note-off always releases what was
        # actually played, even if the rule changed or the rig was edited meanwhile.
        self.held_notes = {}
        # Live keyboard settings moved by MODs/knobs: {route id: {name: value}}.
        self.live = {}
        # Expression state: what the keyboard last sent, and what modulation last sent.
        self.incoming = {}
        self.expression_sent = {}

    def effective(self, route):
        live = self.live.get(route.get('id'))
        if not live: return route
        result = dict(route)
        if 'transpose' in live: result['transpose'] = round(live['transpose'])
        if 'channel' in live: result['out_channel'] = max(1, min(16, round(live['channel'])))
        if 'low' in live or 'high' in live:
            low, high = round(live.get('low', route.get('low', 0))), round(live.get('high', route.get('high', 127)))
            result['low'], result['high'] = min(low, high), max(low, high)
        if 'root' in live and route.get('scale'): result['scale'] = dict(route['scale'], root=round(live['root']) % 12)
        result['velocity_offset'] = round(live.get('velocity', 0))
        return result

    def handle_notes(self, source, message, outputs):
        kind = message.type
        if kind not in ('note_on', 'note_off', 'polytouch', 'aftertouch', 'pitchwheel', 'control_change'): return
        if kind == 'control_change' and message.control not in (1, 64): return
        channel = message.channel + 1
        notes = kind in ('note_on', 'note_off')
        releasing = kind == 'note_off' or (kind == 'note_on' and message.velocity == 0)
        for index, route in enumerate(self.routing['notes']):
            if route['source'] != source or route['channel'] != channel: continue
            route = self.effective(route)
            output = outputs.get(route['port'])
            if kind in ('note_on', 'note_off', 'polytouch'):
                key = (source, channel, message.note, index)
                if releasing:
                    sent = self.held_notes.pop(key, None)
                    if sent is None: continue
                    target_port, target_channel, target_note = sent
                    output = outputs.get(target_port)
                    if output is not None: output.send(type(message)('note_off', channel=target_channel - 1, note=target_note, velocity=0)); self.forwarded += 1
                    continue
                if not route.get('low', 0) <= message.note <= route.get('high', 127): continue
                out_note = map_note(route, message.note)
                if kind == 'note_on':
                    velocity = max(1, min(127, (route.get('fixed_velocity') or message.velocity) + route.get('velocity_offset', 0)))
                    previous = self.held_notes.pop(key, None)
                    if previous and (previous_output := outputs.get(previous[0])) is not None:
                        previous_output.send(type(message)('note_off', channel=previous[1] - 1, note=previous[2], velocity=0))
                    if output is not None and output.send(message.copy(channel=route['out_channel'] - 1, note=out_note, velocity=velocity)) is not False:
                        self.held_notes[key] = (route['port'], route['out_channel'], out_note); self.forwarded += 1
                elif output is not None and key in self.held_notes:
                    output.send(message.copy(channel=route['out_channel'] - 1, note=self.held_notes[key][2])); self.forwarded += 1
            elif route.get('passthrough', True) and output is not None:
                name = expression_name(message)
                live = self.live.get(route.get('id'), {})
                if name:
                    self.incoming[route.get('id') or index, name] = expression_raw(message)
                if name and name in live:
                    # A MOD or knob is adding to this control: send the sum.
                    value = expression_total(name, expression_raw(message), live[name])
                    output.send(expression_message(type(message), name, route['out_channel'] - 1, value))
                    self.expression_sent[route.get('id'), name] = (value, route['port'], route['out_channel'], 0)
                else:
                    output.send(message.copy(channel=route['out_channel'] - 1))
                self.forwarded += 1

    def emit_live(self, outputs, now):
        """Send pitch bend, aftertouch, mod wheel and sustain that a MOD or knob is driving.

        Called every engine tick: only changes are sent, at most 100 per second per
        setting, and the keyboard's own value is restored when modulation stops.
        """
        for route in self.routing.get('notes', ()):
            rid = route.get('id')
            if not rid: continue
            route = self.effective(route)
            output = outputs.get(route['port'])
            live = self.live.get(rid, {})
            for name in EXPRESSION:
                key = rid, name
                sent = self.expression_sent.get(key)
                incoming = self.incoming.get(key, 0) if route.get('passthrough', True) else 0
                if name in live:
                    value = expression_total(name, incoming, live[name])
                    if sent is not None and (value == sent[0] or abs(value - sent[0]) < (16 if name == 'bend' else 1) and name != 'sustain'): continue
                    if sent is not None and now - sent[3] < .01: continue
                elif sent is not None:
                    value = expression_total(name, incoming, 0) if route.get('passthrough', True) and key in self.incoming else (0)
                    self.expression_sent.pop(key)
                    if output is not None: output.send(expression_message(mido.Message, name, sent[2] - 1, value))
                    continue
                else: continue
                if output is not None:
                    output.send(expression_message(mido.Message, name, route['out_channel'] - 1, value)); self.forwarded += 1
                    self.expression_sent[key] = (value, route['port'], route['out_channel'], now)

    def release_all(self, outputs):
        """Release every note this router is holding (stop, panic, disconnect)."""
        sent, self.expression_sent = self.expression_sent, {}
        for (rid, name), (value, port, channel, *_) in sent.items():
            output = outputs.get(port)
            if output is not None:
                try: output.send(expression_message(mido.Message, name, channel - 1, 0))
                except Exception: pass
        held, self.held_notes = self.held_notes, {}
        for port, channel, note in held.values():
            output = outputs.get(port)
            if output is not None:
                try: output.send(mido.Message('note_off', channel=channel - 1, note=note, velocity=0))
                except Exception: pass

    def clock_status(self, now):
        return dict(ticks=self.clock_ticks, receiving=self.last_tick is not None and now - self.last_tick < 1,
                    forwarded=self.forwarded, max_tick_gap_ms=self.max_tick_gap_ms,
                    transport_counts=dict(self.transport_counts),
                    transport_events=[{**event, 'age_seconds': max(0., now - event['at'])}
                                      for event in self.transport_events])

    def handle(self, source, message, outputs, now, active_layers=None):
        clock = self.routing['clock']
        types = {'clock'} | ({'start', 'continue', 'stop', 'songpos'} if clock['transport'] else set())
        if source == clock['source']:
            if message.type == 'clock':
                if self.last_tick is not None:
                    self.max_tick_gap_ms = max(self.max_tick_gap_ms, (now - self.last_tick) * 1000)
                self.clock_ticks += 1
                self.last_tick = now
            elif message.type in ('start', 'continue', 'stop', 'songpos'):
                self.transport_counts[message.type] += 1
                event = dict(type=message.type, at=now, forwarded=clock['transport'])
                if message.type == 'songpos': event['position'] = message.pos
                self.transport_events.append(event)
            if message.type in types:
                # Clock/transport are ordered events, never coalesced as CC state.
                for destination in clock['destinations']:
                    output = outputs.get(destination)
                    if output is not None and output.send(message.copy()) is not False:
                        self.forwarded += 1
        if self.routing.get('notes'):
            self.handle_notes(source, message, outputs)
        if message.type == 'control_change':
            for route in self.routing['cc']:
                if route.get('controller') in (active_layers or {}) and active_layers[route['controller']] != route.get('layer'):
                    continue
                if (source, message.channel + 1, message.control) == (route['source'], route['channel'], route['cc']):
                    for target in route['destinations']:
                        output = outputs.get(target['port'])
                        value = 127 - message.value if target.get('invert', False) else message.value
                        value = round(target.get('min', 0) + value / 127 * (target.get('max', 127) - target.get('min', 0)))
                        if output is not None and output.send(message.copy(channel=target['channel'] - 1, control=target['cc'], value=value)) is not False:
                            self.forwarded += 1
