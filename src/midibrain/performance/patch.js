// Patch canvas UI. All routing logic lives in patch-model.mjs; this file draws
// the graph, turns gestures into model edits and talks to the runtime API.
import * as M from '/patch-model.mjs';
import * as T from '/patch-templates.mjs';
import { knobPresentation, detentValue, migrateWorkspace } from '/surface-model.mjs';
import { renderMap, renderSystem } from '/patch-panels.js';
import { inspectorTopic, sectionTopic, fieldTopic, PANEL_TOPICS, manualHref } from '/manual-context.mjs';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
function el(tag, className, text) {
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
async function api(path, body, method = null) {
  const response = await fetch(path, { signal: AbortSignal.timeout(5000), ...(body === undefined ? { cache: 'no-store' } : { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`);
  return data;
}

const VIEW_KEY = 'midibrain.patch.view.v1';
const DOCK_TABS = ['inspect', 'map', 'devices', 'clock', 'system', 'manual'];
const NODE_LABELS = { controller: 'Controllers', mod: 'MODs', device: 'Destinations', clock: 'Clock', thru: 'MIDI Thru', snapshot: 'Snapshots', operator: 'Operators' };
const WIRE_LABELS = { strip: ['Strip → channel (dotted: per control)', 'var(--neutral)'], send: ['Extra sends', 'var(--blue)'], mod: ['Modulation', 'var(--amber)'],
  modmod: ['MOD → MOD', 'var(--amber)'], notes: ['Keyboard notes', 'var(--magenta)'], notemod: ['Keyboard modulation', 'var(--amber)'], notectl: ['Knob → keyboard', 'var(--pink)'],
  trigger: ['Triggers / gates', 'var(--green)'], action: ['Button actions', 'var(--cyan)'], clock: ['Clock', 'var(--teal)'], thru: ['Direct MIDI controls', 'var(--violet)'],
  op: ['Operator signal', 'var(--sand)'], snapshot: ['Snapshot scope', 'var(--peach)'], modamount: ['Strip MOD amount (dotted)', 'var(--amber)'] };
const GLYPH = { controller: '⌨', device: '▤', clock: '◷', thru: '⇢', snapshot: '◈', operator: 'ƒ' };

function loadView() {
  const fallback = { fold: {}, refreshHz: 5, allLayers: true, detail: 'strip', labels: true, zoom: 1, autoFit: true, pan: { x: 0, y: 0 }, layers: {},
    dock: { side: 'right', open: true, tab: 'inspect', mapMode: 'table', size: { h: 32, v: 40 } },
    nodes: Object.fromEntries(M.NODE_TYPES.map(type => [type, true])), wires: Object.fromEntries(M.WIRE_KINDS.map(kind => [kind, true])) };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (!saved || typeof saved !== 'object') return fallback;
    const result = { ...fallback, ...saved, layers: { ...fallback.layers, ...saved.layers }, nodes: { ...fallback.nodes, ...saved.nodes }, wires: { ...fallback.wires, ...saved.wires }, dock: { ...fallback.dock, ...saved.dock, size: { ...fallback.dock.size, ...saved.dock?.size } } };
    if (!['left', 'right', 'top', 'bottom'].includes(result.dock.side)) result.dock.side = 'right';
    // Routing and Activity became the native MIDI map and System panels.
    result.dock.tab = { controls: 'map', activity: 'system', snapshots: 'inspect' }[result.dock.tab] || result.dock.tab;
    if (!DOCK_TABS.includes(result.dock.tab)) result.dock.tab = 'inspect';
    if (!['table', 'classic'].includes(result.dock.mapMode)) result.dock.mapMode = 'table';
    for (const axis of ['h', 'v']) if (!Number.isFinite(result.dock.size[axis]) || result.dock.size[axis] < 18 || result.dock.size[axis] > 75) result.dock.size[axis] = fallback.dock.size[axis];
    if (![5, 15, 30, 60].includes(result.refreshHz)) result.refreshHz = 5;
    if (!Number.isFinite(result.zoom) || result.zoom < 0.1 || result.zoom > 1.6) result.zoom = 1;
    if (!Number.isFinite(result.pan?.x) || !Number.isFinite(result.pan?.y)) result.pan = { x: 0, y: 0 };
    return result;
  }
  catch { return fallback; }
}
const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { toast('View preferences could not be saved in this browser.'); } };

let server = null, base = null, draft = null, layout = M.emptyLayout(), graph = { nodes: [], wires: [] };
let view = loadView(), selection = null, live = null, validation = { state: 'clean' };
const history = new M.History();
const portEls = new Map();
const scopeHistory = [];
let lastControls = new Map();
let conflict = false, applying = false, lastLiveRead = 0, armedInstance = null, cancelControlDrag = null;

// ---------------------------------------------------------------- load / save

async function load({ keepDraft = false } = {}) {
  stopPlaying();
  await flushLayout();
  const [state, stored] = await Promise.all([api('/api/patch/state'), api('/api/patch/layout')]);
  server = state;
  base = M.normalizeDraft({ setup: state.banks.draft, performance: state.performance.draft, routing: state.routing.draft });
  if (!keepDraft || !draft) draft = M.clone(base);
  history.past = []; history.future = []; conflict = false;
  clearTimeout(validateTimer); validateSeq++; validation = { state: 'clean' };
  if (stored.layout?.version === 1) layout = { ...M.emptyLayout(), ...stored.layout };
  const beforeInputs = JSON.stringify(layout.inputs);
  M.retainInputs(draft, layout);
  if (beforeInputs !== JSON.stringify(layout.inputs)) saveLayout();
  nodeHeights.clear();
  if (stored.error) toast(stored.error);
  if (!state.native) banner('This rig uses an older mixer preset. Use File → New / init patch or import a bank-based rig to begin.', 'warn');
  else if (state.staged) banner(state.demo ? 'Settings are staged.' : 'Saved settings are waiting for a runtime restart.', 'warn', !state.demo && restartButton());
  else banner(null);
  render();
  if ((layout.rev || 0) < 2) { tidy({ record: false, reset: true }); layout.rev = 2; saveLayout(); }
  else if (!view.fitted) fit();
  view.fitted = true; saveView();
}

let layoutTimer = null, layoutPending = false;
function saveLayout() {
  clearTimeout(layoutTimer);
  layoutPending = true;
  layoutTimer = setTimeout(flushLayout, 400);
}
// Reloading the rig re-reads the stored layout, so a debounced save must land first.
async function flushLayout() {
  clearTimeout(layoutTimer);
  if (!layoutPending) return;
  layoutPending = false;
  try { await api('/api/patch/layout', layout); } catch (error) { toast(`Layout not saved: ${error.message}`); }
}

const dirty = () => Object.keys(M.changedSections(base, draft)).length > 0;

let validateTimer = null, validateSeq = 0;
function scheduleValidate() {
  clearTimeout(validateTimer);
  const seq = ++validateSeq;
  const changes = M.changedSections(base, draft);
  if (!Object.keys(changes).length) { validation = { state: 'clean' }; renderStatus(); return; }
  validation = { state: 'checking' }; renderStatus();
  validateTimer = setTimeout(async () => {
    try {
      const result = await api('/api/patch/validate', changes);
      if (seq === validateSeq) validation = { state: 'valid', restart: result.restart_required };
    } catch (error) { if (seq === validateSeq) validation = { state: 'invalid', message: error.message }; }
    renderStatus();
  }, 250);
}

async function apply() {
  if (applying || frameDirty || frameSaving || conflict || validation.state !== 'valid') return;
  const changes = M.changedSections(base, draft);
  if (!Object.keys(changes).length) return;
  stopPlaying(); applying = true; renderStatus();
  try {
    const result = await api('/api/patch/apply', { instance_id: server.instance_id, revision: server.revision, changes });
    history.past = []; history.future = [];
    await load();
    toast(result.restart_required ? 'Saved. Restart the runtime to activate strip/routing changes.' : 'Applied to the running rig.', 'info');
    if (result.restart_required) banner('Saved settings are waiting for a runtime restart.', 'warn', restartButton());
  } catch (error) { toast(error.message); }
  finally { applying = false; renderStatus(); }
}

// A device made on the canvas is published to the rig as soon as it can run, so the Devices
// tab (which reads the applied rig) lists it too. Only the new device(s) are applied: other
// pending edits stay pending. On a real rig a device needs an output port first.
let publishing = false;
async function publishNewDevices() {
  if (publishing || applying || conflict || !server?.native || !base) return;
  const fresh = draft.setup.devices.filter(device => device.kind === 'destination' && !base.setup.devices.some(item => item.id === device.id) && (server.demo || device.output));
  if (!fresh.length) return;
  publishing = true;
  try {
    const target = M.clone(base);
    target.setup.devices.push(...fresh.map(device => M.clone(device)));
    const result = await api('/api/patch/apply', { instance_id: server.instance_id, revision: server.revision, changes: M.changedSections(base, target) });
    await load({ keepDraft: true });
    toast(`${fresh.map(device => device.name).join(', ')} added to the rig and the Devices tab.${result.restart_required ? ' Restart the runtime to use its port.' : ''}`, 'info');
    if (result.restart_required) banner('Saved settings are waiting for a runtime restart.', 'warn', restartButton());
  } catch (error) { toast(`Kept on the canvas only: ${error.message}`); }
  finally { publishing = false; }
}

function restartButton() {
  return button('Restart runtime', async () => {
    try { await api('/api/restart', {}); banner('Restarting… the page reloads when the runtime is back.', 'info'); waitForRestart(); }
    catch (error) { toast(error.message); }
  }, 'primary');
}
async function waitForRestart() {
  const previous = server.instance_id;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try { const state = await api('/api/patch/state'); if (state.instance_id !== previous) { await load(); return; } } catch { /* still restarting */ }
  }
  banner('The runtime did not come back. Check the service on the Pi.', 'warn');
}

// ---------------------------------------------------------------- editing

function edit(change, { select, stay = false } = {}) {
  if (applying) return null;
  const before = { draft: M.clone(draft), layout: M.clone(layout) };
  try {
    M.retainInputs(draft, layout);
    const hint = change(draft, layout);
    M.Snap.pruneSnapshotTargets(draft); M.Ops.pruneOperators(draft);
    if (JSON.stringify(before.draft) !== JSON.stringify(draft)) stopPlaying();
    history.push(before);
    render();
    scheduleValidate();
    if (JSON.stringify(before.layout) !== JSON.stringify(layout)) saveLayout();
    const target = select || hint?.select;
    if (target && !stay) { selectWire(target); }
    return hint ?? true;
  } catch (error) {
    draft = before.draft; layout = before.layout;
    toast(error.message);
    render();
    return null;
  }
}

function undo() { const previous = history.undo({ draft, layout }); if (previous) { ({ draft, layout } = previous); afterHistory(); } }
function redo() { const next = history.redo({ draft, layout }); if (next) { ({ draft, layout } = next); afterHistory(); } }
// History restores positions too; don't re-settle them against the old heights.
function afterHistory() { stopPlaying(); selection = null; nodeHeights.clear(); closeInspector(); render(); scheduleValidate(); saveLayout(); }

// ---------------------------------------------------------------- rendering

function render() {
  graph = M.buildGraph(draft, layout, { detail: view.detail, saved: live?.snapshots_saved });
  problems = M.findProblems(draft, { live: !server?.demo });
  problemNodes = new Map(problems.map(problem => [problem.node, problem.message]));
  const placed = graph.nodes.filter(node => !layout.nodes[node.id]).map(node => node.id);
  if (placed.length) layout.nodes = M.autoLayout(graph, layout).nodes;
  document.body.classList.toggle('hide-labels', !view.labels);
  $('detailStrip').setAttribute('aria-pressed', view.detail !== 'control');
  $('detailControl').setAttribute('aria-pressed', view.detail === 'control');
  renderFilters(); renderNodes(); renderStatus(); applyTransform();
  if (placed.length) { restack(placed); saveLayout(); }
  settleHeights();
  requestAnimationFrame(drawWires);
  renderInspector();
  renderMapPane();
  applyLive();
}

// A configured port that is not connected (unplugged, powered off, renamed) is reported on the
// controller or destination that uses it, and once in the header. Mappings resume by themselves
// when the port returns; nothing needs reassigning.
function offlineByDevice() {
  const offline = live?.offline_ports || [], result = new Map();
  if (!offline.length || !draft) return result;
  const add = (device, text) => { if (!result.has(device.id)) result.set(device.id, []); result.get(device.id).push(text); };
  for (const device of draft.setup?.devices || []) {
    for (const item of offline) {
      if (device.kind === 'controller') {
        if (item.direction === 'input' && item.port === device.input) add(device, 'input offline');
        else if (item.direction === 'output' && item.port === device.feedback_output) add(device, 'feedback output offline');
      } else if (device.kind === 'destination') {
        if (item.direction === 'output' && item.port === device.output) add(device, 'output offline');
        else if (item.direction === 'input' && item.port === device.input) add(device, 'sync input offline');
      }
    }
  }
  return result;
}
let offlineSignature = '';
function showOfflinePorts() {
  const offline = live?.offline_ports || [], byDevice = offlineByDevice();
  const alert = $('portAlert');
  alert.hidden = !offline.length;
  if (offline.length) {
    alert.textContent = `⚠ ${offline.length} MIDI port${offline.length === 1 ? '' : 's'} offline`;
    alert.title = offline.map(item => `${item.direction === 'input' ? 'IN' : 'OUT'} · ${item.port}${item.detail ? ` — ${item.detail}` : ''}`).join('\n') + '\nClick to open System.';
    alert.onclick = () => setTab('system');
  }
  for (const card of document.querySelectorAll('.node[data-type=controller], .node[data-type=device]')) {
    const problems = byDevice.get(card.dataset.id.slice(card.dataset.id.indexOf(':') + 1)) || [];
    card.classList.toggle('offline', problems.length > 0);
    let note = card.querySelector(':scope > .offline-note');
    if (!problems.length) { note?.remove(); continue; }
    if (!note) { note = el('div', 'offline-note'); card.querySelector(':scope > .node-head')?.after(note); }
    note.textContent = `⚠ ${problems.join(' · ')} · resumes on reconnect`;
  }
  // The notes change node heights, so the wires must follow.
  const signature = JSON.stringify([...byDevice]);
  if (signature !== offlineSignature) { offlineSignature = signature; requestAnimationFrame(drawWires); }
}

function renderStatus() {
  const status = $('status'), isDirty = draft && dirty();
  $('discard').disabled = !isDirty;
  $('apply').disabled = !isDirty || validation.state !== 'valid' || problems.length > 0 || frameDirty || frameSaving || conflict || applying;
  $('apply').title = frameDirty || frameSaving ? 'Save or discard the rig tool drafts first' : conflict ? 'Reload the changed rig before applying' : '';
  $('discard').disabled ||= applying;
  const blocker = performBlocker();
  refreshSnapshotInspector();
  $('play').setAttribute('aria-disabled', String(Boolean(blocker) && !playing));
  $('play').title = blocker && !playing ? `Perform is unavailable: ${blocker}` : 'Perform: drag canvas controls to send their value to the running rig (on release). Esc returns to Edit.';
  $('toolDraftStatus').textContent = frameSaving ? 'Saving rig edits…' : frameDirty ? 'Unsaved rig tool edits · canvas output off' : '';
  $('controlDetails').setAttribute('aria-pressed', String(view.controlDetails === true));
  $('controlDetails').setAttribute('aria-checked', String(view.controlDetails === true));
  document.body.classList.toggle('control-details', view.controlDetails === true);
  $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length;
  status.dataset.state = isDirty ? validation.state : 'clean';
  status.title = '';
  renderToolNotice(isDirty);
  const showProblem = $('showProblem'); showProblem.hidden = !(isDirty && problems.length);
  if (isDirty && problems.length) {
    status.dataset.state = 'invalid';
    status.textContent = `✕ ${problems.length > 1 ? `${problems.length} things to fix: ` : ''}${problems[0].message}`; status.title = problems.map(problem => problem.message).join('\n');
    showProblem.onclick = () => openInspector({ type: 'node', id: problems[0].node });
    showProblem.textContent = problems.length > 1 ? `Show 1 of ${problems.length}` : 'Show';
  }
  else if (!isDirty) status.textContent = server?.demo ? 'Simulation · in sync' : 'In sync with rig';
  else if (validation.state === 'checking') status.textContent = 'Checking…';
  else if (validation.state === 'valid') status.textContent = validation.restart ? '✓ Valid · needs restart' : '✓ Valid · applies live';
  else if (validation.state === 'invalid') { status.textContent = `✕ ${validation.message}`; status.title = validation.message; }
  const visible = graph.nodes.filter(nodeVisible).length;
  $('counts').textContent = `${visible}/${graph.nodes.length} nodes · ${graph.wires.filter(wireVisible).length} wires · ${draft?.performance.mods.length || 0} MODs`;
  showOfflinePorts();
}

// The embedded editors (Devices, Snapshots, Clock, bulk routing) read the rig as
// last applied, not the canvas draft. Say so, rather than leave a new canvas
// device looking like it vanished.
function renderToolNotice(isDirty) {
  const notice = $('toolNotice');
  if (!frameTool() || !isDirty || frameDirty) { notice.hidden = true; return; }
  notice.hidden = false; notice.replaceChildren();
  const count = Object.keys(M.changedSections(base, draft)).length;
  notice.append(el('span', null, `The canvas has unapplied changes (${count} section${count === 1 ? '' : 's'}). This editor shows the rig as last applied, so anything you added on the canvas, such as a new device, will not appear here until you Apply.`));
  const apply = button('Apply to rig', () => $('apply').click(), 'primary'); apply.disabled = $('apply').disabled;
  apply.title = apply.disabled ? 'Fix the problems shown in the header first' : 'Apply the canvas changes so this editor can see them';
  notice.append(apply);
}

function renderFilters() {
  const root = $('filters'); root.replaceChildren();
  root.append(el('h4', null, 'Nodes'));
  for (const type of M.NODE_TYPES) {
    const label = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = view.nodes[type];
    box.addEventListener('change', () => { view.nodes[type] = box.checked; saveView(); render(); });
    label.append(box, NODE_LABELS[type]); root.append(label);
  }
  root.append(el('h4', null, 'Wires'));
  for (const kind of M.WIRE_KINDS) {
    const label = el('label'), box = el('input'), swatch = el('span', 'swatch'); box.type = 'checkbox'; box.checked = view.wires[kind];
    swatch.style.background = WIRE_LABELS[kind][1];
    box.addEventListener('change', () => { view.wires[kind] = box.checked; saveView(); render(); });
    label.append(box, swatch, WIRE_LABELS[kind][0]); root.append(label);
  }
  root.append(el('h4', null, 'Display'));
  const label = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = view.labels;
  box.addEventListener('change', () => { view.labels = box.checked; saveView(); render(); });
  label.append(box, 'Wire labels'); root.append(label);
  const layers = el('label'), layerBox = el('input'); layerBox.type = 'checkbox'; layerBox.checked = view.allLayers !== false;
  layerBox.addEventListener('change', () => { view.allLayers = layerBox.checked; saveView(); render(); });
  layers.title = 'Off: only the wires of the layer tab you are looking at';
  layers.append(layerBox, 'Wires from all layers'); root.append(layers);
}

const nodeVisible = node => view.nodes[node.type];
// Shift-drag on the canvas (or Shift-click a node) selects several nodes; dragging one moves them all.
const multi = new Set();
let problemNodes = new Map(), problems = [];
function wireVisible(wire) {
  if (!view.wires[wire.kind]) return false;
  // By default wires from every layer show; “this layer only” limits them to the visible tab.
  if (view.allLayers === false) {
    if (wire.kind === 'thru' && view.layers[wire.controller] !== wire.layer) return false;
    if (wire.from[0].startsWith('ctl:') && ['strip', 'send', 'notectl'].includes(wire.kind)) {
      const controller = deviceById(wire.from[0].slice(4));
      if (controller?.layer_types?.[view.layers[controller.id]] === 'direct') return false;
      if (wire.layer && wire.layer !== view.layers[controller?.id] && controller?.layer_types?.[wire.layer] !== 'direct' && M.bankLayerKeys(controller).includes(view.layers[controller.id])) return false;
    }
  }
  const from = graph.nodes.find(node => node.id === wire.from[0]), to = graph.nodes.find(node => node.id === wire.to[0]);
  return from && to && nodeVisible(from) && nodeVisible(to);
}

function port(nodeId, portId, direction, connectable = true, side = null) {
  const dot = el('span', `port ${direction}${side ? ` ${side}` : ''}`);
  dot.dataset.node = nodeId; dot.dataset.port = portId; dot.dataset.dir = direction;
  portEls.set(`${nodeId}|${portId}`, dot);
  if (direction === 'out' && connectable) dot.addEventListener('pointerdown', event => startConnect(event, nodeId, portId));
  return dot;
}
function dropRow(row, nodeId, portId) { row.dataset.dropNode = nodeId; row.dataset.dropPort = portId; return row; }

function renderNodes() {
  cancelControlDrag?.();
  const root = $('nodes'); root.replaceChildren(); portEls.clear();
  for (const node of graph.nodes) {
    if (!nodeVisible(node)) continue;
    const position = layout.nodes[node.id] || { x: 0, y: 0 };
    const card = el('section', 'node');
    card.dataset.id = node.id; card.dataset.type = node.type;
    if (node.type === 'mod') card.dataset.enabled = node.enabled;
    card.style.left = `${position.x}px`; card.style.top = `${position.y}px`;
    if (selection?.type === 'node' && selection.id === node.id) card.classList.add('selected');
    if (multi.has(node.id)) card.classList.add('multi');
    card.append(nodeHead(node));
    ({ controller: controllerBody, device: deviceBody, mod: modBody, clock: clockBody, thru: thruBody, snapshot: snapshotBody, operator: operatorBody })[node.type](card, node);
    const width = M.nodeWidth(layout, node.id);
    if (width) card.style.width = `${width}px`;
    if (problemNodes.has(node.id)) { card.classList.add('problem'); card.title = problemNodes.get(node.id); }
    card.append(resizeHandle(card, node));
    root.append(card);
  }
  const connected = new Set(graph.wires.flatMap(wire => [wire.from.join('|'), wire.to.join('|')]));
  for (const [key, dot] of portEls) if (connected.has(key)) dot.classList.add('connected');
}

// When a node grows or shrinks (a strip, layer or input added), nodes stacked
// below it move by the same amount, so nothing ends up hidden underneath.
const nodeHeights = new Map();
function settleHeights() {
  const cards = new Map([...document.querySelectorAll('.node')].map(card => [card.dataset.id, card]));
  const size = new Map([...cards].map(([id, card]) => [id, { h: card.offsetHeight, w: card.offsetWidth }]));
  let moved = false;
  for (const [id, { h, w }] of size) {
    const before = nodeHeights.get(id), origin = layout.nodes[id];
    if (before === undefined || before === h || !origin) continue;
    for (const [otherId, other] of size) {
      const position = layout.nodes[otherId];
      if (otherId === id || !position || position.y < origin.y + before - 4) continue;
      if (position.x >= origin.x + w || position.x + other.w <= origin.x) continue;
      position.y = Math.max(-2000, position.y + h - before); moved = true;
      cards.get(otherId).style.top = `${position.y}px`;
    }
  }
  nodeHeights.clear();
  for (const [id, { h }] of size) nodeHeights.set(id, h);
  if (moved) saveLayout();
}

// Auto-placed nodes use estimated heights; re-stack them using measured ones.
function restack(ids) {
  const cards = new Map([...document.querySelectorAll('.node')].map(card => [card.dataset.id, card]));
  const columns = new Map();
  for (const node of graph.nodes) {
    const position = layout.nodes[node.id], card = cards.get(node.id);
    if (!position || !card) continue;
    (columns.get(position.x) || columns.set(position.x, []).get(position.x)).push({ id: node.id, card, position });
  }
  for (const items of columns.values()) {
    let bottom = Math.max(40, ...items.filter(item => !ids.includes(item.id)).map(item => item.position.y + item.card.offsetHeight + 24));
    for (const item of items.filter(entry => ids.includes(entry.id)).sort((a, b) => a.position.y - b.position.y)) {
      item.position.y = bottom; item.card.style.top = `${bottom}px`; bottom += item.card.offsetHeight + 24;
    }
  }
}

// Drag the right edge to widen or narrow a node; double-click it for the default.
function resizeHandle(card, node) {
  const handle = el('span', 'resize-handle'); handle.title = 'Drag to resize · double-click for the default width';
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', `Resize ${node.title}`); handle.tabIndex = 0;
  handle.addEventListener('dblclick', event => { event.stopPropagation(); if (M.nodeWidth(layout, node.id) !== null) edit((_, lay) => M.setNodeWidth(lay, node.id, null)); });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 50 : 10, current = card.offsetWidth;
    const next = event.key === 'ArrowRight' ? current + step : event.key === 'ArrowLeft' ? current - step : null;
    if (next === null) return;
    event.preventDefault(); edit((_, lay) => M.setNodeWidth(lay, node.id, next));
    document.querySelector(`.node[data-id="${CSS.escape(node.id)}"] .resize-handle`)?.focus();
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX, startWidth = card.offsetWidth; let width = startWidth;
    card.classList.add('resizing');
    const move = moveEvent => {
      width = Math.max(M.NODE_WIDTH.min, Math.min(M.NODE_WIDTH.max, Math.round(startWidth + (moveEvent.clientX - startX) / view.zoom)));
      card.style.width = `${width}px`; requestAnimationFrame(drawWires);
    };
    const finish = commit => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel);
      card.classList.remove('resizing');
      if (commit && width !== startWidth) edit((_, lay) => M.setNodeWidth(lay, node.id, width));
      else { const stored = M.nodeWidth(layout, node.id); card.style.width = stored ? `${stored}px` : ''; requestAnimationFrame(drawWires); }
    };
    const up = () => finish(true), cancel = () => finish(false);
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel);
  });
  return handle;
}
function nodeSizeField(body, node) {
  const card = document.querySelector(`.node[data-id="${CSS.escape(node.id)}"]`);
  const stored = M.nodeWidth(layout, node.id), current = stored ?? Math.round(card?.offsetWidth || 260);
  const [range, out] = slider(current, M.NODE_WIDTH.min, M.NODE_WIDTH.max, 10, value => edit((_, lay) => M.setNodeWidth(lay, node.id, value)), v => `${Math.round(v)} px`);
  const auto = button('Default', () => edit((_, lay) => M.setNodeWidth(lay, node.id, null)), 'ghost', 'Use the default width'); auto.disabled = stored === null;
  body.append(group('Node size · canvas only', hint('Widen a node when names are long or you want global inputs spread over a wider grid. You can also drag its right edge on the canvas. This changes the canvas only, never MIDI.'), field('Width', range, out), auto));
}

function nodeHead(node) {
  const head = el('header', 'node-head');
  const glyph = el('span', 'glyph', node.type === 'mod' ? (M.SHAPES[node.shape] || '∿') : GLYPH[node.type]);
  const titles = el('div', 'titles'); const name = el('strong', null, node.title); name.title = node.title; titles.append(name, el('small', null, node.sub));
  const tools = el('div', 'head-tools');
  if (node.type === 'mod') {
    const toggle = button(node.enabled ? 'on' : 'off', () => edit(d => { d.performance.mods[node.mod].enabled = !d.performance.mods[node.mod].enabled; }), 'toggle', 'Enable / bypass');
    toggle.setAttribute('aria-pressed', node.enabled); tools.append(toggle);
  }
  tools.append(button('⋯', event => openInspector({ type: 'node', id: node.id }, event), 'ghost', 'Edit'));
  head.append(glyph, titles, tools);
  head.addEventListener('pointerdown', event => startDrag(event, node.id));
  head.addEventListener('dblclick', event => openInspector({ type: 'node', id: node.id }, event));
  if (node.type === 'mod' || node.type === 'clock' || node.type === 'operator') head.append(port(node.id, 'out', 'out'));
  if (node.type === 'device') { head.append(port(node.id, 'clock', 'in')); dropRow(head, node.id, 'clock'); }
  return head;
}

const polar = (degrees, radius = 16) => { const r = (degrees - 90) * Math.PI / 180; return [20 + radius * Math.cos(r), 20 + radius * Math.sin(r)]; };
function arcPath(from, to) {
  if (to - from < 0.5) return '';
  const [x1, y1] = polar(from), [x2, y2] = polar(to);
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A16,16 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}
function knobGraphic() {
  const svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('viewBox', '0 0 40 40');
  const shape = (tag, cls, attrs) => { const item = document.createElementNS(svgNS, tag); item.classList.add(cls); for (const [k, v] of Object.entries(attrs)) item.setAttribute(k, v); svg.append(item); return item; };
  shape('path', 'track', { d: arcPath(-135, 135) }); shape('path', 'arc', { d: '' });
  shape('line', 'center-mark', { x1: 20, y1: 0, x2: 20, y2: 5 });
  shape('circle', 'cap', { cx: 20, cy: 20, r: 11 }); shape('line', 'needle', { x1: 20, y1: 20, x2: 20, y2: 10 });
  return svg;
}
function setKnob(knob, value, state = {}) {
  const known = Number.isFinite(value) && !state.mixed;
  knob.classList.toggle('unknown', !known); knob.classList.toggle('mixed', Boolean(state.mixed));
  const display = knobPresentation(known ? value : 0, knob.dataset.detent === 'true');
  const fill = knobPresentation(known ? value : 0, knob.dataset.fillCenter === 'true');
  const angle = display.angle;
  knob.dataset.centered = String(known && display.centered);
  knob.dataset.value = known ? value : '';
  knob.setAttribute('aria-readonly', String(!playing || !state.assigned));
  if (knob.dataset.kind === 'button') knob.setAttribute('aria-pressed', String(known && value > 0));
  else {
    if (known) knob.setAttribute('aria-valuenow', value); else knob.removeAttribute('aria-valuenow');
    knob.setAttribute('aria-valuetext', known ? `${value}${display.centered ? ' · center' : ''}` : state.mixed ? 'Mixed' : 'Unknown');
  }
  knob.querySelector('.arc').setAttribute('d', known ? arcPath(fill.start - 135, fill.end - 135) : '');
  const [x, y] = polar(angle, 10); const needle = knob.querySelector('.needle'); needle.setAttribute('x2', x.toFixed(2)); needle.setAttribute('y2', y.toFixed(2));
  knob.style.setProperty('--position', `${known ? value / 127 * 100 : 0}%`);
  knob.querySelector('.k-value').textContent = known ? String(value).padStart(3, '0') : state.mixed ? 'mixed' : '—';
}

function controllerBody(card, node) {
  const layer = node.layers.includes(view.layers[node.device]) ? view.layers[node.device] : node.layers[0] || 'normal';
  const arrangement = M.controllerLayout(layout, node.device), direct = node.layerTypes[layer] === 'direct';
  card.dataset.bankLayout = arrangement.bankLayout;
  if (arrangement.bankLayout === 'columns' && !direct) card.style.width = `${Math.max(320, node.sections.length * 94)}px`;
  // Keyboards, pads and button boxes need no strips or layers: just the Global grid.
  if (!direct && !node.sections.length && node.layers.length <= 1) { globalSection(card, node, { addStrip: true }); return; }
  if (node.layers.length > 1) {
    const tabs = el('div', 'layer-tabs'); tabs.append(el('small', null, node.layerMode === 'software' ? 'Software layer' : 'Input'));
    for (const name of node.layers) {
      const displayName = node.routes.find(route => route.layer === name)?.page || name;
      const tab = button(displayName, async () => {
        if (playing && node.layerMode === 'software') {
          try {
            const result = await api('/api/patch/layer', { controller: node.device, layer: name, runtime_instance: live.instance_id, definitions_revision: live.definitions_revision });
            live.active_layers = result.active_layers;
          } catch (error) { stopPlaying(); toast(error.message); return; }
        }
        view.layers[node.device] = name; saveView(); render();
      }, null, node.layerMode === 'software' ? 'Inspect in Edit; activate on the running rig in Perform' : `Show the ${name} layer of each control`);
      tab.dataset.layerTab = `${node.device}:${name}`;
      tab.title = `Drop a button on this tab to reset the layer · ${node.layerTypes[name] === 'direct' ? 'Direct MIDI · independent of strips/banks' : 'Banked · follows strip channels'}${node.layerMode === 'software' ? ' · activates in Perform' : ' · hardware selects incoming addresses'}`;
      tab.setAttribute('aria-pressed', name === layer);
      // Wires of a layer whose controls are not on screen start here instead.
      tab.append(port(node.id, `layer:${name}`, 'out', false)); tab.classList.add('has-port');
      // Drop a button here to reset every control on this layer (shown while wiring or on hover).
      const resetIn = port(node.id, `resetlayer:${name}`, 'in'); resetIn.classList.add('layer-reset'); resetIn.setAttribute('aria-hidden', 'true');
      tab.append(resetIn); dropRow(tab, node.id, `resetlayer:${name}`);
      tabs.append(tab);
    }
    card.append(tabs);
  }
  const mode = el('div', 'layer-mode-label'); mode.append(el('span', null, direct ? 'DIRECT MIDI · no banks' : 'BANKED · follows strip channels'));
  if (direct) mode.append(button('+ control', () => openInspector({ type: 'add-thru', id: node.device, layer })));
  card.append(mode);
  if (!node.sections.length && !direct) {
    const empty = el('div', 'row');
    empty.append(el('small', null, 'No strips yet'), el('span'), button('+ strip', () => openInspector({ type: 'add-strip', id: node.device }), 'ghost', 'Map a group of this controller’s knobs to device channels'));
    card.append(empty);
  }
  const strips = el('div', 'controller-strips');
  if (arrangement.bankLayout === 'columns') strips.style.gridTemplateColumns = `repeat(${Math.max(1, node.sections.length)}, minmax(0, 1fr))`;
  card.append(strips);
  for (const section of direct ? [] : node.sections) {
    const strip = el('div', 'controller-strip'); strips.append(strip);
    const head = el('div', 'row bank-head clickable');
    const label = el('div', 'label'); label.append(el('span', null, section.title), el('small', null, section.sub));
    head.append(label, el('span'));
    head.append(port(node.id, section.inPort, 'in'));
    dropRow(head, node.id, section.inPort);
    if (section.outPort) head.append(port(node.id, section.outPort, 'out'));
    head.addEventListener('click', () => openInspector({ type: 'bank', id: section.bank }));
    strip.append(head);
    const grid = el('div', 'knobs'); grid.style.gridTemplateColumns = `repeat(${arrangement.bankLayout === 'columns' ? 1 : Math.min(Math.max(section.knobs.length, 1), arrangement.columns)}, minmax(0, 1fr))`;
    for (const knob of section.knobs) {
      const shown = knob.layers[layer] ? layer : Object.keys(knob.layers)[0];
      const info = knob.layers[shown];
      const cell = el('div', 'knob');
      const style = M.controlStyle(layout, section.bank, knob.index);
      cell.dataset.kind = style.kind; cell.dataset.detent = String(style.centerDetent);
      cell.dataset.fillCenter = String(style.fillFromCenter);
      cell.tabIndex = 0; cell.setAttribute('role', style.kind === 'button' ? 'button' : 'slider');
      cell.setAttribute('aria-label', `${section.title} ${info.label} ${shown}`);
      if (style.kind !== 'button') { cell.setAttribute('aria-valuemin', '0'); cell.setAttribute('aria-valuemax', '127'); }
      cell.dataset.knob = `${section.bank}:${knob.index}`; cell.dataset.layer = shown;
      if (!info.parameter && !info.sends && !operatorsReading(node.device, bankById(section.bank)?.controls[knob.index]?.[shown]?.source).length) cell.classList.add('unassigned');
      const fader = el('span', 'mini-fader'); fader.append(el('span', 'fader-thumb'));
      const label = button(info.label, () => { if (!playing) openInspector({ type: 'bank', id: section.bank, focus: `${knob.index}:${shown}` }); }, 'k-label', 'Edit this control');
      cell.append(knobGraphic(), fader, el('span', 'mini-pad', '●'), label, el('span', 'k-value', '—'), el('small', 'k-address', `${info.input}${info.feedback ? ' ⇄' : ''}${info.sync !== 'off' ? ' ⇠' : ''}`));
      cell.title = `${info.name} · IN ${info.input} → OUT ${info.label}${info.sends ? ` + ${info.sends} send${info.sends === 1 ? '' : 's'}` : ''} · ${info.feedback ? `FB ⇄ ${info.feedback}` : 'no feedback'}${info.sync !== 'off' ? ` · device sync: ${info.sync}` : ''}`;
      if (info.feedback) cell.dataset.feedback = 'true';
      if (view.detail === 'control') {
        const dot = port(node.id, info.port, 'out');
        // Other layers of the same physical control wire from the same knob.
        for (const other of Object.values(knob.layers)) if (other.port !== info.port) portEls.set(`${node.id}|${other.port}`, dot);
        cell.append(dot);
      }
      cell.addEventListener('pointerdown', event => { if (playing && !event.target.closest('.port, button:not(.k-label)')) startKnobDrag(event, cell, section.bank, knob.index, shown); });
      cell.addEventListener('click', event => {
        if (event.target.closest('.port, button')) return;
        if (!playing) openInspector({ type: 'bank', id: section.bank, focus: `${knob.index}:${shown}` });
        else if (style.kind === 'button') {
          const control = controlForPlayback(section.bank, knob.index, shown);
          if (control) commitControl(cell, section.bank, knob.index, shown, control.value > 0 ? 0 : 127);
        }
      });
      cell.addEventListener('dblclick', event => {
        if (style.centerDetent && style.kind !== 'button' && !event.target.closest('button, .port')) commitControl(cell, section.bank, knob.index, shown, 64);
      });
      cell.addEventListener('keydown', event => controlKey(event, cell, section.bank, knob.index, shown));
      grid.append(cell);
    }
    strip.append(grid);
  }
  if (direct) {
    const grid = el('div', 'knobs direct-controls'); grid.style.gridTemplateColumns = `repeat(${arrangement.columns}, minmax(0, 1fr))`;
    for (const route of node.routes.filter(item => item.layer === layer)) {
      const cell = el('div', 'knob direct-control'), style = M.controlStyle(layout, `direct:${node.device}:${layer}:${route.channel}`, route.cc);
      cell.dataset.knob = `@thru:${route.index}`; cell.dataset.route = route.index; cell.dataset.layer = layer;
      cell.dataset.kind = style.kind; cell.dataset.detent = String(style.centerDetent); cell.dataset.fillCenter = String(style.fillFromCenter);
      cell.tabIndex = 0; cell.setAttribute('role', style.kind === 'button' ? 'button' : 'slider');
      cell.setAttribute('aria-label', `${node.title} ${route.page || layer} CC ${route.cc}`);
      cell.setAttribute('aria-valuemin', '0'); cell.setAttribute('aria-valuemax', '127');
      const fader = el('span', 'mini-fader'); fader.append(el('span', 'fader-thumb'));
      const inspect = () => openInspector({ type: 'node', id: 'thru', focus: route.index });
      const outputs = route.destinations.map(target => `OUT ch ${target.channel} · CC ${target.cc}`).join(' + ');
      cell.append(knobGraphic(), fader, el('span', 'mini-pad', '●'), button(`CC ${route.cc}`, () => { if (!playing) inspect(); }, 'k-label'), el('span', 'k-value', '—'),
        el('small', 'k-address', `IN ch ${route.channel} · ${outputs}`), port(node.id, `direct:${route.index}`, 'out', false));
      cell.title = `IN ${route.source} ch ${route.channel} CC ${route.cc} → ${route.destinations.map(target => `${target.port} ch ${target.channel} CC ${target.cc}`).join(' + ')} · no bank assignment`;
      cell.addEventListener('pointerdown', event => { if (playing && !event.target.closest('.port, button:not(.k-label)')) startKnobDrag(event, cell, '@thru', route.index, layer); });
      cell.addEventListener('click', event => {
        if (event.target.closest('button, .port')) return;
        if (!playing) inspect();
        else if (style.kind === 'button') commitControl(cell, '@thru', route.index, layer, Number(cell.dataset.value) > 0 ? 0 : 127);
      });
      cell.addEventListener('keydown', event => { if (!playing && ['Enter', ' '].includes(event.key)) { event.preventDefault(); inspect(); } else controlKey(event, cell, '@thru', route.index, layer); });
      cell.addEventListener('dblclick', event => { if (playing && style.centerDetent && !event.target.closest('button, .port')) commitControl(cell, '@thru', route.index, layer, 64); });
      grid.append(cell);
    }
    if (!grid.children.length) card.append(el('p', 'note', 'No direct controls yet. Add a control and choose its output port, channel and CC.'));
    card.append(grid);
  }
  globalSection(card, node);
}

// ---- Global inputs: buttons, knobs, sliders and notes outside the strips.
// They flow into a grid that re-flows as the node is widened or narrowed.
const globalValues = new Map();
const CONTINUOUS_ACTIONS = ['mod_rate', 'mod_amount', 'mod_phase', 'mod_release', 'mod_depth'];
function isContinuousInput(input) {
  return input.uses.some(use => use.kind === 'operator' || (use.kind === 'action' && CONTINUOUS_ACTIONS.includes(draft.performance.actions[use.index].action)) || (use.kind === 'reset' && ['depth', 'release'].includes(draft.setup.resets[use.index].action)));
}
function globalSection(card, node, { addStrip = false } = {}) {
  const title = el('div', 'section-title');
  const label = el('span', null, 'Global'); label.dataset.tip = 'Inputs that sit outside the strips: buttons, knobs, sliders and notes. Wire one to a MOD input, a strip reset or a role, or leave it as a plain control.';
  const buttons = el('span', 'title-buttons');
  if (addStrip) buttons.append(button('+ strip', () => openInspector({ type: 'add-strip', id: node.device }), 'ghost', 'Also map a bank of knobs or faders on this controller to device channels'));
  buttons.append(button('+ input', () => openInspector({ type: 'add-input', id: node.device })));
  title.append(label, buttons);
  card.append(title);
  const grid = el('div', 'global-grid'); card.append(grid);
  for (const input of node.inputs) {
    const style = M.globalStyle(layout, node.device, input.key, isContinuousInput(input));
    const name = input.label || M.inputLabel(input.binding), valueKey = `${node.device}:${input.key}`;
    const cell = el('div', 'knob global-input clickable'); cell.dataset.kind = style.kind; cell.dataset.detent = String(style.centerDetent); cell.dataset.fillCenter = String(style.fillFromCenter);
    cell.dataset.globalInput = input.key; cell.dataset.controller = node.device; cell.tabIndex = 0;
    cell.setAttribute('role', style.kind === 'button' ? 'button' : 'slider'); cell.setAttribute('aria-label', `${name} (global input)`);
    if (style.kind !== 'button') { cell.setAttribute('aria-valuemin', '0'); cell.setAttribute('aria-valuemax', '127'); }
    const fader = el('span', 'mini-fader'); fader.append(el('span', 'fader-thumb'));
    const inspect = () => openInspector({ type: 'input', id: node.device, key: input.key });
    const pad = el('span', 'mini-pad', '●');
    const roles = input.badges.length ? el('small', 'k-roles', input.badges.join(' · ')) : null;
    if (roles) { roles.title = input.badges.join('\n'); if (input.badges.some(badge => badge.startsWith('⇧ Shift'))) roles.dataset.shift = '1'; }
    const caption = button(name, () => { if (!playing) inspect(); }, 'k-label', 'Edit this input');
    cell.append(knobGraphic(), fader, pad, caption, el('span', 'k-value', '—'));
    if (roles) cell.append(roles);
    cell.append(el('small', 'k-address', M.inputLabel(input.binding)));
    cell.title = `${name} · ${M.inputLabel(input.binding)}${input.badges.length ? ` · ${input.badges.join(', ')}` : ''}`;
    setKnob(cell, globalValues.get(valueKey), { assigned: true });
    cell.querySelector('.k-value').textContent = style.kind === 'button' ? '' : cell.querySelector('.k-value').textContent;
    if (style.kind === 'button') pad.replaceWith(globalPad(node.device, input, name));
    if (server?.demo && input.binding.type === 'note' && node.device === 'a4') cell.append(demoNoteButton());
    cell.append(port(node.id, input.port, 'out'));
    cell.addEventListener('pointerdown', event => { if (playing && style.kind !== 'button' && !event.target.closest('.port, button:not(.k-label)')) startGlobalDrag(event, cell, node.device, input); });
    cell.addEventListener('click', event => { if (!playing && !event.target.closest('.port, button')) inspect(); });
    cell.addEventListener('keydown', event => { if (event.target === cell && ['Enter', ' '].includes(event.key) && !playing) { event.preventDefault(); inspect(); } });
    grid.append(cell);
  }
  if (!node.inputs.length) grid.append(el('p', 'note global-empty', 'No global inputs yet. Add a button, knob, slider or note.'));
  keyRoutesSection(card, node);
}

// A momentary pad: sends press on pointer-down and release on pointer-up, in Perform only.
function globalPad(controller, input, name) {
  const pad = button('●', () => {}, 'input-pad', 'Edit to inspect; Perform to press this input');
  pad.setAttribute('aria-label', `Press ${name}`);
  if (input.binding.number === null) { pad.disabled = true; pad.title = 'Choose a specific CC or note number first'; return pad; }
  let pressed = false;
  const release = event => {
    if (event?.type === 'keyup' && ![' ', 'Enter'].includes(event.key)) return;
    window.removeEventListener('pointerup', release, true); window.removeEventListener('pointercancel', release, true);
    window.removeEventListener('keyup', release, true); window.removeEventListener('blur', release);
    if (!pressed) return;
    pressed = false; pad.classList.remove('pressed'); sendInput(controller, input.binding, 0, true);
  };
  const hold = () => {
    pressed = true;
    window.addEventListener('pointerup', release, true); window.addEventListener('pointercancel', release, true);
    window.addEventListener('keyup', release, true); window.addEventListener('blur', release);
    sendInput(controller, input.binding, 127);
  };
  pad.addEventListener('pointerdown', event => {
    if (!playing || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); pad.classList.add('pressed'); pad.setPointerCapture(event.pointerId); hold();
  });
  pad.addEventListener('pointerup', release); pad.addEventListener('pointercancel', release);
  pad.addEventListener('keydown', event => { if (playing && !event.repeat && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); hold(); } });
  pad.addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); release(); } });
  pad.addEventListener('click', () => { if (!playing) openInspector({ type: 'input', id: controller, key: input.key }); });
  return pad;
}

// A continuous global input sends its final value once, on release.
async function sendInputValue(controller, binding, value) {
  if (!playing || performBlocker()) return;
  try { await api('/api/patch/input', { controller, ...binding, runtime_instance: live.instance_id, definitions_revision: live.definitions_revision, value }); }
  catch (error) { stopPlaying(); toast(error.message); }
}
function startGlobalDrag(event, cell, controller, input) {
  if (event.button !== 0) return;
  event.preventDefault();
  if (input.binding.number === null) return;
  cancelControlDrag?.();
  const key = `${controller}:${input.key}`, startY = event.clientY, start = globalValues.get(key) ?? 64;
  let value = start;
  cell.setPointerCapture(event.pointerId); cell.classList.add('moved'); cell.dragging = true;
  const move = moveEvent => { value = detentValue(start + (startY - moveEvent.clientY) * (moveEvent.shiftKey ? 0.15 : 0.7), cell.dataset.detent === 'true'); setKnob(cell, value, { assigned: true }); };
  const cleanup = () => {
    cell.removeEventListener('pointermove', move); cell.removeEventListener('pointerup', up); cell.removeEventListener('pointercancel', cancel); cell.removeEventListener('lostpointercapture', cancel);
    cancelControlDrag = null; cell.classList.remove('moved'); cell.dragging = false;
  };
  const cancel = () => { cleanup(); setKnob(cell, globalValues.get(key), { assigned: true }); };
  const up = () => { cleanup(); if (value !== start || !globalValues.has(key)) { globalValues.set(key, value); sendInputValue(controller, input.binding, value); } };
  cancelControlDrag = cancel;
  cell.addEventListener('pointermove', move); cell.addEventListener('pointerup', up); cell.addEventListener('pointercancel', cancel); cell.addEventListener('lostpointercapture', cancel);
}

const heldInputs = new Map();
const inputWrites = new Map();
async function sendInput(controller, binding, value, releasing = false) {
  const key = `${controller}:${M.inputKey(binding)}`;
  const guard = releasing ? heldInputs.get(key) : null;
  if (!guard && (!playing || performBlocker())) return;
  const command = guard || { controller, ...binding, runtime_instance: live.instance_id, definitions_revision: live.definitions_revision };
  if (releasing) heldInputs.delete(key); else heldInputs.set(key, command);
  const pending = (inputWrites.get(key) || Promise.resolve()).catch(() => {}).then(() => api('/api/patch/input', { ...command, value }));
  inputWrites.set(key, pending);
  try { await pending; }
  catch (error) { if (!releasing) { stopPlaying(); toast(error.message); } }
  finally { if (inputWrites.get(key) === pending) inputWrites.delete(key); }
}

// ---------------------------------------------------------------- perform mode
// Edit mode: canvas controls select things to inspect and never send MIDI.
// Perform mode: dragging a control sends its final value to the running rig,
// using the same guarded endpoint as Workspace. It never re-arms by itself.

let playing = false;
function performBlocker() {
  if (!server) return 'Reading the rig…';
  if (!server.native) return 'This rig still uses the original mixer preset.';
  if (!server.running || (live && !live.running)) return 'The runtime is not running.';
  if (server.staged || live?.staged) return 'Saved settings are waiting for a runtime restart.';
  if (applying) return 'Applying changes…';
  if (dirty()) return 'Apply or discard your patch edits first.';
  if (frameDirty || frameSaving) return 'Save or discard the edits in the panel tool first.';
  if (conflict) return 'The rig changed in another editor. Reload first.';
  if (!live || !live.native || Date.now() - lastLiveRead > 2500) return 'Waiting for live values from the runtime.';
  if (live.instance_id !== server.instance_id || live.definitions_revision !== server.definitions_revision) return 'The runtime changed; reloading.';
  return null;
}
// A reason is shown as a toast so Perform never turns itself off silently.
function stopPlaying(reason = null) {
  const was = playing;
  if (was && reason) toast(`Perform stopped: ${reason}`, 'info');
  for (const command of heldInputs.values()) sendInput(command.controller, command, 0, true);
  playing = false; armedInstance = null;
  cancelControlDrag?.();
  $('play').setAttribute('aria-pressed', 'false'); $('modeEdit').setAttribute('aria-pressed', 'true');
  $('performBar').hidden = true;
  document.body.classList.remove('playing');
}
function controlForPlayback(bank, index, layer) {
  if (!playing || dirty() || frameDirty || frameSaving || conflict || applying || document.visibilityState !== 'visible' ||
      Date.now() - lastLiveRead > 2500 || armedInstance !== live?.instance_id || live?.definitions_revision !== server?.definitions_revision) return null;
  return bank === '@thru' ? M.playableDirectControl(draft, live, index) : M.playableControl(draft, live, bank, index, layer);
}
// Why a control cannot be played right now, in words (null when it can).
function playbackProblem(bank, index, layer) {
  if (!playing) return 'Perform is off.';
  if (dirty()) return 'there are unapplied edits';
  if (frameDirty || frameSaving) return 'a panel tool has unsaved edits';
  if (conflict) return 'the rig changed in another editor';
  if (applying) return 'an Apply is in progress';
  if (document.visibilityState !== 'visible') return 'the tab is hidden';
  if (Date.now() - lastLiveRead > 2500) return 'live values are more than 2.5 s old (slow connection to the rig?)';
  if (armedInstance !== live?.instance_id) return 'the runtime restarted since Perform was enabled';
  if (live?.definitions_revision !== server?.definitions_revision) return 'the rig definitions changed';
  if (bank === '@thru') return 'this direct control’s routing differs from the runtime';
  const state = live.controls.find(item => item.bank === bank && item.index === index && item.layer === layer);
  if (!state) return 'the runtime has no such control';
  if (!state.assigned) return 'this control has no parameter or send on the running rig';
  const local = bankById(bank);
  const diff = local ? M.identityDifference(state.identity, M.controlIdentity(local, index, layer)) : ['strip'];
  if (diff.length) return `the canvas and the running rig disagree about: ${diff.join(', ')}`;
  return 'this software layer is not the active one';
}
async function commitControl(cell, bank, index, layer, value) {
  const control = controlForPlayback(bank, index, layer);
  if (!control) { const why = playbackProblem(bank, index, layer); stopPlaying(); toast(`Perform stopped: ${why}.`); return; }
  setKnob(cell, value, { assigned: true });
  cell.classList.add('moved');
  try {
    await api(bank === '@thru' ? '/api/patch/thru-control' : '/api/bank-control', { bank, index, layer, value, expected: control.identity,
      runtime_instance: live.instance_id, definitions_revision: live.definitions_revision });
  } catch (error) { stopPlaying(); toast(error.message); }
  finally { cell.classList.remove('moved'); }
}
function controlKey(event, cell, bank, index, layer) {
  if (event.target !== cell) return;
  if (!playing) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInspector({ type: 'bank', id: bank, focus: `${index}:${layer}` }); }
    return;
  }
  const current = controlForPlayback(bank, index, layer);
  if (!current) return;
  let value = Number(cell.dataset.value || current.value || 0);
  const step = event.shiftKey ? 10 : 1;
  if (cell.dataset.kind === 'button' && ['Enter', ' '].includes(event.key)) value = value > 0 ? 0 : 127;
  else if (['ArrowUp', 'ArrowRight'].includes(event.key)) value += step;
  else if (['ArrowDown', 'ArrowLeft'].includes(event.key)) value -= step;
  else if (event.key === 'Home') value = 0;
  else if (event.key === 'End') value = 127;
  else if (event.key === 'Enter' && cell.dataset.detent === 'true') value = 64;
  else return;
  event.preventDefault(); event.stopPropagation();
  commitControl(cell, bank, index, layer, Math.max(0, Math.min(127, value)));
}
function startKnobDrag(event, cell, bank, index, layer) {
  if (event.button !== 0) return;
  event.preventDefault();
  const control = controlForPlayback(bank, index, layer);
  if (!control) { const why = playbackProblem(bank, index, layer); stopPlaying(); toast(`Perform stopped: ${why}.`); return; }
  if (cell.dataset.kind === 'button') return;
  cancelControlDrag?.();
  cell.setPointerCapture(event.pointerId); cell.classList.add('moved'); cell.dragging = true;
  const start = control.value ?? 64, startY = event.clientY;
  let value = start;
  const move = moveEvent => {
    value = detentValue(start + (startY - moveEvent.clientY) * (moveEvent.shiftKey ? 0.15 : 0.7), cell.dataset.detent === 'true');
    setKnob(cell, value, { assigned: true });
  };
  const cleanup = () => {
    cell.removeEventListener('pointermove', move); cell.removeEventListener('pointerup', up); cell.removeEventListener('pointercancel', cancel);
    cell.removeEventListener('lostpointercapture', cancel); cancelControlDrag = null; cell.dragging = false; cell.classList.remove('moved');
  };
  const cancel = () => { cleanup(); applyLive(); };
  const up = () => { cleanup(); if (value !== start) commitControl(cell, bank, index, layer, value); };
  cancelControlDrag = cancel;
  cell.addEventListener('pointermove', move); cell.addEventListener('pointerup', up); cell.addEventListener('pointercancel', cancel);
  cell.addEventListener('lostpointercapture', cancel);
}

function demoNoteButton() {
  const play = el('button', 'demo-note', '▶ note'); play.type = 'button'; play.title = 'Simulation: hold to send a trigger note';
  const send = velocity => api('/api/demo-note', { note: 60, velocity }).catch(error => toast(error.message));
  play.addEventListener('pointerdown', event => { event.stopPropagation(); play.setPointerCapture(event.pointerId); send(110); });
  play.addEventListener('pointerup', () => send(0));
  play.addEventListener('pointercancel', () => send(0));
  play.addEventListener('lostpointercapture', () => send(0));
  play.addEventListener('click', event => event.stopPropagation());
  return play;
}

function deviceBody(card, node) {
  if (node.input) {
    const line = el('div', 'row');
    line.append(el('small', node.twoWay ? 'two-way' : null, node.twoWay ? `⇠ two-way · listening on ${node.input}` : `in: ${node.input} · no control syncs yet`));
    line.title = 'Changes made on the device come back on this port. Controls opt in with Device sync.';
    card.append(line);
  }
  const whole = dropRow(el('div', 'row snap-row'), node.id, 'snap');
  whole.append(el('small', null, '◈ whole device (snapshot)'), el('span'), port(node.id, 'snap', 'in'));
  card.append(whole);
  if (node.acceptsNotes) {
    const line = dropRow(el('div', 'row'), node.id, 'notes');
    line.append(el('small', null, '♪ notes in'), el('span'), port(node.id, 'notes', 'in'));
    line.title = 'Drag a keyboard’s note input here to play this device';
    card.append(line);
    // One row per keyboard route that plays this device: its wire ends here.
    for (const source of node.noteSources || []) {
      const row = el('div', 'row note-source'); row.title = 'A keyboard route that plays this destination. Click its wire or its block in the controller to edit it.';
      row.append(el('small', null, `${source.label} · ${source.sub}`), el('span'), port(node.id, source.port, 'in', false));
      card.append(row);
    }
  }
  for (const channel of node.channels) {
    const line = dropRow(el('div', 'row clickable'), node.id, channel.port);
    const text = el('div', 'label'); text.append(el('span', null, channel.label));
    const chips = el('div', 'chips');
    for (const use of channel.uses.slice(0, 8)) { const chip = el('span', use.startsWith('∿') ? 'chip mod' : 'chip', use); chip.dataset.use = use; chips.append(chip); }
    if (channel.uses.length > 8) chips.append(el('span', 'chip', `+${channel.uses.length - 8}`));
    if (!channel.uses.length) chips.append(el('span', 'chip', 'unused'));
    text.append(chips);
    const details = el('div', 'midi-addresses');
    for (const address of channel.addresses) details.append(el('small', null, `${address.label} · OUT ${node.channelMode === 'selectable' ? 'channel selected per mapping' : `ch ${address.channel}`} · CC ${address.cc}`));
    text.append(details);
    line.append(text, el('span'), port(node.id, channel.port, 'in'));
    line.addEventListener('click', () => openInspector({ type: 'node', id: node.id, channel: channel.id }));
    card.append(line);
  }
}

// A snapshot node: every connection sits on its left edge. Recall / Save inputs take a controller
// button; the scope port wires out to whatever it should store: strips, device channels or a whole
// device. Nothing wired = nothing stored.
const clockTime = seconds => new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function snapshotStateText(slot, fresh = false) {
  const info = live?.snapshots_info?.[slot], saved = Boolean(live?.snapshots_saved?.[slot]);
  const queued = live?.queued_slot === slot ? '⏱ queued for the 1 · ' : '';
  if (!saved) return `${queued}○ nothing saved yet`;
  const detail = info ? `${info.saved_at ? ` ${clockTime(info.saved_at)}` : ''} · ${info.values} value${info.values === 1 ? '' : 's'}` : '';
  return `${queued}${fresh ? '✓ saved' : '● saved'}${detail}`;
}
const lastSaveStamp = new Map();
function snapshotBody(card, node) {
  const state = el('div', 'row snapshot-state'); state.dataset.snapSlot = node.slot;
  state.classList.toggle('saved', node.saved);
  state.append(el('small', null, snapshotStateText(node.slot)), el('span'), el('small', 'dim', `${node.sub} · ${node.quantize ? `recall on the 1 / ${node.quantize} bar${node.quantize === 1 ? '' : 's'}` : 'instant'}`));
  card.append(state);
  for (const [portId, label] of [['recall', 'Recall'], ['capture', 'Save']]) {
    const line = dropRow(el('div', 'row snapshot-port'), node.id, portId);
    line.append(port(node.id, portId, 'in'), el('small', null, `${label} ◂ button`));
    card.append(line);
  }
  const out = el('div', 'row snapshot-port snapshot-scope');
  out.append(port(node.id, 'out', 'out', true, 'left'), el('small', null, node.everything ? 'stores everything' : 'stores ▸ strips, channels, devices'));
  card.append(out);
  const chips = el('div', 'chips snapshot-targets');
  for (const target of node.targets) chips.append(el('span', 'chip', target.label || target.type));
  if (node.targets.length) card.append(chips);
}

// An operator node: signals come in on the left, its output goes right. Each setting is
// an input too, so a knob can set it.
function operatorBody(card, node) {
  const op = draft.performance.operators[node.op], spec = M.Ops.OP_KINDS[op.kind];
  const wrap = el('div', 'op-value'); const bar = el('span', 'op-bar'); bar.dataset.opValue = node.op; const text = el('span', 'mod-value', '—'); text.dataset.opText = node.op;
  wrap.append(bar, text); card.append(wrap);
  const signals = dropRow(el('div', 'row'), node.id, 'in');
  signals.style.minHeight = '22px'; signals.style.padding = '2px 16px';
  signals.append(el('small', null, spec.unary ? 'signal in ◂' : 'signals in ◂'), el('span', 'value', String(op.inputs.length || '—')), port(node.id, 'in', 'in'));
  card.append(signals);
  for (const param of node.params) {
    const line = dropRow(el('div', 'row'), node.id, param.port);
    line.style.minHeight = '22px'; line.style.padding = '2px 16px';
    const shown = op.kind === 'quantize' && param.name === 'scale' ? M.Ops.SCALE_NAMES[Math.round(param.value)] : op.kind === 'quantize' && param.name === 'root' ? M.NOTE_NAMES[Math.round(param.value)] : Number.isInteger(param.value) ? String(param.value) : (+param.value).toFixed(2);
    line.append(el('small', null, param.label), el('span', 'value', param.linked ? `knob · ${shown}` : shown), port(node.id, param.port, 'in'));
    card.append(line);
  }
}

function modBody(card, node) {
  const wrap = el('div', 'scope-wrap'), canvas = el('canvas', 'scope');
  canvas.width = 228; canvas.height = 34; canvas.dataset.mod = node.mod;
  const value = el('span', 'mod-value', '0.00'); value.dataset.modValue = node.mod;
  wrap.append(canvas, value); card.append(wrap);
  const mod = draft.performance.mods[node.mod];
  const values = { trigger: mod.trigger ? (mod.trigger.type === 'note' ? `note ${mod.trigger.number ?? 'any'}` : 'gate') : mod.playback === 'loop' ? 'free-running' : '—',
    enable: mod.enabled ? 'on' : 'bypassed', sync: mod.timing === 'sync' ? `${mod.beats} beats` : 'free', rate: mod.timing === 'sync' ? `${mod.beats} beats` : `${(+mod.rate).toFixed(2)} Hz`,
    amount: (+mod.amount).toFixed(2), phase: mod.shape === 'random' ? (+mod.slew).toFixed(2) : `${Math.round(mod.phase)}°`, release: `${Math.round(mod.release_ms)} ms` };
  for (const input of node.inputs) {
    const line = dropRow(el('div', 'row'), node.id, input.port);
    line.style.minHeight = '22px'; line.style.padding = '2px 16px';
    line.append(el('small', null, input.label), el('span', 'value', values[input.port]), port(node.id, input.port, 'in'));
    card.append(line);
  }
}

// Keyboard routes live inside their controller node: every setting is an input port,
// like a MOD's inputs. Drag a MOD (or a knob's ●) onto a setting to move it; the live
// value shows beside it.
const formatNoteValue = (name, value) => name === 'transpose' || name === 'velocity' ? `${value > 0 ? '+' : ''}${Math.round(value)}` : name === 'low' || name === 'high' ? M.noteName(Math.round(value))
  : name === 'root' ? M.NOTE_NAMES[((Math.round(value) % 12) + 12) % 12] : name === 'bend' ? `${value > 0 ? '+' : ''}${Math.round(value)}` : String(Math.round(value));
function keyRoutesSection(card, node) {
  for (const route of node.keyRoutes || []) {
    const block = el('div', 'key-route');
    const head = el('div', 'row clickable key-route-head');
    const title = el('div', 'label'); title.append(el('span', null, `♪ ${route.title}`), el('small', null, route.scale ? `${route.scale} · ch ${route.channel} in` : `chromatic · ch ${route.channel} in`));
    head.append(title, port(node.id, route.outPort, 'out', false));
    head.addEventListener('click', () => openInspector({ type: 'wire', id: route.wire }));
    block.append(head);
    const grid = el('div', 'key-params');
    for (const param of route.params) {
      const row = dropRow(el('div', `key-param${param.off ? ' off' : ''}${param.expression ? ' expression' : ''}`), node.id, param.port);
      const value = el('span', 'value', param.value); value.dataset.noteValue = `${route.id}:${param.name}`; value.dataset.base = param.value;
      row.append(port(node.id, param.port, 'in'), el('small', null, param.label), value);
      row.title = param.off ? 'Choose a scale on this route to use the scale key' : `Drag a MOD or a knob here to move the ${param.label}`;
      grid.append(row);
    }
    block.append(grid); card.append(block);
  }
}

function clockBody(card, node) {
  const line = el('div', 'row clickable');
  line.append(el('small', null, `${draft.performance.beats_per_bar}/${draft.performance.beat_unit} · transport ${node.transport ? 'forwarded' : 'not forwarded'}`), el('span', 'value', live?.clock?.bpm ? `${live.clock.bpm.toFixed(1)} bpm` : ''));
  line.addEventListener('click', event => openInspector({ type: 'node', id: 'clock' }, event));
  card.append(line);
  for (const portName of node.ports) { const row = el('div', 'row'); row.append(el('small', null, `→ ${portName}`)); card.append(row); }
}

function thruBody(card, node) {
  node.routes.forEach((route, index) => {
    const line = el('div', 'row clickable');
    if (route.controller) line.append(port(node.id, `route:${index}`, 'in'));
    const text = el('div', 'label');
    text.append(el('span', null, `${route.page || route.layer || 'CC'} · IN ch ${route.channel} CC ${route.cc}`),
      el('small', null, route.destinations.map(target => `${target.port} · OUT ch ${target.channel} CC ${target.cc}`).join(' + ')));
    line.append(text);
    line.addEventListener('click', event => openInspector({ type: 'node', id: 'thru', focus: index }, event));
    card.append(line);
  });
}

// ---------------------------------------------------------------- wires

function worldPoint(element) {
  const rect = element.getBoundingClientRect(), world = $('world').getBoundingClientRect();
  return { x: (rect.left + rect.width / 2 - world.left) / view.zoom, y: (rect.top + rect.height / 2 - world.top) / view.zoom };
}
// `leftOut`: the wire leaves a port on the node's left edge (a snapshot's scope), so it heads left first.
function curve(a, b, leftOut = false) {
  const dx = Math.max(50, Math.abs(b.x - a.x) * 0.45);
  const c1 = { x: a.x + (leftOut ? -dx : dx), y: a.y }, c2 = { x: b.x - dx, y: b.y };
  return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, mid: { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 } };
}
// A wire between two rows of one node: a bracket along its left edge.
function bracket(nodeId, a, b) {
  const x = layout.nodes[nodeId].x - 2, reach = 22 + Math.min(30, Math.abs(b.y - a.y) / 8);
  return { d: `M${x},${a.y} C${x - reach},${a.y} ${x - reach},${b.y} ${x},${b.y}`, mid: { x: x - reach, y: (a.y + b.y) / 2 } };
}
function endpoint(nodeId, portId) {
  const dot = portEls.get(`${nodeId}|${portId}`);
  if (dot) return worldPoint(dot);
  const card = document.querySelector(`.node[data-id="${CSS.escape(nodeId)}"] .node-head`);
  return card ? worldPoint(card) : null;
}

// Hovering a wire lights both of its connection points (and the knob or row that
// owns each), since many starts sit inside the knob grid. Hovering a connection
// point or its knob/row lights the wires that leave it.
function lightEnds(wire, on) {
  for (const end of [wire.from, wire.to]) {
    const dot = portEls.get(end.join('|'));
    const target = dot || document.querySelector(`.node[data-id="${CSS.escape(end[0])}"] .node-head`);
    target?.classList.toggle('hot', on);
    dot?.closest('.knob, .row, .key-param')?.classList.toggle('hot-end', on);
  }
}
function lightWires(dot, on) {
  const key = `${dot.dataset.node}|${dot.dataset.port}`;
  for (const wire of graph.wires) {
    if (wire.from.join('|') !== key && wire.to.join('|') !== key) continue;
    document.querySelector(`.wire[data-id="${CSS.escape(wire.id)}"]`)?.classList.toggle('flash', on);
    lightEnds(wire, on);
  }
}

// An end whose control is not drawn (another layer is showing) falls back to that
// layer's tab, then to the node header.
function wireEnd(wire, end) {
  if (!portEls.has(end.join('|')) && end[0].startsWith('ctl:')) {
    const controller = deviceById(end[0].slice(4));
    const layer = wire.kind === 'thru' ? wire.layer : wire.layer || M.bankLayerKeys(controller || {})[0];
    const tab = portEls.get(`${end[0]}|layer:${layer}`) || portEls.get(`${end[0]}|layer:${M.bankLayerKeys(controller || {})[0]}`);
    if (tab) return worldPoint(tab);
  }
  return endpoint(...end);
}

// In Per control view a strip control's wire ends on the parameter chip it drives (not just the channel row).
function chipEnd(wire) {
  if (view.detail !== 'control' || !wire.toUse) return null;
  const chip = document.querySelector(`.node[data-id="${CSS.escape(wire.to[0])}"] [data-drop-port="${CSS.escape(wire.to[1])}"] .chip[data-use="${CSS.escape(wire.toUse)}"]`);
  if (!chip) return null;
  const rect = chip.getBoundingClientRect(), world = $('world').getBoundingClientRect();
  return { x: (rect.left - world.left) / view.zoom - 2, y: (rect.top + rect.height / 2 - world.top) / view.zoom };
}

function drawWires() {
  const svg = $('wires'); svg.replaceChildren();
  const top = $('wiresTop'), stubs = [];
  const labelled = new Set();
  for (const wire of graph.wires) {
    if (!wireVisible(wire)) continue;
    const a = wireEnd(wire, wire.from), b = chipEnd(wire) || wireEnd(wire, wire.to);
    if (!a || !b) continue;
    const sameNode = wire.from[0] === wire.to[0];
    const { d, mid } = sameNode ? bracket(wire.from[0], a, b) : curve(a, b, wire.kind === 'snapshot');
    // The part of a wire that runs inside its own node (e.g. from a knob dot to the node's
    // edge) would hide under the card, so it is redrawn on top, clipped to that node.
    for (const [end, point] of [[wire.from[0], a], [wire.to[0], b]]) {
      const card = document.querySelector(`.node[data-id="${CSS.escape(end)}"]`), place = layout.nodes[end];
      if (!card || !place) continue;
      const width = card.offsetWidth, height = card.offsetHeight;
      if (point.x - place.x < 14 || place.x + width - point.x < 14 || point.y < place.y || point.y > place.y + height) continue;
      const clip = document.createElementNS(svgNS, 'clipPath'); clip.id = `clip-${stubs.length}`;
      const rect = document.createElementNS(svgNS, 'rect'); for (const [k, v] of Object.entries({ x: place.x, y: place.y, width, height })) rect.setAttribute(k, v);
      clip.append(rect);
      const holder = document.createElementNS(svgNS, 'g'); holder.classList.add('wire', 'stub'); holder.dataset.kind = wire.kind; if (wire.derived) holder.dataset.derived = 'true'; holder.setAttribute('clip-path', `url(#clip-${stubs.length})`);
      if (wire.mod !== undefined) holder.dataset.mod = wire.mod;
      const stub = document.createElementNS(svgNS, 'path'); stub.setAttribute('d', d); stub.classList.add('line');
      holder.append(stub); stubs.push(clip, holder);
    }
    const group = document.createElementNS(svgNS, 'g');
    group.classList.add('wire'); group.dataset.kind = wire.kind; group.dataset.id = wire.id;
    if (wire.derived) group.dataset.derived = 'true';
    if (wire.mod !== undefined) group.dataset.mod = wire.mod;
    if (wire.fromMod !== undefined) group.dataset.mod = wire.fromMod;
    if (wire.opOut !== undefined) group.dataset.opOut = wire.opOut;
    if (wire.bank) group.dataset.bank = wire.bank;
    if (selection?.type === 'wire' && selection.id === wire.id) group.classList.add('selected');
    const hit = document.createElementNS(svgNS, 'path'), line = document.createElementNS(svgNS, 'path');
    hit.setAttribute('d', d); hit.classList.add('hit'); line.setAttribute('d', d); line.classList.add('line');
    hit.addEventListener('click', event => { event.stopPropagation(); selectWire(wire.id, event); });
    hit.addEventListener('pointerenter', () => lightEnds(wire, true));
    hit.addEventListener('pointerleave', () => lightEnds(wire, false));
    group.append(line, hit);
    // One label per bundle avoids stacks of identical captions.
    const labelKey = `${wire.from.join('|')}>${wire.to[0]}:${wire.label}`;
    if (wire.label && !sameNode && !labelled.has(labelKey)) {
      labelled.add(labelKey);
      const text = document.createElementNS(svgNS, 'text');
      text.setAttribute('x', mid.x); text.setAttribute('y', mid.y - 4); text.setAttribute('text-anchor', 'middle'); text.textContent = wire.label;
      group.append(text);
    }
    svg.append(group);
  }
  top.replaceChildren(...stubs);
}

function selectWire(id, event) {
  selection = { type: 'wire', id };
  document.querySelectorAll('.node.selected').forEach(node => node.classList.remove('selected'));
  document.querySelectorAll('.wire.selected').forEach(node => node.classList.remove('selected'));
  document.querySelector(`.wire[data-id="${CSS.escape(id)}"]`)?.classList.add('selected');
  openInspector(selection, event);
}

// ---------------------------------------------------------------- gestures

function canDrop(fromKind, toKind, toPort) {
  return ((fromKind === 'bank' || fromKind === 'control') && toKind === 'channel') ||
    (fromKind === 'modout' && (toKind === 'keyparam' || toKind === 'channel' || (toKind === 'modin' && M.MODULATABLE.includes(toPort)))) ||
    (fromKind === 'control' && toKind === 'keyparam') ||
    (fromKind === 'snapout' && (toKind === 'reset' || toKind === 'channel' || toKind === 'devsnap')) ||
    (fromKind === 'input' && toKind === 'snapin') ||
    ((fromKind === 'modout' || fromKind === 'opout') && toKind === 'opin') || (fromKind === 'opout' && (toKind === 'channel' || toKind === 'reset')) ||
    ((fromKind === 'input' || fromKind === 'control') && (toKind === 'opin' || toKind === 'opparam')) ||
    (fromKind === 'input' && (toKind === 'modin' && toPort !== 'sync' || toKind === 'reset' || toKind === 'resetlayer' || toKind === 'devnotes' || toKind === 'keyparam')) ||
    (fromKind === 'clockout' && (toKind === 'devclock' || (toKind === 'modin' && toPort === 'sync')));
}

function startConnect(event, nodeId, portId) {
  event.preventDefault(); event.stopPropagation();
  const fromKind = M.portKind(nodeId, portId);
  const start = worldPoint(event.currentTarget), leftOut = event.currentTarget.classList.contains('left');
  const temp = document.createElementNS(svgNS, 'path'); temp.classList.add('temp-wire'); $('wires').append(temp);
  document.body.classList.add('connecting');
  for (const [key, dot] of portEls) {
    if (dot.dataset.dir !== 'in') continue;
    const [n, p] = key.split('|');
    if (canDrop(fromKind, M.portKind(n, p), p) && n !== nodeId) dot.classList.add('candidate');
  }
  let hovered = null;
  const move = moveEvent => {
    const world = $('world').getBoundingClientRect();
    const point = { x: (moveEvent.clientX - world.left) / view.zoom, y: (moveEvent.clientY - world.top) / view.zoom };
    temp.setAttribute('d', curve(start, point, leftOut).d);
    hovered?.classList.remove('drop-target');
    hovered = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-drop-node]') || null;
    if (hovered && !canDrop(fromKind, M.portKind(hovered.dataset.dropNode, hovered.dataset.dropPort), hovered.dataset.dropPort)) hovered = null;
    hovered?.classList.add('drop-target');
  };
  const up = upEvent => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    temp.remove(); document.body.classList.remove('connecting');
    document.querySelectorAll('.candidate').forEach(dot => dot.classList.remove('candidate'));
    hovered?.classList.remove('drop-target');
    const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('[data-drop-node]');
    if (!target) return;
    const to = [target.dataset.dropNode, target.dataset.dropPort];
    edit(d => M.connect(d, [nodeId, portId], to));
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

function startDrag(event, nodeId) {
  if (event.button !== 0 || event.target.closest('button, .port')) return;
  event.preventDefault();
  if (event.shiftKey) {
    if (multi.has(nodeId)) multi.delete(nodeId); else multi.add(nodeId);
    document.querySelector(`.node[data-id="${CSS.escape(nodeId)}"]`)?.classList.toggle('multi', multi.has(nodeId));
    return;
  }
  const ids = multi.has(nodeId) && multi.size > 1 ? [...multi].filter(id => layout.nodes[id]) : [nodeId];
  const cards = new Map(ids.map(id => [id, document.querySelector(`.node[data-id="${CSS.escape(id)}"]`)]));
  const origins = new Map(ids.map(id => [id, { ...layout.nodes[id] }]));
  const before = { draft: M.clone(draft), layout: M.clone(layout) };
  const startX = event.clientX, startY = event.clientY;
  for (const card of cards.values()) card?.classList.add('dragging');
  let moved = false;
  const move = moveEvent => {
    if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 3) return;
    moved = true;
    view.autoFit = false;
    for (const id of ids) {
      const origin = origins.get(id);
      const x = Math.round((origin.x + (moveEvent.clientX - startX) / view.zoom) / 8) * 8;
      const y = Math.round((origin.y + (moveEvent.clientY - startY) / view.zoom) / 8) * 8;
      layout.nodes[id] = { ...layout.nodes[id], x: Math.max(-2000, x), y: Math.max(-2000, y) };
      const card = cards.get(id); if (card) { card.style.left = `${layout.nodes[id].x}px`; card.style.top = `${layout.nodes[id].y}px`; }
    }
    drawWires();
  };
  const up = () => {
    cleanup();
    for (const card of cards.values()) card?.classList.remove('dragging');
    if (moved) { history.push(before); saveLayout(); renderStatus(); }
    else openInspector({ type: 'node', id: nodeId });
  };
  const cancel = () => {
    cleanup();
    for (const id of ids) { layout.nodes[id] = origins.get(id); const card = cards.get(id); if (card) { card.style.left = `${origins.get(id).x}px`; card.style.top = `${origins.get(id).y}px`; card.classList.remove('dragging'); } }
    drawWires();
  };
  const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel);
}

// Shift-drag on empty canvas draws a selection box; every node it touches joins the selection.
function startMarquee(event) {
  const viewport = $('viewport'), box = $('marquee'), area = viewport.getBoundingClientRect();
  const startX = event.clientX, startY = event.clientY, keep = new Set(multi);
  viewport.setPointerCapture(event.pointerId);
  box.hidden = false;
  const move = moveEvent => {
    const x1 = Math.min(startX, moveEvent.clientX), y1 = Math.min(startY, moveEvent.clientY), x2 = Math.max(startX, moveEvent.clientX), y2 = Math.max(startY, moveEvent.clientY);
    Object.assign(box.style, { left: `${x1 - area.left}px`, top: `${y1 - area.top}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });
    multi.clear(); keep.forEach(id => multi.add(id));
    for (const card of document.querySelectorAll('.node')) {
      const rect = card.getBoundingClientRect();
      const hit = rect.right >= x1 && rect.left <= x2 && rect.bottom >= y1 && rect.top <= y2;
      if (hit) multi.add(card.dataset.id);
      card.classList.toggle('multi', multi.has(card.dataset.id));
    }
  };
  const up = () => {
    viewport.removeEventListener('pointermove', move); viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up);
    box.hidden = true;
    if (multi.size) toast(`${multi.size} node${multi.size === 1 ? '' : 's'} selected: drag one to move them all. Esc or a click on empty canvas clears.`, 'info');
  };
  viewport.addEventListener('pointermove', move); viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up);
}
function clearMulti() {
  if (!multi.size) return;
  multi.clear(); document.querySelectorAll('.node.multi').forEach(card => card.classList.remove('multi'));
}

function applyTransform() { $('world').style.transform = `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`; }

function setupViewport() {
  const holderDot = event => { const holder = event.target.closest?.('.port, .knob, .row, .key-param'); return holder?.matches('.port') ? holder : holder?.querySelector(':scope > .port') || null; };
  let lit = null;
  $('nodes').addEventListener('pointerover', event => { const dot = holderDot(event); if (dot === lit) return; if (lit) lightWires(lit, false); lit = dot; if (dot && !document.body.classList.contains('connecting')) lightWires(dot, true); });
  $('nodes').addEventListener('pointerleave', () => { if (lit) lightWires(lit, false); lit = null; });
  const viewport = $('viewport');
  viewport.addEventListener('pointerdown', event => {
    if (event.target.closest('.node, .wire')) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (event.shiftKey && event.button === 0) { event.preventDefault(); startMarquee(event); return; }
    view.autoFit = false;
    viewport.setPointerCapture(event.pointerId); viewport.classList.add('panning');
    const startX = event.clientX, startY = event.clientY, origin = { ...view.pan };
    let moved = false;
    const move = moveEvent => { moved ||= Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 3; view.pan = { x: origin.x + moveEvent.clientX - startX, y: origin.y + moveEvent.clientY - startY }; applyTransform(); };
    const up = () => {
      viewport.removeEventListener('pointermove', move); viewport.removeEventListener('pointerup', up); viewport.classList.remove('panning'); saveView();
      if (!moved) { clearMulti(); selection = null; closeInspector(); document.querySelectorAll('.selected').forEach(node => node.classList.remove('selected')); }
    };
    viewport.addEventListener('pointermove', move); viewport.addEventListener('pointerup', up);
  });
  viewport.addEventListener('wheel', event => {
    if (event.target.closest('.inspector')) return;
    event.preventDefault();
    view.autoFit = false;
    if (event.ctrlKey || event.metaKey) {
      const rect = viewport.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const zoom = Math.min(1.6, Math.max(0.3, view.zoom * Math.exp(-event.deltaY * 0.01)));
      view.pan = { x: x - (x - view.pan.x) * zoom / view.zoom, y: y - (y - view.pan.y) * zoom / view.zoom };
      view.zoom = zoom;
    } else view.pan = { x: view.pan.x - event.deltaX, y: view.pan.y - event.deltaY };
    applyTransform(); clearTimeout(setupViewport.timer); setupViewport.timer = setTimeout(saveView, 300);
  }, { passive: false });
}

function fit() {
  const cards = [...document.querySelectorAll('.node')];
  if (!cards.length) return;
  const boxes = cards.map(card => { const p = layout.nodes[card.dataset.id]; return { x: p.x, y: p.y, w: card.offsetWidth, h: card.offsetHeight }; });
  const minX = Math.min(...boxes.map(b => b.x)), minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w)), maxY = Math.max(...boxes.map(b => b.y + b.h));
  const viewport = $('viewport').getBoundingClientRect();
  view.autoFit = true;
  view.zoom = Math.min(1.15, Math.max(0.1, Math.min((viewport.width - 64) / (maxX - minX), (viewport.height - 60) / (maxY - minY))));
  view.pan = { x: (viewport.width - (maxX - minX) * view.zoom) / 2 - minX * view.zoom, y: 30 - minY * view.zoom };
  applyTransform(); saveView(); requestAnimationFrame(drawWires);
}

// ---------------------------------------------------------------- inspector

function closeInspector() {
  selection = null;
  document.querySelectorAll('.node.selected, .wire.selected').forEach(item => item.classList.remove('selected'));
  renderInspector();
}

function field(label, control, extra) {
  if (control.matches('input, select, textarea') && !control.hasAttribute('aria-label')) control.setAttribute('aria-label', label);
  const row = el('label', 'field'); row.append(el('span', null, label), control);
  const topic = fieldTopic(label, inspectorTopic(selection, graph));
  if (topic) row.firstChild.append(documentationLink(topic, label, 'field-manual'));
  if (extra) { row.classList.add('inline'); row.append(extra); }
  return row;
}
function documentationLink(topic, label, className) {
  const help = el('a', `manual-link ${className}`, '↗');
  help.href = manualHref(topic); help.target = '_blank'; help.rel = 'noopener noreferrer';
  help.title = `Read about ${label} in the wiki (opens a new tab)`;
  help.setAttribute('aria-label', help.title);
  help.addEventListener('click', event => event.stopPropagation());
  return help;
}
function input(value, onChange, options = {}) {
  const node = el('input'); node.type = options.type || 'text';
  // min/max/step first: a range input clamps and rounds a value set before them to its default 0–100 scale.
  for (const key of ['min', 'max', 'step', 'placeholder']) if (options[key] !== undefined) node[key] = options[key];
  node.value = value ?? '';
  if (onChange) node.addEventListener(options.live ? 'input' : 'change', () => onChange(options.optional && node.value === '' ? '' : options.type === 'number' || options.type === 'range' ? Number(node.value) : node.value));
  return node;
}
function checkbox(checked, onChange) { const node = el('input'); node.type = 'checkbox'; node.checked = checked; node.addEventListener('change', () => onChange(node.checked)); return node; }
function select(value, options, onChange) {
  const node = el('select');
  for (const [optionValue, label] of options) { const option = el('option', null, label); option.value = String(optionValue); node.append(option); }
  node.value = String(value ?? '');
  node.addEventListener('change', () => onChange(node.value));
  return node;
}
function slider(value, min, max, step, onChange, format = v => v.toFixed(2)) {
  const out = el('output', null, format(+value));
  const node = input(value, v => onChange(v), { type: 'range', min, max, step });
  node.addEventListener('input', () => { out.textContent = format(Number(node.value)); });
  return [node, out];
}
// Explanations live behind a small “i” (hover, focus or tap) instead of
// taking up room in the panel. A hint placed anywhere inside a section is
// moved up into that section’s heading by foldHints().
function hint(text) {
  const node = el('button', 'hint-i', 'i');
  node.type = 'button'; node.dataset.tip = text;
  node.setAttribute('aria-label', 'More info'); node.title = '';
  return node;
}
// Sections fold; the open/closed choice is remembered per section name, so a
// section you collapse stays collapsed on the next control you inspect.
const DEFAULT_CLOSED = new Set(['DEVICE SYNC', 'Control appearance', 'Control layout', 'Layer switch', 'Parameters', 'Node size']);
const foldKey = title => title.split(/\s[·⇄⇠]/)[0].trim();
function group(title, ...children) {
  if (!title) { const plain = el('div', 'group'); plain.append(...children); return plain; }
  const key = foldKey(title), open = view.fold?.[key] ?? !DEFAULT_CLOSED.has(key);
  const node = el('details', 'group'); node.open = open;
  const summary = el('summary'); summary.append(el('h5', null, title), el('span', 'hints'));
  const topic = sectionTopic(title, inspectorTopic(selection, graph));
  if (topic) {
    summary.append(documentationLink(topic, foldKey(title), 'section-manual'));
  }
  const body = el('div', 'group-body'); body.append(...children);
  node.append(summary, body);
  node.addEventListener('toggle', () => { if (node.open !== (view.fold?.[key] ?? !DEFAULT_CLOSED.has(key))) { (view.fold ||= {})[key] = node.open; saveView(); } });
  return node;
}
function foldHints(root, headHints) {
  const merged = new Map();
  for (const item of [...root.querySelectorAll('.hint-i')]) {
    if (item.closest('summary') || item.closest('.field')) continue;
    const container = item.closest('details.group')?.querySelector(':scope > summary .hints') || headHints;
    if (!container) continue;
    const existing = merged.get(container);
    if (existing) { existing.dataset.tip += `\n\n${item.dataset.tip}`; item.remove(); }
    else { merged.set(container, item); container.append(item); }
  }
}
function chipToggles(items, isOn, onToggle) {
  const root = el('div', 'chip-toggles');
  for (const [value, label] of items) { const chip = button(label, () => onToggle(value)); chip.setAttribute('aria-pressed', isOn(value)); root.append(chip); }
  return root;
}
const deviceById = id => draft.setup.devices.find(device => device.id === id);
const bankById = id => draft.setup.banks.find(bank => bank.id === id);
const modName = index => draft.performance.mods[index]?.name || `MOD ${index + 1}`;

const INSPECTORS = { wire: wireInspector, node: nodeInspector, bank: bankInspector, input: inputInspector, 'add-input': addInputInspector,
  'add-controller': addControllerInspector, 'add-device': addDeviceInspector, 'add-strip': addStripInspector, 'add-thru': addThruInspector, 'add-operator': addOperatorInspector };
function openInspector(target) {
  selection = target;
  if (view.dock.tab !== 'inspect') setTab('inspect');
  if (!view.dock.open) { view.dock.open = true; saveView(); applyDock(); }
  renderInspector();
  if (target.type === 'node') {
    document.querySelectorAll('.node.selected').forEach(item => item.classList.remove('selected'));
    document.querySelector(`.node[data-id="${CSS.escape(target.id)}"]`)?.classList.add('selected');
  }
}

// Where am I? A short trail (All › Controller › Strip › Control) with every
// level clickable, and ← goes up exactly one level instead of back to the top.
function inspectorTrail(sel, title) {
  const crumbs = [{ label: 'All connections', target: null }];
  const controllerCrumb = id => { const item = deviceById(id); if (item) crumbs.push({ label: item.name, target: { type: 'node', id: `ctl:${id}` } }); };
  if (sel.type === 'bank') {
    const bank = bankById(sel.id);
    if (bank) {
      controllerCrumb(bank.controller);
      if (sel.focus) crumbs.push({ label: bank.name, target: { type: 'bank', id: bank.id } });
      crumbs.push({ label: sel.focus ? title.replace(`${bank.name} · `, '') : bank.name, target: null });
      return crumbs;
    }
  }
  if (sel.type === 'input' || sel.type === 'add-input') controllerCrumb(sel.id);
  else if (sel.type === 'add-strip' && sel.id) controllerCrumb(sel.id);
  else if (sel.type === 'node' && sel.channel !== undefined) {
    const node = graph.nodes.find(item => item.id === sel.id);
    if (node) crumbs.push({ label: node.title, target: { type: 'node', id: sel.id } });
  } else if (sel.type === 'node' && sel.id === 'thru' && sel.focus !== undefined) crumbs.push({ label: 'MIDI Thru', target: { type: 'node', id: 'thru' } });
  else if (sel.type === 'wire') { const wire = graph.wires.find(item => item.id === sel.id); if (wire) crumbs.push({ label: WIRE_LABELS[wire.kind][0], target: null }); }
  crumbs.push({ label: title, target: null });
  return crumbs.filter((crumb, i, list) => !(i && i < list.length - 1 && !crumb.label));
}
function renderTrail(sel, title) {
  const nav = $('inspectorTrail'); nav.replaceChildren();
  const crumbs = sel ? inspectorTrail(sel, title) : [{ label: 'All connections', target: null }];
  crumbs.forEach((crumb, i) => {
    const last = i === crumbs.length - 1;
    if (i) nav.append(el('span', 'sep', '›'));
    if (last) { const here = el('strong', null, crumb.label); here.title = crumb.label; here.setAttribute('aria-current', 'page'); nav.append(here); }
    else nav.append(button(crumb.label, () => (crumb.target ? openInspector(crumb.target) : closeInspector()), 'crumb'));
  });
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].target : null;
  $('inspectorBack').hidden = !sel;
  $('inspectorBack').onclick = () => (parent ? openInspector(parent) : closeInspector());
  $('inspectorBack').title = crumbs.length > 1 ? `Back to ${crumbs[crumbs.length - 2].label}` : 'Back';
}

function renderInspector() {
  const body = $('inspectorBody'), kind = $('inspectorKind');
  body.replaceChildren();
  const headHints = $('inspectorHints');
  headHints.replaceChildren();
  let title = null;
  if (selection) { try { title = INSPECTORS[selection.type](body, selection); } catch (error) { console.error(error); title = null; } }
  $('inspectorManual').href = manualHref(inspectorTopic(title ? selection : null, graph));
  if (!title) {
    selection = null; body.replaceChildren(); overview(body);
    $('inspectorTitle').textContent = 'All connections'; kind.textContent = '';
    renderTrail(null); foldHints(body, headHints);
    return;
  }
  $('inspectorTitle').textContent = title;
  if (selection.type === 'wire') { const wire = graph.wires.find(item => item.id === selection.id); kind.dataset.kind = wire.kind; kind.textContent = `wire · ${WIRE_LABELS[wire.kind][0]}`; body.prepend(el('p', 'note', describeWire(wire))); }
  else if (selection.type === 'node') { kind.dataset.kind = 'node'; kind.textContent = graph.nodes.find(item => item.id === selection.id)?.type || 'node'; }
  else { kind.dataset.kind = 'node'; kind.textContent = selection.type === 'bank' ? (selection.focus ? 'control' : 'strip') : { input: 'input', 'add-input': 'new input', 'add-controller': 'new', 'add-device': 'new', 'add-strip': 'new', 'add-thru': 'new', 'add-operator': 'new' }[selection.type]; }
  renderTrail(selection, title); foldHints(body, headHints);
}

function portName(nodeId, portId) {
  const node = graph.nodes.find(item => item.id === nodeId);
  if (!node) return '';
  if (portId.startsWith('bank:')) return bankById(portId.slice(5))?.name || '';
  if (portId.startsWith('reset:')) return `⟲ ${bankById(portId.slice(6))?.name || ''}`;
  if (portId.startsWith('resetlayer:')) return `⟲ layer ${portId.slice(11)}`;
  if (portId.startsWith('keyout:')) return `♪ ${node.keyRoutes?.find(item => item.outPort === portId)?.title.split(' → ')[0] || 'notes'}`;
  if (portId.startsWith('notes:')) return '♪ notes';
  if (portId.startsWith('key:')) return `♪ ${M.NOTE_PARAMS[portId.split(':')[2]]?.label || portId}`;
  if (portId.startsWith('ctl:')) { const [, bid, index, layer] = portId.split(':'); const bank = bankById(bid); return bank ? `${bank.name} · ${M.bindingLabel(bank, Number(index), layer, bank.controls[Number(index)][layer])}` : ''; }
  if (portId.startsWith('in:')) { const entry = node.inputs?.find(item => item.key === portId); return entry?.label || M.inputLabel(M.parseInputKey(portId)); }
  if (portId.startsWith('ch:')) return node.channels?.find(item => item.port === portId)?.label || portId;
  if (portId.startsWith('direct:')) return `direct control ${Number(portId.slice(7)) + 1}`;
  if (portId.startsWith('route:')) return `route ${Number(portId.slice(6)) + 1}`;
  if (portId.startsWith('param:')) return node.params?.find(item => item.port === portId)?.label || portId.slice(6);
  if (node.type === 'operator' && portId === 'in') return 'signal in';
  if (node.type === 'snapshot') return { capture: 'Save', recall: 'Recall' }[portId] || '';
  return portId === 'out' || portId === 'clock' ? '' : portId;
}
function describeWire(wire) {
  const title = id => graph.nodes.find(item => item.id === id)?.title || id;
  return `${title(wire.from[0])} ${portName(...wire.from)} → ${title(wire.to[0])} ${portName(...wire.to)}`.replace(/\s+/g, ' ').trim();
}

function overview(body) {
  body.append(el('p', 'note', 'Click any wire, node, strip, knob or input on the canvas to edit it here. Everything wired in this rig:'));
  body.append(button('Import saved control styles', () => {
    try {
      const saved = localStorage.getItem('midibrain.surfaces.v3') || localStorage.getItem('midibrain.surfaces.v2') || localStorage.getItem('midibrain.surfaces.v1');
      if (!saved) { toast('No earlier saved control layout in this browser.'); return; }
      const workspace = migrateWorkspace(JSON.parse(saved));
      let count = 0;
      edit((current, lay) => { count = M.importWorkspaceStyles(lay, current, workspace); });
      toast(count ? `Imported ${count} matching controls: appearance and center detents only. MIDI mappings are unchanged.` : 'No matching runtime-linked controls in the saved layout.', 'info');
    } catch (error) { toast(`Saved styles were not imported: ${error.message}`); }
  }, null, 'Migrate matching control appearances from an earlier browser layout; never changes MIDI mappings'));
  for (const kind of M.WIRE_KINDS) {
    const wires = graph.wires.filter(item => item.kind === kind);
    if (!wires.length) continue;
    const list = el('div', 'connection-list');
    for (const wire of wires) {
      const row = el('button', 'connection'); row.type = 'button';
      const swatch = el('span', 'swatch'); swatch.style.background = WIRE_LABELS[kind][1];
      row.append(swatch, el('span', null, describeWire(wire)), el('small', null, wire.label || ''));
      row.addEventListener('click', () => selectWire(wire.id));
      row.addEventListener('mouseenter', () => document.querySelector(`.wire[data-id="${CSS.escape(wire.id)}"]`)?.classList.add('flash'));
      row.addEventListener('mouseleave', () => document.querySelector(`.wire[data-id="${CSS.escape(wire.id)}"]`)?.classList.remove('flash'));
      list.append(row);
    }
    body.append(group(`${WIRE_LABELS[kind][0]} · ${wires.length}`, list));
  }
  if (!graph.wires.length) body.append(el('p', 'note', 'Nothing is wired yet. Drag from a ● output to an input.'));
}

// ---------------------------------------------------------------- dock

let frameReady = false, frameSaving = false, frameDirty = false;
// Tabs that embed a Classic editor. MIDI map can also show Classic routing
// ('controls') as its bulk editor; Inspect, MIDI map and System are native.
const TOOL_TABS = ['devices', 'clock'];
const frameTool = () => TOOL_TABS.includes(view.dock.tab) ? view.dock.tab : view.dock.tab === 'map' && view.dock.mapMode === 'classic' ? 'controls' : null;
const dockOrientation = () => ['left', 'right'].includes($('workarea').dataset.side) ? 'h' : 'v';
let navigatedAt = 0;
function postFrame(message) {
  if (!frameReady) return;
  if (message.type === 'midibrain:navigate') navigatedAt = Date.now();
  $('toolFrame').contentWindow.postMessage(message, location.origin);
}
function applyDock() {
  const area = $('workarea');
  const side = innerWidth < 760 ? 'bottom' : view.dock.side;
  area.dataset.side = side;
  area.classList.toggle('dock-hidden', !view.dock.open);
  const orientation = dockOrientation();
  area.style.setProperty('--dock-size', `${view.dock.size[orientation]}%`);
  const divider = $('divider');
  divider.setAttribute('aria-orientation', orientation === 'h' ? 'vertical' : 'horizontal');
  divider.setAttribute('aria-valuenow', String(Math.round(view.dock.size[orientation])));
  document.querySelectorAll('.dock-tools [data-side]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.side === side)));
  document.querySelectorAll('.dock-tabs [data-tab]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.tab === view.dock.tab)));
  $('dockOpen').hidden = view.dock.open;
  const tool = frameTool();
  $('inspectPane').hidden = view.dock.tab !== 'inspect';
  $('mapPane').hidden = view.dock.tab !== 'map' || Boolean(tool);
  $('systemPane').hidden = view.dock.tab !== 'system';
  $('manualFrame').hidden = view.dock.tab !== 'manual';
  $('panelManual').href = manualHref(PANEL_TOPICS[view.dock.tab]);
  $('panelManual').hidden = ['inspect', 'manual'].includes(view.dock.tab);
  if (view.dock.tab === 'manual' && !$('manualFrame').hasAttribute('src')) $('manualFrame').src = '/manual';
  $('classicBar').hidden = tool !== 'controls';
  $('toolFrame').hidden = !tool;
  if (view.dock.tab === 'map' && !tool) renderMapPane();
  if (view.dock.tab === 'system') pollSystem();
  postFrame({ type: 'midibrain:pane-layout', direction: orientation === 'h' ? 'side' : 'stack' });
  if (draft) renderToolNotice(dirty());
  requestAnimationFrame(() => { if (view.autoFit && graph.nodes.length) fit(); else drawWires(); });
}
function setTab(tab) {
  view.dock.tab = tab; view.dock.open = true; saveView(); applyDock();
  const tool = frameTool();
  // Embedded tools can save rig settings, so opening one disarms output. The
  // native MIDI map and System monitor are read-only views: Perform stays on.
  if (!tool) return;
  stopPlaying();
  const frame = $('toolFrame');
  if (!frame.hasAttribute('src')) frame.src = '/tools?embedded=true';
  else postFrame({ type: 'midibrain:navigate', workspace: tool });
}
function openClassicRouting() { view.dock.mapMode = 'classic'; setTab('map'); }

const panelContext = () => ({ draft, graph, server, live, describeWire, openInspector, edit, toast,
  openClassicRouting, restart: restartRuntime, resetView,
  refreshHz: view.refreshHz || 5, setRefreshHz: hz => { view.refreshHz = hz; saveView(); toast(hz > 5 ? `Live display at ${hz} Hz. Only this browser is affected.` : 'Live display back to the standard 5 Hz.', 'info'); },
  command: async (path, body, message) => { try { await api(path, body); toast(message, 'info'); pollSystem(); } catch (error) { toast(error.message); } } });
// The dock is set up before the rig is read; the map renders once a draft exists.
function renderMapPane() { if (draft && view.dock.tab === 'map' && !frameTool()) renderMap($('mapPane'), panelContext()); }
let systemTimer = null, systemState = null;
async function pollSystem() {
  clearTimeout(systemTimer);
  if (view.dock.tab !== 'system' || !view.dock.open) return;
  if (document.visibilityState === 'visible') {
    try { systemState = await api('/api/patch/system'); } catch (error) { systemState = null; }
    renderSystem($('systemPane'), panelContext(), systemState);
  }
  systemTimer = setTimeout(pollSystem, 1000);
}
function resetView() {
  try { localStorage.removeItem(VIEW_KEY); } catch { /* private mode */ }
  view = loadView(); saveView(); applyDock(); render(); fit();
  toast('Canvas view preferences reset in this browser.', 'info');
}
async function restartRuntime() {
  if (!confirm('Restart the runtime? MIDI ports close and reopen; saved settings become active.')) return;
  try { await api('/api/restart', {}); banner('Restarting… the page reloads when the runtime is back.', 'info'); waitForRestart(); }
  catch (error) { toast(error.message); }
}
function setDockSize(percent) {
  view.dock.size[dockOrientation()] = Math.max(18, Math.min(75, percent));
  applyDock();
}
function setupDock() {
  document.querySelectorAll('.dock-tabs [data-tab]').forEach(item => item.addEventListener('click', () => setTab(item.dataset.tab)));
  document.querySelectorAll('.dock-tools [data-side]').forEach(item => item.addEventListener('click', () => { view.dock.side = item.dataset.side; saveView(); applyDock(); }));
  $('dockClose').addEventListener('click', () => { view.dock.open = false; saveView(); applyDock(); });
  $('dockOpen').addEventListener('click', () => { view.dock.open = true; saveView(); applyDock(); });
  $('classicBack').addEventListener('click', () => { view.dock.mapMode = 'table'; saveView(); applyDock(); });
  const divider = $('divider');
  divider.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); divider.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
    const move = moveEvent => {
      const rect = $('workarea').getBoundingClientRect(), side = $('workarea').dataset.side;
      setDockSize(100 * { right: (rect.right - moveEvent.clientX) / rect.width, left: (moveEvent.clientX - rect.left) / rect.width,
        bottom: (rect.bottom - moveEvent.clientY) / rect.height, top: (moveEvent.clientY - rect.top) / rect.height }[side]);
    };
    const up = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', up); document.body.classList.remove('resizing'); saveView(); };
    divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', up);
  });
  divider.addEventListener('keydown', event => {
    const side = $('workarea').dataset.side, size = view.dock.size[dockOrientation()], step = event.shiftKey ? 10 : 2;
    const grow = { right: 'ArrowLeft', left: 'ArrowRight', bottom: 'ArrowUp', top: 'ArrowDown' }[side];
    const shrink = { right: 'ArrowRight', left: 'ArrowLeft', bottom: 'ArrowDown', top: 'ArrowUp' }[side];
    const next = event.key === grow ? size + step : event.key === shrink ? size - step : event.key === 'Home' ? 18 : event.key === 'End' ? 75 : null;
    if (next === null) return;
    event.preventDefault(); setDockSize(next); saveView();
  });
  divider.addEventListener('dblclick', () => { setDockSize(dockOrientation() === 'h' ? 32 : 40); saveView(); });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('toolFrame').contentWindow) return;
    const data = event.data || {};
    if (data.type === 'midibrain:editor-ready') {
      frameReady = true;
      postFrame({ type: 'midibrain:navigate', workspace: frameTool() || 'devices' });
      applyDock();
    }
    if (data.type === 'midibrain:editor-state') {
      const finishedSaving = frameSaving && data.saving !== true;
      frameSaving = data.saving === true;
      frameDirty = data.dirty === true;
      if (frameDirty || frameSaving) stopPlaying();
      document.querySelectorAll('.dock-tabs [data-tab]').forEach(item => item.classList.toggle('dirty', item.dataset.tab !== 'inspect' && frameDirty));
      // Follow navigation inside the embedded editor (e.g. its own links).
      const tool = frameTool();
      // A state message already in flight may still name the previous tool.
      if (tool && data.workspace !== tool && Date.now() - navigatedAt > 800) {
        if (TOOL_TABS.includes(data.workspace)) { view.dock.tab = data.workspace; saveView(); applyDock(); }
        else if (data.workspace === 'controls') { view.dock.tab = 'map'; view.dock.mapMode = 'classic'; saveView(); applyDock(); }
      }
      if (finishedSaving) refreshFromRig();
      renderStatus();
    }
  });
  window.addEventListener('resize', applyDock);
  applyDock();
  if (frameTool() && view.dock.open) setTab(view.dock.tab);
}
async function refreshFromRig() {
  stopPlaying();
  if (!dirty()) await load();
  else { conflict = true; renderStatus(); banner('Settings were saved from the panel. Your unapplied patch edits are based on the old version.', 'warn', button('Reload (discard my edits)', () => load())); }
}

// Tidy keeps your arrangement: nodes that sit roughly in a column snap into it
// (in their current top-to-bottom order, with even gaps), and columns are spaced by
// their widest node. Shift-click, or a fresh canvas, rebuilds the default columns.
function tidy({ record = true, reset = false } = {}) {
  if (record) history.push({ draft, layout });
  const cards = new Map([...document.querySelectorAll('.node')].map(card => [card.dataset.id, card]));
  const shown = graph.nodes.filter(node => cards.has(node.id));
  const widthOf = id => M.nodeWidth(layout, id) ?? cards.get(id)?.offsetWidth ?? 260;
  if (reset || shown.some(node => !layout.nodes[node.id])) {
    // Columns follow the widest node in the one before, so widened nodes never collide.
    const widest = (types, fallback) => Math.max(fallback, ...graph.nodes.filter(node => types.includes(node.type)).map(node => widthOf(node.id)));
    const middle = 40 + widest(['controller'], 320) + 110;
    // Controllers | clock, MODs, Thru | operators and snapshots (only when there are some) | devices.
    const processing = graph.nodes.some(node => ['operator', 'snapshot'].includes(node.type)) ? middle + widest(['clock', 'mod', 'thru'], 260) + 110 : null;
    const deviceX = (processing ?? middle) + (processing === null ? widest(['clock', 'mod', 'thru'], 260) : widest(['operator', 'snapshot'], 240)) + 130;
    const columns = { controller: 40, clock: middle, mod: middle, thru: middle, operator: processing, snapshot: processing, device: deviceX };
    for (const node of graph.nodes) layout.nodes[node.id] = { ...layout.nodes[node.id], x: columns[node.type], y: (layout.nodes[node.id]?.y ?? 0) };
    renderNodes();
    restack(graph.nodes.map(node => node.id));
  } else {
    const ordered = [...shown].sort((a, b) => layout.nodes[a.id].x - layout.nodes[b.id].x);
    const groups = [];
    for (const node of ordered) {
      const x = layout.nodes[node.id].x, last = groups.at(-1);
      // Same column when it starts before the previous node's right edge is passed by much.
      if (last && x - last.x < Math.max(120, last.width * 0.6)) { last.items.push(node); last.width = Math.max(last.width, widthOf(node.id)); }
      else groups.push({ x, items: [node], width: widthOf(node.id) });
    }
    let floor = -Infinity;
    for (const group of groups) {
      group.x = Math.max(Math.round(group.items.reduce((sum, node) => sum + layout.nodes[node.id].x, 0) / group.items.length / 10) * 10, floor);
      group.items.sort((a, b) => layout.nodes[a.id].y - layout.nodes[b.id].y);
      let y = Math.round(layout.nodes[group.items[0].id].y / 10) * 10;
      for (const node of group.items) {
        layout.nodes[node.id] = { ...layout.nodes[node.id], x: group.x, y };
        y += (cards.get(node.id)?.offsetHeight || 120) + 24;
      }
      floor = group.x + group.width + 110;
    }
    renderNodes();
  }
  saveLayout(); fit(); renderStatus();
}

function wireInspector(body, target) {
  const directWire = graph.wires.find(item => item.id === target.id);
  if (directWire?.kind === 'thru') return nodeInspector(body, { id: 'thru', focus: directWire.route });
  const wire = graph.wires.find(item => item.id === target.id);
  if (!wire) return null;
  const remove = button('Remove wire', () => { edit(d => M.disconnect(d, wire)); closeInspector(); }, 'danger');
  if (wire.kind === 'strip') return bankInspector(body, { id: wire.bank, focus: wire.index !== undefined ? `${wire.index}:${wire.layer}` : null, wire });
  if (wire.kind === 'send') {
    const binding = bankById(wire.bank).controls[wire.index][wire.layer], send = binding.sends[wire.send];
    const device = deviceById(send.device), channel = device.channels.find(item => item.id === send.set);
    body.append(hint(`Extra destination for ${M.bindingLabel(bankById(wire.bank), wire.index, wire.layer, binding)} on ${bankById(wire.bank).name}.`),
      field('Parameter', select(send.parameter, Object.entries(channel.parameters).map(([key, p]) => [key, p.label]), value => edit(d => { const s = d.setup.banks.find(b => b.id === wire.bank).controls[wire.index][wire.layer].sends[wire.send]; s.parameter = value; s.midi_channel = channel.parameters[value].channel; }))),
      field('Min', input(send.min ?? 0, value => edit(d => { d.setup.banks.find(b => b.id === wire.bank).controls[wire.index][wire.layer].sends[wire.send].min = value; }), { type: 'number', min: 0, max: 127 })),
      field('Max', input(send.max ?? 127, value => edit(d => { d.setup.banks.find(b => b.id === wire.bank).controls[wire.index][wire.layer].sends[wire.send].max = value; }), { type: 'number', min: 0, max: 127 })),
      field('Invert', checkbox(Boolean(send.invert), value => edit(d => { d.setup.banks.find(b => b.id === wire.bank).controls[wire.index][wire.layer].sends[wire.send].invert = value; }))),
      el('div', 'actions-row'));
    body.lastChild.append(remove);
    return `Send → ${device.name} · ${channel.name}`;
  }
  if (wire.kind === 'op') return operatorWireInspector(body, wire, remove);
  if (wire.kind === 'modamount') {
    const bank = bankById(wire.bank);
    body.append(hint(`${modName(wire.slot)}’s amount for ${bank.name}: this knob sets how much of the MOD reaches ${bank.name}’s channels. No MIDI is sent by the wire itself.`), el('div', 'actions-row'));
    body.lastChild.append(button(wire.index !== undefined ? 'Edit control' : 'Edit strip', () => openInspector({ type: 'bank', id: wire.bank, focus: wire.index !== undefined ? `${wire.index}:${wire.layer}` : null })), remove);
    return `${modName(wire.slot)} amount · ${bank.name}`;
  }
  if (wire.kind === 'snapshot') {
    body.append(hint(`${draft.performance.slots[wire.slot].name} stores this. Remove the wire to stop storing it.`), el('div', 'actions-row'));
    body.lastChild.append(button('Edit snapshot', () => openInspector({ type: 'node', id: `snap:${wire.slot}` })), remove);
    return 'Snapshot scope';
  }
  if (wire.kind === 'mod') return modWireInspector(body, wire, remove);
  if (wire.kind === 'modmod') {
    const targetMod = draft.performance.mods[wire.mod].mod_targets[wire.target];
    const [range, out] = slider(targetMod.amount, -1, 1, 0.01, value => edit(d => { d.performance.mods[wire.mod].mod_targets[wire.target].amount = value; }));
    body.append(hint(`${modName(wire.mod)}’s output bends ${modName(targetMod.mod)}. Rate: ±4 octaves at full amount (free-running MODs). Amount and slew: added. Phase: ±180°. Release: ±2000 ms.`),
      field('Modulates', select(targetMod.parameter, M.MODULATABLE.map(p => [p, p === 'phase' && draft.performance.mods[targetMod.mod].shape === 'random' ? 'slew' : p]), value => edit(d => { d.performance.mods[wire.mod].mod_targets[wire.target].parameter = value; }))),
      field('Amount', range, out), el('div', 'actions-row'));
    body.lastChild.append(remove);
    return `${modName(wire.mod)} → ${modName(targetMod.mod)}`;
  }
  if (wire.kind === 'trigger') {
    const trigger = draft.performance.mods[wire.mod].trigger;
    const set = patch => edit(d => Object.assign(d.performance.mods[wire.mod].trigger, patch));
    body.append(hint(trigger.type === 'note' ? 'Notes on this input trigger the MOD. Velocity scales strength when velocity response is on; gate envelopes hold until note-off.' : 'This input gates the MOD.'),
      field('MIDI channel', input(trigger.channel, value => set({ channel: value }), { type: 'number', min: 1, max: 16 })),
      field('Note', input(trigger.number ?? '', value => set({ number: value === '' ? null : Number(value) }), { type: 'number', min: 0, max: 127, placeholder: 'any' })),
      el('div', 'actions-row'));
    body.lastChild.append(remove);
    return `Trigger → ${modName(wire.mod)}`;
  }
  if (wire.kind === 'action') return actionWireInspector(body, wire, remove);
  if (wire.kind === 'notes') return notesWireInspector(body, wire, remove);
  if (wire.kind === 'notemod') return noteModInspector(body, wire, remove);
  if (wire.kind === 'notectl') return noteControlInspector(body, wire, remove);
  if (wire.kind === 'clock') {
    body.append(hint(wire.mod !== undefined ? `${modName(wire.mod)} follows MIDI clock: its rate is set in beats.` : `MIDI clock and ${draft.routing.clock.transport ? 'transport ' : ''}are forwarded to ${wire.port}.`));
    if (wire.mod !== undefined) {
      const mod = draft.performance.mods[wire.mod];
      body.append(field('Length', select(mod.beats, [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].map(b => [b, `${b} beat${b === 1 ? '' : 's'}`]), value => edit(d => { d.performance.mods[wire.mod].beats = Number(value); }))));
    }
    body.append(el('div', 'actions-row')); body.lastChild.append(remove);
    return wire.mod !== undefined ? `Clock → ${modName(wire.mod)}` : 'Clock → device';
  }
  return null;
}

function modulationRestingValues(device, channelIds, parameter) {
  const channels = device.channels.filter(channel => channelIds.includes(channel.id) && channel.parameters[parameter]);
  const rows = channels.map(channel => {
    const param = channel.parameters[parameter];
    const value = input(param.reset ?? '', raw => edit(d => M.setParameterReset(d, device.id, [channel.id], parameter, raw === '' ? null : raw)),
      { type: 'number', optional: true, min: param.min ?? 0, max: param.max ?? 127, placeholder: 'not set' });
    value.setAttribute('aria-label', `Resting value · ${channel.name}`);
    return field(channel.name, value);
  });
  const content = [hint('When the current parameter value is unknown, modulation uses this explicit resting value and returns to it on release. A value received from a mapped control or snapshot takes priority. These are shared device reset values, not wire output limits; explicit resets use them too. Apply to rig, then restart if prompted.')];
  const missing = channels.filter(channel => channel.parameters[parameter].reset == null);
  if (missing.length) content.push(el('p', 'note warn', `No resting value for ${missing.map(channel => channel.name).join(', ')}. Unless a mapped control or snapshot establishes a base, modulation sends nothing to these channels. Enter the intended normal value below; MIDIBRAIN cannot read the hardware fader position.`));
  content.push(...rows);
  return group('Resting values', ...content);
}

function modWireInspector(body, wire, remove) {
  const mod = draft.performance.mods[wire.mod];
  if (wire.legacy) {
    body.append(hint(wire.legacy === 'bank' ? `This route uses each strip’s ${modName(wire.mod)} amount (the strip’s depth knob). It works as-is.` : 'Legacy direct MOD route.'),
      hint('Editing converts this MOD’s routes to the unified destination list. Sound stays the same.'));
    const convert = button('Edit route', () => {
      let selected = null;
      edit(d => { const index = M.editableDestination(d, wire); const dest = d.performance.mods[wire.mod].destinations[index]; selected = dest.banks.length ? `mod:${wire.mod}:${index}:b${wire.bank}:${wire.cid}` : `mod:${wire.mod}:${index}:c${wire.cid}`; });
      if (selected) selectWire(selected);
    }, 'primary');
    body.append(el('div', 'actions-row')); body.lastChild.append(remove, convert);
    const device = deviceById(wire.to[0].slice(4));
    return `${mod.name} → ${device?.name || wire.to[0].slice(4)} · ${device?.channels.find(c => c.id === wire.cid)?.name || `ch ${wire.cid}`}`;
  }
  const destination = mod.destinations[wire.dest], device = deviceById(destination.device);
  const set = patch => edit(d => Object.assign(d.performance.mods[wire.mod].destinations[wire.dest], patch));
  const channelIds = destination.banks.length ? destination.banks.flatMap(bid => bankById(bid)?.channels || []) : destination.channels.map(cid => Array.isArray(cid) ? cid[0] : cid);
  const channels = device.channels.filter(channel => channelIds.includes(channel.id));
  const choices = M.modParameterChoices(device, channels.map(channel => channel.id), destination.parameter);
  if (destination.parameter && !choices.some(item => item.key === destination.parameter)) choices.push({ key: destination.parameter, label: `⚠ ${destination.parameter} (not on every channel)`, smooth: true });
  const options = choices.map(item => [item.key, item.smooth ? item.label : `${item.label} · will be made smooth`]);
  const volume = destination.parameter === 'volume';
  const [range, out] = slider(destination.amount, volume ? 0 : -1, 1, 0.01, value => set({ amount: value }));
  body.append(field('Parameter', select(destination.parameter, options, value => edit(d => {
      const item = d.performance.mods[wire.mod].destinations[wire.dest];
      if (value !== 'volume') M.allowModulation(d.setup.devices.find(dev => dev.id === item.device), channelIds, value);
      Object.assign(item, { parameter: value, ...(value === 'volume' && item.amount < 0 ? { amount: 1 } : {}) });
    }))),
    field(volume ? 'Duck depth' : 'Amount', range, out));
  if (!volume) body.append(field('Out min', input(destination.min ?? '', value => set({ min: value === '' ? undefined : Number(value) }), { type: 'number', optional: true, min: 0, max: 127, placeholder: 'device min' })),
    field('Out max', input(destination.max ?? '', value => set({ max: value === '' ? undefined : Number(value) }), { type: 'number', optional: true, min: 0, max: 127, placeholder: 'device max' })),
    modulationRestingValues(device, channelIds, destination.parameter));
  if (destination.banks.length) {
    body.append(group('Strips', chipToggles(draft.setup.banks.filter(b => b.destination === destination.device).map(b => [b.id, b.name]), id => destination.banks.includes(id),
      id => set({ banks: destination.banks.includes(id) ? destination.banks.filter(item => item !== id) : [...destination.banks, id] })),
      field('Scale by strip', checkbox(destination.scale_by_bank, value => set({ scale_by_bank: value }))),
      hint('Scale by strip multiplies the amount by each strip’s own MOD amount (its depth knob).')));
  } else {
    body.append(group('Channels', chipToggles(device.channels.map(c => [c.id, c.name]), id => channelIds.includes(id),
      id => set({ channels: channelIds.includes(id) ? destination.channels.filter(cid => (Array.isArray(cid) ? cid[0] : cid) !== id) : [...destination.channels, id] }))));
  }
  const shared = mod.destinations.filter(item => item !== destination && item.device === destination.device && item.parameter === destination.parameter).length;
  const others = draft.performance.mods.filter((m, i) => i !== wire.mod && m.destinations.some(item => item.device === destination.device && item.parameter === destination.parameter && item.channels.some(cid => channelIds.includes(Array.isArray(cid) ? cid[0] : cid)))).map(m => m.name);
  if (others.length) body.append(hint(`Also modulated by ${others.join(', ')}. ${volume ? 'Ducking uses the deepest.' : 'Contributions sum, then clamp to the range.'}`));
  if (shared) body.append(el('p', 'note warn', 'This MOD already routes the same parameter elsewhere on this device.'));
  body.append(el('div', 'actions-row')); body.lastChild.append(remove);
  return `${mod.name} → ${device.name}`;
}

function actionWireInspector(body, wire, remove) {
  if (wire.reset !== undefined) {
    const reset = draft.setup.resets[wire.reset];
    body.append(hint({ reset: `Resets ${bankById(reset.bank)?.name || 'all strips'} to defaults when pressed.`, depth: `This knob sets ${bankById(reset.bank)?.name}’s sidechain amount.`, release: 'This knob sets the sidechain release time.' }[reset.action || 'reset']),
      hint(`Input: CC ${reset.cc} · ch ${reset.channel} (original strip reset binding).`));
    if ((reset.action || 'reset') === 'reset') for (const bank of reset.bank ? [bankById(reset.bank)].filter(Boolean) : draft.setup.banks) {
      const { missing } = M.resetCoverage(deviceById(bank.destination), bank);
      if (missing.length) body.append(el('p', 'note warn', `${bank.name}: ${missing.map(entry => entry.label).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no reset value, so Reset leaves ${missing.length === 1 ? 'it' : 'them'} alone. Set it in the strip’s Reset values.`));
    }
    if ((reset.action || 'reset') === 'reset') body.append(field('Strip', select(reset.bank ?? '', [['', 'All strips'], ...draft.setup.banks.map(b => [b.id, b.name])], value => edit(d => { d.setup.resets[wire.reset].bank = value || null; }))));
    body.append(el('div', 'actions-row')); body.lastChild.append(remove);
    return 'Button action';
  }
  const action = draft.performance.actions[wire.action];
  if (action.action === 'reset') for (const bank of action.layer != null ? draft.setup.banks.filter(item => item.controller === action.layer_controller) : action.bank ? [bankById(action.bank)].filter(Boolean) : draft.setup.banks) {
    const { missing } = M.resetCoverage(deviceById(bank.destination), bank);
    if (missing.length) body.append(el('p', 'note warn', `${bank.name}: ${missing.map(entry => entry.label).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no reset value, so Reset leaves ${missing.length === 1 ? 'it' : 'them'} alone. Set it in the strip’s Reset values.`));
  }
  const set = patch => edit(d => Object.assign(d.performance.actions[wire.action], patch));
  const describe = { reset: action.layer != null ? `Resets every control on ${deviceById(action.layer_controller)?.name || 'the controller'}’s ${action.layer} layer to its defaults.` : `Resets ${bankById(action.bank)?.name} to its defaults.`, mod_trigger: `Triggers ${modName(action.mod)} while pressed.`, mod_enable: `Turns ${modName(action.mod)} on/off.`,
    mod_rate: `This knob sets ${modName(action.mod)}’s rate.`, mod_amount: `This knob sets ${modName(action.mod)}’s amount.`, mod_phase: `This knob sets ${modName(action.mod)}’s phase/slew.`,
    mod_release: `This knob sets ${modName(action.mod)}’s release.`, ...Object.fromEntries(Object.entries(M.NOTE_ACTIONS).map(([kind, name]) => [kind, `This knob sets the keyboard route’s ${M.NOTE_PARAMS[name].label}, across its whole range.`])), mod_depth: `This knob sets ${modName(action.mod)}’s amount on ${bankById(action.bank)?.name}.` }[action.action];
  body.append(hint(describe || ''), hint(`Input: ${M.inputLabel(action)} on ${deviceById(action.controller)?.name}.`));
  const shift = draft.performance.shift;
  body.append(field('Shift', select(action.shift || 'any', [['any', 'Always'], ['off', 'Only without Shift'], ['on', 'Only with Shift']], value => set({ shift: value }))));
  if (!shift) body.lastChild.querySelector('select').disabled = true;
  if (action.action === 'reset') body.append(field('Timing', select(action.when || 'instant', [['instant', 'Instant'], ['bar', 'On the next bar (needs clock)']], value => set({ when: value }))));
  if (!shift) body.append(hint('Give any button the Shift role to make actions Shift-dependent.'));
  body.append(el('div', 'actions-row')); body.lastChild.append(remove);
  return 'Button action';
}

// A strip's parameter choices: parameters every strip channel has, plus MOD amounts.
// A knob that feeds an operator shows that as its "parameter" instead of a bare dash.
const withOperatorLabel = (options, feeds) => feeds.length ? [['', `ƒ ${feeds.map(op => op.name).join(', ')}`], ...options.slice(1)] : options;
function stripParameterOptions(bank, current = []) {
  const device = deviceById(bank.destination);
  const keys = [...new Set([...current, ...bank.controls.flatMap(control => Object.values(control).map(binding => binding.parameter))])].filter(Boolean);
  // Strip MOD amounts are Operator inputs now (drag the knob to an Operator). The old reserved
  // parameter is only listed for a control that still uses it, flagged as legacy.
  const legacy = keys.filter(key => M.BANK_MOD_PARAMETERS.includes(key)).map(key => [key, `${modName(M.BANK_MOD_PARAMETERS.indexOf(key))} amount (old style: use an Operator)`]);
  return [['', '—'], ...M.bankParameterChoices(device, bank, keys).map(item => [item.key, item.label]), ...legacy];
}
const portOptions = (direction, current, none = '— not set —') => [['', none], ...[...new Set([...(server?.routing.available[direction] || []), ...(current ? [current] : [])])].map(p => [p, p])];
const addressText = value => value ? `ch ${value.channel} · CC ${value.cc}` : 'none';
// A keyboard route: one wire from a controller's note input to a device. Several
// wires from the same keyboard make splits and layers.
function noteField(value, onChange, label) {
  const wrap = el('span', 'pair note-pair');
  const number = input(value, null, { type: 'number', min: 0, max: 127 }); number.setAttribute('aria-label', label);
  const name = el('small', 'note-name', M.noteName(value));
  number.addEventListener('input', () => { name.textContent = M.noteName(Number(number.value) || 0); });
  number.addEventListener('change', () => onChange(Number(number.value)));
  wrap.append(number, name);
  return wrap;
}
// Everything about one keyboard route as a flat list of fields, so the same editor
// serves the wire inspector and (stacked, one per route) the keyboard input's panel.
function routeSources(route) {
  const sources = [];
  draft.performance.mods.forEach((mod, index) => sources.push([`mod:${index}`, `∿ ${mod.name}`]));
  for (const controller of draft.setup.devices.filter(item => item.kind === 'controller')) {
    for (const entry of M.controllerInputs(draft, layout, controller.id)) {
      if (entry.binding.type === 'cc' && entry.binding.number !== null) sources.push([`ctl:${controller.id}|${entry.key}`, `◉ ${controller.name} · ${entry.label || M.inputLabel(entry.binding)}`]);
    }
  }
  return sources;
}
function routeModulation(route) {
  const rows = [];
  draft.performance.mods.forEach((mod, modIndex) => (mod.note_targets || []).forEach((target, targetIndex) => {
    if (target.route !== route.id) return;
    const item = el('div', 'list-item mod-row');
    const [range, out] = slider(target.amount, -1, 1, 0.01, value => edit(d => { d.performance.mods[modIndex].note_targets[targetIndex].amount = value; }));
    const info = el('span'); info.append(button(`∿ ${mod.name} → ${M.NOTE_PARAMS[target.parameter].label}`, () => openInspector({ type: 'wire', id: `notemod:${modIndex}:${targetIndex}` }), 'link'), el('small', null, ` ${M.NOTE_PARAMS[target.parameter].span} at full`));
    const controls = el('div', 'inline-fields'); controls.append(range, out, button('×', () => edit(d => { d.performance.mods[modIndex].note_targets.splice(targetIndex, 1); }), 'danger', 'Remove this modulation'));
    item.append(info, controls); rows.push(item);
  }));
  draft.performance.actions.forEach((action, index) => {
    if (!M.NOTE_ACTIONS[action.action] || action.route !== route.id) return;
    const item = el('div', 'list-item mod-row');
    const info = el('span'); info.append(button(`◉ ${deviceById(action.controller)?.name} ${M.inputLabel(action)} → ${M.NOTE_PARAMS[M.NOTE_ACTIONS[action.action]].label}`, () => openInspector({ type: 'wire', id: `action:${index}` }), 'link'), el('small', null, ' sweeps its whole range'));
    item.append(info, button('×', () => edit(d => { d.performance.actions.splice(index, 1); }), 'danger', 'Remove this knob link'));
    rows.push(item);
  });
  for (const bank of draft.setup.banks) bank.controls.forEach((control, controlIndex) => Object.entries(control).forEach(([layer, binding]) => (binding.note_links || []).forEach((link, linkIndex) => {
    if (link.route !== route.id) return;
    const item = el('div', 'list-item mod-row');
    const info = el('span'); info.append(button(`◉ ${bank.name} · ${M.bindingLabel(bank, controlIndex, layer, binding)} → ${M.NOTE_PARAMS[link.parameter].label}`, () => openInspector({ type: 'wire', id: `notectl:${bank.id}:${controlIndex}:${layer}:${linkIndex}` }), 'link'), el('small', null, ' strip knob · sweeps its whole range'));
    item.append(info, button('×', () => edit(d => { M.disconnect(d, { kind: 'notectl', bank: bank.id, index: controlIndex, layer, link: linkIndex }); }), 'danger', 'Remove this knob link'));
    rows.push(item);
  })));
  const add = { parameter: 'transpose', source: '' };
  const sources = routeSources(route);
  const picker = el('div', 'inline-fields');
  picker.append(select('transpose', Object.entries(M.NOTE_PARAMS).map(([name, info]) => [name, info.label]), value => { add.parameter = value; }),
    select('', [['', 'from…'], ...sources], value => { add.source = value; }),
    button('+ Add', () => {
      if (!add.source) { toast('Choose a MOD or a knob to move this setting.'); return; }
      const [from, key] = add.source.split('|');
      edit(d => M.connect(d, key ? [from, key] : [from, 'out'], [`ctl:${M.noteRouteOwner(d.setup, d.routing.notes.find(item => item.id === route.id))}`, `key:${route.id}:${add.parameter}`]), { stay: true });
    }, 'primary'));
  picker.querySelectorAll('select').forEach((node, i) => node.setAttribute('aria-label', i ? 'Modulation source' : 'Keyboard setting'));
  return [...rows, ...(rows.length ? [] : [el('p', 'note', 'Nothing moves these settings yet.')]), picker];
}
// Key and scale together: “G♯ · Minor”. Choosing a key on its own switches the scale on (major).
function scaleField(route, set) {
  const row = el('div', 'field scale-field'); row.append(el('span', null, 'Scale'));
  const pair = el('div', 'inline-fields');
  const key = select(route.scale ? route.scale.root : 0, M.NOTE_NAMES.map((name, i) => [i, name]), root => set({ scale: { mode: route.scale?.mode ?? 'major', root: Number(root) } }));
  key.setAttribute('aria-label', 'Scale key'); key.title = 'Key of the scale (choosing one switches the scale on)';
  const mode = select(route.scale?.mode || 'chromatic', M.NOTE_SCALES, value => set({ scale: value === 'chromatic' ? null : { root: route.scale?.root ?? 0, mode: value } }));
  mode.setAttribute('aria-label', 'Scale');
  pair.append(key, mode); row.append(pair);
  if (!route.scale) key.classList.add('idle');
  return row;
}
function routeFields(index) {
  const route = draft.routing.notes[index];
  const device = draft.setup.devices.find(item => item.kind === 'destination' && item.output === route.port);
  const set = changes => edit(d => { Object.assign(d.routing.notes[index], changes); });
  const modulated = name => draft.performance.mods.some(mod => (mod.note_targets || []).some(target => target.route === route.id && target.parameter === name)) ||
    draft.performance.actions.some(action => M.NOTE_ACTIONS[action.action] === name && action.route === route.id);
  const tag = (name, row) => { if (modulated(name)) { row.classList.add('modulated'); row.querySelector(':scope > span').append(' ∿'); } return row; };
  let at = Math.min(route.high, Math.max(route.low + 1, 60));
  const split = button('Split here', () => {
    let created = null;
    if (edit(d => { created = M.splitNoteRoute(d, index, at); })) openInspector({ type: 'wire', id: `notes:${created}` });
  }, null, 'Keep the keys below this note on this route; the keys from it upward get a copy on the next channel');
  const heading = text => el('h6', 'route-heading', text);
  return [
    heading('Keys in'),
    field('From channel', input(route.channel, value => set({ channel: value }), { type: 'number', min: 1, max: 16 })),
    tag('low', field('Lowest key', noteField(route.low, value => set({ low: Math.min(value, route.high) }), 'Lowest key'))),
    tag('high', field('Highest key', noteField(route.high, value => set({ high: Math.max(value, route.low) }), 'Highest key'))),
    heading(`Out · ${device?.name || route.port}`),
    tag('channel', field('To MIDI channel', input(route.out_channel, value => set({ out_channel: value }), { type: 'number', min: 1, max: 16 }))),
    tag('transpose', field('Transpose (semitones)', input(route.transpose || 0, value => set({ transpose: value }), { type: 'number', min: -48, max: 48 }))),
    tag('root', scaleField(route, set)),
    field('Fixed velocity', checkbox(route.fixed_velocity != null, on => set({ fixed_velocity: on ? 100 : null }))),
    ...(route.fixed_velocity != null ? [field('Velocity', input(route.fixed_velocity, value => set({ fixed_velocity: Math.max(1, value) }), { type: 'number', min: 1, max: 127 }))] : []),
    field('Bend, aftertouch, mod wheel, sustain', checkbox(route.passthrough !== false, on => set({ passthrough: on }))),
    heading('Move these with a MOD or a knob'),
    ...routeModulation(route),
    heading('Split the keyboard'),
    field('Split at', noteField(at, value => { at = value; }, 'Split at key'), split),
  ];
}

function notesWireInspector(body, wire, remove) {
  const route = draft.routing.notes[wire.route];
  const controller = deviceById(wire.controller), device = draft.setup.devices.find(item => item.kind === 'destination' && item.output === route.port);
  body.append(group('Keyboard route', hint('Play this device from the controller’s keyboard. Notes are transposed first, then snapped to the scale, so what comes out is always in key. Anything with a ∿ is being moved by a MOD or a knob; drag a MOD or a knob’s ● onto one of the route’s settings on the controller node, or add one under “Move these…”. Split cuts the route in two so the keyboard can play different devices or channels.'), ...routeFields(wire.route)));
  const actions = el('div', 'actions-row'); actions.append(remove); body.append(actions);
  return `${controller?.name || 'Keyboard'} → ${device?.name || route.port}`;
}

function noteControlInspector(body, wire, remove) {
  const bank = bankById(wire.bank), binding = bank.controls[wire.index][wire.layer], link = binding.note_links[wire.link];
  body.append(hint(`${M.bindingLabel(bank, wire.index, wire.layer, binding)} on ${bank.name} also sweeps the keyboard’s ${M.NOTE_PARAMS[link.parameter].label} across its whole range, in addition to its own mapping. Strips and per-control wiring are unchanged.`),
    field('Setting', select(link.parameter, Object.entries(M.NOTE_PARAMS).map(([name, info]) => [name, info.label]), value => edit(d => {
      const target = d.setup.banks.find(item => item.id === wire.bank).controls[wire.index][wire.layer];
      if (target.note_links.some((item, i) => i !== wire.link && item.route === link.route && item.parameter === value)) throw new Error('That knob already moves this setting.');
      target.note_links[wire.link].parameter = value;
    }))), el('div', 'actions-row'));
  body.lastChild.append(remove);
  return `${M.bindingLabel(bank, wire.index, wire.layer, binding)} → keyboard ${M.NOTE_PARAMS[link.parameter].label}`;
}

function noteModInspector(body, wire, remove) {
  const target = draft.performance.mods[wire.mod].note_targets[wire.target];
  const [range, out] = slider(target.amount, -1, 1, 0.01, value => edit(d => { d.performance.mods[wire.mod].note_targets[wire.target].amount = value; }));
  const route = draft.routing.notes.find(item => item.id === target.route);
  const device = route && draft.setup.devices.find(item => item.kind === 'destination' && item.output === route.port);
  body.append(hint(`${modName(wire.mod)} moves the keyboard’s ${M.NOTE_PARAMS[target.parameter].label}: ${M.NOTE_PARAMS[target.parameter].span} at full amount (scaled by the MOD’s own amount). Rate changes, key ranges and transposes apply to the next note; notes already held keep what they started with.`),
    field('Setting', select(target.parameter, Object.entries(M.NOTE_PARAMS).map(([name, info]) => [name, info.label]), value => edit(d => {
      const mod = d.performance.mods[wire.mod];
      if (mod.note_targets.some((item, i) => i !== wire.target && item.route === target.route && item.parameter === value)) throw new Error('That MOD already drives this setting.');
      mod.note_targets[wire.target].parameter = value;
    }))), field('Amount', range, out), el('div', 'actions-row'));
  body.lastChild.append(remove);
  return `${modName(wire.mod)} → ${device?.name || 'keys'} ${M.NOTE_PARAMS[target.parameter].label}`;
}

function numberPair(value, onChange, labels) {
  const wrap = el('span', 'pair');
  const channel = input(value?.channel ?? 1, null, { type: 'number', min: 1, max: 16 }), cc = input(value?.cc ?? 0, null, { type: 'number', min: 0, max: 119 });
  channel.setAttribute('aria-label', labels[0]); cc.setAttribute('aria-label', labels[1]);
  const commit = () => onChange({ channel: Number(channel.value), cc: Number(cc.value) });
  channel.addEventListener('change', commit); cc.addEventListener('change', commit);
  wrap.append(el('small', null, 'ch'), channel, el('small', null, 'CC'), cc);
  return wrap;
}
async function learnInput(controller, type, status) {
  if (server.demo) throw new Error('MIDI learn needs the hardware runtime.');
  if (!controller.input) throw new Error(`Set ${controller.name}’s input port first.`);
  const armed = await api('/api/learn', { port: controller.input, type });
  status.textContent = `Move or press the control on ${controller.name}…`;
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await api(`/api/learn/${armed.id}`);
    if (result.state === 'captured') return result;
    if (result.state !== 'listening') throw new Error(`Learn ${result.state}.`);
  }
  throw new Error('Learn timed out.');
}
function sectionGroup(kind, title, ...children) { const node = group(title, ...children); node.classList.add('flow', `flow-${kind}`); return node; }

function bankInspector(body, target) {
  if (target.focus) { const title = controlInspector(body, target); if (title) return title; }
  return stripInspector(body, target);
}

// Operators that take this controller CC as a signal or to set one of their settings.
const operatorsReading = (controllerId, source) => M.operatorsReadingSource(draft, controllerId, source);

function controlInspector(body, target) {
  const bank = bankById(target.id);
  if (!bank) return null;
  const [indexText, layer] = target.focus.split(':'), index = Number(indexText);
  const control = bank.controls[index], binding = control?.[layer];
  if (!binding) return null;
  const controller = deviceById(bank.controller), device = deviceById(bank.destination);
  const bankIndex = draft.setup.banks.indexOf(bank);
  const setBinding = mutate => edit(d => mutate(d.setup.banks[bankIndex].controls[index][layer]));
  const layers = Object.keys(control);
  const name = M.bindingLabel(bank, index, layer, binding);
  if (layers.length > 1) {
    const tabs = el('div', 'layer-picker'); tabs.append(el('small', null, 'Layer'));
    for (const key of layers) { const tab = button(key, () => openInspector({ type: 'bank', id: bank.id, focus: `${index}:${key}` })); tab.setAttribute('aria-pressed', String(key === layer)); tabs.append(tab); }
    body.append(tabs);
  }
  body.append(hint(`Control ${index + 1} of ${bank.name}: ${controller.name} → ${device.name} ${bank.channels.length ? `(${bank.channels.map(cid => device.channels.find(c => c.id === cid)?.name || cid).join(', ')})` : '(no channels)'}. Each layer is its own input address with its own mapping.`));
  body.append(field('Mapping name', input(binding.label || '', value => setBinding(b => { if (value.trim()) b.label = value.trim().slice(0, 80); else delete b.label; }), { placeholder: name })));

  // IN
  const learnStatus = el('p', 'note');
  const learn = button('Learn', async () => {
    try { const result = await learnInput(controller, 'cc', learnStatus); edit(d => M.setControlInput(d, bank.id, index, layer, { channel: result.channel, cc: result.number })); }
    catch (error) { learnStatus.textContent = error.message; }
  }, null, 'Move the physical control to capture its address');
  if (server.demo || !controller.input) { learn.disabled = true; learn.title = server.demo ? 'MIDI learn needs the hardware runtime' : 'Set the controller input port first'; }
  const inputRow = el('div', 'inline-fields');
  inputRow.append(numberPair(binding.source, value => edit(d => M.setControlInput(d, bank.id, index, layer, value)), ['Input MIDI channel', 'Input CC']), learn);
  if (binding.source) inputRow.append(button('Clear', () => edit(d => M.setControlInput(d, bank.id, index, layer, null)), 'ghost', 'Remove the input address'));
  const inGroup = sectionGroup('in', `IN · from ${controller.name}`,
    hint(binding.source ? `Listening on ${controller.input || 'the controller input (port not set)'} for ${addressText(binding.source)}.` : 'Enter the channel and CC this control sends, or press Learn and move it.'),
    inputRow, learnStatus);
  if (!binding.source) inGroup.querySelector('.group-body').prepend(el('p', 'note warn', 'No input address yet: this layer never fires.'));
  body.append(inGroup);

  // OUT
  const outputs = M.controlOutputs(draft, bank.id, index, layer);
  const outGroup = sectionGroup('out', `OUT · to ${device.name}`,
    field('Parameter', select(binding.parameter ?? '', withOperatorLabel(stripParameterOptions(bank), operatorsReading(controller.id, binding.source)), value => setBinding(b => { b.parameter = value || null; }))));
  const range = el('div', 'inline-fields');
  range.append(el('small', null, 'Range'), input(binding.min ?? 0, value => setBinding(b => { b.min = value; }), { type: 'number', min: 0, max: 127 }), el('small', null, 'to'),
    input(binding.max ?? 127, value => setBinding(b => { b.max = value; }), { type: 'number', min: 0, max: 127 }));
  const invert = el('label', 'check'); invert.append(checkbox(Boolean(binding.invert), value => setBinding(b => { b.invert = value; })), 'Invert');
  range.append(invert);
  range.querySelectorAll('input[type=number]').forEach((node, i) => node.setAttribute('aria-label', i ? 'Output maximum' : 'Output minimum'));
  outGroup.append(range);
  const list = el('div', 'list');
  if (M.BANK_MOD_PARAMETERS.includes(binding.parameter)) list.append(hint(`Sets ${modName(M.BANK_MOD_PARAMETERS.indexOf(binding.parameter))}’s amount for this strip. No MIDI is sent directly.`));
  for (const out of outputs) {
    const item = el('div', 'list-item');
    item.append(el('span', null, `${out.kind === 'send' ? '+ ' : ''}${out.deviceName} · ${out.channelName} · ${out.label}`),
      el('small', null, `${out.port || 'port not set'} · ch ${out.midi} · CC ${out.cc}${out.min > 0 || out.max < 127 ? ` · ${out.min}–${out.max}` : ''}${out.invert ? ' · inv' : ''}`));
    if (out.kind === 'send') {
      const sendIndex = binding.sends.findIndex(send => send.device === out.device && send.set === out.cid && send.parameter === out.parameter);
      item.append(button('×', () => setBinding(b => { b.sends.splice(sendIndex, 1); }), 'danger', 'Remove this extra send'));
    }
    list.append(item);
  }
  const feeds = operatorsReading(controller.id, binding.source);
  for (const op of feeds) list.append(el('div', 'list-item', `ƒ Feeds ${op.name} (this knob’s value is an operator signal or setting)`));
  if (!outputs.length && !feeds.length && !M.BANK_MOD_PARAMETERS.includes(binding.parameter)) list.append(el('p', 'note', 'Sends nothing yet. Choose a parameter, or add a send below.'));
  else if (!outputs.length && feeds.length) list.append(el('p', 'note', 'No MIDI goes straight out of this knob; it only feeds the operator above.'));
  outGroup.append(list, addSendForm(bank, index, layer));
  body.append(outGroup);

  // FEEDBACK
  const fbGroup = sectionGroup('fb', `FEEDBACK ⇄ back to ${controller.name}`);
  const fbToggle = el('label', 'check');
  fbToggle.append(checkbox(Boolean(binding.feedback), on => edit(d => M.setControlFeedback(d, bank.id, index, layer, on ? (binding.source || { channel: 1, cc: index }) : null))), 'Send the value back to the controller');
  fbGroup.append(fbToggle, hint('Keeps the controller’s LED ring or motor fader in step when MIDIBRAIN changes the value: snapshot recall, reset, the canvas, or another control on the same parameter.'));
  if (binding.feedback) {
    const row = el('div', 'inline-fields'); row.append(el('small', null, 'Address'), numberPair(binding.feedback, value => edit(d => M.setControlFeedback(d, bank.id, index, layer, value)), ['Feedback MIDI channel', 'Feedback CC']));
    if (binding.source && (binding.feedback.channel !== binding.source.channel || binding.feedback.cc !== binding.source.cc)) row.append(button('Same as input', () => edit(d => M.setControlFeedback(d, bank.id, index, layer, binding.source)), 'ghost'));
    fbGroup.append(row);
    if (!controller.feedback_output) {
      fbGroup.append(el('p', 'note warn', `${controller.name} has no feedback port, so nothing is sent yet.`),
        field('Feedback port', select('', portOptions('outputs', null, '— choose —'), value => edit(d => { d.setup.devices.find(item => item.id === controller.id).feedback_output = value || null; }))));
    }
    if (bank.channels.length > 1 && binding.parameter && !M.BANK_MOD_PARAMETERS.includes(binding.parameter)) {
      fbGroup.append(field('Shows the value of', select(binding.feedback_from ?? '', [['', `${device.channels.find(c => c.id === bank.channels[0])?.name || 'First channel'} (first)`], ...bank.channels.slice(1).map(cid => [cid, device.channels.find(c => c.id === cid)?.name || `Channel ${cid}`])],
        value => setBinding(b => { if (value === '') delete b.feedback_from; else b.feedback_from = Number(value); }))),
        hint('This control drives several channels but can only show one value. If they differ (a snapshot, reset or device change touched one), the ring follows this channel.'));
    }
  }
  body.append(fbGroup);

  // DEVICE SYNC
  const deviceInput = device.input;
  const syncGroup = sectionGroup('sync', `DEVICE SYNC ⇠ changes made on ${device.name}`);
  const sync = select(binding.device_sync || 'off', Object.entries(M.DEVICE_SYNC), value => setBinding(b => { if (value === 'off') delete b.device_sync; else b.device_sync = value; }));
  syncGroup.append(field('Enable device MIDI feedback', checkbox((binding.device_sync || 'off') !== 'off', enabled => setBinding(b => { if (enabled) b.device_sync = 'track'; else delete b.device_sync; }))),
    hint('Off by default. This is separate from feedback to the controller: enable it only when your destination is physically connected in both directions.'));
  syncGroup.append(field('When the device changes', sync));
  if (!deviceInput) {
    sync.disabled = (binding.device_sync || 'off') === 'off';
    syncGroup.append(hint(`${device.name} has no input port, so MIDIBRAIN can’t hear changes made on it. Set the port it transmits on to enable sync.`),
      field('Device input port', select('', portOptions('inputs', null, '— none —'), value => edit(d => { d.setup.devices.find(item => item.id === device.id).input = value || null; }))));
  } else {
    syncGroup.append(hint(`Listening on ${deviceInput}. Track updates MIDIBRAIN (and the controller feedback) when you move this parameter on the device. Link also copies the change to this control’s other channels and sends. Echoes of MIDIBRAIN’s own output and MOD-modulated parameters are ignored.`));
  }
  body.append(syncGroup);

  // APPEARANCE
  const style = M.controlStyle(layout, bank.id, index);
  const setStyle = changes => edit((_, lay) => { lay.controls ||= {}; lay.controls[`${bank.id}:${index}`] = { ...style, ...changes }; });
  body.append(group('Control appearance',
    field('Display', select(style.kind, [['knob', 'Knob'], ['fader', 'Slider'], ['button', 'Button']], kind => setStyle({ kind }))),
    field('Center detent', checkbox(style.centerDetent, centerDetent => setStyle({ centerDetent, fillFromCenter: centerDetent }))),
    hint('Appearance is canvas-only and shared by this control’s layers. With a center detent, CC 64 is center and dragging snaps near it; double-click or Enter centers it in Perform mode.')));
  const actions = el('div', 'actions-row');
  actions.append(button(`Edit strip · ${bank.name}`, () => openInspector({ type: 'bank', id: bank.id })));
  if (target.wire) actions.append(button('Unassign this layer (all strip channels)', () => { edit(d => M.disconnect(d, target.wire)); closeInspector(); }, 'danger', 'A strip control drives every strip channel; this clears its parameter'));
  body.append(actions);
  return `${bank.name} · ${name}${layers.length > 1 ? ` · ${layer}` : ''}`;
}

function addSendForm(bank, index, layer) {
  const details = el('details', 'add-send'); details.append(el('summary', null, '+ Send this control to another device too'));
  const destinations = draft.setup.devices.filter(item => item.kind === 'destination');
  const state = { device: destinations[0]?.id, set: null, parameter: null };
  const body = el('div');
  const refresh = () => {
    body.replaceChildren();
    const device = deviceById(state.device);
    if (!device) { body.append(el('p', 'note', 'Add a destination device first.')); return; }
    state.set = device.channels.some(c => c.id === state.set) ? state.set : device.channels[0].id;
    const channel = device.channels.find(c => c.id === state.set);
    state.parameter = channel.parameters[state.parameter] ? state.parameter : Object.keys(channel.parameters)[0];
    body.append(field('Device', select(state.device, destinations.map(d => [d.id, d.name]), value => { state.device = value; refresh(); })),
      field('Channel', select(state.set, device.channels.map(c => [c.id, c.name]), value => { state.set = Number(value); refresh(); })),
      field('Parameter', select(state.parameter, Object.entries(channel.parameters).map(([key, p]) => [key, p.label]), value => { state.parameter = value; })));
    let midi = null;
    if (device.channel_mode === 'selectable') { midi = input(1, null, { type: 'number', min: 1, max: 16 }); body.append(field('MIDI channel', midi)); }
    body.append(button('Add send', () => edit(d => {
      const binding = d.setup.banks.find(b => b.id === bank.id).controls[index][layer];
      const param = d.setup.devices.find(x => x.id === state.device).channels.find(c => c.id === state.set).parameters[state.parameter];
      binding.sends ||= [];
      binding.sends.push({ device: state.device, set: state.set, parameter: state.parameter, midi_channel: midi ? Number(midi.value) : param.channel });
    }), 'primary'));
  };
  refresh(); details.append(body);
  return details;
}

// Reset buttons only move parameters that have a reset value. Set them here for the whole strip.
function resetValuesGroup(bank, device) {
  const { covered, missing } = M.resetCoverage(device, bank);
  const rows = el('div', 'list');
  for (const entry of [...covered, ...missing]) {
    const item = el('div', 'list-item');
    const value = input(entry.value ?? '', raw => edit(d => M.setParameterReset(d, device.id, bank.channels, entry.key, raw === '' || Number.isNaN(raw) ? null : Math.round(raw))), { type: 'number', optional: true, min: 0, max: 127, placeholder: 'none' });
    value.setAttribute('aria-label', `Reset value for ${entry.label}`);
    item.append(el('span', null, entry.label), value);
    if (entry.partial) item.append(el('small', 'warn', 'not set on every channel'));
    rows.append(item);
  }
  if (!rows.children.length) rows.append(el('p', 'note', 'Map a parameter first.'));
  const node = group('Reset values', hint('A strip Reset (or Reset all) sets each mapped parameter to the value here, on every channel of the strip. A parameter with no reset value is left alone, so a Reset button appears to do nothing.'), rows);
  if (missing.length) node.querySelector('.group-body')?.prepend(el('p', 'note warn', `Reset will not move: ${missing.map(entry => entry.label).join(', ')}. Give ${missing.length === 1 ? 'it' : 'them'} a reset value below.`));
  return node;
}

function stripInspector(body, target) {
  const bank = bankById(target.id);
  if (!bank) return null;
  const device = deviceById(bank.destination), controller = deviceById(bank.controller);
  const index = draft.setup.banks.indexOf(bank);
  const setBank = mutate => edit(d => { mutate(d.setup.banks[index]); M.pruneFeedbackFrom(d.setup.banks[index]); });
  // Changing the channels: when a mapped parameter has a different key on the new channel (cc1 vs cc2),
  // align the device's parameter keys by label so the mapping carries over.
  const setBankAligned = mutate => { let aligned = false; if (edit(d => { mutate(d.setup.banks[index]); M.pruneFeedbackFrom(d.setup.banks[index]); aligned = M.alignIfNeeded(d, d.setup.banks[index]); })) { if (aligned) toast('Matched this device’s parameters across channels by name, so the strip keeps its mappings. Undo reverses it.', 'info'); } };
  body.append(field('Name', input(bank.name, value => setBank(b => { b.name = value.trim() || b.name; }))),
    hint(`${controller.name} → ${device.name}. Every control in a strip sends its parameter to all of the strip’s channels. Click a control to edit its input, output and feedback.`),
    group('Channels', chipToggles(device.channels.map(c => [c.id, c.name]), id => bank.channels.includes(id),
      id => setBankAligned(b => { b.channels = b.channels.includes(id) ? b.channels.filter(c => c !== id) : [...b.channels, id].sort((x, y) => x - y); if (b.depth_overrides) { if (b.channels.includes(id)) { if (Object.keys(b.depth_overrides).length) b.depth_overrides[String(id)] = b.depth; } else delete b.depth_overrides[String(id)]; } }))));
  if (device.channel_mode === 'selectable') {
    body.append(group('MIDI channels on the device', chipToggles(Array.from({ length: 16 }, (_, i) => [i + 1, String(i + 1)]), ch => (bank.midi_channels || []).includes(ch),
      ch => setBank(b => { const list = b.midi_channels || []; b.midi_channels = list.includes(ch) ? list.filter(x => x !== ch) : [...list, ch].sort((x, y) => x - y); }))));
  }
  const options = stripParameterOptions(bank);
  if (M.bankParameterGaps(device, bank).length) body.append(button('Match parameters across channels by name', () => { let n = 0; edit(d => { n = M.alignDeviceParameters(d, device.id); }); toast(n ? `Renamed ${n} parameter keys so each channel shares them.` : 'Nothing to match: these channels really differ.', n ? 'info' : 'error'); }, null, 'Rename each channel’s parameter keys from its label (“EQ HI LEVEL CH 2” and “… CH 1” become one parameter) and update every mapping that used them'));
  for (const gap of M.bankParameterGaps(device, bank)) body.append(el('p', 'note warn', `“${gap.label}” is not on ${gap.missing.join(', ')}. The mapping is kept, but Apply is blocked until every selected channel has it. Choose another parameter or change the channels.`));
  const table = el('table', 'mapping-table');
  const head = el('tr'); for (const name of ['', 'IN', 'Parameter', 'Min', 'Max', 'Inv', 'FB']) head.append(el('th', null, name));
  table.append(head);
  bank.controls.forEach((control, controlIndex) => Object.entries(control).forEach(([layer, binding]) => {
    const row = el('tr');
    const setBinding = mutate => setBank(b => mutate(b.controls[controlIndex][layer]));
    const cell = child => { const td = el('td'); td.append(child); return td; };
    const open = button(`${M.bindingLabel(bank, controlIndex, layer, binding)}`, () => openInspector({ type: 'bank', id: bank.id, focus: `${controlIndex}:${layer}` }), 'link', 'Edit input, output and feedback');
    row.append(cell(open), cell(el('small', null, binding.source ? `${binding.source.channel}/${binding.source.cc}` : '—')),
      cell(select(binding.parameter ?? '', withOperatorLabel(options, operatorsReading(controller.id, binding.source)), value => setBinding(b => { b.parameter = value || null; }))),
      cell(input(binding.min ?? 0, value => setBinding(b => { b.min = value; }), { type: 'number', min: 0, max: 127 })),
      cell(input(binding.max ?? 127, value => setBinding(b => { b.max = value; }), { type: 'number', min: 0, max: 127 })),
      cell(checkbox(Boolean(binding.invert), value => setBinding(b => { b.invert = value; }))),
      cell(el('small', binding.feedback ? 'fb-on' : '', binding.feedback ? '⇄' : '—')));
    row.title = binding.source ? `Input ch ${binding.source.channel} CC ${binding.source.cc}${binding.feedback ? ` · feedback ch ${binding.feedback.channel} CC ${binding.feedback.cc}` : ' · no feedback'}` : 'No input address';
    table.append(row);
  }));
  body.append(group('Controls', table, hint('IN is channel/CC. ⇄ means the value is sent back to the controller. Input layers are set on the controller.')));
  body.append(resetValuesGroup(bank, device));
  const actions = el('div', 'actions-row');
  if (target.wire) actions.append(button(`Remove ${device.channels.find(c => c.id === target.wire.cid)?.name || 'channel'} from strip`, () => { edit(d => M.disconnect(d, target.wire)); closeInspector(); }, 'danger'));
  actions.append(button('Duplicate strip', () => {
    let result = null;
    if (edit((d, lay) => { result = M.duplicateStrip(d, lay, bank.id); })) {
      placeNew(`ctl:${bank.controller}`); openInspector({ type: 'bank', id: result.id });
      const where = { 'logical-channel': 'moved to the next free channel on the device (its own CCs)', 'midi-channel': 'moved to the next free MIDI channel (same CCs)', same: 'kept on the same destination channels (none were free)' }[result.placed];
      toast(result.unassigned ? `Duplicated. ${result.unassigned} control${result.unassigned === 1 ? '' : 's'} had no free CC left: give ${result.unassigned === 1 ? 'it' : 'them'} an input.` : `Duplicated with the next free input CCs; ${where}${result.mods ? `; ${result.mods} MOD route${result.mods === 1 ? '' : 's'} copied` : ''}.`, result.unassigned ? 'error' : 'info');
    }
  }, null, 'Copy this strip’s mappings to a new strip on the next free CCs and channels'));
  actions.append(button('Delete strip', () => { if (confirm(`Delete ${bank.name}? Its mappings, resets and MOD routes go too.`)) { edit((d, lay) => M.removeStrip(d, lay, bank.id)); closeInspector(); } }, 'danger'));
  body.append(actions);
  return `Strip · ${bank.name}`;
}

function layersEditor(controller) {
  const keys = M.controllerLayerKeys(controller);
  const list = el('div', 'list');
  for (const key of keys) {
    const usage = M.layerUsage(draft, controller.id, key);
    const item = el('div', 'list-item layer-row');
    const name = input(key, value => { const next = value.trim(); if (next && next !== key) edit(d => { M.renameLayer(d, controller.id, key, next); if (view.layers[controller.id] === key) view.layers[controller.id] = next; }); });
    name.setAttribute('aria-label', `Layer ${key} name`);
    item.append(name, el('small', null, usage.total ? `${usage.inputs}/${usage.total} with input · ${usage.mapped} mapped` : 'no strips yet'));
    const routing = select(controller.layer_types?.[key] || 'banked', [['banked', 'Banked'], ['direct', 'Direct · no banks']], type => edit(d => M.setLayerType(d, controller.id, key, type)));
    routing.setAttribute('aria-label', `Layer ${key} routing`); item.append(routing);
    const remove = button('×', () => {
      if (usage.mapped && !confirm(`Remove layer “${key}”? ${usage.mapped} mapped control${usage.mapped === 1 ? '' : 's'} on it go too.`)) return;
      edit(d => M.removeLayer(d, controller.id, key));
    }, 'danger', 'Remove this layer');
    remove.disabled = keys.length === 1;
    item.append(remove);
    list.append(item);
  }
  const add = el('details', 'add-layer'); add.append(el('summary', null, '+ Add layer'));
  const name = input('', null, { placeholder: keys.length === 1 ? 'alternate' : `layer${keys.length + 1}` });
  name.setAttribute('aria-label', 'New layer name');
  const copy = select('', [['', 'Start empty (no input addresses)'], ...M.bankLayerKeys(controller).map(key => [key, `Copy CC numbers from ${key}`])], value => { channelField.hidden = !value || controller.layer_mode === 'software'; });
  copy.setAttribute('aria-label', 'New layer inputs');
  const channel = input(Math.min(16, 1 + keys.length * 4), null, { type: 'number', min: 1, max: 16 });
  const channelField = field('…on MIDI channel', channel); channelField.hidden = true;
  const routingType = select('banked', [['banked', 'Banked · follows strip channels'], ['direct', 'Direct MIDI · independent of banks']], type => { copy.disabled = type === 'direct'; channelField.hidden = type === 'direct' || !copy.value || controller.layer_mode === 'software'; });
  routingType.setAttribute('aria-label', 'New layer routing');
  add.append(field('Name', name), field('Routing', routingType), field('Inputs', copy), channelField,
    hint('Banked layers follow strip targets. Direct layers have their own controls, output ports and channel/CC assignments, unaffected by strip changes. Hardware pages and encoder alternate addresses can all be shown as layers here.'),
    button('Add layer', () => {
      let created = null;
      if (edit(d => { created = M.addLayer(d, controller.id, { key: name.value, type: routingType.value, copyFrom: routingType.value === 'direct' ? null : copy.value || null, channel: Number(channel.value) }); })) { view.layers[controller.id] = created; saveView(); render(); }
    }, 'primary'));
  if (keys.length >= M.MAX_LAYERS) add.hidden = true;
  return group(`Input layers · ${keys.length}`, list, add);
}

function layerSwitchEditor(controller) {
  const set = mutate => edit(d => mutate(d.setup.devices.find(device => device.id === controller.id)));
  const keys = M.controllerLayerKeys(controller), binding = controller.layer_switch;
  if (keys.length < 2 && !binding) return null;
  // There is no separate “mode”: a controller either has a MIDI layer switch
  // (layers may reuse the same CCs; only the active layer answers) or it does not
  // (every layer listens on its own channel/CC, e.g. the Twister’s encoder-click alternate).
  const software = controller.layer_mode === 'software';
  const section = group('Layer switch', hint('Every layer needs its own MIDI input addresses. Normally each layer simply listens on different channel/CC numbers, so no switch is needed. Assign a MIDI switch instead when the controller sends the same CCs on every layer: a CC or note then chooses which layer all strips answer to. With a switch only the active layer responds, so layers using different hardware addresses will stop responding while inactive.'),
    field('Switch layers with MIDI', checkbox(Boolean(binding), enabled => set(device => {
      if (enabled) { device.layer_mode = 'software'; device.layer_switch = { type: 'cc', channel: 1, number: 119, mode: 'cycle' }; }
      else { delete device.layer_switch; device.layer_mode = 'hardware'; }
    }))));
  if (software && !binding) section.querySelector('.group-body').append(el('p', 'note warn', 'Layers are switched from the canvas only (Perform). Assign a MIDI switch to change them from the controller.'));
  if (!software) return section;
  section.querySelector('.group-body').append(field('Startup layer', select(controller.initial_layer || keys[0], keys.map(key => [key, key]), layer => set(device => { device.initial_layer = layer; }))));
  if (binding) {
    const update = changes => set(device => { Object.assign(device.layer_switch, changes); });
    section.querySelector('.group-body').append(field('Switch message', select(binding.type, [['cc', 'CC'], ['note', 'Note']], type => update({ type, ...(type === 'note' && binding.mode === 'value' ? { mode: 'cycle' } : {}) }))),
      field('Switch MIDI channel', input(binding.channel, channel => update({ channel }), { type: 'number', min: 1, max: 16 })),
      field('Switch number', input(binding.number, number => update({ number }), { type: 'number', min: 0, max: binding.type === 'cc' ? 119 : 127 })),
      field('Switch behavior', select(binding.mode, [['cycle', 'Cycle on each press'], ['momentary', 'Hold next layer; release restores'], ...(binding.type === 'cc' ? [['value', 'CC value selects a layer']] : [])], mode => update({ mode }))));
  }
  section.querySelector('.group-body').append(button('Share first layer’s input addresses', () => {
    if (!confirm('Use the first layer’s channel/CC addresses in every layer? Output assignments are kept.')) return;
    edit(d => {
      for (const bank of d.setup.banks.filter(item => item.controller === controller.id)) for (const control of bank.controls) {
        const banked = M.bankLayerKeys(controller);
        for (const key of banked.slice(1)) {
          control[key].source = M.clone(control[banked[0]].source);
          if (control[key].feedback) control[key].feedback = M.clone(control[banked[0]].feedback);
        }
      }
    });
  }), hint('In Edit, layer tabs only inspect mappings. In Perform they activate the layer. Banked and direct controls both follow the switch.'));
  return section;
}

const globalPick = new Map();
function globalInputsGroup(device, node) {
  const picked = globalPick.get(device.id) || globalPick.set(device.id, new Set()).get(device.id);
  const keys = node.inputs.map(input => input.key);
  for (const key of [...picked]) if (!keys.includes(key)) picked.delete(key);
  const list = el('div', 'list');
  for (const input of node.inputs) {
    const item = el('div', 'list-item global-row');
    const box = checkbox(picked.has(input.key), on => { if (on) picked.add(input.key); else picked.delete(input.key); renderInspector(); });
    box.setAttribute('aria-label', `Select ${input.label || M.inputLabel(input.binding)}`);
    const text = el('span'); text.append(button(input.label || M.inputLabel(input.binding), () => openInspector({ type: 'input', id: device.id, key: input.key }), 'link'));
    const sub = [input.label ? M.inputLabel(input.binding) : null, ...input.badges].filter(Boolean).join(' · ');
    if (sub) text.append(el('small', null, ` ${sub}`));
    const row = el('label', 'check'); row.append(box); item.append(row, text);
    list.append(item);
  }
  if (!node.inputs.length) list.append(el('p', 'note', 'No global inputs yet.'));
  const count = picked.size;
  const remove = button(count ? `Remove ${count} selected` : 'Remove selected', () => {
    const roles = node.inputs.filter(input => picked.has(input.key)).reduce((sum, input) => sum + input.uses.length, 0);
    if (!confirm(`Remove ${count} global input${count === 1 ? '' : 's'} from ${device.name}?${roles ? ` ${roles} role${roles === 1 ? '' : 's'}/wire${roles === 1 ? '' : 's'} using them go too.` : ''}`)) return;
    const chosen = [...picked]; picked.clear();
    edit((d, lay) => { for (const key of chosen) M.forgetInput(d, lay, device.id, key); });
  }, 'danger'); remove.disabled = !count;
  const all = button(count === keys.length && keys.length ? 'Select none' : 'Select all', () => { if (count === keys.length) picked.clear(); else keys.forEach(key => picked.add(key)); renderInspector(); }, 'ghost');
  all.disabled = !keys.length;
  const bar = el('div', 'actions-row'); bar.append(all, remove, button('+ input', () => openInspector({ type: 'add-input', id: device.id })));
  return group(`Global inputs · ${node.inputs.length}`, hint('Buttons, knobs, sliders and notes that are not part of a strip. Click a name to give it a role or wire it; tick several to remove them at once. They appear in the Global grid at the bottom of the controller node.'), list, bar);
}

function controllerInspector(body, node) {
  const device = deviceById(node.device), index = draft.setup.devices.indexOf(device);
  const set = mutate => edit(d => mutate(d.setup.devices[index]));
  const strips = draft.setup.banks.filter(bank => bank.controller === device.id);
  const globalOnly = !strips.length && M.controllerLayerKeys(device).length <= 1 && !Object.values(device.layer_types || {}).includes('direct');
  const count = input(device.controls_per_bank, value => {
    const lost = value < device.controls_per_bank && strips.some(bank => bank.controls.slice(value).some(control => Object.values(control).some(binding => binding.parameter || binding.sends?.length || binding.source)));
    if (lost && !confirm(`Reduce every strip on ${device.name} to ${value} controls? Controls ${value + 1}–${device.controls_per_bank} and their mappings go.`)) { render(); return; }
    edit(d => M.setControlsPerStrip(d, device.id, value));
  }, { type: 'number', min: 1, max: 64 });
  const list = el('div', 'list');
  for (const bank of strips) {
    const item = el('div', 'list-item clickable');
    item.append(el('span', null, bank.name), el('small', null, `→ ${deviceById(bank.destination)?.name} ${bank.channels.join(', ') || '(no channels)'}`));
    item.addEventListener('click', () => openInspector({ type: 'bank', id: bank.id }));
    list.append(item);
  }
  if (!strips.length) list.append(el('p', 'note', 'No strips yet. A strip maps a group of this controller’s knobs to channels on a device.'));
  const arrangement = M.controllerLayout(layout, device.id);
  const setArrangement = changes => edit((_, lay) => { lay.controllers ||= {}; lay.controllers[device.id] = { ...M.controllerLayout(lay, device.id), ...changes }; });
  body.append(field('Name', input(device.name, value => set(d => { d.name = value.trim() || d.name; }))),
    sectionGroup('in', 'IN · what it sends', field('Input port', select(device.input ?? '', portOptions('inputs', device.input), value => edit(d => { d.setup.devices[index].input = value || null; for (const route of d.routing.cc) if (route.controller === device.id) route.source = value || null; d.routing.notes = (d.routing.notes || []).filter(route => route.controller !== device.id || value); for (const route of d.routing.notes) if (route.controller === device.id) route.source = value; }))),
      hint('The port MIDIBRAIN listens to for this controller’s knobs, buttons and notes.')),
    sectionGroup('fb', 'FEEDBACK ⇄ what it receives back', field('Feedback port', select(device.feedback_output ?? '', portOptions('outputs', device.feedback_output, '— off —'), value => set(d => { d.feedback_output = value || null; }))),
      hint('Where MIDIBRAIN sends control values back (LED rings, motor faders). Off means controls never receive feedback. Each control chooses its feedback address in its own panel.')),
    group(`Strips · ${strips.length}`, hint('A strip is a bank of this controller’s knobs mapped to channels on a device. Click one to edit it; click a single knob on the canvas to edit just that control.'), field('Controls per strip', count), list,
      button('+ strip', () => openInspector({ type: 'add-strip', id: device.id }))),
    globalInputsGroup(device, node),
    ...(globalOnly ? [] : [layersEditor(device), layerSwitchEditor(device)].filter(Boolean)),
    ...(globalOnly ? [] : [group('Control layout · canvas only',
      field('Bank arrangement', select(arrangement.bankLayout, [['rows', 'Banks as rows'], ['columns', 'Banks as columns']], bankLayout => setArrangement({ bankLayout }))),
      field('Controls per row', input(arrangement.columns, columns => setArrangement({ columns }), { type: 'number', min: 1, max: 8 })),
      hint('Columns put each bank’s controls vertically, like the Twister. Wire sockets follow the actual bank/control positions. Direct layers use the controls-per-row grid. No MIDI assignments change.'))]));
  body.append(templateGroup(device));
  const actions = el('div', 'actions-row');
  actions.append(button('Delete controller', () => {
      if (!confirm(`Delete ${device.name}${strips.length ? ` and its ${strips.length} strip${strips.length === 1 ? '' : 's'}` : ''}? Its actions, Shift and MOD triggers go too.`)) return;
      if (edit((d, lay) => M.removeController(d, lay, device.id))) closeInspector();
    }, 'danger'));
  body.append(actions);
}

function deviceInspector(body, node, target = {}) {
  const device = deviceById(node.device), index = draft.setup.devices.indexOf(device);
  const set = mutate => edit(d => mutate(d.setup.devices[index]));
  body.append(field('Name', input(device.name, value => set(d => { d.name = value.trim() || d.name; }))),
    sectionGroup('out', 'OUT · what MIDIBRAIN sends it', field('Output port', select(device.output ?? '', portOptions('outputs', device.output), value => edit(d => { const previous = d.setup.devices[index].output; d.setup.devices[index].output = value || null; d.routing.notes = (d.routing.notes || []).filter(route => route.port !== previous || value); for (const route of d.routing.notes) if (route.port === previous) route.port = value; }) && publishNewDevices())),
      field('Send defaults at startup', checkbox(Boolean(device.initialize), value => set(d => { d.initialize = value; }))),
      hint(`${device.channels.length} channel${device.channels.length === 1 ? '' : 's'} · ${device.channel_mode || 'fixed'} channel mode. When on, MIDIBRAIN sends every parameter’s default value to this device each time the runtime starts. This is the one place to change it (System lists it read-only). It is per device and unrelated to the strip ⟲ reset buttons.`)),
    sectionGroup('sync', 'IN ⇠ what it sends back (optional)', field('Input port', select(device.input ?? '', portOptions('inputs', device.input, '— none —'), value => set(d => { d.input = value || null; }))),
      hint('Set this only if the device transmits its own knob/fader changes as MIDI. Then each control can choose Device sync in its panel so MIDIBRAIN and the controller follow changes made on the device. The device must send on the same channel/CC it receives.')));
  const list = el('div', 'list');
  for (const channel of node.channels) { const item = el('div', 'list-item'); item.append(button(channel.label, () => openInspector({ type: 'node', id: node.id, channel: channel.id }), 'link'), el('small', null, channel.uses.join(' · ') || 'unused')); list.append(item); }
  body.append(group('Channels', list));
  const selected = device.channels.find(channel => channel.id === target.channel);
  if (selected) {
    if (selected.volume) {
      const update = changes => set(current => Object.assign(current.channels.find(channel => channel.id === selected.id).volume, changes));
      body.append(group(`Volume output · ${selected.name}`,
        field('Volume MIDI channel', input(selected.volume.channel, channel => update({ channel }), { type: 'number', min: 1, max: 16 })),
        field('Volume CC', input(selected.volume.cc, cc => update({ cc }), { type: 'number', min: 0, max: 119 })),
        hint('For volume calibration curves, use the advanced Devices editor below.')));
    }
    const parameters = el('div', 'list');
    for (const [key, parameter] of Object.entries(selected.parameters)) {
      const details = el('details'); details.append(el('summary', null, `${parameter.label || key} · ch ${parameter.channel} · CC ${parameter.cc}`));
      const update = changes => set(current => Object.assign(current.channels.find(channel => channel.id === selected.id).parameters[key], changes));
      details.append(field('Parameter label', input(parameter.label || key, label => update({ label }))),
        field('MIDI channel', input(parameter.channel, channel => update({ channel }), { type: 'number', min: 1, max: 16 })),
        field('CC', input(parameter.cc, cc => update({ cc }), { type: 'number', min: 0, max: 119 })),
        field('Minimum', input(parameter.min ?? 0, min => update({ min }), { type: 'number', min: 0, max: 127 })),
        field('Maximum', input(parameter.max ?? 127, max => update({ max }), { type: 'number', min: 0, max: 127 })),
        field('Continuous', checkbox(parameter.continuous === true, continuous => update({ continuous }))));
      parameters.append(details);
    }
    body.append(group(`Parameters · ${selected.name}`, parameters));
  }
  const actions = el('div', 'actions-row');
  actions.append(button('Edit parameters (Devices)', () => setTab('devices'), null, 'CC numbers, ranges, defaults, Continuous flags and volume curves'),
    button('Delete device', () => { if (confirm(`Delete ${device.name}? Sends and MOD routes to it go too.`) && edit((d, lay) => M.removeDevice(d, lay, device.id))) closeInspector(); }, 'danger'));
  body.append(actions);
}

// ---------------------------------------------------------------- add forms

function placeNew(nodeId) {
  render();
  requestAnimationFrame(() => {
    const position = layout.nodes[nodeId], card = document.querySelector(`.node[data-id="${CSS.escape(nodeId)}"]`);
    if (!position || !card) return;
    // Pan only if the node is out of view, and only as far as needed.
    const viewport = $('viewport').getBoundingClientRect(), rect = card.getBoundingClientRect(), margin = 24;
    let dx = 0, dy = 0;
    if (rect.left < viewport.left + margin) dx = viewport.left + margin - rect.left;
    else if (rect.right > viewport.right - margin) dx = Math.max(viewport.right - margin - rect.right, viewport.left + margin - rect.left);
    if (rect.top < viewport.top + margin) dy = viewport.top + margin - rect.top;
    else if (rect.bottom > viewport.bottom - margin) dy = Math.max(viewport.bottom - margin - rect.bottom, viewport.top + margin - rect.top);
    if (dx || dy) {
      view.autoFit = false;
      view.pan = { x: view.pan.x + dx, y: view.pan.y + dy };
      applyTransform(); saveView(); requestAnimationFrame(drawWires);
    }
    card.classList.add('flash-node'); setTimeout(() => card.classList.remove('flash-node'), 900);
  });
}

// ---------------------------------------------------------------- controller templates
// Reusable hardware layouts: export one controller node as JSON, keep it in the library, or
// add a new controller from the library or a file. Ports are never copied (they are per-rig).
let templateMappings = false, templateCache = null, templateMaker = '';
const downloadJson = (name, data) => {
  const link = el('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  link.download = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'controller'}.controller.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
function templateGroup(device) {
  const build = () => T.exportController(draft, layout, device.id, { mappings: templateMappings, manufacturer: templateMaker });
  const bar = el('div', 'actions-row');
  bar.append(button('Export file', () => { downloadJson(device.name, build()); toast('Exported the controller template.', 'info'); }, null, 'Download this controller’s layout as a reusable JSON file'),
    button('Save to library', async () => {
      try { await api('/api/patch/controller-templates', build()); templateCache = null; toast(`Saved “${device.name}” to the controller library.`, 'info'); }
      catch (error) { toast(error.message); }
    }, null, 'Keep it in the library so any rig can add it from Add → Controller'));
  return group('Template',
    hint('Save this controller’s shape (strips, layers, input addresses, global inputs, how controls look) once, then add it to any rig from Add → Controller. Ports are not saved: choose them for each rig.'),
    field('Manufacturer', input(templateMaker, value => { templateMaker = value; }, { placeholder: 'e.g. Novation (groups it in the list)' })),
    field('Include parameter mappings', checkbox(templateMappings, on => { templateMappings = on; })),
    hint('Mappings keep each control’s destination parameter, range and inversion. They only apply on a rig with the same destination device.'), bar);
}
async function templateLibrary() {
  if (!templateCache) templateCache = (await api('/api/patch/controller-templates')).templates;
  return templateCache;
}
function importControllerFrom(template, destination, name) {
  let result = null;
  if (!edit((d, lay) => { result = T.importController(d, lay, template, { destination: destination || null, name: name || null }); })) return;
  placeNew(`ctl:${result.id}`); openInspector({ type: 'node', id: `ctl:${result.id}` });
  toast(`Added ${template.name}: ${result.strips} strip${result.strips === 1 ? '' : 's'}${result.skipped ? `, ${result.skipped} skipped (choose a destination device to include them)` : ''}. Set its input port.`, result.skipped ? 'error' : 'info');
}
function templatePicker(title = 'From a template') {
  const destinations = draft.setup.devices.filter(device => device.kind === 'destination');
  const state = { destination: destinations[0]?.id || '', query: '', items: [] };
  const list = el('div', 'template-groups'), status = el('p', 'note', 'Loading the library…');
  const file = el('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
  file.addEventListener('change', async () => {
    try { importControllerFrom(JSON.parse(await file.files[0].text()), state.destination); }
    catch (error) { toast(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message); }
    file.value = '';
  });
  const fill = () => {
    list.replaceChildren();
    const groups = T.groupByManufacturer(state.items, state.query);
    status.textContent = groups.length ? '' : 'No matching controllers.';
    for (const { maker, items } of groups) {
      const section = el('details', 'template-group'); section.open = Boolean(state.query) || maker === 'My templates' || groups.length === 1;
      section.append(el('summary', null, `${maker} · ${items.length}`));
      for (const template of items) {
        const row = el('div', 'list-item'), text = el('span'); text.append(el('strong', null, template.name), el('small', null, ` ${T.describeTemplate(template)}`));
        row.append(text, button('Add', () => importControllerFrom(template, state.destination), 'ghost', template.description || 'Add this controller'));
        if (template.source === 'saved') row.append(button('×', async () => { try { await api(`/api/patch/controller-templates/${encodeURIComponent(template.name)}`, null, 'DELETE'); templateCache = null; state.items = await templateLibrary(); fill(); } catch (error) { toast(error.message); } }, 'danger', 'Remove from the library'));
        section.append(row);
      }
      list.append(section);
    }
  };
  templateLibrary().then(items => { state.items = items; fill(); }).catch(error => { status.textContent = error.message; });
  const search = input('', value => { state.query = value; fill(); }, { placeholder: 'Search, e.g. Novation or knobs', live: true }); search.setAttribute('aria-label', 'Search controller templates');
  return group(title,
    hint('Pre-defined controllers grouped by manufacturer, plus the ones you saved. Strips attach to the destination device you choose; mappings are blank unless the template carries them and the device matches. Built-in layouts use factory CC numbers where the manufacturer documents them; the Generic ones are starting points.'),
    field('Strips go to', select(state.destination, [['', '— none (controller and inputs only) —'], ...destinations.map(device => [device.id, device.name])], value => { state.destination = value; })),
    field('Search', search), status, list, button('Import file…', () => file.click()), file);
}

function addControllerInspector(body) {
  const value = { name: 'New controller', input: '', feedback_output: '', controls: 8, layers: 1, kind: 'strips' };
  const stripFields = [];
  body.append(hint('A controller is anything that sends MIDI to MIDIBRAIN: knobs, faders, pads, a sequencer’s notes.'),
    field('Name', input(value.name, v => { value.name = v; }, { live: true })),
    field('Input port', select('', portOptions('inputs', null), v => { value.input = v; })),
    field('Feedback port', select('', portOptions('outputs', null, '— off —'), v => { value.feedback_output = v; })),
    field('Kind', select('strips', [['strips', 'Knobs / faders in banks (strips, layers)'], ['global', 'Keyboard, pads or buttons (global inputs only)']], v => {
      value.kind = v; stripFields.forEach(row => { row.hidden = v === 'global'; });
    })),
    ...(stripFields.push(field('Controls per strip', input(value.controls, v => { value.controls = v; }, { type: 'number', min: 1, max: 64, live: true })),
      field('Input layers', input(value.layers, v => { value.layers = v; }, { type: 'number', min: 1, max: M.MAX_LAYERS, live: true }))), stripFields),
    hint('Controls per strip is how many knobs one strip (bank) holds, e.g. 4 for a Twister column or 8 for a fader row. Layers are extra input addresses on the same controls.'));
  const actions = el('div', 'actions-row');
  actions.append(button('Create controller', () => {
    let id = null;
    if (edit(d => { id = M.addController(d, { ...value, ...(value.kind === 'global' ? { controls: 4, layers: 1 } : {}), input: value.input || null, feedback_output: value.feedback_output || null }); })) { placeNew(`ctl:${id}`); openInspector({ type: 'node', id: `ctl:${id}` }); }
  }, 'primary'));
  body.append(actions, templatePicker());
  return 'Add controller';
}

let catalogue = null;
function addDeviceInspector(body) {
  const value = { name: 'New device', output: '', input: '', channels: 1, firstChannel: 1, ccStart: 1, ccCount: 8 };
  body.append(hint('A device is something MIDIBRAIN sends to: a mixer, synth or effect. Start blank, or pull a CC map from the Pencil Research catalogue.'));
  const blank = group('Blank device',
    field('Name', input(value.name, v => { value.name = v; }, { live: true })),
    field('Output port', select('', portOptions('outputs', null), v => { value.output = v; })),
    field('Channels', input(value.channels, v => { value.channels = v; }, { type: 'number', min: 1, max: 16, live: true })),
    field('First MIDI channel', input(value.firstChannel, v => { value.firstChannel = v; }, { type: 'number', min: 1, max: 16, live: true })),
    field('CCs from', input(value.ccStart, v => { value.ccStart = v; }, { type: 'number', min: 0, max: 119, live: true })),
    field('How many CCs', input(value.ccCount, v => { value.ccCount = v; }, { type: 'number', min: 1, max: 120, live: true })),
    hint('Each channel listens on its own MIDI channel with the same CC block, all marked Continuous. Rename parameters, set ranges and defaults in Devices.'),
    button('Create device', () => {
      let id = null;
      if (edit(d => { id = M.addDevice(d, { ...value, output: value.output || null }); })) { placeNew(`dev:${id}`); openInspector({ type: 'node', id: `dev:${id}` }); publishNewDevices(); }
    }, 'primary'));
  const catalog = group('From the catalogue');
  const status = el('p', 'note', 'Needs internet. Lists manufacturer CSVs from github.com/pencilresearch/midi.');
  const results = el('div', 'list catalog-results');
  const search = input('', null, { placeholder: 'Search, e.g. Digitone or L6', live: true });
  search.setAttribute('aria-label', 'Search the catalogue');
  const showResults = () => {
    results.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const matches = (catalogue?.paths || []).filter(path => !query || path.toLowerCase().includes(query)).slice(0, 40);
    for (const path of matches) results.append(button(path.replace(/\.csv$/i, ''), async () => {
      status.textContent = `Reading ${path}…`;
      try {
        const preview = await api(`/api/catalog/preview?path=${encodeURIComponent(path)}`);
        const device = await api('/api/catalog/import', { path, revision: preview.revision, selected: preview.parameters.map(row => row.id) });
        let id = null;
        if (edit(d => { id = M.addDeviceDefinition(d, device); })) { placeNew(`dev:${id}`); openInspector({ type: 'node', id: `dev:${id}` }); toast(`Added ${device.name}: ${preview.parameters.length} parameters.${server.demo ? '' : ' Choose its output port to publish it to the Devices tab.'}`, 'info'); publishNewDevices(); }
      } catch (error) { status.textContent = error.message; }
    }, 'connection'));
    if (catalogue && !matches.length) results.append(el('p', 'note', 'No matching devices.'));
  };
  search.addEventListener('input', showResults);
  const load = button(catalogue ? 'Catalogue loaded' : 'Load catalogue', async () => {
    status.textContent = 'Loading the catalogue index…';
    try { catalogue = await api('/api/catalog'); status.textContent = `${catalogue.paths.length} device files. Search and click one to add it with all its CC parameters.`; load.disabled = true; showResults(); }
    catch (error) { status.textContent = error.message; }
  });
  catalog.append(status, load, field('Search', search), results);
  if (catalogue) showResults();
  body.append(blank, catalog, templatePicker('Controllers (templates)'));
  return 'Add destination';
}

function addStripInspector(body, target) {
  const controllers = draft.setup.devices.filter(item => item.kind === 'controller');
  const destinations = draft.setup.devices.filter(item => item.kind === 'destination');
  if (!controllers.length || !destinations.length) { body.append(el('p', 'note', 'A strip needs a controller and a destination device. Add those first.')); return 'Add strip'; }
  const state = target.state || { controller: target.id || controllers[0].id, destination: destinations[0].id, channels: [], name: '', inputs: 'empty', startCc: 0, channel: 1 };
  const rerender = () => openInspector({ type: 'add-strip', id: state.controller, state });
  const controller = deviceById(state.controller), device = deviceById(state.destination) || destinations[0];
  state.destination = device.id;
  state.channels = state.channels.filter(cid => device.channels.some(c => c.id === cid));
  body.append(hint(`A strip is a bank of ${controller.controls_per_bank} control${controller.controls_per_bank === 1 ? '' : 's'} on ${controller.name}. Each control sends its parameter to every channel you pick here.`),
    field('Controller', select(state.controller, controllers.map(c => [c.id, c.name]), v => { state.controller = v; rerender(); })),
    field('Device', select(state.destination, destinations.map(d => [d.id, d.name]), v => { state.destination = v; state.channels = []; rerender(); })),
    group('Channels', chipToggles(device.channels.map(c => [c.id, c.name]), id => state.channels.includes(id), id => { state.channels = state.channels.includes(id) ? state.channels.filter(c => c !== id) : [...state.channels, id]; rerender(); })),
    field('Name', input(state.name, v => { state.name = v; }, { placeholder: 'optional', live: true })),
    field('Inputs', select(state.inputs, [['empty', 'Set later (or Learn per control)'], ['consecutive', 'Consecutive CCs']], v => { state.inputs = v; rerender(); })));
  if (state.inputs === 'consecutive') body.append(field('First CC', input(state.startCc, v => { state.startCc = v; }, { type: 'number', min: 0, max: 119, live: true })),
    field('MIDI channel', input(state.channel, v => { state.channel = v; }, { type: 'number', min: 1, max: 16, live: true })),
    hint(`Fills the ${M.controllerLayerKeys(controller)[0]} layer${controller.feedback_output ? ', with feedback on the same addresses' : ''}.`));
  const actions = el('div', 'actions-row');
  actions.append(button('Create strip', () => {
    let id = null;
    if (edit(d => { id = M.addStrip(d, { controller: state.controller, destination: state.destination, channels: state.channels, name: state.name, startCc: state.inputs === 'consecutive' ? state.startCc : null, channel: state.channel }); })) {
      placeNew(`ctl:${state.controller}`); openInspector({ type: 'bank', id });
    }
  }, 'primary'));
  body.append(actions);
  return 'Add strip';
}

function addThruInspector(body, target = {}) {
  const available = server.routing.available;
  const value = { source: available.inputs[0] || '', channel: 1, cc: 0, port: available.outputs[0] || '', toChannel: 1, toCc: 0 };
  const controller = deviceById(target.id);
  if (controller && target.layer) {
    Object.assign(value, { source: controller.input, controller: controller.id, layer: target.layer });
    while (value.cc < 119 && M.usedInputs(draft, controller.id).has(`cc:${value.channel}:${value.cc}`)) value.cc++;
  }
  body.append(hint('Copies a raw CC from one port to another, with no parameter state, feedback or MOD. Use strips when MIDIBRAIN should know the value.'),
    field('From port', select(value.source, available.inputs.map(p => [p, p]), v => { value.source = v; })),
    field('From channel', input(value.channel, v => { value.channel = v; }, { type: 'number', min: 1, max: 16, live: true })),
    field('From CC', input(value.cc, v => { value.cc = v; }, { type: 'number', min: 0, max: 119, live: true })),
    field('To port', select(value.port, available.outputs.map(p => [p, p]), v => { value.port = v; })),
    field('To channel', input(value.toChannel, v => { value.toChannel = v; }, { type: 'number', min: 1, max: 16, live: true })),
    field('To CC', input(value.toCc, v => { value.toCc = v; }, { type: 'number', min: 0, max: 119, live: true })));
  const actions = el('div', 'actions-row');
  actions.append(button('Add route', () => { let index; if (edit(d => { index = M.addThruRoute(d, value); })) { placeNew('thru'); openInspector({ type: 'node', id: 'thru', focus: index }); } }, 'primary'));
  body.append(actions);
  return 'Add MIDI Thru route';
}

function operatorInspector(body, node) {
  const index = node.op, op = draft.performance.operators[index], spec = M.Ops.OP_KINDS[op.kind];
  const set = mutate => edit(d => mutate(d.performance.operators[index]));
  body.append(field('Name', input(op.name, value => set(o => { o.name = value.trim().slice(0, 80) || o.name; }))),
    field('Kind', select(op.kind, Object.entries(M.Ops.OP_KINDS).map(([key, item]) => [key, `${item.group} · ${item.label}`]), kind => edit(d => M.Ops.setKind(d, index, kind)))),
    hint(`${spec.help}${spec.unary && op.inputs.length > 1 ? ' Only the first input is used.' : ''}`));
  const settings = el('div', 'list');
  for (const [name, [label, , low, high, step]] of Object.entries(spec.params)) {
    if (op.kind === 'quantize' && name === 'steps' && op.params.scale > 0) continue;
    if (op.kind === 'quantize' && name === 'root' && !(op.params.scale > 0)) continue;
    const linked = op.links[name];
    let control;
    if (op.kind === 'quantize' && name === 'scale') control = select(op.params.scale, M.Ops.SCALE_NAMES.map((item, i) => [i, item]), value => set(o => { o.params.scale = Number(value); }));
    else if (op.kind === 'quantize' && name === 'root') control = select(op.params.root, M.NOTE_NAMES.map((item, i) => [i, item]), value => set(o => { o.params.root = Number(value); }));
    else { const [range, out] = slider(op.params[name], low, high, step, value => set(o => { o.params[name] = value; }), v => (Number.isInteger(step) ? String(Math.round(v)) : v.toFixed(2))); control = el('span', 'inline-fields'); control.append(range, out); }
    const row = field(label, control);
    if (linked) { const note = el('small', 'warn', `knob: CC ${linked.number} · ch ${linked.channel}`); row.append(note, button('Unlink', () => set(o => { delete o.links[name]; }), 'ghost', 'Stop this knob setting it')); }
    settings.append(row);
  }
  if (settings.children.length) body.append(group('Settings', settings, hint('Drag a controller knob onto a setting’s ● to let the knob set it across its whole range.')));
  const inputs = el('div', 'list');
  op.inputs.forEach((input, i) => {
    const item = el('div', 'list-item');
    const name = input.type === 'mod' ? modName(input.index) : input.type === 'op' ? draft.performance.operators[input.index]?.name : `${deviceById(input.controller)?.name || input.controller} · CC ${input.number} ch ${input.channel}`;
    item.append(el('span', null, `${input.type === 'mod' ? '∿' : input.type === 'op' ? 'ƒ' : '●'} ${name}`), button('×', () => set(o => { o.inputs.splice(i, 1); }), 'danger', 'Remove this input'));
    inputs.append(item);
  });
  if (!op.inputs.length) inputs.append(el('p', 'note', 'Nothing wired in. Drag a MOD’s output, a knob or another operator onto its “signals in” row.'));
  body.append(group('Signals in', inputs));
  const out = el('div', 'list');
  op.targets.forEach((target, t) => {
    const device = deviceById(target.device);
    const item = el('div', 'list-item');
    const where = [...(target.banks || []).map(id => bankById(id)?.name), ...target.channels.map(cid => device?.channels.find(c => c.id === (Array.isArray(cid) ? cid[0] : cid))?.name)].filter(Boolean).join(', ');
    const firstId = target.banks?.length ? `b${target.banks[0]}` : Array.isArray(target.channels[0]) ? target.channels[0][0] : target.channels[0];
    item.append(button(`${device?.name} · ${where} · ${target.parameter === 'volume' ? 'Volume' : M.stripLabel(device?.channels[0]?.parameters[target.parameter]?.label || target.parameter)}`, () => selectWire(`optarget:${index}:${t}:${firstId}`), 'link'));
    out.append(item);
  });
  if (!op.targets.length) out.append(el('p', 'note', 'Not driving anything. Drag its output ● onto a strip’s header (it follows that strip’s channels) or onto a device channel.'));
  body.append(group('Drives', out));
  const actions = el('div', 'actions-row');
  actions.append(button('Delete operator', () => { if (confirm(`Delete ${op.name}?`)) { edit(d => M.Ops.removeOperator(d, index)); selection = null; closeInspector(); } }, 'danger'));
  body.append(actions);
}

function addOperatorInspector(body) {
  body.append(hint('An operator reads signals (MODs, knobs, other operators), applies one math or logic function, and drives a device channel or another operator. Pick a kind; you can change it later.'));
  for (const groupName of M.Ops.OP_GROUPS) {
    const list = el('div', 'list');
    for (const [kind, spec] of Object.entries(M.Ops.OP_KINDS).filter(([, item]) => item.group === groupName)) {
      const row = el('div', 'list-item clickable'), text = el('span'); text.append(el('strong', null, spec.label), el('small', null, ` ${spec.help}`));
      row.append(text);
      row.addEventListener('click', () => { let index = null; if (edit(d => { index = M.Ops.addOperator(d, kind); })) { placeNew(`op:${index}`); openInspector({ type: 'node', id: `op:${index}` }); } });
      list.append(row);
    }
    body.append(group(groupName, list));
  }
  return 'Add operator';
}

function operatorWireInspector(body, wire, remove) {
  const op = draft.performance.operators[wire.op];
  if (wire.sub === 'in') body.append(hint(`This signal feeds ${op.name}.`));
  else if (wire.sub === 'link') body.append(hint(`This knob sets ${op.name}’s ${M.Ops.OP_KINDS[op.kind].params[wire.name]?.[0] || wire.name}, across its whole range.`));
  else {
    const target = op.targets[wire.target], device = deviceById(target.device);
    const channelIds = [...target.channels.map(cid => Array.isArray(cid) ? cid[0] : cid), ...(target.banks || []).flatMap(id => bankById(id)?.channels || [])];
    const choices = M.modParameterChoices(device, channelIds, target.parameter);
    if (!choices.some(item => item.key === target.parameter)) choices.push({ key: target.parameter, label: `⚠ ${target.parameter} (not on every channel)`, smooth: true });
    const volume = target.parameter === 'volume';
    const set = patch => edit(d => Object.assign(d.performance.operators[wire.op].targets[wire.target], patch));
    const [range, out] = slider(target.amount, volume ? 0 : -1, 1, 0.01, value => set({ amount: value }));
    body.append(hint(`${op.name}’s output is added to the parameter’s base value, like a MOD.`),
      field('Parameter', select(target.parameter, choices.map(item => [item.key, item.smooth ? item.label : `${item.label} · will be made smooth`]), value => edit(d => {
        const item = d.performance.operators[wire.op].targets[wire.target];
        if (value !== 'volume') M.allowModulation(d.setup.devices.find(dev => dev.id === item.device), channelIds, value);
        Object.assign(item, { parameter: value, ...(value === 'volume' && item.amount < 0 ? { amount: 1 } : {}) });
      }))), field(volume ? 'Duck depth' : 'Amount', range, out));
    if (!volume) body.append(field('Out min', input(target.min ?? '', value => set({ min: value === '' ? undefined : Number(value) }), { type: 'number', optional: true, min: 0, max: 127, placeholder: 'device min' })),
      field('Out max', input(target.max ?? '', value => set({ max: value === '' ? undefined : Number(value) }), { type: 'number', optional: true, min: 0, max: 127, placeholder: 'device max' })),
      modulationRestingValues(device, channelIds, target.parameter));
  }
  body.append(el('div', 'actions-row')); body.lastChild.append(button('Edit operator', () => openInspector({ type: 'node', id: `op:${wire.op}` })), remove);
  return `${op.name} · ${wire.sub === 'in' ? 'input' : wire.sub === 'link' ? 'knob' : 'output'}`;
}

function snapshotInspector(body, node) {
  const slot = node.slot, config = draft.performance.slots[slot];
  const devices = draft.setup.devices.filter(device => device.kind === 'destination');
  const has = target => (config.targets || []).some(item => item.type === target.type && item.bank === target.bank && item.device === target.device && item.channel === target.channel);
  const toggle = target => edit(d => { if (has(target)) M.Snap.removeTarget(d, slot, target); else M.Snap.addTarget(d, slot, target); });
  body.append(field('Name', input(config.name, value => edit(d => { d.performance.slots[slot].name = value.trim().slice(0, 80) || d.performance.slots[slot].name; }))),
    hint('Wire a controller button to Recall or Save, and wire this snapshot’s ▸ output to the strips or device channels it should store. With nothing wired it stores nothing. Slot ' + (slot + 1) + '.'));
  const run = action => async () => {
    const blocked = performBlocker();
    if (blocked) { toast(blocked); return; }
    try {
      if (action === 'delete') await api('/api/performance/delete', { slot });
      else await api('/api/performance/action', { action, slot });
      live = await api('/api/patch/live'); lastLiveRead = Date.now(); applyLive();
      toast(action === 'capture' ? 'Current values captured.' : action === 'delete' ? 'Saved values cleared.' : live.queued_slot === slot ? 'Recall queued for the next bar.' : 'Snapshot recalled.', 'info');
    } catch (error) { toast(error.message); }
  };
  const note = el('p', 'note'); note.dataset.snapshotStatus = '';
  const bar = el('div', 'actions-row');
  for (const [action, label] of [['capture', 'Save now'], ['recall', 'Recall now'], ['delete', 'Clear saved values']]) {
    const control = button(label, run(action)); control.dataset.snapshotAction = action; bar.append(control);
  }
  const testing = group('Test / setup', note, bar, hint('These buttons work in Edit and Perform once the rig is applied and running. No hardware button mapping is required. Recall restores parameter bases and updates mapped canvas controls and configured controller feedback; a physical controller must accept feedback to follow the recalled value.'));
  testing.dataset.snapshotActions = slot;
  body.append(testing);
  body.append(group('What it stores',
    field('Everything', checkbox(node.everything, on => { if (on) edit(d => M.Snap.addTarget(d, slot, { type: 'all' })); else edit(d => M.Snap.removeTarget(d, slot, { type: 'all' })); })),
    ...(node.everything ? [] : [
      el('h5', null, 'Strips'), chipToggles(draft.setup.banks.map(bank => [bank.id, bank.name]), id => has({ type: 'bank', bank: id }), id => toggle({ type: 'bank', bank: id })),
      el('h5', null, 'Whole devices'), chipToggles(devices.map(device => [device.id, device.name]), id => has({ type: 'device', device: id }), id => toggle({ type: 'device', device: id })),
      ...devices.flatMap(device => [el('h5', null, `${device.name} channels`), chipToggles(device.channels.map(channel => [channel.id, channel.name]), id => has({ type: 'channel', device: device.id, channel: id }), id => toggle({ type: 'channel', device: device.id, channel: id }))]),
    ])));
  body.append(group('Recall timing', field('Recall', select(config.quantize_bars || 0, [[0, 'Instantly'], [1, 'On the 1 (next bar)'], [2, 'On the 1, every 2 bars'], [4, 'On the 1, every 4 bars'], [8, 'On the 1, every 8 bars'], [16, 'On the 1, every 16 bars']],
      value => edit(d => { if (Number(value)) d.performance.slots[slot].quantize_bars = Number(value); else delete d.performance.slots[slot].quantize_bars; }))),
    hint('With a bar window, pressing the button queues the recall and it fires on the next bar line that is a multiple of the window, counted from the one. It needs running, aligned MIDI clock (set the one on the Clock tab). Pressing again replaces the queued recall; a “cancel queued” button role clears it. Bars follow Beats per bar in System.')));
  const actions = el('div', 'actions-row');
  actions.append(button('Delete snapshot', () => { if (confirm(`Delete ${config.name}? Its saved values and button wires go too.`)) { edit(d => M.Snap.removeSnapshot(d, slot)); selection = null; closeInspector(); } }, 'danger'));
  body.append(actions);
  refreshSnapshotInspector();
}

function refreshSnapshotInspector() {
  for (const group of document.querySelectorAll('[data-snapshot-actions]')) {
    const slot = Number(group.dataset.snapshotActions), saved = Boolean(live?.snapshots_saved?.[slot]), blocked = performBlocker();
    group.querySelector('[data-snapshot-status]').textContent = blocked || (live?.queued_slot === slot ? 'Recall queued for the next bar.' : saved ? `Saved${live?.snapshots_info?.[slot]?.saved_at ? ` at ${clockTime(live.snapshots_info[slot].saved_at)}` : ''}${live?.snapshots_info?.[slot] ? ` · ${live.snapshots_info[slot].values} values` : ''}. Recall restores them; Save replaces them.` : 'Nothing saved yet. Set your controls, then Save now.');
    for (const control of group.querySelectorAll('[data-snapshot-action]')) control.disabled = Boolean(blocked) || (control.dataset.snapshotAction !== 'capture' && !saved);
  }
}

function nodeInspector(body, target) {
  const node = graph.nodes.find(item => item.id === target.id);
  if (!node) return null;
  if (problemNodes.has(node.id)) body.append(el('p', 'note warn problem', problemNodes.get(node.id)));
  if (node.type === 'operator') { operatorInspector(body, node); nodeSizeField(body, node); return node.title; }
  if (node.type === 'snapshot') { snapshotInspector(body, node); nodeSizeField(body, node); return node.title; }
  if (node.type === 'mod') { modInspector(body, node.mod); nodeSizeField(body, node); return node.title; }
  if (node.type === 'controller') { controllerInspector(body, node); nodeSizeField(body, node); return node.title; }
  if (node.type === 'device') { deviceInspector(body, node, target); nodeSizeField(body, node); return node.title; }
  if (node.type === 'clock') {
    const clock = draft.routing.clock;
    const available = server.routing.available;
    body.append(field('Clock source', select(clock.source ?? '', [['', '— none —'], ...available.inputs.map(p => [p, p])], value => edit(d => { d.routing.clock.source = value || null; if (!value) d.routing.clock.destinations = []; }))),
      field('Forward transport', checkbox(clock.transport, value => edit(d => { d.routing.clock.transport = value; }))),
      group('Send clock to', chipToggles(available.outputs.map(p => [p, p]), p => clock.destinations.includes(p),
        p => edit(d => { const c = d.routing.clock; if (!c.source) throw new Error('Choose a clock source first.'); c.destinations = c.destinations.includes(p) ? c.destinations.filter(x => x !== p) : [...c.destinations, p]; }))),
      group('Meter', field('Beats per bar', input(draft.performance.beats_per_bar, value => edit(d => { d.performance.beats_per_bar = value; }), { type: 'number', min: 1, max: 16 })),
        field('Beat unit', select(draft.performance.beat_unit, [2, 4, 8, 16].map(v => [v, v]), value => edit(d => { d.performance.beat_unit = Number(value); })))),
      hint('Drag the clock output to a device’s header to forward clock, or to a MOD’s sync input to lock it to beats. MIDIBRAIN reads clock for synced MODs and “next bar” actions even without forwarding.'));
  }
  if (node.type === 'thru') {
    const route = draft.routing.cc[target.focus];
    if (route) {
      const setRoute = changes => edit(d => { Object.assign(d.routing.cc[target.focus], changes); });
      const sourcePort = select(route.source, portOptions('inputs', route.source), source => setRoute({ source }));
      sourcePort.disabled = Boolean(route.controller);
      body.append(group('IN · controller / source',
        field('From port', sourcePort),
        field('From channel', input(route.channel, channel => setRoute({ channel }), { type: 'number', min: 1, max: 16 })),
        field('From CC', input(route.cc, cc => setRoute({ cc }), { type: 'number', min: 0, max: 119 })),
        field('Hardware page', input(route.page || '', page => { if (page.trim()) setRoute({ page: page.trim() }); }))),
        hint(`${route.layer ? `Layer ${route.layer} · direct MIDI, no banks. ` : ''}Direct routing passes values unchanged unless a range/inversion is set. Hardware encoder-reset values follow the same route.`));
      route.destinations.forEach((destination, index) => {
        const setTarget = changes => edit(d => Object.assign(d.routing.cc[target.focus].destinations[index], changes));
        body.append(group(`OUT · destination ${index + 1}`,
          field('To port', select(destination.port, portOptions('outputs', destination.port), port => setTarget({ port }))),
          field('To channel', input(destination.channel, channel => setTarget({ channel }), { type: 'number', min: 1, max: 16 })),
          field('To CC', input(destination.cc, cc => setTarget({ cc }), { type: 'number', min: 0, max: 119 })),
          field('Minimum', input(destination.min ?? 0, min => setTarget({ min }), { type: 'number', min: 0, max: 127 })),
          field('Maximum', input(destination.max ?? 127, max => setTarget({ max }), { type: 'number', min: 0, max: 127 })),
          field('Invert', checkbox(Boolean(destination.invert), invert => setTarget({ invert })))));
      });
      if (route.controller) {
        const key = `direct:${route.controller}:${route.layer}:${route.channel}`, style = M.controlStyle(layout, key, route.cc);
        const setStyle = changes => edit((_, lay) => { lay.controls ||= {}; lay.controls[`${key}:${route.cc}`] = { ...M.controlStyle(lay, key, route.cc), ...changes }; });
        body.append(group('Control appearance · canvas only',
          field('Display as', select(style.kind, [['knob', 'Knob'], ['fader', 'Slider'], ['button', 'Button']], kind => setStyle({ kind }))),
          field('Center detent', checkbox(style.centerDetent, centerDetent => setStyle({ centerDetent, fillFromCenter: centerDetent })))));
      }
      body.append(button('Remove route', () => { edit(d => d.routing.cc.splice(target.focus, 1)); closeInspector(); }, 'danger'));
      return `${route.page || 'MIDI Thru'} · CC ${route.cc}`;
    }
    const list = el('div', 'list');
    draft.routing.cc.forEach((route, index) => {
      const item = el('div', 'list-item');
      item.append(el('small', null, `${route.source} ch${route.channel} cc${route.cc} → ${route.destinations.map(t => `${t.port} ch${t.channel} cc${t.cc}`).join(', ')}`),
        button('×', () => edit(d => { d.routing.cc.splice(index, 1); }), 'danger', 'Remove route'));
      list.append(item);
    });
    body.append(hint('Raw CC routes copy messages port-to-port without touching parameter state or feedback.'), list,
      el('div', 'actions-row'));
    body.lastChild.append(button('+ Thru route', () => openInspector({ type: 'add-thru' })));
  }
  nodeSizeField(body, node);
  return node.title;
}

function modInspector(body, index) {
  const mod = draft.performance.mods[index];
  const set = patch => edit(d => Object.assign(d.performance.mods[index], patch));
  const envelope = mod.shape === 'envelope';
  body.append(field('Name', input(mod.name, value => set({ name: value.slice(0, 80) || mod.name }))),
    field('Enabled', checkbox(mod.enabled, value => set({ enabled: value }))),
    field('Shape', select(mod.shape, Object.keys(M.SHAPES).map(s => [s, `${M.SHAPES[s]} ${s.replace('_', ' ')}`]), value => set(value === 'envelope' ? { shape: value, playback: 'gate', timing: 'free' } : { shape: value, ...(mod.playback === 'gate' ? { playback: 'triggered' } : {}) }))));
  if (!envelope) {
    body.append(field('Playback', select(mod.playback, [['loop', 'Loop (free-running)'], ['triggered', 'Triggered loop'], ['one_shot', 'One-shot']], value => set({ playback: value }))),
      field('Timing', select(mod.timing, [['free', 'Free (Hz)'], ['sync', 'Synced to clock (beats)']], value => set({ timing: value }))));
    if (mod.timing === 'free') { const [range, out] = slider(Math.log(mod.rate / 0.01) / Math.log(2000), 0, 1, 0.001, value => set({ rate: +(0.01 * 2000 ** value).toFixed(3) }), v => `${(0.01 * 2000 ** v).toFixed(2)} Hz`); body.append(field('Rate', range, out)); }
    else body.append(field('Length', select(mod.beats, [0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64].map(b => [b, `${b} beat${b === 1 ? '' : 's'}`]), value => set({ beats: Number(value) }))));
    if (mod.shape === 'random') { const [range, out] = slider(mod.slew, 0, 1, 0.01, value => set({ slew: value })); body.append(field('Slew', range, out)); }
    else { const [range, out] = slider(mod.phase, 0, 360, 1, value => set({ phase: value }), v => `${Math.round(v)}°`); body.append(field('Start phase', range, out)); }
  } else {
    const [attack, attackOut] = slider(mod.attack_ms, 0, 2000, 1, value => set({ attack_ms: value }), v => `${Math.round(v)} ms`);
    const [release, releaseOut] = slider(mod.release_ms, 0, 2000, 1, value => set({ release_ms: value }), v => `${Math.round(v)} ms`);
    body.append(field('Attack', attack, attackOut), field('Release', release, releaseOut),
      field('Velocity', checkbox(mod.velocity, value => set({ velocity: value }))),
      field('Velocity curve', input(mod.velocity_exponent, value => set({ velocity_exponent: value }), { type: 'number', min: 0.1, max: 8, step: 0.1 })),
      field('Max hold (ms)', input(mod.max_hold_ms, value => set({ max_hold_ms: value }), { type: 'number', min: 100, max: 600000, step: 100 })),
      hint('Gate envelope: rises on note-on/press, holds until note-off/release, then releases. Sidechain ducking is this envelope wired to strip volumes.'));
  }
  const [amount, amountOut] = slider(mod.amount, 0, 1, 0.01, value => set({ amount: value }));
  body.append(field('Amount', amount, amountOut));
  const routes = mod.destinations.length + mod.bank_targets.length + mod.targets.length;
  body.append(hint(`${routes} destination route${routes === 1 ? '' : 's'} · ${mod.mod_targets.length} MOD→MOD · ${mod.trigger ? 'triggered by ' + M.inputLabel(mod.trigger) : 'no direct trigger'}. Drag ● out to a device channel or another MOD’s input.`));
  const actions = el('div', 'actions-row');
  if (index > 0) actions.append(button('Delete MOD', () => { if (confirm(`Delete ${mod.name}? Its wires and button actions go too.`)) { edit(d => M.removeMod(d, index)); closeInspector(); } }, 'danger'));
  const original = base.performance.mods[index];
  const test = el('button', null, 'Hold to trigger'); test.type = 'button';
  test.disabled = !original || JSON.stringify(original) !== JSON.stringify(mod) || !mod.enabled;
  test.title = test.disabled ? 'Apply this MOD first (and enable it) to test it on the running rig' : 'Sends a manual trigger to the running MOD';
  const trigger = on => api('/api/performance/action', { action: 'mod_trigger', mod: index, on, key: 'patch-test' }).catch(error => toast(error.message));
  test.addEventListener('pointerdown', event => { test.setPointerCapture(event.pointerId); trigger(true); });
  test.addEventListener('pointerup', () => trigger(false));
  test.addEventListener('pointercancel', () => trigger(false));
  test.addEventListener('lostpointercapture', () => trigger(false));
  actions.append(test);
  body.append(actions);
}

function inputInspector(body, target) {
  const controller = deviceById(target.id);
  const entry = graph.nodes.find(node => node.id === `ctl:${target.id}`)?.inputs.find(item => item.key === target.key);
  if (!entry) return null;
  const declared = (layout.inputs[target.id] || []).find(item => M.inputKey(item) === target.key);
  if (declared) body.append(field('Label', input(declared.label || '', value => edit((_, lay) => { const item = lay.inputs[target.id].find(i => M.inputKey(i) === target.key); if (value) item.label = value; else delete item.label; }), { placeholder: 'e.g. Side button 1' })));
  // IN: the MIDI address is editable in place; roles, wires and appearance follow it.
  const midiStatus = el('p', 'note');
  const moveTo = changes => {
    const next = { ...entry.binding, ...changes };
    let key = null;
    try { if (edit((d, lay) => { key = M.moveInput(d, lay, target.id, target.key, next); })) { target.key = key; openInspector({ type: 'input', id: target.id, key }); } }
    catch (error) { midiStatus.textContent = error.message; }
  };
  const isKeys = entry.binding.type === 'note' && entry.binding.number === null;
  const typeSelect = select(entry.binding.type, [['cc', 'CC (button / knob / slider)'], ['note', isKeys ? 'Keyboard · any note' : 'Single note (button)']], value => moveTo({ type: value, number: value === 'note' && !isKeys ? (entry.binding.number ?? 60) : entry.binding.number ?? 0 }));
  const learnIn = button('Learn', async () => {
    try { const result = await learnInput(controller, entry.binding.type, midiStatus); moveTo({ channel: result.channel, number: isKeys ? null : result.number }); }
    catch (error) { midiStatus.textContent = error.message; }
  }, null, 'Move or press the physical control to capture its address');
  if (server.demo || !controller.input) { learnIn.disabled = true; learnIn.title = server.demo ? 'MIDI learn needs the hardware runtime' : 'Set the controller input port first'; }
  const addressRow = el('div', 'inline-fields');
  const chInput = input(entry.binding.channel, value => moveTo({ channel: value }), { type: 'number', min: 1, max: 16 });
  chInput.setAttribute('aria-label', 'Input MIDI channel');
  addressRow.append(el('small', null, 'ch'), chInput);
  if (!isKeys) {
    const numInput = input(entry.binding.number ?? 0, value => moveTo({ number: value }), { type: 'number', min: 0, max: entry.binding.type === 'cc' ? 119 : 127 });
    numInput.setAttribute('aria-label', entry.binding.type === 'cc' ? 'Input CC' : 'Input note');
    addressRow.append(el('small', null, entry.binding.type === 'cc' ? 'CC' : 'note'), numInput);
  }
  addressRow.append(learnIn);
  body.append(sectionGroup('in', `IN · from ${controller.name}`, field('Type', typeSelect), addressRow, midiStatus,
    hint(`Listening for ${M.inputLabel(entry.binding)}. Changing the address keeps every role, wire and appearance this input already has.`)));
  const style = M.globalStyle(layout, target.id, target.key, isContinuousInput(entry));
  const setStyle = changes => edit((_, lay) => { lay.controls ||= {}; lay.controls[M.globalStyleKey(target.id, target.key)] = { ...M.globalStyle(lay, target.id, target.key, isContinuousInput(entry)), ...changes }; });
  // Notes are always pads (a keyboard has no knob/slider look), so only CCs choose a display.
  if (entry.binding.type === 'cc') body.append(group('Control appearance · canvas only',
    field('Display', select(style.kind, [['button', 'Button'], ['knob', 'Knob'], ['fader', 'Slider']], kind => setStyle({ kind }))),
    ...(style.kind === 'button' ? [] : [field('Center detent', checkbox(style.centerDetent, centerDetent => setStyle({ centerDetent, fillFromCenter: centerDetent })))]),
    hint('Canvas only. Knobs and sliders send a CC value when you release them in Perform mode; buttons send press and release. Notes are always buttons.')));
  const list = el('div', 'list');
  const uses = entry.uses.length ? entry.uses : [];
  for (const use of uses) {
    const item = el('div', 'list-item');
    let text = '', remove = null;
    if (use.kind === 'layer') { text = '▦ Switch software layer'; remove = () => edit(d => { delete d.setup.devices.find(device => device.id === target.id).layer_switch; }); }
    if (use.kind === 'operator') { const name = draft.performance.operators[use.op]?.name; text = `ƒ Feeds ${name}`; remove = () => edit(d => { const op = d.performance.operators[use.op]; op.inputs = op.inputs.filter(i => !(i.type === 'cc' && i.controller === target.id && M.inputKey({ type: 'cc', channel: i.channel, number: i.number }) === target.key)); for (const [k, l] of Object.entries(op.links)) if (l.controller === target.id && M.inputKey({ type: 'cc', channel: l.channel, number: l.number }) === target.key) delete op.links[k]; }); }
    if (use.kind === 'shift') { text = `⇧ Shift (${draft.performance.shift.mode})`; remove = () => edit(d => { d.performance.shift = null; for (const a of d.performance.actions) a.shift = 'any'; }); }
    if (use.kind === 'trigger') { text = `Triggers ${modName(use.mod)}`; remove = () => edit(d => { d.performance.mods[use.mod].trigger = null; }); }
    if (use.kind === 'action') {
      const action = draft.performance.actions[use.index];
      text = ({ capture: `◈ Save snapshot ${action.slot + 1}`, recall: `◈ Recall snapshot ${action.slot + 1}`, reset: action.bank ? `⟲ Reset ${bankById(action.bank)?.name}` : '⟲ Reset all strips', cancel: '✕ Cancel queued action', align: '⌖ Set the one',
        mod_stop: '■ Stop all MODs', panic: '⚠ Panic', mod_trigger: `Trigger ${modName(action.mod)}`, mod_enable: `On/off ${modName(action.mod)}` }[action.action] || `${action.action.replace('mod_', '')} · ${modName(action.mod)}`) +
        (action.shift && action.shift !== 'any' ? ` (Shift ${action.shift})` : '') + (action.when === 'bar' ? ' @ next bar' : '');
      remove = () => edit(d => { d.performance.actions.splice(use.index, 1); });
    }
    if (use.kind === 'reset') { const reset = draft.setup.resets[use.index]; text = { reset: reset.bank ? `⟲ Reset ${bankById(reset.bank)?.name}` : '⟲ Reset all strips', depth: `${bankById(reset.bank)?.name} sidechain amount`, release: 'Sidechain release', panic: 'Release envelopes' }[reset.action || 'reset']; remove = () => edit(d => { d.setup.resets.splice(use.index, 1); }); }
    item.append(el('span', null, text), button('×', remove, 'danger', 'Remove'));
    list.append(item);
  }
  if (!uses.length) list.append(el('p', 'note', 'Unused. Drag its ● to a MOD input or a strip’s ⟲ reset, or add a role below.'));
  if (entry.binding.type === 'note' && entry.binding.number === null) body.append(keyboardGroup(controller, entry));
  body.append(group('Does', list));
  const roles = [['', 'Add a role…'], ['shift-momentary', '⇧ Shift (hold)'], ['shift-toggle', '⇧ Shift (toggle)'], ['reset-all', '⟲ Reset all strips'],
    ...Array.from({ length: draft.performance.slots.length }, (_, i) => [`recall:${i}`, `◈ Recall ${draft.performance.slots[i].name}`]),
    ...Array.from({ length: draft.performance.slots.length }, (_, i) => [`capture:${i}`, `◈ Save ${draft.performance.slots[i].name}`]),
    ['cancel', '✕ Cancel queued action'], ['align', '⌖ Set the one'], ['stop-mods', '■ Stop all MODs'], ['panic', '⚠ Panic']];
  const picker = select('', roles, value => { if (value) edit(d => M.addRole(d, target.id, target.key, value)); });
  body.append(group('Roles', picker, hint('Roles act on their own. Actions that target something (trigger a MOD, reset one strip, set a MOD’s rate) are wires. With Shift assigned, each action can be limited to Shift on/off in its wire panel.')));
  const actions = el('div', 'actions-row');
  actions.append(button('Remove input', () => { edit((d, lay) => M.forgetInput(d, lay, target.id, target.key)); closeInspector(); }, 'danger'));
  body.append(actions);
  return entry.label || M.inputLabel(entry.binding);
}

// “Any note” inputs are keyboards: every route they play, fully editable on one screen.
function keyboardGroup(controller, entry) {
  const routes = draft.routing.notes.map((route, index) => ({ route, index })).filter(({ route }) => route.controller === controller.id && route.channel === entry.binding.channel);
  const blocks = [];
  routes.forEach(({ route, index }, position) => {
    const device = draft.setup.devices.find(item => item.kind === 'destination' && item.output === route.port);
    const block = el('details', 'route-block');
    const key = `route:${route.id}`;
    block.open = view.fold?.[key] ?? (routes.length <= 2 || position === 0);
    block.addEventListener('toggle', () => { if (block.open !== (view.fold?.[key] ?? (routes.length <= 2 || position === 0))) { (view.fold ||= {})[key] = block.open; saveView(); } });
    const summary = el('summary');
    summary.append(el('strong', null, `→ ${device?.name || route.port} · ch ${route.out_channel}`), el('small', null, ` ${M.noteName(route.low)}–${M.noteName(route.high)}${route.transpose ? ` · ${route.transpose > 0 ? '+' : ''}${route.transpose}` : ''}${route.scale ? ` · ${route.scale.mode.replace('_', ' ')}` : ''}`));
    const body = el('div', 'route-body'); body.append(...routeFields(index));
    const actions = el('div', 'actions-row'); actions.append(button('Remove route', () => { edit(d => d.routing.notes.splice(index, 1) && M.pruneNoteRefs(d)); }, 'danger'));
    body.append(actions); block.append(summary, body); blocks.push(block);
  });
  if (!routes.length) blocks.push(el('p', 'note', 'Not playing anything yet.'));
  const devices = draft.setup.devices.filter(item => item.kind === 'destination');
  const picker = select('', [['', '+ Play a device…'], ...devices.map(device => [device.id, device.name])], id => {
    if (!id) return;
    edit(d => M.connect(d, [`ctl:${controller.id}`, entry.key], [`dev:${id}`, 'notes']), { stay: true });
  });
  picker.setAttribute('aria-label', 'Play a device');
  const missing = !controller.input ? el('p', 'note warn', `Set ${controller.name}’s input port first, so MIDIBRAIN hears the keyboard.`) : null;
  return group('Keyboard · notes', hint('Route this keyboard’s notes to a device through MIDIBRAIN, with channel remapping, key splits, transpose and scale quantising, and let MODs or knobs move any of those settings. Notes still trigger MODs and buttons as before. You can also drag the ● to a device’s “♪ notes in” row.'), ...(missing ? [missing] : []), ...blocks, picker);
}

function addInputInspector(body, target) {
  const controllers = draft.setup.devices.filter(item => item.kind === 'controller');
  if (!controllers.length) { body.append(el('p', 'note', 'Add a controller first.')); return 'Add global input'; }
  const controller = deviceById(target.id) || controllers[0];
  if (controllers.length > 1) body.append(field('Controller', select(controller.id, controllers.map(c => [c.id, c.name]), id => openInspector({ type: 'add-input', id }))));
  target = { ...target, id: controller.id };
  const value = { type: 'cc', channel: 1, number: 0, label: '', kind: 'button', keys: false };
  const numberField = input(0, v => { value.number = v; }, { type: 'number', min: 0, max: 127, live: true });
  const displayRow = field('Display', select('button', [['button', 'Button'], ['knob', 'Knob'], ['fader', 'Slider']], v => { value.kind = v; }));
  const labelInput = input('', v => { value.label = v; }, { placeholder: 'optional', live: true }); labelInput.setAttribute('aria-label', 'Label');
  const numberRow = field('Number', numberField);
  body.append(hint('A global input is a button, knob, slider or note that isn’t part of a strip. Wire it to a MOD input or a strip reset, or give it a role.'),
    field('Type', select('cc', [['cc', 'CC (button / knob / slider)'], ['note', 'Single note (button)'], ['keys', 'Keyboard · any note']], v => {
      value.keys = v === 'keys'; value.type = v === 'cc' ? 'cc' : 'note';
      numberRow.hidden = value.keys; displayRow.hidden = value.type === 'note';
      if (value.keys && !value.label) labelInput.value = 'Keys';
      if (value.keys) value.label = labelInput.value;
    })),
    displayRow,
    field('MIDI channel', input(1, v => { value.channel = v; }, { type: 'number', min: 1, max: 16, live: true })),
    numberRow,
    field('Label', labelInput));
  const status = el('p', 'note');
  const learn = button('Learn', async () => {
    try {
      const armed = await api('/api/learn', { port: controller.input, type: value.type });
      status.textContent = 'Move or press the control…';
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = await api(`/api/learn/${armed.id}`);
        if (result.state === 'captured') { value.channel = result.channel; value.number = result.number; numberField.value = result.number; body.querySelectorAll('input[type=number]')[0].value = result.channel; status.textContent = `Captured ${M.inputLabel(value)}.`; return; }
        if (result.state !== 'listening') { status.textContent = `Learn ${result.state}.`; return; }
      }
    } catch (error) { status.textContent = error.message; }
  });
  if (!controller.input || server.demo) { learn.disabled = true; learn.title = server.demo ? 'MIDI learn needs the hardware runtime' : 'Set the controller’s input port first'; }
  const add = button('Add input', () => {
    if (edit((d, lay) => {
      const key = M.declareInput(lay, target.id, { ...value, number: value.keys ? null : value.number, label: value.label || undefined });
      if (value.kind !== 'button' && value.type === 'cc') { lay.controls ||= {}; lay.controls[M.globalStyleKey(target.id, key)] = { kind: value.kind, centerDetent: false, fillFromCenter: false }; }
    })) openInspector({ type: 'node', id: `ctl:${target.id}` });
  }, 'primary');
  const actions = el('div', 'actions-row'); actions.append(learn, add);
  body.append(status, actions);
  return `Add global input · ${controller.name}`;
}

// ---------------------------------------------------------------- live state

function drawScope(canvas, values, active) {
  const context = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  context.clearRect(0, 0, w, h);
  context.strokeStyle = '#2a2b33'; context.beginPath(); context.moveTo(0, h / 2); context.lineTo(w, h / 2); context.stroke();
  context.strokeStyle = active ? '#e4b078' : '#6f7280'; context.lineWidth = 1.5; context.beginPath();
  values.forEach((value, i) => { const x = i * w / (values.length - 1), y = h / 2 - Math.max(-1, Math.min(1, value)) * (h / 2 - 3); i ? context.lineTo(x, y) : context.moveTo(x, y); });
  context.stroke();
}

function applyLive() {
  if (!live) return;
  if (playing) {
    let switched = false;
    for (const [controller, layer] of Object.entries(live.active_layers || {})) {
      if (view.layers[controller] !== layer) { view.layers[controller] = layer; switched = true; }
    }
    if (switched) { cancelControlDrag?.(); render(); return; }
  }
  for (const tab of document.querySelectorAll('[data-layer-tab]')) {
    const [controller, layer] = tab.dataset.layerTab.split(':');
    tab.classList.toggle('runtime-active', live.active_layers?.[controller] === layer);
  }
  const healthy = live.running && !live.staged && live.native && live.instance_id === server?.instance_id && live.definitions_revision === server?.definitions_revision;
  const inputs = new Map((healthy ? live.inputs || [] : []).map(binding => [`${binding.controller}:${M.inputKey(binding)}`, binding.value]));
  for (const cell of document.querySelectorAll('[data-global-input]')) {
    if (cell.dragging) continue;
    const key = `${cell.dataset.controller}:${cell.dataset.globalInput}`, value = inputs.get(key);
    if (Number.isFinite(value)) globalValues.set(key, value); else globalValues.delete(key);
    setKnob(cell, value, { assigned: true });
    if (cell.dataset.kind === 'button') cell.querySelector('.k-value').textContent = '';
  }
  if (playing && (!healthy || dirty() || frameDirty || frameSaving || conflict || Date.now() - lastLiveRead > 2500))
    stopPlaying(!healthy ? 'the runtime is not ready.' : dirty() ? 'there are unapplied edits.' : conflict ? 'the rig changed elsewhere.' : frameDirty || frameSaving ? 'a panel tool has unsaved edits.' : 'live values stopped updating.');
  live.mods.forEach((value, index) => {
    // Keep roughly 13 seconds of trace on the scope whatever the refresh rate.
    const wanted = Math.round(64 * (view.refreshHz || 5) / 5);
    const history = scopeHistory[index] ||= Array(wanted).fill(0);
    while (history.length < wanted) history.unshift(0);
    while (history.length > wanted) history.shift();
    history.push(value); history.shift();
    const canvas = document.querySelector(`canvas[data-mod="${index}"]`);
    if (canvas) drawScope(canvas, history, live.sources[index]?.active);
    const label = document.querySelector(`[data-mod-value="${index}"]`);
    if (label) label.textContent = value.toFixed(2);
    document.querySelectorAll(`.wire[data-mod="${index}"]`).forEach(wire => wire.style.setProperty('--level', Math.min(1, Math.abs(value))));
  });
  for (const cell of document.querySelectorAll('[data-note-value]')) {
    const [routeId, name] = cell.dataset.noteValue.split(':'), value = live.note_live?.[routeId]?.[name];
    cell.textContent = value === undefined ? cell.dataset.base : formatNoteValue(name, value); cell.classList.toggle('live', value !== undefined);
  }
  for (const knob of document.querySelectorAll('.knob[data-knob]')) {
    if (knob.dragging) continue;
    if (knob.dataset.route !== undefined) {
      const control = healthy && M.playableDirectControl(draft, live, Number(knob.dataset.route));
      setKnob(knob, control ? control.value : null, control || {});
      continue;
    }
    const control = healthy && live.controls.find(item => `${item.bank}:${item.index}` === knob.dataset.knob && item.layer === knob.dataset.layer);
    const bank = control && bankById(control.bank);
    const matches = bank && M.sameIdentity(control.identity, M.controlIdentity(bank, control.index, control.layer));
    setKnob(knob, matches ? control.value : null, matches ? control : {});
  }
  for (const control of live.controls) {
    const key = `${control.bank}:${control.index}:${control.layer}`;
    const previous = lastControls.get(key);
    if (previous !== undefined && previous !== control.value) document.querySelectorAll(`.wire[data-kind=strip][data-bank="${CSS.escape(control.bank)}"]`).forEach(wire => { wire.classList.add('flash'); clearTimeout(wire._flash); wire._flash = setTimeout(() => wire.classList.remove('flash'), 350); });
    lastControls.set(key, control.value);
  }
  for (const wire of document.querySelectorAll('.wire[data-op-out]')) wire.style.setProperty('--level', String(Math.min(1, Math.abs(live.operators?.[Number(wire.dataset.opOut)] ?? 0))));
  for (const bar of document.querySelectorAll('[data-op-value]')) {
    const value = Math.max(-1, Math.min(1, live.operators?.[Number(bar.dataset.opValue)] ?? 0));
    bar.style.setProperty('--l', `${50 + Math.min(0, value) * 50}%`); bar.style.setProperty('--w', `${Math.abs(value) * 50}%`);
    const label = document.querySelector(`[data-op-text="${bar.dataset.opValue}"]`); if (label) label.textContent = value.toFixed(2);
  }
  for (const row of document.querySelectorAll('[data-snap-slot]')) {
    const slot = Number(row.dataset.snapSlot), saved = Boolean(live.snapshots_saved?.[slot]), stamp = live.snapshots_info?.[slot]?.saved_at ?? null;
    // A new save time on an already-saved slot is a re-save: flash the row so the update is visible.
    const resaved = saved && lastSaveStamp.has(slot) && lastSaveStamp.get(slot) !== stamp;
    lastSaveStamp.set(slot, stamp);
    row.classList.toggle('saved', saved);
    if (resaved) { row.classList.remove('resaved'); void row.offsetWidth; row.classList.add('resaved'); clearTimeout(row._resaved); row._resaved = setTimeout(() => { row.classList.remove('resaved'); if (row.firstChild) row.firstChild.textContent = snapshotStateText(slot); }, 2200); }
    if (row.firstChild) row.firstChild.textContent = snapshotStateText(slot, row.classList.contains('resaved'));
  }
  document.querySelectorAll('[data-shift]').forEach(chip => chip.classList.toggle('shift-on', Boolean(live.shift)));
  renderStatus();
}

async function pollLive() {
  const started = Date.now();
  if (document.visibilityState === 'visible' && server?.native) {
    try {
      live = await api('/api/patch/live');
      lastLiveRead = Date.now();
      if (server && (live.instance_id !== server.instance_id || !live.running || live.staged || live.definitions_revision !== server.definitions_revision))
        stopPlaying(live.instance_id !== server.instance_id ? 'the runtime restarted.' : !live.running ? 'the runtime is not running.' : live.staged ? 'settings are staged and waiting for a restart.' : 'the rig definitions changed.');
      if (server && live.instance_id !== server.instance_id && !dirty()) await load();
      applyLive();
    } catch { lastLiveRead = 0; stopPlaying('live values were lost.'); live = null; document.querySelectorAll('.knob').forEach(knob => setKnob(knob, null)); renderStatus(); }
  }
  // Display refresh: Standard 5 Hz, Smooth 15, High 30, Max 60. Only the canvas readout
  // changes; the engine keeps its own update rate (System → Engine).
  setTimeout(pollLive, Math.max(0, 1000 / (view.refreshHz || 5) - (Date.now() - started)));
}

async function pollState() {
  if (document.visibilityState === 'visible' && server) {
    try {
      const state = await api('/api/patch/state');
      if (state.instance_id !== server.instance_id || state.revision !== server.revision) {
        stopPlaying('the rig was changed in another editor.');
        if (!dirty()) await load();
        else { conflict = true; renderStatus(); banner('The rig was changed in another editor. Your unapplied patch edits are based on the old version.', 'warn', button('Reload (discard my edits)', () => load())); }
      }
    } catch { /* ignore */ }
  }
  setTimeout(pollState, 4000);
}

// ---------------------------------------------------------------- chrome

let toastTimer = null;
function toast(message, tone = 'error') {
  const node = $('toast'); node.textContent = message; node.dataset.tone = tone; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, tone === 'error' ? 5000 : 3000);
}
function banner(message, tone = 'warn', action = null) {
  const node = $('banner');
  if (!message) { node.hidden = true; return; }
  node.hidden = false; node.dataset.tone = tone; node.replaceChildren(el('span', null, message));
  if (action) node.append(action);
}

function setupChrome() {
  $('rigButton').addEventListener('click', event => { event.stopPropagation(); $('rigMenu').hidden = !$('rigMenu').hidden; $('rigButton').setAttribute('aria-expanded', String(!$('rigMenu').hidden)); });
  $('exportRig').addEventListener('click', async () => {
    try {
      if (frameDirty || frameSaving || conflict) throw new Error('Save/discard panel edits and resolve rig conflicts before exporting.');
      const state = await api('/api/patch/state');
      if (state.revision !== server.revision || state.instance_id !== server.instance_id) throw new Error('The rig changed. Reload before exporting.');
      const profile = { ...M.clone(draft.profile || state.profile), bank_setup: M.clone(draft.setup), performance: M.clone(draft.performance), routing: M.clone(draft.routing), controller_inputs_migrated: true };
      const bundle = { format: 'midibrain-rig', version: 2, profile, layout: M.clone(layout) };
      const blob = new Blob([JSON.stringify(bundle, null, 2) + '\n'], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = el('a'); link.href = url; link.download = 'midibrain-rig.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      $('rigMenu').hidden = true;
      toast('Exported configuration and canvas. Captured snapshot values are separate, not included.', 'info');
    } catch (error) { toast(error.message); }
  });
  $('importRig').addEventListener('click', () => { $('rigFile').click(); $('rigMenu').hidden = true; });
  $('initPatch').addEventListener('click', async () => {
    try {
      if (frameDirty || frameSaving || conflict) throw new Error('Save/discard panel edits and resolve rig conflicts before initializing.');
      if (!confirm('Start an empty patch? Controllers, devices, strips, MODs, routing and canvas layout will be cleared in the draft. Undo can restore them before Apply. Saved snapshot captures are kept separately.')) return;
      const result = await api('/api/patch/rig/init', {});
      edit((current, lay) => {
        current.setup = result.profile.bank_setup; current.performance = result.profile.performance; current.routing = result.profile.routing; current.profile = result.profile;
        for (const key of Object.keys(lay)) delete lay[key];
        Object.assign(lay, M.emptyLayout());
      });
      selection = null; renderInspector(); $('rigMenu').hidden = true;
      toast('Empty patch draft ready. Add your devices and controls, then Apply to rig. Live routing is unchanged until Apply.', 'info');
    } catch (error) { toast(`Init failed: ${error.message}`); }
  });
  $('rigFile').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (!file) return;
    try {
      if (frameDirty || frameSaving || conflict) throw new Error('Save/discard panel edits and resolve rig conflicts before importing.');
      if (file.size > 2 * 1024 * 1024) throw new Error('Rig file is too large (maximum 2 MB).');
      const result = await api('/api/patch/rig/validate', JSON.parse(await file.text()));
      if (dirty() && !confirm('Replace the unapplied patch draft with this rig? Undo can restore it.')) return;
      edit((current, lay) => {
        current.setup = result.profile.bank_setup; current.performance = result.profile.performance; current.routing = result.profile.routing; current.profile = result.profile;
        if (result.layout) { for (const key of Object.keys(lay)) delete lay[key]; Object.assign(lay, M.emptyLayout(), result.layout); }
        M.retainInputs(current, lay);
      });
      selection = null; renderInspector();
      toast('Rig imported into the draft. Check its ports, then Apply to rig. No routing has changed yet.', 'info');
    } catch (error) { toast(`Import failed: ${error.message}`); }
  });
  const addMenu = $('addMenu'), addButton = $('addButton');
  const closeAdd = () => { addMenu.hidden = true; addButton.setAttribute('aria-expanded', 'false'); };
  addButton.addEventListener('click', event => { event.stopPropagation(); addMenu.hidden = !addMenu.hidden; addButton.setAttribute('aria-expanded', String(!addMenu.hidden)); if (!addMenu.hidden) addMenu.querySelector('button')?.focus(); });
  addMenu.addEventListener('keydown', event => { if (event.key === 'Escape') { closeAdd(); addButton.focus(); } });
  document.addEventListener('click', event => { if (!event.target.closest('.menu')) { closeAdd(); $('rigMenu').hidden = true; $('rigButton').setAttribute('aria-expanded', 'false'); } });
  const ADD = {
    mod: () => {
      let index = null;
      edit(d => { index = M.addMod(d); });
      if (index === null) return;
      // Auto-placed at the bottom of the MOD column, then brought into view.
      const graphNode = `mod:${index}`;
      placeNew(graphNode); openInspector({ type: 'node', id: graphNode });
    },
    controller: () => openInspector({ type: 'add-controller' }),
    device: () => openInspector({ type: 'add-device' }),
    operator: () => openInspector({ type: 'add-operator' }),
    snapshot: () => { let index = null; if (edit(d => { index = M.Snap.addSnapshot(d, { saved: live?.snapshots_saved || [] }); })) { placeNew(`snap:${index}`); openInspector({ type: 'node', id: `snap:${index}` }); } },
    thru: () => openInspector({ type: 'add-thru' }),
  };
  addMenu.querySelectorAll('[data-add]').forEach(item => item.addEventListener('click', event => { event.stopPropagation(); closeAdd(); ADD[item.dataset.add](); }));
  $('detailStrip').addEventListener('click', () => { view.detail = 'strip'; saveView(); render(); });
  $('detailControl').addEventListener('click', () => { view.detail = 'control'; saveView(); render(); });
  $('filtersButton').addEventListener('click', event => { event.stopPropagation(); const popover = $('filters'); popover.hidden = !popover.hidden; $('filtersButton').setAttribute('aria-expanded', !popover.hidden); });
  document.addEventListener('click', event => { if (!event.target.closest('.menu')) $('filters').hidden = true; });
  $('fit').addEventListener('click', fit);
  $('tidy').addEventListener('click', event => tidy({ reset: event.shiftKey }));
  $('controlDetails').addEventListener('click', () => { view.controlDetails = !view.controlDetails; saveView(); render(); });
  $('modeEdit').addEventListener('click', () => { stopPlaying(); applyLive(); });
  $('play').addEventListener('click', async () => {
    if (playing) { stopPlaying(); applyLive(); return; }
    const blocker = performBlocker();
    if (blocker) { toast(`Perform is unavailable: ${blocker}`, 'info'); return; }
    try {
      const [state, snapshot] = await Promise.all([api('/api/patch/state'), api('/api/patch/live')]);
      if (state.revision !== server.revision || state.instance_id !== server.instance_id) { await refreshFromRig(); toast('Rig changed. Review it, then enable playback again.'); return; }
      if (dirty() || frameDirty || frameSaving || conflict || !snapshot.running || snapshot.staged || snapshot.definitions_revision !== server.definitions_revision) throw new Error('Apply or discard all pending edits before playback.');
      if (!server.demo && !confirm('Perform mode: canvas controls send MIDI to the running rig when you release them. Continue?')) return;
      live = snapshot; lastLiveRead = Date.now(); armedInstance = snapshot.instance_id;
      playing = true; $('play').setAttribute('aria-pressed', 'true'); $('modeEdit').setAttribute('aria-pressed', 'false');
      document.body.classList.add('playing'); $('performBar').hidden = false;
      selection = null; renderInspector(); applyLive();
    } catch (error) { stopPlaying(); toast(error.message); }
  });
  // Only a hidden tab disarms Perform. A window `blur` also fires after the native
  // confirm() dialog (and when focus moves into the panel), which used to cancel
  // Perform the instant it was enabled on a real rig.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') stopPlaying('the tab was hidden.'); });
  $('undo').addEventListener('click', undo); $('redo').addEventListener('click', redo);
  $('discard').addEventListener('click', async () => { if (confirm('Discard all unapplied patch edits?')) await load(); });
  $('apply').addEventListener('click', apply);
  window.addEventListener('resize', () => requestAnimationFrame(drawWires));
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  // Best effort: a node moved just before closing the tab still keeps its place.
  window.addEventListener('pagehide', () => {
    if (!layoutPending) return;
    layoutPending = false; clearTimeout(layoutTimer);
    fetch('/api/patch/layout', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify(layout) }).catch(() => {});
  });
  document.addEventListener('keydown', event => {
    const typing = event.target.closest?.('input, select, textarea');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !typing) { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
    if (typing) return;
    if (event.key === 'Escape') { stopPlaying(); if (multi.size) clearMulti(); else closeInspector(); }
    if (event.key === 'f' || event.key === 'F') fit();
    if (event.key === 'p' || event.key === 'P') { view.dock.open = !view.dock.open; saveView(); applyDock(); }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selection?.type === 'wire') { const wire = graph.wires.find(item => item.id === selection.id); if (wire) { edit(d => M.disconnect(d, wire)); selection = null; closeInspector(); } }
      else if (selection?.type === 'node' && selection.id.startsWith('mod:')) {
        const index = Number(selection.id.slice(4));
        if (confirm(`Delete ${modName(index)}?`)) { edit(d => M.removeMod(d, index)); selection = null; closeInspector(); }
      }
    }
  });
}

// One shared tooltip for every “i” hint and [data-tip] label: hover, keyboard
// focus, or tap (tap again to dismiss). Escape also closes it.
function setupTips() {
  const tip = $('tip');
  let current = null, pinned = false;
  const show = target => {
    current = target; tip.textContent = target.dataset.tip; tip.hidden = false;
    const rect = target.getBoundingClientRect(), width = Math.min(320, innerWidth - 16);
    tip.style.maxWidth = `${width}px`;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8));
    const below = rect.bottom + 8 + tip.offsetHeight < innerHeight;
    tip.style.left = `${left}px`; tip.style.top = `${below ? rect.bottom + 8 : Math.max(8, rect.top - tip.offsetHeight - 8)}px`;
  };
  const hide = () => { tip.hidden = true; current = null; pinned = false; };
  const targetOf = event => event.target.closest?.('[data-tip]');
  document.addEventListener('pointerover', event => { const target = targetOf(event); if (target && !pinned && event.pointerType !== 'touch') show(target); });
  document.addEventListener('pointerout', event => { const target = targetOf(event); if (target && !pinned && target === current) hide(); });
  document.addEventListener('focusin', event => { const target = targetOf(event); if (target && !pinned) show(target); });
  document.addEventListener('focusout', event => { if (targetOf(event) && !pinned) hide(); });
  document.addEventListener('click', event => {
    const target = targetOf(event);
    if (target?.classList.contains('hint-i')) { event.preventDefault(); event.stopPropagation(); if (pinned && current === target) hide(); else { show(target); pinned = true; } }
    else if (pinned) hide();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !tip.hidden) { hide(); event.stopPropagation(); } }, true);
  document.addEventListener('scroll', hide, true);
}

setupChrome(); setupViewport(); setupDock(); setupTips();
load().then(() => { pollLive(); pollState(); }).catch(error => banner(`Could not read the rig: ${error.message}`, 'warn'));
