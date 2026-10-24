// The PM Decision Card (2026-10-24, the Junior Trader pipeline): the
// Prosecutor's ticket on Claude's current report, as the desk sized it, with
// Eric's three decisions. Everything shown comes from the index row's ticket
// (core/tickets.js summary): the proposal and levels as the Prosecutor wrote
// them, the exit cost from the desk's own readings, the suggested risk from
// Eric's sizing rules, the two agents' figures side by side (never averaged)
// and the status, read with invalidation against prices and DefiLlama. A
// decision records his choice; nothing here places an order.
import { useState } from 'react';
import { toast, submissionId, fmtDateTime } from '../../../../public/ui.js';
import { api, refresh } from '../../lib/desk.js';

const enc = encodeURIComponent;
const usd = (n) => (typeof n === 'number' ? `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 })}` : '—');
const TYPE_WORDS = { ACCUMULATE: 'Accumulate', LIMIT_TRAP: 'Limit trap', TRIM_EXIT: 'Trim / exit', WATCH_ONLY: 'Watch only', HARD_PASS: 'Hard pass' };
const STATUS = {
  pending_pm_review: { word: 'Pending your review', tone: 'is-warn' },
  risk_granted: { word: 'Risk granted', tone: 'is-ok' },
  vetoed: { word: 'Vetoed', tone: '' },
  invalidated: { word: 'Invalidated', tone: 'is-bad' },
};
const VERDICT_WORDS = { thesis_survives: 'thesis survives', thesis_damaged: 'thesis damaged', fatal_flaw: 'fatal flaw' };

function exitText(t) {
  if (t.exit_cost_500_usd_pct === null || t.exit_cost_500_usd_pct === undefined) return { text: 'No reading', tone: 'is-unknown' };
  const v = `${t.exit_cost_500_complete ? '' : '≥ '}${t.exit_cost_500_usd_pct}%`;
  return { text: v, tone: t.exit_cost_500_usd_pct > 5 ? 'is-bad' : t.exit_cost_500_complete ? 'is-ok' : 'is-unknown' };
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

export function PMDecisionCard({ p }) {
  const [busy, setBusy] = useState(null);
  const [why, setWhy] = useState(false);
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
  const decide = async (action) => {
    setBusy(action);
    try {
      const out = await api.post(`/api/projects/${enc(pid)}/tickets/decisions`, { receipt_id: t.receipt_id, action, request_id: submissionId() });
      const d = out && out.result ? out.result.decision : out && out.decision;
      toast(action === 'undo' ? 'Decision undone' : action === 'veto' ? 'Ticket vetoed' : `Risk granted: ${usd(d ? d.pm_approved_risk_usd : null)}`);
      await refresh();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(null);
    }
  };
  const inv = t.invalidation_trigger || {};
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
      {t.status === 'invalidated' && t.invalidation ? <p className="pm-alert">{t.invalidation.words}</p> : null}
      <div className="iv-rgrid pm-grid">
        <div className="iv-rc">
          <p className="iv-rc-k">Entry zone</p>
          <p className="iv-rc-v">{t.entry_zone ? `${usd(t.entry_zone.low_usd)}–${usd(t.entry_zone.high_usd)}` : <span className="is-unknown">None</span>}</p>
        </div>
        <div className="iv-rc">
          <p className="iv-rc-k">Invalidation</p>
          <p className="iv-rc-v" title={inv.statement || undefined}>{inv.price_usd ? usd(inv.price_usd) : <span className="is-unknown">No price</span>}</p>
          {inv.metric ? <p className="iv-rc-s">{`30d ${inv.metric.key.replace('_', ' ')} < ${usd(inv.metric.below_30d_usd)}`}</p> : null}
        </div>
        <div className="iv-rc">
          <p className="iv-rc-k">Target</p>
          <p className="iv-rc-v" title={t.upside_target ? t.upside_target.basis || undefined : undefined}>{t.upside_target ? usd(t.upside_target.price_usd) : <span className="is-unknown">None</span>}</p>
        </div>
        <div className="iv-rc">
          <p className="iv-rc-k">Exit @ $500</p>
          <p className={`iv-rc-v ${ex.tone}`} title={t.exit_cost_500_complete === false ? 'A lower bound: part of the cost is unknown' : 'The desk\'s own exit reading'}>{ex.text}</p>
          <p className="iv-rc-s">5% limit</p>
        </div>
      </div>
      <div className="pm-dis" title={dis.note || undefined}>
        <p className="pm-dis-row"><span className="pm-dis-k">Researcher</span><span>{`${r.grade_display || r.grade || '—'} · ${r.verdict || 'no verdict'}`}</span></p>
        <p className="pm-dis-row"><span className="pm-dis-k">Prosecutor</span><span>{`${q.conviction_score ?? '—'} · ${VERDICT_WORDS[q.verdict] || q.verdict || 'no verdict'}${fatal.length ? ` · ${fatal.length} fatal flaw${fatal.length === 1 ? '' : 's'}` : ''}`}</span></p>
        {typeof dis.spread_points === 'number' ? <p className="pm-dis-row"><span className="pm-dis-k">Spread</span><span>{`${dis.spread_points > 0 ? '+' : ''}${dis.spread_points} points (researcher minus prosecutor)`}</span></p> : null}
        {dis.note ? (
          <>
            <button type="button" className="btn-link" aria-expanded={why} data-key={`pm-why-${pid}`} onClick={() => setWhy(!why)}>{why ? 'Hide the disagreement' : 'Why they disagree'}</button>
            {why ? <p className="pm-dis-note">{dis.note}</p> : null}
          </>
        ) : null}
      </div>
      {t.superseded_by_report ? <p className="faint pm-note">{`Claude has a newer report (${t.superseded_by_report}); this ticket is on the earlier one.`}</p> : null}
      <div className="pm-actions">
        {decided ? (
          <p className="pm-decided">
            <span>{decided.action === 'veto' ? 'Vetoed' : `Approved ${usd(t.pm_approved_risk_usd)}`}</span>
            <span className="faint">{` · ${fmtDateTime(decided.at)}`}</span>
            <button type="button" className="btn btn-sm" data-key={`pm-undo-${pid}`} disabled={Boolean(busy)} onClick={() => decide('undo')}>Undo</button>
          </p>
        ) : (
          <>
            <button type="button" className="btn btn-sm btn-primary" data-key={`pm-approve-${pid}`} disabled={Boolean(busy) || !(risk > 0) || t.status === 'invalidated'} title={risk > 0 ? `Grant ${usd(risk)} of risk` : 'This ticket suggests no risk'} onClick={() => decide('approve')}>Approve Risk</button>
            <button type="button" className="btn btn-sm" data-key={`pm-halve-${pid}`} disabled={Boolean(busy) || !(risk > 0) || t.status === 'invalidated'} title={risk > 0 ? `Grant ${usd(Math.min(t.starter_risk_usd, risk))}, the starter tranche` : 'This ticket suggests no risk'} onClick={() => decide('halve')}>Halve Size</button>
            <button type="button" className="btn btn-sm" data-key={`pm-veto-${pid}`} disabled={Boolean(busy)} onClick={() => decide('veto')}>Veto / Archive</button>
          </>
        )}
      </div>
      <PilotLine p={p} t={t} busy={busy} setBusy={setBusy} />
    </section>
  );
}
