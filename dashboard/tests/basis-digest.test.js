'use strict';
// Audit 2026-11-02 F3: read-time integrity of the record at a decision's basis
// path. Create-only writes stop the desk overwriting a record; they do not
// verify what is read back. Every record written there now has its exact
// bytes' SHA-256 in the project's digest ledger, committed in the same
// operation, each line chained to the one before; every reader verifies it.
// A one-byte valid-JSON change, a swapped identity, a removed verification
// field or ledger line, a malformed or missing record: each is INTEGRITY,
// named, never rebuilt and never replaced by current values. A record from
// before the ledger reads `unverified`, never as verified decision-time
// history, and no digest is invented for it. The v1 decision line and the
// record's own schema are unchanged.
//
// Before this fix: {"bytes_changed":1,"label":"decision_time",
// "original_grade":60,"accepted_grade":90} (the audit's scratch).
// FICTIONAL temporary workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const DB = require('../core/decision-basis');
const { sha256 } = require('../core/fsx');
const { mandateDesk, saveTicket } = require('./mandate-fixture');

const INTEGRITY = (re) => (e) => e.code === 'INTEGRITY' && (!re || re.test(e.message));
const diffBytes = (a, b) => { let n = Math.abs(a.length - b.length); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n += 1; return n; };

function vetoed(t) {
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid);
  const d = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' }).result.decision;
  const rel = DB.basisRel(s.pid, d.decision_id);
  return { ...s, r, d, rel, abs: s.ws.abs(rel), ledger: s.ws.abs(DB.digestRel(s.pid)) };
}

// Every reader refuses the same way: the view (CLI and attribution through
// it) and the replay's stateOf. The record is left exactly as found.
function assertRefused(s, d, re, why) {
  const before = fs.existsSync(s.abs) ? fs.readFileSync(s.abs) : null;
  const ledger = fs.existsSync(s.ledger) ? fs.readFileSync(s.ledger) : null;
  assert.throws(() => DB.viewOf(s.ws, s.pid, d.decision_id), INTEGRITY(re), why);
  const st = DB.stateOf(s.ws, s.pid, d);
  assert.equal(st.state, 'integrity', `${why}: stateOf says integrity`);
  assert.deepEqual(fs.existsSync(s.abs) ? fs.readFileSync(s.abs) : null, before, `${why}: the record is not rebuilt`);
  assert.deepEqual(fs.existsSync(s.ledger) ? fs.readFileSync(s.ledger) : null, ledger, `${why}: the ledger is not rewritten`);
}

test('F3: a one-byte valid-JSON change to a basis (grade 60 → 90) is refused as INTEGRITY, never read as decision-time history', (t) => {
  const s = vetoed(t);
  const v = DB.viewOf(s.ws, s.pid, s.d.decision_id);
  assert.equal(v.label, 'decision_time');
  assert.equal(v.digest, 'verified');
  const was = fs.readFileSync(s.abs);
  const text = was.toString('utf8');
  assert.match(text, /"value": 60/, 'the fixture\'s decision-input grade is on record');
  const edited = Buffer.from(text.replace(/"value": 60/, '"value": 90'), 'utf8');
  assert.equal(diffBytes(was, edited), 1, 'exactly one byte changed');
  JSON.parse(edited.toString('utf8'));
  fs.writeFileSync(s.abs, edited);
  assertRefused(s, s.d, /does not match its recorded SHA-256/, 'one byte');
  fs.writeFileSync(s.abs, was);
  assert.equal(DB.viewOf(s.ws, s.pid, s.d.decision_id).label, 'decision_time', 'restored, it verifies again');
});

test('F3: a swapped identity (another decision\'s basis given this one\'s identity), a removed verification field and a malformed or missing record are each refused', (t) => {
  const s = vetoed(t);
  const u = T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'undo', by: 'eric' }).result.decision;
  const uAbs = s.ws.abs(DB.basisRel(s.pid, u.decision_id));
  const was = fs.readFileSync(s.abs);
  const veto = JSON.parse(was.toString('utf8'));
  const undo = JSON.parse(fs.readFileSync(uAbs, 'utf8'));
  // The undo's research vector under the veto's identity: valid JSON, every identity field right.
  const swapped = { ...undo, decision_id: veto.decision_id, decided_at: veto.decided_at, action: veto.action, receipt_id: veto.receipt_id, project_id: veto.project_id };
  assert.deepEqual(DB.identityProblems(swapped, s.d), [], 'the identity contract alone would accept it');
  const cases = [
    ['swapped identity', JSON.stringify(swapped, null, 2) + '\n', /does not match its recorded SHA-256/],
    ['digest declaration removed', JSON.stringify((({ digest_ledger, ...rest }) => rest)(veto), null, 2) + '\n', /does not match its recorded SHA-256/],
    ['receipt digest removed', JSON.stringify((({ receipt_sha256, ...rest }) => rest)(veto), null, 2) + '\n', /does not match its recorded SHA-256/],
    ['malformed', `${was.toString('utf8')}x`, /does not match its recorded SHA-256/],
  ];
  for (const [why, bytes, re] of cases) {
    fs.writeFileSync(s.abs, bytes);
    assertRefused(s, s.d, re, why);
    fs.writeFileSync(s.abs, was);
  }
  fs.unlinkSync(s.abs);
  assertRefused(s, s.d, /missing, though its digest is on record/, 'missing record');
  fs.writeFileSync(s.abs, was);
  assert.equal(DB.viewOf(s.ws, s.pid, s.d.decision_id).label, 'decision_time');
  assert.equal(DB.viewOf(s.ws, s.pid, u.decision_id).label, 'decision_time');
});

