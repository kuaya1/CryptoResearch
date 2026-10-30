'use strict';
// The daily brief (cr-daily-brief@1, 2026-10-25, W3.1): one deterministic read
// of what needs Eric today, from records already on the desk. Every line has
// its #/ deep link. It writes nothing, asks no provider and calls no model.
// A section it could not read says so ("Could not be read: ..."), never
// "nothing"; an empty section that was read says "None right now." A section
// where one project's record could not be read is partial: that project is
// named and the count is unknown.
//
// The text is the brief's own words in a fixed order; its SHA-256 is of that
// text, so the same records at the same time give the same hash.

//
// cr-daily-brief@2 (subtraction stage 3, 2026-10-29): the PM cards and the
// exceptions come from the one attention contract (public/attention-model.js,
// cr-attention@1, read through attention() below), the same rules the Desk
// and the Review queue use; a desk gate closed at $0 on a token Eric does not
// hold is one "Closed by the desk" line, never a card; progress closes it.

const { sha256 } = require('./fsx');
const A = require('../public/attention-model.js');

const VERSION = 'cr-daily-brief@2';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const EXIT_FRESH_HOURS = 72;
const OK_JOB = new Set(['ok', 'noop', 'attention', 'skipped', 'partial', 'busy', 'backoff', 'budget_paused', 'not_due']);

// The desk-wide reads the attention contract needs beside the index. Each is
// null when its record could not be read (said as an exception, its count
// unknown), never an empty list.
function attentionExtras(ws, rows, now) {
  const tryRead = (fn) => { try { return fn(); } catch (_) { return null; } };
  const jobs = tryRead(() => Object.entries(require('./jobs').readJobState(ws).jobs || {}).map(([job, s]) => ({
    job,
    failing: Boolean(s.last_status && !OK_JOB.has(s.last_status) && (!s.last_success_at || String(s.last_failure_at || '') > String(s.last_success_at))),
    at: s.last_failure_at || null,
    error: s.last_error || null,
  })));
  const queue = tryRead(() => require('./tickets').pilotQueue(ws, { now }));
  const trader = tryRead(() => {
    const v = require('./trader-desk').view(ws, { now });
    const out = [];
    if (v.settlement && v.settlement.state === 'unsettled') out.push({ project_id: null, record: 'trader-book', reason: 'book_unsettled', words: `The trader's Paper Book is not settled: ${v.settlement.words}` });
    for (const r of v.requests || []) {
      const at = r.phase === 'waiting' && r.exit_as_of ? Date.parse(r.exit_as_of) : NaN;
      if (!Number.isFinite(at)) continue;
      const left = at + EXIT_FRESH_HOURS * HOUR - now;
      if (left > 0 && left <= DAY) out.push({ project_id: r.project_id, record: r.decision_id, reason: 'exit_expiring', words: `${r.project}: the grant waits, and its exit reading lapses in ${Math.max(1, Math.round(left / HOUR))} h (${EXIT_FRESH_HOURS} h from ${r.exit_as_of}).` });
    }
    return out;
  });
  const intake = tryRead(() => require('./intake').listIntakes(ws, { limit: 50 })
    .filter((d) => d && !d.broken && d.status === 'needs_confirmation' && d.identity && d.identity.ambiguous)
    .map((d) => ({ intake_id: d.intake_id, label: d.link || null })));
  const restored = tryRead(() => require('./research').restoredHold(ws));
  return { jobs, queue, trader, intake, restored };
}

// What the desk finished in the 24 hours before `now`: reports saved, tickets
// saved and decisions made, from the index rows. One line.
function progressOf(rows, now) {
  const since = now - DAY;
  const inDay = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && t > since && t <= now; };
  let reports = 0;
  let tickets = 0;
  let decisions = 0;
  for (const r of rows) {
    for (const s of Object.values(r.providers || {})) if (s && !s.broken && inDay(s.imported_at)) reports += 1;
    const t = r.ticket && !r.ticket.unavailable ? r.ticket : null;
    if (t && inDay(t.saved_at)) tickets += 1;
    if (t && t.decision && inDay(t.decision.at)) decisions += 1;
  }
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return { since: new Date(since).toISOString(), reports, tickets, decisions, words: `Since yesterday: ${n(reports, 'report', 'reports')} saved, ${n(tickets, 'ticket', 'tickets')} saved, ${n(decisions, 'decision', 'decisions')} made.` };
}

