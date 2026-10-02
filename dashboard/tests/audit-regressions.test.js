'use strict';
// Regression tests for the October 1, 2026 system review (audits/2026-10-01-codex-system-review).
// Each test reproduces a finding's counterexample in a throwaway TEST workspace
// and checks the acceptance condition. All data is fictional.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const ops = require('../core/ops');
const requests = require('../core/requests');
const notes = require('../core/notes');
const pf = require('../core/portfolio');
const inbox = require('../core/inbox');
const reports = require('../core/reports');
const compare = require('../core/compare');
const exporter = require('../core/exporter');
const market = require('../core/market');
const indexer = require('../core/indexer');
const rubrics = require('../core/rubrics');
const { openWorkspace } = require('../core/workspace');
const { readJson, atomicWrite, jsonText, sha256 } = require('../core/fsx');

const CHILD = path.join(__dirname, 'children');

function writeRequest(root, req) {
  fs.writeFileSync(path.join(root, 'inbox', 'requests', `${req.request_id}.json`), JSON.stringify(req));
}

function journalReq(id, projectId, text = 'FICTIONAL crash probe') {
  return { schema_version: 'cr.request.v1', request_id: id, created_at: new Date().toISOString(), created_by: 'test', utterance: 'record a note', action: 'add_journal', args: { project_id: projectId, type: 'decision', decision: 'watch', text } };
}

function runChild(script, args) {
  return cp.spawnSync(process.execPath, [path.join(CHILD, script), ...args], { encoding: 'utf8' });
}

function accounts(ws, ...ids) {
  for (const id of ids) pf.addAccount(ws, { account_id: id, name: id });
}

function pos(out, id = 'bitcoin') {
  return out.positions.find((p) => p.asset_id === id);
}

// ---------------------------------------------------------------------------
// F01 / F11: request identity, replay safety, truthful receipts

for (const mode of ['before_seal', 'after_effect', 'during_receipt']) {
  test(`F01: a crash ${mode.replace('_', ' ')} still applies a queued journal entry exactly once`, (t) => {
    const { ws, root, cleanup } = tempWorkspace(`f01-${mode}`);
    t.after(cleanup);
    const pid = addFixtureProject(ws).project_id;
    writeRequest(root, journalReq('req_crash_0001', pid));
    const child = runChild('child-queue-crash.js', [root, mode]);
    assert.equal(child.status, 77, child.stderr);
    for (let i = 0; i < 3; i++) requests.processRequests(openWorkspace({ root, actor: `restart-${i}` }));
    const entries = notes.loadJournal(ws, pid).filter((e) => e.text === 'FICTIONAL crash probe');
    assert.equal(entries.length, 1, 'exactly one journal entry');
    const receipt = requests.requestStatus(ws, 'req_crash_0001');
    assert.equal(receipt.status, 'done');
    assert.ok(fs.existsSync(path.join(root, 'inbox', 'requests', 'processed', 'req_crash_0001.json')));
  });
}

test('F01: crashes after the effect are also safe for events and transactions', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f01-other');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  accounts(ws, 'a');
  writeRequest(root, { schema_version: 'cr.request.v1', request_id: 'req_event_0001', action: 'add_event', args: { project_id: pid, type: 'catalyst', title: 'FICTIONAL catalyst', due: '2026-12-01' } });
  writeRequest(root, { schema_version: 'cr.request.v1', request_id: 'req_tx_00001', action: 'add_transaction', args: { type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: '0.5', price_usd: '60000' } });
  // First crash: after the event's effect. Second crash: the event's receipt is
  // rebuilt without re-applying, then the transaction's effect commits and it crashes again.
  assert.equal(runChild('child-queue-crash.js', [root, 'after_effect']).status, 77);
  assert.equal(runChild('child-queue-crash.js', [root, 'after_effect']).status, 77);
  for (let i = 0; i < 3; i++) {
    runChild('child-run-queue.js', [root, `r${i}`]);
  }
  assert.equal(notes.loadEvents(ws, pid).filter((e) => e.title === 'FICTIONAL catalyst').length, 1);
  assert.equal(pf.loadTransactions(ws).length, 1);
  assert.equal(requests.requestStatus(ws, 'req_event_0001').status, 'done');
  assert.equal(requests.requestStatus(ws, 'req_tx_00001').status, 'done');
});

