// The project page's Compare view (#/project/<id>/compare[?a=<report|none>&
// b=<report|none>&order=profile]): two saved reports on the project side by
// side, read from the project record the page already holds
// (public/compare-desk.js) under the Second opinion's own rules
// (public/compare-model.js). By default the desk's latest eligible Claude and
// ChatGPT reports; a model without one says why, and nothing is put in its
// place. Each report keeps its own grade: no consensus, no midpoint, no
// winner. Comparable category differences come first, each with the basis
// each report stores for its own grade; where those records do not explain a
// difference the view says so. The research scope and the authorship are two
// separate facts. Choosing reports, the order and opening a basis are reads:
// nothing is written, fetched or asked of a model, and the Explorer's demo
// records are never read here. Ported from views/brief-compare.js.
import { useMemo, useState } from 'react';
import { CircleHelp, OctagonAlert, TriangleAlert } from 'lucide-react';
import { fmtDate, fmtNum, scoreTier, announce, PROVIDER_LABELS, COVERAGE_MEANS, TAG_TITLES } from '../../../../public/ui.js';
import { MODEL_LABELS, NOTABLE_GAP, valueOf, valueText } from '../../../../public/compare-model.js';
import { deskRecords, latestRecord, missingSide, basisOf, compareView, deskChoices, FIGURE_WORDS } from '../../../../public/compare-desk.js';
import { TAG_WORDS } from '../../../../public/brief-model.js';
import { hosted } from '../../lib/desk.js';
import { useDesk } from '../../lib/hooks.js';
import { navigate, hrefWith, claimFocus } from '../../lib/router.js';
import { ScoreBar } from '../../components/ScoreBar.jsx';
import { ViewLink } from './Overview.jsx';
import { ExtLink, Segments, enc } from './kit.jsx';
import '../../styles/evidence.css';

const MODELS = ['claude', 'chatgpt', 'gemini'];
const CONFIDENCE = { high: 'high confidence', medium: 'medium confidence', low: 'low confidence' };
const REVISION_WORDS = { format_fix: 'format fix', reassessment: 'reassessment', new_evidence: 'new evidence', other: 'other reason', not_stated: 'reason not stated' };
const list = (v) => (Array.isArray(v) ? v : []);

// ---- the pair and the order, kept per project ------------------------------------------

// The pair, the order and the open bases chosen on each project's Compare
// view, kept while the page is open (a live update or a return draws the same
// choice). An address seeds it (?a=<report>&b=<report>, "none" for an empty
// side; &order=profile); a choice writes it back in place.
const STATE = new Map();
const seedOf = (q) => ['a', 'b', 'order'].map((k) => `${k}=${q.get(k) || ''}`).join('&');

function stateFor(pid, query) {
  const seed = seedOf(query);
  let st = STATE.get(pid);
  if (!st || (st.seed !== seed && (query.has('a') || query.has('b') || query.has('order')))) {
    st = { seed, a: query.get('a'), b: query.get('b'), order: query.get('order') === 'profile' ? 'profile' : 'inspection', picked: query.has('a') || query.has('b'), fresh: true, open: new Set() };
    STATE.set(pid, st);
  }
  return st;
}

const wide = () => typeof matchMedia !== 'function' || matchMedia('(min-width: 761px)').matches;

// Rewrites the address without a new entry and keeps the reader's place and
// focus (the page would otherwise start again at its top).
function inPlace(st, params, focusKey) {
  const href = hrefWith(params);
  const qs = href.includes('?') ? href.slice(href.indexOf('?') + 1) : '';
  st.seed = seedOf(new URLSearchParams(qs));
  const y = window.scrollY;
  navigate(href, { replace: true, state: history.state });
  claimFocus();
  requestAnimationFrame(() => {
    window.scrollTo(0, y);
    const el = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  });
}

// A <details> whose open state is kept with the pair.
function Keep({ st, k, bump, className, children }) {
  return (
    <details
      className={className}
      data-key={k}
      open={st.open.has(k)}
      onToggle={(e) => {
        const o = e.currentTarget.open;
        if (o === st.open.has(k)) return;
        if (o) st.open.add(k);
        else st.open.delete(k);
        bump();
      }}
    >
      {children}
    </details>
  );
}

