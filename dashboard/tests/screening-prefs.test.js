'use strict';
// Preferences > Screening (DESIGN_AND_IA_BLUEPRINT.md D5, 2026-10-17): Eric's
// forensic screening preferences are saved through POST /api/settings with
// the same bounds core/forensics.js prefsOf reads them under; a refused value
// writes nothing; the defaults are one list (forensic-defs.js). FICTIONAL
// temporary workspace only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');

function request(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('screening preferences: one list of defaults, read back by prefsOf', () => {
  const D = require('../core/forensic-defs');
  const { DEFAULT_SETTINGS } = require('../core/workspace');
  assert.deepEqual(DEFAULT_SETTINGS.forensics.preferences, { ...D.PREFERENCE_DEFAULTS, exit_sizes_usd: D.PREFERENCE_DEFAULTS.exit_sizes_usd.slice() });
  assert.notEqual(DEFAULT_SETTINGS.forensics.preferences.exit_sizes_usd, D.PREFERENCE_DEFAULTS.exit_sizes_usd, 'a copy, so a merge never touches the frozen defaults');
  const { ws, cleanup } = tempWorkspace('screenprefs-a');
  try {
    const F = require('../core/forensics');
    assert.deepEqual(F.prefsOf(ws).exit_sizes_usd, [100, 500, 2000]);
    ws.settings.forensics.preferences.exit_sizes_usd = [2000, 250, 250, -5, 'x'];
    assert.deepEqual(F.prefsOf(ws).exit_sizes_usd, [250, 2000], 'sorted, positive, without repeats');
    ws.settings.forensics.preferences.exit_sizes_usd = [];
    assert.deepEqual(F.prefsOf(ws).exit_sizes_usd, [100, 500, 2000], 'an empty list falls back to the defaults');
  } finally {
    cleanup();
  }
});

test('screening preferences: POST /api/settings saves valid values and refuses the rest', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('screenprefs-b');
  t.after(cleanup);
  const { start } = require('../server');
  const srv = await start(ws, { port: 49060 + Math.floor(Math.random() * 40), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const session = (await request(srv.port, { path: '/api/session' })).body;
  const post = (body) => request(srv.port, { method: 'POST', path: '/api/settings', headers: { 'x-cr-token': session.token, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' }, body });
  const file = `${root}/config/settings.json`;
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  for (const [bad, why] of [
    [{ exit_cost_limit_pct: 0 }, /more than 0/],
    [{ exit_cost_limit_pct: 150 }, /between 0 and 100/],
    [{ delivery_window_days: 6 }, /between 7 and 365/],
    [{ delivery_window_days: 30.5 }, /whole number/],
    [{ exit_sizes_usd: [] }, /one to five/],
    [{ exit_sizes_usd: [1, 2, 3, 4, 5, 6] }, /one to five/],
    [{ exit_sizes_usd: 'lots' }, /list/],
    [{ volume_review_fraction: 2 }, /between 0 and 1/],
  ]) {
    const r = await post({ forensics: { preferences: bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, why);
  }
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, before, 'a refused value writes nothing');
  const ok = await post({ forensics: { preferences: { exit_sizes_usd: [2000, 250, 250], exit_position_usd: 750, exit_cost_limit_pct: 3.5, delivery_window_days: 90, volume_review_fraction: 0.25, reported_liquidity_review_usd: '', volume_to_liquidity_review_ratio: 40, monitor: 'ignored' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).forensics.preferences;
  assert.deepEqual(saved, { exit_sizes_usd: [250, 2000], exit_position_usd: 750, exit_cost_limit_pct: 3.5, delivery_window_days: 90, volume_review_fraction: 0.25, reported_liquidity_review_usd: null, volume_to_liquidity_review_ratio: 40 });
  const F = require('../core/forensics');
  const p = F.prefsOf(ws);
  assert.deepEqual(p.exit_sizes_usd, [250, 2000]);
  assert.equal(p.exit_position_usd, 750);
  assert.equal(p.exit_cost_limit_pct, 3.5);
  assert.equal(p.reported_liquidity_review_usd, null);
  assert.equal(p.volume_to_liquidity_review_ratio, 40);
  // The monitor's own settings are not reachable through this branch.
  assert.equal(ws.settings.forensics.monitor.enabled, true);
});
