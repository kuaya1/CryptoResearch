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
// research pages and receipts. Whoever does the work (the API in the
// background, Claude in Cowork, ChatGPT or Gemini through its connection), it
// reads "Working"; "Waiting" means the job needs you, because no API runs it.
// researchState() fills in the model's name and, on the online desk, the
// sentence to say to its assistant.
export const RESEARCH_STATE = {
  none: { short: 'None', long: 'No research yet', tone: '' },
  queued: { short: 'Queued', long: 'Queued: it starts shortly; not saved yet', tone: 'wait' },
  dispatching: { short: 'Working', long: 'Running on the API in the background: not saved yet', tone: 'work' },
  running: { short: 'Working', long: 'Working on it: not saved yet', tone: 'work' },
  cowork: { short: 'Working', long: 'Claude in Cowork is researching it: not saved yet', tone: 'work' },
  connector: { short: 'Working', long: 'Researching it itself through its desk connection: not saved yet', tone: 'work' },
  waiting: { short: 'Waiting', long: 'Waiting for you: no API runs this model. Paste the prompt into it and import its answer', tone: 'warn' },
  interrupted: { short: 'Paused', long: 'Paused: its assistant has shown no activity for 30 minutes and has not saved this report. Ask it to resume, or restart it', tone: 'warn' },
  uncertain: { short: 'Check', long: 'Check: the request may have been sent and billed, and no answer was saved. Reconcile it or retry', tone: 'warn' },
  // An answer that arrived but stopped before it finished (for example at the
  // output limit): not a report and never graded; its partial text is kept.
  incomplete: { short: 'Incomplete', long: 'Incomplete answer: the model stopped before finishing (for example at its output limit). Nothing was saved as a report; the partial text is kept under its run', tone: 'bad' },
  failed: { short: 'Failed', long: 'Failed: nothing was saved for this model', tone: 'bad' },
  // A paid answer that does not match the run it was sent for: kept with its
  // receipt and cost, never graded, and not sent again.
  conflict: { short: 'Check', long: 'Check: the answer does not match the research run it was sent for. It is kept with its receipt and cost, is not graded and did not complete the job. Retry only if you want the run asked again', tone: 'bad' },
  canceled: { short: 'Canceled', long: 'Canceled: nothing was saved for this model', tone: '' },
  completed: { short: 'Saved', long: 'Saved as a report', tone: 'ok' },
  // Eric paused the model: its waiting job is kept and nothing new is assigned.
  on_hold: { short: 'On hold', long: 'On hold: this model is paused on this desk. Its waiting job is kept and is not handed out; nothing new is assigned to it', tone: '' },
  // Queued for a paid API, never sent, because its project was archived.
  held: { short: 'Held', long: 'Held, not sent: the project was archived before this request was sent. It is sent only if you send it again', tone: 'warn' },
};

// A model Eric put on hold (settings research.on_hold), from the index.
export function onHoldOf(index, provider) {
  const h = index && index.settings && index.settings.research && index.settings.research.on_hold;
  return h && h[provider] && typeof h[provider] === 'object' ? h[provider] : null;
}

// Work in progress (the ↻ "newer research" mark), and the states of a newer
// run that the saved grade must not hide (the "!" mark).
const WORKING = new Set(['queued', 'dispatching', 'running', 'cowork', 'connector']);
const NEEDS_LOOK = new Set(['failed', 'incomplete', 'conflict', 'uncertain', 'interrupted']);
export const isWorking = (key) => WORKING.has(key);

// The one sentence that gets a model's own assistant to do its waiting
// research through the desk connection (the same words the connector uses),
// and where to say it: Gemini uses a custom app only when the message
// @-mentions it; ChatGPT, when the app is turned on in that chat.
export const WAITING_SENTENCE = 'Do my waiting CryptoResearch research';
export const ASK_WHERE = {
  claude: 'In Cowork, say',
  chatgpt: 'In a ChatGPT chat, turn on the CryptoResearch app (+ menu), then say',
  gemini: 'In Gemini, type @ and pick CryptoResearch, then say',
};

export function waitingInstruction(provider, { full = false } = {}) {
  if (full) return `${ASK_WHERE[provider] || 'Tell its assistant'}: "${WAITING_SENTENCE}"`;
  return `Tell ${PROVIDER_LABELS[provider] || 'its assistant'}: "${WAITING_SENTENCE}"`;
}

