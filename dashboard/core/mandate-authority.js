'use strict';
// The paper mandate's authority, Eric's latch on autonomy, and the
// Prosecutor's consistency, read at every boundary where the mandate acts
// (corrective PR "stabilize autonomous paper trading", 2026-10-31).
//
// Authority (cr-mandate-authority@1). A mandate grant is bound to the arming
// it was made under:
//   - Arming is an authenticated settings write that turns the loop on or sets
//     the mandate (server.js applySettings). Inside that write's lock the desk
//     records automation.mandate.authority { generation, armed_at, armed_by }:
//     a new generation on every arming, never one a client can send
//     (validateSettingsPatch refuses an `authority` key).
//   - Turning the loop off, or pausing automation, revokes the generation in
//     force (revoked_at). Resuming does not arm again; only a new arming does,
//     and its new generation never revives a grant made under an earlier one.
//   - A grant records { generation, armed_at, policy_sha256 }. policy_sha256
//     is mandateOf's settings_sha256, the SHA-256 of the whole mandate block,
//     authority included.
//   - At every opening and before every hour the book applies, the grant's
//     authority is read again (grantAuthority). It holds only while the same
//     generation, unrevoked, with the same policy, is on and unexpired, Eric
//     has not intervened on the project since, and the ticket is consistent.
//   - A grant recorded before this binding (no authority block) keeps its
//     record and opens nothing new.
//
// Eric's latch on autonomy (cr.autonomy.v1). Autonomous execution on a
// project is suspended by any intervention of his:
//   - a veto or an undo he recorded (decided_by not mandate:);
//   - an archive, the current one or one in its archive history;
//   - an explicit stop (projects/<id>/tickets/autonomy.jsonl).
// The suspension is derived from those records on every read, so it survives
// new exit quotes, replacement receipts, new reports, restarts, retries,
// replays, expiry and re-arming. Only his explicit rearm (setAutonomy, from
// the signed-in desk or the CLI, never from a model, a timer, pilot
// synchronization or an evidence refresh) clears the interventions it names.
// A grant he intervened after stays revoked, rearmed or not. His pass and
// watch decisions stay dispositions on their ticket: the mandate never grants
// or re-opens a ticket with any line of his.
//
// History is read strictly here. A decision or autonomy line that does not
// read stops the mandate on that project: unreadable history is not empty
// history.
//
// The Prosecutor's consistency. An automatic grant, or the opening of one, is
// held when any of these is true:
//   - the verdict is fatal_flaw;
//   - a recorded finding has severity fatal;
//   - a required prosecution field is missing or malformed.
// The raw block of the frozen ticket text is read for it, its SHA-256
// checked, so a value the save coerced (an unknown severity read as serious)
// is seen as malformed. A fatal_flaws entry that is serious or minor holds
// nothing. Eric's own review of such a ticket is untouched.

const fs = require('fs');
const crypto = require('crypto');
const { OpError, runOp } = require('./ops');

const AUTHORITY_VERSION = 'cr-mandate-authority@1';
const AUTONOMY_FORMAT = 'cr.autonomy.v1';
const AUTONOMY_ACTIONS = Object.freeze(['stop', 'rearm']);
const OPEN_PHASES = Object.freeze(['waiting', 'ready', 'order', 'open', 'closing']);

const iso = (ms) => new Date(ms).toISOString();
const decisionsRel = (pid) => `projects/${pid}/tickets/decisions.jsonl`;
const autonomyRel = (pid) => `projects/${pid}/tickets/autonomy.jsonl`;
const isMandate = (d) => Boolean(d && typeof d.decided_by === 'string' && d.decided_by.startsWith('mandate:'));

// ---------------------------------------------------------------------------
// Strict history

function parseStrict(text, rel, what) {
  const out = [];
  String(text || '').split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    let d = null;
    try { d = JSON.parse(l); } catch (_) { d = null; }
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new OpError('UNREADABLE', `${what} (${rel}) line ${i + 1} does not read, so the history is unknown; unreadable history is never read as empty.`, { rel, line: i + 1 });
    out.push(d);
  });
  return out;
}

