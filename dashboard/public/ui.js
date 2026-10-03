// DOM helpers and shared components. Everything is built with textContent:
// report content is data and is never inserted as HTML.

export const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
export const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
// Compact labels for grade badges: each grade always names its model.
export const PROVIDER_SHORT = { claude: 'Claude', chatgpt: 'GPT', gemini: 'Gemini' };
const TZ = 'America/New_York';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUS = '−';

// One vocabulary for research states, used by badges, the panel, the
// research pages and receipts.
export const RESEARCH_STATE = {
  none: { short: 'None', long: 'No research yet', tone: '' },
  queued: { short: 'Queued', long: 'Queued: not saved yet', tone: 'wait' },
  running: { short: 'Running', long: 'Running: not saved yet', tone: 'wait' },
  dispatching: { short: 'Running', long: 'Sending to the provider: not saved yet', tone: 'wait' },
  uncertain: { short: 'Check', long: 'Outcome uncertain: the request may have been sent and billed, and no answer was saved. Reconcile it or retry', tone: 'warn' },
  cowork: { short: 'Cowork', long: 'Claude in Cowork is researching it: not saved yet', tone: 'wait' },
  connector: { short: 'Working', long: 'Researching it itself through its desk connection: not saved yet', tone: 'wait' },
  interrupted: { short: 'Paused', long: 'Interrupted: its assistant has not saved this report. Ask it to resume, or restart it', tone: 'warn' },
  manual: { short: 'Waiting', long: 'Waiting for this model: ask its assistant to do its waiting research, or import its answer (no API set up)', tone: 'warn' },
  waiting: { short: 'Manual', long: 'Waiting for you to import this model\'s answer', tone: 'warn' },
  failed: { short: 'Failed', long: 'Failed: nothing was saved for this model', tone: 'bad' },
  canceled: { short: 'Canceled', long: 'Canceled: nothing was saved for this model', tone: '' },
  completed: { short: 'Saved', long: 'Saved as a report', tone: 'ok' },
};

export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  if (u.startsWith('#/') || u.startsWith('/api/')) return u;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) el.value = v;
      else if (k === 'checked' && tag === 'input') el.checked = Boolean(v);
      else if (k === 'href' || k === 'src') {
        const s = safeUrl(String(v));
        if (s) el.setAttribute(k, s);
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  if (tag === 'a' && el.getAttribute('href') && /^https?:/.test(el.getAttribute('href'))) {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

// ---- safe browser storage (per-viewer conveniences only) ----------------

function storageApi(kind) {
  return {
    get(key, fallback = null) {
      try {
        const v = window[kind].getItem(`cr.${key}`);
        return v === null ? fallback : JSON.parse(v);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined) window[kind].removeItem(`cr.${key}`);
        else window[kind].setItem(`cr.${key}`, JSON.stringify(value));
      } catch (_) { /* private window or blocked storage: ignore */ }
    },
  };
}
export const store = storageApi('localStorage');
export const session = storageApi('sessionStorage');

export function submissionId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return `ui${Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---- formatting ---------------------------------------------------------

export function fmtUsd(n, { compact = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (compact) return fmtCompactUsd(n);
  return fmtPrice(n);
}

// Prices keep four significant digits below $1 so small prices stay exact
// enough to read ($0.03364, $0.0004213); larger prices use cents.
export function fmtPrice(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return '$0.00';
  if (abs < 1) {
    const decimals = Math.min(20, 3 - Math.floor(Math.log10(abs)));
    let s = abs.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, '$1');
    if ((s.split('.')[1] || '').length < 2 || Number(s) >= 1) s = abs.toFixed(2);
    return `${n < 0 ? MINUS : ''}$${s}`;
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n).replace('-', MINUS);
}

// Market cap and volume: three significant digits with K/M/B/T.
export function fmtCompactUsd(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? MINUS : '';
  const unit = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([v]) => abs >= v);
  if (!unit) return `${sign}$${abs.toFixed(abs < 10 ? 2 : 0)}`;
  const v = abs / unit[0];
  return `${sign}$${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)}${unit[1]}`;
}

export function fmtNum(n, digits = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(n);
}

export function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function fmtSignedPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return 'unknown';
  const r = Number(n.toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)}%`;
  return `${r > 0 ? '+' : MINUS}${Math.abs(r).toFixed(digits)}%`;
}

