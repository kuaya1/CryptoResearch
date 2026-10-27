// The Pipeline cockpit (#/pipeline, 2026-10-27): where the self-building
// codebase stands. GET /api/pipeline (core/pipeline.js) drawn through
// public/pipeline-progress.js: overall completion, the split by lane
// template, the stage working now, today's builds and the pace. Opening it
// reads and writes nothing; an unknown part says so in words.
import { useEffect, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../../lib/desk.js';
import { cockpit, NODES } from '../../../../public/pipeline-progress.js';
import '../../styles/pipeline.css';

// Read within the same bound as the Daily Brief (L3): a busy desk is said
// with Try again, never an endless wait.
export const PIPELINE_WAIT_MS = 12000;

function Meter({ pct, label, tone = 'ink', big = false }) {
  const known = Number.isFinite(pct);
  return (
    <div
      className={`pl-track${big ? ' is-big' : ''}${known ? '' : ' is-unknown'}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? pct : undefined}
      aria-valuetext={known ? `${pct}%` : 'Unknown'}
    >
      {known ? <span className={`pl-fill is-${tone}`} style={{ width: `${pct}%` }} /> : null}
    </div>
  );
}

function Topology({ node }) {
  return (
    <ol className="pl-flow" aria-label={`Pipeline: ${node.words}`}>
      {NODES.map((s, i) => {
        const active = node.active === s.id;
        const count = node.counts[s.id];
        const label = `${s.label}${s.who ? ` (${s.who})` : ''}: ${count === null ? 'count unknown' : `${count} ${count === 1 ? 'item' : 'items'}`}${active ? `, ${node.words.toLowerCase()}` : ''}`;
        return (
          <li key={s.id} className={`pl-node${active ? ' is-active' : ''}`} aria-label={label} aria-current={active ? 'step' : undefined}>
            {i > 0 ? <span className="pl-link" aria-hidden="true" /> : null}
            <div className="pl-box">
              <span className="pl-dot" aria-hidden="true" />
              <span className="pl-name">{s.label}</span>
              {s.who ? <span className="pl-who">{s.who}</span> : null}
              <span className="pl-count">{count === null ? '—' : count}</span>
              {active ? <span className="pl-state">{node.words}</span> : null}
            </div>
            {s.id === 'sandbox' && node.remediating ? (
              <span className="pl-loop" title="A revision after review is running">
                <RotateCcw size={14} aria-hidden="true" />Revising
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function PipelineCockpit() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api.get('/api/pipeline', { timeoutMs: PIPELINE_WAIT_MS }).then(
      (data) => { if (live) setState({ loading: false, error: null, data }); },
      (e) => { if (live) setState({ loading: false, error: (e && e.message) || 'The pipeline could not be read.', data: null }); },
    );
    return () => { live = false; };
  }, [tick]);

  const c = state.data ? cockpit(state.data) : null;
  return (
    <div className="pl">
      <header className="page-head">
        <div className="ph-title"><p className="ph-eyebrow">CryptoResearch</p><h1>Pipeline</h1></div>
        <button type="button" className="btn btn-sm" onClick={() => setTick((n) => n + 1)} disabled={state.loading} data-key="pl-refresh">
          <RefreshCw size={14} aria-hidden="true" />Refresh
        </button>
      </header>
      {state.loading && !c ? <p role="status" className="pl-note">Loading Pipeline…</p> : null}
      {state.error ? (
        <div className="pl-card pl-error" role="alert">
          <p>{state.error}</p>
          <button type="button" className="btn btn-sm" onClick={() => setTick((n) => n + 1)}>Try again</button>
        </div>
      ) : null}
      {c ? (
        <div className="pl-grid" aria-busy={state.loading}>
          <section className="pl-card pl-span" aria-labelledby="pl-flow-h">
            <div className="pl-card-head">
              <h2 id="pl-flow-h">Topology</h2>
              <span className={`pl-badge${c.node.active ? ' is-live' : ''}`}>{c.node.words}</span>
            </div>
            <Topology node={c.node} />
            {c.node.partial ? <p className="pl-note" title="Counts come only from what this copy can read: the waiting branches and claims need a git remote, today's builds the agent ledger's local copy, grooming the engineering inbox.">Partial reading</p> : null}
          </section>

          <section className="pl-card pl-span" aria-labelledby="pl-all-h">
            <h2 id="pl-all-h" className="sr-only">Overall progress</h2>
            {c.macro.known ? (
              <>
                <p className="pl-hero">
                  <span className="pl-pct">{c.macro.pct === null ? '—' : `${c.macro.pct}%`}</span>
                  <span className="pl-hero-words">complete · {c.macro.done} of {c.macro.total} items built</span>
                </p>
                <Meter big pct={c.macro.pct} label="Overall progress" />
                <p className="pl-sub">
                  <span>{c.macro.in_flight === null ? 'In flight unknown' : `${c.macro.in_flight} in flight`}</span>
                  <span>{Math.max(0, c.macro.total - c.macro.done - (c.macro.in_flight || 0))} not started</span>
                </p>
              </>
            ) : <p className="pl-note">The backlog could not be read in this copy.</p>}
          </section>

          <section className="pl-card" aria-labelledby="pl-cat-h">
            <h2 id="pl-cat-h">By category</h2>
            <ul className="pl-cats">
              {c.categories.rows.map((r) => (
                <li key={r.id} className="pl-cat">
                  <div className="pl-cat-head">
                    <span className="pl-cat-name">{r.label}</span>
                    <span className="pl-tag">{r.template}</span>
                    <span className="pl-cat-fig">{r.pct === null ? '—' : `${r.pct}%`}</span>
                  </div>
                  <Meter pct={r.pct} label={`${r.label}: ${r.done} of ${r.total} built`} />
                  <span className="pl-cat-count">{r.done} of {r.total}</span>
                </li>
              ))}
            </ul>
            {c.categories.unsorted ? <p className="pl-note" title="Items whose text names no file are counted in the total and in no category.">{c.categories.unsorted} unsorted</p> : null}
          </section>

          <section className="pl-card" aria-labelledby="pl-pace-h">
            <h2 id="pl-pace-h">Pace and rhythm</h2>
            <div className="pl-pace">
              <p className="pl-fig-label">Agent lane today</p>
              <p className="pl-fig" title={c.builds.why || undefined}>{c.builds.words}</p>
              <Meter pct={c.builds.known ? c.builds.pct : null} tone={c.builds.known && c.builds.used >= c.builds.limit ? 'warn' : 'ink'} label="Daily builds used" />
            </div>
            <div className="pl-pace">
              <p className="pl-fig-label">Pace</p>
              <p className="pl-fig"><span className="pl-badge" title={c.pace.why || c.pace.detail || undefined}>{c.pace.words}</span></p>
              {c.pace.detail ? <p className="pl-sub"><span>{c.pace.detail}</span></p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
