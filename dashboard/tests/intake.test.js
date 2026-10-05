'use strict';
// Research intake (Stage 1): a link, name or screenshot becomes a confirmed
// identity, one Claude research run and a saved report. CoinGecko and Claude
// are in-process stubs, keys are fake test values, every coin is fictional,
// and every workspace is a temporary TEST workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const intake = require('../core/intake');
const research = require('../core/research');
const projects = require('../core/projects');
const providers = require('../core/providers');
const market = require('../core/market');
const { runOp } = require('../core/ops');
const { mockReport } = require('../core/demo');
const { readJson, atomicWrite, jsonText, readJsonLines } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');

const CG = 'https://api.coingecko.com/api/v3';
const LINK = 'https://coinmarketcap.com/currencies/examplecoin-fictional/';
const COINS = {
  'examplecoin-fictional': { id: 'examplecoin-fictional', name: 'Examplecoin (FICTIONAL)', symbol: 'xmc', market_cap_rank: 412, links: { homepage: ['https://examplecoin.example/', ''] }, platforms: { ethereum: '0x1111111111111111111111111111111111111111', base: '0x2222222222222222222222222222222222222222' }, categories: ['Decentralized Finance (DeFi)', 'Payments'] },
  'examplecoin-classic-fictional': { id: 'examplecoin-classic-fictional', name: 'Examplecoin Classic (FICTIONAL)', symbol: 'xmc', market_cap_rank: 1650, links: { homepage: ['https://classic.example/'] }, platforms: { solana: 'FiCtIoNaLsOlAnAaDdReSs111111111111111111' }, categories: ['Meme'] },
  'other-xmpl-fictional': { id: 'other-xmpl-fictional', name: 'Other Xmpl (FICTIONAL)', symbol: 'xmpl', market_cap_rank: 900, links: { homepage: ['https://otherxmpl.example/'] }, platforms: {}, categories: ['Layer 1 (L1)'] },
};

function cgStub({ search = {}, fail = null } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
  const f = async (url) => {
    calls.push(url);
    if (!url.startsWith(CG)) throw new Error(`unexpected URL ${url}`);
    const u = new URL(url);
    const p = u.pathname.replace('/api/v3', '');
    if (fail) {
      const r = fail(p, calls.length);
      if (r) return r;
    }
    if (p === '/search') return json({ coins: (search[u.searchParams.get('query')] || []).map((id) => ({ id, name: COINS[id].name, symbol: COINS[id].symbol, market_cap_rank: COINS[id].market_cap_rank })) });
    let m = p.match(/^\/coins\/([^/]+)\/contract\/([^/]+)$/);
    if (m) {
      const c = Object.values(COINS).find((x) => Object.entries(x.platforms).some(([k, a]) => k === m[1] && a.toLowerCase() === m[2].toLowerCase()));
      return c ? json(c) : json({ error: 'coin not found' }, 404);
    }
    m = p.match(/^\/coins\/([^/]+)$/);
    if (m) return COINS[m[1]] ? json(COINS[m[1]]) : json({ error: 'coin not found' }, 404);
    return json({ error: 'unknown' }, 404);
  };
  f.calls = calls;
  return f;
}

const SEARCH = { 'examplecoin fictional': ['examplecoin-fictional', 'examplecoin-classic-fictional'], 'Examplecoin (FICTIONAL)': ['examplecoin-fictional'], XMC: ['examplecoin-fictional', 'examplecoin-classic-fictional'], 'other xmpl fictional': ['other-xmpl-fictional'] };

function configure(root, researchSettings) {
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  s.research = { ...(s.research || {}), ...researchSettings };
  atomicWrite(file, jsonText(s));
  return openWorkspace({ root, actor: 'test' });
}

