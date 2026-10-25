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
// The desk computes what no model may: the exit cost at $500 and $2,000 comes
// from its own exit-quote readings (forensics.js), the size from Eric's
// sizing rules (cr-ticket-sizing@1, frozen into each ticket), and whether a
// ticket is invalidated is read against the hourly prices and the bound
// DefiLlama metric each time it is read; the stored ticket is never rewritten.
// A decision records what Eric chose. Nothing here places an order, moves
// money or calls a model or a paid provider.

const fs = require('fs');
const path = require('path');
const { runOp, OpError } = require('./ops');
const { readJson, listDir, sha256, jsonText } = require('./fsx');
const { compactTs, randomId, isProjectId } = require('./ids');

const PROMPT_VERSION = 'cr-ticket-prompt@1';
const FORMAT = 'cr.ticket.v1';
// @2 (Eric, 2026-10-24): a native L1 coin of at least $10B market cap passes
// the exit check without a DEX quote (exit_basis native_l1_liquid). A ticket
// keeps the version it froze: @1 tickets are read without the exemption.
const SIZING_VERSION = 'cr-ticket-sizing@2';
const INVALIDATION_VERSION = 'cr-ticket-invalidation@2';
const INVALIDATION_V1 = 'cr-ticket-invalidation@1';
// Rollback safety (2026-10-25): a receipt made under a newer rules version than
// this code knows is shown as saved, never re-read and never thrown on.
const RULE_KINDS = [
  { name: 'sizing', current: SIZING_VERSION, of: (r) => r.versions && r.versions.sizing },
  { name: 'invalidation', current: INVALIDATION_VERSION, of: (r) => (r.desk && r.desk.invalidation_version) || (r.versions && r.versions.invalidation) },
  { name: 'pregate', current: 'cr-ticket-pregate@1', of: (r) => r.pregate_version || (r.versions && r.versions.pregate) },
];
const versionNumber = (v) => { const m = /@(\d+)$/.exec(String(v || '')); return m ? Number(m[1]) : null; };
const MIN_COVERAGE_DEFAULT = 90;
const MAX_GAP_HOURS = 6;
// The desk's pre-gate (Eric, 2026-10-24): when the grade alone rules out new
// risk and he does not hold the asset, no Prosecutor runs; the desk saves its
// own gate result as a receipt (kind desk_gate), with no proposal.
const PREGATE_VERSION = 'cr-ticket-pregate@1';
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
const OPEN = new Set(['waiting', 'running']);
const HOUR = 3600000;

// Eric's sizing rules (2026-10-24), his choices and not universal rules:
// $500 standard risk (1.0R) only with a proven exit cost at $500 of at most
// 5% and a grade of at least 55; $250 the starter tranche (0.5R, "Halve
// Size"); under 40 nothing new, and under 55 nothing new for an asset he does
// not hold. Settings `tickets.sizing` may change them; each ticket freezes the
// values it was made under.
const SIZING_DEFAULTS = Object.freeze({
  standard_risk_usd: 500,
  starter_risk_usd: 250,
  exit_size_usd: 500,
  max_exit_cost_pct: 5,
  min_grade_new_entry: 55,
  min_grade_any: 40,
  native_l1_min_market_cap_usd: 10e9,
});
const SIZING_NOTE = 'Your sizing rules (settings, tickets.sizing), not universal rules. New tickets freeze the values in force; saved tickets keep theirs.';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const iso = (ms) => new Date(ms).toISOString();
const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const str = (v, max = 2000) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const usd = (n) => `$${Number(n).toLocaleString('en-US')}`;

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
  return {
    version: SIZING_VERSION,
    standard_risk_usd: standard,
    starter_risk_usd: Math.min(pos(s.starter_risk_usd, d.starter_risk_usd, 1e9), standard),
    exit_size_usd: pos(s.exit_size_usd, d.exit_size_usd, 1e9),
    max_exit_cost_pct: pos(s.max_exit_cost_pct, d.max_exit_cost_pct, 100),
    min_grade_new_entry: grade(s.min_grade_new_entry, d.min_grade_new_entry),
    min_grade_any: grade(s.min_grade_any, d.min_grade_any),
    native_l1_min_market_cap_usd: pos(s.native_l1_min_market_cap_usd, d.native_l1_min_market_cap_usd, 1e15),
    note: SIZING_NOTE,
  };
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
// tab's view): the best current reading, or why there is none. A lower bound
// (a cost not known in full) is kept as "at least".
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
    const b = row ? row.best : null;
    const cost = b && isNum(b.cost_pct) ? round(b.cost_pct, 3) : null;
    return {
      size_usd: s,
      status: row ? row.status : 'no_reading',
      cost_pct: cost,
      cost_complete: b ? b.cost_complete !== false : null,
      missing_costs: b ? b.missing_costs || [] : [],
      method: b ? b.method || null : null,
      route_scope: b ? b.route_scope || null : null,
      as_of: (row && row.as_of) || (b && b.retrieved_at) || null,
      note: row ? row.note || null : `No exit reading at ${usd(s)}: approve exit quotes for this project (Forensics > Exits, or Quote exits for every project).`,
    };
  });
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

