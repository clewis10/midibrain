import test from 'node:test';
import assert from 'node:assert/strict';
import { History, addController, addModule, demoWorkspace, duplicateModule, repeatMapping, configureAssignments, enableLayers, addInputVariant, conflicts, resolveTargets, normalizeDevices, outputValue, moduleHeight, nextSource, validate, migrateWorkspace, clone, uid, knobPresentation, detentValue } from '../src/midibrain/performance/surface-model.mjs';

test('center-detent arcs fill from exact MIDI center in either direction', () => {
  assert.deepEqual(knobPresentation(64, true), { angle: 0, start: 135, end: 135, centered: true });
  assert.deepEqual(knobPresentation(0, true), { angle: -135, start: 0, end: 135, centered: false });
  assert.deepEqual(knobPresentation(127, true), { angle: 135, start: 135, end: 270, centered: false });
  for (let value = 0; value <= 127; value++) {
    const display = knobPresentation(value, true);
    assert.ok(display.start <= display.end);
    assert.ok(value < 64 ? display.end === 135 : display.start === 135);
    assert.equal(knobPresentation(value).start, 0);
  }
});

test('pointer detents snap locally without changing MIDI ranges or persisted mappings', () => {
  for (const value of [62, 63, 64, 65, 66]) assert.equal(detentValue(value, true), 64);
  assert.equal(detentValue(61, true), 61); assert.equal(detentValue(67, true), 67);
  assert.equal(detentValue(63, false), 63);
  const { doc, control } = example(); control.centerDetent = true; validate(doc);
  assert.equal(migrateWorkspace(clone(doc)).modules[0].controls[0].centerDetent, true);
  control.centerDetent = 'yes'; assert.throws(() => validate(doc), /Center detent/);
});

const definitions = normalizeDevices([
  { id: 'l6', name: 'Zoom L6', kind: 'destination', output: 'Mixer Control', channels: Array.from({ length: 6 }, (_, index) => ({
    id: index + 1, name: `Channel ${index + 1}`, parameters: {
      low: { label: 'Low', channel: 1, cc: 33 + index, min: 10, max: 110 },
      mid: { label: 'Mid', channel: 1, cc: 21 + index },
      high: { label: 'High', channel: 1, cc: 1 + index },
      aux1: { label: 'Aux 1', channel: 1, cc: 43 + index },
      aux2: { label: 'Aux 2', channel: 1, cc: 53 + index },
      efx: { label: 'FX', channel: 1, cc: 63 + index },
    },
  })) },
  { id: 'synth', name: 'Synth', kind: 'destination', channel_mode: 'selectable', output: 'Synth USB', channels: [{ id: 'voice', name: 'Voice', parameters: { low: { label: 'Cutoff', channel: 2, cc: 74 }, cutoff: { label: 'Cutoff', channel: 2, cc: 74 } } }] },
]);

function example() {
  const doc = demoWorkspace(definitions), module = doc.modules[0];
  return { doc, module, control: module.controls[0], group: module.groups[0], controller: doc.controllers[0] };
}

test('all controllers and modules share one canvas, without controller pages', () => {
  const { doc } = example(); validate(doc);
  assert.equal(doc.controllers.length, 2); assert.equal(doc.modules.length, 3);
  assert.ok(doc.controllers.every(controller => !('pages' in controller)));
  assert.equal(conflicts(doc).size, 0);
});

test('fixed logical channels resolve exact CCs on their definition MIDI channel', () => {
  const { doc, module, control } = example();
  const { targets, missing } = resolveTargets(doc, module, control);
  assert.deepEqual(targets.map(target => [target.channel, target.cc]), [[1, 33], [1, 35]]);
  assert.deepEqual(missing, []);
});

test('changing a shared set changes every row and alternate without copying mappings', () => {
  const { doc, module, group } = example(); group.destinations[0].channels = [2, 6];
  assert.deepEqual(resolveTargets(doc, module, module.controls[0]).targets.map(target => target.cc), [34, 38]);
  assert.deepEqual(resolveTargets(doc, module, module.controls[8]).targets.map(target => target.cc), [44, 48]);
  assert.deepEqual(resolveTargets(doc, module, module.controls[0], 'alternate').targets.map(target => target.cc), [22, 26]);
  assert.equal(resolveTargets(doc, module, module.controls[1]).targets.length, 1);
});

