'use strict';
// Chains as project identities name them ("ethereum", "bsc", "bnb-chain",
// "solana", ...), mapped to a stable chain ID: the EVM chain ID (as a string),
// "tron", or "solana". The screening module uses it to reach GoPlus Security,
// which lists these chains for token security (GET
// https://api.gopluslabs.io/api/v1/supported_chains?name=token_security,
// checked 2026-10-04; Solana has its own endpoint). A chain not listed here is
// "not screenable": nothing is guessed from a similar name.

// [chain_id, label, family, aliases...] — aliases are lowercase, as
// projects.js normalizes chain names.
const TABLE = [
  ['1', 'Ethereum', 'evm', 'ethereum', 'eth', 'mainnet', 'ethereum-mainnet', 'erc20', 'erc-20'],
  ['56', 'BNB Smart Chain', 'evm', 'bsc', 'bnb', 'bnb-chain', 'bnbchain', 'bnb-smart-chain', 'binance-smart-chain', 'binance', 'bep20', 'bep-20'],
  ['42161', 'Arbitrum One', 'evm', 'arbitrum', 'arbitrum-one', 'arb'],
  ['137', 'Polygon', 'evm', 'polygon', 'polygon-pos', 'matic'],
  ['204', 'opBNB', 'evm', 'opbnb'],
  ['324', 'zkSync Era', 'evm', 'zksync', 'zksync-era'],
  ['59144', 'Linea', 'evm', 'linea'],
  ['8453', 'Base', 'evm', 'base'],
  ['5000', 'Mantle', 'evm', 'mantle'],
  ['130', 'Unichain', 'evm', 'unichain'],
  ['48900', 'Zircuit', 'evm', 'zircuit'],
  ['534352', 'Scroll', 'evm', 'scroll'],
  ['10', 'Optimism', 'evm', 'optimism', 'op-mainnet', 'op'],
  ['43114', 'Avalanche C-Chain', 'evm', 'avalanche', 'avax', 'avalanche-c', 'avalanche-c-chain'],
  ['25', 'Cronos', 'evm', 'cronos'],
  ['100', 'Gnosis', 'evm', 'gnosis', 'xdai'],
  ['321', 'KCC', 'evm', 'kcc'],
  ['1514', 'Story', 'evm', 'story'],
  ['1868', 'Soneium', 'evm', 'soneium'],
  ['143', 'Monad', 'evm', 'monad'],
  ['9745', 'Plasma', 'evm', 'plasma'],
  ['1030', 'Conflux eSpace', 'evm', 'conflux', 'conflux-espace'],
  ['4663', 'Robinhood Chain', 'evm', 'robinhood', 'robinhood-chain'],
  ['988', 'Stable', 'evm', 'stable'],
  ['146', 'Sonic', 'evm', 'sonic'],
  ['2741', 'Abstract', 'evm', 'abstract'],
  ['177', 'HashKey Chain', 'evm', 'hashkey', 'hashkey-chain'],
  ['80094', 'Berachain', 'evm', 'berachain', 'bera'],
  ['480', 'World Chain', 'evm', 'world-chain', 'worldchain'],
  ['2818', 'Morph', 'evm', 'morph'],
  ['1625', 'Gravity', 'evm', 'gravity'],
  ['196', 'X Layer', 'evm', 'x-layer', 'xlayer'],
  ['200901', 'Bitlayer', 'evm', 'bitlayer'],
  ['4200', 'Merlin', 'evm', 'merlin'],
  ['169', 'Manta Pacific', 'evm', 'manta', 'manta-pacific'],
  ['81457', 'Blast', 'evm', 'blast'],
  ['tron', 'Tron', 'tron', 'tron', 'trx', 'trc20', 'trc-20'],
  ['solana', 'Solana', 'solana', 'solana', 'sol', 'spl'],
];

const BY_ALIAS = new Map();
const BY_ID = new Map();
for (const [id, label, family, ...aliases] of TABLE) {
  const info = Object.freeze({ chain_id: id, label, family });
  BY_ID.set(id, info);
  for (const a of aliases) BY_ALIAS.set(a, info);
}

// What a chain name (or a chain ID) means for screening, or null when the
// chain is not one GoPlus screens. Pure.
function chainInfo(name) {
  if (name === null || name === undefined) return null;
  const key = String(name).trim().toLowerCase();
  if (!key) return null;
  return BY_ALIAS.get(key) || BY_ID.get(key) || null;
}

// Whether an address has the shape its chain family uses. Never a checksum
// test, only the shape, so a typo is refused before any request is sent.
const ADDRESS = {
  evm: /^0x[0-9a-fA-F]{40}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};
function addressFits(family, address) {
  const re = ADDRESS[family];
  return Boolean(re && typeof address === 'string' && re.test(address.trim()));
}

// The form an address is compared and keyed in: EVM lowercased, the others as
// written (base58 is case-sensitive).
function addressKey(family, address) {
  const a = String(address || '').trim();
  return family === 'evm' ? a.toLowerCase() : a;
}

module.exports = { TABLE, chainInfo, addressFits, addressKey };
