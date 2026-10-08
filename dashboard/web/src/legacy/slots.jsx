// A hosted view can leave a slot for one of the app's components: an element
// with data-react-slot="<name>" and the props on it (el.slotProps). LegacyView
// draws the component there after each drawing, so the view keeps its records
// and its rules and the app draws the part (Eric, 2026-10-08: the ledger on
// a phone's Portfolio). A slot never writes; it only draws what it is given.
import { createPortal } from 'react-dom';
import { useDesk } from '../lib/hooks.js';
import { LedgerTable } from '../components/ui/LedgerTable.jsx';
import { Logo } from '../components/Logo.jsx';

function LedgerSlot({ props }) {
  const d = useDesk();
  const byId = new Map((((d && d.index) || {}).projects || []).map((p) => [p.project_id, p]));
  const rows = (props.rows || []).map((r) => ({ ...r, logo: <Logo p={(r.pid && byId.get(r.pid)) || { symbol: r.symbol }} size={28} /> }));
  return <LedgerTable rows={rows} label={props.label} empty={props.empty} />;
}

const SLOTS = { ledger: LedgerSlot };

export function findSlots(root, seq) {
  return [...root.querySelectorAll('[data-react-slot]')].map((el, i) => ({ el, key: `${seq}-${i}` }));
}

export function Slots({ slots }) {
  return slots.map(({ el, key }) => {
    const Part = SLOTS[el.dataset.reactSlot];
    return Part && el.slotProps ? createPortal(<Part props={el.slotProps} />, el, key) : null;
  });
}