test('selectable definitions expand parameter sets over explicit MIDI channel selections', () => {
  const { doc, module, control, group } = example();
  group.destinations = [{ id: uid(), device: 'synth', channels: ['voice'], midiChannels: [3, 9] }];
  const result = resolveTargets(doc, module, control);
  assert.deepEqual(result.targets.map(target => [target.channel, target.cc]), [[3, 74], [9, 74]]);
  assert.equal(result.targets[0].logicalChannel, 'Voice'); validate(doc);
});

test('a set can broadcast one parameter to multiple different device definitions', () => {
  const { doc, module, control, group } = example();
  group.destinations.push({ id: uid(), device: 'synth', channels: ['voice'], midiChannels: [4] });
  const result = resolveTargets(doc, module, control);
  assert.equal(result.targets.length, 3); assert.equal(result.targets[2].device, 'Synth');
  assert.equal(result.targets[2].cc, 74); validate(doc);
});

test('parameter ranges intersect definition limits and inversion is applied', () => {
  const { doc, module, control } = example();
  Object.assign(control.bindings.normal, { min: 20, max: 100, invert: true });
  const target = resolveTargets(doc, module, control).targets[0];
  assert.equal(target.min, 20); assert.equal(target.max, 100);
  assert.equal(outputValue(0, target), 100); assert.equal(outputValue(127, target), 20);
  control.bindings.normal.min = 120; control.bindings.normal.max = 127;
  const result = resolveTargets(doc, module, control);
  assert.equal(result.targets.length, 0); assert.match(result.missing[0], /does not overlap/);
});

test('missing parameters and empty selectable MIDI selections are explicit, not fake outputs', () => {
  const { doc, module, control, group } = example();
  control.bindings.normal.parameter = 'not_a_parameter';
  assert.equal(resolveTargets(doc, module, control).targets.length, 0);
  assert.equal(resolveTargets(doc, module, control).missing.length, 2);
  control.bindings.normal.parameter = 'low';
  group.destinations = [{ id: uid(), device: 'synth', channels: ['voice'], midiChannels: [] }];
  assert.match(resolveTargets(doc, module, control).missing[0], /select an output MIDI channel/);
});

test('inherited JavaScript property names do not resolve as device parameters', () => {
  const { doc, module, control } = example();
  for (const key of ['toString', 'constructor', '__proto__']) {
    control.bindings.normal.parameter = key;
    const result = resolveTargets(doc, module, control);
    assert.equal(result.targets.length, 0); assert.equal(result.missing.length, 2);
  }
});

test('duplicate destination expansions are deduplicated', () => {
  const { doc, module, control, group } = example();
  group.destinations.push({ ...clone(group.destinations[0]), id: uid() });
  assert.equal(resolveTargets(doc, module, control).targets.length, 2);
});

test('definitions sharing an output port deduplicate by actual MIDI address', () => {
  const { doc, module, control, group } = example();
  doc.devices.push({ ...clone(doc.devices[0]), id: 'alias', name: 'Mixer alias' });
  group.destinations.push({ id: uid(), device: 'alias', channels: [1, 3], midiChannels: [] });
  assert.equal(resolveTargets(doc, module, control).targets.length, 2); validate(doc);
});

test('a parameter unavailable on one channel reports a partial assignment explicitly', () => {
  const { doc, module, control } = example();
  delete doc.devices[0].channels[2].parameters.low;
  const result = resolveTargets(doc, module, control);
  assert.equal(result.targets.length, 1); assert.equal(result.targets[0].cc, 33);
  assert.match(result.missing[0], /Channel 3: low unavailable/); validate(doc);
});

test('input variants have independent sources, parameters, and preview values', () => {
  const { doc, module, control } = example();
  assert.equal(control.bindings.normal.source.channel, 1); assert.equal(control.bindings.alternate.source.channel, 5);
  assert.equal(control.bindings.normal.parameter, 'low'); assert.equal(control.bindings.alternate.parameter, 'mid');
  control.bindings.alternate.value = 100; assert.equal(control.bindings.normal.value, 64);
  const before = clone(control.bindings.alternate);
  enableLayers(doc, module, false);
  assert.equal(resolveTargets(doc, module, control, 'alternate').targets.length, 0);
  enableLayers(doc, module, true);
  assert.deepEqual(control.bindings.alternate, before); validate(doc);
});

