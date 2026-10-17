// "Download case": the case package of one receipt (cr.forensic-case.v1,
// core/forensic-case.js), read through the signed-in client and saved as a
// file. Reading it writes nothing and asks no provider or model; a receipt
// that disagrees with its original makes no package (409, said here).
// Verify it offline: node dashboard/cli.js forensics case-verify --file <it>.
import { useState } from 'react';
import { Package } from 'lucide-react';
import { toast } from '../../../../../public/ui.js';
import { api } from '../../../lib/desk.js';
import { enc } from './fmt.js';

export function CaseButton({ pid, rid }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-link fx-text-btn"
      data-key={`fx-case-${rid}`}
      disabled={busy}
      aria-busy={busy || undefined}
      title="The receipt, its original text, frozen prompt and evidence packet, the monitor observations and the exit calculation, with a manifest of SHA-256 hashes and what is missing. No credentials, wallets or portfolio records."
      onClick={async () => {
        setBusy(true);
        try {
          const pkg = await api.get(`/api/projects/${enc(pid)}/forensics/receipts/${enc(rid)}/case`);
          if (!pkg || !pkg.manifest || !pkg.manifest.receipt || pkg.manifest.receipt.receipt_id !== rid) throw new Error('The answer was not this receipt\'s case package.');
          const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `forensic-case-${rid}.json`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          const missing = (pkg.manifest.missing || []).length;
          toast(`Case package saved${missing ? `; ${missing} item${missing === 1 ? '' : 's'} listed as missing` : ''}`);
        } catch (err) {
          toast(err.status === 401 ? 'Your session has ended. Sign in again to download the case.' : err.message, 'bad');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Package size={13} aria-hidden="true" />{busy ? 'Preparing the case…' : 'Download case'}
    </button>
  );
}
