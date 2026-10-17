// The project inspector, Level 1 (?p=<id> on the Desk; DESIGN_AND_IA
// _BLUEPRINT.md §3.2; Eric, 2026-10-17). It answers "what is this, what is
// the call, what could break it, what do I do" without a long scroll: a
// sticky head (logo, name, ticker, Held, the menu, close; the price with its
// 24-hour change, MC and FDV/MC; the links in one Links menu), six blocks
// (ModelPanel.jsx), and a sticky foot: what changed since your review on the
// left, Open full research and Mark reviewed (R) on the right; each label
// opens exactly one place.
//
// From 1280px it docks beside the list (non-modal; Escape closes it and
// returns to the row; J/K move the choice), 560px wide to 1599px and 640px
// from 1600px; below, it is a drawer over the list, a full-screen sheet on a
// phone (modal: the rest of the page is inert; a swipe down on its head
// closes it). Its body scrolls on its own and the head and foot keep their
// place. Another project opens at its top; a redraw of the same one keeps its
// place.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X, Ellipsis, ExternalLink, Check, ChevronDown, ArrowRight } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtAgo, freshnessText } from '../../../../public/ui.js';
import { mkt, marketStrings, noPriceReason, priceClock, rowProject, needsReview, canonicalOf } from '../../../../public/watchlist-model.js';
import { useDesk, useProject } from '../../lib/hooks.js';
import { claimFocus, navigate } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, Unknown, UnknownFigure } from '../../components/figures.jsx';
import { Menu, MenuItem, MenuSep, MenuLabel } from '../../components/Menu.jsx';
import { loadLegacy } from '../../components/Dom.jsx';
import { view, closePanel, markReviewed, restoreProject, archiveProject, setWatching } from '../watchlist/state.js';
import { ModelPanel } from './ModelPanel.jsx';
import { seenOf, STILL_LOADING } from '../../lib/review.js';

const enc = encodeURIComponent;
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function HeadMarket({ p, freshness }) {
  const m = mkt(p);
  if (!m) return <div className="ih-price none"><span className="faint">{`No price: ${(noPriceReason(p) || 'unknown').toLowerCase()}`}</span></div>;
  const f = freshnessText(m.status, m.age_minutes);
  const fresh = m.status === 'fresh';
  const s = marketStrings(m);
  const clock = priceClock(m.fetched_at, freshness && freshness.last_success_at);
  const source = m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Fictional demo data' : `Source: ${m.source || 'CoinGecko'}`;
  const none = (label, v) => <UnknownFigure label={label} value={v} />;
  return (
    <div className="ih-price">
      <span className="ih-price-v">{s.price}</span>
      {s.change24h ? <span className={`ih-chg ${m.change_24h_pct < 0 ? 'down' : 'up'}`} title="Price change over 24 hours"><Change value={m.change_24h_pct} label="over 24 hours" /></span> : null}
      <span className={`ih-fresh${fresh && !clock.kept ? '' : ' is-warn'}`} title={`${source}, as of ${fmtDateTime(m.as_of)}${clock.kept ? `. The last price refresh (${fmtAgo(freshness.last_success_at)}) did not update this asset, so its last valid price is kept.` : ''}`}>
        {fresh ? clock.text || fmtAgo(m.fetched_at || m.as_of) : f.text}
      </span>
      <span className="ih-fact" title="Market cap (CoinGecko)"><span className="k">MC</span>{s.mcap || none('Market cap', m.market_cap_usd)}</span>
      <span className="ih-fact" title="Fully diluted valuation over market cap, from the two figures (FDV and volume are on the Market section)"><span className="k">FDV/MC</span>{s.fdvMc || <Unknown label="FDV over market cap" />}</span>
    </div>
  );
}

// The external links in one menu: CoinGecko, DexScreener (the verified
// contract's page, else a ticker search) and the official website. A link the
// desk does not hold is left out, never a disabled item or a guessed URL.
function HeadLinks({ p, L }) {
  const web = /^https?:\/\//i.test(String(p.official_website || '')) ? p.official_website : null;
  let host = null;
  try { host = web ? new URL(web).hostname.replace(/^www\./, '') : null; } catch (_) { host = null; }
  const dex = L ? L.dexLink(rowProject(p)) : null;
  const items = [
    p.coingecko_id ? { key: 'cg', label: 'CoinGecko', desc: p.coingecko_id, href: `https://www.coingecko.com/en/coins/${enc(p.coingecko_id)}` } : null,
    dex ? { key: 'dex', label: 'DexScreener', desc: dex.title, href: dex.href } : null,
    web && host ? { key: 'web', label: 'Official website', desc: host, href: web } : null,
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <Menu
      label={`Links for ${p.name}`}
      align="end"
      trigger={<button type="button" className="btn btn-sm ih-links-btn" data-key={`ih-links-${p.project_id}`} aria-label={`Links for ${p.name}: ${items.map((x) => x.label).join(', ')}`}><ExternalLink size={13} aria-hidden="true" /><span>Links</span><ChevronDown size={13} aria-hidden="true" /></button>}
    >
      {items.map((x) => (
        <MenuItem key={x.key} desc={x.desc} data-key={`x-${x.key}-${p.project_id}`} onSelect={() => { window.open(x.href, '_blank', 'noopener,noreferrer'); }}>{x.label}</MenuItem>
      ))}
    </Menu>
  );
}

