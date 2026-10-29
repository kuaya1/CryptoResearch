'use strict';
// Scout leads, stage B: eligibility (intake plan rev. 2 §4, PR 4;
// audits/2026-10-29-intake-dialectic/PLAN.md). One bounded turn reads
// CoinGecko's listing and GoPlus's screen for at most five due assets and
// writes one receipt each, deterministic, with no model call. FICTIONAL
// temporary desks and fake fetch only; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const L = require('../core/leads');
const jobs = require('../core/jobs');
const projects = require('../core/projects');
const { validateSettingsPatch } = require('../server');
const { openWorkspace } = require('../core/workspace');
const { readJson } = require('../core/fsx');
const { tempWorkspace, hashTree } = require('./helpers');

const HOUR = 3600000;
const EVM = (n) => `0x${String(n).padStart(4, '0')}${'cd'.repeat(18)}`;
const POLICY = { enabled: true, chains: ['8453', '1514'], min_market_cap_usd: 1000000, min_volume_24h_usd: 100000, max_sell_tax_pct: 5, eligibility_hours: 24 };

function workspace(t, label, leads = POLICY) {
  const w = tempWorkspace(label, { leads });
  t.after(w.cleanup);
  // Nothing in these tests may reach the network.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  for (const k of ['GOPLUS_APP_KEY', 'GOPLUS_APP_SECRET']) {
    const was = process.env[k];
    delete process.env[k];
    t.after(() => { if (was === undefined) delete process.env[k]; else process.env[k] = was; });
  }
  return w;
}

let deliveries = 0;
function deliver(ws, leads, now = Date.now()) {
  deliveries += 1;
  const out = L.ingest(ws, {
    schema: L.LEADS_SCHEMA,
    prompt_version: L.LEADS_PROMPT,
    delivery_id: `test-${String(deliveries).padStart(4, '0')}`,
    generated_at: new Date(now - 60000).toISOString(),
    model: 'grok-4.3',
    leads: leads.map((l) => ({ chain: 'base', coingecko_id: null, signal: 'A fictional lead for these tests.', urls: ['https://example.com/lead'], ...l })),
  }, { now });
  assert.equal(out.status, 'accepted');
  return out.rows.map((r) => r.lead_key);
}

const reply = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (headers[String(k).toLowerCase()] === undefined ? null : headers[String(k).toLowerCase()]) },
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
});

const coin = (address, over = {}) => ({
  id: 'fictional-token',
  name: 'Fictional Token',
  symbol: 'fict',
  links: { homepage: ['https://fictional.example/'] },
  image: { small: 'https://fictional.example/logo.png' },
  market_data: { market_cap: { usd: 5000000 }, total_volume: { usd: 400000 } },
  detail_platforms: { base: { contract_address: address, decimal_place: 18 } },
  last_updated: '2099-01-01T00:00:00.000Z',
  ...over,
});
const CLEAN = {
  is_mintable: '0', is_proxy: '0', is_blacklisted: '0', is_whitelisted: '0', owner_change_balance: '0', hidden_owner: '0',
  selfdestruct: '0', external_call: '0', can_take_back_ownership: '0', transfer_pausable: '0', trading_cooldown: '0',
  is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', slippage_modifiable: '0', personal_slippage_modifiable: '0',
  is_anti_whale: '0', is_open_source: '1', buy_tax: '0', sell_tax: '0', owner_address: '0x0000000000000000000000000000000000000000',
};
const goplus = (address, fields) => reply(200, { code: 1, message: 'OK', result: { [address.toLowerCase()]: fields } });

