import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGraph, autoLayout, connect, disconnect, addMod, removeMod, normalizeDraft, emptyLayout, declareInput, addRole,
  forgetInput, editableDestination, changedSections, visibleOnPage, History, inputKey, clone, controlIdentity, controlStyle, importWorkspaceStyles, playableControl, findProblems } from '../src/midibrain/performance/patch-model.mjs';
import { projectRig } from '../src/midibrain/performance/surface-runtime.mjs';
import { knobPresentation, detentValue } from '../src/midibrain/performance/surface-model.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/patch_demo_state.json', import.meta.url)));
const fresh = () => normalizeDraft({ setup: clone(fixture.setup), performance: clone(fixture.performance), routing: clone(fixture.routing) });
const wire = (graph, predicate) => graph.wires.find(predicate);

test('Workspace control appearances import only matching runtime mappings without changing either rig', () => {
  const draft = fresh(), before = clone(draft), layout = emptyLayout();
  const workspace = projectRig({ active: draft.setup, native: true, controls: [] });
  workspace.modules[0].controls[0].centerDetent = true;
  workspace.modules[1].kind = 'fader';
  workspace.modules[2].controls[0].bindings.normal.runtime.identity.destination = 'stale';
  const source = clone(workspace);
  assert.equal(importWorkspaceStyles(layout, draft, workspace), 15);
  assert.deepEqual(controlStyle(layout, 'bank-1', 0), { kind: 'knob', centerDetent: true, fillFromCenter: true });
  assert.equal(controlStyle(layout, 'bank-2', 0).kind, 'fader');
  assert.deepEqual(controlStyle(layout, 'bank-3', 0), { kind: 'knob', centerDetent: false, fillFromCenter: false });
  assert.deepEqual(workspace, source); assert.deepEqual(draft, before);
  assert.deepEqual(changedSections(before, draft), {});
  assert.equal(knobPresentation(64, true).centered, true);
  assert.equal(knobPresentation(0, true).end, 135);
  assert.equal(knobPresentation(127, true).start, 135);
  assert.equal(detentValue(62, true), 64); assert.equal(detentValue(66, true), 64);
  assert.equal(detentValue(61, true), 61); assert.equal(detentValue(62, false), 62);
});

test('playback matches the complete mapping and requires a running guarded unstaged runtime', () => {
  const draft = fresh(), bank = draft.setup.banks[0];
  const control = { bank: bank.id, index: 0, layer: 'normal', assigned: true, identity: controlIdentity(bank, 0, 'normal') };
  const live = { native: true, running: true, staged: false, instance_id: 'instance', definitions_revision: 'definitions', controls: [control] };
  assert.equal(playableControl(draft, live, bank.id, 0, 'normal'), control);
  for (const changes of [{ running: false }, { staged: true }, { native: false }, { instance_id: null }, { definitions_revision: null }, { controls: [{ ...control, assigned: false }] }]) {
    assert.equal(playableControl(draft, { ...live, ...changes }, bank.id, 0, 'normal'), null);
  }
  draft.setup.banks[0].controls[0].normal.invert = true;
  assert.equal(playableControl(draft, live, bank.id, 0, 'normal'), null);
});

test('the demo rig projects controllers, MODs, the L6 and clock as nodes', () => {
  const graph = buildGraph(fresh());
  const types = graph.nodes.map(node => node.id);
  assert.ok(types.includes('ctl:twister') && types.includes('ctl:a4') && types.includes('dev:l6') && types.includes('clock'));
  assert.equal(graph.nodes.filter(node => node.type === 'mod').length, 3);
  // Bundled strips: one wire per strip channel (bank-1 drives L6 1 + 3).
  const strips = graph.wires.filter(item => item.kind === 'strip' && item.bank === 'bank-1').map(item => item.to[1]);
  assert.deepEqual(strips, ['ch:1', 'ch:3']);
});

