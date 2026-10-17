// The Evidence view (#/project/<id>/evidence?model=<model>[&report=<report>]):
// one model's saved report read for what stands behind it, the same report
// the Overview reads (briefModel, `m`): the conclusion it bears on with every
// notice, the desk's evidence checks, every claim with the researcher's own
// tag, its date, the desk's worst flag and its sources (filtered and paged),
// every source, the limits the report states, and the records the view is
// drawn from. Folded under it, your own checks of the claims, your dispute
// questions and every model's open questions. Drawing it fetches nothing and
// writes nothing; the only writes are your claim checks and dispute questions,
// each from its own button. Ported from views/brief.js evidencePanel and
// views/project.js evidenceTab, modelStatus and claimsBody; the model switcher
// is the project page's, and the research runs, technical records and token
// identity live on the Record and Contract tabs.
import { useMemo, useState } from 'react';
import { FileText, TriangleAlert, X } from 'lucide-react';
import {
  PROVIDERS, PROVIDER_LABELS, TAG_TITLES, fmtDate, fmtDateTime, fmtNum, badgeInfo, onHoldOf, researchState, toast,
} from '../../../../public/ui.js';
import { TAG_WORDS, checksWord, flaggedText } from '../../../../public/brief-model.js';
import { api, refresh, hosted } from '../../lib/desk.js';
import { useDesk } from '../../lib/hooks.js';
import { navigate } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { loadLegacy } from '../../components/Dom.jsx';
import { SheetHead, Notices, GradeFlags, ViewLink } from './Overview.jsx';
import { Panel, Fold, KV, None, usePager, Pager, ExtLink, enc, plural } from './kit.jsx';
import '../../styles/evidence.css';

const TAG_ORDER = ['V', 'C', 'I', 'S'];
const SEV_RANK = { high: 3, medium: 2, low: 1 };
const SEV_WORD = { high: 'serious', medium: 'material', low: 'note' };
const SEV_BADGE = { high: 'badge is-bad', medium: 'badge is-warn', low: 'badge' };
const list = (v) => (Array.isArray(v) ? v : []);
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const PAGE = 25;

// The note on your own checks, as the legacy Evidence tab gave it (its
// title's tooltip, never copy on the page).
const EVIDENCE_NOTE = 'Separate things: the analyst tag ([V] means the analyst says it checked a primary source in its own session), the desk\'s evidence checks (a [V] resting only on an AI summary or a secondary source, a critical claim without a primary source or date, a fee figure nobody could reproduce), your check (what you confirmed by opening the source), and independent corroboration (a different, independent source agrees). Citation integrity only means the references resolve. Model agreement is not corroboration. None of these changes a score.';

// The desk's worst flag on each claim: high first, then medium, then low;
// among equals the first given. (The legacy list kept a low flag over a later
// medium one, and the claims table kept whichever came first.)
function worstByClaim(flags) {
  const out = new Map();
  for (const f of list(flags)) {
    if (!f || !f.claim_id) continue;
    const cur = out.get(f.claim_id);
    if (!cur || (SEV_RANK[f.severity] || 0) > (SEV_RANK[cur.severity] || 0)) out.set(f.claim_id, f);
  }
  return out;
}

// A link that changes which report this view reads, without a new entry.
function InView({ href, children, dataKey, className }) {
  return (
    <a href={href} className={className} data-key={dataKey} onClick={(e) => { if (!plain(e)) return; e.preventDefault(); navigate(href, { replace: true, state: history.state }); }}>
      {children}
    </a>
  );
}

// ---- the chosen model's status ---------------------------------------------------------

// The latest report's age, staleness and route; a job waiting for you says
// so, with the way to its run on the Record tab (which holds the research
// actions).
function ModelStatus({ d, row, pid, prov, index }) {
  const staleDays = (index && index.settings && index.settings.freshness && index.settings.freshness.research_stale_days) || 90;
  const meta = d.comparison && d.comparison.latest ? d.comparison.latest[prov] : null;
  const r = meta ? list(d.reports).find((x) => x && x.report_id === meta.report_id) || null : null;
  const sum = row && row.providers ? row.providers[prov] : null;
  const job = row && row.research && row.research.providers ? row.research.providers[prov] : null;
  const onHold = Boolean(onHoldOf(index, prov));
  const info = badgeInfo(prov, sum, job, { staleDays, hosted: hosted(), onHold });
  const waiting = Boolean(job && job.state === 'unconfigured' && !onHold);
  if (!r && !waiting) return null;
  const a = r && r.assessment ? r.assessment : null;
  const pv = (r && r.provenance) || {};
  const route = r ? `${a ? a.model_version || 'model not stated' : r.model_version || 'model not stated'} · ${pv.attested ? 'attested by the API' : 'self-reported'}${pv.channel ? ` · via ${pv.channel}` : ''}` : null;
  return (
    <div className="evx-status">
      {r ? (
        <p className="evx-status-t">
          {info.age ? `Analysis ${info.age} · ` : ''}
          {info.stale ? <span className="v-stale">stale · </span> : null}
          {route}
        </p>
      ) : null}
      {waiting ? (
        <p className="evx-status-t" title={researchState('waiting', { provider: prov, hosted: hosted() }).long}>
          <span className="badge is-warn">Waiting for you</span>
          <a href={`#/project/${enc(pid)}/record?open=runs`} data-key={`pb-${prov}-runs`}>Research runs</a>
        </p>
      ) : null}
    </div>
  );
}

