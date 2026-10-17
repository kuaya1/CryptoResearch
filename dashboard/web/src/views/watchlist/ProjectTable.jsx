// The Desk's ledger, Level 0 (DESIGN_AND_IA_BLUEPRINT.md §3.1; Eric,
// 2026-10-17): the project frozen on the left (logo, name, ticker; under it
// the sector and Held), then by default Price / 24h, 7D, Grade (the canonical
// grade, D1, with the Claude · GPT · Gemini consensus glyph; each model's
// grade and the spread on hover and in words), Risk (one waterfall), Last
// research, and the Action verb pinned at the right, shown on hover and
// focus. Everything else is in the Columns picker. Figures are right-aligned
// and tabular; unknown stays "—" with its reason. When the list is narrower
// than its columns, the least essential give way (FIT_ORDER); a phone keeps
// Project, Price / 24h, Grade and Risk. Every value stays in the inspector.
import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronRight } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, fmtPrice, fmtDate, fmtDateTime, freshnessText, onHoldOf } from '../../../../public/ui.js';
import {
  COLUMNS, SORT_NAMES, mkt, marketStrings, noPriceReason, holdCell, sortDescription,
  canonicalGrade, consensusOf, riskCell, exitCell, lastResearchCell, actionOf,
} from '../../../../public/watchlist-model.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, Spark, Unknown, UnknownFigure } from '../../components/figures.jsx';
import { GradePill } from '../../components/GradePill.jsx';

// The least essential columns give way first; the phone's four never do.
const FIT_ORDER = ['sector', 'volChange', 'mcapChange', 'fdv', 'change30d', 'volume', 'mcap', 'change24h', 'change7d', 'price', 'rank', 'research', 'exit', 'lastResearch', 'spark'];
const ESSENTIAL = new Set(['priceStack', 'grade', 'risk']);

export function badgeOpts(d, prov) {
  return { staleDays: d.index.settings.freshness.research_stale_days || 90, hosted: Boolean(d.session && d.session.hosted), onHold: Boolean(onHoldOf(d.index, prov)) };
}

function PriceCell({ p, stacked = false }) {
  const reason = noPriceReason(p);
  if (reason) return <Unknown label="Price" reason={reason} />;
  const m = p.market;
  const f = freshnessText(m.status, m.age_minutes);
  return (
    <span className="price-cell" title={`Source: ${m.source || 'CoinGecko'}, as of ${fmtDateTime(m.as_of)}`}>
      <span className="price">{fmtPrice(m.price_usd)}</span>
      {stacked ? <Change value={m.change_24h_pct} label="over 24 hours" className="price-chg" /> : null}
      {m.status !== 'fresh' ? <span className="price-note">{String(f.text).split(' · ').map((part, i) => <span key={part} className="pn">{i ? ` · ${part}` : part}</span>)}</span> : null}
    </span>
  );
}

// The canonical grade, its rubric word and the consensus glyph (D1). The
// glyph's words are in the cell's label and title: each model's own grade
// and the spread; nothing is averaged.
export function GradeCell({ d, p, onOpen }) {
  const g = canonicalGrade(p, d.index);
  const cs = consensusOf(p, d.index);
  const src = g.source === 'headline' ? 'Your headline' : 'Claude';
  const words = g.kind === 'grade' || g.kind === 'range' ? `${g.value}${g.word ? `, ${g.word}` : ''}` : g.kind === 'withheld' ? `withheld${g.coverage !== null ? `, ${g.coverage}% of the weight scored` : ''}` : String(g.value).toLowerCase();
  const label = `${src} grade ${words}. ${cs.text}. Open details`;
  return (
    <button type="button" className={`gcell is-${g.kind}`} data-key={`grade-${p.project_id}`} aria-label={label} title={`${g.note}\n${cs.text}`} onClick={(e) => { e.stopPropagation(); onOpen(p.project_id, e.currentTarget); }}>
      <span className="gcell-main" aria-hidden="true">
        {g.kind === 'grade' || g.kind === 'range' ? (
          <>
            <span className="gcell-v">{g.value}</span>
            {g.word ? <span className={`badge gcell-band tier-${g.tier || 3}`}>{g.word}</span> : null}
          </>
        ) : g.kind === 'withheld' ? <span className="badge gcell-wh">{`Withheld${g.coverage !== null ? ` · ${g.coverage}%` : ''}`}</span>
          : g.kind === 'job' ? <span className={`gcell-state is-${g.job}`}>{g.value}</span>
            : <span className="gcell-none">{g.value}</span>}
        {g.source === 'headline' ? <span className="gcell-pin" title="Your pinned headline report">Pinned</span> : null}
      </span>
      <span className="cg" aria-hidden="true">
        {cs.models.map((m) => <span key={m.provider} className={`cg-dot is-${m.mark}`} title={`${m.name}: ${m.words}`} />)}
      </span>
    </button>
  );
}

