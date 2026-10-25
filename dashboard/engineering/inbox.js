'use strict';
// The private engineering inbox (Connected Engineering v1, Eric 2026-10-25;
// audits/2026-10-25-connected-engineering). Records live on the desk's disk
// under engineering/, never in Git; every change is one runOp (the workspace
// lock, staged files, read-back verification, recovery): an event file is
// created, never rewritten, and the task's snapshot replaced in the same commit.
//
// Who may do what is decided here on every call, whatever a tool's metadata
// says: `who` is { kind: 'connection', assistant, role, grant_id } from the
// OAuth grant, { kind: 'owner' } for Eric signed in on the desk, or null for
// the public reads the GitHub workflows make. A field in a tool's arguments
// never authorizes anything.

const crypto = require('crypto');
const fs = require('fs');
const { runOp, OpError, readConsistent } = require('../core/ops');
const { readJson, exists, listDir } = require('../core/fsx');
const P = require('./policy');

const ROOT = 'engineering';
const S = {
  state: 'cr.eng-state.v1',
  policy: 'cr.eng-policy.v1',
  task: 'cr.eng-task.v1',
  version: 'cr.eng-task-version.v1',
  instruction: 'cr.eng-instruction.v1',
  event: 'cr.eng-event.v1',
  review: 'cr.eng-review.v1',
  admission: 'cr.eng-admission.v1',
  attestation: 'cr.eng-attestation.v1',
};
const TASK_ID_RE = /^eng-\d{8}-[0-9a-f]{6}$/;
const POLICY_ID_RE = /^pol-\d{8}-[0-9a-f]{6}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TERMINAL = ['merged', 'cancelled', 'superseded'];
const CLAIMABLE = ['admitted', 'queued', 'claimed', 'implementing', 'verifying', 'ready_for_promotion'];
const VERIFY_COMMANDS = ['node dashboard/cli.js test'];
const MAX_DIFF = 400 * 1024;
const MAX_TAIL = 20 * 1024;
const MAX_NOTE = 4000;
// Arguments that claim authority. They are refused, never read: authority is
// the server's own policy record or Eric's confirmation on the desk.
const FORGED = ['approved', 'approval', 'approved_by', 'authorization', 'authorization_ref', 'authorized', 'authorized_by', 'owner_approved', 'owner_approval', 'owner_request', 'owner_confirmed', 'policy_id', 'policy_version', 'status', 'admitted', 'signature', 'signed_by'];

const iso = (ms) => new Date(ms).toISOString();
const ymd = (ms) => iso(ms).slice(0, 10).replace(/-/g, '');
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const connKey = (who) => (who && who.grant_id ? P.sha256(String(who.grant_id)).slice(0, 8) : who && who.kind === 'owner' ? 'owner' : 'none');
const fail = (code, message, details) => { throw new OpError(code, message, details); };
const clone = (o) => JSON.parse(JSON.stringify(o));
const nowOf = (opts) => (opts && Number.isFinite(opts.now) ? opts.now : Date.now());

const rel = {
  state: () => `${ROOT}/state.json`,
  policy: (id) => `${ROOT}/policies/${id}.json`,
  task: (id) => `${ROOT}/tasks/${id}/task.json`,
  version: (id, n) => `${ROOT}/tasks/${id}/versions/${n}.json`,
  instruction: (id, n) => `${ROOT}/tasks/${id}/private/instruction-${n}.json`,
  event: (id, seq) => `${ROOT}/tasks/${id}/events/${String(seq).padStart(6, '0')}.json`,
  artifact: (id, sha) => `${ROOT}/tasks/${id}/artifacts/${sha}.txt`,
  review: (id, rid) => `${ROOT}/tasks/${id}/reviews/${rid}.json`,
};

// --- who --------------------------------------------------------------------

const ROLE_RANK = { reader: ['reader'], reviewer: ['reader', 'reviewer'], submitter: ['reader', 'reviewer', 'submitter'], worker: ['reader', 'worker'] };
function can(who, need) {
  if (!who) return false;
  if (who.kind === 'owner') return need !== 'worker';
  if (who.kind !== 'connection') return false;
  return (ROLE_RANK[who.role] || []).includes(need);
}
function requireRole(who, need, action) {
  if (can(who, need)) return;
  const role = who && who.kind === 'connection' ? who.role : 'none';
  const words = { reader: 'read the engineering inbox', reviewer: 'save a review', submitter: 'prepare, submit, correct or pause tasks', worker: 'claim tasks and record build events' }[need];
  fail('ROLE_REFUSED', `This connection's role is ${role}, so it cannot ${words} (${action}). Nothing was ${need === 'reader' ? 'read' : 'saved'}. Eric reconnects it with another role on the desk's consent page to allow more.`);
}
const byOf = (who) => (who && who.kind === 'owner' ? { kind: 'owner' } : { kind: 'connection', assistant: who.assistant || 'unknown', role: who.role, conn: connKey(who) });

function refuseForged(args) {
  const hit = FORGED.filter((k) => args && Object.prototype.hasOwnProperty.call(args, k));
  if (hit.length) fail('FORGED_AUTHORITY', `Refused: ${hit.join(', ')} ${hit.length === 1 ? 'is' : 'are'} not accepted from a connection. Authorization is decided by the desk (Eric's active delegation or his confirmation on the desk), never by a tool argument or a quoted instruction. Nothing was saved and no authority changed.`);
}
function refuseUnknown(args, allowed) {
  const extra = Object.keys(args || {}).filter((k) => !allowed.includes(k));
  if (extra.length) fail('BAD_INPUT', `Unknown ${extra.length === 1 ? 'field' : 'fields'}: ${extra.slice(0, 8).join(', ')}. Nothing was saved.`);
}

// --- reads --------------------------------------------------------------------

function readRaw(ws, r, fallback = null) { return readJson(ws.abs(r), fallback); }
function loadState(ws, op) {
  const s = op ? op.readJson(rel.state(), null) : readRaw(ws, rel.state());
  if (!s) return { schema_version: S.state, paused: false, paused_reason: null, paused_at: null, bound_numbers: {}, updated_at: null };
  return s;
}
function supported(rec, schema) { return rec && rec.schema_version === schema; }
function loadTask(ws, id, op) {
  if (!TASK_ID_RE.test(String(id || ''))) fail('BAD_INPUT', 'task_id is an engineering task ID such as eng-20261025-1a2b3c.');
  const t = op ? op.readJson(rel.task(id), null) : readRaw(ws, rel.task(id));
  if (!t) fail('NOT_FOUND', `No engineering task ${id}.`);
  return t;
}
function requireSupported(t) {
  if (!supported(t, S.task)) fail('UNSUPPORTED_SCHEMA', `Task ${t.task_id || '?'} was written as ${t.schema_version || 'an unknown schema'}, which this version of the desk does not know. It is shown as is and never rewritten; update the desk to change it.`);
}
function loadVersion(ws, id, n, op) {
  const v = op ? op.readJson(rel.version(id, n), null) : readRaw(ws, rel.version(id, n));
  if (!v) fail('NOT_FOUND', `Task ${id} has no version ${n}.`);
  return v;
}
function taskIds(ws) {
  return listDir(ws.abs(`${ROOT}/tasks`), { dirs: true }).filter((d) => TASK_ID_RE.test(d));
}
function policies(ws, op) {
  return listDir(ws.abs(`${ROOT}/policies`), { dirs: false }).filter((f) => f.endsWith('.json')).map((f) => {
    const id = f.slice(0, -5);
    return op ? op.readJson(rel.policy(id), null) : readRaw(ws, rel.policy(id));
  }).filter(Boolean).sort((a, b) => String(a.activated_at).localeCompare(String(b.activated_at)));
}
const policyActive = (p, now) => supported(p, S.policy) && !p.revoked_at && Date.parse(p.expires_at) > now;
const restoredCopy = (ws) => exists(ws.abs('config/restored-copy.json'));

// Whether a task's authorization still stands now (a revoked delegation ends
// it; an expired one only stops new admissions).
function authorizationHolds(ws, t, op) {
  const a = t.authorization;
  if (!a) return { ok: false, why: 'not authorized' };
  if (a.version !== t.current_version || a.content_sha256 !== t.versions[t.versions.length - 1].content_sha256) return { ok: false, why: `the authorization is for version ${a.version}, not the current version ${t.current_version}` };
  if (a.kind === 'policy') {
    const p = op ? op.readJson(rel.policy(a.policy_id), null) : readRaw(ws, rel.policy(a.policy_id));
    if (!p) return { ok: false, why: `delegation ${a.policy_id} is missing` };
    if (p.revoked_at) return { ok: false, why: `delegation ${a.policy_id} was revoked ${p.revoked_at}` };
  }
  return { ok: true };
}

// The review that decides a task: the stricter of its version's declared
// review and the one its authorization recorded (inside a delegation, the
// stricter of the declared review and the delegation's).
const requiredReview = (t) => P.stricterReview(t.required_review || 'none', t.authorization ? t.authorization.required_review : null);

// The latest review per reviewer kind on the current candidate.
function reviewState(t, need = requiredReview(t)) {
  const cand = t.candidate;
  const onHead = cand ? (t.reviews || []).filter((r) => r.head_sha === cand.head_sha && r.merge_base_sha === cand.merge_base_sha) : [];
  const counts = (r) => r.reviewer.kind === 'owner' || r.reviewer.kind === need;
  const deciding = onHead.filter(counts);
  const latest = deciding.length ? deciding[deciding.length - 1] : null;
  const state = need === 'none' ? 'not_required' : !cand ? 'pending' : latest ? latest.result : 'pending';
  return { required: need, state, satisfied: need === 'none' || (latest && latest.result === 'pass'), latest: latest ? { review_id: latest.review_id, result: latest.result, reviewer: latest.reviewer, at: latest.at } : null, others: onHead.filter((r) => !counts(r)).map((r) => ({ review_id: r.review_id, result: r.result, reviewer: r.reviewer, assigned: r.assigned, at: r.at })) };
}

