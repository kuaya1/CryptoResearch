'use strict';
// Tracked wallets: public addresses Eric chose to follow, read-only. What the
// provider reports about them (events, balance snapshots, the original items)
// and how that reaches the portfolio ledger.
//
// Records (portfolio/wallets/, kept in backups, packages and offsite copies):
//   registry.json                         the wallets: label, public address,
//                                         networks, status, linked ledger account
//   <wallet>/<network>/events.json        one event per transfer leg or fee, with
//                                         its chain references, classification,
//                                         chain state and ledger link
//   <wallet>/<network>/raw/<YYYY-MM>.json the provider's original items, by
//                                         transaction hash, every version kept
//   <wallet>/<network>/balances.json      the last complete balance snapshot and
//                                         a few before it
//   sync-state.json                       progress and status (walletsync.js)
//
// Authority: the ledger (portfolio/transactions.json) stays the only record of
// holdings and cost. Events are evidence; a ledger entry is made from an event
// only when it is final, successful, supported by the ledger's own types and
// mapped to a verified asset (a project identity's chain and contract, or the
// network's native coin). Everything else stays visible here, unrecorded:
//   - a first balance snapshot is an observation, never a purchase;
//   - bridges, staking, liquidity, lending, mints, burns, NFTs, multi-leg
//     swaps and unknown categories stay unresolved;
//   - spam, failed transfers and transfers to yourself are never recorded;
//   - an account with transactions Eric recorded himself for the same asset
//     holds the import for his decision (record, or "already recorded");
//   - an event a later complete re-read no longer reports (a reorganization)
//     is marked reversed, and a ledger entry made from it is voided with the
//     reason, never deleted.
// Reconciliation compares what the chain shows with what the ledger derives
// and is computed on every read; a difference stays visible until the records
// explain it. Nothing here changes a recorded price, cost or manual entry.
//
// Assets are identified by network and contract address (native coins by the
// network), never by ticker. Token names and symbols come from the token's own
// contract via the provider: untrusted text, cleaned and never used to match.
// Quantities are integer strings with their decimals, converted exactly.
// Research never starts from anything here, and no holding comes from research.

const D = require('./decimal');
const { runOp, OpError } = require('./ops');
const { readJson, sha256, listDir } = require('./fsx');
const { randomId, slugify, compactTs } = require('./ids');
const { chainInfo } = require('./chains');
const portfolio = require('./portfolio');

const DIR = 'portfolio/wallets';
const REGISTRY_REL = `${DIR}/registry.json`;
const SOURCE = 'wallet_sync';
const NAMESPACE = 'wallet-sync';
const WALLET_ID_RE = /^w_[a-z2-9]{10}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_PREVIOUS_SNAPSHOTS = 10;

// The networks the desk can follow, each with its Moralis name, the chain ID
// chains.js uses for project identities, its native coin (as the desk's
// reference asset, priced from CoinGecko), how long a block takes to count as
// final here, and its block explorer (for links built from a transaction hash).
const ETH = { asset_id: 'ethereum', symbol: 'ETH', name: 'Ether', coingecko_id: 'ethereum' };
const NETWORKS = {
  eth: { label: 'Ethereum', moralis: 'eth', chain_id: '1', native: ETH, confirm_minutes: 15, explorer: 'https://etherscan.io' },
  base: { label: 'Base', moralis: 'base', chain_id: '8453', native: ETH, confirm_minutes: 30, explorer: 'https://basescan.org' },
  arbitrum: { label: 'Arbitrum One', moralis: 'arbitrum', chain_id: '42161', native: ETH, confirm_minutes: 30, explorer: 'https://arbiscan.io' },
  optimism: { label: 'Optimism', moralis: 'optimism', chain_id: '10', native: ETH, confirm_minutes: 30, explorer: 'https://optimistic.etherscan.io' },
  linea: { label: 'Linea', moralis: 'linea', chain_id: '59144', native: ETH, confirm_minutes: 30, explorer: 'https://lineascan.build' },
  polygon: { label: 'Polygon', moralis: 'polygon', chain_id: '137', native: { asset_id: 'polygon-ecosystem-token', symbol: 'POL', name: 'POL', coingecko_id: 'polygon-ecosystem-token' }, confirm_minutes: 30, explorer: 'https://polygonscan.com' },
  bsc: { label: 'BNB Smart Chain', moralis: 'bsc', chain_id: '56', native: { asset_id: 'binancecoin', symbol: 'BNB', name: 'BNB', coingecko_id: 'binancecoin' }, confirm_minutes: 15, explorer: 'https://bscscan.com' },
  avalanche: { label: 'Avalanche C-Chain', moralis: 'avalanche', chain_id: '43114', native: { asset_id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche', coingecko_id: 'avalanche-2' }, confirm_minutes: 10, explorer: 'https://snowtrace.io' },
};

// Moralis categories that move value without anything else happening.
const TRANSFER_CATEGORIES = new Set(['send', 'receive', 'token send', 'token receive', 'airdrop']);
const SWAP_CATEGORY = 'token swap';
const CATEGORY_WORDS = {
  deposit: 'a deposit into a protocol (staking, lending, liquidity or a bridge)',
  withdraw: 'a withdrawal from a protocol (staking, lending, liquidity or a bridge)',
  borrow: 'a loan',
  mint: 'a token mint',
  burn: 'a token burn',
  'contract interaction': 'a contract interaction',
  approve: 'a token approval',
  revoke: 'a revoked approval',
  'nft send': 'NFT activity', 'nft receive': 'NFT activity', 'nft purchase': 'NFT activity', 'nft sale': 'NFT activity',
};
// Names that advertise something (a link, a claim) are a common way spam
// tokens reach a wallet. Used only to keep an unverified token out of the
// main list, never to match or record anything.
const SUSPICIOUS_NAME = /(https?:|www\.|t\.me|\.(com|io|net|org|xyz|app|site|top|vip|link|gift|live|club|pro)\b|claim|reward|visit|voucher|bonus|redeem|\$\s?\d)/i;

const isoOf = (ms) => new Date(ms).toISOString();
const shortHash = (parts) => sha256(JSON.stringify(parts)).slice(0, 12);

function cfgOf(ws) {
  return { ...require('./workspace').DEFAULT_SETTINGS.wallet_sync, ...((ws.settings && ws.settings.wallet_sync) || {}) };
}

function networkInfo(net) {
  return Object.prototype.hasOwnProperty.call(NETWORKS, net) ? NETWORKS[net] : null;
}

// ---------------------------------------------------------------------------
// Exact decimals of any precision (token amounts can have more than the
// ledger's 18 places). Strings in, strings out; BigInt inside.

function unitsToDecimal(raw, decimals) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0) return null;
  const s = raw.replace(/^0+(?=\d)/, '');
  if (!decimals) return s;
  const padded = s.padStart(decimals + 1, '0');
  const int = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

function bigOf(s) {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(s));
  if (!m) throw new OpError('INVALID', `Not an exact decimal: ${String(s).slice(0, 40)}`);
  return { n: BigInt(`${m[1] || ''}${m[2]}${m[3] || ''}`), scale: (m[3] || '').length };
}

function align(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return [a.n * 10n ** BigInt(scale - a.scale), b.n * 10n ** BigInt(scale - b.scale), scale];
}

