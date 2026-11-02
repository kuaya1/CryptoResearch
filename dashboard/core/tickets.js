'use strict';
// PM trade tickets: the Junior Trader pipeline, Phase 1 (2026-10-24).
//
// projects/<id>/tickets/
//   profile.json                       the autonomous pilot opt-in (Eric's)
//   <ticket_id>/ticket.json            the job: the frozen basis (Agent 1's
//                                       report, measured exits, the sizing
//                                       rules in force), the prompt's pin
//   <ticket_id>/packet.json            the frozen evidence packet (create-only)
//   <ticket_id>/prompt.md              the frozen Prosecutor prompt (create-only)
//   <ticket_id>/drafts/prosecutor.md   working draft, never a receipt
//   receipts/<receipt_id>.json         the saved ticket (create-only)
//   receipts/<receipt_id>.md           its full text as saved (create-only)
//   decisions.jsonl                    Eric's PM decisions (append-only)
//
// Agent 1 (Researcher) is Claude's latest eligible investment report, made
// under the research prompt as always. Agent 2 (Prosecutor) is Claude under
// cr-ticket-prompt@1: a short-seller's attack on Agent 1's report that ends in
// a structured ticket (cr.ticket.v1). The two are never averaged: each keeps
// its own figure and verdict, side by side.
//
// The desk computes what no model may: the exit cost at each of Eric's exit
// sizes (Preferences > Screening) comes from its own exit-quote readings
// (forensics.js), the size from his sizing rules (frozen into each ticket), and whether a
// ticket is invalidated is read against the hourly prices and the bound
// DefiLlama metric each time it is read; the stored ticket is never rewritten.
// A decision records what Eric chose. Nothing here places an order, moves
// money or calls a model or a paid provider.

const fs = require('fs');
const { runOp, withLock, OpError } = require('./ops');
const { readJson, listDir, sha256, jsonText } = require('./fsx');
const { compactTs, randomId, isProjectId } = require('./ids');

const PROMPT_VERSION = 'cr-ticket-prompt@1';
const FORMAT = 'cr.ticket.v1';
// @2 (Eric, 2026-10-24): a native L1 coin of at least $10B market cap passes
// the exit check without a DEX quote (exit_basis native_l1_liquid). A ticket
// keeps the version it froze: @1 tickets are read without the exemption.
// @3 (Eric, 2026-10-28): the exit at a size is the cheapest current reading
// whose cost is known in full, else the cheapest reading; a cheaper lower bound
// no longer hides a complete reading. Frozen tickets keep their exits.
// @4 (Eric, 2026-10-28, D4): one exit setting. The exit size, the ladder of
// sizes and the exit-cost limit are Preferences > Screening's
// (forensics.preferences), the same the Forensics tab reads; tickets.sizing
// no longer holds them. Each ticket still freezes the values it used.
const SIZING_VERSION = 'cr-ticket-sizing@4';
const INVALIDATION_VERSION = 'cr-ticket-invalidation@2';
const INVALIDATION_V1 = 'cr-ticket-invalidation@1';
// Pillar 1 PR C: @5 and @3 are in force only while Eric has the contract gate
// in mode enforce (settings tickets.contract_gate.mode). sizing@5 is @4 plus
// the frozen contract verdict (a block or a hold suggests no new risk; a block
// is a HARD_PASS); invalidation@3 is @2 plus the contract (the identity
// fingerprint changed, or the measured sell tax rose by TAX_SPIKE_BPS or more,
// after the save). In mode observe @4 and @2 stay in force, unchanged.
const SIZING_V5 = 'cr-ticket-sizing@5';
const INVALIDATION_V3 = 'cr-ticket-invalidation@3';
const TAX_SPIKE_BPS = 100;
// Rollback safety (2026-10-25): a receipt made under a newer rules version than
// this code knows is shown as saved, never re-read and never thrown on.
const RULE_KINDS = [
  { name: 'sizing', current: SIZING_V5, of: (r) => r.versions && r.versions.sizing },
  { name: 'invalidation', current: INVALIDATION_V3, of: (r) => (r.desk && r.desk.invalidation_version) || (r.versions && r.versions.invalidation) },
  { name: 'pregate', current: 'cr-ticket-pregate@2', of: (r) => r.pregate_version || (r.versions && r.versions.pregate) },
];
const versionNumber = (v) => { const m = /@(\d+)$/.exec(String(v || '')); return m ? Number(m[1]) : null; };
const MIN_COVERAGE_DEFAULT = 90;
const MAX_GAP_HOURS = 6;
// The desk's pre-gate (Eric, 2026-10-24): when the grade alone rules out new
// risk and he does not hold the asset, no Prosecutor runs; the desk saves its
// own gate result as a receipt (kind desk_gate), with no proposal.
// @2 (item 48): the grade closes the gate only under `pregate_max_grade`
// (default 48), so a near miss (48 up to the new-entry floor, or a range whose
// high end reaches it) gets a Prosecutor; @1 receipts keep their own rule.
const PREGATE_VERSION = 'cr-ticket-pregate@2';
const PACKET_FORMAT = 'cr.ticket-packet.v1';
const TICKET_RE = /^tk_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const RECEIPT_RE = /^tr_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const PROPOSALS = ['ACCUMULATE', 'LIMIT_TRAP', 'TRIM_EXIT', 'WATCH_ONLY', 'HARD_PASS'];
const RISK_TAKING = new Set(['ACCUMULATE', 'LIMIT_TRAP']);
const VERDICTS = ['thesis_survives', 'thesis_damaged', 'fatal_flaw'];
const TESTS = ['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims'];
const METRIC_KEYS = ['fees', 'revenue', 'holders_revenue'];
// approve, halve and veto answer a ticket that suggests risk; pass (and
// archive the project unless it is held), watch and trim answer one that
// suggests none (Eric, 2026-10-24: vetoing a hard pass read backwards).
const ACTIONS = ['approve', 'halve', 'veto', 'pass', 'watch', 'trim', 'reopen', 'undo'];
const STATUS_OF = { approve: 'risk_granted', halve: 'risk_granted', veto: 'vetoed', pass: 'passed', watch: 'watching', trim: 'trim_acknowledged', reopen: 'reopened' };
const MIN_TEXT = 600;
const MAX_TEXT = 400 * 1024;
const MAX_DRAFT = 400 * 1024;
const AS_OF_SLACK_MS = 10 * 60000;
// A Prosecutor's as_of ahead of the save by up to 30 minutes is the model's
// guess at its own clock, not a later fact: it is saved, recorded as the time
// of saving, and the receipt keeps what was written (as_of_clamped). Further
// ahead is refused. (2026-11-02: UNI's ticket wrote 11:52Z and was saved
// about 19 minutes before that.)
const AS_OF_AHEAD_MS = 30 * 60000;
const OPEN = new Set(['waiting', 'running']);
const HOUR = 3600000;

// Eric's sizing rules (2026-10-24), his choices and not universal rules:
// $500 standard risk (1.0R) only with a proven exit cost at his exit position
// within his exit-cost limit (Preferences > Screening, $500 and 5% unless he
// changes them) and a grade of at least 55; $250 the starter tranche (0.5R,
// "Halve Size"); under 40 nothing new, and under 55 nothing new for an asset he
// does not hold. Settings `tickets.sizing` may change the rest; each ticket
// freezes the values it was made under.
const SIZING_DEFAULTS = Object.freeze({
  standard_risk_usd: 500,
  starter_risk_usd: 250,
  min_grade_new_entry: 55,
  pregate_max_grade: 48,
  min_grade_any: 40,
  native_l1_min_market_cap_usd: 10e9,
});
const SIZING_NOTE = 'Your sizing rules (settings, tickets.sizing) with the exit position, exit sizes and exit-cost limit of your screening preferences (forensics.preferences), not universal rules. New tickets freeze the values in force; saved tickets keep theirs.';

const { isNum, round, usd, nearInvalidation, tradePlanGeometry } = require('./ticket-format');
const iso = (ms) => new Date(ms).toISOString();
const str = (v, max = 2000) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');

// ---------------------------------------------------------------------------
// Paths

function dirOf(pid) {
  if (!isProjectId(pid)) throw new OpError('BAD_ID', `Not a project ID: ${JSON.stringify(pid)}`);
  return `projects/${pid}/tickets`;
}
function ticketDir(pid, tid) {
  if (!TICKET_RE.test(String(tid))) throw new OpError('BAD_ID', `Not a ticket ID: ${JSON.stringify(tid)}`);
  return `${dirOf(pid)}/${tid}`;
}
const ticketRel = (pid, tid) => `${ticketDir(pid, tid)}/ticket.json`;
const draftRel = (pid, tid) => `${ticketDir(pid, tid)}/drafts/prosecutor.md`;
function receiptRel(pid, rid, ext = 'json') {
  if (!RECEIPT_RE.test(String(rid))) throw new OpError('BAD_ID', `Not a ticket receipt ID: ${JSON.stringify(rid)}`);
  return `${dirOf(pid)}/receipts/${rid}.${ext}`;
}
const decisionsRel = (pid) => `${dirOf(pid)}/decisions.jsonl`;
const profileRel = (pid) => `${dirOf(pid)}/profile.json`;

// ---------------------------------------------------------------------------
// Settings

function sizingOf(ws) {
  const s = (ws.settings && ws.settings.tickets && ws.settings.tickets.sizing) || {};
  const d = SIZING_DEFAULTS;
  const pos = (v, fb, max) => (isNum(v) && v > 0 && v <= max ? v : fb);
  const grade = (v, fb) => (isNum(v) && v >= 0 && v <= 100 ? v : fb);
  const standard = pos(s.standard_risk_usd, d.standard_risk_usd, 1e9);
  const minNew = grade(s.min_grade_new_entry, d.min_grade_new_entry);
  // The exit figures are the screening preferences' (@4), read with their own
  // bounds; a value left in tickets.sizing from before is not read.
  const screening = require('./forensics').prefsOf(ws);
  return {
    version: contractGateMode(ws) === 'enforce' ? SIZING_V5 : SIZING_VERSION,
    standard_risk_usd: standard,
    starter_risk_usd: Math.min(pos(s.starter_risk_usd, d.starter_risk_usd, 1e9), standard),
    exit_size_usd: screening.exit_position_usd,
    exit_sizes_usd: screening.exit_sizes_usd.slice(),
    max_exit_cost_pct: screening.exit_cost_limit_pct,
    exit_rules_from: 'forensics.preferences',
    min_grade_new_entry: minNew,
    min_grade_any: grade(s.min_grade_any, d.min_grade_any),
    pregate_max_grade: Math.min(grade(s.pregate_max_grade, d.pregate_max_grade), minNew),
    native_l1_min_market_cap_usd: pos(s.native_l1_min_market_cap_usd, d.native_l1_min_market_cap_usd, 1e15),
    note: SIZING_NOTE,
  };
}

// The sizes a ticket reads exits at (@4): the screening ladder and the exit
// position, from the sizing in force.
function exitSizesOf(sizing) {
  return [...new Set([...(sizing.exit_sizes_usd || [2000]), sizing.exit_size_usd])].sort((a, b) => a - b);
}

