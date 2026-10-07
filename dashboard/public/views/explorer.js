// Research Explorer (#/explorer): one category grade across projects, read
// from the Supabase mirror through this desk's own server (GET /api/explorer,
// behind the same sign-in and token as every page; the page never talks to
// Supabase and never sees a key). Opening it reads; it never starts
// research, refreshes prices or writes anything.
// - Demo data is said at the top while the mirror holds fictional records.
// - Each model keeps its own row and grade; nothing is combined.
// - Scores compare only within one scoring version (profile and rubric):
//   rows are grouped by it, and more than one group is said in words.
// - A point is a bar, a range its two ends (never a midpoint), unknown an
//   empty dashed track with "Unknown", N/A its word; 0 is a number.
// - The sync time, a stale export and an unavailable mirror are said; the
//   rest of the desk does not depend on any of it.
import { h, clear, logo, scoreTier, PROVIDERS, PROVIDER_LABELS, fmtDate, fmtDateTime, fmtAgo, icon, announce } from '../ui.js';
import { sortKey } from '../compare-model.js';

const STATE_WORDS = { ok: 'Synced', stale: 'Stale', unavailable: 'Supabase unavailable', not_configured: 'Not set up', off: 'Switched off', empty: 'Nothing exported yet' };
const CONFIDENCE = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence' };
const SEVERITY = { high: 'serious', medium: 'material', low: 'note' };
const REVISION_WORDS = { format_fix: 'format fix', reassessment: 'reassessment', new_evidence: 'new evidence', other: 'other reason', not_stated: 'reason not stated' };
const BASIS_WORDS = { existing_evidence: 'using existing evidence, no source added', new_sources: 'with new sources', scores_unchanged: 'same scores, rewritten' };
const CACHE_MS = 60000;

let cache = null; // { data, got }
let mounted = null;
let filters = null;
let announceTimer = null;
let currentCtx = null; // for actions that open from a row (Compare opinions)
const openDetails = new Set(); // report IDs whose details are open, kept across filter changes

// ---- pure pieces (tested in ui-logic tests) --------------------------------

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
const versionOf = (ref) => {
  const m = /@(\d+)$/.exec(String(ref || ''));
  return m ? Number(m[1]) : 0;
};
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// The desk's display rule: one decimal, truncated, so a grade never shows in
// a higher band than its full value.
const trunc1 = (v) => (Math.floor(v * 10 + 1e-9) / 10).toFixed(1);
const fmtScore = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

export function scoreText(s) {
  if (!s) return 'Not in this report';
  if (s.status === 'scored' && isNum(s.score)) return fmtScore(s.score);
  if (s.status === 'range' && isNum(s.score_low) && isNum(s.score_high)) return `${fmtScore(s.score_low)}–${fmtScore(s.score_high)}`;
  if (s.status === 'not_applicable') return 'N/A';
  return 'Unknown';
}

// What a row sorts by: a point, a range by its low end (as the desk sorts
// it), and no number at all for unknown or N/A, which sort last. Zero is a
// number and sorts as one.
export function sortValue(s) {
  if (!s) return null;
  if (s.status === 'scored' && isNum(s.score)) return s.score;
  if (s.status === 'range' && isNum(s.score_low)) return s.score_low;
  return null;
}

export function gradeText(r) {
  if (r.grade_status === 'firm' && isNum(r.grade_value)) return `Grade ${trunc1(r.grade_value)}`;
  if (r.grade_status === 'range' && isNum(r.grade_low) && isNum(r.grade_high)) return `Grade ${trunc1(r.grade_low)}–${trunc1(r.grade_high)}`;
  if (r.grade_status === 'withheld') return isNum(r.grade_coverage_pct) ? `Grade withheld · ${fmtScore(r.grade_coverage_pct)}% coverage` : 'Grade withheld';
  if (r.grade_status === 'invalid_weights') return 'Weights invalid';
  return 'No grade';
}

