export const VERSION = 3;
export const COLORS = ['magenta', 'cyan', 'amber', 'neutral'];
export const KINDS = ['knob', 'fader', 'button'];
export const clone = value => JSON.parse(JSON.stringify(value));
export const uid = () => globalThis.crypto.randomUUID();
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function knobPresentation(value, centerDetent = false) {
  const position = clamp(value, 0, 127);
  const sweep = centerDetent ? position <= 64 ? position / 64 * 135 : 135 + (position - 64) / 63 * 135 : position / 127 * 270;
  return { angle: sweep - 135, start: centerDetent ? Math.min(135, sweep) : 0, end: centerDetent ? Math.max(135, sweep) : sweep, centered: centerDetent && position === 64 };
}

export function detentValue(value, enabled = false) {
  const position = clamp(Math.round(value), 0, 127);
  return enabled && Math.abs(position - 64) <= 2 ? 64 : position;
}

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}: use ${min}–${max}.`);
}

function text(value, label, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 512) throw new Error(`${label}: use text up to 512 characters.`);
}

function list(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label}: use ${min}–${max} items.`);
}

export function normalizeDevices(devices) {
  return devices.filter(device => device.kind === 'destination').map(device => ({
    id: device.id, name: device.name, output: device.output || '', channelMode: device.channel_mode || 'fixed',
    channels: device.channels.map(channel => ({ id: channel.id, name: channel.name,
      parameters: Object.fromEntries(Object.entries(channel.parameters).map(([key, parameter]) => [key, {
        label: parameter.label || key, channel: parameter.channel, cc: parameter.cc, min: parameter.min ?? 0, max: parameter.max ?? 127,
      }])),
    })),
  }));
}

