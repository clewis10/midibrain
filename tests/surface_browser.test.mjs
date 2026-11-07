import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoWorkspace, normalizeDevices } from '../src/midibrain/performance/surface-model.mjs';

let chromium;
try { ({ chromium } = await import(process.env.MIDIBRAIN_PLAYWRIGHT || 'playwright')); }
catch (error) { if (process.env.MIDIBRAIN_PLAYWRIGHT) throw error; }
const base = process.env.MIDIBRAIN_SURFACE_URL || 'http://127.0.0.1:8790';
const options = { timeout: 90000, skip: !chromium && 'Optional: install Playwright or set MIDIBRAIN_PLAYWRIGHT' };
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('midibrain.surfaces.v3')));
const closeEditor = page => page.locator('#closeEditor').click();
const tab = (page, name) => page.locator('#editorTabs').getByRole('button', { name, exact: true }).click();

test('canvas pane scrolls without a nested viewport, clipped controls or an overlapping footer', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1838, height: 900 } });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  const response = await page.request.get(`${base}/api/surfaces/devices`);
  const fixture = demoWorkspace(normalizeDevices((await response.json()).devices));
  fixture.canvas.height = 480;
  await page.addInitScript(value => localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)), fixture);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Canvas size', exact: true }).count(), 0);
    assert.equal(await page.locator('#signalPreview').isVisible(), false);
    assert.ok((await page.locator('#canvas').boundingBox()).y < 340);
    for (const zoom of ['100', '75', 'fit']) {
      await page.getByLabel('Canvas zoom', { exact: true }).selectOption(zoom);
      const layout = await page.evaluate(() => {
        const viewport = document.querySelector('.canvas-scroll'), stage = document.querySelector('#canvasStage');
        return {
          overflow: getComputedStyle(viewport).overflowY,
          viewportHeight: viewport.getBoundingClientRect().height,
          stageHeight: stage.getBoundingClientRect().height,
          stageBottom: stage.getBoundingClientRect().bottom,
          moduleBottom: Math.max(...[...document.querySelectorAll('.surface-module')].map(node => node.getBoundingClientRect().bottom)),
          footerTop: document.querySelector('.canvas-footer').getBoundingClientRect().top,
        };
      });
      assert.equal(layout.overflow, 'visible');
      assert.ok(Math.abs(layout.viewportHeight - layout.stageHeight) < 1);
      assert.ok(layout.stageBottom >= layout.moduleBottom - 1);
      assert.ok(layout.footerTop >= layout.moduleBottom - 1);
      await page.locator('.surface-module').last().getByRole('slider').last().scrollIntoViewIfNeeded();
      const controlBounds = await page.locator('.surface-module').last().getByRole('slider').last().boundingBox();
      const paneBounds = await page.locator('#canvasPane').boundingBox();
      assert.ok(controlBounds.y + controlBounds.height <= paneBounds.y + paneBounds.height + 1);
      assert.equal(await page.locator('.canvas-scroll').evaluate(node => node.scrollTop), 0);
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal((await saved(page)).canvas.height, 480);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.workspace-details').count(), 0);
    await page.getByRole('button', { name: '≋ Activity', exact: true }).click();
    await page.frameLocator('#runtimeFrame').locator('#canvasActivity').waitFor({ state: 'visible' });
    assert.equal(await page.frameLocator('#runtimeFrame').getByRole('heading', { name: 'Canvas activity', exact: true }).isVisible(), true);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('tools dock beside a persistent canvas with accessible, saved split sizing', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1560, height: 1040 } });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  const response = await page.request.get(`${base}/api/surfaces/devices`);
  const fixture = demoWorkspace(normalizeDevices((await response.json()).devices)); fixture.canvas.scale = 'fit';
  await page.addInitScript(value => { if (!localStorage.getItem('midibrain.surfaces.v3')) localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)); }, fixture);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').first().waitFor();
    const original = await saved(page);
    assert.equal(await page.getByRole('button', { name: 'Mappings', exact: true }).count(), 0);
    await page.getByRole('button', { name: '◈ Snapshots', exact: true }).click();
    const frame = page.frameLocator('#runtimeFrame');
    await frame.locator('#workspace-snapshots').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#canvasPane').isVisible(), true);
    assert.equal(await page.locator('.surface-module').count(), 3);
    assert.equal(await frame.locator('#bankEditor').isVisible(), false);
    assert.equal(await frame.locator('#bankModOverview').isVisible(), false);
    assert.equal(await frame.locator('#liveActions').isVisible(), false);
    assert.equal(await frame.getByRole('button', { name: 'Reset defaults now', exact: true }).isVisible(), false);
    const divider = page.getByRole('separator', { name: 'Resize canvas and tool panes' });
    assert.equal(await divider.getAttribute('aria-orientation'), 'vertical');
    const before = await page.locator('#canvasPane').boundingBox();
    const handle = await divider.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 100); await page.mouse.down();
    await page.mouse.move(handle.x - 180, handle.y + 100, { steps: 8 }); await page.mouse.up();
    assert.ok((await page.locator('#canvasPane').boundingBox()).width < before.width - 100);
    await divider.focus(); const value = Number(await divider.getAttribute('aria-valuenow'));
    await divider.press('ArrowRight'); assert.equal(Number(await divider.getAttribute('aria-valuenow')), value + 2);
    await page.getByRole('button', { name: 'Split top and bottom', exact: true }).click();
    assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal');
    const primary = await page.locator('#canvasPane').boundingBox(), secondary = await page.locator('#runtimeWorkspace').boundingBox();
    assert.ok(secondary.y >= primary.y + primary.height);
    await divider.focus(); await divider.press('ArrowDown');
    const storedView = await page.evaluate(() => JSON.parse(localStorage.getItem('midibrain.workspace.view.v1')));
    assert.equal(storedView.direction, 'stack'); assert.equal(storedView.stack, 57);
    assert.deepEqual(await saved(page), original);
    for (const name of ['⌘ Devices', '◷ Clock', '≋ Activity']) {
      await page.getByRole('button', { name, exact: true }).click();
      const tool = name === '⌘ Devices' ? 'devices' : name === '◷ Clock' ? 'clock' : 'activity';
      await frame.locator(`body[data-tool="${tool}"]`).waitFor();
      const layout = await frame.locator('#workspaceMain').evaluate(node => ({ height: node.clientHeight, available: innerHeight, width: document.body.scrollWidth, viewport: innerWidth }));
      assert.ok(layout.height >= layout.available - 96, `${tool} must use its available pane height`);
      assert.ok(layout.width <= layout.viewport, `${tool} must fit its pane width`);
    }
    assert.equal(await frame.locator('.workspace-toolbar').isVisible(), false);
    await page.getByRole('button', { name: 'Close tool pane', exact: true }).click();
    assert.equal(await page.locator('#runtimeWorkspace').isVisible(), false);
    assert.equal(await page.locator('#canvasPane').isVisible(), true);
    await page.getByRole('button', { name: '⇄ Routing', exact: true }).click();
    await frame.locator('#group-controls').waitFor({ state: 'visible' });
    assert.equal(await divider.getAttribute('aria-orientation'), 'horizontal');
    await page.reload(); await page.locator('.surface-module').first().waitFor();
    await page.getByRole('button', { name: '◈ Snapshots', exact: true }).click();
    await frame.locator('#workspace-snapshots').waitFor({ state: 'visible' });
    assert.equal(await divider.getAttribute('aria-valuenow'), '57');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#workspaceShell').dataset.split === 'stack');
    assert.equal(await page.getByRole('button', { name: 'Split side by side', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
    await page.getByRole('button', { name: '≋ Activity', exact: true }).click();
    await frame.locator('body[data-tool="activity"]').waitFor();
    assert.ok(await frame.locator('#workspaceMain').evaluate(node => node.clientHeight >= innerHeight - 40));
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('Devices switches channels without losing drafts in stacked and side panes', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  try {
    await page.goto(`${base}/workspace`); await page.getByRole('button', { name: '⌘ Devices', exact: true }).click();
    const frame = page.frameLocator('#runtimeFrame'); await frame.locator('#workspace-devices').waitFor({ state: 'visible' });
    await frame.getByRole('button', { name: 'Destinations', exact: true }).click();
    const channelTabs = frame.locator('.bank-form:visible .device-channel-tabs button');
    assert.ok(await channelTabs.count() > 1);
    assert.equal(await frame.locator('.channel-template:visible').count(), 1);
    await channelTabs.nth(1).click();
    const channelName = frame.locator('.channel-template:visible>label input').first();
    await channelName.fill('Retained channel draft'); await channelName.press('Tab');
    await channelTabs.first().click(); await channelTabs.nth(1).click(); assert.equal(await channelName.inputValue(), 'Retained channel draft');
    await page.locator('#splitStack').click();
    assert.equal(await channelName.inputValue(), 'Retained channel draft');
    await frame.locator('.channel-template:visible .parameter-table tr[data-page]').first().scrollIntoViewIfNeeded();
    assert.ok(await frame.locator('#workspaceMain').evaluate(node => node.scrollWidth <= node.clientWidth));
    await page.locator('#splitSide').click(); await page.setViewportSize({ width: 1100, height: 900 });
    await frame.locator('.channel-template:visible .parameter-table tr[data-page]').first().scrollIntoViewIfNeeded();
    assert.ok(await frame.locator('#workspaceMain').evaluate(node => node.scrollWidth <= node.clientWidth));
    assert.equal(await frame.locator('.channel-template:visible').count(), 1);
    assert.match(await page.locator('#runtimeDraftStatus').textContent(), /Unsaved rig edits/);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('direct module resizing, nonmodal editing and details preserve mappings', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1540, height: 1000 } });
  const writes = [], errors = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.request.get(`${base}/api/surfaces/devices`), fixture = demoWorkspace(normalizeDevices((await response.json()).devices));
  await page.addInitScript(value => { if (!localStorage.getItem('midibrain.surfaces.v3')) localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)); }, fixture);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').first().waitFor();
    assert.equal(await page.locator('.control-address').first().isVisible(), false);
    assert.ok(await page.locator('.control-label').evaluateAll(nodes => nodes.every(node => node.scrollHeight <= node.clientHeight + 1)));
    await page.getByRole('button', { name: 'MIDI details', exact: true }).click();
    assert.equal(await page.locator('.control-address').first().isVisible(), true);
    assert.ok(await page.locator('.control-label').evaluateAll(nodes => nodes.every(node => node.scrollHeight <= node.clientHeight + 1)));
    await page.getByRole('button', { name: 'MIDI details', exact: true }).click();
    const module = page.locator('.surface-module').first(), original = (await saved(page)).modules[0];
    const handle = module.locator('.module-resize'), bounds = await handle.boundingBox(), cell = await page.locator('#canvas').evaluate(node => node.getBoundingClientRect().width / 12);
    await page.mouse.move(bounds.x + 11, bounds.y + 11); await page.mouse.down();
    await page.mouse.move(bounds.x + 11 - cell, bounds.y + 11 + 96, { steps: 6 }); await page.mouse.up();
    let resized = (await saved(page)).modules[0];
    assert.equal(resized.width, original.width - 1); assert.ok(resized.height > 0);
    assert.deepEqual(resized.controls, original.controls); assert.deepEqual(resized.groups, original.groups);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); assert.deepEqual((await saved(page)).modules[0], original);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await handle.focus(); await handle.press('ArrowRight'); assert.equal((await saved(page)).modules[0].width, original.width);
    const beforeCancel = await saved(page), cancelBounds = await handle.boundingBox();
    await page.mouse.move(cancelBounds.x + 11, cancelBounds.y + 11); await page.mouse.down(); await page.mouse.move(cancelBounds.x + 11 - cell, cancelBounds.y + 60);
    await handle.dispatchEvent('pointercancel'); await page.mouse.up(); assert.deepEqual(await saved(page), beforeCancel);
    await page.locator('.control-label').first().click();
    assert.equal(await page.locator('#editorDialog').evaluate(node => node.matches(':modal')), false);
    assert.ok((await page.locator('#editorDialog').boundingBox()).width <= 500);
    const header = page.locator('.inspector-top'), headerBounds = await header.boundingBox(), editorBefore = await page.locator('#editorDialog').boundingBox();
    await page.mouse.move(headerBounds.x + 40, headerBounds.y + 10); await page.mouse.down(); await page.mouse.move(headerBounds.x + 80, headerBounds.y + 40); await page.mouse.up();
    assert.ok((await page.locator('#editorDialog').boundingBox()).y > editorBefore.y);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#editorDialog').isVisible(), false);
    await page.getByRole('button', { name: 'MIDI details', exact: true }).click();
    resized = (await saved(page)).modules[0]; await page.reload(); await page.locator('.surface-module').first().waitFor();
    assert.equal(await page.locator('.control-address').first().isVisible(), true); assert.deepEqual((await saved(page)).modules[0], resized);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('center-detent knobs persist, fill from center and remain presentation-only', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const writes = [], errors = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.request.get(`${base}/api/surfaces/devices`), fixture = demoWorkspace(normalizeDevices((await response.json()).devices));
  await page.addInitScript(value => { if (!localStorage.getItem('midibrain.surfaces.v3')) localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)); }, fixture);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.control-label').first().click();
    await page.getByLabel('Center detent', { exact: true }).check(); await closeEditor(page);
    const control = page.locator('.control').first(), dial = control.getByRole('slider');
    assert.equal((await saved(page)).modules[0].controls[0].centerDetent, true);
    assert.equal(await control.evaluate(node => node.style.getPropertyValue('--arc-start')), '135deg');
    assert.equal(await control.evaluate(node => node.style.getPropertyValue('--arc-end')), '135deg');
    await dial.focus(); await dial.press('ArrowLeft');
    assert.equal(await dial.inputValue(), '63');
    assert.ok(parseFloat(await control.evaluate(node => node.style.getPropertyValue('--arc-start'))) < 135);
    await dial.press('Enter'); assert.equal(await dial.inputValue(), '64');
    assert.equal(await dial.getAttribute('aria-valuetext'), '64 · center');
    const bounds = await control.locator('.knob').boundingBox();
    await page.mouse.move(bounds.x + 20, bounds.y + 20); await page.mouse.down(); await page.mouse.move(bounds.x + 20, bounds.y + 22); await page.mouse.up();
    assert.equal((await saved(page)).modules[0].controls[0].bindings.normal.value, 64);
    await dial.focus(); await dial.press('Home'); assert.equal(await dial.inputValue(), '0');
    await control.locator('.knob').dblclick(); assert.equal(await dial.inputValue(), '64');
    await page.reload(); await page.locator('.control').first().waitFor();
    assert.equal(await control.getAttribute('data-detent'), 'true');
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('Edit and Perform focus the canvas, show read-only MOD and restore the dock safely', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const writes = [], errors = [];
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.request.get(`${base}/api/surfaces/devices`), fixture = demoWorkspace(normalizeDevices((await response.json()).devices));
  await page.addInitScript(value => localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)), fixture);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').first().waitFor();
    assert.equal(await page.getByRole('group', { name: 'Workspace mode' }).getByRole('button').count(), 2);
    await page.getByRole('button', { name: '⌘ Devices', exact: true }).click();
    const frame = page.frameLocator('#runtimeFrame'); await frame.locator('#workspace-devices').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Perform', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.mode === 'perform');
    assert.equal(await page.locator('.topbar').isVisible(), false);
    assert.equal(await page.locator('.workspace-navigation').isVisible(), false);
    assert.equal(await page.locator('#runtimeWorkspace').isVisible(), false);
    assert.ok((await page.locator('#canvasPane').boundingBox()).height >= 998);
    assert.match(await page.locator('#performStatus').textContent(), /PREVIEW ONLY.*CANVAS OUTPUT OFF/);
    assert.equal(await page.locator('.performance-mod').count(), 3);
    assert.equal(await page.locator('#performOverview input, #performOverview button').count(), 0);
    await page.getByRole('slider', { name: 'Low simulated value', exact: true }).first().focus();
    await page.getByRole('slider', { name: 'Low simulated value', exact: true }).first().press('ArrowRight');
    await page.locator('.control-label').first().click(); assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.getByRole('button', { name: 'MOD overview', exact: true }).click();
    assert.equal(await page.locator('#performOverview').isVisible(), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.body.dataset.mode === 'build');
    assert.equal(await page.locator('.topbar').isVisible(), true);
    assert.equal(await frame.locator('#workspace-devices').isVisible(), true);
    await page.getByRole('button', { name: '≋ Activity', exact: true }).click();
    await frame.locator('#canvasActivity').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#runtimeFrame').contentDocument.querySelector('#canvasActivity').textContent.includes('Low'));
    assert.equal(await page.locator('.workspace-details').count(), 0);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('floating editors, optional pages, automatic canvas and design workflows', options, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1560, height: 1040 } });
  const artifacts = await mkdtemp(join(tmpdir(), 'midibrain-workspace-v3-'));
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  const response = await page.request.get(`${base}/api/surfaces/devices`);
  const fixture = demoWorkspace(normalizeDevices((await response.json()).devices));
  await page.addInitScript(value => { if (!localStorage.getItem('midibrain.surfaces.v3')) localStorage.setItem('midibrain.surfaces.v3', JSON.stringify(value)); }, fixture);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').first().waitFor();
    assert.equal(await page.locator('.surface-module').count(), 3);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    const canvasSize = await page.locator('#canvas').evaluate(node => [node.clientWidth, node.clientHeight]);
    const dial = page.getByRole('slider', { name: 'Low simulated value', exact: true }).first();
    await dial.focus(); await dial.press('ArrowRight');
    assert.equal((await saved(page)).modules[0].controls[0].bindings.normal.value, 65);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await dial.evaluate(node => document.activeElement === node), true);

    await page.locator('.assignment-chip').first().click(); await tab(page, 'BROADCAST TO');
    await page.locator('#inspectorBody').getByRole('button', { name: 'Channel 6', exact: true }).click();
    assert.deepEqual((await saved(page)).modules[0].groups[0].destinations[0].channels, [1, 3, 6]);
    await closeEditor(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual((await saved(page)).modules[0].groups[0].destinations[0].channels, [1, 3]);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.locator('.control-label').first().click();
    await page.locator('#inspectorBody').getByLabel('Named parameter', { exact: true }).selectOption('high');
    await tab(page, 'REUSE THE PARAMETER'); await page.getByRole('button', { name: 'Apply across row →', exact: true }).click();
    assert.ok((await saved(page)).modules[0].controls.slice(0, 4).every(control => control.bindings.normal.parameter === 'high'));
    await page.locator('#editorTabs').getByRole('button', { name: /^OUTPUT PREVIEW/ }).click();
    assert.equal(await page.locator('#inspectorBody input:visible, #inspectorBody select:visible').count(), 0);
    assert.equal(await page.locator('.direct-details').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Remove physical control and all variants', exact: true }).isVisible(), false);
    assert.equal(await page.getByText(/This is not the Routing list or hardware readback/).isVisible(), true);
    await closeEditor(page);

    await page.getByRole('button', { name: 'Edit Mixer strips module', exact: true }).click();
    await tab(page, 'INPUT VARIANTS'); await page.locator('#inspectorBody').getByLabel('Enable input variants', { exact: true }).uncheck();
    assert.equal((await saved(page)).modules[0].layersEnabled, false);
    await page.locator('#inspectorBody').getByLabel('Enable input variants', { exact: true }).check();
    await page.getByRole('button', { name: '+ Add input variant', exact: true }).click();
    assert.equal((await saved(page)).modules[0].layers.length, 3); await closeEditor(page);

    await page.getByRole('button', { name: '+ Page', exact: true }).click();
    await page.getByLabel('Page name', { exact: true }).fill('Performance'); await page.getByLabel('Page name', { exact: true }).press('Tab'); await closeEditor(page);
    const pageId = (await saved(page)).pages[0].id;
    await page.getByRole('button', { name: 'Edit Mixer strips module', exact: true }).click(); await tab(page, 'LAYOUT / GRID');
    await page.getByLabel('Workspace page', { exact: true }).selectOption(pageId); await closeEditor(page);
    await page.getByRole('button', { name: '+ Page', exact: true }).click(); await closeEditor(page);
    assert.equal(await page.locator('.surface-module').count(), 2);
    await page.locator('#pageTabs').getByRole('button', { name: 'All controls', exact: true }).click();
    assert.equal(await page.locator('.surface-module').count(), 3);
    assert.deepEqual(await page.locator('#canvas').evaluate(node => [node.clientWidth, node.clientHeight]), canvasSize);

    await page.getByLabel('Canvas zoom', { exact: true }).selectOption('75');
    const width = await page.locator('.surface-module').first().evaluate(node => node.getBoundingClientRect().width);
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.waitForFunction(previous => document.querySelector('.surface-module').getBoundingClientRect().width < previous, width);
    await page.getByRole('button', { name: 'Rig & files', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse MIDI Fighter Twister', exact: true }).click();
    await page.getByRole('button', { name: 'Close rig inventory', exact: true }).click();
    assert.ok(await page.locator('#canvas').evaluate(node => Math.abs(node.getBoundingClientRect().width - node.closest('.canvas-scroll').clientWidth) <= 1));
    await page.getByRole('button', { name: 'Rig & files', exact: true }).click();
    await page.getByRole('button', { name: 'Show MIDI Fighter Twister', exact: true }).click();
    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export ↓', exact: true }).click();
    await (await downloadEvent).saveAs(join(artifacts, 'workspace.surfaces.json'));
    await page.getByRole('button', { name: 'Close rig inventory', exact: true }).click();
    await page.getByLabel('Canvas zoom', { exact: true }).selectOption('fit');
    assert.ok(await page.locator('#canvas').evaluate(node => Math.abs(node.clientWidth - node.closest('.canvas-scroll').clientWidth) <= 1));
    assert.equal(await page.locator('.canvas-scroll').evaluate(node => node.scrollWidth <= node.clientWidth + 2), true);
    await page.reload(); await page.locator('.surface-module').first().waitFor();
    assert.equal((await saved(page)).pages[0].name, 'Performance'); assert.equal((await saved(page)).canvas.width, fixture.canvas.width);
    await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    console.log(`Workspace artifacts: ${artifacts}`);
  } catch (error) {
    await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }); console.error({ artifacts, errors }); throw error;
  } finally { await browser.close(); }
});

