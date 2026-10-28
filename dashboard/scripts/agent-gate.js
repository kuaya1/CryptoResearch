'use strict';
// The release gate (hardening P1, 2026-10-27;
// audits/2026-10-27-final-hardening). The checks main-merge-requirements
// requires (test, agent-guard, agent-verify, agent-review) are pinned to
// GitHub Actions (app 15368), and any workflow file a pull request adds or
// edits posts as GitHub Actions too, under any name it likes (F2). The gate is
// one more check, release-gate, posted with its own GitHub App, whose key
// lives in an environment only main's workflows can use; the ruleset requires
// release-gate by that App's ID, so no workflow token can post it. It runs
// main's code only and trusts no check by its name:
//
//   test, agent-guard, agent-verify
//          the job of that name in this head's pull_request run of main's
//          workflow file at that path (test.yml, agent-checks.yml), read
//          from the Actions API, completed with success. A pull request that
//          changes a workflow or action definition makes them its own: then
//          only Eric's review of this exact head clears it.
//   review Eric's receipt of this head (agent-owner-review.js: his
//          "/reviewed <head>" comment or his approval at it, or one that
//          carries over "Update branch"), or the model's pass for this head
//          in the ledger with a valid MAC (AGENT_LEDGER_KEY), or one that
//          carries over. The agent-review check itself is not evidence.
//
//   run      one pull request (its live head, or --head when it still is)
//   sweep    every open pull request to main
//   ruleset  print main-merge-requirements with release-gate required from
//            the gate App (--app-id), for Eric to apply
//
// Off until RELEASE_GATE_ENABLED is "true" (a variable, Eric's; the workflow
// reads it). It merges, approves and pays for nothing.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./agent-ledger');
const OR = require('./agent-owner-review');

const CHECK = 'release-gate';
const SHA_RE = /^[0-9a-f]{40}$/;
// Each required check, by the job that produces it and main's file.
const JOBS = [
  { name: 'test', path: '.github/workflows/test.yml' },
  { name: 'agent-guard', path: '.github/workflows/agent-checks.yml' },
  { name: 'agent-verify', path: '.github/workflows/agent-checks.yml' },
];
// A change here makes the jobs above the pull request's own definitions.
const DEFINITION_RE = /^\.github\/(workflows|actions)\//;
const oneLine = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { status: r.status, out: String(r.stdout || '').trim() };
}

