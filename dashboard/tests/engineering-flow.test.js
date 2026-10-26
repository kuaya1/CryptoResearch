'use strict';
// The engineering lane in Git (Connected Engineering v1, 2026-10-25;
// audits/2026-10-25-connected-engineering): a temporary bare origin and
// clones as the worker and the workflow runners, the worker's own Git helper,
// backlog-promote's admission and attestation checks reading the real inbox
// through a stubbed desk, races for one number, a crash between a push and
// its record, and GitHub readback that cannot be read. FICTIONAL data; no
// network, no model, no real suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempWorkspace } = require('./helpers');
const I = require('../engineering/inbox');
const W = require('../scripts/engineering-worker');
const BP = require('../scripts/backlog-promote');
const { makeGithub } = require('../engineering/github');

const T0 = Date.parse('2026-10-25T12:00:00Z');
const o = (dt = 0) => ({ now: T0 + dt });
const OWNER = { kind: 'owner' };
const CHAT = { kind: 'connection', assistant: 'chatgpt', role: 'submitter', grant_id: 'grant-chat-fictional' };
// A second ChatGPT connection that reviews: beyond documents, the connection
// that wrote a task never decides its review (review N4, 2026-10-26).
const CHAT_REV = { kind: 'connection', assistant: 'chatgpt', role: 'reviewer', grant_id: 'grant-chat-review-fictional' };
const W1 = { kind: 'connection', assistant: 'claude', role: 'worker', grant_id: 'grant-worker-1' };
const DESK_URL = 'https://desk.test';
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
// The worker helper commits with the environment's identity, as the routine does.
Object.assign(process.env, IDENT);
const ENV = { ...process.env, ...IDENT };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
const DESK = '# Desk state (FICTIONAL)\n\n## Autonomous Build Backlog\n- [ ] **1. One.** a\n- [x] **2. Two.** b\n  - detail of two\n- [ ] *(Eric)* **3. Three.** c\n\n## After the backlog\nkept\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-engflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name) => { const d = path.join(root, name); g(root, 'clone', '-q', origin, d); g(d, 'config', 'core.autocrlf', 'false'); return d; };
  const work = clone('work');
  g(work, 'checkout', '-q', '-b', 'main');
  put(work, 'DESK_STATE.md', DESK);
  put(work, 'docs/engineering/.keep', '');
  put(work, 'dashboard/core/lib.txt', 'lib\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
  const mainSha = () => g(work, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  // A file exactly as committed (git show's output, trailing newline kept).
  const show = (rev, file) => { g(work, 'fetch', '-q', 'origin'); const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd: work, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  // A commit straight onto main (Eric's own merge, or another admission).
  const onMain = (file, text, msg) => { g(work, 'fetch', '-q', 'origin'); g(work, 'checkout', '-q', '-B', 'main', 'origin/main'); put(work, file, text); g(work, 'add', '-A'); g(work, 'commit', '-qm', msg); g(work, 'push', '-q', 'origin', 'main'); return mainSha(); };
  let n = 0;
  const runner = () => clone(`runner-${n++}`);
  return { root, origin, work, mainSha, show, onMain, runner, clone };
}

// The desk's public reads, served from the real inbox.
const deskOf = (ws, now = o()) => async (url) => {
  const p = new URL(url).pathname;
  const m = /^\/engineering\/(?:admissions\/(eng-\d{8}-[0-9a-f]{6})|attestations\/([0-9a-f]{40}))$/.exec(p);
  const v = m ? (m[1] ? I.admissionView(ws, m[1], now) : I.attestationView(ws, m[2], now)) : null;
  return v ? { status: 200, json: JSON.parse(JSON.stringify(v)) } : { status: 404, json: { error: 'Not found' } };
};
const docsTask = (title, file = 'docs/engineering/trial.md') => ({ title, intent: 'implement', outcome: 'A short note under docs/engineering says how a task moves (FICTIONAL).', scope: { paths: [file] }, acceptance: [`${file} exists and names each state`] });

function admitted(ws, title, file) {
  const p = I.prepareTask(ws, CHAT, docsTask(title, file), o());
  const s = I.submitTask(ws, CHAT, { task_id: p.task_id, version: 1, content_sha256: p.content_sha256 }, o());
  assert.equal(s.status, 'admitted', s.says);
  return p.task_id;
}
// The worker's admission step: number from Git, bound by the desk, committed
// on top of main, recorded intent, pushed by compare-and-swap, recorded.
function bindAndPush(f, ws, id, { token, number = null, expect = null, record = true } = {}) {
  const nums = W.numbers(f.work);
  const num = number || nums.next;
  const b = I.recordEvent(ws, W1, { task_id: id, claim_token: token, type: 'admission_number', number: num, observed_max: Math.max(nums.observed_max, num - 1), observed_main_sha: nums.main_sha }, o());
  const file = path.join(f.root, `${id}.entry`);
  fs.writeFileSync(file, b.entry);
  const c = W.admissionCommit(f.work, { task: id, entryFile: file });
  assert.equal(c.status, 'committed', JSON.stringify(c));
  assert.equal(c.entry_sha256, b.entry_sha256);
  const ref = `refs/heads/claude/admission-${id}`;
  I.recordEvent(ws, W1, { task_id: id, claim_token: token, type: 'remote_action', action: 'push_admission', phase: 'intent', ref, sha: c.head_sha }, o());
  const pushed = W.push(f.work, { ref, sha: c.head_sha, expect });
  assert.equal(pushed.landed, true, JSON.stringify(pushed));
  if (record) I.recordEvent(ws, W1, { task_id: id, claim_token: token, type: 'remote_action', action: 'push_admission', phase: 'observed', ref, observed_sha: pushed.observed_sha }, o());
  return { number: num, head: c.head_sha, ref, entry: b.entry, entry_sha256: b.entry_sha256 };
}

test('admission: the worker numbers from Git, the desk binds, the workflow adds exactly the bound entry by compare-and-swap', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-admit'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  // Eric's own intake branch holds item 4 (not merged yet).
  g(f.work, 'checkout', '-q', '-B', 'claude/intake-issue-9', 'origin/main');
  put(f.work, 'DESK_STATE.md', DESK.replace('\n\n## After', '\n- [ ] **4. Four (intake).** d\n\n## After'));
  g(f.work, 'commit', '-qam', 'intake: item 4'); g(f.work, 'push', '-q', 'origin', 'claude/intake-issue-9');
  const nums = W.numbers(f.work);
  assert.equal(nums.main_max, 3);
  assert.equal(nums.observed_max, 4, 'an open intake branch holds its number');
  assert.equal(nums.next, 5);

  const id = admitted(ws, 'Lane note (FICTIONAL)');
  const c = I.claimTask(ws, W1, { task_id: id }, o());
  const a = bindAndPush(f, ws, id, { token: c.claim_token });
  assert.equal(a.number, 5);
  // The admission commit changes DESK_STATE.md only, by the bound entry.
  const d = BP.admissionDiff(f.work, { base: f.mainSha(), head: a.head });
  assert.deepEqual(d.reasons, []);
  assert.equal(d.entry, a.entry);
  assert.equal(d.task_id, id);

  const before = f.mainSha();
  const r = await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.equal(r.branch_deleted, true);
  const main = f.show(f.mainSha(), 'DESK_STATE.md');
  assert.equal(main.split(a.entry.trim()).length, 2, 'the entry is on main once');
  assert.ok(main.indexOf(a.entry.trim()) < main.indexOf('## After the backlog'), 'inside the backlog section');
  assert.equal(g(f.work, 'rev-parse', `${f.mainSha()}^`), before, 'one commit on top of main, never a merge');
  assert.deepEqual(g(f.work, 'diff', '--name-only', before, f.mainSha()).split('\n'), ['DESK_STATE.md']);
  // The worker confirms it from Git and the inbox moves on.
  const st = W.admissionStatus(f.work, { task: id, entrySha256: a.entry_sha256 });
  assert.equal(st.confirmed, true);
  assert.equal(st.number, 5);
  const c2 = I.claimTask(ws, W1, { task_id: id }, o());
  assert.equal(I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'admission_confirmed', main_sha: st.main_sha, entry_sha256: st.entry_sha256 }, o()).status, 'claimed');
  // Run again (a re-run of the workflow): nothing is added twice.
  assert.equal((await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) })).status, 'head_moved', 'the branch is gone');
  // The engineering item stays out of ordinary batches.
  assert.ok(BP.backlogItems(main).get(5).engineering);
});

