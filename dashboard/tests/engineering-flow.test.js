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
});

test('both delegations active: application work declared with no review is promoted only after the ChatGPT review its delegation requires', async (t) => {
  const f = fixture(t);
  const { ws, cleanup } = tempWorkspace('engflow-match'); t.after(cleanup);
  I.activatePolicy(ws, OWNER, { template: 'eng-app@1', goal_id: 'desk-polish', goal: 'Polish the desk (FICTIONAL)' }, o());
  I.activatePolicy(ws, OWNER, { template: 'eng-docs@1' }, o(1));
  const file = 'dashboard/web/src/shell/Fictional.jsx';
  const p = I.prepareTask(ws, CHAT, { ...docsTask('Fictional panel (FICTIONAL)', file), goal_id: 'desk-polish', required_review: 'none' }, o());
  assert.equal(p.match.delegation.template, 'eng-app@1');
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
  I.saveReview(ws, CHAT, { task_id: id, head_sha: head, merge_base_sha: ev.merge_base_sha, result: 'pass', read: { diff: true, tests: true, acceptance: true } }, o());
  const ok = await check();
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.equal(ok.attestation.review_state, 'pass');
});

test('GitHub readback that cannot be read says unknown, never a pass; a token is never in the answer', async () => {
  const fail = makeGithub({ fetchImpl: async () => { throw new Error('ENOTFOUND'); }, revision: () => ({ commit: 'c'.repeat(40) }), env: { CR_GITHUB_TOKEN: 'fictional-github-token' } });
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