// Every category any report grades, the newest profile's order first.
export function categoriesOf(reports) {
  const seen = new Map();
  for (const r of reports || []) {
    const ver = versionOf(r.profile_version);
    for (const s of r.category_scores || []) {
      const c = seen.get(s.category_id) || { id: s.category_id, labels: new Map(), count: 0, newest: -1, pos: Infinity };
      c.count += 1;
      c.labels.set(s.category_label, (c.labels.get(s.category_label) || 0) + 1);
      if (ver > c.newest) {
        c.newest = ver;
        c.pos = s.position;
      } else if (ver === c.newest) c.pos = Math.min(c.pos, s.position);
      seen.set(s.category_id, c);
    }
  }
  return [...seen.values()]
    .map((c) => ({ id: c.id, label: [...c.labels.entries()].sort((a, b) => b[1] - a[1])[0][0], count: c.count, newest: c.newest, pos: c.pos }))
    .sort((a, b) => b.newest - a.newest || a.pos - b.pos || a.label.localeCompare(b.label));
}

// The reports in view: the model and search filters, and either each
// project's latest report per model (the desk's own rule, as Compare
// opinions uses) or every save (earlier ones and revisions listed in their
// own rows, never merged). Filters run over every row the server read.
export function selectReports(data, f) {
  const reports = (data && data.reports) || [];
  const projects = new Map(((data && data.projects) || []).map((p) => [p.project_id, p]));
  const saves = new Map();
  for (const r of reports) {
    const k = `${r.project_id}|${r.model}`;
    if (!saves.has(k)) saves.set(k, []);
    saves.get(k).push(r);
  }
  for (const list of saves.values()) list.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  const q = norm(f.q);
  return reports
    .filter((r) => f.model === 'all' || r.model === f.model)
    .filter((r) => {
      if (!q) return true;
      const p = projects.get(r.project_id) || {};
      return [p.name, p.ticker, r.project_id].some((x) => norm(x).includes(q));
    })
    .filter((r) => f.saves === 'all' || saves.get(`${r.project_id}|${r.model}`)[0] === r)
    .map((r) => {
      const list = saves.get(`${r.project_id}|${r.model}`);
      return {
        report: r,
        project: projects.get(r.project_id) || { project_id: r.project_id, name: r.project_id, ticker: null },
        saves: list.length,
        newer: list.indexOf(r),
        revisedBy: reports.filter((x) => x.revision_of === r.report_id).map((x) => x.report_id),
      };
    });
}

// One category across the reports in view, grouped by scoring version.
export function compareCategory(entries, categoryId) {
  const groups = new Map();
  const missing = [];
  for (const e of entries) {
    const s = (e.report.category_scores || []).find((x) => x.category_id === categoryId);
    if (!s) {
      missing.push(e);
      continue;
    }
    const profile = e.report.profile_version || 'Unknown profile';
    const rubric = e.report.rubric_version || 'unknown rubric';
    const key = `${profile} · ${rubric}`;
    if (!groups.has(key)) groups.set(key, { key, profile, rubric, rows: [] });
    groups.get(key).rows.push({ ...e, score: s });
  }
  const byName = (a, b) => String(a.project.name).localeCompare(String(b.project.name)) || PROVIDERS.indexOf(a.report.model) - PROVIDERS.indexOf(b.report.model) || String(b.report.saved_at).localeCompare(String(a.report.saved_at));
  const out = [...groups.values()];
  for (const g of out) {
    g.rows.sort((a, b) => {
      const x = sortValue(a.score);
      const y = sortValue(b.score);
      if (x === null && y === null) return byName(a, b);
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x || byName(a, b);
    });
  }
  out.sort((a, b) => b.rows.length - a.rows.length || versionOf(b.profile) - versionOf(a.profile) || a.key.localeCompare(b.key));
  return { groups: out, missing };
}

// ---- drawing ----------------------------------------------------------------

const clampPct = (v) => Math.max(0, Math.min(100, Number(v)));

function bar(s) {
  if (s && s.status === 'scored' && isNum(s.score)) return h('span', { class: 'cbar' }, h('span', { class: `fill tier-${scoreTier(s.score)}`, style: { width: `${clampPct(s.score)}%` } }));
  if (s && s.status === 'range' && isNum(s.score_low) && isNum(s.score_high)) return h('span', { class: 'cbar' }, h('span', { class: `range tier-${scoreTier(s.score_low)}`, style: { left: `${clampPct(s.score_low)}%`, width: `${Math.max(2, clampPct(s.score_high) - clampPct(s.score_low))}%` } }));
  if (s && s.status === 'not_applicable') return h('span', { class: 'cbar xp-na' });
  return h('span', { class: 'cbar unknown' });
}

function valueCell(s) {
  const t = scoreText(s);
  const tier = scoreTier(sortValue(s));
  return h('span', { class: `xp-val${tier ? ` tier-${tier}` : ' none'}` }, t);
}

