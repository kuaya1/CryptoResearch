'use strict';
// Test child for paid research attempts (audit V2-003/004). Runs the research
// runner once against a TEST workspace. Provider URLs are rewritten to a local
// stub server; any other URL is refused, so nothing leaves this PC. The keys in
// the environment are fake test values.
// Usage: node child-research-runner.js <root> <config.json>
// config: { stub_port, crash: { op, when: 'before'|'after'|'fail_after_build' } | null,
//           barrier: <file to wait for> | null, calls_dir: <dir> | null,
//           capture: { crash: 'before'|'after', fail: '<error code>' } | null,
//           fs: { link_error: '<error code>', capture_read_busy_while: <file> } | null }
// A crash kills the process at that point: no finally block or cleanup runs.
const fs = require('fs');
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, configFile] = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const { sleepSync } = require(path.join(base, 'core', 'fsx'));

const die = () => process.kill(process.pid, 'SIGKILL');
const ops = require(path.join(base, 'core', 'ops'));
const runOp = ops.runOp;
ops.runOp = function crashableRunOp(ws, meta, build) {
  if (cfg.crash && cfg.crash.op === meta.type && cfg.crash.when === 'before') die();
  // 'fail_after_build': the operation stages everything (and appends whatever
  // its build step writes directly, such as spend-log lines), then the atomic
  // save fails before anything is committed.
  if (cfg.crash && cfg.crash.op === meta.type && cfg.crash.when === 'fail_after_build') {
    return runOp.call(this, ws, meta, (op) => {
      build(op);
      throw Object.assign(new Error('test: the save failed after its build step'), { code: 'TEST_SAVE_FAILED' });
    });
  }
  const out = runOp.call(this, ws, meta, build);
  if (cfg.crash && cfg.crash.op === meta.type && cfg.crash.when === 'after') die();
  return out;
};

// Capture hooks (audit F1): capture: { crash: 'before'|'after', fail: '<code>' }.
// Older code without captures.js simply ignores them.
let captures = null;
try { captures = require(path.join(base, 'core', 'captures')); } catch (_) { captures = null; }
if (captures && cfg.capture) {
  const writeCapture = captures.writeCapture;
  captures.writeCapture = function hookedWriteCapture(...args) {
    if (cfg.capture.crash === 'before') die();
    if (cfg.capture.fail) throw Object.assign(new Error(`test: capture write refused (${cfg.capture.fail})`), { code: cfg.capture.fail });
    const out = writeCapture.apply(this, args);
    if (cfg.capture.crash === 'after') die();
    return out;
  };
}

// Windows file-system conditions for captures (audit F1 on Windows):
// fs.link_error: every hard link into .cr/captures fails with that code, as on
//   a volume without hard links.
// fs.capture_read_busy_while: while that file exists, reading a finished
//   capture fails with EBUSY, as when another program holds it open without
//   sharing reads (an exclusive scan or backup).
if (cfg.fs) {
  const finishedCapture = (p) => /[\\/]\.cr[\\/]captures[\\/][^\\/.][^\\/]*$/.test(String(p));
  if (cfg.fs.link_error) {
    const linkSync = fs.linkSync;
    fs.linkSync = function testLinkSync(src, dst) {
      if (finishedCapture(dst)) throw Object.assign(new Error(`${cfg.fs.link_error}: test: hard link refused, link '${src}' -> '${dst}'`), { code: cfg.fs.link_error, syscall: 'link' });
      return linkSync.call(fs, src, dst);
    };
  }
  if (cfg.fs.capture_read_busy_while) {
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function testReadFileSync(p, ...rest) {
      if (typeof p === 'string' && finishedCapture(p) && fs.existsSync(cfg.fs.capture_read_busy_while)) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${p}'`), { code: 'EBUSY', syscall: 'open' });
      return readFileSync.call(fs, p, ...rest);
    };
  }
}

const research = require(path.join(base, 'core', 'research'));
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: 'runner-child' });

const ROUTES = [
  ['https://api.anthropic.com/', '/anthropic/'],
  ['https://api.openai.com/', '/openai/'],
  ['https://generativelanguage.googleapis.com/', '/gemini/'],
];
async function fetchImpl(url, opts) {
  const hit = ROUTES.find(([from]) => String(url).startsWith(from));
  if (!hit) throw new Error(`test child refused a request to ${url}`);
  if (cfg.calls_dir) fs.writeFileSync(path.join(cfg.calls_dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.call`), String(url));
  if (cfg.crash && cfg.crash.op === 'fetch' && cfg.crash.when === 'before') die();
  return fetch(`http://127.0.0.1:${cfg.stub_port}${hit[1]}${String(url).slice(hit[0].length)}`, opts);
}

(async () => {
  if (cfg.barrier) {
    const until = Date.now() + 30000;
    while (!fs.existsSync(cfg.barrier) && Date.now() < until) sleepSync(5);
  }
  const out = await research.runDueJobs(ws, { trigger: 'test-child', fetchImpl });
  process.stdout.write(JSON.stringify(out));
})().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message, code: err.code || null }));
  process.exitCode = 3;
});
