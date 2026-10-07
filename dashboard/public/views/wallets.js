// Tracked wallets in the Portfolio: what the chain shows (observed
// balances), what the ledger records (and from where), and what differs.
// Read-only: public addresses only; nothing here signs, approves or moves
// anything. Drawing this page never syncs: Sync now asks the desk's own queue.
import {
  h, card, table, stateText, fmtUsd, fmtDate, fmtDateTime, fmtAgo, fmtAsOf, callout, empty, link, field, fieldError, input, select,
  button, action, details, submissionId, openDialog, logo, kv, chip,
} from '../ui.js';

const MINUS = '−';

// An exact decimal string for reading: grouped, four decimals (or four
// significant ones below 1), "…" where more digits follow. The exact value is
// the tooltip and the accessible name.
export function fmtQty(s) {
  if (s === null || s === undefined || s === '') return '—';
  const str = String(s);
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace(/^-/, '').split('.');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const keep = i !== '0' ? 4 : Math.min(f.length, (f.match(/^0*/)[0].length) + 4);
  const shown = f.slice(0, keep).replace(/0+$/, '');
  const more = /[1-9]/.test(f.slice(keep));
  return `${neg ? MINUS : ''}${int}${shown ? `.${shown}` : ''}${more ? '…' : ''}`;
}

function qty(s, symbol = null) {
  const exact = `${s}${symbol ? ` ${symbol}` : ''}`;
  return h('span', { class: 'num', title: `Exact: ${exact}`, 'aria-label': exact }, fmtQty(s));
}

const NET_TONE = { ok: 'ok', resuming: 'work', first_read: 'work', stale: 'warn', failing: 'warn', unavailable: 'bad', never: 'wait', paused: '', held: '', off: '', removed: '' };

// One network's sync state in words, with the age of the last complete view.
export function networkStatusText(n) {
  const age = n.last_success_at ? fmtAgo(n.last_success_at) : null;
  if (n.state === 'ok') return `Synced ${age}`;
  if (n.state === 'stale') return `Stale · last complete sync ${age}`;
  if (n.state === 'failing') return `Last sync failed · showing the view from ${age}`;
  if (n.state === 'resuming') return `Reading new activity · last complete sync ${age}`;
  return n.words || 'Unknown';
}

function networkStatus(n) {
  return stateText(networkStatusText(n), NET_TONE[n.state] || '');
}

const RECON = {
  matches: null,
  explained: ['Ledger catching up', 'info', 'Activity the ledger does not have yet (waiting for confirmations, held or unresolved) accounts for the difference.'],
  awaiting_decision: ['Waiting for your decision', 'warn', 'A held transaction may duplicate one you recorded yourself; decide it under Wallets.'],
  mismatch: ['Differs from your ledger', 'bad', 'Nothing on record explains the difference. It stays visible until it is reconciled; nothing is adjusted for you.'],
  incomplete: ['Not every network read yet', 'info', 'A tracked network has no complete view yet.'],
  not_in_ledger: ['Not in your ledger', 'info', 'No verified identity names this token, so the ledger cannot hold it. It is shown as the chain reports it.'],
};

function reconChip(r) {
  const x = RECON[r && r.status];
  if (!x) return null;
  return h('span', { class: `chip ${x[1]}`, title: x[2] }, x[0]);
}

function acquisitionText(a) {
  if (a && a.status === 'known') return h('span', { title: a.all_networks ? 'Recorded cost of this asset in the wallet, all its networks together' : 'Recorded cost' }, `Cost ${fmtUsd(a.cost_usd)}${a.all_networks ? ' (all networks)' : ''}`);
  if (a && a.status === 'partial') return h('span', { title: 'Some units have no recorded cost' }, `Cost ${fmtUsd(a.cost_usd)} + units of unknown cost`);
  return h('span', { class: 'unknown', title: 'No purchase price is on record for these units. Nothing is estimated.' }, 'Acquisition cost unknown');
}

function priceCell(r) {
  if (r.value_usd !== null) return h('span', { class: 'num', title: r.price.as_of ? `Price ${fmtUsd(r.price.usd)} as of ${fmtAsOf(r.price.as_of)}${r.price.status === 'stale' ? ' (stale)' : ''}` : null }, fmtUsd(r.value_usd), r.price.status === 'stale' ? h('span', { class: 'note-line warn-text' }, 'Price stale') : null);
  const why = !r.verified ? 'No verified identity names this token, so the desk has no price for it.' : 'No usable price from the market data right now.';
  return h('span', { class: 'unknown', title: why }, 'Price unavailable');
}

