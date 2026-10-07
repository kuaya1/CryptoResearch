// Tracked wallets in the Portfolio: what the chain shows (observed
// balances), what the ledger records (and from where), and what differs.
// Read-only: public addresses only; nothing here signs, approves or moves
// anything. Drawing this page never syncs: Sync now asks the desk's own queue.
import {
  h, card, table, stateText, fmtUsd, fmtDate, fmtDateTime, fmtAgo, fmtAsOf, callout, empty, link, field, fieldError, input, select,
  button, action, details, submissionId, openDialog, logo, kv, chip, fmtAmount, shortId, copyButton,
} from '../ui.js';

const MINUS = '−';

// An amount rounded for reading (ui.js fmtAmount); the exact decimal is the
// tooltip, the accessible name and data-exact.
function qty(s, symbol = null) {
  if (s === null || s === undefined || s === '') return h('span', { class: 'unknown' }, '—');
  const exact = `${s}${symbol ? ` ${symbol}` : ''}`;
  return h('span', { class: 'num', title: `Exact: ${exact}`, 'aria-label': exact, dataset: { exact: String(s) } }, fmtAmount(s));
}

const NET_TONE = { ok: 'ok', gap: 'warn', resuming: 'work', history_incomplete: 'work', stale: 'warn', failing: 'warn', unavailable: 'bad', never: 'wait', paused: '', held: '', off: '', removed: '', unsupported: '' };

// One network's sync state in words, with the age of the last complete view.
export function networkStatusText(n) {
  const age = n.last_success_at ? fmtAgo(n.last_success_at) : null;
  if (n.state === 'ok') return `Synced ${age}`;
  if (n.state === 'gap') return `Synced ${age} · history incomplete`;
  if (n.state === 'stale') return `Stale · last complete sync ${age}`;
  if (n.state === 'failing') return `Last sync failed · showing the view from ${age}`;
  if (n.state === 'resuming') return `Reading new activity · last complete sync ${age}`;
  if (n.state === 'history_incomplete') return `History still loading${n.pass ? ` (block ${n.pass.resume_block} of ${n.pass.to_block})` : ''}${n.balances_complete_at ? ` · balances read ${fmtAgo(n.balances_complete_at)}` : ''}`;
  return n.words || 'Unknown';
}

function networkStatus(n) {
  return stateText(networkStatusText(n), NET_TONE[n.state] || '');
}

const RECON = {
  matches: ['Matches ledger', 'ok', 'The chain balance equals what the ledger derives for this account.'],
  explained: ['Ledger catching up', 'info', 'Activity the ledger does not have yet (waiting for confirmations, held or unresolved) accounts for the difference.'],
  awaiting_decision: ['Waiting for your decision', 'warn', 'A held transaction may duplicate one you recorded yourself; decide it under Wallets.'],
  mismatch: ['Differs from your ledger', 'bad', 'Nothing on record explains the difference. It stays visible until it is reconciled; nothing is adjusted for you.'],
  incomplete: ['Not complete yet', 'info', 'A tracked network has no complete balance read yet, or its history is still loading.'],
  history_partial: ['History partial', 'info', 'Alchemy\'s history here does not have everything that changes this balance (see the note). It stays visible; nothing is adjusted.'],
  not_in_ledger: ['Not in your ledger', 'info', 'No verified identity names this token, so the ledger cannot hold it. It is shown as the chain reports it.'],
};

function reconChip(r) {
  const x = RECON[r && r.status];
  if (!x) return null;
  const notes = r.notes && r.notes.length ? ` (${r.notes.join('; ')})` : '';
  return h('span', { class: `chip ${x[1]}`, title: `${x[2]}${notes}` }, x[0]);
}

// What the ledger knows of the cost, as a tag; the words say it in full.
function acquisitionTag(a) {
  if (a && a.status === 'known') return chip(`Cost ${fmtUsd(a.cost_usd)}${a.all_networks ? ' · all networks' : ''}`, '', a.all_networks ? 'Recorded cost of this asset in the wallet, all its networks together' : 'Recorded cost');
  if (a && a.status === 'partial') return chip(`Cost ${fmtUsd(a.cost_usd)} + unknown`, '', 'Some units have no recorded cost. Nothing is estimated.');
  return chip('Cost unknown', '', `No purchase price is on record for these units${a && a.note ? ` ${a.note}` : ''}. Nothing is estimated.`);
}