test('F01: two processors started together apply a request once', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('f01-concurrent');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  for (let i = 1; i <= 5; i++) writeRequest(root, journalReq(`req_conc_000${i}`, pid, `FICTIONAL concurrent ${i}`));
  const run = (label) => new Promise((resolve) => {
    const c = cp.spawn(process.execPath, [path.join(CHILD, 'child-run-queue.js'), root, label], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
  const [a, b] = await Promise.all([run('A'), run('B')]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  requests.processRequests(ws);
  for (let i = 1; i <= 5; i++) {
    assert.equal(notes.loadJournal(ws, pid).filter((e) => e.text === `FICTIONAL concurrent ${i}`).length, 1, `request ${i} applied once`);
    assert.equal(requests.requestStatus(ws, `req_conc_000${i}`).status, 'done');
  }
});

test('F01: an ID reused for different content is a conflict; an identical retry is unchanged', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f01-conflict');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  writeRequest(root, journalReq('req_same_0001', pid, 'FICTIONAL first'));
  requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_same_0001').status, 'done');
  writeRequest(root, journalReq('req_same_0001', pid, 'FICTIONAL first'));
  requests.processRequests(ws);
  assert.equal(notes.loadJournal(ws, pid).filter((e) => e.text === 'FICTIONAL first').length, 1, 'identical retry adds nothing');
  writeRequest(root, journalReq('req_same_0001', pid, 'FICTIONAL different'));
  const out = requests.processRequests(ws);
  assert.equal(out.results[0].status, 'conflict');
  assert.equal(notes.loadJournal(ws, pid).filter((e) => e.text === 'FICTIONAL different').length, 0, 'nothing applied');
  assert.equal(requests.requestStatus(ws, 'req_same_0001').status, 'done', 'the original receipt is intact');
});

test('F11: rejected imports, unknown actions and malformed files never get a done receipt', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f11');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  writeRequest(root, { schema_version: 'cr.request.v1', request_id: 'req_short_0001', action: 'import_report_text', args: { provider: 'claude', project_id: pid, text: 'too short' } });
  writeRequest(root, { schema_version: 'cr.request.v1', request_id: 'req_unknown_01', action: 'delete_everything', args: {} });
  const mismatch = `# Example PayFi (FICTIONAL)\nModel: Gemini (Google)\nDate: 2026-09-30\n${'A synthetic completed research discussion for testing. '.repeat(20)}\n`;
  writeRequest(root, { schema_version: 'cr.request.v1', request_id: 'req_mismatch_1', action: 'import_report_text', args: { provider: 'claude', project_id: pid, text: mismatch } });
  requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_short_0001').status, 'rejected');
  assert.equal(requests.requestStatus(ws, 'req_unknown_01').status, 'rejected');
  assert.equal(requests.requestStatus(ws, 'req_mismatch_1').status, 'rejected');
  // The rejected text is kept in the inbox for correction.
  assert.ok(inbox.inboxStatus(ws).in_inbox.some((f) => f.status === 'provider_mismatch'));
  // A partially written file is left pending, then rejected (and kept) once it is old.
  const partial = path.join(root, 'inbox', 'requests', 'req_partial_01.json');
  fs.writeFileSync(partial, '{"schema_version":"cr.request.v1","request_id":"req_part');
  let out = requests.processRequests(ws);
  assert.equal(out.results.find((r) => r.file === 'req_partial_01.json').status, 'pending');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(partial, old, old);
  out = requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_partial_01').status, 'rejected');
  assert.ok(fs.existsSync(path.join(root, 'inbox', 'requests', 'failed', 'req_partial_01.json')), 'input preserved');
  // .tmp publication is ignored until renamed.
  const tmp = path.join(root, 'inbox', 'requests', 'req_tmp_00001.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(journalReq('req_tmp_00001', pid, 'FICTIONAL published')));
  requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_tmp_00001').status, 'pending');
  fs.renameSync(tmp, tmp.replace(/\.tmp$/, ''));
  requests.processRequests(ws);
  requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_tmp_00001').status, 'done');
  assert.equal(notes.loadJournal(ws, pid).filter((e) => e.text === 'FICTIONAL published').length, 1);
});

// ---------------------------------------------------------------------------
// F04: owner-safe locks, coherent reads, fail-closed verification, no-delete sessions

test('F04: an old lock held by a live process is never broken; a dead one is', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f04-lock');
  t.after(cleanup);
  const lf = path.join(root, '.cr', 'lock.json');
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  fs.writeFileSync(lf, JSON.stringify({ token: 'someone-else', pid: process.pid, host: os.hostname(), actor: 'alive' }));
  const old = new Date(Date.now() - 600000);
  fs.utimesSync(lf, old, old);
  assert.throws(() => ops.withLock(ws, 't', () => true, { timeoutMs: 80 }), (e) => e.code === 'WORKSPACE_BUSY');
  fs.writeFileSync(lf, JSON.stringify({ token: 'dead', pid: 999999, host: os.hostname(), actor: 'dead' }));
  assert.equal(ops.withLock(ws, 't', () => 'ran', { timeoutMs: 2000 }), 'ran');
  // A lease from another host expires only after two minutes without renewal.
  fs.writeFileSync(lf, JSON.stringify({ token: 'remote', pid: 1, host: 'cowork-vm', actor: 'cowork' }));
  assert.throws(() => ops.withLock(ws, 't', () => true, { timeoutMs: 80 }), (e) => e.code === 'WORKSPACE_BUSY');
  fs.utimesSync(lf, old, old);
  assert.equal(ops.withLock(ws, 't', () => 'ran', { timeoutMs: 2000 }), 'ran');
});

test('F04: a process that lost its lock cannot remove the new owner\'s lock or apply its write', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f04-owner');
  t.after(cleanup);
  const lf = path.join(root, '.cr', 'lock.json');
  assert.throws(() => ops.runOp(ws, { type: 'lost', summary: 'x' }, (op) => {
    op.write('logs/lost.txt', 'should not land');
    fs.writeFileSync(lf, JSON.stringify({ token: 'new-owner', pid: process.pid, host: os.hostname() }));
  }), (e) => e.code === 'LOCK_LOST');
  assert.ok(!fs.existsSync(path.join(root, 'logs', 'lost.txt')), 'nothing applied');
  assert.equal(JSON.parse(fs.readFileSync(lf, 'utf8')).token, 'new-owner', 'the new owner keeps its lock');
  fs.unlinkSync(lf);
});