export function validate(doc) {
  if (!doc || doc.version !== VERSION) throw new Error('Choose a MIDIBRAIN Surface workspace (version 1, 2 or 3).');
  text(doc.name, 'Workspace name'); list(doc.controllers, 1, 16, 'Controllers'); list(doc.devices, 0, 32, 'Device definitions'); list(doc.modules, 0, 128, 'Modules');
  const ids = new Set();
  const identity = value => { text(value, 'ID'); if (ids.has(value)) throw new Error('Duplicate object ID.'); ids.add(value); };
  const boolean = (value, label) => { if (typeof value !== 'boolean') throw new Error(`${label} must be on or off.`); };
  list(doc.pages, 0, 32, 'Workspace pages');
  for (const page of doc.pages) { identity(page.id); text(page.name, 'Page name'); }
  if (!doc.canvas || !['manual', 'fit'].includes(doc.canvas.scale)) throw new Error('Choose fixed zoom or fit width.');
  integer(doc.canvas.width, 720, 2400, 'Canvas width'); integer(doc.canvas.height, 480, 9600, 'Canvas height'); integer(doc.canvas.zoom, 25, 150, 'Canvas zoom');
  const source = value => {
    if (!value || !['cc', 'note'].includes(value.type)) throw new Error('Choose CC or note input.');
    integer(value.channel, 1, 16, 'Input channel'); integer(value.number, 0, 127, 'Input number');
  };
  const limits = value => { integer(value.min, 0, 127, 'Minimum'); integer(value.max, value.min, 127, 'Maximum'); boolean(value.invert, 'Invert'); };
  for (const controller of doc.controllers) {
    identity(controller.id); text(controller.name, 'Controller name'); text(controller.input, 'Input port', true); boolean(controller.collapsed, 'Controller visibility');
    if (!COLORS.includes(controller.color)) throw new Error('Unknown controller accent.');
  }
  for (const device of doc.devices) {
    identity(device.id); text(device.name, 'Device name'); text(device.output, 'Output port', true);
    if (!['fixed', 'selectable'].includes(device.channelMode)) throw new Error('Unknown channel mode.');
    list(device.channels, 1, 16, 'Device channels');
    const channelIds = new Set();
    for (const channel of device.channels) {
      if (!(typeof channel.id === 'string' && channel.id.trim()) && !Number.isInteger(channel.id)) throw new Error('Invalid logical channel ID.');
      if (channelIds.has(channel.id)) throw new Error('Duplicate logical channel.');
      channelIds.add(channel.id); text(channel.name, 'Channel name');
      if (!channel.parameters || typeof channel.parameters !== 'object' || Array.isArray(channel.parameters) || Object.keys(channel.parameters).length > 5000) throw new Error('Invalid parameter definitions.');
      for (const [key, parameter] of Object.entries(channel.parameters)) {
        text(key, 'Parameter key'); text(parameter.label, 'Parameter label');
        integer(parameter.channel, 1, 16, 'Definition channel'); integer(parameter.cc, 0, 127, 'Definition CC');
        integer(parameter.min, 0, 127, 'Definition minimum'); integer(parameter.max, parameter.min, 127, 'Definition maximum');
      }
    }
  }
  let controlCount = 0;
  for (const module of doc.modules) {
    identity(module.id); text(module.name, 'Module name');
    if (module.page !== null && !doc.pages.some(page => page.id === module.page)) throw new Error('Module page is missing.');
    if (module.runtimeBank !== undefined) text(module.runtimeBank, 'Runtime mapping reference');
    if (!doc.controllers.some(controller => controller.id === module.controller)) throw new Error('Module controller is missing.');
    if (!KINDS.includes(module.kind) || !COLORS.includes(module.color)) throw new Error('Unknown module type or accent.');
    integer(module.columns, 1, 8, 'Columns'); integer(module.x, 0, 9, 'Module X'); integer(module.y, 0, 300, 'Module Y'); integer(module.width, 3, 12 - module.x, 'Module width');
    if (module.height !== undefined) integer(module.height, 4, 960, 'Module height');
    boolean(module.collapsed, 'Module collapse'); boolean(module.layersEnabled, 'Input variants'); list(module.layers, 1, 8, 'Input variants');
    const layerIds = new Set();
    for (const layer of module.layers) {
      text(layer.id, 'Variant ID'); text(layer.name, 'Variant name');
      if (layerIds.has(layer.id)) throw new Error('Duplicate input variant.'); layerIds.add(layer.id);
    }
    if (module.layers[0].id !== 'normal') throw new Error('The first input variant must be normal.');
    list(module.groups, 0, 64, 'Channel assignments');
    for (const group of module.groups) {
      identity(group.id); text(group.name, 'Assignment name'); list(group.destinations, 0, 8, 'Assignment destinations');
      let fanout = 0;
      for (const target of group.destinations) {
        identity(target.id);
        const device = doc.devices.find(item => item.id === target.device);
        if (!device) throw new Error('An assignment references a missing device definition.');
        list(target.channels, 0, 16, 'Selected channels'); list(target.midiChannels, 0, 16, 'Selected MIDI channels');
        if (new Set(target.channels).size !== target.channels.length || target.channels.some(channel => !device.channels.some(item => item.id === channel))) throw new Error('Select distinct channels from the device definition.');
        if (new Set(target.midiChannels).size !== target.midiChannels.length) throw new Error('Select distinct MIDI channels.');
        target.midiChannels.forEach(channel => integer(channel, 1, 16, 'Destination MIDI channel'));
        fanout += target.channels.length * (device.channelMode === 'selectable' ? target.midiChannels.length : 1);
      }
      if (fanout > 128) throw new Error('A channel assignment can expand to at most 128 destinations.');
    }
    list(module.controls, 1, 64, 'Module controls');
    for (const control of module.controls) {
      if (++controlCount > 1024) throw new Error('Use at most 1024 controls per workspace.');
      identity(control.id); text(control.name, 'Control label');
      if (control.centerDetent !== undefined) boolean(control.centerDetent, 'Center detent');
      if (!control.bindings || Object.keys(control.bindings).length !== module.layers.length) throw new Error('Each control needs a binding for every input variant.');
      for (const layer of module.layers) {
        const current = control.bindings[layer.id];
        if (!current) throw new Error('Missing input variant binding.');
        source(current.source); integer(current.value, 0, 127, 'Preview value'); limits(current);
        if (current.parameter !== null) text(current.parameter, 'Parameter key');
        if (current.group !== null && !module.groups.some(group => group.id === current.group)) throw new Error('Missing channel assignment.');
        list(current.targets, 0, 32, 'Direct destinations');
        for (const target of current.targets) {
          identity(target.id); text(target.device, 'Direct device'); text(target.parameter, 'Direct parameter');
          integer(target.channel, 1, 16, 'Direct channel'); integer(target.cc, 0, 127, 'Direct CC'); limits(target);
        }
      }
    }
  }
  return doc;
}

