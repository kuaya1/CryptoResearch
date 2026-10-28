// The PM Decision Card (2026-10-24, the Junior Trader pipeline): the
// Prosecutor's ticket on Claude's current report, as the desk sized it, with
// Eric's three decisions. Everything shown comes from the index row's ticket
// (core/tickets.js summary): the proposal and levels as the Prosecutor wrote
// them, the exit cost from the desk's own readings, the suggested risk from
// Eric's sizing rules, the two agents' figures side by side (never averaged)
// and the status, read with invalidation against prices and DefiLlama. A
// decision records his choice; nothing here places an order.
import { Children, Fragment, cloneElement, isValidElement, useContext, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import { FootSlot } from './footSlot.js';
import { toast, submissionId, fmtDateTime } from '../../../../public/ui.js';
import { api, refresh } from '../../lib/desk.js';
import { ruleNoteOf, deltaBadgeOf, widestCategoryLink } from '../../../../public/pm-card-model.js';

const enc = encodeURIComponent;
const usd = (n) => (typeof n === 'number' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: n >= 1000 ? 0 : 2, maximumFractionDigits: n < 1 ? 6 : 2 })}` : '—');
const TYPE_WORDS = { ACCUMULATE: 'Accumulate', LIMIT_TRAP: 'Limit trap', TRIM_EXIT: 'Trim / exit', WATCH_ONLY: 'Watch only', HARD_PASS: 'Hard pass' };
const STATUS = {
  pending_pm_review: { word: 'Pending your review', tone: 'is-warn' },
  risk_granted: { word: 'Risk granted', tone: 'is-ok' },
  vetoed: { word: 'Vetoed', tone: '' },
  passed: { word: 'Passed', tone: '' },
  watching: { word: 'Watching', tone: '' },
  trim_acknowledged: { word: 'Trim acknowledged', tone: '' },
  invalidated: { word: 'Invalidated', tone: 'is-bad' },
  reopened: { word: 'Re-opened', tone: 'is-warn' },
};
const VERDICT_WORDS = { thesis_survives: 'thesis survives', thesis_damaged: 'thesis damaged', fatal_flaw: 'fatal flaw' };
const TEST_WORDS = { mercenary_emissions: 'mercenary emissions', tax_revenue: 'tax revenue', exit_slippage: 'exit slippage', unverified_claims: 'unverified claims', other: 'other' };
// Why the grade closed the desk's gate (cr-ticket-pregate@1): a weak grade
// reads differently from a withheld one; an older receipt did not record it.
function gateKindWords(t) {
  if (t.gate_reason_kind === 'grade_low') return 'The grade is under the floor.';
  if (t.gate_reason_kind === 'grade_withheld') {
    const w = t.gate_withheld;
    const left = w && Array.isArray(w.unscored) && w.unscored.length ? ` Not scored: ${w.unscored.map((c) => c.label || c.id).join(', ')}.` : '';
    const share = w && typeof w.scored_pct === 'number' ? ` ${w.scored_pct}% of the weight was scored.` : '';
    return `The grade is withheld, not low: the report left a component unscored.${share}${left}`;
  }
  return 'Why the grade closed it: not recorded.';
}

// The buttons as one flat list (a fragment's buttons are its children).
function flat(children) {
  const out = [];
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    if (c.type === Fragment) out.push(...flat(c.props.children));
    else out.push(c);
  });
  return out;
}

// The decision buttons: in the inspector's sticky footer when there is one
// (FootSlot), else in the card. Same buttons, same handlers either way. In
// the foot (L5, 2026-10-26) the card's solid decision is the one primary
// action and every other decision, with the inspector's Open full research
// and Mark reviewed, sits under More: drawn all the time, shown on demand,
// so no button is removed and none is cut off at 520px.
function Actions({ pid, children }) {
  const slot = useContext(FootSlot);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const items = slot ? flat(children) : [];
  const lead = items.find((c) => String(c.props.className || '').split(/\s+/).includes('btn-primary'));
  const claim = slot && slot.claim;
  useEffect(() => {
    if (!claim || !lead) return undefined;
    claim(true);
    return () => claim(false);
  }, [claim, Boolean(lead)]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); const b = box.current && box.current.querySelector('.pm-more-btn'); if (b) b.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc, true); };
  }, [open]);
  if (!slot) return <div className="pm-actions" data-key={`pm-actions-${pid}`} role="group" aria-label="PM decision">{children}</div>;
  if (!lead) return createPortal(<div className="pm-actions is-foot" data-key={`pm-actions-${pid}`} role="group" aria-label="PM decision">{children}</div>, slot.el);
  const rest = [...items.filter((c) => c !== lead), ...flat(slot.extras)].map((c, i) => cloneElement(c, { key: c.key || `m${i}` }));
  const menuId = `pm-more-${pid}`;
  return createPortal(
    <div className="pm-actions is-foot has-more" data-key={`pm-actions-${pid}`} role="group" aria-label="PM decision" ref={box}>
      {lead}
      {rest.length ? (
        <>
          <button type="button" className="btn btn-sm pm-more-btn" data-key={`pm-more-btn-${pid}`} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((o) => !o)}>More<ChevronDown size={14} aria-hidden="true" /></button>
          <div className="pm-more" id={menuId} role="group" aria-label="More actions" hidden={!open} onClick={(e) => { if (e.target.closest('button, a')) setOpen(false); }}>{rest}</div>
        </>
      ) : null}
    </div>,
    slot.el,
  );
}

const DECIDED_WORDS = { veto: 'Vetoed', pass: 'Pass confirmed', watch: 'Kept on watch', trim: 'Trim acknowledged', reopen: 'Re-opened' };

// Item 52: the Prosecutor's four tests as pills (pass, fail, unknown), each
// opening to its finding and the sources it cites, then the strongest bull
// rebuttal. A test the ticket does not hold reads unknown, never pass.
const TEST_ORDER = ['mercenary_emissions', 'tax_revenue', 'exit_slippage', 'unverified_claims'];
const RESULT_TONE = { pass: 'is-ok', fail: 'is-bad', unknown: 'is-unknown' };
function TestMatrix({ pid, pr }) {
  const [open, setOpen] = useState(null);
  if (!pr) return null;
  const tests = pr.tests || {};
  const resultOf = (k) => (tests[k] && ['pass', 'fail', 'unknown'].includes(tests[k].result) ? tests[k].result : 'unknown');
  const cur = open && tests[open] ? tests[open] : null;
  return (
    <div className="pm-tests" data-key={`pm-tests-${pid}`} aria-label="The Prosecutor's four tests">
      <div className="pm-test-pills">
        {TEST_ORDER.map((k) => {
          const res = resultOf(k);
          return (
            <button type="button" key={k} className={`badge pm-test ${RESULT_TONE[res]}`} data-key={`pm-test-${k}-${pid}`} data-result={res} aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>{`${TEST_WORDS[k]}: ${res}`}</button>
          );
        })}
      </div>
      {open ? (
        <div className="pm-test-body" data-key={`pm-test-body-${pid}`}>
          <p className="pm-dis-note">{cur && cur.finding ? cur.finding : 'No finding recorded for this test.'}</p>
          <p className="faint pm-note">{cur && Array.isArray(cur.source_ids) && cur.source_ids.length ? `Sources: ${cur.source_ids.join(', ')}` : 'No sources cited.'}</p>
        </div>
      ) : null}
      {pr.strongest_bull_rebuttal ? <p className="pm-dis-note" data-key={`pm-rebuttal-${pid}`}><span className="pm-dis-k">Strongest bull rebuttal</span>{` ${pr.strongest_bull_rebuttal}`}</p> : null}
    </div>
  );
}

function exitText(t) {
  // A native L1 coin of the size the rules name passes without a DEX quote:
  // said as its basis, never as a measured cost.
  if (t.exit_basis === 'native_l1_liquid') return { text: 'Native L1', tone: 'is-ok', title: 'The chain\'s own coin above the market-cap threshold in your sizing rules: no DEX quote is needed' };
  if (t.exit_cost_500_usd_pct === null || t.exit_cost_500_usd_pct === undefined) return { text: 'No reading', tone: 'is-unknown' };
  const v = `${t.exit_cost_500_complete ? '' : '≥ '}${t.exit_cost_500_usd_pct}%`;
  // Against the limit this ticket froze; without one the figure stays unjudged.
  const limit = typeof t.exit_limit_pct === 'number' ? t.exit_limit_pct : null;
  return { text: v, tone: limit !== null && t.exit_cost_500_usd_pct > limit ? 'is-bad' : limit !== null && t.exit_cost_500_complete ? 'is-ok' : 'is-unknown' };
}

// Item 33: the change since Claude's earlier report, with the prompt versions
// in its tooltip and, when they differ, in the badge's tone.
function DeltaBadge({ pid, delta, row = false }) {
  const b = deltaBadgeOf(delta);
  if (!b) return null;
  const pill = <span className={`badge ${b.tone}`} title={b.title || undefined}>{b.text}</span>;
  return row
    ? <p className="pm-dis-row" data-key={`pm-delta-${pid}`}><span className="pm-dis-k">Since last</span>{pill}</p>
    : <p className="faint pm-note" data-key={`pm-delta-${pid}`}>{"Claude's report: "}{pill}</p>;
}

// Item 13's note on a ticket made under a rule this desk does not know.
function RuleNote({ pid, t }) {
  const note = ruleNoteOf(t);
  return note ? <p className="pm-alert" data-key={`pm-rule-${pid}`}>{note}</p> : null;
}

function PilotLine({ p, t, busy, setBusy }) {
  const pid = p.project_id;
  const on = Boolean(t && t.pilot);
  return (
    <p className="pm-pilot">
      <span className="pm-pilot-k">Autonomous pilot</span>
      <span className="pm-pilot-v">{on ? (t.open ? `Agent 2 ticket ${t.open.state === 'running' ? 'in progress' : 'waiting'}` : t.status ? 'On' : 'On · next: npm run pilot') : 'Off'}</span>
      <button type="button" className="btn-link" data-key={`pm-pilot-${pid}`} disabled={busy === 'pilot'} onClick={async () => {
        setBusy('pilot');
        try {
          await api.post(`/api/projects/${enc(pid)}/tickets/pilot`, { on: !on });
          toast(on ? 'Pilot off for this project' : 'Pilot on: Claude researches, then prosecutes');
          await refresh();
        } catch (err) {
          toast(err.message, 'bad');
        } finally {
          setBusy(null);
        }
      }}>{on ? 'Turn off' : 'Turn on'}</button>
    </p>
  );
}

// Trade Plan strip (item 49, cr-ticket-geometry@2): where the stored price sits
// against the receipt's entry zone, target and invalidation price. Numbers the
// desk does not have read "unknown"; nothing is filled in.
const ZONE_WORDS = { in_zone: 'In the entry zone', above_zone: 'above the zone', below_zone: 'below the zone' };
function TradePlan({ pid, g }) {
  if (!g) return null;
  const pct = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${v}%` : null);
  const unknown = <span className="is-unknown">unknown</span>;
  const zone = g.position === 'unknown' ? null : g.position === 'in_zone' ? ZONE_WORDS.in_zone : `${g.position_pct}% ${ZONE_WORDS[g.position]}`;
  return (
    <div className="pm-plan" data-key={`pm-plan-${pid}`} aria-label="Trade plan" title={g.words || undefined}>
      <p className="pm-plan-cell"><span className="pm-dis-k">Price vs zone</span><span>{zone || unknown}</span></p>
      <p className="pm-plan-cell"><span className="pm-dis-k">To target</span><span>{pct(g.to_upside_pct) || unknown}</span></p>
      <p className="pm-plan-cell"><span className="pm-dis-k">To invalidation</span><span>{pct(g.to_stop_pct) || unknown}</span></p>
      <p className="pm-plan-cell"><span className="pm-dis-k">Reward : risk</span><span>{typeof g.plan_reward_risk_ratio === 'number' ? `${g.plan_reward_risk_ratio} : 1 at plan` : <>{unknown} at plan</>}{', '}{typeof g.reward_risk_ratio === 'number' ? `${g.reward_risk_ratio} : 1 now` : <>{unknown} now</>}</span></p>
    </div>
  );
}

