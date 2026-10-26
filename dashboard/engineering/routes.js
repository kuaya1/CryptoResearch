'use strict';
// The engineering inbox's HTTP routes (Connected Engineering v1, 2026-10-25;
// moved out of dashboard/server.js on Eric's decision on review finding 2):
// the /mcp/engineering connector, the public admission and attestation reads
// the workflows check, and Eric's own /api/engineering decisions. They live
// under dashboard/engineering/, which backlog-promote.js PROTECTED holds for
// Eric, so a branch that changes them never merges on its own;
// dashboard/server.js only mounts them, and promotion holds a server.js
// change that touches that mount.

const { OpError } = require('../core/ops');
const inbox = require('./inbox');

const OWNER = { kind: 'owner' };
const ENG_CONFLICT = new Set(['PAUSED', 'CLAIMED', 'STALE_VERSION', 'HASH_MISMATCH', 'WRONG_STATE', 'WRONG_CANDIDATE', 'NOT_EDITABLE', 'EDIT_AFTER_ADMISSION', 'CEILING', 'NOT_CLAIMABLE', 'HELD', 'UNSUPPORTED_SCHEMA', 'NOT_REBINDABLE', 'AUTHORIZATION_HOLDS', 'MERGE_STATE_UNREAD', 'MERGE_STATE_UNKNOWN', 'NO_FIT', 'NOT_ACTIVE', 'GITHUB_UNKNOWN', 'NOT_ON_MAIN']);
const PUBLIC_READ_RE = /^\/engineering\/(?:admissions\/(eng-\d{8}-[0-9a-f]{6})|attestations\/([0-9a-f]{40}))$/;