export function nextSource(doc, controllerId, type = 'cc') {
  const used = new Set(doc.modules.filter(module => module.controller === controllerId).flatMap(module => module.controls.flatMap(control => Object.values(control.bindings))).filter(current => current.source.type === type).map(current => `${current.source.channel}:${current.source.number}`));
  for (let channel = 1; channel <= 16; channel++) {
    for (let number = 0; number <= 119; number++) if (!used.has(`${channel}:${number}`)) return { type, channel, number };
  }
  throw new Error('No unused input address left on this controller.');
}

export function binding(source, group = null, parameter = null) {
  return { source, group, parameter, value: 64, min: 0, max: 127, invert: false, targets: [] };
}

export function addController(doc, name = 'New controller') {
  const controller = { id: uid(), name, input: '', color: 'neutral', collapsed: false };
  doc.controllers.push(controller); return controller;
}

export function moduleHeight(module, details = true) {
  if (module.collapsed) return 4;
  const assignmentsHeight = Math.max(1, Math.ceil(module.groups.length / 8)) * 50;
  const rowHeight = (details ? { knob: 132, fader: 220, button: 110 } : { knob: 96, fader: 184, button: 74 })[module.kind];
  return Math.max(module.height || 0, Math.ceil((60 + assignmentsHeight + (module.layersEnabled ? 30 : 0) + Math.ceil(module.controls.length / module.columns) * rowHeight) / 24));
}

export function addModule(doc, controllerId, kind = 'knob', columns = 4, rows = 1) {
  if (!KINDS.includes(kind)) throw new Error('Unknown module type.');
  integer(columns, 1, 8, 'Columns'); integer(rows, 1, 8, 'Rows');
  if (rows * columns > 64) throw new Error('Use at most 64 controls per module.');
  const controller = doc.controllers.find(item => item.id === controllerId);
  if (!controller) throw new Error('Select a controller.');
  const module = {
    id: uid(), page: null, controller: controllerId, name: { knob: 'Encoder matrix', fader: 'Fader strip', button: 'Button grid' }[kind],
    kind, columns, x: 0, y: doc.modules.reduce((bottom, item) => Math.max(bottom, item.y + moduleHeight(item)), 0), width: Math.min(12, Math.max(4, columns * 2)),
    color: controller.color, collapsed: false, layersEnabled: false, layers: [{ id: 'normal', name: 'Normal' }], groups: [], controls: [],
  };
  if (module.y > 300) throw new Error('Canvas is full. Move modules up first.');
  doc.modules.push(module);
  for (let index = 0; index < rows * columns; index++) module.controls.push({ id: uid(), name: `Control ${index + 1}`, bindings: { normal: binding(nextSource(doc, controllerId, kind === 'button' ? 'note' : 'cc')) } });
  configureAssignments(module, 'columns'); return module;
}

