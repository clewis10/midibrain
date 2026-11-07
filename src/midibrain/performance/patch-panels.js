// Native dock panels for the patch canvas: the MIDI map (every input path:
// IN → OUT, plus feedback/sync) and System (runtime, ports, MIDI monitor,
// engine counters, global settings). They read the same draft/graph as the
// canvas through a small context object and edit only through ctx.edit.
import * as M from '/patch-model.mjs';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function button(text, onClick, className, title) {
  const node = el('button', className, text);
  node.type = 'button';
  if (title) node.title = title;
  node.addEventListener('click', event => { event.stopPropagation(); onClick(event); });
  return node;
}
function select(value, options, onChange, label) {
  const node = el('select');
  for (const [optionValue, text] of options) { const option = el('option', null, text); option.value = String(optionValue); node.append(option); }
  node.value = String(value ?? '');
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('change', () => onChange(node.value));
  return node;
}
const address = value => value ? `ch ${value.channel} · CC ${value.cc}` : '—';
// "Channel 1, Channel 3" → "ch 1, 3" when names are the defaults.
const channelList = names => names.every(name => /^Channel \d+$/.test(name)) ? `ch ${names.map(name => name.slice(8)).join(', ')}` : names.join(', ');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- MIDI map

const mapFilter = { controller: '', layer: '', text: '', mapped: false };

function inputRows(ctx, controller) {
  const { draft, graph } = ctx;
  const rows = [];
  const node = graph.nodes.find(item => item.id === `ctl:${controller.id}`);
  for (const bank of draft.setup.banks.filter(item => item.controller === controller.id)) {
    const device = draft.setup.devices.find(item => item.id === bank.destination);
    bank.controls.forEach((control, index) => Object.entries(control).forEach(([layer, binding]) => {
      const outputs = M.controlOutputs(draft, bank.id, index, layer);
      const mod = M.BANK_MOD_PARAMETERS.indexOf(binding.parameter);
      let out = '—', detail = '';
      if (mod >= 0) out = `${draft.performance.mods[mod]?.name || `MOD ${mod + 1}`} amount on ${bank.name}`;
      else if (outputs.length) {
        const strip = outputs.filter(item => item.kind === 'strip'), sends = outputs.filter(item => item.kind === 'send');
        const parts = [];
        if (strip.length) parts.push(`${device?.name || bank.destination} ${channelList(strip.map(item => item.channelName))} · ${strip[0].label}`);
        for (const send of sends) parts.push(`${send.deviceName} ${channelList([send.channelName])} · ${send.label}`);
        out = parts.join(' + ');
        detail = outputs.map(item => `${item.port || item.deviceName} · ch ${item.midi} · CC ${item.cc}${item.min > 0 || item.max < 127 ? ` · ${item.min}–${item.max}` : ''}${item.invert ? ' · inverted' : ''}`).join('\n');
      }
      const sync = binding.device_sync || 'off';
      rows.push({ kind: 'control', bank: bank.id, index, layer, name: `${bank.name} · ${binding.label || index + 1}`,
        input: address(binding.source), out, detail, mapped: Boolean(binding.parameter || binding.sends?.length),
        feedback: binding.feedback ? `⇄ ${address(binding.feedback)}${binding.feedback_from != null ? ` · shows ch ${binding.feedback_from}` : ''}` : '—',
        feedbackOn: Boolean(binding.feedback), sync: sync === 'off' ? '—' : sync === 'track' ? '⇠ track' : '⇠ link' });
    }));
  }
  for (const input of node?.inputs || []) {
    const uses = input.badges.length ? input.badges.join(' · ') : '';
    const wires = graph.wires.filter(wire => wire.from[0] === node.id && wire.from[1] === input.port).map(wire => ctx.describeWire(wire).replace(/^.*?→\s*/, '→ ') + (wire.label ? ` (${wire.label})` : ''));
    const out = [uses, ...wires].filter(Boolean).join(' · ') || 'unused';
    rows.push({ kind: 'input', key: input.key, name: input.label || M.inputLabel(input.binding), layer: input.binding.type === 'note' ? 'note' : 'button',
      input: `ch ${input.binding.channel} · ${input.binding.type === 'note' ? 'note' : 'CC'} ${input.binding.number ?? 'any'}`, out, detail: '', mapped: out !== 'unused', feedback: '—', sync: '—' });
  }
  return rows;
}

