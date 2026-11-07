// Structure edits on the patch canvas: input layers, controllers, devices,
// strips, input/feedback addresses, Thru routes and cascading deletes.
// tests/test_patch_structure.py runs the same edits through the Python validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/midibrain/performance/patch-model.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/patch_demo_state.json', import.meta.url)));
const fresh = () => M.normalizeDraft({ setup: M.clone(fixture.setup), performance: M.clone(fixture.performance), routing: M.clone(fixture.routing) });
const twister = draft => draft.setup.devices.find(device => device.id === 'twister');
const bank = (draft, id = 'bank-1') => draft.setup.banks.find(item => item.id === id);

test('direct layers have independent controls and real Thru wires, not bank slots', () => {
  const draft = fresh();
  twister(draft).input = 'Twister input';
  M.addLayer(draft, 'twister', { key: 'page2', type: 'direct' });
  assert.equal(twister(draft).layer_types.page2, 'direct');
  assert.ok(draft.setup.banks.every(strip => strip.controls.every(control => !('page2' in control))));
  const index = M.addThruRoute(draft, { controller: 'twister', layer: 'page2', source: twister(draft).input, channel: 1, cc: 16, port: 'L6 DIN', toChannel: 16, toCc: 70 });
  const graph = M.buildGraph(draft);
  const wire = graph.wires.find(item => item.kind === 'thru');
  assert.deepEqual(wire.from, ['ctl:twister', `direct:${index}`]);
  assert.deepEqual(wire.to, ['thru', `route:${index}`]);
  const before = M.clone(draft.routing);
  bank(draft).channels = [2, 6]; M.setControlsPerStrip(draft, 'twister', 6);
  assert.deepEqual(draft.routing, before);
  assert.ok(bank(draft).controls.every(control => !('page2' in control)));
  M.renameLayer(draft, 'twister', 'page2', 'direct-page');
  assert.equal(draft.routing.cc[index].layer, 'direct-page');
  M.removeLayer(draft, 'twister', 'direct-page');
  assert.equal(draft.routing.cc.length, 0);
  assert.deepEqual(M.bankLayerKeys(twister(draft)), ['normal', 'alternate']);
});

test('layer routing conversion is explicit and never drops mapped controls', () => {
  const draft = fresh();
  assert.throws(() => M.setLayerType(draft, 'twister', 'normal', 'direct'), /Clear this layer/);
  M.addLayer(draft, 'twister', { key: 'empty' });
  M.setLayerType(draft, 'twister', 'empty', 'direct');
  assert.ok(bank(draft).controls.every(control => !('empty' in control)));
  M.setLayerType(draft, 'twister', 'empty', 'banked');
  assert.ok(bank(draft).controls.every(control => 'empty' in control));
  const layout = M.emptyLayout(); layout.controllers.twister = { bankLayout: 'columns', columns: 4 };
  assert.deepEqual(M.controllerLayout(layout, 'twister'), { bankLayout: 'columns', columns: 4 });
});

test('software layers can copy physical CCs while retaining distinct assignments and clash checks', () => {
  const draft = fresh(); twister(draft).layer_mode = 'software';
  const key = M.addLayer(draft, 'twister', { copyFrom: 'normal', key: 'filter' });
  assert.deepEqual(bank(draft).controls[0][key].source, bank(draft).controls[0].normal.source);
  M.setControlInput(draft, 'bank-1', 0, 'alternate', bank(draft).controls[0].normal.source);
  M.setControlFeedback(draft, 'bank-1', 0, 'alternate', bank(draft).controls[0].normal.feedback);
  assert.throws(() => M.setControlInput(draft, 'bank-1', 1, 'alternate', bank(draft).controls[0].normal.source), /already used/);
  twister(draft).initial_layer = key;
  M.renameLayer(draft, 'twister', key, 'renamed');
  assert.equal(twister(draft).initial_layer, 'renamed');
  M.removeLayer(draft, 'twister', 'renamed');
  assert.equal(twister(draft).initial_layer, 'normal');
});

