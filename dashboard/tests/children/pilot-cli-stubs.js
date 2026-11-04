'use strict';
// Preloaded with `node -r` in front of the real scripts/pilot.js, so the tests
// drive its command line and nothing else (pilot-project-guard.test.js). It
// stands in for what pilot.js reaches outside itself: git, the claude
// executable (the FICTIONAL claude-stand-in.js) and the desk (a fake fetch; no
// request leaves the process). Everything reached is appended to a record file.
// Its settings are the JSON file named by CR_TEST_PILOT_STUBS.
const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(process.env.CR_TEST_PILOT_STUBS, 'utf8'));
const note = (what) => fs.appendFileSync(cfg.record, `${what}\n`);
const isClaude = (file) => /^claude(\.exe)?$/i.test(path.basename(String(file)));

const realSpawnSync = cp.spawnSync;
const realSpawn = cp.spawn;

cp.spawnSync = (file, args = [], opts = {}) => {
  if (file === 'git') {
    const op = args[2];
    note(`git ${op}`);
    if (op === 'rev-parse') return cfg.head ? { status: 0, stdout: `${cfg.head}\n` } : { status: 128, stdout: '' };
    if (op === 'status') return { status: 0, stdout: cfg.porcelain || '' };
    return { status: 1, stdout: '' };
  }
  if (isClaude(file)) {
    const kind = args.includes('--help') ? 'claude help' : args.includes('--version') ? 'claude version' : 'SESSION';
    note(kind);
    return realSpawnSync(process.execPath, [cfg.standIn, ...args], opts);
  }
  return realSpawnSync(file, args, opts);
};
cp.spawn = (file, args = [], opts = {}) => {
  if (isClaude(file)) {
    note('claude probe');
    return realSpawn(process.execPath, [cfg.standIn, ...args], opts);
  }
  return realSpawn(file, args, opts);
};

const FORMAT = 'cr-pilot-worker@1';
const PROMPT = 'FICTIONAL frozen prompt.';
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => String(body) });
let claims = 0;

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  note(`${init.method || 'GET'} ${u.pathname}`);
  if (u.pathname === '/healthz') {
    const h = cfg.healthz;
    if (h.throws) throw new TypeError('fetch failed');
    return answer(h.status, h.body);
  }
  const op = u.pathname.split('/').pop();
  if (op === 'claim') {
    claims += 1;
    if (claims > 1) return answer(200, { format: FORMAT, status: 'nothing', step: 'nothing_more' });
    return answer(200, { format: FORMAT, status: 'claimed_now', attempt_id: 'att_fictional', key: 'key_fictional', token: 'FICTIONAL-claim-token', step: 'research', expires_at: new Date(Date.now() + 3600000).toISOString() });
  }
  if (op === 'prepare') return answer(200, { format: FORMAT, status: 'prepared', role: 'researcher', attempt_id: 'att_fictional', run_id: 'run_fictional', prompt: PROMPT, prompt_sha256: crypto.createHash('sha256').update(PROMPT).digest('hex'), sessions: { used: 1, ceiling: 2 } });
  if (op === 'complete') return answer(200, { format: FORMAT, status: 'saved', report_id: 'rep_fictional' });
  if (op === 'poll') return answer(200, { format: FORMAT, poll: { format: 'cr-pilot-poll@1', paused: true, steps: [] }, sighting: null });
  return answer(404, { error: 'FICTIONAL: not on this desk' });
};
