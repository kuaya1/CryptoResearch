'use strict';
// Published deployments for `contracts init-defaults` (Eric, 2026-10-30):
// Uniswap V2 and V3 on Ethereum, Base, Arbitrum One and OP Mainnet, the
// canonical Safe v1.3.0 and v1.4.1 singletons, and conservative network-fee
// ceilings. Every address and hash below was read back from the chain on
// 2026-10-30 before it was written here: each V3 row's CREATE2 address
// matched its factory's getPool(USDC, WETH, 500) and its four fee tiers are
// enabled; each V2 row's matched getPair(USDC, WETH); each QuoterV2's
// factory() and WETH9() matched its chain, and its code hash is the
// Keccak-256 of its runtime code; each Safe singleton's runtime code hash and
// VERSION() were read on all four chains (the canonical and the EIP-155
// deployments of v1.3.0 share their code). Native USDC (6 decimals, $1) is
// the one quote asset. A new venue or chain is a new published row, never a
// guess.

const CHAINS = Object.freeze({ 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum One', 10: 'OP Mainnet' });

const USDC = Object.freeze({
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
});

const V3_INIT_CODE_HASH = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54';
const V3 = Object.freeze({
  1: { factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', quoter_code_hash: '0x06148f47d0f41a68d3bc970030a7150e5d608cfbc28d372440a2e41ce543d92b' },
  8453: { factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd', quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a', quoter_code_hash: '0xceb5b8bc35e09fc64b1c48c6b920e0d2e37d5710e4f3ef214e1a81f75acee51e' },
  42161: { factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', quoter_code_hash: '0xd8162b13ba57ce21a146063b10658bda0a3fd15c99f768c86283fce6640858a5' },
  10: { factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', quoter_code_hash: '0xd833dcf44a912014423afa2b637f23b5db5b7dc492494cbe3f46026a6d57b424' },
});

const V2_INIT_CODE_HASH = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f';
const V2 = Object.freeze({
  1: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
  8453: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6',
  42161: '0xf1d7cc64fb4452f05c498126312ebe29f30fbcf9',
  10: '0x0c3c1c532f1e39edf36be9fe0be1410313e074bf',
});

const quotes = (id) => [{ address: USDC[id], decimals: 6, usd_value: '1', symbol: 'USDC' }];

const POOL_FACTORIES = Object.freeze(Object.keys(CHAINS).flatMap((id) => [
  { chain_id: id, kind: 'v3', name: `Uniswap V3 (${CHAINS[id]})`, source_url: 'https://docs.uniswap.org/contracts/v3/reference/deployments/', factory: V3[id].factory, init_code_hash: V3_INIT_CODE_HASH, fee_tiers: [100, 500, 3000, 10000], quoter: V3[id].quoter, quoter_code_hash: V3[id].quoter_code_hash, quotes: quotes(id) },
  { chain_id: id, kind: 'v2', name: `Uniswap V2 (${CHAINS[id]})`, source_url: 'https://docs.uniswap.org/contracts/v2/reference/smart-contracts/v2-deployments', factory: V2[id], init_code_hash: V2_INIT_CODE_HASH, fee_bps: 30, quotes: quotes(id) },
]));

// Runtime code hashes of the Safe singletons (Safe and SafeL2), the same on
// all four chains.
const SAFE_SINGLETON_CODE_HASHES = Object.freeze([
  '0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e', // v1.3.0 Safe
  '0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f', // v1.3.0 SafeL2
  '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4', // v1.4.1 Safe
  '0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff', // v1.4.1 SafeL2
]);

// Eric's conservative ceilings (USD per exit transaction).
const NETWORK_FEE_CEILING_USD = Object.freeze({ 1: 5, 8453: 0.25, 42161: 0.25, 10: 0.25 });

const rowKey = (r) => `${r.chain_id}:${r.kind}:${String(r.factory).toLowerCase()}`;

// The settings patch that adds what is missing to Eric's contracts settings,
// never removing or replacing his own: a factory row he has (same chain, kind
// and factory) is kept as he set it, and so is a fee ceiling he chose. Null
// when there is nothing to add. Pure; validated by validateSettingsPatch.
function plan(settings) {
  const c = (settings && settings.contracts) || {};
  const rows = Array.isArray(c.pool_factories) ? c.pool_factories : [];
  const have = new Set(rows.map(rowKey));
  const addRows = POOL_FACTORIES.filter((r) => !have.has(rowKey(r)));
  const hashes = Array.isArray(c.safe_singleton_code_hashes) ? c.safe_singleton_code_hashes.map((h) => String(h).toLowerCase()) : [];
  const addHashes = SAFE_SINGLETON_CODE_HASHES.filter((h) => !hashes.includes(h));
  const fees = c.network_fee_ceiling_usd && typeof c.network_fee_ceiling_usd === 'object' && !Array.isArray(c.network_fee_ceiling_usd) ? c.network_fee_ceiling_usd : {};
  const addFees = Object.fromEntries(Object.entries(NETWORK_FEE_CEILING_USD).filter(([id]) => fees[id] === undefined));
  const contracts = {};
  if (addRows.length) contracts.pool_factories = [...rows, ...addRows];
  if (addHashes.length) contracts.safe_singleton_code_hashes = [...hashes, ...addHashes];
  if (Object.keys(addFees).length) contracts.network_fee_ceiling_usd = { ...fees, ...addFees };
  return {
    patch: Object.keys(contracts).length ? { contracts } : null,
    added: { pool_factories: addRows.map((r) => r.name), safe_singleton_code_hashes: addHashes.length, network_fee_ceiling_usd: addFees },
    kept: { pool_factories: rows.length, safe_singleton_code_hashes: hashes.length, network_fee_ceiling_usd: Object.keys(fees).length },
  };
}

module.exports = { CHAINS, USDC, V2, V3, V2_INIT_CODE_HASH, V3_INIT_CODE_HASH, POOL_FACTORIES, SAFE_SINGLETON_CODE_HASHES, NETWORK_FEE_CEILING_USD, plan };