test('sidechain is an ordinary MOD node: A4 notes trigger it and it ducks strip volumes', () => {
  const graph = buildGraph(fresh());
  const sidechain = graph.nodes.find(node => node.id === 'mod:0');
  assert.equal(sidechain.shape, 'envelope');
  const trigger = wire(graph, item => item.kind === 'trigger' && item.mod === 0);
  assert.deepEqual(trigger.from, ['ctl:a4', 'in:note:5:*']);
  const ducks = graph.wires.filter(item => item.kind === 'mod' && item.mod === 0).map(item => item.to[1]).sort();
  assert.deepEqual(ducks, ['ch:1', 'ch:2', 'ch:3', 'ch:4', 'ch:5', 'ch:6']);
  const reset = graph.wires.filter(item => item.kind === 'action' && item.reset !== undefined);
  assert.ok(reset.some(item => item.to[1] === 'reset:bank-1'));
});

test('per-control detail draws one wire per mapped control and channel', () => {
  const graph = buildGraph(fresh(), emptyLayout(), { detail: 'control' });
  const bank1 = graph.wires.filter(item => item.kind === 'strip' && item.bank === 'bank-1');
  assert.ok(bank1.length >= 8);
  assert.ok(bank1.every(item => item.from[1].startsWith('ctl:bank-1:')));
});

test('dragging a strip to another channel adds it to the strip; removing the wire removes it', () => {
  const draft = fresh();
  connect(draft, ['ctl:twister', 'bank:bank-2'], ['dev:l6', 'ch:5']);
  assert.deepEqual(draft.setup.banks.find(bank => bank.id === 'bank-2').channels, [2, 5]);
  assert.throws(() => connect(draft, ['ctl:twister', 'bank:bank-2'], ['dev:l6', 'ch:5']), /already drives/);
  const graph = buildGraph(draft);
  disconnect(draft, wire(graph, item => item.id === 'strip:bank-2:5'));
  assert.deepEqual(draft.setup.banks.find(bank => bank.id === 'bank-2').channels, [2]);
});

test('MOD wires create unified destinations and sum on shared parameters', () => {
  const draft = fresh();
  connect(draft, ['mod:1', 'out'], ['dev:l6', 'ch:1']);
  connect(draft, ['mod:2', 'out'], ['dev:l6', 'ch:1']);
  assert.equal(draft.performance.mods[1].destinations[0].parameter, 'low');
  assert.equal(draft.performance.mods[2].destinations[0].parameter, 'low');
  // A second wire from the same MOD to the same channel picks the next parameter.
  connect(draft, ['mod:1', 'out'], ['dev:l6', 'ch:1']);
  assert.equal(draft.performance.mods[1].destinations[1].parameter, 'high');
  // Envelopes land on volume where the channel has one.
  connect(draft, ['mod:0', 'out'], ['dev:l6', 'ch:1']);
  assert.equal(draft.performance.mods[0].destinations.at(-1).parameter, 'volume');
  const graph = buildGraph(draft);
  const target = wire(graph, item => item.kind === 'mod' && item.mod === 1 && item.dest === 0);
  disconnect(draft, target);
  assert.equal(draft.performance.mods[1].destinations.length, 1);
});

test('removing a legacy sidechain bank wire migrates only that MOD and keeps other strips', () => {
  const draft = fresh();
  const graph = buildGraph(draft);
  disconnect(draft, wire(graph, item => item.kind === 'mod' && item.mod === 0 && item.bank === 'bank-2'));
  const mod = draft.performance.mods[0];
  assert.deepEqual(mod.bank_targets, []);
  assert.deepEqual(mod.destinations, [{ device: 'l6', parameter: 'volume', channels: [], banks: ['bank-1', 'bank-3', 'bank-4'], amount: 1, scale_by_bank: true }]);
  const other = fresh(), index = editableDestination(other, wire(buildGraph(other), item => item.kind === 'mod' && item.mod === 0 && item.bank === 'bank-3'));
  assert.equal(other.performance.mods[0].destinations[index].banks.length, 4);
});