// Item 56: Agent 1 beside Agent 2, never averaged: the researcher's grade and
// verdict, the Prosecutor's conviction and verdict, the spread between them
// and the Prosecutor's own note; when the project has model-spread alerts, a
// link to Compare at the widest diverging category.
function Disagreement({ pid, t, spread, dis, r, q, fatal }) {
  const link = widestCategoryLink(spread);
  return (
    <div className="pm-dis" data-key={`pm-disagreement-${pid}`} aria-label="Researcher and Prosecutor side by side">
      <div className="pm-sbs">
        <div className="pm-sbs-cell" data-key={`pm-agent1-${pid}`}>
          <p className="pm-dis-k">Agent 1 · Researcher</p>
          <p className="pm-sbs-v">{r.grade_display || r.grade || '—'}</p>
          <p className="pm-sbs-s">{r.verdict || 'no verdict'}</p>
        </div>
        <div className="pm-sbs-cell" data-key={`pm-agent2-${pid}`}>
          <p className="pm-dis-k">Agent 2 · Prosecutor</p>
          <p className="pm-sbs-v">{q.conviction_score ?? '—'}</p>
          <p className="pm-sbs-s">{fatal.length ? `${fatal.length} fatal flaw${fatal.length === 1 ? '' : 's'} (${TEST_WORDS[fatal[0].test] || fatal[0].test})` : VERDICT_WORDS[q.verdict] || q.verdict || 'no verdict'}</p>
        </div>
      </div>
      <DeltaBadge pid={pid} delta={t.report_delta} row />
      {typeof dis.spread_points === 'number' ? <p className="pm-dis-row"><span className="pm-dis-k">Spread</span><span>{`${dis.spread_points > 0 ? '+' : ''}${dis.spread_points} points (researcher minus prosecutor)`}</span></p> : null}
      {dis.note ? <p className="pm-dis-note" data-key={`pm-why-${pid}`}>{dis.note}</p> : null}
      {link ? <a className="btn-link" href={link.href} title={link.title} data-key={`pm-widest-${pid}`}>{link.text}</a> : null}
    </div>
  );
}

