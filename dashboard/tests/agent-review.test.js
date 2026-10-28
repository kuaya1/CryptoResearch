'use strict';
// The agent lane's paid review (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification): every request reserved in
// the ledger before it is sent and sent once; an answer that may have been
// accepted is reconciled with OpenAI's stored completions before anything is
// sent again; a verdict whose save or post failed is reused, never paid for
// twice. Fake OpenAI and GitHub APIs, a local bare repository for GitHub's
// Git, FICTIONAL records only; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('../scripts/agent-ledger');
const G = require('../scripts/agent-guard');
const AR = require('../scripts/agent-review');

const POLICY = G.loadPolicy();
const REPO = 'kuaya1/CryptoResearch';
const ENV = { GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: 'ghs_FICTIONAL', OPENAI_API_KEY: 'sk-FICTIONAL', OPENAI_REVIEW_MODEL: 'gpt-fictional', AGENT_LEDGER_KEY: `FICTIONAL-ledger-key-${'k'.repeat(24)}`, AGENT_REVIEW_ENABLED: 'true', BUILDER_APP_SLUG: 'cr-builder', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
const T0 = Date.parse('2026-10-26T12:00:00Z');
const BOT = { name: 'cr-builder[bot]', email: '1+cr-builder[bot]@users.noreply.github.com' };
const ERIC = { name: 'Eric FICTIONAL', email: 'eric@example.invalid' };
const ISSUE_BODY = [
  '### Template', '', 'eng-backend@1', '',
  '### Outcome', '', 'The widget size helper returns 0 for an empty input instead of throwing.', '',
  '### Acceptance checks', '', '- size of an empty string is 0', '',
  '### Negative cases', '', '- size of null throws a TypeError', '',
  '### Regression tests', '', 'dashboard/tests/widget.test.js', '',
  '### Files to change', '', '- dashboard/core/widget.js', '- dashboard/tests/widget.test.js', '',
  '### Notes', '', '_No response_',
].join('\n');

function git(cwd, args, { input, who } = {}) {
  const id = who ? { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email } : {};
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...id } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout).trim();
}

