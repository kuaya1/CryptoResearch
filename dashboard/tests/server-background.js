'use strict';
// A test's hold on the dashboard server's own background work (2026-11-10).
//
// start() (dashboard/server.js) has two kinds of work nobody asked it for:
// - Timers. The inbox and request jobs 200 ms after it listens, then prices,
//   research, the daily jobs and the wallets, and intervals after those. Each
//   job records its run in logs/jobs-state.json.
// - A watcher on the workspace. When a file there changes it rebuilds the
//   derived index 300 ms later (dashboard/index/index.json, with a new time
//   in it) and, for the inbox, schedules the inbox jobs again.
// A test that starts a real server and then asserts "this request wrote
// nothing else" was racing both: idle, the request finished first; on a busy
// machine a start-up job, or the rebuild after a change notice, landed
// inside the test's window (arm-desk.test.js and grade-outcome-view.test.js,
// reproduced under load on every tree; the rebuild with the jobs already
// held, in the whole suite).
//
// startWithBackgroundHeld starts the same server the same way and holds only
// that background work:
// - a job run that the server's own timers lead to answers `not_due` and
//   writes nothing;
// - a change notice from the server's own watcher is kept (`heldWatch`) and
//   not passed on, so it rebuilds nothing and schedules nothing.
// Everything else is real. A job run from anywhere else, on the same
// workspace, runs and records itself as it does in production; a request's
// handler does its own rebuild; and every write a request makes is on disk
// for the test to compare, so "the request wrote nothing else" still means
// what it says. Nothing waits, sleeps or retries, and no production code
// knows about it. The jobs module is held the way pilot-exit-target.test.js
// already holds it for its own server tests: by standing in for jobs.runJob.
//
// How the server's own timers are told from the rest: while start() runs,
// every timer it sets is wrapped so that its callback, and whatever that goes
// on to do (later timers included), runs marked in an AsyncLocalStorage. The
// jobs module's two entry points check the mark. A request handler is not
// marked. The watcher start() opens is the real one, on the same folder, with
// the holding callback in place of the server's.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const jobs = require('../core/jobs');

const BACKGROUND = Symbol('set by the server while starting');
const HELD_WORDS = 'Held by the test: the server\'s own background work is not what it measures.';

// Starts the server for `ws` with its background work held. Returns the
// server (as start() returns it); `held`, the job runs that were held, in
// order; `heldWatch`, the watcher's change notices that were held; and
// `whenHeld(n)`, which resolves once n job runs have been held (an event, for
// a test of this hold itself: nothing else needs to wait). The server is shut
// down and the jobs module restored when the test ends.
async function startWithBackgroundHeld(t, ws, opts = {}) {
  const { start } = require('../server');
  const als = new AsyncLocalStorage();
  const held = [];
  const heldWatch = [];
  const waiting = [];
  const real = { runJob: jobs.runJob, runJobs: jobs.runJobs, setTimeout: global.setTimeout, setInterval: global.setInterval, watch: fs.watch };
  // The mark is this hold's own (one AsyncLocalStorage per started server),
  // so only this server's timers carry it.
  const mine = () => als.getStore() === BACKGROUND;
  const hold = (name, o) => {
    held.push({ job: name, trigger: (o && o.trigger) || null });
    for (const w of waiting.splice(0)) { if (held.length >= w.n) w.resolve(held.slice()); else waiting.push(w); }
    return { job: name, status: 'not_due', summary: HELD_WORDS };
  };
  const whenHeld = (n) => (held.length >= n ? Promise.resolve(held.slice()) : new Promise((resolve) => waiting.push({ n, resolve })));
  jobs.runJob = (w, name, o = {}) => (mine() ? Promise.resolve(hold(name, o)) : real.runJob(w, name, o));
  jobs.runJobs = (w, names, o = {}) => (mine() ? Promise.resolve((names && names.length ? names : jobs.JOB_NAMES).map((n) => hold(n, o))) : real.runJobs(w, names, o));
  const marked = (fn) => (typeof fn === 'function' ? function background(...a) { return als.run(BACKGROUND, () => fn.apply(this, a)); } : fn);
  const wrap = (set) => Object.defineProperties((fn, ...rest) => set(marked(fn), ...rest), Object.getOwnPropertyDescriptors(set));
  const noticed = (evt, filename) => { heldWatch.push({ event: evt, file: filename === null || filename === undefined ? null : String(filename).split(path.sep).join('/') }); };
  let restored = false;
  const restore = () => { if (restored) return; restored = true; jobs.runJob = real.runJob; jobs.runJobs = real.runJobs; };
  let srv = null;
  t.after(() => { try { if (srv) srv.shutdown(); } catch (_) { /* stopped */ } restore(); });
  global.setTimeout = wrap(real.setTimeout);
  global.setInterval = wrap(real.setInterval);
  fs.watch = (...a) => real.watch(...a.map((x) => (typeof x === 'function' ? noticed : x)));
  try {
    srv = await start(ws, opts);
  } finally {
    global.setTimeout = real.setTimeout;
    global.setInterval = real.setInterval;
    fs.watch = real.watch;
  }
  return { srv, held, heldWatch, whenHeld, restore };
}

module.exports = { startWithBackgroundHeld, HELD_WORDS };
