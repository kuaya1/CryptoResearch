'use strict';
// The Paper Book cell of the Desk status strip (issue #49): one small numeric
// summary of the paper book, computed from rows already read, so the strip can
// show it without reading anything itself.
//
//   open exposure  the paper risk (risk_usd) of the positions still open; a
//                  voided or closed position adds nothing. Never money: paper
//                  positions live apart from the portfolio and wallets, and
//                  this module reads neither.
//   30-day vs BTC  the outcomes measured at 30 days (a report outcome's
//                  horizons entry for 30 days with status "measured"): how
//                  many, their median vs_btc_pct and how many beat BTC.
//
// Pure: no file, network or clock; missing or malformed input gives zeros with
// the counts that say so (matured_30d 0 means the median is no result), and
// never throws.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function vsBtc30(row) {
  const horizons = row && Array.isArray(row.horizons) ? row.horizons : [];
  const h = horizons.find((x) => x && x.days === 30 && x.status === 'measured');
  return h && isNum(h.vs_btc_pct) ? h.vs_btc_pct : null;
}

function computePaperBookSummary(outcomes) {
  const rows = (Array.isArray(outcomes) ? outcomes : []).filter((r) => r && typeof r === 'object');
  const open = rows.filter((r) => r.state === 'open' && isNum(r.risk_usd) && r.risk_usd > 0);
  const vs = rows.map(vsBtc30).filter(isNum);
  return {
    open_positions: open.length,
    open_exposure_usd: round(open.reduce((s, r) => s + r.risk_usd, 0)),
    matured_30d: vs.length,
    median_vs_btc_30d_pct: vs.length ? round(median(vs)) : 0,
    beat_btc_30d: vs.filter((x) => x > 0).length,
  };
}

module.exports = { computePaperBookSummary };
