'use strict';
// Words for "Set cost" (item 45): what the corrected date does. Reads the two
// ledger entries the standard correction left (the voided original and its
// copy) and writes nothing; core/portfolio.js is untouched.

function costDateWords(txs, result) {
  const byId = new Map(txs.map((t) => [t.tx_id, t]));
  const was = byId.get(result && result.voided);
  const now = byId.get(result && result.added);
  if (!was || !now) return { original_date: null, corrected_date: null, date_changed: null, words: 'The dates of the original and the corrected entry could not be read back.' };
  const original = String(was.date);
  const corrected = String(now.date);
  const changed = original !== corrected;
  const words = changed
    ? `The original entry was dated ${original}; it is now dated ${corrected}. The units count as held from ${corrected} instead of ${original}, so holdings and results between the two dates change.`
    : `The entry keeps its date, ${original}: the original date is kept, and only the cost is set. Holdings and results by date do not change.`;
  return { original_date: original, corrected_date: corrected, date_changed: changed, words };
}

module.exports = { costDateWords };
