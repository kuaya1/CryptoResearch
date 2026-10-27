'use strict';
// The Daily Brief drawer's model (public/daily-brief-model.js) over the desk's
// own cr-daily-brief@1 on a fictional workspace: every line keeps its #/ link,
// a section that could not be read says so, the hash is shown, and building the
// view or the drawer's static code writes nothing. Fictional fixtures only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace, addFixtureProject, importAllFixtures, hashTree } = require('./helpers');

test('daily brief view: sections keep their deep links and the hash; an unreadable section says so; unsafe links are text; reading writes nothing', async (t) => {
  const M = await import('../public/daily-brief-model.js');
  const w = tempWorkspace('dbrief');
  t.after(w.cleanup);
  addFixtureProject(w.ws);
  importAllFixtures(w.ws);
  const brief = require('../core/brief-daily').brief(w.ws, {});
  const tree = hashTree(w.root);
  const v = M.briefView(brief);
  assert.deepEqual(hashTree(w.root), tree, 'building the view writes nothing');
  assert.equal(v.ok, true);
  assert.equal(v.hash, brief.text_sha256);
  assert.equal(v.hash_short.length, 12);
  assert.equal(v.sections.length, brief.sections.length);
  assert.deepEqual(v.sections.slice(0, 2).map((s) => s.id), ['pm_cards', 'invalidated'], 'cards waiting and invalidated tickets come first');
  for (const s of v.sections) for (const l of s.lines) assert.ok(l.href === null || /^#\//.test(l.href));
  // A section the desk could not read says so, with no count.
  const bad = M.briefView({ ...brief, sections: [{ id: 'held', title: 'Held positions', state: 'unreadable', error: 'ledger unreadable', count: null, lines: [{ text: 'Could not be read: ledger unreadable', link: null }] }] });
  assert.equal(bad.unreadable, 1);
  assert.equal(bad.sections[0].unreadable, true);
  assert.equal(bad.sections[0].count, null);
  assert.equal(bad.sections[0].why, 'ledger unreadable');
  // Only #/ addresses become links.
  assert.equal(M.safeLink('javascript:alert(1)'), null);
  assert.equal(M.safeLink('https://example.com'), null);
  assert.equal(M.safeLink('#/project/x/forensics?tab=exits'), '#/project/x/forensics?tab=exits');
  const odd = M.briefView({ sections: [{ id: 'a', title: 'A', state: 'ok', count: 1, lines: [{ text: 'x', link: 'javascript:alert(1)' }] }] });
  assert.equal(odd.sections[0].lines[0].href, null);
  assert.equal(M.briefView(null).ok, false);
  assert.equal(M.briefView({}).why, 'The daily brief could not be read.');
});

test('daily brief drawer: reads /api/brief/daily and posts only the explicit Reconcile desk button (item 60)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'shell', 'DailyBrief.jsx'), 'utf8');
  // Bounded (L3, 2026-10-26): a busy desk is said with Try again.
  assert.match(src, /api\.get\('\/api\/brief\/daily', \{ timeoutMs: BRIEF_WAIT_MS \}\)/);
  assert.match(src, /data-key="brief-retry"/);
  assert.doesNotMatch(src, /fetch\(|method:\s*'(POST|PUT|DELETE)'/);
  assert.deepEqual([...src.matchAll(/api\.post\(([^,)]+)/g)].map((m) => m[1]), ["'/api/tickets/reconcile'"], 'the one post is the repair, from a button');
  assert.match(src, /onClick=\{reconcile\}/);
  const shell = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'shell', 'Shell.jsx'), 'utf8');
  assert.match(shell, /data-key="top-brief"[^>]*aria-label="Daily Brief"/);
});
