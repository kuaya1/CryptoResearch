'use strict';
// Backend autonomy (Eric, 2026-10-26, audits/2026-10-26-backend-autonomy):
// the eng-backend@1 template (what it admits and what it never reaches, a
// test in every candidate), admission under its delegation with no
// passphrase, the unattended deciding review (its packet, the desk's checks
// when it is saved, Rule N4 against self-review, the sovereign merge boundary)
// and its token route, and dashboard/engineering/reviewer.js end to end on a
// temporary Git repository with a bare origin, the real desk route and a
// stand-in for the OpenAI API. FICTIONAL workspaces; no network beyond this
// PC, no model, no money.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { tempWorkspace } = require('./helpers');
const I = require('../engineering/inbox');
const P = require('../engineering/policy');
const R = require('../engineering/reviewer');
const BP = require('../scripts/backlog-promote');
const F = require('../frontdoor');
const { makeEngineeringRoutes } = require('../engineering/routes');

const T0 = Date.parse('2026-10-26T12:00:00Z');
const o = (dt = 0) => ({ now: T0 + dt });
const MIN = 60 * 1000;
const NL = String.fromCharCode(10);
const OWNER = { kind: 'owner' };
const CHAT = { kind: 'connection', assistant: 'chatgpt', role: 'submitter', grant_id: 'grant-chat-backend-fictional' };
const CHAT_REV = { kind: 'connection', assistant: 'chatgpt', role: 'reviewer', grant_id: 'grant-chat-review-backend-fictional' };
const W1 = { kind: 'connection', assistant: 'claude', role: 'worker', grant_id: 'grant-worker-backend-1' };
const W_CHAT = { kind: 'connection', assistant: 'chatgpt', role: 'worker', grant_id: 'grant-worker-chatgpt-fictional' };
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
const MAIN0 = sha1('backend-main-0');
const MAIN1 = sha1('backend-main-1');
const TOKEN = 'reviewer-token-FICTIONAL-0123456789abcdef';
const CI_OK = { state: 'success', runs: [{ name: 'test', status: 'completed', conclusion: 'success' }], complete: true };

const CORE = 'dashboard/core/fictional-backend.js';
const TEST = 'dashboard/tests/fictional-backend.test.js';
const SERVER = 'dashboard/server.js';
const GOAL = { goal_id: 'desk-backend', goal: 'Backend work (FICTIONAL)' };
const backendTask = (over = {}) => ({
  title: 'Backend change (FICTIONAL)',
  intent: 'implement',
  goal_id: 'desk-backend',
  outcome: 'A fictional core module answers one question, with its test (FICTIONAL).',
  scope: { paths: [CORE, TEST, SERVER] },
  acceptance: ['The fictional test passes (FICTIONAL)'],
  ...over,
});
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const fileDiff = (file, body) => [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, '@@ -0,0 +1 @@', `+${body}`, ''].join(NL);
const diffOf = (files) => Object.entries(files).map(([f, b]) => fileDiff(f, b)).join('');

function ws0(t, label) {
  const w = tempWorkspace(`engb-${label}`);
  t.after(w.cleanup);
  return w.ws;
}
function backendDesk(t, label) {
  const ws = ws0(t, label);
  const pol = I.activatePolicy(ws, OWNER, { template: 'eng-backend@1', ...GOAL }, o()).policy;
  return { ws, pol };
}
function submitted(ws, args = backendTask(), now = o()) {
  const p = I.prepareTask(ws, CHAT, args, now);
  return { ...p, ...I.submitTask(ws, CHAT, { task_id: p.task_id, version: p.version, content_sha256: p.content_sha256 }, now) };
}
// Admitted, numbered, on main and claimed for building (the worker's path).
function onMain(ws, id, { number = 70, w = W1, now = o(), main = MAIN1 } = {}) {
  const c = I.claimTask(ws, w, { task_id: id }, now);
  const b = I.recordEvent(ws, w, { task_id: id, claim_token: c.claim_token, type: 'admission_number', number, observed_max: number - 1, observed_main_sha: MAIN0 }, now);
  const head = sha1(`admission-${id}`);
  const ref = `refs/heads/claude/admission-${id}`;
  I.recordEvent(ws, w, { task_id: id, claim_token: c.claim_token, type: 'remote_action', action: 'push_admission', phase: 'intent', ref, sha: head }, now);
  I.recordEvent(ws, w, { task_id: id, claim_token: c.claim_token, type: 'remote_action', action: 'push_admission', phase: 'observed', ref, observed_sha: head }, now);
  const c2 = I.claimTask(ws, w, { task_id: id }, now);
  I.recordEvent(ws, w, { task_id: id, claim_token: c2.claim_token, type: 'admission_confirmed', main_sha: MAIN1, entry_sha256: b.entry_sha256 }, now);
  I.recordEvent(ws, w, { task_id: id, claim_token: c2.claim_token, type: 'started', branch: `claude/candidate-eng-${number}`, base_sha: main }, now);
  return { token: c2.claim_token, number };
}
function candidate(ws, id, token, number, { files = { [CORE]: 'module.exports = 1;', [TEST]: "require('../core/fictional-backend');" }, diff = null, head = sha1(`${id}-${JSON.stringify(files)}`), base = MAIN1, w = W1, now = o() } = {}) {
  const d = diff || diffOf(files);
  return { head, diff: d, r: I.recordEvent(ws, w, { task_id: id, claim_token: token, type: 'candidate', branch: `claude/candidate-eng-${number}`, head_sha: head, base_sha: base, merge_base_sha: base, files: Object.keys(files), diff: d, notes: 'builder notes (FICTIONAL)' }, now) };
}
function verify(ws, id, token, head, { w = W1, now = o() } = {}) {
  return I.recordEvent(ws, w, { task_id: id, claim_token: token, type: 'verification', head_sha: head, command: 'node dashboard/cli.js test', exit_code: 0, total: 12, passed: 12, failed: 0, output_tail: 'all green (FICTIONAL)', acceptance: [{ index: 0, met: true, evidence: 'ran the fictional test (FICTIONAL)' }] }, now);
}
// A backend task built by `w` and verified: review_pending, waiting for ChatGPT.
function pendingReview(t, label, { w = W1 } = {}) {
  const { ws, pol } = backendDesk(t, label);
  const s = submitted(ws);
  const m = onMain(ws, s.task_id, { w });
  const c = candidate(ws, s.task_id, m.token, m.number, { w });
  verify(ws, s.task_id, m.token, c.head, { w });
  return { ws, pol, id: s.task_id, number: m.number, head: c.head, diffSha: P.sha256(c.diff), diff: c.diff };
}
const save = (ws, x, over = {}, opts = {}) => I.saveAutomatedReview(ws, I.REVIEWER_SERVICE, { task_id: x.id, head_sha: x.head, merge_base_sha: MAIN1, diff_sha256: x.diffSha, result: 'pass', findings: [], summary: 'Looks right (FICTIONAL).', model: 'gpt-fictional', ...over }, { ci: CI_OK, now: T0 + 5 * MIN, ...opts });