function strOf(n, scale) {
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const int = abs.slice(0, abs.length - scale) || '0';
  const frac = scale ? abs.slice(abs.length - scale).replace(/0+$/, '') : '';
  return `${neg && (int !== '0' || frac) ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

function decAdd(a, b) {
  const [x, y, s] = align(bigOf(a), bigOf(b));
  return strOf(x + y, s);
}

function decSub(a, b) {
  const [x, y, s] = align(bigOf(a), bigOf(b));
  return strOf(x - y, s);
}

function decCmp(a, b) {
  const [x, y] = align(bigOf(a), bigOf(b));
  return x === y ? 0 : x < y ? -1 : 1;
}

const decZero = (a) => bigOf(a).n === 0n;
const fracDigits = (s) => (String(s).includes('.') ? String(s).split('.')[1].length : 0);

// ---------------------------------------------------------------------------
// Registry

function loadRegistry(ws) {
  const doc = readJson(ws.abs(REGISTRY_REL), null);
  return doc && Array.isArray(doc.wallets) ? doc : { schema_version: 'cr.wallets.v1', wallets: [] };
}

function listWallets(ws) {
  return loadRegistry(ws).wallets;
}

function walletById(ws, id) {
  if (!WALLET_ID_RE.test(String(id || ''))) throw new OpError('BAD_ID', 'Not a wallet ID');
  const w = listWallets(ws).find((x) => x.wallet_id === id);
  if (!w) throw new OpError('NOT_FOUND', `No tracked wallet ${id}`);
  return w;
}

// Every address Eric registered, removed ones included: a transfer between
// them is a move between his own accounts.
function ownAddressMap(reg) {
  const m = new Map();
  for (const w of reg.wallets) m.set(String(w.address).toLowerCase(), w);
  return m;
}

function shortAddress(a) {
  const s = String(a || '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

// The address as entered, refused when it is not a public EVM address. A
// private key, a seed phrase or a name is named for what it is.
function checkAddress(address) {
  const a = String(address || '').trim();
  if (portfolio.looksLikeSecret(a)) throw new OpError('REFUSED', 'That looks like a private key or a seed phrase. Never enter one anywhere. Only a public address (0x followed by 40 characters) is accepted.');
  if (/\.eth$/i.test(a)) throw new OpError('INVALID', 'Enter the 0x address itself; names such as .eth are not looked up.');
  if (!EVM_ADDRESS.test(a)) throw new OpError('INVALID', 'A public wallet address is 0x followed by 40 letters and digits (0-9, a-f).');
  if (/^0x0{40}$/i.test(a)) throw new OpError('INVALID', 'That is the zero address, not a wallet.');
  return a;
}

function checkNetworks(networks) {
  const list = [...new Set((Array.isArray(networks) ? networks : String(networks || '').split(',')).map((n) => String(n).trim().toLowerCase()).filter(Boolean))];
  if (!list.length) throw new OpError('INVALID', `Choose at least one network to track (${Object.keys(NETWORKS).join(', ')}). Nothing is scanned without one.`);
  const bad = list.filter((n) => !networkInfo(n));
  if (bad.length) throw new OpError('INVALID', `Not a network the desk can follow: ${bad.join(', ')}. Choose from ${Object.keys(NETWORKS).join(', ')}.`);
  return list;
}

function checkLabel(label) {
  const l = String(label || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!l) throw new OpError('INVALID', 'A wallet needs a label (for example MetaMask).');
  if (l.length > 60) throw new OpError('INVALID', 'Keep the label under 60 characters.');
  if (portfolio.looksLikeSecret(l)) throw new OpError('REFUSED', 'That label looks like a seed phrase or a key. Never store those here.');
  return l;
}

// The native coins of the networks: reference assets in portfolio/assets.json
// (added once, never changed), so their prices are fetched and the ledger can
// record fees and transfers in them.
function stageNativeAssets(op, ws, networks) {
  const registry = portfolio.assetRegistry(ws);
  const doc = op.readJson('portfolio/assets.json', { schema_version: 'cr.assets.v1', assets: [] });
  const added = [];
  for (const n of networks) {
    const nat = NETWORKS[n].native;
    if (registry.has(nat.asset_id) || doc.assets.some((a) => a.asset_id === nat.asset_id) || added.includes(nat.asset_id)) continue;
    doc.assets.push({ asset_id: nat.asset_id, symbol: nat.symbol, name: nat.name, coingecko_id: nat.coingecko_id, kind: 'token', decimals: 18, deployments: [], note: 'Native coin of a tracked wallet network.' });
    added.push(nat.asset_id);
  }
  if (added.length) op.writeJson('portfolio/assets.json', doc);
  return added;
}

// Adds a wallet to follow. Its ledger account is an existing account Eric
// names, or a new self-custody account with the wallet's label. Adding the
// same address again returns the wallet already there; a removed one is
// followed again (its history was kept).
function addWallet(ws, { label, address, networks, account_id = null } = {}) {
  const name = checkLabel(label);
  const addr = checkAddress(address);
  const nets = checkNetworks(networks);
  const now = new Date().toISOString();
  const out = runOp(ws, { type: 'wallet_add', summary: `Track wallet "${name}"` }, (op) => {
    const reg = op.readJson(REGISTRY_REL, { schema_version: 'cr.wallets.v1', wallets: [] });
    const same = reg.wallets.find((w) => w.address.toLowerCase() === addr.toLowerCase());
    if (same && same.status !== 'removed') return { status: 'exists', wallet_id: same.wallet_id, account_id: same.account_id };
    const accDoc = op.readJson('portfolio/accounts.json', { schema_version: 'cr.accounts.v1', accounts: [] });
    let acct = null;
    if (account_id) {
      acct = accDoc.accounts.find((a) => a.account_id === account_id);
      if (!acct) throw new OpError('INVALID', `No ledger account "${account_id}". Choose an existing account or leave it empty for a new one.`);
    } else if (same) {
      acct = accDoc.accounts.find((a) => a.account_id === same.account_id) || null;
    }
    if (!acct) {
      const base = slugify(name, 36) || 'wallet';
      let id = base;
      while (accDoc.accounts.some((a) => a.account_id === id)) id = `${base}-${randomId(4)}`;
      acct = { account_id: id, name, kind: 'self_custody', chain: null, public_address: addr, note: 'Tracked wallet (read-only).', created_at: now };
      accDoc.accounts.push(acct);
      op.writeJson('portfolio/accounts.json', accDoc);
    }
    stageNativeAssets(op, ws, nets);
    if (same) {
      Object.assign(same, { label: name, networks: nets, account_id: acct.account_id, status: 'active', updated_at: now, removed_at: null, removed_reason: null, paused_at: null });
      same.history = [...(same.history || []), { at: now, action: 'tracked_again', networks: nets }];
      op.writeJson(REGISTRY_REL, reg);
      return { status: 'saved', wallet_id: same.wallet_id, account_id: acct.account_id, again: true };
    }
    let id = `w_${randomId(10)}`;
    while (reg.wallets.some((w) => w.wallet_id === id)) id = `w_${randomId(10)}`;
    reg.wallets.push({ wallet_id: id, label: name, family: 'evm', address: addr, networks: nets, account_id: acct.account_id, provider: 'moralis', status: 'active', created_at: now, updated_at: now, paused_at: null, removed_at: null, removed_reason: null, history: [{ at: now, action: 'added', networks: nets }] });
    reg.schema_version = 'cr.wallets.v1';
    reg.note = 'Public addresses followed read-only. No key, seed phrase, signature or approval is ever stored or asked for.';
    op.writeJson(REGISTRY_REL, reg);
    return { status: 'saved', wallet_id: id, account_id: acct.account_id };
  });
  return { ...out.result, files: out.files, verified: out.verified };
}

function changeWallet(ws, id, type, summary, fn) {
  walletById(ws, id);
  const out = runOp(ws, { type, summary }, (op) => {
    const reg = op.readJson(REGISTRY_REL, null);
    const w = reg && reg.wallets.find((x) => x.wallet_id === id);
    if (!w) throw new OpError('NOT_FOUND', `No tracked wallet ${id}`);
    const r = fn(w, new Date().toISOString(), op);
    if (r && r.unchanged) return r;
    w.updated_at = new Date().toISOString();
    op.writeJson(REGISTRY_REL, reg);
    return r || { status: 'saved' };
  });
  return { ...out.result, wallet_id: id, files: out.files, verified: out.verified };
}

function pauseWallet(ws, id) {
  return changeWallet(ws, id, 'wallet_pause', `Pause wallet ${id}`, (w, now) => {
    if (w.status === 'removed') throw new OpError('CONFLICT', 'This wallet is no longer tracked; add it again to follow it.');
    if (w.status === 'paused') return { status: 'unchanged', unchanged: true };
    w.status = 'paused';
    w.paused_at = now;
    w.history = [...(w.history || []), { at: now, action: 'paused' }];
    return { status: 'saved' };
  });
}

function resumeWallet(ws, id) {
  return changeWallet(ws, id, 'wallet_resume', `Resume wallet ${id}`, (w, now) => {
    if (w.status === 'removed') throw new OpError('CONFLICT', 'This wallet is no longer tracked; add it again to follow it.');
    if (w.status === 'active') return { status: 'unchanged', unchanged: true };
    w.status = 'active';
    w.paused_at = null;
    w.history = [...(w.history || []), { at: now, action: 'resumed' }];
    return { status: 'saved' };
  });
}

// Stops following a wallet. Its events, snapshots, raw items and every ledger
// entry made from them stay exactly as they are.
function removeWallet(ws, id, reason = null) {
  return changeWallet(ws, id, 'wallet_remove', `Stop tracking wallet ${id}`, (w, now) => {
    if (w.status === 'removed') return { status: 'unchanged', unchanged: true };
    w.status = 'removed';
    w.removed_at = now;
    w.removed_reason = reason ? String(reason).slice(0, 300) : null;
    w.history = [...(w.history || []), { at: now, action: 'removed', reason: w.removed_reason }];
    return { status: 'saved' };
  });
}

function setWalletNetworks(ws, id, networks) {
  const nets = checkNetworks(networks);
  return changeWallet(ws, id, 'wallet_networks', `Networks of wallet ${id}`, (w, now, op) => {
    if (w.status === 'removed') throw new OpError('CONFLICT', 'This wallet is no longer tracked; add it again to follow it.');
    if (JSON.stringify([...w.networks].sort()) === JSON.stringify([...nets].sort())) return { status: 'unchanged', unchanged: true };
    stageNativeAssets(op, ws, nets);
    w.history = [...(w.history || []), { at: now, action: 'networks', from: w.networks, to: nets }];
    w.networks = nets;
    return { status: 'saved', networks: nets };
  });
}

// ---------------------------------------------------------------------------
// Store files

function storeDir(walletId, network) {
  if (!WALLET_ID_RE.test(walletId) || !networkInfo(network)) throw new OpError('BAD_ID', 'Not a wallet or network');
  return `${DIR}/${walletId}/${network}`;
}
const eventsRel = (w, n) => `${storeDir(w, n)}/events.json`;
const balancesRel = (w, n) => `${storeDir(w, n)}/balances.json`;
const rawRel = (w, n, month) => `${storeDir(w, n)}/raw/${month}.json`;

function loadEvents(ws, walletId, network) {
  const doc = readJson(ws.abs(eventsRel(walletId, network)), null);
  return doc && Array.isArray(doc.events) ? doc.events : [];
}

function loadBalances(ws, walletId, network) {
  return readJson(ws.abs(balancesRel(walletId, network)), null);
}

function rawMonths(ws, walletId, network) {
  return listDir(ws.abs(`${storeDir(walletId, network)}/raw`), { dirs: false }).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
}

// ---------------------------------------------------------------------------
// From a provider transaction to events (pure, for the tests)

// The legs of one transaction that touch this wallet, in this wallet's view,
// with the transaction's classification. tx: moralis.normalizeHistoryItem.
function eventsFromTx(tx, { walletId, address, network, own = new Map() }) {
  const me = String(address).toLowerCase();
  const legs = [];
  const seen = new Map();
  const occurrence = (parts) => {
    const k = JSON.stringify(parts);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n;
  };
  const counterparty = (from, to, dir) => (dir === 'out' ? to : dir === 'in' ? from : me);
  for (const t of tx.tokens || []) {
    if (t.from !== me && t.to !== me) continue;
    const dir = t.from === me && t.to === me ? 'self' : t.from === me ? 'out' : 'in';
    const key = t.log_index !== null && t.log_index !== undefined ? `log:${t.log_index}` : `tok:${shortHash([t.contract, t.from, t.to, t.value_raw, occurrence([t.contract, t.from, t.to, t.value_raw])])}`;
    const incomplete = !t.contract || t.value_raw === null || t.decimals === null;
    legs.push({ kind: 'erc20', key, direction: dir, log_index: t.log_index, asset: { native: false, contract: t.contract, decimals: t.decimals, symbol: t.symbol, name: t.name, verified_contract: t.verified_contract }, amount_raw: t.value_raw, amount: incomplete ? null : unitsToDecimal(t.value_raw, t.decimals), from: t.from, to: t.to, counterparty: counterparty(t.from, t.to, dir), suspected_spam: Boolean(t.possible_spam || tx.possible_spam || SUSPICIOUS_NAME.test(`${t.name || ''} ${t.symbol || ''}`)), incomplete });
  }
  for (const n of tx.native || []) {
    if (n.from !== me && n.to !== me) continue;
    if (n.value_raw === '0') continue;
    const dir = n.from === me && n.to === me ? 'self' : n.from === me ? 'out' : 'in';
    const parts = [n.internal ? 'i' : 'x', n.from, n.to, n.value_raw];
    legs.push({ kind: 'native', key: `native:${shortHash([...parts, occurrence(parts)])}`, direction: dir, log_index: null, internal: Boolean(n.internal), asset: { native: true, contract: null, decimals: 18, symbol: NETWORKS[network].native.symbol, name: NETWORKS[network].native.name, verified_contract: null }, amount_raw: n.value_raw, amount: n.value_raw === null ? null : unitsToDecimal(n.value_raw, 18), from: n.from, to: n.to, counterparty: counterparty(n.from, n.to, dir), suspected_spam: false, incomplete: n.value_raw === null });
  }
  const category = (tx.category || '').toLowerCase();
  const failed = tx.receipt_status === '0';
  // Classification of the value legs, in this wallet's view.
  const value = legs.filter((l) => l.direction !== 'self');
  let cls = null;
  let reason = null;
  if (failed) {
    cls = 'failed_transfer';
    reason = 'The transaction failed on chain: nothing moved except the network fee.';
  } else if (value.some((l) => l.incomplete)) {
    cls = 'unresolved';
    reason = 'The provider did not report every amount, token or decimals of this transaction.';
  } else if (TRANSFER_CATEGORIES.has(category)) {
    const dirs = new Set(value.map((l) => l.direction));
    if (dirs.size > 1) {
      cls = 'unresolved';
      reason = 'Value went both out and in under a plain transfer; not recorded automatically.';
    } else cls = 'transfer';
  } else if (category === SWAP_CATEGORY) {
    const net = new Map();
    for (const l of value) {
      const k = l.asset.native ? 'native' : l.asset.contract;
      const cur = net.get(k) || { out: '0', in: '0' };
      cur[l.direction] = decAdd(cur[l.direction], l.amount);
      net.set(k, cur);
    }
    const outs = [...net.entries()].filter(([, v]) => !decZero(v.out) && decZero(v.in));
    const ins = [...net.entries()].filter(([, v]) => !decZero(v.in) && decZero(v.out));
    const mixed = [...net.entries()].filter(([, v]) => !decZero(v.in) && !decZero(v.out));
    if (outs.length === 1 && ins.length === 1 && !mixed.length) cls = 'swap';
    else {
      cls = 'unresolved';
      reason = 'A swap with more than one token on a side (or a token both sent and received); not recorded automatically.';
    }
  } else {
    cls = 'unresolved';
    reason = category ? `The provider describes this as ${CATEGORY_WORDS[category] || `"${category}"`}; not recorded automatically.` : 'The provider gave no category for this transaction; not recorded automatically.';
  }
  const events = legs.map((l) => {
    let classification;
    let why = null;
    if (l.direction === 'self') {
      classification = 'self_transfer';
      why = 'Sent from this wallet to itself: no change.';
    } else if (cls === 'transfer') {
      const other = own.get(l.counterparty);
      classification = other && other.wallet_id !== walletId ? 'internal_transfer' : l.direction === 'in' ? 'incoming_transfer' : 'outgoing_transfer';
    } else {
      classification = cls;
      why = reason;
    }
    const other = own.get(l.counterparty);
    return {
      event_key: `${network}:${tx.hash}:${l.key}`,
      wallet_id: walletId,
      network,
      tx_hash: tx.hash,
      block_number: tx.block_number,
      block_hash: tx.block_hash,
      block_timestamp: tx.block_timestamp,
      log_index: l.log_index,
      kind: l.kind,
      internal: l.internal || false,
      direction: l.direction,
      asset: l.asset,
      amount_raw: l.amount_raw,
      amount: l.amount,
      from: l.from,
      to: l.to,
      counterparty_wallet_id: other && other.wallet_id !== walletId ? other.wallet_id : null,
      category: tx.category,
      summary: tx.summary,
      receipt_status: tx.receipt_status,
      classification,
      reason: why,
      suspected_spam: l.suspected_spam,
    };
  });
  if (tx.from === me) {
    const fee = tx.fee || {};
    const amount = fee.amount ? fee.amount : fee.amount_raw ? unitsToDecimal(fee.amount_raw, 18) : null;
    if (amount === null || !decZero(amount)) {
      events.push({
        event_key: `${network}:${tx.hash}:fee`,
        wallet_id: walletId,
        network,
        tx_hash: tx.hash,
        block_number: tx.block_number,
        block_hash: tx.block_hash,
        block_timestamp: tx.block_timestamp,
        log_index: null,
        kind: 'fee',
        internal: false,
        direction: 'out',
        asset: { native: true, contract: null, decimals: 18, symbol: NETWORKS[network].native.symbol, name: NETWORKS[network].native.name, verified_contract: null },
        amount_raw: fee.amount_raw || null,
        amount,
        fee_basis: fee.basis || null,
        from: me,
        to: null,
        counterparty_wallet_id: null,
        category: tx.category,
        summary: tx.summary,
        receipt_status: tx.receipt_status,
        classification: amount === null ? 'unresolved' : 'gas_fee',
        reason: amount === null ? 'The provider did not report the network fee.' : null,
        suspected_spam: false,
      });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Writing what a sync read

function newEventsDoc(walletId, network) {
  return { schema_version: 'cr.wallet-events.v1', wallet_id: walletId, network, events: [] };
}

// Merges one fresh event into the stored list. Returns what changed.
function mergeEvent(list, byKey, fresh, { passId, now }) {
  const at = isoOf(now);
  const cur = byKey.get(fresh.event_key);
  if (!cur) {
    const e = { ...fresh, state: 'pending', ledger: { status: 'waiting', tx_ids: [], revision: 0 }, first_seen_at: at, last_seen_at: at, last_seen_pass: passId, history: [{ at, change: 'seen' }] };
    list.push(e);
    byKey.set(e.event_key, e);
    return 'new';
  }
  let change = null;
  if (cur.state === 'reverted') {
    cur.state = 'pending';
    cur.history.push({ at, change: 'reported again after being reversed' });
    if (cur.ledger.status === 'voided' || cur.ledger.status === 'not_recorded') cur.ledger = { ...cur.ledger, status: 'waiting', reason: null, hold: null };
    change = 'returned';
  }
  if (cur.block_hash !== fresh.block_hash || cur.block_number !== fresh.block_number) {
    cur.history.push({ at, change: `block changed from ${cur.block_number} to ${fresh.block_number} (reorganization)` });
    cur.block_hash = fresh.block_hash;
    cur.block_number = fresh.block_number;
    cur.block_timestamp = fresh.block_timestamp;
    if (cur.state === 'final') cur.state = 'pending';
    change = change || 'moved';
  }
  if (cur.amount_raw !== fresh.amount_raw || (cur.asset.contract || null) !== (fresh.asset.contract || null) || cur.direction !== fresh.direction || cur.receipt_status !== fresh.receipt_status) {
    cur.history.push({ at, change: 'the provider now reports different content' });
    cur.content_changed = cur.ledger.status === 'recorded';
    for (const k of ['amount_raw', 'amount', 'asset', 'direction', 'from', 'to', 'receipt_status', 'counterparty_wallet_id']) cur[k] = fresh[k];
    if (cur.state === 'final') cur.state = 'pending';
    change = change || 'content';
  }
  // The classification follows the provider until the event is recorded.
  if (cur.ledger.status !== 'recorded' && (cur.classification !== fresh.classification || cur.reason !== fresh.reason || cur.suspected_spam !== fresh.suspected_spam || cur.counterparty_wallet_id !== fresh.counterparty_wallet_id)) {
    for (const k of ['classification', 'reason', 'suspected_spam', 'counterparty_wallet_id', 'category', 'summary']) cur[k] = fresh[k];
    if (cur.ledger.status === 'not_recorded' || (cur.ledger.status === 'held' && cur.ledger.hold && !cur.ledger.hold.needs_decision)) cur.ledger = { ...cur.ledger, status: 'waiting', reason: null, hold: null };
    change = change || 'classified';
  }
  if (cur.last_seen_pass !== passId) {
    cur.last_seen_pass = passId;
    cur.last_seen_at = at;
    change = change || 'seen';
  }
  return change;
}

// One page of history: its events merged into events.json and its original
// items added to the month's raw file (a new version only when an item
// changed). One verified save; nothing when nothing changed.
function storeHistoryPage(ws, wallet, network, items, { passId, now = Date.now(), own = null } = {}) {
  const ownMap = own || ownAddressMap(loadRegistry(ws));
  const at = isoOf(now);
  const out = runOp(ws, { type: 'wallet_history', summary: `Wallet activity read (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = eventsRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null) || newEventsDoc(wallet.wallet_id, network);
    const byKey = new Map(doc.events.map((e) => [e.event_key, e]));
    const counts = { new: 0, changed: 0, seen: 0, malformed: 0 };
    let eventsChanged = false;
    const raws = new Map();
    for (const { tx, item } of items) {
      if (!tx || tx.error) {
        counts.malformed++;
        continue;
      }
      const month = tx.block_timestamp.slice(0, 7);
      if (!raws.has(month)) raws.set(month, { doc: op.readJson(rawRel(wallet.wallet_id, network, month), null) || { schema_version: 'cr.wallet-raw.v1', provider: 'moralis', endpoint: 'GET /api/v2.2/wallets/{address}/history', wallet_id: wallet.wallet_id, network, month, items: {} }, changed: false });
      const raw = raws.get(month);
      const itemSha = sha256(JSON.stringify(item));
      const versions = raw.doc.items[tx.hash] || [];
      if (!versions.length || versions[versions.length - 1].item_sha256 !== itemSha) {
        raw.doc.items[tx.hash] = [...versions, { fetched_at: at, item_sha256: itemSha, item }];
        raw.changed = true;
      }
      for (const fresh of eventsFromTx(tx, { walletId: wallet.wallet_id, address: wallet.address, network, own: ownMap })) {
        fresh.raw = { file: `raw/${month}.json`, tx_hash: tx.hash, item_sha256: itemSha };
        const change = mergeEvent(doc.events, byKey, fresh, { passId, now });
        if (change === 'new') counts.new++;
        else if (change && change !== 'seen') counts.changed++;
        else if (change === 'seen') counts.seen++;
        if (change) eventsChanged = true;
      }
    }
    if (eventsChanged) {
      doc.events.sort((a, b) => String(a.block_timestamp).localeCompare(String(b.block_timestamp)) || String(a.event_key).localeCompare(String(b.event_key)));
      op.writeJson(rel, doc);
    }
    for (const [month, raw] of raws) if (raw.changed) op.writeJson(rawRel(wallet.wallet_id, network, month), raw.doc);
    return counts;
  });
  return out.result;
}

