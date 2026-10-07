'use strict';
// The wallet sync: reads each tracked wallet's networks from Alchemy on the
// desk's own schedule (jobs.js "wallets"; on the online desk a one-minute
// check in server.js, on the PC also the hourly task). Twice daily by default:
// a personal free account needs little, and nothing polls more often.
// Read-only (alchemy.js).
//
// Per wallet and network, each run:
//   1. The head block and the chain's finalized block (the "finalized" tag;
//      a fixed depth only where a chain does not answer it).
//   2. History, one window: from the last complete read minus an overlap
//      (recheck_minutes of blocks; from block 0 the first time, a backfill) to
//      the head read in step 1. Three queries, each paged to the end in block
//      order: every transaction the wallet sent (zero value included, for its
//      fee), ETH sent by contracts and tokens out, and everything in. After
//      each page its transfers and their receipts are saved and the place is
//      kept (the block reached, and Alchemy's pageKey while it lives), so a
//      restart, a cap or a page limit continues where it stopped.
//   3. When all three are complete: receipts still missing, and those of
//      transactions not final yet, are asked again. A receipt that is gone is
//      a reversal only if the block that held it now has another hash. Then
//      the count of transactions the wallet sent (its nonce) is compared with
//      those seen, token details are asked once per token, and every
//      transaction is classified and marked final at the finalized block
//      (wallets.settleNetwork).
//   4. Balances, when new activity appeared, when asked (Sync now) or every
//      balance_refresh_minutes: the native balance and every token balance,
//      every page, or no snapshot at all.
//   5. Then, for every wallet, final events are recorded in the ledger or held
//      with their reason (wallets.importReady), and reconciliation differences
//      get the time they were first seen.
//
// Shared by every runner: one lease (no two syncs at once), Alchemy's rate
// limit (a Retry-After is honored; otherwise a doubling wait), a failure
// backoff per network, a key refusal or a used-up plan pausing everything,
// and daily and monthly compute-unit caps reserved on disk before each request
// is sent, retries and pages included. These counts are the desk's estimate
// from Alchemy's published method costs; Alchemy's dashboard is the record.
// "Sync now" marks the wallet's networks as asked for; the same queue runs
// them. A restored copy (config/restored-copy.json) asks nothing until it is
// released, like research.
//
// Status (portfolio/wallets/sync-state.json) holds counts, times, blocks,
// places and errors: never an address, a key, an endpoint URL or a token name.
// Logs name wallets by label.

const { readJson, jsonText } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease, leaseInfo } = require('./leases');
const { ymdInTz } = require('./dates');
const { randomId, compactTs } = require('./ids');
const alchemy = require('./alchemy');
const wallets = require('./wallets');

const STATE_REL = `${wallets.DIR}/sync-state.json`;
const LEASE = 'wallet-sync';
const RATE_LIMIT_DEFAULT_MS = 2 * 60000;
const RATE_LIMIT_MIN_MS = 30000;
const RETRY_AFTER_CEILING_MS = 24 * 3600000;
const KEY_REFUSED_MS = 6 * 3600000;
const QUOTA_MS = 24 * 3600000;
const PAGE_KEY_LIFE_MS = 9 * 60000;

const isoOf = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const netKey = (walletId, network) => `${walletId}:${network}`;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

function emptyState() {
  return { schema_version: 'cr.wallet-sync-state.v2', provider: 'alchemy', networks: {}, reconciliation: {} };
}

function readState(ws) {
  try {
    const s = readJson(ws.abs(STATE_REL), null);
    return s && typeof s === 'object' ? { ...emptyState(), ...s, networks: s.networks || {}, reconciliation: s.reconciliation || {} } : emptyState();
  } catch (_) {
    return { ...emptyState(), unreadable: true };
  }
}

function updateState(ws, fn) {
  return withLock(ws, 'wallet_sync_state', () => {
    const next = fn(readState(ws));
    replaceFile(ws, ws.abs(STATE_REL), jsonText({ ...next, schema_version: 'cr.wallet-sync-state.v2', provider: 'alchemy' }));
    return next;
  });
}

function updateNetwork(ws, key, patch) {
  return updateState(ws, (s) => ({ ...s, networks: { ...s.networks, [key]: { ...(s.networks[key] || {}), ...patch } } }));
}

// ---------------------------------------------------------------------------
// Compute units (estimated), gate, backoff

function callCounts(state, now) {
  const today = ymdInTz(new Date(now));
  const month = today.slice(0, 7);
  const prev = state.calls || {};
  const c = prev.month === month ? { ...prev, methods: { ...(prev.methods || {}) } } : { month, month_count: 0, month_cu: 0, month_answered: 0, day: today, day_count: 0, day_cu: 0, day_answered: 0, methods: {} };
  if (c.day !== today) Object.assign(c, { day: today, day_count: 0, day_cu: 0, day_answered: 0 });
  return c;
}

// Reserves one request's estimated compute units before it is sent, on disk,
// so no runner goes past the day's or the month's cap and a stop mid-request
// still counts it. False when a cap would be passed (nothing is counted then).
function reserveCu(ws, cfg, cu, method, now) {
  return withLock(ws, 'wallet_sync_state', () => {
    const cur = readState(ws);
    const c = callCounts(cur, now);
    if (cfg.daily_cu_cap && (c.day_cu || 0) + cu > cfg.daily_cu_cap) return false;
    if (cfg.monthly_cu_cap && (c.month_cu || 0) + cu > cfg.monthly_cu_cap) return false;
    const methods = { ...c.methods, [method]: (c.methods[method] || 0) + 1 };
    const next = { ...c, methods, day_count: c.day_count + 1, month_count: c.month_count + 1, day_cu: (c.day_cu || 0) + cu, month_cu: (c.month_cu || 0) + cu };
    replaceFile(ws, ws.abs(STATE_REL), jsonText({ ...cur, calls: next, schema_version: 'cr.wallet-sync-state.v2', provider: 'alchemy' }));
    return true;
  });
}

