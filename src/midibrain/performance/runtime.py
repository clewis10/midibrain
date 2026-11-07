"""Bounded, concurrent USB MIDI processing and a thread-safe setup facade."""
from __future__ import annotations

import logging
import copy
import re
import threading
import time
import uuid
from collections import deque
from contextlib import ExitStack, contextmanager
from dataclasses import asdict

from .engine import CC, Event, MixerEngine
from .bank_engine import BankEngine
from .banks import migrate, validate_setup
from .profile import save, validate
from .routing import empty_routing, validate_routing, required_ports, PortRouter

log = logging.getLogger(__name__)


@contextmanager
def managed_input(port):
    """Quiesce RtMidi callbacks before its native input thread is joined."""
    with port:
        try:
            yield port
        finally:
            if type(port).__module__ == 'mido.backends.rtmidi' and not port.closed:
                # Mido's Input._close sets callback=None, which re-registers its
                # queue callback. Under live MIDI traffic RtMidi.close_port can
                # then hold the GIL while joining a callback waiting for the GIL.
                # Leave callbacks cancelled and let any already-entered Python
                # callback finish before closing/deleting the native port.
                port._rt.cancel_callback()
                time.sleep(.02)
                port._rt.close_port()
                port._rt.delete()
                port.closed = True


def resolve_port(configured, available, direction, *, log_resolution=True):
    if configured in available:
        return configured
    # ALSA client/port numbers change with USB enumeration after a reboot.
    # Keep the entire device/endpoint name; never confuse I/O with Mixer Control.
    stem = re.sub(r" \d+:\d+$", "", configured)
    matches = [name for name in available
               if re.sub(r" \d+:\d+$", "", name) == stem]
    if len(matches) == 1:
        if log_resolution:
            log.info("Resolved MIDI %s %r as %r", direction, configured, matches[0])
        return matches[0]
    raise ValueError(f"Missing MIDI {direction} or ambiguous match for {configured!r}; "
                     "run midibrain-mixer ports")


