'use strict';
// The decision basis (cr.decision-basis.v1; blueprint 2026-11-02 §5.2, build
// plan row 8): what a PM or mandate decision stood on, frozen in the SAME
// operation as the decision line (tickets.decide's runOp), so both commit or
// neither does. One create-only file per decision:
//   projects/<id>/tickets/basis/<decision_id>.json
// The decision line itself stays cr.ticket-decision.v1: the protected Paper
// Book reads decisions only in that format, and nothing here changes it.
//
// Contents, all read under the decision's lock as of decided_at:
// - identity: the decision and its receipt, the receipt's own SHA-256 (of its
//   bytes as read) and its packet's and text's SHA-256 as recorded;
// - research[]: one entry per model from the desk's own selector
//   (compare.latestByProvider): the Claude report the receipt names is the
//   decision's input, any other model's report is context; a model with no
//   eligible report says why (none, held, excluded, pdf_only), never filled in;
// - prosecutor: the receipt's Prosecutor and the typed spread it recorded;
// - authority: a mandate decision's generation, armed_at, policy and tier, or
//   who decided, and the pause and project-stop state as the gate read them;
// - code_revision: the running commit (core/revision.js).
// It holds no trader rules, fee or funding: those are execution context and
// live in the book's own events.
//
// Reading it back (viewOf) is a join computed on read: the basis by decision
// ID, each referenced record read by ID and checked against its SHA-256 (the
// receipt, the packet, each report's original). A mismatch is INTEGRITY (409)
// naming the record; nothing is rebuilt and no current value is substituted.
// A decision made before this existed has no basis: its view is rebuilt from
// the records that exist now, with only the corrections dated at or before the
// decision applied, and is labeled `reconstructed`, never `decision_time`.
// Corrections dated after the decision are listed as later annotations.

const fs = require('fs');
const { OpError } = require('./ops');
const { readJson, sha256 } = require('./fsx');

const BASIS_VERSION = 'cr.decision-basis.v1';
const VIEW_VERSION = 'cr-decision-view@1';
const SPREAD_KIND = 'researcher_gate_grade_minus_prosecutor_conviction';
const DECISION_RE = /^td_[0-9a-f]{14}$/;

const basisRel = (pid, decisionId) => `projects/${pid}/tickets/basis/${decisionId}.json`;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function originalSha(ws, r) {
  const file = r.meta && r.meta.original_file;
  if (!file) return null;
  try { return sha256(fs.readFileSync(ws.abs(`${r.dir}/${file}`))); } catch (_) { return null; }
}

function gradeOf(ws, a) {
  const { gradeAssessment } = require('./rubrics');
  const g = gradeAssessment(ws, a);
  if (!g) return null;
  return {
    status: g.status || null,
    value: isNum(g.value) ? g.value : null,
    low: isNum(g.low) ? g.low : null,
    high: isNum(g.high) ? g.high : null,
    coverage_pct: isNum(g.coverage_pct) ? g.coverage_pct : null,
    missing: g.status === 'withheld' ? (g.reason || null) : null,
    rubric_sha256: g.rubric_sha256 || null,
  };
}

function reportEntry(ws, r, role, corrections) {
  const a = r.assessment || {};
  return {
    provider: r.meta.provider,
    role: 'researcher',
    use: role,
    report_id: r.report_id,
    run_id: (r.provenance && r.provenance.research_run_id) || null,
    model_version: a.model_version || null,
    ...(a.model_version ? {} : { model_version_note: a.model_version_note || null }),
    original_sha256: r.meta.original_sha256 || null,
    imported_at: r.meta.imported_at || null,
    analysis_at: a.analysis_at || null,
    versions: { prompt: a.prompt_version || null, rubric: a.rubric_version || null, profile: a.sector_profile || null },
    grade: gradeOf(ws, a),
    corrections_applied: corrections.map((c) => c.correction_id || null),
    eligible_at_decision: true,
  };
}

// Why a model has no eligible report among these records.
function absentState(ws, reports, provider) {
  const held = require('./research').heldProviders(ws)[provider];
  const mine = reports.filter((r) => !r.broken && r.meta && r.meta.provider === provider);
  if (held && !mine.length) return { state: 'held', reason: `${provider} is on hold on this desk${held.reason ? ` (${held.reason})` : ''}.` };
  if (!mine.length) return { state: 'none', reason: `No ${provider} report on this project.` };
  if (mine.every((r) => r.assessment && r.assessment.eligibility && r.assessment.eligibility.excluded)) return { state: 'excluded', reason: `Every ${provider} report on this project is excluded.` };
  if (mine.every((r) => r.assessment && (r.assessment.source_format === 'pdf' || r.assessment.needs_text))) return { state: 'pdf_only', reason: `${provider}'s reports here are PDFs with no text read.` };
  return { state: 'none', reason: `No eligible ${provider} report on this project.` };
}