test('disconnecting the last inferred reset keeps its physical input until explicitly removed', () => {
  const draft = fresh(), layout = M.emptyLayout();
  M.retainInputs(draft, layout);
  const reset = draft.setup.resets.find(item => item.bank);
  const key = M.inputKey({ type: 'cc', channel: reset.channel, number: reset.cc });
  const wire = M.buildGraph(draft, layout).wires.find(item => item.kind === 'action' && item.reset !== undefined && item.to[1] === `reset:${reset.bank}`);
  assert.ok(wire);
  M.disconnect(draft, wire);
  assert.ok(M.controllerInputs(draft, layout, reset.controller).find(input => input.key === key));
  M.forgetInput(draft, layout, reset.controller, key);
  assert.equal(M.controllerInputs(draft, layout, reset.controller).some(input => input.key === key), false);
});

test('per-control outputs derive from strip channels; extra sends stay independent', () => {
  const draft = fresh(), strip = bank(draft);
  const before = M.clone(strip.controls);
  const extra = { device: strip.destination, set: 2, midi_channel: 1, parameter: 'high' };
  strip.controls[0].normal.sends = [extra];
  strip.channels = [2, 6];
  const outputs = M.controlOutputs(draft, strip.id, 0, 'normal');
  assert.deepEqual(outputs.filter(output => output.kind === 'strip').map(output => output.cid), [2, 6]);
  assert.deepEqual(outputs.filter(output => output.kind === 'send').map(output => output.cid), [2]);
  assert.equal(strip.controls[0].normal.parameter, before[0].normal.parameter);
});

test('middle fill follows the center detent and rig imports keep complete profile fields', () => {
  const layout = M.emptyLayout(); layout.controls['bank-1:0'] = { kind: 'fader', centerDetent: false, fillFromCenter: true };
  assert.deepEqual(M.controlStyle(layout, 'bank-1', 0), { kind: 'fader', centerDetent: false, fillFromCenter: false });
  layout.controls['bank-1:1'] = { kind: 'knob', centerDetent: true };
  assert.deepEqual(M.controlStyle(layout, 'bank-1', 1), { kind: 'knob', centerDetent: true, fillFromCenter: true });
  const draft = fresh(), base = M.clone(draft); draft.profile = { version: 1, update_hz: 80, ports: { a4_input: 'Trigger' } };
  const changes = M.changedSections(base, draft);
  assert.equal(changes.profile.update_hz, 80);
  assert.deepEqual(changes.profile.bank_setup, draft.setup);
  assert.deepEqual(changes.profile.routing, draft.routing);
});

test('the legacy alternate flag reads as two layers and edits convert it to a layer list', () => {
  const draft = fresh();
  assert.deepEqual(M.controllerLayerKeys(twister(draft)), ['normal', 'alternate']);
  const graph = M.buildGraph(draft);
  assert.deepEqual(graph.nodes.find(node => node.id === 'ctl:twister').layers, ['normal', 'alternate']);
  const name = M.addLayer(draft, 'twister', { copyFrom: 'normal', channel: 9 });
  assert.equal(name, 'layer3');
  assert.deepEqual(twister(draft).layers, ['normal', 'alternate', 'layer3']);
  assert.equal('alternate' in twister(draft), false);
  const control = bank(draft).controls[0];
  assert.deepEqual(control.layer3, { source: { channel: 9, cc: 0 }, feedback: { channel: 9, cc: 0 }, parameter: null });
  assert.equal(control.normal.parameter, 'low', 'existing layers keep their mappings');
  // Every strip of the controller gets the new layer.
  for (const item of draft.setup.banks.filter(b => b.controller === 'twister')) for (const c of item.controls) assert.ok(c.layer3);
});

test('layers reject address clashes, bad names, the ninth layer and removing the last one', () => {
  const draft = fresh();
  assert.throws(() => M.addLayer(draft, 'twister', { copyFrom: 'normal', channel: 5 }), /already used/);
  assert.deepEqual(draft, fresh(), 'a failed add leaves the draft untouched');
  assert.throws(() => M.addLayer(fresh(), 'twister', { key: 'bad name' }), /letters, numbers/);
  assert.throws(() => M.addLayer(fresh(), 'twister', { key: 'normal' }), /already exists/);
  const full = fresh();
  while (M.controllerLayerKeys(twister(full)).length < M.MAX_LAYERS) M.addLayer(full, 'twister');
  assert.throws(() => M.addLayer(full, 'twister'), /up to 8/);
  const single = fresh();
  M.removeLayer(single, 'twister', 'alternate');
  assert.deepEqual(twister(single).layers, ['normal']);
  assert.equal('alternate' in bank(single).controls[0], false);
  assert.throws(() => M.removeLayer(single, 'twister', 'normal'), /at least one/);
});

