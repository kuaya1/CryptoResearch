// The fixed-token exit comparison (core/forensic-exitcompare.js,
// cr-forensic-exit-compare@1): per approved exit-quote chain, the monitor's
// quotes at your position size (fixed dollars: the token quantity changes
// with the price) beside quotes for one fixed quantity (what your position
// size bought at the first quote after the assessment). Hypothetical exits,
// never transactions. "Quote this quantity now" is Eric's explicit request:
// one keyless GET quote through the approved adapter inside the monitor's
// budget and gates, with one request ID kept until it is answered.
import { useState } from 'react';
import { fmtDateTime, fmtAgo, toast } from '../../../../../public/ui.js';
import { api, refresh } from '../../../lib/desk.js';
import { enc, pct, usd, requestId } from './fmt.js';

function Cost({ r }) {
  if (r.status === 'no_route') return <span>No route</span>;
  if (r.cost_pct === null) return <span className="faint">{r.error ? 'No answer' : 'Unknown'}</span>;
  if (r.cost_complete === false) return <><span className="fx-cost-lb">{`at least ${pct(r.cost_pct)}`}</span><span className="fx-cost-miss">{`${(r.missing_costs || []).join(' and ')} unknown`}</span></>;
  return <span>{pct(r.cost_pct)}</span>;
}

function Rows({ rows, label, symbol }) {
  if (!rows.length) return null;
  return (
    <div className="fx-xc-t" role="table" aria-label={label}>
      <div className="fx-xc-r fx-xc-head" role="row">
        <span role="columnheader">Read</span><span role="columnheader">Sells</span><span role="columnheader">Worth</span><span role="columnheader">Receives</span><span role="columnheader">Cost</span>
      </div>
      {[...rows].reverse().map((r) => (
        <div key={r.obs_id} className={`fx-xc-r is-${r.status}`} role="row">
          <span role="cell" title={`Observation ${r.obs_id}${r.sha256 ? ` · SHA-256 ${r.sha256}` : ''}`}>{fmtDateTime(r.at)}<span className="faint">{` · ${fmtAgo(r.at)}`}</span></span>
          <span role="cell" title={r.amount_in ? `${r.amount_in} base units (${r.decimals} decimals)` : undefined}>{r.tokens ? `${r.tokens}${symbol ? ` ${symbol}` : ''}` : '—'}</span>
          <span role="cell" title={r.price_usd ? `At $${r.price_usd}${r.price_as_of ? ` (price of ${fmtDateTime(r.price_as_of)})` : ''}` : undefined}>{usd(r.value_usd)}</span>
          <span role="cell">{r.net_received_usd !== null ? usd(r.net_received_usd) : r.received_usd !== null ? usd(r.received_usd) : '—'}</span>
          <span role="cell" className="fx-exit-cost"><Cost r={r} /></span>
        </div>
      ))}
    </div>
  );
}

function Chain({ pid, it, symbol, size }) {
  const [busy, setBusy] = useState(false);
  const [rid, setRid] = useState(() => requestId('xq'));
  if (it.status !== 'compared') {
    return (
      <article className="fx-xc" aria-label={`${it.chain}: exit comparison`}>
        <p className="fx-xc-top"><b>{it.chain}</b><span className="faint">{` · ${it.provider}`}</span></p>
        <p className="none">{it.reason}</p>
      </article>
    );
  }
  const ref = it.reference;
  return (
    <article className="fx-xc" aria-label={`${it.chain}: exit comparison`}>
      <p className="fx-xc-top"><b>{it.chain}</b><span className="faint">{` · ${it.provider} · for ${it.quote_symbol || 'USDC'}`}</span></p>
      <p className="fx-xc-ref"><span className="faint">Fixed quantity </span><b title={`${ref.amount_in} base units, ${ref.decimals} decimals`}>{`${ref.tokens}${symbol ? ` ${symbol}` : ''}`}</b><span className="faint">{` · what $${size} bought on ${fmtDateTime(ref.set_at)}${ref.price_usd ? ` at $${ref.price_usd}` : ''}`}</span></p>
      <h4 className="fx-h4">{`Fixed dollars ($${size}): the quantity sold moves with the price`}</h4>
      <Rows rows={it.fixed_usd} label={`Fixed dollars, ${it.chain}`} symbol={symbol} />
      <h4 className="fx-h4">{`Fixed tokens (${ref.tokens}${symbol ? ` ${symbol}` : ''}): the same quantity each time`}</h4>
      {it.fixed_token.length ? <Rows rows={it.fixed_token} label={`Fixed tokens, ${it.chain}`} symbol={symbol} /> : <p className="none">{it.note}</p>}
      <button
        type="button"
        className="btn btn-sm"
        disabled={busy}
        aria-busy={busy || undefined}
        data-key={`fx-xc-quote-${it.target_id}`}
        title={`Asks ${it.provider} for one quote for ${ref.tokens}${symbol ? ` ${symbol}` : ''}: a keyless read inside the monitor's request budget. Never a transaction, a signature or a wallet.`}
        onClick={async () => {
          setBusy(true);
          try {
            const out = await api.post(`/api/projects/${enc(pid)}/forensics/exit-compare/quote`, { target_id: it.target_id, amount_in: ref.amount_in, request_id: rid });
            const o = out.result && out.result.observation;
            toast((out.result && out.result.status) === 'unchanged' ? 'Already quoted: nothing new was asked' : o && o.status === 'quoted' ? 'Quote saved: a hypothetical exit, never a transaction' : `Saved: ${o ? (o.status === 'no_route' ? 'no route at this quantity' : o.error || o.status) : 'no answer'}`);
            setRid(requestId('xq'));
            await refresh();
          } catch (err) {
            toast(err.status === 401 ? 'Your session has ended. Sign in again to ask for a quote.' : err.message, 'bad');
            if (err.status && err.status < 500) setRid(requestId('xq'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Asking for the quote…' : 'Quote this quantity now'}
      </button>
    </article>
  );
}

export function ExitCompare({ v, pid, symbol }) {
  const c = v.exit_compare;
  if (!c) return null;
  return (
    <section className="fx-card fx-xcs" aria-labelledby="fx-xc-h" data-key="fx-exit-compare">
      <div className="fx-head">
        <h2 id="fx-xc-h" className="fx-h" tabIndex={-1}>Exit at a fixed quantity</h2>
        <span className="fx-head-sub">Hypothetical, never transactions</span>
      </div>
      {c.status === 'unavailable' ? <p className="none">{c.reason}</p> : c.items.map((it) => <Chain key={it.target_id} pid={pid} it={it} symbol={symbol} size={c.size_usd} />)}
      {c.note ? <p className="faint fx-act-note">{c.note}</p> : null}
    </section>
  );
}
