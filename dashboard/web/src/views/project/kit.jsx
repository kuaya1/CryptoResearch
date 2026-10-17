// The project page's shared parts for its sections (Level 2, DESIGN_AND_IA
// _BLUEPRINT.md §3.3): a panel (a white card with a head band and a hairline,
// no shadow), a fold (a <details> an address can name with ?open=, its state
// kept for the page's life so a live redraw never closes what you opened),
// facts as a definition list, a pager for long lists, a text asked for only
// when it is shown (an original, a prompt, a normalized record: immutable, so
// kept once read), copy and external links. Drawing any of them writes
// nothing and asks no provider. Styles: styles/l2.css.
import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { safeUrl, copyText, toast } from '../../../../public/ui.js';
import { api } from '../../lib/desk.js';

export const enc = encodeURIComponent;
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- panel ---------------------------------------------------------------------------

export function Panel({ id, title, sub = null, actions = null, children, className = '', dataKey, note = null }) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section className={`l2-panel ${className}`.trim()} id={id} aria-labelledby={title ? hid : undefined} data-key={dataKey}>
      {title ? (
        <header className="l2-panel-head">
          <h2 className="l2-panel-t" id={hid} tabIndex={-1} title={note || undefined}>{title}</h2>
          {sub ? <span className="l2-panel-sub">{sub}</span> : null}
          {actions ? <div className="l2-panel-act">{actions}</div> : null}
        </header>
      ) : null}
      <div className="l2-panel-body">{children}</div>
    </section>
  );
}

// ---- fold ----------------------------------------------------------------------------

// Open state per fold, for the page's life (a live update redraws the tab).
const openFolds = new Map();

export function Fold({ dataKey, title, note = null, count = null, defaultOpen = false, lazy = false, children, className = '', id = null }) {
  const [open, setOpen] = useState(() => (openFolds.has(dataKey) ? openFolds.get(dataKey) : defaultOpen));
  const [seen, setSeen] = useState(open);
  return (
    <details
      className={`l2-fold ${className}`.trim()}
      data-key={dataKey}
      id={id || dataKey}
      open={open}
      onToggle={(e) => {
        const o = e.currentTarget.open;
        openFolds.set(dataKey, o);
        if (o !== open) setOpen(o);
        if (o && !seen) setSeen(true);
      }}
    >
      <summary data-key={`${dataKey}-summary`} title={note || undefined}>
        <span className="l2-fold-t">{title}</span>
        {count !== null && count !== undefined ? <span className="l2-count" aria-label={typeof count === 'number' ? `${count}` : undefined}>{count}</span> : null}
      </summary>
      <div className="l2-fold-body">{!lazy || seen || open ? children : null}</div>
    </details>
  );
}

// ---- facts ---------------------------------------------------------------------------

