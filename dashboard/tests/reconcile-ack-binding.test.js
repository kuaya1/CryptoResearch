'use strict';
// N3 (post-remediation audit, 2026-11-02): Preferences > Desk controls kept
// Eric's "I checked the desk for attempt …" acknowledgement under the project
// alone (DeskControls.jsx `checked[p.project_id]`). When the view was read
// again and showed another attempt B, the box stayed ticked and "Release as
// reconciled" was enabled for B, which Eric never checked; the click posted
// B (audit F4 binds the release to the attempt shown, so the server accepted
// it as the attempt shown).
//
// Now the acknowledgement is kept under the project AND the attempt
// (desk-controls-model.js ackKey), every read of the view drops the ones it no
// longer offers (pruneAcks), and the checkbox and the button both read one
// rule (reconcileControl). The panel's props here are the view it reads,
// /api/desk/controls (cr-desk-controls@1), FICTIONAL. CI runs no browser, so
// the component's binding to the rule is checked in its source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const loadModel = () => import('../public/desk-controls-model.js');
const PID = 'example-pilot-fictional';

// The view the panel reads, with one pilot project whose claim is expired
// (attempt `attempt`), or none to reconcile (attempt null).
function view(attempt, { available = attempt !== null } = {}) {
  return {
    format: 'cr-desk-controls@1',
    at: '2026-11-02T12:00:00.000Z',
    controls: {},
    projects: [{
      project_id: PID,
      name: 'Example (FICTIONAL)',
      next_step: 'Check the desk, then release it as reconciled.',
      dispatch: { state: attempt ? 'expired' : 'none', attempt_id: attempt },
      controls: {
        stop: { available: true },
        reconcile: { available, method: 'POST', path: `/api/projects/${PID}/pilot-claim/release`, body: { reconciled: true, attempt_id: attempt }, attempt_id: attempt },
      },
    }],
  };
}

// What the panel draws for the project, as the component computes it: the
// acknowledgements pruned by each read, then the one rule.
function panel(M, checked, v, busy = null) {
  const kept = M.pruneAcks(checked, v);
  const p = v.projects[0];
  return { checked: kept, ...M.reconcileControl(kept, p.project_id, p.controls.reconcile, busy) };
}
const tick = (M, checked, v) => {
  const p = v.projects[0];
  const k = M.reconcileControl(checked, p.project_id, p.controls.reconcile).key;
  assert.ok(k, 'the shown attempt has a key to tick');
  return { ...checked, [k]: true };
};

test('N3: a view that refreshes to a new attempt clears Eric\'s check and disables Release until he checks again', async () => {
  const M = await loadModel();
  // Attempt A shown; nothing checked yet: Release is disabled.
  const vA = view('att_A_fictional');
  let s = panel(M, {}, vA);
  assert.deepEqual([s.acknowledged, s.enabled], [false, false]);
  // Eric checks A: Release is enabled for A, and posts A.
  s = panel(M, tick(M, s.checked, vA), vA);
  assert.deepEqual([s.acknowledged, s.enabled], [true, true]);
  assert.equal(s.key, `${PID}:att_A_fictional`);
  assert.deepEqual(M.reconcileBody(vA.projects[0].controls.reconcile), { reconciled: true, attempt_id: 'att_A_fictional' });

  // The view is read again and now shows attempt B: the check is gone and
  // Release is disabled, at once.
  const vB = view('att_B_fictional');
  s = panel(M, s.checked, vB);
  assert.equal(s.acknowledged, false, 'the box reads clear for attempt B');
  assert.equal(s.enabled, false, 'Release is disabled for attempt B');
  assert.deepEqual(s.checked, {}, 'A\'s acknowledgement is dropped');
  // Only Eric's own check of B enables it again.
  s = panel(M, tick(M, s.checked, vB), vB);
  assert.deepEqual([s.acknowledged, s.enabled, s.key], [true, true, `${PID}:att_B_fictional`]);

  // A, gone and back, is not checked: every read drops what it no longer offers.
  s = panel(M, s.checked, vA);
  assert.deepEqual([s.acknowledged, s.enabled], [false, false]);
});

test('N3: no attempt shown, or none offered to reconcile, means nothing to acknowledge and Release disabled', async () => {
  const M = await loadModel();
  const checkedA = { [`${PID}:att_A_fictional`]: true };
  for (const [what, v] of [['no attempt', view(null)], ['not offered', view('att_A_fictional', { available: false })], ['empty attempt', view('')]]) {
    const s = panel(M, checkedA, v);
    assert.equal(s.key, null, `${what}: no key`);
    assert.deepEqual([s.acknowledged, s.enabled], [false, false], what);
    assert.deepEqual(s.checked, {}, `${what}: the old check is dropped`);
  }
  // The project-only key the panel used before never enables anything.
  const s = panel(M, { [PID]: true }, view('att_A_fictional'));
  assert.deepEqual([s.acknowledged, s.enabled], [false, false], 'a check kept under the project alone is not a check of this attempt');
  // Busy disables it even when checked.
  const vA = view('att_A_fictional');
  const busy = panel(M, tick(M, {}, vA), vA, `${PID}:stop`);
  assert.deepEqual([busy.acknowledged, busy.enabled], [true, false]);
  // Two projects keep their checks apart.
  assert.equal(M.ackKey('p1', { available: true, attempt_id: 'x' }) === M.ackKey('p2', { available: true, attempt_id: 'x' }), false);
});

test('N3: the panel draws the checkbox and Release from that one rule, and prunes on every read', () => {
  const src = fs.readFileSync(path.join(__dirname, '../web/src/shell/DeskControls.jsx'), 'utf8');
  assert.doesNotMatch(src, /checked\[p\.project_id\]/, 'no acknowledgement is read under the project alone');
  assert.doesNotMatch(src, /\[projectId\]:\s*false/, 'none is written under the project alone');
  assert.match(src, /const ack = reconcileControl\(checked, p\.project_id, rc, busy\);/);
  assert.match(src, /<input type="checkbox" checked=\{ack\.acknowledged\}/, 'the box reads the rule');
  assert.match(src, /setChecked\(\(x\) => \(\{ \.\.\.x, \[k\]: e\.target\.checked \}\)\)/, 'a tick is kept under the attempt\'s key');
  assert.match(src, /disabled=\{!ack\.enabled\}/, 'Release reads the rule');
  assert.match(src, /setChecked\(\(x\) => pruneAcks\(x, got\)\);\s*setV\(got\);/, 'each read prunes before it is drawn');
  assert.match(src, /if \(!body \|\| !reconcileControl\(checked, projectId, rc\)\.acknowledged\) throw/, 'the click itself refuses an attempt not checked');
});
