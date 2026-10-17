// The Preferences drawer (DESIGN_AND_IA_BLUEPRINT.md §3.6; ⌘, or Ctrl+,, the
// rail's Preferences, ?prefs=<section> on any page): the former Settings page
// in eight sections over the page you were on. Appearance, Models & budget,
// Rubrics, Data (the dashboard settings and backups and exports), System and
// Activity are the same cards and forms as before (views/settings.js
// prefsSection); Screening edits your forensic screening preferences (D5);
// Developer holds the Explorer (D4) and the running code. Opening it writes
// nothing; each save is its own button.
import { useEffect, useRef, useState } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { toast } from '../../../public/ui.js';
import { useDesk, useMedia } from '../lib/hooks.js';
import { api, refresh } from '../lib/desk.js';
import { legacyCtx } from '../legacy/ctx.js';
import { Dom } from '../components/Dom.jsx';
import { PREF_SECTIONS, prefsOf, openPrefs, closePrefs, deskPrefs } from './overlays.js';
import { ui } from '../lib/desk.js';
import { prefs as readPrefs, VIEWS, DEFAULT_COLUMNS } from '../../../public/watchlist-model.js';
import '../styles/overlays.css';

// ---- Screening: forensics.preferences (core/forensics.js prefsOf) ---------------------------

const FIELDS = [
  ['exit_sizes_usd', 'Exit sizes (USD)', 'One to five amounts, separated by commas. Each is quoted on every chain you approve for a project, every 12 hours, within the monitor\'s request budget.'],
  ['exit_position_usd', 'Position size for exits (USD)', 'The size the Desk\'s Exit column and the liquidity outcome read the exit cost at.'],
  ['exit_cost_limit_pct', 'Exit cost limit (%)', 'An exit costing more than this (price impact plus fees) counts as beyond your limit.'],
  ['delivery_window_days', 'Delivery window (days)', 'Days without a release or commit before delivery reads inactive: 7 to 365.'],
  ['volume_review_fraction', 'Volume review fraction', 'A fall in 24h volume to this share of the audit\'s reading suggests a review: above 0, at most 1.'],
  ['reported_liquidity_review_usd', 'Reported liquidity review level (USD)', 'Optional. Reported liquidity below this suggests a review; empty for none.'],
  ['volume_to_liquidity_review_ratio', 'Volume to liquidity review ratio', 'Optional. 24h volume above this multiple of reported liquidity suggests a review; empty for none.'],
];
const OPTIONAL = new Set(['reported_liquidity_review_usd', 'volume_to_liquidity_review_ratio']);
const asText = (k, v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v));