// After a complete read of a window [from, to]: an event in that window the
// provider no longer reports is reversed; an event reported in it that is old
// enough becomes final. Only a complete read decides either.
function finishPass(ws, wallet, network, { pass, now = Date.now(), confirmMinutes = null } = {}) {
  const confirmMs = (confirmMinutes === null ? NETWORKS[network].confirm_minutes : confirmMinutes) * 60000;
  const from = pass.from ? Date.parse(pass.from) : -Infinity;
  const to = Date.parse(pass.to);
  const at = isoOf(now);
  const out = runOp(ws, { type: 'wallet_confirm', summary: `Wallet activity confirmed (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = eventsRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null);
    const counts = { final: 0, reverted: 0 };
    if (!doc) return counts;
    let changed = false;
    for (const e of doc.events) {
      const t = Date.parse(e.block_timestamp);
      if (!(t >= from && t <= to)) continue;
      if (e.last_seen_pass !== pass.id) {
        if (e.state !== 'reverted') {
          e.state = 'reverted';
          e.history.push({ at, change: `not reported in a complete re-read of ${pass.from || 'the whole history'} to ${pass.to} (reversed)` });
          counts.reverted++;
          changed = true;
        }
        continue;
      }
      if (e.state === 'pending' && now - t >= confirmMs) {
        e.state = 'final';
        e.history.push({ at, change: 'final' });
        counts.final++;
        changed = true;
      }
    }
    if (changed) op.writeJson(rel, doc);
    return counts;
  });
  return out.result;
}

// A complete balance read: saved as the last complete snapshot when it differs
// from the one before (the earlier one moves to "previous"). A partial read is
// never saved as a snapshot.
function storeBalances(ws, wallet, network, rows, { now = Date.now(), block = null } = {}) {
  const at = isoOf(now);
  const tokens = rows.filter((r) => !r.error).map((r) => ({ ...r, balance: unitsToDecimal(r.balance_raw, r.decimals) })).sort((a, b) => Number(b.native) - Number(a.native) || String(a.contract).localeCompare(String(b.contract)));
  const contentSha = sha256(JSON.stringify(tokens.map((t) => [t.native, t.contract, t.decimals, t.balance_raw])));
  const out = runOp(ws, { type: 'wallet_balances', summary: `Wallet balances read (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = balancesRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null) || { schema_version: 'cr.wallet-balances.v1', wallet_id: wallet.wallet_id, network, last_complete: null, previous: [] };
    if (doc.last_complete && doc.last_complete.content_sha256 === contentSha) return { changed: false };
    if (doc.last_complete) doc.previous = [doc.last_complete, ...(doc.previous || [])].slice(0, MAX_PREVIOUS_SNAPSHOTS);
    doc.last_complete = { fetched_at: at, provider: 'moralis', endpoint: 'GET /api/v2.2/wallets/{address}/tokens', block_number: block, content_sha256: contentSha, unreadable_rows: rows.filter((r) => r.error).length, tokens };
    op.writeJson(rel, doc);
    return { changed: true };
  });
  return out.result;
}

