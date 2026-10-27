// The Daily Brief (GET /api/brief/daily, cr-daily-brief@1), read once per
// index for the Desk's hero; the drawer reads its own copy when opened. An
// answer a newer read replaced is never drawn; signing out drops it with the
// rest of the workspace. Reading it writes nothing.
import { useEffect, useState } from 'react';
import { api, desk } from './desk.js';
import { useDesk } from './hooks.js';
import { briefView } from '../../../public/daily-brief-model.js';

const EMPTY = { view: null, error: null };

function read(index) {
  const s = desk.brief;
  if (s && s.index === index && s.promise) return s.promise;
  const last = s ? s.last : EMPTY;
  const promise = api.get('/api/brief/daily', { timeoutMs: 12000 }).then(
    (b) => ({ view: briefView(b), error: null }),
    (error) => ({ view: last.view, error }),
  );
  desk.brief = { index, promise, last };
  promise.then((out) => { if (desk.brief && desk.brief.promise === promise) desk.brief.last = out; });
  return promise;
}

export function useBriefRead() {
  const d = useDesk();
  const index = d.index;
  const [st, setSt] = useState(() => (desk.brief ? desk.brief.last : EMPTY));
  useEffect(() => {
    if (!index || desk.signedOut) return undefined;
    let live = true;
    const promise = read(index);
    promise.then((out) => { if (live && desk.brief && desk.brief.promise === promise) setSt(out); });
    return () => { live = false; };
  }, [index]);
  if (!index || desk.signedOut) return EMPTY;
  return st;
}
