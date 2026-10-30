'use strict';
// Stage 2.2: one admission rule for new research, checked before the lock and
// again inside it (research.createRun). A model with an open job, or with a
// report saved in the last 24 hours, is left out and said; nothing starts when
// no model is left; an unverified identity starts nothing unless Eric allows it.
// Fictional workspaces only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace, addFixtureProject, importAllFixtures } = require('./helpers');
const research = require('../core/research');
const projects = require('../core/projects');

const PID = 'example-payfi-fictional';

function desk(t) {
  const { root, ws, cleanup } = tempWorkspace('admit');
  t.after(cleanup);
  addFixtureProject(ws);
  return { root, ws };
}

test('admission: a model with an open job is left out and said; the others start', (t) => {
  const { ws } = desk(t);
  research.createRun(ws, { project_id: PID, providers: ['claude'] });
  const next = research.createRun(ws, { project_id: PID, providers: ['claude', 'chatgpt'], force_new: true });
  assert.deepEqual(next.run.providers, ['chatgpt']);
  assert.deepEqual(next.skipped.map((s) => [s.provider, s.reason]), [['claude', 'open_job']]);
  assert.match(next.message, /Left out: /);
});

test('admission: when no model is left nothing is written, and the refusal names why', (t) => {
  const { ws } = desk(t);
  research.createRun(ws, { project_id: PID, providers: ['claude'] });
  assert.throws(() => research.createRun(ws, { project_id: PID, providers: ['claude'], force_new: true }), (e) => e.code === 'CONFLICT' && /Claude already has an open job/.test(e.message));
  assert.equal(research.listRuns(ws, PID).length, 1);
});

test('admission: a report saved in the last 24 hours is left out unless a refresh is asked', (t) => {
  const { ws } = desk(t);
  importAllFixtures(ws);
  assert.throws(() => research.createRun(ws, { project_id: PID, providers: ['claude'] }), (e) => e.code === 'CONFLICT');
  assert.equal(research.listRuns(ws, PID).length, 0);
  const asked = research.createRun(ws, { project_id: PID, providers: ['claude'], refresh: true });
  assert.equal(asked.status, 'created');
});

test('admission: an unverified identity starts nothing, unless Eric allows a pending identity', (t) => {
  const { ws } = desk(t);
  const p = projects.addProject(ws, { name: 'Pending Coin (FICTIONAL)', symbol: 'PEND' });
  assert.throws(() => research.createRun(ws, { project_id: p.project_id, providers: ['claude'] }), (e) => e.code === 'INVALID' && /identity/.test(e.message));
  assert.equal(research.listRuns(ws, p.project_id).length, 0);
  const allowed = research.createRun(ws, { project_id: p.project_id, providers: ['claude'], allow_pending_identity: true });
  assert.equal(allowed.status, 'created');
});

// Four processes pass the check before the lock at once; the check inside it
// answers the others, so exactly one run is made.
test('createRun: four processes started together make exactly one run', (t) => {
  const cp = require('child_process');
  const { root, ws } = desk(t);
  const go = Date.now() + 1500;
  const script = `const R=require(${JSON.stringify(require.resolve('../core/research'))});const ws=require(${JSON.stringify(require.resolve('../core/workspace'))}).openWorkspace({root:process.argv[1],actor:'race'});while(Date.now()<${go});try{const r=R.createRun(ws,{project_id:process.argv[2],providers:['claude'],force_new:true});process.stdout.write(JSON.stringify({status:r.status,run_id:r.run_id||null}))}catch(e){process.stdout.write(JSON.stringify({error:e.code||e.message}))}`;
  const kids = Array.from({ length: 4 }, () => cp.spawn(process.execPath, ['-e', script, root, PID], { stdio: ['ignore', 'pipe', 'pipe'] }));
  const outs = kids.map((k) => { let o = ''; k.stdout.on('data', (d) => { o += d; }); return new Promise((res) => k.on('close', () => res(o))); });
  return Promise.all(outs).then((texts) => {
    const r = texts.map((x) => JSON.parse(x));
    assert.equal(r.filter((x) => x.status === 'created').length, 1, JSON.stringify(r));
    assert.ok(r.filter((x) => x.status !== 'created').every((x) => x.error === 'CONFLICT'), JSON.stringify(r));
    const runs = research.listRuns(ws, PID);
    assert.equal(runs.length, 1, 'one run on disk');
    assert.equal(fs.readdirSync(ws.abs(`projects/${PID}/research`)).filter((n) => !n.startsWith('.')).length, 1);
  });
});
