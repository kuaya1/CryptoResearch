'use strict';
// The test control for the server's own background work
// (tests/server-background.js). Temporary FICTIONAL workspaces only; a real
// local server on 127.0.0.1; no network beyond it.
//
// The rules under test:
// - With the hold, the job runs the server's start-up timers lead to write
//   nothing: logs/jobs-state.json is not created by them. And a change notice
//   from the server's watcher is kept and schedules nothing.
// - Without it (the server started as production starts it), the same timer
//   writes that file, and the same change notice schedules the index rebuild
//   (and, for the inbox, the inbox jobs again). Those are the writes two
//   tests were racing.
// - Only that background work is held. A job run that is not the server's
//   own timer, on the same workspace, runs and writes as always.
// - Nothing is left changed: the timers, the watcher and the jobs module are
//   restored.
// Every wait here is for the event itself; nothing sleeps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jobs = require('../core/jobs');
const { PROVIDERS } = require('../core/workspace');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const { startWithBackgroundHeld, HELD_WORDS } = require('./server-background');

function tree(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
const port = () => 48600 + Math.floor(Math.random() * 300);
const STATE = 'logs/jobs-state.json';
// A report landing in the inbox, and a project record changing, as the
// operating system names them to a watcher on the workspace.
const INBOX_FILE = path.join('inbox', PROVIDERS[0], 'a-new-report.md');
const PROJECT_FILE = path.join('projects', 'example-payfi-fictional', 'project.json');

// Runs `starting` and keeps the callback it hands the operating system's
// watcher, so a test can deliver a change notice itself, exactly as the
// system would, instead of waiting for one.
// The server's watcher is its one RECURSIVE watch on the workspace root
// (`root`): `asked` is the folder of every recursive watch `starting` asked
// for, and `given` the callback of each one on `root`. Every call goes on to
// the real fs.watch, whatever it is for. Where the operating system has no
// recursive watch (Linux), Node makes one from nonrecursive watches, one on
// the root itself and one on each file and folder under it, and asks for each
// through fs.watch as it is then, so they pass through here too. The folder
// alone therefore does not tell the server's call from Node's own.
// `left` is what fs.watch was the moment `starting` had finished, before this
// puts the real one back: it must be `recorder`, the one `starting` found.
async function watching(root, starting) {
  const realWatch = fs.watch;
  const at = path.resolve(root);
  const asked = [];
  const given = [];
  const recorder = (...a) => {
    const [dir, options] = a;
    if (options !== null && typeof options === 'object' && options.recursive === true) {
      const folder = typeof dir === 'string' ? path.resolve(dir) : dir;
      asked.push(folder);
      if (folder === at) given.push(a.find((x) => typeof x === 'function'));
    }
    return realWatch(...a);
  };
  fs.watch = recorder;
  try {
    const out = await starting();
    return { out, at, asked, given, recorder, left: fs.watch };
  } finally { fs.watch = realWatch; }
}
// The delays of the timers `fn` sets, with none of them started.
function timersSetBy(fn) {
  const real = global.setTimeout;
  const delays = [];
  global.setTimeout = (f, ms) => { delays.push(ms); const h = real(() => {}, 0); clearTimeout(h); return h; };
  try { fn(); } finally { global.setTimeout = real; }
  return delays;
}

test('held: the server\'s 200 ms start-up jobs fire, are held, and write nothing; a change notice from its watcher is held and schedules nothing; the timers, the watcher and the jobs module are as they were', async (t) => {
  const w = tempWorkspace('server-background');
  t.after(w.cleanup);
  addFixtureProject(w.ws);
  const before = [global.setTimeout, global.setInterval, fs.watch];
  // A start-up job run that is NOT held reaches the jobs module itself: said at once, so a broken hold fails here instead of waiting for a held run that never comes.
  const realJobs = [jobs.runJob, jobs.runJobs];
  let escape;
  const escaped = new Promise((resolve, reject) => { escape = reject; });
  let watchingForEscapes = true;
  const noted = (real) => (...a) => { if (watchingForEscapes && a[0] === w.ws) escape(new Error(`a start-up job run was not held: ${JSON.stringify(a[1])}`)); return real(...a); };
  jobs.runJob = noted(realJobs[0]);
  jobs.runJobs = noted(realJobs[1]);
  t.after(() => { [jobs.runJob, jobs.runJobs] = realJobs; });
  const entry = [jobs.runJob, jobs.runJobs];
  const { out: h, at, asked, given, recorder, left } = await watching(w.ws.root, () => startWithBackgroundHeld(t, w.ws, { port: port(), quiet: true }));
  assert.equal(left, recorder, 'fs.watch is what it was as soon as the server has started');
  assert.deepEqual([global.setTimeout, global.setInterval, fs.watch], before, 'and so are the global timers');
  assert.deepEqual(asked, [at], 'the server asked for exactly one recursive watch, on its workspace');
  assert.equal(given.length, 1, 'the server opened its one watcher');
  const started = tree(w.root); // the server's own start writes its index first
  assert.equal(started[STATE], undefined, 'no job has recorded a run');
  // A change notice, delivered as the operating system delivers it: kept, and nothing scheduled.
  assert.deepEqual(timersSetBy(() => given[0]('change', INBOX_FILE)), [], 'a held notice sets no timer: no index rebuild, no second inbox run');
  assert.deepEqual(timersSetBy(() => given[0]('rename', PROJECT_FILE)), []);
  const mine = h.heldWatch.filter((e) => e.file.endsWith('a-new-report.md') || e.file.endsWith('example-payfi-fictional/project.json'));
  assert.deepEqual(mine, [{ event: 'change', file: INBOX_FILE.split(path.sep).join('/') }, { event: 'rename', file: PROJECT_FILE.split(path.sep).join('/') }]);
  // The start-up inbox timer, awaited as the event it is: the request and the inbox job.
  const first = await Promise.race([h.whenHeld(2), escaped]);
  watchingForEscapes = false; // from here the test runs jobs of its own, on purpose
  assert.deepEqual(first.slice(0, 2), [{ job: 'requests', trigger: 'dashboard' }, { job: 'inbox', trigger: 'dashboard' }]);
  assert.deepEqual(changed(started, tree(w.root)), [], 'the held work wrote nothing: no job state, and no rebuilt index');
  assert.equal(fs.existsSync(w.ws.abs(STATE)), false);
  // Not the server's own timer: the same jobs on the same workspace run and record themselves.
  const real = await jobs.runJobs(w.ws, ['requests', 'inbox'], { trigger: 'dashboard' });
  assert.ok(real.every((r) => r.summary !== HELD_WORDS), 'a run that is not the server\'s own timer is not held');
  assert.deepEqual(changed(started, tree(w.root)).filter((f) => f === STATE), [STATE], 'it records its run, as in production');
  assert.ok(JSON.parse(fs.readFileSync(w.ws.abs(STATE), 'utf8')).jobs.inbox.last_run_at);
  // A timer set from here, after the start, is not the server's: its job runs too.
  const beforeTimer = tree(w.root);
  const again = await new Promise((resolve, reject) => setTimeout(() => jobs.runJob(w.ws, 'inbox', { trigger: 'dashboard' }).then(resolve, reject), 0));
  assert.notEqual(again.summary, HELD_WORDS);
  assert.deepEqual(changed(beforeTimer, tree(w.root)).filter((f) => f === STATE), [STATE]);
  h.restore();
  assert.deepEqual([jobs.runJob, jobs.runJobs], entry, 'the jobs module is restored');
});

test('not held (the server as production starts it): the same start-up timer writes logs/jobs-state.json by itself, and the same change notices schedule the index rebuild and the inbox jobs', async (t) => {
  const w = tempWorkspace('server-background-real');
  t.after(w.cleanup);
  addFixtureProject(w.ws);
  const { start } = require('../server');
  // Told when the start-up inbox pass has finished, by the pass itself.
  const realRunJobs = jobs.runJobs;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  jobs.runJobs = async (...a) => { const r = await realRunJobs(...a); if (a[0] === w.ws && Array.isArray(a[1]) && a[1].includes('inbox')) done(r); return r; };
  t.after(() => { jobs.runJobs = realRunJobs; });
  const { out: srv, at, asked, given } = await watching(w.ws.root, () => start(w.ws, { port: port(), quiet: true }));
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const started = tree(w.root);
  assert.equal(started[STATE], undefined);
  const ran = await finished;
  assert.deepEqual(ran.map((r) => r.job), ['requests', 'inbox']);
  assert.deepEqual(changed(started, tree(w.root)).filter((f) => f === STATE), [STATE], 'the background write the two tests were racing');
  // The watcher's own work, read off the timers its callback sets (none is started here):
  // a change in the workspace schedules the index rebuild; one in the inbox, the inbox jobs as well.
  assert.deepEqual(asked, [at], 'the server asked for exactly one recursive watch, on its workspace');
  assert.equal(given.length, 1);
  assert.deepEqual(timersSetBy(() => given[0]('rename', PROJECT_FILE)), [300], 'the derived index is rebuilt 300 ms after a change');
  assert.deepEqual(timersSetBy(() => given[0]('change', INBOX_FILE)), [1500, 300], 'and the inbox jobs are scheduled again');
});
