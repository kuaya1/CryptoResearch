'use strict';
// Audit F7 (2026-11-02): a report original whose SHA-256 is missing, null,
// malformed or mismatched must never be skipped and still read as verified
// decision-time history. A digest the decision recorded is checked; one it
// should hold and does not is INTEGRITY; a report that genuinely carried no
// digest when the decision was made reads `unverified`, said by name, with no
// digest put in its place. FICTIONAL temporary workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const T = require('../core/tickets');
const DB = require('../core/decision-basis');
const { loadReports } = require('../core/reports');
const { sha256 } = require('../core/fsx');
const { mandateDesk, saveTicket } = require('./mandate-fixture');

const veto = (ws, pid, r) => T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' }).result.decision;
const metaFile = (ws, rep) => ws.abs(`${rep.dir}/meta.json`);
const originalFile = (ws, rep) => ws.abs(`${rep.dir}/${rep.meta.original_file}`);
const reportOf = (ws, pid, id) => loadReports(ws, pid).find((x) => x.report_id === id);
// The report's metadata without its digest, as a report imported before the
// desk recorded one (or with it removed) reads.
function dropDigest(ws, rep) {
  const meta = JSON.parse(fs.readFileSync(metaFile(ws, rep), 'utf8'));
  delete meta.original_sha256;
  fs.writeFileSync(metaFile(ws, rep), `${JSON.stringify(meta, null, 2)}\n`);
}
const refused = (re) => (e) => e.code === 'INTEGRITY' && re.test(e.message);
// Every file a read could touch, by SHA-256: the view writes nothing.
function tree(ws, pid) {
  const out = {};
  const walk = (rel) => {
    for (const n of fs.readdirSync(ws.abs(rel), { withFileTypes: true })) {
      const p = `${rel}/${n.name}`;
      if (n.isDirectory()) walk(p); else out[p] = sha256(fs.readFileSync(ws.abs(p)));
    }
  };
  walk(`projects/${pid}`);
  return out;
}
function editBasis(ws, pid, d, fn) {
  const file = ws.abs(DB.basisRel(pid, d.decision_id));
  const was = fs.readFileSync(file);
  const rec = JSON.parse(was.toString('utf8'));
  fn(rec);
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return () => fs.writeFileSync(file, was);
}

test('the audit\'s case: the decision input\'s digest removed before the decision, then its original changed, is refused, never decision_time', (t) => {
  const { ws, pid } = mandateDesk(t, { grade: 60 });
  const r = saveTicket(ws, pid);
  const input = reportOf(ws, pid, r.researcher.report_id);
  const packet = JSON.parse(fs.readFileSync(ws.abs(r.packet.path), 'utf8'));
  assert.equal(packet.researcher.report_id, input.report_id);
  assert.match(packet.researcher.original_sha256, /^[0-9a-f]{64}$/, 'the receipt\'s frozen packet holds the input\'s digest from when the ticket was opened');
  dropDigest(ws, input);
  const d = veto(ws, pid, r);
  const basis = JSON.parse(fs.readFileSync(ws.abs(DB.basisRel(pid, d.decision_id)), 'utf8'));
  assert.equal(basis.research[0].use, 'decision_input');
  assert.equal(basis.research[0].original_sha256, null, 'the basis records what the report carried then: no digest');
  // Intact, it is checked against the digest the verified packet froze.
  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.equal(v.label, 'decision_time');
  assert.deepEqual(v.originals.find((o) => o.report_id === input.report_id), { report_id: input.report_id, use: 'decision_input', digest: 'verified', against: 'packet' });
  // The original changed: refused, named, nothing rebuilt.
  const file = originalFile(ws, input);
  fs.appendFileSync(file, '\nFICTIONAL edit after the decision');
  const before = tree(ws, pid);
  assert.throws(() => DB.viewOf(ws, pid, d.decision_id), refused(new RegExp(`The original of report ${input.report_id} does not match its recorded SHA-256`)));
  assert.deepEqual(tree(ws, pid), before, 'the refusal writes nothing');
});

test('a context report that carried no digest at the decision reads `unverified` by name, with no digest put in its place, even after its original changes', (t) => {
  const { ws, pid } = mandateDesk(t, { grade: 60 });
  const r = saveTicket(ws, pid);
  const ctx = loadReports(ws, pid).find((x) => !x.broken && x.meta.provider === 'chatgpt');
  assert.ok(ctx, 'the fixtures hold a ChatGPT report');
  dropDigest(ws, ctx);
  const d = veto(ws, pid, r);
  const entry = JSON.parse(fs.readFileSync(ws.abs(DB.basisRel(pid, d.decision_id)), 'utf8')).research.find((e) => e.report_id === ctx.report_id);
  assert.equal(entry.use, 'available_context');
  assert.equal(entry.original_sha256, null);
  const before = tree(ws, pid);
  const v = DB.viewOf(ws, pid, d.decision_id);
  assert.equal(v.label, 'unverified');
  assert.notEqual(v.label, 'decision_time');
  assert.match(v.words, new RegExp(`report ${ctx.report_id} \\(chatgpt\\) carried no SHA-256 when this decision was made`));
  assert.match(v.words, /not verified decision-time history\. No digest is put in its place\./);
  assert.deepEqual(v.originals.find((o) => o.report_id === ctx.report_id), { report_id: ctx.report_id, use: 'available_context', digest: 'not_recorded' });
  assert.equal(v.basis.research.find((e) => e.report_id === ctx.report_id).original_sha256, null, 'the view shows the basis as recorded; no current digest is substituted');
  // The decision input is still checked.
  assert.equal(v.originals.find((o) => o.use === 'decision_input').digest, 'verified');
  // Its original changed: still unverified, never decision_time.
  fs.appendFileSync(originalFile(ws, ctx), '\nFICTIONAL edit');
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'unverified');
  // The original gone: refused.
  const was = fs.readFileSync(originalFile(ws, ctx));
  fs.unlinkSync(originalFile(ws, ctx));
  assert.throws(() => DB.viewOf(ws, pid, d.decision_id), refused(new RegExp(`The original of report ${ctx.report_id} is missing`)));
  fs.writeFileSync(originalFile(ws, ctx), was);
  // Reading wrote nothing, and no digest was added to the report.
  assert.ok(!('original_sha256' in JSON.parse(fs.readFileSync(metaFile(ws, ctx), 'utf8'))), 'no digest is invented for the report');
  delete before[`${ctx.dir}/${ctx.meta.original_file}`];
  const after = tree(ws, pid);
  delete after[`${ctx.dir}/${ctx.meta.original_file}`];
  assert.deepEqual(after, before);
});