test('renaming a layer renames it in every control and keeps order and mappings', () => {
  const draft = fresh();
  M.renameLayer(draft, 'twister', 'alternate', 'shift');
  assert.deepEqual(twister(draft).layers, ['normal', 'shift']);
  assert.deepEqual(Object.keys(bank(draft).controls[0]), ['normal', 'shift']);
  assert.equal(bank(draft).controls[0].shift.parameter, 'mid');
  assert.throws(() => M.renameLayer(draft, 'twister', 'shift', 'normal'), /already exists/);
  const usage = M.layerUsage(draft, 'twister', 'shift');
  assert.equal(usage.total, 16); assert.equal(usage.inputs, 16); assert.equal(usage.mapped, 12);
});

test('input addresses: clashes are rejected and mirrored feedback follows the input', () => {
  const draft = fresh();
  assert.throws(() => M.setControlInput(draft, 'bank-1', 0, 'normal', { channel: 1, cc: 4 }), /already used by Bank 1/);
  assert.throws(() => M.setControlInput(draft, 'bank-1', 0, 'normal', { channel: 4, cc: 9 }), /reset button/);
  M.setControlInput(draft, 'bank-1', 0, 'normal', { channel: 2, cc: 40 });
  const binding = bank(draft).controls[0].normal;
  assert.deepEqual(binding.source, { channel: 2, cc: 40 });
  assert.deepEqual(binding.feedback, { channel: 2, cc: 40 }, 'feedback mirrored the old input, so it follows');
  M.setControlFeedback(draft, 'bank-1', 0, 'normal', { channel: 3, cc: 41 });
  M.setControlInput(draft, 'bank-1', 0, 'normal', { channel: 2, cc: 42 });
  assert.deepEqual(binding.feedback, { channel: 3, cc: 41 }, 'a custom feedback address stays');
  assert.throws(() => M.setControlFeedback(draft, 'bank-1', 0, 'normal', { channel: 1, cc: 4 }), /already used/);
  M.setControlFeedback(draft, 'bank-1', 0, 'normal', null);
  assert.equal(binding.feedback, null);
  M.setControlInput(draft, 'bank-1', 0, 'normal', null);
  assert.equal(binding.source, null);
});

test('controlOutputs lists the concrete MIDI address of every strip channel and send', () => {
  const draft = fresh();
  const outputs = M.controlOutputs(draft, 'bank-1', 0, 'normal');
  assert.deepEqual(outputs.map(item => [item.channelName, item.label, item.midi]), [['Channel 1', 'Low', 1], ['Channel 3', 'Low', 1]]);
  assert.notEqual(outputs[0].cc, outputs[1].cc);
  bank(draft).controls[0].normal.sends = [{ device: 'l6', set: 2, parameter: 'high', midi_channel: 1, min: 10, max: 90 }];
  const send = M.controlOutputs(draft, 'bank-1', 0, 'normal').at(-1);
  assert.equal(send.kind, 'send'); assert.equal(send.min, 10); assert.equal(send.max, 90);
});

