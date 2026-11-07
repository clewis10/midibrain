import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRig } from '../src/midibrain/performance/surface-runtime.mjs';

let chromium;
try { ({ chromium } = await import(process.env.MIDIBRAIN_PLAYWRIGHT || 'playwright')); }
catch (error) { if (process.env.MIDIBRAIN_PLAYWRIGHT) throw error; }
const base = process.env.MIDIBRAIN_SURFACE_URL || 'http://127.0.0.1:8790';
const options = { timeout: 60000, skip: !chromium && 'Optional: install Playwright or set MIDIBRAIN_PLAYWRIGHT' };

async function setup(run, prepare = () => {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = await (await fetch(`${base}/api/patch/state`)).json();
  const live = await (await fetch(`${base}/api/patch/live`)).json();
  const fixture = { state, live, layout: null, writes: [], errors: [] };
  page.on('pageerror', error => fixture.errors.push(error.message));
  await page.route('**/api/patch/state', route => route.fulfill({ json: fixture.state }));
  await page.route('**/api/patch/live', route => route.fulfill({ json: fixture.live }));
  await page.route('**/api/patch/layout', async route => {
    if (route.request().method() === 'POST') fixture.layout = route.request().postDataJSON();
    await route.fulfill({ json: { layout: fixture.layout, stored: 'memory' } });
  });
  await page.route('**/api/bank-control', async route => {
    const command = route.request().postDataJSON(); fixture.writes.push(command);
    const control = fixture.live.controls.find(item => item.bank === command.bank && item.index === command.index && item.layer === command.layer);
    control.value = command.value;
    await route.fulfill({ json: { ok: true } });
  });
  try {
    await prepare(page, fixture);
    await page.goto(`${base}/patch`);
    await page.locator('.node').first().waitFor();
    await performReady(page);
    await run(page, fixture);
    assert.deepEqual(fixture.errors, []);
  } catch (error) {
    console.error(JSON.stringify({ writes: fixture.writes, errors: fixture.errors, ui: await page.locator('#inspectorBody').innerText(), play: await page.locator('#play').getAttribute('aria-pressed'), knob: await firstControl(page).getAttribute('data-value') }));
    throw error;
  } finally { await browser.close(); }
}

// Perform stays clickable when unavailable (it explains why), so readiness is aria-disabled.
const performReady = page => page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-disabled') === 'false');
const performBlocked = async page => (await page.locator('#play').getAttribute('aria-disabled')) === 'true';

async function play(page) {
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-pressed') === 'true');
}

const firstControl = page => page.locator('.knob[data-knob="bank-1:0"]');

// Inspector sections fold (some start closed); open them all before reaching in.
async function expandSections(page) { await page.evaluate(() => document.querySelectorAll('#inspectorBody details.group').forEach(item => { item.open = true; })); }

test('Init patch clears only the draft and Undo restores the graph', options, async () => {
  await setup(async (page, fixture) => {
    const initial = await page.locator('.node').count();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#rigButton').click();
    await page.locator('#initPatch').click();
    await page.waitForFunction(() => document.querySelectorAll('.node').length === 1);
    assert.equal(await page.locator('.node').count(), 1);
    assert.equal(await page.locator('.node').getAttribute('data-id'), 'clock');
    assert.deepEqual(fixture.writes, []);
    await page.locator('#undo').click();
    assert.equal(await page.locator('.node').count(), initial);
    assert.equal(await page.locator('a[href="/workspace"]').count(), 0);
  });
});

test('MIDI details is a switch with destination addresses and middle fill is separate from snapping', options, async () => {
  await setup(async page => {
    const toggle = page.getByRole('switch', { name: 'MIDI details', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    assert.equal(await page.locator('.midi-addresses').first().isVisible(), true);
    assert.match(await page.locator('.midi-addresses').first().innerText(), /OUT ch 1 · CC/);
    await firstControl(page).locator('.k-label').click();
    await expandSections(page);
    assert.equal(await page.getByLabel('Fill from middle', { exact: true }).count(), 0);
    await page.getByLabel('Center detent', { exact: true }).check();
    assert.equal(await firstControl(page).getAttribute('data-detent'), 'true');
    assert.equal(await firstControl(page).getAttribute('data-fill-center'), 'true');
    await page.getByLabel('Display', { exact: true }).selectOption('fader');
    assert.equal(await firstControl(page).getAttribute('data-kind'), 'fader');
    assert.equal(await firstControl(page).locator('.mini-fader').isVisible(), true);
  });
});

test('Page 2 is a direct knob layer with real Thru wires and guarded playback', options, async () => {
  await setup(async (page, fixture) => {
    const writes = [];
    await page.route('**/api/patch/thru-control', async route => {
      const command = route.request().postDataJSON(); writes.push(command);
      fixture.live.direct_controls.find(control => control.index === command.index).value = command.value;
      await route.fulfill({ json: { ok: true } });
    });
    const controller = page.locator('.node[data-id="ctl:twister"]');
    await controller.locator('[data-layer-tab="twister:page2"]').click();
    assert.equal(await controller.locator('.direct-control').count(), 16);
    assert.equal(await controller.locator('.bank-head').count(), 0);
    await page.locator('#wires .wire[data-kind="thru"]').first().waitFor();
    assert.equal(await page.locator('#wires .wire[data-kind="thru"]').count(), 16);
    const knob = controller.locator('.direct-control').first();
    await knob.focus(); await knob.press('ArrowUp');
    assert.equal(writes.length, 0, 'Edit does not send MIDI');
    await knob.locator('.k-label').click();
    assert.equal(await page.getByLabel('From channel', { exact: true }).inputValue(), '1');
    assert.equal(await page.getByLabel('From CC', { exact: true }).inputValue(), '16');
    assert.equal(await page.getByLabel('To channel', { exact: true }).inputValue(), '16');
    assert.equal(await page.getByLabel('To CC', { exact: true }).inputValue(), '70');
    await play(page); await knob.focus(); await knob.press('End');
    await page.waitForFunction(() => document.querySelector('.direct-control .k-value')?.textContent === '127');
    assert.equal(writes.length, 1); assert.equal(writes[0].expected.destinations[0].channel, 16);
    await controller.locator('[data-layer-tab="twister:normal"]').click();
    assert.equal(await controller.locator('.bank-head').count(), 4);
    // Wires of every layer stay drawn by default; “this layer only” hides Page 2's while normal shows.
    assert.equal(await page.locator('#wires .wire[data-kind="thru"]').count(), 16);
    await page.locator('#filtersButton').click(); await page.getByLabel('Wires from all layers').uncheck(); await page.locator('#filtersButton').click();
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="thru"]').length === 0);
  });
});

test('controller banks can be columns without changing MIDI mappings', options, async () => {
  await setup(async (page, fixture) => {
    const controller = page.locator('.node[data-id="ctl:twister"]');
    await controller.locator('.node-head').click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/patch/layout') && response.request().method() === 'POST');
    await expandSections(page);
    await page.getByLabel('Bank arrangement', { exact: true }).selectOption('columns');
    await saved;
    assert.equal(await controller.getAttribute('data-bank-layout'), 'columns');
    const heads = controller.locator('.bank-head');
    const first = await heads.nth(0).boundingBox(), second = await heads.nth(1).boundingBox();
    assert.ok(second.x > first.x + 20); assert.ok(Math.abs(second.y - first.y) < 2);
    await page.waitForFunction(() => document.querySelector('#apply').disabled);
    assert.equal(fixture.layout.controllers.twister.bankLayout, 'columns');
    assert.equal(await controller.locator('.controller-strip').count(), 4);
    await controller.locator('[data-layer-tab="twister:page2"]').click();
    assert.equal(await controller.locator('.direct-control').count(), 16);
  });
});

test('reset inputs are playable pads and survive removal of their last role', options, async () => {
  await setup(async (page, fixture) => {
    const writes = [];
    await page.route('**/api/patch/input', async route => { writes.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
    const pad = page.getByRole('button', { name: 'Press CC 11 · ch 4', exact: true });
    assert.equal(await pad.count(), 1);
    await pad.click();
    assert.equal(writes.length, 0, 'Edit is silent');
    await play(page);
    await pad.click();
    await page.waitForTimeout(100);
    assert.deepEqual(writes.map(write => write.value), [127, 0]);
    assert.equal(writes[0].runtime_instance, fixture.live.instance_id);
    await page.locator('#modeEdit').click();
    await pad.click();
    await page.locator('#inspectorBody .list-item').filter({ hasText: 'Reset Bank 3' }).locator('button.danger').click();
    assert.equal(await pad.count(), 1);
    assert.match(await page.locator('#inspectorBody').innerText(), /Unused/);
  });
});

test('rig export includes full configuration and importing stages it without live MIDI', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('#rigButton').click();
    const downloaded = page.waitForEvent('download');
    await page.locator('#exportRig').click();
    const stream = await (await downloaded).createReadStream();
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    const bundle = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(bundle.format, 'midibrain-rig');
    assert.equal(bundle.profile.routing.cc.length, 16);
    assert.ok(bundle.profile.sidechain);
    assert.ok(bundle.profile.ports);
    assert.equal(bundle.layout.version, 1);
    bundle.profile.update_hz = 80;
    bundle.profile.bank_setup.banks[0].name = 'Imported strip';
    await page.locator('#rigFile').setInputFiles({ name: 'round-trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    await page.waitForFunction(() => !document.querySelector('#apply').disabled);
    assert.match(await page.locator('.node[data-id="ctl:twister"]').innerText(), /Imported strip/);
    assert.equal(fixture.writes.length, 0);
    await page.locator('#undo').click();
    assert.equal(await page.locator('#apply').isDisabled(), true);
  });
});

test('software-layer tabs switch the engine only in Perform and follow runtime changes', options, async () => {
  await setup(async (page, fixture) => {
    const writes = [];
    await page.route('**/api/patch/layer', async route => {
      const command = route.request().postDataJSON(); writes.push(command);
      fixture.live.active_layers = { twister: command.layer };
      await route.fulfill({ json: { ok: true, active_layers: fixture.live.active_layers } });
    });
    const tabs = page.locator('.node[data-id="ctl:twister"] .layer-tabs');
    await tabs.getByRole('button', { name: 'alternate', exact: true }).click();
    assert.equal(writes.length, 0);
    await play(page);
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.layer === 'normal');
    await tabs.getByRole('button', { name: 'alternate', exact: true }).click();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].layer, 'alternate');
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.layer === 'alternate');
    assert.equal(await firstControl(page).getAttribute('data-layer'), 'alternate');
    fixture.live.active_layers = { twister: 'normal' };
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.layer === 'normal');
  }, async (_page, fixture) => {
    for (const setup of [fixture.state.banks.active, fixture.state.banks.draft]) setup.devices.find(device => device.id === 'twister').layer_mode = 'software';
    fixture.live.active_layers = { twister: 'normal' };
  });
});