function Screening({ d }) {
  const saved = (d.index.settings && d.index.settings.forensics && d.index.settings.forensics.preferences) || {};
  const savedKey = JSON.stringify(saved);
  const [form, setForm] = useState(() => Object.fromEntries(FIELDS.map(([k]) => [k, asText(k, saved[k])])));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const dirty = FIELDS.some(([k]) => form[k] !== asText(k, saved[k]));
  // A save elsewhere (another tab, Cowork) shows here when nothing is typed.
  useEffect(() => { if (!dirty) setForm(Object.fromEntries(FIELDS.map(([k]) => [k, asText(k, saved[k])]))); }, [savedKey]);
  const save = async () => {
    const out = {};
    for (const [k, label] of FIELDS) {
      const t = form[k].trim();
      if (k === 'exit_sizes_usd') {
        const parts = t.split(/[,\s]+/).filter(Boolean).map((x) => Number(x.replace(/[$_]/g, '')));
        if (!parts.length || parts.some((n) => !Number.isFinite(n))) { setErr(`${label}: give one to five amounts, such as 100, 500, 2000.`); return; }
        out[k] = parts;
      } else if (OPTIONAL.has(k) && t === '') out[k] = null;
      else {
        const n = Number(t.replace(/[$,_%]/g, ''));
        if (t === '' || !Number.isFinite(n)) { setErr(`${label}: a number is needed.`); return; }
        out[k] = n;
      }
    }
    setErr(null);
    setBusy(true);
    try {
      await api.post('/api/settings', { forensics: { preferences: out } });
      toast('Screening preferences saved. New forensic receipts freeze these values; saved receipts keep theirs.');
      await refresh();
    } catch (e) {
      setErr(e.message);
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="l2-panel" aria-labelledby="prefs-screening-h">
      <header className="l2-panel-head">
        <h3 className="l2-panel-t" id="prefs-screening-h" title="Your screening choices, not universal rules. Each new forensic receipt freezes the values in force; saved receipts and their outcomes keep theirs.">Your screening preferences</h3>
      </header>
      <div className="l2-panel-body">
        <form className="l2-form prefs-form" data-key="prefs-screening-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {FIELDS.map(([k, label, hint]) => (
            <label key={k} className="prefs-field" title={hint}>
              <span>{label}</span>
              <input
                className="input"
                type="text"
                inputMode="decimal"
                value={form[k]}
                aria-describedby={`prefs-hint-${k}`}
                placeholder={OPTIONAL.has(k) ? 'None' : ''}
                data-key={`prefs-${k}`}
                onChange={(e) => { setForm({ ...form, [k]: e.target.value }); setErr(null); }}
              />
              <span id={`prefs-hint-${k}`} className="sr-only">{hint}</span>
            </label>
          ))}
          {err ? <p className="l2-err" role="alert">{err}</p> : null}
          <div className="l2-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty} data-key="prefs-screening-save">{busy ? 'Saving…' : 'Save screening preferences'}</button>
            {dirty ? <button type="button" className="btn btn-ghost btn-sm" data-key="prefs-screening-undo" onClick={() => { setForm(Object.fromEntries(FIELDS.map(([k]) => [k, asText(k, saved[k])]))); setErr(null); }}>Discard changes</button> : null}
          </div>
        </form>
      </div>
    </section>
  );
}

// ---- Appearance: the Desk's density, opening view and columns -----------------------------------

function DeskDefaults() {
  const [pf, setPf] = useState(() => readPrefs({ ui }));
  const set = (patch) => {
    deskPrefs(patch);
    setPf({ ...pf, ...patch, filters: { ...pf.filters, ...(patch.filters || {}) } });
    toast('Saved for the Desk');
  };
  const custom = pf.columns.join(',') !== DEFAULT_COLUMNS.join(',');
  return (
    <section className="l2-panel" aria-labelledby="prefs-desk-h">
      <header className="l2-panel-head"><h3 className="l2-panel-t" id="prefs-desk-h" title="Kept for this desk; the Desk's own menus change the same choices.">The Desk</h3></header>
      <div className="l2-panel-body prefs-form">
        <label className="prefs-field"><span>Row density</span>
          <select className="input" value={pf.density} data-key="prefs-density" onChange={(e) => set({ density: e.target.value })}>
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label className="prefs-field"><span>View</span>
          <select className="input" value={pf.filters.owned} data-key="prefs-view" onChange={(e) => set({ filters: { owned: e.target.value } })}>
            {VIEWS.map(([v, w]) => <option key={v} value={v}>{w}</option>)}
          </select>
        </label>
        <div className="prefs-field"><span>Columns</span>
          <button type="button" className="btn btn-sm" disabled={!custom} data-key="prefs-reset-columns" onClick={() => set({ columns: DEFAULT_COLUMNS.slice() })}>{custom ? 'Reset to the seven defaults' : 'The seven defaults'}</button>
        </div>
      </div>
    </section>
  );
}

// ---- Developer: the Explorer (D4) and the running code ----------------------------------------

