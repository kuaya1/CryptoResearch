'use strict';
// Portfolio records and calculations. Separate from the research watchlist:
// adding or researching a project never creates a holding.
//
// Accounting: FIFO lots per account (wallet by wallet), with exact decimals.
// - Lots keep their ORIGINAL acquisition date, including after transfers, and
//   are always consumed oldest first (audit F02).
// - A transfer between your own accounts is one transfer_out and one
//   transfer_in sharing a transfer_id. Each ID may be used by one leg in each
//   direction; reuse is rejected on input, and legacy duplicates are kept in
//   transit or quarantine instead of overwriting each other (F03).
// - Units lost to in-kind network fees reduce what arrives; their cost stays in
//   the basis of the remaining units. An arrival as a DIFFERENT asset (a bridge
//   or wrapper) is quarantined until you record the conversion; it is never
//   counted twice (F21).
// - Unknown purchase prices mean unknown cost basis. Nothing is estimated.
// - Missing, invalid or stale prices mean unknown or stale value, never zero.
// - Quantities and money use exact decimals (18 places); dust is kept, and fees
//   are totaled per transaction, so closing a position never hides them (F20).
// - Research grades never feed into any of this, and nothing here places trades.

const D = require('./decimal');
const { runOp, OpError } = require('./ops');
const { readJson } = require('./fsx');
const { randomId, compactTs, slugify, isProjectId } = require('./ids');
const { listProjects } = require('./projects');
const { ymdInTz } = require('./dates');

const TX_TYPES = ['buy', 'sell', 'transfer_out', 'transfer_in', 'income', 'fee', 'deposit_cash', 'withdraw_cash'];
const TX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const METHOD_TEXT = 'FIFO lots per account (wallet by wallet), oldest acquisition first, exact to 18 decimal places. Transfers between your own accounts move lots with their original cost and acquisition date (no gain or loss). In-kind transfer fees reduce the units that arrive; their cost stays in the basis of the remaining units. USD fees are added to purchase cost and deducted from sale proceeds, and every fee stays in the fee totals even after a position closes. Fees paid in another crypto asset reduce that asset and are reported at cost under fees. Trades marked "settled in cash" move the account\'s USD cash; otherwise cash is only what you record as deposits and withdrawals.';
const BTC_DEFINITION = 'BTC capital comparison: the BTC-equivalent of what you hold now plus each sale\'s proceeds converted to BTC on the sale date, compared with each purchase\'s cost (including USD fees) converted to BTC on the purchase date. Positive means the position ended with more BTC-equivalent than putting the same cash flows into BTC on the same days. It is not a time-weighted return (TWR) or an internal rate of return (IRR). It needs a recorded BTC/USD price for every purchase and sale, and it is withheld when any input is missing, a cost basis is unknown, units arrived or left without a cash flow (external transfers), or income was received (no cash cost).';

function loadAccounts(ws) {
  return readJson(ws.abs('portfolio/accounts.json'), { accounts: [] }).accounts || [];
}

function loadTransactions(ws) {
  return readJson(ws.abs('portfolio/transactions.json'), { transactions: [] }).transactions || [];
}

function loadLimits(ws) {
  return readJson(ws.abs('portfolio/limits.json'), {});
}

// Assets: reference assets from portfolio/assets.json plus every project whose
// identity is verified. Pending identities are never used for holdings.
function assetRegistry(ws) {
  const map = new Map();
  for (const a of readJson(ws.abs('portfolio/assets.json'), { assets: [] }).assets || []) {
    map.set(a.asset_id, { ...a, decimals: Number.isInteger(a.decimals) ? a.decimals : 18, project_id: a.project_id || null, source: 'portfolio/assets.json' });
  }
  for (const p of listProjects(ws)) {
    if (p.broken || !p.identity || p.identity.status !== 'verified') continue;
    const assetId = p.identity.coingecko_id || p.project_id;
    if (map.has(assetId) && map.get(assetId).project_id && map.get(assetId).project_id !== p.project_id) continue;
    const declared = (p.identity.assets || []).map((x) => x.decimals).filter((x) => Number.isInteger(x));
    map.set(assetId, {
      asset_id: assetId,
      symbol: p.symbol,
      name: p.name,
      coingecko_id: p.identity.coingecko_id || null,
      kind: 'token',
      decimals: declared.length ? Math.max(...declared) : 18,
      deployments: p.identity.assets || [],
      project_id: p.project_id,
      sector: p.sector && p.sector.primary ? p.sector.primary : null,
      sector_profile: p.sector_profile,
      source: `projects/${p.project_id}/project.json`,
    });
  }
  return map;
}

function looksLikeSecret(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  if (v.split(/\s+/).length >= 12) return true; // seed phrase
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return true; // raw private key
  if (/^[1-9A-HJ-NP-Za-km-z]{85,90}$/.test(v)) return true; // base58 secret key
  if (/(xprv|tprv|private|secret|mnemonic)/i.test(v)) return true;
  return false;
}

function addAccount(ws, { account_id = null, name, kind = 'exchange', chain = null, public_address = null, note = null }) {
  const label = String(name || '').trim();
  if (!label) throw new OpError('INVALID', 'An account needs a name.');
  if (looksLikeSecret(public_address) || looksLikeSecret(note)) {
    throw new OpError('REFUSED', 'That looks like a seed phrase or private key. Never store those here. Only public addresses are accepted.');
  }
  const id = account_id || slugify(label, 40);
  if (!isProjectId(id)) throw new OpError('BAD_ID', 'Invalid account ID');
  const out = runOp(ws, { type: 'add_account', summary: `Add account ${id}` }, (op) => {
    const doc = op.readJson('portfolio/accounts.json', { schema_version: 'cr.accounts.v1', accounts: [] });
    if (doc.accounts.some((a) => a.account_id === id)) return { exists: true };
    doc.accounts.push({ account_id: id, name: label, kind, chain, public_address, note, created_at: new Date().toISOString() });
    op.writeJson('portfolio/accounts.json', doc);
    return { exists: false };
  });
  return { status: out.result.exists ? 'exists' : 'saved', account_id: id, files: out.files, verified: out.verified };
}