// ---- no report to read -------------------------------------------------------------------

// Why there is no evidence to read (brief-model.js emptyOf), as the
// Overview's empty brief says it; its research runs are on the Record tab and
// a PDF's text is imported on the Review page.
function EmptyEvidence({ m, d, row, pid, who }) {
  const e = m.empty;
  let title = `No ${who} report yet`;
  const lines = [];
  if (e.kind === 'not_found') title = 'This report is not on this project';
  else if (e.kind === 'other_provider') title = `This is ${e.other}'s report`;
  else if (e.kind === 'broken') title = 'This report could not be read';
  else if (e.kind === 'ineligible' && e.why) title = e.why.kind === 'quarantined' ? `${who}'s answer was quarantined` : e.why.kind === 'pdf' ? 'A PDF without a text copy' : 'This report is excluded';
  const quarantineLines = (reason) => [
    <p key="q">It does not match the research run it was saved for, so it is kept but not graded, and no brief is drawn from it.</p>,
    reason ? <details key="qw" className="fold" data-key="brief-q-why"><summary>Why</summary><p className="fold-body">{reason}</p></details> : null,
  ];
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'quarantined') lines.push(...quarantineLines(e.why.reason));
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'excluded') lines.push(<p key="x">{`It is excluded from comparison${e.why.reason ? `: ${e.why.reason}` : ''}, so no brief is drawn from it.`}</p>);
  if (e.kind === 'ineligible' && e.why && e.why.kind === 'pdf') lines.push(<p key="p">No scores were read from it, so no brief is drawn from it until a text copy is imported.</p>);
  if (e.kind === 'broken' && e.why) lines.push(<p key="b">{e.why.reason}</p>);
  if (e.kind === 'other_provider') lines.push(<p key="o">{`The ${who} Brief reads ${who}'s reports only.`}</p>);
  if (e.kind === 'none') {
    if (e.quarantined) {
      title = `${who}'s answer was quarantined`;
      lines.push(...quarantineLines(e.quarantined.reason));
    } else if (e.job) {
      lines.push(<p key="j" className={`state-word tone-${e.job.tone || 'none'}`}>{e.job.long}</p>);
      if (e.job.error && e.job.key === 'failed') lines.push(<p key="je" className="v-error">{e.job.error}</p>);
    } else if (e.hold) lines.push(<p key="h">{`${who} is on hold on this desk${e.hold.since ? ` since ${fmtDate(e.hold.since)}` : ''}: nothing new is assigned to it.`}</p>);
    else if (e.archived) lines.push(<p key="a">The project is archived: its records are kept, and no research is offered here.</p>);
    if (e.pdf) lines.push(<p key="pdf">{`A PDF report from ${fmtDate(e.pdf.saved_at)} is saved and needs a text copy before it can be read. `}<a href={`#/review?seg=imports&project=${enc(pid)}&provider=${m.provider}`} data-key="brief-pdf-import">Import the text</a></p>);
    if (e.excluded) lines.push(<p key="ex">{`A report is excluded from comparison${e.excluded.reason ? `: ${e.excluded.reason}` : ''}.`}</p>);
  }
  const runHref = `#/project/${enc(pid)}/record?model=${m.provider}&open=runs`;
  const latestHref = `#/project/${enc(pid)}/brief?model=${m.provider}`;
  return (
    <section className="ov-sec ov-empty" aria-labelledby="bf-h-empty">
      <div className="ov-empty-mark" aria-hidden="true"><FileText size={22} /></div>
      <h2 className="ov-empty-t" id="bf-h-empty">{title}</h2>
      {lines}
      <p className="ov-links">
        {e.kind === 'none' && e.can_run ? (
          <button type="button" className="btn btn-primary btn-sm" data-key="brief-run" onClick={async () => { const L = await loadLegacy(); const p = row && row.project_id ? { ...row } : { ...d.project, research: null }; L.openResearchDialog(legacyCtx, { ...p, report_count: list(d.reports).length }, { providers: [m.provider] }); }}>{`Run ${who} research…`}</button>
        ) : null}
        {e.latest_id && e.kind !== 'none' ? <InView className="btn btn-sm" href={latestHref} dataKey="brief-latest-empty">{`${who}'s latest brief`}</InView> : null}
        {e.report_id && ['ineligible', 'other_provider'].includes(e.kind) ? <a className="btn btn-sm" href={`#/project/${enc(pid)}/report?report=${enc(e.report_id)}`} data-key="brief-empty-report">Open the report</a> : e.pdf ? <a className="btn btn-sm" href={`#/project/${enc(pid)}/report?report=${enc(e.pdf.report_id)}`} data-key="brief-pdf-report">Open the PDF report</a> : null}
        {e.job || e.quarantined || (e.why && e.why.kind === 'quarantined') ? <a className="btn btn-sm" href={runHref} data-key="brief-empty-runs">Research runs</a> : null}
      </p>
    </section>
  );
}

