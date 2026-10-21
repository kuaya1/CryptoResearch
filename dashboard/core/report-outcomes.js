'use strict';
// What happened after each report (Eric, 2026-10-21: "the outcome flywheel").
// For every eligible report, its start (T0) is when its research run's
// evidence packet was captured, so every model in one run shares it (a report
// imported for no run starts when it was saved). The project's price and
// Bitcoin's are read from the desk's own hourly records
// (market-data/observations/YYYY-MM.jsonl) at T0 and 30, 60, 90 and 120 days
// later, and the report's return is set against BTC's over the same days:
// (1 + return) / (1 + BTC's return) - 1, the definition cycle.js uses.
//
// Computed on read; nothing is stored, and no report, grade or record
// changes. The report's own verdict, grade and invalidation triggers are
// frozen in the report itself (reports are immutable), so they are read from
// it, never copied. Nothing is interpolated: a reading is the nearest record
// within 6 hours of T0 and 24 hours of each later date, else "no price". A
// date still ahead is "pending" with its date.
//
// Per model it gives counts (reports, with a start price, matured at each
// horizon). A median and a share that beat BTC are shown only from
// MIN_COMPARABLE matured reports at that horizon: fewer cannot say anything
// about a model (the mission: a small sample or one market phase cannot
// establish an edge). Models are never ranked, averaged together or declared
// the more accurate one.

const fs = require('fs');
const { PROVIDERS } = require('./workspace');