// research[] from a set of report records, the desk's own selector over them.
function researchOf(ws, reports, inputReportId) {
  const { latestByProvider } = require('./compare');
  const { isEligible } = require('./reports');
  const { PROVIDERS } = require('./workspace');
  const latest = latestByProvider(reports);
  const out = [];
  for (const p of PROVIDERS) {
    // The receipt names its Claude report: that report is the decision's
    // input, as itself, even when a newer one was saved since.
    if (p === 'claude' && inputReportId) {
      const r = reports.find((x) => x.report_id === inputReportId && !x.broken) || null;
      if (r) out.push({ ...reportEntry(ws, r, 'decision_input', r.corrections || []), eligible_at_decision: isEligible(r) });
      else out.push({ provider: p, role: 'researcher', use: 'decision_input', report_id: inputReportId, state: 'missing', reason: `The report the ticket names (${inputReportId}) is not on record.` });
      continue;
    }
    const r = latest[p];
    if (r) out.push(reportEntry(ws, r, 'available_context', r.corrections || []));
    else out.push({ provider: p, role: 'researcher', use: 'available_context', ...absentState(ws, reports, p) });
  }
  return out;
}

function prosecutorOf(receipt) {
  if (!receipt || receipt.kind === 'desk_gate' || !receipt.prosecution) return null;
  const ad = receipt.agent_disagreement || {};
  const conviction = isNum(receipt.prosecution.conviction_score) ? receipt.prosecution.conviction_score : null;
  return {
    provider: (receipt.model && receipt.model.provider) || 'claude',
    model_version: (receipt.model && receipt.model.model_version) || null,
    prompt_sha256: receipt.prompt_sha256 || null,
    conviction_score: conviction,
    verdict: receipt.prosecution.verdict || null,
    spread: { kind: SPREAD_KIND, researcher_grade_used: ad.researcher && isNum(ad.researcher.grade) ? ad.researcher.grade : null, conviction, points: isNum(ad.spread_points) ? ad.spread_points : null },
  };
}

function gateStateOf(ws, pid, decisions) {
  try {
    const g = require('./mandate-authority').automationGate(ws, pid, { decisions });
    return { version: g.version || null, paused: g.paused === true, project_stopped: g.project_stopped === true, code: g.code || null };
  } catch (err) {
    return { state: 'unknown', reason: String(err && err.message || err).slice(0, 200) };
  }
}

// Built inside decide's runOp, from the receipt bytes it read there.
function buildBasis(ws, { decision, receipt, receiptText, decisions = [], revision = null }) {
  const { loadReports } = require('./reports');
  const pid = decision.project_id;
  const inputId = receipt && receipt.researcher ? receipt.researcher.report_id || null : null;
  const m = decision.mandate || null;
  return {
    schema_version: BASIS_VERSION,
    decision_id: decision.decision_id,
    project_id: pid,
    receipt_id: decision.receipt_id,
    decided_at: decision.decided_at,
    action: decision.action,
    receipt_sha256: sha256(receiptText),
    packet_sha256: receipt && receipt.packet ? receipt.packet.sha256 || null : null,
    text_sha256: receipt && receipt.text ? receipt.text.sha256 || null : null,
    research: researchOf(ws, loadReports(ws, pid), inputId),
    prosecutor: prosecutorOf(receipt),
    authority: {
      decided_by: decision.decided_by || null,
      ...(m ? { mandate: { generation: m.authority ? m.authority.generation : null, armed_at: m.authority ? m.authority.armed_at : null, policy_sha256: m.authority ? m.authority.policy_sha256 : m.settings_sha256 || null, tier: m.tier || null, expires_at: m.expires_at || null } } : {}),
      gate: gateStateOf(ws, pid, decisions),
    },
    code_revision: revision || require('./revision').revision(),
    meaning: 'What this decision stood on, read under its lock. It is never rewritten; later corrections and exclusions are annotations on read.',
  };
}

// ---------------------------------------------------------------------------
// Reading it back

