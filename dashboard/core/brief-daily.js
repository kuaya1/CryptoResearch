'use strict';
// The daily brief (cr-daily-brief@1, 2026-10-25, W3.1): one deterministic read
// of what needs Eric today, from records already on the desk. Every line has
// its #/ deep link. It writes nothing, asks no provider and calls no model.
// A section it could not read says so ("Could not be read: ..."), never
// "nothing"; an empty section that was read says "None right now."
//
// The text is the brief's own words in a fixed order; its SHA-256 is of that
// text, so the same records at the same time give the same hash.

const { sha256 } = require('./fsx');

const VERSION = 'cr-daily-brief@1';
const HOUR = 3600000;

const age = (fromIso, now) => {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return 'age unknown';
  const h = Math.max(0, Math.round((now - t) / HOUR));
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};
const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const pct = (n) => `${n > 0 ? '+' : ''}${Number(n).toFixed(2)}%`;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toMs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

function brief(ws, { since = null, now = Date.now() } = {}) {
  const sinceMs = since === null || since === undefined || since === '' ? null : toMs(since);
  if (since && sinceMs === null) {
    const { OpError } = require('./ops');
    throw new OpError('INVALID', `"${since}" is not a date: give since as an ISO time such as 2026-10-24T00:00:00Z.`);
  }
  const sections = [];
  let index = null;
  let indexError = null;
  try { index = require('./indexer').buildIndex(ws, { now }); } catch (err) { indexError = err.message; }
  const rows = index ? index.projects.filter((p) => p && !p.broken && p.status !== 'archived') : [];
  const link = (pid) => `#/?p=${pid}`;

  const section = (id, title, needsIndex, fn) => {
    let lines;
    let state = 'ok';
    let error = null;
    try {
      if (needsIndex && !index) throw new Error(`the desk's index could not be built (${indexError})`);
      lines = fn();
    } catch (err) {
      state = 'unreadable';
      error = err.message;
      lines = [{ text: `Could not be read: ${err.message}`, link: null }];
    }
    if (state === 'ok' && !lines.length) lines = [{ text: 'None right now.', link: null }];
    sections.push({ id, title, state, error, count: state === 'ok' ? lines.filter((l) => l.link || l.text !== 'None right now.').length : null, lines });
  };

  const ticketOf = (r) => (r.ticket && !r.ticket.unavailable ? r.ticket : null);

  section('pm_cards', 'PM cards waiting for you', true, () => rows
    .filter((r) => ticketOf(r) && ticketOf(r).status === 'pending_pm_review')
    .sort((a, b) => String(ticketOf(a).saved_at).localeCompare(String(ticketOf(b).saved_at)))
    .map((r) => ({ text: `${r.name}: ${String(ticketOf(r).proposal_type || 'ticket').replace(/_/g, ' ')}${ticketOf(r).desk_gate ? ' (desk gate)' : ''}, waiting ${age(ticketOf(r).saved_at, now)}.`, link: link(r.project_id) })));

  section('invalidated', sinceMs === null ? 'Tickets invalidated (no since given: all)' : `Tickets invalidated since ${new Date(sinceMs).toISOString()}`, true, () => rows
    .filter((r) => {
      const t = ticketOf(r);
      if (!t || t.status !== 'invalidated') return false;
      const at = toMs(t.invalidation && t.invalidation.fired && t.invalidation.fired.at);
      // A trigger with no reading time cannot be placed after `since`: said, not hidden.
      return sinceMs === null || at === null || at >= sinceMs;
    })
    .map((r) => {
      const t = ticketOf(r);
      const at = t.invalidation && t.invalidation.fired && t.invalidation.fired.at;
      return { text: `${r.name}: ${t.invalidation.words || 'invalidated'}${at ? '' : ' (reading time not on record)'}`, link: link(r.project_id) };
    }));

  section('stale_basis', 'Tickets on a stale or superseded basis', true, () => rows
    .filter((r) => { const t = ticketOf(r); return t && !t.desk_gate && (t.superseded_by_report || (t.invalidation && t.invalidation.basis_stale)); })
    .map((r) => {
      const t = ticketOf(r);
      const why = t.invalidation && t.invalidation.basis_stale ? t.invalidation.basis_stale.why : `Claude's report ${t.researcher_report_id} is superseded by ${t.superseded_by_report}.`;
      return { text: `${r.name}: ${why}`, link: link(r.project_id) };
    }));

  section('pilot_exits', 'Pilot projects missing an exit reading', false, () => {
    const T = require('./tickets');
    return T.pilotCandidates(ws, { now })
      .filter((c) => c.in_pilot && c.exit_reading && c.exit_reading.present === false)
      .map((c) => ({ text: `${c.name || c.project_id}: no current exit reading at $${c.exit_reading.size_usd}.`, link: `#/project/${c.project_id}/forensics?tab=exits` }));
  });

  section('held', 'Held positions', true, () => rows
    .filter((r) => r.held && r.position)
    .map((r) => {
      const v = isNum(r.position.value_usd) ? usd(r.position.value_usd) : 'value unknown';
      const m = r.market || {};
      const c = isNum(m.change_24h_pct) ? `24h ${pct(m.change_24h_pct)}` : '24h change unknown';
      return { text: `${r.name}: ${v}, ${c}${r.position.price_status && r.position.price_status !== 'fresh' && r.position.price_status !== 'ok' ? ` (price ${String(r.position.price_status).replace(/_/g, ' ')})` : ''}.`, link: '#/portfolio' };
    }));

  section('research_waiting', 'Research waiting per model', true, () => {
    const held = require('./research').heldProviders(ws);
    const per = new Map();
    for (const r of rows) {
      const provs = (r.research && r.research.providers) || {};
      for (const [prov, job] of Object.entries(provs)) {
        if (job && job.state === 'unconfigured') {
          if (!per.has(prov)) per.set(prov, []);
          per.get(prov).push(r.name);
        }
      }
    }
    return [...per.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([prov, names]) => ({ text: `${prov}: ${names.length} waiting (${names.sort().join(', ')})${held[prov] ? '; on hold, kept' : ''}.`, link: '#/research' }));
  });

  section('models_differ', 'Models differ', true, () => (index.attention || [])
    .filter((a) => a.kind === 'disagreement' && a.project_id && rows.some((r) => r.project_id === a.project_id))
    .map((a) => ({ text: String(a.title), link: `#/project/${a.project_id}/compare` })));

  section('freshness', 'Backup and prices', false, () => {
    const out = [];
    const b = require('./offsite').backupStatus(ws, process.env, now);
    out.push({ text: b.summary, link: '#/?prefs=data' });
    const m = require('./market').freshness(ws, now);
    out.push({ text: m.age_minutes === null ? `Prices: ${m.note || 'none stored yet'}.` : `Prices: ${String(m.freshness).replace(/_/g, ' ')}, last update ${m.age_minutes} min ago (stale after ${m.stale_after_minutes} min)${m.note ? `. ${m.note}` : ''}.`, link: '#/' });
    return out;
  });

  const head = `Daily brief (${VERSION}), as of ${new Date(now).toISOString()}${sinceMs === null ? '' : `, since ${new Date(sinceMs).toISOString()}`}`;
  const text = [head, ...sections.flatMap((s) => ['', `${s.title}${s.state === 'ok' ? ` (${s.count})` : ''}`, ...s.lines.map((l) => `- ${l.text}${l.link ? ` ${l.link}` : ''}`)])].join('\n');
  return { format: VERSION, generated_at: new Date(now).toISOString(), since: sinceMs === null ? null : new Date(sinceMs).toISOString(), sections, text, text_sha256: sha256(text), writes_nothing: true };
}

module.exports = { brief, VERSION };
