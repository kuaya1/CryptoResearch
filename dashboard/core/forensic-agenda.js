'use strict';
// The review agenda (cr-review-agenda@1, 2026-10-17, the re-audit's ranked
// improvement #5): one primary next action per project, from records
// already on the desk.
//
// Each item says why it is due, the receipt, report or record behind it,
// and its basis in words:
//   - sourced: a date or a state a stored record gives (a forensic receipt's
//     frozen checkpoint schedule, a model's suggested review or horizon end
//     in its report, an open disagreement, an unreviewed evidence change);
//   - conditional: a conditional threshold estimate frozen at a receipt's
//     origin (never a forecast);
//   - Eric's choice: a review date Eric set himself.
// An item without a date stays undated and is never made primary. The agenda
// is always read from the latest intact receipt and the latest eligible
// reports: browsing an earlier receipt does not change it. Reading it writes
// nothing and asks nothing; it sends no notification and starts no research.
//
// Eric's actions (complete, snooze until a date, reopen) are lines in
// projects/<id>/forensics/agenda.jsonl, replay-safe by request ID; a
// completed item stays completed, a snooze ends on its date. An item's ID
// names its exact source (receipt and checkpoint, report and date,
// disagreement, evidence change), so a new receipt or report is a new item.

const { runOp, OpError } = require('./ops');
const { readJsonLines, sha256 } = require('./fsx');

const VERSION = 'cr-review-agenda@1';
const DAY = 86400000;
const BASIS = Object.freeze({ sourced: 'Sourced', conditional: 'Conditional estimate', owner: 'Your choice' });
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
// Order among items that are due: what is wrong with the record first, then
// what waits on Eric's judgment, then the dated reviews.
const RANK = { integrity: 0, disagreement: 1, evidence_change: 2, stale_evidence: 3, checkpoint: 4, owner_review: 5, model_review: 6, horizon_end: 7, research_stale: 8, conditional: 9 };
const UPCOMING_DAYS = 30;

const actionsRel = (pid) => `${require('./forensics').dirOf(pid)}/agenda.jsonl`;
const readActions = (ws, pid) => readJsonLines(ws.abs(actionsRel(pid))).filter((x) => x && !x._corrupt_line && x.schema_version === 'cr.agenda-action.v1');
const itemId = (pid, kind, key) => `ag_${sha256(`${pid}|${kind}|${key}`).slice(0, 16)}`;
const ymd = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const endOfDay = (d) => Date.parse(`${d}T23:59:59Z`);
const startOfDay = (d) => Date.parse(`${d}T00:00:00Z`);

