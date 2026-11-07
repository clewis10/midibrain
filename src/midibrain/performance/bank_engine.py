"""Bank-driven CC and envelope processing, sharing the proven note envelope."""
import copy
from .engine import CC, MixerEngine
from .banks import validate_setup, bank_targets, expanded_channels, migrate, controller_layers, MOD_PARAMETERS
from .profile import number


class BankEngine(MixerEngine):
    def __init__(self, profile, send):
        super().__init__(profile, send)
        self.setup = validate_setup(migrate(profile))
        self.profile['controller_inputs_migrated'] = True
        self.devices = {d['id']: d for d in self.setup['devices']}
        self.banks = {b['id']: b for b in self.setup['banks']}
        self.destinations = expanded_channels(self.setup)
        self.bank_values = {(did, cid, key): None for (did, cid), ch in self.destinations.items() for key, param in ch['parameters'].items()}
        self.bank_bindings = {}
        self.active_layers = {device['id']: device.get('initial_layer', controller_layers(device)[0])
                              for device in self.devices.values() if device['kind'] == 'controller' and device.get('layer_mode') == 'software'}
        self.layer_pressed = {}
        self.direct_routes = {index: route for index, route in enumerate(self.profile.get('routing', {}).get('cc', [])) if 'layer' in route}
        self.direct_values = {}
        for bank in self.banks.values():
            for control in bank['controls']:
                for layer, binding in control.items():
                    if binding.get('source'):
                        addr = binding['source']
                        self.bank_bindings.setdefault((bank['controller'], addr['channel'], addr['cc']), []).append((bank, layer, binding))
        from .features import Performance, parameters
        self.parameter_map = parameters(self.setup)
        self.alias_refs = {}
        for ref, (_, signature) in self.parameter_map.items():
            self.alias_refs.setdefault(tuple(signature[:3]), []).append(ref)
        self.features = Performance(self)
        self.bank_resets = {(r['controller'], r['channel'], r['cc']): r for r in self.setup['resets']}
        # Two-way sync: (device, MIDI channel, CC) arriving on a destination's own
        # input -> the mappings that opted in. Built once; never in the tick path.
        self.device_sync = {}
        for bank in self.banks.values():
            for control in bank['controls']:
                for layer, binding in control.items():
                    mode = binding.get('device_sync', 'off')
                    if mode == 'off': continue
                    param = binding.get('parameter')
                    refs = []
                    if param and param not in MOD_PARAMETERS:
                        refs.extend(((bank['destination'], cid, param), binding) for cid in self.targets(bank))
                    for send in binding.get('sends', []):
                        cid = (send['set'], send['midi_channel']) if self.devices[send['device']].get('channel_mode') == 'selectable' else send['set']
                        refs.append(((send['device'], cid, send['parameter']), send))
                    for ref, mapping in refs:
                        if not self.devices[ref[0]].get('input'): continue
                        p, _ = self.parameter_info(ref)
                        self.device_sync.setdefault((ref[0], p['channel'], p['cc']), []).append((ref, bank, layer, binding, mapping, mode))
        self.device_sync_sources = {key[0] for key in self.device_sync}

    def targets(self, bank):
        return bank_targets(bank, self.devices[bank['destination']])

    def layer_active(self, controller, layer):
        return controller not in self.active_layers or self.active_layers[controller] == layer

    def set_direct_control(self, index, value):
        number(value, 0, 127, 'Control value', True)
        route = self.direct_routes.get(index)
        if route is None: raise ValueError('Unknown direct control')
        if not self.layer_active(route['controller'], route['layer']): raise ValueError('Direct control layer is inactive')
        self.direct_values[index] = value
        for target in route['destinations']:
            output = 127 - value if target.get('invert', False) else value
            output = round(target.get('min', 0) + output / 127 * (target.get('max', 127) - target.get('min', 0)))
            self.send(CC(target['port'], target['channel'], target['cc'], output))

    def select_layer(self, controller, layer):
        if controller not in self.active_layers: raise ValueError('Controller does not use software layers')
        if layer not in controller_layers(self.devices[controller]): raise ValueError('Unknown layer')
        if self.active_layers[controller] == layer: return
        self.active_layers[controller] = layer
        for bank in self.banks.values():
            if bank['controller'] == controller: self._bank_feedback(bank)

    def release_layer_switch(self, controller):
        previous = self.layer_pressed.pop(controller, None)
        device = self.devices.get(controller, {})
        if previous is not None and device.get('layer_switch', {}).get('mode') == 'momentary':
            self.select_layer(controller, previous)

    def handle_layer_switch(self, controller, event):
        device = self.devices.get(controller, {})
        switch = device.get('layer_switch') if controller in self.active_layers else None
        if not switch: return False
        kind = 'cc' if event.type == 'control_change' else 'note' if event.type in ('note_on', 'note_off') else None
        number_ = event.control if kind == 'cc' else event.note
        if (kind, event.channel, number_) != (switch['type'], switch['channel'], switch['number']): return False
        value = event.value if kind == 'cc' else event.velocity if event.type == 'note_on' else 0
        layers = controller_layers(device)
        if switch['mode'] == 'value':
            self.select_layer(controller, layers[min(len(layers) - 1, value * len(layers) // 128)])
        elif value and controller not in self.layer_pressed:
            previous = self.active_layers[controller]
            self.layer_pressed[controller] = previous
            self.select_layer(controller, layers[(layers.index(previous) + 1) % len(layers)])
        elif not value:
            self.release_layer_switch(controller)
        return True

    def feedback_target(self, bank, binding):
        """The strip channel whose value a control displays (first unless chosen)."""
        targets = self.targets(bank)
        chosen = binding.get('feedback_from')
        if chosen is not None:
            for cid in targets:
                if (cid[0] if isinstance(cid, tuple) else cid) == chosen: return cid
        return targets[0] if targets else None

    def _bank_feedback(self, bank):
        device = self.devices[bank['controller']]
        if not device.get('feedback_output'): return
        for control in bank['controls']:
            for layer, binding in control.items():
                if not self.layer_active(bank['controller'], layer): continue
                param = binding.get('parameter')
                if binding.get('feedback') and param:
                    shown = self.feedback_target(bank, binding)
                    shown_id = shown[0] if isinstance(shown, tuple) else shown
                    value = (bank.get('depth_overrides', {}).get(str(shown_id), bank['depth']) * 127 if param == 'depth' and bank['channels'] else
                             self.bank_mod_depth(bank, MOD_PARAMETERS[param]) * 127 if param in MOD_PARAMETERS else
                             self.bank_values[bank['destination'], shown, param] if shown is not None else 0)
                    if value is None: continue
                    if param in MOD_PARAMETERS:
                        minimum, maximum = binding.get('min', 0), binding.get('max', 127)
                        value = (value - minimum) * 127 / (maximum - minimum) if maximum > minimum else 0
                        if binding.get('invert', False): value = 127 - value
                    elif shown is not None:
                        target = self.destinations[bank['destination'], shown]['parameters'][param]
                        minimum = max(target.get('min', 0), binding.get('min', target.get('min', 0)))
                        maximum = min(target.get('max', 127), binding.get('max', target.get('max', 127)))
                        value = (value - minimum) * 127 / (maximum - minimum) if maximum > minimum else 0
                        if binding.get('invert', False): value = 127 - value
                    self._emit('feedback:' + device['id'], binding['feedback'], value)

    def parameter_info(self, ref):
        return self.parameter_map[ref]

    def set_base(self, ref, value, *, force=False):
        _, signature = self.parameter_info(ref)
        for other in self.alias_refs[tuple(signature[:3])]:
            self.bank_values[other] = value
        self.emit_base(ref, force=force)

    def emit_base(self, ref, *, force=False, routes_by_address=None):
        value = self.bank_values[ref]
        if value is None: return
        param, _ = self.parameter_info(ref)
        self._emit(ref[0], param, self.features.output(ref, value, routes_by_address=routes_by_address), force=force)

    def refresh_feedback(self):
        for bank in self.banks.values(): self._bank_feedback(bank)

    def bank_refs(self, bank):
        refs = {(bank['destination'], cid, key) for cid in self.targets(bank)
                for key in self.destinations[bank['destination'], cid]['parameters']}
        for control in bank['controls']:
            for binding in control.values():
                for send in binding.get('sends', []):
                    cid = (send['set'], send['midi_channel']) if self.devices[send['device']].get('channel_mode') == 'selectable' else send['set']
                    refs.add((send['device'], cid, send['parameter']))
        return refs

    def initialize(self, now):
        self.last_time = now
        self.panic(now)
        for source in self.features.sources:
            source.start = source.last_sample = now
        for ref in self.bank_values:
            param, _ = self.parameter_info(ref)
            if self.devices[ref[0]].get('initialize', False) and param.get('reset') is not None:
                self.set_base(ref, param['reset'], force=True)
        self.refresh_feedback()

    def reset_refs(self, refs):
        seen = set()
        for ref in refs:
            param, signature = self.parameter_info(ref)
            addr = tuple(signature[:3])
            if addr in seen or param.get('reset') is None or not param.get('include_reset', True): continue
            seen.add(addr)
            self.set_base(ref, param['reset'], force=True)

    def reset_mixer(self, cid=None):
        self.reset_refs(ref for ref in self.bank_values if cid is None or ref[1] == cid)
        for bank in self.banks.values():
            if cid is None and bank.get('depth_include_reset', False):
                for i in range(len(self.features.sources)): self.set_bank_mod_depth(bank['id'], i, 0.)
        self.refresh_feedback()

    def reset_bank(self, bid):
        bank = self.banks.get(bid)
        if bank is None: raise ValueError('Unknown bank')
        self.reset_refs(self.bank_refs(bank))
        if bank.get('depth_include_reset', False):
            for i in range(len(self.features.sources)): self.set_bank_mod_depth(bid, i, 0.)
        self.refresh_feedback()

    def reset_layer(self, controller, layer):
        """Reset every parameter mapped by one controller layer (all of its strips)."""
        refs = set()
        for bank in self.banks.values():
            if bank['controller'] != controller: continue
            for control in bank['controls']:
                binding = control.get(layer)
                if not binding: continue
                param = binding.get('parameter')
                if param and param not in MOD_PARAMETERS:
                    refs.update((bank['destination'], cid, param) for cid in self.targets(bank))
                for send in binding.get('sends', []):
                    cid = (send['set'], send['midi_channel']) if self.devices[send['device']].get('channel_mode') == 'selectable' else send['set']
                    refs.add((send['device'], cid, send['parameter']))
        self.reset_refs(sorted(refs, key=repr))
        self.refresh_feedback()

    def set_bank_depth(self, bid, depth):
        number(depth, 0, 1, 'Bank depth')
        bank = self.banks.get(bid)
        if bank is None: raise ValueError('Unknown bank')
        if depth and any(self.destinations[bank['destination'], cid].get('volume') is None for cid in self.targets(bank)):
            raise ValueError('Define volume CCs for this bank before enabling sidechain')
        bank['depth'] = depth
        bank['depth_overrides'] = {}
        self._bank_feedback(bank)

    def destination_depth(self, did, cid):
        return max((bank.get('depth_overrides', {}).get(str(cid[0] if isinstance(cid, tuple) else cid), bank['depth']) for bank in self.banks.values()
                    if bank['destination'] == did and cid in self.targets(bank)), default=0)

    def handle(self, source, event, now):
        if source in self.device_sync_sources:
            # A destination reporting its own change: never an action or panic.
            if event.type == 'control_change': self.device_change(source, event, now)
            return
        if self.handle_layer_switch(source, event): return
        if event.type == 'control_change':
            for index, route in self.direct_routes.items():
                if (source, event.channel, event.control) == (route['controller'], route['channel'], route['cc']) and self.layer_active(source, route['layer']):
                    self.direct_values[index] = event.value
        handled = self.features.handle(source, event, now)
        if event.type in ('stop', 'reset') or (event.type == 'control_change' and event.control in (120, 123)):
            self.panic(now)
        self.tick(now)
        if handled: return
        if event.type != 'control_change': return
        key = source, event.channel, event.control
        if key in self.bank_resets:
            reset = self.bank_resets[key]
            action = reset.get('action', 'reset')
            if action == 'depth':
                self.set_bank_depth(reset['bank'], event.value / 127)
                return
            if action == 'release':
                low, high = reset.get('min_ms', 0), reset.get('max_ms', 2000)
                self.set_release(low + event.value / 127 * (high - low), now)
                return
            if event.value and key not in self.reset_pressed:
                if action == 'panic': self.panic(now)
                elif reset.get('bank'): self.reset_bank(reset['bank'])
                else: self.reset_mixer(reset.get('channel_id'))
                self.reset_pressed.add(key)
            elif not event.value: self.reset_pressed.discard(key)
            return
        if key not in self.bank_bindings: return
        for bank, layer, binding in self.bank_bindings[key]:
            if self.layer_active(source, layer): self.apply_control(bank, binding, event.value)

    def modulated_addresses(self):
        """Output addresses an enabled MOD currently moves (nonzero route amount)."""
        from .features import ref_key
        addresses = set()
        for source in self.features.sources:
            if not source.config['enabled'] or not source.effective_amount(): continue
            for route in self.features.routes(source):
                if route['amount']:
                    addresses.add(tuple(self.parameter_info(ref_key(route['ref']))[1][:3]))
        return addresses

    def device_change(self, did, event, now):
        """Fold a change made on the device itself into MIDIBRAIN's state.

        Opt-in per mapping (device_sync). A value equal to the last one MIDIBRAIN
        sent there is an echo and is ignored; MOD-modulated parameters are skipped
        because the device would report the modulated output, not the base value.
        Nothing is sent back to the address the device just reported.
        """
        entries = self.device_sync.get((did, event.channel, event.control))
        if not entries: return False
        address = (did, event.channel, event.control)
        if self.last_output.get(address) == event.value: return False
        modulated = self.modulated_addresses()
        changed = set()
        for ref, bank, layer, binding, mapping, mode in entries:
            if not self.layer_active(bank['controller'], layer): continue
            p, signature = self.parameter_info(ref)
            if tuple(signature[:3]) in modulated: continue
            value = max(p.get('min', 0), min(p.get('max', 127), event.value))
            # The device is physically at this value now; dedup must know it, and
            # an older value still queued for that address must not overwrite it.
            self.last_output[address] = value
            self.send(CC(*address, None))
            for other in self.alias_refs[tuple(signature[:3])]:
                self.bank_values[other] = value
            changed.add(bank['id'])
            if mode != 'link': continue
            target = p
            lo = max(target.get('min', 0), mapping.get('min', target.get('min', 0)))
            hi = min(target.get('max', 127), mapping.get('max', target.get('max', 127)))
            position = (value - lo) * 127 / (hi - lo) if hi > lo else 0
            if mapping.get('invert', False): position = 127 - position
            position = max(0, min(127, round(position)))
            param = binding.get('parameter')
            if param and param not in MOD_PARAMETERS:
                for cid in self.targets(bank):
                    other = (bank['destination'], cid, param)
                    if other == ref: continue
                    self.set_base(other, self.mapped_value(self.destinations[other[0], cid]['parameters'][param], binding, position))
            for send in binding.get('sends', []):
                cid = (send['set'], send['midi_channel']) if self.devices[send['device']].get('channel_mode') == 'selectable' else send['set']
                other = (send['device'], cid, send['parameter'])
                if other == ref: continue
                self.set_base(other, self.mapped_value(self.destinations[send['device'], cid]['parameters'][send['parameter']], send, position))
        if changed:
            for bank in self.banks.values(): self._bank_feedback(bank)
        return bool(changed)

    def control_identity(self, bank, index, layer):
        return dict(controller=bank['controller'], destination=bank['destination'], channels=copy.deepcopy(bank['channels']),
                    midi_channels=copy.deepcopy(bank.get('midi_channels')), binding=copy.deepcopy(bank['controls'][index][layer]))

    def set_control(self, bank_id, index, layer, value, expected=None):
        number(value, 0, 127, 'Control value', True)
        if not isinstance(bank_id, str) or bank_id not in self.banks: raise ValueError('Unknown bank')
        bank = self.banks[bank_id]
        number(index, 0, len(bank['controls']) - 1, 'Control index', True)
        if not isinstance(layer, str) or layer not in bank['controls'][index]: raise ValueError('Unknown control input')
        if not self.layer_active(bank['controller'], layer): raise ValueError('Layer is inactive; select it before performing')
        binding = bank['controls'][index][layer]
        if expected is not None and expected != self.control_identity(bank, index, layer): raise ValueError('Mapping changed; refresh the page')
        reads = self.features.operator_reads(bank['controller'], binding.get('source'))
        if not binding.get('parameter') and not binding.get('sends') and not binding.get('note_links') and not reads: raise ValueError('Control has no destination')
        self.apply_control(bank, binding, value)
        # A virtual knob stands in for the physical one: operators that read this CC see it too.
        if reads: self.features.cc_values[bank['controller'], binding['source']['channel'], binding['source']['cc']] = value

    def apply_control(self, bank, binding, value):
        param = binding.get('parameter')
        for link in binding.get('note_links', ()):
            from .features import NOTE_PARAMS
            low, high, _ = NOTE_PARAMS[link['parameter']]
            self.features.note_knobs[link['route'], link['parameter']] = low + value / 127 * (high - low)
        if param in MOD_PARAMETERS: self.set_bank_mod_depth(bank['id'], MOD_PARAMETERS[param], self.mapped_value({}, binding, value) / 127)
        elif param:
            for cid in self.targets(bank):
                target = self.destinations[bank['destination'], cid]['parameters'][param]
                mapped = self.mapped_value(target, binding, value)
                self.set_base((bank['destination'], cid, param), mapped)
        for send in binding.get('sends', []):
            did = send['device']
            cid = (send['set'], send['midi_channel']) if self.devices[did].get('channel_mode') == 'selectable' else send['set']
            target = self.destinations[did, cid]['parameters'][send['parameter']]
            mapped = self.mapped_value(target, send, value)
            self.set_base((did, cid, send['parameter']), mapped)
        if param not in MOD_PARAMETERS or binding.get('sends'):
            for other in self.banks.values(): self._bank_feedback(other)

    @staticmethod
    def mapped_value(target, mapping, value):
        lo = max(target.get('min', 0), mapping.get('min', target.get('min', 0)))
        hi = min(target.get('max', 127), mapping.get('max', target.get('max', 127)))
        if hi < lo: raise ValueError('Mapping range does not overlap device range')
        value = 127 - value if mapping.get('invert', False) else value
        return round(lo + value / 127 * (hi - lo))

    def tick(self, now):
        if now < self.last_time: raise ValueError('Engine time must be monotonic')
        self.last_time = now
        self.features.tick(now)
        source = self.features.sources[0] if self.features.sources else None
        # Compatibility status for the original bank depth and note diagnostics.
        self.notes = source.gates if source else {}
        self.envelope = self.features.values[0] if source and source.config['playback'] == 'gate' else 0.
        self.expired_notes = source.expired_notes if source else 0
        for (did, cid), ch in self.destinations.items():
            if ch.get('volume'):
                value = self.features.volume_value(did, cid, ch['volume']['curve'])
                self._emit(did, ch['volume'], value)

    def bank_mod_depth(self, bank, index):
        if index == 0: return bank['depth']
        depths = bank.get('mod_depths', [0., 0., 0.])
        return depths[index] if index < len(depths) else 0.

    def set_bank_mod_depth(self, bid, index, depth):
        from .features import MAX_MODS
        number(index, 0, MAX_MODS - 1, 'MOD slot', True)
        number(depth, 0, 1, 'Bank MOD amount')
        if bid not in self.banks: raise ValueError('Unknown bank')
        if index == 0:
            # MOD 1 retains existing encoder/side-button mappings.
            bank = self.banks[bid]
            bank['depth'] = depth; bank['depth_overrides'] = {}
            self.refresh_feedback()
        else:
            bank = self.banks[bid]
            depths = bank.setdefault('mod_depths', [bank['depth'], 0., 0.])
            if index >= len(depths):
                # Absent amounts are zero; resetting them must not change saved structure.
                if not depth: return
                depths.extend([0.] * (index + 1 - len(depths)))
            depths[index] = depth
            self.refresh_feedback()

    def set_release(self, milliseconds, now):
        number(milliseconds, 0, 10000, 'release_ms')
        self.tick(now)
        self.profile['sidechain']['release_ms'] = milliseconds
        if not self.features.sources: return
        source = self.features.sources[0]
        source.config['release_ms'] = milliseconds
        if not source.gates: source.transition = (now, source.level, 0.)

    def set_trigger(self, channel, note, now):
        number(channel, 1, 16, 'Trigger channel', True)
        if note is not None: number(note, 0, 127, 'Trigger note', True)
        self.panic(now)
        self.profile['trigger'] = dict(channel=channel, note=note)
        if self.features.config['mods']:
            self.features.config['mods'][0]['trigger'] = dict(controller='a4', type='note', channel=channel, number=note)

    @staticmethod
    def curve_value(curve, attenuation):
        for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
            if attenuation <= x1: return round(y0 + (y1-y0)*(attenuation-x0)/(x1-x0))
        return curve[-1][1]

    def panic(self, now):
        if hasattr(self, 'features'): self.features.release_gates(now)
        self.notes.clear(); self.envelope = 0.; self.release_start = None; self.last_time = now
        for (did, cid), ch in self.destinations.items():
            if ch.get('volume'): self._emit(did, ch['volume'], self.curve_value(ch['volume']['curve'], 0), force=True)

    def control_states(self):
        """Input-position and output summaries for the active bank bindings."""
        result = []
        def position(value, param, mapping):
            lo = max(param.get('min', 0), mapping.get('min', param.get('min', 0)))
            hi = min(param.get('max', 127), mapping.get('max', param.get('max', 127)))
            n = (value - lo) * 127 / (hi - lo) if hi > lo else 0
            if mapping.get('invert', False): n = 127 - n
            return max(0, min(127, round(n)))
        for bank in self.banks.values():
            for index, control in enumerate(bank['controls']):
                for layer, binding in control.items():
                    param = binding.get('parameter'); refs = []
                    values, outputs, unknown = [], [], False
                    if param in MOD_PARAMETERS:
                        values = [position(self.bank_mod_depth(bank, MOD_PARAMETERS[param]) * 127, {}, binding)]
                        if param == 'depth' and bank.get('depth_overrides'):
                            values = [position(bank['depth_overrides'].get(str(cid[0] if isinstance(cid, tuple) else cid), bank['depth']) * 127, {}, binding) for cid in self.targets(bank)]
                        outputs.append(round(self.bank_mod_depth(bank, MOD_PARAMETERS[param]) * 127))
                    elif param:
                        refs.extend(((bank['destination'], cid, param), binding) for cid in self.targets(bank))
                    for send in binding.get('sends', []):
                        cid = (send['set'], send['midi_channel']) if self.devices[send['device']].get('channel_mode') == 'selectable' else send['set']
                        refs.append(((send['device'], cid, send['parameter']), send))
                    for ref, mapping in refs:
                        p, _ = self.parameter_info(ref); base = self.bank_values[ref]
                        if base is None: unknown = True
                        else: values.append(position(base, p, mapping))
                        output = self.last_output.get((ref[0], p['channel'], p['cc']))
                        if output is not None: outputs.append(output)
                    unique = set(values); out_unique = set(outputs)
                    reads = self.features.operator_reads(bank['controller'], binding.get('source'))
                    operator_value = self.features.cc_values.get((bank['controller'], binding['source']['channel'], binding['source']['cc'])) if reads else None
                    result.append(dict(bank=bank['id'], index=index, layer=layer,
                        identity=self.control_identity(bank,index,layer), assigned=bool(param or binding.get('sends') or reads), value=values[0] if values and len(unique)==1 and not unknown else (operator_value if not values else None),
                        mixed=len(unique)>1 or (unknown and bool(values)), unknown=(unknown or not values) and operator_value is None,
                        output=outputs[0] if len(out_unique)==1 else None, output_mixed=len(out_unique)>1))
        return result

    def snapshot(self):
        return dict(envelope=self.envelope, held_notes=sum(map(len, self.notes.values())),
                    expired_notes=self.expired_notes, release_ms=self.settings_release(),
                    columns=[], channels={}, banks=copy.deepcopy(list(self.banks.values())))

    def routing_snapshot(self):
        return dict(trigger=dict(self.profile['trigger']), controls=[])

    def settings_profile(self):
        profile = copy.deepcopy(self.profile)
        profile['bank_setup'] = copy.deepcopy(self.setup)
        profile['performance'] = copy.deepcopy(self.features.config)
        profile['sidechain']['release_ms'] = self.settings_release()
        return profile

    def settings_release(self):
        mods = self.features.config['mods']
        return mods[0]['release_ms'] if mods else self.profile['sidechain']['release_ms']
