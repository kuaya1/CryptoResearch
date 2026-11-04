'use strict';
// The Constitution's Invariant 3 names the whole protected list (Stage 1.5, PR
// B2). trader-boundary.test.js owns the list, and it checks that the
// Constitution names nothing off it. This is the other direction: nothing on
// the list goes unnamed. It reads the list from that test's own source, so
// there is one list and no copy of it here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function protectedList() {
  const m = /const PROTECTED = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(read('dashboard', 'tests', 'trader-boundary.test.js'));
  assert.ok(m, 'trader-boundary.test.js still declares PROTECTED');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function invariant3() {
  const text = read('docs', 'CONSTITUTION.md');
  const start = text.indexOf('### Invariant 3:');
  assert.ok(start >= 0, 'the Constitution has Invariant 3');
  const rest = text.slice(start);
  const end = rest.indexOf('\n---');
  return end < 0 ? rest : rest.slice(0, end);
}

test('the protected list is the nine files, and each exists', () => {
  const list = protectedList();
  assert.equal(list.length, 9, 'the list changed: update Invariant 3 in the same pull request');
  for (const f of list) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

test('Invariant 3 names exactly the protected list, in full paths, on one line', () => {
  const lines = invariant3().split('\n').filter((l) => /Protected accounting modules/.test(l));
  assert.equal(lines.length, 1, 'trader-boundary.test.js reads this rule as one line');
  const named = [...lines[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  assert.deepEqual([...named].sort(), [...protectedList()].sort());
});

test('the rule itself is unchanged, and so are the two lines beside it', () => {
  const inv = invariant3();
  assert.match(inv, /require deliberate manual review and cannot be modified unattended\./);
  assert.match(inv, /Keep only deterministic status checks \(like `test`\) as required merge gates on `main`\./);
  assert.match(inv, /Never rely on external paid AI API calls \(`agent-review`\) as a hard requirement to merge code\./);
});