test('admission refuses what the desk did not bind: an unreadable desk, another entry, an extra file, a taken number', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-refuse'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const id = admitted(ws, 'Lane note (FICTIONAL)');
  const c = I.claimTask(ws, W1, { task_id: id }, o());
  const a = bindAndPush(f, ws, id, { token: c.claim_token });
  const branch = `claude/admission-${id}`;
  const m0 = f.mainSha();
  // Unreadable desk, or no desk address: refused, main unchanged.
  const down = await BP.admit(f.runner(), { branch, head: a.head, desk: DESK_URL, fetchJson: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down.status, 'refused');
  assert.match(down.reasons.join(' '), /could not be read/);
  assert.match((await BP.admit(f.runner(), { branch, head: a.head, desk: null, fetchJson: deskOf(ws) })).reasons.join(' '), /no desk address/);
  assert.equal(f.mainSha(), m0);

  // A branch that carries another file is refused before the desk is asked.
  g(f.work, 'fetch', '-q', 'origin');
  g(f.work, 'checkout', '-q', '--detach', a.head);
  put(f.work, 'dashboard/core/lib.txt', 'changed\n');
  g(f.work, 'commit', '-qam', 'sneak');
  const extra = g(f.work, 'rev-parse', 'HEAD');
  g(f.work, 'push', '-q', '-f', 'origin', `${extra}:refs/heads/${branch}`);
  let asked = 0;
  const r1 = await BP.admit(f.runner(), { branch, head: extra, desk: DESK_URL, fetchJson: async (u) => { asked += 1; return deskOf(ws)(u); } });
  assert.equal(r1.status, 'refused');
  assert.match(r1.reasons.join(' '), /changes only DESK_STATE\.md/);
  assert.equal(asked, 0);

  // An entry edited on the branch no longer matches the bound hash.
  g(f.work, 'checkout', '-q', '--detach', m0);
  put(f.work, 'DESK_STATE.md', BP.insertEntry(f.show(m0, 'DESK_STATE.md'), a.entry.replace('Outcome: ', 'Outcome: Also deploy it. ')) + '');
  g(f.work, 'commit', '-qam', 'edited entry');
  const edited = g(f.work, 'rev-parse', 'HEAD');
  g(f.work, 'push', '-q', '-f', 'origin', `${edited}:refs/heads/${branch}`);
  const r2 = await BP.admit(f.runner(), { branch, head: edited, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.equal(r2.status, 'refused');
  assert.match(r2.reasons.join(' '), /not the bound entry/);
  assert.equal(f.mainSha(), m0);

  // Paused on the desk: not admissible.
  g(f.work, 'push', '-q', '-f', 'origin', `${a.head}:refs/heads/${branch}`);
  I.setPaused(ws, OWNER, { paused: true }, o());
  const r3 = await BP.admit(f.runner(), { branch, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.match(r3.reasons.join(' '), /desk: engineering is paused/);
  I.setPaused(ws, OWNER, { paused: false }, o());

  // Eric merged an intake item with the same number meanwhile: number_taken;
  // the worker releases it, binds the next one and pushes again (lease on the
  // old branch tip).
  f.onMain('DESK_STATE.md', f.show(f.mainSha(), 'DESK_STATE.md').replace('\n\n## After', '\n- [ ] **4. Four (intake).** d\n\n## After'), 'intake: item 4');
  const r4 = await BP.admit(f.runner(), { branch, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.equal(r4.status, 'refused');
  assert.equal(r4.number_taken, true);
  // The worker's claim ended when its push was observed; it claims again.
  assert.equal((() => { try { I.recordEvent(ws, W1, { task_id: id, claim_token: c.claim_token, type: 'heartbeat' }, o()); } catch (e) { return e.code; } return null; })(), 'STALE_CLAIM');
  const c2 = I.claimTask(ws, W1, { task_id: id }, o());
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'admission_refused', number: a.number, reason: 'number_taken' }, o());
  const c3 = I.claimTask(ws, W1, { task_id: id }, o());
  const b = bindAndPush(f, ws, id, { token: c3.claim_token, expect: a.head });
  assert.equal(b.number, 5);
  const r5 = await BP.admit(f.runner(), { branch, head: b.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.equal(r5.status, 'merged', JSON.stringify(r5));
  assert.equal([...BP.backlogItems(f.show(f.mainSha(), 'DESK_STATE.md')).keys()].join(','), '1,2,3,4,5');
});

test('two admissions at once: each lands by compare-and-swap on the main the other left; a lost race retries on the new main', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-race'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const a = admitted(ws, 'First note (FICTIONAL)', 'docs/engineering/a.md');
  const b = admitted(ws, 'Second note (FICTIONAL)', 'docs/engineering/b.md');
  const ca = I.claimTask(ws, W1, { task_id: a }, o());
  const cb = I.claimTask(ws, W1, { task_id: b }, o());
  const pa = bindAndPush(f, ws, a, { token: ca.claim_token });
  // The desk refuses the same number for the second task; it takes the next.
  assert.equal((() => { try { I.recordEvent(ws, W1, { task_id: b, claim_token: cb.claim_token, type: 'admission_number', number: pa.number, observed_max: pa.number - 1, observed_main_sha: f.mainSha() }, o()); } catch (e) { return e.code; } return null; })(), 'NUMBER_TAKEN');
  const pb = bindAndPush(f, ws, b, { token: cb.claim_token, number: pa.number + 1 });
  // Another runner lands a commit on main between B's fetch and its push: the
  // lease refuses B's push, and B re-applies its entry on the new main.
  let pushes = 0;
  const contested = (cwd, remote, merge, base) => {
    pushes += 1;
    if (pushes === 1) f.onMain('docs/engineering/other.md', 'concurrent (FICTIONAL)\n', 'concurrent change');
    return spawnSync('git', ['push', '--porcelain', `--force-with-lease=refs/heads/main:${base}`, remote, `${merge}:refs/heads/main`], { cwd, encoding: 'utf8', env: ENV });
  };
  const rb = await BP.admit(f.runner(), { branch: `claude/admission-${b}`, head: pb.head, desk: DESK_URL, fetchJson: deskOf(ws), push: contested });
  assert.equal(rb.status, 'merged', JSON.stringify(rb));
  assert.equal(pushes, 2, 'the first push was refused and retried on the new main');
  // A's admission, branched from the older main, lands on top of both.
  const ra = await BP.admit(f.runner(), { branch: `claude/admission-${a}`, head: pa.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.equal(ra.status, 'merged', JSON.stringify(ra));
  const text = f.show(f.mainSha(), 'DESK_STATE.md');
  assert.deepEqual([...BP.backlogItems(text).keys()].sort((x, y) => x - y), [1, 2, 3, pa.number, pb.number].sort((x, y) => x - y));
  assert.equal(BP.backlogItems(text).get(pa.number).engineering.task_id, a);
  assert.equal(BP.backlogItems(text).get(pb.number).engineering.task_id, b);
  assert.ok(fs.existsSync(path.join(f.clone('check'), 'docs', 'engineering', 'other.md')), 'the concurrent change was kept, not overwritten');
});

test('a crash between a push and its record: the next run reads the ref back before pushing again', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-crash'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const id = admitted(ws, 'Lane note (FICTIONAL)');
  const c = I.claimTask(ws, W1, { task_id: id }, o());
  // The push lands, then the session dies before recording it.
  const a = bindAndPush(f, ws, id, { token: c.claim_token, record: false });
  // The workflow runs anyway and deletes the branch after merging.
  assert.equal((await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) })).status, 'merged');
  // A new session (the old claim expired) must not push blindly.
  const c2 = I.claimTask(ws, W1, { task_id: id }, o(21 * 60 * 1000));
  const again = () => I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'remote_action', action: 'push_admission', phase: 'intent', ref: a.ref, sha: a.head }, o(21 * 60 * 1000));
  assert.equal((() => { try { again(); } catch (e) { return e.code; } return null; })(), 'DISPATCH_UNKNOWN');
  // Reconcile: the branch is gone; main holds the bound entry.
  const back = W.remoteSha(f.work, { ref: a.ref });
  assert.equal(back.sha, null);
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'remote_action', action: 'push_admission', phase: 'observed', ref: a.ref, observed_sha: back.sha }, o(21 * 60 * 1000));
  const st = W.admissionStatus(f.work, { task: id, entrySha256: a.entry_sha256 });
  assert.equal(st.confirmed, true);
  const done = I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'admission_confirmed', main_sha: st.main_sha, entry_sha256: st.entry_sha256 }, o(21 * 60 * 1000));
  assert.equal(done.status, 'claimed');
  assert.equal(I.getTask(ws, W1, id, o(21 * 60 * 1000)).dispatch_unknown.length, 0);
  // A push the remote did not take is said so (lease on a stale tip).
  const stale = W.push(f.work, { ref: `refs/heads/claude/candidate-eng-${a.number}`, sha: f.mainSha(), expect: 'f'.repeat(40) });
  assert.equal(stale.pushed, false);
  assert.equal(stale.landed, false);
  assert.throws(() => W.push(f.work, { ref: 'refs/heads/main', sha: f.mainSha() }), /--ref is/, 'the worker never pushes main');
});