function withKey(t, value = 'test-key-not-real-a') {
  const prev = process.env.ANTHROPIC_API_KEY;
  if (value === null) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
  t.after(() => {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  });
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a00000000049454e44ae426082', 'hex');
const shot = (extra = 0) => ({ media_type: 'image/png', data_base64: Buffer.concat([PNG, Buffer.alloc(extra, 7)]).toString('base64') });

const READ = { project_name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', chain: 'Ethereum', contract_address: null, website: null, coinmarketcap_url: null, coingecko_url: null, confidence: 'high', visible_text: 'Examplecoin XMC $0.42 (FICTIONAL)', notes: null };
function reader(fields = READ) {
  const calls = [];
  const f = async (args) => {
    calls.push(args);
    return { fields, usage: { input_tokens: 1700, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, search_calls: 0, requests: 1 }, attested: { provider: 'anthropic', model: 'claude-test-model' }, raw: '{}' };
  };
  f.calls = calls;
  return f;
}

async function confirmedRun(ws, f, { instructions = null } = {}) {
  const { intake: doc } = intake.createIntake(ws, { link: LINK, instructions });
  await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  return { doc, conf: intake.confirmIntake(ws, doc.intake_id, { coingecko_id: 'examplecoin-fictional' }) };
}

test('intake: links are read from their own text only; other sites are refused', () => {
  const pick = (x) => x && Object.fromEntries(Object.entries(x).filter(([k]) => !['raw', 'query', 'error'].includes(k)));
  assert.deepEqual(pick(intake.parseLink(LINK)), { source: 'coinmarketcap', slug: 'examplecoin-fictional' });
  assert.deepEqual(pick(intake.parseLink('coinmarketcap.com/currencies/examplecoin-fictional/markets/')), { source: 'coinmarketcap', slug: 'examplecoin-fictional' });
  assert.deepEqual(pick(intake.parseLink('https://coinmarketcap.com/dexscan/base/0x2222222222222222222222222222222222222222/')), { source: 'coinmarketcap_dexscan', chain: 'base', platform: 'base', address: '0x2222222222222222222222222222222222222222' });
  assert.equal(intake.parseLink('https://coinmarketcap.com/dexscan/foochain/0x2222222222222222222222222222222222222222/').platform, null);
  assert.deepEqual(pick(intake.parseLink('https://www.coingecko.com/en/coins/examplecoin-fictional')), { source: 'coingecko', coingecko_id: 'examplecoin-fictional' });
  assert.equal(intake.parseLink('Examplecoin').source, 'text');
  assert.equal(intake.parseLink('https://scam.example/currencies/examplecoin').source, 'invalid');
  assert.equal(intake.parseLink('https://coinmarketcap.com/').source, 'invalid');
  assert.equal(intake.parseLink('<script>alert(1)</script>').source, 'invalid');
  assert.equal(intake.parseLink(''), null);
});

test('intake: a request is saved first; a repeat within minutes is the same request; nothing touches the portfolio', (t) => {
  const { ws, cleanup } = tempWorkspace('intake-save');
  t.after(cleanup);
  // The forms ask for a name or a CoinGecko link; a pasted CoinMarketCap link
  // still works (above), but no message asks for one.
  assert.throws(() => intake.createIntake(ws, {}), /Type a project name, paste a CoinGecko link, or add a screenshot\./);
  for (const bad of ['https://scam.example/x', 'x'.repeat(81)]) assert.doesNotMatch(intake.parseLink(bad).error, /CoinMarketCap/);
  assert.throws(() => intake.createIntake(ws, { link: 'https://scam.example/x' }), /not used to identify/);
  assert.throws(() => intake.createIntake(ws, { screenshot: { media_type: 'image/svg+xml', data_base64: 'PHN2Zz4=' } }), /PNG, JPEG/);
  assert.throws(() => intake.createIntake(ws, { screenshot: { media_type: 'image/png', data_base64: Buffer.alloc(intake.MAX_IMAGE_BYTES + 1).toString('base64') } }), /larger than/);
  const a = intake.createIntake(ws, { link: LINK, instructions: '  Who actually uses it?  ' });
  assert.equal(a.status, 'created');
  assert.equal(a.verified, true);
  assert.equal(a.intake.status, 'identifying');
  assert.equal(a.intake.input.instructions, 'Who actually uses it?');
  assert.ok(fs.existsSync(ws.abs(`inbox/intake/${a.intake.intake_id}.json`)));
  const again = intake.createIntake(ws, { link: LINK, instructions: 'Who actually uses it?' });
  assert.equal(again.status, 'exists');
  assert.equal(again.intake.intake_id, a.intake.intake_id);
  assert.equal(intake.createIntake(ws, { link: LINK, instructions: 'A different question' }).status, 'created');
  const s = intake.createIntake(ws, { screenshot: shot() });
  assert.deepEqual(fs.readFileSync(ws.abs(s.intake.input.screenshot.file)), PNG);
  assert.equal(s.intake.input.screenshot.sha256.length, 64);
  assert.equal(readJson(ws.abs('portfolio/transactions.json')).transactions.length, 0);
  assert.deepEqual(intake.pendingIdentify(ws).sort(), intake.listIntakes(ws).map((d) => d.intake_id).sort());
});

test('intake: a CoinMarketCap link becomes candidates; a lookalike is never chosen silently; confirming researches only the chosen coin, with the instructions', async (t) => {
  const { root, cleanup } = tempWorkspace('intake-flow');
  t.after(cleanup);
  const ws = configure(root, { providers: { claude: { mock: 'fixture', model: 'fictional-fixture' } }, default_providers: ['claude'] });
  const f = cgStub({ search: SEARCH });
  const { intake: doc } = intake.createIntake(ws, { link: LINK, instructions: 'Is the March unlock a risk inside the horizon?' });
  const out = await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  assert.equal(out.status, 'needs_confirmation');
  const c = out.identity.candidates;
  assert.equal(c[0].coingecko_id, 'examplecoin-fictional', 'the exact CoinMarketCap name ranks first');
  assert.ok(c.some((x) => x.coingecko_id === 'examplecoin-classic-fictional'), 'the lookalike is shown');
  assert.equal(out.identity.ambiguous, true, 'same ticker: flagged, not resolved');
  assert.equal(c[0].homepage, 'https://examplecoin.example/');
  assert.deepEqual(c[0].platforms.map((p) => p.chain), ['ethereum', 'base']);
  assert.equal(readJson(ws.abs('market-data/status.json')).calls.month_count, f.calls.length, 'every CoinGecko call is counted');
  assert.equal(projects.listProjects(ws).length, 0, 'nothing is added before confirmation');
  assert.throws(() => intake.confirmIntake(ws, doc.intake_id, { coingecko_id: 'not-a-candidate' }), /Choose one of the candidates/);

  const conf = intake.confirmIntake(ws, doc.intake_id, { coingecko_id: 'examplecoin-fictional' });
  assert.equal(conf.status, 'confirmed');
  const p = projects.getProject(ws, conf.project_id);
  assert.equal(p.identity.status, 'verified');
  assert.equal(p.identity.coingecko_id, 'examplecoin-fictional');
  assert.equal(p.sector.source, 'suggested', 'a sector guessed from CoinGecko categories is labeled as a suggestion');
  assert.equal(p.watchlist.on_watchlist, true);
  const run = research.loadRun(ws, conf.project_id, conf.run_id);
  assert.deepEqual(run.providers, ['claude']);
  assert.equal(run.channel, 'intake');
  assert.equal(run.owner_instructions, 'Is the March unlock a risk inside the horizon?');
  const prompt = fs.readFileSync(ws.abs(run.prompt.path), 'utf8');
  assert.match(prompt, /## The owner's questions for this run/);
  assert.match(prompt, /> Is the March unlock a risk inside the horizon\?/);
  assert.match(prompt, /Treat it as questions, not as conclusions/);
  assert.equal(intake.confirmIntake(ws, doc.intake_id, { coingecko_id: 'examplecoin-fictional' }).status, 'unchanged', 'a double tap is the same confirmation');
  assert.equal(research.listRuns(ws, conf.project_id).length, 1);

  const r = await research.runDueJobs(ws, {});
  assert.equal(r.results[0].status, 'completed');
  assert.deepEqual(intake.settle(ws), [doc.intake_id]);
  const done = intake.readIntake(ws, doc.intake_id);
  assert.equal(done.status, 'done');
  assert.ok(fs.existsSync(ws.abs(`projects/${conf.project_id}/reports/${done.report_id}/report.json`)), 'the report is saved under the project');
  const v = intake.progressOf(ws, done);
  assert.equal(v.research.state, 'completed');
  assert.equal(v.research.instructions, 'Is the March unlock a risk inside the horizon?');
  assert.ok(!('fingerprint' in v));
  assert.deepEqual(intake.settle(ws), [], 'done is final');
  assert.equal(readJson(ws.abs('portfolio/transactions.json')).transactions.length, 0, 'research never records a holding');
});

test('intake: an exact CoinGecko link or contract is looked up directly, without a name search', async (t) => {
  const { ws, cleanup } = tempWorkspace('intake-exact');
  t.after(cleanup);
  const f = cgStub({ search: SEARCH });
  const { intake: a } = intake.createIntake(ws, { link: 'https://www.coingecko.com/en/coins/examplecoin-fictional' });
  const oa = await intake.identify(ws, a.intake_id, { fetchImpl: f });
  assert.deepEqual(oa.identity.candidates.map((c) => c.coingecko_id), ['examplecoin-fictional']);
  assert.equal(oa.identity.ambiguous, false);
  assert.equal(f.calls.length, 1);
  assert.ok(!f.calls.some((u) => u.includes('/search')));
  const { intake: b } = intake.createIntake(ws, { link: 'https://coinmarketcap.com/dexscan/base/0x2222222222222222222222222222222222222222/' });
  const ob = await intake.identify(ws, b.intake_id, { fetchImpl: f });
  assert.equal(ob.identity.candidates[0].coingecko_id, 'examplecoin-fictional');
  assert.match(ob.identity.candidates[0].reasons.join(' '), /exact contract on base/);
  const { intake: n } = intake.createIntake(ws, { link: 'https://www.coingecko.com/en/coins/no-such-coin-fictional' });
  const on = await intake.identify(ws, n.intake_id, { fetchImpl: f });
  assert.equal(on.status, 'identity_failed');
  assert.match(on.identity.error, /lists no coin/);
});

test('intake: CoinGecko rate limits are waited out once; a lookup failure is shown and can be retried', async (t) => {
  const { ws, cleanup } = tempWorkspace('intake-429');
  t.after(cleanup);
  let limited = 0;
  const busy = { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '0.01' : null) }, json: async () => ({}) };
  const f = cgStub({ search: SEARCH, fail: (p) => (p === '/search' && limited++ < 1 ? busy : null) });
  const { intake: doc } = intake.createIntake(ws, { link: LINK });
  const out = await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  assert.equal(out.status, 'needs_confirmation', 'one 429 is waited out');
  const down = cgStub({ fail: () => ({ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }) });
  const { intake: d2 } = intake.createIntake(ws, { link: 'https://coinmarketcap.com/currencies/other-xmpl-fictional/' });
  const o2 = await intake.identify(ws, d2.intake_id, { fetchImpl: down });
  assert.equal(o2.status, 'identity_failed');
  assert.match(o2.identity.error, /HTTP 503/);
  intake.retryIdentify(ws, d2.intake_id);
  const o3 = await intake.identify(ws, d2.intake_id, { fetchImpl: cgStub({ search: SEARCH }) });
  assert.equal(o3.status, 'needs_confirmation');
});

test('intake: a 429 without Retry-After fails at once with the time to try again, and every CoinGecko caller then waits', async (t) => {
  const { ws, cleanup } = tempWorkspace('intake-429-long', { market_data: { enabled: true } });
  t.after(cleanup);
  const busy = { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
  const f = cgStub({ search: SEARCH, fail: (p) => (p === '/search' ? busy : null) });
  const { intake: doc } = intake.createIntake(ws, { link: LINK });
  const started = Date.now();
  const out = await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  assert.ok(Date.now() - started < 5000, 'no long sleep inside the lookup');
  assert.equal(f.calls.length, 1, 'asked once, not again');
  assert.equal(out.status, 'identity_failed');
  assert.match(out.identity.error, /^CoinGecko is rate-limiting this server\. Try again after (\w{3} \d{1,2}, )?\d{1,2}:\d{2} [AP]M\.$/);
  const gate = market.rateLimitGate(ws);
  assert.equal(gate.open, false);
  assert.ok(gate.wait_ms > 110000 && gate.wait_ms <= 120000, `the default wait, got ${gate.wait_ms} ms`);
  assert.equal(market.readStatus(ws).rate_limit.source, 'research intake');
  assert.equal(market.readStatus(ws).calls.month_count, 1, 'the call is counted');

  // Prices (even a manual refresh), market context and the next lookup wait without calling.
  const never = async (url) => { throw new Error(`must not be called: ${url}`); };
  const p = await market.refresh(ws, { fetchImpl: never, force: true });
  assert.equal(p.status, 'backoff');
  assert.equal(p.rate_limited, true);
  assert.equal((await require('../core/cycle').refreshContext(ws, { fetchImpl: never, force: true })).status, 'backoff');
  assert.equal(require('../core/jobs').marketDue(ws, Date.now(), { foreground: true }), false);
  intake.retryIdentify(ws, doc.intake_id);
  const again = await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  assert.equal(again.status, 'identity_failed');
  assert.equal(f.calls.length, 1, 'the lookup waits for the shared gate too');
});

test('intake: a short shared wait is sat out once; a provider that keeps answering 429 is asked at most twice', async (t) => {
  const { ws, cleanup } = tempWorkspace('intake-429-short');
  t.after(cleanup);
  // Prices saw a 429 with a short Retry-After a moment ago.
  market.noteRateLimit(ws, { retryAfterMs: 50, source: 'prices' });
  const f = cgStub({ search: SEARCH });
  const { intake: doc } = intake.createIntake(ws, { link: LINK });
  const out = await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  assert.equal(out.status, 'needs_confirmation', 'waited out, then looked up');

  const zero = { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '0' : null) }, json: async () => ({}) };
  const g = cgStub({ fail: () => zero });
  await assert.rejects(intake.cgGet(ws, '/search?query=x', g), /rate-limiting this server/);
  assert.equal(g.calls.length, 2, 'never more than one retry, even with Retry-After: 0');
});

