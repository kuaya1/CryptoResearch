// The Desk's ledger, Level 0 (DESIGN_AND_IA_BLUEPRINT.md §3.1; UI v3 parity,
// UI_MASTER_PLAYBOOK.md §4.4, 2026-10-30): one grid shared by the head and
// every row. By default Project (logo, name; under it the ticker and Held),
// Price with its change over the chosen window, 7 days, Grade (the canonical
// grade and three model dots, Claude · GPT · Gemini, each filled when within
// 6 points of Claude's grade, amber beyond, hollow with none), Gate (the
// contract gate's tier on the PM ticket; without one, the risk words) and
// Research (the latest report's age, Running while a model works). Sorting
// is in the Desk's options menu; head cells are labels. The Action verb
// shows at the row's right on hover and focus. More columns are in the
// options menu; when the list is narrower than its columns, the least
// essential give way (FIT_ORDER). Every value stays in the inspector.
import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, fmtPrice, fmtDateTime, freshnessText, onHoldOf } from '../../../../public/ui.js';
import {
  COLUMNS, mkt, marketStrings, noPriceReason, holdCell, sortDescription,
  canonicalGrade, consensusOf, riskCell, exitCell, lastResearchCell, actionOf, rangeOf, waitingJobs,
} from '../../../../public/watchlist-model.js';
import { useMedia } from '../../lib/hooks.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, Spark, Unknown, UnknownFigure } from '../../components/figures.jsx';
import { GradePill } from '../../components/GradePill.jsx';

// The least essential columns give way first; the phone's four never do.
const FIT_ORDER = ['sector', 'volChange', 'mcapChange', 'fdv', 'change30d', 'volume', 'mcap', 'change24h', 'change7d', 'price', 'rank', 'research', 'exit', 'lastResearch', 'spark'];
const ESSENTIAL = new Set(['priceStack', 'grade', 'risk']);

export function badgeOpts(d, prov) {
  return { staleDays: d.index.settings.freshness.research_stale_days || 90, hosted: Boolean(d.session && d.session.hosted), onHold: Boolean(onHoldOf(d.index, prov)) };
}

function PriceCell({ p, stacked = false, range = '24h' }) {
  const r = rangeOf(range);
  const reason = noPriceReason(p);
  if (reason) return <Unknown label="Price" reason={reason} />;
  const m = p.market;
  const f = freshnessText(m.status, m.age_minutes);
  return (
    <span className="price-cell" title={`Source: ${m.source || 'CoinGecko'}, as of ${fmtDateTime(m.as_of)}`}>
      <span className="price">{fmtPrice(m.price_usd)}</span>
      {stacked ? <Change value={m[r.field]} label={r.words} className="price-chg" /> : null}
      {m.status !== 'fresh' ? <span className="price-note">{String(f.text).split(' · ').map((part, i) => <span key={part} className="pn">{i ? ` · ${part}` : part}</span>)}</span> : null}
    </span>
  );
}

// The canonical grade and the three model dots (D1). Each dot is a model's
// own grade against Claude's: filled within 6 points, amber beyond, hollow
// with none; the words are in the cell's label and each dot's title. Nothing
// is averaged.
const midOf = (m) => (typeof m.value === 'number' ? m.value : typeof m.low === 'number' && typeof m.high === 'number' ? (m.low + m.high) / 2 : null);
export function GradeCell({ d, p, onOpen }) {
  const g = canonicalGrade(p, d.index);
  const cs = consensusOf(p, d.index);
  const src = g.source === 'headline' ? 'Your headline' : 'Claude';
  const words = g.kind === 'grade' || g.kind === 'range' ? `${g.value}${g.word ? `, ${g.word}` : ''}` : g.kind === 'withheld' ? `withheld${g.coverage !== null ? `, ${g.coverage}% of the weight scored` : ''}` : String(g.value).toLowerCase();
  const label = `${src} grade ${words}. ${cs.text}. Open details`;
  const claude = cs.models.find((m) => m.provider === 'claude');
  const ref = claude ? midOf(claude) : null;
  const refOf = ref !== null ? ref : typeof g.sort === 'number' ? g.sort : null;
  const tone = (m) => {
    const v = midOf(m);
    if (v === null) return 'is-empty';
    return refOf === null || Math.abs(v - refOf) <= 6 ? 'is-near' : 'is-far';
  };
  const shown = g.kind === 'grade' || g.kind === 'range' ? g.value : g.kind === 'withheld' ? 'Withheld' : null;
  return (
    <button type="button" className={`gcell is-${g.kind}`} data-key={`grade-${p.project_id}`} aria-label={label} title={`${g.note}\n${cs.text}`} onClick={(e) => { e.stopPropagation(); onOpen(p.project_id, e.currentTarget); }}>
      <span className={`gcell-v${shown === null ? ' is-none' : ''}${g.kind === 'withheld' ? ' is-wh' : ''}`} aria-hidden="true">{shown === null ? '—' : shown}</span>
      <span className="cg" aria-hidden="true">
        {cs.models.map((m) => <span key={m.provider} className={`cg-dot ${tone(m)}`} title={`${m.name}: ${midOf(m) === null ? 'no grade' : m.words}`} />)}
      </span>
    </button>
  );
}

