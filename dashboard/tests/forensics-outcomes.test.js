'use strict';
// The outcome learning register (cr-forensic-outcome-register@1): frozen
// conditional estimates beside what was observed, with coverage deciding
// whether a row can be read at all. Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, hashTree } = require('./helpers');
const F = require('../core/forensics');
const O = require('../core/forensic-outcomes');
const FX = require('./forensic-fixtures');

const DAY = 86400000;
const at = (ms) => new Date(ms).toISOString();
const CG = 'example-payfi-fictional';

// Daily CoinGecko volume lines at absolute times (FICTIONAL).
function storeAt(ws, points) {
  fs.mkdirSync(ws.abs('market-data/observations'), { recursive: true });
  for (const { t, v } of points) {
    const line = { fetched_at: at(t), provider: 'fictional', trigger: 'test', assets: [{ id: CG, source_last_updated_at: at(t), price_usd: 1, volume_24h_usd: v }] };
    fs.appendFileSync(ws.abs(`market-data/observations/${at(t).slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`);
  }
}

// Thirty days of volume falling 2% a day before the origin, so the frozen
// deterioration case crosses the review level inside the horizon.
function registerSetup(label) {
  const t = tempWorkspace(label);
  const pid = addFixtureProject(t.ws).project_id;
  const today = Date.parse(`${at(Date.now()).slice(0, 10)}T12:00:00Z`);
  storeAt(t.ws, Array.from({ length: 30 }, (_, i) => ({ t: today - (30 - i) * DAY, v: Math.round(1000 * 0.98 ** i) })));
  const a = F.createAudit(t.ws, { project_id: pid, assistant: 'claude' });
  const s = F.saveReport(t.ws, { project_id: pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a.audit) });
  const o = Date.parse(s.receipt.origin);
  const est = s.receipt.scenarios_at_origin.volume;
  return { ...t, pid, s, o, est };
}

const rowOf = (v, metric, kind) => v.outcomes.items[0].rows.find((r) => r.metric === metric && r.kind === kind);

test('register: frozen estimates beside the observed crossing; by date, without a date, and not due are told apart', (t) => {
  const x = registerSetup('fo-reg');
  t.after(x.cleanup);
  assert.equal(x.est.status, 'estimated', JSON.stringify(x.est.words || x.est));
  const det = x.est.scenarios.find((s) => s.kind === 'deterioration');
  assert.ok(det.crosses_at && det.within_horizon, 'the fixture projects a dated crossing');
  const due = Date.parse(`${det.crosses_at}T12:00:00Z`);
  // Observed: below the level from the first day after the origin.
  storeAt(x.ws, Array.from({ length: Math.round((due - x.o) / DAY) + 4 }, (_, i) => ({ t: x.o + (i + 1) * DAY, v: Math.round(x.est.threshold * 0.6) })));
  const frozenBefore = JSON.stringify(F.loadReceipt(x.ws, x.pid, x.s.receipt_id).scenarios_at_origin);
  const before = hashTree(path.join(x.root, 'projects'));
  // Before the conditional date: not due.
  const early = F.view(x.ws, x.pid, { now: x.o + 3 * DAY });
  assert.equal(rowOf(early, 'volume', 'deterioration').evaluation.state, 'not_due');
  // After it.
  const v = F.view(x.ws, x.pid, { now: due + 3 * DAY });
  assert.deepEqual(hashTree(path.join(x.root, 'projects')), before, 'reading the register writes nothing');
  const d = rowOf(v, 'volume', 'deterioration');
  assert.equal(d.frozen.crosses_at, det.crosses_at, 'the frozen date, never recomputed');
  assert.equal(d.frozen.words, det.words);
  assert.equal(d.frozen.threshold, x.est.threshold);
  assert.equal(d.observed.evaluable, true);
  assert.equal(d.evaluation.state, 'crossed_by_date');
  assert.match(d.evaluation.words, /by the conditional date/);
  const st = rowOf(v, 'volume', 'stabilization');
  assert.equal(st.frozen.crosses_at, null);
  assert.equal(st.evaluation.state, 'crossed_without_date', 'a crossing the assumption did not project is said as such, not as a miss or a hit');
  assert.equal(JSON.stringify(F.loadReceipt(x.ws, x.pid, x.s.receipt_id).scenarios_at_origin), frozenBefore, 'the frozen estimates are untouched');
  assert.equal(v.outcomes.items[0].origin, x.s.receipt.origin, 'the origin is never reset');
  // No probability, calibration, ranking or accuracy figure anywhere.
  const text = JSON.stringify(v.outcomes);
  assert.ok(!/"(probability|probabilities|accuracy|calibration|hit_rate|rank|ranking|score)"/.test(text), 'no such field');
  assert.ok(!/accuracy of|hit rate|\d+% (right|correct|accurate)/i.test(text));
  assert.match(v.outcomes.meaning, /not a prediction/);
  assert.equal(v.outcomes.tally[0].version, 'cr-forensic-scenarios@3', 'counted per scenarios version, never pooled');
  assert.ok(v.outcomes.tally[0].evaluable >= 1);
  assert.deepEqual(v.outcomes.episodes.liquidity_impairment, v.states.liquidity.episodes, 'every episode on record, as the state holds it');
});

