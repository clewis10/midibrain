import { VERSION, binding, clone, moduleHeight, normalizeDevices, uid, validate } from './surface-model.mjs';

function controlName(mapping, setup, bank, index) {
  if (mapping.label) return mapping.label;
  const device = setup.devices.find(item => item.id === bank.destination);
  const channel = device?.channels.find(item => bank.channels.includes(item.id)) || device?.channels[0];
  return channel && Object.hasOwn(channel.parameters, mapping.parameter) ? channel.parameters[mapping.parameter].label || mapping.parameter : new Map([['depth', 'MOD 1'], ['mod_depth_2', 'MOD 2'], ['mod_depth_3', 'MOD 3']]).get(mapping.parameter) || `Control ${index + 1}`;
}

export function projectRig(snapshot) {
  const setup = snapshot.active;
  const doc = { version: VERSION, name: 'Current rig', pages: [], canvas: { width: 1200, height: 960, zoom: 100, scale: 'manual' }, controllers: [], devices: normalizeDevices(setup.devices), modules: [] };
  for (const device of setup.devices.filter(item => item.kind === 'controller')) {
    doc.controllers.push({ id: device.id, name: device.name, input: device.input || '', color: 'neutral', collapsed: false });
  }
  let bottom = 0;
  setup.banks.forEach((bank, bankIndex) => {
    const controller = doc.controllers.find(item => item.id === bank.controller);
    const variants = Object.keys(bank.controls[0]);
    if (variants.includes('normal')) { variants.splice(variants.indexOf('normal'), 1); variants.unshift('normal'); }
    const group = { id: uid(), name: bank.name, destinations: [{ id: uid(), device: bank.destination, channels: clone(bank.channels), midiChannels: clone(bank.midi_channels || []) }] };
    const module = { id: uid(), runtimeBank: bank.id, page: null, controller: controller.id, name: bank.name, color: controller.color,
      kind: 'knob', columns: 1, x: bankIndex % 4 * 3, y: bottom, width: 3, collapsed: false,
      layersEnabled: variants.length > 1, layers: variants.map((name, index) => ({ id: index === 0 ? 'normal' : name, name })), groups: [group], controls: [] };
    bank.controls.forEach((control, index) => {
      const projected = { id: uid(), name: controlName(control[variants[0]], setup, bank, index), bindings: {} };
      variants.forEach((name, variantIndex) => {
        const mapping = control[name];
        const current = binding({ type: 'cc', channel: mapping.source?.channel || 1, number: mapping.source?.cc ?? 119 }, group.id, mapping.parameter || null);
        Object.assign(current, { min: mapping.min ?? 0, max: mapping.max ?? 127, invert: mapping.invert ?? false,
          runtime: { bank: bank.id, index, layer: name, identity: { controller: bank.controller, destination: bank.destination, channels: clone(bank.channels), midi_channels: clone(bank.midi_channels ?? null), binding: clone(mapping) } } });
        for (const send of mapping.sends || []) {
          const device = doc.devices.find(item => item.id === send.device), parameter = device.channels.find(channel => channel.id === send.set).parameters[send.parameter];
          current.targets.push({ id: uid(), device: device.name, parameter: parameter.label, channel: device.channelMode === 'selectable' ? send.midi_channel : parameter.channel, cc: parameter.cc,
            min: Math.max(parameter.min, send.min ?? 0), max: Math.min(parameter.max, send.max ?? 127), invert: send.invert ?? false });
        }
        projected.bindings[variantIndex === 0 ? 'normal' : name] = current;
      });
      module.controls.push(projected);
    });
    doc.modules.push(module);
    if (bankIndex % 4 === 3) bottom = Math.max(...doc.modules.map(item => item.y + moduleHeight(item))) + 1;
  });
  doc.canvas.height = Math.max(960, ...doc.modules.map(module => (module.y + moduleHeight(module) + 1) * 24));
  return validate(doc);
}

export function matchingState(current, snapshot) {
  const reference = current?.runtime;
  if (!reference || !snapshot?.native || snapshot.staged || snapshot.running === false) return null;
  const state = snapshot.controls.find(item => item.bank === reference.bank && item.index === reference.index && item.layer === reference.layer);
  return state?.assigned && JSON.stringify(state.identity) === JSON.stringify(reference.identity) ? state : null;
}

export function liveCommand(current, snapshot) {
  const state = matchingState(current, snapshot);
  if (!state) throw new Error('The active mapping changed or is staged. Read the active rig again before using this control.');
  return { bank: current.runtime.bank, index: current.runtime.index, layer: current.runtime.layer, expected: clone(state.identity),
    ...(snapshot.instance_id && snapshot.definitions_revision ? { runtime_instance: snapshot.instance_id, definitions_revision: snapshot.definitions_revision } : {}) };
}

