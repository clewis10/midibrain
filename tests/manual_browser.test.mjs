import test from 'node:test';
import assert from 'node:assert/strict';

let chromium;
try { ({ chromium } = await import(process.env.MIDIBRAIN_PLAYWRIGHT || 'playwright')); }
catch (error) { if (process.env.MIDIBRAIN_PLAYWRIGHT) throw error; }
const base = process.env.MIDIBRAIN_SURFACE_URL || 'http://127.0.0.1:8790';
const options = { timeout: 45000, skip: !chromium && 'Optional: install Playwright or set MIDIBRAIN_PLAYWRIGHT' };

async function reader(run, prepare = () => {}, viewport = { width: 1440, height: 1000 }) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport });
  const errors = [], external = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    if (!request.url().startsWith(`${base}/`)) { external.push(request.url()); return route.abort(); }
    if (request.method() !== 'GET') writes.push(request.url());
    return route.continue();
  });
  try {
    await prepare(page);
    await run(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, [], 'the bundled manual makes no external requests');
    assert.deepEqual(writes, [], 'the reader never writes to the runtime');
  } finally { await browser.close(); }
}

test('manual search navigates to sections, supports history and is fully local', options, async () => {
  await reader(async page => {
    await page.goto(`${base}/manual`);
    await page.locator('#article h1').waitFor();
    const bundle = await (await page.request.get(`${base}/api/manual`)).json();
    assert.equal(await page.locator('#pages [data-page]').count(), bundle.pages.length);
    await page.getByLabel('Search the wiki', { exact: true }).fill('feedback');
    await page.locator('#results .result').first().waitFor();
    assert.equal(await page.locator('#results .result').first().getAttribute('href'), '#feedback');
    assert.ok(await page.locator('#results mark').count() > 0);
    await page.locator('#results .result').first().click();
    await page.waitForURL('**/manual#feedback');
    await page.getByRole('heading', { name: 'FEEDBACK', exact: true }).waitFor();
    assert.equal(await page.locator('#article h1').textContent(), 'FEEDBACK');
    await page.waitForFunction(() => document.activeElement?.id === 'article');
    await page.locator('#headings a[href="#feedback/values-and-layers"]').click();
    await page.waitForURL('**/manual#feedback/values-and-layers');
    await page.goBack();
    await page.waitForURL('**/manual#feedback');
    await page.waitForFunction(() => document.activeElement?.id === 'article');
    await page.keyboard.press('Control+k');
    assert.equal(await page.locator('#search').evaluate(node => node === document.activeElement), true);
    await page.locator('#search').fill('no midi');
    await page.locator('#search').press('Enter');
    await page.waitForURL('**/manual#troubleshooting/no-midi');
    await page.getByRole('heading', { name: 'Troubleshooting', exact: true }).waitFor();
    assert.equal(await page.locator('#search').inputValue(), '');
    await page.reload();
    await page.locator('#article #no-midi').waitFor();
    assert.equal(await page.locator('#source').getAttribute('href'), '/manual/source/troubleshooting.md');
    assert.equal(await page.locator('#openTab').getAttribute('href'), '/manual#troubleshooting/no-midi');
  });
});

test('no results, unknown pages and missing sections offer a usable way back', options, async () => {
  await reader(async page => {
    await page.goto(`${base}/manual#missing-page`);
    await page.getByRole('heading', { name: 'Page not found' }).waitFor();
    await page.getByRole('link', { name: 'Go to the wiki home' }).click();
    await page.getByRole('heading', { name: 'MIDIBRAIN wiki', exact: true }).waitFor();
    await page.locator('#search').fill('<img onerror=alert(1)> unfindableterm');
    await page.locator('#searchStatus').filter({ hasText: 'No matching pages' }).waitFor();
    assert.equal(await page.locator('#results img, #results script').count(), 0);
    await page.locator('#search').press('Escape');
    assert.equal(await page.locator('#browse').isVisible(), true);
    await page.goto(`${base}/manual#keyboard/missing-section`);
    await page.locator('#article .reader-error').waitFor();
    assert.equal(await page.locator('#article h1').textContent(), 'Keyboard route');
  });
});

