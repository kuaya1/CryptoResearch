// One page per project (#/project/<id>/<tab>): the identity and the market
// now in the header (with its own time, apart from any research date), then
// Overview (the default, at the address "brief"), Compare, Evidence, Full
// report, Market and Notes. Opened from the inspector (its Claude Brief
// link), a back bar, Back and Escape return there with the list's filters,
// place and focus, also after moving between the project's tabs. Drawing a
// view never fetches prices, screens, posts or starts research; the actions
// are explicit buttons.
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ellipsis, Check, Play } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABELS, fmtDate, fmtDateTime, fmtAgo, fmtAsOf, fmtSignedPct, onHoldOf, toast } from '../../../../public/ui.js';
import { briefModel, marketNow } from '../../../../public/brief-model.js';
import { PROJECT_TABS } from '../../../../public/project-routes.js';
import { useDesk, useProject, useMedia } from '../../lib/hooks.js';
import { api, refresh, hosted } from '../../lib/desk.js';
import { nav, navigate, pageReady, claimFocus, hrefWith } from '../../lib/router.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { Logo } from '../../components/Logo.jsx';
import { Change, UnknownFigure } from '../../components/figures.jsx';
import { GradePill, pillInfo } from '../../components/GradePill.jsx';
import { Menu, MenuItem } from '../../components/Menu.jsx';
import { Dom, loadLegacy } from '../../components/Dom.jsx';
import { badgeOpts } from '../watchlist/ProjectTable.jsx';
import { archiveProject, restoreProject, setWatching } from '../watchlist/state.js';
import Overview from './Overview.jsx';

const enc = encodeURIComponent;
const BRIEF_VIEWS = ['brief', 'compare', 'evidence'];
// Each view's folded sections, by the name an address opens them with.
const FOLDS = {
  brief: { scorecard: 'pb-scorecard', headline: 'pb-headline' },
  evidence: { checks: 'brief-ev-checks', claims: 'pb-claims', technical: 'pb-technical', runs: 'pb-runs', identity: 'pb-identity' },
};
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// Leaving a brief opened from the inspector: back to that entry (all the way,
// past the project's own tabs), else to the project in the watchlist.
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
  const id = p.identity;
  const sector = d.sector || p.sector;
  const archived = p.status === 'archived';
  const watching = Boolean(p.watchlist && p.watchlist.on_watchlist);
  const projectish = { ...row, ...p, research: row.research, report_count: d.reports.length, on_watchlist: watching };
  const runResearch = async () => {
    const L = await loadLegacy();
    L.openResearchDialog(legacyCtx, projectish);
  };
  const toggleWatch = async () => { await setWatching(projectish, !watching); toast('Watchlist updated'); };
  return (
    <header className="ph">
      <div className="ph-id">
        <Logo p={{ ...row, project_id: p.project_id, name: p.name, symbol: p.symbol }} size={40} />
        <div className="ph-names">
          <h1>{p.name}{p.symbol ? <span className="ph-ticker">{` ${p.symbol}`}</span> : null}</h1>
          <MarketFacts row={row} />
          <p className="ph-meta">
            {sector ? <button type="button" className="btn-link" data-key="project-sector" aria-label={`Sector: ${sector.label || sector.primary}. Change sector`} onClick={async () => { const L = await loadLegacy(); L.openSectorDialog(legacyCtx, { ...projectish, sector }); }}>{sector.label || sector.primary}</button> : null}
            <a href={`#/project/${enc(p.project_id)}/evidence?open=identity`} title={(id.unknowns || []).join(' ') || 'Token identity, contracts and evidence'} data-key="project-identity">{id.status === 'verified' ? 'Identity verified' : `Identity ${id.status}`}</a>
            {d.position && !d.position.closed ? <span className="pill pill-accent">Held</span> : null}
            {id.official_website ? <a href={id.official_website} target="_blank" rel="noopener noreferrer nofollow" className="wrap-anywhere">{id.official_website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a> : null}
          </p>
        </div>
        {phone ? (
          <Menu label={`Actions for ${p.name}`} align="end" trigger={<button type="button" className="btn btn-ghost btn-icon ph-more" aria-label={`Actions for ${p.name}`} data-key="project-more"><Ellipsis size={18} aria-hidden="true" /></button>}>
            {archived ? null : <MenuItem data-key="project-menu-research" onSelect={runResearch}>Run research…</MenuItem>}
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
          {archived ? null : <button type="button" className="btn" aria-pressed={watching} data-key="project-watch" title={watching ? 'On your watchlist. Click to stop watching.' : 'Add to your watchlist'} onClick={toggleWatch}>{watching ? <><Check size={14} aria-hidden="true" />Watching</> : 'Watch'}</button>}
          <button type="button" className="btn btn-ghost" data-key={archived ? 'project-restore' : 'project-archive'} title={archived ? 'Bring it back as it was, with its history' : 'Off your lists; nothing is deleted. Undo right after.'} onClick={() => (archived ? restoreProject(projectish) : archiveProject(projectish))}>{archived ? 'Restore' : 'Archive'}</button>
        </div>
      )}
    </header>
  );
}