// ---------------------------------------------------------------------------
// Which desk asset a wallet token is

// network:contract -> the verified assets that declare that deployment.
function assetIndex(registry) {
  const byDeployment = new Map();
  for (const a of registry.values()) {
    for (const d of a.deployments || []) {
      if (!d || typeof d.contract_address !== 'string' || !EVM_ADDRESS.test(d.contract_address.trim())) continue;
      const info = chainInfo(d.chain_id || d.chain);
      if (!info || info.family !== 'evm') continue;
      const key = `${info.chain_id}:${d.contract_address.trim().toLowerCase()}`;
      const list = byDeployment.get(key) || [];
      if (!list.some((x) => x.asset_id === a.asset_id)) list.push({ asset_id: a.asset_id, decimals: Number.isInteger(d.decimals) ? d.decimals : null });
      byDeployment.set(key, list);
    }
  }
  return byDeployment;
}

// { asset_id, asset } or { asset_id: null, reason }.
function mapAsset(ctx, network, asset) {
  const net = NETWORKS[network];
  if (asset.native) {
    const a = ctx.registry.get(net.native.asset_id);
    return a ? { asset_id: a.asset_id, asset: a } : { asset_id: null, reason: `${net.native.symbol} is not a reference asset yet` };
  }
  const hits = ctx.index.get(`${net.chain_id}:${String(asset.contract).toLowerCase()}`) || [];
  if (!hits.length) return { asset_id: null, reason: 'No verified identity names this token contract on this network' };
  if (hits.length > 1) return { asset_id: null, reason: `More than one verified identity names this contract (${hits.map((x) => x.asset_id).join(', ')})` };
  const a = ctx.registry.get(hits[0].asset_id);
  if (hits[0].decimals !== null && Number.isInteger(asset.decimals) && hits[0].decimals !== asset.decimals) return { asset_id: null, reason: `The identity declares ${hits[0].decimals} decimals; the chain reports ${asset.decimals}`, mismatch: true };
  return { asset_id: a.asset_id, asset: a };
}

function mapContext(ws) {
  const registry = portfolio.assetRegistry(ws);
  return { registry, index: assetIndex(registry) };
}