// A fake fetch: CoinGecko's contract read and GoPlus's screen by address,
// each from its table; every URL is recorded.
function fake({ cg = {}, gp = {}, onCall = null } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(String(url));
    if (onCall) {
      const r = await onCall(String(url), opts, calls.length);
      if (r) return r;
    }
    const m = /\/contract\/(0x[0-9a-f]{40})/i.exec(url);
    if (m) {
      const a = m[1].toLowerCase();
      if (!(a in cg)) return reply(404, { error: 'coin not found' });
      return typeof cg[a] === 'function' ? cg[a]() : reply(200, cg[a]);
    }
    const g = /contract_addresses=(0x[0-9a-f]{40})/i.exec(url);
    if (g) {
      const a = g[1].toLowerCase();
      if (!(a in gp)) return reply(200, { code: 1, message: 'OK', result: {} });
      return typeof gp[a] === 'function' ? gp[a]() : goplus(a, gp[a]);
    }
    throw new Error(`unexpected request ${url}`);
  };
  fn.calls = calls;
  return fn;
}
// A fetch that never answers until its signal ends it.
const stall = (url, opts) => new Promise((_, reject) => {
  const s = opts && opts.signal;
  const end = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  if (s && s.aborted) end();
  else if (s) s.addEventListener('abort', end, { once: true });
});

const asset = (ws, id) => L.getAsset(ws, id);
const receiptOf = (ws, id) => L.getReceipt(ws, asset(ws, id).eligibility.receipt_id);