test('a failed bundle load can be retried without reloading the app', options, async () => {
  await reader(async page => {
    await page.goto(`${base}/manual`);
    await page.locator('#retry').waitFor({ state: 'visible' });
    assert.match(await page.locator('#loadStatus').textContent(), /could not be loaded/);
    await page.locator('#retry').click();
    await page.locator('#article h1').waitFor();
    assert.equal(await page.locator('#search').isEnabled(), true);
  }, async page => {
    let requests = 0;
    await page.route('**/api/manual', route => ++requests === 1 ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
  });
});

test('the narrow reader keeps tables contained and search usable', options, async () => {
  await reader(async page => {
    await page.goto(`${base}/manual#glossary`);
    await page.locator('#article table').waitFor();
    assert.equal(await page.locator('#browse').getAttribute('open'), null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('/');
    await page.locator('#search').fill('transpose');
    await page.locator('#results .result').first().waitFor();
    await page.locator('#results .result').first().click();
    await page.waitForURL('**/manual#keyboard/range-transpose-and-scale');
    assert.equal(await page.locator('#results').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }, undefined, { width: 390, height: 844 });
});


test('Topics, A–Z, breadcrumbs, subtopics and backlinks form a browsable wiki', options, async () => {
  await reader(async page => {
    await page.goto(`${base}/manual#modulation`);
    await page.getByRole('heading', { name: 'MOD', exact: true }).waitFor();
    assert.equal(await page.locator('#breadcrumbs').innerText(), 'Wiki\nMOD');
    assert.equal(await page.locator('#branch-modulation').isVisible(), true);
    await page.locator('#children a[href="#sidechain"]').click();
    await page.waitForURL('**/manual#sidechain');
    await page.getByRole('heading', { name: 'Example: sidechain ducking', exact: true }).waitFor();
    assert.match(await page.locator('#breadcrumbs').innerText(), /Wiki[\s\S]*MOD[\s\S]*Example: sidechain ducking/);
    assert.equal(await page.locator('#category').textContent(), 'Example');
    assert.equal(await page.locator('#pages [data-page="sidechain"]').getAttribute('aria-current'), 'page');
    await page.locator('#azMode').click();
    assert.equal(await page.locator('#azMode').getAttribute('aria-pressed'), 'true');
    const titles = await page.locator('#pages [data-page]').allTextContents();
    assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
    await page.locator('#pages [data-page="feedback"]').click();
    await page.waitForURL('**/manual#feedback');
    await page.getByRole('heading', { name: 'FEEDBACK', exact: true }).waitFor();
    await page.locator('#backlinksSection summary').click();
    await page.locator('#backlinks a[href="#mappings"]').click();
    await page.getByRole('heading', { name: 'Control', exact: true }).waitFor();
    await page.locator('#topicsMode').click();
    assert.equal(await page.locator('#branch-controllers').isVisible(), true);
    assert.equal(await page.locator('#branch-strips').isVisible(), true);
    await page.getByRole('button', { name: 'Subtopics of Controller', exact: true }).click();
    assert.equal(await page.locator('#branch-controllers').isVisible(), false);
    await page.getByRole('button', { name: 'Subtopics of Controller', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#branch-controllers').isVisible(), true);
  });
});

test('old section bookmarks redirect to the focused entry and keep browser history usable', options, async () => {
  await reader(async page => {
    await page.goto(`${base}/manual#mappings/feedback`);
    await page.waitForURL('**/manual#feedback');
    await page.getByRole('heading', { name: 'FEEDBACK', exact: true }).waitFor();
    assert.equal(await page.locator('#article .reader-error').count(), 0);
    assert.equal(await page.locator('#source').getAttribute('href'), '/manual/source/feedback.md');
    await page.locator('#related a[href="#device-sync"]').click();
    await page.waitForURL('**/manual#device-sync');
    await page.goBack();
    await page.waitForURL('**/manual#feedback');
    await page.locator('#search').fill('sidechain');
    await page.locator('#results .result').first().waitFor();
    assert.equal(await page.locator('#results .result-context').first().textContent(), 'MOD · Example');
  });
});