export function stageModule(module, snapshot) {
  const original = snapshot?.active.banks.find(bank => bank.id === module.runtimeBank);
  if (!original || module.controls.length !== original.controls.length || module.groups.length !== 1) throw new Error('Read the active rig again; the runtime strip structure changed.');
  const destination = module.groups[0].destinations;
  if (destination.length !== 1 || destination[0].device !== original.destination) throw new Error('Use Routing to change a runtime strip’s destination device or additional sends.');
  const replacement = clone(original);
  replacement.channels = clone(destination[0].channels);
  if (original.depth_overrides) replacement.depth_overrides = Object.fromEntries(Object.entries(original.depth_overrides).filter(([channel]) => replacement.channels.some(id => String(id) === channel)));
  if (original.midi_channels !== undefined) replacement.midi_channels = clone(destination[0].midiChannels);
  module.controls.forEach((control, index) => {
    const primary = control.bindings.normal.runtime;
    if (!primary || primary.index !== index) throw new Error('Runtime controls were rearranged. Read the active rig again.');
    const originalName = controlName(original.controls[index][primary.layer], snapshot.active, original, index);
    for (const current of Object.values(control.bindings)) {
      const reference = current.runtime, mapping = reference && original.controls[index][reference.layer];
      const identity = mapping && { controller: original.controller, destination: original.destination, channels: original.channels, midi_channels: original.midi_channels ?? null, binding: mapping };
      if (!identity || reference.bank !== original.id || reference.index !== index || JSON.stringify(identity) !== JSON.stringify(reference.identity)) throw new Error('The runtime mapping changed. Read the active rig again; no draft was replaced.');
      if (current.source.type !== 'cc' || current.group !== module.groups[0].id) throw new Error('Use Routing for runtime message types or channel-set structure changes.');
      const changed = replacement.controls[index][reference.layer];
      if (control.name !== originalName) changed.label = control.name;
      if (current.parameter !== (mapping.parameter || null)) changed.parameter = current.parameter;
      for (const key of ['min', 'max', 'invert']) if (current[key] !== (mapping[key] ?? { min: 0, max: 127, invert: false }[key])) changed[key] = current[key];
      if (current.source.channel !== (mapping.source?.channel || 1) || current.source.number !== (mapping.source?.cc ?? 119)) changed.source = { channel: current.source.channel, cc: current.source.number };
    }
  });
  return { bank: original.id, expected: clone(original), replacement };
}

export function hasMappingEdits(module, snapshot) {
  try { const staged = stageModule(module, snapshot); return JSON.stringify(staged.expected) !== JSON.stringify(staged.replacement); }
  catch { return true; }
}

export function refreshRig(snapshot, workspace) {
  const incoming = projectRig(snapshot);
  if (!workspace.modules.some(module => module.runtimeBank)) return incoming;
  const doc = clone(workspace);
  const oldModules = new Map(doc.modules.filter(module => module.runtimeBank).map(module => [module.runtimeBank, module]));
  const controllers = new Map(doc.controllers.map(controller => [controller.id, controller]));
  incoming.controllers.forEach(controller => controllers.set(controller.id, { ...controller, ...controllers.get(controller.id), input: controller.input }));
  const devices = new Map(doc.devices.map(device => [device.id, device])); incoming.devices.forEach(device => devices.set(device.id, device));
  doc.controllers = [...controllers.values()]; doc.devices = [...devices.values()];
  doc.modules = [...doc.modules.filter(module => !module.runtimeBank), ...incoming.modules.map(module => {
    const old = oldModules.get(module.runtimeBank); if (!old) return module;
    for (const key of ['id', 'page', 'name', 'x', 'y', 'width', 'columns', 'collapsed', 'color', 'kind']) module[key] = old[key];
    if (old.height !== undefined) module.height = old.height;
    const group = module.groups[0]; group.id = old.groups[0].id; group.name = old.groups[0].name;
    module.controls.forEach((control, index) => { if (old.controls[index]) { control.id = old.controls[index].id; if (old.controls[index].centerDetent !== undefined) control.centerDetent = old.controls[index].centerDetent; } Object.values(control.bindings).forEach(current => { current.group = group.id; }); });
    return module;
  })];
  return validate(doc);
}

export function definitionsMatch(workspace, snapshot) {
  if (!snapshot?.active) return false;
  const definitions = normalizeDevices(snapshot.active.devices);
  const used = new Set(snapshot.active.banks.filter(bank => workspace.modules.some(module => module.runtimeBank === bank.id)).flatMap(bank => [bank.destination, ...bank.controls.flatMap(control => Object.values(control).flatMap(current => (current.sends || []).map(send => send.device)))]));
  return [...used].every(id => JSON.stringify(workspace.devices.find(device => device.id === id)) === JSON.stringify(definitions.find(device => device.id === id)));
}