test('new controllers, devices and strips get unique ids and consecutive inputs', () => {
  const draft = fresh();
  const controller = M.addController(draft, { name: 'Launch Control', controls: 8, layers: 2, feedback_output: 'LCXL:out' });
  assert.equal(controller, 'launch-control');
  assert.equal(M.addController(draft, { name: 'Launch Control' }), 'launch-control-2');
  const device = M.addDevice(draft, { name: 'Synth', channels: 2, firstChannel: 3, ccStart: 70, ccCount: 4 });
  const synth = draft.setup.devices.find(item => item.id === device);
  assert.deepEqual(synth.channels.map(c => Object.values(c.parameters).map(p => [p.channel, p.cc])), [[[3, 70], [3, 71], [3, 72], [3, 73]], [[4, 70], [4, 71], [4, 72], [4, 73]]]);
  const strip = M.addStrip(draft, { controller, destination: device, channels: [1, 2], startCc: 13, channel: 1 });
  const created = draft.setup.banks.find(item => item.id === strip);
  assert.equal(created.controls.length, 8);
  assert.deepEqual(created.controls.map(c => c.normal.source.cc), [13, 14, 15, 16, 17, 18, 19, 20]);
  assert.deepEqual(created.controls[0].normal.feedback, { channel: 1, cc: 13 }, 'feedback follows when the controller has a feedback port');
  assert.equal(created.controls[0].alternate.source, null);
  assert.throws(() => M.addStrip(draft, { controller, destination: device, startCc: 15, channel: 1 }), /already used/);
  assert.throws(() => M.addStrip(draft, { controller, destination: device, startCc: 115, channel: 2 }), /past CC 119/);
  const graph = M.buildGraph(draft);
  assert.ok(graph.nodes.some(node => node.id === `ctl:${controller}`));
  assert.ok(graph.wires.some(wire => wire.kind === 'strip' && wire.bank === strip));
});

test('controls per strip grows and shrinks every strip of a controller', () => {
  const draft = fresh();
  M.setControlsPerStrip(draft, 'twister', 6);
  assert.equal(bank(draft).controls.length, 6);
  assert.deepEqual(bank(draft).controls[5], { normal: { source: null, feedback: null, parameter: null }, alternate: { source: null, feedback: null, parameter: null } });
  M.setControlsPerStrip(draft, 'twister', 2);
  assert.equal(bank(draft, 'bank-4').controls.length, 2);
  assert.equal(twister(draft).controls_per_bank, 2);
});

test('deleting a strip removes its resets, actions, snapshot scopes and MOD routes', () => {
  const draft = fresh(), layout = M.emptyLayout();
  layout.controls['bank-2:0'] = { kind: 'fader' };
  draft.performance.actions.push({ controller: 'twister', type: 'cc', channel: 4, number: 30, action: 'reset', bank: 'bank-2', shift: 'any', when: 'instant' });
  draft.performance.slots[0].banks = ['bank-1', 'bank-2'];
  draft.performance.mods[1].destinations.push({ device: 'l6', parameter: 'low', channels: [], banks: ['bank-2'], amount: 0.5, scale_by_bank: true });
  M.removeStrip(draft, layout, 'bank-2');
  assert.equal(draft.setup.banks.some(item => item.id === 'bank-2'), false);
  assert.equal(draft.setup.resets.some(reset => reset.bank === 'bank-2'), false);
  assert.equal(draft.performance.actions.length, 0);
  assert.deepEqual(draft.performance.slots[0].banks, ['bank-1']);
  assert.equal(draft.performance.mods[1].destinations.length, 0);
  assert.equal(draft.performance.mods[0].bank_targets.some(target => target.bank === 'bank-2'), false);
  assert.equal(layout.controls['bank-2:0'], undefined);
});

test('deleting a controller cascades; deleting a device that strips still drive is refused', () => {
  const draft = fresh(), layout = M.emptyLayout();
  draft.performance.shift = { controller: 'twister', type: 'cc', channel: 4, number: 20, mode: 'momentary' };
  draft.performance.actions.push({ controller: 'twister', type: 'cc', channel: 4, number: 21, action: 'panic', shift: 'on', when: 'instant' });
  draft.performance.actions.push({ controller: 'a4', type: 'note', channel: 5, number: 40, action: 'panic', shift: 'on', when: 'instant' });
  M.removeController(draft, layout, 'twister');
  assert.equal(draft.setup.banks.length, 0);
  assert.equal(draft.setup.resets.length, 0);
  assert.equal(draft.performance.shift, null);
  assert.deepEqual(draft.performance.actions.map(a => [a.controller, a.shift]), [['a4', 'any']], 'other controllers keep their actions, without a Shift that no longer exists');
  assert.throws(() => M.removeDevice(fresh(), layout, 'l6'), /driven by Bank 1/);
  const spare = fresh();
  const synth = M.addDevice(spare, { name: 'Spare' });
  bank(spare).controls[0].normal.sends = [{ device: synth, set: 1, parameter: 'cc1', midi_channel: 1 }];
  M.removeDevice(spare, layout, synth);
  assert.deepEqual(bank(spare).controls[0].normal.sends, []);
});

