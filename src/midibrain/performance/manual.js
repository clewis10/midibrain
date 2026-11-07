import { makeIndex, pageHash, readHash, resolveTopic, topicTrail, pageRelations, searchPages, queryTerms } from '/manual-model.mjs';

const $ = id => document.getElementById(id);
const narrow = () => matchMedia('(max-width: 760px)').matches;
let pages = [], redirects = {}, results = [], searchTimer, browseMode = 'topics';
const expanded = new Set();

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function link(text, hash) { const node = el('a', text); node.href = hash; return node; }
function pageLink(page) {
  const anchor = link(page.title, pageHash(page.id)); anchor.dataset.page = page.id;
  if (page.id === readHash(location.hash).id) anchor.setAttribute('aria-current', 'page');
  return anchor;
}

function renderNavigation() {
  const root = $('pages'); root.replaceChildren();
  $('topicsMode').setAttribute('aria-pressed', String(browseMode === 'topics'));
  $('azMode').setAttribute('aria-pressed', String(browseMode === 'az'));
  function branch(page) {
    const node = el('div', undefined, 'nav-branch'), row = el('div', undefined, 'nav-item');
    const children = pages.filter(item => item.parent === page.id);
    if (children.length) {
      const open = expanded.has(page.id), button = el('button', open ? '▾' : '▸', 'branch-toggle');
      const nested = el('div', undefined, 'nav-children'); nested.id = `branch-${page.id}`; nested.hidden = !open;
      button.type = 'button'; button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-controls', nested.id);
      button.setAttribute('aria-label', `Subtopics of ${page.title}`);
      button.addEventListener('click', () => {
        if (expanded.has(page.id)) expanded.delete(page.id); else expanded.add(page.id);
        nested.hidden = !expanded.has(page.id); button.textContent = nested.hidden ? '▸' : '▾';
        button.setAttribute('aria-expanded', String(!nested.hidden));
      });
      row.append(button, pageLink(page)); node.append(row, nested);
      children.forEach(child => nested.append(branch(child)));
    } else { row.classList.add('nav-leaf'); row.append(pageLink(page)); node.append(row); }
    return node;
  }
  const listed = browseMode === 'az' ? [...pages].sort((a, b) => a.title.localeCompare(b.title)) : pages.filter(page => !page.parent);
  let section, group;
  for (const page of listed) {
    const label = browseMode === 'az' ? page.title[0].toLocaleUpperCase() : page.section;
    if (label !== section) {
      section = label; group = el('section', undefined, 'nav-group');
      group.append(el('h2', section)); root.append(group);
    }
    group.append(browseMode === 'topics' ? branch(page) : pageLink(page));
  }
}

function highlight(node, text, terms) {
  if (!terms.length) { node.textContent = text; return; }
  const regex = new RegExp(terms.join('|'), 'giu');
  let offset = 0;
  for (const match of text.matchAll(regex)) {
    node.append(document.createTextNode(text.slice(offset, match.index)), el('mark', match[0]));
    offset = match.index + match[0].length;
  }
  node.append(document.createTextNode(text.slice(offset)));
}

function search() {
  clearTimeout(searchTimer);
  const query = $('search').value.trim(), terms = queryTerms(query), root = $('results');
  root.replaceChildren(); $('clearSearch').hidden = !query;
  results = query ? searchPages(pages, query) : [];
  root.hidden = !query; $('browse').hidden = Boolean(query);
  $('searchStatus').textContent = !query ? '' : results.length ? `${results.length} matching page${results.length === 1 ? '' : 's'}` : 'No matching pages. Try fewer words or a feature name.';
  for (const result of results) {
    const anchor = link('', pageHash(result.page.id, result.anchor)); anchor.className = 'result';
    const title = el('strong'), excerpt = el('span');
    highlight(title, result.page.title, terms); highlight(excerpt, result.excerpt, terms);
    anchor.append(title);
    const parents = topicTrail(pages, result.page.id).slice(0, -1).map(page => page.title);
    anchor.append(el('small', `${parents.join(' › ') || result.page.section}${result.page.kind === 'example' ? ' · Example' : ''}`, 'result-context'));
    if (result.heading && result.heading !== result.page.title) anchor.append(el('small', result.heading));
    anchor.append(excerpt); root.append(anchor);
  }
}
function clearSearch() { $('search').value = ''; search(); }

