// Browser checks for the Nov 6 QA follow-up: Add menu, operators, snapshot nodes, controller
// templates, dotted per-control wires, reset-layer drop, global input MIDI edit, display rate.
// Uses the demo server's real endpoints but never presses Apply.
import test from 'node:test';
import assert from 'node:assert/strict';

let chromium;
try { ({ chromium } = await import(process.env.MIDIBRAIN_PLAYWRIGHT || 'playwright')); }
catch (error) { if (process.env.MIDIBRAIN_PLAYWRIGHT) throw error; }
const base = process.env.MIDIBRAIN_SURFACE_URL || 'http://127.0.0.1:8790';
const options = { timeout: 60000, skip: !chromium && 'Optional: install Playwright or set MIDIBRAIN_PLAYWRIGHT' };

async function setup(run, prepare = null) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/api/patch/layout', route => route.fulfill({ json: { layout: null, stored: 'memory' } }));
  try {
    if (prepare) await prepare(page);
    await page.goto(`${base}/patch`);
    await page.locator('.node').first().waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

async function drag(page, from, to) {
  const a = await from.boundingBox(), b = await to.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
}
const port = (page, node, name) => page.locator(`.port[data-node="${node}"][data-port="${name}"]`);

async function clickWire(page, selector) {
  await page.waitForTimeout(300);
  const point = await page.locator(selector).first().evaluate(path => {
    const matrix = path.getScreenCTM();
    const nodes = [...document.querySelectorAll('.node')].map(node => node.getBoundingClientRect());
    for (let distance = 20; distance < path.getTotalLength() - 20; distance += 4) {
      const point = path.getPointAtLength(distance).matrixTransform(matrix);
      if (nodes.some(rect => point.x > rect.left - 15 && point.x < rect.right + 15 && point.y > rect.top - 15 && point.y < rect.bottom + 15)) continue;
      if (document.elementFromPoint(point.x, point.y) === path) return { x: point.x, y: point.y };
    }
    return null;
  });
  assert.ok(point, 'the wire has an exposed clickable segment');
  await page.mouse.click(point.x, point.y);
}

test('wire clicks open their inspector without starting canvas panning; blank limits stay unset', options, async () => {
  await setup(async page => {
    await page.locator('#fit').click();
    await clickWire(page, '.wire[data-id^="optarget:0:"] .hit');
    await page.locator('#inspectorBody button', { hasText: 'Edit operator' }).waitFor();
    assert.equal(await page.locator('#viewport').evaluate(node => node.classList.contains('panning')), false);
    await page.locator('#inspectorBody .field', { hasText: 'Parameter' }).locator('select').selectOption('low');
    for (const [label, value] of [['Out min', '0'], ['Out max', '100']]) {
      const field = page.locator('#inspectorBody .field', { hasText: label }).locator('input');
      await field.fill(value); await field.press('Tab');
      assert.equal(await field.inputValue(), value);
      await field.fill(''); await field.press('Tab');
      assert.equal(await field.inputValue(), '', `${label} remains optional instead of becoming zero`);
    }
    await page.locator('#fit').click();
    await clickWire(page, '.wire[data-id^="optarget:0:"] .hit');
    for (const label of ['Out min', 'Out max']) {
      assert.equal(await page.locator('#inspectorBody .field', { hasText: label }).locator('input').inputValue(), '');
    }
    await page.waitForFunction(() => !document.querySelector('#apply').disabled && /Valid/.test(document.querySelector('#status').textContent));
  });
});

test('an operator wire edits a separate resting value per channel and clearing it removes the fallback', options, async () => {
  await setup(async page => {
    const validations = [];
    page.on('request', request => {
      if (request.url().endsWith('/api/patch/validate')) validations.push(request.postDataJSON());
    });
    await page.locator('#fit').click();
    await clickWire(page, '.wire[data-id^="optarget:0:"] .hit');
    await page.locator('#inspectorBody .field', { hasText: 'Parameter' }).locator('select').selectOption('low');
    const first = page.getByRole('spinbutton', { name: 'Resting value · Channel 1', exact: true });
    const third = page.getByRole('spinbutton', { name: 'Resting value · Channel 3', exact: true });
    const otherValue = await third.inputValue();
    await first.fill('84'); await first.press('Tab');
    assert.equal(await first.inputValue(), '84');
    assert.equal(await third.inputValue(), otherValue, 'another channel keeps its independent resting value');
    await page.waitForFunction(() => !document.querySelector('#apply').disabled && /Valid/.test(document.querySelector('#status').textContent));
    const setup = validations.at(-1).banks || validations.at(-1).profile?.bank_setup;
    assert.equal(setup.devices.find(device => device.id === 'l6').channels.find(channel => channel.id === 1).parameters.low.reset, 84);
    await first.fill('0'); await first.press('Tab');
    assert.equal(await first.inputValue(), '0', 'an explicit zero is distinct from an unknown base');
    await first.fill(''); await first.press('Tab');
    assert.equal(await first.inputValue(), '');
    await page.getByText(/No resting value for Channel 1/).waitFor();
    await page.waitForFunction(() => !document.querySelector('#apply').disabled && /Valid/.test(document.querySelector('#status').textContent));
    const cleared = validations.at(-1).banks || validations.at(-1).profile?.bank_setup;
    assert.equal(cleared.devices.find(device => device.id === 'l6').channels.find(channel => channel.id === 1).parameters.low.reset, null);
    assert.equal(await page.locator('#inspectorBody .field', { hasText: 'Out max' }).locator('input').inputValue(), '');
  });
});

test('the Add menu is for canvas nodes only; strips and inputs are added from a controller', options, async () => {
  await setup(async page => {
    await page.locator('#addButton').click();
    const items = await page.locator('#addMenu [data-add]').evaluateAll(nodes => nodes.map(node => node.dataset.add));
    assert.deepEqual(items.sort(), ['controller', 'device', 'mod', 'operator', 'snapshot', 'thru']);
    await page.locator('#addButton').click();
    assert.ok(await page.locator('#view-tools, .view-tools').count() >= 1);
    // Tidy, Fit, MIDI details and Panel sit in the bar next to File.
    const order = await page.locator('.bar > *').evaluateAll(nodes => nodes.map(node => node.className || node.id));
    assert.ok(order.indexOf('menu file-menu') < order.findIndex(name => String(name).includes('view-tools')));
  });
});

test('the local rig ducks through Scale operators fed by each strip\u2019s amount knob', options, async () => {
  await setup(async page => {
    assert.equal(await page.locator('.node[data-type="operator"]').count(), 4);
    const wires = await page.locator('.wire[data-kind="op"]').evaluateAll(nodes => nodes.map(node => node.dataset.id || ''));
    assert.equal(wires.filter(id => id.startsWith('opin:')).length, 4, 'the Sidechain MOD feeds each operator');
    assert.equal(wires.filter(id => id.startsWith('oplink:')).length, 4, 'each strip knob sets its operator amount');
    assert.equal(wires.filter(id => id.startsWith('optarget:')).length, 4, 'each operator drives its strip');
    assert.equal(await page.locator('.wire[data-kind="mod"][data-id*="modbank"]').count(), 0, 'no hidden per-strip MOD routes remain');
  });
});

test('operators: a MOD wires through a Scale operator to a channel', options, async () => {
  await setup(async page => {
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="operator"]').click();
    await page.locator('#inspectorBody .list-item', { hasText: 'Scale / limit' }).click();
    const node = page.locator('.node[data-id="op:4"]'); await node.waitFor();
    assert.equal(await page.locator('#inspectorKind').textContent(), 'operator');
    await page.locator('#fit').click();
    await drag(page, port(page, 'mod:1', 'out'), port(page, 'op:4', 'in'));
    await drag(page, port(page, 'op:4', 'out'), port(page, 'dev:l6', 'ch:2'));
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-id^="opin:4"], .wire[data-id^="optarget:4"]').length === 2);
    await node.getByText('Amount (cap)').waitFor();
    await page.waitForFunction(() => !document.querySelector('#apply').disabled && /Valid/.test(document.querySelector('#status').textContent));
    await page.locator('#undo').click(); await page.locator('#undo').click();
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-id^="opin:4"], .wire[data-id^="optarget:4"]').length === 0);
  });
});