test('held layer-switch pads release even when a runtime layer change rebuilds the node', options, async () => {
  await setup(async (page, fixture) => {
    const writes = [];
    await page.route('**/api/patch/input', async route => {
      const command = route.request().postDataJSON(); writes.push(command);
      fixture.live.active_layers = { twister: command.value ? 'alternate' : 'normal' };
      await route.fulfill({ json: { ok: true } });
    });
    await play(page);
    const pad = page.getByRole('button', { name: 'Press CC 119 · ch 4', exact: true });
    const box = await pad.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.layer === 'alternate');
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.layer === 'normal');
    assert.deepEqual(writes.map(command => command.value), [127, 0]);
  }, async (_page, fixture) => {
    for (const setup of [fixture.state.banks.active, fixture.state.banks.draft]) Object.assign(setup.devices.find(device => device.id === 'twister'), { layer_mode: 'software', layer_switch: { type: 'cc', channel: 4, number: 119, mode: 'momentary' } });
    fixture.live.active_layers = { twister: 'normal' };
  });
});
async function enableDetent(page) {
  await firstControl(page).locator('.k-label').click();
  await expandSections(page);
  await page.getByLabel('Center detent', { exact: true }).check();
  await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.detent === 'true');
}

test('center detents persist, preview silently, commit once on release, and cancel without MIDI', options, async () => {
  await setup(async (page, fixture) => {
    await enableDetent(page);
    assert.equal(await firstControl(page).getAttribute('data-centered'), 'true');
    await play(page);
    const graphic = firstControl(page).locator('svg');
    const box = await graphic.boundingBox(), startX = box.x + box.width / 2, startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY); await page.mouse.down(); await page.mouse.move(startX, startY - 14);
    assert.equal(fixture.writes.length, 0);
    await page.mouse.up(); await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.value === '74');
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0].runtime_instance, fixture.live.instance_id);
    assert.equal(fixture.writes[0].definitions_revision, fixture.live.definitions_revision);
    await firstControl(page).focus(); await firstControl(page).press('Enter');
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"]').dataset.centered === 'true');
    assert.equal(fixture.writes.at(-1).value, 64);
    const count = fixture.writes.length;
    await page.mouse.move(startX, startY); await page.mouse.down(); await page.mouse.move(startX, startY + 20);
    await firstControl(page).dispatchEvent('pointercancel'); await page.mouse.up();
    assert.equal(fixture.writes.length, count);
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-pressed') === 'false');
    await page.waitForFunction(() => document.querySelector('#undo').disabled === false);
    if (!fixture.layout?.controls?.['bank-1:0']?.centerDetent) await page.waitForResponse(response => response.url().endsWith('/api/patch/layout') && response.request().method() === 'POST');
    await page.reload(); await page.locator('.node').first().waitFor();
    assert.equal(await firstControl(page).getAttribute('data-detent'), 'true');
    assert.equal(await page.locator('#apply').isDisabled(), true);
  });
});

