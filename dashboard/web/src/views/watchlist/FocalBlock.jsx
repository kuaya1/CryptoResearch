// The Focal block (UI v3 parity, 2026-10-30, UI_MASTER_PLAYBOOK.md §4.2): the
// Desk's one dark card, in place of the page head, the Daily Brief hero, the
// headline and the PM card grid (D7, D8, D10). Row 1: today's date and the
// desk's mode, Refresh and Add project. Then the headline: how many live
// tickets wait for you, in words to four, and Bitcoin's week when nothing
// does. Then the one ticket to decide first (the PM card grid's own order,
// Trim / exit first) as a row that opens its inspector, and under it the
// folds: the other live tickets, the Hard pass list (proposals of Hard pass
// and tickets the contract gate holds or blocks while it is enforced) and
// what the desk closed, with the PM Cohort's research line at the right.
// Nothing here decides: the decisions and their `seen` guard stay in the
// inspector. Which tickets wait is the attention contract's
// (public/attention-model.js decisionsOf), read through DecisionGrid.jsx.
import { useState } from 'react';
import { deskKpis, waitingJobs } from '../../../../public/watchlist-model.js';
import { riskWords } from '../../../../public/pm-card-model.js';
import { decisionsOf } from '../../../../public/attention-model.js';
import { waitingTickets, decisionGroups } from './DecisionGrid.jsx';
import { RefreshLink } from './StatusStrip.jsx';
import { view, openPanel } from './state.js';

const TYPE_WORDS = { ACCUMULATE: 'Accumulate', LIMIT_TRAP: 'Limit trap', TRIM_EXIT: 'Trim / exit', WATCH_ONLY: 'Watch only', HARD_PASS: 'Hard pass' };
const TYPE_DOT = { ACCUMULATE: 'is-live', LIMIT_TRAP: 'is-amber', TRIM_EXIT: 'is-amber', WATCH_ONLY: 'is-faint', HARD_PASS: 'is-critical' };
const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four'];
const MODEL_NAMES = { claude: 'Claude', chatgpt: 'GPT', openai: 'GPT', gpt: 'GPT', gemini: 'Gemini' };
const RUNNING = new Set(['running', 'dispatching', 'cowork', 'connector']);

// The contract gate on a ticket (cr-contract-gate@1, observe or enforce).
export function gateOf(t) {
  const g = t && t.contract_gate;
  return g && g.tier ? g : null;
}
// A gated ticket: the contract gate holds or blocks it while enforced. In
// observe mode the tier is shown and nothing is gated (§5.1).
export function isGated(p) {
  const g = gateOf(p && p.ticket);
  return Boolean(g && g.mode === 'enforce' && (g.tier === 'block' || g.tier === 'hold'));
}
const GATE_SHORT = { none: ['Gate clear', 'is-ok'], review: ['Gate · review', 'is-warn'], hold: ['Gate · hold', 'is-warn'], block: ['Gate · block', 'is-bad'] };

export function typeWords(t) {
  return TYPE_WORDS[t.proposal_type] || String(t.proposal_type || 'Ticket').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
}
// The exit cost at the ticket's exit size: three places under 1%, one from
// 1%, "≥ " when the reading is a lower bound.
export function exitWords(t) {
  const c = t.exit_cost_500_usd_pct;
  if (typeof c !== 'number' || !Number.isFinite(c)) return 'exit unknown';
  return `exit ${t.exit_cost_500_complete === false ? '≥ ' : ''}${c < 1 ? c.toFixed(3) : c.toFixed(1)}%`;
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '—');
export function ticketMeta(t) {
  const r = t.researcher ? num(t.researcher.grade) : '—';
  const pr = t.prosecution ? num(t.prosecution.conviction_score) : '—';
  return `Risk ${riskWords(t).text} · ${exitWords(t)} · Researcher ${r}, Prosecutor ${pr}`;
}

function headline(n) {
  if (!n) return 'Nothing needs you.';
  const w = n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
  return `${w} ${n === 1 ? 'decision waits' : 'decisions wait'} for you.`;
}

function weekWords(d, agenda) {
  const m = deskKpis(d.index, agenda).market;
  const ch = m && typeof m.change_7d === 'number' ? m.change_7d : null;
  if (ch === null) return null;
  return `Bitcoin is ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(1)}% this week.`;
}

// The PM Cohort's line: the model at work and the next project queued, from
// the research jobs the list already reads; left out when nothing waits.
function cohortWords(d, rows) {
  const jobs = rows.flatMap((p) => waitingJobs(p, d.index).map((j) => ({ ...j, p })));
  if (!jobs.length) return null;
  const run = jobs.find((j) => RUNNING.has(j.key));
  const queued = jobs.find((j) => j.key === 'queued' && (!run || j.p !== run.p));
  const parts = [];
  if (run) parts.push(`${MODEL_NAMES[run.provider] || run.provider} running`);
  if (queued) parts.push(`${queued.p.name} queued`);
  if (!parts.length) parts.push(`${jobs.length} waiting`);
  return `PM Cohort · ${parts.join(', ')}`;
}

function dateLine() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
}

function GateShort({ t }) {
  const g = gateOf(t);
  const [words, tone] = g ? GATE_SHORT[g.tier] || [`Gate · ${g.tier}`, 'is-warn'] : ['Gate · not attested', 'is-warn'];
  return <span className={`v3-fgate ${tone}`}><span className="v3-gdot" aria-hidden="true" />{words}</span>;
}