test('register: a gap in the readings or readings that start late make a row unevaluable, never a success', (t) => {
  const x = registerSetup('fo-gap');
  t.after(x.cleanup);
  const det = x.est.scenarios.find((s) => s.kind === 'deterioration');
  const due = Date.parse(`${det.crosses_at}T12:00:00Z`);
  // Readings above the level, with a five-day hole after the first two days.
  const days = Math.round((due - x.o) / DAY) + 2;
  storeAt(x.ws, Array.from({ length: days }, (_, i) => i + 1).filter((d) => d <= 2 || d > 7).map((d) => ({ t: x.o + d * DAY, v: Math.round(x.est.threshold * 3) })));
  const v = F.view(x.ws, x.pid, { now: due + 3 * DAY });
  const d = rowOf(v, 'volume', 'deterioration');
  assert.equal(d.evaluation.state, 'unevaluable');
  assert.match(d.evaluation.words, /gap of 6 days without a usable reading \(at most 2 allowed\)/, 'days 3 to 7 missing: six days from one reading to the next');
  // No reading at all after the origin.
  const y = registerSetup('fo-none');
  t.after(y.cleanup);
  const dy = y.est.scenarios.find((s) => s.kind === 'deterioration');
  const vy = F.view(y.ws, y.pid, { now: Date.parse(`${dy.crosses_at}T12:00:00Z`) + 3 * DAY });
  assert.equal(rowOf(vy, 'volume', 'deterioration').evaluation.state, 'unevaluable');
  assert.ok(vy.outcomes.tally[0].unevaluable >= 1);
});

