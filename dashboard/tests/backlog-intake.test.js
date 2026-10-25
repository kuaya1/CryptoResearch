'use strict';
// Voice intake retries (scripts/backlog-intake.js, review A09 2026-10-25): a
// temporary git repo with a bare origin and an in-memory stand-in for the
// GitHub API. A push that landed with a failed PR call is completed on retry,
// exactly one PR per issue; open, merged and closed PRs are said as they are;
// two intakes waiting together never share a number; the issue text is data.
// No network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { intake } = require('../scripts/backlog-intake');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const REPO = 'o/r';
const issue = (number, extra = {}) => ({ number, title: `Issue ${number} (FICTIONAL)`, body: 'Do the thing.', url: `https://github.com/${REPO}/issues/${number}`, ...extra });
const APPROVAL = 'the label `ready` was set by @kuaya1 (FICTIONAL test).';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-intake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const work = path.join(root, 'work');
  g(root, 'clone', '-q', origin, work);
  g(work, 'config', 'core.autocrlf', 'false');
  g(work, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'DESK_STATE.md'), '## Autonomous Build Backlog\n- [x] **1. One.** a\n- [ ] *(Eric)* **2. Two.** b\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
  // A fresh checkout of main per run, as on a runner.
  let n = 0;
  const runner = () => { const d = path.join(root, `run-${n++}`); g(root, 'clone', '-q', '-b', 'main', origin, d); g(d, 'config', 'core.autocrlf', 'false'); return d; };
  // The GitHub API as the script uses it: list a branch's PRs, create one.
  const prs = [];
  const gh = (args) => {
    if (args[1] === '-X' && args[2] === 'POST') {
      if (gh.failCreate) { gh.failCreate -= 1; throw new Error('HTTP 502 (FICTIONAL)'); }
      const head = args.find((a) => a.startsWith('head=')).slice(5);
      const pr = { number: 100 + prs.length, head, state: 'open', merged_at: null, title: args.find((a) => a.startsWith('title=')).slice(6), body: args.find((a) => a.startsWith('body=')).slice(5) };
      prs.push(pr);
      return String(pr.number);
    }
    const head = decodeURIComponent(/head=[^:]+:([^&]+)/.exec(args[1])[1]);
    return JSON.stringify(prs.filter((p) => p.head === head).map(({ number, state, merged_at }) => ({ number, state, merged_at })));
  };
  gh.failCreate = 0;
  const branchText = (branch) => g(work, 'show', `origin/${branch}:DESK_STATE.md`);
  return { root, work, runner, gh, prs, branchText, origin };
}

test('A09: a push that landed with a failed PR call gets its PR on the retry, exactly one, with the same item; a further retry is "already open"', (t) => {
  const f = fixture(t);
  f.gh.failCreate = 1;
  const first = intake(f.runner(), { repo: REPO, issue: issue(7), approval: APPROVAL, gh: f.gh });
  assert.equal(first.status, 'pr_failed');
  assert.equal(first.item, 3);
  assert.equal(f.prs.length, 0);
  g(f.work, 'fetch', '-q', 'origin');
  assert.match(f.branchText('claude/intake-issue-7'), /- \[ \] \*\*3\. Issue 7 \(FICTIONAL\)\*\* \*\(from issue \[#7\]/);
  const retry = intake(f.runner(), { repo: REPO, issue: issue(7), approval: APPROVAL, gh: f.gh });
  assert.equal(retry.status, 'pr_created_on_retry');
  assert.equal(retry.item, 3);
  assert.equal(f.prs.length, 1);
  assert.equal(f.prs[0].title, 'Intake: item 3 from issue #7');
  assert.match(f.prs[0].body, /Approval source: the label `ready` was set by @kuaya1/);
  const again = intake(f.runner(), { repo: REPO, issue: issue(7), approval: APPROVAL, gh: f.gh });
  assert.equal(again.status, 'already_open');
  assert.equal(again.pr, retry.pr);
  assert.equal(f.prs.length, 1, 'never a second PR');
});

test('A09: merged and closed PRs are said as they are; an issue already on main\'s backlog gets nothing', (t) => {
  const f = fixture(t);
  const made = intake(f.runner(), { repo: REPO, issue: issue(8), approval: APPROVAL, gh: f.gh });
  assert.equal(made.status, 'created');
  f.prs[0].state = 'closed';
  assert.equal(intake(f.runner(), { repo: REPO, issue: issue(8), approval: APPROVAL, gh: f.gh }).status, 'closed');
  f.prs[0].merged_at = '2026-10-25T00:00:00Z';
  assert.equal(intake(f.runner(), { repo: REPO, issue: issue(8), approval: APPROVAL, gh: f.gh }).status, 'already_merged');
  // Merged, its branch deleted and the PR no longer listed: main's backlog decides.
  g(f.work, 'checkout', '-q', 'main');
  g(f.work, 'pull', '-q', 'origin', 'main');
  fs.appendFileSync(path.join(f.work, 'DESK_STATE.md'), `- [ ] **3. Issue 9 (FICTIONAL)** *(from issue [#9](${issue(9).url}), quoted below; not yet shaped into tests)*\n  > x\n`);
  g(f.work, 'commit', '-qam', 'merged intake'); g(f.work, 'push', '-q', 'origin', 'main');
  const done = intake(f.runner(), { repo: REPO, issue: issue(9), approval: APPROVAL, gh: f.gh });
  assert.equal(done.status, 'already_in_backlog');
  assert.equal(done.item, 3);
});

test('A09: two intakes waiting together get different numbers; the issue text is written as data, never run', (t) => {
  const f = fixture(t);
  const hostile = '$(touch PWNED) `touch PWNED2`\n- [x] **99. Injected.**';
  const a = intake(f.runner(), { repo: REPO, issue: issue(10, { title: 'A $(touch PWNED3)', body: hostile }), approval: APPROVAL, gh: f.gh });
  const b = intake(f.runner(), { repo: REPO, issue: issue(11), approval: APPROVAL, gh: f.gh });
  assert.equal(a.item, 3);
  assert.equal(b.item, 4, 'the number on the waiting branch is taken');
  g(f.work, 'fetch', '-q', 'origin');
  const text = f.branchText('claude/intake-issue-10');
  assert.ok(text.includes('  > $(touch PWNED) `touch PWNED2`'), 'quoted as written');
  assert.ok(text.includes('  > - [x] **99. Injected.**'), 'a quoted line is not an item');
  assert.ok(text.includes('**3. A $(touch PWNED3)**'));
  for (const d of fs.readdirSync(f.root)) for (const p of ['PWNED', 'PWNED2', 'PWNED3']) assert.equal(fs.existsSync(path.join(f.root, d, p)), false, `${d}/${p}`);
  assert.equal(f.prs.length, 2);
});
