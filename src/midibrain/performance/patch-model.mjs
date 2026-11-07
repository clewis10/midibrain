// Patch canvas model: the rig profile as a node graph.
//
// Nothing here is a second routing model. Nodes and wires are derived from the
// saved setup (banks), performance config (MODs, actions, Shift) and patchbay
// routing; every edit operation rewrites those same structures. Only node
// positions, pages and declared-but-unused inputs live in the layout.

import * as Snap from './patch-snapshots.mjs';
import * as Ops from './patch-operators.mjs';

export const MAX_MODS = 16;
export const MOD_INPUTS = ['trigger', 'enable', 'sync', 'rate', 'amount', 'phase', 'release'];
export const MODULATABLE = ['rate', 'amount', 'phase', 'release'];
export const CONTINUOUS_ACTIONS = { rate: 'mod_rate', amount: 'mod_amount', phase: 'mod_phase', release: 'mod_release' };
export const BANK_MOD_PARAMETERS = ['depth', 'mod_depth_2', 'mod_depth_3'];
export const NODE_TYPES = ['controller', 'mod', 'device', 'clock', 'thru', 'snapshot', 'operator'];
export const WIRE_KINDS = ['strip', 'send', 'mod', 'modmod', 'trigger', 'action', 'clock', 'thru', 'notes', 'notemod', 'notectl', 'op', 'snapshot', 'modamount'];
export const ROLE_ACTIONS = {
  'reset-all': { action: 'reset', bank: null, when: 'instant' }, panic: { action: 'panic' }, 'stop-mods': { action: 'mod_stop' },
  cancel: { action: 'cancel' }, align: { action: 'align' },
};
export const NOTE_SCALES = [['chromatic', 'Off · chromatic'], ['major', 'Major'], ['minor', 'Minor'], ['dorian', 'Dorian'], ['phrygian', 'Phrygian'], ['lydian', 'Lydian'],
  ['mixolydian', 'Mixolydian'], ['locrian', 'Locrian'], ['harmonic_minor', 'Harmonic minor'], ['melodic_minor', 'Melodic minor'],
  ['pentatonic_major', 'Pentatonic major'], ['pentatonic_minor', 'Pentatonic minor'], ['blues', 'Blues'], ['whole_tone', 'Whole tone']];