// ---- the conclusion and the checks ---------------------------------------------------------

function conclusionWords(m) {
  const g = m.grade;
  if (g.status === 'firm' || g.status === 'range') return `Grade ${g.display}${g.word ? ` · ${g.word}` : ''}`;
  if (g.status === 'withheld') return `Grade withheld${typeof g.coverage === 'number' ? ` · ${g.coverage}% of the weight scored` : ''}`;
  return 'No grade';
}

// The desk's evidence checks on the report's claims and category grades
// (core/evidence.js): flags with their reason; never a score change. (Ported
// from views/project.js evidenceChecksBlock.)
function ChecksBlock({ ev }) {
  const flags = list(ev.flags);
  const cov = ev.coverage && typeof ev.coverage === 'object' ? ev.coverage.status : ev.coverage;
  const head = flags.length ? `${flaggedText(ev)} flagged` : cov === 'none' ? 'Evidence checks: coverage insufficient' : 'No inconsistencies detected by these checks';
  const tone = ev.high ? 'bad' : flags.length || cov === 'none' ? 'warn' : 'none';
  const outside = ev.source_types ? list(ev.source_types.outside_list) : [];
  return (
    <div className="evx-checks">
      <p className="evx-checks-t"><span className={`evx-state is-${tone}`}>{head}</span>{ev.summary ? <span className="muted">{` ${ev.summary}`}</span> : null}</p>
      {flags.length ? (
        <ul className="evx-flags" aria-label="The desk's evidence flags">
          {flags.map((x, i) => <li key={`${x.rule || 'flag'}-${i}`}><span className={SEV_BADGE[x.severity] || 'badge'}>{x.severity}</span><span>{x.message}</span></li>)}
        </ul>
      ) : null}
      <p className="l2-note">{ev.tag_note || 'A claim tagged [V] is the researcher\'s own classification of its source; the desk does not verify it independently.'}</p>
      {outside.length ? <p className="muted evx-small">{`Source types written outside the accepted list, read as: ${outside.map((x) => `${x.given} as ${x.read_as}`).join(', ')}.`}</p> : null}
    </div>
  );
}

// How the report's claims are supported, by its own tags: researcher-verified
// [V], project-claimed [C], inference [I], speculative [S]; counts in words,
// the bar only repeats them. (Ported from views/inspector.js evidenceQuality.)
const TAG_BAR = [['V', 't-v', 'researcher-verified'], ['C', 't-c', 'claimed'], ['I', 't-i', 'inference'], ['S', 't-s', 'speculative']];
function TagSpread({ claims }) {
  const all = list(claims);
  if (!all.length) return <p className="faint evx-small">No structured claims in this report.</p>;
  const n = Object.fromEntries(TAG_BAR.map(([t]) => [t, all.filter((c) => c.evidence_tag === t).length]));
  const other = all.length - TAG_BAR.reduce((s, [t]) => s + n[t], 0);
  return (
    <div className="evx-spread">
      <div className="evx-tagbar" aria-hidden="true">{TAG_BAR.filter(([t]) => n[t]).map(([t, cls]) => <span key={t} className={cls} style={{ width: `${(n[t] / all.length) * 100}%` }} />)}</div>
      <p className="evx-legend">
        {TAG_BAR.map(([t, cls, word]) => <span key={t}><i className={cls} aria-hidden="true" /><strong>{String(n[t])}</strong>{` ${word} [${t}]`}</span>)}
        {other ? <span><strong>{String(other)}</strong> untagged</span> : null}
        <span className="faint">{`of ${all.length} claims`}</span>
      </p>
    </div>
  );
}

// ---- the claims, filtered and paged -------------------------------------------------------------

// Filters per project and report, for the page's life: a live redraw keeps them.
const CLAIM_FILTERS = new Map();
const SOURCE_FILTERS = new Map();
const NO_FILTER = { tag: 'all', flag: 'any', source: 'all', q: '' };
const TAG_OPTIONS = [['all', 'All'], ...TAG_ORDER.map((t) => [t, `${TAG_WORDS[t]} [${t}]`]), ['untagged', 'Untagged']];
const FLAG_OPTIONS = [['any', 'Any'], ['flagged', 'Flagged'], ['serious', 'Serious'], ['none', 'Not flagged']];
const cut = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function SourceRef({ id, s }) {
  if (!s) return <span className="cite-dangling">{`${id} not in the source list`}</span>;
  if (s.url) return <ExtLink href={s.url} title={[s.publisher, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean).join(' · ') || null}>{s.title || s.url}</ExtLink>;
  return <span>{s.title || id}</span>;
}