function strictLines(ws, rel, what) {
  let text;
  try { text = fs.readFileSync(ws.abs(rel), 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new OpError('UNREADABLE', `${what} (${rel}) could not be read (${(err && err.code) || 'error'}), so the history is unknown.`, { rel });
  }
  return parseStrict(text, rel, what);
}

const readDecisionsStrict = (ws, pid) => strictLines(ws, decisionsRel(pid), 'The decision history');
const readAutonomyStrict = (ws, pid) => strictLines(ws, autonomyRel(pid), 'The autonomy record');

// ---------------------------------------------------------------------------
// Eric's latch on autonomy

function interventionsOf(project, decisions, autonomy) {
  const out = [];
  for (const d of decisions) {
    if ((d.action === 'veto' || d.action === 'undo') && !isMandate(d)) out.push({ id: d.decision_id, kind: d.action, at: d.decided_at || null, receipt_id: d.receipt_id || null, by: d.decided_by || null });
  }
  const archived = [];
  if (project && project.archive && project.archive.archived_at) archived.push(project.archive.archived_at);
  for (const h of project && Array.isArray(project.archive_history) ? project.archive_history : []) if (h && h.archived_at) archived.push(h.archived_at);
  for (const at of new Set(archived)) out.push({ id: `archive:${at}`, kind: 'archive', at, receipt_id: null, by: null });
  // An archived project with no archive time on record is still an intervention.
  if (project && project.status === 'archived' && !archived.length) out.push({ id: 'archive:unknown', kind: 'archive', at: null, receipt_id: null, by: null });
  for (const l of autonomy) if (l.action === 'stop') out.push({ id: l.line_id, kind: 'stop', at: l.at || null, receipt_id: null, by: l.by || null });
  return out;
}

const KIND_WORDS = { veto: 'veto', undo: 'Undo', archive: 'archive', stop: 'autonomy stop' };

function suspensionWords(pid, open) {
  const x = open[0];
  const more = open.length > 1 ? ` (and ${open.length - 1} more intervention${open.length === 2 ? '' : 's'})` : '';
  return `Autonomous execution on ${pid} is suspended by Eric's ${KIND_WORDS[x.kind] || x.kind}${x.id && !String(x.id).startsWith('archive:') ? ` ${x.id}` : ''}${x.at ? ` at ${x.at}` : ''}${more}. It stays suspended through new exit quotes, tickets and reports until he rearms it: on the desk POST /api/projects/${pid}/autonomy {"action":"rearm"}, or locally node dashboard/cli.js tickets autonomy ${pid} --rearm.`;
}

// { suspended, unreadable, interventions (not cleared), all, rearmed_at, words }.
function autonomyOf(ws, pid, { project = null, decisions = null } = {}) {
  const base = { version: AUTONOMY_FORMAT, project_id: pid };
  try {
    const ls = decisions || readDecisionsStrict(ws, pid);
    const au = readAutonomyStrict(ws, pid);
    const p = project || require('./projects').getProject(ws, pid);
    const all = interventionsOf(p, ls, au);
    const rearms = au.filter((l) => l.action === 'rearm');
    const cleared = new Set(rearms.flatMap((l) => (Array.isArray(l.clears) ? l.clears : [])));
    const open = all.filter((x) => !cleared.has(x.id));
    const last = rearms.length ? rearms[rearms.length - 1] : null;
    return { ...base, suspended: open.length > 0, unreadable: false, interventions: open, all, rearmed_at: last ? last.at || null : null, words: open.length ? suspensionWords(pid, open) : null };
  } catch (err) {
    return { ...base, suspended: true, unreadable: true, interventions: [], all: [], rearmed_at: null, words: `Autonomous execution on ${pid} is held: ${String(err && err.message || err).slice(0, 240)}` };
  }
}

// Eric's explicit stop or rearm. Only the signed-in desk's route and the CLI
// call this; no connector tool, model, timer or synchronization does. A rearm
// clears exactly the interventions open at its write, read inside the lock.
function setAutonomy(ws, pid, { action, note = null, request_id: requestId = null, by = null } = {}) {
  if (!AUTONOMY_ACTIONS.includes(action)) throw new OpError('INVALID', `The autonomy action is ${AUTONOMY_ACTIONS.join(' or ')}.`);
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const text = note === null || note === undefined ? null : String(note).replace(/\r\n/g, '\n').trim().slice(0, 600) || null;
  const rel = autonomyRel(pid);
  const out = runOp(ws, { type: `autonomy_${action}`, summary: `Autonomy ${action} on ${pid}` }, (op) => {
    const project = require('./projects').getProject(ws, pid);
    const cur = op.readText(rel, '');
    const lines = parseStrict(cur, rel, 'The autonomy record');
    const prior = reqId ? lines.find((l) => l.request_id === reqId) : null;
    if (prior) return { status: 'unchanged', line: prior };
    const decisions = readDecisionsStrict(ws, pid);
    const all = interventionsOf(project, decisions, lines);
    const cleared = new Set(lines.filter((l) => l.action === 'rearm').flatMap((l) => (Array.isArray(l.clears) ? l.clears : [])));
    const open = all.filter((x) => !cleared.has(x.id));
    if (action === 'rearm') {
      if (project.status === 'archived') throw new OpError('REFUSED', `${pid} is archived: restore it first, then rearm its autonomy.`);
      if (!open.length) return { status: 'unchanged', words: `Autonomous execution on ${pid} is not suspended; nothing to rearm.` };
    }
    const at = new Date().toISOString();
    const line = {
      schema_version: AUTONOMY_FORMAT,
      line_id: `au_${crypto.createHash('sha256').update(`${pid}|${action}|${at}|${lines.length}`).digest('hex').slice(0, 14)}`,
      project_id: pid,
      action,
      at,
      by: by || ws.actor || null,
      note: text,
      request_id: reqId,
      ...(action === 'rearm' ? { clears: open.map((x) => x.id) } : {}),
      meaning: action === 'rearm'
        ? 'Eric rearmed autonomous execution on this project. The interventions listed are cleared; grants made before them stay revoked.'
        : 'Eric stopped autonomous execution on this project until he rearms it.',
    };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`);
    return { status: 'saved', line };
  });
  const res = out.result || {};
  return { ...res, autonomy: autonomyOf(ws, pid), verified: out.verified !== false };
}

// ---------------------------------------------------------------------------
// The Prosecutor's consistency

// null when an automatic grant may rely on the ticket, else
// { code, words, problems }. Reads only.
function prosecutionHoldOf(ws, receipt) {
  const T = require('./tickets');
  const hold = (code, words, problems = []) => ({ code, words, problems });
  if (!receipt || receipt.kind === 'desk_gate') return hold('NOT_A_TICKET', 'The receipt is not a Prosecutor\'s ticket.');
  const type = (receipt.desk && receipt.desk.proposal_type) || 'no proposal';
  const p = receipt.prosecution;
  if (!p || typeof p !== 'object') return hold('PROSECUTION_MISSING', `The ticket carries no prosecution, so its ${type} cannot be granted automatically; Eric reviews it.`);
  if (p.verdict === 'fatal_flaw') return hold('FATAL_VERDICT', `The Prosecutor's verdict is fatal_flaw while the proposal is ${type}: a contradictory ticket is never granted automatically; Eric reviews it.`);
  if (Array.isArray(p.fatal_flaws) && p.fatal_flaws.some((f) => f && f.severity === 'fatal')) return hold('FATAL_FINDING', `The Prosecutor recorded a finding of severity fatal while the proposal is ${type}: it is never granted automatically; Eric reviews it.`);
  let raw = null;
  try {
    if (!receipt.text || !receipt.text.path || !receipt.text.sha256) throw new Error('The receipt names no saved ticket text.');
    const text = require('./forensics').verifiedFrozen(ws, receipt.text.path, receipt.text.sha256, 'The saved ticket text');
    raw = require('./forensics').findBlock(text, T.FORMAT).obj;
  } catch (err) {
    return hold('TEXT_UNREADABLE', `The Prosecutor's saved text cannot be read against its SHA-256 (${String(err && err.message || err).slice(0, 160)}), so its findings are unknown.`);
  }
  if (!raw || typeof raw !== 'object') return hold('BLOCK_MISSING', 'The Prosecutor\'s saved text holds no JSON block, so its findings are unknown.');
  const rp = raw.prosecution;
  const problems = [];
  if (!rp || typeof rp !== 'object' || Array.isArray(rp)) problems.push('prosecution');
  else {
    if (!T.VERDICTS.includes(rp.verdict)) problems.push('prosecution.verdict');
    if (!(typeof rp.conviction_score === 'number' && Number.isFinite(rp.conviction_score) && rp.conviction_score >= 0 && rp.conviction_score <= 100)) problems.push('prosecution.conviction_score');
    if (!rp.tests || typeof rp.tests !== 'object' || Array.isArray(rp.tests)) problems.push('prosecution.tests');
    else for (const k of T.TESTS) if (!rp.tests[k] || !['pass', 'fail', 'unknown'].includes(rp.tests[k].result)) problems.push(`prosecution.tests.${k}.result`);
    if (!Array.isArray(rp.fatal_flaws)) problems.push('prosecution.fatal_flaws');
    else {
      rp.fatal_flaws.forEach((f, i) => { if (!f || typeof f !== 'object' || !['fatal', 'serious', 'minor'].includes(f.severity)) problems.push(`prosecution.fatal_flaws[${i}].severity`); });
      // A fatal finding the save dropped (no finding text) still counts.
      if (rp.fatal_flaws.some((f) => f && f.severity === 'fatal')) return hold('FATAL_FINDING', `The Prosecutor's block records a finding of severity fatal while the proposal is ${type}: it is never granted automatically; Eric reviews it.`);
    }
    if (rp.verdict === 'fatal_flaw') return hold('FATAL_VERDICT', `The Prosecutor's block gives the verdict fatal_flaw while the proposal is ${type}: it is never granted automatically; Eric reviews it.`);
  }
  if (problems.length) return hold('MALFORMED', `The Prosecutor's ${problems.join(', ')} ${problems.length === 1 ? 'is' : 'are'} missing or malformed, so the ticket is not granted automatically; Eric reviews it.`, problems);
  return null;
}

// ---------------------------------------------------------------------------
// The authority generation

const policyOf = (a) => {
  const m = a && a.mandate && typeof a.mandate === 'object' && !Array.isArray(a.mandate) ? a.mandate : {};
  const { authority, ...rest } = m;
  return require('./requests').stableStringify(rest);
};
const liveOf = (a) => Boolean(a && a.autonomous_paper_loop === true && a.paused !== true);

// What a settings write does to the authority: the new authority block, or
// null when it leaves it as it is. Called inside applySettings's lock with the
// saved settings, the validated patch and the merged result.
//   - The patch arms (it sets the loop on, or the mandate) and the result is
//     live: a new generation.
//   - The result is not live and a generation is in force: it is revoked.
//   - Anything else (an unrelated write, a resume): unchanged.
function authorityNext(cur, patch, merged, { now = Date.now(), actor = null } = {}) {
  const a0 = (cur && cur.automation) || {};
  const pa = (patch && patch.automation) || {};
  const a1 = (merged && merged.automation) || {};
  const prev = a0.mandate && a0.mandate.authority && typeof a0.mandate.authority === 'object' ? a0.mandate.authority : null;
  const prevGen = prev && Number.isSafeInteger(prev.generation) && prev.generation >= 1 ? prev.generation : 0;
  const arms = pa.autonomous_paper_loop === true || pa.mandate !== undefined;
  if (arms && liveOf(a1)) {
    // The same policy, already live and unrevoked: no new generation.
    if (prev && prevGen && !prev.revoked_at && liveOf(a0) && policyOf(a0) === policyOf(a1)) return null;
    return { version: AUTHORITY_VERSION, generation: prevGen + 1, armed_at: iso(now), armed_by: actor || null };
  }
  if (!liveOf(a1) && prev && prevGen && !prev.revoked_at) {
    return { ...prev, revoked_at: iso(now), revoked_by: actor || null, revoked_because: a1.autonomous_paper_loop !== true ? 'loop_off' : 'paused' };
  }
  return null;
}

// Whether a decision's mandate authority holds now (and, with asOfMs, for an
// hour ending then): { ok, final, code, words }. Eric's own decisions are not
// this check's (ok). Reads only.
function grantAuthority(ws, d, { now = Date.now(), asOfMs = null, project = null, receipt = null } = {}) {
  const T = require('./tickets');
  const ok = { ok: true, final: false, code: null, words: null };
  if (!isMandate(d)) return ok;
  const no = (code, words, final = true) => ({ ok: false, final, code, words });
  const au = d.mandate && d.mandate.authority;
  if (!au || !Number.isSafeInteger(au.generation) || typeof au.policy_sha256 !== 'string') return no('MANDATE_LEGACY', `This grant was recorded by the paper mandate before its authority was bound to an arming (${AUTHORITY_VERSION}). Its record stands; it opens nothing new.`);
  const m = T.mandateOf(ws, now);
  if (!m.on) {
    const coveredUntilExpiry = m.expired && asOfMs !== null && asOfMs <= Date.parse(m.expires_at) && m.generation === au.generation && m.settings_sha256 === au.policy_sha256;
    if (!coveredUntilExpiry) return no(m.held ? 'MANDATE_HELD' : 'MANDATE_REVOKED', `The paper mandate's authority no longer covers this grant: ${m.why}`, !m.held);
  } else if (m.generation !== au.generation || m.settings_sha256 !== au.policy_sha256) {
    return no('MANDATE_REVOKED', `This grant was made under the paper mandate's generation ${au.generation}; generation ${m.generation} is in force now${m.generation === au.generation ? ' with other limits' : ''}, and a new arming never revives an earlier grant.`);
  }
  const pid = d.project_id;
  const st = autonomyOf(ws, pid, { project });
  if (st.suspended) return no('MANDATE_SUSPENDED', st.words, !st.unreadable);
  const t0 = Date.parse(d.decided_at);
  const after = st.all.find((x) => x.id !== d.decision_id && x.at && Number.isFinite(Date.parse(x.at)) && Number.isFinite(t0) && Date.parse(x.at) >= t0);
  if (after) return no('MANDATE_SUSPENDED', `Eric intervened (${KIND_WORDS[after.kind] || after.kind} ${after.id} at ${after.at}) after this grant: it opens nothing, rearmed or not.`);
  let r = receipt;
  if (!r) {
    try { r = JSON.parse(fs.readFileSync(ws.abs(`projects/${pid}/tickets/receipts/${d.receipt_id}.json`), 'utf8')); } catch (_) { r = null; }
  }
  if (!r) return no('MANDATE_RECEIPT', `Ticket receipt ${d.receipt_id} could not be read, so the grant's ticket cannot be checked.`, false);
  const ph = prosecutionHoldOf(ws, r);
  if (ph) return no('MANDATE_PROSECUTION_HOLD', ph.words);
  return ok;
}

// ---------------------------------------------------------------------------
// Capacity

// The mandate's grants today (New York day) and the grants that hold capacity:
// every mandate grant whose trader request is not finished (waiting, ready,
// an order, a position, closing) or that opens nothing for a reason that may
// pass (not_opened, not final). A grant the trader's view does not list holds
// capacity too. Throws when any history does not read (the caller refuses).
function mandateCapacity(ws, { now = Date.now(), projects = null } = {}) {
  const T = require('./tickets');
  const { ymdInTz } = require('./dates');
  const list = projects || require('./projects').listProjects(ws).filter((p) => !p.broken);
  const grants = [];
  for (const p of list) for (const l of readDecisionsStrict(ws, p.project_id)) if (T.isMandateLine(l) && (l.action === 'approve' || l.action === 'halve')) grants.push(l);
  const today = ymdInTz(new Date(now));
  const grantsToday = grants.filter((l) => Number.isFinite(Date.parse(l.decided_at)) && ymdInTz(new Date(l.decided_at)) === today).length;
  const ids = new Set(grants.map((l) => l.decision_id));
  const rq = require('./trader-desk').requests(ws, { now: iso(now) });
  const holding = rq.requests.filter((r) => ids.has(r.decision_id) && (OPEN_PHASES.includes(r.phase) || (r.phase === 'not_opened' && r.final !== true)));
  const listed = new Set(rq.requests.map((r) => r.decision_id));
  const unlisted = grants.filter((l) => !listed.has(l.decision_id));
  return {
    grants_today: grantsToday,
    open_grants: holding.length + unlisted.length,
    holding: [...holding.map((r) => ({ decision_id: r.decision_id, project_id: r.project_id, phase: r.phase })), ...unlisted.map((l) => ({ decision_id: l.decision_id, project_id: l.project_id, phase: 'unlisted' }))],
  };
}

// ---------------------------------------------------------------------------
// Status (corrective PR §7): for each pilot step, the next action and who
// takes it, what blocks it, the mandate's authority over the project, the
// claim, and the IDs of what it works on. Reads only; a part that does not
// read says so and the rest stands. No token, key or prompt text is in it.

// Who takes each step: an agent session, the desk by itself, or Eric.
const STEP_ACTOR = Object.freeze({ research: 'agent', ticket: 'agent', ticket_failed: 'agent', pm_review: 'agent', gate_closed: 'desk', contract_evidence: 'desk', exit_evidence: 'desk', blocked: 'eric', done: 'desk' });
const errWords = (err) => String((err && err.message) || err).slice(0, 200);

function statusRows(ws, steps, { now = Date.now(), sessions = null } = {}) {
  const T = require('./tickets');
  const TD = require('./trader-desk');
  const PC = require('./pilot-claims');
  let paused = null;
  try { paused = require('./workspace').automationPaused(ws); } catch (_) { paused = null; }
  let m;
  try { m = T.mandateOf(ws, now); } catch (err) { m = { on: false, why: `The mandate's settings could not be read (${errWords(err)}).` }; }
  const mandate = { on: Boolean(m.on), generation: m.generation === undefined ? null : m.generation, policy_sha256: m.settings_sha256 || null, expires_at: m.expires_at || null, why: m.on ? null : m.why || null };
  // The book is read through its one adapter (trader-desk.js), never directly.
  let requests = null;
  try { requests = TD.requests(ws, { now: iso(now) }).requests; } catch (_) { requests = null; }
  return (steps || []).map((s) => {
    const pid = s.project_id;
    const actor = STEP_ACTOR[s.step] || 'desk';
    const au = autonomyOf(ws, pid);
    const autonomy = { suspended: au.suspended, unreadable: au.unreadable, words: au.words };
    let grant = null;
    let grantProblem = null;
    try {
      const d = readDecisionsStrict(ws, pid).filter((l) => isMandate(l) && (l.action === 'approve' || l.action === 'halve')).pop() || null;
      if (d) {
        const a = grantAuthority(ws, d, { now });
        const r = requests ? requests.find((x) => x.decision_id === d.decision_id) || null : null;
        grant = {
          decision_id: d.decision_id, receipt_id: d.receipt_id, generation: d.mandate && d.mandate.authority ? d.mandate.authority.generation : null,
          authority: a.ok ? 'holds' : a.code, authority_words: a.ok ? null : a.words,
          phase: r ? r.phase : requests ? 'unlisted' : null, trade_words: r ? r.words : null,
          intent_id: TD.intentIdOf(d, 'open'), client_order_id: r ? r.client_order_id || null : null, order_state: r ? r.order_state || (requests ? 'none' : null) : null,
        };
      }
    } catch (err) { grantProblem = `The project's decisions could not be read (${errWords(err)}).`; }
    let claim = null;
    try {
      const rec = PC.read(ws, pid);
      const state = PC.peek(ws, pid, s, now);
      claim = rec ? { state: state || (rec.released ? 'released' : 'expired'), attempt_id: rec.attempt_id || null, role: rec.role || null, owner: rec.owner || null, expires_at: rec.expires_at || null, run_id: rec.run_id || null, ticket_id: rec.ticket_id || null } : null;
    } catch (err) { claim = { state: 'unreadable', words: errWords(err) }; }
    const noSessions = sessions && (sessions.unreadable || sessions.left === 0);
    const blocker = paused ? 'Automation is paused: no agent session and no new opening until Eric resumes it (a resume does not re-arm the mandate).'
      : grantProblem ? grantProblem
      : actor === 'agent' && claim && claim.state === 'claimed' ? `Claimed by ${claim.owner || 'a runner'} until ${claim.expires_at}.`
      : actor === 'agent' && claim && claim.state === 'reconcile' ? `Attempt ${claim.attempt_id}'s session outcome is not settled: Eric checks it, then releases the claim as reconciled.`
      : actor === 'agent' && noSessions ? (sessions.unreadable ? 'The daily session ledger could not be read: no session starts.' : `Today's ${sessions.ceiling} agent sessions are used: none starts until tomorrow (New York).`)
      : actor !== 'agent' && s.step !== 'done' ? s.why || null
      : autonomy.suspended ? autonomy.words
      : grant && grant.authority !== 'holds' ? grant.authority_words
      : grant && ['waiting', 'not_opened'].includes(grant.phase) ? grant.trade_words
      : null;
    return {
      project_id: pid, next_action: s.step, actor, blocker,
      authority: { mandate, autonomy, grant },
      claim,
      ids: { report_id: s.report_id || null, run_id: s.run_id || null, ticket_id: s.ticket_id || null, receipt_id: s.receipt_id || (grant ? grant.receipt_id : null), decision_id: grant ? grant.decision_id : null, intent_id: grant ? grant.intent_id : null, client_order_id: grant ? grant.client_order_id : null, attempt_id: claim ? claim.attempt_id || null : null },
    };
  });
}

module.exports = {
  statusRows,
  STEP_ACTOR,
  parseStrict,
  AUTHORITY_VERSION,
  AUTONOMY_FORMAT,
  AUTONOMY_ACTIONS,
  OPEN_PHASES,
  autonomyRel,
  readDecisionsStrict,
  readAutonomyStrict,
  autonomyOf,
  setAutonomy,
  prosecutionHoldOf,
  authorityNext,
  grantAuthority,
  mandateCapacity,
};