// --- the template ------------------------------------------------------------

test('eng-backend@1: backend paths for one goal, implement only, ChatGPT review, release by Eric, a test required', () => {
  const tpl = P.TEMPLATES['eng-backend@1'];
  assert.ok(tpl && !P.RETIRED['eng-backend@1']);
  assert.deepEqual(tpl.allowed_paths, ['dashboard/server.js', 'dashboard/core/**', 'dashboard/tests/**']);
  assert.deepEqual(tpl.intents, ['implement']);
  assert.equal(tpl.required_review, 'chatgpt');
  assert.equal(tpl.release_mode, 'owner');
  assert.equal(tpl.requires_goal, true);
  assert.equal(tpl.requires_tests, 'dashboard/tests/**/*.test.js');
  for (const f of ['dashboard/engineering/**', 'dashboard/frontdoor.js', '.github/workflows/**', 'server.js', 'dashboard/hosted.js', 'dashboard/oauth.js', 'dashboard/mcp.js', 'dashboard/core/portfolio.js', 'dashboard/core/wallets.js', 'dashboard/core/walletsync.js', 'dashboard/core/alchemy.js']) assert.ok(tpl.forbidden_paths.includes(f), `${f} is forbidden`);
  // The published templates before it are unchanged.
  assert.deepEqual(P.TEMPLATES['eng-app@4'].allowed_paths, ['dashboard/web/src/**', 'dashboard/public/**', 'dashboard/tests/**', 'docs/engineering/**']);
  assert.equal(P.TEMPLATES['eng-app@4'].forbidden_paths, undefined);
});

test('eng-backend@1 permits server routes, core logic and their tests', () => {
  const pol = { ...P.TEMPLATES['eng-backend@1'], policy_id: 'pol-20261026-0b0b0b', goal_id: 'desk-backend', expires_at: '2026-11-25T00:00:00.000Z', revoked_at: null };
  const content = (paths) => P.contentOf({ ...backendTask({ scope: { paths } }) });
  const fit = (paths) => P.fits(pol, content(paths), { now: T0 });
  assert.deepEqual(fit([CORE, TEST]), []);
  assert.deepEqual(fit([SERVER, 'dashboard/core/projects.js', 'dashboard/core/research.js', 'dashboard/tests/projects.test.js']), []);
  assert.deepEqual(fit(['dashboard/core/forensic-monitor.js', 'dashboard/tests/forensic-*.test.js']), []);
});