// ---------------------------------------------------------------------------
// Ledger import

// Accounts and assets Eric recorded transactions for himself (manual, CSV,
// dashboard, connector). A correction of a wallet entry still counts as the
// wallet's.
function manualIndex(txs) {
  const fromWallet = new Set(txs.filter((t) => t.source === SOURCE).map((t) => t.tx_id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of txs) {
      if (t.corrects && fromWallet.has(t.corrects) && !fromWallet.has(t.tx_id)) {
        fromWallet.add(t.tx_id);
        grew = true;
      }
    }
  }
  const keys = new Map();
  const list = [];
  for (const t of txs) {
    if (t.voided || fromWallet.has(t.tx_id)) continue;
    list.push(t);
    for (const asset of [t.asset_id, t.fee && t.fee.asset_id !== 'usd' ? t.fee.asset_id : null]) {
      if (!asset) continue;
      const k = `${t.account_id}|${asset}`;
      keys.set(k, [...(keys.get(k) || []), t.tx_id]);
    }
  }
  return { keys, list };
}

const externalId = (e, role) => `${e.event_key}:${role}${e.ledger && e.ledger.revision ? `:r${e.ledger.revision + 1}` : ''}`;
const netLabel = (n) => (NETWORKS[n] ? NETWORKS[n].label : n);
const txRef = (e) => `${e.tx_hash.slice(0, 10)}…`;

// The ledger entries one unit (a transfer leg, a swap, a fee) would make, or
// why it cannot make them yet. Pure apart from the context it is given.
function entriesFor(unit, ctx) {
  const { wallet, network } = unit;
  const first = unit.events[0];
  const date = first.block_timestamp;
  const base = { date, chain: network, price_usd: null, source_namespace: NAMESPACE };
  const mapped = [];
  for (const e of unit.events) {
    const m = mapAsset(ctx.map, network, e.asset);
    if (!m.asset_id) return { hold: { code: m.mismatch ? 'decimals_mismatch' : 'unmapped_asset', needs_decision: false, reason: `${e.asset.native ? e.asset.symbol : e.asset.symbol || 'Token'}: ${m.reason}.` } };
    if (e.amount === null) return { hold: { code: 'incomplete', needs_decision: false, reason: 'The amount is not known exactly.' } };
    const dec = Math.min(18, Number.isInteger(m.asset.decimals) ? m.asset.decimals : 18);
    if (fracDigits(e.amount) > dec) return { hold: { code: 'precision', needs_decision: false, reason: `${e.amount} has more decimal places than the ledger keeps for ${m.asset_id} (${dec}).` } };
    mapped.push({ e, asset_id: m.asset_id });
  }
  const acct = wallet.account_id;
  const entries = [];
  if (unit.kind === 'fee') {
    const { e, asset_id } = mapped[0];
    entries.push({ ...base, type: 'fee', account_id: acct, asset_id, quantity: e.amount, external_id: externalId(e, 'fee'), note: `Network fee on ${netLabel(network)} (tx ${txRef(e)})`, _event: e });
  } else if (unit.kind === 'swap') {
    const out = mapped.filter((x) => x.e.direction === 'out');
    const inn = mapped.filter((x) => x.e.direction === 'in');
    const sum = (list) => list.reduce((s, x) => decAdd(s, x.e.amount), '0');
    entries.push({ ...base, type: 'sell', account_id: acct, asset_id: out[0].asset_id, quantity: sum(out), external_id: externalId(out[0].e, 'sell'), note: `Swap on ${netLabel(network)} (tx ${txRef(first)}): sold for ${inn[0].e.asset.symbol || inn[0].asset_id}; price unknown`, _event: out[0].e });
    entries.push({ ...base, type: 'buy', account_id: acct, asset_id: inn[0].asset_id, quantity: sum(inn), external_id: externalId(inn[0].e, 'buy'), note: `Swap on ${netLabel(network)} (tx ${txRef(first)}): bought with ${out[0].e.asset.symbol || out[0].asset_id}; price unknown`, _event: inn[0].e });
  } else {
    const { e, asset_id } = mapped[0];
    if (e.classification === 'internal_transfer') {
      const other = ctx.wallets.get(e.counterparty_wallet_id);
      if (!other) return { hold: { code: 'invalid', needs_decision: false, reason: 'The other tracked wallet is not in the registry.' } };
      const sender = e.direction === 'out' ? wallet : other;
      const receiver = e.direction === 'in' ? wallet : other;
      const transferId = `wt-${network}-${e.tx_hash.slice(2, 14)}-${shortHash([e.event_key]).slice(0, 8)}`;
      entries.push({ ...base, type: 'transfer_out', account_id: sender.account_id, asset_id, quantity: e.amount, transfer_id: transferId, external_id: externalId(e, 'out'), note: `To your wallet ${receiver.label} on ${netLabel(network)} (tx ${txRef(e)})`, _event: e });
      entries.push({ ...base, type: 'transfer_in', account_id: receiver.account_id, asset_id, quantity: e.amount, transfer_id: transferId, external_id: externalId(e, 'in'), note: `From your wallet ${sender.label} on ${netLabel(network)} (tx ${txRef(e)})`, _event: e });
    } else if (e.direction === 'in') {
      entries.push({ ...base, type: 'transfer_in', account_id: acct, asset_id, quantity: e.amount, external_id: externalId(e, 'in'), note: `Received on ${netLabel(network)} (tx ${txRef(e)}); cost unknown`, _event: e });
    } else {
      entries.push({ ...base, type: 'transfer_out', account_id: acct, asset_id, quantity: e.amount, external_id: externalId(e, 'out'), note: `Sent on ${netLabel(network)} (tx ${txRef(e)})`, _event: e });
    }
  }
  return { entries };
}

// The units of one wallet view's final, undecided events: each transfer leg
// and each fee on its own, a swap as one.
function unitsOf(events, wallet, network) {
  const units = [];
  const byTx = new Map();
  for (const e of events) {
    if (!byTx.has(e.tx_hash)) byTx.set(e.tx_hash, []);
    byTx.get(e.tx_hash).push(e);
  }
  for (const list of byTx.values()) {
    const swap = list.filter((e) => e.classification === 'swap');
    if (swap.length) units.push({ kind: 'swap', wallet, network, events: swap });
    for (const e of list) {
      if (e.classification === 'swap') continue;
      units.push({ kind: e.kind === 'fee' ? 'fee' : 'transfer', wallet, network, events: [e] });
    }
  }
  return units;
}

// Why a unit is not recorded at all (never will be, as classified).
function notRecordedReason(unit, ctx) {
  const e = unit.events[0];
  if (unit.events.some((x) => x.suspected_spam) && unit.events.some((x) => !x.asset.native && !mapAsset(ctx.map, unit.network, x.asset).asset_id)) return { code: 'spam', reason: 'Suspected spam token (no verified identity).' };
  if (e.classification === 'failed_transfer') return { code: 'failed', reason: e.reason };
  if (e.classification === 'self_transfer') return { code: 'self', reason: e.reason };
  if (e.classification === 'unresolved') return { code: 'unresolved', reason: e.reason };
  return null;
}

