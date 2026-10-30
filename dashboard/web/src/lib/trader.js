// The trader simulation's book (GET /api/paper/trader, core/trader-desk.js
// view), read once per index for the Desk's market line (Trader Sim), the
// way lib/agenda.js reads the agenda: an answer that a newer read replaced is
// never drawn; signing out drops it (desk.js signedOut). Reading it writes
// nothing.
import { useEffect, useState } from 'react';
import { api, desk } from './desk.js';
import { useDesk } from './hooks.js';

const EMPTY = { v: null, error: null };

function read(index) {
  const s = desk.trader;
  if (s && s.index === index && s.promise) return s.promise;
  const last = s ? s.last : EMPTY;
  const promise = api.get('/api/paper/trader').then(
    (v) => ({ v, error: null }),
    (error) => ({ v: last.v, error }),
  );
  desk.trader = { index, promise, last };
  promise.then((out) => { if (desk.trader && desk.trader.promise === promise) desk.trader.last = out; });
  return promise;
}

export function useTraderRead() {
  const d = useDesk();
  const index = d.index;
  const [st, setSt] = useState(() => (desk.trader ? desk.trader.last : EMPTY));
  useEffect(() => {
    if (!index || desk.signedOut) return undefined;
    let live = true;
    const promise = read(index);
    promise.then((out) => { if (live && desk.trader && desk.trader.promise === promise) setSt(out); });
    return () => { live = false; };
  }, [index]);
  if (!index || desk.signedOut) return EMPTY;
  return st;
}
