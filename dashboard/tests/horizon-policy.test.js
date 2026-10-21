'use strict';
// Eric's position horizon (review of 2026-10-07, finding 5). He usually holds
// a position 3 to 4 months; longer holds are explicit long-term exceptions.
// The policy default said a typical hold was "about 2 months" (position.js
// DEFAULT_POLICY), and every new run's prompt said so and asked the models to
// place catalysts before a date two months in. Now the typical hold is 3 to 4
// months; the 4-month default horizon, the 4-month planning ceiling and the
// long-term exception are unchanged, and so is every run already made: its
// frozen prompt stays byte for byte, and it re-renders identically from its
// own stored horizon. No template, profile or rubric file changes.
// Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const research = require('../core/research');
const pos = require('../core/position');
const prompts = require('../core/prompts');
const { readJson, atomicWrite, jsonText, sha256 } = require('../core/fsx');
const { openWorkspace } = require('../core/workspace');
const { getProject } = require('../core/projects');

const PID = 'example-payfi-fictional';

function workspace(t, label, horizonPolicy = null) {
  const { root, ws, cleanup } = tempWorkspace(label);
  t.after(cleanup);
  if (horizonPolicy) {
    const file = path.join(root, 'config', 'settings.json');
    const s = readJson(file);
    s.research = { ...(s.research || {}), horizon_policy: horizonPolicy };
    atomicWrite(file, jsonText(s));
  }
  const w = horizonPolicy ? openWorkspace({ root, actor: 'test' }) : ws;
  addFixtureProject(w);
  return { root, ws: w };
}

const promptOf = (ws, run) => fs.readFileSync(ws.abs(run.prompt.path), 'utf8');

test('finding 5: a new run says a typical hold is 3 to 4 months inside the 4-month ceiling, with the 4-month default horizon', (t) => {
  const { ws } = workspace(t, 'hz-new');
  const pol = pos.policy(ws);
  assert.deepEqual({ ceiling: pol.planning_ceiling_months, low: pol.typical_hold_months, high: pol.typical_hold_max_months, def: pol.default_months }, { ceiling: 4, low: 3, high: 4, def: 4 });
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  assert.equal(run.horizon.months, 4, 'the default assessment horizon stays 4 months');
  assert.equal(run.horizon.mode, 'position');
  assert.equal(run.horizon.end_date, pos.addCalendarMonths(run.horizon.start_date, 4));
  assert.equal(run.horizon.typical_hold_months, 3);
  assert.equal(run.horizon.typical_hold_max_months, 4);
  const p = promptOf(ws, run);
  assert.equal(run.prompt.version, 'cr-research-prompt@6');
  // The investor context.
  assert.match(p, /- Style: position trading\. A typical hold is about 3 to 4 months, and 4 months is the planning ceiling\./);
  assert.doesNotMatch(p, /about 2 months/);
  // Typical-hold dates and how catalysts are placed against them.
  const three = pos.addCalendarMonths(run.horizon.start_date, 3);
  assert.ok(p.includes(`A typical hold of 3 to 4 months would end between ${three} and the end of this horizon (${run.horizon.end_date}): say which catalysts and supply events fall before ${three}, and which only after it.`), 'the catalyst line names the 3-month date and the horizon end');
  assert.ok(!p.includes(pos.addCalendarMonths(run.horizon.start_date, 2)), 'no two-month cutoff date anywhere');
  assert.equal(sha256(p), run.prompt.sha256);
});