// A white card on the canvas with its head band.
function Card({ hid = null, title = null, sub = null, actions = null, label = null, className = '', children }) {
  return (
    <section className={`l2-panel ${className}`.trim()} aria-labelledby={title ? hid : undefined} aria-label={!title && label ? label : undefined}>
      {title ? (
        <header className="l2-panel-head">
          <h2 className="l2-panel-t" id={hid} tabIndex={-1}>{title}</h2>
          {sub ? <span className="l2-panel-sub">{sub}</span> : null}
          {actions ? <div className="l2-panel-act">{actions}</div> : null}
        </header>
      ) : null}
      <div className="l2-panel-body">{children}</div>
    </section>
  );
}

// ---- small pieces ------------------------------------------------------------------------

const gradeWords = (r) => (r.grade_status === 'firm' || r.grade_status === 'range' ? r.grade_display || '—'
  : r.grade_status === 'withheld' ? 'Withheld' : 'No grade');

function Bar({ s }) {
  const x = valueOf(s);
  if (x.kind === 'point') return <ScoreBar score={{ status: 'scored', value: x.v }} />;
  if (x.kind === 'range') return <ScoreBar score={{ status: 'range', low: x.lo, high: x.hi }} />;
  if (x.kind === 'na') return <span className="bar cmx-na" aria-hidden="true" />;
  return <ScoreBar score={null} />;
}

function Verdict({ v }) {
  if (!v) return <span className="faint" title="The report did not give one of the six verdict labels">No verdict</span>;
  return <span className="cmx-verdict-w" title="Verdict as written by the report">{v.charAt(0) + v.slice(1).toLowerCase()}</span>;
}

function whereWords(r, all, d) {
  const parts = [];
  if (latestRecord(d, [r], r.model)) parts.push(`${MODEL_LABELS[r.model]}'s latest`);
  else parts.push('An earlier report');
  if (r.revision_of) parts.push(`revision · ${REVISION_WORDS[r.revision_kind] || 'reason not stated'}`);
  if (all.some((x) => x.revision_of === r.report_id)) parts.push('revised later');
  return parts.join(' · ');
}

// One report at the top: its name on this screen, the desk's grade (a figure,
// a range, or withheld with the share of the weight scored), its verdict, its
// research date, where it sits, and its evidence flags in words.
function SideCard({ r, who, all, d }) {
  const tier = r.grade_status === 'firm' ? scoreTier(r.grade_value) : r.grade_status === 'range' ? scoreTier(r.grade_low) : null;
  const flags = r.evidence_high ? `${r.evidence_high} serious evidence flag${r.evidence_high === 1 ? '' : 's'}` : r.evidence_medium ? `${r.evidence_medium} evidence flag${r.evidence_medium === 1 ? '' : 's'}` : null;
  const Icon = r.evidence_high ? OctagonAlert : TriangleAlert;
  return (
    <div className="cmx-side">
      <p className="cmx-who">{who}</p>
      <div className="cmx-grade-row">
        <span className={`cmx-grade g-${r.grade_status}${tier ? ` tier-${tier}` : ''}`} title={r.grade_status === 'withheld' ? COVERAGE_MEANS : 'Calculated by the desk from this report\'s six weighted components; never the model\'s own total.'}>
          {gradeWords(r)}
        </span>
        <span className="cmx-grade-k">{r.grade_status === 'withheld' && typeof r.grade_coverage_pct === 'number' ? `${r.grade_coverage_pct}% of the weight scored` : 'Investment grade'}</span>
      </div>
      <p className="cmx-verdict"><Verdict v={r.verdict} /></p>
      <p className="cmx-meta">{`Analysis ${r.research_date ? fmtDate(r.research_date) : r.analysis_at || 'date not stated'}`}<span aria-hidden="true"> · </span>{whereWords(r, all, d)}</p>
      {flags ? <p className={`cmx-flag ${r.evidence_high ? 'is-serious' : 'is-material'}`}><Icon size={14} aria-hidden="true" /><span>{flags}</span></p> : null}
    </div>
  );
}

function EmptyCard({ miss }) {
  return (
    <div className="cmx-side is-empty">
      <p className="cmx-who">{miss.who}</p>
      <p className="cmx-none">{miss.text}</p>
    </div>
  );
}