test('MOD-to-MOD connections reject self-modulation and loops', () => {
  const draft = fresh();
  connect(draft, ['mod:1', 'out'], ['mod:2', 'rate']);
  assert.deepEqual(draft.performance.mods[1].mod_targets, [{ mod: 2, parameter: 'rate', amount: 0.5 }]);
  assert.throws(() => connect(draft, ['mod:2', 'out'], ['mod:1', 'amount']), /loop/);
  assert.throws(() => connect(draft, ['mod:1', 'out'], ['mod:1', 'rate']), /itself/);
  assert.throws(() => connect(draft, ['mod:1', 'out'], ['mod:2', 'trigger']), /rate, amount/);
});

test('controller inputs become trigger, MOD-control and reset action wires', () => {
  const draft = fresh(), layout = emptyLayout();
  const key = declareInput(layout, 'twister', { type: 'cc', channel: 4, number: 20 });
  connect(draft, ['ctl:twister', key], ['mod:1', 'trigger']);
  connect(draft, ['ctl:twister', key], ['ctl:twister', 'reset:bank-3']);
  const knob = declareInput(layout, 'twister', { type: 'cc', channel: 4, number: 21 });
  connect(draft, ['ctl:twister', knob], ['mod:1', 'rate']);
  assert.deepEqual(draft.performance.actions.map(action => action.action), ['mod_trigger', 'reset', 'mod_rate']);
  const note = declareInput(layout, 'a4', { type: 'note', channel: 5, number: 36 });
  connect(draft, ['ctl:a4', note], ['mod:2', 'trigger']);
  assert.deepEqual(draft.performance.mods[2].trigger, { controller: 'a4', type: 'note', channel: 5, number: 36 });
  assert.throws(() => connect(draft, ['ctl:a4', note], ['mod:2', 'rate']), /CC input/);
  assert.throws(() => connect(draft, ['ctl:twister', 'bank:bank-1'], ['mod:1', 'rate']), /free controller input/);
  const graph = buildGraph(draft, layout);
  assert.equal(graph.wires.filter(item => item.kind === 'action' && item.action !== undefined).length, 3);
  addRole(draft, 'twister', inputKey({ type: 'cc', channel: 4, number: 22 }), 'shift-toggle');
  addRole(draft, 'twister', key, 'recall:2');
  const twister = buildGraph(draft, layout).nodes.find(node => node.id === 'ctl:twister');
  assert.ok(twister.inputs.find(input => input.key === key).badges.includes('◈ Recall 3'));
  forgetInput(draft, layout, 'twister', key);
  assert.deepEqual(draft.performance.actions.map(action => action.action), ['mod_rate']);
});

test('adding and removing MODs remaps actions, MOD-to-MOD routes and bank amounts', () => {
  const draft = fresh();
  const added = addMod(draft);
  assert.equal(added, 3);
  assert.equal(draft.performance.mods[3].name, 'MOD 4');
  connect(draft, ['mod:3', 'out'], ['mod:2', 'amount']);
  draft.performance.actions.push({ controller: 'twister', type: 'cc', channel: 4, number: 30, action: 'mod_enable', mod: 3, shift: 'any', when: 'instant' });
  draft.setup.banks[0].mod_depths = [0.5, 0.2, 0.3];
  draft.setup.banks[0].controls[0].normal.parameter = 'mod_depth_3';
  removeMod(draft, 1);
  assert.equal(draft.performance.mods.length, 3);
  assert.deepEqual(draft.performance.mods[2].mod_targets, [{ mod: 1, parameter: 'amount', amount: 0.5 }]);
  assert.equal(draft.performance.actions[0].mod, 2);
  assert.deepEqual(draft.setup.banks[0].mod_depths, [0.5, 0.3, 0]);
  assert.equal(draft.setup.banks[0].controls[0].normal.parameter, 'mod_depth_2');
  assert.throws(() => removeMod(draft, 0), /sidechain/);
});

