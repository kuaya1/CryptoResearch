'use strict';
// A FICTIONAL, offline desk for frontend development (npm run dev) and the
// browser checks (npm run check). It is the Claude Brief test fixture
// (tests/brief-fixtures.js: complete research with a revision and ChatGPT's
// report for the same run, a withheld grade, ranges with a quarantined newer
// answer, a sparse legacy report, only a quarantined answer, waiting, none,
// and a very long name with hostile text) plus a fuller watchlist: graded
// projects across the 0-100 spectrum, research working, failed and waiting,
// a project you stopped watching, an archived one, a holding, contract
// screens, a market snapshot and generated FICTIONAL logos.
//
// Nothing leaves this PC: research runners, prices, DefiLlama, GoPlus and
// wallets are stubbed off before the server starts, and no key is set. The
// workspace lives in the OS temp folder and is deleted when this stops.
//   node scripts/dev-desk.cjs [--port 4790] [--info <file>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const research = require(`${ROOT}/core/research.js`);
const projects = require(`${ROOT}/core/projects.js`);
const inbox = require(`${ROOT}/core/inbox.js`);
const notes = require(`${ROOT}/core/notes.js`);
const portfolio = require(`${ROOT}/core/portfolio.js`);
const cycle = require(`${ROOT}/core/cycle.js`);
const screening = require(`${ROOT}/core/screening.js`);
const { readJson, atomicWrite, jsonText } = require(`${ROOT}/core/fsx.js`);
const { addDays, ymdInTz } = require(`${ROOT}/core/dates.js`);
const { buildBriefWorkspace, reportText, IDS } = require(`${ROOT}/tests/brief-fixtures.js`);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('--port', process.env.CR_DESK_PORT || 4790));
const INFO = arg('--info', null);

// ---- deterministic randomness ------------------------------------------------
function seeded(seed) {
  let h = crypto.createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return (h % 100000) / 100000;
  };
}
function series(seed, start, drift, n = 168) {
  const rnd = seeded(seed);
  const out = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v = Math.max(start * 0.2, v * (1 + (rnd() - 0.5) * 0.03 + drift / n));
    out.push(Number(v.toPrecision(6)));
  }
  return out;
}

// ---- FICTIONAL logos: a PNG disc with a white geometric mark --------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function pngOf(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const HUES = [[71, 85, 105], [14, 116, 144], [217, 119, 6], [22, 163, 74], [190, 24, 93], [37, 99, 235], [101, 163, 13], [15, 23, 42], [234, 88, 12], [8, 145, 178]];
function logoPng(seed) {
  const S = 96;
  const rnd = seeded(seed);
  const [r, g, b] = HUES[Math.floor(rnd() * HUES.length)];
  const shape = Math.floor(rnd() * 5);
  const px = Buffer.alloc(S * S * 4);
  const inside = (x, y) => {
    const cx = x - S / 2;
    const cy = y - S / 2;
    const d = Math.hypot(cx, cy);
    if (d > S / 2 - 0.5) return 0;
    let mark = false;
    if (shape === 0) mark = d < S * 0.3 && d > S * 0.17;
    else if (shape === 1) mark = Math.abs(cx) + Math.abs(cy) < S * 0.24;
    else if (shape === 2) mark = cy > -S * 0.2 && cy < S * 0.18 && Math.abs(cx) < (cy + S * 0.2) * 0.6;
    else if (shape === 3) mark = Math.abs(cy) < S * 0.24 && (Math.abs(cx + S * 0.12) < S * 0.05 || Math.abs(cx - S * 0.12) < S * 0.05 || Math.abs(cx) < S * 0.05);
    else mark = d < S * 0.12 || (Math.abs(cx) < S * 0.04 && Math.abs(cy) < S * 0.3);
    return mark ? 2 : 1;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let disc = 0;
      let mark = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const v = inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
        if (v) disc++;
        if (v === 2) mark++;
      }
      const i = (y * S + x) * 4;
      const m = mark / 16;
      px[i] = Math.round(r * (1 - m) + 255 * m);
      px[i + 1] = Math.round(g * (1 - m) + 255 * m);
      px[i + 2] = Math.round(b * (1 - m) + 255 * m);
      px[i + 3] = Math.round((disc / 16) * 255);
    }
  }
  return pngOf(S, S, px);
}

