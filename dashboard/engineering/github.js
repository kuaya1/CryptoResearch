'use strict';
// GitHub readback for the engineering inbox (Connected Engineering v1,
// 2026-10-25): what GitHub itself says about an engineering item, read when
// asked and never stored. The worker's own reports are kept apart from this;
// a read that fails, is rate-limited or cannot be matched is "unknown", never
// a pass. Reads only: the pull request for claude/backlog-eng-<n> or
// claude/candidate-eng-<n> (and whether it proves the item merged), the check
// runs on a head, whether main contains the merge, whether the running desk
// contains it (its own revision against GitHub's compare), and whether main
// holds a task's admission at a commit (2026-10-26), and the agent lane's
// state for its briefing (repoRead, 2026-10-27). The optional
// token (CR_GITHUB_TOKEN, in the environment only) raises the rate limit; it
// is never stored, logged or shown.

const P = require('./policy');
const { readBodyBounded } = require('../core/netguard');
const { engEntryOf } = require('../scripts/backlog-promote');

const GITHUB = 'https://api.github.com';
const SHA_RE = /^[0-9a-f]{40}$/;
const TTL_MS = 60000;

function headers(env) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'CryptoResearch-desk/1', 'x-github-api-version': '2022-11-28' };
  const tok = env.CR_GITHUB_TOKEN;
  if (tok && /^[A-Za-z0-9_]{20,255}$/.test(tok)) h.authorization = `Bearer ${tok}`;
  return h;
}

// A read that GitHub could not answer for a passing reason (not reachable, a
// 502, 503 or 504) is asked again after 1 s, 2 s and 4 s; a timeout has
// already waited and is not (2026-10-26).
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const TRANSIENT = new Set([502, 503, 504]);