test('clock wires follow device outputs and MOD sync', () => {
  const draft = fresh();
  assert.throws(() => connect(draft, ['clock', 'out'], ['dev:l6', 'clock']), /output port|clock source/);
  draft.setup.devices.find(device => device.id === 'l6').output = 'L6:L6 Mixer Control';
  assert.throws(() => connect(draft, ['clock', 'out'], ['dev:l6', 'clock']), /clock source/);
  draft.routing.clock.source = 'Digitone II:MIDI';
  connect(draft, ['clock', 'out'], ['dev:l6', 'clock']);
  connect(draft, ['clock', 'out'], ['mod:1', 'sync']);
  assert.equal(draft.performance.mods[1].timing, 'sync');
  const graph = buildGraph(draft);
  assert.equal(graph.wires.filter(item => item.kind === 'clock').length, 2);
  assert.throws(() => connect(draft, ['clock', 'out'], ['mod:0', 'sync']), /Envelopes/);
});

test('layout, pages, history and changed-section detection', () => {
  const draft = fresh(), base = clone(draft);
  const graph = buildGraph(draft);
  const layout = autoLayout(graph, emptyLayout());
  assert.ok(graph.nodes.every(node => layout.nodes[node.id]));
  assert.ok(layout.nodes['dev:l6'].x > layout.nodes['mod:0'].x && layout.nodes['mod:0'].x > layout.nodes['ctl:twister'].x);
  layout.pages = [{ id: 'p1', name: 'MODs', nodes: ['mod:1'] }, { id: 'p2', name: 'Other', nodes: ['mod:2'] }];
  assert.equal(visibleOnPage(layout, 'p1', 'mod:1'), true);
  assert.equal(visibleOnPage(layout, 'p1', 'mod:2'), false);
  assert.equal(visibleOnPage(layout, 'p1', 'dev:l6'), true);
  assert.deepEqual(changedSections(base, draft), {});
  const history = new History();
  history.push(draft);
  connect(draft, ['mod:1', 'out'], ['dev:l6', 'ch:2']);
  assert.deepEqual(Object.keys(changedSections(base, draft)), ['performance']);
  assert.deepEqual(history.undo(draft), base);
});

test('node widths clamp, reset, and global inputs keep their own appearance', async () => {
  const M = await import('../src/midibrain/performance/patch-model.mjs');
  const layout = M.emptyLayout();
  assert.equal(M.nodeWidth(layout, 'ctl:twister'), null);
  M.setNodeWidth(layout, 'ctl:twister', 10); assert.equal(M.nodeWidth(layout, 'ctl:twister'), M.NODE_WIDTH.min);
  M.setNodeWidth(layout, 'ctl:twister', 99999); assert.equal(M.nodeWidth(layout, 'ctl:twister'), M.NODE_WIDTH.max);
  M.setNodeWidth(layout, 'ctl:twister', 412.4); assert.equal(M.nodeWidth(layout, 'ctl:twister'), 412);
  M.setNodeWidth(layout, 'ctl:twister', null); assert.equal(M.nodeWidth(layout, 'ctl:twister'), null);
  assert.equal(M.globalStyle(layout, 'twister', 'cc:4:8').kind, 'button');
  assert.equal(M.globalStyle(layout, 'twister', 'cc:4:8', true).kind, 'knob');
  layout.controls[M.globalStyleKey('twister', 'cc:4:8')] = { kind: 'fader', centerDetent: true };
  assert.deepEqual(M.globalStyle(layout, 'twister', 'cc:4:8'), { kind: 'fader', centerDetent: true, fillFromCenter: true });
  // Removing the input removes its appearance too.
  const draft = fresh(), key = inputKey({ type: 'cc', channel: 4, number: 8 });
  layout.inputs.twister = [{ type: 'cc', channel: 4, number: 8 }];
  layout.controls[M.globalStyleKey('twister', key)] = { kind: 'knob' };
  M.forgetInput(draft, layout, 'twister', key);
  assert.equal(layout.controls[M.globalStyleKey('twister', key)], undefined);
});

