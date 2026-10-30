// PM decisions waiting for you (Eric, 2026-10-26, after the platform's card
// grid; the Architecture restyle, 2026-10-29): one card per project whose
// ticket waits for your decision (pending_pm_review or reopened, not yet
// decided), from the index row's ticket summary. Each card: the logo, the
// name and its ticker, the proposal as the card's one tinted badge, the
// Prosecutor's one-line thesis (or a quiet "No thesis" when the ticket has
// none), the grade (your headline else Claude's, D1; never averaged) over a
// 3px bar on the 0–100 scale, and the suggested risk as the desk sized it.
// Cards are grouped by proposal, Trim / exit first and then the others, each
// group in the desk's own order; Hard pass folds into one row that shows
// them on a click. Which tickets are cards is the attention contract's
// (public/attention-model.js decisionsOf, cr-attention@1), the Review
// queue's and the Daily Brief's own rule: a desk gate closed at $0 on a
// token Eric does not hold is not a card, only a quiet "Closed by the desk"
// count that opens the list (subtraction stage 3). Its two ways in, Open Inspector and Read Full Report, show
// over the card on hover and focus, and under it on a touch screen. The
// cards decide nothing: the decisions and their `seen` guard live in the
// inspector only.
import { useState } from 'react';
import { ArrowRight, PanelRight } from 'lucide-react';
import { canonicalGrade } from '../../../../public/watchlist-model.js';
import { riskWords } from '../../../../public/pm-card-model.js';
import { decisionsOf } from '../../../../public/attention-model.js';
import { Logo } from '../../components/Logo.jsx';
import { navigate } from '../../lib/router.js';
import { openPanel } from './state.js';

const enc = encodeURIComponent;
const TYPE_WORDS = { ACCUMULATE: 'Accumulate', LIMIT_TRAP: 'Limit trap', TRIM_EXIT: 'Trim / exit', WATCH_ONLY: 'Watch only', HARD_PASS: 'Hard pass' };
const TYPE_TONE = { ACCUMULATE: 'is-ok', LIMIT_TRAP: 'is-info', TRIM_EXIT: 'is-warn', WATCH_ONLY: '', HARD_PASS: 'is-bad' };
// The groups in the order they show; anything else follows them.
const GROUPS = ['TRIM_EXIT', 'ACCUMULATE', 'LIMIT_TRAP', 'WATCH_ONLY'];

export function waitingTickets(rows) {
  return decisionsOf(rows).cards;
}