// ---- the extra watchlist -----------------------------------------------------------
const score = (value, rationale) => ({ status: 'scored', value, low: null, high: null, rationale, evidence_refs: ['C1'], missing_data: null });
const unknown = (missing) => ({ status: 'unknown', value: null, low: null, high: null, rationale: '', evidence_refs: [], missing_data: missing });
const clamp = (v) => Math.max(5, Math.min(98, Math.round(v)));
const VERDICT_FOR = (g) => (g >= 85 ? 'ATTRACTIVE ASYMMETRY' : g >= 70 ? 'CONDITIONAL OPPORTUNITY' : g >= 55 ? 'REAL PRODUCT, WEAK TOKEN' : g >= 45 ? 'UNFAVORABLE VALUATION' : 'INCENTIVE-DEPENDENT');

// A report graded near `g`: the six weighted components around it (so the
// desk's own grade lands there) and the category grades spread around it.
function tuned(g, seed, { withheld = false, summary = null } = {}) {
  return (j) => {
    const rnd = seeded(seed);
    for (const k of Object.keys(j.investment_components)) j.investment_components[k] = score(clamp(g + (rnd() - 0.5) * 10), `Fictional: ${k.replace(/_/g, ' ')} reasoning for this project.`);
    for (const [k, s] of Object.entries(j.diagnostic_scores)) {
      if (s && s.status === 'scored') s.value = clamp(g + (rnd() - 0.5) * 34);
      if (s && s.status === 'range') { s.low = clamp(g - 12); s.high = clamp(g + 4); }
      if (k === 'volume_liquidity' && rnd() > 0.5) j.diagnostic_scores[k] = { ...score(clamp(g - 8), 'Fictional: a dated depth reading on the main venue.'), confidence: 'medium' };
    }
    if (withheld) {
      j.investment_components.btc_relative_asymmetry = unknown('Fictional: no defensible price range for the horizon.');
      j.investment_components.timing_executable_liquidity = unknown('Fictional: no order-book depth could be read.');
    }
    j.verdict = withheld ? 'INSUFFICIENT EVIDENCE' : VERDICT_FOR(g);
    j.model_reported_overall_score = score(clamp(g + (rnd() - 0.5) * 6), 'Fictional: the model\'s own total.');
    if (summary) j.summary = summary;
  };
}