export default function Inspector({ pid, wide }) {
  const d = useDesk();
  const p = d.index.projects.find((x) => x.project_id === pid);
  const { d: detail, current, error, retry } = useProject(pid);
  const root = useRef(null);
  const heading = useRef(null);
  const body = useRef(null);
  const swipe = useRef(null);
  const [L, setL] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadLegacy().then(setL, () => {}); }, []);
  const modal = !wide;
  // The reports drawn here, which Mark reviewed sends (nothing while loading).
  const drawn = seenOf(p, current ? detail : null);

  // Opening: focus moves into the inspector (its title); a peek beside the
  // list leaves focus on the row. Another project starts at its top.
  const lastPid = useRef(null);
  useLayoutEffect(() => {
    const changed = lastPid.current !== pid;
    lastPid.current = pid;
    if (changed && body.current) body.current.scrollTop = 0;
    if (view.focusOnRender) {
      const target = heading.current;
      if (target) {
        target.focus({ preventScroll: true });
        claimFocus();
      }
      if (wide) {
        const row = document.querySelector(`[data-pid="${CSS.escape(pid)}"]`);
        if (row) row.scrollIntoView({ block: 'nearest' });
      }
    } else if (changed && modal && heading.current && !root.current.contains(document.activeElement)) {
      heading.current.focus({ preventScroll: true });
      claimFocus();
    }
    view.focusOnRender = false;
    view.focusProvider = null;
  }, [pid]);

  // A drawer is modal: the page behind it is inert; Escape and Back close it.
  // A layout effect, so the page is live again before the list returns focus
  // to the row (its own layout effect, which runs after this one's cleanup).
  useLayoutEffect(() => {
    if (!modal) return undefined;
    const targets = [...document.querySelectorAll('.sidebar, .topbar, .tabbar, .wl-main, .demo-banner, .skip-link')];
    for (const el of targets) el.inert = true;
    document.documentElement.classList.add('has-drawer');
    return () => {
      for (const el of targets) el.inert = false;
      document.documentElement.classList.remove('has-drawer');
    };
  }, [modal]);

  if (!p) return null;
  const ch = p.changes || {};
  const archived = p.status === 'archived';
  const a = p.archive || {};
  const canon = canonicalOf(p);
  const prov = canon.provider || 'claude';
  const fullHref = `#/project/${enc(pid)}/brief?model=${prov}`;
  const openFull = (e) => {
    if (e && !plain(e)) return;
    if (e) e.preventDefault();
    view.briefReturn = pid;
    navigate(fullHref, { state: { crBrief: pid, from: 'watchlist' } });
  };
  // A phone's sheet: a swipe down on its head closes it.
  const onTouchStart = (e) => { if (modal && e.touches && e.touches.length === 1) swipe.current = { y: e.touches[0].clientY, t: Date.now() }; };
  const onTouchEnd = (e) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || !e.changedTouches || !e.changedTouches.length) return;
    const dy = e.changedTouches[0].clientY - s.y;
    if (dy > 80 && Date.now() - s.t < 800 && (!body.current || body.current.scrollTop <= 0)) closePanel();
  };

  return (
    <>
      {modal ? <div className="drawer-scrim" aria-hidden="true" onClick={closePanel} /> : null}
      <aside
        ref={root}
        className={`inspector ${modal ? 'is-modal' : 'is-docked'}`}
        role="dialog"
        aria-modal={modal ? 'true' : 'false'}
        aria-labelledby="insp-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !document.querySelector('.menu')) {
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            closePanel();
          }
        }}
      >
        <header className="insp-head" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {modal ? <span className="insp-grip" aria-hidden="true" /> : null}
          <div className="ih-row">
            <Logo p={p} size={32} />
            <h2 id="insp-title" ref={heading} tabIndex={-1} title={p.name}>
              <span className="ih-name">{p.name}{p.symbol ? <>{' '}<span className="ih-sym">{p.symbol}</span></> : null}</span>
              {p.held ? <span className="badge is-accent ih-held" title="You hold this: see Portfolio">Held</span> : null}
              {p.identity_status !== 'verified' ? <span className="badge is-warn ih-held" title={(p.identity_unknowns || []).join(' ') || 'Identity not confirmed: no prices or holdings use it'}>Identity pending</span> : null}
            </h2>
            <div className="ih-win">
              <Menu
                label={`Actions for ${p.name}`}
                align="end"
                trigger={<button type="button" className="btn btn-ghost btn-icon" aria-label={`More actions for ${p.name}`} title="More actions" data-key="panel-more"><Ellipsis size={18} aria-hidden="true" /></button>}
              >
                <MenuItem data-key={`menu-full-${pid}`} onSelect={() => openFull(null)}>Full research page</MenuItem>
                {archived ? null : <MenuItem data-key="menu-research" onSelect={async () => { const Lm = await loadLegacy(); Lm.openResearchDialog(legacyCtx, p); }}>Run research…</MenuItem>}
                {archived ? null : <MenuItem data-key="menu-watch" desc={p.on_watchlist ? 'On your watchlist now' : null} onSelect={() => setWatching(p, !p.on_watchlist)}>{p.on_watchlist ? 'Stop watching' : 'Watch'}</MenuItem>}
                {p.sector ? <MenuItem data-key="menu-sector" desc={p.sector.label} onSelect={async () => { const Lm = await loadLegacy(); Lm.openSectorDialog(legacyCtx, p); }}>Change sector</MenuItem> : null}
                <MenuItem data-key="menu-reviewed" desc={drawn.ready ? null : STILL_LOADING} disabled={!drawn.ready} onSelect={() => markReviewed(p, { force: true, onBusy: setBusy })}>Mark reviewed</MenuItem>
                {p.held ? <MenuItem href="#/portfolio" data-key="menu-held">Holding in Portfolio</MenuItem> : null}
                <MenuSep />
                <MenuLabel>Sections</MenuLabel>
                {[['forensics', 'Forensics'], ['market', 'Market and pools'], ['contract', 'Contract and checks'], ['record', 'Research record']].map(([t, w]) => (
                  <MenuItem key={t} data-key={`menu-${t}-${pid}`} onSelect={() => { navigate(`#/project/${enc(pid)}/${t}`, { state: { crBrief: pid, from: 'watchlist' } }); }}>{w}</MenuItem>
                ))}
                <MenuSep />
                {archived
                  ? <MenuItem data-key="menu-restore" desc="Back as it was, with its history" onSelect={() => restoreProject(p)}>Restore</MenuItem>
                  : <MenuItem data-key="menu-archive" desc="Off your lists; nothing is deleted. Undo right after." onSelect={() => archiveProject(p)}>Archive</MenuItem>}
              </Menu>
              <button type="button" className="btn btn-ghost btn-icon" aria-label={`Close ${p.name} details`} title="Close (Esc)" data-key="panel-close" onClick={closePanel}><X size={18} aria-hidden="true" /></button>
            </div>
          </div>
          <div className="ih-sub">
            <HeadMarket p={p} freshness={d.index.freshness && d.index.freshness.market} />
            <HeadLinks p={p} L={L} />
          </div>
        </header>

        <div className="insp-body" ref={body} data-keep-scroll={`panel:${pid}`}>
          {archived ? (
            <div className="note insp-archived" role="note">
              <span><strong>Archived</strong>{a.archived_at ? ` ${fmtDate(a.archived_at)}` : ''}{a.reason ? `: ${a.reason}` : ''}. Off your lists; its reports, notes, runs and any holding are kept.</span>
              <button type="button" className="btn btn-sm" data-key={`restore-${pid}`} onClick={() => restoreProject(p)}>Restore</button>
            </div>
          ) : null}
          {error ? (
            <div className="note note-warn insp-error" role="alert">
              <span>{`Could not load the full record: ${error.message}. The summary above is current.`}</span>
              <button type="button" className="btn btn-sm" data-key={`insp-retry-${pid}`} onClick={retry}>Try again</button>
            </div>
          ) : null}
          <ModelPanel d={d} p={p} detail={detail} current={current} failed={Boolean(error)} />
        </div>

        <footer className="insp-foot">
          <p className="if-sum" title={p.next_review ? `Next review: ${fmtDate(p.next_review.date)}${p.next_review.overdue ? ' (overdue)' : ''}` : undefined}>
            {ch.item_count ? (
              <>
                <span>{`${ch.item_count} change${ch.item_count === 1 ? '' : 's'} since ${ch.cursor_source === 'project created' ? 'added' : 'your last review'}`}</span>
                <span className="if-dot" aria-hidden="true">·</span>
                <a href={`#/project/${enc(pid)}/notes`} data-key={`what-changed-${pid}`} onClick={(e) => { if (!plain(e)) return; e.preventDefault(); navigate(`#/project/${enc(pid)}/notes`, { state: { crBrief: pid, from: 'watchlist' } }); }}>What changed</a>
              </>
            ) : <span className="if-ok"><Check size={14} aria-hidden="true" />Reviewed</span>}
          </p>
          <div className="if-act">
            <a className="btn btn-sm" href={fullHref} data-key={`brief-${pid}`} aria-label={`Open full research: ${p.name}`} onClick={openFull}>Open full research<ArrowRight size={13} aria-hidden="true" /></a>
            {needsReview(p) ? <button type="button" className="btn btn-sm btn-primary" data-key="panel-reviewed" aria-keyshortcuts="R" title={drawn.ready ? 'Mark reviewed (R marks it and moves to the next project to review)' : STILL_LOADING} aria-disabled={drawn.ready ? undefined : 'true'} disabled={busy || !drawn.ready} onClick={() => markReviewed(p, { onBusy: setBusy })}>{drawn.ready ? 'Mark reviewed' : STILL_LOADING}</button> : null}
          </div>
        </footer>
      </aside>
    </>
  );
}