function nextAction(t, now) {
  const n = t.admission && t.admission.number;
  const review = reviewState(t);
  switch (t.status) {
    case 'prepared': return t.intent === 'explore' ? 'A note only: an explore task is never built. Prepare a design or implement task to build something.' : 'Submit this version (engineering_submit_task with its version and content_sha256).';
    case 'awaiting_authorization': return `Eric authorizes version ${t.current_version} in the desk's Preferences > Developer > Engineering (or activates a delegation that covers it), then submit again. ${t.status_reason || ''}`.trim();
    case 'admitted':
      if (!t.admission || t.admission.state === 'unbound') return 'Worker: claim it, allocate the next backlog number from Git, record admission_number.';
      if (t.admission.state === 'bound') return `Worker: push claude/admission-${t.task_id} with the bound entry for item ${n}, then record remote_action push_admission observed.`;
      if (t.admission.state === 'pushed') return `The engineering-admission workflow adds item ${n} to main; the worker then reads main back and records admission_confirmed.`;
      return 'Worker: claim it.';
    case 'queued': return t.corrections && t.corrections.some((c) => !c.resolved_by_head) ? `Worker: claim it and correct the open findings for item ${n}.` : `Worker: claim it and build item ${n} on claude/candidate-eng-${n}.`;
    case 'claimed': return `Worker: build item ${n} on claude/candidate-eng-${n} (record started).`;
    case 'implementing': return 'Worker: record the candidate (head, base, diff) when it is committed.';
    case 'verifying': return 'Worker: run node dashboard/cli.js test on the candidate and record verification with every acceptance check.';
    case 'review_pending': return `Review by ${review.required}: engineering_get_evidence, then engineering_save_review for head ${t.candidate ? t.candidate.head_sha.slice(0, 12) : '?'} in an active conversation. Nothing reviews it unattended.`;
    case 'ready_for_promotion': return t.release ? `Waiting for backlog-pr to merge claude/backlog-eng-${n}; the worker records merged from Git readback.` : `Worker: push the candidate head to claude/backlog-eng-${n}; backlog-pr promotes it when the desk's attestation holds.`;
    case 'merged': return 'Merged. Deployment is reported on its own.';
    case 'blocked': return `Blocked: ${t.status_reason || 'see events'}. Eric decides (Reopen on the desk, or a new task).`;
    case 'paused': return 'Paused: nothing is claimed, admitted or promoted until Eric resumes it on the desk.';
    case 'cancelled': return 'Cancelled.';
    case 'superseded': return 'Superseded by a newer task.';
    default: return `Unknown state ${t.status}.`;
  }
}

// --- the view -------------------------------------------------------------------

function view(ws, t, who, { now = Date.now() } = {}) {
  if (!supported(t, S.task)) return { task_id: t.task_id || null, schema_version: t.schema_version || null, unsupported: true, says: `Written as ${t.schema_version || 'an unknown schema'}, which this desk version does not read; shown as is and never rewritten.` };
  const ver = readRaw(ws, rel.version(t.task_id, t.current_version));
  const content = ver && supported(ver, S.version) ? ver.content : null;
  const lease = t.lease && Date.parse(t.lease.expires_at) > now ? { generation: t.lease.generation, holder: t.lease.holder, purpose: t.lease.purpose, claimed_at: t.lease.claimed_at, expires_at: t.lease.expires_at } : null;
  const review = reviewState(t);
  const unknown = Object.entries(t.remote_actions || {}).filter(([, a]) => a.phase === 'intent').map(([k, a]) => ({ action: k, ref: a.ref, sha: a.sha, since: a.at }));
  const out = {
    task_id: t.task_id,
    title: t.title,
    intent: t.intent,
    status: t.status,
    status_reason: t.status_reason || null,
    next_action: nextAction(t, now),
    version: t.current_version,
    content_sha256: t.versions[t.versions.length - 1].content_sha256,
    content,
    executable: t.intent !== 'explore',
    authorization: t.authorization ? { kind: t.authorization.kind, version: t.authorization.version, policy_id: t.authorization.policy_id || null, template: t.authorization.template || null, rule: t.authorization.rule || null, why: t.authorization.why || null, required_review: requiredReview(t), review_basis: t.authorization.review_basis || null, release_mode: t.authorization.release_mode || null, at: t.authorization.at, holds: authorizationHolds(ws, t).ok } : null,
    admission: t.admission ? { number: t.admission.number, state: t.admission.state, entry_sha256: t.admission.entry_sha256 || null, branch: t.admission.number ? `claude/admission-${t.task_id}` : null, confirmed_main_sha: t.admission.confirmed_main_sha || null } : null,
    lease,
    generation: t.generation,
    attempts: { count: t.attempts.count, max: t.attempts.max },
    candidate: t.candidate ? { head_sha: t.candidate.head_sha, base_sha: t.candidate.base_sha, merge_base_sha: t.candidate.merge_base_sha, branch: t.candidate.branch, files: t.candidate.files, diff_sha256: t.candidate.diff_sha256, attempt: t.candidate.attempt, recorded_at: t.candidate.recorded_at } : null,
    verification: t.verification ? { head_sha: t.verification.head_sha, command: t.verification.command, exit_code: t.verification.exit_code, total: t.verification.total, passed: t.verification.passed, failed: t.verification.failed, ok: t.verification.ok, acceptance: t.verification.acceptance.map((a) => ({ index: a.index, met: a.met })), recorded_at: t.verification.recorded_at, reported_by: 'worker' } : null,
    review,
    corrections: (t.corrections || []).map((c) => ({ correction_id: c.correction_id, at: c.at, by: c.by, head_sha: c.head_sha, resolved_by_head: c.resolved_by_head || null })),
    dispatch_unknown: unknown,
    release: t.release || null,
    merge: t.merge || null,
    created_at: t.created_at,
    updated_at: t.updated_at,
    events: listDir(ws.abs(`${ROOT}/tasks/${t.task_id}/events`), { dirs: false }).slice(-25).map((f) => { const e = readRaw(ws, `${ROOT}/tasks/${t.task_id}/events/${f}`); return e ? { seq: e.seq, type: e.type, at: e.at, by: e.by } : null; }).filter(Boolean),
  };
  if (who && (who.kind === 'owner' || who.role === 'submitter') && ver && ver.instruction_ref) {
    const ins = readRaw(ws, rel.instruction(t.task_id, t.current_version));
    out.original_instruction = ins ? { text: ins.text, sha256: ins.sha256, private: true } : null;
  }
  return out;
}

// --- the mutation frame ---------------------------------------------------------

function newTaskRecord(id, who, now) {
  return { schema_version: S.task, task_id: id, created_at: iso(now), created_by: byOf(who), title: null, intent: null, repo_full_name: P.REPO, required_review: 'none', current_version: 0, versions: [], status: 'prepared', status_reason: null, status_at: iso(now), paused_from: null, authorization: null, admission: null, lease: null, generation: 0, attempts: { count: 0, max: P.MAX_ATTEMPTS, last_failure_sha256: null }, candidate: null, candidates: [], verification: null, reviews: [], corrections: [], remote_actions: {}, release: null, merge: null, seq: 0, updated_at: iso(now) };
}

// One verified commit: fn(task, ctx) changes a copy of the snapshot and adds
// events; nothing is written when it adds none.
function mutate(ws, { taskId, create = null, type, key = null, payload = null, now }, fn) {
  return runOp(ws, { type: `engineering_${type}`, summary: `engineering ${type} ${taskId || ''}`.trim(), idempotencyKey: key, payloadHash: key ? P.sha256(P.canonical(payload)) : null }, (op) => {
    let t;
    if (create) t = create;
    else {
      t = clone(loadTask(ws, taskId, op));
      requireSupported(t);
    }
    const ctx = { op, now, events: [], state: null, stateDirty: false };
    ctx.emit = (etype, data = {}, by = null) => ctx.events.push({ type: etype, data, by });
    ctx.getState = () => { if (!ctx.state) ctx.state = clone(loadState(ws, op)); return ctx.state; };
    const result = fn(t, ctx);
    if (!ctx.events.length) return result;
    for (const e of ctx.events) {
      t.seq += 1;
      op.writeJson(rel.event(t.task_id, t.seq), { schema_version: S.event, task_id: t.task_id, seq: t.seq, type: e.type, at: iso(now), by: e.by, data: e.data }, { mode: 'create' });
    }
    t.updated_at = iso(now);
    op.writeJson(rel.task(t.task_id), t);
    if (ctx.stateDirty) { ctx.state.updated_at = iso(now); op.writeJson(rel.state(), ctx.state); }
    return result;
  });
}
const setStatus = (t, status, reason, now) => { t.status = status; t.status_reason = reason || null; t.status_at = iso(now); };

// --- connection: prepare, submit --------------------------------------------------

const PREPARE_FIELDS = ['task_id', 'title', 'intent', 'outcome', 'scope', 'non_goals', 'acceptance', 'dependencies', 'required_review', 'release_mode', 'reviews_requested', 'goal_id', 'parent_backlog_id', 'repo_full_name', 'original_instruction', 'idempotency_key'];

function prepareTask(ws, who, args = {}, opts = {}) {
  const now = nowOf(opts);
  requireRole(who, 'submitter', 'engineering_prepare_task');
  refuseForged(args);
  refuseUnknown(args, PREPARE_FIELDS);
  const content = P.contentOf(args);
  const bad = P.validateContent(content);
  if (bad.length) fail('BAD_INPUT', `Not saved: ${bad.join('; ')}.`);
  const instruction = args.original_instruction === undefined || args.original_instruction === null ? null : String(args.original_instruction);
  if (instruction !== null && instruction.length > P.LIMITS.instruction) fail('BAD_INPUT', `original_instruction is over ${P.LIMITS.instruction} characters.`);
  const hash = P.contentHash(content);
  const key = args.idempotency_key ? `eng-prepare-${connKey(who)}-${String(args.idempotency_key).slice(0, 80)}` : null;
  const payload = { ...args };
  const existing = args.task_id ? String(args.task_id) : null;
  const id = existing || `eng-${ymd(now)}-${rnd(3)}`;
  if (!existing && exists(ws.abs(rel.task(id)))) fail('RETRY', 'A task ID collided; call again.');
  const r = mutate(ws, { taskId: id, create: existing ? null : newTaskRecord(id, who, now), type: 'prepare', key, payload, now }, (t, ctx) => {
    const last = t.versions[t.versions.length - 1];
    if (existing) {
      if (TERMINAL.includes(t.status) || t.status === 'paused' || t.status === 'blocked') fail('NOT_EDITABLE', `Task ${id} is ${t.status}; prepare a new task instead.`);
      if (t.admission && t.admission.state && t.admission.state !== 'unbound') fail('EDIT_AFTER_ADMISSION', `Task ${id} already holds backlog item ${t.admission.number}; its content can no longer change. Use engineering_request_correction within its scope, or prepare a new task.`);
      if (last && last.content_sha256 === hash) return { task_id: id, unchanged: true };
    }
    const n = t.current_version + 1;
    ctx.op.writeJson(rel.version(id, n), { schema_version: S.version, task_id: id, version: n, content_sha256: hash, content, created_at: iso(now), created_by: byOf(who), instruction_ref: instruction !== null ? P.sha256(instruction) : null }, { mode: 'create' });
    if (instruction !== null) ctx.op.writeJson(rel.instruction(id, n), { schema_version: S.instruction, task_id: id, version: n, text: instruction, sha256: P.sha256(instruction), relayed_by: byOf(who), at: iso(now) }, { mode: 'create' });
    const replaced = existing && ['awaiting_authorization', 'admitted'].includes(t.status) ? t.status : null;
    t.versions.push({ version: n, content_sha256: hash, created_at: iso(now) });
    t.current_version = n;
    t.title = content.title;
    t.intent = content.intent;
    t.required_review = content.required_review;
    if (replaced) {
      t.authorization = null;
      if (t.admission) t.admission = null;
    }
    setStatus(t, 'prepared', replaced ? `version ${n} replaces the version that was ${replaced === 'admitted' ? 'authorized' : 'waiting for Eric'}; it needs submitting (and authorizing) again` : null, now);
    ctx.emit('version_created', { version: n, content_sha256: hash, replaced_status: replaced }, byOf(who));
    return { task_id: id, unchanged: false };
  });
  // A replayed request names the task it made the first time.
  const tid = (r.result && r.result.task_id) || id;
  const t = readRaw(ws, rel.task(tid));
  // Which delegation this version would be admitted under if submitted now.
  const match = content.intent === 'explore' ? null : matchForTask(ws, t, t.current_version, now);
  return { task_id: tid, version: t.current_version, content_sha256: t.versions[t.versions.length - 1].content_sha256, status: t.status, executable: content.intent !== 'explore', unchanged: Boolean(r.result && r.result.unchanged) || Boolean(r.replayed), verified: r.verified, match, says: content.intent === 'explore' ? `Saved ${id} as a note (explore). Nothing is queued and nothing will be built.` : `Saved ${id} version ${t.current_version} (sha256 ${t.versions[t.versions.length - 1].content_sha256.slice(0, 12)}). It is a draft: nothing is queued until it is submitted. ${match.says}`, next_action: nextAction(t, now) };
}