// Keyboard settings a MOD or knob can drive: label, and what a full-scale MOD or a knob sweep covers.
export const NOTE_PARAMS = {
  transpose: { label: 'transpose', span: '±24 semitones' }, low: { label: 'low key', span: '±63 keys' }, high: { label: 'high key', span: '±63 keys' },
  velocity: { label: 'velocity', span: '±63' }, channel: { label: 'channel', span: '±8' }, root: { label: 'scale key', span: '±6 semitones' },
  // Expression: added to whatever the keyboard sends (nothing if it sends none).
  bend: { label: 'pitch bend', span: 'full bend', expression: true }, pressure: { label: 'aftertouch', span: 'full range', expression: true },
  modwheel: { label: 'mod wheel', span: 'full range', expression: true }, sustain: { label: 'sustain', span: 'on above half', expression: true },
};
export const NOTE_ACTIONS = Object.fromEntries(Object.keys(NOTE_PARAMS).map(name => [`note_${name}`, name]));
// The controller a keyboard route belongs to (its recorded one, else whoever owns the source port).
export function noteRouteOwner(setup, route) {
  if (!route) return null;
  return (route.controller ? setup.devices.find(item => item.id === route.controller) : setup.devices.find(item => item.kind === 'controller' && item.input === route.source))?.id || null;
}
export const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const noteName = note => `${NOTE_NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
export const SHAPES = { sine: '∿', triangle: '⋀', saw_up: '⟋', saw_down: '⟍', square: '⊓', random: '⁙', envelope: '◿' };

export const clone = value => JSON.parse(JSON.stringify(value));
const channelKey = cid => Array.isArray(cid) ? cid[0] : cid;
const fail = message => { throw new Error(message); };

export function defaultMod(index) {
  return { name: `MOD ${index + 1}`, shape: 'sine', enabled: false, timing: 'free', rate: 1, beats: 1, playback: 'loop',
    phase: 0, slew: 0, amount: 1, attack_ms: 0, release_ms: 250, trigger: null, targets: [], bank_targets: [], destinations: [],
    velocity: true, velocity_exponent: 1, max_hold_ms: 30000, mod_targets: [], note_targets: [] };
}

export function inputKey(binding) {
  return `in:${binding.type || 'cc'}:${binding.channel}:${binding.number ?? '*'}`;
}

export function inputLabel(binding) {
  const kind = (binding.type || 'cc') === 'note' ? 'Note' : 'CC';
  return `${kind} ${binding.number ?? 'any'} · ch ${binding.channel}`;
}

export function parseInputKey(key) {
  const [, type, channel, number] = key.split(':');
  return { type, channel: Number(channel), number: number === '*' ? null : Number(number) };
}

export function normalizeDraft(draft) {
  const result = clone(draft);
  result.routing.notes ||= [];
  for (const route of result.routing.notes) route.id ||= uniqueId(result.routing.notes.map(item => item.id).filter(Boolean), 'n');
  for (const route of result.routing.cc) {
    if (route.layer || !route.page) continue;
    const controller = result.setup.devices.find(device => device.kind === 'controller' && device.input === route.source);
    if (!controller) continue;
    const key = slug(route.page);
    if (controllerLayerKeys(controller).includes(key) && controller.layer_types?.[key] !== 'direct') continue;
    setLayers(controller, [...new Set([...controllerLayerKeys(controller), key])]);
    controller.layer_types ||= {}; controller.layer_types[key] = 'direct';
    route.controller = controller.id; route.layer = key;
  }
  result.performance.operators ||= [];
  for (const mod of result.performance.mods) {
    for (const [key, value] of Object.entries(defaultMod(0))) if (!(key in mod)) mod[key] = clone(value);
  }
  return result;
}

export function emptyLayout() {
  return { version: 1, nodes: {}, pages: [], inputs: {}, controls: {}, controllers: {} };
}

export function controllerLayout(layout, id) {
  const saved = layout.controllers?.[id];
  return { bankLayout: saved?.bankLayout === 'columns' ? 'columns' : 'rows', columns: Number.isInteger(saved?.columns) ? Math.max(1, Math.min(8, saved.columns)) : 4 };
}

export function bankLayerKeys(device) { return controllerLayerKeys(device).filter(key => device.layer_types?.[key] !== 'direct'); }

export function playableDirectControl(draft, snapshot, index) {
  if (!snapshot?.native || !snapshot.running || snapshot.staged) return null;
  const route = draft.routing.cc[index], state = snapshot.direct_controls?.find(control => control.index === index);
  const controller = draft.setup.devices.find(device => device.id === route?.controller);
  if (!route?.layer || !state || !sameIdentity(route, state.identity)) return null;
  if (controller?.layer_mode === 'software' && snapshot.active_layers?.[controller.id] !== route.layer) return null;
  return { ...state, assigned: true };
}

export function setLayerType(draft, controllerId, key, type) {
  const device = findDevice(draft, controllerId);
  if (!controllerLayerKeys(device).includes(key) || !['banked', 'direct'].includes(type)) fail('Choose an existing layer and routing type.');
  if ((device.layer_types?.[key] || 'banked') === type) return;
  const usage = layerUsage(draft, controllerId, key);
  if (usage.inputs || usage.mapped) fail('Clear this layer’s mappings first, or add a new layer with the routing type you want.');
  if (type === 'direct' && bankLayerKeys(device).length === 1 && controllerBanks(draft, controllerId).length) fail('Keep one banked layer while this controller has strips.');
  for (const bank of controllerBanks(draft, controllerId)) for (const control of bank.controls) {
    if (type === 'direct') delete control[key]; else control[key] = blankBinding();
  }
  device.layer_types ||= {}; device.layer_types[key] = type;
}

// Two descriptions of one mapping are the same when they differ only by defaults: the engine
// fills in empty fields (null, [], false, device_sync off, a 0–127 range) that a saved draft
// may omit, and key order is not meaningful. Strict text comparison made Perform refuse every
// control on a rig whose saved file was not already in the engine's normal form.
const DEFAULTS = { min: 0, max: 127, device_sync: 'off' };
function canonical(value, key = null) {
  if (Array.isArray(value)) return value.length ? value.map(item => canonical(item) ?? null) : undefined;
  if (value && typeof value === 'object') {
    const result = {};
    for (const name of Object.keys(value).sort()) {
      const inner = canonical(value[name], name);
      if (inner === undefined) continue;
      result[name] = inner;
    }
    return Object.keys(result).length ? result : undefined;
  }
  if (value === null || value === undefined || value === false || (key in DEFAULTS && value === DEFAULTS[key])) return undefined;
  return value;
}
export const sameIdentity = (a, b) => JSON.stringify(canonical(a) ?? null) === JSON.stringify(canonical(b) ?? null);
// Which top-level/binding fields differ, for a message the user can act on.
export function identityDifference(live, local) {
  const a = canonical(live) || {}, b = canonical(local) || {}, out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'binding') {
      const x = a.binding || {}, y = b.binding || {};
      for (const inner of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[inner]) !== JSON.stringify(y[inner])) out.push(`binding.${inner}`);
    } else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key);
  }
  return out;
}

export function controlIdentity(bank, index, layer) {
  return { controller: bank.controller, destination: bank.destination, channels: clone(bank.channels),
    midi_channels: clone(bank.midi_channels ?? null), binding: clone(bank.controls[index][layer]) };
}

export function controlStyle(layout, bank, index) {
  const saved = layout.controls?.[`${bank}:${index}`];
  return { kind: ['knob', 'fader', 'button'].includes(saved?.kind) ? saved.kind : 'knob', centerDetent: saved?.centerDetent === true,
    fillFromCenter: saved?.centerDetent === true };
}

// Global inputs (buttons, knobs, sliders and notes outside strips) keep their
// canvas appearance beside strip controls, in the same layout sidecar.
export const globalStyleKey = (controllerId, key) => `global:${controllerId}:${key}`;
export function globalStyle(layout, controllerId, key, continuous = false) {
  const saved = layout.controls?.[globalStyleKey(controllerId, key)];
  return { kind: ['knob', 'fader', 'button'].includes(saved?.kind) ? saved.kind : continuous ? 'knob' : 'button', centerDetent: saved?.centerDetent === true,
    fillFromCenter: saved?.centerDetent === true };
}

// Nodes may be widened or narrowed on the canvas (long controller names, wide
// global grids). Canvas-only; stored in the layout sidecar.
export const NODE_WIDTH = { min: 180, max: 900 };
export function nodeWidth(layout, id) {
  const width = layout.widths?.[id];
  return Number.isFinite(width) ? Math.max(NODE_WIDTH.min, Math.min(NODE_WIDTH.max, Math.round(width))) : null;
}
export function setNodeWidth(layout, id, width) {
  layout.widths ||= {};
  if (width === null) delete layout.widths[id];
  else layout.widths[id] = Math.max(NODE_WIDTH.min, Math.min(NODE_WIDTH.max, Math.round(width)));
}

// What would stop this draft from being applied to a real (non-simulated) rig,
// and which node to look at to fix it.
export function findProblems(draft, { live = false } = {}) {
  const problems = [];
  for (const bank of draft.setup.banks) {
    const device = draft.setup.devices.find(item => item.id === bank.destination);
    if (!device) continue;
    for (const gap of bankParameterGaps(device, bank)) {
      problems.push({ node: `ctl:${bank.controller}`, message: `${bank.name}: “${gap.label}” is not available on ${gap.missing.join(', ')}. Pick a parameter every selected channel has, or remove that channel from the strip.` });
    }
  }
  if (!live) return problems;
  for (const device of draft.setup.devices) {
    if (device.kind === 'controller' && !device.input) problems.push({ node: `ctl:${device.id}`, message: `“${device.name}” needs an input port: choose where it sends MIDI to MIDIBRAIN.` });
    if (device.kind === 'destination' && !device.output) problems.push({ node: `dev:${device.id}`, message: `“${device.name}” needs an output port: choose where MIDIBRAIN sends to it.` });
  }
  return problems;
}

// Strip parameters that some selected channel does not define (the engine needs every
// selected channel to have the parameter). The choice is kept, never silently cleared.
export function bankParameterGaps(device, bank) {
  const channels = bank.channels.map(cid => device.channels.find(item => item.id === cid)).filter(Boolean);
  const gaps = [], seen = new Set();
  for (const control of bank.controls) for (const binding of Object.values(control)) {
    const key = binding.parameter;
    if (!key || BANK_MOD_PARAMETERS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const missing = channels.filter(channel => !channel.parameters[key]).map(channel => channel.name);
    if (missing.length) gaps.push({ key, label: stripLabel(channels.find(channel => channel.parameters[key])?.parameters[key].label || key), missing });
  }
  return gaps;
}

// Reset only acts on parameters that define a reset value. This lists, for a strip, which
// mapped parameters have one on every channel and which would silently do nothing.
export function resetCoverage(device, bank) {
  const channels = bank.channels.map(cid => device.channels.find(item => item.id === cid)).filter(Boolean);
  const keys = [...new Set(bank.controls.flatMap(control => Object.values(control).map(binding => binding.parameter)))].filter(key => key && !BANK_MOD_PARAMETERS.includes(key));
  const label = key => stripLabel(channels.find(channel => channel.parameters[key])?.parameters[key].label || key);
  const covered = [], missing = [];
  for (const key of keys) {
    const values = channels.map(channel => channel.parameters[key]?.reset);
    const entry = { key, label: label(key), value: values.find(value => value != null) ?? null, partial: values.some(value => value == null) && values.some(value => value != null) };
    (values.length && values.every(value => value != null && channels.every(channel => channel.parameters[key]?.include_reset !== false)) ? covered : missing).push(entry);
  }
  return { covered, missing };
}

export function setParameterReset(draft, deviceId, channelIds, key, value) {
  const device = findDevice(draft, deviceId);
  if (value !== null && (!Number.isInteger(value) || value < 0 || value > 127)) fail('A reset value is 0–127.');
  for (const cid of channelIds) {
    const parameter = device.channels.find(channel => channel.id === cid)?.parameters[key];
    if (!parameter) continue;
    parameter.reset = value;
    if (value !== null && parameter.include_reset === false) delete parameter.include_reset;
  }
}

// ---- parameters that mean the same thing on different channels --------------------------
// A catalogue import can key parameters by CC number (cc1 on channel 1, cc2 on channel 2), so a
// strip over two channels has no key in common even though "EQ HI LEVEL CH 1" and "… CH 2" are the
// same control. Aligning renames each channel's keys from the label with the channel number
// removed, and rewrites everything that pointed at the old keys.
// What a strip shows for a parameter: the label without the channel it happens to be on.
export const stripLabel = label => String(label || '').replace(/\s*\b(ch|channel)\s*\d+\s*$/i, '').trim() || String(label || '');
export const canonicalParameterLabel = label => String(label || '').trim().toLowerCase().replace(/\s*\b(ch|channel)\s*\d+\s*$/, '').replace(/\s+/g, ' ');
const parameterSlug = label => canonicalParameterLabel(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function alignDeviceParameters(draft, deviceId) {
  const device = findDevice(draft, deviceId);
  const renames = new Map(), reserved = new Set([...BANK_MOD_PARAMETERS, 'volume']);
  let count = 0;
  for (const channel of device.channels) {
    const map = {}, taken = new Set(Object.keys(channel.parameters));
    const entries = Object.entries(channel.parameters);
    const wanted = new Map();
    for (const [key, parameter] of entries) {
      const slug = parameterSlug(parameter.label || key);
      if (slug) wanted.set(slug, [...(wanted.get(slug) || []), key]);
    }
    const result = {};
    for (const [key, parameter] of entries) {
      const slug = parameterSlug(parameter.label || key);
      const unique = slug && wanted.get(slug).length === 1 && !reserved.has(slug);
      const next = unique && slug !== key && !taken.has(slug) ? slug : key;
      if (next !== key) { taken.delete(key); taken.add(next); map[key] = next; count++; }
      result[next] = parameter;
    }
    channel.parameters = result;
    if (Object.keys(map).length) renames.set(channel.id, map);
  }
  if (!count) return 0;
  const rename = (cids, key) => { for (const cid of cids) { const next = renames.get(Array.isArray(cid) ? cid[0] : cid)?.[key]; if (next) return next; } return key; };
  const banks = new Map(draft.setup.banks.map(bank => [bank.id, bank]));
  for (const bank of draft.setup.banks) {
    for (const control of bank.controls) for (const binding of Object.values(control)) {
      if (bank.destination === deviceId && binding.parameter && !BANK_MOD_PARAMETERS.includes(binding.parameter)) binding.parameter = rename(bank.channels, binding.parameter);
      for (const send of binding.sends || []) if (send.device === deviceId) send.parameter = rename([send.set], send.parameter);
    }
  }
  const channelsOf = destination => destination.banks?.length ? destination.banks.flatMap(id => banks.get(id)?.channels || []) : destination.channels;
  for (const mod of draft.performance.mods) {
    for (const destination of mod.destinations || []) if (destination.device === deviceId && destination.parameter !== 'volume') destination.parameter = rename(channelsOf(destination), destination.parameter);
    for (const target of mod.bank_targets || []) { const bank = banks.get(target.bank); if (bank?.destination === deviceId && target.parameter !== 'volume') target.parameter = rename(bank.channels, target.parameter); }
    for (const target of mod.targets || []) if (target.ref[0] === deviceId) target.ref[2] = rename([target.ref[1]], target.ref[2]);
  }
  for (const op of draft.performance.operators || []) for (const target of op.targets) if (target.device === deviceId && target.parameter !== 'volume') target.parameter = rename(channelsOf(target), target.parameter);
  return count;
}

// After a strip's channels change: if some mapped parameter is now missing, try aligning the device.
export function alignIfNeeded(draft, bank) {
  const device = findDevice(draft, bank.destination);
  if (!bankParameterGaps(device, bank).length) return false;
  if (!alignDeviceParameters(draft, device.id)) return false;
  return true;
}

// Operators that read this controller CC (as a signal or to set one of their settings).
export const operatorsReadingSource = (draft, controllerId, source) => !source ? [] : (draft.performance.operators || []).filter(op =>
  [...op.inputs.filter(i => i.type === 'cc'), ...Object.values(op.links)].some(i => i.controller === controllerId && i.channel === source.channel && i.number === source.cc));

// The parameters a strip can offer: those on every selected channel first, then those on
// only some (flagged), so a choice is never invisible just because the channel set changed.
export function bankParameterChoices(device, bank, current = []) {
  const channels = bank.channels.map(cid => device.channels.find(item => item.id === cid)).filter(Boolean);
  const pool = channels.length ? channels : device.channels.slice(0, 1);
  const labels = new Map(), where = new Map();
  for (const channel of pool) for (const [key, parameter] of Object.entries(channel.parameters)) {
    if (!labels.has(key)) labels.set(key, stripLabel(parameter.label || key));
    where.set(key, [...(where.get(key) || []), channel.name]);
  }
  const common = [], partial = [];
  for (const [key, label] of labels) {
    if (where.get(key).length === pool.length) common.push({ key, label, ok: true });
    else partial.push({ key, label: `⚠ ${label} (only ${where.get(key).join(', ')})`, ok: false });
  }
  for (const key of current) if (key && !labels.has(key) && !BANK_MOD_PARAMETERS.includes(key)) partial.push({ key, label: `⚠ ${key} (not on this device)`, ok: false });
  return [...common, ...partial];
}

// Re-pick a parameter on another device/channel by its label when the key differs.
export function matchParameter(fromDevice, toChannel, key) {
  if (!key || BANK_MOD_PARAMETERS.includes(key)) return key;
  if (toChannel.parameters[key]) return key;
  const label = fromDevice?.channels?.flatMap(channel => Object.entries(channel.parameters)).find(([name]) => name === key)?.[1]?.label;
  if (!label) return null;
  const wanted = canonicalParameterLabel(label);
  return Object.entries(toChannel.parameters).find(([, parameter]) => canonicalParameterLabel(parameter.label) === wanted)?.[0] ?? null;
}

export function importWorkspaceStyles(layout, draft, workspace) {
  let count = 0;
  for (const module of workspace.modules || []) {
    const bank = draft.setup.banks.find(item => item.id === module.runtimeBank);
    if (!bank) continue;
    for (const control of module.controls || []) {
      const reference = control.bindings?.normal?.runtime;
      if (!reference || reference.bank !== bank.id || !bank.controls[reference.index]?.[reference.layer]) continue;
      if (!sameIdentity(reference.identity, controlIdentity(bank, reference.index, reference.layer))) continue;
      layout.controls ||= {};
      layout.controls[`${bank.id}:${reference.index}`] = { kind: module.kind, centerDetent: control.centerDetent === true };
      count++;
    }
  }
  return count;
}

export function playableControl(draft, snapshot, bankId, index, layer) {
  if (!snapshot?.native || !snapshot.running || snapshot.staged || !snapshot.instance_id || !snapshot.definitions_revision) return null;
  const bank = draft.setup.banks.find(item => item.id === bankId);
  if (!bank?.controls[index]?.[layer]) return null;
  const control = snapshot.controls.find(item => item.bank === bankId && item.index === index && item.layer === layer);
  const controller = draft.setup.devices.find(device => device.id === bank.controller);
  if (controller?.layer_mode === 'software' && snapshot.active_layers?.[bank.controller] !== layer) return null;
  return control?.assigned && sameIdentity(control.identity, controlIdentity(bank, index, layer)) ? control : null;
}

// ---------------------------------------------------------------- graph

function devicesById(setup) { return Object.fromEntries(setup.devices.map(device => [device.id, device])); }

export function controllerInputs(draft, layout, controllerId) {
  const inputs = new Map();
  const add = (binding, source) => {
    const key = inputKey(binding);
    const entry = inputs.get(key) || { key, binding: { type: binding.type || 'cc', channel: binding.channel, number: binding.number ?? null }, uses: [], label: binding.label || null };
    if (source) entry.uses.push(source);
    if (binding.label && !entry.label) entry.label = binding.label;
    inputs.set(key, entry);
  };
  for (const declared of layout.inputs?.[controllerId] || []) add(declared, null);
  const controller = draft.setup.devices.find(device => device.id === controllerId);
  if (controller?.layer_mode === 'software' && controller.layer_switch) add(controller.layer_switch, { kind: 'layer' });
  draft.setup.resets.forEach((reset, index) => {
    if (reset.controller === controllerId) add({ type: 'cc', channel: reset.channel, number: reset.cc }, { kind: 'reset', index });
  });
  (draft.routing.notes || []).forEach((route, index) => {
    if (route.controller === controllerId) add({ type: 'note', channel: route.channel, number: null }, { kind: 'notes', index });
  });
  draft.performance.actions.forEach((action, index) => {
    if (action.controller === controllerId) add(action, { kind: 'action', index });
  });
  (draft.performance.operators || []).forEach((op, index) => {
    const owned = ref => draft.setup.banks.some(bank => bank.controller === controllerId && bank.controls.some(control => Object.values(control).some(binding => binding.source && binding.source.channel === ref.channel && binding.source.cc === ref.number)));
    for (const input of op.inputs) if (input.type === 'cc' && input.controller === controllerId && !owned(input)) add({ type: 'cc', channel: input.channel, number: input.number }, { kind: 'operator', op: index });
    for (const link of Object.values(op.links)) if (link.controller === controllerId && !owned(link)) add({ type: 'cc', channel: link.channel, number: link.number }, { kind: 'operator', op: index });
  });
  const shift = draft.performance.shift;
  if (shift && shift.controller === controllerId) add(shift, { kind: 'shift' });
  draft.performance.mods.forEach((mod, index) => {
    if (mod.trigger && mod.trigger.controller === controllerId) add(mod.trigger, { kind: 'trigger', mod: index });
  });
  return [...inputs.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

export function retainInputs(draft, layout) {
  layout.inputs ||= {};
  for (const controller of draft.setup.devices.filter(device => device.kind === 'controller')) {
    for (const entry of controllerInputs(draft, layout, controller.id)) {
      if (!(layout.inputs[controller.id] || []).some(binding => inputKey(binding) === entry.key)) {
        declareInput(layout, controller.id, { ...entry.binding, label: entry.label });
      }
    }
  }
}

export function roleBadges(draft, entry) {
  const badges = [];
  for (const use of entry.uses) {
    if (use.kind === 'layer') badges.push('▦ Switch layer');
    if (use.kind === 'notes') {
      const route = draft.routing.notes[use.index];
      const device = draft.setup.devices.find(item => item.kind === 'destination' && item.output && item.output === route.port);
      badges.push(`♪ → ${device?.name || route.port}${route.low > 0 || route.high < 127 ? ` ${noteName(route.low)}–${noteName(route.high)}` : ''}`);
    }
    if (use.kind === 'shift') badges.push(`⇧ Shift (${draft.performance.shift.mode})`);
    if (use.kind === 'action') {
      const action = draft.performance.actions[use.index];
      const condition = action.shift && action.shift !== 'any' ? ` ⇧${action.shift}` : '';
      const name = { capture: `◈ Save ${action.slot + 1}`, recall: `◈ Recall ${action.slot + 1}`, cancel: '✕ Cancel queued', align: '⌖ Set the one',
        mod_stop: '■ Stop MODs', panic: '⚠ Panic', reset: action.bank == null ? '⟲ Reset all' : null }[action.action];
      if (name) badges.push(name + condition);
    }
    if (use.kind === 'reset') {
      const reset = draft.setup.resets[use.index];
      if ((reset.action || 'reset') === 'reset' && reset.bank == null) badges.push('⟲ Reset all');
      else if ((reset.action || 'reset') === 'reset') badges.push(`⟲ Reset ${draft.setup.banks.find(bank => bank.id === reset.bank)?.name || reset.bank}`);
      if (reset.action === 'panic') badges.push('⚠ Release envelopes');
    }
  }
  return badges;
}

function parameterLabels(device, channelIds, keys) {
  const channel = device?.channels.find(item => channelIds.includes(item.id)) || device?.channels[0];
  return keys.map(key => channel?.parameters[key]?.label || ({ depth: 'MOD 1 amt', mod_depth_2: 'MOD 2 amt', mod_depth_3: 'MOD 3 amt', volume: 'Volume' }[key] || key));
}

export function bindingLabel(bank, index, layer, binding) {
  return binding.label || `${layer === 'normal' ? '' : layer + ' '}${index + 1}`.trim();
}

export function buildGraph(draft, layout = emptyLayout(), view = {}) {
  const detail = view.detail === 'control';
  const { setup, performance, routing } = draft;
  const devices = devicesById(setup);
  const banks = Object.fromEntries(setup.banks.map(bank => [bank.id, bank]));
  const nodes = [], wires = [];
  const deviceUse = {};
  const touch = (deviceId, cid, text) => {
    const key = `${deviceId}:${channelKey(cid)}`;
    (deviceUse[key] ||= new Set()).add(text);
  };

  for (const device of setup.devices.filter(item => item.kind === 'controller')) {
    const sections = [];
    for (const bank of setup.banks.filter(item => item.controller === device.id)) {
      const destination = devices[bank.destination];
      const used = [...new Set(bank.controls.flatMap(control => Object.values(control).map(binding => binding.parameter).filter(Boolean)))];
      const rows = detail ? bank.controls.flatMap((control, index) => Object.entries(control).map(([layer, binding]) => ({
        port: `ctl:${bank.id}:${index}:${layer}`, label: bindingLabel(bank, index, layer, binding),
        sub: `${binding.source ? `ch${binding.source.channel} cc${binding.source.cc}` : 'no input'} → ${binding.parameter ? parameterLabels(destination, bank.channels, [binding.parameter])[0] : '—'}`,
        bank: bank.id, index, layer, out: true,
      }))) : [];
      // One knob per physical control; each input layer (normal/alternate) is a port on it.
      const knobs = bank.controls.map((control, index) => ({ index, layers: Object.fromEntries(Object.entries(control).map(([layer, binding]) => [layer, {
        port: `ctl:${bank.id}:${index}:${layer}`, name: bindingLabel(bank, index, layer, binding), parameter: binding.parameter || null,
        label: binding.parameter ? (BANK_MOD_PARAMETERS.includes(binding.parameter) ? parameterLabels(destination, bank.channels, [binding.parameter])[0] : stripLabel(parameterLabels(destination, bank.channels, [binding.parameter])[0])) : (operatorsReadingSource(draft, bank.controller, binding.source)[0] ? `ƒ ${operatorsReadingSource(draft, bank.controller, binding.source)[0].name}` : '—'),
        input: binding.source ? `ch${binding.source.channel} cc${binding.source.cc}` : 'no input', sends: (binding.sends || []).length,
        feedback: binding.feedback ? `ch${binding.feedback.channel} cc${binding.feedback.cc}` : null, sync: binding.device_sync || 'off',
      }])) }));
      sections.push({ id: `bank:${bank.id}`, title: bank.name, bank: bank.id, inPort: `reset:${bank.id}`, knobs,
        outPort: detail ? null : `bank:${bank.id}`,
        sub: `${bank.controls.length} ctl → ${destination?.name || bank.destination} ${bank.channels.length ? 'ch ' + bank.channels.join(', ') : '(no channels)'}`,
        summary: parameterLabels(destination, bank.channels, used).join(' · '), rows });
    }
    const inputs = controllerInputs(draft, layout, device.id).map(entry => ({ ...entry, port: entry.key, out: true, badges: roleBadges(draft, entry) }));
    // Keyboard routes live inside the controller: every setting is an input port, like a MOD's.
    const keyRoutes = (routing.notes || []).map((route, index) => ({ route, index })).filter(({ route }) => (route.controller ? route.controller === device.id : device.input === route.source)).map(({ route, index }) => {
      const target = setup.devices.find(item => item.kind === 'destination' && item.output && item.output === route.port);
      const base = { transpose: route.transpose || 0, low: noteName(route.low), high: noteName(route.high), velocity: route.fixed_velocity != null ? `${route.fixed_velocity}` : 'played', channel: `${route.out_channel}`,
        root: route.scale ? NOTE_NAMES[route.scale.root] : 'no scale', bend: 'thru', pressure: 'thru', modwheel: 'thru', sustain: 'thru' };
      return { id: route.id, index, channel: route.channel, key: inputKey({ type: 'note', channel: route.channel, number: null }), title: `${route.low > 0 || route.high < 127 ? `${noteName(route.low)}–${noteName(route.high)}` : 'All keys'} → ${target?.name || route.port} · ch ${route.out_channel}`, wire: `notes:${index}`, outPort: `keyout:${route.id}`,
        scale: route.scale ? `${NOTE_NAMES[route.scale.root]} ${route.scale.mode.replace('_', ' ')}` : null,
        params: Object.entries(NOTE_PARAMS).map(([name, info]) => ({ port: `key:${route.id}:${name}`, name, label: info.label, value: String(base[name]), off: name === 'root' && !route.scale, expression: Boolean(info.expression) })) };
    });
    const layers = controllerLayerKeys(device);
    nodes.push({ id: `ctl:${device.id}`, type: 'controller', device: device.id, title: device.name, sub: device.input || 'input port not set', sections, inputs, layers,
      layerMode: device.layer_mode || 'hardware', layerTypes: device.layer_types || {}, pages: device.pages || ['Page 1'],
      routes: routing.cc.map((route, index) => ({ ...route, index })).filter(route => route.source === device.input), keyRoutes,
      feedbackPort: device.feedback_output || null });
  }

  setup.banks.forEach(bank => {
    const destination = devices[bank.destination];
    const keys = new Set();
    bank.controls.forEach((control, index) => Object.entries(control).forEach(([layer, binding]) => {
      if (binding.parameter && !BANK_MOD_PARAMETERS.includes(binding.parameter)) keys.add(binding.parameter);
      if (detail && binding.parameter && !BANK_MOD_PARAMETERS.includes(binding.parameter)) for (const cid of bank.channels) {
        wires.push({ id: `strip:${bank.id}:${index}:${layer}:${cid}`, kind: 'strip', from: [`ctl:${bank.controller}`, `ctl:${bank.id}:${index}:${layer}`],
          to: [`dev:${bank.destination}`, `ch:${cid}`], bank: bank.id, cid, index, layer, derived: true, toUse: parameterLabels(destination, [cid], [binding.parameter])[0], label: stripLabel(parameterLabels(destination, [cid], [binding.parameter])[0]) });
      }
      (binding.note_links || []).forEach((link, linkIndex) => {
        const owner = noteRouteOwner(setup, (routing.notes || []).find(route => route.id === link.route));
        if (!owner) return;
        wires.push({ id: `notectl:${bank.id}:${index}:${layer}:${linkIndex}`, kind: 'notectl', bank: bank.id, index, layer, link: linkIndex, route: link.route,
          from: [`ctl:${bank.controller}`, detail ? `ctl:${bank.id}:${index}:${layer}` : `bank:${bank.id}`], to: [`ctl:${owner}`, `key:${link.route}:${link.parameter}`],
          label: `♪ ${NOTE_PARAMS[link.parameter]?.label || link.parameter}` });
      });
      (binding.sends || []).forEach((send, sendIndex) => {
        touch(send.device, send.set, parameterLabels(devices[send.device], [send.set], [send.parameter])[0]);
        const from = detail ? `ctl:${bank.id}:${index}:${layer}` : `bank:${bank.id}`;
        wires.push({ id: `send:${bank.id}:${index}:${layer}:${sendIndex}`, kind: 'send', from: [`ctl:${bank.controller}`, from], to: [`dev:${send.device}`, `ch:${send.set}`],
          bank: bank.id, index, layer, send: sendIndex, label: `+ ${parameterLabels(devices[send.device], [send.set], [send.parameter])[0]}` });
      });
    }));
    const labels = parameterLabels(destination, bank.channels, [...keys]);
    for (const cid of bank.channels) {
      parameterLabels(destination, [cid], [...keys]).forEach(label => touch(bank.destination, cid, label));
      if (!detail) wires.push({ id: `strip:${bank.id}:${cid}`, kind: 'strip', from: [`ctl:${bank.controller}`, `bank:${bank.id}`], to: [`dev:${bank.destination}`, `ch:${cid}`],
        bank: bank.id, cid, label: `${bank.controls.length} ctl` });
    }
  });

  performance.mods.forEach((mod, index) => {
    const id = `mod:${index}`;
    nodes.push({ id, type: 'mod', mod: index, title: mod.name, shape: mod.shape, enabled: mod.enabled,
      sub: `${SHAPES[mod.shape] || ''} ${mod.shape.replace('_', ' ')} · ${mod.shape === 'envelope' ? `${Math.round(mod.release_ms)} ms rel` : mod.timing === 'sync' ? `${mod.beats} beats` : `${(+mod.rate).toFixed(2)} Hz`}`,
      inputs: MOD_INPUTS.filter(port => port !== 'release' || mod.shape === 'envelope').filter(port => port !== 'phase' || mod.shape !== 'envelope')
        .map(port => ({ port, label: port === 'phase' && mod.shape === 'random' ? 'slew' : port })) });
    mod.destinations.forEach((destination, destIndex) => {
      const device = devices[destination.device];
      const label = `${parameterLabels(device, destination.channels.map(channelKey), [destination.parameter])[0]} ${destination.amount >= 0 ? '+' : ''}${(+destination.amount).toFixed(2)}`;
      for (const cid of destination.channels) {
        touch(destination.device, cid, `∿ ${parameterLabels(device, [channelKey(cid)], [destination.parameter])[0]}`);
        wires.push({ id: `mod:${index}:${destIndex}:c${channelKey(cid)}`, kind: 'mod', mod: index, dest: destIndex, cid: channelKey(cid), from: [id, 'out'], to: [`dev:${destination.device}`, `ch:${channelKey(cid)}`], label });
      }
      for (const bid of destination.banks) for (const cid of banks[bid]?.channels || []) {
        touch(destination.device, cid, `∿ ${parameterLabels(device, [cid], [destination.parameter])[0]}`);
        wires.push({ id: `mod:${index}:${destIndex}:b${bid}:${cid}`, kind: 'mod', mod: index, dest: destIndex, bank: bid, cid, from: [id, 'out'], to: [`dev:${destination.device}`, `ch:${cid}`], label: `${label} · ${banks[bid].name}` });
      }
    });
    mod.bank_targets.forEach((target, targetIndex) => {
      const bank = banks[target.bank]; if (!bank) return;
      for (const cid of bank.channels) {
        const name = parameterLabels(devices[bank.destination], [cid], [target.parameter])[0];
        touch(bank.destination, cid, `∿ ${name}`);
        wires.push({ id: `modbank:${index}:${targetIndex}:${cid}`, kind: 'mod', mod: index, legacy: 'bank', legacyIndex: targetIndex, bank: bank.id, cid,
          from: [id, 'out'], to: [`dev:${bank.destination}`, `ch:${cid}`], label: `${name} · ${bank.name} amount` });
      }
    });
    mod.targets.forEach((target, targetIndex) => {
      const [deviceId, cid, parameter] = target.ref;
      touch(deviceId, cid, `∿ ${parameterLabels(devices[deviceId], [channelKey(cid)], [parameter])[0]}`);
      wires.push({ id: `modref:${index}:${targetIndex}`, kind: 'mod', mod: index, legacy: 'ref', legacyIndex: targetIndex, cid: channelKey(cid),
        from: [id, 'out'], to: [`dev:${deviceId}`, `ch:${channelKey(cid)}`], label: `${parameter} ${(+target.amount).toFixed(2)}` });
    });
    mod.mod_targets.forEach((target, targetIndex) => wires.push({ id: `modmod:${index}:${targetIndex}`, kind: 'modmod', mod: index, target: targetIndex,
      from: [id, 'out'], to: [`mod:${target.mod}`, target.parameter], label: `${target.parameter} ${target.amount >= 0 ? '+' : ''}${(+target.amount).toFixed(2)}` }));
    if (mod.trigger) wires.push({ id: `trigger:${index}`, kind: 'trigger', mod: index, from: [`ctl:${mod.trigger.controller}`, inputKey(mod.trigger)], to: [id, 'trigger'],
      label: mod.trigger.type === 'note' ? `note ${mod.trigger.number ?? 'any'}` : 'gate' });
    (mod.note_targets || []).forEach((target, targetIndex) => {
      if (!(routing.notes || []).some(route => route.id === target.route)) return;
      const owner = noteRouteOwner(setup, routing.notes.find(route => route.id === target.route));
      if (!owner) return;
      wires.push({ id: `notemod:${index}:${targetIndex}`, kind: 'notemod', mod: index, target: targetIndex, route: target.route, from: [id, 'out'], to: [`ctl:${owner}`, `key:${target.route}:${target.parameter}`],
        label: `${NOTE_PARAMS[target.parameter]?.label || target.parameter} ${target.amount >= 0 ? '+' : ''}${(+target.amount).toFixed(2)}` });
    });
    if (mod.timing === 'sync') wires.push({ id: `sync:${index}`, kind: 'clock', mod: index, from: ['clock', 'out'], to: [id, 'sync'], label: `${mod.beats} beats` });
  });

  const actionTarget = action => {
    if (NOTE_ACTIONS[action.action]) {
      const owner = noteRouteOwner(setup, (routing.notes || []).find(route => route.id === action.route));
      return owner ? [`ctl:${owner}`, `key:${action.route}:${NOTE_ACTIONS[action.action]}`] : null;
    }
    if (action.action === 'reset' && action.bank != null) return banks[action.bank] ? [`ctl:${banks[action.bank].controller}`, `reset:${action.bank}`] : null;
    if (action.action === 'reset' && action.layer != null) return (setup.devices.find(device => device.id === action.layer_controller)) ? [`ctl:${action.layer_controller}`, `resetlayer:${action.layer}`] : null;
    if (action.action === 'mod_trigger') return [`mod:${action.mod}`, 'trigger'];
    if (action.action === 'mod_enable') return [`mod:${action.mod}`, 'enable'];
    const port = Object.entries(CONTINUOUS_ACTIONS).find(([, kind]) => kind === action.action)?.[0];
    if (port) return [`mod:${action.mod}`, port];
    if (action.action === 'mod_depth') return [`mod:${action.mod}`, 'amount'];
    return null;
  };
  performance.actions.forEach((action, index) => {
    const to = actionTarget(action); if (!to) return;
    const condition = action.shift && action.shift !== 'any' ? ` ⇧${action.shift}` : '';
    const name = NOTE_ACTIONS[action.action] ? `♪ ${NOTE_PARAMS[NOTE_ACTIONS[action.action]].label}` : { reset: action.layer != null ? `⟲ layer ${action.layer}` : '⟲ reset', mod_trigger: 'trigger', mod_enable: 'on/off', mod_depth: `${banks[action.bank]?.name || action.bank} amount` }[action.action] || action.action.replace('mod_', '');
    wires.push({ id: `action:${index}`, kind: 'action', action: index, from: [`ctl:${action.controller}`, inputKey(action)], to, label: `${name}${action.when === 'bar' ? ' @bar' : ''}${condition}` });
  });
  setup.resets.forEach((reset, index) => {
    const kind = reset.action || 'reset';
    const from = [`ctl:${reset.controller}`, inputKey({ type: 'cc', channel: reset.channel, number: reset.cc })];
    if (kind === 'reset' && reset.bank != null && banks[reset.bank]) wires.push({ id: `reset:${index}`, kind: 'action', reset: index, from, to: [`ctl:${banks[reset.bank].controller}`, `reset:${reset.bank}`], label: reset.channel_id ? `⟲ ch ${reset.channel_id}` : '⟲ reset' });
    if (kind === 'depth') wires.push({ id: `reset:${index}`, kind: 'action', reset: index, from, to: ['mod:0', 'amount'], label: `${banks[reset.bank]?.name || ''} amount` });
    if (kind === 'release') wires.push({ id: `reset:${index}`, kind: 'action', reset: index, from, to: ['mod:0', 'release'], label: 'release' });
  });

  const noteDevices = new Set(), noteSources = new Map();
  (routing.notes || []).forEach((route, index) => {
    const device = setup.devices.find(item => item.kind === 'destination' && item.output && item.output === route.port);
    const controller = setup.devices.find(item => item.kind === 'controller' && (route.controller ? item.id === route.controller : item.input === route.source));
    if (!device || !controller) return;
    noteDevices.add(device.id);
    // Each route leaves its own block inside the controller and lands on its own row of the destination,
    // so a split keyboard shows one visible path per route instead of wires stacked on one another.
    const range = route.low > 0 || route.high < 127 ? `${noteName(route.low)}–${noteName(route.high)}` : 'all keys';
    if (!noteSources.has(device.id)) noteSources.set(device.id, []);
    noteSources.get(device.id).push({ port: `notes:${route.id}`, label: `${controller.name} · ${range}`, sub: `ch ${route.channel} → ${route.out_channel}` });
    wires.push({ id: `notes:${index}`, kind: 'notes', route: index, controller: controller.id, from: [`ctl:${controller.id}`, `keyout:${route.id}`],
      to: [`dev:${device.id}`, `notes:${route.id}`], label: `♪ ${range} · ch ${route.channel} → ${route.out_channel}` });
  });
  const anyNoteInput = noteDevices.size > 0 || Object.values(layout.inputs || {}).some(list => list.some(item => item.type === 'note'));

  const clockRows = [];
  for (const port of routing.clock.destinations) {
    const device = setup.devices.find(item => item.kind === 'destination' && item.output && item.output === port);
    if (device) wires.push({ id: `clock:${port}`, kind: 'clock', port, from: ['clock', 'out'], to: [`dev:${device.id}`, 'clock'], label: 'clock' });
    else clockRows.push(port);
  }
  nodes.push({ id: 'clock', type: 'clock', title: 'Clock', sub: routing.clock.source ? `from ${routing.clock.source}` : 'no clock source', ports: clockRows, transport: routing.clock.transport });
  if (routing.cc.length) {
    nodes.push({ id: 'thru', type: 'thru', title: 'MIDI Thru', sub: `${routing.cc.length} direct CC route${routing.cc.length === 1 ? '' : 's'}`, routes: routing.cc });
    routing.cc.forEach((route, index) => {
      if (!route.controller) return;
      wires.push({ id: `thru:${index}`, kind: 'thru', route: index, controller: route.controller, layer: route.layer,
        from: [`ctl:${route.controller}`, `direct:${index}`], to: ['thru', `route:${index}`], label: `CC ${route.cc} → ch ${route.destinations[0].channel} CC ${route.destinations[0].cc}` });
    });
  }

  Ops.operators(draft).forEach(op => op.targets.forEach(target => { for (const cid of [...target.channels, ...(target.banks || []).flatMap(id => banks[id]?.channels || [])]) touch(target.device, Array.isArray(cid) ? cid[0] : cid, `ƒ ${parameterLabels(devices[target.device], [Array.isArray(cid) ? cid[0] : cid], [target.parameter])[0]}`); }));
  for (const device of setup.devices.filter(item => item.kind === 'destination')) {
    const syncing = setup.banks.some(bank => bank.controls.some(control => Object.values(control).some(binding => (binding.device_sync || 'off') !== 'off' &&
      ((bank.destination === device.id && binding.parameter) || (binding.sends || []).some(send => send.device === device.id)))));
    nodes.push({ id: `dev:${device.id}`, type: 'device', device: device.id, title: device.name, sub: device.output || 'output port not set',
      channelMode: device.channel_mode || 'fixed',
      input: device.input || null, twoWay: Boolean(device.input) && syncing, acceptsNotes: anyNoteInput, noteSources: noteSources.get(device.id) || [],
      channels: device.channels.map(channel => ({ port: `ch:${channel.id}`, id: channel.id, label: channel.name, uses: [...(deviceUse[`${device.id}:${channel.id}`] || [])], volume: Boolean(channel.volume),
        addresses: Object.entries({ ...channel.parameters, ...(channel.volume ? { volume: { ...channel.volume, label: 'Volume' } } : {}) }).map(([key, parameter]) => ({ key, label: parameter.label || key, channel: parameter.channel, cc: parameter.cc })) })) });
  }
  const opGraph = Ops.operatorGraph(draft, { devices, labelFor: (device, cid, parameter) => parameterLabels(device, [cid], [parameter])[0], modName: index => performance.mods[index]?.name || `MOD ${index + 1}`,
    // A knob that also drives a strip control is drawn from that control; otherwise from its global input.
    knobPort: link => {
      for (const bank of setup.banks) if (bank.controller === link.controller) for (const [index, control] of bank.controls.entries()) for (const [layer, binding] of Object.entries(control)) {
        if (binding.source && binding.source.channel === link.channel && binding.source.cc === link.number) return [`ctl:${bank.controller}`, detail ? `ctl:${bank.id}:${index}:${layer}` : `bank:${bank.id}`];
      }
      return [`ctl:${link.controller}`, inputKey({ type: 'cc', channel: link.channel, number: link.number })];
    } });
  nodes.push(...opGraph.nodes); wires.push(...opGraph.wires);
  // A strip knob that sets a MOD's amount for this strip is drawn to the channels it scales.
  setup.banks.forEach(bank => {
    const seen = new Set();
    bank.controls.forEach((control, index) => Object.entries(control).forEach(([layer, binding]) => {
      const slot = BANK_MOD_PARAMETERS.indexOf(binding.parameter);
      if (slot < 0 || !performance.mods[slot]) return;
      for (const cid of bank.channels) {
        const key = detail ? `${index}:${layer}:${cid}` : `${slot}:${cid}`;
        if (seen.has(key)) continue; seen.add(key);
        wires.push({ id: `modamount:${bank.id}:${detail ? `${index}:${layer}` : slot}:${cid}`, kind: 'modamount', bank: bank.id, cid, slot, index: detail ? index : undefined, layer: detail ? layer : undefined, derived: true,
          from: [`ctl:${bank.controller}`, detail ? `ctl:${bank.id}:${index}:${layer}` : `bank:${bank.id}`], to: [`dev:${bank.destination}`, `ch:${cid}`], label: `${performance.mods[slot].name} amount` });
      }
    }));
  });
  const snaps = Snap.snapshotGraph(draft, { banks, devices, saved: view?.saved || [] });
  nodes.push(...snaps.nodes); wires.push(...snaps.wires);
  performance.actions.forEach((action, index) => {
    if (!['capture', 'recall'].includes(action.action) || !snaps.nodes.some(node => node.slot === action.slot)) return;
    wires.push({ id: `action:${index}`, kind: 'action', action: index, from: [`ctl:${action.controller}`, inputKey(action)], to: [`snap:${action.slot}`, action.action === 'recall' ? 'recall' : 'capture'],
      label: `${action.action === 'recall' ? 'recall' : 'save'}${action.when === 'bar' ? ' @bar' : ''}${action.shift && action.shift !== 'any' ? ` ⇧${action.shift}` : ''}` });
  });
  return { nodes, wires };
}

// ---------------------------------------------------------------- layout

export function estimateHeight(node) {
  if (node.type === 'controller') return 64 + node.sections.reduce((sum, section) => sum + 44 + section.rows.length * 30, 0) + 28 + node.inputs.length * 30 + (node.keyRoutes?.length || 0) * 150;
  if (node.type === 'mod') return 92 + node.inputs.length * 22;
  if (node.type === 'device') return 52 + node.channels.length * 34 + (node.noteSources?.length || 0) * 22;
  if (node.type === 'operator') return 100 + node.params.length * 24;
  if (node.type === 'snapshot') return 120 + node.targets.length * 4;
  if (node.type === 'clock') return 76 + node.ports.length * 22;
  return 70 + (node.routes?.length || 0) * 22;
}

export function autoLayout(graph, layout) {
  const result = clone(layout);
  const processing = graph.nodes.some(node => ['operator', 'snapshot'].includes(node.type));
  const columns = { controller: 40, clock: 470, mod: 470, thru: 470, snapshot: 860, operator: 860, device: processing ? 1250 : 860 };
  const cursor = { 40: 40, 470: 40, 860: 40, 1250: 40 };
  for (const node of graph.nodes) {
    if (result.nodes[node.id]) {
      const column = columns[node.type];
      cursor[column] = Math.max(cursor[column], result.nodes[node.id].y + estimateHeight(node) + 24);
    }
  }
  for (const type of ['controller', 'clock', 'mod', 'thru', 'snapshot', 'operator', 'device']) for (const node of graph.nodes.filter(item => item.type === type)) {
    if (result.nodes[node.id]) continue;
    const x = columns[type];
    result.nodes[node.id] = { x, y: cursor[x] };
    cursor[x] += estimateHeight(node) + 24;
  }
  return result;
}

export function visibleOnPage(layout, pageId, nodeId) {
  if (!pageId) return true;
  const page = layout.pages.find(item => item.id === pageId);
  if (!page) return true;
  const paged = layout.pages.some(item => item.nodes.includes(nodeId));
  return !paged || page.nodes.includes(nodeId);
}

// ---------------------------------------------------------------- edits

function migrateMod(mod, setup) {
  const result = clone(mod);
  const banks = Object.fromEntries(setup.banks.map(bank => [bank.id, bank]));
  const grouped = new Map();
  for (const target of result.bank_targets) {
    const bank = banks[target.bank]; if (!bank) continue;
    const key = `${bank.destination}\u0000${target.parameter}`;
    if (!grouped.has(key)) grouped.set(key, { device: bank.destination, parameter: target.parameter, channels: [], banks: [], amount: 1, scale_by_bank: true });
    grouped.get(key).banks.push(bank.id);
  }
  result.destinations.push(...grouped.values());
  for (const target of result.targets) result.destinations.push({ device: target.ref[0], parameter: target.ref[2], channels: [target.ref[1]], banks: [], amount: target.amount, scale_by_bank: false });
  result.targets = []; result.bank_targets = [];
  return result;
}

function findBank(draft, id) { return draft.setup.banks.find(bank => bank.id === id) || fail('That strip no longer exists.'); }
function findDevice(draft, id) { return draft.setup.devices.find(device => device.id === id) || fail('That device no longer exists.'); }

export function portKind(nodeId, portId) {
  if (nodeId.startsWith('ctl:')) {
    if (portId.startsWith('key:')) return 'keyparam';
    if (portId.startsWith('bank:')) return 'bank';
    if (portId.startsWith('ctl:')) return 'control';
    if (portId.startsWith('in:')) return 'input';
    if (portId.startsWith('reset:')) return 'reset';
    if (portId.startsWith('resetlayer:')) return 'resetlayer';
  }
  if (nodeId.startsWith('snap:')) return portId === 'out' ? 'snapout' : 'snapin';
  if (nodeId.startsWith('op:')) return portId === 'out' ? 'opout' : portId === 'in' ? 'opin' : 'opparam';
  if (nodeId.startsWith('dev:')) return portId.startsWith('notes:') ? 'devnoteroute' : portId === 'clock' ? 'devclock' : portId === 'notes' ? 'devnotes' : portId === 'snap' ? 'devsnap' : 'channel';
  if (nodeId.startsWith('mod:')) return portId === 'out' ? 'modout' : 'modin';
  if (nodeId === 'clock') return portId === 'out' ? 'clockout' : 'clockin';
  return 'unknown';
}

export function isOutput(nodeId, portId) {
  return ['bank', 'control', 'input', 'modout', 'clockout', 'snapout', 'opout'].includes(portKind(nodeId, portId));
}

function wouldCycle(mods, from, to) {
  const seen = new Set();
  const visit = index => {
    if (index === from) return true;
    if (seen.has(index)) return false;
    seen.add(index);
    return mods[index].mod_targets.some(target => visit(target.mod));
  };
  return visit(to);
}

// A channel fader as a plain parameter (a catalogue "LEVEL CH 1", "Volume", "Fader", "Gain").
const LEVEL_KEY = /^(level|volume|fader|gain)$/;
export const levelParameter = (device, channelIds) => {
  const channels = device.channels.filter(channel => channelIds.includes(channel.id));
  if (!channels.length) return null;
  return Object.keys(channels[0].parameters).find(key => LEVEL_KEY.test(parameterSlug(channels[0].parameters[key].label || key)) && channels.every(channel => channel.parameters[key])) || null;
};

// Any parameter can be modulated, not just a sidechain volume. Prefer volume for an envelope,
// then a smooth (Continuous) parameter nobody uses yet; with none, take the first parameter and
// mark it Continuous (the engine only moves smooth parameters) so a MOD is never a dead end.
function firstModParameter(device, cid, mod, existing) {
  const channel = device.channels.find(item => item.id === cid) || fail('Unknown channel.');
  // A sidechain ducks the channel's fader: a Level/Volume parameter if the device has one, else its calibrated volume.
  if (mod.shape === 'envelope') { const level = levelParameter(device, [cid]); if (level) { allowModulation(device, [cid], level); return level; } if (channel.volume) return 'volume'; }
  const used = new Set(existing);
  const entries = Object.entries(channel.parameters);
  if (!entries.length) fail(`${channel.name} has no parameters yet. Add one in Devices first.`);
  const continuous = entries.filter(([, parameter]) => parameter.continuous).map(([key]) => key);
  const pick = continuous.find(key => !used.has(key)) || continuous[0] || entries.find(([key]) => !used.has(key))?.[0] || entries[0][0];
  allowModulation(device, [cid], pick);
  return pick;
}

// Make a parameter movable by a MOD on the given channels (sets its Continuous flag).
export function allowModulation(device, channelIds, key) {
  for (const cid of channelIds) {
    const parameter = device.channels.find(channel => channel.id === cid)?.parameters[key];
    if (parameter) parameter.continuous = true;
  }
}

// Every parameter a MOD could drive on these channels: Continuous ones first, the rest flagged
// "will be marked Continuous". Volume appears when every channel has a calibrated mapping.
export function modParameterChoices(device, channelIds, current = null) {
  const channels = device.channels.filter(channel => channelIds.includes(channel.id));
  const choices = [];
  // The calibrated "Volume output" is the old way to duck. It is offered only when the device has no
  // Level/Volume parameter of its own, or when a route already uses it.
  if (channels.length && channels.every(channel => channel.volume) && (current === 'volume' || !levelParameter(device, channelIds))) choices.push({ key: 'volume', label: 'Volume (ducking curve)', smooth: true });
  const keys = channels[0] ? Object.keys(channels[0].parameters).filter(key => channels.every(channel => channel.parameters[key])) : [];
  for (const key of keys) choices.push({ key, label: channels[0].parameters[key].label || key, smooth: channels.every(channel => channel.parameters[key].continuous) });
  return [...choices.filter(item => item.smooth), ...choices.filter(item => !item.smooth)];
}

function addAction(draft, action) {
  draft.performance.actions.push({ shift: 'any', when: 'instant', ...action });
  return { select: `action:${draft.performance.actions.length - 1}` };
}

// Connect an output port to an input port. Mutates draft; returns a hint.
// The controller CC behind a global input or a strip control's knob.
function knobAddress(draft, kind, port) {
  if (kind === 'input') {
    const parsed = parseInputKey(port);
    if (parsed.type !== 'cc' || parsed.number === null) fail('A knob or slider (a specific CC) can be used here. Choose its CC number first.');
    return { channel: parsed.channel, number: parsed.number };
  }
  const [, bankId, index, layer] = port.split(':');
  const source = findBank(draft, bankId).controls[Number(index)]?.[layer]?.source;
  if (!source) fail('That control has no input address yet. Give it a channel and CC first.');
  return { channel: source.channel, number: source.cc };
}

export function connect(draft, from, to) {
  const [fromNode, fromPort] = from, [toNode, toPort] = to;
  const a = portKind(fromNode, fromPort), b = portKind(toNode, toPort);
  const controllerId = fromNode.slice(4);
  if ((a === 'bank' || a === 'control') && b === 'channel') {
    const bankId = fromPort.split(':')[1];
    const bank = findBank(draft, bankId);
    const deviceId = toNode.slice(4), cid = Number(toPort.slice(3));
    const device = findDevice(draft, deviceId);
    if (bank.destination === deviceId) {
      if (bank.channels.includes(cid)) fail(`${bank.name} already drives that channel.`);
      bank.channels.push(cid); bank.channels.sort((x, y) => x - y);
      alignIfNeeded(draft, bank);
      if (bank.depth_overrides && Object.keys(bank.depth_overrides).length) bank.depth_overrides[String(cid)] = bank.depth;
      return { select: `strip:${bank.id}:${cid}` };
    }
    if (a === 'control') {
      const [, , index, layer] = fromPort.split(':');
      const binding = bank.controls[Number(index)][layer];
      const channel = device.channels.find(item => item.id === cid);
      const parameter = binding.parameter && channel.parameters[binding.parameter] ? binding.parameter : Object.keys(channel.parameters)[0];
      binding.sends ||= [];
      binding.sends.push({ device: deviceId, set: cid, parameter, midi_channel: channel.parameters[parameter].channel });
      return { select: `send:${bank.id}:${index}:${layer}:${binding.sends.length - 1}` };
    }
    if (bank.channels.length) fail(`${bank.name} drives ${findDevice(draft, bank.destination).name}. A strip drives one device — switch to Per control view and drag a single control to send it elsewhere.`);
    const previousDevice = bank.destination === deviceId ? null : findDevice(draft, bank.destination);
    bank.destination = deviceId; bank.channels = [cid]; bank.depth_overrides = {};
    if (device.channel_mode === 'selectable' && !bank.midi_channels?.length) bank.midi_channels = [1];
    if (device.channel_mode !== 'selectable') delete bank.midi_channels;
    // Another device: keep each parameter by label where the key differs; the same device keeps its keys.
    if (previousDevice) {
      const channel = device.channels.find(item => item.id === cid);
      for (const control of bank.controls) for (const binding of Object.values(control)) if (binding.parameter) binding.parameter = matchParameter(previousDevice, channel, binding.parameter);
    }
    pruneFeedbackFrom(bank);
    return { select: `strip:${bank.id}:${cid}` };
  }
  if (a === 'modout' && b === 'channel') {
    const index = Number(fromNode.slice(4));
    const deviceId = toNode.slice(4), cid = Number(toPort.slice(3));
    const device = findDevice(draft, deviceId);
    let mod = draft.performance.mods[index];
    const existing = mod.destinations.filter(item => item.device === deviceId && item.channels.map(channelKey).includes(cid)).map(item => item.parameter);
    const parameter = firstModParameter(device, cid, mod, existing);
    if (device.channel_mode === 'selectable') fail('Selectable-channel devices: assign MOD destinations through a strip (drag the MOD to a strip channel already in use).');
    mod.destinations.push({ device: deviceId, parameter, channels: [cid], banks: [], amount: parameter === 'volume' ? 1 : mod.shape === 'envelope' && parameter === levelParameter(device, [cid]) ? -1 : 0.5, scale_by_bank: false });
    return { select: `mod:${index}:${mod.destinations.length - 1}:c${cid}` };
  }
  if (a === 'modout' && b === 'modin') {
    const source = Number(fromNode.slice(4)), target = Number(toNode.slice(4));
    if (!MODULATABLE.includes(toPort)) fail('A MOD can modulate another MOD’s rate, amount, phase/slew or release.');
    if (source === target) fail('A MOD cannot modulate itself.');
    const mods = draft.performance.mods;
    if (mods[source].mod_targets.some(item => item.mod === target && item.parameter === toPort)) fail('Those MODs are already connected.');
    if (wouldCycle(mods, source, target)) fail('That would make a MOD loop. MOD-to-MOD connections must flow one way.');
    mods[source].mod_targets.push({ mod: target, parameter: toPort, amount: 0.5 });
    return { select: `modmod:${source}:${mods[source].mod_targets.length - 1}` };
  }
  if (a === 'input' && b === 'modin') {
    const input = parseInputKey(fromPort), mod = Number(toNode.slice(4));
    const base = { controller: controllerId, type: input.type, channel: input.channel, number: input.number };
    if (toPort === 'trigger') {
      if (input.type === 'note') { draft.performance.mods[mod].trigger = base; return { select: `trigger:${mod}` }; }
      return addAction(draft, { ...base, action: 'mod_trigger', mod });
    }
    if (input.number === null) fail('Choose a specific CC or note number for this input first.');
    if (toPort === 'enable') return addAction(draft, { ...base, action: 'mod_enable', mod });
    if (CONTINUOUS_ACTIONS[toPort]) {
      if (input.type !== 'cc') fail('Continuous MOD controls need a CC input (a knob or fader).');
      return addAction(draft, { ...base, action: CONTINUOUS_ACTIONS[toPort], mod });
    }
    fail('Sync comes from the Clock node.');
  }
  if (a === 'opout' && b === 'reset') {
    const source = Number(fromNode.slice(3)), bank = findBank(draft, toPort.slice(6)), list = Ops.operators(draft)[source] || fail('That operator no longer exists.');
    if (!bank.channels.length) fail(`${bank.name} has no channels yet.`);
    const device = findDevice(draft, bank.destination);
    if (list.targets.some(item => (item.banks || []).includes(bank.id))) fail(`${list.name} already drives ${bank.name}.`);
    const envelope = list.inputs.some(input => input.type === 'mod' && draft.performance.mods[input.index]?.shape === 'envelope');
    const used = list.targets.filter(item => item.device === device.id && (item.banks || []).some(id => id === bank.id)).map(item => item.parameter);
    // The parameter must exist on every channel the strip drives; volume for an envelope, else a shared smooth parameter.
    const level = envelope ? levelParameter(device, bank.channels) : null;
    const shared = bank.channels.every(cid => device.channels.find(channel => channel.id === cid)?.volume);
    let parameter = level || (envelope && shared ? 'volume' : null);
    if (level) allowModulation(device, bank.channels, level);
    if (!parameter) {
      const first = device.channels.find(channel => channel.id === bank.channels[0]);
      parameter = Object.keys(first.parameters).find(key => !used.includes(key) && bank.channels.every(cid => device.channels.find(channel => channel.id === cid)?.parameters[key])) || fail(`${bank.name}’s channels have no parameter in common. Use “Match parameters across channels” on the strip first.`);
      allowModulation(device, bank.channels, parameter);
    }
    list.targets.push({ device: device.id, parameter, channels: [], banks: [bank.id], amount: parameter === 'volume' ? 1 : level ? -1 : 0.5, scale_by_bank: false });
    return { select: `optarget:${source}:${list.targets.length - 1}:b${bank.id}` };
  }
  if (b === 'opin' || b === 'opparam' || (a === 'opout' && b === 'channel')) {
    const op = Number(toNode.slice(3));
    if (a === 'opout' && b === 'channel') {
      const source = Number(fromNode.slice(3)), deviceId = toNode.slice(4), cid = Number(toPort.slice(3)), device = findDevice(draft, deviceId);
      if (device.channel_mode === 'selectable') fail('Selectable-channel devices: assign operator destinations through a strip channel instead.');
      const list = Ops.operators(draft)[source] || fail('That operator no longer exists.');
      const used = list.targets.filter(item => item.device === deviceId && item.channels.includes(cid)).map(item => item.parameter);
      // An operator fed by an envelope MOD (a sidechain) ducks volume by default, like the MOD would.
      const envelope = list.inputs.some(input => input.type === 'mod' && draft.performance.mods[input.index]?.shape === 'envelope');
      const parameter = firstModParameter(device, cid, { shape: envelope ? 'envelope' : 'sine' }, used);
      list.targets.push({ device: deviceId, parameter, channels: [cid], banks: [], amount: parameter === 'volume' ? 1 : envelope && parameter === levelParameter(device, [cid]) ? -1 : 0.5, scale_by_bank: false });
      return { select: `optarget:${source}:${list.targets.length - 1}:${cid}` };
    }
    if (b === 'opin') {
      let input;
      if (a === 'modout') input = { type: 'mod', index: Number(fromNode.slice(4)) };
      else if (a === 'opout') input = { type: 'op', index: Number(fromNode.slice(3)) };
      else if (a === 'input' || a === 'control') {
        const parsed = knobAddress(draft, a, fromPort);
        input = { type: 'cc', controller: controllerId, channel: parsed.channel, number: parsed.number };
      } else if (a === 'bank') fail('A strip has many knobs. Switch to Per control view and drag from the one knob you want.');
      else fail('Those ports don’t connect.');
      const at = Ops.addInput(draft, op, input);
      return { select: `opin:${op}:${at}` };
    }
    if (a === 'bank') fail('A strip has many knobs. Switch to Per control view and drag from the one knob you want.');
    if (a !== 'input' && a !== 'control') fail('Only a knob or slider can set an operator setting.');
    const parsed = knobAddress(draft, a, fromPort), name = toPort.slice(6);
    Ops.operators(draft)[op].links[name] = { controller: controllerId, channel: parsed.channel, number: parsed.number };
    return { select: `oplink:${op}:${name}` };
  }
  if (a === 'input' && b === 'snapin') {
    const input = parseInputKey(fromPort), slot = Number(toNode.slice(5));
    if (input.number === null) fail('Choose a specific CC or note number for this input first.');
    return addAction(draft, { controller: controllerId, type: input.type, channel: input.channel, number: input.number, action: toPort === 'recall' ? 'recall' : 'capture', slot });
  }
  if (a === 'snapout' && (b === 'reset' || b === 'channel' || b === 'devsnap')) {
    const slot = Number(fromNode.slice(5));
    const target = b === 'reset' ? { type: 'bank', bank: toPort.slice(6) } : b === 'channel' ? { type: 'channel', device: toNode.slice(4), channel: Number(toPort.slice(3)) } : { type: 'device', device: toNode.slice(4) };
    Snap.addTarget(draft, slot, target);
    return { select: `snapscope:${slot}:${draft.performance.slots[slot].targets.length - 1}` };
  }
  if (a === 'input' && b === 'resetlayer') {
    const input = parseInputKey(fromPort), layerController = toNode.slice(4), layer = toPort.slice(11);
    if (input.number === null) fail('Choose a specific CC or note number for this input first.');
    if (!controllerLayerKeys(findDevice(draft, layerController)).includes(layer)) fail('That layer no longer exists.');
    return addAction(draft, { controller: controllerId, type: input.type, channel: input.channel, number: input.number, action: 'reset', layer, layer_controller: layerController });
  }
  if (a === 'input' && b === 'reset') {
    const input = parseInputKey(fromPort);
    if (input.number === null) fail('Choose a specific CC or note number for this input first.');
    return addAction(draft, { controller: controllerId, type: input.type, channel: input.channel, number: input.number, action: 'reset', bank: toPort.slice(6) });
  }
  if (a === 'modout' && b === 'keyparam') {
    const mod = draft.performance.mods[Number(fromNode.slice(4))] || fail('That MOD no longer exists.');
    const [, routeId, parameter] = toPort.split(':');
    if (!(draft.routing.notes || []).some(route => route.id === routeId)) fail('That keyboard route no longer exists.');
    if (!NOTE_PARAMS[parameter]) fail('Unknown keyboard setting.');
    mod.note_targets ||= [];
    if (mod.note_targets.some(item => item.route === routeId && item.parameter === parameter)) fail('That MOD already drives this setting.');
    if (parameter === 'root' && !draft.routing.notes.find(route => route.id === routeId).scale) fail('Pick a scale for this route first: the scale key has nothing to move without one.');
    mod.note_targets.push({ route: routeId, parameter, amount: 1 });
    return { select: `notemod:${fromNode.slice(4)}:${mod.note_targets.length - 1}` };
  }
  if ((a === 'control' || a === 'bank') && b === 'keyparam') {
    if (a === 'bank') fail('A strip drives many controls. Switch to Per control view and drag from a single knob to a keyboard setting.');
    const [, bankId, index, layer] = fromPort.split(':'), [, routeId, parameter] = toPort.split(':');
    const binding = findBank(draft, bankId).controls[Number(index)][layer];
    const route = (draft.routing.notes || []).find(item => item.id === routeId) || fail('That keyboard route no longer exists.');
    if (parameter === 'root' && !route.scale) fail('Pick a scale for this route first: the scale key has nothing to move without one.');
    binding.note_links ||= [];
    if (binding.note_links.some(item => item.route === routeId && item.parameter === parameter)) fail('That knob already moves this setting.');
    binding.note_links.push({ route: routeId, parameter });
    return { select: `notectl:${bankId}:${index}:${layer}:${binding.note_links.length - 1}` };
  }
  if (a === 'input' && b === 'keyparam') {
    const input = parseInputKey(fromPort), [, routeId, parameter] = toPort.split(':');
    if (input.type !== 'cc') fail('A knob or slider (CC input) can control a keyboard setting; notes and buttons cannot.');
    if (input.number === null) fail('Choose a specific CC number for this input first.');
    if (!(draft.routing.notes || []).some(route => route.id === routeId)) fail('That keyboard route no longer exists.');
    if (parameter === 'root' && !draft.routing.notes.find(route => route.id === routeId).scale) fail('Pick a scale for this route first: the scale key has nothing to move without one.');
    return addAction(draft, { controller: controllerId, type: 'cc', channel: input.channel, number: input.number, action: `note_${parameter}`, route: routeId });
  }
  if (a === 'input' && b === 'devnotes') {
    const input = parseInputKey(fromPort), device = findDevice(draft, toNode.slice(4)), controller = findDevice(draft, controllerId);
    if (input.type !== 'note') fail('Only a note input can play a device. Add a note input (“Any note”) to the controller.');
    if (input.number !== null) fail('Route “any note” from the controller to play a device with a keyboard. A single note is a button.');
    if (!controller.input) fail(`Set ${controller.name}’s input port first.`);
    if (!device.output) fail(`Set ${device.name}’s output port first.`);
    const route = { id: uniqueId((draft.routing.notes || []).map(item => item.id), 'n'), controller: controllerId, source: controller.input, channel: input.channel, low: 0, high: 127, port: device.output, out_channel: 1, transpose: 0, scale: null, fixed_velocity: null, passthrough: true };
    draft.routing.notes ||= [];
    if (draft.routing.notes.some(item => item.controller === controllerId && item.channel === route.channel && item.port === route.port && item.low === 0 && item.high === 127 && item.out_channel === 1)) fail('That keyboard already plays this device on channel 1. Change its channel or key range first, or split the keyboard.');
    draft.routing.notes.push(route);
    return { select: `notes:${draft.routing.notes.length - 1}` };
  }
  if (a === 'clockout' && b === 'devclock') {
    const device = findDevice(draft, toNode.slice(4));
    if (!device.output) fail(`Set ${device.name}’s output port first.`);
    const clock = draft.routing.clock;
    if (!clock.source) fail('Choose a clock source on the Clock node first.');
    if (clock.destinations.includes(device.output)) fail('That device already receives clock.');
    clock.destinations.push(device.output);
    return { select: `clock:${device.output}` };
  }
  if (a === 'clockout' && b === 'modin') {
    if (toPort !== 'sync') fail('Clock connects to a MOD’s sync input.');
    const mod = draft.performance.mods[Number(toNode.slice(4))];
    if (mod.shape === 'envelope') fail('Envelopes follow their gate; sync their times from the MOD panel instead.');
    mod.timing = 'sync';
    return { select: `sync:${toNode.slice(4)}` };
  }
  if ((a === 'bank' || a === 'control') && (b === 'modin' || b === 'reset')) fail('Mapped knobs already drive a strip parameter. Use a free controller input (+ input) for MOD controls and resets.');
  fail('Those ports don’t connect.');
}

// Remove a wire. Mutates draft.
export function disconnect(draft, wire) {
  const mods = draft.performance.mods;
  switch (wire.kind) {
    case 'strip': {
      const bank = findBank(draft, wire.bank);
      if (wire.index !== undefined) { bank.controls[wire.index][wire.layer].parameter = null; return; }
      bank.channels = bank.channels.filter(cid => cid !== wire.cid);
      if (bank.depth_overrides) delete bank.depth_overrides[String(wire.cid)];
      pruneFeedbackFrom(bank);
      return;
    }
    case 'send': findBank(draft, wire.bank).controls[wire.index][wire.layer].sends.splice(wire.send, 1); return;
    case 'mod': {
      if (wire.legacy) {
        // Editing a legacy route converts that MOD to the unified destination list.
        const legacyBank = wire.bank;
        mods[wire.mod] = migrateMod(mods[wire.mod], draft.setup);
        const mod = mods[wire.mod];
        const index = mod.destinations.findIndex(item => wire.legacy === 'bank' ? item.banks.includes(legacyBank) : item.channels.map(channelKey).includes(wire.cid));
        if (index >= 0) disconnect(draft, { ...wire, legacy: null, dest: index });
        return;
      }
      const mod = mods[wire.mod], destination = mod.destinations[wire.dest];
      if (wire.bank) destination.banks = destination.banks.filter(bid => bid !== wire.bank);
      else destination.channels = destination.channels.filter(cid => channelKey(cid) !== wire.cid);
      if (!destination.banks.length) destination.scale_by_bank = false;
      if (!destination.banks.length && !destination.channels.length) mod.destinations.splice(wire.dest, 1);
      return;
    }
    case 'modmod': mods[wire.mod].mod_targets.splice(wire.target, 1); return;
    case 'snapshot': draft.performance.slots[wire.slot].targets.splice(wire.target, 1); return;
    case 'op': Ops.removeWire(draft, wire); return;
    case 'modamount': {
      const bank = findBank(draft, wire.bank);
      for (const [index, control] of bank.controls.entries()) for (const [layer, binding] of Object.entries(control)) {
        if (BANK_MOD_PARAMETERS.indexOf(binding.parameter) === wire.slot && (wire.index === undefined || (wire.index === index && wire.layer === layer))) binding.parameter = null;
      }
      return;
    }
    case 'trigger': mods[wire.mod].trigger = null; return;
    case 'action':
      if (wire.reset !== undefined) draft.setup.resets.splice(wire.reset, 1);
      else draft.performance.actions.splice(wire.action, 1);
      return;
    case 'clock':
      if (wire.mod !== undefined) { mods[wire.mod].timing = 'free'; return; }
      draft.routing.clock.destinations = draft.routing.clock.destinations.filter(port => port !== wire.port);
      return;
    case 'thru': draft.routing.cc.splice(wire.route, 1); return;
    case 'notes': draft.routing.notes.splice(wire.route, 1); pruneNoteRefs(draft); return;
    case 'notemod': mods[wire.mod].note_targets.splice(wire.target, 1); return;
    case 'notectl': {
      const binding = findBank(draft, wire.bank).controls[wire.index][wire.layer];
      binding.note_links.splice(wire.link, 1); if (!binding.note_links.length) delete binding.note_links;
      return;
    }
    default: fail('Unknown wire.');
  }
}

// Make a legacy MOD route editable as a normal destination; returns its index.
export function editableDestination(draft, wire) {
  if (!wire.legacy) return wire.dest;
  const mods = draft.performance.mods;
  mods[wire.mod] = migrateMod(mods[wire.mod], draft.setup);
  return mods[wire.mod].destinations.findIndex(item => wire.legacy === 'bank' ? item.banks.includes(wire.bank) : item.channels.map(channelKey).includes(wire.cid));
}

export function addMod(draft) {
  const mods = draft.performance.mods;
  if (mods.length >= MAX_MODS) fail(`Up to ${MAX_MODS} MODs.`);
  const used = new Set(mods.map(mod => mod.name));
  let number = mods.length + 1;
  while (used.has(`MOD ${number}`)) number++;
  mods.push({ ...defaultMod(mods.length), name: `MOD ${number}` });
  return mods.length - 1;
}

export function removeMod(draft, index) {
  const mods = draft.performance.mods;
  if (index === 0) fail('MOD 1 carries the strips’ sidechain amounts. Disable it instead of deleting it.');
  if (!mods[index]) fail('Unknown MOD.');
  mods.splice(index, 1);
  Ops.modRemoved(draft, index);
  const shift = value => value > index ? value - 1 : value;
  draft.performance.actions = draft.performance.actions.filter(action => !(action.action?.startsWith('mod_') && action.action !== 'mod_stop' && action.mod === index))
    .map(action => action.action?.startsWith('mod_') && action.mod !== undefined ? { ...action, mod: shift(action.mod) } : action);
  for (const mod of mods) mod.mod_targets = mod.mod_targets.filter(target => target.mod !== index).map(target => ({ ...target, mod: shift(target.mod) }));
  for (const bank of draft.setup.banks) {
    if (Array.isArray(bank.mod_depths) && bank.mod_depths.length > index) {
      bank.mod_depths.splice(index, 1);
      while (bank.mod_depths.length < 3) bank.mod_depths.push(0);
    }
    for (const control of bank.controls) for (const binding of Object.values(control)) {
      const slot = BANK_MOD_PARAMETERS.indexOf(binding.parameter);
      if (slot === index) binding.parameter = null;
      else if (slot > index) binding.parameter = BANK_MOD_PARAMETERS[slot - 1];
    }
  }
}

export function declareInput(layout, controllerId, binding) {
  const list = layout.inputs[controllerId] ||= [];
  const key = inputKey(binding);
  if (list.some(item => inputKey(item) === key)) fail('That input is already on the controller.');
  list.push({ type: binding.type, channel: binding.channel, number: binding.number ?? null, ...(binding.label ? { label: binding.label } : {}) });
  return key;
}

export function forgetInput(draft, layout, controllerId, key) {
  layout.inputs[controllerId] = (layout.inputs[controllerId] || []).filter(item => inputKey(item) !== key);
  draft.performance.actions = draft.performance.actions.filter(action => !(action.controller === controllerId && inputKey(action) === key));
  draft.setup.resets = draft.setup.resets.filter(reset => !(reset.controller === controllerId && inputKey({ type: 'cc', channel: reset.channel, number: reset.cc }) === key));
  if (draft.performance.shift?.controller === controllerId && inputKey(draft.performance.shift) === key) {
    draft.performance.shift = null;
    for (const action of draft.performance.actions) if (action.shift !== 'any') action.shift = 'any';
  }
  const controller = findDevice(draft, controllerId);
  if (controller.layer_switch && inputKey(controller.layer_switch) === key) { delete controller.layer_switch; controller.layer_mode = 'hardware'; }
  if (layout.controls) delete layout.controls[globalStyleKey(controllerId, key)];
  for (const mod of draft.performance.mods) if (mod.trigger?.controller === controllerId && inputKey(mod.trigger) === key) mod.trigger = null;
  const matches = binding => binding.controller === controllerId && inputKey({ type: 'cc', channel: binding.channel, number: binding.number }) === key;
  for (const operator of draft.performance.operators || []) {
    operator.inputs = operator.inputs.filter(binding => binding.type !== 'cc' || !matches(binding));
    for (const [name, binding] of Object.entries(operator.links)) if (matches(binding)) delete operator.links[name];
  }
}

// Change a global input's MIDI address (type, channel, number) in place. Every role, wire,
// trigger, reset and appearance that used the old address follows it; nothing is deleted.
export function moveInput(draft, layout, controllerId, oldKey, next) {
  const old = parseInputKey(oldKey);
  const type = next.type === 'note' ? 'note' : 'cc';
  const channel = Number(next.channel), number = next.number === null || next.number === undefined || next.number === '' ? null : Number(next.number);
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) fail('MIDI channel must be 1–16.');
  if (number !== null && (!Number.isInteger(number) || number < 0 || number > (type === 'cc' ? 119 : 127))) fail(type === 'cc' ? 'CC must be 0–119.' : 'Note must be 0–127.');
  if (type === 'cc' && number === null) fail('A CC input needs a CC number.');
  const newKey = inputKey({ type, channel, number });
  if (newKey === oldKey) return newKey;
  const controller = findDevice(draft, controllerId);
  const operatorBindings = (draft.performance.operators || []).flatMap(operator => [...operator.inputs.filter(binding => binding.type === 'cc'), ...Object.values(operator.links)])
    .filter(binding => binding.controller === controllerId && inputKey({ type: 'cc', channel: binding.channel, number: binding.number }) === oldKey);
  if (type !== 'cc' && operatorBindings.length) fail('An operator input must stay a CC. Remove its operator wires before changing the type.');
  if (type !== old.type && (draft.setup.resets.some(reset => reset.controller === controllerId && inputKey({ type: 'cc', channel: reset.channel, number: reset.cc }) === oldKey)))
    fail('A reset button must stay a CC. Remove its reset role before changing the type.');
  if (controllerInputs(draft, layout, controllerId).some(entry => entry.key === newKey)) fail(`${inputLabel({ type, channel, number })} is already an input on ${controller.name}.`);
  if (number !== null) {
    const clash = usedInputs(draft, controllerId).get(`${type}:${channel}:${number}`);
    if (clash) fail(`${inputLabel({ type, channel, number })} is already used by ${clash}.`);
  }
  const retarget = binding => { binding.type = type; binding.channel = channel; binding.number = number; };
  const same = binding => binding && binding.controller !== undefined ? binding.controller === controllerId && inputKey({ type: binding.type || 'cc', channel: binding.channel, number: binding.number }) === oldKey : false;
  for (const binding of operatorBindings) { binding.channel = channel; binding.number = number; }
  for (const item of layout.inputs[controllerId] || []) if (inputKey(item) === oldKey) retarget(item);
  for (const action of draft.performance.actions) if (same(action)) retarget(action);
  for (const reset of draft.setup.resets) if (reset.controller === controllerId && inputKey({ type: 'cc', channel: reset.channel, number: reset.cc }) === oldKey) { reset.channel = channel; reset.cc = number; }
  if (same(draft.performance.shift)) retarget(draft.performance.shift);
  for (const mod of draft.performance.mods) if (same(mod.trigger)) retarget(mod.trigger);
  if (controller.layer_switch && inputKey(controller.layer_switch) === oldKey) retarget(controller.layer_switch);
  if (old.type === 'note' && old.number === null) for (const route of draft.routing.notes || []) if (route.controller === controllerId && route.channel === old.channel) route.channel = channel;
  if (layout.controls?.[globalStyleKey(controllerId, oldKey)]) { layout.controls[globalStyleKey(controllerId, newKey)] = layout.controls[globalStyleKey(controllerId, oldKey)]; delete layout.controls[globalStyleKey(controllerId, oldKey)]; }
  return newKey;
}

// Port roles: what a button does on its own (no target node).
export function addRole(draft, controllerId, key, role) {
  const input = parseInputKey(key);
  if (input.number === null) fail('Choose a specific CC or note number for this input first.');
  const base = { controller: controllerId, type: input.type, channel: input.channel, number: input.number };
  if (role === 'shift-momentary' || role === 'shift-toggle') {
    draft.performance.shift = { ...base, mode: role.slice(6) };
    return;
  }
  const [name, slot] = role.split(':');
  if (name === 'recall' || name === 'capture') return void draft.performance.actions.push({ ...base, action: name, slot: Number(slot), shift: 'any', when: 'instant' });
  if (!ROLE_ACTIONS[role]) fail('Unknown button role.');
  draft.performance.actions.push({ ...base, shift: 'any', when: 'instant', ...clone(ROLE_ACTIONS[role]) });
}

// ---------------------------------------------------------------- structure
// Controllers, devices, strips, input layers and MIDI Thru routes. These edit
// the same setup/routing the engine validates; Apply still runs full checks.

export const MAX_LAYERS = 8;
export const DEVICE_SYNC = { off: 'Ignore device changes', track: 'Update MIDIBRAIN', link: 'Update and copy to the other channels' };
const LAYER_KEY = /^[a-zA-Z0-9_-]{1,32}$/;
const slug = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'device';
const blankBinding = () => ({ source: null, feedback: null, parameter: null });

// A control's feedback may follow one strip channel; drop it when that channel leaves.
export function pruneFeedbackFrom(bank) {
  for (const control of bank.controls) for (const binding of Object.values(control)) {
    if (binding.feedback_from != null && !bank.channels.includes(binding.feedback_from)) delete binding.feedback_from;
  }
}

export function controllerLayerKeys(device) {
  return Array.isArray(device?.layers) ? [...device.layers] : device?.alternate ? ['normal', 'alternate'] : ['normal'];
}

export function uniqueId(existing, base) {
  const used = new Set(existing);
  let id = slug(base), n = 2;
  while (used.has(id)) id = `${slug(base)}-${n++}`;
  return id;
}

function controllerBanks(draft, controllerId) { return draft.setup.banks.filter(bank => bank.controller === controllerId); }
function setLayers(device, keys) { device.layers = keys; delete device.alternate; }

// Every input address (port-scoped) a controller already listens to.
export function usedInputs(draft, controllerId, except = null) {
  const used = new Map();
  const mark = (type, channel, number, what) => used.set(`${type}:${channel}:${number}`, what);
  for (const bank of controllerBanks(draft, controllerId)) bank.controls.forEach((control, index) => Object.entries(control).forEach(([layer, binding]) => {
    if (except && findDevice(draft, controllerId).layer_mode === 'software' && layer !== except.layer) return;
    if (binding.source && !(except && except.bank === bank.id && except.index === index && except.layer === layer)) mark('cc', binding.source.channel, binding.source.cc, `${bank.name} · ${bindingLabel(bank, index, layer, binding)}`);
  }));
  for (const reset of draft.setup.resets) if (reset.controller === controllerId) mark('cc', reset.channel, reset.cc, 'a reset button');
  for (const action of draft.performance.actions) if (action.controller === controllerId) mark(action.type || 'cc', action.channel, action.number, 'a button action');
  for (const route of draft.routing.cc) if (route.controller === controllerId && !(except && findDevice(draft, controllerId).layer_mode === 'software' && route.layer !== except.layer)) mark('cc', route.channel, route.cc, `direct layer ${route.layer}`);
  const shift = draft.performance.shift;
  if (shift?.controller === controllerId) mark(shift.type || 'cc', shift.channel, shift.number, 'Shift');
  const controller = findDevice(draft, controllerId);
  if (controller.layer_mode === 'software' && controller.layer_switch) { const entry = controller.layer_switch; mark(entry.type, entry.channel, entry.number, 'the layer switch'); }
  return used;
}

export function addLayer(draft, controllerId, { key, copyFrom = null, channel = null, type = 'banked' } = {}) {
  const device = findDevice(draft, controllerId);
  const keys = controllerLayerKeys(device);
  if (keys.length >= MAX_LAYERS) fail(`Controllers support up to ${MAX_LAYERS} input layers.`);
  let name = key?.trim();
  if (!name) { let n = keys.length + 1; name = n === 2 && !keys.includes('alternate') ? 'alternate' : `layer${n}`; while (keys.includes(name)) name = `layer${++n}`; }
  if (!LAYER_KEY.test(name)) fail('Layer names use letters, numbers, - or _ (up to 32).');
  if (keys.includes(name)) fail('That layer already exists.');
  if (!['banked', 'direct'].includes(type)) fail('Choose banked or direct routing.');
  if (type === 'direct') {
    setLayers(device, [...keys, name]); device.layer_types ||= {}; device.layer_types[name] = 'direct';
    return name;
  }
  if (copyFrom && !keys.includes(copyFrom)) fail('Unknown layer to copy from.');
  const software = device.layer_mode === 'software';
  if (copyFrom && !software && !(Number.isInteger(channel) && channel >= 1 && channel <= 16)) fail('Choose the MIDI channel the new layer sends on.');
  // Build every binding first so a clash leaves the draft untouched.
  const used = usedInputs(draft, controllerId), planned = [];
  for (const bank of controllerBanks(draft, controllerId)) for (const control of bank.controls) {
    const from = copyFrom ? control[copyFrom] : null;
    const binding = blankBinding();
    if (from?.source) {
      binding.source = { channel: software ? from.source.channel : channel, cc: from.source.cc };
      if (!software && used.has(`cc:${channel}:${from.source.cc}`)) fail(`MIDI ch ${channel} CC ${from.source.cc} is already used by ${used.get(`cc:${channel}:${from.source.cc}`)}. Pick another channel.`);
      used.set(`cc:${channel}:${from.source.cc}`, name);
      if (from.feedback) binding.feedback = { channel: software ? from.feedback.channel : channel, cc: from.feedback.cc };
    }
    planned.push([control, binding]);
  }
  for (const [control, binding] of planned) control[name] = binding;
  setLayers(device, [...keys, name]);
  return name;
}

export function removeLayer(draft, controllerId, key) {
  const device = findDevice(draft, controllerId);
  const keys = controllerLayerKeys(device);
  if (!keys.includes(key)) fail('Unknown layer.');
  if (keys.length === 1) fail('A controller needs at least one input layer.');
  if (bankLayerKeys(device).includes(key) && bankLayerKeys(device).length === 1 && controllerBanks(draft, controllerId).length) fail('Remove this controller’s strips before removing its last banked layer.');
  for (const bank of controllerBanks(draft, controllerId)) for (const control of bank.controls) delete control[key];
  setLayers(device, keys.filter(item => item !== key));
  if (device.layer_types) delete device.layer_types[key];
  draft.routing.cc = draft.routing.cc.filter(route => route.controller !== controllerId || route.layer !== key);
  if (device.initial_layer === key) device.initial_layer = device.layers[0];
}

export function renameLayer(draft, controllerId, from, to) {
  const device = findDevice(draft, controllerId);
  const keys = controllerLayerKeys(device), name = String(to || '').trim();
  if (!keys.includes(from)) fail('Unknown layer.');
  if (name === from) return from;
  if (!LAYER_KEY.test(name)) fail('Layer names use letters, numbers, - or _ (up to 32).');
  if (keys.includes(name)) fail('That layer already exists.');
  for (const bank of controllerBanks(draft, controllerId)) bank.controls = bank.controls.map(control => Object.fromEntries(Object.entries(control).map(([layer, binding]) => [layer === from ? name : layer, binding])));
  setLayers(device, keys.map(item => item === from ? name : item));
  if (device.layer_types?.[from]) { device.layer_types[name] = device.layer_types[from]; delete device.layer_types[from]; }
  for (const route of draft.routing.cc) if (route.controller === controllerId && route.layer === from) { route.layer = name; if (route.page) route.page = name; }
  if (device.initial_layer === from) device.initial_layer = name;
  return name;
}

// Layer usage summary: how many controls have an input address / a mapping.
export function layerUsage(draft, controllerId, key) {
  const direct = draft.routing.cc.filter(route => route.controller === controllerId && route.layer === key);
  if (direct.length) return { inputs: direct.length, mapped: direct.length, total: direct.length };
  let inputs = 0, mapped = 0, total = 0;
  for (const bank of controllerBanks(draft, controllerId)) for (const control of bank.controls) {
    const binding = control[key]; if (!binding) continue;
    total++; if (binding.source) inputs++; if (binding.parameter || binding.sends?.length) mapped++;
  }
  return { inputs, mapped, total };
}

export function setControlsPerStrip(draft, controllerId, count) {
  const device = findDevice(draft, controllerId);
  if (!Number.isInteger(count) || count < 1 || count > 64) fail('Controls per strip must be 1–64.');
  const keys = bankLayerKeys(device);
  for (const bank of controllerBanks(draft, controllerId)) {
    while (bank.controls.length < count) bank.controls.push(Object.fromEntries(keys.map(key => [key, blankBinding()])));
    bank.controls.length = count;
  }
  device.controls_per_bank = count;
}

export function addController(draft, { name = 'New controller', input = null, feedback_output = null, controls = 4, layers = 1 } = {}) {
  if (draft.setup.devices.length >= 32) fail('Up to 32 devices.');
  if (!Number.isInteger(controls) || controls < 1 || controls > 64) fail('Controls per strip must be 1–64.');
  if (!Number.isInteger(layers) || layers < 1 || layers > MAX_LAYERS) fail(`Input layers must be 1–${MAX_LAYERS}.`);
  const id = uniqueId(draft.setup.devices.map(device => device.id), name);
  const keys = ['normal']; while (keys.length < layers) keys.push(keys.length === 1 ? 'alternate' : `layer${keys.length + 1}`);
  draft.setup.devices.push({ id, name: name.trim() || 'New controller', kind: 'controller', input: input || null, feedback_output: feedback_output || null, controls_per_bank: controls, layers: keys });
  return id;
}

// A generic destination: one logical channel per MIDI channel, same CC block on each.
export function addDevice(draft, { name = 'New device', output = null, input = null, channels = 1, firstChannel = 1, ccStart = 1, ccCount = 8 } = {}) {
  if (draft.setup.devices.length >= 32) fail('Up to 32 devices.');
  if (!Number.isInteger(channels) || channels < 1 || channels > 16) fail('Channels must be 1–16.');
  if (!Number.isInteger(firstChannel) || firstChannel < 1 || firstChannel + channels - 1 > 16) fail('Those channels go past MIDI channel 16.');
  if (!Number.isInteger(ccStart) || !Number.isInteger(ccCount) || ccCount < 1 || ccStart < 0 || ccStart + ccCount - 1 > 119) fail('CCs must stay within 0–119.');
  const id = uniqueId(draft.setup.devices.map(device => device.id), name);
  const list = Array.from({ length: channels }, (_, i) => ({ id: i + 1, name: `Channel ${i + 1}`, volume: null,
    parameters: Object.fromEntries(Array.from({ length: ccCount }, (_, k) => [`cc${ccStart + k}`, { label: `CC ${ccStart + k}`, channel: firstChannel + i, cc: ccStart + k, min: 0, max: 127, reset: null, continuous: true }])) }));
  draft.setup.devices.push({ id, name: name.trim() || 'New device', kind: 'destination', output: output || null, input: input || null, initialize: false, channels: list });
  return id;
}

// A catalogue (or other prepared) definition; ids are re-issued to stay unique.
export function addDeviceDefinition(draft, definition, { output = null } = {}) {
  if (draft.setup.devices.length >= 32) fail('Up to 32 devices.');
  if (definition?.kind !== 'destination' || !Array.isArray(definition.channels)) fail('That is not a destination device definition.');
  const device = clone(definition);
  device.id = uniqueId(draft.setup.devices.map(item => item.id), device.name || 'device');
  device.output = output || device.output || null;
  draft.setup.devices.push(device);
  return device.id;
}

export function addStrip(draft, { controller, destination, channels = [], name = null, startCc = null, channel = 1 } = {}) {
  const control = findDevice(draft, controller), device = findDevice(draft, destination);
  if (control.kind !== 'controller') fail('Strips start on a controller.');
  if (device.kind !== 'destination') fail('Strips drive a destination device.');
  if (draft.setup.banks.length >= 32) fail('Up to 32 strips.');
  const ids = channels.length ? channels : [device.channels[0].id];
  for (const cid of ids) if (!device.channels.some(item => item.id === cid)) fail('Unknown destination channel.');
  const layers = bankLayerKeys(control), count = control.controls_per_bank;
  if (!layers.length) fail('Add a banked layer before adding a strip.');
  const used = usedInputs(draft, controller);
  const id = uniqueId(draft.setup.banks.map(bank => bank.id), 'strip');
  const strip = { id, name: name?.trim() || `Strip ${draft.setup.banks.filter(bank => bank.controller === controller).length + 1}`, controller, destination, channels: [...ids].sort((a, b) => a - b), depth: 0, depth_overrides: {},
    controls: Array.from({ length: count }, (_, i) => Object.fromEntries(layers.map((layer, l) => {
      const binding = blankBinding();
      if (startCc !== null && l === 0) {
        const cc = startCc + i;
        if (cc > 119) fail('Those inputs go past CC 119.');
        if (used.has(`cc:${channel}:${cc}`)) fail(`MIDI ch ${channel} CC ${cc} is already used by ${used.get(`cc:${channel}:${cc}`)}.`);
        binding.source = { channel, cc };
        if (control.feedback_output) binding.feedback = { channel, cc };
      }
      return [layer, binding];
    }))) };
  if (device.channel_mode === 'selectable') strip.midi_channels = [1];
  draft.setup.banks.push(strip);
  return id;
}

// Copy a finished strip with everything on it: controls, mappings, ranges, sends, labels,
// snapshot membership, per-channel MOD amounts and the MOD routes that reach it. The copy
// takes the next free *destination address*, whichever way the destination separates its
// channels: a fixed device (Zoom L6) has a different CC per logical channel on one MIDI
// channel, so the copy moves to the next free logical channels; a selectable-channel device
// (Digitone) keeps the same CCs on different MIDI channels, so the copy moves to the next free
// MIDI channels. Input CCs move to the next free ones on each control's MIDI channel.
// Anything that cannot be placed is left unassigned and counted in the result.
export function duplicateStrip(draft, layout, bankId) {
  const original = findBank(draft, bankId), controller = findDevice(draft, original.controller), device = findDevice(draft, original.destination);
  if (draft.setup.banks.length >= 32) fail('Up to 32 strips.');
  const copy = clone(original);
  const base = original.name.replace(/ copy( \d+)?$/, '');
  copy.id = uniqueId(draft.setup.banks.map(bank => bank.id), base + '-copy');
  const names = draft.setup.banks.map(bank => bank.name);
  let n = 1;
  while (names.includes(n === 1 ? `${base} copy` : `${base} copy ${n}`)) n++;
  copy.name = n === 1 ? `${base} copy` : `${base} copy ${n}`;
  const others = draft.setup.banks.filter(bank => bank.destination === device.id);
  let placed = 'same';
  const channelMap = new Map(original.channels.map(cid => [cid, cid]));
  if (device.channel_mode === 'selectable') {
    // Same CCs, next free MIDI channels (wrapping past 16).
    const taken = new Set(others.flatMap(bank => bank.midi_channels || []));
    const moved = [];
    for (const channel of original.midi_channels || []) {
      let next = null;
      for (let step = 1; step <= 16 && next === null; step++) {
        const candidate = ((channel - 1 + step) % 16) + 1;
        if (!taken.has(candidate) && !moved.includes(candidate)) next = candidate;
      }
      if (next === null) { moved.length = 0; break; }
      moved.push(next);
    }
    if (moved.length && moved.length === (original.midi_channels || []).length) { copy.midi_channels = moved.sort((a, b) => a - b); placed = 'midi-channel'; }
  } else {
    // Different logical channel (its own CCs) on the device, next unused ones.
    const taken = new Set(others.flatMap(bank => bank.channels));
    const ids = device.channels.map(channel => channel.id), moved = [];
    for (const cid of original.channels) {
      const next = [...ids.slice(ids.indexOf(cid) + 1), ...ids.slice(0, ids.indexOf(cid))].find(id => !taken.has(id) && !moved.includes(id));
      if (next === undefined) { moved.length = 0; break; }
      moved.push(next);
    }
    if (moved.length && moved.length === original.channels.length) {
      original.channels.forEach((cid, i) => channelMap.set(cid, moved[i]));
      copy.channels = [...moved].sort((a, b) => a - b); placed = 'logical-channel';
    }
  }
  // Per-channel MOD amounts and "show this channel's value" follow the channel they now belong to.
  copy.depth_overrides = Object.fromEntries(Object.entries(original.depth_overrides || {}).filter(([cid]) => channelMap.has(Number(cid))).map(([cid, value]) => [String(channelMap.get(Number(cid))), value]));
  // Keep the parameter on the new channel even if its key differs (match by label).
  const targetChannel = copy.channels.length ? device.channels.find(item => item.id === copy.channels[0]) : null;
  const used = usedInputs(draft, controller.id);
  const feedbackUsed = new Set();
  for (const bank of controllerBanks(draft, controller.id)) for (const control of bank.controls) for (const binding of Object.values(control)) if (binding.feedback) feedbackUsed.add(`${binding.feedback.channel}:${binding.feedback.cc}`);
  let unassigned = 0;
  const freeCc = (channel, from, taken) => { for (let cc = from + 1; cc <= 119; cc++) if (!taken(channel, cc)) return cc; return null; };
  copy.controls.forEach(control => Object.values(control).forEach(binding => {
    delete binding.note_links;
    if (binding.feedback_from !== undefined && channelMap.has(binding.feedback_from)) binding.feedback_from = channelMap.get(binding.feedback_from);
    if (targetChannel && binding.parameter && placed === 'logical-channel') binding.parameter = matchParameter(device, targetChannel, binding.parameter) ?? binding.parameter;
    const before = binding.source;
    if (before) {
      const cc = freeCc(before.channel, before.cc, (channel, number) => used.has(`cc:${channel}:${number}`));
      if (cc === null) { binding.source = null; unassigned++; } else { used.set(`cc:${before.channel}:${cc}`, copy.name); binding.source = { channel: before.channel, cc }; }
    }
    if (binding.feedback) {
      const mirrored = before && binding.feedback.channel === before.channel && binding.feedback.cc === before.cc;
      if (mirrored) binding.feedback = binding.source ? { ...binding.source } : null;
      else {
        const cc = freeCc(binding.feedback.channel, binding.feedback.cc, (channel, number) => feedbackUsed.has(`${channel}:${number}`));
        binding.feedback = cc === null ? null : { channel: binding.feedback.channel, cc };
      }
      if (binding.feedback) feedbackUsed.add(`${binding.feedback.channel}:${binding.feedback.cc}`);
    }
  }));
  draft.setup.banks.splice(draft.setup.banks.indexOf(original) + 1, 0, copy);
  for (const slot of draft.performance.slots) if (slot.banks.includes(bankId)) slot.banks.push(copy.id);
  // MODs that reach the original strip (side-chain style amounts per strip) reach the copy too.
  let mods = 0;
  for (const mod of draft.performance.mods) {
    for (const target of [...(mod.bank_targets || [])]) if (target.bank === bankId) { mod.bank_targets.push({ ...target, bank: copy.id }); mods++; }
    for (const destination of mod.destinations || []) if (destination.banks?.includes(bankId)) destination.banks.push(copy.id);
  }
  if (layout?.controls) for (const [key, style] of Object.entries(layout.controls)) if (key.startsWith(`${bankId}:`)) layout.controls[`${copy.id}:${key.slice(bankId.length + 1)}`] = clone(style);
  return { id: copy.id, unassigned, placed, mods };
}

export function removeStrip(draft, layout, bankId) {
  findBank(draft, bankId);
  draft.setup.banks = draft.setup.banks.filter(bank => bank.id !== bankId);
  draft.setup.resets = draft.setup.resets.filter(reset => reset.bank !== bankId);
  draft.performance.actions = draft.performance.actions.filter(action => !(['reset', 'mod_depth'].includes(action.action) && action.bank === bankId));
  for (const slot of draft.performance.slots) slot.banks = slot.banks.filter(id => id !== bankId);
  for (const mod of draft.performance.mods) {
    mod.bank_targets = mod.bank_targets.filter(target => target.bank !== bankId);
    mod.destinations = mod.destinations.filter(destination => {
      if (!destination.banks.includes(bankId)) return true;
      destination.banks = destination.banks.filter(id => id !== bankId);
      if (!destination.banks.length) destination.scale_by_bank = false;
      return destination.banks.length || destination.channels.length;
    });
  }
  if (layout?.controls) for (const key of Object.keys(layout.controls)) if (key.startsWith(`${bankId}:`)) delete layout.controls[key];
}

// Modulation and knob links follow a keyboard route by id; drop the ones whose route is gone.
export function pruneNoteRefs(draft) {
  const ids = new Set((draft.routing.notes || []).map(route => route.id));
  for (const mod of draft.performance.mods) mod.note_targets = (mod.note_targets || []).filter(target => ids.has(target.route));
  draft.performance.actions = draft.performance.actions.filter(action => !NOTE_ACTIONS[action.action] || ids.has(action.route));
  for (const bank of draft.setup.banks) for (const control of bank.controls) for (const binding of Object.values(control)) {
    if (!binding.note_links) continue;
    binding.note_links = binding.note_links.filter(link => ids.has(link.route));
    if (!binding.note_links.length) delete binding.note_links;
  }
}

export function removeController(draft, layout, controllerId) {
  const device = findDevice(draft, controllerId);
  if (device.kind !== 'controller') fail('Not a controller.');
  for (const bank of controllerBanks(draft, controllerId)) removeStrip(draft, layout, bank.id);
  draft.setup.resets = draft.setup.resets.filter(reset => reset.controller !== controllerId);
  draft.performance.actions = draft.performance.actions.filter(action => action.controller !== controllerId);
  if (draft.performance.shift?.controller === controllerId) {
    draft.performance.shift = null;
    for (const action of draft.performance.actions) action.shift = 'any';
  }
  for (const mod of draft.performance.mods) if (mod.trigger?.controller === controllerId) mod.trigger = null;
  draft.setup.devices = draft.setup.devices.filter(item => item.id !== controllerId);
  draft.routing.cc = draft.routing.cc.filter(route => route.controller !== controllerId);
  draft.routing.notes = (draft.routing.notes || []).filter(route => route.controller !== controllerId);
  pruneNoteRefs(draft);
  if (layout) { delete layout.inputs?.[controllerId]; delete layout.nodes?.[`ctl:${controllerId}`]; }
}

export function removeDevice(draft, layout, deviceId) {
  const device = findDevice(draft, deviceId);
  if (device.kind !== 'destination') fail('Not a destination device.');
  const strips = draft.setup.banks.filter(bank => bank.destination === deviceId).map(bank => bank.name);
  if (strips.length) fail(`${device.name} is driven by ${strips.join(', ')}. Remove those strips or point them at another device first.`);
  for (const bank of draft.setup.banks) for (const control of bank.controls) for (const binding of Object.values(control)) {
    if (binding.sends) binding.sends = binding.sends.filter(send => send.device !== deviceId);
  }
  for (const mod of draft.performance.mods) {
    mod.destinations = mod.destinations.filter(destination => destination.device !== deviceId);
    mod.targets = mod.targets.filter(target => target.ref[0] !== deviceId);
  }
  if (device.output) {
    draft.routing.clock.destinations = draft.routing.clock.destinations.filter(port => port !== device.output);
    draft.routing.notes = (draft.routing.notes || []).filter(route => route.port !== device.output);
    pruneNoteRefs(draft);
  }
  draft.setup.devices = draft.setup.devices.filter(item => item.id !== deviceId);
  if (layout) delete layout.nodes?.[`dev:${deviceId}`];
}

// Input/feedback addresses of one control layer. `source` / `feedback` are
// {channel, cc} or null. When feedback mirrored the old input, it follows it.
export function setControlInput(draft, bankId, index, layer, source) {
  const bank = findBank(draft, bankId);
  const binding = bank.controls[index]?.[layer] || fail('Unknown control.');
  if (source) {
    if (!Number.isInteger(source.channel) || source.channel < 1 || source.channel > 16) fail('MIDI channel must be 1–16.');
    if (!Number.isInteger(source.cc) || source.cc < 0 || source.cc > 119) fail('CC must be 0–119.');
    const used = usedInputs(draft, bank.controller, { bank: bankId, index, layer });
    const clash = used.get(`cc:${source.channel}:${source.cc}`);
    if (clash) fail(`MIDI ch ${source.channel} CC ${source.cc} is already used by ${clash}.`);
  }
  const mirrored = binding.feedback && binding.source && binding.feedback.channel === binding.source.channel && binding.feedback.cc === binding.source.cc;
  binding.source = source ? { channel: source.channel, cc: source.cc } : null;
  if (mirrored) binding.feedback = source ? { ...binding.source } : null;
}

export function setControlFeedback(draft, bankId, index, layer, feedback) {
  const bank = findBank(draft, bankId);
  const binding = bank.controls[index]?.[layer] || fail('Unknown control.');
  if (feedback) {
    if (!Number.isInteger(feedback.channel) || feedback.channel < 1 || feedback.channel > 16) fail('MIDI channel must be 1–16.');
    if (!Number.isInteger(feedback.cc) || feedback.cc < 0 || feedback.cc > 119) fail('CC must be 0–119.');
    for (const other of controllerBanks(draft, bank.controller)) other.controls.forEach((control, i) => Object.entries(control).forEach(([name, item]) => {
      if (findDevice(draft, bank.controller).layer_mode === 'software' && name !== layer) return;
      if (item !== binding && item.feedback && item.feedback.channel === feedback.channel && item.feedback.cc === feedback.cc) fail(`Feedback ch ${feedback.channel} CC ${feedback.cc} is already used by ${other.name} · ${bindingLabel(other, i, name, item)}.`);
    }));
  }
  binding.feedback = feedback ? { channel: feedback.channel, cc: feedback.cc } : null;
}

// Everything one control layer sends, as concrete MIDI addresses.
export function controlOutputs(draft, bankId, index, layer) {
  const bank = findBank(draft, bankId), binding = bank.controls[index][layer];
  const devices = devicesById(draft.setup), device = devices[bank.destination];
  const outputs = [];
  const describe = (target, cid, parameter, mapping, kind) => {
    const channel = target.channels.find(item => item.id === cid);
    const param = parameter === 'volume' ? channel?.volume : channel?.parameters[parameter];
    if (!param) return;
    const midi = target.channel_mode === 'selectable' ? (kind === 'send' ? mapping.midi_channel : (bank.midi_channels || [])[0] ?? param.channel) : param.channel;
    outputs.push({ kind, device: target.id, deviceName: target.name, port: target.output || null, cid, channelName: channel.name, parameter, label: param.label || parameter,
      midi, cc: param.cc, min: Math.max(param.min ?? 0, mapping.min ?? param.min ?? 0), max: Math.min(param.max ?? 127, mapping.max ?? param.max ?? 127), invert: Boolean(mapping.invert) });
  };
  if (binding.parameter && !BANK_MOD_PARAMETERS.includes(binding.parameter)) for (const cid of bank.channels) describe(device, cid, binding.parameter, binding, 'strip');
  (binding.sends || []).forEach(send => describe(devices[send.device], send.set, send.parameter, send, 'send'));
  return outputs;
}

export function addThruRoute(draft, { source, channel, cc, port, toChannel, toCc, controller = null, layer = null }) {
  for (const [value, low, high, label] of [[channel, 1, 16, 'Source channel'], [cc, 0, 119, 'Source CC'], [toChannel, 1, 16, 'Destination channel'], [toCc, 0, 119, 'Destination CC']]) {
    if (!Number.isInteger(value) || value < low || value > high) fail(`${label} must be ${low}–${high}.`);
  }
  if (!source || !port) fail('Choose both ports.');
  if (source === port) fail('A Thru route cannot return to its source port.');
  const routes = draft.routing.cc;
  let route = routes.find(item => item.source === source && item.channel === channel && item.cc === cc && (item.layer || null) === layer && (item.controller || null) === controller);
  if (!route) { if (routes.length >= 64) fail('Up to 64 Thru routes.'); route = { source, channel, cc, destinations: [] }; routes.push(route); }
  if (route.destinations.some(item => item.port === port && item.channel === toChannel && item.cc === toCc)) fail('That route already exists.');
  route.destinations.push({ port, channel: toChannel, cc: toCc });
  if (controller && layer) Object.assign(route, { controller, layer });
  return routes.indexOf(route);
}

// ---------------------------------------------------------------- history

export class History {
  constructor(limit = 100) { this.limit = limit; this.past = []; this.future = []; }
  push(snapshot) { this.past.push(JSON.stringify(snapshot)); if (this.past.length > this.limit) this.past.shift(); this.future = []; }
  undo(current) { if (!this.past.length) return null; this.future.push(JSON.stringify(current)); return JSON.parse(this.past.pop()); }
  redo(current) { if (!this.future.length) return null; this.past.push(JSON.stringify(current)); return JSON.parse(this.future.pop()); }
}

export function changedSections(base, draft) {
  if (draft.profile) return { profile: { ...clone(draft.profile), bank_setup: clone(draft.setup), performance: clone(draft.performance), routing: clone(draft.routing) } };
  const result = {};
  if (JSON.stringify(base.setup) !== JSON.stringify(draft.setup)) result.banks = draft.setup;
  if (JSON.stringify(base.performance) !== JSON.stringify(draft.performance)) result.performance = draft.performance;
  if (JSON.stringify(base.routing) !== JSON.stringify(draft.routing)) result.routing = draft.routing;
  return result;
}

// Key split: the route keeps the notes below `at`; a copy takes `at` and above on
// the next MIDI channel, ready to be pointed at another device or channel.
export function splitNoteRoute(draft, index, at) {
  const route = draft.routing.notes[index] || fail('That keyboard route no longer exists.');
  if (!Number.isInteger(at) || at <= route.low || at > route.high) fail(`Choose a split point above ${noteName(route.low)} and no higher than ${noteName(route.high)}.`);
  const upper = clone(route);
  upper.id = uniqueId(draft.routing.notes.map(item => item.id), 'n');
  upper.low = at; route.high = at - 1; upper.out_channel = route.out_channel % 16 + 1;
  draft.routing.notes.splice(index + 1, 0, upper);
  return index + 1;
}

export { Snap, Ops };
