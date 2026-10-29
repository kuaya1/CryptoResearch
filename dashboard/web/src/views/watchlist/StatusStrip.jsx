// The Desk's KPI strip (DESIGN_AND_IA_BLUEPRINT.md §3.1; Eric, 2026-10-17):
// one panel split by hairlines into five cells, each a way in: Market
// (Bitcoin's price and 7-day change, dominance; opens the market details),
// Total cap (with its 24-hour change), Beat BTC 30d (filters the list to the
// coins ahead of Bitcoin), Needs review (the one count, D3: projects; opens
// Review) and Research waiting (the model jobs in progress or waiting; shows
// that view). Each change names its window. Under it, what needs action is
// always in view, named in words. The price refresh is the header's Refresh
// prices button (RefreshButton).
import { useEffect, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { fmtAgo, fmtAsOf, fmtChangePct, fmtMarketUsd, fmtPrice, priceStatus, toast } from '../../../../public/ui.js';
import { splitAttention, kindWord, countdownText, refreshToast, attentionHref, deskKpis, riskBudget } from '../../../../public/watchlist-model.js';
import { api, refresh, desk } from '../../lib/desk.js';
import { navigate } from '../../lib/router.js';
import { Dom } from '../../components/Dom.jsx';
import { view } from './state.js';

function useTick(on) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

// Refresh prices (the header's secondary action): asks CoinGecko now; a
// rate limit is said with its countdown.
// Refresh prices now: the Desk's button and the command menu's "Refresh
// prices", each an explicit choice (CoinGecko's budget and rate limit apply).
export const refreshPrices = async () => {
  const m = desk.index ? desk.index.freshness.market : null;
  try {
    const out = await api.post('/api/market/refresh', {});
    toast(...refreshToast(out));
    await refresh();
  } catch (err) {
    toast(...refreshToast({ result: { status: 'failed', message: err.message }, status: m }));
  }
};

export function RefreshButton({ d }) {
  const m = d.index.freshness.market;
  const [busy, setBusy] = useState(false);
  useTick(Boolean(m.rate_limited && m.retry_at));
  const left = m.rate_limited ? countdownText(m.retry_at) : null;
  const doRefresh = async () => {
    setBusy(true);
    try {
      await refreshPrices();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {m.rate_limited ? (
        <span className="badge is-warn kpi-rl" role="note" title={`The price source is limiting requests${m.retry_at ? `; the next automatic try is after ${fmtAsOf(m.retry_at)}` : ''}. Prices keep their age until then.`}>
          Rate limited{left ? <span className="kpi-rl-count" aria-hidden="true">{left === 'due' ? ' · retry due' : ` · ${left}`}</span> : null}
          {m.retry_at ? <span className="sr-only">{`, next try after ${fmtAsOf(m.retry_at)}`}</span> : null}
        </span>
      ) : null}
      <button type="button" className="btn" data-key="refresh-prices" aria-label="Refresh prices now" disabled={busy} onClick={doRefresh}>
        <RefreshCw size={14} strokeWidth={2} className={busy ? 'spin' : ''} aria-hidden="true" />
        <span>{busy ? 'Refreshing…' : 'Refresh'}</span>
      </button>
    </>
  );
}

// The risk budget: recorded speculative cost against the cap in Portfolio's
// limits, a 16px track with the cap's 2×10 mark; caution from 80%, over
// above 100%, always in words. No cap set: the words only, no bar.
function RiskBudget({ rb }) {
  const fill = rb.pct === null ? 0 : Math.max(0, Math.min(100, rb.pct));
  const usd = (n) => fmtPrice(n);
  const title = rb.state === 'no_cap'
    ? 'No speculative capital cap is set (Portfolio > Limits)'
    : rb.state === 'unknown' ? 'The recorded cost of speculative positions is unknown'
      : `${rb.atLeast ? 'At least ' : ''}${usd(rb.used)} recorded cost of speculative positions against a ${usd(rb.cap)} cap${rb.atLeast ? '; some units have unknown cost' : ''}`;
  return (
    <a className={`rb is-${rb.state}`} href="#/portfolio" data-key="kpi-risk" title={title}>
      <span className="rb-k">Risk budget</span>
      {rb.state === 'no_cap' || rb.state === 'unknown' ? (
        <span className="rb-none">
          {rb.words}
          {/* An empty budget says where to set it (L4): Portfolio's Capital
              limits form; nothing is saved from here. */}
          {rb.state === 'no_cap' ? <a className="rb-set" href="#/portfolio?tab=record" data-key="rb-set-cap">Set cap</a> : null}
        </span>
      ) : (
        <>
          <span className="rb-fig">{`${usd(rb.used)} / ${usd(rb.cap)}`}</span>
          <span className="rb-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fill)} aria-valuetext={rb.words} aria-label="Risk budget used">
            <span className="rb-fill" style={{ width: `${fill}%` }} />
            <span className="rb-cap" aria-hidden="true" />
          </span>
          <span className="rb-words">{rb.words}</span>
        </>
      )}
    </a>
  );
}

// A key figure (Desk v2): its label, a large light value and a sub-line,
// each on one line; a cell that is a way in is a button.
function Cell({ id, label, value, sub = null, subTone = '', valueTone = '', onClick, title, active = false, aria }) {
  const inner = (
    <>
      <span className="kpi-k">{label}</span>
      <span className={`kpi-v${valueTone ? ` is-${valueTone}` : ''}`}>{value}</span>
      {sub ? <span className={`kpi-s${subTone ? ` is-${subTone}` : ''}`}>{sub}</span> : null}
    </>
  );
  if (!onClick) return <div className="kpi-cell" title={title} data-key={`kpi-${id}`}>{inner}</div>;
  return (
    <button type="button" className={`kpi-cell is-link${active ? ' is-on' : ''}`} title={title} data-key={`kpi-${id}`} aria-label={aria} aria-pressed={active || undefined} onClick={onClick}>
      {inner}
    </button>
  );
}

// "+2.1% this week", with its direction for the sub-line's colour.
function chgWords(n, win) {
  const s = fmtChangePct(n);
  return s ? { text: `${s} ${win}`, tone: n > 0 ? 'up' : n < 0 ? 'down' : '' } : null;
}

export function KpiStrip({ d, agenda = null, settled = true, sources, filters, onView, onBeat, range = '24h' }) {
  const idx = d.index;
  const k = deskKpis(idx, agenda);
  const m = idx.freshness.market;
  const ps = priceStatus(m);
  const [open, setOpen] = useState(view.strip === 'market' ? 'market' : null);
  const toggle = (id) => { const next = open === id ? null : id; view.strip = next; setOpen(next); };
  const demo = k.market && k.market.demo;
  // Bitcoin's change in the chosen window where the snapshot holds it (7d
  // and 30d; it has no 24h), its window always named.
  const btc30 = range === '30d' && k.market && typeof k.market.change_30d === 'number';
  const btcChg = k.market ? (btc30 ? chgWords(k.market.change_30d, 'over 30 days') : chgWords(k.market.change_7d, 'this week')) : null;
  const totalChg = k.total ? chgWords(k.total.change_24h, 'today') : null;
  const rb = riskBudget(idx);
  const prices = `Prices ${m.last_success_at ? fmtAgo(m.last_success_at) : 'not fetched'}${ps.problem && !m.rate_limited ? ` · ${ps.text}` : ''}`;
  const n = settled ? k.review.projects : null;
  return (
    <section className="kpi" aria-label="Market and what needs you">
      <div className="kpi-row">
        <Cell
          id="market"
          label={<>Bitcoin{demo || sources.price !== 'CoinGecko' ? <span className="kpi-demo"> (demo)</span> : null}</>}
          value={k.market ? `$${Math.round(k.market.btc).toLocaleString('en-US')}` : '—'}
          sub={btcChg ? btcChg.text : prices}
          subTone={btcChg ? btcChg.tone : ps.problem ? 'warn' : ''}
          onClick={k.market ? () => toggle('market') : null}
          active={open === 'market'}
          aria={k.market ? `Bitcoin ${Math.round(k.market.btc).toLocaleString('en-US')} dollars${btcChg ? `, ${btcChg.text.replace('−', 'minus ')}` : ''}${k.market.dominance !== null ? `, dominance ${k.market.dominance.toFixed(1)} percent` : ''}. ${prices}. Market details` : undefined}
          title={k.market ? `Bitcoin and its change (CoinGecko /global)${k.market.dominance !== null ? `; dominance ${k.market.dominance.toFixed(1)}%` : ''}${k.market.stale ? '; the snapshot is stale' : ''}. ${prices}${ps.note ? `. ${ps.note}` : ''}` : 'No market snapshot captured yet'}
        />
        <Cell
          id="total"
          label="Total market"
          value={k.total ? fmtMarketUsd(k.total.usd) : '—'}
          sub={totalChg ? totalChg.text : null}
          subTone={totalChg ? totalChg.tone : ''}
          title="Total crypto market cap (CoinGecko /global), its change over 24 hours"
        />
        <Cell
          id="beat"
          label="Beat Bitcoin"
          value={k.beat ? `${k.beat.n} of ${k.beat.of}` : '—'}
          sub="over 30 days"
          onClick={k.beat ? onBeat : null}
          active={filters.beat === 'yes'}
          title={k.beat ? `${k.beat.words.title} Select to show the projects on your list that beat Bitcoin over 30 days.` : 'No breadth figure captured yet'}
          aria={k.beat ? `${k.beat.n} of ${k.beat.of} beat Bitcoin over 30 days. Show the projects on your list that did` : undefined}
        />
        <Cell
          id="review"
          label="Needs review"
          value={n === null ? '…' : String(n)}
          valueTone={n ? 'amber' : ''}
          sub={n === null ? 'counting' : n ? 'open the queue' : 'all reviewed'}
          onClick={() => navigate('#/review')}
          title="Projects with changes since your review, a review of yours due, or research waiting for you. One project counts once."
          aria={settled ? `${k.review.projects} project${k.review.projects === 1 ? '' : 's'} need your review. Open Review` : 'Counting the projects that need your review. Open Review'}
        />
        <Cell
          id="waiting"
          label="Research"
          value={String(k.waiting.jobs)}
          sub="running or queued"
          onClick={() => onView('waiting')}
          active={filters.owned === 'waiting'}
          title="Model jobs queued, working, paused or waiting for you (a model on hold has none)"
          aria={`${k.waiting.jobs} research job${k.waiting.jobs === 1 ? '' : 's'} waiting on a model. Show them`}
        />
      </div>
      <RiskBudget rb={rb} />
      {open === 'market' ? (
        <div className="kpi-panel" role="region" aria-label="Market details">
          <Dom build={(L) => L.marketStrip(idx)} deps={[idx]} />
        </div>
      ) : null}
    </section>
  );
}

// What needs action, never folded away: a paid call that may have been
// billed with no answer, research that failed or stalled, records or saving
// that need recovery. Each says its kind in words, with its way in.
export function ActionBand({ d }) {
  const { critical } = splitAttention(d.index.attention || []);
  const [all, setAll] = useState(false);
  if (!critical.length) return null;
  const anyHigh = critical.some((a) => a.severity === 'high' || ['research_uncertain', 'research_failed', 'writes_blocked', 'broken_record'].includes(a.kind));
  return (
    <section className={`action-band ${anyHigh ? 'is-bad' : 'is-warn'}`} aria-label={`Needs action: ${critical.length}`}>
      <TriangleAlert className="ab-ico" size={15} aria-hidden="true" />
      <ul className="ab-list">
        {(all ? critical : critical.slice(0, 4)).map((a, i) => (
          <li key={`${a.kind}-${a.project_id || ''}-${i}`}>
            <strong>{kindWord(a)}</strong>
            <span className="ab-t" title={a.detail || undefined}>{` · ${a.title}`}</span>
            {a.action ? <a className="ab-go" href={attentionHref(a)} data-key={`alert-${i}`}>Open</a> : null}
          </li>
        ))}
        {critical.length > 4 ? <li><button type="button" className="btn btn-ghost btn-sm ab-more" data-key="alert-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `${critical.length - 4} more`}</button></li> : null}
      </ul>
    </section>
  );
}
