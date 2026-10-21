// What "Needs attention" counts in Portfolio, one rule for the rail's count
// and the page's tab (2026-10-21): one per row the page shows. Each ledger
// warning is a row, except the notes of imported wallet activity (a price
// the chain does not give, units sent to or from outside your accounts),
// which are one row together; notes you accepted as unknown leave it (core/
// portfolio.js acceptUnknown: nothing is priced or recorded, and a later
// note comes back). Each quarantined record counts, and each wallet with
// events waiting for your decision. Pure, for the tests.

export const WALLET_NOTE_KINDS = new Set(['external_deposit', 'external_transfer_out', 'unknown_basis', 'unknown_proceeds']);
export const isWalletNote = (w) => Boolean(w) && w.source === 'wallet_sync' && WALLET_NOTE_KINDS.has(w.kind);
export const warningKey = (w) => `${w.kind}:${w.tx_id || ''}:${w.asset_id || ''}`;

// The ledger's warnings still open: every warning except the wallet-import
// notes accepted as unknown.
export function openWarnings(pf) {
  const accepted = new Set((pf && pf.acknowledged && pf.acknowledged.keys) || []);
  return ((pf && pf.warnings) || []).filter((w) => !(isWalletNote(w) && accepted.has(warningKey(w))));
}

export function needsCount(index) {
  if (!index) return 0;
  const pf = index.portfolio || {};
  const open = openWarnings(pf);
  const notes = open.filter(isWalletNote).length;
  const wallet = (index.attention || []).filter((a) => a.kind === 'wallet_decision').length;
  return open.length - notes + (notes ? 1 : 0) + (pf.quarantine || []).length + wallet;
}
