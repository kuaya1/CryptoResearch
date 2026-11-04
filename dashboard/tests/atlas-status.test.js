'use strict';
// Stage 1.5, PR A2: the System Atlas is a static map, so nothing keeps it true
// on its own. These checks fail when its assets, its tokens or its status words
// leave repository truth. A failure about an item below usually means a later
// pull request changed that fact: update `stage15` in atlas/system.js in the
// same pull request, then `node atlas/build.mjs && node atlas/pdf.mjs`.
//
// Reads the repository's own files only; no network, no browser, no desk.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const ATLAS = path.join(ROOT, 'atlas');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHEET = read('docs', 'ONE-SHEET.md');

function load() {
  const sandbox = { window: {} };
  vm.runInNewContext(read('atlas', 'system.js'), sandbox);
  vm.runInNewContext(read('atlas', 'evidence.generated.js'), sandbox);
  // Through JSON, so strict comparison is not defeated by the sandbox's own Array.
  return { A: JSON.parse(JSON.stringify(sandbox.window.ATLAS)), EV: sandbox.window.ATLAS_EVIDENCE };
}
const { A, EV } = load();
const S = A.stage15;
const item = (n) => S.items.find((i) => i.n === n);

function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function fullClone(t) {
  let shallow;
  try { shallow = git('rev-parse', '--is-shallow-repository') === 'true'; } catch (_) { t.skip('no git history here'); return false; }
  if (shallow) { t.skip('shallow clone: these commits are not in its history'); return false; }
  return true;
}

// The two files as extracted from Architecture v17, by SHA-256. tokens.css
// differs by one line: the Atlas calls no network, so the font import is gone.
const SOURCE_TOKENS_SHA = '475bca926d3942956cbb5776dbb99d504aecd76f50edd605f7ed231b10836e0d';
const SOURCE_MAP_SHA = '81813d56b3cb4ea60c87e77dfaef68c92bed5775090dc3abefb4bfcc7ca2bf06';
const FONT_IMPORT = "@import url('https://fonts.googleapis.com/css2?family=Geist:wght@100;200;300;400;500;600&family=Geist+Mono:wght@400;500&display=swap');";
const IMPORT_NOTE = '/* Atlas copy: the Google Fonts @import that stood here is removed, because the Atlas calls no network. See atlas/README.md. */';
const CANONICAL = ['--cr-canvas', '--cr-obsidian', '--cr-live', '--cr-read', '--cr-tuning', '--cr-critical', '--cr-agent'];
const valueOf = (css, name) => {
  const m = new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(css);
  return m ? m[1].trim() : null;
};

test('every Atlas asset is in the repository, and the page loads the tokens first', () => {
  for (const f of ['index.html', 'atlas.css', 'atlas.js', 'system.js', 'evidence.generated.js', 'build.mjs', 'pdf.mjs', 'serve.mjs', 'README.md', 'CryptoResearch-System-Atlas.pdf', 'design-tokens/tokens.css', 'design-tokens/Token Map.md']) {
    assert.ok(fs.existsSync(path.join(ATLAS, f)), `atlas/${f} is missing`);
  }
  assert.equal(fs.readFileSync(path.join(ATLAS, 'CryptoResearch-System-Atlas.pdf')).subarray(0, 5).toString(), '%PDF-');
  const html = read('atlas', 'index.html');
  const tokens = html.indexOf('href="design-tokens/tokens.css"');
  const page = html.indexOf('href="atlas.css"');
  assert.ok(tokens > 0 && tokens < page, 'tokens.css must load before atlas.css');
});

test('the token files are the v17 extract, with only the font import removed', () => {
  const tokens = read('atlas', 'design-tokens', 'tokens.css');
  assert.equal(tokens.split(IMPORT_NOTE).length, 2, 'the note that replaces the import is there once');
  assert.equal(sha256(tokens.replace(IMPORT_NOTE, FONT_IMPORT)), SOURCE_TOKENS_SHA, 'tokens.css differs from the v17 extract by more than the font import');
  assert.equal(sha256(fs.readFileSync(path.join(ATLAS, 'design-tokens', 'Token Map.md'))), SOURCE_MAP_SHA, 'Token Map.md differs from the v17 extract');
});

