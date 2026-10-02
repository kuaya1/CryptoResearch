// Position-cycle views: the market-context strip on the watchlist, each model's
// position and timing view, and "add a model's suggested review to my reviews".
// Everything here describes what was recorded; nothing is a verdict, a forecast
// or an instruction to trade. Missing values are said in words, never as zero.
import { h, button, toast, fmtPrice, fmtCompactUsd, fmtDate, fmtDateTime, fmtAgo, fmtSignedPct, changeCell, stateText, submissionId, PROVIDER_LABELS } from './ui.js';

export const CERTAINTY_LABELS = {
  unknown: 'certainty unknown',
  project_claimed: 'project-claimed',
  source_documented: 'source-documented',
  analyst_inferred: 'analyst inference',
};
const EXCLUSION_LABELS = {
  bitcoin: 'Bitcoin itself',
  stablecoin: 'stablecoins and dollar-pegged tokens',
  commodity_backed: 'gold-backed tokens',
  tokenized_fund: 'tokenized funds (T-bills, money-market, credit)',
  derivative: 'wrapped, staked or bridged versions of other coins',
  invalid: 'rows without a usable price',
};

const pct = (n) => (n === null || n === undefined || Number.isNaN(n) ? 'unknown' : fmtSignedPct(n));

function windowText(w) {
  if (!w) return 'date unknown';
  if (w.window_start && w.window_end && w.window_start !== w.window_end) return `${fmtDate(w.window_start)} – ${fmtDate(w.window_end)}`;
  if (w.window_start || w.window_end) return fmtDate(w.window_start || w.window_end);
  return 'date unknown';
}

// ---- watchlist: one line of market context ----------------------------------