test('intake: a project with the same ticker is never merged silently; a different binding is never replaced', async (t) => {
  const { root, cleanup } = tempWorkspace('intake-dup');
  t.after(cleanup);
  let ws = openWorkspace({ root, actor: 'test' });
  addFixtureProject(ws); // XMPL
  ws = configure(root, { providers: { claude: { mock: 'fixture', model: 'fictional-fixture' } } });
  const f = cgStub({ search: SEARCH });
  const { intake: doc } = intake.createIntake(ws, { link: 'https://coinmarketcap.com/currencies/other-xmpl-fictional/' });
  await intake.identify(ws, doc.intake_id, { fetchImpl: f });
  assert.throws(() => intake.confirmIntake(ws, doc.intake_id, { coingecko_id: 'other-xmpl-fictional' }), (err) => err.code === 'AMBIGUOUS' && /ticker XMPL/.test(err.message));
  assert.equal(intake.readIntake(ws, doc.intake_id).status, 'needs_confirmation', 'nothing happened');
  const ok = intake.confirmIntake(ws, doc.intake_id, { coingecko_id: 'other-xmpl-fictional', different_project: true, sector: 'infrastructure' });
  assert.equal(ok.project_status, 'created');
  assert.equal(projects.getProject(ws, ok.project_id).sector.source, 'owner', 'a sector chosen on the card is the owner\'s');

  // Same name, already bound to another coin: refused, nothing researched.
  projects.addProject(ws, { name: 'Examplecoin (FICTIONAL)', symbol: 'XMC', official_website: 'https://classic.example/', coingecko_id: 'examplecoin-classic-fictional', evidence: [{ url: 'https://classic.example/', note: 'fictional' }] });
  const { intake: d2 } = intake.createIntake(ws, { link: LINK });
  await intake.identify(ws, d2.intake_id, { fetchImpl: f });
  const runsBefore = projects.listProjects(ws).map((p) => research.listRuns(ws, p.project_id).length).reduce((a, b) => a + b, 0);
  assert.throws(() => intake.confirmIntake(ws, d2.intake_id, { coingecko_id: 'examplecoin-fictional' }), (err) => err.code === 'CONFLICT' && /same name.*bound to the CoinGecko coin "examplecoin-classic-fictional"/.test(err.message));
  const runsAfter = projects.listProjects(ws).map((p) => research.listRuns(ws, p.project_id).length).reduce((a, b) => a + b, 0);
  assert.equal(runsAfter, runsBefore);
});