test('Workspace styles import by runtime identity and sliders/buttons remain editable', options, async () => {
  await setup(async (page, fixture) => {
    await page.getByRole('button', { name: 'Import saved control styles', exact: true }).click();
    assert.equal(await firstControl(page).getAttribute('data-detent'), 'true');
    assert.equal(await page.locator('.knob[data-knob="bank-2:0"]').getAttribute('data-kind'), 'fader');
    assert.equal(await page.locator('.knob[data-knob="bank-3:0"]').getAttribute('data-kind'), 'button');
    await firstControl(page).locator('.k-label').click();
    await expandSections(page);
    await page.getByLabel('Display', { exact: true }).selectOption('fader');
    assert.equal(await firstControl(page).getAttribute('data-kind'), 'fader');
    await page.locator('#undo').click();
    assert.equal(await firstControl(page).getAttribute('data-kind'), 'knob');
    await page.locator('#controlDetails').click();
    assert.equal(await firstControl(page).locator('.k-address').isVisible(), true);
    assert.equal(await page.locator('#apply').isDisabled(), true);
    assert.equal(fixture.writes.length, 0);
    await play(page);
    const pad = page.locator('.knob[data-knob="bank-3:0"] .mini-pad'), bounds = await pad.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
    assert.equal(fixture.writes.length, 0);
    const committed = page.waitForResponse(response => response.url().endsWith('/api/bank-control'));
    await page.mouse.up(); await committed;
    assert.equal(fixture.writes.length, 1); assert.equal(fixture.writes[0].value, 0);
  }, async (page, fixture) => {
    const workspace = projectRig({ active: fixture.state.banks.active, native: true });
    workspace.modules[0].controls[0].centerDetent = true;
    workspace.modules[1].kind = 'fader'; workspace.modules[2].kind = 'button';
    await page.addInitScript(value => localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)), workspace);
  });
});

