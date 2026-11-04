'use strict';
// A5 (Stage 1.5, PR B3 [P]): the PM Cohort's records are read in full or not at
// all. A line that does not read, or a file that cannot be read, is an INTEGRITY
// refusal, never a shorter or empty book. A missing file is the only empty one.
// Temporary fictional workspaces only. The decision-level path is in
// tickets.test.js, beside the fixtures it needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const P = require('../core/paper');
const { tempWorkspace } = require('./helpers');

const OPEN_A = { schema_version: 'cr.paper.v1', paper_version: P.VERSION, event: 'open', position_id: 'pp_FICTIONAL_a', project_id: 'fictional-a', receipt_id: 'rc_a', decision_id: 'dc_a', decided_at: '2026-10-01T00:00:00.000Z', risk_usd: 50, entry: { status: 'no_entry_price', reason: 'FICTIONAL' } };
const OPEN_B = { ...OPEN_A, position_id: 'pp_FICTIONAL_b', project_id: 'fictional-b', decision_id: 'dc_b' };
const SECRET_LOOKING = 'FICTIONAL-record-contents-never-echoed';

function workspace(t) {
  const w = tempWorkspace('paper-integrity');
  t.after(w.cleanup);
  return w;
}
const put = (ws, text) => {
  fs.mkdirSync(path.dirname(ws.abs(P.REL)), { recursive: true });
  fs.writeFileSync(ws.abs(P.REL), text);
};
const line = (r) => `${JSON.stringify(r)}\n`;
const refused = (fn, re) => assert.throws(fn, (e) => {
  assert.equal(e.code, 'INTEGRITY', e.message);
  assert.match(e.message, re);
  assert.ok(!e.message.includes(SECRET_LOOKING), 'a record\'s contents are never repeated');
  return true;
});

test('a missing file is an empty book, the one case that is', (t) => {
  const { ws } = workspace(t);
  assert.deepEqual(P.readRecords(ws), []);
  assert.equal(P.book(ws).counts.positions, 0);
});

test('a good file reads in full and in order; blank lines, CRLF and a BOM are not corruption', (t) => {
  const { ws } = workspace(t);
  put(ws, `\uFEFF${JSON.stringify(OPEN_A)}\r\n\r\n${JSON.stringify(OPEN_B)}\n\n`);
  assert.deepEqual(P.readRecords(ws).map((r) => r.position_id), ['pp_FICTIONAL_a', 'pp_FICTIONAL_b']);
});

test('one bad line refuses the whole read and names the line; the good lines around it are not returned', (t) => {
  const { ws } = workspace(t);
  put(ws, `${line(OPEN_A)}{"event":"open","note":"${SECRET_LOOKING}\n${line(OPEN_B)}`);
  refused(() => P.readRecords(ws), /paper\/positions\.jsonl has a line that does not read \(line 2\)/);
});

test('every shape of a line that is not a record is refused', (t) => {
  const { ws } = workspace(t);
  for (const bad of ['{"event":"open"', 'not json', 'null', '123', '"text"', 'true', '[1,2]']) {
    put(ws, `${line(OPEN_A)}${bad}\n`);
    refused(() => P.readRecords(ws), /does not read \(line 2\)/);
  }
});

test('several bad lines are counted, and the words stay short', (t) => {
  const { ws } = workspace(t);
  put(ws, `x\n${line(OPEN_A)}y\nz\n1\n2\n3\n4\n`);
  refused(() => P.readRecords(ws), /has 7 lines that do not read \(line 1, 3, 4, 5, 6\)/);
});

test('a file that cannot be read is refused, and the words carry no folder of this machine', (t) => {
  const { ws, root } = workspace(t);
  fs.mkdirSync(ws.abs(P.REL), { recursive: true }); // A real read error: a folder in its place.
  assert.throws(() => P.readRecords(ws), (e) => {
    assert.equal(e.code, 'INTEGRITY');
    assert.match(e.message, /paper\/positions\.jsonl could not be read \(EISDIR\)/);
    assert.ok(!e.message.includes(root), 'no absolute path');
    return true;
  });
});

test('the book refuses instead of reading short', (t) => {
  const { ws } = workspace(t);
  put(ws, `${line(OPEN_A)}{bad\n`);
  refused(() => P.book(ws), /does not read \(line 2\)/);
});

// The write path read the same way, so a dropped line hid the decision's own open.
const DECISION = { project_id: 'fictional-a', receipt_id: 'rc_a', decision_id: 'dc_a', decided_at: '2026-10-01T00:00:00.000Z', pm_approved_risk_usd: 50 };
const PROJECT = { identity: {} };
const RECEIPT = { receipt_id: 'rc_a', ticket_id: 'tk_a', project_id: 'fictional-a', proposal: null };