// rows: [label, value, title?, wide?]; a row whose value is null, undefined
// or '' is left out (never drawn as a blank).
export function KV({ rows, className = '', label = null }) {
  const list = (rows || []).filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '');
  if (!list.length) return null;
  return (
    <dl className={`l2-kv ${className}`.trim()} aria-label={label || undefined}>
      {list.map(([k, v, title, wide]) => (
        <div key={k} className={wide ? 'is-wide' : undefined} title={title || undefined}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function None({ children }) {
  return <p className="none">{children}</p>;
}

// ---- pager ---------------------------------------------------------------------------

// A page of a long list (the desk-wide evidence rendered 766k characters at
// once): the page resets when the list's filters change (resetKey).
export function usePager(items, size = 25, resetKey = '') {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [resetKey]);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(page, pages - 1);
  const slice = useMemo(() => items.slice(p * size, p * size + size), [items, p, size]);
  return { page: p, pages, total, size, slice, from: total ? p * size + 1 : 0, to: Math.min(total, (p + 1) * size), setPage };
}

export function Pager({ pager, label, dataKey }) {
  if (!pager || pager.pages <= 1) return null;
  return (
    <nav className="l2-pager" aria-label={label}>
      <span className="l2-pager-n" aria-live="polite">{`${pager.from}–${pager.to} of ${pager.total}`}</span>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Previous page" disabled={pager.page === 0} data-key={`${dataKey}-prev`} onClick={() => pager.setPage(pager.page - 1)}><ChevronLeft size={15} aria-hidden="true" /></button>
      <span className="l2-pager-p">{`Page ${pager.page + 1} of ${pager.pages}`}</span>
      <button type="button" className="btn btn-sm btn-icon" aria-label="Next page" disabled={pager.page >= pager.pages - 1} data-key={`${dataKey}-next`} onClick={() => pager.setPage(pager.page + 1)}><ChevronRight size={15} aria-hidden="true" /></button>
    </nav>
  );
}

// ---- lazy text -----------------------------------------------------------------------

// GET a text the desk serves (an original report, a run's exact prompt, a
// normalized record, a partial answer): asked for once when first shown and
// kept, since these never change once saved. A read only.
const textCache = new Map();
export function useLazyText(path, enabled = true) {
  const [st, setSt] = useState(() => (textCache.has(path) ? { text: textCache.get(path), error: null } : { text: null, error: null }));
  useEffect(() => {
    if (!enabled || !path) return undefined;
    if (textCache.has(path)) {
      setSt({ text: textCache.get(path), error: null });
      return undefined;
    }
    const ctrl = new AbortController();
    setSt({ text: null, error: null });
    api.text(path, { signal: ctrl.signal }).then(
      (text) => { textCache.set(path, text); if (!ctrl.signal.aborted) setSt({ text, error: null }); },
      (error) => { if (!ctrl.signal.aborted && error.name !== 'AbortError') setSt({ text: null, error }); },
    );
    return () => ctrl.abort();
  }, [path, enabled]);
  return st;
}
export const cachedText = (path) => (textCache.has(path) ? textCache.get(path) : null);
export async function readText(path) {
  if (textCache.has(path)) return textCache.get(path);
  const t = await api.text(path);
  textCache.set(path, t);
  return t;
}

// A <pre> filled from a lazy text, its scroll kept across redraws.
export function LazyPre({ path, loading = 'Loading…', failed = 'Could not be loaded', keepScroll = null, className = '' }) {
  const { text, error } = useLazyText(path);
  return (
    <pre className={`l2-pre ${className}`.trim()} data-keep-scroll={keepScroll || undefined} tabIndex={0} aria-busy={text === null && !error ? 'true' : undefined}>
      {error ? `${failed}: ${error.message}` : text === null ? loading : text}
    </pre>
  );
}

// ---- small controls -----------------------------------------------------------------

export function CopyButton({ text = null, getText = null, label = 'Copy', dataKey, className = 'btn btn-sm', title = null }) {
  return (
    <button
      type="button"
      className={className}
      data-key={dataKey}
      title={title || undefined}
      onClick={async () => {
        try {
          await copyText(getText ? await getText() : text);
        } catch (err) {
          toast(err.message, 'bad');
        }
      }}
    >
      <Copy size={13} aria-hidden="true" />{label}
    </button>
  );
}

// An external link: http(s) only (ui.js safeUrl), a new tab, no referrer.
export function ExtLink({ href, children, title = null, dataKey, className = '' }) {
  const u = safeUrl(href);
  if (!u || u.startsWith('#/') || u.startsWith('/api/')) return <span className={className}>{children}</span>;
  return (
    <a className={`l2-ext ${className}`.trim()} href={u} target="_blank" rel="noopener noreferrer nofollow" title={title || undefined} data-key={dataKey}>
      {children}<ArrowUpRight size={12} aria-hidden="true" />
    </a>
  );
}

// A segmented choice inside a section (Forensics: Assessment | Exits |
// Timeline | Receipts): one level deep, never nested further.
export function Segments({ value, options, onChange, label, dataKey = 'seg' }) {
  return (
    <div className="l2-seg" role="group" aria-label={label}>
      {options.map(([v, text, count]) => (
        <button key={v} type="button" aria-pressed={v === value} data-key={`${dataKey}-${v}`} onClick={() => { if (v !== value) onChange(v); }}>
          {text}{count !== undefined && count !== null ? <span className="l2-count">{count}</span> : null}
        </button>
      ))}
    </div>
  );
}