function worstFlag(flags) {
  const rank = { high: 0, medium: 1, low: 2 };
  return [...(flags || [])].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))[0] || null;
}

function flagChip(flags) {
  const f = worstFlag(flags);
  if (!f) return null;
  const word = f.severity === 'low' ? 'Evidence note' : `Evidence flag · ${SEVERITY[f.severity] || f.severity}`;
  return h('span', { class: `xp-flag sev-${f.severity}`, title: flags.map((x) => x.message).join('\n\n') }, h('span', { class: 'mark', 'aria-hidden': 'true' }), word);
}

function revisionChips(e) {
  const r = e.report;
  const out = [];
  if (r.revision_of) {
    out.push(h('span', { class: 'xp-chip rev', title: [`Revises ${r.revision_of}`, BASIS_WORDS[r.revision_basis] ? `, ${BASIS_WORDS[r.revision_basis]}` : '', r.revision_note ? `. ${r.revision_note}` : ''].join('') }, `Revision · ${REVISION_WORDS[r.revision_kind] || 'reason not stated'}`));
  }
  if (e.revisedBy.length) out.push(h('span', { class: 'xp-chip', title: `Revised by ${e.revisedBy.join(', ')}` }, 'Revised later'));
  else if (e.newer > 0) out.push(h('span', { class: 'xp-chip', title: 'The same model has a later report on this project (by the desk\'s latest-report rule)' }, 'Earlier save'));
  return out;
}

function promptShort(v) {
  const m = /^cr-research-prompt@(\d+)$/.exec(String(v || ''));
  return m ? `prompt @${m[1]}` : v || 'prompt unknown';
}