test('a destination without an output port is a named problem on a real rig only', () => {
  const draft = fresh();
  assert.deepEqual(findProblems(draft, { live: false }), []);
  draft.setup.devices.forEach(device => { if (device.kind === 'destination') device.output = 'Port'; if (device.kind === 'controller') device.input = 'In'; });
  assert.deepEqual(findProblems(draft, { live: true }), []);
  const device = draft.setup.devices.find(item => item.kind === 'destination'); device.output = null; device.name = 'My synth';
  const [problem] = findProblems(draft, { live: true });
  assert.equal(problem.node, `dev:${device.id}`); assert.match(problem.message, /My synth/); assert.match(problem.message, /output port/);
});

test('removing a layer-switch input returns the controller to hardware layers', () => {
  const draft = fresh(), layout = emptyLayout();
  const controller = draft.setup.devices.find(device => device.kind === 'controller');
  controller.layer_mode = 'software'; controller.layer_switch = { type: 'cc', channel: 1, number: 119, mode: 'cycle' };
  forgetInput(draft, layout, controller.id, inputKey({ type: 'cc', channel: 1, number: 119 }));
  assert.equal(controller.layer_switch, undefined); assert.equal(controller.layer_mode, 'hardware');
});

test('a keyboard note input routes to a device, splits, and cleans up with its controller or device', async () => {
  const M = await import('../src/midibrain/performance/patch-model.mjs');
  const draft = fresh(), layout = emptyLayout();
  const controller = draft.setup.devices.find(device => device.kind === 'controller'), synth = M.addDevice(draft, { name: 'Synth', output: 'Synth:MIDI', channels: 1 });
  controller.input = 'Keys:MIDI';
  const key = inputKey({ type: 'note', channel: 2, number: null });
  M.declareInput(layout, controller.id, { type: 'note', channel: 2, number: null, label: 'Keys' });
  assert.throws(() => M.connect(draft, [`ctl:${controller.id}`, inputKey({ type: 'note', channel: 2, number: 60 })], [`dev:${synth}`, 'notes']), /any note/);
  assert.throws(() => M.connect(draft, [`ctl:${controller.id}`, inputKey({ type: 'cc', channel: 2, number: 7 })], [`dev:${synth}`, 'notes']), /note input/);
  M.connect(draft, [`ctl:${controller.id}`, key], [`dev:${synth}`, 'notes']);
  assert.deepEqual(draft.routing.notes[0], { id: 'n', controller: controller.id, source: 'Keys:MIDI', channel: 2, low: 0, high: 127, port: 'Synth:MIDI', out_channel: 1, transpose: 0, scale: null, fixed_velocity: null, passthrough: true });
  assert.throws(() => M.connect(draft, [`ctl:${controller.id}`, key], [`dev:${synth}`, 'notes']), /already/);
  let graph = buildGraph(draft, layout);
  const wire = graph.wires.find(item => item.kind === 'notes');
  // A route leaves its own block in the controller and lands on its own row of the destination.
  const routeId = draft.routing.notes[wire.route].id;
  assert.deepEqual([wire.from, wire.to], [[`ctl:${controller.id}`, `keyout:${routeId}`], [`dev:${synth}`, `notes:${routeId}`]]);
  assert.deepEqual(graph.nodes.find(item => item.id === `dev:${synth}`).noteSources.map(item => item.port), [`notes:${routeId}`]);
  assert.equal(M.portKind(`dev:${synth}`, `notes:${routeId}`), 'devnoteroute');
  assert.ok(graph.nodes.find(node => node.id === `dev:${synth}`).acceptsNotes);
  assert.ok(M.controllerInputs(draft, layout, controller.id).find(entry => entry.key === key).uses.some(use => use.kind === 'notes'));
  assert.throws(() => M.splitNoteRoute(draft, 0, 0), /split point/);
  assert.equal(M.splitNoteRoute(draft, 0, 60), 1);
  assert.deepEqual(draft.routing.notes.map(route => [route.low, route.high, route.out_channel]), [[0, 59, 1], [60, 127, 2]]);
  assert.equal(M.noteName(60), 'C4');
  M.disconnect(draft, buildGraph(draft, layout).wires.find(item => item.kind === 'notes' && item.route === 1));
  assert.equal(draft.routing.notes.length, 1);
  M.removeDevice(draft, layout, synth);
  assert.equal(draft.routing.notes.length, 0);
  M.connect(draft, [`ctl:${controller.id}`, key], [`dev:${M.addDevice(draft, { name: 'Again', output: 'Again:MIDI' })}`, 'notes']);
  M.removeController(draft, layout, controller.id);
  assert.equal(draft.routing.notes.length, 0);
});