const EXTRA = [
  { key: 'halcyon', name: 'Halcyon Rollup (FICTIONAL)', symbol: 'XHAL', profile: 'network-infrastructure@2', claude: 91, gpt: 86, price: 2.84, mcap: 1.9e9, rank: 64, ch: [1.4, 9.8, 32.5], drift: 0.1, summary: 'Fictional: a rollup with real fee revenue that already reaches stakers; the valuation is full but the next upgrade is funded and dated.' },
  { key: 'northwind', name: 'Northwind Data Mesh (FICTIONAL)', symbol: 'XNDM', profile: 'network-infrastructure@2', claude: 81, gpt: 74, price: 0.4127, mcap: 412e6, rank: 182, ch: [0.86, -3.2, 12.4], drift: -0.03, summary: 'Fictional: data buyers pay in the token and usage is growing without incentives; the open question is whether the next unlock is absorbed.' },
  { key: 'atlas', name: 'Atlas Storage (FICTIONAL)', symbol: 'XATL', profile: 'network-infrastructure@2', claude: 84, gpt: 79, price: 7.21, mcap: 860e6, rank: 103, ch: [-0.42, 4.1, -2.6], drift: 0.04 },
  { key: 'kestrel', name: 'Kestrel Lending (FICTIONAL)', symbol: 'XKST', profile: 'payfi-credit@2', claude: 63, gpt: 58, price: 0.0912, mcap: 88e6, rank: 540, ch: [-2.31, -8.7, 4.9], drift: -0.08 },
  { key: 'ember', name: 'Ember Oracle (FICTIONAL)', symbol: 'XEMB', profile: 'network-infrastructure@2', claude: 36, gpt: 'withheld', price: 0.0234, mcap: 21e6, rank: 980, ch: [-5.6, -14.2, -31.8], drift: -0.18 },
  { key: 'tidepool', name: 'Tidepool Exchange (FICTIONAL)', symbol: 'XTDP', profile: 'general-token@2', claude: 55, gpt: 'working', price: 1.18, mcap: 240e6, rank: 290, ch: [2.08, 6.3, 15.1], drift: 0.06 },
  { key: 'lumen', name: 'Lumen Compute (FICTIONAL)', symbol: 'XLMN', profile: 'network-infrastructure@2', claude: 72, gpt: 'failed', price: 0.00731, mcap: 64e6, rank: 702, ch: [11.4, 27.9, 61.0], drift: 0.25 },
  { key: 'quarry', name: 'Quarry Restaking (FICTIONAL)', symbol: 'XQRY', profile: 'general-token@2', claude: 67, gpt: 'waiting', price: 14.62, mcap: 1.1e9, rank: 77, ch: [-0.08, 1.2, 8.8], drift: 0.01 },
  { key: 'solace', name: 'Solace Payments (FICTIONAL)', symbol: 'XSLC', profile: 'payfi-credit@2', claude: 48, gpt: 52, price: 0.188, mcap: 33e6, rank: 845, ch: [0.31, -1.9, -7.7], drift: -0.02, unwatched: true },
  { key: 'vireo', name: 'Vireo Games (FICTIONAL)', symbol: 'XVIR', profile: 'general-token@2', claude: 29, gpt: null, price: 0.0011, mcap: 4.2e6, rank: 2210, ch: [-1.2, -6.6, -22.4], drift: -0.1, archived: true },
];

const offline0 = async () => ({ status: 'noop', message: 'FICTIONAL dev desk: offline' });

function contractFor(symbol) {
  return `0x${crypto.createHash('sha1').update(`FICTIONAL-DEV-${symbol}`).digest('hex')}`;
}

