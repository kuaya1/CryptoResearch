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
import { RefreshCw, TriangleAlert, ArrowUpRight, ChevronDown } from 'lucide-react';
import { fmtAgo, fmtAsOf, fmtChangePct, fmtMarketUsd, priceStatus, toast } from '../../../../public/ui.js';
import { splitAttention, kindWord, countdownText, refreshToast, attentionHref, deskKpis } from '../../../../public/watchlist-model.js';
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

function Chg({ n, win, label }) {
  const s = fmtChangePct(n);
  if (!s) return null;
  const dir = n < 0 ? 'down' : n > 0 ? 'up' : 'flat';
  return (
    <span className={`kpi-chg chg ${dir}`}>
      <span aria-hidden="true">{s}</span>
      <span className="kpi-win" aria-hidden="true">{win}</span>
      <span className="sr-only">{`${s.replace('−', 'minus ')} ${label}`}</span>
    </span>
  );
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
        <span>{busy ? 'Refreshing…' : 'Refresh prices'}</span>
      </button>
    </>
  );
}

function Cell({ id, label, children, onClick, title, sub = null, active = false, aria }) {
  const inner = (
    <>
      <span className="kpi-k">{label}</span>
      <span className="kpi-v">{children}</span>
      {sub ? <span className="kpi-s">{sub}</span> : null}
    </>
  );
  if (!onClick) return <div className="kpi-cell" title={title} data-key={`kpi-${id}`}>{inner}</div>;
  return (
    <button type="button" className={`kpi-cell is-link${active ? ' is-on' : ''}`} title={title} data-key={`kpi-${id}`} aria-label={aria} aria-pressed={active || undefined} onClick={onClick}>
      {inner}
      <ArrowUpRight className="kpi-go" size={13} aria-hidden="true" />
    </button>
  );
}

export function KpiStrip({ d, agenda = null, sources, filters, onView, onBeat }) {
  const idx = d.index;
  const k = deskKpis(idx, agenda);
  const m = idx.freshness.market;
  const ps = priceStatus(m);
  const [open, setOpen] = useState(view.strip === 'market' ? 'market' : null);
  const toggle = (id) => { const next = open === id ? null : id; view.strip = next; setOpen(next); };
  const demo = k.market && k.market.demo;
  return (
    <section className="kpi" aria-label="Market and what needs you">
      <div className="kpi-row">
        <Cell
          id="market"
          label={<>Market{demo || sources.price !== 'CoinGecko' ? <span className="kpi-demo"> (demo)</span> : null}</>}
          onClick={k.market ? () => toggle('market') : null}
          active={open === 'market'}
          aria={k.market ? `Bitcoin ${Math.round(k.market.btc).toLocaleString('en-US')} dollars${k.market.dominance !== null ? `, dominance ${k.market.dominance.toFixed(1)} percent` : ''}. Market details` : undefined}
          title={k.market ? 'Bitcoin, its 7-day change and its dominance of the total market cap (CoinGecko /global)' : 'No market snapshot captured yet'}
          sub={<span className={ps.problem ? 'kpi-warn' : undefined} title={ps.note || undefined}>{`Prices ${m.last_success_at ? fmtAgo(m.last_success_at) : 'not fetched'}${ps.problem && !m.rate_limited ? ` · ${ps.text}` : ''}`}</span>}
        >
          {k.market ? (
            <>
              <span className="kpi-num">{`BTC $${Math.round(k.market.btc).toLocaleString('en-US')}`}</span>
              <Chg n={k.market.change_7d} win="7d" label="over 7 days" />
              {k.market.dominance !== null ? <span className="kpi-sub2">{`Dom ${k.market.dominance.toFixed(1)}%`}</span> : null}
              {k.market.stale ? <span className="kpi-warn">stale</span> : null}
            </>
          ) : <span className="faint">No snapshot</span>}
          {open === 'market' ? <ChevronDown className="kpi-open" size={13} aria-hidden="true" /> : null}
        </Cell>
        <Cell id="total" label="Total cap" title="Total crypto market cap (CoinGecko /global)">
          {k.total ? <><span className="kpi-num">{fmtMarketUsd(k.total.usd)}</span><Chg n={k.total.change_24h} win="24h" label="total market cap over 24 hours" /></> : <span className="faint">—</span>}
        </Cell>
        <Cell
          id="beat"
          label="Beat BTC (30d)"
          onClick={k.beat ? onBeat : null}
          active={filters.beat === 'yes'}
          title={k.beat ? `${k.beat.words.title} Select to show the projects on your list that beat Bitcoin over 30 days.` : 'No breadth figure captured yet'}
          aria={k.beat ? `${k.beat.n} of ${k.beat.of} beat Bitcoin over 30 days. Show the projects on your list that did` : undefined}
        >
          {k.beat ? (
            <>
              <span className="kpi-num">{`${k.beat.n} / ${k.beat.of}`}</span>
              {typeof k.beat.share === 'number' ? <span className="breadth-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, k.beat.share))}%` }} /></span> : null}
            </>
          ) : <span className="faint">—</span>}
        </Cell>
        <Cell
          id="review"
          label="Needs review"
          onClick={() => navigate('#/review')}
          title="Projects with changes since your review, a review of yours due, or research waiting for you. One project counts once."
          aria={`${k.review.projects} project${k.review.projects === 1 ? '' : 's'} need your review. Open Review`}
        >
          <span className="kpi-num">{k.review.projects}</span><span className="kpi-unit">{k.review.projects === 1 ? 'project' : 'projects'}</span>
        </Cell>
        <Cell
          id="waiting"
          label="Research waiting"
          onClick={() => onView('waiting')}
          active={filters.owned === 'waiting'}
          title="Model jobs queued, working, paused or waiting for you (a model on hold has none)"
          aria={`${k.waiting.jobs} research job${k.waiting.jobs === 1 ? '' : 's'} waiting on a model. Show them`}
        >
          <span className="kpi-num">{k.waiting.jobs}</span><span className="kpi-unit">{k.waiting.jobs === 1 ? 'job' : 'jobs'}</span>
        </Cell>
      </div>
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
