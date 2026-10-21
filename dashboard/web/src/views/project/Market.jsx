// The Market section (#/project/<id>/market; DESIGN_AND_IA_BLUEPRINT.md
// §3.3): the market now (price, changes over 24 hours, 7 and 30 days with two
// decimals, against Bitcoin, rank, caps, FDV, volume, supply), the DEX pools
// (chain and pool live here, asked of DexScreener in the browser on demand
// only, never stored), DefiLlama's dated daily fees, revenue and holders
// revenue as saved (each its own chart over the 30 completed UTC days; a day
// DefiLlama did not report is drawn as missing, never as zero), the on-chain
// activity no source provides (said so), the technical chart and your
// position. Drawing it writes nothing and asks no paid provider.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtPrice, fmtCompactUsd, fmtDateTime, fmtDate, fmtAgo, freshnessText, fmtNum } from '../../../../public/ui.js';
import { marketStrings, rowProject, defillamaBound, taxRevenueNote } from '../../../../public/watchlist-model.js';
import { legacyCtx } from '../../legacy/ctx.js';
import { api } from '../../lib/desk.js';
import { PROVIDER_LABELS } from '../../../../public/ui.js';
import { Dom } from '../../components/Dom.jsx';
import { Change, Spark, Unknown, UnknownFigure } from '../../components/figures.jsx';
import { Panel, KV, None, ExtLink, enc } from './kit.jsx';

const DAY = 86400000;
const METRICS = [['fees', 'Fees'], ['revenue', 'Revenue'], ['holders_revenue', 'Holders revenue']];
const supplyWords = (v) => (typeof v === 'number' && Number.isFinite(v) ? fmtNum(v, 0) : null);

function MarketNow({ d, row }) {
  const m = d.market;
  const identityPending = d.project.identity && d.project.identity.status !== 'verified';
  if (!m) return <None>{identityPending ? 'Identity pending: no token is bound, so no prices are fetched. Another token\'s prices are never used.' : 'No CoinGecko listing is recorded, so there is no price source.'}</None>;
  if (m.status === 'missing') return <None>{`No observation for ${m.coingecko_id} yet. Prices refresh every few minutes while the desk is open and hourly through the scheduled task.`}</None>;
  const s = marketStrings(m) || {};
  const f = freshnessText(m.status, m.age_minutes);
  const vs = m.vs_btc || (row.market && row.market.vs_btc) || null;
  const demo = m.rank_source_label && /fictional/i.test(m.rank_source_label);
  const full = (v) => (typeof v === 'number' && Number.isFinite(v) ? `$${Math.round(v).toLocaleString('en-US')}` : null);
  return (
    <>
      <div className="mk-now">
        <span className="mk-price">{s.price}</span>
        <Change value={m.change_24h_pct} label="over 24 hours" className="mk-chg" />
        <span className={`mk-when${m.status === 'fresh' ? '' : ' is-stale'}`} title={`${demo ? 'Fictional demo data' : `Source: ${m.source || 'CoinGecko'}`}, as of ${fmtDateTime(m.as_of)}`}>{m.status === 'fresh' ? `Updated ${fmtAgo(m.fetched_at || m.as_of)}` : f.text}</span>
      </div>
      {Array.isArray(m.sparkline_7d) && m.sparkline_7d.length ? (
        <div className="mk-spark" title="7-day series from the provider. Prices never change stored grades or report conclusions.">
          <Spark values={m.sparkline_7d} change={m.change_7d_pct} width={640} height={96} label={`${d.project.symbol || d.project.name} price over 7 days`} />
        </div>
      ) : null}
      <KV
        label="Market figures"
        rows={[
          ['24H change', <Change value={m.change_24h_pct} label="over 24 hours" />],
          ['7D change, rolling', <Change value={m.change_7d_pct} label="over 7 days" />],
          ['30D change, rolling', <Change value={m.change_30d_pct} label="over 30 days" />],
          ['Against BTC, 7D', vs ? <Change value={vs.vs_btc_7d_pct} label="against Bitcoin over 7 days" /> : <Unknown label="Against BTC, 7 days" reason="No Bitcoin comparison stored" />, vs ? vs.definition : null],
          ['Against BTC, 30D', vs ? <Change value={vs.vs_btc_30d_pct} label="against Bitcoin over 30 days" /> : <Unknown label="Against BTC, 30 days" reason="No Bitcoin comparison stored" />, vs ? vs.definition : null],
          [demo ? 'Rank (demo data)' : 'Rank', m.market_cap_rank ? `#${m.market_cap_rank}${m.rank_source_label ? ` · ${m.rank_source_label}` : ''}` : 'Unranked'],
          ['Market cap', s.mcap ? <span title={full(m.market_cap_usd) || undefined}>{s.mcap}</span> : <UnknownFigure label="Market cap" value={m.market_cap_usd} />],
          ['Market cap, 24H change', <Change value={m.market_cap_change_24h_pct} label="market cap over 24 hours" />],
          ['Fully diluted valuation', s.fdv ? <span title={full(m.fdv_usd) || undefined}>{s.fdv}</span> : <UnknownFigure label="FDV" value={m.fdv_usd} />],
          ['FDV / market cap', s.fdvMc || <Unknown label="FDV over market cap" />, 'From the two figures shown'],
          ['Volume, last 24h', s.volume || <UnknownFigure label="Volume" value={m.volume_24h_usd} />],
          ['Volume vs ~24h ago', typeof m.volume_change_24h_pct === 'number' ? <Change value={m.volume_change_24h_pct} label="volume against about 24 hours earlier" /> : <span className="unknown">{`Unknown${m.volume_change_basis ? `: ${m.volume_change_basis}` : ''}`}</span>],
          ['Circulating supply', supplyWords(m.circulating_supply) || <Unknown label="Circulating supply" />],
          ['Total supply', supplyWords(m.total_supply) || <Unknown label="Total supply" />],
          ['Max supply', supplyWords(m.max_supply) || <Unknown label="Max supply" reason="No maximum reported" />],
          ['Source timestamp', `${fmtDateTime(m.as_of)} (${demo ? 'fictional demo data' : m.source || 'CoinGecko'})`, null, true],
          ['Fetched', m.fetched_at ? fmtDateTime(m.fetched_at) : null],
        ]}
      />
    </>
  );
}