function holdingRow(r, { showWallet }) {
  const lg = logo({ symbol: r.symbol || '?', name: r.name || '', project_id: r.asset_id || r.contract || r.key, market: { logo_url: r.logo_url } }, { size: 24 });
  const title = r.name || r.symbol || 'Unnamed token';
  const name = r.project_id ? link(title, `#/watchlist?p=${encodeURIComponent(r.project_id)}`, { title: 'Open its research summary' }) : h('span', { title: r.verified ? null : 'Name as the token contract reports it (unverified)' }, title);
  const sub = [r.network_label, showWallet ? r.wallet_label : null, r.verified ? null : 'Unverified token', r.wallet_status === 'paused' ? 'Syncing paused' : null].filter(Boolean).join(' · ');
  return h('li', { class: 'wh-row', dataset: { key: `wh-${r.key}` } },
    lg,
    h('div', { class: 'wh-name' }, h('div', { class: 'wh-title' }, name, r.symbol && r.symbol !== title ? h('span', { class: 'wh-sym' }, r.symbol) : null), h('div', { class: 'wh-sub' }, sub)),
    h('div', { class: 'wh-fig' }, h('div', { class: 'wh-qty' }, qty(r.quantity, r.symbol)), h('div', { class: 'wh-val' }, priceCell(r))),
    h('div', { class: 'wh-foot' }, acquisitionText(r.acquisition), reconChip(r.reconciliation)));
}

function hiddenList(rows) {
  if (!rows.length) return null;
  return details(`Suspected spam and dust (${rows.length})`, h('ul', { class: 'wh-list wh-hidden' }, rows.map((r) => h('li', { class: 'wh-row', dataset: { key: `wh-${r.key}` } },
    logo({ symbol: r.reported.symbol || r.symbol || '?', project_id: r.contract || r.key, market: {} }, { size: 24 }),
    h('div', { class: 'wh-name' }, h('div', { class: 'wh-title' }, h('span', { title: 'Name as the token contract reports it (unverified)' }, r.name || r.reported.name || r.reported.symbol || 'Unnamed token')), h('div', { class: 'wh-sub' }, [r.network_label, r.hidden === 'spam' ? 'Suspected spam' : 'Dust'].join(' · '))),
    h('div', { class: 'wh-fig' }, h('div', { class: 'wh-qty' }, qty(r.quantity, r.reported.symbol)), h('div', { class: 'wh-val' }, priceCell(r))),
    h('div', { class: 'wh-foot' }, h('span', { class: 'small muted' }, r.hidden_reason), r.contract ? h('code', { class: 'mono small wrap-anywhere' }, r.contract) : null)))), { id: 'wallet-hidden' });
}

