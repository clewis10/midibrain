import test from 'node:test';
import assert from 'node:assert/strict';
import { clone } from '../src/midibrain/performance/surface-model.mjs';
import { projectRig, refreshRig, matchingState, liveCommand, stageModule, hasMappingEdits, definitionsMatch } from '../src/midibrain/performance/surface-runtime.mjs';

function fixture() {
  const mapping = { label: 'Low', source: { channel: 1, cc: 8 }, feedback: { channel: 2, cc: 8 }, parameter: 'low', page: 'Page 1', include_snapshot: false, include_reset: true,
    sends: [{ device: 'l6', set: 2, parameter: 'high', midi_channel: 1, min: 10, max: 100, invert: true }] };
  const bank = { id: 'strip-1', name: 'Mixer strip', controller: 'twister', destination: 'l6', channels: [1, 3], depth: .4, mod_depths: [.4, .2, .1], depth_include_reset: false, controls: [{ normal: mapping, alternate: { ...clone(mapping), parameter: 'depth', source: null } }] };
  const identity = layer => ({ controller: bank.controller, destination: bank.destination, channels: clone(bank.channels), midi_channels: null, binding: clone(bank.controls[0][layer]) });
  return { native: true, staged: false, demo: true, active: { devices: [
    { id: 'twister', name: 'Twister', kind: 'controller', input: 'Twister USB' },
    { id: 'l6', name: 'L6', kind: 'destination', output: 'L6 USB', channels: [1, 2, 3].map(index => ({ id: index, name: `Channel ${index}`, parameters: { low: { label: 'Low', channel: 1, cc: 32 + index }, high: { label: 'High', channel: 1, cc: index } } })) },
  ], banks: [bank], resets: [{ controller: 'twister', channel: 4, cc: 2 }] }, controls: ['normal', 'alternate'].map(layer => ({ bank: bank.id, index: 0, layer, identity: identity(layer), assigned: true, value: null, mixed: false })) };
}

test('active mappings project without mutating devices, feedback, MOD, sends or reset policy', () => {
  const snapshot = fixture(), before = clone(snapshot), doc = projectRig(snapshot);
  assert.deepEqual(snapshot, before);
  assert.equal(doc.modules[0].runtimeBank, 'strip-1');
  assert.equal(doc.modules[0].controls[0].bindings.alternate.parameter, 'depth');
  assert.equal(doc.modules[0].controls[0].bindings.normal.targets[0].cc, 2);
  assert.deepEqual(stageModule(doc.modules[0], snapshot).replacement, snapshot.active.banks[0]);
  assert.equal(hasMappingEdits(doc.modules[0], snapshot), false);
});

test('live commands carry the complete active identity and do not invent unknown values', () => {
  const snapshot = fixture(), current = projectRig(snapshot).modules[0].controls[0].bindings.normal;
  assert.equal(matchingState(current, snapshot).value, null);
  assert.deepEqual(liveCommand(current, snapshot), { bank: 'strip-1', index: 0, layer: 'normal', expected: snapshot.controls[0].identity });
  for (const changed of [{ ...snapshot, staged: true }, { ...snapshot, native: false }, { ...snapshot, controls: [] }]) assert.throws(() => liveCommand(current, changed), /mapping changed/);
  snapshot.controls[0].identity.binding.feedback.cc = 9;
  assert.equal(matchingState(current, snapshot), null);
});

test('strip proposals preserve all unrelated fields, sends, alternate inputs, and null inputs', () => {
  const snapshot = fixture(); snapshot.active.banks[0].depth_overrides = { '1': .1, '3': .8 };
  const doc = projectRig(snapshot), module = doc.modules[0];
  module.groups[0].destinations[0].channels = [2, 3];
  const current = module.controls[0].bindings.normal;
  current.parameter = 'high'; current.min = 20; current.source.number = 9;
  const result = stageModule(module, snapshot), original = snapshot.active.banks[0];
  assert.equal(hasMappingEdits(module, snapshot), true);
  assert.deepEqual(result.expected, original);
  assert.deepEqual(result.replacement.channels, [2, 3]);
  assert.deepEqual(result.replacement.depth_overrides, { '3': .8 });
  assert.deepEqual(result.replacement.controls[0].normal.feedback, original.controls[0].normal.feedback);
  assert.deepEqual(result.replacement.controls[0].normal.sends, original.controls[0].normal.sends);
  assert.deepEqual(result.replacement.controls[0].alternate, original.controls[0].alternate);
  assert.equal(result.replacement.controls[0].normal.include_snapshot, false);
  assert.deepEqual(result.replacement.mod_depths, original.mod_depths);
  assert.deepEqual(snapshot.active.banks[0], original);
});

test('stale or structurally changed strips cannot overwrite runtime draft mappings', () => {
  const snapshot = fixture(), module = projectRig(snapshot).modules[0];
  snapshot.active.banks[0].controls[0].normal.parameter = 'high';
  assert.throws(() => stageModule(module, snapshot), /mapping changed/);
  assert.equal(hasMappingEdits(module, snapshot), true);
  module.groups = [];
  assert.throws(() => stageModule(module, snapshot), /structure changed/);
});

test('device-address and output-port changes invalidate live workspace definitions', () => {
  const snapshot = fixture(), doc = projectRig(snapshot);
  assert.equal(definitionsMatch(doc, snapshot), true);
  snapshot.active.devices[1].channels[0].parameters.low.cc = 74;
  assert.equal(definitionsMatch(doc, snapshot), false);
  assert.equal(definitionsMatch(refreshRig(snapshot, doc), snapshot), true);
  snapshot.active.devices[1].output = 'Different port'; assert.equal(definitionsMatch(doc, snapshot), false);
});

test('refreshing mappings preserves pages, geometry, zoom, module IDs and non-runtime modules', () => {
  const snapshot = fixture(), doc = projectRig(snapshot), module = doc.modules[0];
  doc.pages = [{ id: 'custom-page', name: 'Live set' }]; doc.canvas.zoom = 75; doc.canvas.width = 1440;
  module.controls[0].centerDetent = true;
  module.kind = 'fader';
  assert.equal(hasMappingEdits(module, snapshot), false);
  module.page = 'custom-page'; module.x = 6; module.width = 4; module.height = 35; module.name = 'My mixer'; module.controls[0].bindings.normal.parameter = 'high';
  const custom = clone(module); delete custom.runtimeBank; custom.id = 'design'; custom.groups = []; custom.controls = [{ id: 'design-control', name: 'Design', bindings: { normal: { ...clone(module.controls[0].bindings.normal), group: null } } }]; custom.layersEnabled = false; custom.layers = [{ id: 'normal', name: 'Normal' }];
  doc.modules.push(custom);
  const refreshed = refreshRig(snapshot, doc), linked = refreshed.modules.find(item => item.runtimeBank);
  assert.deepEqual(refreshed.canvas, doc.canvas); assert.deepEqual(refreshed.pages, doc.pages);
  for (const key of ['id', 'page', 'x', 'width', 'height', 'name', 'kind']) assert.equal(linked[key], module[key]);
  assert.equal(linked.controls[0].id, module.controls[0].id);
  assert.equal(linked.controls[0].centerDetent, true);
  assert.equal(linked.controls[0].bindings.normal.parameter, 'low');
  assert.deepEqual(refreshed.modules.find(item => item.id === 'design'), custom);
});
