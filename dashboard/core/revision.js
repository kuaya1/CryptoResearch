'use strict';
// Which code is running, so a review (or Eric) can tell the deployed revision
// from the repository: on Render, the commit it deployed (RENDER_GIT_COMMIT,
// RENDER_GIT_BRANCH, set by Render for every deploy); on the PC, the Git
// checkout the code runs from (read from .git, no git program needed).
// Nothing secret: a commit ID and a branch name.

const fs = require('fs');
const path = require('path');

const CODE_DIR = path.resolve(__dirname, '..', '..');
const STARTED_AT = new Date().toISOString();
let cached = null;

function readGitHead(dir = CODE_DIR) {
  try {
    const gitDir = path.join(dir, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return { commit: head, branch: null };
    const m = head.match(/^ref: refs\/heads\/(.+)$/);
    if (!m) return null;
    const ref = `refs/heads/${m[1]}`;
    try {
      const sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return { commit: sha, branch: m[1] };
    } catch (_) { /* packed */ }
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    const sha = line ? line.split(' ')[0] : null;
    return sha && /^[0-9a-f]{40}$/.test(sha) ? { commit: sha, branch: m[1] } : null;
  } catch (_) {
    return null;
  }
}

function revision(env = process.env) {
  if (cached && env === process.env) return cached;
  const commit = env.RENDER_GIT_COMMIT && /^[0-9a-f]{7,40}$/i.test(env.RENDER_GIT_COMMIT) ? env.RENDER_GIT_COMMIT.toLowerCase() : null;
  const git = commit ? null : readGitHead();
  const out = commit
    ? { commit, short: commit.slice(0, 7), branch: env.RENDER_GIT_BRANCH || null, source: 'render', started_at: STARTED_AT }
    : git
      ? { commit: git.commit, short: git.commit.slice(0, 7), branch: git.branch, source: 'git', started_at: STARTED_AT }
      : { commit: null, short: null, branch: null, source: 'unknown', started_at: STARTED_AT };
  if (env === process.env) cached = out;
  return out;
}

function revisionLine(r = revision()) {
  return r.commit ? `${r.short}${r.branch ? ` (${r.branch})` : ''}, from ${r.source === 'render' ? 'the Render deploy' : 'the Git checkout'}` : 'unknown (no deploy or Git information)';
}

module.exports = { revision, revisionLine, readGitHead };
