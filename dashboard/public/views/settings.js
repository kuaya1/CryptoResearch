// Settings: general preferences, research providers and budgets (keys never
// appear in the page), rubrics, data (exports, backups) and system status.
import {
  h, card, table, stateText, fmtDateTime, fmtNum, fmtAgo, field, input, select, button, action, callout, kv, details, tabStrip, safeSection,
  priceStatus, PROVIDERS, PROVIDER_LABELS,
} from '../ui.js';

const TABS = [
  ['general', 'General'],
  ['research', 'Research models & budget'],
  ['rubrics', 'Rubrics'],
  ['data', 'Backups & exports'],
  ['system', 'System & privacy'],
  ['activity', 'Activity'],
];

export async function renderSettings(ctx, route) {
  const tab = TABS.some(([t]) => t === route.query.get('tab')) ? route.query.get('tab') : 'general';
  const strip = tabStrip(TABS.map(([t, label]) => ({ id: t, label, href: `#/settings?tab=${t}` })), tab, { label: 'Settings sections' });
  const body = await safeSection(TABS.find(([t]) => t === tab)[1], () => ({ general: generalTab, research: researchTab, rubrics: rubricsTab, data: dataTab, system: systemTab, activity: activityTab })[tab](ctx));
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'), h('div', { class: 'sub' }, 'Stored in config/settings.json inside your workspace.'))),
    strip,
    h('div', { id: 'tabpanel', role: 'tabpanel', 'aria-labelledby': `tab-${tab}` }, body));
}

function generalTab(ctx) {
  const s = ctx.state.index.settings;
  const r = ctx.state.index.rubrics;
  const spread = input({ type: 'number', min: '1', max: '99', value: s.comparison.spread_threshold });
  const windowDays = input({ type: 'number', min: '0', max: '365', value: s.comparison.date_window_days });
  const median = h('input', { type: 'checkbox', checked: Boolean(s.comparison.show_median) });
  const tol = input({ type: 'number', step: 'any', min: '0', max: '20', value: s.grading.discrepancy_tolerance });
  const stale = input({ type: 'number', min: '5', value: s.freshness.price_stale_minutes });
  const claimStale = input({ type: 'number', min: '1', value: s.freshness.claim_stale_days });
  const researchStale = input({ type: 'number', min: '1', value: s.freshness.research_stale_days || 90 });
  const md = h('input', { type: 'checkbox', checked: Boolean(s.market_data.enabled) });
  const fg = input({ type: 'number', min: '2', max: '240', value: s.market_data.foreground_interval_minutes });
  const budget = input({ type: 'number', min: '100', value: s.market_data.monthly_call_budget || 7500 });
  const labels = input({ value: (r.labels || []).map((l) => `${l.label}:${l.min}`).join(', ') });
  const btn = button('Save settings', null, { kind: 'primary small', type: 'submit' });
  const form = h('form', { class: 'form-grid' },
    field('Highlight spreads of at least', spread, 'points'),
    field('Comparison date window', windowDays, 'days; applies across the whole span of compared analyses'),
    field('Model-total tolerance', tol, 'points before a mismatch is flagged'),
    field('Price is stale after', stale, 'minutes'),
    field('Claim is stale after', claimStale, 'days'),
    field('Research is stale after', researchStale, 'days; stale grades are marked, never hidden'),
    field('Refresh prices while open every', fg, 'minutes'),
    field('CoinGecko monthly call budget', budget, 'calls; refreshes pause at the budget and keep last values'),
    field('Grade labels', labels, 'label:minimum, e.g. A:90, B:80, C:70, D:60, F:0'),
    h('label', { class: 'check' }, median, 'Show descriptive median in comparisons'),
    h('label', { class: 'check' }, md, 'Fetch market data (CoinGecko)'),
    h('div', { class: 'field' }, btn));
  form.onsubmit = action(btn, async () => {
    const parsed = labels.value.split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [label, min] = x.split(':'); return { label: (label || '').trim(), min: Number(min) }; });
    const out = await ctx.api.post('/api/settings', {
      comparison: { spread_threshold: spread.value, date_window_days: windowDays.value, show_median: median.checked },
      grading: { discrepancy_tolerance: tol.value, labels: parsed },
      freshness: { price_stale_minutes: stale.value, claim_stale_days: claimStale.value, research_stale_days: researchStale.value },
      market_data: { enabled: md.checked, foreground_interval_minutes: fg.value, monthly_call_budget: budget.value },
    });
    await ctx.refresh();
    return out;
  }, 'Settings saved to config/settings.json');
  const sources = s.rank_sources || {};
  return h('div', null,
    card('Dashboard settings', form, { note: 'Rubric weights are not editable here: they belong to the versioned rubric files.' }),
    card('Market data sources', table([
      { label: 'Source', render: (x) => x.label },
      { label: 'Status', render: (x) => (x.enabled ? stateText('In use', 'ok') : stateText('Not configured')) },
      { label: 'Used for', wrap: true, render: (x) => h('span', { class: 'small' }, x.note) },
    ], [
      { label: 'CoinGecko /coins/markets', enabled: s.market_data.enabled !== false, note: 'Price, market cap, rank (labeled "CoinGecko"), rolling 24H/7D/30D change, 24h volume, supply, 7-day series, logos. Free, keyless, within the monthly call budget.' },
      { label: 'CoinMarketCap', enabled: Boolean(sources.coinmarketcap && sources.coinmarketcap.enabled), note: 'Not used. A literal CoinMarketCap rank would need a CoinMarketCap API key and adapter; CoinGecko rank is never relabeled as CoinMarketCap.' },
      { label: 'Liquidity (DEX/CEX depth)', enabled: false, note: 'No source configured, so no liquidity column is offered.' },
    ]), { note: 'Each value shows the source it came from.' }));
}

