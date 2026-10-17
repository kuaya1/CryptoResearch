// The original text of a receipt, read through the signed-in client (no
// token in any address), shown with its pin checked twice: by the server
// against the receipt, and here against the SHA-256 the page shows. The
// download is made from the same bytes. Review F12. Used by the receipts
// list, the integrity notice, the challenge and the disagreement board.
import { useEffect, useRef, useState } from 'react';
import { FileText, Download } from 'lucide-react';
import { fmtDateTime, PROVIDER_LABELS } from '../../../../../public/ui.js';
import { api } from '../../../lib/desk.js';
import { enc } from './fmt.js';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function TextViewer({ pid, rid, sha, onClose }) {
  const ref = useRef(null);
  const [st, setSt] = useState({ state: 'loading' });
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    const ctrl = new AbortController();
    api.get(`/api/projects/${enc(pid)}/forensics/receipts/${enc(rid)}/text`, { signal: ctrl.signal }).then(
      async (r) => {
        if (ctrl.signal.aborted) return;
        if (!r || r.receipt_id !== rid || typeof r.text !== 'string') return setSt({ state: 'error', message: 'The answer was not this receipt\'s text.' });
        const got = await sha256Hex(r.text);
        if (ctrl.signal.aborted) return;
        if (got !== r.sha256 || (sha && got !== sha)) return setSt({ state: 'error', message: `The text read does not match the receipt's SHA-256 (${(sha || r.sha256).slice(0, 12)}…); it is not shown.` });
        setSt({ state: 'ok', r, got });
      },
      (err) => { if (!ctrl.signal.aborted && err.name !== 'AbortError') setSt({ state: 'error', message: err.status === 401 ? 'Your session has ended. Sign in again to read the original.' : err.message }); },
    );
    return () => { ctrl.abort(); if (d && d.open) d.close(); };
  }, [pid, rid]);
  return (
    <dialog ref={ref} className="fx-dialog fx-viewer" aria-labelledby="fx-viewer-h" onClose={onClose}>
      <div className="fx-dialog-head"><h2 id="fx-viewer-h" className="fx-h">{`The full text as saved · ${rid}`}</h2></div>
      <div className="fx-dialog-body">
        {st.state === 'loading' ? <p role="status">Reading the saved text…</p> : null}
        {st.state === 'error' ? <p className="fx-error" role="alert">{st.message}</p> : null}
        {st.state === 'ok' ? (
          <>
            <p className="faint">{`${PROVIDER_LABELS[st.r.model && st.r.model.provider] || ''} · saved ${fmtDateTime(st.r.saved_at)} · ${st.r.chars.toLocaleString('en-US')} characters · SHA-256 ${st.got} (matches the receipt; the JSON block matches too)`}</p>
            <pre className="fx-viewer-text" tabIndex={0}>{st.r.text}</pre>
          </>
        ) : null}
      </div>
      <div className="fx-dialog-foot">
        {st.state === 'ok' ? (
          <button
            type="button"
            className="btn"
            data-key="fx-viewer-download"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([st.r.text], { type: 'text/markdown;charset=utf-8' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `${rid}.md`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 2000);
            }}
          >
            <Download size={14} aria-hidden="true" />Download
          </button>
        ) : null}
        <button type="button" className="btn" data-key="fx-viewer-close" onClick={() => ref.current.close()}>Close</button>
      </div>
    </dialog>
  );
}

// dataKey: unique on the page (the same receipt can be opened from the
// receipts list and from the board).
export function TextButton({ pid, rid, sha, label = 'The full text as saved', dataKey = null }) {
  const [open, setOpen] = useState(false);
  const opener = useRef(null);
  return (
    <>
      <button ref={opener} type="button" className="btn-link fx-text-btn" data-key={dataKey || `fx-text-${rid}`} onClick={() => setOpen(true)}><FileText size={13} aria-hidden="true" />{label}</button>
      {open ? <TextViewer pid={pid} rid={rid} sha={sha} onClose={() => { setOpen(false); requestAnimationFrame(() => { if (opener.current) opener.current.focus(); }); }} /> : null}
    </>
  );
}
