// One page per project (#/project/<id>/<section>): the deep audit, Level 2
// (DESIGN_AND_IA_BLUEPRINT.md §3.3; Eric, 2026-10-17). The header carries the
// identity and the market now (with its own time, apart from any research
// date) and the actions: Run research, Start forensic audit, Watching and the
// menu (Archive). Under it the model switcher, a segmented control:
// Claude | ChatGPT | Gemini | Compare (Compare is a mode, not a section, at
// the address "compare"); then the sections as underline tabs with counts:
// Brief (the address "brief"), Evidence, Forensics, Market, Contract, Report,
// Record and Notes. Opened from the inspector (Open full research), a back bar,
// Back and Escape return there with the list's filters, place and focus, also
// after moving between the project's sections. Drawing a section never
// fetches prices, screens, posts or starts research; the actions are explicit.
//
// The sections are page navigation (links, the current one marked), and each
// carries the opinion chosen here (?model=, ?report=) so Evidence, Report and
// Back keep the same model and report (review 2026-10-08, F4, F6). An opinion
// is drawn only when the record holds the very report the list names
// (lib/opinion.js), else the view waits (F1).
import { Fragment, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ellipsis, Check, Play, ShieldCheck } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABELS, PROVIDER_SHORT, fmtDateTime, fmtAgo, fmtAsOf, toast } from '../../../../public/ui.js';
import { briefModel, marketNow } from '../../../../public/brief-model.js';
import { PROJECT_TABS, PROJECT_VIEWS, MODEL_VIEWS, selectionOf, sectionHref } from '../../../../public/project-routes.js';
import { useDesk, useProject, useMedia } from '../../lib/hooks.js';
import { refresh, hosted, resyncOnce, wasResynced } from '../../lib/desk.js';
import { opinionOf, opinionsAgree } from '../../lib/opinion.js';
import { WsTag } from '../../shell/Shell.jsx';
import { nav, navigate, pageReady, claimFocus, hrefWith } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, UnknownFigure } from '../../components/figures.jsx';
import { GradePill, pillInfo } from '../../components/GradePill.jsx';
import { Menu, MenuItem } from '../../components/Menu.jsx';
import { Dom, loadLegacy } from '../../components/Dom.jsx';
import { badgeOpts } from '../watchlist/ProjectTable.jsx';
import { archiveProject, restoreProject, setWatching } from '../watchlist/state.js';
import Brief from './Overview.jsx';
import { CheckIn } from './CheckIn.jsx';
import Forensics from './Forensics.jsx';
import Compare from './Compare.jsx';
import Evidence from './Evidence.jsx';
import Market from './Market.jsx';
import Contract from './Contract.jsx';
import Report from './Report.jsx';
import Record from './Record.jsx';
import Notes from './Notes.jsx';

const enc = encodeURIComponent;
// Each section's folds, by the name an address opens them with (?open=).
const FOLDS = {
  brief: { scorecard: 'pb-scorecard' },
  evidence: { checks: 'brief-ev-checks', claims: 'pb-claims' },
  record: { runs: 'pb-runs', technical: 'pb-technical', headline: 'pb-headline', history: 'rec-history', forensic: 'rec-forensic' },
  contract: { identity: 'pb-identity', edit: 'identity-edit' },
  forensics: { start: 'fx-start' },
};
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// Leaving a project opened from the inspector: back to that entry (all the
// way, past the project's own sections), else to the project on the Desk.
function closeBrief(pid) {
  const st = history.state;
  if (st && st.crBrief === pid) history.go(-(Number(st.crDepth) || 1));
  else navigate(`#/watchlist?p=${enc(pid)}`, { replace: true });
}