function backoffMs(cfg, failures) {
  const base = cfg.backoff_initial_minutes * 60000;
  return Math.min(cfg.backoff_max_minutes * 60000, base * 2 ** Math.max(0, failures - 1));
}

// Closed while Alchemy asked the desk to wait, after it refused the key, or
// after it said the plan's capacity is used up.
function gateOf(state, now) {
  const until = state.retry_after_until ? Date.parse(state.retry_after_until) : 0;
  if (until > now) return { open: false, rate_limited: true, until: state.retry_after_until, why: 'Alchemy asked the desk to wait (rate limit)' };
  const quota = state.quota_until ? Date.parse(state.quota_until) : 0;
  if (quota > now) return { open: false, rate_limited: false, until: state.quota_until, why: state.quota_error || 'Alchemy says the plan\'s capacity is used up' };
  const paused = state.key_refused_until ? Date.parse(state.key_refused_until) : 0;
  if (paused > now) return { open: false, rate_limited: false, until: state.key_refused_until, why: state.key_refused_error || 'Alchemy refused the key' };
  return { open: true };
}

function rateLimitFields(state, retryAfter, now) {
  const given = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null;
  const prev = state.rate_limit || null;
  const prevEnd = prev && prev.until ? Date.parse(prev.until) : NaN;
  const strikes = !Number.isNaN(prevEnd) && now - prevEnd < 3600000 ? (prev.strikes || 1) + 1 : 1;
  const waitMs = given !== null ? Math.min(RETRY_AFTER_CEILING_MS, Math.max(RATE_LIMIT_MIN_MS, given)) : Math.min(60 * 60000, RATE_LIMIT_DEFAULT_MS * 2 ** (strikes - 1));
  const until = isoOf(now + waitMs);
  return { retry_after_until: until, rate_limit: { at: isoOf(now), retry_after_ms: given, wait_ms: waitMs, strikes, until } };
}

