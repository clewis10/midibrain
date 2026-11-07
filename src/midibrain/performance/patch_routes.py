"""Patch canvas: one node graph over the real rig profile.

The graph is a view of the saved setup (banks, performance/MOD config and
patchbay routing). Every wire maps to something the engine runs. Only node
positions, pages and declared-but-unused controller inputs are canvas-only;
they live in a small layout sidecar next to the profile, never inside it.
"""
import copy
import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import HTMLResponse, Response

HERE = Path(__file__).parent
ASSETS = {'/patch.js': ('patch.js', 'text/javascript'),
          '/patch-model.mjs': ('patch-model.mjs', 'text/javascript'),
          '/patch-panels.js': ('patch-panels.js', 'text/javascript'),
          '/patch-templates.mjs': ('patch-templates.mjs', 'text/javascript'),
          '/patch-snapshots.mjs': ('patch-snapshots.mjs', 'text/javascript'),
          '/patch-operators.mjs': ('patch-operators.mjs', 'text/javascript'),
          '/patch.css': ('patch.css', 'text/css')}
# Output pacing the runtime applies to generated CCs (see runtime.run).
OUTPUT_LIMITS = {'per_second': 500, 'burst': 16, 'per_pass': 96, 'input_per_pass': 64}
LAYOUT_LIMIT = 512 * 1024
RIG_BUNDLE_VERSION = 2


def layout_path(session):
    if session.demo or not session.config_path:
        return None
    path = Path(session.config_path)
    return path.with_name(path.stem + '.patch-layout.json')


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_layout(layout):
    from .profile import number
    if not isinstance(layout, dict) or layout.get('version') != 1 or not isinstance(layout.get('nodes'), dict) or len(json.dumps(layout)) > LAYOUT_LIMIT:
        raise ValueError('Invalid patch layout')
    for position in layout['nodes'].values():
        if not isinstance(position, dict): raise ValueError('Invalid canvas node position')
        for coordinate in ('x', 'y'): number(position.get(coordinate), -10000000, 10000000, 'Canvas position')
    pages = layout.get('pages', [])
    if not isinstance(pages, list): raise ValueError('Invalid canvas pages')
    for page in pages:
        if not isinstance(page, dict) or any(not isinstance(page.get(key), str) for key in ('id', 'name')) or not isinstance(page.get('nodes'), list) or any(not isinstance(node, str) for node in page['nodes']):
            raise ValueError('Invalid canvas page')
    controls, inputs = layout.get('controls', {}), layout.get('inputs', {})
    controllers = layout.get('controllers', {})
    if not isinstance(controllers, dict): raise ValueError('Invalid controller canvas layout')
    for arrangement in controllers.values():
        if not isinstance(arrangement, dict) or arrangement.get('bankLayout', 'rows') not in ('rows', 'columns'):
            raise ValueError('Controller bank layout must be rows or columns')
        number(arrangement.get('columns', 4), 1, 8, 'Controller grid columns', True)
    widths = layout.get('widths', {})
    if not isinstance(widths, dict): raise ValueError('Invalid canvas node widths')
    for width in widths.values(): number(width, 120, 2000, 'Canvas node width', True)
    if not isinstance(controls, dict) or not isinstance(inputs, dict): raise ValueError('Invalid canvas controls or inputs')
    for style in controls.values():
        if not isinstance(style, dict) or style.get('kind', 'knob') not in ('knob', 'fader', 'button'):
            raise ValueError('Invalid canvas control style')
        for flag in ('centerDetent', 'fillFromCenter'):
            if flag in style and type(style[flag]) is not bool: raise ValueError('Canvas appearance flags must be on/off')
    for bindings in inputs.values():
        if not isinstance(bindings, list): raise ValueError('Invalid declared canvas inputs')
        for binding in bindings:
            if not isinstance(binding, dict) or binding.get('type') not in ('cc', 'note'): raise ValueError('Invalid declared canvas input')
            number(binding.get('channel'), 1, 16, 'Declared input channel', True)
            if binding.get('number') is not None or binding['type'] != 'note':
                number(binding.get('number'), 0, 127, 'Declared input number', True)
    return layout