function priceCell(r) {
  if (r.value_usd !== null) return h('span', { class: 'num', title: r.price.as_of ? `Price ${fmtUsd(r.price.usd)} as of ${fmtAsOf(r.price.as_of)}${r.price.status === 'stale' ? ' (stale)' : ''}` : null }, fmtUsd(r.value_usd), r.price.status === 'stale' ? h('span', { class: 'note-line warn-text' }, 'Price stale') : null);
  const why = !r.verified ? 'No verified identity names this token, so the desk has no price for it.' : 'No usable price from the market data right now.';
  return h('span', { class: 'wh-noprice', title: why }, 'Price unavailable');
}

// The balance as read: rounded for reading, the exact decimal kept as the
// tooltip, the accessible name and data-exact.
function balance(r, symbol) {
  if (r.quantity === null || r.quantity === undefined) return h('span', { class: 'unknown' }, r.quantity_note || 'Unknown');
  const exact = `${r.quantity}${symbol ? ` ${symbol}` : ''}`;
  return h('span', { class: 'num', title: `Exact: ${exact}`, 'aria-label': exact, dataset: { exact: String(r.quantity) } }, fmtAmount(r.quantity));
}

const HIDDEN_WORDS = { suspicious: 'Suspected spam', unsolicited: 'Not acquired by you' };

// One token on one network: the asset (logo, symbol, name, network), what
// the ledger knows (tags), then the balance and its value on the right.
function holdingRow(r, { showWallet, setAside = false }) {
  const symbol = setAside ? (r.reported && r.reported.symbol) || r.symbol : r.symbol;
  const name = setAside ? r.name || (r.reported && r.reported.name) : r.name;
  const lg = logo({ symbol: symbol || '?', name: name || '', project_id: r.asset_id || r.contract || r.key, market: { logo_url: setAside ? null : r.logo_url } }, { size: 32 });
  const asReported = r.verified ? null : 'As the token contract reports it (unverified)';
  const sym = symbol || name || 'Unnamed token';
  const symEl = r.project_id ? link(sym, `#/watchlist?p=${encodeURIComponent(r.project_id)}`, { class: 'wh-sym', title: 'Open its research summary' }) : h('span', { class: 'wh-sym', title: asReported }, sym);
  const tags = setAside
    ? [chip(HIDDEN_WORDS[r.hidden] || 'Set aside', '', r.hidden_reason || null)]
    : [acquisitionTag(r.acquisition), reconChip(r.reconciliation), r.wallet_status === 'paused' ? chip('Syncing paused', '') : null];
  return h('li', { class: 'wh-row', dataset: { key: `wh-${r.key}` } },
    lg,
    h('div', { class: 'wh-asset' },
      h('div', { class: 'wh-line' }, symEl, h('span', { class: 'net-pill' }, r.network_label), showWallet ? h('span', { class: 'net-pill' }, r.wallet_label) : null),
      name && name !== sym ? h('div', { class: 'wh-name', title: asReported }, name) : null,
      setAside && r.contract ? h('div', { class: 'wh-name' }, h('code', { class: 'mono', title: r.contract }, shortId(r.contract)), copyButton(r.contract, 'token contract')) : null),
    h('div', { class: 'wh-tags' }, tags),
    h('div', { class: 'wh-fig' }, h('div', { class: 'wh-qty' }, balance(r, symbol)), h('div', { class: 'wh-val' }, priceCell(r))));
}

// The rows a balance sheet shows first (verified tokens and the network's
// own coin) and the ones it folds away (unverified tokens).
export function holdingGroups(holdings) {
  return { main: holdings.filter((r) => r.verified), unverified: holdings.filter((r) => !r.verified) };
}

function holdingsTable(rows, opts, label) {
  return h('div', { class: 'wh-table' },
    h('div', { class: 'wh-cols', 'aria-hidden': 'true' }, h('span', null, 'Asset'), h('span', null, 'Ledger'), h('span', { class: 'r' }, 'Balance · value')),
    h('ul', { class: 'wh-list', 'aria-label': label }, rows.map((r) => holdingRow(r, opts))));
}

function hiddenList(rows) {
  if (!rows.length) return null;
  return details(`Set aside as spam or unsolicited (${rows.length})`, holdingsTable(rows, { showWallet: false, setAside: true }, 'Tokens set aside'), { id: 'wallet-hidden' });
}