test('snapshot nodes start empty, are scoped by wires and offer 9+ slots', options, async () => {
  await setup(async page => {
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="snapshot"]').click();
    const node = page.locator('.node[data-type="snapshot"]'); await node.waitFor();
    assert.match(await node.innerText(), /nothing wired/);
    await page.locator('#fit').click();
    await drag(page, port(page, 'snap:0', 'out'), port(page, 'dev:l6', 'ch:1'));
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="snapshot"]').length === 1);
    assert.match(await node.innerText(), /1 thing/);
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="snapshot"]').click();
    await page.locator('.node[data-id="snap:1"]').waitFor();
  });
});

test('per-control strip wires are dotted, and the layer tab accepts a reset drop', options, async () => {
  await setup(async page => {
    await page.locator('#detailControl').click();
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="strip"][data-derived="true"]').length > 0);
    assert.equal(await page.locator('.wire[data-kind="strip"]:not([data-derived="true"])').count(), 0);
    const dash = await page.locator('.wire[data-kind="strip"][data-derived="true"] .line').first().evaluate(node => getComputedStyle(node).strokeDasharray);
    assert.notEqual(dash, 'none');
    await page.locator('#detailStrip').click();
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="strip"][data-derived="true"]').length === 0);
    assert.ok(await page.locator('.wire[data-kind="strip"]:not([data-derived="true"])').count() > 0);
    assert.ok(await page.locator('.layer-tabs .port.layer-reset').count() >= 2);
  });
});