// main with a widget, and pull request #3: the builder's commit on
// agent/issue-7 (or Eric's own on another branch).
function fixture(t, { owner = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  git(dir, ['init', '-q', '--bare', remote]);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  git(src, ['init', '-q']);
  const put = (p, text) => { fs.mkdirSync(path.dirname(path.join(src, p)), { recursive: true }); fs.writeFileSync(path.join(src, p), text); };
  put('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: (s) => s.length };\n");
  git(src, ['add', '-A']);
  git(src, ['commit', '-q', '-m', 'main'], { who: ERIC });
  const main = git(src, ['rev-parse', 'HEAD']);
  put('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: (s) => (s === '' ? 0 : s.length) };\n");
  put('dashboard/tests/widget.test.js', "'use strict';\nconst assert = require('node:assert/strict');\nconst { size } = require('../core/widget');\nassert.equal(size(''), 0);\nassert.throws(() => size(null), TypeError);\n");
  git(src, ['add', '-A']);
  const issue = { number: 7, title: 'Widget size of an empty input', body: ISSUE_BODY, state: 'open', labels: [{ name: 'agent:build' }] };
  const task = G.taskOf(issue, { policy: POLICY });
  assert.deepEqual(task.problems, []);
  git(src, ['commit', '-q', '-m', owner ? 'Eric\'s own change' : G.commitMessage(task, { run: '5/1', policy: POLICY })], { who: owner ? ERIC : BOT });
  const head = git(src, ['rev-parse', 'HEAD']);
  const branch = owner ? 'eric/widget' : 'agent/issue-7';
  git(src, ['push', '-q', remote, `${main}:refs/heads/main`, `${head}:refs/heads/${branch}`, `${head}:refs/pull/3/head`]);
  let n = 0;
  // A fresh runner: an empty repository whose origin is "GitHub".
  const runner = () => { const w = path.join(dir, `runner-${n += 1}`); fs.mkdirSync(w); git(w, ['init', '-q']); git(w, ['remote', 'add', 'origin', remote]); return w; };
  const pull = { number: 3, state: 'open', head: { sha: head, ref: branch }, base: { ref: 'main' }, user: { login: owner ? 'kuaya1' : 'cr-builder[bot]' } };
  const fx = { remote, head, main, issue, pull, runner, task };
  // The pull request moves: its branch and refs/pull/3/head go to `sha`.
  const moveTo = (sha) => { git(src, ['push', '-q', '-f', remote, `${sha}:refs/heads/${branch}`, `${sha}:refs/pull/3/head`]); fx.head = sha; pull.head.sha = sha; return sha; };
  // main gains a commit of Eric's (another file unless named).
  fx.onMain = (p = 'dashboard/core/other.js', text = `module.exports = ${Date.now()};\n`) => {
    git(src, ['checkout', '-q', fx.main]);
    put(p, text);
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', 'main moves on'], { who: ERIC });
    fx.main = git(src, ['rev-parse', 'HEAD']);
    git(src, ['push', '-q', remote, `${fx.main}:refs/heads/main`]);
    git(src, ['checkout', '-q', '--detach', fx.head]);
    return fx.main;
  };
  // GitHub's "Update branch": a merge of main by Eric; `extra` adds a change
  // of its own to the merge.
  fx.updateBranch = ({ extra = null } = {}) => {
    git(src, ['checkout', '-q', '--detach', fx.head]);
    git(src, ['merge', '-q', '--no-ff', '--no-commit', fx.main], { who: ERIC });
    if (extra) { put(extra[0], extra[1]); git(src, ['add', '-A']); }
    git(src, ['commit', '-q', '-m', `Merge branch 'main' into ${branch}`], { who: ERIC });
    return moveTo(git(src, ['rev-parse', 'HEAD']));
  };
  // A commit of the pull request's own (the builder's for a candidate).
  fx.commitOwn = (p, text) => {
    git(src, ['checkout', '-q', '--detach', fx.head]);
    put(p, text);
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', owner ? 'Eric again' : G.commitMessage(task, { run: '5/1', policy: POLICY })], { who: owner ? ERIC : BOT });
    return moveTo(git(src, ['rev-parse', 'HEAD']));
  };
  return fx;
}
// Eric's comment and approval as GitHub returns them (FICTIONAL ids).
const OWNER_USER = { login: 'kuaya1', type: 'User' };
const comment = (id, body, o = {}) => ({ id, body, user: OWNER_USER, author_association: 'OWNER', created_at: '2026-10-27T10:00:00Z', updated_at: '2026-10-27T10:00:00Z', html_url: `https://github.com/${REPO}/pull/3#issuecomment-${id}`, ...o });
const approval = (id, sha, o = {}) => ({ id, state: 'APPROVED', commit_id: sha, user: OWNER_USER, author_association: 'OWNER', submitted_at: '2026-10-27T11:00:00Z', ...o });

const resp = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const VERDICT = { result: 'pass', summary: 'FICTIONAL: the change does what the task says.', findings: [{ severity: 'note', path: 'dashboard/core/widget.js', line: 2, summary: 'FICTIONAL note.' }] };

// OpenAI and GitHub as the reviewer sees them. Each POST to OpenAI takes the
// next mode: ok, timeout (accepted, then the answer is lost), 503 (refused
// before acceptance), 429, cut (accepted, body cut).
function world(fx, { modes = [], fallback = 'ok' } = {}) {
  const w = { clock: T0, posts: 0, bodies: [], stored: [], checks: [], checkFail: 0, modelStatus: 200, listStatus: 200, required: { test: 'success', 'agent-guard': 'success', 'agent-verify': 'success' }, verdict: VERDICT, modes: [...modes], comments: [], reviews: [] };
  w.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.host === 'api.openai.com') {
      if (method === 'POST' && u.pathname === '/v1/chat/completions') {
        w.posts += 1;
        const body = JSON.parse(opts.body);
        w.bodies.push(body);
        assert.equal(body.store, true);
        assert.match(body.metadata.cr_attempt, /^rv-[0-9a-f]{16}$/);
        const completion = { id: `chatcmpl-${w.posts}`, object: 'chat.completion', model: body.model, metadata: body.metadata, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(w.verdict) } }], usage: { total_tokens: 1234 } };
        const mode = w.modes.shift() || fallback;
        if (['ok', 'timeout', 'cut'].includes(mode)) w.stored.push(completion);
        if (mode === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
        if (mode === 'cut') return resp(200, '{"id":"chatcmpl');
        if (mode === '503') return resp(503, { error: { type: 'server_error' } });
        if (mode === '429') return resp(429, { error: { code: 'rate_limit_exceeded' } });
        return resp(200, completion);
      }
      if (method === 'GET' && u.pathname === '/v1/chat/completions') return w.listStatus !== 200 ? resp(w.listStatus, {}) : resp(200, { object: 'list', data: w.stored.filter((c) => !u.searchParams.has('metadata[cr_attempt]') || c.metadata.cr_attempt === u.searchParams.get('metadata[cr_attempt]')) });
      const one = /^\/v1\/chat\/completions\/(.+)$/.exec(u.pathname);
      if (method === 'GET' && one) { const c = w.stored.find((x) => x.id === decodeURIComponent(one[1])); return c ? resp(200, c) : resp(404, {}); }
      if (method === 'GET' && u.pathname.startsWith('/v1/models/')) return resp(w.modelStatus, { id: 'gpt-fictional' });
    }
    if (u.host === 'api.github.com') {
      if (u.pathname === `/repos/${REPO}/pulls/3`) return resp(200, fx.pull);
      if (u.pathname === `/repos/${REPO}/issues/7`) return resp(200, fx.issue);
      // Comments, reviews and open pull requests: one page each.
      if (u.pathname === `/repos/${REPO}/issues/3/comments` && method === 'GET') return w.comments === null ? resp(502, {}) : resp(200, u.searchParams.get('page') === '1' ? w.comments : []);
      if (u.pathname === `/repos/${REPO}/pulls/3/reviews` && method === 'GET') return resp(200, u.searchParams.get('page') === '1' ? w.reviews : []);
      if (u.pathname === `/repos/${REPO}/pulls` && method === 'GET') return resp(200, u.searchParams.get('page') === '1' && fx.pull.state === 'open' ? [fx.pull] : []);
      // The required checks, and every agent-review posted on that head.
      if (/\/check-runs$/.test(u.pathname) && method === 'GET') {
        const sha = /\/commits\/([0-9a-f]{40})\/check-runs$/.exec(u.pathname)[1];
        const posted = w.checks.map((c, i) => ({ ...c, id: 1000 + i, app: { id: 15368 } })).filter((c) => c.head_sha === sha);
        return resp(200, { check_runs: [...Object.entries(w.required).map(([name, s], i) => ({ id: 100 + i, name, app: { id: 15368 }, status: s === 'pending' ? 'in_progress' : 'completed', conclusion: s === 'pending' ? null : s })), ...posted] });
      }
      if (u.pathname === `/repos/${REPO}/check-runs` && method === 'POST') {
        if (w.checkFail > 0) { w.checkFail -= 1; return resp(502, {}); }
        w.checks.push(JSON.parse(opts.body));
        return resp(201, { id: w.checks.length });
      }
    }
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return w;
}
const review = (fx, w, { env = {}, policy = POLICY, hooks = {} } = {}) => AR.reviewHead({ pr: 3, head: fx.head, env: { ...ENV, ...env }, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy, runUrl: 'https://github.com/kuaya1/CryptoResearch/actions/runs/1', hooks });
const ledger = (fx) => L.read(fx.runner()).entries;
const lastCheck = (w) => w.checks[w.checks.length - 1];

