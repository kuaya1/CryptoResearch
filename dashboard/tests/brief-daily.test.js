'use strict';
// The daily brief (core/brief-daily.js, cr-daily-brief@1, item 15, W3.1):
// deterministic, every line linked, a section it cannot read says so, and a
// read writes nothing. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');
const T = require('../core/tickets');
const B = require('../core/brief-daily');
const { sha256, readJson, atomicWrite, jsonText } = require('../core/fsx');

function setup(t) {
  const w = tempWorkspace('brief-daily');
  t.after(w.cleanup);
  const pid = addFixtureProject(w.ws).project_id;
  importAllFixtures(w.ws);
  return { ...w, pid };
}

function stubHeld(t, pid, held) {
  const portfolio = require('../core/portfolio');
  const real = portfolio.computePortfolio;
  portfolio.computePortfolio = (...a) => { const pf = real(...a); return { ...pf, positions: held ? [{ project_id: pid, closed: false, quantity: '10', value_usd: null, price: { status: 'missing' } }] : [] }; };
  t.after(() => { portfolio.computePortfolio = real; });
}

function answer(ticket) {
  const at = new Date().toISOString();
  const b = {
    format: T.FORMAT, ticket_id: ticket.ticket_id, project_id: ticket.project_id, prompt_version: T.PROMPT_VERSION, role: 'prosecutor', model: 'claude', model_version: 'claude-test', as_of: at,
    researcher_report_id: ticket.basis.researcher.report_id, researcher_report_sha256: ticket.basis.researcher.original.sha256,
    prosecution: { verdict: 'thesis_damaged', conviction_score: 38, tests: { mercenary_emissions: { result: 'fail', finding: 'x (FICTIONAL).', source_ids: ['S1'] }, tax_revenue: { result: 'pass', finding: '' }, exit_slippage: { result: 'unknown', finding: 'No reading.' }, unverified_claims: { result: 'fail', finding: 'y' } }, fatal_flaws: [{ test: 'mercenary_emissions', severity: 'fatal', finding: 'z (FICTIONAL).', source_ids: ['S1'] }], strongest_bull_rebuttal: 'Emissions taper.' },
    proposal: { proposal_type: 'ACCUMULATE', non_consensus_thesis: 'The market assumes organic demand; the evidence shows paid activity; the emission cut in Q1 makes the difference observable.', entry_zone: { low_usd: 0.8, high_usd: 0.9, basis: 'prior range' }, upside_target: { price_usd: 1.4, basis: 'fees double' }, invalidation_trigger: { price_usd: 0.7, statement: 'Below $0.70.' } },
    agent_disagreement_note: 'I score 38.',
    sources: [{ source_id: 'S1', url: 'https://example.com/xmpl/emissions', publisher: 'Example (FICTIONAL)', retrieved_at: at, excerpt: 'fictional' }],
  };
  return `# Prosecution (FICTIONAL)\n\n${'The four tests and the flaws, written out for the test fixture. '.repeat(12)}\n\n\`\`\`json\n${JSON.stringify(b, null, 2)}\n\`\`\`\n`;
}

function savedTicket(t, s) {
  stubHeld(t, s.pid, true);
  const tk = T.createTicket(s.ws, { project_id: s.pid, assistant: true }).ticket;
  const rel = `projects/${s.pid}/tickets/${tk.ticket_id}/ticket.json`;
  const job = readJson(s.ws.abs(rel));
  job.basis.exits = [{ size_usd: 500, status: 'current', cost_pct: 1.5, cost_complete: true, missing_costs: [] }, { size_usd: 2000, status: 'current', cost_pct: 3, cost_complete: true }];
  atomicWrite(s.ws.abs(rel), jsonText(job));
  return T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: answer(T.loadTicket(s.ws, s.pid, tk.ticket_id)) });
}

function dropPrice(ws, atMs, price) {
  const dir = ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(atMs).toISOString();
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: 'example-payfi-fictional', price_usd: price, source_last_updated_at: at, fetched_at: at }] })}\n`);
}

const byId = (out, id) => out.sections.find((x) => x.id === id);

test('daily brief: a PM card waiting is listed with its age and link; held, models differ and research waiting are named', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const now = Date.parse(saved.receipt.saved_at) + 5 * 3600000;
  const out = B.brief(s.ws, { now });
  assert.equal(out.format, 'cr-daily-brief@1');
  const cards = byId(out, 'pm_cards');
  assert.equal(cards.state, 'ok');
  assert.match(cards.lines[0].text, /Example PayFi \(FICTIONAL\): ACCUMULATE, waiting 5 h\./);
  assert.equal(cards.lines[0].link, `#/?p=${s.pid}`);
  const held = byId(out, 'held');
  assert.equal(held.state, 'ok');
  assert.match(held.lines[0].text, /Example PayFi \(FICTIONAL\): .*(value unknown|\$)/);
  assert.match(held.lines[0].text, /24h change unknown|24h [+-]/);
  assert.equal(held.lines[0].link, '#/portfolio');
  const differ = byId(out, 'models_differ');
  assert.equal(differ.state, 'ok');
  assert.ok(differ.lines.every((l) => /^#\/project\/.+\/compare$/.test(l.link) || l.link === null));
  assert.equal(out.sections.map((x) => x.id).join(), 'pm_cards,invalidated,stale_basis,pilot_exits,held,research_waiting,models_differ,spread,freshness');
});