// The holdings view of every tracked wallet, for the top of Positions.
export function walletHoldingsCard(ctx, o) {
  const tracked = o.wallets.filter((w) => w.status !== 'removed');
  if (!tracked.length) return null;
  const showWallet = tracked.length > 1;
  const statusLines = tracked.map((w) => h('div', { class: 'wh-status' }, showWallet ? h('strong', null, `${w.label}:`) : null, w.networks.map((n) => h('span', { class: 'wh-net' }, `${n.label} `, networkStatus(n)))));
  const keyMissing = !o.provider.present;
  const s = o.summary;
  const actions = [];
  if (tracked.length === 1 && tracked[0].status === 'active' && !keyMissing) actions.push(syncButton(ctx, tracked[0]));
  actions.push(link('Wallets', '#/portfolio?tab=wallets', { class: 'btn small' }));
  return card('Wallet balances', [
    statusLines,
    keyMissing ? callout('Waiting for the Moralis key (MORALIS_API_KEY in Render > Environment). Nothing is read until it is set.', 'info') : null,
    o.holdings.length ? h('ul', { class: 'wh-list', 'aria-label': 'Wallet balances' }, o.holdings.map((r) => holdingRow(r, { showWallet }))) : empty(s.last_success_at ? 'No balance on the tracked networks.' : 'No complete balance read yet.'),
    o.holdings.length ? h('div', { class: 'wh-total' }, h('span', { class: 'muted' }, 'Observed value'), h('strong', { class: 'num' }, s.value_priced_usd === null ? '—' : fmtUsd(s.value_priced_usd)), h('span', { class: 'small muted' }, `${s.priced} priced${s.unpriced ? `, ${s.unpriced} without a price` : ''}`)) : null,
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
  if (l.status === 'skipped') return ['You said it is already recorded', ''];
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
  return h('span', { class: 'num nowrap', title: `Exact: ${e.amount} ${e.symbol || ''}`.trim() }, `${sign}${fmtQty(e.amount)} `, h('span', { class: e.verified ? null : 'faint' }, e.symbol || 'token'));
}

function decisionButtons(ctx, e) {
  const post = (decision) => ctx.api.post('/api/wallets/events/resolve', { wallet_id: e.wallet_id, network: e.network, event_key: e.event_key, decision });
  const rec = button('Record in ledger', null, { kind: 'small', key: `rec-${e.event_key}` });
  rec.onclick = action(rec, async () => { const r = await post('record'); await ctx.refresh(); return r; }, (r) => (r.ledger && r.ledger.recorded ? 'Recorded in the ledger' : 'Saved; it is recorded once it is final and mapped'));
  const skip = button('Already recorded', null, { kind: 'small', key: `skip-${e.event_key}` });
  skip.onclick = action(skip, async () => { const r = await post('skip'); await ctx.refresh(); return r; }, 'Kept out of the ledger. Your own entry stays as it is.');
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
  const rows = h('ul', { class: 'wh-list' }, w.networks.map((n) => h('li', { class: 'wl-net', dataset: { key: `wl-net-${w.wallet_id}-${n.network}` } },
    h('div', { class: 'wl-net-head' }, h('strong', null, n.label), networkStatus(n)),
    n.last_error && n.state !== 'ok' ? h('div', { class: 'small muted' }, n.last_error) : null,
    h('div', { class: 'small muted' }, [
      n.snapshot_at ? `Balances as of ${fmtAsOf(n.snapshot_at)}` : 'No complete balance read yet',
      `${n.events} event(s)`,
      n.counts.pending ? `${n.counts.pending} waiting for confirmations` : null,
      n.counts.decisions ? `${n.counts.decisions} need your decision` : null,
      n.counts.reversed ? `${n.counts.reversed} reversed` : null,
    ].filter(Boolean).join(' · ')))));
  const title = h('div', { class: 'wl-title' }, h('h2', null, w.label), h('code', { class: 'mono small', title: w.address }, w.address_short), w.status === 'removed' ? chip('Not tracked', '') : w.status === 'paused' ? chip('Paused', 'warn') : null);
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
    h('div', { class: 'field' }, go));
  for (const el of [label, address]) el.addEventListener('input', () => fieldError(el, null));
  const submit = action(go, async () => {
    const r = await ctx.api.post('/api/wallets', { label: label.value.trim(), address: address.value.trim(), networks: checkedNetworks(form, 'wallet-nets'), account_id: account.value || null, submission_id: sid });
    sid = submissionId();
    await ctx.refresh();
    return r;
  }, (r) => (r.status === 'exists' ? 'That address is already tracked.' : 'Wallet added. The first read starts within a minute once the Moralis key is set.'));
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!label.value.trim()) return fieldError(label, 'Give it a label.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address.value.trim())) return fieldError(address, 'A public address is 0x followed by 40 characters (0-9, a-f).');
    if (!checkedNetworks(form, 'wallet-nets').length) return fieldError(address, 'Choose at least one network below; nothing is scanned without one.');
    return submit();
  };
  return form;
}

function settingsForm(ctx, o) {
  const s = o.settings;
  const interval = input({ name: 'ws-interval', inputmode: 'numeric', value: String(s.interval_minutes) });
  const balances = input({ name: 'ws-balances', inputmode: 'numeric', value: String(s.balance_refresh_minutes) });
  const budget = input({ name: 'ws-budget', inputmode: 'numeric', value: s.daily_cu_budget === null ? '' : String(s.daily_cu_budget), placeholder: 'no cap' });
  const go = button('Save', null, { kind: 'small', type: 'submit' });
  const form = h('form', { class: 'form-grid' },
    field('Sync every (minutes)', interval, 'Each tracked network is read this often (5 to 1440).'),
    field('Balances every (minutes)', balances, 'Balances are also read whenever new activity appears.'),
    field('Daily compute-unit budget', budget, 'Moralis compute units per day (New York time); the sync stops at it. Empty means no cap.'),
    h('div', { class: 'field' }, go));
  form.onsubmit = action(go, async () => {
    const r = await ctx.api.post('/api/settings', { wallet_sync: { interval_minutes: interval.value.trim(), balance_refresh_minutes: balances.value.trim(), daily_cu_budget: budget.value.trim() === '' ? null : budget.value.trim() } });
    await ctx.refresh();
    return r;
  }, 'Saved.');
  return form;
}

