'use strict';
// Backend pieces added for the watchlist interface: identity lookup, logos,
// the transaction ledger route, PDF-only badges and safe serialization.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, dropText, FIXTURES } = require('./helpers');
const { readJson, atomicWrite, jsonText } = require('../core/fsx');

function request(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function fakeSearch(coins, { status = 200 } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    return { ok: status === 200, status, headers: { get: () => null }, json: async () => ({ coins }) };
  };
  f.calls = calls;
  return f;
}

test('identity lookup returns candidates only, flags shared tickers and counts the call', async (t) => {
  const { ws, cleanup } = tempWorkspace('lookup', { market_data: { enabled: true } });
  t.after(cleanup);
  const market = require('../core/market');
  const f = fakeSearch([
    { id: 'allora', name: 'Allora', symbol: 'allo', market_cap_rank: 400 },
    { id: 'allo-other', name: 'Allo Other', symbol: 'ALLO', market_cap_rank: null },
    { id: '../evil', name: 'bad id', symbol: 'X' },
  ]);
  const r = await market.searchCoins(ws, 'allo', { fetchImpl: f });
  assert.equal(r.status, 'ok');
  assert.match(f.calls[0], /\/search\?query=allo$/);
  assert.deepEqual(r.candidates.map((c) => c.coingecko_id), ['allora', 'allo-other']);
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates[0].rank_source, 'CoinGecko market-cap rank');
  assert.equal(market.readStatus(ws).calls.month_count, 1);
  // Nothing is bound: no project or market record was written.
  assert.equal(fs.existsSync(path.join(ws.root, 'market-data', 'latest.json')), false);

  const failed = await market.searchCoins(ws, 'allo', { fetchImpl: fakeSearch([], { status: 429 }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.candidates.length, 0);
  assert.equal(market.readStatus(ws).calls.month_count, 2);

  const short = await market.searchCoins(ws, 'a', { fetchImpl: f });
  assert.equal(short.status, 'invalid');
  assert.equal(f.calls.length, 1);
});

test('a PDF-only report shows as "needs text", never as "no research", and raises a review item', (t) => {
  const { ws, cleanup } = tempWorkspace('pdfonly');
  t.after(cleanup);
  const added = addFixtureProject(ws);
  const inbox = require('../core/inbox');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
  const r = inbox.importContent(ws, 'claude', { content: pdf, filename: 'fictional-report.pdf', projectId: added.project_id });
  assert.equal((r.result || r).status, 'ingested');
  const { buildIndex } = require('../core/indexer');
  const idx = buildIndex(ws);
  const p = idx.projects.find((x) => x.project_id === added.project_id);
  assert.ok(p.providers.claude, 'the PDF report is visible');
  assert.equal(p.providers.claude.needs_text, true);
  assert.equal(p.providers.claude.latest_eligible, false);
  assert.notEqual(p.providers.claude.grade && p.providers.claude.grade.status, 'firm');
  assert.equal(p.providers.chatgpt, null);
  assert.ok(idx.attention.some((a) => a.kind === 'needs_text' && a.project_id === added.project_id));
  // Comparison still ignores the PDF.
  assert.deepEqual(p.comparison.comparable_providers, []);
});

test('adding a project with a research horizon saves a valid record from every entry point', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('horizon');
  t.after(cleanup);
  const projects = require('../core/projects');
  // Core / CLI path (project add --horizon).
  const a = projects.addProject(ws, { name: 'Horizon Test One (FICTIONAL)', horizon: '3 months', research_providers: ['gpt', 'Claude', 'gpt'] });
  assert.equal(a.status, 'created');
  const pa = projects.getProject(ws, a.project_id);
  assert.deepEqual(pa.research_defaults, { horizon: '3 months', providers: ['chatgpt', 'claude'] });
  // Above the 4-month planning ceiling a horizon is a long-term exception: it needs a reason.
  // Above the 4-month ceiling a horizon is labeled long-term; a reason is kept when given.
  const b = projects.addProject(ws, { name: 'Horizon Test Two (FICTIONAL)', horizon: '12-24 months', long_term_reason: 'FICTIONAL structural thesis' });
  assert.deepEqual(projects.getProject(ws, b.project_id).research_defaults, { horizon: '12-24 months', providers: [], long_term_reason: 'FICTIONAL structural thesis' });
  // Cowork request queue path.
  const requests = require('../core/requests');
  fs.writeFileSync(path.join(root, 'inbox', 'requests', 'req_horizon_0001.json'), JSON.stringify({ schema_version: 'cr.request.v1', request_id: 'req_horizon_0001', action: 'add_project', args: { name: 'Horizon Test Three (FICTIONAL)', horizon: '24 months', long_term_reason: 'FICTIONAL exception for the queue path', research_providers: ['gemini'] } }));
  requests.processRequests(ws);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'requests', 'req_horizon_0001.result.json'), 'utf8'));
  assert.equal(receipt.status, 'done', JSON.stringify(receipt));
  // Dashboard path (POST /api/projects with research).
  const { start } = require('../server');
  const srv = await start(ws, { port: 48950 + Math.floor(Math.random() * 40), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const session = JSON.parse((await request(srv.port, { path: '/api/session' })).body.toString('utf8'));
  const res = await request(srv.port, {
    method: 'POST',
    path: '/api/projects',
    headers: { 'x-cr-token': session.token, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' },
    body: { name: 'Horizon Test Four (FICTIONAL)', horizon: '4 months', research: true, research_providers: ['claude', 'chatgpt'], submission_id: 'uitest00horizon01' },
  });
  const out = JSON.parse(res.body.toString('utf8'));
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, 'created');
  assert.ok(out.research && ['created', 'exists'].includes(out.research.status), JSON.stringify(out.research));
  // Replaying the same submission applies once.
  const again = await request(srv.port, {
    method: 'POST',
    path: '/api/projects',
    headers: { 'x-cr-token': session.token, origin: `http://127.0.0.1:${srv.port}`, 'content-type': 'application/json' },
    body: { name: 'Horizon Test Four (FICTIONAL)', horizon: '4 months', research: true, research_providers: ['claude', 'chatgpt'], submission_id: 'uitest00horizon01' },
  });
  assert.equal(again.status, 200);
  assert.equal(projects.listProjects(ws).filter((p) => p.name === 'Horizon Test Four (FICTIONAL)').length, 1);
  assert.equal(require('../core/research').listRuns(ws, out.project_id).length, 1);
});

