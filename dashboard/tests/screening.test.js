'use strict';
// Contract screening (core/screening.js, core/chains.js): what is screened and
// what is not, GoPlus's flags as present / absent / unknown, failures and the
// shared gate, backoff and budget, the alert transitions, and the evidence
// block prepared for research. Every GoPlus answer here is a stub with
// FICTIONAL contracts and values, the clock is fixed, and global fetch is
// replaced by one that fails, so nothing is ever sent anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace } = require('./helpers');
const screening = require('../core/screening');
const chains = require('../core/chains');
const projects = require('../core/projects');
const jobs = require('../core/jobs');
const { buildIndex, projectDetail } = require('../core/indexer');

const NOW = Date.parse('2026-10-04T15:00:00Z');
const HOUR = 3600000;
const DAY = 86400000;
const FAST = { retryDelayMs: 0, pauseMs: 0 };
const EVM_A = '0x00000000000000000000000000000000000fc001';
const EVM_B = '0x00000000000000000000000000000000000fc002';
const SOL_MINT = 'F1ct1onaLM1nt1111111111111111111111111111111';

function workspace(t, label, settings = {}) {
  const { ws, root, cleanup } = tempWorkspace(label, settings);
  t.after(cleanup);
  // Nothing in these tests may reach the network.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  return { ws, root };
}

function addProject(ws, { name = 'Example Token (FICTIONAL)', symbol = 'XTKN', assets = [{ chain: 'ethereum', contract_address: EVM_A }], extra = {} } = {}) {
  const host = `${symbol.toLowerCase()}.example`;
  const out = projects.addProject(ws, {
    name,
    symbol,
    official_website: `https://${host}/`,
    coingecko_id: `${symbol.toLowerCase()}-fictional`,
    assets,
    evidence: [{ url: `https://${host}/docs`, note: 'fictional test evidence' }],
    sector: 'defi',
    ...extra,
  });
  assert.equal(out.status, 'created', out.message);
  return out.project_id;
}

const reply = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});

// A GoPlus token_security answer for one address.
const goplus = (address, fields, code = 1) => reply(200, { code, message: 'OK', result: { [address.toLowerCase()]: fields } });

// A clean EVM record: every flag answered "0", the owner renounced, no tax.
const CLEAN = {
  is_mintable: '0', is_proxy: '0', is_blacklisted: '0', is_whitelisted: '0', owner_change_balance: '0', hidden_owner: '0',
  selfdestruct: '0', external_call: '0', can_take_back_ownership: '0', transfer_pausable: '0', trading_cooldown: '0',
  is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', slippage_modifiable: '0', personal_slippage_modifiable: '0',
  is_anti_whale: '0', is_open_source: '1', buy_tax: '0', sell_tax: '0', owner_address: '0x0000000000000000000000000000000000000000',
  holder_count: '12345', lp_holder_count: '67', is_in_dex: '1', trust_list: '0', token_name: 'Example Token (FICTIONAL)', token_symbol: 'XTKN',
};

// A stub GoPlus: answers by URL (an answer, a function, or an Error to throw)
// and keeps every URL it was asked for.
function stub(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    const a = typeof answer === 'function' ? await answer(url, init, calls) : answer;
    if (a instanceof Error) throw a;
    return a;
  };
  f.calls = calls;
  return f;
}

const project = (ws, id) => projects.getProject(ws, id);
const refresh = (ws, f, extra = {}) => screening.refresh(ws, { fetchImpl: f, now: NOW, ...FAST, ...extra });

// Every string in a value, at any depth (keys and values).
function stringsOf(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); stringsOf(x, out); }
  return out;
}

// ---------------------------------------------------------------------------
// Chains and addresses

test('chains: identity chain names map to GoPlus chain IDs; unknown names and malformed addresses are never guessed', () => {
  assert.equal(chains.chainInfo('ethereum').chain_id, '1');
  assert.equal(chains.chainInfo(' BSC ').chain_id, '56');
  assert.equal(chains.chainInfo('bnb-chain').chain_id, '56');
  assert.equal(chains.chainInfo('base').chain_id, '8453');
  assert.equal(chains.chainInfo('8453').label, 'Base');
  assert.equal(chains.chainInfo('solana').family, 'solana');
  assert.equal(chains.chainInfo('tron').family, 'tron');
  assert.equal(chains.chainInfo('example-chain'), null);
  assert.equal(chains.chainInfo('ethereum-classic'), null, 'a similar name is not the chain');
  assert.equal(chains.chainInfo(''), null);
  assert.equal(chains.chainInfo(null), null);
  assert.ok(chains.addressFits('evm', EVM_A));
  assert.ok(!chains.addressFits('evm', '0x123'));
  assert.ok(!chains.addressFits('evm', SOL_MINT));
  assert.ok(chains.addressFits('solana', SOL_MINT));
  assert.ok(!chains.addressFits('solana', EVM_A));
  assert.ok(!chains.addressFits('solana', 'O0Il' + SOL_MINT.slice(4)), 'characters base58 leaves out');
  assert.equal(chains.addressKey('evm', '0xABCdef0000000000000000000000000000000001'), '0xabcdef0000000000000000000000000000000001');
  assert.equal(chains.addressKey('solana', SOL_MINT), SOL_MINT, 'base58 keeps its case');
});