test('each state is reached from a fixture, each with one intact receipt', async (t) => {
  const { ws } = workspace(t, 'leads-states');
  const a = {
    eligible: EVM(1), lowcap: EVM(2), unlisted: EVM(3), notax: EVM(4), noplatform: EVM(5), otherid: EVM(6), honeypot: EVM(7), zerotax: EVM(8),
  };
  const ids = deliver(ws, [
    { contract: a.eligible }, { contract: a.lowcap }, { contract: a.unlisted }, { contract: a.notax }, { contract: a.noplatform },
  ]);
  const more = deliver(ws, [{ contract: a.otherid, coingecko_id: 'another-fictional-id' }, { contract: a.honeypot }, { contract: a.zerotax }, { chain: 'story', contract: EVM(9) }, { chain: 'ethereum', contract: EVM(10) }]);
  const { sell_tax, ...noSellTax } = CLEAN;
  const f = fake({
    cg: {
      [a.eligible]: coin(a.eligible), [a.lowcap]: coin(a.lowcap, { market_data: { market_cap: { usd: 20000 }, total_volume: { usd: 400000 } } }),
      [a.notax]: coin(a.notax), [a.noplatform]: coin(a.noplatform, { detail_platforms: { ethereum: { contract_address: a.noplatform } } }),
      [a.otherid]: coin(a.otherid), [a.honeypot]: coin(a.honeypot), [a.zerotax]: coin(a.zerotax),
    },
    gp: { [a.eligible]: { ...CLEAN, sell_tax: '0.01' }, [a.notax]: noSellTax, [a.noplatform]: CLEAN, [a.otherid]: CLEAN, [a.honeypot]: { ...CLEAN, is_honeypot: '1' }, [a.zerotax]: CLEAN },
  });
  const r1 = await L.refresh(ws, { fetchImpl: f, retryDelayMs: 0 });
  assert.equal(r1.results.length, L.TURN_ASSETS, 'five assets a turn');
  const r2 = await L.refresh(ws, { fetchImpl: f, retryDelayMs: 0 });
  assert.equal(r2.results.length, 5);
  const state = (id) => asset(ws, id).state;
  assert.equal(state(ids[0]), 'ELIGIBLE');
  assert.equal(state(ids[1]), 'REFUSED');
  assert.match(receiptOf(ws, ids[1]).reasons.join(' '), /market cap \$20,000 is under your floor/);
  assert.equal(state(ids[2]), 'REFUSED');
  assert.match(receiptOf(ws, ids[2]).reasons.join(' '), /does not list/);
  assert.equal(state(ids[3]), 'INCOMPLETE', 'a missing sell tax is unknown, never 0');
  assert.match(receiptOf(ws, ids[3]).reasons.join(' '), /no sell tax/);
  assert.equal(state(ids[4]), 'INCOMPLETE', 'no detail_platforms entry for the chain');
  assert.equal(state(more[0]), 'NEEDS_REVIEW');
  assert.equal(state(more[1]), 'REFUSED');
  assert.match(receiptOf(ws, more[1]).reasons.join(' '), /honeypot/);
  assert.equal(state(more[2]), 'ELIGIBLE');
  assert.equal(state(more[3]), 'NEEDS_REVIEW', 'a chain without a CoinGecko platform');
  assert.equal(state(more[4]), 'REFUSED', 'a chain outside leads.chains');
  assert.match(receiptOf(ws, more[4]).reasons.join(' '), /not among the chains you allow/);
  assert.ok(!f.calls.some((u) => u.includes(EVM(9)) || u.includes(EVM(10))), 'no request for a chain refused or unmapped');
  // Each receipt is create-only and checked against its hash.
  const r = receiptOf(ws, ids[0]);
  assert.equal(r.schema_version, 'cr.lead-eligibility.v1');
  assert.equal(r.version, 'cr-lead-eligibility@1');
  assert.equal(r.policy.sha256, L.policyOf(ws).sha256);
  assert.equal(r.words, 'Listing matched; on-chain deployment not independently checked.');
  assert.deepEqual(r.observations.map((o) => o.source), ['coingecko', 'goplus']);
  assert.ok(r.observations.every((o) => /^[0-9a-f]{64}$/.test(o.answer_sha256)));
  const file = ws.abs(`${L.ELIGIBILITY}/${r.receipt_id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...r, state: 'REFUSED' }));
  assert.throws(() => L.getReceipt(ws, r.receipt_id), (e) => e.status === 404);
  // "0" is 0 and passes a limit of 0.
  ws.settings.leads = { ...POLICY, max_sell_tax_pct: 0 };
  const zero = L.judge(asset(ws, more[2]).identity, [], receiptOf(ws, more[2]).observations, L.policyOf(ws));
  assert.equal(zero.state, 'ELIGIBLE');
  assert.equal(zero.criteria.find((c) => c.name === 'sell_tax_pct').value, 0);
});

test('an unset floor holds every lead; a known contract is KNOWN; nothing is asked', async (t) => {
  const { ws } = workspace(t, 'leads-hold', { ...POLICY, min_volume_24h_usd: null });
  const pid = projects.addProject(ws, {
    name: 'Known Token (FICTIONAL)', symbol: 'KNWN', official_website: 'https://known.example/', coingecko_id: 'known-fictional',
    assets: [{ chain: 'base', contract_address: EVM(20).toUpperCase().replace('0X', '0x') }], evidence: [{ url: 'https://known.example/docs', note: 'fictional' }], sector: 'defi',
  }).project_id;
  const [known, held] = deliver(ws, [{ contract: EVM(20) }, { contract: EVM(21) }]);
  const f = fake();
  await L.refresh(ws, { fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.equal(asset(ws, known).state, 'KNOWN');
  assert.match(receiptOf(ws, known).reasons[0], new RegExp(pid));
  assert.equal(asset(ws, held).state, 'POLICY_HOLD');
  assert.match(receiptOf(ws, held).reasons.join(' '), /minimum 24-hour volume not set/);
  // Held stays held until the policy changes; then it is due again.
  assert.equal(L.dueAssets(ws).length, 0);
  ws.settings.leads = POLICY;
  assert.deepEqual(L.dueAssets(ws).map((a) => a.asset_id), [held]);
});

test('an expired receipt and a changed policy make an asset due; a sighting alone does not', async (t) => {
  const { ws } = workspace(t, 'leads-due');
  const [id] = deliver(ws, [{ contract: EVM(30) }]);
  const T = Date.now();
  await L.refresh(ws, { fetchImpl: fake({ cg: { [EVM(30)]: coin(EVM(30)) }, gp: { [EVM(30)]: CLEAN } }), clock: () => T });
  assert.equal(asset(ws, id).state, 'ELIGIBLE');
  deliver(ws, [{ contract: EVM(30) }]);
  assert.equal(asset(ws, id).sightings.length, 2);
  assert.equal(L.dueAssets(ws, T + HOUR).length, 0, 'a sighting alone is not due');
  assert.equal(L.dueAssets(ws, T + 25 * HOUR).length, 1, 'an expired reading is due');
  ws.settings.leads = { ...POLICY, min_market_cap_usd: 2000000 };
  assert.equal(L.dueAssets(ws, T + HOUR).length, 1, 'a changed policy is due');
  // A changed policy within the reading's life is judged again with no request.
  const f = fake();
  await L.refresh(ws, { fetchImpl: f, clock: () => T + HOUR });
  assert.equal(f.calls.length, 0);
  const r = receiptOf(ws, id);
  assert.ok(r.reused_from);
  assert.equal(r.policy.values.min_market_cap_usd, 2000000);
});

test('expires_at comes from the desk\'s send time only, never the answer\'s own times', async (t) => {
  const { ws } = workspace(t, 'leads-expiry');
  const [id] = deliver(ws, [{ contract: EVM(40) }]);
  const T = Date.parse('2026-10-29T12:00:00.000Z');
  await L.refresh(ws, { fetchImpl: fake({ cg: { [EVM(40)]: coin(EVM(40), { last_updated: 'not a date' }) }, gp: { [EVM(40)]: CLEAN } }), clock: () => T });
  const r = receiptOf(ws, id);
  assert.equal(r.observations[0].observed_at, new Date(T).toISOString());
  assert.equal(r.expires_at, new Date(T + 24 * HOUR).toISOString());
});

test('a GoPlus 429 gives RETRY_AT at the gate\'s time, ends the phase, and the next job still runs', async (t) => {
  const { ws } = workspace(t, 'leads-429');
  const ids = deliver(ws, [{ contract: EVM(50) }, { contract: EVM(51) }]);
  const limit = () => reply(429, 'slow down', { 'retry-after': '120' });
  const f = fake({ cg: { [EVM(50)]: coin(EVM(50)), [EVM(51)]: coin(EVM(51)) }, gp: { [EVM(50)]: limit, [EVM(51)]: limit } });
  const r = await L.refresh(ws, { fetchImpl: f, retryDelayMs: 0 });
  assert.equal(r.status, 'partial');
  // Whichever is read first meets the 429; the other is not read at all.
  const first = ids.find((id) => asset(ws, id).state === 'RETRY_AT');
  const second = ids.find((id) => id !== first);
  const addrOf = (id) => asset(ws, id).identity.address_key;
  const a = asset(ws, first);
  assert.equal(a.state, 'RETRY_AT');
  const gate = require('../core/screening').blockedBy(require('../core/screening').readStatus(ws), Date.now());
  assert.ok(gate, 'GoPlus\'s gate is closed');
  assert.equal(a.next_attempt_at, receiptOf(ws, first).retry.at);
  assert.ok(Math.abs(Date.parse(a.next_attempt_at) - Date.parse(gate.retry_at)) < 2000);
  assert.ok(!f.calls.some((u) => u.includes(addrOf(second))), 'the phase ended: the second asset was not read');
  assert.equal(asset(ws, second).state, 'NEW');
  assert.ok(asset(ws, second).released_at);
  assert.equal(L.isDue(ws), false, 'not due while GoPlus\'s gate is closed');
  // The timer's list runs on past it.
  const results = await jobs.runJobs(ws, ['leads', 'reviews'], { onlyDue: true });
  assert.equal(results.length, 2);
  assert.equal(results[1].status, 'ok');
});

test('ten requests at most, the token and retries counted; nothing sent after the counter', async (t) => {
  const { ws } = workspace(t, 'leads-requests');
  process.env.GOPLUS_APP_KEY = `fictional-key-${Date.now()}`;
  process.env.GOPLUS_APP_SECRET = 'fictional-secret';
  const addrs = [60, 61, 62, 63, 64].map(EVM);
  const ids = deliver(ws, addrs.map((contract) => ({ contract })));
  // Every GoPlus screen fails once with a 500, so each asset costs CoinGecko
  // one, GoPlus two (the retry), plus one token request.
  const tries = {};
  const f = fake({
    cg: Object.fromEntries(addrs.map((a) => [a, coin(a)])),
    gp: Object.fromEntries(addrs.map((a) => [a, () => { tries[a] = (tries[a] || 0) + 1; return tries[a] === 1 ? reply(500, 'oops') : goplus(a, CLEAN); }])),
    onCall: (url) => (new URL(url).pathname === '/api/v1/token' ? reply(200, { code: 1, result: { access_token: 'fictional-token', expires_in: 3600 } }) : null),
  });
  const r = await L.refresh(ws, { fetchImpl: f, retryDelayMs: 0 });
  assert.ok(f.calls.length <= 10, `${f.calls.length} requests`);
  assert.equal(r.requests, f.calls.length);
  assert.ok(f.calls.some((u) => new URL(u).pathname === '/api/v1/token'), 'the token request is counted');
  const states = ids.map((id) => asset(ws, id));
  assert.ok(states.some((a) => a.state === 'ELIGIBLE'));
  const left = states.filter((a) => a.state === 'NEW');
  assert.ok(left.length >= 1, 'an asset left by the counter');
  for (const a of left) {
    assert.ok(a.released_at);
    assert.equal(a.next_attempt_at, a.released_at);
  }
  // Read first next turn.
  assert.equal(L.dueAssets(ws)[0].asset_id, left[0].asset_id);
});

test('the deadline cuts a stalled request, its retry wait and its body read', async (t) => {
  const { ws } = workspace(t, 'leads-deadline');
  const ids = deliver(ws, [{ contract: EVM(70) }, { contract: EVM(71) }]);
  // CoinGecko answers; GoPlus stalls until the turn ends it.
  const f = fake({ cg: { [EVM(70)]: coin(EVM(70)), [EVM(71)]: coin(EVM(71)) }, onCall: (url, opts) => (url.includes('token_security') ? stall(url, opts) : null) });
  const t0 = Date.now();
  await L.refresh(ws, { fetchImpl: f, turnMs: 300, retryDelayMs: 5000 });
  assert.ok(Date.now() - t0 < 3000, 'the turn ended at its deadline, not the retry delay');
  const sentAfter = f.calls.length;
  assert.ok(sentAfter <= 3);
  for (const id of ids) assert.equal(asset(ws, id).state, 'NEW');
  assert.ok(ids.every((id) => asset(ws, id).released_at));
  // A body that never ends is cut too.
  const g = fake({ onCall: (url, opts) => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader: () => ({ read: () => stall(url, opts), cancel: async () => {} }) } }) });
  const t1 = Date.now();
  await L.refresh(ws, { fetchImpl: g, turnMs: 300 });
  assert.ok(Date.now() - t1 < 3000);
  assert.equal(g.calls.length, 1, 'nothing sent after the deadline');
});

test('a stale claim is taken over; a commit after the asset changed writes no receipt', async (t) => {
  const { ws } = workspace(t, 'leads-claims');
  const [id] = deliver(ws, [{ contract: EVM(80) }]);
  const file = ws.abs(`${L.ASSETS}/${id}.json`);
  const cur = readJson(file);
  fs.writeFileSync(file, JSON.stringify({ ...cur, claim: { op_id: 'lt_old', claimed_at: new Date(Date.now() - 60000).toISOString(), revision: cur.revision } }));
  assert.equal(L.dueAssets(ws).length, 0, 'a fresh claim is not due');
  fs.writeFileSync(file, JSON.stringify({ ...cur, claim: { op_id: 'lt_old', claimed_at: new Date(Date.now() - 11 * 60000).toISOString(), revision: cur.revision } }));
  assert.equal(L.dueAssets(ws).length, 1, 'a claim older than 10 minutes is taken over');
  // The asset changes while the turn reads (as a dismissal would).
  const f = fake({
    cg: { [EVM(80)]: coin(EVM(80)) },
    gp: { [EVM(80)]: () => { const a = readJson(file); fs.writeFileSync(file, JSON.stringify({ ...a, revision: a.revision + 1, claim: null, state: 'DISMISSED' })); return goplus(EVM(80), CLEAN); } },
  });
  const r = await L.refresh(ws, { fetchImpl: f });
  assert.equal(r.results[0].result, 'dropped');
  assert.equal(asset(ws, id).state, 'DISMISSED');
  assert.ok(!fs.existsSync(ws.abs(L.ELIGIBILITY)) || fs.readdirSync(ws.abs(L.ELIGIBILITY)).length === 0);
});

test('two runners on one folder do one turn; a restored copy is held; reads write nothing', async (t) => {
  const { ws, root } = workspace(t, 'leads-lease');
  const other = openWorkspace({ root, actor: 'test-2' });
  deliver(ws, [{ contract: EVM(90) }]);
  let release;
  const gateP = new Promise((r) => { release = r; });
  const f = fake({ onCall: async () => { await gateP; return reply(404, {}); } });
  const first = L.refresh(ws, { fetchImpl: f });
  await new Promise((r) => setTimeout(r, 50));
  const second = await L.refresh(other, { fetchImpl: f });
  assert.equal(second.status, 'busy');
  release();
  assert.equal((await first).results.length, 1);
  // Reads write nothing.
  deliver(ws, [{ contract: EVM(91) }]);
  const before = hashTree(root);
  L.policyOf(ws); L.dueAssets(ws); L.isDue(ws); L.view(ws);
  assert.deepEqual(hashTree(root), before);
  // A restored copy holds the job.
  fs.writeFileSync(ws.abs('config/restored-copy.json'), JSON.stringify({ restored_at: '2026-10-29T00:00:00Z', research_held: true }));
  assert.equal(L.isDue(ws), false);
  assert.equal(jobs.isDue(ws, 'leads', jobs.readJobState(ws)), false);
  assert.equal((await L.refresh(ws, { fetchImpl: f })).status, 'held');
});

test('leads is in HOSTED_TIMER_JOBS and the timer\'s list runs it, not only the CLI', async (t) => {
  const { ws } = workspace(t, 'leads-timer');
  assert.ok(jobs.HOSTED_TIMER_JOBS.includes('leads'));
  assert.equal(jobs.JOB_NAMES[jobs.JOB_NAMES.indexOf('trader') + 1], 'leads');
  const [id] = deliver(ws, [{ contract: EVM(95) }]);
  const f = fake({ cg: { [EVM(95)]: coin(EVM(95)) }, gp: { [EVM(95)]: CLEAN } });
  t.mock.method(globalThis, 'fetch', f);
  const results = await jobs.runJobs(ws, jobs.HOSTED_TIMER_JOBS, { onlyDue: true });
  const r = results[jobs.HOSTED_TIMER_JOBS.indexOf('leads')];
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(asset(ws, id).state, 'ELIGIBLE');
  // Off means not due, and nothing is asked.
  ws.settings.leads = { ...POLICY, enabled: false };
  deliver(ws, [{ contract: EVM(96) }]);
  assert.equal(L.isDue(ws), false);
  assert.equal((await L.refresh(ws, { fetchImpl: f })).status, 'skipped');
});

test('each lead setting refuses a value outside its bounds', () => {
  const bad = [
    { enabled: 'yes' }, { chains: [] }, { chains: ['not-a-chain'] }, { chains: Array.from({ length: 41 }, (_, i) => String(i)) },
    { min_market_cap_usd: -1 }, { min_market_cap_usd: 1.5 }, { min_market_cap_usd: 2e12 }, { min_volume_24h_usd: Infinity },
    { max_sell_tax_pct: 101 }, { max_sell_tax_pct: 1.234 }, { eligibility_hours: 0 }, { eligibility_hours: 721 }, { eligibility_hours: 2.5 },
    { unknown_field: 1 },
  ];
  for (const leads of bad) assert.throws(() => validateSettingsPatch({ leads }), (e) => e.code === 'INVALID', JSON.stringify(leads));
  const ok = validateSettingsPatch({ leads: { enabled: true, chains: ['base', 'ethereum', 'base'], min_market_cap_usd: 0, max_sell_tax_pct: 2.5, eligibility_hours: 720, min_volume_24h_usd: null } });
  assert.deepEqual(ok.leads, { enabled: true, chains: ['1', '8453'], min_market_cap_usd: 0, max_sell_tax_pct: 2.5, eligibility_hours: 720, min_volume_24h_usd: null });
});

// Audit F5: a Solana token's scheduled fee, its transfer hook and whether it
// can be transferred decide eligibility; a missing fact is never a pass.
test('Solana: the higher of the fee now and every scheduled fee, a non-transferable token, a transfer hook and an unknown basis', () => {
  const S = require('../core/screening');
  const identity = L.identityOf('solana', `2${'A'.repeat(42)}B`);
  assert.ok(identity);
  const policy = { values: { ...POLICY, chains: ['solana'] } };
  const listing = { source: 'coingecko', outcome: 'ok', facts: { coingecko_id: 'fictional-solana', platform_entry: true, platform_contract: identity.address, homepage: 'https://fictional-solana.example/', market_cap_usd: 5000000, volume_24h_usd: 400000 } };
  const judgeOf = (raw) => {
    const facts = L.screenFacts(S.normalizeSolana(raw), 'solana');
    return { facts, out: L.judge(identity, [], [listing, { source: 'goplus', outcome: 'ok', facts }], policy) };
  };
  const fee = (now, scheduled) => ({ current_fee_rate: { fee_rate: now }, ...(scheduled === undefined ? {} : { scheduled_fee_rate: scheduled }) });
  const clean = { transfer_fee: fee('0', []), transfer_hook: [], non_transferable: '0' };
  // Fully known, zero fee, no hook, transferable: eligible.
  const ok = judgeOf(clean);
  assert.equal(ok.out.state, 'ELIGIBLE');
  assert.deepEqual([ok.facts.transfer_fee_pct, ok.facts.transfer_fee_scheduled_max_pct, ok.facts.transfer_hook, ok.facts.non_transferable], [0, 0, 'absent', 'absent']);
  // A scheduled fee above the limit is refused, even at zero now.
  const scheduled = judgeOf({ ...clean, transfer_fee: fee('0', [{ epoch: '42', fee_rate: '0.25' }]) });
  assert.equal(scheduled.out.state, 'REFUSED');
  assert.equal(scheduled.out.criteria.find((c) => c.name === 'transfer_fee_pct').value, 25);
  assert.match(scheduled.out.reasons.join(' '), /transfer fee 25% \(the highest of the fee now and every scheduled fee\) is above your limit of 5%/);
  // A schedule GoPlus does not state completely is missing, never zero.
  const partial = judgeOf({ ...clean, transfer_fee: fee('0', [{ epoch: '42', fee_rate: 'not a number' }]) });
  assert.equal(partial.facts.transfer_fee_scheduled_max_pct, null);
  assert.equal(partial.out.state, 'INCOMPLETE');
  assert.match(partial.out.reasons.join(' '), /no complete schedule of transfer fees/);
  assert.equal(judgeOf({ ...clean, transfer_fee: { current_fee_rate: { fee_rate: '0' }, scheduled_fee_rate: null } }).out.state, 'INCOMPLETE', 'a schedule that is not a list is unknown');
  assert.equal(judgeOf({ ...clean, transfer_fee: undefined }).out.state, 'INCOMPLETE');
  // Not transferable never passes; unknown transferability is missing.
  const nt = judgeOf({ ...clean, non_transferable: '1' });
  assert.equal(nt.out.state, 'REFUSED');
  assert.match(nt.out.reasons.join(' '), /not transferable/);
  const ntUnknown = judgeOf({ ...clean, non_transferable: undefined });
  assert.equal(ntUnknown.out.state, 'INCOMPLETE');
  // A transfer hook is for Eric to look at; an unknown hook is missing.
  const hook = judgeOf({ ...clean, transfer_hook: ['fictional-hook-program'] });
  assert.equal(hook.out.state, 'NEEDS_REVIEW');
  assert.match(hook.out.reasons.join(' '), /transfer hook/);
  assert.equal(judgeOf({ ...clean, transfer_hook: undefined }).out.state, 'INCOMPLETE');
});
