"""Controller layouts, destination maps, and independently assignable banks."""
import copy
import re
from .profile import ROWS, address, number, column_groups


MOD_PARAMETERS = {'depth': 0, 'mod_depth_2': 1, 'mod_depth_3': 2}
# How a mapping follows changes made on the destination device itself:
# off = ignore, track = update MIDIBRAIN's value (and controller feedback),
# link = also copy the change to the mapping's other channels/destinations.
DEVICE_SYNC = ('off', 'track', 'link')

def controller_input_name(port):
    return port.split(':', 1)[0] if port else 'MIDI input'

def with_trigger_controller(setup, profile):
    if not profile.get('controller_inputs_migrated') and not any(d['id'] == 'a4' for d in setup['devices']):
        setup['devices'].append(dict(id='a4', name=controller_input_name(profile['ports'].get('a4_input')), kind='controller',
            input=profile['ports'].get('a4_input'), feedback_output=None, controls_per_bank=1, layers=['normal']))
    if not profile.get('controller_inputs_migrated'):
        for device in setup['devices']:
            if device['id'] == 'a4' and not device.get('input'):
                device['input'] = profile['ports'].get('a4_input')
    for device in setup['devices']:
        if device['kind'] == 'controller' and device['name'] == 'Trigger source':
            device['name'] = controller_input_name(device.get('input'))
    return setup

def migrate(profile):
    if 'bank_setup' in profile:
        return with_trigger_controller(copy.deepcopy(profile['bank_setup']), profile)
    ports, twister = profile['ports'], profile['twister']
    devices = [dict(id='twister', name='MIDI Fighter Twister', kind='controller',
                    input=ports['twister_input'], feedback_output=ports['twister_output'],
                    controls_per_bank=4, alternate=True),
               dict(id='l6', name='Zoom L6', kind='destination', output=ports['l6_output'], initialize=True,
                    channels=[dict(id=ch['id'], name=f"Channel {ch['id']}",
                                   parameters={key: dict(value, label=key.title()) for key, value in ch['parameters'].items() if key != 'volume'},
                                   volume=dict(ch['parameters']['volume'], curve=copy.deepcopy(ch['volume_curve'])))
                              for ch in profile['channels']])]
    from .presets import enrich_l6
    enrich_l6(devices[1])
    banks = []
    groups = column_groups(twister['columns'], [ch['id'] for ch in profile['channels']])
    for column, group in enumerate(groups):
        controls = []
        for row, params in enumerate(ROWS):
            layers = {}
            for n, layer in enumerate(('normal', 'alternate')):
                index = row * 4 + column
                layers[layer] = dict(source=copy.deepcopy(twister[layer]['input'][index]),
                                     feedback=copy.deepcopy(twister[layer]['feedback'][index]), parameter=params[n])
            controls.append(layers)
        depths = {str(ch['id']): ch['depth'] for ch in profile['channels'] if ch['id'] in group}
        banks.append(dict(id=f'bank-{column+1}', name=f'Bank {column+1}', controller='twister',
                          destination='l6', channels=list(group), controls=controls,
                          depth=max(depths.values(), default=0), depth_overrides=depths))
    # Preserve ducking on destinations that weren't assigned to a controller column.
    unmapped = [ch for ch in profile['channels'] if ch['id'] not in sum(groups, []) and ch['depth']]
    if unmapped:
        bank = copy.deepcopy(banks[0]); bank.update(id='legacy-envelope', name='Envelope destinations', channels=[ch['id'] for ch in unmapped])
        bank['depth_overrides'] = {str(ch['id']): ch['depth'] for ch in unmapped}
        bank['depth'] = max(bank['depth_overrides'].values())
        for control in bank['controls']:
            for layer in control.values(): layer.update(source=None, feedback=None)
        banks.append(bank)
    resets = []
    for binding in twister.get('resets', []):
        scope = binding['scope']
        resets.append(dict(controller='twister', channel=binding['channel'], cc=binding['cc'],
                           bank=f"bank-{scope['column']}" if isinstance(scope, dict) else None,
                           channel_id=scope if type(scope) is int else None))
    return with_trigger_controller(dict(devices=devices, banks=banks, resets=resets), profile)