// A model's research route, as readiness reports it: automatic on its API,
// or setup required (what is missing in the tooltip and below the label) and
// meanwhile waiting for its assistant (online desk) or a pasted answer (PC).
function routeCell(m, hostedDesk) {
  if (!m) return h('span', { class: 'faint' }, '—');
  if (m.route === 'automatic') return h('span', null, stateText('Automatic (API)', 'ok'), m.reservation_usd !== null ? h('div', { class: 'small muted' }, `about ${fmtUsd(m.reservation_usd)} reserved per attempt`) : null);
  if (m.route === 'demo') return stateText('Fictional demo adapter');
  return h('span', { title: m.setup || '' }, stateText(`Setup required · ${hostedDesk ? 'waits for its assistant' : 'paste by hand'}`, 'warn'), h('div', { class: 'small muted' }, m.setup_short || ''));
}
const fmtUsd = (x) => `$${x > 0 && x < 0.1 ? x.toFixed(4) : x.toFixed(2)}`;

async function researchTab(ctx) {
  let info;
  try {
    info = await ctx.api.get('/api/research/providers');
  } catch (err) {
    return callout(err.message, 'bad');
  }
  const s = ctx.state.index.settings.research;
  const cfg = s.providers || {};
  const ready = info.readiness || null;
  const hostedDesk = Boolean(ctx.state.session && ctx.state.session.hosted);
  const inputs = {};
  const rows = PROVIDERS.map((p) => {
    const c = cfg[p] || {};
    inputs[p] = {
      model: input({ value: c.model || '', placeholder: 'model ID', 'aria-label': `${PROVIDER_LABELS[p]} model ID` }),
      inp: input({ inputmode: 'decimal', value: c.input_usd_per_mtok ?? '', placeholder: 'USD / 1M input tokens', 'aria-label': `${PROVIDER_LABELS[p]} input price` }),
      outp: input({ inputmode: 'decimal', value: c.output_usd_per_mtok ?? '', placeholder: 'USD / 1M output tokens', 'aria-label': `${PROVIDER_LABELS[p]} output price` }),
      search: input({ inputmode: 'decimal', value: c.search_usd_per_call ?? '', placeholder: 'USD per web search', 'aria-label': `${PROVIDER_LABELS[p]} search price` }),
      maxs: input({ inputmode: 'numeric', value: c.max_searches ?? '', placeholder: 'max searches (0 = off)', 'aria-label': `${PROVIDER_LABELS[p]} max searches (0 turns web search off)` }),
    };
    return p;
  });
  const b = s.budget || {};
  const perRun = input({ inputmode: 'decimal', value: b.per_run_usd ?? '', placeholder: 'not set' });
  const daily = input({ inputmode: 'decimal', value: b.daily_usd ?? '', placeholder: 'not set' });
  const monthly = input({ inputmode: 'decimal', value: b.monthly_usd ?? '', placeholder: 'not set' });
  const horizon = input({ value: s.default_horizon || '24 months' });
  // The Gemini API cannot cap searches per request, so web search is used only
  // when you declare how your model bills it (audit V2-005): one fee per
  // grounded request (Gemini 2.5), or per search query (Gemini 3, where max
  // searches is the number the reservation assumes and a count the answer does
  // not report keeps the reservation counted until you reconcile it).
  const geminiBilling = select([
    { value: '', label: 'Not declared (Gemini search is not used)', selected: !(cfg.gemini && cfg.gemini.search_billing) },
    { value: 'per_request', label: 'Per request (Gemini 2.5 and older)', selected: Boolean(cfg.gemini && cfg.gemini.search_billing === 'per_request') },
    { value: 'per_query', label: 'Per search query (Gemini 3: reserved as an estimate; no cap exists)', selected: Boolean(cfg.gemini && cfg.gemini.search_billing === 'per_query') },
  ], { 'aria-label': 'Gemini search billing' });
  const boundsList = PROVIDERS.filter((p) => info.providers[p] && info.providers[p].bounds).map((p) => {
    const b = info.providers[p].bounds;
    return h('li', null, h('strong', null, `${PROVIDER_LABELS[p]}: `), `enforced by the request: ${b.enforced.join('; ')}. Estimated only: ${b.estimated.join('; ')}.`);
  });
  const unattended = h('input', { type: 'checkbox', checked: Boolean(s.unattended_enabled) });
  const btn = button('Save research settings', null, { kind: 'primary small', type: 'submit' });
  const form = h('form', null,
    table([
      { label: 'Model', render: (p) => h('strong', null, PROVIDER_LABELS[p]) },
      { label: 'Route', render: (p) => routeCell(ready && ready.models[p], hostedDesk) },
      { label: 'API key', render: (p) => { const st = info.providers[p] || {}; return st.key && st.key.present ? `Present (${st.key.source || st.key.how || 'configured'})` : h('span', { class: 'faint' }, 'Not set'); } },
      { label: 'Model ID', render: (p) => inputs[p].model },
      { label: 'Input $/1M tok', render: (p) => inputs[p].inp },
      { label: 'Output $/1M tok', render: (p) => inputs[p].outp },
      { label: '$ per search', render: (p) => inputs[p].search },
      { label: 'Max searches', render: (p) => inputs[p].maxs },
    ], rows),
    h('div', { class: 'form-grid', style: { marginTop: '12px' } },
      field('Per-run limit (USD)', perRun, 'The total for one run: every model and every attempt, counting each call\'s reservation until its actual cost is known'),
      field('Daily limit (USD)', daily),
      field('Monthly limit (USD)', monthly),
      field('Default horizon', horizon),
      field('Gemini search billing', geminiBilling, 'The Gemini API has no per-request search limit. Gemini 3 bills each search query: choose per search query (Max searches is then the number the reservation assumes, an estimate; a count the answer does not report keeps the reservation counted until you reconcile it), or set Max searches to 0. Choose per request only if your model bills grounding per prompt (Gemini 2.5 and older).'),
      h('label', { class: 'check field wide' }, unattended, 'Allow scheduled (unattended) research runs within these limits'),
      h('div', { class: 'field' }, btn)));
  form.onsubmit = action(btn, async () => {
    const providers = {};
    for (const p of PROVIDERS) {
      const v = inputs[p];
      providers[p] = { model: v.model.value.trim() || null, input_usd_per_mtok: v.inp.value.trim() || null, output_usd_per_mtok: v.outp.value.trim() || null, search_usd_per_call: v.search.value.trim() || null };
      if (v.maxs.value.trim()) providers[p].max_searches = v.maxs.value.trim();
    }
    providers.gemini.search_billing = geminiBilling.value || null;
    const out = await ctx.api.post('/api/settings', { research: { providers, budget: { per_run_usd: perRun.value.trim() || null, daily_usd: daily.value.trim() || null, monthly_usd: monthly.value.trim() || null }, default_horizon: horizon.value.trim(), unattended_enabled: unattended.checked } });
    await ctx.refresh();
    return out;
  }, 'Research settings saved. No key was sent or stored by this page.');
  // The online desk reads its keys from Render's environment; this PC reads
  // them from its environment or the secrets file outside the workspace.
  const hosted = Boolean(ctx.state.session && ctx.state.session.hosted);
  const keyHelp = hosted
    ? card('How to add a key (online desk)', h('ol', { class: 'list small' },
      h('li', null, 'In Render, open the CryptoResearch service, then Environment.'),
      h('li', null, 'Add only the keys you want to use: ', h('code', null, 'ANTHROPIC_API_KEY'), ', ', h('code', null, 'OPENAI_API_KEY'), ', ', h('code', null, 'GEMINI_API_KEY'), '. Save; Render restarts the desk with them. Never paste a key into a chat or this page.'),
      h('li', null, 'Set the model ID and token prices above (from each provider\'s pricing page), then the three limits.'),
      h('li', null, 'The Route column shows "Automatic (API)" when everything needed is present. That model then runs by itself in the background, within your limits. Until then it says "Setup required" and what is missing, and its jobs wait for its assistant.')))
    : card('How to add a key (on this PC only)', h('ol', { class: 'list small' },
      h('li', null, 'Create the file ', h('code', null, info.keys_file), ' (outside your workspace, so it is never backed up or exported).'),
      h('li', null, 'Put in only the keys you want to use, for example ', h('code', null, '{ "anthropic_api_key": "…", "openai_api_key": "…", "gemini_api_key": "…" }'), '. Environment variables ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY also work.'),
      h('li', null, 'Set the model ID and token prices above (from each provider\'s pricing page), then the three limits.'),
      h('li', null, 'Restart the dashboard. The Route column shows "Automatic (API)" when everything needed is present; until then it says "Setup required" and what is missing.')));
  return h('div', null,
    ready ? card('Readiness', [
      h('p', null, ready.summary),
      h('ul', { class: 'list small' }, PROVIDERS.map((p) => h('li', null, ready.models[p].sentence))),
      h('p', { class: 'small muted' }, `${ready.retries_note} ${ready.limits_note}`),
    ]) : null,
    callout(hosted
      ? h('span', null, 'API access is separate from consumer subscriptions (Claude Pro/Max, ChatGPT Plus, Gemini Advanced are not API keys). On this online desk, keys are set in Render > Environment and read only by the desk\'s server; they are never shown here, sent to the browser, written to settings, exported or logged. Without a key, a model\'s job waits for you: tell its assistant to do its waiting research, or paste the prompt and import the answer.')
      : h('span', null, 'API access is separate from consumer subscriptions (Claude Pro/Max, ChatGPT Plus, Gemini Advanced are not API keys). Keys are read only by the local server from environment variables or ', h('code', null, info.keys_file), '; they are never shown here, sent to the browser, written to settings, exported or logged. Without a key, a model\'s job waits for you to paste its answer.'), 'info'),
    card('Models, prices and limits', [
      form,
      boundsList.length ? h('div', { style: { marginTop: '12px' } }, h('h3', null, 'What each limit enforces'), h('ul', { class: 'list small' }, boundsList),
        h('p', { class: 'small muted' }, 'Each call reserves the enforced parts plus the estimates before it is sent. Actual usage can be higher; it is recorded when the provider reports it.')) : null,
    ], { note: `Counted so far: $${info.spend.daily} today, $${info.spend.monthly} this month (${info.spend.calls} call(s)${info.spend.open_reservations_usd ? `; $${info.spend.open_reservations_usd} of it is reservations for calls whose cost is not known yet` : ''}${info.spend.estimated_usd ? `; $${info.spend.estimated_usd} is estimates for ${info.spend.estimated_attempts} answer(s) whose provider did not report every billable quantity, each counted at least at its reservation until you reconcile it` : ''}${info.spend.uncertain_attempts ? `; ${info.spend.uncertain_attempts} attempt(s) uncertain: never resent; reconcile them in the project's Research tab` : ''}). No budget is implied: until you set all three limits, no paid call is made. Provider spend caps are a second guard with billing delay, not hard limits.` }),
    keyHelp);
}

function rubricsTab(ctx) {
  const r = ctx.state.index.rubrics;
  const comps = r.grading.investment_components;
  return h('div', null,
    card(`Investment grade: ${r.grading.rubric_ref}`, [
      table([
        { label: 'Component', key: 'label' },
        { label: 'Weight', num: true, render: (c) => `${c.weight_bp / 100}%` },
        { label: 'Definition', wrap: true, key: 'definition' },
      ], comps),
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, `Weights total ${comps.reduce((a, c) => a + c.weight_bp, 0) / 100}%. ${r.grading.grade_display_rule || ''} ${r.grading.grade_label_note || ''}`),
      h('ul', { class: 'list small' }, (r.grading.rules || []).map((x) => h('li', null, x))),
    ], { note: 'Each report is graded with the rubric version it declares. Unknown, unpinned or altered versions get no authoritative grade (templates/rubrics/RUBRIC-LOCK.json).' }),
    card('Downside-risk panel (higher = more risk)', table([
      { label: 'Risk', key: 'label' },
      { label: 'Definition', wrap: true, key: 'definition' },
    ], r.grading.risk_scores)),
    card('Scoring profiles (diagnostic scorecards)', r.profiles.map((p) => details(`${p.profile_ref} — ${p.title}`, h('div', null,
      h('p', { class: 'small muted' }, p.applies_to),
      table([
        { label: 'Category', render: (c) => h('span', null, c.label, ' ', h('code', { class: 'small faint' }, c.id)) },
        { label: 'Applies', render: (c) => (c.applicable === false ? h('span', { class: 'faint', title: c.na_reason || '' }, 'Not applicable') : 'Yes') },
        { label: 'Definition', wrap: true, key: 'definition' },
      ], p.diagnostic_categories),
      h('h3', { style: { marginTop: '10px' } }, 'Research sections'),
      h('ol', { class: 'list small' }, p.research_sections.map((sct) => h('li', null, h('strong', null, sct.title), ` — ${sct.guidance}`)))))), { note: 'Scores are comparable only within the same profile and rubric version. Inapplicable categories are N/A, never zero. A project\'s sector is your label and is separate from its scoring profile.' }),
    card('Evidence tags', kv(Object.entries(r.evidence_tags).map(([k, v]) => [`[${k}]`, v]))));
}

async function dataTab(ctx) {
  let inventory = null;
  try {
    inventory = (await ctx.api.get('/api/export/inventory')).portable;
  } catch (_) { /* optional */ }
  const portable = button('Portable export (JSON)', null, { kind: 'small' });
  portable.onclick = action(portable, async () => { await ctx.api.download('/api/export.json', 'cryptoresearch-portable-export.json'); return undefined; });
  const pkg = button('Complete package (restorable)', null, { kind: 'primary small' });
  pkg.onclick = action(pkg, async () => { await ctx.api.download('/api/export/package', 'cryptoresearch-complete-package.json'); return undefined; });
  const csvButtons = ['reports', 'scores', 'claims', 'transactions', 'positions', 'events'].map((t) => {
    const b = button(`${t}.csv`, null, { kind: 'small' });
    b.onclick = action(b, async () => { await ctx.api.download(`/api/export/${t}.csv`, `${t}.csv`); return undefined; });
    return b;
  });
  const backupList = h('div', null, h('p', { class: 'small muted' }, 'Loading backups…'));
  const loadBackups = async () => {
    try {
      const list = await ctx.api.get('/api/backups');
      backupList.replaceChildren(table([
        { label: 'Backup', render: (b) => h('code', { class: 'small' }, b.name) },
        { label: 'Created', render: (b) => fmtDateTime(b.created_at) },
        { label: 'Kind', render: (b) => h('span', { title: b.sealed ? 'Has a manifest with SHA-256 for every file' : 'Older backup without a manifest; cannot be verified' }, stateText(b.sealed ? 'Sealed' : 'Legacy, unverifiable', b.sealed ? 'ok' : 'warn')) },
        { label: 'Reason', key: 'reason' },
        { label: 'Files', num: true, render: (b) => (b.files ? fmtNum(b.files) : '—') },
        { label: '', render: (b) => {
          if (!b.sealed) return null;
          const v = button('Verify', null, { kind: 'small' });
          v.onclick = action(v, async () => ctx.api.get(`/api/backups/${encodeURIComponent(b.name)}/verify`), (r) => (r.ok ? `Verified: all ${r.files} files match their SHA-256 hashes${r.extra && r.extra.length ? ` (${r.extra.length} unlisted extra file(s))` : ''}` : `Did not verify: ${r.reason || `${(r.missing || []).length} missing, ${(r.mismatched || []).length} changed`}`));
          return v;
        } },
      ], list, { empty: 'No backups yet. One is made daily while the dashboard or the hourly task runs.' }));
    } catch (err) {
      backupList.replaceChildren(callout(err.message, 'bad'));
    }
  };
  loadBackups();
  const mk = button('Create backup now', null, { kind: 'small' });
  mk.onclick = action(mk, async () => { const r = await ctx.api.post('/api/backups', {}); await loadBackups(); return r; }, (r) => `Backup ${r.name} created (${r.files} files)`);
  return h('div', null,
    card('Exports', [
      h('p', null, 'The complete package contains every record and every original file (binary originals included) and can be restored into a new folder. The portable export is a readable JSON of your records. CSVs flatten the same data for spreadsheets; cells that look like formulas are neutralized. No secrets are stored in the workspace, so none are exported.'),
      h('div', { class: 'actions' }, pkg, portable, ...csvButtons),
      inventory ? details('What the portable export contains and leaves out', h('div', null,
        h('h3', null, 'Included'), h('ul', { class: 'list small' }, (inventory.included || []).map((x) => h('li', null, x))),
        (inventory.excluded || []).length ? h('div', null, h('h3', null, 'Not included'), h('ul', { class: 'list small' }, inventory.excluded.map((x) => h('li', null, x)))) : null)) : null,
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Command line: node dashboard/cli.js package --out <file> · restore: node dashboard/cli.js restore-package <file> --to <new folder>'),
    ]),
    card('Local backups', [
      h('p', null, 'Sealed backups live in backups/snapshots/ with a manifest of SHA-256 hashes. They protect against mistakes, not disk failure: copy the folder to an external drive for that. Nothing is uploaded.'),
      h('div', { class: 'actions', style: { marginBottom: '10px' } }, mk),
      backupList,
      h('h3', { style: { marginTop: '12px' } }, 'Restoring'),
      h('ul', { class: 'list small' },
        h('li', null, h('strong', null, 'Clean restore (recommended): '), h('code', null, 'node dashboard/cli.js backup restore <name> --to <empty folder>'), ' — rebuilds the backup in a separate folder and reconciles hashes and record counts. Your live folder is untouched.'),
        h('li', null, h('strong', null, 'Point-in-time: '), h('code', null, 'backup restore <name> --point-in-time'), ' previews; add ', h('code', null, '--confirm'), ' to apply. Files created after the backup are moved to backups/quarantine/, not deleted.'),
        h('li', null, h('strong', null, 'Overlay: '), h('code', null, 'backup restore <name> --overlay --confirm'), ' copies backup files over the live folder and leaves newer files in place. It is not a point-in-time recovery.')),
    ]));
}

// Which code this desk runs: the commit Render deployed (or this PC's Git
// checkout), so a review can match the running code to the repository.
function revisionItem(session) {
  const r = session && session.revision;
  if (!r) return null;
  return h('li', null, h('strong', null, 'Running code: '), r.commit
    ? [h('code', null, r.short), r.branch ? ` (${r.branch})` : '', r.source === 'render' ? ', deployed by Render from GitHub' : ', from this PC\'s Git checkout', r.started_at ? `; started ${fmtAgo(r.started_at)}.` : '.']
    : 'unknown (no deploy or Git information).');
}

async function systemTab(ctx) {
  const idx = ctx.state.index;
  const hostedDesk = Boolean(ctx.state.session && ctx.state.session.hosted);
  const sched = h('div', null, h('p', { class: 'small muted' }, 'Checking the Windows scheduled task…'));
  // The online desk runs on Render: there is no Windows scheduled task to show.
  if (!hostedDesk) ctx.api.get('/api/schedule').then((s) => {
    const own = { this_workspace: ['runs this workspace', 'ok'], other_workspace: ['points at a DIFFERENT workspace', 'bad'], this_folder_other_workspace_id: ['points at this folder but another workspace ID', 'warn'], none: ['not installed', 'warn'], unknown: ['ownership unknown', 'warn'] }[s.ownership] || [s.ownership || 'unknown', ''];
    sched.replaceChildren(s.installed
      ? kv([
        ['Task', '\\CryptoResearch\\Hourly'],
        ['Ownership', stateText(own[0], own[1])],
        ['State', s.state],
        ['Last run', s.last_run_time ? `${fmtDateTime(s.last_run_time)} (${s.last_task_result_meaning || s.last_task_result})` : 'not yet'],
        ['Next run', s.next_run_time ? fmtDateTime(s.next_run_time) : '—'],
        ['Runs', s.execute ? h('code', { class: 'small wrap-anywhere' }, `${s.execute} ${s.arguments || ''}`) : '—'],
        ['In folder', s.working_directory ? h('code', { class: 'small wrap-anywhere' }, s.working_directory) : '—'],
      ])
      : s.installed === false
        ? callout('The hourly task is not installed. Background updates only happen while the dashboard is open. Install it with: node dashboard/cli.js schedule install', 'warn')
        : callout(`Scheduler status unavailable: ${s.error || s.status}`, 'warn'));
  }).catch((err) => sched.replaceChildren(callout(err.message, 'bad')));
  const doc = h('div', null, h('p', { class: 'small muted' }, 'Running checks…'));
  ctx.api.get('/api/doctor').then((d) => {
    doc.replaceChildren(
      kv([
        ['Node', d.runtime ? `v${d.runtime.version}${d.runtime.support ? ` · ${d.runtime.support}` : ''}${d.runtime.project_pin ? ` · project pin ${d.runtime.project_pin}` : ''}` : '—'],
        ['This session', d.session ? `${d.session.host || '?'}${d.session.home_host ? ` (workspace home: ${d.session.home_host})` : ''} · write ${d.session.can_write ? 'yes' : 'no'}, rename ${d.session.can_rename ? 'yes' : 'no'}, delete ${d.session.can_delete ? 'yes' : 'no'}` : '—'],
      ]),
      table([
        { label: 'Check', key: 'name' },
        { label: 'Result', render: (c) => stateText(c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'Warning' : 'Problem', c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'bad') },
        { label: 'Detail', wrap: true, render: (c) => h('span', { class: 'small' }, c.detail || c.message || '') },
      ], d.checks || []));
  }).catch((err) => doc.replaceChildren(callout(err.message, 'bad')));
  const jobs = idx.settings.jobs || {};
  // Connected apps: assistant connections (Claude, ChatGPT, Gemini) Eric
  // approved for the online desk.
  const conn = h('div', null, h('p', { class: 'small muted' }, 'Loading…'));
  const drawConnections = () => ctx.api.get('/api/connections').then((c) => {
    if (!c.available) {
      conn.replaceChildren(callout('Claude (Cowork, claude.ai), ChatGPT and Gemini connect to the online desk, not to this PC\'s dashboard. On the online desk this section shows the connector address and what is connected.', 'info'));
      return;
    }
    const rows = c.connections.map((x) => {
      const b = button('Disconnect', null, { kind: 'small quiet' });
      b.setAttribute('aria-label', `Disconnect ${x.client_name}`);
      b.onclick = action(b, async () => {
        if (!window.confirm(`Disconnect ${x.client_name}? It loses access to the desk at once; reconnecting needs your passphrase again.`)) return undefined;
        const r = await ctx.api.post(`/api/connections/${encodeURIComponent(x.grant_id)}/revoke`, {});
        drawConnections();
        return r;
      }, (r) => r.message);
      return { ...x, action: b };
    });
    conn.replaceChildren(
      kv([['Connector address', h('code', { class: 'wrap-anywhere' }, c.mcp_url)]]),
      h('ul', { class: 'list small muted' },
        h('li', null, h('strong', null, 'Claude (and so Cowork): '), 'claude.ai > Settings > Connectors > Add custom connector, name it CryptoResearch and paste this address.'),
        h('li', null, h('strong', null, 'ChatGPT (Plus or Pro, on the web): '), 'Settings > Security and login > turn on Developer mode; then Plugins > + > create an app named CryptoResearch with this address and OAuth sign-in.'),
        h('li', null, h('strong', null, 'Gemini (personal account, US, 18+): '), 'gemini.google.com > Settings > Connected Apps > Custom apps > Add a custom app, and paste this address. In a chat, type @ and pick CryptoResearch: Gemini uses it only when mentioned.'),
        h('li', null, 'Each then opens an approval page here; approve it with your desk passphrase. What a connection saves is filed under its own model.')),
      rows.length
        ? table([
          { label: 'Model', key: 'assistant_label' },
          { label: 'App', key: 'client_name' },
          { label: 'Connected', render: (x) => fmtDateTime(x.created_at) },
          { label: 'Last used', render: (x) => (x.last_used_at ? fmtAgo(x.last_used_at) : 'not yet') },
          { label: '', render: (x) => x.action },
        ], rows)
        : h('p', { class: 'small' }, 'Nothing is connected yet.'));
  }).catch((err) => conn.replaceChildren(callout(err.message, 'bad')));
  drawConnections();
  return h('div', null,
    card('Connected apps', conn, { note: 'Apps you approved to use this desk. They act through the same validated records as this page; none of them can trade or move money.' }),
    card('Where things run', h('ul', { class: 'list' },
      revisionItem(ctx.state.session),
      hostedDesk
        ? h('li', null, h('strong', null, 'This desk: '), 'runs online (Render) with its own records on a persistent disk. Every page and API call needs your sign-in; Claude\'s connector needs a connection you approved. Your PC\'s dashboard and its records are separate.')
        : h('li', null, h('strong', null, 'This dashboard: '), 'runs on this PC at 127.0.0.1 only. It is not reachable from your phone or the internet, and it should not be exposed to reach it from elsewhere. Phone access is the separate online desk.'),
      h('li', null, h('strong', null, 'Prices: '), hostedDesk
        ? `refreshed by the desk itself: every ${idx.settings.market_data.foreground_interval_minutes} minutes while a page is open, and on a slower schedule otherwise.`
        : `every ${idx.settings.market_data.foreground_interval_minutes} minutes while the dashboard is open, and hourly through the Windows scheduled task while the PC is on and you are logged in.`),
      h('li', null, h('strong', null, 'Research: '), 'only when you ask (dashboard, CLI or Cowork) or on a schedule you configure with a budget. A price refresh never starts research.'),
      hostedDesk
        ? h('li', null, h('strong', null, 'Assistants: '), 'Claude in Cowork, ChatGPT and Gemini work on this desk through the CryptoResearch connector (Connected apps, above): they find and add projects, do the research themselves under their own plans and save the full report here, each under its own name. No CoinGecko or paid model API is needed for that. Research by the paid APIs in the background happens only for models whose API key you added on Render, within your research spending limits.')
        : h('li', null, h('strong', null, 'Cowork: '), 'a Cowork task may run in Anthropic\'s cloud. It can reach this folder only while the Claude desktop app is open and the folder is connected. Being able to write files there does not mean it can run programs on this PC: when it cannot, it drops a request in inbox/requests/ and this PC applies it. Scheduled Cowork tasks also run in the cloud. Through the connector, Cowork works on the online desk instead.'),
      h('li', null, h('strong', null, 'Holdings: '), 'change only when you record transactions.'),
      jobs.evidence_watch ? h('li', null, h('strong', null, 'Evidence watch: '), jobs.evidence_watch.note || 'optional; produces a dated digest and never overwrites grades.') : null)),
    hostedDesk ? null : card('Scheduled task (Windows)', sched),
    card('Health checks', doc, { note: 'Same as: node dashboard/cli.js doctor' }),
    card('Privacy', h('ul', { class: 'list' },
      h('li', null, hostedDesk ? 'Answers only its own address over HTTPS. Pages and the API need your sign-in, writes also need this page\'s token, and the connector needs a token from a connection you approved with your passphrase (stored only as hashes).' : 'Listens on 127.0.0.1 only, accepts only expected Host headers, and writes need a per-launch token from this page.'),
      h('li', null, 'Market data requests send only the tracked coin IDs to CoinGecko. No holdings, quantities, accounts or notes leave the PC.'),
      h('li', null, 'Research prompts contain only the project context needed: name, links, identity, sector and a dated public market packet. Holdings and private notes are never model inputs by default.'),
      h('li', null, 'No wallet connection, exchange keys, seed phrases or trading access are ever requested or stored.'),
      h('li', null, hostedDesk
        ? 'API keys live only in Render\'s environment settings for this desk, entered by you, so they are never in browser code, prompts, exports or logs.'
        : 'API keys stay in environment variables or ~/.cryptoresearch/secrets.json, outside the workspace, so they are never in browser code, prompts, exports or logs.'),
      h('li', null, hostedDesk ? 'The records of this desk live on its own disk. Nothing from your PC is uploaded or synced.' : `Your records live in ${idx.workspace.root}. Nothing is uploaded or synced by this app.`))));
}

// Activity: freshness, jobs and the write log (moved here from Updates).
function activityTab(ctx) {
  const idx = ctx.state.index;
  const mf = idx.freshness.market;
  const jobs = idx.freshness.jobs.jobs || {};
  const jobRows = ['requests', 'inbox', 'market', 'research', 'snapshot', 'reviews', 'backup'].map((name) => ({ name, ...(jobs[name] || {}) }));
  const runner = idx.freshness.jobs.runner || {};
  const JOB_STATE = { ok: ['OK', 'ok'], done: ['OK', 'ok'], failed: ['Failed', 'bad'], attention: ['Needs attention', 'warn'] };
  const ps = priceStatus(mf);
  return h('div', null,
    card('Data freshness', kv([
      ['Market data', h('span', null, stateText(ps.text, ps.tone), ' ', h('span', { class: 'muted' }, `· ${ps.asOf}`),
        ps.note ? h('div', { class: 'small muted' }, ps.problem ? `Last problem: ${ps.note}` : ps.note) : mf.last_error ? h('div', { class: 'small muted' }, `Last problem: ${mf.last_error}`) : null)],
      ['CoinGecko calls', mf.calls ? `${mf.calls.month_count} this month of a ${mf.calls.budget_monthly || 'unlimited'} budget · ${mf.calls.day_count} today` : '—'],
      ctx.state.session && ctx.state.session.hosted ? null : ['Hourly scheduled task', runner.last_scheduler_run_at ? `last ran ${fmtAgo(runner.last_scheduler_run_at)}${runner.node ? ` on Node ${runner.node}` : ''}` : h('span', { class: 'muted' }, 'no scheduled run recorded yet')],
      ['Index', `built ${fmtDateTime(idx.generated_at)} in ${idx.build_ms} ms`],
    ])),
    card('Jobs', table([
      { label: 'Job', key: 'name' },
      { label: 'Last run', render: (j) => (j.last_run_at ? fmtAgo(j.last_run_at) : 'never') },
      { label: 'Trigger', render: (j) => j.last_trigger || '—' },
      { label: 'Status', render: (j) => { if (!j.last_status) return h('span', { class: 'faint' }, 'Never run'); const [t, tone] = JOB_STATE[j.last_status] || [j.last_status, '']; return stateText(t, tone); } },
      { label: 'Summary', wrap: true, render: (j) => j.last_summary || '' },
    ], jobRows), { note: 'Each job keeps its own timestamp. A failed refresh keeps the last valid data and marks it stale. Research never runs on a price refresh.' }),
    card('Operation log', table([
      { label: 'When', render: (o) => fmtDateTime(o.at) },
      { label: 'Phase', render: (o) => (o.phase === 'commit' ? 'Committed' : /fail|interrupt|quarant/.test(o.phase || '') ? stateText(o.phase.replace(/_/g, ' '), 'bad') : (o.phase || '').replace(/_/g, ' ')) },
      { label: 'Type', render: (o) => h('code', { class: 'small' }, o.type || '') },
      { label: 'By', key: 'actor' },
      { label: 'Summary', wrap: true, render: (o) => o.summary || o.error || o.note || '' },
    ], idx.imports.recent_operations || [], { empty: 'No writes yet.' }), { note: 'The latest 25 writes from logs/operations.jsonl.' }));
}