test('intake: a screenshot is read once by Claude inside the limits and counted in the spend log; an interrupted read is held, never repeated by itself', async (t) => {
  withKey(t);
  const { root, cleanup } = tempWorkspace('intake-shot');
  t.after(cleanup);
  const ws = configure(root, { providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 4, output_usd_per_mtok: 20 } }, budget: { per_run_usd: 2.5, daily_usd: 8, monthly_usd: 30 } });
  const f = cgStub({ search: SEARCH });
  const good = reader();
  assert.equal(intake.readReservation(ws), 0.092, '3,000 input and 4,000 output tokens at $4 / $20 per million');

  const { intake: doc } = intake.createIntake(ws, { screenshot: shot() });
  const out = await intake.identify(ws, doc.intake_id, { fetchImpl: f, identifyImpl: good });
  assert.equal(good.calls.length, 1);
  assert.equal(good.calls[0].mediaType, 'image/png');
  assert.equal(good.calls[0].imageBase64, PNG.toString('base64'));
  assert.equal(out.status, 'needs_confirmation');
  assert.equal(out.identity.candidates[0].coingecko_id, 'examplecoin-fictional');
  assert.equal(out.identity.screenshot_read.phase, 'read');
  assert.equal(out.identity.screenshot_read.cost_actual_usd, 0.0128, '1,700 x $4 + 300 x $20 per million');
  const lines = () => readJsonLines(ws.abs('logs/research-spend.jsonl')).filter((l) => String(l.run_id).startsWith('intake_'));
  assert.deepEqual(lines().map((l) => [l.kind, l.attempt]), [['reservation', 1], ['actual', 1]]);
  assert.equal(research.spendSoFar(ws).daily, 0.0128, 'counted in the same daily total as research');
  intake.retryIdentify(ws, doc.intake_id);
  await intake.identify(ws, doc.intake_id, { fetchImpl: f, identifyImpl: good });
  assert.equal(good.calls.length, 1, 'a finished read is reused, never bought twice');

  // A read that times out may have been billed: held at its reservation.
  let slow = 0;
  const timeout = async () => {
    slow++;
    throw new providers.ProviderError('timeout', 'The provider did not answer before the time limit. A request that was sent may still be billed.');
  };
  const { intake: d2 } = intake.createIntake(ws, { screenshot: shot(1) });
  const o2 = await intake.identify(ws, d2.intake_id, { fetchImpl: f, identifyImpl: timeout });
  assert.equal(slow, 1);
  assert.equal(o2.status, 'identity_failed');
  assert.equal(o2.identity.screenshot_read.phase, 'uncertain');
  assert.equal(research.spendSoFar(ws).daily, 0.0128 + 0.092, 'the uncertain read counts at its reservation');
  intake.retryIdentify(ws, d2.intake_id);
  const o3 = await intake.identify(ws, d2.intake_id, { fetchImpl: f, identifyImpl: good });
  assert.equal(good.calls.length, 2, 'read again only because Eric asked');
  assert.equal(o3.identity.screenshot_attempts, 2);
  assert.equal(research.spendSoFar(ws).daily, Math.round((0.0128 + 0.092 + 0.0128) * 10000) / 10000, 'the first attempt stays counted; the second is its own');

  // The server stopped while a read was marked as sent: held, not resent.
  const { intake: d4 } = intake.createIntake(ws, { screenshot: shot(2) });
  runOp(ws, { type: 'test_interrupt', summary: 'simulate a stop mid-read' }, (op) => {
    const rel = `inbox/intake/${d4.intake_id}.json`;
    const d = op.readJson(rel);
    d.identity = { screenshot_attempts: 1, screenshot_read: { phase: 'dispatched', n: 1, at: new Date().toISOString(), reserved_usd: 0.092 } };
    op.writeJson(rel, d);
  });
  const o4 = await intake.identify(ws, d4.intake_id, { fetchImpl: f, identifyImpl: good });
  assert.equal(good.calls.length, 2, 'not sent again');
  assert.equal(o4.identity.screenshot_read.phase, 'uncertain');
  assert.equal(o4.status, 'identity_failed');

  // Over the daily limit: refused before anything is sent.
  const tight = configure(root, { budget: { per_run_usd: 2.5, daily_usd: 0.2, monthly_usd: 30 } });
  const { intake: d5 } = intake.createIntake(tight, { screenshot: shot(3) });
  const o5 = await intake.identify(tight, d5.intake_id, { fetchImpl: f, identifyImpl: good });
  assert.equal(good.calls.length, 2, 'refused, not sent');
  assert.equal(o5.identity.screenshot_read.phase, 'refused');
  assert.match(o5.identity.notes.join(' '), /daily limit/);
});

