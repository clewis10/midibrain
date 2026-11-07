// Controller templates: export one controller node, import it again (same rig or a new one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as M from '../src/midibrain/performance/patch-model.mjs';
import * as T from '../src/midibrain/performance/patch-templates.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/patch_demo_state.json', import.meta.url)));
const fresh = () => M.normalizeDraft({ setup: M.clone(fixture.setup), performance: M.clone(fixture.performance), routing: M.clone(fixture.routing) });

test('a controller exports its shape and input addresses, and mappings only on request', () => {
  const draft = fresh(), layout = M.emptyLayout();
  const plain = T.exportController(draft, layout, 'twister');
  assert.equal(plain.format, T.TEMPLATE_FORMAT);
  assert.equal(plain.controller.controls_per_bank, 4);
  assert.equal(plain.strips.length, draft.setup.banks.filter(bank => bank.controller === 'twister').length);
  assert.equal(plain.strips[0].destination, undefined);
  assert.equal(plain.strips[0].controls[0].normal.parameter, undefined);
  assert.deepEqual(plain.strips[0].controls[0].normal.source, draft.setup.banks[0].controls[0].normal.source);
  const full = T.exportController(draft, layout, 'twister', { mappings: true });
  assert.equal(full.strips[0].destination, 'l6');
  assert.equal(full.strips[0].controls[0].normal.parameter, 'low');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(full)));
});

test('importing into another rig needs a destination, gives fresh ids, and never copies ports', () => {
  const source = fresh(), layout = M.emptyLayout();
  source.setup.devices.find(device => device.id === 'twister').input = 'Real port';
  const template = T.exportController(source, layout, 'twister');
  const target = fresh(), targetLayout = M.emptyLayout();
  const result = T.importController(target, targetLayout, template, { destination: 'l6', name: 'Twister B' });
  assert.equal(result.id, 'twister-b');
  const imported = target.setup.devices.find(device => device.id === result.id);
  assert.equal(imported.input, null);
  assert.equal(imported.kind, 'controller');
  const banks = target.setup.banks.filter(bank => bank.controller === result.id);
  assert.equal(banks.length, template.strips.length);
  assert.ok(banks.every(bank => bank.destination === 'l6' && bank.channels.length === 1 && bank.controls.every(control => Object.values(control).every(binding => binding.parameter === null))));
  assert.deepEqual(banks[1].controls[2].normal.source, template.strips[1].controls[2].normal.source);
  assert.equal(new Set(target.setup.banks.map(bank => bank.id)).size, target.setup.banks.length);
  // Importing without a destination keeps the controller and inputs and reports the skipped strips.
  const skipped = T.importController(fresh(), M.emptyLayout(), template, {});
  assert.equal(skipped.strips, 0);
  assert.equal(skipped.skipped, template.strips.length);
});

test('mappings survive a round trip onto the same destination; layout and global inputs travel along', () => {
  const draft = fresh(), layout = M.emptyLayout();
  M.declareInput(layout, 'twister', { type: 'cc', channel: 4, number: 20, label: 'Cutoff' });
  layout.controls[M.globalStyleKey('twister', 'in:cc:4:20')] = { kind: 'knob', centerDetent: true };
  layout.controllers = { twister: { bankLayout: 'columns', columns: 3 } };
  const template = T.exportController(draft, layout, 'twister', { mappings: true });
  const target = fresh(), targetLayout = M.emptyLayout();
  const { id } = T.importController(target, targetLayout, template, { destination: 'l6' });
  const first = target.setup.banks.find(bank => bank.controller === id);
  assert.equal(first.controls[0].normal.parameter, 'low');
  assert.deepEqual(first.channels, draft.setup.banks[0].channels);
  assert.deepEqual(targetLayout.inputs[id], [{ type: 'cc', channel: 4, number: 20, label: 'Cutoff' }]);
  assert.equal(targetLayout.controls[M.globalStyleKey(id, 'in:cc:4:20')].centerDetent, true);
  assert.deepEqual(targetLayout.controllers[id], { bankLayout: 'columns', columns: 3 });
});

test('bad template files are refused with a clear message', () => {
  assert.throws(() => T.importController(fresh(), M.emptyLayout(), { format: 'other' }), /not a MIDIBRAIN controller template/);
  assert.throws(() => T.importController(fresh(), M.emptyLayout(), { format: T.TEMPLATE_FORMAT, version: 1, name: 'x', controller: { controls_per_bank: 0, layers: ['normal'] } }), /controls per strip/);
  assert.throws(() => T.importController(fresh(), M.emptyLayout(), { format: T.TEMPLATE_FORMAT, version: 1, name: 'x', controller: { controls_per_bank: 2, layers: ['normal'] }, strips: [] }, { destination: 'nope' }), /existing destination/);
});