function openUnder(ws, policyId, exceptId) {
  return taskIds(ws).map((id) => readRaw(ws, rel.task(id))).filter((t) => t && t.task_id !== exceptId && supported(t, S.task) && t.authorization && t.authorization.policy_id === policyId && !TERMINAL.includes(t.status)).length;
}
function admittedSince(ws, policyId, since, exceptId) {
  return taskIds(ws).map((id) => readRaw(ws, rel.task(id))).filter((t) => t && t.task_id !== exceptId && supported(t, S.task) && t.authorization && t.authorization.policy_id === policyId && Date.parse(t.authorization.at) > since).length;
}

// Every active delegation, whether a version fits it (and why not), and the
// one it is admitted under (P.choose, P.MATCH_RULE). Reads only.
function matchOf(ws, content, { now, exceptId = null, op = null }) {
  const active = policies(ws, op).filter((p) => policyActive(p, now));
  const rows = active.map((p) => ({ policy: p, reasons: P.fits(p, content, { now, openUnderPolicy: openUnder(ws, p.policy_id, exceptId), admittedLastDay: admittedSince(ws, p.policy_id, now - 86400000, exceptId) }) }));
  const pick = P.choose(rows.filter((r) => !r.reasons.length).map((r) => r.policy));
  return { active, rows, pick };
}
const missedText = (m) => (m.active.length ? `outside every active delegation: ${m.rows.map((r) => `${r.policy.policy_id} (${r.policy.template}): ${r.reasons.join('; ')}`).join(' | ')}` : 'no delegation is active');
const reviewWords = (b) => `review ${b.required_review}${b.review_basis.declared !== b.required_review ? ` (declared ${b.review_basis.declared}; the delegation requires ${b.review_basis.delegation})` : ''}`;
// The match in words for a connection: the delegation it is (or would be)
// admitted under and the rules it is held to, or what each delegation misses.
function matchView(m, content, { would }) {
  const out = { rule: P.MATCH_RULE, delegation: null, considered: m.rows.map((r) => ({ policy_id: r.policy.policy_id, template: r.policy.template, fits: !r.reasons.length, chosen: Boolean(m.pick && m.pick.policy === r.policy), reasons: r.reasons })) };
  if (m.pick) {
    const p = m.pick.policy;
    const b = P.boundaries(p, content);
    out.delegation = { policy_id: p.policy_id, template: p.template, title: p.title, decided_by: m.pick.decided_by, why: m.pick.why, required_review: b.required_review, review_basis: b.review_basis, release_mode: b.release_mode, limits: b.limits, expires_at: p.expires_at };
    out.says = `${would ? 'Would be admitted' : 'Admitted'} under ${p.template} (${p.policy_id}), ${m.pick.why}. Held to ${reviewWords(b)}, release ${b.release_mode}, at most ${b.limits.max_files} files.`;
  } else out.says = `${would ? 'Would wait' : 'Waits'} for Eric to authorize this exact version on the desk: ${missedText(m)}.`;
  return out;
}
// The same for an authorization already recorded.
function authorizedView(t) {
  const a = t.authorization;
  if (a.kind !== 'policy') return { rule: null, delegation: null, considered: [], says: `Authorized by Eric for version ${a.version}; held to review ${requiredReview(t)}.` };
  const b = { required_review: requiredReview(t), review_basis: a.review_basis || { declared: t.required_review, delegation: null }, release_mode: a.release_mode || null };
  return { rule: a.rule || null, delegation: { policy_id: a.policy_id, template: a.template, why: a.why || null, required_review: b.required_review, review_basis: b.review_basis, release_mode: b.release_mode }, considered: [], says: `Admitted under ${a.template} (${a.policy_id})${a.why ? `, ${a.why}` : ''}. Held to review ${b.required_review}.` };
}
// What a saved version of a task would match now, for a connection deciding
// whether to submit it. Writes nothing.
function matchForTask(ws, t, version, now) {
  if (t.intent === 'explore') return { rule: P.MATCH_RULE, delegation: null, considered: [], says: 'An explore note is never submitted or built.' };
  if (t.authorization && t.authorization.version === version) return authorizedView(t);
  const v = loadVersion(ws, t.task_id, version);
  const out = matchView(matchOf(ws, v.content, { now, exceptId: t.task_id }), v.content, { would: true });
  if (loadState(ws).paused) out.says += ' Engineering is paused on the desk: a submit is refused until Eric resumes it.';
  return out;
}

function submitTask(ws, who, args = {}, opts = {}) {
  const now = nowOf(opts);
  requireRole(who, 'submitter', 'engineering_submit_task');
  refuseForged(Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'content_sha256')));
  refuseUnknown(args, ['task_id', 'version', 'content_sha256', 'idempotency_key']);
  const id = String(args.task_id || '');
  const state = loadState(ws);
  if (state.paused) fail('PAUSED', `Engineering is paused on the desk${state.paused_reason ? ` (${state.paused_reason})` : ''}. Nothing was submitted.`);
  const r = mutate(ws, { taskId: id, type: 'submit', now }, (t, ctx) => {
    const last = t.versions[t.versions.length - 1];
    if (Number(args.version) !== t.current_version) fail('STALE_VERSION', `Version ${args.version} is not the current version of ${id} (${t.current_version}). Nothing was submitted.`);
    if (args.content_sha256 !== last.content_sha256) fail('HASH_MISMATCH', `content_sha256 does not match version ${t.current_version} of ${id} (${last.content_sha256.slice(0, 12)}…). Nothing was submitted.`);
    if (t.intent === 'explore') fail('NOT_EXECUTABLE', `${id} is an explore note: it is never submitted or built. Prepare a design or implement task for work to be done.`);
    if (!['prepared', 'awaiting_authorization'].includes(t.status)) return { unchanged: true };
    const v = loadVersion(ws, id, t.current_version, ctx.op);
    // The narrowest delegation it fits, never the first activated; its
    // review, release and limits apply. The content and its hash are as
    // submitted: the effective rules live in the authorization.
    const m = matchOf(ws, v.content, { now, exceptId: id, op: ctx.op });
    const match = matchView(m, v.content, { would: false });
    if (m.pick) {
      const p = m.pick.policy;
      const b = P.boundaries(p, v.content);
      t.authorization = { kind: 'policy', policy_id: p.policy_id, template: p.template, version: t.current_version, content_sha256: last.content_sha256, at: iso(now), rule: P.MATCH_RULE, why: m.pick.why, fitting: m.pick.ranked.map((x) => x.policy_id), required_review: b.required_review, review_basis: b.review_basis, release_mode: b.release_mode };
      t.admission = { number: null, state: 'unbound', entry_sha256: null, history: [] };
      setStatus(t, 'admitted', `inside delegation ${p.policy_id} (${p.template}), ${m.pick.why}; ${reviewWords(b)}`, now);
      ctx.emit('admitted', { kind: 'policy', policy_id: p.policy_id, template: p.template, version: t.current_version, content_sha256: last.content_sha256, rule: P.MATCH_RULE, decided_by: m.pick.decided_by, fitting: t.authorization.fitting, required_review: b.required_review, release_mode: b.release_mode }, byOf(who));
      return { unchanged: false, match };
    }
    const reason = missedText(m);
    if (t.status === 'awaiting_authorization' && t.status_reason === reason) return { unchanged: true, match };
    setStatus(t, 'awaiting_authorization', reason, now);
    ctx.emit('awaiting_authorization', { version: t.current_version, content_sha256: last.content_sha256, reason }, byOf(who));
    return { unchanged: false, match };
  });
  const t = readRaw(ws, rel.task(id));
  const match = (r.result && r.result.match) || (t.authorization && t.authorization.version === t.current_version ? authorizedView(t) : null);
  const words = {
    admitted: `Admitted inside Eric's delegation ${t.authorization && t.authorization.policy_id} (${t.authorization && t.authorization.template}), held to review ${requiredReview(t)}. It is not on the backlog yet: the builder adds it as a numbered item, then builds it.`,
    awaiting_authorization: `Not admitted: ${t.status_reason}. It waits for Eric to authorize version ${t.current_version} on the desk. Nothing is queued.`,
  }[t.status] || `Already ${t.status}; nothing changed.`;
  return { task_id: id, version: t.current_version, status: t.status, admitted: t.status === 'admitted' || ['queued', 'claimed', 'implementing', 'verifying', 'review_pending', 'ready_for_promotion', 'merged'].includes(t.status), unchanged: Boolean(r.result && r.result.unchanged), verified: r.verified, match, says: words, next_action: nextAction(t, now) };
}

// --- owner ------------------------------------------------------------------------

function requireOwner(who) { if (!who || who.kind !== 'owner') fail('OWNER_ONLY', 'Only Eric, signed in on the desk, can do this.'); }