function heldOf(ws, pid, now) {
  try {
    const market = require('./market').readLatest(ws);
    const pf = require('./portfolio').computePortfolio(ws, { market, now });
    return pf.positions.some((p) => !p.closed && p.project_id === pid);
  } catch (_) {
    return null;
  }
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
// The sizing gate (cr-ticket-sizing@1, @2): deterministic, from the frozen
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
    type = 'WATCH_ONLY';
  }
  if (!type) type = riskAllowed ? null : grade !== null && grade < sizing.min_grade_any ? 'HARD_PASS' : 'WATCH_ONLY';
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
  };
}

// Does the grade alone rule out new risk for an asset Eric does not hold? Only
// a known "not held" counts (an unreadable portfolio opens a normal ticket).
// Returns the gate's grade reason, else null.
function pregateReason(researcher, held, sizing) {
  if (held !== false) return null;
  const grade = gateGrade(researcher.grade);
  if (grade !== null && grade >= sizing.min_grade_new_entry) return null;
  const g = gate({ researcher, held: false, exits: [], native: null }, sizing);
  return g.reasons[0] || null;
}

// ---------------------------------------------------------------------------
// Prompt

function templateText(ws, name) {
  const local = ws.abs(`templates/tickets/${name}`);
  const shipped = path.join(__dirname, '..', '..', 'templates', 'tickets', name);
  for (const p of [local, shipped]) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (_) { /* next */ }
  }
  throw new OpError('NOT_FOUND', `The ticket template ${name} is missing.`);
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
    if (!reopenReason(ws, project, latest, { now })) throw new OpError('REFUSED', 'Re-open applies only when the ticket in force is invalidated, or was sized under an older rules version than the one in force. It is neither; nothing was opened.');
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
  const onReport = listReceipts(ws, pid).filter((r) => !r.broken && r.researcher && r.researcher.report_id === researcher.report_id && !(args.force_prosecution === true && r.kind === 'desk_gate')).pop() || null;
  if (pregate && onReport && onReport.kind === 'desk_gate') return { status: 'unchanged', gate_closed: true, project_id: pid, receipt_id: onReport.receipt_id, receipt: onReport, verified: true, message: `The desk's gate on Claude's current report (${researcher.report_id}) is already saved (${onReport.receipt_id}). No Prosecutor runs; pass force_prosecution: true only when Eric asks for one.` };
  if (!args.refresh && !args.restart && onReport) return { status: 'exists', project_id: pid, receipt_id: onReport.receipt_id, ticket_id: onReport.ticket_id, message: `A ticket on Claude's current report (${researcher.report_id}) is already saved (${onReport.receipt_id}). Nothing new was opened; pass refresh: true only when Eric asks for another.` };
  if (open && args.restart) cancelTicket(ws, pid, open.ticket_id, 'Eric asked to start the ticket over.');
  const tid = `tk_${compactTs(new Date(now))}_${randomId(5)}`;
  const sizes = [...new Set([sizing.exit_size_usd, 2000])].sort((a, b) => a - b);
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
      'exits: the desk\'s own exit-quote readings (aggregator quotes or constant-product reserves) as the Forensics tab reads them; a cost not known in full is a lower bound.',
      'held: whether Eric records an open position in this token (Portfolio); never its size.',
    ],
  };
  // Whether the identity says this is the chain's own coin (never inferred
  // from a missing contract), with the stored market cap the exemption reads.
  packet.native = { native_chain: project.identity.native_chain === true, market_cap_usd: isNum(packet.market.market_cap_usd) ? packet.market.market_cap_usd : null };
  packet.exits_missing = exitsMissing(packet.exits, pid);
  const packetText = jsonText(packet);
  const packetSha = sha256(packetText);
  if (pregate) return closeGate(ws, { pid, project, researcher, packet, packetText, packetSha, sizing, now });
  const dir = ticketDir(pid, tid);
  const ticket = {
    schema_version: 'cr.ticket-job.v1',
    ticket_id: tid,
    project_id: pid,
    created_at: at,
    created_by: ws.actor || null,
    channel: args.channel || ws.actor || 'cli',
    utterance: typeof args.utterance === 'string' ? args.utterance.slice(0, 2000) : null,
    versions: { prompt: PROMPT_VERSION, format: FORMAT, sizing: SIZING_VERSION, invalidation: INVALIDATION_VERSION },
    basis: { researcher, held: packet.held, exits: packet.exits, market: packet.market, native: packet.native },
    sizing,
    packet: { path: `${dir}/packet.json`, sha256: packetSha, captured_at: at },
    prompt: null,
    paid_requests: 'none: the Prosecutor is Claude through its connection or the local runner (Eric\'s subscription); the desk sends no model request.',
    job: { provider: 'claude', role: 'prosecutor', state: assistant ? 'running' : 'waiting', mode: assistant ? args.mode || 'cowork' : 'manual', receipt_id: null, receipts: [], updated_at: at, note: assistant ? 'Taken by Claude.' : 'Waiting for Claude: ask Claude (CryptoResearch connector) for the waiting ticket, or run npm run pilot.' },
  };
  const prompt = renderPrompt(ws, { ticket, project, packetText, packetSha, reportText });
  ticket.prompt = { version: PROMPT_VERSION, path: `${dir}/prompt.md`, sha256: sha256(prompt), chars: prompt.length };
  const out = runOp(ws, { type: 'ticket_create', summary: `PM ticket for ${pid}` }, (op) => {
    op.write(`${dir}/packet.json`, packetText, { mode: 'create' });
    op.write(`${dir}/prompt.md`, prompt, { mode: 'create' });
    op.writeJson(`${dir}/ticket.json`, ticket, { mode: 'create' });
    return { ticket_id: tid };
  });
  return { status: 'created', project_id: pid, ticket_id: tid, ticket, verified: out.verified, files: out.files, message: `Opened ticket ${tid} for ${project.name} on Claude's report ${researcher.report_id}.` };
}