// A tracked wallet's bar: its label and address, each network's sync state
// as a pill, and the schedule.
function walletBar(w, o) {
  return h('div', { class: 'wh-bar', dataset: { key: `wh-bar-${w.wallet_id}` } },
    h('div', { class: 'wh-id' }, h('strong', null, w.label), h('code', { class: 'mono', title: w.address }, w.address_short), copyButton(w.address, `${w.label}'s address`), w.status === 'paused' ? chip('Paused', 'warn') : null),
    h('div', { class: 'wh-nets' }, w.networks.map((n) => h('span', { class: 'sync-pill', title: n.last_error || null }, h('span', { class: 'k' }, n.label), networkStatus(n)))),
    h('span', { class: 'wh-cad', title: 'Each tracked network is read on this schedule; Sync now asks for a read sooner. Change it under Wallets > Sync settings.' }, `Syncs ${o.settings.interval_words.toLowerCase()}`));
}

// The holdings view of every tracked wallet, for the top of Positions.
export function walletHoldingsCard(ctx, o) {
  const tracked = o.wallets.filter((w) => w.status !== 'removed');
  if (!tracked.length) return null;
  const showWallet = tracked.length > 1;
  const keyMissing = !o.provider.present;
  const s = o.summary;
  const actions = [];
  if (tracked.length === 1 && tracked[0].status === 'active' && !keyMissing) actions.push(syncButton(ctx, tracked[0]));
  actions.push(link('Manage wallets', '#/portfolio?tab=wallets', { class: 'btn small' }));
  const { main, unverified } = holdingGroups(o.holdings);
  return card('Wallet balances', [
    h('div', { class: 'wh-bars' }, tracked.map((w) => walletBar(w, o))),
    keyMissing ? callout('Waiting for the Alchemy key (ALCHEMY_API_KEY in Render > Environment). Nothing is read until it is set.', 'info') : null,
    main.length ? holdingsTable(main, { showWallet }, 'Wallet balances') : empty(!o.holdings.length && !s.last_success_at ? 'No complete balance read yet.' : 'No verified token balance on the tracked networks.'),
    o.holdings.length ? h('div', { class: 'wh-total' }, h('span', { class: 'wh-total-k' }, 'Observed value', h('span', { class: 'muted' }, ` · ${s.priced} priced${s.unpriced ? `, ${s.unpriced} without a price` : ''}`)), h('strong', { class: 'num' }, s.value_priced_usd === null ? '—' : fmtUsd(s.value_priced_usd))) : null,
    unverified.length ? details(`Unverified tokens (${unverified.length})`, holdingsTable(unverified, { showWallet }, 'Unverified tokens'), { id: 'wallet-unverified' }) : null,
    hiddenList(o.hidden),
  ], { note: 'What the chain shows at the last complete sync of each network. The ledger below is what you and the sync recorded; differences are marked on each row.', actions });
}

function syncButton(ctx, w) {
  const b = button('Sync now', null, { kind: 'small', key: `sync-${w.wallet_id}` });
  b.setAttribute('aria-label', `Sync ${w.label} now`);
  b.onclick = action(b, async () => {
    const r = await ctx.api.post(`/api/wallets/${encodeURIComponent(w.wallet_id)}/sync`, {});
    if (r.status !== 'queued') throw new Error(r.message);
    return r;
  }, (r) => r.message);
  return b;
}

// ---------------------------------------------------------------------------
// The Wallets tab

const KIND_WORDS = {
  incoming_transfer: () => 'Received',
  outgoing_transfer: () => 'Sent',
  internal_transfer: (e, names) => (e.direction === 'in' ? `From your wallet ${names.get(e.counterparty_wallet_id) || ''}` : `To your wallet ${names.get(e.counterparty_wallet_id) || ''}`).trim(),
  swap: (e) => (e.direction === 'in' ? 'Swap · bought' : 'Swap · sold'),
  possible_swap: (e) => (e.direction === 'in' ? 'Possible swap · in' : 'Possible swap · out'),
  awaiting_receipt: (e) => (e.direction === 'in' ? 'Received' : 'Sent'),
  gas_fee: () => 'Network fee',
  failed_transfer: () => 'Failed transaction',
  self_transfer: () => 'Sent to itself',
  unresolved: () => 'Unresolved',
};