test('F04: readers see one generation even while a two-file commit is in progress', async (t) => {
  const { root, cleanup } = tempWorkspace('f04-gen');
  t.after(cleanup);
  const spawn = (role) => new Promise((resolve) => {
    const c = cp.spawn(process.execPath, [path.join(CHILD, 'child-generation.js'), root, role, '25'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', () => resolve(out));
  });
  const [, reader] = await Promise.all([spawn('writer'), spawn('reader')]);
  const r = JSON.parse(reader);
  assert.equal(r.consistentMixed, 0, `consistent reads saw mixed generations: ${reader}`);
});

test('F04: a commit that does not verify keeps evidence and blocks writes until resolved', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f04-verify');
  t.after(cleanup);
  const rename = fs.renameSync;
  t.after(() => { fs.renameSync = rename; });
  fs.renameSync = function corrupting(from, to) {
    const r = rename.call(fs, from, to);
    if (String(to).endsWith('corrupt-me.txt')) fs.writeFileSync(to, 'damaged on disk');
    return r;
  };
  assert.throws(() => ops.runOp(ws, { type: 'probe', summary: 'x' }, (op) => op.write('logs/corrupt-me.txt', 'intended')), (e) => e.code === 'COMMIT_UNVERIFIED');
  fs.renameSync = rename;
  const blocked = ops.blockedState(ws);
  assert.ok(blocked, 'writes are blocked');
  assert.ok(fs.existsSync(path.join(root, blocked.evidence, 'manifest.json')), 'staged evidence kept');
  assert.throws(() => ops.runOp(ws, { type: 'next', summary: 'x' }, (op) => op.write('logs/next.txt', 'x')), (e) => e.code === 'WRITES_BLOCKED');
  assert.equal(ops.resolveBlock(ws).status, 'still_blocked');
  assert.equal(ops.resolveBlock(ws, { force: true, reason: 'test: inspected and accepted' }).status, 'unblocked');
  assert.equal(ops.runOp(ws, { type: 'next', summary: 'x' }, (op) => op.write('logs/next.txt', 'x')).verified, true);
});

test('F04: a session that cannot delete files still commits, and cleanup happens later', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f04-nodelete');
  t.after(cleanup);
  const unlink = fs.unlinkSync;
  const rm = fs.rmSync;
  const deny = () => { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; };
  fs.unlinkSync = deny;
  fs.rmSync = deny;
  t.after(() => { fs.unlinkSync = unlink; fs.rmSync = rm; });
  ws._caps = { write: true, rename: true, delete: false };
  const a = ops.runOp(ws, { type: 'nd1', summary: 'x' }, (op) => op.write('logs/nd1.txt', 'one'));
  assert.equal(a.verified, true);
  const started = Date.now();
  const b = ops.runOp(ws, { type: 'nd2', summary: 'x' }, (op) => op.write('logs/nd2.txt', 'two'));
  assert.equal(b.verified, true);
  assert.ok(Date.now() - started < 5000, 'second write did not wait for a lease to expire');
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, '.cr', 'lock.json'), 'utf8')).released, 'lock left as a released marker');
  fs.unlinkSync = unlink;
  fs.rmSync = rm;
  const ws2 = openWorkspace({ root, actor: 'pc' });
  ops.runOp(ws2, { type: 'nd3', summary: 'x' }, (op) => op.write('logs/nd3.txt', 'three'));
  const staging = path.join(root, '.cr', 'staging');
  assert.equal(fs.existsSync(staging) ? fs.readdirSync(staging).length : 0, 0, 'deferred staging cleaned up by a session that can delete');
});

// ---------------------------------------------------------------------------
// F05: historical rubric resolution

function scoredComponents(ws, values) {
  return Object.fromEntries(ws.rubrics.grading.investment_components.map((c, i) => [c.id, { status: 'scored', value: values[i], rationale: 'FICTIONAL' }]));
}

test('F05: a v1 report keeps its v1 grade after v2 becomes active; unknown and altered rubrics are withheld', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f05');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  const raw = { schema_version: 'cr.report.v1', provider: 'claude', project_id: pid, rubric_version: 'cr-grading@1', sector_profile: 'payfi-credit@1', analysis_at: '2026-09-30', horizon: '24 months', verdict: 'INSUFFICIENT EVIDENCE', diagnostic_scores: {}, investment_components: scoredComponents(ws, [100, 20, 50, 50, 50, 50]), model_reported_overall_score: { status: 'scored', value: 52.5, rationale: 'x' }, risk_scores: {} };
  inbox.importContent(ws, 'claude', { content: JSON.stringify(raw), projectId: pid });
  const before = indexer.projectDetail(ws, pid).reports[0];
  assert.equal(before.grade.value, 52.5);
  const v2 = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'rubrics', 'cr-grading.v1.json'), 'utf8'));
  v2.rubric_ref = 'cr-grading@2';
  v2.version = 2;
  v2.investment_components[0].weight_bp = 4000;
  v2.investment_components[1].weight_bp = 500;
  fs.writeFileSync(path.join(root, 'templates', 'rubrics', 'cr-grading.v2.json'), JSON.stringify(v2));
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText({ ...readJson(path.join(root, 'config', 'settings.json')), grading: { rubric: 'cr-grading@2' } }));
  const ws2 = openWorkspace({ root });
  const after = indexer.projectDetail(ws2, pid).reports[0];
  assert.equal(after.grade.value, 52.5, 'grade unchanged');
  assert.equal(after.grade.rubric, 'cr-grading@1');
  assert.equal(after.model_total.status, before.model_total.status);
  // Unknown rubric: raw scores kept, no app grade.
  const unknown = { ...raw, rubric_version: 'unrecognized@1', analysis_at: '2026-09-29', summary: 'different bytes' };
  inbox.importContent(ws2, 'claude', { content: JSON.stringify(unknown), projectId: pid });
  const u = indexer.projectDetail(ws2, pid).reports.find((r) => r.assessment.rubric_version === 'unrecognized@1');
  assert.equal(u.grade.status, 'withheld');
  assert.match(u.grade.reason, /not a known rubric version/);
  // A pinned rubric file that changes later withholds grades that depend on it.
  rubrics.pinRubrics(ws2);
  const v1file = path.join(root, 'templates', 'rubrics', 'cr-grading.v1.json');
  const v1 = JSON.parse(fs.readFileSync(v1file, 'utf8'));
  v1.investment_components[0].weight_bp = 1500;
  v1.investment_components[1].weight_bp = 3000;
  fs.writeFileSync(v1file, JSON.stringify(v1));
  const ws3 = openWorkspace({ root });
  const altered = indexer.projectDetail(ws3, pid).reports.find((r) => r.assessment.rubric_version === 'cr-grading@1');
  assert.equal(altered.grade.status, 'withheld');
  assert.equal(altered.grade.rubric_status, 'altered');
});

// ---------------------------------------------------------------------------
// F02 / F03 / F07 / F20 / F21 / U03: portfolio