function addAsset(ws, { asset_id, symbol, name, coingecko_id = null, kind = 'token', deployments = [], decimals = 18 }) {
  if (!asset_id || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(asset_id)) throw new OpError('BAD_ID', 'asset_id must be lowercase letters, digits and dashes (use the CoinGecko ID when there is one).');
  if (!['token', 'stablecoin', 'btc', 'cash'].includes(kind)) throw new OpError('INVALID', 'kind must be token, stablecoin, btc or cash');
  const dec = Number(decimals);
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) throw new OpError('INVALID', 'decimals must be a whole number from 0 to 18');
  const out = runOp(ws, { type: 'add_asset', summary: `Add asset ${asset_id}` }, (op) => {
    const doc = op.readJson('portfolio/assets.json', { schema_version: 'cr.assets.v1', assets: [] });
    if (doc.assets.some((a) => a.asset_id === asset_id)) return { exists: true };
    doc.assets.push({ asset_id, symbol: symbol || null, name: name || asset_id, coingecko_id, kind, decimals: dec, deployments });
    op.writeJson('portfolio/assets.json', doc);
    return { exists: false };
  });
  return { status: out.result.exists ? 'exists' : 'saved', asset_id, files: out.files };
}

// ---------------------------------------------------------------------------
// Input normalization and validation (audit F07)

function blank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function normalizeTx(input, { source }) {
  const errors = [];
  const dec = (v, label) => {
    if (blank(v)) return null;
    try {
      return D.toString(D.of(v, { label }));
    } catch (err) {
      errors.push(err.message);
      return undefined;
    }
  };
  let fee = null;
  if (input.fee && typeof input.fee === 'object') {
    const amount = dec(input.fee.amount, 'fee amount');
    if (amount === null) errors.push('fee amount is missing');
    fee = amount === null || amount === undefined ? null : { amount, asset_id: String(input.fee.asset_id || 'usd').trim().toLowerCase() };
  } else if (!blank(input.fee_amount)) {
    const amount = dec(input.fee_amount, 'fee_amount');
    fee = amount === undefined ? null : { amount, asset_id: String(input.fee_asset || 'usd').trim().toLowerCase() || 'usd' };
  } else if (!blank(input.fee)) {
    const amount = dec(input.fee, 'fee');
    fee = amount === undefined ? null : { amount, asset_id: String(input.fee_asset || 'usd').trim().toLowerCase() || 'usd' };
  }
  const suppliedId = blank(input.tx_id) ? null : String(input.tx_id).trim();
  if (suppliedId && !TX_ID_RE.test(suppliedId)) errors.push('tx_id may use letters, digits, ".", "_", ":" and "-" (up to 100 characters)');
  const tx = {
    tx_id: suppliedId || `tx_${compactTs()}_${randomId(6)}`,
    tx_id_supplied: Boolean(suppliedId),
    type: String(input.type || '').trim().toLowerCase(),
    date: String(input.date || '').trim(),
    account_id: String(input.account_id || input.account || '').trim(),
    asset_id: String(input.asset_id || input.asset || '').trim().toLowerCase(),
    chain: input.chain || null,
    quantity: dec(input.quantity, 'quantity'),
    price_usd: dec(input.price_usd !== undefined ? input.price_usd : input.price, 'price_usd'),
    fee,
    transfer_id: blank(input.transfer_id) ? null : String(input.transfer_id).trim(),
    btc_price_usd: dec(input.btc_price_usd, 'btc_price_usd'),
    btc_price_source: !blank(input.btc_price_usd) ? input.btc_price_source || 'user' : null,
    // When true, a buy is paid from (and a sale paid into) the account's USD cash balance.
    settle_cash: [true, 'true', 'yes', '1', 1].includes(input.settle_cash),
    external_id: blank(input.external_id) ? null : String(input.external_id).trim(),
    source_namespace: blank(input.source_namespace) ? null : String(input.source_namespace).trim(),
    note: input.note || null,
    source,
    created_at: new Date().toISOString(),
    voided: false,
    void_reason: null,
    voided_at: null,
  };
  return { tx, errors };
}

// The economic content of a transaction, for telling an exact retry from a
// different transaction that reuses an ID.
function payloadKey(t) {
  const fee = t.fee ? `${D.toString(D.of(t.fee.amount, { round: true }))}|${t.fee.asset_id}` : '';
  const n = (v) => (blank(v) ? '' : D.toString(D.of(v, { round: true })));
  return JSON.stringify([t.date, t.type, t.account_id, t.asset_id, t.chain || null, n(t.quantity), n(t.price_usd), fee, t.transfer_id || null, n(t.btc_price_usd), Boolean(t.settle_cash), t.external_id || null]);
}

function validateTx(tx, registry, accountIds, existing) {
  const errors = [];
  if (!TX_TYPES.includes(tx.type)) errors.push(`type must be one of ${TX_TYPES.join(', ')}`);
  if (!tx.date || Number.isNaN(Date.parse(tx.date))) errors.push('date must be an ISO date or date-time');
  else if (Date.parse(tx.date) > Date.now() + 86400000) errors.push('date is in the future');
  if (!accountIds.has(tx.account_id)) errors.push(`unknown account "${tx.account_id}" (add it first)`);
  const asset = registry.get(tx.asset_id);
  if (['deposit_cash', 'withdraw_cash'].includes(tx.type)) {
    if (tx.asset_id !== 'usd') errors.push('cash deposits and withdrawals use asset usd');
  } else if (!asset) {
    errors.push(`unknown asset "${tx.asset_id}". Use a CoinGecko ID from a verified project or portfolio/assets.json; pending identities cannot hold positions.`);
  }
  if (tx.quantity === null) errors.push('quantity is required');
  else if (tx.quantity !== undefined) {
    const q = D.of(tx.quantity);
    if (q <= 0n) errors.push('quantity must be positive');
    const decimals = asset ? asset.decimals : 18;
    if (D.decimalsOf(q) > decimals) errors.push(`quantity ${tx.quantity} has more than the ${decimals} decimal places ${tx.asset_id} supports`);
  }
  if (tx.price_usd !== null && tx.price_usd !== undefined && D.of(tx.price_usd) < 0n) errors.push('price_usd must be empty (unknown) or a non-negative number');
  if (tx.btc_price_usd !== null && tx.btc_price_usd !== undefined && D.of(tx.btc_price_usd) <= 0n) errors.push('btc_price_usd must be empty or positive');
  if (tx.fee) {
    if (D.of(tx.fee.amount) < 0n) errors.push('fee amount must be a non-negative number');
    if (tx.fee.asset_id !== 'usd' && !registry.has(tx.fee.asset_id)) errors.push(`unknown fee asset ${tx.fee.asset_id}`);
  }
  if (tx.transfer_id && !['transfer_out', 'transfer_in'].includes(tx.type)) errors.push('transfer_id is only for transfer_out and transfer_in');
  return errors;
}