// The event's state in words and a tone: the chain first, then the ledger.
export function eventStatus(e) {
  const l = e.ledger || {};
  if (e.state === 'reverted') return l.status === 'voided' ? ['Reversed on chain · ledger entry voided', 'bad'] : ['Reversed on chain', 'bad'];
  if (l.status === 'recorded') return ['Recorded', 'ok'];
  if (l.status === 'skipped') return [l.decision && /swap/.test(e.classification) ? 'You left it unrecorded' : 'You said it is already recorded', ''];
  if (e.classification === 'awaiting_receipt') return ['Waiting for its receipt', 'wait'];
  if (l.status === 'held') return l.hold && l.hold.needs_decision && !l.decision ? ['Needs your decision', 'warn'] : ['Held', 'warn'];
  if (l.status === 'not_recorded') return l.code === 'spam' ? ['Suspected spam · not recorded', ''] : l.code === 'failed' ? ['Not recorded: failed', ''] : l.code === 'self' ? ['No change', ''] : ['Not recorded', 'wait'];
  if (e.state === 'pending') return ['Waiting for confirmations', 'wait'];
  return ['Waiting to be recorded', 'wait'];
}

function eventReason(e) {
  const l = e.ledger || {};
  if (l.status === 'held' && l.hold) return l.hold.reason;
  if (l.status === 'not_recorded') return l.reason || e.reason;
  return e.reason || null;
}

function amountCell(e) {
  if (e.amount === null || e.amount === undefined) return h('span', { class: 'unknown' }, 'unknown');
  const sign = e.direction === 'out' ? MINUS : e.direction === 'in' ? '+' : '';
  return h('span', { class: 'num nowrap', title: `Exact: ${e.amount} ${e.symbol || ''}`.trim() }, `${sign}${fmtAmount(e.amount)} `, h('span', { class: e.verified ? null : 'faint' }, e.symbol || 'token'));
}

// The two choices, in the words of why the event is held.
const DECISION_WORDS = {
  possible_swap: ['Record as swap', 'Leave unrecorded', 'Recorded as a sale and a purchase at unknown price', 'Left out of the ledger. The balances still show it.'],
  possible_own_transfer: ['Record as sent', 'Already recorded', 'Recorded in the ledger', 'Kept out of the ledger. Your own entry stays as it is.'],
  manual_records: ['Record in ledger', 'Already recorded', 'Recorded in the ledger', 'Kept out of the ledger. Your own entry stays as it is.'],
};

function decisionButtons(ctx, e) {
  const post = (decision) => ctx.api.post('/api/wallets/events/resolve', { wallet_id: e.wallet_id, network: e.network, event_key: e.event_key, decision });
  const [recWord, skipWord, recDone, skipDone] = DECISION_WORDS[e.ledger.hold && e.ledger.hold.code] || DECISION_WORDS.manual_records;
  const rec = button(recWord, null, { kind: 'small', key: `rec-${e.event_key}` });
  rec.onclick = action(rec, async () => { const r = await post('record'); await ctx.refresh(); return r; }, (r) => (r.ledger && r.ledger.recorded ? recDone : 'Saved; it is recorded once it is final and mapped'));
  const skip = button(skipWord, null, { kind: 'small', key: `skip-${e.event_key}` });
  skip.onclick = action(skip, async () => { const r = await post('skip'); await ctx.refresh(); return r; }, skipDone);
  return h('span', { class: 'btn-row' }, rec, skip);
}

