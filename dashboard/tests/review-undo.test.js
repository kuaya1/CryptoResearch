'use strict';
// Mark reviewed and its Undo (core/projects.js markReviewed and
// restoreReview) on a temporary fictional workspace: the review cursor it
// replaced comes back with the result, Undo puts that cursor back only while
// the mark it undoes is still the latest, and nothing else in the record moves.
const test = require('node:test');
const assert = require('node:assert/strict');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const projects = require('../core/projects');

function setup(t) {
  const { ws, cleanup } = tempWorkspace('review-undo');
  t.after(cleanup);
  const id = addFixtureProject(ws).project_id;
  return { ws, id };
}

const strip = (p) => { const { review: _r, updated_at: _u, ...rest } = p; return rest; }; // eslint-disable-line no-unused-vars

test('mark reviewed hands back the cursor it replaced; Undo restores it exactly', (t) => {
  const { ws, id } = setup(t);
  const before = projects.getProject(ws, id);
  const first = projects.markReviewed(ws, id);
  assert.equal(first.verified, true);
  assert.equal(first.result.previous, null, 'never reviewed before: nothing to restore but "never"');
  const afterFirst = projects.getProject(ws, id);
  assert.equal(afterFirst.review.last_reviewed_at, first.result.reviewed_at);
  // Undo the first mark: back to never reviewed.
  const undo = projects.restoreReview(ws, id, { previous: first.result.previous, expect: first.result.reviewed_at });
  assert.equal(undo.verified, true);
  assert.equal(projects.getProject(ws, id).review, null);
  assert.deepEqual(strip(projects.getProject(ws, id)), strip(before), 'nothing else in the record changes');
  // A second pair: the earlier cursor (with its note) comes back as it was.
  projects.markReviewed(ws, id, { note: 'FICTIONAL earlier note' });
  const earlier = projects.getProject(ws, id).review;
  const second = projects.markReviewed(ws, id);
  assert.deepEqual(second.result.previous, earlier);
  projects.restoreReview(ws, id, { previous: second.result.previous, expect: second.result.reviewed_at });
  assert.deepEqual(projects.getProject(ws, id).review, earlier);
});

test('Undo never overrides a later review, and refuses a malformed request', (t) => {
  const { ws, id } = setup(t);
  const first = projects.markReviewed(ws, id);
  // A later review happens before the Undo arrives (a clock tick later).
  const t0 = Date.now();
  while (Date.now() <= t0 + 2) { /* wait for the clock */ }
  const later = projects.markReviewed(ws, id);
  assert.notEqual(later.result.reviewed_at, first.result.reviewed_at);
  assert.throws(() => projects.restoreReview(ws, id, { previous: first.result.previous, expect: first.result.reviewed_at }), (e) => e.code === 'CONFLICT');
  assert.equal(projects.getProject(ws, id).review.last_reviewed_at, later.result.reviewed_at, 'the later review stands');
  assert.throws(() => projects.restoreReview(ws, id, { previous: null, expect: null }), (e) => e.code === 'INVALID');
  assert.throws(() => projects.restoreReview(ws, id, { previous: { last_reviewed_at: '2999-01-01T00:00:00Z' }, expect: later.result.reviewed_at }), (e) => e.code === 'INVALID', 'an "earlier" cursor after the mark it undoes');
  assert.throws(() => projects.restoreReview(ws, id, { previous: ['x'], expect: later.result.reviewed_at }), (e) => e.code === 'INVALID');
});