// What changed since your last review: one line naming the changes, the list
// one tap away (the full history is on Notes), with Mark reviewed.
function Digest({ d, pid }) {
  const [busy, setBusy] = useState(false);
  const ch = d.changes || {};
  const n = (k, one, many = `${one}s`) => (k ? `${k} ${k === 1 ? one : many}` : null);
  const grades = (ch.provider_changes || []).filter((c) => c.from_report);
  const words = [n((ch.new_reports || []).length, 'new report'), n(grades.length, 'grade change'), n((ch.research_runs || []).length, 'research run'), ch.price && typeof ch.price.change_pct === 'number' ? `price ${fmtSignedPct(ch.price.change_pct)}` : null].filter(Boolean);
  const since = ch.since ? `Since ${ch.cursor_source === 'project created' ? 'the project was added' : fmtDateTime(ch.since)}. A digest never changes grades, reports or your headline.` : undefined;
  const mark = async () => {
    setBusy(true);
    try {
      await api.post(`/api/projects/${enc(pid)}/reviewed`, {});
      toast('Marked reviewed. New changes are counted from now.');
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  // On a phone the line is just the changes (the label stays for screen
  // readers), so it keeps to one line beside Mark reviewed.
  const head = <span className="dg-t"><strong id="pb-digest-h" className="dg-label">Since your last review</strong><span className="faint"><span className="dg-sep">{' · '}</span>{words.length ? words.join(', ') : 'nothing new'}</span></span>;
  return (
    <section className={`digest${ch.item_count ? ' has' : ''}`} aria-labelledby="pb-digest-h" title={since}>
      {ch.item_count ? (
        <details className="dg-d" data-key="pb-digest">
          <summary>{head}</summary>
          <ul className="plain-list">
            {(ch.new_reports || []).map((r) => <li key={r.report_id || `${r.provider}${r.analysis_at}`}>{`New ${PROVIDER_LABELS[r.provider]} report (${fmtDate(r.analysis_at)}): ${r.verdict || 'no verdict'}`}</li>)}
            {grades.map((c) => <li key={`${c.provider}-${c.from_report}`}>{`${PROVIDER_LABELS[c.provider]} grade ${c.grade_from || 'none'} → ${c.grade_to || 'none'}${c.verdict_from !== c.verdict_to ? `; verdict ${c.verdict_from || 'none'} → ${c.verdict_to || 'none'}` : ''}`}</li>)}
            {(ch.research_runs || []).map((r) => <li key={r.run_id || r.created_at}>{`Research run ${String(r.status).replace(/_/g, ' ')} (${r.providers.map((x) => PROVIDER_LABELS[x]).join(', ')})`}</li>)}
            {ch.price && typeof ch.price.change_pct === 'number' ? <li>{`Price ${fmtSignedPct(ch.price.change_pct)} since then`}</li> : null}
            <li className="dg-all"><a href={`#/project/${enc(pid)}/notes`} data-key="pb-all-changes">All changes</a></li>
          </ul>
        </details>
      ) : <p className="dg-d none">{head}</p>}
      {ch.item_count ? <button type="button" className="btn btn-sm" data-key="ov-reviewed" disabled={busy} onClick={mark}>Mark reviewed</button> : null}
    </section>
  );
}

function ModelTabs({ row, sel }) {
  const desk = useDesk();
  const go = (prov) => {
    navigate(hrefWith({ model: prov, report: null, open: null, run: null }), { replace: true, state: history.state });
    requestAnimationFrame(() => { const t = document.querySelector(`[data-key="pb-tab-${prov}"]`); if (t) t.focus({ preventScroll: true }); });
  };
  return (
    <div className="ptabs" role="tablist" aria-label="Model" onKeyDown={(e) => {
      const i = PROVIDERS.indexOf(sel);
      const to = e.key === 'ArrowRight' ? PROVIDERS[(i + 1) % 3] : e.key === 'ArrowLeft' ? PROVIDERS[(i + 2) % 3] : e.key === 'Home' ? PROVIDERS[0] : e.key === 'End' ? PROVIDERS[2] : null;
      if (!to) return;
      e.preventDefault();
      if (to !== sel) go(to);
    }}>
      {PROVIDERS.map((prov) => {
        const rep = row.providers && row.providers[prov];
        const job = row.research && row.research.providers && row.research.providers[prov];
        const opts = badgeOpts(desk, prov);
        const info = pillInfo(prov, rep, job, opts);
        const on = prov === sel;
        const verdict = rep && rep.verdict ? `${rep.verdict.charAt(0)}${rep.verdict.slice(1).toLowerCase().replace(/_/g, ' ')}` : null;
        return (
          <button key={prov} type="button" role="tab" id={`pb-tab-${prov}`} className="ptab" aria-selected={on} aria-controls="pb-model" tabIndex={on ? 0 : -1} data-key={`pb-tab-${prov}`} aria-label={`${info.text.replace(/[.\s]+$/, '')}${verdict ? `. Verdict: ${verdict}` : ''}`} title={verdict || undefined} onClick={() => { if (!on) go(prov); }}>
            <span className="ptab-top" aria-hidden="true"><span className="ptab-name">{PROVIDER_LABELS[prov]}</span><GradePill provider={prov} report={rep} job={job} opts={opts} showSub={false} /></span>
            {verdict ? <span className="ptab-verdict" aria-hidden="true">{verdict}</span> : <span className="ptab-verdict faint" aria-hidden="true">{info.kind === 'none' ? 'No report' : ''}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Hosted({ build, deps, after = null }) {
  return <Dom className="lg-view-part" build={(L) => { const node = build(L); if (after) requestAnimationFrame(() => after(node)); return node; }} deps={deps} />;
}

export default function ProjectPage() {
  const d0 = useDesk();
  const route = nav.route;
  const pid = route.args[0];
  const tab = PROJECT_TABS.some(([t]) => t === route.args[1]) ? route.args[1] : 'brief';
  const { d, error } = useProject(pid);
  const phone = useMedia('(max-width: 767.98px)');
  const row = d0.index.projects.find((x) => x.project_id === pid) || {};
  const prov = PROVIDERS.includes(route.query.get('model')) ? route.query.get('model') : 'claude';
  const reportId = route.query.get('report') || null;
  const st = history.state;
  const fromInspector = BRIEF_VIEWS.includes(tab) && st && st.crBrief === pid;
  const staleDays = (d0.index.settings && d0.index.settings.freshness && d0.index.settings.freshness.research_stale_days) || 90;
  const m = useMemo(() => (d && (tab === 'brief' || tab === 'evidence') ? briefModel({ detail: d, row, index: d0.index, provider: prov, reportId, hosted: hosted() }) : null), [d, d0.index, prov, reportId, tab]);

  // Escape leaves a brief opened from the inspector; never while typing or
  // with a dialog or menu open.
  useEffect(() => {
    const onKey = (e) => {
      const r = nav.route;
      if (!r || r.name !== 'project' || e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const s = history.state;
      if (!s || s.crBrief !== r.args[0]) return;
      const t = e.target;
      if (document.querySelector('dialog[open]') || document.querySelector('.menu') || (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)))) return;
      e.preventDefault();
      closeBrief(r.args[0]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // In place: start where Back left it, or at the top; an address that names
  // a folded section (?open=, ?run=) brings it into view once, with focus.
  const open = FOLDS[tab] ? FOLDS[tab][route.query.get('open') || (tab === 'evidence' && route.query.get('run') ? 'runs' : '')] : null;
  const run = tab === 'evidence' ? route.query.get('run') : null;
  useLayoutEffect(() => {
    if (!d) return;
    pageReady();
    if (nav.reason === 'same' || d0.reason === 'live') return;
    if (!open && !run) {
      if (fromInspector && nav.reason === 'nav') {
        const t = document.getElementById('bf-title');
        if (t) { t.focus({ preventScroll: true }); claimFocus(); }
      }
      return;
    }
    claimFocus();
    let tries = 0;
    const find = () => (run && document.querySelector(`#run-card-${CSS.escape(run)}`)) || (open && document.querySelector(`[data-key="${open}"]`)) || null;
    const go = () => {
      const el = find();
      if (!el) {
        if (tries++ < 40) requestAnimationFrame(go);
        return;
      }
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ block: 'start' });
      const head = (run && el.querySelector(`[data-key="run-${CSS.escape(run)}"] > summary`)) || el.querySelector(':scope > summary') || el;
      if (head === el && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      head.focus({ preventScroll: true });
    };
    requestAnimationFrame(go);
  }, [Boolean(d), pid, tab, route.query.toString()]);

  if (!d) {
    return (
      <div className="pp">
        <nav className="crumbs"><a href="#/watchlist">Watchlist</a></nav>
        {error ? <p className="note note-bad">{`Could not load project "${pid}": ${error.message}`}</p> : <div className="page-loading" role="status"><span className="sr-only">Loading the project…</span><span className="skel w60" /><span className="skel w80" /><span className="skel w40" /></div>}
      </div>
    );
  }

  const p = d.project;
  const tabLink = (t, label) => {
    const href = `#/project/${enc(pid)}/${t}`;
    const count = t === 'report' && d.reports.length ? d.reports.length : null;
    return (
      <a
        key={t}
        role="tab"
        href={href}
        id={`tab-${t}`}
        className="tab"
        aria-selected={t === tab}
        aria-controls="tabpanel"
        data-key={`tab-${t}`}
        onClick={(e) => {
          if (!plain(e) || !(history.state && history.state.crBrief === pid)) return;
          e.preventDefault();
          if (t === tab) return;
          const now = history.state;
          navigate(href, { state: { ...now, crDepth: (Number(now.crDepth) || 1) + 1 } });
        }}
      >
        {label}{count ? <span className="tab-count" aria-label={`${count} report${count === 1 ? '' : 's'}`}>{count}</span> : null}
      </a>
    );
  };
  const barLabel = tab === 'compare' ? 'Compare' : tab === 'evidence' ? `${PROVIDER_LABELS[prov]}'s evidence` : `${PROVIDER_LABELS[prov]} Brief`;
  const from = st && st.crBrief === pid ? st.from : null;

  let body;
  if (tab === 'brief') {
    body = (
      <>
        <Digest d={d} pid={pid} />
        <ModelTabs row={row} sel={prov} />
        <div id="pb-model" role="tabpanel" aria-labelledby={`pb-tab-${prov}`}>
          <Overview m={m} d={d} row={row} pid={pid} staleDays={staleDays} />
        </div>
        <details className="fold page-fold" data-key="pb-scorecard" title="Three separate panels, never mixed: the category grades are diagnostics and are never averaged into the grade; the grade comes from six weighted components; the downside-risk scores are higher-is-worse.">
          <summary>{`Full scorecard · ${PROVIDER_LABELS[prov]}`}</summary>
          <Hosted build={(L) => { const latest = L.latestReports(d); return latest[prov] ? L.scorecardBody(legacyCtx, d, latest, prov) : L.h('p', { class: 'small muted' }, `No gradable ${PROVIDER_LABELS[prov]} report yet.`); }} deps={[d, prov]} />
        </details>
        <details className="fold page-fold" data-key="pb-headline" title="The headline is your choice: one report, or one of your own decisions.">
          <summary>Your headline</summary>
          <Hosted build={(L) => L.headlineBody(legacyCtx, d)} deps={[d]} />
        </details>
      </>
    );
  } else if (tab === 'compare') {
    body = <Hosted build={(L) => L.comparePanel(legacyCtx, { d, row, pid, query: route.query })} deps={[d, route.query.toString()]} />;
  } else if (tab === 'evidence') {
    body = (
      <>
        <ModelTabs row={row} sel={prov} />
        <Hosted build={(L) => L.evidenceTab(legacyCtx, d, row, L.latestReports(d), route).node} deps={[d, route.query.toString()]} />
      </>
    );
  } else if (tab === 'report') {
    body = <Hosted build={(L) => L.reportsTab(legacyCtx, d, route)} deps={[d, route.query.toString()]} after={(node) => { const toc = node && node.querySelector && node.querySelector('.report-toc'); if (toc && typeof toc.watch === 'function') toc.watch(); }} />;
  } else if (tab === 'market') {
    body = <Hosted build={(L) => L.marketTab(legacyCtx, d)} deps={[d]} />;
  } else {
    body = <Hosted build={(L) => L.historyTab(legacyCtx, d)} deps={[d]} />;
  }

  return (
    <div className={`pp pp-${tab}${BRIEF_VIEWS.includes(tab) ? ' pb-view' : ''}`}>
      {fromInspector ? (
        <div className="backbar">
          <a className="btn btn-ghost btn-sm backbar-back" href={`#/watchlist?p=${enc(pid)}`} data-key="brief-back" aria-label={`Close the brief and return to ${from === 'project' ? `the ${p.name} page` : 'the watchlist'}`} title="Back (Esc)" onClick={(e) => { if (!plain(e)) return; e.preventDefault(); closeBrief(pid); }}>
            <ArrowLeft size={15} aria-hidden="true" /><span>{from === 'project' ? 'Project' : 'Watchlist'}</span>
          </a>
          <span className="backbar-t" aria-hidden="true"><span className="faint">{barLabel}</span></span>
          {m && m.report_id ? <a className="btn btn-sm" href={`#/project/${enc(pid)}/report?report=${enc(m.report_id)}`} data-key="brief-report">Full report</a> : null}
        </div>
      ) : (
        <nav className="crumbs" aria-label="Breadcrumb"><a href={`#/watchlist?p=${enc(pid)}`} data-key="crumb-watchlist">Watchlist</a><span aria-hidden="true">/</span><span aria-current="page">{p.name}</span></nav>
      )}
      <Header d={d} row={row} phone={phone} />
      <div className="tabs pp-tabs" role="tablist" aria-label="Project sections">
        {PROJECT_TABS.map(([t, label]) => tabLink(t, label))}
      </div>
      <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="pp-panel">{body}</div>
    </div>
  );
}