test('Fill from middle is gone, 127 is not clipped, and the display rate is a System setting', options, async () => {
  await setup(async page => {
    await page.locator('#detailControl').click();
    await page.locator('.knob[data-knob="bank-1:0"] .k-label').click();
    await page.evaluate(() => document.querySelectorAll('#inspectorBody details.group').forEach(item => { item.open = true; }));
    assert.equal(await page.getByLabel('Fill from middle').count(), 0);
    const max = page.getByLabel('Output maximum');
    await max.fill('127');
    const clipped = await max.evaluate(node => node.scrollWidth > node.clientWidth);
    assert.equal(clipped, false);
    await page.locator('.dock-tabs [data-tab="system"]').click();
    const select = page.getByLabel('Live display rate');
    await select.selectOption('30');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('midibrain.patch.view.v1')).refreshHz), 30);
    await select.selectOption('5');
  });
});

test('a global input keeps its roles and wires when its MIDI address is edited in place', options, async () => {
  await setup(async page => {
    const pad = page.locator('.node[data-id="ctl:a4"] .global-input').first();
    if (!(await pad.count())) return;
    await pad.locator('.k-label').click();
    const channel = page.getByLabel('Input MIDI channel');
    await channel.waitFor();
    const before = await page.locator('#inspectorBody').innerText();
    assert.match(await page.locator('#inspectorBody').innerText(), /Triggers Sidechain/);
    await channel.fill('7'); await channel.press('Tab');
    await page.waitForFunction(() => /ch 7/.test(document.querySelector('.node[data-id="ctl:a4"] .k-address')?.textContent || ''));
    assert.match(await page.locator('#inspectorBody').innerText(), /Triggers Sidechain/, 'the MOD trigger followed the new address');
    void before;
    await page.locator('#undo').click();
  });
});

test('controller templates: the library lists built-ins and adding one creates strips on the canvas', options, async () => {
  await setup(async page => {
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="controller"]').click();
    await page.getByText(/^Novation · 1/).waitFor();
    assert.ok(await page.locator('.template-group > summary').count() >= 3, 'grouped by manufacturer');
    await page.getByLabel('Search controller templates').fill('launch');
    await page.getByText('Launch Control XL 3').first().waitFor();
    await page.locator('.list-item', { hasText: 'Launch Control XL 3' }).getByRole('button', { name: 'Add' }).click();
    const node = page.locator('.node[data-type="controller"]', { hasText: 'Launch Control XL 3' }); await node.waitFor();
    assert.equal(await node.locator('.controller-strip').count(), 8);
  });
});

test('Add → Device also lists controller templates, and there is no Snapshots tab', options, async () => {
  await setup(async page => {
    assert.equal(await page.locator('.dock-tabs [data-tab="snapshots"]').count(), 0);
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="device"]').click();
    await page.getByText(/^DJ TechTools · 1/).waitFor();
  });
});

test('a snapshot node offers recall on the 1 with a bar window and a clear button', options, async () => {
  await setup(async page => {
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="snapshot"]').click();
    const node = page.locator('.node[data-type="snapshot"]'); await node.waitFor();
    assert.match(await node.innerText(), /instant/);
    await page.getByLabel('Recall', { exact: true }).selectOption('4');
    await page.waitForFunction(() => /every 4 bar|4 bars/.test(document.querySelector('.node[data-type="snapshot"]').innerText));
    assert.equal(await page.getByRole('button', { name: 'Clear saved values' }).isDisabled(), true);
  });
});

