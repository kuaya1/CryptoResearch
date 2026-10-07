'use strict';
// Tracked wallets: public addresses Eric chose to follow, read-only. What the
// provider reports about them (transfers, receipts, balance snapshots, the
// original answers) and how that reaches the portfolio ledger.
//
// Records (portfolio/wallets/, kept in backups, packages and offsite copies):
//   registry.json                         the wallets: label, public address,
//                                         networks, status, linked ledger account
//   token-metadata.json                   token names, symbols and decimals as
//                                         the provider reported them, by network
//   <wallet>/<network>/events.json        one event per transfer leg or fee, with
//                                         its chain references, classification,
//                                         chain state and ledger link; "txs" holds
//                                         each transaction's receipt facts
//   <wallet>/<network>/raw/alchemy-<YYYY-MM>.json   Alchemy's original transfer
//                                         and receipt answers, every version kept
//   <wallet>/<network>/raw/<YYYY-MM>.json earlier providers' answers (kept as
//                                         they were saved)
//   <wallet>/<network>/balances.json      the last complete balance snapshot and
//                                         a few before it
//   sync-state.json                       progress and status (walletsync.js)
//
// Authority: the ledger (portfolio/transactions.json) stays the only record of
// holdings and cost. Events are evidence; a ledger entry is made from an event
// only when it is final (at or below the chain's finalized block), successful
// (its receipt says so), supported by explicit evidence and the ledger's own
// types, and mapped to a verified asset (a project identity's chain and
// contract, or the network's native coin). What counts as evidence:
//   - received: value arrived in a transaction this wallet did not send;
//   - sent: this wallet sent a plain transfer (ETH to the recipient with no
//     contract events, or a token's own transfer call with exactly one
//     Transfer event);
//   - between your wallets: the same, with the other side a tracked wallet;
//   - network fee: the receipt of a transaction this wallet sent (once per
//     transaction, however many transfers it holds).
// A transaction this wallet sent where one asset left and another arrived is a
// possible swap: held for Eric's decision, never assumed. Everything else
// (deposits, bridges, staking, liquidity, claims, batch sends, value taken by
// a contract) stays unresolved and visible. Balances keep updating either way.
//   - a first balance snapshot is an observation, never a purchase;
//   - failed transfers and transfers to yourself are never recorded;
//   - an account with transactions Eric recorded himself for the same asset
//     holds the import for his decision (record, or "already recorded");
//   - an event is reversed only on chain evidence: its receipt is gone and the
//     block that held it now has another hash. Missing from one answer, a page
//     or a window is never evidence. Only final events are recorded, so a
//     recorded entry is voided (with the reason, never deleted) only if that
//     evidence ever appears for it.
// Reconciliation compares what the chain shows with what the ledger derives
// and is computed on every read; a difference stays visible until the records
// explain it. Nothing here changes a recorded price, cost or manual entry.
//
// Assets are identified by network and contract address (native coins by the
// network), never by ticker. Token names and symbols come from the token's own
// contract via the provider: untrusted text, cleaned and never used to match.
// The provider gives no spam verdict here, and a missing flag is not "safe".
// Quantities are integer strings with their decimals, converted exactly.
// Research never starts from anything here, and no holding comes from research.

const D = require('./decimal');
const { runOp, OpError } = require('./ops');
const { readJson, sha256, listDir } = require('./fsx');
const { randomId, slugify, compactTs } = require('./ids');
const { chainInfo } = require('./chains');
const portfolio = require('./portfolio');
const alchemy = require('./alchemy');

const DIR = 'portfolio/wallets';
const REGISTRY_REL = `${DIR}/registry.json`;
const METADATA_REL = `${DIR}/token-metadata.json`;
const SOURCE = 'wallet_sync';
const NAMESPACE = 'wallet-sync';
const PROVIDER = 'alchemy';
const WALLET_ID_RE = /^w_[a-z2-9]{10}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_PREVIOUS_SNAPSHOTS = 10;