function TicketRow({ p, kind = 'live' }) {
  const t = p.ticket;
  const gated = kind === 'pass';
  const type = gated && t.proposal_type !== 'HARD_PASS' ? 'Hard pass' : typeWords(t);
  const dot = gated ? 'is-critical' : TYPE_DOT[t.proposal_type] || 'is-faint';
  const g = gateOf(t);
  const meta = gated
    ? `${(g && g.words) || (t.gate_reasons && t.gate_reasons[0]) || 'The desk vetoed this ticket.'} Deterministic veto.`
    : kind === 'closed' ? (t.gate_reasons && t.gate_reasons[0]) || 'Closed at $0 by the desk' : ticketMeta(t);
  const status = gated ? (t.proposal_type === 'HARD_PASS' && !isGated(p) ? ['Passed', 'is-faint'] : ['Vetoed by gate', 'is-bad'])
    : kind === 'closed' ? ['Closed by the desk', 'is-faint'] : [t.status === 'reopened' ? 'Re-opened' : 'Waiting', 'is-warn'];
  return (
    <li>
      <button type="button" className="v3-frow" data-key={`focal-row-${p.project_id}`} aria-label={`${p.name}, ${type}: ${status[0]}. Open`} onClick={(e) => openPanel(p.project_id, e.currentTarget)}>
        <span className={`v3-dot is-sm ${dot}`} aria-hidden="true" />
        <span className="v3-fcol">
          <span className="v3-frow-name">{p.name}<span className="v3-ftype">{` · ${type}`}</span></span>
          <span className="v3-fmeta">{meta}</span>
        </span>
        <span className={`v3-fstatus ${status[1]}`}>{status[0]}</span>
        <span className="v3-fopen">Open</span>
      </button>
    </li>
  );
}

export function FocalBlock({ d, rows, agenda, onAdd, options = null }) {
  const waiting = waitingTickets(rows);
  const closed = decisionsOf(rows).closed;
  const { shown, hardPass } = decisionGroups(waiting);
  const live = shown.filter((p) => !isGated(p));
  const pass = [...shown.filter(isGated), ...hardPass];
  const focal = live[0] || null;
  const more = live.slice(1);
  const n = live.length;
  const [open, setOpen] = useState(() => ({ more: Boolean(view.focalMore), pass: Boolean(view.focalPass), closed: Boolean(view.focalClosed) }));
  const flip = (k) => setOpen((o) => {
    const next = { ...o, [k]: !o[k] };
    view.focalMore = next.more; view.focalPass = next.pass; view.focalClosed = next.closed;
    return next;
  });
  const week = n ? 'The rest can wait.' : weekWords(d, agenda);
  const cohort = cohortWords(d, rows);
  const t = focal && focal.ticket;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  return (
    <section className="v3-focal" aria-labelledby="desk-h">
      <div className="v3-focal-top">
        <p className="v3-focal-date">{`${dateLine()} · Paper desk`}</p>
        <div className="v3-focal-acts">
          <RefreshLink d={d} />
          {options}
          <button type="button" className="v3-add" id="add-project-btn" data-key="add-project" onClick={onAdd}>Add project</button>
        </div>
      </div>
      <h1 id="desk-h" className="v3-focal-h">
        {headline(n)}
        {week ? <> <span className="v3-dim">{week}</span></> : null}
      </h1>
      {focal ? (
        <button type="button" className="v3-focal-ticket" data-key={`focal-${focal.project_id}`} aria-label={`Decide ${focal.name}: ${typeWords(t)}`} onClick={(e) => openPanel(focal.project_id, e.currentTarget)}>
          <span className={`v3-dot ${TYPE_DOT[t.proposal_type] || 'is-faint'}`} aria-hidden="true" />
          <span className="v3-fcol">
            <span className="v3-fname">{focal.name}<span className="v3-ftype">{` · ${typeWords(t)}`}</span></span>
            <span className="v3-fmeta">{ticketMeta(t)}</span>
          </span>
          <GateShort t={t} />
          <span className="v3-fgo" aria-hidden="true">Decide →</span>
        </button>
      ) : null}
      {more.length || pass.length || closed.length || cohort ? (
        <div className="v3-folds">
          {more.length ? (
            <button type="button" className="v3-fold-btn" aria-expanded={open.more} aria-controls="focal-more-list" data-key="focal-more" onClick={() => flip('more')}>
              {`${open.more ? 'Hide ' : ''}${plural(more.length, 'more ticket', 'more tickets')}`}
            </button>
          ) : null}
          {pass.length ? (
            <button type="button" className="v3-fold-btn" aria-expanded={open.pass} aria-controls="focal-pass-list" data-key="dgrid-hard-pass" onClick={() => flip('pass')}>
              <span className="v3-gdot is-bad-fill" aria-hidden="true" />
              {`${open.pass ? 'Hide ' : ''}${pass.length} Hard pass`}
            </button>
          ) : null}
          {closed.length ? (
            <button type="button" className="v3-fold-btn" aria-expanded={open.closed} aria-controls="focal-closed-list" data-key="dgrid-closed" onClick={() => flip('closed')}>
              {`Closed by the desk (${closed.length})`}
            </button>
          ) : null}
          <span className="v3-spacer" />
          {cohort ? <span className="v3-cohort">{cohort}</span> : null}
        </div>
      ) : null}
      {open.more && more.length ? <ul className="v3-flist" id="focal-more-list">{more.map((p) => <TicketRow key={p.project_id} p={p} />)}</ul> : null}
      {open.pass && pass.length ? <ul className="v3-flist" id="focal-pass-list">{pass.map((p) => <TicketRow key={p.project_id} p={p} kind="pass" />)}</ul> : null}
      {open.closed && closed.length ? <ul className="v3-flist" id="focal-closed-list">{closed.map((p) => <TicketRow key={p.project_id} p={p} kind="closed" />)}</ul> : null}
    </section>
  );
}