test('enabling variants allocates distinct addresses without inventing switch messages', () => {
  const { doc } = example(); const module = doc.modules[1];
  enableLayers(doc, module, true);
  assert.equal(module.layers.length, 2); assert.equal(conflicts(doc).size, 0);
  assert.ok(module.controls.every(control => control.bindings.alternate.parameter === null));
});

test('modules support eight explicit input variants and reject a ninth atomically', () => {
  const history = new History(example().doc);
  for (let index = 3; index <= 8; index++) history.apply(doc => addInputVariant(doc, doc.modules[0]));
  assert.equal(history.doc.modules[0].layers.length, 8); assert.equal(conflicts(history.doc).size, 0);
  const before = clone(history.doc);
  assert.throws(() => history.apply(doc => addInputVariant(doc, doc.modules[0])), /at most 8/);
  assert.deepEqual(history.doc, before);
});

test('identical source addresses across enabled variants warn even when visually separate', () => {
  const { doc, module, control } = example();
  control.bindings.alternate.source = clone(control.bindings.normal.source);
  assert.ok(conflicts(doc).has(`${control.id}:normal`)); assert.ok(conflicts(doc).has(`${control.id}:alternate`));
  enableLayers(doc, module, false); assert.equal(conflicts(doc).size, 0);
});

test('source isolation follows controller input identity, not canvas position or visibility', () => {
  const { doc, module, control, controller } = example();
  const other = doc.modules[1].controls[0]; other.bindings.normal.source = clone(control.bindings.normal.source);
  assert.equal(conflicts(doc).size, 0);
  doc.controllers[1].input = controller.input = 'Same port'; controller.collapsed = true;
  assert.ok(conflicts(doc).has(`${control.id}:normal`));
  doc.controllers[1].input = 'Other port'; assert.equal(conflicts(doc).size, 0);
  assert.equal(module.controller, controller.id);
});

test('repeat row copies parameter/range but preserves input identity and each strip assignment', () => {
  const { doc, module, control } = example();
  const before = clone(module.controls); control.bindings.normal.parameter = 'efx'; control.bindings.normal.max = 90;
  repeatMapping(module, control.id, 'row');
  module.controls.slice(0, 4).forEach((item, index) => {
    assert.equal(item.bindings.normal.parameter, 'efx'); assert.equal(item.bindings.normal.max, 90);
    assert.equal(item.bindings.normal.group, before[index].bindings.normal.group);
    assert.deepEqual(item.bindings.normal.source, before[index].bindings.normal.source);
    assert.deepEqual(item.bindings.alternate, before[index].bindings.alternate);
  });
  assert.deepEqual(module.controls.slice(4), before.slice(4)); validate(doc);
});

test('repeat column and whole-module operations do not affect other input variants', () => {
  const { module, control } = example();
  control.bindings.alternate.parameter = 'aux1'; repeatMapping(module, control.id, 'column', 'alternate');
  assert.ok([0, 4, 8, 12].every(index => module.controls[index].bindings.alternate.parameter === 'aux1'));
  assert.equal(module.controls[1].bindings.alternate.parameter, 'mid');
  repeatMapping(module, control.id, 'all', 'alternate');
  assert.ok(module.controls.every(item => item.bindings.alternate.parameter === 'aux1'));
  assert.equal(control.bindings.normal.parameter, 'low');
});

test('changing visual columns alone does not change assignment membership', () => {
  const { doc, module } = example(); const before = module.controls.map(control => control.bindings.normal.group);
  module.columns = 2; validate(doc);
  assert.deepEqual(module.controls.map(control => control.bindings.normal.group), before);
  configureAssignments(module, 'module'); assert.equal(module.groups.length, 1);
  assert.ok(module.controls.every(control => control.bindings.normal.group === module.groups[0].id)); validate(doc);
});