// Each transfer_id may have one transfer_out and one transfer_in (audit F03).
function transferIdErrors(tx, existing) {
  if (!tx.transfer_id || !['transfer_out', 'transfer_in'].includes(tx.type)) return [];
  const same = existing.filter((t) => !t.voided && t.transfer_id === tx.transfer_id && t.type === tx.type && t.tx_id !== tx.tx_id);
  return same.length ? [`transfer_id "${tx.transfer_id}" is already used by ${same[0].tx_id} for a ${tx.type}. Each transfer needs its own ID (one transfer_out and one transfer_in).`] : [];
}

function addTransactions(ws, inputs, { source = 'manual', csvFile = null, csvContent = null, allowIdentical = false } = {}) {
  const registry = assetRegistry(ws);
  const accountIds = new Set(loadAccounts(ws).map((a) => a.account_id));
  const out = runOp(ws, { type: 'add_transactions', summary: `Record ${inputs.length} transaction(s) from ${source}` }, (op) => {
    const doc = op.readJson('portfolio/transactions.json', { schema_version: 'cr.transactions.v2', accounting_method: 'fifo_per_account', transactions: [] });
    const added = [];
    const unchanged = [];
    const duplicates = [];
    const rejected = [];
    const conflicts = [];
    inputs.forEach((input, i) => {
      const { tx, errors } = normalizeTx(input, { source });
      if (!errors.length) errors.push(...validateTx(tx, registry, accountIds, doc.transactions));
      if (errors.length) {
        rejected.push({ row: i + 1, errors });
        return;
      }
      const key = payloadKey(tx);
      if (tx.tx_id_supplied) {
        const same = doc.transactions.filter((t) => t.tx_id === tx.tx_id);
        if (same.length) {
          if (same.length === 1 && payloadKey(same[0]) === key) unchanged.push({ row: i + 1, tx_id: tx.tx_id, reason: 'same ID and content already recorded' });
          else conflicts.push({ row: i + 1, tx_id: tx.tx_id, reason: 'this ID is already used by a different transaction' });
          return;
        }
      }
      if (tx.external_id) {
        const ns = tx.source_namespace || tx.account_id;
        const same = doc.transactions.find((t) => t.external_id === tx.external_id && (t.source_namespace || t.account_id) === ns);
        if (same) {
          if (payloadKey(same) === key) unchanged.push({ row: i + 1, tx_id: same.tx_id, reason: 'same external ID and content already recorded' });
          else conflicts.push({ row: i + 1, tx_id: same.tx_id, reason: `external ID ${tx.external_id} (${ns}) is already used by a different transaction` });
          return;
        }
      }
      // A CSV row identical in every economic field to an active transaction is
      // held back as a possible re-import, unless explicitly allowed.
      if (source === 'csv' && !allowIdentical && !tx.external_id && !tx.tx_id_supplied) {
        const twin = doc.transactions.find((t) => !t.voided && payloadKey(t) === key);
        if (twin) {
          duplicates.push({ row: i + 1, tx_id: twin.tx_id, reason: 'identical to an existing transaction (re-import?). Use --allow-identical if this really is a second, identical fill.' });
          return;
        }
      }
      const transferErrors = transferIdErrors(tx, doc.transactions);
      if (transferErrors.length) {
        rejected.push({ row: i + 1, errors: transferErrors });
        return;
      }
      delete tx.tx_id_supplied;
      doc.transactions.push(tx);
      added.push(tx.tx_id);
    });
    if (source !== 'csv' && (rejected.length || conflicts.length)) {
      if (conflicts.length) throw new OpError('CONFLICT', `Transaction not recorded: ${conflicts.map((c) => c.reason).join(' | ')}`);
      throw new OpError('INVALID', `Transaction rejected: ${rejected.map((r) => r.errors.join('; ')).join(' | ')}`);
    }
    doc.schema_version = 'cr.transactions.v2';
    if (added.length) op.writeJson('portfolio/transactions.json', doc);
    if (csvContent && added.length) op.write(`portfolio/imports/${compactTs()}_${slugify(csvFile || 'import', 40)}.csv`, csvContent, { mode: 'create' });
    return { added, unchanged, duplicates, rejected, conflicts };
  });
  const r = out.result || { added: [], unchanged: [], duplicates: [], rejected: [], conflicts: [] };
  return { status: r.added.length ? 'saved' : 'unchanged', ...r, files: out.files, verified: out.verified, op_id: out.op_id, replayed: Boolean(out.replayed) };
}

function voidTransaction(ws, txId, reason) {
  if (!reason) throw new OpError('INVALID', 'Voiding needs a reason.');
  const out = runOp(ws, { type: 'void_transaction', summary: `Void ${txId}` }, (op) => {
    const doc = op.readJson('portfolio/transactions.json', null);
    const matches = doc ? doc.transactions.filter((t) => t.tx_id === txId) : [];
    if (!matches.length) throw new OpError('NOT_FOUND', `No transaction ${txId}`);
    if (matches.length > 1) throw new OpError('AMBIGUOUS', `${matches.length} older records share the ID ${txId}, so voiding by ID is ambiguous. Nothing was changed. Fix the duplicate IDs in portfolio/transactions.json first (each needs its own ID).`);
    const tx = matches[0];
    if (tx.voided) return tx;
    tx.voided = true;
    tx.void_reason = String(reason);
    tx.voided_at = new Date().toISOString();
    op.writeJson('portfolio/transactions.json', doc);
    return tx;
  });
  return { status: out.noop ? 'unchanged' : 'voided', tx: out.result, files: out.files };
}

function setLimits(ws, { speculative_capital_cap_usd, max_position_pct, max_sector_pct }) {
  const check = (v, label, max) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (max && n > max)) throw new OpError('INVALID', `${label} must be a number${max ? ` up to ${max}` : ''}`);
    return n;
  };
  const patch = {
    speculative_capital_cap_usd: check(speculative_capital_cap_usd, 'Speculative capital cap'),
    max_position_pct: check(max_position_pct, 'Max position %', 100),
    max_sector_pct: check(max_sector_pct, 'Max sector %', 100),
  };
  const out = runOp(ws, { type: 'set_limits', summary: 'Update capital limits' }, (op) => {
    const doc = op.readJson('portfolio/limits.json', { schema_version: 'cr.limits.v1' });
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) doc[k] = v;
    doc.updated_at = new Date().toISOString();
    op.writeJson('portfolio/limits.json', doc);
    return doc;
  });
  return { status: 'saved', limits: out.result, files: out.files };
}