// The waiting tickets grouped by proposal, each group in the order given.
export function decisionGroups(waiting) {
  const rank = (p) => { const i = GROUPS.indexOf(p.ticket.proposal_type); return i === -1 ? GROUPS.length : i; };
  const shown = waiting.filter((p) => p.ticket.proposal_type !== 'HARD_PASS');
  const order = shown.map((p, i) => [rank(p), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  return { shown: order, hardPass: waiting.filter((p) => p.ticket.proposal_type === 'HARD_PASS') };
}

export function DecisionGrid({ d, rows }) {
  const waiting = waitingTickets(rows);
  const closed = decisionsOf(rows).closed;
  const { shown, hardPass } = decisionGroups(waiting);
  const [showPass, setShowPass] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  return (
    <section className="dgrid-wrap" aria-labelledby="dgrid-h">
      <p className="eyebrow">PM decisions</p>
      <h2 className="sec-h card-title" id="dgrid-h">{waiting.length ? `${waiting.length} ${waiting.length === 1 ? 'decision waits' : 'decisions wait'}` : 'No decisions wait'}<span className="sr-only"> for you</span></h2>
      {waiting.length ? (
        <>
          {shown.length ? (
            <ul className="dgrid">
              {shown.map((p) => <DecisionTile key={p.project_id} d={d} p={p} />)}
            </ul>
          ) : null}
          {hardPass.length ? (
            <div className="dgrid-fold">
              <button type="button" className="act dgrid-fold-btn" aria-expanded={showPass} aria-controls="dgrid-pass" data-key="dgrid-hard-pass" onClick={() => setShowPass((v) => !v)}>
                <span className="badge is-bad">{`${hardPass.length} Hard pass`}</span>
                <span>{showPass ? 'Hide' : 'Show'}</span>
              </button>
              {showPass ? (
                <ul className="dgrid" id="dgrid-pass">
                  {hardPass.map((p) => <DecisionTile key={p.project_id} d={d} p={p} />)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      ) : <p className="dgrid-none">No tickets wait for you</p>}
      {closed.length ? (
        <div className="dgrid-closed">
          <button type="button" className="act dgrid-fold-btn" aria-expanded={showClosed} aria-controls="dgrid-closed" data-key="dgrid-closed" onClick={() => setShowClosed((v) => !v)}>
            <span>{`Closed by the desk (${closed.length})`}</span>
          </button>
          {showClosed ? (
            <ul className="dgrid-closed-list" id="dgrid-closed">
              {closed.map((p) => (
                <li key={p.project_id}>
                  <button type="button" className="act" data-key={`dgrid-closed-${p.project_id}`} onClick={(e) => openPanel(p.project_id, e.currentTarget)}>{p.name}</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// The grade's place on the 0–100 bar: a point for a grade, a span for a
// range, nothing for anything else (a withheld grade has no place on it).
function gradeBar(g) {
  const gr = g.report && g.report.grade;
  if (!gr) return null;
  const clamp = (n) => Math.max(0, Math.min(100, n));
  if (g.kind === 'grade' && typeof gr.value === 'number') return { left: 0, width: clamp(gr.value) };
  if (g.kind === 'range' && typeof gr.low === 'number' && typeof gr.high === 'number') return { left: clamp(gr.low), width: clamp(gr.high) - clamp(gr.low) };
  return null;
}

function DecisionTile({ d, p }) {
  const t = p.ticket;
  const g = canonicalGrade(p, d.index);
  const src = g.source === 'headline' ? 'Your headline' : 'Claude';
  const type = TYPE_WORDS[t.proposal_type] || String(t.proposal_type || 'Ticket').replace(/_/g, ' ');
  const risk = riskWords(t);
  const pid = p.project_id;
  const report = `#/project/${enc(pid)}/report`;
  const graded = g.kind === 'grade' || g.kind === 'range';
  const bar = gradeBar(g);
  return (
    <li className="dcard" data-pid={pid}>
      <div className="dcard-top">
        <span className="dcard-tile"><Logo p={p} size={32} /></span>
        <span className="dcard-id">
          <span className="dcard-name">{p.name}</span>
          <span className="dcard-sym">{p.symbol || p.name}</span>
        </span>
        <span className={`badge is-tint ${TYPE_TONE[t.proposal_type] || ''}`}>{type}</span>
      </div>
      {/* Two lines on every card (L4); the whole sentence stays in the page
          for screen readers and shows in full as its tooltip. */}
      {t.non_consensus_thesis ? <p className="dcard-thesis" title={t.non_consensus_thesis}>{t.non_consensus_thesis}</p> : <p className="dcard-thesis is-none" title="No thesis on the ticket">No thesis</p>}
      <div className="dcard-grade">
        <span className="dcard-k">{`${src} grade`}</span>
        <span className="dcard-v" title={graded || g.kind === 'withheld' ? undefined : 'No eligible grade on file'}>{graded ? g.value : g.kind === 'withheld' ? 'Withheld' : '—'}</span>
        <span className="dcard-bar" aria-hidden="true">{bar ? <span style={{ left: `${bar.left}%`, width: `${bar.width}%` }} /> : null}</span>
      </div>
      <div className="dcard-figs">
        <span className="dcard-risk" title={risk.title}>
          <span className="dcard-k">Suggested risk</span>
          <span className="dcard-rv">{risk.text}{risk.why ? <span className="dcard-why">{` · ${risk.why}`}</span> : null}</span>
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