def candidate_profile(session, edits):
    """The same full-profile candidate save_settings builds, without saving."""
    from .bank_engine import BankEngine
    from .profile import validate
    profile = session.settings_candidate(edits)
    validate(profile, live=not session.demo, allow_unverified=True)
    candidate = BankEngine(profile, lambda message: None)
    normalized = candidate.settings_profile()
    for requested, target in zip((profile.get('performance') or {}).get('mods', []), normalized['performance']['mods']):
        target['enabled'] = requested.get('enabled', target['enabled'])
    return normalized


def pending_input_release(engine, controller, event):
    kind = 'cc' if event.type == 'control_change' else 'note'
    control = event.control if kind == 'cc' else event.note
    key = controller, kind, event.channel, control
    switch = engine.devices.get(controller, {}).get('layer_switch')
    if controller in engine.active_layers and switch and (kind, event.channel, control) == (switch['type'], switch['channel'], switch['number']):
        return switch['mode'] != 'value' and controller in engine.layer_pressed
    reset_key = controller, event.channel, control
    reset = engine.bank_resets.get(reset_key) if kind == 'cc' else None
    if reset:
        return reset.get('action') not in ('depth', 'release') and reset_key in engine.reset_pressed
    if any(action['action'] in ('mod_rate', 'mod_amount', 'mod_phase', 'mod_depth', 'mod_release') and
           engine.features.match(action, controller, event) for action in engine.features.config['actions']):
        return False
    return key in engine.features.pressed or any(key in source.gates for source in engine.features.sources)