// A state in words for one model. On the online desk a waiting job's next
// step is the sentence for its assistant; on this PC it is the pasted prompt.
export function researchState(key, { provider = null, hosted = false } = {}) {
  const base = RESEARCH_STATE[key];
  if (!base) return { short: key || 'Unknown', long: key || 'Unknown state', tone: '' };
  const who = PROVIDER_LABELS[provider];
  if (key === 'waiting') return { ...base, long: hosted ? `Waiting for you. ${waitingInstruction(provider)}` : `Waiting for you: paste the prompt into ${who || 'the model'} and import its answer` };
  if (key === 'dispatching' && who) return { ...base, long: `Running on the ${who} API in the background: not saved yet` };
  if (key === 'connector' && who) return { ...base, long: `${who} is researching it through its desk connection: not saved yet` };
  return base;
}

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
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
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

// The calendar day of an instant in New York (YYYY-MM-DD).
const dayET = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });

// Calendar days since a date or date-time, counted in New York: something
// analyzed yesterday evening is "yesterday" this morning, not "today".
export function daysSince(s, now = Date.now()) {
  if (!s) return null;
  let day = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) day = s;
  else {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    day = dayET(t);
  }
  const diff = Math.round((Date.parse(`${dayET(now)}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000);
  return Number.isNaN(diff) ? null : Math.max(0, diff);
}

// Compact analysis age for badges: today, 1d, 6d, 3w, 4mo, 1y.
export function fmtAge(s, now = Date.now()) {
  const d = daysSince(s, now);
  if (d === null) return null;
  if (d < 1) return 'today';
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round(d / 365)}y`;
}

// The same in words, for a date line: today, yesterday, 5 days ago.
export function fmtRelDay(s, now = Date.now()) {
  const d = daysSince(s, now);
  if (d === null) return null;
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 60) return `${d} days ago`;
  return null;
}

// The rubric's own words for a score (cr-grading favorable anchors, for
// example 40–59 "Weak"), never a word the rubric does not define.
export function anchorWord(anchors, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Array.isArray(anchors)) return null;
  for (const a of anchors) {
    const m = String((a && a.band) || '').match(/^(\d+)\s*-\s*(\d+)$/);
    if (m && n >= Number(m[1]) && n < Number(m[2]) + 1) return String(a.meaning || '').split('.')[0].trim() || null;
  }
  return null;
}

// "Weak", or "Weak to adequate or mixed" for a range across two bands.
export function anchorText(anchors, s) {
  if (!s) return null;
  if (s.status === 'scored' || typeof s.value === 'number') return anchorWord(anchors, s.value);
  if (s.status === 'range' || (typeof s.low === 'number' && typeof s.high === 'number')) {
    const lo = anchorWord(anchors, s.low);
    const hi = anchorWord(anchors, s.high);
    if (!lo || !hi) return lo || hi;
    return lo === hi ? lo : `${lo} to ${hi.charAt(0).toLowerCase()}${hi.slice(1)}`;
  }
  return null;
}

// ---- small components ----------------------------------------------------

export function chip(text, kind = '', title = null) {
  return h('span', { class: `chip ${kind}`.trim(), title }, text);
}

export function stateText(text, tone = '') {
  return h('span', { class: `state ${tone}`.trim() }, text);
}

// Projects on your watchlist or in your portfolio: the one count the
// navigation and the watchlist header both show.
export const isFollowed = (p) => Boolean(p && !p.broken && p.status !== 'archived' && (p.on_watchlist || p.held));
export const followedCount = (projects) => (projects || []).filter(isFollowed).length;