def controller_layers(device):
    if 'layers' not in device:
        if type(device.get('alternate')) is not bool: raise ValueError('Legacy alternate layer must be on or off')
        return ['normal', 'alternate'] if device['alternate'] else ['normal']
    layers = device['layers']
    if not isinstance(layers, list) or not 1 <= len(layers) <= 8:
        raise ValueError('Controllers need 1..8 layers')
    if any(not isinstance(k, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,32}', k) for k in layers) or len(set(layers)) != len(layers):
        raise ValueError('Layer keys must be distinct identifiers')
    return layers


def bank_layers(device):
    return [layer for layer in controller_layers(device) if device.get('layer_types', {}).get(layer, 'banked') == 'banked']


def bank_targets(bank, device):
    if device.get('channel_mode', 'fixed') == 'selectable':
        return [(cid, midi) for cid in bank['channels'] for midi in bank.get('midi_channels', [])]
    return list(bank['channels'])


def expanded_channels(setup):
    result = {}
    for device in setup['devices']:
        if device['kind'] != 'destination': continue
        if device.get('channel_mode', 'fixed') == 'fixed':
            result.update({(device['id'], ch['id']): copy.deepcopy(ch) for ch in device['channels']})
        else:
            templates = {ch['id']: ch for ch in device['channels']}
            for bank in setup['banks']:
                if bank['destination'] != device['id']: continue
                for tid, midi in bank_targets(bank, device):
                    ch = copy.deepcopy(templates[tid])
                    for param in ch['parameters'].values(): param['channel'] = midi
                    if ch.get('volume'): ch['volume']['channel'] = midi
                    result[device['id'], (tid, midi)] = ch
    for bank in setup['banks']:
        for control in bank['controls']:
            for binding in control.values():
                for send in binding.get('sends', []):
                    device = next(d for d in setup['devices'] if d['id'] == send['device'])
                    if device.get('channel_mode', 'fixed') != 'selectable': continue
                    ch = copy.deepcopy(next(c for c in device['channels'] if c['id'] == send['set']))
                    for param in ch['parameters'].values(): param['channel'] = send['midi_channel']
                    if ch.get('volume'): ch['volume']['channel'] = send['midi_channel']
                    result[device['id'], (send['set'], send['midi_channel'])] = ch
    return result


def validate_setup(setup, *, live=False):
    if not isinstance(setup, dict) or set(setup) != {'devices', 'banks', 'resets'}:
        raise ValueError('Bank setup needs devices, banks and resets')
    devices = setup['devices']
    if not isinstance(devices, list) or not 0 <= len(devices) <= 32:
        raise ValueError('Define 0..32 devices')
    by_id, inputs, outputs = {}, set(), set()
    def text(value, label):
        if not isinstance(value, str) or not value.strip() or len(value) > 512:
            raise ValueError(f'{label} must be nonempty text')
    def port(value, label, optional=False, owner=None):
        if value is None and (optional or not live): return
        if value is None or value == '':
            raise ValueError(f'{owner or label} needs a port: choose one for the {label.lower()}')
        text(value, label)
    for device in devices:
        if not isinstance(device, dict): raise ValueError('Invalid device')
        did = device.get('id'); text(did, 'Device id'); text(device.get('name'), 'Device name')
        if did in by_id or not re.fullmatch(r'[a-zA-Z0-9_-]+', did): raise ValueError('Use distinct device ids containing letters, numbers, - or _')
        by_id[did] = device
        if device.get('kind') == 'controller':
            port(device.get('input'), 'Controller input', owner=f'“{device.get("name")}”')
            port(device.get('feedback_output'), 'Feedback output', optional=True)
            number(device.get('controls_per_bank'), 1, 64, 'Controls per bank', True)
            controller_layers(device)
            types = device.get('layer_types', {})
            if not isinstance(types, dict) or any(layer not in controller_layers(device) or kind not in ('banked', 'direct') for layer, kind in types.items()):
                raise ValueError('Layer routing must choose banked or direct for an existing layer')
            if device.get('layer_mode', 'hardware') not in ('hardware', 'software'):
                raise ValueError('Layer mode must be hardware or software')
            if device.get('initial_layer', controller_layers(device)[0]) not in controller_layers(device):
                raise ValueError('Choose an existing initial layer')
            switch = device.get('layer_switch')
            if switch is not None:
                if not isinstance(switch, dict) or set(switch) != {'type', 'channel', 'number', 'mode'}:
                    raise ValueError('Layer switch needs type, channel, number and mode')
                if switch['type'] not in ('cc', 'note') or switch['mode'] not in ('cycle', 'momentary', 'value'):
                    raise ValueError('Choose a CC/note layer switch and cycle, momentary or value mode')
                if switch['mode'] == 'value' and switch['type'] != 'cc':
                    raise ValueError('Value-selected layers require CC input')
                number(switch['channel'], 1, 16, 'Layer switch channel', True)
                number(switch['number'], 0, 119 if switch['type'] == 'cc' else 127, 'Layer switch number', True)
            pages = device.get('pages', ['Page 1'])
            if not isinstance(pages, list) or not 1 <= len(pages) <= 32 or any(not isinstance(p, str) or not p.strip() or len(p) > 80 for p in pages) or len(set(pages)) != len(pages): raise ValueError('Define 1..32 distinct controller page names')
        elif device.get('kind') == 'destination':
            port(device.get('output'), 'Destination output', owner=f'“{device.get("name")}”')
            # Optional: the port this device transmits its own changes on (two-way sync).
            port(device.get('input'), 'Destination input', optional=True)
            if type(device.get('initialize', False)) is not bool: raise ValueError('Startup reset must be on or off')
            mode = device.get('channel_mode', 'fixed')
            if mode not in ('fixed', 'selectable'): raise ValueError('Channel mode must be fixed or selectable')
            channels = device.get('channels')
            if not isinstance(channels, list) or not 1 <= len(channels) <= 16: raise ValueError('Destination needs 1..16 logical channels')
            ids = set()
            for ch in channels:
                if not isinstance(ch, dict): raise ValueError('Invalid destination channel')
                cid = number(ch.get('id'), 1, 16, 'Destination channel id', True)
                if cid in ids: raise ValueError('Duplicate destination channel id')
                ids.add(cid); text(ch.get('name'), 'Channel name')
                if not isinstance(ch.get('parameters'), dict) or not 1 <= len(ch['parameters']) <= 5000: raise ValueError('Define 1..5000 named parameters per channel')
                for key, param in ch['parameters'].items():
                    text(key, 'Parameter key')
                    if not isinstance(param, dict): raise ValueError('Invalid parameter definition')
                    text(param.get('label'), 'Parameter label')
                    if key in MOD_PARAMETERS: raise ValueError('Parameter name is reserved for a bank MOD amount')
                    for flag in ('include_snapshot', 'include_reset', 'continuous'):
                        if flag in param and type(param[flag]) is not bool: raise ValueError(f'{flag} must be on/off')
                    addr = address(param, 'Destination parameter')
                    minimum = number(param.get('min', 0), 0, 127, 'Minimum value', True)
                    maximum = number(param.get('max', 127), minimum, 127, 'Maximum value', True)
                    if param.get('reset') is not None: number(param['reset'], minimum, maximum, 'Reset value', True)
                    target = ((device.get('output') or did, *addr) if mode == 'fixed' else (did, cid, addr[1]))
                    if target in outputs and not param.get('alias'): raise ValueError('Destination parameters must use distinct output/channel/CC addresses')
                    outputs.add(target)
                volume = ch.get('volume')
                if volume is not None:
                    addr = address(volume, 'Volume parameter'); target = ((device.get('output') or did, *addr) if mode == 'fixed' else (did, cid, addr[1]))
                    if target in outputs: raise ValueError('Volume must have a separate CC address')
                    outputs.add(target)
                    curve = volume.get('curve')
                    if not isinstance(curve, list) or len(curve) < 2: raise ValueError('Volume needs an attenuation curve')
                    prev_x, prev_y = -1, 128
                    for point in curve:
                        if not isinstance(point, list) or len(point) != 2: raise ValueError('Curve points are [attenuation, value]')
                        x = number(point[0], 0, 1, 'Attenuation'); y = number(point[1], 0, 127, 'Volume CC value', True)
                        if x <= prev_x or y > prev_y: raise ValueError('Volume curve must increase in attenuation and decrease in CC value')
                        prev_x, prev_y = x, y
                    if curve[0][0] != 0 or curve[-1][0] != 1: raise ValueError('Volume curve must cover 0..1')
        else: raise ValueError('Device kind must be controller or destination')
    banks = setup['banks']
    if not isinstance(banks, list) or len(banks) > 32: raise ValueError('Up to 32 banks are supported')
    bank_ids, feedback = set(), set()
    layered_addresses = {'source': {}, 'feedback': {}}
    for bank in banks:
        if not isinstance(bank, dict): raise ValueError('Invalid bank definition')
        text(bank.get('id'), 'Bank id'); text(bank.get('name'), 'Bank name')
        if bank['id'] in bank_ids: raise ValueError('Duplicate bank id')
        bank_ids.add(bank['id'])
        text(bank.get('controller'), 'Bank controller'); text(bank.get('destination'), 'Bank destination')
        controller, destination = by_id.get(bank.get('controller')), by_id.get(bank.get('destination'))
        if not controller or controller['kind'] != 'controller' or not destination or destination['kind'] != 'destination': raise ValueError('Select a controller and destination for every bank')
        if controller.get('input') and controller.get('input') == destination.get('output'): raise ValueError('A bank cannot route back to its own input port')
        channels = {ch['id']: ch for ch in destination['channels']}
        targets = bank.get('channels')
        if not isinstance(targets, list) or any(type(cid) is not int or cid not in channels for cid in targets) or len(set(targets)) != len(targets): raise ValueError('Bank targets must be distinct destination channels')
        if destination.get('channel_mode', 'fixed') == 'selectable':
            midi = bank.get('midi_channels')
            if not isinstance(midi, list) or not midi or any(type(ch) is not int or not 1 <= ch <= 16 for ch in midi) or len(set(midi)) != len(midi): raise ValueError('Choose distinct MIDI channels 1..16 for the bank')
        for flag in ('depth_include_snapshot', 'depth_include_reset'):
            if flag in bank and type(bank[flag]) is not bool: raise ValueError(f'{flag} must be on/off')
        number(bank.get('depth'), 0, 1, 'Bank depth')
        if 'mod_depths' in bank:
            if not isinstance(bank['mod_depths'], list) or not 3 <= len(bank['mod_depths']) <= 16: raise ValueError('Use 3..16 bank MOD amounts')
            for depth in bank['mod_depths']: number(depth, 0, 1, 'Bank MOD amount')
        overrides = bank.get('depth_overrides', {})
        if not isinstance(overrides, dict) or any(key not in [str(cid) for cid in targets] for key in overrides): raise ValueError('Legacy depths must belong to bank targets')
        for value in overrides.values(): number(value, 0, 1, 'Legacy depth')
        controls = bank.get('controls')
        if not isinstance(controls, list) or len(controls) != controller['controls_per_bank']: raise ValueError('Bank control count must match its controller definition')
        layers = set(bank_layers(controller))
        if not layers: raise ValueError('A controller with strips needs at least one banked layer')
        for control in controls:
            if not isinstance(control, dict) or set(control) != layers: raise ValueError('Bank layers must match its controller definition')
            for layer, binding in control.items():
                if not isinstance(binding, dict): raise ValueError('Invalid bank binding')
                if 'label' in binding and (not isinstance(binding['label'], str) or len(binding['label']) > 80): raise ValueError('Slot name must be text up to 80 characters')
                if 'page' in binding and binding['page'] not in controller.get('pages', ['Page 1']): raise ValueError('Mapping refers to an unknown controller page')
                for field, used, port_key in [('source', inputs, 'input'), ('feedback', feedback, 'feedback_output')]:
                    if binding.get(field) is not None:
                        addr = address(binding[field], field)
                        key = (controller.get(port_key) or controller['id'], *addr)
                        scopes = layered_addresses[field].setdefault(key, set())
                        scope = (controller['id'], layer) if controller.get('layer_mode') == 'software' else None
                        if scopes and (scope is None or None in scopes or scope in scopes or any(item[0] != controller['id'] for item in scopes)):
                            raise ValueError(f'Duplicate controller {field} channel/CC; assign a different input to the copied bank')
                        scopes.add(scope)
                        used.add(key)
                if not isinstance(binding.get('sends', []), list): raise ValueError('Additional destinations must be a list')
                for ranged in [binding, *binding.get('sends', [])]:
                    if not isinstance(ranged, dict): raise ValueError('Invalid mapping destination')
                    lo = number(ranged.get('min', 0), 0, 127, 'Mapping minimum CC', True)
                    number(ranged.get('max', 127), lo, 127, 'Mapping maximum CC', True)
                    if type(ranged.get('invert', False)) is not bool: raise ValueError('Invert must be on/off')
                sends = binding.get('sends', [])
                if not isinstance(sends, list) or len(sends) > 32: raise ValueError('Use up to 32 additional destinations per control')
                seen_sends = set()
                for send in sends:
                    if not isinstance(send, dict): raise ValueError('Invalid additional destination')
                    dest = by_id.get(send.get('device'))
                    if not dest or dest['kind'] != 'destination': raise ValueError('Additional destination device is missing')
                    if controller.get('input') and controller['input'] == dest.get('output'): raise ValueError('A control cannot route back to its own input')
                    sid = number(send.get('set'), 1, 16, 'Destination parameter set', True)
                    ch = next((c for c in dest['channels'] if c['id'] == sid), None)
                    if ch is None or send.get('parameter') not in ch['parameters']: raise ValueError('Choose a parameter for each additional destination')
                    midi = number(send.get('midi_channel'), 1, 16, 'Additional destination MIDI channel', True)
                    addr = ch['parameters'][send['parameter']]
                    target = (dest.get('output') or dest['id'], midi if dest.get('channel_mode') == 'selectable' else addr['channel'], addr['cc'])
                    if target in seen_sends: raise ValueError('Duplicate additional destination address')
                    if max(addr.get('min', 0), send.get('min', 0)) > min(addr.get('max', 127), send.get('max', 127)): raise ValueError('Destination range does not overlap device range')
                    seen_sends.add(target)
                links = binding.get('note_links', [])
                if not isinstance(links, list) or len(links) > 16: raise ValueError('Use up to 16 keyboard settings per control')
                from .features import NOTE_PARAMS
                seen_links = set()
                for link in links:
                    if not isinstance(link, dict) or set(link) != {'route', 'parameter'} or not isinstance(link['route'], str) or not 1 <= len(link['route']) <= 32 or link['parameter'] not in NOTE_PARAMS:
                        raise ValueError('Invalid keyboard setting link')
                    if (link['route'], link['parameter']) in seen_links: raise ValueError('Duplicate keyboard setting link')
                    seen_links.add((link['route'], link['parameter']))
                if binding.get('device_sync', 'off') not in DEVICE_SYNC: raise ValueError('Device sync must be off, track or link')
                if binding.get('feedback_from') is not None: number(binding['feedback_from'], 1, 16, 'Feedback channel', True)
                param = binding.get('parameter')
                if param is not None and not isinstance(param, str): raise ValueError('Parameter must be a key or null')
                if param is not None and param not in MOD_PARAMETERS and any(param not in channels[cid]['parameters'] for cid in targets): raise ValueError(f'Parameter {param!r} is missing from a selected destination channel')
                if param is not None and param not in MOD_PARAMETERS:
                    for cid in targets:
                        p = channels[cid]['parameters'][param]
                        if max(p.get('min', 0), binding.get('min', 0)) > min(p.get('max', 127), binding.get('max', 127)): raise ValueError('Mapping range does not overlap device range')
        if bank['depth'] or any(overrides.values()):
            if any(channels[cid].get('volume') is None for cid in targets): raise ValueError('Sidechain needs a volume mapping for every bank destination')
    if not isinstance(setup['resets'], list) or len(setup['resets']) > 128: raise ValueError('Invalid reset bindings')
    for reset in setup['resets']:
        if not isinstance(reset, dict): raise ValueError('Invalid reset binding')
        text(reset.get('controller'), 'Reset controller')
        controller = by_id.get(reset.get('controller'))
        if not controller or controller['kind'] != 'controller': raise ValueError('Reset controller is missing')
        if 'page' in reset and reset['page'] not in controller.get('pages', ['Page 1']): raise ValueError('Action refers to an unknown controller page')
        addr = address(reset, 'Reset'); key = (controller.get('input') or controller['id'], *addr)
        if key in inputs: raise ValueError('Reset conflicts with a controller input')
        inputs.add(key)
        if reset.get('bank') is not None and reset['bank'] not in bank_ids: raise ValueError('Reset refers to a removed bank')
        if reset.get('channel_id') is not None: number(reset['channel_id'], 1, 16, 'Reset channel id', True)
        action = reset.get('action', 'reset')
        if action not in ('reset', 'depth', 'release', 'panic'): raise ValueError('Unknown MIDIBRAIN action')
        if action == 'depth':
            bank = next((b for b in banks if b['id'] == reset.get('bank')), None)
            if bank is None: raise ValueError('Choose a bank for the MOD 1 amount')
            device = by_id[bank['destination']]
            if any(c.get('volume') is None for c in device['channels'] if c['id'] in bank['channels']):
                raise ValueError('Bank depth action requires volume mappings')
        if action == 'release':
            lo = number(reset.get('min_ms', 0), 0, 10000, 'Minimum release')
            number(reset.get('max_ms', 2000), lo, 10000, 'Maximum release')
        if action != 'reset' and reset.get('channel_id') is not None: raise ValueError('Logical channel scope is only valid for reset')

    for controller in devices:
        switch = controller.get('layer_switch') if controller.get('layer_mode') == 'software' else None
        if switch and switch['type'] == 'cc':
            key = (controller.get('input') or controller['id'], switch['channel'], switch['number'])
            if key in inputs: raise ValueError('Layer switch conflicts with a controller input or reset')
            inputs.add(key)

    addresses = {}
    policies = {}
    for (did, cid), ch in expanded_channels(setup).items():
        for param in [*ch['parameters'].values(), *([ch['volume']] if ch.get('volume') else [])]:
            key = (by_id[did].get('output') or did, param['channel'], param['cc'])
            if key in addresses and not (addresses[key] == (did, cid) and param.get('alias')): raise ValueError('Selected templates overlap on an output MIDI channel/CC')
            addresses[key] = (did, cid)
            policy = (param.get('include_snapshot', True), param.get('include_reset', True), param.get('continuous', False), param.get('min', 0), param.get('max', 127))
            if key in policies and policies[key] != policy: raise ValueError('Aliases sharing an address must have identical inclusion, Continuous and range settings')
            policies[key] = policy
    return copy.deepcopy(setup)
