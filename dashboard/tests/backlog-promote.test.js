'use strict';
// Backlog promotion (scripts/backlog-promote.js, review A01/A02 2026-10-25): a
// temporary git repo with a bare origin. Two branches that are green alone and
// red together never both reach main; a moved main or branch is refused; the
// result is read back from the remote; the branch is deleted only at the
// tested commit; the scope gate holds protected paths and unlisted items for
// Eric. No network, no npm, no real suite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../scripts/backlog-promote');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
const DESK = '## Autonomous Build Backlog\n- [ ] **1. One.** a\n- [ ] **2. Two.** b\n- [ ] *(Eric)* **3. Three.** c\n- [x] **4. Four.** d\n';

// The fixture's "suite": every caller names the library's current name. A
// rename (branch A) and a new caller of the old name (branch B) each pass
// alone, merge cleanly, and fail together.
const suite = (dir) => {
  const name = fs.readFileSync(path.join(dir, 'dashboard/core/lib.txt'), 'utf8').trim();
  return fs.readdirSync(path.join(dir, 'dashboard/core/callers')).every((f) => fs.readFileSync(path.join(dir, 'dashboard/core/callers', f), 'utf8').trim() === name);
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const clone = (name) => { const d = path.join(root, name); g(root, 'clone', '-q', origin, d); g(d, 'config', 'core.autocrlf', 'false'); return d; };
  const work = clone('work');
  g(work, 'checkout', '-q', '-b', 'main');
  put(work, 'DESK_STATE.md', DESK);
  put(work, 'dashboard/core/lib.txt', 'old\n');
  put(work, 'dashboard/core/callers/c1.txt', 'old\n');
  put(work, 'templates/prompt.v1.md', 'v1\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base'); g(work, 'push', '-q', '-u', 'origin', 'main');
  const branch = (name, files, { item = 1, from = 'origin/main', message = null } = {}) => {
    g(work, 'fetch', '-q', 'origin');
    g(work, 'checkout', '-q', '-B', name, from);
    for (const [f, c] of Object.entries(files)) put(work, f, c);
    g(work, 'add', '-A'); g(work, 'commit', '-qm', message || `backlog: item ${item}\n\nBacklog-Item: ${item}`);
    g(work, 'push', '-q', '-f', 'origin', name);
    return g(work, 'rev-parse', 'HEAD');
  };
  const mainSha = () => g(work, 'ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  // The workflow's three jobs, each in a fresh clone as on a runner.
  let n = 0;
  const runner = () => clone(`runner-${n++}`);
  const testRun = (head) => {
    const c = runner();
    const base = mainSha();
    const out = P.compose(c, { base, head });
    return { base, ...out, green: out.status === 'composed' && suite(c) };
  };
  return { root, work, branch, mainSha, runner, testRun, origin };
}

test('A01: two branches green alone and red together never both reach main; the second is tested on the new main and held', (t) => {
  const f = fixture(t);
  const a = f.branch('claude/backlog-a', { 'dashboard/core/lib.txt': 'new\n', 'dashboard/core/callers/c1.txt': 'new\n' }, { item: 1 });
  const b = f.branch('claude/backlog-b', { 'dashboard/core/callers/c2.txt': 'old\n' }, { item: 2 });
  const base0 = f.mainSha();
  // Each push run is green on its own (the old admission rule's only check).
  assert.equal(f.testRun(a).green, true);
  const bAlone = f.testRun(b);
  assert.equal(bAlone.green, true);
  // A is promoted: its composed tree passed on main as it was.
  const ta = f.testRun(a);
  const pa = P.promote(f.runner(), { base: ta.base, head: a, branch: 'claude/backlog-a', tree: ta.tree });
  assert.equal(pa.status, 'merged');
  assert.notEqual(f.mainSha(), base0);
  // B's head is exactly the tested SHA, but main moved: its old green result
  // cannot be used (compare-and-swap) ...
  const stale = P.promote(f.runner(), { base: bAlone.base, head: b, branch: 'claude/backlog-b', tree: bAlone.tree });
  assert.equal(stale.status, 'base_moved');
  assert.match(P.summaryOf('promote', stale), /^### Not merged: main moved/);
  // ... and B composed on the new main merges cleanly but fails the suite, so
  // the workflow never reaches promote.
  const tb = f.testRun(b);
  assert.equal(tb.status, 'composed', 'a clean merge');
  assert.equal(tb.green, false, 'red together');
  assert.equal(f.mainSha(), pa.merge, 'main holds only A');
});

test('A01/A02: a confirmed merge lands the exact tested tree with both parents, says merged, and deletes the branch at the tested commit', (t) => {
  const f = fixture(t);
  const head = f.branch('claude/backlog-one', { 'dashboard/core/callers/c3.txt': 'old\n' }, { item: 1 });
  const tr = f.testRun(head);
  const gh = (args) => { assert.deepEqual(args.slice(0, 2), ['api', 'repos/o/r/pulls/7']); return JSON.stringify({ merged: true, state: 'closed', merge_commit_sha: 'x' }); };
  const r = P.promote(f.runner(), { base: tr.base, head, branch: 'claude/backlog-one', tree: tr.tree, repo: 'o/r', number: 7, gh });
  assert.equal(r.status, 'merged');
  assert.equal(f.mainSha(), r.merge);
  const check = f.runner();
  assert.equal(g(check, 'rev-parse', 'origin/main^{tree}'), tr.tree, 'the tree that passed');
  assert.deepEqual(g(check, 'log', '-1', '--format=%P', 'origin/main').split(' '), [tr.base, head]);
  assert.equal(r.branch_deleted, true);
  assert.equal(g(f.work, 'ls-remote', '--heads', 'origin', 'claude/backlog-one'), '');
  const words = P.summaryOf('promote', r);
  assert.match(words, /^### Merged into main as [0-9a-f]{7}/);
  assert.match(words, /PR #7 reads merged/);
  assert.match(words, /Branch claude\/backlog-one deleted/);
  assert.match(words, /Deployment is reported on its own/);
});

test('A01: a moved branch and a re-created tree that differs are refused; nothing lands', (t) => {
  const f = fixture(t);
  const head = f.branch('claude/backlog-one', { 'dashboard/core/callers/c3.txt': 'old\n' }, { item: 1 });
  const tr = f.testRun(head);
  const before = f.mainSha();
  const wrong = P.promote(f.runner(), { base: tr.base, head, branch: 'claude/backlog-one', tree: 'f'.repeat(40) });
  assert.equal(wrong.status, 'tree_mismatch');
  f.branch('claude/backlog-one', { 'dashboard/core/callers/c4.txt': 'old\n' }, { item: 1, from: 'claude/backlog-one' });
  const moved = P.promote(f.runner(), { base: tr.base, head, branch: 'claude/backlog-one', tree: tr.tree });
  assert.equal(moved.status, 'head_moved');
  assert.match(P.summaryOf('promote', moved), /^### Not merged: the branch moved/);
  assert.equal(f.mainSha(), before);
  assert.throws(() => P.promote(f.runner(), { base: tr.base, head, branch: 'main', tree: tr.tree }), /not a backlog branch/);
});

test('A02: the remote decides the result: a refused push is "not merged" with main unchanged; a reply lost after the push landed is still a merge', (t) => {
  const f = fixture(t);
  const head = f.branch('claude/backlog-one', { 'dashboard/core/callers/c3.txt': 'old\n' }, { item: 1 });
  const tr = f.testRun(head);
  const before = f.mainSha();
  const refused = P.promote(f.runner(), { base: tr.base, head, branch: 'claude/backlog-one', tree: tr.tree, push: () => { throw new Error('HTTP 409 (FICTIONAL)'); } });
  assert.equal(refused.status, 'push_failed');
  assert.equal(refused.branch_deleted, false, 'no delete without a merge');
  assert.match(P.summaryOf('promote', refused), /^### Not merged: the push was refused\n\nHTTP 409/);
  assert.equal(f.mainSha(), before);
  assert.match(g(f.work, 'ls-remote', '--heads', 'origin', 'claude/backlog-one'), /claude\/backlog-one/, 'the branch is kept');
  const lost = P.promote(f.runner(), { base: tr.base, head, branch: 'claude/backlog-one', tree: tr.tree, push: (cwd, remote, merge) => { g(cwd, 'push', '-q', remote, `${merge}:refs/heads/main`); throw new Error('timed out (FICTIONAL)'); } });
  assert.equal(lost.status, 'merged');
  assert.equal(f.mainSha(), lost.merge);
  assert.equal(lost.branch_deleted, true);
});

test('A02: a branch that moved after the merge is kept, and the PR state that cannot be read is said', (t) => {
  const f = fixture(t);
  const head = f.branch('claude/backlog-one', { 'dashboard/core/callers/c3.txt': 'old\n' }, { item: 1 });
  const tr = f.testRun(head);
  const push = (cwd, remote, merge, base) => {
    g(cwd, 'push', '-q', `--force-with-lease=refs/heads/main:${base}`, remote, `${merge}:refs/heads/main`);
    f.branch('claude/backlog-one', { 'dashboard/core/callers/c5.txt': 'old\n' }, { item: 1, from: 'claude/backlog-one' });
  };
  const gh = () => { throw new Error('HTTP 502 (FICTIONAL)'); };
  const r = P.promote(f.runner(), { base: tr.base, head, branch: 'claude/backlog-one', tree: tr.tree, push, repo: 'o/r', number: 9, gh });
  assert.equal(r.status, 'merged');
  assert.equal(r.branch_deleted, false);
  assert.match(r.branch_note, /moved past the tested commit/);
  assert.match(g(f.work, 'ls-remote', '--heads', 'origin', 'claude/backlog-one'), /claude\/backlog-one/);
  assert.match(P.summaryOf('promote', r), /The PR's state could not be read \(HTTP 502/);
});

test('A01: the scope gate holds protected paths, a backlog edit, an edited template, a commit with no item and an item not buildable for Eric', (t) => {
  const f = fixture(t);
  const base = f.mainSha();
  const scope = (files, opts) => { const head = f.branch(`claude/backlog-s${Math.random().toString(36).slice(2, 7)}`, files, opts); return P.scopeCheck(f.work, { base, head }); };
  const ok = scope({ 'dashboard/core/callers/c9.txt': 'old\n', 'templates/prompt.v2.md': 'v2\n' }, { item: 2 });
  assert.equal(ok.ok, true, ok.reasons.join('; '));
  assert.deepEqual(ok.items, [2]);
  assert.match(P.summaryOf('scope', ok), /^Scope: items 2, 1 commit, no protected path\.$/);
  const cases = [
    [{ '.github/workflows/test.yml': 'x\n' }, { item: 1 }, /\.github\/workflows\/test\.yml: CI and promotion workflows/],
    [{ 'dashboard/mcp.js': 'x\n' }, { item: 1 }, /authorization/],
    [{ 'dashboard/core/portfolio.js': 'x\n' }, { item: 1 }, /financial records/],
    [{ 'dashboard/scripts/backlog-promote.js': 'x\n' }, { item: 1 }, /promotion controls/],
    [{ 'dashboard/web/package.json': '{}\n' }, { item: 1 }, /dependencies/],
    [{ 'DESK_STATE.md': `${DESK}- [ ] **5. Self-approved.** x\n` }, { item: 1 }, /DESK_STATE\.md: the backlog/],
    [{ 'templates/prompt.v1.md': 'v1 edited\n' }, { item: 1 }, /a published template is edited/],
    [{ 'dashboard/core/x.txt': 'x\n' }, { message: 'backlog: no trailer' }, /names no Backlog-Item/],
    [{ 'dashboard/core/x.txt': 'x\n' }, { item: 9 }, /item 9 is not on main's backlog/],
    [{ 'dashboard/core/x.txt': 'x\n' }, { item: 3 }, /item 3 is marked \(Eric\)/],
    [{ 'dashboard/core/x.txt': 'x\n' }, { item: 4 }, /item 4 is already ticked/],
  ];
  for (const [files, opts, re] of cases) {
    const r = scope(files, opts);
    assert.equal(r.ok, false, String(re));
    assert.ok(r.reasons.some((x) => re.test(x)), `${re}: ${r.reasons.join('; ')}`);
    assert.match(P.summaryOf('scope', r), /^### Needs Eric: not promoted/);
  }
  assert.deepEqual([...P.backlogItems(DESK).entries()].map(([k, v]) => [k, v.ticked, v.eric]), [[1, false, false], [2, false, false], [3, false, true], [4, true, false]]);
});

test('A01: a conflict with main is said and lands nothing', (t) => {
  const f = fixture(t);
  f.branch('claude/backlog-x', { 'dashboard/core/lib.txt': 'mid\n' }, { item: 1 });
  const x = f.testRun(g(f.work, 'rev-parse', 'HEAD'));
  assert.equal(P.promote(f.runner(), { base: x.base, head: g(f.work, 'rev-parse', 'HEAD'), branch: 'claude/backlog-x', tree: x.tree }).status, 'merged');
  const y = f.branch('claude/backlog-y', { 'dashboard/core/lib.txt': 'other\n' }, { item: 2, from: g(f.work, 'rev-parse', 'HEAD~1') });
  const c = f.testRun(y);
  assert.equal(c.status, 'conflict');
  assert.deepEqual(c.files, ['dashboard/core/lib.txt']);
  assert.match(P.summaryOf('compose', c), /does not merge cleanly onto main/);
});

// Review N9 (2026-10-26): Eric's PC ignores letter case and drops a name's
// trailing dots and spaces, and Git for Windows writes an 8.3 short name
// through to the file it names. A branch is read the way that PC reads it.
test('N9: the scope gate reads paths as Windows does: letter case, collisions, short names, odd names and nested agent files wait for Eric', (t) => {
  const f = fixture(t);
  const base = f.mainSha();
  const blob = (text) => { const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.work, input: text, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  // Built in the index, as a branch made on Linux arrives: this PC would
  // write claude.md over CLAUDE.md, and refuses some names outright.
  let n = 0;
  const scope = (entries, { remove = [], item = 1 } = {}) => {
    g(f.work, 'checkout', '-q', '-f', '-B', `claude/backlog-n9-${n++}`, base);
    for (const p of remove) g(f.work, 'rm', '-q', '--cached', p);
    for (const [p, text] of entries) g(f.work, '-c', 'core.protectNTFS=false', 'update-index', '--add', '--cacheinfo', `100644,${blob(text)},${p}`);
    g(f.work, 'commit', '-qm', `backlog: item ${item}\n\nBacklog-Item: ${item}`);
    const head = g(f.work, 'rev-parse', 'HEAD');
    g(f.work, 'checkout', '-q', '-f', base);
    return P.scopeCheck(f.work, { base, head });
  };
  const held = (entries, re, opts) => {
    const r = scope(entries, opts);
    assert.equal(r.ok, false, `${entries.map((e) => e[0]).join(', ')} must be held`);
    assert.ok(r.reasons.some((x) => re.test(x)), `${re}: ${r.reasons.join('; ')}`);
    return r;
  };
  // The three from the review, each alone.
  held([['claude.md', 'INJECTED (FICTIONAL)\n']], /^claude\.md: agent instructions$/);
  held([['desk_state.md', '## Autonomous Build Backlog\n- [ ] **9. Nine.** x\n']], /^desk_state\.md: the backlog/);
  held([['.Claude/settings.json', '{"hooks":{}}\n']], /^\.Claude\/settings\.json: agent definitions and permissions$/);
  // A file and a folder that collide with tracked paths, unprotected as they are.
  held([['dashboard/core/LIB.txt', 'x\n']], /^dashboard\/core\/LIB\.txt: dashboard\/core\/LIB\.txt and dashboard\/core\/lib\.txt differ only in letter case or a trailing dot or space, which makes them one file on Windows$/);
  held([['Dashboard/core/new.txt', 'x\n']], /^Dashboard\/core\/new\.txt: Dashboard and dashboard differ only in letter case/);
  // Short names and names Windows cannot hold.
  held([['DESK_S~1.MD', 'INJECTED (FICTIONAL)\n']], /^DESK_S~1\.MD: an 8\.3 short name, which Windows can read as another file$/);
  held([['dashboard/core/CALLER~1/c1.txt', 'x\n']], /an 8\.3 short name/);
  held([['CLAUDE.md.', 'x\n']], /^CLAUDE\.md\.: agent instructions$/);
  held([['dashboard/core/lib.txt ', 'x\n']], /^dashboard\/core\/lib\.txt : a name ending in a dot or a space, which Windows drops$/);
  held([['dashboard/core/a:b.txt', 'x\n']], /a character Windows does not allow in a name/);
  held([['dashboard/core/aux.txt', 'x\n']], /a reserved Windows device name/);
  // A name Git would print quoted is read as it is.
  held([['.claude/café.md', 'x\n']], /^\.claude\/café\.md: agent definitions and permissions$/);
  // Agent instructions and settings at any depth (proposed with N9; removable).
  for (const p of ['dashboard/web/CLAUDE.md', 'docs/engineering/claude.local.md', 'dashboard/AGENTS.md', 'dashboard/web/.claude/settings.json', '.mcp.json']) {
    held([[p, 'x\n']], /agent instructions or settings, which agents read at any depth$/);
  }
  // Ordinary work still passes: a new file, and a rename that changes only case.
  assert.deepEqual(scope([['dashboard/core/callers/c9.txt', 'old\n']]).reasons, []);
  assert.deepEqual(scope([['dashboard/core/callers/C1.txt', 'old\n']], { remove: ['dashboard/core/callers/c1.txt'] }).reasons, []);
  assert.equal(P.foldPath('.Claude/Settings.json.'), '.claude/settings.json');
  assert.equal(P.protectedHit('Dashboard/Engineering/inbox.js').why, 'engineering authorization (the inbox, delegations and their connector)');
});

// Review N3 (2026-10-26): a symbolic link can point a served file anywhere on
// the host, and a submodule pulls in code from elsewhere. A branch that adds
// either waits for Eric, whatever path it is at; removing one does not.
test('N3: the scope gate holds a symbolic link or a submodule; removing one is not held', (t) => {
  const f = fixture(t);
  const blob = (text) => { const r = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.work, input: text, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  // Built in the index: Git records the mode, nothing is linked on disk.
  let n = 0;
  const scope = (base, entries, { remove = [] } = {}) => {
    g(f.work, 'checkout', '-q', '-f', '-B', `claude/backlog-n3-${n++}`, base);
    for (const p of remove) g(f.work, 'rm', '-q', '--cached', p);
    for (const [mode, oid, p] of entries) g(f.work, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${p}`);
    g(f.work, 'commit', '-qm', 'backlog: item 1\n\nBacklog-Item: 1');
    const head = g(f.work, 'rev-parse', 'HEAD');
    g(f.work, 'checkout', '-q', '-f', base);
    return P.scopeCheck(f.work, { base, head });
  };
  const base = f.mainSha();
  const link = scope(base, [['120000', blob('fictional-target.txt'), 'dashboard/public/views/linked.css']]);
  assert.equal(link.ok, false);
  assert.deepEqual(link.reasons, ['dashboard/public/views/linked.css: a symbolic link (mode 120000), which a branch never adds without Eric']);
  const sub = scope(base, [['160000', 'a'.repeat(40), 'vendor/tool']]);
  assert.equal(sub.ok, false);
  assert.deepEqual(sub.reasons, ['vendor/tool: a submodule (mode 160000), which a branch never adds without Eric']);
  assert.deepEqual(scope(base, [['100644', blob('export default 1;\n'), 'dashboard/public/views/fine.js']]).reasons, [], 'a regular file');
  // A link already on main: changing it is held, removing it is not.
  g(f.work, 'checkout', '-q', '-f', '-B', 'main', base);
  g(f.work, 'update-index', '--add', '--cacheinfo', `120000,${blob('elsewhere')},docs/old-link`);
  g(f.work, 'commit', '-qm', 'a link on main (FICTIONAL)');
  g(f.work, 'push', '-q', 'origin', 'main');
  const base2 = f.mainSha();
  assert.deepEqual(scope(base2, [['120000', blob('somewhere-else'), 'docs/old-link']]).reasons, ['docs/old-link: a symbolic link (mode 120000), which a branch never adds without Eric']);
  assert.deepEqual(scope(base2, [], { remove: ['docs/old-link'] }).reasons, [], 'a link removed');
});

// Backlog item 65: the rules a delegation never reaches, and the one template
// that lifts some of them.
// Eric, 2026-10-26 (audits/2026-10-26-backend-autonomy): dashboard/core/ is
// lifted for eng-backend@1 alone.
test('65: DELEGATION_RESTRICTED lifts only the app source, the bundle and three stylesheets for eng-app@4, and core for eng-backend@1', () => {
  const lifts = P.DELEGATION_RESTRICTED.filter((x) => x.lifted);
  assert.ok(lifts.length >= 6);
  for (const x of lifts) assert.deepEqual(Object.keys(x.lifted), x.prefix === 'dashboard/core/' ? ['eng-backend@1'] : ['eng-app@4'], `${x.prefix} is lifted for one template alone`);
  assert.deepEqual(lifts.map((x) => x.prefix).sort(), ['dashboard/core/', 'dashboard/public/app/', 'dashboard/public/position.css', 'dashboard/public/styles.css', 'dashboard/public/tokens.css', 'dashboard/web/']);
  for (const [p, tpl, held] of [
    ['dashboard/web/src/App.jsx', 'eng-app@4', false], ['dashboard/web/src/App.jsx', 'eng-app@3', true], ['dashboard/web/src/App.jsx', undefined, true],
    ['dashboard/web/index.html', 'eng-app@4', true], ['dashboard/web/scripts/check.mjs', 'eng-app@4', true],
    ['dashboard/public/app/assets/index-1.js', 'eng-app@4', false], ['dashboard/public/tokens.css', 'eng-app@4', false], ['dashboard/public/tokens.css', 'eng-app@3', true],
    ['dashboard/public/favicon.svg', 'eng-app@4', true], ['dashboard/core/wallets.js', 'eng-app@4', true],
    ['dashboard/core/projects.js', 'eng-backend@1', false], ['dashboard/core/projects.js', 'eng-app@4', true], ['dashboard/web/src/App.jsx', 'eng-backend@1', true],
    ['dashboard/tests/engineering-inbox.test.js', 'eng-backend@1', true],
    ['dashboard/tests/guardrails.test.js', 'eng-app@4', true], ['dashboard/tests/backlog-promote.test.js', 'eng-app@4', true], ['dashboard/tests/web-app.test.js', 'eng-app@4', true],
    ['dashboard/tests/screening.test.js', 'eng-app@4', false],
  ]) assert.equal(Boolean(P.restrictedFor(p, tpl)), held, `${p} for ${tpl}`);
});

// 2026-10-26: one reading of an engineering entry for the worker and the
// desk's GitHub proof, and revisions resolved where git exists.
test('engEntryOf reads one engineering item, its own detail lines and its number', () => {
  const task = 'eng-20261026-9c21de';
  const line = `- [ ] **65. Lane item (FICTIONAL).** text *(engineering task ${task} v1, sha256 0123456789abcdef)*`;
  const text = ['## Autonomous Build Backlog', '- [ ] **1. One.** a', line, '  - detail one', '  - detail two', '- [ ] **66. Next.** b', '  - not this', ''].join('\n');
  assert.deepEqual(P.engEntryOf(text, task), { entry: `${line}\n  - detail one\n  - detail two\n`, number: 65 });
  assert.equal(P.engEntryOf(text, 'eng-20261026-aaaaaa'), null);
  assert.equal(P.engEntryOf('', task), null);
  assert.equal(P.engEntryOf(null, task), null);
});

test('promotion resolves --base and --head given as a short SHA, a branch or a tag, and leaves anything else to its checks', (t) => {
  const f = fixture(t);
  const head = f.branch('claude/backlog-item-1', { 'docs/a.md': 'a\n' });
  g(f.work, 'tag', 'fictional-tag', head);
  const main = f.mainSha();
  for (const rev of [head, head.slice(0, 7), 'claude/backlog-item-1', 'fictional-tag']) assert.equal(P.resolveRevs(f.work, { head: rev }).head, head, rev);
  assert.equal(P.resolveRevs(f.work, { base: 'origin/main' }).base, main);
  // A name that resolves to nothing, or is not a plain revision, stays as given for the checks to refuse.
  assert.equal(P.resolveRevs(f.work, { head: 'no-such-branch' }).head, 'no-such-branch');
  assert.equal(P.resolveRevs(f.work, { head: '--all' }).head, '--all');
  assert.deepEqual(P.resolveRevs(f.work, { branch: 'claude/backlog-item-1' }), { branch: 'claude/backlog-item-1' }, 'only --base and --head');
});