export function RiskBadge({ d, p }) {
  const r = riskCell(p, d.index);
  const cls = r.tone === 'bad' ? 'is-bad' : r.tone === 'warn' ? 'is-warn' : r.tone === 'unknown' ? 'is-unknown' : '';
  return <span className={`badge risk-badge ${cls}`} title={r.title}>{r.text}{r.more ? <span className="risk-more">{` +${r.more}`}</span> : null}<span className="sr-only">{r.signals && r.signals.length > 1 ? `. Also: ${r.signals.filter((s) => s.text !== r.text).map((s) => s.text).join(', ')}` : ''}</span></span>;
}

function Cell({ col, d, p, sources, onSector, onOpen }) {
  const m = mkt(p);
  const s = marketStrings(m) || {};
  switch (col) {
    case 'rank': return m && m.market_cap_rank ? <span className="rk" title={m.rank_source_label || 'CoinGecko market-cap rank'}>{m.market_cap_rank}</span> : <Unknown label="Rank" />;
    case 'priceStack': return <PriceCell p={p} stacked />;
    case 'price': return <PriceCell p={p} />;
    case 'spark': return <span className="spark-cell" title={m && typeof m.change_7d_pct === 'number' ? `7 days: ${s.change7d}` : undefined}><Spark values={m && m.sparkline_7d} change={m ? m.change_7d_pct : null} width={96} height={30} label={`${p.symbol || p.name} 7-day price${m && s.change7d ? `, ${s.change7d}` : ''}`} /></span>;
    case 'grade': return <GradeCell d={d} p={p} onOpen={onOpen} />;
    case 'risk': return <RiskBadge d={d} p={p} />;
    case 'exit': { const x = exitCell(p); return <span className={`exit-cell is-${x.tone}`} title={x.title}>{x.text}</span>; }
    case 'lastResearch': { const x = lastResearchCell(p, d.index); return <span className={`lr-cell${x.tone ? ` is-${x.tone}` : ''}`} title={x.title}>{x.text}</span>; }
    case 'change24h': return m ? <Change value={m.change_24h_pct} label="over 24 hours" /> : <Unknown label="24-hour change" />;
    case 'change7d': return m ? <Change value={m.change_7d_pct} label="over 7 days" /> : <Unknown label="7-day change" />;
    case 'change30d': return m ? <Change value={m.change_30d_pct} label="over 30 days" /> : <Unknown label="30-day change" />;
    case 'mcap': return m && s.mcap ? <span title={fmtPrice(m.market_cap_usd)}>{s.mcap}</span> : m ? <UnknownFigure label="Market cap" value={m.market_cap_usd} /> : <Unknown label="Market cap" />;
    case 'mcapChange': return m ? <Change value={m.market_cap_change_24h_pct} label="market cap over 24 hours" /> : <Unknown label="Market-cap change" />;
    case 'fdv': return m && s.fdv ? s.fdv : m ? <UnknownFigure label="FDV" value={m.fdv_usd} /> : <Unknown label="FDV" />;
    case 'volume': return m && s.volume ? s.volume : m ? <UnknownFigure label="Volume" value={m.volume_24h_usd} /> : <Unknown label="Volume" />;
    case 'volChange': return m && typeof m.volume_change_24h_pct === 'number' ? <Change value={m.volume_change_24h_pct} label="volume" /> : <Unknown label="Volume change" reason={m ? m.volume_change_basis || null : 'No market data'} />;
    case 'sector': return p.sector ? <button type="button" className="chip-btn" data-key={`sector-${p.project_id}`} aria-label={`Sector: ${p.sector.label}. Change sector`} title="Your label; change it here" onClick={(e) => { e.stopPropagation(); onSector(p, e.currentTarget); }}>{p.sector.label}</button> : <Unknown label="Sector" />;
    default: return null;
  }
}

function Marks({ p }) {
  const marks = [];
  if (p.sector && p.sector.primary) marks.push(<span key="sector" className="proj-sector" title="Sector (your label)">{p.sector.label}</span>);
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
  return <GradePill provider={prov} report={rep} job={job} opts={badgeOpts(d, prov)} asButton data-key={`gb-${p.project_id}-${prov}`} onClick={(e) => { e.stopPropagation(); onOpen(p.project_id, e.currentTarget, prov); }} />;
}