// The Gate cell: the contract gate's tier on the PM ticket (cr-contract-gate@1),
// observe or enforce; without a verdict, the risk words.
const GATE_TIER = { none: ['No finding', 'is-ok'], review: ['For review', 'is-warn'], hold: ['Hold', 'is-warn'], block: ['Block · Hard pass', 'is-bad'] };
export function GateCell({ d, p }) {
  const g = p.ticket && p.ticket.contract_gate && p.ticket.contract_gate.tier ? p.ticket.contract_gate : null;
  if (g) {
    const [text, tone] = GATE_TIER[g.tier] || [String(g.tier), 'is-warn'];
    const title = `Contract gate (${g.mode === 'enforce' ? 'enforced' : 'observing'}): ${g.words || text}`;
    return <span className={`gate-cell ${tone}`} title={title}><span className="gate-dot" aria-hidden="true" /><span className="gate-w">{text}</span><span className="sr-only">{`. ${title}`}</span></span>;
  }
  const r = riskCell(p, d.index);
  const tone = r.tone === 'bad' ? 'is-bad' : r.tone === 'warn' ? 'is-warn' : r.tone === 'unknown' ? 'is-unknown' : 'is-ok';
  return <span className={`gate-cell ${tone}`} title={r.title}><span className="gate-dot" aria-hidden="true" /><span className="gate-w">{r.text}{r.more ? ` +${r.more}` : ''}</span><span className="sr-only">{r.signals && r.signals.length > 1 ? `. Also: ${r.signals.filter((x) => x.text !== r.text).map((x) => x.text).join(', ')}` : ''}</span></span>;
}

// The Research cell: Running while a model works; else the latest report's
// age, amber from 30 days or never.
const RUNNING = new Set(['running', 'dispatching', 'cowork', 'connector']);
function ResearchCell({ d, p }) {
  if (waitingJobs(p, d.index).some((j) => RUNNING.has(j.key))) return <span className="lr-cell is-running" title="A model is researching this project now">Running</span>;
  const x = lastResearchCell(p, d.index);
  const m = /^(\d+)d$/.exec(x.text);
  const old = x.text === 'Never' || /mo$/.test(x.text) || (m && Number(m[1]) >= 30) || x.tone === 'warn';
  return <span className={`lr-cell${old ? ' is-old' : ''}`} title={x.title}>{x.text}</span>;
}