test('a pass is reserved, sent once with its attempt ID and posted; the next trigger sends nothing', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const r = await review(fx, w);
  assert.equal(r.status, 'posted');
  assert.equal(w.posts, 1);
  assert.equal(lastCheck(w).name, 'agent-review');
  assert.equal(lastCheck(w).head_sha, fx.head);
  assert.equal(lastCheck(w).conclusion, 'success');
  assert.deepEqual(ledger(fx).map((e) => `${e.t}:${e.state || ''}`), ['reserve:', 'outcome:response', 'posted:']);
  const reserve = ledger(fx)[0];
  assert.equal(w.bodies[0].metadata.cr_attempt, reserve.id);
  assert.deepEqual([reserve.bind.head, reserve.bind.pr, reserve.bind.issue, reserve.bind.task_sha256, reserve.bind.model], [fx.head, 3, 7, G.taskOf(fx.issue).body_sha256, 'gpt-fictional']);
  const again = await review(fx, w);
  assert.equal(again.status, 'posted');
  assert.ok(again.reused);
  assert.equal(w.posts, 1);
  assert.equal(w.checks.length, 1);
});

test('a timeout after OpenAI accepted the request: nothing is resent; the next run takes the stored answer', async (t) => {
  const fx = fixture(t);
  const w = world(fx, { modes: ['timeout'] });
  const first = await review(fx, w);
  assert.equal(first.status, 'uncertain');
  assert.equal(w.posts, 1);
  assert.equal(w.checks.length, 0, 'nothing is posted while the outcome is unknown');
  assert.equal(ledger(fx).at(-1).state, 'unknown');
  const second = await review(fx, w);
  assert.equal(second.status, 'posted');
  assert.match(second.says, /recovered from the stored completion/);
  assert.equal(w.posts, 1, 'the answer OpenAI kept was reused, not paid for again');
  assert.equal(lastCheck(w).conclusion, 'success');
  assert.equal(ledger(fx).find((e) => e.state === 'response').via, 'reconcile');
});