function SortHead({ col, sort, onSort, sources, label = null }) {
  const c = COLUMNS.find((x) => x.id === col);
  const active = sort.key === c.sort;
  const title = col === 'rank' && sources.rank === 'Demo data' ? 'Fictional market-cap rank from the demo data' : c.title;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  const text = label || c.label;
  if (!c.sort) return <th scope="col" className={`c-${col}${c.num ? ' num' : ''}`} title={title}><span className="th-lbl">{text}</span></th>;
  return (
    <th scope="col" className={`c-${col}${c.num ? ' num' : ''}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="th-sort" data-key={`sort-${c.sort}`} title={title} onClick={() => onSort(c.sort)}>
        <span className="th-lbl">{text}</span>
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

// The Action verb: one verb for the project's state, pinned at the right and
// shown on hover and keyboard focus; it opens exactly one place.
function ActionCell({ d, p, onOpen, onAction, agenda = null }) {
  const a = actionOf(p, d.index, agenda);
  if (!a) return null;
  return (
    <button type="button" className="row-act" data-key={`act-${p.project_id}`} aria-label={`${a.verb}: ${p.name}`} onClick={(e) => { e.stopPropagation(); onAction(p, a, e.currentTarget); }}>
      <span>{a.verb}</span><ChevronRight size={13} aria-hidden="true" />
    </button>
  );
}

export function ProjectTable({ d, rows, columns, sort, onSort, selected, recent, onOpen, onSector, onAction, sources, density = 'comfortable', footer = null, agenda = null }) {
  const wrap = useRef(null);
  const [hidden, setHidden] = useState([]);
  const [wrapNotes, setWrapNotes] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const cols = COLUMNS.filter((c) => columns.includes(c.id)).map((c) => c.id);
  const rankFirst = cols.includes('rank');
  const rest = cols.filter((c) => c !== 'rank' && c !== 'research');
  const showModels = cols.includes('research') && !hidden.includes('research');
  const shown = (c) => !hidden.includes(c);
  const exitLabel = (() => { const f = rows.find((p) => p.forensic && p.forensic.position_usd); return f ? `Exit @ $${f.forensic.position_usd.toLocaleString('en-US')}` : null; })();

  // Columns give way, least essential first, until the table fits; before an
  // essential one would, a stale price's note may take two lines. A new
  // width, new columns or a new number of rows fit again from all of them.
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
      if (hidden.includes(id) || !cols.includes(id) || ESSENTIAL.has(id)) continue;
      if (id === 'spark' && !wrapNotes) {
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
    <div className={`wl-scroll density-${density}`} ref={wrap} data-keep-scroll="watchlist" data-fit={fitKey}>
      <table className={`wl-table${wrapNotes ? ' wrap-notes' : ''}`}>
        <caption className="sr-only">{`The Desk. ${sortDescription(sort)}. Choose a project name for its details; J and K or the arrow keys move between rows, Space or Enter opens and closes a project, R marks the open project reviewed and moves to the next one with changes to review.`}</caption>
        <thead>
          <tr>
            {rankFirst && shown('rank') ? <SortHead col="rank" sort={sort} onSort={onSort} sources={sources} /> : null}
            <th scope="col" className="c-name" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              <button type="button" className="th-sort" data-key="sort-name" onClick={() => onSort('name')}>
                <span className="th-lbl">Project</span>
                {sort.key === 'name' ? (sort.dir === 'asc' ? <ArrowUp className="th-arrow" size={12} strokeWidth={2.2} aria-hidden="true" /> : <ArrowDown className="th-arrow" size={12} strokeWidth={2.2} aria-hidden="true" />) : null}
              </button>
            </th>
            {rest.filter(shown).map((c) => <SortHead key={c} col={c} sort={sort} onSort={onSort} sources={sources} label={c === 'exit' ? exitLabel : null} />)}
            {showModels ? PROVIDERS.map((prov) => <ProviderHead key={prov} d={d} prov={prov} sort={sort} onSort={onSort} />) : null}
            <th scope="col" className="c-act"><span className="sr-only">Action</span></th>
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
                {rankFirst && shown('rank') ? <td className="c-rank num"><Cell col="rank" d={d} p={p} sources={sources} /></td> : null}
                <td className="c-name">
                  <div className="proj">
                    <Logo p={p} size={28} />
                    <div className="proj-names">
                      <span className="proj-top">
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
                        {p.symbol ? <span className="ticker">{p.symbol}</span> : null}
                      </span>
                      <span className="proj-sub"><Marks p={p} /></span>
                    </div>
                  </div>
                </td>
                {rest.filter(shown).map((c) => {
                  const col = COLUMNS.find((x) => x.id === c);
                  return <td key={c} className={`c-${c}${col.num ? ' num' : ''}`}><Cell col={c} d={d} p={p} sources={sources} onSector={onSector} onOpen={onOpen} /></td>;
                })}
                {showModels ? PROVIDERS.map((prov) => <td key={prov} className={`c-prov c-prov-${prov}`}><ModelCell d={d} p={p} prov={prov} onOpen={onOpen} /></td>) : null}
                <td className="c-act"><ActionCell d={d} p={p} onOpen={onOpen} onAction={onAction} agenda={agenda} /></td>
              </tr>
            );
          })}
        </tbody>
        {footer ? (
          <tfoot>
            <tr><td colSpan={99} className="wl-foot">{footer}</td></tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
