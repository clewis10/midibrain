import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/midibrain/performance/patch-model.mjs';
import * as S from '../src/midibrain/performance/patch-snapshots.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/patch_demo_state.json', import.meta.url)));
const fresh = () => M.normalizeDraft({ setup: M.clone(fixture.setup), performance: M.clone(fixture.performance), routing: M.clone(fixture.routing) });

test('a rig starts with no snapshot nodes; the eight stored slots fill first, then slots append', () => {
  const draft = fresh();
  assert.equal(M.buildGraph(draft).nodes.filter(node => node.type === 'snapshot').length, 0);
  const index = S.addSnapshot(draft);
  assert.equal(index, 0);
  assert.equal(draft.performance.slots.length, 8);
  assert.equal(S.addSnapshot(draft, { saved: [true, true, false] }), 2, 'a slot that holds saved values is not reused');
  for (let i = 0; i < 6; i++) S.addSnapshot(draft);
  assert.equal(S.addSnapshot(draft), 8);
  assert.equal(draft.performance.slots.length, 9);
  const node = M.buildGraph(draft).nodes.find(item => item.type === 'snapshot');
  assert.equal(node.sub, 'nothing wired');
});

test('wiring a snapshot to a strip, a channel and everything sets its scope; wires delete cleanly', () => {
  const draft = fresh(), slot = S.addSnapshot(draft);
  M.connect(draft, [`snap:${slot}`, 'out'], ['ctl:twister', 'reset:bank-1']);
  M.connect(draft, [`snap:${slot}`, 'out'], ['dev:l6', 'ch:2']);
  assert.deepEqual(draft.performance.slots[slot].targets, [{ type: 'bank', bank: 'bank-1' }, { type: 'channel', device: 'l6', channel: 2 }]);
  assert.throws(() => M.connect(draft, [`snap:${slot}`, 'out'], ['dev:l6', 'ch:2']), /already stores/);
  const graph = M.buildGraph(draft);
  const scope = graph.wires.filter(wire => wire.kind === 'snapshot');
  assert.equal(scope.length, 2);
  M.disconnect(draft, scope[0]);
  assert.equal(draft.performance.slots[slot].targets.length, 1);
  S.addTarget(draft, slot, { type: 'all' });
  assert.deepEqual(draft.performance.slots[slot].targets, [{ type: 'all' }]);
  assert.equal(M.buildGraph(draft).nodes.find(node => node.id === `snap:${slot}`).everything, true);
});

test('a controller button wires to Recall and Save and the wire shows on the canvas', () => {
  const draft = fresh(), slot = S.addSnapshot(draft);
  const layout = M.emptyLayout(); M.declareInput(layout, 'twister', { type: 'cc', channel: 16, number: 40, label: 'Recall pad' });
  M.connect(draft, ['ctl:twister', M.inputKey({ type: 'cc', channel: 16, number: 40 })], [`snap:${slot}`, 'recall']);
  const action = draft.performance.actions.at(-1);
  assert.deepEqual([action.action, action.slot], ['recall', slot]);
  const wire = M.buildGraph(draft, layout).wires.find(item => item.to[0] === `snap:${slot}`);
  assert.equal(wire.kind, 'action');
  assert.match(wire.label, /recall/);
});

test('removing a snapshot frees its actions and trims unused extra slots, never shifting the rest', () => {
  const draft = fresh(); for (let i = 0; i < 8; i++) S.addSnapshot(draft);
  const a = S.addSnapshot(draft), b = S.addSnapshot(draft);
  M.connect(draft, ['ctl:twister', M.inputKey({ type: 'cc', channel: 16, number: 41 })], [`snap:${a}`, 'capture']);
  S.removeSnapshot(draft, a);
  assert.equal(draft.performance.actions.some(action => action.slot === a), false);
  assert.equal(draft.performance.slots.length, b + 1, 'slot b keeps its index');
  S.removeSnapshot(draft, b);
  assert.equal(draft.performance.slots.length, 8);
  assert.equal(S.addSnapshot(draft), 8);
});

test('deleting a strip or device drops snapshot scope that pointed at it', () => {
  const draft = fresh(), slot = S.addSnapshot(draft);
  S.addTarget(draft, slot, { type: 'bank', bank: 'bank-1' }); S.addTarget(draft, slot, { type: 'device', device: 'l6' });
  M.removeStrip(draft, M.emptyLayout(), 'bank-1'); S.pruneSnapshotTargets(draft);
  assert.deepEqual(draft.performance.slots[slot].targets, [{ type: 'device', device: 'l6' }]);
  for (const id of ['bank-2', 'bank-3', 'bank-4']) M.removeStrip(draft, M.emptyLayout(), id);
  M.removeDevice(draft, M.emptyLayout(), 'l6'); S.pruneSnapshotTargets(draft);
  assert.deepEqual(draft.performance.slots[slot].targets, []);
  for (let i = 0; i < 40; i++) { try { S.addSnapshot(draft); } catch (error) { assert.match(error.message, /Up to 32/); return; } }
  assert.fail('expected a 32 snapshot limit');
});