function Developer({ d }) {
  const r = d.session && d.session.revision;
  const ws = d.session && d.session.workspace;
  return (
    <div className="l2-stack">
      <section className="l2-panel" aria-labelledby="prefs-dev-explorer">
        <header className="l2-panel-head"><h3 className="l2-panel-t" id="prefs-dev-explorer" title="A one-way mirror of FICTIONAL demo records in the Supabase sandbox. Real records are never sent.">Research Explorer</h3></header>
        <div className="l2-panel-body">
          <a className="btn btn-sm" href="#/explorer" data-key="prefs-explorer" onClick={() => { closePrefs(); }}>Open the Explorer<ExternalLink size={13} aria-hidden="true" /></a>
        </div>
      </section>
      <section className="l2-panel" aria-labelledby="prefs-dev-code">
        <header className="l2-panel-head"><h3 className="l2-panel-t" id="prefs-dev-code">Running code</h3></header>
        <div className="l2-panel-body">
          <dl className="l2-kv">
            <div><dt>Revision</dt><dd>{r && r.commit ? <code>{r.short}</code> : 'Unknown'}{r && r.branch ? ` (${r.branch})` : ''}</dd></div>
            <div><dt>Source</dt><dd>{r && r.source === 'render' ? 'Deployed by Render from GitHub' : r && r.commit ? 'This PC\'s Git checkout' : 'No deploy or Git information'}</dd></div>
            <div><dt>Workspace</dt><dd>{ws ? `${ws.kind === 'real' ? 'Real' : ws.kind === 'demo' ? 'Demo (fictional)' : 'Test (fictional)'}` : 'Unknown'}</dd></div>
            <div><dt>Desk</dt><dd>{d.session && d.session.hosted ? 'The online desk' : 'This PC'}</dd></div>
          </dl>
        </div>
      </section>
    </div>
  );
}

// ---- the drawer --------------------------------------------------------------------------------

export default function Preferences() {
  const d = useDesk();
  const section = prefsOf() || 'appearance';
  const dlg = useRef(null);
  const opener = useRef(typeof document !== 'undefined' ? document.activeElement : null);
  const phone = useMedia('(max-width: 767.98px)');
  useEffect(() => {
    const el = dlg.current;
    if (el && !el.open) el.showModal();
    const o = opener.current;
    return () => {
      if (el && el.open) el.close();
      if (o && o.isConnected && typeof o.focus === 'function') requestAnimationFrame(() => o.focus());
    };
  }, []);
  // A new section starts at its top, with focus on its heading.
  const body = useRef(null);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    const h = document.getElementById('prefs-title');
    if (h) h.focus({ preventScroll: true });
  }, [section]);
  const settingsKey = JSON.stringify((d.index && d.index.settings) || null);
  const label = (PREF_SECTIONS.find(([k]) => k === section) || PREF_SECTIONS[0])[1];
  return (
    <dialog
      ref={dlg}
      className="prefs"
      aria-labelledby="prefs-title"
      data-key="prefs"
      onCancel={(e) => { e.preventDefault(); closePrefs(); }}
      onClick={(e) => { if (e.target === dlg.current) closePrefs(); }}
      onKeyDown={(e) => {
        const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
        if (e.key === ',' && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); closePrefs(); }
      }}
    >
      <div className="prefs-in">
        <header className="prefs-head">
          <h2 className="prefs-h">Preferences</h2>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Close Preferences" data-key="prefs-close" onClick={() => closePrefs()}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="prefs-main">
          <nav className="prefs-nav" aria-label="Preferences sections">
            {phone ? (
              <select className="input" aria-label="Section" value={section} data-key="prefs-section" onChange={(e) => openPrefs(e.target.value)}>
                {PREF_SECTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            ) : PREF_SECTIONS.map(([k, l]) => (
              <button key={k} type="button" className={`prefs-tab${k === section ? ' is-on' : ''}`} aria-current={k === section ? 'page' : undefined} data-key={`prefs-tab-${k}`} onClick={() => openPrefs(k)}>{l}</button>
            ))}
          </nav>
          <div className="prefs-body" ref={body}>
            <h3 className="prefs-title" id="prefs-title" tabIndex={-1}>{label}</h3>
            {section === 'screening' ? <Screening d={d} />
              : section === 'developer' ? <Developer d={d} />
                : <Dom key={section} build={(L) => L.prefsSection(legacyCtx, section)} deps={[section, settingsKey]} />}
            {section === 'appearance' ? <DeskDefaults /> : null}
          </div>
        </div>
      </div>
    </dialog>
  );
}