// Eric's choice, not a universal rule: the share of hours since a ticket with
// at least one hourly price reading below which a price check reads unknown.
function minCoveragePct(ws) {
  const v = ws.settings && ws.settings.tickets && ws.settings.tickets.invalidation && ws.settings.tickets.invalidation.min_coverage_pct;
  return isNum(v) && v > 0 && v <= 100 ? v : MIN_COVERAGE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Reading records

function readText(ws, rel) {
  try {
    return fs.readFileSync(ws.abs(rel), 'utf8');
  } catch (_) {
    return null;
  }
}

function verifiedFrozen(ws, rel, want, what) {
  return require('./forensics').verifiedFrozen(ws, rel, want, what);
}

function loadTicket(ws, pid, tid) {
  return readJson(ws.abs(ticketRel(pid, tid)), null);
}

function listTickets(ws, pid) {
  return listDir(ws.abs(dirOf(pid)), { dirs: true })
    .filter((d) => TICKET_RE.test(d))
    .map((d) => {
      try {
        return readJson(ws.abs(ticketRel(pid, d)), null);
      } catch (err) {
        return { ticket_id: d, broken: true, error: err.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function listReceipts(ws, pid) {
  return listDir(ws.abs(`${dirOf(pid)}/receipts`), { dirs: false })
    .filter((f) => f.endsWith('.json') && RECEIPT_RE.test(f.slice(0, -5)))
    .map((f) => {
      try {
        return readJson(ws.abs(`${dirOf(pid)}/receipts/${f}`), null);
      } catch (err) {
        return { receipt_id: f.slice(0, -5), broken: true, error: err.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => `${a.saved_at || ''}|${a.receipt_id}`.localeCompare(`${b.saved_at || ''}|${b.receipt_id}`));
}

function readDecisions(ws, pid) {
  const text = readText(ws, decisionsRel(pid)) || '';
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function readProfile(ws, pid) {
  return readJson(ws.abs(profileRel(pid)), null) || { schema_version: 'cr.ticket-profile.v1', project_id: pid, pilot: false, pilot_set_at: null, pilot_set_by: null };
}

function readDraft(ws, pid, tid) {
  return readText(ws, draftRel(pid, tid));
}

// ---------------------------------------------------------------------------
// The basis: Agent 1's report, the desk's measured exits, the market now

// Claude's current report by the desk's own selector (compare.latestByProvider,
// as the watchlist and the Brief read it), with the grade the desk calculates.
function researcherOf(ws, pid) {
  const { loadReports } = require('./reports');
  const { latestByProvider } = require('./compare');
  const { gradeAssessment } = require('./rubrics');
  const r = latestByProvider(loadReports(ws, pid)).claude;
  if (!r) return null;
  const a = r.assessment || {};
  const g = gradeAssessment(ws, a) || null;
  const file = r.meta && r.meta.original_file;
  const rel = file ? `${r.dir}/${file}` : null;
  return {
    report_id: r.report_id,
    provider: 'claude',
    run_id: (r.provenance && r.provenance.research_run_id) || null,
    analysis_at: a.analysis_at || null,
    verdict: a.verdict || null,
    model_version: a.model_version || null,
    rubric_version: a.rubric_version || null,
    sector_profile: a.sector_profile || null,
    grade: g ? { status: g.status, value: isNum(g.value) ? g.value : null, low: isNum(g.low) ? g.low : null, high: isNum(g.high) ? g.high : null, display: g.display || null, label: g.label || null, coverage_pct: isNum(g.coverage_pct) ? g.coverage_pct : null } : null,
    original: rel && !/\.pdf$/i.test(rel) && !a.needs_text ? { path: rel } : null,
  };
}

// The grade a gate uses: the figure, or a range's low end (a range takes its
// low end's tier on this desk); withheld or none is no grade.
function gateGrade(grade) {
  if (!grade) return null;
  if (isNum(grade.value)) return grade.value;
  if (isNum(grade.low)) return grade.low;
  return null;
}

// The exit cost at a size from the desk's own quote readings (the Forensics
// tab's view): the cheapest current reading whose cost is known in full, else
// the cheapest current reading (@3), or why there is none. A lower bound (a
// cost not known in full) is kept as "at least".
function exitsOf(ws, pid, sizes, now) {
  let v = null;
  try {
    v = require('./forensics').view(ws, pid, { now });
  } catch (err) {
    return sizes.map((s) => ({ size_usd: s, status: 'unavailable', cost_pct: null, cost_complete: null, note: `The exit readings could not be read: ${err.message}` }));
  }
  const rows = (v && v.liquidity && v.liquidity.exits) || [];
  return sizes.map((s) => {
    const row = rows.find((x) => x.size_usd === s);
    const b = row ? row.best_complete || row.best : null;
    const cost = b && isNum(b.cost_pct) ? round(b.cost_pct, 3) : null;
    return {
      size_usd: s,
      status: row ? row.status : 'no_reading',
      cost_pct: cost,
      // Only a cost known in full is complete: unknown completeness is not
      // (corrective PR 2026-10-31; it read as complete before).
      cost_complete: b ? b.cost_complete === true : null,
      missing_costs: b ? b.missing_costs || [] : [],
      method: b ? b.method || null : null,
      route_scope: b ? b.route_scope || null : null,
      as_of: (b && b.retrieved_at) || (row && row.as_of) || null,
      note: row ? row.note || null : `No exit reading at ${usd(s)}: approve exit quotes for this project (Forensics > Exits, or Quote exits for every project).`,
    };
  });
}

// Whether a reading is evidence a ticket can freeze now: a cost known in full
// (exitsOf drops stale and future-dated readings), or a current "no route",
// which is itself the answer. A number with unknown or missing costs is not.
function exitReady(row) {
  if (!row) return false;
  if (row.status === 'no_route') return true;
  return row.cost_complete === true && isNum(row.cost_pct);
}

// Why a Prosecutor waits for the exit reading (corrective PR 2026-10-31): the
// project has an approved exit-quote target, it is not a native L1 (whose exit
// needs no DEX quote), and the reading at the exit size is not ready. The
// forensic monitor asks for it on its own schedule, budget and backoff; the
// ticket is opened once it is, so the Prosecutor's ticket freezes it. Null
// when there is nothing to wait for. Reads only.
function exitWaitOf(ws, project, sizing, now) {
  if (project.identity && project.identity.native_chain === true) return null;
  let targets = [];
  try { targets = require('./forensics').readProfile(ws, project.project_id).targets.exit_quotes || []; } catch (_) { targets = []; }
  if (!targets.length) return null;
  const [x] = exitsOf(ws, project.project_id, [sizing.exit_size_usd], now);
  if (exitReady(x)) return null;
  const what = !x || x.cost_pct === null
    ? (x && x.note) || `No current exit reading at ${usd(sizing.exit_size_usd)}.`
    : `The reading at ${usd(sizing.exit_size_usd)} (${x.cost_pct}%) is not complete${x.missing_costs && x.missing_costs.length ? `: ${x.missing_costs.join(', ')} unknown` : ''}.`;
  return {
    exit: { size_usd: sizing.exit_size_usd, status: x ? x.status : 'no_reading', cost_pct: x ? x.cost_pct : null, cost_complete: x ? x.cost_complete : null, as_of: x ? x.as_of : null },
    why: `The Prosecutor waits for the desk's exit reading: ${what} The forensic monitor asks for it on its own schedule, budget and backoff; the ticket is opened once the reading is complete, so it freezes it. Nothing for an agent to do now.`,
  };
}

// Which sizes have no current reading, and why, in words, with the address of
// the Forensics tab's Exits segment where quotes are approved.
function exitsMissing(exits, pid) {
  return (exits || []).filter((x) => !isNum(x.cost_pct)).map((x) => ({
    size_usd: x.size_usd,
    status: x.status || 'no_reading',
    reason: x.note || `No current exit reading at ${usd(x.size_usd)}.`,
    link: `#/project/${encodeURIComponent(pid)}/forensics?fx=exits`,
  }));
}

// Who Eric holds, from one read of the portfolio: the project IDs with an open
// position, or null when the holdings could not be read ("not held" is then
// unknown). A call that goes over many projects reads it once and hands it to
// heldOf instead of reading the ledger again for each one.
function heldSetOf(ws, now) {
  try {
    const market = require('./market').readLatest(ws);
    const pf = require('./portfolio').computePortfolio(ws, { market, now });
    return new Set(pf.positions.filter((p) => !p.closed).map((p) => p.project_id));
  } catch (_) {
    return null;
  }
}

function heldOf(ws, pid, now, heldSet = undefined) {
  const set = heldSet === undefined ? heldSetOf(ws, now) : heldSet;
  return set === null ? null : set.has(pid);
}

function marketOf(ws, project) {
  const cg = project.identity && project.identity.coingecko_id;
  const row = cg ? (require('./market').readLatest(ws).assets || {})[cg] : null;
  if (!row) return { coingecko_id: cg || null, price_usd: null, note: cg ? 'No stored price for this token.' : 'No CoinGecko ID on the identity.' };
  return { coingecko_id: cg, price_usd: row.price_usd ?? null, market_cap_usd: row.market_cap_usd ?? null, fdv_usd: row.fdv_usd ?? null, volume_24h_usd: row.volume_24h_usd ?? null, as_of: row.source_last_updated_at || row.fetched_at || null };
}

function taxOf(ws, project, now) {
  try {
    const s = require('./screening').summary(ws, project, now);
    if (!s) return null;
    return { state: s.state || null, fetched_at: s.fetched_at || null, contracts: (s.contracts || []).map((c) => ({ chain: c.chain, address: c.address, status: c.status, sell_tax_pct: c.sell_tax_pct ?? null })) };
  } catch (_) {
    return null;
  }
}

function fundamentalsOf(ws, project, now) {
  try {
    return require('./fundamentals').summary(ws, project, now);
  } catch (err) {
    return { state: 'unavailable', reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// The sizing gate (cr-ticket-sizing@1, @2, @3): deterministic, from the frozen
// basis and the sizing the ticket froze.

// A native L1 coin (the identity says so; never inferred) whose stored market
// cap is at least the frozen threshold: its exit at Eric's size is not
// measured by a DEX quote (none exists for a chain's own coin), so it passes
// the exit check on that basis, said as such. Only under sizing that carries
// the threshold (@2 and later).
function nativeL1Liquid(basis, sizing) {
  const min = sizing.native_l1_min_market_cap_usd;
  const n = basis.native || {};
  return isNum(min) && n.native_chain === true && isNum(n.market_cap_usd) && n.market_cap_usd >= min;
}

function gate(basis, sizing, proposalType = null) {
  const grade = gateGrade(basis.researcher.grade);
  const held = basis.held === true;
  const exit = (basis.exits || []).find((x) => x.size_usd === sizing.exit_size_usd) || null;
  const reasons = [];
  let newRisk = true;
  if (grade === null) {
    newRisk = false;
    reasons.push(`Agent 1's grade is ${basis.researcher.grade ? basis.researcher.grade.status : 'missing'}: no new risk without a grade.`);
  } else if (grade < sizing.min_grade_any) {
    newRisk = false;
    reasons.push(`Grade ${grade} is under ${sizing.min_grade_any}: no new risk.`);
  } else if (grade < sizing.min_grade_new_entry && !held) {
    newRisk = false;
    reasons.push(`Grade ${grade} is under ${sizing.min_grade_new_entry} for a new entry.`);
  } else if (grade < sizing.min_grade_new_entry && held) {
    newRisk = false;
    reasons.push(`Grade ${grade} is under ${sizing.min_grade_new_entry}: a held position is not added to.`);
  }
  // sizing@5: the contract verdict frozen in the packet. A trim is never
  // blocked by it (held positions keep TRIM_EXIT).
  const contractTier = sizing.version === SIZING_V5 && basis.contract && basis.contract.verdict ? basis.contract.verdict.tier : null;
  if (contractTier === 'block' || contractTier === 'hold') {
    newRisk = false;
    reasons.unshift(`The contract gate ${contractTier === 'block' ? 'blocks' : 'holds'} new risk: ${basis.contract.words}`);
  }
  let exitOk = false;
  const native = nativeL1Liquid(basis, sizing);
  if (native) exitOk = true;
  else if (!exit || exit.cost_pct === null) reasons.push(`No current exit reading at ${usd(sizing.exit_size_usd)}: the exit cost is not proven within ${sizing.max_exit_cost_pct}%.`);
  else if (exit.cost_pct > sizing.max_exit_cost_pct) reasons.push(`Exit cost at ${usd(sizing.exit_size_usd)} is ${exit.cost_complete ? '' : 'at least '}${exit.cost_pct}%, over ${sizing.max_exit_cost_pct}%.`);
  else if (!exit.cost_complete) reasons.push(`Exit cost at ${usd(sizing.exit_size_usd)} is at least ${exit.cost_pct}% (${(exit.missing_costs || []).join(', ') || 'a cost'} unknown): a lower bound does not prove it within ${sizing.max_exit_cost_pct}%.`);
  else exitOk = true;
  const riskAllowed = newRisk && exitOk;
  const allowed = ['WATCH_ONLY', 'HARD_PASS', ...(held ? ['TRIM_EXIT'] : []), ...(riskAllowed ? ['ACCUMULATE', 'LIMIT_TRAP'] : [])];
  let type = proposalType;
  let capped = null;
  if (type && !allowed.includes(type)) {
    capped = { from: type, reason: RISK_TAKING.has(type) ? reasons.join(' ') : type === 'TRIM_EXIT' ? 'Nothing is held to trim.' : 'Not allowed.' };
    type = contractTier === 'block' ? 'HARD_PASS' : 'WATCH_ONLY';
  }
  if (!type) type = riskAllowed ? null : contractTier === 'block' || (grade !== null && grade < sizing.min_grade_any) ? 'HARD_PASS' : 'WATCH_ONLY';
  return {
    version: sizing.version || SIZING_VERSION,
    grade_used: grade,
    held,
    exit_basis: native ? 'native_l1_liquid' : 'measured',
    exit_cost_pct: exit ? exit.cost_pct : null,
    exit_cost_complete: exit ? exit.cost_complete : null,
    risk_allowed: riskAllowed,
    allowed_types: allowed,
    proposal_type: type,
    capped,
    suggested_risk_usd: type && RISK_TAKING.has(type) && riskAllowed ? sizing.standard_risk_usd : 0,
    reasons: riskAllowed ? [] : reasons,
    ...(contractTier ? { contract_tier: contractTier } : {}),
  };
}

// Why the grade closed the pre-gate (cr-ticket-pregate@1 records more, the rule
// is unchanged): `grade_low` (a firm grade, or a range's low end, under the
// floor) or `grade_withheld` (a retrieval gap reads differently from a weak
// project); null for anything else.
function gradeReasonKind(grade) {
  if (!grade) return null;
  if (gateGrade(grade) !== null) return 'grade_low';
  return grade.status === 'withheld' ? 'grade_withheld' : null;
}

// For a withheld grade: the share of investment weight scored and the
// components the report left unscored, read from the report's own
// investment_components. null when the report cannot be read again.
function withheldOf(ws, pid, researcher) {
  try {
    const { loadReports } = require('./reports');
    const r = require('./compare').latestByProvider(loadReports(ws, pid)).claude;
    if (!r || r.report_id !== researcher.report_id) return null;
    const g = require('./rubrics').gradeAssessment(ws, r.assessment || {});
    if (!g || g.status !== 'withheld') return null;
    return {
      scored_pct: isNum(g.coverage_pct) ? g.coverage_pct : null,
      unscored: (g.missing || []).map((m) => ({ id: m.id, label: m.label, status: m.status })),
    };
  } catch (_) {
    return null;
  }
}

const KIND_WORDS = { grade_low: 'the grade is under the floor', grade_withheld: 'the grade is withheld (a component was not scored), not a weak score' };

// Does the grade alone rule out new risk for an asset Eric does not hold
// (cr-ticket-pregate@2, pregate_max_grade)? Only
// a known "not held" counts (an unreadable portfolio opens a normal ticket).
// Returns the gate's grade reason, else null.
function pregateReason(researcher, held, sizing) {
  if (held !== false) return null;
  const grade = gateGrade(researcher.grade);
  if (grade !== null && grade >= sizing.min_grade_new_entry) return null;
  // cr-ticket-pregate@2: a near miss gets a Prosecutor. The gate stays closed
  // only for a withheld or missing grade, or one under pregate_max_grade whose
  // range (if any) does not reach the new-entry floor at its high end.
  if (grade !== null && grade >= sizing.pregate_max_grade) return null;
  if (grade !== null && isNum(researcher.grade.high) && researcher.grade.high >= sizing.min_grade_new_entry) return null;
  const g = gate({ researcher, held: false, exits: [], native: null }, sizing);
  return g.reasons[0] || null;
}

// ---------------------------------------------------------------------------
// Prompt

// The code's own published template, only when it matches its pin
// (template-lock.js); a workspace copy is never read (D5).
function templateText(ws, name) {
  return require('./template-lock').lockedText('tickets', name);
}

function skeleton(ticket) {
  return {
    format: FORMAT,
    ticket_id: ticket.ticket_id,
    project_id: ticket.project_id,
    prompt_version: PROMPT_VERSION,
    role: 'prosecutor',
    model: 'claude',
    model_version: null,
    as_of: 'YYYY-MM-DDTHH:MM:SSZ',
    researcher_report_id: ticket.basis.researcher.report_id,
    researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: VERDICTS.join(' | '),
      conviction_score: 'integer 0-100 (your own; never Agent 1\'s, never an average) | null',
      tests: Object.fromEntries(TESTS.map((t) => [t, { result: 'pass | fail | unknown', finding: '', source_ids: ['S1'] }])),
      fatal_flaws: [{ test: `${TESTS.join(' | ')} | other`, severity: 'fatal | serious | minor', finding: '', source_ids: ['S1'] }],
      strongest_bull_rebuttal: '',
    },
    proposal: {
      proposal_type: PROPOSALS.join(' | '),
      non_consensus_thesis: 'one sentence',
      entry_zone: { low_usd: null, high_usd: null, basis: '' },
      upside_target: { price_usd: null, basis: '' },
      invalidation_trigger: { price_usd: null, metric: { key: `${METRIC_KEYS.join(' | ')}`, below_30d_usd: null }, statement: '' },
    },
    agent_disagreement_note: '',
    sources: [{ source_id: 'S1', url: 'https://...', publisher: '', retrieved_at: '', excerpt: '' }],
  };
}

function sizingBlock(s) {
  return [
    `- Standard risk (1.0R): ${usd(s.standard_risk_usd)}, only when the desk's measured exit cost at ${usd(s.exit_size_usd)} is at most ${s.max_exit_cost_pct}% (known in full, not a lower bound) and Agent 1's grade is at least ${s.min_grade_new_entry}.`,
    `- Starter tranche (0.5R): ${usd(s.starter_risk_usd)}, Eric's choice at review ("Halve Size").`,
    `- Grade under ${s.min_grade_any}: no new risk (HARD_PASS or WATCH_ONLY). Under ${s.min_grade_new_entry} for an asset Eric does not hold: no new entry (WATCH_ONLY or HARD_PASS).`,
    ...(isNum(s.native_l1_min_market_cap_usd) ? [`- A native L1 coin (the chain's own coin, per its verified identity) with a market cap of at least ${usd(s.native_l1_min_market_cap_usd)} passes the exit check without a DEX quote (exit basis "native L1 liquid"); a token never does.`] : []),
    '- The desk applies these rules itself after you save. You propose the type; you never choose a dollar amount.',
  ].join('\n');
}

function renderPrompt(ws, { ticket, project, packetText, packetSha, reportText }) {
  const fill = (tpl, vars) => tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  return fill(templateText(ws, 'ticket-prompt.v1.md'), {
    PROJECT_NAME: project.name,
    SYMBOL: project.symbol || 'no ticker',
    PROJECT_ID: project.project_id,
    TICKET_ID: ticket.ticket_id,
    CREATED_AT: ticket.created_at,
    REPORT_ID: ticket.basis.researcher.report_id,
    REPORT_SHA256: ticket.basis.researcher.original.sha256,
    SIZING_BLOCK: sizingBlock(ticket.sizing),
    PACKET_SHA256: packetSha,
    PACKET_JSON: packetText.trim(),
    REPORT_TEXT: reportText.trim(),
    SKELETON: `\`\`\`json\n${JSON.stringify(skeleton(ticket), null, 2)}\n\`\`\``,
  });
}

function promptFor(ws, ticket) {
  try {
    const text = verifiedFrozen(ws, ticket.prompt && ticket.prompt.path, ticket.prompt && ticket.prompt.sha256, 'The frozen Prosecutor prompt');
    verifiedFrozen(ws, ticket.packet && ticket.packet.path, ticket.packet && ticket.packet.sha256, 'The frozen ticket packet');
    return { text, sha256: ticket.prompt.sha256, chars: text.length, version: ticket.prompt.version };
  } catch (err) {
    if (err.code !== 'INTEGRITY') throw err;
    return { text: null, error: err.message, code: 'INTEGRITY' };
  }
}

// ---------------------------------------------------------------------------
// Opening a ticket

function openTicket(ws, pid) {
  return listTickets(ws, pid).filter((t) => !t.broken && t.job && OPEN.has(t.job.state)).pop() || null;
}

function updateTicket(ws, pid, tid, mutate, summary, type = 'ticket_update') {
  const rel = ticketRel(pid, tid);
  return runOp(ws, { type, summary }, (op) => {
    const t = op.readJson(rel, null);
    if (!t) throw new OpError('NOT_FOUND', `No ticket ${tid} for ${pid}.`);
    const res = mutate(t, op);
    if (res && res.noop) return res;
    op.writeJson(rel, t);
    return res || {};
  });
}

// Before sizing: when the verified token has no current reading at the exit
// size, ask for one fixed-size quote (forensic-monitor.js quoteSizeUsd: the
// approved adapter, its gates, budget and hold; never a wallet or swap). Async,
// so it belongs to the route and CLI, not the pure createTicket. A failed or
// refused quote falls back to "no reading" with the reason, which the packet
// carries (exit_quote_attempt). Writes nothing when a reading exists.
async function prepareExitQuote(ws, pid, opts = {}) {
  const now = opts.now !== undefined ? opts.now : Date.now();
  const project = require('./projects').getProject(ws, pid);
  if (project.status === 'archived' || !project.identity || project.identity.status !== 'verified') return null;
  const size = sizingOf(ws).exit_size_usd;
  const [row] = exitsOf(ws, pid, [size], now);
  // A current number, complete or not, is not asked again: a second quote
  // does not make an unknown cost known. Whether it is ready for a ticket is
  // exitReady's question (nextStep waits on it).
  if (row.status !== 'unavailable' && row.cost_pct !== null) return null;
  const out = await require('./forensic-monitor').quoteSizeUsd(ws, pid, { size_usd: size, fetchImpl: opts.fetchImpl, cgGetImpl: opts.cgGetImpl, sleep: opts.sleep, now: opts.now });
  return { size_usd: size, status: out.status, reason: out.reason || null, asked_at: iso(Date.now()) };
}

// Opens the Prosecutor's ticket on Claude's current report (or resumes the
// one open). assistant: true when Claude takes it at once (connector, CLI
// runner). refresh: a new ticket although one was saved on the same report.
function createTicket(ws, args = {}) {
  const pid = args.project_id;
  const project = require('./projects').getProject(ws, pid);
  if (project.status === 'archived') throw new OpError('INVALID', `${project.name} is archived. Restore it before opening a ticket.`);
  if (!project.identity || project.identity.status !== 'verified') return { status: 'needs_identity', project_id: pid, message: `${project.name}'s identity is not verified, so no ticket was opened: the Prosecutor and the exit readings must name one verified token.` };
  if (require('./research').heldProviders(ws).claude) throw new OpError('REFUSED', 'Claude is on hold on this desk: it takes no new job. Eric can lift the hold in Settings.');
  const now = Date.now();
  const at = iso(now);
  const assistant = Boolean(args.assistant);
  if (args.reopen === true) {
    const latest = listReceipts(ws, pid).filter((r) => !r.broken).pop() || null;
    if (!reopenReason(ws, project, latest, { now })) throw new OpError('REFUSED', 'Re-open applies only when the ticket in force is invalidated, was sized under an older rules version than the one in force, or its exit readings expired before any grant. It is none of these; nothing was opened.');
    args = { ...args, refresh: true };
  }
  const open = openTicket(ws, pid);
  if (open && !args.restart) {
    if (assistant && open.job.state === 'waiting') updateTicket(ws, pid, open.ticket_id, (t) => { if (t.job.state !== 'waiting') return { noop: true }; Object.assign(t.job, { state: 'running', mode: args.mode || 'cowork', updated_at: at, note: 'Taken by Claude.' }); return {}; }, `Claude takes ticket ${open.ticket_id}`);
    return { status: 'resumed', project_id: pid, ticket_id: open.ticket_id, ticket: loadTicket(ws, pid, open.ticket_id), message: `Resuming the open ticket ${open.ticket_id} for ${project.name} (opened ${open.created_at}).` };
  }
  const researcher = researcherOf(ws, pid);
  if (!researcher) return { status: 'needs_research', project_id: pid, message: `${project.name} has no eligible Claude report, so there is nothing for the Prosecutor to attack. Run Agent 1 first (Claude research).` };
  if (!researcher.original) return { status: 'needs_text', project_id: pid, report_id: researcher.report_id, message: `Claude's current report on ${project.name} (${researcher.report_id}) has no text the Prosecutor can read (a PDF, or saved without its text).` };
  const reportText = readText(ws, researcher.original.path);
  if (reportText === null) throw new OpError('INTEGRITY', `The original text of ${researcher.report_id} is missing (${researcher.original.path}). Nothing was opened.`);
  researcher.original.sha256 = sha256(reportText);
  researcher.original.chars = reportText.length;
  const sizing = sizingOf(ws);
  const held = heldOf(ws, pid, now);
  const pregate = args.force_prosecution !== true && !args.restart && pregateReason(researcher, held, sizing) !== null;
  // A contract block's gate stands for the contract it read (its replay key
  // is the report and the identity fingerprint): once the fingerprint
  // changes, the same report may open a ticket.
  const idNow = sizing.version === SIZING_V5 ? contractIdentityNow(ws, project, now) : null;
  const onReport = listReceipts(ws, pid).filter((r) => !r.broken && r.researcher && r.researcher.report_id === researcher.report_id && !(args.force_prosecution === true && r.kind === 'desk_gate') && gateStands(r, idNow)).pop() || null;
  if (pregate && onReport && onReport.kind === 'desk_gate') return { status: 'unchanged', gate_closed: true, project_id: pid, receipt_id: onReport.receipt_id, receipt: onReport, verified: true, message: `The desk's gate on Claude's current report (${researcher.report_id}) is already saved (${onReport.receipt_id}). No Prosecutor runs; pass force_prosecution: true only when Eric asks for one.` };
  if (!args.refresh && !args.restart && onReport && contractBlockGate(onReport)) return { status: 'unchanged', gate_closed: true, project_id: pid, receipt_id: onReport.receipt_id, receipt: onReport, verified: true, message: `The desk's contract gate on Claude's current report (${researcher.report_id}) is already saved (${onReport.receipt_id}) for the contract as it stands. No Prosecutor runs until the contract changes.` };
  if (!args.refresh && !args.restart && onReport) return { status: 'exists', project_id: pid, receipt_id: onReport.receipt_id, ticket_id: onReport.ticket_id, message: `A ticket on Claude's current report (${researcher.report_id}) is already saved (${onReport.receipt_id}). Nothing new was opened; pass refresh: true only when Eric asks for another.` };
  if (open && args.restart) cancelTicket(ws, pid, open.ticket_id, 'Eric asked to start the ticket over.');
  const tid = `tk_${compactTs(new Date(now))}_${randomId(5)}`;
  const sizes = exitSizesOf(sizing);
  const packet = {
    schema_version: PACKET_FORMAT,
    captured_at: at,
    project: { project_id: pid, name: project.name, symbol: project.symbol || null, identity: { official_website: project.identity.official_website || null, coingecko_id: project.identity.coingecko_id || null, assets: (project.identity.assets || []).map((a) => ({ chain: a.chain, contract_address: a.contract_address })) } },
    researcher: { report_id: researcher.report_id, run_id: researcher.run_id, analysis_at: researcher.analysis_at, verdict: researcher.verdict, grade: researcher.grade, rubric_version: researcher.rubric_version, sector_profile: researcher.sector_profile, original_sha256: researcher.original.sha256 },
    market: marketOf(ws, project),
    exits: exitsOf(ws, pid, sizes, now),
    exits_missing: [],
    ...(args.exit_quote ? { exit_quote_attempt: args.exit_quote } : {}),
    sell_tax: taxOf(ws, project, now),
    fundamentals: fundamentalsOf(ws, project, now),
    held,
    sizing,
    native: null,
    notes: [
      'exits: the desk\'s own exit-quote readings (aggregator quotes or constant-product reserves) as the Forensics tab reads them, at each size the cheapest current reading whose cost is known in full, else the cheapest; a cost not known in full is a lower bound.',
      'held: whether Eric records an open position in this token (Portfolio); never its size.',
    ],
  };
  // Whether the identity says this is the chain's own coin (never inferred
  // from a missing contract), with the stored market cap the exemption reads.
  packet.native = { native_chain: project.identity.native_chain === true, market_cap_usd: isNum(packet.market.market_cap_usd) ? packet.market.market_cap_usd : null };
  packet.exits_missing = exitsMissing(packet.exits, pid);
  // The contract attestation (v2): frozen beside the receipt for a desk gate,
  // beside the ticket otherwise. Observe mode: recorded, read by nothing.
  const att = contractAttestation(ws, project, packet, sizing, now, `${ticketDir(pid, tid)}/contract`);
  // Enforce mode (sizing@5), for a token Eric does not hold: a block closes
  // the desk's gate with no Prosecutor; a hold opens nothing and writes no
  // receipt until the contract is observed again. A held token's ticket opens
  // (a trim is never blocked) and the gate sizes it.
  const tier = att ? att.contract.verdict.tier : null;
  const contractPregate = sizing.version === SIZING_V5 && !pregate && args.force_prosecution !== true && !args.restart && held === false && (tier === 'block' || tier === 'hold') ? tier : null;
  if (contractPregate === 'hold') {
    const holds = att.contract.verdict.findings.filter((f) => f.tier === 'hold');
    return { status: 'needs_contract_evidence', project_id: pid, report_id: researcher.report_id, tier, findings: holds, message: `No ticket was opened for ${project.name} and no receipt written: the contract gate holds (${att.contract.words}). It opens once the desk observes the contract with nothing holding it (contracts observe).` };
  }
  const gated = pregate || contractPregate === 'block';
  const gateRid = gated ? `tr_${compactTs(new Date(now))}_${randomId(5)}` : null;
  if (att && gated) {
    const base = receiptRel(pid, gateRid, 'contract');
    const move = (p) => `${base}/${p.split('/').pop()}`;
    for (const s of att.contract.subjects) s.observation.path = move(s.observation.path);
    for (const f of att.frozen) f.path = move(f.path);
  }
  if (att) {
    packet.schema_version = require('./contract-gate').PACKET_V2;
    packet.contract = att.contract;
    packet.value_capture = att.value_capture;
    packet.notes.push('contract: the latest contract observation of each chain (frozen beside this packet) and the contract gate\'s verdict, in its mode; value_capture: holder yield against dilution, never a share of revenue.');
  }
  const packetText = jsonText(packet);
  const packetSha = sha256(packetText);
  if (gated) return closeGate(ws, { pid, project, researcher, packet, packetText, packetSha, sizing, now, rid: gateRid, frozen: att ? att.frozen : [], reasonKind: pregate ? null : 'contract_block' });
  const dir = ticketDir(pid, tid);
  const ticket = {
    schema_version: 'cr.ticket-job.v1',
    ticket_id: tid,
    project_id: pid,
    created_at: at,
    created_by: ws.actor || null,
    channel: args.channel || ws.actor || 'cli',
    utterance: typeof args.utterance === 'string' ? args.utterance.slice(0, 2000) : null,
    versions: { prompt: PROMPT_VERSION, format: FORMAT, sizing: sizing.version, invalidation: sizing.version === SIZING_V5 ? INVALIDATION_V3 : INVALIDATION_VERSION },
    basis: { researcher, held: packet.held, exits: packet.exits, market: packet.market, native: packet.native, ...(packet.contract ? { contract: packet.contract, value_capture: packet.value_capture } : {}) },
    sizing,
    packet: { path: `${dir}/packet.json`, sha256: packetSha, captured_at: at },
    prompt: null,
    paid_requests: 'none: the Prosecutor is Claude through its connection or the local runner (Eric\'s subscription); the desk sends no model request.',
    job: { provider: 'claude', role: 'prosecutor', state: assistant ? 'running' : 'waiting', mode: assistant ? args.mode || 'cowork' : 'manual', receipt_id: null, receipts: [], updated_at: at, note: assistant ? 'Taken by Claude.' : 'Waiting for Claude: ask Claude (CryptoResearch connector) for the waiting ticket, or run npm run pilot.' },
  };
  const prompt = renderPrompt(ws, { ticket, project, packetText, packetSha, reportText });
  ticket.prompt = { version: PROMPT_VERSION, path: `${dir}/prompt.md`, sha256: sha256(prompt), chars: prompt.length };
  const out = runOp(ws, { type: 'ticket_create', summary: `PM ticket for ${pid}` }, (op) => {
    // Checked again under the lock: a ticket another caller opened meanwhile,
    // or a receipt saved on this report meanwhile, is answered, never doubled.
    const openNow = openTicket(ws, pid);
    if (openNow) return { meanwhile: 'open', ticket_id: openNow.ticket_id, created_at: openNow.created_at };
    if (!args.refresh && !args.restart) {
      const savedNow = listReceipts(ws, pid).filter((r) => !r.broken && r.researcher && r.researcher.report_id === researcher.report_id && !(args.force_prosecution === true && r.kind === 'desk_gate') && gateStands(r, idNow)).pop();
      if (savedNow) return { meanwhile: 'saved', receipt_id: savedNow.receipt_id, ticket_id: savedNow.ticket_id };
    }
    op.write(`${dir}/packet.json`, packetText, { mode: 'create' });
    for (const f of att ? att.frozen : []) op.write(f.path, f.text, { mode: 'create' });
    op.write(`${dir}/prompt.md`, prompt, { mode: 'create' });
    op.writeJson(`${dir}/ticket.json`, ticket, { mode: 'create' });
    return { ticket_id: tid };
  });
  const m = out.result && out.result.meanwhile;
  if (m === 'open') return { status: 'resumed', project_id: pid, ticket_id: out.result.ticket_id, ticket: loadTicket(ws, pid, out.result.ticket_id), message: `Resuming the open ticket ${out.result.ticket_id} for ${project.name} (opened ${out.result.created_at}); it was opened while this request waited, so no second ticket was opened.` };
  if (m === 'saved') return { status: 'exists', project_id: pid, receipt_id: out.result.receipt_id, ticket_id: out.result.ticket_id, message: `A ticket on Claude's current report (${researcher.report_id}) was saved while this request waited (${out.result.receipt_id}). Nothing new was opened.` };
  return { status: 'created', project_id: pid, ticket_id: tid, ticket, verified: out.verified, files: out.files, message: `Opened ticket ${tid} for ${project.name} on Claude's report ${researcher.report_id}.` };
}

// The pre-gate's receipt: the same frozen packet as a ticket would carry (kept
// beside the receipt, create-only) and the gate's own result with no
// proposal. No prompt is rendered and nothing goes to a model.
function closeGate(ws, { pid, project, researcher, packet, packetText, packetSha, sizing, now, rid: givenRid = null, frozen = [], reasonKind = null }) {
  const basis = { researcher, held: packet.held, exits: packet.exits, market: packet.market, native: packet.native, contract: packet.contract || null };
  const g = gate(basis, sizing);
  const at500 = packet.exits.find((x) => x.size_usd === sizing.exit_size_usd) || null;
  const at2000 = packet.exits.find((x) => x.size_usd === 2000) || null;
  const rid = givenRid || `tr_${compactTs(new Date(now))}_${randomId(5)}`;
  const savedAt = iso(now);
  const { original, ...researcherNoPath } = researcher;
  const contractGate = contractGateOf(packet);
  const receipt = {
    schema_version: 'cr.ticket-receipt.v1',
    kind: 'desk_gate',
    pregate_version: PREGATE_VERSION,
    receipt_id: rid,
    ticket_id: null,
    project_id: pid,
    saved_at: savedAt,
    as_of: savedAt,
    model: null,
    versions: { pregate: PREGATE_VERSION, sizing: sizing.version },
    prompt_sha256: null,
    packet: { path: receiptRel(pid, rid, 'packet.json'), sha256: packetSha, captured_at: packet.captured_at },
    text: null,
    block_sha256: null,
    revision_of: null,
    revision: null,
    researcher: { report_id: researcher.report_id, verdict: researcher.verdict, grade: researcher.grade, analysis_at: researcher.analysis_at, original_sha256: original ? original.sha256 : null },
    prosecution: null,
    proposal: null,
    desk: {
      sizing,
      gate: (() => {
        const reason_kind = reasonKind || gradeReasonKind(researcher.grade);
        const withheld = reason_kind === 'grade_withheld' ? withheldOf(ws, pid, researcher) : null;
        return { ...g, reason_kind, ...(withheld ? { withheld } : {}) };
      })(),
      proposal_type: g.proposal_type,
      model_proposal_type: null,
      suggested_risk_usd: g.suggested_risk_usd,
      exit_basis: g.exit_basis,
      exit_cost_500_usd_pct: at500 ? at500.cost_pct : null,
      exit_cost_500_complete: at500 ? at500.cost_complete : null,
      exit_cost_500_as_of: at500 ? at500.as_of : null,
      exit_cost_2000_usd_pct: at2000 ? at2000.cost_pct : null,
      exit_cost_2000_complete: at2000 ? at2000.cost_complete : null,
      exits_missing: packet.exits_missing,
      sell_tax: packet.sell_tax || null,
      ...(contractGate ? { contract_gate: contractGate } : {}),
    },
    agent_disagreement: null,
    sources: [],
    validation: { errors: [] },
  };
  const out = runOp(ws, { type: 'ticket_desk_gate', summary: `Desk gate for ${pid}` }, (op) => {
    const idNow = contractGate ? { identity_key: contractGate.identity_key } : null;
    const again = listReceipts(ws, pid).find((r) => !r.broken && r.kind === 'desk_gate' && r.researcher && r.researcher.report_id === researcher.report_id && gateStands(r, idNow));
    if (again) return { replay: again };
    op.write(receipt.packet.path, packetText, { mode: 'create' });
    for (const f of frozen) op.write(f.path, f.text, { mode: 'create' });
    op.writeJson(receiptRel(pid, rid), receipt, { mode: 'create' });
    return { receipt_id: rid };
  });
  if (out.result && out.result.replay) return { status: 'unchanged', gate_closed: true, project_id: pid, receipt_id: out.result.replay.receipt_id, receipt: out.result.replay, verified: true, message: `The desk's gate on this report is already saved as ${out.result.replay.receipt_id}.` };
  return {
    status: 'gate_closed',
    gate_closed: true,
    project_id: pid,
    receipt_id: rid,
    receipt,
    verified: out.verified,
    files: out.files,
    message: reasonKind === 'contract_block'
      ? `The desk's contract gate is closed for ${project.name}: ${g.proposal_type}, no risk. ${g.reasons[0] || ''} No Prosecutor ran; the receipt ${rid} waits for Eric's review. A change of the contract's identity opens a ticket on the same report.`
      : `The desk's gate is closed for ${project.name}: ${g.proposal_type}, no risk. ${g.reasons[0] || ''} No Prosecutor ran; the receipt ${rid} waits for Eric's review (pass force_prosecution: true to open one anyway).`,
  };
}

// ---------------------------------------------------------------------------
// The contract attestation (cr-contract-attestation@1, Pillar 1 PR B): the
// latest contract observation of each chain, frozen beside the packet, and
// the contract gate's verdict over it with the value-capture tests. In mode
// observe (the default) it is recorded and changes nothing: no gate, size,
// receipt kind or decision reads it.

function contractGateMode(ws) {
  const m = ws.settings && ws.settings.tickets && ws.settings.tickets.contract_gate && ws.settings.tickets.contract_gate.mode;
  return require('./contract-gate').MODES.includes(m) ? m : 'observe';
}

// The project's latest observations as the packet's `contract` block, with
// the exact stored files to freeze under `base`. Null for a project with no
// contract the desk reads (a native coin, an unsupported chain family).
function contractAttestation(ws, project, packet, sizing, now, base) {
  const CF = require('./contract-forensics');
  const G = require('./contract-gate');
  const subjects = CF.subjectsOf(project);
  if (!subjects.length) return null;
  const pid = project.project_id;
  const status = CF.readStatus(ws, pid);
  const cfg = (ws.settings && ws.settings.contracts) || {};
  const frozen = [];
  const rows = [];
  const notObserved = [];
  const forVerdict = [];
  subjects.forEach((s, i) => {
    const role = i === 0 ? 'exit_chain' : 'other_chain';
    const cur = status.subjects[`${s.chain_id}:${s.address}`];
    const r = cur && cur.current ? CF.readObservation(ws, pid, cur.current) : null;
    if (!r || !r.ok) {
      const support = require('./contract-rpc').networkSupport(ws, s.chain_id);
      const reason = r && !r.ok ? 'unreadable' : !support.supported ? support.reason : status.last_attempt && status.last_attempt.outcome === 'reorged' ? 'reorged' : 'not_observed';
      notObserved.push({ chain_id: s.chain_id, address: s.address, role, reason });
      forVerdict.push({ role, chain_id: s.chain_id, address: s.address, observation: null, reason });
      return;
    }
    const o = r.observation;
    const text = readText(ws, CF.obsPath(pid, o.observation_id));
    const path = `${base}/${o.observation_id}.json`;
    frozen.push({ path, text });
    const auth = (o.authorities || []).map((a) => ({ capability: a.capability, class: a.class, proof: a.proof, words: a.words }));
    const tp = o.transfer_probe || null;
    rows.push({
      chain_id: s.chain_id,
      address: s.address,
      role,
      observation: { observation_id: o.observation_id, path, sha256: sha256(text), block: o.block.hash ? { number: o.block.number, hash: o.block.hash, timestamp: o.block.timestamp } : { slot: o.block.slot }, age_minutes_at_capture: Math.round((now - Date.parse(o.block.timestamp || o.retrieved.finished_at)) / 60000) },
      identity_key: o.identity_key,
      summary: {
        proxy_kind: o.proxy ? o.proxy.kind : null,
        token_code_hash: o.token ? o.token.code_hash || null : null,
        implementation_code_hash: o.proxy && o.proxy.implementation ? o.proxy.implementation.code_hash : null,
        controllers: auth,
        sell_probe: tp ? { status: tp.status, tax_bps: tp.sell_path ? tp.sell_path.tax_bps : null } : null,
        source: o.source ? o.source.status : null,
        coverage: { complete: Boolean(o.coverage && o.coverage.complete), missing: (o.coverage && o.coverage.missing) || [] },
      },
    });
    forVerdict.push({ role, chain_id: s.chain_id, address: s.address, observation: o, transitions: (cur.transitions || []).slice(-5) });
  });
  const exitObs = forVerdict.find((v) => v.role === 'exit_chain' && v.observation);
  const feeCeil = exitObs && cfg.network_fee_ceiling_usd && typeof cfg.network_fee_ceiling_usd === 'object' ? cfg.network_fee_ceiling_usd[exitObs.chain_id] : null;
  const price = packet.market && isNum(packet.market.price_usd) ? packet.market.price_usd : null;
  const ladder = exitObs && price !== null ? G.exitLadder(exitObs.observation, { sizes: sizing.exit_sizes_usd.includes(sizing.exit_size_usd) ? sizing.exit_sizes_usd : [...sizing.exit_sizes_usd, sizing.exit_size_usd].sort((a, b) => a - b), priceUsd: String(price), networkFeeUsd: feeCeil === undefined || feeCeil === null ? null : String(feeCeil), limitPct: sizing.max_exit_cost_pct }) : null;
  const vc = G.valueCapture(valueInputs(ws, project, packet, exitObs ? exitObs.observation : null, status, pid));
  let vendor = null;
  try {
    const sc = require('./screening').summary(ws, project, now);
    vendor = { severe: (sc && sc.contracts ? sc.contracts : []).flatMap((c) => (Array.isArray(c.severe) ? c.severe : []).map((x) => (typeof x === 'string' ? x : x && (x.words || x.label || x.key)) || 'severe flag')) };
  } catch (_) { vendor = null; }
  const params = { ttl_hours: Number(cfg.ttl_hours) > 0 ? Number(cfg.ttl_hours) : 24, min_timelock_hours: Number(cfg.min_timelock_hours) > 0 ? Number(cfg.min_timelock_hours) : 48, recent_change_days: 30, exit_cost_limit_pct: sizing.max_exit_cost_pct, exit_size_usd: sizing.exit_size_usd };
  const v = G.verdict({ subjects: forVerdict, vendor, exits: ladder, valueCapture: vc, params, now });
  const contract = {
    attestation_version: G.ATTESTATION_VERSION,
    rules: { version: G.GATE_VERSION, mode: contractGateMode(ws), params },
    subjects: rows,
    not_observed: notObserved,
    identity_key: identityKeyOf(rows),
    exits: ladder ? { version: ladder.version, tax_bps: ladder.tax_bps, best: ladder.best.map((b) => ({ size_usd: b.size_usd, ...(b.best ? { pool: b.best.pool, cost_pct: b.best.cost_pct, cost_pct_3: b.best.cost_pct_3, cost_complete: b.best.cost_complete, missing_costs: b.best.missing_costs } : { cost_pct: null }) })), excluded: ladder.excluded, projection: G.EXIT_LEGACY_VERSION, legacy: ladder.best.map((b) => G.legacyExit(b.best, exitObs.observation.block.timestamp)), note: 'The desk\'s own on-chain readings; under sizing@4 they are not in `exits`.' } : null,
    verdict: { tier: v.tier, findings: v.findings, findings_sha256: v.findings_sha256 },
    words: v.words,
  };
  return { contract, value_capture: vc, frozen };
}

// Value-capture inputs from the packet's own stored figures and the on-chain
// supply (no extra request): DefiLlama only when its 30-day total is complete.
function valueInputs(ws, project, packet, obs, status, pid) {
  const m = packet.fundamentals && packet.fundamentals.metrics ? packet.fundamentals.metrics : {};
  const total = (k) => (m[k] && m[k].status === 'complete' && isNum(m[k].total_30d_usd) ? m[k].total_30d_usd : null);
  let growth = null;
  try {
    const CF = require('./contract-forensics');
    const sub = obs ? status.subjects[`${obs.subject.chain_id}:${obs.subject.address}`] : null;
    const first = sub && sub.history && sub.history.length > 1 ? CF.readObservation(ws, pid, sub.history[0].observation_id) : null;
    if (first && first.ok && first.observation.token.total_supply && obs.token.total_supply) {
      const days = (Date.parse(obs.block.timestamp) - Date.parse(first.observation.block.timestamp)) / 86400000;
      const a = Number(first.observation.token.total_supply);
      const b = Number(obs.token.total_supply);
      if (days >= 7 && a > 0) growth = ((b - a) / a) * (365 / days);
    }
  } catch (_) { growth = null; }
  const tp = obs && obs.transfer_probe && obs.transfer_probe.status === 'ok' ? obs.transfer_probe.sell_path.tax_bps / 100 : null;
  return {
    holders_revenue_30d_usd: total('holders_revenue'),
    revenue_30d_usd: total('revenue'),
    market_cap_usd: packet.market && isNum(packet.market.market_cap_usd) ? packet.market.market_cap_usd : null,
    onchain_supply_growth_annual: growth,
    circulating_supply_growth_annual: null,
    buy_tax_pct: null,
    sell_tax_pct: tp,
    volume_30d_usd: null,
  };
}

// The receipt's record of the gate: what it said, in which mode.
function contractGateOf(packet) {
  if (!packet || !packet.contract) return null;
  const c = packet.contract;
  return { version: c.rules.version, mode: c.rules.mode, tier: c.verdict.tier, identity_key: c.identity_key, findings: c.verdict.findings, findings_sha256: c.verdict.findings_sha256, words: c.words, economics: packet.value_capture ? packet.value_capture.words : null, value_capture_classes: packet.value_capture ? packet.value_capture.classes : [] };
}

// A v2 packet's contract block holds: each frozen observation matches its
// SHA-256 and its own canonical hash, and the findings match their hash and
// the receipt's. Null when it holds; a refusal in words otherwise.
function contractIntegrity(ws, receipt) {
  const G = require('./contract-gate');
  try {
    const packet = JSON.parse(verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
    if (packet.schema_version !== G.PACKET_V2 || !packet.contract) throw new OpError('INTEGRITY', 'The receipt records a contract gate but its packet is not cr.ticket-packet.v2.');
    const c = packet.contract;
    for (const s of c.subjects || []) {
      const o = JSON.parse(verifiedFrozen(ws, s.observation.path, s.observation.sha256, `The frozen observation ${s.observation.observation_id}`));
      const { sha256: own, ...rest } = o;
      if (o.observation_id !== s.observation.observation_id || own !== sha256(G.canonicalJson(rest)) || o.identity_key !== s.identity_key) throw new OpError('INTEGRITY', `The frozen observation ${s.observation.observation_id} does not match its own record.`);
    }
    if (G.hashOf(c.verdict.findings) !== c.verdict.findings_sha256 || c.verdict.findings_sha256 !== receipt.desk.contract_gate.findings_sha256) throw new OpError('INTEGRITY', 'The contract findings do not match their hash or the receipt.');
    return null;
  } catch (err) {
    return { status: 'unverified', words: `Cannot be checked: ${String(err && err.message || err).slice(0, 200)} It cannot be approved or halved; a veto, pass or watch is still allowed.` };
  }
}

// ---------------------------------------------------------------------------
// The contract gate in force (mode enforce, Pillar 1 PR C). Every check reads
// stored observations only; none asks a chain.

const CONTRACT_ADMISSION_VERSION = 'cr-contract-admission@1';
const identityKeyOf = (rows) => `sha256:${require('./contract-gate').hashOf(rows.map((r) => [r.chain_id, r.address, r.identity_key]))}`;
function contractTtlHours(ws) {
  const v = Number(ws.settings && ws.settings.contracts && ws.settings.contracts.ttl_hours);
  return v > 0 ? v : 24;
}

// The project's contract as the desk last observed it: the identity
// fingerprint over every observed chain (the attestation's own rule), the exit
// chain's observation and its age. Null for a project with no contract the
// desk reads.
function contractIdentityNow(ws, project, now = Date.now()) {
  const CF = require('./contract-forensics');
  const subjects = CF.subjectsOf(project);
  if (!subjects.length) return null;
  const status = CF.readStatus(ws, project.project_id);
  const rows = [];
  let exit = null;
  subjects.forEach((s, i) => {
    const cur = status.subjects[`${s.chain_id}:${s.address}`];
    const r = cur && cur.current ? CF.readObservation(ws, project.project_id, cur.current) : null;
    if (!r || !r.ok) return;
    rows.push({ chain_id: s.chain_id, address: s.address, identity_key: r.observation.identity_key });
    if (i === 0) exit = r.observation;
  });
  const at = exit ? Date.parse((exit.block && exit.block.timestamp) || (exit.retrieved && exit.retrieved.finished_at)) : NaN;
  return { identity_key: identityKeyOf(rows), exit_observation: exit, exit_age_hours: Number.isFinite(at) ? (now - at) / HOUR : null, ttl_hours: contractTtlHours(ws) };
}

// Why the exit chain's latest observation does not give current evidence, or
// null when it does.
function contractStaleWords(idNow) {
  if (!idNow || !idNow.exit_observation) return 'The exit chain\'s contract has no observation on record.';
  if (idNow.exit_age_hours === null || idNow.exit_age_hours > idNow.ttl_hours) return `The exit chain's latest contract observation is ${idNow.exit_age_hours === null ? 'of unknown age' : `${Math.round(idNow.exit_age_hours)} hours old`}, past ${idNow.ttl_hours} hours.`;
  return null;
}

const contractBlockGate = (r) => Boolean(r && r.kind === 'desk_gate' && r.desk && r.desk.gate && r.desk.gate.reason_kind === 'contract_block');
// A contract block's gate stands only for the identity it read; every other
// receipt stands as it is.
function gateStands(r, idNow) {
  if (!contractBlockGate(r)) return true;
  return Boolean(idNow && r.desk.contract_gate && r.desk.contract_gate.identity_key === idNow.identity_key);
}

// The verdict the desk would freeze now, for the queue's next step. Reads only.
function contractVerdictNow(ws, project, sizing, now) {
  const packet = { market: marketOf(ws, project), fundamentals: fundamentalsOf(ws, project, now) };
  const att = contractAttestation(ws, project, packet, sizing, now, 'preview');
  return att ? { tier: att.contract.verdict.tier, words: att.contract.words, findings: att.contract.verdict.findings, identity_key: att.contract.identity_key } : null;
}

// At the save (sizing@5): the contract is still the one the packet froze and
// its evidence is current. Otherwise the ticket is saved with no risk, said as
// a cap, as the price admission does.
function contractAdmissionOf(ws, project, packet, now) {
  const idNow = contractIdentityNow(ws, project, now);
  const base = { version: CONTRACT_ADMISSION_VERSION, checked_at: iso(now), identity_key_frozen: packet.contract.identity_key, identity_key_now: idNow ? idNow.identity_key : null };
  if (!idNow || idNow.identity_key !== packet.contract.identity_key) return { ...base, status: 'changed', words: 'The contract\'s identity fingerprint changed after the ticket was opened (an implementation, admin or controller moved).' };
  const stale = contractStaleWords(idNow);
  if (stale) return { ...base, status: 'expired', words: stale };
  return { ...base, status: 'same', words: null };
}

function contractAdmitted(g, ca) {
  if (!ca || ca.status === 'same' || !(g.suggested_risk_usd > 0)) return g;
  const why = `${ca.words} No risk is suggested until the contract is attested again (${CONTRACT_ADMISSION_VERSION}).`;
  return { ...g, risk_allowed: false, allowed_types: g.allowed_types.filter((x) => !RISK_TAKING.has(x)), proposal_type: 'WATCH_ONLY', capped: { from: g.proposal_type, reason: why }, suggested_risk_usd: 0, reasons: [why], contract_hold: true };
}

// What a grant needs under enforce: an attestation that let risk through,
// the same contract now, and current evidence. Null when it holds, or when the
// gate is observed only or the project has no contract the desk reads.
function contractGrantBlock(ws, project, receipt, now) {
  if (contractGateMode(ws) !== 'enforce') return null;
  if (!require('./contract-forensics').subjectsOf(project).length) return null;
  const cg = receipt.desk && receipt.desk.contract_gate;
  const refuse = (code, words) => ({ code, message: `Not recorded: ${words} Nothing was granted.`, changed: [{ kind: 'contract', words }] });
  if (!cg) return refuse('CONTRACT_UNATTESTED', 'This ticket carries no contract attestation (its packet is not cr.ticket-packet.v2), and the contract gate is enforced. Re-open it for a ticket on a fresh packet.');
  if (cg.tier === 'block' || cg.tier === 'hold') return refuse('CONTRACT_UNATTESTED', `Its contract gate read ${cg.tier} when it was saved (mode ${cg.mode}): ${cg.words}`);
  const idNow = contractIdentityNow(ws, project, now);
  if (!idNow || idNow.identity_key !== cg.identity_key) return refuse('CONTRACT_CHANGED', 'The contract\'s identity fingerprint changed since this ticket was saved (an implementation, admin or controller moved).');
  const stale = contractStaleWords(idNow);
  if (stale) return refuse('CONTRACT_EVIDENCE_EXPIRED', `${stale} Observe the contract again (contracts observe).`);
  return null;
}

// invalidation@3's contract check: the fingerprint changed after the save, or
// the measured sell tax rose by TAX_SPIKE_BPS or more over the one frozen.
function contractCheckOf(ws, project, receipt, now) {
  const cg = receipt.desk && receipt.desk.contract_gate;
  if (!cg) return null;
  const idNow = contractIdentityNow(ws, project, now);
  if (!idNow) return { kind: 'contract', status: 'unknown', words: 'The contract is not read now.' };
  if (idNow.identity_key !== cg.identity_key) return { kind: 'contract', status: 'triggered', identity_key_frozen: cg.identity_key, identity_key_now: idNow.identity_key, words: 'The contract\'s identity fingerprint changed after the ticket was saved (an implementation, admin or controller moved).' };
  let frozenTax = null;
  try {
    const packet = JSON.parse(verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
    const s = packet.contract && packet.contract.subjects ? packet.contract.subjects.find((x) => x.role === 'exit_chain') : null;
    frozenTax = s && s.summary && s.summary.sell_probe && s.summary.sell_probe.status === 'ok' ? s.summary.sell_probe.tax_bps : null;
  } catch (_) { frozenTax = null; }
  const tp = idNow.exit_observation && idNow.exit_observation.transfer_probe;
  const nowTax = tp && tp.status === 'ok' && tp.sell_path ? tp.sell_path.tax_bps : null;
  if (Number.isInteger(frozenTax) && Number.isInteger(nowTax) && nowTax - frozenTax >= TAX_SPIKE_BPS) return { kind: 'contract', status: 'triggered', tax_bps_frozen: frozenTax, tax_bps_now: nowTax, words: `The measured sell tax rose from ${frozenTax / 100}% to ${nowTax / 100}% after the ticket was saved.` };
  return { kind: 'contract', status: 'holding', words: 'The contract\'s identity is unchanged since the ticket was saved.' };
}

// Before the trader's book is asked to open (enforce only): the same
// contract, current evidence, and the exit at the fitted notional (CG-14).
// `final` when no later step can open it. Null when nothing holds the order.
// Only an opening is checked: a close, a trim or a settlement never is.
function contractOpenGuard(ws, project, receipt, { now = Date.now(), notionalUsd, priceUsd } = {}) {
  if (contractGateMode(ws) !== 'enforce') return null;
  const cg = receipt && receipt.desk && receipt.desk.contract_gate;
  if (!cg) return require('./contract-forensics').subjectsOf(project).length ? { hold: true, final: true, rule_id: 'CONTRACT_UNATTESTED', words: 'The ticket carries no contract attestation and the contract gate is enforced: no order is made from it.' } : null;
  const idNow = contractIdentityNow(ws, project, now);
  if (!idNow || idNow.identity_key !== cg.identity_key) return { hold: true, final: true, rule_id: 'CONTRACT_CHANGED', words: 'The contract\'s identity fingerprint changed since the ticket was saved: no order is made from it.' };
  const stale = contractStaleWords(idNow);
  if (stale) return { hold: true, final: false, rule_id: 'CG-20', words: `${stale} The order waits for a current observation.` };
  const fee = ws.settings && ws.settings.contracts && ws.settings.contracts.network_fee_ceiling_usd;
  const feeCeil = fee && typeof fee === 'object' ? fee[idNow.exit_observation.subject.chain_id] : null;
  const limit = receipt.desk.sizing && receipt.desk.sizing.max_exit_cost_pct;
  const fx = require('./contract-gate').fittedExit(idNow.exit_observation, { notionalUsd, priceUsd, networkFeeUsd: feeCeil === undefined || feeCeil === null ? null : String(feeCeil), limitPct: limit });
  if (!fx.ok) return { hold: true, final: false, rule_id: 'CG-14', fitted: fx, words: `${fx.words} The order waits until the fitted size is within the proven exit.` };
  return null;
}

function cancelTicket(ws, pid, tid, reason = null) {
  return updateTicket(ws, pid, tid, (t) => {
    if (!OPEN.has(t.job.state)) return { noop: true };
    Object.assign(t.job, { state: 'canceled', canceled_at: iso(Date.now()), cancel_reason: reason ? String(reason).slice(0, 300) : null });
    return {};
  }, `Cancel ticket ${tid}`);
}

function saveDraft(ws, pid, tid, { text, note = null }) {
  const body = typeof text === 'string' ? text : '';
  if (!body.trim()) throw new OpError('INVALID', 'The draft is empty.');
  if (Buffer.byteLength(body) > MAX_DRAFT) throw new OpError('INVALID', `The draft is larger than ${MAX_DRAFT / 1024} KB.`);
  const out = updateTicket(ws, pid, tid, (t, op) => {
    const at = iso(Date.now());
    if (t.job.state === 'waiting') Object.assign(t.job, { state: 'running', mode: 'cowork', note: 'Taken by Claude with its first draft.' });
    if (t.job.state !== 'running') throw new OpError('CONFLICT', `Ticket ${tid} is ${t.job.state}; a draft is kept only for open work.`);
    op.write(draftRel(pid, tid), body);
    // A new draft is a new attempt: the last refusal no longer stands.
    Object.assign(t.job, { draft_saved_at: at, draft_chars: body.length, progress_note: note ? String(note).slice(0, 300) : null, last_refusal: null, updated_at: at });
    return { at, chars: body.length };
  }, `Prosecutor draft for ${tid}`, 'ticket_draft');
  return { status: 'saved', ...out.result, verified: out.verified };
}

// ---------------------------------------------------------------------------
// Saving the Prosecutor's ticket

function normalizeBlock(b) {
  const errors = [];
  const p = b.prosecution && typeof b.prosecution === 'object' ? b.prosecution : {};
  const q = b.proposal && typeof b.proposal === 'object' ? b.proposal : {};
  const num = (v, what) => {
    if (v === null || v === undefined || v === '') return null;
    if (isNum(v) && v > 0) return v;
    errors.push(`${what} is not a positive number; kept as unknown.`);
    return null;
  };
  const verdict = VERDICTS.includes(p.verdict) ? p.verdict : null;
  if (!verdict) errors.push(`prosecution.verdict must be one of ${VERDICTS.join(', ')}.`);
  let score = null;
  if (isNum(p.conviction_score) && p.conviction_score >= 0 && p.conviction_score <= 100) score = Math.round(p.conviction_score);
  else if (p.conviction_score !== null && p.conviction_score !== undefined) errors.push('prosecution.conviction_score is not a number from 0 to 100; kept as unknown.');
  const tests = Object.fromEntries(TESTS.map((t) => {
    const x = p.tests && p.tests[t] && typeof p.tests[t] === 'object' ? p.tests[t] : {};
    const result = ['pass', 'fail', 'unknown'].includes(x.result) ? x.result : 'unknown';
    return [t, { result, finding: str(x.finding, 1200), source_ids: Array.isArray(x.source_ids) ? x.source_ids.map(String).slice(0, 20) : [] }];
  }));
  (Array.isArray(p.fatal_flaws) ? p.fatal_flaws : []).slice(0, 20).forEach((f, i) => {
    if (!['fatal', 'serious', 'minor'].includes(f && f.severity)) errors.push(`prosecution.fatal_flaws[${i}].severity is not fatal, serious or minor; read as serious, and the ticket is not granted automatically.`);
  });
  const flaws = (Array.isArray(p.fatal_flaws) ? p.fatal_flaws : []).slice(0, 20).map((f) => ({ test: [...TESTS, 'other'].includes(f && f.test) ? f.test : 'other', severity: ['fatal', 'serious', 'minor'].includes(f && f.severity) ? f.severity : 'serious', finding: str(f && f.finding, 1200), source_ids: Array.isArray(f && f.source_ids) ? f.source_ids.map(String).slice(0, 20) : [] })).filter((f) => f.finding);
  const type = PROPOSALS.includes(q.proposal_type) ? q.proposal_type : null;
  if (!type) errors.push(`proposal.proposal_type must be one of ${PROPOSALS.join(', ')}.`);
  let thesis = str(q.non_consensus_thesis, 600);
  if (!thesis) errors.push('proposal.non_consensus_thesis is empty.');
  const sentences = thesis.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
  if (sentences.length > 1) {
    errors.push('proposal.non_consensus_thesis is more than one sentence; the first is kept.');
    thesis = sentences[0];
  }
  const ez = q.entry_zone && typeof q.entry_zone === 'object' ? q.entry_zone : {};
  let low = num(ez.low_usd, 'entry_zone.low_usd');
  let high = num(ez.high_usd, 'entry_zone.high_usd');
  if (low !== null && high !== null && low > high) [low, high] = [high, low];
  const up = q.upside_target && typeof q.upside_target === 'object' ? q.upside_target : {};
  const inv = q.invalidation_trigger && typeof q.invalidation_trigger === 'object' ? q.invalidation_trigger : {};
  const m = inv.metric && typeof inv.metric === 'object' ? inv.metric : null;
  const metric = m && METRIC_KEYS.includes(m.key) && isNum(m.below_30d_usd) && m.below_30d_usd > 0 ? { key: m.key, below_30d_usd: m.below_30d_usd } : null;
  if (m && !metric && (m.below_30d_usd !== null && m.below_30d_usd !== undefined)) errors.push(`invalidation_trigger.metric needs a key (${METRIC_KEYS.join(', ')}) and a positive below_30d_usd; not used.`);
  const invalidation = { price_usd: num(inv.price_usd, 'invalidation_trigger.price_usd'), metric, statement: str(inv.statement, 800) };
  if (RISK_TAKING.has(type) && invalidation.price_usd === null) errors.push('A risk-taking proposal without an invalidation price: the desk cannot watch it by price.');
  return {
    errors,
    content: {
      model_version: str(b.model_version, 120) || null,
      as_of: str(b.as_of, 40) || null,
      prosecution: { verdict, conviction_score: score, tests, fatal_flaws: flaws, strongest_bull_rebuttal: str(p.strongest_bull_rebuttal, 1200) },
      proposal: {
        proposal_type: type,
        non_consensus_thesis: thesis,
        entry_zone: low === null && high === null ? null : { low_usd: low, high_usd: high, basis: str(ez.basis, 600) },
        upside_target: num(up.price_usd, 'upside_target.price_usd') === null ? null : { price_usd: up.price_usd, basis: str(up.basis, 600) },
        invalidation_trigger: invalidation,
      },
      agent_disagreement_note: str(b.agent_disagreement_note, 2000),
      sources: (Array.isArray(b.sources) ? b.sources : []).slice(0, 80).map((s) => ({ source_id: str(s && s.source_id, 20), url: str(s && s.url, 600), publisher: str(s && s.publisher, 200), retrieved_at: str(s && s.retrieved_at, 40), excerpt: str(s && s.excerpt, 600) })).filter((s) => s.url),
    },
  };
}

const normalizedTextHash = (text) => sha256(String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim());

// The basis the desk sizes from is the verified frozen packet (review A08,
// 2026-10-25). The job record keeps a copy for reading; a copy that differs
// from the packet it pins is an INTEGRITY refusal, never sized: a changed job
// file must not create an exit reading, a holding or a grade the packet does
// not hold.
function frozenBasis(ticket, packet) {
  const canon = require('./requests').stableStringify;
  const b = ticket.basis || {};
  const r = b.researcher || {};
  const p = packet.researcher || {};
  const fields = [
    ['researcher.report_id', r.report_id, p.report_id],
    ['researcher.run_id', r.run_id, p.run_id],
    ['researcher.grade', r.grade, p.grade],
    ['researcher.original_sha256', r.original && r.original.sha256, p.original_sha256],
    ['held', b.held, packet.held],
    ['exits', b.exits, packet.exits],
    ['market', b.market, packet.market],
    ['native', b.native, packet.native],
    ['sizing', ticket.sizing, packet.sizing],
    ['contract', b.contract, packet.contract],
    ['value_capture', b.value_capture, packet.value_capture],
  ];
  const diffs = fields.filter(([, a, z]) => canon(a === undefined ? null : a) !== canon(z === undefined ? null : z)).map(([k]) => k);
  if (diffs.length) throw new OpError('INTEGRITY', `Not saved: the ticket's basis differs from its frozen packet (${diffs.join(', ')}). The desk sizes only from the verified packet; nothing was written. Keep the text: a new ticket (refresh) sizes it on a fresh packet.`, { fields: diffs });
  return { researcher: { ...r, grade: p.grade === undefined ? null : p.grade, run_id: p.run_id === undefined ? null : p.run_id }, held: packet.held, exits: packet.exits || [], market: packet.market || null, native: packet.native === undefined ? null : packet.native, contract: packet.contract || null };
}

// The horizon of the research run the report was made under, read from the
// run record, so the paper position knows when it ends. Null when the report
// names no run or the run states no end date.
function runHorizonOf(ws, pid, runId) {
  if (!runId) return null;
  try {
    const run = require('./research').loadRun(ws, pid, runId);
    const h = run && run.horizon;
    if (!h || !/^\d{4}-\d{2}-\d{2}$/.test(String(h.end_date || ''))) return null;
    return { run_id: runId, start_date: h.start_date || null, end_date: h.end_date, text: h.text || null, source: 'research_run' };
  } catch (_) {
    return null;
  }
}

// The admission check at commit (cr-ticket-admission@1, 2026-10-25, review
// A03), run inside the save's lock against the stored data as it stands then.
// A trigger already breached is refused (HARD_PASS and TRIM_EXIT are saved and
// labeled). A check that cannot be made (no usable invalidation price, no
// stored price, a price older than the freshness limit) is said as unchecked
// and holds a risk-taking ticket to $0: unknown is never a pass. A stored
// hourly price is not proof the market did not move after it.
const ADMISSION_VERSION = 'cr-ticket-admission@1';
const ADMISSION_LIMIT = 'A stored price is not proof the market did not move after it was read.';
const EXEMPT_FROM_BORN_CHECK = new Set(['HARD_PASS', 'TRIM_EXIT']);
function admissionOf(ws, project, packet, inv, now) {
  const staleMin = (ws.settings && ws.settings.freshness && ws.settings.freshness.price_stale_minutes) || 90;
  const out = { version: ADMISSION_VERSION, checked_at: iso(now), price_stale_minutes: staleMin, price: null, metric: null, breached: null, limit: ADMISSION_LIMIT };
  const trig = inv || {};
  if (!isNum(trig.price_usd)) {
    out.price = { status: 'unchecked', threshold_usd: null, reason: 'No usable invalidation price: the desk cannot watch this ticket by price.' };
  } else {
    let latest = null;
    try { latest = marketOf(ws, project); } catch (_) { latest = null; }
    const pk = packet.market || null;
    const cur = latest && isNum(latest.price_usd) ? { ...latest, source: 'latest' } : pk && isNum(pk.price_usd) ? { ...pk, source: 'packet' } : null;
    if (!cur) {
      out.price = { status: 'unchecked', threshold_usd: trig.price_usd, reason: `No stored price to check the invalidation price $${trig.price_usd} against${latest && latest.note ? ` (${latest.note.replace(/\.$/, '')})` : ''}.` };
    } else {
      const at = Date.parse(cur.as_of);
      const age = Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60000)) : null;
      const when = cur.as_of || 'an unknown time';
      const base = { threshold_usd: trig.price_usd, price_usd: cur.price_usd, as_of: cur.as_of || null, age_minutes: age, source: cur.source };
      if (trig.price_usd >= cur.price_usd) {
        out.price = { status: 'breached', ...base };
        out.breached = {
          kind: 'price',
          words: `The invalidation price $${trig.price_usd} was at or above the price when saved ($${cur.price_usd} at ${when}).`,
          refusal: `the invalidation price $${trig.price_usd} is at or above the price now ($${cur.price_usd} at ${when}): the ticket would be invalidated the moment it is saved. Set a threshold below the current price.`,
        };
      } else if (age === null || age > staleMin) {
        out.price = { status: 'unchecked', ...base, reason: `The stored price ($${cur.price_usd} at ${when}) is ${age === null ? 'of unknown age' : `${age} min old`}, past your ${staleMin}-minute freshness limit: it does not show the trigger $${trig.price_usd} still clear.` };
      } else {
        out.price = { status: 'clear', ...base, words: `The invalidation price $${trig.price_usd} is below the stored price $${cur.price_usd} (${when}, ${age} min old).` };
      }
    }
  }
  if (trig.metric) {
    const pick = (f, source) => {
      const m = f && f.metrics ? f.metrics[trig.metric.key] : null;
      return m && m.status === 'complete' && isNum(m.total_30d_usd) ? { total_30d_usd: m.total_30d_usd, fetched_at: f.fetched_at || null, source } : null;
    };
    const got = pick(fundamentalsOf(ws, project, now), 'latest') || pick(packet.fundamentals, 'packet');
    const base = { key: trig.metric.key, threshold_usd: trig.metric.below_30d_usd };
    if (!got) out.metric = { status: 'unchecked', ...base, reason: `No complete 30-day ${trig.metric.key} total on file: the floor is not checked.` };
    else if (trig.metric.below_30d_usd > got.total_30d_usd) {
      const when = got.fetched_at || 'an unknown date';
      out.metric = { status: 'breached', ...base, ...got };
      if (!out.breached) {
        out.breached = {
          kind: 'metric',
          words: `The ${trig.metric.key} floor $${trig.metric.below_30d_usd} was above the complete 30-day total on file ($${got.total_30d_usd}, ${when}).`,
          refusal: `the ${trig.metric.key} floor $${trig.metric.below_30d_usd} is above the complete 30-day total on file ($${got.total_30d_usd}, ${when}): the ticket would be invalidated the moment it is saved. Set a floor below the total.`,
        };
      }
    } else out.metric = { status: 'clear', ...base, ...got };
  }
  return out;
}

// The gate's result with the admission check applied: a risk-taking ticket
// whose price check is not clear suggests no risk, said as a cap.
function admitted(g, admission) {
  if (!(g.suggested_risk_usd > 0) || (admission.price && admission.price.status === 'clear')) return g;
  const why = `${(admission.price && admission.price.reason) || 'The invalidation price could not be checked.'} No risk is suggested until it can be checked (${ADMISSION_VERSION}).`;
  return { ...g, risk_allowed: false, allowed_types: g.allowed_types.filter((x) => !RISK_TAKING.has(x)), proposal_type: 'WATCH_ONLY', capped: { from: g.proposal_type, reason: why }, suggested_risk_usd: 0, reasons: [why], admission_hold: true };
}

// The field a refusal names, for the queue's ticket_failed step.
function refusedField(err) {
  const d = err.details || {};
  if (Array.isArray(d.fields) && d.fields.length) return String(d.fields[0]).split(':')[0];
  if (d.trigger) return 'proposal.invalidation_trigger';
  const m = String(err.message || '');
  if (/too short|larger than/.test(m)) return 'text';
  if (/JSON block was found/.test(m)) return 'json_block';
  if (/revision/.test(m)) return 'revision';
  if (/as_of/.test(m)) return 'as_of';
  const dotted = m.match(/\b(?:prosecution|proposal|entry_zone|upside_target|invalidation_trigger)(?:\.[a-z0-9_]+)*\b/);
  return dotted ? dotted[0] : null;
}

// A refused save on an open ticket is recorded on its job (an operational
// record: the field, the message, the text kept as the draft), so the queue
// says ticket_failed with the reason instead of repeating "ticket". INTEGRITY,
// a closed or missing ticket and a trigger already breached at the save (A03:
// refused with nothing written) write nothing; the refusal is thrown as is.
function saveTicket(ws, args) {
  try {
    return saveTicketOnce(ws, args);
  } catch (err) {
    if (['INVALID', 'CONFLICT'].includes(err.code) && !(err.details && err.details.trigger) && TICKET_RE.test(String(args.ticket_id)) && isProjectId(args.project_id)) {
      const body = typeof args.text === 'string' ? args.text : '';
      try {
        updateTicket(ws, args.project_id, args.ticket_id, (t, op) => {
          if (!OPEN.has(t.job.state)) return { noop: true };
          const at = iso(Date.now());
          if (body.trim() && Buffer.byteLength(body) <= MAX_DRAFT) {
            op.write(draftRel(args.project_id, args.ticket_id), body);
            Object.assign(t.job, { draft_saved_at: at, draft_chars: body.length });
          }
          Object.assign(t.job, { last_refusal: { at, code: err.code, field: refusedField(err), message: String(err.message).slice(0, 600) }, updated_at: at });
          return {};
        }, `Prosecutor save refused on ${args.ticket_id}`, 'ticket_refusal');
      } catch (_) { /* the refusal below is what the caller needs */ }
    }
    throw err;
  }
}

function saveTicketOnce(ws, { project_id: pid, ticket_id: tid, text, revision = null, channel = null }) {
  if (require('./research').heldProviders(ws).claude) throw new OpError('REFUSED', 'Claude is on hold on this desk; nothing was saved.');
  const body = typeof text === 'string' ? text : '';
  if (body.trim().length < MIN_TEXT) throw new OpError('INVALID', `That is too short to be the finished ticket (${body.trim().length} characters). Save the whole text with its JSON block.`);
  if (Buffer.byteLength(body) > MAX_TEXT) throw new OpError('INVALID', `The text is larger than ${MAX_TEXT / 1024} KB.`);
  const project = require('./projects').getProject(ws, pid);
  const ticket = loadTicket(ws, pid, tid);
  if (!ticket) throw new OpError('NOT_FOUND', `No ticket ${tid} for ${pid}.`);
  if (ticket.job.state === 'canceled') throw new OpError('CONFLICT', `Ticket ${tid} was canceled. Nothing was saved.`);
  const found = require('./forensics').findBlock(body, FORMAT);
  if (!found.obj) throw new OpError('INVALID', `No ${FORMAT} JSON block was found${found.errors && found.errors.length ? `: ${found.errors.join(' ')}` : ''}. End the text with the fenced JSON block the prompt asks for. Nothing was saved.`);
  const b = found.obj;
  const expect = { ticket_id: tid, project_id: pid, prompt_version: PROMPT_VERSION, role: 'prosecutor', model: 'claude', researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256 };
  const diffs = Object.entries(expect).filter(([k, v]) => b[k] !== v).map(([k, v]) => `${k}: the block says ${JSON.stringify(b[k] === undefined ? null : b[k])}, this ticket's is ${JSON.stringify(v)}`);
  if (diffs.length) throw new OpError('CONFLICT', `Not saved: the JSON block does not answer this ticket. ${diffs.join('; ')}.`, { fields: diffs });
  const norm = normalizeBlock(b);
  const c = norm.content;
  if (!c.prosecution.verdict || !c.proposal.proposal_type) throw new OpError('INVALID', `Not saved: ${norm.errors.filter((e) => /verdict|proposal_type/.test(e)).join(' ')}`);
  const textHash = normalizedTextHash(body);
  const prior = () => listReceipts(ws, pid).filter((r) => !r.broken && r.ticket_id === tid);
  const same = prior().find((r) => r.text && r.text.normalized_sha256 === textHash);
  if (same) return { status: 'unchanged', receipt_id: same.receipt_id, receipt: same, verified: true, message: `This exact ticket is already saved as ${same.receipt_id}.` };
  const last = prior().pop() || null;
  let rev = null;
  if (last) {
    const note = revision && typeof revision.note === 'string' ? revision.note.trim() : '';
    if (note.length < 15) throw new OpError('INVALID', `Not saved: ${last.receipt_id} is already saved for this ticket. A different text is a revision: pass revision { note } saying in a sentence what changed and why.`);
    rev = { of: last.receipt_id, note: note.slice(0, 600) };
  }
  let packet;
  try {
    verifiedFrozen(ws, ticket.prompt.path, ticket.prompt.sha256, 'The frozen Prosecutor prompt');
    packet = JSON.parse(verifiedFrozen(ws, ticket.packet.path, ticket.packet.sha256, 'The frozen ticket packet'));
  } catch (err) {
    if (err.code !== 'INTEGRITY') throw err;
    throw new OpError('INTEGRITY', `Not saved: ${err.message} Keep the text: it can be saved once the frozen files are restored.`, err.details);
  }
  const basis = frozenBasis(ticket, packet);
  const asOf = c.as_of ? Date.parse(c.as_of) : NaN;
  if (Number.isFinite(asOf) && asOf > Date.now() + AS_OF_AHEAD_MS) throw new OpError('INVALID', `Not saved: as_of (${c.as_of}) is after the time of saving by more than ${AS_OF_AHEAD_MS / 60000} minutes.`);
  if (Number.isFinite(asOf) && asOf < Date.parse(ticket.created_at) - AS_OF_SLACK_MS) throw new OpError('INVALID', `Not saved: as_of (${c.as_of}) is before the ticket was opened (${ticket.created_at}).`);
  const exits = basis.exits;
  const at500 = exits.find((x) => x.size_usd === ticket.sizing.exit_size_usd) || null;
  const at2000 = exits.find((x) => x.size_usd === 2000) || null;
  const rgrade = basis.researcher.grade;
  let receipt = null;
  let g = null;
  // Everything that decides the ticket's risk is read inside the lock, so a
  // price stored between a check and the write cannot slip past it (A03).
  const out = runOp(ws, { type: 'ticket_receipt', summary: `PM ticket for ${pid}` }, (op) => {
    const again = prior().find((r) => r.text && r.text.normalized_sha256 === textHash);
    if (again) return { replay: again };
    const t = op.readJson(ticketRel(pid, tid), null);
    if (!t || t.job.state === 'canceled') throw new OpError('CONFLICT', `Ticket ${tid} is no longer open.`);
    const now = Date.now();
    const g0 = gate(basis, ticket.sizing, c.proposal.proposal_type);
    const admission = admissionOf(ws, project, packet, c.proposal.invalidation_trigger, now);
    const breached = admission.breached;
    const exemptType = EXEMPT_FROM_BORN_CHECK.has(c.proposal.proposal_type) || EXEMPT_FROM_BORN_CHECK.has(g0.proposal_type);
    if (breached && !exemptType) throw new OpError('INVALID', `Not saved: ${breached.refusal} The draft is kept.`, { trigger: breached.kind });
    const g1 = admitted(g0, admission);
    // sizing@5: the contract the packet froze must still stand at the save.
    const contractAdmission = ticket.sizing.version === SIZING_V5 && packet.contract ? contractAdmissionOf(ws, project, packet, now) : null;
    g = contractAdmitted(g1, contractAdmission);
    const rid = `tr_${compactTs(new Date(now))}_${randomId(5)}`;
    const savedAt = iso(now);
    receipt = {
      schema_version: 'cr.ticket-receipt.v1',
      receipt_id: rid,
      ticket_id: tid,
      project_id: pid,
      saved_at: savedAt,
      as_of: Number.isFinite(asOf) ? iso(Math.min(asOf, now)) : savedAt,
      ...(Number.isFinite(asOf) && asOf > now ? { as_of_clamped: { written: c.as_of, recorded: savedAt } } : {}),
      model: { provider: 'claude', role: 'prosecutor', model_version: c.model_version, channel: channel || ws.actor || null, saved_by: ws.actor || null },
      versions: ticket.versions,
      prompt_sha256: ticket.prompt.sha256,
      packet: ticket.packet,
      text: { path: receiptRel(pid, rid, 'md'), sha256: sha256(body), normalized_sha256: textHash, chars: body.length },
      block_sha256: sha256(JSON.stringify(b)),
      revision_of: rev ? rev.of : null,
      revision: rev,
      // The run and its horizon travel with the receipt, so the paper book
      // knows when a position ends (A05).
      researcher: { report_id: basis.researcher.report_id, verdict: basis.researcher.verdict, grade: rgrade, analysis_at: basis.researcher.analysis_at, run_id: basis.researcher.run_id, horizon: runHorizonOf(ws, pid, basis.researcher.run_id) },
      prosecution: c.prosecution,
      proposal: c.proposal,
      // What the desk computed, beside what the model wrote.
      desk: {
        sizing: ticket.sizing,
        gate: g,
        proposal_type: g.proposal_type,
        model_proposal_type: c.proposal.proposal_type,
        suggested_risk_usd: g.suggested_risk_usd,
        exit_basis: g.exit_basis,
        exit_cost_500_usd_pct: at500 ? at500.cost_pct : null,
        exit_cost_500_complete: at500 ? at500.cost_complete : null,
        exit_cost_500_as_of: at500 ? at500.as_of : null,
        exit_cost_2000_usd_pct: at2000 ? at2000.cost_pct : null,
        exit_cost_2000_complete: at2000 ? at2000.cost_complete : null,
        exits_missing: exitsMissing(exits, pid),
        sell_tax: packet.sell_tax || null,
        ...(contractGateOf(packet) ? { contract_gate: contractGateOf(packet) } : {}),
        invalidation_version: ticket.versions && ticket.versions.invalidation === INVALIDATION_V3 ? INVALIDATION_V3 : INVALIDATION_VERSION,
        ...(contractAdmission ? { contract_admission: { ...contractAdmission, held_risk: g.contract_hold ? { from: g1.proposal_type, risk_usd: g1.suggested_risk_usd, reason: g.capped.reason } : null } } : {}),
        admission: { version: admission.version, checked_at: admission.checked_at, price_stale_minutes: admission.price_stale_minutes, price: admission.price, metric: admission.metric, held_risk: g.admission_hold ? { from: g0.proposal_type, risk_usd: g0.suggested_risk_usd, reason: g.capped.reason } : null, limit: admission.limit },
        ...(breached && exemptType ? { trigger_breached_at_save: { kind: breached.kind, words: breached.words } } : {}),
      },
      // Both agents' own figures and verdicts, side by side; the spread is the
      // difference between the two, never their average.
      agent_disagreement: {
        researcher: { report_id: basis.researcher.report_id, grade: gateGrade(rgrade), grade_display: rgrade ? rgrade.display : null, verdict: basis.researcher.verdict },
        prosecutor: { conviction_score: c.prosecution.conviction_score, verdict: c.prosecution.verdict, fatal_flaws: c.prosecution.fatal_flaws.filter((f) => f.severity === 'fatal').length },
        spread_points: isNum(gateGrade(rgrade)) && isNum(c.prosecution.conviction_score) ? round(gateGrade(rgrade) - c.prosecution.conviction_score, 2) : null,
        note: c.agent_disagreement_note,
      },
      sources: c.sources,
      validation: { errors: norm.errors },
    };
    op.write(receipt.text.path, body, { mode: 'create' });
    op.writeJson(receiptRel(pid, rid), receipt, { mode: 'create' });
    Object.assign(t.job, { state: 'completed', receipt_id: rid, receipts: [...(t.job.receipts || []), rid], completed_at: savedAt, updated_at: savedAt });
    op.writeJson(ticketRel(pid, tid), t);
    return { receipt_id: rid };
  });
  if (out.result && out.result.replay) return { status: 'unchanged', receipt_id: out.result.replay.receipt_id, receipt: out.result.replay, verified: true, message: `This exact text is already saved as ${out.result.replay.receipt_id}.` };
  const rid = receipt.receipt_id;
  const capped = g.capped ? ` The desk capped ${g.capped.from} to ${g.proposal_type}: ${g.capped.reason}` : '';
  const clamped = receipt.as_of_clamped ? ` Its as_of (${receipt.as_of_clamped.written}) was after the save; the receipt records the time of saving and keeps what was written.` : '';
  return {
    status: out.verified ? 'saved' : 'unverified',
    receipt_id: rid,
    receipt,
    verified: out.verified,
    files: out.files,
    message: out.verified
      ? `Saved ticket ${rid} for ${project.name}: ${g.proposal_type}, suggested risk ${usd(g.suggested_risk_usd)}. Waiting for Eric's PM review.${capped}${clamped}${rev ? ` A revision of ${rev.of}; the original is unchanged.` : ''}${norm.errors.length ? ` ${norm.errors.length} format note${norm.errors.length === 1 ? '' : 's'} kept with it.` : ''}`
      : `The desk wrote ${rid} but could not confirm it read back as written. Save the same text again; if it landed, nothing changes.`,
  };
}

function receiptText(ws, pid, rid) {
  const r = readJson(ws.abs(receiptRel(pid, rid)), null);
  if (!r) throw new OpError('NOT_FOUND', `No ticket receipt ${rid} for ${pid}.`);
  if (r.kind === 'desk_gate') throw new OpError('INVALID', `${rid} is the desk's gate, not a Prosecutor's ticket: it has no saved text.`);
  const text = verifiedFrozen(ws, r.text && r.text.path, r.text && r.text.sha256, `The saved text of ${rid}`);
  return { receipt_id: rid, saved_at: r.saved_at, sha256: r.text.sha256, chars: text.length, verified: true, text };
}

// ---------------------------------------------------------------------------
// The paper mandate (cr-paper-mandate@1; settings automation.autonomous_paper_loop
// and automation.mandate). Under it the desk may grant a Prosecutor's ticket
// on the Trader Sim book by itself, within Eric's caps, until it expires. A
// mandate grant is the mandate's, never Eric's; it never opens a PM Cohort
// position; his Undo or Veto latches the ticket off for good. Whatever cannot
// be read keeps it off: unknown is never a grant.

const MANDATE_VERSION = 'cr-paper-mandate@1';
const MANDATE_BY = `mandate:${MANDATE_VERSION}`;
// A hard floor, whatever tickets.sizing.min_grade_new_entry says.
const MANDATE_MIN_GRADE = 50;
const MANDATE_MAX_DAYS = 30;
const MANDATE_MAX_CAP = 5;
const MANDATE_MAX_CHAINS = 10;
const MANDATE_DEFAULTS = Object.freeze({ expires_at: null, max_grants_per_day: 1, max_open_grants: 2, allowed_chains: Object.freeze(['ethereum', 'base', 'arbitrum', 'optimism', 'solana']) });
const MANDATE_MEANING = 'The desk\'s paper mandate recorded this under the limits Eric set (automation.mandate). It is not Eric\'s decision and places no real order.';

// The tier from the receipt's own grade (a range read at its low end): 50 up
// to 55 is the exploratory half grant, 55 and above the standard grant, under
// 50 nothing.
function mandateTierOf(grade) {
  if (!isNum(grade) || grade < MANDATE_MIN_GRADE) return null;
  return grade < 55 ? { name: 'exploratory_50_54', action: 'halve' } : { name: 'standard_55_plus', action: 'approve' };
}

// Whether a verified identity names this contract on this chain (chain IDs
// and aliases through chains.js, addresses compared as the family keys them).
function ownsContract(project, chainId, address) {
  const { chainInfo, addressKey } = require('./chains');
  const want = chainInfo(chainId);
  if (!want || typeof address !== 'string' || !address.trim()) return false;
  const id = (project && project.identity) || {};
  if (id.status !== 'verified') return false;
  return (Array.isArray(id.assets) ? id.assets : []).some((a) => {
    const info = chainInfo(a && a.chain);
    return Boolean(info && info.chain_id === want.chain_id && typeof a.contract_address === 'string' && addressKey(info.family, a.contract_address.trim()) === addressKey(want.family, address.trim()));
  });
}

const isMandateLine = (d) => Boolean(d && typeof d.decided_by === 'string' && d.decided_by.startsWith('mandate:'));

// 1 to 10 unique chains that chains.js knows (aliases count once). Throws INVALID.
function mandateChains(list) {
  const { chainInfo } = require('./chains');
  if (!Array.isArray(list) || !list.length || list.length > MANDATE_MAX_CHAINS) throw new OpError('INVALID', `automation.mandate.allowed_chains must list 1 to ${MANDATE_MAX_CHAINS} chains.`);
  const seen = new Set();
  return list.map((c) => {
    const info = chainInfo(c);
    if (!info) throw new OpError('INVALID', `automation.mandate.allowed_chains: "${String(c).slice(0, 40)}" is not a chain the desk knows.`);
    if (seen.has(info.chain_id)) throw new OpError('INVALID', `automation.mandate.allowed_chains names ${info.label} twice.`);
    seen.add(info.chain_id);
    return String(c).trim().toLowerCase();
  });
}

// The mandate in force. `on` only when the loop is on, automation is not
// paused, the expiry is in the future and at most MANDATE_MAX_DAYS ahead, every
// limit reads, and this is not a restored copy on hold.
function mandateOf(ws, now = Date.now()) {
  const a = (ws.settings && ws.settings.automation) || {};
  const raw = a.mandate && typeof a.mandate === 'object' && !Array.isArray(a.mandate) ? a.mandate : {};
  const out = {
    version: MANDATE_VERSION,
    on: false,
    why: null,
    expires_at: typeof raw.expires_at === 'string' ? raw.expires_at : null,
    max_grants_per_day: null,
    max_open_grants: null,
    allowed_chains: null,
    settings_sha256: sha256(require('./requests').stableStringify(raw)),
    // The arming this mandate is under (mandate-authority.js): its generation,
    // when it was armed, and when it was revoked (loop off or paused).
    generation: null,
    armed_at: null,
    revoked_at: null,
    expired: false,
    held: false,
  };
  const au = raw.authority && typeof raw.authority === 'object' && !Array.isArray(raw.authority) ? raw.authority : null;
  if (au && Number.isSafeInteger(au.generation) && au.generation >= 1) {
    out.generation = au.generation;
    out.armed_at = typeof au.armed_at === 'string' ? au.armed_at : null;
    out.revoked_at = typeof au.revoked_at === 'string' ? au.revoked_at : null;
  }
  const problems = [];
  for (const k of ['max_grants_per_day', 'max_open_grants']) {
    const v = raw[k] === undefined ? MANDATE_DEFAULTS[k] : raw[k];
    if (Number.isInteger(v) && v >= 1 && v <= MANDATE_MAX_CAP) out[k] = v;
    else problems.push(`automation.mandate.${k} does not read as a whole number from 1 to ${MANDATE_MAX_CAP}`);
  }
  try { out.allowed_chains = mandateChains(raw.allowed_chains === undefined ? [...MANDATE_DEFAULTS.allowed_chains] : raw.allowed_chains); } catch (err) { problems.push(err.message.replace(/\.$/, '')); }
  const t = out.expires_at ? Date.parse(out.expires_at) : NaN;
  let held = null;
  try { held = require('./research').restoredHold(ws); } catch (_) { held = { unreadable: true }; }
  if (a.autonomous_paper_loop !== true) out.why = 'The paper mandate is off (automation.autonomous_paper_loop).';
  else if (a.paused === true) out.why = 'Automation is paused: the paper mandate grants nothing.';
  else if (!out.generation) out.why = 'The paper mandate is on without an arming the desk recorded (cr-mandate-authority@1), so it grants nothing; arm it again (arm-desk --mandate-days=N, or set the mandate in settings).';
  else if (out.revoked_at) out.why = `The paper mandate's generation ${out.generation} was revoked at ${out.revoked_at}; arm it again to grant.`;
  else if (problems.length) out.why = `The paper mandate's limits do not read, so it grants nothing: ${problems.join('; ')}.`;
  else if (!Number.isFinite(t)) out.why = 'The paper mandate has no expiry (automation.mandate.expires_at), so it grants nothing.';
  else if (t <= now) { out.why = `The paper mandate expired at ${out.expires_at}.`; out.expired = true; }
  else if (t - now > MANDATE_MAX_DAYS * 86400000) out.why = `The paper mandate's expiry is more than ${MANDATE_MAX_DAYS} days ahead; set it again.`;
  else if (held) { out.why = 'This is a restored copy on hold: the paper mandate grants nothing until it is released.'; out.held = true; }
  else out.on = true;
  return out;
}

// ---------------------------------------------------------------------------
// Eric's PM decisions

// The decision in force for a receipt: the last line that an undo has not
// taken back.
function decisionFor(lines, rid) {
  const mine = lines.filter((l) => l.receipt_id === rid);
  const undone = new Set(mine.filter((l) => l.action === 'undo').map((l) => l.undoes));
  return mine.filter((l) => l.action !== 'undo' && !undone.has(l.decision_id)).pop() || null;
}

// Was the receipt sized from what its verified frozen packet holds (review
// A08, item 37)? The gate is recomputed from the packet under the receipt's own
// sizing and proposal type and compared with the exit costs and the risk
// before any admission hold. `ok`, `limited` (fields differ) or `unverified`
// (the packet cannot be read as frozen). A desk-gate receipt has no
// Prosecutor's sizing to check (null). Reads only.
function integrityOf(ws, receipt) {
  // A v2 packet's contract block is checked first, a desk gate's included.
  if (receipt && receipt.desk && receipt.desk.contract_gate) {
    const ci = contractIntegrity(ws, receipt);
    if (ci) return ci;
  }
  if (!receipt || receipt.kind === 'desk_gate' || !receipt.desk) return null;
  let packet;
  try {
    if (!receipt.packet || !receipt.packet.path) throw new Error('The receipt names no frozen packet.');
    packet = JSON.parse(verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
  } catch (err) {
    return { status: 'unverified', words: `Cannot be checked: ${String(err && err.message || err).slice(0, 200)} It cannot be approved or halved; a veto, pass or watch is still allowed.` };
  }
  const d = receipt.desk;
  const sizing = d.sizing || {};
  const p = packet.researcher || {};
  const g = gate({ researcher: { grade: p.grade === undefined ? null : p.grade }, held: packet.held, exits: packet.exits || [], market: packet.market || null, native: packet.native === undefined ? null : packet.native, contract: packet.contract || null }, sizing, receipt.proposal && receipt.proposal.proposal_type);
  const exitAt = (n) => (packet.exits || []).find((x) => x.size_usd === n) || null;
  const e500 = exitAt(sizing.exit_size_usd);
  const e2000 = exitAt(2000);
  const savedRisk = d.admission && d.admission.held_risk ? d.admission.held_risk.risk_usd : d.contract_admission && d.contract_admission.held_risk ? d.contract_admission.held_risk.risk_usd : d.suggested_risk_usd;
  const num = (v) => (v === undefined ? null : v);
  const fields = [
    ['exit_cost_500_usd_pct', num(d.exit_cost_500_usd_pct), e500 ? e500.cost_pct : null],
    ['exit_cost_2000_usd_pct', num(d.exit_cost_2000_usd_pct), e2000 ? e2000.cost_pct : null],
    ['risk_before_admission_usd', num(savedRisk), g.suggested_risk_usd],
  ].filter(([, a, z]) => JSON.stringify(a) !== JSON.stringify(z)).map(([k, a, z]) => ({ field: k, saved: a, packet: z }));
  if (!fields.length) return { status: 'ok', fields: [], words: null };
  return { status: 'limited', fields, words: `Sized from a job record that differs from its frozen packet (${fields.map((f) => `${f.field}: saved ${JSON.stringify(f.saved)}, packet ${JSON.stringify(f.packet)}`).join('; ')}). It cannot be approved or halved; a veto, pass or watch is still allowed. The receipt is unchanged.` };
}

// The rules versions on a receipt that are newer than this code knows, in
// words; null when none. Same family only: cr-ticket-sizing@9 against @2.
function newerRuleOf(receipt) {
  if (!receipt) return null;
  const newer = [];
  for (const k of RULE_KINDS) {
    const v = k.of(receipt);
    const n = versionNumber(v);
    const cur = versionNumber(k.current);
    if (typeof v === 'string' && n !== null && cur !== null && n > cur && v.split('@')[0] === k.current.split('@')[0]) newer.push(v);
  }
  return newer.length ? { versions: newer, words: `Made under a newer rule (${newer.join(', ')}): shown as saved, not re-read.` } : null;
}

// How long a ticket's frozen exit readings give the trader a size
// (cr-ticket-exit-evidence@1, the cohesion audit's M3, 2026-10-29). The rule
// is the Paper Book's own (paper-trader.js exitCapOf): a reading counts when
// its cost is known in full, is within the receipt's frozen exit-cost limit
// and is no older than the desk's exit freshness window; the evidence expires
// when its newest such reading passes that window. Only a risk-taking ticket
// has one; null otherwise. Reads the verified packet; writes nothing.
const EXIT_EVIDENCE_VERSION = 'cr-ticket-exit-evidence@1';
const EXIT_FRESH_HOURS = require('./forensic-defs').EVENTS.liquidity_impairment.freshness_hours;
// The frozen exit readings that count: complete, dated, within the limit.
function countedExits(exits, limit) {
  return (Array.isArray(exits) ? exits : []).filter((x) => x && Number(x.size_usd) > 0 && x.cost_complete === true && isNum(x.cost_pct) && limit > 0 && x.cost_pct <= limit && Number.isFinite(Date.parse(x.as_of)));
}

function exitEvidenceOf(ws, receipt, now = Date.now()) {
  if (!receipt || receipt.kind === 'desk_gate' || !receipt.desk || !RISK_TAKING.has(receipt.desk.proposal_type) || !(receipt.desk.suggested_risk_usd > 0)) return null;
  const base = { version: EXIT_EVIDENCE_VERSION, fresh_hours: EXIT_FRESH_HOURS };
  let packet;
  try {
    if (!receipt.packet || !receipt.packet.path) throw new Error('The receipt names no frozen packet.');
    packet = JSON.parse(verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
  } catch (err) {
    return { ...base, state: 'unknown', expires_at: null, expired: false, words: `The exit readings cannot be read: ${String(err && err.message || err).slice(0, 200)}` };
  }
  const limit = Number(receipt.desk.sizing && receipt.desk.sizing.max_exit_cost_pct);
  const counted = countedExits(packet.exits, limit);
  if (!counted.length) return { ...base, state: 'none', expires_at: null, expired: false, words: 'No exit reading on this ticket is complete and within its limit, so the trader has no size from it.' };
  const newest = Math.max(...counted.map((x) => Date.parse(x.as_of)));
  const ends = newest + EXIT_FRESH_HOURS * 3600000;
  const day = iso(ends).slice(0, 16).replace('T', ' ');
  if (now > ends) return { ...base, state: 'expired', expires_at: iso(ends), expired: true, words: `The exit readings this ticket froze expired ${day} UTC (${EXIT_FRESH_HOURS} hours after the newest, ${iso(newest).slice(0, 10)}): an approval now gives the trader no size, so no order would be made. Renew the exit evidence: a new ticket on fresh readings, the old one kept.` };
  return { ...base, state: 'current', expires_at: iso(ends), expired: false, words: `The exit readings this ticket froze give the trader a size until ${day} UTC.` };
}

// An exit reading arrived after a ticket froze none (autonomous paper
// playbook, Stage 5): { kind: 'exit_evidence_arrived', why, exit } or null.
// All must hold: a Prosecutor's ticket (not the desk's gate) with no grant in
// force; its frozen packet holds no complete exit within its limit; the
// desk's reading at the exit size is now complete, within the limit in force
// and under EXIT_FRESH_HOURS old; and the gate with no proposal would now
// allow risk, so a replacement is never one that would still be $0. The
// cheap reads go first. Fails closed: a packet that does not read is null.
function exitArrivedOf(ws, project, receipt, now = Date.now()) {
  if (!receipt || receipt.kind === 'desk_gate' || newerRuleOf(receipt) || !receipt.desk) return null;
  const pid = receipt.project_id || project.project_id;
  const inForce = decisionFor(readDecisions(ws, pid), receipt.receipt_id);
  if (inForce && (inForce.action === 'approve' || inForce.action === 'halve')) return null;
  let packet;
  try {
    if (!receipt.packet || !receipt.packet.path) return null;
    packet = JSON.parse(verifiedFrozen(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet'));
  } catch (_) {
    return null;
  }
  const frozenLimit = Number(receipt.desk.sizing && receipt.desk.sizing.max_exit_cost_pct);
  if (countedExits(packet.exits, frozenLimit).length) return null;
  const sizing = sizingOf(ws);
  const researcher = researcherOf(ws, pid);
  if (!researcher) return null;
  const x = exitsOf(ws, pid, [sizing.exit_size_usd], now)[0];
  const at = x && x.as_of ? Date.parse(x.as_of) : NaN;
  if (!x || x.cost_complete !== true || !isNum(x.cost_pct) || !(x.cost_pct <= sizing.max_exit_cost_pct) || !Number.isFinite(at) || now - at > EXIT_FRESH_HOURS * 3600000) return null;
  const market = marketOf(ws, project);
  // held changes only the trim type, never whether new risk is allowed.
  const g = gate({ researcher, held: false, exits: [x], market, native: { native_chain: Boolean(project.identity && project.identity.native_chain === true), market_cap_usd: isNum(market.market_cap_usd) ? market.market_cap_usd : null } }, sizing);
  if (g.risk_allowed !== true) return null;
  return {
    kind: 'exit_evidence_arrived',
    why: `An exit reading at ${usd(x.size_usd)} arrived after this ticket froze none: ${x.cost_pct}%, complete, as of ${x.as_of}. A new ticket can freeze it.`,
    exit: { size_usd: x.size_usd, cost_pct: x.cost_pct, cost_complete: true, method: x.method, as_of: x.as_of },
  };
}

// Why a saved ticket may be re-opened: it is invalidated, an exit reading
// arrived after it froze none (exitArrivedOf), it was sized under an older
// rules version than the one in force, or (M3) its exit readings have expired
// while no grant is in force. Null when none holds. Only the paper mandate
// re-opens by itself, and only for an exit reading that arrived.
function reopenReason(ws, project, receipt, { now = Date.now() } = {}) {
  if (!receipt || receipt.kind === 'desk_gate' || newerRuleOf(receipt)) return null;
  const inv = invalidationOf(ws, project, receipt, { now });
  if (inv.invalidated) return { kind: 'invalidated', why: inv.words || 'The ticket is invalidated.' };
  const arrived = exitArrivedOf(ws, project, receipt, now);
  if (arrived) return arrived;
  const was = receipt.versions && receipt.versions.sizing;
  const inForce = sizingOf(ws).version;
  if (was && was !== inForce) return { kind: 'rules_upgrade', why: `Sized under ${was}; ${inForce} is in force.` };
  const ev = exitEvidenceOf(ws, receipt, now);
  if (ev && ev.expired) {
    // A grant in force keeps its own course (its position closes on its own
    // terms); renewal is for a ticket not yet granted, or one re-opened.
    const d = decisionFor(readDecisions(ws, receipt.project_id || project.project_id), receipt.receipt_id);
    if (!d || d.action === 'reopen') return { kind: 'exit_expired', why: ev.words, expires_at: ev.expires_at };
  }
  return null;
}

// What a grant must hold at the moment it is recorded (review A04,
// 2026-10-25): the ticket is not invalidated, its invalidation can be read
// under this code's rules, and the report it answers is still Claude's
// current one. Read inside the decision's lock; a refusal names the change.
function grantBlock(ws, project, receipt, now) {
  const inv = invalidationOf(ws, project, receipt, { now });
  if (inv.unread) return { code: 'REFUSED', message: `Not recorded: ${inv.words} Whether it is invalidated cannot be read here, so it cannot be approved.`, changed: [{ kind: 'rules', words: inv.words }] };
  if (inv.invalidated) return { code: 'INVALIDATED', message: `Not recorded: this ticket is invalidated. ${inv.words} An approval applies to the ticket as you saw it, so nothing was granted; re-open it for a new review.`, changed: [{ kind: 'invalidated', by: inv.by, words: inv.words }] };
  const ev = exitEvidenceOf(ws, receipt, now);
  if (ev && ev.expired) return { code: 'EXIT_EXPIRED', message: `Not recorded: ${ev.words}`, changed: [{ kind: 'exit_evidence', expires_at: ev.expires_at, words: ev.words }] };
  const cb = contractGrantBlock(ws, project, receipt, now);
  if (cb) return cb;
  let cur = null;
  try { cur = researcherOf(ws, project.project_id); } catch (_) { cur = null; }
  const was = receipt.researcher && receipt.researcher.report_id;
  if (was && (!cur || cur.report_id !== was)) {
    const words = cur ? `Claude's report ${was}, which this ticket answers, is superseded by ${cur.report_id}.` : `Claude's report ${was}, which this ticket answers, is no longer Claude's current eligible report.`;
    return { code: 'BASIS_CHANGED', message: `Not recorded: ${words} Nothing was granted; a ticket on the current report needs your review.`, changed: [{ kind: 'report', from: was, to: cur ? cur.report_id : null, words }] };
  }
  return null;
}

// The card's `seen` (status, suggested risk, superseded report) against the
// ticket now: what differs, in words. Empty when it matches or nothing was sent.
function seenChanges(seen, now) {
  if (!seen || typeof seen !== 'object') return [];
  const out = [];
  const cmp = (key, label) => {
    if (!Object.prototype.hasOwnProperty.call(seen, key)) return;
    const a = seen[key] === undefined ? null : seen[key];
    const b = now[key] === undefined ? null : now[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ kind: key, from: a, to: b, words: `${label}: you saw ${JSON.stringify(a)}, it is now ${JSON.stringify(b)}` });
  };
  cmp('status', 'Status');
  cmp('suggested_risk_usd', 'Suggested risk');
  cmp('superseded_by_report', 'Newer Claude report');
  return out;
}

// mandate: { version, tier, grade_used }, from mandateSweep only. No route,
// command or connector tool passes it (tests/tickets-mandate-decide.test.js).
function decide(ws, pid, { receipt_id: rid, action, note = null, request_id: requestId = null, by = null, seen = null, mandate = null }) {
  if (!RECEIPT_RE.test(String(rid))) throw new OpError('BAD_ID', 'Name the ticket you decided (its receipt ID).');
  if (!ACTIONS.includes(action)) throw new OpError('INVALID', `The decision is one of ${ACTIONS.join(', ')}.`);
  if (mandate !== null) {
    if (!mandate || typeof mandate !== 'object' || mandate.version !== MANDATE_VERSION) throw new OpError('INVALID', `A paper mandate decision names ${MANDATE_VERSION}.`);
    if (!['approve', 'halve', 'reopen'].includes(action)) throw new OpError('INVALID', `The paper mandate records approve, halve or reopen only, never ${action}.`);
  }
  const text = note === null || note === undefined ? null : String(note).replace(/\r\n/g, '\n').trim().slice(0, 1000) || null;
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const rel = decisionsRel(pid);
  const held = action === 'pass' ? heldOf(ws, pid, Date.now()) === true : false;
  let proj = null;
  const project = () => proj || (proj = require('./projects').getProject(ws, pid));
  let reopen = null;
  if (action === 'reopen') {
    const rec = readJson(ws.abs(receiptRel(pid, rid)), null);
    if (rec) {
      reopen = mandate ? exitArrivedOf(ws, project(), rec) : reopenReason(ws, project(), rec);
      if (!reopen && mandate) throw new OpError('REFUSED', 'Not recorded: the paper mandate re-opens a ticket only when an exit reading arrived after it froze none and the gate would now allow risk. This ticket is not one.', { reason: 'MANDATE_NO_REOPEN' });
      if (!reopen && rec.kind !== 'desk_gate') throw new OpError('REFUSED', 'Re-open applies only to an invalidated ticket, one that froze no exit reading when one has since arrived, one sized under an older rules version than the one in force, or one whose exit readings expired before any grant. This ticket is none of these.');
    }
  }
  const out = runOp(ws, { type: 'ticket_decision', summary: `${mandate ? 'Paper mandate' : 'PM'} ${action} on ${rid} for ${pid}` }, (op) => {
    const r = op.readJson(receiptRel(pid, rid), null);
    if (!r) throw new OpError('NOT_FOUND', `No ticket ${rid} for ${pid}.`);
    if (r.kind === 'desk_gate' && !['pass', 'watch', 'undo'].includes(action)) throw new OpError('REFUSED', `This is the desk's gate, not a Prosecutor's ticket (${r.desk && r.desk.proposal_type || 'no proposal'}, no risk): ${action} does not apply. Confirm the pass or keep it on watch.`);
    const cur = op.readText(rel, '');
    const lines = cur.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    // A replay names whether the decision is still the one in force, so its
    // consequences are completed once, never for a decision taken back (A06).
    // It also says the basis as recorded; nothing is built for it now.
    const replay = (d) => {
      const mine = lines.filter((l) => l.receipt_id === rid);
      const basis = require('./decision-basis').stateOf(ws, pid, d.decision_id);
      if (d.action === 'undo') return { status: 'unchanged', decision: d, live: mine[mine.length - 1] === d, undone: lines.find((l) => l.decision_id === d.undoes) || null, basis };
      const now = decisionFor(lines, rid);
      return { status: 'unchanged', decision: d, live: Boolean(now && now.decision_id === d.decision_id), undone: null, basis };
    };
    const prior = reqId ? lines.find((l) => l.request_id === reqId) : null;
    if (prior) return replay(prior);
    const latest = listReceipts(ws, pid).filter((x) => !x.broken).pop();
    if (action !== 'undo' && latest && latest.receipt_id !== rid) throw new OpError('NEWER_REPORT', `Not recorded: a newer ticket was saved (${latest.receipt_id}, ${latest.saved_at}). Look at it, then decide that one.`, { newer: [{ receipt_id: latest.receipt_id, saved_at: latest.saved_at }] });
    const inForce = decisionFor(lines, rid);
    // The paper mandate, checked under this lock: on now, zero history on the
    // receipt for a grant (any decision of Eric's, a veto or an undo
    // included, latches it off), the tier from the receipt's own grade, and
    // one mandate re-open per Claude report.
    let mandateLine = null;
    if (mandate) {
      const MA = require('./mandate-authority');
      // Strict history: a line that does not read is not an empty history.
      try { MA.parseStrict(cur, rel, 'The decision history'); } catch (err) { throw new OpError('REFUSED', `Not recorded: ${err.message}`, { reason: 'MANDATE_HISTORY_UNREADABLE' }); }
      const m = mandateOf(ws, Date.now());
      if (!m.on) throw new OpError('REFUSED', `Not recorded: ${m.why}`, { reason: 'MANDATE_OFF' });
      // The desk's one gate (automationGate): any veto, Undo, archive or stop
      // of Eric's not cleared by his rearm, or the pause, stops every mandate
      // action, re-opens included.
      const gate = MA.automationGate(ws, pid, { decisions: lines });
      if (!gate.ok) throw new OpError('REFUSED', `Not recorded: ${gate.words}`, { reason: gate.project_stopped ? 'MANDATE_SUSPENDED' : 'MANDATE_OFF' });
      const g = gateGrade(r.researcher && r.researcher.grade);
      if (action === 'approve' || action === 'halve') {
        if (lines.some((l) => l.receipt_id === rid)) throw new OpError('REFUSED', 'Not recorded: this ticket already has a decision on record. The paper mandate grants only a ticket nobody has decided.', { reason: 'MANDATE_PRIOR_DECISION' });
        const tier = mandateTierOf(g);
        if (!tier || tier.action !== action || tier.name !== mandate.tier) throw new OpError('INVALID', `Not recorded: grade ${g === null ? 'none' : g} gives the paper mandate ${tier ? `${tier.action} (${tier.name})` : 'nothing'}, not ${action} (${mandate.tier || 'no tier'}).`);
        // A contradictory or malformed prosecution is Eric's to review.
        const ph = MA.prosecutionHoldOf(ws, r);
        if (ph) throw new OpError('REFUSED', `Not recorded: ${ph.words}`, { reason: 'MANDATE_PROSECUTION_HOLD', hold: ph.code });
        // The caps, counted at this write: pending, waiting and open grants
        // and their exposure hold capacity until they are finished.
        let cap;
        try { cap = MA.mandateCapacity(ws, { now: Date.now() }); } catch (err) { throw new OpError('REFUSED', `Not recorded: the paper mandate's caps cannot be counted (${String(err && err.message || err).slice(0, 200)}).`, { reason: 'MANDATE_CAP_UNKNOWN' }); }
        if (cap.grants_today >= m.max_grants_per_day) throw new OpError('REFUSED', `Not recorded: the paper mandate's ${m.max_grants_per_day} grant${m.max_grants_per_day === 1 ? '' : 's'} for today (New York) are made.`, { reason: 'MANDATE_CAP_DAY' });
        if (cap.open_grants >= m.max_open_grants) throw new OpError('REFUSED', `Not recorded: the paper mandate holds ${cap.open_grants} grant${cap.open_grants === 1 ? '' : 's'} not yet finished, its limit of ${m.max_open_grants}.`, { reason: 'MANDATE_CAP_OPEN', holding: cap.holding });
      } else {
        if (lines.some((l) => l.receipt_id === rid && !isMandateLine(l))) throw new OpError('REFUSED', 'Not recorded: Eric decided this ticket; the paper mandate never re-opens a ticket with a decision of his.', { reason: 'MANDATE_HUMAN_LATCH' });
        const reportOf = new Map(listReceipts(ws, pid).filter((x) => !x.broken).map((x) => [x.receipt_id, x.researcher ? x.researcher.report_id : null]));
        const was = r.researcher ? r.researcher.report_id : null;
        if (lines.some((l) => l.action === 'reopen' && isMandateLine(l) && reportOf.get(l.receipt_id) === was)) throw new OpError('REFUSED', `Not recorded: the paper mandate already re-opened a ticket on Claude's report ${was}.`, { reason: 'MANDATE_REOPEN_DONE' });
      }
      mandateLine = { version: MANDATE_VERSION, tier: action === 'reopen' ? null : mandate.tier, grade_used: g, expires_at: m.expires_at, settings_sha256: m.settings_sha256, authority: { version: MA.AUTHORITY_VERSION, generation: m.generation, armed_at: m.armed_at, policy_sha256: m.settings_sha256 } };
    }
    const at = new Date().toISOString();
    let line;
    if (action === 'undo') {
      if (!inForce) throw new OpError('CONFLICT', 'There is no decision on this ticket to undo.');
      line = { action: 'undo', undoes: inForce.decision_id };
    } else {
      const suggested = r.desk ? r.desk.suggested_risk_usd : 0;
      const type = r.desk ? r.desk.proposal_type : null;
      if (action === 'reopen' && inForce && inForce.action === 'reopen') return replay(inForce);
      if ((action === 'approve' || action === 'halve') && !(suggested > 0)) throw new OpError('REFUSED', `This ticket suggests no risk (${type || 'no proposal'}): there is nothing to approve. Confirm the pass, or keep watching.`);
      if ((action === 'pass' || action === 'watch') && suggested > 0) throw new OpError('REFUSED', `This ticket suggests ${usd(suggested)} of risk: approve, halve or veto it.`);
      if (action === 'reopen' && !reopen) throw new OpError('REFUSED', 'Re-open applies only to an invalidated ticket, one that froze no exit reading when one has since arrived, one sized under an older rules version, or one whose exit readings expired before any grant.');
      if (action === 'trim' && type !== 'TRIM_EXIT') throw new OpError('REFUSED', `This ticket proposes ${type || 'nothing'}, not a trim.`);
      if (inForce && inForce.action === action) return replay(inForce);
      // One live paper exposure per ticket: a grant in force is undone before
      // another grant or a veto replaces it (its position is then voided).
      if (inForce && (inForce.action === 'approve' || inForce.action === 'halve') && ['approve', 'halve', 'veto'].includes(action)) throw new OpError('CONFLICT', `Not recorded: the ${inForce.action} decision (${inForce.decision_id}, ${usd(inForce.pm_approved_risk_usd)}) is in force. Undo it first, then record the ${action}.`);
      const now = Date.now();
      if (action === 'approve' || action === 'halve') {
        const integ = integrityOf(ws, r);
        if (integ && integ.status !== 'ok') throw new OpError('INTEGRITY', `Not recorded: ${integ.words}`, { fields: (integ.fields || []).map((f) => f.field) });
        const block = grantBlock(ws, project(), r, now);
        if (block) throw new OpError(block.code, block.message, { changed: block.changed });
      }
      // Only a grant must match what the card showed: a veto, pass or watch on a
      // ticket that changed meanwhile takes no risk.
      const changed = seen && (action === 'approve' || action === 'halve') ? seenChanges(seen, (() => {
        let superseded = null;
        try { const c = researcherOf(ws, pid); superseded = c && r.researcher && c.report_id !== r.researcher.report_id ? c.report_id : null; } catch (_) { superseded = null; }
        return { status: statusOf(inForce, invalidationOf(ws, project(), r, { now })), suggested_risk_usd: suggested || 0, superseded_by_report: superseded };
      })()) : [];
      if (changed.length) throw new OpError('CHANGED', `Not recorded: the ticket changed since you saw it. ${changed.map((x) => x.words).join('; ')}. Look at it again, then decide.`, { changed });
      const starter = r.desk && r.desk.sizing ? r.desk.sizing.starter_risk_usd : SIZING_DEFAULTS.starter_risk_usd;
      const approved = action === 'approve' ? suggested : action === 'halve' ? Math.min(starter, suggested) : 0;
      line = { action, pm_approved_risk_usd: approved, suggested_risk_usd: suggested, proposal_type: type, ...(action === 'reopen' ? { reopen: reopen } : {}) };
      // A confirmed pass archives the project (reversible; Undo restores it),
      // except one Eric holds, which stays watched.
      if (action === 'pass') line.archive = held ? 'kept: held' : 'archived';
    }
    // The consequences, stated with the decision so a retry completes them.
    const grants = (d) => d && (d.action === 'approve' || d.action === 'halve');
    line.effects = {
      archive: action === 'pass' && line.archive === 'archived' ? 'archive' : action === 'undo' && inForce.archive === 'archived' ? 'restore' : null,
      // The PM Cohort book (paper.js) measures Eric's own grants only: a
      // mandate grant opens none, and its undo voids none.
      paper: grants(line) && !mandateLine ? 'open' : action === 'undo' && paperWanted(inForce) ? 'void' : null,
      journal: 'entry',
      // The trader's Paper Book (cr-paper@2, slot 12a): a grant asks for its
      // order, an undo of one for what has not filled cancelled and what has
      // closed (core/trader-desk.js; only decisions stating this ask it).
      trader: grants(line) ? 'open' : action === 'undo' && grants(inForce) ? 'close' : null,
    };
    const full = { schema_version: 'cr.ticket-decision.v1', decision_id: `td_${sha256(`${pid}:${rid}:${action}:${at}:${lines.length}`).slice(0, 14)}`, project_id: pid, receipt_id: rid, ticket_id: r.ticket_id, ...line, note: text, decided_at: at, decided_by: mandateLine ? MANDATE_BY : by || ws.actor || null, request_id: reqId, ...(mandateLine ? { mandate: mandateLine } : {}), meaning: mandateLine ? MANDATE_MEANING : 'Eric\'s PM decision on the ticket: it records his choice and places no order.' };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(full)}\n`);
    // What the decision stood on (cr.decision-basis.v1), staged in this same
    // operation: the line and its basis commit together or not at all. The
    // line stays cr.ticket-decision.v1 (the Paper Book reads only that).
    const DB = require('./decision-basis');
    // Eric's veto and Undo are the project stop (mandate-authority.js reads
    // them from this line), so a basis that cannot be built never holds them
    // back (audit F1, 2026-11-02): the failure is recorded in the basis's place
    // as unavailable, in this same operation, and read back as such. A grant,
    // a pass, a watch, a trim or a re-open still commits only with its basis.
    let basis;
    try {
      basis = DB.buildBasis(ws, { decision: full, receipt: r, receiptText: fs.readFileSync(ws.abs(receiptRel(pid, rid))), decisions: lines });
    } catch (err) {
      if (mandateLine || !DB.STOP_ACTIONS.includes(action)) throw err;
      basis = DB.unavailableBasis({ decision: full, error: err });
    }
    op.writeJson(DB.basisRel(pid, full.decision_id), basis, { mode: 'create' });
    return { status: 'saved', decision: full, live: true, undone: action === 'undo' ? inForce : null, basis: DB.stateOfRecord(basis) };
  });
  const res = out.result || {};
  if (res.live) Object.assign(res, effectsOf(ws, pid, rid, res.decision, res.undone));
  return out;
}

// The decision's consequences: the project archived or restored, the journal
// entry, the paper position opened or voided. Each is idempotent, so a replay
// of the same request (or the same decision again) completes what a failure
// left undone and duplicates nothing. A failure here is told, never allowed
// to lose or block the decision.
function effectsOf(ws, pid, rid, d, undone) {
  const out = {};
  const projects = require('./projects');
  const step = (fn) => { try { return fn(); } catch (err) { return { status: 'failed', error: String(err && err.message || err).slice(0, 200) }; } };
  if (d.action === 'pass' && d.archive === 'archived') {
    out.archive = step(() => projects.archiveProject(ws, pid, `PM confirmed the pass on ticket ${rid}.`));
    if (out.archive.status !== 'failed') out.project_archived = true;
  }
  if (d.action === 'undo' && undone && undone.archive === 'archived') {
    out.restore = step(() => projects.restoreProject(ws, pid));
    if (out.restore.status !== 'failed') out.project_restored = true;
  }
  out.journal = journalDecision(ws, pid, d, undone);
  // The PM Cohort book only where the decision asks it (effects.paper); a
  // line written before effects existed keeps the action-based rule.
  const asked = d.effects && typeof d.effects === 'object' ? d.effects.paper === 'open' || d.effects.paper === 'void' : true;
  out.paper = asked ? paperBook(ws, pid, rid, d, undone) : null;
  out.trader = traderBook(ws, pid, d);
  return out;
}

// Whether a decision's grant opens (or opened) a PM Cohort position: an
// approve or halve whose effects ask the paper book, or an older line with no
// effects at all. A mandate grant never does.
function paperWanted(d) {
  if (!d || !(d.action === 'approve' || d.action === 'halve')) return false;
  return d.effects && typeof d.effects === 'object' ? d.effects.paper === 'open' : true;
}

// The decision's order in the trader's Paper Book (cr-paper@2): the desk's
// adapter takes one step for this project at once (core/trader-desk.js).
// Until the book can answer (funded, Eric's rules and fee set, recent hours
// for the pair) the request waits, said in words, and the adapter's later
// steps complete it. Simulated only: it places no order at any venue.
function traderBook(ws, pid, d) {
  if (!d.effects || !d.effects.trader) return null;
  try {
    const r = require('./trader-desk').step(ws, { project: pid });
    const id = d.action === 'undo' ? d.undoes : d.decision_id;
    const mine = r.requests.find((x) => x.decision_id === id);
    const problems = r.problems.filter((x) => !x.decision_id || x.decision_id === id);
    return { status: mine ? mine.phase : 'skipped', words: mine ? mine.words : null, ...(problems.length ? { problems } : {}) };
  } catch (err) {
    return { status: 'failed', error: String(err && err.message || err).slice(0, 200) };
  }
}

// A decision that grants risk opens a paper position (core/paper.js, kept
// apart from the portfolio); Undo voids it.
function paperBook(ws, pid, rid, d, undone) {
  try {
    const paper = require('./paper');
    if (d.action === 'approve' || d.action === 'halve') {
      const receipt = readJson(ws.abs(receiptRel(pid, rid)), null);
      return receipt ? paper.openForDecision(ws, require('./projects').getProject(ws, pid), { ...receipt, project_id: pid }, d) : { status: 'skipped' };
    }
    if (d.action === 'undo' && undone && (undone.action === 'approve' || undone.action === 'halve')) return paper.voidForDecision(ws, undone.decision_id, `The ${undone.action} decision on ${rid} was undone.`);
    return null;
  } catch (err) {
    return { status: 'failed', error: String(err && err.message || err).slice(0, 200) };
  }
}

// The decision also shows in Notes as a journal entry (type decision). The
// schema's decision words do not cover every PM action, so the action, the
// receipt and the approved risk are stated in reasons; decisions.jsonl stays
// the source of truth and a journal failure never loses or blocks a decision.
// One entry per decision: an entry naming its decision_id is not written again.
function journalDecision(ws, pid, d, undone, { late = false } = {}) {
  try {
    const notes = require('./notes');
    const have = notes.loadJournal(ws, pid).find((e) => e.type === 'decision' && Array.isArray(e.reasons) && e.reasons.includes(`decision_id: ${d.decision_id}`));
    if (have) return { status: 'unchanged', entry_id: have.entry_id };
    const undo = d.action === 'undo';
    const shown = undo ? undone : d;
    const byMandate = isMandateLine(d);
    const reasons = byMandate
      ? [`mandate_action: ${d.action}`, `decided_by: ${d.decided_by}`, `receipt: ${d.receipt_id}`, `decision_id: ${d.decision_id}`]
      : [`pm_action: ${d.action}`, `receipt: ${d.receipt_id}`, `decision_id: ${d.decision_id}`];
    if (undo) reasons.push(`undoes: ${undone.decision_id}`);
    else if (isNum(d.pm_approved_risk_usd)) reasons.push(`approved_risk_usd: ${d.pm_approved_risk_usd}`);
    if (byMandate && d.mandate && d.mandate.tier) reasons.push(`mandate_tier: ${d.mandate.tier}`);
    const tierOf = (x) => (x.mandate && x.mandate.tier) || 'no tier';
    const base = undo
      ? isMandateLine(shown) ? `PM undid the paper mandate's ${shown.action} on ticket ${d.receipt_id}.` : `PM undid ${shown.action} on ticket ${d.receipt_id}.`
      : byMandate
        ? d.action === 'reopen'
          ? `Paper mandate re-opened ticket ${d.receipt_id}: ${(d.reopen && d.reopen.why) || 'an exit reading arrived'}`
          : `Paper mandate ${d.action} on ticket ${d.receipt_id}, approved risk ${usd(d.pm_approved_risk_usd)} (${tierOf(d)}).${d.note ? ` ${d.note}` : ''}`
        : `PM ${d.action} on ticket ${d.receipt_id}${isNum(d.pm_approved_risk_usd) ? `, approved risk ${usd(d.pm_approved_risk_usd)}` : ''}.${d.note ? ` ${d.note}` : ''}`;
    const text = late ? `${base} Decided ${d.decided_at}; this entry was added later by tickets reconcile.` : base;
    const entry = require('./notes').addJournal(ws, pid, { type: 'decision', decision: d.action === 'watch' || d.action === 'trim' ? d.action : null, text, reasons });
    return { status: 'saved', entry_id: entry.entry_id };
  } catch (err) {
    return { status: 'failed', error: String(err && err.message || err).slice(0, 200) };
  }
}

// A JSONL record read for a repair: a missing file is empty, but a file that
// does not read, or any line in it that does not parse, is a refusal, never
// "nothing there" (the everyday readers skip such lines).
function strictLines(ws, rel) {
  let text;
  try {
    text = require('fs').readFileSync(ws.abs(rel), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, lines: [] };
    return { ok: false, words: `${rel} could not be read (${(err && (err.code || err.message)) || 'unknown error'})` };
  }
  const lines = [];
  const bad = [];
  text.split('\n').forEach((l, i) => {
    if (!l.trim()) return;
    try { lines.push(JSON.parse(l)); } catch (_) { bad.push(i + 1); }
  });
  return bad.length ? { ok: false, words: `${rel} has ${bad.length === 1 ? 'a line that does' : `${bad.length} lines that do`} not read (line ${bad.slice(0, 5).join(', ')})` } : { ok: true, lines };
}

// Completes what a recorded decision left undone (review A06): the paper
// position of a grant in force, and the journal entry of any decision line.
// It never archives or restores a project, never voids a position and never
// touches decisions.jsonl; a pass whose archive step is not done is named.
// Before anything is written, every decisions file, the paper positions and
// each receipt and frozen packet a position would be opened from must read in
// full and hold (integrityOf); otherwise it is an INTEGRITY refusal naming
// them and nothing is written, so absence is never inferred from a failed read.
function reconcileEffects(ws, { project = null, dryRun = false } = {}) {
  const projects = require('./projects');
  const out = { dry_run: dryRun === true, completed: [], already_complete: [], named: [] };
  const pids = project ? [project] : projects.listProjects(ws).filter((p) => !p.broken).map((p) => p.project_id);
  const problems = [];
  const decisionsOf = new Map();
  for (const pid of pids) {
    const r = strictLines(ws, decisionsRel(pid));
    if (r.ok) decisionsOf.set(pid, r.lines);
    else problems.push(r.words);
  }
  const positions = strictLines(ws, require('./paper').REL);
  if (!positions.ok) problems.push(positions.words);
  const openFor = (decisionId) => (positions.lines || []).find((l) => l.event === 'open' && l.decision_id === decisionId) || null;
  for (const [pid, lines] of decisionsOf) {
    for (const rid of new Set(lines.map((l) => l.receipt_id))) {
      const inForce = decisionFor(lines, rid);
      if (!inForce || !paperWanted(inForce) || !positions.ok || openFor(inForce.decision_id)) continue;
      let receipt = null;
      try { receipt = JSON.parse(require('fs').readFileSync(ws.abs(receiptRel(pid, rid)), 'utf8')); } catch (err) { problems.push(`${receiptRel(pid, rid)} could not be read (${(err && (err.code || err.message)) || 'unknown error'})`); continue; }
      const held = integrityOf(ws, receipt);
      if (held && held.status !== 'ok') problems.push(`${receiptRel(pid, rid)}: ${held.words}`);
    }
  }
  if (problems.length) throw new OpError('INTEGRITY', `Nothing was repaired: ${problems.join('; ')}. A record that does not read is never taken as missing; fix or restore it, then run the repair again.`, { problems });
  for (const pid of pids) {
    const lines = decisionsOf.get(pid);
    if (!lines.length) continue;
    const rids = [...new Set(lines.map((l) => l.receipt_id))];
    for (const d of lines) {
      const undone = d.action === 'undo' ? lines.find((l) => l.decision_id === d.undoes) || null : null;
      if (d.action === 'undo' && !undone) continue;
      const have = require('./notes').loadJournal(ws, pid).some((e) => e.type === 'decision' && Array.isArray(e.reasons) && e.reasons.includes(`decision_id: ${d.decision_id}`));
      if (have) out.already_complete.push({ project_id: pid, decision_id: d.decision_id, step: 'journal' });
      else if (dryRun) out.completed.push({ project_id: pid, decision_id: d.decision_id, step: 'journal', status: 'would_add' });
      else out.completed.push({ project_id: pid, decision_id: d.decision_id, step: 'journal', ...journalDecision(ws, pid, d, undone, { late: true }) });
    }
    for (const rid of rids) {
      const inForce = decisionFor(lines, rid);
      if (!inForce) continue;
      if (paperWanted(inForce)) {
        const opened = openFor(inForce.decision_id);
        // A position saved with no entry price is complete, qualified; never opened again.
        if (opened) out.already_complete.push({ project_id: pid, decision_id: inForce.decision_id, step: 'paper', ...(opened.entry && opened.entry.status === 'no_entry_price' ? { qualified: 'no_entry_price' } : {}) });
        else if (dryRun) out.completed.push({ project_id: pid, decision_id: inForce.decision_id, step: 'paper', status: 'would_open' });
        else out.completed.push({ project_id: pid, decision_id: inForce.decision_id, step: 'paper', ...openStillInForce(ws, pid, rid, inForce) });
      }
      if (inForce.action === 'pass' && inForce.archive === 'archived') {
        let status = null;
        try { status = projects.getProject(ws, pid).status; } catch (_) { status = null; }
        if (status !== 'archived') out.named.push({ project_id: pid, decision_id: inForce.decision_id, step: 'archive', words: `The pass on ${rid} was to archive ${pid}, and it is not archived. Left as it is: archive it, or leave it, yourself.` });
        else out.already_complete.push({ project_id: pid, decision_id: inForce.decision_id, step: 'archive' });
      }
    }
  }
  return out;
}

// The repair's paper step at its write boundary (audit H3): inside the
// workspace lock, where a decision or an Undo is written, the decisions and the
// paper positions are read again; the position is opened only while the same
// decision is still the one in force and nothing has opened it since. A
// decision superseded or undone after the repair's first read is skipped, said
// in words, and nothing is written for it.
function openStillInForce(ws, pid, rid, d) {
  return withLock(ws, `ticket reconcile ${pid}`, () => {
    const lines = strictLines(ws, decisionsRel(pid));
    if (!lines.ok) return { status: 'skipped', reason: 'unreadable', words: `${lines.words}; the position was not opened.` };
    const now = decisionFor(lines.lines, rid);
    if (!now || now.decision_id !== d.decision_id) {
      return { status: 'skipped', reason: 'not_in_force', words: `Decision ${d.decision_id} on ${rid} is no longer the one in force (${now ? `${now.action} ${now.decision_id}` : 'none'}); the position was not opened.` };
    }
    const positions = strictLines(ws, require('./paper').REL);
    if (!positions.ok) return { status: 'skipped', reason: 'unreadable', words: `${positions.words}; the position was not opened.` };
    if (positions.lines.some((l) => l.event === 'open' && l.decision_id === d.decision_id)) return { status: 'unchanged', reason: 'opened_since' };
    return paperBook(ws, pid, rid, now, null);
  });
}

// Item 60: the one-click repair. reconcileEffects over every project, as a
// deterministic report: sorted, counted, with the archive step named and never
// done (Eric may have restored the project since). Idempotent: a second run
// completes nothing. `dryRun` reports what would be completed and writes nothing.
const RECONCILE_FORMAT = 'cr-ticket-reconcile@1';
function reconcileDesk(ws, { dryRun = false } = {}) {
  const r = reconcileEffects(ws, { dryRun });
  const order = (a, b) => a.project_id.localeCompare(b.project_id) || a.decision_id.localeCompare(b.decision_id) || a.step.localeCompare(b.step);
  const completed = r.completed.slice().sort(order);
  const failed = completed.filter((x) => x.status === 'failed');
  return {
    format: RECONCILE_FORMAT,
    dry_run: r.dry_run,
    completed,
    already_complete: r.already_complete.slice().sort(order),
    named: r.named.slice().sort(order),
    counts: { completed: completed.length - failed.length, failed: failed.length, already_complete: r.already_complete.length, named: r.named.length },
    words: dryRun
      ? `${completed.length} step${completed.length === 1 ? '' : 's'} would be completed; ${r.named.length} named for you.`
      : `${completed.length - failed.length} step${completed.length - failed.length === 1 ? '' : 's'} completed${failed.length ? `, ${failed.length} failed` : ''}; ${r.named.length} named for you (an archive is never done here).`,
  };
}

// ---------------------------------------------------------------------------
// Invalidation, evaluated on read (cr-ticket-invalidation@1, @2, @3)

// Hours since the ticket with at least one hourly reading, out of the whole
// hours elapsed, and every stretch over MAX_GAP_HOURS without a reading (from
// the ticket or the last reading to the next reading or now).
function coverageOf(times, startMs, endMs) {
  const hoursElapsed = Math.floor((endMs - startMs) / HOUR);
  const have = new Set();
  for (const t of times) {
    const k = Math.floor((t - startMs) / HOUR);
    if (k >= 0 && k < hoursElapsed) have.add(k);
  }
  const marks = [startMs, ...[...times].sort((a, b) => a - b), endMs];
  const gaps = [];
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > MAX_GAP_HOURS * HOUR) gaps.push({ from: iso(marks[i - 1]), to: iso(marks[i]), hours: round((marks[i] - marks[i - 1]) / HOUR, 1) });
  return { hours_elapsed: hoursElapsed, hours_with_reading: have.size, coverage_pct: hoursElapsed ? round((have.size / hoursElapsed) * 100, 1) : null, gaps };
}

// The Researcher's report this receipt answers, when it is no longer the basis
// to lean on: superseded by a newer eligible report, or past the research
// freshness limit. The status of the ticket does not change.
function basisStale(ws, project, receipt, now) {
  const why = [];
  try {
    const r = researcherOf(ws, project.project_id);
    if (r && receipt.researcher && r.report_id !== receipt.researcher.report_id) why.push(`Claude's report ${receipt.researcher.report_id} is superseded by ${r.report_id}.`);
  } catch (_) { /* left unread */ }
  const staleDays = (ws.settings && ws.settings.freshness && ws.settings.freshness.research_stale_days) || 90;
  const at = receipt.researcher && Date.parse(receipt.researcher.analysis_at);
  if (Number.isFinite(at) && (now - at) / 86400000 > staleDays) why.push(`The report it answers is ${Math.round((now - at) / 86400000)} days old, past ${staleDays}.`);
  return why.length ? { why: why.join(' ') } : null;
}

// The lowest hourly price recorded since the ticket was saved, and the price
// now (cr-ticket-invalidation@2 adds the coverage of those readings). A price trigger fires when any reading is at or below it; the metric
// trigger when DefiLlama's latest complete 30-day total, fetched after the
// ticket, is under its threshold. Unknown is unknown, never "holding".
function invalidationOf(ws, project, receipt, { now = Date.now(), fundamentals = null } = {}) {
  if (receipt.kind === 'desk_gate') return { version: INVALIDATION_VERSION, invalidated: false, checks: [], words: 'No invalidation trigger: the desk\'s gate, not a Prosecutor.' };
  const newer = newerRuleOf(receipt);
  if (newer) return { version: (receipt.desk && receipt.desk.invalidation_version) || INVALIDATION_VERSION, invalidated: false, unread: true, checks: [], words: newer.words, rule_note: newer.words };
  // A receipt made before the coverage rule has no version on it: read as @1.
  const v1 = !(receipt.desk && receipt.desk.invalidation_version);
  const version = v1 ? INVALIDATION_V1 : receipt.desk.invalidation_version === INVALIDATION_V3 ? INVALIDATION_V3 : INVALIDATION_VERSION;
  const inv = receipt.proposal && receipt.proposal.invalidation_trigger;
  if (!inv && version !== INVALIDATION_V3) return { version, invalidated: false, checks: [] };
  const checks = [];
  const savedMs = Date.parse(receipt.saved_at);
  const cg = project.identity && project.identity.coingecko_id;
  if (inv && isNum(inv.price_usd)) {
    let low = null;
    const times = [];
    if (cg) {
      const market = require('./market');
      const months = [];
      const d = new Date(Date.UTC(new Date(savedMs).getUTCFullYear(), new Date(savedMs).getUTCMonth(), 1));
      while (d.getTime() <= now) { months.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
      const cache = new Map();
      for (const m of months) {
        for (const pt of market.historyMonth(ws, m, cache).get(cg) || []) {
          const t = Date.parse(pt.source_last_updated_at || pt.fetched_at);
          if (!Number.isFinite(t) || t < savedMs || t > now || !isNum(pt.price_usd)) continue;
          times.push(t);
          if (!low || pt.price_usd < low.price_usd) low = { price_usd: pt.price_usd, at: iso(t), source: 'hourly observation' };
        }
      }
      const latest = (market.readLatest(ws).assets || {})[cg];
      const lt = latest ? Date.parse(latest.source_last_updated_at || latest.fetched_at) : NaN;
      if (latest && isNum(latest.price_usd) && Number.isFinite(lt) && lt >= savedMs && lt <= now) times.push(lt);
      if (latest && isNum(latest.price_usd) && Number.isFinite(lt) && lt >= savedMs && (!low || latest.price_usd < low.price_usd)) low = { price_usd: latest.price_usd, at: iso(lt), source: 'latest.json' };
    }
    const cov = v1 ? null : coverageOf(times, savedMs, now);
    const triggered = low !== null && low.price_usd <= inv.price_usd;
    const thin = cov && cov.hours_elapsed >= 1 && cov.coverage_pct < minCoveragePct(ws);
    const covWords = cov && cov.hours_elapsed >= 1 ? ` Coverage: ${cov.hours_with_reading} of ${cov.hours_elapsed} hours since the ticket had a reading${cov.gaps.length ? `; gaps over ${MAX_GAP_HOURS} h: ${cov.gaps.map((g) => `${g.from} to ${g.to}`).join('; ')}` : ''}.` : '';
    const base = low === null ? null : { price_usd: low.price_usd, at: low.at };
    if (low === null) checks.push({ kind: 'price', status: 'unknown', threshold_usd: inv.price_usd, ...(cov ? { coverage: cov } : {}), words: `No price recorded since the ticket.${covWords}` });
    else if (triggered) {
      // The published rule decides; the label only says how much was seen (item 38).
      const sampled = Boolean(thin);
      const sampledWords = sampled ? ` A sampled reading: ${cov.hours_with_reading} of ${cov.hours_elapsed} hours had one; this one is from ${low.at} (${low.source}).` : '';
      checks.push({ kind: 'price', status: 'triggered', threshold_usd: inv.price_usd, lowest_usd: low.price_usd, at: low.at, source: low.source, sampled, ...(cov ? { coverage: cov } : {}), words: `Price reached $${low.price_usd} at ${low.at} (${low.source}), at or below the invalidation price $${inv.price_usd}.${sampledWords}${covWords}` });
    }
    else if (thin) checks.push({ kind: 'price', status: 'unknown', threshold_usd: inv.price_usd, lowest_usd: base.price_usd, at: base.at, coverage: cov, words: `Not enough price readings to say the price held: ${cov.coverage_pct}% of the hours since the ticket have one, under your ${minCoveragePct(ws)}%. Lowest seen $${low.price_usd}, above $${inv.price_usd}.${covWords}` });
    else checks.push({ kind: 'price', status: 'holding', threshold_usd: inv.price_usd, lowest_usd: low.price_usd, at: low.at, ...(cov ? { coverage: cov } : {}), words: `Lowest price since the ticket $${low.price_usd}, above $${inv.price_usd}.${covWords}` });
  }
  if (inv && inv.metric) {
    const f = fundamentals || fundamentalsOf(ws, project, now);
    const m = f && f.metrics ? f.metrics[inv.metric.key] : null;
    const fetched = f && f.fetched_at ? Date.parse(f.fetched_at) : NaN;
    if (!f || f.state === 'unmapped') checks.push({ kind: 'metric', status: 'not_bound', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, words: 'No DefiLlama entity is bound: the metric is not checked.' });
    else if (!m || !isNum(m.total_30d_usd) || m.status !== 'complete') checks.push({ kind: 'metric', status: 'unknown', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, words: `No complete 30-day ${inv.metric.key} total on file.` });
    else if (!(fetched > savedMs)) checks.push({ kind: 'metric', status: 'unknown', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, words: 'The saved total is from before the ticket; it is not read as a change.' });
    else checks.push({ kind: 'metric', status: m.total_30d_usd < inv.metric.below_30d_usd ? 'triggered' : 'holding', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, value_usd: m.total_30d_usd, at: f.fetched_at, ...(m.total_30d_usd >= inv.metric.below_30d_usd && inv.metric.below_30d_usd > 0 ? { headroom_pct: round(((m.total_30d_usd - inv.metric.below_30d_usd) / inv.metric.below_30d_usd) * 100, 1) } : {}), words: `30-day ${inv.metric.key} $${Math.round(m.total_30d_usd).toLocaleString('en-US')} ${m.total_30d_usd < inv.metric.below_30d_usd ? 'under' : 'not under'} $${inv.metric.below_30d_usd.toLocaleString('en-US')}.` });
  }
  if (version === INVALIDATION_V3) {
    const c = contractCheckOf(ws, project, receipt, now);
    if (c) checks.push(c);
  }
  const hit = checks.find((c) => c.status === 'triggered') || null;
  const out = { version, invalidated: Boolean(hit), by: hit ? hit.kind : null, words: hit ? hit.words : null, fired: hit, ...(hit && hit.kind === 'price' ? { sampled: hit.sampled } : {}), checks };
  if (!v1) {
    const stale = basisStale(ws, project, receipt, now);
    if (stale) out.basis_stale = stale;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading: the ticket in force and its status

// Whether a grant in force has its paper position: 'open', 'missing' (the
// decision is recorded but its position is not; the same decision again
// completes it), or null for a decision that grants nothing.
function paperStateOf(ws, decision) {
  if (!paperWanted(decision) || !(decision.pm_approved_risk_usd > 0)) return null;
  try {
    return require('./paper').readRecords(ws).some((l) => l.event === 'open' && l.decision_id === decision.decision_id) ? 'open' : 'missing';
  } catch (_) {
    return null;
  }
}

function statusOf(decision, invalidation) {
  if (decision && decision.action === 'reopen') return 'reopened';
  if (invalidation && invalidation.invalidated) return 'invalidated';
  if (!decision) return 'pending_pm_review';
  return STATUS_OF[decision.action] || 'risk_granted';
}

// receiptId: read that saved ticket as the one in force (an earlier receipt
// shows `latest: false`); without it, the latest. Reading writes nothing.
function view(ws, pid, { now = Date.now(), fundamentals = null, receiptId = null } = {}) {
  const project = require('./projects').getProject(ws, pid);
  const receipts = listReceipts(ws, pid).filter((r) => !r.broken);
  const decisions = readDecisions(ws, pid);
  const current = receiptId ? receipts.find((r) => r.receipt_id === receiptId) || null : receipts[receipts.length - 1] || null;
  if (receiptId && !current) throw new OpError('NOT_FOUND', `No ticket receipt ${receiptId} for ${pid}.`);
  const open = openTicket(ws, pid);
  const researcher = researcherOf(ws, pid);
  let ticket = null;
  if (current) {
    const decision = decisionFor(decisions, current.receipt_id);
    const invalidation = invalidationOf(ws, project, current, { now, fundamentals });
    const d = current.desk || {};
    const pr = current.proposal || {};
    const gateOnly = current.kind === 'desk_gate';
    ticket = {
      kind: gateOnly ? 'desk_gate' : 'prosecutor',
      desk_gate: gateOnly,
      latest: current === receipts[receipts.length - 1],
      receipt_id: current.receipt_id,
      ticket_id: current.ticket_id,
      saved_at: current.saved_at,
      status: statusOf(decision, invalidation),
      proposal_type: d.proposal_type,
      model_proposal_type: d.model_proposal_type,
      capped: d.gate ? d.gate.capped : null,
      gate_reasons: d.gate ? d.gate.reasons : [],
      gate_reason_kind: gateOnly && d.gate ? d.gate.reason_kind || null : null,
      gate_withheld: gateOnly && d.gate ? d.gate.withheld || null : null,
      non_consensus_thesis: pr.non_consensus_thesis || null,
      entry_zone: pr.entry_zone || null,
      upside_target: pr.upside_target || null,
      invalidation_trigger: pr.invalidation_trigger || null,
      trade_plan_geometry: gateOnly || !current.proposal ? null : (() => {
        let latest = null;
        try { latest = marketOf(ws, project); } catch (_) { latest = null; }
        return tradePlanGeometry(current.proposal, latest, { now, staleMinutes: (ws.settings && ws.settings.freshness && ws.settings.freshness.price_stale_minutes) || 90 });
      })(),
      near_invalidation: null,
      exit_basis: d.exit_basis || 'measured',
      // The size and limit this ticket froze: the card says them, never a fixed $500 and 5%.
      exit_size_usd: d.sizing && isNum(d.sizing.exit_size_usd) ? d.sizing.exit_size_usd : null,
      exit_limit_pct: d.sizing && isNum(d.sizing.max_exit_cost_pct) ? d.sizing.max_exit_cost_pct : null,
      exit_cost_500_usd_pct: d.exit_cost_500_usd_pct ?? null,
      exit_cost_500_complete: d.exit_cost_500_complete ?? null,
      exit_cost_2000_usd_pct: d.exit_cost_2000_usd_pct ?? null,
      exits_missing: d.exits_missing || [],
      // One quiet row on the card (observe mode: words only, nothing gated).
      contract_gate: d.contract_gate ? { mode: d.contract_gate.mode, tier: d.contract_gate.tier, words: d.contract_gate.words, economics: d.contract_gate.economics } : null,
      exit_evidence: gateOnly ? null : exitEvidenceOf(ws, current, now),
      trigger_breached_at_save: d.trigger_breached_at_save || null,
      admission: d.admission || null,
      integrity: gateOnly ? null : integrityOf(ws, current),
      rule_note: (newerRuleOf(current) || {}).words || null,
      can_reopen: (() => {
        if (gateOnly || current !== receipts[receipts.length - 1] || open || (decision && decision.action === 'reopen')) return null;
        return reopenReason(ws, project, current, { now });
      })(),
      suggested_risk_usd: d.suggested_risk_usd || 0,
      starter_risk_usd: d.sizing ? d.sizing.starter_risk_usd : SIZING_DEFAULTS.starter_risk_usd,
      pm_approved_risk_usd: decision ? decision.pm_approved_risk_usd : null,
      decision: decision ? { decision_id: decision.decision_id, action: decision.action, at: decision.decided_at, note: decision.note, archive: decision.archive || null, paper: paperStateOf(ws, decision), decided_by: decision.decided_by || null, mandate: decision.mandate || null, reopen: decision.reopen || null } : null,
      // Eric undid a paper mandate grant on this receipt: the mandate never grants it again.
      mandate_latched: (() => {
        const mine = decisions.filter((l) => l.receipt_id === current.receipt_id);
        const u = mine.filter((l) => l.action === 'undo').map((l) => mine.find((x) => x.decision_id === l.undoes)).find((x) => isMandateLine(x) && (x.action === 'approve' || x.action === 'halve'));
        return u ? { undone_decision_id: u.decision_id, action: u.action, tier: (u.mandate && u.mandate.tier) || null } : null;
      })(),
      prosecution: current.prosecution ? { verdict: current.prosecution.verdict, conviction_score: current.prosecution.conviction_score, fatal_flaws: current.prosecution.fatal_flaws, tests: current.prosecution.tests, strongest_bull_rebuttal: current.prosecution.strongest_bull_rebuttal || '' } : null,
      agent_disagreement: current.agent_disagreement || null,
      invalidation,
      researcher_report_id: current.researcher.report_id,
      researcher: { report_id: current.researcher.report_id, grade: gateGrade(current.researcher.grade), grade_display: current.researcher.grade ? current.researcher.grade.display : null, verdict: current.researcher.verdict },
      superseded_by_report: researcher && researcher.report_id !== current.researcher.report_id ? researcher.report_id : null,
      format_notes: current.validation ? current.validation.errors : [],
      report_delta: (() => { try { return require('./report-delta').reportDelta(ws, require('./reports').loadReports(ws, pid)); } catch (_) { return null; } })(),
    };
  }
  if (ticket) ticket.near_invalidation = nearInvalidation(ticket.status, ticket.trade_plan_geometry);
  const profile = readProfile(ws, pid);
  return {
    project_id: pid,
    pilot: Boolean(profile.pilot),
    ticket,
    open: open ? { ticket_id: open.ticket_id, state: open.job.state, created_at: open.created_at, report_id: open.basis.researcher.report_id } : null,
    history: receipts.map((r) => ({ receipt_id: r.receipt_id, ticket_id: r.ticket_id, saved_at: r.saved_at, proposal_type: r.desk && r.desk.proposal_type, decision: decisionFor(decisions, r.receipt_id) ? decisionFor(decisions, r.receipt_id).action : null })).reverse(),
    sizing: sizingOf(ws),
  };
}

// The read behind get_ticket and `tickets view`: the view (the latest receipt,
// or the named one) and, with includeText, that receipt's saved text, its pins
// checked as on GET .../tickets/receipts/<tr>/text (a mismatch is an INTEGRITY
// refusal). A desk-gate receipt has no text. Writes nothing.
function read(ws, pid, { receiptId = null, includeText = false, now = Date.now() } = {}) {
  if (receiptId !== null && !RECEIPT_RE.test(String(receiptId))) throw new OpError('BAD_ID', `"${receiptId}" is not a ticket receipt ID (tr_...).`);
  const out = view(ws, pid, { now, receiptId });
  if (includeText) {
    const rid = out.ticket ? out.ticket.receipt_id : null;
    if (!rid) out.text = null;
    else if (out.ticket.desk_gate) out.text = { receipt_id: rid, text: null, note: 'The desk\'s gate has no saved text: no Prosecutor ran.' };
    else out.text = receiptText(ws, pid, rid);
  }
  return out;
}

// The index row's ticket: what the inspector's PM Decision Card and the
// Review queue read. null when the project has no ticket and no pilot.
function summary(ws, pid, { now = Date.now(), fundamentals = null } = {}) {
  if (!fs.existsSync(ws.abs(dirOf(pid)))) return null;
  try {
    const v = view(ws, pid, { now, fundamentals });
    return { pilot: v.pilot, open: v.open, ...(v.ticket || { status: null }) };
  } catch (err) {
    return { unavailable: true, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// The autonomous pilot: Eric's opt-in per project, and the next step of each

// Turning the pilot on also approves the project's primary exit-quote target
// (forensics.js approvePrimaryExitQuote), after the enrollment is committed:
// its outcome is `exit_quote`, and a failure there never undoes the enrollment.
function setPilot(ws, pid, on, { by = null } = {}) {
  require('./projects').getProject(ws, pid);
  const out = runOp(ws, { type: 'ticket_pilot', summary: `${on ? 'Start' : 'Stop'} the autonomous pilot on ${pid}` }, (op) => {
    const cur = op.readJson(profileRel(pid), null) || readProfile(ws, pid);
    if (Boolean(cur.pilot) === Boolean(on)) return { noop: true, pilot: Boolean(on) };
    op.writeJson(profileRel(pid), { ...cur, pilot: Boolean(on), pilot_set_at: new Date().toISOString(), pilot_set_by: by || ws.actor || null });
    return { pilot: Boolean(on) };
  });
  const turnedOn = Boolean(on) && !(out.result && out.result.noop) && !out.noop;
  if (turnedOn) {
    try { out.exit_quote = require('./forensics').approvePrimaryExitQuote(ws, pid, { by: 'pilot enrollment' }); }
    catch (err) { out.exit_quote = { project_id: pid, status: 'failed', reason: String((err && err.message) || err).slice(0, 200) }; }
  }
  return out;
}

// What the chain needs next on one project: Agent 1 (Claude research), then
// Agent 2 (the Prosecutor's ticket), then Eric. Read-only.
function nextStep(ws, pid, { now = Date.now(), heldSet = undefined } = {}) {
  const research = require('./research');
  const project = require('./projects').getProject(ws, pid);
  const base = { project_id: pid, name: project.name, pilot: Boolean(readProfile(ws, pid).pilot) };
  // Eric's stop on the project (mandate-authority.js automationGate: a veto
  // or Undo of his, an archive, an explicit stop, or history that does not
  // read) blocks every step until he rearms it. The desk-wide pause is not a
  // step: its callers say "paused" beside the step it would be.
  const gate = require('./mandate-authority').automationGate(ws, pid, { project });
  if (gate.project_stopped) return { ...base, step: 'blocked', stopped: gate.code, why: gate.words };
  if (!project.identity || project.identity.status !== 'verified') return { ...base, step: 'blocked', why: 'The identity is not verified.' };
  const staleDays = (ws.settings.freshness && ws.settings.freshness.research_stale_days) || 90;
  const waitingRun = research.listRuns(ws, pid).filter((r) => !r.broken && r.jobs && r.jobs.claude && ['unconfigured', 'queued', 'dispatching', 'running', 'uncertain'].includes(r.jobs.claude.state)).pop();
  if (waitingRun) return { ...base, step: 'research', run_id: waitingRun.run_id, state: waitingRun.jobs.claude.state, why: `Claude's research run ${waitingRun.run_id} is open: finish it (Agent 1).` };
  const r = researcherOf(ws, pid);
  if (!r) return { ...base, step: 'research', run_id: null, why: 'No eligible Claude report: start Claude research (Agent 1).' };
  const ageDays = r.analysis_at ? (now - Date.parse(r.analysis_at)) / 86400000 : null;
  if (ageDays !== null && ageDays > staleDays) return { ...base, step: 'research', run_id: null, report_id: r.report_id, why: `Claude's report is ${Math.round(ageDays)} days old, past ${staleDays}: research again (Agent 1).` };
  const open = openTicket(ws, pid);
  const refused = open && open.job.last_refusal;
  if (refused) return { ...base, step: 'ticket_failed', ticket_id: open.ticket_id, state: open.job.state, report_id: open.basis.researcher.report_id, refused_field: refused.field || null, refused_at: refused.at, why: `Prosecutor: save refused${refused.field ? `, ${refused.field}` : ''}: ${refused.message} Run the Prosecutor again on ticket ${open.ticket_id} (start_ticket resumes it with its draft), then save_ticket.` };
  if (open) return { ...base, step: 'ticket', ticket_id: open.ticket_id, state: open.job.state, report_id: open.basis.researcher.report_id, why: `Ticket ${open.ticket_id} is open: write the Prosecutor's ticket (Agent 2).` };
  const v = view(ws, pid, { now });
  const sizing = sizingOf(ws);
  const enforce = sizing.version === SIZING_V5;
  if (v.ticket && v.ticket.status === 'reopened' && v.ticket.researcher_report_id === r.report_id) {
    // A re-opened ticket freezes a new packet, so it waits for the same
    // contract and exit evidence a first ticket waits for (OP-1, 2026-11-01:
    // a re-open taken while the exit quote was still out froze a packet with
    // no exit reading at any size). The old receipt is kept either way.
    const held = heldOf(ws, pid, now, heldSet);
    const cv = enforce && held === false ? contractVerdictNow(ws, project, sizing, now) : null;
    if (cv && (cv.tier === 'block' || cv.tier === 'hold')) return { ...base, step: 'contract_evidence', ticket_id: null, report_id: r.report_id, reopen: true, findings: cv.findings.filter((f) => f.tier === cv.tier), why: `Ticket ${v.ticket.receipt_id} was re-opened, but the contract gate ${cv.tier === 'block' ? 'blocks' : 'holds'} on ${project.name}: ${cv.words} No Prosecutor runs until the desk observes the contract with nothing ${cv.tier === 'block' ? 'blocking' : 'holding'} it (contracts observe).` };
    const wait = held === false ? exitWaitOf(ws, project, sizing, now) : null;
    if (wait) return { ...base, step: 'exit_evidence', ticket_id: null, report_id: r.report_id, reopen: true, exit: wait.exit, why: `Ticket ${v.ticket.receipt_id} was re-opened. ${wait.why}` };
    return { ...base, step: 'ticket', ticket_id: null, report_id: r.report_id, refresh: true, reopen: true, why: `${v.ticket.decision && typeof v.ticket.decision.decided_by === 'string' && v.ticket.decision.decided_by.startsWith('mandate:') ? 'The paper mandate' : 'Eric'} re-opened ticket ${v.ticket.receipt_id}: open a new one on Claude's current report ${r.report_id} (start_ticket with refresh: true). The old receipt is kept.` };
  }
  let onCurrent = Boolean(v.ticket && v.ticket.researcher_report_id === r.report_id);
  // A contract block's gate on this report no longer stands once the
  // contract's identity changed: the report gets its ticket.
  if (onCurrent && v.ticket.gate_reason_kind === 'contract_block' && !gateStands(readJson(ws.abs(receiptRel(pid, v.ticket.receipt_id)), null), enforce ? contractIdentityNow(ws, project, now) : null)) onCurrent = false;
  if (!onCurrent) {
    const held = heldOf(ws, pid, now, heldSet);
    const why = pregateReason(r, held, sizing);
    const kind = gradeReasonKind(r.grade);
    if (why) return { ...base, step: 'gate_closed', ticket_id: null, report_id: r.report_id, reasons: [why], reason_kind: kind, why: `The desk's gate is closed on Claude's current report ${r.report_id}${kind ? ` (${KIND_WORDS[kind]})` : ''}: ${why} No Prosecutor runs; call start_ticket (tickets start) to save the desk's receipt.` };
    const cv = enforce && held === false ? contractVerdictNow(ws, project, sizing, now) : null;
    if (cv && cv.tier === 'block') return { ...base, step: 'gate_closed', ticket_id: null, report_id: r.report_id, reasons: [cv.words], reason_kind: 'contract_block', why: `The desk's contract gate is closed on Claude's current report ${r.report_id}: ${cv.words} No Prosecutor runs; call start_ticket (tickets start) to save the desk's receipt.` };
    if (cv && cv.tier === 'hold') return { ...base, step: 'contract_evidence', ticket_id: null, report_id: r.report_id, findings: cv.findings.filter((f) => f.tier === 'hold'), why: `The contract gate holds on ${project.name}: ${cv.words} No Prosecutor runs and no receipt is written until the desk observes the contract with nothing holding it (contracts observe).` };
    const wait = held === false ? exitWaitOf(ws, project, sizing, now) : null;
    if (wait) return { ...base, step: 'exit_evidence', ticket_id: null, report_id: r.report_id, exit: wait.exit, why: wait.why };
    return { ...base, step: 'ticket', ticket_id: null, report_id: r.report_id, why: `No ticket on Claude's current report ${r.report_id}: open one (Agent 2).` };
  }
  if (v.ticket.status === 'pending_pm_review') return { ...base, step: 'pm_review', receipt_id: v.ticket.receipt_id, why: 'The ticket waits for Eric\'s PM review. Nothing for an agent to do.' };
  if (v.ticket.status === 'invalidated') return { ...base, step: 'done', receipt_id: v.ticket.receipt_id, status: v.ticket.status, why: 'Invalidated: Re-open ticket on the card (or tickets start --reopen). Nothing for an agent to do until then.' };
  return { ...base, step: 'done', receipt_id: v.ticket.receipt_id, status: v.ticket.status, why: `The ticket is ${v.ticket.status.replace(/_/g, ' ')}. Nothing for an agent to do until Claude's report changes.` };
}

// ---------------------------------------------------------------------------
// The paper mandate's sweep (autonomous paper playbook, Stage 7): on each
// trader tick, under one lease, it re-opens a pilot ticket an exit reading
// arrived for (Phase A) and grants each pilot ticket that meets R2 to R5
// (Phase B), the highest grade first, under the day's and the open caps. One
// project's failure is listed in skipped and never stops the sweep. Grants go
// through decide() like any decision; its own lock checks the mandate, the
// zero history and the tier again.
const MANDATE_LEASE = 'paper-mandate';
const MANDATE_LEASE_MS = 10 * 60000;

// R4's contract evidence for a mandate grant (a live Pillar 1 observation):
// the ticket's packet carried an attestation, the verdict now reads and is
// neither block nor hold, and the identity has not changed nor the sell tax
// spiked since the save. Null when it holds, else the words. Reads only; the
// lookups go through this module's exports, as the trader's re-check does.
function mandateContractEvidence(ws, project, receipt, sizing, now) {
  const self = module.exports;
  if (!receipt.desk || !receipt.desk.contract_gate) return 'The ticket\'s packet carried no contract attestation.';
  const v = self.contractVerdictNow(ws, project, sizing, now);
  if (!v) return 'The contract has no observation the desk can read now.';
  if (v.tier === 'block' || v.tier === 'hold') return `The contract gate ${v.tier === 'block' ? 'blocks' : 'holds'}: ${v.words}`;
  const chk = self.contractCheckOf(ws, project, receipt, now);
  if (chk && chk.status === 'triggered') return chk.words;
  return null;
}

// Whether a receipt meets R2 to R5 for a grant now: { ok: true, tier, grade,
// pair } or { ok: false, rule, words }. Reads only.
function mandateEligible(ws, project, receipt, ctx) {
  const no = (rule, words) => ({ ok: false, rule, words });
  const desk = receipt.desk || {};
  const g = desk.gate || {};
  // R2, the receipt.
  if (receipt.kind === 'desk_gate') return no('R2', 'The latest receipt is the desk\'s gate, not a Prosecutor\'s ticket.');
  if (newerRuleOf(receipt)) return no('R2', 'The ticket was sized under rules newer than this code reads.');
  if (g.risk_allowed !== true || !(desk.suggested_risk_usd > 0) || !RISK_TAKING.has(desk.proposal_type)) return no('R2', `The ticket proposes ${desk.proposal_type || 'nothing'} with ${usd(desk.suggested_risk_usd || 0)} of risk: nothing to grant.`);
  const grade = gateGrade(receipt.researcher && receipt.researcher.grade);
  const tier = mandateTierOf(grade);
  if (!tier) return no('R2', `Agent 1's grade is ${grade === null ? 'withheld or none' : grade}, under the paper mandate's floor of ${MANDATE_MIN_GRADE}.`);
  const ph = require('./mandate-authority').prosecutionHoldOf(ws, receipt);
  if (ph) return no('R2', ph.words);
  const inv = invalidationOf(ws, project, receipt, { now: ctx.now });
  if (inv.unread || inv.invalidated) return no('R2', `The ticket is ${inv.invalidated ? 'invalidated' : 'not readable for invalidation'}: ${inv.words || 'no words'}`);
  // R3, zero history.
  if (ctx.lines.some((l) => l.receipt_id === receipt.receipt_id)) return no('R3', 'This ticket already has a decision on record, so the paper mandate never grants it.');
  // R4, evidence.
  if (project.identity && project.identity.native_chain === true) return no('R4', 'A native L1 coin stays Eric\'s own decision: the paper mandate never grants it.');
  if (g.exit_basis === 'native_l1_liquid') return no('R4', 'The ticket was sized on a native L1\'s liquidity, not a measured exit: Eric decides it.');
  const ev = exitEvidenceOf(ws, receipt, ctx.now);
  if (!ev || ev.state !== 'current') return no('R4', ev ? ev.words : 'The ticket has no exit evidence.');
  const limit = Number(desk.sizing && desk.sizing.max_exit_cost_pct);
  if (g.exit_cost_complete !== true || !isNum(g.exit_cost_pct) || !(g.exit_cost_pct <= limit)) return no('R4', `The gate's exit cost is ${isNum(g.exit_cost_pct) ? `${g.exit_cost_complete ? '' : 'at least '}${g.exit_cost_pct}%` : 'unknown'}, not proven within ${limit}%.`);
  const { chainInfo } = require('./chains');
  const subject = require('./contract-forensics').subjectsOf(project)[0] || null;
  if (!subject) return no('R4', 'The token has no contract the desk reads, so it has no exit chain.');
  const allowed = new Set((ctx.mandate.allowed_chains || []).map((c) => (chainInfo(c) || {}).chain_id).filter(Boolean));
  if (!allowed.has(subject.chain_id)) return no('R4', `The exit chain (${subject.label}) is not among the paper mandate's chains.`);
  const cw = module.exports.mandateContractEvidence(ws, project, receipt, ctx.sizing, ctx.now);
  if (cw) return no('R4', cw);
  // R5, the pair.
  const pr = require('./trader-desk').pairOf(project, ctx.projects, { sources: ctx.sources });
  if (!pr.pair) return no('R5', pr.why);
  return { ok: true, tier, grade, pair: pr.pair };
}

function mandateSweep(ws, { now = Date.now() } = {}) {
  const m = mandateOf(ws, now);
  const base = { version: MANDATE_VERSION, granted: [], reopened: [], skipped: [] };
  if (!m.on) return { ...base, status: 'skipped', why: m.why, message: m.why };
  const leases = require('./leases');
  const token = leases.acquireLease(ws, MANDATE_LEASE, MANDATE_LEASE_MS, { label: 'paper mandate sweep' });
  if (!token) return { ...base, status: 'busy', why: 'Another paper mandate sweep is running.', message: 'Another paper mandate sweep is running.' };
  try {
    const out = { ...base, status: 'ok', mandate: { expires_at: m.expires_at, max_grants_per_day: m.max_grants_per_day, max_open_grants: m.max_open_grants }, grants_today: 0, open_grants: 0, why: null };
    const MA = require('./mandate-authority');
    const projects = require('./projects').listProjects(ws).filter((p) => !p.broken);
    // Strict history: a project whose decisions do not read is skipped, and
    // the caps, which read every project, are then unknown (fail closed).
    const unreadable = new Map();
    const linesOf = new Map(projects.map((p) => {
      try { return [p.project_id, MA.readDecisionsStrict(ws, p.project_id)]; } catch (err) { unreadable.set(p.project_id, err.message); return [p.project_id, null]; }
    }));
    // The caps: grants today, and every grant not yet finished (waiting,
    // blocked for a reason that may pass, an order, a position, closing).
    let openKnown = true;
    try {
      const cap = MA.mandateCapacity(ws, { now, projects });
      out.grants_today = cap.grants_today;
      out.open_grants = cap.open_grants;
    } catch (err) {
      openKnown = false;
      out.why = `The paper mandate's caps could not be counted (${String(err && err.message || err).slice(0, 160)}), so it grants nothing this time.`;
    }
    let sources = null;
    try { sources = require('./trader-desk').sourceBindings(ws); } catch (_) { sources = Object.assign(new Map(), { unreadable: true }); }
    const ctx = { now, mandate: m, sizing: sizingOf(ws), projects, sources, lines: [] };
    const candidates = [];
    for (const p of projects) {
      if (!readProfile(ws, p.project_id).pilot) continue;
      const pid = p.project_id;
      const skip = (receiptId, rule, words) => out.skipped.push({ project_id: pid, receipt_id: receiptId, rule, words: String(words || '').slice(0, 300) });
      try {
        if (unreadable.has(pid)) { skip(null, 'R0', unreadable.get(pid)); continue; }
        const lines = linesOf.get(pid) || [];
        // The desk's one gate (an archive is one of Eric's stops): stopped
        // until he rearms (mandate-authority.js automationGate).
        const gate = MA.automationGate(ws, pid, { project: p, decisions: lines });
        if (!gate.ok) { skip(null, 'R0', gate.words); continue; }
        if (!p.identity || p.identity.status !== 'verified') { skip(null, 'R1', 'The project has no verified token binding.'); continue; }
        const latest = listReceipts(ws, pid).filter((x) => !x.broken).pop();
        if (!latest) { skip(null, 'R2', 'The project has no ticket yet.'); continue; }
        const inForce = decisionFor(lines, latest.receipt_id);
        // A ticket Eric decided (veto, pass, watch, any line of his) is his:
        // never re-opened, never granted.
        if (lines.some((l) => l.receipt_id === latest.receipt_id && !isMandateLine(l))) { skip(latest.receipt_id, 'R3', 'Eric decided this ticket; the paper mandate never re-opens or grants it.'); continue; }
        // Phase A: a re-open when an exit reading arrived after the ticket
        // froze none, once per Claude report.
        if (inForce && inForce.action === 'reopen') { skip(latest.receipt_id, 'R3', 'The ticket is re-opened and waits for Agent 2\'s new ticket.'); continue; }
        const arrived = exitArrivedOf(ws, p, latest, now);
        if (arrived) {
          const reportOf = new Map(listReceipts(ws, pid).filter((x) => !x.broken).map((x) => [x.receipt_id, x.researcher ? x.researcher.report_id : null]));
          const was = latest.researcher ? latest.researcher.report_id : null;
          if (lines.some((l) => l.action === 'reopen' && isMandateLine(l) && reportOf.get(l.receipt_id) === was)) { skip(latest.receipt_id, 'R3', `The paper mandate already re-opened a ticket on Claude's report ${was}.`); continue; }
          const r = decide(ws, pid, { receipt_id: latest.receipt_id, action: 'reopen', request_id: `mandate_r_${latest.receipt_id}`, note: `Paper mandate: ${arrived.why}`, mandate: { version: MANDATE_VERSION } });
          if (r.result && r.result.status === 'saved') out.reopened.push({ project_id: pid, receipt_id: latest.receipt_id, decision_id: r.result.decision.decision_id, why: arrived.why });
          continue;
        }
        // Phase B: a grant.
        const e = mandateEligible(ws, p, latest, { ...ctx, lines });
        if (!e.ok) { skip(latest.receipt_id, e.rule, e.words); continue; }
        candidates.push({ project: p, receipt: latest, ...e });
      } catch (err) {
        skip(null, err && err.code ? err.code : 'ERROR', String(err && err.message || err));
      }
    }
    candidates.sort((a, b) => b.grade - a.grade || String(a.receipt.saved_at || '').localeCompare(String(b.receipt.saved_at || '')));
    for (const c of candidates) {
      const pid = c.project.project_id;
      const rid = c.receipt.receipt_id;
      const skip = (rule, words) => out.skipped.push({ project_id: pid, receipt_id: rid, rule, words: String(words || '').slice(0, 300) });
      if (!openKnown) { skip('R5', out.why); continue; }
      if (out.grants_today >= m.max_grants_per_day) { skip('R5', `The paper mandate's ${m.max_grants_per_day} grant${m.max_grants_per_day === 1 ? '' : 's'} for today (New York) are made.`); continue; }
      if (out.open_grants >= m.max_open_grants) { skip('R5', `The paper mandate holds ${out.open_grants} open grant${out.open_grants === 1 ? '' : 's'}, its limit.`); continue; }
      try {
        const r = decide(ws, pid, { receipt_id: rid, action: c.tier.action, request_id: `mandate_${rid}`, note: `Paper mandate, ${c.tier.name}, grade ${c.grade}.`, mandate: { version: MANDATE_VERSION, tier: c.tier.name, grade_used: c.grade } });
        if (r.result && r.result.status === 'saved') {
          out.grants_today += 1;
          out.open_grants += 1;
          const d = r.result.decision;
          out.granted.push({ project_id: pid, receipt_id: rid, decision_id: d.decision_id, action: d.action, tier: c.tier.name, grade: c.grade, risk_usd: d.pm_approved_risk_usd, pair: c.pair, trader: r.result.trader ? r.result.trader.status || null : null });
        } else skip('R3', 'decide() replayed an earlier decision; nothing new was granted.');
      } catch (err) {
        skip(err && err.details && err.details.reason ? err.details.reason : err && err.code ? err.code : 'ERROR', String(err && err.message || err));
      }
    }
    out.message = `Paper mandate: ${out.granted.length} granted, ${out.reopened.length} re-opened, ${out.skipped.length} skipped (${out.grants_today} of ${m.max_grants_per_day} today, ${out.open_grants} of ${m.max_open_grants} open).`;
    return out;
  } finally {
    leases.releaseLease(ws, MANDATE_LEASE, token);
  }
}

// Whether the paper mandate has work a sweep could do: it is on, and a pilot
// project's latest Prosecutor's ticket has no decision yet (a grant, or a
// re-open when an exit reading arrives). Read only and bounded (one profile,
// the receipts' list and the decisions per project); the trader job is due
// on it, so a cold desk runs its first sweep (corrective PR, defect A).
function mandateDue(ws, now = Date.now()) {
  if (!mandateOf(ws, now).on) return false;
  const MA = require('./mandate-authority');
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || !readProfile(ws, p.project_id).pilot) continue;
    const latest = listReceipts(ws, p.project_id).filter((x) => !x.broken).pop();
    if (!latest || latest.kind === 'desk_gate') continue;
    let lines;
    try { lines = MA.readDecisionsStrict(ws, p.project_id); } catch (_) { continue; }
    if (!MA.automationGate(ws, p.project_id, { project: p, decisions: lines }).ok) continue;
    if (!lines.some((l) => l.receipt_id === latest.receipt_id)) return true;
  }
  return false;
}

function pilotQueue(ws, { project = null, now = Date.now() } = {}) {
  const list = require('./projects').listProjects(ws).filter((p) => !p.broken && (project ? p.project_id === project : readProfile(ws, p.project_id).pilot));
  return list.map((p) => nextStep(ws, p.project_id, { now }));
}

// Who could go in the pilot, read-only. Held projects first, then verified,
// active projects by the desk's calculated grade of Claude's current eligible
// report (a range by its low end; withheld and no report last). Each row gives
// the gate's result today with no proposal, whether an exit reading exists at
// the sizing's exit size, the report's age and prompt version, and whether the
// project is already in the pilot. Writes nothing and opts nothing in.
// The portfolio is read once per call (at the first project that needs it, or
// handed in as `heldSet`), not once per project. `pilotOnly` leaves out every
// project not opted in, reading only its profile.json, for a caller that wants
// the pilot's rows alone; the rows it returns are the same ones.
function pilotCandidates(ws, { now = Date.now(), heldSet = undefined, pilotOnly = false } = {}) {
  const sizing = sizingOf(ws);
  const rows = [];
  let holdings = heldSet;
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    if (pilotOnly && !readProfile(ws, p.project_id).pilot) continue;
    const project = require('./projects').getProject(ws, p.project_id);
    if (!project.identity || project.identity.status !== 'verified') continue;
    const pid = p.project_id;
    const researcher = researcherOf(ws, pid);
    if (holdings === undefined) holdings = heldSetOf(ws, now);
    const held = heldOf(ws, pid, now, holdings) === true;
    const exits = exitsOf(ws, pid, [sizing.exit_size_usd], now);
    const market = marketOf(ws, project);
    const basis = {
      researcher: researcher || { grade: null },
      held,
      exits,
      market,
      native: { native_chain: project.identity.native_chain === true, market_cap_usd: isNum(market.market_cap_usd) ? market.market_cap_usd : null },
    };
    const g = gate(basis, sizing);
    const grade = researcher ? gateGrade(researcher.grade) : null;
    let promptVersion = null;
    if (researcher) {
      try {
        const r = require('./compare').latestByProvider(require('./reports').loadReports(ws, pid)).claude;
        promptVersion = (r && r.assessment && r.assessment.prompt_version) || null;
      } catch (_) { /* left unknown */ }
    }
    const ageDays = researcher && researcher.analysis_at && Number.isFinite(Date.parse(researcher.analysis_at)) ? round((now - Date.parse(researcher.analysis_at)) / 86400000, 1) : null;
    const native = g.exit_basis === 'native_l1_liquid';
    rows.push({
      project_id: pid,
      name: project.name,
      held,
      grade,
      grade_display: researcher && researcher.grade ? researcher.grade.display || researcher.grade.status : null,
      report_id: researcher ? researcher.report_id : null,
      report_age_days: ageDays,
      report_prompt_version: promptVersion,
      gate: { risk_allowed: g.risk_allowed, allowed_types: g.allowed_types, suggested_risk_usd: g.suggested_risk_usd, exit_basis: g.exit_basis, reasons: g.reasons },
      exit_reading: { size_usd: sizing.exit_size_usd, present: native ? null : Boolean(exits[0] && isNum(exits[0].cost_pct)), cost_pct: exits[0] ? exits[0].cost_pct : null, note: native ? 'Native L1: no DEX quote is needed.' : exits[0] ? exits[0].note || null : null },
      in_pilot: Boolean(readProfile(ws, pid).pilot),
    });
  }
  const rank = (r) => (r.grade === null ? -Infinity : r.grade);
  rows.sort((a, b) => (a.held === b.held ? 0 : a.held ? -1 : 1) || (rank(b) === rank(a) ? 0 : rank(b) > rank(a) ? 1 : -1) || a.project_id.localeCompare(b.project_id));
  return rows;
}

// Item 54: the Track 2 pilot queue as a board. Each candidate row (the read
// above) with the pipeline step the chain needs next, the change since Claude's
// earlier report (@5 to @6) and whether the exit readings at each size are
// in. Read-only: it writes nothing and asks no provider. A native L1 coin
// needs no DEX quote (ready: null); a step that cannot be read says so.
function candidateBoard(ws, { now = Date.now() } = {}) {
  const sizing = sizingOf(ws);
  const sizes = exitSizesOf(sizing);
  const heldSet = heldSetOf(ws, now);
  return pilotCandidates(ws, { now, heldSet }).map((c) => {
    let step = { step: 'unknown', why: 'The next step could not be read.' };
    try { step = nextStep(ws, c.project_id, { now, heldSet }); } catch (err) { step = { step: 'unknown', why: `The next step could not be read: ${err.message}` }; }
    let delta = null;
    try { delta = require('./report-delta').reportDelta(ws, require('./reports').loadReports(ws, c.project_id)); } catch (_) { delta = null; }
    const native = c.gate && c.gate.exit_basis === 'native_l1_liquid';
    const exits = exitsOf(ws, c.project_id, sizes, now).map((e) => ({ size_usd: e.size_usd, ready: native ? null : isNum(e.cost_pct), cost_pct: e.cost_pct, cost_complete: e.cost_complete, note: native ? 'Native L1: no DEX quote is needed.' : e.note }));
    return { ...c, step: step.step, step_why: step.why || null, report_delta: delta, exits };
  });
}

// Item 61: the watchlist's exit-liquidity matrix. Every verified, active
// project, best grade first (a range by its low end; no grade last), with the
// desk's exit cost at each size, whether each cost is complete and the
// components missing, the chain, the quote's age and the native L1 status.
// Read only: it asks no provider and writes nothing. A missing reading is
// null with its reason, never 0. @2 (D4): the sizes are the screening ladder
// and exit position ($100, $500, $2,000 by default), no longer a fixed $500
// and $2,000.
const EXIT_MATRIX_FORMAT = 'cr-exit-matrix@2';
function exitMatrix(ws, { now = Date.now() } = {}) {
  const sizing = sizingOf(ws);
  const sizes = exitSizesOf(sizing);
  const rows = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    const project = require('./projects').getProject(ws, p.project_id);
    if (!project.identity || project.identity.status !== 'verified') continue;
    const pid = p.project_id;
    let researcher = null;
    try { researcher = researcherOf(ws, pid); } catch (_) { researcher = null; }
    const market = marketOf(ws, project);
    const native = nativeL1Liquid({ native: { native_chain: project.identity.native_chain === true, market_cap_usd: isNum(market.market_cap_usd) ? market.market_cap_usd : null } }, sizing);
    const chains = [...new Set((project.identity.assets || []).map((a) => a.chain).filter(Boolean))].sort();
    const exits = exitsOf(ws, pid, sizes, now).map((e) => {
      const at = Date.parse(e.as_of);
      return {
        size_usd: e.size_usd,
        cost_pct: e.cost_pct,
        complete: isNum(e.cost_pct) ? e.cost_complete !== false : null,
        missing_costs: isNum(e.cost_pct) ? e.missing_costs || [] : [],
        quote_age_minutes: Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60000)) : null,
        as_of: e.as_of || null,
        status: e.status,
        note: e.note || null,
      };
    });
    rows.push({
      project_id: pid,
      name: project.name,
      grade: researcher ? gateGrade(researcher.grade) : null,
      grade_display: researcher && researcher.grade ? researcher.grade.display || researcher.grade.status : null,
      chain: native ? (project.identity.native_chain_name || chains[0] || null) : chains.join(', ') || null,
      native_l1_liquid: native,
      exits,
    });
  }
  const rank = (r) => (r.grade === null ? -Infinity : r.grade);
  rows.sort((a, b) => (rank(b) === rank(a) ? 0 : rank(b) > rank(a) ? 1 : -1) || a.project_id.localeCompare(b.project_id));
  return { format: EXIT_MATRIX_FORMAT, writes_nothing: true, as_of: iso(now), sizes_usd: sizes, rows };
}

// Backlog item 30. Opt in (pilot: true) every verified, active project whose
// Claude current eligible report is a cr-research-prompt@6 run with a grade of
// `min` or more (a range by its low end), so qualifying candidates enter the
// pilot queue as the surge finishes reports. Withheld or no grade, no report,
// an older prompt, an archived or unverified project is skipped and named.
// Projects already in the pilot are unchanged; nothing is ever opted out.
// `dryRun` writes nothing.
const AUTO_PILOT_MIN = 45;
const AUTO_PILOT_PROMPT = 'cr-research-prompt@6';

function autoPilotSync(ws, { min = null, dryRun = false } = {}) {
  const floor = min === null || min === undefined ? AUTO_PILOT_MIN : min;
  if (!isNum(floor) || floor < 0 || floor > 100) throw new OpError('INVALID', '--min is a number from 0 to 100.');
  const projects = require('./projects');
  const out = { min: floor, prompt_version: AUTO_PILOT_PROMPT, dry_run: dryRun === true, opted_in: [], unchanged: [], skipped: [] };
  const todo = [];
  for (const p of projects.listProjects(ws)) {
    if (p.broken) continue;
    const skip = (reason) => out.skipped.push({ project_id: p.project_id, name: p.name || p.project_id, reason });
    if (p.status === 'archived') { skip('Archived.'); continue; }
    const project = projects.getProject(ws, p.project_id);
    if (!project.identity || project.identity.status !== 'verified') { skip('Identity not verified.'); continue; }
    const pid = p.project_id;
    const researcher = researcherOf(ws, pid);
    if (!researcher) { skip('No eligible Claude report.'); continue; }
    let version = null;
    try {
      const r = require('./compare').latestByProvider(require('./reports').loadReports(ws, pid)).claude;
      version = (r && r.assessment && r.assessment.prompt_version) || null;
    } catch (_) { /* left unknown */ }
    if (version !== AUTO_PILOT_PROMPT) { skip(`Claude's current report was made under ${version || 'an unknown prompt'}, not ${AUTO_PILOT_PROMPT}.`); continue; }
    const grade = gateGrade(researcher.grade);
    if (grade === null) { skip(`Grade withheld or none (${(researcher.grade && researcher.grade.display) || 'no grade'}).`); continue; }
    if (grade < floor) { skip(`Grade ${grade} is under ${floor}.`); continue; }
    if (readProfile(ws, pid).pilot) { out.unchanged.push({ project_id: pid, name: project.name, grade, reason: 'Already in the pilot.' }); continue; }
    todo.push({ pid, project, grade });
  }
  for (const { pid, project, grade } of todo) {
    if (!dryRun) setPilot(ws, pid, true, { by: 'auto-pilot-sync' });
    out.opted_in.push({ project_id: pid, name: project.name, grade, reason: dryRun ? 'Would be opted in.' : 'Opted in.' });
  }
  return out;
}

// Eric's filter for the batch gate: a grade under 40 (his choice), never
// above the sizing's new-entry floor (above it the pre-gate would not close).
const BATCH_GATE_BELOW = 40;

function batchGateBelow(ws, below) {
  const cap = sizingOf(ws).min_grade_new_entry;
  if (below === null || below === undefined) return Math.min(BATCH_GATE_BELOW, cap);
  if (!isNum(below) || below < 0) throw new OpError('INVALID', '--below must be a number of 0 or more.');
  if (below > cap) throw new OpError('INVALID', `--below ${below} is above the new-entry floor (${cap}): the batch gate may lower Eric's filter, never raise it past the floor.`);
  return below;
}

// Every active, verified project Eric does not hold whose Claude current
// eligible report grades under `below` goes through createTicket, so each gets
// the pre-gate's desk receipt. No exit quote is asked for, no prompt is
// rendered and no model is called. `dryRun` writes nothing. Each project is
// said as made, unchanged or skipped with its reason.
function batchGate(ws, { below = null, dryRun = false, now = Date.now() } = {}) {
  const limit = batchGateBelow(ws, below);
  const projects = require('./projects');
  const out = { below: limit, dry_run: dryRun === true, made: [], unchanged: [], skipped: [] };
  const skip = (p, reason) => out.skipped.push({ project_id: p.project_id, name: p.name || p.project_id, reason });
  const todo = [];
  for (const p of projects.listProjects(ws)) {
    if (p.broken) continue;
    if (p.status === 'archived') { skip(p, 'Archived.'); continue; }
    const project = projects.getProject(ws, p.project_id);
    if (!project.identity || project.identity.status !== 'verified') { skip(project, 'Identity not verified.'); continue; }
    const pid = p.project_id;
    const researcher = researcherOf(ws, pid);
    if (!researcher) { skip(project, 'No eligible Claude report.'); continue; }
    const grade = gateGrade(researcher.grade);
    if (grade === null) { skip(project, `Grade withheld or none (${(researcher.grade && researcher.grade.display) || 'no grade'}): the grade alone decides nothing.`); continue; }
    if (grade >= limit) { skip(project, `Grade ${grade} is not under ${limit}.`); continue; }
    const held = heldOf(ws, pid, now);
    if (held === true) { skip(project, 'Held: a held position gets a Prosecutor.'); continue; }
    if (held === null) { skip(project, 'Holdings unreadable, so "not held" is not known.'); continue; }
    if (openTicket(ws, pid)) { skip(project, 'A Prosecutor ticket is open.'); continue; }
    const receipts = listReceipts(ws, pid).filter((r) => !r.broken && r.researcher && r.researcher.report_id === researcher.report_id);
    const gateReceipt = receipts.find((r) => r.kind === 'desk_gate');
    if (gateReceipt) { out.unchanged.push({ project_id: pid, name: project.name, receipt_id: gateReceipt.receipt_id, reason: `The desk's gate already answers ${researcher.report_id}.` }); continue; }
    if (receipts.length) { skip(project, `A ticket (${receipts[receipts.length - 1].receipt_id}) already answers ${researcher.report_id}.`); continue; }
    todo.push({ pid, project, grade });
  }
  for (const { pid, project, grade } of todo) {
    if (dryRun) { out.made.push({ project_id: pid, name: project.name, grade, receipt_id: null, reason: 'Would get a desk gate receipt.' }); continue; }
    try {
      const r = createTicket(ws, { project_id: pid, channel: 'batch-gate' });
      if (r.status === 'gate_closed') out.made.push({ project_id: pid, name: project.name, grade, receipt_id: r.receipt_id, reason: r.receipt.desk.gate.reasons[0] || null });
      else if (r.status === 'unchanged') out.unchanged.push({ project_id: pid, name: project.name, receipt_id: r.receipt_id, reason: 'The desk\'s gate already answers this report.' });
      else skip(project, r.message || `Not gated (${r.status}).`);
    } catch (e) {
      skip(project, e.message);
    }
  }
  return out;
}

// Desk-gate cards waiting for Eric (item 70): the latest receipt of an active
// project is the desk's gate (no Prosecutor ran), still undecided and on
// Claude's current report. Read-only.
function waitingDeskGates(ws, { now = Date.now() } = {}) {
  const projects = require('./projects');
  const out = [];
  for (const p of projects.listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    let t = null;
    try { t = view(ws, p.project_id, { now }).ticket; } catch (_) { continue; }
    if (!t || !t.desk_gate || !t.latest || t.status !== 'pending_pm_review' || t.superseded_by_report) continue;
    out.push({ project_id: p.project_id, name: p.name || p.project_id, receipt_id: t.receipt_id, saved_at: t.saved_at, report_id: t.researcher_report_id });
  }
  return out.sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at)) || a.project_id.localeCompare(b.project_id));
}

// Decide desk gates together (item 70): `pass` or `watch` only, each through
// the existing `decide` with its own journal line, effects and Undo; no new
// decision kind. `receipt_ids` limits the set (default: every one waiting). A
// dry run writes nothing and says which unheld projects a pass would archive
// (a held one never archives). A failure part-way leaves the decisions before
// it standing and names the rest; the same `request_id` completes them, each
// receipt deriving its own request ID.
function decideDeskGates(ws, { action, receipt_ids: receiptIds = null, request_id: requestId = null, note = null, dryRun = false, by = null, now = Date.now() } = {}) {
  if (action === 'approve' || action === 'halve') throw new OpError('REFUSED', `A desk gate suggests no risk: ${action} does not apply. Pass or watch.`);
  if (action !== 'pass' && action !== 'watch') throw new OpError('INVALID', 'Decide the desk gates with pass or watch.');
  let waiting = waitingDeskGates(ws, { now });
  const out = { action, dry_run: dryRun === true, decided: [], skipped: [], failed: null, remaining: [] };
  if (Array.isArray(receiptIds)) {
    const want = new Set(receiptIds.map(String));
    for (const id of want) if (!waiting.some((w) => w.receipt_id === id)) out.skipped.push({ receipt_id: id, reason: 'Not a desk gate waiting for you on Claude\'s current report.' });
    waiting = waiting.filter((w) => want.has(w.receipt_id));
  }
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  if (dryRun) {
    out.decided = waiting.map((w) => {
      const held = action === 'pass' ? heldOf(ws, w.project_id, now) : null;
      return { ...w, held, would_archive: action === 'pass' && held !== true, decision: null };
    });
    return out;
  }
  for (let i = 0; i < waiting.length; i += 1) {
    const w = waiting[i];
    try {
      const r = decide(ws, w.project_id, { receipt_id: w.receipt_id, action, note, by, request_id: reqId ? `dg_${sha256(`${reqId}:${w.receipt_id}`).slice(0, 24)}` : null });
      const res = r.result || {};
      out.decided.push({ ...w, status: res.status || null, decision_id: res.decision ? res.decision.decision_id : null, archived: res.project_archived === true, effects: { archive: res.archive || null, journal: res.journal || null } });
    } catch (e) {
      out.failed = { ...w, error: e.message, code: e.code || null };
      out.remaining = waiting.slice(i + 1).map((x) => ({ project_id: x.project_id, name: x.name, receipt_id: x.receipt_id }));
      break;
    }
  }
  return out;
}

// Exit quotes for pilot candidates (backlog item 25). Each candidate graded
// QUOTE_MIN_GRADE or over with no current reading at the sizing's exit sizes
// (the screening ladder and exit position) is quoted at each through prepareExitQuote's path
// (forensic-monitor.js quoteSizeUsd: the approved chain, the adapter, budget,
// gates, hold, never a wallet or swap), so the gate reads them as it does
// before a ticket. A native coin needs no DEX quote; a project with no
// approved chain is named, never approved here; a refusal (a 429, the budget)
// stops that source for the pass. `dryRun` sends nothing.
const QUOTE_MIN_GRADE = 40;

async function quoteCandidates(ws, { limit = 15, dryRun = false, fetchImpl, cgGetImpl, sleep, now = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new OpError('INVALID', '--limit is a whole number from 1 to 200.');
  const FM = require('./forensic-monitor');
  const sizing = sizingOf(ws);
  const sizes = exitSizesOf(sizing);
  const out = { dry_run: dryRun === true, sizes, limit, quoted: [], current: [], skipped: [], stopped: [] };
  const stopped = new Set();
  let budgetStop = null;
  let asked = 0;
  for (const row of pilotCandidates(ws, { now })) {
    const item = (extra) => ({ project_id: row.project_id, name: row.name, ...extra });
    if (row.grade === null || row.grade < QUOTE_MIN_GRADE) { out.skipped.push(item({ reason: row.grade === null ? 'No firm grade.' : `Grade ${row.grade} is under ${QUOTE_MIN_GRADE}: the desk gate decides it, no quote needed.` })); continue; }
    if (row.gate.exit_basis === 'native_l1_liquid') { out.skipped.push(item({ reason: 'Native L1: no DEX quote is needed.' })); continue; }
    const missing = exitsOf(ws, row.project_id, sizes, now).filter((x) => x.status === 'unavailable' || x.cost_pct === null).map((x) => x.size_usd);
    if (!missing.length) { out.current.push(item({ reason: `Current readings at ${sizes.map(usd).join(' and ')}.` })); continue; }
    const targets = require('./forensics').readProfile(ws, row.project_id).targets.exit_quotes || [];
    if (!targets.length) { out.skipped.push(item({ reason: 'Needs a chain approved (Forensics > Exits).' })); continue; }
    if (budgetStop) { out.skipped.push(item({ reason: budgetStop })); continue; }
    if (targets.every((t) => stopped.has(t.provider))) { out.skipped.push(item({ reason: `${[...new Set(targets.map((t) => t.provider))].join(', ')} is stopped for this pass.` })); continue; }
    if (asked >= limit) { out.skipped.push(item({ reason: `Over this pass's limit of ${limit} projects.` })); continue; }
    asked += 1;
    if (dryRun) { out.quoted.push(item({ sizes: missing.map((z) => ({ size_usd: z, status: 'would_ask' })) })); continue; }
    const results = [];
    for (const z of missing) {
      const r = await FM.quoteSizeUsd(ws, row.project_id, { size_usd: z, fetchImpl, cgGetImpl, sleep, now });
      results.push({ size_usd: z, status: r.status, reason: r.reason || null });
      if (r.status === 'refused') {
        if (/budget/i.test(r.reason || '')) budgetStop = r.reason;
        else for (const t of targets) { if (!stopped.has(t.provider)) out.stopped.push({ source: t.provider, reason: r.reason }); stopped.add(t.provider); }
        break;
      }
    }
    out.quoted.push(item({ sizes: results }));
  }
  return out;
}
// `tickets run-cycle` (item 51): the Track 2 pipeline in one deterministic pass,
// in this order: autoPilotSync, batchGate, quoteCandidates (up to `limit`),
// pilotQueue. It answers one combined receipt with each step's counts and the
// next steps for Agent 1 (research) and Agent 2 (ticket). A step that throws is
// said in `errors` and the later steps still run. It calls no model, places no
// order, and `dryRun` writes and sends nothing (the queue then shows the
// records as they stand, before any opt-in the pass would make).
const CYCLE_FORMAT = 'cr-run-cycle@1';

async function runCycle(ws, { limit = 10, dryRun = false, now = Date.now(), fetchImpl, cgGetImpl, sleep } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new OpError('INVALID', '--limit is a whole number from 1 to 200.');
  const dry = dryRun === true;
  const out = { format: CYCLE_FORMAT, ran_at: iso(now), dry_run: dry, limit, steps: {}, counts: {}, next: { agent1_research: [], agent2_ticket: [], for_eric: [] }, errors: [] };
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      out.errors.push({ step: name, code: err.code || null, message: err.message });
      return null;
    }
  };
  const sync = await step('auto_pilot_sync', () => autoPilotSync(ws, { dryRun: dry }));
  out.steps.auto_pilot_sync = sync ? { min: sync.min, opted_in: sync.opted_in, unchanged: sync.unchanged.length, skipped: sync.skipped.length } : null;
  const gates = await step('batch_gate', () => batchGate(ws, { dryRun: dry, now }));
  out.steps.batch_gate = gates ? { below: gates.below, made: gates.made, unchanged: gates.unchanged.length, skipped: gates.skipped.length } : null;
  const quotes = await step('quote_candidates', () => quoteCandidates(ws, { limit, dryRun: dry, fetchImpl, cgGetImpl, sleep, now }));
  out.steps.quote_candidates = quotes ? { sizes: quotes.sizes, quoted: quotes.quoted, current: quotes.current.length, skipped: quotes.skipped.length, stopped: quotes.stopped } : null;
  const queue = await step('pilot_queue', () => pilotQueue(ws, { now }));
  out.steps.pilot_queue = queue ? { steps: queue.length } : null;
  for (const q of queue || []) {
    const row = { project_id: q.project_id, name: q.name || null, step: q.step, why: q.why };
    if (q.step === 'research') out.next.agent1_research.push({ ...row, run_id: q.run_id || null });
    else if (q.step === 'ticket') out.next.agent2_ticket.push({ ...row, ticket_id: q.ticket_id || null, report_id: q.report_id || null });
    else if (q.step === 'pm_review') out.next.for_eric.push({ ...row, receipt_id: q.receipt_id || null });
  }
  const byStep = {};
  for (const q of queue || []) byStep[q.step] = (byStep[q.step] || 0) + 1;
  out.counts = {
    opted_in: sync ? sync.opted_in.length : null,
    gates_made: gates ? gates.made.length : null,
    quoted: quotes ? quotes.quoted.length : null,
    queue: byStep,
    agent1_research: out.next.agent1_research.length,
    agent2_ticket: out.next.agent2_ticket.length,
    waiting_for_eric: out.next.for_eric.length,
    errors: out.errors.length,
  };
  return out;
}

function pendingFor(ws) {
  const out = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    const t = openTicket(ws, p.project_id);
    if (t) out.push({ project_id: p.project_id, name: p.name, ticket_id: t.ticket_id, state: t.job.state === 'running' ? 'started' : 'waiting', created_at: t.created_at, report_id: t.basis.researcher.report_id });
  }
  return out.sort((x, y) => (x.state === y.state ? String(x.created_at).localeCompare(String(y.created_at)) : x.state === 'started' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The weekly digest (backlog item 34): what the pilot did over the last N
// days, from the stored records only. Deterministic for a given workspace and
// `now`, writes nothing, calls no model. A section that cannot be read is said
// ("unreadable", with why) and never counted as zero; a broken record is
// listed by name, not skipped silently.

const DIGEST_FORMAT = 'cr-ticket-digest@1';
const SPREAD_BANDS = [{ id: 'under_5', label: 'under 5 points', max: 5 }, { id: '5_to_15', label: '5 to under 15', max: 15 }, { id: '15_to_30', label: '15 to under 30', max: 30 }, { id: '30_or_more', label: '30 or more', max: Infinity }];

function digest(ws, { days = 7, now = Date.now() } = {}) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0 || n > 366) throw new OpError('BAD_INPUT', 'days must be a number from 1 to 366.');
  const since = now - n * 86400000;
  const inWindow = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= since && t <= now; };
  const projects = require('./projects').listProjects(ws);
  const live = projects.filter((p) => !p.broken);
  const section = (fn) => { try { return { status: 'ok', ...fn() }; } catch (err) { return { status: 'unreadable', why: `Could not be read: ${err.message}` }; } };
  const reportsOf = (pid) => require('./reports').loadReports(ws, pid);
  const broken = projects.filter((p) => p.broken).map((p) => p.project_id || p.error || 'unknown project');

  const reportsV6 = section(() => {
    const { isEligible } = require('./reports');
    const by = {};
    let completed = 0; let eligible = 0; let undated = 0;
    const unreadable = [];
    for (const p of live) {
      for (const r of reportsOf(p.project_id)) {
        if (r.broken) { unreadable.push(r.report_id || `${p.project_id} (a report)`); continue; }
        if (!r.assessment || r.assessment.prompt_version !== AUTO_PILOT_PROMPT) continue;
        const at = r.meta && r.meta.imported_at;
        if (!at || !Number.isFinite(Date.parse(at))) { undated += 1; continue; }
        if (!inWindow(at)) continue;
        completed += 1;
        const prov = (r.meta && r.meta.provider) || 'unknown';
        by[prov] = (by[prov] || 0) + 1;
        if (isEligible(r)) eligible += 1;
      }
    }
    return { prompt: AUTO_PILOT_PROMPT, completed, eligible, by_model: by, undated_not_counted: undated, unreadable_records: unreadable };
  });

  const tickets = section(() => {
    let prosecutor = 0; let deskGate = 0;
    const unreadable = [];
    for (const p of live) {
      for (const r of listReceipts(ws, p.project_id)) {
        if (r.broken) { unreadable.push(r.receipt_id); continue; }
        if (!inWindow(r.saved_at)) continue;
        if (r.kind === 'desk_gate') deskGate += 1; else prosecutor += 1;
      }
    }
    return { prosecutor_tickets: prosecutor, desk_gate_passes: deskGate, unreadable_records: unreadable };
  });

  const spreads = section(() => {
    const { latestByProvider } = require('./compare');
    const { gradeOf } = require('./report-delta');
    const counts = Object.fromEntries(SPREAD_BANDS.map((b) => [b.id, 0]));
    let notCompared = 0;
    const largest = [];
    for (const p of live) {
      if (p.status === 'archived') continue;
      const latest = latestByProvider(reportsOf(p.project_id));
      const claude = latest.claude;
      if (!claude) continue;
      const gc = gradeOf(ws, claude);
      for (const prov of ['chatgpt', 'gemini']) {
        const other = latest[prov];
        if (!other) continue;
        const newer = [claude, other].map((r) => (r.meta && r.meta.imported_at) || '').sort().pop();
        if (!inWindow(newer)) continue;
        const go = gradeOf(ws, other);
        if (gc.kind !== 'firm' || go.kind !== 'firm' || claude.assessment.rubric_version !== other.assessment.rubric_version) { notCompared += 1; continue; }
        const gap = round(Math.abs(gc.value - go.value), 2);
        counts[SPREAD_BANDS.find((b) => gap < b.max).id] += 1;
        largest.push({ project_id: p.project_id, name: p.name, other: prov, gap });
      }
    }
    largest.sort((a, b) => b.gap - a.gap || a.project_id.localeCompare(b.project_id) || a.other.localeCompare(b.other));
    return { bands: SPREAD_BANDS.map((b) => ({ id: b.id, label: b.label, pairs: counts[b.id] })), pairs_compared: Object.values(counts).reduce((x, y) => x + y, 0), not_compared: notCompared, largest: largest.slice(0, 5), note: 'Claude\'s latest eligible report against ChatGPT\'s or Gemini\'s, same rubric, firm grades only, when the newer of the two was saved in the window.' };
  });

  const invalidated = section(() => {
    const fired = [];
    const unread = [];
    for (const p of live) {
      const receipts = listReceipts(ws, p.project_id).filter((r) => !r.broken);
      const cur = receipts[receipts.length - 1];
      if (!cur || cur.kind === 'desk_gate') continue;
      let inv;
      try { inv = invalidationOf(ws, require('./projects').getProject(ws, p.project_id), cur, { now }); } catch (err) { unread.push({ project_id: p.project_id, why: err.message }); continue; }
      if (inv.unread) { unread.push({ project_id: p.project_id, why: inv.words }); continue; }
      const hit = inv.fired;
      if (hit && inWindow(hit.at)) fired.push({ project_id: p.project_id, name: p.name, receipt_id: cur.receipt_id, by: hit.kind, at: hit.at, words: hit.words });
    }
    fired.sort((a, b) => a.at.localeCompare(b.at) || a.project_id.localeCompare(b.project_id));
    return { fired: fired.length, triggers: fired, not_read: unread, note: 'The current ticket of each project, read against prices and DefiLlama; a trigger counts when it fired in the window.' };
  });

  const budget = section(() => {
    const research = require('./research');
    const charges = research.allCharges(ws);
    const byProvider = {};
    let total = 0; let undated = 0; let estimated = 0;
    for (const c of charges) {
      if (!c.at || !Number.isFinite(Date.parse(c.at))) { undated += 1; continue; }
      if (!inWindow(c.at)) continue;
      const row = byProvider[c.provider] || (byProvider[c.provider] = { calls: 0, usd: 0 });
      row.calls += 1;
      row.usd = round(row.usd + c.usd, 4);
      total += c.usd;
      if (!['actual', 'ledger_actual', 'captured_actual', 'reconciled'].includes(c.basis)) estimated += 1;
    }
    const spent = research.spendSoFar(ws, new Date(now));
    const b = (ws.settings.research || {}).budget || {};
    return { total_usd: round(total, 4), calls: Object.values(byProvider).reduce((x, y) => x + y.calls, 0), by_provider: byProvider, estimated_or_open_calls: estimated, undated_not_counted: undated, today_usd: spent.daily, month_usd: spent.monthly, limits: { daily_usd: b.daily_usd ?? null, monthly_usd: b.monthly_usd ?? null }, note: 'Reservations and estimates count at their recorded amount.' };
  });

  // Item 58: tickets waiting on a repair (a grant whose paper position is
  // missing) or held to $0 by the admission check; the count the daily brief's
  // ticket_repairs section lists. A project that cannot be read is named.
  const repairs = section(() => {
    let count = 0;
    const unread = [];
    for (const p of live) {
      if (p.status === 'archived') continue;
      let v;
      try { v = view(ws, p.project_id, { now }); } catch (err) { unread.push({ project_id: p.project_id, why: err.message }); continue; }
      const t = v.ticket;
      if (!t) continue;
      if (t.decision && t.decision.paper === 'missing') count += 1;
      if (t.admission && t.admission.held_risk && t.status === 'pending_pm_review') count += 1;
    }
    return { count, not_read: unread, note: 'Grants whose paper position is missing, and tickets held to $0 by the admission check.' };
  });

  return { format: DIGEST_FORMAT, days: n, since: iso(since), until: iso(now), unreadable_projects: broken, reports_v6: reportsV6, tickets, grade_spreads: spreads, invalidations: invalidated, ticket_repairs: repairs, provider_budget: budget };
}

function digestText(d) {
  const L = [`Digest, last ${d.days} days (${d.since.slice(0, 10)} to ${d.until.slice(0, 10)})`];
  const bad = (s, name) => (s.status === 'ok' ? false : (L.push(`${name}: unreadable. ${s.why}`), true));
  if (!bad(d.reports_v6, '@6 reports')) {
    const r = d.reports_v6;
    L.push(`${r.prompt} reports completed: ${r.completed} (${r.eligible} eligible)${Object.keys(r.by_model).length ? ` — ${Object.entries(r.by_model).sort().map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}${r.undated_not_counted ? `; ${r.undated_not_counted} with no save time not counted` : ''}${r.unreadable_records.length ? `; unreadable: ${r.unreadable_records.join(', ')}` : ''}`);
  }
  if (!bad(d.tickets, 'Tickets')) L.push(`Prosecutor tickets ${d.tickets.prosecutor_tickets}, desk gate passes ${d.tickets.desk_gate_passes}${d.tickets.unreadable_records.length ? `; unreadable: ${d.tickets.unreadable_records.join(', ')}` : ''}`);
  if (!bad(d.grade_spreads, 'Grade spreads')) {
    const s = d.grade_spreads;
    L.push(`Grade spreads between models (${s.pairs_compared} pairs compared, ${s.not_compared} not compared): ${s.bands.map((b) => `${b.label} ${b.pairs}`).join(', ')}`);
  }
  if (!bad(d.invalidations, 'Invalidations')) {
    const v = d.invalidations;
    L.push(`Invalidation triggers fired: ${v.fired}${v.triggers.length ? ` — ${v.triggers.map((t) => `${t.name} (${t.by}, ${t.at.slice(0, 10)})`).join('; ')}` : ''}${v.not_read.length ? `; ${v.not_read.length} not read` : ''}`);
  }
  if (d.ticket_repairs && !bad(d.ticket_repairs, 'Ticket repairs')) L.push(`Tickets waiting on a repair: ${d.ticket_repairs.count}${d.ticket_repairs.not_read.length ? `; ${d.ticket_repairs.not_read.length} not read` : ''}`);
  if (!bad(d.provider_budget, 'Provider budget')) {
    const b = d.provider_budget;
    L.push(`Provider budget used: $${b.total_usd} over ${b.calls} calls${Object.keys(b.by_provider).length ? ` (${Object.entries(b.by_provider).sort().map(([k, v]) => `${k} $${v.usd}`).join(', ')})` : ''}; today $${b.today_usd}, this month $${b.month_usd}${b.undated_not_counted ? `; ${b.undated_not_counted} charges with no time not counted` : ''}`);
  }
  if (d.unreadable_projects.length) L.push(`Unreadable projects: ${d.unreadable_projects.join(', ')}`);
  return L.join('\n');
}

module.exports = {
  digest,
  digestText,
  DIGEST_FORMAT,
  newerRuleOf,
  integrityOf,
  PROMPT_VERSION,
  FORMAT,
  SIZING_VERSION,
  INVALIDATION_VERSION,
  INVALIDATION_V1,
  SIZING_V5,
  INVALIDATION_V3,
  TAX_SPIKE_BPS,
  contractIdentityNow,
  contractOpenGuard,
  contractVerdictNow,
  contractCheckOf,
  exitsOf,
  exitSizesOf,
  MANDATE_VERSION,
  MANDATE_BY,
  MANDATE_MIN_GRADE,
  MANDATE_MAX_DAYS,
  MANDATE_MAX_CAP,
  MANDATE_DEFAULTS,
  MANDATE_MEANING,
  mandateTierOf,
  mandateChains,
  mandateOf,
  isMandateLine,
  exitArrivedOf,
  reopenReason,
  ownsContract,
  mandateContractEvidence,
  mandateEligible,
  mandateSweep,
  mandateDue,
  MANDATE_LEASE,
  VERDICTS,
  TESTS,
  // The mandate's authority and Eric's latch (core/mandate-authority.js).
  grantAuthority: (...a) => require('./mandate-authority').grantAuthority(...a),
  autonomyOf: (...a) => require('./mandate-authority').autonomyOf(...a),
  setAutonomy: (...a) => require('./mandate-authority').setAutonomy(...a),
  prosecutionHoldOf: (...a) => require('./mandate-authority').prosecutionHoldOf(...a),
  readDecisionsStrict: (...a) => require('./mandate-authority').readDecisionsStrict(...a),
  paperWanted,
  countedExits,
  PREGATE_VERSION,
  ADMISSION_VERSION,
  SIZING_DEFAULTS,
  TICKET_RE,
  RECEIPT_RE,
  PROPOSALS,
  sizingOf,
  gate,
  pregateReason,
  tradePlanGeometry,
  nearInvalidation,
  waitingDeskGates,
  decideDeskGates,
  gateGrade,
  skeleton,
  researcherOf,
  loadTicket,
  listTickets,
  listReceipts,
  readDecisions,
  decisionFor,
  readDraft,
  promptFor,
  createTicket,
  prepareExitQuote,
  cancelTicket,
  saveDraft,
  saveTicket,
  receiptText,
  decide,
  reconcileEffects,
  reconcileDesk,
  RECONCILE_FORMAT,
  invalidationOf,
  view,
  read,
  summary,
  setPilot,
  nextStep,
  pilotQueue,
  readTicketProfile: readProfile,
  pilotCandidates,
  candidateBoard,
  exitMatrix,
  EXIT_MATRIX_FORMAT,
  EXIT_EVIDENCE_VERSION,
  exitEvidenceOf,
  batchGate,
  autoPilotSync,
  quoteCandidates,
  runCycle,
  CYCLE_FORMAT,
  pendingFor,
};
