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
// A stop of Eric's (veto, Undo, a pass that archives) whose basis could not be
// built (audit F1) has an unavailable record in its place (unavailableBasis
// below) and reads `unavailable`.

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
// When the basis cannot be built (audit F1, 2026-11-02)
//
// Eric's stop actions are the ones the desk documents as stopping a project
// (DESK_STATE.md "One stop per project stops everything on it"): his veto and
// his Undo, whose lines latch it (mandate-authority.js autonomyOf), and his
// confirmed pass on a project he does not hold, which archives it
// (DESK_STATE.md, "Confirm Pass & Archive (archives the project unless
// held)"). A failure building the basis (a report that does not load, a rubric
// that does not read, anything buildBasis calls) must never hold one of those
// back, so tickets.decide records this in the basis's place, at the same path,
// create-only and in the same operation. It is not a basis: it names the
// decision and the failure and nothing else, no part of a basis is filled in,
// and it is never replaced by one built later. viewOf reads it as
// `unavailable`, never `decision_time` or `reconstructed`. Every other
// decision still commits only with its basis: a grant, any mandate line, a
// watch, a trim, a re-open, and a pass on a held project (which stays watched
// and stops nothing).
const UNAVAILABLE_VERSION = 'cr.decision-basis-unavailable.v1';

function stopsProject(decision) {
  if (!decision || (typeof decision.decided_by === 'string' && decision.decided_by.startsWith('mandate:'))) return false;
  return decision.action === 'veto' || decision.action === 'undo' || (decision.action === 'pass' && decision.archive === 'archived');
}