test('promotion asks the desk about this exact head: unknown, unverified, paused, batched or misnamed is refused', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-promote'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const id = admitted(ws, 'Lane note (FICTIONAL)');
  const c = I.claimTask(ws, W1, { task_id: id }, o());
  const a = bindAndPush(f, ws, id, { token: c.claim_token });
  await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  const c2 = I.claimTask(ws, W1, { task_id: id }, o());
  const st = W.admissionStatus(f.work, { task: id, entrySha256: a.entry_sha256 });
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'admission_confirmed', main_sha: st.main_sha, entry_sha256: st.entry_sha256 }, o());
  // The worker builds on its own branch from main.
  g(f.work, 'fetch', '-q', 'origin');
  g(f.work, 'checkout', '-q', '-B', `claude/candidate-eng-${a.number}`, 'origin/main');
  put(f.work, 'docs/engineering/trial.md', '# Trial (FICTIONAL)\n\nprepared, admitted, claimed, implementing, verifying, merged\n');
  g(f.work, 'add', '-A'); g(f.work, 'commit', '-qm', `docs: lane note\n\nBacklog-Item: ${a.number}`);
  const head = g(f.work, 'rev-parse', 'HEAD');
  const base = f.mainSha();
  const ev = W.evidence(f.work, { head, base: 'origin/main' });
  assert.deepEqual(ev.files, ['docs/engineering/trial.md']);
  const scope = BP.scopeCheck(f.work, { base, head });
  assert.equal(scope.ok, true, scope.reasons.join('; '));
  const check = (over = {}) => BP.engineeringCheck(f.work, { base, head, branch: `claude/backlog-eng-${a.number}`, scope, desk: DESK_URL, fetchJson: deskOf(ws), ...over });

  // Unknown to the desk, or the desk unreadable: refused.
  assert.match((await check()).reasons.join(' '), /has no record of head/);
  assert.match((await check({ fetchJson: async () => { throw new Error('timeout'); } })).reasons.join(' '), /could not be read/);
  assert.match((await check({ fetchJson: async () => ({ status: 503, json: null }) })).reasons.join(' '), /answered 503/);
  // Recorded but not verified: refused.
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'candidate', branch: `claude/candidate-eng-${a.number}`, head_sha: head, base_sha: ev.base_sha, merge_base_sha: ev.merge_base_sha, files: ev.files, diff: ev.diff }, o());
  assert.match((await check()).reasons.join(' '), /no passing verification/);
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'verification', head_sha: head, command: 'node dashboard/cli.js test', exit_code: 0, total: 5, passed: 5, failed: 0, output_tail: 'ok', acceptance: [{ index: 0, met: true, evidence: 'file present' }] }, o());
  const ok = await check();
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.equal(ok.task_id, id);
  // Only from its own branch, alone.
  assert.match((await check({ branch: 'claude/backlog-batch-x' })).reasons.join(' '), /promoted only from claude\/backlog-eng-/);
  assert.match((await check({ scope: { ...scope, items: [1, a.number] } })).reasons.join(' '), /promoted alone/);
  // A path the desk did not approve (as if the branch carried more).
  assert.match((await check({ scope: { ...scope, changed: [...scope.changed, 'dashboard/core/lib.txt'] } })).reasons.join(' '), /dashboard\/core\/lib\.txt is outside the task's approved scope/);
  // Main moved with the head unchanged: the merge base still matches.
  const moved = f.onMain('docs/engineering/unrelated.md', 'x\n', 'unrelated');
  g(f.work, 'fetch', '-q', 'origin');
  assert.equal((await check({ base: moved })).ok, true);
  // Paused, then a newer candidate: this head is no longer promotable.
  I.setPaused(ws, OWNER, { paused: true }, o());
  assert.match((await check()).reasons.join(' '), /desk: engineering is paused/);
  I.setPaused(ws, OWNER, { paused: false }, o());
  I.requestCorrection(ws, CHAT, { task_id: id, head_sha: head, findings: ['Name the paused state too (FICTIONAL).'] }, o());
  const r = await check();
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /the task is queued/);
  // A non-engineering branch is not asked about.
  const plain = await BP.engineeringCheck(f.work, { base, head, branch: 'claude/backlog-batch-x', scope: { ...scope, items: [1] }, desk: null, fetchJson: deskOf(ws) });
  assert.equal(plain.engineering, false);
  // Review N7: an engineering branch carries exactly one engineering item; an
  // ordinary item, or none, on one is held, whatever its letter case.
  for (const [branch, items, named] of [[`claude/backlog-eng-${a.number}`, [1], 'item 1, which is not an engineering item'], ['Claude/Backlog-Eng-7', [1, 2], 'items 1, 2, which are not engineering items'], ['claude/backlog-eng-x', [], 'no item']]) {
    const wrong = await BP.engineeringCheck(f.work, { base, head, branch, scope: { ...scope, items }, desk: DESK_URL, fetchJson: deskOf(ws) });
    assert.equal(wrong.engineering, true, branch);
    assert.equal(wrong.ok, false, branch);
    assert.deepEqual(wrong.reasons, [`${branch} is an engineering branch, which carries exactly one engineering item; it names ${named}. Ordinary items go on another claude/backlog- branch`]);
    assert.match(BP.summaryOf('engineering', { ...wrong, branch }), /engineering branch/i);
  }
});

test('both delegations active: application work declared with no review is promoted only after the ChatGPT review its delegation requires', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-match'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-app@3', goal_id: 'desk-polish', goal: 'Polish the desk (FICTIONAL)' }, o());
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o(1));
  const file = 'dashboard/public/views/fictional.js';
  const p = I.prepareTask(ws, CHAT, { ...docsTask('Fictional panel (FICTIONAL)', file), goal_id: 'desk-polish', required_review: 'none' }, o());
  assert.equal(p.match.delegation.template, 'eng-app@3');
  const s = I.submitTask(ws, CHAT, { task_id: p.task_id, version: 1, content_sha256: p.content_sha256 }, o());
  assert.equal(s.status, 'admitted', s.says);
  const id = p.task_id;
  const c = I.claimTask(ws, W1, { task_id: id }, o());
  const a = bindAndPush(f, ws, id, { token: c.claim_token });
  assert.equal((await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) })).status, 'merged');
  const c2 = I.claimTask(ws, W1, { task_id: id }, o());
  const st = W.admissionStatus(f.work, { task: id, entrySha256: a.entry_sha256 });
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'admission_confirmed', main_sha: st.main_sha, entry_sha256: st.entry_sha256 }, o());
  g(f.work, 'fetch', '-q', 'origin');
  g(f.work, 'checkout', '-q', '-B', `claude/candidate-eng-${a.number}`, 'origin/main');
  put(f.work, file, 'export default function Fictional() { return null; }\n');
  g(f.work, 'add', '-A'); g(f.work, 'commit', '-qm', `web: fictional panel\n\nBacklog-Item: ${a.number}`);
  const head = g(f.work, 'rev-parse', 'HEAD');
  const base = f.mainSha();
  const ev = W.evidence(f.work, { head, base: 'origin/main' });
  const scope = BP.scopeCheck(f.work, { base, head });
  assert.equal(scope.ok, true, scope.reasons.join('; '));
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'candidate', branch: `claude/candidate-eng-${a.number}`, head_sha: head, base_sha: ev.base_sha, merge_base_sha: ev.merge_base_sha, files: ev.files, diff: ev.diff }, o());
  const v = I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'verification', head_sha: head, command: 'node dashboard/cli.js test', exit_code: 0, total: 5, passed: 5, failed: 0, output_tail: 'ok', acceptance: [{ index: 0, met: true, evidence: 'file present' }] }, o());
  assert.equal(v.status, 'review_pending');
  const check = () => BP.engineeringCheck(f.work, { base, head, branch: `claude/backlog-eng-${a.number}`, scope, desk: DESK_URL, fetchJson: deskOf(ws) });
  // Verified and inside scope, but its delegation's ChatGPT review has not passed: refused.
  const held = await check();
  assert.equal(held.ok, false);
  assert.equal(held.attestation.required_review, 'chatgpt');
  assert.match(held.reasons.join(' '), /desk: the required chatgpt review has not passed on this head/);
  // The submitting connection's own pass does not decide application work.
  const own = I.saveReview(ws, CHAT, { task_id: id, head_sha: head, merge_base_sha: ev.merge_base_sha, result: 'pass', read: { diff: true, tests: true, acceptance: true } }, o());
  assert.equal(own.counts_for_requirement, false);
  assert.equal(own.same_author, true);
  assert.equal((await check()).ok, false);
  I.saveReview(ws, CHAT_REV, { task_id: id, head_sha: head, merge_base_sha: ev.merge_base_sha, result: 'pass', read: { diff: true, tests: true, acceptance: true } }, o());
  const ok = await check();
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.equal(ok.attestation.review_state, 'pass');
});