export function renderMap(root, ctx) {
  const { draft } = ctx;
  root.replaceChildren();
  const head = el('div', 'panel-head');
  head.append(el('h3', null, 'MIDI map'), el('p', 'note', 'Every path through MIDIBRAIN. IN is what a controller sends. OUT is what MIDIBRAIN sends to your devices. FB is what it sends back so the controller’s LEDs follow. Device sync listens to changes made on the device itself. Click a row to edit it in Inspect.'));
  root.append(head);
  const controllers = draft.setup.devices.filter(device => device.kind === 'controller');
  if (mapFilter.controller && !controllers.some(item => item.id === mapFilter.controller)) mapFilter.controller = '';
  const layers = [...new Set(controllers.flatMap(device => M.controllerLayerKeys(device)))];
  const bar = el('div', 'map-filters');
  const rerender = () => renderMap(root, ctx);
  bar.append(select(mapFilter.controller, [['', 'All controllers'], ...controllers.map(item => [item.id, item.name])], value => { mapFilter.controller = value; rerender(); }, 'Controller'),
    select(mapFilter.layer, [['', 'All layers'], ...layers.map(item => [item, item]), ['button', 'Buttons / notes']], value => { mapFilter.layer = value; rerender(); }, 'Layer'));
  const search = el('input'); search.type = 'search'; search.placeholder = 'Filter…'; search.value = mapFilter.text; search.setAttribute('aria-label', 'Filter mappings');
  search.addEventListener('input', () => { mapFilter.text = search.value; renderRows(); });
  const only = el('label', 'check'); const box = el('input'); box.type = 'checkbox'; box.checked = mapFilter.mapped;
  box.addEventListener('change', () => { mapFilter.mapped = box.checked; renderRows(); });
  only.append(box, 'Only mapped');
  bar.append(search, only);
  root.append(bar);
  const tables = el('div');
  root.append(tables);
  function renderRows() {
    tables.replaceChildren();
    const text = mapFilter.text.trim().toLowerCase();
    for (const controller of controllers.filter(item => !mapFilter.controller || item.id === mapFilter.controller)) {
      const rows = inputRows(ctx, controller).filter(row => (!mapFilter.layer || row.layer === mapFilter.layer || (mapFilter.layer === 'button' && row.kind === 'input')) &&
        (!mapFilter.mapped || row.mapped) && (!text || `${row.name} ${row.input} ${row.out} ${row.feedback} ${row.detail}`.toLowerCase().includes(text)));
      const section = el('section', 'map-section');
      const title = el('div', 'map-title');
      title.append(el('strong', null, controller.name), el('small', null, `in: ${controller.input || 'port not set'} · feedback: ${controller.feedback_output || 'off (no feedback port)'}`));
      title.append(button('Edit controller', () => ctx.openInspector({ type: 'node', id: `ctl:${controller.id}` }), 'ghost'));
      section.append(title);
      if (!rows.length) { section.append(el('p', 'note', 'No matching inputs.')); tables.append(section); continue; }
      const table = el('table', 'map-table');
      const header = el('tr');
      for (const name of ['Control', 'Layer', 'IN', 'OUT', 'FB', 'Sync']) header.append(el('th', null, name));
      table.append(header);
      for (const row of rows) {
        const tr = el('tr', row.mapped ? '' : 'unmapped'); tr.tabIndex = 0;
        tr.append(el('td', null, row.name), el('td', 'muted', row.layer), el('td', 'in', row.input));
        const out = el('td', 'out', row.out); if (row.detail) out.title = row.detail;
        const feedback = el('td', row.feedbackOn ? 'fb on' : 'fb', row.feedback);
        tr.append(out, feedback, el('td', 'muted', row.sync));
        const open = () => row.kind === 'control' ? ctx.openInspector({ type: 'bank', id: row.bank, focus: `${row.index}:${row.layer}` }) : ctx.openInspector({ type: 'input', id: controller.id, key: row.key });
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
        table.append(tr);
      }
      section.append(table);
      tables.append(section);
    }
    if (draft.routing.cc.length) {
      const section = el('section', 'map-section');
      const title = el('div', 'map-title'); title.append(el('strong', null, 'MIDI Thru'), el('small', null, 'Raw CC copies between ports. They bypass MIDIBRAIN’s parameter state and feedback.'));
      title.append(button('+ Thru route', () => ctx.openInspector({ type: 'add-thru' }), 'ghost'));
      section.append(title);
      const table = el('table', 'map-table');
      const header = el('tr'); for (const name of ['Page', 'From port', 'IN', 'OUT']) header.append(el('th', null, name)); table.append(header);
      draft.routing.cc.forEach((route, index) => {
        const tr = el('tr'); tr.tabIndex = 0;
        tr.append(el('td', null, route.page || '—'), el('td', null, route.source), el('td', 'in', `ch ${route.channel} · CC ${route.cc}`), el('td', 'out', route.destinations.map(target => `${target.port} · ch ${target.channel} · CC ${target.cc}`).join(' + ')));
        tr.addEventListener('click', () => ctx.openInspector({ type: 'node', id: 'thru', focus: index }));
        table.append(tr);
      });
      section.append(table); tables.append(section);
    }
  }
  renderRows();
  const tools = el('div', 'actions-row');
  tools.append(button('+ Thru route', () => ctx.openInspector({ type: 'add-thru' })),
    button('Bulk routing editor', () => ctx.openClassicRouting(), null, 'Consecutive input assignment, controller pages and MIDI learn sweeps'));
  root.append(tools);
}