// The networks the desk knows. "supported" ones are those Alchemy documents
// for its Transfers API (alchemy.js); the others stay known so a wallet saved
// with one keeps its records, and are never read. blocks_per_minute sizes the
// overlap re-read each sync; confirm_blocks is the depth used as final only
// where the chain does not answer the "finalized" block tag.
const ETH = { asset_id: 'ethereum', symbol: 'ETH', name: 'Ether', coingecko_id: 'ethereum' };
const NETWORKS = {
  eth: { label: 'Ethereum', chain_id: '1', native: ETH, blocks_per_minute: 5, confirm_blocks: 96, explorer: 'https://etherscan.io' },
  base: { label: 'Base', chain_id: '8453', native: ETH, blocks_per_minute: 30, confirm_blocks: 1800, explorer: 'https://basescan.org' },
  arbitrum: { label: 'Arbitrum One', chain_id: '42161', native: ETH, blocks_per_minute: 240, confirm_blocks: 14400, explorer: 'https://arbiscan.io' },
  optimism: { label: 'Optimism', chain_id: '10', native: ETH, blocks_per_minute: 30, confirm_blocks: 1800, explorer: 'https://optimistic.etherscan.io' },
  polygon: { label: 'Polygon', chain_id: '137', native: { asset_id: 'polygon-ecosystem-token', symbol: 'POL', name: 'POL', coingecko_id: 'polygon-ecosystem-token' }, blocks_per_minute: 30, confirm_blocks: 1800, explorer: 'https://polygonscan.com' },
  linea: { label: 'Linea', chain_id: '59144', native: ETH, blocks_per_minute: 30, confirm_blocks: 1800, explorer: 'https://lineascan.build' },
  bsc: { label: 'BNB Smart Chain', chain_id: '56', native: { asset_id: 'binancecoin', symbol: 'BNB', name: 'BNB', coingecko_id: 'binancecoin' }, blocks_per_minute: 80, confirm_blocks: 1800, explorer: 'https://bscscan.com' },
  avalanche: { label: 'Avalanche C-Chain', chain_id: '43114', native: { asset_id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche', coingecko_id: 'avalanche-2' }, blocks_per_minute: 30, confirm_blocks: 300, explorer: 'https://snowtrace.io' },
};
for (const [id, n] of Object.entries(NETWORKS)) {
  n.supported = alchemy.supports(id);
  n.coverage = n.supported ? alchemy.NETWORKS[id] : null;
}

// Names that advertise something (a link, a claim) are a common way unwanted
// tokens reach a wallet. Used only to keep an unverified token out of the main
// list, never to match or record anything, and never to call one "safe".
const SUSPICIOUS_NAME = /(https?:|www\.|t\.me|\.(com|io|net|org|xyz|app|site|top|vip|link|gift|live|club|pro)\b|claim|reward|visit|voucher|bonus|redeem|\$\s?\d)/i;

const isoOf = (ms) => new Date(ms).toISOString();
const shortHash = (parts) => sha256(JSON.stringify(parts)).slice(0, 12);

function cfgOf(ws) {
  return { ...require('./workspace').DEFAULT_SETTINGS.wallet_sync, ...((ws.settings && ws.settings.wallet_sync) || {}) };
}

function networkInfo(net) {
  return Object.prototype.hasOwnProperty.call(NETWORKS, net) ? NETWORKS[net] : null;
}

// The words for an interval in minutes, as Settings shows it.
function intervalWords(minutes) {
  const m = Number(minutes);
  if (m === 720) return 'Twice daily';
  if (m === 1440) return 'Once daily';
  if (m === 360) return 'Every 6 hours';
  if (m === 180) return 'Every 3 hours';
  if (m === 60) return 'Every hour';
  if (m % 60 === 0) return `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
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

const supportedIds = () => Object.keys(NETWORKS).filter((n) => NETWORKS[n].supported);

function checkNetworks(networks) {
  const list = [...new Set((Array.isArray(networks) ? networks : String(networks || '').split(',')).map((n) => String(n).trim().toLowerCase()).filter(Boolean))];
  if (!list.length) throw new OpError('INVALID', `Choose at least one network to track (${supportedIds().join(', ')}). Nothing is scanned without one.`);
  const unknown = list.filter((n) => !networkInfo(n));
  if (unknown.length) throw new OpError('INVALID', `Not a network the desk can follow: ${unknown.join(', ')}. Choose from ${supportedIds().join(', ')}.`);
  const unsupported = list.filter((n) => !NETWORKS[n].supported);
  if (unsupported.length) throw new OpError('INVALID', `${unsupported.map((n) => NETWORKS[n].label).join(', ')}: Alchemy's transfer history does not cover ${unsupported.length === 1 ? 'it' : 'them'}, so the desk cannot follow ${unsupported.length === 1 ? 'it' : 'them'} yet. Choose from ${supportedIds().join(', ')}.`);
  return list;
}

function checkLabel(label) {
  const l = String(label || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!l) throw new OpError('INVALID', 'A wallet needs a label (for example MetaMask).');
  if (l.length > 60) throw new OpError('INVALID', 'Keep the label under 60 characters.');
  if (portfolio.looksLikeSecret(l)) throw new OpError('REFUSED', 'That label looks like a seed phrase or a key. Never store those here.');
  // Labels name the wallet in logs and messages, where addresses never go.
  if (/0x[0-9a-fA-F]{40}/.test(l)) throw new OpError('INVALID', 'Use a name for the label (for example MetaMask), not the address: labels appear in logs and messages.');
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
      Object.assign(same, { label: name, networks: nets, account_id: acct.account_id, status: 'active', provider: PROVIDER, updated_at: now, removed_at: null, removed_reason: null, paused_at: null });
      same.history = [...(same.history || []), { at: now, action: 'tracked_again', networks: nets }];
      op.writeJson(REGISTRY_REL, reg);
      return { status: 'saved', wallet_id: same.wallet_id, account_id: acct.account_id, again: true };
    }
    let id = `w_${randomId(10)}`;
    while (reg.wallets.some((w) => w.wallet_id === id)) id = `w_${randomId(10)}`;
    reg.wallets.push({ wallet_id: id, label: name, family: 'evm', address: addr, networks: nets, account_id: acct.account_id, provider: PROVIDER, status: 'active', created_at: now, updated_at: now, paused_at: null, removed_at: null, removed_reason: null, history: [{ at: now, action: 'added', networks: nets }] });
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

// Stops following a wallet. Its events, snapshots, raw answers and every
// ledger entry made from them stay exactly as they are.
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
const rawRel = (w, n, month) => `${storeDir(w, n)}/raw/alchemy-${month}.json`;

function loadEventsDoc(ws, walletId, network) {
  const doc = readJson(ws.abs(eventsRel(walletId, network)), null);
  return doc && Array.isArray(doc.events) ? { txs: {}, ...doc } : null;
}

function loadEvents(ws, walletId, network) {
  const doc = loadEventsDoc(ws, walletId, network);
  return doc ? doc.events : [];
}

function loadBalances(ws, walletId, network) {
  return readJson(ws.abs(balancesRel(walletId, network)), null);
}

function rawMonths(ws, walletId, network) {
  return listDir(ws.abs(`${storeDir(walletId, network)}/raw`), { dirs: false }).filter((f) => /^(alchemy-)?\d{4}-\d{2}\.json$/.test(f));
}

function loadMetadata(ws) {
  const doc = readJson(ws.abs(METADATA_REL), null);
  return doc && doc.networks ? doc : { schema_version: 'cr.wallet-token-metadata.v1', provider: PROVIDER, networks: {} };
}

function metadataOf(meta, network, contract) {
  return (meta.networks[network] || {})[String(contract || '').toLowerCase()] || null;
}

// Token metadata as the provider reported it (name, symbol, decimals), kept so
// it is asked once per token. Untrusted text, cleaned in alchemy.js.
function storeMetadata(ws, network, entries, { now = Date.now() } = {}) {
  if (!entries.length) return { changed: false };
  const out = runOp(ws, { type: 'wallet_metadata', summary: `Token details read (${NETWORKS[network].label})` }, (op) => {
    const doc = op.readJson(METADATA_REL, null) || { schema_version: 'cr.wallet-token-metadata.v1', provider: PROVIDER, networks: {} };
    const net = doc.networks[network] || {};
    for (const e of entries) net[e.contract] = { name: e.name, symbol: e.symbol, decimals: e.decimals, fetched_at: isoOf(now), readable: e.readable !== false };
    doc.networks[network] = net;
    op.writeJson(METADATA_REL, doc);
    return { changed: true };
  });
  return out.result;
}

function newEventsDoc(walletId, network) {
  return { schema_version: 'cr.wallet-events.v2', wallet_id: walletId, network, events: [], txs: {} };
}

function rawDocOf(op, wallet, network, month) {
  return op.readJson(rawRel(wallet.wallet_id, network, month), null) || { schema_version: 'cr.wallet-raw.v2', provider: PROVIDER, wallet_id: wallet.wallet_id, network, month, transfers: {}, receipts: {}, blocks: {} };
}

// Adds a version to a raw list only when the answer changed.
function keepVersion(list, item, at) {
  const sha = sha256(JSON.stringify(item));
  const versions = list || [];
  if (versions.length && versions[versions.length - 1].item_sha256 === sha) return { versions, sha, changed: false };
  return { versions: [...versions, { fetched_at: at, item_sha256: sha, item }], sha, changed: true };
}

// ---------------------------------------------------------------------------
// From Alchemy's transfers to events

// An event for one transfer leg touching this wallet, before classification.
// Its key is the network and Alchemy's uniqueId (a transaction hash and the
// transfer's place in it), the same from the "sent" and the "received" query.
function legOf(t, { wallet, network, own }) {
  const me = String(wallet.address).toLowerCase();
  if (t.from !== me && t.to !== me) return null;
  const dir = t.from === me && t.to === me ? 'self' : t.from === me ? 'out' : 'in';
  const counterparty = dir === 'out' ? t.to : dir === 'in' ? t.from : me;
  const other = own.get(counterparty);
  const native = t.category !== 'erc20';
  const decimals = native ? 18 : t.decimals;
  return {
    event_key: `${network}:${t.unique_id}`,
    unique_id: t.unique_id,
    provider: PROVIDER,
    wallet_id: wallet.wallet_id,
    network,
    tx_hash: t.hash,
    block_number: t.block_number,
    block_hash: null,
    block_timestamp: t.block_timestamp,
    log_index: t.log_index,
    kind: native ? 'native' : 'erc20',
    internal: t.category === 'internal',
    direction: dir,
    asset: { native, contract: t.contract, decimals: Number.isInteger(decimals) ? decimals : null, symbol: native ? NETWORKS[network].native.symbol : t.symbol, name: native ? NETWORKS[network].native.name : null },
    amount_raw: t.value_raw,
    amount: t.value_raw !== null && Number.isInteger(decimals) ? unitsToDecimal(t.value_raw, decimals) : null,
    from: t.from,
    to: t.to,
    counterparty,
    counterparty_wallet_id: other && other.wallet_id !== wallet.wallet_id ? other.wallet_id : null,
    category: t.category,
    receipt_status: null,
    classification: 'awaiting_receipt',
    reason: 'Waiting for the transaction receipt.',
    suspected_spam: false,
  };
}

// An event another provider saved for the same leg, so switching providers
// never counts a transfer twice.
function twinOf(events, fresh) {
  return events.find((e) => e.provider !== PROVIDER && e.tx_hash === fresh.tx_hash && e.kind === fresh.kind && e.direction === fresh.direction && (e.asset.contract || null) === (fresh.asset.contract || null) && e.amount_raw === fresh.amount_raw && !e.alias_of);
}

// How many transactions this wallet sent are on record for a network: those
// whose receipt names it as sender, or, before the receipt is read, those
// Alchemy listed as sent by it. Compared with the chain's count (its nonce).
function sentSeenOf(doc, address) {
  const me = String(address).toLowerCase();
  return doc ? Object.values(doc.txs || {}).filter((x) => !x.reversal && (x.receipt ? x.receipt.from === me : x.sent_by_me === true)).length : 0;
}

// Transactions this wallet sent that the chain counts but the history read
// does not have (their fees, at least, are not recorded). 0 when unknown.
function sentGapOf(st) {
  if (!st || !st.history_complete_to || st.sent_count_chain === null || st.sent_count_chain === undefined) return 0;
  const gap = BigInt(st.sent_count_chain) - BigInt(st.sent_count_seen || 0);
  return gap > 0n ? Number(gap) : 0;
}

// Merges one fresh leg into the stored events. Returns what changed.
function mergeLeg(doc, byKey, fresh, { passId, now }) {
  const at = isoOf(now);
  let cur = byKey.get(fresh.event_key);
  if (!cur) {
    const twin = twinOf(doc.events, fresh);
    if (twin) {
      twin.alias_of = fresh.event_key;
      twin.history.push({ at, change: `also reported by ${PROVIDER} as ${fresh.unique_id}` });
      byKey.set(fresh.event_key, twin);
      return 'alias';
    }
    const e = { ...fresh, state: 'pending', ledger: { status: 'waiting', tx_ids: [], revision: 0 }, first_seen_at: at, last_seen_at: at, last_seen_pass: passId, history: [{ at, change: 'seen' }] };
    doc.events.push(e);
    byKey.set(e.event_key, e);
    return 'new';
  }
  if (cur.provider !== PROVIDER) return 'alias';
  let change = null;
  if (cur.amount_raw !== fresh.amount_raw || (cur.asset.contract || null) !== (fresh.asset.contract || null) || cur.direction !== fresh.direction) {
    cur.history.push({ at, change: 'the provider now reports different content' });
    cur.content_changed = cur.ledger.status === 'recorded';
    for (const k of ['amount_raw', 'amount', 'asset', 'direction', 'from', 'to', 'counterparty', 'counterparty_wallet_id']) cur[k] = fresh[k];
    if (cur.state === 'final') cur.state = 'pending';
    change = 'content';
  }
  if (cur.block_number !== fresh.block_number) {
    cur.history.push({ at, change: `reported in block ${fresh.block_number} (was ${cur.block_number})` });
    cur.block_number = fresh.block_number;
    if (cur.state === 'final') cur.state = 'pending';
    change = change || 'moved';
  }
  if (!cur.block_timestamp && fresh.block_timestamp) {
    cur.block_timestamp = fresh.block_timestamp;
    change = change || 'dated';
  }
  if (cur.last_seen_pass !== passId) {
    cur.last_seen_pass = passId;
    cur.last_seen_at = at;
    change = change || 'seen';
  }
  return change;
}

// One page of transfers: legs merged into events.json, each transaction noted
// (also zero-value ones this wallet sent, for their fee), and Alchemy's
// original answers kept by month. One verified save; nothing when nothing
// changed. Returns the transactions still without a receipt.
function storeTransfers(ws, wallet, network, items, { passId, now = Date.now(), own = null } = {}) {
  const ownMap = own || ownAddressMap(loadRegistry(ws));
  const at = isoOf(now);
  const out = runOp(ws, { type: 'wallet_history', summary: `Wallet activity read (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = eventsRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null) || newEventsDoc(wallet.wallet_id, network);
    doc.txs = doc.txs || {};
    doc.schema_version = 'cr.wallet-events.v2';
    const byKey = new Map(doc.events.map((e) => [e.event_key, e]));
    for (const e of doc.events) if (e.alias_of) byKey.set(e.alias_of, e);
    const counts = { new: 0, changed: 0, seen: 0, malformed: 0, alias: 0 };
    let changed = false;
    const raws = new Map();
    const touched = new Set();
    const me = String(wallet.address).toLowerCase();
    for (const { t, item } of items) {
      if (!t || t.error) {
        counts.malformed++;
        continue;
      }
      touched.add(t.hash);
      const month = (t.block_timestamp || at).slice(0, 7);
      if (!raws.has(month)) raws.set(month, { doc: rawDocOf(op, wallet, network, month), changed: false });
      const raw = raws.get(month);
      const kept = keepVersion(raw.doc.transfers[t.unique_id], item, at);
      if (kept.changed) {
        raw.doc.transfers[t.unique_id] = kept.versions;
        raw.changed = true;
      }
      const tx = doc.txs[t.hash] || { tx_hash: t.hash, block_number: t.block_number, block_timestamp: t.block_timestamp, receipt: null, first_seen_at: at };
      if (!doc.txs[t.hash]) changed = true;
      if (!tx.block_timestamp && t.block_timestamp) {
        tx.block_timestamp = t.block_timestamp;
        changed = true;
      }
      if (t.category === 'external' && t.from === me && !tx.sent_by_me) {
        tx.sent_by_me = true;
        changed = true;
      }
      doc.txs[t.hash] = tx;
      if (t.value_raw === '0' || t.value_raw === null) continue;
      const fresh = legOf(t, { wallet, network, own: ownMap });
      if (!fresh) continue;
      fresh.raw = { file: `raw/alchemy-${month}.json`, unique_id: t.unique_id, item_sha256: kept.sha };
      const change = mergeLeg(doc, byKey, fresh, { passId, now });
      if (change === 'new') counts.new++;
      else if (change === 'alias') counts.alias++;
      else if (change && change !== 'seen') counts.changed++;
      else if (change === 'seen') counts.seen++;
      if (change) changed = true;
    }
    if (changed) {
      doc.events.sort((a, b) => String(a.block_number).padStart(20, '0').localeCompare(String(b.block_number).padStart(20, '0')) || String(a.event_key).localeCompare(String(b.event_key)));
      op.writeJson(rel, doc);
    }
    for (const [month, raw] of raws) if (raw.changed) op.writeJson(rawRel(wallet.wallet_id, network, month), raw.doc);
    // This page's transactions without a receipt; any others are asked once
    // the window is complete (receiptsToCheck), not again on every page.
    return { ...counts, need_receipts: [...touched].filter((h) => doc.txs[h] && !doc.txs[h].receipt && !doc.txs[h].reversal) };
  });
  return out.result;
}

// The transactions whose receipt is missing, and those not final yet (their
// receipt is asked again: still there, moved, or gone).
function receiptsToCheck(ws, wallet, network, { finalized }) {
  const doc = loadEventsDoc(ws, wallet.wallet_id, network);
  if (!doc) return { missing: [], recheck: [] };
  const fin = BigInt(finalized);
  const missing = [];
  const recheck = [];
  for (const x of Object.values(doc.txs)) {
    if (x.reversal) continue;
    if (!x.receipt) missing.push(x.tx_hash);
    else if (BigInt(x.receipt.block_number) > fin) recheck.push({ tx_hash: x.tx_hash, block_number: x.receipt.block_number, block_hash: x.receipt.block_hash });
  }
  return { missing, recheck };
}

// Receipts as read: a receipt, or null with the evidence gathered about the
// block that held it. A reversal is recorded only when the receipt is gone AND
// the block at that height now has another hash.
function storeReceipts(ws, wallet, network, results, { now = Date.now() } = {}) {
  if (!results.length) return { stored: 0, reversed: 0 };
  const at = isoOf(now);
  const out = runOp(ws, { type: 'wallet_receipts', summary: `Wallet receipts read (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = eventsRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null) || newEventsDoc(wallet.wallet_id, network);
    doc.txs = doc.txs || {};
    const raws = new Map();
    let stored = 0;
    let reversed = 0;
    for (const r of results) {
      const tx = doc.txs[r.tx_hash] || { tx_hash: r.tx_hash, block_number: null, block_timestamp: null, receipt: null, first_seen_at: at };
      const month = (tx.block_timestamp || at).slice(0, 7);
      if (!raws.has(month)) raws.set(month, { doc: rawDocOf(op, wallet, network, month), changed: false });
      const raw = raws.get(month);
      const kept = keepVersion(raw.doc.receipts[r.tx_hash], r.raw === undefined ? null : r.raw, at);
      if (kept.changed) {
        raw.doc.receipts[r.tx_hash] = kept.versions;
        raw.changed = true;
      }
      if (r.receipt) {
        if (tx.receipt && tx.receipt.block_hash && tx.receipt.block_hash !== r.receipt.block_hash) tx.moved = { at, from_block: tx.receipt.block_number, to_block: r.receipt.block_number };
        tx.receipt = r.receipt;
        tx.receipt_checked_at = at;
        tx.missing_since = null;
        stored++;
      } else {
        tx.receipt_checked_at = at;
        tx.missing_since = tx.missing_since || at;
        if (r.block_check) {
          const was = tx.receipt ? tx.receipt.block_hash : null;
          raw.doc.blocks[`${r.block_check.number}`] = [...(raw.doc.blocks[`${r.block_check.number}`] || []), { fetched_at: at, hash: r.block_check.hash }];
          raw.changed = true;
          if (was && r.block_check.hash && r.block_check.hash !== was) {
            tx.reversal = { at, evidence: `The receipt is no longer found, and block ${r.block_check.number} now has hash ${r.block_check.hash} (it was ${was}).` };
            reversed++;
          } else {
            tx.reversal_check = { at, result: was ? 'The receipt is not found, but the block that held it is unchanged; not treated as reversed.' : 'The receipt is not found yet.' };
          }
        }
      }
      doc.txs[r.tx_hash] = tx;
    }
    op.writeJson(rel, doc);
    for (const [month, raw] of raws) if (raw.changed) op.writeJson(rawRel(wallet.wallet_id, network, month), raw.doc);
    return { stored, reversed };
  });
  return out.result;
}

// What one transaction is, in this wallet's view, from its legs and its
// receipt only. Returns { legs: Map(event_key -> { classification, reason }),
// fee: { amount_raw, basis } | null }. Pure, for the tests.
function classifyTx(legs, rc, { me, own, walletId }) {
  const out = new Map();
  const set = (e, classification, reason = null) => out.set(e.event_key, { classification, reason });
  if (!rc) {
    for (const e of legs) set(e, 'awaiting_receipt', 'Waiting for the transaction receipt.');
    return { legs: out, fee: null, initiated: null };
  }
  // A deposit bridged in from Ethereum (OP stack): its gas was paid there,
  // and what arrives is a bridge, never a plain transfer or a self-transfer.
  if (rc.deposit) {
    for (const e of legs) set(e, 'unresolved', 'A deposit bridged in from Ethereum; not recorded automatically.');
    return { legs: out, fee: null, initiated: rc.from === me };
  }
  const initiated = rc.from === me;
  const fee = initiated ? { amount_raw: rc.fee_raw, basis: rc.fee_basis } : null;
  if (rc.status !== '1') {
    const why = rc.status === '0' ? 'The transaction failed on chain: nothing moved except the network fee.' : 'The receipt gives no success status, so nothing is recorded.';
    for (const e of legs) set(e, rc.status === '0' ? 'failed_transfer' : 'unresolved', why);
    return { legs: out, fee, initiated };
  }
  const value = [];
  for (const e of legs) {
    if (e.direction === 'self') set(e, 'self_transfer', 'Sent from this wallet to itself: no change.');
    else if (e.amount === null) set(e, 'unresolved', 'The amount or the token\'s decimals are not known.');
    else value.push(e);
  }
  const outs = value.filter((e) => e.direction === 'out');
  const ins = value.filter((e) => e.direction === 'in');
  const plainKind = (e) => {
    const other = own.get(e.counterparty);
    if (other && other.wallet_id !== walletId) return 'internal_transfer';
    return e.direction === 'in' ? 'incoming_transfer' : 'outgoing_transfer';
  };
  if (!initiated) {
    if (outs.length) {
      for (const e of value) set(e, 'unresolved', 'Value left this wallet in a transaction it did not send (a contract using an approval, for example); not recorded automatically.');
    } else {
      for (const e of ins) set(e, plainKind(e));
    }
    return { legs: out, fee, initiated };
  }
  const assetKey = (e) => (e.asset.native ? 'native' : e.asset.contract);
  if (outs.length && ins.length) {
    const outAssets = new Set(outs.map(assetKey));
    const inAssets = new Set(ins.map(assetKey));
    const shared = [...outAssets].some((a) => inAssets.has(a));
    if (outAssets.size === 1 && inAssets.size === 1 && !shared) {
      for (const e of value) set(e, 'possible_swap', 'One asset left and another arrived in a transaction this wallet sent. It may be a swap: record it as one (a sale and a purchase at unknown price), or leave it unrecorded.');
    } else {
      for (const e of value) set(e, 'unresolved', 'Several assets moved in one transaction (liquidity, a multi-step swap or a bridge, for example); not recorded automatically.');
    }
  } else if (outs.length === 1) {
    const e = outs[0];
    const transfers = rc.logs.filter((l) => l.topic0 === alchemy.TRANSFER_TOPIC);
    const plain = e.asset.native
      ? !e.internal && rc.to === e.to && rc.logs.length === 0
      : rc.to === e.asset.contract && rc.logs.length === 1 && transfers.length === 1 && transfers[0].address === e.asset.contract;
    if (plain) set(e, plainKind(e));
    else set(e, 'unresolved', e.asset.native ? 'Sent to a contract or with other effects (a deposit, bridge, staking or purchase, for example); not recorded automatically.' : 'Moved by a contract call rather than a plain transfer (a deposit, bridge, staking or purchase, for example); not recorded automatically.');
  } else if (outs.length > 1) {
    for (const e of outs) set(e, 'unresolved', 'Several transfers out in one transaction (a batch send or a protocol action); not recorded automatically.');
  } else {
    for (const e of ins) set(e, 'unresolved', 'Received through a transaction this wallet sent (a claim, withdrawal or unstaking, for example); not recorded automatically.');
  }
  return { legs: out, fee, initiated };
}

// After a complete read: every transaction with a receipt is classified,
// gets its fee event (once, when this wallet sent it), and is final when its
// block is at or below the finalized block. Recorded events keep their
// classification. Pure apart from the save.
function settleNetwork(ws, wallet, network, { finalized, now = Date.now(), own = null } = {}) {
  const ownMap = own || ownAddressMap(loadRegistry(ws));
  const me = String(wallet.address).toLowerCase();
  const meta = loadMetadata(ws);
  const at = isoOf(now);
  const fin = BigInt(finalized);
  const out = runOp(ws, { type: 'wallet_confirm', summary: `Wallet activity confirmed (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = eventsRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null);
    const counts = { final: 0, pending: 0, reversed: 0, classified: 0 };
    if (!doc) return counts;
    doc.txs = doc.txs || {};
    let changed = false;
    const byTx = new Map();
    for (const e of doc.events) {
      if (e.provider !== PROVIDER) continue;
      if (!byTx.has(e.tx_hash)) byTx.set(e.tx_hash, []);
      byTx.get(e.tx_hash).push(e);
    }
    const update = (e, fields, note = null) => {
      let did = false;
      for (const [k, v] of Object.entries(fields)) {
        if (JSON.stringify(e[k]) !== JSON.stringify(v)) {
          e[k] = v;
          did = true;
        }
      }
      if (did && note) e.history.push({ at, change: note });
      if (did) changed = true;
      return did;
    };
    for (const tx of Object.values(doc.txs)) {
      const all = byTx.get(tx.tx_hash) || [];
      const legs = all.filter((e) => e.kind !== 'fee');
      if (tx.reversal) {
        for (const e of all) if (update(e, { state: 'reverted' }, `reversed: ${tx.reversal.evidence}`)) counts.reversed++;
        continue;
      }
      const rc = tx.receipt;
      // Names from the token's metadata: shown as reported, and an
      // advertising name marks the leg (it never decides anything alone).
      for (const e of legs) {
        if (e.asset.native) continue;
        const m = metadataOf(meta, network, e.asset.contract);
        if (m) {
          const asset = { ...e.asset, name: m.name, symbol: m.symbol || e.asset.symbol, decimals: Number.isInteger(e.asset.decimals) ? e.asset.decimals : m.decimals };
          const amount = e.amount === null && Number.isInteger(asset.decimals) && e.amount_raw ? unitsToDecimal(e.amount_raw, asset.decimals) : e.amount;
          update(e, { asset, amount });
        }
        update(e, { suspected_spam: SUSPICIOUS_NAME.test(`${e.asset.name || ''} ${e.asset.symbol || ''}`) });
      }
      const result = classifyTx(legs, rc, { me, own: ownMap, walletId: wallet.wallet_id });
      for (const e of legs) {
        if (e.ledger.status === 'recorded') continue;
        const c = result.legs.get(e.event_key);
        if (c && update(e, { classification: c.classification, reason: c.reason }, `classified: ${c.classification}`)) counts.classified++;
      }
      if (rc) {
        for (const e of legs) update(e, { block_number: rc.block_number, block_hash: rc.block_hash, receipt_status: rc.status });
        const feeKey = `${network}:${tx.tx_hash}:fee`;
        // A fee an earlier provider saved for this transaction stays the one.
        const earlierFee = doc.events.some((e) => e.event_key === feeKey && e.provider !== PROVIDER);
        if (result.fee && !earlierFee) {
          const key = feeKey;
          let fee = all.find((e) => e.event_key === key);
          const amount = result.fee.amount_raw === null ? null : unitsToDecimal(result.fee.amount_raw, 18);
          const fields = { amount_raw: result.fee.amount_raw, amount, fee_basis: result.fee.basis, block_number: rc.block_number, block_hash: rc.block_hash, block_timestamp: tx.block_timestamp, receipt_status: rc.status, classification: amount === null ? 'unresolved' : 'gas_fee', reason: amount === null ? (result.fee.basis ? `The fee is not known exactly: ${result.fee.basis}.` : 'The receipt gives no fee.') : null };
          if (!fee && !(amount !== null && decZero(amount))) {
            fee = { event_key: key, unique_id: `${tx.tx_hash}:fee`, provider: PROVIDER, wallet_id: wallet.wallet_id, network, tx_hash: tx.tx_hash, log_index: null, kind: 'fee', internal: false, direction: 'out', asset: { native: true, contract: null, decimals: 18, symbol: NETWORKS[network].native.symbol, name: NETWORKS[network].native.name }, from: me, to: null, counterparty: null, counterparty_wallet_id: null, category: 'fee', suspected_spam: false, state: 'pending', ledger: { status: 'waiting', tx_ids: [], revision: 0 }, first_seen_at: at, last_seen_at: at, last_seen_pass: null, history: [{ at, change: 'fee from the receipt' }], ...fields };
            doc.events.push(fee);
            all.push(fee);
            changed = true;
          } else if (fee && fee.ledger.status !== 'recorded') {
            update(fee, fields);
          }
        }
        const isFinal = BigInt(rc.block_number) <= fin;
        for (const e of all) {
          if (e.state === 'reverted' && !tx.reversal) update(e, { state: 'pending' }, 'reported again');
          const next = isFinal ? 'final' : 'pending';
          if (e.state !== next && update(e, { state: next }, next === 'final' ? 'final (at or below the finalized block)' : null)) {
            if (next === 'final') counts.final++;
          }
          if (next === 'pending') counts.pending++;
        }
      }
    }
    if (changed) {
      doc.events.sort((a, b) => String(a.block_number).padStart(20, '0').localeCompare(String(b.block_number).padStart(20, '0')) || String(a.event_key).localeCompare(String(b.event_key)));
      op.writeJson(rel, doc);
    }
    return counts;
  });
  return out.result;
}

// A complete balance read: the native coin and every token balance Alchemy
// listed, saved as the last complete snapshot when it differs from the one
// before (the earlier one moves to "previous"). A token whose balance could
// not be read, or whose decimals are unknown, is kept with that note. A
// partial read is never saved as a snapshot.
function storeBalances(ws, wallet, network, { native_raw, tokens = [], block = null }, { now = Date.now() } = {}) {
  const at = isoOf(now);
  const meta = loadMetadata(ws);
  const nat = NETWORKS[network].native;
  const rows = [{ native: true, contract: null, decimals: 18, balance_raw: native_raw, balance: unitsToDecimal(native_raw, 18), symbol: nat.symbol, name: nat.name }];
  const unreadable = [];
  for (const t of tokens) {
    if (t.error) {
      unreadable.push({ contract: t.contract || null, error: t.error });
      continue;
    }
    if (t.balance_raw === '0') continue;
    const m = metadataOf(meta, network, t.contract);
    const decimals = m && Number.isInteger(m.decimals) ? m.decimals : null;
    rows.push({ native: false, contract: t.contract, decimals, balance_raw: t.balance_raw, balance: decimals === null ? null : unitsToDecimal(t.balance_raw, decimals), symbol: m ? m.symbol : null, name: m ? m.name : null, decimals_unknown: decimals === null });
  }
  rows.sort((a, b) => Number(b.native) - Number(a.native) || String(a.contract).localeCompare(String(b.contract)));
  const contentSha = sha256(JSON.stringify([rows.map((t) => [t.native, t.contract, t.decimals, t.balance_raw]), unreadable.map((u) => u.contract)]));
  const out = runOp(ws, { type: 'wallet_balances', summary: `Wallet balances read (${wallet.label}, ${NETWORKS[network].label})` }, (op) => {
    const rel = balancesRel(wallet.wallet_id, network);
    const doc = op.readJson(rel, null) || { schema_version: 'cr.wallet-balances.v1', wallet_id: wallet.wallet_id, network, last_complete: null, previous: [] };
    if (doc.last_complete && doc.last_complete.content_sha256 === contentSha) {
      doc.last_complete.confirmed_at = at;
      op.writeJson(rel, doc);
      return { changed: false };
    }
    if (doc.last_complete) doc.previous = [doc.last_complete, ...(doc.previous || [])].slice(0, MAX_PREVIOUS_SNAPSHOTS);
    doc.last_complete = { fetched_at: at, confirmed_at: at, provider: PROVIDER, methods: 'eth_getBalance + alchemy_getTokenBalances', block_number: block, content_sha256: contentSha, unreadable, tokens: rows };
    op.writeJson(rel, doc);
    return { changed: true };
  });
  return out.result;
}

// The token contracts of a wallet network that have no metadata yet (from its
// events and its last snapshot's raw balances). Details that could not be read
// (no answer, or no decimals) are asked again at most once a day, so a passing
// failure does not keep a token's transfers out of the ledger for good.
const METADATA_RETRY_MS = 24 * 3600000;
function contractsNeedingMetadata(ws, wallet, network, extra = [], { now = Date.now() } = {}) {
  const meta = loadMetadata(ws);
  const set = new Set(extra.filter(Boolean).map((c) => c.toLowerCase()));
  for (const e of loadEvents(ws, wallet.wallet_id, network)) if (!e.asset.native && e.asset.contract) set.add(e.asset.contract);
  return [...set].filter((c) => {
    const m = metadataOf(meta, network, c);
    if (!m) return true;
    const known = m.readable !== false && Number.isInteger(m.decimals);
    return !known && !(Date.parse(m.fetched_at) > now - METADATA_RETRY_MS);
  });
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
const SWAPLIKE = new Set(['swap', 'possible_swap']);

// The ledger entries one unit (a transfer leg, a swap, a fee) would make, or
// why it cannot make them yet. Pure apart from the context it is given.
function entriesFor(unit, ctx) {
  const { wallet, network } = unit;
  const first = unit.events[0];
  const date = first.block_timestamp;
  if (!date) return { hold: { code: 'incomplete', needs_decision: false, reason: 'The provider gave no block time for this transaction.' } };
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
    if (!out.length || !inn.length) return { hold: { code: 'incomplete', needs_decision: false, reason: 'Only one side of this possible swap is on record.' } };
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
// and each fee on its own, a swap (or possible swap) as one.
function unitsOf(events, wallet, network) {
  const units = [];
  const byTx = new Map();
  for (const e of events) {
    if (!byTx.has(e.tx_hash)) byTx.set(e.tx_hash, []);
    byTx.get(e.tx_hash).push(e);
  }
  for (const list of byTx.values()) {
    const swap = list.filter((e) => SWAPLIKE.has(e.classification));
    if (swap.length) units.push({ kind: 'swap', wallet, network, events: swap });
    for (const e of list) {
      if (SWAPLIKE.has(e.classification)) continue;
      units.push({ kind: e.kind === 'fee' ? 'fee' : 'transfer', wallet, network, events: [e] });
    }
  }
  return units;
}

// Why a unit is not recorded at all (never will be, as classified).
function notRecordedReason(unit, ctx) {
  const e = unit.events[0];
  if (e.classification === 'awaiting_receipt') return { code: 'waiting', reason: e.reason, later: true };
  if (unit.events.some((x) => x.suspected_spam) && unit.events.some((x) => !x.asset.native && !mapAsset(ctx.map, unit.network, x.asset).asset_id)) return { code: 'spam', reason: 'An unverified token whose name advertises a link or a claim.' };
  if (e.classification === 'failed_transfer') return { code: 'failed', reason: e.reason };
  if (e.classification === 'self_transfer') return { code: 'self', reason: e.reason };
  if (e.classification === 'unresolved') return { code: 'unresolved', reason: e.reason };
  return null;
}

// Records final, supported, mapped events in the ledger, holds the rest with
// the reason, and voids ledger entries whose event was reversed on chain
// evidence. One verified save for everything (or nothing when nothing changed).
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
        // Reversed on chain evidence, or changed, after being recorded: void
        // the entries (kept, with the reason).
        for (const e of doc.events) {
          if (e.ledger.status !== 'recorded' || !(e.state === 'reverted' || e.content_changed)) continue;
          const tx = (doc.txs || {})[e.tx_hash];
          const why = e.state === 'reverted' ? `reversed on chain: ${tx && tx.reversal ? tx.reversal.evidence : 'the provider no longer reports it'}` : 'the provider now reports different content for this transaction';
          for (const id of e.ledger.tx_ids || []) {
            const t = txs.find((x) => x.tx_id === id);
            if (t && !t.voided) {
              t.voided = true;
              t.void_reason = `Wallet sync: ${why} (${netLabel(network)} tx ${e.tx_hash})`;
              t.voided_at = at;
              ledgerChanged = true;
            }
          }
          const gone = new Set(e.ledger.tx_ids || []);
          e.ledger = { status: e.state === 'reverted' ? 'voided' : 'waiting', tx_ids: [], voided_tx_ids: e.ledger.tx_ids, revision: (e.ledger.revision || 0) + 1, at };
          e.content_changed = false;
          e.history.push({ at, change: 'ledger entries voided' });
          counts.voided++;
          changed = true;
          // The other leg of a recorded swap shared those entries: it is
          // decided again with the new content, never left pointing at them.
          for (const mate of doc.events) {
            if (mate === e || mate.ledger.status !== 'recorded' || !(mate.ledger.tx_ids || []).some((id) => gone.has(id))) continue;
            mate.ledger = { status: mate.state === 'reverted' ? 'voided' : 'waiting', tx_ids: [], voided_tx_ids: mate.ledger.tx_ids, revision: (mate.ledger.revision || 0) + 1, at };
            mate.history.push({ at, change: 'ledger entries voided with the other side of the transaction' });
          }
        }
        // Not recorded earlier (an amount or a receipt not known then) is looked
        // at again: a class that can be recorded now is recorded or held.
        const ready = doc.events.filter((e) => e.state === 'final' && ['waiting', 'held', 'not_recorded'].includes(e.ledger.status));
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
            mark('skipped', { hold: null, reason: SWAPLIKE.has(unit.events[0].classification) ? 'You chose to leave it unrecorded.' : 'You said this is already recorded.' });
            continue;
          }
          const nr = notRecordedReason(unit, ctx);
          if (nr) {
            if (nr.later) continue;
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
          // A possible swap is recorded only when Eric says so.
          if (unit.events[0].classification === 'possible_swap' && !(decision && decision.choice === 'record')) {
            mark('held', { hold: { code: 'possible_swap', needs_decision: true, reason: unit.events[0].reason } });
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
            tx.provenance = { wallet_id: w.wallet_id, network, provider: ev.provider || 'moralis', tx_hash: ev.tx_hash, block_number: ev.block_number, event_key: ev.event_key };
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

// Eric's decision on a held event: record it, or keep it out (already
// recorded, or not a swap). The next import applies it (right away from the
// dashboard).
function resolveEvent(ws, { wallet_id, network, event_key, decision, note = null }) {
  const w = walletById(ws, wallet_id);
  if (!networkInfo(network)) throw new OpError('INVALID', 'Unknown network');
  if (!['record', 'skip'].includes(decision)) throw new OpError('INVALID', 'Decide "record" (record it in the ledger) or "skip" (keep it out of the ledger).');
  const out = runOp(ws, { type: 'wallet_decision', summary: `Wallet event decision (${w.label})` }, (op) => {
    const rel = eventsRel(w.wallet_id, network);
    const doc = op.readJson(rel, null);
    const e = doc && doc.events.find((x) => x.event_key === event_key);
    if (!e) throw new OpError('NOT_FOUND', 'No such wallet event');
    if (e.ledger.status === 'recorded') throw new OpError('CONFLICT', 'Already recorded in the ledger. Use Void or Correct on the transaction itself.');
    // A swap is decided as one: every leg of the same transaction.
    const group = SWAPLIKE.has(e.classification) ? doc.events.filter((x) => x.tx_hash === e.tx_hash && SWAPLIKE.has(x.classification)) : [e];
    const at = new Date().toISOString();
    for (const x of group) {
      x.ledger = { ...x.ledger, decision: { choice: decision, at, note: note ? String(note).slice(0, 300) : null }, status: x.ledger.status === 'skipped' && decision === 'record' ? 'waiting' : x.ledger.status };
      x.history.push({ at, change: decision === 'record' ? 'you chose to record it' : SWAPLIKE.has(x.classification) ? 'you chose to leave it unrecorded' : 'you said it is already recorded' });
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
function reconcileWallet(ws, w, { map, ledger, state = null }) {
  const syncState = state || require('./walletsync').readState(ws);
  const rows = new Map();
  const missing = [];
  const historyIncomplete = [];
  const assetNets = new Map();
  const nativeNoInternal = new Set();
  const sentGaps = new Map();
  const addNet = (asset, network) => assetNets.set(asset, [...(assetNets.get(asset) || []), network]);
  for (const network of w.networks) {
    const info = NETWORKS[network];
    if (!info || !info.supported) continue;
    const st = syncState.networks[`${w.wallet_id}:${network}`] || {};
    if (!st.history_complete_to) historyIncomplete.push(network);
    if (info.coverage && !info.coverage.internal) nativeNoInternal.add(info.native.asset_id);
    const gap = sentGapOf(st);
    if (gap) sentGaps.set(info.native.asset_id, [...(sentGaps.get(info.native.asset_id) || []), `${gap} transaction(s) this wallet sent on ${info.label} are not in Alchemy's history, so their fees are not recorded`]);
    const bal = loadBalances(ws, w.wallet_id, network);
    const snap = bal && bal.last_complete;
    if (!snap) {
      missing.push(network);
      continue;
    }
    for (const t of snap.tokens) {
      if (t.balance === null || decZero(t.balance)) continue;
      const m = mapAsset(map, network, t);
      if (!m.asset_id) continue;
      const r = rows.get(m.asset_id) || { asset_id: m.asset_id, observed: '0', parts: [], unrecorded: '0', unrecorded_events: 0, decisions: 0, snapshot_at: snap.fetched_at };
      r.observed = decAdd(r.observed, t.balance);
      r.parts.push({ network, quantity: t.balance });
      if (snap.fetched_at < r.snapshot_at) r.snapshot_at = snap.fetched_at;
      rows.set(m.asset_id, r);
    }
    // The assets a network could hold for this account: its native coin and
    // the verified tokens deployed on it.
    addNet(info.native.asset_id, network);
    for (const [key, hits] of map.index) {
      if (!key.startsWith(`${info.chain_id}:`)) continue;
      for (const h of hits) addNet(h.asset_id, network);
    }
    // Movements on chain that the ledger does not have yet.
    for (const e of loadEvents(ws, w.wallet_id, network)) {
      if (e.state === 'reverted' || e.amount === null || e.direction === 'self' || e.alias_of) continue;
      if (['recorded', 'skipped'].includes(e.ledger.status)) continue;
      if (e.classification === 'failed_transfer') continue;
      if (snap && e.block_timestamp && e.block_timestamp > snap.fetched_at) continue;
      const m = mapAsset(map, network, e.asset);
      if (!m.asset_id) continue;
      const r = rows.get(m.asset_id) || { asset_id: m.asset_id, observed: '0', parts: [], unrecorded: '0', unrecorded_events: 0, decisions: 0, snapshot_at: snap ? snap.fetched_at : null };
      r.unrecorded = decAdd(r.unrecorded, signed(e));
      r.unrecorded_events++;
      if (e.ledger.status === 'held' && e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision) r.decisions++;
      rows.set(m.asset_id, r);
    }
  }
  for (const [k] of ledger) {
    const [acct, asset] = k.split('|');
    if (acct !== w.account_id || rows.has(asset) || !assetNets.has(asset)) continue;
    rows.set(asset, { asset_id: asset, observed: '0', parts: [], unrecorded: '0', unrecorded_events: 0, decisions: 0, snapshot_at: null });
  }
  const out = [];
  for (const r of rows.values()) {
    const rec = ledger.get(`${w.account_id}|${r.asset_id}`);
    const recorded = rec ? rec.quantity : '0';
    const nets = [...new Set(assetNets.get(r.asset_id) || [])];
    const difference = decSub(r.observed, recorded);
    // matches: chain and ledger agree. explained: the chain activity the
    // ledger does not have yet (pending, held, unresolved) accounts for the
    // difference exactly. awaiting_decision: held entries that may duplicate
    // your own records decide it, so no sum is guessed. incomplete: a tracked
    // network has no complete balance view, or its history is still loading.
    // history_partial: the native coin on a network whose transfer history
    // does not report ETH sent by contracts, or where the chain counts more
    // transactions sent by this wallet than the history has (their fees are
    // missing). mismatch: nothing on record explains it.
    let status;
    const notes = [];
    if (nets.some((n) => missing.includes(n))) status = 'incomplete';
    else if (decZero(difference)) status = 'matches';
    else if (nets.some((n) => historyIncomplete.includes(n))) {
      status = 'incomplete';
      notes.push('history still loading');
    } else if (r.decisions) status = 'awaiting_decision';
    else if (r.unrecorded_events && decCmp(decAdd(recorded, r.unrecorded), r.observed) === 0) status = 'explained';
    else if (nativeNoInternal.has(r.asset_id) || sentGaps.has(r.asset_id)) {
      status = 'history_partial';
      if (sentGaps.has(r.asset_id)) notes.push(...sentGaps.get(r.asset_id));
      if (nativeNoInternal.has(r.asset_id)) notes.push(`ETH sent by contracts is not reported on ${nets.filter((n) => NETWORKS[n].coverage && !NETWORKS[n].coverage.internal).map((n) => NETWORKS[n].label).join(', ')}`);
    } else status = 'mismatch';
    // Missing sent transactions are said wherever a difference is shown.
    if (status !== 'matches' && status !== 'history_partial' && sentGaps.has(r.asset_id)) notes.push(...sentGaps.get(r.asset_id));
    out.push({ wallet_id: w.wallet_id, account_id: w.account_id, asset_id: r.asset_id, observed: r.observed, recorded, difference, unrecorded: r.unrecorded, unrecorded_events: r.unrecorded_events, decisions: r.decisions || 0, parts: r.parts, networks: nets, status, notes, snapshot_at: r.snapshot_at, cost: rec ? { known_usd: rec.cost_known_exact === null ? null : D.toNumber(D.of(rec.cost_known_exact)), unknown_quantity: rec.unknown_quantity_exact } : null });
  }
  return { rows: out.sort((a, b) => a.asset_id.localeCompare(b.asset_id)), missing_snapshots: missing, history_incomplete: historyIncomplete };
}

function reconcileAll(ws, { pf, map = null, state = null } = {}) {
  const m = map || mapContext(ws);
  const ledger = ledgerByAccount(pf);
  const st = state || require('./walletsync').readState(ws);
  const rows = [];
  for (const w of listWallets(ws)) {
    if (w.status === 'removed') continue;
    rows.push(...reconcileWallet(ws, w, { map: m, ledger, state: st }).rows);
  }
  return rows;
}

const ACTIVITY_LIMIT = 40;

// Why an unverified token stays out of the main list. The provider gives no
// spam verdict, so nothing is called safe or unsafe: a name that advertises a
// link, or a token the wallet never did anything to get. A verified token or
// the native coin is never hidden, however small.
function hiddenOf(t, act) {
  if (SUSPICIOUS_NAME.test(`${t.name || ''} ${t.symbol || ''}`)) return ['suspicious', 'Its name advertises a link or a claim. No verified identity names it.'];
  if (!act || !act.initiated) return ['unsolicited', act ? 'It arrived without this wallet doing anything, and no verified identity names it. This is not a judgment that it is safe or unsafe.' : 'No activity of this wallet with it is on record, and no verified identity names it.'];
  return [null, null];
}

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
  const logoOf = (cg) => (cg && marketMod.logoFile(ws, cg) ? `/api/logos/${cg}` : null);
  for (const w of reg.wallets) {
    const recon = w.status === 'removed' ? { rows: [], missing_snapshots: [], history_incomplete: [] } : reconcileWallet(ws, w, { map, ledger, state });
    const reconByAsset = new Map(recon.rows.map((r) => [r.asset_id, r]));
    const firstSeen = state.reconciliation || {};
    for (const r of recon.rows) {
      const key = `${w.wallet_id}|${r.asset_id}`;
      reconciliation.push({ ...r, wallet_label: w.label, since: firstSeen[key] && firstSeen[key].status === r.status ? firstSeen[key].since : null });
    }
    const nets = [];
    for (const network of w.networks) {
      const info = NETWORKS[network];
      if (!info) continue;
      const bal = loadBalances(ws, w.wallet_id, network);
      const snap = bal && bal.last_complete;
      const doc = loadEventsDoc(ws, w.wallet_id, network);
      const events = doc ? doc.events.filter((e) => !e.alias_of || e.provider !== PROVIDER) : [];
      const st = status.networks[`${w.wallet_id}:${network}`] || {};
      const counts = { pending: 0, held: 0, decisions: 0, unresolved: 0, recorded: 0, reversed: 0, awaiting_receipt: 0 };
      const asked = new Set();
      for (const e of events) {
        if (e.state === 'pending') counts.pending++;
        if (e.state === 'reverted') counts.reversed++;
        if (e.classification === 'awaiting_receipt') counts.awaiting_receipt++;
        if (e.ledger.status === 'held') {
          counts.held++;
          // A possible swap is one decision, whatever its legs.
          if (e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision) asked.add(SWAPLIKE.has(e.classification) ? `swap:${e.tx_hash}` : e.event_key);
        }
        if (e.ledger.status === 'not_recorded' && e.ledger.code === 'unresolved') counts.unresolved++;
        if (e.ledger.status === 'recorded') counts.recorded++;
      }
      counts.decisions = asked.size;
      const sentSeen = sentSeenOf(doc, w.address);
      nets.push({ network, label: info.label, supported: info.supported, coverage: info.coverage, ...st, snapshot_at: snap ? snap.fetched_at : null, snapshot_confirmed_at: snap ? snap.confirmed_at || snap.fetched_at : null, block_number: snap ? snap.block_number : null, unreadable: snap && Array.isArray(snap.unreadable) ? snap.unreadable.length : 0, events: events.length, raw_months: rawMonths(ws, w.wallet_id, network).length, counts, sent_seen: sentSeen, explorer: info.explorer });
      if (w.status === 'removed' || !snap) continue;
      // Holdings: the last complete snapshot, with its age.
      const tokenActivity = new Map();
      for (const e of events) {
        if (e.kind === 'fee' || e.state === 'reverted') continue;
        const k = e.asset.native ? 'native' : e.asset.contract;
        const a = tokenActivity.get(k) || { in: 0, out: 0, initiated: false };
        a[e.direction === 'in' ? 'in' : 'out']++;
        if (e.direction === 'out' || SWAPLIKE.has(e.classification) || (e.classification === 'unresolved' && /this wallet sent/.test(e.reason || ''))) a.initiated = true;
        tokenActivity.set(k, a);
      }
      const rows = [...snap.tokens, ...((snap.unreadable || []).map((u) => ({ native: false, contract: u.contract, decimals: null, balance: null, balance_raw: null, symbol: null, name: null, unreadable: u.error })))];
      for (const t of rows) {
        if (t.balance !== null && t.balance !== undefined && decZero(t.balance)) continue;
        const m = mapAsset(map, network, t);
        const asset = m.asset_id ? m.asset : null;
        const price = asset ? portfolio.priceFor(asset, latest, ws.settings, now) : { usd: null, status: 'no_identity' };
        const value = price.exact && t.balance ? D.toNumber(D.mul(D.of(t.balance, { round: true }), price.exact)) : null;
        const r = m.asset_id ? reconByAsset.get(m.asset_id) : null;
        const act = tokenActivity.get(t.native ? 'native' : t.contract) || null;
        const [hide, hideReason] = asset || t.native ? [null, null] : hiddenOf(t, act);
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
          quantity_note: t.unreadable ? 'Balance unreadable' : t.decimals_unknown ? 'Decimals unknown' : null,
          asset_id: m.asset_id,
          verified: Boolean(asset) || t.native,
          unmapped_reason: asset ? null : m.reason,
          project_id: asset ? asset.project_id || null : null,
          symbol: asset ? asset.symbol : t.symbol,
          name: asset ? asset.name : t.name,
          reported: { symbol: t.symbol, name: t.name },
          logo_url: asset ? logoOf(asset.coingecko_id) : null,
          price: { usd: price.usd, status: price.status, as_of: price.as_of || null, age_minutes: price.age_minutes ?? null },
          value_usd: value,
          acquisition: acq,
          reconciliation: r ? { status: r.status, observed: r.observed, recorded: r.recorded, difference: r.difference, notes: r.notes } : { status: 'not_in_ledger' },
          snapshot_at: snap.fetched_at,
          hidden: hide,
          hidden_reason: hideReason,
        };
        (hide ? hidden : holdings).push(row);
      }
      for (const e of events) {
        const m = e.asset.native ? { asset_id: info.native.asset_id } : mapAsset(map, network, e.asset);
        const item = { wallet_id: w.wallet_id, wallet_label: w.label, network, network_label: info.label, event_key: e.event_key, tx_hash: e.tx_hash, block_number: e.block_number, at: e.block_timestamp, kind: e.kind, direction: e.direction, classification: e.classification, reason: e.reason, category: e.category, provider: e.provider || 'moralis', symbol: m.asset_id && map.registry.get(m.asset_id) ? map.registry.get(m.asset_id).symbol : e.asset.symbol, verified: Boolean(m.asset_id), contract: e.asset.contract, amount: e.amount, state: e.state, ledger: e.ledger, suspected_spam: e.suspected_spam, counterparty_wallet_id: e.counterparty_wallet_id, explorer_url: `${info.explorer}/tx/${e.tx_hash}` };
        activity.push(item);
        // One decision per on-chain leg (both views of a transfer between your
        // wallets share its event key), and one per possible swap, with both
        // of its legs.
        if (e.ledger.status === 'held' && e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision && !held.some((x) => x.event_key === e.event_key)) {
          const swapMate = SWAPLIKE.has(e.classification) ? held.find((x) => x.tx_hash === e.tx_hash && SWAPLIKE.has(x.classification) && x.wallet_id === w.wallet_id) : null;
          if (swapMate) swapMate.swap_legs.push({ direction: e.direction, amount: e.amount, symbol: item.symbol, verified: item.verified });
          else held.push({ ...item, swap_legs: SWAPLIKE.has(e.classification) ? [{ direction: e.direction, amount: e.amount, symbol: item.symbol, verified: item.verified }] : null });
        }
      }
    }
    wallets.push({ wallet_id: w.wallet_id, label: w.label, address: w.address, address_short: shortAddress(w.address), account_id: w.account_id, status: w.status, created_at: w.created_at, paused_at: w.paused_at, removed_at: w.removed_at, networks: nets, missing_snapshots: recon.missing_snapshots, history_incomplete: recon.history_incomplete });
  }
  activity.sort((a, b) => String(b.at).localeCompare(String(a.at)) || String(a.event_key).localeCompare(String(b.event_key)));
  holdings.sort((a, b) => (b.value_usd ?? -1) - (a.value_usd ?? -1) || Number(b.verified) - Number(a.verified) || String(a.symbol).localeCompare(String(b.symbol)));
  const priced = holdings.filter((r) => r.value_usd !== null);
  const lastSuccess = Object.values(status.networks).map((n) => n.last_success_at).filter(Boolean).sort().pop() || null;
  return {
    provider: { name: 'Alchemy', ...alchemy.keyStatus() },
    settings: { enabled: cfg.enabled, interval_minutes: cfg.interval_minutes, interval_words: intervalWords(cfg.interval_minutes), balance_refresh_minutes: cfg.balance_refresh_minutes, daily_cu_cap: cfg.daily_cu_cap, monthly_cu_cap: cfg.monthly_cu_cap },
    sync: status.summary,
    estimate: sync.estimateUsage(ws),
    networks_supported: Object.entries(NETWORKS).filter(([, n]) => n.supported).map(([id, n]) => ({ id, label: n.label, native: n.native.symbol, internal: n.coverage.internal })),
    networks_unsupported: Object.entries(NETWORKS).filter(([, n]) => !n.supported).map(([id, n]) => ({ id, label: n.label })),
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
  const state = sync.readState(ws);
  const status = sync.statusOf(ws, { now, state });
  for (const w of reg.wallets) {
    if (w.status === 'removed') continue;
    const asked = new Set();
    let voided = 0;
    for (const network of w.networks) {
      if (!networkInfo(network)) continue;
      for (const e of loadEvents(ws, w.wallet_id, network)) {
        if (e.ledger.status === 'held' && e.ledger.hold && e.ledger.hold.needs_decision && !e.ledger.decision) asked.add(SWAPLIKE.has(e.classification) ? `swap:${e.tx_hash}` : e.event_key);
        if (e.ledger.status === 'voided') voided++;
      }
      const st = status.networks[`${w.wallet_id}:${network}`];
      if (w.status === 'active' && st && ['stale', 'failing', 'unavailable'].includes(st.state) && status.summary.configured) out.push({ kind: 'wallet_sync', severity: 'medium', project_id: null, title: `Wallet ${w.label} on ${NETWORKS[network].label}: ${st.words}`, detail: st.last_error || 'The last good view stays on screen with its age.', action: '#/portfolio?tab=wallets' });
      if (w.status === 'active' && st && st.history_gap) out.push({ kind: 'wallet_history_gap', severity: 'low', project_id: null, title: `Wallet ${w.label} on ${NETWORKS[network].label}: history incomplete`, detail: `${st.history_gap} transaction(s) this wallet sent are not in Alchemy's history, so their fees are not recorded. The balance difference stays visible.`, action: '#/portfolio?tab=wallets' });
      if (w.status === 'active' && st && st.state === 'unsupported') out.push({ kind: 'wallet_unsupported', severity: 'low', project_id: null, title: `Wallet ${w.label}: ${NETWORKS[network].label} is not read`, detail: 'Alchemy\'s transfer history does not cover it; its earlier records stay as they are.', action: '#/portfolio?tab=wallets' });
    }
    const decisions = asked.size;
    if (decisions) out.push({ kind: 'wallet_decision', severity: 'medium', project_id: null, title: `Wallet ${w.label}: ${decisions} transaction(s) wait for your decision`, detail: 'A possible swap, an overlap with an asset you recorded in that account yourself, or a possible move between your accounts.', action: '#/portfolio?tab=wallets' });
    if (voided) out.push({ kind: 'wallet_reversed', severity: 'medium', project_id: null, title: `Wallet ${w.label}: ${voided} recorded transaction(s) were reversed on chain`, detail: 'Their ledger entries were voided with the evidence; nothing was deleted.', action: '#/portfolio?tab=wallets' });
  }
  try {
    const mismatches = reconcileAll(ws, { pf, state }).filter((r) => r.status === 'mismatch');
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
    const dirs = listDir(ws.abs(`${DIR}/${w.wallet_id}`), { dirs: true });
    for (const network of Object.keys(NETWORKS)) {
      if (!dirs.includes(network)) continue;
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
  METADATA_REL,
  NETWORKS,
  SOURCE,
  NAMESPACE,
  PROVIDER,
  WALLET_ID_RE,
  networkInfo,
  intervalWords,
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
  loadEventsDoc,
  loadBalances,
  loadMetadata,
  storeMetadata,
  contractsNeedingMetadata,
  legOf,
  sentSeenOf,
  sentGapOf,
  classifyTx,
  storeTransfers,
  receiptsToCheck,
  storeReceipts,
  settleNetwork,
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