(async () => {
  const f = buildBriefWorkspace('dev-desk');
  const { ws } = f;
  const pids = { ...f.pids };
  const cg = { ...Object.fromEntries(Object.entries(IDS).map(([k, v]) => [k, `${v}-cg`])) };
  const day = ymdInTz();

  // Settings: no model has an API key; Gemini is on hold, as on the real desk.
  const settingsFile = ws.abs('config/settings.json');
  const s = readJson(settingsFile);
  s.research = { ...(s.research || {}), providers: {}, default_providers: ['claude', 'chatgpt', 'gemini'], on_hold: { gemini: { since: '2026-10-04', reason: 'FICTIONAL hold' } } };
  atomicWrite(settingsFile, jsonText(s));
  ws.reloadSettings && ws.reloadSettings();

  const importAs = (provider, pid, text, opts = {}) => {
    const out = inbox.importContent(ws, provider, { content: text, projectId: pid, ...opts });
    if (out.result.status !== 'ingested') throw new Error(`dev desk import failed: ${out.result.message}`);
    return out.result;
  };
  const hz = (run) => ({ start: run.horizon.start_date, end: run.horizon.end_date, text: run.horizon.text, mode: run.horizon.mode });
  const setJob = (pid, runId, provider, patch) => {
    const file = ws.abs(`projects/${pid}/research/${runId}/run.json`);
    const run = readJson(file);
    run.jobs[provider] = { ...run.jobs[provider], ...patch };
    atomicWrite(file, jsonText(run));
  };

  for (const x of EXTRA) {
    const res = projects.addProject(ws, {
      name: x.name, symbol: x.symbol, sector_profile: x.profile,
      official_website: `https://${x.symbol.toLowerCase()}.example/`,
      coingecko_id: `${x.key}-fictional-cg`,
      assets: [{ chain: x.key === 'atlas' ? 'base' : 'ethereum', contract_address: contractFor(x.symbol) }],
      evidence: [{ url: `https://${x.symbol.toLowerCase()}.example/token`, note: 'FICTIONAL dev evidence' }],
    });
    if (res.status !== 'created') throw new Error(`dev project not created: ${res.message}`);
    const pid = res.project_id;
    pids[x.key] = pid;
    cg[x.key] = `${x.key}-fictional-cg`;
    const project = { project_id: pid, name: x.name };
    const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt'], channel: 'dashboard', force_new: true }).run;
    const at = addDays(day, -Math.floor(seeded(x.key)() * 20));
    importAs('claude', pid, reportText({ project, symbol: x.symbol, profile: run.sector_profile, run, analysisAt: at, horizon: hz(run), edit: tuned(x.claude, `${x.key}-c`, { summary: x.summary || null }) }), { runId: run.run_id });
    if (typeof x.gpt === 'number' || x.gpt === 'withheld') {
      const g = typeof x.gpt === 'number' ? x.gpt : 50;
      importAs('chatgpt', pid, reportText({ project, symbol: x.symbol, profile: run.sector_profile, run, analysisAt: at, horizon: hz(run), edit: (j) => { tuned(g, `${x.key}-g`, { withheld: x.gpt === 'withheld' })(j); j.provider = 'chatgpt'; j.model_self_identification = 'FICTIONAL dev fixture labeled as ChatGPT'; } }), { runId: run.run_id });
    } else if (x.gpt === 'working') {
      setJob(pid, run.run_id, 'chatgpt', { state: 'running', mode: 'connector', progress_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    } else if (x.gpt === 'failed') {
      setJob(pid, run.run_id, 'chatgpt', { state: 'failed', error: 'FICTIONAL: the provider answered 500 twice; nothing was saved.', updated_at: new Date().toISOString() });
    }
    if (x.unwatched) projects.setWatchlist(ws, pid, false);
    if (['halcyon', 'atlas', 'kestrel'].includes(x.key)) projects.markReviewed(ws, pid, {});
  }
  // The brief fixture's projects: two reviewed, so the queue is not everything.
  projects.markReviewed(ws, pids.sparse, {});
  projects.markReviewed(ws, pids.waiting, {});

  // A holding (Portfolio is its own page; the list only says Held).
  portfolio.addAccount(ws, { account_id: 'dev-exchange', name: 'Dev exchange (FICTIONAL)', kind: 'exchange' });
  portfolio.addTransactions(ws, [
    { type: 'buy', account_id: 'dev-exchange', asset_id: cg.halcyon, quantity: '1200', price_usd: '2.1', date: addDays(day, -40) },
    { type: 'buy', account_id: 'dev-exchange', asset_id: cg.complete, quantity: '3000', price_usd: '0.82', date: addDays(day, -12) },
  ], { source: 'dev' });

  // A tracked wallet with one balance read, written as a sync would (FICTIONAL
  // address and tokens; no provider is asked): ETH, a verified project token
  // and a token no identity names, for the Portfolio balance sheet.
  const walletsCore = require(`${ROOT}/core/wallets.js`);
  const devWallet = walletsCore.addWallet(ws, { label: 'Dev wallet (FICTIONAL)', address: '0x00000000000000000000000000000000000de71e', networks: ['eth'] });
  const walletRec = walletsCore.walletById(ws, devWallet.wallet_id);
  const xhal = contractFor('XHAL').toLowerCase();
  const stray = contractFor('XUNK').toLowerCase();
  walletsCore.storeMetadata(ws, 'eth', [
    { contract: xhal, name: 'Example Halcyon Rollup (FICTIONAL)', symbol: 'XHAL', decimals: 18 },
    { contract: stray, name: 'Unknown token (FICTIONAL)', symbol: 'XUNK', decimals: 18 },
  ]);
  walletsCore.storeBalances(ws, walletRec, 'eth', { native_raw: '1532000000000000000', tokens: [{ contract: xhal, balance_raw: '2500000000000000000000' }, { contract: stray, balance_raw: '4000000000000000000000' }], block: 20000000 });

  // Contract screens from a stubbed GoPlus (nothing is sent anywhere).
  const CLEAN = {
    is_mintable: '0', is_proxy: '0', is_blacklisted: '0', is_whitelisted: '0', owner_change_balance: '0', hidden_owner: '0',
    selfdestruct: '0', external_call: '0', can_take_back_ownership: '0', transfer_pausable: '0', trading_cooldown: '0',
    is_honeypot: '0', cannot_buy: '0', cannot_sell_all: '0', slippage_modifiable: '0', personal_slippage_modifiable: '0',
    is_anti_whale: '0', is_open_source: '1', buy_tax: '0', sell_tax: '0', owner_address: '0x0000000000000000000000000000000000000000',
    holder_count: '12345', lp_holder_count: '67', is_in_dex: '1', trust_list: '0',
  };
  const VARIANT = { [contractFor('XLMN')]: { is_mintable: '1', is_proxy: '1' }, [contractFor('XEMB')]: { sell_tax: '0.12', is_blacklisted: '1', owner_address: '0x00000000000000000000000000000000000000ab' }, [contractFor('XKST')]: { is_proxy: '1', owner_change_balance: '1', hidden_owner: '1' } };
  const goplus = async (url) => {
    const addr = (String(url).match(/contract_addresses=([^&]+)/) || [])[1];
    const a = decodeURIComponent(addr || '').toLowerCase();
    const body = { code: 1, message: 'OK', result: { [a]: { ...CLEAN, ...(VARIANT[a] || {}) } } };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  for (const key of ['halcyon', 'northwind', 'atlas', 'kestrel', 'ember', 'tidepool', 'lumen', 'quarry', 'complete', 'withheld']) {
    try {
      await screening.refresh(ws, { fetchImpl: goplus, force: true, projectIds: [pids[key]], retryDelayMs: 0, pauseMs: 0 });
    } catch (err) {
      console.error(`screen ${key}: ${err.message}`);
    }
  }

  // Prices: every project, FICTIONAL, with 7-day series; one stale on purpose.
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const obs = (id, symbol, name, price, extra) => ({ id, symbol, name, image_url: null, price_usd: price, rank_source: 'fictional-demo', source: 'FICTIONAL demo data', source_last_updated_at: iso(2 * 60000), fetched_at: iso(60000), ...extra });
  const assets = {};
  const add = (key, symbol, name, price, mcap, rank, [c24, c7, c30], drift, extra = {}) => {
    const id = cg[key];
    assets[id] = obs(id, symbol, name, price, { market_cap_usd: mcap, market_cap_rank: rank, fdv_usd: mcap * (1.4 + seeded(key)() * 2), volume_24h_usd: mcap * (0.02 + seeded(`${key}v`)() * 0.08), change_24h_pct: c24, change_7d_pct: c7, change_30d_pct: c30, market_cap_change_24h_pct: c24 * 0.97, sparkline_7d: series(key, price / (1 + c7 / 100), drift), ...extra });
  };
  add('complete', 'XRLY', 'Example Relay Network (FICTIONAL)', 1.07, 214e6, 233, [3.12, 8.4, 21.7], 0.08);
  add('withheld', 'XLDG', 'Example Ledger Credit (FICTIONAL)', 0.31, 61e6, 640, [-1.84, -4.1, 2.2], -0.04, { source_last_updated_at: iso(3 * 86400000), fetched_at: iso(3 * 86400000) });
  add('ranges', 'XRNG', 'Example Range Labs (FICTIONAL)', 0.0577, 9.8e6, 1540, [4.4, -2.2, -11.9], -0.02);
  add('sparse', 'XSPR', 'Example Sparse Token (FICTIONAL)', 0.62, 41e6, 760, [0.12, 0.9, -3.3], 0.01);
  add('quarantined', 'XQRN', 'Example Quarantine Network (FICTIONAL)', 3.4, 150e6, 360, [-0.9, 2.6, 6.1], 0.03);
  add('waiting', 'XWTG', 'Example Waiting Protocol (FICTIONAL)', 0.044, 18e6, 1104, [6.7, 18.2, 40.4], 0.17);
  add('none', 'XNON', 'Example Unresearched Token (FICTIONAL)', 0.00093, 2.6e6, 2611, [-2.2, -9.1, -18.6], -0.09);
  add('long', 'XLNG', 'Example Long (FICTIONAL)', 0.0042, 3.1e6, 2405, [-3.4, -12.5, -28.1], -0.13);
  for (const x of EXTRA) add(x.key, x.symbol, x.name, x.price, x.mcap, x.rank, x.ch, x.drift);
  assets.ethereum = obs('ethereum', 'ETH', 'Ethereum (FICTIONAL price)', 2450, { market_cap_usd: 2.9e11, market_cap_rank: 2, change_24h_pct: 1.1, change_7d_pct: 3.2, change_30d_pct: 6.4 });
  atomicWrite(ws.abs('market-data/latest.json'), jsonText({ schema_version: 'cr.market-latest.v2', provider: 'fictional-demo', rank_source: 'FICTIONAL demo rank', note: 'FICTIONAL prices for frontend development.', fetched_at: iso(60000), assets }));
  atomicWrite(ws.abs('market-data/status.json'), jsonText({ schema_version: 'cr.market-status.v2', state: 'ok', last_attempt_at: iso(60000), last_success_at: iso(60000), last_trigger: 'dev', last_error: null, consecutive_failures: 0, note: 'FICTIONAL', calls: { month: iso(0).slice(0, 7), month_count: 0, day: iso(0).slice(0, 10), day_count: 0 } }));

  // Logos for most projects (two keep a monogram, as an unlisted logo does).
  fs.mkdirSync(ws.abs('market-data/logos'), { recursive: true });
  for (const [key, id] of Object.entries(cg)) {
    if (['none', 'sparse'].includes(key)) continue;
    fs.writeFileSync(ws.abs(`market-data/logos/${id}.lg.png`), logoPng(id));
  }

  // A market snapshot: Bitcoin, dominance, total market cap, and breadth over
  // 30 days across a hundred FICTIONAL coins.
  const capturedAt = new Date().toISOString();
  const rnd = seeded('breadth');
  const rows = [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 61240, market_cap: 1.2e12, price_change_percentage_7d_in_currency: 2.2, price_change_percentage_30d_in_currency: 5.1, last_updated: capturedAt },
    { id: 'tether', symbol: 'usdt', name: 'Tether', current_price: 1, market_cap: 1.1e11, price_change_percentage_7d_in_currency: 0, price_change_percentage_30d_in_currency: 0.01, last_updated: capturedAt }];
  for (let i = 0; i < 100; i++) rows.push({ id: `fictional-coin-${i}`, symbol: `xc${i}`, name: `Fictional coin ${i}`, current_price: 1 + i, market_cap: 1e9 - i * 5e6, price_change_percentage_7d_in_currency: (rnd() - 0.5) * 20, price_change_percentage_30d_in_currency: (rnd() - 0.55) * 40, last_updated: capturedAt });
  const global = { data: { total_market_cap: { usd: 2.14e12 }, total_volume: { usd: 7.2e10 }, market_cap_percentage: { btc: 56.4, eth: 11.8 }, market_cap_change_percentage_24h_usd: -0.42, updated_at: Math.floor(Date.now() / 1000) } };
  cycle.saveSnapshot(ws, cycle.buildSnapshot({ global, rows, capturedAt, fictional: true }));

  // Forensics (FICTIONAL): the relay project has an assessment from 20 days
  // ago with ChatGPT's challenge, product checks with a 4-day outage that
  // recovered, daily repository reads and 45 days of volume, so the tab draws
  // past and upcoming checkpoints and dated conditional estimates; Ember has
  // an audit open with nothing saved; every other project has nothing.
  {
    const F = require(`${ROOT}/core/forensics.js`);
    const FX = require(`${ROOT}/tests/forensic-fixtures.js`);
    const pid = pids.complete;
    const t0 = Date.now() - 20 * 86400000;
    const a = F.createAudit(ws, { project_id: pid, assistant: 'claude', challenge: true, channel: 'dev' });
    const auditFile = ws.abs(F.auditRel(pid, a.audit_id));
    const audit = readJson(auditFile);
    audit.created_at = new Date(t0 - 3600000).toISOString();
    atomicWrite(auditFile, jsonText(audit));
    // CoinGecko volume for 45 days, falling about 2% a day (FICTIONAL).
    const vid = cg.complete;
    const byMonth = new Map();
    for (let h = 45 * 24; h >= 0; h -= 6) {
      const at = new Date(Date.now() - h * 3600000).toISOString();
      const line = { fetched_at: at, provider: 'fictional-demo', trigger: 'dev', assets: [{ id: vid, source_last_updated_at: at, price_usd: 1.07, volume_24h_usd: Math.round(9.5e6 * 0.98 ** ((45 * 24 - h) / 24)) }] };
      const m = at.slice(0, 7);
      byMonth.set(m, [...(byMonth.get(m) || []), JSON.stringify(line)]);
    }
    fs.mkdirSync(ws.abs('market-data/observations'), { recursive: true });
    for (const [m, lines] of byMonth) fs.appendFileSync(ws.abs(`market-data/observations/${m}.jsonl`), `${lines.join('\n')}\n`);
    const asOf = new Date(t0).toISOString();
    const s = F.saveReport(ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(F.loadAudit(ws, pid, a.audit_id), { assessment_as_of: asOf, delivery: { observations: [] } }) });
    F.saveReport(ws, { project_id: pid, audit_id: a.audit_id, provider: 'chatgpt', text: FX.challengeText(F.loadAudit(ws, pid, a.audit_id), s.receipt) });
    F.setMonitoring(ws, pid, { approve: { receipt_id: s.receipt_id }, enabled: true, by: 'dev' });
    const prof = F.readProfile(ws, pid);
    const pc = prof.targets.product_checks[0];
    const gh = prof.targets.repositories[0];
    for (let h = 0; h <= 20 * 24; h += 6) {
      const at = new Date(t0 + h * 3600000).toISOString();
      const down = h >= 6 * 24 && h < 10 * 24;
      F.appendObservation(ws, pid, { kind: 'product_check', target_id: pc.target_id, label: pc.label, url: pc.url, observed_at: at, outcome: down ? 'fail' : 'pass', http_status: down ? 503 : 200, error: down ? 'Answered 503.' : null, excerpt: down ? null : 'All systems operational (FICTIONAL)' });
      if (h % 24 === 0) F.appendObservation(ws, pid, { kind: 'repository_read', target_id: gh.target_id, repository: `github.com/${gh.owner}/${gh.repo}`, observed_at: at, status: 'ok', latest_delivery_at: new Date(t0 - 52 * 86400000).toISOString(), latest_commit: { sha: 'f1c7i0n4l', at: new Date(t0 - 52 * 86400000).toISOString(), message: 'FICTIONAL commit' } });
    }
    // Exit quotes approved on the relay's (FICTIONAL) Ethereum contract, every
    // 12 hours: within the 5% limit at $500 until a thin stretch from day 12
    // to day 16 (an episode that recovers); $2,000 finds no route then.
    // Nothing is asked of any quote source: these are written as fixtures.
    const xo = require(`${ROOT}/core/exitquotes.js`).quoteOptions(projects.getProject(ws, pid)).find((o) => o.supported);
    if (xo) {
      F.setMonitoring(ws, pid, { approve_quotes: [xo.key], by: 'dev' });
      const xt = F.readProfile(ws, pid).targets.exit_quotes[0];
      for (let h = 0; h <= 20 * 24; h += 12) {
        const at = new Date(t0 + h * 3600000).toISOString();
        const thin = h >= 12 * 24 && h < 16 * 24;
        for (const size of [100, 500, 2000]) {
          const cost = (size === 100 ? 0.9 : size === 500 ? 2.4 : 6.1) * (thin ? 2.6 : 1) + (h % 48) / 100;
          const noRoute = thin && size === 2000;
          F.appendObservation(ws, pid, { kind: 'executable_quote', source: 'monitor', target_id: xt.target_id, provider: xt.provider, provider_label: 'KyberSwap', venue: 'KyberSwap', mechanism: 'aggregator', route_scope: 'aggregator', chain: xt.chain_label, chain_id: xt.chain_id, contract_address: xt.contract_address, observed_at: at, retrieved_at: at, size_usd: size, status: noRoute ? 'no_route' : 'quoted', quote: noRoute ? { sell_usd: size, received_usd: null, no_route: true, route: null } : { sell_usd: size, received_usd: Math.round(size * (1 - cost / 100) * 100) / 100, fees_usd: null, price_impact_pct: Math.round((cost - 0.3) * 100) / 100, gas_usd: 0.42, gas_included: false, route: 'FICTIONAL pool A > FICTIONAL pool B', no_route: false, valuation_note: 'FICTIONAL dev quote: nothing was asked of any quote source.' }, note: 'FICTIONAL dev desk fixture.' });
        }
      }
    }
    F.recordDueResolutions(ws, pid, { now: Date.now() });
    F.createAudit(ws, { project_id: pids.ember, channel: 'dev' });
    const mon = require(`${ROOT}/core/forensic-monitor.js`);
    mon.isDue = () => false;
    mon.refresh = offline0;
  }

  // The archived one last, so its history stays.
  const vireo = EXTRA.find((x) => x.archived);
  projects.archiveProject(ws, pids[vireo.key], 'FICTIONAL: archived for the dev desk');

  // Nothing runs or fetches from here on.
  research.runDueJobs = async () => ({ status: 'noop' });
  research.hasDueWork = () => false;
  research.hasBackgroundWork = () => false;
  const offline = async () => ({ status: 'noop', message: 'FICTIONAL dev desk: offline' });
  for (const m of ['fundamentals', 'screening']) {
    const mod = require(`${ROOT}/core/${m}.js`);
    mod.isDue = () => false;
    mod.refresh = offline;
  }
  require(`${ROOT}/core/market.js`).refresh = offline;
  cycle.refreshContext = offline;
  const jobs = require(`${ROOT}/core/jobs.js`);
  const runJob = jobs.runJob;
  jobs.runJob = async (w, name, opts) => (name === 'wallets' ? { status: 'skipped' } : runJob(w, name, opts));
  require(`${ROOT}/core/indexer.js`).rebuildIndex(ws);

  const { start } = require(`${ROOT}/server.js`);
  const srv = await start(ws, { port: PORT, quiet: true });
  const out = { url: `http://127.0.0.1:${srv.port}`, root: ws.root, pids, reports: f.reports, runs: f.runs };
  if (INFO) fs.writeFileSync(INFO, JSON.stringify(out, null, 2));
  console.log(`FICTIONAL dev desk on ${out.url} (workspace ${ws.root})`);
  if (process.send) process.send({ ready: true, ...out });
  const stop = () => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    f.cleanup();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
