// PM decisions waiting for you (Eric, 2026-10-26, after the platform's card
// grid): one card per project whose ticket waits for your decision
// (pending_pm_review or reopened, not yet decided), from the index row's
// ticket summary. Each card: the logo on a 48px tile, ticker and name, the
// proposal as a badge in words, the Prosecutor's one-line thesis, the
// suggested risk as the desk sized it, and the grade (your headline else
// Claude's, D1; never averaged). Its two ways in, Open Inspector and Read
// Full Report, show over the card on hover and focus, and under it on a
// touch screen. The cards decide nothing: the decisions and their `seen`
// guard live in the inspector only.
import { ArrowRight, PanelRight } from 'lucide-react';
import { canonicalGrade } from '../../../../public/watchlist-model.js';
import { Logo } from '../../components/Logo.jsx';
import { navigate } from '../../lib/router.js';
import { openPanel } from './state.js';

const enc = encodeURIComponent;
const TYPE_WORDS = { ACCUMULATE: 'Accumulate', LIMIT_TRAP: 'Limit trap', TRIM_EXIT: 'Trim / exit', WATCH_ONLY: 'Watch only', HARD_PASS: 'Hard pass' };
const TYPE_TONE = { ACCUMULATE: 'is-ok', LIMIT_TRAP: 'is-info', TRIM_EXIT: 'is-warn', WATCH_ONLY: '', HARD_PASS: 'is-bad' };
const usd = (n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

export function waitingTickets(rows) {
  return rows.filter((p) => p.status !== 'archived' && p.ticket && !p.ticket.unavailable && !p.ticket.decision && ['pending_pm_review', 'reopened'].includes(p.ticket.status));
}

export function DecisionGrid({ d, rows }) {
  const waiting = waitingTickets(rows);
  return (
    <section className="dgrid-wrap" aria-labelledby="dgrid-h">
      <h2 className="sec-h" id="dgrid-h">PM decisions<span className="sec-count">{waiting.length}</span></h2>
      {waiting.length ? (
        <ul className="dgrid">
          {waiting.map((p) => <DecisionTile key={p.project_id} d={d} p={p} />)}
        </ul>
      ) : <p className="dgrid-none">No tickets wait for you</p>}
    </section>
  );
}

function DecisionTile({ d, p }) {
  const t = p.ticket;
  const g = canonicalGrade(p, d.index);
  const src = g.source === 'headline' ? 'Your headline' : 'Claude';
  const type = TYPE_WORDS[t.proposal_type] || String(t.proposal_type || 'Ticket').replace(/_/g, ' ');
  const risk = typeof t.suggested_risk_usd === 'number' && t.suggested_risk_usd > 0 ? t.suggested_risk_usd : 0;
  const pid = p.project_id;
  const report = `#/project/${enc(pid)}/report`;
  return (
    <li className="dcard" data-pid={pid}>
      <div className="dcard-top">
        <span className="dcard-tile"><Logo p={p} size={32} /></span>
        <span className="dcard-id">
          <span className="dcard-sym">{p.symbol || p.name}</span>
          <span className="dcard-name">{p.name}</span>
        </span>
        <span className={`badge ${TYPE_TONE[t.proposal_type] || ''}`}>{type}</span>
      </div>
      {t.non_consensus_thesis ? <p className="dcard-thesis">{t.non_consensus_thesis}</p> : null}
      <div className="dcard-figs">
        <span className="dcard-fig">
          <span className="dcard-k">Suggested risk</span>
          <span className="dcard-v">{risk ? usd(risk) : 'None'}</span>
        </span>
        <span className="dcard-fig">
          <span className="dcard-k">{`${src} grade`}</span>
          <span className="dcard-v">{g.kind === 'grade' || g.kind === 'range' ? g.value : g.kind === 'withheld' ? 'Withheld' : '—'}</span>
        </span>
        {t.status === 'reopened' ? <span className="badge is-warn dcard-st">Re-opened</span> : null}
      </div>
      <div className="dcard-over">
        <button type="button" className="btn btn-sm btn-primary" data-key={`dcard-open-${pid}`} aria-label={`Open Inspector: ${p.name}`} onClick={(e) => openPanel(pid, e.currentTarget)}>
          <PanelRight size={14} aria-hidden="true" />Open Inspector
        </button>
        <a className="btn btn-sm" href={report} data-key={`dcard-report-${pid}`} aria-label={`Read Full Report: ${p.name}`} onClick={(e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate(report, { state: { crBrief: pid, from: 'watchlist' } }); }}>
          Read Full Report<ArrowRight size={14} aria-hidden="true" />
        </a>
      </div>
    </li>
  );
}