function activatePolicy(ws, who, { template, goal_id = null, goal = null, days = null } = {}, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  const tpl = P.TEMPLATES[template];
  if (!tpl) fail('BAD_INPUT', `Unknown delegation template ${String(template).slice(0, 40)}. Templates: ${Object.keys(P.TEMPLATES).join(', ')}.`);
  if (tpl.requires_goal && !(goal_id && goal)) fail('BAD_INPUT', `${template} covers one goal: give its goal_id and the goal in a sentence.`);
  if (goal_id && !/^[a-z0-9][a-z0-9-]{1,78}$/.test(goal_id)) fail('BAD_INPUT', 'goal_id is lower-case letters, digits and hyphens.');
  const d = days === null || days === undefined || days === '' ? tpl.max_days : Number(days);
  if (!(Number.isInteger(d) && d >= 1 && d <= tpl.max_days)) fail('BAD_INPUT', `days is 1 to ${tpl.max_days}.`);
  const id = `pol-${ymd(now)}-${rnd(3)}`;
  const rec = { schema_version: S.policy, policy_id: id, template, policy_version: 1, title: tpl.title, says: tpl.says, repo_full_name: tpl.repo_full_name, intents: tpl.intents, allowed_paths: tpl.allowed_paths, required_review: tpl.required_review, release_mode: tpl.release_mode, limits: tpl.limits, goal_id: goal_id || null, goal: goal ? String(goal).slice(0, 300) : null, activated_at: iso(now), activated_by: 'owner', expires_at: iso(now + d * 86400000), revoked_at: null, revoked_reason: null };
  rec.activation_sha256 = P.contentHash(rec);
  const r = runOp(ws, { type: 'engineering_policy_activate', summary: `engineering delegation ${id} (${template})` }, (op) => { op.writeJson(rel.policy(id), rec, { mode: 'create' }); return rec; });
  return { policy: rec, verified: r.verified };
}

function revokePolicy(ws, who, id, { reason = null } = {}, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  if (!POLICY_ID_RE.test(String(id))) fail('BAD_INPUT', 'Unknown delegation ID.');
  const r = runOp(ws, { type: 'engineering_policy_revoke', summary: `engineering revoke ${id}` }, (op) => {
    const p = op.readJson(rel.policy(id), null);
    if (!p) fail('NOT_FOUND', `No delegation ${id}.`);
    if (p.revoked_at) return { unchanged: true, policy: p };
    const next = { ...p, revoked_at: iso(now), revoked_reason: reason ? String(reason).slice(0, 300) : null };
    op.writeJson(rel.policy(id), next);
    return { unchanged: false, policy: next };
  });
  return { ...r.result, verified: r.verified };
}

function setPaused(ws, who, { paused, reason = null } = {}, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  const r = runOp(ws, { type: 'engineering_pause_all', summary: `engineering ${paused ? 'paused' : 'resumed'}` }, (op) => {
    const s = clone(loadState(ws, op));
    if (Boolean(s.paused) === Boolean(paused)) return { unchanged: true, state: s };
    s.paused = Boolean(paused);
    s.paused_reason = paused && reason ? String(reason).slice(0, 300) : null;
    s.paused_at = paused ? iso(now) : null;
    s.updated_at = iso(now);
    op.writeJson(rel.state(), s);
    return { unchanged: false, state: s };
  });
  return { ...r.result, verified: r.verified };
}

function authorizeTask(ws, who, id, { version, content_sha256 } = {}, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  const r = mutate(ws, { taskId: id, type: 'authorize', now }, (t, ctx) => {
    const last = t.versions[t.versions.length - 1];
    if (Number(version) !== t.current_version || content_sha256 !== last.content_sha256) fail('STALE_VERSION', `The page showed version ${version}; ${id} is now version ${t.current_version} (${last.content_sha256.slice(0, 12)}…). Nothing was authorized: read it again.`);
    if (t.intent === 'explore') fail('NOT_EXECUTABLE', 'An explore note is never built.');
    if (t.status !== 'awaiting_authorization') {
      if (t.authorization && t.authorization.version === t.current_version) return { unchanged: true };
      fail('NOT_WAITING', `${id} is ${t.status}, not waiting for your authorization.`);
    }
    const v = loadVersion(ws, id, t.current_version, ctx.op);
    t.authorization = { kind: 'owner', version: t.current_version, content_sha256: last.content_sha256, at: iso(now), receipt: P.sha256(`${id}|${t.current_version}|${last.content_sha256}|${iso(now)}`), required_review: v.content.required_review, release_mode: v.content.release_mode };
    t.admission = { number: null, state: 'unbound', entry_sha256: null, history: [] };
    setStatus(t, 'admitted', 'authorized by Eric', now);
    ctx.emit('authorized_by_owner', { version: t.current_version, content_sha256: last.content_sha256 }, { kind: 'owner' });
    return { unchanged: false };
  });
  return { task: view(ws, readRaw(ws, rel.task(id)), who, { now }), unchanged: Boolean(r.result && r.result.unchanged), verified: r.verified };
}

function pauseTask(ws, who, id, { reason = null } = {}, opts = {}) {
  const now = nowOf(opts);
  if (!(who && who.kind === 'owner')) requireRole(who, 'submitter', 'engineering_pause_task');
  const r = mutate(ws, { taskId: id, type: 'pause', now }, (t, ctx) => {
    if (TERMINAL.includes(t.status)) fail('NOT_PAUSABLE', `${id} is ${t.status}; nothing to pause.`);
    if (t.status === 'paused') return { unchanged: true };
    t.paused_from = t.status;
    const held = t.lease ? t.lease.generation : null;
    t.lease = null;
    setStatus(t, 'paused', reason ? String(reason).slice(0, 300) : 'paused', now);
    ctx.emit('paused', { from: t.paused_from, released_generation: held }, byOf(who));
    return { unchanged: false };
  });
  const t = readRaw(ws, rel.task(id));
  return { task_id: id, status: t.status, unchanged: Boolean(r.result && r.result.unchanged), verified: r.verified, says: `${id} is paused: no claim, admission, build event or promotion goes ahead until Eric resumes it on the desk. A command already running stops at its next step; what already happened remotely stays recorded.` };
}

function resumeTask(ws, who, id, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  const r = mutate(ws, { taskId: id, type: 'resume', now }, (t, ctx) => {
    if (t.status !== 'paused') return { unchanged: true };
    setStatus(t, t.paused_from || 'prepared', 'resumed by Eric', now);
    t.paused_from = null;
    ctx.emit('resumed', { to: t.status }, { kind: 'owner' });
    return { unchanged: false };
  });
  return { task: view(ws, readRaw(ws, rel.task(id)), who, { now }), verified: r.verified };
}

function cancelTask(ws, who, id, { reason = null } = {}, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  const r = mutate(ws, { taskId: id, type: 'cancel', now }, (t, ctx) => {
    if (t.status === 'cancelled') return { unchanged: true };
    if (t.status === 'merged') fail('NOT_CANCELLABLE', `${id} is merged; it stays recorded.`);
    if (t.admission && t.admission.number && t.admission.state !== 'confirmed') {
      const s = ctx.getState();
      if (s.bound_numbers[t.admission.number] === id) { delete s.bound_numbers[t.admission.number]; ctx.stateDirty = true; }
    }
    t.lease = null;
    setStatus(t, 'cancelled', reason ? String(reason).slice(0, 300) : 'cancelled by Eric', now);
    ctx.emit('cancelled', {}, { kind: 'owner' });
    return { unchanged: false };
  });
  return { task: view(ws, readRaw(ws, rel.task(id)), who, { now }), verified: r.verified };
}

// Eric reopens a blocked task with three more attempts (recorded).
function reopenTask(ws, who, id, opts = {}) {
  const now = nowOf(opts);
  requireOwner(who);
  const r = mutate(ws, { taskId: id, type: 'reopen', now }, (t, ctx) => {
    if (t.status !== 'blocked') fail('NOT_BLOCKED', `${id} is ${t.status}, not blocked.`);
    t.attempts.max = t.attempts.count + P.MAX_ATTEMPTS;
    t.attempts.last_failure_sha256 = null;
    setStatus(t, t.admission && t.admission.state === 'confirmed' ? 'queued' : 'admitted', 'reopened by Eric', now);
    ctx.emit('reopened', { attempts_max: t.attempts.max }, { kind: 'owner' });
    return {};
  });
  return { task: view(ws, readRaw(ws, rel.task(id)), who, { now }), verified: r.verified };
}

// --- worker: claim and events --------------------------------------------------------

function claimTask(ws, who, { task_id } = {}, opts = {}) {
  const now = nowOf(opts);
  requireRole(who, 'worker', 'engineering_claim_task');
  if (restoredCopy(ws)) fail('HELD', 'This is a restored copy of the desk: engineering work is held here.');
  const state = loadState(ws);
  if (state.paused) fail('PAUSED', `Engineering is paused on the desk${state.paused_reason ? ` (${state.paused_reason})` : ''}. Nothing was claimed.`);
  const token = rnd(32);
  const r = mutate(ws, { taskId: String(task_id || ''), type: 'claim', now }, (t, ctx) => {
    if (!CLAIMABLE.includes(t.status)) fail('NOT_CLAIMABLE', `${t.task_id} is ${t.status}: ${nextAction(t, now)}`);
    if (t.status === 'admitted' && t.admission && t.admission.state === 'pushed') { /* claimable: to confirm from readback */ }
    const auth = authorizationHolds(ws, t, ctx.op);
    if (!auth.ok) fail('NOT_AUTHORIZED', `${t.task_id} cannot be worked on: ${auth.why}.`);
    if (t.lease && Date.parse(t.lease.expires_at) > now) fail('CLAIMED', `${t.task_id} is claimed by another worker session (generation ${t.lease.generation}) until ${t.lease.expires_at}. Do nothing on it; it will be free after that time if that session stops.`);
    const v = loadVersion(ws, t.task_id, t.current_version, ctx.op);
    for (const dep of v.content.dependencies.filter((d) => TASK_ID_RE.test(d))) {
      const dt = ctx.op.readJson(rel.task(dep), null);
      if (!dt || dt.status !== 'merged') fail('DEPENDENCY', `${t.task_id} waits for ${dep}${dt ? ` (${dt.status})` : ' (not found)'}.`);
    }
    t.generation += 1;
    t.lease = { token_sha256: P.sha256(token), generation: t.generation, holder: byOf(who), purpose: t.status === 'admitted' ? 'admission' : 'build', claimed_at: iso(now), heartbeat_at: iso(now), expires_at: iso(now + P.LEASE_MS) };
    if (t.status === 'queued') setStatus(t, 'claimed', null, now);
    ctx.emit('claimed', { generation: t.generation, purpose: t.lease.purpose }, byOf(who));
    return {};
  });
  const t = readRaw(ws, rel.task(String(task_id)));
  return { task_id: t.task_id, claim_token: token, generation: t.generation, expires_at: t.lease.expires_at, phase: t.lease.purpose, verified: r.verified, says: `Claimed ${t.task_id} (generation ${t.generation}) until ${t.lease.expires_at}; every event renews it. Keep claim_token for every engineering_record_event; if an event says the claim is stale, stop and push nothing.`, task: view(ws, t, who, { now }) };
}

