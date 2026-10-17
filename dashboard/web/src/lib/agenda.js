// The review agenda (GET /api/agenda, core/forensic-agenda.js), read once per
// index and shared by the rail's Review count, the Desk and the Review page,
// so the three count the same projects (D3). An answer that a newer read
// replaced is never drawn; signing out drops it with the rest of the
// workspace (desk.js signedOut). Reading it writes nothing.
import { useEffect, useState } from 'react';
import { api, desk } from './desk.js';
import { useDesk } from './hooks.js';

const EMPTY = { a: null, error: null };

function read(index) {
  const s = desk.agenda;
  if (s && s.index === index && s.promise) return s.promise;
  const last = s ? s.last : EMPTY;
  const promise = api.get('/api/agenda').then(
    (a) => ({ a, error: null }),
    (error) => ({ a: last.a, error }),
  );
  desk.agenda = { index, promise, last };
  promise.then((out) => { if (desk.agenda && desk.agenda.promise === promise) desk.agenda.last = out; });
  return promise;
}

export function useAgendaRead() {
  const d = useDesk();
  const index = d.index;
  const [attempt, setAttempt] = useState(0);
  const [st, setSt] = useState(() => (desk.agenda ? desk.agenda.last : EMPTY));
  useEffect(() => {
    if (!index || desk.signedOut) return undefined;
    let live = true;
    const promise = read(index);
    promise.then((out) => { if (live && desk.agenda && desk.agenda.promise === promise) setSt(out); });
    return () => { live = false; };
  }, [index, attempt]);
  if (!index || desk.signedOut) return { ...EMPTY, retry: () => {} };
  return { ...st, retry: () => { if (desk.agenda) desk.agenda.promise = null; setAttempt((x) => x + 1); } };
}
