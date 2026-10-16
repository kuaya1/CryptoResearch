// The project inspector (?p=<id> on the watchlist). From 1280px it docks
// beside the list (non-modal; Escape closes it and returns to the row; J/K
// move the choice); below, it is a drawer over the list, full screen on a
// phone (modal: the rest of the page is inert). Its body scrolls on its own
// and the head and foot keep their place. Another project opens at its top;
// a redraw of the same one keeps its place and its open sections.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { X, Ellipsis, ExternalLink, Copy, Check, FileText, Clock } from 'lucide-react';
import {
  PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, fmtDate, fmtDateTime, fmtAgo, freshnessText, fmtMarketFigure, onHoldOf, toast, announce,
} from '../../../../public/ui.js';
import {
  mkt, marketStrings, noPriceReason, defaultModel, priceClock, fundamentalsTile, defillamaBound, rowProject,
  contractChipModel, contractChecks, shortAddr, needsReview, progressSteps, STEP_NAMES, setupShort,
} from '../../../../public/watchlist-model.js';
import { jobKey, researchState, stateText } from '../../../../public/ui.js';
import { useDesk, useProject } from '../../lib/hooks.js';
import { nav, claimFocus } from '../../lib/router.js';
import { hosted } from '../../lib/desk.js';
import { navigate } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, Spark, Unknown, UnknownFigure } from '../../components/figures.jsx';
import { GradePill, pillInfo } from '../../components/GradePill.jsx';
import { Menu, MenuItem, MenuSep } from '../../components/Menu.jsx';
import { Dom, loadLegacy } from '../../components/Dom.jsx';
import { badgeOpts } from '../watchlist/ProjectTable.jsx';
import { view, closePanel, markReviewed, restoreProject, archiveProject, setWatching } from '../watchlist/state.js';
import { ModelPanel } from './ModelPanel.jsx';
import { MetricRibbon } from '../../components/ui/MetricRibbon.jsx';
import { SecurityAuditStrip } from '../../components/ui/SecurityAuditStrip.jsx';
import { ModelTabMatrix } from '../../components/ui/ModelTabMatrix.jsx';
import { opinionOf, opinionsAgree } from '../../lib/opinion.js';
import { seenOf, STILL_LOADING } from '../../lib/review.js';

// Folds and rows you opened stay open for this project across a model
// switch and a refresh; another project starts closed.
const opened = new Map();
let openedFor = null;

function HeadMarket({ p, freshness }) {
  const m = mkt(p);
  if (!m) return <div className="ih-price none"><span className="faint">{`No price: ${(noPriceReason(p) || 'unknown').toLowerCase()}`}</span></div>;
  const f = freshnessText(m.status, m.age_minutes);
  const fresh = m.status === 'fresh';
  const s = marketStrings(m);
  const clock = priceClock(m.fetched_at, freshness && freshness.last_success_at);
  const source = m.rank_source_label && /fictional/i.test(m.rank_source_label) ? 'Fictional demo data' : `Source: ${m.source || 'CoinGecko'}`;
  return (
    <div className="ih-price">
      <span className="ih-price-v">{s.price}</span>
      {s.change24h ? <span className={`ih-chg ${m.change_24h_pct < 0 ? 'down' : 'up'}`} title="Price change over 24 hours"><Change value={m.change_24h_pct} label="over 24 hours" /></span> : null}
      <span className={`ih-fresh${fresh && !clock.kept ? '' : ' is-warn'}`} title={`${source}, as of ${fmtDateTime(m.as_of)}${clock.kept ? `. The last price refresh (${fmtAgo(freshness.last_success_at)}) did not update this asset, so its last valid price is kept.` : ''}`}>
        {fresh ? clock.text || fmtAgo(m.fetched_at || m.as_of) : f.text}
      </span>
    </div>
  );
}

function HeadLinks({ p, L }) {
  const web = /^https?:\/\//i.test(String(p.official_website || '')) ? p.official_website : null;
  let host = null;
  try { host = web ? new URL(web).hostname.replace(/^www\./, '') : null; } catch (_) { host = null; }
  const dex = L ? L.dexLink(rowProject(p)) : null;
  const link = (cls, label, href, title, aria) => (
    <a className={`xlink ${cls}`} href={href} target="_blank" rel="noopener noreferrer nofollow" title={title} aria-label={aria} data-key={`x-${cls}-${p.project_id}`}>
      <ExternalLink size={12} strokeWidth={2} aria-hidden="true" /><span>{label}</span>
    </a>
  );
  return (
    <div className="ih-links">
      {p.coingecko_id ? link('cg', 'CG', `https://www.coingecko.com/en/coins/${encodeURIComponent(p.coingecko_id)}`, `CoinGecko: ${p.coingecko_id}`, 'CoinGecko listing') : null}
      {dex ? link('dex', 'DexScreener', dex.href, dex.title, dex.aria) : null}
      {web && host ? link('web', 'Web', web, `Official website: ${host}`, `Official website, ${host}`) : null}
    </div>
  );
}