const EVENT_FIELDS = {
  heartbeat: [],
  note: ['text'],
  admission_number: ['number', 'observed_max', 'observed_main_sha'],
  admission_refused: ['number', 'reason'],
  admission_confirmed: ['main_sha', 'entry_sha256'],
  remote_action: ['action', 'phase', 'ref', 'sha', 'observed_sha', 'note'],
  started: ['branch', 'base_sha'],
  candidate: ['branch', 'head_sha', 'base_sha', 'merge_base_sha', 'files', 'diff', 'notes'],
  verification: ['head_sha', 'command', 'exit_code', 'total', 'passed', 'failed', 'output_tail', 'output_sha256', 'acceptance'],
  merged: ['main_sha', 'pr_number', 'pr_url'],
  blocked: ['reason'],
  stopped: ['reason'],
};
const RELEASES_LEASE = ['admission_refused', 'merged', 'blocked', 'stopped'];
const REMOTE_ACTIONS = { push_admission: (t) => `refs/heads/claude/admission-${t.task_id}`, push_candidate: (t) => `refs/heads/claude/candidate-eng-${t.admission && t.admission.number}`, push_release: (t) => `refs/heads/claude/backlog-eng-${t.admission && t.admission.number}` };

function diffFiles(diff) {
  const out = new Set();
  for (const m of String(diff).matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) { out.add(m[1]); out.add(m[2]); }
  return out;
}