test('Thru routes merge destinations under one source and refuse loops back to the source', () => {
  const draft = fresh();
  const first = M.addThruRoute(draft, { source: 'In A', channel: 1, cc: 10, port: 'Out B', toChannel: 2, toCc: 20 });
  const second = M.addThruRoute(draft, { source: 'In A', channel: 1, cc: 10, port: 'Out C', toChannel: 2, toCc: 20 });
  assert.equal(first, second);
  assert.equal(draft.routing.cc[0].destinations.length, 2);
  assert.throws(() => M.addThruRoute(draft, { source: 'In A', channel: 1, cc: 10, port: 'Out C', toChannel: 2, toCc: 20 }), /already exists/);
  assert.throws(() => M.addThruRoute(draft, { source: 'X', channel: 1, cc: 1, port: 'X', toChannel: 1, toCc: 1 }), /return to its source/);
  assert.equal(M.buildGraph(draft).nodes.some(node => node.id === 'thru'), true);
});

test('feedback channel choices are dropped when the channel leaves the strip', () => {
  const draft = fresh();
  bank(draft).controls[0].normal.feedback_from = 3;
  const wire = M.buildGraph(draft).wires.find(item => item.kind === 'strip' && item.bank === 'bank-1' && item.cid === 3);
  M.disconnect(draft, wire);
  assert.equal('feedback_from' in bank(draft).controls[0].normal, false);
});

test('graph exposes feedback, sync and two-way devices', () => {
  const draft = fresh();
  draft.setup.devices.find(device => device.id === 'l6').input = 'L6:L6 Mixer Control';
  bank(draft).controls[0].normal.device_sync = 'track';
  const graph = M.buildGraph(draft);
  const knob = graph.nodes.find(node => node.id === 'ctl:twister').sections[0].knobs[0].layers.normal;
  assert.equal(knob.feedback, 'ch1 cc0'); assert.equal(knob.sync, 'track');
  const device = graph.nodes.find(node => node.id === 'dev:l6');
  assert.equal(device.input, 'L6:L6 Mixer Control'); assert.equal(device.twoWay, true);
});

test('retargeting a strip to a selectable-channel device gives it a MIDI channel', () => {
  const draft = fresh();
  const synth = M.addDevice(draft, { name: 'Tracks', channels: 2 });
  draft.setup.devices.find(item => item.id === synth).channel_mode = 'selectable';
  const strip = draft.setup.banks.find(item => item.id === 'bank-4');
  strip.channels = [];
  M.connect(draft, ['ctl:twister', 'bank:bank-4'], [`dev:${synth}`, 'ch:1']);
  assert.equal(strip.destination, synth);
  assert.deepEqual(strip.midi_channels, [1]);
});

test('strip parameters survive a channel change and are offered with a warning, never silently cleared', () => {
  const draft = fresh(), strip = bank(draft), device = draft.setup.devices.find(item => item.id === 'l6');
  strip.channels = [1, 7];                       // channel 7 is the L6 Global channel: none of the strip's parameters exist there
  assert.equal(strip.controls[0].normal.parameter, 'low');
  const gaps = M.bankParameterGaps(device, strip);
  assert.ok(gaps.some(gap => gap.key === 'low' && gap.missing.includes('Global')));
  const choices = M.bankParameterChoices(device, strip, ['low']);
  assert.ok(choices.some(choice => choice.key === 'low' && !choice.ok), 'the current choice stays visible, flagged');
  assert.ok(M.findProblems(draft).some(problem => /not available on Global/.test(problem.message)));
  strip.channels = [2];
  assert.deepEqual(M.bankParameterGaps(device, strip), []);
  assert.ok(M.bankParameterChoices(device, strip).every(choice => choice.ok));
});

