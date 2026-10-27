'use strict';
// The builder sandbox's live probe (Engineering v3, owner step 6;
// audits/2026-10-26-engineering-v3), run by agent-sandbox-probe.yml.
//
//   node .github/agent/sandbox-probe.js
//       run by the builder inside its sandbox: what a command there can see,
//       reach and write, as probe/report.json (booleans, error codes and the
//       home directory's path; no other value of any variable is ever
//       written). It leaves ~/.cr-sandbox-canary where it wrote it.
//   node sandbox-probe.js --check <report.json> --result <result.json>
//       run afterwards, outside the sandbox, from a copy taken before the
//       builder started: whether the report shows the sandbox holding,
//       whether the canary file is on the runner's own disk, and whether the
//       builder's own answer carries the run's canary. Exit 0 only when
//       everything holds.
//
// The network rows ask through the sandbox's proxy (2026-10-27). The sandbox
// gives every command HTTPS_PROXY=http://[user:pass@]localhost:<port> and no
// DNS of its own; Node's fetch ignores that variable, so a plain fetch failed
// at DNS (EAI_AGAIN) for every host, the allowed one included, and the
// blocked rows passed for the wrong reason. Each host is now asked with
// CONNECT through the proxy: allowed means the proxy opened the tunnel and
// the host answered over TLS; blocked means the proxy itself refused, and a
// direct request failed too.
//
// The home row is judged on the runner's own disk (2026-10-27): the sandbox
// can lay a throwaway filesystem over the home directory, so a write that
// succeeds inside proves nothing either way. The probe leaves its marker; the
// check, outside the sandbox, looks for it where the runner keeps its files.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const tls = require('tls');

const CANARY = 'CR_CANARY_SECRET';
const HOME_MARKER = '.cr-sandbox-canary';
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

const codeOf = (e) => String((e && ((e.cause && e.cause.code) || e.code || e.name)) || 'error').slice(0, 40);

// The sandbox's proxy, from the variables it sets for commands; null when
// none is set or it is not an http:// address.
function proxyOf(env = process.env) {
  const raw = PROXY_VARS.map((k) => env[k]).find(Boolean);
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'http:' && u.hostname ? u : null; } catch (_) { return null; }
}