// Minimal RFC 4180 CSV parser.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function importCsv(ws, csvText, { filename = 'import.csv', defaultAccount = null, allowIdentical = false } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new OpError('INVALID', 'The CSV needs a header row and at least one transaction.');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  for (const col of ['date', 'type', 'asset', 'quantity']) {
    if (!header.includes(col) && !(col === 'asset' && header.includes('asset_id'))) throw new OpError('INVALID', `CSV is missing the "${col}" column. Expected: date,type,account,asset,quantity,price_usd,fee_amount,fee_asset,transfer_id,btc_price_usd,settle_cash,external_id,note`);
  }
  const inputs = rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      o[h] = r[i] !== undefined ? r[i].trim() : '';
    });
    if (!o.account && !o.account_id && defaultAccount) o.account = defaultAccount;
    return o;
  });
  return addTransactions(ws, inputs, { source: 'csv', csvFile: filename, csvContent: csvText, allowIdentical });
}

// ---------------------------------------------------------------------------
// Calculation

// Validates a stored observation before using it (audit F10).
function priceFor(asset, market, settings, now = Date.now()) {
  if (!asset) return { usd: null, status: 'unknown_asset' };
  if (asset.kind === 'cash') return { usd: 1, exact: D.ONE, status: 'fixed', source: 'USD cash is valued at 1.00', as_of: null };
  const id = asset.coingecko_id;
  if (!id) return { usd: null, status: 'no_price_source' };
  const obs = market && market.assets ? market.assets[id] : null;
  if (!obs) return { usd: null, status: 'missing' };
  const p = obs.price_usd;
  const asOf = obs.source_last_updated_at || obs.fetched_at;
  const t = Date.parse(asOf);
  if (!(typeof p === 'number' && Number.isFinite(p) && p > 0) || Number.isNaN(t) || t > now + 10 * 60000) {
    return { usd: null, status: 'invalid', as_of: asOf || null, note: 'The stored observation is not a usable price; it is not used for valuation.' };
  }
  const ageMin = (now - t) / 60000;
  const staleAfter = (settings.freshness && settings.freshness.price_stale_minutes) || 90;
  return { usd: p, exact: D.of(p, { round: true }), status: ageMin > staleAfter ? 'stale' : 'fresh', as_of: asOf, fetched_at: obs.fetched_at, age_minutes: Math.round(ageMin), source: obs.source || 'CoinGecko' };
}

// The price object as shown to callers (no BigInt inside, so it serializes).
function publicPrice(price) {
  const { exact, ...rest } = price;
  return rest;
}

function txOrder(txs) {
  const outDate = new Map();
  for (const t of txs) if (t.type === 'transfer_out' && t.transfer_id && !outDate.has(t.transfer_id)) outDate.set(t.transfer_id, Date.parse(t.date));
  const typeRank = { deposit_cash: 0, buy: 1, income: 1, transfer_in: 2, transfer_out: 1, sell: 3, fee: 3, withdraw_cash: 4 };
  return [...txs].sort((a, b) => {
    const da = a.type === 'transfer_in' && outDate.has(a.transfer_id) ? Math.max(Date.parse(a.date), outDate.get(a.transfer_id)) : Date.parse(a.date);
    const db = b.type === 'transfer_in' && outDate.has(b.transfer_id) ? Math.max(Date.parse(b.date), outDate.get(b.transfer_id)) : Date.parse(b.date);
    if (da !== db) return da - db;
    if (a.transfer_id && a.transfer_id === b.transfer_id) return a.type === 'transfer_out' ? -1 : 1;
    if (typeRank[a.type] !== typeRank[b.type]) return typeRank[a.type] - typeRank[b.type];
    return String(a.created_at).localeCompare(String(b.created_at)) || String(a.tx_id).localeCompare(String(b.tx_id));
  });
}

const n = D.toNumber;
const q = (v) => (blank(v) ? null : D.of(v, { round: true }));