test('duplicate modules preserve semantics but own all IDs, groups, and fresh input variants', () => {
  const { doc, module, control } = example(); const copy = duplicateModule(doc, module);
  validate(doc); assert.equal(conflicts(doc).size, 0);
  assert.notEqual(copy.id, module.id); assert.notEqual(copy.groups[0].id, module.groups[0].id);
  assert.equal(copy.controls[0].bindings.normal.group, copy.groups[0].id);
  assert.deepEqual(resolveTargets(doc, copy, copy.controls[0]).targets, resolveTargets(doc, module, control).targets);
  copy.groups[0].destinations[0].channels = [6]; assert.deepEqual(module.groups[0].destinations[0].channels, [1, 3]);
});

for (const kind of ['knob', 'fader', 'button']) test(`adding ${kind} modules keeps controller addresses independent`, () => {
  const { doc, controller } = example(); const module = addModule(doc, controller.id, kind, 4, 2);
  assert.equal(module.controls.length, 8); assert.equal(module.groups.length, 4); assert.equal(conflicts(doc).size, 0); validate(doc);
});

test('module collapse affects geometry only, not resolved bindings', () => {
  const { doc, module, control } = example(); const before = resolveTargets(doc, module, control);
  assert.ok(moduleHeight(module) > 4); module.collapsed = true; assert.equal(moduleHeight(module), 4);
  assert.deepEqual(resolveTargets(doc, module, control), before);
});

test('v1 workspaces flatten controllers/pages while preserving direct routing and IDs', () => {
  const target = { id: 'target', device: 'Old synth', parameter: 'Cutoff', channel: 4, cc: 74, min: 12, max: 100, invert: true };
  const old = { version: 1, name: 'Old rig', surfaces: [{ id: 'controller', name: 'Twister', input: 'USB', color: 'mint', pages: [
    { id: 'page', name: 'First', modules: [{ id: 'module', name: 'Encoders', kind: 'knob', color: 'mint', x: 0, y: 0, width: 6, columns: 1, controls: [{ id: 'control', name: 'Cutoff', value: 42, source: { type: 'cc', channel: 2, number: 8 }, targets: [target] }] }] },
    { id: 'page-2', name: 'Second', modules: [] },
  ] }] };
  const doc = migrateWorkspace(old), module = doc.modules[0];
  assert.equal(doc.version, 3); assert.equal(doc.controllers[0].id, 'controller'); assert.equal(module.name, 'First / Encoders');
  assert.equal(module.controls[0].bindings.normal.value, 42); assert.deepEqual(resolveTargets(doc, module, module.controls[0]).targets, [target]);
  assert.equal(old.version, 1); assert.deepEqual(migrateWorkspace(doc), doc);
});

test('history operations validate atomically, isolate edits, and support undo/redo', () => {
  const { doc } = example(); const history = new History(doc);
  history.apply(candidate => { candidate.modules[0].groups[0].destinations[0].channels = [2, 6]; });
  history.undo(); assert.deepEqual(history.doc.modules[0].groups[0].destinations[0].channels, [1, 3]);
  history.redo(); assert.deepEqual(history.doc.modules[0].groups[0].destinations[0].channels, [2, 6]);
  const before = clone(history.doc);
  assert.throws(() => history.apply(candidate => { candidate.modules[0].groups[0].destinations[0].channels = [100]; }));
  assert.deepEqual(history.doc, before); assert.deepEqual(doc.modules[0].groups[0].destinations[0].channels, [1, 3]);
});

test('new edits clear redo while no-ops do not pollute history', () => {
  const history = new History(example().doc);
  history.apply(doc => { doc.name = 'First'; }); history.apply(() => {}); assert.equal(history.past.length, 1);
  history.undo(); history.apply(doc => { doc.name = 'Second'; }); assert.equal(history.redo(), false);
});

test('workspace exports preserve definitions, multi-device groups and disabled variant bindings', () => {
  const { doc, module } = example(); enableLayers(doc, module, false);
  assert.deepEqual(validate(JSON.parse(JSON.stringify(doc))), doc);
});