test('intake: without the Claude key a screenshot is not read, and the request says why', async (t) => {
  withKey(t, null);
  if (providers.keyStatus('claude').present) return t.skip('a Claude key is configured on this machine (secrets.json); not changing it');
  const { root, cleanup } = tempWorkspace('intake-nokey');
  t.after(cleanup);
  const ws = configure(root, { providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 4, output_usd_per_mtok: 20 } }, budget: { per_run_usd: 2.5, daily_usd: 8, monthly_usd: 30 } });
  const good = reader();
  const { intake: doc } = intake.createIntake(ws, { screenshot: shot() });
  const out = await intake.identify(ws, doc.intake_id, { fetchImpl: cgStub(), identifyImpl: good });
  assert.equal(good.calls.length, 0);
  assert.equal(out.status, 'identity_failed');
  assert.match(out.identity.error, /needs the Claude API key/);
  // A link alongside the screenshot is still identified.
  const { intake: d2 } = intake.createIntake(ws, { link: LINK, screenshot: shot(1) });
  const o2 = await intake.identify(ws, d2.intake_id, { fetchImpl: cgStub({ search: SEARCH }), identifyImpl: good });
  assert.equal(o2.status, 'needs_confirmation');
  assert.match(o2.identity.notes.join(' '), /needs the Claude API key/);
});

