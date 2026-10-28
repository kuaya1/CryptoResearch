'use strict';
// D6 (Eric, 2026-10-28): the pilot's two sub-agents are split by their tools,
// not by words. Each agent file lists its own tools (its connector tools under
// both spellings of the connector) and runs the role guard on Bash and Write:
// Bash only that role's `node dashboard/cli.js` commands, Write only in the
// system's temporary folder. Nothing here starts Claude Code or a connector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'dashboard', 'scripts', 'pilot-role-guard.js');
const { decide, words } = require('../scripts/pilot-role-guard');

const SERVERS = ['mcp__claude_ai_CryptoResearch__', 'mcp__ab53ce10-e51b-46ac-b8d7-d2bcc8e7bd65__'];
const BUILT_IN = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash', 'Write', 'ToolSearch'];
const AGENTS = {
  researcher: { file: 'forensic-researcher.md', connector: ['find_projects', 'desk_status', 'pending_research', 'start_research', 'get_research', 'save_research_draft', 'save_report', 'get_report'] },
  prosecutor: { file: 'junior-trader-prosecutor.md', connector: ['find_projects', 'desk_status', 'pending_tickets', 'start_ticket', 'get_ticket', 'save_ticket'] },
};

const bash = (command, cwd = ROOT) => ({ tool_name: 'Bash', tool_input: { command }, cwd });
const write = (file_path, cwd = ROOT) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd });

