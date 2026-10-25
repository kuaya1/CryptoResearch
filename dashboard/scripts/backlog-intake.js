#!/usr/bin/env node
'use strict';
// Voice intake (DESK_STATE item 17; .github/workflows/backlog-intake.yml), with
// retries that converge (review A09, 2026-10-25). When Eric labels an issue
// `ready`, one PR adds the issue, quoted and linked, as the next numbered
// backlog item. It builds nothing and never merges: Eric merges it.
//
// Intake is done only when its PR is known, not when its branch exists:
//   - a PR for the issue's branch, open, merged or closed, is said as it is
//     and nothing new is made;
//   - a branch with no PR (the push landed, the PR call failed) gets its PR;
//   - an issue already on main's backlog gets nothing;
//   - otherwise the next number is one more than any on main's backlog or on
//     an open intake branch, so two intakes waiting together never share one.
// The issue text is data: it is written to the file, never run.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE_FILE = 'DESK_STATE.md';
const IDENTITY = { GIT_AUTHOR_NAME: 'backlog-intake', GIT_AUTHOR_EMAIL: 'backlog-intake@users.noreply.github.com', GIT_COMMITTER_NAME: 'backlog-intake', GIT_COMMITTER_EMAIL: 'backlog-intake@users.noreply.github.com' };

function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY }, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 600)}`);
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const itemNumbers = (text) => [...String(text || '').matchAll(/^- \[[ x]\] (?:\*\(Eric\)\* )?\*\*(\d+)\./gm)].map((m) => Number(m[1]));
const branchOf = (number) => `claude/intake-issue-${number}`;
const issueMark = (number, url) => `issue [#${number}](${url})`;

function entryFor(next, { number, title, body, url }) {
  const one = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const quote = String(body || '(no description)').replace(/\r/g, '').trim().split('\n').map((l) => `  > ${l}`).join('\n');
  return `- [ ] **${next}. ${one(title).slice(0, 120)}** *(from ${issueMark(number, url)}, quoted below; not yet shaped into tests)*\n${quote}\n`;
}

// The PRs whose head is the issue's branch, any state.
function prsFor(gh, repo, branch) {
  const owner = repo.split('/')[0];
  return JSON.parse(gh(['api', `repos/${repo}/pulls?state=all&head=${owner}:${branch}`, '--jq', '[.[] | {number, state, merged_at}]']) || '[]');
}

function prBody(issue, item, approval) {
  return `Adds issue #${issue.number}, quoted and linked, as item ${item} of the backlog. It builds nothing. Eric merges it like any PR.\n\nApproval source: ${approval}`;
}

function createPr(gh, repo, branch, issue, item, approval) {
  return Number(gh(['api', '-X', 'POST', `repos/${repo}/pulls`, '-f', `title=Intake: item ${item} from issue #${issue.number}`, '-f', `head=${branch}`, '-f', 'base=main', '-f', `body=${prBody(issue, item, approval)}`, '--jq', '.number']));
}

// cwd: a checkout of main. issue: { number, title, body, url }. approval: the
// event's words (who set the label and when).
function intake(cwd, { repo, issue, approval, gh, remote = 'origin' }) {
  if (!/^\d+$/.test(String(issue.number))) throw new Error('The issue number is not a number.');
  const branch = branchOf(issue.number);
  const prs = prsFor(gh, repo, branch);
  const merged = prs.find((p) => p.merged_at);
  if (merged) return { status: 'already_merged', branch, pr: merged.number };
  const open = prs.find((p) => p.state === 'open');
  if (open) return { status: 'already_open', branch, pr: open.number };
  if (prs.length) return { status: 'closed', branch, pr: prs[0].number, note: 'Its PR was closed without merging; nothing was made again. Re-open that PR, or delete the branch and label the issue again.' };
  git(cwd, ['fetch', '-q', remote, '+refs/heads/main:refs/remotes/intake/main']);
  const remoteBranch = git(cwd, ['ls-remote', '--heads', remote, `refs/heads/${branch}`]).out;
  if (remoteBranch) {
    // The push landed and the PR call did not: make the PR for that branch.
    git(cwd, ['fetch', '-q', remote, `+refs/heads/${branch}:refs/remotes/intake/${branch}`]);
    const msg = git(cwd, ['log', '-1', '--format=%s', `refs/remotes/intake/${branch}`]).out;
    const m = /^intake: item (\d+) from issue #(\d+)$/.exec(msg);
    const text = git(cwd, ['show', `refs/remotes/intake/${branch}:${STATE_FILE}`], { allowFail: true }).out;
    if (!m || Number(m[2]) !== Number(issue.number) || !text.includes(issueMark(issue.number, issue.url))) return { status: 'branch_unexpected', branch, note: `The branch ${branch} exists but does not hold this issue's intake commit; nothing was made. Look at it, then delete it and label the issue again.` };
    const pr = createPr(gh, repo, branch, issue, Number(m[1]), approval);
    return { status: 'pr_created_on_retry', branch, item: Number(m[1]), pr };
  }
  const mainText = git(cwd, ['show', `refs/remotes/intake/main:${STATE_FILE}`]).out;
  if (mainText.includes(issueMark(issue.number, issue.url))) {
    const line = mainText.split('\n').find((l) => l.includes(issueMark(issue.number, issue.url))) || '';
    const n = (/\*\*(\d+)\./.exec(line) || [])[1];
    return { status: 'already_in_backlog', branch, item: n ? Number(n) : null };
  }
  // Numbers waiting on other open intake branches, and on engineering
  // admission branches (Connected Engineering v1), count as taken.
  const taken = new Set(itemNumbers(mainText));
  const others = git(cwd, ['ls-remote', '--heads', remote, 'refs/heads/claude/intake-issue-*', 'refs/heads/claude/admission-*']).out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1].replace('refs/heads/', ''));
  for (const b of others) {
    git(cwd, ['fetch', '-q', remote, `+refs/heads/${b}:refs/remotes/intake/${b}`], { allowFail: true });
    for (const n of itemNumbers(git(cwd, ['show', `refs/remotes/intake/${b}:${STATE_FILE}`], { allowFail: true }).out)) taken.add(n);
  }
  const next = Math.max(0, ...taken) + 1;
  git(cwd, ['checkout', '-q', '-B', branch, 'refs/remotes/intake/main']);
  let text = fs.readFileSync(path.join(cwd, STATE_FILE), 'utf8');
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(path.join(cwd, STATE_FILE), text + entryFor(next, issue));
  git(cwd, ['add', STATE_FILE]);
  git(cwd, ['commit', '-q', '-m', `intake: item ${next} from issue #${issue.number}`]);
  // A plain push: if the branch appeared meanwhile it is refused, and the
  // next run reconciles that branch instead.
  git(cwd, ['push', '-q', remote, `HEAD:refs/heads/${branch}`]);
  try {
    return { status: 'created', branch, item: next, pr: createPr(gh, repo, branch, issue, next, approval) };
  } catch (err) {
    return { status: 'pr_failed', branch, item: next, error: String(err && err.message || err).slice(0, 300), note: 'The branch is pushed; label the issue again (or re-run) to make its PR.' };
  }
}

