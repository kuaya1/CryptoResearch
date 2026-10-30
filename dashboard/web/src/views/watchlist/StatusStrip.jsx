// The Desk's figures and its refresh (UI v3 parity, UI_MASTER_PLAYBOOK.md
// §4.3, D14): the market line under the Focal block, each item a way in
// (Bitcoin opens the market details, Beat Bitcoin filters the list, Trader
// Sim opens Research > Outcomes, Needs review opens Review, Research shows
// the waiting view, Risk budget opens Portfolio), with the queues said only
// when they hold something. Refresh is the Focal block's text link
// (RefreshLink); what needs action stays in view under it (ActionBand).
import { useEffect, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { fmtAgo, fmtAsOf, fmtMarketUsd, fmtPrice, priceStatus, toast } from '../../../../public/ui.js';
import { splitAttention, kindWord, countdownText, refreshToast, attentionHref, deskKpis, riskBudget } from '../../../../public/watchlist-model.js';
import { settlementWords } from '../../../../public/trader-book-model.js';
import { useTraderRead } from '../../lib/trader.js';
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

export function RefreshLink({ d }) {
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
  const limited = Boolean(m.rate_limited) && !busy;
  const words = busy ? 'Refreshing…' : limited ? `Rate limited${left ? (left === 'due' ? ' · retry due' : ` · ${left}`) : ''}` : 'Refresh';
  return (
    <button
      type="button"
      className={`v3-focal-link${limited ? ' is-limited' : ''}`}
      data-key="refresh-prices"
      aria-label={limited ? `Refresh prices now. The price source is limiting requests${m.retry_at ? `; the next automatic try is after ${fmtAsOf(m.retry_at)}` : ''}` : 'Refresh prices now'}
      disabled={busy}
      onClick={doRefresh}
    >
      {words}
    </button>
  );
}

// The market line (UI v3 parity, UI_MASTER_PLAYBOOK.md §4.3): the Desk's
// figures as one line of text items, no box. Bitcoin (opens the market
// details), Total market, Beat Bitcoin (filters the list), Trader Sim (the
// trader simulation's book, opens Research > Outcomes), then only when they
// hold something: Needs review, Research waiting, Risk budget (a cap set).
function signed(n, digits = 1) {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`;
}

function Item({ id, label, value, sub = null, tone = '', onClick, href, title, aria, pressed, strong = false, valueTone = '' }) {
  const inner = (
    <>
      <span className="v3-ml-k">{label}</span>
      <span className={`v3-ml-v${strong ? ' is-strong' : ''}${valueTone ? ` ${valueTone}` : ''}`}>{value}</span>
      {sub ? <span className={`v3-ml-s${tone ? ` ${tone}` : ''}`}>{sub}</span> : null}
    </>
  );
  if (href) return <a className="v3-ml-item" href={href} data-key={`kpi-${id}`} title={title} aria-label={aria}>{inner}</a>;
  if (!onClick) return <span className="v3-ml-item" data-key={`kpi-${id}`} title={title}>{inner}</span>;
  return <button type="button" className="v3-ml-item" data-key={`kpi-${id}`} title={title} aria-label={aria} aria-pressed={pressed} onClick={onClick}>{inner}</button>;
}

const PLAIN = /^-?\d+(\.\d+)?$/;

export function MarketLine({ d, agenda = null, settled = true, sources, filters, onView, onBeat }) {
  const idx = d.index;
  const k = deskKpis(idx, agenda);
  const m = idx.freshness.market;
  const ps = priceStatus(m);
  const tr = useTraderRead().v;
  const [open, setOpen] = useState(view.strip === 'market');
  const toggle = () => { const next = !open; view.strip = next ? 'market' : null; setOpen(next); };
  const demo = Boolean(k.market && k.market.demo) || sources.price !== 'CoinGecko';
  const rb = riskBudget(idx);
  const usd = (n) => fmtPrice(n);
  const ch7 = k.market && typeof k.market.change_7d === 'number' ? k.market.change_7d : null;
  const chT = k.total && typeof k.total.change_24h === 'number' ? k.total.change_24h : null;
  const r = (tr && tr.results) || null;
  const funded = Boolean(r && r.funded_usd !== null && r.funded_usd !== undefined);
  const nav = funded && typeof r.nav_usd === 'string' && PLAIN.test(r.nav_usd) ? Number(r.nav_usd) : null;
  const openN = r && Array.isArray(r.open_positions) ? r.open_positions.length : 0;
  const unsettled = settlementWords(tr).unsettled;
  const btcWords = k.market ? `${Math.round(k.market.btc).toLocaleString('en-US')} dollars` : '';
  return (
    <section className="v3-market" aria-label="Market and what needs you">
      <div className="v3-ml">
        <Item
          id="market"
          label={demo ? 'Bitcoin (demo)' : 'Bitcoin'}
          value={k.market ? `$${Math.round(k.market.btc).toLocaleString('en-US')}` : 'No snapshot'}
          sub={ch7 !== null ? `${signed(ch7)} this week` : k.market && k.market.stale ? 'stale' : null}
          tone={ch7 === null ? '' : ch7 >= 0 ? 'is-up' : 'is-down'}
          onClick={k.market ? toggle : null}
          pressed={open}
          title={`${k.market ? 'Bitcoin and its 7-day change; select for the market details.' : 'No market snapshot captured yet.'} Prices ${m.last_success_at ? fmtAgo(m.last_success_at) : 'not fetched'}${ps.problem ? ` · ${ps.text}` : ''}`}
          aria={k.market ? `Bitcoin ${btcWords}${ch7 !== null ? `, ${ch7 >= 0 ? 'up' : 'down'} ${Math.abs(ch7).toFixed(1)} percent this week` : ''}. Market details` : undefined}
        />
        <Item
          id="total"
          label="Total market"
          value={k.total ? fmtMarketUsd(k.total.usd) : '—'}
          sub={chT !== null ? `${signed(chT)} today` : null}
          tone={chT === null ? '' : chT >= 0 ? 'is-up' : 'is-down'}
          title="Total crypto market cap and its 24-hour change (CoinGecko /global)"
        />
        <Item
          id="beat"
          label="Beat Bitcoin"
          value={k.beat ? `${k.beat.n} of ${k.beat.of}` : '—'}
          sub="30 days"
          strong={filters.beat === 'yes'}
          onClick={k.beat ? onBeat : null}
          pressed={filters.beat === 'yes'}
          title={k.beat ? `${k.beat.words.title} Select to show the projects on your list that beat Bitcoin over 30 days.` : 'No breadth figure captured yet'}
          aria={k.beat ? `${k.beat.n} of ${k.beat.of} beat Bitcoin over 30 days. Show the projects on your list that did` : undefined}
        />
        {tr ? (
          <Item
            id="trader"
            label="Trader Sim"
            value={!funded ? 'Not funded' : nav === null ? 'Unknown' : `$${Math.round(nav).toLocaleString('en-US')}`}
            sub={funded ? `${openN} open · ${unsettled ? 'unsettled' : 'settled'}` : null}
            href="#/research?tab=outcomes"
            title="The trader simulation's book: its NAV, open positions and whether its record is settled (Research > Outcomes)"
          />
        ) : null}
        {settled && k.review.projects > 0 ? (
          <Item
            id="review"
            label="Needs review"
            value={String(k.review.projects)}
            valueTone="is-review"
            onClick={() => navigate('#/review')}
            title="Projects with changes since your review, a review of yours due, or research waiting for you. One project counts once."
            aria={`${k.review.projects} project${k.review.projects === 1 ? '' : 's'} need your review. Open Review`}
          />
        ) : null}
        {k.waiting.jobs > 0 ? (
          <Item
            id="waiting"
            label="Research"
            value={String(k.waiting.jobs)}
            sub="running or queued"
            onClick={() => onView('waiting')}
            pressed={filters.owned === 'waiting'}
            title="Model jobs queued, working, paused or waiting for you (a model on hold has none)"
            aria={`${k.waiting.jobs} research job${k.waiting.jobs === 1 ? '' : 's'} running or queued. Show them`}
          />
        ) : null}
        {rb.state !== 'no_cap' ? (
          <Item
            id="risk"
            label="Risk budget"
            value={rb.state === 'unknown' ? `Unknown / ${usd(rb.cap)}` : `${usd(rb.used)} / ${usd(rb.cap)}`}
            valueTone={rb.state === 'over' ? 'is-down' : ''}
            sub={rb.words}
            tone={rb.state === 'over' ? 'is-down' : ''}
            href="#/portfolio"
            title={rb.state === 'unknown' ? 'The recorded cost of speculative positions is unknown' : `${rb.atLeast ? 'At least ' : ''}${usd(rb.used)} recorded cost of speculative positions against a ${usd(rb.cap)} cap`}
          />
        ) : null}
      </div>
      {open && k.market ? (
        <div className="v3-ml-panel" role="region" aria-label="Market details">
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