function unavailableBasis({ decision, error }) {
  if (!stopsProject(decision)) throw new OpError('INVALID', `Only Eric's veto, Undo or a pass that archives is recorded without its basis, never ${decision.action}${decision.action === 'pass' ? ` (${decision.archive || 'no archive'})` : ''}.`);
  return {
    schema_version: UNAVAILABLE_VERSION,
    decision_id: decision.decision_id,
    project_id: decision.project_id,
    receipt_id: decision.receipt_id,
    decided_at: decision.decided_at,
    action: decision.action,
    state: 'unavailable',
    failure: { code: error && typeof error.code === 'string' ? error.code.slice(0, 60) : null, words: String((error && error.message) || error || 'unknown failure').slice(0, 300) },
    meaning: 'What this decision stood on could not be read under its lock (the failure above), so no basis was recorded. This is not a basis: nothing in it is filled in, and it is never rebuilt or replaced later. It says nothing of whether the decision still applies; the decision history says that.',
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

// The one identity contract every reader of the record at a decision's basis
// path applies (viewOf, stateOf, and through viewOf the attribution view and
// the CLI): the record names this decision, its project, receipt, time and
// action, under a schema it can be read by. Returns the fields that fail.
function identityProblems(rec, decision) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['record'];
  const bad = [];
  if (rec.schema_version !== BASIS_VERSION && rec.schema_version !== UNAVAILABLE_VERSION) bad.push('schema_version');
  for (const k of ['decision_id', 'project_id', 'receipt_id', 'decided_at', 'action']) if (rec[k] !== decision[k]) bad.push(k);
  if (rec.schema_version === UNAVAILABLE_VERSION) {
    if (rec.state !== 'unavailable') bad.push('state');
    if (!rec.failure || typeof rec.failure !== 'object' || typeof rec.failure.words !== 'string') bad.push('failure');
    if (!stopsProject(decision)) bad.push('action (only a stop is recorded without its basis)');
    for (const k of ['research', 'receipt_sha256', 'authority']) if (k in rec) bad.push(k);
  }
  if (rec.schema_version === BASIS_VERSION) {
    if (typeof rec.receipt_sha256 !== 'string' || !HEX64.test(rec.receipt_sha256)) bad.push('receipt_sha256');
    if (!Array.isArray(rec.research)) bad.push('research');
    if ('state' in rec || 'failure' in rec) bad.push('state');
  }
  // A record whose digest could not be recorded (N1): only one of Eric's
  // stops, its failure in words, and no ledger declaration beside it.
  if ('digest_unrecorded' in rec) {
    const u = rec.digest_unrecorded;
    if (!u || typeof u !== 'object' || Array.isArray(u) || typeof u.words !== 'string') bad.push('digest_unrecorded');
    if ('digest_ledger' in rec) bad.push('digest_ledger');
    if (!stopsProject(decision)) bad.push('digest_unrecorded (only a stop is recorded without its digest)');
  }
  return bad;
}

function integrityError(rel, decisionId, bad) {
  return new OpError('INTEGRITY', `The decision basis ${rel} does not belong to decision ${decisionId} (${bad.join(', ')}). It is not rebuilt.`, { path: rel, record: 'The decision basis', fields: bad });
}

// ---------------------------------------------------------------------------
// Read-time integrity of the record at a basis path (audit F3, 2026-11-02)
//
// Create-only writes stop the desk from overwriting a record; they say nothing
// of what is read back later. So every record written at a basis path (a basis
// or an unavailable record) has its exact bytes' SHA-256 appended, in the same
// operation, to the project's digest ledger, one line per record, each line
// naming the SHA-256 of the line before it. Reading verifies the bytes against
// it: a one-byte change, a valid-JSON edit, a swapped or removed record, a
// removed or altered ledger line, a ledger that does not read: each is an
// INTEGRITY refusal naming the record, never rebuilt and never replaced by
// current values. Each new record also declares the ledger (`digest_ledger`),
// so removing the whole ledger is refused too. A record written before the
// ledger existed (no declaration, decided before the project's first digest)
// carries no digest: it is read as recorded and labelled `unverified`, never
// as verified decision-time history, and no digest is invented for it. The
// v1 decision line and every existing record keep their bytes.
const DIGEST_VERSION = 'cr.decision-basis-digest.v1';
const digestRel = (pid) => `projects/${pid}/tickets/basis-digests.jsonl`;
const ledgerLines = (text) => String(text || '').split('\n').filter((l) => l !== '');

// Stage a record and its digest line in the caller's operation. It never
// parses the ledger, so a ledger whose lines do not read cannot hold back a
// stop (audit F1): its line still chains to the raw line before it.
//
// A ledger whose bytes cannot be read at all (EIO, a permission, anything the
// disk answers) cannot be appended to: its prior lines are unknown, and
// writing without them would destroy them. For one of Eric's stops (his veto,
// Undo or a pass that archives; `decision` is the line being recorded) that
// never holds the decision back (N1, post-remediation audit 2026-11-02): the
// record is staged with `digest_unrecorded` (the failure, in its own words)
// in place of the ledger declaration, the ledger is left exactly as it was,
// and every reader says the record's bytes cannot be checked. Anything else,
// a grant, a mandate line, a watch, a trim, a re-open, is refused as before.
function stageRecord(op, pid, rec, decision = null) {
  const { jsonText } = require('./fsx');
  let cur;
  try {
    cur = op.readText(digestRel(pid), '');
  } catch (err) {
    if (!decision || decision.decision_id !== rec.decision_id || !stopsProject(decision)) throw err;
    const unrecorded = { ...rec, digest_unrecorded: { code: err && typeof err.code === 'string' ? err.code.slice(0, 60) : null, words: String((err && err.message) || err || 'unknown failure').slice(0, 300) } };
    op.write(basisRel(pid, rec.decision_id), Buffer.from(jsonText(unrecorded), 'utf8'), { mode: 'create' });
    return unrecorded;
  }
  const declared = { ...rec, digest_ledger: DIGEST_VERSION };
  const buf = Buffer.from(jsonText(declared), 'utf8');
  op.write(basisRel(pid, rec.decision_id), buf, { mode: 'create' });
  const lines = ledgerLines(cur);
  const line = {
    schema_version: DIGEST_VERSION,
    seq: lines.length + 1,
    decision_id: rec.decision_id,
    decided_at: rec.decided_at,
    record_schema: rec.schema_version,
    record_sha256: sha256(buf),
    prev_sha256: lines.length ? sha256(Buffer.from(lines[lines.length - 1], 'utf8')) : null,
  };
  op.write(digestRel(pid), `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`);
  return declared;
}

function ledgerError(pid, words) {
  const rel = digestRel(pid);
  return new OpError('INTEGRITY', `The decision-basis digest ledger ${rel} ${words} It is not rebuilt; restore it from a backup.`, { path: rel, record: 'The decision-basis digest ledger' });
}

// The ledger as recorded, each line checked: it reads, it is in sequence, and
// it chains to the line before it. One decision has at most one line.
function ledgerOf(ws, pid) {
  const buf = readExact(ws, digestRel(pid));
  const out = { entries: new Map(), first_decided_at: null };
  if (buf === null) return out;
  const lines = ledgerLines(buf.toString('utf8'));
  lines.forEach((text, i) => {
    let e = null;
    try { e = JSON.parse(text); } catch (_) { throw ledgerError(pid, `line ${i + 1} does not read.`); }
    if (!e || e.schema_version !== DIGEST_VERSION || e.seq !== i + 1 || !DECISION_RE.test(String(e.decision_id)) || typeof e.record_sha256 !== 'string' || !HEX64.test(e.record_sha256) || typeof e.decided_at !== 'string') throw ledgerError(pid, `line ${i + 1} is not a digest line in sequence.`);
    const want = i ? sha256(Buffer.from(lines[i - 1], 'utf8')) : null;
    if (e.prev_sha256 !== want) throw ledgerError(pid, `line ${i + 1} does not follow the line before it (a line was removed, added or changed).`);
    if (out.entries.has(e.decision_id)) throw ledgerError(pid, `names decision ${e.decision_id} twice.`);
    out.entries.set(e.decision_id, e);
    if (out.first_decided_at === null || e.decided_at < out.first_decided_at) out.first_decided_at = e.decided_at;
  });
  return out;
}

// The record at a decision's basis path, its bytes verified against the
// ledger. Returns { buf, digest } with digest 'verified', 'not_recorded' (a
// record from before the ledger), 'unrecorded' (one of Eric's stops recorded
// while the ledger could not be read, N1; with its `failure`) or 'none' (no
// record: a decision from before the basis); anything that does not hold is
// thrown as INTEGRITY.
function verifiedRecord(ws, pid, decision) {
  const id = decision.decision_id;
  const rel = basisRel(pid, id);
  const buf = readExact(ws, rel);
  const ledger = ledgerOf(ws, pid);
  const e = ledger.entries.get(id) || null;
  if (e) {
    if (buf === null) throw new OpError('INTEGRITY', `The decision basis ${rel} is missing, though its digest is on record (line ${e.seq}). It is not rebuilt; restore it from a backup.`, { path: rel, record: 'The decision basis' });
    if (sha256(buf) !== e.record_sha256) throw new OpError('INTEGRITY', `The decision basis ${rel} does not match its recorded SHA-256 (${e.record_sha256.slice(0, 12)}…): it changed after the decision. It is not rebuilt; restore it from a backup.`, { path: rel, record: 'The decision basis' });
    return { buf, digest: 'verified', entry: e };
  }
  let parsed = null;
  if (buf !== null) { try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; } }
  const declares = Boolean(parsed && parsed.digest_ledger);
  // One of Eric's stops recorded while the ledger could not be read (N1): no
  // line was written for it, so its bytes cannot be checked. Read as such,
  // never as verified; the identity check still holds it (identityProblems).
  if (!declares && parsed && parsed.digest_unrecorded && stopsProject(decision)) return { buf, digest: 'unrecorded', failure: parsed.digest_unrecorded };
  const afterLedger = ledger.first_decided_at !== null && String(decision.decided_at) >= ledger.first_decided_at;
  if (declares || afterLedger) {
    throw new OpError('INTEGRITY', `${buf === null ? 'Neither the decision basis nor its digest is' : `The digest of the decision basis ${rel} is not`} on record in ${digestRel(pid)}, though ${declares ? 'the record declares one' : 'this decision came after the project\'s first digest'}. It is not rebuilt; restore it from a backup.`, { path: rel, record: 'The decision basis' });
  }
  return { buf, digest: buf === null ? 'none' : 'not_recorded' };
}

