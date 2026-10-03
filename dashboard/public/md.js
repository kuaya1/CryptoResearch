// Safe Markdown reader for original reports. Produces DOM nodes with textContent
// only: no HTML from the report is ever interpreted, and links are limited to
// http(s). Report text is data; any instructions inside it are just text.

import { h, safeUrl, tagChip } from './ui.js';

// Inline marks: code, bold, links (http(s) only), bare URLs, italics, and the
// evidence tags [V] [C] [I] [S] as tag chips, so a checked fact, a project
// claim, an inference and a speculation stand apart while reading.
function inline(text) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*]*\*)|\[([VCIS])\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('code', null, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', null, inline(m[2].slice(2, -2))));
    else if (m[3]) {
      const label = m[3].slice(1, m[3].indexOf(']('));
      out.push(safeUrl(m[4]) ? h('a', { href: m[4] }, label) : label);
    } else if (m[5]) out.push(safeUrl(m[5]) ? h('a', { href: m[5] }, m[5]) : m[5]);
    else if (m[6]) out.push(h('em', null, inline(m[6].slice(1, -1))));
    else if (m[7]) out.push(tagChip(m[7]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

export function renderMarkdown(text) {
  const root = h('div', { class: 'report-body' });
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) root.appendChild(h('p', null, inline(para.join(' '))));
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      root.appendChild(h('pre', null, h('code', null, body.join('\n'))));
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1].length + 2);
      root.appendChild(h(`h${level}`, null, inline(heading[2].replace(/\s#+\s*$/, ''))));
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      root.appendChild(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, head.map((c) => h('th', null, inline(c))))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c)))))))));
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      root.appendChild(h('blockquote', null, inline(body.join(' '))));
      continue;
    }
    const bullet = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flush();
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*([-*•]|\d+[.)])\s+(.*)$/);
        if (!b) break;
        items.push(h('li', null, inline(b[2])));
        i++;
      }
      root.appendChild(h(ordered ? 'ol' : 'ul', { class: 'list' }, items));
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      root.appendChild(h('hr', { class: 'soft' }));
      i++;
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return root;
}