// The one attention projection (cr-attention@1): decisions, exceptions and
// progress, from the index (built here unless handed in). Writes nothing.
function attention(ws, { now = Date.now(), index = null } = {}) {
  const idx = index || require('./indexer').buildIndex(ws, { now });
  const rows = idx.projects.filter((p) => p && !p.broken && p.status !== 'archived');
  const d = A.decisionsOf(rows);
  const brief = (p) => ({ project_id: p.project_id, name: p.name, receipt_id: p.ticket.receipt_id || null, proposal_type: p.ticket.proposal_type || null, status: p.ticket.status, suggested_risk_usd: p.ticket.suggested_risk_usd || 0, held: Boolean(p.held), saved_at: p.ticket.saved_at || null });
  const ex = A.exceptionsOf(idx, attentionExtras(ws, rows, now));
  return {
    format: A.VERSION,
    generated_at: new Date(now).toISOString(),
    decisions: { count: d.count, cards: d.cards.map(brief), closed_by_desk: d.closed.map(brief), unreadable: d.unreadable.map((p) => ({ project_id: p.project_id, name: p.name, error: p.ticket.error || null })) },
    exceptions: ex,
    progress: progressOf(rows, now),
    writes_nothing: true,
  };
}

const age = (fromIso, now) => {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 'age unknown';
  const h = Math.max(0, Math.round((now - t) / HOUR));
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};
const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toMs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