// --- research through the Claude adapter (stubbed HTTP), as on the live desk

function claudeStub(ws, behaviors) {
  const calls = [];
  const f = async (url, opts) => {
    if (!url.startsWith('https://api.anthropic.com/')) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(opts.body);
    calls.push(body);
    const b = behaviors[calls.length - 1] || 'ok';
    if (b === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const prompt = body.messages[0].content;
    let run = null;
    for (const p of projects.listProjects(ws)) run = run || research.listRuns(ws, p.project_id).find((r) => prompt.includes(r.run_id));
    const text = mockReport(ws, 'claude', run).replace('FICTIONAL demo fixture standing in for Claude', 'Claude (Anthropic)');
    return { ok: true, status: 200, headers: { get: (k) => (k === 'request-id' ? 'req_stub' : null) }, text: async () => JSON.stringify({ id: 'msg_stub', model: 'claude-test-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 5000, output_tokens: 8000 } }) };
  };
  f.calls = calls;
  return f;
}

test('intake: a research call that times out is held as uncertain and never resent by itself; Retry sends exactly one new attempt and the request finishes', async (t) => {
  withKey(t);
  const { root, cleanup } = tempWorkspace('intake-retry');
  t.after(cleanup);
  // A $1.00 reservation per attempt: 10,000 output tokens at $100 per million.
  const ws = configure(root, { providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 0, output_usd_per_mtok: 100, search_usd_per_call: 0.01, max_searches: 0 } }, budget: { per_run_usd: 5, daily_usd: 5, monthly_usd: 5 }, max_output_tokens: 10000 });
  assert.equal(research.providerStatus(ws).claude.mode, 'api');
  const { doc, conf } = await confirmedRun(ws, cgStub({ search: SEARCH }), { instructions: 'Check the team.' });
  const api = claudeStub(ws, ['timeout', 'ok']);
  const r1 = await research.runDueJobs(ws, { fetchImpl: api });
  assert.equal(r1.results[0].status, 'uncertain');
  intake.settle(ws);
  let v = intake.progressOf(ws, intake.readIntake(ws, doc.intake_id));
  assert.equal(v.status, 'researching');
  assert.equal(v.research.state, 'uncertain');
  assert.equal(v.research.cost.counted_usd, 1, 'held at its reservation');
  assert.equal(v.research.cost.all_recorded, false);
  await research.runDueJobs(ws, { fetchImpl: api });
  assert.equal(api.calls.length, 1, 'an uncertain attempt is never resent by itself');
  const again = intake.retryResearch(ws, doc.intake_id);
  assert.match(again.message, /may already have been billed/);
  const r2 = await research.runDueJobs(ws, { fetchImpl: api });
  assert.equal(r2.results[0].status, 'completed');
  assert.equal(api.calls.length, 2, 'exactly one new attempt');
  intake.settle(ws);
  v = intake.progressOf(ws, intake.readIntake(ws, doc.intake_id));
  assert.equal(v.status, 'done');
  assert.equal(v.research.attempts, 2);
  assert.equal(v.research.cost.counted_usd, 1.8, 'the uncertain $1.00 reservation plus the $0.80 recorded cost');
  assert.equal(research.spendSoFar(ws, new Date(), { runId: conf.run_id }).run, 1.8);
  assert.equal(api.calls[0].messages[0].content.includes('Check the team.'), true, 'the instructions reach Claude');
});

test('intake: a run refused by the budget is shown as failed and can be retried once the limit allows', async (t) => {
  withKey(t);
  const { root, cleanup } = tempWorkspace('intake-budget');
  t.after(cleanup);
  let ws = configure(root, { providers: { claude: { model: 'claude-test-model', input_usd_per_mtok: 0, output_usd_per_mtok: 100, search_usd_per_call: 0.01, max_searches: 0 } }, budget: { per_run_usd: 0.5, daily_usd: 5, monthly_usd: 5 }, max_output_tokens: 10000 });
  const { doc } = await confirmedRun(ws, cgStub({ search: SEARCH }));
  const api = claudeStub(ws, ['ok']);
  const r = await research.runDueJobs(ws, { fetchImpl: api });
  assert.equal(r.results[0].status, 'budget_refused');
  assert.equal(api.calls.length, 0, 'nothing was sent');
  intake.settle(ws);
  const failed = intake.progressOf(ws, intake.readIntake(ws, doc.intake_id));
  assert.equal(failed.status, 'failed');
  assert.match(failed.research.error, /per-run limit/);
  ws = configure(root, { budget: { per_run_usd: 2.5, daily_usd: 5, monthly_usd: 5 } });
  intake.retryResearch(ws, doc.intake_id);
  assert.equal(intake.readIntake(ws, doc.intake_id).status, 'researching', 'queued again');
  await research.runDueJobs(ws, { fetchImpl: api });
  intake.settle(ws);
  assert.equal(intake.readIntake(ws, doc.intake_id).status, 'done');
  assert.equal(api.calls.length, 1);
});

test('intake: dismissing works only before research starts', async (t) => {
  const { root, cleanup } = tempWorkspace('intake-dismiss');
  t.after(cleanup);
  const ws = configure(root, { providers: { claude: { mock: 'fixture', model: 'fictional-fixture' } } });
  const f = cgStub({ search: SEARCH });
  const { intake: a } = intake.createIntake(ws, { link: LINK });
  await intake.identify(ws, a.intake_id, { fetchImpl: f });
  assert.equal(intake.dismissIntake(ws, a.intake_id).status, 'canceled');
  assert.throws(() => intake.confirmIntake(ws, a.intake_id, { coingecko_id: 'examplecoin-fictional' }), /canceled/);
  const { doc } = await confirmedRun(ws, f, { instructions: 'x' });
  assert.throws(() => intake.dismissIntake(ws, doc.intake_id), /already started/);
});

test('intake: a confirmed request is researched by Claude, plus ChatGPT and Gemini where their API is set up, or all three when asked', (t) => {
  const { tempWorkspace } = require('./helpers');
  const { ws, cleanup } = tempWorkspace('intake-models', { research: { providers: { chatgpt: { mock: 'ok' } } } });
  t.after(cleanup);
  const intakeMod = require('../core/intake');
  assert.deepEqual(intakeMod.intakeModels(ws, { input: { instructions: null } }), ['claude', 'chatgpt'], 'ChatGPT runs by itself here; Gemini has no API');
  assert.deepEqual(intakeMod.intakeModels(ws, { input: { instructions: 'Research it with all three models, focus on unlocks' } }), ['claude', 'chatgpt', 'gemini']);
});