test('an answer whose save failed is recovered from OpenAI, not bought again', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const first = await review(fx, w, { hooks: { failRecord: true } });
  assert.equal(first.status, 'uncertain');
  assert.equal(w.posts, 1);
  assert.equal(w.checks.length, 0, 'a verdict is posted only once the ledger holds it');
  assert.deepEqual(ledger(fx).map((e) => e.t), ['reserve']);
  const second = await review(fx, w);
  assert.equal(second.status, 'posted');
  assert.equal(w.posts, 1);
  assert.equal(lastCheck(w).conclusion, 'success');
});

test('a check that could not be posted is posted from the ledger next time, with no request', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  w.checkFail = 1;
  await assert.rejects(review(fx, w), /could not be posted \(HTTP 502\)/);
  assert.equal(w.posts, 1);
  assert.equal(ledger(fx).at(-1).state, 'response');
  const second = await review(fx, w);
  assert.equal(second.status, 'posted');
  assert.equal(w.posts, 1);
  assert.equal(lastCheck(w).conclusion, 'success');
});

test('a runner lost after reserving: a young attempt blocks any resend; past the grace one new attempt is sent', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  await assert.rejects(review(fx, w, { hooks: { beforeSend: () => { throw new Error('runner lost'); } } }), /runner lost/);
  assert.equal(w.posts, 0);
  w.clock = T0 + 5 * 60000;
  const young = await review(fx, w);
  assert.equal(young.status, 'uncertain');
  assert.match(young.says, /5 min old and not found at OpenAI yet/);
  assert.equal(w.posts, 0);
  assert.equal(w.checks.length, 0);
  w.clock = T0 + (POLICY.review.unknown_grace_minutes + 1) * 60000;
  const old = await review(fx, w);
  assert.equal(old.status, 'posted');
  assert.equal(w.posts, 1);
  assert.deepEqual(ledger(fx).filter((e) => e.t !== 'posted').map((e) => `${e.t}:${e.state || ''}`), ['reserve:', 'outcome:lost', 'reserve:', 'outcome:response']);
});

test('two triggers at once: the second finds the first attempt in flight and sends nothing', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  let inner = null;
  const outer = await review(fx, w, { hooks: { beforeSend: async () => { inner = await review(fx, w); } } });
  assert.equal(inner.status, 'uncertain');
  assert.equal(outer.status, 'posted');
  assert.equal(w.posts, 1);
  assert.equal(w.checks.length, 1);
  assert.equal(ledger(fx).filter((e) => e.t === 'reserve').length, 1);
});

test('GPT\'s reproduction: a failing API costs one request per attempt and stops at the ceiling, never four for two triggers', async (t) => {
  const fx = fixture(t);
  const w = world(fx, { fallback: '503' });
  await review(fx, w);
  await review(fx, w);
  assert.equal(w.posts, 1, 'two invocations, one request: the second waits for the first to be reconciled');
  assert.equal(w.checks.length, 0);
  const grace = (POLICY.review.unknown_grace_minutes + 1) * 60000;
  w.clock += grace;
  assert.equal((await review(fx, w)).status, 'uncertain');
  assert.equal(w.posts, 2);
  w.clock += grace;
  const stop = await review(fx, w);
  assert.equal(stop.status, 'refused');
  assert.equal(w.posts, 2);
  assert.equal(lastCheck(w).conclusion, 'action_required');
  assert.match(lastCheck(w).output.summary, /2 paid attempts for this exact head, diff and task already/);
  assert.equal(ledger(fx).filter((e) => e.t === 'reserve').length, 2);
});

test('refused requests count: two 429s use up the head, and the daily ceiling holds across bindings', async (t) => {
  const fx = fixture(t);
  const w = world(fx, { fallback: '429' });
  for (const n of [1, 2]) {
    const r = await review(fx, w);
    assert.equal(r.status, 'failed');
    assert.equal(w.posts, n);
    assert.match(lastCheck(w).output.summary, /HTTP 429, rate_limit_exceeded/);
  }
  assert.equal((await review(fx, w)).status, 'refused');
  assert.equal(w.posts, 2);
  // Another review configuration is another binding, still within today.
  const tight = { ...POLICY, ceilings: { ...POLICY.ceilings, reviews_per_day: 2 } };
  const r = await review(fx, w, { env: { OPENAI_REVIEW_MODEL: 'gpt-fictional-2' }, policy: tight });
  assert.equal(r.status, 'refused');
  assert.match(lastCheck(w).output.summary, /2 paid review attempts today/);
  assert.equal(w.posts, 2);
});

test('an unreadable 200 is kept open and reconciled, not resent', async (t) => {
  const fx = fixture(t);
  const w = world(fx, { modes: ['cut'] });
  assert.equal((await review(fx, w)).status, 'uncertain');
  assert.equal((await review(fx, w)).status, 'posted');
  assert.equal(w.posts, 1);
});