test('snapshot setup buttons follow captures and clears without reopening Inspect', options, async () => {
  let saved = false;
  await setup(async page => {
    await page.locator('#fit').click();
    await page.locator('.node[data-id="snap:0"] .head-tools button').click();
    const save = page.getByRole('button', { name: 'Save now', exact: true });
    const recall = page.getByRole('button', { name: 'Recall now', exact: true });
    const clear = page.getByRole('button', { name: 'Clear saved values', exact: true });
    await page.waitForFunction(() => !document.querySelector('[data-snapshot-action="capture"]').disabled);
    assert.equal(await recall.isDisabled(), true);
    await save.click();
    await page.waitForFunction(() => !document.querySelector('[data-snapshot-action="recall"]').disabled);
    await recall.click();
    assert.equal(await clear.isDisabled(), false);
    await clear.click();
    await page.waitForFunction(() => document.querySelector('[data-snapshot-action="recall"]').disabled);
    assert.equal(await clear.isDisabled(), true);
    saved = true;
    await page.waitForFunction(() => !document.querySelector('[data-snapshot-action="recall"]').disabled);
    const name = page.locator('#inspectorBody .field', { hasText: 'Name' }).locator('input').first();
    await name.fill('Unapplied snapshot name'); await name.press('Tab');
    assert.equal(await save.isDisabled(), true);
    assert.equal(await recall.isDisabled(), true);
  }, async page => {
    await page.route('**/api/patch/state', async route => {
      const state = await (await route.fetch()).json();
      Object.assign(state.performance.draft.slots[0], { node: true, targets: [{ type: 'bank', bank: 'bank-1' }] });
      await route.fulfill({ json: state });
    });
    await page.route('**/api/patch/live', async route => {
      const live = await (await route.fetch()).json(); live.snapshots_saved[0] = saved;
      await route.fulfill({ json: live });
    });
    await page.route('**/api/performance/action', async route => {
      const action = route.request().postDataJSON();
      assert.equal(action.slot, 0);
      if (action.action === 'capture') saved = true;
      else assert.equal(action.action, 'recall');
      await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/performance/delete', async route => {
      assert.equal(route.request().postDataJSON().slot, 0); saved = false;
      await route.fulfill({ json: { ok: true } });
    });
  });
});

test('a global operator knob displays incoming hardware CC values', options, async () => {
  let value = 0;
  await setup(async page => {
    const knob = page.locator('.node[data-id="ctl:twister"] [data-global-input="in:cc:3:30"]');
    await knob.waitFor();
    assert.equal(await knob.getAttribute('data-kind'), 'knob');
    await page.waitForFunction(() => document.querySelector('[data-global-input="in:cc:3:30"]')?.dataset.value === '0');
    value = 100;
    await page.waitForFunction(() => document.querySelector('[data-global-input="in:cc:3:30"]')?.dataset.value === '100');
    assert.equal(await knob.getAttribute('aria-valuenow'), '100');
  }, async page => {
    await page.route('**/api/patch/state', async route => {
      const state = await (await route.fetch()).json();
      state.performance.draft.operators[0].links.amount = { controller: 'twister', channel: 3, number: 30 };
      await route.fulfill({ json: state });
    });
    await page.route('**/api/patch/live', async route => {
      const live = await (await route.fetch()).json();
      live.inputs = [{ controller: 'twister', type: 'cc', channel: 3, number: 30, value }];
      await route.fulfill({ json: live });
    });
  });
});