test('MODs and knobs can drive keyboard settings; links follow the route by id and are pruned with it', async () => {
  const M = await import('../src/midibrain/performance/patch-model.mjs');
  const draft = fresh(), layout = emptyLayout();
  const controller = draft.setup.devices.find(device => device.kind === 'controller'), synth = M.addDevice(draft, { name: 'Synth', output: 'Synth:MIDI' });
  controller.input = 'Keys:MIDI';
  const key = inputKey({ type: 'note', channel: 2, number: null });
  M.declareInput(layout, controller.id, { type: 'note', channel: 2, number: null });
  M.connect(draft, [`ctl:${controller.id}`, key], [`dev:${synth}`, 'notes']);
  const [route] = draft.routing.notes;
  assert.match(route.id, /^n/);
  assert.equal(M.portKind(`ctl:${controller.id}`, `key:${route.id}:transpose`), 'keyparam');
  M.connect(draft, ['mod:1', 'out'], [`ctl:${controller.id}`, `key:${route.id}:transpose`]);
  assert.deepEqual(draft.performance.mods[1].note_targets, [{ route: route.id, parameter: 'transpose', amount: 1 }]);
  assert.throws(() => M.connect(draft, ['mod:1', 'out'], [`ctl:${controller.id}`, `key:${route.id}:transpose`]), /already/);
  assert.throws(() => M.connect(draft, ['mod:1', 'out'], [`ctl:${controller.id}`, `key:${route.id}:root`]), /scale/);
  route.scale = { root: 0, mode: 'major' };
  M.connect(draft, ['mod:2', 'out'], [`ctl:${controller.id}`, `key:${route.id}:root`]);
  const knob = inputKey({ type: 'cc', channel: 4, number: 8 });
  assert.throws(() => M.connect(draft, [`ctl:${controller.id}`, key], [`ctl:${controller.id}`, `key:${route.id}:low`]), /CC input/);
  M.connect(draft, [`ctl:${controller.id}`, knob], [`ctl:${controller.id}`, `key:${route.id}:low`]);
  assert.equal(draft.performance.actions.at(-1).action, 'note_low');
  const graph = buildGraph(draft, layout);
  const keyRoutes = graph.nodes.find(node => node.id === `ctl:${controller.id}`).keyRoutes;
  assert.equal(keyRoutes[0].params.length, 10);
  assert.equal(graph.nodes.some(node => node.type === 'keys'), false);
  assert.deepEqual(graph.wires.filter(wire => wire.kind === 'notemod').map(wire => wire.to), [[`ctl:${controller.id}`, `key:${route.id}:transpose`], [`ctl:${controller.id}`, `key:${route.id}:root`]]);
  assert.ok(graph.wires.some(wire => wire.kind === 'action' && wire.to[1].startsWith('key:')));
  // A split gets its own id and starts without links; removing a route removes its links.
  const upper = M.splitNoteRoute(draft, 0, 60);
  assert.notEqual(draft.routing.notes[upper].id, route.id);
  M.disconnect(draft, buildGraph(draft, layout).wires.find(wire => wire.kind === 'notes' && wire.route === 0));
  assert.deepEqual(draft.performance.mods[1].note_targets, []);
  assert.equal(draft.performance.actions.some(action => action.action === 'note_low'), false);
  // Legacy routes without ids are given one on load.
  const legacy = normalizeDraft({ setup: draft.setup, performance: draft.performance, routing: { ...draft.routing, notes: [{ source: 'A', channel: 1, port: 'B', out_channel: 1 }] } });
  assert.ok(legacy.routing.notes[0].id);
});