test('a bad line stops the next position: its own open cannot be hidden and opened twice, and nothing is written', (t) => {
  const { ws } = workspace(t);
  const before = `{"event":"open","decision_id":"dc_a","note":"${SECRET_LOOKING}\n`;
  put(ws, before);
  refused(() => P.openForDecision(ws, PROJECT, RECEIPT, DECISION), /does not read \(line 1\)/);
  assert.equal(fs.readFileSync(ws.abs(P.REL), 'utf8'), before, 'zero writes');
});

test('a bad line stops a void too, and nothing is written', (t) => {
  const { ws } = workspace(t);
  const before = `${line(OPEN_A)}{bad\n`;
  put(ws, before);
  refused(() => P.voidForDecision(ws, 'dc_a', 'FICTIONAL undo'), /does not read \(line 2\)/);
  assert.equal(fs.readFileSync(ws.abs(P.REL), 'utf8'), before, 'zero writes');
});

test('a file that cannot be read stops a write in the same words', (t) => {
  const { ws, root } = workspace(t);
  fs.mkdirSync(ws.abs(P.REL), { recursive: true });
  assert.throws(() => P.openForDecision(ws, PROJECT, RECEIPT, DECISION), (e) => {
    assert.equal(e.code, 'INTEGRITY');
    assert.match(e.message, /could not be read/);
    assert.ok(!e.message.includes(root), 'no absolute path');
    return true;
  });
});

test('a healthy file still opens, repeats unchanged and voids', (t) => {
  const { ws } = workspace(t);
  assert.equal(P.openForDecision(ws, PROJECT, RECEIPT, DECISION).status, 'saved');
  assert.equal(P.openForDecision(ws, PROJECT, RECEIPT, DECISION).status, 'unchanged');
  assert.equal(P.voidForDecision(ws, 'dc_a', 'FICTIONAL undo').status, 'saved');
  assert.deepEqual(P.readRecords(ws).map((r) => r.event), ['open', 'void']);
});

// ---- Everyone who reads it

test('the JSON export keeps working and says the book is unreadable; it never exports it as empty', (t) => {
  const exporter = require('../core/exporter');
  const { ws } = workspace(t);
  put(ws, `${line(OPEN_A)}{"note":"${SECRET_LOOKING}\n`);
  const doc = exporter.exportJson(ws);
  assert.equal(doc.paper.positions, null, 'null, never []');
  assert.match(doc.paper.unreadable, /does not read \(line 2\)/);
  assert.ok(!JSON.stringify(doc).includes(SECRET_LOOKING));
  assert.ok(doc.portfolio, 'the rest of the export is still there');
  fs.rmSync(ws.abs(P.REL));
  const clean = exporter.exportJson(ws);
  assert.deepEqual(clean.paper, { positions: [] });
});

test('the daily brief reads the real book: Horizons is partial and says why', (t) => {
  const B = require('../core/brief-daily');
  const { ws } = workspace(t);
  put(ws, `${line(OPEN_A)}{bad\n`);
  const h = B.brief(ws, { now: Date.now() }).sections.find((s) => s.id === 'horizons');
  assert.equal(h.state, 'partial');
  assert.equal(h.count, null);
  assert.match(h.lines[0].text, /^Paper: the book could not be read \(paper\/positions\.jsonl has a line that does not read \(line 2\)/);
});

test('`cli paper` fails loudly with the same words', (t) => {
  const { ws, root } = workspace(t);
  put(ws, `${line(OPEN_A)}{"note":"${SECRET_LOOKING}\n`);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'paper', '--json', '--workspace', root], { encoding: 'utf8', timeout: 60000 });
  assert.notEqual(r.status, 0);
  const said = r.stdout + r.stderr;
  assert.match(said, /INTEGRITY/);
  assert.match(said, /does not read \(line 2\)/);
  assert.ok(!said.includes(SECRET_LOOKING));
  fs.rmSync(ws.abs(P.REL));
  const clean = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'paper', '--json', '--workspace', root], { encoding: 'utf8', timeout: 60000 });
  assert.equal(clean.status, 0, clean.stderr);
});

function request(port, { pathName, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathName, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/paper answers an error with the code, not an empty book', async (t) => {
  const { start } = require('../server');
  const { ws } = workspace(t);
  const srv = await start(ws, { port: 49500 + Math.floor(Math.random() * 300), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* already stopped */ } });
  const token = JSON.parse((await request(srv.port, { pathName: '/api/session' })).body).token;
  const headers = { 'x-cr-token': token };
  put(ws, `${line(OPEN_A)}{"note":"${SECRET_LOOKING}\n`);
  const bad = await request(srv.port, { pathName: '/api/paper', headers });
  assert.ok(bad.status >= 400, `status ${bad.status}`);
  assert.match(bad.body, /INTEGRITY/);
  assert.ok(!bad.body.includes(SECRET_LOOKING));
  assert.doesNotMatch(bad.body, /"positions"/);
  fs.rmSync(ws.abs(P.REL));
  const good = await request(srv.port, { pathName: '/api/paper', headers });
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.body).counts.positions, 0);
});