test('F02: a transferred older lot is sold first (acquisition-order FIFO)', (t) => {
  const { ws, cleanup } = tempWorkspace('f02');
  t.after(cleanup);
  accounts(ws, 'a', 'b');
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10 },
    { type: 'buy', date: '2026-09-02', account_id: 'b', asset_id: 'bitcoin', quantity: 1, price_usd: 20 },
    { type: 'transfer_out', date: '2026-09-03', account_id: 'a', asset_id: 'bitcoin', quantity: 1, transfer_id: 'move' },
    { type: 'transfer_in', date: '2026-09-03', account_id: 'b', asset_id: 'bitcoin', quantity: 1, transfer_id: 'move' },
    { type: 'sell', date: '2026-09-04', account_id: 'b', asset_id: 'bitcoin', quantity: 1, price_usd: 30 },
  ].map((x) => ({ ...x })), { source: 'csv' });
  const p = pos(pf.computePortfolio(ws));
  assert.equal(p.realized_known_usd, 20);
  assert.equal(p.cost_basis_known_usd, 20);
});

test('F02: multi-hop and partial transfers keep acquisition order', (t) => {
  const { ws, cleanup } = tempWorkspace('f02b');
  t.after(cleanup);
  accounts(ws, 'a', 'b', 'c');
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-08-01', account_id: 'a', asset_id: 'bitcoin', quantity: 2, price_usd: 10 },
    { type: 'buy', date: '2026-08-05', account_id: 'c', asset_id: 'bitcoin', quantity: 1, price_usd: 50 },
    { type: 'transfer_out', date: '2026-08-10', account_id: 'a', asset_id: 'bitcoin', quantity: 1, transfer_id: 'hop1' },
    { type: 'transfer_in', date: '2026-08-10', account_id: 'b', asset_id: 'bitcoin', quantity: 1, transfer_id: 'hop1' },
    { type: 'transfer_out', date: '2026-08-11', account_id: 'b', asset_id: 'bitcoin', quantity: 1, transfer_id: 'hop2' },
    { type: 'transfer_in', date: '2026-08-11', account_id: 'c', asset_id: 'bitcoin', quantity: 1, transfer_id: 'hop2' },
    { type: 'sell', date: '2026-08-12', account_id: 'c', asset_id: 'bitcoin', quantity: 1, price_usd: 100 },
  ], { source: 'csv' });
  const p = pos(pf.computePortfolio(ws));
  assert.equal(p.realized_known_usd, 90, 'the Aug 1 lot (cost 10) is sold, not the Aug 5 lot (cost 50)');
  assert.equal(p.quantity, 2);
  assert.equal(p.cost_basis_known_usd, 60);
});

test('F03: a reused transfer ID is refused on input; legacy duplicates are never dropped', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f03');
  t.after(cleanup);
  accounts(ws, 'a', 'b');
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 2, price_usd: 10 }]);
  pf.addTransactions(ws, [{ type: 'transfer_out', date: '2026-09-02', account_id: 'a', asset_id: 'bitcoin', quantity: 1, transfer_id: 'same' }]);
  assert.throws(() => pf.addTransactions(ws, [{ type: 'transfer_out', date: '2026-09-02', account_id: 'a', asset_id: 'bitcoin', quantity: 1, transfer_id: 'same' }]), /already used/);
  // Legacy file with two outbound legs sharing an ID (written before this check existed).
  const doc = readJson(path.join(root, 'portfolio', 'transactions.json'));
  doc.transactions.push({ ...doc.transactions[1], tx_id: 'legacy-second-leg' });
  atomicWrite(path.join(root, 'portfolio', 'transactions.json'), jsonText(doc));
  const out = pf.computePortfolio(ws);
  const p = pos(out);
  assert.equal(p.quantity, 2, 'both units still owned (in transit)');
  assert.equal(p.in_transit_quantity, 2);
  assert.ok(out.warnings.some((w) => w.kind === 'ambiguous_transfer_id'));
  assert.ok(p.conservation.ok);
  // An arrival for the ambiguous ID is quarantined, not counted twice.
  doc.transactions.push({ ...doc.transactions[1], tx_id: 'legacy-arrival', type: 'transfer_in', account_id: 'b' });
  atomicWrite(path.join(root, 'portfolio', 'transactions.json'), jsonText(doc));
  const out2 = pf.computePortfolio(ws);
  assert.equal(pos(out2).quantity, 2);
  assert.equal(out2.quarantine.length, 1);
});

test('F07: separate fills stay separate, ID reuse conflicts, malformed fees are rejected, voids are exact', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f07');
  t.after(cleanup);
  accounts(ws, 'a');
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10, fee_amount: 1 }]);
  const second = pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10, fee_amount: 2 }]);
  assert.equal(second.status, 'saved');
  assert.equal(pos(pf.computePortfolio(ws)).quantity, 2);
  pf.addTransactions(ws, [{ tx_id: 'same-id', type: 'buy', date: '2026-09-02', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10 }]);
  assert.equal(pf.addTransactions(ws, [{ tx_id: 'same-id', type: 'buy', date: '2026-09-02', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10 }]).unchanged.length, 1, 'exact retry is unchanged');
  assert.throws(() => pf.addTransactions(ws, [{ tx_id: 'same-id', type: 'buy', date: '2026-09-02', account_id: 'a', asset_id: 'bitcoin', quantity: 2, price_usd: 20 }]), (e) => e.code === 'CONFLICT');
  assert.throws(() => pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-03', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10, fee_amount: 'invalid' }]), /fee_amount/);
  const csv = pf.importCsv(ws, 'date,type,account,asset,quantity,price_usd,fee_amount\n2026-09-04,buy,a,bitcoin,1,10,abc\n', { filename: 'bad.csv' });
  assert.equal(csv.rejected.length, 1);
  assert.equal(csv.added.length, 0);
  // Legacy duplicate IDs make a void ambiguous: refused, nothing changed.
  const doc = readJson(path.join(root, 'portfolio', 'transactions.json'));
  doc.transactions.push({ ...doc.transactions.find((x) => x.tx_id === 'same-id'), quantity: '2' });
  atomicWrite(path.join(root, 'portfolio', 'transactions.json'), jsonText(doc));
  assert.throws(() => pf.voidTransaction(ws, 'same-id', 'test'), (e) => e.code === 'AMBIGUOUS');
});