test('playback disarms for pending patch edits, tool navigation, restart and document hiding', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('#play').click();
    await page.locator('.node[data-id="mod:1"] .toggle').click();
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    assert.equal(await performBlocked(page), true);
    await page.locator('#play').click({ force: true }); // aria-disabled, but it still explains itself
    await page.locator('#toast').filter({ hasText: 'Apply or discard your patch edits first' }).waitFor();
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    await page.locator('#undo').click();
    await page.locator('#play').click();
    await page.locator('[data-tab="devices"]').click();
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    await page.locator('[data-tab="inspect"]').click();
    await page.locator('#play').click();
    fixture.live.instance_id = 'new-runtime';
    await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-pressed') === 'false');
    fixture.live.instance_id = fixture.state.instance_id;
    await performReady(page);
    await page.locator('#play').click();
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    assert.equal(fixture.writes.length, 0);
  });
});

test('all dock sides, narrow layouts and Fit keep nodes inside the canvas', options, async () => {
  await setup(async (page, fixture) => {
    for (const side of ['left', 'top', 'right', 'bottom']) {
      await page.getByRole('button', { name: `Dock ${side}`, exact: true }).click();
      await page.locator('#fit').click();
      assert.equal(await page.evaluate(() => {
        const bounds = document.querySelector('#viewport').getBoundingClientRect();
        return [...document.querySelectorAll('.node')].every(node => { const rect = node.getBoundingClientRect(); return rect.top >= bounds.top && rect.bottom <= bounds.bottom + 1 && rect.left >= bounds.left && rect.right <= bounds.right + 1; });
      }), true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#fit').click();
    assert.equal(await page.locator('#workarea').getAttribute('data-side'), 'bottom');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('[data-tab="clock"]').click();
    await page.frameLocator('#toolFrame').locator('body[data-tool="clock"]').waitFor();
    assert.equal(fixture.writes.length, 0);
  });
});

test('real embedded tool drafts block patch apply and playback until discarded', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('.node[data-id="mod:1"] .toggle').click();
    await page.waitForFunction(() => !document.querySelector('#apply').disabled);
    await page.locator('[data-tab="devices"]').click();
    const frame = page.frameLocator('#toolFrame');
    await frame.locator('#workspace-devices').waitFor({ state: 'visible' });
    await frame.getByRole('button', { name: 'Destinations', exact: true }).click();
    const channelName = frame.locator('.channel-template:visible>label input').first();
    await channelName.fill('Unsaved node review'); await channelName.press('Tab');
    await page.waitForFunction(() => document.querySelector('#toolDraftStatus').textContent.includes('Unsaved'));
    await page.locator('[data-tab="inspect"]').click();
    assert.equal(await page.locator('#apply').isDisabled(), true);
    assert.equal(await performBlocked(page), true);
    await page.locator('[data-tab="devices"]').click();
    assert.equal(await channelName.inputValue(), 'Unsaved node review');
    await frame.getByLabel('More settings', { exact: true }).click();
    await frame.locator('#discardSettings').click();
    await page.waitForFunction(() => !document.querySelector('#apply').disabled);
    assert.equal(fixture.writes.length, 0);
  });
});

test('another editor changing the rig disables apply without discarding the local patch', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('.node[data-id="mod:1"] .toggle').click();
    await page.waitForFunction(() => !document.querySelector('#apply').disabled);
    fixture.state.revision = 'changed-in-another-editor';
    await page.locator('#banner').getByRole('button', { name: 'Reload (discard my edits)', exact: true }).waitFor();
    assert.equal(await page.locator('#apply').isDisabled(), true);
    assert.equal(await page.locator('.node[data-id="mod:1"] .toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#discard').isDisabled(), false);
    assert.equal(fixture.writes.length, 0);
  });
});

test('the Add menu creates a controller and a strip on the canvas without sending MIDI', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('#addButton').click();
    await page.locator('#addMenu [data-add="controller"]').click();
    await page.getByLabel('Name', { exact: true }).fill('Faders');
    await page.getByRole('button', { name: 'Create controller', exact: true }).click();
    await page.locator('.node[data-id="ctl:faders"]').waitFor();
    assert.equal(await page.locator('#inspectorTitle').textContent(), 'Faders');
    await page.locator('.node[data-id="ctl:faders"]').getByRole('button', { name: '+ strip', exact: true }).click();
    await page.getByLabel('Inputs', { exact: true }).selectOption('consecutive');
    await page.getByLabel('First CC', { exact: true }).fill('40');
    await page.getByRole('button', { name: 'Create strip', exact: true }).click();
    await page.locator('.node[data-id="ctl:faders"] .knob').first().waitFor();
    assert.equal(await page.locator('.node[data-id="ctl:faders"] .knob').count(), 8);
    assert.match(await page.locator('.node[data-id="ctl:faders"] .knob').first().getAttribute('title'), /IN ch1 cc40/);
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'valid');
    assert.equal(await page.locator('#apply').isDisabled(), false);
    await page.locator('#undo').click(); await page.locator('#undo').click();
    assert.equal(await page.locator('.node[data-id="ctl:faders"]').count(), 0);
    assert.equal(fixture.writes.length, 0);
  });
});