test('F3: the ledger itself: a line changed, removed or malformed, or the whole ledger removed, is refused; nothing reads as unverified history instead', (t) => {
  const s = vetoed(t);
  const u = T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'undo', by: 'eric' }).result.decision;
  const was = fs.readFileSync(s.ledger);
  const lines = was.toString('utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const e0 = JSON.parse(lines[0]);
  assert.deepEqual([e0.seq, e0.decision_id, e0.record_schema, e0.prev_sha256], [1, s.d.decision_id, DB.BASIS_VERSION, null]);
  assert.equal(e0.record_sha256, sha256(fs.readFileSync(s.abs)), 'the digest is of the exact bytes written');
  assert.equal(JSON.parse(lines[1]).prev_sha256, sha256(Buffer.from(lines[0], 'utf8')), 'each line chains to the one before');
  // The basis edited and its digest line rewritten to match: the chain breaks.
  const basisWas = fs.readFileSync(s.abs);
  const forged = Buffer.from(basisWas.toString('utf8').replace(/"value": 60/, '"value": 90'), 'utf8');
  fs.writeFileSync(s.abs, forged);
  fs.writeFileSync(s.ledger, `${JSON.stringify({ ...e0, record_sha256: sha256(forged) })}\n${lines[1]}\n`);
  assertRefused(s, s.d, /line 2 does not follow the line before it/, 'a digest line rewritten');
  fs.writeFileSync(s.abs, basisWas);
  // The veto's line removed: the undo's line no longer chains.
  fs.writeFileSync(s.ledger, `${lines[1]}\n`);
  assertRefused(s, s.d, /line 1 is not a digest line in sequence/, 'a line removed');
  // The undo's (last) line removed: its record declares the ledger.
  fs.writeFileSync(s.ledger, `${lines[0]}\n`);
  assert.throws(() => DB.viewOf(s.ws, s.pid, u.decision_id), INTEGRITY(/is not on record .* the record declares one/), 'the last line removed');
  // A malformed line.
  fs.writeFileSync(s.ledger, `${lines[0]}\n{nope\n`);
  assertRefused(s, s.d, /line 2 does not read/, 'a malformed line');
  // The whole ledger removed: each record declares it.
  fs.unlinkSync(s.ledger);
  assertRefused(s, s.d, /is not on record .* the record declares one/, 'the ledger removed');
  fs.writeFileSync(s.ledger, was);
  assert.equal(DB.viewOf(s.ws, s.pid, s.d.decision_id).label, 'decision_time');
});

test('F3: an unavailable record is verified the same way: a one-byte change to its failure words is refused', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid);
  const real = DB.buildBasis;
  DB.buildBasis = () => { throw new Error('FICTIONAL basis construction failed'); };
  let d;
  try { d = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' }).result.decision; } finally { DB.buildBasis = real; }
  const st = { ...s, abs: s.ws.abs(DB.basisRel(s.pid, d.decision_id)), ledger: s.ws.abs(DB.digestRel(s.pid)) };
  const v = DB.viewOf(s.ws, s.pid, d.decision_id);
  assert.equal(v.label, 'unavailable');
  assert.equal(v.digest, 'verified');
  const was = fs.readFileSync(st.abs);
  const edited = Buffer.from(was.toString('utf8').replace('FICTIONAL basis construction failed', 'FICTIONAL basis construction failez'), 'utf8');
  assert.equal(diffBytes(was, edited), 1);
  fs.writeFileSync(st.abs, edited);
  assertRefused(st, d, /does not match its recorded SHA-256/, 'unavailable record, one byte');
  fs.writeFileSync(st.abs, was);
  assert.equal(DB.viewOf(s.ws, s.pid, d.decision_id).label, 'unavailable');
});