test('daily brief: a ticket invalidated since a time is listed with the reading that fired; one before it is not; no since lists every one', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const t0 = Date.parse(saved.receipt.saved_at);
  dropPrice(s.ws, t0 + 3600000, 0.69);
  const now = t0 + 2 * 3600000;
  const all = byId(B.brief(s.ws, { now }), 'invalidated');
  assert.match(all.lines[0].text, /0\.69/);
  assert.equal(all.lines[0].link, `#/?p=${s.pid}`);
  const recent = byId(B.brief(s.ws, { now, since: new Date(t0).toISOString() }), 'invalidated');
  assert.match(recent.lines[0].text, /0\.69/);
  const later = byId(B.brief(s.ws, { now, since: new Date(t0 + 3 * 3600000).toISOString() }), 'invalidated');
  assert.equal(later.lines[0].text, 'None right now.');
  assert.throws(() => B.brief(s.ws, { now, since: 'yesterday-ish' }), (e) => e.code === 'INVALID');
});

test('daily brief: a stale basis and a pilot project without an exit reading are named', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const far = Date.parse(saved.receipt.saved_at) + 400 * 86400000;
  const stale = byId(B.brief(s.ws, { now: far }), 'stale_basis');
  assert.match(stale.lines[0].text, /days old/);
  T.setPilot(s.ws, s.pid, true, { by: 'test' });
  const out = B.brief(s.ws, { now: Date.parse(saved.receipt.saved_at) });
  const exits = byId(out, 'pilot_exits');
  assert.equal(exits.state, 'ok');
  for (const l of exits.lines) assert.match(l.link, /\/forensics\?tab=exits$/);
});

test('daily brief: a section it cannot read says so, never nothing; the others still read', (t) => {
  const s = setup(t);
  const offsite = require('../core/offsite');
  const real = offsite.backupStatus;
  offsite.backupStatus = () => { throw new Error('backup folder unreadable (FICTIONAL)'); };
  t.after(() => { offsite.backupStatus = real; });
  const out = B.brief(s.ws, { now: Date.now() });
  const f = byId(out, 'freshness');
  assert.equal(f.state, 'unreadable');
  assert.match(f.lines[0].text, /^Could not be read: backup folder unreadable/);
  assert.match(out.text, /Could not be read: backup folder unreadable/);
  assert.equal(byId(out, 'pm_cards').state, 'ok');
  assert.equal(byId(out, 'pm_cards').lines[0].text, 'None right now.');
  // Without the index, every section that needs it says so.
  const indexer = require('../core/indexer');
  const realIndex = indexer.buildIndex;
  indexer.buildIndex = () => { throw new Error('records unreadable (FICTIONAL)'); };
  t.after(() => { indexer.buildIndex = realIndex; });
  const down = B.brief(s.ws, { now: Date.now() });
  for (const id of ['pm_cards', 'invalidated', 'stale_basis', 'held', 'research_waiting', 'models_differ']) {
    assert.equal(byId(down, id).state, 'unreadable', id);
    assert.match(byId(down, id).lines[0].text, /index could not be built/);
  }
});

test('daily brief: the text is deterministic, its SHA-256 is of that text, and a read (CLI, route, connector) writes nothing', async (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const now = Date.parse(saved.receipt.saved_at) + 3600000;
  const a = B.brief(s.ws, { now });
  const b = B.brief(s.ws, { now });
  assert.equal(a.text, b.text);
  assert.equal(a.text_sha256, sha256(a.text));
  assert.equal(a.text_sha256, b.text_sha256);
  for (const sec of a.sections) for (const l of sec.lines) assert.ok(l.link || sec.state === 'unreadable' || l.text === 'None right now.', `${sec.id}: ${l.text} has a link`);
  // The connector tool: read-only, for every model.
  const { makeMcp, TOOLS } = require('../mcp');
  assert.equal(TOOLS.find((x) => x.name === 'daily_brief').annotations.readOnlyHint, true);
  const handle = makeMcp(s.ws);
  for (const who of ['claude', 'chatgpt', 'gemini']) {
    let body = '';
    const req = require('stream').Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'daily_brief', arguments: {} } }))]);
    req.method = 'POST';
    await handle(req, { writeHead() {}, end(x) { body = x || ''; } }, { assistant: who });
    const r = JSON.parse(body).result;
    assert.equal(r.isError, false, who);
    assert.equal(r.structuredContent.format, 'cr-daily-brief@1');
    assert.equal(r.structuredContent.text_sha256, sha256(r.structuredContent.text));
  }
  // The route.
  const { start } = require('../server');
  const srv = await start(s.ws, { port: 47900 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: p, headers: { host: `127.0.0.1:${srv.port}`, ...headers } }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch (_) { return null; } })() }));
    }).on('error', reject);
  });
  const token = (await get('/api/session')).json.token;
  const tree = hashTree(s.root);
  const r = await get('/api/brief/daily', { 'x-cr-token': token });
  assert.equal(r.status, 200);
  assert.equal(r.json.format, 'cr-daily-brief@1');
  assert.equal((await get('/api/brief/daily?since=nope', { 'x-cr-token': token })).status, 400);
  assert.deepEqual(hashTree(s.root), tree, 'no file changed');
});

test('daily brief: the CLI prints the text and its hash, or the JSON', async (t) => {
  const s = setup(t);
  const tree = hashTree(s.root);
  const cliOut = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'brief', 'daily', '--json', '--workspace', s.root], { encoding: 'utf8' });
  assert.equal(cliOut.status, 0, cliOut.stderr);
  const json = JSON.parse(cliOut.stdout);
  assert.equal(json.format, 'cr-daily-brief@1');
  const text = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'brief', 'daily', '--workspace', s.root], { encoding: 'utf8' });
  assert.match(text.stdout, /SHA-256 of this text: [0-9a-f]{64}/);
  assert.match(text.stdout, /PM cards waiting for you/);
  assert.deepEqual(hashTree(s.root), tree, 'the CLI wrote nothing');
});
