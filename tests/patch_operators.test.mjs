import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/midibrain/performance/patch-model.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/patch_demo_state.json', import.meta.url)));
const fresh = () => M.normalizeDraft({ setup: M.clone(fixture.setup), performance: M.clone(fixture.performance), routing: M.clone(fixture.routing) });
const { Ops } = M;

test('remapping and removing a global knob updates all of its operator wires', () => {
  const draft = fresh(), layout = M.emptyLayout(), index = Ops.addOperator(draft, 'scale');
  const binding = { type: 'cc', channel: 3, number: 30 }, key = M.declareInput(layout, 'twister', binding);
  M.connect(draft, ['ctl:twister', key], [`op:${index}`, 'param:amount']);
  M.connect(draft, ['ctl:twister', key], [`op:${index}`, 'in']);
  const next = M.moveInput(draft, layout, 'twister', key, { type: 'cc', channel: 2, number: 40 });
  const operator = draft.performance.operators[index];
  assert.deepEqual(operator.links.amount, { controller: 'twister', channel: 2, number: 40 });
  assert.deepEqual(operator.inputs, [{ type: 'cc', controller: 'twister', channel: 2, number: 40 }]);
  const wires = M.buildGraph(draft, layout).wires.filter(wire => wire.kind === 'op');
  assert.ok(wires.every(wire => wire.from[0] === 'ctl:twister' && wire.from[1] === next));
  const before = M.clone(draft);
  assert.throws(() => M.moveInput(draft, layout, 'twister', next, { type: 'note', channel: 2, number: 40 }), /must stay a CC/);
  assert.deepEqual(draft, before);
  M.forgetInput(draft, layout, 'twister', next);
  assert.deepEqual(operator.inputs, []);
  assert.deepEqual(operator.links, {});
  assert.equal(M.buildGraph(draft, layout).wires.filter(wire => wire.kind === 'op').length, 0);
});

test('a MOD wires through a scale operator to a channel, with a knob setting the cap', () => {
  const draft = fresh(), op = Ops.addOperator(draft, 'scale');
  M.connect(draft, ['mod:1', 'out'], [`op:${op}`, 'in']);
  M.connect(draft, [`op:${op}`, 'out'], ['dev:l6', 'ch:2']);
  M.connect(draft, ['ctl:twister', M.inputKey({ type: 'cc', channel: 3, number: 30 })], [`op:${op}`, 'param:amount']);
  const saved = draft.performance.operators[op];
  assert.deepEqual(saved.inputs, [{ type: 'mod', index: 1 }]);
  assert.equal(saved.targets[0].device, 'l6');
  assert.deepEqual(saved.links.amount, { controller: 'twister', channel: 3, number: 30 });
  const graph = M.buildGraph(draft);
  const opWires = graph.wires.filter(wire => wire.kind === 'op');
  assert.deepEqual(opWires.map(wire => wire.sub).sort(), ['in', 'link', 'target']);
  assert.equal(graph.nodes.find(node => node.id === `op:${op}`).params[0].linked, true);
  for (const wire of opWires) M.disconnect(draft, wire);
  assert.deepEqual([saved.inputs.length, saved.targets.length, Object.keys(saved.links).length], [0, 0, 0]);
});

test('operators chain, refuse loops and duplicates, and follow deleted MODs', () => {
  const draft = fresh(), a = Ops.addOperator(draft, 'sum'), b = Ops.addOperator(draft, 'curve');
  M.connect(draft, ['mod:1', 'out'], [`op:${a}`, 'in']); M.connect(draft, ['mod:2', 'out'], [`op:${a}`, 'in']);
  M.connect(draft, [`op:${a}`, 'out'], [`op:${b}`, 'in']);
  assert.throws(() => M.connect(draft, [`op:${b}`, 'out'], [`op:${a}`, 'in']), /loop/);
  assert.throws(() => M.connect(draft, ['mod:1', 'out'], [`op:${a}`, 'in']), /already wired/);
  assert.throws(() => M.connect(draft, [`op:${a}`, 'out'], [`op:${a}`, 'in']), /itself/);
  M.removeMod(draft, 1);
  assert.deepEqual(draft.performance.operators[a].inputs, [{ type: 'mod', index: 1 }], 'MOD 3 shifts down to index 1');
  Ops.removeOperator(draft, a);
  assert.deepEqual(draft.performance.operators.map(op => op.kind), ['curve']);
  assert.deepEqual(draft.performance.operators[0].inputs, []);
});