function recordEvent(ws, who, args = {}, opts = {}) {
  const now = nowOf(opts);
  requireRole(who, 'worker', 'engineering_record_event');
  const type = String(args.type || '');
  if (!EVENT_FIELDS[type]) fail('BAD_INPUT', `type is one of ${Object.keys(EVENT_FIELDS).join(', ')}.`);
  refuseUnknown(args, ['task_id', 'claim_token', 'type', ...EVENT_FIELDS[type]]);
  if (restoredCopy(ws)) fail('HELD', 'This is a restored copy of the desk: engineering work is held here.');
  const id = String(args.task_id || '');
  const state = loadState(ws);
  let reply = {};
  const r = mutate(ws, { taskId: id, type: `event_${type}`, now }, (t, ctx) => {
    const lease = t.lease;
    if (!lease || lease.token_sha256 !== P.sha256(String(args.claim_token || '')) || Date.parse(lease.expires_at) <= now) {
      fail('STALE_CLAIM', `This claim on ${id} is not current${lease ? ` (the current claim is generation ${lease.generation}${Date.parse(lease.expires_at) <= now ? ', expired' : ''})` : ' (no live claim)'}. Stop: record nothing more and push nothing for it. Claim it again only if engineering_get_task says it is free.`);
    }
    const halted = t.status === 'paused' ? 'paused' : t.status === 'cancelled' ? 'cancelled' : state.paused ? 'paused for all engineering' : null;
    if (halted && type !== 'stopped') fail('PAUSED', `${id} is ${halted}. Stop at this step: run nothing more, push nothing, and record type stopped.`);
    const by = byOf(who);
    const n = t.admission && t.admission.number;
    const v = loadVersion(ws, id, t.current_version, ctx.op);
    const content = v.content;
    const sha = (x, name) => { if (!SHA_RE.test(String(x || ''))) fail('BAD_INPUT', `${name} is a full 40-character commit SHA.`); return String(x); };
    switch (type) {
      case 'heartbeat': break;
      case 'note': {
        const text = String(args.text || '').slice(0, MAX_NOTE);
        ctx.emit('note', { text }, by);
        break;
      }
      case 'admission_number': {
        if (t.status !== 'admitted') fail('WRONG_STATE', `${id} is ${t.status}; a number is bound only to an admitted task.`);
        const num = Number(args.number);
        const max = Number(args.observed_max);
        if (!Number.isInteger(num) || !Number.isInteger(max) || max < 0 || num <= max) fail('BAD_INPUT', 'number must be an integer above observed_max (the highest item number on main and on open intake and admission branches).');
        if (num > max + 5) fail('BAD_INPUT', `number ${num} skips more than four numbers past ${max}; use the next free one.`);
        sha(args.observed_main_sha, 'observed_main_sha');
        if (t.admission.state !== 'unbound') {
          if (t.admission.number === num) { reply = { number: num, entry: t.admission.entry, entry_sha256: t.admission.entry_sha256, branch: `claude/admission-${id}`, unchanged: true }; break; }
          fail('ALREADY_BOUND', `${id} already holds number ${t.admission.number} (${t.admission.state}). Record admission_refused first if the admission workflow refused it.`);
        }
        const s = ctx.getState();
        const holder = s.bound_numbers[num];
        if (holder && holder !== id) fail('NUMBER_TAKEN', `Number ${num} is bound to ${holder}. Use the next free number.`);
        const entry = P.entryText({ number: num, task_id: id, version: t.current_version, content_sha256: t.authorization.content_sha256, policy_id: t.authorization.kind === 'policy' ? t.authorization.policy_id : null, content });
        s.bound_numbers[num] = id;
        ctx.stateDirty = true;
        t.admission = { ...t.admission, number: num, state: 'bound', entry, entry_sha256: P.sha256(entry), bound_at: iso(now), observed_main_sha: args.observed_main_sha };
        ctx.emit('admission_bound', { number: num, entry_sha256: t.admission.entry_sha256, observed_main_sha: args.observed_main_sha }, by);
        reply = { number: num, entry, entry_sha256: t.admission.entry_sha256, branch: `claude/admission-${id}` };
        break;
      }
      case 'admission_refused': {
        if (t.status !== 'admitted' || !t.admission || t.admission.state === 'unbound') fail('WRONG_STATE', `${id} holds no number to release.`);
        if (Number(args.number) !== t.admission.number) fail('BAD_INPUT', `${id} holds number ${t.admission.number}, not ${args.number}.`);
        const s = ctx.getState();
        if (s.bound_numbers[t.admission.number] === id) { delete s.bound_numbers[t.admission.number]; ctx.stateDirty = true; }
        t.admission.history.push({ number: t.admission.number, released_at: iso(now), reason: String(args.reason || '').slice(0, 300) });
        t.admission = { ...t.admission, number: null, state: 'unbound', entry: null, entry_sha256: null };
        delete t.remote_actions.push_admission;
        ctx.emit('admission_released', { number: Number(args.number), reason: String(args.reason || '').slice(0, 300) }, by);
        break;
      }
      case 'admission_confirmed': {
        if (t.status !== 'admitted' || !t.admission || !['bound', 'pushed'].includes(t.admission.state)) fail('WRONG_STATE', `${id} has no admission waiting for confirmation.`);
        if (args.entry_sha256 !== t.admission.entry_sha256) fail('MISMATCH', 'The entry read back from main is not the bound entry. Nothing was confirmed; read main again.');
        t.admission = { ...t.admission, state: 'confirmed', confirmed_main_sha: sha(args.main_sha, 'main_sha'), confirmed_at: iso(now) };
        delete t.remote_actions.push_admission;
        setStatus(t, 'claimed', `item ${n} is on main`, now);
        ctx.emit('admission_confirmed', { number: n, main_sha: args.main_sha }, by);
        break;
      }
      case 'remote_action': {
        const action = String(args.action || '');
        if (!REMOTE_ACTIONS[action]) fail('BAD_INPUT', `action is one of ${Object.keys(REMOTE_ACTIONS).join(', ')}.`);
        if (action !== 'push_admission' && !n) fail('WRONG_STATE', `${id} has no backlog number yet.`);
        const ref = REMOTE_ACTIONS[action](t);
        if (args.ref !== ref) fail('BAD_INPUT', `ref for ${action} is ${ref}.`);
        const phase = String(args.phase || '');
        const prior = t.remote_actions[action];
        if (phase === 'intent') {
          if (prior && prior.phase === 'intent') fail('DISPATCH_UNKNOWN', `An earlier ${action} of ${ref} (${String(prior.sha).slice(0, 12)}) was never confirmed. Read the remote ref back (git ls-remote origin ${ref}) and record phase observed (or failed) before pushing again.`);
          const target = sha(args.sha, 'sha');
          if (action === 'push_admission' && t.admission.state !== 'bound' && t.admission.state !== 'pushed') fail('WRONG_STATE', 'Bind a number first (admission_number).');
          if (action !== 'push_admission' && (!t.candidate || t.candidate.head_sha !== target)) fail('WRONG_CANDIDATE', `Only the recorded candidate ${t.candidate ? t.candidate.head_sha.slice(0, 12) : '(none)'} is pushed.`);
          if (action === 'push_release' && t.status !== 'ready_for_promotion') fail('WRONG_STATE', `${id} is ${t.status}; the release branch is pushed only when the desk's attestation holds (${nextAction(t, now)})`);
          t.remote_actions[action] = { phase: 'intent', ref, sha: target, at: iso(now) };
          ctx.emit('remote_intent', { action, ref, sha: target }, by);
        } else if (phase === 'observed' || phase === 'failed') {
          if (!prior) fail('WRONG_STATE', `No ${action} was recorded.`);
          const seen = args.observed_sha === null || args.observed_sha === undefined || args.observed_sha === '' ? null : sha(args.observed_sha, 'observed_sha');
          const landed = phase === 'observed' && seen === prior.sha;
          t.remote_actions[action] = { ...prior, phase: landed ? 'observed' : 'failed', observed_sha: seen, observed_at: iso(now), note: args.note ? String(args.note).slice(0, 300) : null };
          ctx.emit(landed ? 'remote_observed' : 'remote_not_landed', { action, ref, sha: prior.sha, observed_sha: seen }, by);
          if (landed && action === 'push_admission') { t.admission.state = 'pushed'; t.admission.head_sha = prior.sha; t.lease = null; }
          if (landed && action === 'push_release') { t.release = { branch: ref.replace('refs/heads/', ''), head_sha: prior.sha, pushed_at: iso(now) }; t.lease = null; }
        } else fail('BAD_INPUT', 'phase is intent, observed or failed.');
        break;
      }
      case 'started': {
        if (!['claimed', 'queued', 'implementing'].includes(t.status)) fail('WRONG_STATE', `${id} is ${t.status}; ${nextAction(t, now)}`);
        if (args.branch !== `claude/candidate-eng-${n}`) fail('BAD_INPUT', `The build branch is claude/candidate-eng-${n}.`);
        setStatus(t, 'implementing', null, now);
        ctx.emit('started', { branch: args.branch, base_sha: sha(args.base_sha, 'base_sha') }, by);
        break;
      }
      case 'candidate': {
        if (!['implementing', 'claimed', 'queued', 'verifying'].includes(t.status)) fail('WRONG_STATE', `${id} is ${t.status}; ${nextAction(t, now)}`);
        if (args.branch !== `claude/candidate-eng-${n}`) fail('BAD_INPUT', `The candidate branch is claude/candidate-eng-${n}.`);
        const head = sha(args.head_sha, 'head_sha');
        const base = sha(args.base_sha, 'base_sha');
        const mb = sha(args.merge_base_sha, 'merge_base_sha');
        if (t.candidate && t.candidate.head_sha === head) { reply = { unchanged: true }; break; }
        const diff = String(args.diff || '');
        if (!diff) fail('BAD_INPUT', 'diff is the exact output of git diff --binary --no-color --no-ext-diff --full-index <merge_base> <head>.');
        if (Buffer.byteLength(diff) > MAX_DIFF) fail('TOO_LARGE', `The diff is over ${MAX_DIFF / 1024} KB; split the task.`);
        const files = Array.isArray(args.files) ? args.files.map(String) : [];
        if (!files.length) fail('BAD_INPUT', 'files lists every path the candidate changes.');
        const inDiff = diffFiles(diff);
        const listed = new Set(files);
        if ([...inDiff].some((f) => !listed.has(f)) || files.some((f) => !inDiff.has(f))) fail('MISMATCH', 'files does not match the paths in the diff.');
        const problems = [];
        for (const f of files) {
          const why = P.protectedWhy(f);
          if (why) problems.push(`${f} is protected (${why})`);
          else if (!P.matches(f, content.scope.paths)) problems.push(`${f} is outside the task's scope (${content.scope.paths.join(', ')})`);
        }
        if (t.authorization.kind === 'policy') {
          const p = ctx.op.readJson(rel.policy(t.authorization.policy_id), null);
          if (p && files.length > p.limits.max_files) problems.push(`${files.length} files is over the delegation's ${p.limits.max_files}`);
        }
        if (problems.length) fail('SCOPE', `Candidate refused: ${problems.join('; ')}. Nothing was recorded; change the branch to stay inside the approved scope.`);
        if (t.attempts.count >= t.attempts.max) {
          setStatus(t, 'blocked', `the correction ceiling of ${t.attempts.max} attempts is reached`, now);
          t.lease = null;
          ctx.emit('blocked', { reason: 'ceiling', attempts: t.attempts.count }, by);
          reply = { blocked: true };
          break;
        }
        const dsha = P.sha256(diff);
        ctx.op.write(rel.artifact(id, dsha), diff);
        t.attempts.count += 1;
        for (const c of t.corrections) if (!c.resolved_by_head) c.resolved_by_head = head;
        t.candidate = { head_sha: head, base_sha: base, merge_base_sha: mb, branch: args.branch, files, diff_sha256: dsha, diff_bytes: Buffer.byteLength(diff), generation: lease.generation, attempt: t.attempts.count, recorded_at: iso(now) };
        t.candidates.push({ head_sha: head, merge_base_sha: mb, diff_sha256: dsha, attempt: t.attempts.count, recorded_at: iso(now) });
        if (args.notes) ctx.op.write(rel.artifact(id, P.sha256(String(args.notes).slice(0, MAX_NOTE))), String(args.notes).slice(0, MAX_NOTE));
        t.candidate.notes_sha256 = args.notes ? P.sha256(String(args.notes).slice(0, MAX_NOTE)) : null;
        t.verification = null;
        t.release = null;
        delete t.remote_actions.push_release;
        setStatus(t, 'verifying', null, now);
        ctx.emit('candidate', { head_sha: head, merge_base_sha: mb, diff_sha256: dsha, files: files.length, attempt: t.attempts.count }, by);
        break;
      }
      case 'verification': {
        if (!t.candidate) fail('WRONG_STATE', 'Record the candidate first.');
        const head = sha(args.head_sha, 'head_sha');
        if (head !== t.candidate.head_sha) fail('WRONG_CANDIDATE', `Verification is for the recorded candidate ${t.candidate.head_sha.slice(0, 12)}; record the new candidate first.`);
        if (!['verifying', 'implementing'].includes(t.status)) fail('WRONG_STATE', `${id} is ${t.status}.`);
        if (!VERIFY_COMMANDS.includes(String(args.command || ''))) fail('BAD_INPUT', `command is the documented full suite: ${VERIFY_COMMANDS.join(' or ')}.`);
        const ints = ['exit_code', 'total', 'passed', 'failed'].map((k) => Number(args[k]));
        if (ints.some((x) => !Number.isInteger(x) || x < 0 || x > 1e6)) fail('BAD_INPUT', 'exit_code, total, passed and failed are whole numbers.');
        const acc = Array.isArray(args.acceptance) ? args.acceptance : [];
        const results = content.acceptance.map((_, i) => { const a = acc.find((x) => x && Number(x.index) === i); return { index: i, met: Boolean(a && a.met === true), evidence: a && a.evidence ? String(a.evidence).slice(0, 600) : null }; });
        const tail = String(args.output_tail || '').slice(-MAX_TAIL);
        const outSha = /^[0-9a-f]{64}$/.test(String(args.output_sha256 || '')) ? String(args.output_sha256) : P.sha256(tail);
        if (tail) ctx.op.write(rel.artifact(id, P.sha256(tail)), tail);
        const [exitCode, total, passed, failed] = ints;
        const suiteOk = exitCode === 0 && failed === 0 && total > 0 && passed === total;
        const ok = suiteOk && results.every((x) => x.met);
        t.verification = { head_sha: head, command: args.command, exit_code: exitCode, total, passed, failed, output_sha256: outSha, tail_sha256: tail ? P.sha256(tail) : null, acceptance: results, ok, recorded_at: iso(now) };
        ctx.emit('verification', { head_sha: head, ok, exit_code: exitCode, total, passed, failed, acceptance_met: results.filter((x) => x.met).length, acceptance_total: results.length }, by);
        if (ok) {
          const rs = reviewState(t);
          if (rs.satisfied) setStatus(t, 'ready_for_promotion', null, now);
          else { setStatus(t, 'review_pending', `waiting for a ${rs.required} review of ${head.slice(0, 12)}`, now); t.lease = null; }
        } else {
          const why = !suiteOk ? `the suite did not pass (${failed} failed of ${total}, exit ${exitCode})` : `acceptance ${results.filter((x) => !x.met).map((x) => x.index + 1).join(', ')} not met`;
          if (t.attempts.last_failure_sha256 && t.attempts.last_failure_sha256 === outSha) {
            setStatus(t, 'blocked', `the same failure twice: ${why}`, now);
            t.lease = null;
            ctx.emit('blocked', { reason: 'unchanged_failure' }, by);
          } else if (t.attempts.count >= t.attempts.max) {
            setStatus(t, 'blocked', `${why}, at the correction ceiling of ${t.attempts.max} attempts`, now);
            t.lease = null;
            ctx.emit('blocked', { reason: 'ceiling', attempts: t.attempts.count }, by);
          } else setStatus(t, 'implementing', `correct it: ${why} (attempt ${t.attempts.count} of ${t.attempts.max})`, now);
          t.attempts.last_failure_sha256 = outSha;
        }
        break;
      }
      case 'merged': {
        if (t.status !== 'ready_for_promotion' || !t.release) fail('WRONG_STATE', `${id} is ${t.status}${t.release ? '' : ' and its release branch was never recorded'}.`);
        t.merge = { main_sha: sha(args.main_sha, 'main_sha'), contains_head: t.release.head_sha, pr_number: Number.isInteger(Number(args.pr_number)) && Number(args.pr_number) > 0 ? Number(args.pr_number) : null, pr_url: /^https:\/\/github\.com\/kuaya1\/CryptoResearch\/pull\/\d+$/.test(String(args.pr_url || '')) ? args.pr_url : null, observed_at: iso(now), by: 'worker Git readback' };
        setStatus(t, 'merged', null, now);
        ctx.emit('merged', { main_sha: args.main_sha, pr_number: t.merge.pr_number }, by);
        break;
      }
      case 'blocked': {
        setStatus(t, 'blocked', String(args.reason || 'blocked by the worker').slice(0, 300), now);
        ctx.emit('blocked', { reason: 'worker', text: String(args.reason || '').slice(0, 300) }, by);
        break;
      }
      case 'stopped': {
        ctx.emit('stopped', { reason: String(args.reason || '').slice(0, 300), generation: lease.generation }, by);
        break;
      }
      default: break;
    }
    if (RELEASES_LEASE.includes(type)) t.lease = null;
    else if (t.lease) { t.lease.heartbeat_at = iso(now); t.lease.expires_at = iso(now + P.LEASE_MS); if (type === 'heartbeat') ctx.emit('heartbeat', { generation: t.lease.generation }, by); }
    return reply;
  });
  const t = readRaw(ws, rel.task(id));
  return { task_id: id, type, status: t.status, ...(r.result || {}), verified: r.verified, lease_expires_at: t.lease ? t.lease.expires_at : null, next_action: nextAction(t, now) };
}

// --- reviews and corrections --------------------------------------------------------

