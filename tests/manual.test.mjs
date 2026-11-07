import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { makeIndex, parseMarkdown, readHash, pageHash, linkTarget, searchPages, resolveTopic, topicTrail, pageRelations } from '../src/midibrain/performance/manual-model.mjs';
import { TOPICS, WIRE_TOPICS, SECTION_TOPICS, FIELD_TOPICS, PANEL_TOPICS, ADD_TOPICS, inspectorTopic, sectionTopic, fieldTopic, manualHref } from '../src/midibrain/performance/manual-context.mjs';
import { WIRE_KINDS, NODE_TYPES } from '../src/midibrain/performance/patch-model.mjs';

const directory = new URL('../src/midibrain/performance/manual/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const pages = makeIndex(manifest.pages.map(page => ({ ...page, markdown: readFileSync(new URL(`${page.id}.md`, directory), 'utf8') })));
const ids = new Set(pages.map(page => page.id));

function resolves(topic) {
  const [id, anchor] = topic.split('#');
  const page = pages.find(page => page.id === id);
  assert.ok(page, `Missing manual page: ${topic}`);
  if (anchor) assert.ok(page.headings.some(heading => heading.id === anchor), `Missing manual anchor: ${topic}`);
}

test('the manifest includes every article once and every internal link resolves', () => {
  assert.equal(ids.size, pages.length);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.md')).sort(), pages.map(page => `${page.id}.md`).sort());
  for (const page of pages) {
    assert.match(page.id, /^[a-z0-9-]+$/);
    assert.equal(page.headings.filter(h => h.level === 1).length, 1, page.id);
    assert.equal(page.headings[0].title, page.title);
    assert.ok(page.summary && page.section && page.keywords.length, page.id);
    assert.ok(['guide', 'reference', 'example'].includes(page.kind), page.id);
    if (page.parent) {
      assert.ok(ids.has(page.parent), `Missing parent: ${page.id}`);
      const trail = topicTrail(pages, page.id);
      assert.equal(trail[0].parent, null, `Cyclic parent: ${page.id}`);
      assert.equal(trail.at(-1).id, page.id);
    }
    for (const match of page.markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = match[1];
      assert.ok(linkTarget(href, page.id), `Unsupported link: ${page.id}: ${href}`);
      if (href.startsWith('#')) resolves(`${page.id}${href}`);
      else if (!/^https?:/.test(href)) resolves(href.replace('.md', ''));
    }
  }
});

test('every node, wire and documented inspector section has a valid help target', () => {
  for (const topic of [...Object.values(TOPICS), ...Object.values(WIRE_TOPICS), ...Object.values(SECTION_TOPICS), ...Object.values(FIELD_TOPICS), ...Object.values(PANEL_TOPICS), ...Object.values(ADD_TOPICS)]) resolves(topic);
  for (const kind of WIRE_KINDS) {
    assert.ok(WIRE_TOPICS[kind], kind);
    assert.equal(inspectorTopic({ type: 'wire', id: 'w' }, { nodes: [], wires: [{ id: 'w', kind }] }), WIRE_TOPICS[kind]);
  }
  for (const type of NODE_TYPES) {
    assert.ok(TOPICS[type], type);
    assert.equal(inspectorTopic({ type: 'node', id: 'n' }, { nodes: [{ id: 'n', type }], wires: [] }), TOPICS[type]);
  }
  assert.equal(inspectorTopic({ type: 'bank', id: 'b', focus: '0:normal' }), 'mappings');
  assert.equal(inspectorTopic({ type: 'bank', id: 'b' }), 'strips');
  assert.equal(inspectorTopic({ type: 'input', id: 'k', key: 'keys' }, { nodes: [{ id: 'ctl:k', inputs: [{ key: 'keys', binding: { type: 'note', number: null } }] }], wires: [] }), 'keyboard');
  assert.equal(sectionTopic('FEEDBACK ⇄ back to controller'), 'feedback');
  assert.equal(sectionTopic('Global inputs · 6'), 'global-input');
  assert.equal(sectionTopic('Unrelated heading'), null);
  assert.equal(manualHref('feedback'), '/manual#feedback');
  assert.equal(manualHref('modulation#timing'), '/manual#modulation/timing');
  assert.equal(sectionTopic('IN ⇠ what it sends back (optional)', 'devices'), 'device-sync');
  assert.equal(sectionTopic('IN · what it sends', 'controllers'), 'controllers#settings');
  assert.equal(sectionTopic('IN · controller / source', 'midi-thru'), 'midi-thru#create-a-route');
  assert.equal(fieldTopic('Timing', 'modulation'), 'modulation#timing');
  assert.equal(fieldTopic('Timing', 'actions'), 'clock#next-bar-actions');
  assert.equal(inspectorTopic({ type: 'wire', id: 'w' }, { nodes: [], wires: [{ id: 'w', kind: 'strip', index: 0 }] }), 'mappings');
  assert.equal(inspectorTopic({ type: 'node', id: 'd', channel: 1 }, { nodes: [{ id: 'd', type: 'device' }], wires: [] }), 'channels');
});

test('full-text search ranks feature names, symptoms and section matches', () => {
  for (const [query, expected] of [['feedback', 'feedback'], ['no midi', 'troubleshooting'], ['transpose', 'keyboard'], ['layer switch', 'layer-switch'], ['sidechain', 'sidechain'], ['next bar', 'snapshots']]) {
    const results = searchPages(pages, query);
    assert.equal(results[0]?.page.id, expected, query);
    resolves(`${results[0].page.id}${results[0].anchor ? '#' + results[0].anchor : ''}`);
    assert.ok(results[0].excerpt.length < 225);
  }
  assert.ok(searchPages(pages, 'fixed velocity').some(result => result.page.id === 'keyboard'), 'body-only multiword search');
  assert.ok(searchPages(pages, 'passthrough').some(result => result.page.id === 'midi-thru'), 'keyword aliases');
  assert.equal(searchPages(pages, 'FEEDBACK')[0].page.id, 'feedback');
  assert.deepEqual(searchPages(pages, 'feedback unfindableterm'), [], 'all words required');
  for (const query of ['', '   ', '???', 'no-such-unfindableterm']) assert.deepEqual(searchPages(pages, query), []);
});

test('reader hashes and Markdown links keep page and section navigation', () => {
  assert.deepEqual(readHash(pageHash('mappings', 'feedback')), { id: 'mappings', anchor: 'feedback' });
  assert.deepEqual(readHash(''), { id: 'index', anchor: '' });
  assert.deepEqual(readHash('#%zz'), { id: '', anchor: '' });
  assert.deepEqual(linkTarget('keyboard.md#expression', 'index'), { href: '#keyboard/expression', external: false });
  assert.deepEqual(linkTarget('#feedback', 'mappings'), { href: '#mappings/feedback', external: false });
  assert.equal(linkTarget('../profile.json', 'index'), null);
  assert.equal(linkTarget('javascript:alert(1)', 'index'), null);
  assert.equal(linkTarget('//example.com', 'index'), null);
});

test('Markdown supports the documented subset and escapes executable content', () => {
  const text = '# A title\n\n## A section\n\nA **strong** and *soft* `code` [link](mappings.md#feedback).\n\n- first\n- second\n\n1. one\n2. two\n\n| Key | Value |\n| --- | --- |\n| A | B |\n\n> A note\n\n```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)> [bad](javascript:alert) [safe](https://example.com)\n\n## A section';
  const result = parseMarkdown(text);
  for (const fragment of ['<strong>strong</strong>', '<em>soft</em>', '<code>code</code>', 'href="#mappings/feedback"', '<ul>', '<ol>', '<table>', '<th scope="col">', '<blockquote>', '<pre><code>', 'id="a-section-1"']) assert.ok(result.html.includes(fragment), fragment);
  assert.ok(!result.html.includes('<script>'));
  assert.ok(!result.html.includes('<img'));
  assert.ok(!result.html.includes('href="javascript:'));
  assert.match(result.html, /rel="noopener noreferrer"/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.deepEqual(result.headings.map(h => h.id), ['a-title', 'a-section', 'a-section-1']);
});


test('app panels, Add objects and important settings have dedicated searchable entries', () => {
  const html = readFileSync(new URL('../src/midibrain/performance/patch.html', import.meta.url), 'utf8');
  for (const [attribute, topics] of [['tab', PANEL_TOPICS], ['add', ADD_TOPICS]]) {
    const values = [...html.matchAll(new RegExp(`data-${attribute}="([^"]+)"`, 'g'))].map(match => match[1]);
    assert.deepEqual(new Set(values), new Set(Object.keys(topics)), attribute);
  }
  for (const id of new Set([...Object.values(PANEL_TOPICS), ...Object.values(ADD_TOPICS), 'channels', 'feedback', 'device-sync', 'layers', 'layer-switch', 'parameters', 'volume', 'mod-shapes', 'mod-destinations', 'mod-mod', 'note-modulation', 'midi-monitor'])) {
    const page = pages.find(item => item.id === id);
    assert.equal(searchPages(pages, page.title)[0]?.page.id, id, `Exact UI title: ${page.title}`);
  }
  const source = readFileSync(new URL('../src/midibrain/performance/patch.js', import.meta.url), 'utf8');
  for (const [label, topic] of Object.entries(FIELD_TOPICS)) {
    assert.ok(source.includes(`'${label}'`), `Field no longer present in Patch: ${label}`);
    assert.ok(pages.find(page => page.id === topic.split('#')[0]).markdown.toLowerCase().includes(label.toLowerCase()), `Field absent from linked entry: ${label}`);
  }
});

test('wiki hierarchy, related entries and backlinks connect the actual app objects', () => {
  assert.deepEqual(topicTrail(pages, 'feedback').map(page => page.title), ['Controller', 'Strip', 'Control', 'FEEDBACK']);
  const example = pages.find(page => page.id === 'sidechain');
  assert.equal(example.parent, 'modulation'); assert.equal(example.kind, 'example');
  assert.ok(pageRelations(pages, 'modulation').children.includes(example));
  const related = pageRelations(pages, 'feedback');
  assert.ok(related.related.some(page => page.id === 'device-sync'));
  assert.ok(related.backlinks.some(page => page.id === 'mappings'));
  for (const page of pages) {
    if (page.id !== 'index') assert.ok(pageRelations(pages, page.id).backlinks.length, `No incoming article links: ${page.id}`);
  }
  assert.deepEqual(pageRelations(pages, 'missing'), { children: [], related: [], backlinks: [] });
});

test('moved sections have valid legacy redirects without losing the correct topic', () => {
  for (const [from, to] of Object.entries(manifest.redirects)) {
    resolves(to);
    const [id, anchor = ''] = from.split('#');
    const resolved = resolveTopic(pageHash(id, anchor), manifest.redirects);
    const [expectedId, expectedAnchor = ''] = to.split('#');
    assert.deepEqual(resolved, { id: expectedId, anchor: expectedAnchor }, from);
    assert.notEqual(from, to);
  }
  assert.deepEqual(resolveTopic('#mappings/feedback', manifest.redirects), { id: 'feedback', anchor: '' });
  assert.deepEqual(resolveTopic('#modulation/triggering', manifest.redirects), { id: 'triggers', anchor: '' });
  assert.deepEqual(resolveTopic('#keyboard/expression', manifest.redirects), { id: 'keyboard', anchor: 'expression' });
});
