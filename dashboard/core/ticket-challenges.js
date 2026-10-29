'use strict';
// ChatGPT's challenge of a saved PM ticket (intake dialectic PR 6, 2026-10-29;
// audits/2026-10-29-intake-dialectic/PLAN.md §6).
//
// projects/<id>/tickets/
//   challenges/<tc_…>/target.json          the frozen bindings (create-only)
//   challenges/<tc_…>/prompt.md            the frozen challenge prompt (create-only)
//   challenges/<tc_…>/challenge.json       the job: state, model, draft stamp,
//                                           the last refusal (operational)
//   challenges/<tc_…>/drafts/challenger.md  the text of the last refused save
//   challenge-receipts/<tcr_…>.{json,md}   the saved challenge (create-only)
//
// ChatGPT checks the Prosecutor's four tests under cr-ticket-challenge-prompt@1
// and returns cr.ticket-challenge.v1: each test agree, disagree or
// cannot_assess, a critique of the trade plan, and a verdict that must fit the
// tests. The challenge is advisory. It never changes the ticket, its status,
// the gate, the size, the decision or the book, and nothing is averaged. Its
// receipts live apart from receipts/, so no reader of tickets ever meets one,
// and no model-facing read carries its conclusions: the PM card and
// GET /api/projects/<id>/tickets/challenges read it. Every handoff, save and
// read checks the frozen target against the ticket receipt as it stands on
// disk; a mismatch is INTEGRITY, nothing written, and no verdict is shown.
// Nothing here calls a model or a paid provider.

const fs = require('fs');
const { runOp, OpError } = require('./ops');
const { readJson, listDir, sha256, jsonText } = require('./fsx');
const { compactTs, randomId, isProjectId } = require('./ids');

const PROMPT_VERSION = 'cr-ticket-challenge-prompt@1';
const FORMAT = 'cr.ticket-challenge.v1';
const TEMPLATE = 'challenge-prompt.v1.md';
const CHALLENGE_RE = /^tc_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const CRECEIPT_RE = /^tcr_\d{4}-\d{2}-\d{2}T\d{6}Z_[a-z2-9]{5}$/;
const TESTS = ['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims'];
const TEST_LABELS = { mercenary_emissions: 'Mercenary emissions', tax_revenue: 'Tax revenue', exit_slippage: 'Exit slippage', unverified_claims: 'Unverified claims' };
const ASSESSMENTS = ['agree', 'disagree', 'cannot_assess'];
const VERDICTS = ['concur', 'material_objection', 'fatal_objection', 'insufficient_evidence'];
const VERDICT_WORDS = { concur: 'concurs', material_objection: 'material objection', fatal_objection: 'fatal objection', insufficient_evidence: 'insufficient evidence' };
const BINDING = ['format', 'challenge_id', 'project_id', 'receipt_id', 'receipt_sha256', 'prompt_version', 'role', 'model'];
const FIELDS = new Set([...BINDING, 'model_version', 'as_of', 'tests', 'trade_plan_critique', 'challenge_verdict', 'verdict_reason', 'sources']);
const MIN_TEXT = 400;
const MAX_TEXT = 400 * 1024;
const OPEN = new Set(['waiting', 'running']);
const NOT_SHOWN = 'Challenge not shown: its record does not match the ticket receipt.';

const iso = (ms) => new Date(ms).toISOString();
const str = (v, max = 2000) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const normalizedTextHash = (text) => sha256(String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim());
const T = () => require('./tickets');

// ---------------------------------------------------------------------------
// Paths

