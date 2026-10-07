// Portfolio: only what you record. Valuation states are explicit, the priced
// subtotal shows its coverage, and every allocation names its denominator.
import {
  h, card, table, stateText, fmtUsd, fmtNum, fmtPct, fmtDate, fmtDateTime, freshnessText, callout, empty, link, field, fieldError, input, select,
  button, action, tabStrip, safeSection, submissionId, openDialog,
} from '../ui.js';
import { walletHoldingsCard, walletsTab } from './wallets.js';

const TX_TYPES = ['buy', 'sell', 'transfer_out', 'transfer_in', 'income', 'fee', 'deposit_cash', 'withdraw_cash'];

// Correcting an entry: the form starts from the recorded values; saving voids
// the old entry and records the corrected one together (one verified save).
function openCorrectDialog(ctx, t, ledger) {
  const assets = [{ value: 'usd', label: 'USD cash' }];
  for (const a of ledger.assets || []) if (a.asset_id !== 'usd') assets.push({ value: a.asset_id, label: `${a.symbol || a.name || a.asset_id} (${a.asset_id})` });
  const opts = (list, cur) => list.map((o) => (typeof o === 'string' ? { value: o, label: o.replace(/_/g, ' '), selected: o === cur } : { ...o, selected: o.value === cur }));
  const type = select(opts(TX_TYPES, t.type), { name: 'fix-type' });
  const date = h('input', { type: 'date', name: 'fix-date', value: String(t.date || '').slice(0, 10) });
  const acct = select(opts((ledger.accounts || []).map((a) => ({ value: a.account_id, label: a.name || a.account_id })), t.account_id), { name: 'fix-account' });
  const asset = select(opts(assets, t.asset_id), { name: 'fix-asset' });
  const qty = input({ name: 'fix-qty', inputmode: 'decimal', value: String(t.quantity) });
  const price = input({ name: 'fix-price', inputmode: 'decimal', placeholder: 'blank = unknown', value: t.price_usd === null || t.price_usd === undefined ? '' : String(t.price_usd) });
  const fee = input({ name: 'fix-fee', inputmode: 'decimal', placeholder: '0', value: t.fee ? String(t.fee.amount) : '' });
  const feeAsset = select(opts(assets, t.fee ? t.fee.asset_id : 'usd'), { name: 'fix-fee-asset' });
  const note = input({ name: 'fix-note', value: t.note || '' });
  const reason = input({ name: 'fix-reason', placeholder: 'e.g. wrong quantity' });
  const save = button('Save correction', null, { kind: 'primary', type: 'submit' });
  let dlg = null;
  const form = h('form', { class: 'form-grid' },
    field('Type', type), field('Date', date), field('Account', acct), field('Asset', asset), field('Quantity', qty, 'Exact decimal'), field('Price per unit (USD)', price, 'Blank means unknown'), field('Fee', fee), field('Fee asset', feeAsset), field('Note', note), field('Reason for the correction', reason, 'Kept with both entries'),
    h('div', { class: 'field wide' }, h('p', { class: 'small muted' }, `The current entry (${t.tx_id}) is voided and stays visible; the corrected entry replaces it.`), save));
  form.onsubmit = action(save, async () => {
    if (!reason.value.trim()) {
      fieldError(reason, 'Say why, so the history stays clear.');
      return undefined;
    }
    const r = await ctx.api.post(`/api/portfolio/transactions/${encodeURIComponent(t.tx_id)}/correct`, {
      reason: reason.value.trim(),
      transaction: { type: type.value, date: date.value, account_id: acct.value, asset_id: asset.value, quantity: qty.value.trim(), price_usd: price.value.trim() === '' ? null : price.value.trim(), fee: fee.value.trim() ? { amount: fee.value.trim(), asset_id: feeAsset.value } : null, transfer_id: t.transfer_id || null, btc_price_usd: t.btc_price_usd ?? null, settle_cash: Boolean(t.settle_cash), note: note.value.trim() || null },
    });
    if (dlg) dlg.close();
    await ctx.refresh();
    return r;
  }, () => 'Corrected. The old entry stays, marked voided.');
  dlg = openDialog(`Correct ${t.type.replace(/_/g, ' ')} of ${t.asset_id}`, form);
  return dlg;
}

const TABS = [
  ['positions', 'Positions'],
  ['wallets', 'Wallets'],
  ['transactions', 'Transactions'],
  ['record', 'Record & import'],
];