export function configureAssignments(module, scope) {
  if (!['columns', 'module'].includes(scope)) throw new Error('Choose a module or column assignment.');
  module.groups = Array.from({ length: scope === 'module' ? 1 : module.columns }, (_, index) => ({ id: uid(), name: scope === 'module' ? 'All controls' : `Strip ${index + 1}`, destinations: [] }));
  module.controls.forEach((control, index) => Object.values(control.bindings).forEach(current => { current.group = module.groups[scope === 'module' ? 0 : index % module.columns].id; }));
}

export function addInputVariant(doc, module, name = `Variant ${module.layers.length + 1}`, id = uid()) {
  if (module.layers.length >= 8) throw new Error('Use at most 8 input variants.');
  if (module.layers.some(layer => layer.id === id)) throw new Error('Duplicate input variant.');
  module.layers.push({ id, name });
  for (const control of module.controls) {
    const base = control.bindings.normal;
    control.bindings[id] = { ...clone(base), source: nextSource(doc, module.controller, base.source.type), parameter: null, value: 0, targets: [] };
  }
  module.layersEnabled = true;
  return id;
}

export function enableLayers(doc, module, enabled) {
  if (enabled && module.layers.length === 1) addInputVariant(doc, module, 'Alternate', 'alternate');
  module.layersEnabled = enabled;
}

export function resolveTargets(doc, module, control, layer = 'normal') {
  const current = control.bindings[layer];
  if (!current || (!module.layersEnabled && layer !== 'normal')) return { targets: [], missing: ['This input variant is disabled.'] };
  const targets = clone(current.targets), missing = [];
  const group = module.groups.find(item => item.id === current.group);
  if (group && current.parameter) {
    for (const assignment of group.destinations) {
      const device = doc.devices.find(item => item.id === assignment.device);
      for (const channelId of assignment.channels) {
        const channel = device?.channels.find(item => item.id === channelId);
        const parameter = channel && Object.hasOwn(channel.parameters, current.parameter) ? channel.parameters[current.parameter] : null;
        if (!parameter) { missing.push(`${device?.name || assignment.device} / ${channel?.name || channelId}: ${current.parameter} unavailable`); continue; }
        const midiChannels = device.channelMode === 'selectable' ? assignment.midiChannels : [parameter.channel];
        if (!midiChannels.length) missing.push(`${device.name}: select an output MIDI channel`);
        const min = Math.max(parameter.min, current.min), max = Math.min(parameter.max, current.max);
        if (min > max) { missing.push(`${channel.name}: output range does not overlap the parameter limits`); continue; }
        for (const midiChannel of midiChannels) targets.push({ device: device.name, deviceId: device.id, output: device.output, parameter: parameter.label, logicalChannel: channel.name, channel: midiChannel, cc: parameter.cc, min, max, invert: current.invert });
      }
    }
  }
  const unique = new Map();
  for (const target of targets) {
    const key = JSON.stringify([target.output || target.deviceId || target.device, target.channel, target.cc]), previous = unique.get(key);
    if (previous && ['min', 'max', 'invert'].some(field => previous[field] !== target[field])) missing.push(`${target.device}: conflicting ranges for ch ${target.channel} CC ${target.cc}; first destination retained`);
    if (!previous) unique.set(key, target);
  }
  return { targets: [...unique.values()], missing };
}

export function outputValue(value, target) {
  return Math.round(target.min + (target.invert ? 127 - value : value) / 127 * (target.max - target.min));
}

export function conflicts(doc) {
  const addresses = new Map();
  for (const module of doc.modules) {
    const controller = doc.controllers.find(item => item.id === module.controller);
    for (const control of module.controls) {
      for (const layer of module.layersEnabled ? module.layers : module.layers.slice(0, 1)) {
        const source = control.bindings[layer.id].source;
        const key = JSON.stringify([controller.input.trim() || controller.id, source.type, source.channel, source.number]);
        if (!addresses.has(key)) addresses.set(key, []);
        addresses.get(key).push(`${control.id}:${layer.id}`);
      }
    }
  }
  return new Set([...addresses.values()].filter(group => group.length > 1).flat());
}