// oauth and auth are null on this PC (no connector, no sign-in); HttpError
// and readCodes are the server's own, so errors read as every other route's.
function makeEngineeringRoutes(ws, { oauth = null, auth = null, origins = new Set(), version = '1.0.0', log = () => {}, github = null, HttpError, readCodes = new Set() } = {}) {
  const engMcp = oauth ? require('./tools').makeEngineeringMcp(ws, { version, log, github }) : null;

  // /mcp/engineering, with its own OAuth resource and one role per
  // connection; none of the desk's research, ticket or portfolio tools.
  async function connector(req, res, url) {
    if (!oauth || (url.pathname !== '/mcp/engineering' && url.pathname !== '/mcp/engineering/')) return false;
    const o = req.headers.origin;
    if (o && !origins.has(o)) {
      log(`MCP engineering request refused: Origin ${String(o).slice(0, 80)} is not allowed`);
      throw new HttpError(403, 'Origin not allowed');
    }
    const grant = oauth.authenticate(req, { audience: 'engineering' });
    if (!grant) {
      log(`MCP engineering sign-in needed: ${oauth.refusal(req, { audience: 'engineering' })}`);
      oauth.challenge(res, { invalid: Boolean(req.headers.authorization), audience: 'engineering' });
      return true;
    }
    await engMcp(req, res, grant);
    return true;
  }

  // What the engineering-admission and backlog-pr workflows check
  // (backlog-promote.js): public and read-only, with no private content
  // (task IDs, hashes, backlog numbers, paths, states and reason codes only).
  function publicRead(req, res, url) {
    const m = PUBLIC_READ_RE.exec(url.pathname);
    if (!m) return false;
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    const v = m[1] ? inbox.admissionView(ws, m[1]) : inbox.attestationView(ws, m[2]);
    res.writeHead(v ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(v || { error: 'Not found' }));
    return true;
  }

  // Preferences > Developer > Engineering: Eric's own decisions, behind the
  // desk's sign-in. Activating a delegation and authorizing a task take his
  // passphrase again on the online desk.
  function mount(route) {
    const eng = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof OpError && !err.status && !readCodes.has(err.code) && !['WORKSPACE_BUSY', 'WRITES_BLOCKED', 'IDEMPOTENCY_CONFLICT'].includes(err.code)) err.status = err.code === 'NOT_FOUND' ? 404 : ENG_CONFLICT.has(err.code) ? 409 : 400;
        throw err;
      }
    };
    const passphrase = async (req, body) => {
      if (!auth) return;
      const check = await auth.verifyPassphrase(req, String((body && body.password) || ''));
      if (!check.ok) throw new HttpError(check.locked ? 429 : 403, check.locked ? 'Too many attempts. Wait a few minutes and try again.' : 'That passphrase is not right. Nothing was changed.');
    };
    const engTask = (s) => { if (!inbox.TASK_ID_RE.test(s)) throw new HttpError(400, 'Not an engineering task ID'); return s; };
    // The task's own state stays readable as task_status.
    const saved = (r) => ({ ...r, ...(r && r.status ? { task_status: r.status } : {}), status: 'saved' });
    route('GET', '/api/engineering', () => eng(() => ({
      ...inbox.ownerView(ws, OWNER),
      mcp_url: oauth ? oauth.engineeringResource : null,
      connections: oauth ? oauth.connections().filter((c) => c.audience === 'engineering') : [],
    })));
    route('POST', '/api/engineering/pause', (m, req, res, body) => eng(() => saved(inbox.setPaused(ws, OWNER, { paused: Boolean(body.paused), reason: body.reason || null }))));
    route('POST', '/api/engineering/policies', (m, req, res, body) => eng(async () => {
      await passphrase(req, body);
      return saved(inbox.activatePolicy(ws, OWNER, { template: body.template, goal_id: body.goal_id || null, goal: body.goal || null, days: body.days || null }));
    }));
    route('POST', '/api/engineering/policies/(pol-\\d{8}-[0-9a-f]{6})/revoke', (m, req, res, body) => eng(() => saved(inbox.revokePolicy(ws, OWNER, m[1], { reason: body.reason || null }))));
    route('POST', '/api/engineering/tasks/([^/]+)/authorize', (m, req, res, body) => eng(async () => {
      await passphrase(req, body);
      return saved(inbox.authorizeTask(ws, OWNER, engTask(m[1]), { version: Number(body.version), content_sha256: String(body.content_sha256 || '') }));
    }));
    // Re-binding one exact task version (backlog item 65): Eric's passphrase,
    // and GitHub's own answer on whether main already holds the candidate is
    // read first, so merged work is settled and never promoted again.
    route('POST', '/api/engineering/tasks/([^/]+)/rebind', (m, req, res, body) => eng(async () => {
      await passphrase(req, body);
      const id = engTask(m[1]);
      const head = inbox.candidateHeadOf(ws, id);
      let merge_state = null;
      if (head) {
        if (!github) throw new HttpError(503, 'GitHub cannot be read from here, so whether main holds this candidate is unknown. Nothing was changed.');
        const c = await github.contains(head, 'main');
        merge_state = { state: c.state, why: c.why || null, main_sha: null };
      }
      return saved(inbox.rebindTask(ws, OWNER, id, { version: Number(body.version), content_sha256: String(body.content_sha256 || ''), policy_id: body.policy_id || null, explicit: body.explicit === true, reason: body.reason || null, merge_state }));
    }));
    route('POST', '/api/engineering/tasks/([^/]+)/pause', (m, req, res, body) => eng(() => saved(inbox.pauseTask(ws, OWNER, engTask(m[1]), { reason: body.reason || null }))));
    route('POST', '/api/engineering/tasks/([^/]+)/resume', (m) => eng(() => saved(inbox.resumeTask(ws, OWNER, engTask(m[1])))));
    route('POST', '/api/engineering/tasks/([^/]+)/cancel', (m, req, res, body) => eng(() => saved(inbox.cancelTask(ws, OWNER, engTask(m[1]), { reason: body.reason || null }))));
    route('POST', '/api/engineering/tasks/([^/]+)/reopen', (m) => eng(() => saved(inbox.reopenTask(ws, OWNER, engTask(m[1])))));
    // Check a confirmed admission against GitHub (2026-10-26): the commit on
    // record first; only when GitHub shows it does not hold the entry is
    // main's history asked for the commit that does. It writes only what
    // GitHub proves, so it takes no passphrase.
    route('POST', '/api/engineering/tasks/([^/]+)/admission/recheck', (m) => eng(async () => {
      const id = engTask(m[1]);
      const a = inbox.admissionCheckOf(ws, id);
      if (!github) throw new HttpError(503, 'GitHub cannot be read from here, so the admission cannot be checked. Nothing was changed.');
      const recorded = a.confirmed_main_sha ? await github.admissionAt(a.confirmed_main_sha, id) : { state: 'no', why: 'no commit recorded' };
      let located = null;
      if (recorded.state === 'no' || (recorded.state === 'yes' && (recorded.main_sha !== a.confirmed_main_sha || recorded.entry_sha256 !== a.entry_sha256))) {
        const f = await github.findAdmissionCommit({ number: a.number, task: id, version: a.version, since: a.bound_at });
        located = f.state === 'found' ? await github.admissionAt(f.sha, id) : { state: f.state === 'none' ? 'no' : 'unknown', why: f.why };
      }
      return saved(inbox.recheckAdmission(ws, OWNER, id, { recorded, located }));
    }));
    // Eric's own review decides any requirement, so it takes his passphrase
    // too (review N3): code running in his signed-in page cannot pass it.
    route('POST', '/api/engineering/tasks/([^/]+)/review', (m, req, res, body) => eng(async () => {
      await passphrase(req, body);
      const { password, ...args } = body || {};
      return saved(inbox.saveReview(ws, OWNER, { ...args, task_id: engTask(m[1]) }));
    }));
  }

  // Convergence with GitHub (2026-10-26): every task ready for promotion is
  // settled as merged once GitHub proves it (github.js mergeProof: a merged
  // pull request from claude/backlog-eng-<n> or claude/candidate-eng-<n>
  // whose head is the head the desk recorded, and main holding it). Run on
  // the schedule below; asks GitHub nothing when no task waits, and one sweep
  // at a time. A task GitHub cannot prove stays as it is.
  let sweeping = false;
  async function reconcileMerges({ now = undefined } = {}) {
    if (!github || sweeping) return { checked: 0, merged: [], skipped: [] };
    sweeping = true;
    try {
      const merged = [];
      const skipped = [];
      const due = inbox.mergeCandidates(ws);
      for (const d of due) {
        const proof = await github.mergeProof({ number: d.number, heads: d.heads });
        if (proof.state !== 'yes') { skipped.push({ task_id: d.task_id, state: proof.state, why: proof.why || null }); continue; }
        try {
          const r = inbox.reconcileMerged(ws, d.task_id, proof, now === undefined ? {} : { now });
          if (r.merged) merged.push({ task_id: d.task_id, number: d.number, pr_number: proof.pr_number });
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          skipped.push({ task_id: d.task_id, state: err.code, why: String(err.message).slice(0, 200) });
        }
      }
      if (merged.length) log(`Engineering: recorded merged from GitHub: ${merged.map((x) => `item ${x.number} (PR #${x.pr_number})`).join(', ')}`);
      return { checked: due.length, merged, skipped };
    } finally {
      sweeping = false;
    }
  }

  // The sweep's schedule on the online desk (frontdoor.js): 20 s after the
  // start, then every 30 minutes, stopped when the server closes. Neither
  // timer keeps the process alive.
  function scheduleSweeps(server, { firstMs = 20000, everyMs = 30 * 60000 } = {}) {
    const run = () => reconcileMerges().catch((err) => log(`Engineering merge sweep failed: ${String((err && err.message) || err).slice(0, 200)}`));
    const first = setTimeout(run, firstMs);
    const every = setInterval(run, everyMs);
    for (const x of [first, every]) if (x.unref) x.unref();
    server.once('close', () => { clearTimeout(first); clearInterval(every); });
    return { first, every };
  }

  return { connector, publicRead, mount, reconcileMerges, scheduleSweeps };
}

module.exports = { makeEngineeringRoutes, PUBLIC_READ_RE };
