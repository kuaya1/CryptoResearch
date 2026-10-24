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
const SIZING_VERSION = 'cr-ticket-sizing@1';
const INVALIDATION_VERSION = 'cr-ticket-invalidation@1';
const PACKET_FORMAT = 'cr.ticket-packet.v1';
const TICKET_RE = /^tk_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const RECEIPT_RE = /^tr_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const PROPOSALS = ['ACCUMULATE', 'LIMIT_TRAP', 'TRIM_EXIT', 'WATCH_ONLY', 'HARD_PASS'];
const RISK_TAKING = new Set(['ACCUMULATE', 'LIMIT_TRAP']);
const VERDICTS = ['thesis_survives', 'thesis_damaged', 'fatal_flaw'];
const TESTS = ['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims'];
const METRIC_KEYS = ['fees', 'revenue', 'holders_revenue'];
const ACTIONS = ['approve', 'halve', 'veto', 'undo'];
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
    note: SIZING_NOTE,
  };
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
// The sizing gate (cr-ticket-sizing@1): deterministic, from the frozen basis

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
  if (!exit || exit.cost_pct === null) reasons.push(`No current exit reading at ${usd(sizing.exit_size_usd)}: the exit cost is not proven within ${sizing.max_exit_cost_pct}%.`);
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
    version: SIZING_VERSION,
    grade_used: grade,
    held,
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
  if (!args.refresh && !args.restart) {
    const done = listReceipts(ws, pid).filter((r) => !r.broken && r.researcher && r.researcher.report_id === researcher.report_id).pop();
    if (done) return { status: 'exists', project_id: pid, receipt_id: done.receipt_id, ticket_id: done.ticket_id, message: `A ticket on Claude's current report (${researcher.report_id}) is already saved (${done.receipt_id}). Nothing new was opened; pass refresh: true only when Eric asks for another.` };
  }
  if (open && args.restart) cancelTicket(ws, pid, open.ticket_id, 'Eric asked to start the ticket over.');
  const tid = `tk_${compactTs(new Date(now))}_${randomId(5)}`;
  const sizing = sizingOf(ws);
  const sizes = [...new Set([sizing.exit_size_usd, 2000])].sort((a, b) => a - b);
  const packet = {
    schema_version: PACKET_FORMAT,
    captured_at: at,
    project: { project_id: pid, name: project.name, symbol: project.symbol || null, identity: { official_website: project.identity.official_website || null, coingecko_id: project.identity.coingecko_id || null, assets: (project.identity.assets || []).map((a) => ({ chain: a.chain, contract_address: a.contract_address })) } },
    researcher: { report_id: researcher.report_id, run_id: researcher.run_id, analysis_at: researcher.analysis_at, verdict: researcher.verdict, grade: researcher.grade, rubric_version: researcher.rubric_version, sector_profile: researcher.sector_profile, original_sha256: researcher.original.sha256 },
    market: marketOf(ws, project),
    exits: exitsOf(ws, pid, sizes, now),
    sell_tax: taxOf(ws, project, now),
    fundamentals: fundamentalsOf(ws, project, now),
    held: heldOf(ws, pid, now),
    sizing,
    notes: [
      'exits: the desk\'s own exit-quote readings (aggregator quotes or constant-product reserves) as the Forensics tab reads them; a cost not known in full is a lower bound.',
      'held: whether Eric records an open position in this token (Portfolio); never its size.',
    ],
  };
  const packetText = jsonText(packet);
  const packetSha = sha256(packetText);
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
    basis: { researcher, held: packet.held, exits: packet.exits, market: packet.market },
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
      exit_cost_500_usd_pct: at500 ? at500.cost_pct : null,
      exit_cost_500_complete: at500 ? at500.cost_complete : null,
      exit_cost_500_as_of: at500 ? at500.as_of : null,
      exit_cost_2000_usd_pct: at2000 ? at2000.cost_pct : null,
      exit_cost_2000_complete: at2000 ? at2000.cost_complete : null,
      sell_tax: null,
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