// The pre-gate's receipt: the same frozen packet as a ticket would carry (kept
// beside the receipt, create-only) and the gate's own result with no
// proposal. No prompt is rendered and nothing goes to a model.
function closeGate(ws, { pid, project, researcher, packet, packetText, packetSha, sizing, now }) {
  const basis = { researcher, held: packet.held, exits: packet.exits, market: packet.market, native: packet.native };
  const g = gate(basis, sizing);
  const at500 = packet.exits.find((x) => x.size_usd === sizing.exit_size_usd) || null;
  const at2000 = packet.exits.find((x) => x.size_usd === 2000) || null;
  const rid = `tr_${compactTs(new Date(now))}_${randomId(5)}`;
  const savedAt = iso(now);
  const { original, ...researcherNoPath } = researcher;
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
      gate: g,
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
    },
    agent_disagreement: null,
    sources: [],
    validation: { errors: [] },
  };
  const out = runOp(ws, { type: 'ticket_desk_gate', summary: `Desk gate for ${pid}` }, (op) => {
    const again = listReceipts(ws, pid).find((r) => !r.broken && r.kind === 'desk_gate' && r.researcher && r.researcher.report_id === researcher.report_id);
    if (again) return { replay: again };
    op.write(receipt.packet.path, packetText, { mode: 'create' });
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
    message: `The desk's gate is closed for ${project.name}: ${g.proposal_type}, no risk. ${g.reasons[0] || ''} No Prosecutor ran; the receipt ${rid} waits for Eric's review (pass force_prosecution: true to open one anyway).`,
  };
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
    Object.assign(t.job, { draft_saved_at: at, draft_chars: body.length, progress_note: note ? String(note).slice(0, 300) : null, updated_at: at });
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

// A ticket must not be invalidated the moment it is saved. The price now is
// the latest stored reading, else the frozen packet's; the metric total is the
// packet's complete 30-day total. A check with no reading is skipped, not
// passed. Returns null, or { kind, words, refusal }.
const EXEMPT_FROM_BORN_CHECK = new Set(['HARD_PASS', 'TRIM_EXIT']);
function bornInvalidated(ws, project, ticket, inv) {
  if (!inv) return null;
  let packet = null;
  try { packet = JSON.parse(verifiedFrozen(ws, ticket.packet.path, ticket.packet.sha256, 'The frozen ticket packet')); } catch (_) { packet = null; }
  if (isNum(inv.price_usd)) {
    let now = null;
    try { now = marketOf(ws, project); } catch (_) { now = null; }
    const pk = (packet && packet.market) || (ticket.basis && ticket.basis.market);
    const cur = now && isNum(now.price_usd) ? now : pk && isNum(pk.price_usd) ? pk : null;
    if (cur && inv.price_usd >= cur.price_usd) {
      const when = cur.as_of || 'an unknown time';
      return {
        kind: 'price',
        words: `The invalidation price $${inv.price_usd} was at or above the price when saved ($${cur.price_usd} at ${when}).`,
        refusal: `the invalidation price $${inv.price_usd} is at or above the price now ($${cur.price_usd} at ${when}): the ticket would be invalidated the moment it is saved. Set a threshold below the current price.`,
      };
    }
  }
  if (inv.metric) {
    const f = packet && packet.fundamentals;
    const m = f && f.metrics ? f.metrics[inv.metric.key] : null;
    if (m && m.status === 'complete' && isNum(m.total_30d_usd) && inv.metric.below_30d_usd > m.total_30d_usd) {
      const when = (f && f.fetched_at) || 'an unknown date';
      return {
        kind: 'metric',
        words: `The ${inv.metric.key} floor $${inv.metric.below_30d_usd} was above the packet's complete 30-day total ($${m.total_30d_usd}, ${when}).`,
        refusal: `the ${inv.metric.key} floor $${inv.metric.below_30d_usd} is above the packet's complete 30-day total ($${m.total_30d_usd}, ${when}): the ticket would be invalidated the moment it is saved. Set a floor below the total.`,
      };
    }
  }
  return null;
}

function saveTicket(ws, { project_id: pid, ticket_id: tid, text, revision = null, channel = null }) {
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
  try {
    verifiedFrozen(ws, ticket.prompt.path, ticket.prompt.sha256, 'The frozen Prosecutor prompt');
    verifiedFrozen(ws, ticket.packet.path, ticket.packet.sha256, 'The frozen ticket packet');
  } catch (err) {
    if (err.code !== 'INTEGRITY') throw err;
    throw new OpError('INTEGRITY', `Not saved: ${err.message} Keep the text: it can be saved once the frozen files are restored.`, err.details);
  }
  const now = Date.now();
  const asOf = c.as_of ? Date.parse(c.as_of) : NaN;
  if (Number.isFinite(asOf) && asOf > now + AS_OF_SLACK_MS) throw new OpError('INVALID', `Not saved: as_of (${c.as_of}) is after the time of saving.`);
  if (Number.isFinite(asOf) && asOf < Date.parse(ticket.created_at) - AS_OF_SLACK_MS) throw new OpError('INVALID', `Not saved: as_of (${c.as_of}) is before the ticket was opened (${ticket.created_at}).`);
  const g = gate(ticket.basis, ticket.sizing, c.proposal.proposal_type);
  const breached = bornInvalidated(ws, project, ticket, c.proposal.invalidation_trigger);
  const exemptType = EXEMPT_FROM_BORN_CHECK.has(c.proposal.proposal_type) || EXEMPT_FROM_BORN_CHECK.has(g.proposal_type);
  if (breached && !exemptType) throw new OpError('INVALID', `Not saved: ${breached.refusal} The draft is kept.`, { trigger: breached.kind });
  const exits = ticket.basis.exits || [];
  const at500 = exits.find((x) => x.size_usd === ticket.sizing.exit_size_usd) || null;
  const at2000 = exits.find((x) => x.size_usd === 2000) || null;
  const rgrade = ticket.basis.researcher.grade;
  const rid = `tr_${compactTs(new Date(now))}_${randomId(5)}`;
  const savedAt = iso(now);
  const receipt = {
    schema_version: 'cr.ticket-receipt.v1',
    receipt_id: rid,
    ticket_id: tid,
    project_id: pid,
    saved_at: savedAt,
    as_of: Number.isFinite(asOf) ? iso(Math.min(asOf, now)) : savedAt,
    model: { provider: 'claude', role: 'prosecutor', model_version: c.model_version, channel: channel || ws.actor || null, saved_by: ws.actor || null },
    versions: ticket.versions,
    prompt_sha256: ticket.prompt.sha256,
    packet: ticket.packet,
    text: { path: receiptRel(pid, rid, 'md'), sha256: sha256(body), normalized_sha256: textHash, chars: body.length },
    block_sha256: sha256(JSON.stringify(b)),
    revision_of: rev ? rev.of : null,
    revision: rev,
    researcher: { report_id: ticket.basis.researcher.report_id, verdict: ticket.basis.researcher.verdict, grade: rgrade, analysis_at: ticket.basis.researcher.analysis_at },
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
      sell_tax: null,
      invalidation_version: INVALIDATION_VERSION,
      ...(breached && exemptType ? { trigger_breached_at_save: { kind: breached.kind, words: breached.words } } : {}),
    },
    // Both agents' own figures and verdicts, side by side; the spread is the
    // difference between the two, never their average.
    agent_disagreement: {
      researcher: { report_id: ticket.basis.researcher.report_id, grade: gateGrade(rgrade), grade_display: rgrade ? rgrade.display : null, verdict: ticket.basis.researcher.verdict },
      prosecutor: { conviction_score: c.prosecution.conviction_score, verdict: c.prosecution.verdict, fatal_flaws: c.prosecution.fatal_flaws.filter((f) => f.severity === 'fatal').length },
      spread_points: isNum(gateGrade(rgrade)) && isNum(c.prosecution.conviction_score) ? round(gateGrade(rgrade) - c.prosecution.conviction_score, 2) : null,
      note: c.agent_disagreement_note,
    },
    sources: c.sources,
    validation: { errors: norm.errors },
  };
  try {
    const pk = JSON.parse(verifiedFrozen(ws, ticket.packet.path, ticket.packet.sha256, 'The frozen ticket packet'));
    receipt.desk.sell_tax = pk.sell_tax || null;
  } catch (_) { /* checked above */ }
  const out = runOp(ws, { type: 'ticket_receipt', summary: `PM ticket for ${pid}` }, (op) => {
    const again = prior().find((r) => r.text && r.text.normalized_sha256 === textHash);
    if (again) return { replay: again };
    const t = op.readJson(ticketRel(pid, tid), null);
    if (!t || t.job.state === 'canceled') throw new OpError('CONFLICT', `Ticket ${tid} is no longer open.`);
    op.write(receipt.text.path, body, { mode: 'create' });
    op.writeJson(receiptRel(pid, rid), receipt, { mode: 'create' });
    Object.assign(t.job, { state: 'completed', receipt_id: rid, receipts: [...(t.job.receipts || []), rid], completed_at: savedAt, updated_at: savedAt });
    op.writeJson(ticketRel(pid, tid), t);
    return { receipt_id: rid };
  });
  if (out.result && out.result.replay) return { status: 'unchanged', receipt_id: out.result.replay.receipt_id, receipt: out.result.replay, verified: true, message: `This exact text is already saved as ${out.result.replay.receipt_id}.` };
  const capped = g.capped ? ` The desk capped ${g.capped.from} to ${g.proposal_type}: ${g.capped.reason}` : '';
  return {
    status: out.verified ? 'saved' : 'unverified',
    receipt_id: rid,
    receipt,
    verified: out.verified,
    files: out.files,
    message: out.verified
      ? `Saved ticket ${rid} for ${project.name}: ${g.proposal_type}, suggested risk ${usd(g.suggested_risk_usd)}. Waiting for Eric's PM review.${capped}${rev ? ` A revision of ${rev.of}; the original is unchanged.` : ''}${norm.errors.length ? ` ${norm.errors.length} format note${norm.errors.length === 1 ? '' : 's'} kept with it.` : ''}`
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
// Eric's PM decisions

// The decision in force for a receipt: the last line that an undo has not
// taken back.
function decisionFor(lines, rid) {
  const mine = lines.filter((l) => l.receipt_id === rid);
  const undone = new Set(mine.filter((l) => l.action === 'undo').map((l) => l.undoes));
  return mine.filter((l) => l.action !== 'undo' && !undone.has(l.decision_id)).pop() || null;
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

// Why a saved ticket may be re-opened: it is invalidated, or it was sized under
// an older rules version than the one in force. Null when neither holds.
// Nothing re-opens automatically.
function reopenReason(ws, project, receipt, { now = Date.now() } = {}) {
  if (!receipt || receipt.kind === 'desk_gate' || newerRuleOf(receipt)) return null;
  const inv = invalidationOf(ws, project, receipt, { now });
  if (inv.invalidated) return { kind: 'invalidated', why: inv.words || 'The ticket is invalidated.' };
  const was = receipt.versions && receipt.versions.sizing;
  const inForce = sizingOf(ws).version;
  if (was && was !== inForce) return { kind: 'rules_upgrade', why: `Sized under ${was}; ${inForce} is in force.` };
  return null;
}

function decide(ws, pid, { receipt_id: rid, action, note = null, request_id: requestId = null, by = null }) {
  if (!RECEIPT_RE.test(String(rid))) throw new OpError('BAD_ID', 'Name the ticket you decided (its receipt ID).');
  if (!ACTIONS.includes(action)) throw new OpError('INVALID', `The decision is one of ${ACTIONS.join(', ')}.`);
  const text = note === null || note === undefined ? null : String(note).replace(/\r\n/g, '\n').trim().slice(0, 1000) || null;
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const rel = decisionsRel(pid);
  const held = action === 'pass' ? heldOf(ws, pid, Date.now()) === true : false;
  let reopen = null;
  if (action === 'reopen') {
    const project = require('./projects').getProject(ws, pid);
    const rec = readJson(ws.abs(receiptRel(pid, rid)), null);
    if (rec) {
      reopen = reopenReason(ws, project, rec);
      if (!reopen && rec.kind !== 'desk_gate') throw new OpError('REFUSED', 'Re-open applies only to an invalidated ticket, or one sized under an older rules version than the one in force. This ticket is neither.');
    }
  }
  const out = runOp(ws, { type: 'ticket_decision', summary: `PM ${action} on ${rid} for ${pid}` }, (op) => {
    const r = op.readJson(receiptRel(pid, rid), null);
    if (!r) throw new OpError('NOT_FOUND', `No ticket ${rid} for ${pid}.`);
    if (r.kind === 'desk_gate' && !['pass', 'watch', 'undo'].includes(action)) throw new OpError('REFUSED', `This is the desk's gate, not a Prosecutor's ticket (${r.desk && r.desk.proposal_type || 'no proposal'}, no risk): ${action} does not apply. Confirm the pass or keep it on watch.`);
    const cur = op.readText(rel, '');
    const lines = cur.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const prior = reqId ? lines.find((l) => l.request_id === reqId) : null;
    if (prior) return { status: 'unchanged', decision: prior };
    const latest = listReceipts(ws, pid).filter((x) => !x.broken).pop();
    if (action !== 'undo' && latest && latest.receipt_id !== rid) throw new OpError('NEWER_REPORT', `Not recorded: a newer ticket was saved (${latest.receipt_id}, ${latest.saved_at}). Look at it, then decide that one.`, { newer: [{ receipt_id: latest.receipt_id, saved_at: latest.saved_at }] });
    const inForce = decisionFor(lines, rid);
    const at = new Date().toISOString();
    let line;
    if (action === 'undo') {
      if (!inForce) throw new OpError('CONFLICT', 'There is no decision on this ticket to undo.');
      line = { action: 'undo', undoes: inForce.decision_id };
    } else {
      const suggested = r.desk ? r.desk.suggested_risk_usd : 0;
      const type = r.desk ? r.desk.proposal_type : null;
      if (action === 'reopen' && inForce && inForce.action === 'reopen') return { status: 'unchanged', decision: inForce };
      if ((action === 'approve' || action === 'halve') && !(suggested > 0)) throw new OpError('REFUSED', `This ticket suggests no risk (${type || 'no proposal'}): there is nothing to approve. Confirm the pass, or keep watching.`);
      if ((action === 'pass' || action === 'watch') && suggested > 0) throw new OpError('REFUSED', `This ticket suggests ${usd(suggested)} of risk: approve, halve or veto it.`);
      if (action === 'reopen' && !reopen) throw new OpError('REFUSED', 'Re-open applies only to an invalidated ticket, or one sized under an older rules version.');
      if (action === 'trim' && type !== 'TRIM_EXIT') throw new OpError('REFUSED', `This ticket proposes ${type || 'nothing'}, not a trim.`);
      if (inForce && inForce.action === action) return { status: 'unchanged', decision: inForce };
      const starter = r.desk && r.desk.sizing ? r.desk.sizing.starter_risk_usd : SIZING_DEFAULTS.starter_risk_usd;
      const approved = action === 'approve' ? suggested : action === 'halve' ? Math.min(starter, suggested) : 0;
      line = { action, pm_approved_risk_usd: approved, suggested_risk_usd: suggested, proposal_type: type, ...(action === 'reopen' ? { reopen: reopen } : {}) };
      // A confirmed pass archives the project (reversible; Undo restores it),
      // except one Eric holds, which stays watched.
      if (action === 'pass') line.archive = held ? 'kept: held' : 'archived';
    }
    const full = { schema_version: 'cr.ticket-decision.v1', decision_id: `td_${sha256(`${pid}:${rid}:${action}:${at}:${lines.length}`).slice(0, 14)}`, project_id: pid, receipt_id: rid, ticket_id: r.ticket_id, ...line, note: text, decided_at: at, decided_by: by || ws.actor || null, request_id: reqId, meaning: 'Eric\'s PM decision on the ticket: it records his choice and places no order.' };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(full)}\n`);
    return { status: 'saved', decision: full, undone: action === 'undo' ? inForce : null };
  });
  const res = out.result || {};
  if (res.status === 'saved') {
    const projects = require('./projects');
    if (action === 'pass' && res.decision.archive === 'archived') {
      projects.archiveProject(ws, pid, `PM confirmed the pass on ticket ${rid}.`);
      res.project_archived = true;
    }
    if (action === 'undo' && res.undone && res.undone.archive === 'archived') {
      projects.restoreProject(ws, pid);
      res.project_restored = true;
    }
    res.journal = journalDecision(ws, pid, res.decision, res.undone);
  }
  return out;
}

// The decision also shows in Notes as a journal entry (type decision). The
// schema's decision words do not cover every PM action, so the action, the
// receipt and the approved risk are stated in reasons; decisions.jsonl stays
// the source of truth and a journal failure never loses or blocks a decision.
function journalDecision(ws, pid, d, undone) {
  try {
    const undo = d.action === 'undo';
    const shown = undo ? undone : d;
    const reasons = [`pm_action: ${d.action}`, `receipt: ${d.receipt_id}`, `decision_id: ${d.decision_id}`];
    if (undo) reasons.push(`undoes: ${undone.decision_id}`);
    else if (isNum(d.pm_approved_risk_usd)) reasons.push(`approved_risk_usd: ${d.pm_approved_risk_usd}`);
    const text = undo
      ? `PM undid ${shown.action} on ticket ${d.receipt_id}.`
      : `PM ${d.action} on ticket ${d.receipt_id}${isNum(d.pm_approved_risk_usd) ? `, approved risk ${usd(d.pm_approved_risk_usd)}` : ''}.${d.note ? ` ${d.note}` : ''}`;
    const entry = require('./notes').addJournal(ws, pid, { type: 'decision', decision: d.action === 'watch' || d.action === 'trim' ? d.action : null, text, reasons });
    return { status: 'saved', entry_id: entry.entry_id };
  } catch (err) {
    return { status: 'failed', error: String(err && err.message || err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Invalidation, evaluated on read (cr-ticket-invalidation@1, @2)

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
  const version = v1 ? INVALIDATION_V1 : INVALIDATION_VERSION;
  const inv = receipt.proposal && receipt.proposal.invalidation_trigger;
  if (!inv) return { version, invalidated: false, checks: [] };
  const checks = [];
  const savedMs = Date.parse(receipt.saved_at);
  const cg = project.identity && project.identity.coingecko_id;
  if (isNum(inv.price_usd)) {
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
          if (!low || pt.price_usd < low.price_usd) low = { price_usd: pt.price_usd, at: iso(t) };
        }
      }
      const latest = (market.readLatest(ws).assets || {})[cg];
      const lt = latest ? Date.parse(latest.source_last_updated_at || latest.fetched_at) : NaN;
      if (latest && isNum(latest.price_usd) && Number.isFinite(lt) && lt >= savedMs && lt <= now) times.push(lt);
      if (latest && isNum(latest.price_usd) && Number.isFinite(lt) && lt >= savedMs && (!low || latest.price_usd < low.price_usd)) low = { price_usd: latest.price_usd, at: iso(lt) };
    }
    const cov = v1 ? null : coverageOf(times, savedMs, now);
    const triggered = low !== null && low.price_usd <= inv.price_usd;
    const thin = cov && cov.hours_elapsed >= 1 && cov.coverage_pct < minCoveragePct(ws);
    const covWords = cov && cov.hours_elapsed >= 1 ? ` Coverage: ${cov.hours_with_reading} of ${cov.hours_elapsed} hours since the ticket had a reading${cov.gaps.length ? `; gaps over ${MAX_GAP_HOURS} h: ${cov.gaps.map((g) => `${g.from} to ${g.to}`).join('; ')}` : ''}.` : '';
    const base = low === null ? null : { price_usd: low.price_usd, at: low.at };
    if (low === null) checks.push({ kind: 'price', status: 'unknown', threshold_usd: inv.price_usd, ...(cov ? { coverage: cov } : {}), words: `No price recorded since the ticket.${covWords}` });
    else if (triggered) checks.push({ kind: 'price', status: 'triggered', threshold_usd: inv.price_usd, lowest_usd: low.price_usd, at: low.at, ...(cov ? { coverage: cov } : {}), words: `Price reached $${low.price_usd} at ${low.at}, at or below the invalidation price $${inv.price_usd}.${covWords}` });
    else if (thin) checks.push({ kind: 'price', status: 'unknown', threshold_usd: inv.price_usd, lowest_usd: base.price_usd, at: base.at, coverage: cov, words: `Not enough price readings to say the price held: ${cov.coverage_pct}% of the hours since the ticket have one, under your ${minCoveragePct(ws)}%. Lowest seen $${low.price_usd}, above $${inv.price_usd}.${covWords}` });
    else checks.push({ kind: 'price', status: 'holding', threshold_usd: inv.price_usd, lowest_usd: low.price_usd, at: low.at, ...(cov ? { coverage: cov } : {}), words: `Lowest price since the ticket $${low.price_usd}, above $${inv.price_usd}.${covWords}` });
  }
  if (inv.metric) {
    const f = fundamentals || fundamentalsOf(ws, project, now);
    const m = f && f.metrics ? f.metrics[inv.metric.key] : null;
    const fetched = f && f.fetched_at ? Date.parse(f.fetched_at) : NaN;
    if (!f || f.state === 'unmapped') checks.push({ kind: 'metric', status: 'not_bound', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, words: 'No DefiLlama entity is bound: the metric is not checked.' });
    else if (!m || !isNum(m.total_30d_usd) || m.status !== 'complete') checks.push({ kind: 'metric', status: 'unknown', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, words: `No complete 30-day ${inv.metric.key} total on file.` });
    else if (!(fetched > savedMs)) checks.push({ kind: 'metric', status: 'unknown', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, words: 'The saved total is from before the ticket; it is not read as a change.' });
    else checks.push({ kind: 'metric', status: m.total_30d_usd < inv.metric.below_30d_usd ? 'triggered' : 'holding', key: inv.metric.key, threshold_usd: inv.metric.below_30d_usd, value_usd: m.total_30d_usd, at: f.fetched_at, words: `30-day ${inv.metric.key} $${Math.round(m.total_30d_usd).toLocaleString('en-US')} ${m.total_30d_usd < inv.metric.below_30d_usd ? 'under' : 'not under'} $${inv.metric.below_30d_usd.toLocaleString('en-US')}.` });
  }
  const hit = checks.find((c) => c.status === 'triggered') || null;
  const out = { version, invalidated: Boolean(hit), by: hit ? hit.kind : null, words: hit ? hit.words : null, fired: hit, checks };
  if (!v1) {
    const stale = basisStale(ws, project, receipt, now);
    if (stale) out.basis_stale = stale;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading: the ticket in force and its status

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
      non_consensus_thesis: pr.non_consensus_thesis || null,
      entry_zone: pr.entry_zone || null,
      upside_target: pr.upside_target || null,
      invalidation_trigger: pr.invalidation_trigger || null,
      exit_basis: d.exit_basis || 'measured',
      exit_cost_500_usd_pct: d.exit_cost_500_usd_pct ?? null,
      exit_cost_500_complete: d.exit_cost_500_complete ?? null,
      exit_cost_2000_usd_pct: d.exit_cost_2000_usd_pct ?? null,
      exits_missing: d.exits_missing || [],
      trigger_breached_at_save: d.trigger_breached_at_save || null,
      rule_note: (newerRuleOf(current) || {}).words || null,
      can_reopen: (() => {
        if (gateOnly || current !== receipts[receipts.length - 1] || open || (decision && decision.action === 'reopen')) return null;
        return reopenReason(ws, project, current, { now });
      })(),
      suggested_risk_usd: d.suggested_risk_usd || 0,
      starter_risk_usd: d.sizing ? d.sizing.starter_risk_usd : SIZING_DEFAULTS.starter_risk_usd,
      pm_approved_risk_usd: decision ? decision.pm_approved_risk_usd : null,
      decision: decision ? { decision_id: decision.decision_id, action: decision.action, at: decision.decided_at, note: decision.note, archive: decision.archive || null } : null,
      prosecution: current.prosecution ? { verdict: current.prosecution.verdict, conviction_score: current.prosecution.conviction_score, fatal_flaws: current.prosecution.fatal_flaws, tests: current.prosecution.tests } : null,
      agent_disagreement: current.agent_disagreement || null,
      invalidation,
      researcher_report_id: current.researcher.report_id,
      researcher: { report_id: current.researcher.report_id, grade: gateGrade(current.researcher.grade), grade_display: current.researcher.grade ? current.researcher.grade.display : null, verdict: current.researcher.verdict },
      superseded_by_report: researcher && researcher.report_id !== current.researcher.report_id ? researcher.report_id : null,
      format_notes: current.validation ? current.validation.errors : [],
    };
  }
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

function setPilot(ws, pid, on, { by = null } = {}) {
  require('./projects').getProject(ws, pid);
  return runOp(ws, { type: 'ticket_pilot', summary: `${on ? 'Start' : 'Stop'} the autonomous pilot on ${pid}` }, (op) => {
    const cur = op.readJson(profileRel(pid), null) || readProfile(ws, pid);
    if (Boolean(cur.pilot) === Boolean(on)) return { noop: true, pilot: Boolean(on) };
    op.writeJson(profileRel(pid), { ...cur, pilot: Boolean(on), pilot_set_at: new Date().toISOString(), pilot_set_by: by || ws.actor || null });
    return { pilot: Boolean(on) };
  });
}

// What the chain needs next on one project: Agent 1 (Claude research), then
// Agent 2 (the Prosecutor's ticket), then Eric. Read-only.
function nextStep(ws, pid, { now = Date.now() } = {}) {
  const research = require('./research');
  const project = require('./projects').getProject(ws, pid);
  const base = { project_id: pid, name: project.name, pilot: Boolean(readProfile(ws, pid).pilot) };
  if (project.status === 'archived') return { ...base, step: 'blocked', why: 'Archived.' };
  if (!project.identity || project.identity.status !== 'verified') return { ...base, step: 'blocked', why: 'The identity is not verified.' };
  const staleDays = (ws.settings.freshness && ws.settings.freshness.research_stale_days) || 90;
  const waitingRun = research.listRuns(ws, pid).filter((r) => !r.broken && r.jobs && r.jobs.claude && ['unconfigured', 'queued', 'dispatching', 'running', 'uncertain'].includes(r.jobs.claude.state)).pop();
  if (waitingRun) return { ...base, step: 'research', run_id: waitingRun.run_id, state: waitingRun.jobs.claude.state, why: `Claude's research run ${waitingRun.run_id} is open: finish it (Agent 1).` };
  const r = researcherOf(ws, pid);
  if (!r) return { ...base, step: 'research', run_id: null, why: 'No eligible Claude report: start Claude research (Agent 1).' };
  const ageDays = r.analysis_at ? (now - Date.parse(r.analysis_at)) / 86400000 : null;
  if (ageDays !== null && ageDays > staleDays) return { ...base, step: 'research', run_id: null, report_id: r.report_id, why: `Claude's report is ${Math.round(ageDays)} days old, past ${staleDays}: research again (Agent 1).` };
  const open = openTicket(ws, pid);
  if (open) return { ...base, step: 'ticket', ticket_id: open.ticket_id, state: open.job.state, report_id: open.basis.researcher.report_id, why: `Ticket ${open.ticket_id} is open: write the Prosecutor's ticket (Agent 2).` };
  const v = view(ws, pid, { now });
  if (v.ticket && v.ticket.status === 'reopened' && v.ticket.researcher_report_id === r.report_id) return { ...base, step: 'ticket', ticket_id: null, report_id: r.report_id, refresh: true, reopen: true, why: `Eric re-opened ticket ${v.ticket.receipt_id}: open a new one on Claude's current report ${r.report_id} (start_ticket with refresh: true). The old receipt is kept.` };
  if (!v.ticket || v.ticket.researcher_report_id !== r.report_id) {
    const why = pregateReason(r, heldOf(ws, pid, now), sizingOf(ws));
    if (why) return { ...base, step: 'gate_closed', ticket_id: null, report_id: r.report_id, reasons: [why], why: `The desk's gate is closed on Claude's current report ${r.report_id}: ${why} No Prosecutor runs; call start_ticket (tickets start) to save the desk's receipt.` };
  }
  if (!v.ticket || v.ticket.researcher_report_id !== r.report_id) return { ...base, step: 'ticket', ticket_id: null, report_id: r.report_id, why: `No ticket on Claude's current report ${r.report_id}: open one (Agent 2).` };
  if (v.ticket.status === 'pending_pm_review') return { ...base, step: 'pm_review', receipt_id: v.ticket.receipt_id, why: 'The ticket waits for Eric\'s PM review. Nothing for an agent to do.' };
  if (v.ticket.status === 'invalidated') return { ...base, step: 'done', receipt_id: v.ticket.receipt_id, status: v.ticket.status, why: 'Invalidated: Re-open ticket on the card (or tickets start --reopen). Nothing for an agent to do until then.' };
  return { ...base, step: 'done', receipt_id: v.ticket.receipt_id, status: v.ticket.status, why: `The ticket is ${v.ticket.status.replace(/_/g, ' ')}. Nothing for an agent to do until Claude's report changes.` };
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
function pilotCandidates(ws, { now = Date.now() } = {}) {
  const sizing = sizingOf(ws);
  const rows = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    const project = require('./projects').getProject(ws, p.project_id);
    if (!project.identity || project.identity.status !== 'verified') continue;
    const pid = p.project_id;
    const researcher = researcherOf(ws, pid);
    const held = heldOf(ws, pid, now) === true;
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

function pendingFor(ws) {
  const out = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    const t = openTicket(ws, p.project_id);
    if (t) out.push({ project_id: p.project_id, name: p.name, ticket_id: t.ticket_id, state: t.job.state === 'running' ? 'started' : 'waiting', created_at: t.created_at, report_id: t.basis.researcher.report_id });
  }
  return out.sort((x, y) => (x.state === y.state ? String(x.created_at).localeCompare(String(y.created_at)) : x.state === 'started' ? -1 : 1));
}

module.exports = {
  newerRuleOf,
  PROMPT_VERSION,
  FORMAT,
  SIZING_VERSION,
  INVALIDATION_VERSION,
  INVALIDATION_V1,
  PREGATE_VERSION,
  SIZING_DEFAULTS,
  TICKET_RE,
  RECEIPT_RE,
  PROPOSALS,
  sizingOf,
  gate,
  gateGrade,
  skeleton,
  researcherOf,
  loadTicket,
  listTickets,
  listReceipts,
  readDecisions,
  readDraft,
  promptFor,
  createTicket,
  prepareExitQuote,
  cancelTicket,
  saveDraft,
  saveTicket,
  receiptText,
  decide,
  invalidationOf,
  view,
  read,
  summary,
  setPilot,
  nextStep,
  pilotQueue,
  pilotCandidates,
  pendingFor,
};