function ClaimItem({ c, f, sources }) {
  const tag = TAG_ORDER.includes(c.evidence_tag) ? c.evidence_tag : null;
  const ids = list(c.source_ids);
  return (
    <li className={`evx-claim${f ? ` flag-${f.severity}` : ''}`}>
      <p className="evx-claim-m">
        <span className="cite-ids">{c.claim_id}</span>
        {tag ? <span className={`etag t-${tag.toLowerCase()}`} title={TAG_TITLES[tag]}>{TAG_WORDS[tag]}</span> : <span className="etag none">Untagged</span>}
        <span className="faint">{c.as_of ? `as of ${fmtDate(c.as_of)}` : 'date not stated'}</span>
      </p>
      <p className="evx-claim-t">{c.text || <span className="faint">No text</span>}</p>
      {f ? (
        <p className={`evline${f.severity === 'high' ? ' ev-serious' : f.severity === 'low' ? ' evx-low' : ''}`}>
          <TriangleAlert size={13} aria-hidden="true" />
          <span><strong>{`Desk check (${SEV_WORD[f.severity] || 'note'}). `}</strong>{f.message}</span>
        </p>
      ) : null}
      <p className="cite">
        {ids.length ? ids.map((id, i) => (
          <span key={`${id}-${i}`} className="evx-src">
            {i ? <span className="faint" aria-hidden="true">·</span> : null}
            <SourceRef id={id} s={sources.get(id)} />
          </span>
        )) : <span className="etag none">No source cited</span>}
      </p>
    </li>
  );
}