// ---- the pickers --------------------------------------------------------------------------

function optionLabel(c, d) {
  const r = c.report;
  const where = [latestRecord(d, [r], r.model) ? 'latest' : null, r.revision_of ? 'revision' : null, c.revisedBy.length ? 'revised later' : null].filter(Boolean).join(', ');
  return `${MODEL_LABELS[r.model]} · ${r.research_date ? fmtDate(r.research_date) : `saved ${fmtDate(r.saved_at)}`} · ${gradeWords(r)}${where ? ` · ${where}` : ''}`;
}

function Picker({ label, dataKey, choices, selected, d, onPick }) {
  return (
    <label className="cmx-pick">
      <span className="cmx-pick-l">{label}</span>
      <select className="input" aria-label={label} data-key={dataKey} value={selected ? selected.report_id : 'none'} onChange={(e) => onPick(e.target.value)}>
        <option value="none">— No report —</option>
        {MODELS.filter((m) => choices.some((c) => c.model === m)).map((m) => (
          <optgroup key={m} label={MODEL_LABELS[m]}>
            {choices.filter((c) => c.model === m).map((c) => <option key={c.report.report_id} value={c.report.report_id}>{optionLabel(c, d)}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

// ---- the status: scope, authorship, versions ---------------------------------------------------

function StatusBlock({ v }) {
  const s = v.cmp.scope;
  const a = v.cmp.authorship;
  const ver = v.cmp.versions;
  const warn = !s.confirmed || !a.independent || !ver.compatible;
  const lines = [];
  if (!s.confirmed) lines.push(s.text);
  if (!a.independent) lines.push(`${a.label}: not an independent second opinion.`);
  if (!ver.compatible) lines.push(`${ver.label}: the category numbers are shown side by side and not compared.`);
  if (s.confirmed) lines.push(s.caveat);
  return (
    <div className={`cmx-status ${warn ? 'is-warn' : 'is-ok'}`} role="note">
      <p className="cmx-status-h">{warn ? <TriangleAlert size={15} aria-hidden="true" /> : null}<strong>{s.label}</strong><span aria-hidden="true"> · </span><strong>{a.label}</strong></p>
      {lines.map((t) => <p key={t}>{t}</p>)}
    </div>
  );
}

const factText = (x) => String(x).replace(/(\d{4}-\d{2}-\d{2})/g, (y) => fmtDate(y));

function FactRow({ f, names }) {
  const [na, nb] = names;
  return (
    <div className={f.differs ? 'is-differs' : f.missing ? 'is-missing' : undefined}>
      <dt>{f.what}</dt>
      <dd>{f.a === f.b ? `${factText(f.a)}${f.missing ? ' by either' : ' · same'}` : <><span>{`${na}: ${factText(f.a)}`}</span><span aria-hidden="true"> · </span><span>{`${nb}: ${factText(f.b)}`}</span></>}</dd>
    </div>
  );
}

// The facts of the research scope that differ or are missing, in words, the
// research date apart; all of them stay in the details.
function ScopeFacts({ v, st, bump }) {
  const shown = v.scope_differences;
  return (
    <div className="cmx-scope">
      {shown.length ? <dl className="cmx-facts">{shown.map((f) => <FactRow key={f.what} f={f} names={v.names} />)}</dl> : null}
      <Keep st={st} k="cmp-scope-all" bump={bump} className="fold cmx-scope-all">
        <summary data-key="cmp-scope-all-summary">Research scope, dates and versions</summary>
        <div className="fold-body">
          <dl className="cmx-facts is-all">{v.cmp.scope.facts.map((f) => <FactRow key={f.what} f={f} names={v.names} />)}</dl>
          <p className="cmx-ver"><strong>{v.cmp.versions.label}</strong>{`: ${v.cmp.versions.text}`}</p>
          <p className="cmx-ver"><strong>{v.cmp.authorship.label}</strong>{`: ${v.cmp.authorship.text}`}</p>
        </div>
      </Keep>
    </div>
  );
}

// ---- the basis of a difference ----------------------------------------------------------

function CitedItem({ c }) {
  const s = c.sources[0] || null;
  return (
    <li>
      <span className="cite-ids">{c.id}</span>
      {c.tag ? <span className={`etag t-${c.tag.toLowerCase()}`} title={TAG_TITLES[c.tag]}>{TAG_WORDS[c.tag]}</span> : null}
      {c.as_of ? <span className="faint">{`as of ${fmtDate(c.as_of)}`}</span> : null}
      {c.text ? <span className="cmx-ctext">{c.text}</span> : null}
      {s ? (
        <span className="cmx-csrc">
          {s.url ? <ExtLink href={s.url} title={[s.publisher, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean).join(' · ') || null}>{s.title || s.url}</ExtLink> : <span>{s.title || s.source_id}</span>}
          {c.sources.length > 1 ? <span className="faint">{` +${c.sources.length - 1}`}</span> : null}
        </span>
      ) : <span className="etag none">No source</span>}
    </li>
  );
}

function SideWords({ b }) {
  if (!b) return null;
  if (!b.graded) {
    return (
      <div className="cmx-words">
        <h4>{b.who}</h4>
        <p className="cmx-none">{`${b.who}'s report gives no grade for this category.`}</p>
      </div>
    );
  }
  const line = (k, v) => (v ? [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`}>{v}</dd>] : []);
  return (
    <div className="cmx-words">
      <h4>{b.who}<span className="cmx-wv">{`${b.value}${b.confidence ? ` · ${CONFIDENCE[b.confidence]}` : ''}`}</span></h4>
      <dl>
        {line(b.kind === 'unknown' ? 'Why unknown' : b.kind === 'na' ? 'Why not applicable' : 'Reason', b.reason || b.unknown_reason || <span className="cmx-none">No reason given</span>)}
        {line('Strongest evidence', b.strongest_evidence)}
        <dt>Cites</dt>
        <dd>
          {b.cited.length ? <ul className="cmx-cited">{b.cited.map((c, i) => <CitedItem key={`${c.id}-${i}`} c={c} />)}</ul> : <span className="cmx-none">No evidence cited</span>}
          {b.dangling.length ? <span className="cite-dangling">{` ${b.dangling.join(', ')} not listed in the report`}</span> : null}
        </dd>
        {line('Main weakness', b.main_weakness)}
        {line('Would raise it', b.would_raise)}
        {line('Would lower it', b.would_lower)}
      </dl>
      {b.flags.map((f, i) => (
        <p key={`${f.rule || 'flag'}-${i}`} className={`evline${f.severity === 'high' ? ' ev-serious' : f.severity === 'low' ? ' evx-low' : ''}`}>
          <TriangleAlert size={13} aria-hidden="true" />
          <span><strong>{`Desk evidence check (${f.severity === 'high' ? 'serious' : f.severity === 'medium' ? 'material' : 'note'}): `}</strong>{f.message}</span>
        </p>
      ))}
    </div>
  );
}

function FigureLine({ c, names }) {
  const v = (x) => `${fmtNum(x.value)}${x.unit ? ` ${x.unit}` : ''}${x.period ? `, ${x.period}` : ''}${x.as_of ? `, as of ${fmtDate(x.as_of)}` : ''}`;
  return (
    <li>
      <strong>{String(c.metric || '').replace(/_/g, ' ')}</strong>
      {`: ${names[0]} ${v(c.a)}; ${names[1]} ${v(c.b)}. `}
      <span className="cmx-fig-k">{`${FIGURE_WORDS[c.kind] || String(c.kind || '').replace(/_/g, ' ')}${c.kind === 'context_unstated' && c.missing ? ` (${c.missing})` : ''}.`}</span>
    </li>
  );
}

function BasisBlock({ basis, names }) {
  const n = basis.unexplained.length;
  return (
    <div className="cmx-basis">
      {n ? (
        <p className="cmx-unexplained">
          <CircleHelp size={15} aria-hidden="true" />
          <span>{`The stored records cannot explain this difference: ${basis.unexplained.join(' and ')} ${n === 1 ? 'gives' : 'give'} no reason and ${n === 1 ? 'cites' : 'cite'} no evidence for ${n === 1 ? 'its' : 'their'} grade.`}</span>
        </p>
      ) : null}
      <div className="cmx-words-pair">{basis.sides.map((s, i) => <SideWords key={i} b={s} />)}</div>
      {basis.shared.length ? (
        <p className="cmx-shared">
          <strong>Cited by both: </strong>
          {basis.shared.map((s, i) => <span key={`${s.url}-${i}`}>{i ? ', ' : ''}<ExtLink href={s.url}>{s.title}</ExtLink></span>)}
          . A shared source is not independent confirmation.
        </p>
      ) : null}
      {basis.conflicts.length ? (
        <div className="cmx-figs">
          <p className="cmx-figs-h">Figures the two cite</p>
          <ul>{basis.conflicts.map((c, i) => <FigureLine key={`${c.metric}-${i}`} c={c} names={names} />)}</ul>
        </div>
      ) : null}
    </div>
  );
}

// ---- one category ---------------------------------------------------------------------------

function ModelLine({ who, s }) {
  const scored = s && (s.status === 'scored' || s.status === 'range');
  return (
    <div className="cmx-line">
      <span className="cmx-model">{who}</span>
      <span className="cmx-bar" aria-hidden="true"><Bar s={s} /></span>
      <span className={`cmx-val${scored ? '' : ' is-none'}`}>{s ? valueText(s) : 'Not graded'}</span>
      <span className="cmx-conf" title={s && s.confidence ? CONFIDENCE[s.confidence] : undefined}>{s && s.confidence ? s.confidence.charAt(0).toUpperCase() : ''}</span>
    </div>
  );
}

function CategoryRow({ v, row, d, st, bump }) {
  const [na, nb] = v.names;
  const said = `${row.label}: ${na} ${row.a ? valueText(row.a) : 'not graded'}${row.a && row.a.confidence ? ` (${CONFIDENCE[row.a.confidence]})` : ''}${nb ? `; ${nb} ${row.b ? valueText(row.b) : 'not graded'}${row.b && row.b.confidence ? ` (${CONFIDENCE[row.b.confidence]})` : ''}. ${row.result ? row.result.label : ''}` : ''}`;
  const basis = v.second ? basisOf(row, v.first, v.second, v.names, d) : null;
  const words = v.second ? 'Basis of the difference' : 'The report\'s words';
  const k = `cmp-basis-${row.category_id}`;
  return (
    <li className={`cmx-row g-${row.result ? row.result.group : 'one'}`} aria-label={said}>
      <div className="cmx-name">
        <span>{row.label}</span>
        {row.other_label ? <span className="cmx-alt">{`${nb}: ${row.other_label}`}</span> : null}
        {row.result ? <span className={`cmx-label k-${row.result.kind}`} title={row.result.detail}>{row.result.label}</span> : null}
      </div>
      <div className="cmx-pair">
        <ModelLine who={na} s={row.a} />
        {nb ? <ModelLine who={nb} s={row.b} /> : null}
      </div>
      <Keep st={st} k={k} bump={bump} className="cmx-more">
        <summary aria-label={`${words}: ${row.label}`} data-key={`${k}-summary`}>
          {words}
          {basis && basis.unexplained.length ? <span className="cmx-q" title="The stored records cannot explain it"> · not explained by the records</span> : null}
        </summary>
        {v.second ? <BasisBlock basis={basis} names={v.names} /> : (
          <div className="cmx-basis">
            <div className="cmx-words-pair is-one">
              {basisOf({ a: row.a, b: null }, v.first, null, [na, null], d).sides.filter(Boolean).map((s, i) => <SideWords key={i} b={s} />)}
            </div>
          </div>
        )}
      </Keep>
    </li>
  );
}

const GROUPS = [
  ['notable', 'Where they differ', `comparable differences of ${NOTABLE_GAP} points or more, largest first`],
  ['missing', 'Evidence missing', 'one or both could not grade it'],
  ['close', 'Close or the same', 'a smaller difference, or none; matching numbers do not mean the facts agree'],
  ['other', 'Not compared', 'not applicable, or not scored on the same scale'],
];

function Categories({ v, d, st, bump, setOrder }) {
  const order = st.order;
  const seg = v.second ? (
    <Segments value={order} options={[['inspection', 'Differences first'], ['profile', 'Profile order']]} onChange={setOrder} label="Order of the categories" dataKey="cmp-order" />
  ) : null;
  const sub = v.second ? `${v.rows.length} categories · diagnostics, never averaged into either grade` : `${v.rows.length} categories`;
  let body;
  if (!v.rows.length) body = <p className="cmx-none">No category grades in this report.</p>;
  else if (!v.second || order === 'profile') {
    const rows = [...v.rows].sort((x, y) => x.position - y.position);
    body = <ol className="cmx-rows">{rows.map((r) => <CategoryRow key={r.category_id} v={v} row={r} d={d} st={st} bump={bump} />)}</ol>;
  } else {
    body = GROUPS.map(([g, title, gsub]) => {
      const rows = v.rows.filter((r) => r.result && r.result.group === g);
      if (!rows.length) return null;
      return (
        <div key={g} className={`cmx-group g-${g}`}>
          <h3 className="cmx-h3">{`${title} (${rows.length})`}<span className="cmx-h3-sub">{gsub}</span></h3>
          <ol className="cmx-rows">{rows.map((r) => <CategoryRow key={r.category_id} v={v} row={r} d={d} st={st} bump={bump} />)}</ol>
        </div>
      );
    });
  }
  return <Card hid="cmp-h-cats" title="Category grades" sub={sub} actions={seg} className="cmx-cats">{body}</Card>;
}

// ---- the grade inputs and downside risk -------------------------------------------------------

function RubricCard({ v, rows, id, title, sub, risk = false, weights = null }) {
  const [na, nb] = v.names;
  return (
    <Card hid={`cmp-h-${id}`} title={title} sub={sub} className={`cmx-rubric${risk ? ' is-risk' : ''}`}>
      {rows.length ? (
        <div className="l2-table-wrap">
          <table className="l2-table cmx-table">
            <thead>
              <tr>
                <th scope="col">{risk ? 'Risk' : 'Component'}</th>
                <th scope="col" className="num">{na}</th>
                <th scope="col" className="num">{nb}</th>
                <th scope="col">Comparison</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.result.group === 'notable' ? 'is-notable' : undefined}>
                  <th scope="row">{r.label}{weights && weights[r.id] !== undefined ? <span className="faint">{` ${weights[r.id]}%`}</span> : null}</th>
                  <td className="num" title={r.a ? r.a.rationale || r.a.unknown_reason || undefined : undefined}>{r.a ? valueText(r.a) : '—'}</td>
                  <td className="num" title={r.b ? r.b.rationale || r.b.unknown_reason || undefined : undefined}>{r.b ? valueText(r.b) : '—'}</td>
                  <td className="cmx-res" title={r.result.detail}>{r.result.label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="cmx-none">The rubric is not on this desk.</p>}
    </Card>
  );
}

// ---- the view -------------------------------------------------------------------------------------

export default function Compare({ d, row, pid, route }) {
  const desk = useDesk();
  const idx = desk.index || {};
  const rub = idx.rubrics || {};
  const [, setTick] = useState(0);
  const bump = () => setTick((t) => t + 1);
  const query = route && route.query ? route.query : new URLSearchParams();
  const st = stateFor(pid, query);
  const { records, set_aside } = useMemo(() => deskRecords(d, { profiles: rub.profiles || [], grading: rub.grading || null }), [d, rub.profiles, rub.grading]);
  const choices = useMemo(() => deskChoices(records), [records]);
  // A side not chosen is the desk's own latest eligible report of its model.
  const pick = (val, model) => (val === 'none' ? null : val ? records.find((r) => r.report_id === val) || null : latestRecord(d, records, model));
  const a = pick(st.a, 'claude');
  const b = pick(st.b, 'chatgpt');
  const v = compareView(d, { a, b, records, set_aside, row, index: idx, hosted: hosted(), picked: st.picked });
  // The first comparable difference opens with its basis, the first time, on
  // a wide screen (on a phone the list comes first).
  if (st.fresh) {
    st.fresh = false;
    st.open = new Set();
    if (v.second && !v.same && st.order !== 'profile' && wide()) {
      const first = list(v.rows).find((r) => r.result && r.result.group === 'notable');
      if (first) st.open.add(`cmp-basis-${first.category_id}`);
    }
  }
  const weights = Object.fromEntries(list(rub.grading && rub.grading.investment_components).map((x) => [x.id, x.weight_bp / 100]));
  const choose = (key) => (val) => {
    st[key] = val;
    st.picked = true;
    st.fresh = true;
    st.open = new Set();
    inPlace(st, { a: st.a, b: st.b }, `cmp-${key}`);
    bump();
    const x = pick(st.a, 'claude');
    const y = pick(st.b, 'chatgpt');
    announce(x && y && x !== y ? `Comparing ${compareView(d, { a: x, b: y, records }).names.join(' and ')}` : 'One report shown');
  };
  const setOrder = (val) => {
    st.order = val;
    inPlace(st, { order: val === 'profile' ? 'profile' : null }, `cmp-order-${val}`);
    bump();
  };
  // Each side: the report, or why there is none (only the opening pair names
  // the missing model; after a choice, a side asks for a report).
  const names = v.names || [];
  const sideFor = (rec, model, name) => {
    if (rec) return <SideCard r={rec} who={name || MODEL_LABELS[rec.model]} all={records} d={d} />;
    if (!st.picked) return <EmptyCard miss={missingSide(d, { row, index: idx, model, hosted: hosted() })} />;
    return <EmptyCard miss={{ who: 'No report chosen', text: 'Choose a report to compare.' }} />;
  };
  const aside = set_aside.filter((x) => MODELS.includes(x.model));
  const why = (x) => (x.why.kind === 'quarantined' ? 'quarantined: it does not match its research run' : x.why.kind === 'pdf' ? 'a PDF without a text copy' : x.why.kind === 'broken' ? 'could not be read' : `excluded${x.why.reason ? `: ${x.why.reason}` : ''}`);
  const shown = !v.empty && !v.same;
  return (
    <article className="cmx l2-stack" id="brief-sheet" aria-labelledby="bf-title">
      <section className="l2-panel cmx-top">
        <div className="l2-panel-body">
          <header className="sheet-head">
            <h2 id="bf-title" className="sheet-title" tabIndex={-1}>Compare the models<span className="sr-only">{`: ${(d.project && d.project.name) || pid}`}</span></h2>
            <p className="sheet-sub">Saved reports · each grade its own</p>
          </header>
          <div className="cmx-pickers">
            <Picker label="First report" dataKey="cmp-a" choices={choices} selected={a} d={d} onPick={choose('a')} />
            <Picker label="Second report" dataKey="cmp-b" choices={choices} selected={b} d={d} onPick={choose('b')} />
          </div>
          <div className="cmx-sides">
            {sideFor(a, 'claude', a && b ? names[0] : null)}
            {sideFor(b, 'chatgpt', a && b ? names[1] : null)}
          </div>
          {v.empty ? <p className="cmx-none">{records.length ? 'Choose a report to read.' : 'No saved report on this project can be compared yet.'}</p> : null}
          {v.same ? <p className="cmx-none">The same report is chosen twice. Choose a second, different report.</p> : null}
        </div>
      </section>
      {shown && v.cmp ? (
        <Card label="Whether the two reports can be compared" className="cmx-state">
          <StatusBlock v={v} />
          <ScopeFacts v={v} st={st} bump={bump} />
        </Card>
      ) : null}
      {shown ? <Categories v={v} d={d} st={st} bump={bump} setOrder={setOrder} /> : null}
      {shown && v.cmp ? (
        <>
          <RubricCard v={v} rows={v.components} id="inputs" title="What each grade is calculated from" sub="six weighted components · each report's own grade, never combined" weights={weights} />
          <RubricCard v={v} rows={v.risks} id="risks" title="Downside risk" sub="higher is worse · never folded into a grade" risk />
          {!v.figures_checked ? <p className="l2-note cmx-note">Figures are checked against each other for each model's latest report only.</p> : null}
        </>
      ) : null}
      {aside.length ? (
        <Card hid="cmp-h-aside" title="Not compared" sub={`${aside.length} saved report${aside.length === 1 ? '' : 's'}`} className="cmx-aside">
          <ul className="l2-list">
            {aside.map((x) => (
              <li key={x.report_id}>
                <strong>{`${PROVIDER_LABELS[x.model]}, saved ${fmtDate(x.saved_at)}: `}</strong>
                {`${why(x)}. `}
                <ViewLink pid={pid} href={`#/project/${enc(pid)}/report?report=${enc(x.report_id)}`} dataKey={`cmp-aside-${x.report_id}`}>The report</ViewLink>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </article>
  );
}