test('the seven canonical tokens are defined, used by the page, and match the desk', () => {
  const tokens = read('atlas', 'design-tokens', 'tokens.css');
  const desk = read('dashboard', 'public', 'tokens.css');
  const css = read('atlas', 'atlas.css');
  for (const name of CANONICAL) {
    assert.ok(valueOf(tokens, name), `${name} is not defined in the Atlas tokens`);
    assert.equal(valueOf(tokens, name), valueOf(desk, name), `${name} differs between the Atlas and dashboard/public/tokens.css`);
    assert.ok(css.includes(`var(${name})`), `atlas.css never uses ${name}`);
  }
});

test('the Atlas stylesheet holds no colour of its own', () => {
  const css = read('atlas', 'atlas.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const raw = css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g) || [];
  assert.deepEqual(raw, [], 'every colour in atlas.css comes from a --cr-* token');
});

test('the page calls no network and stores nothing', () => {
  for (const f of ['index.html', 'atlas.css', 'atlas.js', 'system.js', 'evidence.generated.js', 'design-tokens/tokens.css']) {
    const text = read('atlas', f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(text, /@import\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB/, `atlas/${f}`);
    assert.doesNotMatch(text, /(?:src|href)=["']https?:|url\(\s*['"]?https?:/, `atlas/${f} loads something from outside`);
  }
});

test('it says it is a static map, not live telemetry, on every surface', () => {
  assert.match(A.staticNotice, /static architectural and status map, not a live telemetry backend/);
  const page = read('atlas', 'atlas.js');
  assert.ok(page.split('A.staticNotice').length - 1 >= 4, 'the bar, the cover, chapter 13 and the PDF each carry the notice');
  assert.match(read('atlas', 'README.md'), /not a live telemetry backend/);
});

test('the seven items carry Eric\'s classes, in four that stay apart', () => {
  assert.deepEqual(S.items.map((i) => i.n).sort(), [1, 2, 3, 4, 5, 6, 7]);
  const classOf = Object.fromEntries(S.items.map((i) => [i.n, i.cls]));
  assert.deepEqual(classOf, { 1: 'proof', 2: 'proof', 3: 'hold', 4: 'built', 5: 'code', 6: 'hold', 7: 'built' });
  assert.equal(S.classes.hold.name, 'Intentional hold by design');
  assert.equal(S.classes.proof.name, 'Pending operating proof');
  assert.equal(S.classes.code.name, 'Scheduled Stage 1.5 code slice');
  assert.equal(S.classes.built.name, 'Built in code');
  assert.match(S.classes.built.words, /not that it has run on real records/);
  assert.match(S.classes.hold.words, /not an engineering failure/);
  assert.equal(item(4).slice, null, 'item 4 was built by C2');
  assert.equal(item(5).slice, 'C3');
  assert.equal(item(7).slice, null, 'item 7 has no slice left: what stays open is Eric\'s');
  assert.match(S.classSource, /Neither is a file in this repository/, 'the rulings are said to live outside the repository');
});

test('each item\'s facts still hold in the code (a later slice updates its own item)', () => {
  // Built in code: goes red if the default or either packet's wiring moves back.
  assert.match(read('dashboard', 'core', 'screening.js'), /packet_mode: 'include'/, 'item 4: the default moved, so update item 4');
  assert.match(read('dashboard', 'core', 'workspace.js'), /packet_mode: 'include'/, 'item 4: the settings default moved, so update item 4');
  assert.match(read('dashboard', 'core', 'research.js'), /contract_screen: require\('\.\/screening'\)\.packetSection\(/, 'item 4: research no longer carries the screen');
  assert.match(read('dashboard', 'core', 'tickets.js'), /contract_screen: require\('\.\/screening'\)\.packetSection\(/, 'item 4: tickets no longer carry the screen');
  assert.match(item(4).now, /new research and ticket packets carry/);
  assert.match(item(4).now, /No real run has used it yet/, 'item 4: built is not run');
  assert.match(SHEET, /New research and ticket packets now carry GoPlus's contract flags from the saved screen \(C2/, 'item 4: the sheet stopped saying so');
  assert.doesNotMatch(read('atlas', 'system.js'), /Still in monitor mode|packet_mode is “monitor”/, 'the map still says monitor');
  assert.match(read('atlas', 'atlas.css'), /\.st15-built h3 \.pip \{/, 'the built class has no mark on the page');
  // Holds.
  assert.match(read('dashboard', 'core', 'paper-trader.js'), /function venueSend\(/, 'item 3');
  assert.match(item(3).now, /None exists/);
  assert.match(read('dashboard', 'hosted.js'), /const GEMINI_HOLD = \{/, 'item 6: the hold moved or was lifted');
  // Pending proof.
  assert.match(read('docs', 'engineering', 'OPS1_RENDER_CRON.md'), /\*\*Status: defined, not created\.\*\*/, 'item 1: Ops-1 changed');
  assert.match(item(1).now, /not created/);
  assert.ok(fs.existsSync(path.join(ROOT, 'dashboard', 'core', 'autonomy-proof.js')), 'item 2');
  assert.match(read('dashboard', 'cli.js'), /cmd === 'prove-autonomy'/, 'item 2');
  assert.match(item(2).now, /prove-autonomy \(#169, #171\)/);
  // Scheduled slices: each of these goes red in the pull request that builds it.
  assert.match(read('dashboard', 'core', 'explorer.js'), /if \(!dryRun\) \{\s*throw new ExplorerError\('REFUSED', `Sending real desk records/, 'item 5: C3 changed the refusal, so update item 5');
  assert.match(SHEET, /Still his and still open: the Law 1 credential\. The buy-and-hold baseline comparison is deferred to Stage 2/, 'item 7: the sheet\'s open list changed, so update item 7');
  assert.match(read('dashboard', 'core', 'grade-outcome-view.js'), /function accountingOf\(/, 'item 7: the fee accounting moved or went');
  assert.doesNotMatch(read('dashboard', 'core', 'grade-outcome-view.js'), /buy_and_hold|buy-and-hold/, 'item 7: a baseline was built, so update item 7');
  assert.match(item(7).now, /buy-and-hold baseline is not built; Eric deferred it to Stage 2/);
  assert.match(read('dashboard', 'core', 'paper.js'), /function parseRecords\(text\)[\s\S]*?new OpError\('INTEGRITY'/, 'item 7: A5 is closed only while the book refuses a bad line');
  assert.match(item(7).now, /A5 is closed in code \(B3\)/);
  assert.match(item(7).now, /Invariant 3 now names all nine protected files \(B2\)/);
  assert.match(item(7).now, /the stored gh login still reaches admin/, 'item 7: B1 closed the environment path only');
});

test('no operating proof is claimed while the sheet says there is none', () => {
  assert.match(SHEET, /\*\*Operating proof: none yet\.\*\*/, 'the sheet changed: update stage15.operatingProof and the items');
  assert.equal(S.operatingProof, 'none');
  const words = JSON.stringify({ items: S.items.map((i) => [i.name, i.now]), lede: A.chapters.find((c) => c.id === 'stage15').lede });
  assert.match(words, /Operating proof: none yet/);
  assert.doesNotMatch(words, /\bPASS\b|\bproven\b|\bverified\b|\bcompleted\b/i, 'an item reads as proved');
  assert.match(item(2).now, /No real B0, B1, B2, B3 or cutover evidence exists yet, and R0 must be repeated/);
});

test('the deployment line does not claim the R0 receipt describes this baseline', () => {
  const all = read('atlas', 'system.js') + read('atlas', 'atlas.js');
  assert.doesNotMatch(all, /identical to this baseline|same application code|changed documents only/);
  assert.match(A.baseline.deployed.words, /does not describe this baseline/);
  assert.match(A.baseline.deployed.words, /does not read which revision is deployed now/);
});

test('the four hosts are the sheet\'s four, name for name', () => {
  const start = SHEET.indexOf('| Host | What runs there |');
  assert.ok(start > 0, 'the sheet has its host table');
  const rows = SHEET.slice(start).split('\n').slice(2).filter((l) => l.startsWith('|'));
  const names = rows.map((l) => /\|\s*\*\*(.+?)\*\*/.exec(l)[1]);
  assert.deepEqual(S.hosts.map((h) => h.name), names);
  assert.equal(names.length, 4);
  assert.deepEqual(names, ['GitHub Actions', 'Render desk', 'Runner host', 'PC offsite backup']);
});

test('the boxes are the sheet\'s drawing, label for label, and no six-box set is invented', () => {
  const mermaid = /```mermaid\n([\s\S]*?)```/.exec(SHEET)[1];
  const seen = new Map();
  for (const m of mermaid.matchAll(/\b([A-Z]\w*)\[([^\]]+)\]/g)) seen.set(m[1], m[2]);
  const overlays = [...mermaid.matchAll(/\b[A-Z]\w*\{\{([^}]+)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...S.lifecycle].sort(), [...seen.values()].sort());
  assert.equal(S.lifecycle.length, 13);
  assert.deepEqual([...S.overlays].sort(), [...overlays].sort());
  assert.doesNotMatch(SHEET, /six[- ]box/i, 'the sheet now names six boxes, so show them in stage15 and drop boxNote');
  assert.match(S.boxNote, /No document in this repository names a set of six boxes/);
});

test('provenance runs #158 to #171 with #170 alone unmerged, and agrees with the sheet', () => {
  assert.deepEqual(S.prs.map(([n]) => n), Array.from({ length: 14 }, (_, i) => 158 + i));
  assert.deepEqual(S.prs.filter(([, sha]) => !sha).map(([n]) => n), [170]);
  const sheetPairs = new Map([...SHEET.matchAll(/#(\d+) `([0-9a-f]{7,40})`/g)].map((m) => [Number(m[1]), m[2]]));
  for (const [n, sha] of S.prs) {
    if (sheetPairs.has(n)) assert.equal(sha, sheetPairs.get(n), `#${n} differs from the sheet`);
  }
  assert.ok(sheetPairs.has(158) && sheetPairs.has(165), 'the sheet still lists the range this checks');
  assert.match(S.prs.find(([n]) => n === 170)[2], /^Closed unmerged/);
});

test('each named merge commit is that pull request\'s, on this history (a full clone; skipped on a shallow one)', (t) => {
  if (!fullClone(t)) return;
  for (const [n, sha] of S.prs) {
    if (sha) {
      assert.match(git('log', '-1', '--format=%s', sha), new RegExp(`#${n}\\b`), `#${n}`);
      git('merge-base', '--is-ancestor', sha, 'HEAD');
    } else {
      assert.equal(git('log', 'HEAD', '--format=%h', '--grep', `^Merge pull request #${n} `), '', `#${n} is named as not merged`);
    }
  }
});

test('the evidence was built from this system.js, and everything it cites still exists', () => {
  assert.equal(EV.system_sha256, sha256(fs.readFileSync(path.join(ATLAS, 'system.js'))), 'system.js changed without node atlas/build.mjs');
  const paths = new Set(Object.keys(EV.refs).map((k) => k.split('|')[0]));
  for (const p of paths) assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is cited but gone`);
  for (const i of S.items) for (const [p, a] of i.evidence) assert.ok(`${p}|${a}` in EV.refs, `item ${i.n}: ${p} was not resolved by the build`);
  for (const h of S.hosts) assert.ok(`${h.evidence[0]}|${h.evidence[1]}` in EV.refs, `${h.name} was not resolved by the build`);
});

test('the PDF was rendered from the page as it stands', () => {
  const stamp = JSON.parse(read('atlas', 'pdf-source.json'));
  const page = ['index.html', 'atlas.css', 'atlas.js', 'system.js', 'evidence.generated.js', 'design-tokens/tokens.css'];
  const now = sha256(page.map((f) => sha256(fs.readFileSync(path.join(ATLAS, f)))).join('\n'));
  assert.equal(stamp.page_sha256, now, 'the page changed without node atlas/pdf.mjs');
  assert.equal(stamp.pdf_sha256, sha256(fs.readFileSync(path.join(ATLAS, 'CryptoResearch-System-Atlas.pdf'))), 'the PDF is not the one that was rendered');
});

test('the source baseline is on this history (a full clone; skipped on a shallow one)', (t) => {
  if (!fullClone(t)) return;
  // Never "the baseline is HEAD": later pull requests move HEAD past it, and a
  // link pinned to an older commit is still true of that commit.
  git('merge-base', '--is-ancestor', EV.commit, 'HEAD');
});
