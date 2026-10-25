'use strict';
// Guardrail invariants (item 14, W2.6): scanned over the API answers of a rich
// fictional workspace (three models' reports, a saved PM ticket and a desk-gate
// ticket, the index, the forensics tab, outcomes, the portfolio). They hold the
// desk to what its rules say, wherever a later change adds a field or a line:
//   - no desk-generated text puts a % beside probability, chance or likely;
//   - no unknown value is serialized as 0 where the record has none;
//   - there are no averaged or midpoint grade fields;
//   - every two-agent or two-model view carries both figures;
//   - nothing is labeled safe.
// Model-authored text (reports, claims, scenarios, the Prosecutor's own words)
// is the model's, not the desk's, and is not scanned for wording.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { tempWorkspace, addFixtureProject, importAllFixtures, withExitReadings, freshPrice } = require('./helpers');
const { start } = require('../server');
const T = require('../core/tickets');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

const PORT = 47500 + Math.floor(Math.random() * 400);

function get(port, token, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, 'x-cr-token': token } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Every [path, value] leaf of a JSON value, skipping subtrees that hold a
// model's own words or the saved original.
// guidance: the published prompt asks the model for probabilities; extraction: parse notes about the report's own numbers.
const MODEL_AUTHORED = new Set(['guidance', 'extraction', 'analysis', 'scenarios', 'claims', 'sources', 'text', 'original', 'normalized', 'prosecution', 'proposal', 'strongest_bull_rebuttal', 'non_consensus_thesis', 'statement', 'excerpt', 'finding', 'summary_text', 'agent_disagreement_note']);
function leaves(value, path = [], out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => leaves(v, [...path, String(i)], out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (MODEL_AUTHORED.has(k)) continue;
      leaves(v, [...path, k], out);
    }
  } else out.push([path.join('.'), value]);
  return out;
}

const PROB_PCT = /(probab\w*|chance|likel\w*)[^.\n]{0,24}\d+(\.\d+)?\s*%|\d+(\.\d+)?\s*%[^.\n]{0,24}(probab\w*|chance|likel\w*)/i;
const SAFE_WORD = /(^|[^a-z])(safe|safely|secure|risk[- ]free)([^a-z]|$)/i;
const NEGATED_SAFE = /\b(never|not|no|nothing|isn't|is not|cannot|can't|without|un)\W+(\w+\W+){0,3}(labeled |called |read as |treated as |declared )?(safe|secure)/i;
const AVERAGED_KEY = /(^|[_.])(avg|average|averaged|mean|midpoint|mid|blended|composite|combined)(_|\.|$)/i;

function ticketAnswer(ticket, over = {}) {
  const at = new Date().toISOString();
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: at,
    researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: {
      verdict: 'thesis_damaged', conviction_score: 38,
      tests: { mercenary_emissions: { result: 'fail', finding: 'Rewards exceed fees (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'Partner list unsourced.' } },
      fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'Activity is paid for by emissions (FICTIONAL).', source_ids: ['S1'] }],
      strongest_bull_rebuttal: 'Emissions taper next quarter.',
    },
    proposal: { proposal_type: 'ACCUMULATE', non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.', entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' }, upside_target: { price_usd: 1.4, basis: 'fees double' }, invalidation_trigger: { price_usd: 0.7, statement: 'Below $0.70.' } },
    agent_disagreement_note: 'The researcher grades 60.5; I score 38.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: at, excerpt: 'fictional' }],
    ...over,
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

async function richWorkspace(t) {
  const w = tempWorkspace('guardrails');
  const { ws } = w;
  const project = addFixtureProject(ws);
  const pid = project.project_id;
  importAllFixtures(ws);
  // A second project with nothing known: no price, no report, no ticket.
  const bare = require('../core/projects').addProject(ws, { name: 'Bare Example (FICTIONAL)', symbol: 'BARE', official_website: 'https://bare-example.org', identity_status: 'pending' });
  // Held, so the Prosecutor opens; a $500 exit is proven in the ticket's basis.
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => { const pf = real(...a); return { ...pf, positions: [{ project_id: pid, closed: false }] }; };
  const tk = withExitReadings(1.5, () => T.createTicket(ws, { project_id: pid, assistant: true })).ticket;
  freshPrice(ws, 'example-payfi-fictional', 0.85);
  const saved = T.saveTicket(ws, { project_id: pid, ticket_id: tk.ticket_id, text: ticketAnswer(T.loadTicket(ws, pid, tk.ticket_id)) });
  portfolio.computePortfolio = real;
  const srv = await start(ws, { port: PORT + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } w.cleanup(); });
  const session = (await get(srv.port, '', '/api/session')).json;
  return { ws, pid, bare: bare.project_id, saved, port: srv.port, token: session.token };
}

async function answers(r) {
  const paths = ['/api/index', `/api/projects/${r.pid}`, `/api/projects/${r.bare}`, `/api/projects/${r.pid}/tickets`, `/api/projects/${r.bare}/tickets`, `/api/projects/${r.pid}/forensics`, `/api/projects/${r.pid}/outcomes`, '/api/research/outcomes', '/api/portfolio/ledger', '/api/agenda', '/api/wallets'];
  const out = {};
  for (const p of paths) out[p] = await get(r.port, r.token, p);
  return out;
}

test('guardrails: the rich fictional workspace answers every read', async (t) => {
  const r = await richWorkspace(t);
  const all = await answers(r);
  for (const [p, a] of Object.entries(all)) assert.ok(a.status === 200 && a.json, `${p} -> ${a.status} ${a.text.slice(0, 120)}`);
});