test('duplicating a strip follows the destination: new logical channel on a fixed device, new MIDI channel on a selectable one', () => {
  const draft = fresh();
  const free = M.addStrip(draft, { controller: 'twister', destination: 'l6', channels: [2], startCc: 40, channel: 3 });
  draft.setup.banks.find(item => item.id === free).depth_overrides = { 2: 0.4 };
  draft.performance.mods[0].bank_targets.push({ bank: free, parameter: 'volume' });
  const fixed = M.duplicateStrip(draft, M.emptyLayout(), free);
  assert.equal(fixed.placed, 'logical-channel');
  assert.equal(fixed.mods, 1, 'the sidechain route follows the copy');
  const copy = draft.setup.banks.find(item => item.id === fixed.id);
  assert.notDeepEqual(copy.channels, [2]);
  assert.deepEqual(copy.depth_overrides, { [copy.channels[0]]: 0.4 });
  assert.ok(draft.performance.mods[0].bank_targets.some(target => target.bank === copy.id));

  const synth = M.addDevice(draft, { name: 'Digi', output: 'Digi', channels: 1, ccStart: 70, ccCount: 4 });
  draft.setup.devices.find(item => item.id === synth).channel_mode = 'selectable';
  const strip = M.addStrip(draft, { controller: 'twister', destination: synth, channels: [1], startCc: 60, channel: 3 });
  assert.deepEqual(draft.setup.banks.find(item => item.id === strip).midi_channels, [1]);
  const next = M.duplicateStrip(draft, M.emptyLayout(), strip);
  assert.equal(next.placed, 'midi-channel');
  const second = draft.setup.banks.find(item => item.id === next.id);
  assert.deepEqual(second.midi_channels, [2]);
  assert.deepEqual(second.channels, [1], 'same logical channel, so the same CCs');
  assert.equal(M.duplicateStrip(draft, M.emptyLayout(), strip).placed, 'midi-channel');
  assert.deepEqual(draft.setup.banks.filter(item => item.destination === synth).map(item => item.midi_channels[0]).sort((a, b) => a - b), [1, 2, 3]);
});

test('a global input changes its MIDI address in place and keeps everything that used it', () => {
  const draft = fresh(), layout = M.emptyLayout();
  const key = M.declareInput(layout, 'twister', { type: 'cc', channel: 3, number: 30, label: 'Kick' });
  draft.performance.actions.push({ controller: 'twister', type: 'cc', channel: 3, number: 30, action: 'mod_trigger', mod: 1, shift: 'any', when: 'instant' });
  layout.controls[M.globalStyleKey('twister', key)] = { kind: 'knob', centerDetent: true };
  const moved = M.moveInput(draft, layout, 'twister', key, { type: 'cc', channel: 4, number: 31 });
  assert.equal(moved, 'in:cc:4:31');
  assert.deepEqual([draft.performance.actions.at(-1).channel, draft.performance.actions.at(-1).number], [4, 31]);
  assert.deepEqual(layout.inputs.twister.at(-1), { type: 'cc', channel: 4, number: 31, label: 'Kick' });
  assert.equal(layout.controls[M.globalStyleKey('twister', moved)].centerDetent, true);
  assert.equal(layout.controls[M.globalStyleKey('twister', key)], undefined);
  assert.throws(() => M.moveInput(draft, layout, 'twister', moved, { type: 'cc', channel: 1, number: 0 }), /already used/);
  assert.throws(() => M.moveInput(draft, layout, 'twister', moved, { type: 'cc', channel: 17, number: 1 }), /channel must be 1/);
});

test('a reset only moves parameters that have a reset value, and the coverage says which', () => {
  const draft = fresh(), strip = bank(draft), device = draft.setup.devices.find(item => item.id === 'l6');
  strip.controls[3].normal.parameter = 'pan';
  let { covered, missing } = M.resetCoverage(device, strip);
  assert.ok(missing.some(entry => entry.key === 'pan'));
  assert.ok(covered.some(entry => entry.key === 'low'));
  M.setParameterReset(draft, 'l6', strip.channels, 'pan', 64);
  ({ missing } = M.resetCoverage(device, strip));
  assert.ok(!missing.some(entry => entry.key === 'pan'));
  assert.throws(() => M.setParameterReset(draft, 'l6', strip.channels, 'pan', 300), /0–127/);
});

