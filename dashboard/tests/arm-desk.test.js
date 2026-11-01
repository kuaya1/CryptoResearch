'use strict';
// `arm-desk` and `contracts init-defaults` (2026-10-30): the paper desk's
// baseline settings and the published contract defaults, each checked by the
// same validateSettingsPatch as Settings. FICTIONAL temporary workspaces; no
// network, no key, no provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempWorkspace, hashTree } = require('./helpers');
const { run } = require('../cli');
const { validateSettingsPatch, start } = require('../server');
const A = require('../core/arm-desk');
const P = require('../core/contract-presets');
const K = require('../core/keccak');
const TR = require('../core/trader-rules');
const L = require('../core/leads');

function temp(t, settings = {}) {
  const w = tempWorkspace('arm', settings);
  t.after(w.cleanup);
  return w;
}
const reopen = (w) => require('../core/workspace').openWorkspace({ root: w.root, actor: 'test' });

test('arm-desk --dry-run validates cleanly against validateSettingsPatch and writes nothing', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--dry-run', '--workspace', w.root]);
  assert.equal(out.status, 'planned');
  assert.equal(out.valid, true);
  assert.deepEqual(out.patch, validateSettingsPatch(A.armPatch(), w.ws), 'the patch shown is the validated one');
  assert.equal(out.patch.leads.enabled, true);
  assert.equal(out.patch.leads.chains.length, 10);
  assert.deepEqual([out.patch.leads.min_market_cap_usd, out.patch.leads.min_volume_24h_usd, out.patch.leads.max_sell_tax_pct, out.patch.leads.eligibility_hours], [5000000, 250000, 5, 48]);
  assert.equal(out.patch.automation.exit_quotes_auto, true);
  assert.deepEqual(out.patch.trader.book, { cash_usd: '25000', fee_rate: '0.001' });
  assert.deepEqual(out.patch.trader.rules, { stop_min_pct: '0.03', stop_min_atr: '0.5', notional_max_pct: '0.20', max_validity_minutes: 1440 });
  assert.deepEqual(out.patch.tickets, { sizing: { min_grade_new_entry: 50 } });
  assert.equal(out.patch.automation.autonomous_paper_loop, undefined, 'the mandate untouched without a flag');
  assert.equal(out.patch.contracts, undefined, 'contracts untouched without caps');
  assert.ok(out.left_for_you.some((s) => /allowlist is unset/.test(s)));
  assert.ok(out.left_for_you.some((s) => /caps are unset/.test(s)));
  assert.equal(out.contract_defaults.pool_factories.length, 8);
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
  // With the caps and pairs named, still valid; a cap under the minimum is refused.
  const capped = await run(['arm-desk', '--dry-run', '--daily-cu=5000', '--monthly-cu=100000', '--allow=XFIC/USDC,ABC/USDC', '--workspace', w.root]);
  assert.deepEqual(capped.patch.contracts, { daily_cu_cap: 5000, monthly_cu_cap: 100000 });
  assert.deepEqual(capped.patch.trader.rules.allowlist, ['XFIC/USDC', 'ABC/USDC']);
  assert.ok(!capped.left_for_you.some((s) => /allowlist|caps/.test(s)));
  await assert.rejects(run(['arm-desk', '--dry-run', '--daily-cu=500', '--workspace', w.root]), (e) => e.code === 'INVALID');
  await assert.rejects(run(['arm-desk', '--dry-run', '--daily-cu=5k', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--desk=elsewhere', '--workspace', w.root]), (e) => e.code === 'USAGE');
  assert.deepEqual(hashTree(w.root), before, 'still nothing written');
});

test('arm-desk locally: the settings and the contract defaults are written; the trader waits only for the allowlist', async (t) => {
  const w = temp(t);
  const out = await run(['arm-desk', '--workspace', w.root]);
  assert.equal(out.status, 'saved');
  assert.equal(out.verified, true);
  const ws = reopen(w);
  assert.deepEqual(L.policyOf(ws).missing, [], 'the lead policy is complete');
  assert.equal(L.policyOf(ws).values.enabled, true);
  assert.equal(ws.settings.automation.exit_quotes_auto, true);
  assert.equal(ws.settings.automation.paused, false, 'the pause untouched');
  assert.deepEqual(TR.bookOf(ws).unset, []);
  assert.deepEqual(TR.rulesOf(ws).unset, ['allowlist']);
  assert.equal(ws.settings.contracts.enabled, false, 'observations stay off');
  assert.equal(ws.settings.contracts.daily_cu_cap, null);
  assert.equal(ws.settings.contracts.pool_factories.length, 8);
  assert.equal(ws.settings.contracts.safe_singleton_code_hashes.length, 4);
  assert.deepEqual(ws.settings.contracts.network_fee_ceiling_usd, { 1: 5, 8453: 0.25, 42161: 0.25, 10: 0.25 });
  // Again, with pairs: the allowlist is the last rule; the defaults are not added twice.
  const again = await run(['arm-desk', '--allow=XFIC/USDC', '--workspace', w.root]);
  assert.deepEqual(again.contract_defaults.pool_factories, []);
  const ws2 = reopen(w);
  assert.deepEqual(TR.rulesOf(ws2).unset, []);
  assert.equal(ws2.settings.contracts.pool_factories.length, 8);
});

test('arm-desk --desk=online prints a console script with the same validated settings and no secret', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--desk=online', '--workspace', w.root]);
  const text = out._text;
  assert.match(text, /fetch\('\/api\/session'/);
  assert.match(text, /'x-cr-token': s\.token/);
  assert.match(text, /post\('\/api\/contracts\/init-defaults', \{\}\)/);
  const body = JSON.parse(text.match(/post\('\/api\/settings', (\{.*\})\)\);/)[1]);
  assert.deepEqual(body, A.armPatch());
  validateSettingsPatch(body, w.ws);
  assert.doesNotMatch(text, /DESK_INGEST_KEY|XAI_API_KEY|ALCHEMY_API_KEY|passphrase/i);
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
});

test('contract presets: every row passes Settings, the mainnet rows derive the published USDC/WETH pools, and Eric\'s own values are kept', async (t) => {
  const p = P.plan({ contracts: { pool_factories: [], safe_singleton_code_hashes: [], network_fee_ceiling_usd: {} } });
  const checked = validateSettingsPatch(p.patch).contracts;
  assert.equal(checked.pool_factories.length, 8);
  assert.deepEqual(checked.pool_factories, P.POOL_FACTORIES.map((r) => validateSettingsPatch({ contracts: { pool_factories: [r] } }).contracts.pool_factories[0]), 'already in the stored form');
  assert.deepEqual([...new Set(checked.pool_factories.map((r) => r.chain_id))].sort(), ['1', '10', '42161', '8453']);
  assert.ok(checked.pool_factories.every((r) => r.quotes.length === 1 && r.quotes[0].symbol === 'USDC' && r.quotes[0].decimals === 6 && r.quotes[0].usd_value === '1'));
  assert.equal(checked.safe_singleton_code_hashes.length, 4);
  assert.deepEqual(checked.network_fee_ceiling_usd, { 1: 5, 8453: 0.25, 42161: 0.25, 10: 0.25 });
  // The factory and init-code hash give the published mainnet USDC/WETH pools.
  const USDC = P.USDC[1].slice(2);
  const WETH = 'c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const v3 = P.POOL_FACTORIES.find((r) => r.chain_id === '1' && r.kind === 'v3');
  const v2 = P.POOL_FACTORIES.find((r) => r.chain_id === '1' && r.kind === 'v2');
  assert.equal(K.create2Address(v3.factory, K.keccak256Hex(`0x${USDC.padStart(64, '0')}${WETH.padStart(64, '0')}${(500).toString(16).padStart(64, '0')}`), v3.init_code_hash), '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
  assert.equal(K.create2Address(v2.factory, K.keccak256Hex(`0x${USDC}${WETH}`), v2.init_code_hash), '0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
  // Eric's own: a row with the same factory and a ceiling he chose are kept.
  const mine = { ...P.POOL_FACTORIES[0], name: 'Mine', fee_tiers: [500] };
  const kept = P.plan({ contracts: { pool_factories: [mine], safe_singleton_code_hashes: [P.SAFE_SINGLETON_CODE_HASHES[0].toUpperCase().replace('0X', '0x')], network_fee_ceiling_usd: { 1: 2 } } });
  assert.equal(kept.patch.contracts.pool_factories.length, 8);
  assert.equal(kept.patch.contracts.pool_factories[0].name, 'Mine');
  assert.equal(kept.patch.contracts.safe_singleton_code_hashes.length, 4);
  assert.equal(kept.patch.contracts.network_fee_ceiling_usd[1], 2);
  assert.equal(kept.added.pool_factories.length, 7);
  assert.equal(P.plan({ contracts: { ...checked } }).patch, null, 'nothing to add');
});

test('contracts init-defaults: --dry-run writes nothing; the run adds the defaults once', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const dry = await run(['contracts', 'init-defaults', '--dry-run', '--workspace', w.root]);
  assert.equal(dry.status, 'planned');
  assert.equal(dry.patch.contracts.pool_factories.length, 8);
  assert.deepEqual(hashTree(w.root), before);
  const out = await run(['contracts', 'init-defaults', '--workspace', w.root]);
  assert.equal(out.status, 'saved');
  assert.equal(out.verified, true);
  assert.equal(reopen(w).settings.contracts.pool_factories.length, 8);
  assert.equal((await run(['contracts', 'init-defaults', '--workspace', w.root])).status, 'unchanged');
});

test('POST /api/contracts/init-defaults: dry_run writes nothing, then the defaults are saved, signed in only', async (t) => {
  const w = temp(t);
  const srv = await start(w.ws, { port: 47980 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const ask = (p, headers = {}, body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${srv.port}`, ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${srv.port}` } : {}), ...headers } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const token = (await ask('/api/session')).json.token;
  const settingsFile = () => fs.readFileSync(path.join(w.root, 'config', 'settings.json'), 'utf8');
  const before = settingsFile();
  const dry = await ask('/api/contracts/init-defaults', { 'x-cr-token': token }, { dry_run: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.json.status, 'planned');
  assert.equal(settingsFile(), before);
  assert.equal((await ask('/api/contracts/init-defaults', {}, {})).status, 401);
  const saved = await ask('/api/contracts/init-defaults', { 'x-cr-token': token }, {});
  assert.equal(saved.json.status, 'saved');
  assert.equal(JSON.parse(settingsFile()).contracts.pool_factories.length, 8);
  assert.equal((await ask('/api/contracts/init-defaults', { 'x-cr-token': token }, {})).json.status, 'unchanged');
});

// --- Autonomous paper playbook, Stage 12.

test('--intent-life sets the life of an intent (1 to 10,080 minutes); --contracts-on needs both caps', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const life = await run(['arm-desk', '--dry-run', '--intent-life=4320', '--workspace', w.root]);
  assert.equal(life.patch.trader.rules.max_validity_minutes, 4320);
  await assert.rejects(run(['arm-desk', '--dry-run', '--intent-life=20000', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--intent-life=0', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--contracts-on', '--workspace', w.root]), (e) => e.code === 'REFUSED' && /both compute-unit caps/.test(e.message));
  await assert.rejects(run(['arm-desk', '--dry-run', '--contracts-on', '--daily-cu=5000', '--workspace', w.root]), (e) => e.code === 'REFUSED');
  const on = await run(['arm-desk', '--dry-run', '--contracts-on', '--daily-cu=5000', '--monthly-cu=100000', '--workspace', w.root]);
  assert.deepEqual(on.patch.contracts, { daily_cu_cap: 5000, monthly_cu_cap: 100000, enabled: true });
  assert.ok(on.left_for_you.some((s) => /ALCHEMY_API_KEY in Render > Environment/.test(s)));
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
  // Caps already saved locally count.
  const w2 = temp(t, { contracts: { daily_cu_cap: 5000, monthly_cu_cap: 100000 } });
  assert.equal((await run(['arm-desk', '--dry-run', '--contracts-on', '--workspace', w2.root])).patch.contracts.enabled, true);
});

test('--mandate-days turns the paper mandate on for N days (1 to 30); --mandate-off turns it off; not both', async (t) => {
  const w = temp(t);
  const t0 = Date.now();
  const on = await run(['arm-desk', '--dry-run', '--mandate-days=7', '--workspace', w.root]);
  assert.equal(on.patch.automation.autonomous_paper_loop, true);
  const ahead = Date.parse(on.patch.automation.mandate.expires_at) - t0;
  assert.ok(ahead > 6.99 * 86400000 && ahead <= 7 * 86400000 + 60000, String(ahead));
  assert.ok(on.left_for_you.some((s) => /paper mandate is on until/.test(s)));
  await assert.rejects(run(['arm-desk', '--dry-run', '--mandate-days=31', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--mandate-days=0', '--workspace', w.root]), (e) => e.code === 'USAGE');
  await assert.rejects(run(['arm-desk', '--dry-run', '--mandate-days=7', '--mandate-off', '--workspace', w.root]), (e) => e.code === 'USAGE');
  const off = await run(['arm-desk', '--dry-run', '--mandate-off', '--workspace', w.root]);
  assert.equal(off.patch.automation.autonomous_paper_loop, false);
  assert.ok(off.left_for_you.some((s) => /paper mandate is off/.test(s)));
  // Written locally, the mandate reads on.
  await run(['arm-desk', '--mandate-days=7', '--workspace', w.root]);
  const T = require('../core/tickets');
  assert.equal(T.mandateOf(reopen(w)).on, true);
  assert.equal(reopen(w).settings.tickets.sizing.min_grade_new_entry, 50);
});

test('--desk=online with the flags: the settings, then the exit-quote targets, then the contract defaults; what is left as comments', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--desk=online', '--allow=NMR/USDC', '--daily-cu=5000', '--monthly-cu=100000', '--contracts-on', '--mandate-days=7', '--intent-life=4320', '--workspace', w.root]);
  const text = out._text;
  const body = JSON.parse(text.match(/post\('\/api\/settings', (\{.*\})\)\);/)[1]);
  validateSettingsPatch(body, w.ws);
  assert.deepEqual(body.trader.rules.allowlist, ['NMR/USDC']);
  assert.equal(body.trader.rules.max_validity_minutes, 4320);
  assert.deepEqual(body.contracts, { daily_cu_cap: 5000, monthly_cu_cap: 100000, enabled: true });
  assert.equal(body.automation.autonomous_paper_loop, true);
  assert.deepEqual(body.tickets, { sizing: { min_grade_new_entry: 50 } });
  const at = (p) => text.indexOf(p);
  assert.ok(at("post('/api/settings'") < at("post('/api/forensics/exit-quotes/auto', {})") && at("post('/api/forensics/exit-quotes/auto', {})") < at("post('/api/contracts/init-defaults', {})"));
  assert.match(text, /^\/\/ Left for you: .*CR_PILOT_POLL_TOKEN_SHA256/m);
  assert.doesNotMatch(text, /DESK_INGEST_KEY|XAI_API_KEY|passphrase|pilot_poll_token":/i);
  // The online desk's caps are not known here: --contracts-on needs them named.
  await assert.rejects(run(['arm-desk', '--desk=online', '--contracts-on', '--workspace', w.root]), (e) => e.code === 'REFUSED');
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
});

test('--print-schedule prints the pilot-task.ps1 registration (disabled, never /F) and runs nothing', async (t) => {
  const w = temp(t);
  const before = hashTree(w.root);
  const out = await run(['arm-desk', '--print-schedule', '--workspace', w.root]);
  assert.match(out._text, /^powershell -NoProfile -ExecutionPolicy Bypass -File ".*\\dashboard\\scripts\\pilot-task\.ps1" -Register -MaxAgents 1$/m);
  assert.match(out._text, /disabled until you enable it\. Nothing was run/);
  assert.doesNotMatch(out._text, /schtasks|\/F\b/, 'no line that replaces a task by name');
  assert.deepEqual(hashTree(w.root), before, 'nothing written');
});

// The registration script itself, read as text (it is run only by Eric or
// the operator on Windows): disabled first, never replacing a task it did not
// make, the verified Node binary and pilot.js, IgnoreNew, a 3-hour limit.
test('pilot-task.ps1 registers disabled, refuses a task it did not make, and runs the verified node binary with pilot.js', () => {
  const text = fs.readFileSync(require('path').join(__dirname, '..', 'scripts', 'pilot-task.ps1'), 'utf8');
  assert.match(text, /New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit \(New-TimeSpan -Hours 3\) -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Disable/);
  assert.match(text, /-RepetitionInterval \(New-TimeSpan -Minutes 30\)/);
  assert.match(text, /New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited/);
  assert.match(text, /if \(\$t -and \$t\.Description -ne \$Mark\) \{ throw/);
  assert.match(text, /if \(\$t\) \{ Assert-Ours \$t; throw/, '-Register refuses while any task of that name exists');
  // The launcher is the job wrapper, never conhost (A4: measured under Task
  // Scheduler, conhost lost every exit code and left the runner's processes alive).
  assert.match(text, /New-ScheduledTaskAction -Execute \$PowerShellExe -Argument \('-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "\{0\}" "\{1\}" --pilot-all --desk=online --max-agents=\{2\}' -f \$Wrapper, \$node\.Path, \$MaxAgents\) -WorkingDirectory \$Root/);
  assert.doesNotMatch(text, /-Execute \$Conhost|--headless "\{0\}"/);
  assert.match(text, /Volta shim/);
  assert.doesNotMatch(text, /-Force|schtasks|WakeToRun \$true/);
  // -Status reads only: no start, stop, change or removal, no lock or claim
  // touched, and the action's arguments are never printed.
  const status = text.slice(text.indexOf('function Get-Facts'), text.indexOf('$t = Get-Task'));
  assert.doesNotMatch(status, /Start-ScheduledTask|Stop-ScheduledTask|Set-ScheduledTask|Enable-ScheduledTask|Disable-ScheduledTask|Unregister|Remove-Item|Set-Content|Out-File|release/);
  assert.doesNotMatch(status, /arguments\s*=/);
});

test('pilot-task-run.ps1 holds the runner in a kill-on-close job before starting it, runs pilot.js from the repository and returns its exit code', () => {
  const text = fs.readFileSync(require('path').join(__dirname, '..', 'scripts', 'pilot-task-run.ps1'), 'utf8');
  assert.doesNotMatch(text, /^\s*param\(/m, 'no param() block: --desk=online is passed on as it is');
  assert.match(text, /e\.Basic\.LimitFlags = 0x2000; \/\/ JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(text, /AssignProcessToJobObject\(Handle, GetCurrentProcess\(\)\)/);
  const job = text.indexOf('[CrPilotJob]::Setup()');
  const run = text.indexOf('& $node $pilot @rest');
  assert.ok(job > 0 && run > job, 'the job is made before the runner starts');
  assert.match(text, /if \(\$jobError -ne 0\) \{ exit 94 \}/);
  assert.match(text, /\} catch \{\s*exit 93\s*\}/, 'no job, nothing started');
  assert.match(text, /\$pilot = Join-Path \$root 'dashboard\\scripts\\pilot\.js'/);
  assert.match(text, /Set-Location -LiteralPath \$root/);
  assert.match(text, /if \(\$null -eq \$LASTEXITCODE\) \{ exit 91 \}\s*exit \$LASTEXITCODE\s*$/);
  const code = text.slice(text.indexOf('#>'));
  assert.doesNotMatch(code, /Stop-Process|taskkill|release|Remove-Item|tickets/, 'it ends nothing by name and touches no claim');
});

// --- Off-only controls (bounded paper readiness A5, 2026-11-01).
// --mandate-off and --admission-off, alone or together, are exactly
//   {"automation":{"autonomous_paper_loop":false}}
//   {"automation":{"lead_admission":{"enabled":false}}}
// plus the authority revocation and operation receipt the settings write
// records; nothing else is written or asked, and nothing beside them is taken.

const vm = require('vm');
const { applySettings } = require('../server');
const LA = require('../core/lead-admission');
const MT = require('../core/tickets');

const OFF_BOTH = { automation: { autonomous_paper_loop: false, lead_admission: { enabled: false } } };
const settingsOf = (w) => JSON.parse(fs.readFileSync(path.join(w.root, 'config', 'settings.json'), 'utf8'));
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => k.split(path.sep).join('/')).sort();
// The settings write's own records (ops.js): its line in the operation log,
// the workspace's write generation and the earlier settings' version copy.
const OP_RECORD = /^(logs\/operations\.jsonl|\.cr\/generation\.json|backups\/versions\/config\/settings\.json@[0-9TZ-]+)$/;

// An armed desk with Eric's own values where a baseline arm-desk would reset
// them: the mandate and admission each at generation 1, his Paper Book, exit
// quotes and the lead policy off, no pool factories (so contract defaults, if
// asked, would show).
async function armedDesk(t) {
  const w = temp(t);
  const out = await run(['arm-desk', '--mandate-days=7', '--admission-days=5', '--allow=XFIC/USDC', '--intent-life=4320', '--daily-cu=5000', '--monthly-cu=100000', '--workspace', w.root]);
  assert.equal(out.status, 'saved');
  applySettings(reopen(w), { automation: { exit_quotes_auto: false }, leads: { enabled: false }, trader: { book: { cash_usd: '40000', fee_rate: '0.002' } }, contracts: { pool_factories: [] } }, 'FICTIONAL: own values');
  const s = settingsOf(w);
  assert.equal(s.automation.mandate.authority.generation, 1);
  assert.equal(s.automation.lead_admission.authority.generation, 1);
  assert.equal(s.automation.mandate.authority.revoked_at, undefined);
  assert.equal(MT.mandateOf(reopen(w)).on, true);
  assert.equal(LA.authorityOf(reopen(w)).on, true);
  return w;
}

// What the off write may change: the two switches and the authorities' revocation.
function expectOff(before, after, { mandate = true, admission = true } = {}) {
  const want = JSON.parse(JSON.stringify(before));
  if (mandate) {
    want.automation.autonomous_paper_loop = false;
    const au = after.automation.mandate.authority;
    assert.match(String(au.revoked_at), /^\d{4}-\d{2}-\d{2}T/);
    want.automation.mandate.authority = { ...before.automation.mandate.authority, revoked_at: au.revoked_at, revoked_by: au.revoked_by, revoked_because: 'loop_off' };
  }
  if (admission) {
    want.automation.lead_admission.enabled = false;
    const au = after.automation.lead_admission.authority;
    assert.match(String(au.revoked_at), /^\d{4}-\d{2}-\d{2}T/);
    want.automation.lead_admission.authority = { ...before.automation.lead_admission.authority, revoked_at: au.revoked_at, revoked_by: au.revoked_by, revoked_because: 'off' };
  }
  assert.deepEqual(after, want, 'only the switches and the revocations changed; every other setting is identical');
}

test('off-only: --mandate-off and --admission-off are exactly their switches (dry run and local, alone and together), revoke the authority in force, and leave every other setting as it was', async (t) => {
  const w = await armedDesk(t);
  const tree0 = hashTree(w.root);
  // Dry run: the exact patch, nothing written, no contract defaults planned.
  const dry = await run(['arm-desk', '--dry-run', '--mandate-off', '--admission-off', '--workspace', w.root]);
  assert.deepEqual([dry.status, dry.mode, dry.valid], ['planned', 'off_only', true]);
  assert.deepEqual(dry.patch, OFF_BOTH);
  assert.equal('contract_defaults' in dry, false, 'no contract defaults planned');
  assert.deepEqual((await run(['arm-desk', '--dry-run', '--mandate-off', '--workspace', w.root])).patch, { automation: { autonomous_paper_loop: false } });
  assert.deepEqual((await run(['arm-desk', '--dry-run', '--admission-off', '--workspace', w.root])).patch, { automation: { lead_admission: { enabled: false } } });
  assert.deepEqual(A.armPatch({ mandateOff: true, admissionOff: true }), OFF_BOTH);
  assert.ok(dry.left_for_you.some((l) => /Nothing else is written/.test(l)));
  assert.ok(dry.left_for_you.some((l) => /pilot-all task is not touched/.test(l)));
  assert.ok(!dry.left_for_you.some((l) => /allowlist is unset|caps are unset|CR_PILOT_POLL_TOKEN/.test(l)), 'no baseline assumptions');
  assert.deepEqual(hashTree(w.root), tree0, 'the dry runs wrote nothing');
  // Both, locally: the switches, the revocations and the operation's own record.
  const before = settingsOf(w);
  const out = await run(['arm-desk', '--mandate-off', '--admission-off', '--workspace', w.root]);
  assert.deepEqual([out.status, out.verified, out.mode], ['saved', true, 'off_only']);
  assert.deepEqual(out.applied, OFF_BOTH);
  assert.equal('contract_defaults' in out, false);
  const after = settingsOf(w);
  expectOff(before, after);
  assert.deepEqual(after.contracts.pool_factories, [], 'contract defaults were not added');
  assert.deepEqual(after.trader.book, { cash_usd: '40000', fee_rate: '0.002' }, 'the Paper Book was not reset');
  assert.equal(after.automation.exit_quotes_auto, false, 'exit quotes not turned on');
  assert.equal(after.leads.enabled, false, 'leads not turned on');
  assert.deepEqual([out.readback.mandate_on, out.readback.admission_on], [false, false]);
  assert.deepEqual(out.readback.mandate_authority, { generation: 1, revoked_at: after.automation.mandate.authority.revoked_at, revoked_because: 'loop_off' });
  assert.deepEqual(out.readback.admission_authority, { generation: 1, revoked_at: after.automation.lead_admission.authority.revoked_at, revoked_because: 'off' });
  const files = changed(tree0, hashTree(w.root));
  assert.ok(files.includes('config/settings.json'));
  const others = files.filter((f) => f !== 'config/settings.json');
  assert.ok(others.every((f) => OP_RECORD.test(f)), `only the settings and the write's own operation records changed: ${others.join(', ')}`);
  const ws = reopen(w);
  assert.equal(MT.mandateOf(ws).on, false);
  assert.equal(LA.authorityOf(ws).on, false);
  // Again: the same switches, nothing new revoked or armed.
  const again = await run(['arm-desk', '--mandate-off', '--admission-off', '--workspace', w.root]);
  assert.equal(again.verified, true);
  assert.deepEqual(settingsOf(w).automation, after.automation, 'the revocations stand as first recorded');
});

test('off-only: the mandate off alone leaves admission armed, and admission off alone leaves the mandate armed', async (t) => {
  const w = await armedDesk(t);
  let before = settingsOf(w);
  await run(['arm-desk', '--mandate-off', '--workspace', w.root]);
  expectOff(before, settingsOf(w), { admission: false });
  assert.equal(LA.authorityOf(reopen(w)).on, true, 'admission still armed, generation 1');
  const w2 = await armedDesk(t);
  before = settingsOf(w2);
  await run(['arm-desk', '--admission-off', '--workspace', w2.root]);
  expectOff(before, settingsOf(w2), { mandate: false });
  assert.equal(MT.mandateOf(reopen(w2)).on, true, 'the mandate still armed, generation 1');
});

test('off-only: resuming automation or a baseline arm-desk never rearms a revoked generation; an explicit arming is a new one', async (t) => {
  const w = await armedDesk(t);
  // Paused, then off, then resumed.
  applySettings(reopen(w), { automation: { paused: true } }, 'FICTIONAL: pause');
  await run(['arm-desk', '--mandate-off', '--admission-off', '--workspace', w.root]);
  applySettings(reopen(w), { automation: { paused: false } }, 'FICTIONAL: resume');
  let s = settingsOf(w);
  assert.equal(s.automation.mandate.authority.generation, 1);
  assert.ok(s.automation.mandate.authority.revoked_at);
  assert.equal(s.automation.lead_admission.authority.generation, 1);
  assert.ok(s.automation.lead_admission.authority.revoked_at);
  assert.equal(MT.mandateOf(reopen(w)).on, false);
  assert.equal(LA.authorityOf(reopen(w)).on, false);
  // A baseline arm-desk (no mandate or admission flag) arms neither.
  await run(['arm-desk', '--workspace', w.root]);
  s = settingsOf(w);
  assert.deepEqual([s.automation.autonomous_paper_loop, s.automation.mandate.authority.generation, Boolean(s.automation.mandate.authority.revoked_at)], [false, 1, true]);
  assert.deepEqual([s.automation.lead_admission.enabled, s.automation.lead_admission.authority.generation, Boolean(s.automation.lead_admission.authority.revoked_at)], [false, 1, true]);
  // Only the explicit flags arm, each a new generation.
  await run(['arm-desk', '--mandate-days=3', '--workspace', w.root]);
  s = settingsOf(w);
  assert.deepEqual([s.automation.mandate.authority.generation, s.automation.mandate.authority.revoked_at], [2, undefined]);
  assert.equal(MT.mandateOf(reopen(w)).on, true);
  assert.equal(LA.authorityOf(reopen(w)).on, false, 'the mandate\'s arming never arms admission');
});

test('off-only refuses every arming, baseline or collection flag beside it, locally and online, and never picks one', async (t) => {
  const w = await armedDesk(t);
  const tree0 = hashTree(w.root);
  const others = [['--allow=XFIC/USDC'], ['--intent-life=60'], ['--daily-cu=5000'], ['--monthly-cu=100000'], ['--contracts-on'], ['--mandate-days=7'], ['--admission-days=3'], ['--admission-days=3', '--admission-daily=1'], ['--admission-daily=1'], ['--print-schedule']];
  for (const off of [['--mandate-off'], ['--admission-off'], ['--mandate-off', '--admission-off']]) {
    for (const extra of others) {
      for (const desk of [[], ['--dry-run'], ['--desk=online']]) {
        const args = ['arm-desk', ...desk, ...off, ...extra, '--workspace', w.root];
        await assert.rejects(run(args), (e) => e.code === 'USAGE', args.join(' '));
      }
    }
  }
  await assert.rejects(run(['arm-desk', '--mandate-off', '--allow=XFIC/USDC', '--intent-life=60', '--workspace', w.root]), /--mandate-off only turns off; --allow, --intent-life arm or set something/);
  await assert.rejects(run(['arm-desk', '--mandate-off', '--admission-off', '--contracts-on', '--workspace', w.root]), /--mandate-off and --admission-off only turn off; --contracts-on arms or sets something and cannot be given with them/);
  assert.deepEqual(hashTree(w.root), tree0, 'nothing written by any refused mix');
  // Ordinary arming is unchanged: the baseline with its flags still validates.
  assert.equal(A.armPatch({ mandateDays: 7, admissionDays: 2, allow: ['XFIC/USDC'] }).trader.rules.max_validity_minutes, 1440);
});

// The online script, run against a FICTIONAL transport: a fetch that carries
// the script's relative requests to a local desk on a temporary workspace
// (same-origin, as in the signed-in page) and records each one.
function fictionalTransport(port) {
  const calls = [];
  const fetchImpl = (p, opts = {}) => new Promise((resolve, reject) => {
    const method = opts.method || 'GET';
    calls.push([method, p]);
    const headers = { host: `127.0.0.1:${port}`, ...(opts.headers || {}), ...(method === 'POST' ? { origin: `http://127.0.0.1:${port}` } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { const body = Buffer.concat(c).toString(); resolve({ status: res.statusCode, json: async () => JSON.parse(body) }); });
    });
    req.on('error', reject);
    req.end(opts.body);
  });
  return { calls, fetchImpl };
}

test('--desk=online off-only: the script makes the settings write and one read back only, revoking both authorities and nothing else', async (t) => {
  const w = await armedDesk(t);
  const tree0 = hashTree(w.root);
  const out = await run(['arm-desk', '--desk=online', '--mandate-off', '--admission-off', '--workspace', w.root]);
  const text = out._text;
  assert.deepEqual(hashTree(w.root), tree0, 'printing the script wrote nothing');
  const code = text.split('\n').filter((l) => !l.startsWith('//')).join('\n');
  assert.doesNotMatch(code, /exit-quotes|init-defaults|pilot|enroll|contracts|forensics/i, 'no other endpoint in the code');
  assert.doesNotMatch(text, /DESK_INGEST_KEY|XAI_API_KEY|ALCHEMY_API_KEY|passphrase/i);
  assert.deepEqual(JSON.parse(text.match(/body: JSON\.stringify\((\{.*\})\) \}\);/)[1]), OFF_BOTH);
  assert.match(text, /^\/\/ What this does: The paper mandate is off/m);
  // The real command line's --json form (it reads process.argv).
  const cli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'arm-desk', '--desk=online', '--mandate-off', '--admission-off', '--json', '--workspace', w.root], { encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.status, 0, cli.stderr);
  const json = JSON.parse(cli.stdout);
  assert.deepEqual([json.mode, json.patch, json.script], ['off_only', OFF_BOTH, text.trimEnd()]);
  assert.deepEqual(hashTree(w.root), tree0, 'the command line wrote nothing');
  // Run it against the desk.
  const ws = reopen(w);
  const srv = await start(ws, { port: 47990 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const before = settingsOf(w);
  const tr = fictionalTransport(srv.port);
  const logs = [];
  await vm.runInNewContext(text, { fetch: tr.fetchImpl, console: { log: (...a) => logs.push(a) } });
  assert.deepEqual(tr.calls, [['GET', '/api/session'], ['POST', '/api/settings'], ['GET', '/api/index']], 'no other endpoint is asked');
  const [wrote, read] = logs;
  assert.deepEqual([wrote[0], wrote[1].status, wrote[1].body.status], ['arm-desk off', 200, 'saved']);
  const after = settingsOf(w);
  expectOff(before, after);
  assert.equal(read[0], 'read back');
  assert.deepEqual(JSON.parse(JSON.stringify(read[1])), {
    autonomous_paper_loop: false,
    mandate_authority: { generation: 1, armed_at: before.automation.mandate.authority.armed_at, revoked_at: after.automation.mandate.authority.revoked_at, revoked_because: 'loop_off' },
    lead_admission_enabled: false,
    admission_authority: { generation: 1, armed_at: before.automation.lead_admission.authority.armed_at, revoked_at: after.automation.lead_admission.authority.revoked_at, revoked_because: 'off' },
    paused: false,
  });
  assert.equal(MT.mandateOf(ws).on, false);
  assert.equal(LA.authorityOf(ws).on, false);
  // A refused write reads nothing back.
  const bad = fictionalTransport(srv.port);
  const quiet = [];
  await vm.runInNewContext(text.replace("'x-cr-token': s.token", "'x-cr-token': 'FICTIONAL-wrong'"), { fetch: bad.fetchImpl, console: { log: (...a) => quiet.push(a) } });
  assert.deepEqual(bad.calls.map((c) => c[1]), ['/api/session', '/api/settings']);
  assert.notEqual(quiet[0][1].status, 200);
});

// ---------------------------------------------------------------------------
// Phase C step 3: the reviewed admission-only patch (PR #125 audit, finding 3;
// docs/engineering/BOUNDED_PAPER_READINESS.md). The runbook's own validation
// command and console script are read from the markdown and run here, on a
// FICTIONAL desk, through the real Settings validation and application path.

const RUNBOOK = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'engineering', 'BOUNDED_PAPER_READINESS.md'), 'utf8');
const PLACEHOLDER = '<explicit approved ISO timestamp>';
const PATCH_TEXT = `{"automation":{"lead_admission":{"enabled":true,"daily_limit":1,"expires_at":"${PLACEHOLDER}"}}}`;
const RUNBOOK_SCRIPT = (RUNBOOK.match(/```js\n(\/\/ Phase C step 3: admission only\.[\s\S]*?)```/) || [])[1];
const RUNBOOK_VALIDATE = (RUNBOOK.match(/^node -e '([^']+)' \$patch$/m) || [])[1];
const HOUR = 3600000;
const expiryIn = (ms) => new Date(Math.floor((Date.now() + ms) / HOUR) * HOUR).toISOString();
const admissionPatch = (exp) => JSON.parse(PATCH_TEXT.replace(PLACEHOLDER, exp));

// A desk where every value the baseline arm-desk writes is Eric's own, none
// of them the baseline's: the book and fee, the lead policy (off, his own
// thresholds), sizing, the intent life, automatic exit quotes off, the paper
// mandate armed (generation 1) and admission armed once and turned off
// (generation 1, revoked).
async function ownValuesDesk(t) {
  const w = temp(t);
  assert.equal((await run(['arm-desk', '--mandate-days=7', '--admission-days=5', '--admission-daily=2', '--allow=XFIC/USDC', '--intent-life=4320', '--workspace', w.root])).status, 'saved');
  assert.equal((await run(['arm-desk', '--admission-off', '--workspace', w.root])).verified, true);
  applySettings(reopen(w), {
    automation: { exit_quotes_auto: false },
    leads: { enabled: false, min_market_cap_usd: 9000000, min_volume_24h_usd: 400000, max_sell_tax_pct: 3, eligibility_hours: 24 },
    tickets: { sizing: { min_grade_new_entry: 60 } },
    trader: { book: { cash_usd: '40000', fee_rate: '0.002' } },
  }, 'FICTIONAL: own values');
  const s = settingsOf(w);
  assert.deepEqual([s.trader.book, s.trader.rules.max_validity_minutes, s.leads.enabled, s.leads.min_market_cap_usd, s.tickets.sizing.min_grade_new_entry, s.automation.exit_quotes_auto], [{ cash_usd: '40000', fee_rate: '0.002' }, 4320, false, 9000000, 60, false]);
  assert.deepEqual([s.automation.lead_admission.enabled, s.automation.lead_admission.daily_limit, s.automation.lead_admission.authority.generation, s.automation.lead_admission.authority.revoked_because], [false, 2, 1, 'off']);
  assert.equal(MT.mandateOf(reopen(w)).on, true);
  assert.equal(LA.authorityOf(reopen(w)).on, false);
  return w;
}

test('admission-only patch: the Settings path arms admission alone, as a new generation; the book, fee, lead policy, sizing, intent life, other automation and the mandate are as they were', async (t) => {
  assert.ok(RUNBOOK.includes(PATCH_TEXT), 'the runbook carries the reviewed patch verbatim');
  const w = await ownValuesDesk(t);
  const ws = reopen(w);
  const exp = expiryIn(3 * 24 * HOUR);
  const patch = admissionPatch(exp);
  const tree0 = hashTree(w.root);
  // Prepare and validate: the desk's own validator returns it unchanged and writes nothing.
  assert.deepEqual(validateSettingsPatch(JSON.parse(JSON.stringify(patch)), ws), patch);
  assert.deepEqual(hashTree(w.root), tree0, 'validation wrote nothing');
  const before = settingsOf(w);
  applySettings(ws, patch, 'FICTIONAL: Phase C admission-only patch');
  const after = settingsOf(w);
  const au = after.automation.lead_admission.authority;
  const want = JSON.parse(JSON.stringify(before));
  want.automation.lead_admission = { ...before.automation.lead_admission, enabled: true, daily_limit: 1, expires_at: exp, authority: au };
  assert.deepEqual(after, want, 'only admission\'s three values and its authority changed');
  assert.deepEqual(Object.keys(au).sort(), ['armed_at', 'armed_by', 'generation', 'policy_sha256', 'version']);
  assert.deepEqual([au.version, au.generation], ['cr-lead-admission-authority@1', 2], 'a new generation after the revoked one');
  assert.match(au.armed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(au.policy_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(after.automation.mandate, before.automation.mandate, 'the paper mandate and its authority are untouched');
  assert.equal(after.automation.autonomous_paper_loop, before.automation.autonomous_paper_loop);
  const files = changed(tree0, hashTree(w.root));
  assert.ok(files.includes('config/settings.json'));
  const others = files.filter((f) => f !== 'config/settings.json');
  assert.ok(others.every((f) => OP_RECORD.test(f)), `only the settings and the write's own operation records changed: ${others.join(', ')}`);
  // Read back: admission authority, generation, expiry and daily limit.
  const a = LA.authorityOf(reopen(w));
  assert.deepEqual([a.on, a.generation, a.values.enabled, a.values.daily_limit, a.values.expires_at, a.policy_sha256], [true, 2, true, 1, exp, au.policy_sha256]);
  const m = MT.mandateOf(reopen(w));
  assert.equal(m.on, true, 'the mandate is still on, apart from admission');
  // The same patch again records no new generation.
  applySettings(reopen(w), patch, 'FICTIONAL: the same patch again');
  assert.deepEqual(settingsOf(w).automation.lead_admission.authority, au);
});

test('admission-only patch: the runbook\'s validation command passes the prepared patch unchanged and refuses the placeholder, a past expiry and one over 30 days', (t) => {
  assert.ok(RUNBOOK_VALIDATE, 'the runbook carries the validation command');
  const repo = path.join(__dirname, '..', '..');
  const validate = (text) => require('child_process').spawnSync(process.execPath, ['-e', RUNBOOK_VALIDATE, text], { cwd: repo, encoding: 'utf8', timeout: 60000 });
  const good = PATCH_TEXT.replace(PLACEHOLDER, expiryIn(3 * 24 * HOUR));
  const ok = validate(good);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), good, 'the patch exactly as prepared');
  for (const [name, text, why] of [
    ['the placeholder', PATCH_TEXT, /expires_at must be an ISO-8601 UTC time/],
    ['a past expiry', PATCH_TEXT.replace(PLACEHOLDER, '2026-10-01T00:00:00.000Z'), /must be in the future/],
    ['31 days ahead', PATCH_TEXT.replace(PLACEHOLDER, expiryIn(31 * 24 * HOUR)), /at most 30 days ahead/],
    ['a limit of 4', PATCH_TEXT.replace(PLACEHOLDER, expiryIn(3 * 24 * HOUR)).replace('"daily_limit":1', '"daily_limit":4'), /from 0 to 3/],
    ['another key', PATCH_TEXT.replace(PLACEHOLDER, expiryIn(3 * 24 * HOUR)).replace('"enabled":true', '"enabled":true,"authority":{}'), /has no setting authority/],
    ['an expiry the desk would rewrite', PATCH_TEXT.replace(PLACEHOLDER, expiryIn(3 * 24 * HOUR).replace('.000Z', 'Z')), /the validator changed it/],
  ]) {
    const r = validate(text);
    assert.equal(r.status, 1, `${name}: refused`);
    assert.match(r.stderr, why, name);
  }
});

test('admission-only patch: the runbook\'s console script, on a signed-in FICTIONAL desk, sends nothing with the placeholder; with an approved time it writes admission alone and reads back its authority and no unrelated change', async (t) => {
  assert.ok(RUNBOOK_SCRIPT, 'the runbook carries the console script');
  assert.ok(RUNBOOK_SCRIPT.includes(`const PATCH = ${PATCH_TEXT};`), 'the script posts the reviewed patch');
  assert.doesNotMatch(RUNBOOK_SCRIPT, /exit-quotes|init-defaults|pilot|enroll|contracts|forensics|DESK_INGEST_KEY|XAI_API_KEY|ALCHEMY_API_KEY|passphrase/i);
  const w = await ownValuesDesk(t);
  const ws = reopen(w);
  const srv = await start(ws, { port: 47980 + Math.floor(Math.random() * 9), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  // As written: nothing is asked of the desk.
  const idle = fictionalTransport(srv.port);
  const said = [];
  await vm.runInNewContext(RUNBOOK_SCRIPT, { fetch: idle.fetchImpl, console: { log: (...a) => said.push(a) } });
  assert.deepEqual(idle.calls, [], 'the placeholder sends nothing');
  assert.match(String(said[0][0]), /Set the approved expiry first.+Nothing was sent/);
  // With Eric's approved time.
  const exp = expiryIn(3 * 24 * HOUR);
  const before = settingsOf(w);
  const tree0 = hashTree(w.root);
  const tr = fictionalTransport(srv.port);
  const logs = [];
  await vm.runInNewContext(RUNBOOK_SCRIPT.replace(PLACEHOLDER, exp), { fetch: tr.fetchImpl, console: { log: (...a) => logs.push(a) } });
  assert.deepEqual(tr.calls, [['GET', '/api/session'], ['GET', '/api/index'], ['POST', '/api/settings'], ['GET', '/api/index']], 'no other endpoint is asked');
  const [wrote, read] = logs.map((l) => JSON.parse(JSON.stringify(l)));
  assert.deepEqual([wrote[0], wrote[1].status, wrote[1].body.status], ['admission patch', 200, 'saved']);
  const after = settingsOf(w);
  const au = after.automation.lead_admission.authority;
  assert.equal(read[0], 'read back');
  const { changed: names, ...shown } = read[1];
  assert.deepEqual(shown, {
    enabled: true,
    daily_limit: 1,
    expires_at: exp,
    paused: false,
    authority: { generation: 2, armed_at: au.armed_at, policy_sha256: au.policy_sha256, revoked_at: null },
    unrelated_changed: [],
    mandate_unchanged: true,
  });
  assert.ok(names.every((k) => k.startsWith('automation.lead_admission.')), names.join(', '));
  for (const k of ['enabled', 'daily_limit', 'expires_at', 'authority.generation', 'authority.armed_at', 'authority.policy_sha256', 'authority.revoked_at']) assert.ok(names.includes(`automation.lead_admission.${k}`), `${k} is named as changed`);
  const want = JSON.parse(JSON.stringify(before));
  want.automation.lead_admission = { ...before.automation.lead_admission, enabled: true, daily_limit: 1, expires_at: exp, authority: au };
  assert.deepEqual(after, want, 'on disk: admission alone');
  // Besides the settings write's own records, the server rebuilds its derived
  // index after a settings write (POST /api/settings, rebuild(['config'])).
  const others = changed(tree0, hashTree(w.root)).filter((f) => f !== 'config/settings.json' && f !== 'dashboard/index/index.json');
  assert.ok(others.every((f) => OP_RECORD.test(f)), `only the settings, the write's own operation records and the derived index changed: ${others.join(', ')}`);
  assert.equal(LA.authorityOf(reopen(w)).on, true);
  assert.equal(MT.mandateOf(reopen(w)).on, true);
});

test('the earlier Phase C step (arm-desk --admission-days=N --admission-daily=1) is a baseline arming: it resets the book, fee, lead policy, sizing, intent life and exit quotes, and online it posts more than settings', async (t) => {
  const w = await ownValuesDesk(t);
  const before = settingsOf(w);
  const online = await run(['arm-desk', '--desk=online', '--admission-days=3', '--admission-daily=1', '--workspace', w.root]);
  assert.match(online._text, /post\('\/api\/forensics\/exit-quotes\/auto', \{\}\)/);
  assert.match(online._text, /post\('\/api\/contracts\/init-defaults', \{\}\)/);
  const out = await run(['arm-desk', '--admission-days=3', '--admission-daily=1', '--workspace', w.root]);
  assert.equal(out.status, 'saved', 'without --desk=online it writes this local workspace');
  const after = settingsOf(w);
  assert.deepEqual(after.trader.book, { cash_usd: '25000', fee_rate: '0.001' }, 'the book and fee were reset');
  assert.notDeepEqual(after.trader.book, before.trader.book);
  assert.equal(after.trader.rules.max_validity_minutes, 1440, 'the intent life went back to 1440');
  assert.equal(after.leads.enabled, true, 'the lead policy was turned on');
  assert.equal(after.leads.min_market_cap_usd, 5000000, 'its thresholds reset');
  assert.equal(after.tickets.sizing.min_grade_new_entry, 50, 'sizing reset');
  assert.equal(after.automation.exit_quotes_auto, true, 'automatic exit quotes turned on');
});