class Session:
    def __init__(self, profile, *, demo=False, config_path=None, allow_unverified=False):
        from .routing import upgrade_layer_routes
        profile = upgrade_layer_routes(profile)
        validate(profile, live=not demo, allow_unverified=allow_unverified)
        self.demo = demo
        self.config_path = config_path
        self.lock = threading.RLock()
        self.learn = None
        self.open_input_names = set()
        self.pending = {}
        self.events = deque(maxlen=100)
        self.engine = (BankEngine if "bank_setup" in profile else MixerEngine)(profile, self._queue)
        from .snapshot_store import SnapshotStore
        self.snapshot_store = SnapshotStore(config_path if not demo else None)
        self.snapshot_revision = 0
        if isinstance(self.engine, BankEngine):
            self.engine.features.captures = self.snapshot_store.load()
            self.engine.features.fit_captures()
        self.next_bank_setup = None
        self.next_performance = None
        self.bank_saved = True
        self.running = False
        self.error = None
        self.connection_status = {"endpoints": [], "discovery_error": None}
        self.sent_count = 0
        self.stop_event = threading.Event()
        self.signal_stop_requested = False
        self.restart_requested = False
        self.instance_id = uuid.uuid4().hex
        self.started_wall = time.time()
        self.available_ports = {"inputs": [], "outputs": []}
        self.active_ports = {}
        self.next_ports = dict(profile["ports"])
        self.next_routing = validate_routing(profile.get("routing", empty_routing()))
        self.port_router = PortRouter(self.next_routing)
        self.routing_saved = True
        if demo:
            self.available_ports = {
                "inputs": ["L6:L6 MIDI I/O", "Midi Fighter Twister:Control", "Digitone II:MIDI"],
                "outputs": ["L6:L6 MIDI I/O", "L6:L6 Mixer Control", "Midi Fighter Twister:Control", "Digitone II:MIDI", "Analog Four:MIDI"],
            }


    def persist_captures(self):
        if isinstance(self.engine, BankEngine):
            f = self.engine.features
            if f.revision != self.snapshot_revision:
                self.snapshot_store.submit(f.captures, f.revision)
                self.snapshot_revision = f.revision

    def performance_snapshot(self):
        with self.lock:
            if not isinstance(self.engine, BankEngine): return {'native': False}
            f = self.engine.features
            targets = []
            for ref, value in self.engine.bank_values.items():
                param, signature = self.engine.parameter_info(ref)
                targets.append(dict(ref=ref, name=self.engine.devices[ref[0]]['name'] + ' / ' + str(ref[1]) + ' / ' + param['label'],
                                    value=value, output=self.engine.last_output.get((ref[0], param['channel'], param['cc'])), continuous=param.get('continuous', False), signature=signature))
            return dict(native=True, **f.state(time.monotonic()), targets=targets,
                        draft_config=copy.deepcopy(self.next_performance or f.config),
                        storage=dict(memory_only=self.demo or self.config_path is None, **self.snapshot_store.status()))

    def activity_snapshot(self):
        """Small, single-lock monitor payload; avoids polling all editor models."""
        with self.lock:
            status = dict(running=self.running, demo=self.demo, error=self.error,
                          connections=copy.deepcopy(self.connection_status),
                          sent_count=self.sent_count, pending=len(self.pending),
                          held_notes=sum(map(len, self.engine.notes.values())), events=list(self.events))
            routing = dict(active_patchbay=copy.deepcopy(self.port_router.routing),
                           patchbay=copy.deepcopy(self.next_routing))
            if not isinstance(self.engine, BankEngine):
                return dict(status=status, routing=routing,
                            banks={'active': {'banks': []}}, performance={'native': False})
            now = time.monotonic()
            features = self.engine.features
            targets = []
            known_targets = 0
            for ref, value in self.engine.bank_values.items():
                param, signature = self.engine.parameter_info(ref)
                output = self.engine.last_output.get((ref[0], param['channel'], param['cc']))
                if value is not None: known_targets += 1
                if value is not None and output is not None and round(value) != round(output):
                    targets.append(dict(name=self.engine.devices[ref[0]]['name'] + ' / ' + str(ref[1]) + ' / ' + param['label'],
                                        value=value, output=output, signature=signature))
            bank_rows = [dict(id=bank['id'], name=bank['name'], destination=bank['destination'],
                              depth=bank['depth'], mod_depths=copy.deepcopy(bank.get('mod_depths', [bank['depth'], 0., 0.])))
                         for bank in self.engine.banks.values()]
            return dict(status=status, routing=routing, banks={'active': {'banks': bank_rows}},
                        performance=dict(native=True, **features.state(now), targets=targets,
                                         target_counts=dict(tracked=len(self.engine.bank_values),
                                                            known=known_targets, moving=len(targets))))

    def arm_learn(self, port, kind='cc'):
        with self.lock:
            if self.demo:
                raise ValueError('MIDI learn needs the hardware runtime; simulation does not open MIDI inputs')
            if not self.running or not isinstance(port, str) or not port:
                raise ValueError('Choose a connected controller input that is active in this session; stage/save/restart new ports first')
            port = resolve_port(port, self.open_input_names, 'input')
            if kind not in ('cc', 'note'): raise ValueError('Learn type must be CC or note')
            self.learn = dict(kind=kind, id=uuid.uuid4().hex, port=port, state='listening', expires=time.monotonic()+30)
            return self.learn_status(self.learn['id'])

    def learn_status(self, token, cancel=False):
        with self.lock:
            if not self.learn or self.learn['id'] != token:
                return dict(state='superseded')
            if self.learn['state'] == 'listening':
                if cancel or not self.running: self.learn['state'] = 'cancelled'
                elif time.monotonic() >= self.learn['expires']: self.learn['state'] = 'expired'
            return {k: copy.deepcopy(v) for k,v in self.learn.items() if k != 'expires'}

    def observe_learn(self, port, event):
        # Called under the runtime lock. Learning observes; it never changes routing.
        with self.lock:
            if not self.learn or self.learn_status(self.learn['id'])['state'] != 'listening': return
            if port != self.learn['port']: return
            if self.learn.get('kind', 'cc') == 'note':
                if event.type != 'note_on' or event.velocity <= 0: return
                self.learn.update(state='captured', channel=event.channel, number=event.note, value=event.velocity)
            else:
                if event.type != 'control_change' or not 0 <= event.control <= 119: return
                self.learn.update(state='captured', channel=event.channel, cc=event.control, number=event.control, value=event.value)

    def bank_snapshot(self):
        with self.lock:
            active = migrate(self.engine.settings_profile())
            if self.demo and not isinstance(self.engine, BankEngine):
                active['devices'][0].update(input='Midi Fighter Twister:Control', feedback_output='Midi Fighter Twister:Control')
                active['devices'][1]['output'] = 'L6:L6 Mixer Control' 
            return {"active": active, "draft": copy.deepcopy(self.next_bank_setup or active),
                    "staged": self.next_bank_setup is not None, "demo": self.demo,
                    "native": isinstance(self.engine, BankEngine), "saved": self.bank_saved,
                    "controls": self.engine.control_states() if isinstance(self.engine, BankEngine) else []}

    def routing_snapshot(self):
        with self.lock:
            return {**self.engine.routing_snapshot(),
                    "available": copy.deepcopy(self.available_ports),
                    "active_ports": dict(self.active_ports),
                    "connections": copy.deepcopy(self.connection_status),
                    "configured_ports": dict(self.next_ports),
                    "restart_required": (self.next_ports != self.engine.profile["ports"] or
                                         self.next_routing != self.engine.profile.get("routing", empty_routing())),
                    "patchbay": copy.deepcopy(self.next_routing),
                    "active_patchbay": copy.deepcopy(self.port_router.routing),
                    "routing_saved": self.routing_saved,
                    "clock_status": self.port_router.clock_status(time.monotonic()),
                    "demo": self.demo}

    def _queue(self, message: CC):
        # Last desired value wins. A burst cannot build an unbounded MIDI queue.
        # A value of None withdraws a queued value (the device reported a newer one).
        key = message.destination, message.channel, message.control
        if message.value is None:
            self.pending.pop(key, None)
            return
        self.pending[key] = message

    def snapshot(self):
        with self.lock:
            return {**self.engine.snapshot(), "running": self.running, "demo": self.demo,
                    "instance_id": self.instance_id,
                    "connections": copy.deepcopy(self.connection_status),
                    "error": self.error, "sent_count": self.sent_count,
                    "pending": len(self.pending), "events": list(self.events)}

    def settings_candidate(self, edits):
        if not isinstance(edits, dict) or set(edits) - {'banks', 'performance', 'routing', 'profile'}:
            raise ValueError('Unknown settings section')
        if 'profile' in edits:
            if set(edits) != {'profile'} or not isinstance(edits['profile'], dict):
                raise ValueError('Import a complete profile without other settings sections')
            profile = copy.deepcopy(edits['profile'])
            profile.setdefault('routing', empty_routing())
            from .routing import upgrade_layer_routes
            return upgrade_layer_routes(profile)
        profile = copy.deepcopy(getattr(self, 'next_profile', None) or self.engine.settings_profile())
        profile['ports'] = dict(self.next_ports)
        profile['bank_setup'] = copy.deepcopy(edits.get('banks', self.next_bank_setup or migrate(profile)))
        profile['controller_inputs_migrated'] = True
        profile['routing'] = copy.deepcopy(edits.get('routing', self.next_routing))
        if 'performance' in edits or self.next_performance is not None:
            profile['performance'] = copy.deepcopy(edits.get('performance', self.next_performance))
        return profile

    def save_settings(self, edits):
        """Validate the complete draft before saving or changing any running state."""
        with self.lock:
            profile = self.settings_candidate(edits)
            validate(profile, live=not self.demo, allow_unverified=True)
            # Construct and validate without emitting MIDI or touching the active engine.
            candidate = BankEngine(profile, lambda message: None)
            # A new engine bypasses free-running MODs (boot safety) by editing its
            # copy of the config. Live application must keep the user's on/off.
            live_performance = copy.deepcopy(profile.get('performance'))
            profile = candidate.settings_profile()
            for requested, target in zip((live_performance or {}).get('mods', []), profile['performance']['mods']):
                target['enabled'] = requested.get('enabled', target['enabled'])
            active = self.engine.settings_profile()
            structural = (not isinstance(self.engine, BankEngine) or
                          profile['bank_setup'] != active.get('bank_setup') or
                          profile['routing'] != active.get('routing', empty_routing()) or
                          profile['ports'] != active['ports'] or 'profile' in edits or getattr(self, 'next_profile', None) is not None)
            # Valid saved assignments may be offline. Connectivity is checked by
            # the runtime; disconnected devices must not prevent setup repair.
            if not self.demo:
                if self.config_path is None: raise ValueError('No profile path is configured')
                save(self.config_path, profile)
            now = time.monotonic()
            if self.demo and structural:
                old = self.engine.features if isinstance(self.engine, BankEngine) else None
                if old:
                    candidate.features.captures = copy.deepcopy(old.captures)
                    candidate.features.revision = old.revision
                self.pending.clear()
                self.engine = BankEngine(profile, self._queue)
                self.engine.features.captures = candidate.features.captures
                self.engine.features.revision = candidate.features.revision
                self.engine.initialize(now)
                self.port_router = PortRouter(profile['routing'])
                self.next_bank_setup = self.next_performance = None
                self.next_profile = None
            elif structural:
                self.next_bank_setup = profile['bank_setup']
                self.next_performance = profile['performance']
                self.next_profile = copy.deepcopy(profile)
            else:
                live = live_performance if live_performance is not None else profile['performance']
                if live != self.engine.features.config:
                    self.engine.features.configure(live, now)
                self.next_bank_setup = self.next_performance = None
            self.next_routing = copy.deepcopy(profile['routing'])
            self.next_ports = dict(profile['ports'])
            self.bank_saved = self.routing_saved = True
            return dict(ok=True, restart_required=structural and not self.demo, demo=self.demo)

    def restart_process(self):
        """Request normal shutdown; the CLI relaunches after all ports close."""
        with self.lock:
            if self.demo or self.config_path is None:
                raise ValueError('Simulation does not need a runtime restart')
            if self.restart_requested:
                return
            self.restart_requested = True
            # Give the HTTP response time to leave before shutting down its server.
            timer = threading.Timer(.25, self.stop)
            timer.daemon = True
            timer.start()

    def command(self, action, **values):
        with self.lock:
            if not self.running:
                raise ValueError("Runtime is not running")
            now = time.monotonic()
            if isinstance(self.engine, BankEngine) and action in ("depth", "columns", "reset_column"):
                raise ValueError("Use bank controls for a bank-based setup")
            if action in ('performance_config', 'performance_action', 'snapshot_delete', 'snapshot_retry'):
                if not isinstance(self.engine, BankEngine): raise ValueError('Activate bank setup first')
                f = self.engine.features
                if action == 'performance_config':
                    candidate = self.engine.settings_profile()
                    candidate['performance'] = values['config']
                    validate(candidate)
                    f.configure(values['config'], now)
                elif action == 'snapshot_delete':
                    from .profile import number
                    index = number(values.get('slot'), 0, len(f.captures) - 1, 'Snapshot slot', True)
                    f.captures[index] = None; f.revision += 1
                elif action == 'snapshot_retry':
                    f.revision += 1
                else:
                    f.request(values['command'], now)
                    self.engine.tick(now)
                self.persist_captures()
            elif action == 'bank_control':
                if not isinstance(self.engine, BankEngine): raise ValueError('Activate bank setup first')
                if self.next_bank_setup is not None: raise ValueError('Restart to activate saved bank settings first')
                if not isinstance(values.get('expected'), dict): raise ValueError('Mapping identity is required')
                self.engine.set_control(values.get('bank'), values.get('index'), values.get('layer'), values.get('value'), values.get('expected'))
                self.engine.tick(now)
            elif action == 'performance_control':
                from .profile import number
                if not isinstance(self.engine, BankEngine): raise ValueError('Activate bank setup first')
                if self.next_bank_setup is not None or self.next_performance is not None: raise ValueError('Restart to activate saved settings first')
                actions = self.engine.features.config['actions']
                index = number(values.get('index'), 0, len(actions)-1, 'Action index', True)
                binding = actions[index]
                if binding['action'] != values.get('kind') or binding != values.get('expected'): raise ValueError('Action changed; refresh the page')
                self.engine.features.apply_continuous(binding, values.get('value'))
                self.engine.tick(now)
            elif action == "release":
                self.engine.set_release(values["release_ms"], now)
            elif action == "depth":
                self.engine.set_depth(values["channel"], values["depth"])
            elif action == "reset":
                self.engine.reset_mixer(values.get("channel"))
            elif action == "columns":
                self.engine.set_columns(values["columns"])
            elif action == "trigger":
                self.engine.set_trigger(values["channel"], values.get("note"), now)
            elif action == "bank_setup":
                setup = validate_setup(values["setup"], live=not self.demo)
                for device in setup['devices']:
                    fields = [('input', 'inputs'), ('feedback_output', 'outputs')] if device['kind'] == 'controller' else [('output', 'outputs'), ('input', 'inputs')]
                    for field, direction in fields:
                        if device.get(field) and device[field] not in self.available_ports[direction]:
                            raise ValueError(f"Unavailable {direction} port: {device[field]}")
                candidate = self.engine.settings_profile()
                candidate['bank_setup'] = setup
                candidate['routing'] = self.next_routing
                candidate['ports'] = self.next_ports
                validate(candidate)
                if self.demo:
                    self.pending.clear()
                    old = self.engine.features if isinstance(self.engine, BankEngine) else None
                    self.engine = BankEngine(candidate, self._queue)
                    if old:
                        self.engine.features.captures = copy.deepcopy(old.captures)
                        self.engine.features.revision = old.revision
                    self.engine.initialize(now)
                    self.next_bank_setup = None
                else:
                    self.next_bank_setup = setup
                    self.bank_saved = False
            elif action == 'bank_mod_depth':
                if not isinstance(self.engine, BankEngine): raise ValueError('Activate bank setup first')
                if self.next_bank_setup: raise ValueError('Restart staged bank setup before changing MOD amounts')
                self.engine.set_bank_mod_depth(values['bank'], values['mod'], values['depth'])
                self.engine.tick(now)
            elif action == "bank_depth":
                if isinstance(self.engine, BankEngine):
                    self.engine.set_bank_depth(values['bank'], values['depth'])
                else:
                    raise ValueError('Apply bank setup and restart before controlling depth by bank')
                if self.next_bank_setup:
                    for bank in self.next_bank_setup['banks']:
                        if bank['id'] == values['bank']:
                            bank['depth'] = values['depth']; bank['depth_overrides'] = {}
                            self.bank_saved = False
            elif action == "bank_reset":
                if isinstance(self.engine, BankEngine): self.engine.reset_bank(values['bank'])
                else:
                    bank = next((b for b in migrate(self.engine.settings_profile())['banks'] if b['id'] == values['bank']), None)
                    if bank is None: raise ValueError('Unknown bank')
                    for cid in bank['channels']: self.engine.reset_mixer(cid)
            elif action == "routing":
                candidate = validate_routing(values["routing"])
                inputs, outputs = required_ports(candidate)
                for names, direction in ((inputs, "inputs"), (outputs, "outputs")):
                    if not names.issubset(self.available_ports[direction]):
                        raise ValueError("A selected port is unavailable; refresh the device inventory")
                profile = self.engine.settings_profile()
                profile["ports"] = self.next_ports
                profile["routing"] = candidate
                if self.next_bank_setup is not None:
                    profile["bank_setup"] = self.next_bank_setup
                validate(profile)
                self.next_routing = candidate
                self.routing_saved = False
                if self.demo:
                    self.port_router = PortRouter(candidate)
                    if isinstance(self.engine, BankEngine):
                        from .features import MusicalClock
                        self.engine.features.clock = MusicalClock()
                        self.engine.features.pending = None
                    self.engine.profile["routing"] = copy.deepcopy(candidate)
                    if isinstance(self.engine, BankEngine):
                        self.engine.direct_routes = {index: route for index, route in enumerate(candidate['cc']) if 'layer' in route}
                        self.engine.direct_values.clear()
            elif action == "ports":
                if self.demo:
                    raise ValueError("Device assignment is unavailable in simulation")
                candidate = self.engine.settings_profile()
                candidate["ports"] = values["ports"]
                candidate["routing"] = self.next_routing
                validate(candidate, live=True, allow_unverified=True)
                for role, name in candidate["ports"].items():
                    if isinstance(self.engine, BankEngine) and role != "a4_input":
                        continue
                    direction = "inputs" if role.endswith("_input") else "outputs"
                    if name not in self.available_ports[direction]:
                        raise ValueError(f"Port is no longer available: {name}")
                self.next_ports = dict(candidate["ports"])
                self.routing_saved = False
            elif action == "reset_column":
                self.engine.reset_column(values["column"])
            elif action == "panic":
                self.engine.panic(now)
            elif action == "save":
                if self.demo or self.config_path is None:
                    raise ValueError("Demo settings cannot overwrite a hardware profile")
                profile = self.settings_candidate({})
                validate(profile)
                save(self.config_path, profile)
                self.routing_saved = True
                self.bank_saved = True
            elif action == "note" and self.demo:
                note = values.get("note", 60)
                velocity = values.get("velocity", 127)
                from .profile import number
                number(note, 0, 127, "note", True)
                number(velocity, 0, 127, "velocity", True)
                event = Event("note_on", self.engine.profile["trigger"]["channel"], note=note, velocity=velocity)
                self.events.append({"input": "simulated note", **asdict(event), "at": time.time()})
                self.engine.handle("a4", event, now)
            else:
                raise ValueError("Unknown or unavailable command")

    def stop(self):
        self.stop_event.set()