function MarketFacts({ row }) {
  const mk = marketNow(row);
  if (!mk) return <p className="ph-mk none"><span className="faint">No market data for this project</span></p>;
  const when = mk.as_of ? fmtAgo(mk.as_of) : 'time not recorded';
  return (
    <p className="ph-mk" title={`${mk.source}${mk.as_of ? `, as of ${fmtDateTime(mk.as_of)}` : ''}. A market observation, not part of the research.`}>
      <span className="ph-mk-price">{mk.price}</span>
      {mk.change24h ? <Change value={mk.change} label="over 24 hours" className="ph-mk-chg" /> : null}
      <span className="ph-mk-f"><span className="k" aria-hidden="true">MC</span><span className="sr-only">Market cap </span>{mk.mcap || <UnknownFigure label="Market cap" value={mk.mcap_usd} />}</span>
      <span className="ph-mk-f"><span className="k" aria-hidden="true">Vol 24h</span><span className="sr-only">Volume over 24 hours </span>{mk.volume || <UnknownFigure label="Volume" value={mk.volume_usd} />}</span>
      <span className={`ph-mk-when${mk.stale ? ' is-stale' : ''}`}>{mk.stale ? `Stale price · ${when}` : `${mk.source} · ${when}`}{mk.as_of ? <span className="sr-only">{`, at ${fmtAsOf(mk.as_of)}`}</span> : null}</span>
    </p>
  );
}