test('any parameter can be driven, deleted controllers and devices are pruned, kinds can change', () => {
  const draft = fresh(), op = Ops.addOperator(draft, 'average');
  M.connect(draft, [`op:${op}`, 'out'], ['dev:l6', 'ch:7']);   // the Global channel has no Continuous parameters
  assert.ok(draft.setup.devices.find(device => device.id === 'l6').channels.find(channel => channel.id === 7).parameters[draft.performance.operators[op].targets[0].parameter].continuous);
  Ops.setKind(draft, op, 'quantize');
  assert.equal(draft.performance.operators[op].params.steps, 8);
  assert.match(draft.performance.operators[op].name, /^Quantize/);
  Ops.addInput(draft, op, { type: 'cc', controller: 'twister', channel: 2, number: 9 });
  for (const id of ['bank-1', 'bank-2', 'bank-3', 'bank-4']) M.removeStrip(draft, M.emptyLayout(), id);
  M.removeController(draft, M.emptyLayout(), 'twister'); M.removeDevice(draft, M.emptyLayout(), 'l6'); Ops.pruneOperators(draft);
  assert.deepEqual([draft.performance.operators[op].inputs.length, draft.performance.operators[op].targets.length], [0, 0]);
});

test('a strip knob that sets a MOD amount is drawn to the channels it scales', () => {
  const draft = fresh(), bank = draft.setup.banks[0];
  for (const control of bank.controls) for (const binding of Object.values(control)) if (M.BANK_MOD_PARAMETERS.includes(binding.parameter)) binding.parameter = null;
  bank.controls[2].normal.parameter = 'depth';
  const strip = M.buildGraph(draft, M.emptyLayout(), { detail: 'strip' }).wires.filter(wire => wire.kind === 'modamount' && wire.bank === bank.id);
  assert.equal(strip.length, bank.channels.length);
  assert.ok(strip.every(wire => wire.derived && wire.from[1] === `bank:${bank.id}` && wire.to[0] === 'dev:l6'));
  const control = M.buildGraph(draft, M.emptyLayout(), { detail: 'control' }).wires.filter(wire => wire.kind === 'modamount' && wire.bank === bank.id);
  assert.equal(control[0].from[1], `ctl:${bank.id}:2:normal`);
  M.disconnect(draft, control[0]);
  assert.equal(bank.controls[2].normal.parameter, null);
});

test('a strip control’s knob wires straight to an operator input or setting', () => {
  const draft = fresh(), op = Ops.addOperator(draft, 'scale'), strip = draft.setup.banks[0];
  const source = strip.controls[1].normal.source;
  M.connect(draft, ['ctl:twister', `ctl:${strip.id}:1:normal`], [`op:${op}`, 'param:amount']);
  assert.deepEqual(draft.performance.operators[op].links.amount, { controller: 'twister', channel: source.channel, number: source.cc });
  M.connect(draft, ['ctl:twister', `ctl:${strip.id}:2:normal`], [`op:${op}`, 'in']);
  assert.equal(draft.performance.operators[op].inputs[0].type, 'cc');
  assert.throws(() => M.connect(draft, ['ctl:twister', `bank:${strip.id}`], [`op:${op}`, 'param:amount']), /Per control/);
  strip.controls[3].normal.source = null;
  assert.throws(() => M.connect(draft, ['ctl:twister', `ctl:${strip.id}:3:normal`], [`op:${op}`, 'param:amount']), /no input address/);
  // The wire starts at that knob on the canvas and is solid (not derived from the strip's channels).
  const wire = M.buildGraph(draft, M.emptyLayout(), { detail: 'control' }).wires.find(item => item.id === `oplink:${op}:amount`);
  assert.deepEqual(wire.from, ['ctl:twister', `ctl:${strip.id}:1:normal`]);
  assert.ok(!wire.derived);
});

test('an operator fed by a sidechain envelope ducks volume by default, and strips show parameters without the channel', () => {
  const draft = fresh(), op = Ops.addOperator(draft, 'scale');
  assert.equal(draft.performance.mods[0].shape, 'envelope');
  M.connect(draft, ['mod:0', 'out'], [`op:${op}`, 'in']);
  M.connect(draft, [`op:${op}`, 'out'], ['dev:l6', 'ch:2']);
  assert.equal(draft.performance.operators[op].targets[0].parameter, 'volume');
  assert.equal(draft.performance.operators[op].targets[0].amount, 1);
  const wires = M.buildGraph(draft).wires.filter(wire => wire.kind === 'op');
  assert.equal(wires.find(wire => wire.sub === 'in').fromMod, 0);
  assert.equal(wires.find(wire => wire.sub === 'target').opOut, op);
  assert.equal(M.stripLabel('EQ HI LEVEL CH 12'), 'EQ HI LEVEL');
  assert.equal(M.stripLabel('Channel 3'), 'Channel 3', 'a label that is only the channel is kept');
  const device = draft.setup.devices.find(item => item.id === 'l6'); device.channels[0].parameters.low.label = 'EQ LO LEVEL CH 1';
  assert.ok(M.bankParameterChoices(device, { channels: [1] }).some(choice => choice.label === 'EQ LO LEVEL'));
});