function detailBody(e, categoryId) {
  const r = e.report;
  const s = e.score;
  const lines = [];
  if (s.rationale) lines.push(['Reason', s.rationale]);
  if (s.main_weakness) lines.push(['Main weakness', s.main_weakness]);
  if (s.unknown_reason) lines.push(['Why unknown', s.unknown_reason]);
  if (s.status === 'unknown' && !s.unknown_reason) lines.push(['Why unknown', 'Not stated in the report']);
  if (s.evidence_refs && s.evidence_refs.length) lines.push(['Evidence', s.evidence_refs.join(', ')]);
  for (const f of s.evidence_flags || []) lines.push([f.severity === 'low' ? 'Evidence note' : `Evidence flag (${SEVERITY[f.severity] || f.severity})`, f.message]);
  const facts = [
    ['Verdict', r.verdict || 'Not stated'],
    ['Investment grade', `${gradeText(r)}${r.grade_unscored.length ? ` · not scored: ${r.grade_unscored.join(', ')}` : ''}`],
    ['Horizon', r.horizon_start && r.horizon_end ? `${fmtDate(r.horizon_start)} to ${fmtDate(r.horizon_end)}` : r.horizon_text || 'Not stated'],
    ['Versions', [r.prompt_version, r.profile_version, r.rubric_version, r.report_format].filter(Boolean).join(' · ') || 'Not stated'],
    ['Saved', fmtDateTime(r.saved_at)],
    ['Report', r.report_id],
    r.research_run_id ? ['Research run', r.research_run_id] : null,
    r.evidence_summary ? ['Evidence checks', r.evidence_summary] : null,
  ].filter(Boolean);
  return h('div', { class: 'xp-detail' },
    lines.length ? h('dl', { class: 'xp-kv' }, lines.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])) : null,
    h('h4', null, 'All categories in this report'),
    h('ol', { class: 'xp-cats' }, (r.category_scores || []).map((c) => h('li', { class: c.category_id === categoryId ? 'on' : null },
      h('span', { class: 'n' }, c.category_label),
      h('span', { class: 'b', 'aria-hidden': 'true' }, bar(c)),
      valueCell(c),
      (c.evidence_flags || []).length ? h('span', { class: 'xp-dot', title: c.evidence_flags.map((f) => f.message).join('\n\n'), 'aria-label': 'evidence flag' }) : null))),
    h('dl', { class: 'xp-kv facts' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', { class: k === 'Report' || k === 'Research run' ? 'id' : null }, v)])));
}

function row(e, categoryId, label) {
  const r = e.report;
  const p = e.project;
  const s = e.score;
  const who = PROVIDER_LABELS[r.model] || r.model;
  const conf = s.confidence ? CONFIDENCE[s.confidence] : null;
  const date = r.research_date ? `Analyzed ${fmtDate(r.research_date)}` : 'Analysis date unknown';
  const said = [`${p.name}${p.ticker ? ` (${p.ticker})` : ''}`, who, `${label}: ${scoreText(s) === 'N/A' ? 'not applicable' : scoreText(s)}${isNum(sortValue(s)) ? ' of 100' : ''}`, conf, date, gradeText(r), worstFlag(s.evidence_flags) ? 'evidence flag' : null, r.revision_of ? 'revision' : null, e.revisedBy.length ? 'revised later' : e.newer > 0 ? 'earlier save' : null].filter(Boolean).join(', ');
  const panelId = `xp-d-${r.report_id}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const panel = h('div', { class: 'xp-more', id: panelId, hidden: !openDetails.has(r.report_id) || null }, openDetails.has(r.report_id) ? detailBody(e, categoryId) : null);
  const toggle = h('button', { type: 'button', class: 'quiet small xp-toggle', 'aria-expanded': String(openDetails.has(r.report_id)), 'aria-controls': panelId, dataset: { key: `xp-more-${r.report_id}` } }, 'Details');
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      openDetails.add(r.report_id);
      clear(panel).appendChild(detailBody(e, categoryId));
      panel.hidden = false;
    } else {
      openDetails.delete(r.report_id);
      panel.hidden = true;
    }
  });
  // Second opinion: this project's reports side by side (views/explorer-compare.js).
  const compare = h('button', { type: 'button', class: 'quiet small xp-compare', dataset: { key: `xp-compare-${r.report_id}` } }, 'Compare opinions');
  compare.setAttribute('aria-label', `Compare opinions on ${p.name}`);
  compare.addEventListener('click', () => import('./explorer-compare.js').then((m) => m.openCompare(currentCtx, p)));
  return h('li', { class: 'xp-row', 'aria-label': said },
    h('div', { class: 'xp-who' },
      logo({ project_id: p.project_id, name: p.name, symbol: p.ticker }, { size: 24 }),
      h('span', { class: 'names' },
        h('span', { class: 'pname', title: p.name }, p.name),
        h('span', { class: 'sub' }, p.ticker ? h('span', { class: 'tick' }, p.ticker) : null, h('span', { class: `xp-model m-${r.model}` }, who)))),
    h('div', { class: 'xp-score' }, h('span', { class: 'xp-bar', 'aria-hidden': 'true' }, bar(s)), valueCell(s)),
    h('div', { class: 'xp-meta' },
      conf ? h('span', null, conf) : null,
      h('span', null, date),
      h('span', { title: [r.prompt_version, r.profile_version, r.rubric_version].filter(Boolean).join(' · ') }, promptShort(r.prompt_version)),
      h('span', { class: `xp-grade g-${r.grade_status}`, title: r.grade_reason || (r.grade_status === 'withheld' ? 'At least one weighted component is not scored; coverage is the share of weight scored, not the score.' : 'Calculated by the desk from the six weighted components; never the model\'s own total.') }, gradeText(r)),
      flagChip(s.evidence_flags),
      ...revisionChips(e),
      compare,
      toggle),
    panel);
}

function syncLine(data, { onRefresh }) {
  const st = data.state;
  const word = STATE_WORDS[st] || st;
  const tone = st === 'ok' ? 'ok' : st === 'stale' || st === 'empty' ? 'warn' : st === 'unavailable' ? 'bad' : 'muted';
  const last = data.last_export;
  const parts = [];
  if (last && last.finished_at) parts.push(`last export ${fmtDateTime(last.finished_at)} (${fmtAgo(last.finished_at)})`);
  if (data.served === 'memory' && data.copy_fetched_at) parts.push(`showing the copy read ${fmtDateTime(data.copy_fetched_at)}`);
  else if (data.fetched_at && st !== 'unavailable') parts.push(`read ${fmtAgo(data.fetched_at)}`);
  if (Array.isArray(data.reports) && data.reports.length) parts.push(`${new Set(data.reports.map((r) => r.project_id)).size} projects · ${data.reports.length} reports`);
  const btn = h('button', { type: 'button', class: 'quiet small xp-refresh', dataset: { key: 'xp-refresh' }, title: 'Read the Explorer again from Supabase (nothing is written)' }, icon('refresh'), h('span', null, 'Refresh'));
  btn.addEventListener('click', onRefresh);
  return h('div', { class: `xp-sync tone-${tone}`, role: 'status' },
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', { class: 'word' }, word),
    parts.length ? h('span', { class: 'rest' }, parts.join(' · ')) : null,
    data.configured ? btn : null);
}

function stateCallout(data) {
  if (data.state === 'ok') return null;
  const kind = data.state === 'unavailable' ? 'bad' : data.state === 'stale' || data.state === 'empty' ? 'warn' : 'info';
  const text = data.reason || STATE_WORDS[data.state];
  return h('div', { class: `callout ${kind}` }, text);
}

function seg(label, options, current, onPick, key) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const [value, text] of options) {
    const b = h('button', { type: 'button', 'aria-pressed': String(value === current), dataset: { key: `${key}-${value}` } }, text);
    b.addEventListener('click', () => onPick(value));
    wrap.appendChild(b);
  }
  return wrap;
}

function syncUrl() {
  const q = new URLSearchParams();
  if (filters.q) q.set('q', filters.q);
  if (filters.model !== 'all') q.set('model', filters.model);
  if (filters.category) q.set('category', filters.category);
  if (filters.saves === 'all') q.set('saves', 'all');
  const hash = `#/explorer${q.toString() ? `?${q}` : ''}`;
  if (location.hash !== hash) history.replaceState(history.state, '', hash);
}

function results(data) {
  const entries = selectReports(data, filters);
  const cats = categoriesOf(data.reports);
  const cat = cats.find((c) => c.id === filters.category) || cats[0] || null;
  if (!cat) return h('div', { class: 'empty' }, 'No category grades to compare.');
  const { groups, missing } = compareCategory(entries, cat.id);
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);
  const out = h('div', null);
  if (groups.length > 1) {
    out.appendChild(h('div', { class: 'callout info xp-versions' }, `${groups.length} scoring versions · compare scores within a group only; a category is defined by its own profile.`));
  }
  const body = h('section', { class: 'card xp-card' },
    h('div', { class: 'card-head' },
      h('div', null, h('h2', { id: 'xp-cat-title' }, cat.label)),
      h('div', { class: 'actions' }, h('span', { class: 'xp-count' }, `${shown} report${shown === 1 ? '' : 's'}`))));
  if (!shown) body.appendChild(h('div', { class: 'empty' }, filters.q ? `No project matches “${filters.q}”.` : 'No report in view grades this category.'));
  for (const g of groups) {
    body.appendChild(h('h3', { class: 'xp-group', title: 'Scores are read under this scoring profile and rubric version' }, h('span', null, g.profile), h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), h('span', null, g.rubric), h('span', { class: 'n' }, `${g.rows.length}`)));
    body.appendChild(h('ol', { class: 'xp-rows', 'aria-label': `${cat.label}, ${g.key}` }, g.rows.map((e) => row(e, cat.id, cat.label))));
  }
  if (missing.length) {
    const who = missing.map((e) => `${e.project.name} · ${PROVIDER_LABELS[e.report.model] || e.report.model} (${e.report.profile_version || 'unknown profile'})`);
    body.appendChild(h('p', { class: 'xp-missing' }, `Not in ${missing.length} report${missing.length === 1 ? '' : 's'}: ${who.join('; ')}.`));
  }
  out.appendChild(body);
  return out;
}

