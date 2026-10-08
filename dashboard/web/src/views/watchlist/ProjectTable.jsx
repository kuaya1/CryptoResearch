// The list: CoinMarketCap's column order (# rank, Name, Price, 24h %, 7d %,
// 30d %, Market Cap, Volume(24h), 7D Chart), then each model's own grade in
// its own column; never a combined score. Figures are right-aligned and
// tabular; unknown stays "—" with its reason. When the list is narrower than
// its columns, the least essential give way (FIT_ORDER), every value staying
// in the inspector; below 720px each project is a card.
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, fmtPrice, fmtDate, fmtDateTime, freshnessText, onHoldOf } from '../../../../public/ui.js';
import { COLUMNS, SORT_NAMES, mkt, marketStrings, noPriceReason, holdCell, sortDescription } from '../../../../public/watchlist-model.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, Spark, Unknown, UnknownFigure } from '../../components/figures.jsx';
import { GradePill } from '../../components/GradePill.jsx';

// Optional columns first, then the defaults: 30d %, volume, the 7-day chart,
// market cap (Eric's order), then the rest.
const FIT_ORDER = ['lastResearch', 'sector', 'volChange', 'mcapChange', 'fdv', 'change30d', 'volume', 'spark', 'mcap', 'change24h', 'rank', 'change7d', 'price'];

export function badgeOpts(d, prov) {
  return { staleDays: d.index.settings.freshness.research_stale_days || 90, hosted: Boolean(d.session && d.session.hosted), onHold: Boolean(onHoldOf(d.index, prov)) };
}

function PriceCell({ p }) {
  const reason = noPriceReason(p);
  if (reason) return <Unknown label="Price" reason={reason} />;
  const m = p.market;
  const f = freshnessText(m.status, m.age_minutes);
  return (
    <span className="price-cell" title={`Source: ${m.source || 'CoinGecko'}, as of ${fmtDateTime(m.as_of)}`}>
      <span className="price">{fmtPrice(m.price_usd)}</span>
      {m.status !== 'fresh' ? <span className="price-note">{String(f.text).split(' · ').map((part, i) => <span key={part} className="pn">{i ? ` · ${part}` : part}</span>)}</span> : null}
    </span>
  );
}

function Cell({ col, p, sources, onSector }) {
  const m = mkt(p);
  const s = marketStrings(m) || {};
  switch (col) {
    case 'rank': return m && m.market_cap_rank ? <span className="rk" title={m.rank_source_label || 'CoinGecko market-cap rank'}>{m.market_cap_rank}</span> : <Unknown label="Rank" />;
    case 'price': return <PriceCell p={p} />;
    case 'change24h': return m ? <Change value={m.change_24h_pct} label="over 24 hours" /> : <Unknown label="24-hour change" />;
    case 'change7d': return m ? <Change value={m.change_7d_pct} label="over 7 days" /> : <Unknown label="7-day change" />;
    case 'change30d': return m ? <Change value={m.change_30d_pct} label="over 30 days" /> : <Unknown label="30-day change" />;
    case 'mcap': return m && s.mcap ? <span title={fmtPrice(m.market_cap_usd)}>{s.mcap}</span> : m ? <UnknownFigure label="Market cap" value={m.market_cap_usd} /> : <Unknown label="Market cap" />;
    case 'mcapChange': return m ? <Change value={m.market_cap_change_24h_pct} label="market cap over 24 hours" /> : <Unknown label="Market-cap change" />;
    case 'fdv': return m && s.fdv ? s.fdv : m ? <UnknownFigure label="FDV" value={m.fdv_usd} /> : <Unknown label="FDV" />;
    case 'volume': return m && s.volume ? s.volume : m ? <UnknownFigure label="Volume" value={m.volume_24h_usd} /> : <Unknown label="Volume" />;
    case 'volChange': return m && typeof m.volume_change_24h_pct === 'number' ? <Change value={m.volume_change_24h_pct} label="volume" /> : <Unknown label="Volume change" reason={m ? m.volume_change_basis || null : 'No market data'} />;
    case 'spark': return <Spark values={m && m.sparkline_7d} change={m ? m.change_7d_pct : null} width={108} height={34} label={`${p.symbol || p.name} 7-day price`} />;
    case 'sector': return p.sector ? <button type="button" className="chip-btn" data-key={`sector-${p.project_id}`} aria-label={`Sector: ${p.sector.label}. Change sector`} title="Your label; change it here" onClick={(e) => { e.stopPropagation(); onSector(p, e.currentTarget); }}>{p.sector.label}</button> : <Unknown label="Sector" />;
    case 'lastResearch': return p.last_report_at ? <span title="Latest report analysis date">{fmtDate(p.last_report_at)}</span> : <Unknown label="Last research" />;
    default: return null;
  }
}