// Records final, supported, mapped events in the ledger, holds the rest with
// the reason, and voids ledger entries whose event was reversed. One verified
// save for everything (or nothing when nothing changed).
function importReady(ws, { now = Date.now() } = {}) {
  const reg = loadRegistry(ws);
  if (!reg.wallets.length) return { status: 'noop', recorded: 0, held: 0, voided: 0, not_recorded: 0 };
  const map = mapContext(ws);
  const accountIds = new Set(portfolio.loadAccounts(ws).map((a) => a.account_id));
  const wallets = new Map(reg.wallets.map((w) => [w.wallet_id, w]));
  const at = isoOf(now);
  const out = runOp(ws, { type: 'wallet_import', summary: 'Record final wallet activity in the ledger' }, (op) => {
    const ledger = op.readJson('portfolio/transactions.json', { schema_version: 'cr.transactions.v2', accounting_method: 'fifo_per_account', transactions: [] });
    const txs = ledger.transactions;
    const byExternal = new Map(txs.filter((t) => t.external_id && t.source_namespace === NAMESPACE).map((t) => [t.external_id, t]));
    const counts = { recorded: 0, held: 0, voided: 0, not_recorded: 0, already: 0 };
    let ledgerChanged = false;
    const ctx = { map, wallets };
    // Only wallet entries are added below, so Eric's own records stay as read.
    const manual = manualIndex(txs);
    for (const w of reg.wallets) {
      if (w.status !== 'active') continue;
      for (const network of w.networks) {
        if (!networkInfo(network)) continue;
        const rel = eventsRel(w.wallet_id, network);
        const doc = op.readJson(rel, null);
        if (!doc || !doc.events.length) continue;
        let changed = false;
        // Reversed or changed after being recorded: void the entries (kept, with the reason).
        for (const e of doc.events) {
          if (e.ledger.status !== 'recorded' || !(e.state === 'reverted' || e.content_changed)) continue;
          const why = e.state === 'reverted' ? 'the provider no longer reports this transaction (chain reorganization)' : 'the provider now reports different content for this transaction';
          for (const id of e.ledger.tx_ids || []) {
            const t = txs.find((x) => x.tx_id === id);
            if (t && !t.voided) {
              t.voided = true;
              t.void_reason = `Wallet sync: ${why} (${netLabel(network)} tx ${e.tx_hash})`;
              t.voided_at = at;
              ledgerChanged = true;
            }
          }
          e.ledger = { status: e.state === 'reverted' ? 'voided' : 'waiting', tx_ids: [], voided_tx_ids: e.ledger.tx_ids, revision: (e.ledger.revision || 0) + 1, at };
          e.content_changed = false;
          e.history.push({ at, change: 'ledger entries voided' });
          counts.voided++;
          changed = true;
        }
        const ready = doc.events.filter((e) => e.state === 'final' && (e.ledger.status === 'waiting' || e.ledger.status === 'held'));
        for (const unit of unitsOf(ready, w, network)) {
          // A unit whose status and reason are unchanged is not rewritten.
          const mark = (status, extra = {}) => {
            for (const e of unit.events) {
              const next = { ...e.ledger, status, ...extra };
              if (JSON.stringify({ ...next, at: null }) === JSON.stringify({ ...e.ledger, at: null })) continue;
              e.ledger = { ...next, at };
              changed = true;
            }
          };
          const decision = unit.events[0].ledger.decision || null;
          if (decision && decision.choice === 'skip') {
            mark('skipped', { hold: null, reason: 'You said this is already recorded.' });
            continue;
          }
          const nr = notRecordedReason(unit, ctx);
          if (nr) {
            mark('not_recorded', { hold: null, reason: nr.reason, code: nr.code });
            counts.not_recorded++;
            continue;
          }
          const built = entriesFor(unit, ctx);
          if (built.hold) {
            mark('held', { hold: built.hold });
            counts.held++;
            continue;
          }
          // Already in the ledger (a save that finished after a crash, or the
          // other wallet of an internal transfer recorded it first).
          const existing = built.entries.map((x) => byExternal.get(x.external_id) || null);
          if (existing.every(Boolean)) {
            mark('recorded', { hold: null, tx_ids: existing.map((t) => t.tx_id) });
            counts.already++;
            continue;
          }
          const missing = built.entries.filter((x, i) => !existing[i]);
          // Transactions Eric recorded himself for the same account and asset.
          if (!(decision && decision.choice === 'record')) {
            const overlap = missing.find((x) => manual.keys.has(`${x.account_id}|${x.asset_id}`));
            if (overlap) {
              const ids = manual.keys.get(`${overlap.account_id}|${overlap.asset_id}`);
              mark('held', { hold: { code: 'manual_records', needs_decision: true, reason: `You recorded ${ids.length} transaction(s) for ${overlap.asset_id} in ${overlap.account_id} yourself (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', …' : ''}). Recording this too could count the same units twice.`, match_tx_ids: ids.slice(0, 10) } });
              counts.held++;
              continue;
            }
            const outExt = missing.find((x) => x.type === 'transfer_out' && !x.transfer_id);
            if (outExt) {
              const q = D.of(outExt.quantity);
              const t0 = Date.parse(outExt.date);
              const twin = manual.list.find((t) => t.type === 'transfer_in' && t.asset_id === outExt.asset_id && t.account_id !== outExt.account_id && Math.abs(Date.parse(t.date) - t0) <= 3 * 86400000 && (() => { const m = D.of(t.quantity); return m <= q && m * 100n >= q * 95n; })());
              if (twin) {
                mark('held', { hold: { code: 'possible_own_transfer', needs_decision: true, reason: `This may be a move to your account ${twin.account_id}: you recorded ${twin.quantity} ${twin.asset_id} arriving there on ${String(twin.date).slice(0, 10)} (${twin.tx_id}).`, match_tx_ids: [twin.tx_id] } });
                counts.held++;
                continue;
              }
            }
          }
          const registry = map.registry;
          const added = [];
          let invalid = null;
          for (const x of missing) {
            const { _event: ev, ...input } = x;
            const { tx, errors } = portfolio.normalizeTx(input, { source: SOURCE });
            if (!errors.length) errors.push(...portfolio.validateTx(tx, registry, accountIds, txs));
            if (!errors.length) errors.push(...portfolio.transferIdErrors(tx, [...txs, ...added]));
            if (errors.length) {
              invalid = errors.join('; ');
              break;
            }
            delete tx.tx_id_supplied;
            tx.provenance = { wallet_id: w.wallet_id, network, tx_hash: ev.tx_hash, block_number: ev.block_number, event_key: ev.event_key };
            added.push(tx);
          }
          if (invalid) {
            mark('held', { hold: { code: 'invalid', needs_decision: false, reason: `The ledger would refuse it: ${invalid}` } });
            counts.held++;
            continue;
          }
          for (const t of added) {
            txs.push(t);
            byExternal.set(t.external_id, t);
          }
          ledgerChanged = true;
          mark('recorded', { hold: null, tx_ids: built.entries.map((x) => (byExternal.get(x.external_id) || {}).tx_id).filter(Boolean) });
          counts.recorded++;
        }
        if (changed) op.writeJson(rel, doc);
      }
    }
    if (ledgerChanged) {
      ledger.schema_version = 'cr.transactions.v2';
      op.writeJson('portfolio/transactions.json', ledger);
    }
    return counts;
  });
  const r = out.result;
  return { status: r.recorded || r.voided ? 'saved' : 'unchanged', ...r, files: out.files, verified: out.verified };
}

// Eric's decision on a held event: record it, or say it is already recorded.
// The next import applies it (right away when called from the dashboard).
function resolveEvent(ws, { wallet_id, network, event_key, decision, note = null }) {
  const w = walletById(ws, wallet_id);
  if (!networkInfo(network)) throw new OpError('INVALID', 'Unknown network');
  if (!['record', 'skip'].includes(decision)) throw new OpError('INVALID', 'Decide "record" (record it in the ledger) or "skip" (already recorded).');
  const out = runOp(ws, { type: 'wallet_decision', summary: `Wallet event decision (${w.label})` }, (op) => {
    const rel = eventsRel(w.wallet_id, network);
    const doc = op.readJson(rel, null);
    const e = doc && doc.events.find((x) => x.event_key === event_key);
    if (!e) throw new OpError('NOT_FOUND', 'No such wallet event');
    if (e.ledger.status === 'recorded') throw new OpError('CONFLICT', 'Already recorded in the ledger. Use Void or Correct on the transaction itself.');
    // A swap is decided as one: every leg of the same transaction.
    const group = e.classification === 'swap' ? doc.events.filter((x) => x.tx_hash === e.tx_hash && x.classification === 'swap') : [e];
    const at = new Date().toISOString();
    for (const x of group) {
      x.ledger = { ...x.ledger, decision: { choice: decision, at, note: note ? String(note).slice(0, 300) : null }, status: x.ledger.status === 'skipped' && decision === 'record' ? 'waiting' : x.ledger.status };
      x.history.push({ at, change: decision === 'record' ? 'you chose to record it' : 'you said it is already recorded' });
    }
    op.writeJson(rel, doc);
    // A transfer between two tracked wallets is one transfer: the other
    // wallet's view of the same leg gets the same decision.
    let mirrored = 0;
    const other = e.classification === 'internal_transfer' && e.counterparty_wallet_id ? loadRegistry(ws).wallets.find((x) => x.wallet_id === e.counterparty_wallet_id) : null;
    if (other && other.networks.includes(network)) {
      const orel = eventsRel(other.wallet_id, network);
      const odoc = op.readJson(orel, null);
      const twin = odoc && odoc.events.find((x) => x.event_key === e.event_key && x.ledger.status !== 'recorded');
      if (twin) {
        twin.ledger = { ...twin.ledger, decision: { choice: decision, at, note: note ? String(note).slice(0, 300) : null, via: w.wallet_id }, status: twin.ledger.status === 'skipped' && decision === 'record' ? 'waiting' : twin.ledger.status };
        twin.history.push({ at, change: `decided from ${w.label}: ${decision === 'record' ? 'record it' : 'already recorded'}` });
        op.writeJson(orel, odoc);
        mirrored = 1;
      }
    }
    return { status: 'saved', events: group.length + mirrored };
  });
  return { ...out.result, files: out.files, verified: out.verified };
}

// ---------------------------------------------------------------------------
// Reading: holdings, reconciliation, activity

// Signed amount of an event in its wallet (in +, out -).
const signed = (e) => (e.direction === 'in' ? e.amount : `-${e.amount}`);

// What the ledger derives per account and asset, exact.
function ledgerByAccount(pf) {
  const m = new Map();
  for (const p of pf.positions || []) {
    for (const a of p.by_account || []) m.set(`${a.account_id}|${p.asset_id}`, { quantity: a.quantity_exact, cost_known_exact: a.cost_known_exact ?? null, unknown_quantity_exact: a.unknown_quantity_exact ?? null, position: p });
  }
  return m;
}