test('an operator wired to a strip follows the strip’s channels and ducks their volume', () => {
  const draft = fresh(), op = Ops.addOperator(draft, 'scale'), strip = draft.setup.banks[0];
  M.connect(draft, ['mod:0', 'out'], [`op:${op}`, 'in']);
  M.connect(draft, [`op:${op}`, 'out'], ['ctl:twister', `reset:${strip.id}`]);
  const target = draft.performance.operators[op].targets[0];
  assert.deepEqual([target.parameter, target.banks, target.channels], ['volume', [strip.id], []]);
  assert.throws(() => M.connect(draft, [`op:${op}`, 'out'], ['ctl:twister', `reset:${strip.id}`]), /already drives/);
  const graph = M.buildGraph(draft);
  const wire = graph.wires.find(item => item.kind === 'op' && item.sub === 'target');
  assert.deepEqual(wire.to, ['ctl:twister', `reset:${strip.id}`]);
  // The destination device shows a chip on every channel the strip broadcasts to.
  const device = graph.nodes.find(node => node.id === 'dev:l6');
  for (const cid of strip.channels) assert.ok(device.channels.find(channel => channel.id === cid).uses.some(use => use.startsWith('ƒ')));
  strip.channels = [2];
  assert.ok(M.buildGraph(draft).nodes.find(node => node.id === 'dev:l6').channels.find(channel => channel.id === 2).uses.some(use => use.startsWith('ƒ')), 'follows a channel change');
  M.disconnect(draft, wire);
  assert.equal(draft.performance.operators[op].targets.length, 0);
});

test('per control wires end on the parameter chip they drive, with the right channel’s label', () => {
  const draft = fresh(), strip = draft.setup.banks[2];            // bank-3 drives channels 4 and 5
  const wires = M.buildGraph(draft, M.emptyLayout(), { detail: 'control' }).wires.filter(wire => wire.kind === 'strip' && wire.bank === strip.id);
  assert.ok(wires.length && wires.every(wire => wire.toUse));
  const device = draft.setup.devices.find(item => item.id === 'l6');
  device.channels.find(channel => channel.id === 5).parameters.low.label = 'EQ LO LEVEL CH 5';
  const again = M.buildGraph(draft, M.emptyLayout(), { detail: 'control' });
  const wire = again.wires.find(item => item.kind === 'strip' && item.bank === strip.id && item.cid === 5 && item.index === 0 && item.layer === 'normal');
  assert.equal(wire.toUse, 'EQ LO LEVEL CH 5');
  assert.ok(again.nodes.find(node => node.id === 'dev:l6').channels.find(channel => channel.id === 5).uses.includes('EQ LO LEVEL CH 5'));
});

test('on a device with a Level parameter, a sidechain operator ducks it with a negative amount and the old Volume option is hidden', () => {
  const draft = fresh();
  const channel = id => ({ id, name: `Channel ${id}`, volume: { channel: 1, cc: 7, curve: [[0, 127], [1, 0]] }, parameters: { level: { label: `LEVEL CH ${id}`, channel: 1, cc: 82 + id, min: 0, max: 127, reset: null }, pan: { label: `PAN CH ${id}`, channel: 1, cc: 72 + id, min: 0, max: 127, reset: null } } });
  const id = M.addDeviceDefinition(draft, { id: 'x', name: 'Mixer', kind: 'destination', output: 'Mixer', channels: [channel(1), channel(2)] });
  const strip = M.addStrip(draft, { controller: 'twister', destination: id, channels: [1, 2], startCc: 90, channel: 3 });
  const op = Ops.addOperator(draft, 'scale');
  M.connect(draft, ['mod:0', 'out'], [`op:${op}`, 'in']);
  M.connect(draft, [`op:${op}`, 'out'], ['ctl:twister', `reset:${strip}`]);
  const target = draft.performance.operators[op].targets[0];
  assert.deepEqual([target.parameter, target.amount, target.banks], ['level', -1, [strip]]);
  assert.ok(draft.setup.devices.find(item => item.id === id).channels[0].parameters.level.continuous);
  const device = draft.setup.devices.find(item => item.id === id);
  assert.ok(!M.modParameterChoices(device, [1, 2]).some(choice => choice.key === 'volume'), 'volume curve is not offered next to a Level parameter');
  assert.ok(M.modParameterChoices(device, [1, 2], 'volume').some(choice => choice.key === 'volume'), 'but an existing route keeps it');
  // The demo L6 has no Level parameter, so its calibrated volume remains the default there.
  const demo = fresh(), o2 = Ops.addOperator(demo, 'scale');
  M.connect(demo, ['mod:0', 'out'], [`op:${o2}`, 'in']); M.connect(demo, [`op:${o2}`, 'out'], ['ctl:twister', 'reset:bank-1']);
  assert.equal(demo.performance.operators[o2].targets[0].parameter, 'volume');
});