function restored(ws) {
  try {
    return require('./research').restoredHold(ws);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What is due

// The wallet networks a run would read now, each with why. A network Alchemy
// does not cover is never a target.
function targets(ws, now, { state = null, walletIds = null, force = false } = {}) {
  const cfg = wallets.cfgOf(ws);
  const s = state || readState(ws);
  const out = [];
  for (const w of wallets.listWallets(ws)) {
    if (w.status !== 'active') continue;
    if (Array.isArray(walletIds) && !walletIds.includes(w.wallet_id)) continue;
    for (const network of w.networks) {
      const info = wallets.networkInfo(network);
      if (!info || !info.supported) continue;
      const st = s.networks[netKey(w.wallet_id, network)] || {};
      const lastAt = st.last_attempt ? Date.parse(st.last_attempt.at) : 0;
      // Cleared by the run that serves it, so any value still here is asked for.
      const requested = Boolean(st.requested_at);
      const spaced = now - lastAt >= cfg.sync_now_min_seconds * 1000;
      const backoff = st.next_attempt_at && Date.parse(st.next_attempt_at) > now;
      const byInterval = !st.last_attempt || now - lastAt >= cfg.interval_minutes * 60000 - 60000;
      // A long read stopped by a page limit continues at the next check.
      const continuing = Boolean(st.pass) && Boolean(st.last_attempt) && st.last_attempt.outcome === 'partial';
      const due = force || ((requested || continuing) && spaced) || (byInterval && !backoff);
      out.push({ wallet: w, network, key: netKey(w.wallet_id, network), st, requested, due });
    }
  }
  return out;
}

function configured(ws) {
  const cfg = wallets.cfgOf(ws);
  if (!cfg.enabled) return { ok: false, why: 'Wallet sync is turned off in settings.' };
  if (!wallets.listWallets(ws).some((w) => w.status === 'active')) return { ok: false, why: 'No wallet is being tracked.' };
  if (!alchemy.apiKey()) return { ok: false, why: 'No Alchemy key: set ALCHEMY_API_KEY in Render > Environment (or "alchemy_api_key" in ~/.cryptoresearch/secrets.json on the PC).', key: false };
  return { ok: true };
}

function isDue(ws, now = Date.now()) {
  if (!configured(ws).ok || restored(ws)) return false;
  const s = readState(ws);
  if (!gateOf(s, now).open) return false;
  return targets(ws, now, { state: s }).some((t) => t.due);
}

// "Sync now": the wallet's networks are asked for; the next run (within a
// minute on the desk) reads them, in the same queue and under the same caps.
function requestSync(ws, walletId, { now = Date.now() } = {}) {
  const w = wallets.walletById(ws, walletId);
  if (w.status !== 'active') return { status: 'refused', message: w.status === 'paused' ? 'Syncing is paused for this wallet. Resume it first.' : 'This wallet is no longer tracked.' };
  const c = configured(ws);
  if (!c.ok) return { status: 'not_configured', message: c.why };
  if (restored(ws)) return { status: 'held', message: 'This is a restored copy: wallet sync asks Alchemy for nothing until it is released (node dashboard/cli.js restored-copy release --confirm).' };
  const nets = w.networks.filter((n) => wallets.networkInfo(n) && wallets.networkInfo(n).supported);
  if (!nets.length) return { status: 'refused', message: 'None of this wallet\'s networks is covered by Alchemy\'s transfer history.' };
  updateState(ws, (s) => {
    const networks = { ...s.networks };
    for (const n of nets) networks[netKey(w.wallet_id, n)] = { ...(networks[netKey(w.wallet_id, n)] || {}), requested_at: isoOf(now) };
    return { ...s, networks };
  });
  const g = gateOf(readState(ws), now);
  return { status: 'queued', message: g.open ? 'Sync asked for. It runs within a minute, in turn with any sync already running.' : `Sync asked for. ${g.why}; it runs after ${g.until}.`, wallet_id: w.wallet_id };
}

// ---------------------------------------------------------------------------
// The run

function failureOf(r) {
  if (!r) return { outcome: 'failed', error: 'no answer' };
  if (r.kind === 'rate_limited') return { outcome: 'rate_limited', error: 'Alchemy rate-limited the request', retry_after_ms: r.retry_after_ms };
  if (r.kind === 'budget') return { outcome: 'budget', error: 'the compute-unit cap for today or this month is reached' };
  if (r.kind === 'key_refused') return { outcome: 'key_refused', error: r.error };
  if (r.kind === 'quota') return { outcome: 'quota', error: r.error };
  return { outcome: 'failed', error: `${r.error || 'the request failed'}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ''}` };
}

// The three history queries, in this order, for one network.
function phasesOf(network, me) {
  const internal = wallets.networkInfo(network).coverage.internal;
  return [
    { name: 'sent', params: { fromAddress: me, category: ['external'], excludeZeroValue: false } },
    { name: 'out', params: { fromAddress: me, category: internal ? ['internal', 'erc20'] : ['erc20'], excludeZeroValue: true } },
    { name: 'in', params: { toAddress: me, category: internal ? ['external', 'internal', 'erc20'] : ['external', 'erc20'], excludeZeroValue: true } },
  ];
}

// One wallet network. Returns { outcome: ok | partial | failed | rate_limited
// | budget | key_refused | quota, ... }.
async function syncOne(ws, t, ctx) {
  const { cfg, clock, counts } = ctx;
  const w = t.wallet;
  const network = t.network;
  const info = wallets.networkInfo(network);
  const me = String(w.address).toLowerCase();
  const rpc = async (method, params) => {
    if (ctx.sentAny && ctx.pauseMs) await sleep(ctx.pauseMs);
    ctx.sentAny = true;
    return alchemy.call(network, method, params, { fetchImpl: ctx.fetchImpl, key: ctx.key, timeoutMs: ctx.timeoutMs, maxAttempts: Math.max(1, cfg.max_attempts), retryDelayMs: ctx.retryDelayMs, reserve: (cu, m) => reserveCu(ws, cfg, cu, m, clock()), counts });
  };
  // 1. Head and finalized block.
  let r = await rpc('eth_blockNumber', []);
  if (!r || r.kind !== 'ok' || alchemy.hexToDec(r.result) === null) return r && r.kind === 'ok' ? { outcome: 'failed', error: 'eth_blockNumber: not a block number' } : failureOf(r);
  const head = BigInt(alchemy.hexToDec(r.result));
  // A node behind the history already read answers nothing new and could
  // make finality look lower: tried again later, nothing read.
  if (t.st.history_complete_to && head < BigInt(t.st.history_complete_to)) return { outcome: 'failed', error: `Alchemy answered head block ${head}, behind block ${t.st.history_complete_to} already read; nothing was read this time` };
  r = await rpc('eth_getBlockByNumber', ['finalized', false]);
  let finalized;
  let finalizedBasis;
  if (r && r.kind === 'ok' && r.result && alchemy.hexToDec(r.result.number) !== null) {
    finalized = BigInt(alchemy.hexToDec(r.result.number));
    finalizedBasis = 'the chain\'s finalized block';
  } else if (r && (r.kind === 'refused' || (r.kind === 'ok' && !r.result))) {
    finalized = head > BigInt(info.confirm_blocks) ? head - BigInt(info.confirm_blocks) : 0n;
    finalizedBasis = `${info.confirm_blocks} blocks below the head (the chain did not answer "finalized")`;
  } else return failureOf(r);
  // Finality never goes back: an answer below the one already seen (another
  // node, a little behind) keeps the earlier block, so nothing recorded as
  // final becomes pending again.
  const seenFinal = /^\d{1,30}$/.test(String(t.st.finalized_block || '')) ? BigInt(t.st.finalized_block) : 0n;
  if (seenFinal > finalized && seenFinal <= head) finalized = seenFinal;
  updateNetwork(ws, t.key, { head_block: String(head), finalized_block: String(finalized), finalized_basis: finalizedBasis });

  // 2. History window.
  let pass = t.st.pass || null;
  if (!pass) {
    const done = t.st.history_complete_to ? BigInt(t.st.history_complete_to) : null;
    const overlap = BigInt(Math.ceil(cfg.recheck_minutes * info.blocks_per_minute));
    const from = done === null ? 0n : done > overlap ? done - overlap : 0n;
    // query_from: where the paged query now running started (a pageKey only
    // works with the query's own parameters); resume_block: the last block
    // fully reached, where a new query starts once the pageKey has expired.
    pass = { id: `p_${compactTs(new Date(clock()))}_${randomId(4)}`, from_block: String(from), to_block: String(head), phase: 0, query_from: String(from), resume_block: String(from), page_key: null, page_key_at: null, pages: 0, items: 0, malformed: 0, backfill: done === null, started_at: isoOf(clock()) };
    updateNetwork(ws, t.key, { pass });
  }
  const phases = phasesOf(network, me);
  let stop = null;
  let fresh = 0;
  let keyRetry = false;
  // A receipt as answered: { receipt } (null only when Alchemy answered null:
  // not in the chain), or { malformed } for anything else that is not this
  // transaction's receipt, which is never taken as evidence of anything.
  const receiptOf = (h, result) => {
    if (result === null) return { receipt: null };
    const rc = alchemy.normalizeReceipt(result);
    return rc && rc.tx_hash === h ? { receipt: rc } : { malformed: true };
  };
  const fetchReceipts = async (hashes) => {
    const got = [];
    for (const h of hashes) {
      if (ctx.receipts >= cfg.max_receipts_per_run) return { got, stop: { outcome: 'partial', error: `stopped after ${ctx.receipts} receipts in this run; the rest are read next run` } };
      const rr = await rpc('eth_getTransactionReceipt', [h]);
      if (!rr || rr.kind !== 'ok') return { got, stop: failureOf(rr) };
      ctx.receipts++;
      const x = receiptOf(h, rr.result);
      if (x.malformed) continue;
      got.push({ tx_hash: h, receipt: x.receipt, raw: rr.result });
    }
    return { got, stop: null };
  };
  while (pass.phase < phases.length) {
    if (ctx.pages >= cfg.max_pages_per_run) {
      stop = { outcome: 'partial', error: `stopped after ${ctx.pages} pages in this run; the read continues next run from where it stopped` };
      break;
    }
    const ph = phases[pass.phase];
    const keyFresh = Boolean(pass.page_key) && clock() - Date.parse(pass.page_key_at) < PAGE_KEY_LIFE_MS;
    // With a live pageKey, the same query as the page before; otherwise a new
    // query from the last block reached (its transfers are read again and
    // deduplicated by uniqueId).
    const queryFrom = keyFresh ? pass.query_from || pass.resume_block : pass.resume_block;
    const params = { ...ph.params, fromBlock: hex(queryFrom), toBlock: hex(pass.to_block), withMetadata: true, order: 'asc', maxCount: '0x3e8', ...(keyFresh ? { pageKey: pass.page_key } : {}) };
    r = await rpc('alchemy_getAssetTransfers', [params]);
    if (!r || r.kind !== 'ok') {
      if (r && r.kind === 'refused' && keyFresh && !keyRetry) {
        // A page key Alchemy no longer takes: read on from the block reached.
        keyRetry = true;
        pass = { ...pass, page_key: null, page_key_at: null };
        updateNetwork(ws, t.key, { pass });
        continue;
      }
      stop = failureOf(r);
      break;
    }
    const list = r.result && Array.isArray(r.result.transfers) ? r.result.transfers : null;
    if (!list) {
      stop = { outcome: 'failed', error: 'alchemy_getAssetTransfers: the answer had no transfers' };
      break;
    }
    ctx.pages++;
    const items = list.map((item) => ({ item, t: alchemy.normalizeTransfer(item) }));
    const c = wallets.storeTransfers(ws, w, network, items, { passId: pass.id, now: clock(), own: ctx.own });
    fresh += c.new + c.changed;
    const rec = await fetchReceipts(c.need_receipts);
    wallets.storeReceipts(ws, w, network, rec.got, { now: clock() });
    const blocks = items.filter((x) => !x.t.error).map((x) => BigInt(x.t.block_number));
    const lastBlock = blocks.length ? blocks.reduce((a, b) => (b > a ? b : a)) : null;
    const nextKey = r.result.pageKey ? String(r.result.pageKey) : null;
    pass = { ...pass, query_from: queryFrom, page_key: nextKey, page_key_at: nextKey ? isoOf(clock()) : null, resume_block: nextKey && lastBlock !== null ? String(lastBlock) : pass.resume_block, pages: pass.pages + 1, items: pass.items + list.length, malformed: pass.malformed + c.malformed };
    if (!nextKey) pass = { ...pass, phase: pass.phase + 1, query_from: pass.from_block, resume_block: pass.from_block, page_key: null, page_key_at: null };
    updateNetwork(ws, t.key, { pass });
    if (rec.stop) {
      stop = rec.stop;
      break;
    }
  }

  // 3. A complete window: receipts, evidence, nonce, token details, settle.
  let settled = null;
  if (!stop && pass.phase >= phases.length) {
    const check = wallets.receiptsToCheck(ws, w, network, { finalized: String(finalized) });
    const missing = await fetchReceipts(check.missing);
    wallets.storeReceipts(ws, w, network, missing.got, { now: clock() });
    if (missing.stop) stop = missing.stop;
    if (!stop) {
      const results = [];
      for (const x of check.recheck) {
        if (ctx.receipts >= cfg.max_receipts_per_run) {
          stop = { outcome: 'partial', error: 'stopped at the receipt limit; the rest are read next run' };
          break;
        }
        const rr = await rpc('eth_getTransactionReceipt', [x.tx_hash]);
        if (!rr || rr.kind !== 'ok') {
          stop = failureOf(rr);
          break;
        }
        ctx.receipts++;
        const x0 = receiptOf(x.tx_hash, rr.result);
        if (x0.malformed) continue;
        const receipt = x0.receipt;
        let blockCheck = null;
        if (!receipt) {
          // Gone: ask what the block that held it is now.
          const br = await rpc('eth_getBlockByNumber', [hex(x.block_number), false]);
          if (!br || br.kind !== 'ok') {
            stop = failureOf(br);
            break;
          }
          // Only a block answered at that height is evidence; anything else is none.
          const answered = br.result && typeof br.result.hash === 'string' && alchemy.TX_HASH.test(br.result.hash) && alchemy.hexToDec(br.result.number) === String(x.block_number);
          blockCheck = { number: x.block_number, hash: answered ? br.result.hash.toLowerCase() : null };
        }
        results.push({ tx_hash: x.tx_hash, receipt, raw: rr.result, block_check: blockCheck });
      }
      wallets.storeReceipts(ws, w, network, results, { now: clock() });
    }
    if (!stop) {
      const nr = await rpc('eth_getTransactionCount', [me, hex(pass.to_block)]);
      if (nr && nr.kind === 'ok' && alchemy.hexToDec(nr.result) !== null) updateNetwork(ws, t.key, { sent_count_chain: alchemy.hexToDec(nr.result), sent_count_at_block: pass.to_block });
      else if (nr && ['rate_limited', 'budget', 'key_refused', 'quota'].includes(nr.kind)) stop = failureOf(nr);
    }
    if (!stop) {
      const meta = await fetchMetadata(ws, w, network, wallets.contractsNeedingMetadata(ws, w, network, [], { now: clock() }), { rpc, cfg, clock, ctx });
      if (meta.stop) stop = meta.stop;
    }
    // Classification and finality from what is stored (no request).
    settled = wallets.settleNetwork(ws, w, network, { finalized: String(finalized), now: clock(), own: ctx.own });
    if (!stop || stop.outcome === 'partial') {
      const sent = wallets.loadEventsDoc(ws, w.wallet_id, network);
      updateNetwork(ws, t.key, {
        pass: null,
        history_complete_to: pass.to_block,
        history_complete_at: isoOf(clock()),
        ...(pass.backfill ? { backfill_complete_at: isoOf(clock()) } : {}),
        sent_count_seen: String(wallets.sentSeenOf(sent, me)),
        last_pass: { id: pass.id, from_block: pass.from_block, to_block: pass.to_block, pages: pass.pages, items: pass.items, malformed: pass.malformed, backfill: pass.backfill, final: settled.final, reversed: settled.reversed },
      });
    }
  }

  // 4. Balances, after a history read Alchemy did not stop.
  let balances = 'not_due';
  if (!stop || stop.outcome === 'partial') {
    const lastBal = t.st.balances_checked_at ? Date.parse(t.st.balances_checked_at) : 0;
    const due = t.requested || fresh > 0 || (settled && settled.reversed) || !t.st.balances_complete_at || clock() - lastBal >= cfg.balance_refresh_minutes * 60000 - 60000;
    if (due) {
      const b = await readBalances(ws, w, network, { rpc, cfg, clock, ctx, head });
      if (b.stop) {
        balances = 'failed';
        if (!stop || b.stop.outcome !== 'partial') stop = b.stop;
        updateNetwork(ws, t.key, { balances_last_error: b.stop.error, balances_checked_at: isoOf(clock()) });
      } else {
        balances = 'saved';
        updateNetwork(ws, t.key, { balances_checked_at: isoOf(clock()), balances_complete_at: isoOf(clock()), balances_last_error: null });
      }
    }
  }
  const outcome = stop ? stop.outcome : settled ? 'ok' : 'partial';
  return { outcome, error: stop ? stop.error : null, retry_after_ms: stop ? stop.retry_after_ms : null, complete: Boolean(settled) && !stop, fresh, balances, settled };
}

// Token details (name, symbol, decimals) asked once per token, in the cap.
async function fetchMetadata(ws, w, network, contracts, { rpc, cfg, clock, ctx }) {
  const entries = [];
  let stop = null;
  for (const c of contracts) {
    if (ctx.metadata >= cfg.max_metadata_per_run) {
      stop = { outcome: 'partial', error: 'stopped at the token-details limit; the rest are read next run' };
      break;
    }
    const r = await rpc('alchemy_getTokenMetadata', [c]);
    if (!r || r.kind !== 'ok') {
      if (r && r.kind === 'refused') {
        entries.push({ contract: c, name: null, symbol: null, decimals: null, readable: false });
        continue;
      }
      stop = failureOf(r);
      break;
    }
    ctx.metadata++;
    const m = alchemy.normalizeMetadata(r.result) || { name: null, symbol: null, decimals: null };
    entries.push({ contract: c, ...m });
  }
  wallets.storeMetadata(ws, network, entries, { now: clock() });
  return { stop };
}

// The native balance and every token balance, every page, with token details
// for new tokens; saved only when complete.
async function readBalances(ws, w, network, { rpc, cfg, clock, ctx, head }) {
  const me = String(w.address).toLowerCase();
  const nb = await rpc('eth_getBalance', [me, 'latest']);
  if (!nb || nb.kind !== 'ok' || alchemy.hexToDec(nb.result) === null) return { stop: nb && nb.kind === 'ok' ? { outcome: 'failed', error: 'eth_getBalance: not a quantity' } : failureOf(nb) };
  const tokens = [];
  let pageKey = null;
  let pages = 0;
  do {
    const r = await rpc('alchemy_getTokenBalances', [me, 'erc20', pageKey ? { pageKey, maxCount: 100 } : { maxCount: 100 }]);
    if (!r || r.kind !== 'ok') return { stop: failureOf(r) };
    const list = r.result && Array.isArray(r.result.tokenBalances) ? r.result.tokenBalances : null;
    if (!list) return { stop: { outcome: 'failed', error: 'alchemy_getTokenBalances: the answer had no balances' } };
    for (const row of list) tokens.push(alchemy.normalizeTokenBalance(row));
    pageKey = r.result.pageKey ? String(r.result.pageKey) : null;
    pages++;
  } while (pageKey && pages < cfg.max_balance_pages);
  if (pageKey) return { stop: { outcome: 'partial', error: `more than ${cfg.max_balance_pages} pages of token balances; no snapshot was saved` } };
  const held = tokens.filter((x) => !x.error && x.balance_raw !== '0').map((x) => x.contract);
  const meta = await fetchMetadata(ws, w, network, wallets.contractsNeedingMetadata(ws, w, network, held, { now: clock() }).filter((c) => held.includes(c)), { rpc, cfg, clock, ctx });
  if (meta.stop && meta.stop.outcome !== 'partial') return { stop: meta.stop };
  wallets.storeBalances(ws, w, network, { native_raw: alchemy.hexToDec(nb.result), tokens, block: String(head) }, { now: clock() });
  return { stop: null };
}

// Reads what is due (all of it, or the wallets named, when forced: a manual
// run skips a network's failure backoff, never Alchemy's rate limit, a key
// refusal or a used-up plan). Returns { status: ok | partial | failed |
// backoff | busy | noop | budget_paused | skipped | not_configured | held,
// message, ... }.
async function refresh(ws, opts = {}) {
  const { trigger = 'manual', fetchImpl = fetch, force = false, walletIds = null, retryDelayMs = 1200, pauseMs = 120 } = opts;
  const clock = () => (opts.now !== undefined ? opts.now : Date.now());
  const cfg = wallets.cfgOf(ws);
  if (!cfg.enabled) return { status: 'skipped', message: 'Wallet sync is turned off in settings.' };
  if (restored(ws)) return { status: 'held', message: 'Restored copy: wallet sync asks Alchemy for nothing until the copy is released (node dashboard/cli.js restored-copy release --confirm).' };
  if (!wallets.listWallets(ws).some((w) => w.status === 'active')) return { status: 'noop', message: 'No wallet is being tracked.' };
  const key = alchemy.apiKey();
  if (!key) return { status: 'not_configured', message: configured(ws).why };
  const now0 = clock();
  const s0 = readState(ws);
  const g = gateOf(s0, now0);
  if (!g.open) return { status: 'backoff', rate_limited: g.rate_limited, retry_at: g.until, message: `Wallets not synced: ${g.why}; next try after ${g.until}.` };
  const list = targets(ws, now0, { state: s0, walletIds, force }).filter((x) => x.due);
  if (!list.length) return { status: 'noop', message: 'No wallet sync is due.' };
  const timeoutMs = Math.max(1, cfg.timeout_seconds) * 1000;
  const ttl = Math.max(30 * 60000, (cfg.max_pages_per_run + cfg.max_receipts_per_run + cfg.max_metadata_per_run) * (timeoutMs / 4) + 60000);
  const lease = acquireLease(ws, LEASE, ttl, { label: trigger });
  if (!lease) return { status: 'busy', message: 'Another wallet sync is running; its result will be used.' };
  try {
    return await refreshLeased(ws, list, { trigger, fetchImpl, cfg, clock, key, timeoutMs, retryDelayMs, pauseMs });
  } finally {
    releaseLease(ws, LEASE, lease);
  }
}

async function refreshLeased(ws, list, { trigger, fetchImpl, cfg, clock, key, timeoutMs, retryDelayMs, pauseMs }) {
  const counts = { sent: 0, answered: 0 };
  const ctx = { cfg, clock, fetchImpl, key, counts, own: wallets.ownAddressMap(wallets.loadRegistry(ws)), timeoutMs, retryDelayMs, pauseMs, pages: 0, receipts: 0, metadata: 0, sentAny: false };
  const results = [];
  let halt = null;
  for (const t of list) {
    if (halt) {
      results.push({ t, outcome: 'not_attempted', error: halt.error });
      continue;
    }
    let r;
    try {
      r = await syncOne(ws, t, ctx);
    } catch (err) {
      r = { outcome: 'failed', error: alchemy.scrub(`the sync could not save what it read: ${err.message}`, key) };
    }
    results.push({ t, ...r });
    const now = clock();
    const fails = r.outcome === 'failed' ? (t.st.consecutive_failures || 0) + 1 : r.outcome === 'ok' ? 0 : t.st.consecutive_failures || 0;
    // A Sync now pressed while this read ran stays asked for.
    const served = t.st.requested_at || null;
    const current = (readState(ws).networks[t.key] || {}).requested_at || null;
    updateNetwork(ws, t.key, {
      requested_at: current && current !== served ? current : null,
      last_attempt: { at: isoOf(now), trigger, outcome: r.outcome, error: r.error || null },
      consecutive_failures: fails,
      next_attempt_at: r.outcome === 'failed' ? isoOf(now + backoffMs(cfg, fails)) : null,
      ...(r.outcome === 'ok' ? { last_success_at: isoOf(now) } : {}),
      ...(r.outcome === 'failed' ? { last_failure_at: isoOf(now), last_error: r.error } : r.outcome === 'ok' ? { last_error: null } : {}),
    });
    if (['rate_limited', 'key_refused', 'budget', 'quota'].includes(r.outcome)) halt = r;
  }
  // Ledger: final events of every active wallet (also those read earlier).
  let imported = null;
  try {
    imported = wallets.importReady(ws, { now: clock() });
  } catch (err) {
    imported = { status: 'failed', error: err.message, recorded: 0, held: 0, voided: 0 };
  }
  // Reconciliation: when each difference was first seen (it stays visible).
  try {
    const market = require('./market');
    const pf = require('./portfolio').computePortfolio(ws, { market: market.readLatest(ws), now: clock() });
    const rows = wallets.reconcileAll(ws, { pf });
    updateState(ws, (s) => {
      const next = {};
      for (const row of rows) {
        if (row.status === 'matches') continue;
        const k = `${row.wallet_id}|${row.asset_id}`;
        const prev = s.reconciliation[k];
        next[k] = { status: row.status, difference: row.difference, since: prev && prev.status === row.status ? prev.since : isoOf(clock()) };
      }
      return { ...s, reconciliation: next };
    });
  } catch (_) { /* the page computes it again on every read */ }

  const now = clock();
  const ok = results.filter((x) => x.outcome === 'ok');
  const label = (x) => `${x.t.wallet.label} on ${wallets.NETWORKS[x.t.network].label}`;
  const problems = results.filter((x) => x.outcome !== 'ok');
  const status = halt && halt.outcome === 'budget' && !ok.length ? 'budget_paused' : problems.length ? (ok.length ? 'partial' : 'failed') : 'ok';
  const fresh = results.reduce((a, x) => a + (x.fresh || 0), 0);
  const message = [
    `Wallet sync: ${ok.length} of ${results.length} network(s) read completely; ${fresh} new or changed transfer(s).`,
    imported && imported.status !== 'failed' ? `${imported.recorded || 0} recorded in the ledger, ${imported.held || 0} held${imported.voided ? `, ${imported.voided} voided on chain evidence` : ''}.` : imported ? `Ledger import failed: ${imported.error}.` : '',
    problems.length ? `Not complete: ${problems.map((x) => `${label(x)} (${x.error || x.outcome})`).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  updateState(ws, (s) => {
    let next = { ...s, last_run: { at: isoOf(now), trigger, status, requests: counts.sent, answered: counts.answered, summary: message.slice(0, 600) } };
    next.calls = { ...callCounts(next, now) };
    next.calls.day_answered = (next.calls.day_answered || 0) + counts.answered;
    next.calls.month_answered = (next.calls.month_answered || 0) + counts.answered;
    if (halt && halt.outcome === 'rate_limited') next = { ...next, ...rateLimitFields(s, halt.retry_after_ms, now) };
    if (halt && halt.outcome === 'key_refused') next = { ...next, key_refused_until: isoOf(now + KEY_REFUSED_MS), key_refused_error: halt.error };
    if (halt && halt.outcome === 'quota') next = { ...next, quota_until: isoOf(now + QUOTA_MS), quota_error: halt.error };
    if (ok.length && !(halt && halt.outcome === 'key_refused')) next = { ...next, key_refused_until: null, key_refused_error: null };
    if (ok.length) next.last_success_at = isoOf(now);
    return next;
  });
  return { status, message, networks: results.map((x) => ({ wallet_id: x.t.wallet.wallet_id, network: x.t.network, outcome: x.outcome, error: x.error || null, fresh: x.fresh || 0, balances: x.balances || null })), ledger: imported, requests: counts.sent };
}

// ---------------------------------------------------------------------------
// Status for the page, doctor and the start log

function statusOf(ws, { now = Date.now(), state = null } = {}) {
  const cfg = wallets.cfgOf(ws);
  const s = state || readState(ws);
  const key = alchemy.keyStatus();
  const conf = configured(ws);
  const g = gateOf(s, now);
  const held = restored(ws);
  const c = callCounts(s, now);
  const networks = {};
  for (const w of wallets.listWallets(ws)) {
    for (const network of w.networks) {
      const k = netKey(w.wallet_id, network);
      const info = wallets.networkInfo(network);
      const st = s.networks[k] || {};
      const lastOk = st.last_success_at ? Date.parse(st.last_success_at) : null;
      const lastTry = st.last_attempt || null;
      let stateWord;
      let words;
      if (w.status === 'removed') [stateWord, words] = ['removed', 'Not tracked'];
      else if (!info || !info.supported) [stateWord, words] = ['unsupported', 'Not read: Alchemy\'s transfer history does not cover this network'];
      else if (w.status === 'paused') [stateWord, words] = ['paused', 'Paused'];
      else if (held) [stateWord, words] = ['held', 'Held in this restored copy'];
      else if (!cfg.enabled) [stateWord, words] = ['off', 'Wallet sync is off'];
      else if (!key.present) [stateWord, words] = ['unavailable', 'Waiting for the Alchemy key'];
      else if (!st.history_complete_to) {
        if (lastTry && ['failed', 'key_refused', 'rate_limited', 'budget', 'quota'].includes(lastTry.outcome)) [stateWord, words] = ['unavailable', `Not synced yet: the last try did not finish${st.pass ? ` (history read to block ${st.pass.resume_block} of ${st.pass.to_block} so far)` : ''}`];
        else if (st.pass || lastOk || (lastTry && lastTry.outcome === 'partial')) [stateWord, words] = ['history_incomplete', `History still loading${st.pass ? ` (block ${st.pass.resume_block} of ${st.pass.to_block})` : ''}`];
        else [stateWord, words] = ['never', 'Not synced yet'];
      } else if (lastTry && ['failed', 'key_refused', 'rate_limited', 'budget', 'quota'].includes(lastTry.outcome) && (!lastOk || Date.parse(lastTry.at) > lastOk)) [stateWord, words] = ['failing', 'Last sync did not finish; showing the last complete view'];
      else if (lastOk && now - lastOk > cfg.stale_after_minutes * 60000) [stateWord, words] = ['stale', 'Stale'];
      else if (st.pass) [stateWord, words] = ['resuming', 'Reading new activity'];
      else [stateWord, words] = ['ok', 'Synced'];
      // The chain counts more transactions sent by this wallet than the
      // history has: never said to be complete.
      const gap = info && info.supported ? wallets.sentGapOf(st) : 0;
      if (gap && stateWord === 'ok') [stateWord, words] = ['gap', `Synced; history incomplete (${gap} sent transaction(s) not in Alchemy's history)`];
      networks[k] = {
        state: stateWord,
        words,
        history_gap: gap,
        last_success_at: st.last_success_at || null,
        last_attempt: lastTry,
        last_error: st.last_error || (lastTry && lastTry.outcome !== 'ok' ? lastTry.error : null),
        next_attempt_at: st.next_attempt_at || null,
        requested_at: st.requested_at || null,
        pass: st.pass ? { from_block: st.pass.from_block, to_block: st.pass.to_block, resume_block: st.pass.resume_block, phase: st.pass.phase, pages: st.pass.pages, backfill: st.pass.backfill } : null,
        last_pass: st.last_pass || null,
        history_complete_to: st.history_complete_to || null,
        history_complete_at: st.history_complete_at || null,
        backfill_complete_at: st.backfill_complete_at || null,
        head_block: st.head_block || null,
        finalized_block: st.finalized_block || null,
        finalized_basis: st.finalized_basis || null,
        sent_count_chain: st.sent_count_chain || null,
        sent_count_seen: st.sent_count_seen || null,
        balances_complete_at: st.balances_complete_at || null,
        balances_last_error: st.balances_last_error || null,
      };
    }
  }
  return {
    summary: {
      configured: conf.ok,
      why: conf.ok ? null : conf.why,
      enabled: cfg.enabled,
      provider: 'Alchemy',
      key_present: key.present,
      key_source: key.present ? key.source : null,
      held_restored_copy: Boolean(held),
      running: leaseInfo(ws, LEASE).held,
      gate: g.open ? null : { rate_limited: g.rate_limited, until: g.until, why: g.why },
      calls: { day: c.day, day_count: c.day_count, day_cu: c.day_cu, month: c.month, month_count: c.month_count, month_cu: c.month_cu, methods: c.methods || {} },
      daily_cu_cap: cfg.daily_cu_cap,
      monthly_cu_cap: cfg.monthly_cu_cap,
      interval_minutes: cfg.interval_minutes,
      interval_words: wallets.intervalWords(cfg.interval_minutes),
      last_run: s.last_run || null,
      last_success_at: s.last_success_at || null,
    },
    networks,
  };
}

// Estimated compute units at the current settings, for one network with no
// new activity: the head and finalized blocks (30), three history queries
// (360), the sent-transaction count (20), and balances (eth_getBalance and
// one page of token balances, 40) = 450 a sync. New activity adds 20 per
// transaction (its receipt) and 10 per new token (its details, once).
const PER_SYNC = alchemy.CU.eth_blockNumber + alchemy.CU.eth_getBlockByNumber + 3 * alchemy.CU.alchemy_getAssetTransfers + alchemy.CU.eth_getTransactionCount;
const PER_BALANCES = alchemy.CU.eth_getBalance + alchemy.CU.alchemy_getTokenBalances;

function estimateUsage(ws) {
  const cfg = wallets.cfgOf(ws);
  const nets = wallets.listWallets(ws).filter((w) => w.status === 'active').reduce((a, w) => a + w.networks.filter((n) => wallets.networkInfo(n) && wallets.networkInfo(n).supported).length, 0);
  const syncs = 1440 / cfg.interval_minutes;
  const balances = 1440 / Math.max(cfg.interval_minutes, cfg.balance_refresh_minutes);
  const perNetDay = Math.round(syncs * PER_SYNC + balances * PER_BALANCES);
  return {
    basis: 'Alchemy\'s published method costs; Alchemy\'s dashboard is the record of actual use',
    per_sync: PER_SYNC + PER_BALANCES,
    syncs_per_day: syncs,
    per_network_day: perNetDay,
    per_network_month: perNetDay * 30,
    networks: nets,
    total_day: perNetDay * nets,
    total_month: perNetDay * nets * 30,
    per_new_transaction: alchemy.CU.eth_getTransactionReceipt,
    per_new_token: alchemy.CU.alchemy_getTokenMetadata,
    free_plan_month: 30000000,
  };
}

module.exports = { STATE_REL, LEASE, readState, updateState, isDue, targets, configured, requestSync, refresh, statusOf, estimateUsage, gateOf, callCounts };