function walletCard(ctx, w, o) {
  const active = w.status === 'active';
  const acts = [];
  if (w.status !== 'removed') {
    if (active && o.provider.present) acts.push(syncButton(ctx, w));
    const pr = button(active ? 'Pause syncing' : 'Resume syncing', null, { kind: 'small', key: `pause-${w.wallet_id}` });
    pr.onclick = action(pr, async () => { const r = await ctx.api.post(`/api/wallets/${encodeURIComponent(w.wallet_id)}/${active ? 'pause' : 'resume'}`, {}); await ctx.refresh(); return r; }, active ? 'Syncing paused. The last view stays.' : 'Syncing resumed.');
    acts.push(pr);
    acts.push(button('Networks', () => openNetworksDialog(ctx, w, o), { kind: 'small', key: `nets-${w.wallet_id}` }));
    acts.push(button('Remove tracking', () => openRemoveDialog(ctx, w), { kind: 'small', key: `remove-${w.wallet_id}` }));
  }
  // One row per network, stacked so it reads the same on a phone.
  const rows = h('ul', { class: 'wh-list' }, w.networks.map((n) => {
    const missingSent = Number(n.history_gap || 0);
    return h('li', { class: 'wl-net', dataset: { key: `wl-net-${w.wallet_id}-${n.network}` } },
      h('div', { class: 'wl-net-head' }, h('strong', null, n.label), networkStatus(n)),
      n.last_error && !['ok', 'unsupported'].includes(n.state) ? h('div', { class: 'small muted' }, n.last_error) : null,
      n.supported === false ? h('div', { class: 'small muted' }, 'Its earlier records stay as they are. Choose a covered network under Networks to keep following this wallet.') : h('div', { class: 'small muted' }, [
        n.snapshot_at ? `Balances as of ${fmtAsOf(n.snapshot_confirmed_at || n.snapshot_at)}` : 'No complete balance read yet',
        `${n.events} event(s)`,
        n.counts.pending ? `${n.counts.pending} not final yet` : null,
        n.counts.decisions ? `${n.counts.decisions} need your decision` : null,
        n.counts.reversed ? `${n.counts.reversed} reversed` : null,
        n.unreadable ? `${n.unreadable} token balance(s) unreadable` : null,
      ].filter(Boolean).join(' · ')),
      n.coverage && !n.coverage.internal ? h('div', { class: 'small muted', title: 'Alchemy reports ETH that contracts send (internal transfers) only on Ethereum, Polygon and Base.' }, 'History here does not include ETH sent by contracts.') : null,
      missingSent ? h('div', { class: 'small warn-text' }, `${missingSent} transaction(s) this wallet sent are not in Alchemy's history; their fees are not recorded.`) : null);
  }));
  const title = h('div', { class: 'wl-title' }, h('h2', null, w.label), h('code', { class: 'mono small', title: w.address }, w.address_short), copyButton(w.address, `${w.label}'s address`), w.status === 'removed' ? chip('Not tracked', '') : w.status === 'paused' ? chip('Paused', 'warn') : null);
  return card(title, [
    rows,
    details('Address and ledger account', kv([
      ['Public address', h('code', { class: 'mono wrap-anywhere' }, w.address)],
      ['Ledger account', w.account_id],
      ['Tracked since', fmtDate(w.created_at)],
      w.removed_at ? ['Tracking removed', fmtDateTime(w.removed_at)] : null,
    ]), { id: `wl-addr-${w.wallet_id}` }),
  ], { actions: acts });
}

function openRemoveDialog(ctx, w) {
  const reason = input({ name: 'remove-reason', placeholder: 'optional' });
  const go = button('Remove tracking', null, { kind: 'primary', type: 'submit' });
  let dlg = null;
  const form = h('form', { class: 'form-grid' },
    h('p', { class: 'field wide' }, `Stops following ${w.label}. Its activity, balance snapshots and every ledger entry made from them stay; nothing is deleted.`),
    field('Reason', reason, 'Kept with the wallet record'),
    h('div', { class: 'field wide' }, go));
  form.onsubmit = action(go, async () => {
    const r = await ctx.api.post(`/api/wallets/${encodeURIComponent(w.wallet_id)}/remove`, { reason: reason.value.trim() || null });
    if (dlg) dlg.close();
    await ctx.refresh();
    return r;
  }, 'No longer tracked. History kept.');
  dlg = openDialog(`Remove tracking: ${w.label}`, form);
  return dlg;
}

function networkChecks(o, chosen, name) {
  return h('fieldset', { class: 'field wide wl-nets' }, h('legend', null, 'Networks'), o.networks_supported.map((n) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name, value: n.id, checked: chosen.includes(n.id) || null }), `${n.label} (${n.native})`)));
}

function checkedNetworks(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((x) => x.value);
}

function openNetworksDialog(ctx, w, o) {
  const save = button('Save networks', null, { kind: 'primary', type: 'submit' });
  let dlg = null;
  const form = h('form', { class: 'form-grid' }, networkChecks(o, w.networks.map((n) => n.network), 'edit-nets'), h('div', { class: 'field wide' }, save));
  form.onsubmit = action(save, async () => {
    const nets = checkedNetworks(form, 'edit-nets');
    if (!nets.length) throw new Error('Choose at least one network.');
    const r = await ctx.api.post(`/api/wallets/${encodeURIComponent(w.wallet_id)}/networks`, { networks: nets });
    if (dlg) dlg.close();
    await ctx.refresh();
    return r;
  }, 'Networks saved. A new network is read at the next sync.');
  dlg = openDialog(`Networks: ${w.label}`, form);
  return dlg;
}