test('eng-backend@1 rejects the front door, the lane, the workflows, sign-in, the ledger and wallets, and a task with no test', () => {
  const pol = { ...P.TEMPLATES['eng-backend@1'], policy_id: 'pol-20261026-0b0b0b', goal_id: 'desk-backend', expires_at: '2026-11-25T00:00:00.000Z', revoked_at: null };
  const fit = (paths) => P.fits(pol, P.contentOf(backendTask({ scope: { paths: [...paths, TEST] } })), { now: T0 }).join(' | ');
  for (const p of ['dashboard/frontdoor.js', 'dashboard/engineering/inbox.js', 'dashboard/engineering/reviewer.js', '.github/workflows/test.yml', '.github/workflows/candidate-review.yml', 'server.js', 'dashboard/hosted.js', 'dashboard/oauth.js', 'dashboard/mcp.js', 'dashboard/core/portfolio.js', 'dashboard/core/wallets.js', 'dashboard/core/walletsync.js', 'dashboard/core/alchemy.js']) {
    assert.match(fit([p]), /forbidden under eng-backend@1|protected path/, p);
  }
  // Windows spelling does not get around it.
  assert.match(fit(['Dashboard/FrontDoor.js']), /forbidden under eng-backend@1|protected/);
  assert.match(fit(['DASHBOARD/Engineering/routes.js']), /forbidden under eng-backend@1|protected/);
  // A glob that reaches a forbidden or protected file, the gate's own core files, the guard tests and the browser app.
  assert.match(fit(['dashboard/core/**']), /protected path|forbidden/);
  assert.match(fit(['dashboard/**']), /protected path|forbidden/);
  assert.match(fit(['dashboard/core/scoring.js']), /protected path/);
  assert.match(fit(['dashboard/tests/engineering-inbox.test.js']), /guards the engineering lane/);
  assert.match(fit(['dashboard/web/src/App.jsx']), /browser app|outside the delegated paths/);
  assert.match(fit(['docs/engineering/x.md']), /outside the delegated paths/);
  // Every task names the test it adds or changes.
  assert.match(P.fits(pol, P.contentOf(backendTask({ scope: { paths: [CORE] } })), { now: T0 }).join(' '), /eng-backend@1 needs a test/);
  assert.match(P.fits(pol, P.contentOf(backendTask({ scope: { paths: [CORE, 'dashboard/tests/helpers-fictional.js'] } })), { now: T0 }).join(' '), /needs a test/);
  // Design and explore are not delegated.
  assert.match(P.fits(pol, P.contentOf(backendTask({ intent: 'design' })), { now: T0 }).join(' '), /intent design is not delegated/);
});

// --- admission and the candidate ------------------------------------------------

test('admission: a backend task is admitted under an active eng-backend@1 delegation with no passphrase', (t) => {
  const { ws, pol } = backendDesk(t, 'admit');
  assert.equal(pol.template, 'eng-backend@1');
  assert.deepEqual(pol.forbidden_paths, P.TEMPLATES['eng-backend@1'].forbidden_paths, 'the delegation carries the template\'s forbidden paths');
  assert.equal(pol.requires_tests, P.TEST_FILES);
  const s = submitted(ws);
  assert.equal(s.status, 'admitted');
  const v = I.getTask(ws, CHAT, s.task_id, o());
  assert.equal(v.authorization.kind, 'policy');
  assert.equal(v.authorization.template, 'eng-backend@1');
  assert.equal(v.authorization.required_review, 'chatgpt');
  assert.equal(v.authorization.release_mode, 'owner');
  // Nothing of Eric's was asked for: the inbox holds no authorization by him.
  assert.ok(!v.events.some((e) => e.type === 'authorized_by_owner'));
  // A task outside it waits for Eric.
  const out = submitted(ws, backendTask({ title: 'Front door (FICTIONAL)', scope: { paths: ['dashboard/frontdoor.js', TEST] } }));
  assert.equal(out.status, 'awaiting_authorization');
  assert.match(out.says, /forbidden under eng-backend@1|protected/);
  // Another goal waits too.
  assert.equal(submitted(ws, backendTask({ title: 'Other goal (FICTIONAL)', goal_id: 'other-goal' })).status, 'awaiting_authorization');
});

test('candidate: a delegated backend candidate carries a test and never a line that mounts the lane or the front door', (t) => {
  const { ws } = backendDesk(t, 'candidate');
  const s = submitted(ws);
  const m = onMain(ws, s.task_id);
  const noTest = codeOf(() => candidate(ws, s.task_id, m.token, m.number, { files: { [CORE]: 'module.exports = 2;' } }));
  assert.equal(noTest, 'SCOPE');
  // A deleted test is not a test added or changed.
  const deleted = [`diff --git a/${CORE} b/${CORE}`, 'new file mode 100644', '--- /dev/null', `+++ b/${CORE}`, '@@ -0,0 +1 @@', '+module.exports = 3;', `diff --git a/${TEST} b/${TEST}`, 'deleted file mode 100644', `--- a/${TEST}`, '+++ /dev/null', '@@ -1 +0,0 @@', '-old', ''].join(NL);
  assert.equal(codeOf(() => candidate(ws, s.task_id, m.token, m.number, { files: { [CORE]: '', [TEST]: '' }, diff: deleted, head: sha1('deleted') })), 'SCOPE');
  // server.js may change, but never the line that mounts the lane or opens the front door.
  assert.equal(codeOf(() => candidate(ws, s.task_id, m.token, m.number, { files: { [SERVER]: "require('./engineering/routes').makeEngineeringRoutes(ws);", [TEST]: 'test' }, head: sha1('mount') })), 'SCOPE');
  assert.equal(codeOf(() => candidate(ws, s.task_id, m.token, m.number, { files: { [SERVER]: "const f = require('./frontdoor');", [TEST]: 'test' }, head: sha1('door') })), 'SCOPE');
  assert.equal(I.getTask(ws, CHAT, s.task_id, o()).candidate, null, 'nothing was recorded');
  const ok = candidate(ws, s.task_id, m.token, m.number, { files: { [SERVER]: "route('GET', '/api/fictional', () => ({}));", [CORE]: 'module.exports = 4;', [TEST]: "require('../core/fictional-backend');" } });
  assert.equal(ok.r.status, 'verifying');
  const v = I.getTask(ws, CHAT, s.task_id, o());
  assert.deepEqual(v.candidate.files, [SERVER, CORE, TEST]);
});

