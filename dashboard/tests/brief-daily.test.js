'use strict';
// The daily brief (core/brief-daily.js, cr-daily-brief@1, item 15, W3.1):
// deterministic, every line linked, a section it cannot read says so, and a
// read writes nothing. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree, withExitReadings, freshPrice } = require('./helpers');
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

function savedTicket(t, s, edit = (x) => x) {
  stubHeld(t, s.pid, true);
  const tk = withExitReadings(1.5, () => T.createTicket(s.ws, { project_id: s.pid, assistant: true })).ticket;
  freshPrice(s.ws, 'example-payfi-fictional', 0.85);
  return T.saveTicket(s.ws, { project_id: s.pid, ticket_id: tk.ticket_id, text: edit(answer(T.loadTicket(s.ws, s.pid, tk.ticket_id))) });
}

function dropPrice(ws, atMs, price) {
  const dir = ws.abs('market-data/observations');
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(atMs).toISOString();
  fs.appendFileSync(path.join(dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ fetched_at: at, provider: 'coingecko', assets: [{ id: 'example-payfi-fictional', price_usd: price, source_last_updated_at: at, fetched_at: at }] })}\n`);
}

const byId = (out, id) => out.sections.find((x) => x.id === id);

test('daily brief (item 50): a waiting Prosecutor ticket carries its compact trade plan and the two verdicts', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const out = B.brief(s.ws, { now: Date.parse(saved.receipt.saved_at) + 20 * 60000 });
  const line = byId(out, 'pm_cards').lines[0].text;
  assert.match(line, /Entry \$0\.8–\$0\.9, target \$1\.4, invalidation \$0\.7, R:R \d\.\dx at plan, 3\.7x now; Researcher .+ vs Prosecutor 38\./);
  // The same card hours later: the stored price is past the freshness limit, so the ratio is unknown, not stale arithmetic.
  const late = byId(B.brief(s.ws, { now: Date.parse(saved.receipt.saved_at) + 5 * 3600000 }), 'pm_cards').lines[0].text;
  assert.match(late, /R:R \d\.\dx at plan, unknown now;/);
});

test('daily brief (item 50): each plan number the receipt lacks reads unknown', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s, (txt) => txt.replace(/"upside_target": \{[^}]*\}/, '"upside_target": null'));
  const out = B.brief(s.ws, { now: Date.parse(saved.receipt.saved_at) + 3600000 });
  const line = byId(out, 'pm_cards').lines[0].text;
  assert.match(line, /target unknown, invalidation \$0\.7, R:R unknown at plan, unknown now; Researcher/);
  assert.doesNotMatch(line, /undefined|NaN|null/);
});

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
  assert.equal(out.sections.map((x) => x.id).join(), 'pm_cards,invalidated,near_invalidation,stale_basis,ticket_repairs,pilot_exits,held,research_waiting,models_differ,spread,freshness');
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
  for (const id of ['pm_cards', 'invalidated', 'near_invalidation', 'stale_basis', 'held', 'research_waiting', 'models_differ']) {
    assert.equal(byId(down, id).state, 'unreadable', id);
    assert.match(byId(down, id).lines[0].text, /index could not be built/);
  }
});

test('daily brief (review A07): a ticket that cannot be read is named in each ticket section, which is partial with no count, never "None right now"; a read writes nothing', async (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const rel = `projects/${s.pid}/tickets/receipts/${saved.receipt_id}.json`;
  const r = readJson(s.ws.abs(rel));
  r.researcher = null;
  atomicWrite(s.ws.abs(rel), jsonText(r));
  const sum = T.summary(s.ws, s.pid);
  assert.equal(sum.unavailable, true, 'the real summary cannot read it');
  const tree = hashTree(s.root);
  const out = B.brief(s.ws, { now: Date.parse(saved.receipt.saved_at) + 3600000 });
  assert.deepEqual(hashTree(s.root), tree, 'a read writes nothing');
  for (const id of ['pm_cards', 'invalidated', 'near_invalidation', 'stale_basis']) {
    const sec = byId(out, id);
    assert.equal(sec.state, 'partial', id);
    assert.equal(sec.count, null, `${id}: the count is unknown`);
    assert.equal(sec.unreadable_count, 1, id);
    assert.match(sec.lines[0].text, /^Example PayFi \(FICTIONAL\): the ticket could not be read \(.+\), so whether it .+ is unknown\.$/, id);
    assert.equal(sec.lines[0].link, `#/?p=${s.pid}`);
    assert.ok(!sec.lines.some((l) => l.text === 'None right now.'), id);
  }
  assert.match(out.text, /PM cards waiting for you \(0 read; 1 could not be read, so the count is unknown\)/);
  // The drawer says it in words, with no count that looks complete.
  const { briefView } = await import('../public/daily-brief-model.js');
  const v = briefView(out);
  const cards = v.sections.find((x) => x.id === 'pm_cards');
  assert.equal(cards.partial, true);
  assert.equal(cards.count, null);
  assert.equal(cards.count_words, '0 read, 1 could not be read');
  assert.equal(cards.empty, false);
  assert.equal(v.waiting, null);
  assert.equal(v.partial >= 3, true);
  // A healthy desk with no ticket still reads "None right now".
  const h = setup(t);
  const calm = byId(B.brief(h.ws, { now: Date.now() }), 'pm_cards');
  assert.equal(calm.state, 'ok');
  assert.equal(calm.count, 0);
  assert.equal(calm.lines[0].text, 'None right now.');
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
  for (const sec of a.sections) for (const l of sec.lines) assert.ok(l.link || sec.state === 'unreadable' || l.text === 'None right now.' || l.text.startsWith('No project is in the pilot'), `${sec.id}: ${l.text} has a link`);
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
  // Daily jobs marked done today, the startup inbox job awaited and the tree
  // left to settle, so the server's own background writes (jobs state, index
  // rebuild) land before the tree is hashed.
  const today = require('../core/dates').ymdInTz(new Date());
  atomicWrite(s.ws.abs('logs/jobs-state.json'), jsonText({ schema_version: 'cr.jobs-state.v1', jobs: { snapshot: { last_success_day: today }, reviews: { last_success_day: today }, backup: { last_success_day: today } }, runner: {} }));
  const srv = await start(s.ws, { port: 47900 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  for (let i = 0; i < 150; i++) {
    const st = readJson(s.ws.abs('logs/jobs-state.json'), { jobs: {} });
    if (st.jobs && st.jobs.inbox && st.jobs.inbox.last_run_at) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (let i = 0, prev = null; i < 40; i++) {
    const h = JSON.stringify(hashTree(s.root));
    if (h === prev) break;
    prev = h;
    await new Promise((r) => setTimeout(r, 500));
  }
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

test('daily brief (item 39): tickets waiting on a repair or a fresh price are listed with words and links; a healthy desk reads None right now; an unreadable ticket makes it partial; a read writes nothing', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const now = Date.parse(saved.receipt.saved_at) + 3600000;
  const healthy = byId(B.brief(s.ws, { now }), 'ticket_repairs');
  assert.equal(healthy.state, 'ok');
  assert.equal(healthy.lines[0].text, 'None right now.');
  const real = T.summary;
  const tree = hashTree(s.root);
  T.summary = (...a) => ({ ...real(...a), decision: { action: 'approve', paper: 'missing' } });
  const paper = byId(B.brief(s.ws, { now }), 'ticket_repairs');
  assert.match(paper.lines[0].text, /paper position is missing: complete it on the card \(Complete paper position\) or `tickets reconcile`\./);
  assert.equal(paper.lines[0].link, `#/?p=${s.pid}`);
  T.summary = (...a) => ({ ...real(...a), status: 'pending_pm_review', admission: { held_risk: { reason: 'The stored price is 3 days old.' } } });
  const held = byId(B.brief(s.ws, { now }), 'ticket_repairs');
  assert.match(held.lines[0].text, /held to \$0 by the admission check \(The stored price is 3 days old\): refresh prices, then ask for a new ticket \(refresh\)\./);
  assert.equal(held.lines[0].link, `#/?p=${s.pid}`);
  T.summary = () => ({ unavailable: true, error: 'unreadable (FICTIONAL)' });
  const bad = byId(B.brief(s.ws, { now }), 'ticket_repairs');
  T.summary = real;
  assert.equal(bad.state, 'partial');
  assert.equal(bad.count, null);
  assert.equal(bad.unreadable_count, 1);
  assert.deepEqual(hashTree(s.root), tree, 'a read writes nothing');
});

test('daily brief (item 53): a ticket whose fresh price is within 10% above its invalidation price is listed; a farther one is not', (t) => {
  const s = setup(t);
  const saved = savedTicket(t, s);
  const at = Date.parse(saved.receipt.saved_at) + 20 * 60000;
  // The saved price (0.85) is 21% above the 0.7 stop: nothing near.
  assert.match(byId(B.brief(s.ws, { now: Date.now() }), 'near_invalidation').lines[0].text, /None right now/);
  freshPrice(s.ws, 'example-payfi-fictional', 0.75);
  const sec = byId(B.brief(s.ws, { now: Date.now() }), 'near_invalidation');
  assert.equal(sec.state, 'ok');
  assert.equal(sec.count, 1);
  assert.match(sec.lines[0].text, /Near invalidation: a 6\.67% fall reaches the invalidation price \$0\.7 \(price \$0\.75/);
  assert.match(sec.lines[0].link, /^#\/\?p=/);
  assert.ok(at > 0);
});

test('daily brief (item 67): PM cards order trims, near-invalidation, then oldest; desk gates are one line; the count is the cards waiting', (t) => {
  const s = setup(t);
  const indexer = require('../core/indexer');
  const real = indexer.buildIndex;
  const row = (id, ticket) => ({ project_id: id, name: id, ticket: { status: 'pending_pm_review', proposal_type: 'ACCUMULATE', ...ticket } });
  const rows = [
    row('ord-late', { saved_at: '2026-10-02T00:00:00Z' }),
    row('gate-a', { desk_gate: true, proposal_type: 'HARD_PASS', saved_at: '2026-09-01T00:00:00Z' }),
    row('near', { near_invalidation: { words: 'x' }, saved_at: '2026-10-03T00:00:00Z' }),
    row('gate-b', { desk_gate: true, proposal_type: 'HARD_PASS', saved_at: '2026-09-02T00:00:00Z' }),
    row('ord-early', { saved_at: '2026-10-01T00:00:00Z' }),
    row('trim', { proposal_type: 'TRIM_EXIT', saved_at: '2026-10-04T00:00:00Z' }),
    row('gate-c', { desk_gate: true, proposal_type: 'HARD_PASS', saved_at: '2026-09-03T00:00:00Z' }),
  ];
  indexer.buildIndex = (...a) => ({ ...real(...a), projects: rows });
  t.after(() => { indexer.buildIndex = real; });
  const sec = byId(B.brief(s.ws, { now: Date.parse('2026-10-05T00:00:00Z') }), 'pm_cards');
  assert.equal(sec.state, 'ok');
  assert.deepEqual(sec.lines.slice(0, 4).map((l) => l.text.split(':')[0]), ['trim', 'near', 'ord-early', 'ord-late']);
  assert.equal(sec.lines[4].text, '3 desk gates waiting: gate-a, gate-b, gate-c.');
  assert.equal(sec.lines[4].link, '#/research?tab=runs');
  assert.equal(sec.lines.length, 5);
  assert.equal(sec.count, 7);
  assert.ok(!('n' in sec.lines[4]));
  // an unreadable ticket still makes the section partial
  rows.push({ project_id: 'bad', name: 'bad', ticket: { unavailable: true, error: 'x' } });
  const part = byId(B.brief(s.ws, { now: Date.parse('2026-10-05T00:00:00Z') }), 'pm_cards');
  assert.equal(part.state, 'partial');
  assert.equal(part.count, null);
});

test('daily brief (item 67): with no project in the pilot the exit section says nothing is expected, with a count of 0', (t) => {
  const s = setup(t);
  const none = byId(B.brief(s.ws, { now: Date.now() }), 'pilot_exits');
  assert.equal(none.state, 'ok');
  assert.equal(none.count, 0);
  assert.equal(none.lines.length, 1);
  assert.equal(none.lines[0].text, 'No project is in the pilot, so no exit reading is expected.');
  assert.equal(none.lines[0].link, null);
  // pilot projects that all have their reading: "None right now."
  const tk = require('../core/tickets');
  const real = tk.pilotCandidates;
  tk.pilotCandidates = () => [{ project_id: 'p', in_pilot: true, exit_reading: { present: true } }];
  const ok = byId(B.brief(s.ws, { now: Date.now() }), 'pilot_exits');
  assert.equal(ok.lines[0].text, 'None right now.');
  tk.pilotCandidates = () => [{ project_id: 'p', name: 'P', in_pilot: true, exit_reading: { present: false, size_usd: 500 } }];
  const miss = byId(B.brief(s.ws, { now: Date.now() }), 'pilot_exits');
  tk.pilotCandidates = real;
  assert.equal(miss.count, 1);
  assert.match(miss.lines[0].text, /^P: no current exit reading at \$500\./);
});