function dirOf(pid) {
  if (!isProjectId(pid)) throw new OpError('BAD_ID', `Not a project ID: ${JSON.stringify(pid)}`);
  return `projects/${pid}/tickets`;
}
function challengeDir(pid, cid) {
  if (!CHALLENGE_RE.test(String(cid))) throw new OpError('BAD_ID', `Not a challenge ID: ${JSON.stringify(cid)}`);
  return `${dirOf(pid)}/challenges/${cid}`;
}
const jobRel = (pid, cid) => `${challengeDir(pid, cid)}/challenge.json`;
const targetRel = (pid, cid) => `${challengeDir(pid, cid)}/target.json`;
const promptRel = (pid, cid) => `${challengeDir(pid, cid)}/prompt.md`;
const draftRel = (pid, cid) => `${challengeDir(pid, cid)}/drafts/challenger.md`;
function creceiptRel(pid, crid, ext = 'json') {
  if (!CRECEIPT_RE.test(String(crid))) throw new OpError('BAD_ID', `Not a challenge receipt ID: ${JSON.stringify(crid)}`);
  return `${dirOf(pid)}/challenge-receipts/${crid}.${ext}`;
}
function ticketReceiptRel(pid, rid) {
  if (!T().RECEIPT_RE.test(String(rid))) throw new OpError('BAD_ID', `Not a ticket receipt ID: ${JSON.stringify(rid)}`);
  return `${dirOf(pid)}/receipts/${rid}.json`;
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
// The SHA-256 of a file's bytes as stored, or null when it is missing.
function fileSha(ws, rel) {
  try {
    return sha256(fs.readFileSync(ws.abs(rel)));
  } catch (_) {
    return null;
  }
}
const verifiedFrozen = (ws, rel, want, what) => require('./forensics').verifiedFrozen(ws, rel, want, what);

function listChallenges(ws, pid) {
  return listDir(ws.abs(`${dirOf(pid)}/challenges`), { dirs: true })
    .filter((d) => CHALLENGE_RE.test(d))
    .map((d) => {
      try {
        return readJson(ws.abs(jobRel(pid, d)), null);
      } catch (err) {
        return { challenge_id: d, broken: true, error: err.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function listChallengeReceipts(ws, pid) {
  return listDir(ws.abs(`${dirOf(pid)}/challenge-receipts`), { dirs: false })
    .filter((f) => f.endsWith('.json') && CRECEIPT_RE.test(f.slice(0, -5)))
    .map((f) => {
      try {
        return readJson(ws.abs(`${dirOf(pid)}/challenge-receipts/${f}`), null);
      } catch (err) {
        return { challenge_receipt_id: f.slice(0, -5), broken: true, error: err.message };
      }
    })
    .filter(Boolean)
    .sort((a, b) => `${a.saved_at || ''}|${a.challenge_receipt_id}`.localeCompare(`${b.saved_at || ''}|${b.challenge_receipt_id}`));
}

function loadJob(ws, pid, cid) {
  return readJson(ws.abs(jobRel(pid, cid)), null);
}

// The Prosecutor's receipt a challenge can answer: the one named, else the
// latest. The desk's gate has no Prosecutor and nothing to challenge.
function challengeable(ws, pid, rid = null) {
  const all = T().listReceipts(ws, pid).filter((r) => !r.broken);
  const r = rid ? all.find((x) => x.receipt_id === rid) || null : all.filter((x) => x.kind !== 'desk_gate').pop() || null;
  if (rid && !r) throw new OpError('NOT_FOUND', `No ticket receipt ${rid} for ${pid}.`);
  if (r && r.kind === 'desk_gate') throw new OpError('INVALID', `${r.receipt_id} is the desk's gate: no Prosecutor ran, so there is nothing to challenge.`);
  return r;
}

// ---------------------------------------------------------------------------
// The frozen target, checked on every handoff, save and read

function readInputs(ws, pid, receipt) {
  const rel = ticketReceiptRel(pid, receipt.receipt_id);
  const receiptSha = fileSha(ws, rel);
  if (!receiptSha) throw new OpError('INTEGRITY', `The ticket receipt ${receipt.receipt_id} is missing. Nothing was opened.`, { path: rel });
  const ticketText = verifiedFrozen(ws, receipt.text && receipt.text.path, receipt.text && receipt.text.sha256, `The saved text of ${receipt.receipt_id}`);
  const packetText = verifiedFrozen(ws, receipt.packet && receipt.packet.path, receipt.packet && receipt.packet.sha256, 'The frozen ticket packet');
  const ticket = T().loadTicket(ws, pid, receipt.ticket_id);
  const original = ticket && ticket.basis && ticket.basis.researcher && ticket.basis.researcher.original;
  if (!original || !original.path || !original.sha256) throw new OpError('INTEGRITY', `Ticket ${receipt.ticket_id} names no report text it prosecuted. Nothing was opened.`);
  const reportText = verifiedFrozen(ws, original.path, original.sha256, `The text of report ${ticket.basis.researcher.report_id}`);
  return {
    target: {
      receipt: { receipt_id: receipt.receipt_id, ticket_id: receipt.ticket_id, path: rel, sha256: receiptSha, text_path: receipt.text.path, text_sha256: receipt.text.sha256 },
      packet: { path: receipt.packet.path, sha256: receipt.packet.sha256 },
      report: { report_id: ticket.basis.researcher.report_id, path: original.path, sha256: original.sha256 },
    },
    ticketText,
    packetText,
    reportText,
  };
}

// Throws INTEGRITY naming what differs; returns the frozen target.
function verifyTarget(ws, job) {
  const pid = job.project_id;
  const target = JSON.parse(verifiedFrozen(ws, targetRel(pid, job.challenge_id), job.target_sha256, `The frozen target of challenge ${job.challenge_id}`));
  const now = fileSha(ws, target.receipt.path);
  if (now !== target.receipt.sha256) throw new OpError('INTEGRITY', `The ticket receipt ${target.receipt.receipt_id} ${now ? 'changed after the challenge froze it' : 'is missing'} (frozen SHA-256 ${target.receipt.sha256.slice(0, 12)}…). Nothing was handed out or saved.`, { path: target.receipt.path });
  verifiedFrozen(ws, target.receipt.text_path, target.receipt.text_sha256, `The saved text of ${target.receipt.receipt_id}`);
  verifiedFrozen(ws, target.packet.path, target.packet.sha256, 'The frozen ticket packet');
  verifiedFrozen(ws, target.report.path, target.report.sha256, `The text of report ${target.report.report_id}`);
  verifiedFrozen(ws, job.prompt.path, job.prompt.sha256, 'The frozen challenge prompt');
  return target;
}

// ---------------------------------------------------------------------------
// The prompt

function skeleton(job, target) {
  return {
    format: FORMAT,
    challenge_id: job.challenge_id,
    project_id: job.project_id,
    receipt_id: target.receipt.receipt_id,
    receipt_sha256: target.receipt.sha256,
    prompt_version: PROMPT_VERSION,
    role: 'challenger',
    model: 'chatgpt',
    model_version: null,
    as_of: 'YYYY-MM-DDTHH:MM:SSZ',
    tests: Object.fromEntries(TESTS.map((t) => [t, { assessment: ASSESSMENTS.join(' | '), reason: '', source_ids: ['X1'] }])),
    trade_plan_critique: '',
    challenge_verdict: VERDICTS.join(' | '),
    verdict_reason: '',
    sources: [{ source_id: 'X1', url: 'https://...', publisher: '', retrieved_at: '', excerpt: '' }],
  };
}

function renderPrompt(job, target, project, inputs) {
  const fill = (tpl, vars) => tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
  return fill(require('./template-lock').lockedText('tickets', TEMPLATE), {
    PROJECT_NAME: project.name,
    SYMBOL: project.symbol || 'no ticker',
    PROJECT_ID: project.project_id,
    CHALLENGE_ID: job.challenge_id,
    RECEIPT_ID: target.receipt.receipt_id,
    RECEIPT_SHA256: target.receipt.sha256,
    TICKET_TEXT: inputs.ticketText.trim(),
    PACKET_SHA256: target.packet.sha256,
    PACKET_JSON: inputs.packetText.trim(),
    REPORT_ID: target.report.report_id,
    REPORT_SHA256: target.report.sha256,
    REPORT_TEXT: inputs.reportText.trim(),
    SKELETON: `\`\`\`json\n${JSON.stringify(skeleton(job, target), null, 2)}\n\`\`\``,
  });
}

// ---------------------------------------------------------------------------
// Opening (or resuming) a challenge

function updateJob(ws, pid, cid, mutate, summary, type = 'ticket_challenge_update') {
  return runOp(ws, { type, summary }, (op) => {
    const j = op.readJson(jobRel(pid, cid), null);
    if (!j) throw new OpError('NOT_FOUND', `No challenge ${cid} for ${pid}.`);
    const res = mutate(j, op);
    if (res && res.noop) return res;
    op.writeJson(jobRel(pid, cid), j);
    return res || {};
  });
}

function handoff(ws, job, status, message) {
  const target = verifyTarget(ws, job);
  const prompt = readText(ws, job.prompt.path);
  const draft = readText(ws, draftRel(job.project_id, job.challenge_id));
  return { status, project_id: job.project_id, challenge_id: job.challenge_id, receipt_id: target.receipt.receipt_id, state: job.job.state, prompt: { version: PROMPT_VERSION, sha256: job.prompt.sha256, chars: prompt.length, text: prompt }, target: { receipt_sha256: target.receipt.sha256, packet_sha256: target.packet.sha256, report_id: target.report.report_id, report_sha256: target.report.sha256 }, draft: draft === null ? null : { text: draft, chars: draft.length, saved_at: job.job.draft_saved_at || null }, last_refusal: job.job.last_refusal || null, challenge_receipt_id: job.job.receipt_id || null, message };
}

function startChallenge(ws, { project_id: pid, receipt_id: rid = null, channel = null, utterance = null, now = Date.now() } = {}) {
  const project = require('./projects').getProject(ws, pid);
  if (project.status === 'archived') throw new OpError('REFUSED', `${project.name} is archived. Nothing was opened.`);
  const receipt = challengeable(ws, pid, rid);
  if (!receipt) return { status: 'none', project_id: pid, message: `${project.name} has no saved Prosecutor ticket to challenge.` };
  const mine = listChallenges(ws, pid).filter((c) => !c.broken && c.receipt_id === receipt.receipt_id).pop() || null;
  if (mine) {
    if (OPEN.has(mine.job.state)) {
      verifyTarget(ws, mine);
      if (mine.job.state === 'waiting') updateJob(ws, pid, mine.challenge_id, (j) => { if (j.job.state !== 'waiting') return { noop: true }; Object.assign(j.job, { state: 'running', updated_at: iso(now) }); return {}; }, `ChatGPT takes challenge ${mine.challenge_id}`);
      return handoff(ws, loadJob(ws, pid, mine.challenge_id), 'resumed', `Resuming challenge ${mine.challenge_id} of ticket ${receipt.receipt_id}${mine.job.last_refusal ? ` (the last save was refused: ${mine.job.last_refusal.fields.map((f) => f.field).join(', ')})` : ''}.`);
    }
    return handoff(ws, mine, 'saved', `Challenge ${mine.challenge_id} of ticket ${receipt.receipt_id} is already saved (${mine.job.receipt_id}). A different text is a revision: save_challenge with revision { kind, note }.`);
  }
  const inputs = readInputs(ws, pid, receipt);
  const at = iso(now);
  const cid = `tc_${compactTs(new Date(now))}_${randomId(5)}`;
  const target = { schema_version: 'cr.ticket-challenge-target.v1', challenge_id: cid, project_id: pid, created_at: at, prompt_version: PROMPT_VERSION, prompt_pin: require('./template-lock').pinOf('tickets')[TEMPLATE] || null, ...inputs.target };
  const targetText = jsonText(target);
  const job = {
    schema_version: 'cr.ticket-challenge-job.v1',
    challenge_id: cid,
    project_id: pid,
    receipt_id: receipt.receipt_id,
    ticket_id: receipt.ticket_id,
    created_at: at,
    channel: channel || ws.actor || null,
    utterance: typeof utterance === 'string' ? utterance.slice(0, 2000) : null,
    target_sha256: sha256(targetText),
    prompt: null,
    paid_requests: 'none: ChatGPT challenges through its own connection; the desk sends no model request.',
    job: { provider: 'chatgpt', role: 'challenger', state: 'running', receipt_id: null, receipts: [], draft_saved_at: null, draft_chars: null, last_refusal: null, updated_at: at, note: 'Taken by ChatGPT.' },
  };
  const prompt = renderPrompt(job, target, project, inputs);
  job.prompt = { version: PROMPT_VERSION, path: promptRel(pid, cid), sha256: sha256(prompt), chars: prompt.length };
  runOp(ws, { type: 'ticket_challenge_create', summary: `ChatGPT challenge of ${receipt.receipt_id}` }, (op) => {
    op.write(targetRel(pid, cid), targetText, { mode: 'create' });
    op.write(promptRel(pid, cid), prompt, { mode: 'create' });
    op.writeJson(jobRel(pid, cid), job, { mode: 'create' });
    return { challenge_id: cid };
  });
  return handoff(ws, job, 'created', `Opened challenge ${cid} of ticket ${receipt.receipt_id} for ${project.name}.`);
}

// ---------------------------------------------------------------------------
// The block, checked field by field

function checkBlock(b, expect) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  for (const k of Object.keys(b)) if (!FIELDS.has(k)) bad(k, `${k} is not part of ${FORMAT} (it has no proposal type, size, risk, grade or price).`);
  for (const k of BINDING) if (b[k] !== expect[k]) bad(k, `${k}: the block says ${JSON.stringify(b[k] === undefined ? null : b[k])}, this challenge's is ${JSON.stringify(expect[k])}.`);
  const sources = Array.isArray(b.sources) ? b.sources : null;
  if (!sources) bad('sources', 'sources must be a list (empty when none).');
  const ids = new Set();
  (sources || []).forEach((s, i) => {
    if (!s || typeof s !== 'object' || !str(s.source_id, 20) || !str(s.url, 600)) bad(`sources[${i}]`, `sources[${i}] needs a source_id and a url.`);
    else ids.add(str(s.source_id, 20));
  });
  const tests = {};
  const t = b.tests && typeof b.tests === 'object' && !Array.isArray(b.tests) ? b.tests : null;
  if (!t) bad('tests', 'tests is missing.');
  for (const k of Object.keys(t || {})) if (!TESTS.includes(k)) bad(`tests.${k}`, `tests.${k} is not one of the four tests.`);
  for (const k of TESTS) {
    const x = t && t[k];
    if (!x || typeof x !== 'object') { if (t) bad(`tests.${k}`, `tests.${k} missing.`); continue; }
    if (!ASSESSMENTS.includes(x.assessment)) bad(`tests.${k}.assessment`, `tests.${k}.assessment must be one of ${ASSESSMENTS.join(', ')}.`);
    if (!str(x.reason, 1500)) bad(`tests.${k}.reason`, `tests.${k}.reason is empty.`);
    if (!Array.isArray(x.source_ids)) bad(`tests.${k}.source_ids`, `tests.${k}.source_ids must be a list (empty when none).`);
    const missing = (Array.isArray(x.source_ids) ? x.source_ids : []).map(String).filter((id) => !ids.has(id));
    if (missing.length && sources) bad(`tests.${k}.source_ids`, `tests.${k} cites ${missing.join(', ')}, not in sources.`);
    tests[k] = { assessment: ASSESSMENTS.includes(x.assessment) ? x.assessment : null, reason: str(x.reason, 1500), source_ids: Array.isArray(x.source_ids) ? x.source_ids.map(String).slice(0, 20) : [] };
  }
  if (!str(b.trade_plan_critique, 3000)) bad('trade_plan_critique', 'trade_plan_critique is empty.');
  const verdict = VERDICTS.includes(b.challenge_verdict) ? b.challenge_verdict : null;
  if (!verdict) bad('challenge_verdict', `challenge_verdict must be one of ${VERDICTS.join(', ')}.`);
  if (!str(b.verdict_reason, 2000)) bad('verdict_reason', 'verdict_reason is empty.');
  // The verdict must fit the tests (B7); a test that failed its own check
  // counts as nothing, never as agreement.
  const marks = TESTS.map((k) => tests[k] && tests[k].assessment);
  const agree = marks.filter((m) => m === 'agree').length;
  const disagree = marks.filter((m) => m === 'disagree').length;
  const unassessed = marks.filter((m) => m === 'cannot_assess').length;
  if (verdict && unassessed === TESTS.length && verdict !== 'insufficient_evidence') bad('challenge_verdict', `All four tests are cannot_assess: the only verdict that fits is insufficient_evidence, not ${verdict}.`);
  else if (verdict === 'concur' && (agree < 1 || disagree > 0)) bad('challenge_verdict', `concur needs at least one agree and no disagree (the tests give ${agree} agree, ${disagree} disagree).`);
  else if ((verdict === 'material_objection' || verdict === 'fatal_objection') && disagree < 1) bad('challenge_verdict', `${verdict} needs at least one disagree (the tests give none).`);
  return {
    errors,
    content: {
      model_version: str(b.model_version, 120) || null,
      as_of: str(b.as_of, 40) || null,
      tests,
      trade_plan_critique: str(b.trade_plan_critique, 3000),
      challenge_verdict: verdict,
      verdict_reason: str(b.verdict_reason, 2000),
      sources: (sources || []).filter((s) => s && typeof s === 'object').slice(0, 80).map((s) => ({ source_id: str(s.source_id, 20), url: str(s.url, 600), publisher: str(s.publisher, 200) || null, retrieved_at: str(s.retrieved_at, 40) || null, excerpt: str(s.excerpt, 600) || null })),
      assessed: TESTS.length - unassessed,
    },
  };
}

// A refused save keeps its text as the draft and names the fields (B8); the
// job stays open. Then the refusal is thrown.
function refuse(ws, job, body, fields, message) {
  const pid = job.project_id;
  const cid = job.challenge_id;
  updateJob(ws, pid, cid, (j, op) => {
    const at = iso(Date.now());
    op.write(draftRel(pid, cid), body);
    if (j.job.state === 'waiting') j.job.state = 'running';
    Object.assign(j.job, { draft_saved_at: at, draft_chars: body.length, last_refusal: { at, fields: fields.slice(0, 30), message: message.slice(0, 600) }, updated_at: at });
    return {};
  }, `Challenge ${cid}: save refused`, 'ticket_challenge_draft');
  throw new OpError('INVALID', `Not saved: ${message} The text is kept as the draft; correct it and save again.`, { fields });
}

function saveChallenge(ws, { project_id: pid, challenge_id: cid, text, revision = null, channel = null }) {
  if (require('./research').heldProviders(ws).chatgpt) throw new OpError('REFUSED', 'ChatGPT is on hold on this desk; nothing was saved.');
  const body = typeof text === 'string' ? text : '';
  if (!body.trim()) throw new OpError('INVALID', 'The text is empty. Nothing was saved.');
  if (Buffer.byteLength(body) > MAX_TEXT) throw new OpError('INVALID', `The text is larger than ${MAX_TEXT / 1024} KB. Nothing was saved.`);
  const job = loadJob(ws, pid, cid);
  if (!job) throw new OpError('NOT_FOUND', `No challenge ${cid} for ${pid}.`);
  let target;
  try {
    target = verifyTarget(ws, job);
  } catch (err) {
    if (err.code !== 'INTEGRITY') throw err;
    throw new OpError('INTEGRITY', `Not saved: ${err.message} Keep the text: nothing was written.`, err.details);
  }
  if (body.trim().length < MIN_TEXT) refuse(ws, job, body, [{ field: 'text', message: 'too short' }], `That is too short to be the finished challenge (${body.trim().length} characters). Save the whole text with its JSON block.`);
  const found = require('./forensics').findBlock(body, FORMAT);
  if (!found.obj) refuse(ws, job, body, [{ field: 'json_block', message: 'missing' }], `No ${FORMAT} JSON block was found${found.errors && found.errors.length ? `: ${found.errors.join(' ')}` : ''}.`);
  const b = found.obj;
  const expect = { format: FORMAT, challenge_id: cid, project_id: pid, receipt_id: target.receipt.receipt_id, receipt_sha256: target.receipt.sha256, prompt_version: PROMPT_VERSION, role: 'challenger', model: 'chatgpt' };
  const checked = checkBlock(b, expect);
  if (checked.errors.length) refuse(ws, job, body, checked.errors, checked.errors.map((e) => e.message).join(' '));
  const c = checked.content;
  const textHash = normalizedTextHash(body);
  const prior = () => listChallengeReceipts(ws, pid).filter((r) => !r.broken && r.challenge_id === cid);
  const same = prior().find((r) => r.text && r.text.normalized_sha256 === textHash);
  if (same) return { status: 'unchanged', challenge_receipt_id: same.challenge_receipt_id, receipt: same, verified: true, message: `This exact challenge is already saved as ${same.challenge_receipt_id}.` };
  const last = prior().pop() || null;
  let rev = null;
  if (last) {
    const kinds = Object.keys(require('./revisions').REVISION_KINDS);
    const note = revision && typeof revision.note === 'string' ? revision.note.trim() : '';
    const kind = revision && kinds.includes(revision.kind) ? revision.kind : null;
    if (!kind || note.length < 15) refuse(ws, job, body, [{ field: 'revision', message: 'missing' }], `${last.challenge_receipt_id} is already saved for this challenge. A different text is a revision: pass revision { kind (${kinds.join(', ')}), note } saying in a sentence what changed and why.`);
    rev = { of: last.challenge_receipt_id, kind, note: note.slice(0, 600) };
  }
  let receipt = null;
  const out = runOp(ws, { type: 'ticket_challenge_receipt', summary: `ChatGPT challenge of ${target.receipt.receipt_id}` }, (op) => {
    const again = prior().find((r) => r.text && r.text.normalized_sha256 === textHash);
    if (again) return { replay: again };
    const j = op.readJson(jobRel(pid, cid), null);
    if (!j) throw new OpError('NOT_FOUND', `No challenge ${cid} for ${pid}.`);
    const now = Date.now();
    const crid = `tcr_${compactTs(new Date(now))}_${randomId(5)}`;
    const savedAt = iso(now);
    const asOf = c.as_of ? Date.parse(c.as_of) : NaN;
    receipt = {
      schema_version: 'cr.ticket-challenge-receipt.v1',
      challenge_receipt_id: crid,
      challenge_id: cid,
      project_id: pid,
      receipt_id: target.receipt.receipt_id,
      ticket_id: target.receipt.ticket_id,
      saved_at: savedAt,
      as_of: Number.isFinite(asOf) ? iso(Math.min(asOf, now)) : savedAt,
      model: { provider: 'chatgpt', role: 'challenger', model_version: c.model_version, channel: channel || ws.actor || null, saved_by: ws.actor || null },
      prompt_version: PROMPT_VERSION,
      prompt_sha256: job.prompt.sha256,
      target_sha256: job.target_sha256,
      target: { receipt_sha256: target.receipt.sha256, text_sha256: target.receipt.text_sha256, packet_sha256: target.packet.sha256, report_id: target.report.report_id, report_sha256: target.report.sha256 },
      text: { path: creceiptRel(pid, crid, 'md'), sha256: sha256(body), normalized_sha256: textHash, chars: body.length },
      block_sha256: sha256(JSON.stringify(b)),
      revision_of: rev ? rev.of : null,
      revision: rev,
      tests: c.tests,
      assessed: c.assessed,
      trade_plan_critique: c.trade_plan_critique,
      challenge_verdict: c.challenge_verdict,
      verdict_reason: c.verdict_reason,
      sources: c.sources,
    };
    op.write(receipt.text.path, body, { mode: 'create' });
    op.writeJson(creceiptRel(pid, crid), receipt, { mode: 'create' });
    Object.assign(j.job, { state: 'saved', receipt_id: crid, receipts: [...(j.job.receipts || []), crid], last_refusal: null, saved_at: j.job.saved_at || savedAt, updated_at: savedAt });
    op.writeJson(jobRel(pid, cid), j);
    return { challenge_receipt_id: crid };
  });
  if (out.result && out.result.replay) return { status: 'unchanged', challenge_receipt_id: out.result.replay.challenge_receipt_id, receipt: out.result.replay, verified: true, message: `This exact text is already saved as ${out.result.replay.challenge_receipt_id}.` };
  return {
    status: out.verified ? 'saved' : 'unverified',
    challenge_receipt_id: receipt.challenge_receipt_id,
    receipt,
    verified: out.verified,
    message: out.verified
      ? `Saved challenge ${receipt.challenge_receipt_id} of ticket ${receipt.receipt_id}: ${VERDICT_WORDS[c.challenge_verdict]} (${c.assessed} of 4 tests assessed). It is advisory: the ticket, its size and Eric's decision are unchanged.${rev ? ` A revision of ${rev.of}; the original is unchanged.` : ''}`
      : `The desk wrote ${receipt.challenge_receipt_id} but could not confirm it read back as written. Save the same text again; if it landed, nothing changes.`,
  };
}

// ---------------------------------------------------------------------------
// Reading: the card's row and the GET route

// Does a saved challenge still answer the ticket receipt on disk? Its text is
// hashed against its record, its target against the job's pin, and the
// target's receipt against the receipt's bytes now. Reads only.
function receiptHolds(ws, pid, cr) {
  try {
    const md = readText(ws, cr.text && cr.text.path);
    if (md === null || sha256(md) !== cr.text.sha256) return false;
    const job = loadJob(ws, pid, cr.challenge_id);
    if (!job || job.target_sha256 !== cr.target_sha256) return false;
    const target = verifyTarget(ws, job);
    return target.receipt.receipt_id === cr.receipt_id && target.receipt.sha256 === cr.target.receipt_sha256;
  } catch (_) {
    return false;
  }
}

const assessedWords = (n) => `${n} of 4 tests assessed`;
function verdictWords(cr) {
  if (cr.challenge_verdict === 'insufficient_evidence') return `ChatGPT: insufficient evidence (${assessedWords(cr.assessed)}): ${cr.verdict_reason}`;
  return `ChatGPT challenge: ${VERDICT_WORDS[cr.challenge_verdict] || cr.challenge_verdict} (${assessedWords(cr.assessed)})`;
}
const fmtTime = (s) => String(s || '').replace('T', ' ').slice(0, 16);

// One row for the PM card on a ticket receipt: always a state and its words,
// never an empty space. Reads only.
function rowFor(ws, pid, rid, { decision = undefined } = {}) {
  const receipts = listChallengeReceipts(ws, pid).filter((r) => !r.broken && r.receipt_id === rid);
  const latest = receipts[receipts.length - 1] || null;
  const job = listChallenges(ws, pid).filter((c) => !c.broken && c.receipt_id === rid).pop() || null;
  const base = { receipt_id: rid, challenge_id: job ? job.challenge_id : latest ? latest.challenge_id : null };
  if (latest) {
    if (!receiptHolds(ws, pid, latest)) return { ...base, state: 'integrity', words: NOT_SHOWN, verdict: null, tests: null };
    const d = decision === undefined ? T().decisionFor(T().readDecisions(ws, pid), rid) : decision;
    const late = d && d.decided_at && Date.parse(latest.saved_at) > Date.parse(d.decided_at);
    return {
      ...base,
      state: 'saved',
      challenge_receipt_id: latest.challenge_receipt_id,
      saved_at: latest.saved_at,
      verdict: latest.challenge_verdict,
      verdict_label: VERDICT_WORDS[latest.challenge_verdict] || latest.challenge_verdict,
      verdict_reason: latest.verdict_reason,
      assessed: latest.assessed,
      assessed_words: assessedWords(latest.assessed),
      tests: TESTS.map((k) => ({ key: k, label: TEST_LABELS[k], assessment: latest.tests[k] ? latest.tests[k].assessment : null, reason: latest.tests[k] ? latest.tests[k].reason : '' })),
      trade_plan_critique: latest.trade_plan_critique,
      revisions: receipts.length - 1,
      after_decision: Boolean(late),
      after_decision_words: late ? `Arrived after your decision, ${fmtTime(latest.saved_at)}` : null,
      words: verdictWords(latest),
    };
  }
  const none = { verdict: null, tests: null };
  if (job && OPEN.has(job.job.state)) {
    try {
      verifyTarget(ws, job);
    } catch (_) {
      return { ...base, ...none, state: 'integrity', words: NOT_SHOWN };
    }
    const r = job.job.last_refusal;
    if (r) return { ...base, ...none, state: 'refused', fields: r.fields.map((f) => f.field), words: `ChatGPT challenge refused: ${r.fields.slice(0, 3).map((f) => { const m = String(f.message || '').replace(/\.$/, ''); return m.startsWith(f.field) ? m : `${f.field}: ${m}`; }).join('; ')}${r.fields.length > 3 ? ` (${r.fields.length - 3} more)` : ''}` };
    return { ...base, ...none, state: 'draft', words: 'ChatGPT challenge: started, nothing saved yet' };
  }
  if (require('./research').heldProviders(ws).chatgpt) return { ...base, ...none, state: 'on_hold', words: 'No ChatGPT challenge: ChatGPT is on hold' };
  const open = require('./research').openJobsFor(ws, pid, 'chatgpt');
  if (open.length) return { ...base, ...none, state: 'blocked', run_id: open[0].run.run_id, words: 'No ChatGPT challenge yet: its own research on this project is open' };
  return { ...base, ...none, state: 'none', words: 'No ChatGPT challenge: not started' };
}

// GET /api/projects/<id>/tickets/challenges: the row for the ticket in force
// (or the receipt named) and every saved challenge on the project, each said
// to hold or not. A record that does not hold carries no verdict.
function challengesView(ws, pid, { receiptId = null } = {}) {
  require('./projects').getProject(ws, pid);
  if (receiptId !== null && !T().RECEIPT_RE.test(String(receiptId))) throw new OpError('BAD_ID', `"${receiptId}" is not a ticket receipt ID (tr_...).`);
  const all = T().listReceipts(ws, pid).filter((r) => !r.broken);
  const current = receiptId ? all.find((r) => r.receipt_id === receiptId) || null : all[all.length - 1] || null;
  if (receiptId && !current) throw new OpError('NOT_FOUND', `No ticket receipt ${receiptId} for ${pid}.`);
  const row = !current ? null : current.kind === 'desk_gate' ? { receipt_id: current.receipt_id, state: 'desk_gate', words: 'No ChatGPT challenge: the desk\'s gate ran no Prosecutor', verdict: null, tests: null } : rowFor(ws, pid, current.receipt_id);
  const challenges = listChallengeReceipts(ws, pid).filter((r) => !r.broken).map((r) => {
    const holds = receiptHolds(ws, pid, r);
    return holds
      ? { challenge_receipt_id: r.challenge_receipt_id, challenge_id: r.challenge_id, receipt_id: r.receipt_id, saved_at: r.saved_at, holds: true, verdict: r.challenge_verdict, assessed: r.assessed, revision_of: r.revision_of }
      : { challenge_receipt_id: r.challenge_receipt_id, challenge_id: r.challenge_id, receipt_id: r.receipt_id, saved_at: r.saved_at, holds: false, words: NOT_SHOWN };
  }).reverse();
  return { project_id: pid, receipt_id: current ? current.receipt_id : null, row, challenges };
}

// What waits for ChatGPT: each active project's latest Prosecutor ticket with
// no saved challenge, the one ChatGPT started first. A project where ChatGPT's
// own research is open is listed as blocked, without prompt, target or draft.
function pendingFor(ws) {
  const out = [];
  for (const p of require('./projects').listProjects(ws)) {
    if (p.broken || p.status === 'archived') continue;
    let r;
    try { r = challengeable(ws, p.project_id); } catch (_) { r = null; }
    if (!r) continue;
    const job = listChallenges(ws, p.project_id).filter((c) => !c.broken && c.receipt_id === r.receipt_id).pop() || null;
    if (job && job.job.state === 'saved') continue;
    const open = require('./research').openJobsFor(ws, p.project_id, 'chatgpt');
    const item = { project_id: p.project_id, name: p.name, receipt_id: r.receipt_id, saved_at: r.saved_at, challenge_id: job ? job.challenge_id : null, state: job ? 'started' : 'waiting' };
    if (open.length) Object.assign(item, { blocked: `your own research on this project is open (run ${open[0].run.run_id})`, state: 'blocked' });
    out.push(item);
  }
  const rank = { started: 0, waiting: 1, blocked: 2 };
  return out.sort((x, y) => rank[x.state] - rank[y.state] || String(x.saved_at).localeCompare(String(y.saved_at)));
}

module.exports = {
  PROMPT_VERSION,
  FORMAT,
  TEMPLATE,
  CHALLENGE_RE,
  CRECEIPT_RE,
  TESTS,
  VERDICTS,
  NOT_SHOWN,
  listChallenges,
  listChallengeReceipts,
  loadJob,
  verifyTarget,
  skeleton,
  startChallenge,
  saveChallenge,
  checkBlock,
  rowFor,
  challengesView,
  pendingFor,
};