export function marketStrip(idx) {
  const mc = idx && idx.market_context;
  if (!mc) return null;
  const s = mc.snapshot;
  if (!s) {
    const text = mc.status === 'off'
      ? 'Market context is off in settings.'
      : mc.freshness && mc.freshness.last_error
        ? `Market context not captured yet (last attempt: ${mc.freshness.last_error}).`
        : 'Market context not captured yet. It is fetched with prices, about once an hour.';
    return h('div', { class: 'mc-strip', role: 'note', 'aria-label': 'Market context' }, h('span', { class: 'mc-label' }, 'Market'), h('span', { class: 'muted' }, text));
  }
  const demo = s.provider === 'fictional-demo';
  const b30 = s.breadth && s.breadth.d30;
  const stale = mc.status === 'stale';
  const breadth = b30 && b30.beating_btc !== null && b30.beating_btc !== undefined
    ? h('span', { class: 'mc-item', title: 'Of the large coins counted, how many rose more than Bitcoin over 30 days. Open "What is this?" for the universe and exclusions.' },
      h('strong', null, `${b30.beating_btc} of ${b30.counted}`), ` large coins beat BTC over 30D (${b30.share_pct}%)`)
    : h('span', { class: 'mc-item muted' }, 'breadth unknown');
  const explain = h('details', { class: 'mc-explain', dataset: { key: 'mc-explain' } },
    h('summary', null, 'What is this?'),
    h('div', { class: 'mc-explain-body' },
      h('p', null, 'A dated snapshot of the whole market, captured by this dashboard and given to every new research run. It describes conditions; it is not a forecast and not a call on "altcoin season".'),
      h('dl', { class: 'facts' },
        h('div', null, h('dt', null, 'BTC, 7D'), h('dd', null, changeCell(s.bitcoin.change_7d_pct, { label: 'Bitcoin over 7 days' }))),
        h('div', null, h('dt', null, 'BTC, 30D'), h('dd', null, changeCell(s.bitcoin.change_30d_pct, { label: 'Bitcoin over 30 days' }))),
        h('div', null, h('dt', null, 'BTC dominance'), h('dd', null, s.dominance.btc_pct !== null ? `${s.dominance.btc_pct.toFixed(1)}%` : 'unknown')),
        h('div', null, h('dt', null, 'ETH dominance'), h('dd', null, s.dominance.eth_pct !== null && s.dominance.eth_pct !== undefined ? `${s.dominance.eth_pct.toFixed(1)}%` : 'unknown')),
        s.ethereum ? h('div', null, h('dt', null, 'ETH vs BTC, 30D'), h('dd', null, changeCell(s.ethereum.vs_btc_30d_pct, { label: 'Ethereum against Bitcoin over 30 days' }))) : null,
        h('div', null, h('dt', null, 'Total market cap'), h('dd', null, fmtCompactUsd(s.total_market.market_cap_usd))),
        b30 ? h('div', null, h('dt', null, 'Median coin vs BTC, 30D'), h('dd', null, pct(b30.median_vs_btc_pct))) : null,
        s.breadth.d7 && s.breadth.d7.beating_btc !== null ? h('div', null, h('dt', null, 'Beat BTC over 7D'), h('dd', null, `${s.breadth.d7.beating_btc} of ${s.breadth.d7.counted} (${s.breadth.d7.share_pct}%)`)) : null),
      h('p', { class: 'small', style: { marginTop: '10px' } }, h('strong', null, 'Universe. '), s.breadth.universe, ` ${s.breadth.counted} of ${s.breadth.considered} counted.`),
      h('p', { class: 'small' }, h('strong', null, 'Left out: '), Object.entries(s.breadth.excluded || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${EXCLUSION_LABELS[k] || k}`).join('; ') || 'nothing', '.'),
      h('p', { class: 'small' }, h('strong', null, 'Definitions. '), s.breadth.definition, ' ', s.dominance.definition),
      h('p', { class: 'small faint' }, `${demo ? 'FICTIONAL demo snapshot' : 'Source: CoinGecko /global and /coins/markets (top 100 by market cap)'} · snapshot ${s.snapshot_id} · captured ${fmtDateTime(s.captured_at)}`)));
  return h('div', { class: `mc-strip${stale ? ' stale' : ''}`, role: 'note', 'aria-label': 'Market context' },
    h('span', { class: 'mc-label' }, demo ? 'Market (demo)' : 'Market'),
    h('span', { class: 'mc-item' }, 'BTC ', h('strong', null, `$${Math.round(s.bitcoin.price_usd).toLocaleString('en-US')}`), ' · 7D ', changeCell(s.bitcoin.change_7d_pct, { label: 'Bitcoin over 7 days' }), ' · 30D ', changeCell(s.bitcoin.change_30d_pct, { label: 'Bitcoin over 30 days' })),
    h('span', { class: 'mc-item' }, 'BTC dominance ', h('strong', null, s.dominance.btc_pct !== null ? `${s.dominance.btc_pct.toFixed(1)}%` : 'unknown')),
    breadth,
    h('span', { class: `mc-item ${stale ? 'freshness stale' : 'faint'}` }, `as of ${fmtDateTime(s.as_of)}${stale ? ` · stale (${fmtAgo(s.captured_at)})` : ''}`),
    explain);
}

// ---- summary panel and scorecard: one model's position view ----------------

// [label, value] pairs for the summary panel's model section.
export function positionFacts(ctx, p, prov, rep) {
  const pos = rep && rep.position;
  if (!pos) return [];
  if (pos.status === 'not_in_recipe') return [['Timing view', h('span', { class: 'faint' }, 'Not in this report (written before the position recipe)')]];
  if (pos.status === 'missing') return [['Timing view', h('span', { class: 'faint' }, 'Missing: the report has no position block')]];
  const out = [];
  out.push(['Timing', h('span', null, h('span', { class: 'tl-chip' }, pos.timing_label), pos.timing_rationale ? h('span', { class: 'small muted' }, ` ${short(pos.timing_rationale, 160)}`) : null)]);
  out.push(['Market view', h('span', null, pos.market_label, h('span', { class: 'faint small' }, ' (the model\'s reading)'))]);
  if (pos.next_catalyst) out.push(['Next catalyst', `${pos.next_catalyst.title} · ${windowText(pos.next_catalyst)} · ${CERTAINTY_LABELS[pos.next_catalyst.certainty] || 'certainty unknown'}`]);
  if (pos.next_review_date) out.push(['Suggested review', suggestedReview(ctx, p, prov, pos)]);
  if (pos.horizon_matches_run === false) out.push(['Check', 'This report\'s horizon differs from its research run\'s.']);
  return out;
}

function short(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The model's suggested review date, with one action: put it on my calendar.
function suggestedReview(ctx, p, prov, pos) {
  const when = h('span', null, fmtDate(pos.next_review_date), pos.review_in_days !== null && pos.review_in_days !== undefined ? h('span', { class: 'faint' }, pos.review_in_days < 0 ? ' · passed' : pos.review_in_days === 0 ? ' · today' : ` · in ${pos.review_in_days} d`) : null);
  const covered = p.next_review && p.next_review.date && p.next_review.date <= pos.next_review_date;
  const wrap = h('span', { class: 'sr-wrap' }, when);
  if (pos.review_trigger) wrap.append(h('span', { class: 'small muted sr-trigger' }, `Sooner if: ${short(pos.review_trigger, 160)}`));
  if (covered) {
    wrap.append(h('span', { class: 'small faint sr-trigger' }, p.next_review.date === pos.next_review_date ? 'On your reviews.' : `Your next review (${fmtDate(p.next_review.date)}) comes first.`));
    return wrap;
  }
  if (pos.review_in_days !== null && pos.review_in_days < 0) return wrap;
  const add = button('Add to my reviews', null, { kind: 'small', key: `add-review-${p.project_id}-${prov}` });
  add.setAttribute('aria-label', `Add ${fmtDate(pos.next_review_date)}, ${PROVIDER_LABELS[prov]}'s suggested review date, to your reviews`);
  const sid = submissionId();
  add.onclick = async () => {
    add.disabled = true;
    try {
      const r = await ctx.api.post(`/api/scopes/${encodeURIComponent(p.project_id)}/events`, {
        type: 'review',
        title: `Review thesis (${PROVIDER_LABELS[prov]} suggested this date)`,
        due: pos.next_review_date,
        note: pos.review_trigger ? `Sooner if: ${pos.review_trigger}` : null,
        submission_id: sid,
      });
      toast(r.status === 'exists' ? 'That review is already on your calendar.' : `Review added for ${fmtDate(pos.next_review_date)}.`);
      await ctx.refresh();
    } catch (err) {
      toast(err.message, 'bad');
      add.disabled = false;
    }
  };
  wrap.append(add);
  return wrap;
}

// One short line for the hover scorecard.
export function previewTiming(rep) {
  const pos = rep && rep.position;
  if (!pos || pos.status !== 'provided') return null;
  return `${pos.timing_label}${pos.next_review_date ? ` · review ${fmtDate(pos.next_review_date)}` : ''}`;
}

// The project's own price against Bitcoin's, for the summary panel.
export function vsBtcFacts(m) {
  const v = m && m.vs_btc;
  if (!v) return [];
  return [
    h('div', { title: v.definition }, h('dt', null, 'vs BTC, 7D'), h('dd', null, changeCell(v.vs_btc_7d_pct, { label: 'against Bitcoin over 7 days' }))),
    h('div', { title: v.definition }, h('dt', null, 'vs BTC, 30D'), h('dd', null, changeCell(v.vs_btc_30d_pct, { label: 'against Bitcoin over 30 days' }))),
  ];
}

// ---- project page: the full position card for one report --------------------

export function positionCard(assessment, provider) {
  const pc = assessment && assessment.position_context;
  if (!pc) {
    const note = assessment && assessment.prompt_version === 'cr-research-prompt@3'
      ? 'This report was asked for a position block (market view, timing view, review date) and did not give one, so those views are unknown.'
      : 'This report was written before the position recipe, so it has no market, timing or review view. Nothing is inferred for it.';
    return h('div', { class: 'card pos-card' }, h('h3', null, 'Position and timing'), h('p', { class: 'small muted', style: { margin: 0 } }, note));
  }
  const rows = [];
  const add = (k, v) => rows.push(h('dt', null, k), h('dd', null, v));
  const hz = pc.horizon || {};
  add('Horizon', `${hz.mode === 'long_term' ? 'Long-term exception' : 'Position'} · ${hz.start_date ? fmtDate(hz.start_date) : '?'} to ${hz.end_date ? fmtDate(hz.end_date) : '?'}${pc.run_binding && pc.run_binding.horizon_matches === false ? ' (differs from its research run)' : pc.run_binding && pc.run_binding.horizon_matches ? ' (matches its research run)' : ''}`);
  add('Market view', h('span', null, h('strong', null, labelOf(pc.market.state, MARKET)), pc.market.state_raw ? h('span', { class: 'faint' }, ` (written as "${pc.market.state_raw}")`) : null, pc.market.rationale ? h('span', { class: 'block' }, pc.market.rationale) : null, refsLine(pc.market.evidence_refs)));
  add('Timing', h('span', null, h('strong', null, labelOf(pc.timing.state, TIMING)), pc.timing.state_raw ? h('span', { class: 'faint' }, ` (written as "${pc.timing.state_raw}")`) : null, pc.timing.rationale ? h('span', { class: 'block' }, pc.timing.rationale) : null, refsLine(pc.timing.evidence_refs)));
  add('Suggested review', pc.timing.next_review_date ? `${fmtDate(pc.timing.next_review_date)}${pc.timing.review_trigger ? ` · sooner if: ${pc.timing.review_trigger}` : ''}` : h('span', { class: 'faint' }, 'not given'));
  if (pc.long_term_note) add('Longer-term note', h('span', { class: 'muted' }, pc.long_term_note, h('span', { class: 'faint' }, ' (kept apart from this position assessment)')));
  const windows = pc.catalyst_windows || [];
  return h('div', { class: 'card pos-card' },
    h('h3', null, `Position and timing · ${PROVIDER_LABELS[provider] || provider}`),
    h('p', { class: 'small faint', style: { margin: '2px 0 8px' } }, 'The model\'s own views. They change no score: timing and executable liquidity stays the only timing score in the grade.'),
    h('dl', { class: 'kv' }, rows),
    windows.length
      ? h('div', { class: 'pos-catalysts' }, h('h4', null, 'Catalysts'),
        h('ul', { class: 'plain' }, windows.map((w) => h('li', null, h('strong', null, w.title), ` · ${windowText(w)} · ${CERTAINTY_LABELS[w.certainty] || 'certainty unknown'}`, w.in_horizon === true ? ' · inside the horizon' : w.in_horizon === false ? ' · outside the horizon' : ''))))
      : h('p', { class: 'small muted' }, 'No catalysts with dates given.'));
}

const MARKET = { unknown: 'Unknown', bitcoin_led: 'Bitcoin-led', broad_altcoin_participation: 'Broad altcoin participation', mixed: 'Mixed', contracting: 'Contracting' };
const TIMING = { unknown: 'Unknown', early: 'Early', developing: 'Developing', extended: 'Extended', thesis_impaired: 'Thesis impaired' };
const labelOf = (state, map) => map[state] || 'Unknown';

function refsLine(refs) {
  if (!refs || !refs.length) return h('span', { class: 'block faint small' }, 'No evidence references given.');
  return h('span', { class: 'block faint small' }, `Evidence: ${refs.join(', ')}`);
}

// ---- run research dialog: the horizon a run will use -------------------------

export function horizonHint(idx) {
  const pol = (idx && idx.horizon_policy) || { planning_ceiling_months: 4, default_months: 4, typical_hold_months: 2 };
  return `Whole calendar months from today. Leave it at ${pol.default_months} months for your usual position horizon (typical hold about ${pol.typical_hold_months} months, planning ceiling ${pol.planning_ceiling_months}). Longer is labeled a long-term exception${pol.require_long_term_reason ? ' and needs your reason' : ''}.`;
}

export function needsReason(idx, text) {
  const pol = (idx && idx.horizon_policy) || { planning_ceiling_months: 4 };
  const m = String(text || '').toLowerCase().match(/(\d+(?:\.\d+)?)\s*(?:-|to)?\s*(\d+(?:\.\d+)?)?\s*(years?|yrs?|y|months?|mos?|mo|m)\b/);
  if (!m) return false;
  const n = Number(m[2] || m[1]) * (/^y/.test(m[3]) ? 12 : 1);
  return n > pol.planning_ceiling_months;
}

export { stateText };
