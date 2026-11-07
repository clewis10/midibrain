// Controller templates for the patch canvas: turn one controller node into a portable
// JSON description and back. Pure functions over the same draft/layout the canvas edits,
// so an import is one undoable edit and Apply still runs the engine's full validation.
//
// A template holds the controller's *shape and input addresses* (strips, layers, global
// inputs, how the controls look). Destination mappings are optional ("with mappings") because
// they only make sense on a rig that has the same devices.

import { clone, controllerLayerKeys, bankLayerKeys, uniqueId, controllerLayout, globalStyleKey, inputKey } from './patch-model.mjs';

export const TEMPLATE_FORMAT = 'midibrain.controller';
export const TEMPLATE_VERSION = 1;
const fail = message => { throw new Error(message); };

function bindingTemplate(binding, mappings) {
  const result = {};
  if (binding.source) result.source = { channel: binding.source.channel, cc: binding.source.cc };
  if (binding.feedback) result.feedback = { channel: binding.feedback.channel, cc: binding.feedback.cc };
  if (binding.label) result.label = binding.label;
  if (mappings) for (const key of ['parameter', 'min', 'max', 'invert']) if (binding[key] !== undefined && binding[key] !== null) result[key] = binding[key];
  return result;
}

// Describe a controller (and its strips) as a template. `mappings` also keeps each control's
// destination parameter, range and inversion plus the strip's destination/channels.
export function exportController(draft, layout, controllerId, { mappings = false, name = null, manufacturer = null } = {}) {
  const device = draft.setup.devices.find(item => item.id === controllerId && item.kind === 'controller') || fail('That controller no longer exists.');
  const layers = bankLayerKeys(device);
  const banks = draft.setup.banks.filter(bank => bank.controller === controllerId);
  const template = {
    format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, name: (name || device.name).trim().slice(0, 80) || 'Controller', ...(manufacturer && manufacturer.trim() ? { manufacturer: manufacturer.trim().slice(0, 80) } : {}),
    controller: { name: device.name, controls_per_bank: device.controls_per_bank, layers: layers.length ? layers : ['normal'] },
    strips: banks.map(bank => ({
      name: bank.name,
      ...(mappings ? { destination: bank.destination, channels: [...bank.channels], ...(bank.midi_channels ? { midi_channels: [...bank.midi_channels] } : {}) } : {}),
      controls: bank.controls.map(control => Object.fromEntries(Object.entries(control).filter(([layer]) => layers.includes(layer)).map(([layer, binding]) => [layer, bindingTemplate(binding, mappings)]))),
    })),
    inputs: ((layout.inputs || {})[controllerId] || []).map(item => ({ type: item.type, channel: item.channel, number: item.number ?? null, ...(item.label ? { label: item.label } : {}) })),
    appearance: { arrangement: controllerLayout(layout, controllerId), controls: {}, globals: {} },
  };
  if (device.layer_mode === 'software' && device.layer_switch) { template.controller.layer_mode = 'software'; template.controller.layer_switch = clone(device.layer_switch); }
  banks.forEach((bank, position) => {
    bank.controls.forEach((_, index) => {
      const style = layout.controls?.[`${bank.id}:${index}`];
      if (style && position === 0) template.appearance.controls[String(index)] = clone(style);
    });
  });
  for (const item of template.inputs) {
    const style = layout.controls?.[globalStyleKey(controllerId, inputKey(item))];
    if (style) template.appearance.globals[inputKey(item)] = clone(style);
  }
  return template;
}