// ---- DefiLlama's daily series --------------------------------------------------------

function windowDays(win) {
  if (!win || !win.start || !win.end) return [];
  const out = [];
  for (let t = Date.parse(`${win.start}T00:00:00Z`), end = Date.parse(`${win.end}T00:00:00Z`); t <= end && out.length < 400; t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

const usdShort = (v) => (v === 0 ? '$0' : Math.abs(v) >= 1000 ? fmtCompactUsd(v) : fmtPrice(v));

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return w;
}

// One series, one axis: a column per completed UTC day in ink (a single
// series needs no legend; the title names it). A missing day is a dashed stub
// at the baseline, never a zero; a zero is a hairline on the baseline. The
// readout follows the pointer and the arrow keys; every value is also in the
// table under it.
function SeriesChart({ id, title, metric, days }) {
  const wrap = useRef(null);
  const width = Math.max(240, useWidth(wrap) || 560);
  const [at, setAt] = useState(null);
  const values = days.map((day) => (metric.daily && typeof metric.daily[day] === 'number' ? metric.daily[day] : null));
  const top = niceMax(Math.max(0, ...values.filter((v) => v !== null)));
  const H = 150;
  const pad = { l: 46, r: 8, t: 10, b: 22 };
  const plotW = width - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const band = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (v) => pad.t + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const active = at !== null && at >= 0 && at < days.length ? at : null;
  const pick = (clientX) => {
    const r = wrap.current.getBoundingClientRect();
    const i = Math.floor((clientX - r.left - pad.l) / band);
    setAt(Math.max(0, Math.min(days.length - 1, i)));
  };
  const reported = values.filter((v) => v !== null).length;
  const summary = `${title}, daily, ${days.length ? `${fmtDate(days[0])} to ${fmtDate(days[days.length - 1])}` : 'no window'}: ${reported} of ${days.length} days reported${metric.total_30d_usd !== null && metric.total_30d_usd !== undefined ? `, total ${usdShort(metric.total_30d_usd)}` : ''}. Use the arrow keys to read each day.`;
  return (
    <div className="mk-chart" ref={wrap}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={summary}
        tabIndex={0}
        data-key={`mk-chart-${id}`}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
        onKeyDown={(e) => {
          const i = active === null ? days.length - 1 : active;
          const to = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1 : null;
          if (to === null) return;
          e.preventDefault();
          setAt(Math.max(0, Math.min(days.length - 1, to)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className="mk-grid" x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
            <text className="mk-tick" x={pad.l - 6} y={y(t) + 4} textAnchor="end">{usdShort(t)}</text>
          </g>
        ))}
        {values.map((v, i) => {
          const x = pad.l + i * band + (band - barW) / 2;
          if (v === null) return <rect key={days[i]} className={`mk-missing${i === active ? ' is-on' : ''}`} x={x} y={y(0) - 6} width={barW} height={6} />;
          if (v <= 0) return <rect key={days[i]} className={`mk-zero${i === active ? ' is-on' : ''}`} x={x} y={y(0) - 1} width={barW} height={2} />;
          const h = Math.max(2, y(0) - y(v));
          const r = Math.min(4, barW / 2, h);
          // A 4px rounded top, square at the baseline.
          const path = `M${x},${y(0)} V${y(0) - h + r} Q${x},${y(0) - h} ${x + r},${y(0) - h} H${x + barW - r} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + r} V${y(0)} Z`;
          return <path key={days[i]} className={`mk-bar${i === active ? ' is-on' : ''}`} d={path} />;
        })}
        {days.length ? (
          <>
            <text className="mk-tick" x={pad.l} y={H - 6} textAnchor="start">{fmtDate(days[0]).replace(/, \d{4}$/, '')}</text>
            <text className="mk-tick" x={width - pad.r} y={H - 6} textAnchor="end">{fmtDate(days[days.length - 1]).replace(/, \d{4}$/, '')}</text>
          </>
        ) : null}
        {active !== null ? <line className="mk-cross" x1={pad.l + active * band + band / 2} x2={pad.l + active * band + band / 2} y1={pad.t} y2={y(0)} /> : null}
      </svg>
      {active !== null ? (
        <div className="mk-tip" role="status" style={{ left: `${Math.min(width - 150, Math.max(0, pad.l + active * band + band / 2 - 70))}px` }}>
          <strong>{values[active] === null ? 'Not reported' : usdShort(values[active])}</strong>
          <span>{fmtDate(days[active])}</span>
        </div>
      ) : null}
    </div>
  );
}

function Fundamentals({ d, row }) {
  const f = d.fundamentals;
  const bound = defillamaBound(row.fundamentals || f);
  const win = (f && f.window) || null;
  const days = useMemo(() => windowDays(win), [win && win.start, win && win.end]);
  if (!f || !bound) {
    return (
      <None>{(f && f.reason) || (row.fundamentals && row.fundamentals.reason) || 'No DefiLlama entity is bound to this project, so no fees or revenue are supplied.'}</None>
    );
  }
  const b = f.binding || {};
  const taxNote = taxRevenueNote(row.screening, f);
  return (
    <>
      {taxNote ? <p className="l2-note is-warn" data-key="mk-tax-revenue">{taxNote}</p> : null}
      <p className="mk-src">
        <span>{`DefiLlama ${b.scope || f.scope || ''} ${b.slug || f.slug || ''}`.replace(/\s+/g, ' ').trim()}</span>
        {win ? <span className="faint">{` · 30 completed UTC days, ${fmtDate(win.start)} to ${fmtDate(win.end)}`}</span> : null}
        {f.fetched_at ? <span className="faint">{` · fetched ${fmtAgo(f.fetched_at)}`}</span> : null}
        {f.state === 'stale' ? <span className="badge is-warn">Stale</span> : null}
        {b.source_url ? <ExtLink href={b.source_url} dataKey="mk-binding-src">How the binding was checked</ExtLink> : null}
      </p>
      {f.reason ? <p className="l2-note">{f.reason}</p> : null}
      {f.token_link_note ? <p className="l2-note">{f.token_link_note}</p> : null}
      <div className="mk-series">
        {METRICS.map(([key, label]) => {
          const x = f.metrics && f.metrics[key];
          if (!x) return null;
          const cov = x.coverage;
          const total = typeof x.total_30d_usd === 'number' ? usdShort(x.total_30d_usd) : null;
          return (
            <section key={key} className="mk-metric" aria-labelledby={`mk-h-${key}`}>
              <header className="mk-metric-head">
                <h3 id={`mk-h-${key}`} title={x.definition || undefined}>{x.label || label}</h3>
                <span className="mk-total">
                  {x.status === 'unsupported' ? 'Not reported by DefiLlama for this entity'
                    : total ? <><strong>{total}</strong><span className="faint"> over 30 days</span></>
                      : typeof x.observed_subtotal_usd === 'number' ? <><strong>{usdShort(x.observed_subtotal_usd)}</strong><span className="faint">{` over ${cov ? cov.observed_days : '?'} reported days · not a 30-day total`}</span></>
                        : <span className="faint">No total</span>}
                </span>
              </header>
              {x.status === 'unsupported' ? null : <SeriesChart id={key} title={x.label || label} metric={x} days={days} />}
              {cov && cov.missing_dates && cov.missing_dates.length ? <p className="l2-note">{`${cov.missing_dates.length} of ${cov.expected_days} days not reported${cov.conflicting_dates && cov.conflicting_dates.length ? `; ${cov.conflicting_dates.length} left out as reported twice with different values` : ''}.`}</p> : null}
              {x.reason ? <p className="l2-note">{x.reason}</p> : null}
              {days.length && x.status !== 'unsupported' ? (
                <details className="l2-fold mk-table" data-key={`mk-table-${key}`}>
                  <summary><span className="l2-fold-t">Daily values</span></summary>
                  <div className="l2-fold-body l2-table-wrap">
                    <table className="l2-table">
                      <thead><tr><th scope="col">Day (UTC)</th><th scope="col" className="num">{x.label || label}</th></tr></thead>
                      <tbody>{[...days].reverse().map((day) => <tr key={day}><td>{fmtDate(day)}</td><td className="num">{typeof x.daily[day] === 'number' ? usdShort(x.daily[day]) : <span className="unknown">Not reported</span>}</td></tr>)}</tbody>
                    </table>
                  </div>
                </details>
              ) : null}
              {x.source_url ? <p className="l2-note"><ExtLink href={x.source_url} dataKey={`mk-src-${key}`}>DefiLlama's data for this metric</ExtLink></p> : null}
            </section>
          );
        })}
      </div>
    </>
  );
}

// What happened after each of this project's reports (core/report-outcomes.js):
// the return against BTC from the research run's start, at 30, 60, 90 and
// 120 days. Read when the section opens; nothing is written or fetched from
// a provider.
const signedPct = (x) => (typeof x === 'number' ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}%` : '—');
function Outcomes({ pid }) {
  const [st, setSt] = useState({ pid: null, data: null, error: null });
  useEffect(() => {
    let alive = true;
    api.get(`/api/projects/${enc(pid)}/outcomes`).then((data) => { if (alive) setSt({ pid, data, error: null }); }, (error) => { if (alive) setSt({ pid, data: null, error }); });
    return () => { alive = false; };
  }, [pid]);
  if (st.pid !== pid) return <p className="faint" aria-busy="true">Reading the price records…</p>;
  if (st.error) return <None>{`Outcomes could not be read: ${st.error.message}`}</None>;
  const o = st.data;
  if (!o.reports.length) return <None>No eligible report yet.</None>;
  const days = o.horizons_days;
  const cell = (h) => {
    if (!h) return '—';
    if (h.status === 'pending') return <span className="faint">{`Due ${fmtDate(h.due)}`}</span>;
    if (h.status === 'no_price') return <span className="faint" title={h.reason}>No price</span>;
    return <span className={h.vs_btc_pct > 0 ? 'pos' : h.vs_btc_pct < 0 ? 'neg' : ''} title={`${signedPct(h.return_pct)} against BTC's ${signedPct(h.btc_return_pct)}, ${fmtDate(h.at)}`}>{signedPct(h.vs_btc_pct)}</span>;
  };
  const rows = o.reports.slice().sort((a, b) => String(b.start.at || '').localeCompare(String(a.start.at || '')));
  return (
    <div className="l2-table-wrap">
      <table className="l2-table">
        <thead><tr><th scope="col">Report</th><th scope="col">Verdict</th><th scope="col">Start</th>{days.map((x) => <th key={x} scope="col" className="num">{`${x}d vs BTC`}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.report_id}>
              <td><a href={`#/project/${enc(pid)}/report?report=${enc(r.report_id)}`} data-key={`mk-out-${r.report_id}`}>{PROVIDER_LABELS[r.provider] || r.provider}</a>{r.grade && r.grade.display ? <span className="faint">{` · ${r.grade.display}`}</span> : null}</td>
              <td>{r.verdict ? r.verdict.charAt(0) + r.verdict.slice(1).toLowerCase() : '—'}</td>
              <td title={r.note || (r.start.basis === 'run_packet' ? "When the research run's evidence packet was captured" : 'When the report was saved (it answers no run)')}>{r.start.project ? `${fmtDate(r.start.at)} · ${fmtPrice(r.start.project.price_usd)}` : <span className="faint">No price</span>}</td>
              {days.map((x) => <td key={x} className="num">{cell(r.horizons.find((h) => h.days === x))}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Market({ d, row, pid }) {
  const pos = d.position && !d.position.closed ? d.position : null;
  const proj = useMemo(() => rowProject({ ...row, project_id: pid, name: d.project.name, symbol: d.project.symbol }), [row, pid]);
  return (
    <div className="l2-stack mk">
      <Panel id="mk-now" title="Market data" sub={d.market && d.market.source ? d.market.source : null}>
        <MarketNow d={d} row={row} />
      </Panel>
      <div className="l2-grid2">
        <Panel id="mk-dex" title="DEX liquidity and pools" note="Asked of DexScreener in the browser when shown, for the verified contracts only; nothing is stored. DEX pools only: centralized exchanges are not counted.">
          <Dom className="mk-dex" build={(L) => L.dexCard(legacyCtx, proj)} deps={[pid]} />
        </Panel>
        <Panel id="mk-onchain" title="On-chain activity" note="No on-chain data source (such as Artemis) is set up; nothing is estimated.">
          <KV rows={[['Daily active addresses', <Unknown label="Daily active addresses" reason="No on-chain source is connected" />], ['Transactions', <Unknown label="Transactions" reason="No on-chain source is connected" />], ['TVL', <Unknown label="TVL" reason="No on-chain source is connected" />]]} />
          <p><span className="badge">Not connected</span></p>
        </Panel>
      </div>
      <Panel id="mk-fund" title="Fees and revenue (DefiLlama)" note="Dated daily series as saved for the latest 30 completed UTC days; fees, revenue and holders revenue stay separate and no valuation ratio is computed. A partial month is not a total.">
        <Fundamentals d={d} row={row} />
      </Panel>
      <Panel id="mk-outcomes" title="After each report" note="Return against BTC from each research run's start, at 30, 60, 90 and 120 days, from the desk's hourly price records; nothing interpolated. Not a forecast or an accuracy figure; it changes no grade.">
        <Outcomes pid={pid} />
      </Panel>
      <Panel id="mk-chart" title="Technical chart">
        <Dom className="chart-slot mk-tv" build={(L) => L.technicalChart(legacyCtx, d.project)} deps={[pid]} />
      </Panel>
      {pos ? (
        <Panel id="mk-pos" title="Your position">
          <p>{`You hold ${fmtNum(pos.quantity)} ${pos.symbol || d.project.symbol || ''} ${typeof pos.value_usd === 'number' ? `worth ${fmtPrice(pos.value_usd)}` : '(value unknown: no usable price)'}. `}<a href="#/portfolio" data-key="mk-portfolio">Open Portfolio</a></p>
        </Panel>
      ) : null}
      <p className="l2-note"><a href={`#/project/${enc(pid)}/contract`} data-key="mk-contract">Contract and security checks are on the Contract section</a></p>
    </div>
  );
}