def register(app, session):
    @app.post('/api/patch/rig/init')
    def init_patch():
        from .rigs import fresh_profile
        with session.lock:
            return {'profile': candidate_profile(session, {'profile': fresh_profile()})}

    @app.get('/patch', response_class=HTMLResponse)
    def patch_page():
        return (HERE / 'patch.html').read_text()

    for route, (name, media) in ASSETS.items():
        def asset(name=name, media=media):
            return Response((HERE / name).read_text(), media_type=media, headers={'Cache-Control': 'no-store'})
        app.get(route)(asset)

    @app.get('/api/patch/state')
    def patch_state():
        """Definitions and drafts in one consistent read."""
        with session.lock:
            banks = session.bank_snapshot()
            performance = session.performance_snapshot()
            routing = session.routing_snapshot()
            return {'instance_id': session.instance_id, 'running': session.running, 'demo': session.demo,
                    'native': banks['native'],
                    'definitions_revision': revision(banks['active']['devices']),
                    'revision': revision(session.settings_candidate({})),
                    'profile': session.settings_candidate({}),
                    'banks': {'active': banks['active'], 'draft': banks['draft'], 'staged': banks['staged']},
                    'performance': {'active': performance.get('config'), 'draft': performance.get('draft_config')},
                    'routing': {'draft': routing['patchbay'], 'active': routing['active_patchbay'],
                                'available': routing['available'], 'restart_required': routing['restart_required']},
                    'staged': banks['staged'] or session.next_performance is not None or routing['restart_required']}

    @app.get('/api/patch/live')
    def patch_live():
        """Small polling payload: control positions and MOD values only.

        Polled several times a second while the canvas is visible, so it holds
        the runtime lock briefly: no config copies, capture validation or
        per-parameter summaries (those belong to /api/patch/state and System).
        """
        with session.lock:
            native = banks_native(session)
            engine = session.engine
            payload = {'instance_id': session.instance_id, 'running': session.running, 'native': native,
                       'definitions_revision': definitions_revision(session),
                       'staged': session.next_bank_setup is not None or session.next_performance is not None or restart_required(session),
                       'controls': [], 'inputs': [], 'mods': [], 'sources': [], 'clock': {}, 'shift': False, 'error': None,
                       'active_layers': dict(engine.active_layers) if native else {},
                       'direct_controls': [dict(index=index, identity=copy.deepcopy(route), value=engine.direct_values.get(index)) for index, route in engine.direct_routes.items()] if native else []}
            if not native:
                return payload
            features, now = engine.features, time.monotonic()
            payload['inputs'] = [dict(controller=controller, type='cc', channel=channel, number=number, value=value)
                                 for (controller, channel, number), value in features.cc_values.items()]
            bpm = 60 / (features.clock.period * 24) if features.clock.period else None
            payload.update(queued_slot=(features.pending or {}).get('slot'), queued_at_bar=(features.pending or {}).get('bars'), snapshots_saved=[capture is not None for capture in features.captures],
                           snapshots_info=[dict(saved_at=capture.get('saved_at'), values=len(capture['values']), depths=len(capture['depths'])) if capture else None for capture in features.captures],
                           offline_ports=[dict(direction=item['direction'], port=item['configured'], state=item['state'], detail=item.get('detail')) for item in session.connection_status.get('endpoints', []) if item['state'] != 'connected'], operators=[round(v, 4) for v in features.op_values], controls=engine.control_states(), mods=list(features.values),
                           sources=[dict(active=source.active, held=sum(len(notes) for notes in source.gates.values()),
                                         expired=source.expired_notes) for source in features.sources],
                           clock=dict(running=features.clock.running, aligned=features.clock.aligned,
                                      receiving=features.clock.valid(now), quarter=features.clock.position(now), bpm=bpm),
                           shift=bool(features.shift or features.virtual_shift), error=features.error,
                           note_live=copy.deepcopy(session.port_router.live))
            return payload

    @app.get('/api/patch/system')
    def patch_system():
        """Runtime, ports, MIDI monitor and engine counters for the System panel."""
        with session.lock:
            engine, now = session.engine, time.monotonic()
            native = banks_native(session)
            router = session.port_router
            result = {'instance_id': session.instance_id, 'running': session.running, 'demo': session.demo,
                      'error': session.error, 'uptime': max(0., time.time() - session.started_wall),
                      'config_path': None if session.demo or not session.config_path else str(session.config_path),
                      'staged': session.next_bank_setup is not None or session.next_performance is not None or restart_required(session),
                      'restart_required': restart_required(session),
                      'connections': copy.deepcopy(session.connection_status),
                      'available': copy.deepcopy(session.available_ports), 'active_ports': dict(session.active_ports),
                      'events': list(session.events), 'sent_count': session.sent_count, 'pending': len(session.pending),
                      'update_hz': engine.profile['update_hz'], 'output_limits': dict(OUTPUT_LIMITS),
                      'clock': router.clock_status(now), 'routing': copy.deepcopy(router.routing),
                      'held_notes': sum(map(len, engine.notes.values())), 'native': native}
            if native:
                features = engine.features
                known = sum(1 for value in engine.bank_values.values() if value is not None)
                bpm = 60 / (features.clock.period * 24) if features.clock.period else None
                result.update(devices=[{key: device.get(key) for key in ('id', 'name', 'kind', 'input', 'output', 'feedback_output')}
                                       for device in engine.setup['devices']],
                              tracked=len(engine.bank_values), known=known, mods=len(features.sources),
                              mods_active=sum(1 for source in features.sources if source.active),
                              device_sync=sum(len(entries) for entries in engine.device_sync.values()),
                              musical_clock=dict(running=features.clock.running, receiving=features.clock.valid(now), bpm=bpm,
                                                 aligned=features.clock.aligned),
                              snapshots=dict(saved=sum(1 for capture in features.captures if capture), **session.snapshot_store.status()),
                              performance_error=features.error, shift=bool(features.shift or features.virtual_shift))
            return result

    @app.post('/api/patch/apply')
    def patch_apply(body: dict):
        if set(body) != {'instance_id', 'revision', 'changes'} or not isinstance(body['changes'], dict):
            raise HTTPException(400, 'Runtime, revision and changes are required')
        with session.lock:
            current = patch_state()
            if body['instance_id'] != current['instance_id'] or body['revision'] != current['revision']:
                raise HTTPException(409, 'The rig changed in another editor. Reload before applying your patch.')
            try:
                return session.save_settings(body['changes'])
            except (ValueError, KeyError, TypeError, IndexError) as exc:
                raise HTTPException(400, str(exc)) from exc
            except OSError as exc:
                raise HTTPException(500, 'Settings could not be saved; edits were kept') from exc

    @app.post('/api/patch/validate')
    def patch_validate(body: dict):
        with session.lock:
            try:
                profile = candidate_profile(session, body)
            except (ValueError, KeyError, TypeError, IndexError) as exc:
                raise HTTPException(400, str(exc)) from exc
            active = session.engine.settings_profile()
            structural = (profile['bank_setup'] != active.get('bank_setup') or
                          profile['routing'] != active.get('routing') or profile['ports'] != active['ports'] or 'profile' in body)
            return {'ok': True, 'restart_required': structural and not session.demo}

    @app.post('/api/patch/rig/validate')
    def validate_rig(body: dict):
        try:
            if body.get('format') != 'midibrain-rig' or body.get('version') != RIG_BUNDLE_VERSION:
                raise ValueError('This configuration file is from an older version of MIDIBRAIN and is not supported. Export it again from the current version.')
            profile, layout = body['profile'], body.get('layout')
            if layout is not None: validate_layout(layout)
            with session.lock:
                profile = candidate_profile(session, {'profile': profile})
            return {'profile': profile, 'layout': layout}
        except (ValueError, KeyError, TypeError, IndexError) as exc:
            raise HTTPException(400, str(exc)) from exc

    def guard_runtime(body, *, releasing=False):
        if not banks_native(session) or not session.running or (not releasing and (session.next_bank_setup is not None or session.next_performance is not None or restart_required(session))):
            raise HTTPException(409, 'Apply settings and activate the runtime first')
        if body.get('runtime_instance') != session.instance_id or body.get('definitions_revision') != definitions_revision(session):
            raise HTTPException(409, 'Runtime or device definitions changed')

    @app.post('/api/patch/layer')
    def select_layer(body: dict):
        with session.lock:
            guard_runtime(body)
            try:
                session.engine.select_layer(body.get('controller'), body.get('layer'))
            except (ValueError, TypeError) as exc:
                raise HTTPException(400, str(exc)) from exc
            return {'ok': True, 'active_layers': dict(session.engine.active_layers)}

    @app.post('/api/patch/input')
    def perform_input(body: dict):
        from .engine import Event
        from .profile import number
        with session.lock:
            try:
                controller, kind = body['controller'], body['type']
                if not isinstance(controller, str) or kind not in ('cc', 'note'):
                    raise ValueError('Choose a controller and CC or note input')
                channel = number(body['channel'], 1, 16, 'Input channel', True)
                control = number(body['number'], 0, 119 if kind == 'cc' else 127, 'Input number', True)
                value = number(body['value'], 0, 127, 'Input value', True)
                engine = session.engine
                event = Event('control_change', channel, control=control, value=value) if kind == 'cc' else Event('note_on' if value else 'note_off', channel, note=control, velocity=value)
                releasing = value == 0 and banks_native(session) and pending_input_release(engine, controller, event)
                guard_runtime(body, releasing=releasing)
                configured = [(reset['controller'], 'cc', reset['channel'], reset['cc']) for reset in engine.setup['resets']]
                bindings = [*engine.features.config['actions']]
                if engine.features.config['shift']: bindings.append(engine.features.config['shift'])
                bindings += [mod['trigger'] for mod in engine.features.config['mods'] if mod['trigger']]
                bindings += [dict(device['layer_switch'], controller=device['id']) for device in engine.devices.values() if device.get('layer_mode') == 'software' and device.get('layer_switch')]
                configured += [(binding['controller'], binding.get('type', 'cc'), binding['channel'], binding['number']) for binding in bindings]
                for operator in engine.features.config['operators']:
                    configured += [(binding['controller'], 'cc', binding['channel'], binding['number'])
                                   for binding in [*operator['links'].values(), *[item for item in operator['inputs'] if item['type'] == 'cc']]]
                if (controller, kind, channel, control) not in configured: raise ValueError('Input is not assigned in the active rig')
                engine.handle(controller, event, time.monotonic())
            except (ValueError, KeyError, TypeError) as exc:
                raise HTTPException(400, str(exc)) from exc
            return {'ok': True}

    @app.post('/api/patch/thru-control')
    def perform_direct_control(body: dict):
        with session.lock:
            guard_runtime(body)
            try:
                from .profile import number
                index = number(body['index'], 0, 63, 'Direct control index', True)
                if body.get('expected') != session.engine.direct_routes.get(index):
                    raise HTTPException(409, 'Direct control routing changed')
                session.engine.set_direct_control(index, body['value'])
            except (ValueError, KeyError, TypeError) as exc:
                raise HTTPException(400, str(exc)) from exc
            return {'ok': True}

    def template_library():
        from .controller_templates import TemplateLibrary
        saved = None
        maps = HERE.parents[2] / 'config' / 'controller_maps.json'
        if not session.demo and session.config_path:
            parent = Path(session.config_path).parent
            saved = parent / 'controller-templates.json'
            if (parent / 'controller_maps.json').exists(): maps = parent / 'controller_maps.json'
        if not hasattr(session, 'controller_templates') or session.controller_templates.path != saved:
            session.controller_templates = TemplateLibrary(saved, maps)
        return session.controller_templates

    @app.get('/api/patch/controller-templates')
    def list_controller_templates():
        return {'templates': template_library().listing(), 'stored': 'memory' if session.demo or not session.config_path else 'file'}

    @app.post('/api/patch/controller-templates')
    def save_controller_template(body: dict):
        try:
            name = template_library().save(body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, 'The controller template could not be saved') from exc
        return {'ok': True, 'name': name}

    @app.delete('/api/patch/controller-templates/{name}')
    def delete_controller_template(name: str):
        try:
            template_library().delete(name)
        except KeyError as exc:
            raise HTTPException(404, 'No saved template with that name') from exc
        return {'ok': True}

    @app.get('/api/patch/layout')
    def get_layout():
        path = layout_path(session)
        if path is None:
            return {'layout': getattr(session, 'patch_layout', None), 'stored': 'memory'}
        try:
            return {'layout': json.loads(path.read_text()), 'stored': 'file'}
        except FileNotFoundError:
            return {'layout': None, 'stored': 'file'}
        except (OSError, ValueError):
            return {'layout': None, 'stored': 'file', 'error': 'Layout file is unreadable; using automatic layout'}

    @app.post('/api/patch/layout')
    def set_layout(body: dict):
        encoded = json.dumps(body, separators=(',', ':'))
        if len(encoded) > LAYOUT_LIMIT or body.get('version') != 1 or not isinstance(body.get('nodes'), dict):
            raise HTTPException(400, 'Invalid patch layout')
        path = layout_path(session)
        if path is None:
            session.patch_layout = body
            return {'ok': True, 'stored': 'memory'}
        # Layout is cosmetic and written outside the session lock: never delays MIDI.
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.patch-layout-')
        try:
            with os.fdopen(fd, 'w') as handle:
                handle.write(encoded)
            os.replace(temporary, path)
        except OSError as exc:
            Path(temporary).unlink(missing_ok=True)
            raise HTTPException(500, 'Layout could not be saved') from exc
        return {'ok': True, 'stored': 'file', 'at': time.time()}


def banks_native(session):
    from .bank_engine import BankEngine
    return isinstance(session.engine, BankEngine)


def restart_required(session):
    from .routing import empty_routing
    engine = session.engine
    return session.next_ports != engine.profile['ports'] or session.next_routing != engine.profile.get('routing', empty_routing())


def definitions_revision(session):
    """Hash of the active device definitions, cached per engine instance.

    The active engine's setup never changes in place (edits build a new engine),
    so the hash only needs computing when the engine is replaced. The cache keeps
    a reference to the engine, so a recycled object id cannot match.
    """
    cached = getattr(session, '_patch_definitions', None)
    if cached and cached[0] is session.engine:
        return cached[1]
    devices = session.engine.setup['devices'] if banks_native(session) else session.bank_snapshot()['active']['devices']
    value = revision(devices)
    session._patch_definitions = (session.engine, value)
    return value