function addWalletForm(ctx, o) {
  const label = input({ name: 'wallet-label', placeholder: 'e.g. MetaMask', autocomplete: 'off' });
  const address = input({ name: 'wallet-address', placeholder: '0x…', autocomplete: 'off', spellcheck: 'false', inputmode: 'text' });
  const account = select([{ value: '', label: 'New account with this label' }, ...o.accounts.map((a) => ({ value: a.account_id, label: `${a.name || a.account_id} (${a.account_id})` }))], { name: 'wallet-account' });
  const go = button('Add wallet', null, { kind: 'primary small', type: 'submit' });
  let sid = submissionId();
  const form = h('form', { class: 'form-grid', dataset: { key: 'wallet-add-form' } },
    field('Label', label),
    field('Public address', address, 'The 0x address only. Never a private key or a seed phrase; the desk never asks for one.'),
    field('Ledger account', account, 'Where recorded activity goes. An existing account with your own entries holds overlapping imports for your decision.'),
    networkChecks(o, [], 'wallet-nets'),
    o.networks_unsupported && o.networks_unsupported.length ? h('p', { class: 'field wide small muted' }, `Not available: ${o.networks_unsupported.map((n) => n.label).join(', ')} (Alchemy's transfer history does not cover them).`) : null,
    h('div', { class: 'field' }, go));
  for (const el of [label, address]) el.addEventListener('input', () => fieldError(el, null));
  const submit = action(go, async () => {
    const r = await ctx.api.post('/api/wallets', { label: label.value.trim(), address: address.value.trim(), networks: checkedNetworks(form, 'wallet-nets'), account_id: account.value || null, submission_id: sid });
    sid = submissionId();
    await ctx.refresh();
    return r;
  }, (r) => (r.status === 'exists' ? 'That address is already tracked.' : 'Wallet added. The first read starts within a minute once the Alchemy key is set, then twice daily.'));
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!label.value.trim()) return fieldError(label, 'Give it a label.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.value.trim())) return fieldError(address, 'A public address is 0x followed by 40 characters (0-9, a-f).');
    if (!checkedNetworks(form, 'wallet-nets').length) return fieldError(address, 'Choose at least one network below; nothing is scanned without one.');
    return submit();
  };
  return form;
}

// The schedules offered; a value set another way still shows as its own words.
const INTERVALS = [[720, 'Twice daily'], [1440, 'Once daily'], [360, 'Every 6 hours'], [180, 'Every 3 hours'], [60, 'Every hour']];

function settingsForm(ctx, o) {
  const s = o.settings;
  const options = INTERVALS.some(([m]) => m === s.interval_minutes) ? INTERVALS : [[s.interval_minutes, s.interval_words], ...INTERVALS];
  const interval = select(options.map(([m, words]) => ({ value: String(m), label: words, selected: m === s.interval_minutes })), { name: 'ws-interval' });
  const daily = input({ name: 'ws-daily-cap', inputmode: 'numeric', value: s.daily_cu_cap === null ? '' : String(s.daily_cu_cap), placeholder: 'no cap' });
  const monthly = input({ name: 'ws-monthly-cap', inputmode: 'numeric', value: s.monthly_cu_cap === null ? '' : String(s.monthly_cu_cap), placeholder: 'no cap' });
  const go = button('Save', null, { kind: 'small', type: 'submit' });
  const e = o.estimate;
  const form = h('form', { class: 'form-grid' },
    field('Sync', interval, 'How often each tracked network is read. Sync now asks for a read sooner, within the same caps.'),
    field('Daily cap (compute units, estimated)', daily, 'The desk stops for the day (New York time) before passing it. Empty means no cap.'),
    field('Monthly cap (compute units, estimated)', monthly, 'The desk stops for the month before passing it. Alchemy Free allows 30,000,000 a month. Empty means no cap.'),
    h('p', { class: 'field wide small muted', title: e.basis }, `About ${e.per_sync.toLocaleString('en-US')} compute units per network each sync with no new activity, plus ${e.per_new_transaction} per new transaction and ${e.per_new_token} per new token. At this schedule: about ${e.per_network_month.toLocaleString('en-US')} a month per network${e.networks ? `; ${e.total_month.toLocaleString('en-US')} for the ${e.networks} network(s) tracked` : ''}.`),
    h('div', { class: 'field' }, go));
  form.onsubmit = action(go, async () => {
    const minutes = Number(interval.value);
    const r = await ctx.api.post('/api/settings', { wallet_sync: { interval_minutes: minutes, balance_refresh_minutes: minutes, daily_cu_cap: daily.value.trim() === '' ? null : daily.value.trim(), monthly_cu_cap: monthly.value.trim() === '' ? null : monthly.value.trim() } });
    await ctx.refresh();
    return r;
  }, 'Saved.');
  return form;
}