// The candidates for one project, from its records (writes nothing).
function candidates(ws, project, { now = Date.now() } = {}) {
  const F = require('./forensics');
  const pid = project.project_id;
  const out = [];
  const add = (x) => out.push({ ...x, item_id: itemId(pid, x.kind, x.key) });
  // Forensics: the latest receipt, read as the tab reads it.
  const receipts = F.listReceipts(ws, pid).filter((r) => !r.broken);
  const assessed = F.investigatorReceipts(receipts);
  const latest = assessed[assessed.length - 1] || null;
  if (latest) {
    const integrity = F.receiptIntegrity(ws, pid, latest);
    if (!integrity.ok) {
      add({ kind: 'integrity', key: `${latest.receipt_id}|${integrity.problems.join('|')}`, title: 'Check the latest forensic receipt', why: `Its stored assessment does not agree with its verified original: ${integrity.problems[0]}`, due_at: latest.saved_at, basis: 'sourced', support: { kind: 'receipt', receipt_id: latest.receipt_id }, href: `#/project/${pid}/forensics?receipt=${latest.receipt_id}` });
    } else {
      const v = F.view(ws, pid, { now });
      const rid = latest.receipt_id;
      const dg = v.disagreements;
      if (dg && dg.status === 'compared' && dg.open) {
        const first = dg.items.find((i) => i.state === 'unjudged' || i.state === 'unresolved');
        add({ kind: 'disagreement', key: `${dg.assessment_receipt_id}|${dg.challenge_receipt_id}`, title: `Judge ${dg.open === 1 ? 'a disagreement' : `${dg.open} disagreements`} between Claude and ChatGPT`, why: `ChatGPT's challenge ${dg.challenge_receipt_id} reviewed finding ${first.finding_id} as ${first.challenge.verdict.replace(/_/g, ' ')}, and it has no judgment of yours.`, due_at: (v.challenge && v.challenge.saved_at) || latest.saved_at, basis: 'sourced', support: { kind: 'challenge', receipt_id: dg.challenge_receipt_id, assessment_receipt_id: dg.assessment_receipt_id, finding_id: first.finding_id }, href: `#/project/${pid}/forensics` });
      }
      // Evidence changes not yet reviewed: the item names the latest change
      // of each thread, so a newer change is a new agenda item.
      const ec = v.evidence_changes;
      const open = ec && Array.isArray(ec.threads) ? ec.threads.filter((t) => t.state === 'open' || t.state === 'reopened') : [];
      if (open.length) {
        const firsts = open.map((t) => ({ t, g: (t.since_review || []).find((g) => g.relevant) })).filter((x) => x.g).sort((a, b) => String(a.g.first_at).localeCompare(String(b.g.first_at)));
        const total = open.reduce((n, t) => n + (t.open_count || 0), 0);
        const f = firsts[0] || null;
        add({ kind: 'evidence_change', key: open.map((t) => t.latest_relevant_item_id).sort().join(','), title: `Review ${total === 1 ? 'an evidence change' : `${total} evidence changes`}`, why: f ? `${f.t.label}: ${f.g.class_words.toLowerCase()}${f.g.current && f.g.current.words ? ` (${f.g.current.words})` : ''} on ${String(f.g.first_at).slice(0, 10)}, not reviewed yet.` : 'A monitored check changed since your last review.', due_at: f ? f.g.first_at : latest.saved_at, basis: 'sourced', support: { kind: 'observation', target_id: f ? f.t.target_id : null, obs_id: f && f.g.current ? f.g.current.obs_id : null, item_id: f ? f.g.item_id : null }, href: `#/project/${pid}/forensics` });
      }
      // Evidence freshness: a monitored target that cannot be read now (its
      // outcome reads Unknown until it can), from the failing stretch on record.
      for (const t of (ec && Array.isArray(ec.threads) ? ec.threads : []).filter((x) => x.unavailable && !x.removed)) {
        const fail = [...(t.items || [])].reverse().find((i) => i.class === 'read_failed' && !i.ended_at) || null;
        if (!fail) continue;
        add({ kind: 'stale_evidence', key: `${t.target_id}|${fail.item_id}`, title: `${t.label} cannot be read`, why: `The monitor has had no successful reading since ${String(fail.at).slice(0, 10)} (${fail.count || 1} failed reading${(fail.count || 1) === 1 ? '' : 's'}); what it measures reads Unknown meanwhile, never as passing or failing.`, due_at: fail.at, basis: 'sourced', support: { kind: 'observation', target_id: t.target_id, obs_id: fail.last_obs_id || (fail.current && fail.current.obs_id) || null, item_id: fail.item_id }, href: `#/project/${pid}/forensics` });
      }
      // The latest checkpoint that has passed, and the next one. The
      // assessment's age is said with them; past the last checkpoint the
      // receipt's horizon has ended and only a new audit starts a new origin.
      const cps = (v.timeline && v.timeline.checkpoints) || [];
      const passed = cps.filter((c) => c.status === 'past');
      const lastPassed = passed[passed.length - 1] || null;
      const asOf = latest.assessment_as_of || latest.origin;
      const ageDays = Math.max(0, Math.floor((now - Date.parse(asOf)) / DAY));
      const age = `assessed ${ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`} (${String(asOf).slice(0, 10)})`;
      const next = cps.find((c) => c.status === 'upcoming');
      if (lastPassed) {
        const watch = lastPassed.watch || [];
        const ended = !next;
        add({ kind: 'checkpoint', key: `${rid}|${lastPassed.id}`, title: ended ? `Reassess: the horizon of receipt ${rid} has ended` : `Review the ${lastPassed.label} checkpoint`, why: ended ? `Its last checkpoint (${lastPassed.label}) passed on ${lastPassed.at.slice(0, 10)}; ${age}. Nothing later is read under this receipt; a new audit starts a new origin.` : `The ${lastPassed.label} checkpoint of receipt ${rid} passed on ${lastPassed.at.slice(0, 10)}; ${age}${watch.length ? `; ${watch.length === 1 ? 'a watch item' : `${watch.length} watch items`} from the assessment (${watch[0].signal})` : ''}.`, due_at: lastPassed.at, basis: 'sourced', support: { kind: 'receipt', receipt_id: rid, checkpoint: lastPassed.id }, href: `#/project/${pid}/forensics` });
      }
      if (next) add({ kind: 'checkpoint', key: `${rid}|${next.id}`, title: `Review the ${next.label} checkpoint`, why: `The ${next.label} checkpoint of receipt ${rid} is on ${next.at.slice(0, 10)}${(next.watch || []).length ? `, with ${next.watch.length === 1 ? 'a watch item' : `${next.watch.length} watch items`}` : ''}.`, due_at: next.at, basis: 'sourced', support: { kind: 'receipt', receipt_id: rid, checkpoint: next.id }, href: `#/project/${pid}/forensics` });
      // Conditional crossings frozen at the origin (never live estimates).
      const sao = latest.scenarios_at_origin || {};
      const metricWords = { volume: 'volume crosses the review level', exit_cost: 'exit cost crosses your limit' };
      for (const [metric, est] of Object.entries({ volume: sao.volume, exit_cost: sao.exit_cost })) {
        if (!est || est.status !== 'estimated' || !Array.isArray(est.scenarios)) continue;
        const s = est.scenarios.filter((x) => x.crosses_at && x.within_horizon && x.direction !== 'back').sort((a, b) => a.crosses_at.localeCompare(b.crosses_at))[0];
        if (s) add({ kind: 'conditional', key: `${rid}|${metric}|${s.kind}`, title: `Check whether ${metricWords[metric]}`, why: `Under the ${s.kind} assumption frozen in receipt ${rid}, it would cross around ${s.crosses_at}. A conditional threshold estimate, not a forecast.`, due_at: `${s.crosses_at}T12:00:00.000Z`, basis: 'conditional', support: { kind: 'receipt', receipt_id: rid, metric, scenario: s.kind }, href: `#/project/${pid}/forensics` });
      }
      if (sao.delivery && sao.delivery.status === 'estimated' && sao.delivery.within_horizon) add({ kind: 'conditional', key: `${rid}|delivery`, title: 'Check for a new release or commit', why: `${sao.delivery.words} (frozen in receipt ${rid}; a conditional date, not a forecast).`, due_at: `${sao.delivery.crosses_at}T12:00:00.000Z`, basis: 'conditional', support: { kind: 'receipt', receipt_id: rid, metric: 'delivery' }, href: `#/project/${pid}/forensics` });
    }
  }
  // Research: each model's latest eligible report (the desk's own selector).
  const { loadReports } = require('./reports');
  const { latestByProvider } = require('./compare');
  const latestReports = latestByProvider(loadReports(ws, pid));
  // Research age against Eric's own freshness limit (Settings).
  const staleDays = Number((((ws.settings || {}).freshness) || {}).research_stale_days) || 90;
  for (const [prov, r] of Object.entries(latestReports)) {
    if (!r) continue;
    const pc = r.assessment.position_context || null;
    const review = pc && pc.timing ? ymd(pc.timing.next_review_date) : null;
    const label = PROVIDER_LABELS[prov] || prov;
    const href = `#/project/${pid}/brief?model=${prov}`;
    const analysed = ymd(r.assessment.analysis_at) || ymd(r.meta && r.meta.imported_at);
    if (analysed) {
      const at = startOfDay(analysed) + staleDays * DAY;
      const day = new Date(at).toISOString().slice(0, 10);
      add({ kind: 'research_stale', key: `${r.report_id}|${staleDays}`, title: at <= now ? `${label}'s research is past your ${staleDays}-day freshness limit` : `${label}'s research reaches your ${staleDays}-day freshness limit on ${day}`, why: `${label}'s report ${r.report_id} reads the project as of ${analysed}; your research freshness limit in Settings is ${staleDays} days.`, due_at: `${day}T12:00:00.000Z`, basis: 'owner', support: { kind: 'report', report_id: r.report_id, provider: prov }, href });
    } else add({ kind: 'research_stale', key: `${r.report_id}|undated`, title: `${label}'s research has no analysis date`, why: `${label}'s report ${r.report_id} states no analysis date, so its age is unknown.`, due_at: null, basis: 'sourced', support: { kind: 'report', report_id: r.report_id, provider: prov }, href });
    if (review) add({ kind: 'model_review', key: `${r.report_id}|${review}`, title: `Review the research: ${label} suggested ${review}`, why: `${label}'s report ${r.report_id} suggests a review on ${review}${pc.timing.review_trigger ? ` (${String(pc.timing.review_trigger).slice(0, 200)})` : ''}. A model's suggestion, not your calendar.`, due_at: `${review}T12:00:00.000Z`, basis: 'sourced', support: { kind: 'report', report_id: r.report_id, provider: prov }, href });
    const end = pc && pc.horizon ? ymd(pc.horizon.end_date) : null;
    if (end) add({ kind: 'horizon_end', key: `${r.report_id}|${end}`, title: `${label}'s research horizon ends ${end}`, why: `The horizon of ${label}'s report ${r.report_id} runs to ${end}: past it, its view no longer covers the period.`, due_at: `${end}T12:00:00.000Z`, basis: 'sourced', support: { kind: 'report', report_id: r.report_id, provider: prov }, href });
    else if (!review) add({ kind: 'model_review', key: `${r.report_id}|undated`, title: `${label}'s research gives no review date`, why: `${label}'s report ${r.report_id} states no review date or horizon end, so none is set for it.`, due_at: null, basis: 'sourced', support: { kind: 'report', report_id: r.report_id, provider: prov }, href });
  }
  // Eric's own review dates.
  for (const e of require('./notes').loadEvents(ws, pid)) {
    if (e.status !== 'open' || e.type !== 'review') continue;
    const d = ymd(e.due_date);
    add({ kind: 'owner_review', key: `${e.event_id || e.id || e.title}|${d || 'undated'}`, title: e.title ? `Your review: ${String(e.title).slice(0, 120)}` : 'Your review', why: d ? `You set this review for ${d}.` : 'You set this review without a date.', due_at: d ? `${d}T12:00:00.000Z` : null, basis: 'owner', support: { kind: 'event', event_id: e.event_id || e.id || null }, href: `#/project/${pid}/notes` });
  }
  return out;
}

