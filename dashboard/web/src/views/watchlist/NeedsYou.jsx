// Needs you (Desk v2, Eric, 2026-10-28, design_handoff_desk_redesign §2c):
// the Daily Brief's readiness and the PM tickets in one dark card, the
// highest-contrast part of the Desk. Its head is the readiness in words, read
// from GET /api/brief/daily (a section the desk could not read says Unknown),
// and opens the Daily Brief. One row per ticket that waits for your decision
// (pending or re-opened, undecided), then any decided in the last day with
// its outcome: a dot in the proposal's colour, the name and proposal, the
// suggested risk, the exit cost and the two agents' figures side by side
// (never averaged), the status in words, and Decide. A row opens the
// project's inspector; the decisions and their `seen` guard live there only.
// Nothing here starts research, the pilot or a paid call; reading writes nothing.
import { readiness } from '../../../../public/daily-brief-model.js';
import { riskWords } from '../../../../public/pm-card-model.js';
import { useBriefRead } from '../../lib/brief.js';
import { openBrief } from '../../shell/overlays.js';
import { openPanel } from './state.js';

export const TYPE_WORDS = { ACCUMULATE: 'Accumulate', LIMIT_TRAP: 'Limit trap', TRIM_EXIT: 'Trim / exit', WATCH_ONLY: 'Watch only', HARD_PASS: 'Hard pass' };
export const TYPE_TONE = { ACCUMULATE: 'ok', LIMIT_TRAP: 'warn', TRIM_EXIT: 'warn', WATCH_ONLY: 'unknown', HARD_PASS: 'bad' };
const DAY_MS = 24 * 3600 * 1000;
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const usd0 = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

const waits = (p) => p.status !== 'archived' && p.ticket && !p.ticket.unavailable && !p.ticket.decision && ['pending_pm_review', 'reopened'].includes(p.ticket.status);
export function waitingTickets(rows) {
  return rows.filter(waits);
}
// A ticket decided in the last day keeps its row, with the outcome in words.
function recentlyDecided(rows, now = Date.now()) {
  return rows.filter((p) => p.status !== 'archived' && p.ticket && !p.ticket.unavailable && p.ticket.decision && p.ticket.decision.at && now - Date.parse(p.ticket.decision.at) < DAY_MS);
}

// "Two decisions wait for you." (spelled out to ten), "Nothing needs you." at zero.
export function decisionsHeadline(n) {
  if (!n) return 'Nothing needs you.';
  const w = n <= 10 ? NUMBER_WORDS[n] : String(n);
  return `${w} decision${n === 1 ? ' waits' : 's wait'} for you.`;
}

export function exitWords(t) {
  if (t.exit_basis === 'native_l1_liquid') return 'native L1';
  if (typeof t.exit_cost_500_usd_pct !== 'number') return 'no reading';
  return `${t.exit_cost_500_complete ? '' : '≥ '}${t.exit_cost_500_usd_pct}%`;
}

// The status in words and its tone (night colours): waiting is amber, a
// grant is green, everything else plain.
export function ticketStatus(t) {
  const d = t.decision;
  if (!d) return t.status === 'reopened' ? { text: 'Re-opened', tone: 'wait' } : { text: 'Waiting', tone: 'wait' };
  const granted = typeof t.pm_approved_risk_usd === 'number' ? t.pm_approved_risk_usd : null;
  if (d.action === 'approve' || d.action === 'halve') return { text: `Approved${granted !== null ? ` · ${usd0(granted)}` : ''}`, tone: 'ok' };
  const words = { veto: 'Vetoed', pass: 'Passed', watch: 'Watching', trim: 'Trim acknowledged', reopen: 'Re-opened' };
  return { text: words[d.action] || 'Decided', tone: '' };
}

function metaOf(t) {
  const dis = t.agent_disagreement || {};
  const r = dis.researcher || t.researcher || {};
  const q = dis.prosecutor || {};
  const parts = [`Risk ${riskWords(t).text}`, `exit ${exitWords(t)}`];
  const res = r.grade_display || r.grade;
  if (res || typeof q.conviction_score === 'number') parts.push(`Researcher ${res || '—'}, Prosecutor ${q.conviction_score ?? '—'}`);
  return parts.join(' · ');
}

function BriefLine() {
  const { view, error } = useBriefRead();
  const loading = !view && !error;
  const rows = readiness(view);
  const words = loading ? 'Reading the Daily Brief…' : rows.map((r) => `${r.title} ${r.n ? r.words : r.words.charAt(0).toLowerCase() + r.words.slice(1)}`).join(' · ');
  return (
    <button type="button" className="ny-brief" data-key="hero-brief" aria-label={`Open Daily Brief. ${words}`} title={rows.filter((r) => r.why).map((r) => `${r.title}: ${r.why}`).join('\n') || 'Open Daily Brief'} onClick={() => openBrief()}>
      {words}
    </button>
  );
}

export function NeedsYou({ rows, selected = null }) {
  const waiting = waitingTickets(rows);
  const shown = [...waiting, ...recentlyDecided(rows)];
  return (
    <section className="needs-you" aria-labelledby="ny-h">
      <div className="ny-head">
        <h2 className="ny-h" id="ny-h">Needs you</h2>
        <BriefLine />
      </div>
      {shown.length ? (
        <ul className="ny-list">
          {shown.map((p) => {
            const t = p.ticket;
            const type = TYPE_WORDS[t.proposal_type] || String(t.proposal_type || 'Ticket').replace(/_/g, ' ');
            const st = ticketStatus(t);
            const meta = metaOf(t);
            const open = p.project_id === selected;
            return (
              <li key={p.project_id} data-pid={p.project_id}>
                <button type="button" className="ny-row" data-key={`dcard-open-${p.project_id}`} aria-label={`${p.name}, ${type}: ${st.text}. ${meta}. Open Inspector`} aria-expanded={open} onClick={(e) => openPanel(p.project_id, e.currentTarget)}>
                  <span className={`ny-dot tone-${TYPE_TONE[t.proposal_type] || 'unknown'}`} aria-hidden="true" />
                  <span className="ny-main" aria-hidden="true">
                    <span className="ny-name">{p.name}<span className="ny-type">{` · ${type}`}</span></span>
                    <span className="ny-meta" title={t.non_consensus_thesis || meta}>{meta}</span>
                  </span>
                  <span className={`ny-st is-${st.tone || 'plain'}`} aria-hidden="true">{st.text}</span>
                  <span className="ny-go" aria-hidden="true">{open ? 'Open' : st.tone === 'wait' ? 'Decide →' : 'View →'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="ny-none">No tickets wait for you</p>}
    </section>
  );
}