function Marks({ p }) {
  const marks = [];
  if (p.held) marks.push(<span key="held" className="mark mark-held" title="You hold this: see Portfolio">Held</span>);
  if (p.identity_status !== 'verified') marks.push(<span key="id" className="mark mark-flag" title={(p.identity_unknowns || []).join(' ') || 'Identity not confirmed: no prices or holdings use it'}>Identity pending</span>);
  if (p.status === 'archived') marks.push(<span key="arch" className="mark">Archived</span>);
  return marks.length ? <span className="marks">{marks}</span> : null;
}

function ModelCell({ d, p, prov, onOpen }) {
  const rep = p.providers && p.providers[prov];
  const job = p.research && p.research.providers && p.research.providers[prov];
  if (holdCell(d.index, prov, rep).dash) {
    return (
      <button type="button" className="gp gp-dash" aria-label={`No ${PROVIDER_LABELS[prov]} score`} title={`No ${PROVIDER_LABELS[prov]} report yet: ${PROVIDER_LABELS[prov]} is on hold on this desk`} data-key={`gb-${p.project_id}-${prov}`} data-provider={prov} onClick={(e) => { e.stopPropagation(); onOpen(p.project_id, e.currentTarget, prov); }}>
        <span aria-hidden="true">—</span>
      </button>
    );
  }
  return (
    <GradePill
      provider={prov}
      report={rep}
      job={job}
      opts={badgeOpts(d, prov)}
      asButton
      data-key={`gb-${p.project_id}-${prov}`}
      onClick={(e) => { e.stopPropagation(); onOpen(p.project_id, e.currentTarget, prov); }}
    />
  );
}

