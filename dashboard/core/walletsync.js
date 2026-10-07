'use strict';
// The wallet sync: reads each tracked wallet's networks from Moralis on the
// desk's own schedule (jobs.js "wallets"; on the online desk a one-minute
// check in server.js, on the PC also the hourly task), so the Portfolio stays
// current with the PC and the browser closed. Read-only (moralis.js).
//
// Per wallet and network, each run:
//   1. History: one window, from the last complete read minus recheck_minutes
//      (the whole history the first time) to the moment the window opened,
//      every page to the end. The cursor is saved after each page, so a
//      restart or a page cap continues where it stopped. Only a window read to
//      its last page is complete: then events it no longer contains are
//      reversed and events old enough are final (wallets.finishPass).
//   2. Balances, when new activity appeared, when asked (Sync now) or every
//      balance_refresh_minutes: every page, or no snapshot at all.
//   3. Then, for every wallet, final events are recorded in the ledger or held
//      with their reason (wallets.importReady), and reconciliation differences
//      get the time they were first seen.
//
// Shared by every runner: one lease (no two syncs at once), Moralis's rate
// limit (a Retry-After is honored; otherwise a doubling wait), a failure
// backoff per network, a key refusal that pauses everything, and a daily
// compute-unit budget reserved on disk before each request is sent. "Sync
// now" marks the wallet's networks as asked for; the same queue runs them.
// A restored copy (config/restored-copy.json) asks Moralis for nothing until
// it is released, like research.
//
// Status (portfolio/wallets/sync-state.json) holds counts, times, cursors and
// errors: never an address, a key or a token name. Logs name wallets by label.

const { readJson, jsonText } = require('./fsx');
const { withLock, replaceFile } = require('./ops');
const { acquireLease, releaseLease, leaseInfo } = require('./leases');
const { ymdInTz } = require('./dates');
const { randomId, compactTs } = require('./ids');
const moralis = require('./moralis');
const wallets = require('./wallets');

const STATE_REL = `${wallets.DIR}/sync-state.json`;
const LEASE = 'wallet-sync';
const RATE_LIMIT_DEFAULT_MS = 2 * 60000;
const RATE_LIMIT_MIN_MS = 30000;
const RETRY_AFTER_CEILING_MS = 24 * 3600000;
const KEY_REFUSED_MS = 60 * 60000;

const isoOf = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const netKey = (walletId, network) => `${walletId}:${network}`;

function emptyState() {
  return { schema_version: 'cr.wallet-sync-state.v1', provider: 'moralis', networks: {}, reconciliation: {} };
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
    replaceFile(ws, ws.abs(STATE_REL), jsonText({ ...next, schema_version: 'cr.wallet-sync-state.v1', provider: 'moralis' }));
    return next;
  });
}

function updateNetwork(ws, key, patch) {
  return updateState(ws, (s) => ({ ...s, networks: { ...s.networks, [key]: { ...(s.networks[key] || {}), ...patch } } }));
}

// ---------------------------------------------------------------------------
// Compute units, gate, backoff

function callCounts(state, now) {
  const today = ymdInTz(new Date(now));
  const month = today.slice(0, 7);
  const c = state.calls && state.calls.month === month ? { ...state.calls } : { month, month_count: 0, month_cu: 0, month_answered: 0, day: today, day_count: 0, day_cu: 0, day_answered: 0 };
  if (c.day !== today) Object.assign(c, { day: today, day_count: 0, day_cu: 0, day_answered: 0 });
  return c;
}

// Reserves one request's compute units before it is sent, on disk, so no
// runner goes past the day's budget and a stop mid-request still counts it.
function reserveCu(ws, cfg, cu, now) {
  return withLock(ws, 'wallet_sync_state', () => {
    const cur = readState(ws);
    const c = callCounts(cur, now);
    if (cfg.daily_cu_budget && (c.day_cu || 0) + cu > cfg.daily_cu_budget) return false;
    const next = { ...c, day_count: c.day_count + 1, month_count: c.month_count + 1, day_cu: (c.day_cu || 0) + cu, month_cu: (c.month_cu || 0) + cu };
    replaceFile(ws, ws.abs(STATE_REL), jsonText({ ...cur, calls: next, schema_version: 'cr.wallet-sync-state.v1', provider: 'moralis' }));
    return true;
  });
}