function decide(ws, pid, { receipt_id: rid, action, note = null, request_id: requestId = null, by = null }) {
  if (!RECEIPT_RE.test(String(rid))) throw new OpError('BAD_ID', 'Name the ticket you decided (its receipt ID).');
  if (!ACTIONS.includes(action)) throw new OpError('INVALID', `The decision is one of ${ACTIONS.join(', ')}.`);
  const text = note === null || note === undefined ? null : String(note).replace(/\r\n/g, '\n').trim().slice(0, 1000) || null;
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const rel = decisionsRel(pid);
  return runOp(ws, { type: 'ticket_decision', summary: `PM ${action} on ${rid} for ${pid}` }, (op) => {
    const r = op.readJson(receiptRel(pid, rid), null);
    if (!r) throw new OpError('NOT_FOUND', `No ticket ${rid} for ${pid}.`);
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
      if ((action === 'approve' || action === 'halve') && !(suggested > 0)) throw new OpError('REFUSED', `This ticket suggests no risk (${r.desk ? r.desk.proposal_type : 'no proposal'}): there is nothing to approve. Veto it, or wait for a new ticket.`);
      if (inForce && inForce.action === action) return { status: 'unchanged', decision: inForce };
      const starter = r.desk && r.desk.sizing ? r.desk.sizing.starter_risk_usd : SIZING_DEFAULTS.starter_risk_usd;
      const approved = action === 'approve' ? suggested : action === 'halve' ? Math.min(starter, suggested) : 0;
      line = { action, pm_approved_risk_usd: approved, suggested_risk_usd: suggested, proposal_type: r.desk ? r.desk.proposal_type : null };
    }
    const full = { schema_version: 'cr.ticket-decision.v1', decision_id: `td_${sha256(`${pid}:${rid}:${action}:${at}:${lines.length}`).slice(0, 14)}`, project_id: pid, receipt_id: rid, ticket_id: r.ticket_id, ...line, note: text, decided_at: at, decided_by: by || ws.actor || null, request_id: reqId, meaning: 'Eric\'s PM decision on the ticket: it records his choice and places no order.' };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(full)}\n`);
    return { status: 'saved', decision: full };
  });
}

// ---------------------------------------------------------------------------
// Invalidation, evaluated on read (cr-ticket-invalidation@1)

// The lowest hourly price recorded since the ticket was saved, and the price
// now. A price trigger fires when any reading is at or below it; the metric
// trigger when DefiLlama's latest complete 30-day total, fetched after the
// ticket, is under its threshold. Unknown is unknown, never "holding".
function invalidationOf(ws, project, receipt, { now = Date.now(), fundamentals = null } = {}) {
  const inv = receipt.proposal && receipt.proposal.invalidation_trigger;
  if (!inv) return { version: INVALIDATION_VERSION, invalidated: false, checks: [] };
  const checks = [];
  const savedMs = Date.parse(receipt.saved_at);
  const cg = project.identity && project.identity.coingecko_id;
  if (isNum(inv.price_usd)) {
    let low = null;
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
          if (!low || pt.price_usd < low.price_usd) low = { price_usd: pt.price_usd, at: iso(t) };
        }
      }
      const latest = (market.readLatest(ws).assets || {})[cg];
      const lt = latest ? Date.parse(latest.source_last_updated_at || latest.fetched_at) : NaN;
      if (latest && isNum(latest.price_usd) && Number.isFinite(lt) && lt >= savedMs && (!low || latest.price_usd < low.price_usd)) low = { price_usd: latest.price_usd, at: iso(lt) };
    }
    checks.push(low === null
      ? { kind: 'price', status: 'unknown', threshold_usd: inv.price_usd, words: 'No price recorded since the ticket.' }
      : { kind: 'price', status: low.price_usd <= inv.price_usd ? 'triggered' : 'holding', threshold_usd: inv.price_usd, lowest_usd: low.price_usd, at: low.at, words: low.price_usd <= inv.price_usd ? `Price reached $${low.price_usd} at ${low.at}, at or below the invalidation price $${inv.price_usd}.` : `Lowest price since the ticket $${low.price_usd}, above $${inv.price_usd}.` });
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
  return { version: INVALIDATION_VERSION, invalidated: Boolean(hit), by: hit ? hit.kind : null, words: hit ? hit.words : null, checks };
}

// ---------------------------------------------------------------------------
// Reading: the ticket in force and its status

function statusOf(decision, invalidation) {
  if (invalidation && invalidation.invalidated) return 'invalidated';
  if (!decision) return 'pending_pm_review';
  return decision.action === 'veto' ? 'vetoed' : 'risk_granted';
}

function view(ws, pid, { now = Date.now(), fundamentals = null } = {}) {
  const project = require('./projects').getProject(ws, pid);
  const receipts = listReceipts(ws, pid).filter((r) => !r.broken);
  const decisions = readDecisions(ws, pid);
  const current = receipts[receipts.length - 1] || null;
  const open = openTicket(ws, pid);
  const researcher = researcherOf(ws, pid);
  let ticket = null;
  if (current) {
    const decision = decisionFor(decisions, current.receipt_id);
    const invalidation = invalidationOf(ws, project, current, { now, fundamentals });
    const d = current.desk || {};
    ticket = {
      receipt_id: current.receipt_id,
      ticket_id: current.ticket_id,
      saved_at: current.saved_at,
      status: statusOf(decision, invalidation),
      proposal_type: d.proposal_type,
      model_proposal_type: d.model_proposal_type,
      capped: d.gate ? d.gate.capped : null,
      gate_reasons: d.gate ? d.gate.reasons : [],
      non_consensus_thesis: current.proposal.non_consensus_thesis,
      entry_zone: current.proposal.entry_zone,
      upside_target: current.proposal.upside_target,
      invalidation_trigger: current.proposal.invalidation_trigger,
      exit_cost_500_usd_pct: d.exit_cost_500_usd_pct ?? null,
      exit_cost_500_complete: d.exit_cost_500_complete ?? null,
      exit_cost_2000_usd_pct: d.exit_cost_2000_usd_pct ?? null,
      suggested_risk_usd: d.suggested_risk_usd || 0,
      starter_risk_usd: d.sizing ? d.sizing.starter_risk_usd : SIZING_DEFAULTS.starter_risk_usd,
      pm_approved_risk_usd: decision ? decision.pm_approved_risk_usd : null,
      decision: decision ? { decision_id: decision.decision_id, action: decision.action, at: decision.decided_at, note: decision.note } : null,
      prosecution: { verdict: current.prosecution.verdict, conviction_score: current.prosecution.conviction_score, fatal_flaws: current.prosecution.fatal_flaws, tests: current.prosecution.tests },
      agent_disagreement: current.agent_disagreement,
      invalidation,
      researcher_report_id: current.researcher.report_id,
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
  const base = { project_id: pid, name: project.name };
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
  if (!v.ticket || v.ticket.researcher_report_id !== r.report_id) return { ...base, step: 'ticket', ticket_id: null, report_id: r.report_id, why: `No ticket on Claude's current report ${r.report_id}: open one (Agent 2).` };
  if (v.ticket.status === 'pending_pm_review') return { ...base, step: 'pm_review', receipt_id: v.ticket.receipt_id, why: 'The ticket waits for Eric\'s PM review. Nothing for an agent to do.' };
  return { ...base, step: 'done', receipt_id: v.ticket.receipt_id, status: v.ticket.status, why: `The ticket is ${v.ticket.status.replace(/_/g, ' ')}. Nothing for an agent to do until Claude's report changes.` };
}

function pilotQueue(ws, { project = null, now = Date.now() } = {}) {
  const list = require('./projects').listProjects(ws).filter((p) => !p.broken && (project ? p.project_id === project : readProfile(ws, p.project_id).pilot));
  return list.map((p) => nextStep(ws, p.project_id, { now }));
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
  PROMPT_VERSION,
  FORMAT,
  SIZING_VERSION,
  INVALIDATION_VERSION,
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
  cancelTicket,
  saveDraft,
  saveTicket,
  receiptText,
  decide,
  invalidationOf,
  view,
  summary,
  setPilot,
  nextStep,
  pilotQueue,
  pendingFor,
};