function saveReview(ws, who, args = {}, opts = {}) {
  const now = nowOf(opts);
  if (!(who && who.kind === 'owner')) requireRole(who, 'reviewer', 'engineering_save_review');
  refuseForged(args);
  refuseUnknown(args, ['task_id', 'head_sha', 'merge_base_sha', 'result', 'findings', 'method', 'read', 'summary', 'idempotency_key']);
  const result = String(args.result || '');
  if (!['pass', 'changes_required', 'insufficient_evidence'].includes(result)) fail('BAD_INPUT', 'result is pass, changes_required or insufficient_evidence.');
  const findings = (Array.isArray(args.findings) ? args.findings : []).slice(0, 50).map((f) => ({ severity: ['high', 'medium', 'low', 'note'].includes(String(f && f.severity)) ? f.severity : 'note', summary: String((f && f.summary) || '').slice(0, 600), path: f && f.path ? String(f.path).slice(0, 160) : null, line: f && Number.isInteger(Number(f.line)) ? Number(f.line) : null }));
  if (result === 'changes_required' && !findings.length) fail('BAD_INPUT', 'changes_required needs at least one finding.');
  const read = args.read && typeof args.read === 'object' ? { diff: Boolean(args.read.diff), tests: Boolean(args.read.tests), acceptance: Boolean(args.read.acceptance), builder_notes: Boolean(args.read.builder_notes) } : { diff: false, tests: false, acceptance: false, builder_notes: false };
  const reviewer = who.kind === 'owner' ? { kind: 'owner' } : { kind: who.assistant || 'unknown', role: who.role, conn: connKey(who) };
  let out = {};
  const r = mutate(ws, { taskId: String(args.task_id || ''), type: 'review', now }, (t, ctx) => {
    const c = t.candidate;
    if (!c) fail('NO_CANDIDATE', `${t.task_id} has no candidate to review yet (${t.status}).`);
    if (args.head_sha !== c.head_sha || args.merge_base_sha !== c.merge_base_sha) fail('WRONG_CANDIDATE', `The current candidate of ${t.task_id} is head ${c.head_sha} on merge base ${c.merge_base_sha}. A review is saved only for the exact candidate it read; read engineering_get_evidence again. Nothing was saved.`);
    if (TERMINAL.includes(t.status)) fail('WRONG_STATE', `${t.task_id} is ${t.status}.`);
    const v = loadVersion(ws, t.task_id, t.current_version, ctx.op);
    const fsha = P.sha256(P.canonical({ result, findings }));
    const dup = t.reviews.find((x) => x.head_sha === c.head_sha && x.reviewer.kind === reviewer.kind && x.reviewer.conn === reviewer.conn && x.findings_sha256 === fsha);
    if (dup) { out = { review_id: dup.review_id, unchanged: true }; return out; }
    const rid = `rev-${ymd(now)}-${rnd(3)}`;
    const need = requiredReview(t);
    const assigned = reviewer.kind === 'owner' || reviewer.kind === need || v.content.reviews_requested.includes(reviewer.kind);
    const limited = !(read.diff && read.tests);
    ctx.op.writeJson(rel.review(t.task_id, rid), { schema_version: S.review, review_id: rid, task_id: t.task_id, version: t.current_version, head_sha: c.head_sha, merge_base_sha: c.merge_base_sha, diff_sha256: c.diff_sha256, result, findings, method: args.method ? String(args.method).slice(0, 300) : null, read, limited, summary: args.summary ? String(args.summary).slice(0, 2000) : null, reviewer, assigned, at: iso(now) }, { mode: 'create' });
    t.reviews.push({ review_id: rid, head_sha: c.head_sha, merge_base_sha: c.merge_base_sha, result, reviewer, assigned, limited, findings_sha256: fsha, at: iso(now) });
    ctx.emit('review_saved', { review_id: rid, result, reviewer: reviewer.kind, head_sha: c.head_sha, assigned, limited }, byOf(who));
    const deciding = reviewer.kind === 'owner' || reviewer.kind === need;
    if (deciding && result === 'changes_required' && ['review_pending', 'ready_for_promotion', 'verifying'].includes(t.status)) {
      const cid = `cor-${ymd(now)}-${rnd(3)}`;
      t.corrections.push({ correction_id: cid, at: iso(now), by: reviewer, head_sha: c.head_sha, review_id: rid, resolved_by_head: null });
      t.release = null;
      if (t.attempts.count >= t.attempts.max) { setStatus(t, 'blocked', `the review asked for changes at the correction ceiling of ${t.attempts.max} attempts`, now); ctx.emit('blocked', { reason: 'ceiling' }, byOf(who)); }
      else setStatus(t, 'queued', `the ${reviewer.kind} review asked for changes (${findings.length} ${findings.length === 1 ? 'finding' : 'findings'})`, now);
    } else if (deciding && result === 'pass' && t.status === 'review_pending' && t.verification && t.verification.ok && t.verification.head_sha === c.head_sha) {
      setStatus(t, 'ready_for_promotion', null, now);
    }
    out = { review_id: rid, unchanged: false, counts_for_requirement: deciding, assigned, limited };
    return out;
  });
  const t = readRaw(ws, rel.task(String(args.task_id)));
  const rs = reviewState(t);
  return { task_id: t.task_id, ...out, status: t.status, review: rs, verified: r.verified, says: out.unchanged ? 'The same review was already saved; nothing changed.' : `Saved review ${out.review_id} (${result}) of head ${t.candidate.head_sha.slice(0, 12)}${out.counts_for_requirement ? '' : `; it does not decide this task (the requirement is ${rs.required})`}${out.limited ? '; marked limited: it did not read both the diff and the test evidence' : ''}. ${nextAction(t, now)}` };
}

function requestCorrection(ws, who, args = {}, opts = {}) {
  const now = nowOf(opts);
  requireRole(who, 'submitter', 'engineering_request_correction');
  refuseForged(args);
  refuseUnknown(args, ['task_id', 'head_sha', 'findings', 'idempotency_key']);
  const findings = (Array.isArray(args.findings) ? args.findings : [args.findings]).filter(Boolean).slice(0, 30).map((f) => String(typeof f === 'string' ? f : f.summary || '').slice(0, 600)).filter(Boolean);
  if (!findings.length) fail('BAD_INPUT', 'findings lists what to correct, within the task\'s approved scope.');
  let cid = null;
  const key = args.idempotency_key ? `eng-correction-${connKey(who)}-${String(args.idempotency_key).slice(0, 80)}` : null;
  const r = mutate(ws, { taskId: String(args.task_id || ''), type: 'correction', key, payload: args, now }, (t, ctx) => {
    if (TERMINAL.includes(t.status)) fail('WRONG_STATE', `${t.task_id} is ${t.status}; prepare a new task.`);
    if (!t.candidate) fail('NO_CANDIDATE', `${t.task_id} has no candidate yet; nothing to correct.`);
    if (args.head_sha && args.head_sha !== t.candidate.head_sha) fail('WRONG_CANDIDATE', `The current candidate is ${t.candidate.head_sha}.`);
    if (['paused', 'blocked'].includes(t.status)) fail('WRONG_STATE', `${t.task_id} is ${t.status}.`);
    if (t.attempts.count >= t.attempts.max) fail('CEILING', `${t.task_id} is at its correction ceiling (${t.attempts.max} attempts). Eric decides on the desk.`);
    cid = `cor-${ymd(now)}-${rnd(3)}`;
    const fsha = P.sha256(P.canonical(findings));
    ctx.op.write(rel.artifact(t.task_id, fsha), findings.map((f, i) => `${i + 1}. ${f}`).join('\n'));
    t.corrections.push({ correction_id: cid, at: iso(now), by: byOf(who), head_sha: t.candidate.head_sha, findings_sha256: fsha, resolved_by_head: null });
    t.release = null;
    if (['review_pending', 'ready_for_promotion', 'verifying', 'implementing', 'claimed'].includes(t.status)) setStatus(t, 'queued', `a correction was requested (${findings.length} ${findings.length === 1 ? 'point' : 'points'})`, now);
    ctx.emit('correction_requested', { correction_id: cid, head_sha: t.candidate.head_sha, findings_sha256: fsha }, byOf(who));
    return { correction_id: cid };
  });
  if (r.replayed && r.result) cid = r.result.correction_id;
  const t = readRaw(ws, rel.task(String(args.task_id)));
  return { task_id: t.task_id, correction_id: cid, status: t.status, verified: r.verified, says: `Correction ${cid} recorded for ${t.task_id}; the worker corrects it within the approved scope, and the corrected candidate needs fresh verification${requiredReview(t) !== 'none' ? ' and a fresh review' : ''}.`, next_action: nextAction(t, now) };
}

// --- reads --------------------------------------------------------------------------

function getTask(ws, who, id, opts = {}) {
  requireRole(who, 'reader', 'engineering_get_task');
  const now = nowOf(opts);
  return readConsistent(ws, () => view(ws, loadTask(ws, String(id || '')), who, { now }));
}

function listTasks(ws, who, { status = null, repo = null, limit = 50 } = {}, opts = {}) {
  requireRole(who, 'reader', 'engineering_list_tasks');
  const now = nowOf(opts);
  if (repo && repo !== P.REPO) fail('WRONG_REPO', `This connection reads only ${P.REPO}.`);
  return readConsistent(ws, () => {
    const dir = ws.abs(`${ROOT}/tasks`);
    if (exists(dir)) { fs.readdirSync(dir); } // an unreadable inbox throws, never reads as empty
    const want = status ? String(status).split(',').map((s) => s.trim()) : null;
    const rows = [];
    let unreadable = 0;
    for (const id of taskIds(ws)) {
      let t;
      try { t = readJson(ws.abs(rel.task(id)), null); } catch (_) { t = null; }
      if (!t) { unreadable += 1; continue; }
      if (!supported(t, S.task)) { rows.push({ task_id: id, unsupported: true, schema_version: t.schema_version || null }); continue; }
      if (want && !want.includes(t.status)) continue;
      rows.push({ task_id: t.task_id, title: t.title, intent: t.intent, status: t.status, version: t.current_version, number: t.admission && t.admission.number, review: reviewState(t).state, next_action: nextAction(t, now), updated_at: t.updated_at, lease_live: Boolean(t.lease && Date.parse(t.lease.expires_at) > now) });
    }
    rows.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const s = loadState(ws);
    return { repo: P.REPO, paused: Boolean(s.paused), paused_reason: s.paused_reason || null, count: rows.length, unreadable, complete: unreadable === 0, tasks: rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))) };
  });
}