test('F20: dust survives, closed positions keep their fees, precision is explicit', (t) => {
  const { ws, cleanup } = tempWorkspace('f20');
  t.after(cleanup);
  accounts(ws, 'a');
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: '0.0000000005', price_usd: 1000000 }]);
  const dust = pos(pf.computePortfolio(ws));
  assert.ok(dust && dust.quantity_exact === '0.0000000005', 'dust holding is shown exactly');
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-09-02', account_id: 'a', asset_id: 'usd-coin', quantity: 1, price_usd: 10, fee_amount: 1 },
    { type: 'sell', date: '2026-09-03', account_id: 'a', asset_id: 'usd-coin', quantity: 1, price_usd: 12, fee_amount: 1 },
  ], { source: 'csv' });
  const out = pf.computePortfolio(ws);
  const closed = pos(out, 'usd-coin');
  assert.equal(closed.closed, true);
  assert.equal(closed.realized_known_usd, 0);
  assert.equal(closed.fees_usd, 2);
  assert.equal(out.totals.fees_usd, 2, 'fees of a closed breakeven position stay in the totals');
  assert.throws(() => pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-04', account_id: 'a', asset_id: 'bitcoin', quantity: '0.0000000000000000001', price_usd: 1 }]), /decimal places/);
  // Exact decimals: 0.1 + 0.2 = 0.3, not 0.30000000000000004.
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-09-05', account_id: 'a', asset_id: 'tether', quantity: '0.1', price_usd: 1 },
    { type: 'buy', date: '2026-09-05', account_id: 'a', asset_id: 'tether', quantity: '0.2', price_usd: 1 },
  ], { source: 'csv' });
  assert.equal(pos(pf.computePortfolio(ws), 'tether').quantity_exact, '0.3');
});

test('F21: a bridge into a different asset is quarantined, and the BTC comparison says when it is incomplete', (t) => {
  const { ws, cleanup } = tempWorkspace('f21');
  t.after(cleanup);
  addFixtureProject(ws);
  accounts(ws, 'a', 'b');
  pf.addTransactions(ws, [
    { type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 1, price_usd: 10 },
    { type: 'transfer_out', date: '2026-09-02', account_id: 'a', asset_id: 'bitcoin', quantity: 1, transfer_id: 'bridge' },
    { type: 'transfer_in', date: '2026-09-03', account_id: 'b', asset_id: 'example-payfi-fictional', quantity: 1, transfer_id: 'bridge' },
  ], { source: 'csv' });
  const out = pf.computePortfolio(ws, { market: { assets: { bitcoin: { price_usd: 100, source_last_updated_at: new Date().toISOString() }, 'example-payfi-fictional': { price_usd: 100, source_last_updated_at: new Date().toISOString() } } } });
  assert.equal(pos(out).in_transit_quantity, 1, 'outbound bitcoin stays in transit');
  assert.ok(!pos(out, 'example-payfi-fictional') || pos(out, 'example-payfi-fictional').quantity === 0, 'arrival not counted');
  assert.equal(out.quarantine.length, 1);
  assert.equal(out.totals.value_priced_usd, 100, 'one unit of exposure, not two');
  // Complete BTC capital comparison against an independent calculation.
  const { ws: w2, cleanup: c2 } = tempWorkspace('f21b');
  t.after(c2);
  addFixtureProject(w2);
  accounts(w2, 'a');
  pf.addTransactions(w2, [
    { type: 'buy', date: '2026-08-01', account_id: 'a', asset_id: 'example-payfi-fictional', quantity: 100, price_usd: 1, fee_amount: 1, btc_price_usd: 50000 },
    { type: 'sell', date: '2026-08-15', account_id: 'a', asset_id: 'example-payfi-fictional', quantity: 50, price_usd: 2, btc_price_usd: 40000 },
  ], { source: 'csv' });
  const now = new Date().toISOString();
  const out2 = pf.computePortfolio(w2, { market: { assets: { bitcoin: { price_usd: 60000, source_last_updated_at: now }, 'example-payfi-fictional': { price_usd: 3, source_last_updated_at: now } } } });
  const b = pos(out2, 'example-payfi-fictional').btc_relative;
  assert.equal(b.status, 'computed');
  const cost = 101 / 50000;
  const proceeds = 100 / 40000;
  const current = 150 / 60000;
  assert.ok(Math.abs(b.result_btc - (current + proceeds - cost)) < 1e-12);
  assert.match(b.method, /not TWR or IRR/);
});

test('U03: valuation states never turn a missing price into $0', (t) => {
  const { ws, cleanup } = tempWorkspace('u03');
  t.after(cleanup);
  assert.equal(pf.computePortfolio(ws).totals.valuation_state, 'no_records');
  accounts(ws, 'a');
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 10, price_usd: 5 }]);
  const none = pf.computePortfolio(ws, { market: { assets: {} } });
  assert.equal(none.totals.valuation_state, 'all_unpriced');
  assert.equal(none.totals.value_priced_usd, null);
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'tether', quantity: 10, price_usd: 1 }]);
  const partial = pf.computePortfolio(ws, { market: { assets: { tether: { price_usd: 1, source_last_updated_at: new Date().toISOString() } } } });
  assert.equal(partial.totals.valuation_state, 'partially_priced');
  assert.equal(partial.totals.value_priced_usd, 10);
  assert.equal(partial.totals.allocation_denominator, 'priced holdings only');
  const stale = pf.computePortfolio(ws, { market: { assets: { tether: { price_usd: 1, source_last_updated_at: new Date(Date.now() - 6 * 3600000).toISOString() }, bitcoin: { price_usd: 2, source_last_updated_at: new Date().toISOString() } } } });
  assert.equal(stale.totals.valuation_state, 'stale');
});