test('a strip duplicates onto free CCs and the next free channels, and a knob can also move a keyboard setting', async () => {
  const M = await import('../src/midibrain/performance/patch-model.mjs');
  const draft = fresh(), layout = emptyLayout();
  const original = draft.setup.banks[0], controller = draft.setup.devices.find(device => device.id === original.controller);
  layout.controls[`${original.id}:0`] = { kind: 'fader' };
  const before = M.usedInputs(draft, controller.id).size;
  const { id, unassigned } = M.duplicateStrip(draft, layout, original.id);
  const copy = draft.setup.banks.find(bank => bank.id === id);
  assert.equal(draft.setup.banks[1].id, id, 'inserted after the original');
  assert.match(copy.name, /copy$/); assert.equal(unassigned, 0);
  assert.equal(M.usedInputs(draft, controller.id).size, before + original.controls.length * Object.keys(original.controls[0]).length);
  assert.deepEqual(copy.controls[0].normal.parameter, original.controls[0].normal.parameter);
  assert.notDeepEqual(copy.controls[0].normal.source, original.controls[0].normal.source);
  assert.deepEqual(layout.controls[`${id}:0`], { kind: 'fader' });
  const device = draft.setup.devices.find(item => item.id === original.destination);
  if (device.channel_mode !== 'selectable') {
    assert.deepEqual(copy.channels, original.channels, 'no free channel: it keeps the same ones');
    M.removeStrip(draft, layout, 'bank-4');
    const second = draft.setup.banks.find(bank => bank.id === 'bank-2');
    const moved = M.duplicateStrip(draft, layout, 'bank-2');
    assert.deepEqual(draft.setup.banks.find(bank => bank.id === moved.id).channels, [6]);
    assert.deepEqual(second.channels, [2]);
  }
  for (const slot of draft.performance.slots) assert.equal(slot.banks.includes(id), slot.banks.includes(original.id));
  assert.equal(M.duplicateStrip(draft, layout, id).id !== id, true);
  assert.match(draft.setup.banks.find(bank => bank.id !== id && /copy 2$/.test(bank.name))?.name || '', /copy 2$/);
  // Knob → keyboard setting (per-control link), pruned with the route.
  const synth = M.addDevice(draft, { name: 'Synth', output: 'Synth:MIDI' });
  const keys = draft.setup.devices.find(item => item.kind === 'controller'); keys.input = 'Keys:MIDI';
  M.declareInput(layout, keys.id, { type: 'note', channel: 3, number: null });
  M.connect(draft, [`ctl:${keys.id}`, inputKey({ type: 'note', channel: 3, number: null })], [`dev:${synth}`, 'notes']);
  const route = draft.routing.notes[0];
  assert.throws(() => M.connect(draft, [`ctl:${keys.id}`, `bank:${original.id}`], [`ctl:${keys.id}`, `key:${route.id}:low`]), /Per control/);
  M.connect(draft, [`ctl:${keys.id}`, `ctl:${original.id}:0:normal`], [`ctl:${keys.id}`, `key:${route.id}:low`]);
  assert.deepEqual(original.controls[0].normal.note_links, [{ route: route.id, parameter: 'low' }]);
  assert.throws(() => M.connect(draft, [`ctl:${keys.id}`, `ctl:${original.id}:0:normal`], [`ctl:${keys.id}`, `key:${route.id}:low`]), /already/);
  const wire = buildGraph(draft, layout, { detail: 'control' }).wires.find(item => item.kind === 'notectl');
  assert.deepEqual([wire.from[1], wire.to[1]], [`ctl:${original.id}:0:normal`, `key:${route.id}:low`]);
  const copyAgain = M.duplicateStrip(draft, layout, original.id);
  assert.equal(draft.setup.banks.find(bank => bank.id === copyAgain.id).controls[0].normal.note_links, undefined);
  M.disconnect(draft, wire); assert.equal(original.controls[0].normal.note_links, undefined);
});