// ---------------------------------------------------------------- System

const monitor = { direction: 'all', port: '', paused: false, after: 0, rows: [] };
function describeEvent(event) {
  if (event.type === 'control_change' || (!event.type && 'control' in event)) return `CC ${event.control} = ${event.value}`;
  if (event.type === 'note_on') return event.velocity > 0 ? `Note ${event.note} on · vel ${event.velocity}` : `Note ${event.note} off`;
  if (event.type === 'note_off') return `Note ${event.note} off`;
  return event.type || 'MIDI';
}
function since(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor(seconds % 3600 / 60)} min`;
}
function stat(label, value, sub) {
  const node = el('div', 'stat'); node.append(el('small', null, label), el('strong', null, value));
  if (sub) node.append(el('span', null, sub));
  return node;
}

function portRows(ctx, system) {
  const endpoints = system.connections?.endpoints || [];
  const state = (direction, port) => {
    if (!port) return ['not set', 'off'];
    if (system.demo) return ['simulated', 'sim'];
    const match = endpoints.find(item => item.direction === direction && item.configured === port);
    if (!match) return ['not requested', 'off'];
    return [match.state === 'connected' ? `connected${match.resolved && match.resolved !== port ? ` as ${match.resolved}` : ''}` : `${match.state}${match.detail ? ` · ${match.detail}` : ''}`, match.state];
  };
  const rows = [];
  for (const device of ctx.server?.banks?.active?.devices || system.devices || []) {
    if (device.kind === 'controller') {
      rows.push([device.name, 'IN · controller', device.input, ...state('input', device.input)]);
      if (device.feedback_output) rows.push([device.name, 'FB · feedback out', device.feedback_output, ...state('output', device.feedback_output)]);
    } else {
      rows.push([device.name, 'OUT · to device', device.output, ...state('output', device.output)]);
      if (device.input) rows.push([device.name, 'IN · device sync', device.input, ...state('input', device.input)]);
    }
  }
  const routing = system.routing || { clock: { source: null, destinations: [] }, cc: [] };
  if (routing.clock.source) rows.push(['Clock', 'IN · clock source', routing.clock.source, ...state('input', routing.clock.source)]);
  for (const port of routing.clock.destinations) rows.push(['Clock', 'OUT · clock to', port, ...state('output', port)]);
  for (const route of routing.cc) {
    rows.push(['MIDI Thru', 'IN', route.source, ...state('input', route.source)]);
    for (const target of route.destinations) rows.push(['MIDI Thru', 'OUT', target.port, ...state('output', target.port)]);
  }
  return rows;
}

export function renderSystem(root, ctx, system) {
  const { draft } = ctx;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    root.replaceChildren();
    for (const id of ['runtime', 'ports', 'monitor', 'engine', 'global']) { const section = el('section', 'system-section'); section.dataset.part = id; root.append(section); }
  }
  const part = id => root.querySelector(`[data-part="${id}"]`);
  if (!system) { part('runtime').replaceChildren(el('h3', null, 'System'), el('p', 'note', 'Reading the runtime…')); return; }
  const devices = Object.fromEntries((draft?.setup.devices || []).map(device => [device.id, device.name]));

  // Runtime
  const runtime = part('runtime'); runtime.replaceChildren();
  const head = el('div', 'panel-head');
  head.append(el('h3', null, 'System'), el('p', 'note', 'Runtime health, MIDI ports, a live MIDI monitor and rig-wide settings.'));
  const stats = el('div', 'stats');
  stats.append(stat('Runtime', system.running ? 'RUNNING' : 'STOPPED', `${system.demo ? 'Simulation' : 'Live hardware'} · up ${since(system.uptime)}`),
    stat('MIDI out', `${system.sent_count}`, `sent · ${system.pending} queued`),
    stat('Clock', system.musical_clock?.receiving ? `${system.musical_clock.bpm ? system.musical_clock.bpm.toFixed(1) : '—'} bpm` : 'NO CLOCK', system.routing?.clock?.source ? `from ${system.routing.clock.source}` : 'no clock source'),
    stat('Notes held', `${system.held_notes}`, `${system.mods_active ?? 0}/${system.mods ?? 0} MODs running`));
  const actions = el('div', 'actions-row');
  actions.append(button('⚠ Panic', () => ctx.command('/api/panic', {}, 'Released envelopes and restored volumes.'), 'danger', 'Release every envelope and restore ducked volumes'),
    button('■ Stop MODs', () => ctx.command('/api/performance/action', { action: 'mod_stop' }, 'All MODs stopped.'), null, 'Turn every MOD off until re-enabled'));
  if (!system.demo) actions.append(button('Restart runtime', () => ctx.restart(), 'primary', 'Reopen MIDI ports and activate saved structural settings'));
  runtime.append(head, stats, actions);
  if (system.error) runtime.append(el('p', 'note warn', `Runtime error: ${system.error}`));
  if (system.performance_error) runtime.append(el('p', 'note warn', `Last action error: ${system.performance_error}`));
  if (system.staged) runtime.append(el('p', 'note warn', system.demo ? 'Settings are staged.' : 'Saved settings are waiting for a runtime restart.'));

  // Ports
  const ports = part('ports'); ports.replaceChildren(el('h4', null, 'Ports & connections'));
  if (system.demo) ports.append(el('p', 'note', 'Simulation opens no MIDI ports. This is what the rig would use on hardware.'));
  if (system.connections?.discovery_error) ports.append(el('p', 'note warn', `Port discovery failed: ${system.connections.discovery_error}`));
  const table = el('table', 'map-table');
  const header = el('tr'); for (const name of ['Device', 'Role', 'Port', 'State']) header.append(el('th', null, name)); table.append(header);
  for (const [name, role, port, text, state] of portRows(ctx, system)) {
    const tr = el('tr'); tr.append(el('td', null, name), el('td', 'muted', role), el('td', null, port || '—'));
    const cell = el('td', 'port-state', text); cell.dataset.state = state; tr.append(cell); table.append(tr);
  }
  ports.append(table);
  const available = el('details'); available.append(el('summary', null, `Available ports · ${system.available.inputs.length} in · ${system.available.outputs.length} out`));
  available.append(el('p', 'note', `Inputs: ${system.available.inputs.join(', ') || 'none'}`), el('p', 'note', `Outputs: ${system.available.outputs.join(', ') || 'none'}`));
  ports.append(available);

  // MIDI monitor
  const section = part('monitor');
  if (!section.dataset.built) {
    section.dataset.built = '1';
    const tools = el('div', 'map-filters');
    tools.append(select(monitor.direction, [['all', 'In + out'], ['in', 'In only'], ['out', 'Out only']], value => { monitor.direction = value; drawMonitor(); }, 'Direction'));
    const portSelect = el('select'); portSelect.setAttribute('aria-label', 'Port'); portSelect.className = 'monitor-port';
    portSelect.addEventListener('change', () => { monitor.port = portSelect.value; drawMonitor(); });
    const pause = button('Pause', () => { monitor.paused = !monitor.paused; pause.textContent = monitor.paused ? 'Resume' : 'Pause'; pause.setAttribute('aria-pressed', String(monitor.paused)); });
    const clear = button('Clear', () => { monitor.after = Math.max(monitor.after, ...monitor.rows.map(row => row.at || 0)); drawMonitor(); });
    tools.append(portSelect, pause, clear);
    section.append(el('h4', null, 'MIDI monitor'), tools, el('ol', 'monitor'));
    section.querySelector('.monitor').setAttribute('aria-label', 'Recent MIDI messages');
  }
  if (!monitor.paused) monitor.rows = system.events || [];
  const name = event => 'input' in event ? event.input : (event.output || '').startsWith('feedback:') ? `${devices[event.output.slice(9)] || event.output.slice(9)} feedback` : devices[event.output] || event.output;
  function drawMonitor() {
    const list = section.querySelector('.monitor'), portSelect = section.querySelector('.monitor-port');
    const names = [...new Set(monitor.rows.map(name))];
    const current = monitor.port;
    // Rebuilding an open picker would close it under the pointer.
    if (document.activeElement !== portSelect) {
      portSelect.replaceChildren(...[['', 'All ports / devices'], ...names.map(item => [item, item])].map(([value, text]) => { const option = el('option', null, text); option.value = value; return option; }));
      portSelect.value = names.includes(current) ? current : '';
    }
    const now = Date.now() / 1000;
    const rows = monitor.rows.filter(event => (event.at || 0) > monitor.after || !event.at && !monitor.after)
      .filter(event => monitor.direction === 'all' || (monitor.direction === 'in') === ('input' in event))
      .filter(event => !monitor.port || name(event) === monitor.port).slice(-60).reverse();
    list.replaceChildren();
    if (!rows.length) { list.append(el('li', 'empty', 'Waiting for MIDI… Move a control or send a note.')); return; }
    for (const event of rows) {
      const inbound = 'input' in event, row = el('li', inbound ? 'in' : 'out');
      row.append(el('span', 'dir', inbound ? 'IN' : 'OUT'), el('span', 'when', event.at ? `${Math.max(0, now - event.at).toFixed(1)}s` : ''), el('span', 'who', name(event)),
        el('span', 'ch', `ch ${event.channel}`), el('span', 'what', describeEvent(event)));
      list.append(row);
    }
  }
  section.querySelector('h4').textContent = `MIDI monitor · ${plural(monitor.rows.length, 'message')} buffered${monitor.paused ? ' · paused' : ''}`;
  drawMonitor();

  // Engine
  const engine = part('engine'); engine.replaceChildren(el('h4', null, 'Engine'));
  const list = el('dl', 'facts');
  const fact = (term, value) => list.append(el('dt', null, term), el('dd', null, value));
  fact('Update rate', `${system.update_hz} Hz · ${(1000 / system.update_hz).toFixed(0)} ms per engine tick`);
  fact('Output pacing', `${system.output_limits.per_second} CC/s per port · burst ${system.output_limits.burst} · ${system.output_limits.per_pass} per loop pass`);
  if (system.native) {
    fact('Parameters', `${system.known}/${system.tracked} with a known value`);
    fact('MODs', `${system.mods_active}/${system.mods} running`);
    fact('Device sync', system.device_sync ? `${plural(system.device_sync, 'mapping')} listening to device changes` : 'off for every mapping');
    fact('Snapshots', `${system.snapshots.saved}/8 saved${system.snapshots.memory_only || system.demo ? ' · memory only' : ''}${system.snapshots.error ? ` · ${system.snapshots.error}` : ''}`);
    fact('Clock', `${system.clock.ticks} ticks · ${system.clock.forwarded} forwarded · max gap ${system.clock.max_tick_gap_ms.toFixed(1)} ms`);
  }
  fact('Profile', system.config_path || (system.demo ? 'simulation (not saved to disk)' : 'not set'));
  engine.append(list);

  // Global settings (draft)
  const global = part('global');
  if (!global.contains(document.activeElement)) {
    global.replaceChildren(el('h4', null, 'Global settings'));
    if (draft) {
      global.append(el('p', 'note', 'Rig-wide settings. They are part of the patch draft: Apply to rig saves them.'));
      const meter = el('div', 'inline-fields');
      const beats = el('input'); beats.type = 'number'; beats.min = 1; beats.max = 16; beats.value = draft.performance.beats_per_bar; beats.setAttribute('aria-label', 'Beats per bar');
      beats.addEventListener('change', () => ctx.edit(d => { d.performance.beats_per_bar = Number(beats.value); }));
      meter.append(el('span', null, 'Meter'), beats, el('span', null, '/'), select(draft.performance.beat_unit, [2, 4, 8, 16].map(v => [v, v]), value => ctx.edit(d => { d.performance.beat_unit = Number(value); }), 'Beat unit'));
      global.append(meter);
      // One place to change this: each destination device's own panel. It is the
      // same per-device `initialize` setting the Devices editor also shows.
      const startup = el('div', 'list');
      const destinations = draft.setup.devices.filter(item => item.kind === 'destination');
      for (const device of destinations) {
        const item = el('div', 'list-item');
        item.append(button(device.name, () => ctx.openInspector({ type: 'node', id: `dev:${device.id}` }), 'link', 'Edit this device'),
          el('small', null, device.initialize ? 'sends its default values at startup' : 'left as it is at startup'));
        startup.append(item);
      }
      const startupTitle = el('h4', null, 'Startup state per device');
      startupTitle.append(' ', Object.assign(el('button', 'hint-i', 'i'), { type: 'button' }));
      startupTitle.lastChild.dataset.tip = 'Whether MIDIBRAIN sends each parameter’s default value to a destination device when the runtime starts. It applies to any destination (the L6 is just one), and is set in that device’s own panel: click a name. Strip ⟲ resets and Panic are separate: they act while running.';
      startupTitle.lastChild.setAttribute('aria-label', 'More info');
      global.append(startupTitle, startup);
      const displayTitle = el('h4', null, 'Display');
      global.append(displayTitle, el('p', 'note', 'How often this browser reads live values (knob positions, MOD scopes, wire activity). Higher is smoother but asks the Pi for more updates; it is saved per browser and does not change the MIDI engine.'));
      const refresh = select(ctx.refreshHz, [[5, 'Standard · 5 Hz'], [15, 'Smooth · 15 Hz'], [30, 'High frame rate · 30 Hz'], [60, 'Maximum · 60 Hz']], value => ctx.setRefreshHz(Number(value)), 'Live display rate');
      global.append(refresh, el('p', 'note', 'Engine rate and output pacing are fixed for now. Use File → New / init patch to start over.'));
      global.append(button('Reset canvas view preferences', () => ctx.resetView(), null, 'Dock position, zoom, filters and layer tabs in this browser'));
    }
  }
}
