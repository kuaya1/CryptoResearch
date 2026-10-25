'use strict';
// The morning visual sanity report (dashboard/scripts/sanity-report.js; Eric,
// 2026-10-25, audits/2026-10-25-visual-proof): every value names its source,
// what nothing measured reads unknown or not read, the visual lines stay
// unticked boxes (never "Verified"), nothing is called a consensus, a desk
// snapshot never reaches a pull request comment, and the branch's own visual
// proof is read as untrusted data. A temporary git repo, a stubbed `gh`,
// fictional files only; no network, no model.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { hashTree } = require('./helpers');
const S = require('../scripts/sanity-report');

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const g = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
const tmp = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// What a write would change: the files and every ref. (Git may refresh its
// own index's stat data on a read, so .git's files are not compared.)
const repoState = (w) => {
  const files = hashTree(w);
  for (const k of Object.keys(files)) if (k.split(path.sep)[0] === '.git') delete files[k];
  return { files, refs: g(w, 'for-each-ref', '--format=%(refname) %(objectname)') };
};

// A PNG signature and IHDR are all the reader looks at.
function png(w = 1440, h = 900) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const SUMMARY = '### node dashboard/cli.js test\n\n- tests 907\n- suites 0\n- pass 907\n- fail 0\n- cancelled 0\n- skipped 0\n- todo 0\n- duration_ms 55443.1\n';

function proofDir(t, overrides = {}) {
  const dir = tmp(t, 'cr-proof-');
  const shots = [
    { name: 'desk', ready: true, measures: { rows: 16, row_height_px: 61, name_font_px: 15, name_weight: 600, columns: 7, consensus_marks: { graded: 18, waiting: 3, withheld: 2, problem: 2, hold: 16, none: 7 } }, errors: [], writes: [] },
    { name: 'inspector', ready: true, measures: { strip: true, cells: 4, one_row: true, wrapped_heads: 0, wrapped_notes: 2, inspector_width_px: 620 }, errors: [], writes: [] },
    { name: 'review', ready: true, measures: { panes: 3, raw_ids_visible: 2, raw_id_samples: ['fr_2026-10-25T165028Z_a5mnd', '2026-10-25_claude_64bfff06'] }, errors: [], writes: [] },
    { name: 'portfolio', ready: true, measures: { badge: true, needs_attention: 3 }, errors: [], writes: [] },
  ];
  const proof = { schema_version: 'cr.visual-proof.v1', desk: 'fictional', theme: 'light', viewport: { width: 1440, height: 900 }, taken_at: '2026-10-25T16:50:30.351Z', shots, ...overrides };
  put(dir, 'proof.json', JSON.stringify(proof));
  for (const s of shots) put(dir, `${s.name}.png`, png());
  put(dir, 'check.txt', 'ok   / opens search\nok   J moves down\n\nAll browser checks passed.\n');
  put(dir, 'regress.txt', 'ok   F1 a\n\n78 of 78 regression checks passed (production build).\n');
  return dir;
}

