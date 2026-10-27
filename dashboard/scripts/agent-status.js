'use strict';
// The agent lane's briefing (Eric, 2026-10-27; audits/2026-10-27-pm-builder):
// what the lane is doing, what merged in the last 24 hours, the candidate
// open now and the next task, with three lines for a phone. It reads GitHub
// only (main's DESK_STATE.md, the ledger branch, the pull requests, the
// agent-build runs and the checks on the open candidate), through the desk's
// read-only client (engineering/github.js repoRead, CR_GITHUB_TOKEN), and
// says what the PM (agent-pm.js decide) would do with that state. It writes
// nothing and stores nothing. A source that cannot be read is "unknown",
// never "none".
//
//   GET /api/system/briefing          (signed in; server.js)
//   node dashboard/cli.js system briefing [--json]
//   the engineering connector's system_briefing tool

const B = require('./agent-backlog');
const L = require('./agent-ledger');
const G = require('./agent-guard');
const PM = require('./agent-pm');

const FORMAT = 'cr-lane-briefing@1';
const DAY_MS = 24 * 3600 * 1000;
const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// The lane's state as agent-pm.js gather reads it, through GitHub's API.
// `read(path)` answers { ok, body } or { ok: false, status, why }.
async function readLane(read, { repo, policy }) {
  const s = { repo, main: null, backlog: null, entries: null, candidates: [], runs: null, pr: null, errors: [], closed: null };
  const fail = (what, r) => s.errors.push(`${what} (${r.why || `HTTP ${r.status}`})`);
  const main = await read(`/repos/${repo}/commits/main`);
  if (main.ok && main.body && G.SHA_RE.test(String(main.body.sha || ''))) s.main = main.body.sha;
  else fail('main', main);
  if (s.main) {
    const f = await read(`/repos/${repo}/contents/${B.FILE}?ref=${s.main}`);
    if (f.ok && f.body && f.body.encoding === 'base64') s.backlog = B.parse(Buffer.from(String(f.body.content || ''), 'base64').toString('utf8'));
    else fail(B.FILE, f.ok ? { why: 'not readable through the contents API' } : f);
    // No ledger branch yet is an empty ledger, as agent-ledger.js reads it.
    const l = await read(`/repos/${repo}/contents/${L.FILE}?ref=agent-ledger`);
    if (l.ok && l.body && l.body.encoding === 'base64') {
      const p = L.parse(Buffer.from(String(l.body.content || ''), 'base64').toString('utf8'));
      if (p.broken) s.errors.push(`the ledger (broken: ${p.broken})`);
      else s.entries = p.entries;
    } else if (!l.ok && l.status === 404) s.entries = [];
    else fail('the ledger', l.ok ? { why: 'too large for the contents API' } : l);
  }
  const open = await read(`/repos/${repo}/pulls?state=open&base=main&per_page=100`);
  if (open.ok && Array.isArray(open.body)) s.candidates = open.body.map((p) => PM.candidateOf(p, { repo, policy })).filter(Boolean).sort((a, b) => a.number - b.number);
  else fail('the open pull requests', open);
  const closed = await read(`/repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50`);
  if (closed.ok && Array.isArray(closed.body)) s.closed = closed.body;
  else s.closed = null;
  const runs = await read(`/repos/${repo}/actions/workflows/${PM.BUILD_WORKFLOW}/runs?per_page=30`);
  if (runs.ok && runs.body && Array.isArray(runs.body.workflow_runs)) s.runs = runs.body.workflow_runs;
  else fail(`the runs of ${PM.BUILD_WORKFLOW}`, runs);
  const c = s.candidates.length === 1 && s.candidates[0].task ? s.candidates[0] : null;
  if (c) {
    const ch = await read(`/repos/${repo}/commits/${c.head}/check-runs?per_page=100&filter=latest`);
    if (ch.ok && ch.body && Array.isArray(ch.body.check_runs)) {
      c.checks = PM.checkStates(ch.body.check_runs);
      const review = ch.body.check_runs.filter((x) => x && x.name === 'agent-review').sort((a, b) => b.id - a.id)[0];
      c.review_title = review && review.output && review.output.title ? cut(review.output.title, 200) : null;
    } else fail(`the checks of #${c.number}`, ch);
    if (c.checks && PM.REQUIRED.every((n) => c.checks[n] === 'success')) {
      const cm = await read(`/repos/${repo}/issues/${c.number}/comments?per_page=100`);
      if (cm.ok && Array.isArray(cm.body)) c.signedOff = cm.body.some((x) => x && x.user && x.user.login === 'github-actions[bot]' && String(x.body || '').includes(PM.signoffMark(c.head)));
      else fail(`the comments on #${c.number}`, cm);
    }
    s.pr = c;
  }
  return s;
}

