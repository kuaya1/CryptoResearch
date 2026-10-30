// The contract gate panel (UI_MASTER_PLAYBOOK.md §4.6, 2026-10-30), inside
// the ticket card: the gate's tier and its words, verbatim, from the ticket's
// contract_gate (cr-contract-gate@1 as the Desk index carries it). Nothing is
// recomputed here. The index carries the tier, the words, the mode and the
// economics only; the findings, the frozen packet's facts and the authority
// graph are on the project's Contract page, which the open panel links to.
//
// Folded by default; Preferences → Appearance → "Contract gate details"
// (ui-state gate_details) opens it everywhere, and ?p={id}&open=gate opens it
// for that project.
import { useState } from 'react';
import { ui } from '../../lib/desk.js';
import { navigate } from '../../lib/router.js';

const enc = encodeURIComponent;
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const TIER = { none: { word: 'No finding', tone: 'is-ok' }, review: { word: 'For review', tone: 'is-warn' }, hold: { word: 'Hold', tone: 'is-warn' }, block: { word: 'Block · Hard pass', tone: 'is-bad' } };

// The address asks for this project's gate open (?p={id}&open=gate).
function deepOpen(pid) {
  const q = new URLSearchParams(String(window.location.hash || '').split('?')[1] || '');
  return q.get('open') === 'gate' && q.get('p') === pid;
}

export function GatePanel({ pid, t }) {
  const [open, setOpen] = useState(() => deepOpen(pid) || ui.get('gate_details', 'folded') === 'open');
  const cg = t.contract_gate;
  if (!cg) {
    return (
      <div className="v3-gate is-unattested" data-key={`pm-contract-${pid}`} aria-label="Contract gate">
        <p className="v3-gate-title"><span className="v3-gate-t"><span className="v3-gate-dot is-warn" aria-hidden="true" />Contract gate<span className="is-warn">{' · Not attested'}</span></span></p>
        <p className="v3-gate-words">This ticket carries no contract attestation.</p>
      </div>
    );
  }
  const tier = TIER[cg.tier] || { word: cg.tier, tone: '' };
  const href = `#/project/${enc(pid)}/contract`;
  return (
    <div className="v3-gate" data-key={`pm-contract-${pid}`} data-tier={cg.tier} aria-label="Contract gate">
      <button type="button" className="v3-gate-title" aria-expanded={open} data-key={`gate-toggle-${pid}`} onClick={() => setOpen(!open)}>
        <span className="v3-gate-t"><span className={`v3-gate-dot ${tier.tone}`} aria-hidden="true" />Contract gate<span className={tier.tone}>{` · ${tier.word}`}</span></span>
        <span className="v3-gate-fold">{open ? 'Fold' : 'Forensics'}</span>
      </button>
      <p className="v3-gate-words">{`${cg.words}${cg.mode === 'observe' ? ' (observed, not applied)' : ''}`}</p>
      {open ? (
        <div className="v3-gate-more">
          <dl className="v3-gate-facts">
            <div><dt>Mode</dt><dd>{cg.mode === 'enforce' ? 'Enforced' : cg.mode === 'observe' ? 'Observed, not applied' : cg.mode || '—'}</dd></div>
            <div><dt>Tier</dt><dd>{tier.word}</dd></div>
            {cg.economics ? <div className="wide"><dt>Economics</dt><dd>{cg.economics}</dd></div> : null}
          </dl>
          <p className="v3-gate-note">
            {'The findings, the pinned block, the proxy, the transfer probe and the authority graph are on '}
            <a href={href} data-key={`gate-contract-${pid}`} onClick={(e) => { if (!plain(e)) return; e.preventDefault(); navigate(href, { state: { crBrief: pid, from: 'watchlist' } }); }}>Contract and checks</a>.
          </p>
        </div>
      ) : null}
    </div>
  );
}
