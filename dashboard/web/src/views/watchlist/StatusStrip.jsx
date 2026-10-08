// The status strip: one compact line under the title, in three groups:
// [prices, with a rate-limit badge and its countdown, and Refresh] |
// [Bitcoin and the market, only with a captured snapshot: each change names
// its window] | [breadth over 30 days, what needs action (always named in
// words, never a count alone), the review queue]. Each part opens its
// details right under the strip; routine setup lives in Settings.
import { useEffect, useState } from 'react';
import { RefreshCw, Clock, TriangleAlert, Inbox, Coins, ChevronDown, ArrowUpRight } from 'lucide-react';
import { fmtAgo, fmtAsOf, fmtChangePct, fmtMarketUsd, priceStatus, toast } from '../../../../public/ui.js';
import { splitAttention, kindWord, breadthWords, countdownText, refreshToast, attentionHref } from '../../../../public/watchlist-model.js';
import { api, refresh, ui } from '../../lib/desk.js';
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
    <span className={`ss-chg chg ${dir}`}>
      <span aria-hidden="true">{s}</span>
      <span className="ss-win" aria-hidden="true">{win}</span>
      <span className="sr-only">{`${s.replace('−', 'minus ')} ${label}`}</span>
    </span>
  );
}

function Part({ id, open, onToggle, tone = '', children, label, className = '' }) {
  return (
    <button type="button" className={`ss-part ${tone ? `is-${tone}` : ''} ${className}`.trim()} aria-expanded={open === id} aria-controls="ss-panel" data-key={`ss-${id}`} aria-label={label} onClick={() => onToggle(id)}>
      {children}
      <ChevronDown className="ss-caret" size={13} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

function AttentionList({ items, prefix }) {
  return (
    <ul className="att-list">
      {items.map((a, i) => (
        <li key={`${a.kind}-${a.project_id || ''}-${i}`} className={`att att-${a.severity || 'low'}`}>
          <span className={`att-kind sev-${a.severity || 'low'}`}>{a.severity === 'high' && !kindWord(a).match(/^(Check|Research|Saving|Unreadable|Import)/) ? 'Urgent' : kindWord(a)}</span>
          <span className="att-text">
            <span className="att-title">{a.title}</span>
            {a.detail ? <span className="att-detail" title={a.detail}>{a.detail}</span> : null}
          </span>
          {a.action ? <a className="btn btn-sm" href={attentionHref(a)} data-key={`${prefix}-${i}`}>Open<ArrowUpRight size={13} aria-hidden="true" /></a> : null}
        </li>
      ))}
    </ul>
  );
}

export function StatusStrip({ d, sources }) {
  const idx = d.index;
  const { critical, rest } = splitAttention(idx.attention || []);
  if (!view.stripReady && ui.get('reviewOpen', false)) view.strip = view.strip || 'review';
  view.stripReady = true;
  const [open, setOpen] = useState(view.strip);
  const [busy, setBusy] = useState(false);
  let shown = open;
  if (shown === 'review' && !rest.length) shown = null;
  if (shown === 'action' && !critical.length) shown = null;
  const m = idx.freshness.market;
  const ps = priceStatus(m);
  useTick(Boolean(m.rate_limited && m.retry_at));
  const mc = idx.market_context;
  const snap = mc && mc.snapshot;
  const hasSnap = Boolean(snap && snap.bitcoin && typeof snap.bitcoin.price_usd === 'number');
  const bw = hasSnap ? breadthWords(snap.breadth && snap.breadth.d30) : null;
  const high = rest.filter((a) => a.severity === 'high').length;
  const toggle = (id) => {
    const next = shown === id ? null : id;
    view.strip = next;
    if ((id === 'review' || shown === 'review') && rest.length) ui.set('reviewOpen', next === 'review');
    setOpen(next);
  };
  const doRefresh = async () => {
    setBusy(true);
    try {
      const out = await api.post('/api/market/refresh', {});
      toast(...refreshToast(out));
      await refresh();
    } catch (err) {
      toast(...refreshToast({ result: { status: 'failed', message: err.message }, status: m }));
    } finally {
      setBusy(false);
    }
  };
  const demo = snap && snap.provider === 'fictional-demo';
  const dom = snap && snap.dominance && typeof snap.dominance.btc_pct === 'number' ? snap.dominance.btc_pct : null;
  const tm = (snap && snap.total_market) || {};
  const kinds = [...new Set(critical.map(kindWord))];
  const anyHigh = critical.some((a) => a.severity === 'high' || ['research_uncertain', 'research_failed', 'writes_blocked', 'broken_record'].includes(a.kind));
  const left = m.rate_limited ? countdownText(m.retry_at) : null;

  return (
    <section className="ss" aria-label="Status">
      <div className="ss-line">
        <div className="ss-group">
          <Part id="prices" open={shown} onToggle={toggle} tone={ps.problem ? 'warn' : ''} label={`Prices: ${m.last_success_at ? ps.asOf : 'not fetched yet'}${ps.problem && !m.rate_limited ? `, ${ps.text}` : ''}. Details`}>
            <Clock className="ss-ico" size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="ss-k ss-plabel">Prices{sources.price === 'CoinGecko' ? null : <span className="ss-demo"> (demo)</span>}</span>
            <span className="ss-v">{m.last_success_at ? fmtAgo(m.last_success_at) : 'not fetched'}</span>
            {ps.problem && !m.rate_limited ? <span className="ss-warn">{ps.text}</span> : null}
          </Part>
          {m.rate_limited ? (
            <span className="ss-rl" role="note" title={`The price source is limiting requests${m.retry_at ? `; the next automatic try is after ${fmtAsOf(m.retry_at)}` : ''}. Prices keep their age until then.`}>
              <span className="ss-rl-dot" aria-hidden="true" />Rate limited
              {left ? <span className="ss-rl-count" aria-hidden="true">{left === 'due' ? 'retry due' : left}</span> : null}
              {m.retry_at ? <span className="sr-only">{`, next try after ${fmtAsOf(m.retry_at)}`}</span> : null}
            </span>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm ss-refresh" data-key="refresh-prices" aria-label="Refresh prices now" disabled={busy} onClick={doRefresh}>
            <RefreshCw size={13} strokeWidth={2} className={busy ? 'spin' : ''} aria-hidden="true" />
            <span className="ss-refresh-lbl">{busy ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
        {hasSnap ? (
          <div className="ss-group ss-market">
            <Part id="market" open={shown} onToggle={toggle} tone={mc.status === 'stale' ? 'warn' : ''} label={`Bitcoin ${Math.round(snap.bitcoin.price_usd).toLocaleString('en-US')} dollars${dom !== null ? `, dominance ${dom.toFixed(1)} percent` : ''}. Market details`}>
              <Coins className="ss-ico" size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="ss-k">BTC{demo ? <span className="ss-demo"> (demo)</span> : null}</span>
              <span className="ss-v">{`$${Math.round(snap.bitcoin.price_usd).toLocaleString('en-US')}`}</span>
              <Chg n={snap.bitcoin.change_7d_pct} win="7d" label="over 7 days" />
              {dom !== null ? <span className="ss-sub ss-dom"><span className="ss-dot" aria-hidden="true">·</span><span className="ss-k" title="Bitcoin dominance: its share of the total crypto market cap (CoinGecko /global)">Dom</span><span className="ss-v">{`${dom.toFixed(1)}%`}</span></span> : null}
              {typeof tm.market_cap_usd === 'number' ? <span className="ss-sub ss-total"><span className="ss-dot" aria-hidden="true">·</span><span className="ss-k" title="Total crypto market cap (CoinGecko /global)">Total</span><span className="ss-v">{fmtMarketUsd(tm.market_cap_usd)}</span><Chg n={tm.market_cap_change_24h_pct} win="24h" label="total market cap over 24 hours" /></span> : null}
              {mc.status === 'stale' ? <span className="ss-warn">stale</span> : null}
            </Part>
            {bw ? (
              <Part id="breadth" open={shown} onToggle={toggle} label={`${bw.title} Details`} className="ss-breadth">
                {typeof snap.breadth.d30.share_pct === 'number' ? <span className="breadth-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, snap.breadth.d30.share_pct))}%` }} /></span> : null}
                <span className="ss-v">{bw.text}</span>
                <span className="ss-win">{bw.window}</span>
              </Part>
            ) : null}
          </div>
        ) : null}
        {critical.length || rest.length ? (
          <div className="ss-group ss-attn">
            {critical.length ? (
              <Part id="action" open={shown} onToggle={toggle} tone={anyHigh ? 'bad' : 'warn'} label={`Needs action: ${critical.map((a) => a.title).join('; ')}. Details`}>
                <TriangleAlert className="ss-ico" size={14} strokeWidth={1.9} aria-hidden="true" />
                <span className="ss-v">{kinds.length === 1 ? kinds[0] : `${critical.length} need action`}</span>
                {critical.length > 1 && kinds.length === 1 ? <span className="ss-k">{`×${critical.length}`}</span> : null}
                {kinds.length > 1 ? <span className="ss-k ss-kinds">{kinds.join(' · ')}</span> : null}
              </Part>
            ) : null}
            {rest.length ? (
              <Part id="review" open={shown} onToggle={toggle} tone={high ? 'warn' : ''} label={`${rest.length} ${rest.length === 1 ? 'item' : 'items'} in the review queue (one project can have several)${high ? `, ${high} urgent` : ''}. Details`}>
                <Inbox className="ss-ico" size={14} strokeWidth={1.8} aria-hidden="true" />
                <span className="ss-v">{rest.length}</span>
                <span className="ss-k">to review</span>
                {high ? <span className="ss-warn">{`${high} urgent`}</span> : null}
              </Part>
            ) : null}
          </div>
        ) : null}
      </div>
      {shown ? (
        <div className="ss-panel" id="ss-panel" role="region" aria-label="Status details">
          {shown === 'action' ? <><h2>{`Needs action (${critical.length})`}</h2><AttentionList items={critical} prefix="alert" /></> : null}
          {shown === 'review' ? <><h2>{`To review (${rest.length})`}</h2><AttentionList items={rest} prefix="att" /></> : null}
          {shown === 'prices' ? (
            <>
              <h2>Prices</h2>
              <p>{`${m.last_success_at ? ps.asOf : 'No prices fetched yet'} · source: ${sources.price}.`}</p>
              {ps.note ? <p className={ps.problem ? 'ss-warn-text' : ''}>{ps.problem ? 'Note: ' : ''}{ps.note}</p> : null}
              {ps.retryAt ? <p>{`Next try after ${fmtAsOf(ps.retryAt)}.`}</p> : null}
            </>
          ) : null}
          {shown === 'market' || shown === 'breadth' ? <Dom build={(L) => L.marketStrip(idx)} deps={[idx]} /> : null}
        </div>
      ) : null}
    </section>
  );
}