test('nothing is paid for: the review off, the task edited after the build, a required check failed or pending', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const off = await review(fx, w, { env: { AGENT_REVIEW_ENABLED: 'false' } });
  assert.equal(off.status, 'off');
  assert.equal(lastCheck(w).conclusion, 'action_required');
  assert.deepEqual(ledger(fx), [], 'nothing was reserved');
  w.required['agent-verify'] = 'pending';
  assert.equal((await review(fx, w)).status, 'waiting');
  w.required['agent-verify'] = 'failure';
  const failed = await review(fx, w);
  assert.equal(failed.status, 'not_ready');
  assert.equal(lastCheck(w).conclusion, 'failure');
  w.required['agent-verify'] = 'success';
  fx.issue.body = fx.issue.body.replace('_No response_', 'FICTIONAL: also change the cache.');
  const edited = await review(fx, w);
  assert.equal(edited.status, 'refused');
  assert.match(lastCheck(w).output.summary, /was edited after this build/);
  assert.equal(w.posts, 0);
  assert.deepEqual(ledger(fx), []);
});

test('a verdict line written without the key is never posted', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  assert.equal((await review(fx, w, { env: { AGENT_REVIEW_ENABLED: 'false' } })).status, 'off');
  // Someone with write access to the ledger branch appends a reservation and
  // a passing verdict for this exact binding, signed with another key.
  const r = await review(fx, w, { hooks: { beforeSend: () => { throw new Error('stop after reserving'); } } }).catch((e) => e);
  assert.match(String(r.message), /stop after reserving/);
  const reserve = ledger(fx).find((e) => e.t === 'reserve');
  const rec = { t: 'outcome', id: reserve.id, state: 'response', response_id: 'chatcmpl-forged', verdict: VERDICT };
  L.transact(fx.runner(), { decide: () => ({ append: [{ ...rec, mac: L.macOf(L.macKey('not the key'), { ...rec, binding: reserve.binding }) }] }) });
  const after = await review(fx, w);
  assert.equal(after.status, 'refused');
  assert.match(lastCheck(w).output.summary, /fails its check/);
  assert.equal(w.posts, 0);
});