const DONE = new Set(['created', 'pr_created_on_retry', 'already_open', 'already_merged', 'already_in_backlog', 'closed']);

if (require.main === module) {
  const e = process.env;
  const gh = (args) => {
    const r = spawnSync('gh', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || `gh exited ${r.status}`).trim().slice(0, 300));
    return (r.stdout || '').trim();
  };
  const out = intake(process.cwd(), { repo: e.REPO, issue: { number: e.NUMBER, title: e.TITLE, body: e.BODY, url: e.URL }, approval: `the label \`ready\` was set by @${e.SENDER || 'unknown'} at ${e.LABELED_AT || 'an unknown time'} (run ${e.GITHUB_RUN_ID || 'unknown'}). That is an action of the account; it does not by itself show whether a person or an assistant holding its credential set it.`, gh });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (e.GITHUB_STEP_SUMMARY) fs.appendFileSync(e.GITHUB_STEP_SUMMARY, `### Intake of issue #${e.NUMBER}: ${out.status.replace(/_/g, ' ')}\n\n${out.pr ? `PR #${out.pr}` : 'No PR'}${out.item ? `, item ${out.item}` : ''}. ${out.note || out.error || ''}\n`);
  process.exitCode = DONE.has(out.status) ? 0 : 1;
}

module.exports = { intake, entryFor, itemNumbers, branchOf, DONE };