// The briefing from a state (pure).
function briefing(s, { policy, now = Date.now() }) {
  const d = PM.decide(s, { policy, now });
  const unknown = [...s.errors];
  const tasks = s.backlog && s.backlog.found ? s.backlog.tasks : null;
  const status = s.errors.length ? 'unknown'
    : d.action === 'idle' ? 'idle'
      : d.action === 'block' || d.blocked ? 'blocked'
        : d.action === 'stop' || d.eric ? 'waiting_on_eric' : 'working';

  // Merged in the last 24 hours, by each pull request's merge time (Eric,
  // 2026-10-27): the lane's own candidates. [DONE] rows in DESK_STATE.md are
  // history and never count here.
  let completed = null;
  if (s.closed) {
    const since = now - DAY_MS;
    const prs = s.closed.filter((p) => p && p.merged_at && Date.parse(p.merged_at) >= since && String((p.head && p.head.ref) || '').startsWith('agent/'))
      .map((p) => ({ number: p.number, title: cut(p.title || '', 200), task: B.idOfBranch(p.head.ref, policy.task_branch_prefix), merged_at: p.merged_at, url: p.html_url || null }));
    completed = { count: prs.length, prs };
  } else unknown.push('the pull requests closed lately');

  const c = s.errors.some((e) => /open pull requests/.test(e)) ? undefined : s.candidates[0] || null;
  const current = c === undefined ? null : c && {
    number: c.number, title: c.title, url: c.url, branch: c.branch, head: c.head, task: c.task,
    checks: c.checks || null,
    review: c.checks ? { state: c.checks['agent-review'], title: c.review_title || null } : null,
    signed_off: c.signedOff === undefined ? null : c.signedOff,
  };
  const todos = tasks ? tasks.filter((t) => t.status && t.status.kind === 'todo' && (!c || t.id !== c.task)) : null;
  const next = todos && todos[0] ? { id: todos[0].id, title: todos[0].title, template: todos[0].fields.template || null } : null;

  const nowLine = `Now: ${status === 'unknown' ? `unknown (${cut(s.errors.join('; '), 160)})` : cut(d.why, 220)}.`;
  const doneLine = completed === null ? 'Done in the last 24 h: unknown (the closed pull requests could not be read).'
    : completed.count ? `Done in the last 24 h: ${completed.prs.map((p) => `#${p.number}${p.task ? ` ${p.task}` : ''}`).join(', ')}.` : 'Done in the last 24 h: nothing merged.';
  const nextLine = !s.backlog ? 'Next: unknown (DESK_STATE.md could not be read).'
    : !s.backlog.found ? `Next: none queued (${cut(s.backlog.problems.join('; '), 160)}).` : next ? `Next: ${next.id} · ${cut(next.title, 80)} (${next.template || 'no template'}).` : 'Next: nothing queued after this.';
  return {
    format: FORMAT,
    read_at: new Date(now).toISOString(),
    main: s.main,
    status,
    needs_eric: status === 'unknown' ? null : status === 'waiting_on_eric' || status === 'blocked',
    action: d.action,
    why: d.why,
    completed_today: completed,
    current_pr: c === undefined ? 'unknown' : current,
    next_in_queue: !s.backlog ? 'unknown' : next,
    bullets: [nowLine, doneLine, nextLine],
    unknown,
    source: 'GitHub API, read now; nothing stored',
  };
}

// The desk's briefing: GitHub read through `github` (engineering/github.js
// makeGithub; by default one client per process, with its 60-second cache),
// else everything unknown.
let shared = null;
const sharedGithub = () => (shared = shared || require('../engineering/github').makeGithub());
async function deskBriefing({ github = sharedGithub(), policy = G.loadPolicy(), now = Date.now(), repo = require('../engineering/policy').REPO } = {}) {
  const read = github && github.repoRead ? github.repoRead : async () => ({ ok: false, status: 0, why: 'GitHub readback is not set up on this desk' });
  return briefing(await readLane(read, { repo, policy }), { policy, now });
}

// The briefing as text, for the CLI.
function briefingText(b) {
  const lines = [`Agent lane: ${b.status === 'waiting_on_eric' ? 'waiting on Eric' : b.status}`, ...b.bullets.map((x) => `- ${x}`)];
  if (b.current_pr && typeof b.current_pr === 'object') lines.push(`Candidate: #${b.current_pr.number} ${b.current_pr.title}${b.current_pr.url ? ` · ${b.current_pr.url}` : ''}`);
  if (b.unknown.length) lines.push(`Unknown: ${b.unknown.join('; ')}`);
  lines.push(`Read ${b.read_at} from GitHub; nothing stored.`);
  return lines.join('\n');
}

// node dashboard/scripts/agent-status.js [--json]: reads GitHub with
// CR_GITHUB_TOKEN (or GH_TOKEN) through engineering/github.js.
async function main(argv) {
  const { makeGithub } = require('../engineering/github');
  const token = process.env.CR_GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const b = await deskBriefing({ github: makeGithub({ env: { CR_GITHUB_TOKEN: token } }) });
  process.stdout.write(`${argv.includes('--json') ? JSON.stringify(b, null, 2) : briefingText(b)}\n`);
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`agent-status: ${String((err && err.message) || err).slice(0, 400)}\n`); process.exitCode = 1; });

module.exports = { FORMAT, readLane, briefing, deskBriefing, briefingText, main };