// ---------------------------------------------------------------------------
// F06 / F18: sealed backups, clean restore, complete package

test('F06: a sealed backup verifies, detects tampering, and restores cleanly into a new folder', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f06');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  accounts(ws, 'a');
  pf.addTransactions(ws, [{ type: 'buy', date: '2026-09-01', account_id: 'a', asset_id: 'bitcoin', quantity: 2, price_usd: 10 }]);
  const raw = { schema_version: 'cr.report.v1', provider: 'claude', project_id: pid, rubric_version: 'cr-grading@1', sector_profile: 'payfi-credit@1', analysis_at: '2026-09-30', horizon: '24 months', investment_components: scoredComponents(ws, [50, 50, 50, 50, 50, 50]) };
  const rep = inbox.importContent(ws, 'claude', { content: JSON.stringify(raw), projectId: pid });
  notes.addCorrection(ws, pid, rep.result.report_id, 'summary', 'FICTIONAL corrected summary', 'test');
  const b = exporter.createBackup(ws, { reason: 'manual' });
  assert.equal(exporter.verifyBackup(ws, b.name).ok, true);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-restore-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const restored = exporter.restoreBackup(ws, b.name, { to: path.join(dest, 'ws') });
  assert.equal(restored.status, 'restored_and_verified', JSON.stringify(restored.reconciliation));
  // Tampering is detected.
  const target = path.join(root, 'backups', 'snapshots', b.name, 'files', 'portfolio', 'transactions.json');
  fs.appendFileSync(target, ' ');
  const v = exporter.verifyBackup(ws, b.name);
  assert.equal(v.ok, false);
  assert.ok(v.mismatched.includes('portfolio/transactions.json'));
  assert.throws(() => exporter.restoreBackup(ws, b.name, { to: path.join(dest, 'ws2') }), /did not verify/);
  // Overlay must be named explicitly; point-in-time previews before changing anything.
  const b2 = exporter.createBackup(ws, { reason: 'manual2' });
  notes.addJournal(ws, pid, { type: 'note', text: 'FICTIONAL after backup' });
  assert.throws(() => exporter.restoreBackup(ws, b2.name, {}), (e) => e.code === 'CONFIRM');
  const preview = exporter.restoreBackup(ws, b2.name, { pointInTime: true });
  assert.equal(preview.status, 'preview');
  assert.ok(preview.files_to_quarantine.some((f) => f.includes('/journal/')));
  const applied = exporter.restoreBackup(ws, b2.name, { pointInTime: true, confirm: true });
  assert.equal(applied.status, 'restored');
  assert.equal(notes.loadJournal(ws, pid).filter((e) => e.text === 'FICTIONAL after backup').length, 0, 'later record moved to quarantine');
  assert.ok(fs.existsSync(path.join(root, applied.quarantine_folder)), 'and kept there');
});

test('F18: the complete package rebuilds a workspace with PDF, correction, custom asset, event and a second rubric version', (t) => {
  const { ws, root, cleanup } = tempWorkspace('f18');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  pf.addAsset(ws, { asset_id: 'fictional-custom', symbol: 'FCT', name: 'Fictional custom', kind: 'token', decimals: 6 });
  notes.addEvent(ws, pid, { type: 'catalyst', title: 'FICTIONAL event', due: '2026-12-01' });
  inbox.importContent(ws, 'claude', { content: Buffer.from('%PDF-1.4\n% FICTIONAL minimal test bytes\n%%EOF\n'), filename: 'x.pdf', projectId: pid });
  const raw = { schema_version: 'cr.report.v1', provider: 'claude', project_id: pid, rubric_version: 'cr-grading@1', sector_profile: 'payfi-credit@1', analysis_at: '2026-09-30', horizon: '24 months', investment_components: scoredComponents(ws, [50, 50, 50, 50, 50, 50]) };
  const rep = inbox.importContent(ws, 'claude', { content: JSON.stringify(raw), projectId: pid });
  notes.addCorrection(ws, pid, rep.result.report_id, 'summary', 'FICTIONAL', 'test');
  const v2 = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'rubrics', 'cr-grading.v1.json'), 'utf8'));
  v2.rubric_ref = 'cr-grading@2';
  v2.version = 2;
  fs.writeFileSync(path.join(root, 'templates', 'rubrics', 'cr-grading.v2.json'), JSON.stringify(v2));
  const pkg = exporter.exportPackage(ws);
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-pkg-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const res = exporter.restorePackage(JSON.parse(JSON.stringify(pkg)), path.join(dest, 'ws'));
  assert.equal(res.status, 'restored_and_verified', JSON.stringify(res));
  const pdf = fs.readdirSync(path.join(dest, 'ws', 'projects', pid, 'reports')).some((d) => fs.existsSync(path.join(dest, 'ws', 'projects', pid, 'reports', d, 'original.pdf')));
  assert.ok(pdf, 'PDF original restored byte for byte');
  // The portable export names what it leaves out.
  assert.ok(exporter.exportJson(ws).inventory.omitted.length > 0);
});

test('F09: CSV text that a spreadsheet would run as a formula is neutralized; numbers stay numbers', () => {
  assert.equal(exporter.csvCell('=1+1'), "'=1+1");
  assert.equal(exporter.csvCell('  +SUM(A1:A2)'), "'  +SUM(A1:A2)");
  assert.equal(exporter.csvCell('@cmd'), "'@cmd");
  assert.equal(exporter.csvCell('-2+3'), "'-2+3");
  assert.equal(exporter.csvCell('\t=1'), "'\t=1");
  assert.equal(exporter.csvCell(-12.5), '-12.5');
  assert.equal(exporter.csvCell('-12.5'), '-12.5');
  assert.equal(exporter.csvCell('a,"b"'), '"a,""b"""');
  const csv = exporter.toCsv([{ note: '=HYPERLINK("x")', qty: -3 }], ['note', 'qty']);
  assert.match(csv, /"'=HYPERLINK\(""x""\)",-3/);
});