function technicalDetails(o) {
  const s = o.sync;
  const methods = Object.entries(s.calls.methods || {}).map(([m, n]) => `${m} ${n}`).join(', ');
  const lines = [
    ['Provider', `Alchemy · key ${o.provider.present ? `present (${o.provider.source})` : 'missing'}`],
    ['Schedule', `${o.settings.interval_words} (every ${o.settings.interval_minutes} minutes)`],
    ['Compute units today (estimated)', `${(s.calls.day_cu || 0).toLocaleString('en-US')}${s.daily_cu_cap ? ` of ${s.daily_cu_cap.toLocaleString('en-US')}` : ''} (${s.calls.day_count || 0} requests)`],
    ['This month (estimated)', `${(s.calls.month_cu || 0).toLocaleString('en-US')}${s.monthly_cu_cap ? ` of ${s.monthly_cu_cap.toLocaleString('en-US')}` : ''} compute units (${s.calls.month_count || 0} requests)${methods ? `: ${methods}` : ''}`],
    ['Usage record', 'Estimated here from Alchemy\'s published method costs; Alchemy\'s dashboard is the provider\'s record.'],
    ['Last run', s.last_run ? `${fmtDateTime(s.last_run.at)} · ${s.last_run.status} · ${s.last_run.summary}` : 'never'],
    s.gate ? ['Waiting', `${s.gate.why} until ${fmtDateTime(s.gate.until)}`] : null,
    s.held_restored_copy ? ['Restored copy', 'Held: no request is sent until the copy is released.'] : null,
  ];
  const nets = o.wallets.flatMap((w) => w.networks.map((n) => ({ ...n, wallet: w.label })));
  return [
    kv(lines),
    table([
      { label: 'Wallet', render: (n) => n.wallet },
      { label: 'Network', render: (n) => n.label },
      { label: 'History read', wrap: true, render: (n) => (n.supported === false ? 'Not covered by Alchemy' : n.history_complete_to ? `Blocks to ${n.history_complete_to}${n.backfill_complete_at ? ` · full history since ${fmtDate(n.backfill_complete_at)}` : ''}${n.last_pass ? ` · last read ${n.last_pass.from_block} to ${n.last_pass.to_block}, ${n.last_pass.pages} page(s), ${n.last_pass.items} item(s)${n.last_pass.malformed ? `, ${n.last_pass.malformed} unreadable` : ''}` : ''}` : n.pass ? `Loading: block ${n.pass.resume_block} of ${n.pass.to_block}` : 'Not read yet') },
      { label: 'Final at', wrap: true, render: (n) => (n.finalized_block ? h('span', { title: n.finalized_basis || null }, `block ${n.finalized_block}`) : '—') },
      { label: 'Sent transactions', render: (n) => (n.sent_count_chain ? `${n.sent_count_seen || 0} seen of ${n.sent_count_chain}` : '—') },
      { label: 'Stored', render: (n) => `${n.events} event(s), ${n.raw_months} raw file(s)` },
      { label: 'Next try', render: (n) => (n.next_attempt_at ? fmtDateTime(n.next_attempt_at) : '—') },
    ], nets, { empty: 'No network.' }),
  ];
}