// The frontmatter's tools list and its one hook, read line by line (the files
// keep one shape; a different shape fails here rather than being guessed at).
function frontmatter(file) {
  const text = fs.readFileSync(path.join(ROOT, '.claude', 'agents', file), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${file} has frontmatter`);
  const lines = m[1].split('\n');
  const tools = [];
  let inTools = false;
  for (const l of lines) {
    if (/^tools:\s*$/.test(l)) { inTools = true; continue; }
    if (inTools && /^ {2}- /.test(l)) { tools.push(l.replace(/^ {2}- /, '').trim()); continue; }
    if (inTools && !/^\s*#/.test(l)) inTools = false;
  }
  const hook = m[1].slice(m[1].indexOf('\nhooks:'));
  return { tools, hook, body: text.slice(m[0].length) };
}

test('D6: each agent file lists only its own tools, its connector tools under both connector spellings', () => {
  for (const [role, a] of Object.entries(AGENTS)) {
    const { tools } = frontmatter(a.file);
    const expected = [...BUILT_IN, ...SERVERS.flatMap((s) => a.connector.map((t) => s + t))];
    assert.deepEqual([...tools].sort(), [...expected].sort(), `${role}: the tools list is exactly the confirmed one`);
    for (const never of ['Edit', 'NotebookEdit', 'Agent', 'PowerShell', 'Skill']) assert.ok(!tools.includes(never), `${role} has no ${never}`);
    assert.ok(!tools.some((t) => t.endsWith('__*') || t === 'mcp__*'), `${role}: no whole-server grant`);
  }
  const r = frontmatter(AGENTS.researcher.file).tools;
  const p = frontmatter(AGENTS.prosecutor.file).tools;
  for (const t of ['start_ticket', 'save_ticket', 'get_ticket', 'pending_tickets']) assert.ok(!r.some((x) => x.endsWith(`__${t}`)), `the researcher cannot ${t}`);
  for (const t of ['start_research', 'save_report', 'save_research_draft', 'get_research', 'get_report']) assert.ok(!p.some((x) => x.endsWith(`__${t}`)), `the prosecutor cannot ${t} (Agent 1's run and drafts stay out of its context)`);
  for (const t of ['record_transaction', 'add_account', 'archive_project', 'restore_project', 'update_project_identity', 'add_project', 'save_forensic_report']) {
    assert.ok(![...r, ...p].some((x) => x.endsWith(`__${t}`)), `neither agent can ${t}`);
  }
});

test('D6: each agent file runs the role guard on Bash and Write, and blocks when the guard cannot run', () => {
  for (const [role, a] of Object.entries(AGENTS)) {
    const { hook, body } = frontmatter(a.file);
    assert.match(hook, /\n {2}PreToolUse:\n {4}- matcher: "Bash\|Write"\n {6}hooks:\n {8}- type: command\n {10}command: node\n/, `${role}: one PreToolUse hook on Bash and Write, in exec form`);
    assert.ok(hook.includes(`args: ["\${CLAUDE_PROJECT_DIR}/dashboard/scripts/pilot-role-guard.js", "${role}"]`), `${role}: the guard, with its role`);
    assert.match(hook, /\n {10}onFailure: block(\n|$)/, `${role}: a guard that cannot start refuses`);
    assert.match(body, /The guard refuses anything else/, `${role}: the body says what the guard allows`);
    assert.ok(!/outside the repository/.test(body), `${role}: scratch files go to the temporary folder`);
  }
  assert.ok(fs.existsSync(GUARD));
  assert.ok(!/cr-ticket-sizing@1/.test(frontmatter(AGENTS.prosecutor.file).body), 'the prosecutor no longer names a sizing version the desk does not run');
});

test('D6 guard: Bash runs only one plain `node dashboard/cli.js` command of the role', () => {
  const ok = (role, cmd, cwd) => assert.equal(decide(role, bash(cmd, cwd)).allow, true, `${role} may: ${cmd}`);
  const no = (role, cmd, why, cwd) => {
    const d = decide(role, bash(cmd, cwd));
    assert.equal(d.allow, false, `${role} may not: ${cmd}`);
    assert.match(d.reason, why, cmd);
  };
  ok('researcher', 'node dashboard/cli.js doctor --json');
  ok('researcher', 'node dashboard/cli.js research add olas --providers claude --channel cowork --utterance "autonomous pilot"');
  ok('researcher', 'node dashboard/cli.js research prompt olas rr_1');
  ok('researcher', 'node dashboard/cli.js research status olas');
  ok('researcher', `node dashboard/cli.js import-text --provider claude --project olas --text-file "${path.join(os.tmpdir(), 'r.md')}" --run rr_1`);
  ok('researcher', `node "${path.join(ROOT, 'dashboard', 'cli.js')}" doctor`);
  ok('researcher', 'node ../dashboard/cli.js doctor', path.join(ROOT, 'templates'));
  ok('prosecutor', 'node dashboard/cli.js tickets start olas --assistant --mode cli');
  ok('prosecutor', 'node dashboard/cli.js tickets prompt olas tk_1');
  ok('prosecutor', `node dashboard/cli.js tickets import olas tk_1 --text-file '${path.join(os.tmpdir(), 't.md')}'`);
  ok('prosecutor', 'node dashboard/cli.js tickets view olas');
  // The other role's commands.
  no('researcher', 'node dashboard/cli.js tickets import olas tk_1 --text-file x', /the researcher runs only/);
  no('researcher', 'node dashboard/cli.js tickets start olas', /the researcher runs only/);
  no('prosecutor', 'node dashboard/cli.js import-text --provider claude --project olas --text-file x', /the prosecutor runs only/);
  no('prosecutor', 'node dashboard/cli.js research prompt olas rr_1', /the prosecutor runs only/);
  // Decisions, money and records are nobody's here.
  for (const role of ['researcher', 'prosecutor']) {
    no(role, 'node dashboard/cli.js tickets decide olas tk_1 approve', /runs only/);
    no(role, 'node dashboard/cli.js record-transaction --x', /runs only/);
    no(role, 'node dashboard/cli.js', /runs only/);
    no(role, 'node dashboard/cli.js --workspace x doctor', /runs only/);
  }
  // Claude's work only.
  no('researcher', 'node dashboard/cli.js import-text --provider chatgpt --project olas --text-file x', /--provider claude/);
  no('researcher', 'node dashboard/cli.js import-text --project olas --text-file x', /--provider claude/);
  no('researcher', 'node dashboard/cli.js import-text --provider claude --provider gemini --project olas --text-file x', /--provider claude/);
  no('researcher', 'node dashboard/cli.js research add olas', /--providers claude/);
  no('researcher', 'node dashboard/cli.js research add olas --providers claude,chatgpt', /--providers claude/);
  // One plain command: nothing chained, piped, redirected or built at run time.
  for (const cmd of [
    'node dashboard/cli.js doctor && git push',
    'node dashboard/cli.js doctor; rm -rf x',
    'node dashboard/cli.js doctor | tee x',
    'node dashboard/cli.js doctor > x',
    'node dashboard/cli.js doctor < x',
    'node dashboard/cli.js doctor & curl x',
    'node dashboard/cli.js $(echo tickets) import',
    'node dashboard/cli.js "$(cat x)"',
    'node dashboard/cli.js `echo doctor`',
    'node dashboard/cli.js doctor\ngit push',
    '(node dashboard/cli.js doctor)',
    'node dashboard/cli.js doctor "unclosed',
    '',
  ]) no('researcher', cmd, /one plain command/);
  // Only node, only the desk's CLI.
  no('researcher', 'git commit -am x', /not `git`/);
  no('prosecutor', 'X=1 node dashboard/cli.js doctor', /not `X=1`/);
  no('researcher', 'node -e "require(1)"', /desk's own CLI/);
  no('researcher', 'node dashboard/scripts/pilot.js --project=olas', /desk's own CLI/);
  no('researcher', 'node --require x dashboard/cli.js doctor', /desk's own CLI/);
  no('researcher', 'node dashboard/cli.js doctor', /desk's own CLI/, os.tmpdir());
});

test('D6 guard: Git Bash paths on Windows read as Windows paths', () => {
  const opts = { root: 'C:\\desk', platform: 'win32' };
  assert.equal(decide('researcher', bash('node /c/desk/dashboard/cli.js doctor', '/c/desk'), opts).allow, true);
  assert.equal(decide('researcher', bash('node "C:\\desk\\dashboard\\cli.js" doctor', 'C:\\Users'), opts).allow, true);
  assert.equal(decide('researcher', bash('node dashboard/cli.js doctor', 'c:\\DESK'), opts).allow, true, 'case does not matter on Windows');
  assert.equal(decide('researcher', bash('node /d/desk/dashboard/cli.js doctor', '/c/desk'), opts).allow, false);
  assert.deepEqual(words('node "a b" c\\ d \'e"f\''), ['node', 'a b', 'c d', 'e"f']);
});

test('D6 guard: Write saves only in the system\'s temporary folder, never in the repository or elsewhere', () => {
  const tmp = os.tmpdir();
  assert.equal(decide('researcher', write(path.join(tmp, 'cr-pilot-x', 'report.md'))).allow, true);
  assert.equal(decide('prosecutor', write(path.join(tmp, 'ticket.md'))).allow, true);
  for (const f of [path.join(ROOT, 'DESK_STATE.md'), path.join(ROOT, 'dashboard', 'core', 'tickets.js'), path.join(ROOT, '.claude', 'agents', 'forensic-researcher.md')]) {
    const d = decide('researcher', write(f));
    assert.equal(d.allow, false, f);
    assert.match(d.reason, /never saves inside the repository/);
  }
  assert.equal(decide('prosecutor', write('DESK_STATE.md')).allow, false, 'a relative path is read from the working folder');
  for (const f of [path.join(os.homedir(), '.claude', 'settings.json'), path.join(os.homedir(), 'Documents', 'x.md'), path.join(tmp, '..', 'x.md')]) {
    const d = decide('prosecutor', write(f));
    assert.equal(d.allow, false, f);
    assert.match(d.reason, /temporary folder only/);
  }
  assert.equal(decide('researcher', write(tmp)).allow, false, 'not the folder itself');
  assert.equal(decide('researcher', write('')).allow, false);
});

test('D6 guard: other tools pass; an unknown role or unreadable input is refused', () => {
  assert.equal(decide('researcher', { tool_name: 'WebSearch', tool_input: { query: 'x' } }).allow, true);
  assert.equal(decide('banker', bash('node dashboard/cli.js doctor')).allow, false);
  assert.equal(decide(undefined, bash('node dashboard/cli.js doctor')).allow, false);
  assert.equal(decide('researcher', null).allow, false);
});

test('D6 guard: run as a hook, it exits 0 to allow and 2 with the reason on stderr to refuse', () => {
  const run = (role, input) => spawnSync(process.execPath, [GUARD, ...(role ? [role] : [])], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const ok = run('researcher', bash('node dashboard/cli.js doctor --json'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, '');
  const no = run('researcher', bash('node dashboard/cli.js tickets import olas tk_1 --text-file x'));
  assert.equal(no.status, 2);
  assert.match(no.stderr, /^Refused by the pilot's role guard \(researcher\): the researcher runs only /);
  assert.equal(run('prosecutor', '{not json').status, 2);
  assert.equal(run(null, bash('node dashboard/cli.js doctor')).status, 2);
  assert.equal(run('prosecutor', write(path.join(ROOT, 'x.md'))).status, 2);
});
