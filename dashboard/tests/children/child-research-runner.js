'use strict';
// Test child for paid research attempts (audit V2-003/004). Runs the research
// runner once against a TEST workspace. Provider URLs are rewritten to a local
// stub server; any other URL is refused, so nothing leaves this PC. The keys in
// the environment are fake test values.
// Usage: node child-research-runner.js <root> <config.json>
// config: { stub_port, crash: { op, when: 'before'|'after' } | null,
//           barrier: <file to wait for> | null, calls_dir: <dir> | null,
//           capture: { crash: 'before'|'after', fail: '<error code>' } | null }
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