function Cell({ col, d, p, sources, onSector, onOpen, range }) {
  const m = mkt(p);
  const s = marketStrings(m) || {};
  switch (col) {
    case 'rank': return m && m.market_cap_rank ? <span className="rk" title={m.rank_source_label || 'CoinGecko market-cap rank'}>{m.market_cap_rank}</span> : <Unknown label="Rank" />;
    case 'priceStack': return <PriceCell p={p} stacked range={range} />;
    case 'price': return <PriceCell p={p} />;
    case 'spark': return <span className="spark-cell" title={m && typeof m.change_7d_pct === 'number' ? `7 days: ${s.change7d}` : undefined}><Spark values={m && m.sparkline_7d} change={m ? m.change_7d_pct : null} width={100} height={24} label={`${p.symbol || p.name} 7-day price${m && s.change7d ? `, ${s.change7d}` : ''}`} /></span>;
    case 'grade': return <GradeCell d={d} p={p} onOpen={onOpen} />;
    case 'risk': return <GateCell d={d} p={p} />;
    case 'exit': { const x = exitCell(p, d.index); return <span className={`exit-cell is-${x.tone}`} title={x.title}>{x.text}</span>; }
    case 'lastResearch': return <ResearchCell d={d} p={p} />;
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

// Under the name: the ticker, held, and what keeps the project from prices.
function Marks({ p }) {
  const parts = [];
  if (p.symbol) parts.push(<span key="sym" className="ticker">{p.symbol}</span>);
  if (p.held) parts.push(<span key="held" className="mark-held" title="You hold this: see Portfolio">held</span>);
  if (p.identity_status !== 'verified') parts.push(<span key="id" className="mark-flag" title={(p.identity_unknowns || []).join(' ') || 'Identity not confirmed: no prices or holdings use it'}>identity pending</span>);
  if (p.status === 'archived') parts.push(<span key="arch" className="mark-arch">archived</span>);
  return parts.length ? <span className="marks">{parts.flatMap((x, i) => (i ? [<span key={`s${i}`} aria-hidden="true">{' · '}</span>, x] : [x]))}</span> : null;
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

// The v3 head labels; sorting is in the Desk's options menu (D11).
const HEAD = { name: 'Project', priceStack: 'Price', spark: '7 days', grade: 'Grade', risk: 'Gate', lastResearch: 'Research' };
function Head({ col, sort, sources, label = null }) {
  const c = COLUMNS.find((x) => x.id === col);
  const active = c.sort && sort.key === c.sort;
  const title = col === 'rank' && sources.rank === 'Demo data' ? 'Fictional market-cap rank from the demo data' : c.title;
  return <th scope="col" className={`c-${col}${c.num ? ' num' : ''}`} title={title} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}><span className="th-lbl">{label || HEAD[col] || c.label}</span></th>;
}

function ProviderHead({ d, prov, sort }) {
  const key = `grade:${prov}`;
  const on = sort.key === key;
  const hold = holdCell(d.index, prov, null).hold;
  return (
    <th scope="col" className={`c-prov c-prov-${prov}${hold ? ' is-hold' : ''}`} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} title={`${PROVIDER_LABELS[prov]} grade, 0 to 100${hold ? ', on hold on this desk' : ''}`}>
      <span className="th-lbl">{PROVIDER_SHORT[prov]}</span>
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

// The ledger's grid (§4.4): one template for the head and the rows, from the
// columns shown.
const TRACK = {
  name: 'minmax(130px, 1.6fr)', priceStack: '84px', price: '84px', spark: 'minmax(56px, 90px)', grade: '84px', risk: 'minmax(90px, 1fr)', lastResearch: '58px',
  rank: '32px', exit: '84px', change24h: '64px', change7d: '64px', change30d: '64px', mcapChange: '64px', volChange: '64px', mcap: '76px', fdv: '76px', volume: '76px', sector: 'minmax(80px, 0.8fr)', prov: '44px',
};

export function ProjectTable({ d, rows, columns, sort, onSort, selected, recent, onOpen, onSector, onAction, sources, density = 'comfortable', footer = null, agenda = null, range = '24h' }) {
  const wrap = useRef(null);
  const [hidden, setHidden] = useState([]);
  const [wrapNotes, setWrapNotes] = useState(false);
  const [fitKey, setFitKey] = useState(0);
  const cols = COLUMNS.filter((c) => columns.includes(c.id)).map((c) => c.id);
  const rankFirst = cols.includes('rank');
  const rest = cols.filter((c) => c !== 'rank' && c !== 'research');
  const showModels = cols.includes('research') && !hidden.includes('research');
  // 768-1023px: the 7 days column steps aside (§6).
  const mid = useMedia('(min-width: 768px) and (max-width: 1023.98px)');
  const shown = (c) => !hidden.includes(c) && !(mid && c === 'spark');
  const template = [...(rankFirst && shown('rank') ? ['rank'] : []), 'name', ...rest.filter(shown), ...(showModels ? PROVIDERS.map(() => 'prov') : [])].map((c) => TRACK[c] || '84px').join(' ');
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
      <table className={`wl-table${wrapNotes ? ' wrap-notes' : ''}`} style={{ '--wl-cols': template }}>
        <caption className="sr-only">{`The Desk. ${sortDescription(sort)}. Choose a project name for its details; J and K or the arrow keys move between rows, Space or Enter opens and closes a project, R marks the open project reviewed and moves to the next one with changes to review.`}</caption>
        <thead>
          <tr>
            {rankFirst && shown('rank') ? <Head col="rank" sort={sort} sources={sources} /> : null}
            <th scope="col" className="c-name" aria-sort={sort.key === 'name' ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}><span className="th-lbl">Project</span></th>
            {rest.filter(shown).map((c) => <Head key={c} col={c} sort={sort} sources={sources} label={c === 'exit' ? exitLabel : c === 'priceStack' ? `Price · ${rangeOf(range).label}` : null} />)}
            {showModels ? PROVIDERS.map((prov) => <ProviderHead key={prov} d={d} prov={prov} sort={sort} />) : null}
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
                    <Logo p={p} size={30} />
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
                      </span>
                      <span className="proj-sub"><Marks p={p} /></span>
                    </div>
                  </div>
                </td>
                {rest.filter(shown).map((c) => {
                  const col = COLUMNS.find((x) => x.id === c);
                  return <td key={c} className={`c-${c}${col.num ? ' num' : ''}`}><Cell col={c} d={d} p={p} sources={sources} onSector={onSector} onOpen={onOpen} range={range} /></td>;
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