test('register: methods are kept apart line by line; corrections follow what they correct', (t) => {
  const x = registerSetup('fo-methods');
  t.after(x.cleanup);
  // A line recorded under method@1 and its method@3 correction (FICTIONAL),
  // where the desk keeps them.
  const file = x.ws.abs(`${F.dirOf(x.pid)}/resolutions/${x.s.receipt_id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cp = x.s.receipt.deadlines[0];
  const l1 = { schema_version: 'cr.forensic-resolution.v1', entry_id: 'rs_fictional00001', receipt_id: x.s.receipt_id, checkpoint: cp.id, deadline: cp.at, event: 'liquidity_impairment', outcome: 'occurred', recorded_at: at(x.o + DAY), corrects: null };
  const l2 = { ...l1, entry_id: 'rs_fictional00002', method: 'cr-forensic-method@3', outcome: 'not_established', corrects: 'rs_fictional00001', previous_method: 'cr-forensic-method@1', reason: 'Re-read (FICTIONAL).', recorded_at: at(x.o + 2 * DAY) };
  fs.appendFileSync(file, `${JSON.stringify(l1)}\n${JSON.stringify(l2)}\n`);
  assert.equal(F.resolutionsOf(x.ws, x.pid, x.s.receipt_id).length, 2);
  const v = F.view(x.ws, x.pid, { now: Date.parse(cp.at) + DAY });
  const item = v.outcomes.items[0];
  const ev = item.checkpoints.find((c) => c.checkpoint === cp.id).events.find((e) => e.event === 'liquidity_impairment');
  assert.deepEqual(ev.lines.map((l) => [l.outcome, l.method]), [['occurred', 'cr-forensic-method@1'], ['not_established', 'cr-forensic-method@3']], 'each line under its own method, never pooled into one outcome');
  assert.equal(ev.lines[1].corrects, 'rs_fictional00001');
  assert.equal(ev.lines[1].previous_method, 'cr-forensic-method@1');
  assert.deepEqual(item.methods_recorded.slice().sort(), ['cr-forensic-method@1', 'cr-forensic-method@3']);
  assert.equal(F.resolutionsOf(x.ws, x.pid, x.s.receipt_id)[0].outcome, 'occurred', 'the corrected line stays on record');
});

test('register: Eric\'s interpretation is a note of his, append-only and replay-safe, and changes no evaluation', (t) => {
  const x = registerSetup('fo-notes');
  t.after(x.cleanup);
  const det = x.est.scenarios.find((s) => s.kind === 'deterioration');
  const now = Date.parse(`${det.crosses_at}T12:00:00Z`) + 3 * DAY;
  const row = rowOf(F.view(x.ws, x.pid, { now }), 'volume', 'deterioration');
  assert.throws(() => O.addNote(x.ws, x.pid, { receipt_id: x.s.receipt_id, row_id: 'or_bad', note: 'A note (FICTIONAL).' }), (e) => e.code === 'INVALID');
  assert.throws(() => O.addNote(x.ws, x.pid, { receipt_id: x.s.receipt_id, row_id: row.row_id, note: '' }), (e) => e.code === 'INVALID');
  const n1 = O.addNote(x.ws, x.pid, { receipt_id: x.s.receipt_id, row_id: row.row_id, note: 'A listing ended that week (FICTIONAL).', request_id: 'req-fictional-on-1' });
  assert.equal(n1.result.status, 'saved');
  assert.equal(O.addNote(x.ws, x.pid, { receipt_id: x.s.receipt_id, row_id: row.row_id, note: 'A listing ended that week (FICTIONAL).', request_id: 'req-fictional-on-1' }).result.status, 'unchanged');
  assert.equal(O.addNote(x.ws, x.pid, { receipt_id: x.s.receipt_id, row_id: row.row_id, note: 'A listing ended that week (FICTIONAL).', request_id: 'req-fictional-on-2' }).result.status, 'unchanged');
  O.addNote(x.ws, x.pid, { receipt_id: x.s.receipt_id, row_id: row.row_id, note: 'On reflection, two listings ended (FICTIONAL).' });
  const after = rowOf(F.view(x.ws, x.pid, { now }), 'volume', 'deterioration');
  assert.equal(after.owner.note, 'On reflection, two listings ended (FICTIONAL).');
  assert.equal(after.owner.history.length, 2);
  assert.deepEqual(after.evaluation, { ...row.evaluation }, 'a note changes no evaluation');
  assert.equal(O.readNotes(x.ws, x.pid).length, 2);
  assert.match(O.readNotes(x.ws, x.pid)[0].meaning, /not an observed outcome/);
  const proj = require('../core/exporter').exportJson(x.ws).projects.find((p) => p.project.project_id === x.pid);
  assert.equal(proj.forensics.outcome_notes.length, 2);
});