export async function walletsTab(ctx) {
  let o;
  try {
    o = await ctx.api.get('/api/wallets');
  } catch (err) {
    return callout(`Could not load the tracked wallets: ${err.message}`, 'bad');
  }
  const names = new Map(o.wallets.map((w) => [w.wallet_id, w.label]));
  const tracked = o.wallets.filter((w) => w.status !== 'removed');
  const held = o.held;
  const recon = o.reconciliation.filter((r) => r.status !== 'matches');
  const assetOf = new Map(o.holdings.filter((r) => r.asset_id).map((r) => [r.asset_id, r]));
  const activity = table([
    { label: 'Date', nowrap: true, render: (e) => h('span', { title: fmtDateTime(e.at) }, fmtDate(e.at)) },
    { label: 'Network', render: (e) => e.network_label },
    { label: 'What', render: (e) => (KIND_WORDS[e.classification] || (() => e.classification))(e, names) },
    { label: 'Amount', num: true, render: amountCell },
    { label: 'Status', wrap: true, render: (e) => { const [t, tone] = eventStatus(e); const why = eventReason(e); return h('div', null, stateText(t, tone), why ? h('div', { class: 'small muted' }, why) : null); } },
    { label: 'Transaction', render: (e) => h('span', { class: 'au-id' }, link(shortId(e.tx_hash), e.explorer_url, { class: 'mono small', title: e.tx_hash, rel: 'noopener noreferrer', target: '_blank' }), copyButton(e.tx_hash, 'transaction hash')) },
  ], o.activity, { empty: 'No activity read yet.', rowClass: (e) => (e.state === 'reverted' ? 'faint' : null) });
  return h('div', null,
    held.length ? card(`Waiting for your decision (${held.length})`, h('ul', { class: 'wh-list' }, held.map((e) => h('li', { class: 'wl-decide', dataset: { key: `wl-decide-${e.event_key}` } },
      e.swap_legs ? h('div', { class: 'wl-net-head' }, h('strong', null, 'Possible swap'), h('span', { class: 'btn-row' }, e.swap_legs.map((x) => amountCell({ ...x })))) : h('div', { class: 'wl-net-head' }, h('strong', null, (KIND_WORDS[e.classification] || (() => e.classification))(e, names)), amountCell(e)),
      h('div', { class: 'small muted' }, `${e.wallet_label} · ${e.network_label} · ${fmtDate(e.at)}`),
      h('div', { class: 'small' }, e.ledger.hold.reason),
      decisionButtons(ctx, e)))), { note: 'A possible swap, an overlap with your own entries, or a possible move between your accounts. Nothing is recorded over your entries, and no swap is assumed, without you.' }) : null,
    tracked.length || o.wallets.length ? o.wallets.map((w) => walletCard(ctx, w, o)) : empty('No wallet tracked yet. Add one below: a label, its public address and the networks to follow.'),
    recon.length ? card('Reconciliation', table([
      { label: 'Asset', render: (r) => { const a = assetOf.get(r.asset_id); return h('div', null, h('strong', { title: r.asset_id }, a && a.symbol ? a.symbol : r.asset_id), a && a.name ? h('span', { class: 'muted' }, ` ${a.name}`) : null, h('div', { class: 'small muted' }, `${r.wallet_label} · ${r.account_id}`)); } },
      { label: 'On chain', num: true, render: (r) => qty(r.observed) },
      { label: 'In your ledger', num: true, render: (r) => qty(r.recorded) },
      { label: 'Difference', num: true, render: (r) => qty(r.difference) },
      { label: 'Status', wrap: true, render: (r) => h('div', null, reconChip(r), r.since ? h('div', { class: 'small muted' }, `since ${fmtDateTime(r.since)}`) : null, r.unrecorded_events ? h('div', { class: 'small muted' }, `${r.unrecorded_events} chain event(s) not in the ledger`) : null) },
    ], recon), { note: 'The chain\'s balance at the last complete sync against what the ledger derives for the wallet\'s account. A difference stays here until the records explain it; the ledger is never adjusted to match.' }) : null,
    tracked.length ? card(`Recent activity${o.activity_total > o.activity.length ? ` (latest ${o.activity.length} of ${o.activity_total})` : ''}`, activity, { note: 'Each transfer Alchemy reported and each network fee from a receipt, with what happened to it in the ledger.' }) : null,
    card('Add wallet', addWalletForm(ctx, o), { note: 'Read-only: the desk follows a public address. It never asks for a private key, a seed phrase, a signature or an approval.' }),
    tracked.length ? details(`Sync settings · ${o.settings.interval_words}`, settingsForm(ctx, o), { id: 'wallet-settings' }) : null,
    tracked.length ? details('Technical details', technicalDetails(o), { id: 'wallet-tech' }) : null);
}