// Eric's latest action per item, read from the action lines.
function stateOf(actions) {
  const st = new Map();
  for (const a of actions) {
    if (a.action === 'reopen') st.delete(a.item_id);
    else st.set(a.item_id, a);
  }
  return st;
}

// The agenda for one project: the primary action and the rest.
function forProject(ws, project, { now = Date.now() } = {}) {
  const pid = project.project_id;
  const st = stateOf(readActions(ws, pid));
  const list = candidates(ws, project, { now }).map((x) => {
    const a = st.get(x.item_id) || null;
    const t = x.due_at ? Date.parse(x.due_at) : null;
    const due = t !== null && t <= now;
    const days = t === null ? null : Math.round((startOfDay(String(x.due_at).slice(0, 10)) - startOfDay(new Date(now).toISOString().slice(0, 10))) / DAY);
    const snoozed = a && a.action === 'snooze' && endOfDay(a.until) >= now ? { until: a.until, at: a.at, note: a.note || null } : null;
    return {
      ...x,
      basis_words: BASIS[x.basis],
      due,
      days,
      when: t === null ? 'No date' : due ? (days === 0 ? 'Due today' : `Due since ${String(x.due_at).slice(0, 10)}`) : days === 0 ? 'Today' : `In ${days} day${days === 1 ? '' : 's'} (${String(x.due_at).slice(0, 10)})`,
      completed: a && a.action === 'complete' ? { at: a.at, note: a.note || null } : null,
      snoozed,
    };
  });
  const open = list.filter((x) => !x.completed && !x.snoozed);
  const dueNow = open.filter((x) => x.due).sort((a, b) => RANK[a.kind] - RANK[b.kind] || String(a.due_at).localeCompare(String(b.due_at)));
  const upcoming = open.filter((x) => x.due_at && !x.due).sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  const primary = dueNow[0] || upcoming.find((x) => x.days <= UPCOMING_DAYS) || null;
  return {
    project_id: pid,
    name: project.name,
    symbol: project.symbol || null,
    primary,
    due: dueNow,
    upcoming,
    undated: open.filter((x) => !x.due_at),
    snoozed: list.filter((x) => x.snoozed),
    completed: list.filter((x) => x.completed),
  };
}