const textLeaves = (all) => Object.entries(all).flatMap(([p, a]) => leaves(a.json).filter(([, v]) => typeof v === 'string').map(([k, v]) => [`${p} ${k}`, v]));

test('guardrails: no desk-generated text puts a % beside probability, chance or likely', async (t) => {
  const r = await richWorkspace(t);
  const all = await answers(r);
  const bad = textLeaves(all).filter(([, v]) => PROB_PCT.test(v));
  assert.deepEqual(bad, []);
  // The pattern itself catches what it is meant to.
  assert.ok(PROB_PCT.test('A 62% chance of reaching the target'));
  assert.ok(PROB_PCT.test('Probability: 40 %'));
  assert.ok(!PROB_PCT.test('Exit cost 3.1% at $500'));
});

test('guardrails: nothing is labeled safe', async (t) => {
  const r = await richWorkspace(t);
  const all = await answers(r);
  const bad = textLeaves(all).filter(([, v]) => SAFE_WORD.test(v) && !NEGATED_SAFE.test(v));
  assert.deepEqual(bad, []);
  assert.ok(SAFE_WORD.test('This token is safe') && !NEGATED_SAFE.test('This token is safe'));
  assert.ok(NEGATED_SAFE.test('Nothing is ever labeled safe'));
});

test('guardrails: there are no averaged or midpoint grade fields', async (t) => {
  const r = await richWorkspace(t);
  const all = await answers(r);
  const bad = Object.entries(all).flatMap(([p, a]) => leaves(a.json).filter(([k]) => AVERAGED_KEY.test(k)).map(([k]) => `${p} ${k}`));
  assert.deepEqual(bad, []);
  assert.ok(AVERAGED_KEY.test('providers.consensus.average_grade') && AVERAGED_KEY.test('grade_midpoint'));
});

test('guardrails: an unknown value is null, never 0', async (t) => {
  const r = await richWorkspace(t);
  const all = await answers(r);
  const idx = all['/api/index'].json;
  const bare = idx.projects.find((p) => p.project_id === r.bare);
  const rich = idx.projects.find((p) => p.project_id === r.pid);
  assert.ok(bare && rich);
  // No price or figure on file: the market block carries none, and nothing reads as zero.
  for (const row of [bare, rich]) {
    for (const [k, v] of leaves(row.market || {})) assert.ok(v !== 0, `${row.project_id} market.${k} is 0`);
  }
  // No report, no grade, no ticket, no decision: null, not 0.
  assert.equal(bare.headline ?? null, null);
  assert.equal(bare.position ?? null, null);
  const bareTickets = all[`/api/projects/${r.bare}/tickets`].json;
  assert.equal(bareTickets.ticket, null);
  const rt = all[`/api/projects/${r.pid}/tickets`].json.ticket;
  assert.equal(rt.pm_approved_risk_usd, null, 'no decision yet: no approved risk');
  assert.equal(rt.decision, null);
  // A ticket with no exit reading: the cost is null and the missing size is named.
  const second = T.createTicket(r.ws, { project_id: r.pid, refresh: true, assistant: true }).ticket;
  T.saveTicket(r.ws, { project_id: r.pid, ticket_id: second.ticket_id, text: ticketAnswer(T.loadTicket(r.ws, r.pid, second.ticket_id)) });
  const noExit = (await get(r.port, r.token, `/api/projects/${r.pid}/tickets`)).json.ticket;
  assert.equal(noExit.exit_cost_500_usd_pct, null);
  assert.equal(noExit.exit_cost_2000_usd_pct, null);
  assert.ok(noExit.exits_missing.length > 0);
  assert.equal(noExit.pm_approved_risk_usd, null);
});

test('guardrails: a view of two agents carries both figures, never one of them or a blend', async (t) => {
  const r = await richWorkspace(t);
  const all = await answers(r);
  const tk = all[`/api/projects/${r.pid}/tickets`].json.ticket;
  assert.equal(tk.kind, 'prosecutor');
  const d = tk.agent_disagreement;
  assert.equal(typeof d.researcher.grade, 'number');
  assert.equal(typeof d.prosecutor.conviction_score, 'number');
  assert.equal(d.spread_points, Math.abs(d.researcher.grade - d.prosecutor.conviction_score));
  assert.equal(tk.prosecution.conviction_score, d.prosecutor.conviction_score);
  assert.equal(tk.researcher.grade, d.researcher.grade);
  // The index row's ticket carries the same pair.
  const row = all['/api/index'].json.projects.find((p) => p.project_id === r.pid);
  assert.equal(row.ticket.agent_disagreement.researcher.grade, d.researcher.grade);
  assert.equal(row.ticket.agent_disagreement.prosecutor.conviction_score, d.prosecutor.conviction_score);
  // The three models' reports are listed each with its own grade.
  const detail = all[`/api/projects/${r.pid}`].json;
  const byModel = new Map(detail.reports.map((x) => [x.meta.provider, x]));
  for (const m of ['claude', 'chatgpt', 'gemini']) {
    assert.ok(byModel.has(m), `${m} report listed`);
    assert.ok(byModel.get(m).grade, `${m} has its own grade record`);
  }
  const cmp = row.comparison;
  assert.deepEqual([...cmp.comparable_providers].sort(), ['chatgpt', 'claude', 'gemini']);
  for (const x of cmp.rows) assert.ok(!('average' in x) && !('midpoint' in x) && !('winner' in x));
});