const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function joinAnd(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

// The weighted parts a withheld grade is missing, from a full report record
// (the index carries the same list as `unscored`), with the model's own note.
export function unscoredFrom(grade, components) {
  if (!grade || grade.status !== 'withheld') return [];
  return (grade.missing || []).map((m) => {
    const s = components ? components[m.id] : null;
    const note = s ? s.missing_data || s.rationale || null : null;
    return { label: m.label, status: m.status, note: note ? String(note) : null };
  });
}

const PART_STATUS = { unknown: 'marked unknown', not_applicable: 'marked not applicable', missing: 'not scored', range: 'a range without a reason' };

// What the coverage of a withheld grade is, said once and the same everywhere.
export const COVERAGE_MEANS = 'Coverage is the share of the investment grade\'s weight that this report scored. It is not research progress and not the score.';

// "Grade withheld — 80% coverage" (or just "Grade withheld" when the share is
// not known): the saved report's state in one phrase.
export function withheldLabel(pct) {
  return typeof pct === 'number' ? `Grade withheld — ${pct}% coverage` : 'Grade withheld';
}

// Why a grade is withheld, in plain words: which weighted parts were not
// scored, what share of the weight was, and the model's own notes. It never
// offers a number in the grade's place.
export function withheldReason(provider, grade, unscored = []) {
  const who = PROVIDER_LABELS[provider] || 'The model';
  const pct = grade && typeof grade.coverage_pct === 'number' ? grade.coverage_pct : null;
  const parts = Array.isArray(unscored) ? unscored : [];
  const names = (status) => joinAnd(parts.filter((x) => x.status === status).map((x) => lowerFirst(String(x.label))));
  const phrases = [];
  if (names('unknown')) phrases.push(`${who} said evidence was missing for ${names('unknown')}`);
  if (names('not_applicable')) phrases.push(`${who} marked ${names('not_applicable')} not applicable`);
  if (names('missing')) phrases.push(`${who}'s report did not score ${names('missing')}`);
  if (names('range')) phrases.push(`${names('range')}: a score range without a reason`);
  const short = withheldLabel(pct);
  const why = phrases.length ? phrases.join('; ') : (grade && grade.reason) || 'a weighted part of the grade was not scored';
  return {
    short,
    why,
    sentence: `${short}: ${why.replace(/\.$/, '')}.`,
    coverage: pct,
    items: parts.map((x) => ({ label: x.label, status: PART_STATUS[x.status] || x.status, note: x.note || null })),
  };
}

// A report's structure checks (core/consistency.js) as short notes: weighted
// parts left unscored while the same report scores related ground. They
// never change a score; they say where to look.
export function structureNotes(st, { max = 3 } = {}) {
  if (!st || !st.flagged || !Array.isArray(st.flags) || !st.flags.length) return null;
  const items = st.flags.slice(0, max);
  return h('ul', { class: 'list small structure-notes' },
    items.map((f) => h('li', null, f.message)),
    st.flags.length > max ? h('li', { class: 'muted' }, `${st.flags.length - max} more on the report's scorecard`) : null);
}

// The unscored parts as a short list, each with the model's own note.
export function unscoredList(reason, { max = 200 } = {}) {
  if (!reason.items.length) return null;
  return h('ul', { class: 'list small unscored' }, reason.items.map((x) => h('li', null,
    h('strong', null, x.label), ` · ${x.status}`,
    x.note ? h('span', { class: 'muted' }, `: “${x.note.length > max ? `${x.note.slice(0, max - 1)}…` : x.note}”`) : null)));
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

// The 7-day chart in the list: one SVG path, no library. The series is
// thinned to at most `max` points (evenly, keeping the last), scaled to the
// box with `pad` pixels top and bottom, and written as one "M … L …" string.
// A flat series is drawn through the middle. Pure, for the tests.
export function sparkPath(values, { width = 135, height = 36, pad = 3, max = 140 } = {}) {
  const src = Array.isArray(values) ? values.filter((v) => typeof v === 'number' && Number.isFinite(v)) : [];
  if (src.length < 2) return null;
  const pts = src.length > max ? Array.from({ length: max }, (_, i) => src[Math.round((i * (src.length - 1)) / (max - 1))]) : src;
  let min = Infinity;
  let max2 = -Infinity;
  for (const v of pts) { if (v < min) min = v; if (v > max2) max2 = v; }
  const span = max2 - min;
  const step = (width - 2) / (pts.length - 1);
  const y = (v) => (span ? height - pad - ((v - min) / span) * (height - 2 * pad) : height / 2);
  let d = '';
  for (let i = 0; i < pts.length; i++) d += `${i ? 'L' : 'M'}${(1 + i * step).toFixed(1)} ${y(pts[i]).toFixed(1)}`;
  return d;
}

// The list's 7-day chart: green when the 7-day change is up or flat, red when
// down; a faint dashed line when there is no series. The label says the change.
export function priceSpark(values, change, { width = 135, height = 36, label = '7-day price' } = {}) {
  const d = sparkPath(values, { width, height });
  const attrs = { class: 'pspark', width: String(width), height: String(height), viewBox: `0 0 ${width} ${height}`, fill: 'none' };
  if (!d) {
    return svg('svg', { ...attrs, class: 'pspark none', role: 'img', 'aria-label': `${label}: no series from the provider` },
      svg('line', { x1: '1', y1: String(height / 2), x2: String(width - 1), y2: String(height / 2), 'stroke-width': '1.5', 'stroke-dasharray': '3 4', 'stroke-linecap': 'round' }));
  }
  const up = !(typeof change === 'number' && change < 0);
  return svg('svg', { ...attrs, class: `pspark ${up ? 'up' : 'down'}`, role: 'img', 'aria-label': `${label}${typeof change === 'number' ? `, ${change >= 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(2)} percent` : ''}` },
    svg('path', { d, 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

// A project's logo: CoinGecko's own image, fetched and cached by this desk
// (the page never calls an outside image host). Without one, or while it
// loads, a monogram on one of six soft tones, chosen from the project ID so
// a project keeps its tone. One size, one fine ring.
export function logo(p, { size = 28 } = {}) {
  const m = p.market || {};
  const label = (p.symbol || p.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  let hash = 0;
  for (const ch of String(p.project_id || p.name || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const box = h('span', { class: `logo tone-${hash % 6}`, 'aria-hidden': 'true', style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(10, Math.round(size * 0.38))}px` } }, label);
  if (m.logo_url) {
    // Loaded before it is placed (so a missing logo never flashes a broken
    // image); a detached image must not be lazy, or it never loads at all.
    const img = h('img', { src: m.logo_url, alt: '', decoding: 'async', width: String(size), height: String(size) });
    img.addEventListener('error', () => img.remove());
    img.addEventListener('load', () => { box.textContent = ''; box.appendChild(img); box.classList.add('has-img'); });
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
    const known = !(g.coverage_pct === null || g.coverage_pct === undefined);
    return h('div', { class: 'grade withheld', title: [g.reason || '', known ? COVERAGE_MEANS : ''].filter(Boolean).join(' ') },
      h('span', { class: compact ? '' : 'big' }, 'Grade withheld'),
      known ? h('span', { class: 'small muted' }, `${pct}% coverage`) : null,
      compact || !known ? null : h('div', { class: 'coverage', style: { width: '100%' }, 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })));
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

// How a job's last attempt ended ('incomplete' for an answer that stopped
// early): on the index's job summary as `outcome`, on a full job record from
// its attempts.
const lastOutcome = (job) => job.outcome || (Array.isArray(job.attempts) && job.attempts.length ? job.attempts[job.attempts.length - 1].outcome || null : null);

export function jobKey(job, runCreatedAt = null, { onHold = false } = {}) {
  if (!job) return null;
  if (job.state === 'running' && isAssistantJob(job)) {
    const idle = coworkIdleMinutes(job, runCreatedAt);
    return idle !== null && idle >= COWORK_IDLE_MINUTES ? 'interrupted' : job.mode;
  }
  if (job.state === 'unconfigured') return onHold ? 'on_hold' : 'waiting';
  if (job.state === 'queued' && job.hold) return 'held';
  if (job.state === 'queued' && onHold) return 'on_hold';
  // An answer that arrived but stopped before finishing is its own state,
  // apart from a request that failed outright.
  if (job.state === 'failed' && lastOutcome(job) === 'incomplete') return 'incomplete';
  if (job.state === 'failed' && lastOutcome(job) === 'contract_conflict') return 'conflict';
  return job.state;
}

// A run started after the saved report, in one line: "Newer research
// queued", "Newer run failed: <error>", "Newer run waiting for ChatGPT".
function newerRunText(provider, key, job) {
  const who = PROVIDER_LABELS[provider];
  if (key === 'queued') return 'Newer research queued';
  if (WORKING.has(key)) return key === 'dispatching' ? `Newer research running on the ${who} API` : 'Newer research in progress';
  if (key === 'waiting') return `Newer run waiting for ${who}`;
  if (key === 'failed') return `Newer run failed${job && job.error ? `: ${job.error}` : ''}`;
  if (key === 'incomplete') return 'Newer run incomplete: the answer stopped before finishing, and nothing was saved';
  if (key === 'conflict') return 'Newer run needs a check: its answer does not match the run, so it was kept but not graded';
  if (key === 'uncertain') return 'Newer run needs a check: it may have been billed, and no answer was saved';
  if (key === 'interrupted') return `Newer run paused: ${provider === 'claude' && job && job.mode === 'cowork' ? 'Cowork' : who} stopped working on it`;
  return `Newer run ${(RESEARCH_STATE[key] || { short: key }).short.toLowerCase()}`;
}

// The desk's evidence checks on a report (core/evidence.js, in brief on the
// index): "serious" when any flag is high (for example a claim tagged verified
// whose only support is an AI summary), "material" when any is medium, else
// none. The checks never change a score; they say how far to trust it.
// Evidence flags on a report: on its claims, and on category grades that lack
// the evidence the prompt asks for beside them (core/evidence.js).
export function evidenceLevel(ev) {
  if (!ev || !(ev.flagged || ev.flagged_categories || ev.flagged_other)) return null;
  if (ev.high > 0) return 'serious';
  if (ev.medium > 0) return 'material';
  return null;
}

export function evidenceText(ev) {
  if (!ev || !(ev.flagged || ev.flagged_categories || ev.flagged_other)) return null;
  const n = ev.flagged || 0;
  const c = ev.flagged_categories || 0;
  const what = [n ? `${n} claim${n === 1 ? '' : 's'}` : null, c ? `${c} category grade${c === 1 ? '' : 's'}` : null, ev.flagged_other ? 'scenario probabilities' : null].filter(Boolean).join(' and ');
  return `${what} flagged by evidence checks${ev.high ? ` (${ev.high} serious)` : ev.medium ? ` (${ev.medium} material)` : ''}`;
}

const SVG_ICONS = {
  // A warning sign: filled for a serious flag, outlined for a material one.
  'warn-fill': [['path', { d: 'M8 1.6 15.3 14.4H.7Z', fill: 'currentColor' }], ['path', { d: 'M8 6v3.6', class: 'ink-line', 'stroke-width': '1.7', 'stroke-linecap': 'round' }], ['circle', { cx: '8', cy: '11.9', r: '0.95', class: 'ink-dot' }]],
  'warn-line': [['path', { d: 'M8 2.2 14.6 13.9H1.4Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }], ['path', { d: 'M8 6.2v3.3', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }], ['circle', { cx: '8', cy: '11.7', r: '0.85', fill: 'currentColor' }]],
  // Research states, one sign each (the word is always beside it).
  clock: [['circle', { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'M8 4.8V8l2.1 1.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }]],
  key: [['circle', { cx: '5.6', cy: '10.4', r: '2.7', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'm7.6 8.4 5.6-5.6m-1.9 1.9 1.5 1.5m-3.1.1 1.3 1.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }]],
  pause: [['path', { d: 'M5.8 4.2v7.6M10.2 4.2v7.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }]],
  question: [['circle', { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'M6.3 6.3a1.8 1.8 0 1 1 2.5 1.7c-.5.2-.8.6-.8 1.1v.3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }], ['circle', { cx: '8', cy: '11.4', r: '0.8', fill: 'currentColor' }]],
  alert: [['circle', { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'M8 4.9v3.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }], ['circle', { cx: '8', cy: '11', r: '0.85', fill: 'currentColor' }]],
  file: [['path', { d: 'M4.2 1.9h5L12 4.7v9.4H4.2Z M9 1.9v3h3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }]],
  none: [['circle', { cx: '8', cy: '8', r: '5.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-dasharray': '2.1 2.1' }]],
  slash: [['circle', { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'm3.8 12.2 8.4-8.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }]],
  hatch: [['rect', { x: '2', y: '2', width: '12', height: '12', rx: '2.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-dasharray': '2 1.6' }], ['path', { d: 'M5 11 11 5M2.8 8.2 8.2 2.8M7.8 13.2l5.4-5.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.1' }]],
  // An answer that stopped part-way: a half-filled circle.
  half: [['circle', { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'M8 1.8a6.2 6.2 0 0 0 0 12.4Z', fill: 'currentColor' }]],
  // Paused on purpose (a model on hold, work held unsent): a bar in a circle.
  minus: [['circle', { cx: '8', cy: '8', r: '6.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }], ['path', { d: 'M5.2 8h5.6', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }]],
  // A link that opens elsewhere.
  ext: [['path', { d: 'M9.5 2.5h4v4M13.3 2.7 7.5 8.5M12 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8c0-.4.4-.8.8-.8h3.2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  // More actions.
  more:[['circle', { cx: '3.5', cy: '8', r: '1.4', fill: 'currentColor' }], ['circle', { cx: '8', cy: '8', r: '1.4', fill: 'currentColor' }], ['circle', { cx: '12.5', cy: '8', r: '1.4', fill: 'currentColor' }]],
};

// The sign for each research state on a badge. Working (blue) and Waiting
// (amber, it needs you) wear a live dot instead.
const STATE_ICON = { none: 'none', withheld: 'hatch', pdf: 'file', queued: 'clock', interrupted: 'pause', uncertain: 'question', incomplete: 'half', failed: 'alert', canceled: 'slash', on_hold: 'minus', held: 'minus' };
const WORKING_KINDS = new Set(['running', 'dispatching', 'cowork', 'connector']);

// The grade ruler: 0 to 100 with the rubric's letter bands (F below 60, then
// D, C, B and A by tens), a marker at the grade or a span for a range. The
// number and letter are always written next to it.
export function gradeMeter(g, { serious = false } = {}) {
  if (!g || !['firm', 'range'].includes(g.status)) return null;
  const clamp = (v) => Math.max(0, Math.min(100, Number(v)));
  const wrap = h('div', { class: 'wrap' }, h('div', { class: 'track' }, ['f', 'd', 'c', 'b', 'a'].map((z) => h('span', { class: `zone z-${z}` }))));
  if (g.status === 'firm') wrap.appendChild(h('span', { class: 'mark', style: { left: `${clamp(g.value)}%` } }));
  else wrap.appendChild(h('span', { class: 'span', style: { left: `${clamp(g.low)}%`, width: `${Math.max(2, clamp(g.high) - clamp(g.low))}%` } }));
  return h('div', { class: `gmeter${serious ? ' ev-serious' : ''}`, 'aria-hidden': 'true' }, wrap,
    h('div', { class: 'scale' }, h('span', null, '0'), h('span', null, '60'), h('span', null, '100')));
}

// A withheld grade's coverage, the share of the investment weight the report
// scored; the rest is hatched. The words say what it is and what it is not.
export function coverageMeter(pct, { compact = false } = {}) {
  if (typeof pct !== 'number') return null;
  const track = h('div', { class: 'track', 'aria-hidden': 'true' }, h('div', { class: 'fill', style: { width: `${Math.max(0, Math.min(100, pct))}%` } }));
  // Compact (the inspector): the share in a few words.
  if (compact) return h('div', { class: 'coverage-meter' }, track, h('div', { class: 'lbl' }, `${pct}% of the investment weight scored`));
  return h('div', { class: 'coverage-meter' }, track,
    h('div', { class: 'lbl' }, `${pct}% coverage · no grade is calculated from part of the weight`),
    h('div', { class: 'lbl muted' }, COVERAGE_MEANS));
}

// The one 0–100 spectrum for every score on the desk, on the rubric's own
// anchors: 1 below 40 (poor or severe), 2 to 59 (weak), 3 to 74 (adequate or
// mixed), 4 to 89 (strong), 5 from 90 (exceptional). A range takes the tier
// of its low end, as it sorts. Pure, for the tests.
export function scoreTier(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v < 40 ? 1 : v < 60 ? 2 : v < 75 ? 3 : v < 90 ? 4 : 5;
}
export const TIER_EDGES = [[0, 40], [40, 60], [60, 75], [75, 90], [90, 100]];

// A point on the gauge's half circle for a score (0 at the left end, 100 at
// the right), and the arc between two scores, clockwise over the top.
export function gaugePoint(s, { cx = 90, cy = 90, r = 76 } = {}) {
  const a = Math.PI * (1 - Math.max(0, Math.min(100, s)) / 100);
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
}
export function gaugeArc(s0, s1, geo = {}) {
  const [x0, y0] = gaugePoint(s0, geo);
  const [x1, y1] = gaugePoint(s1, geo);
  const r = geo.r || 76;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

// The investment grade as a half-circle gauge: five muted segments on the
// spectrum (the grade's own segment a shade stronger), a marker at the grade
// or a span for a range, the number and the rubric's word in the middle.
export function gradeGauge(g, { word = null, serious = false } = {}) {
  if (!g || !['firm', 'range'].includes(g.status)) return null;
  const geo = { cx: 90, cy: 90, r: 76 };
  const low = g.status === 'range' ? g.low : g.value;
  const high = g.status === 'range' ? g.high : g.value;
  const tier = scoreTier(low);
  const gap = 3.2;
  const segs = TIER_EDGES.map(([a, b], i) => svg('path', { class: `gseg t${i + 1}${i + 1 === tier ? ' on' : ''}`, d: gaugeArc(a === 0 ? 1.5 : a + gap / 2, b === 100 ? 98.5 : b - gap / 2, geo) }));
  const mark = g.status === 'range'
    ? svg('path', { class: 'gspan', d: gaugeArc(Math.max(1.5, low), Math.min(98.5, Math.max(high, low + 0.8)), geo) })
    : (() => { const [x, y] = gaugePoint(Math.max(1.5, Math.min(98.5, low)), geo); return svg('circle', { class: 'gdot', cx: x.toFixed(2), cy: y.toFixed(2), r: '6.5' }); })();
  return svg('svg', { class: `ggauge${serious ? ' ev-serious' : ''}`, width: '180', height: '100', viewBox: '0 0 180 100', role: 'img', 'aria-label': `Investment grade ${g.display} of 100${word ? `, ${word}` : ''}` },
    ...segs, mark,
    svg('text', { class: 'gnum', x: '90', y: '76', 'text-anchor': 'middle' }, g.display),
    word ? svg('text', { class: 'gword', x: '90', y: '95', 'text-anchor': 'middle' }, word) : null);
}

// A small decorative icon; the meaning is always in the surrounding text.
export function icon(name) {
  const parts = SVG_ICONS[name] || [];
  return svg('svg', { viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true', focusable: 'false' }, ...parts.map(([tag, attrs]) => svg(tag, attrs)));
}

export function badgeInfo(provider, report, job, { staleDays = 90, hosted = false, onHold = false } = {}) {
  const who = PROVIDER_LABELS[provider];
  const key = jobKey(job, null, { onHold });
  if (report) {
    // A newer run (started after this report was saved) shows on the saved
    // grade: ↻ while it works, ! when it failed, needs a check or stalled.
    const newer = Boolean(key && !['completed', 'canceled', 'on_hold'].includes(key) && job.run_created_at && report.imported_at && job.run_created_at > report.imported_at);
    const g = report.grade || {};
    const age = daysSince(report.analysis_at);
    const stale = age !== null && age > staleDays;
    const newerText = newer ? newerRunText(provider, key, job) : null;
    const ev = report.needs_text ? null : evidenceLevel(report.evidence);
    const evText = ev ? evidenceText(report.evidence) : null;
    const base = { report: true, age: fmtAge(report.analysis_at), date: report.analysis_at, stale, sub: null, refreshing: newer && WORKING.has(key), problem: newer && NEEDS_LOOK.has(key), newerText, job: newer ? key : null, ev, evText };
    let out;
    if (report.needs_text) out = { kind: 'pdf', value: 'PDF', label: null, text: `${who}: PDF report saved; a text copy is needed before it can be graded` };
    else if (g.status === 'firm') out = { kind: 'grade', value: g.display, label: g.label, text: `${who} grade ${g.display}${g.label ? `, ${g.label}` : ''}` };
    else if (g.status === 'range') out = { kind: 'range', value: g.display, label: g.label, text: `${who} grade range ${g.display}${g.label ? `, ${g.label}` : ''}` };
    else if (g.status === 'withheld') {
      // A saved report whose grade is withheld: the coverage is the share of
      // the investment weight it scored, never progress and never a score.
      const pct = typeof g.coverage_pct === 'number' ? g.coverage_pct : null;
      out = { kind: 'withheld', value: 'Withheld', sub: pct !== null ? `${pct}% coverage` : null, label: null, text: `${who}: report saved, ${withheldLabel(pct).replace(/^G/, 'g')}${pct !== null ? ' (the share of the investment weight it scored, not research progress)' : ''}` };
    } else out = { kind: 'withheld', value: 'No grade', label: null, text: `${who}: report saved, no authoritative grade${g.reason ? `. ${g.reason}` : ''}` };
    const when = report.analysis_at ? `analysis ${fmtDate(report.analysis_at)}${stale ? ', stale' : ''}` : 'analysis date unknown';
    return { ...base, ...out, text: `${out.text}, ${when}${evText ? `; ${evText}` : ''}${newerText ? `; ${newerText.charAt(0).toLowerCase()}${newerText.slice(1)}` : ''}` };
  }
  if (key && RESEARCH_STATE[key]) {
    const st = researchState(key, { provider, hosted });
    return { report: false, kind: key, value: st.short, sub: null, label: null, age: null, stale: false, refreshing: false, problem: false, newerText: null, job: key, ev: null, evText: null, text: `${who}: ${st.long}${job.error ? `. ${job.error}` : ''}` };
  }
  return { report: false, kind: 'none', value: 'None', sub: null, label: null, age: null, stale: false, refreshing: false, problem: false, newerText: null, job: null, ev: null, evText: null, text: `${who}: no research yet` };
}

export function gradeBadge(provider, report, job, opts = {}) {
  const info = badgeInfo(provider, report, job, opts);
  const tag = opts.button ? 'button' : 'span';
  const band = info.kind === 'grade' || info.kind === 'range' ? bandClass(report && report.grade) : '';
  // The grade's place on the one 0–100 spectrum (a range by its low end).
  const g = report && report.grade;
  const tier = info.kind === 'grade' ? scoreTier(g.value) : info.kind === 'range' ? scoreTier(g.low) : null;
  const attrs = {
    class: `gb is-${info.kind}${band}${tier ? ` tier-${tier}` : ''}${info.stale ? ' is-stale' : ''}${info.problem ? ' has-problem' : ''}${info.ev ? ` ev-${info.ev}` : ''}`,
    'aria-label': opts.button ? `${info.text.replace(/[.\s]+$/, '')}. Open details` : info.text,
    dataset: { provider, key: opts.key || null },
  };
  if (!opts.key) delete attrs.dataset.key;
  if (opts.button) attrs.type = 'button';
  // The model's name (hidden where a column header already names it), then
  // its grade in the band's color, or a plain state. The analysis age shows
  // only when it is stale; the scorecard and panel give the date. A withheld
  // grade shows the share of the weight that was scored, never a number in
  // the grade's place. Evidence flags sit right beside the grade.
  const sign = WORKING_KINDS.has(info.kind) ? h('span', { class: 'pulse' }) : info.kind === 'waiting' ? h('span', { class: 'pulse wait' }) : STATE_ICON[info.kind] ? h('span', { class: 'si' }, icon(STATE_ICON[info.kind])) : null;
  return h(tag, attrs,
    h('span', { class: 'p', 'aria-hidden': 'true' }, PROVIDER_SHORT[provider]),
    h('span', { class: 'main', 'aria-hidden': 'true' },
      sign,
      h('span', { class: 'v' }, info.value),
      info.label ? h('span', { class: 'l' }, info.label) : null,
      // A small muted dot (filled: serious, a ring: material); the words are
      // in the badge's label, its tooltip and the inspector's evidence line.
      info.ev ? h('span', { class: 'ev', title: `Evidence checks: ${info.evText}` }) : null,
      info.stale && info.age ? h('span', { class: 'a' }, info.age) : null,
      info.refreshing ? h('span', { class: 'r', title: info.newerText }, '↻') : null,
      info.problem ? h('span', { class: 'x', title: info.newerText }, '!') : null),
    // A withheld grade's coverage on its own line ("80% coverage"), so the
    // share never reads as progress or as a score next to the word.
    info.sub ? h('span', { class: 'cov', 'aria-hidden': 'true' }, info.sub) : null);
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

// Today's times without the date; other days with it.
export function fmtAsOf(s) {
  const t = Date.parse(s || '');
  if (Number.isNaN(t)) return '—';
  const day = (x) => new Date(x).toLocaleDateString('en-US', { timeZone: TZ });
  if (day(t) !== day(Date.now())) return fmtDateTime(s);
  return `${new Date(t).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })} ET`;
}

// The price status in plain words for the watchlist header and the activity
// log: how old the prices are and, when the last refresh failed or was
// rate-limited, the market source's own note (or its last error).
export function priceStatus(mf) {
  const m = mf || {};
  const f = freshnessText(m.freshness, m.age_minutes);
  const problem = ['stale', 'stale_failed', 'failed', 'fresh_last_failed'].includes(m.freshness) || Boolean(m.rate_limited);
  const limited = m.rate_limited ? `The price source is limiting requests${m.retry_at ? `; the next try is after ${fmtAsOf(m.retry_at)}` : ''}` : null;
  const note = m.note || limited || (problem ? m.last_error : null) || null;
  return {
    text: f.text,
    tone: f.tone,
    problem,
    asOf: m.last_success_at ? `Prices as of ${fmtAsOf(m.last_success_at)} (${fmtAgo(m.last_success_at)})` : 'No prices fetched yet',
    note: note ? String(note) : null,
    retryAt: m.retry_at || null,
  };
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

// A card: its title and actions. An explanatory note is never shown as copy;
// it stays as the title's tooltip.
export function card(title, children, { note = null, actions = null, id = null } = {}) {
  return h('section', { class: 'card', id },
    title || actions ? h('div', { class: 'card-head' }, h('div', null, typeof title === 'string' ? h('h2', { title: note || null }, title) : title), actions ? h('div', { class: 'actions' }, actions) : null) : null,
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
  // A hint is not shown as copy: it describes the field to a screen reader
  // and is the field's tooltip.
  const hintEl = hint ? h('div', { class: 'hint sr-only', id: `${id}-hint` }, hint) : null;
  if (hint && typeof hint === 'string' && !inputEl.title) inputEl.title = hint;
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

// A short notice. With an action (Undo), it stays longer and carries the
// button; the same action is always reachable elsewhere on the page too.
export function toast(message, kind = '', { action = null, ms = null } = {}) {
  const box = document.getElementById('toast');
  const el = h('div', { class: `${kind}${action ? ' with-action' : ''}`.trim() }, h('span', null, message));
  if (action) {
    const b = h('button', { type: 'button', class: 'toast-action', dataset: { key: action.key || 'toast-action' } }, action.label);
    b.onclick = async () => {
      b.disabled = true;
      try {
        await action.onClick();
        el.remove();
      } catch (err) {
        b.disabled = false;
        toast(err.message, 'bad');
      }
    };
    el.appendChild(b);
  }
  box.appendChild(el);
  setTimeout(() => el.remove(), ms || (action ? 12000 : kind === 'bad' ? 9000 : 4500));
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