function toolbar(data, redraw) {
  // Every category stays listed; its count is the reports in view (model
  // and saves filters) that grade it.
  const inView = selectReports(data, { ...filters, q: '' }).map((e) => e.report);
  const cats = categoriesOf(data.reports).map((c) => ({ ...c, count: inView.filter((r) => (r.category_scores || []).some((s) => s.category_id === c.id)).length }));
  const search = h('input', { type: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects', value: filters.q, autocomplete: 'off', spellcheck: 'false', dataset: { key: 'xp-search' } });
  search.addEventListener('input', () => {
    filters.q = search.value;
    redraw();
  });
  const category = h('select', { 'aria-label': 'Category', dataset: { key: 'xp-category' } }, cats.map((c) => h('option', { value: c.id, selected: c.id === filters.category || null }, `${c.label} (${c.count})`)));
  category.addEventListener('change', () => {
    filters.category = category.value;
    redraw();
  });
  const pick = (k) => (v) => {
    filters[k] = v;
    redraw({ controls: true });
  };
  return h('div', { class: 'toolbar xp-tools' },
    h('div', { class: 'search' }, search),
    seg('Model', [['all', 'All models'], ...PROVIDERS.map((p) => [p, PROVIDER_LABELS[p]])], filters.model, pick('model'), 'xp-model'),
    h('label', { class: 'xp-select' }, h('span', { class: 'sr-only' }, 'Category'), category),
    seg('Saves', [['latest', 'Latest'], ['all', 'All saves']], filters.saves, pick('saves'), 'xp-saves'));
}

async function load(ctx, { refresh = false } = {}) {
  try {
    const data = await ctx.api.get(`/api/explorer${refresh ? '?refresh=1' : ''}`);
    cache = { data, got: Date.now() };
  } catch (err) {
    const prev = cache ? cache.data : null;
    cache = { data: { ...(prev || { projects: [], reports: [] }), state: 'unavailable', configured: Boolean(prev && prev.configured), reason: `The desk did not answer: ${err.message}`, served: prev ? 'memory' : null, copy_fetched_at: prev ? prev.fetched_at : null }, got: Date.now() };
  }
  return cache.data;
}

export async function renderExplorer(ctx, route) {
  currentCtx = ctx;
  const reason = ctx.state.renderReason;
  // A live redraw of another part of the desk leaves this page as it is.
  if ((reason === 'live' || reason === 'same') && mounted && mounted.isConnected) return mounted;
  if (reason === 'nav' || !filters) {
    const q = route.query;
    filters = {
      q: q.get('q') || '',
      model: PROVIDERS.includes(q.get('model')) ? q.get('model') : 'all',
      category: q.get('category') || null,
      saves: q.get('saves') === 'all' ? 'all' : 'latest',
    };
  }
  // A minute's copy is reused (Refresh reads again); the server keeps its own
  // short cache in front of Supabase too.
  const data = cache && Date.now() - cache.got < CACHE_MS ? cache.data : await load(ctx);
  const cats = categoriesOf(data.reports);
  if (!cats.some((c) => c.id === filters.category)) filters.category = (cats.find((c) => c.id === 'legitimacy') || cats[0] || {}).id || null;

  const page = h('div', { class: 'xp-page' });
  const head = h('div', { class: 'page-head xp-head' }, h('div', { class: 'xp-title' }, h('h1', null, 'Research Explorer'), data.demo ? h('span', { class: 'xp-demo', title: 'Every record shown here is FICTIONAL, exported from the fixture file for learning. None is research.' }, 'Demo data') : null));
  const syncSlot = h('div', null);
  const toolsSlot = h('div', null);
  const resultsSlot = h('div', { id: 'xp-results' });
  page.append(head, syncSlot, toolsSlot, resultsSlot);

  const drawAll = (d) => {
    clear(syncSlot).appendChild(syncLine(d, { onRefresh }));
    const c = stateCallout(d);
    if (c) syncSlot.appendChild(c);
    clear(toolsSlot);
    clear(resultsSlot);
    if (Array.isArray(d.reports) && d.reports.length) {
      toolsSlot.appendChild(toolbar(d, redraw));
      resultsSlot.appendChild(results(d));
    }
  };
  function redraw({ controls = false } = {}) {
    syncUrl();
    const d = cache ? cache.data : data;
    if (controls) {
      // A segment's pressed state is part of the controls: redraw them, and
      // keep focus on the segment that was used.
      const k = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
      clear(toolsSlot).appendChild(toolbar(d, redraw));
      const back = k ? toolsSlot.querySelector(`[data-key="${CSS.escape(k)}"]`) : null;
      if (back) back.focus();
    }
    clear(resultsSlot).appendChild(results(d));
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const n = resultsSlot.querySelectorAll('.xp-row').length;
      announce(`${n} report${n === 1 ? '' : 's'} shown`);
    }, 400);
  }
  async function onRefresh() {
    const btn = syncSlot.querySelector('.xp-refresh');
    if (btn) btn.disabled = true;
    const d = await load(ctx, { refresh: true });
    if (!page.isConnected) return;
    const cs = categoriesOf(d.reports);
    if (!cs.some((c) => c.id === filters.category)) filters.category = (cs[0] || {}).id || null;
    drawAll(d);
    const again = syncSlot.querySelector('.xp-refresh');
    if (again) again.focus();
    announce(`${STATE_WORDS[d.state] || d.state}`);
  }
  drawAll(data);
  syncUrl();
  mounted = page;
  return page;
}