test('verdicts are signed with the ledger\'s own key: without it nothing is read or posted, under another key a held verdict is refused, and a new OpenAI key changes nothing', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const reads = [];
  const fetch = w.fetch;
  w.fetch = (url, o) => { reads.push(url); return fetch(url, o); };
  for (const k of ['', 'x'.repeat(31)]) {
    const r = await review(fx, w, { env: { AGENT_LEDGER_KEY: k } });
    assert.equal(r.status, 'not_configured');
    assert.match(r.says, /AGENT_LEDGER_KEY \(a repository secret, Eric's, at least 32 characters\) is not set; nothing was read, reserved or posted/);
    assert.deepEqual((await AR.sweep({ env: { ...ENV, AGENT_LEDGER_KEY: k }, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY }))[0].status, 'not_configured');
    const pf = await AR.preflight({ env: { ...ENV, AGENT_LEDGER_KEY: k }, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY });
    assert.equal(pf.ok, false);
    assert.ok(pf.lines.some((x) => /^Ledger key: AGENT_LEDGER_KEY \(a repository secret/.test(x)), pf.lines.join('\n'));
  }
  assert.equal(reads.filter((u) => !u.includes('/v1/models/') && !u.includes('/v1/chat/completions?limit=1')).length, 0, 'no pull request read, nothing sent, no check posted');
  assert.equal(w.checks.length, 0);
  assert.deepEqual(ledger(fx), []);
  // A pass under key A.
  assert.equal((await review(fx, w)).status, 'posted');
  assert.equal(w.posts, 1);
  // The OpenAI key is rotated: the held verdict still checks and is reposted, nothing sent.
  const rotated = await review(fx, w, { env: { OPENAI_API_KEY: 'sk-FICTIONAL-rotated' }, hooks: { repost: true } });
  assert.equal(rotated.status, 'posted');
  assert.equal(lastCheck(w).conclusion, 'success');
  assert.equal(w.posts, 1);
  // Under another ledger key the same line fails its check: refused, never posted as a verdict, nothing sent.
  const other = await review(fx, w, { env: { AGENT_LEDGER_KEY: `FICTIONAL-other-ledger-key-${'q'.repeat(20)}` }, hooks: { repost: true } });
  assert.equal(other.status, 'refused');
  assert.equal(lastCheck(w).conclusion, 'action_required');
  assert.match(lastCheck(w).output.summary, /fails its check/);
  assert.equal(w.posts, 1);
  // The key is its own: the MAC under the ledger key is not the one under the OpenAI key.
  const held = ledger(fx);
  const line = { ...held.find((e) => e.state === 'response'), binding: held.find((e) => e.t === 'reserve').binding };
  assert.ok(L.macOk(L.ledgerKey(ENV), line));
  assert.equal(L.macOk(L.macKey(ENV.OPENAI_API_KEY), line), false);
});

// Eric's own review (hardening, 2026-10-27; agent-owner-review.js): only a record
// GitHub authenticates counts, and it names one exact head.
test('a change that is not an agent candidate is never sent to a model; Eric\'s own change too reads Missing until his review of this exact head', async (t) => {
  const fx = fixture(t, { owner: true });
  const w = world(fx);
  const r = await review(fx, w);
  assert.equal(r.status, 'missing');
  assert.equal(w.posts, 0);
  assert.deepEqual(ledger(fx), []);
  assert.equal(lastCheck(w).conclusion, 'action_required');
  assert.equal(lastCheck(w).output.title, `Missing: no review of ${fx.head.slice(0, 12)}`);
  assert.ok(lastCheck(w).output.summary.includes(`\`\`\`\n/reviewed ${fx.head}\n\`\`\``));
  assert.equal((await review(fx, w)).status, 'missing');
  assert.equal(w.checks.length, 1, 'the same state is not posted twice');
  // None of these is Eric's review of this head.
  w.comments.push(
    comment(50, `/reviewed ${fx.head}`, { user: { login: 'someone', type: 'User' }, author_association: 'COLLABORATOR' }),
    comment(51, `/reviewed ${fx.head}`, { user: { login: 'kuaya1', type: 'Bot' } }),
    comment(52, `/reviewed ${fx.head}`, { updated_at: '2026-10-27T10:05:00Z' }),
    comment(53, `/reviewed ${fx.head.slice(0, 12)}`),
    comment(54, `/reviewed ${fx.head.toUpperCase()}`),
    comment(55, `/reviewed ${fx.head} and the next one too`),
    comment(56, `Looks fine. /reviewed ${fx.head}`),
  );
  w.reviews.push(
    approval(60, fx.head, { user: { login: 'someone', type: 'User' }, author_association: 'COLLABORATOR' }),
    approval(61, fx.head, { state: 'DISMISSED' }),
    approval(62, fx.head, { state: 'COMMENTED' }),
  );
  assert.equal((await review(fx, w)).status, 'missing');
  const s = lastCheck(w).output.summary;
  assert.match(s, /comment 50 \(it is by someone \(User, COLLABORATOR\), not the repository's owner\)/);
  assert.match(s, /comment 51 \(it is by kuaya1 \(Bot, OWNER\), not the repository's owner\)/);
  assert.match(s, /comment 52 \(it was edited after it was posted\)/);
  for (const id of [53, 54, 55]) assert.ok(s.includes(`comment ${id} (its first line is not "/reviewed" and a full 40-character commit)`), String(id));
  assert.doesNotMatch(s, /comment 56/);
  // Eric's own comment naming this head: an override, neutral, nothing paid.
  w.comments.push(comment(99, `/reviewed ${fx.head}\nRead it on my phone.`));
  const ok = await review(fx, w);
  assert.equal(ok.status, 'owner_override');
  assert.equal(lastCheck(w).conclusion, 'neutral');
  assert.equal(lastCheck(w).output.title, `Owner override: kuaya1 reviewed ${fx.head.slice(0, 12)}`);
  assert.match(lastCheck(w).output.summary, /kuaya1 reviewed this head himself \(comment 99 at 2026-10-27T10:00:00Z\)/);
  assert.equal(w.posts, 0);
  assert.deepEqual(ledger(fx), []);
});

test('Eric\'s approval counts at the commit GitHub bound it to, and the sweep picks it up (an approval starts no trusted run)', async (t) => {
  const fx = fixture(t, { owner: true });
  const w = world(fx);
  assert.equal((await review(fx, w)).status, 'missing');
  w.reviews.push(approval(12, fx.head));
  const sweep = () => AR.sweep({ env: ENV, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY });
  const out = await sweep();
  assert.deepEqual(out.map((o) => [o.status, o.pr]), [['posted', 3]]);
  assert.equal(lastCheck(w).conclusion, 'neutral');
  assert.match(lastCheck(w).output.summary, /approving review 12 at 2026-10-27T11:00:00Z/);
  assert.deepEqual((await sweep()).map((o) => o.status), ['unchanged']);
  // A head with no review of Eric's: the sweep posts nothing for it.
  fx.commitOwn('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: (s) => (s === '' ? 0 : String(s).length) };\n");
  const n = w.checks.length;
  assert.deepEqual(await sweep(), []);
  assert.equal(w.checks.length, n);
  assert.equal(w.posts, 0);
});

test('a review carries over GitHub\'s "Update branch" only: a commit of its own or a merge that adds a change invalidates it', async (t) => {
  const fx = fixture(t, { owner: true });
  const w = world(fx);
  const h0 = fx.head;
  w.comments.push(comment(70, `/reviewed ${h0}`));
  assert.equal((await review(fx, w)).status, 'owner_override');
  fx.onMain();
  const h1 = fx.updateBranch();
  assert.equal((await review(fx, w)).status, 'owner_override');
  assert.equal(lastCheck(w).head_sha, h1);
  assert.equal(lastCheck(w).output.title, `Owner override: carried over from ${h0.slice(0, 12)}`);
  assert.match(lastCheck(w).output.summary, /the one commit since merges main and adds nothing of its own, and the pull request's own change is the same patch \([0-9a-f]{12}\)/);
  // Twice more: two merges still carry over.
  fx.onMain('dashboard/core/third.js', 'module.exports = 3;\n');
  fx.updateBranch();
  assert.equal((await review(fx, w)).status, 'owner_override');
  assert.match(lastCheck(w).output.summary, /the 2 commits since merge main and add nothing of their own/);
  // A merge that slips in a change of its own.
  fx.onMain('dashboard/core/fourth.js', 'module.exports = 4;\n');
  const evil = fx.updateBranch({ extra: ['dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: () => 0 };\n"] });
  assert.equal((await review(fx, w)).status, 'invalidated');
  assert.equal(lastCheck(w).conclusion, 'action_required');
  assert.equal(lastCheck(w).output.title, `Invalidated by a new commit: kuaya1 reviewed ${h0.slice(0, 12)}, the head is ${evil.slice(0, 12)}`);
  assert.ok(lastCheck(w).output.summary.includes(`merge ${evil.slice(0, 12)} adds changes of its own`));
  assert.ok(lastCheck(w).output.summary.includes(`/reviewed ${evil}\n`));
  // Eric reviews that head; then a commit of the pull request's own.
  w.comments.push(comment(71, `/reviewed ${evil}`, { created_at: '2026-10-27T12:00:00Z', updated_at: '2026-10-27T12:00:00Z' }));
  assert.equal((await review(fx, w)).status, 'owner_override');
  const own = fx.commitOwn('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: () => 1 };\n");
  assert.equal((await review(fx, w)).status, 'invalidated');
  assert.equal(lastCheck(w).output.title, `Invalidated by a new commit: kuaya1 reviewed ${evil.slice(0, 12)}, the head is ${own.slice(0, 12)}`);
  assert.ok(lastCheck(w).output.summary.includes(`${own.slice(0, 12)} is a commit of its own, not a merge of main`));
  assert.equal(w.posts, 0);
});

test('a model pass carries over "Update branch" with nothing sent; a commit of the builder\'s own is reviewed again', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const h0 = fx.head;
  assert.equal((await review(fx, w)).status, 'posted');
  assert.equal(w.posts, 1);
  fx.onMain();
  const h1 = fx.updateBranch();
  const r = await review(fx, w);
  assert.equal(r.status, 'posted');
  assert.equal(w.posts, 1, 'nothing sent for the merged head');
  assert.equal(lastCheck(w).head_sha, h1);
  assert.equal(lastCheck(w).conclusion, 'success');
  assert.equal(lastCheck(w).output.title, `Independent pass (1 note), carried over from ${h0.slice(0, 12)}`);
  assert.match(lastCheck(w).output.summary, /It was given for [0-9a-f]{12} and covers this head: the one commit since merges main/);
  const line = ledger(fx).at(-1);
  assert.deepEqual([line.t, line.head, line.carried_from, line.conclusion], ['posted', h1, h0, 'pass']);
  const n = w.checks.length;
  assert.equal((await review(fx, w)).status, 'posted');
  assert.equal(w.checks.length, n, 'posted once');
  fx.commitOwn('dashboard/core/widget.js', "'use strict';\nmodule.exports = { size: (s) => (s === '' ? 0 : s.length + 0) };\n");
  assert.equal((await review(fx, w)).status, 'posted');
  assert.equal(w.posts, 2, 'a change of its own is reviewed again');
  assert.equal(lastCheck(w).output.title, 'Independent pass (1 note)');
});

test('Eric\'s review of an agent candidate\'s head stands in for the model\'s with nothing reserved; a pass already posted stays', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  assert.equal((await review(fx, w, { env: { AGENT_REVIEW_ENABLED: 'false' } })).status, 'off');
  assert.equal(lastCheck(w).output.title, 'Missing: the model review is off');
  assert.ok(lastCheck(w).output.summary.includes(`/reviewed ${fx.head}\n`));
  w.comments.push(comment(80, `/reviewed ${fx.head}`));
  const o = await review(fx, w, { env: { AGENT_REVIEW_ENABLED: 'false' } });
  assert.equal(o.status, 'owner_override');
  assert.equal(lastCheck(w).conclusion, 'neutral');
  assert.equal(w.posts, 0);
  assert.deepEqual(ledger(fx), []);
  // A model pass posted first is not replaced by the override.
  const fx2 = fixture(t);
  const w2 = world(fx2);
  assert.equal((await review(fx2, w2)).status, 'posted');
  const n = w2.checks.length;
  w2.comments.push(comment(81, `/reviewed ${fx2.head}`));
  const kept = await review(fx2, w2);
  assert.equal(kept.status, 'posted');
  assert.match(kept.says, /The model's pass on [0-9a-f]{12} stands/);
  assert.equal(w2.checks.length, n);
  assert.equal(lastCheck(w2).conclusion, 'success');
});

test('every check names its state: Failed for a required check that failed or changes required, Missing for insufficient evidence', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  w.required.test = 'failure';
  assert.equal((await review(fx, w)).status, 'not_ready');
  assert.equal(lastCheck(w).output.title, 'Failed: test did not pass');
  assert.equal(lastCheck(w).conclusion, 'failure');
  assert.equal(AR.verdictCheck('a'.repeat(40), 'rv-1', { result: 'changes_required', findings: [{ severity: 'high', summary: 'x' }], summary: 's' }, 'm', null).output.title, 'Failed: changes required (1 high)');
  assert.equal(AR.verdictCheck('a'.repeat(40), 'rv-1', { result: 'insufficient_evidence', findings: [], summary: 's' }, 'm', null).output.title, 'Missing: insufficient evidence');
});

test('the sweep settles an attempt whose pull request moved on, without posting on the old head', async (t) => {
  const fx = fixture(t);
  const w = world(fx, { modes: ['timeout'] });
  assert.equal((await review(fx, w)).status, 'uncertain');
  fx.pull.head.sha = 'f'.repeat(40);
  const out = await AR.sweep({ env: ENV, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY });
  // The settled attempt, then the open pull request read for an approval:
  // its head is not one GitHub's Git holds, so nothing is picked up.
  assert.deepEqual(out.map((o) => o.status), ['settled', 'unreadable']);
  assert.match(out[1].says, /#3 f{12} could not be fetched; no approval picked up/);
  assert.equal(ledger(fx).at(-1).state, 'response');
  assert.equal(w.checks.length, 0);
  assert.equal(w.posts, 1);
});

test('the handshake reads the model with the key at no charge and reads the ledger', async (t) => {
  const fx = fixture(t);
  const w = world(fx);
  const ok = await AR.preflight({ env: ENV, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY });
  assert.equal(ok.ok, true);
  assert.match(ok.lines.join('\n'), /reads model gpt-fictional/);
  assert.match(ok.lines.join('\n'), /0 of 12 review attempts/);
  assert.match(ok.lines.join('\n'), /lists stored completions/);
  // A key that reads the model but cannot list stored completions could not
  // reconcile an uncertain attempt: not ready.
  w.listStatus = 403;
  const blind = await AR.preflight({ env: ENV, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY });
  assert.equal(blind.ok, false);
  assert.match(blind.lines.join('\n'), /chat\/completions answered HTTP 403/);
  w.listStatus = 200;
  w.modelStatus = 401;
  const bad = await AR.preflight({ env: ENV, cwd: fx.runner(), fetchImpl: w.fetch, now: () => w.clock, policy: POLICY });
  assert.equal(bad.ok, false);
  assert.match(bad.lines[0], /HTTP 401/);
  assert.equal(w.posts, 0);
});

test('verdicts: a pass with a medium finding is changes_required; other answers are no verdict', () => {
  assert.equal(AR.normalizeVerdict(JSON.stringify({ result: 'pass', findings: [{ severity: 'medium', summary: 'x' }] })).result, 'changes_required');
  assert.equal(AR.normalizeVerdict('not json'), null);
  assert.equal(AR.normalizeVerdict(JSON.stringify({ result: 'ship it' })), null);
  const c = AR.verdictCheck('a'.repeat(40), 'rv-1', { result: 'insufficient_evidence', findings: [], summary: 's' }, 'm', null);
  assert.equal(c.conclusion, 'action_required');
});