const UNVERIFIED_WORDS = 'This basis was written before the desk recorded each basis\'s SHA-256, so its bytes cannot be checked: it is read as recorded and is not verified decision-time history. No digest is put in its place.';

const UNAVAILABLE_WORDS = (rec) => `No basis could be recorded when this decision was made (${rec.failure && rec.failure.words ? rec.failure.words : 'no reason on record'}). It is never rebuilt. This says nothing of whether the decision still applies.`;

const LEDGER_WORDS = (rec) => {
  const u = rec.digest_unrecorded || {};
  return `The digest ledger could not be read when this decision was recorded (${u.code ? `${u.code}: ` : ''}${u.words || 'no reason on record'}), so this record's SHA-256 was not recorded and its bytes cannot be checked: it is read as recorded and is not verified decision-time history. The stop was not held back for it, and no digest is added later.`;
};

// What a decide() answer says of the record it wrote or found, under the
// identity contract. It never speaks of current authority.
function describe(rec, decision) {
  const bad = identityProblems(rec, decision);
  if (bad.length) return { state: 'integrity', fields: bad, words: `The record at this decision's basis path does not match the decision (${bad.join(', ')}); its view refuses it as INTEGRITY. Nothing is rebuilt.` };
  if (rec.schema_version === UNAVAILABLE_VERSION) return { state: 'unavailable', words: rec.digest_unrecorded ? `${UNAVAILABLE_WORDS(rec)} ${LEDGER_WORDS(rec)}` : UNAVAILABLE_WORDS(rec) };
  if (rec.digest_unrecorded) return { state: 'unverified', words: LEDGER_WORDS(rec) };
  return { state: 'frozen' };
}