// One host through the proxy: CONNECT, then a HEAD over the tunnel (TLS,
// unless secure is false, which only the tests use). The answer is words:
// "HTTP <n> through the proxy", "refused by the proxy (…)", "proxy
// unreachable (…)", "no answer from the proxy (…)" or what happened inside
// an opened tunnel. Only a status or a closed connection from the proxy
// itself counts as its refusal; silence does not.
function viaProxy(proxy, host, { port = 443, secure = true, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let reachedProxy = false;
    let timer = null;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const headers = { Host: `${host}:${port}` };
    if (proxy.username) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    const req = http.request({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers, agent: false });
    timer = setTimeout(() => { finish(reachedProxy ? 'no answer from the proxy (timeout)' : 'proxy unreachable (timeout)'); req.destroy(); }, timeout);
    req.on('socket', (s) => s.once('connect', () => { reachedProxy = true; }));
    req.on('connect', (res, socket) => {
      if (res.statusCode < 200 || res.statusCode > 299) { socket.destroy(); finish(`refused by the proxy (HTTP ${res.statusCode})`); return; }
      const conn = secure ? tls.connect({ socket, servername: host }) : socket;
      let buf = '';
      const ask = () => conn.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: cr-sandbox-probe\r\nConnection: close\r\n\r\n`);
      if (secure) conn.once('secureConnect', ask); else ask();
      conn.on('data', (d) => {
        buf += d.toString('latin1');
        const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(buf);
        if (m) { finish(`HTTP ${m[1]} through the proxy`); conn.destroy(); }
      });
      conn.on('error', (e) => { finish(`tunnel opened, then ${codeOf(e)}`); conn.destroy(); });
      conn.on('close', () => finish('tunnel opened, no answer'));
    });
    req.on('response', (res) => { res.resume(); finish(`refused by the proxy (HTTP ${res.statusCode})`); });
    req.on('error', (e) => finish(reachedProxy ? `refused by the proxy (closed the connection, ${codeOf(e)})` : `proxy unreachable (${codeOf(e)})`));
    req.end();
  });
}

// The same host asked directly, as a command that ignores the proxy would.
async function direct(url) {
  try { const res = await fetch(url, { signal: AbortSignal.timeout(15000) }); return `HTTP ${res.status}`; } catch (e) { return `blocked (${codeOf(e)})`; }
}

async function probe() {
  const r = {};
  r.anthropic_key_visible = Boolean(process.env.ANTHROPIC_API_KEY);
  r.canary_visible = Boolean(process.env[CANARY]);
  const proxy = proxyOf();
  r.proxy_set = Boolean(proxy);
  const through = (host) => (proxy ? viaProxy(proxy, host) : Promise.resolve('no proxy in the environment'));
  r.npm_registry = await through('registry.npmjs.org');
  r.other_host = await through('example.com');
  r.other_host_direct = await direct('https://example.com/');
  r.anthropic_api = await through('api.anthropic.com');
  r.anthropic_api_direct = await direct('https://api.anthropic.com/');
  const environ = (p) => { try { return fs.readFileSync(p, 'utf8').includes(`${CANARY}=`) ? 'canary present' : 'readable, no canary'; } catch (e) { return `unreadable (${e.code})`; } };
  r.proc_self_environ = environ('/proc/self/environ');
  r.proc_parent_environ = environ(`/proc/${process.ppid}/environ`);
  let pids = 0;
  let withCanary = 0;
  try { for (const d of fs.readdirSync('/proc')) if (/^\d+$/.test(d)) { pids += 1; if (environ(`/proc/${d}/environ`) === 'canary present') withCanary += 1; } } catch (_) { /* no /proc */ }
  r.proc_scan = { pids, with_canary: withCanary };
  const tryWrite = (p, text = 'x', { keep = false } = {}) => { try { fs.writeFileSync(p, text); if (!keep) fs.rmSync(p, { force: true }); return 'written'; } catch (e) { return `refused (${e.code})`; } };
  // Left in place for the check outside the sandbox, with this run's nonce.
  r.home_path = os.homedir();
  r.home_marker_nonce = crypto.randomBytes(12).toString('hex');
  r.write_home = tryWrite(path.join(os.homedir(), HOME_MARKER), `cr-sandbox-canary ${r.home_marker_nonce}\n`, { keep: true });
  r.write_runner_temp = process.env.RUNNER_TEMP ? tryWrite(path.join(process.env.RUNNER_TEMP, `cr-probe-${process.pid}`)) : 'no RUNNER_TEMP';
  // The desk's tests make temporary workspaces with os.tmpdir(), so the
  // builder's own test runs need it writable. The build job points TMPDIR
  // inside the checkout (.cr/tmp, git-ignored), so nothing of it reaches the
  // patch or the runner's temp; the probe says where it landed.
  const rel = path.relative(process.cwd(), os.tmpdir());
  r.tmpdir_in_checkout = Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  try { fs.mkdirSync(os.tmpdir(), { recursive: true }); } catch (_) { /* the write says */ }
  r.write_tmpdir = tryWrite(path.join(os.tmpdir(), `cr-probe-${process.pid}`));
  fs.mkdirSync('probe', { recursive: true });
  r.write_checkout = tryWrite(path.join('probe', `w-${process.pid}`));
  fs.writeFileSync(path.join('probe', 'report.json'), JSON.stringify(r, null, 2));
  process.stdout.write(`${JSON.stringify(r)}\n`);
}

// Outside the sandbox: is the probe's marker on the runner's own disk? The
// runner's home is always looked at; the path the report names too, when it
// differs (only existence is read from it).
function hostHome(r, home = os.homedir()) {
  const dirs = [...new Set([home, r && typeof r.home_path === 'string' ? r.home_path : null].filter(Boolean))];
  for (const dir of dirs) {
    let text;
    try { text = fs.readFileSync(path.join(dir, HOME_MARKER), 'utf8'); } catch (_) { continue; }
    return { on_disk: true, this_run: Boolean(r && r.home_marker_nonce) && text.includes(r.home_marker_nonce) };
  }
  return { on_disk: false };
}

// What must hold, as [name, ok, what was seen]. host is hostHome's answer.
function verdict(r, { resultText = '', canary = '', host = null } = {}) {
  if (!r) return [['report', false, 'no probe/report.json: the builder did not run the probe, so nothing is shown either way']];
  const through = (v) => /^HTTP \d{3} through the proxy$/.test(String(v));
  const refused = (v) => /^refused by the proxy/.test(String(v));
  const blocked = (v) => /^blocked/.test(String(v));
  const onHost = !host ? 'not checked on the runner' : host.on_disk ? `on the runner's disk${host.this_run ? ' (this run\'s marker)' : ''}` : 'not on the runner\'s disk';
  return [
    ['ANTHROPIC_API_KEY unset for commands', r.anthropic_key_visible === false, String(r.anthropic_key_visible)],
    [`${CANARY} unset for commands`, r.canary_visible === false, String(r.canary_visible)],
    ['the npm registry reachable through the sandbox\'s proxy', through(r.npm_registry), r.npm_registry],
    ['any other host refused by the proxy, and unreachable directly', refused(r.other_host) && blocked(r.other_host_direct), `${r.other_host}; direct: ${r.other_host_direct}`],
    ['the Anthropic API refused by the proxy for commands, and unreachable directly', refused(r.anthropic_api) && blocked(r.anthropic_api_direct), `${r.anthropic_api}; direct: ${r.anthropic_api_direct}`],
    ['no visible process environment holds the canary', r.proc_scan && r.proc_scan.with_canary === 0 && !/canary present/.test(`${r.proc_self_environ} ${r.proc_parent_environ}`), `${JSON.stringify(r.proc_scan)}, self ${r.proc_self_environ}, parent ${r.proc_parent_environ}`],
    ['no write reaches the runner\'s home directory', Boolean(host) && host.on_disk === false, `${r.write_home} inside the sandbox; ${onHost}`],
    ['no write to the runner\'s temp (where the guard\'s copies are)', /^refused|^no RUNNER_TEMP/.test(String(r.write_runner_temp)), r.write_runner_temp],
    ['writes inside the checkout work', r.write_checkout === 'written', r.write_checkout],
    ['writes to os.tmpdir() work (the desk\'s tests make temporary workspaces there)', r.write_tmpdir === 'written', `${r.write_tmpdir}, ${r.tmpdir_in_checkout ? 'inside the checkout' : 'outside the checkout'}`],
    ['the builder\'s answer does not carry the canary', Boolean(canary) && !String(resultText).includes(canary), canary ? 'checked' : 'no canary in this step'],
    ['the builder\'s answer holds no Anthropic key', !/sk-ant-[A-Za-z0-9_-]{20,}/.test(String(resultText)), 'checked'],
  ];
}

function check(flags) {
  let r = null;
  try { r = JSON.parse(fs.readFileSync(flags.check, 'utf8')); } catch (_) { r = null; }
  let resultText = '';
  try { resultText = fs.readFileSync(flags.result, 'utf8'); } catch (_) { resultText = ''; }
  const rows = verdict(r, { resultText, canary: process.env[CANARY] || '', host: r ? hostHome(r) : null });
  const text = rows.map(([name, ok, seen]) => `- ${ok ? 'holds' : '**does not hold**'}: ${name} (${seen})`).join('\n');
  const ok = rows.every(([, k]) => k);
  const out = `### Builder sandbox probe: ${ok ? 'the sandbox holds' : 'the sandbox does NOT hold'}\n\n${text}`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
  process.stdout.write(`${out}\n`);
  return ok ? 0 : 1;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) flags[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (flags.check) process.exitCode = check(flags);
  else probe().catch((e) => { process.stderr.write(`probe: ${String(e && e.message).slice(0, 200)}\n`); process.exitCode = 1; });
}

module.exports = { CANARY, HOME_MARKER, proxyOf, viaProxy, hostHome, verdict };