test('portfolio and index serialize without BigInt errors', (t) => {
  const { ws, cleanup } = tempWorkspace('serial');
  t.after(cleanup);
  addFixtureProject(ws);
  importAllFixtures(ws);
  const portfolio = require('../core/portfolio');
  portfolio.addAccount(ws, { name: 'Fictional wallet', kind: 'self_custody' });
  const acct = portfolio.loadAccounts(ws)[0].account_id;
  const out = portfolio.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '1234.567890123456789', price_usd: '0.1' }], { source: 'test' });
  assert.equal(out.status, 'saved');
  const pf = portfolio.computePortfolio(ws, { market: { assets: {} } });
  const text = JSON.stringify(pf);
  assert.ok(text.includes('1234.567890123456789'), 'exact quantity kept as a decimal string');
  const { buildIndex } = require('../core/indexer');
  assert.doesNotThrow(() => JSON.stringify(buildIndex(ws)));
});

test('server: logos load without the token but same-origin only; ledger and lookup need the token', async (t) => {
  const { ws, cleanup } = tempWorkspace('uisrv');
  const { start } = require('../server');
  addFixtureProject(ws);
  const logoDir = path.join(ws.root, 'market-data', 'logos');
  fs.mkdirSync(logoDir, { recursive: true });
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');
  fs.writeFileSync(path.join(logoDir, 'example-payfi-fictional.png'), png);
  const srv = await start(ws, { port: 48600 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    cleanup();
  });
  const port = srv.port;
  const logo = await request(port, { path: '/api/logos/example-payfi-fictional' });
  assert.equal(logo.status, 200);
  assert.equal(logo.headers['content-type'], 'image/png');
  assert.equal(logo.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal((await request(port, { path: '/api/logos/nothing-here' })).status, 404);
  assert.notEqual((await request(port, { path: '/api/logos/..%2Fconfig' })).status, 200);
  const cross = await request(port, { path: '/api/logos/example-payfi-fictional', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);

  assert.equal((await request(port, { path: '/api/portfolio/ledger' })).status, 401);
  assert.equal((await request(port, { path: '/api/market/lookup?q=allora' })).status, 401);
  const session = JSON.parse((await request(port, { path: '/api/session' })).body.toString('utf8'));
  const ledger = await request(port, { path: '/api/portfolio/ledger', headers: { 'x-cr-token': session.token } });
  assert.equal(ledger.status, 200);
  const body = JSON.parse(ledger.body.toString('utf8'));
  assert.ok(Array.isArray(body.transactions) && Array.isArray(body.accounts) && Array.isArray(body.assets));
  assert.ok(body.assets.some((a) => a.asset_id === 'example-payfi-fictional'), 'verified project identities are recordable assets');
  // The page itself carries no secrets: the app page at / and every script it
  // loads first (the built bundle, dashboard/web) hold no key, and no key-shaped
  // value appears in any of the app's assets.
  const root = await request(port, { path: '/' });
  assert.equal(root.status, 200);
  const html = root.body.toString('utf8');
  assert.match(html, /<script type="module" crossorigin src="\/app\/assets\/index-[\w-]+\.js"><\/script>/);
  const first = [...html.matchAll(/(?:src|href)="(\/app\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(first.length >= 2, 'the entry and its preloads');
  for (const p of first) {
    const js = (await request(port, { path: p })).body.toString('utf8');
    assert.equal(/api[_-]?key|secret/i.test(p === first[0] ? js : ''), false, `${p}: no key named in the entry`);
  }
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public', 'app', 'assets'))) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'assets', f), 'utf8');
    assert.doesNotMatch(s, /sk-ant-[\w-]{10}|sk-proj-[\w-]{10}|sk-[A-Za-z0-9]{32}|AIza[\w-]{30}|sb_secret_[\w-]{10}|eyJhbGciOi/, `${f}: a key-shaped value`);
  }
});

test('server: a repeated paste is saved once; a fixed retry reuses the saved copy', async (t) => {
  const { ws, cleanup } = tempWorkspace('uiimport');
  const { start } = require('../server');
  addFixtureProject(ws);
  const srv = await start(ws, { port: 48900 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => {
    try { srv.shutdown(); } catch (_) { /* stopped */ }
    cleanup();
  });
  const port = srv.port;
  const session = JSON.parse((await request(port, { path: '/api/session' })).body.toString('utf8'));
  const good = { 'x-cr-token': session.token, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` };
  const post = async (p, body) => {
    const r = await request(port, { method: 'POST', path: p, headers: good, body });
    return { status: r.status, body: JSON.parse(r.body.toString('utf8')) };
  };
  const inboxCopies = () => fs.readdirSync(path.join(ws.root, 'inbox', 'claude')).filter((f) => !f.startsWith('.') && f !== 'processed');

  const paste = { provider: 'claude', project_id: null, run_id: null, text: 'FICTIONAL text that is not a report: no JSON block, no scores.', submission_id: 'imtest00000000000000001' };
  const first = await post('/api/import/text', paste);
  assert.equal(first.status, 200);
  assert.notEqual(first.body.result.status, 'ingested', 'not a report, so nothing is imported');
  const again = await post('/api/import/text', paste);
  assert.equal(again.status, 200);
  assert.equal(again.body.saved.filename, first.body.saved.filename, 'the same submission reuses the saved copy');
  assert.equal(inboxCopies().length, 1, 'a double submit leaves one inbox copy');

  // The same submission ID with different content is refused, never applied twice.
  const conflict = await post('/api/import/text', { ...paste, text: 'Different FICTIONAL text.' });
  assert.notEqual(conflict.status, 200);
  assert.equal(inboxCopies().length, 1);

  // Retrying the saved copy works on that file; no new copy is written.
  const retry = await post('/api/inbox/retry', { key: first.body.result.key, project_id: 'example-payfi-fictional', run_id: null });
  assert.equal(retry.status, 200);
  assert.equal(inboxCopies().length, 1);
});

test('a withheld grade carries its unscored parts and the model\'s own notes into the index, never a value', (t) => {
  const { ws, cleanup } = tempWorkspace('unscored');
  t.after(cleanup);
  addFixtureProject(ws);
  // The weighted component (not the diagnostic of the same name) is unknown.
  const [head, tail] = fs.readFileSync(path.join(FIXTURES, 'reports', 'example-payfi-fictional__chatgpt.md'), 'utf8').split('"investment_components"');
  const text = `${head}"investment_components"${tail.replace(/"token_value_capture": \{[^}]*\}/, '"token_value_capture": {"status": "unknown", "value": null, "low": null, "high": null, "rationale": null, "evidence_refs": [], "missing_data": "FICTIONAL: no fee data was found for this token."}')}`;
  assert.match(text, /no fee data was found/);
  dropText(ws, 'chatgpt', 'example-payfi-fictional__chatgpt.md', text);
  require('../core/inbox').scanInbox(ws, { force: true });
  const { buildIndex } = require('../core/indexer');
  const p = buildIndex(ws).projects.find((x) => x.project_id === 'example-payfi-fictional');
  const s = p.providers.chatgpt;
  assert.equal(s.grade.status, 'withheld');
  assert.equal(s.grade.display, null, 'no number stands in for the grade');
  assert.ok(s.grade.coverage_pct > 0 && s.grade.coverage_pct < 100);
  assert.equal(s.unscored.length, 1);
  assert.equal(s.unscored[0].status, 'unknown');
  assert.equal(s.unscored[0].note, 'FICTIONAL: no fee data was found for this token.');
  assert.equal(typeof s.unscored[0].label, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(s.unscored[0], 'value'), false);
});

test('review queue: research waiting, stalled, uncertain or failed opens the project\'s research runs', (t) => {
  const { ws, root, cleanup } = tempWorkspace('attention-research', { research: { providers: {} } });
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  const research = require('../core/research');
  const { buildIndex } = require('../core/indexer');
  ws.actor = 'cowork';
  const run = research.createRun(ws, { project_id: pid, providers: ['claude', 'chatgpt', 'gemini'], horizon: '4 months', channel: 'cowork' });
  ws.actor = 'test';
  assert.equal(run.run.jobs.claude.mode, 'cowork');
  assert.equal(run.run.jobs.chatgpt.state, 'unconfigured');
  const kinds = (idx) => idx.attention.filter((a) => a.project_id === pid && a.kind.startsWith('research_'));
  // Just started: waiting and working are normal, nothing to review yet.
  assert.deepEqual(kinds(buildIndex(ws)), []);
  // Forty minutes later: two models waiting for their assistants, and Cowork has gone quiet.
  const later = kinds(buildIndex(ws, { now: Date.now() + 40 * 60000 }));
  const waiting = later.filter((a) => a.kind === 'research_waiting');
  assert.deepEqual(waiting.map((a) => a.title).sort(), ['Example PayFi (FICTIONAL): ChatGPT research is waiting for you', 'Example PayFi (FICTIONAL): Gemini research is waiting for you']);
  assert.ok(waiting.every((a) => a.severity === 'medium' && a.action === `#/project/${pid}/research`));
  const stalled = later.find((a) => a.kind === 'research_interrupted');
  assert.ok(stalled, JSON.stringify(later));
  assert.match(stalled.title, /Cowork stopped working on its research/);
  assert.equal(stalled.action, `#/project/${pid}/research`);
  // An API call that may have been billed is urgent; a failure opens the runs, not the reports.
  const file = path.join(root, 'projects', pid, 'research', run.run_id, 'run.json');
  const doc = readJson(file);
  doc.jobs.gemini.state = 'uncertain';
  doc.jobs.chatgpt.state = 'failed';
  doc.jobs.chatgpt.error = 'FICTIONAL provider error';
  atomicWrite(file, jsonText(doc));
  const now = kinds(buildIndex(ws));
  const uncertain = now.find((a) => a.kind === 'research_uncertain');
  assert.equal(uncertain.severity, 'high');
  assert.equal(uncertain.action, `#/project/${pid}/research`);
  const failed = now.find((a) => a.kind === 'research_failed');
  assert.equal(failed.detail, 'FICTIONAL provider error');
  assert.equal(failed.action, `#/project/${pid}/research`);
});

test('review queue: stale prices open the activity log and carry the market\'s own note', (t) => {
  const { ws, root, cleanup } = tempWorkspace('attention-market');
  t.after(cleanup);
  fs.mkdirSync(path.join(root, 'market-data'), { recursive: true });
  atomicWrite(path.join(root, 'market-data', 'status.json'), jsonText({ state: 'failed', last_attempt_at: new Date().toISOString(), last_success_at: new Date(Date.now() - 3 * 3600000).toISOString(), last_error: 'HTTP 429', note: 'FICTIONAL: the price source is limiting requests.', consecutive_failures: 2 }));
  const { buildIndex } = require('../core/indexer');
  const item = buildIndex(ws).attention.find((a) => a.kind === 'market_stale');
  assert.ok(item);
  assert.equal(item.action, '#/settings?tab=activity');
  // The market code's own plain-English note (market.freshness), not the raw error.
  assert.equal(item.detail, require('../core/market').freshness(ws).note);
  assert.match(item.detail, /^The last price refresh failed; showing prices from /);
});

test('a closed position is not a holding: the project page and the list do not say Held', (t) => {
  const { ws, cleanup } = tempWorkspace('closed');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  const portfolio = require('../core/portfolio');
  const indexer = require('../core/indexer');
  portfolio.addAccount(ws, { name: 'Fictional wallet', kind: 'self_custody' });
  const acct = portfolio.loadAccounts(ws)[0].account_id;
  assert.equal(portfolio.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '10', price_usd: '0.1' }], { source: 'test' }).status, 'saved');
  assert.ok(indexer.projectDetail(ws, pid).position, 'an open position is a holding');
  assert.equal(indexer.buildIndex(ws).projects.find((p) => p.project_id === pid).held, true);
  assert.equal(portfolio.addTransactions(ws, [{ type: 'sell', date: '2026-09-02', account_id: acct, asset_id: 'example-payfi-fictional', quantity: '10', price_usd: '0.2' }], { source: 'test' }).status, 'saved');
  assert.equal(indexer.projectDetail(ws, pid).position, null, 'sold to zero: no position on the project page');
  assert.equal(indexer.buildIndex(ws).projects.find((p) => p.project_id === pid).held, false);
});