function Header({ d, row, phone }) {
  const p = d.project;
  const [wholeName, setWholeName] = useState(false);
  const longName = String(p.name || '').length > 48;
  const id = p.identity;
  const sector = d.sector || p.sector;
  const archived = p.status === 'archived';
  const watching = Boolean(p.watchlist && p.watchlist.on_watchlist);
  const projectish = { ...row, ...p, research: row.research, report_count: d.reports.length, on_watchlist: watching };
  const runResearch = async () => {
    const L = await loadLegacy();
    L.openResearchDialog(legacyCtx, projectish);
  };
  // Start forensic audit opens the Forensics section on its Start button:
  // the audit itself is that button's explicit click (with its options).
  const forensicHref = `#/project/${enc(p.project_id)}/forensics?open=start`;
  const toggleWatch = async () => { await setWatching(projectish, !watching); toast('Watchlist updated'); };
  return (
    <header className="ph">
      <div className="ph-id">
        <Logo p={{ ...row, project_id: p.project_id, name: p.name, symbol: p.symbol }} size={40} />
        <div className="ph-names">
          <h1 id="ph-name" className={longName ? `is-long${wholeName ? '' : ' is-clamped'}` : undefined}>{p.name}{p.symbol ? <span className="ph-ticker">{` ${p.symbol}`}</span> : null}</h1>
          {longName && phone ? <button type="button" className="btn-link ph-wholename" aria-expanded={wholeName} aria-controls="ph-name" data-key="ph-wholename" onClick={() => setWholeName(!wholeName)}>{wholeName ? 'Shorter name' : 'Whole name'}</button> : null}
          <MarketFacts row={row} />
          <p className="ph-meta">
            {d.position && !d.position.closed ? <span className="badge is-accent">Held</span> : null}
            <a className={`badge${id.status === 'verified' ? '' : ' is-warn'}`} href={`#/project/${enc(p.project_id)}/contract?open=identity`} title={(id.unknowns || []).join(' ') || 'Token identity, contracts and evidence'} data-key="project-identity">{id.status === 'verified' ? 'Identity verified' : `Identity ${id.status}`}</a>
            {sector ? <button type="button" className="btn-link" data-key="project-sector" aria-label={`Sector: ${sector.label || sector.primary}. Change sector`} onClick={async () => { const L = await loadLegacy(); L.openSectorDialog(legacyCtx, { ...projectish, sector }); }}>{sector.label || sector.primary}</button> : null}
            {id.official_website ? <a href={id.official_website} target="_blank" rel="noopener noreferrer nofollow" className="wrap-anywhere">{id.official_website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a> : null}
          </p>
        </div>
        {phone ? (
          <Menu label={`Actions for ${p.name}`} align="end" trigger={<button type="button" className="btn btn-ghost btn-icon ph-more" aria-label={`Actions for ${p.name}`} data-key="project-more"><Ellipsis size={18} aria-hidden="true" /></button>}>
            {archived ? null : <MenuItem data-key="project-menu-research" onSelect={runResearch}>Run research…</MenuItem>}
            {archived ? null : <MenuItem data-key="project-menu-forensic" href={forensicHref}>Start forensic audit</MenuItem>}
            {archived ? null : <MenuItem data-key="project-menu-watch" desc={watching ? 'On your watchlist now' : null} onSelect={toggleWatch}>{watching ? 'Stop watching' : 'Watch'}</MenuItem>}
            {archived
              ? <MenuItem data-key="project-menu-restore" desc="Back as it was, with its history" onSelect={() => restoreProject(projectish)}>Restore</MenuItem>
              : <MenuItem data-key="project-menu-archive" desc="Off your lists; nothing is deleted. Undo right after." onSelect={() => archiveProject(projectish)}>Archive</MenuItem>}
          </Menu>
        ) : null}
      </div>
      {phone ? null : (
        <div className="ph-actions">
          {archived ? null : <button type="button" className="btn btn-primary" id="project-research-btn" data-key="project-research" onClick={runResearch}><Play size={14} aria-hidden="true" />Run research</button>}
          {archived ? null : <a className="btn" href={forensicHref} data-key="project-forensic"><ShieldCheck size={14} aria-hidden="true" />Start forensic audit</a>}
          {archived ? null : <button type="button" className="btn" aria-pressed={watching} data-key="project-watch" title={watching ? 'On your watchlist. Click to stop watching.' : 'Add to your watchlist'} onClick={toggleWatch}>{watching ? <><Check size={14} aria-hidden="true" />Watching</> : 'Watch'}</button>}
          <Menu label={`More actions for ${p.name}`} align="end" trigger={<button type="button" className="btn btn-ghost btn-icon" aria-label={`More actions for ${p.name}`} data-key="project-menu"><Ellipsis size={18} aria-hidden="true" /></button>}>
            {archived
              ? <MenuItem data-key="project-restore" desc="Back as it was, with its history" onSelect={() => restoreProject(projectish)}>Restore</MenuItem>
              : <MenuItem data-key="project-archive" desc="Off your lists; nothing is deleted. Undo right after." onSelect={() => archiveProject(projectish)}>Archive</MenuItem>}
          </Menu>
        </div>
      )}
    </header>
  );
}

// The model switcher: Claude | ChatGPT | Gemini | Compare (a segmented
// control; Left, Right, Home and End move along it; focus stays on the chosen
// segment). A model shows the current section for that model (Brief when
// Compare was open); Compare shows the two latest reports side by side.
function ModelSwitcher({ row, sel, tab, pid }) {
  const desk = useDesk();
  const keys = [...PROVIDERS, 'compare'];
  const current = tab === 'compare' ? 'compare' : sel;
  const go = (k) => {
    // Compare keeps the chosen model for the way back to its Brief.
    const to = k === 'compare'
      ? `#/project/${enc(pid)}/compare${sel ? `?model=${sel}` : ''}`
      : tab === 'compare'
        ? `#/project/${enc(pid)}/brief?model=${k}`
        : hrefWith({ model: k, report: null, open: null, run: null });
    navigate(to, { replace: true, state: history.state });
    requestAnimationFrame(() => { const t = document.querySelector(`[data-key="pb-tab-${k}"]`); if (t) t.focus({ preventScroll: true }); });
  };
  return (
    <div className="ptabs" role="tablist" aria-label="Model" onKeyDown={(e) => {
      const i = keys.indexOf(current);
      const to = e.key === 'ArrowRight' ? keys[(i + 1) % keys.length] : e.key === 'ArrowLeft' ? keys[(i + keys.length - 1) % keys.length] : e.key === 'Home' ? keys[0] : e.key === 'End' ? keys[keys.length - 1] : null;
      if (!to) return;
      e.preventDefault();
      if (to !== current) go(to);
    }}>
      {PROVIDERS.map((prov) => {
        const rep = row.providers && row.providers[prov];
        const job = row.research && row.research.providers && row.research.providers[prov];
        const opts = badgeOpts(desk, prov);
        const info = pillInfo(prov, rep, job, opts);
        const on = prov === current;
        const verdict = rep && rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase().replace(/_/g, ' ')}` : null;
        return (
          <button key={prov} type="button" role="tab" id={`pb-tab-${prov}`} className="ptab" aria-selected={on} aria-controls="pb-model" tabIndex={on ? 0 : -1} data-key={`pb-tab-${prov}`} aria-label={`${info.text.replace(/[.\s]+$/, '')}${verdict ? `. Verdict: ${verdict}` : ''}`} title={verdict || undefined} onClick={() => { if (!on) go(prov); }}>
            <span className="ptab-top" aria-hidden="true"><span className="ptab-name"><span className="n-full">{PROVIDER_LABELS[prov]}</span><span className="n-short">{PROVIDER_SHORT[prov]}</span></span><GradePill provider={prov} report={rep} job={job} opts={opts} showSub={false} /></span>
            {verdict ? <span className="ptab-verdict" aria-hidden="true">{verdict}</span> : <span className="ptab-verdict faint" aria-hidden="true">{info.kind === 'none' ? 'No report' : ''}</span>}
          </button>
        );
      })}
      <button type="button" role="tab" id="pb-tab-compare" className="ptab ptab-compare" aria-selected={current === 'compare'} aria-controls="pb-model" tabIndex={current === 'compare' ? 0 : -1} data-key="pb-tab-compare" aria-label="Compare the models' reports side by side" onClick={() => { if (current !== 'compare') go('compare'); }}>
        <span className="ptab-top" aria-hidden="true"><span className="ptab-name">Compare</span></span>
        <span className="ptab-verdict" aria-hidden="true">Side by side</span>
      </button>
    </div>
  );
}

export default function ProjectPage() {
  const d0 = useDesk();
  const route = nav.route;
  const pid = route.args[0];
  const tab = PROJECT_VIEWS.includes(route.args[1]) ? route.args[1] : 'brief';
  const { d, current, error, retry } = useProject(pid);
  const phone = useMedia('(max-width: 767.98px)');
  const row = d0.index.projects.find((x) => x.project_id === pid) || {};
  const prov = PROVIDERS.includes(route.query.get('model')) ? route.query.get('model') : 'claude';
  const reportId = route.query.get('report') || null;
  const st = history.state;
  const fromInspector = Boolean(st && st.crBrief === pid);
  const staleDays = (d0.index.settings && d0.index.settings.freshness && d0.index.settings.freshness.research_stale_days) || 90;
  const m = useMemo(() => (d && (tab === 'brief' || tab === 'evidence') ? briefModel({ detail: d, row, index: d0.index, provider: prov, reportId, hosted: hosted() }) : null), [d, d0.index, prov, reportId, tab]);

  // Escape leaves a project opened from the inspector; never while typing or
  // with a dialog or menu open.
  useEffect(() => {
    const onKey = (e) => {
      const r = nav.route;
      if (!r || r.name !== 'project' || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const s = history.state;
      if (!s || s.crBrief !== r.args[0]) return;
      const t = e.target;
      if (document.querySelector('dialog[open]') || document.querySelector('.menu') || document.querySelector('.prefs.is-open') || (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))) return;
      e.preventDefault();
      closeBrief(r.args[0]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // In place: start where Back left it, or at the top; an address that names
  // a folded part (?open=, ?run=) brings it into view once, with focus.
  const open = FOLDS[tab] ? FOLDS[tab][route.query.get('open') || (tab === 'record' && route.query.get('run') ? 'runs' : '')] : null;
  const run = tab === 'record' ? route.query.get('run') : null;
  useLayoutEffect(() => {
    if (!d) return;
    pageReady();
    if (nav.reason === 'same' || d0.reason === 'live') return;
    if (!open && !run) {
      if (fromInspector && nav.reason === 'nav') {
        const t = document.getElementById('bf-title') || document.getElementById('ph-name');
        if (t) { if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1'); t.focus({ preventScroll: true }); claimFocus(); }
      }
      return;
    }
    claimFocus();
    let tries = 0;
    const find = () => (run && document.querySelector(`#run-card-${CSS.escape(run)}`)) || (open && document.querySelector(`[data-key="${open}"]`)) || null;
    const go = () => {
      const el = find();
      if (!el) {
        if (tries++ < 60) requestAnimationFrame(go);
        return;
      }
      if (el.tagName === 'DETAILS') el.open = true;
      if (run) { const det = document.querySelector(`[data-key="pb-runs"]`); if (det && det.tagName === 'DETAILS') det.open = true; const rd = document.querySelector(`[data-key="run-${CSS.escape(run)}"]`); if (rd && rd.tagName === 'DETAILS') rd.open = true; }
      el.scrollIntoView({ block: 'start' });
      const head = (run && el.querySelector(`[data-key="run-${CSS.escape(run)}"] > summary`)) || el.querySelector(':scope > summary') || el;
      if (head === el && !el.hasAttribute('tabindex') && !['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) el.setAttribute('tabindex', '-1');
      head.focus({ preventScroll: true });
    };
    requestAnimationFrame(go);
  }, [Boolean(d), pid, tab, route.query.toString()]);

  // The opinion this page shows: the record must hold the report the list
  // names for the chosen model (an explicitly chosen report is immutable and
  // needs no check); a comparison needs every model to agree.
  const latest = d ? Object.fromEntries(PROVIDERS.map((x) => [x, d.comparison && d.comparison.latest && d.comparison.latest[x] ? d.comparison.latest[x].report_id : null])) : {};
  const providerOf = (rid) => { const r = d ? d.reports.find((x) => x.report_id === rid) : null; return r && r.meta ? r.meta.provider : null; };
  const agrees = (x) => {
    if (!d || !row.project_id) return true;
    const o = opinionOf(row, x, d);
    return o.status === 'none' ? !latest[x] : o.status === 'ok' && latest[x] === o.report_id;
  };
  const waiting = d ? (tab === 'compare' ? Boolean(row.project_id) && !opinionsAgree(row, d) : (tab === 'brief' || tab === 'evidence') && !reportId && !agrees(prov)) : false;
  const waitKey = tab === 'compare' ? 'all' : (row.providers && row.providers[prov] && row.providers[prov].report_id) || 'none';
  useEffect(() => {
    if (waiting && current) resyncOnce(pid, waitKey);
  }, [waiting, current, pid, waitKey]);
  // On a phone a project opened from the inspector has its back bar in place
  // of the top bar.
  useLayoutEffect(() => {
    const on = Boolean(d) && fromInspector;
    document.documentElement.classList.toggle('has-backbar', on);
    return () => document.documentElement.classList.remove('has-backbar');
  }, [Boolean(d), fromInspector]);

  if (!d) {
    return (
      <div className="pp">
        <nav className="crumbs" aria-label="Breadcrumb"><a href={`#/watchlist?p=${enc(pid)}`}>Desk</a></nav>
        {error ? (
          <div className="note note-bad pp-error" role="alert">
            <span>{`Could not load project "${pid}": ${error.message}`}</span>
            <button type="button" className="btn btn-sm" data-key="project-retry" onClick={retry}>Try again</button>
          </div>
        ) : <div className="page-loading" role="status"><span className="sr-only">Loading the project…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>}
      </div>
    );
  }

  const p = d.project;
  const sel = selectionOf(tab, route.query, { latest, providerOf });
  // Counts beside the sections: the chosen report's claims, the reports and
  // the research runs on record.
  const chosen = d.reports.find((r) => !r.broken && r.report_id === (reportId || latest[prov])) || null;
  const COUNTS = {
    evidence: chosen && chosen.assessment && Array.isArray(chosen.assessment.claims) ? chosen.assessment.claims.length : null,
    report: d.reports.length || null,
    record: (d.research && d.research.runs ? d.research.runs.length : 0) || null,
  };
  const COUNT_WORDS = { evidence: 'claims', report: 'reports', record: 'research runs' };
  const navTab = tab === 'compare' ? 'brief' : tab;
  const tabLink = (t, label) => {
    const href = sectionHref(pid, t, sel, { latest });
    const count = COUNTS[t];
    return (
      <a
        key={t}
        href={href}
        id={`tab-${t}`}
        className="tab"
        aria-current={t === navTab ? 'page' : undefined}
        data-key={`tab-${t}`}
        onClick={(e) => {
          if (!plain(e) || !(history.state && history.state.crBrief === pid)) return;
          e.preventDefault();
          if (t === tab) return;
          const now = history.state;
          navigate(href, { state: { ...now, crDepth: (Number(now.crDepth) || 1) + 1 } });
        }}
      >
        {label}{count ? <span className="tab-count" aria-label={`, ${count} ${COUNT_WORDS[t]}`}>{count}</span> : null}
      </a>
    );
  };
  const barLabel = tab === 'compare' ? 'Compare' : MODEL_VIEWS.includes(tab) ? `${PROVIDER_LABELS[prov]} · ${(PROJECT_TABS.find(([t]) => t === tab) || [null, 'Brief'])[1]}` : (PROJECT_TABS.find(([t]) => t === tab) || [null, ''])[1];
  const from = st && st.crBrief === pid ? st.from : null;

  const stuck = waiting && current && wasResynced(pid, waitKey);
  const wait = (
    <div className="pp-wait">
      {stuck ? (
        <div className="note note-warn" role="status">
          <span>The list and this project's record name different reports. Nothing from another report is shown in their place.</span>
          <button type="button" className="btn btn-sm" data-key="pp-resync" onClick={() => refresh().catch((err) => toast(err.message, 'bad'))}>Read again</button>
        </div>
      ) : <div className="page-loading" role="status"><span className="sr-only">Loading the report…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>}
    </div>
  );
  const props = { d, row, pid, prov, reportId, route, current };
  let body;
  if (waiting) {
    body = wait;
  } else if (tab === 'brief') {
    body = (
      <>
        <CheckIn key={pid} d={d} current={current} row={row} pid={pid} />
        <div id="pb-model" role="tabpanel" aria-labelledby={`pb-tab-${prov}`}>
          <Brief m={m} d={d} row={row} pid={pid} staleDays={staleDays} />
        </div>
        <details className="fold page-fold" data-key="pb-scorecard" title="Three separate panels, never mixed: the category grades are diagnostics and are never averaged into the grade; the grade comes from six weighted components; the downside-risk scores are higher-is-worse.">
          <summary>{`Full scorecard · ${PROVIDER_LABELS[prov]}`}</summary>
          <Dom className="lg-view-part" build={(L) => { const lt = L.latestReports(d); return lt[prov] ? L.scorecardBody(legacyCtx, d, lt, prov) : L.h('p', { class: 'small muted' }, `No gradable ${PROVIDER_LABELS[prov]} report yet.`); }} deps={[d, prov]} />
        </details>
      </>
    );
  } else if (tab === 'compare') {
    body = <div id="pb-model" role="tabpanel" aria-labelledby="pb-tab-compare"><Compare {...props} /></div>;
  } else if (tab === 'evidence') {
    body = <div id="pb-model" role="tabpanel" aria-labelledby={`pb-tab-${prov}`}><Evidence {...props} m={m} /></div>;
  } else if (tab === 'forensics') {
    body = <Forensics pid={pid} receipt={route.query.get('receipt') || null} />;
  } else if (tab === 'report') {
    body = <div id="pb-model" role="tabpanel" aria-labelledby={`pb-tab-${prov}`}><Report {...props} /></div>;
  } else if (tab === 'market') {
    body = <Market {...props} />;
  } else if (tab === 'contract') {
    body = <Contract {...props} />;
  } else if (tab === 'record') {
    body = <Record {...props} />;
  } else {
    body = <Notes {...props} />;
  }

  return (
    <div className={`pp pp-${tab}${MODEL_VIEWS.includes(tab) ? ' pb-view' : ''}`}>
      {fromInspector ? (
        <div className="backbar">
          <a className="btn btn-ghost btn-sm backbar-back" href={`#/watchlist?p=${enc(pid)}`} data-key="brief-back" aria-label={`Close the full research and return to ${from === 'project' ? `the ${p.name} page` : 'the Desk'}`} title="Back (Esc)" onClick={(e) => { if (!plain(e)) return; e.preventDefault(); closeBrief(pid); }}>
            <ArrowLeft size={15} aria-hidden="true" /><span>{from === 'project' ? 'Project' : 'Desk'}</span>
          </a>
          <span className="backbar-t" aria-hidden="true"><span className="faint">{barLabel}</span></span>
          <WsTag />
          {m && m.report_id && !waiting && tab === 'brief' ? <a className="btn btn-sm" href={sectionHref(pid, 'report', { model: prov, report: m.report_id }, { latest })} data-key="brief-report">Full report</a> : null}
        </div>
      ) : (
        <nav className="crumbs" aria-label="Breadcrumb"><a href={`#/watchlist?p=${enc(pid)}`} data-key="crumb-watchlist">Desk</a><span aria-hidden="true">/</span><span aria-current="page">{p.name}</span></nav>
      )}
      <Header d={d} row={row} phone={phone} />
      {MODEL_VIEWS.includes(tab) ? <ModelSwitcher row={row} sel={prov} tab={tab} pid={pid} /> : null}
      <nav className="tabs pp-tabs" aria-label="Project sections">
        {PROJECT_TABS.map(([t, label]) => tabLink(t, label))}
      </nav>
      {/* Each section mounts its own parts: two sections with equal inputs
          would otherwise share one part and keep the first one drawn. */}
      <div id="tabpanel" className="pp-panel"><Fragment key={tab}>{body}</Fragment></div>
    </div>
  );
}