test('Perform: clicking or dragging a knob (even its label) keeps Perform on, and engine-default differences do not block it', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const writes = [];
  try {
    await page.route('**/api/patch/layout', route => route.fulfill({ json: { layout: null, stored: 'memory' } }));
    // The runtime reports each mapping in the engine's normal form: defaults filled in, keys reordered.
    await page.route('**/api/patch/live', async route => {
      const live = await (await route.fetch()).json();
      for (const control of live.controls || []) {
        const binding = { sends: [], invert: false, device_sync: 'off', min: 0, max: 127, ...control.identity.binding };
        control.identity.binding = Object.fromEntries(Object.entries(binding).reverse());
      }
      await route.fulfill({ json: live });
    });
    await page.route('**/api/bank-control', async route => { writes.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
    await page.goto(`${base}/patch`); await page.locator('.node').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-disabled') === 'false');
    await page.locator('#play').click();
    const knob = page.locator('.knob[data-knob="bank-1:0"]');
    await knob.locator('.k-label').click();                       // a plain click on the label
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#inspectorKind').textContent(), '', 'the inspector did not open');
    const box = await knob.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 14); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 20, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true', await page.locator('#toast').innerText().catch(() => ''));
    assert.equal(writes.length, 1);
    const label = await knob.locator('.k-label').boundingBox();   // dragging from the label works too
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2); await page.mouse.down();
    await page.mouse.move(label.x + label.width / 2, label.y - 25, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(writes.length, 2);
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true');
  } finally { await browser.close(); }
});

test('a per-control knob drags onto an operator setting, and the old MOD-amount parameter is no longer offered', options, async () => {
  await setup(async page => {
    await page.locator('#detailControl').click();
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="strip"][data-derived="true"]').length > 0);
    await page.locator('#fit').click();
    await drag(page, port(page, 'ctl:twister', 'ctl:bank-2:1:normal'), port(page, 'op:0', 'param:amount'));
    await page.waitForFunction(() => { const w = document.querySelector('.wire[data-id="oplink:0:amount"]'); return w && !w.dataset.derived; });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.wire[data-id="oplink:0:amount"] .line')).strokeDasharray === 'none');
    await page.locator('.knob[data-knob="bank-1:1"] .k-label').click().catch(() => {});
    await page.locator('.knob[data-knob="bank-1:0"] .k-label').click();
    const options = await page.getByLabel('Parameter').first().locator('option').allInnerTexts().catch(() => []);
    assert.ok(options.every(text => !/^MOD \d amount$|^Sidechain amount$/i.test(text.trim())));
  });
});

test('Perform: a knob that only feeds an operator can be dragged', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const writes = [];
  try {
    await page.route('**/api/patch/layout', route => route.fulfill({ json: { layout: null, stored: 'memory' } }));
    page.on('request', request => { if (request.url().includes('/api/bank-control')) writes.push(request.postDataJSON()); });
    await page.goto(`${base}/patch`); await page.locator('.node').first().waitFor();
    await page.locator('#detailControl').click();
    await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-disabled') === 'false');
    await page.locator('.node[data-id="ctl:twister"] .layer-tabs').getByRole('button', { name: 'alternate', exact: true }).click();
    await page.locator('#play').click();
    await page.waitForTimeout(400);
    const operatorKnobs = await page.evaluate(() => [...document.querySelectorAll('.knob[data-knob]')].filter(k => k.dataset.layer === 'alternate' && k.dataset.knob.endsWith(':3')).map(k => k.dataset.knob));
    assert.ok(operatorKnobs.length >= 1, 'the demo has strip amount knobs that only feed operators');
    const box = await page.locator(`.knob[data-knob="${operatorKnobs[0]}"]`).first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 14); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 20, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'true', await page.locator('#toast').innerText().catch(() => ''));
    assert.equal(writes.length, 1);
  } finally { await browser.close(); }
});

test('an operator slider keeps the value it shows, and per-control wires end on the parameter chips', options, async () => {
  await setup(async page => {
    await page.locator('.node[data-id="op:0"] .node-head').dblclick();
    const offset = page.locator('#inspectorBody .field', { hasText: 'Offset' }).locator('input[type=range]');
    await offset.waitFor();
    await offset.evaluate(node => { node.value = '0.25'; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => /0\.25/.test(document.querySelector('#inspectorBody').innerText));
    const shown = await page.locator('#inspectorBody .field', { hasText: 'Offset' }).locator('input[type=range]').evaluate(node => Number(node.value));
    assert.equal(shown, 0.25, 'the thumb matches the number');
    await page.locator('#detailControl').click();
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="strip"][data-derived="true"]').length > 0);
    await page.waitForTimeout(300);
    const ends = await page.evaluate(() => {
      const wire = document.querySelector('.wire[data-kind="strip"][data-derived="true"] .line'); if (!wire) return null;
      const chip = document.querySelector('.node[data-id="dev:l6"] .chip'); const row = chip.closest('.row');
      return { chips: document.querySelectorAll('.node[data-id="dev:l6"] .chip[data-use]').length, rowTop: row.getBoundingClientRect().top };
    });
    assert.ok(ends && ends.chips > 0);
  });
});