// Add a controller from a template. Strips need a destination; with none, only the controller,
// its global inputs and layout come in and the result says how many strips were skipped.
export function importController(draft, layout, template, { destination = null, name = null } = {}) {
  if (template?.format !== TEMPLATE_FORMAT || template.version !== TEMPLATE_VERSION) fail('That file is not a MIDIBRAIN controller template.');
  const spec = template.controller;
  if (!spec || !Number.isInteger(spec.controls_per_bank) || spec.controls_per_bank < 1 || spec.controls_per_bank > 64) fail('The template’s controls per strip are invalid.');
  if (!Array.isArray(spec.layers) || !spec.layers.length || spec.layers.length > 8) fail('The template’s input layers are invalid.');
  if (draft.setup.devices.length >= 32) fail('Up to 32 devices.');
  const target = destination ? draft.setup.devices.find(item => item.id === destination && item.kind === 'destination') || fail('Choose an existing destination device for the strips.') : null;
  const id = uniqueId(draft.setup.devices.map(item => item.id), name || template.name || spec.name);
  const controller = { id, name: (name || template.name || spec.name || 'Controller').trim().slice(0, 80), kind: 'controller', input: null, feedback_output: null,
    controls_per_bank: spec.controls_per_bank, layers: [...spec.layers] };
  if (spec.layer_mode === 'software' && spec.layer_switch) { controller.layer_mode = 'software'; controller.layer_switch = clone(spec.layer_switch); }
  draft.setup.devices.push(controller);

  let skipped = 0, created = 0;
  const strips = template.strips || [];
  if (strips.length && target) {
    for (const strip of strips) {
      if (draft.setup.banks.length >= 32) { skipped++; continue; }
      const keepsMapping = strip.destination === target.id;
      const wanted = keepsMapping ? strip.channels.filter(cid => target.channels.some(channel => channel.id === cid)) : [];
      const channels = wanted.length ? wanted : [target.channels[0].id];
      const bankId = uniqueId(draft.setup.banks.map(bank => bank.id), 'strip');
      const bank = { id: bankId, name: String(strip.name || `Strip ${created + 1}`).slice(0, 80), controller: id, destination: target.id, channels: [...channels].sort((a, b) => a - b), depth: 0, depth_overrides: {},
        controls: strip.controls.map(control => Object.fromEntries(Object.entries(control).map(([layer, binding]) => {
          const fresh = { source: binding.source ? { ...binding.source } : null, feedback: binding.feedback ? { ...binding.feedback } : null, parameter: null };
          if (binding.label) fresh.label = binding.label;
          if (keepsMapping) {
            for (const key of ['min', 'max', 'invert']) if (binding[key] !== undefined) fresh[key] = binding[key];
            if (binding.parameter && channels.every(cid => target.channels.find(channel => channel.id === cid)?.parameters[binding.parameter])) fresh.parameter = binding.parameter;
          }
          return [layer, fresh];
        }))) };
      if (target.channel_mode === 'selectable') bank.midi_channels = keepsMapping && strip.midi_channels?.length ? [...strip.midi_channels] : [1];
      draft.setup.banks.push(bank); created++;
    }
  } else skipped = strips.length;

  layout.inputs ||= {};
  layout.inputs[id] = (template.inputs || []).map(item => ({ type: item.type, channel: item.channel, number: item.number ?? null, ...(item.label ? { label: item.label } : {}) }));
  layout.controls ||= {};
  const look = template.appearance || {};
  if (look.arrangement) { layout.controllers ||= {}; layout.controllers[id] = { bankLayout: look.arrangement.bankLayout === 'columns' ? 'columns' : 'rows', columns: Number.isInteger(look.arrangement.columns) ? Math.max(1, Math.min(8, look.arrangement.columns)) : 4 }; }
  for (const bank of draft.setup.banks.filter(item => item.controller === id)) {
    for (const [index, style] of Object.entries(look.controls || {})) layout.controls[`${bank.id}:${index}`] = clone(style);
  }
  for (const [key, style] of Object.entries(look.globals || {})) layout.controls[globalStyleKey(id, key)] = clone(style);
  return { id, strips: created, skipped };
}

// A short line for the library list: what a template contains.
// Group a template list by manufacturer (built-ins and saved alike); "My templates" for saved ones without one.
export function groupByManufacturer(templates, query = '') {
  const needle = query.trim().toLowerCase(), groups = new Map();
  for (const template of templates) {
    const maker = template.manufacturer || (template.source === 'saved' ? 'My templates' : 'Other');
    if (needle && !`${maker} ${template.name} ${template.description || ''}`.toLowerCase().includes(needle)) continue;
    if (!groups.has(maker)) groups.set(maker, []);
    groups.get(maker).push(template);
  }
  const rank = maker => (maker === 'My templates' ? 0 : maker === 'Generic' ? 2 : 1);
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([maker, items]) => ({ maker, items: items.sort((x, y) => x.name.localeCompare(y.name)) }));
}

export function describeTemplate(template) {
  const strips = template.strips?.length || 0, inputs = template.inputs?.length || 0, layers = template.controller?.layers?.length || 1;
  return `${strips} strip${strips === 1 ? '' : 's'} × ${template.controller?.controls_per_bank ?? '?'} controls · ${layers} layer${layers === 1 ? '' : 's'}${inputs ? ` · ${inputs} global input${inputs === 1 ? '' : 's'}` : ''}`;
}
