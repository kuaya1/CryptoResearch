'use strict';
// The runner's credentials and environment (blueprint 2026-11-02 §6.4, build
// plan row 4): the desk's bearers come from the environment first, else
// secrets.json; no bearer and no API key reaches a session's environment; an
// unattended run names its model; a lost complete leaves one stdout line with
// identifiers and hashes only. Stubs only: nothing is spawned, no desk is
// reached. FICTIONAL tokens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../scripts/pilot');

const ENV_WORKER = 'FICTIONAL-env-worker-token-000000';
const FILE_WORKER = 'FICTIONAL-file-worker-token-11111';
const ENV_POLL = 'FICTIONAL-env-poll-token-22222222';
const FILE_POLL = 'FICTIONAL-file-poll-token-3333333';

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pilot-cred-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function secrets(t, obj) {
  const f = path.join(tmp(t), 'secrets.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

test('the bearers are read from the environment first, then secrets.json', (t) => {
  const f = secrets(t, { pilot_worker_token: FILE_WORKER, pilot_poll_token: FILE_POLL });
  assert.equal(P.WORKER_TOKEN_ENV, 'CR_PILOT_WORKER_TOKEN');
  assert.equal(P.POLL_TOKEN_ENV, 'CR_PILOT_POLL_TOKEN');
  assert.equal(P.readWorkerToken(f, { CR_PILOT_WORKER_TOKEN: ENV_WORKER }), ENV_WORKER, 'the environment wins');
  assert.equal(P.readPollToken(f, { CR_PILOT_POLL_TOKEN: ` ${ENV_POLL} ` }), ENV_POLL, 'trimmed');
  assert.equal(P.readWorkerToken(f, {}), FILE_WORKER, 'the file when the environment has none');
  assert.equal(P.readPollToken(f, { CR_PILOT_POLL_TOKEN: '   ' }), FILE_POLL, 'a blank value is none');
  // Each reads its own name only.
  assert.equal(P.readWorkerToken(f, { CR_PILOT_POLL_TOKEN: ENV_POLL }), FILE_WORKER);
  assert.equal(P.readPollToken(f, { CR_PILOT_WORKER_TOKEN: ENV_WORKER }), FILE_POLL);
});

test('a short bearer in the environment is refused, never passed over for the file', (t) => {
  const f = secrets(t, { pilot_worker_token: FILE_WORKER, pilot_poll_token: FILE_POLL });
  assert.throws(() => P.readWorkerToken(f, { CR_PILOT_WORKER_TOKEN: 'short' }), /CR_PILOT_WORKER_TOKEN is set but too short/);
  assert.throws(() => P.readPollToken(f, { CR_PILOT_POLL_TOKEN: 'short' }), /CR_PILOT_POLL_TOKEN is set but too short/);
  // The refusal never repeats the value.
  try { P.readWorkerToken(f, { CR_PILOT_WORKER_TOKEN: 'shortsecret' }); } catch (err) { assert.ok(!err.message.includes('shortsecret')); }
});

test('without an environment value or a file, the bearer is a plain error', (t) => {
  const missing = path.join(tmp(t), 'secrets.json');
  assert.throws(() => P.readWorkerToken(missing, {}), /worker token could not be read/);
  assert.throws(() => P.readPollToken(missing, {}), /poll token could not be read/);
});

test('the session environment allowlist is pinned: no CR_* name, no API key', () => {
  const pinned = [
    'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
    'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_GIT_BASH_PATH', 'ANTHROPIC_MODEL',
  ];
  assert.deepEqual([...P.ENV_KEEP].sort(), [...pinned].sort(), 'a change to the allowlist is a reviewed change to this test');
  for (const k of P.ENV_KEEP) assert.ok(!/^CR_/.test(k), `${k} is a desk name`);
  assert.ok(!P.ENV_KEEP.has('ANTHROPIC_API_KEY') && !P.ENV_KEEP.has('ANTHROPIC_AUTH_TOKEN'));
  assert.equal(String(P.ENV_KEEP_RE), String(/^ANTHROPIC_DEFAULT_[A-Z0-9]+_MODEL$/));
});

test('a session\'s environment drops the desk\'s bearers, the Healthchecks URL and every API key, and keeps the subscription token', () => {
  const parent = {
    PATH: '/usr/bin', HOME: '/home/fictional',
    CR_PILOT_POLL_TOKEN: ENV_POLL, CR_PILOT_WORKER_TOKEN: ENV_WORKER, CR_HEALTHCHECK_URL: 'https://hc.fictional.example/ping/0000',
    CR_DESK_URL: 'https://desk.fictional.example', ANTHROPIC_API_KEY: 'sk-ant-FICTIONAL', ANTHROPIC_AUTH_TOKEN: 'FICTIONAL-auth',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', DESK_INGEST_KEY: 'FICTIONAL-ingest', XAI_API_KEY: 'FICTIONAL-xai',
    CLAUDE_CODE_OAUTH_TOKEN: 'FICTIONAL-oauth', ANTHROPIC_MODEL: 'claude-fictional', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-fictional-opus',
  };
  const env = P.launchEnv(parent);
  for (const k of ['CR_PILOT_POLL_TOKEN', 'CR_PILOT_WORKER_TOKEN', 'CR_HEALTHCHECK_URL', 'CR_DESK_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'DESK_INGEST_KEY', 'XAI_API_KEY']) {
    assert.ok(!(k in env), `${k} reached the session`);
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'FICTIONAL-oauth');
  assert.equal(env.ANTHROPIC_MODEL, 'claude-fictional');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-fictional-opus');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  const all = JSON.stringify(env);
  for (const v of [ENV_POLL, ENV_WORKER, 'sk-ant-FICTIONAL', 'FICTIONAL-auth', 'hc.fictional.example']) assert.ok(!all.includes(v));
});

test('--unattended parses; without --model the run exits 1 before any poll, claim or session', async (t) => {
  assert.equal(P.parse(['--pilot-all', '--unattended']).unattended, true);
  assert.ok(!P.parse(['--pilot-all']).unattended);
  const d = tmp(t);
  const logFile = path.join(d, 'pilot-all.jsonl');
  const lockFile = path.join(d, 'pilot-all.lock');
  const touched = [];
  const said = [];
  for (const desk of ['local', 'online']) {
    const code = await P.runAll({ desk, maxAgents: 2, unattended: true, model: null }, {
      call: (args) => { touched.push(['call', args]); return {}; },
      agent: () => { touched.push(['agent']); return ''; },
      fetchImpl: async (url) => { touched.push(['fetch', url]); throw new Error('no desk in this test'); },
      env: { CR_PILOT_POLL_TOKEN: ENV_POLL },
      lockFile, logFile, out: (s) => said.push(s),
    });
    assert.equal(code, 1, desk);
  }
  assert.deepEqual(touched, [], 'nothing was polled, claimed or run');
  assert.ok(!fs.existsSync(lockFile), 'no lock was taken');
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 2);
  for (const l of log) {
    assert.match(l.error, /names its model: --model=<id>/);
    assert.equal(l.exit, 1);
    assert.equal(l.health, 'failure');
    assert.deepEqual(l.dispatches, []);
  }
  assert.ok(said.some((s) => /names its model/.test(s)));
});

test('--unattended with --model goes on to the poll', async (t) => {
  const d = tmp(t);
  let polled = 0;
  const call = (args) => {
    if (args[1] === 'queue') { polled += 1; return { steps: [], pending: [], paused: false, claims: {} }; }
    return {};
  };
  const code = await P.runAll({ desk: 'local', maxAgents: 2, unattended: true, model: 'claude-fictional' }, { call, agent: () => '', lockFile: path.join(d, 'l.lock'), logFile: path.join(d, 'l.jsonl'), out: () => {} });
  assert.equal(code, 0);
  assert.ok(polled >= 1);
  const l = JSON.parse(fs.readFileSync(path.join(d, 'l.jsonl'), 'utf8').trim());
  assert.equal(l.unattended, true);
});

// A lost complete on a host whose disk does not outlive the run: stdout keeps
// one line with the IDs and hashes needed to reconcile, never the answer's
// text, the claim token or the worker token.
const DESK = 'https://desk.fictional.example';
const WTOKEN = 'FICTIONAL-worker-token-0000000000';
const CLAIM = 'c'.repeat(24);
const ANSWER = 'Report (FICTIONAL) with a distinctive sentence 9f2e.';
const PROMPT = 'FROZEN RESEARCH PROMPT (FICTIONAL)';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

test('a lost complete prints one Lost complete line: identifiers and hashes, no text or token', async (t) => {
  const pendingDir = tmp(t);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const op = url.slice(`${DESK}/api/pilot/worker/`.length);
    calls.push(op);
    const json = (o) => ({ status: 200, ok: true, json: async () => ({ format: 'cr-pilot-worker@1', ...o }) });
    if (op === 'claim') return json({ status: 'claimed_now', step: 'research', key: 'research:-', token: CLAIM, attempt_id: 'pa_1', expires_at: '2099-01-01T00:00:00.000Z' });
    if (op === 'prepare') return json({ status: 'prepared', role: 'researcher', attempt_id: 'pa_1', run_id: 'run_FICTIONAL', ticket_id: null, prompt: PROMPT, prompt_sha256: sha(PROMPT), sessions: { used: 1, ceiling: 6 } });
    if (op === 'complete') throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    return { status: 404, ok: false, json: async () => ({}) };
  };
  const said = [];
  const o = { project: 'olas', desk: 'online', deskUrl: DESK, model: null, timeoutMin: 1, forceProsecution: false, ownerWords: null };
  const r = await P.runOnline(o, { run: () => ANSWER, out: (s) => said.push(s), fetchImpl, token: WTOKEN, sleep: async () => {}, pendingDir });
  assert.equal(r.stop, 'reconcile');
  const lost = said.filter((s) => s.startsWith('Lost complete: '));
  assert.equal(lost.length, 1);
  const rec = JSON.parse(lost[0].slice('Lost complete: '.length));
  assert.deepEqual(Object.keys(rec), ['format', ...P.LOST_FIELDS]);
  assert.equal(rec.format, P.LOST_FORMAT);
  assert.deepEqual([rec.project_id, rec.attempt_id, rec.key, rec.role, rec.run_id, rec.ticket_id], ['olas', 'pa_1', 'research:-', 'researcher', 'run_FICTIONAL', null]);
  assert.equal(rec.claim_expires_at, '2099-01-01T00:00:00.000Z');
  assert.equal(rec.prompt_sha256, sha(PROMPT));
  assert.equal(rec.text_sha256, sha(ANSWER));
  assert.equal(rec.attempts, 6, 'one try and 5 retries');
  const stdout = said.join('\n');
  for (const secret of [ANSWER, 'distinctive sentence 9f2e', CLAIM, WTOKEN]) assert.ok(!stdout.includes(secret), `stdout carries ${secret.slice(0, 12)}…`);
  assert.equal(calls.filter((c) => c === 'complete').length, 6);
});

test('lostComplete keeps only its named fields', () => {
  const rec = P.lostComplete({ project_id: 'olas', text: ANSWER, claim_token: CLAIM, token: WTOKEN, attempts: 2 });
  assert.deepEqual(Object.keys(rec), ['format', ...P.LOST_FIELDS]);
  assert.ok(!JSON.stringify(rec).includes(ANSWER) && !JSON.stringify(rec).includes(CLAIM) && !JSON.stringify(rec).includes(WTOKEN));
  assert.equal(rec.run_id, null, 'missing is null, never left out');
});