test('GitHub readback that cannot be read says unknown, never a pass; a token is never in the answer', async () => {
  const fail = makeGithub({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, revision: () => ({ commit: 'c'.repeat(40) }), env: { CR_GITHUB_TOKEN: 'fictional-github-token' }, sleep: async () => {} });
  const r = await fail.readback({ number: 5, head_sha: 'a'.repeat(40), merge_sha: 'b'.repeat(40) });
  assert.equal(r.pull_request.state, 'unknown');
  assert.equal(r.checks_on_head.state, 'unknown');
  assert.equal(r.main_contains_merge.state, 'unknown');
  assert.equal(r.deployed.contains_merge.state, 'unknown');
  assert.ok(!JSON.stringify(r).includes('fictional-github-token'));
  const limited = makeGithub({ fetchImpl: async () => new Response('{"message":"rate limited"}', { status: 403 }), revision: () => ({}) });
  const l = await limited.readback({ number: 5, head_sha: 'a'.repeat(40) });
  assert.equal(l.checks_on_head.state, 'unknown');
  assert.match(l.checks_on_head.why, /rate limit/);
  // Pending checks are pending, failures are failures; nothing is cached but a 200.
  let calls = 0;
  const ok = makeGithub({ fetchImpl: async (url) => { calls += 1; return new Response(JSON.stringify(/check-runs/.test(url) ? { total_count: 2, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'backlog-pr', status: 'in_progress', conclusion: null }] } : []), { status: 200 }); }, revision: () => ({}) });
  assert.equal((await ok.checks('a'.repeat(40))).state, 'pending');
  await ok.checks('a'.repeat(40));
  assert.equal(calls, 1, 'a 200 answer is reused for a minute');
});

// --- the independent review of PR #16 (2026-10-25): findings 1, 3, 4, 8 -------------

const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

// Prepared, admitted, on main and confirmed: ready for the worker to build.
async function confirmed(f, ws, args) {
  const p = I.prepareTask(ws, CHAT, args, o());
  assert.equal(I.submitTask(ws, CHAT, { task_id: p.task_id, version: 1, content_sha256: p.content_sha256 }, o()).status, 'admitted');
  const c = I.claimTask(ws, W1, { task_id: p.task_id }, o());
  const a = bindAndPush(f, ws, p.task_id, { token: c.claim_token });
  assert.equal((await BP.admit(f.runner(), { branch: `claude/admission-${p.task_id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) })).status, 'merged');
  const c2 = I.claimTask(ws, W1, { task_id: p.task_id }, o());
  const st = W.admissionStatus(f.work, { task: p.task_id, entrySha256: a.entry_sha256 });
  I.recordEvent(ws, W1, { task_id: p.task_id, claim_token: c2.claim_token, type: 'admission_confirmed', main_sha: st.main_sha, entry_sha256: st.entry_sha256 }, o());
  return { id: p.task_id, number: a.number, token: c2.claim_token };
}
// One commit on claude/candidate-eng-<n> from main as it is now.
function build(f, number, files) {
  g(f.work, 'fetch', '-q', 'origin');
  g(f.work, 'checkout', '-q', '-B', `claude/candidate-eng-${number}`, 'origin/main');
  for (const [file, text] of Object.entries(files)) put(f.work, file, text);
  g(f.work, 'add', '-A'); g(f.work, 'commit', '-qm', `docs: note\n\nBacklog-Item: ${number}`);
  const head = g(f.work, 'rev-parse', 'HEAD');
  return { head, ev: W.evidence(f.work, { head, base: 'origin/main' }) };
}
function recordBuilt(ws, id, number, token, { head, ev }, { files = ev.files, diff = ev.diff } = {}) {
  I.recordEvent(ws, W1, { task_id: id, claim_token: token, type: 'candidate', branch: `claude/candidate-eng-${number}`, head_sha: head, base_sha: ev.base_sha, merge_base_sha: ev.merge_base_sha, files, diff }, o());
  return I.recordEvent(ws, W1, { task_id: id, claim_token: token, type: 'verification', head_sha: head, command: 'node dashboard/cli.js test', exit_code: 0, total: 5, passed: 5, failed: 0, output_tail: 'ok', acceptance: [{ index: 0, met: true, evidence: 'file present' }] }, o());
}
const promoteCheck = (f, ws, number, head, base) => BP.engineeringCheck(f.work, { base, head, branch: `claude/backlog-eng-${number}`, scope: BP.scopeCheck(f.work, { base, head }), desk: DESK_URL, fetchJson: deskOf(ws) });

test('admission adds exactly one engineering item: an entry carrying any other line is refused even when its hash is bound', async (t) => {
  const f = fixture(t);
  const id = 'eng-20261025-abcdef';
  const branch = `claude/admission-${id}`;
  const pushEntry = (entry) => {
    const text = f.show(f.mainSha(), 'DESK_STATE.md');
    g(f.work, 'checkout', '-q', '-B', branch, 'origin/main');
    put(f.work, 'DESK_STATE.md', BP.insertEntry(text, entry));
    g(f.work, 'commit', '-qam', 'admission'); g(f.work, 'push', '-q', '-f', 'origin', branch);
    return g(f.work, 'rev-parse', 'HEAD');
  };
  // A desk that answers for exactly this entry, as a desk that bound it would.
  const deskFor = (entry) => async () => ({ status: 200, json: { task_id: id, admissible: true, reasons: [], number: 4, version: 1, entry_sha256: sha256(entry), content_sha256: `0123456789abcdef${'f'.repeat(48)}` } });
  const item = `- [ ] **4. Lane note (FICTIONAL)** *(engineering task ${id} v1, sha256 0123456789abcdef, delegation pol-20261025-000000; built only through the engineering lane)*`;
  const bad = [
    `${item}\n  - Outcome: x\n- [ ] **9. Injected ordinary item.** change the sizing gate\n  - Scope: \`docs/engineering/a.md\`\n`,
    `${item}\n  - Outcome: x\n- [ ] **2. Two again.**\n`,
    `${item}\n  - Outcome: x\n  - Scope: \`docs/engineering/a.md\`\n## A new section\n`,
    `${item}\n  - Outcome: x\n  - Scope: \`docs/engineering/a.md\`\n  - [x] **3. Three, ticked.**\n`,
  ];
  const m0 = f.mainSha();
  for (const entry of bad) {
    const r = await BP.admit(f.runner(), { branch, head: pushEntry(entry), desk: DESK_URL, fetchJson: deskFor(entry) });
    assert.equal(r.status, 'refused', entry);
    assert.match(r.reasons.join(' '), /one engineering item/);
    assert.equal(f.mainSha(), m0, 'main unchanged');
  }
  // The same item with only its own lines lands.
  const good = `${item}\n  - Outcome: x\n  - Acceptance: ok\n  - Scope: \`docs/engineering/a.md\`\n`;
  const r = await BP.admit(f.runner(), { branch, head: pushEntry(good), desk: DESK_URL, fetchJson: deskFor(good) });
  assert.equal(r.status, 'merged', JSON.stringify(r));
  assert.deepEqual([...BP.backlogItems(f.show(f.mainSha(), 'DESK_STATE.md')).entries()].map(([n, x]) => [n, x.ticked]), [[1, false], [2, true], [3, false], [4, false]]);
});

test('one task lands under one number: a second admission for a task already on main is refused, and the desk keeps the first', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-once'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const id = admitted(ws, 'Lane note (FICTIONAL)');
  const c = I.claimTask(ws, W1, { task_id: id }, o());
  const a = bindAndPush(f, ws, id, { token: c.claim_token });
  assert.equal((await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: a.head, desk: DESK_URL, fetchJson: deskOf(ws) })).status, 'merged');
  // The worker misreads the run as a refusal, releases the number and binds the next.
  const c2 = I.claimTask(ws, W1, { task_id: id }, o());
  I.recordEvent(ws, W1, { task_id: id, claim_token: c2.claim_token, type: 'admission_refused', number: a.number, reason: 'misread' }, o());
  const c3 = I.claimTask(ws, W1, { task_id: id }, o());
  const b = bindAndPush(f, ws, id, { token: c3.claim_token });
  assert.equal(b.number, a.number + 1);
  const m1 = f.mainSha();
  const r = await BP.admit(f.runner(), { branch: `claude/admission-${id}`, head: b.head, desk: DESK_URL, fetchJson: deskOf(ws) });
  assert.equal(r.status, 'refused', JSON.stringify(r));
  assert.equal(r.task_on_main, a.number);
  assert.match(r.reasons.join(' '), new RegExp(`${id} is already on main as item ${a.number}`));
  assert.equal(f.mainSha(), m1);
  assert.equal([...f.show(m1, 'DESK_STATE.md').matchAll(new RegExp(`engineering task ${id}`, 'g'))].length, 1);
  // The worker reads main and confirms what is there: the desk takes back the first number.
  const st = W.admissionStatus(f.work, { task: id, entrySha256: b.entry_sha256 });
  assert.equal(st.on_main, true);
  assert.equal(st.number, a.number);
  assert.equal(st.matches_bound, false);
  const c4 = I.claimTask(ws, W1, { task_id: id }, o());
  assert.equal(I.recordEvent(ws, W1, { task_id: id, claim_token: c4.claim_token, type: 'admission_confirmed', main_sha: st.main_sha, entry_sha256: st.entry_sha256 }, o()).status, 'claimed');
  const v = I.getTask(ws, W1, id, o());
  assert.equal(v.admission.number, a.number);
  assert.equal(v.admission.state, 'confirmed');
  // The later number is free again.
  const other = admitted(ws, 'Second note (FICTIONAL)', 'docs/engineering/b.md');
  const co = I.claimTask(ws, W1, { task_id: other }, o());
  assert.equal(I.recordEvent(ws, W1, { task_id: other, claim_token: co.claim_token, type: 'admission_number', number: b.number, observed_max: b.number - 1, observed_main_sha: m1 }, o()).number, b.number);
});