function technicalDetails(o) {
  const s = o.sync;
  const lines = [
    ['Provider', `Moralis · key ${o.provider.present ? `present (${o.provider.source})` : 'missing'}`],
    ['Compute units today', `${s.calls.day_cu || 0}${s.daily_cu_budget ? ` of ${s.daily_cu_budget}` : ''} (${s.calls.day_count || 0} requests)`],
    ['This month', `${s.calls.month_cu || 0} compute units (${s.calls.month_count || 0} requests)`],
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
      { label: 'Last complete read', wrap: true, render: (n) => (n.last_pass ? `${n.last_pass.from ? fmtDateTime(n.last_pass.from) : 'whole history'} to ${fmtDateTime(n.last_pass.to)} · ${n.last_pass.pages} page(s), ${n.last_pass.items} item(s)${n.last_pass.malformed ? `, ${n.last_pass.malformed} unreadable` : ''}` : '—') },
      { label: 'In progress', render: (n) => (n.pass ? `${n.pass.pages} page(s) read` : '—') },
      { label: 'Block', render: (n) => n.block_number || '—' },
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
  const activity = table([
    { label: 'Date', nowrap: true, render: (e) => h('span', { title: fmtDateTime(e.at) }, fmtDate(e.at)) },
    { label: 'Network', render: (e) => e.network_label },
    { label: 'What', render: (e) => (KIND_WORDS[e.classification] || (() => e.classification))(e, names) },
    { label: 'Amount', num: true, render: amountCell },
    { label: 'Status', wrap: true, render: (e) => { const [t, tone] = eventStatus(e); const why = eventReason(e); return h('div', null, stateText(t, tone), why ? h('div', { class: 'small muted' }, why) : null); } },
    { label: 'Transaction', render: (e) => link(`${e.tx_hash.slice(0, 10)}…`, e.explorer_url, { class: 'mono small', title: e.tx_hash }) },
  ], o.activity, { empty: 'No activity read yet.', rowClass: (e) => (e.state === 'reverted' ? 'faint' : null) });
  return h('div', null,
    held.length ? card(`Waiting for your decision (${held.length})`, h('ul', { class: 'wh-list' }, held.map((e) => h('li', { class: 'wl-decide', dataset: { key: `wl-decide-${e.event_key}` } },
      h('div', { class: 'wl-net-head' }, h('strong', null, (KIND_WORDS[e.classification] || (() => e.classification))(e, names)), amountCell(e)),
      h('div', { class: 'small muted' }, `${e.wallet_label} · ${e.network_label} · ${fmtDate(e.at)}`),
      h('div', { class: 'small' }, e.ledger.hold.reason),
      decisionButtons(ctx, e)))), { note: 'Record it, or say it is already in your own records. Nothing is recorded over your entries without you.' }) : null,
    tracked.length || o.wallets.length ? o.wallets.map((w) => walletCard(ctx, w, o)) : empty('No wallet tracked yet. Add one below: a label, its public address and the networks to follow.'),
    recon.length ? card('Reconciliation', table([
      { label: 'Asset', render: (r) => h('div', null, r.asset_id, h('div', { class: 'small muted' }, `${r.wallet_label} · ${r.account_id}`)) },
      { label: 'On chain', num: true, render: (r) => qty(r.observed) },
      { label: 'In your ledger', num: true, render: (r) => qty(r.recorded) },
      { label: 'Difference', num: true, render: (r) => qty(r.difference) },
      { label: 'Status', wrap: true, render: (r) => h('div', null, reconChip(r), r.since ? h('div', { class: 'small muted' }, `since ${fmtDateTime(r.since)}`) : null, r.unrecorded_events ? h('div', { class: 'small muted' }, `${r.unrecorded_events} chain event(s) not in the ledger`) : null) },
    ], recon), { note: 'The chain\'s balance at the last complete sync against what the ledger derives for the wallet\'s account. A difference stays here until the records explain it; the ledger is never adjusted to match.' }) : null,
    tracked.length ? card(`Recent activity${o.activity_total > o.activity.length ? ` (latest ${o.activity.length} of ${o.activity_total})` : ''}`, activity, { note: 'Each transfer, swap leg and network fee the provider reported, with what happened to it in the ledger.' }) : null,
    card('Add wallet', addWalletForm(ctx, o), { note: 'Read-only: the desk follows a public address. It never asks for a private key, a seed phrase, a signature or an approval.' }),
    tracked.length ? details('Sync settings', settingsForm(ctx, o), { id: 'wallet-settings' }) : null,
    tracked.length ? details('Technical details', technicalDetails(o), { id: 'wallet-tech' }) : null);
}