function Stats({ p }) {
  const m = mkt(p);
  const s = marketStrings(m) || {};
  const none = (label, v) => (m ? <UnknownFigure label={label} value={v} /> : <Unknown label={label} />);
  return (
    <MetricRibbon
      label="Asset overview"
      items={[
        { key: 'mc', label: 'MC', value: s.mcap || none('Market cap', m && m.market_cap_usd), title: 'Market cap (CoinGecko)' },
        { key: 'vol', label: 'Vol 24h', value: s.volume || none('Volume', m && m.volume_24h_usd), title: 'Trading volume over 24 hours' },
        { key: 'fdv', label: 'FDV', value: s.fdv || none('FDV', m && m.fdv_usd), title: 'Fully diluted valuation' },
        { key: 'fdvmc', label: 'FDV/MC', value: s.fdvMc || <Unknown label="FDV over market cap" />, title: 'Fully diluted valuation over market cap, from the two figures shown' },
      ]}
    />
  );
}

function CopyAddr({ address, pid }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-ghost btn-sm btn-icon cc-copy" aria-label={done ? 'Copied' : 'Copy contract address'} title={address} data-key={`copy-addr-${pid}`} onClick={async () => {
      try {
        await navigator.clipboard.writeText(address);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      } catch (_) {
        toast('Could not copy: the browser refused the clipboard.', 'bad');
      }
    }}>
      {done ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

function ContractChips({ p }) {
  const m = contractChipModel(p.screening);
  const first = m.items[0];
  return (
    <div className="cchips">
      <div className="cc-line">
        <span className="cc-k">Contract</span>
        {first ? (
          <span className="cc-v" title={m.items.map((x) => `${x.label || 'chain?'}: ${x.address}`).join('\n')}>
            {first.label ? <span className="cc-chain">{first.label}</span> : null}
            <span className="mono">{shortAddr(first.address)}</span>
            {m.items.length > 1 ? <span className="faint">{` +${m.items.length - 1}`}</span> : null}
          </span>
        ) : <span className="cc-v" title={m.title || undefined}>{m.text || '—'}</span>}
        {first && first.address ? <CopyAddr address={first.address} pid={p.project_id} /> : null}
        {m.status ? <span className={`pill${m.status.tone === 'warn' ? ' pill-warn' : ''}`} title={m.status.title || undefined}>{m.status.word}</span> : null}
        {m.age ? <span className={`cc-age${m.stale ? ' is-stale' : ''}`} title={m.ageTitle} aria-label={`Screened by GoPlus ${m.age} ago${m.stale ? ', stale' : ''}`}>{m.stale ? <Clock size={12} aria-hidden="true" /> : null}<span aria-hidden="true">{`GoPlus ${m.age}`}</span></span> : null}
      </div>
      <SecurityAuditStrip model={m} />
    </div>
  );
}

function Fold({ id, title, children, note = null }) {
  return (
    <details className="fold insp-fold" data-key={id} open={opened.get(id)} onToggle={(e) => opened.set(id, e.currentTarget.open)}>
      <summary title={note || undefined} data-key={`${id}-summary`}>{title}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

// What needs you on this project, one line per model, each opening its tab;
// then the identity when it is not confirmed.
const PROBLEM_WORDS = { uncertain: 'Check charge', failed: 'Research failed', incomplete: 'Research incomplete', conflict: 'Answer quarantined', interrupted: 'Research paused', held: 'Held by archive' };
function ProblemLines({ d, p, onPick }) {
  const items = [];
  for (const prov of PROVIDERS) {
    const job = p.research && p.research.providers && p.research.providers[prov];
    const key = jobKey(job, null, { onHold: Boolean(onHoldOf(d.index, prov)) });
    if (!PROBLEM_WORDS[key]) continue;
    items.push(
      <li key={prov}>
        <button type="button" className={`pline sev-${key === 'uncertain' ? 'high' : 'medium'}`} data-key={`insp-show-${prov}`} onClick={() => onPick(prov)}>
          <span><strong>{PROBLEM_WORDS[key]}</strong>{` · ${PROVIDER_LABELS[prov]}`}</span>
          <span className="pline-go" aria-hidden="true">Show</span>
        </button>
      </li>,
    );
  }
  const crit = (d.index.attention || []).filter((a) => a.project_id === p.project_id && ['writes_blocked', 'broken_record', 'import_failed'].includes(a.kind));
  const idNote = p.identity_status !== 'verified';
  if (!items.length && !crit.length && !idNote) return null;
  return (
    <div className="insp-problems">
      {items.length ? <ul className="plines" aria-label="Research that needs you">{items}</ul> : null}
      {crit.map((a) => <p key={a.kind} className="note note-bad"><strong>{a.title}</strong>{a.detail ? ` ${a.detail}` : ''}</p>)}
      {idNote ? (
        <p className="insp-idnote">
          <strong>Identity pending: </strong>
          {(p.identity_unknowns || []).join(' ') || 'The token is not confirmed, so no prices or holdings use it.'}{' '}
          <a href={`#/project/${encodeURIComponent(p.project_id)}/evidence?open=identity`} data-key={`fix-identity-${p.project_id}`}>Complete the identity</a>
        </p>
      ) : null}
    </div>
  );
}

function ResearchDetails({ d, p, detail }) {
  const idx = d.index;
  const run = p.research && p.research.latest_run;
  const ready = (idx.research && idx.research.providers) || {};
  const words = { done: 'done', now: 'in progress', warn: 'needs attention', bad: 'failed', todo: 'not yet' };
  const runFull = detail ? (detail.research.runs || []).find((r) => r.prompt) || null : null;
  return (
    <div>
      {run ? <p className="run-line"><span>{`Run of ${fmtDateTime(run.created_at)}`}</span><span>{String(run.status || '').replace(/_/g, ' ')}</span>{run.horizon && run.horizon.text ? <span>{`Horizon ${run.horizon.text}`}</span> : null}</p> : <p className="run-line">No research run yet.</p>}
      <ul className="job-list">
        {PROVIDERS.map((prov) => {
          const job = p.research && p.research.providers && p.research.providers[prov];
          const hold = onHoldOf(idx, prov);
          const key = jobKey(job, null, { onHold: Boolean(hold) });
          const st = key ? researchState(key, { provider: prov, hosted: hosted() }) : null;
          const r = ready[prov];
          const rep = p.providers && p.providers[prov];
          const steps = progressSteps(rep, key);
          const how = hold && (key === 'on_hold' || !key) ? `On hold on this desk${hold.since ? ` since ${fmtDate(hold.since)}` : ''}: nothing new is assigned to it`
            : r && r.mode === 'manual' && (key === 'waiting' || (!key && !rep)) ? `${hosted() ? 'Manual: its own assistant does it when you ask' : 'Manual: paste the prompt, import the answer'} · ${setupShort(r.reason)}`
              : r && r.mode === 'mock' && !key ? 'Fictional demo adapter' : null;
          return (
            <li key={prov}>
              <span className="job-who">{PROVIDER_LABELS[prov]}</span>
              <span className="job-state">
                {st ? <span className={`state-word tone-${st.tone || 'none'}`}>{st.short === 'Saved' ? 'Saved as a report' : st.long}</span> : rep ? <span className="state-word tone-ok">{`Report saved${rep.analysis_at ? ` (analysis ${fmtDate(rep.analysis_at)})` : ''}`}</span> : <span className="faint">Not requested</span>}
                {job && job.error && key !== 'completed' ? <span className="job-how">{job.error}</span> : null}
                {how ? <span className="job-how">{how}</span> : null}
                <ol className="steps" aria-label={STEP_NAMES.map((n, i) => `${n} ${words[steps[i]]}`).join(', ')}>
                  {steps.map((s, i) => <li key={STEP_NAMES[i]} className={`step-${s}`} title={`${STEP_NAMES[i]}: ${words[s]}`} aria-hidden="true" />)}
                </ol>
              </span>
            </li>
          );
        })}
      </ul>
      {runFull ? (
        <dl className="facts">
          <div><dt>Prompt version</dt><dd>{runFull.prompt.version || 'not stated'}</dd></div>
          <div><dt>Prompt SHA-256</dt><dd><span className="mono" title={runFull.prompt.sha256}>{`${String(runFull.prompt.sha256 || '').slice(0, 12)}…`}</span></dd></div>
          <div className="wide"><dt>Holding horizon</dt><dd>{runFull.horizon && runFull.horizon.text ? runFull.horizon.text : 'not stated'}</dd></div>
          {runFull.horizon && runFull.horizon.exception_reason ? <div className="wide"><dt>Long-term reason (yours)</dt><dd>{runFull.horizon.exception_reason}</dd></div> : null}
          <div className="wide"><dt>Rubric · profile</dt><dd>{`${runFull.rubric_version || '?'} · ${runFull.sector_profile || '?'}`}</dd></div>
          <div className="wide"><dt>Started</dt><dd>{`${fmtDateTime(runFull.created_at)} via ${runFull.channel || '?'}`}</dd></div>
        </dl>
      ) : null}
      {runFull ? <Dom build={(L) => L.promptView(legacyCtx, p.project_id, runFull)} deps={[runFull.run_id]} /> : null}
    </div>
  );
}

function ComparePart({ d, p, detail }) {
  if (!detail) return null;
  // Side by side only when every model's opinion in the record is the one
  // the list shows (review 2026-10-08, F1).
  if (!opinionsAgree(p, detail)) return <div className="part-loading" role="status"><span className="sr-only">Loading the models' reports…</span><span className="skel w80" /><span className="skel w60" /></div>;
  const c = detail.comparison;
  const present = PROVIDERS.filter((x) => c.latest[x]);
  if (present.length < 2) return <p className="faint">Model differences appear once at least two models have graded this project.</p>;
  const comparable = new Set(c.comparability.comparable_providers || []);
  const weights = Object.fromEntries(d.index.rubrics.grading.investment_components.map((x) => [x.id, x.weight_bp / 100]));
  const cell = (s) => {
    if (!s) return <span className="faint" title="Not in this report">—</span>;
    const title = s.rationale || s.missing_data || undefined;
    if (s.status === 'scored') return <span title={title}>{s.value}</span>;
    if (s.status === 'range') return <span title={title}>{`${s.low}–${s.high}`}</span>;
    if (s.status === 'not_applicable') return <span className="faint" title={title || 'Not applicable'}>N/A</span>;
    return <span className="faint" title={title || 'Unknown'}>?<span className="sr-only"> unknown</span></span>;
  };
  const table = (rows, w = null) => (
    <div className="cmp-wrap">
      <table className="cmp">
        <thead><tr><th scope="col">Item</th>{present.map((x) => <th key={x} scope="col" className="n" title={comparable.has(x) ? undefined : 'Not compared: a different rubric, profile, horizon or date'}>{PROVIDER_LABELS[x] === 'ChatGPT' ? 'GPT' : PROVIDER_LABELS[x]}{comparable.has(x) || comparable.size < 2 ? null : '*'}</th>)}{comparable.size >= 2 ? <th scope="col" className="n" title="Points between the highest and lowest comparable score">Gap</th> : null}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.spread_flag ? 'is-flag' : ''}>
              <td>{r.label}{w && w[r.id] !== undefined ? <span className="part-w">{`${w[r.id]}%`}</span> : null}</td>
              {present.map((x) => <td key={x} className="n">{r.applicable === false ? <span className="faint" title={r.na_reason || ''}>N/A</span> : cell(r.cells[x])}</td>)}
              {comparable.size >= 2 ? <td className="n">{r.spread === null || r.spread === undefined ? <span className="faint">—</span> : r.spread_flag ? <strong>{r.spread}<span className="sr-only">, at or above the highlight threshold</span></strong> : r.spread}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  const of = (section) => c.rows.filter((r) => r.section === section);
  return (
    <div className="cmp-part">
      <p className="faint">Computed by this desk from the saved reports; not a model's opinion. Agreement between models is not independent confirmation.</p>
      <h4>Weighted components</h4>
      {table(of('component'), weights)}
      <h4>Downside risk <span className="faint">· higher = worse</span></h4>
      {table(of('risk'))}
      {comparable.size < 2 ? <p className="faint">{`Not directly comparable${(c.comparability.reasons || []).length ? `: ${c.comparability.reasons.join('; ')}` : ''}.`}</p> : null}
      <a className="btn btn-sm" href={`#/project/${encodeURIComponent(detail.project.project_id)}/compare`} data-key={`compare-${detail.project.project_id}`}>Compare in detail</a>
    </div>
  );
}

function ChecksPart({ detail }) {
  const m = detail ? contractChecks(detail.screening) : null;
  if (!m) return null;
  return (
    <Fold id={`insp-checks-${detail.project.project_id}`} title="Contract checks">
      <div className="cchecks">
        {m.alerts.length ? <ul className="cc-alerts">{m.alerts.map((a) => <li key={`${a.at}-${a.address}`}><span className="faint">{fmtDateTime(a.at)}</span>{` · ${a.label} `}<span className="mono" title={a.address}>{shortAddr(a.address)}</span>{`: ${a.words}`}</li>)}</ul> : null}
        {m.contracts.map((c) => (
          <div key={`${c.label}-${c.address}`} className="cc-contract">
            <div className="cc-head"><span className="cc-chain">{c.label}</span><span className="mono cc-addr" title={c.address}>{c.address}</span>{c.status === 'ok' ? <span className="faint" title={`GoPlus Security${c.partial ? ', partial answer' : ''}`}>{fmtDateTime(c.checked_at)}</span> : null}</div>
            {c.status !== 'ok' ? <p className="faint">{c.reason || 'Not screened'}</p> : (
              <dl className="cc-rows">
                {c.rows.map((r) => <div key={r.key} className={`cc-row is-${r.state} lvl-${r.level}`}><dt>{r.label}</dt><dd aria-label={r.state === 'unknown' ? 'unknown, GoPlus gave no answer' : r.value}>{r.value}</dd></div>)}
                {c.facts.map(([k, v, full]) => <div key={k} className="cc-row is-fact"><dt>{k}</dt><dd className={full ? 'mono' : undefined} title={full || undefined}>{v}</dd></div>)}
              </dl>
            )}
            {c.status === 'ok' && c.unknown.length ? <p className="cc-unknown"><span className="tl-k">No answer: </span>{c.unknown.join(' · ')}</p> : null}
            {c.notes && c.notes.length ? <p className="faint">{c.notes.join(' · ')}</p> : null}
          </div>
        ))}
      </div>
    </Fold>
  );
}

function EvidencePart({ d, p, prov, detail }) {
  const sum = p.providers && p.providers[prov];
  if (!detail) return <div className="part-loading" role="status"><span className="sr-only">Loading the evidence checks…</span><span className="skel w80" /><span className="skel w60" /></div>;
  const op = opinionOf(p, prov, detail);
  const r = op.status === 'ok' ? op.report : null;
  if (!r) return sum ? <div className="part-loading" role="status"><span className="sr-only">Loading the evidence checks…</span><span className="skel w80" /><span className="skel w60" /></div> : null;
  if (r.broken) return null;
  const a = r.assessment || {};
  const sources = a.sources || [];
  const claims = Array.isArray(a.claims) ? a.claims : [];
  const TAGS = [['V', 't-v', 'researcher-verified'], ['C', 't-c', 'claimed'], ['I', 't-i', 'inference'], ['S', 't-s', 'speculative']];
  const n = Object.fromEntries(TAGS.map(([t]) => [t, claims.filter((c) => c.evidence_tag === t).length]));
  const other = claims.length - TAGS.reduce((s, [t]) => s + n[t], 0);
  return (
    <div className="ev-model" id={`insp-ev-${prov}`} tabIndex={-1} data-report={r.report_id}>
      {claims.length ? (
        <div className="evq">
          <div className="evbar" aria-hidden="true">{TAGS.filter(([t]) => n[t]).map(([t, cls]) => <span key={t} className={cls} style={{ width: `${(n[t] / claims.length) * 100}%` }} />)}</div>
          <p className="ev-legend">
            {TAGS.map(([t, cls, word]) => <span key={t}><i className={cls} aria-hidden="true" /><strong>{n[t]}</strong>{` ${word} [${t}]`}</span>)}
            {other ? <span><strong>{other}</strong> untagged</span> : null}
            <span className="faint">{`of ${claims.length} claims`}</span>
          </p>
        </div>
      ) : <p className="faint">No structured claims in this report.</p>}
      <Dom build={(L) => L.evidenceChecksBlock(r.evidence)} deps={[r.report_id]} />
      {sources.length ? (
        <Fold id={`insp-src-${p.project_id}-${prov}`} title={`${sources.length} source${sources.length === 1 ? '' : 's'} cited`}>
          <Dom as="ol" className="src-list" build={(L) => sources.map(L.sourceItem)} deps={[r.report_id]} />
        </Fold>
      ) : <p className="faint">This report lists no sources.</p>}
      <p><a href={`#/project/${encodeURIComponent(p.project_id)}/evidence?model=${prov}&open=claims`} data-key={`insp-claims-${prov}`}>Claims and your checks</a></p>
    </div>
  );
}

function TimingFacts({ d, p, prov }) {
  const rep = p.providers && p.providers[prov];
  if (!rep) return null;
  const riskLabels = Object.fromEntries((d.index.rubrics.grading.risk_scores || []).map((x) => [x.id, x.label]));
  const risks = (rep.top_risks || []).filter((r) => r.status === 'scored' || r.status === 'range');
  const channel = rep.provenance && rep.provenance.channel ? rep.provenance.channel : null;
  return (
    <Dom
      build={(L) => {
        const facts = [...L.positionFacts(legacyCtx, p, prov, rep)];
        if (risks.length) facts.push(['Top risks (higher is worse)', risks.map((r) => `${riskLabels[r.id] || r.id}: ${r.status === 'range' ? `${r.low}–${r.high}` : r.value}`).join(' · ')]);
        facts.push(['Report', [rep.model_version || 'model not stated', rep.provenance && rep.provenance.attested ? 'attested by the API' : /desk connector/i.test(channel || '') ? 'saved through its connection' : 'imported'].join(' · ')]);
        return L.h('dl', { class: 'facts' }, facts.map(([k, v]) => L.h('div', { class: 'wide' }, L.h('dt', null, k), L.h('dd', null, v))));
      }}
      deps={[p.project_id, prov, rep.report_id, d.version]}
    />
  );
}

function Onchain({ p }) {
  const fund = (key, k) => {
    const x = fundamentalsTile(p.fundamentals, key);
    return <div title={x.title}><dt>{k}</dt><dd className={x.stale ? 'is-stale' : undefined}>{x.text || <Unknown label={k} />}</dd></div>;
  };
  return (
    <div>
      {defillamaBound(p.fundamentals) ? <dl className="facts">{fund('fees', '30D fees (DefiLlama)')}{fund('revenue', '30D revenue (DefiLlama)')}</dl> : null}
      <p><span className="pill" title="No on-chain data source (such as Artemis) is set up; nothing is estimated">Not connected</span></p>
      <dl className="facts">{['Daily active addresses', 'Transactions', 'TVL'].map((k) => <div key={k}><dt>{k}</dt><dd><Unknown label={k} /></dd></div>)}</dl>
    </div>
  );
}

function MarketDetails({ p }) {
  const m = mkt(p);
  if (!m) return null;
  const demo = m.rank_source_label && /fictional/i.test(m.rank_source_label);
  return (
    <div>
      {m.sparkline_7d ? <div className="md-spark"><Spark values={m.sparkline_7d} change={m.change_7d_pct} width={360} height={56} label={`${p.symbol || p.name} 7-day price`} /></div> : null}
      <dl className="facts">
        <div><dt>7D, rolling</dt><dd><Change value={m.change_7d_pct} label="over 7 days" /></dd></div>
        <div><dt>30D, rolling</dt><dd><Change value={m.change_30d_pct} label="over 30 days" /></dd></div>
        <div><dt>{demo ? 'Rank (demo data)' : 'Rank (CoinGecko)'}</dt><dd>{m.market_cap_rank ? `#${m.market_cap_rank}` : 'Unranked'}</dd></div>
        <div><dt>FDV</dt><dd>{fmtMarketFigure(m.fdv_usd) || <UnknownFigure label="FDV" value={m.fdv_usd} />}</dd></div>
        {m.vs_btc ? <div title={m.vs_btc.definition}><dt>vs BTC, 7D</dt><dd><Change value={m.vs_btc.vs_btc_7d_pct} label="against Bitcoin over 7 days" /></dd></div> : null}
        {m.vs_btc ? <div title={m.vs_btc.definition}><dt>vs BTC, 30D</dt><dd><Change value={m.vs_btc.vs_btc_30d_pct} label="against Bitcoin over 30 days" /></dd></div> : null}
        <div className="wide"><dt>Source</dt><dd>{`${demo ? 'Fictional demo data' : 'CoinGecko'} · as of ${fmtDateTime(m.as_of)}`}</dd></div>
      </dl>
    </div>
  );
}

export default function Inspector({ pid, wide }) {
  const d = useDesk();
  const p = d.index.projects.find((x) => x.project_id === pid);
  const { d: detail, current, error, retry } = useProject(pid);
  const root = useRef(null);
  const heading = useRef(null);
  const body = useRef(null);
  const [, force] = useState(0);
  const [L, setL] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadLegacy().then(setL, () => {}); }, []);
  if (openedFor !== pid) {
    opened.clear();
    openedFor = pid;
  }
  const sel = view.inspectorTab[pid] && PROVIDERS.includes(view.inspectorTab[pid]) ? view.inspectorTab[pid] : defaultModel(p.providers);
  const modal = !wide;
  // The reports drawn here, which Mark reviewed sends (nothing while loading).
  const drawn = seenOf(p, current ? detail : null);

  // Opening: focus moves into the inspector (its title, or the model's tab
  // when a grade opened it); a peek beside the list leaves focus on the row.
  // Another project starts at its top.
  const lastPid = useRef(null);
  useLayoutEffect(() => {
    const changed = lastPid.current !== pid;
    lastPid.current = pid;
    if (changed && body.current) body.current.scrollTop = 0;
    if (view.focusOnRender) {
      const target = view.focusProvider ? root.current.querySelector(`[data-key="insp-tab-${view.focusProvider}"]`) : heading.current;
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
  const pickModel = (prov, focus = true) => {
    view.inspectorTab[pid] = prov;
    force((n) => n + 1);
    if (focus) {
      requestAnimationFrame(() => {
        const t = root.current && root.current.querySelector(`[data-key="insp-tab-${prov}"]`);
        if (t) t.focus({ preventScroll: true });
        const list = root.current && root.current.querySelector('.mtabs');
        if (body.current && list) {
          const above = body.current.getBoundingClientRect().top - list.getBoundingClientRect().top;
          if (above > 0) body.current.scrollTop -= above + 8;
        }
      });
    }
  };
  const ch = p.changes || {};
  const selRep = p.providers && p.providers[sel];
  const reports = PROVIDERS.filter((x) => p.providers && p.providers[x] && !p.providers[x].needs_text).length;
  const archived = p.status === 'archived';
  const a = p.archive || {};
  const m = mkt(p);

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
        <header className="insp-head">
          <div className="ih-row">
            <Logo p={p} size={36} />
            <h2 id="insp-title" ref={heading} tabIndex={-1} title={p.name}>
              <span className="ih-name">{p.name}{p.symbol ? <>{' '}<span className="ih-sym">{p.symbol}</span></> : null}</span>
            </h2>
            <div className="ih-win">
              <Menu
                label={`Actions for ${p.name}`}
                align="end"
                trigger={<button type="button" className="btn btn-ghost btn-icon" aria-label={`More actions for ${p.name}`} title="More actions" data-key="panel-more"><Ellipsis size={18} aria-hidden="true" /></button>}
              >
                <MenuItem href={`#/project/${encodeURIComponent(pid)}/brief`} data-key={`menu-full-${pid}`}>Full research page</MenuItem>
                {archived ? null : <MenuItem data-key="menu-research" onSelect={async () => { const Lm = await loadLegacy(); Lm.openResearchDialog(legacyCtx, p); }}>Run research…</MenuItem>}
                {archived ? null : <MenuItem data-key="menu-watch" desc={p.on_watchlist ? 'On your watchlist now' : null} onSelect={() => setWatching(p, !p.on_watchlist)}>{p.on_watchlist ? 'Stop watching' : 'Watch'}</MenuItem>}
                {p.sector ? <MenuItem data-key="menu-sector" desc={p.sector.label} onSelect={async () => { const Lm = await loadLegacy(); Lm.openSectorDialog(legacyCtx, p); }}>Change sector</MenuItem> : null}
                <MenuItem data-key="menu-reviewed" desc={drawn.ready ? null : STILL_LOADING} disabled={!drawn.ready} onSelect={() => markReviewed(p, { force: true, onBusy: setBusy })}>Mark reviewed</MenuItem>
                {p.held ? <MenuItem href="#/portfolio" data-key="menu-held">Holding in Portfolio</MenuItem> : null}
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
          <Stats p={p} />
        </header>

        <div className="insp-body" ref={body} data-keep-scroll={`panel:${pid}`}>
          {archived ? (
            <div className="note insp-archived" role="note">
              <span><strong>Archived</strong>{a.archived_at ? ` ${fmtDate(a.archived_at)}` : ''}{a.reason ? `: ${a.reason}` : ''}. Off your lists; its reports, notes, runs and any holding are kept.</span>
              <button type="button" className="btn btn-sm" data-key={`restore-${pid}`} onClick={() => restoreProject(p)}>Restore</button>
            </div>
          ) : null}
          <ProblemLines d={d} p={p} onPick={(prov) => pickModel(prov)} />
          {error ? (
            <div className="note note-warn insp-error" role="alert">
              <span>{`Could not load the full record: ${error.message}. The summary above is current.`}</span>
              <button type="button" className="btn btn-sm" data-key={`insp-retry-${pid}`} onClick={retry}>Try again</button>
            </div>
          ) : null}

          <section className="insp-sec insp-verdict" aria-labelledby="insp-sec-verdict">
            <div className="sec-head">
              <h3 className="sec-title" id="insp-sec-verdict">Verdict</h3>
              {/* The Brief of the model chosen here (review 2026-10-08, F4). */}
              <a
                className="btn btn-sm brief-link"
                href={`#/project/${encodeURIComponent(pid)}/brief?model=${sel}`}
                data-key={`brief-${pid}`}
                aria-label={`${PROVIDER_LABELS[sel]} Brief: ${p.name}`}
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  view.briefReturn = pid;
                  navigate(`#/project/${encodeURIComponent(pid)}/brief?model=${sel}`, { state: { crBrief: pid, from: 'watchlist' } });
                }}
              >
                <FileText size={14} aria-hidden="true" /><span>{`${PROVIDER_LABELS[sel]} Brief`}</span>
              </a>
            </div>
            <Tabs.Root value={sel} onValueChange={(v) => pickModel(v)} activationMode="automatic">
              {/* A segmented control: the model and its grade in one line; a
                  model on hold with no report and no job reads "Hold". */}
              <ModelTabMatrix
                models={PROVIDERS.map((prov) => {
                  const rep = p.providers && p.providers[prov];
                  const job = p.research && p.research.providers && p.research.providers[prov];
                  const info = pillInfo(prov, rep, job, badgeOpts(d, prov));
                  const hold = !rep && !job ? onHoldOf(d.index, prov) : null;
                  return {
                    key: prov,
                    name: PROVIDER_LABELS[prov],
                    short: PROVIDER_SHORT[prov],
                    dataKey: `insp-tab-${prov}`,
                    aria: hold ? `${PROVIDER_LABELS[prov]}: on hold on this desk, no report` : info.text.replace(/[.\s]+$/, ''),
                    badge: hold ? <span className="mtab-hold" aria-hidden="true">Hold</span> : <GradePill provider={prov} report={rep} job={job} opts={badgeOpts(d, prov)} showSub={false} className="gp-compact" aria-hidden="true" />,
                  };
                })}
              />
              <Tabs.Content value={sel} className="mtab-panel" tabIndex={-1}>
                <ModelPanel d={d} p={p} prov={sel} detail={detail} current={current} failed={Boolean(error)} opened={opened} />
              </Tabs.Content>
            </Tabs.Root>
          </section>

          <section className="insp-sec insp-market" aria-labelledby="insp-sec-market">
            <h3 className="sec-title" id="insp-sec-market">Market structure</h3>
            <Dom className="dex-slot" build={(Lm) => Lm.dexCard(legacyCtx, rowProject(p))} deps={[pid]} />
            <ContractChips p={p} />
          </section>

          <div className="insp-folds">
            <Dom className="chart-slot" build={(Lm) => Lm.technicalChart(legacyCtx, detail ? detail.project : null)} deps={[pid, Boolean(detail)]} />
            {selRep ? <Fold id={`insp-evd-${sel}`} title="Evidence and sources"><EvidencePart d={d} p={p} prov={sel} detail={detail} /></Fold> : null}
            {selRep ? <Fold id={`insp-timing-${sel}`} title="Timing, risks and the report"><TimingFacts d={d} p={p} prov={sel} /></Fold> : null}
            <Fold id={`insp-onchain-${pid}`} title="On-chain fundamentals"><Onchain p={p} /></Fold>
            {reports >= 2 ? <Fold id={`insp-compare-${pid}`} title="Compare the models"><ComparePart d={d} p={p} detail={detail} /></Fold> : null}
            {m ? <Fold id={`insp-market-${pid}`} title="Market details"><MarketDetails p={p} /></Fold> : null}
            <Fold id={`insp-research-${pid}`} title="Research details"><ResearchDetails d={d} p={p} detail={detail} /></Fold>
            <ChecksPart detail={detail} />
            {selRep ? <p className="insp-links"><a className="btn btn-sm" href={`#/project/${encodeURIComponent(pid)}/brief?model=${sel}&open=scorecard`} data-key={`scorecard-${pid}-${sel}`}>Full scorecard</a></p> : null}
          </div>
        </div>

        <footer className="insp-foot">
          <p className="if-sum" title={p.next_review ? `Next review: ${fmtDate(p.next_review.date)}${p.next_review.overdue ? ' (overdue)' : ''}` : undefined}>
            {ch.item_count ? (
              <>
                <span>{`${ch.item_count} change${ch.item_count === 1 ? '' : 's'} since ${ch.cursor_source === 'project created' ? 'added' : 'your last review'}`}</span>
                <span className="if-dot" aria-hidden="true">·</span>
                <a href={`#/project/${encodeURIComponent(pid)}/notes`} data-key={`history-${pid}`}>What changed</a>
              </>
            ) : <span className="if-ok"><Check size={14} aria-hidden="true" />Reviewed</span>}
          </p>
          <div className="if-act">
            {selRep ? <a className="btn btn-sm" href={`#/project/${encodeURIComponent(pid)}/report?report=${encodeURIComponent(selRep.report_id)}`} data-key={`report-${pid}-${sel}`} data-report={selRep.report_id}>Open report</a> : null}
            {needsReview(p) ? <button type="button" className="btn btn-sm btn-primary" data-key="panel-reviewed" aria-keyshortcuts="R" title={drawn.ready ? 'Mark reviewed (R marks it and moves to the next project to review)' : STILL_LOADING} aria-disabled={drawn.ready ? undefined : 'true'} disabled={busy || !drawn.ready} onClick={() => markReviewed(p, { onBusy: setBusy })}>{drawn.ready ? 'Mark reviewed' : STILL_LOADING}</button> : null}
          </div>
        </footer>
      </aside>
    </>
  );
}