test('finding 5: deliberately chosen horizons are kept: a 3-month run, and a 12-month long-term exception with its reason', (t) => {
  const { ws } = workspace(t, 'hz-chosen');
  const short = research.createRun(ws, { project_id: PID, providers: ['claude'], horizon: '3 months' }).run;
  assert.equal(short.horizon.months, 3);
  assert.equal(short.horizon.mode, 'position');
  const ps = promptOf(ws, short);
  assert.match(ps, /\(3 calendar months; a position horizon inside the 4-month planning ceiling\)/);
  assert.doesNotMatch(ps, /A typical hold of 3 to 4 months would end/, 'a 3-month horizon lies inside every typical hold: no cutoff line');
  const long = research.createRun(ws, { project_id: PID, providers: ['claude'], horizon: '12 months', long_term_reason: 'FICTIONAL: structural thesis', force_new: true }).run;
  assert.equal(long.horizon.months, 12);
  assert.equal(long.horizon.mode, 'long_term');
  assert.equal(long.horizon.exception_reason, 'FICTIONAL: structural thesis');
  const pl = promptOf(ws, long);
  assert.match(pl, /12 calendar months; a long-term exception beyond the 4-month planning ceiling/);
  const a = pos.addCalendarMonths(long.horizon.start_date, 3);
  const b = pos.addCalendarMonths(long.horizon.start_date, 4);
  assert.ok(pl.includes(`A typical hold of 3 to 4 months would end between ${a} and ${b}: say which catalysts and supply events fall before ${a}, which between ${a} and ${b}, and which only later, before the end of the horizon.`));
  assert.match(pl, /This run is a long-term exception the owner chose, for this reason: "FICTIONAL: structural thesis"/);
});

test('finding 5: a typical hold Eric set himself in Settings is kept as he set it', (t) => {
  const { ws } = workspace(t, 'hz-own', { typical_hold_months: 2 });
  const pol = pos.policy(ws);
  assert.equal(pol.typical_hold_months, 2);
  assert.equal(pol.typical_hold_max_months, 2, 'one length, as set');
  const run = research.createRun(ws, { project_id: PID, providers: ['claude'] }).run;
  const p = promptOf(ws, run);
  assert.match(p, /A typical hold is about 2 months, and 4 months is the planning ceiling\./);
  assert.ok(p.includes(`A typical hold would end around ${pos.addCalendarMonths(run.horizon.start_date, 2)}`));
});

test('finding 5: runs made under the old two-month default keep their frozen prompt byte for byte and re-render identically from their own horizon', (t) => {
  const { root, ws } = workspace(t, 'hz-old', { typical_hold_months: 2 });
  const old = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt'] }).run;
  // What an older run stored: one typical length and no upper end.
  assert.equal(old.horizon.typical_hold_months, 2);
  const bytes = fs.readFileSync(ws.abs(old.prompt.path));
  // The policy moves to its new default (the setting removed).
  const file = path.join(root, 'config', 'settings.json');
  const s = readJson(file);
  delete s.research.horizon_policy;
  atomicWrite(file, jsonText(s));
  const now = openWorkspace({ root, actor: 'test' });
  assert.equal(pos.policy(now).typical_hold_months, 3);
  const stored = research.loadRun(now, PID, old.run_id);
  assert.ok(fs.readFileSync(now.abs(stored.prompt.path)).equals(bytes), 'the frozen prompt file is unchanged');
  assert.equal(sha256(fs.readFileSync(now.abs(stored.prompt.path))), stored.prompt.sha256);
  const packet = readJson(now.abs(stored.evidence_packet.path));
  const again = prompts.buildRunPrompt(now, getProject(now, PID), { runId: stored.run_id, horizon: stored.horizon, rubricRef: stored.rubric_version, packet, ownerInstructions: stored.owner_instructions, version: stored.prompt.version, profileRef: stored.sector_profile });
  assert.equal(again, bytes.toString('utf8'), 'rendering from the run\'s own stored horizon reproduces it exactly');
  assert.match(again, /A typical hold is about 2 months/);
  // A run stored before this change has no upper end at all: the same bytes.
  const { typical_hold_max_months: _drop, ...legacy } = stored.horizon;
  const legacyAgain = prompts.buildRunPrompt(now, getProject(now, PID), { runId: stored.run_id, horizon: legacy, rubricRef: stored.rubric_version, packet, ownerInstructions: stored.owner_instructions, version: stored.prompt.version, profileRef: stored.sector_profile });
  assert.equal(legacyAgain, bytes.toString('utf8'));
  // A new run on the same desk gets the new policy.
  const fresh = research.createRun(now, { project_id: PID, providers: ['claude'], force_new: true }).run;
  assert.match(promptOf(now, fresh), /A typical hold is about 3 to 4 months/);
});
