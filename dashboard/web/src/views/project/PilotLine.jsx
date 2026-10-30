// The autonomous pilot's switch for one project. It is operations, not a
// decision (subtraction stage 4.2), so it sits on the project's Record tab,
// never on the PM card.
import { useState } from 'react';
import { toast } from '../../../../public/ui.js';
import { api, refresh } from '../../lib/desk.js';

const enc = encodeURIComponent;

export function PilotLine({ p, t }) {
  const [busy, setBusy] = useState(null);
  const pid = p.project_id;
  const on = Boolean(t && t.pilot);
  return (
    <p className="pm-pilot">
      <span className="pm-pilot-k">Autonomous pilot</span>
      <span className="pm-pilot-v">{on ? (t.open ? `Prosecutor ticket ${t.open.state === 'running' ? 'in progress' : 'waiting'}` : 'On') : 'Off'}</span>
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