const HORIZONS = [30, 60, 90, 120];
const DAY = 86400000;
const T0_TOLERANCE_MS = 6 * 3600000;
const LATER_TOLERANCE_MS = 24 * 3600000;
const MIN_COMPARABLE = 20;
const CHUNK = 1 << 20;

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
function monthsBetween(fromMs, toMs) {
  const out = [];
  const d = new Date(Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1));
  while (d.getTime() <= toMs) {
    out.push(d.toISOString().slice(0, 7));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// Reads a month's records a chunk at a time, parsing only lines that name one
// of the wanted assets, and hands each wanted asset's reading to onPoint.
function scanMonth(ws, month, ids, onPoint) {
  const file = ws.abs(`market-data/observations/${month}.jsonl`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (_) {
    return;
  }
  const needles = [...ids].map((id) => `"id":"${id}"`);
  const buf = Buffer.alloc(CHUNK);
  let rest = '';
  const line = (s) => {
    if (!s || !needles.some((n) => s.includes(n))) return;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch (_) {
      return;
    }
    for (const a of Array.isArray(rec.assets) ? rec.assets : []) {
      if (!a || !ids.has(a.id) || !(typeof a.price_usd === 'number' && a.price_usd > 0)) continue;
      const t = Date.parse(a.source_last_updated_at || a.fetched_at || rec.fetched_at);
      if (Number.isFinite(t)) onPoint(a.id, t, a.price_usd, typeof a.market_cap_usd === 'number' ? a.market_cap_usd : null);
    }
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      if (!n) break;
      const text = rest + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      rest = lines.pop();
      for (const s of lines) line(s);
    }
    line(rest);
  } finally {
    fs.closeSync(fd);
  }
}

// The nearest reading to each wanted time, per asset, within its tolerance.
function nearestReadings(ws, wants, now) {
  const byId = new Map();
  for (const w of wants) {
    if (!byId.has(w.id)) byId.set(w.id, []);
    byId.get(w.id).push(w);
  }
  if (!byId.size) return;
  const times = wants.map((w) => w.at);
  const from = Math.min(...times) - LATER_TOLERANCE_MS;
  const to = Math.min(now, Math.max(...times) + LATER_TOLERANCE_MS);
  const ids = new Set(byId.keys());
  for (const month of monthsBetween(from, to)) {
    scanMonth(ws, month, ids, (id, t, price, mcap) => {
      for (const w of byId.get(id)) {
        const gap = Math.abs(t - w.at);
        if (gap <= w.tolerance && (!w.best || gap < w.best.gap)) w.best = { gap, at: new Date(t).toISOString(), price_usd: price, market_cap_usd: mcap };
      }
    });
  }
}

const round = (x, d = 4) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// The reports an outcome is measured for: eligible, with a written text, and
// for each run and model only the latest save (a revision replaces the save
// it revises for this purpose; both stay on record).
function reportsOf(ws, pid) {
  const R = require('./reports');
  const all = R.loadReports(ws, pid).filter((r) => !r.broken);
  const keep = new Map();
  for (const r of all) {
    if (!R.isEligible(r) || r.assessment.source_format === 'pdf' || r.assessment.needs_text) continue;
    const runId = r.provenance && r.provenance.research_run_id;
    const key = runId ? `${runId}\u0000${r.meta.provider}` : `report\u0000${r.report_id}`;
    const cur = keep.get(key);
    if (!cur || R.reportSortKey(r) > R.reportSortKey(cur)) keep.set(key, r);
  }
  return { all, list: [...keep.values()] };
}

function startOf(ws, pid, r) {
  const runId = r.provenance && r.provenance.research_run_id;
  if (runId) {
    try {
      const run = require('./research').loadRun(ws, pid, runId);
      const at = run && run.evidence_packet && run.evidence_packet.captured_at;
      if (at && Number.isFinite(Date.parse(at))) return { at, basis: 'run_packet', run_id: runId };
    } catch (_) { /* fall back to the save time */ }
  }
  return { at: r.meta.imported_at, basis: 'saved', run_id: runId || null };
}

// Every measured report of the given projects, with its readings.
function measure(ws, projects, { now = Date.now() } = {}) {
  const { reportSummary } = require('./indexer');
  const rows = [];
  const wants = [];
  for (const p of projects) {
    const cg = p.identity && p.identity.status === 'verified' ? p.identity.coingecko_id : null;
    const { all, list } = reportsOf(ws, p.project_id);
    for (const r of list) {
      const s = reportSummary(ws, r, p, all);
      const start = startOf(ws, p.project_id, r);
      const t0 = Date.parse(start.at);
      const row = {
        project_id: p.project_id,
        name: p.name,
        symbol: p.symbol || null,
        report_id: r.report_id,
        provider: r.meta.provider,
        verdict: s.verdict || null,
        grade: s.grade || null,
        prompt_version: r.assessment.prompt_version || null,
        start: { ...start, project: null, btc: null },
        horizons: [],
        coingecko_id: cg,
      };
      if (!cg || !Number.isFinite(t0)) {
        row.note = cg ? 'No start time on record.' : 'No verified CoinGecko listing, so no price is on record.';
        rows.push(row);
        continue;
      }
      const w0 = { id: cg, at: t0, tolerance: T0_TOLERANCE_MS };
      const b0 = { id: 'bitcoin', at: t0, tolerance: T0_TOLERANCE_MS };
      wants.push(w0, b0);
      row._w = { w0, b0, later: [] };
      for (const days of HORIZONS) {
        const at = t0 + days * DAY;
        if (at > now) {
          row._w.later.push({ days, pending: true, due: new Date(at).toISOString() });
          continue;
        }
        const w = { id: cg, at, tolerance: LATER_TOLERANCE_MS };
        const b = { id: 'bitcoin', at, tolerance: LATER_TOLERANCE_MS };
        wants.push(w, b);
        row._w.later.push({ days, due: new Date(at).toISOString(), w, b });
      }
      rows.push(row);
    }
  }
  nearestReadings(ws, wants, now);
  const pick = (x) => (x.best ? { at: x.best.at, price_usd: x.best.price_usd, market_cap_usd: x.best.market_cap_usd } : null);
  for (const row of rows) {
    if (!row._w) continue;
    const { w0, b0, later } = row._w;
    row.start.project = pick(w0);
    row.start.btc = pick(b0);
    for (const h of later) {
      if (h.pending) {
        row.horizons.push({ days: h.days, status: 'pending', due: h.due });
        continue;
      }
      const p1 = pick(h.w);
      const b1 = pick(h.b);
      if (!row.start.project || !row.start.btc || !p1 || !b1) {
        row.horizons.push({ days: h.days, status: 'no_price', due: h.due, reason: !row.start.project || !row.start.btc ? 'No price on record near the start.' : 'No price on record within a day of this date.' });
        continue;
      }
      const ret = p1.price_usd / row.start.project.price_usd - 1;
      const btc = b1.price_usd / row.start.btc.price_usd - 1;
      row.horizons.push({ days: h.days, status: 'measured', due: h.due, at: p1.at, price_usd: p1.price_usd, return_pct: round(ret * 100, 2), btc_return_pct: round(btc * 100, 2), vs_btc_pct: round(((1 + ret) / (1 + btc) - 1) * 100, 2) });
    }
    if (!row.start.project) row.note = 'No price on record within 6 hours of the start.';
    delete row._w;
  }
  for (const row of rows) delete row._w;
  return rows;
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Per model: counts at each horizon; a median and the share that beat BTC
// only from MIN_COMPARABLE matured reports. In the fixed model order, never
// sorted by result.
function byModel(rows) {
  return PROVIDERS.map((provider) => {
    const mine = rows.filter((r) => r.provider === provider);
    return {
      provider,
      reports: mine.length,
      with_start: mine.filter((r) => r.start && r.start.project).length,
      horizons: HORIZONS.map((days) => {
        const xs = mine.map((r) => r.horizons.find((h) => h.days === days)).filter((h) => h && h.status === 'measured').map((h) => h.vs_btc_pct);
        const pending = mine.filter((r) => (r.horizons.find((h) => h.days === days) || {}).status === 'pending').length;
        const enough = xs.length >= MIN_COMPARABLE;
        return {
          days,
          matured: xs.length,
          pending,
          median_vs_btc_pct: enough ? round(median(xs), 2) : null,
          beat_btc: enough ? xs.filter((x) => x > 0).length : null,
          note: enough ? null : `Too few to judge: ${xs.length} of ${MIN_COMPARABLE} matured reports needed.`,
        };
      }),
    };
  });
}

const MEANING = `Return against BTC from the research run's start (when its evidence packet was captured), measured at 30, 60, 90 and 120 days from the desk's hourly price records; nothing interpolated. A median and a share that beat BTC appear only from ${MIN_COMPARABLE} matured reports per model at that horizon. It is not a forecast, an accuracy figure or a ranking of the models, and it changes no grade.`;

function deskOutcomes(ws, { now = Date.now() } = {}) {
  const projects = require('./projects').listProjects(ws).filter((p) => !p.broken);
  const rows = measure(ws, projects, { now });
  return { schema_version: 'cr.report-outcomes.v1', as_of: new Date(now).toISOString(), horizons_days: HORIZONS, min_comparable: MIN_COMPARABLE, meaning: MEANING, models: byModel(rows), reports: rows };
}

function projectOutcomes(ws, pid, { now = Date.now() } = {}) {
  const p = require('./projects').getProject(ws, pid);
  return { schema_version: 'cr.report-outcomes.v1', as_of: new Date(now).toISOString(), horizons_days: HORIZONS, min_comparable: MIN_COMPARABLE, meaning: MEANING, reports: measure(ws, [p], { now }) };
}

module.exports = { HORIZONS, MIN_COMPARABLE, deskOutcomes, projectOutcomes, measure, byModel, scanMonth };