// Reconciliation of one wallet: the chain's balances (last complete snapshot
// of each tracked network) against what the ledger derives for its account.
function reconcileWallet(ws, w, { map, ledger, now }) {
  const rows = new Map();
  const missing = [];
  const assetNets = new Map();
  for (const network of w.networks) {
    const bal = loadBalances(ws, w.wallet_id, network);
    const snap = bal && bal.last_complete;
    if (!snap) {
      missing.push(network);
      continue;
    }
    for (const t of snap.tokens) {
      if (decZero(t.balance)) continue;
      const m = mapAsset(map, network, t);
      if (!m.asset_id) continue;
      const r = rows.get(m.asset_id) || { asset_id: m.asset_id, observed: '0', parts: [], unrecorded: '0', unrecorded_events: 0, snapshot_at: snap.fetched_at };
      r.observed = decAdd(r.observed, t.balance);
      r.parts.push({ network, quantity: t.balance });
      if (snap.fetched_at < r.snapshot_at) r.snapshot_at = snap.fetched_at;
      rows.set(m.asset_id, r);
    }
    // The assets a network could hold for this account: its native coin and
    // the verified tokens deployed on it.
    assetNets.set(NETWORKS[network].native.asset_id, [...(assetNets.get(NETWORKS[network].native.asset_id) || []), network]);
    for (const [key, hits] of map.index) {
      if (!key.startsWith(`${NETWORKS[network].chain_id}:`)) continue;
      for (const h of hits) assetNets.set(h.asset_id, [...(assetNets.get(h.asset_id) || []), network]);
    }
    // Movements on chain that the ledger does not have yet.
    for (const e of loadEvents(ws, w.wallet_id, network)) {
      if (e.state === 'reverted' || e.amount === null || e.direction === 'self') continue;
      if (['recorded', 'skipped'].includes(e.ledger.status)) continue;
      if (e.classification === 'failed_transfer') continue;
      if (snap && e.block_timestamp > snap.fetched_at) continue;
      const m = mapAsset(map, network, e.asset);
      if (!m.asset_id) continue;
      const r = rows.get(m.asset_id) || { asset_id: m.asset_id, observed: '0', parts: [], unrecorded: '0', unrecorded_events: 0, decisions: 0, snapshot_at: snap ? snap.fetched_at : null };
      r.unrecorded = decAdd(r.unrecorded, signed(e));
      r.unrecorded_events++;
      if (e.ledger.status === 'held' && e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision) r.decisions = (r.decisions || 0) + 1;
      rows.set(m.asset_id, r);
    }
  }
  for (const [k] of ledger) {
    const [acct, asset] = k.split('|');
    if (acct !== w.account_id || rows.has(asset) || !assetNets.has(asset)) continue;
    rows.set(asset, { asset_id: asset, observed: '0', parts: [], unrecorded: '0', unrecorded_events: 0, snapshot_at: null });
  }
  const out = [];
  for (const r of rows.values()) {
    const rec = ledger.get(`${w.account_id}|${r.asset_id}`);
    const recorded = rec ? rec.quantity : '0';
    const nets = assetNets.get(r.asset_id) || [];
    const incomplete = nets.some((n) => missing.includes(n));
    const difference = decSub(r.observed, recorded);
    // matches: chain and ledger agree. explained: the chain activity the
    // ledger does not have yet (pending, held, unresolved) accounts for the
    // difference exactly. awaiting_decision: held entries that may duplicate
    // your own records decide it, so no sum is guessed. mismatch: nothing on
    // record explains it. incomplete: a tracked network has no complete view.
    let status;
    if (incomplete) status = 'incomplete';
    else if (decZero(difference)) status = 'matches';
    else if (r.decisions) status = 'awaiting_decision';
    else if (r.unrecorded_events && decCmp(decAdd(recorded, r.unrecorded), r.observed) === 0) status = 'explained';
    else status = 'mismatch';
    out.push({ wallet_id: w.wallet_id, account_id: w.account_id, asset_id: r.asset_id, observed: r.observed, recorded, difference, unrecorded: r.unrecorded, unrecorded_events: r.unrecorded_events, decisions: r.decisions || 0, parts: r.parts, networks: [...new Set(nets)], status, snapshot_at: r.snapshot_at, cost: rec ? { known_usd: rec.cost_known_exact === null ? null : D.toNumber(D.of(rec.cost_known_exact)), unknown_quantity: rec.unknown_quantity_exact } : null });
  }
  return { rows: out.sort((a, b) => a.asset_id.localeCompare(b.asset_id)), missing_snapshots: missing };
}

function reconcileAll(ws, { pf, map = null, now = Date.now() } = {}) {
  const m = map || mapContext(ws);
  const ledger = ledgerByAccount(pf);
  const rows = [];
  for (const w of listWallets(ws)) {
    if (w.status === 'removed') continue;
    rows.push(...reconcileWallet(ws, w, { map: m, ledger, now }).rows);
  }
  return rows;
}

const ACTIVITY_LIMIT = 40;