// --- the unattended review ------------------------------------------------------------

test('the reviewer packet: only the reviewer service reads it, and it says whether the candidate may be reviewed now', (t) => {
  const x = pendingReview(t, 'packet');
  assert.equal(I.getTask(x.ws, CHAT, x.id, o()).status, 'review_pending');
  for (const who of [OWNER, CHAT, CHAT_REV, W1, { kind: 'service', service: 'other@1', assistant: 'chatgpt', role: 'reviewer' }]) {
    assert.equal(codeOf(() => I.reviewerPacket(x.ws, who, { head_sha: x.head }, { ci: CI_OK, now: T0 })), 'ROLE_REFUSED');
  }
  const p = I.reviewerPacket(x.ws, I.REVIEWER_SERVICE, { head_sha: x.head }, { ci: CI_OK, now: T0 });
  assert.equal(p.reviewable, true, p.reasons.join(', '));
  assert.equal(p.task_id, x.id);
  assert.equal(p.number, x.number);
  assert.equal(p.candidate.diff_sha256, x.diffSha);
  assert.equal(p.candidate.merge_base_sha, MAIN1);
  assert.deepEqual(p.builders, [{ kind: 'connection', assistant: 'claude' }]);
  assert.equal(p.delegation.template, 'eng-backend@1');
  assert.equal(p.delegation.requires_tests, P.TEST_FILES);
  assert.equal(p.verification.ok, true);
  assert.equal(p.required_review, 'chatgpt');
  // GitHub's check runs, as the desk read them, decide whether it is time.
  const at = (ci) => I.reviewerPacket(x.ws, I.REVIEWER_SERVICE, { head_sha: x.head }, { ci, now: T0 }).reasons;
  assert.deepEqual(at(null), ['ci_unknown']);
  assert.deepEqual(at({ state: 'unknown', why: 'rate limited' }), ['ci_unknown']);
  assert.deepEqual(at({ state: 'pending', runs: [{ name: 'test', status: 'in_progress', conclusion: null }] }), ['ci_pending']);
  assert.deepEqual(at({ state: 'failure', runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] }), ['ci_failed']);
  assert.deepEqual(at({ state: 'success', runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }] }), ['ci_pending'], 'the suite itself must have passed');
  // The review's own run never counts for or against it.
  assert.deepEqual(at({ state: 'pending', runs: [...CI_OK.runs, { name: 'candidate review', status: 'in_progress', conclusion: null }] }), []);
  assert.equal(codeOf(() => I.reviewerPacket(x.ws, I.REVIEWER_SERVICE, { head_sha: sha1('nobody') }, { ci: CI_OK, now: T0 })), 'NOT_FOUND');
});

test('an unattended pass makes the task ready and nothing more: Eric merges it, no workflow promotes it', (t) => {
  const x = pendingReview(t, 'pass');
  const r = save(x.ws, x);
  assert.equal(r.unchanged, false);
  assert.equal(r.counts_for_requirement, true);
  assert.equal(r.same_builder, false);
  assert.equal(r.status, 'ready_for_promotion');
  const v = I.getTask(x.ws, CHAT, x.id, o(10 * MIN));
  assert.equal(v.review.state, 'pass');
  assert.equal(v.review.latest.reviewer.automated, true);
  assert.equal(v.review.latest.reviewer.kind, 'chatgpt');
  assert.equal(v.review.latest.reviewer.conn, I.SERVICE_CONN);
  assert.match(v.next_action, /Eric merges the pull request from claude\/candidate-eng-70 on GitHub himself/);
  assert.match(v.next_action, /no agent merges or promotes it/);
  assert.equal(v.verification.ci.state, 'success', 'the desk recorded its own read of the check runs');
  // The attestation backlog-pr reads never lets a workflow merge it.
  const a = I.attestationView(x.ws, x.head, o(10 * MIN));
  assert.equal(a.promotable, false);
  assert.ok(a.reasons.includes('owner_merges_unattended_review'));
  assert.ok(a.reasons.includes('release_by_owner'));
  assert.match(BP.deskReason('owner_merges_unattended_review'), /Eric merges it himself/);
  // The same answer again is unchanged; another answer for the same head is refused (one paid review per head).
  assert.equal(save(x.ws, x).unchanged, true);
  const again = (() => { try { save(x.ws, x, { result: 'changes_required', findings: [{ severity: 'low', summary: 'x' }] }); } catch (e) { return e; } return null; })();
  assert.equal(again.code, 'REVIEW_REFUSED');
  assert.ok(again.details.reasons.includes('already_reviewed'));
  // The review file says what read it and how.
  const file = JSON.parse(fs.readFileSync(x.ws.abs(`engineering/tasks/${x.id}/reviews/${r.review_id}.json`), 'utf8'));
  assert.equal(file.automated.service, 'candidate-review@1');
  assert.equal(file.automated.model, 'gpt-fictional');
  assert.equal(file.same_builder, false);
  assert.equal(file.limited, false);
});