export function duplicateModule(doc, original) {
  const module = clone(original);
  delete module.runtimeBank;
  module.id = uid(); module.name = `${original.name.slice(0, 490)} copy`;
  module.y = doc.modules.reduce((bottom, item) => Math.max(bottom, item.y + moduleHeight(item)), 0);
  if (module.y > 300) throw new Error('Canvas is full. Move modules up first.');
  const groups = new Map(module.groups.map(group => [group.id, uid()]));
  module.groups.forEach(group => { group.id = groups.get(group.id); group.destinations.forEach(target => { target.id = uid(); }); });
  const originals = module.controls; module.controls = []; doc.modules.push(module);
  for (const old of originals) {
    const control = { id: uid(), name: old.name, bindings: {} }; module.controls.push(control);
    for (const layer of module.layers) {
      const current = clone(old.bindings[layer.id]);
      delete current.runtime;
      current.source = nextSource(doc, module.controller, current.source.type); current.group = groups.get(current.group) || null;
      current.targets.forEach(target => { target.id = uid(); }); control.bindings[layer.id] = current;
    }
  }
  return module;
}

export function repeatMapping(module, controlId, direction, layer = 'normal') {
  const index = module.controls.findIndex(control => control.id === controlId);
  if (index < 0 || !['row', 'column', 'all'].includes(direction)) throw new Error('Select a control and a repeat direction.');
  const origin = module.controls[index].bindings[layer];
  for (const [position, control] of module.controls.entries()) {
    if (position === index || (direction === 'row' && Math.floor(position / module.columns) !== Math.floor(index / module.columns)) || (direction === 'column' && position % module.columns !== index % module.columns)) continue;
    Object.assign(control.bindings[layer], { parameter: origin.parameter, min: origin.min, max: origin.max, invert: origin.invert });
  }
}

export function migrateWorkspace(value) {
  if (value?.version === VERSION) return clone(validate(value));
  if (value?.version === 2) {
    const doc = clone(value); doc.version = VERSION; doc.pages = [];
    doc.modules.forEach(module => { module.page = null; });
    doc.canvas = { width: 1200, height: Math.min(9600, Math.max(960, ...doc.modules.map(module => (module.y + moduleHeight(module) + 1) * 24))), scale: 'manual', zoom: 100 };
    return validate(doc);
  }
  if (value?.version !== 1 || !Array.isArray(value.surfaces)) throw new Error('Choose a supported Surface workspace.');
  const doc = { version: 2, name: value.name, controllers: [], devices: [], modules: [] };
  const colors = { mint: 'magenta', blue: 'cyan', amber: 'amber', rose: 'magenta', violet: 'cyan' };
  let offset = 0;
  for (const surface of value.surfaces) {
    const controller = { id: surface.id, name: surface.name, input: surface.input, color: colors[surface.color] || 'neutral', collapsed: false };
    doc.controllers.push(controller);
    for (const page of surface.pages) {
      const bottom = page.modules.reduce((end, module) => Math.max(end, module.y + Math.ceil((94 + Math.ceil(module.controls.length / module.columns) * { knob: 116, fader: 204, button: 94 }[module.kind]) / 24)), 0);
      for (const old of page.modules) doc.modules.push({
        id: old.id, controller: controller.id, name: surface.pages.length > 1 ? `${page.name} / ${old.name}` : old.name,
        kind: old.kind, columns: old.columns, x: old.x, y: old.y + offset, width: old.width, color: colors[old.color] || 'neutral', collapsed: false,
        layersEnabled: false, layers: [{ id: 'normal', name: 'Normal' }], groups: [],
        controls: old.controls.map(control => ({ id: control.id, name: control.name, bindings: { normal: { ...binding(clone(control.source)), value: control.value, targets: clone(control.targets) } } })),
      });
      offset += bottom + 2;
    }
  }
  return migrateWorkspace(doc);
}