test('a running rig that only differs by engine defaults is still playable; real differences are named', () => {
  const draft = fresh(), strip = bank(draft);
  const live = M.controlIdentity(strip, 0, 'normal');
  // The engine fills defaults and may order keys differently; a saved draft can omit them.
  const engine = { ...live, binding: { ...live.binding, sends: [], min: 0, max: 127, invert: false, device_sync: 'off', feedback_from: null } };
  engine.binding = Object.fromEntries(Object.entries(engine.binding).reverse());
  assert.equal(M.sameIdentity(engine, live), true);
  assert.deepEqual(M.identityDifference(engine, live), []);
  const moved = { ...engine, binding: { ...engine.binding, parameter: 'high' } };
  assert.equal(M.sameIdentity(moved, live), false);
  assert.deepEqual(M.identityDifference(moved, live), ['binding.parameter']);
  assert.equal(M.sameIdentity({ ...engine, channels: [9] }, live), false);
  const snapshot = { native: true, running: true, staged: false, instance_id: 'i', definitions_revision: 'r', active_layers: {},
    controls: [{ bank: strip.id, index: 0, layer: 'normal', assigned: true, value: 10, identity: engine }] };
  assert.ok(M.playableControl(draft, snapshot, strip.id, 0, 'normal'), 'defaults do not block Perform');
  snapshot.controls[0].identity = moved;
  assert.equal(M.playableControl(draft, snapshot, strip.id, 0, 'normal'), null);
});

test('catalogue-style parameters (cc1 on channel 1, cc2 on channel 2) are matched by label when a strip spans channels', () => {
  const draft = fresh();
  const channel = (id, ccs) => ({ id, name: `Channel ${id}`, volume: null, parameters: Object.fromEntries(Object.entries(ccs).map(([label, cc]) => [`cc${cc}`, { label: `${label} CH ${id}`, channel: 1, cc, min: 0, max: 127, reset: 64, continuous: true }])) });
  const id = M.addDeviceDefinition(draft, { id: 'x', name: 'Catalogue mixer', kind: 'destination', output: 'Mixer', channels: [channel(1, { 'EQ HI LEVEL': 1, 'EQ MID LEVEL': 21 }), channel(2, { 'EQ HI LEVEL': 2, 'EQ MID LEVEL': 22 })] });
  const strip = M.addStrip(draft, { controller: 'twister', destination: id, channels: [1], startCc: 90, channel: 3 });
  const stripRef = draft.setup.banks.find(item => item.id === strip);
  stripRef.controls[0].normal.parameter = 'cc1';
  draft.performance.mods[1].destinations.push({ device: id, parameter: 'cc21', channels: [1], banks: [], amount: .5, scale_by_bank: false });
  assert.ok(M.bankParameterGaps(draft.setup.devices.find(item => item.id === id), Object.assign(M.clone(stripRef), { channels: [1, 2] })).length);
  M.connect(draft, [`ctl:twister`, `bank:${strip}`], [`dev:${id}`, 'ch:2']);   // add channel 2 to the strip
  assert.deepEqual(stripRef.channels, [1, 2]);
  assert.equal(stripRef.controls[0].normal.parameter, 'eq_hi_level');
  const device = draft.setup.devices.find(item => item.id === id);
  assert.deepEqual(Object.keys(device.channels[1].parameters), ['eq_hi_level', 'eq_mid_level']);
  assert.deepEqual(M.bankParameterGaps(device, stripRef), []);
  assert.equal(draft.performance.mods[1].destinations.at(-1).parameter, 'eq_mid_level', 'MOD routes follow the rename');
  assert.equal(device.channels[1].parameters.eq_hi_level.cc, 2, 'each channel keeps its own CC');
  assert.equal(M.alignDeviceParameters(draft, id), 0, 'aligning again changes nothing');
});

test('a knob that feeds an operator shows that instead of a bare dash', () => {
  const draft = fresh(), op = M.Ops.addOperator(draft, 'scale');
  draft.setup.banks[0].controls[1].normal.parameter = null;
  M.connect(draft, ['ctl:twister', `ctl:bank-1:1:normal`], [`op:${op}`, 'param:amount']);
  const knob = M.buildGraph(draft, M.emptyLayout(), { detail: 'control' }).nodes.find(node => node.id === 'ctl:twister').sections[0].knobs[1].layers.normal;
  assert.match(knob.label, /^ƒ /);
});