// fetchImpl, clock and sleep: tests stub them. revision: the running desk's commit.
function makeGithub({ repo = P.REPO, fetchImpl = globalThis.fetch, clock = () => Date.now(), env = process.env, revision = () => require('../core/revision').revision(), timeoutMs = 10000, retryDelaysMs = RETRY_DELAYS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const cache = new Map();

  async function getOnce(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), { headers: headers(env), signal: ctrl.signal, redirect: 'error' });
      const text = await readBodyBounded(res, 2 * 1024 * 1024, ctrl);
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
      return { status: res.status, body };
    } catch (err) {
      return { status: 0, body: null, error: err.name === 'AbortError' ? 'timed out' : err.code === 'CR_TOO_LARGE' ? 'answer too large' : 'not reachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function get(path) {
    const hit = cache.get(path);
    if (hit && hit.until > clock()) return hit.value;
    const url = new URL(path, GITHUB);
    if (url.origin !== GITHUB) throw new Error('Unexpected origin');
    let value = await getOnce(url);
    for (const ms of retryDelaysMs) {
      if (!(TRANSIENT.has(value.status) || value.error === 'not reachable')) break;
      await sleep(ms);
      value = await getOnce(url);
    }
    if (value.status === 200) cache.set(path, { value, until: clock() + TTL_MS });
    return value;
  }
  const why = (r) => (r.status === 0 ? `GitHub ${r.error}` : r.status === 403 || r.status === 429 ? 'GitHub rate limit' : `GitHub answered ${r.status}`);

  // Whether `head` contains `base` (GitHub's compare of base...head).
  async function contains(base, head) {
    if (!SHA_RE.test(String(base || '')) || !head) return { state: 'unknown', why: 'no commit to compare' };
    const r = await get(`/repos/${repo}/compare/${base}...${encodeURIComponent(head)}`);
    if (r.status !== 200 || !r.body) return { state: 'unknown', why: why(r) };
    const s = r.body.status;
    if (s === 'identical' || s === 'ahead') return { state: 'yes' };
    if (s === 'behind' || s === 'diverged') return { state: 'no', status: s };
    return { state: 'unknown', why: `compare status ${s}` };
  }

  // The full commit a SHA or an abbreviated one names (GitHub resolves a
  // prefix as git does); never a branch or tag name, which moves.
  async function commit(rev) {
    if (!/^[0-9a-f]{7,40}$/.test(String(rev || ''))) return { state: 'none', why: 'not a commit SHA' };
    const r = await get(`/repos/${repo}/commits/${rev}`);
    if (r.status === 200 && r.body && SHA_RE.test(String(r.body.sha || ''))) return { state: 'found', sha: r.body.sha };
    if (r.status === 404 || r.status === 422) return { state: 'none', why: `GitHub knows no commit ${String(rev).slice(0, 12)}` };
    return { state: 'unknown', why: why(r) };
  }

  // One file's text at one commit (the contents API).
  async function fileAt(file, sha) {
    if (!SHA_RE.test(String(sha || ''))) return { state: 'unknown', why: 'no commit' };
    const r = await get(`/repos/${repo}/contents/${file}?ref=${sha}`);
    if (r.status === 200 && r.body && r.body.encoding === 'base64' && typeof r.body.content === 'string') return { state: 'found', text: Buffer.from(r.body.content, 'base64').toString('utf8') };
    if (r.status === 404) return { state: 'none', why: `${file} is not at ${sha.slice(0, 12)}` };
    return { state: 'unknown', why: why(r) };
  }

  // Whether main holds a task's admission at a commit (a SHA or a prefix of
  // one): the commit is on main, and DESK_STATE.md there holds the task's
  // entry, returned so the inbox compares it with the bound entry.
  async function admissionAt(rev, taskId) {
    const c = await commit(rev);
    if (c.state !== 'found') return { state: c.state === 'none' ? 'no' : 'unknown', why: c.why };
    const on = await contains(c.sha, 'main');
    if (on.state !== 'yes') return { state: on.state, main_sha: c.sha, why: on.state === 'no' ? `${c.sha.slice(0, 12)} is not on main` : on.why };
    const f = await fileAt('DESK_STATE.md', c.sha);
    if (f.state !== 'found') return { state: f.state === 'none' ? 'no' : 'unknown', main_sha: c.sha, why: f.why };
    const e = engEntryOf(f.text, taskId);
    if (!e) return { state: 'no', main_sha: c.sha, why: `DESK_STATE.md at ${c.sha.slice(0, 12)} holds no entry for ${taskId}` };
    return { state: 'yes', main_sha: c.sha, entry: e.entry, entry_sha256: P.sha256(e.entry), number: e.number };
  }

  // The commit on main that landed a task's admission, found by the title
  // the admission workflow gives it among main's changes to DESK_STATE.md
  // since the number was bound (the oldest, should there be two). The title
  // only finds it; admissionAt proves it.
  async function findAdmissionCommit({ number, task, version, since = null }) {
    const title = `admission: backlog item ${number} for ${task} v${version}`;
    const after = since && Number.isFinite(Date.parse(since)) ? `&since=${encodeURIComponent(new Date(Date.parse(since) - 3600 * 1000).toISOString())}` : '';
    const r = await get(`/repos/${repo}/commits?sha=main&path=DESK_STATE.md&per_page=100${after}`);
    if (r.status !== 200 || !Array.isArray(r.body)) return { state: 'unknown', why: why(r) };
    const hits = r.body.filter((x) => x && x.commit && SHA_RE.test(String(x.sha || '')) && String(x.commit.message || '').split('\n')[0] === title);
    return hits.length ? { state: 'found', sha: hits[hits.length - 1].sha } : { state: 'none', why: `no commit titled "${title}" on main` };
  }

  async function checks(headSha) {
    if (!SHA_RE.test(String(headSha || ''))) return { state: 'unknown', why: 'no head' };
    const r = await get(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.check_runs)) return { state: 'unknown', why: why(r) };
    const runs = r.body.check_runs.map((c) => ({ name: String(c.name || '').slice(0, 80), status: c.status, conclusion: c.conclusion || null }));
    if (!runs.length) return { state: 'pending', runs, why: 'no check run on this head yet' };
    const state = runs.some((c) => c.status !== 'completed') ? 'pending'
      : runs.every((c) => ['success', 'neutral', 'skipped'].includes(c.conclusion)) ? 'success' : 'failure';
    return { state, runs, complete: r.body.total_count === undefined || r.body.total_count <= runs.length };
  }

  // Every pull request from an item's branches: claude/backlog-eng-<n>, which
  // backlog-pr promotes, and claude/candidate-eng-<n>, which Eric may merge
  // himself (items 63 and 64, 2026-10-26). Merged first, then the newest.
  // A branch GitHub could not be asked about makes the answer partial.
  const BRANCHES = (n) => [`claude/backlog-eng-${n}`, `claude/candidate-eng-${n}`];
  async function pullRequests(number) {
    if (!Number.isInteger(number) || number < 1) return { state: 'unknown', why: 'no backlog number', prs: [] };
    const owner = repo.split('/')[0];
    const prs = [];
    const failed = [];
    for (const branch of BRANCHES(number)) {
      const r = await get(`/repos/${repo}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      if (r.status !== 200 || !Array.isArray(r.body)) { failed.push(`${branch}: ${why(r)}`); continue; }
      for (const pr of r.body) prs.push({ state: pr.merged_at ? 'merged' : pr.state, number: pr.number, url: pr.html_url, branch, head_sha: pr.head && pr.head.sha, merge_commit_sha: pr.merged_at ? pr.merge_commit_sha : null, merged_at: pr.merged_at || null });
    }
    prs.sort((a, b) => Number(b.state === 'merged') - Number(a.state === 'merged') || b.number - a.number);
    return { state: failed.length === BRANCHES(number).length ? 'unknown' : failed.length ? 'partial' : prs.length ? 'found' : 'none', why: failed.length ? failed.join('; ') : null, prs };
  }
  async function pullRequest(number) {
    const all = await pullRequests(number);
    if (!all.prs.length) return all.state === 'none' ? { state: 'none', branches: BRANCHES(number) } : { state: 'unknown', why: all.why };
    return { ...all.prs[0], others: all.prs.slice(1).map((p) => ({ number: p.number, state: p.state, branch: p.branch })), partial: all.state === 'partial' ? all.why : null };
  }

  // Whether GitHub proves an item merged (2026-10-26, convergence): a merged
  // pull request from one of its branches whose head is a head the desk
  // recorded (the candidate, or the release pushed from it), and main holding
  // that head. A branch name alone proves nothing, and a squash merge (main
  // without the head) is not proof. The merge commit is kept only when main
  // holds it too. 'unknown' when GitHub could not answer; 'no' with why.
  async function mergeProof({ number, heads = [] } = {}) {
    const wanted = heads.filter((h) => SHA_RE.test(String(h || '')));
    if (!wanted.length) return { state: 'no', why: 'no recorded head' };
    const all = await pullRequests(number);
    const pr = all.prs.find((p) => p.state === 'merged' && wanted.includes(p.head_sha));
    if (!pr) {
      if (all.state === 'unknown' || all.state === 'partial') return { state: 'unknown', why: all.why };
      const other = all.prs.find((p) => p.state === 'merged');
      return { state: 'no', why: other ? `PR #${other.number} merged ${String(other.head_sha || '').slice(0, 12)}, not the recorded head` : all.prs.length ? `no merged pull request (${all.prs.map((p) => `#${p.number} ${p.state}`).join(', ')})` : 'no pull request' };
    }
    const on = await contains(pr.head_sha, 'main');
    if (on.state !== 'yes') return { state: on.state === 'no' ? 'no' : 'unknown', why: on.state === 'no' ? `main does not hold ${pr.head_sha.slice(0, 12)} (PR #${pr.number})` : on.why };
    const mc = SHA_RE.test(String(pr.merge_commit_sha || '')) ? await contains(pr.merge_commit_sha, 'main') : { state: 'unknown' };
    return { state: 'yes', number, pr_number: pr.number, pr_url: pr.url, branch: pr.branch, head_sha: pr.head_sha, main_sha: mc.state === 'yes' ? pr.merge_commit_sha : null, merged_at: pr.merged_at };
  }

  // Everything GitHub says about one task's item, in one answer.
  async function readback({ number = null, head_sha = null, merge_sha = null } = {}) {
    const at = new Date(clock()).toISOString();
    const pr = await pullRequest(number);
    const merged = merge_sha || (pr.state === 'merged' ? pr.merge_commit_sha : null);
    const rev = revision() || {};
    const [check, onMain, deployed] = await Promise.all([
      checks(head_sha),
      merged ? contains(merged, 'main') : Promise.resolve({ state: 'unknown', why: 'not merged' }),
      merged && rev.commit && SHA_RE.test(rev.commit) ? contains(merged, rev.commit) : Promise.resolve({ state: 'unknown', why: merged ? 'the running revision is unknown' : 'not merged' }),
    ]);
    return {
      read_at: at,
      source: 'GitHub API, read now; not stored',
      pull_request: pr,
      checks_on_head: { head_sha, ...check },
      main_contains_merge: onMain,
      deployed: { running_revision: rev.commit || null, contains_merge: deployed },
    };
  }

  // One read of this repository's API, for the agent lane's briefing
  // (scripts/agent-status.js, 2026-10-27): { ok, body }, or { ok: false,
  // status, why }. Nothing outside /repos/<this repository>/ is asked.
  async function repoRead(p) {
    if (!String(p).startsWith(`/repos/${repo}/`)) return { ok: false, status: 0, why: 'not this repository' };
    const r = await get(p);
    return r.status === 200 ? { ok: true, body: r.body } : { ok: false, status: r.status, why: why(r) };
  }

  return { readback, checks, contains, pullRequest, pullRequests, mergeProof, commit, fileAt, admissionAt, findAdmissionCommit, repoRead };
}

module.exports = { makeGithub };