export function PMDecisionCard({ p }) {
  const [busy, setBusy] = useState(null);
  const t = p.ticket;
  const pid = p.project_id;
  if (!t || t.unavailable) return null;
  if (!t.status) {
    return t.pilot || t.open ? (
      <section className="pm-card" aria-labelledby={`pm-h-${pid}`}>
        <h3 className="iv-h" id={`pm-h-${pid}`}>PM decision</h3>
        <p className="faint">No ticket yet.</p>
        <PilotLine p={p} t={t} busy={busy} setBusy={setBusy} />
      </section>
    ) : null;
  }
  const st = STATUS[t.status] || { word: t.status, tone: '' };
  const ex = exitText(t);
  const dis = t.agent_disagreement || {};
  const r = dis.researcher || {};
  const q = dis.prosecutor || {};
  const fatal = ((t.prosecution && t.prosecution.fatal_flaws) || []).filter((f) => f.severity === 'fatal');
  const risk = t.suggested_risk_usd || 0;
  const decided = t.decision;
  // The card sends what it shows (status, suggested risk, a newer report), so
  // the desk refuses a decision on a ticket that changed since it was drawn.
  const decide = async (action, { repair = false } = {}) => {
    setBusy(action);
    try {
      const seen = action === 'undo' ? undefined : { status: t.status, suggested_risk_usd: t.suggested_risk_usd || 0, superseded_by_report: t.superseded_by_report || null };
      const out = await api.post(`/api/projects/${enc(pid)}/tickets/decisions`, { receipt_id: t.receipt_id, action, request_id: submissionId(), ...(seen && !repair ? { seen } : {}) });
      const d = out && out.result ? out.result.decision : out && out.decision;
      const r = out && out.result ? out.result : out || {};
      toast(repair ? (r.paper && r.paper.status !== 'failed' ? 'Paper position completed' : `Paper position not completed: ${(r.paper && r.paper.error) || 'unknown error'}`)
        : action === 'undo' ? (r.project_restored ? 'Decision undone; project restored' : 'Decision undone')
          : action === 'pass' ? (r.project_archived ? 'Pass confirmed; project archived' : 'Pass confirmed; kept because you hold it')
            : DECIDED_WORDS[action] || `Risk granted: ${usd(d ? d.pm_approved_risk_usd : null)}`, repair && !(r.paper && r.paper.status !== 'failed') ? 'bad' : undefined);
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  // Eric's override of the desk's gate: after a confirm, a normal ticket is
  // opened on the same report (force_prosecution), labeled as his choice.
  const prosecuteAnyway = async () => {
    if (!window.confirm("The desk's gate is closed on this grade. Ask the Prosecutor anyway? This is your override and may use a paid request.")) return;
    setBusy('prosecute');
    try {
      await api.post(`/api/projects/${enc(pid)}/tickets`, { force_prosecution: true, utterance: "Eric's override of the desk's gate (Ask the Prosecutor anyway)" });
      toast('Prosecutor asked at your override');
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  const inv = t.invalidation_trigger || {};
  // The desk's own gate (cr-ticket-pregate@1): the grade alone ruled out new
  // risk, so no Prosecutor ran. Its reasons and the two ways out only.
  if (t.desk_gate) {
    return (
      <section className="pm-card" aria-labelledby={`pm-h-${pid}`} data-status={t.status} data-kind="desk_gate">
        <div className="pm-head">
          <h3 className="iv-h" id={`pm-h-${pid}`}>PM decision</h3>
          <span className={`badge ${st.tone}`}>{st.word}</span>
        </div>
        <div className="pm-call">
          <p className="pm-type">Desk gate · no Prosecutor run</p>
          <p className="pm-risk"><span className="pm-risk-s">{`${TYPE_WORDS[t.proposal_type] || t.proposal_type} · no risk`}</span></p>
        </div>
        {(t.gate_reasons || []).map((reason) => <p className="pm-thesis" key={reason}>{reason}</p>)}
        <p className="faint pm-note" data-key={`pm-gate-kind-${pid}`}>{gateKindWords(t)}</p>
        <div className="pm-dis">
          <p className="pm-dis-row"><span className="pm-dis-k">Researcher</span><span>{`${(t.researcher || {}).grade_display || (t.researcher || {}).grade || '—'} · ${(t.researcher || {}).verdict || 'no verdict'}`}</span></p>
        </div>
        <DeltaBadge pid={pid} delta={t.report_delta} />
        <RuleNote pid={pid} t={t} />
        {t.superseded_by_report ? <p className="faint pm-note">{`Claude has a newer report (${t.superseded_by_report}); this gate is on the earlier one.`}</p> : null}
        <Actions pid={pid}>
          {decided ? (
            <p className="pm-decided">
              <span>{DECIDED_WORDS[decided.action] || 'Decided'}{decided.action === 'pass' && decided.archive === 'archived' ? ' · archived' : ''}</span>
              <span className="faint">{` · ${fmtDateTime(decided.at)}`}</span>
              <button type="button" className="btn btn-sm" data-key={`pm-undo-${pid}`} disabled={Boolean(busy)} onClick={() => decide('undo')}>Undo</button>
            </p>
          ) : (
            <>
              <button type="button" className="btn btn-sm btn-primary" data-key={`pm-pass-${pid}`} disabled={Boolean(busy)} title={p.held ? 'You hold it, so it stays on the Desk' : 'Archives the project; Undo restores it'} onClick={() => decide('pass')}>{'Confirm Pass & Archive'}</button>
              <button type="button" className="btn btn-sm" data-key={`pm-watch-${pid}`} disabled={Boolean(busy)} onClick={() => decide('watch')}>{'Override → Watch'}</button>
              {t.latest && !t.superseded_by_report ? <button type="button" className="btn btn-sm" data-key={`pm-prosecute-${pid}`} disabled={Boolean(busy)} title="Your override: runs a Prosecutor although the desk's gate is closed" onClick={prosecuteAnyway}>Ask the Prosecutor anyway</button> : null}
            </>
          )}
        </Actions>
        <PilotLine p={p} t={t} busy={busy} setBusy={setBusy} />
      </section>
    );
  }
  return (
    <section className="pm-card" aria-labelledby={`pm-h-${pid}`} data-status={t.status}>
      <div className="pm-head">
        <h3 className="iv-h" id={`pm-h-${pid}`}>PM decision</h3>
        <span className={`badge ${st.tone}`}>{st.word}</span>
      </div>
      <div className="pm-call">
        <p className="pm-type">{TYPE_WORDS[t.proposal_type] || t.proposal_type}</p>
        <p className="pm-risk" title={t.capped ? `The desk capped ${TYPE_WORDS[t.capped.from] || t.capped.from}: ${t.capped.reason}` : (t.gate_reasons || []).join(' ') || undefined}>
          {risk > 0 ? <>{usd(risk)}<span className="pm-risk-s"> suggested</span></> : <span className="pm-risk-s">{t.capped ? `No risk · capped from ${TYPE_WORDS[t.capped.from] || t.capped.from}` : 'No risk suggested'}</span>}
        </p>
      </div>
      {t.non_consensus_thesis ? <p className="pm-thesis">{t.non_consensus_thesis}</p> : null}
      {t.trigger_breached_at_save ? <p className="pm-alert" title={t.trigger_breached_at_save.words}>Trigger already breached when saved</p> : null}
      {t.integrity && t.integrity.status !== 'ok' && t.integrity.words ? <p className="pm-alert" data-key={`pm-integrity-${pid}`}>{t.integrity.words}</p> : null}
      {t.near_invalidation ? <p className="pm-alert" data-key={`pm-near-${pid}`} title={t.near_invalidation.words}>{`Near invalidation: a ${t.near_invalidation.distance_pct}% fall reaches ${usd(t.near_invalidation.threshold_usd)}`}</p> : null}
      {(t.invalidation && t.invalidation.checks || []).filter((c) => c.kind === 'metric' && c.status === 'holding' && typeof c.headroom_pct === 'number').map((c) => <p key={`pm-headroom-${c.key}`} className="pm-alert" data-key={`pm-headroom-${pid}`} title={c.words}>{`${c.key} floor headroom: ${c.headroom_pct}% above ${usd(c.threshold_usd)}`}</p>)}
      {t.status === 'invalidated' && t.invalidation ? <p className="pm-alert">{t.invalidation.words}</p> : null}
      <div className="iv-rgrid pm-grid">
        <div className="iv-rc">
          <p className="iv-rc-k">Entry zone</p>
          <p className="iv-rc-v">{t.entry_zone ? `${usd(t.entry_zone.low_usd)}–${usd(t.entry_zone.high_usd)}` : <span className="is-unknown" title="The ticket gives no entry zone">Not given</span>}</p>
        </div>
        <div className="iv-rc">
          <p className="iv-rc-k">Invalidation</p>
          <p className="iv-rc-v" title={inv.statement || undefined}>{inv.price_usd ? usd(inv.price_usd) : <span className="is-unknown">No price</span>}</p>
          {inv.metric ? <p className="iv-rc-s">{`30d ${inv.metric.key.replace('_', ' ')} < ${usd(inv.metric.below_30d_usd)}`}</p> : null}
        </div>
        <div className="iv-rc">
          <p className="iv-rc-k">Target</p>
          <p className="iv-rc-v" title={t.upside_target ? t.upside_target.basis || undefined : undefined}>{t.upside_target ? usd(t.upside_target.price_usd) : <span className="is-unknown" title="The ticket gives no upside target">Not given</span>}</p>
        </div>
        <div className="iv-rc">
          <p className="iv-rc-k">{typeof t.exit_size_usd === 'number' ? `Exit @ $${t.exit_size_usd.toLocaleString('en-US')}` : 'Exit'}</p>
          <p className={`iv-rc-v ${ex.tone}`} title={ex.title || (t.exit_cost_500_complete === false ? 'A lower bound: part of the cost is unknown' : 'The desk\'s own exit reading')}>{ex.text}</p>
          {typeof t.exit_limit_pct === 'number' ? <p className="iv-rc-s">{`${t.exit_limit_pct}% limit`}</p> : null}
        </div>
      </div>
      <TradePlan pid={pid} g={t.trade_plan_geometry} />
      <TestMatrix pid={pid} pr={t.prosecution} />
      {(t.exits_missing || []).length ? (
        <p className="faint" data-key={`pm-missing-${pid}`}>
          {`No current exit reading at ${t.exits_missing.map((m) => `$${m.size_usd.toLocaleString("en-US")}`).join(' or ')}. `}
          <a href={t.exits_missing[0].link} title={t.exits_missing.map((m) => m.reason).join(' ')}>Approve exit quotes</a>
        </p>
      ) : null}
      {t.agent_disagreement ? <Disagreement pid={pid} t={t} spread={p.spread} dis={dis} r={r} q={q} fatal={fatal} /> : null}
      <RuleNote pid={pid} t={t} />
      {t.superseded_by_report ? <p className="faint pm-note">{`Claude has a newer report (${t.superseded_by_report}); this ticket is on the earlier one.`}</p> : null}
      <Actions pid={pid}>
        {decided ? (
          <p className="pm-decided">
            <span>{DECIDED_WORDS[decided.action] || `Approved ${usd(t.pm_approved_risk_usd)}`}{decided.action === 'pass' && decided.archive === 'archived' ? ' · archived' : ''}</span>
            <span className="faint">{` · ${fmtDateTime(decided.at)}`}</span>
            {decided.paper === 'missing' ? <button type="button" className="btn btn-sm" data-key={`pm-repair-${pid}`} disabled={Boolean(busy)} title="The decision is recorded but its paper position is not: records the same decision again, which completes it once" onClick={() => decide(decided.action, { repair: true })}>Complete paper position</button> : null}
            <button type="button" className="btn btn-sm" data-key={`pm-undo-${pid}`} disabled={Boolean(busy)} onClick={() => decide('undo')}>Undo</button>
          </p>
        ) : risk > 0 ? (
          <>
            <button type="button" className="btn btn-sm btn-primary" data-key={`pm-approve-${pid}`} disabled={Boolean(busy) || t.status === 'invalidated' || Boolean(t.integrity && t.integrity.status !== 'ok')} title={`Grant ${usd(risk)} of risk`} onClick={() => decide('approve')}>{`Approve Risk (${usd(risk)})`}</button>
            <button type="button" className="btn btn-sm" data-key={`pm-halve-${pid}`} disabled={Boolean(busy) || t.status === 'invalidated' || Boolean(t.integrity && t.integrity.status !== 'ok')} title="The starter tranche" onClick={() => decide('halve')}>{`Halve Size (${usd(Math.min(t.starter_risk_usd, risk))})`}</button>
            <button type="button" className="btn btn-sm btn-danger" data-key={`pm-veto-${pid}`} disabled={Boolean(busy)} onClick={() => decide('veto')}>Veto / Archive</button>
          </>
        ) : t.proposal_type === 'TRIM_EXIT' ? (
          <>
            <button type="button" className="btn btn-sm btn-primary" data-key={`pm-trim-${pid}`} disabled={Boolean(busy)} title="Records that you saw the trim proposal; it places no order" onClick={() => decide('trim')}>Acknowledge Trim</button>
            <button type="button" className="btn btn-sm" data-key={`pm-watch-${pid}`} disabled={Boolean(busy)} onClick={() => decide('watch')}>{'Override → Watch'}</button>
          </>
        ) : t.proposal_type === 'WATCH_ONLY' ? (
          <>
            <button type="button" className="btn btn-sm btn-primary" data-key={`pm-watch-${pid}`} disabled={Boolean(busy)} onClick={() => decide('watch')}>Confirm Watch</button>
            <button type="button" className="btn btn-sm" data-key={`pm-pass-${pid}`} disabled={Boolean(busy)} title={p.held ? 'You hold it, so it stays on the Desk' : 'Archives the project; Undo restores it'} onClick={() => decide('pass')}>{'Pass & Archive'}</button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-sm btn-primary" data-key={`pm-pass-${pid}`} disabled={Boolean(busy)} title={p.held ? 'You hold it, so it stays on the Desk' : 'Archives the project; Undo restores it'} onClick={() => decide('pass')}>{'Confirm Pass & Archive'}</button>
            <button type="button" className="btn btn-sm" data-key={`pm-watch-${pid}`} disabled={Boolean(busy)} onClick={() => decide('watch')}>{'Override → Watch'}</button>
          </>
        )}
        {t.can_reopen && !(decided && decided.action === 'reopen') ? <button type="button" className="btn btn-sm" data-key={`pm-reopen-${pid}`} disabled={Boolean(busy)} title={t.can_reopen.why} onClick={() => decide('reopen')}>Re-open ticket</button> : null}
      </Actions>
      <PilotLine p={p} t={t} busy={busy} setBusy={setBusy} />
    </section>
  );
}