test('runtime tools retain drafts; live output is explicit, identity-guarded and blocked by edits', options, async () => {
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], writes = [], live = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.route('**/api/bank-control', async route => { live.push(route.request().postDataJSON()); await route.fulfill({ json: { ok: true } }); });
  try {
    await page.goto(`${base}/workspace`); await page.locator('.live-module').first().waitFor();
    assert.ok((await saved(page)).modules.every(module => module.runtimeBank)); assert.deepEqual(writes, []);
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Perform', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.mode === 'perform');
    const liveResponse = page.waitForResponse(response => response.url().endsWith('/api/bank-control'));
    const dial = page.getByRole('slider', { name: /live value/ }).first(); await dial.focus(); await dial.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('#runtimeStatus').textContent.includes('OUTPUT ON'));
    await liveResponse;
    assert.equal(live.length, 1); assert.ok(live[0].expected.binding); assert.deepEqual(live[0].expected.channels, [1, 3]);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('.assignment-chip').first().click(); await page.locator('#inspectorBody').getByRole('button', { name: 'Channel 6', exact: true }).click();
    await page.getByRole('button', { name: 'Stage strip edits in rig tools →', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#runtimeDraftStatus').textContent.includes('Unsaved'));
    const frame = page.frames().find(item => item.url().includes('embedded=true'));
    assert.deepEqual(await frame.evaluate(() => bankDraft.banks[0].channels), [1, 3, 6]);
    assert.equal(await frame.locator('#appSidebar').isVisible(), false);
    const tools = [['∿ MOD', '#group-sidechain'], ['⇄ Routing', '#group-controls'], ['◷ Clock', '#group-clock'], ['⌘ Devices', '#workspace-devices'], ['≋ Activity', '#workspace-activity'], ['◈ Snapshots', '#snapshotsDisclosure']];
    for (const [name, selector] of tools) { await page.getByRole('button', { name, exact: true }).click(); await frame.locator(selector).waitFor({ state: 'visible' }); }
    assert.deepEqual(await frame.evaluate(() => bankDraft.banks[0].channels), [1, 3, 6]);
    await page.getByRole('button', { name: '▦ Canvas', exact: true }).click(); await page.getByRole('button', { name: 'Perform', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('unsaved or staged'));
    assert.equal(await page.locator('#performMode').getAttribute('aria-pressed'), 'false');
    assert.equal(writes.length, 2); assert.ok(writes[1].endsWith('/api/surfaces/validate-strip')); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('legacy browser sketches migrate without losing direct routes or old storage', options, async () => {
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const legacy = { version: 1, name: 'Legacy rig', surfaces: [{ id: 'hardware', name: 'Old controller', input: 'USB', color: 'mint', pages: [{ id: 'page', name: 'Main', modules: [{ id: 'module', name: 'Old encoders', kind: 'knob', color: 'mint', x: 0, y: 0, width: 6, columns: 1, controls: [{ id: 'control', name: '<img src=x onerror=alert(1)>', value: 42, source: { type: 'cc', channel: 2, number: 8 }, targets: [{ id: 'target', device: 'Old synth', parameter: 'Cutoff', channel: 4, cc: 74, min: 12, max: 100, invert: true }] }] }] }] }] };
  await page.addInitScript(value => localStorage.setItem('midibrain.surfaces.v1', JSON.stringify(value)), legacy);
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    await page.getByRole('slider').focus(); await page.getByRole('slider').press('ArrowRight');
    const doc = await saved(page); assert.equal(doc.version, 3); assert.equal(doc.modules[0].controls[0].bindings.normal.value, 43);
    assert.deepEqual(doc.modules[0].controls[0].bindings.normal.targets, legacy.surfaces[0].pages[0].modules[0].controls[0].targets);
    assert.equal(await page.evaluate(() => localStorage.getItem('midibrain.surfaces.v1')), JSON.stringify(legacy));
  } finally { await browser.close(); }
});

test('changed definitions, restarted engines and disconnects cannot silently resume live output', options, async () => {
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  const response = await page.request.get(`${base}/api/surfaces/runtime`), original = await response.json();
  let snapshot = structuredClone(original), offline = false;
  const writes = []; page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.route('**/api/surfaces/runtime', route => offline ? route.abort() : route.fulfill({ json: snapshot }));
  try {
    await page.goto(`${base}/workspace`); await page.locator('.live-module').first().waitFor();
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Perform', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.mode === 'perform');
    snapshot.active.devices.find(device => device.kind === 'destination').output = 'Changed destination';
    await page.waitForFunction(() => document.body.dataset.mode === 'build');
    assert.equal(await page.locator('#performMode').getAttribute('aria-pressed'), 'false');
    snapshot = structuredClone(original); snapshot.instance_id = 'restarted-instance';
    await page.waitForFunction(() => document.body.dataset.mode === 'build');
    await page.waitForTimeout(1200); assert.equal(await page.locator('#performMode').getAttribute('aria-pressed'), 'false');
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Perform', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.mode === 'perform');
    offline = true; await page.waitForFunction(() => document.body.dataset.mode === 'build');
    offline = false; await page.waitForTimeout(1200);
    assert.equal(await page.locator('#performMode').getAttribute('aria-pressed'), 'false'); assert.deepEqual(writes, []);
  } finally { await browser.close(); }
});

test('corrupt browser storage is preserved until an explicit recovery choice', options, async () => {
  const browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
  await page.addInitScript(() => localStorage.setItem('midibrain.surfaces.v3', 'invalid'));
  try {
    await page.goto(`${base}/workspace`); await page.locator('.surface-module').first().waitFor();
    await page.getByRole('slider').first().focus(); await page.getByRole('slider').first().press('ArrowRight');
    assert.equal(await page.evaluate(() => localStorage.getItem('midibrain.surfaces.v3')), 'invalid');
  } finally { await browser.close(); }
});