test('F3: a basis from before the ledger reads `unverified` with no digest invented; reading writes nothing; a later decision is verified beside it', (t) => {
  const s = vetoed(t);
  // Make it a record written by the code before this change: no declaration, no ledger.
  const legacy = (({ digest_ledger, ...rest }) => rest)(JSON.parse(fs.readFileSync(s.abs, 'utf8')));
  fs.writeFileSync(s.abs, JSON.stringify(legacy, null, 2) + '\n');
  fs.unlinkSync(s.ledger);
  const bytes = fs.readFileSync(s.abs);
  const v = DB.viewOf(s.ws, s.pid, s.d.decision_id);
  assert.equal(v.label, 'unverified');
  assert.notEqual(v.label, 'decision_time');
  assert.equal(v.digest, 'not_recorded');
  assert.match(v.words, /cannot be checked: it is read as recorded and is not verified decision-time history\. No digest is put in its place\./);
  assert.equal(DB.stateOf(s.ws, s.pid, s.d).state, 'unverified');
  assert.ok(fs.readFileSync(s.abs).equals(bytes), 'the legacy record is not rewritten');
  assert.equal(fs.existsSync(s.ledger), false, 'reading invents no ledger or digest');
  // A later decision gets its digest; the legacy one, decided before it, stays unverified.
  const u = T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'undo', by: 'eric' }).result.decision;
  assert.equal(DB.viewOf(s.ws, s.pid, u.decision_id).label, 'decision_time');
  assert.equal(DB.viewOf(s.ws, s.pid, s.d.decision_id).label, 'unverified');
  const lines = fs.readFileSync(s.ledger, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => JSON.parse(l).decision_id), [u.decision_id], 'no digest is written for the legacy record');
  // A legacy-looking record (no declaration) for a decision after the first digest is refused.
  const uAbs = s.ws.abs(DB.basisRel(s.pid, u.decision_id));
  const uWas = fs.readFileSync(uAbs);
  fs.writeFileSync(s.ledger, '');
  fs.writeFileSync(uAbs, JSON.stringify((({ digest_ledger, ...rest }) => rest)(JSON.parse(uWas.toString('utf8'))), null, 2) + '\n');
  assert.equal(DB.viewOf(s.ws, s.pid, u.decision_id).label, 'unverified', 'with both the ledger emptied and the declaration removed, two records changed: said unverified, never verified');
});

test('F3: a ledger that does not read never holds back Eric\'s stop; the stop\'s line still chains to the raw line before it; the v1 decision line keeps its bytes', (t) => {
  const s = vetoed(t);
  const decisionsRel = `projects/${s.pid}/tickets/decisions.jsonl`;
  const line0 = fs.readFileSync(s.ws.abs(decisionsRel), 'utf8').split('\n').filter(Boolean)[0];
  assert.deepEqual(Object.keys(JSON.parse(line0)).includes('digest_ledger') || Object.keys(JSON.parse(line0)).includes('basis_sha256'), false, 'the decision line carries no digest');
  fs.appendFileSync(s.ledger, '{nope\n');
  const u = T.decide(s.ws, s.pid, { receipt_id: s.r.receipt_id, action: 'undo', by: 'eric' });
  assert.equal(u.result.status, 'saved', 'the Undo is recorded');
  const lines = fs.readFileSync(s.ledger, 'utf8').split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.decision_id, u.result.decision.decision_id);
  assert.equal(last.prev_sha256, sha256(Buffer.from('{nope', 'utf8')), 'chained to the raw line before it');
  // Its view is refused while the ledger does not read: said, never guessed.
  assert.throws(() => DB.viewOf(s.ws, s.pid, u.result.decision.decision_id), INTEGRITY(/line 2 does not read/));
  // The earlier decision line is byte-identical.
  assert.equal(fs.readFileSync(s.ws.abs(decisionsRel), 'utf8').split('\n').filter(Boolean)[0], line0);
});

test('F3: the CLI\'s tickets basis refuses a one-byte change as INTEGRITY and reads the verified basis otherwise', async (t) => {
  const { run } = require('../cli');
  const s = vetoed(t);
  const ok = await run(['tickets', 'basis', s.pid, s.d.decision_id, '--workspace', s.root]);
  assert.equal(ok.label, 'decision_time');
  assert.equal(ok.digest, 'verified');
  const was = fs.readFileSync(s.abs);
  fs.writeFileSync(s.abs, Buffer.from(was.toString('utf8').replace(/"value": 60/, '"value": 90'), 'utf8'));
  await assert.rejects(run(['tickets', 'basis', s.pid, s.d.decision_id, '--workspace', s.root]), INTEGRITY(/does not match its recorded SHA-256/));
});