export function fmtDate(s) {
  if (!s) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(s) {
  if (!s) return '—';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return `${new Date(t).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
}

export function fmtAgo(s) {
  if (!s) return 'never';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

export function daysSince(s) {
  if (!s) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

// Compact analysis age for badges: today, 6d, 3w, 4mo, 1y.
export function fmtAge(s) {
  const d = daysSince(s);
  if (d === null) return null;
  if (d < 1) return 'today';
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

// ---- small components ----------------------------------------------------

export function chip(text, kind = '', title = null) {
  return h('span', { class: `chip ${kind}`.trim(), title }, text);
}

export function stateText(text, tone = '') {
  return h('span', { class: `state ${tone}`.trim() }, text);
}

export const TAG_TITLES = {
  V: "[V] Checked in that analyst's session. Not checked by this dashboard.",
  C: '[C] Project-claimed.',
  I: '[I] Analyst inference.',
  S: '[S] Speculative forecast.',
};

export function tagChip(tag, raw) {
  if (!tag) return chip(raw ? `?${raw}` : '?', 'tag', 'Unknown evidence tag');
  return chip(`[${tag}]`, 'tag', TAG_TITLES[tag]);
}

export function providerChip(p) {
  return h('span', { class: 'chip' }, PROVIDER_LABELS[p] || p);
}

export function verdictChip(v) {
  if (!v) return h('span', { class: 'faint', title: 'The report did not give one of the six verdict labels' }, 'No verdict');
  return h('span', { class: 'verdict', title: 'Verdict as written by the report' }, v.charAt(0) + v.slice(1).toLowerCase());
}

// Signed rolling change. The sign and arrow carry the meaning; color only reinforces it.
export function changeCell(n, { label = '', digits = 1 } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return h('span', { class: 'unknown', title: `${label} change unknown` }, 'unknown');
  const dir = n > 0 ? 'up' : n < 0 ? 'down' : 'unchanged';
  const arrow = n > 0 ? '▲ ' : n < 0 ? '▼ ' : '';
  return h('span', { class: `chg ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`.trim() },
    h('span', { 'aria-hidden': 'true' }, arrow + fmtSignedPct(n, digits)),
    h('span', { class: 'sr-only' }, `${dir} ${Math.abs(n).toFixed(digits)} percent${label ? `, ${label}` : ''}`));
}

export function sparkline(values, { width = 96, height = 28, label = '7-day price' } = {}) {
  if (!Array.isArray(values) || values.length < 2) return h('span', { class: 'unknown', title: 'No 7-day series from the provider' }, 'no data');
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (width - 2) / (values.length - 1);
  const pts = values.map((v, i) => `${(1 + i * step).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  const change = ((values[values.length - 1] / values[0]) - 1) * 100;
  return svg('svg', { class: 'spark', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${label}: ${fmtSignedPct(change)} from first to last point` },
    svg('polyline', { points: pts, fill: 'none', stroke: 'var(--text-2)', 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
}

const LOGO_GRAYS = ['#3a3a3c', '#48484a', '#5f5f64', '#6e6e73'];

export function logo(p, { size = 28 } = {}) {
  const m = p.market || {};
  const label = (p.symbol || p.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  let hash = 0;
  for (const ch of String(p.project_id || p.name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const box = h('span', { class: 'logo', 'aria-hidden': 'true', style: { background: LOGO_GRAYS[hash % LOGO_GRAYS.length], width: `${size}px`, height: `${size}px` } }, label);
  if (m.logo_url) {
    const img = h('img', { src: m.logo_url, alt: '', loading: 'lazy', width: String(size), height: String(size) });
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => { box.textContent = ''; box.appendChild(img); box.style.background = 'transparent'; });
  }
  return box;
}

// Score cell. direction: 'fav' (higher is better) or 'risk' (higher is more risk).
export function scoreView(s, direction = 'fav', { corrected = null } = {}) {
  const cls = `score ${direction}`;
  const mark = corrected ? chip('corrected', '', `Corrected by you. Original value as written: ${corrected}`) : null;
  if (!s) return h('span', { class: `${cls} unknown`, title: 'Not in this report' }, h('span', { class: 'v' }, '—'));
  if (s.status === 'not_applicable') {
    return h('span', { class: `${cls} na`, title: s.rationale || 'Not applicable' }, h('span', { class: 'v' }, 'N/A'), h('span', { class: 'na' }, 'not applicable'), mark);
  }
  if (s.status === 'unknown') {
    return h('span', { class: `${cls} unknown`, title: s.missing_data || 'Unknown' }, h('span', { class: 'v' }, '?'), h('span', { class: 'na' }, 'unknown'), mark);
  }
  const title = [s.rationale, s.extraction ? `Extracted from prose (line ${s.extraction.line}): ${s.extraction.excerpt}` : null, direction === 'risk' ? 'Higher means more risk' : 'Higher is better'].filter(Boolean).join('\n');
  if (s.status === 'range') {
    // Risk bars grow from the right edge, so a risk range sits low% to high% in from the right.
    const fill = h('span', { class: 'fill', style: direction === 'risk' ? { right: `${s.low}%`, width: `${s.high - s.low}%` } : { left: `${s.low}%`, width: `${s.high - s.low}%` } });
    return h('span', { class: `${cls} range`, title }, h('span', { class: 'v' }, `${s.low}–${s.high}`), h('span', { class: 'track', 'aria-hidden': 'true' }, fill), mark);
  }
  const fill = h('span', { class: 'fill', style: { width: `${Math.max(0, Math.min(100, s.value))}%` } });
  return h('span', { class: cls, title }, h('span', { class: 'v' }, String(s.value)), h('span', { class: 'track', 'aria-hidden': 'true' }, fill), s.extraction ? chip('read from prose', '', 'Read from the prose, not a JSON block. Check against the original.') : null, mark);
}

// The rubric's letter band of a grade (a to f), for its color. A range takes
// the band of its low end. No band without a calculated grade: a withheld or
// missing grade never takes a grade's color.
export function gradeBand(g) {
  if (!g || !['firm', 'range'].includes(g.status)) return null;
  const letter = String(g.label || '').trim().charAt(0).toLowerCase();
  return /^[a-f]$/.test(letter) && letter !== 'e' ? letter : null;
}

export const bandClass = (g) => (gradeBand(g) ? ` band-${gradeBand(g)}` : '');

export function gradeView(g, { compact = false } = {}) {
  if (!g) return h('span', { class: 'faint' }, 'No grade');
  if (g.status === 'firm') {
    return h('div', { class: `grade${bandClass(g)}`, title: `Full precision: ${g.value}. Calculated by this app from the six weighted components.` }, h('span', { class: compact ? 'num' : 'big' }, g.display), g.label ? h('span', { class: 'lab', 'aria-label': `letter ${g.label}` }, g.label) : null);
  }
  if (g.status === 'range') {
    return h('div', { class: `grade${bandClass(g)}`, title: `Range from justified component ranges: ${g.low} to ${g.high}` }, h('span', { class: compact ? 'num' : 'big' }, g.display), h('span', { class: 'lab' }, g.label), h('span', { class: 'faint small' }, 'range'));
  }
  if (g.status === 'withheld') {
    const pct = g.coverage_pct || 0;
    return h('div', { class: 'grade withheld', title: g.reason || '' },
      h('span', { class: compact ? '' : 'big' }, 'Withheld'),
      g.coverage_pct === null || g.coverage_pct === undefined ? null : h('span', { class: 'small muted' }, `${pct}% of the weight scored`),
      compact || g.coverage_pct === null || g.coverage_pct === undefined ? null : h('div', { class: 'coverage', style: { width: '100%' }, 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })));
  }
  return h('span', { class: 'faint', title: g.reason || '' }, g.status === 'invalid_weights' ? 'Weights invalid' : 'No grade');
}

// ---- research grade badges -----------------------------------------------
//
// One badge per model. A missing grade is never shown as zero: the badge
// states why (queued, running, manual, failed, withheld, PDF, none).

// Research a model's own assistant does through the desk connector (Claude in
// Cowork, ChatGPT, Gemini) with no sign of life for this long (no draft, no
// report) is shown as interrupted; the same limit as the desk's
// (core/research.js ASSISTANT_IDLE_MINUTES).
export const COWORK_IDLE_MINUTES = 30;

export const isAssistantJob = (job) => Boolean(job && (job.mode === 'cowork' || job.mode === 'connector'));

export function coworkIdleMinutes(job, runCreatedAt = null) {
  const last = job.progress_at || job.updated_at || runCreatedAt || job.run_created_at;
  const t = last ? Date.parse(last) : NaN;
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
}

export function jobKey(job, runCreatedAt = null) {
  if (!job) return null;
  if (job.state === 'running' && isAssistantJob(job)) {
    const idle = coworkIdleMinutes(job, runCreatedAt);
    return idle !== null && idle >= COWORK_IDLE_MINUTES ? 'interrupted' : job.mode;
  }
  if (job.state === 'unconfigured') return 'manual';
  return job.state;
}

export function badgeInfo(provider, report, job, { staleDays = 90 } = {}) {
  const who = PROVIDER_LABELS[provider];
  const jobOpen = job && ['queued', 'running', 'dispatching', 'uncertain', 'waiting', 'unconfigured'].includes(job.state) && (!report || (job.run_created_at && report.imported_at && job.run_created_at > report.imported_at));
  if (report) {
    const g = report.grade || {};
    const age = daysSince(report.analysis_at);
    const stale = age !== null && age > staleDays;
    const base = { report: true, age: fmtAge(report.analysis_at), date: report.analysis_at, stale, refreshing: Boolean(jobOpen), job: jobOpen ? jobKey(job) : null };
    let out;
    if (report.needs_text) out = { kind: 'pdf', value: 'PDF', label: null, text: `${who}: PDF report saved; a text copy is needed before it can be graded` };
    else if (g.status === 'firm') out = { kind: 'grade', value: g.display, label: g.label, text: `${who} grade ${g.display}${g.label ? `, ${g.label}` : ''}` };
    else if (g.status === 'range') out = { kind: 'range', value: g.display, label: g.label, text: `${who} grade range ${g.display}${g.label ? `, ${g.label}` : ''}` };
    else if (g.status === 'withheld') out = { kind: 'withheld', value: 'Withheld', label: null, text: `${who}: grade withheld${g.coverage_pct !== null && g.coverage_pct !== undefined ? `, ${g.coverage_pct}% of the weight scored` : ''}` };
    else out = { kind: 'withheld', value: 'No grade', label: null, text: `${who}: no authoritative grade${g.reason ? `. ${g.reason}` : ''}` };
    const when = report.analysis_at ? `analysis ${fmtDate(report.analysis_at)}${stale ? ', stale' : ''}` : 'analysis date unknown';
    const extra = jobOpen ? `; newer research ${RESEARCH_STATE[jobKey(job)] ? RESEARCH_STATE[jobKey(job)].short.toLowerCase() : job.state}` : '';
    return { ...base, ...out, text: `${out.text}, ${when}${extra}` };
  }
  const k = jobKey(job);
  if (k && RESEARCH_STATE[k]) {
    const st = RESEARCH_STATE[k];
    return { report: false, kind: k, value: st.short, label: null, age: null, stale: false, refreshing: false, job: k, text: `${who}: ${st.long}${job.error ? `. ${job.error}` : ''}` };
  }
  return { report: false, kind: 'none', value: 'None', label: null, age: null, stale: false, refreshing: false, job: null, text: `${who}: no research yet` };
}

export function gradeBadge(provider, report, job, opts = {}) {
  const info = badgeInfo(provider, report, job, opts);
  const tag = opts.button ? 'button' : 'span';
  const band = info.kind === 'grade' || info.kind === 'range' ? bandClass(report && report.grade) : '';
  const attrs = {
    class: `gb is-${info.kind}${band}${info.stale ? ' is-stale' : ''}`,
    'aria-label': opts.button ? `${info.text}. Open details` : info.text,
    dataset: { provider, key: opts.key || null },
  };
  if (!opts.key) delete attrs.dataset.key;
  if (opts.button) attrs.type = 'button';
  // The model's name (hidden where a column header already names it), then
  // its grade in the band's color, or a plain state. The analysis age shows
  // only when it is stale; the scorecard and panel give the date.
  return h(tag, attrs,
    h('span', { class: 'p', 'aria-hidden': 'true' }, PROVIDER_SHORT[provider]),
    h('span', { class: 'main', 'aria-hidden': 'true' }, h('span', { class: 'v' }, info.value), info.label ? h('span', { class: 'l' }, info.label) : null, info.stale && info.age ? h('span', { class: 'a' }, info.age) : null, info.refreshing ? h('span', { class: 'r' }, '↻') : null));
}

export function freshnessText(status, ageMin) {
  const age = ageMin === null || ageMin === undefined ? '' : ageMin < 60 ? `${ageMin} min` : ageMin < 2880 ? `${Math.round(ageMin / 60)} h` : `${Math.round(ageMin / 1440)} d`;
  const map = {
    fresh: ['Fresh', 'ok'], fresh_partial: ['Fresh, some assets missing', 'warn'], stale: [`Stale${age ? ` · ${age} old` : ''}`, 'warn'],
    missing: ['No price', 'warn'], invalid: ['Invalid data', 'bad'], stale_failed: [`Stale · last refresh failed`, 'bad'],
    fresh_last_failed: ['Last refresh failed', 'warn'], failed: ['Refresh failed', 'bad'], never_run: ['Never fetched', 'warn'],
  };
  const [text, tone] = map[status] || [status || 'Unknown', ''];
  return { text, tone, age };
}

export function freshnessChip(status, ageMin) {
  const f = freshnessText(status, ageMin);
  return stateText(status === 'fresh' && f.age ? `Fresh · ${f.age}` : f.text, f.tone);
}

export function table(columns, rows, { empty = 'Nothing here yet.', rowClass = null, caption = null } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  const thead = h('thead', null, h('tr', null, columns.map((c) => h('th', { class: c.num ? 'num' : null, title: c.title || null, scope: 'col' }, c.label === '' || c.label === null || c.label === undefined ? h('span', { class: 'sr-only' }, c.srLabel || 'Actions') : c.label))));
  const tbody = h('tbody', null, rows.map((r) => {
    if (r && r._group) return h('tr', { class: 'group' }, h('td', { colspan: columns.length }, r._group));
    return h('tr', { class: rowClass ? rowClass(r) : null }, columns.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      return h('td', { class: [c.num ? 'num' : '', c.wrap ? 'wrap' : '', c.nowrap ? 'nowrap' : ''].join(' ').trim() || null }, v === undefined || v === null || v === '' ? h('span', { class: 'faint' }, '—') : v);
    }));
  }));
  return h('div', { class: 'table-wrap' }, h('table', null, caption ? h('caption', { class: 'sr-only' }, caption) : null, thead, tbody));
}

export function card(title, children, { note = null, actions = null, id = null } = {}) {
  return h('section', { class: 'card', id },
    title || note || actions ? h('div', { class: 'card-head' }, h('div', null, typeof title === 'string' ? h('h2', null, title) : title, note ? h('div', { class: 'note' }, note) : null), actions ? h('div', { class: 'actions' }, actions) : null) : null,
    children);
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'field';
}

// Label + control + hint + inline error slot. The control gets a stable name
// (so drafts survive a live refresh) and is described by its hint and error.
export function field(label, inputEl, hint = null, { wide = false, name = null } = {}) {
  const id = inputEl.id || `f_${Math.random().toString(36).slice(2, 9)}`;
  inputEl.id = id;
  if (!inputEl.name && inputEl.tagName !== 'BUTTON') inputEl.name = name || slug(label);
  const hintEl = hint ? h('div', { class: 'hint', id: `${id}-hint` }, hint) : null;
  const errEl = h('div', { class: 'field-error hidden', id: `${id}-err`, role: 'alert' });
  inputEl.setAttribute('aria-describedby', [hintEl ? hintEl.id : null, errEl.id].filter(Boolean).join(' '));
  return h('div', { class: `field${wide ? ' wide' : ''}` }, h('label', { for: id }, label), inputEl, hintEl, errEl);
}

// Shows an error right under its control (and announces it).
export function fieldError(inputEl, message) {
  const err = document.getElementById(`${inputEl.id}-err`);
  if (message) {
    inputEl.setAttribute('aria-invalid', 'true');
    if (err) {
      err.textContent = message;
      err.classList.remove('hidden');
    }
    inputEl.focus();
  } else {
    inputEl.removeAttribute('aria-invalid');
    if (err) {
      err.textContent = '';
      err.classList.add('hidden');
    }
  }
}

export function input(attrs = {}) {
  return h('input', { type: 'text', ...attrs });
}

export function select(options, attrs = {}) {
  return h('select', attrs, options.map((o) => (typeof o === 'string' ? h('option', { value: o }, o) : h('option', { value: o.value, selected: o.selected || null, disabled: o.disabled || null }, o.label))));
}

export function button(text, onClick, { kind = '', title = null, type = 'button', key = null } = {}) {
  return h('button', { type, class: kind || null, title, onclick: onClick, dataset: key ? { key } : null }, text);
}

export function empty(text) {
  return h('div', { class: 'empty' }, text);
}

export function callout(text, kind = 'info') {
  return h('div', { class: `callout ${kind}` }, text);
}

export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? h('span', { class: 'faint' }, '—') : v)]));
}

export function details(summary, body, { open = false, id = null } = {}) {
  return h('details', { class: 'disclosure', open: open || null, id, dataset: id ? { key: id } : null }, h('summary', null, summary), h('div', { class: 'body' }, body));
}

export function link(text, href, attrs = {}) {
  return h('a', { href, ...attrs }, text);
}

export function toast(message, kind = '') {
  const box = document.getElementById('toast');
  const el = h('div', { class: kind }, message);
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 9000 : 4500);
}

// Screen-reader announcement for changes that happen without a page change.
export function announce(text) {
  const el = document.getElementById('sr-live');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 30);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to the clipboard');
  } catch (_) {
    toast('Copy failed: select the text and copy it manually.', 'bad');
  }
}

// Marks a button as working: disabled, aria-busy, and a progress label.
export function busy(btn, on, label = 'Working…') {
  if (on) {
    btn.dataset.label = btn.dataset.label || btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  } else {
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

// Wraps an async action on a button: busy state, then a toast with the result.
export function action(btn, fn, success = null, { busyLabel = 'Working…' } = {}) {
  return async (e) => {
    if (e) e.preventDefault();
    if (btn.getAttribute('aria-busy') === 'true') return null;
    busy(btn, true, busyLabel);
    try {
      const out = await fn();
      if (success && out !== undefined) toast(typeof success === 'function' ? success(out) : success);
      return out;
    } catch (err) {
      toast(err.message || String(err), 'bad');
      return null;
    } finally {
      if (btn.isConnected) busy(btn, false);
    }
  };
}

// Accessible tab strip with roving focus. Each tab is a link, so tabs are
// addressable, survive reloads and work with Back.
export function tabStrip(items, current, { label = 'Sections' } = {}) {
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label });
  for (const it of items) {
    const sel = it.id === current;
    list.appendChild(h('a', { role: 'tab', href: it.href, id: `tab-${it.id}`, 'aria-selected': String(sel), tabindex: sel ? '0' : '-1', 'aria-controls': 'tabpanel', dataset: { key: `tab-${it.id}` } }, it.label, it.count ? h('span', { class: 'count', 'aria-label': `${it.count} items` }, String(it.count)) : null));
  }
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null) return;
    e.preventDefault();
    tabs[i].tabIndex = -1;
    tabs[j].tabIndex = 0;
    tabs[j].focus();
  });
  return list;
}

// Renders a section and contains its failure, so one broken section never
// blanks the page.
export async function safeSection(name, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    return callout(`${name} could not be shown: ${err.message}. The rest of the page still works; your files are unchanged.`, 'bad');
  }
}

// Modal dialog (native <dialog>): the page behind is inert; Esc, the close
// button and the backdrop close it; focus returns to the control that opened it.
export function openDialog(title, body, { onClose = null, wide = false } = {}) {
  const opener = document.activeElement;
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { type: 'button', class: 'close quiet', 'aria-label': 'Close' }, '×');
  const bodyEl = h('div', { class: 'dlg-body' }, body);
  const dlg = h('dialog', { 'aria-labelledby': titleId, style: wide ? { maxWidth: 'min(820px, calc(100vw - 24px))' } : null },
    h('div', { class: 'dlg-head' }, h('h2', { id: titleId }, title), closeBtn),
    bodyEl);
  const close = () => {
    if (dlg.open) dlg.close();
  };
  closeBtn.onclick = close;
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (onClose) onClose();
    // A live refresh may have redrawn the page under the dialog: fall back to
    // the redrawn twin of the control that opened it.
    const target = opener && opener.isConnected ? opener
      : opener && opener.dataset && opener.dataset.key ? document.querySelector(`[data-key="${CSS.escape(opener.dataset.key)}"]`)
        : opener && opener.id ? document.getElementById(opener.id) : null;
    if (target && typeof target.focus === 'function') target.focus();
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  const first = dlg.querySelector('input:not([type="hidden"]), select, textarea');
  if (first) first.focus();
  return { dlg, close, body: bodyEl };
}