// Where a ledger entry came from, in words; a wallet import names its
// network and transaction.
const SOURCE_WORDS = { manual: 'Manual', csv: 'CSV import', dashboard: 'Dashboard', correction: 'Correction', connector: 'Assistant', request: 'Request' };
const EXPLORERS = { eth: 'https://etherscan.io', base: 'https://basescan.org', arbitrum: 'https://arbiscan.io', optimism: 'https://optimistic.etherscan.io', linea: 'https://lineascan.build', polygon: 'https://polygonscan.com', bsc: 'https://bscscan.com', avalanche: 'https://snowtrace.io' };
function sourceCell(t) {
  const p = t.provenance;
  if (t.source === 'wallet_sync' && p && p.tx_hash) {
    const base = EXPLORERS[p.network];
    return h('div', { class: 'small' }, `Wallet sync · ${p.network}`, h('div', null, base ? link(`${p.tx_hash.slice(0, 10)}…`, `${base}/tx/${p.tx_hash}`, { class: 'mono', title: p.tx_hash }) : h('code', { class: 'mono', title: p.tx_hash }, `${p.tx_hash.slice(0, 10)}…`)));
  }
  return h('span', { class: 'small' }, SOURCE_WORDS[t.source] || t.source || '—');
}

// Wallet imports carry no prices and leave to addresses outside your
// accounts: expected notes, counted in one line instead of one per entry.
const WALLET_NOTE_KINDS = new Set(['external_deposit', 'external_transfer_out', 'unknown_basis', 'unknown_proceeds']);

const STATE_TEXT = {
  no_records: ['Nothing recorded in the ledger', 'info', 'Researching a token never creates a position. Record transactions under Record & import, or track a wallet under Wallets.'],
  empty: ['All positions closed', 'info', 'Every recorded position is closed. Realized results and fees stay below.'],
  all_unpriced: ['No position has a usable price', 'bad', 'Values are unknown, not zero. Prices return when market data refreshes.'],
  partially_priced: ['Partly priced', 'warn', 'Some positions have no usable price. Totals cover priced positions only and say so.'],
  zero: ['Priced at zero', 'warn', 'Every priced position is worth zero.'],
  stale: ['Priced, some prices stale', 'warn', 'Some prices are older than your freshness setting. They are shown with their age.'],
  priced: ['All positions priced', 'ok', 'Every open position has a fresh price.'],
};

export async function renderPortfolio(ctx, route) {
  const tab = TABS.some(([t]) => t === route.query.get('tab')) ? route.query.get('tab') : 'positions';
  const strip = tabStrip(TABS.map(([t, label]) => ({ id: t, label, href: `#/portfolio${t === 'positions' ? '' : `?tab=${t}`}` })), tab, { label: 'Portfolio sections' });
  const body = await safeSection(TABS.find(([t]) => t === tab)[1], () => ({ positions: positionsTab, wallets: walletsTab, transactions: transactionsTab, record: recordTab })[tab](ctx));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Portfolio'))),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
}

function pnl(v) {
  if (v === null || v === undefined) return h('span', { class: 'unknown' }, 'unknown');
  return h('span', { class: v > 0 ? 'pos' : v < 0 ? 'neg' : '' }, fmtUsd(v));
}

function basisCell(p) {
  if (p.cost_basis_status === 'known') return fmtUsd(p.cost_basis_known_usd);
  if (p.cost_basis_status === 'partial') return h('span', { title: 'Unknown purchase history means unknown cost basis. Nothing is guessed.' }, fmtUsd(p.cost_basis_known_usd), h('span', { class: 'note-line' }, `+ ${fmtNum(p.unknown_basis_quantity)} units with unknown cost`));
  return h('span', { class: 'unknown', title: 'No recorded purchase price' }, 'Unknown');
}

function btcCell(p) {
  const b = p.btc_relative;
  if (!b || b.status === 'not_applicable') return h('span', { class: 'faint' }, 'Not applicable');
  if (b.status !== 'computed') return h('span', { class: 'unknown', title: `${b.method || 'BTC capital comparison'}: ${(b.reasons || []).join('; ')}` }, 'Withheld');
  return h('span', { title: `${b.method}. ${b.definition}` },
    h('span', { class: b.result_btc >= 0 ? 'pos' : 'neg' }, `${b.result_btc >= 0 ? '+' : ''}${b.result_btc.toFixed(5)} BTC (${b.result_pct >= 0 ? '+' : ''}${b.result_pct.toFixed(1)}%)`),
    b.price_status === 'stale' ? h('span', { class: 'note-line warn-text' }, 'BTC price stale') : null);
}