// main, then a backlog branch with two items, left unmerged (pr) or merged
// with a merge commit as backlog-promote.js does (morning).
function repo(t, { merge = false } = {}) {
  const work = tmp(t, 'cr-sanity-repo-');
  g(work, 'init', '-q', '-b', 'main');
  put(work, 'a.txt', 'a'); g(work, 'add', '-A'); g(work, 'commit', '-qm', 'base');
  g(work, 'checkout', '-q', '-b', 'claude/backlog-batch-items-36-and-37');
  put(work, 'b.txt', 'b'); g(work, 'add', '-A'); g(work, 'commit', '-qm', 'backlog: one\n\nBacklog-Item: 36');
  put(work, 'c.txt', 'c'); g(work, 'add', '-A'); g(work, 'commit', '-qm', 'backlog: two\n\nBacklog-Item: 37');
  const head = g(work, 'rev-parse', 'HEAD');
  g(work, 'checkout', '-q', 'main');
  if (merge) g(work, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #11 from kuaya1/claude/backlog-batch-items-36-and-37', head);
  return { work, head };
}

function snapshot(t, extra = {}) {
  const dir = tmp(t, 'cr-snap-');
  const job = (waiting, more = {}) => ({ waiting, queued: 0, on_api: 0, with_assistant: 0, uncertain: 0, ...more });
  const snap = {
    schema_version: 'cr.desk-snapshot.v1',
    taken_at: '2026-10-25T11:00:00Z',
    desk_status: {
      revision: { commit: 'a'.repeat(40), short: 'aaaaaaa', source: 'render' },
      prices: { freshness: 'fresh' },
      research: { models: {
        claude: { status: 'manual', key: { present: false }, jobs: job(0) },
        chatgpt: { status: 'manual', key: { present: false }, jobs: job(4) },
        gemini: { status: 'on_hold', key: { present: false }, jobs: job(2) },
      } },
    },
    daily_brief: {
      format: 'cr-daily-brief@1',
      text_sha256: 'b'.repeat(64),
      sections: [
        { id: 'pm_cards', state: 'ok', count: 2 },
        { id: 'pilot_exits', state: 'partial', count: null, count_read: 1, unreadable_count: 1 },
      ],
    },
    ...extra,
  };
  const file = path.join(dir, 'snap.json');
  fs.writeFileSync(file, JSON.stringify(snap));
  return file;
}

test('counts, ranges and escaping', () => {
  assert.deepEqual(S.parseTestSummary(SUMMARY), { tests: 907, pass: 907, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(S.parseTestSummary('no counts here'), null);
  assert.equal(S.itemRange([38, 36, 37]), '#36–38');
  assert.equal(S.itemRange([7, 8, 9, 12, 14, 15]), '#7–9, #12, #14–15');
  assert.equal(S.itemRange([]), null);
  assert.equal(S.esc('a *b* [c](d) <img> `x`\n#h'), 'a \\*b\\* \\[c\\](d) \\<img\\> \\`x\\` \\#h', 'no link, image, tag or code can form; parentheses alone cannot');
});

test('pull request mode: the batch from trailers, measured values beside their targets, unticked boxes, every source named', (t) => {
  const r = repo(t);
  const proof = proofDir(t);
  const counts = path.join(tmp(t, 'cr-counts-'), 'test-summary.md');
  fs.writeFileSync(counts, SUMMARY);
  const before = repoState(r.work);
  const rep = S.build({ cwd: r.work, pr: true, head: r.head, branch: 'claude/backlog-batch-items-36-and-37', base: 'main', repo: 'kuaya1/fictional', prUrl: 'https://github.com/kuaya1/fictional/pull/12', prState: 'merged', proof, tests: counts });
  const md = S.render(rep, { imagesBase: `https://github.com/kuaya1/fictional/raw/visual-proof/${r.head}` });
  assert.deepEqual(repoState(r.work), before, 'the repo is only read');

  assert.ok(md.startsWith(S.MARKER), 'the comment carries its marker first');
  assert.match(md, /Build batch: #36–37 \|/);
  assert.match(md, new RegExp(`Status: unit tests passed on ${r.head.slice(0, 7)}`));
  assert.match(md, /- \[ \] \*\*Desk table:\*\* rows 61px \(target 60px\); names 15px \/ 600 \(target 15px\); 7 columns shown; model marks drawn: 18 graded, 3 waiting ○/);
  assert.match(md, /- \[ \] \*\*Inspector drawer:\*\* Key metrics: 4 cells in one row; no label or figure wraps; the notes under a figure wrap in 2 cells/);
  assert.match(md, /2 raw record IDs or hashes in visible text \(`fr_2026-10-25T165028Z_a5mnd`, `2026-10-25_claude_64bfff06`\)/);
  assert.match(md, /Needs attention badge reads 3 on the fictional desk; the live count has no read-only source/);
  assert.match(md, /FICTIONAL desk in headless Chrome at 1440×900/);
  assert.match(md, /already merged when these screenshots were posted/);
  assert.match(md, /unit 907 of 907 passed; browser checks check\.mjs passed \(0 failures\); regress\.mjs 78 of 78 passed/);
  assert.match(md, /Waiting jobs:\*\* not read: CI has no access to the live desk/);
  assert.match(md, /Exit quotes \(KyberSwap, Jupiter\):\*\* unknown/);
  for (const name of ['desk', 'inspector', 'review', 'portfolio']) assert.ok(md.includes(`<img src="https://github.com/kuaya1/fictional/raw/visual-proof/${r.head}/${name}.png"`), name);
  assert.match(md, /\[Live production desk\]\(https:\/\/cryptoresearch\.onrender\.com\)/);
  assert.match(md, /\[This pull request\]\(https:\/\/github\.com\/kuaya1\/fictional\/pull\/12\) \(merged\)/);

  assert.doesNotMatch(md, /- \[x\]/i, 'no box is ticked');
  assert.doesNotMatch(md, /\bverified\b|\bconfirmed\b/i);
  assert.doesNotMatch(md, /consensus engine|consensus:/i);
  assert.doesNotMatch(md, /90.*dropped to.*9/);
  for (const v of ['Date', 'Build batch', 'Unit tests', 'Section 1 (visual surfaces)', 'Browser checks', 'Waiting jobs and models', 'Status', 'Live desk link', 'Pull request link']) {
    assert.ok(rep.sources.some((s) => s.value === v && s.source), `${v} names its source`);
  }
});

test('a desk snapshot is never rendered into a pull request comment', (t) => {
  const r = repo(t);
  assert.throws(() => S.build({ cwd: r.work, pr: true, head: r.head, base: 'main', desk: snapshot(t) }), /never rendered into a pull request comment/);
});

test('nothing measured reads not measured or unknown, never a number', (t) => {
  const r = repo(t);
  const rep = S.build({ cwd: r.work, pr: true, head: r.head, base: 'main', repo: 'kuaya1/fictional' });
  const md = S.render(rep);
  assert.equal(rep.visual.length, 4);
  for (const v of rep.visual) assert.match(v.words, /not measured: no visual proof for this commit/);
  assert.match(md, /Status: CI result unknown for /);
  assert.match(md, /unit unknown: no test counts were given or found; browser checks not run/);
  assert.match(md, /Nothing measured: no visual proof for this commit/);
  assert.doesNotMatch(md, /<img/);
});

test('the branch\'s proof is untrusted: fixed names, PNG signatures, numbers only, text escaped', (t) => {
  const dir = proofDir(t);
  const proof = JSON.parse(fs.readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  proof.shots[0].measures.row_height_px = '60px"><script>';
  proof.shots[0].measures.extra = 'ignored';
  proof.shots[0].errors = ['boom `x`\n![img](https://evil.example/p.png)'];
  proof.shots[0].writes = ['POST /api/projects/x/reviewed'];
  proof.shots[2].measures.raw_id_samples = ['fr_2026-10-25T165028Z_a5mnd', '[click](https://evil.example)', '<img src=x>'];
  proof.shots.push({ name: '../../evil', ready: true });
  fs.writeFileSync(path.join(dir, 'proof.json'), JSON.stringify(proof));
  fs.writeFileSync(path.join(dir, 'portfolio.png'), 'not a png');
  put(dir, 'evil.png', png());

  const out = tmp(t, 'cr-images-');
  const v = S.validateProof(dir, { imagesOut: out });
  assert.equal(v.present, true);
  assert.deepEqual(fs.readdirSync(out).sort(), ['desk.png', 'inspector.png', 'review.png'], 'only the fixed names, and only real PNGs');
  const desk = v.shots.find((s) => s.name === 'desk');
  assert.equal(desk.measures.row_height_px, null, 'a string is not a measurement');
  assert.equal('extra' in desk.measures, false);
  assert.deepEqual(v.shots.find((s) => s.name === 'review').measures.raw_id_samples, ['fr_2026-10-25T165028Z_a5mnd']);
  assert.equal(v.shots.find((s) => s.name === 'portfolio').image, null);
  assert.ok(v.problems.some((p) => /Portfolio: no usable PNG/.test(p)));

  const lines = S.visualLines(v);
  const d = lines.find((l) => l.id === 'desk');
  assert.match(d.words, /row height not measured/);
  assert.match(d.page, /1 console error \(`boom  x  !\[img\]\(https:\/\/evil\.example\/p\.png\)`\)/, 'inside a code span, with no backtick or line break left');
  assert.match(d.page, /1 write on opening \(`POST \/api\/projects\/x\/reviewed`\)/);

  const bad = proofDir(t, { desk: 'live' });
  assert.equal(S.validateProof(bad).present, false, 'only the fictional desk');
});

test('morning mode: the merged batch, the push run\'s counts through gh, the desk snapshot per model; the downloads are removed', (t) => {
  const r = repo(t, { merge: true });
  const calls = [];
  let downloadDir = null;
  const gh = (cwd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list') {
      return { status: 0, out: JSON.stringify([
        { databaseId: 2, conclusion: 'failure', status: 'completed', event: 'pull_request', url: 'https://github.com/kuaya1/fictional/actions/runs/2' },
        { databaseId: 1, conclusion: 'success', status: 'completed', event: 'push', url: 'https://github.com/kuaya1/fictional/actions/runs/1' },
      ]), err: '' };
    }
    if (args[0] === 'run' && args[1] === 'download') {
      assert.equal(args[2], '1', 'the push run, the one promotion gates on');
      downloadDir = args[args.indexOf('-D') + 1];
      put(downloadDir, 'test-summary.md', SUMMARY);
      return { status: 0, out: '', err: '' };
    }
    if (args[0] === 'api' && /actions\/artifacts/.test(args[1])) return { status: 0, out: JSON.stringify({ artifacts: [] }), err: '' };
    if (args[0] === 'api' && /\/pulls$/.test(args[1])) return { status: 0, out: JSON.stringify([{ html_url: 'https://github.com/kuaya1/fictional/pull/11', number: 11, merged_at: '2026-10-25T16:08:00Z', state: 'closed' }]), err: '' };
    return { status: 1, out: '', err: 'unexpected' };
  };
  const rep = S.build({ cwd: r.work, gh, repo: 'kuaya1/fictional', since: '24h', desk: snapshot(t) });
  const md = S.render(rep);
  assert.ok(downloadDir && !fs.existsSync(downloadDir), 'the temporary download folder is removed');
  assert.ok(calls.some((c) => c.startsWith(`run list --workflow test.yml --commit ${r.head}`)));

  assert.match(md, /Build batch: #36–37 \|/);
  assert.match(md, new RegExp(`Status: unit tests passed on ${r.head.slice(0, 7)}`));
  assert.ok(rep.sources.find((s) => s.value === 'Unit tests').source.includes('push test run'));
  assert.match(md, /Models, each on its own \(nothing averaged or called a consensus\):\*\* Claude: manual, no API key on the desk; nothing waiting; ChatGPT: manual, no API key on the desk; 4 waiting ○; Gemini: on hold, no API key on the desk; 2 waiting ○/);
  assert.match(md, /Waiting jobs:\*\* 6 research jobs waiting, queued or uncertain on the desk \(snapshot taken 2026-10-25T11:00:00Z; Claude 0, ChatGPT 4, Gemini 2 waiting\); PM cards waiting for you: 2/);
  assert.match(md, /pilot projects missing an exit reading: 1 read, 1 could not be read, so the count is unknown/);
  assert.match(md, /Exit quotes \(KyberSwap, Jupiter\):\*\* refresh age unknown/);
  assert.match(md, new RegExp(`Deploy:\\*\\* the desk in the snapshot runs \`aaaaaaa\`; the newest merged head is \`${r.head.slice(0, 7)}\``));
  assert.match(md, /\[Pull request #11\]\(https:\/\/github\.com\/kuaya1\/fictional\/pull\/11\) \(merged\)/);
  assert.match(md, /Section 1 \(visual surfaces\) \| no visual proof given or found/);
  assert.match(md, /no visual-proof artifact for /);
  assert.ok(rep.sources.find((s) => s.value === 'Waiting jobs and models').source.includes('cr-daily-brief@1'));
  assert.doesNotMatch(md, /\bverified\b|\bconfirmed\b/i);
});

test('morning mode without gh or a snapshot says what was not read', (t) => {
  const r = repo(t, { merge: true });
  const signedOut = () => ({ status: 1, out: '', err: 'not logged in' });
  const md = S.render(S.build({ cwd: r.work, gh: signedOut, repo: 'kuaya1/fictional' }));
  assert.match(md, /Status: CI result unknown for /);
  assert.match(md, /gh could not list the test runs \(not logged in\)/);
  assert.match(md, /Waiting jobs:\*\* not read: no desk snapshot given \(--desk\)/);
  assert.match(md, /As recorded on 2026-10-25, not read now: Gemini on hold on the online desk; ChatGPT and Gemini with no API key on Render/);
  const quiet = S.render(S.build({ cwd: r.work, gh: signedOut, repo: 'kuaya1/fictional', since: '2026-01-01T00:00:00Z', now: Date.parse('2026-01-02T00:00:00Z') }));
  assert.match(quiet, /Build batch: nothing merged since/);
  assert.match(quiet, /Status: no backlog merge in the window/);
});

test('the command line refuses an image address off GitHub and a snapshot of another format', (t) => {
  const r = repo(t);
  assert.throws(() => S.main(['--pr', '--head', r.head, '--images-base', 'https://evil.example/x']), /--images-base must be/);
  assert.throws(() => S.main(['--pr']), /--pr needs --head/);
  const bad = path.join(tmp(t, 'cr-snap-'), 's.json');
  fs.writeFileSync(bad, JSON.stringify({ schema_version: 'other' }));
  assert.throws(() => S.build({ cwd: r.work, gh: () => ({ status: 1, out: '', err: '' }), desk: bad }), /not cr\.desk-snapshot\.v1/);
});