// ---------------------------------------------------------------------------
// F08 / F14 / F15: PDF shape, citation integrity, provider provenance

test('F08: a PDF-only project opens, with every section shape present and no inferred grade', (t) => {
  const { ws, cleanup } = tempWorkspace('f08');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  const r = inbox.importContent(ws, 'claude', { content: Buffer.from('%PDF-1.4\n% FICTIONAL\n%%EOF\n'), filename: 'only.pdf', projectId: pid });
  assert.equal(r.result.status, 'ingested');
  const d = indexer.projectDetail(ws, pid);
  const rep = d.reports[0];
  for (const k of ['sources', 'claims', 'bullish_facts', 'bearish_facts', 'invalidators', 'catalysts', 'unlocks', 'unresolved_questions']) assert.ok(Array.isArray(rep.assessment[k]), k);
  assert.equal(rep.grade.status, 'withheld');
  assert.match(rep.grade.reason, /PDF/);
  assert.ok(indexer.buildIndex(ws).projects.find((p) => p.project_id === pid));
});

test('F14: dangling and duplicate references are reported with exact paths and never look supported', () => {
  const a = {
    sources: [{ source_id: 'S1', url: 'https://example.com' }, { source_id: 'S1', url: 'https://example.org' }],
    claims: [{ claim_id: 'C1', text: 'x', evidence_tag: 'V', source_ids: ['MISSING'] }],
    investment_components: { token_value_capture: { status: 'scored', value: 50, evidence_refs: ['C9'] } },
    bullish_facts: [{ text: 'y', claim_ids: ['C2'] }],
  };
  const integ = reports.citationIntegrity(a);
  assert.equal(integ.status, 'issues');
  const paths = integ.issues.map((i) => i.path);
  assert.ok(paths.includes('sources[1].source_id'));
  assert.ok(paths.includes('claims[0].source_ids[0]'));
  assert.ok(paths.includes('investment_components.token_value_capture.evidence_refs[0]'));
  assert.ok(paths.includes('bullish_facts[0].claim_ids[0]'));
  assert.equal(a.claims[0].evidence_tag, 'V', 'tags are untouched');
});

test('F15: a prose report that names another provider is held back; an accepted conflict stays recorded', (t) => {
  const { ws, cleanup } = tempWorkspace('f15');
  t.after(cleanup);
  const pid = addFixtureProject(ws).project_id;
  const prose = `# Example PayFi (FICTIONAL)\nModel: Gemini (Google)\nDate: 2026-09-30\n${'This is a synthetic completed research discussion. '.repeat(15)}\n## Investment components\nToken value capture: 60/100\n`;
  const r = inbox.importContent(ws, 'claude', { content: prose, projectId: pid });
  assert.equal(r.result.status, 'provider_mismatch');
  const key = inbox.inboxStatus(ws).in_inbox[0].key;
  const forced = inbox.assignAndRetry(ws, key, pid, { allowProviderMismatch: true });
  assert.equal(forced.status, 'ingested');
  const rep = indexer.projectDetail(ws, pid).reports[0];
  assert.equal(rep.provenance.declared_provider, 'gemini');
  assert.equal(rep.provenance.inbox_provider, 'claude');
  assert.equal(rep.meta.provenance.provider_conflict_accepted, true);
  assert.equal(rep.provenance.attested, null, 'pasted text is self-reported, never attested');
});

// ---------------------------------------------------------------------------
// F12 / F13: comparisons

function fakeLatest(provider, date, horizon, extra = {}) {
  return { meta: { provider, imported_at: date }, report_id: `${provider}-${date}`, assessment: { rubric_version: 'cr-grading@1', sector_profile: 'general-token@1', horizon, horizon_interval: reports.parseHorizon(horizon), analysis_at: date, diagnostic_scores: {}, investment_components: {}, risk_scores: {}, sources: [], claims: [], ...extra } };
}

test('F12: the comparison window covers the whole date span, and horizon ranges are not collapsed', (t) => {
  const { ws, cleanup } = tempWorkspace('f12');
  t.after(cleanup);
  const latest = { claude: fakeLatest('claude', '2026-08-01', '24 months'), chatgpt: fakeLatest('chatgpt', '2026-08-21', '24 months'), gemini: fakeLatest('gemini', '2026-09-10', '24 months') };
  const c = compare.comparability(latest, ws.settings);
  assert.equal(c.comparable_providers.length, 2, '40-day span is not one comparable set');
  assert.ok(c.date_span_days <= 30);
  assert.notEqual(reports.normalizeHorizon('12-24 months'), reports.normalizeHorizon('24 months'));
  const h = compare.comparability({ claude: fakeLatest('claude', '2026-09-01', '12-24 months'), chatgpt: fakeLatest('chatgpt', '2026-09-02', '24 months') }, ws.settings);
  assert.equal(h.comparable, false);
  assert.match(h.reasons.join(' '), /horizon/);
  const eq = compare.comparability({ claude: fakeLatest('claude', '2026-09-01', '2 years'), chatgpt: fakeLatest('chatgpt', '2026-09-02', '24 months') }, ws.settings);
  assert.equal(eq.comparable, true, 'equivalent explicit units compare');
});

