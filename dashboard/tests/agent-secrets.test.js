'use strict';
// The agent lane's scan for key-shaped strings (Engineering v3, change 1;
// audits/2026-10-26-engineering-v3): a hit names the file, the line and the
// kind of key, never the value, and the build's output dir loses the file
// that holds one before anything is uploaded. Every key here is FICTIONAL and
// assembled at run time, so this file holds none.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../scripts/agent-secrets');

const run = (n) => 'Q7x'.repeat(Math.ceil(n / 3)).slice(0, n);
const FAKE = {
  'an Anthropic key': ['sk', 'ant', `api03-${run(90)}`].join('-'),
  'an OpenAI key': ['sk', `proj-${run(48)}`].join('-'),
  'a GitHub token': `${'gh'}p_${run(36)}`,
  'a private key': `-----BEGIN ${'RSA'} PRIVATE KEY-----`,
  'an AWS access key': `${'AK'}IA${'ABCDEFGH23456789'}`,
  'an xAI key': `${'xai'}-${run(80)}`,
  'a Slack token': `${'xo'}xb-${run(24)}`,
  'a Google API key': `${'AI'}za${run(35)}`,
  'a Stripe live key': `${'sk'}_live_${run(24)}`,
  'an npm token': `${'npm'}_${run(36)}`,
};

test('each kind of key is found by line, and what is reported never holds the value', () => {
  for (const [kind, value] of Object.entries(FAKE)) {
    const hits = S.secretHits(`first line\nconst k = "${value}";\nlast`);
    assert.deepEqual(hits, [{ line: 2, kind }], kind);
    assert.ok(!S.describe({ path: 'x.js', ...hits[0] }).includes(value));
  }
  // Ordinary code and the ledger tests' short fictional strings are not keys.
  for (const ok of ['sk-FICTIONAL', 'const sk = 1;', 'AKIA', 'xai-short', 'module.exports = { size: (s) => s.trim().length };']) assert.deepEqual(S.secretHits(ok), [], ok);
});

test('a patch reports the file and the line the key lands on, from added lines only', () => {
  const key = FAKE['an Anthropic key'];
  const patch = [
    'diff --git a/dashboard/core/widget.js b/dashboard/core/widget.js',
    'index 1111111..2222222 100644',
    '--- a/dashboard/core/widget.js',
    '+++ b/dashboard/core/widget.js',
    '@@ -10,3 +10,4 @@ function size(s) {',
    ' const a = 1;',
    `-const old = "${FAKE['an OpenAI key']}";`,
    '+const b = 2;',
    `+const key = "${key}";`,
    '++ x; // an added line that starts with "++ "',
    ' module.exports = {};',
  ].join('\n');
  const hits = S.patchHits(patch);
  assert.deepEqual(hits, [{ path: 'dashboard/core/widget.js', line: 12, kind: 'an Anthropic key' }], 'the removed line is main\'s; the added key is on line 12');
  assert.equal(S.describe(hits[0]), 'dashboard/core/widget.js:12 (an Anthropic key)');
  assert.ok(!JSON.stringify(hits).includes(key));
  // A key in a file name is the patch's own line.
  const named = S.patchHits(`diff --git a/x b/${FAKE['an npm token']}.js\n--- /dev/null\n+++ b/${FAKE['an npm token']}.js\n@@ -0,0 +1 @@\n+ok`);
  assert.deepEqual(named.map((h) => [h.path, h.line]), [['(patch)', 1], ['(patch)', 3]]);
});

test('the output dir loses each file that holds a key; scan.json says where, never what', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-secrets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = FAKE['a GitHub token'];
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ result: `I found ${key} in the environment.` }));
  fs.writeFileSync(path.join(dir, 'patch.diff'), 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n');
  const r = S.scanDir(dir);
  assert.deepEqual(r.hits.map((h) => [h.file, h.line, h.kind]), [['result.json', 1, 'a GitHub token']]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['patch.diff', 'scan.json']);
  const scan = fs.readFileSync(path.join(dir, 'scan.json'), 'utf8');
  assert.ok(!scan.includes(key));
  assert.deepEqual(JSON.parse(scan).removed, ['result.json']);
  // The CLI's exit code is what fails the build job.
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ result: key }));
  assert.equal(S.main(['--dir', dir]), 1);
  assert.equal(S.main(['--dir', dir]), 0, 'nothing left to find');
});

test('the scan requires nothing outside Node, so the build job can run a copy taken before the builder starts', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-secrets.js'), 'utf8');
  const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reqs, ['fs', 'path']);
});