for (const [name, change] of [
  ['bad version', doc => { doc.version = 4; }],
  ['no controllers', doc => { doc.controllers = []; }],
  ['duplicate IDs', doc => { doc.modules[0].id = doc.controllers[0].id; }],
  ['missing controller', doc => { doc.modules[0].controller = 'missing'; }],
  ['missing device', doc => { doc.modules[0].groups[0].destinations[0].device = 'missing'; }],
  ['missing logical channel', doc => { doc.modules[0].groups[0].destinations[0].channels = [100]; }],
  ['duplicate logical channels', doc => { doc.modules[0].groups[0].destinations[0].channels = [1, 1]; }],
  ['fractional input', doc => { doc.modules[0].controls[0].bindings.normal.source.number = 2.5; }],
  ['bad range', doc => { doc.modules[0].controls[0].bindings.normal.min = 128; }],
  ['bad geometry', doc => { doc.modules[0].x = 9; }],
  ['missing binding', doc => { delete doc.modules[0].controls[0].bindings.alternate; }],
  ['missing assignment', doc => { doc.modules[0].controls[0].bindings.normal.group = 'missing'; }],
  ['bad layer toggle', doc => { doc.modules[0].layersEnabled = 'true'; }],
]) test(`validation rejects ${name}`, () => { const { doc } = example(); change(doc); assert.throws(() => validate(doc)); });

test('new controllers can be empty without losing the shared workspace', () => {
  const { doc } = example(); addController(doc, 'DIY'); validate(doc); assert.equal(doc.modules.length, 3);
});

test('pages are optional views and do not change channel sets, input collisions or routing', () => {
  const { doc, module, control } = example(), before = resolveTargets(doc, module, control);
  doc.pages = [{ id: 'set-a', name: 'Set A' }, { id: 'set-b', name: 'Set B' }]; module.page = 'set-a';
  validate(doc); assert.deepEqual(resolveTargets(doc, module, control), before);
  module.page = 'missing'; assert.throws(() => validate(doc), /page is missing/);
});

test('v2 migrates atomically to explicit canvas dimensions and keeps its old data untouched', () => {
  const { doc } = example(); doc.version = 2; delete doc.canvas; delete doc.pages; doc.modules.forEach(module => delete module.page);
  const before = clone(doc), migrated = migrateWorkspace(doc);
  assert.deepEqual(doc, before); assert.equal(migrated.version, 3); assert.equal(migrated.canvas.width, 1200); assert.equal(migrated.canvas.zoom, 100);
  assert.deepEqual(migrated.pages, []); assert.ok(migrated.modules.every(module => module.page === null));
});

test('visibility and geometry edits preserve legacy dimensions for round trips', () => {
  const { doc, module } = example(), history = new History(doc), size = clone(doc.canvas);
  history.apply(candidate => { candidate.modules[0].collapsed = true; candidate.controllers[0].collapsed = true; });
  assert.deepEqual(history.doc.canvas, size);
  module.y = 100; validate(doc); assert.deepEqual(doc.canvas, size);
  for (const [key, value] of [['width', 500], ['height', 20000], ['zoom', 0], ['scale', 'auto']]) {
    const candidate = clone(doc); candidate.canvas[key] = value; assert.throws(() => validate(candidate));
  }
});

test('module height supports resize, compact controls, collapse and validation', () => {
  const { doc, module } = example(), natural = moduleHeight(module), compact = moduleHeight(module, false);
  assert.ok(compact < natural);
  module.height = natural + 5; validate(doc); assert.equal(moduleHeight(module), natural + 5);
  assert.equal(moduleHeight(module, false), natural + 5);
  module.collapsed = true; assert.equal(moduleHeight(module), 4);
  module.collapsed = false; module.height = 4; assert.equal(moduleHeight(module), natural);
  module.height = 961; assert.throws(() => validate(doc), /Module height/);
});

test('next address allocator reserves disabled variants and moves to another MIDI channel', () => {
  const { doc, controller } = example(); doc.modules = [];
  const module = addModule(doc, controller.id, 'knob', 8, 8);
  enableLayers(doc, module, true); enableLayers(doc, module, false);
  assert.deepEqual(nextSource(doc, controller.id), { type: 'cc', channel: 2, number: 8 });
});
