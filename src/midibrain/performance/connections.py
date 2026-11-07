"""Independent MIDI endpoint lifetimes, recovery and connection diagnostics."""
from __future__ import annotations

import copy
import logging
import time
from contextlib import ExitStack

from .bank_engine import BankEngine
from .engine import CC
from .routing import required_ports

log = logging.getLogger(__name__)


class Endpoint:
    def __init__(self, owner, key, port, context):
        self.owner, self.key, self.port, self.context = owner, key, port, context
        self.online = True

    def poll(self):
        if not self.online:
            return None
        try:
            return self.port.poll()
        except Exception as exc:
            self.owner.fail(self, exc)
            return None

    def send(self, message):
        if not self.online:
            return False
        try:
            self.port.send(message)
            return True
        except Exception as exc:
            self.owner.fail(self, exc)
            return False

    def close(self):
        self.online = False
        try:
            self.context.close()
        except Exception:
            log.exception('Could not close MIDI endpoint %s', self.key)


class Connections:
    """Never close or reinitialize healthy endpoints to recover a different one."""
    def __init__(self, session, backend):
        self.session, self.backend = session, backend
        self.inputs, self.outputs, self.all_outputs, self.input_roles = {}, {}, {}, {}
        self.handles, self.resolved, self.failures = {}, {}, {}
        self.discovery_error = None
        self.routing = copy.deepcopy(session.next_routing)
        self.roles = {}
        engine = session.engine
        if isinstance(engine, BankEngine):
            for device in engine.setup['devices']:
                if device['kind'] == 'controller':
                    self.roles[device['id'] + '_input'] = device['input']
                    if device.get('feedback_output'):
                        self.roles['feedback:' + device['id'] + '_output'] = device['feedback_output']
                else:
                    self.roles[device['id'] + '_output'] = device['output']
                    if device.get('input'):
                        # Destination's own changes, for mappings using device sync.
                        self.roles[device['id'] + '_input'] = device['input']
        else:
            self.roles = dict(engine.profile['ports'])
        self.requested = {('input' if role.endswith('_input') else 'output', name)
                          for role, name in self.roles.items()}
        extra_inputs, extra_outputs = required_ports(self.routing)
        self.requested.update(('input', name) for name in extra_inputs)
        self.requested.update(('output', name) for name in extra_outputs)

    def refresh(self):
        from .runtime import managed_input, resolve_port
        try:
            available = {'input': self.backend.get_input_names(),
                         'output': self.backend.get_output_names()}
        except Exception as exc:
            # Enumeration can fail independently of already-open working ports.
            self.discovery_error = str(exc)
            self.publish()
            return
        self.discovery_error = None
        with self.session.lock:
            self.session.available_ports = {'inputs': list(available['input']),
                                            'outputs': list(available['output'])}
        desired = {}
        for direction, configured in sorted(self.requested):
            try:
                name = resolve_port(configured, available[direction], direction, log_resolution=False)
                desired[direction, configured] = (name, None)
            except ValueError as exc:
                desired[direction, configured] = (None, str(exc))
        wanted = {(direction, name) for (direction, _), (name, _) in desired.items() if name}
        for key, endpoint in list(self.handles.items()):
            if key not in wanted:
                self.detach(endpoint)
        self.resolved = desired
        now = time.monotonic()
        for key in sorted(wanted):
            if key in self.handles:
                continue
            failure = self.failures.get(key)
            if failure and now < failure[1]:
                continue
            context = ExitStack()
            try:
                direction, name = key
                port = (context.enter_context(managed_input(self.backend.open_input(name)))
                        if direction == 'input' else context.enter_context(self.backend.open_output(name)))
            except Exception as exc:
                try:
                    context.close()
                except Exception:
                    log.exception('Could not clean up MIDI open failure for %s', key)
                self.record_failure(key, exc)
                continue
            self.handles[key] = Endpoint(self, key, port, context)
            self.failures.pop(key, None)
            if direction == 'output' and self.session.running:
                # Replay only this output's latest desired CC state. Never replay
                # past clock/transport messages or reset another mixer/controller.
                with self.session.lock:
                    for role, configured in self.roles.items():
                        if not role.endswith('_output'):
                            continue
                        if self.resolved['output', configured][0] != name:
                            continue
                        destination = role[:-7]
                        for (dest, channel, control), value in self.session.engine.last_output.items():
                            if dest == destination:
                                self.session._queue(CC(dest, channel, control, value))
        self.publish()

    def record_failure(self, key, exc):
        previous = self.failures.get(key)
        attempts = previous[2] + 1 if previous else 1
        self.failures[key] = (str(exc), time.monotonic() + min(10, 2 ** min(attempts, 4)), attempts)
        log.warning('MIDI %s %r unavailable: %s', *key, exc)

    def fail(self, endpoint, exc):
        self.record_failure(endpoint.key, exc)
        self.detach(endpoint)
        self.publish()

    def detach(self, endpoint):
        direction, name = endpoint.key
        if direction == 'input':
            with self.session.lock:
                engine = self.session.engine
                roles = self.input_roles.get(name, [])
                now = time.monotonic()
                if isinstance(engine, BankEngine):
                    for role in roles:
                        engine.features.release_controller(role, now)
                    if name == self.session.port_router.routing['clock']['source']:
                        from .features import MusicalClock
                        engine.features.clock = MusicalClock()
                        engine.features.pending = None
                    engine.tick(now)
                elif 'a4' in roles:
                    engine.panic(now)
        self.handles.pop(endpoint.key, None)
        endpoint.close()

    def publish(self):
        def connected(direction, configured):
            name = self.resolved.get((direction, configured), (None, None))[0]
            return name if (direction, name) in self.handles else None

        ports, roles, endpoints = {}, {}, []
        for role, configured in self.roles.items():
            direction = 'input' if role.endswith('_input') else 'output'
            name = connected(direction, configured)
            if name:
                ports[role] = name
                if direction == 'input':
                    roles.setdefault(name, []).append(role[:-6])
        for direction, configured in sorted(self.requested):
            name, detail = self.resolved.get((direction, configured), (None, 'Waiting for MIDI discovery'))
            online = connected(direction, configured) is not None
            failure = self.failures.get((direction, name))
            endpoints.append(dict(direction=direction, configured=configured, resolved=name,
                                  state='connected' if online else 'retrying' if failure else 'unavailable',
                                  detail=None if online else failure[0] if failure else detail))
        routing = copy.deepcopy(self.routing)
        source = routing['clock']['source']
        routing['clock']['source'] = connected('input', source) if source else None
        routing['clock']['destinations'] = [name for configured in routing['clock']['destinations']
                                            if (name := connected('output', configured))
                                            and routing['clock']['source']]
        for route in routing['cc']:
            route['source'] = connected('input', route['source'])
            for target in route['destinations']:
                target['port'] = connected('output', target['port'])
            route['destinations'] = [t for t in route['destinations'] if t['port']]
        routing['cc'] = [r for r in routing['cc'] if r['source'] and r['destinations']]
        routing['notes'] = [dict(route, source=connected('input', route['source']), port=connected('output', route['port'])) for route in routing.get('notes', [])]
        routing['notes'] = [route for route in routing['notes'] if route['source'] and route['port']]
        with self.session.lock:
            self.inputs.clear(); self.inputs.update({name: p for (d, name), p in self.handles.items() if d == 'input'})
            self.all_outputs.clear(); self.all_outputs.update({name: p for (d, name), p in self.handles.items() if d == 'output'})
            self.outputs.clear(); self.outputs.update({role[:-7]: self.all_outputs[name] for role, name in ports.items() if role.endswith('_output')})
            self.input_roles.clear(); self.input_roles.update(roles)
            self.session.active_ports = ports
            self.session.open_input_names = set(self.inputs)
            router = self.session.port_router
            if router.routing['clock']['source'] != routing['clock']['source']:
                router.last_tick = None
            router.routing = routing
            self.session.connection_status = dict(endpoints=endpoints, discovery_error=self.discovery_error)
            self.session.error = None

    def close(self):
        for endpoint in list(self.handles.values()):
            endpoint.close()
        self.handles.clear()