def from_mido(message):
    return Event(message.type, getattr(message, "channel", 0) + 1,
                 getattr(message, "control", 0), getattr(message, "value", 0),
                 getattr(message, "note", 0), getattr(message, "velocity", 0))


def run(session: Session, *, backend=None, duration=None, allow_missing=False):
    """Poll each source fairly; schedule envelopes even when no MIDI arrives.

    The CLI isolates absent or faulty endpoints and reconnects them independently.
    Direct callers retain strict, all-ports-required startup by default.
    """
    if not session.demo and backend is None:
        import mido as backend
    profile = session.engine.profile
    inputs, outputs = {}, {}
    input_roles = {}
    all_outputs = {}
    started = False
    with ExitStack() as stack:
        try:
            connections = None
            if not session.demo and allow_missing:
                from .connections import Connections
                connections = Connections(session, backend)
                stack.callback(connections.close)
                connections.refresh()
                inputs, outputs = connections.inputs, connections.outputs
                all_outputs, input_roles = connections.all_outputs, connections.input_roles
            elif not session.demo:
                # Strict mode remains available to diagnostics and direct callers.
                ports = dict(profile["ports"])
                available_inputs = backend.get_input_names()
                available_outputs = backend.get_output_names()
                with session.lock:
                    session.available_ports = {"inputs": list(available_inputs), "outputs": list(available_outputs)}
                if isinstance(session.engine, BankEngine):
                    ports = {}
                    for device in session.engine.setup['devices']:
                        if device['kind'] == 'controller':
                            ports[device['id'] + '_input'] = resolve_port(device['input'], available_inputs, 'input')
                            if device.get('feedback_output'):
                                ports['feedback:' + device['id'] + '_output'] = resolve_port(device['feedback_output'], available_outputs, 'output')
                        else:
                            ports[device['id'] + '_output'] = resolve_port(device['output'], available_outputs, 'output')
                            if device.get('input'):
                                ports[device['id'] + '_input'] = resolve_port(device['input'], available_inputs, 'input')
                else:
                    for role in ("a4_input", "twister_input"):
                        ports[role] = resolve_port(ports[role], available_inputs, "input")
                    for role in ("l6_output", "twister_output"):
                        ports[role] = resolve_port(ports[role], available_outputs, "output")
                routing = copy.deepcopy(session.next_routing)
                extra_inputs, extra_outputs = required_ports(routing)
                input_names = {name: resolve_port(name, available_inputs, "input") for name in extra_inputs}
                output_names = {name: resolve_port(name, available_outputs, "output") for name in extra_outputs}
                if routing["clock"]["source"]:
                    routing["clock"]["source"] = input_names[routing["clock"]["source"]]
                routing["clock"]["destinations"] = [output_names[n] for n in routing["clock"]["destinations"]]
                for route in routing["cc"]:
                    route["source"] = input_names[route["source"]]
                    for target in route["destinations"]:
                        target["port"] = output_names[target["port"]]
                for route in routing.get("notes", []):
                    route["source"] = input_names[route["source"]]
                    route["port"] = output_names[route["port"]]
                for role_key, name in ports.items():
                    if role_key.endswith('_input'):
                        input_roles.setdefault(name, []).append(role_key[:-6])
                for name in sorted(set(input_roles) | set(input_names.values())):
                    inputs[name] = stack.enter_context(managed_input(backend.open_input(name)))
                for name in sorted({name for role, name in ports.items() if role.endswith("_output")} | set(output_names.values())):
                    all_outputs[name] = stack.enter_context(backend.open_output(name))
                for role, name in ports.items():
                    if role.endswith('_output'): outputs[role[:-7]] = all_outputs[name]
                for configured, resolved in output_names.items():
                    outputs[configured] = all_outputs[resolved]
                with session.lock:
                    session.active_ports = dict(ports)
                    session.port_router = PortRouter(routing)
                    session.error = None
            with session.lock:
                session.open_input_names = set(inputs)
            started_at = time.monotonic()
            with session.lock:
                session.engine.initialize(started_at)
                session.running = started = True
            interval = min(1 / profile["update_hz"], 0.001) if session.port_router.routing["clock"]["source"] else 1 / profile["update_hz"]
            budgets = {}
            next_port_check = started_at + 1
            next_engine_tick = started_at
            while not session.signal_stop_requested and not session.stop_event.is_set():
                now = time.monotonic()
                if duration is not None and now - started_at >= duration:
                    break
                with session.lock:
                    for name, port in list(inputs.items()):
                        for _ in range(64):
                            message = port.poll()
                            if message is None:
                                break
                            event = from_mido(message)
                            session.observe_learn(name, event)
                            if event.type not in ("clock", "active_sensing"):
                                session.events.append({"input": name, **asdict(event), "at": time.time()})
                            if isinstance(session.engine, BankEngine) and name == session.port_router.routing['clock']['source'] and message.type in ('clock', 'start', 'continue', 'stop', 'songpos'):
                                session.engine.features.clock_event(message, time.monotonic())
                            session.port_router.handle(name, message, all_outputs, time.monotonic(), getattr(session.engine, 'active_layers', {}))
                            if name in input_roles and event.type not in ("clock", "active_sensing"):
                                for role in input_roles[name]:
                                    session.engine.handle(role, event, time.monotonic())
                    if now >= next_engine_tick:
                        session.engine.tick(time.monotonic())
                        next_engine_tick = now + 1 / profile["update_hz"]
                        if session.port_router.routing.get('notes') and hasattr(session.engine, 'features'):
                            session.port_router.live = session.engine.features.note_live(session.port_router.routing['notes'])
                            if not session.demo: session.port_router.emit_live(all_outputs, time.monotonic())
                    session.persist_captures()
                    # Fair per-output token buckets (500 CC/s, burst 16). Coalescing
                    # preserves insertion order so busy MOD targets cannot starve recalls.
                    count = 0
                    for key, message in list(session.pending.items()):
                        if not session.demo and message.destination not in outputs:
                            del session.pending[key]
                            continue
                        output_id = id(outputs[message.destination]) if not session.demo else message.destination
                        tokens, last = budgets.get(output_id, (16., now))
                        tokens = min(16., tokens + max(0., now - last) * 500)
                        budgets[output_id] = (tokens, now)
                        if tokens < 1: continue
                        budgets[output_id] = (tokens - 1, now)
                        if not session.demo:
                            delivered = outputs[message.destination].send(backend.Message(
                                "control_change", channel=message.channel - 1,
                                control=message.control, value=message.value))
                            if delivered is False:
                                del session.pending[key]
                                continue
                        session.sent_count += 1
                        session.events.append({"output": message.destination, **asdict(message), "at": time.time()})
                        del session.pending[key]
                        count += 1
                        if count >= 96: break
                if not session.demo and now >= next_port_check:
                    if connections:
                        connections.refresh()
                        interval = min(1 / profile["update_hz"], .001) if session.port_router.routing['clock']['source'] else 1 / profile["update_hz"]
                    else:
                        current_inputs = backend.get_input_names()
                        current_outputs = backend.get_output_names()
                        with session.lock:
                            session.available_ports = {"inputs": list(current_inputs), "outputs": list(current_outputs)}
                        if (any(name not in current_inputs for name in inputs)
                                or any(name not in current_outputs for name in all_outputs)):
                            raise RuntimeError("A MIDI device disconnected; reconnect and restart the runtime")
                    next_port_check = now + 1
                session.stop_event.wait(max(0, interval - (time.monotonic() - now)))
            # Leaving cleanly: let go of any note a keyboard route is still holding.
            if not session.demo:
                with session.lock:
                    session.port_router.release_all(all_outputs)
        except Exception as exc:
            with session.lock:
                session.error = str(exc)
            raise
        finally:
            with session.lock:
                session.running = False
                session.open_input_names.clear()
                session.pending.clear()
                if started:
                    if isinstance(session.engine, BankEngine):
                        enabled = [source.config['enabled'] for source in session.engine.features.sources]
                        session.engine.features.stop_mods(time.monotonic())
                        if allow_missing:
                            # Recovery must release held notes without turning
                            # the user's enabled MODs off for the next attempt.
                            for source, value in zip(session.engine.features.sources, enabled):
                                source.config['enabled'] = value
                                source.active = value and source.config['playback'] == 'loop'
                        session.engine.features.pending = None
                        session.engine.features.pressed.clear()
                        session.engine.features.shift = False
                        session.persist_captures()
                    session.engine.panic(time.monotonic())
                    # Best effort per channel: one failed send must not prevent
                    # restoration of the other channels or closing every port.
                    for message in session.pending.values():
                        if message.destination in outputs:
                            try:
                                outputs[message.destination].send(backend.Message(
                                    "control_change", channel=message.channel - 1,
                                    control=message.control, value=message.value))
                            except Exception:
                                log.exception("Could not restore L6 volume to unity")
                    session.pending.clear()

            session.snapshot_store.flush()