// The record on file for a decision, as stored (a replay builds nothing).
function stateOf(ws, pid, decision) {
  let v;
  try { v = verifiedRecord(ws, pid, decision); } catch (err) {
    if (err.code !== 'INTEGRITY') throw err;
    return { state: 'integrity', fields: ['record'], words: `${err.message} Its view refuses it as INTEGRITY.` };
  }
  if (v.buf === null) return { state: 'none', words: 'No basis is on record for this decision; its view is rebuilt and labelled reconstructed.' };
  let rec = null;
  try { rec = JSON.parse(v.buf.toString('utf8')); } catch (_) { return { state: 'integrity', fields: ['record'], words: 'The record at this decision\'s basis path does not read; its view refuses it as INTEGRITY. Nothing is rebuilt.' }; }
  const d = describe(rec, decision);
  if (d.state === 'frozen' && v.digest === 'not_recorded') return { state: 'unverified', words: UNVERIFIED_WORDS };
  return d;
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

// A SHA-256 the basis must hold for a record it names (audit F7): absent,
// null or not a lowercase SHA-256 is INTEGRITY, never a check skipped and
// read as verified. A report that genuinely carried no digest is the one
// exception, and viewOf handles it apart, by name.
function digestOnRecord(rec, field, what, brel) {
  const want = rec ? rec[field] : undefined;
  if (typeof want === 'string' && HEX64.test(want)) return want;
  const why = !rec || !(field in rec) ? 'has no SHA-256 in the basis' : want === null ? 'has a null SHA-256 in the basis' : 'has a recorded SHA-256 that is not one';
  throw new OpError('INTEGRITY', `${what} ${why} (${field}), so it cannot be checked. It is not taken as verified and nothing is put in its place; restore the basis from a backup.`, { path: brel, record: what, field });
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
// trader's Paper Book recorded for this decision's orders, read through the
// desk's one adapter (trader-desk.js executionFor), which runs the book's own
// integrity checks over the bytes it shows (audit F5). A journal the book
// refuses is refused here in the book's own words: state 'integrity' and no
// values, never an empty list (unknown is not none). Nothing writes. The
// engine revision, FILL_SHARE_MAX and the trader rules' digest are not in
// those events, so they are said to be not recorded (blueprint §5.3 option B
// until Eric decides Q4).
const NOT_RECORDED = Object.freeze(['engine revision', 'fill_share_max', 'trader.rules digest']);
function executionOf(ws, decisionId) {
  const TD = require('./trader-desk');
  const out = { label: 'execution_time', source: TD.JOURNAL, not_recorded: [...NOT_RECORDED] };
  try {
    return { ...out, ...TD.executionFor(ws, decisionId) };
  } catch (err) {
    if (!err || err.code !== 'INTEGRITY') throw err;
    return { ...out, state: 'integrity', code: 'INTEGRITY', words: err.message, reserved: null, fills: null, exits: null };
  }
}

function viewOf(ws, pid, decisionId) {
  if (!DECISION_RE.test(String(decisionId))) throw new OpError('BAD_ID', 'Name the decision (its decision ID, td_…).');
  const decision = readDecisions(ws, pid).find((d) => d.decision_id === decisionId);
  if (!decision) throw new OpError('NOT_FOUND', `No decision ${decisionId} on ${pid}.`);
  const { loadReports } = require('./reports');
  const reports = loadReports(ws, pid);
  const receiptRel = `projects/${pid}/tickets/receipts/${decision.receipt_id}.json`;
  const brel = basisRel(pid, decisionId);
  const verified = verifiedRecord(ws, pid, decision);
  const basisBuf = verified.buf;
  if (basisBuf !== null) {
    let basis;
    try { basis = JSON.parse(basisBuf.toString('utf8')); } catch (_) { throw new OpError('INTEGRITY', `The decision basis ${brel} does not read. It is not rebuilt; restore it from a backup.`, { path: brel, record: 'The decision basis' }); }
    const bad = identityProblems(basis, decision);
    if (bad.length) throw integrityError(brel, decisionId, bad);
    // A stop recorded without its basis (unavailableBasis): said as such, with
    // nothing rebuilt or put in its place, and nothing said of current authority.
    if (basis.schema_version === UNAVAILABLE_VERSION) {
      return {
        format: VIEW_VERSION,
        label: 'unavailable',
        digest: verified.digest === 'verified' ? 'verified' : 'not_recorded',
        words: `What this decision stood on could not be read under its lock, so its basis was not recorded. ${UNAVAILABLE_WORDS(basis)} No current value is put in its place.${verified.digest === 'unrecorded' ? ` ${LEDGER_WORDS(basis)}` : ''}`,
        ...(verified.digest === 'unrecorded' ? { ledger_failure: basis.digest_unrecorded } : {}),
        decision,
        basis: null,
        unavailable: basis,
        later: [],
        execution: executionOf(ws, decisionId),
      };
    }
    const receiptBuf = mustMatch(ws, receiptRel, basis.receipt_sha256, 'The ticket receipt');
    const receipt = JSON.parse(receiptBuf.toString('utf8'));
    let packet = null;
    if (receipt.packet && receipt.packet.path) {
      const what = 'The frozen ticket packet';
      const want = digestOnRecord(basis, 'packet_sha256', what, brel);
      if (receipt.packet.sha256 !== want) throw new OpError('INTEGRITY', `${what}'s SHA-256 in the basis is not the one its receipt records. It is not taken as verified; restore the basis from a backup.`, { path: brel, record: what, field: 'packet_sha256' });
      try { packet = JSON.parse(mustMatch(ws, receipt.packet.path, want, what).toString('utf8')); } catch (err) { if (err instanceof OpError) throw err; packet = null; }
    }
    if (receipt.text && receipt.text.path) mustMatch(ws, receipt.text.path, digestOnRecord(basis, 'text_sha256', 'The Prosecutor\'s saved text', brel), 'The Prosecutor\'s saved text');
    const ids = new Set();
    const originals = [];
    for (const e of basis.research || []) {
      // A stated absence (the report the ticket names, not on record then)
      // names no original to check; the basis says so in its own words.
      if (!e || !e.report_id || (e.state === 'missing' && !('original_sha256' in e))) continue;
      ids.add(e.report_id);
      const what = `The original of report ${e.report_id}`;
      const r = reports.find((x) => x.report_id === e.report_id && !x.broken);
      if (!r) throw new OpError('INTEGRITY', `Report ${e.report_id}, on record at the decision, is gone. It is not rebuilt; restore it from a backup.`, { report_id: e.report_id, record: `Report ${e.report_id}` });
      const rel = `${r.dir}/${r.meta.original_file}`;
      if (e.original_sha256 === null) {
        // The report carried no digest when the decision was made. The
        // ticket's frozen packet (checked above) may hold the one it had when
        // the ticket was opened: the original is checked against that.
        const frozen = packet && packet.researcher && packet.researcher.report_id === e.report_id ? packet.researcher.original_sha256 : null;
        if (typeof frozen === 'string' && HEX64.test(frozen)) {
          mustMatch(ws, rel, frozen, what);
          originals.push({ report_id: e.report_id, use: e.use || null, digest: 'verified', against: 'packet' });
          continue;
        }
        mustMatch(ws, rel, null, what); // still there; its bytes cannot be checked
        originals.push({ report_id: e.report_id, use: e.use || null, digest: 'not_recorded', provider: e.provider || null });
        continue;
      }
      mustMatch(ws, rel, digestOnRecord(e, 'original_sha256', what, brel), what);
      originals.push({ report_id: e.report_id, use: e.use || null, digest: 'verified', against: 'basis' });
    }
    const unchecked = originals.filter((o) => o.digest === 'not_recorded');
    const shown = originals.map(({ provider, ...o }) => o);
    const reasons = [];
    // A basis from before the digest ledger, or one of Eric's stops recorded
    // while the ledger could not be read (N1): read as recorded, never called
    // verified.
    if (verified.digest === 'unrecorded') reasons.push(LEDGER_WORDS(basis));
    else if (verified.digest !== 'verified') reasons.push(UNVERIFIED_WORDS);
    if (unchecked.length) {
      const named = unchecked.map((o) => `report ${o.report_id} (${o.provider || 'model not stated'})`).join(', ');
      reasons.push(`The original of ${named} carried no SHA-256 when this decision was made, so its bytes cannot be checked against what the decision stood on: this basis is read as recorded and is not verified decision-time history. No digest is put in its place.`);
    }
    const digest = verified.digest === 'verified' ? 'verified' : 'not_recorded';
    if (reasons.length) return { format: VIEW_VERSION, label: 'unverified', words: reasons.join(' '), digest, ...(verified.digest === 'unrecorded' ? { ledger_failure: basis.digest_unrecorded } : {}), decision, basis, originals: shown, later: laterAnnotations(reports, decision.decided_at, ids), execution: executionOf(ws, decisionId) };
    return { format: VIEW_VERSION, label: 'decision_time', digest: 'verified', decision, basis, originals: shown, later: laterAnnotations(reports, decision.decided_at, ids), execution: executionOf(ws, decisionId) };
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

module.exports = { BASIS_VERSION, UNAVAILABLE_VERSION, DIGEST_VERSION, VIEW_VERSION, SPREAD_KIND, basisRel, digestRel, buildBasis, unavailableBasis, stageRecord, stopsProject, identityProblems, describe, stateOf, ledgerOf, verifiedRecord, viewOf, executionOf };