test('an unattended review is saved only for the exact candidate, merge base and diff, with the tests passed on GitHub', (t) => {
  const x = pendingReview(t, 'exact');
  assert.equal(codeOf(() => save(x.ws, x, { diff_sha256: 'e'.repeat(64) })), 'DIFF_MISMATCH');
  assert.equal(codeOf(() => save(x.ws, x, { merge_base_sha: MAIN0 })), 'MERGE_BASE_MISMATCH');
  assert.equal(codeOf(() => save(x.ws, x, { head_sha: sha1('other head') })), 'WRONG_CANDIDATE');
  assert.equal(codeOf(() => save(x.ws, x, {}, { ci: { state: 'pending', runs: [{ name: 'test', status: 'queued', conclusion: null }] } })), 'REVIEW_REFUSED');
  assert.equal(codeOf(() => save(x.ws, x, {}, { ci: null })), 'REVIEW_REFUSED');
  assert.equal(codeOf(() => save(x.ws, x, { result: 'pass', findings: [{ severity: 'high', summary: 'broken' }] })), 'BAD_INPUT');
  assert.equal(codeOf(() => save(x.ws, x, { approved: true })), 'FORGED_AUTHORITY');
  assert.equal(codeOf(() => save(x.ws, x, { read: { diff: true } })), 'BAD_INPUT');
  assert.equal(codeOf(() => I.saveAutomatedReview(x.ws, CHAT_REV, { task_id: x.id, head_sha: x.head }, { ci: CI_OK, now: T0 })), 'ROLE_REFUSED');
  assert.equal(I.getTask(x.ws, CHAT, x.id, o()).review.state, 'pending', 'nothing was saved');
  // A pause on the desk stops it too.
  I.setPaused(x.ws, OWNER, { paused: true, reason: 'FICTIONAL' }, o());
  assert.equal(codeOf(() => save(x.ws, x)), 'REVIEW_REFUSED');
});

test('Rule N4: the reviewer never decides work its own kind of assistant built', (t) => {
  const x = pendingReview(t, 'self', { w: W_CHAT });
  const p = I.reviewerPacket(x.ws, I.REVIEWER_SERVICE, { head_sha: x.head }, { ci: CI_OK, now: T0 });
  assert.equal(p.reviewable, false);
  assert.ok(p.reasons.includes('self_review'));
  const e = (() => { try { save(x.ws, x); } catch (err) { return err; } return null; })();
  assert.equal(e.code, 'REVIEW_REFUSED');
  assert.ok(e.details.reasons.includes('self_review'));
  assert.equal(I.getTask(x.ws, CHAT, x.id, o()).status, 'review_pending');
});

test('an unattended changes_required sends the task back to the builder with a correction', (t) => {
  const x = pendingReview(t, 'changes');
  const r = save(x.ws, x, { result: 'changes_required', findings: [{ severity: 'medium', summary: 'Handle the empty case (FICTIONAL).', path: CORE, line: 1 }] });
  assert.equal(r.status, 'queued');
  const v = I.getTask(x.ws, CHAT, x.id, o(10 * MIN));
  assert.equal(v.corrections.length, 1);
  assert.equal(v.review.state, 'changes_required');
  assert.match(v.next_action, /correct the open findings/);
});