test('a control shows IN, OUT and FEEDBACK; editing them and adding a layer updates the canvas', options, async () => {
  await setup(async (page, fixture) => {
    await firstControl(page).locator('.k-label').click();
    for (const heading of ['IN · from MIDI Fighter Twister', 'OUT · to Zoom L6', 'FEEDBACK ⇄ back to MIDI Fighter Twister', 'DEVICE SYNC ⇠ changes made on Zoom L6']) {
      await page.locator('#inspectorBody h5', { hasText: heading }).waitFor();
    }
    await page.getByLabel('Input CC', { exact: true }).fill('44'); await page.getByLabel('Input CC', { exact: true }).press('Tab');
    await page.locator('#controlDetails').click();
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"] .k-address').textContent === 'ch1 cc44 ⇄');
    await page.getByLabel('Send the value back to the controller').uncheck();
    await page.waitForFunction(() => document.querySelector('.knob[data-knob="bank-1:0"] .k-address').textContent === 'ch1 cc44');
    await page.getByLabel('Input CC', { exact: true }).fill('4'); await page.getByLabel('Input CC', { exact: true }).press('Tab');
    await page.locator('#toast').filter({ hasText: 'already used by Bank 1' }).waitFor();
    await page.locator('.node[data-id="ctl:twister"] .node-head strong').dblclick();
    await page.locator('details.add-layer > summary').click();
    await page.getByLabel('New layer name', { exact: true }).fill('extra');
    await page.getByLabel('New layer inputs', { exact: true }).selectOption('normal');
    await page.getByLabel('…on MIDI channel', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Add layer', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.node[data-id="ctl:twister"] .layer-tabs button').length === 4);
    assert.equal(await page.locator('.node[data-id="ctl:twister"] .layer-tabs button[aria-pressed=true]').textContent(), 'extra');
    assert.equal(fixture.writes.length, 0);
  });
});

test('MIDI map rows open their control; System shows ports, the MIDI monitor and global settings', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('[data-tab="map"]').click();
    const row = page.locator('#mapPane .map-table tr[tabindex]').first();
    await row.waitFor();
    assert.match(await row.innerText(), /Bank 1 · 1[\s\S]*ch 1 · CC 0[\s\S]*Low[\s\S]*⇄ ch 1 · CC 0/);
    await page.getByLabel('Filter mappings').fill('Aux2');
    assert.ok(await page.locator('#mapPane .map-table tr[tabindex]').count() >= 4);
    await row.click();
    assert.equal(await page.locator('[data-tab="inspect"]').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#inspectorTitle').textContent(), /^Bank 1 · /);
    await page.locator('[data-tab="system"]').click();
    await page.locator('#systemPane .stat').first().waitFor();
    assert.match(await page.locator('#systemPane').innerText(), /RUNNING[\s\S]*Ports & connections[\s\S]*MIDI monitor[\s\S]*Global settings/i);
    await page.locator('#systemPane .monitor li').first().waitFor();
    await page.getByLabel('Beats per bar', { exact: true }).fill('7'); await page.getByLabel('Beats per bar', { exact: true }).press('Tab');
    await page.waitForFunction(() => !document.querySelector('#discard').disabled);
    assert.equal(fixture.writes.length, 0);
  });
});

test('reloading with the MIDI map, System or a migrated Routing/Activity tab open still loads the canvas', options, async () => {
  for (const tab of ['map', 'system', 'controls', 'activity']) {
    await setup(async page => {
      const expected = { map: 'map', system: 'system', controls: 'map', activity: 'system' }[tab];
      assert.equal(await page.locator(`[data-tab="${expected}"]`).getAttribute('aria-pressed'), 'true', tab);
      if (expected === 'map') await page.locator('#mapPane .map-table').first().waitFor();
      else await page.locator('#systemPane .stat').first().waitFor();
    }, async page => {
      await page.addInitScript(value => localStorage.setItem('midibrain.patch.view.v1', JSON.stringify({ dock: { side: 'right', open: true, tab: value } })), tab);
    });
  }
});