test('F13: a later measurement is a change, missing context is unresolved, and N/A categories stay out of spreads', (t) => {
  const { ws, cleanup } = tempWorkspace('f13');
  t.after(cleanup);
  const claim = (value, asOf, definition) => ({ claim_id: 'C1', text: 'synthetic', metric_id: 'tvl_usd', value, unit: 'USD', period: 'spot', definition, as_of: asOf, source_ids: [] });
  const pairs = compare.claimConflicts({ claude: fakeLatest('claude', '2026-08-01', '24 months', { claims: [claim(100, '2026-08-01', 'TVL')] }), chatgpt: fakeLatest('chatgpt', '2026-09-01', '24 months', { claims: [claim(200, '2026-09-01', 'TVL')] }) }, 2)[0].pairs;
  assert.equal(pairs[0].kind, 'different_date');
  const unstated = compare.claimConflicts({ claude: fakeLatest('claude', '2026-08-01', '24 months', { claims: [claim(100, '2026-08-01', null)] }), chatgpt: fakeLatest('chatgpt', '2026-08-02', '24 months', { claims: [claim(200, '2026-08-02', 'TVL')] }) }, 2)[0].pairs;
  assert.equal(unstated[0].kind, 'context_unstated');
  const same = compare.claimConflicts({ claude: fakeLatest('claude', '2026-08-01', '24 months', { claims: [claim(100, '2026-08-01', 'TVL')] }), chatgpt: fakeLatest('chatgpt', '2026-08-02', '24 months', { claims: [claim(200, '2026-08-03', 'TVL')] }) }, 2)[0].pairs;
  assert.equal(same[0].kind, 'contradiction', 'simultaneous incompatible values still flag');
  // credit_risk_transparency is N/A under general-token@1.
  const mk = (provider, value) => ({ meta: { provider, imported_at: '2026-10-01' }, report_id: provider, corrections: [], assessment: { ...fakeLatest(provider, '2026-09-30', '24 months').assessment, diagnostic_scores: { credit_risk_transparency: { status: 'scored', value, rationale: 'x' } } } });
  const row = compare.compareProject(ws, [mk('claude', 20), mk('chatgpt', 80)]).rows.find((r) => r.id === 'credit_risk_transparency');
  assert.equal(row.applicable, false);
  assert.equal(row.spread, null);
  assert.equal(row.cells.claude.value, 20, 'raw value still shown');
});

// ---------------------------------------------------------------------------
// F10 / F17: market validation, single flight, shared backoff

function enableMarket(ws, root) {
  const s = readJson(path.join(root, 'config', 'settings.json'));
  s.market_data = { enabled: true, backoff_initial_minutes: 2 };
  atomicWrite(path.join(root, 'config', 'settings.json'), jsonText(s));
  ws.reloadSettings();
}

function rowsFetch(rows, { status = 200, headers = {} } = {}) {
  let calls = 0;
  const f = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 40));
    return { ok: status === 200, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => rows };
  };
  f.calls = () => calls;
  return f;
}

test('F10: invalid, negative, undated, untracked and older rows never replace a valid price', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('f10');
  t.after(cleanup);
  enableMarket(ws, root);
  const now = new Date().toISOString();
  await market.refresh(ws, { fetchImpl: rowsFetch([{ id: 'bitcoin', current_price: 100, last_updated: now }]) });
  assert.equal(market.readLatest(ws).assets.bitcoin.price_usd, 100);
  const bad = [
    [{ id: 'bitcoin', current_price: null, last_updated: 'bad-date' }],
    [{ id: 'bitcoin', current_price: -10, last_updated: now }],
    [{ id: 'bitcoin', current_price: 0, last_updated: now }],
    [{ id: 'bitcoin', current_price: 120, last_updated: 'bad-date' }],
    [{ id: 'bitcoin', current_price: 130, last_updated: new Date(Date.now() - 3600000).toISOString() }],
    [{ id: 'not-tracked', current_price: 5, last_updated: now }],
  ];
  for (const rows of bad) await market.refresh(ws, { fetchImpl: rowsFetch(rows), force: true });
  assert.equal(market.readLatest(ws).assets.bitcoin.price_usd, 100, 'still the last valid price');
  assert.equal(market.readLatest(ws).assets['not-tracked'], undefined);
  const st = market.readStatus(ws);
  assert.ok(st.invalid_rows.length >= 1 || st.skipped_older.length >= 1);
  // A corrupt stored observation is not used for valuation.
  assert.equal(pf.priceFor({ asset_id: 'bitcoin', coingecko_id: 'bitcoin', kind: 'btc' }, { assets: { bitcoin: { price_usd: -10, source_last_updated_at: 'bad-date' } } }, ws.settings).status, 'invalid');
});

test('F17: concurrent refreshes make one provider call; a 429 backs off every runner the same way', async (t) => {
  const { ws, root, cleanup } = tempWorkspace('f17');
  t.after(cleanup);
  enableMarket(ws, root);
  const f = rowsFetch([{ id: 'bitcoin', current_price: 100, last_updated: new Date().toISOString() }]);
  const [a, b] = await Promise.all([market.refresh(ws, { fetchImpl: f, force: true }), market.refresh(ws, { fetchImpl: f, force: true })]);
  assert.equal(f.calls(), 1, 'single flight');
  assert.ok([a.status, b.status].includes('busy'));
  const limited = rowsFetch([], { status: 429, headers: { 'retry-after': '120' } });
  const r = await market.refresh(ws, { fetchImpl: limited, force: true });
  assert.equal(r.status, 'failed');
  const st = market.readStatus(ws);
  assert.ok(Date.parse(st.retry_after_until) > Date.now() + 100000);
  const again = await market.refresh(ws, { fetchImpl: limited, force: true });
  assert.equal(again.status, 'backoff', 'even a manual refresh waits for Retry-After');
  assert.equal(require('../core/jobs').marketDue(ws, Date.now(), { foreground: true }), false, 'foreground runner backs off too');
  assert.equal(require('../core/jobs').marketDue(ws, Date.now(), { foreground: false }), false, 'and the scheduled runner');
});

test('F17: two runners due for the same daily job run it once', async (t) => {
  const { ws, cleanup } = tempWorkspace('f17-daily');
  t.after(cleanup);
  const jobs = require('../core/jobs');
  const [a, b] = await Promise.all([jobs.runJob(ws, 'reviews', { trigger: 'scheduler', onlyDue: true }), jobs.runJob(ws, 'reviews', { trigger: 'dashboard', onlyDue: true })]);
  const ran = [a, b].filter((x) => x.status === 'ok').length;
  assert.equal(ran, 1, JSON.stringify([a, b]));
  const c = await jobs.runJob(ws, 'reviews', { trigger: 'cli', onlyDue: true });
  assert.equal(c.status, 'not_due');
});