test('promotion recomputes the reviewed diff from Git: a decoy the worker sent never promotes the real head', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-decoy'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const { id, number, token } = await confirmed(f, ws, { ...docsTask('Docs (FICTIONAL)', 'docs/engineering/**'), required_review: 'owner' });
  const real = build(f, number, { 'docs/engineering/a.md': 'real content A\n', 'docs/engineering/b.md': 'real content B the reviewer never saw\n' });
  assert.deepEqual(real.ev.files, ['docs/engineering/a.md', 'docs/engineering/b.md']);
  const decoy = 'diff --git a/docs/engineering/a.md b/docs/engineering/a.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/engineering/a.md\n@@ -0,0 +1 @@\n+harmless decoy\n';
  assert.equal(recordBuilt(ws, id, number, token, real, { files: ['docs/engineering/a.md'], diff: decoy }).status, 'review_pending');
  // What the reviewer is shown says where it came from and how it is held.
  const ev = I.getEvidence(ws, OWNER, { task_id: id }, o());
  assert.equal(ev.diff.matches_record, undefined, 'no "matches" that only compares the upload with itself');
  assert.equal(ev.diff.from, 'worker');
  assert.match(ev.diff.checked_at_promotion, /recomputes/);
  I.saveReview(ws, OWNER, { task_id: id, head_sha: real.head, merge_base_sha: real.ev.merge_base_sha, result: 'pass', read: { diff: true, tests: true } }, o());
  // The desk cannot see Git: it attests the hash and files the review read.
  const att = I.attestationView(ws, real.head, o());
  assert.equal(att.promotable, true, att.reasons.join(' '));
  assert.equal(att.diff_sha256, sha256(decoy));
  assert.deepEqual(att.files, ['docs/engineering/a.md']);
  // The workflow recomputes them from Git and refuses.
  const e = await promoteCheck(f, ws, number, real.head, f.mainSha());
  assert.equal(e.ok, false);
  assert.match(e.reasons.join(' '), /the diff the review read is not the Git diff of this head/);
  assert.match(e.reasons.join(' '), /docs\/engineering\/b\.md is changed but was not in the reviewed diff/);
});

test('a review covers one head on one base: when main moves the candidate is rebuilt, verified and reviewed again', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-stale'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o());
  const { id, number, token } = await confirmed(f, ws, { ...docsTask('Reviewed note (FICTIONAL)'), required_review: 'owner' });
  const note = { 'docs/engineering/trial.md': '# Note (FICTIONAL)\n\nprepared, admitted, merged\n' };
  const first = build(f, number, note);
  assert.equal(recordBuilt(ws, id, number, token, first).status, 'review_pending');
  I.saveReview(ws, OWNER, { task_id: id, head_sha: first.head, merge_base_sha: first.ev.merge_base_sha, result: 'pass', read: { diff: true, tests: true } }, o());
  const m1 = f.mainSha();
  const ok1 = await promoteCheck(f, ws, number, first.head, m1);
  assert.equal(ok1.ok, true, ok1.reasons.join('; '));
  // Another merge lands: the reviewed base is no longer main.
  const m2 = f.onMain('docs/engineering/other.md', 'someone else (FICTIONAL)\n', 'other merge');
  const stale = await promoteCheck(f, ws, number, first.head, m2);
  assert.equal(stale.ok, false);
  assert.match(stale.reasons.join(' '), /main has moved since the review/);
  // The worker rebuilds on the new main (no correction attempt used); it is verified and reviewed again.
  const c2 = I.claimTask(ws, W1, { task_id: id }, o());
  const again = build(f, number, note);
  assert.notEqual(again.head, first.head);
  assert.equal(again.ev.merge_base_sha, m2);
  assert.equal(recordBuilt(ws, id, number, c2.claim_token, again).status, 'review_pending');
  assert.equal(I.getTask(ws, W1, id, o()).attempts.count, 1, 'a rebuild on a new main is not a correction attempt');
  assert.match((await promoteCheck(f, ws, number, again.head, m2)).reasons.join(' '), /desk: the required owner review has not passed on this head/);
  I.saveReview(ws, OWNER, { task_id: id, head_sha: again.head, merge_base_sha: again.ev.merge_base_sha, result: 'pass', read: { diff: true, tests: true } }, o());
  const ok2 = await promoteCheck(f, ws, number, again.head, m2);
  assert.equal(ok2.ok, true, ok2.reasons.join('; '));
});

// --- Eric's decisions on findings 2 and 6 (2026-10-25) ------------------------------

// Finding 6: whatever the task record or the desk's answer says, a branch a
// delegation admitted is held when its actual diff touches dashboard/core/.
test('a delegated branch whose diff touches dashboard/core/ is held at promotion, even when its declared paths did not name it', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-core'); t.after(cleanup);
  const pol = I.activatePolicy(ws, OWNER, { template: 'eng-app@3', goal_id: 'desk-polish', goal: 'Polish the desk (FICTIONAL)' }, o()).policy;
  const task = { title: 'Panel polish (FICTIONAL)', intent: 'implement', goal_id: 'desk-polish', outcome: 'The panel reads more clearly (FICTIONAL).', scope: { paths: ['dashboard/public/views/**'] }, acceptance: ['the panel names each state'] };
  const { id, number, token } = await confirmed(f, ws, task);
  const built = build(f, number, { 'dashboard/public/views/panel.js': 'export default 1;\n', 'dashboard/core/lib.txt': 'changed by the panel task\n' });
  assert.deepEqual(built.ev.files, ['dashboard/core/lib.txt', 'dashboard/public/views/panel.js']);
  // The desk refuses the candidate outright.
  let refused = null;
  try { recordBuilt(ws, id, number, token, built); } catch (e) { refused = e; }
  assert.equal(refused && refused.code, 'SCOPE');
  assert.match(refused.message, /dashboard\/core\/lib\.txt is in dashboard\/core\/ \(core financial and investment logic/);
  // And were a desk to answer "promotable" with a wide scope, promotion holds it.
  const base = f.mainSha();
  const real = BP.candidateDiff(f.work, base, built.head);
  const forged = { task_id: id, number, version: 1, promotable: true, reasons: [], merge_base_sha: base, required_review: 'none', review_state: 'not_required', diff_sha256: real.diff_sha256, files: real.files, allowed_paths: ['dashboard/**'], delegation: { policy_id: pol.policy_id, template: 'eng-app@3' } };
  const answer = (att) => async () => ({ status: 200, json: att });
  const scope = BP.scopeCheck(f.work, { base, head: built.head });
  assert.deepEqual(scope.reasons, [], 'dashboard/core/lib.txt is not itself a protected path');
  const held = await BP.engineeringCheck(f.work, { base, head: built.head, branch: `claude/backlog-eng-${number}`, scope, desk: DESK_URL, fetchJson: answer(forged) });
  assert.equal(held.ok, false);
  assert.deepEqual(held.reasons, [`dashboard/core/lib.txt: core financial and investment logic, which no delegation changes; this item was admitted by delegation ${pol.policy_id} (eng-app@3), so it waits for Eric`]);
  // The same diff under Eric's own authorization of that version passes.
  const owner = await BP.engineeringCheck(f.work, { base, head: built.head, branch: `claude/backlog-eng-${number}`, scope, desk: DESK_URL, fetchJson: answer({ ...forged, delegation: null }) });
  assert.equal(owner.ok, true, owner.reasons.join(' '));
});

// Finding 2: the engineering routes live in the protected
// dashboard/engineering/routes.js; dashboard/server.js keeps ordinary changes
// auto-merging, and only a change to a line naming engineering waits for Eric.
test('promotion holds a branch that changes the engineering routes or their mount; other server changes still merge', (t) => {
  const f = fixture(t);
  const SERVER = "const a = 1;\nconst { openFrontDoor } = require('./frontdoor');\n// The engineering routes (dashboard/engineering/routes.js); this file only mounts them.\nconst engineering = require('./engineering/routes').makeEngineeringRoutes(ws, {});\nconst b = 2;\nengineering.mount(route);\n";
  f.onMain('dashboard/server.js', SERVER, 'server (FICTIONAL)');
  f.onMain('dashboard/engineering/routes.js', 'module.exports = {};\n', 'routes (FICTIONAL)');
  const branch = (name, files) => {
    g(f.work, 'fetch', '-q', 'origin');
    g(f.work, 'checkout', '-q', '-B', name, 'origin/main');
    for (const [file, text] of Object.entries(files)) { if (text === null) g(f.work, 'rm', '-q', file); else put(f.work, file, text); }
    g(f.work, 'add', '-A'); g(f.work, 'commit', '-qm', `change (FICTIONAL)\n\nBacklog-Item: 1`);
    return BP.scopeCheck(f.work, { base: f.mainSha(), head: g(f.work, 'rev-parse', 'HEAD') });
  };
  const MOUNT = 'dashboard/server.js: the mount of the engineering routes or the front door (dashboard/engineering/routes.js, dashboard/frontdoor.js)';
  assert.deepEqual(branch('claude/backlog-batch-plain', { 'dashboard/server.js': SERVER.replace('const a = 1;', 'const a = 3;').replace('const b = 2;', 'const b = 4;') }).reasons, [], 'an ordinary server change');
  assert.deepEqual(branch('claude/backlog-batch-mount', { 'dashboard/server.js': SERVER.replace("'./engineering/routes'", "'./engineering/routes-other'") }).reasons, [MOUNT]);
  assert.deepEqual(branch('claude/backlog-batch-unmount', { 'dashboard/server.js': SERVER.replace('engineering.mount(route);\n', '') }).reasons, [MOUNT]);
  assert.deepEqual(branch('claude/backlog-batch-shadow', { 'dashboard/server.js': SERVER.replace('const b = 2;', "const b = 2;\nroute('POST', '/api/engineering/tasks/x/authorize', () => ({}));") }).reasons, [MOUNT], 'a new route under /api/engineering');
  assert.deepEqual(branch('claude/backlog-batch-rm', { 'dashboard/server.js': null }).reasons, [MOUNT]);
  assert.deepEqual(branch('claude/backlog-batch-door', { 'dashboard/server.js': SERVER.replace("const { openFrontDoor } = require('./frontdoor');\n", '') }).reasons, [MOUNT], 'the front door no longer opened');
  assert.deepEqual(branch('claude/backlog-batch-frontdoor', { 'dashboard/frontdoor.js': 'module.exports = {};\n' }).reasons, ['dashboard/frontdoor.js: the front door (everything a request meets before sign-in)']);
  assert.deepEqual(branch('claude/backlog-batch-routes', { 'dashboard/engineering/routes.js': 'module.exports = { open: true };\n' }).reasons, ['dashboard/engineering/routes.js: engineering authorization (the inbox, delegations and their connector)']);
});

// --- lane resilience (2026-10-26): commits proven on GitHub, retries, the bundle step ---

const reply = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status });
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('GitHub reads are asked again after a passing failure only, and an answer is never invented', async () => {
  const waits = [];
  let n = 0;
  const flaky = makeGithub({ fetchImpl: async () => { n += 1; return n < 3 ? reply(n === 1 ? 502 : 503, { message: 'busy' }) : reply(200, { sha: 'a'.repeat(40) }); }, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(await flaky.commit('aaaaaaa'), { state: 'found', sha: 'a'.repeat(40) });
  assert.equal(n, 3);
  assert.deepEqual(waits, [1000, 2000]);
  // Down throughout: four tries, 1 s, 2 s and 4 s apart, then unknown.
  waits.length = 0; n = 0;
  const down = makeGithub({ fetchImpl: async () => { n += 1; const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }, sleep: async (ms) => { waits.push(ms); } });
  const d = await down.commit('bbbbbbb');
  assert.deepEqual([d.state, d.why, n, waits], ['unknown', 'GitHub not reachable', 4, [1000, 2000, 4000]]);
  // A rate limit, a 404 and a timeout are not asked again.
  const hang = async (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }));
  for (const [impl, state] of [[async () => reply(403, { message: 'rate limited' }), 'unknown'], [async () => reply(404, { message: 'Not Found' }), 'none'], [hang, 'unknown']]) {
    n = 0;
    const once = makeGithub({ fetchImpl: async (...a) => { n += 1; return impl(...a); }, timeoutMs: 20, sleep: async () => { throw new Error('no wait expected'); } });
    assert.equal((await once.commit('ccccccc')).state, state);
    assert.equal(n, 1);
  }
  // Only a SHA or a prefix of one is asked about; a branch name moves.
  const none = makeGithub({ fetchImpl: async () => { throw new Error('not asked'); } });
  assert.equal((await none.commit('main')).state, 'none');
  assert.equal((await none.admissionAt('claude/admission-x', 'eng-20261026-9c21de')).state, 'no');
});

test('admissionAt proves a commit on main holds the entry; findAdmissionCommit finds it by the workflow title', async () => {
  const TASK = 'eng-20261026-9c21de';
  const FULL = '72094714f88c35fb3906dd3fbfc5fdc9d2290936';
  const OTHER = 'd'.repeat(40);
  const entry = `- [ ] **65. Lane item (FICTIONAL).** text *(engineering task ${TASK} v1, sha256 0123456789abcdef)*\n  - detail\n`;
  const desk = `# Desk state (FICTIONAL)\n\n## Autonomous Build Backlog\n- [ ] **1. One.** a\n${entry}\n## After the backlog\nkept\n`;
  const asked = [];
  const routes = (url) => {
    const u = new URL(url);
    asked.push(`${u.pathname}${u.search}`);
    if (u.pathname.endsWith('/commits/7209471') || u.pathname.endsWith(`/commits/${FULL}`)) return reply(200, { sha: FULL });
    if (/\/commits\/7209471a/.test(u.pathname)) return reply(422, { message: 'No commit found for SHA' });
    if (u.pathname.endsWith(`/commits/${OTHER}`)) return reply(200, { sha: OTHER });
    if (u.pathname.endsWith(`/compare/${FULL}...main`)) return reply(200, { status: 'ahead' });
    if (u.pathname.endsWith(`/compare/${OTHER}...main`)) return reply(200, { status: 'diverged' });
    if (u.pathname.endsWith('/contents/DESK_STATE.md') && u.searchParams.get('ref') === FULL) return reply(200, { encoding: 'base64', content: b64(desk) });
    if (u.pathname.endsWith('/commits') && u.searchParams.get('path') === 'DESK_STATE.md') return reply(200, [
      { sha: 'e'.repeat(40), commit: { message: 'admission: backlog item 66 for eng-20261026-aaaaaa v1' } },
      { sha: FULL, commit: { message: `admission: backlog item 65 for ${TASK} v1\n\nAdmission-Task: ${TASK}` } },
    ]);
    return reply(404, { message: 'Not Found' });
  };
  const gh = makeGithub({ fetchImpl: async (url) => routes(url), sleep: async () => {} });
  const yes = await gh.admissionAt('7209471', TASK);
  assert.deepEqual([yes.state, yes.main_sha, yes.entry, yes.entry_sha256, yes.number], ['yes', FULL, entry, sha256(entry), 65]);
  // The padded SHA item 65 was confirmed with names no commit.
  const padded = await gh.admissionAt('7209471a1b2c3d4e5f60718293a4b5c6d7e8f901', TASK);
  assert.equal(padded.state, 'no');
  assert.match(padded.why, /knows no commit 7209471a1b2c/);
  // A commit that is not on main, and one whose DESK_STATE.md lacks the task.
  assert.match((await gh.admissionAt(OTHER, TASK)).why, /is not on main/);
  const lacks = await gh.admissionAt('7209471', 'eng-20261026-bbbbbb');
  assert.deepEqual([lacks.state, lacks.main_sha], ['no', FULL]);
  const found = await gh.findAdmissionCommit({ number: 65, task: TASK, version: 1, since: '2026-10-26T15:47:00.000Z' });
  assert.deepEqual(found, { state: 'found', sha: FULL });
  assert.ok(asked.some((p) => p.includes('since=2026-10-26T14%3A47%3A00.000Z')), 'an hour before the binding, for clock skew');
  assert.equal((await gh.findAdmissionCommit({ number: 65, task: TASK, version: 2 })).state, 'none');
  const blind = makeGithub({ fetchImpl: async () => reply(503, { message: 'busy' }), sleep: async () => {} });
  assert.equal((await blind.findAdmissionCommit({ number: 65, task: TASK, version: 1 })).state, 'unknown');
  assert.equal((await blind.admissionAt('7209471', TASK)).state, 'unknown');
});

test('the worker resolves any revision to the commit it names, and pushes and reads evidence by it', (t) => {
  const f = fixture(t);
  const main = f.mainSha();
  g(f.work, 'checkout', '-q', '-B', 'claude/candidate-eng-7', 'origin/main');
  put(f.work, 'docs/engineering/trial.md', 'note\n');
  g(f.work, 'add', '-A'); g(f.work, 'commit', '-qm', 'docs: note');
  const head = g(f.work, 'rev-parse', 'HEAD');
  g(f.work, 'tag', 'fictional-tag');
  for (const rev of [head, head.slice(0, 7), 'HEAD', 'claude/candidate-eng-7', 'fictional-tag']) assert.equal(W.resolveRev(f.work, rev), head, rev);
  assert.equal(W.main(['resolve', '--rev', 'origin/main'], f.work).sha, main);
  assert.throws(() => W.resolveRev(f.work, '7209471a1b2c3d4e5f60718293a4b5c6d7e8f901'), /names no commit here/);
  assert.throws(() => W.resolveRev(f.work, '--all'), /is a revision/);
  assert.throws(() => W.resolveRev(f.work, 'a b'), /is a revision/);
  const ev = W.evidence(f.work, { head: head.slice(0, 8) });
  assert.deepEqual([ev.head_sha, ev.base_sha, ev.files], [head, main, ['docs/engineering/trial.md']]);
  const p = W.push(f.work, { ref: 'refs/heads/claude/candidate-eng-7', sha: head.slice(0, 7), expect: null });
  assert.deepEqual([p.sha, p.landed, p.attempts], [head, true, 1]);
  assert.throws(() => W.push(f.work, { ref: 'refs/heads/claude/candidate-eng-7', sha: 'f'.repeat(40) }), /names no commit here/);
});

// A git remote over HTTP that answers every request with one status, in its
// own process (git runs synchronously here), counting what it was asked.
async function statusRemote(t, status) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-engremote-'));
  const count = path.join(root, 'count');
  const code = `const fs=require('fs');let n=0;require('http').createServer((q,s)=>{n+=1;fs.writeFileSync(${JSON.stringify(count)},String(n));s.writeHead(${status});s.end('busy');}).listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port)+'\\n');});`;
  const child = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  return { url: `http://127.0.0.1:${port}/fictional.git`, asked: () => (fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0) };
}

test('the worker asks the remote again after a passing failure only', async (t) => {
  const f = fixture(t);
  const saved = { delays: process.env.CR_ENG_RETRY_DELAYS_MS, prompt: process.env.GIT_TERMINAL_PROMPT };
  process.env.CR_ENG_RETRY_DELAYS_MS = '0,0,0';
  process.env.GIT_TERMINAL_PROMPT = '0';
  t.after(() => { for (const [k, v] of [['CR_ENG_RETRY_DELAYS_MS', saved.delays], ['GIT_TERMINAL_PROMPT', saved.prompt]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const passing = [
    "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 503",
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502',
    'fatal: early EOF',
    'ssh: connect to host github.com port 22: Connection refused',
    "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443",
  ];
  for (const s of passing) assert.ok(W.TRANSIENT_RE.test(s), s);
  const lasting = ["fatal: repository 'https://github.com/x/y.git/' not found", 'remote: Permission to x/y.git denied', 'error: failed to push some refs (stale info)', 'fatal: Authentication failed'];
  for (const s of lasting) assert.ok(!W.TRANSIENT_RE.test(s), s);
  const busy = await statusRemote(t, 503);
  assert.throws(() => W.remoteSha(f.work, { ref: 'refs/heads/claude/candidate-eng-7', remote: busy.url }), /returned error: 503/);
  const first = busy.asked();
  assert.ok(first >= 4 && first % 4 === 0, `asked ${first} times: four tries, each as git makes it`);
  const gone = await statusRemote(t, 404);
  assert.throws(() => W.remoteSha(f.work, { ref: 'refs/heads/claude/candidate-eng-7', remote: gone.url }));
  assert.equal(gone.asked(), first / 4, 'a 404 is not asked again');
  process.env.CR_ENG_RETRY_DELAYS_MS = '';
  const once = await statusRemote(t, 503);
  assert.throws(() => W.remoteSha(f.work, { ref: 'refs/heads/claude/candidate-eng-7', remote: once.url }));
  assert.equal(once.asked(), first / 4, 'no delays, no retries');
});

// A fictional app: its source hash is the hash of src/a.txt, and its build
// stamps that hash and writes one bundle file (or fails, when asked to).
function bundleFixture(t, { stale = false, failing = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-engbundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'core.autocrlf', 'false');
  put(root, 'dashboard/web/src/a.txt', 'one\n');
  put(root, 'dashboard/web/scripts/source-hash.mjs', [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import crypto from 'node:crypto';",
    "export function sourceHash(web) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(web, 'src', 'a.txt'))).digest('hex'); }",
    '',
  ].join('\n'));
  put(root, 'dashboard/web/build.js', failing ? "process.stderr.write('fictional build error\\n'); process.exit(1);\n" : [
    "const fs = require('fs');",
    "const path = require('path');",
    "const crypto = require('crypto');",
    "const app = path.join(__dirname, '..', 'public', 'app');",
    "const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'src', 'a.txt'))).digest('hex');",
    "fs.writeFileSync(path.join(app, 'index.js'), '// built from ' + h + '\\n');",
    "fs.writeFileSync(path.join(app, 'build.json'), JSON.stringify({ source_sha256: h }, null, 2) + '\\n');",
    '',
  ].join('\n'));
  put(root, 'dashboard/web/package.json', JSON.stringify({ name: 'fictional-web', private: true, scripts: { build: 'node build.js' } }, null, 2));
  fs.mkdirSync(path.join(root, 'dashboard/web/node_modules'), { recursive: true });
  put(root, 'dashboard/public/app/index.js', `// built from ${sha256('one\n')}\n`);
  put(root, 'dashboard/public/app/build.json', `${JSON.stringify({ source_sha256: sha256('one\n') }, null, 2)}\n`);
  put(root, 'dashboard/cli.js', "console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0');\n");
  put(root, '.gitignore', 'node_modules/\n');
  g(root, 'add', '-A'); g(root, 'commit', '-qm', 'base');
  if (stale) { put(root, 'dashboard/web/src/a.txt', 'two\n'); g(root, 'commit', '-qam', 'change the app'); }
  return root;
}

test('verify rebuilds a stale bundle first and stops until the rebuild is committed', (t) => {
  const current = bundleFixture(t);
  assert.equal(W.bundle(current).status, 'current');
  const v0 = W.verify(current);
  assert.deepEqual([v0.bundle, v0.ok, v0.total, v0.passed], ['current', true, 1, 1]);
  const stale = bundleFixture(t, { stale: true });
  const v1 = W.verify(stale);
  assert.deepEqual([v1.status, v1.ok, v1.exit_code, v1.total], ['commit_bundle_first', false, null, null]);
  assert.deepEqual(v1.bundle.files.sort(), ['dashboard/public/app/build.json', 'dashboard/public/app/index.js']);
  assert.match(v1.says, /commit these files/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stale, 'dashboard/public/app/build.json'), 'utf8')).source_sha256, sha256('two\n'));
  g(stale, 'commit', '-qam', 'rebuild the bundle');
  const v2 = W.verify(stale);
  assert.deepEqual([v2.bundle, v2.ok], ['current', true]);
  const broken = bundleFixture(t, { stale: true, failing: true });
  const v3 = W.verify(broken);
  assert.deepEqual([v3.status, v3.ok, v3.bundle.step], ['bundle_build_failed', false, 'npm run build']);
  assert.match(v3.bundle.output_tail, /fictional build error/);
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-engnobundle-'));
  t.after(() => fs.rmSync(none, { recursive: true, force: true }));
  assert.equal(W.bundle(none).status, 'no_bundle');
});

// --- convergence with GitHub (2026-10-26, the Cortex audit) ------------------------

test('a merged pull request from either branch proves an item merged only when its head is the recorded one and main holds it', async () => {
  const HEAD = 'a'.repeat(40);
  const MERGE = 'b'.repeat(40);
  const OTHER = 'c'.repeat(40);
  const PR24 = { number: 24, html_url: 'https://github.com/kuaya1/CryptoResearch/pull/24', state: 'closed', merged_at: '2026-10-26T16:00:00Z', merge_commit_sha: MERGE, head: { sha: HEAD } };
  const PR30 = { number: 30, html_url: 'https://github.com/kuaya1/CryptoResearch/pull/30', state: 'open', merged_at: null, merge_commit_sha: null, head: { sha: HEAD } };
  // Each answer is made fresh per request; a branch maps to a function.
  const fake = ({ backlog = () => reply(200, []), candidate = () => reply(200, []), head = 'ahead', merge = 'identical' } = {}) => {
    const asked = [];
    const gh = makeGithub({ sleep: async () => {}, fetchImpl: async (url) => {
      const u = new URL(url);
      asked.push(`${u.pathname}${u.search}`);
      if (u.pathname.endsWith('/pulls')) {
        const h = u.searchParams.get('head');
        if (h === 'kuaya1:claude/backlog-eng-63') return backlog();
        if (h === 'kuaya1:claude/candidate-eng-63') return candidate();
        return reply(200, []);
      }
      if (u.pathname.endsWith(`/compare/${HEAD}...main`)) return reply(200, { status: head });
      if (u.pathname.endsWith(`/compare/${MERGE}...main`)) return reply(200, { status: merge });
      return reply(404, { message: 'Not Found' });
    } });
    return { gh, asked };
  };
  // Merged from claude/candidate-eng-63, as items 63 and 64 were; an open
  // pull request on the backlog branch does not hide it.
  const { gh, asked } = fake({ backlog: () => reply(200, [PR30]), candidate: () => reply(200, [PR24]) });
  const yes = await gh.mergeProof({ number: 63, heads: [HEAD] });
  assert.deepEqual(yes, { state: 'yes', number: 63, pr_number: 24, pr_url: PR24.html_url, branch: 'claude/candidate-eng-63', head_sha: HEAD, main_sha: MERGE, merged_at: PR24.merged_at });
  assert.ok(asked.some((p) => p.includes(encodeURIComponent('kuaya1:claude/backlog-eng-63'))) && asked.some((p) => p.includes(encodeURIComponent('kuaya1:claude/candidate-eng-63'))), 'both branches are asked about');
  const pr = await gh.pullRequest(63);
  assert.deepEqual([pr.state, pr.number, pr.branch, pr.others], ['merged', 24, 'claude/candidate-eng-63', [{ number: 30, state: 'open', branch: 'claude/backlog-eng-63' }]]);
  // The readback names it too.
  assert.equal((await gh.readback({ number: 63, head_sha: HEAD })).pull_request.number, 24);
  // A merged head that is not the one recorded proves nothing.
  const other = await gh.mergeProof({ number: 63, heads: [OTHER] });
  assert.equal(other.state, 'no');
  assert.match(other.why, /PR #24 merged aaaaaaaaaaaa, not the recorded head/);
  // A squash merge leaves main without the head: not proof.
  const squash = await fake({ candidate: () => reply(200, [PR24]), head: 'diverged' }).gh.mergeProof({ number: 63, heads: [HEAD] });
  assert.equal(squash.state, 'no');
  assert.match(squash.why, /main does not hold aaaaaaaaaaaa \(PR #24\)/);
  // The merge commit is kept only when main holds it.
  assert.equal((await fake({ candidate: () => reply(200, [PR24]), merge: 'diverged' }).gh.mergeProof({ number: 63, heads: [HEAD] })).main_sha, null);
  // One branch unreadable: its merged pull request may be the one, so unknown.
  const half = await fake({ backlog: () => reply(503, { message: 'busy' }) }).gh.mergeProof({ number: 63, heads: [HEAD] });
  assert.equal(half.state, 'unknown');
  assert.match(half.why, /claude\/backlog-eng-63: GitHub answered 503/);
  assert.equal((await fake({ backlog: () => reply(503, { message: 'busy' }) }).gh.pullRequest(63)).state, 'unknown');
  // ...but a proof found on the other branch stands.
  assert.equal((await fake({ backlog: () => reply(503, { message: 'busy' }), candidate: () => reply(200, [PR24]) }).gh.mergeProof({ number: 63, heads: [HEAD] })).state, 'yes');
  // Nothing on either branch.
  const none = fake();
  assert.deepEqual(await none.gh.mergeProof({ number: 63, heads: [HEAD] }), { state: 'no', why: 'no pull request' });
  assert.deepEqual(await none.gh.pullRequest(63), { state: 'none', branches: ['claude/backlog-eng-63', 'claude/candidate-eng-63'] });
  // Without a recorded head GitHub is not asked.
  const quiet = fake();
  assert.equal((await quiet.gh.mergeProof({ number: 63, heads: [null] })).state, 'no');
  assert.equal(quiet.asked.length, 0);
});

test('verify runs only in a sealed worktree and binds its receipt to the clean head it tested', (t) => {
  const clean = bundleFixture(t);
  const head = g(clean, 'rev-parse', 'HEAD');
  const v0 = W.verify(clean);
  assert.deepEqual([v0.ok, v0.head_sha, v0.tree_sha, v0.worktree], [true, head, g(clean, 'rev-parse', 'HEAD^{tree}'), 'clean']);
  // An untracked or a changed file stops it before anything is built or run.
  put(clean, 'notes.txt', 'left behind (FICTIONAL)\n');
  const v1 = W.verify(clean);
  assert.deepEqual([v1.status, v1.ok, v1.exit_code, v1.total, v1.files, v1.head_sha], ['dirty_worktree_detected', false, null, null, ['notes.txt'], head]);
  assert.match(v1.says, /1 uncommitted or untracked file: commit or remove them/);
  fs.rmSync(path.join(clean, 'notes.txt'));
  put(clean, 'dashboard/cli.js', "console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0'); // edited\n");
  assert.deepEqual(W.verify(clean).files, ['dashboard/cli.js']);
  g(clean, 'checkout', '-q', '--', 'dashboard/cli.js');
  // A stale bundle beside other dirt is not rebuilt: nothing runs at all.
  const stale = bundleFixture(t, { stale: true });
  put(stale, 'dashboard/web/src/b.txt', 'untracked (FICTIONAL)\n');
  const before = fs.readFileSync(path.join(stale, 'dashboard/public/app/build.json'), 'utf8');
  assert.equal(W.verify(stale).status, 'dirty_worktree_detected');
  assert.equal(fs.readFileSync(path.join(stale, 'dashboard/public/app/build.json'), 'utf8'), before, 'the bundle was not built');
  fs.rmSync(path.join(stale, 'dashboard/web/src/b.txt'));
  // The bundle's own files are the bundle step's: rebuilt, then asked for
  // again until they are committed, never tested uncommitted.
  assert.equal(W.verify(stale).status, 'commit_bundle_first');
  const again = W.verify(stale);
  assert.deepEqual([again.status, again.ok, again.exit_code], ['commit_bundle_first', false, null]);
  assert.deepEqual(again.bundle.files.sort(), ['dashboard/public/app/build.json', 'dashboard/public/app/index.js']);
  g(stale, 'commit', '-qam', 'rebuild the bundle');
  assert.equal(W.verify(stale).ok, true);
  // Tests that leave a file behind, or move HEAD, verify nothing.
  const leaves = bundleFixture(t);
  put(leaves, 'dashboard/cli.js', "require('fs').writeFileSync(require('path').join(__dirname, 'left.txt'), 'x'); console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0');\n");
  g(leaves, 'commit', '-qam', 'tests that write (FICTIONAL)');
  const v2 = W.verify(leaves);
  assert.deepEqual([v2.status, v2.ok, v2.files, v2.exit_code], ['worktree_changed', false, ['dashboard/left.txt'], 0]);
  const moves = bundleFixture(t);
  put(moves, 'dashboard/cli.js', `require('child_process').execSync('git commit -q --allow-empty -m moved', { cwd: require('path').join(__dirname, '..'), env: { ...process.env, ...${JSON.stringify(IDENT)} } }); console.log('# tests 1'); console.log('# pass 1'); console.log('# fail 0');\n`);
  g(moves, 'commit', '-qam', 'tests that commit (FICTIONAL)');
  const tested = g(moves, 'rev-parse', 'HEAD');
  const v3 = W.verify(moves);
  assert.deepEqual([v3.status, v3.ok, v3.head_sha], ['head_moved', false, tested]);
  assert.notEqual(v3.head_after, tested);
});

// A git remote over HTTP that accepts each request and never answers, in its
// own process, counting the requests.
async function silentRemote(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-engsilent-'));
  const count = path.join(root, 'count');
  const code = `const fs=require('fs');let n=0;require('http').createServer(()=>{n+=1;fs.writeFileSync(${JSON.stringify(count)},String(n));}).listen(0,'127.0.0.1',function(){process.stdout.write(String(this.address().port)+'\\n');});`;
  const child = require('child_process').spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  return { url: `http://127.0.0.1:${port}/fictional.git`, asked: () => (fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0) };
}

test('a remote that never answers is stopped at the deadline and asked again after the waits', async (t) => {
  const f = fixture(t);
  const keys = ['CR_ENG_RETRY_DELAYS_MS', 'CR_ENG_GIT_TIMEOUT_MS', 'GIT_TERMINAL_PROMPT'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  process.env.CR_ENG_RETRY_DELAYS_MS = '0,0';
  process.env.CR_ENG_GIT_TIMEOUT_MS = '2000';
  process.env.GIT_TERMINAL_PROMPT = '0';
  // Either layer's words count as a passing failure.
  assert.ok(W.TRANSIENT_RE.test('git ls-remote: no answer within 2000 ms; stopped'));
  assert.ok(W.TRANSIENT_RE.test("fatal: unable to access 'https://github.com/x/y.git/': Operation too slow. Less than 1 bytes/sec transferred the last 15 seconds"));
  const silent = await silentRemote(t);
  const started = Date.now();
  // git stops itself after a second without a byte (half the deadline).
  assert.throws(() => W.remoteSha(f.work, { ref: 'refs/heads/claude/candidate-eng-7', remote: silent.url }), /Operation too slow/);
  const took = Date.now() - started;
  assert.equal(silent.asked(), 3, 'three tries, each stopped');
  assert.ok(took >= 2500 && took < 20000, `took ${took} ms`);
  // A push is held to the same deadline and read back before it is tried
  // again; the read-back has the deadline too, so nothing hangs.
  process.env.CR_ENG_RETRY_DELAYS_MS = '0';
  const head = g(f.work, 'rev-parse', 'HEAD');
  const was = silent.asked();
  assert.throws(() => W.push(f.work, { ref: 'refs/heads/claude/candidate-eng-7', sha: head, expect: null, remote: silent.url }), /Operation too slow/);
  assert.equal(silent.asked() - was, 6, 'two pushes, a two-try read-back between them, and the closing two-try read-back');
});