function readDecisions(ws, pid) {
  let text = '';
  try { text = fs.readFileSync(ws.abs(`projects/${pid}/tickets/decisions.jsonl`), 'utf8'); } catch (_) { return []; }
  return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

function readExact(ws, rel) {
  try { return fs.readFileSync(ws.abs(rel)); } catch (_) { return null; }
}

function mustMatch(ws, rel, want, what) {
  const buf = rel ? readExact(ws, rel) : null;
  if (buf === null) throw new OpError('INTEGRITY', `${what} is missing (${rel || 'no path on record'}). It is not rebuilt; restore it from a backup.`, { path: rel || null, record: what });
  if (want && sha256(buf) !== want) throw new OpError('INTEGRITY', `${what} does not match its recorded SHA-256 (${String(want).slice(0, 12)}…): it changed after the decision. It is not rebuilt; restore it from a backup.`, { path: rel, record: what });
  return buf;
}

// Corrections and exclusions dated after the decision: annotations, never applied.
function laterAnnotations(reports, decidedAt, ids) {
  const out = [];
  for (const r of reports) {
    if (r.broken || !ids.has(r.report_id)) continue;
    for (const c of r.corrections || []) {
      if (String(c.created_at || '') > String(decidedAt)) out.push({ report_id: r.report_id, correction_id: c.correction_id || null, field: c.field || null, at: c.created_at || null, words: `${c.field === 'eligibility' ? 'Eligibility' : `Field ${c.field}`} of report ${r.report_id} corrected on ${String(c.created_at || '').slice(0, 10)}, after the decision.` });
    }
  }
  return out;
}

// The records as they stood at decidedAt: reports imported by then, with only
// the corrections dated by then applied.
function asOf(reports, decidedAt) {
  const { applyCorrections } = require('./reports');
  return reports
    .filter((r) => r.broken || String(r.meta.imported_at || '') <= String(decidedAt))
    .map((r) => {
      if (r.broken) return r;
      const kept = (r.corrections || []).filter((c) => String(c.created_at || '') <= String(decidedAt));
      return { ...r, corrections: kept, assessment: applyCorrections(r.record.assessment, kept) };
    });
}

// Execution context, beside the basis and never merged into it: what the
// trader's Paper Book recorded for this decision's orders, read from its
// journal as written (the book's own events; nothing here writes to it). The
// engine revision, FILL_SHARE_MAX and the trader rules' digest are not in
// those events, so they are said to be not recorded (blueprint §5.3 option B
// until Eric decides Q4).
const NOT_RECORDED = Object.freeze(['engine revision', 'fill_share_max', 'trader.rules digest']);
function executionOf(ws, decisionId) {
  // The path comes through the desk's one adapter; nothing here calls the
  // book (trader-boundary.test.js).
  const { JOURNAL } = require('./trader-desk');
  let text = null;
  try { text = fs.readFileSync(ws.abs(JOURNAL), 'utf8'); } catch (_) { text = null; }
  const out = { label: 'execution_time', source: JOURNAL, reserved: [], fills: [], exits: [], not_recorded: [...NOT_RECORDED] };
  if (text === null) return { ...out, state: 'no_book' };
  const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } });
  if (events.some((e) => e === null)) return { ...out, state: 'unreadable', words: `${JOURNAL} has a line that does not read; execution is not shown from a partial journal.` };
  const coids = new Set();
  const positions = new Set();
  for (const e of events) {
    if (e.type !== 'reserved' || !e.intent || e.intent.decision_id !== decisionId) continue;
    coids.add(e.client_order_id);
    if (e.position_id) positions.add(e.position_id);
    out.reserved.push({ at: e.at, intent_id: e.intent_id, intent_sha256: e.intent_sha256 || null, side: e.intent.side || null, client_order_id: e.client_order_id, position_id: e.position_id || null, quantity: e.quantity, notional_usd: e.notional_usd || null, loss_at_stop_usd: e.loss_at_stop_usd || null, valid_until_effective: e.valid_until_effective || null, venue: e.venue || null, grant: e.grant || null });
  }
  for (const e of events) {
    if (e.type === 'fill' && coids.has(e.client_order_id)) out.fills.push({ at: e.at, hour: e.hour, client_order_id: e.client_order_id, quantity: e.quantity, price: e.price, notional_usd: e.notional_usd, fee_usd: e.fee_usd, fee_kind: e.fee_kind });
    if (e.type === 'exit' && positions.has(e.position_id)) out.exits.push({ at: e.at, hour: e.hour, position_id: e.position_id, reason: e.reason, quantity: e.quantity, price: e.price, proceeds_usd: e.proceeds_usd, fee_usd: e.fee_usd });
  }
  return { ...out, state: out.reserved.length ? 'recorded' : 'none' };
}