test('a digest the basis must hold that is removed, malformed or mismatched is INTEGRITY, never a skipped check', (t) => {
  const { ws, pid } = mandateDesk(t, { grade: 60 });
  const r = saveTicket(ws, pid);
  const d = veto(ws, pid, r);
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'decision_time');
  const cases = [
    ['an original\'s digest removed', (b) => { delete b.research[0].original_sha256; }, /The original of report \S+ has no SHA-256 in the basis \(original_sha256\)/],
    ['an original\'s digest malformed', (b) => { b.research[0].original_sha256 = 'abc123'; }, /The original of report \S+ has a recorded SHA-256 that is not one \(original_sha256\)/],
    ['an original\'s digest in capitals', (b) => { b.research[0].original_sha256 = b.research[0].original_sha256.toUpperCase(); }, /is not one \(original_sha256\)/],
    ['an original\'s digest another file\'s', (b) => { b.research[0].original_sha256 = 'a'.repeat(64); }, /The original of report \S+ does not match its recorded SHA-256/],
    ['the packet\'s digest null', (b) => { b.packet_sha256 = null; }, /The frozen ticket packet has a null SHA-256 in the basis \(packet_sha256\)/],
    ['the packet\'s digest removed', (b) => { delete b.packet_sha256; }, /The frozen ticket packet has no SHA-256 in the basis \(packet_sha256\)/],
    ['the packet\'s digest not its receipt\'s', (b) => { b.packet_sha256 = 'b'.repeat(64); }, /The frozen ticket packet's SHA-256 in the basis is not the one its receipt records/],
    ['the Prosecutor text\'s digest malformed', (b) => { b.text_sha256 = 'zz'; }, /The Prosecutor's saved text has a recorded SHA-256 that is not one \(text_sha256\)/],
    ['the Prosecutor text\'s digest null', (b) => { b.text_sha256 = null; }, /The Prosecutor's saved text has a null SHA-256 in the basis \(text_sha256\)/],
  ];
  for (const [what, fn, re] of cases) {
    const restore = editBasis(ws, pid, d, fn);
    const before = tree(ws, pid);
    assert.throws(() => DB.viewOf(ws, pid, d.decision_id), refused(re), what);
    assert.deepEqual(tree(ws, pid), before, `${what}: nothing written`);
    restore();
  }
  assert.equal(DB.viewOf(ws, pid, d.decision_id).label, 'decision_time', 'restored, it reads again');
});

test('the public entry points: `tickets basis` says unverified for a hashless context report and refuses the audit\'s case', async (t) => {
  const { run } = require('../cli');
  const { ws, pid, root } = mandateDesk(t, { grade: 60 });
  const r = saveTicket(ws, pid);
  const ctx = loadReports(ws, pid).find((x) => !x.broken && x.meta.provider === 'chatgpt');
  dropDigest(ws, ctx);
  const input = reportOf(ws, pid, r.researcher.report_id);
  dropDigest(ws, input);
  const d = veto(ws, pid, r);
  const out = await run(['tickets', 'basis', pid, d.decision_id, '--json', '--workspace', root]);
  assert.equal(out.label, 'unverified');
  assert.equal(out.originals.find((o) => o.report_id === ctx.report_id).digest, 'not_recorded');
  fs.appendFileSync(originalFile(ws, input), '\nFICTIONAL edit');
  await assert.rejects(run(['tickets', 'basis', pid, d.decision_id, '--json', '--workspace', root]), (e) => e.code === 'INTEGRITY' && new RegExp(`The original of report ${input.report_id}`).test(e.message));
});

test('the attribution view counts a basis that is not verified apart from decision-time ones', (t) => {
  const GO = require('../core/grade-outcome-view');
  const { ws, pid } = mandateDesk(t, { grade: 60 });
  const r = saveTicket(ws, pid);
  const ctx = loadReports(ws, pid).find((x) => !x.broken && x.meta.provider === 'chatgpt');
  dropDigest(ws, ctx);
  const d = T.decide(ws, pid, { receipt_id: r.receipt_id, action: 'approve', by: 'eric' }).result.decision;
  assert.ok(d, 'a grant');
  const v = GO.view(ws, { now: new Date().toISOString() });
  assert.equal(v.denominators.decisions_granted, 1);
  assert.deepEqual(v.denominators.basis, { decision_time: 0, unverified: 1, reconstructed: 0, refused: 0 });
});