function ClaimsPanel({ m, pid, who }) {
  const e = m.evidence;
  const key = `${pid}#${m.report_id}`;
  const [f, setFState] = useState(() => CLAIM_FILTERS.get(key) || NO_FILTER);
  const setF = (patch) => {
    const next = { ...f, ...patch };
    CLAIM_FILTERS.set(key, next);
    setFState(next);
  };
  const sources = useMemo(() => new Map(list(e.sources).map((s) => [s.source_id, s])), [e.sources]);
  const worst = useMemo(() => worstByClaim(e.flags), [e.flags]);
  const q = f.q.trim().toLowerCase();
  const shown = useMemo(() => list(e.claims).filter((c) => {
    if (f.tag === 'untagged' ? TAG_ORDER.includes(c.evidence_tag) : f.tag !== 'all' && c.evidence_tag !== f.tag) return false;
    const w = worst.get(c.claim_id);
    if (f.flag === 'flagged' && !w) return false;
    if (f.flag === 'serious' && !(w && w.severity === 'high')) return false;
    if (f.flag === 'none' && w) return false;
    const ids = list(c.source_ids);
    if (f.source === 'none' && ids.length) return false;
    if (f.source.startsWith('src:') && !ids.includes(f.source.slice(4))) return false;
    if (q && !`${c.claim_id || ''} ${c.text || ''}`.toLowerCase().includes(q)) return false;
    return true;
  }), [e.claims, f.tag, f.flag, f.source, q, worst]);
  const pg = usePager(shown, PAGE, `${f.tag}|${f.flag}|${f.source}|${q}`);
  const tagWord = (v) => (TAG_OPTIONS.find(([x]) => x === v) || [v, v])[1];
  const sourceWord = (v) => {
    if (v === 'none') return 'No source cited';
    const id = v.slice(4);
    const s = sources.get(id);
    return s && (s.title || s.publisher) ? `${id} · ${cut(s.title || s.publisher, 40)}` : id;
  };
  const chips = [
    f.tag !== 'all' ? { k: 'Tag', v: tagWord(f.tag), key: 'tag', clear: { tag: 'all' } } : null,
    f.flag !== 'any' ? { k: 'Desk flag', v: (FLAG_OPTIONS.find(([x]) => x === f.flag) || [f.flag, f.flag])[1], key: 'flag', clear: { flag: 'any' } } : null,
    f.source !== 'all' ? { k: 'Source', v: sourceWord(f.source), key: 'source', clear: { source: 'all' } } : null,
    q ? { k: 'Search', v: `“${f.q.trim()}”`, key: 'q', clear: { q: '' } } : null,
  ].filter(Boolean);
  const total = list(e.claims).length;
  return (
    <Panel
      id="ev-claims"
      title={`Claims (${e.total})`}
      sub={<span title={TAG_TITLES.V}>{`${who}'s own evidence tags; the desk does not verify them`}</span>}
    >
      <TagSpread claims={e.claims} />
      {total ? (
        <>
          <div className="l2-filters" role="group" aria-label="Filter the claims">
            <label>
              Tag
              <select className="input" value={f.tag} data-key="ev-f-tag" onChange={(ev) => setF({ tag: ev.target.value })}>
                {TAG_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            <label>
              Desk flag
              <select className="input" value={f.flag} data-key="ev-f-flag" onChange={(ev) => setF({ flag: ev.target.value })}>
                {FLAG_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
              </select>
            </label>
            <label>
              Source
              <select className="input evx-src-select" value={f.source} data-key="ev-f-source" onChange={(ev) => setF({ source: ev.target.value })}>
                <option value="all">All</option>
                {list(e.sources).filter((s) => s && s.source_id).map((s) => <option key={s.source_id} value={`src:${s.source_id}`}>{`${s.source_id}${s.title || s.publisher ? ` · ${cut(s.title || s.publisher)}` : ''}`}</option>)}
                <option value="none">No source cited</option>
              </select>
            </label>
            <label>
              Search
              <input type="search" className="input" value={f.q} placeholder="Claim text or ID" data-key="ev-f-q" onChange={(ev) => setF({ q: ev.target.value })} />
            </label>
          </div>
          {chips.length ? (
            <div className="evx-chips" role="group" aria-label="Active filters">
              {chips.map((c) => (
                <span key={c.key} className="token">
                  {`${c.k} | ${c.v}`}
                  <button type="button" aria-label={`Remove filter: ${c.k}: ${c.v}`} data-key={`ev-f-clear-${c.key}`} onClick={() => setF(c.clear)}><X size={12} strokeWidth={2.2} aria-hidden="true" /></button>
                </span>
              ))}
              {chips.length > 1 ? <button type="button" className="btn-link" data-key="ev-f-clear-all" onClick={() => setF(NO_FILTER)}>Clear all</button> : null}
            </div>
          ) : null}
          {chips.length ? <p className="l2-note" role="status">{`${shown.length} of ${plural(total, 'claim')}`}</p> : null}
        </>
      ) : null}
      {!total ? <None>This report lists no structured claims.</None> : !shown.length ? <None>No claim matches these filters.</None> : (
        <ol className="evx-claims" aria-label={`${who}'s claims, with their evidence tags, dates and sources`}>
          {pg.slice.map((c, i) => <ClaimItem key={`${c.claim_id}-${pg.from + i}`} c={c} f={worst.get(c.claim_id)} sources={sources} />)}
        </ol>
      )}
      <Pager pager={pg} label="Pages of claims" dataKey="ev-claims-page" />
    </Panel>
  );
}

// ---- the sources ------------------------------------------------------------------------------

function SourceItem({ s }) {
  const meta = [s.publisher, s.source_type ? String(s.source_type).replace(/_/g, ' ') : null, s.accessed_at ? `accessed ${fmtDate(s.accessed_at)}` : null].filter(Boolean);
  return (
    <li>
      {s.url ? <ExtLink href={s.url}>{s.title || s.url}</ExtLink> : <span>{s.title || s.source_id}<span className="faint"> (no usable link)</span></span>}
      {meta.length ? <span className="faint">{` · ${meta.join(' · ')}`}</span> : null}
    </li>
  );
}

function SourcesPanel({ m, pid }) {
  const all = list(m.evidence.sources);
  const key = `${pid}#${m.report_id}`;
  const [q, setQState] = useState(() => SOURCE_FILTERS.get(key) || '');
  const setQ = (v) => { SOURCE_FILTERS.set(key, v); setQState(v); };
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (needle ? all.filter((s) => [s.title, s.publisher, s.source_type ? String(s.source_type).replace(/_/g, ' ') : null].filter(Boolean).join(' ').toLowerCase().includes(needle)) : all), [all, needle]);
  const pg = usePager(shown, PAGE, needle);
  return (
    <Panel id="ev-sources" title={`Sources (${all.length})`}>
      {all.length ? (
        <div className="l2-filters" role="group" aria-label="Filter the sources">
          <label>
            Search
            <input type="search" className="input" value={q} placeholder="Title, publisher or type" data-key="ev-src-q" onChange={(ev) => setQ(ev.target.value)} />
          </label>
          {needle ? <p className="l2-note" role="status">{`${shown.length} of ${plural(all.length, 'source')}`}</p> : null}
        </div>
      ) : null}
      {!all.length ? <None>This report lists no sources.</None> : !shown.length ? <None>No source matches this search.</None> : (
        <ol className="evx-sources" start={pg.from}>
          {pg.slice.map((s, i) => <SourceItem key={`${s.source_id || 's'}-${pg.from + i}`} s={s} />)}
        </ol>
      )}
      <Pager pager={pg} label="Pages of sources" dataKey="ev-sources-page" />
    </Panel>
  );
}

// ---- provenance and the model's reports ---------------------------------------------------------

function Provenance({ m, pid, who }) {
  const pv = m.provenance;
  const prov = m.provider;
  const short = (s, n = 12) => (s && s.length > n + 2 ? `${s.slice(0, n)}…` : s || '—');
  const cur = m.history.find((x) => x.current) || null;
  const runHref = pv.run_id ? `#/project/${enc(pid)}/record?run=${enc(pv.run_id)}&open=runs` : null;
  const reportHref = (rid) => `#/project/${enc(pid)}/report?report=${enc(rid)}&model=${prov}`;
  const evidenceHref = (rid) => `#/project/${enc(pid)}/evidence?model=${prov}&report=${enc(rid)}`;
  const rows = [
    ['Report', <span className="mono">{pv.report_id}</span>],
    ['Research run', runHref ? <ViewLink pid={pid} href={runHref} className="mono" dataKey="brief-rec-run">{pv.run_id}</ViewLink> : <span className="faint">Not part of a run</span>],
    ['Analysis', pv.analysis_at ? fmtDate(pv.analysis_at) : 'Not stated'],
    ['Saved', fmtDateTime(pv.saved_at)],
    ['Model', `${pv.model || 'not stated'} · ${pv.attested ? 'attested by the API' : /connector/i.test(pv.channel || '') ? 'saved through its connection' : 'self-reported'}`],
    ['Channel', pv.channel || 'Not recorded'],
    ['Prompt · rubric · profile', `${pv.prompt_version || '?'} · ${pv.rubric_version || '?'} · ${pv.sector_profile || '?'}`],
    ['Where it sits', [cur && cur.revision, m.is_latest ? `${who}'s latest` : 'An earlier report'].filter(Boolean).join(' · ')],
    ['Original SHA-256', <span className="mono">{short(pv.sha256, 16)}</span>, pv.sha256 || null],
    ['Drawn', `${pv.format}, from this report each time it is opened`],
  ];
  return (
    <Panel id="ev-records" title="Report provenance">
      <KV rows={rows} label="The records this view is drawn from" />
      <p className="l2-actions">
        <ViewLink pid={pid} href={reportHref(pv.report_id)} className="btn btn-sm" dataKey="brief-open-report">Open the original report</ViewLink>
        {runHref ? <ViewLink pid={pid} href={runHref} className="btn btn-sm" dataKey="brief-open-run">Research run</ViewLink> : null}
      </p>
      {m.history.length >= 2 ? (
        <div className="evx-hist-wrap">
          <h3 className="evx-h3">{`${who}'s reports on this project`}</h3>
          <ul className="evx-hist">
            {m.history.map((x) => (
              <li key={x.report_id} className={x.current ? 'is-current' : undefined} aria-current={x.current ? 'true' : undefined}>
                <span className="evx-hist-d">{x.analysis_at ? fmtDate(x.analysis_at) : 'Undated'}</span>
                <span className="evx-hist-g">{x.grade && x.grade.display ? x.grade.display : x.needs_text ? 'PDF' : x.grade && x.grade.status === 'withheld' ? 'Withheld' : 'No grade'}</span>
                <span className="evx-hist-v">{[x.current ? 'This report' : null, x.verdict, x.revision, x.latest ? 'latest' : null, x.excluded ? `excluded: ${x.excluded}` : null].filter(Boolean).join(' · ')}</span>
                {x.current ? <span className="faint">Shown</span>
                  : x.eligible && !x.needs_text ? <InView href={evidenceHref(x.report_id)} dataKey={`brief-hist-${x.report_id}`}>Its evidence</InView>
                    : <ViewLink pid={pid} href={reportHref(x.report_id)} dataKey={`brief-hist-r-${x.report_id}`}>The report</ViewLink>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

// ---- check the claims yourself --------------------------------------------------------------------

const CHECKS = ['not_checked', 'source_reachable', 'source_matches_claim', 'source_contradicts_claim', 'source_unavailable'];
const CORROBORATION = ['none', 'single_source_only', 'independently_corroborated', 'contradicted'];
const words = (v) => v.replace(/_/g, ' ');

// Your check of one claim and its independent corroboration, saved from its
// own button.
function ClaimReview({ pid, rid, c, rev }) {
  const [check, setCheck] = useState(rev && rev.dashboard_check ? rev.dashboard_check.status : 'not_checked');
  const [corr, setCorr] = useState(rev && rev.corroboration ? rev.corroboration.status : 'none');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${enc(pid)}/claims`, { report_id: rid, claim_id: c.claim_id, dashboard_check: check, corroboration: corr });
      toast('Claim review saved');
      await refresh();
    } catch (err) {
      toast(err.message || String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="evx-review">
      <select className="input" value={check} aria-label={`Your check of claim ${c.claim_id}`} data-key={`claim-check-${c.claim_id}`} onChange={(e) => setCheck(e.target.value)}>
        {CHECKS.map((v) => <option key={v} value={v}>{words(v)}</option>)}
      </select>
      <select className="input" value={corr} aria-label={`Independent corroboration of claim ${c.claim_id}`} data-key={`claim-corr-${c.claim_id}`} onChange={(e) => setCorr(e.target.value)}>
        {CORROBORATION.map((v) => <option key={v} value={v}>{words(v)}</option>)}
      </select>
      <button type="button" className="btn btn-sm" disabled={busy} aria-busy={busy || undefined} data-key={`claim-save-${c.claim_id}`} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
    </div>
  );
}

function ClaimsTable({ d, pid, r }) {
  const a = r.assessment || {};
  const claims = list(a.claims);
  const reviews = d.claim_reviews || {};
  const sources = useMemo(() => new Map(list(a.sources).map((s) => [s.source_id, s])), [a.sources]);
  const worst = useMemo(() => worstByClaim(r.evidence && r.evidence.flags), [r.evidence]);
  const pg = usePager(claims, PAGE, r.report_id);
  if (!claims.length) return <None>This report lists no structured claims.</None>;
  return (
    <>
      <div className="l2-table-wrap">
        <table className="l2-table evx-ctable">
          <thead>
            <tr>
              <th scope="col">Claim</th>
              <th scope="col">Analyst tag</th>
              <th scope="col">Metric</th>
              <th scope="col">Sources</th>
              <th scope="col">Your check · corroboration</th>
            </tr>
          </thead>
          <tbody>
            {pg.slice.map((c, i) => {
              const w = worst.get(c.claim_id);
              const rev = reviews[`${r.report_id}#${c.claim_id}`];
              const tag = TAG_ORDER.includes(c.evidence_tag) ? c.evidence_tag : null;
              const meta = [c.period, c.as_of ? `as of ${c.as_of}` : null].filter(Boolean).join(' · ');
              const ids = list(c.source_ids);
              return (
                <tr key={`${c.claim_id}-${pg.from + i}`}>
                  <td className="evx-ctext">
                    <span className="faint">{`${c.claim_id} `}</span>{c.text}
                    {c.limitation ? <div className="muted evx-small">{`Limitation: ${c.limitation}`}</div> : null}
                    {w ? <div className="evx-small evx-cflag"><span className={SEV_BADGE[w.severity] || 'badge'}>{`Desk check (${SEV_WORD[w.severity] || 'note'})`}</span> <span className="muted">{w.message}</span></div> : null}
                  </td>
                  <td>{tag ? <span className={`etag t-${tag.toLowerCase()}`} title={TAG_TITLES[tag]}>{`[${tag}]`}</span> : <span className="etag none" title="Unknown evidence tag">{c.evidence_tag_raw ? `?${c.evidence_tag_raw}` : '?'}</span>}</td>
                  <td className="evx-small">
                    {c.metric_id ? (
                      <>
                        <code>{c.metric_id}</code>{c.value !== null && c.value !== undefined ? ` ${fmtNum(c.value)} ${c.unit || ''}` : ''}
                        {meta ? <div className="muted">{meta}</div> : null}
                      </>
                    ) : <span className="faint">—</span>}
                  </td>
                  <td className="evx-small">
                    {ids.length ? ids.map((sid, j) => {
                      const s = sources.get(sid);
                      return <div key={`${sid}-${j}`}>{s && s.url ? <ExtLink href={s.url}>{s.title || s.url}</ExtLink> : s ? `${s.title || sid} (no usable link)` : `${sid} (not in the source list)`}</div>;
                    }) : <span className="faint">—</span>}
                  </td>
                  <td>
                    <ClaimReview
                      key={`${c.claim_id}:${rev && rev.dashboard_check ? rev.dashboard_check.status : ''}:${rev && rev.corroboration ? rev.corroboration.status : ''}`}
                      pid={pid}
                      rid={r.report_id}
                      c={c}
                      rev={rev}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pager pager={pg} label="Pages of claims to check" dataKey="ev-review-page" />
    </>
  );
}

function DisputeForm({ pid }) {
  const [topic, setTopic] = useState('');
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.post(`/api/projects/${enc(pid)}/disputes`, { topic: topic || null, question });
      toast('Question added');
      setTopic('');
      setQuestion('');
      await refresh();
    } catch (err) {
      toast(err.message || String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="l2-form" data-key="dispute-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <div className="l2-row">
        <label>
          Topic
          <input type="text" className="input" name="topic" value={topic} placeholder="e.g. category:token_value_capture or metric:revenue_usd" data-key="dispute-topic" onChange={(e) => setTopic(e.target.value)} />
        </label>
        <label>
          Resolving question
          <input type="text" className="input" name="question" value={question} placeholder="The question that would settle it" data-key="dispute-question" onChange={(e) => setQuestion(e.target.value)} />
        </label>
      </div>
      <div className="l2-actions">
        <button type="submit" className="btn btn-sm" disabled={busy} aria-busy={busy || undefined} data-key="dispute-add">{busy ? 'Adding…' : 'Add question'}</button>
      </div>
    </form>
  );
}

// Your own checks of this report's claims, your dispute questions, and every
// open question on the project (each model's latest report's, and yours).
function ClaimsBody({ d, pid, r }) {
  const disputes = list(d.disputes);
  const latest = PROVIDERS.map((p) => {
    const meta = d.comparison && d.comparison.latest ? d.comparison.latest[p] : null;
    const rep = meta ? list(d.reports).find((x) => x && x.report_id === meta.report_id) || null : null;
    return [p, rep && !rep.broken && rep.assessment ? rep : null];
  });
  const unresolved = [
    ...latest.flatMap(([p, rep]) => (rep ? list(rep.assessment.unresolved_questions).map((q) => ({ who: PROVIDER_LABELS[p], q })) : [])),
    ...disputes.filter((x) => x.status === 'open').map((x) => ({ who: 'You', q: x.question })),
  ];
  return (
    <div className="evx-checkyours">
      {r ? (
        <section className="evx-sub" aria-labelledby="ev-cy-h">
          <h3 className="evx-h3" id="ev-cy-h">{`${PROVIDER_LABELS[r.meta.provider] || r.meta.provider} · ${fmtDate(r.assessment.analysis_at)}`}</h3>
          <ClaimsTable d={d} pid={pid} r={r} />
        </section>
      ) : <p className="note">No report to check here yet.</p>}
      <section className="evx-sub" aria-labelledby="ev-dq-h">
        <h3 className="evx-h3" id="ev-dq-h">Your dispute questions</h3>
        {disputes.length ? (
          <div className="l2-table-wrap">
            <table className="l2-table">
              <thead><tr><th scope="col">Topic</th><th scope="col">Question</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {disputes.map((x, i) => (
                  <tr key={x.dispute_id || x.id || `${x.question}-${i}`}>
                    <td>{x.topic ? <code>{x.topic}</code> : <span className="faint">—</span>}</td>
                    <td>{x.question || <span className="faint">—</span>}</td>
                    <td>{x.status || <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <None>None yet.</None>}
        <DisputeForm pid={pid} />
      </section>
      {unresolved.length ? (
        <section className="evx-sub" aria-labelledby="ev-uq-h">
          <h3 className="evx-h3" id="ev-uq-h">Unresolved questions</h3>
          <ul className="l2-list">{unresolved.map((u, i) => <li key={`${u.who}-${i}`}><span className="faint">{`${u.who}: `}</span>{u.q}</li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

// ---- the view ---------------------------------------------------------------------------------------

export default function Evidence({ d, row, pid, prov, m }) {
  const desk = useDesk();
  const index = desk.index;
  const who = m ? m.who : PROVIDER_LABELS[prov];
  const r = m && m.status === 'ok' ? m.report : null;
  const fold = (
    <section className="l2-panel evx-foldpanel">
      <div className="l2-panel-body">
        <Fold dataKey="pb-claims" title={`Check the claims yourself${r ? ` · ${PROVIDER_LABELS[prov]}` : ''}`} note={EVIDENCE_NOTE} lazy>
          <ClaimsBody d={d} pid={pid} r={r} />
        </Fold>
      </div>
    </section>
  );
  if (!m) return null;
  if (m.status !== 'ok') {
    return (
      <div className="evx l2-stack">
        <ModelStatus d={d} row={row} pid={pid} prov={prov} index={index} />
        <article className="l2-panel evx-sheet" id="brief-sheet" aria-labelledby="bf-title">
          <div className="l2-panel-body">
            <SheetHead m={m} title={`${who}'s evidence`} />
            <EmptyEvidence m={m} d={d} row={row} pid={pid} who={who} />
          </div>
        </article>
        {fold}
      </div>
    );
  }
  const e = m.evidence;
  const checksHead = e.flags.length ? `${plural(e.flags.length, 'flag')}${e.checks && e.checks.high ? ` · ${e.checks.high} serious` : ''}` : checksWord(e.checks);
  return (
    <div className="evx l2-stack">
      <ModelStatus d={d} row={row} pid={pid} prov={prov} index={index} />
      <article className="evx-sheet l2-stack" id="brief-sheet" aria-labelledby="bf-title">
        <section className="l2-panel evx-concl" aria-label="The conclusion this evidence bears on">
          <div className="l2-panel-body">
            <SheetHead m={m} title={`${who}'s evidence`} />
            <p className="evx-concl-t">
              <strong>{conclusionWords(m)}</strong>
              {` · ${m.verdict.label || 'No verdict given'}`}
              <span className="faint">{` · analysis ${m.provenance.analysis_at ? fmtDate(m.provenance.analysis_at) : 'date not stated'}`}</span>
            </p>
            <GradeFlags m={m} />
            <Notices list={m.notices} m={m} pid={pid} who={who} label="Before you rely on this report" view="evidence" />
          </div>
        </section>
        <Panel id="ev-checks" title="Desk evidence checks" sub={checksHead}>
          <div className="evx-checks-wrap" data-key="brief-ev-checks" tabIndex={-1}>
            {e.checks ? <ChecksBlock ev={e.checks} /> : <None>The evidence checks have not run on this report.</None>}
          </div>
        </Panel>
        <ClaimsPanel key={`claims-${m.report_id}`} m={m} pid={pid} who={who} />
        <SourcesPanel key={`sources-${m.report_id}`} m={m} pid={pid} />
        <Panel id="ev-limits" title="What the report says it could not establish">
          {e.limits.length ? <ul className="l2-list">{e.limits.map((x, i) => <li key={`${x.label}-${i}`}><strong>{`${x.label}: `}</strong>{x.text}</li>)}</ul> : <None>The report states no limitation.</None>}
          {e.questions.length ? (
            <div>
              <h3 className="evx-h3">{`Open questions (${e.questions.length})`}</h3>
              <ul className="l2-list">{e.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
            </div>
          ) : null}
        </Panel>
        <Provenance m={m} pid={pid} who={who} />
      </article>
      {fold}
    </div>
  );
}