function renderRelations(page) {
  const trail = $('breadcrumbs'); trail.replaceChildren();
  if (page && page.id !== 'index') {
    const items = [{ id: 'index', title: 'Wiki' }, ...topicTrail(pages, page.id)];
    const list = el('ol');
    items.forEach((item, index) => {
      const li = el('li');
      if (index === items.length - 1) { li.textContent = item.title; li.setAttribute('aria-current', 'page'); }
      else li.append(link(item.title, pageHash(item.id)));
      list.append(li);
    });
    trail.append(list);
  }
  const relations = pageRelations(pages, page?.id);
  for (const [name, wrapper] of [['children', 'subtopics'], ['related', 'relatedSection'], ['backlinks', 'backlinksSection']]) {
    const root = $(name); root.replaceChildren();
    // The home page already contains the complete hand-written topic index.
    $(wrapper).hidden = !relations[name].length || page?.id === 'index';
    for (const item of relations[name]) {
      const anchor = link('', pageHash(item.id));
      if (name === 'children') anchor.append(el('strong', item.title), el('span', item.summary));
      else anchor.textContent = item.title;
      root.append(anchor);
    }
  }
}

function showPage({ focus = true } = {}) {
  if (!pages.length) return;
  const requested = readHash(location.hash), { id, anchor } = resolveTopic(location.hash, redirects);
  if (id !== requested.id || anchor !== requested.anchor) history.replaceState(null, '', pageHash(id, anchor));
  const page = pages.find(item => item.id === id);
  for (const item of topicTrail(pages, id)) expanded.add(item.id);
  renderNavigation(); renderRelations(page);
  $('loadStatus').hidden = true; $('retry').hidden = true; $('articleView').hidden = false;
  $('headings').replaceChildren();
  $('openTab').href = `/manual${pageHash(id || 'index', anchor)}`;
  $('source').hidden = !page; $('contents').hidden = !page;
  const article = $('article');
  if (!page) {
    document.title = 'Page not found · MIDIBRAIN Wiki';
    $('category').textContent = 'Wiki';
    article.replaceChildren(el('h1', 'Page not found'), el('p', 'This entry is not included in this version of MIDIBRAIN. Browse the wiki or search for the feature.'), link('Go to the wiki home', '#index'));
  } else {
    document.title = `${page.title} · MIDIBRAIN Wiki`;
    $('category').textContent = page.kind === 'example' ? 'Example' : page.kind === 'guide' ? 'Guide' : page.section;
    // parseMarkdown emits only our escaped, allowlisted markup.
    article.innerHTML = page.html;
    for (const heading of page.headings.filter(item => item.level === 2)) $('headings').append(link(heading.title, pageHash(page.id, heading.id)));
    $('contents').hidden = !page.headings.some(item => item.level === 2);
    $('source').href = `/manual/source/${page.id}.md`;
  }
  if (narrow()) { $('browse').open = false; $('contents').open = false; }
  const destination = anchor && article.querySelector(`#${CSS.escape(anchor)}`);
  if (page && anchor && !destination) article.prepend(el('p', 'That section is not in this version of the article. The full page is shown below.', 'reader-error'));
  if (focus) {
    const target = destination || article;
    target.focus({ preventScroll: true });
    if (destination) target.scrollIntoView({ block: 'start' });
    else window.scrollTo({ top: 0 });
  }
}

async function load() {
  $('loadStatus').hidden = false; $('loadStatus').textContent = 'Loading the bundled wiki…';
  $('loadStatus').className = ''; $('retry').hidden = true;
  try {
    const response = await fetch('/api/manual', { signal: AbortSignal.timeout(8000), cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.version !== 1 || !Array.isArray(data.pages) || !data.pages.length) throw new Error('Invalid wiki bundle');
    pages = makeIndex(data.pages); redirects = data.redirects || {}; $('search').disabled = false;
    showPage({ focus: Boolean(location.hash && location.hash !== '#index') });
  } catch (error) {
    $('loadStatus').className = 'reader-error';
    $('loadStatus').textContent = `The wiki could not be loaded. Check that MIDIBRAIN is reachable, then retry. (${error.message})`;
    $('retry').hidden = false;
  }
}

$('topicsMode').addEventListener('click', () => { browseMode = 'topics'; renderNavigation(); });
$('azMode').addEventListener('click', () => { browseMode = 'az'; renderNavigation(); });
$('retry').addEventListener('click', load);
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 90); });
$('clearSearch').addEventListener('click', () => { clearSearch(); $('search').focus(); });
$('searchForm').addEventListener('submit', event => {
  event.preventDefault(); search();
  if (results.length) { const first = results[0]; clearSearch(); location.hash = pageHash(first.page.id, first.anchor); showPage(); }
});
window.addEventListener('hashchange', () => showPage());
document.addEventListener('click', event => {
  const anchor = event.target.closest('a[href^="#"]');
  if (!anchor || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  if (anchor.classList.contains('skip')) { event.preventDefault(); $('article').focus(); return; }
  clearSearch();
  if (anchor.hash === location.hash) { event.preventDefault(); showPage(); }
});
document.addEventListener('keydown', event => {
  const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
  if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing)) {
    event.preventDefault(); $('search').focus(); $('search').select();
  } else if (event.key === 'Escape' && event.target === $('search')) clearSearch();
});
load();
