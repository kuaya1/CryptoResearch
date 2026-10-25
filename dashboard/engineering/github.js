'use strict';
// GitHub readback for the engineering inbox (Connected Engineering v1,
// 2026-10-25): what GitHub itself says about an engineering item, read when
// asked and never stored. The worker's own reports are kept apart from this;
// a read that fails, is rate-limited or cannot be matched is "unknown", never
// a pass. Reads only: the pull request for claude/backlog-eng-<n>, the check
// runs on a head, whether main contains the merge, and whether the running
// desk contains it (its own revision against GitHub's compare). The optional
// token (CR_GITHUB_TOKEN, in the environment only) raises the rate limit; it
// is never stored, logged or shown.

const P = require('./policy');
const { readBodyBounded } = require('../core/netguard');

const GITHUB = 'https://api.github.com';
const SHA_RE = /^[0-9a-f]{40}$/;
const TTL_MS = 60000;

function headers(env) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'CryptoResearch-desk/1', 'x-github-api-version': '2022-11-28' };
  const tok = env.CR_GITHUB_TOKEN;
  if (tok && /^[A-Za-z0-9_]{20,255}$/.test(tok)) h.authorization = `Bearer ${tok}`;
  return h;
}

// fetchImpl and clock: tests stub them. revision: the running desk's commit.
function makeGithub({ repo = P.REPO, fetchImpl = globalThis.fetch, clock = () => Date.now(), env = process.env, revision = () => require('../core/revision').revision(), timeoutMs = 10000 } = {}) {
  const cache = new Map();

  async function get(path) {
    const hit = cache.get(path);
    if (hit && hit.until > clock()) return hit.value;
    const url = new URL(path, GITHUB);
    if (url.origin !== GITHUB) throw new Error('Unexpected origin');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let value;
    try {
      const res = await fetchImpl(url.toString(), { headers: headers(env), signal: ctrl.signal, redirect: 'error' });
      const text = await readBodyBounded(res, 2 * 1024 * 1024, ctrl);
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
      value = { status: res.status, body };
    } catch (err) {
      value = { status: 0, body: null, error: err.name === 'AbortError' ? 'timed out' : err.code === 'CR_TOO_LARGE' ? 'answer too large' : 'not reachable' };
    } finally {
      clearTimeout(timer);
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

  async function pullRequest(number) {
    if (!Number.isInteger(number) || number < 1) return { state: 'unknown', why: 'no backlog number' };
    const owner = repo.split('/')[0];
    const r = await get(`/repos/${repo}/pulls?state=all&per_page=10&head=${encodeURIComponent(`${owner}:claude/backlog-eng-${number}`)}`);
    if (r.status !== 200 || !Array.isArray(r.body)) return { state: 'unknown', why: why(r) };
    if (!r.body.length) return { state: 'none' };
    const pr = r.body.sort((a, b) => b.number - a.number)[0];
    return { state: pr.merged_at ? 'merged' : pr.state, number: pr.number, url: pr.html_url, head_sha: pr.head && pr.head.sha, merge_commit_sha: pr.merged_at ? pr.merge_commit_sha : null, merged_at: pr.merged_at || null };
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

  return { readback, checks, contains, pullRequest };
}

module.exports = { makeGithub };
