// The Paper card in Research > Outcomes (core/paper.js `book`): open and closed
// positions apart, each return against BTC (unknown said, never 0), and the
// shadow gate, the receipts that took no risk with what the price did since.
// Pure, for the view and the tests; it never fetches or writes. No total,
// median or hit rate appears before the book's own summary has one (20 closed).

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function pctText(x) {
  return isNum(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}%` : '—';
}

const byDecidedDesc = (a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || ''));

// Positions in three groups: open, closed, voided (voided kept apart, never
// deleted). Newest decision first.
export function splitPositions(book) {
  const list = Array.isArray(book && book.positions) ? book.positions : [];
  const pick = (state) => list.filter((x) => x.state === state).sort(byDecidedDesc);
  return { open: pick('open'), closed: pick('closed'), voided: pick('voided') };
}

// A position's return in words and tone; "—" with the reason when unknown.
export function returnWords(position) {
  const r = position && position.return;
  if (!r || r.status === 'unknown') return { text: '—', tone: '', title: r ? r.why : 'No return.' };
  const vs = r.btc_return_pct === null || r.btc_return_pct === undefined ? r.btc_note : `BTC ${pctText(r.btc_return_pct)}, against BTC ${pctText(r.vs_btc_pct)}`;
  return { text: pctText(r.return_pct), tone: r.return_pct > 0 ? 'pos' : r.return_pct < 0 ? 'neg' : '', title: `${r.status === 'realized' ? 'Realized' : 'Unrealized'}; ${vs}` };
}

// The book's summary line: the counts, then its own note or median.
export function summaryLine(book) {
  const c = (book && book.counts) || { open: 0, closed: 0, voided: 0 };
  const s = (book && book.summary) || {};
  const tail = s.note || (isNum(s.median_vs_btc_pct) ? `${s.closed} closed · median ${pctText(s.median_vs_btc_pct)} against BTC · ${s.beat_btc} of ${s.of} beat BTC` : '');
  return `${c.open} open · ${c.closed} closed${c.voided ? ` · ${c.voided} voided` : ''}${tail ? ` · ${tail}` : ''}`;
}

// The shadow gate's rows, newest first: each receipt that took no risk with the
// price's change since (unknown said), its change against BTC, and whether the
// price rose, which is a fact about the price and says nothing about the gate.
export function shadowRows(book) {
  const list = Array.isArray(book && book.shadow_gate) ? book.shadow_gate : [];
  return list.slice().sort((a, b) => String(b.saved_at || '').localeCompare(String(a.saved_at || ''))).map((x) => {
    const s = x.since || { status: 'unknown', why: 'No reading.' };
    const measured = s.status === 'measured';
    return {
      project_id: x.project_id,
      name: x.name || x.project_id,
      receipt_id: x.receipt_id,
      saved_at: x.saved_at,
      kind: x.kind,
      line: x.line,
      proposal_type: x.proposal_type || null,
      change_text: measured ? pctText(s.change_pct) : '—',
      vs_btc_text: measured ? pctText(s.vs_btc_pct) : '—',
      tone: measured ? (s.change_pct > 0 ? 'pos' : s.change_pct < 0 ? 'neg' : '') : '',
      title: measured ? `From $${s.from_price_usd} (${s.from_at}) to $${s.to_price_usd} (${s.to_at}); ${s.btc_change_pct === null ? s.btc_note : `BTC ${pctText(s.btc_change_pct)}`}` : s.why,
    };
  });
}

// How many shadow rows the price rose after, of those measured: counts only,
// no rate and no verdict on the gate.
export function shadowCounts(book) {
  const rows = (Array.isArray(book && book.shadow_gate) ? book.shadow_gate : []);
  const measured = rows.filter((x) => x.since && x.since.status === 'measured');
  return { total: rows.length, measured: measured.length, rose: measured.filter((x) => x.since.change_pct > 0).length, unknown: rows.length - measured.length };
}