function summaryItem(label, value, hint) {
  return h('div', { class: 'item' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null);
}

async function positionsTab(ctx) {
  const idx = ctx.state.index;
  const pf = idx.portfolio;
  // Tracked wallets first (what the chain shows); the ledger follows. A
  // failure to read them never hides the ledger.
  let walletCard = null;
  try {
    walletCard = walletHoldingsCard(ctx, await ctx.api.get('/api/wallets'));
  } catch (err) {
    walletCard = callout(`Wallet balances could not be shown: ${err.message}. The ledger below is unaffected.`, 'warn');
  }
  const walletNotes = pf.warnings.filter((w) => w.source === 'wallet_sync' && WALLET_NOTE_KINDS.has(w.kind));
  const otherNotes = pf.warnings.filter((w) => !walletNotes.includes(w));
  const t = pf.totals;
  const open = pf.positions.filter((p) => !p.closed);
  const closed = pf.positions.filter((p) => p.closed);
  const [stateLabel, stateKind, stateNote] = STATE_TEXT[t.valuation_state] || [t.valuation_state, '', ''];
  const denominator = t.allocation_denominator || 'priced holdings only';

  const positions = table([
    { label: 'Asset', render: (p) => h('div', { style: { minWidth: '120px' } }, p.project_id ? h('a', { href: `#/watchlist?p=${encodeURIComponent(p.project_id)}`, title: 'Open its research summary' }, p.symbol || p.asset_id) : h('strong', null, p.symbol || p.asset_id), h('div', { class: 'small muted' }, p.name), p.kind !== 'token' ? h('div', { class: 'small faint' }, p.kind.replace(/_/g, ' ')) : null) },
    { label: 'Accounts', render: (p) => h('div', { class: 'small' }, p.by_account.map((a) => h('div', { class: 'nowrap' }, `${a.account_id}: ${fmtNum(a.quantity)}`)), p.in_transit_quantity ? h('div', { class: 'warn-text' }, `${fmtNum(p.in_transit_quantity)} in transit`) : null, p.quarantined_quantity ? h('div', { class: 'warn-text', title: 'Units held back until a conflicting record is resolved' }, `${fmtNum(p.quarantined_quantity)} quarantined`) : null) },
    { label: 'Quantity', num: true, render: (p) => h('span', { title: `Exact: ${p.quantity_exact}` }, fmtNum(p.quantity)) },
    { label: 'Price', num: true, render: (p) => { const f = freshnessText(p.price.status, p.price.age_minutes); return h('div', null, p.price.usd === null ? h('span', { class: 'unknown' }, 'No price') : fmtUsd(p.price.usd), p.price.status === 'fresh' ? null : h('span', { class: `note-line${f.tone === 'ok' ? '' : ' warn-text'}` }, f.text)); } },
    { label: 'Value', num: true, render: (p) => (p.value_usd === null ? h('span', { class: 'unknown', title: 'No usable price; the value is unknown, not zero' }, 'Unknown') : fmtUsd(p.value_usd)) },
    { label: h('span', { title: `Share of ${denominator}` }, 'Allocation', h('span', { class: 'th-sub' }, `of ${denominator}`)), num: true, render: (p) => (p.allocation_pct === null ? h('span', { class: 'unknown' }, 'Unpriced') : fmtPct(p.allocation_pct)) },
    { label: 'Cost basis', render: basisCell },
    { label: 'Unrealized (known lots)', num: true, render: (p) => pnl(p.unrealized_known_usd) },
    { label: 'Realized', num: true, render: (p) => h('div', null, pnl(p.realized_known_usd), p.realized_unknown_quantity ? h('span', { class: 'note-line' }, `+ ${fmtNum(p.realized_unknown_quantity)} units with unknown cost`) : null) },
    { label: 'Fees', num: true, render: (p) => fmtUsd((p.fees_usd || 0) + (p.fees_crypto_cost_usd || 0)) },
    { label: 'vs BTC (capital comparison)', render: btcCell },
  ], open, { empty: 'No open positions.' });

  const limits = pf.limits || {};
  return h('div', null,
    walletCard,
    callout(h('span', null, h('strong', null, `${stateLabel}. `), stateNote), stateKind === 'ok' ? 'ok' : stateKind === 'bad' ? 'bad' : stateKind === 'warn' ? 'warn' : 'info'),
    open.length ? h('div', { class: 'summary-row' },
      summaryItem('Priced value', fmtUsd(t.value_priced_usd), `${t.priced_count} of ${t.open_count} open position(s) priced${t.unpriced_count ? ` · unpriced: ${t.unpriced_assets.join(', ')}` : ''}`),
      summaryItem('Cash & stablecoins', t.cash_stable_pct === null ? '—' : fmtPct(t.cash_stable_pct), `${fmtUsd(t.cash_stable_usd)} · share of ${denominator}`),
      summaryItem('Realized (known)', fmtUsd(t.realized_known_usd), t.realized_unknown_positions ? `${t.realized_unknown_positions} position(s) with unknown basis` : 'all sales have known basis'),
      summaryItem('Fees paid', fmtUsd(t.fees_usd), t.fees_crypto_cost_usd ? `includes ${fmtUsd(t.fees_crypto_cost_usd)} paid in crypto (at cost)` : 'USD and in-kind, at cost'),
      summaryItem('Stale prices', String(t.stale_count || 0), t.stale_count ? t.stale_assets.join(', ') : 'none')) : null,
    pf.warnings.length ? card('Records that need attention', h('ul', { class: 'list' },
      otherNotes.map((w) => h('li', null, w.message)),
      walletNotes.length ? h('li', null, `${walletNotes.length} wallet import${walletNotes.length === 1 ? '' : 's'} with no recorded price, or sent to an address outside your accounts. The chain gives quantities, not prices; Correct an entry to add one.`) : null), { note: 'Nothing is estimated to fill these gaps.' }) : null,
    (pf.quarantine || []).length ? card('Quarantined records', table([
      { label: 'Record', render: (q) => h('code', { class: 'small' }, q.tx_id || q.id || '?') },
      { label: 'Why', wrap: true, render: (q) => q.reason || q.message || '' },
    ], pf.quarantine), { note: 'Held out of positions until you resolve them. Nothing was deleted.' }) : null,
    card('Recorded positions', positions, {
      note: open.length ? `From the ledger (your entries and recorded wallet activity). Allocation denominator: ${denominator}. Unpriced positions are excluded from it and listed as unpriced. Research grades stay on the watchlist; select an asset to see them.` : null,
      actions: [link('Record transactions', '#/portfolio?tab=record')],
    }),
    h('div', { class: 'grid two' },
      card('Sector concentration', table([
        { label: 'Sector', render: (s) => s.sector },
        { label: 'Value', num: true, render: (s) => fmtUsd(s.value_usd) },
        { label: 'Share', num: true, render: (s) => (s.pct === null ? '—' : h('span', { title: `Share of ${s.denominator || denominator}` }, fmtPct(s.pct))) },
      ], pf.sectors, { empty: 'No priced holdings.' }), { note: `Shares of ${denominator}. Sector comes from each project's sector label.` }),
      card('Capital limits', [
        limits.flags && limits.flags.length ? h('ul', { class: 'list' }, limits.flags.map((f) => h('li', null, f.severity === 'warn' ? stateText('Over limit', 'warn') : h('strong', null, 'Note'), ' ', f.message))) : h('p', { class: 'small muted' }, 'No limit flags.'),
        h('dl', { class: 'kv', style: { marginTop: '8px' } },
          h('dt', null, 'Speculative capital cap'), h('dd', null, limits.speculative_capital_cap_usd ? fmtUsd(limits.speculative_capital_cap_usd) : 'not set'),
          h('dt', null, 'Recorded cost of speculative positions'), h('dd', null, `${fmtUsd(t.speculative_cost_known_usd)}${t.speculative_cost_has_unknown ? ' (some cost unknown)' : ''}`),
          h('dt', null, 'Max position'), h('dd', null, limits.max_position_pct ? `${limits.max_position_pct}%` : 'not set'),
          h('dt', null, 'Max sector'), h('dd', null, limits.max_sector_pct ? `${limits.max_sector_pct}%` : 'not set')),
        h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Limits only raise flags. A research grade never triggers or suggests a trade.'),
      ], { actions: [link('Edit limits', '#/portfolio?tab=record')] })),
    closed.length ? card('Closed positions', table([
      { label: 'Asset', render: (p) => p.symbol || p.asset_id },
      { label: 'Realized (known)', num: true, render: (p) => pnl(p.realized_known_usd) },
      { label: 'Unknown units', num: true, render: (p) => (p.realized_unknown_quantity ? fmtNum(p.realized_unknown_quantity) : '—') },
      { label: 'Fees', num: true, render: (p) => fmtUsd((p.fees_usd || 0) + (p.fees_crypto_cost_usd || 0)) },
    ], closed), { note: 'Kept with their realized results and fees.' }) : null,
    card('Accounts', pf.accounts.length ? table([
      { label: 'Account', key: 'account_id' },
      { label: 'Name', key: 'name' },
      { label: 'Kind', key: 'kind' },
      { label: 'Chain', key: 'chain' },
      { label: 'Public address', render: (a) => (a.public_address ? h('code', { class: 'wrap-anywhere' }, a.public_address) : null) },
    ], pf.accounts) : empty('No accounts yet.')));
}

async function transactionsTab(ctx) {
  let ledger;
  try {
    ledger = await ctx.api.get('/api/portfolio/ledger');
  } catch (err) {
    return callout(`Could not load transactions: ${err.message}`, 'bad');
  }
  const txs = ledger.transactions.slice().sort((a, b) => String(b.date || b.timestamp || '').localeCompare(String(a.date || a.timestamp || '')));
  const idCounts = new Map();
  for (const t of txs) idCounts.set(t.tx_id, (idCounts.get(t.tx_id) || 0) + 1);
  return h('div', null,
    callout('Mistakes are fixed with Correct (or Void). Nothing is edited in place or deleted: the old entry stays visible, marked voided, next to the corrected one.', 'info'),
    card(`Transactions (${txs.length})`, table([
      { label: 'Date', nowrap: true, render: (t) => fmtDate(t.date || t.timestamp) },
      { label: 'Type', render: (t) => t.type.replace(/_/g, ' ') },
      { label: 'Account', key: 'account_id' },
      { label: 'Asset', render: (t) => h('code', { class: 'small' }, t.asset_id) },
      { label: 'Quantity', num: true, render: (t) => h('span', { title: `Exact: ${t.quantity}` }, fmtNum(Number(t.quantity), 8)) },
      { label: 'Price (USD)', num: true, render: (t) => (t.price_usd === null || t.price_usd === undefined ? h('span', { class: 'unknown' }, 'unknown') : fmtUsd(Number(t.price_usd))) },
      { label: 'Fee', render: (t) => (t.fee ? `${t.fee.amount} ${t.fee.asset_id}` : null) },
      { label: 'Transfer', render: (t) => (t.transfer_id ? h('code', { class: 'small' }, t.transfer_id) : null) },
      { label: 'Source', render: sourceCell },
      { label: 'Note', wrap: true, render: (t) => h('span', { class: 'small' }, t.note || '', t.voided ? h('div', { class: 'faint' }, `Voided ${fmtDateTime(t.voided_at)}: ${t.void_reason || ''}`) : null) },
      { label: '', render: (t) => {
        if (t.voided) return h('span', { class: 'faint' }, 'Voided');
        if (idCounts.get(t.tx_id) > 1) return h('span', { title: 'Several records share this ID; voiding by ID would be ambiguous. Fix the IDs in portfolio/transactions.json.' }, stateText('Duplicate ID', 'bad'));
        const b = button('Void', null, { kind: 'small' });
        b.setAttribute('aria-label', `Void transaction ${t.tx_id}`);
        b.onclick = action(b, async () => {
          const reason = window.prompt(`Why void ${t.tx_id}? (kept with the record)`);
          if (!reason) return undefined;
          const r = await ctx.api.post(`/api/portfolio/transactions/${encodeURIComponent(t.tx_id)}/void`, { reason });
          await ctx.refresh();
          return r;
        }, (r) => (r.status === 'voided' ? 'Voided. The record stays, marked voided.' : 'Already voided'));
        const fix = button('Correct', () => openCorrectDialog(ctx, t, ledger), { kind: 'small' });
        fix.setAttribute('aria-label', `Correct transaction ${t.tx_id}`);
        return h('span', { class: 'btn-row' }, fix, b);
      } },
    ], txs, { empty: 'No transactions recorded.', rowClass: (t) => (t.voided ? 'faint' : null) }), { note: 'Also in portfolio/transactions.json and the transactions CSV export.' }));
}

// The CSV result outlives the page refresh that follows the import.
const lastCsv = { node: null };

async function recordTab(ctx) {
  const idx = ctx.state.index;
  const pf = idx.portfolio;
  let ledger = { accounts: pf.accounts, assets: [] };
  try {
    ledger = await ctx.api.get('/api/portfolio/ledger');
  } catch (_) { /* fall back to index data */ }
  const accounts = ledger.accounts || [];
  const assetOptions = [{ value: 'usd', label: 'USD cash' }];
  const seen = new Set(['usd']);
  for (const a of ledger.assets || []) if (!seen.has(a.asset_id)) { seen.add(a.asset_id); assetOptions.push({ value: a.asset_id, label: `${a.symbol || a.name || a.asset_id} (${a.asset_id})` }); }

  const accName = input({ placeholder: 'Label, e.g. Coinbase (no keys or seed phrases)' });
  const accKind = select(['exchange', 'self_custody', 'other']);
  const accChain = input({ placeholder: 'chain (optional)' });
  const accAddr = input({ placeholder: 'public address only (optional)' });
  const accBtn = button('Add account', null, { kind: 'small', type: 'submit' });
  const accForm = h('form', { class: 'form-grid' }, field('Name', accName), field('Kind', accKind), field('Chain', accChain), field('Public address', accAddr, 'Public only. Never a seed phrase or key.'), h('div', { class: 'field' }, accBtn));
  accForm.onsubmit = action(accBtn, async () => { const r = await ctx.api.post('/api/portfolio/accounts', { name: accName.value, kind: accKind.value, chain: accChain.value || null, public_address: accAddr.value || null }); await ctx.refresh(); return r; }, 'Account added');

  const type = select(['buy', 'sell', 'transfer_out', 'transfer_in', 'income', 'fee', 'deposit_cash', 'withdraw_cash']);
  const date = h('input', { type: 'date', 'aria-label': 'Date' });
  const acct = select(accounts.length ? accounts.map((a) => ({ value: a.account_id, label: a.name })) : [{ value: '', label: 'Add an account first' }]);
  const asset = select(assetOptions);
  const qty = input({ inputmode: 'decimal', placeholder: 'exact amount' });
  const price = input({ inputmode: 'decimal', placeholder: 'blank = unknown' });
  const fee = input({ inputmode: 'decimal', placeholder: '0' });
  const feeAsset = select(assetOptions);
  const transfer = input({ placeholder: 'same ID on both sides' });
  const btc = input({ inputmode: 'decimal', placeholder: 'optional, for vs-BTC' });
  const note = input({ placeholder: 'optional' });
  const settle = h('input', { type: 'checkbox' });
  const txBtn = button('Record transaction', null, { kind: 'primary small', type: 'submit' });
  const txForm = h('form', { class: 'form-grid' }, field('Type', type), field('Date', date), field('Account', acct), field('Asset', asset, 'Only verified project identities and reference assets'), field('Quantity', qty, 'Exact decimal, up to the asset\'s decimals'), field('Price per unit (USD)', price, 'Blank means unknown; cost basis stays unknown'), field('Fee', fee), field('Fee asset', feeAsset), field('Transfer ID', transfer, 'For moves between your own accounts or bridges'), field('BTC/USD at the time', btc), field('Note', note), h('label', { class: 'check' }, settle, 'Settled in this account\'s USD cash'), h('div', { class: 'field' }, txBtn));
  let txSid = submissionId();
  const recordTx = action(txBtn, async () => {
    const r = await ctx.api.post('/api/portfolio/transactions', {
      type: type.value, date: date.value, account_id: acct.value, asset_id: asset.value, quantity: qty.value.trim(),
      price_usd: price.value.trim() === '' ? null : price.value.trim(), fee: fee.value.trim() ? { amount: fee.value.trim(), asset_id: feeAsset.value } : null,
      transfer_id: transfer.value.trim() || null, btc_price_usd: btc.value.trim() || null, note: note.value.trim() || null, settle_cash: settle.checked, submission_id: txSid,
    });
    if ((r.rejected || []).length) throw new Error(`Not recorded: ${r.rejected.map((x) => (x.errors || []).join('; ')).join(' | ')}`);
    txSid = submissionId();
    await ctx.refresh();
    return r;
  }, (r) => (r.status === 'saved' ? 'Transaction recorded' : 'Already recorded (no duplicate created)'));
  for (const el of [date, acct, qty]) el.addEventListener('input', () => fieldError(el, null));
  txForm.onsubmit = (e) => {
    e.preventDefault();
    if (!date.value) return fieldError(date, 'Pick a date.');
    if (!acct.value) return fieldError(acct, 'Add an account first (below).');
    if (!qty.value.trim()) return fieldError(qty, 'Enter the exact quantity.');
    return recordTx();
  };

  const csv = h('textarea', { name: 'csv-text', placeholder: 'date,type,account,asset,quantity,price_usd,fee_amount,fee_asset,transfer_id,btc_price_usd,settle_cash,external_id,note', 'aria-label': 'CSV text' });
  const csvFile = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'CSV file' });
  const csvBtn = button('Import CSV', null, { kind: 'small', type: 'submit' });
  const csvOut = h('div', { 'aria-live': 'polite' }, lastCsv.node);
  const csvForm = h('form', { class: 'form-grid' }, field('CSV file', csvFile), h('div', { class: 'field wide' }, csv), h('div', { class: 'field' }, csvBtn));
  csvForm.onsubmit = action(csvBtn, async () => {
    let content = csv.value;
    let filename = 'pasted.csv';
    if (csvFile.files && csvFile.files[0]) {
      content = await csvFile.files[0].text();
      filename = csvFile.files[0].name;
    }
    if (!content.trim()) {
      fieldError(csvFile, 'Choose a CSV file or paste CSV text.');
      return undefined;
    }
    const r = await ctx.api.post('/api/portfolio/csv', { csv: content, filename });
    const n = (k) => (r[k] || []).length;
    lastCsv.node = callout(`Added ${n('added')}, already recorded ${n('unchanged')}, duplicate rows skipped ${n('duplicates')}, conflicts ${n('conflicts')}, rejected ${n('rejected')}${n('rejected') ? `: ${r.rejected.map((x) => `row ${x.row}: ${(x.errors || []).join('; ')}`).join(' | ')}` : ''}`, n('rejected') || n('conflicts') ? 'warn' : 'info');
    csvOut.replaceChildren(lastCsv.node);
    await ctx.refresh();
    return undefined;
  });

  const limits = pf.limits || {};
  const cap = input({ inputmode: 'decimal', value: limits.speculative_capital_cap_usd ?? '' });
  const maxPos = input({ inputmode: 'decimal', value: limits.max_position_pct ?? '' });
  const maxSec = input({ inputmode: 'decimal', value: limits.max_sector_pct ?? '' });
  const limBtn = button('Save limits', null, { kind: 'small', type: 'submit' });
  const limForm = h('form', { class: 'form-grid' }, field('Speculative capital cap (USD)', cap), field('Max single position (%)', maxPos), field('Max sector (%)', maxSec), h('div', { class: 'field' }, limBtn));
  limForm.onsubmit = action(limBtn, async () => { const r = await ctx.api.post('/api/portfolio/limits', { speculative_capital_cap_usd: cap.value, max_position_pct: maxPos.value, max_sector_pct: maxSec.value }); await ctx.refresh(); return r; }, 'Limits saved. They only raise flags.');

  return h('div', null,
    callout('Holdings are recorded by you, manually or by CSV, or from the public wallets you track (read-only, under Wallets). No exchange is connected, no wallet is asked to sign anything and no trading access is ever requested. Quantities are kept exact (18 decimal places).', 'info'),
    card('Record a transaction', txForm, { note: 'A repeated submission is applied once.' }),
    card('Import transactions from CSV', [csvForm, csvOut, h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'The CSV is saved to portfolio/imports/ as received. Rows already recorded are skipped; rows that conflict with a recorded transaction are reported, not overwritten.')]),
    h('div', { class: 'grid two' }, card('Accounts', [accForm, accounts.length ? h('p', { class: 'small muted', style: { marginTop: '8px' } }, `Existing: ${accounts.map((a) => a.account_id).join(', ')}`) : null]), card('Capital limits', limForm)));
}
