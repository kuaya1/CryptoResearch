'use strict';
// A stand-in for the `claude` executable (worker boundary PR, 2026-10-31),
// run by the real launcher in scripts/pilot.js (makeLauncher) as
// `node claude-stand-in.js <args>`. It generates nothing and calls no model.
// What it was given (its arguments, its environment, its stdin and working
// folder) is appended to record.jsonl beside a copy of it. Its behaviour is
// read from config.json beside it, since the launcher hands a session none of
// the test's environment:
//
//   help_drop   flags left out of its --help, as an older CLI would
//   help_fail   --help exits 2
//   leak        tool definitions it offers the model on top of --tools, as a
//               CLI or a configuration that broadened the session would
//   no_request  it never reaches the model endpoint
//   hang        the probe's run never exits
//   offer       the exact tool list it sends (instead of --tools and the
//               placeholder): an empty, partial or server-form inventory
//   no_tools    its model request carries no tools key at all
//
// With ANTHROPIC_BASE_URL set (the launcher's probe) it sends one model request
// there, with the tools it would offer, and exits 1 on the stand-in's 400, as
// the real CLI does; otherwise (a session) it prints a FICTIONAL answer.

const fs = require('fs');
const path = require('path');
const http = require('http');

const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (_) { return {}; } })();
const argv = process.argv.slice(2);
// [flag, its --help line]
const HELP = [
  ['--print', '-p, --print'], ['--output-format', '--output-format <format>'], ['--tools', '--tools <tools...>'],
  ['--allowedTools', '--allowedTools, --allowed-tools <tools...>'], ['--disallowedTools', '--disallowedTools, --disallowed-tools <tools...>'],
  ['--permission-mode', '--permission-mode <mode>'], ['dontAsk', '    (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")'],
  ['--strict-mcp-config', '--strict-mcp-config'], ['--mcp-config', '--mcp-config <configs...>'], ['--restricted', '--restricted'], ['--safe-mode', '--safe-mode'],
  ['--settings', '--settings <file-or-json>'], ['--disable-slash-commands', '--disable-slash-commands'], ['--no-chrome', '--no-chrome'],
  ['--no-session-persistence', '--no-session-persistence'], ['--model', '--model <model>'], ['--effort', '--effort <level>'],
];

if (argv.includes('--help')) {
  if (cfg.help_fail) process.exit(2);
  const drop = new Set(cfg.help_drop || []);
  process.stdout.write(`Usage: claude [options]\n\nOptions:\n${HELP.filter(([f]) => !drop.has(f)).map(([, l]) => `  ${l}`).join('\n')}\n`);
} else if (argv.includes('--version')) {
  process.stdout.write('0.0.0 (Claude Code stand-in, FICTIONAL)\n');
} else {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const stdin = Buffer.concat(chunks).toString('utf8');
    const cwd = process.cwd();
    fs.appendFileSync(path.join(__dirname, 'record.jsonl'), `${JSON.stringify({ argv, env: process.env, stdin, cwd, cwd_entries: fs.readdirSync(cwd) })}\n`);
    const base = process.env.ANTHROPIC_BASE_URL;
    if (!base) {
      process.stdout.write('FICTIONAL answer from the claude stand-in.\n');
      return;
    }
    if (cfg.hang) { setInterval(() => {}, 1000); return; }
    if (cfg.no_request) process.exit(1);
    const i = argv.indexOf('--tools');
    const names = i >= 0 ? String(argv[i + 1]).split(',').filter(Boolean) : [];
    const tools = Array.isArray(cfg.offer) ? cfg.offer : [
      ...names.map((name) => ({ name, description: `${name} (stand-in)`, input_schema: { type: 'object', properties: { q: { type: 'string' } } } })),
      { name: 'DeferredToolPlaceholder', description: 'Reserved placeholder (stand-in).', input_schema: { type: 'object', properties: {} }, defer_loading: true },
      ...(cfg.leak || []),
    ];
    const body = JSON.stringify({ model: 'stand-in', max_tokens: 1, ...(cfg.no_tools ? {} : { tools }), system: 'stand-in system prompt', messages: [{ role: 'user', content: stdin }] });
    const u = new URL('/v1/messages?beta=true', base);
    const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));
    });
    req.on('error', () => process.exit(1));
    req.end(body);
  });
}