// Everything the Portfolio's wallet views show, in one read. Never fetches,
// syncs or researches.
function overview(ws, { market = null, now = Date.now(), pf = null } = {}) {
  const sync = require('./walletsync');
  const marketMod = require('./market');
  const latest = market || marketMod.readLatest(ws);
  const portfolioNow = pf || portfolio.computePortfolio(ws, { market: latest, now });
  const reg = loadRegistry(ws);
  const map = mapContext(ws);
  const cfg = cfgOf(ws);
  const state = sync.readState(ws);
  const status = sync.statusOf(ws, { now, state });
  const ledger = ledgerByAccount(portfolioNow);
  const holdings = [];
  const hidden = [];
  const activity = [];
  const held = [];
  const reconciliation = [];
  const wallets = [];
  const projects = new Map(require('./projects').listProjects(ws).filter((p) => !p.broken).map((p) => [p.project_id, p]));
  const logoOf = (cg) => (cg && marketMod.logoFile(ws, cg) ? `/api/logos/${cg}` : null);
  for (const w of reg.wallets) {
    const recon = w.status === 'removed' ? { rows: [], missing_snapshots: [] } : reconcileWallet(ws, w, { map, ledger, now });
    const reconByAsset = new Map(recon.rows.map((r) => [r.asset_id, r]));
    const firstSeen = (state.reconciliation || {});
    for (const r of recon.rows) {
      const key = `${w.wallet_id}|${r.asset_id}`;
      reconciliation.push({ ...r, wallet_label: w.label, since: firstSeen[key] && firstSeen[key].status === r.status ? firstSeen[key].since : null });
    }
    const nets = [];
    for (const network of w.networks) {
      const info = NETWORKS[network];
      const bal = loadBalances(ws, w.wallet_id, network);
      const snap = bal && bal.last_complete;
      const events = loadEvents(ws, w.wallet_id, network);
      const st = status.networks[`${w.wallet_id}:${network}`] || {};
      const counts = { pending: 0, held: 0, decisions: 0, unresolved: 0, recorded: 0, reversed: 0 };
      for (const e of events) {
        if (e.state === 'pending') counts.pending++;
        if (e.state === 'reverted') counts.reversed++;
        if (e.ledger.status === 'held') {
          counts.held++;
          if (e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision) counts.decisions++;
        }
        if (e.ledger.status === 'not_recorded' && e.ledger.code === 'unresolved') counts.unresolved++;
        if (e.ledger.status === 'recorded') counts.recorded++;
      }
      nets.push({ network, label: info.label, ...st, snapshot_at: snap ? snap.fetched_at : null, block_number: snap ? snap.block_number : null, events: events.length, raw_months: rawMonths(ws, w.wallet_id, network).length, counts, explorer: info.explorer });
      if (w.status === 'removed') continue;
      // Holdings: the last complete snapshot, with its age.
      const tokenActivity = new Map();
      for (const e of events) {
        if (e.kind === 'fee' || e.state === 'reverted') continue;
        const k = e.asset.native ? 'native' : e.asset.contract;
        const a = tokenActivity.get(k) || { in: 0, out: 0, initiated: false };
        a[e.direction === 'in' ? 'in' : 'out']++;
        if (e.classification === 'swap' || e.direction === 'out') a.initiated = true;
        tokenActivity.set(k, a);
      }
      for (const t of snap ? snap.tokens : []) {
        if (decZero(t.balance)) continue;
        const m = mapAsset(map, network, t);
        const asset = m.asset_id ? m.asset : null;
        const project = asset && asset.project_id ? projects.get(asset.project_id) : null;
        const price = asset ? portfolio.priceFor(asset, latest, ws.settings, now) : { usd: null, status: 'no_identity' };
        const value = price.exact ? D.toNumber(D.mul(D.of(t.balance, { round: true }), price.exact)) : null;
        const r = m.asset_id ? reconByAsset.get(m.asset_id) : null;
        const act = tokenActivity.get(t.native ? 'native' : t.contract) || null;
        let hide = null;
        let hideReason = null;
        if (!asset && (t.possible_spam || SUSPICIOUS_NAME.test(`${t.name || ''} ${t.symbol || ''}`))) {
          hide = 'spam';
          hideReason = t.possible_spam ? 'The provider flags it as possible spam.' : 'Its name advertises a link or a claim.';
        } else if (!asset && act && !act.initiated && t.verified_contract !== true) {
          hide = 'spam';
          hideReason = 'It arrived without anything sent from this wallet, and its contract is not verified.';
        } else if (!t.native && value !== null && value < cfg.dust_usd) {
          hide = 'dust';
          hideReason = `Worth less than $${cfg.dust_usd}.`;
        }
        const acq = !r ? { status: 'unknown' }
          : r.status !== 'matches' ? { status: 'unknown', note: 'until the difference is reconciled' }
            : r.cost && r.cost.known_usd !== null && (!r.cost.unknown_quantity || decZero(r.cost.unknown_quantity)) ? { status: 'known', cost_usd: r.cost.known_usd, all_networks: r.parts.length > 1 }
              : r.cost && r.cost.known_usd !== null ? { status: 'partial', cost_usd: r.cost.known_usd, unknown_quantity: r.cost.unknown_quantity, all_networks: r.parts.length > 1 } : { status: 'unknown' };
        const row = {
          key: `${w.wallet_id}:${network}:${t.native ? 'native' : t.contract}`,
          wallet_id: w.wallet_id,
          wallet_label: w.label,
          wallet_status: w.status,
          network,
          network_label: info.label,
          native: t.native,
          contract: t.contract,
          decimals: t.decimals,
          quantity: t.balance,
          quantity_raw: t.balance_raw,
          asset_id: m.asset_id,
          verified: Boolean(asset),
          unmapped_reason: asset ? null : m.reason,
          project_id: asset ? asset.project_id || null : null,
          symbol: asset ? asset.symbol : t.symbol,
          name: asset ? asset.name : t.name,
          reported: { symbol: t.symbol, name: t.name },
          logo_url: asset ? logoOf(asset.coingecko_id) : null,
          price: { usd: price.usd, status: price.status, as_of: price.as_of || null, age_minutes: price.age_minutes ?? null },
          value_usd: value,
          acquisition: acq,
          reconciliation: r ? { status: r.status, observed: r.observed, recorded: r.recorded, difference: r.difference } : { status: 'not_in_ledger' },
          snapshot_at: snap.fetched_at,
          hidden: hide,
          hidden_reason: hideReason,
        };
        (hide ? hidden : holdings).push(row);
      }
      for (const e of events) {
        const m = e.asset.native ? { asset_id: info.native.asset_id } : mapAsset(map, network, e.asset);
        const item = { wallet_id: w.wallet_id, wallet_label: w.label, network, network_label: info.label, event_key: e.event_key, tx_hash: e.tx_hash, block_number: e.block_number, at: e.block_timestamp, kind: e.kind, direction: e.direction, classification: e.classification, reason: e.reason, category: e.category, symbol: m.asset_id && map.registry.get(m.asset_id) ? map.registry.get(m.asset_id).symbol : e.asset.symbol, verified: Boolean(m.asset_id), contract: e.asset.contract, amount: e.amount, state: e.state, ledger: e.ledger, suspected_spam: e.suspected_spam, counterparty_wallet_id: e.counterparty_wallet_id, explorer_url: `${info.explorer}/tx/${e.tx_hash}` };
        activity.push(item);
        // One decision per on-chain leg: both views of a transfer between
        // your wallets share its event key.
        if (e.ledger.status === 'held' && e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision && !held.some((x) => x.event_key === e.event_key)) held.push(item);
      }
    }
    wallets.push({ wallet_id: w.wallet_id, label: w.label, address: w.address, address_short: shortAddress(w.address), account_id: w.account_id, status: w.status, created_at: w.created_at, paused_at: w.paused_at, removed_at: w.removed_at, networks: nets, missing_snapshots: recon.missing_snapshots });
  }
  activity.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(a.event_key).localeCompare(String(b.event_key)));
  holdings.sort((a, b) => (b.value_usd ?? -1) - (a.value_usd ?? -1) || Number(b.verified) - Number(a.verified) || String(a.symbol).localeCompare(String(b.symbol)));
  const priced = holdings.filter((r) => r.value_usd !== null);
  const lastSuccess = Object.values(status.networks).map((n) => n.last_success_at).filter(Boolean).sort().pop() || null;
  return {
    provider: { name: 'Moralis', ...require('./moralis').keyStatus() },
    settings: { enabled: cfg.enabled, interval_minutes: cfg.interval_minutes, balance_refresh_minutes: cfg.balance_refresh_minutes, daily_cu_budget: cfg.daily_cu_budget, dust_usd: cfg.dust_usd },
    sync: status.summary,
    networks_supported: Object.entries(NETWORKS).map(([id, n]) => ({ id, label: n.label, native: n.native.symbol })),
    accounts: portfolio.loadAccounts(ws).map((a) => ({ account_id: a.account_id, name: a.name })),
    wallets,
    holdings,
    hidden,
    activity: activity.slice(0, ACTIVITY_LIMIT),
    activity_total: activity.length,
    held,
    reconciliation,
    summary: {
      tracked: reg.wallets.filter((w) => w.status !== 'removed').length,
      value_priced_usd: priced.length ? priced.reduce((s, r) => s + r.value_usd, 0) : null,
      priced: priced.length,
      unpriced: holdings.length - priced.length,
      hidden: hidden.length,
      decisions: held.length,
      mismatches: reconciliation.filter((r) => r.status === 'mismatch').length,
      last_success_at: lastSuccess,
    },
  };
}

// Review-queue items for the index: a decision waiting, a difference, a
// reversed entry, a network that stopped syncing. IDs and words only.
function attentionItems(ws, { pf, now = Date.now() } = {}) {
  const reg = loadRegistry(ws);
  if (!reg.wallets.some((w) => w.status !== 'removed')) return [];
  const out = [];
  const sync = require('./walletsync');
  const status = sync.statusOf(ws, { now });
  for (const w of reg.wallets) {
    if (w.status === 'removed') continue;
    let decisions = 0;
    let voided = 0;
    for (const network of w.networks) {
      for (const e of loadEvents(ws, w.wallet_id, network)) {
        if (e.ledger.status === 'held' && e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision) decisions++;
        if (e.ledger.status === 'voided') voided++;
      }
      const st = status.networks[`${w.wallet_id}:${network}`];
      if (w.status === 'active' && st && ['stale', 'failing', 'unavailable'].includes(st.state) && status.summary.configured) out.push({ kind: 'wallet_sync', severity: 'medium', project_id: null, title: `Wallet ${w.label} on ${NETWORKS[network].label}: ${st.words}`, detail: st.last_error || 'The last good view stays on screen with its age.', action: '#/portfolio?tab=wallets' });
    }
    if (decisions) out.push({ kind: 'wallet_decision', severity: 'medium', project_id: null, title: `Wallet ${w.label}: ${decisions} transaction(s) wait for your decision`, detail: 'Held because you recorded the same asset in that account yourself, or it may be a move between your accounts.', action: '#/portfolio?tab=wallets' });
    if (voided) out.push({ kind: 'wallet_reversed', severity: 'medium', project_id: null, title: `Wallet ${w.label}: ${voided} recorded transaction(s) were reversed on chain`, detail: 'Their ledger entries were voided with the reason; nothing was deleted.', action: '#/portfolio?tab=wallets' });
  }
  try {
    const mismatches = reconcileAll(ws, { pf, now }).filter((r) => r.status === 'mismatch');
    if (mismatches.length) out.push({ kind: 'wallet_mismatch', severity: 'medium', project_id: null, title: `Wallet balances differ from your ledger for ${mismatches.length} asset(s)`, detail: mismatches.slice(0, 4).map((r) => `${r.asset_id} in ${r.account_id}: chain ${r.observed}, ledger ${r.recorded}`).join('; '), action: '#/portfolio?tab=wallets' });
  } catch (_) { /* a reconciliation failure never hides the rest */ }
  return out;
}

// Counts for backup and restore checks (no addresses).
function recordSummary(ws) {
  const reg = loadRegistry(ws);
  let events = 0;
  let raw = 0;
  let snapshots = 0;
  for (const w of reg.wallets) {
    for (const network of Object.keys(NETWORKS)) {
      if (!listDir(ws.abs(`${DIR}/${w.wallet_id}`), { dirs: true }).includes(network)) continue;
      events += loadEvents(ws, w.wallet_id, network).length;
      raw += rawMonths(ws, w.wallet_id, network).length;
      if (loadBalances(ws, w.wallet_id, network)) snapshots++;
    }
  }
  return { wallets: reg.wallets.length, events, raw_files: raw, snapshots };
}

module.exports = {
  DIR,
  REGISTRY_REL,
  NETWORKS,
  SOURCE,
  NAMESPACE,
  WALLET_ID_RE,
  networkInfo,
  cfgOf,
  unitsToDecimal,
  decAdd,
  decSub,
  decCmp,
  loadRegistry,
  listWallets,
  walletById,
  ownAddressMap,
  shortAddress,
  addWallet,
  pauseWallet,
  resumeWallet,
  removeWallet,
  setWalletNetworks,
  eventsRel,
  balancesRel,
  rawRel,
  loadEvents,
  loadBalances,
  eventsFromTx,
  storeHistoryPage,
  finishPass,
  storeBalances,
  assetIndex,
  mapAsset,
  mapContext,
  importReady,
  resolveEvent,
  reconcileAll,
  overview,
  attentionItems,
  recordSummary,
  compactTs,
};