test('the review packet is never public, and only the reviewer token reaches it', async (t) => {
  const x = pendingReview(t, 'route');
  let calls = 0;
  const github = { checks: async () => { calls += 1; return CI_OK; } };
  const serve = async (env) => {
    const routes = makeEngineeringRoutes(x.ws, { env, github, HttpError: F.HttpError, readCodes: F.READ_CODES });
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (routes.publicRead(req, res, url)) return;
        if (await routes.reviewer(req, res, url)) return;
        throw new F.HttpError(404, 'Not found');
      } catch (err) { F.sendError(req, res, err); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
  };
  const call = async (base, p, { body = { head_sha: x.head }, token = TOKEN, method = 'POST' } = {}) => {
    const res = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === 'POST' ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  // Off without the token in the environment, or with a short one.
  for (const env of [{}, { CR_ENG_REVIEWER_TOKEN: 'short' }]) {
    const off = await serve(env);
    assert.equal((await call(off, '/engineering/reviewer/packet')).status, 404);
  }
  const on = await serve({ CR_ENG_REVIEWER_TOKEN: TOKEN });
  assert.equal((await call(on, '/engineering/reviewer/packet', { token: null })).status, 401);
  assert.equal((await call(on, '/engineering/reviewer/packet', { token: `${TOKEN}x` })).status, 401);
  assert.equal((await call(on, '/engineering/reviewer/packet', { method: 'GET' })).status, 405);
  assert.equal(calls, 0, 'GitHub is not asked before the token holds');
  assert.equal((await call(on, '/engineering/reviewer/packet', { body: { head_sha: x.head, task_id: x.id } })).status, 400);
  assert.equal((await call(on, '/engineering/reviewer/packet', { body: { head_sha: 'abc' } })).status, 400);
  const p = await call(on, '/engineering/reviewer/packet');
  assert.equal(p.status, 200);
  assert.equal(p.json.reviewable, true);
  assert.equal(p.json.goal.title, 'Backend change (FICTIONAL)');
  // The public attestation carries codes, never the goal.
  const pub = await call(on, `/engineering/attestations/${x.head}`, { method: 'GET', token: null });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.goal, undefined);
  const bad = await call(on, '/engineering/reviewer/reviews', { body: { task_id: x.id, head_sha: x.head, merge_base_sha: MAIN1, diff_sha256: 'e'.repeat(64), result: 'pass', findings: [], model: 'gpt-fictional' } });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, 'DIFF_MISMATCH');
  const ok = await call(on, '/engineering/reviewer/reviews', { body: { task_id: x.id, head_sha: x.head, merge_base_sha: MAIN1, diff_sha256: x.diffSha, result: 'pass', findings: [], model: 'gpt-fictional' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'ready_for_promotion');
  const twice = await call(on, '/engineering/reviewer/reviews', { body: { task_id: x.id, head_sha: x.head, merge_base_sha: MAIN1, diff_sha256: x.diffSha, result: 'changes_required', findings: [{ severity: 'low', summary: 'x' }], model: 'gpt-fictional' } });
  assert.equal(twice.status, 409);
  assert.deepEqual(twice.json.reasons, ['task_status:ready_for_promotion', 'already_reviewed']);
  // A body over the limit is refused whole.
  assert.equal((await call(on, '/engineering/reviewer/reviews', { body: { head_sha: x.head, summary: 'x'.repeat(70 * 1024) } })).status, 413);
});

// --- reviewer.js ---------------------------------------------------------------------

test('reviewer.js: the reviewer\'s own kind is recognized in commits, tests must require a changed module, and a verdict is read strictly', () => {
  for (const s of ['ChatGPT <noreply@openai.com>', 'OpenAI Codex <codex@openai.com>', 'gpt-5 bot <x@y>', 'GPT4 <x@y>']) assert.ok(R.REVIEWER_KIN_RE.test(s), s);
  for (const s of ['Claude Opus 5.5 <noreply@anthropic.com>', 'kuaya1 <kuaya23@gmail.com>', 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>']) assert.ok(!R.REVIEWER_KIN_RE.test(s), s);
  const files = { [CORE]: 'x', 'dashboard/core/other.js': 'y', [TEST]: "const m = require('../core/fictional-backend');", 'dashboard/tests/unrelated.test.js': "require('../core/projects');" };
  const at = (f) => (f in files ? files[f] : null);
  const cov = R.testCoverage(Object.keys(files), at);
  assert.equal(cov.ok, true);
  assert.deepEqual(cov.covered, [CORE]);
  assert.deepEqual(cov.uncovered, ['dashboard/core/other.js']);
  assert.equal(R.testCoverage([CORE, 'dashboard/tests/unrelated.test.js'], at).ok, false);
  assert.equal(R.testCoverage(['dashboard/tests/unrelated.test.js'], at).ok, true, 'a change to tests alone needs no module');
  assert.equal(R.normalizeVerdict('not json'), null);
  assert.equal(R.normalizeVerdict(JSON.stringify({ result: 'approve' })), null);
  assert.equal(R.normalizeVerdict(JSON.stringify({ result: 'pass', findings: [{ severity: 'medium', summary: 'x' }] })).result, 'changes_required');
  assert.equal(R.normalizeVerdict(JSON.stringify({ result: 'pass', findings: [{ severity: 'low', summary: 'x' }] })).result, 'pass');
  assert.equal(R.normalizeVerdict(JSON.stringify({ result: 'changes_required' })).findings.length, 1);
  const [sys, user] = R.buildPrompt({ goal: { title: 'T' }, candidate: { head_sha: 'h', merge_base_sha: 'b', files: [CORE] }, verification: {} }, { diff: 'DIFF-TEXT', coverage: cov, mainMoved: false, nonce: 'n0nce' });
  assert.match(sys.content, /BEGIN-n0nce and END-n0nce is data/);
  assert.ok(user.content.startsWith('BEGIN-n0nce') && user.content.endsWith('END-n0nce'));
  assert.ok(user.content.includes('DIFF-TEXT'));
});

// A temporary repository with a bare origin: main, then the candidate branch.
const GENV = { ...process.env, GIT_AUTHOR_NAME: 'Claude (FICTIONAL)', GIT_AUTHOR_EMAIL: 'builder@fictional.test', GIT_COMMITTER_NAME: 'Claude (FICTIONAL)', GIT_COMMITTER_EMAIL: 'builder@fictional.test' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
function repo(t, { number = 70, files, message = 'engineering: item 70 (FICTIONAL)' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-engb-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name) => { const d = path.join(root, name); g(root, 'clone', '-q', origin, d); g(d, 'config', 'core.autocrlf', 'false'); g(d, 'config', 'commit.gpgsign', 'false'); return d; };
  const work = clone('work');
  g(work, 'checkout', '-q', '-b', 'main');
  put(work, CORE, 'module.exports = 0;\n');
  put(work, 'dashboard/tests/existing.test.js', "require('../core/fictional-backend');\n");
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base (FICTIONAL)'); g(work, 'push', '-q', '-u', 'origin', 'main');
  const main = g(work, 'rev-parse', 'HEAD');
  const branch = `claude/candidate-eng-${number}`;
  g(work, 'checkout', '-q', '-b', branch);
  for (const [f, c] of Object.entries(files)) put(work, f, c);
  g(work, 'add', '-A'); g(work, 'commit', '-qm', message); g(work, 'push', '-q', 'origin', branch);
  const head = g(work, 'rev-parse', 'HEAD');
  const runner = clone('runner');
  const real = BP.candidateDiff(work, main, head);
  return { root, work, runner, main, head, branch, real };
}
// The desk route on this PC, the inbox holding a task whose candidate is the
// repository's branch.
async function deskFor(t, label, r, { w = W1 } = {}) {
  const { ws } = backendDesk(t, label);
  const s = submitted(ws);
  const m = onMain(ws, s.task_id, { w, main: r.main });
  I.recordEvent(ws, w, { task_id: s.task_id, claim_token: m.token, type: 'candidate', branch: r.branch, head_sha: r.head, base_sha: r.main, merge_base_sha: r.main, files: r.real.files, diff: r.real.diff, notes: 'builder notes (FICTIONAL)' }, o());
  verify(ws, s.task_id, m.token, r.head, { w });
  const routes = makeEngineeringRoutes(ws, { env: { CR_ENG_REVIEWER_TOKEN: TOKEN }, github: { checks: async () => CI_OK }, HttpError: F.HttpError, readCodes: F.READ_CODES });
  const server = http.createServer(async (req, res) => {
    try {
      if (await routes.reviewer(req, res, new URL(req.url, 'http://127.0.0.1'))) return;
      throw new F.HttpError(404, 'Not found');
    } catch (err) { F.sendError(req, res, err); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  return { ws, id: s.task_id, url: `http://127.0.0.1:${server.address().port}` };
}
// A stand-in for the OpenAI API that answers one verdict and keeps what it was sent.
function openai(verdict) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (!String(url).startsWith('https://api.openai.com/')) return fetch(url, init);
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'chatcmpl-FICTIONAL', model: 'gpt-fictional-2026', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(verdict) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { sent, fetchImpl };
}
const envOf = (r, desk) => ({ BRANCH: r.branch, HEAD_SHA: r.head, DESK_URL: desk.url, CR_ENG_REVIEWER_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-FICTIONAL-not-a-key', OPENAI_REVIEW_MODEL: 'gpt-fictional', RUN_URL: 'https://github.com/kuaya1/CryptoResearch/actions/runs/1' });
const ghStub = () => {
  const calls = [];
  const gh = (args) => { calls.push(args); if (args[1] && args[1].includes('/pulls?')) return '[]'; if (args.includes('POST') && args.some((a) => /\/pulls$/.test(a))) return '41'; return '{}'; };
  return { calls, gh };
};

test('reviewer.js end to end: Git checks, one model call, the desk saves the pass, the pull request is opened and commented, nothing merged', async (t) => {
  const r = repo(t, { files: { [CORE]: 'module.exports = 1;\n', [TEST]: "const m = require('../core/fictional-backend');\nrequire('node:assert').equal(m, 1);\n" } });
  const desk = await deskFor(t, 'e2e', r);
  const ai = openai({ result: 'pass', summary: 'Does what the goal says (FICTIONAL).', findings: [{ severity: 'note', summary: 'Fine (FICTIONAL).', path: CORE, line: 1 }] });
  const { calls, gh } = ghStub();
  const out = await R.review({ env: envOf(r, desk), cwd: r.runner, fetchImpl: ai.fetchImpl, gh, sleep: async () => {} });
  assert.equal(out.status, 'reviewed', out.says);
  assert.equal(out.result, 'pass');
  assert.equal(out.task_status, 'ready_for_promotion');
  assert.equal(ai.sent.length, 1, 'one paid call');
  const req = ai.sent[0];
  assert.equal(req.headers.authorization, 'Bearer sk-FICTIONAL-not-a-key');
  assert.equal(req.body.model, 'gpt-fictional');
  assert.deepEqual(req.body.response_format, { type: 'json_object' });
  assert.ok(req.body.messages[1].content.includes(r.real.diff), 'the exact Git diff was sent');
  // The desk holds it as the unattended ChatGPT review of that exact diff.
  const v = I.getTask(desk.ws, CHAT, desk.id, o(10 * MIN));
  assert.equal(v.status, 'ready_for_promotion');
  assert.equal(v.review.latest.reviewer.automated, true);
  assert.equal(v.review.latest.reviewer.model, 'gpt-fictional-2026');
  assert.equal(I.attestationView(desk.ws, r.head, o(10 * MIN)).promotable, false);
  // GitHub: the pull request is found or opened and commented; never merged or approved.
  const flat = calls.map((a) => a.join(' '));
  assert.ok(flat.some((c) => c.includes(`pulls?state=open&head=kuaya1:${r.branch}`)));
  assert.ok(flat.some((c) => c.includes('POST repos/kuaya1/CryptoResearch/pulls')));
  assert.ok(flat.some((c) => c.includes('repos/kuaya1/CryptoResearch/issues/41/comments')));
  assert.ok(!flat.some((c) => /merge|reviews|approve/i.test(c.replace(/body=[\s\S]*/, ''))), 'no merge, no GitHub review, no approval');
  const comment = calls.find((a) => a.join(' ').includes('/comments')).find((a) => a.startsWith('body='));
  assert.match(comment, /Eric merges this pull request himself/);
  assert.ok(!comment.includes('Fine (FICTIONAL)'), 'the findings\' words stay on the desk');
  assert.equal(out.pr.pr, 41);
  // A second run for the same head pays for nothing.
  const again = await R.review({ env: envOf(r, desk), cwd: r.runner, fetchImpl: ai.fetchImpl, gh, sleep: async () => {} });
  assert.equal(again.status, 'not_reviewable');
  assert.ok(again.reasons.includes('already_reviewed'));
  assert.equal(ai.sent.length, 1);
});

test('reviewer.js asks no model when the branch is not what the desk recorded, its own kind wrote it, or its test misses the change', async (t) => {
  // The desk recorded another diff than Git's.
  const r1 = repo(t, { files: { [CORE]: 'module.exports = 1;\n', [TEST]: "require('../core/fictional-backend');\n" } });
  const d1 = await deskFor(t, 'mismatch', { ...r1, real: { ...r1.real, diff: `${r1.real.diff}+tampered\n` } });
  const ai1 = openai({ result: 'pass', findings: [] });
  const o1 = await R.review({ env: envOf(r1, d1), cwd: r1.runner, fetchImpl: ai1.fetchImpl, gh: null, sleep: async () => {} });
  assert.equal(o1.status, 'refused');
  assert.ok(o1.reasons.some((x) => x.startsWith('diff_mismatch')));
  assert.equal(ai1.sent.length, 0);
  // A commit co-authored by the reviewer's own kind of assistant.
  const r2 = repo(t, { files: { [CORE]: 'module.exports = 2;\n', [TEST]: "require('../core/fictional-backend');\n" }, message: 'engineering: item 70 (FICTIONAL)\n\nCo-authored-by: ChatGPT <noreply@openai.com>' });
  const d2 = await deskFor(t, 'kin', r2);
  const ai2 = openai({ result: 'pass', findings: [] });
  const o2 = await R.review({ env: envOf(r2, d2), cwd: r2.runner, fetchImpl: ai2.fetchImpl, gh: null, sleep: async () => {} });
  assert.equal(o2.status, 'refused');
  assert.ok(o2.reasons.some((x) => x.startsWith('self_review')));
  assert.equal(ai2.sent.length, 0);
  // A ChatGPT connection built it: the desk itself says no.
  const r3 = repo(t, { files: { [CORE]: 'module.exports = 3;\n', [TEST]: "require('../core/fictional-backend');\n" } });
  const d3 = await deskFor(t, 'chatgpt-built', r3, { w: W_CHAT });
  const ai3 = openai({ result: 'pass', findings: [] });
  const o3 = await R.review({ env: envOf(r3, d3), cwd: r3.runner, fetchImpl: ai3.fetchImpl, gh: null, sleep: async () => {} });
  assert.equal(o3.status, 'not_reviewable');
  assert.ok(o3.reasons.includes('self_review'));
  assert.equal(ai3.sent.length, 0);
  // The changed test does not require the changed module.
  const r4 = repo(t, { files: { [CORE]: 'module.exports = 4;\n', [TEST]: "require('node:assert').ok(true);\n" } });
  const d4 = await deskFor(t, 'unmatched', r4);
  const ai4 = openai({ result: 'pass', findings: [] });
  const o4 = await R.review({ env: envOf(r4, d4), cwd: r4.runner, fetchImpl: ai4.fetchImpl, gh: null, sleep: async () => {} });
  assert.equal(o4.status, 'refused');
  assert.deepEqual(o4.reasons, ['tests_unmatched']);
  assert.equal(ai4.sent.length, 0);
  assert.equal(I.getTask(d4.ws, CHAT, d4.id, o()).status, 'review_pending', 'nothing moved on the desk');
  // Not configured: no secret, no call.
  const o5 = await R.review({ env: { ...envOf(r4, d4), OPENAI_API_KEY: '' }, cwd: r4.runner, fetchImpl: ai4.fetchImpl, gh: null });
  assert.equal(o5.status, 'not_configured');
  assert.equal(o5.exit, 1);
  assert.ok(!JSON.stringify(o5).includes(TOKEN), 'no secret in what it prints');
  // Not a candidate branch.
  assert.equal((await R.review({ env: { ...envOf(r4, d4), BRANCH: 'claude/backlog-eng-70' }, cwd: r4.runner, fetchImpl: ai4.fetchImpl })).status, 'skipped');
});

test('reviewer.js sends the paid request once: a 503 or a timeout is not retried', async (t) => {
  const r = repo(t, { files: { [CORE]: 'module.exports = 5;\n', [TEST]: "const m = require('../core/fictional-backend');\nrequire('node:assert').equal(m, 5);\n" } });
  const desk = await deskFor(t, 'no-retry', r);
  for (const fail of [() => new Response('{"error":{"code":"overloaded"}}', { status: 503 }), () => { throw new Error('The operation was aborted due to timeout'); }]) {
    let paid = 0;
    const fetchImpl = async (url, init) => { if (!String(url).startsWith('https://api.openai.com/')) return fetch(url, init); paid += 1; return fail(); };
    const out = await R.review({ env: envOf(r, desk), cwd: r.runner, fetchImpl, gh: null, sleep: async () => {} });
    assert.equal(out.status, 'model_failed', out.says);
    assert.equal(paid, 1, 'one paid request per run');
  }
  assert.equal(I.getTask(desk.ws, CHAT, desk.id, o()).status, 'review_pending', 'nothing saved');
});