test('File menu, breadcrumb navigation, hints, global inputs and node width', options, async () => {
  await setup(async (page, fixture) => {
    // File menu lives at the top left; canvas pages are gone.
    assert.equal(await page.locator('#pages').count(), 0);
    assert.equal(await page.locator('#addMenu [data-add="page"]').count(), 0);
    const file = await page.locator('#rigButton').boundingBox(), add = await page.locator('#addButton').boundingBox();
    assert.ok(file.x < add.x, 'File menu is left of the toolbar');
    await page.locator('#rigButton').click();
    assert.deepEqual(await page.locator('#rigMenu button').allInnerTexts(), ['New / init patch…', 'Import rig configuration…', 'Export rig configuration']);
    await page.locator('#rigButton').click();

    // Control → strip → controller: ← goes up one level, not to the top.
    await page.locator('.node[data-id="ctl:twister"] .knob').first().locator('.k-label').click();
    assert.match(await page.locator('#inspectorTrail').innerText(), /MIDI Fighter Twister[\s\S]*Bank 1/);
    await page.locator('#inspectorBack').click();
    assert.equal(await page.locator('#inspectorKind').textContent(), 'strip');
    await page.locator('#inspectorBack').click();
    assert.equal(await page.locator('#inspectorKind').textContent(), 'controller');

    // Explanations sit behind an “i”, not in the panel.
    assert.equal(await page.locator('#inspectorBody p.note:not(.warn)').count(), 0);
    await page.locator('#inspectorBody .hint-i').first().hover();
    await page.locator('#tip').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#tip').textContent()).length > 20);

    // Global inputs: add a knob and a slider, then remove both in one go.
    for (const [kind, number, label] of [['knob', '20', 'Cutoff'], ['fader', '21', 'Resonance']]) {
      assert.equal(await page.locator('#addMenu [data-add="input"], #addMenu [data-add="strip"]').count(), 0);
      await page.locator('.node[data-id^="ctl:"]').first().getByRole('button', { name: '+ input', exact: true }).click();
      await page.getByLabel('Display', { exact: true }).selectOption(kind);
      await page.getByLabel('Number', { exact: true }).fill(number);
      await page.getByRole('textbox', { name: 'Label', exact: true }).fill(label);
      await page.getByRole('button', { name: 'Add input', exact: true }).click();
    }
    assert.equal(await page.locator('.global-input[data-kind="knob"]').count(), 1);
    assert.equal(await page.locator('.global-input[data-kind="fader"]').count(), 1);
    await page.locator('#inspectorBody .global-row', { hasText: 'Cutoff' }).getByRole('checkbox').check();
    await page.locator('#inspectorBody .global-row', { hasText: 'Resonance' }).getByRole('checkbox').check();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /Remove 2 selected/ }).click();
    assert.equal(await page.locator('.global-input[data-kind="knob"], .global-input[data-kind="fader"]').count(), 0);

    // Node width: drag the edge, it persists in the layout, and the default restores it.
    const card = page.locator('.node[data-id="ctl:twister"]');
    const before = (await card.boundingBox()).width;
    await card.hover();
    const handle = await card.locator('.resize-handle').boundingBox();
    await page.mouse.move(handle.x + 4, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + 124, handle.y + handle.height / 2, { steps: 4 }); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.node[data-id="ctl:twister"]').offsetWidth > 400);
    assert.ok((await card.boundingBox()).width > before + 50);
    await page.waitForTimeout(700);
    assert.ok(fixture.layout.widths['ctl:twister'] > 400);
    await card.locator('.resize-handle').dispatchEvent('dblclick');
    await page.waitForTimeout(700);
    assert.equal(fixture.layout.widths['ctl:twister'], undefined);
  });
});

test('a global-only keyboard controller plays a device with a split; Tidy keeps your arrangement', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="controller"]').click();
    await page.getByLabel('Name', { exact: true }).fill('Keystation');
    await page.getByLabel('Kind', { exact: true }).selectOption('global');
    assert.equal(await page.getByLabel('Controls per strip', { exact: true }).isVisible(), false);
    await page.getByLabel('Input port', { exact: true }).selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Create controller', exact: true }).click();
    const keys = page.locator('.node[data-id="ctl:keystation"]');
    await keys.waitFor();
    assert.equal(await keys.locator('.layer-tabs, .layer-mode-label, .controller-strips').count(), 0);
    assert.equal(await page.locator('#inspectorBody h5', { hasText: /Input layers|Layer switch|Control layout/ }).count(), 0);

    await keys.getByRole('button', { name: '+ input', exact: true }).click();
    await page.getByLabel('Type', { exact: true }).selectOption('keys');
    await page.getByRole('button', { name: 'Add input', exact: true }).click();
    await page.locator('#addButton').click(); await page.locator('#addMenu [data-add="device"]').click();
    await page.getByLabel('Name', { exact: true }).fill('Synth');
    await page.getByLabel('Output port', { exact: true }).selectOption({ index: 2 });
    await page.getByRole('button', { name: 'Create device', exact: true }).click();
    await page.locator('.node[data-id="dev:synth"]').waitFor();
    await keys.locator('.global-input', { hasText: 'Keys' }).locator('.k-label').click();
    await page.getByLabel('Play a device', { exact: true }).selectOption({ label: 'Synth' });
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="notes"]').length === 1);
    // The keyboard's own panel shows every route and its settings on one screen, without a Display choice.
    await keys.locator('.global-input', { hasText: 'Keys' }).locator('.k-label').click();
    assert.equal(await page.locator('#inspectorBody h5', { hasText: 'Control appearance' }).count(), 0);
    assert.equal(await page.getByLabel('Transpose (semitones)', { exact: true }).count(), 1);
    await page.getByLabel('Keyboard setting').selectOption('transpose');
    await page.getByLabel('Modulation source').selectOption({ label: '∿ MOD 2' });
    await page.getByRole('button', { name: '+ Add', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="notemod"]').length === 1);
    assert.equal(await page.locator('.field.modulated').count(), 1);
    assert.equal(await keys.locator('.key-param').count(), 10, 'the keyboard route sits inside its controller node');
    assert.equal(await page.locator('.node[data-type="keys"]').count(), 0);
    await page.getByLabel('Scale key', { exact: true }).selectOption('8');
    assert.equal(await page.getByLabel('Scale', { exact: true }).inputValue(), 'major', 'picking a key switches the scale on');
    await page.getByLabel('Scale', { exact: true }).selectOption('minor');
    assert.match(await keys.locator('.key-route-head small').innerText(), /G♯ minor/);
    assert.equal(await page.getByLabel('Transpose (semitones)', { exact: true }).count(), 1, 'still on the keyboard panel');
    await page.getByRole('button', { name: 'Split here', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="notes"]').length === 2);
    assert.match(await keys.locator('.k-roles').innerText(), /♪ → Synth/);

    // Tidy snaps a nudged node back into its column without re-sorting the canvas.
    const other = page.locator('.node[data-id="ctl:twister"]');
    const head = await keys.locator('.node-head').boundingBox();
    await page.mouse.move(head.x + 20, head.y + 10); await page.mouse.down(); await page.mouse.move(head.x + 70, head.y + 10, { steps: 4 }); await page.mouse.up();
    const nudged = (await keys.boundingBox()).x - (await other.boundingBox()).x;
    assert.ok(Math.abs(nudged) > 10, 'the node was nudged off its column');
    await page.locator('#tidy').click(); await page.waitForTimeout(300);
    assert.ok(Math.abs((await keys.boundingBox()).x - (await other.boundingBox()).x) < 2, 'Tidy snaps it back into the column');
  });
});