function viewOf(ws, pid, decisionId) {
  if (!DECISION_RE.test(String(decisionId))) throw new OpError('BAD_ID', 'Name the decision (its decision ID, td_…).');
  const decision = readDecisions(ws, pid).find((d) => d.decision_id === decisionId);
  if (!decision) throw new OpError('NOT_FOUND', `No decision ${decisionId} on ${pid}.`);
  const { loadReports } = require('./reports');
  const reports = loadReports(ws, pid);
  const receiptRel = `projects/${pid}/tickets/receipts/${decision.receipt_id}.json`;
  const brel = basisRel(pid, decisionId);
  const basisBuf = readExact(ws, brel);
  if (basisBuf !== null) {
    let basis;
    try { basis = JSON.parse(basisBuf.toString('utf8')); } catch (_) { throw new OpError('INTEGRITY', `The decision basis ${brel} does not read. It is not rebuilt; restore it from a backup.`, { path: brel, record: 'The decision basis' }); }
    if (!basis || basis.schema_version !== BASIS_VERSION || basis.decision_id !== decisionId || basis.receipt_id !== decision.receipt_id || basis.decided_at !== decision.decided_at) throw new OpError('INTEGRITY', `The decision basis ${brel} does not belong to decision ${decisionId}. It is not rebuilt.`, { path: brel, record: 'The decision basis' });
    const receiptBuf = mustMatch(ws, receiptRel, basis.receipt_sha256, 'The ticket receipt');
    const receipt = JSON.parse(receiptBuf.toString('utf8'));
    if (receipt.packet && receipt.packet.path) mustMatch(ws, receipt.packet.path, basis.packet_sha256, 'The frozen ticket packet');
    if (receipt.text && receipt.text.path) mustMatch(ws, receipt.text.path, basis.text_sha256, 'The Prosecutor\'s saved text');
    const ids = new Set();
    for (const e of basis.research || []) {
      if (!e.report_id || !e.original_sha256) continue;
      ids.add(e.report_id);
      const r = reports.find((x) => x.report_id === e.report_id && !x.broken);
      if (!r) throw new OpError('INTEGRITY', `Report ${e.report_id}, on record at the decision, is gone. It is not rebuilt; restore it from a backup.`, { report_id: e.report_id, record: `Report ${e.report_id}` });
      mustMatch(ws, `${r.dir}/${r.meta.original_file}`, e.original_sha256, `The original of report ${e.report_id}`);
    }
    return { format: VIEW_VERSION, label: 'decision_time', decision, basis, later: laterAnnotations(reports, decision.decided_at, ids), execution: executionOf(ws, decisionId) };
  }
  // Before cr.decision-basis.v1: rebuilt from what exists now, as of the decision.
  const receiptBuf = readExact(ws, receiptRel);
  if (receiptBuf === null) throw new OpError('INTEGRITY', `The ticket receipt ${decision.receipt_id} is missing. It is not rebuilt; restore it from a backup.`, { path: receiptRel, record: 'The ticket receipt' });
  const receipt = JSON.parse(receiptBuf.toString('utf8'));
  if (receipt.packet && receipt.packet.path) mustMatch(ws, receipt.packet.path, receipt.packet.sha256, 'The frozen ticket packet');
  const then = asOf(reports, decision.decided_at);
  const inputId = receipt.researcher ? receipt.researcher.report_id || null : null;
  const research = researchOf(ws, then, inputId);
  const ids = new Set(research.filter((e) => e.report_id).map((e) => e.report_id));
  const m = decision.mandate || null;
  return {
    format: VIEW_VERSION,
    label: 'reconstructed',
    words: 'This decision was recorded before the desk froze a decision basis: what it stood on is rebuilt from the records that exist now, as of the decision. The receipt\'s own bytes then were not recorded.',
    decision,
    basis: {
      schema_version: null,
      decision_id: decisionId,
      project_id: pid,
      receipt_id: decision.receipt_id,
      decided_at: decision.decided_at,
      action: decision.action,
      receipt_sha256: null,
      packet_sha256: receipt.packet ? receipt.packet.sha256 || null : null,
      text_sha256: receipt.text ? receipt.text.sha256 || null : null,
      research,
      prosecutor: prosecutorOf(receipt),
      authority: { decided_by: decision.decided_by || null, ...(m ? { mandate: { generation: m.authority ? m.authority.generation : null, armed_at: m.authority ? m.authority.armed_at : null, policy_sha256: m.authority ? m.authority.policy_sha256 : m.settings_sha256 || null, tier: m.tier || null, expires_at: m.expires_at || null } } : {}), gate: { state: 'not_recorded' } },
      code_revision: { state: 'not_recorded' },
    },
    later: laterAnnotations(reports, decision.decided_at, ids),
    execution: executionOf(ws, decisionId),
  };
}

module.exports = { BASIS_VERSION, VIEW_VERSION, SPREAD_KIND, basisRel, buildBasis, viewOf };