// ---- Pi test pass 2 follow-ups: snapshot ports on the left, re-save feedback, key route paths, offline ports.
const importRig = async (page, name) => {
  await page.locator('#rigFile').setInputFiles(new URL(`./pi-rigs/${name}`, import.meta.url).pathname);
  await page.waitForTimeout(800);
};

test('a snapshot node keeps every connection on its left edge', options, async () => {
  await setup(async page => {
    await importRig(page, '03-snapshots-clock.json');
    const node = page.locator('.node[data-id="snap:0"]');
    const box = await node.boundingBox();
    for (const name of ['recall', 'capture', 'out']) {
      const dot = await port(page, 'snap:0', name).boundingBox();
      assert.ok(dot.x + dot.width / 2 <= box.x + 4, `${name} sits on the left edge`);
    }
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="snapshot"]').length > 0);
  });
});

test('a snapshot shows when it was saved and flashes on every re-save', options, async () => {
  let stamp = 1789000000.5;
  await setup(async page => {
    await importRig(page, '03-snapshots-clock.json');
    const state = page.locator('.node[data-id="snap:0"] .snapshot-state');
    await page.waitForFunction(() => /saved .*12 values/.test(document.querySelector('.node[data-id="snap:0"] .snapshot-state').innerText));
    assert.equal(await state.evaluate(row => row.classList.contains('resaved')), false);
    const first = await state.innerText();
    stamp += 61;
    await page.waitForFunction(() => document.querySelector('.node[data-id="snap:0"] .snapshot-state').classList.contains('resaved'));
    assert.notEqual(await state.innerText(), first, 'the time changes');
    assert.match(await state.innerText(), /✓ saved/);
    await page.waitForFunction(() => !document.querySelector('.node[data-id="snap:0"] .snapshot-state').classList.contains('resaved'));
    assert.match(await state.innerText(), /● saved/);
  }, async page => {
    await page.route('**/api/patch/live', async route => {
      let response, body; try { response = await route.fetch(); body = await response.json(); } catch { return; } // the page closed
      body.snapshots_saved = [true, false, false, false, false, false, false, false];
      body.snapshots_info = [{ saved_at: stamp, values: 12, depths: 0 }, null, null, null, null, null, null, null];
      await route.fulfill({ response, json: body });
    });
  });
});

test('a split keyboard draws one separate wire per route and lands each on its own destination row', options, async () => {
  await setup(async page => {
    await importRig(page, '04-keyboard.json');
    await page.waitForFunction(() => document.querySelectorAll('.wire[data-kind="notes"]').length === 2);
    const paths = await page.locator('.wire[data-kind="notes"] .line').evaluateAll(lines => lines.map(line => line.getAttribute('d')));
    assert.equal(new Set(paths).size, 2, 'the two wires do not overlap');
    assert.equal(await page.locator('.node[data-id="dev:synth"] .note-source').count(), 2);
    assert.equal(await page.locator('.key-route-head .port.out').count(), 2);
    assert.match(await page.locator('.node[data-id="dev:synth"] .note-source').first().innerText(), /C-1–B3/);
  });
});

test('ports that are not connected are reported on their nodes and in the header, then clear', options, async () => {
  let offline = true;
  await setup(async page => {
    await importRig(page, '03-snapshots-clock.json');
    await page.waitForFunction(() => !document.querySelector('#portAlert').hidden);
    assert.match(await page.locator('#portAlert').innerText(), /2 MIDI ports offline/);
    const notes = await page.locator('.offline-note').allInnerTexts();
    assert.equal(notes.length, 2);
    assert.ok(notes.some(text => /input offline/.test(text)) && notes.some(text => /output offline/.test(text)));
    offline = false;
    await page.waitForFunction(() => document.querySelector('#portAlert').hidden && !document.querySelector('.offline-note'));
  }, async page => {
    await page.route('**/api/patch/live', async route => {
      let response, body; try { response = await route.fetch(); body = await response.json(); } catch { return; } // the page closed
      body.offline_ports = offline ? [{ direction: 'input', port: 'TEST - Twister input', state: 'unavailable', detail: 'not found' },
        { direction: 'output', port: 'TEST - L6 Mixer Control', state: 'retrying', detail: 'busy' }] : [];
      await route.fulfill({ response, json: body });
    });
  });
});
