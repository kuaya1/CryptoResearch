'use strict';
// Builds dashboard/demo-workspace: a separate, permanently labeled FICTIONAL
// workspace that shows a populated watchlist, research runs in every state,
// and a portfolio. It never reads or writes the real workspace. Market data is
// switched off there; its prices are fictional. Research providers there are
// MOCK adapters that return fictional fixture reports (never real API calls).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, exists, rmrf, atomicWrite, jsonText } = require('./fsx');
const { initWorkspace, openWorkspace, CODE_ROOT, DEFAULT_ROOT } = require('./workspace');

const DEMO_ROOT = path.join(CODE_ROOT, 'demo-workspace');
const FIXTURES = path.join(CODE_ROOT, 'fixtures');
const PROVIDER_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

function seeded(seed) {
  let x = parseInt(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

// A complete fictional report (prose + cr.report.v1 JSON) for a mock research job.
function mockReport(ws, provider, run) {
  const project = require('./projects').getProject(ws, run.project_id);
  const profile = ws.rubrics.profiles[run.sector_profile];
  const grading = ws.rubrics.gradingVersions[run.rubric_version] || ws.rubrics.grading;
  const rnd = seeded(`${run.project_id}|${provider}`);
  const score = (lo = 30, hi = 85) => Math.round(lo + rnd() * (hi - lo));
  const s = (v, why) => ({ status: 'scored', value: v, low: null, high: null, rationale: `FICTIONAL ${why}`, evidence_refs: ['C1'], missing_data: null });
  const diagnostic = {};
  for (const c of profile.diagnostic_categories) {
    diagnostic[c.id] = c.applicable === false ? { status: 'not_applicable', value: null, low: null, high: null, rationale: c.na_reason || 'Not applicable', evidence_refs: [], missing_data: null } : s(score(), `${c.label} assessment`);
  }
  const components = {};
  for (const c of grading.investment_components) components[c.id] = s(score(25, 80), c.label);
  const risk = {};
  for (const r of grading.risk_scores) {
    const na = r.id === 'credit' && profile.risk_applicability && profile.risk_applicability.credit === false;
    risk[r.id] = na ? { status: 'not_applicable', value: null, low: null, high: null, rationale: 'Not applicable under this profile', evidence_refs: [], missing_data: null } : s(score(25, 85), r.label);
  }
  const today = new Date().toISOString().slice(0, 10);
  const verdicts = ['CONDITIONAL OPPORTUNITY', 'REAL PRODUCT, WEAK TOKEN', 'INSUFFICIENT EVIDENCE'];
  const verdict = verdicts[Math.floor(rnd() * verdicts.length)];
  // A run under the position-cycle recipe gets a FICTIONAL position_context
  // and a catalyst with a window inside the run's horizon.
  const h = run.horizon || {};
  const positional = Boolean(h.recipe && h.start_date && h.end_date);
  const { addDays } = require('./dates');
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const reviewDay = positional ? addDays(h.start_date, 35 + Math.floor(rnd() * 20)) : null;
  const positionContext = positional ? {
    recipe: h.recipe,
    horizon: { mode: h.mode, start_date: h.start_date, end_date: h.end_date },
    market: { state: pick(['bitcoin_led', 'mixed', 'broad_altcoin_participation']), rationale: 'FICTIONAL reading of the demo market snapshot. Not research.', evidence_refs: ['C1'] },
    timing: { state: pick(['early', 'developing', 'extended']), rationale: 'FICTIONAL timing view for the demo. Not research.', evidence_refs: ['C1'], next_review_date: reviewDay < h.end_date ? reviewDay : h.end_date, review_trigger: 'FICTIONAL: re-check sooner if the demo upgrade slips.' },
    long_term_note: null,
  } : undefined;
  const catalysts = positional
    ? [{ title: 'FICTIONAL mainnet upgrade', date: null, date_precision: 'window', window_start: addDays(h.start_date, 20), window_end: addDays(h.start_date, 50), kind: 'product', status: 'announced', certainty: 'project_claimed', in_horizon: true, claim_ids: ['C1'] }]
    : [];
  const json = {
    schema_version: 'cr.report.v1',
    report_id: null,
    research_run_id: run.run_id,
    project_id: run.project_id,
    project_name: project.name,
    project_symbol: project.symbol,
    provider,
    model_self_identification: `FICTIONAL demo fixture standing in for ${PROVIDER_NAMES[provider]}`,
    model_version: null,
    model_version_note: 'Mock adapter in the fictional demo workspace; not a real model answer.',
    analysis_at: today,
    horizon: run.horizon.text,
    prompt_version: run.prompt.version,
    rubric_version: run.rubric_version,
    sector_profile: run.sector_profile,
    verdict,
    summary: `FICTIONAL ${PROVIDER_NAMES[provider]} demo assessment of ${project.name}. Not research.`,
    diagnostic_scores: diagnostic,
    investment_components: components,
    model_reported_overall_score: null,
    risk_scores: risk,
    sources: [{ source_id: 'S1', url: 'https://example.com/fictional-source', title: 'FICTIONAL example source', publisher: 'example.com', source_type: 'other', accessed_at: today }],
    claims: [{ claim_id: 'C1', text: 'FICTIONAL claim used by every score in this demo report.', evidence_tag: 'I', source_ids: ['S1'], metric_id: 'tvl_usd', value: Math.round(1e6 + rnd() * 9e6), unit: 'USD', definition: 'FICTIONAL total value locked', period: 'spot', as_of: today, limitation: 'Fictional', section: null }],
    bullish_facts: [{ text: 'FICTIONAL bullish fact.', claim_ids: ['C1'] }],
    bearish_facts: [{ text: 'FICTIONAL bearish fact.', claim_ids: ['C1'] }],
    conviction_increases: [{ text: 'FICTIONAL development that would raise conviction.', claim_ids: [] }],
    invalidators: [{ text: 'FICTIONAL thesis invalidator.', claim_ids: [] }],
    catalysts,
    unlocks: [],
    tokenomics_changes: [],
    economics: {},
    scenarios: { btc_relative_definition: '(1 + token return) / (1 + BTC return) - 1 over the horizon', items: [{ case: 'bull', probability_pct: 25, price_range_usd: { low: null, high: null }, relative_return_vs_btc_pct: { low: null, high: null } }, { case: 'base', probability_pct: 45, price_range_usd: { low: null, high: null }, relative_return_vs_btc_pct: { low: null, high: null } }, { case: 'bear', probability_pct: 30, price_range_usd: { low: null, high: null }, relative_return_vs_btc_pct: { low: null, high: null } }] },
    next_metric_to_monitor: { metric: 'FICTIONAL metric', why: 'Demo', threshold: null },
    position_context: positionContext,
    final_take: 'FICTIONAL demo take. Nothing here is real research.',
    unresolved_questions: ['FICTIONAL open question?'],
    original_report_reference: { note: 'The written report above this JSON block is the original.' },
  };
  const prose = [
    `# ${project.name}: FICTIONAL ${PROVIDER_NAMES[provider]} demo report`,
    '',
    `Analysis date: ${today}`,
    `Horizon: ${run.horizon.text}`,
    '',
    'This text was produced by the mock research adapter of the fictional demo workspace to show how a',
    'completed research job looks. It is not research, not a real model answer, and not advice. Every',
    'number and sentence here is invented for display purposes only, and the project itself is fictional.',
    '',
    `Verdict: ${verdict}`,
    '',
    '```json',
    JSON.stringify(json, null, 2),
    '```',
    '',
  ].join('\n');
  return prose;
}

// A labeled FICTIONAL snapshot in the shape of a real one (cycle.js).
function demoMarketContext(ws) {
  const cycle = require('./cycle');
  const now = new Date().toISOString();
  const r = (id, symbol, price, ch7, ch30) => ({ id, symbol, name: `${id} (FICTIONAL)`, current_price: price, market_cap: 1e9, price_change_percentage_7d_in_currency: ch7, price_change_percentage_30d_in_currency: ch30, last_updated: now });
  const rows = [
    { ...r('bitcoin', 'btc', 61000, 2.2, 5.1), name: 'Bitcoin' },
    { ...r('ethereum', 'eth', 2600, 1.4, 3.2), name: 'Ethereum' },
    { ...r('tether', 'usdt', 1, 0, 0.01), name: 'Tether' },
    r('example-infra-fictional', 'xinf', 1.84, -4.6, 18.9),
    r('example-payfi-fictional', 'xmpl', 0.27, 11.8, -6.2),
    r('example-ai-fictional', 'xaid', 0.061, 31.2, 54),
    r('example-game-fictional', 'xgme', 0.0042, -12.5, -28.1),
    r('example-alt-one-fictional', 'xa1', 2, 1, 2),
    r('example-alt-two-fictional', 'xa2', 3, -2, 4),
  ];
  const global = { data: { total_market_cap: { usd: 2.1e12 }, total_volume: { usd: 7e10 }, market_cap_percentage: { btc: 56.4, eth: 11.8 }, market_cap_change_percentage_24h_usd: 0.6, updated_at: Math.floor(Date.now() / 1000) } };
  return cycle.saveSnapshot(ws, cycle.buildSnapshot({ global, rows, capturedAt: now, fictional: true }));
}

function sparkline(seed, start, drift) {
  const rnd = seeded(seed);
  const out = [];
  let v = start;
  for (let i = 0; i < 84; i++) {
    v = Math.max(start * 0.2, v * (1 + (rnd() - 0.5) * 0.04 + drift / 84));
    out.push(Number(v.toPrecision(6)));
  }
  return out;
}

function minimalPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 12 Tf 20 100 Td (FICTIONAL DEMO PDF) Tj ET';
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function buildDemo({ root = DEMO_ROOT } = {}) {
  if (exists(root)) {
    const meta = readJson(path.join(root, 'workspace.json'), null);
    if (!meta || meta.kind !== 'demo') throw new Error(`Refusing to replace ${root}: it is not marked as a demo workspace.`);
    rmrf(root);
  }
  initWorkspace(root, { kind: 'demo', name: 'DEMO - fictional data', templatesFrom: path.join(DEFAULT_ROOT, 'templates') });
  const settings = (mocks) => ({
    schema_version: 1,
    note: 'DEMO workspace: market data is off so no fictional IDs are sent to CoinGecko; prices here are fictional. Research providers are mock adapters returning fictional reports.',
    server: { port: 4739 },
    market_data: { enabled: false },
    research: { providers: mocks, max_attempts: 2 },
  });
  const settingsFile = path.join(root, 'config', 'settings.json');
  atomicWrite(settingsFile, jsonText(settings({ claude: { mock: 'ok' }, chatgpt: { mock: 'ok' }, gemini: { mock: 'timeout' } })));
  let ws = openWorkspace({ root, actor: 'demo-builder' });
  const projects = require('./projects');
  const inbox = require('./inbox');
  const notes = require('./notes');
  const portfolio = require('./portfolio');
  const research = require('./research');

  const add = (p) => projects.addProject(ws, { ...p, evidence: p.coingecko_id ? [{ url: 'https://example.com/fictional-evidence', note: 'FICTIONAL demo evidence; example.com is a reserved example domain.' }] : [], official_website: p.coingecko_id ? `https://${String(p.symbol).toLowerCase()}.example/` : null, utterance: `DEMO: add ${p.name} to my watchlist` });
  const main = add({ name: 'Example PayFi (FICTIONAL)', symbol: 'XMPL', coingecko_id: 'example-payfi-fictional', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMPL', standard: 'fictional' }], sector: 'payments', sector_profile: 'payfi-credit@1' });
  const infra = add({ name: 'Example Infra Network (FICTIONAL)', symbol: 'XINF', coingecko_id: 'example-infra-fictional', sector: 'infrastructure' });
  const ai = add({ name: 'Example AI Data (FICTIONAL)', symbol: 'XAID', coingecko_id: 'example-ai-fictional', sector: { primary: 'ai_data', tags: ['inference'] } });
  const defi = add({ name: 'Example DeFi Lend (FICTIONAL)', symbol: 'XDFL', coingecko_id: 'example-defi-fictional', sector: 'defi' });
  const game = add({ name: 'Example Game (FICTIONAL)', symbol: 'XGME', coingecko_id: 'example-game-fictional', sector: 'gaming' });
  add({ name: 'Pending Draft Token (FICTIONAL)', symbol: 'PDT', identity_status: 'pending', sector: 'other' });

  for (const [provider, file] of [['claude', 'example-payfi-fictional__claude.md'], ['chatgpt', 'example-payfi-fictional__chatgpt.md'], ['gemini', 'example-payfi-fictional__gemini.md']]) {
    fs.copyFileSync(path.join(FIXTURES, 'reports', file), path.join(root, 'inbox', provider, file));
  }
  fs.copyFileSync(path.join(FIXTURES, 'reports', 'example-payfi-fictional__prose-claude.md'), path.join(root, 'inbox', 'claude', 'example-payfi-fictional__prose-claude.md'));
  const scan = inbox.scanInbox(ws, { force: true });
  inbox.importContent(ws, 'claude', { content: minimalPdf(), filename: 'example-game-fictional.pdf', projectId: game.project_id });

  // A FICTIONAL market-cycle snapshot, so new runs carry one (market data is off here).
  demoMarketContext(ws);

  // Research runs in different states (mock adapters, fictional output): a
  // 4-month position run, and a long-term exception with its stated reason.
  research.createRun(ws, { project_id: infra.project_id, providers: ['claude', 'chatgpt', 'gemini'], channel: 'dashboard', utterance: 'DEMO: research Example Infra with Claude, GPT and Gemini' });
  await research.runDueJobs(ws, { trigger: 'demo' });
  await research.runDueJobs(ws, { trigger: 'demo' });
  atomicWrite(settingsFile, jsonText(settings({ claude: { mock: 'ok' } })));
  ws = openWorkspace({ root, actor: 'demo-builder' });
  research.createRun(ws, { project_id: ai.project_id, providers: ['claude', 'chatgpt', 'gemini'], horizon: '12 months', long_term_reason: 'FICTIONAL demo: a structural thesis on data demand, recorded as a long-term exception.', channel: 'dashboard', utterance: 'DEMO: research Example AI Data over 12 months' });
  await research.runDueJobs(ws, { trigger: 'demo' });
  atomicWrite(settingsFile, jsonText(settings({ claude: { mock: 'ok' }, chatgpt: { mock: 'ok' }, gemini: { mock: 'timeout' } })));
  ws = openWorkspace({ root, actor: 'demo-builder' });

  portfolio.addAccount(ws, { account_id: 'demo-exchange', name: 'Demo exchange (FICTIONAL)', kind: 'exchange' });
  portfolio.addAccount(ws, { account_id: 'demo-wallet', name: 'Demo wallet (FICTIONAL)', kind: 'self_custody', chain: 'example-chain' });
  portfolio.importCsv(ws, fs.readFileSync(path.join(FIXTURES, 'portfolio', 'fictional-transactions.csv'), 'utf8'), { filename: 'fictional-transactions.csv' });
  portfolio.setLimits(ws, { speculative_capital_cap_usd: 2000, max_position_pct: 40, max_sector_pct: 60 });

  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const obs = (id, symbol, name, price, extra) => ({
    id, symbol, name: `${name} (FICTIONAL)`, image_url: null, price_usd: price, rank_source: 'fictional-demo', source: 'FICTIONAL demo data',
    source_last_updated_at: iso(2 * 60000), fetched_at: iso(60000), ...extra,
  });
  const assets = {
    'example-payfi-fictional': obs('example-payfi-fictional', 'XMPL', 'Example PayFi', 0.27, { market_cap_usd: 54e6, market_cap_rank: 412, fdv_usd: 270e6, volume_24h_usd: 3.1e6, change_24h_pct: 2.4, change_7d_pct: 11.8, change_30d_pct: -6.2, market_cap_change_24h_pct: 2.1, circulating_supply: 2e8, total_supply: 1e9, max_supply: 1e9, sparkline_7d: sparkline('xmpl', 0.24, 0.12) }),
    'example-infra-fictional': obs('example-infra-fictional', 'XINF', 'Example Infra Network', 1.84, { market_cap_usd: 920e6, market_cap_rank: 88, fdv_usd: 1.8e9, volume_24h_usd: 41e6, change_24h_pct: -1.3, change_7d_pct: -4.6, change_30d_pct: 18.9, market_cap_change_24h_pct: -1.1, circulating_supply: 5e8, total_supply: 1e9, max_supply: null, sparkline_7d: sparkline('xinf', 1.93, -0.05) }),
    'example-ai-fictional': obs('example-ai-fictional', 'XAID', 'Example AI Data', 0.061, { market_cap_usd: 12.4e6, market_cap_rank: 1290, fdv_usd: 61e6, volume_24h_usd: 0.4e6, change_24h_pct: 7.9, change_7d_pct: 31.2, change_30d_pct: 54.0, market_cap_change_24h_pct: 7.5, circulating_supply: 2.03e8, total_supply: 1e9, max_supply: 1e9, sparkline_7d: sparkline('xaid', 0.046, 0.3) }),
    'example-game-fictional': obs('example-game-fictional', 'XGME', 'Example Game', 0.0042, { market_cap_usd: 3.1e6, market_cap_rank: 2405, fdv_usd: 4.2e6, volume_24h_usd: 0.09e6, change_24h_pct: -3.4, change_7d_pct: -12.5, change_30d_pct: -28.1, market_cap_change_24h_pct: null, circulating_supply: 7.4e8, total_supply: 1e9, max_supply: 1e9, sparkline_7d: sparkline('xgme', 0.0048, -0.13), source_last_updated_at: iso(7 * 3600000), fetched_at: iso(7 * 3600000) }),
    bitcoin: obs('bitcoin', 'BTC', 'Bitcoin', 61000, { market_cap_usd: 1.2e12, market_cap_rank: 1, fdv_usd: 1.28e12, volume_24h_usd: 28e9, change_24h_pct: 0.8, change_7d_pct: 2.2, change_30d_pct: 5.1, sparkline_7d: sparkline('btc', 59800, 0.02) }),
    'usd-coin': obs('usd-coin', 'USDC', 'USDC', 1, { market_cap_usd: 33e9, market_cap_rank: 7, volume_24h_usd: 6e9, change_24h_pct: 0, change_7d_pct: 0.01, change_30d_pct: -0.01 }),
  };
  atomicWrite(ws.abs('market-data/latest.json'), jsonText({ schema_version: 'cr.market-latest.v2', provider: 'fictional-demo', rank_source: 'FICTIONAL demo rank', note: 'FICTIONAL prices for the demo workspace. Not market data. Example DeFi Lend has no price on purpose; Example Game is stale on purpose.', fetched_at: iso(60000), assets }));
  atomicWrite(ws.abs('market-data/status.json'), jsonText({ schema_version: 'cr.market-status.v2', state: 'ok', last_attempt_at: iso(60000), last_success_at: iso(60000), last_trigger: 'demo-builder', last_error: null, consecutive_failures: 0, note: 'FICTIONAL demo status', calls: { month: iso(0).slice(0, 7), month_count: 0, day: iso(0).slice(0, 10), day_count: 0 } }));

  const id = main.project_id;
  notes.setConvictionNote(ws, id, 'FICTIONAL demo note: real product, token does not capture value yet. Waiting for the fee switch to be implemented on-chain before considering a position.', { conviction: 'low' });
  notes.addJournal(ws, id, { type: 'decision', decision: 'watch', conviction: 'low', text: 'FICTIONAL demo decision: keep watching; do not add.', reasons: ['Fee switch only announced', 'Models disagree on token value capture'] });
  notes.addEvent(ws, id, { type: 'review', title: 'FICTIONAL: re-check the fee switch vote', due: 'next friday' });
  notes.addEvent(ws, id, { type: 'alert', title: 'FICTIONAL: price below 0.30', alert_kind: 'price_below', threshold_usd: 0.3 });
  notes.addEvent(ws, defi.project_id, { type: 'review', title: 'FICTIONAL: overdue review example', due: '2026-09-01' });
  notes.addDispute(ws, id, { topic: 'metric:protocol_revenue_usd', question: 'FICTIONAL: which 30-day revenue figure matches the on-chain fee contract?' });
  const reports = require('./reports').loadReports(ws, id).filter((r) => !r.broken && r.assessment.source_format !== 'prose');
  const claude = reports.find((r) => r.meta.provider === 'claude');
  if (claude) {
    projects.setHeadline(ws, id, { report_id: claude.report_id, note: 'FICTIONAL demo headline choice' });
    notes.reviewClaim(ws, id, claude.report_id, 'C2', { dashboard_check: 'source_reachable', corroboration: 'single_source_only', note: 'FICTIONAL: opened the dashboard link; not independently corroborated.' });
  }
  const { rebuildIndex } = require('./indexer');
  rebuildIndex(ws);
  return {
    status: 'built',
    root,
    kind: 'demo',
    imported: scan.counts,
    launch: 'node dashboard/cli.js serve --workspace dashboard/demo-workspace --open   (or "Open Demo Dashboard.cmd")',
    note: 'Everything in this workspace is FICTIONAL and separate from your real records. Its research providers are mock adapters.',
  };
}

module.exports = { buildDemo, mockReport, DEMO_ROOT };