// The approved goal, the exact diff and the test evidence first; the
// builder's own notes after them.
function getEvidence(ws, who, { task_id, head_sha = null, offset = 0, max_chars = 100000 } = {}, opts = {}) {
  requireRole(who, 'reader', 'engineering_get_evidence');
  const now = nowOf(opts);
  return readConsistent(ws, () => {
    const t = loadTask(ws, String(task_id || ''));
    requireSupported(t);
    const v = loadVersion(ws, t.task_id, t.current_version);
    const cand = head_sha ? (t.candidate && t.candidate.head_sha === head_sha ? t.candidate : t.candidates.find((c) => c.head_sha === head_sha)) : t.candidate;
    if (head_sha && !cand) fail('NOT_FOUND', `${t.task_id} never recorded a candidate ${String(head_sha).slice(0, 12)}.`);
    const out = { task_id: t.task_id, status: t.status, goal: { version: t.current_version, content_sha256: v.content_sha256, title: v.content.title, outcome: v.content.outcome, scope: v.content.scope, acceptance: v.content.acceptance, non_goals: v.content.non_goals, required_review: v.content.required_review }, candidate: null, diff: null, verification: null, reviews: [], builder_notes: null, current: Boolean(cand && t.candidate && cand.head_sha === t.candidate.head_sha) };
    if (!cand) return { ...out, says: `${t.task_id} has no candidate yet (${t.status}).` };
    out.candidate = { head_sha: cand.head_sha, merge_base_sha: cand.merge_base_sha, base_sha: cand.base_sha || null, files: cand.files || null, diff_sha256: cand.diff_sha256, attempt: cand.attempt };
    const diff = fs.existsSync(ws.abs(rel.artifact(t.task_id, cand.diff_sha256))) ? fs.readFileSync(ws.abs(rel.artifact(t.task_id, cand.diff_sha256)), 'utf8') : null;
    const lim = Math.max(1000, Math.min(150000, Number(max_chars) || 100000));
    const off = Math.max(0, Number(offset) || 0);
    out.diff = diff === null ? { missing: true } : { text: diff.slice(off, off + lim), offset: off, chars: diff.length, complete: off + lim >= diff.length, next_offset: off + lim < diff.length ? off + lim : null, sha256: P.sha256(diff), matches_record: P.sha256(diff) === cand.diff_sha256 };
    const ver = t.verification && t.verification.head_sha === cand.head_sha ? t.verification : null;
    if (ver) {
      const tail = ver.tail_sha256 && fs.existsSync(ws.abs(rel.artifact(t.task_id, ver.tail_sha256))) ? fs.readFileSync(ws.abs(rel.artifact(t.task_id, ver.tail_sha256)), 'utf8') : null;
      out.verification = { command: ver.command, exit_code: ver.exit_code, total: ver.total, passed: ver.passed, failed: ver.failed, ok: ver.ok, output_tail: tail, output_sha256: ver.output_sha256, acceptance: ver.acceptance.map((a) => ({ index: a.index, check: v.content.acceptance[a.index], met: a.met, evidence: a.evidence })), reported_by: 'the worker; the GitHub test run on the head is read back separately' };
    }
    out.reviews = (t.reviews || []).filter((r) => r.head_sha === cand.head_sha).map((r) => { const full = readRaw(ws, rel.review(t.task_id, r.review_id)) || {}; return { review_id: r.review_id, result: r.result, reviewer: r.reviewer, assigned: r.assigned, limited: r.limited, findings: full.findings || [], summary: full.summary || null, at: r.at }; });
    const notes = t.candidate && t.candidate.head_sha === cand.head_sha && t.candidate.notes_sha256 ? readTextSafe(ws, rel.artifact(t.task_id, t.candidate.notes_sha256)) : null;
    out.builder_notes = notes ? { text: notes, read_after: 'the goal, diff and test evidence above' } : null;
    out.next_action = nextAction(t, now);
    return out;
  });
}
function readTextSafe(ws, r) { try { return fs.readFileSync(ws.abs(r), 'utf8'); } catch (_) { return null; } }

// --- public reads for the GitHub workflows (no private content) ----------------------

function admissionView(ws, taskId, opts = {}) {
  const now = nowOf(opts);
  return readConsistent(ws, () => {
    if (!TASK_ID_RE.test(String(taskId || ''))) return null;
    const t = readRaw(ws, rel.task(taskId));
    if (!t) return null;
    if (!supported(t, S.task)) return { schema_version: S.admission, task_id: taskId, admissible: false, reasons: ['unsupported record schema'] };
    const s = loadState(ws);
    const reasons = [];
    if (s.paused) reasons.push('engineering is paused');
    if (t.status !== 'admitted') reasons.push(`the task is ${t.status}`);
    const a = t.admission;
    if (!a || !a.number || !['bound', 'pushed'].includes(a.state)) reasons.push('no number is bound');
    const auth = authorizationHolds(ws, t);
    if (!auth.ok) reasons.push(auth.why);
    if (t.authorization && t.authorization.kind === 'policy') {
      const p = readRaw(ws, rel.policy(t.authorization.policy_id));
      if (p && Date.parse(p.expires_at) <= now) reasons.push(`delegation ${p.policy_id} expired`);
    }
    return { schema_version: S.admission, task_id: taskId, version: t.current_version, content_sha256: t.versions[t.versions.length - 1].content_sha256, number: a ? a.number : null, entry_sha256: a ? a.entry_sha256 : null, state: a ? a.state : null, authorization: t.authorization ? t.authorization.kind : null, admissible: reasons.length === 0, reasons, at: iso(now) };
  });
}

function attestationView(ws, headSha, opts = {}) {
  const now = nowOf(opts);
  return readConsistent(ws, () => {
    if (!SHA_RE.test(String(headSha || ''))) return null;
    let t = null;
    for (const id of taskIds(ws)) {
      const x = readRaw(ws, rel.task(id));
      if (x && supported(x, S.task) && (x.candidates || []).some((c) => c.head_sha === headSha)) { t = x; break; }
    }
    if (!t) return null;
    const s = loadState(ws);
    const v = readRaw(ws, rel.version(t.task_id, t.current_version));
    const reasons = [];
    const c = t.candidate;
    if (s.paused) reasons.push('engineering is paused');
    if (!c || c.head_sha !== headSha) reasons.push(`this head is not the task's current candidate (${c ? c.head_sha.slice(0, 12) : 'none'})`);
    if (t.status !== 'ready_for_promotion') reasons.push(`the task is ${t.status}${t.status_reason ? ` (${t.status_reason})` : ''}`);
    const auth = authorizationHolds(ws, t);
    if (!auth.ok) reasons.push(auth.why);
    if (!t.admission || t.admission.state !== 'confirmed') reasons.push('its admission is not confirmed on main');
    const ver = t.verification;
    if (!ver || ver.head_sha !== headSha || !ver.ok) reasons.push('no passing verification with every acceptance check met is recorded for this head');
    const content = v && supported(v, S.version) ? v.content : null;
    // The stricter of what the authorization recorded, the version's declared
    // rule and the delegation's own: no record can lower another.
    const a = t.authorization;
    const pol = a && a.kind === 'policy' ? readRaw(ws, rel.policy(a.policy_id)) : null;
    const rs = reviewState(t, P.stricterReview(requiredReview(t), content && content.required_review, pol && pol.required_review));
    if (!rs.satisfied) reasons.push(`the required ${rs.required} review has not passed on this head (${rs.state})`);
    const release = P.stricterRelease(content && content.release_mode, a && a.release_mode, pol && pol.release_mode);
    if (release === 'owner') reasons.push('this task is released by Eric (release mode owner)');
    return { schema_version: S.attestation, head_sha: headSha, task_id: t.task_id, version: t.current_version, content_sha256: t.versions[t.versions.length - 1].content_sha256, number: t.admission ? t.admission.number : null, merge_base_sha: c ? c.merge_base_sha : null, generation: c ? c.generation : null, allowed_paths: content ? content.scope.paths : [], delegation: a && a.kind === 'policy' ? { policy_id: a.policy_id, template: a.template } : null, required_review: rs.required, review_state: rs.state, release_mode: release, promotable: reasons.length === 0, reasons, at: iso(now) };
  });
}

// --- the owner's page ------------------------------------------------------------------

function ownerView(ws, who, opts = {}) {
  requireOwner(who);
  const now = nowOf(opts);
  return readConsistent(ws, () => {
    const s = loadState(ws);
    const list = taskIds(ws).map((id) => readRaw(ws, rel.task(id))).filter(Boolean);
    return {
      paused: Boolean(s.paused),
      paused_reason: s.paused_reason || null,
      templates: Object.values(P.TEMPLATES).map((x) => ({ template: x.template, title: x.title, says: x.says, intents: x.intents, allowed_paths: x.allowed_paths, required_review: x.required_review, release_mode: x.release_mode, limits: x.limits, max_days: x.max_days, requires_goal: x.requires_goal })),
      policies: policies(ws).map((p) => ({ ...p, active: policyActive(p, now) })),
      tasks: list.map((t) => (supported(t, S.task) ? view(ws, t, who, { now }) : { task_id: t.task_id, unsupported: true, schema_version: t.schema_version })).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))),
    };
  });
}

// With task_id (and a version, else the current one): the delegation that
// version would be admitted under now and why, or what each one misses.
function capabilities(ws, who, args = {}, opts = {}) {
  requireRole(who, 'reader', 'engineering_capabilities');
  refuseUnknown(args, ['task_id', 'version']);
  const now = nowOf(opts);
  const s = loadState(ws);
  const active = policies(ws).filter((p) => policyActive(p, now));
  const role = who.kind === 'owner' ? 'owner' : who.role;
  let preview;
  if (args.task_id) {
    preview = readConsistent(ws, () => {
      const t = loadTask(ws, String(args.task_id));
      requireSupported(t);
      const n = args.version === undefined || args.version === null ? t.current_version : Number(args.version);
      if (!t.versions.some((x) => x.version === n)) fail('NOT_FOUND', `Task ${t.task_id} has no version ${args.version}.`);
      return { task_id: t.task_id, version: n, current: n === t.current_version, status: t.status, ...matchForTask(ws, t, n, now) };
    });
  }
  return {
    repo: P.REPO,
    role,
    assistant: who.assistant || null,
    paused: Boolean(s.paused),
    can: { read: true, review: can(who, 'reviewer'), submit: can(who, 'submitter'), work: can(who, 'worker') },
    delegations: active.map((p) => ({ policy_id: p.policy_id, template: p.template, title: p.title, intents: p.intents, allowed_paths: p.allowed_paths, required_review: p.required_review, release_mode: p.release_mode, limits: p.limits, goal_id: p.goal_id, expires_at: p.expires_at })),
    matching: `${P.MATCH_RULE}: a submitted version is admitted under the narrowest active delegation it fits, never the first activated: (1) a delegation whose paths lie inside another's comes first, then (2) the lighter review it requires (${P.REVIEWS.join(' < ')}), (3) release by promotion before release by Eric, (4) fewer path rules, (5) the template name, (6) the delegation ID. It is held to the stricter of its declared review and release and the delegation's, and to the delegation's limits and max_files. Fitting none, it waits for Eric. Pass task_id to see where a saved version would land.`,
    ...(preview ? { preview } : {}),
    intents: { explore: 'a note only; never built', design: `documents only (${P.DESIGN_PATHS.join(', ')})`, implement: 'code inside the approved scope' },
    unavailable: ['an unattended ChatGPT review (ChatGPT reviews only in a conversation Eric opens)', 'a wake-up trigger (the builder runs hourly)', 'Gemini automation (an assigned review only when Eric asks)', 'merging, deploying or approving by any connection'],
    lifecycle: 'prepared → awaiting_authorization → admitted → queued → claimed → implementing → verifying → review_pending → ready_for_promotion → merged; also blocked, paused, cancelled, superseded. Deployment is read separately.',
  };
}

module.exports = {
  S, TASK_ID_RE, POLICY_ID_RE, FORGED, VERIFY_COMMANDS,
  prepareTask, submitTask, activatePolicy, revokePolicy, setPaused, authorizeTask, pauseTask, resumeTask, cancelTask, reopenTask,
  claimTask, recordEvent, saveReview, requestCorrection,
  getTask, listTasks, getEvidence, admissionView, attestationView, ownerView, capabilities, nextAction, reviewState,
};