// Reads with the job's own token; the one write, the check, with the gate
// App's.
function github({ token, postToken, repo, fetchImpl }) {
  const call = async (tok, method, p, body) => {
    const res = await fetchImpl(`https://api.github.com${p}`, { method, headers: { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: res.status, json };
  };
  const get = (p) => call(token, 'GET', p);
  // Every page of a list (`key` names it inside an object), or null.
  const all = async (p, key = null) => {
    const out = [];
    for (let page = 1; page <= 10; page += 1) {
      const r = await get(`${p}${p.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const list = r.status === 200 && r.json ? (key ? r.json[key] : r.json) : null;
      if (!Array.isArray(list)) return null;
      out.push(...list);
      if (list.length < 100) return out;
    }
    return null;
  };
  return {
    pull: async (n) => { const r = await get(`/repos/${repo}/pulls/${n}`); return r.status === 200 ? r.json : null; },
    openPulls: () => all(`/repos/${repo}/pulls?state=open&base=main`),
    comments: (n) => all(`/repos/${repo}/issues/${n}/comments`),
    reviews: (n) => all(`/repos/${repo}/pulls/${n}/reviews`),
    runs: (sha) => all(`/repos/${repo}/actions/runs?head_sha=${sha}&event=pull_request`, 'workflow_runs'),
    jobs: (id) => all(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, 'jobs'),
    checks: (sha) => all(`/repos/${repo}/commits/${sha}/check-runs?check_name=${CHECK}&filter=latest`, 'check_runs'),
    post: async (o) => { const r = await call(postToken, 'POST', `/repos/${repo}/check-runs`, o); return { ok: r.status === 201, status: r.status }; },
  };
}

// One required job on this head: the latest pull_request run of main's file
// at its path for this pull request, and the job of that name in it.
async function jobState(gh, runs, { repo, pr, head }, job) {
  const mine = runs.filter((r) => String(r.path || '').replace(/@.*$/, '') === job.path && r.event === 'pull_request' && r.head_sha === head
    && r.repository && r.repository.full_name === repo && r.head_repository && r.head_repository.full_name === repo
    && (r.pull_requests || []).some((p) => p.number === pr)).sort((a, b) => b.id - a.id);
  const run = mine[0];
  if (!run) return { name: job.name, state: 'missing', why: `no pull_request run of ${job.path} for this head` };
  const jobs = await gh.jobs(run.id);
  if (!jobs) return { name: job.name, state: 'unreadable', why: `the jobs of run ${run.id} could not be read` };
  const j = jobs.filter((x) => x.name === job.name && x.head_sha === head).sort((a, b) => b.id - a.id)[0];
  if (!j) return { name: job.name, state: 'missing', why: `run ${run.id} of ${job.path} has no job ${job.name}` };
  if (j.status !== 'completed') return { name: job.name, state: 'pending', why: `${job.name} is ${j.status} (run ${run.id})` };
  return { name: job.name, state: j.conclusion || 'unknown', why: `${job.name} ${j.conclusion} (run ${run.id} of ${job.path})` };
}

// The model's verdict for this head as the ledger holds it, signed: the
// latest signed verdict on this exact head decides; with none, a pass given
// an earlier head of this pull request that carries over to it.
function modelPass(entries, { key, repo, pr, head, cwd, base }) {
  const signed = L.attempts(entries).filter((a) => a.reserve.kind === 'review' && a.reserve.bind && a.reserve.bind.repo === repo && a.reserve.bind.pr === pr
    && a.response && a.response.verdict && a.posted.length && L.macOk(key, { ...a.response, binding: a.reserve.binding }));
  const exact = signed.filter((a) => a.reserve.bind.head === head);
  if (exact.length) {
    const a = exact[exact.length - 1];
    return a.response.verdict.result === 'pass' ? { attempt: a.id, from: head } : { attempt: a.id, from: head, result: a.response.verdict.result };
  }
  for (const a of [...signed].reverse()) {
    if (a.response.verdict.result !== 'pass') continue;
    const c = OR.carriesOver(cwd, { from: a.reserve.bind.head, to: head, base });
    if (c.ok) return { attempt: a.id, from: a.reserve.bind.head, carried: c };
  }
  return null;
}

const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'skipped', 'neutral', 'unknown']);

// The gate's answer for one head: { conclusion, title, summary }.
function decide({ head, owner, jobs, defs, st, ignored, model, keyless }) {
  const h12 = head.slice(0, 12);
  const jobLines = jobs.map((j) => `- ${j.why}`).join('\n');
  const notCounted = ignored && ignored.length ? `\n\nNot counted: ${ignored.map((i) => `comment ${i.id} (${i.why})`).join('; ')}.` : '';
  const out = (conclusion, title, body) => ({ conclusion, title: oneLine(title, 200), summary: `${body}\n\nThe required jobs, read from the Actions API:\n${jobLines}${notCounted}\n\nThe gate merges, approves and pays for nothing; Eric merges.` });
  const failed = jobs.filter((j) => FAILED.has(j.state));
  if (failed.length) return out('failure', `Failed: ${failed.map((j) => j.name).join(', ')} did not pass`, 'A required job did not pass on this head.');
  const waiting = jobs.filter((j) => j.state !== 'success');
  if (waiting.length) return out('action_required', `Waiting: ${waiting.map((j) => `${j.name} ${j.state}`).join(', ')}`, `The gate runs again when they finish.\n\n${OR.HOW(head)}`);
  const ownerOk = st.state === 'owner_override';
  const byOwner = ownerOk ? (st.carried ? `${owner}'s review of ${st.receipt.head.slice(0, 12)}, which carries over (${OR.carriedWords(st.carried)})` : `${owner}'s review of this head (${st.receipt.kind === 'approve' ? 'approving review' : 'comment'} ${st.receipt.id})`) : null;
  if (defs.length) {
    if (ownerOk) return out('success', `Cleared by ${owner}'s review: this change edits workflow definitions`, `This pull request changes ${defs.map((f) => `\`${f}\``).join(', ')}, so the jobs above ran from its own definitions. ${byOwner} is the evidence that they are what they claim.`);
    return out('action_required', st.state === 'invalidated' ? `Invalidated by a new commit: ${owner} reviewed ${st.reviewed.slice(0, 12)}, the head is ${h12}` : `Missing: this change edits workflow definitions, so only ${owner}'s review of ${h12} clears it`,
      `This pull request changes ${defs.map((f) => `\`${f}\``).join(', ')}: the jobs above ran from its own definitions and prove nothing by themselves. A model's review does not stand in here.${st.state === 'invalidated' ? `\n\n${st.why.join('; ')}.` : ''}\n\n${OR.HOW(head)}`);
  }
  if (ownerOk) return out('success', `Cleared: the required jobs passed from main's workflow files; ${owner} reviewed ${st.carried ? `${st.receipt.head.slice(0, 12)}, carried over` : h12}`, `Review: ${byOwner}.`);
  if (model && !model.result) return out('success', `Cleared: the required jobs passed from main's workflow files; the model passed ${model.carried ? `${model.from.slice(0, 12)}, carried over` : h12}`, `Review: the ledger's signed pass, attempt \`${model.attempt}\`${model.carried ? `, given for ${model.from.slice(0, 12)} and covering this head (${OR.carriedWords(model.carried)})` : ''}.`);
  if (model && model.result) return out('failure', `Failed: the model's review of ${h12} is ${model.result.replace(/_/g, ' ')}`, `The ledger's signed verdict for this head, attempt \`${model.attempt}\`, is ${model.result}. ${owner}'s own review of this head can stand in for it.\n\n${OR.HOW(head)}`);
  const why = st.state === 'invalidated' ? `\n\n${st.why.join('; ')}.` : '';
  return out('action_required', st.state === 'invalidated' ? `Invalidated by a new commit: ${owner} reviewed ${st.reviewed.slice(0, 12)}, the head is ${h12}` : `Missing: no review of ${h12}`,
    `No signed model pass and no review by ${owner} covers this head${keyless ? ' (AGENT_LEDGER_KEY is not set in the environment, so no model pass can be read)' : ''}.${why}\n\n${OR.HOW(head)}`);
}

// The gate on one pull request. Returns { status, says, pr, head }.
async function gateHead({ pr, head = null, env = process.env, cwd = process.cwd(), remote = 'origin', fetchImpl = globalThis.fetch, runUrl = null }) {
  const repo = env.GITHUB_REPOSITORY;
  const owner = env.GITHUB_REPOSITORY_OWNER || String(repo || '').split('/')[0] || null;
  const gh = github({ token: env.GITHUB_TOKEN, postToken: env.GATE_TOKEN, repo, fetchImpl });
  const say = (status, says) => ({ status, says, pr, head });
  if (!env.GATE_TOKEN) return say('not_configured', 'The gate App\'s token is missing (GATE_APP_ID, GATE_APP_KEY in the release-gate environment); nothing posted.');
  const p = await gh.pull(pr);
  if (!p) return say('unreadable', `Pull request #${pr} could not be read; nothing posted.`);
  if (p.state !== 'open') return say('skipped', `#${pr} is ${p.state}; nothing posted.`);
  if (p.base.ref !== 'main') return say('skipped', `#${pr} targets ${p.base.ref}; nothing posted.`);
  if (head && p.head.sha !== head) return say('skipped', `#${pr} is at ${String(p.head.sha).slice(0, 12)}, not ${head.slice(0, 12)}; the run for the newer head gates it.`);
  head = p.head.sha;
  if (!SHA_RE.test(String(head))) return say('unreadable', `#${pr} has no readable head; nothing posted.`);
  const f = git(cwd, ['fetch', '-q', '--no-tags', remote, `+refs/heads/main:refs/remotes/${remote}/main`, `+refs/pull/${pr}/head:refs/remotes/pr/${pr}`]);
  if (f.status !== 0 || git(cwd, ['rev-parse', '--verify', '-q', `${head}^{commit}`]).out !== head) return say('unreadable', `${head.slice(0, 12)} could not be fetched; nothing posted.`);
  const base = `refs/remotes/${remote}/main`;
  const mb = git(cwd, ['merge-base', base, head]);
  const names = mb.status === 0 ? git(cwd, ['diff', '--name-only', '--no-renames', mb.out, head]) : mb;
  if (names.status !== 0) return say('unreadable', `The files #${pr} changes could not be listed; nothing posted.`);
  const defs = names.out.split('\n').filter((x) => DEFINITION_RE.test(x));

  const runs = await gh.runs(head);
  if (!runs) return say('unreadable', `The workflow runs of ${head.slice(0, 12)} could not be read; nothing posted.`);
  const jobs = [];
  for (const j of JOBS) jobs.push(await jobState(gh, runs, { repo, pr, head }, j));
  if (jobs.some((j) => j.state === 'unreadable')) return say('unreadable', jobs.filter((j) => j.state === 'unreadable').map((j) => j.why).join('; '));

  const [comments, reviews] = [await gh.comments(pr), await gh.reviews(pr)];
  if (!comments || !reviews) return say('unreadable', `The comments and reviews of #${pr} could not be read; nothing posted.`);
  const { receipts, ignored } = OR.receiptsOf({ comments, reviews, owner });
  const st = OR.ownerState({ cwd, base, head, receipts });
  const key = L.ledgerKey(env);
  let model = null;
  if (key && !defs.length) {
    const held = L.read(cwd, { remote });
    if (held.error) return say('unreadable', `${held.error}; nothing posted.`);
    model = modelPass(held.entries, { key, repo, pr, head, cwd, base });
  }
  const d = decide({ head, owner: owner || 'the owner', jobs, defs, st, ignored, model, keyless: !key });
  const now = (await gh.checks(head) || []).filter((c) => c.name === CHECK && (!env.GATE_APP_ID || (c.app && String(c.app.id) === String(env.GATE_APP_ID)))).sort((a, b) => b.id - a.id)[0];
  if (now && now.status === 'completed' && now.conclusion === d.conclusion && now.output && now.output.title === d.title && now.output.summary === d.summary) return say('unchanged', `${d.title} (already posted).`);
  const r = await gh.post({ name: CHECK, head_sha: head, status: 'completed', conclusion: d.conclusion, details_url: runUrl || undefined, output: { title: d.title, summary: d.summary.slice(0, 60000) } });
  if (!r.ok) throw new Error(`the ${CHECK} check could not be posted (HTTP ${r.status})`);
  return say(d.conclusion === 'success' ? 'cleared' : d.conclusion === 'failure' ? 'failed' : 'held', `${d.title}.`);
}

async function sweep({ env = process.env, cwd = process.cwd(), remote = 'origin', fetchImpl = globalThis.fetch, runUrl = null }) {
  const gh = github({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl });
  const pulls = await gh.openPulls();
  if (!pulls) return [{ status: 'unreadable', says: 'The open pull requests could not be read; nothing posted.' }];
  const out = [];
  for (const p of pulls) out.push(await gateHead({ pr: p.number, head: p.head && p.head.sha, env, cwd, remote, fetchImpl, runUrl }));
  return out;
}

// The ruleset Eric applies once the gate posts: main-merge-requirements as
// the repository holds it, with release-gate required from the gate App
// (`appId`, never GitHub Actions). The repository's file stays the rollback.
function rulesetAfter(before, appId) {
  const id = Number(appId);
  if (!Number.isInteger(id) || id < 1 || id === 15368) throw new Error('the gate App\'s ID: a positive integer, never GitHub Actions (15368)');
  const after = JSON.parse(JSON.stringify(before));
  const rule = (after.rules || []).find((r) => r.type === 'required_status_checks');
  if (!rule) throw new Error('main-merge-requirements has no required_status_checks rule');
  const list = rule.parameters.required_status_checks;
  if (list.some((c) => c.context === CHECK)) throw new Error(`${CHECK} is already required`);
  list.push({ context: CHECK, integration_id: id });
  return after;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, '')] = rest[i + 1];
  const env = process.env;
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const summary = (text) => { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n\n`); process.stdout.write(`${text}\n`); };
  if (cmd === 'run') {
    const pr = Number(flags.pr);
    if (!Number.isInteger(pr) || pr < 1 || (flags.head && !SHA_RE.test(flags.head))) { summary('No pull request to gate.'); return 0; }
    const r = await gateHead({ pr, head: flags.head || null, runUrl });
    summary(`#${pr}: ${r.says}`);
    return ['unreadable', 'not_configured'].includes(r.status) ? 1 : 0;
  }
  if (cmd === 'sweep') {
    const rs = await sweep({ runUrl });
    summary(rs.length ? rs.map((r) => `- ${r.pr ? `#${r.pr} ` : ''}${r.says}`).join('\n') : 'No open pull request to gate.');
    return rs.some((r) => ['unreadable', 'not_configured'].includes(r.status)) ? 1 : 0;
  }
  if (cmd === 'ruleset') {
    const before = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'rulesets', 'main-merge-requirements.json'), 'utf8'));
    process.stdout.write(`${JSON.stringify(rulesetAfter(before, flags['app-id']), null, 2)}\n`);
    return 0;
  }
  process.stderr.write('Usage: agent-gate.js run --pr <n> [--head <sha>] | sweep | ruleset --app-id <gate App ID>\n');
  return 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (err) => { process.stderr.write(`agent-gate: ${oneLine(err && err.message, 400)}\n`); process.exitCode = 1; });

module.exports = { CHECK, JOBS, DEFINITION_RE, jobState, modelPass, decide, gateHead, sweep, rulesetAfter, main };