test('identity records keep the chain ID beside each contract (null for a chain not listed) and native_chain only when stated', (t) => {
  const { ws } = workspace(t, 'scr-identity');
  const id = addProject(ws, { assets: [{ chain: 'Base', contract_address: EVM_A }, { chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT' }] });
  const p = project(ws, id);
  assert.deepEqual(p.identity.assets.map((a) => [a.chain, a.chain_id, a.contract_address]), [['base', '8453', EVM_A], ['example-chain', null, 'FICTIONAL-CONTRACT']]);
  assert.equal('native_chain' in p.identity, false, 'nothing stated, nothing stored');

  const coin = addProject(ws, { name: 'Zeta Ledger (FICTIONAL)', symbol: 'XCC', assets: [], extra: { native_chain: true } });
  assert.equal(project(ws, coin).identity.native_chain, true);
  // Carried through an identity change that does not mention it; changed only explicitly.
  projects.updateIdentity(ws, coin, { evidence: [{ url: 'https://xcc.example/more', note: 'fictional' }] });
  assert.equal(project(ws, coin).identity.native_chain, true);
  projects.updateIdentity(ws, coin, { native_chain: false });
  assert.equal(project(ws, coin).identity.native_chain, false);
  projects.updateIdentity(ws, coin, { native_chain: null });
  assert.equal('native_chain' in project(ws, coin).identity, false);
  assert.throws(() => projects.updateIdentity(ws, coin, { native_chain: 'yes' }), /native_chain must be true or false/);
});

// ---------------------------------------------------------------------------
// Normalization (pure)

test('normalization: "1" is present, "0" absent, anything else unknown; taxes are percentages; nothing is ever called safe', () => {
  assert.equal(screening.tri('1'), 'present');
  assert.equal(screening.tri(0), 'absent');
  assert.equal(screening.tri(undefined), 'unknown');
  assert.equal(screening.tri(''), 'unknown');
  assert.equal(screening.taxPct('0.1'), 10);
  assert.equal(screening.taxPct('0.0525'), 5.25);
  assert.equal(screening.taxPct(''), null);
  assert.equal(screening.taxPct('abc'), null);
  const n = screening.normalizeEvm({ is_mintable: '1', owner_address: '', other_potential_risks: 'line\u0000one\n\ntwo' });
  assert.equal(n.checks.mint, 'present');
  assert.equal(n.checks.proxy, 'unknown', 'a field GoPlus leaves out is unknown, never absent');
  assert.equal(n.owner.state, 'none');
  assert.equal(n.notes.other_potential_risks, 'line one two', 'GoPlus text is cleaned');
  assert.equal(screening.normalizeEvm({ owner_address: '0x000000000000000000000000000000000000dEaD' }).owner.state, 'renounced');
  assert.equal(screening.normalizeEvm({ owner_address: EVM_B }).owner.address, EVM_B);
  const s = screening.normalizeSolana({ mintable: { status: '1', authority: [{ address: 'x' }] }, freezable: { status: '0' }, transfer_hook: [], transfer_fee: { current_fee_rate: '0.02' } });
  assert.equal(s.checks.mint, 'present');
  assert.equal(s.checks.freeze, 'absent');
  assert.equal(s.checks.closable, 'unknown');
  assert.equal(s.checks.transfer_hook, 'absent');
  assert.equal(s.taxes.transfer_fee_pct, 2);
  for (const v of [n, s, screening.normalizeEvm(CLEAN)]) assert.ok(!stringsOf(v).some((x) => /\bsafe\b/i.test(x)), 'no "safe" anywhere');
});

test('a Solana transfer fee is read as GoPlus documents it (liquidity@4, D2): an empty object is none, the rate an object, every scheduled rate kept', () => {
  const fee = (transfer_fee) => screening.normalizeSolana(transfer_fee === undefined ? {} : { transfer_fee }).taxes;
  // A classic SPL token (GoPlus answered {} for USDC, 2026-10-28): no fee configured.
  assert.deepEqual(fee({}), { buy_pct: null, sell_pct: null, transfer_fee_pct: 0, transfer_fee_scheduled_max_pct: 0 });
  // A Token-2022 mint with its fee at 0 now and scheduled (PYUSD's shape).
  assert.deepEqual([fee({ current_fee_rate: { fee_rate: '0', maximum_fee: '0' }, scheduled_fee_rate: [{ epoch: '605', fee_rate: '0', maximum_fee: '0' }] }).transfer_fee_pct, fee({ current_fee_rate: { fee_rate: '0' }, scheduled_fee_rate: [{ epoch: '605', fee_rate: '0' }] }).transfer_fee_scheduled_max_pct], [0, 0]);
  const rising = fee({ current_fee_rate: { fee_rate: '0.01', maximum_fee: '5000' }, scheduled_fee_rate: [{ epoch: '700', fee_rate: '0.03' }, { epoch: '650', fee_rate: '0.02' }] });
  assert.deepEqual([rising.transfer_fee_pct, rising.transfer_fee_scheduled_max_pct], [1, 3], 'the rate now, and the highest scheduled one');
  // Not stated, or not readable: unknown, never 0.
  assert.deepEqual([fee(undefined).transfer_fee_pct, fee(undefined).transfer_fee_scheduled_max_pct], [null, null]);
  assert.deepEqual([fee(null).transfer_fee_pct, fee([]).transfer_fee_pct], [null, null]);
  assert.equal(fee({ scheduled_fee_rate: [] }).transfer_fee_pct, null, 'an object without the rate now is not "none"');
  assert.equal(fee({ current_fee_rate: { fee_rate: 'x' } }).transfer_fee_pct, null);
  assert.equal(fee({ current_fee_rate: { fee_rate: '0' }, scheduled_fee_rate: [{ epoch: '1' }] }).transfer_fee_scheduled_max_pct, null, 'one unreadable scheduled rate makes the schedule unknown');
});

// ---------------------------------------------------------------------------
// Screening runs

test('a standard token: one request to the fixed GoPlus URL, every flag absent, the owner renounced, nothing severe, and the block labeled as captured by the dashboard', async (t) => {
  const { ws } = workspace(t, 'scr-clean');
  const id = addProject(ws);
  const f = stub(goplus(EVM_A, CLEAN));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.deepEqual(r.screened, [id]);
  assert.deepEqual(f.calls, [`https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${EVM_A}`]);
  const s = screening.stateFor(ws, project(ws, id), NOW);
  assert.equal(s.state, 'fresh');
  const c = s.snapshot.contracts[0];
  assert.equal(c.status, 'ok');
  assert.equal(c.chain_id, '1');
  assert.ok(Object.values(c.checks).every((v) => v === 'absent'), JSON.stringify(c.checks));
  assert.deepEqual(c.severe, []);
  assert.deepEqual(c.watch, []);
  assert.deepEqual(c.taxes, { buy_pct: 0, sell_pct: 0 });
  assert.equal(c.owner.state, 'renounced');
  assert.equal(c.source, 'open');
  assert.equal(c.facts.holder_count, 12345);

  const block = screening.packetBlock(ws, project(ws, id), { now: NOW });
  assert.match(block.note, /captured by the dashboard, not checked in your session/);
  assert.equal(block.mode, 'include');
  assert.equal(screening.includeInPacket(ws), true, 'research packets carry it (Stage 1.5 C2)');
  assert.ok(!stringsOf(block).some((x) => /\bsafe\b/i.test(x)));
  const sum = screening.summary(ws, project(ws, id), NOW);
  assert.deepEqual([sum.state, sum.contracts[0].mint, sum.contracts[0].blacklist, sum.contracts[0].proxy], ['fresh', 'absent', 'absent', 'absent']);
  assert.deepEqual(sum.alerts, []);
  // Not due again until refresh_hours.
  assert.equal(screening.isDue(ws, NOW + HOUR), false);
  assert.equal(screening.isDue(ws, NOW + 169 * HOUR), true);
});

test('a malicious token: honeypot, mint and blacklist flags raised as GoPlus answered them, the sell tax kept as a percentage, a missing field unknown', async (t) => {
  const { ws } = workspace(t, 'scr-honeypot');
  const id = addProject(ws, { name: 'Trap Token (FICTIONAL)', symbol: 'TRAP' });
  const { is_proxy: _left, ...rest } = CLEAN; // eslint-disable-line no-unused-vars
  const f = stub(goplus(EVM_A, { ...rest, is_mintable: '1', is_blacklisted: '1', is_honeypot: '1', cannot_sell_all: '1', owner_change_balance: '1', sell_tax: '0.99', owner_address: EVM_B, is_open_source: '0' }));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const c = screening.stateFor(ws, project(ws, id), NOW).snapshot.contracts[0];
  assert.equal(c.checks.mint, 'present');
  assert.equal(c.checks.blacklist, 'present');
  assert.equal(c.checks.honeypot, 'present');
  assert.equal(c.checks.proxy, 'unknown');
  assert.deepEqual(c.severe.sort(), ['Cannot sell the whole balance', 'Honeypot', 'Owner can change balances']);
  assert.deepEqual(c.watch.sort(), ['Blacklist', 'Mint function']);
  assert.equal(c.unknown, 1);
  assert.equal(c.taxes.sell_pct, 99);
  assert.equal(c.owner.state, 'present');
  assert.equal(c.owner.address, EVM_B);
  assert.equal(c.source, 'closed');
  const sum = screening.summary(ws, project(ws, id), NOW).contracts[0];
  assert.deepEqual([sum.mint, sum.blacklist, sum.proxy, sum.sell_tax_pct], ['present', 'present', 'unknown', 99]);
  assert.equal(screening.summary(ws, project(ws, id), NOW).alerts.length, 0, 'a first screen is not a change');
});

test('Solana uses its own endpoint; mint and freeze authorities are read from their status', async (t) => {
  const { ws } = workspace(t, 'scr-solana');
  const id = addProject(ws, { name: 'Example Sol Token (FICTIONAL)', symbol: 'XSOL', assets: [{ chain: 'solana', contract_address: SOL_MINT }] });
  const f = stub(reply(200, { code: 1, message: 'OK', result: { [SOL_MINT]: { mintable: { status: '0', authority: [] }, freezable: { status: '1', authority: [{ address: 'FICTIONAL' }] }, closable: { status: '0' }, balance_mutable_authority: { status: '0' }, metadata_mutable: { status: '1' }, transfer_hook: [], non_transferable: '0', trusted_token: 0 } } }));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.deepEqual(f.calls, [`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${SOL_MINT}`]);
  const sum = screening.summary(ws, project(ws, id), NOW).contracts[0];
  assert.deepEqual([sum.mint, sum.blacklist, sum.proxy], ['absent', 'present', null], 'freeze authority stands where a blacklist would; Solana has no proxy flag');
});

test('a native-chain coin is bypassed gracefully: no request, its own state, and a project without a contract is never assumed native', async (t) => {
  const { ws } = workspace(t, 'scr-native');
  const coin = addProject(ws, { name: 'Example Chain Coin (FICTIONAL)', symbol: 'XCC', assets: [{ chain: 'example-chain', contract_address: null }], extra: { native_chain: true } });
  const plain = addProject(ws, { name: 'Example No Contract (FICTIONAL)', symbol: 'XNC', assets: [] });
  const f = stub(new Error('must not be called'));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'noop', r.message);
  assert.equal(f.calls.length, 0);
  assert.equal(screening.isDue(ws, NOW), false);
  const a = screening.stateFor(ws, project(ws, coin), NOW);
  assert.equal(a.state, 'native_chain');
  assert.equal(a.native, true);
  const b = screening.stateFor(ws, project(ws, plain), NOW);
  assert.equal(b.state, 'no_contract');
  assert.equal(b.native, false);
  assert.equal(screening.packetBlock(ws, project(ws, coin), { now: NOW }).native_chain, true);
  assert.equal(screening.packetBlock(ws, project(ws, plain), { now: NOW }).native_chain, false);
  // A forced, named refresh of either is still a no-op.
  assert.equal((await refresh(ws, f, { force: true, projectIds: [coin, plain] })).status, 'noop');
  assert.equal(f.calls.length, 0);
});

test('chains GoPlus does not list and malformed addresses cost no request; a screenable contract beside them is screened and they are recorded as not screenable', async (t) => {
  const { ws } = workspace(t, 'scr-unsupported');
  const only = addProject(ws, { name: 'Elsewhere Token (FICTIONAL)', symbol: 'XELS', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XELS' }, { chain: 'ethereum', contract_address: '0x1234' }] });
  const mixed = addProject(ws, { name: 'Mixed Token (FICTIONAL)', symbol: 'XMIX', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMIX' }, { chain: 'base', contract_address: EVM_B }] });
  const s = screening.stateFor(ws, project(ws, only), NOW);
  assert.equal(s.state, 'unsupported');
  assert.match(s.reason, /GoPlus does not screen tokens on example-chain/);
  assert.match(s.reason, /does not have the shape of a Ethereum address/);
  const f = stub(goplus(EVM_B, CLEAN));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  assert.deepEqual(r.screened, [mixed], 'the unsupported-only project is not attempted');
  assert.deepEqual(f.calls, [`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${EVM_B}`]);
  const m = screening.stateFor(ws, project(ws, mixed), NOW).snapshot.contracts;
  assert.deepEqual(m.map((c) => c.status), ['unsupported_chain', 'ok']);
  assert.throws(() => screening.screenUrl({ screenable: true, family: 'evm', chain_id: '1', address: '0x1234' }), /Not a screenable contract/);
});

test('GoPlus with no record of a contract is "not_found", never a clean screen; an unknown GoPlus code is recorded as refused', async (t) => {
  const { ws } = workspace(t, 'scr-notfound');
  const id = addProject(ws, { assets: [{ chain: 'ethereum', contract_address: EVM_A }, { chain: 'base', contract_address: EVM_B }] });
  const f = stub((url) => (url.includes('/1?') ? reply(200, { code: 1, message: 'OK', result: {} }) : reply(200, { code: 2004, message: 'contract address not supported' })));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'ok', r.message);
  const c = screening.stateFor(ws, project(ws, id), NOW).snapshot.contracts;
  assert.deepEqual(c.map((x) => x.status), ['not_found', 'refused']);
  assert.match(c[1].reason, /code 2004: contract address not supported/);
  assert.equal(screening.summary(ws, project(ws, id), NOW).contracts[0].mint, undefined, 'no flags for a contract without a screen');
});

// ---------------------------------------------------------------------------
// Failures, the gate, the budget

test('a transient 500 is retried once and the screen saved; a network error or repeated 500 never throws, keeps the last good screen and backs off', async (t) => {
  const { ws } = workspace(t, 'scr-500');
  const id = addProject(ws);
  let n = 0;
  const flaky = stub(() => (++n === 1 ? reply(500, 'Internal Server Error') : goplus(EVM_A, CLEAN)));
  const r1 = await refresh(ws, flaky);
  assert.equal(r1.status, 'ok', r1.message);
  assert.equal(flaky.calls.length, 2);
  assert.equal(r1.requests, 2);

  // Eight days later both attempts fail: the old screen stays, marked.
  const later = NOW + 8 * DAY;
  const down = stub(reply(503, 'Service Unavailable'));
  const r2 = await refresh(ws, down, { now: later });
  assert.equal(r2.status, 'failed');
  assert.match(r2.message, /HTTP 503 \(after 2 attempts\)/);
  const s = screening.stateFor(ws, project(ws, id), later);
  assert.equal(s.state, 'fresh_last_failed');
  assert.equal(s.snapshot.contracts[0].status, 'ok');
  assert.match(screening.summary(ws, project(ws, id), later).last_error, /HTTP 503/);
  // The desk backs off: an unforced run waits, a forced one goes.
  assert.equal((await refresh(ws, down, { now: later + 60000 })).status, 'backoff');
  const offline = stub(new TypeError('fetch failed'));
  const r3 = await refresh(ws, offline, { now: later + 60000, force: true });
  assert.equal(r3.status, 'failed');
  assert.match(r3.message, /the request failed: fetch failed/);
  assert.equal(offline.calls.length, 2);
  assert.equal(screening.overview(ws, later + 60000).consecutive_failures, 2);
  // An unreadable answer counts as a failure too, never as a screen.
  const garbled = stub(reply(200, '<html>maintenance</html>'));
  const r4 = await refresh(ws, garbled, { now: later + 2 * HOUR, force: true });
  assert.equal(r4.status, 'failed');
  assert.match(r4.message, /not a GoPlus result/);
  assert.equal(screening.stateFor(ws, project(ws, id), later + 2 * HOUR).snapshot.contracts[0].status, 'ok');
});

test('a 429 stops the run at once, honors Retry-After and shuts the gate for every runner, forced or not; GoPlus code 4029 does the same', async (t) => {
  const { ws } = workspace(t, 'scr-429');
  addProject(ws, { name: 'First Token (FICTIONAL)', symbol: 'XONE' });
  const second = addProject(ws, { name: 'Second Token (FICTIONAL)', symbol: 'XTWO', assets: [{ chain: 'base', contract_address: EVM_B }] });
  const f = stub(reply(429, 'Too Many Requests', { 'retry-after': '120' }));
  const r = await refresh(ws, f);
  assert.equal(r.status, 'failed');
  assert.equal(r.rate_limited, true);
  assert.equal(r.retry_at, new Date(NOW + 120000).toISOString());
  assert.equal(f.calls.length, 1, 'no retry into a rate limit, and the next project is not attempted');
  assert.ok(r.not_screened.some((x) => x.project_id === second && x.outcome === 'not_attempted'));
  const blocked = await refresh(ws, f, { now: NOW + 60000, force: true });
  assert.equal(blocked.status, 'backoff');
  assert.equal(blocked.rate_limited, true);
  assert.equal(f.calls.length, 1);
  assert.equal(screening.isDue(ws, NOW + 60000), false);
  assert.equal(screening.overview(ws, NOW + 60000).rate_limited, true);

  // A wait longer than backoff_max_minutes (12 h) is honored in full.
  const { ws: ws3 } = workspace(t, 'scr-429-long');
  addProject(ws3);
  const day = await refresh(ws3, stub(reply(429, 'Too Many Requests', { 'retry-after': '86400' })));
  assert.equal(day.retry_at, new Date(NOW + DAY).toISOString());
  assert.equal((await refresh(ws3, f, { now: NOW + 13 * HOUR, force: true })).status, 'backoff');

  const { ws: ws2 } = workspace(t, 'scr-4029');
  addProject(ws2);
  const g = stub(reply(200, { code: 4029, message: 'request limit reached', result: {} }));
  const r2 = await refresh(ws2, g);
  assert.equal(r2.rate_limited, true);
  assert.equal(g.calls.length, 1);
  assert.equal((await refresh(ws2, g, { now: NOW + 30000 })).status, 'backoff');
});

test('the monthly request budget pauses screening before it is exceeded, and the per-run cap takes whole projects', async (t) => {
  const { ws } = workspace(t, 'scr-budget', { screening: { monthly_request_budget: 2, max_contracts_per_run: 1 } });
  addProject(ws, { name: 'First Token (FICTIONAL)', symbol: 'XONE' });
  addProject(ws, { name: 'Second Token (FICTIONAL)', symbol: 'XTWO', assets: [{ chain: 'base', contract_address: EVM_B }] });
  addProject(ws, { name: 'Third Token (FICTIONAL)', symbol: 'XTRI', assets: [{ chain: 'polygon', contract_address: '0x00000000000000000000000000000000000fc003' }] });
  const f = stub((url) => goplus(new URL(url).searchParams.get('contract_addresses'), CLEAN));
  const r1 = await refresh(ws, f);
  assert.equal(r1.screened.length, 1, 'one contract per run');
  const r2 = await refresh(ws, f);
  assert.equal(r2.screened.length, 1);
  const r3 = await refresh(ws, f);
  assert.equal(r3.status, 'budget_paused', r3.message);
  assert.equal(f.calls.length, 2);
  assert.equal(screening.overview(ws, NOW).calls.month_count, 2);
});

test('settings can turn screening off: no request, the state says so', async (t) => {
  const { ws } = workspace(t, 'scr-off', { screening: { enabled: false } });
  const id = addProject(ws);
  const f = stub(new Error('must not be called'));
  assert.equal((await refresh(ws, f)).status, 'skipped');
  assert.equal(screening.isDue(ws, NOW), false);
  assert.equal(screening.stateFor(ws, project(ws, id), NOW).state, 'disabled');
  // The contract on record is still listed, as not screened, never as none.
  const sum = screening.summary(ws, project(ws, id), NOW);
  assert.deepEqual(sum.contracts.map((c) => [c.label, c.address, c.status]), [['Ethereum', EVM_A, 'not_screened']]);
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Alert transitions

test('alerts only on severe structural changes between two good screens: mint, proxy and blacklist newly present, sell tax crossing 10%; unknown to present is not a change', async (t) => {
  const { ws } = workspace(t, 'scr-transitions');
  const id = addProject(ws);
  const { is_proxy: _p, ...noProxy } = CLEAN; // eslint-disable-line no-unused-vars
  await refresh(ws, stub(goplus(EVM_A, { ...noProxy, sell_tax: '0.05' })));
  const later = NOW + 8 * DAY;
  const r = await refresh(ws, stub(goplus(EVM_A, { ...CLEAN, is_mintable: '1', is_blacklisted: '1', is_proxy: '1', sell_tax: '0.15', hidden_owner: '1' })), { now: later });
  assert.equal(r.status, 'ok', r.message);
  assert.equal(r.alerts, 3);
  const alerts = screening.summary(ws, project(ws, id), later).alerts;
  assert.deepEqual(alerts.map((a) => a.check).sort(), ['blacklist', 'mint', 'sell_tax'], 'proxy was unknown before: no alert; hidden owner is not an alert check');
  const tax = alerts.find((a) => a.check === 'sell_tax');
  assert.deepEqual([tax.from, tax.to], ['5%', '15%']);

  // The review queue shows them as a contract change, within alert_days.
  const idx = buildIndex(ws, { now: later });
  const items = (idx.attention || []).filter((x) => x.kind === 'contract_change' && x.project_id === id);
  assert.equal(items.length, 1, JSON.stringify(idx.attention));
  assert.equal(items[0].severity, 'high');
  assert.match(items[0].title, /token contract now has a mint function \(\+2 more\)/);
  assert.match(items[0].detail, /sell tax rose to 15%/);
  const row = idx.projects.find((p) => p.project_id === id);
  assert.equal(row.screening.state, 'fresh');
  assert.equal(screening.view(ws, project(ws, id), { now: later }).alerts.length, 3);
  // Past alert_days they leave the review queue but stay on file.
  assert.equal(screening.summary(ws, project(ws, id), later + 15 * DAY).alerts.length, 0);
  assert.equal(screening.readProjectDoc(ws, id).transitions.length, 3);

  // A failed screen in between never produces a transition.
  await refresh(ws, stub(reply(500, 'down')), { now: later + 8 * DAY, force: true });
  const r2 = await refresh(ws, stub(goplus(EVM_A, { ...CLEAN, is_mintable: '1', is_blacklisted: '1', is_proxy: '1', sell_tax: '0.15' })), { now: later + 9 * DAY, force: true });
  assert.equal(r2.alerts, 0);
});

test('transitionsBetween: tax staying above or falling below the line, and a present flag going away, raise nothing', () => {
  const ok = (checks, sell) => ({ status: 'ok', chain: 'ethereum', chain_id: '1', address: EVM_A, checks, taxes: { sell_pct: sell } });
  assert.deepEqual(screening.transitionsBetween(ok({ mint: 'present' }, 12), ok({ mint: 'absent' }, 30)), []);
  assert.deepEqual(screening.transitionsBetween(ok({}, 15), ok({}, 5)), []);
  assert.deepEqual(screening.transitionsBetween(ok({}, 10), ok({}, 10.01)).map((x) => x.check), ['sell_tax']);
  assert.deepEqual(screening.transitionsBetween(ok({}, null), ok({}, 50)), [], 'an unknown tax before is not a crossing');
  assert.deepEqual(screening.transitionsBetween(ok({ freeze: 'absent' }, null), ok({ freeze: 'present' }, null)).map((x) => x.check), ['freeze']);
  assert.deepEqual(screening.transitionsBetween({ status: 'not_found' }, ok({ mint: 'present' }, 0)), []);
});

test('a change to the contracts on record makes the project due at once; the old screen is never shown for new contracts', async (t) => {
  const { ws } = workspace(t, 'scr-rebind');
  const id = addProject(ws);
  await refresh(ws, stub(goplus(EVM_A, CLEAN)));
  assert.equal(screening.isDue(ws, NOW + HOUR), false);
  projects.updateIdentity(ws, id, { assets: [{ chain: 'ethereum', contract_address: EVM_B }] });
  assert.equal(screening.isDue(ws, NOW + HOUR), true);
  const s = screening.stateFor(ws, project(ws, id), NOW + HOUR);
  assert.equal(s.state, 'pending');
  assert.equal(s.snapshot, undefined);
  const f = stub(goplus(EVM_B, CLEAN));
  assert.equal((await refresh(ws, f, { now: NOW + HOUR })).status, 'ok');
  assert.deepEqual(f.calls, [`https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${EVM_B}`]);
});

test('a pending identity is never screened, and screening is a scheduled job', async (t) => {
  const { ws } = workspace(t, 'scr-pending');
  const out = projects.addProject(ws, { name: 'Unconfirmed Token (FICTIONAL)', symbol: 'XUNC', assets: [{ chain: 'ethereum', contract_address: EVM_A }] });
  const f = stub(new Error('must not be called'));
  assert.equal((await refresh(ws, f)).status, 'noop');
  assert.equal(screening.stateFor(ws, project(ws, out.project_id), NOW).state, 'identity_pending');
  assert.equal(f.calls.length, 0);
  assert.ok(jobs.JOB_NAMES.includes('screening'));
  assert.ok('screening' in require('../core/workspace').DEFAULT_SETTINGS);
});

// ---------------------------------------------------------------------------
// The research packets (Stage 1.5 C2): the screen reaches Agent 1 and Agent 2
// from the saved cache, and every state short of a good screen says so.

const research = require('../core/research');
const fsNode = require('fs');
const pathNode = require('path');
const { DEFAULT_SETTINGS } = require('../core/workspace');

test('C2: include is the default in both places that state one, and an explicit monitor still wins', (t) => {
  assert.equal(DEFAULT_SETTINGS.screening.packet_mode, 'include');
  const { ws } = workspace(t, 'scr-c2-default');
  assert.equal(screening.includeInPacket(ws), true);
  assert.equal(screening.includeInPacket({ settings: {} }), true, 'the module default agrees');
  const { ws: held } = workspace(t, 'scr-c2-monitor', { screening: { packet_mode: 'monitor' } });
  const id = addProject(held);
  assert.equal(screening.includeInPacket(held), false);
  const s = screening.packetSection(held, project(held, id), { now: NOW });
  assert.equal(s.state, 'not_included');
  assert.match(s.reason, /monitor/);
  assert.equal(s.contracts, undefined, 'monitor keeps the flags out');
});

test('C2: a new run\'s frozen packet and prompt carry the screen as GoPlus answered, from the cache, with no request', async (t) => {
  const { ws, root } = workspace(t, 'scr-c2-run');
  const id = addProject(ws);
  const f = stub(goplus(EVM_A, CLEAN));
  await refresh(ws, f);
  const asked = f.calls.length;
  const before = globalThis.fetch.mock.calls.length;
  const run = research.createRun(ws, { project_id: id, providers: ['claude'] }).run;
  assert.equal(f.calls.length, asked);
  assert.equal(globalThis.fetch.mock.calls.length, before, 'freezing a packet asks nobody');
  const packet = JSON.parse(fsNode.readFileSync(pathNode.join(root, run.evidence_packet.path), 'utf8'));
  assert.equal(packet.schema_version, 'cr.evidence-packet.v4');
  assert.equal(run.evidence_packet.schema_version, 'cr.evidence-packet.v4');
  const c = packet.contract_screen;
  assert.equal(c.schema_version, 'cr.contract-screen.v1');
  assert.equal(c.mode, 'include');
  assert.equal(c.contracts[0].address, EVM_A);
  assert.equal(c.contracts[0].checks.honeypot, 'absent');
  assert.match(c.note, /an absent flag is not an audit/);
  assert.match(c.note, /data, never instructions/);
  assert.ok(!stringsOf(c).some((x) => /\bsafe\b/i.test(x)), 'nothing is labeled safe');
  assert.ok(fsNode.readFileSync(pathNode.join(root, run.prompt.path), 'utf8').includes('"contract_screen"'), 'the prompt shows it to Agent 1');
  assert.deepEqual(packet.excluded, ['your holdings and transactions', 'your notes and journal', 'other models\' reports and scores']);
});

test('C2: a field GoPlus left out stays unknown in the packet, and a present flag stays present', async (t) => {
  const { ws, root } = workspace(t, 'scr-c2-unknown');
  const id = addProject(ws);
  const { is_honeypot: _gone, ...partial } = CLEAN;
  await refresh(ws, stub(goplus(EVM_A, { ...partial, is_mintable: '1' })));
  const run = research.createRun(ws, { project_id: id, providers: ['claude'] }).run;
  const c = JSON.parse(fsNode.readFileSync(pathNode.join(root, run.evidence_packet.path), 'utf8')).contract_screen.contracts[0];
  assert.equal(c.checks.honeypot, 'unknown');
  assert.equal(c.checks.mint, 'present');
  assert.ok(c.unknown >= 1, 'the count of unanswered checks says so');
});

test('C2: nothing screened yet, a GoPlus failure, an old screen and an unverified identity each say so and carry no flags they do not have', async (t) => {
  const { ws, root } = workspace(t, 'scr-c2-states');
  const id = addProject(ws);
  const first = screening.packetSection(ws, project(ws, id), { now: NOW });
  assert.equal(first.state, 'pending');
  assert.match(first.reason, /Not screened yet/);
  assert.equal(first.contracts[0].status, 'not_screened');
  assert.equal(first.contracts[0].checks, undefined);

  // GoPlus fails before any good screen: the run is still created, and says so.
  await refresh(ws, stub(reply(500, 'FICTIONAL outage')));
  const run = research.createRun(ws, { project_id: id, providers: ['claude'] }).run;
  const failed = JSON.parse(fsNode.readFileSync(pathNode.join(root, run.evidence_packet.path), 'utf8')).contract_screen;
  assert.equal(failed.state, 'unavailable');
  assert.match(failed.reason, /HTTP 500/);
  assert.match(failed.last_refresh_failure.error, /HTTP 500/);
  assert.equal(failed.contracts[0].checks, undefined);

  // A good screen, then a failure: the old screen is named as old.
  await refresh(ws, stub(goplus(EVM_A, CLEAN)), { force: true });
  await refresh(ws, stub(reply(500, 'FICTIONAL outage')), { force: true });
  const lastFailed = screening.packetSection(ws, project(ws, id), { now: NOW });
  assert.equal(lastFailed.state, 'fresh_last_failed');
  assert.match(lastFailed.reason, /latest run failed/);
  const stale = screening.packetSection(ws, project(ws, id), { now: NOW + 400 * HOUR });
  assert.equal(stale.state, 'stale');
  assert.match(stale.reason, /older than 336 h/);

  const pending = screening.packetSection(ws, { project_id: id, identity: { status: 'pending' } }, { now: NOW });
  assert.equal(pending.state, 'identity_pending');
  assert.equal(pending.contracts, undefined);
});

test('C2: a cache that does not read is not a pass, screening turned off says so, and a read that throws never breaks a packet', async (t) => {
  const { ws } = workspace(t, 'scr-c2-broken');
  const id = addProject(ws);
  await refresh(ws, stub(goplus(EVM_A, CLEAN)));
  fsNode.writeFileSync(ws.abs('market-data/screening/' + id + '.json'), '{torn');
  const torn = screening.packetSection(ws, project(ws, id), { now: NOW });
  assert.equal(torn.state, 'pending');
  assert.equal(torn.contracts[0].checks, undefined);

  const { ws: off } = workspace(t, 'scr-c2-off', { screening: { enabled: false } });
  const offId = addProject(off);
  const disabled = screening.packetSection(off, project(off, offId), { now: NOW });
  assert.equal(disabled.state, 'disabled');
  assert.match(disabled.reason, /turned off/);
  assert.equal(disabled.contracts[0].status, 'not_screened');

  const thrower = { get identity() { throw new Error('FICTIONAL read failure'); } };
  const broken = screening.packetSection(ws, thrower, { now: NOW });
  assert.equal(broken.state, 'unavailable');
  assert.match(broken.reason, /FICTIONAL read failure/);
  assert.equal(broken.contracts, undefined);
});