function brief(ws, { since = null, now = Date.now() } = {}) {
  const sinceMs = since === null || since === undefined || since === '' ? null : toMs(since);
  if (since && sinceMs === null) {
    const { OpError } = require('./ops');
    throw new OpError('INVALID', `"${since}" is not a date: give since as an ISO time such as 2026-10-24T00:00:00Z.`);
  }
  const sections = [];
  let index = null;
  let indexError = null;
  try { index = require('./indexer').buildIndex(ws, { now }); } catch (err) { indexError = err.message; }
  const rows = index ? index.projects.filter((p) => p && !p.broken && p.status !== 'archived') : [];
  const link = (pid) => `#/?p=${pid}`;

  // A line marked `unreadable` names one project's record that could not be
  // read: the section is then partial, its count unknown (review A07), never
  // "None right now" or a complete count.
  const section = (id, title, needsIndex, fn) => {
    let lines;
    let state = 'ok';
    let error = null;
    try {
      if (needsIndex && !index) throw new Error(`the desk's index could not be built (${indexError})`);
      lines = fn();
    } catch (err) {
      state = 'unreadable';
      error = err.message;
      lines = [{ text: `Could not be read: ${err.message}`, link: null }];
    }
    const failed = state === 'ok' ? lines.filter((l) => l.unreadable) : [];
    const read = state === 'ok' ? lines.filter((l) => !l.unreadable) : [];
    if (failed.length) {
      state = 'partial';
      error = `${failed.length} ${failed.length === 1 ? 'record' : 'records'} could not be read`;
    }
    if (state === 'ok' && !lines.length) lines = [{ text: 'None right now.', link: null }];
    sections.push({
      id, title, state, error,
      count: state === 'ok' ? lines.filter((l) => l.link || l.text !== 'None right now.').reduce((n, l) => n + (typeof l.n === 'number' ? l.n : 1), 0) : null,
      ...(state === 'partial' ? { count_read: read.length, unreadable_count: failed.length } : {}),
      lines: lines.map(({ unreadable, n, ...l }) => (unreadable ? { ...l, unreadable: true } : l)),
    });
  };

  const ticketOf = (r) => (r.ticket && !r.ticket.unavailable ? r.ticket : null);
  // A ticket the index could not read, named in each ticket section: whether
  // it waits, is invalidated or stands on a stale basis is unknown.
  const unreadableTickets = (what) => rows
    .filter((r) => r.ticket && r.ticket.unavailable)
    .map((r) => ({ text: `${r.name}: the ticket could not be read (${String(r.ticket.error || 'unknown error').replace(/\.$/, '')}), so whether it ${what} is unknown.`, link: link(r.project_id), unreadable: true }));

  // A Prosecutor ticket's compact trade plan (item 50): the receipt's own
  // numbers and the desk's reward:risk, "unknown" for each one absent.
  const planOf = (t) => {
    if (!t || t.desk_gate) return '';
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${v}` : 'unknown');
    const ez = t.entry_zone;
    const entry = ez && typeof ez.low_usd === 'number' && typeof ez.high_usd === 'number' ? `${n(ez.low_usd)}–${n(ez.high_usd)}` : 'unknown';
    const geo = t.trade_plan_geometry;
    const x = (v) => (typeof v === 'number' ? `${v.toFixed(1)}x` : 'unknown');
    const rr = `${x(geo && geo.plan_reward_risk_ratio)} at plan, ${x(geo && geo.reward_risk_ratio)} now`;
    const grade = t.researcher && (t.researcher.grade_display || (typeof t.researcher.grade === 'number' ? String(t.researcher.grade) : null));
    const conv = t.prosecution && typeof t.prosecution.conviction_score === 'number' ? String(t.prosecution.conviction_score) : null;
    return ` Entry ${entry}, target ${n(t.upside_target && t.upside_target.price_usd)}, invalidation ${n(t.invalidation_trigger && t.invalidation_trigger.price_usd)}, R:R ${rr}; Researcher ${grade || 'unknown'} vs Prosecutor ${conv || 'unknown'}.`;
  };

  // Order (item 67): risk-reducing tickets first, then those near their
  // invalidation price, then the rest, oldest first; desk gates close the
  // section as one line.
  const cardRank = (t) => (t.proposal_type === 'TRIM_EXIT' ? 0 : t.near_invalidation ? 1 : 2);
  // The cards and the closed desk gates are the attention contract's
  // (A.decisionsOf), the Desk's and the Review queue's own rule. A closed
  // desk gate is counted on its own line, never as a card.
  const decided = A.decisionsOf(rows);
  section('pm_cards', 'PM cards waiting for you', true, () => {
    const cards = decided.cards
      .sort((a, b) => cardRank(ticketOf(a)) - cardRank(ticketOf(b)) || String(ticketOf(a).saved_at).localeCompare(String(ticketOf(b).saved_at)))
      .map((r) => ({ text: `${r.name}: ${String(ticketOf(r).proposal_type || 'ticket').replace(/_/g, ' ')}${ticketOf(r).status === 'reopened' ? ' (re-opened)' : ''}, waiting ${age(ticketOf(r).saved_at, now)}.${planOf(ticketOf(r))}${r.report_delta && r.report_delta.status === 'ok' ? ` Claude's report: ${r.report_delta.line}.` : ''}`, link: link(r.project_id) }));
    const closed = decided.closed.sort((a, b) => String(ticketOf(a).saved_at).localeCompare(String(ticketOf(b).saved_at)));
    const closedLine = closed.length ? [{ text: `Closed by the desk (${closed.length}): ${closed.map((r) => r.name).join(', ')}.`, link: '#/research?tab=runs', n: 0 }] : [];
    return [...unreadableTickets('waits for you'), ...cards, ...closedLine];
  });

  // The attention contract's exceptions, each with its one recovery action;
  // a source it could not read makes the section partial.
  let att = null;
  section('exceptions', 'Exceptions', true, () => {
    att = attention(ws, { now, index });
    return att.exceptions.items.map((e) => ({ text: `${e.words} ${e.action.label}.`, link: e.action.href, ...(/_unreadable$/.test(e.reason) ? { unreadable: true } : {}) }));
  });

  section('invalidated', sinceMs === null ? 'Tickets invalidated (no since given: all)' : `Tickets invalidated since ${new Date(sinceMs).toISOString()}`, true, () => [...unreadableTickets('is invalidated'), ...rows
    .filter((r) => {
      const t = ticketOf(r);
      if (!t || t.status !== 'invalidated') return false;
      const at = toMs(t.invalidation && t.invalidation.fired && t.invalidation.fired.at);
      // A trigger with no reading time cannot be placed after `since`: said, not hidden.
      return sinceMs === null || at === null || at >= sinceMs;
    })
    .map((r) => {
      const t = ticketOf(r);
      const at = t.invalidation && t.invalidation.fired && t.invalidation.fired.at;
      return { text: `${r.name}: ${t.invalidation.words || 'invalidated'}${at ? '' : ' (reading time not on record)'}`, link: link(r.project_id) };
    })]);

  section('near_invalidation', 'Near invalidation', true, () => [...unreadableTickets('is near its invalidation price'), ...rows
    .filter((r) => ticketOf(r) && ticketOf(r).near_invalidation)
    .map((r) => ({ text: `${r.name}: ${ticketOf(r).near_invalidation.words}`, link: link(r.project_id) }))]);

  section('stale_basis', 'Tickets on a stale or superseded basis', true, () => [...unreadableTickets('stands on a stale basis'), ...rows
    .filter((r) => { const t = ticketOf(r); return t && !t.desk_gate && (t.superseded_by_report || (t.invalidation && t.invalidation.basis_stale)); })
    .map((r) => {
      const t = ticketOf(r);
      const why = t.invalidation && t.invalidation.basis_stale ? t.invalidation.basis_stale.why : `Claude's report ${t.researcher_report_id} is superseded by ${t.superseded_by_report}.`;
      return { text: `${r.name}: ${why}`, link: link(r.project_id) };
    })]);

  section('ticket_repairs', 'Tickets waiting on a repair or a fresh price', true, () => [...unreadableTickets('waits on a repair or a fresh price'), ...rows
    .flatMap((r) => {
      const t = ticketOf(r);
      if (!t) return [];
      const out = [];
      if (t.decision && t.decision.paper === 'missing') out.push({ text: `${r.name}: the grant is recorded but its paper position is missing: complete it on the card (Complete paper position) or \`tickets reconcile\`.`, link: link(r.project_id) });
      const held = t.admission && t.admission.held_risk;
      if (held && t.status === 'pending_pm_review') out.push({ text: `${r.name}: held to $0 by the admission check (${String(held.reason || 'the invalidation price could not be checked').replace(/\.$/, '')}): refresh prices, then ask for a new ticket (refresh).`, link: link(r.project_id) });
      return out;
    })]);

  section('pilot_exits', 'Pilot projects missing an exit reading', false, () => {
    const T = require('./tickets');
    // Only the pilot's rows are read here: a project not opted in is never scanned.
    const cands = T.pilotCandidates(ws, { now, pilotOnly: true });
    if (!cands.some((c) => c.in_pilot)) return [{ text: 'No project is in the pilot, so no exit reading is expected.', link: null, n: 0 }];
    return cands
      .filter((c) => c.in_pilot && c.exit_reading && c.exit_reading.present === false)
      .map((c) => ({ text: `${c.name || c.project_id}: no current exit reading at $${c.exit_reading.size_usd}.`, link: `#/project/${c.project_id}/forensics?fx=exits` }));
  });

  section('held', 'Held positions', true, () => {
    // Unrealized result and the distance to the invalidation price come from
    // the ledger and the ticket in force (core/position-brief.js).
    const pf = require('./portfolio').computePortfolio(ws, { market: require('./market').readLatest(ws) });
    const detail = new Map(require('./position-brief').describe(ws, pf, { now }).map((b) => [b.project_id, b]));
    return rows
      .filter((r) => r.held && r.position)
      .map((r) => {
        const v = isNum(r.position.value_usd) ? usd(r.position.value_usd) : 'value unknown';
        const m = r.market || {};
        const c = isNum(m.change_24h_pct) ? `24h ${pct(m.change_24h_pct)}` : '24h change unknown';
        const d = detail.get(r.project_id);
        const extra = d ? ` ${d.pnl.words} ${d.invalidation_distance.words}` : '';
        return { text: `${r.name}: ${v}, ${c}${r.position.price_status && r.position.price_status !== 'fresh' && r.position.price_status !== 'ok' ? ` (price ${String(r.position.price_status).replace(/_/g, ' ')})` : ''}.${extra}`, link: '#/portfolio' };
      });
  });

  // Held and paper lines never mix: each says which it is. An unreadable
  // record makes the section partial (core/position-brief.js checkpoints).
  section('horizons', 'Horizons', true, () => {
    const pb = require('./position-brief');
    const out = [];
    const pf = require('./portfolio').computePortfolio(ws, { market: require('./market').readLatest(ws) });
    const names = new Map(rows.map((r) => [r.project_id, r.name]));
    for (const p of pf.positions.filter((x) => !x.closed && x.asset_id !== 'usd')) {
      const nm = names.get(p.project_id) || p.asset_id;
      try {
        const h = pb.heldHorizon(ws, p, { now });
        const due = h.research ? `; ${h.research.words}` : '';
        out.push({ text: `Held: ${nm}: ${h.words}${due}`, link: p.project_id ? link(p.project_id) : '#/portfolio' });
      } catch (err) {
        out.push({ text: `Held: ${nm}: could not be read (${err.message}).`, link: '#/portfolio', unreadable: true });
      }
    }
    let book;
    try { book = require('./paper').book(ws, { now }); } catch (err) { out.push({ text: `Paper: the book could not be read (${err.message}).`, link: '#/research?tab=outcomes', unreadable: true }); }
    for (const q of (book ? book.positions : []).filter((x) => x.state === 'open')) {
      const h = pb.checkpoints(q, { now });
      out.push({ text: `Paper: ${q.name || q.project_id}: ${h.words}`, link: `#/project/${q.project_id}/brief` });
    }
    return out;
  });

  section('research_waiting', 'Research waiting per model', true, () => {
    const held = require('./research').heldProviders(ws);
    const per = new Map();
    for (const r of rows) {
      const provs = (r.research && r.research.providers) || {};
      for (const [prov, job] of Object.entries(provs)) {
        if (job && job.state === 'unconfigured') {
          if (!per.has(prov)) per.set(prov, []);
          per.get(prov).push(r.name);
        }
      }
    }
    return [...per.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([prov, names]) => ({ text: `${prov}: ${names.length} waiting (${names.sort().join(', ')})${held[prov] ? '; on hold, kept' : ''}.`, link: '#/research' }));
  });

  section('models_differ', 'Models differ', true, () => (index.attention || [])
    .filter((a) => a.kind === 'disagreement' && a.project_id && rows.some((r) => r.project_id === a.project_id))
    .map((a) => ({ text: String(a.title), link: `#/project/${a.project_id}/compare` })));

  section('spread', 'Grade spreads', true, () => {
    const out = [];
    for (const r of rows) {
      const sp = r.spread;
      if (!sp) continue;
      for (const a of sp.alerts) out.push({ text: `${r.name}: ${a.words}`, link: a.link });
    }
    return out;
  });

  section('freshness', 'Backup and prices', false, () => {
    const out = [];
    const b = require('./offsite').backupStatus(ws, process.env, now);
    out.push({ text: b.summary, link: '#/?prefs=data' });
    const m = require('./market').freshness(ws, now);
    out.push({ text: m.age_minutes === null ? `Prices: ${m.note || 'none stored yet'}.` : `Prices: ${String(m.freshness).replace(/_/g, ' ')}, last update ${m.age_minutes} min ago (stale after ${m.stale_after_minutes} min)${m.note ? `. ${m.note}` : ''}.`, link: '#/' });
    return out;
  });

  section('progress', 'Progress', true, () => [{ text: (att || attention(ws, { now, index })).progress.words, link: '#/research?tab=outcomes', n: 0 }]);

  const head = `Daily brief (${VERSION}), as of ${new Date(now).toISOString()}${sinceMs === null ? '' : `, since ${new Date(sinceMs).toISOString()}`}`;
  const countWords = (s) => (s.state === 'ok' ? ` (${s.count})` : s.state === 'partial' ? ` (${s.count_read} read; ${s.unreadable_count} could not be read, so the count is unknown)` : '');
  const text = [head, ...sections.flatMap((s) => ['', `${s.title}${countWords(s)}`, ...s.lines.map((l) => `- ${l.text}${l.link ? ` ${l.link}` : ''}`)])].join('\n');
  return { format: VERSION, generated_at: new Date(now).toISOString(), since: sinceMs === null ? null : new Date(sinceMs).toISOString(), sections, attention: att, text, text_sha256: sha256(text), writes_nothing: true };
}

module.exports = { brief, attention, VERSION };