test('hovering a wire lights both connection points', options, async () => {
  await setup(async page => {
    const wire = page.locator('#wires .wire[data-kind="action"] .hit').first();
    const box = await wire.evaluate(path => { const point = path.getPointAtLength(path.getTotalLength() / 2); const rect = path.ownerSVGElement.getBoundingClientRect(); const matrix = path.getScreenCTM(); return { x: matrix.a * point.x + matrix.e, y: matrix.d * point.y + matrix.f, rect: rect.width }; });
    await page.mouse.move(box.x, box.y);
    await page.waitForFunction(() => document.querySelectorAll('.port.hot').length >= 2);
    assert.ok(await page.locator('.hot-end').count() >= 1);
    await page.mouse.move(5, 5);
    await page.waitForFunction(() => document.querySelectorAll('.port.hot').length === 0);
  });
});

test('strips duplicate, and wires from every layer show unless limited to the visible one', options, async () => {
  await setup(async (page, fixture) => {
    // All layers by default: the Page 2 wires are drawn while the normal layer is showing.
    const normal = page.locator('[data-layer-tab="twister:normal"]');
    if ((await normal.getAttribute('aria-pressed')) !== 'true') await normal.click();
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="thru"]').length > 0);
    await page.locator('#filtersButton').click();
    await page.getByLabel('Wires from all layers').uncheck();
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="thru"]').length === 0);
    await page.getByLabel('Wires from all layers').check();
    await page.waitForFunction(() => document.querySelectorAll('#wires .wire[data-kind="thru"]').length > 0);
    await page.locator('#filtersButton').click();

    const strips = await page.locator('.node[data-id="ctl:twister"] .controller-strip').count();
    await page.locator('.node[data-id="ctl:twister"] .bank-head').first().click();
    await page.getByRole('button', { name: 'Duplicate strip', exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll('.node[data-id="ctl:twister"] .controller-strip').length === count + 1, strips);
    assert.match(await page.locator('#inspectorTitle').textContent(), /copy/);
    assert.equal(fixture.writes.length, 0);
  });
});

test('Shift-drag selects several nodes and one drag moves them all; Shift-click toggles; Esc clears', options, async () => {
  await setup(async (page, fixture) => {
    const twister = page.locator('.node[data-id="ctl:twister"]'), clock = page.locator('.node[data-id="clock"]');
    // Shift-click toggles membership without opening the inspector.
    await page.keyboard.down('Shift');
    await twister.locator('.node-head').click({ position: { x: 40, y: 12 } });
    await clock.locator('.node-head').click({ position: { x: 30, y: 10 } });
    await page.keyboard.up('Shift');
    assert.equal(await page.locator('.node.multi').count(), 2);
    const [twisterBefore, clockBefore, otherBefore] = await Promise.all([twister.boundingBox(), clock.boundingBox(), page.locator('.node[data-id="thru"]').boundingBox()]);
    const head = await twister.locator('.node-head').boundingBox();
    await page.mouse.move(head.x + 40, head.y + 12); await page.mouse.down(); await page.mouse.move(head.x + 90, head.y + 52, { steps: 5 }); await page.mouse.up();
    const [twisterAfter, clockAfter, otherAfter] = await Promise.all([twister.boundingBox(), clock.boundingBox(), page.locator('.node[data-id="thru"]').boundingBox()]);
    const dx = twisterAfter.x - twisterBefore.x, dy = twisterAfter.y - twisterBefore.y;
    assert.ok(dx > 20 && dy > 20, 'the dragged node moved');
    assert.ok(Math.abs(clockAfter.x - clockBefore.x - dx) < 2 && Math.abs(clockAfter.y - clockBefore.y - dy) < 2, 'the other selected node moved with it');
    assert.ok(Math.abs(otherAfter.x - otherBefore.x) < 1 && Math.abs(otherAfter.y - otherBefore.y) < 1, 'an unselected node stayed put');
    await page.locator('#undo').click();
    assert.ok(Math.abs((await clock.boundingBox()).x - clockBefore.x) < 2, 'one undo returns the whole group');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.node.multi').count(), 0);
    // Marquee from empty canvas around everything.
    const area = await page.locator('#viewport').boundingBox();
    await page.keyboard.down('Shift');
    await page.mouse.move(area.x + area.width - 4, area.y + area.height - 4); await page.mouse.down();
    await page.mouse.move(area.x + 3, area.y + 3, { steps: 6 }); await page.mouse.up();
    await page.keyboard.up('Shift');
    assert.equal(await page.locator('.node.multi').count(), await page.locator('.node').count());
    await page.mouse.click(area.x + area.width - 4, area.y + area.height - 4);
    assert.equal(await page.locator('.node.multi').count(), 0);
    assert.equal(fixture.writes.length, 0);
  });
});

