'use strict';
// Shared FICTIONAL fixtures for the scout-lead tests: a desk with Eric's lead
// policy set, deliveries, and a fake fetch answering CoinGecko's contract read
// and GoPlus's screen from tables. Nothing here reaches the network.

const assert = require('node:assert/strict');
const L = require('../core/leads');
const { tempWorkspace } = require('./helpers');

const POLICY = { enabled: true, chains: ['8453', '1514'], min_market_cap_usd: 1000000, min_volume_24h_usd: 100000, max_sell_tax_pct: 5, eligibility_hours: 24 };
const EVM = (n) => `0x${String(n).padStart(4, '0')}${'cd'.repeat(18)}`;

function workspace(t, label, { leads = POLICY, research = undefined } = {}) {
  const w = tempWorkspace(label, { leads, ...(research ? { research } : {}) });
  t.after(w.cleanup);
  // Nothing in these tests may reach the network.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network access is not allowed in tests');
  });
  for (const k of ['GOPLUS_APP_KEY', 'GOPLUS_APP_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) {
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
    delivery_id: `test-${process.pid}-${String(deliveries).padStart(4, '0')}`,
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
  id: `fictional-${address.slice(2, 6)}`,
  name: `Fictional Token ${address.slice(2, 6)}`,
  symbol: `f${address.slice(4, 6)}`,
  links: { homepage: [`https://fictional-${address.slice(2, 6)}.example/`] },
  image: { small: 'https://fictional.example/logo.png' },
  market_data: { market_cap: { usd: 5000000 }, total_volume: { usd: 400000 } },
  detail_platforms: { base: { contract_address: address, decimal_place: 18 } },
  ...over,
});
const CLEAN = {
  is_mintable: '0', is_proxy: '0', is_blacklisted: '0', is_whitelisted: '0', owner_change_balance: '0', hidden_owner: '0',
  selfdestruct: '0', external_call: '0', can_take_back_ownership: '0', transfer_pausable: '0', trading_cooldown: '0',
  is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', slippage_modifiable: '0', personal_slippage_modifiable: '0',
  is_anti_whale: '0', is_open_source: '1', buy_tax: '0', sell_tax: '0', owner_address: '0x0000000000000000000000000000000000000000',
};
const goplus = (address, fields) => reply(200, { code: 1, message: 'OK', result: { [address.toLowerCase()]: fields } });

// A fake fetch: CoinGecko's contract read and GoPlus's screen by address;
// every URL is recorded. Addresses not in `cg` are not listed; those not in
// `gp` have no GoPlus record.
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

// Leads made ELIGIBLE by one or more turns over a clean fake answer each.
async function eligibleLeads(ws, addrs, { now = Date.now() } = {}) {
  const ids = deliver(ws, addrs.map((contract) => ({ contract })), now);
  const f = fake({ cg: Object.fromEntries(addrs.map((a) => [a, coin(a)])), gp: Object.fromEntries(addrs.map((a) => [a, CLEAN])) });
  for (let i = 0; i < Math.ceil(addrs.length / L.TURN_ASSETS); i++) await L.refresh(ws, { fetchImpl: f, clock: () => now });
  for (const id of ids) assert.equal(L.getAsset(ws, id).state, 'ELIGIBLE');
  return ids;
}

module.exports = { POLICY, EVM, workspace, deliver, reply, coin, CLEAN, goplus, fake, eligibleLeads };