function computePortfolio(ws, { market = null, now = Date.now() } = {}) {
  const registry = assetRegistry(ws);
  const accounts = loadAccounts(ws);
  const all = loadTransactions(ws);
  const active = all.filter((t) => !t.voided);
  const txs = txOrder(active);
  const lots = new Map(); // acct|asset -> lots sorted by acquisition
  const transit = new Map(); // transfer_id -> [legs]
  const quarantine = [];
  const stats = new Map();
  const flows = new Map();
  const warnings = [];
  let seq = 0;
  let totalFeesUsd = 0n;
  let totalCryptoFeeCost = 0n;
  const st = (asset) => {
    if (!stats.has(asset)) stats.set(asset, { realized_known: 0n, realized_unknown_qty: 0n, proceeds: 0n, fees_usd: 0n, fees_crypto_cost: 0n, fees_in_kind_qty: 0n, income: 0n, removed_qty: 0n, shortfall_qty: 0n });
    return stats.get(asset);
  };
  const flow = (asset) => {
    if (!flows.has(asset)) flows.set(asset, { in: 0n, out: 0n });
    return flows.get(asset);
  };
  const key = (acct, asset) => `${acct}|${asset}`;
  const acqTime = (l) => (l.acquired_at ? Date.parse(l.acquired_at) : Number.MAX_SAFE_INTEGER);
  const put = (acct, asset, lot) => {
    const k = key(acct, asset);
    if (!lots.has(k)) lots.set(k, []);
    const list = lots.get(k);
    const at = acqTime(lot);
    let i = list.length;
    while (i > 0 && (acqTime(list[i - 1]) > at || (acqTime(list[i - 1]) === at && list[i - 1].seq > lot.seq))) i--;
    list.splice(i, 0, lot);
  };
  const take = (acct, asset, qty, txId) => {
    const k = key(acct, asset);
    const list = lots.get(k) || [];
    const taken = [];
    let need = qty;
    while (need > 0n && list.length) {
      const lot = list[0];
      if (lot.qty <= need) {
        taken.push(lot);
        need -= lot.qty;
        list.shift();
      } else {
        const takenCost = lot.cost === null ? null : D.div(D.mul(lot.cost, need), lot.qty);
        taken.push({ ...lot, qty: need, cost: takenCost, lot_id: `${lot.lot_id}/${++seq}` });
        lot.cost = lot.cost === null ? null : lot.cost - takenCost;
        lot.qty -= need;
        need = 0n;
      }
    }
    lots.set(k, list);
    if (need > 0n) {
      st(asset).shortfall_qty += need;
      warnings.push({
        kind: 'shortfall',
        tx_id: txId,
        asset_id: asset,
        account_id: acct,
        message: asset === 'usd'
          ? `${txId}: paid ${D.toString(need)} USD more than the recorded cash in ${acct}. Record the deposit, or leave "paid from cash" off.`
          : `${txId}: ${D.toString(need)} ${asset} more than recorded in ${acct}. Earlier purchases are probably missing; the missing units are treated as unknown cost.`,
      });
      taken.push({ qty: need, cost: null, acquired_at: null, tx_id: null, shortfall: true, lot_id: `shortfall/${txId}` });
    }
    return taken;
  };
  const usdFee = (t) => (t.fee && t.fee.asset_id === 'usd' ? q(t.fee.amount) || 0n : 0n);
  const cryptoFee = (t) => {
    if (!t.fee || t.fee.asset_id === 'usd') return;
    const amount = q(t.fee.amount);
    if (!amount) return;
    const taken = take(t.account_id, t.fee.asset_id, amount, t.tx_id);
    const s = st(t.fee.asset_id);
    for (const l of taken) {
      if (l.cost !== null) {
        s.fees_crypto_cost += l.cost;
        totalCryptoFeeCost += l.cost;
      }
    }
    s.removed_qty += amount;
    flow(t.fee.asset_id).out += amount;
  };

  for (const t of txs) {
    const s = st(t.asset_id);
    const qty = q(t.quantity);
    const price = q(t.price_usd);
    switch (t.type) {
      case 'buy': {
        const fee = usdFee(t);
        const cost = price === null ? null : D.mul(qty, price) + fee;
        if (cost === null) warnings.push({ kind: 'unknown_basis', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: purchase price unknown, so cost basis is unknown.` });
        put(t.account_id, t.asset_id, { qty, cost, acquired_at: t.date, tx_id: t.tx_id, lot_id: t.tx_id, seq: ++seq });
        flow(t.asset_id).in += qty;
        s.fees_usd += fee;
        totalFeesUsd += fee;
        cryptoFee(t);
        if (t.settle_cash) {
          if (cost === null) warnings.push({ kind: 'cash_unsettled', tx_id: t.tx_id, message: `${t.tx_id}: paid from cash, but the price is unknown, so the cash balance was not reduced.` });
          else {
            take(t.account_id, 'usd', cost, t.tx_id);
            flow('usd').out += cost;
          }
        }
        break;
      }
      case 'income': {
        const cost = price === null ? null : D.mul(qty, price);
        put(t.account_id, t.asset_id, { qty, cost, acquired_at: t.date, tx_id: t.tx_id, lot_id: t.tx_id, seq: ++seq, income: true });
        flow(t.asset_id).in += qty;
        if (cost !== null) s.income += cost;
        break;
      }
      case 'deposit_cash':
        put(t.account_id, 'usd', { qty, cost: qty, acquired_at: t.date, tx_id: t.tx_id, lot_id: t.tx_id, seq: ++seq });
        flow('usd').in += qty;
        break;
      case 'withdraw_cash':
        take(t.account_id, 'usd', qty, t.tx_id);
        flow('usd').out += qty;
        break;
      case 'sell': {
        const taken = take(t.account_id, t.asset_id, qty, t.tx_id);
        flow(t.asset_id).out += qty;
        const fee = usdFee(t);
        s.fees_usd += fee;
        totalFeesUsd += fee;
        const proceeds = price === null ? null : D.mul(qty, price) - fee;
        if (proceeds === null) {
          s.realized_unknown_qty += qty;
          warnings.push({ kind: 'unknown_proceeds', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: sale price unknown, so realized result is unknown.` });
        } else {
          s.proceeds += proceeds;
          for (const l of taken) {
            if (l.cost === null) s.realized_unknown_qty += l.qty;
            else s.realized_known += D.div(D.mul(l.qty, proceeds), qty) - l.cost;
          }
          if (t.settle_cash && proceeds > 0n) {
            put(t.account_id, 'usd', { qty: proceeds, cost: proceeds, acquired_at: t.date, tx_id: t.tx_id, lot_id: `${t.tx_id}/cash`, seq: ++seq });
            flow('usd').in += proceeds;
          }
        }
        cryptoFee(t);
        break;
      }
      case 'fee': {
        const taken = take(t.account_id, t.asset_id, qty, t.tx_id);
        for (const l of taken) {
          if (l.cost !== null) {
            s.fees_crypto_cost += l.cost;
            totalCryptoFeeCost += l.cost;
          }
        }
        s.removed_qty += qty;
        flow(t.asset_id).out += qty;
        break;
      }
      case 'transfer_out': {
        const taken = take(t.account_id, t.asset_id, qty, t.tx_id);
        if (t.transfer_id) {
          const legs = transit.get(t.transfer_id) || [];
          const ambiguous = legs.some((l) => l.direction === 'out');
          if (ambiguous) warnings.push({ kind: 'ambiguous_transfer_id', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: transfer_id ${t.transfer_id} is used by more than one transfer_out. Both legs are kept in transit (still yours); give each transfer its own ID.` });
          legs.push({ direction: 'out', id: t.transfer_id, asset_id: t.asset_id, qty, lots: taken, from: t.account_id, date: t.date, tx_id: t.tx_id, matched: false, ambiguous });
          if (ambiguous) legs.forEach((l) => { l.ambiguous = true; });
          transit.set(t.transfer_id, legs);
        } else {
          s.removed_qty += qty;
          flow(t.asset_id).out += qty;
          warnings.push({ kind: 'external_transfer_out', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: sent outside your recorded accounts (no transfer_id). Removed from holdings with no gain or loss recorded.` });
        }
        cryptoFee(t);
        break;
      }
      case 'transfer_in': {
        if (t.transfer_id) {
          const legs = transit.get(t.transfer_id) || [];
          const open = legs.filter((l) => l.direction === 'out' && !l.matched);
          const matchedBefore = legs.some((l) => l.direction === 'out' && l.matched);
          if (open.length > 1 || (open.length === 1 && open[0].ambiguous)) {
            quarantine.push({ tx_id: t.tx_id, asset_id: t.asset_id, quantity: qty, account_id: t.account_id, reason: `transfer_id ${t.transfer_id} matches more than one outbound leg` });
            warnings.push({ kind: 'transfer_quarantined', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: arrival for transfer ${t.transfer_id} cannot be matched to one outbound leg. Its units are quarantined (not counted) until the IDs are fixed; the outbound units stay in transit.` });
            break;
          }
          if (open.length === 1) {
            const leg = open[0];
            if (leg.asset_id !== t.asset_id) {
              quarantine.push({ tx_id: t.tx_id, asset_id: t.asset_id, quantity: qty, account_id: t.account_id, reason: `transfer ${t.transfer_id} left as ${leg.asset_id} and arrived as ${t.asset_id}` });
              warnings.push({ kind: 'bridge_unmatched_asset', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: transfer ${t.transfer_id} left as ${leg.asset_id} but arrived as ${t.asset_id}. The arrival is quarantined (not counted) and the outbound ${leg.asset_id} stays in transit, so nothing is counted twice. Record both sides with one economic asset ID, or record the conversion with evidence.` });
              break;
            }
            leg.matched = true;
            const sent = leg.qty;
            const arrived = qty;
            if (arrived > sent) {
              warnings.push({ kind: 'transfer_over_arrival', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: more arrived (${D.toString(arrived)}) than was sent (${D.toString(sent)}). The extra is treated as unknown cost.` });
              for (const l of leg.lots) put(t.account_id, t.asset_id, { ...l });
              put(t.account_id, t.asset_id, { qty: arrived - sent, cost: null, acquired_at: t.date, tx_id: t.tx_id, lot_id: `${t.tx_id}/extra`, seq: ++seq });
              flow(t.asset_id).in += arrived - sent;
            } else {
              if (sent > arrived) {
                s.fees_in_kind_qty += sent - arrived;
                flow(t.asset_id).out += sent - arrived;
              }
              // Units lost in transit shrink each lot proportionally (exactly);
              // every lot keeps its full cost and original acquisition date.
              const parts = D.splitProportionally(leg.lots.map((l) => l.qty), arrived);
              const arrivedLots = leg.lots.map((l, i) => ({ ...l, qty: parts[i] }));
              arrivedLots.forEach((l, i) => {
                if (l.qty > 0n || l.cost === null || l.cost === 0n) return;
                // A lot whose units were all consumed by the fee passes its cost on.
                const target = arrivedLots.slice(i + 1).find((x) => x.qty > 0n) || [...arrivedLots.slice(0, i)].reverse().find((x) => x.qty > 0n);
                if (target) target.cost = target.cost === null ? null : target.cost + l.cost;
                l.cost = 0n;
              });
              for (const l of arrivedLots) if (l.qty > 0n) put(t.account_id, t.asset_id, l);
            }
            break;
          }
          if (matchedBefore) {
            quarantine.push({ tx_id: t.tx_id, asset_id: t.asset_id, quantity: qty, account_id: t.account_id, reason: `transfer ${t.transfer_id} already arrived once` });
            warnings.push({ kind: 'transfer_quarantined', tx_id: t.tx_id, asset_id: t.asset_id, message: `${t.tx_id}: a second arrival for transfer ${t.transfer_id}. Quarantined (not counted).` });
            break;
          }
        }
        const cost = price === null ? null : D.mul(qty, price);
        put(t.account_id, t.asset_id, { qty, cost, acquired_at: t.date, tx_id: t.tx_id, lot_id: t.tx_id, seq: ++seq });
        flow(t.asset_id).in += qty;
        warnings.push({
          kind: t.transfer_id ? 'unmatched_transfer_in' : 'external_deposit',
          tx_id: t.tx_id,
          asset_id: t.asset_id,
          message: t.transfer_id
            ? `${t.tx_id}: no matching transfer_out for ${t.transfer_id}; treated as a deposit${cost === null ? ' with unknown cost' : ''}.`
            : `${t.tx_id}: deposit from outside your recorded accounts${cost === null ? '; cost basis unknown' : ''}.`,
        });
        break;
      }
      default:
        break;
    }
  }
  for (const [tid, legs] of transit) {
    for (const p of legs.filter((l) => l.direction === 'out' && !l.matched)) {
      warnings.push({ kind: 'in_transit', asset_id: p.asset_id, message: `Transfer ${tid} (${D.toString(p.qty)} ${p.asset_id} from ${p.from}, ${p.tx_id}) has not arrived in a recorded account. It is still counted as yours, shown as in transit.` });
    }
  }

  const settings = ws.settings;
  const openLegs = [...transit.values()].flat().filter((l) => l.direction === 'out' && !l.matched);
  const assetIds = new Set([...[...lots.keys()].map((k) => k.split('|')[1]), ...openLegs.map((p) => p.asset_id), ...[...stats.keys()].filter((a) => {
    const s = stats.get(a);
    return s.realized_known !== 0n || s.realized_unknown_qty > 0n || s.fees_usd > 0n || s.fees_crypto_cost > 0n || s.proceeds !== 0n;
  })]);
  const positions = [];
  for (const assetId of assetIds) {
    const asset = registry.get(assetId) || (assetId === 'usd' ? { asset_id: 'usd', symbol: 'USD', name: 'US dollar cash', kind: 'cash', decimals: 18 } : null);
    const byAccount = [];
    let qty = 0n;
    let knownQty = 0n;
    let knownCost = 0n;
    let unknownQty = 0n;
    for (const [k, list] of lots) {
      const [acct, a] = k.split('|');
      if (a !== assetId) continue;
      const qa = list.reduce((sum, l) => sum + l.qty, 0n);
      if (qa > 0n) byAccount.push({ account_id: acct, quantity: n(qa), quantity_exact: D.toString(qa) });
      for (const l of list) {
        qty += l.qty;
        if (l.cost === null) unknownQty += l.qty;
        else {
          knownQty += l.qty;
          knownCost += l.cost;
        }
      }
    }
    let inTransitQty = 0n;
    for (const p of openLegs) {
      if (p.asset_id !== assetId) continue;
      inTransitQty += p.qty;
      for (const l of p.lots) {
        if (l.cost === null) unknownQty += l.qty;
        else {
          knownQty += l.qty;
          knownCost += l.cost;
        }
      }
    }
    qty += inTransitQty;
    const quarantinedQty = quarantine.filter((x) => x.asset_id === assetId).reduce((sum, x) => sum + x.quantity, 0n);
    const s = st(assetId);
    const price = priceFor(asset, market, settings, now);
    const value = price.exact ? D.mul(qty, price.exact) : null;
    const knownValue = price.exact ? D.mul(knownQty, price.exact) : null;
    const f = flows.get(assetId) || { in: 0n, out: 0n };
    positions.push({
      asset_id: assetId,
      symbol: asset ? asset.symbol : assetId,
      name: asset ? asset.name : assetId,
      kind: asset ? asset.kind : 'unknown',
      project_id: asset ? asset.project_id || null : null,
      sector: asset ? asset.sector || null : null,
      sector_profile: asset ? asset.sector_profile || null : null,
      quantity: n(qty),
      quantity_exact: D.toString(qty),
      in_transit_quantity: n(inTransitQty),
      quarantined_quantity: n(quarantinedQty),
      by_account: byAccount,
      cost_basis_known_usd: knownQty > 0n ? n(knownCost) : null,
      cost_basis_known_exact: knownQty > 0n ? D.toString(knownCost) : null,
      unknown_basis_quantity: n(unknownQty),
      cost_basis_status: unknownQty > 0n ? (knownQty > 0n ? 'partial' : 'unknown') : 'known',
      price: publicPrice(price),
      _price_exact: price.exact || null,
      value_usd: value === null ? null : n(value),
      unrealized_known_usd: knownValue === null || knownQty === 0n ? null : n(knownValue - knownCost),
      realized_known_usd: n(s.realized_known),
      realized_unknown_quantity: n(s.realized_unknown_qty),
      fees_usd: n(s.fees_usd),
      fees_crypto_cost_usd: n(s.fees_crypto_cost),
      fees_in_kind_quantity: n(s.fees_in_kind_qty),
      income_usd: n(s.income),
      closed: qty === 0n,
      conservation: { inflow: D.toString(f.in), outflow: D.toString(f.out), shortfall: D.toString(s.shortfall_qty), holding: D.toString(qty), ok: f.in - f.out + s.shortfall_qty === qty || assetId === 'usd' },
      _value: value,
    });
  }

  // Valuation coverage (audit U03): a missing price is never a zero value.
  const open = positions.filter((p) => !p.closed);
  const priced = open.filter((p) => p.value_usd !== null);
  const unpriced = open.filter((p) => p.value_usd === null);
  const stale = open.filter((p) => p.price.status === 'stale');
  const pricedTotalExact = priced.reduce((acc, p) => acc + p._value, 0n);
  const pricedTotal = n(pricedTotalExact);
  for (const p of positions) {
    p.allocation_pct = p.value_usd === null || pricedTotalExact <= 0n || p.closed ? null : (p.value_usd / pricedTotal) * 100;
    delete p._value;
  }
  const exactPrice = new Map(positions.map((p) => [p.asset_id, p._price_exact]));
  for (const p of positions) delete p._price_exact;
  const valuationState = !all.length ? 'no_records' : !open.length ? 'empty' : !priced.length ? 'all_unpriced' : unpriced.length ? 'partially_priced' : pricedTotalExact === 0n ? 'zero' : stale.length ? 'stale' : 'priced';
  const cashStable = open.filter((p) => ['cash', 'stablecoin'].includes(p.kind)).reduce((acc, p) => acc + (p.value_usd || 0), 0);

  // BTC capital comparison, only when every input is present (audit F21).
  const btcNow = priceFor(registry.get('bitcoin'), market, settings, now);
  for (const p of positions) {
    if (['cash', 'stablecoin', 'btc'].includes(p.kind)) {
      p.btc_relative = { status: 'not_applicable' };
      continue;
    }
    const flowsT = active.filter((t) => t.asset_id === p.asset_id && ['buy', 'sell', 'income', 'transfer_in', 'transfer_out'].includes(t.type));
    const reasons = [];
    let costBtc = 0n;
    let proceedsBtc = 0n;
    for (const t of flowsT) {
      if (t.type === 'transfer_out' && t.transfer_id) continue;
      if (t.type === 'transfer_in' && t.transfer_id && active.some((o) => o.type === 'transfer_out' && o.transfer_id === t.transfer_id && o.asset_id === t.asset_id)) continue;
      if (t.type === 'income') {
        reasons.push(`${t.tx_id}: income received without a cash cost; the comparison method does not cover it`);
        continue;
      }
      if (t.type === 'transfer_out' || t.type === 'transfer_in') {
        reasons.push(`${t.tx_id}: units moved without a recorded cash flow`);
        continue;
      }
      const price = q(t.price_usd);
      const btc = q(t.btc_price_usd);
      if (price === null) reasons.push(`${t.tx_id}: price unknown`);
      if (!btc) reasons.push(`${t.tx_id}: no BTC price recorded`);
      if (price === null || !btc) continue;
      const fee = usdFee(t);
      if (t.type === 'buy') costBtc += D.div(D.mul(q(t.quantity), price) + fee, btc);
      if (t.type === 'sell') proceedsBtc += D.div(D.mul(q(t.quantity), price) - fee, btc);
    }
    if (p.value_usd === null && !p.closed) reasons.push('current price unknown');
    if (!btcNow.exact) reasons.push('current BTC price unknown');
    if (p.unknown_basis_quantity > 0) reasons.push('some units have unknown cost');
    if (p.quarantined_quantity > 0) reasons.push('some units are quarantined');
    if (reasons.length || costBtc <= 0n) {
      p.btc_relative = { status: 'incomplete', reasons: reasons.length ? reasons : ['no priced purchases'], method: 'BTC capital comparison (not TWR or IRR)', definition: BTC_DEFINITION };
      continue;
    }
    const valueExact = p.closed ? 0n : D.mul(D.of(p.quantity_exact), exactPrice.get(p.asset_id));
    const currentBtc = D.div(valueExact, btcNow.exact);
    const result = currentBtc + proceedsBtc - costBtc;
    p.btc_relative = {
      status: 'computed',
      method: 'BTC capital comparison (not TWR or IRR)',
      cost_btc: n(costBtc),
      proceeds_btc: n(proceedsBtc),
      current_btc: n(currentBtc),
      result_btc: n(result),
      result_pct: n(D.div(result * 100n, costBtc)),
      price_status: p.price.status === 'stale' || btcNow.status === 'stale' ? 'stale' : 'fresh',
      definition: BTC_DEFINITION,
    };
  }

  // Sector concentration and limits (flags only, never trades).
  const sectors = new Map();
  for (const p of priced) {
    const sector = p.sector || (p.kind === 'token' ? 'Unclassified' : p.kind);
    sectors.set(sector, (sectors.get(sector) || 0) + p.value_usd);
  }
  const sectorRows = [...sectors.entries()].map(([sector, v]) => ({ sector, value_usd: v, pct: pricedTotal > 0 ? (v / pricedTotal) * 100 : null, denominator: 'priced holdings' })).sort((a, b) => b.value_usd - a.value_usd);
  const limits = loadLimits(ws);
  const flags = [];
  const speculative = open.filter((p) => p.kind === 'token');
  const deployedKnown = speculative.reduce((acc, p) => acc + (p.cost_basis_known_usd || 0), 0);
  const deployedUnknown = speculative.some((p) => p.cost_basis_status !== 'known');
  const speculativeValue = speculative.reduce((acc, p) => acc + (p.value_usd || 0), 0);
  if (limits.speculative_capital_cap_usd) {
    if (deployedKnown > limits.speculative_capital_cap_usd) flags.push({ kind: 'cap', severity: 'warn', message: `Recorded cost of speculative positions ($${deployedKnown.toFixed(2)}${deployedUnknown ? ', plus units of unknown cost' : ''}) is above your cap ($${limits.speculative_capital_cap_usd}).` });
    if (speculativeValue > limits.speculative_capital_cap_usd) flags.push({ kind: 'cap_value', severity: 'info', message: `Priced value of speculative positions ($${speculativeValue.toFixed(2)}) is above your cap.` });
  }
  if (limits.max_position_pct) {
    for (const p of speculative) {
      if (p.allocation_pct !== null && p.allocation_pct > limits.max_position_pct) flags.push({ kind: 'position', severity: 'warn', asset_id: p.asset_id, message: `${p.symbol} is ${p.allocation_pct.toFixed(1)}% of priced holdings (limit ${limits.max_position_pct}%).` });
    }
  }
  if (limits.max_sector_pct) {
    for (const s of sectorRows) {
      if (!['cash', 'stablecoin', 'btc'].includes(s.sector) && s.pct !== null && s.pct > limits.max_sector_pct) flags.push({ kind: 'sector', severity: 'warn', message: `${s.sector} is ${s.pct.toFixed(1)}% of priced holdings (limit ${limits.max_sector_pct}%).` });
    }
  }

  const realizedKnown = positions.reduce((a, p) => a + p.realized_known_usd, 0);
  return {
    as_of: new Date(now).toISOString(),
    method: METHOD_TEXT,
    btc_relative_definition: BTC_DEFINITION,
    accounts,
    positions: positions.sort((a, b) => Number(a.closed) - Number(b.closed) || (b.value_usd || 0) - (a.value_usd || 0)),
    quarantine: quarantine.map((x) => ({ ...x, quantity: n(x.quantity), quantity_exact: D.toString(x.quantity) })),
    totals: {
      valuation_state: valuationState,
      value_priced_usd: priced.length ? pricedTotal : null,
      priced_count: priced.length,
      open_count: open.length,
      unpriced_count: unpriced.length,
      unpriced_assets: unpriced.map((p) => p.symbol || p.asset_id),
      stale_count: stale.length,
      stale_assets: stale.map((p) => p.symbol || p.asset_id),
      cash_stable_usd: cashStable,
      cash_stable_pct: pricedTotal > 0 ? (cashStable / pricedTotal) * 100 : null,
      allocation_denominator: 'priced holdings only',
      realized_known_usd: realizedKnown,
      realized_unknown_positions: positions.filter((p) => p.realized_unknown_quantity > 0).length,
      fees_usd: n(totalFeesUsd + totalCryptoFeeCost),
      fees_usd_cash: n(totalFeesUsd),
      fees_crypto_cost_usd: n(totalCryptoFeeCost),
      speculative_cost_known_usd: deployedKnown,
      speculative_cost_has_unknown: deployedUnknown,
      speculative_value_usd: speculativeValue,
      quarantined_items: quarantine.length,
    },
    sectors: sectorRows,
    limits: { ...limits, flags },
    warnings,
    transaction_count: all.length,
    voided_count: all.filter((t) => t.voided).length,
    duplicate_ids: [...new Set(all.map((t) => t.tx_id).filter((id, i, arr) => arr.indexOf(id) !== i))],
  };
}

function snapshotIfDue(ws, market) {
  const day = ymdInTz();
  const rel = `portfolio/snapshots/${day}.json`;
  const fs = require('fs');
  if (fs.existsSync(ws.abs(rel))) return { status: 'noop', message: `Snapshot for ${day} already exists.` };
  if (!loadTransactions(ws).length) return { status: 'noop', message: 'No transactions recorded; nothing to snapshot.' };
  // A snapshot is permanent, so it is computed inside its own operation: under
  // the workspace lock, after recovery, from one generation of the records
  // (audit V2-001), never from files another save is moving.
  const out = runOp(ws, { type: 'portfolio_snapshot', summary: `Portfolio snapshot ${day}` }, (op) => {
    if (fs.existsSync(ws.abs(rel))) return { noop: true };
    const pf = computePortfolio(ws, { market });
    const snap = {
      schema_version: 'cr.snapshot.v2',
      date: day,
      timezone: 'America/New_York',
      created_at: new Date().toISOString(),
      note: 'Historical record. Values use the prices listed here with their timestamps. Never rewritten.',
      method: pf.method,
      totals: pf.totals,
      positions: pf.positions.filter((p) => !p.closed).map((p) => ({ asset_id: p.asset_id, symbol: p.symbol, quantity: p.quantity_exact, price_usd: p.price.usd, price_status: p.price.status, price_as_of: p.price.as_of || null, value_usd: p.value_usd, cost_basis_known_usd: p.cost_basis_known_exact, cost_basis_status: p.cost_basis_status })),
    };
    op.writeJson(rel, snap, { mode: 'create' });
    return { noop: false };
  });
  if (out.result && out.result.noop) return { status: 'noop', message: `Snapshot for ${day} already exists.` };
  return { status: 'ok', message: `Saved ${rel}`, files: out.files };
}

module.exports = {
  TX_TYPES,
  METHOD_TEXT,
  BTC_DEFINITION,
  loadAccounts,
  loadTransactions,
  loadLimits,
  assetRegistry,
  addAccount,
  addAsset,
  addTransactions,
  voidTransaction,
  setLimits,
  parseCsv,
  importCsv,
  computePortfolio,
  snapshotIfDue,
  priceFor,
  looksLikeSecret,
  payloadKey,
};