function backoffMs(cfg, failures) {
  const base = cfg.backoff_initial_minutes * 60000;
  return Math.min(cfg.backoff_max_minutes * 60000, base * 2 ** Math.max(0, failures - 1));
}

// Closed while Moralis asked the desk to wait, or after it refused the key.
function gateOf(state, now) {
  const until = state.retry_after_until ? Date.parse(state.retry_after_until) : 0;
  if (until > now) return { open: false, rate_limited: true, until: state.retry_after_until, why: 'Moralis asked the desk to wait (rate limit)' };
  const paused = state.key_refused_until ? Date.parse(state.key_refused_until) : 0;
  if (paused > now) return { open: false, rate_limited: false, until: state.key_refused_until, why: state.key_refused_error || 'Moralis refused the key' };
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

// The wallet networks a run would read now, each with why.
function targets(ws, now, { state = null, walletIds = null, force = false } = {}) {
  const cfg = wallets.cfgOf(ws);
  const s = state || readState(ws);
  const out = [];
  for (const w of wallets.listWallets(ws)) {
    if (w.status !== 'active') continue;
    if (Array.isArray(walletIds) && !walletIds.includes(w.wallet_id)) continue;
    for (const network of w.networks) {
      if (!wallets.networkInfo(network)) continue;
      const st = s.networks[netKey(w.wallet_id, network)] || {};
      const lastAt = st.last_attempt ? Date.parse(st.last_attempt.at) : 0;
      // Cleared by the run that serves it, so any value still here is asked for.
      const requested = Boolean(st.requested_at);
      const spaced = now - lastAt >= cfg.sync_now_min_seconds * 1000;
      const backoff = st.next_attempt_at && Date.parse(st.next_attempt_at) > now;
      const byInterval = !st.last_attempt || now - lastAt >= cfg.interval_minutes * 60000 - 15000;
      // A long read stopped at the page cap continues at the next check.
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
  if (!moralis.apiKey()) return { ok: false, why: 'No Moralis key: set MORALIS_API_KEY in Render > Environment (or "moralis_api_key" in ~/.cryptoresearch/secrets.json on the PC).', key: false };
  return { ok: true };
}

function isDue(ws, now = Date.now()) {
  if (!configured(ws).ok || restored(ws)) return false;
  const s = readState(ws);
  if (!gateOf(s, now).open) return false;
  return targets(ws, now, { state: s }).some((t) => t.due);
}

// "Sync now": the wallet's networks are asked for; the next run (within a
// minute on the desk) reads them, in the same queue and under the same limits.
function requestSync(ws, walletId, { now = Date.now() } = {}) {
  const w = wallets.walletById(ws, walletId);
  if (w.status !== 'active') return { status: 'refused', message: w.status === 'paused' ? 'Syncing is paused for this wallet. Resume it first.' : 'This wallet is no longer tracked.' };
  const c = configured(ws);
  if (!c.ok) return { status: 'not_configured', message: c.why };
  if (restored(ws)) return { status: 'held', message: 'This is a restored copy: wallet sync asks Moralis for nothing until it is released (node dashboard/cli.js restored-copy release --confirm).' };
  updateState(ws, (s) => {
    const networks = { ...s.networks };
    for (const n of w.networks) networks[netKey(w.wallet_id, n)] = { ...(networks[netKey(w.wallet_id, n)] || {}), requested_at: isoOf(now) };
    return { ...s, networks };
  });
  const g = gateOf(readState(ws), now);
  return { status: 'queued', message: g.open ? 'Sync asked for. It runs within a minute, in turn with any sync already running.' : `Sync asked for. ${g.why}; it runs after ${g.until}.`, wallet_id: w.wallet_id };
}

// ---------------------------------------------------------------------------
// The run

function failureOf(r) {
  if (!r) return { outcome: 'failed', error: 'no answer' };
  if (r.kind === 'rate_limited') return { outcome: 'rate_limited', error: 'Moralis rate-limited the request', retry_after_ms: r.retry_after_ms };
  if (r.kind === 'budget') return { outcome: 'budget', error: 'the daily compute-unit budget is used up' };
  if (r.kind === 'key_refused') return { outcome: 'key_refused', error: r.error };
  return { outcome: 'failed', error: `${r.error || 'the request failed'}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ''}` };
}

// One wallet network: history window, then balances when due. Returns
// { outcome: ok | partial | failed | rate_limited | budget | key_refused, ... }.
async function syncOne(ws, t, ctx) {
  const { cfg, clock, fetchImpl, key, counts, own, timeoutMs, retryDelayMs, pauseMs } = ctx;
  const w = t.wallet;
  const info = wallets.NETWORKS[t.network];
  const get = async (url, endpoint) => {
    if (ctx.sentAny && pauseMs) await sleep(pauseMs);
    ctx.sentAny = true;
    return moralis.getPage(url, { endpoint, fetchImpl, key, timeoutMs, maxAttempts: Math.max(1, cfg.max_attempts), retryDelayMs, reserve: (cu) => reserveCu(ws, cfg, cu, clock()), counts });
  };
  let pass = t.st.pass || null;
  if (!pass) {
    const now0 = clock();
    const from = t.st.last_complete_pass_at ? isoOf(Date.parse(t.st.last_complete_pass_at) - cfg.recheck_minutes * 60000) : null;
    pass = { id: `p_${compactTs(new Date(now0))}_${randomId(4)}`, from, to: isoOf(now0), cursor: null, pages: 0, items: 0, malformed: 0, started_at: isoOf(now0) };
    updateNetwork(ws, t.key, { pass });
  }
  let complete = false;
  let stop = null;
  let fresh = 0;
  for (;;) {
    if (ctx.pages >= cfg.max_pages_per_run) {
      stop = { outcome: 'partial', error: `stopped after ${ctx.pages} pages in this run; the read continues next run from where it stopped` };
      break;
    }
    const r = await get(moralis.historyUrl(w.address, info.moralis, { cursor: pass.cursor, fromDate: pass.from, toDate: pass.to }), 'history');
    if (!r || r.kind !== 'ok') {
      if (r && r.kind === 'refused' && pass.cursor) {
        // A saved cursor Moralis no longer accepts: the window is read again.
        updateNetwork(ws, t.key, { pass: null });
        stop = { outcome: 'failed', error: `Moralis refused the saved page cursor (HTTP ${r.http_status}); the window is read again from its start next run` };
      } else stop = failureOf(r);
      break;
    }
    ctx.pages++;
    const items = r.body.result.map((item) => ({ item, tx: moralis.normalizeHistoryItem(item) }));
    const c = wallets.storeHistoryPage(ws, w, t.network, items, { passId: pass.id, now: clock(), own });
    fresh += c.new + c.changed;
    pass = { ...pass, cursor: r.cursor, pages: pass.pages + 1, items: pass.items + items.length, malformed: pass.malformed + c.malformed };
    if (!r.cursor) {
      complete = true;
      break;
    }
    updateNetwork(ws, t.key, { pass });
  }
  let confirmed = null;
  if (complete) {
    confirmed = wallets.finishPass(ws, w, t.network, { pass, now: clock(), confirmMinutes: cfg.confirm_minutes && Number.isFinite(cfg.confirm_minutes[t.network]) ? cfg.confirm_minutes[t.network] : null });
    updateNetwork(ws, t.key, { pass: null, last_complete_pass_at: pass.to, history_complete_at: isoOf(clock()), last_pass: { id: pass.id, from: pass.from, to: pass.to, pages: pass.pages, items: pass.items, malformed: pass.malformed, final: confirmed.final, reverted: confirmed.reverted } });
  }
  // Balances only after a history read that was not stopped by Moralis.
  let balances = 'not_due';
  if (!stop || stop.outcome === 'partial') {
    const lastBal = t.st.balances_checked_at ? Date.parse(t.st.balances_checked_at) : 0;
    const due = t.requested || fresh > 0 || (confirmed && confirmed.reverted) || !t.st.balances_complete_at || clock() - lastBal >= cfg.balance_refresh_minutes * 60000;
    if (due) {
      const rows = [];
      let cursor = null;
      let pages = 0;
      let block = null;
      let bstop = null;
      do {
        const r = await get(moralis.tokensUrl(w.address, info.moralis, { cursor }), 'tokens');
        if (!r || r.kind !== 'ok') {
          bstop = failureOf(r);
          break;
        }
        pages++;
        for (const row of r.body.result) rows.push(moralis.normalizeTokenBalance(row));
        if (block === null && r.body.block_number !== undefined && /^\d{1,20}$/.test(String(r.body.block_number))) block = String(r.body.block_number);
        cursor = r.cursor;
      } while (cursor && pages < cfg.max_balance_pages);
      if (!bstop && cursor) bstop = { outcome: 'partial', error: `more than ${cfg.max_balance_pages} pages of balances; no snapshot was saved` };
      if (bstop) {
        balances = 'failed';
        if (!stop || bstop.outcome !== 'partial') stop = bstop;
        updateNetwork(ws, t.key, { balances_last_error: bstop.error, balances_checked_at: isoOf(clock()) });
      } else {
        wallets.storeBalances(ws, w, t.network, rows, { now: clock(), block });
        balances = 'saved';
        updateNetwork(ws, t.key, { balances_checked_at: isoOf(clock()), balances_complete_at: isoOf(clock()), balances_last_error: null, balances_unreadable: rows.filter((x) => x.error).length });
      }
    }
  }
  const outcome = stop ? stop.outcome : complete ? 'ok' : 'partial';
  return { outcome, error: stop ? stop.error : null, retry_after_ms: stop ? stop.retry_after_ms : null, complete, fresh, balances, confirmed };
}

// Reads what is due (all of it, or the wallets named, when forced: a manual
// run skips a network's failure backoff, never Moralis's rate limit or a key
// refusal). Returns { status: ok | partial | failed | backoff | busy | noop |
// budget_paused | skipped | not_configured | held, message, ... }.
async function refresh(ws, opts = {}) {
  const { trigger = 'manual', fetchImpl = fetch, force = false, walletIds = null, retryDelayMs = 1500, pauseMs = 250 } = opts;
  const clock = () => (opts.now !== undefined ? opts.now : Date.now());
  const cfg = wallets.cfgOf(ws);
  if (!cfg.enabled) return { status: 'skipped', message: 'Wallet sync is turned off in settings.' };
  if (restored(ws)) return { status: 'held', message: 'Restored copy: wallet sync asks Moralis for nothing until the copy is released (node dashboard/cli.js restored-copy release --confirm).' };
  if (!wallets.listWallets(ws).some((w) => w.status === 'active')) return { status: 'noop', message: 'No wallet is being tracked.' };
  const key = moralis.apiKey();
  if (!key) return { status: 'not_configured', message: configured(ws).why };
  const now0 = clock();
  const s0 = readState(ws);
  const g = gateOf(s0, now0);
  if (!g.open) return { status: 'backoff', rate_limited: g.rate_limited, retry_at: g.until, message: `Wallets not synced: ${g.why}; next try after ${g.until}.` };
  const list = targets(ws, now0, { state: s0, walletIds, force }).filter((t) => t.due);
  if (!list.length) return { status: 'noop', message: 'No wallet sync is due.' };
  const timeoutMs = Math.max(1, cfg.timeout_seconds) * 1000;
  const ttl = Math.max(20 * 60000, cfg.max_pages_per_run * (timeoutMs * cfg.max_attempts + retryDelayMs + pauseMs) + list.length * cfg.max_balance_pages * timeoutMs + 60000);
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
  const ctx = { cfg, clock, fetchImpl, key, counts, own: wallets.ownAddressMap(wallets.loadRegistry(ws)), timeoutMs, retryDelayMs, pauseMs, pages: 0, sentAny: false };
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
      r = { outcome: 'failed', error: `the sync could not save what it read: ${err.message}` };
    }
    results.push({ t, ...r });
    const now = clock();
    const fails = ['failed'].includes(r.outcome) ? (t.st.consecutive_failures || 0) + 1 : r.outcome === 'ok' ? 0 : t.st.consecutive_failures || 0;
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
    if (['rate_limited', 'key_refused', 'budget'].includes(r.outcome)) halt = r;
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
    const rows = wallets.reconcileAll(ws, { pf, now: clock() });
    updateState(ws, (s) => {
      const next = {};
      for (const r of rows) {
        if (r.status === 'matches') continue;
        const k = `${r.wallet_id}|${r.asset_id}`;
        const prev = s.reconciliation[k];
        next[k] = { status: r.status, difference: r.difference, since: prev && prev.status === r.status ? prev.since : isoOf(clock()) };
      }
      return { ...s, reconciliation: next };
    });
  } catch (_) { /* the page computes it again on every read */ }

  const now = clock();
  const ok = results.filter((r) => r.outcome === 'ok');
  const label = (r) => `${r.t.wallet.label} on ${wallets.NETWORKS[r.t.network].label}`;
  const problems = results.filter((r) => r.outcome !== 'ok');
  const status = halt && halt.outcome === 'budget' && !ok.length ? 'budget_paused' : problems.length ? (ok.length ? 'partial' : 'failed') : 'ok';
  const fresh = results.reduce((a, r) => a + (r.fresh || 0), 0);
  const message = [
    `Wallet sync: ${ok.length} of ${results.length} network(s) read completely; ${fresh} new or changed event(s).`,
    imported && imported.status !== 'failed' ? `${imported.recorded || 0} recorded in the ledger, ${imported.held || 0} held${imported.voided ? `, ${imported.voided} voided after a reversal` : ''}.` : imported ? `Ledger import failed: ${imported.error}.` : '',
    problems.length ? `Not complete: ${problems.map((r) => `${label(r)} (${r.error || r.outcome})`).join('; ')}.` : '',
  ].filter(Boolean).join(' ');
  updateState(ws, (s) => {
    let next = { ...s, last_run: { at: isoOf(now), trigger, status, requests: counts.sent, answered: counts.answered, summary: message.slice(0, 600) } };
    next.calls = { ...callCounts(next, now) };
    next.calls.day_answered = (next.calls.day_answered || 0) + counts.answered;
    next.calls.month_answered = (next.calls.month_answered || 0) + counts.answered;
    if (halt && halt.outcome === 'rate_limited') next = { ...next, ...rateLimitFields(s, halt.retry_after_ms, now) };
    if (halt && halt.outcome === 'key_refused') next = { ...next, key_refused_until: isoOf(now + KEY_REFUSED_MS), key_refused_error: halt.error };
    if (ok.length && !(halt && halt.outcome === 'key_refused')) next = { ...next, key_refused_until: null, key_refused_error: null };
    if (ok.length) next.last_success_at = isoOf(now);
    return next;
  });
  return { status, message, networks: results.map((r) => ({ wallet_id: r.t.wallet.wallet_id, network: r.t.network, outcome: r.outcome, error: r.error || null, fresh: r.fresh || 0, balances: r.balances || null })), ledger: imported, requests: counts.sent };
}

// ---------------------------------------------------------------------------
// Status for the page, doctor and the start log

function statusOf(ws, { now = Date.now(), state = null } = {}) {
  const cfg = wallets.cfgOf(ws);
  const s = state || readState(ws);
  const key = moralis.keyStatus();
  const conf = configured(ws);
  const g = gateOf(s, now);
  const held = restored(ws);
  const c = callCounts(s, now);
  const networks = {};
  for (const w of wallets.listWallets(ws)) {
    for (const network of w.networks) {
      const k = netKey(w.wallet_id, network);
      const st = s.networks[k] || {};
      const lastOk = st.last_success_at ? Date.parse(st.last_success_at) : null;
      const lastTry = st.last_attempt || null;
      let stateWord;
      let words;
      if (w.status === 'removed') [stateWord, words] = ['removed', 'Not tracked'];
      else if (w.status === 'paused') [stateWord, words] = ['paused', 'Paused'];
      else if (held) [stateWord, words] = ['held', 'Held in this restored copy'];
      else if (!cfg.enabled) [stateWord, words] = ['off', 'Wallet sync is off'];
      else if (!key.present) [stateWord, words] = ['unavailable', 'Waiting for the Moralis key'];
      else if (!lastOk) {
        if (st.pass) [stateWord, words] = ['first_read', `First read in progress (${st.pass.pages || 0} page(s) so far)`];
        else if (lastTry && lastTry.outcome !== 'ok') [stateWord, words] = ['unavailable', 'Not synced yet: the last try did not finish'];
        else [stateWord, words] = ['never', 'Not synced yet'];
      } else if (lastTry && ['failed', 'key_refused', 'rate_limited', 'budget'].includes(lastTry.outcome) && Date.parse(lastTry.at) > lastOk) [stateWord, words] = ['failing', 'Last sync did not finish; showing the last complete view'];
      else if (now - lastOk > cfg.stale_after_minutes * 60000) [stateWord, words] = ['stale', 'Stale'];
      else if (st.pass) [stateWord, words] = ['resuming', 'Reading new activity'];
      else [stateWord, words] = ['ok', 'Synced'];
      networks[k] = {
        state: stateWord,
        words,
        last_success_at: st.last_success_at || null,
        last_attempt: lastTry,
        last_error: st.last_error || (lastTry && lastTry.outcome !== 'ok' ? lastTry.error : null),
        next_attempt_at: st.next_attempt_at || null,
        requested_at: st.requested_at || null,
        pass: st.pass ? { from: st.pass.from, to: st.pass.to, pages: st.pass.pages } : null,
        last_pass: st.last_pass || null,
        history_complete_at: st.history_complete_at || null,
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
      key_present: key.present,
      key_source: key.present ? key.source : null,
      held_restored_copy: Boolean(held),
      running: leaseInfo(ws, LEASE).held,
      gate: g.open ? null : { rate_limited: g.rate_limited, until: g.until, why: g.why },
      calls: { day: c.day, day_count: c.day_count, day_cu: c.day_cu, month: c.month, month_count: c.month_count, month_cu: c.month_cu },
      daily_cu_budget: cfg.daily_cu_budget,
      interval_minutes: cfg.interval_minutes,
      last_run: s.last_run || null,
      last_success_at: s.last_success_at || null,
    },
    networks,
  };
}

// Estimated compute units a day at the current settings (history every
// interval, balances every balance_refresh_minutes), for the settings line.
function estimateDailyCu(ws) {
  const cfg = wallets.cfgOf(ws);
  const nets = wallets.listWallets(ws).filter((w) => w.status === 'active').reduce((a, w) => a + w.networks.length, 0);
  const perNet = Math.ceil(1440 / cfg.interval_minutes) * moralis.CU.history + Math.ceil(1440 / Math.max(cfg.interval_minutes, cfg.balance_refresh_minutes)) * moralis.CU.tokens;
  return { networks: nets, per_network: perNet, total: perNet * nets };
}

module.exports = { STATE_REL, LEASE, readState, updateState, isDue, targets, configured, requestSync, refresh, statusOf, estimateDailyCu, gateOf, callCounts };