export function demoWorkspace(devices = []) {
  const doc = { version: VERSION, name: 'Performance rig', pages: [], canvas: { width: 1200, height: 960, scale: 'manual', zoom: 100 }, controllers: [], devices: clone(devices), modules: [] };
  const twister = addController(doc, 'MIDI Fighter Twister'), xl = addController(doc, 'Launch Control XL');
  const encoders = addModule(doc, twister.id, 'knob', 4, 4);
  encoders.name = 'Mixer strips'; encoders.width = 7; encoders.x = 0; encoders.y = 0;
  const device = devices.find(item => item.id === 'l6') || devices[0];
  if (device) encoders.groups.forEach((group, index) => {
    const channels = [[0, 2], [1], [3, 4], [5]][index].map(position => device.channels[position]?.id).filter(channel => channel !== undefined);
    group.destinations.push({ id: uid(), device: device.id, channels, midiChannels: device.channelMode === 'selectable' ? [index + 1] : [] });
  });
  encoders.controls.forEach((control, index) => {
    control.name = ['Low', 'High', 'Aux 1', 'Aux 2'][Math.floor(index / 4)];
    control.bindings.normal.parameter = ['low', 'high', 'aux1', 'aux2'][Math.floor(index / 4)];
    control.bindings.normal.source = { type: 'cc', channel: 1, number: index }; control.bindings.normal.value = index < 8 ? 64 : 0;
  });
  enableLayers(doc, encoders, true);
  encoders.controls.forEach((control, index) => {
    control.bindings.alternate.source = { type: 'cc', channel: 5, number: index };
    control.bindings.alternate.parameter = ['mid', null, 'efx', null][Math.floor(index / 4)];
  });
  const macros = addModule(doc, xl.id, 'knob', 4, 2);
  macros.name = 'Send & tone'; macros.x = 7; macros.y = 0; macros.width = 5; configureAssignments(macros, 'module');
  if (device) macros.groups[0].destinations = [{ id: uid(), device: device.id, channels: device.channels.slice(0, 6).map(channel => channel.id), midiChannels: device.channelMode === 'selectable' ? [1] : [] }];
  macros.controls.forEach((control, index) => { control.name = ['Low', 'Mid', 'High', 'Pan', 'Aux 1', 'Aux 2', 'FX', 'Mute'][index]; control.bindings.normal.parameter = ['low', 'mid', 'high', 'pan', 'aux1', 'aux2', 'efx', 'mute'][index]; });
  const faders = addModule(doc, xl.id, 'fader', 4, 1);
  faders.name = 'Hands-on sends'; faders.x = 7; faders.y = 16; faders.width = 5;
  if (device) faders.groups.forEach((group, index) => { group.destinations = [{ id: uid(), device: device.id, channels: [device.channels[index % device.channels.length].id], midiChannels: device.channelMode === 'selectable' ? [1] : [] }]; });
  faders.controls.forEach((control, index) => { control.name = `Send ${index + 1}`; control.bindings.normal.parameter = 'aux1'; control.bindings.normal.value = 24 + index * 16; });
  return validate(doc);
}

export class History {
  constructor(doc) { this.doc = clone(validate(doc)); this.past = []; this.future = []; }
  apply(change) {
    const candidate = clone(this.doc), result = change(candidate); validate(candidate);
    if (JSON.stringify(candidate) === JSON.stringify(this.doc)) return result;
    this.past.push(clone(this.doc)); if (this.past.length > 60) this.past.shift(); this.doc = candidate; this.future = []; return result;
  }
  undo() { if (!this.past.length) return false; this.future.push(this.doc); this.doc = this.past.pop(); return true; }
  redo() { if (!this.future.length) return false; this.past.push(this.doc); this.doc = this.future.pop(); return true; }
}