test('a wire that starts inside its own node is drawn over the card from the knob', options, async () => {
  await setup(async page => {
    await page.locator('#detailControl').click();
    await page.waitForFunction(() => document.querySelectorAll('#wiresTop .wire.stub').length > 0);
    // Stubs start at a knob dot that sits well inside the node, and are clipped to it.
    assert.ok(await page.locator('#wiresTop g[clip-path]').count() > 0);
  });
});

test('inspector manual links open the selected topic and section in a separate tab', options, async () => {
  await setup(async (page, fixture) => {
    await firstControl(page).locator('.k-label').click();
    assert.equal(await page.locator('#inspectorManual').getAttribute('href'), '/manual#mappings');
    const opened = page.context().waitForEvent('page');
    await page.locator('#inspectorManual').click();
    const manual = await opened;
    await manual.waitForURL('**/manual#mappings');
    await manual.locator('#article h1').waitFor();
    assert.equal(await manual.locator('#article h1').textContent(), 'Control');
    assert.equal(await manual.evaluate(() => window.opener), null);
    await manual.close();
    const section = page.locator('#inspectorBody a[href="/manual#feedback"]');
    const more = page.context().waitForEvent('page');
    await section.click();
    const detail = await more;
    await detail.waitForURL('**/manual#feedback');
    await detail.locator('#article #feedback').waitFor();
    await detail.close();
    assert.equal(fixture.writes.length, 0);
    await page.locator('#inspectorBack').click();
    assert.equal(await page.locator('#inspectorManual').getAttribute('href'), '/manual#strips');
  });
});

test('the Manual dock preserves the draft and article when switching panels and reloads as a saved tab', options, async () => {
  await setup(async (page, fixture) => {
    const manual = page.frameLocator('#manualFrame');
    await manual.locator('#article h1').waitFor();
    await page.locator('[data-tab="inspect"]').click();
    await firstControl(page).locator('.k-label').click();
    await page.getByLabel('Mapping name', { exact: true }).fill('Manual test draft');
    await page.getByLabel('Mapping name', { exact: true }).press('Tab');
    await page.waitForFunction(() => !document.querySelector('#discard').disabled);
    await page.locator('[data-tab="manual"]').click();
    await manual.locator('#search').fill('next bar');
    await manual.locator('#results .result').first().waitFor();
    await manual.locator('#results .result').first().click();
    await manual.getByRole('heading', { name: 'Snapshots', exact: true }).waitFor();
    assert.equal(await page.locator('#discard').isEnabled(), true);
    await page.locator('[data-tab="inspect"]').click();
    assert.equal(await page.getByLabel('Mapping name', { exact: true }).inputValue(), 'Manual test draft');
    await page.locator('[data-tab="manual"]').click();
    assert.equal(await manual.locator('#article h1').textContent(), 'Snapshots');
    assert.equal(fixture.writes.length, 0);
  }, async page => {
    await page.addInitScript(() => localStorage.setItem('midibrain.patch.view.v1', JSON.stringify({ dock: { side: 'right', open: true, tab: 'manual' } })));
  });
});


test('MOD fields, device sync sections and panel help link to the precise wiki entry without edits', options, async () => {
  await setup(async (page, fixture) => {
    await page.locator('.node[data-id="mod:0"] .node-head').click();
    const shape = page.getByLabel('Shape', { exact: true }), before = await shape.inputValue();
    const opened = page.context().waitForEvent('page');
    await page.locator('#inspectorBody a[href="/manual#mod-shapes"]').click();
    const wiki = await opened;
    await wiki.getByRole('heading', { name: 'Shape', exact: true }).waitFor();
    await wiki.close();
    assert.equal(await shape.inputValue(), before);
    assert.equal(await page.locator('#discard').isDisabled(), true);
    await page.locator('.node[data-id="dev:l6"] .node-head').click();
    assert.equal(await page.locator('#inspectorBody .flow-sync .section-manual').getAttribute('href'), '/manual#device-sync');
    assert.equal(await page.locator('#inspectorBody .flow-out .section-manual').getAttribute('href'), '/manual#devices/add-and-ports');
    await page.locator('[data-tab="system"]').click();
    assert.equal(await page.locator('#panelManual').getAttribute('href'), '/manual#system');
    const helpOpened = page.context().waitForEvent('page');
    await page.locator('#panelManual').click();
    const panelWiki = await helpOpened;
    await panelWiki.getByRole('heading', { name: 'System', exact: true }).waitFor();
    await panelWiki.close();
    assert.equal(fixture.writes.length, 0);
  });
});