function SortHead({ col, sort, onSort, sources }) {
  const c = COLUMNS.find((x) => x.id === col);
  const active = sort.key === c.sort;
  const title = col === 'rank' && sources.rank === 'Demo data' ? 'Fictional market-cap rank from the demo data' : c.title;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  if (!c.sort) return <th scope="col" className={`c-${col}${c.num ? ' num' : ''}`} title={title}><span className="th-lbl">{c.label}</span></th>;
  return (
    <th scope="col" className={`c-${col}${c.num ? ' num' : ''}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" data-key={`sort-${c.sort}`} title={title} onClick={() => onSort(c.sort)}>
        <span className="th-lbl">{c.label}</span>
        {active ? <Arrow className="th-arrow" size={12} strokeWidth={2.2} aria-hidden="true" /> : null}
      </button>
    </th>
  );
}

function ProviderHead({ d, prov, sort, onSort }) {
  const key = `grade:${prov}`;
  const on = sort.key === key;
  const hold = holdCell(d.index, prov, null).hold;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" className={`c-prov c-prov-${prov}${hold ? ' is-hold' : ''}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" data-key={`sort-${key}`} aria-label={`${PROVIDER_LABELS[prov]} grade, 0 to 100${hold ? ', on hold on this desk' : ''}. Sort${on ? `ed ${SORT_NAMES[key][sort.dir === 'asc' ? 1 : 2]}` : ''}`} onClick={() => onSort(key)}>
        <span className="th-stack">
          <span className="th-lbl">{PROVIDER_SHORT[prov]}{on ? <Arrow className="th-arrow" size={12} strokeWidth={2.2} aria-hidden="true" /> : null}</span>
          {hold ? <span className="th-hold" aria-hidden="true">on hold</span> : null}
        </span>
      </button>
    </th>
  );
}

export function ProjectTable({ d, rows, columns, sort, onSort, selected, recent, onOpen, onSector, sources }) {
  const wrap = useRef(null);
  const [hidden, setHidden] = useState([]);
  const [wrapNotes, setWrapNotes] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const cols = COLUMNS.filter((c) => columns.includes(c.id)).map((c) => c.id);
  const rankFirst = cols.includes('rank');
  const rest = cols.filter((c) => c !== 'rank' && c !== 'research');
  const showModels = cols.includes('research');
  const shown = (c) => !hidden.includes(c);

  // Columns give way, least essential first, until the table fits; before an
  // essential column (24h % onward) gives way, a stale price's note may take
  // two lines (Eric, 2026-10-06). A new width, new columns or a new number of
  // rows fit again from all of them.
  const sig = `${columns.join(',')}|${rows.length}|${fitKey}`;
  const lastSig = useRef(sig);
  useLayoutEffect(() => {
    const sc = wrap.current;
    if (!sc) return;
    if (lastSig.current !== sig) {
      lastSig.current = sig;
      if (hidden.length || wrapNotes) {
        setHidden([]);
        setWrapNotes(false);
        return;
      }
    }
    if (sc.scrollWidth <= sc.clientWidth + 1) return;
    for (const id of FIT_ORDER) {
      if (hidden.includes(id) || !cols.includes(id)) continue;
      if (id === 'change24h' && !wrapNotes) {
        setWrapNotes(true);
        return;
      }
      setHidden((h) => [...h, id]);
      return;
    }
  });
  useLayoutEffect(() => {
    const sc = wrap.current;
    if (!sc || typeof ResizeObserver !== 'function') return undefined;
    let w = sc.clientWidth;
    const ro = new ResizeObserver(() => {
      if (Math.abs(sc.clientWidth - w) < 2) return;
      w = sc.clientWidth;
      setFitKey((k) => k + 1);
    });
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="wl-scroll" ref={wrap} data-keep-scroll="watchlist" data-fit={fitKey}>
      <table className={`wl-table${wrapNotes ? ' wrap-notes' : ''}`}>
        <caption className="sr-only">{`Watchlist. ${sortDescription(sort)}. Choose a project name for its details; J and K or the arrow keys move between rows, Space or Enter opens and closes a project, R marks the open project reviewed and moves to the next one with changes to review.`}</caption>
        <thead>
          <tr>
            {rankFirst && shown('rank') ? <SortHead col="rank" sort={sort} onSort={onSort} sources={sources} /> : null}
            <th scope="col" className="c-name" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              <button type="button" className="th-sort" data-key="sort-name" onClick={() => onSort('name')}>
                <span className="th-lbl">Name</span>
                {sort.key === 'name' ? (sort.dir === 'asc' ? <ArrowUp className="th-arrow" size={12} strokeWidth={2.2} aria-hidden="true" /> : <ArrowDown className="th-arrow" size={12} strokeWidth={2.2} aria-hidden="true" />) : null}
              </button>
            </th>
            {rest.filter(shown).map((c) => <SortHead key={c} col={c} sort={sort} onSort={onSort} sources={sources} />)}
            {showModels ? PROVIDERS.map((prov) => <ProviderHead key={prov} d={d} prov={prov} sort={sort} onSort={onSort} />) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const sel = p.project_id === selected;
            const cls = sel ? 'is-selected' : !selected && p.project_id === recent ? 'is-recent' : '';
            return (
              <tr
                key={p.project_id}
                className={cls}
                data-pid={p.project_id}
                onClick={(e) => {
                  if (e.target.closest('button, a, input, select, label, summary, details')) return;
                  onOpen(p.project_id, e.currentTarget.querySelector('.pname'));
                }}
              >
                {rankFirst && shown('rank') ? <td className="c-rank num"><Cell col="rank" p={p} sources={sources} /></td> : null}
                <td className="c-name">
                  <div className="proj">
                    <Logo p={p} size={28} />
                    <div className="proj-names">
                      <button
                        type="button"
                        className="pname"
                        title={p.name}
                        data-key={`pname-${p.project_id}`}
                        aria-label={`${p.name}${p.symbol ? ` (${p.symbol})` : ''}: open details`}
                        aria-expanded={sel}
                        onClick={(e) => { e.stopPropagation(); onOpen(p.project_id, e.currentTarget); }}
                      >
                        {p.name}
                      </button>
                      <span className="proj-sub">
                        {p.symbol ? <span className="ticker">{p.symbol}</span> : null}
                        <Marks p={p} />
                      </span>
                    </div>
                  </div>
                </td>
                {rest.filter(shown).map((c) => {
                  const col = COLUMNS.find((x) => x.id === c);
                  return <td key={c} className={`c-${c}${col.num ? ' num' : ''}`}><Cell col={c} p={p} sources={sources} onSector={onSector} /></td>;
                })}
                {showModels ? PROVIDERS.map((prov) => <td key={prov} className={`c-prov c-prov-${prov}`}><ModelCell d={d} p={p} prov={prov} onOpen={onOpen} /></td>) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// A phone: each project a card. Identity and price first, then each model's
// grade with its name, then the market in one quiet line.
export function ProjectCards({ d, rows, selected, recent, onOpen }) {
  return (
    <ul className="wl-cards" aria-label="Projects">
      {rows.map((p) => {
        const m = mkt(p);
        const s = marketStrings(m) || {};
        const reason = noPriceReason(p);
        const sel = p.project_id === selected;
        return (
          <li key={p.project_id} className={`wl-card${sel ? ' is-selected' : ''}${!selected && p.project_id === recent ? ' is-recent' : ''}`} data-pid={p.project_id}>
            <div className="wc-top">
              <Logo p={p} size={32} />
              <div className="wc-names">
                <button type="button" className="pname wc-name" data-key={`pname-${p.project_id}`} aria-label={`${p.name}${p.symbol ? ` (${p.symbol})` : ''}: open details`} onClick={(e) => onOpen(p.project_id, e.currentTarget)}>
                  {p.name}
                </button>
                <span className="wc-sub">
                  {p.symbol ? <span className="ticker">{p.symbol}</span> : null}
                  <Marks p={p} />
                </span>
              </div>
              <div className="wc-price">
                {reason || !m ? <span className="unknown wc-noprice">{reason || 'No price'}</span> : (
                  <>
                    <span className="price">{s.price}</span>
                    <Change value={m.change_24h_pct} label="over 24 hours" className="wc-chg" />
                  </>
                )}
              </div>
            </div>
            <div className="wc-models">
              {PROVIDERS.map((prov) => (
                <div key={prov} className="wc-model">
                  <span className="wc-model-name">{PROVIDER_SHORT[prov]}</span>
                  <ModelCell d={d} p={p} prov={prov} onOpen={onOpen} />
                </div>
              ))}
            </div>
            {m ? (
              <p className="wc-market">
                <span><span className="k">7d</span> <Change value={m.change_7d_pct} label="over 7 days" /></span>
                <span><span className="k">MC</span> {s.mcap || '—'}</span>
                <span><span className="k">Vol</span> {s.volume || '—'}</span>
                {m.status !== 'fresh' ? <span className="price-note">{freshnessText(m.status, m.age_minutes).text}</span> : null}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
