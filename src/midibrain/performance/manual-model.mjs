// A deliberately small Markdown subset and full-text index. No HTML from an
// article or query is trusted. Pure functions keep links/search testable in Node.
export const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
export const slug = value => normalize(value).replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/[\s-]+/g, '-');
export const plainText = value => value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '');

export function pageHash(id, anchor = '') {
  return `#${encodeURIComponent(id)}${anchor ? `/${encodeURIComponent(anchor)}` : ''}`;
}
export function readHash(hash) {
  try {
    const [id = 'index', anchor = ''] = hash.replace(/^#/, '').split('/').map(decodeURIComponent);
    return { id: id || 'index', anchor };
  } catch { return { id: '', anchor: '' }; }
}
// Keep shared/bookmarked links useful when a section becomes its own entry.
export function resolveTopic(hash, redirects = {}) {
  let topic = readHash(hash);
  const seen = new Set();
  while (true) {
    const key = `${topic.id}${topic.anchor ? `#${topic.anchor}` : ''}`;
    const destination = redirects[key];
    if (!destination || seen.has(key)) return topic;
    seen.add(key);
    const [id, anchor = ''] = destination.split('#');
    topic = { id, anchor };
  }
}
export function linkTarget(href, pageId) {
  const internal = href.match(/^([a-z0-9-]+)\.md(?:#([a-z0-9-]+))?$/);
  if (internal) return { href: pageHash(internal[1], internal[2]), external: false };
  if (/^#[a-z0-9-]+$/.test(href)) return { href: pageHash(pageId, href.slice(1)), external: false };
  if (/^https?:\/\//i.test(href)) return { href, external: true };
  return null;
}

function inline(text, pageId) {
  const tokens = /`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let result = '', offset = 0;
  for (const match of text.matchAll(tokens)) {
    result += escapeHTML(text.slice(offset, match.index));
    if (match[1] !== undefined) result += `<code>${escapeHTML(match[1])}</code>`;
    else if (match[2] !== undefined) {
      const target = linkTarget(match[3], pageId);
      result += target ? `<a href="${escapeHTML(target.href)}"${target.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHTML(match[2])}</a>` : escapeHTML(match[2]);
    } else if (match[4] !== undefined) result += `<strong>${escapeHTML(match[4])}</strong>`;
    else result += `<em>${escapeHTML(match[5])}</em>`;
    offset = match.index + match[0].length;
  }
  return result + escapeHTML(text.slice(offset));
}

export function parseMarkdown(markdown, pageId = 'index') {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const html = [], headings = [], sections = [], used = new Map();
  let section = { title: '', anchor: '', text: '' };
  sections.push(section);
  const addText = text => { section.text += `${plainText(text)} `; };
  const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  const tableRule = line => /^\|?\s*:?-{3,}:?\s*\|/.test(line || '') && cells(line).every(cell => /^:?-{3,}:?$/.test(cell));
  const listItem = line => line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
  const blockStart = index => /^(?:#{1,6}\s|```|>\s?)/.test(lines[index]) || listItem(lines[index]) || tableRule(lines[index + 1]);
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      if (i < lines.length) i++;
      html.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`); addText(code.join(' ')); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const title = plainText(heading[2]), base = slug(title), count = used.get(base) || 0;
      used.set(base, count + 1);
      const id = count ? `${base}-${count}` : base, level = heading[1].length;
      headings.push({ id, title, level }); section = { title, anchor: id, text: '' }; sections.push(section);
      html.push(`<h${level} id="${escapeHTML(id)}" tabindex="-1">${inline(heading[2], pageId)}</h${level}>`); i++; continue;
    }
    if (line.includes('|') && tableRule(lines[i + 1])) {
      const headers = cells(line); i += 2;
      let rows = '';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows += `<tr>${cells(lines[i]).map(cell => `<td>${inline(cell, pageId)}</td>`).join('')}</tr>`;
        addText(lines[i++]);
      }
      addText(line);
      html.push(`<div class="table-scroll"><table><thead><tr>${headers.map(cell => `<th scope="col">${inline(cell, pageId)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`); continue;
    }
    const item = listItem(line);
    if (item) {
      const ordered = Boolean(item[2]), tag = ordered ? 'ol' : 'ul'; let rows = '';
      while (i < lines.length) {
        const next = listItem(lines[i]);
        if (!next || Boolean(next[2]) !== ordered) break;
        rows += `<li>${inline(next[3], pageId)}</li>`; addText(next[3]); i++;
      }
      html.push(`<${tag}>${rows}</${tag}>`); continue;
    }
    if (line.startsWith('>')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) quote.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote><p>${inline(quote.join(' '), pageId)}</p></blockquote>`); addText(quote.join(' ')); continue;
    }
    const paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !blockStart(i)) paragraph.push(lines[i++]);
    html.push(`<p>${inline(paragraph.join(' '), pageId)}</p>`); addText(paragraph.join(' '));
  }
  return { html: html.join('\n'), headings, sections: sections.filter(item => item.text || item.title) };
}

export function makeIndex(pages) {
  return pages.map(page => {
    const parsed = parseMarkdown(page.markdown, page.id);
    const links = [...new Set([...page.markdown.matchAll(/\[[^\]]+\]\(([a-z0-9-]+)\.md(?:#[a-z0-9-]+)?\)/g)].map(match => match[1]))];
    return { ...page, ...parsed, links, searchTitle: normalize(page.title),
      searchKeywords: normalize((page.keywords || []).join(' ')),
      searchText: normalize(`${page.summary} ${parsed.sections.map(s => `${s.title} ${s.text}`).join(' ')}`) };
  });
}

export function topicTrail(pages, id) {
  const trail = [], seen = new Set();
  let page = pages.find(item => item.id === id);
  while (page && !seen.has(page.id)) {
    trail.unshift(page); seen.add(page.id);
    page = pages.find(item => item.id === page.parent);
  }
  return trail;
}

export function pageRelations(pages, id) {
  const page = pages.find(item => item.id === id);
  if (!page) return { children: [], related: [], backlinks: [] };
  const children = pages.filter(item => item.parent === id);
  const excluded = new Set([id, 'index', ...children.map(item => item.id), ...topicTrail(pages, id).map(item => item.id)]);
  return {
    children,
    related: pages.filter(item => !excluded.has(item.id) && page.links.includes(item.id)),
    backlinks: pages.filter(item => item.id !== id && item.links.includes(id)),
  };
}
export const queryTerms = query => [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) || [])].slice(0, 20);

export function searchPages(pages, query) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const phrase = normalize(query.trim());
  return pages.flatMap(page => {
    const all = `${page.searchTitle} ${page.searchKeywords} ${page.searchText}`;
    if (!terms.every(term => all.includes(term))) return [];
    const ranked = page.sections.map(section => {
      const heading = normalize(section.title), content = normalize(section.text);
      return { section, score: terms.reduce((sum, term) => sum + (heading.includes(term) ? 24 : 0) + (content.includes(term) ? 6 : 0), 0) + (heading.includes(phrase) ? 35 : 0) };
    }).sort((a, b) => b.score - a.score);
    const section = ranked[0]?.section;
    const text = section?.text.trim() || page.summary;
    const first = Math.min(...terms.map(term => normalize(text).indexOf(term)).filter(index => index >= 0));
    let start = Number.isFinite(first) ? Math.max(0, first - 70) : 0;
    if (start) { const space = text.indexOf(' ', start); if (space >= 0) start = space + 1; }
    const excerpt = `${start ? '…' : ''}${text.slice(start, start + 220)}${text.length > start + 220 ? '…' : ''}`;
    const score = terms.reduce((sum, term) => sum + (page.searchTitle.includes(term) ? 60 : 0) + (page.searchKeywords.includes(term) ? 15 : 0), 0)
      + (page.searchTitle.includes(phrase) ? 120 : 0) + (page.searchTitle === phrase ? 600 : 0) + (ranked[0]?.score || 0);
    // An exact object name opens the whole entry; a body match opens its section.
    const exact = page.searchTitle === phrase;
    return [{ page, score, anchor: exact ? '' : section?.anchor || '', heading: exact ? '' : section?.title || '', excerpt }];
  }).sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title));
}