// The desk's agenda: one row per active project, the ones with something
// due first, then by their next date (writes nothing).
function agenda(ws, { now = Date.now() } = {}) {
  const P = require('./projects');
  const rows = [];
  const failed = [];
  for (const p of P.listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    try { rows.push(forProject(ws, p, { now })); } catch (e) { failed.push({ project_id: p.project_id, name: p.name, error: String(e.message || e).slice(0, 200) }); }
  }
  const key = (r) => (r.primary ? `${r.primary.due ? 0 : 1}|${r.primary.due ? String(RANK[r.primary.kind]).padStart(2, '0') : ''}|${r.primary.due_at}` : '2|');
  rows.sort((a, b) => key(a).localeCompare(key(b)) || String(a.name).localeCompare(String(b.name)));
  return { version: VERSION, generated_at: new Date(now).toISOString(), read_only: true, basis: BASIS, rows, failed, due: rows.filter((r) => r.primary && r.primary.due).length };
}

// Eric's action on one item: complete, snooze (until a date) or reopen.
function act(ws, pid, { item_id: id, action, until = null, note = null, request_id: requestId = null, by = null, now = Date.now() }) {
  if (typeof id !== 'string' || !/^ag_[0-9a-f]{16}$/.test(id)) throw new OpError('INVALID', 'Name the agenda item.');
  if (!['complete', 'snooze', 'reopen'].includes(action)) throw new OpError('INVALID', 'The action must be complete, snooze or reopen.');
  const day = action === 'snooze' ? ymd(until) : null;
  if (action === 'snooze' && (!day || endOfDay(day) < now)) throw new OpError('INVALID', 'Snooze until a date from today on (YYYY-MM-DD).');
  const text = typeof note === 'string' ? note.trim().slice(0, 600) || null : null;
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const project = require('./projects').getProject(ws, pid);
  const rel = actionsRel(pid);
  return runOp(ws, { type: 'agenda_action', summary: `Agenda ${action} for ${pid}` }, (op) => {
    const cur = op.readText(rel, '');
    const lines = cur.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const prior = reqId ? lines.find((l) => l.request_id === reqId) : null;
    if (prior) return { status: 'unchanged', action: prior };
    // The item must be one the agenda shows now (or one Eric acted on).
    const known = candidates(ws, project, { now }).find((x) => x.item_id === id) || lines.find((l) => l.item_id === id);
    if (!known) throw new OpError('NOT_FOUND', `No agenda item ${id} for ${project.name}.`);
    const last = stateOf(lines).get(id) || null;
    if (action === 'reopen' && !last) return { status: 'unchanged', action: null };
    if (last && last.action === action && (action !== 'snooze' || last.until === day)) return { status: 'unchanged', action: last };
    const at = new Date(now).toISOString();
    const line = { schema_version: 'cr.agenda-action.v1', action_id: `aa_${sha256(`${id}:${action}:${at}`).slice(0, 14)}`, version: VERSION, project_id: pid, item_id: id, kind: known.kind, key: known.key, action, until: day, note: text, at, by: by || ws.actor || null, request_id: reqId };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`);
    return { status: 'saved', action: line };
  });
}

module.exports = { VERSION, BASIS, actionsRel, readActions, candidates, forProject, agenda, act };
