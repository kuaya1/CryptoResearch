'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempWorkspace } = require('./helpers');
const projects = require('../core/projects');
const requests = require('../core/requests');
const notes = require('../core/notes');
const { buildIndex } = require('../core/indexer');

const allora = {
  name: 'Allora Network',
  symbol: 'ALLO',
  official_website: 'https://www.allora.network',
  coingecko_id: 'allora-test-id',
  evidence: [{ url: 'https://www.allora.network', note: 'test evidence' }],
  sector_profile: 'network-infrastructure@1',
  utterance: 'Add Allora Network to my watchlist, make its project folder, and prepare my analysis prompt.',
};

test('spoken add-project request creates the folder, files and prompts, and the index lists it', (t) => {
  const { ws, root, cleanup } = tempWorkspace('add');
  t.after(cleanup);
  const r = projects.addProject(ws, allora);
  assert.equal(r.status, 'created');
  assert.equal(r.project_id, 'allora-network');
  assert.equal(r.verified, true);
  for (const f of ['project.json', 'events.json', 'prompts/claude.md', 'prompts/chatgpt.md', 'prompts/gemini.md']) {
    assert.ok(fs.existsSync(path.join(root, 'projects', 'allora-network', ...f.split('/'))), f);
  }
  const p = projects.getProject(ws, 'allora-network');
  assert.equal(p.watchlist.on_watchlist, true);
  assert.equal(p.origin_request, allora.utterance);
  assert.equal(p.identity.status, 'verified');
  const idx = buildIndex(ws);
  assert.ok(idx.projects.some((x) => x.project_id === 'allora-network' && x.on_watchlist && !x.held), 'watchlist, not a holding');
  assert.equal(idx.portfolio.positions.length, 0, 'researching a token never creates a position');
  const prompt = fs.readFileSync(path.join(root, 'projects', 'allora-network', 'prompts', 'chatgpt.md'), 'utf8');
  assert.match(prompt, /"provider": "chatgpt"/);
  assert.match(prompt, /technical_risk_transparency/);
  assert.match(prompt, /credit_risk_transparency/);
});

test('repeating the add-project request does not create a duplicate', (t) => {
  const { ws, root, cleanup } = tempWorkspace('repeat');
  t.after(cleanup);
  projects.addProject(ws, allora);
  const again = projects.addProject(ws, { ...allora, name: 'Allora' });
  assert.equal(again.status, 'exists');
  assert.equal(again.project_id, 'allora-network');
  const bySite = projects.addProject(ws, { name: 'Allora Labs token', official_website: 'https://allora.network/docs' });
  assert.equal(bySite.status, 'exists');
  assert.deepEqual(fs.readdirSync(path.join(root, 'projects')), ['allora-network']);
  const sameTicker = projects.addProject(ws, { name: 'Allo Something Else', symbol: 'ALLO' });
  assert.equal(sameTicker.status, 'possible_duplicate', 'tickers alone are not trusted');
});

test('an unconfirmed identity becomes a pending draft that is not bound to a token', (t) => {
  const { ws, cleanup } = tempWorkspace('pending');
  t.after(cleanup);
  const r = projects.addProject(ws, { name: 'Huma Finance', symbol: 'HUMA', coingecko_id: 'huma-guess', sector_profile: 'payfi-credit@1' });
  assert.equal(r.identity_status, 'pending');
  const p = projects.getProject(ws, r.project_id);
  assert.equal(p.status, 'pending_identity');
  assert.equal(p.identity.coingecko_id, null);
  assert.equal(p.identity.candidates[0].coingecko_id, 'huma-guess');
  assert.ok(!require('../core/market').trackedIds(ws).includes('huma-guess'), 'pending candidates are never priced');
  const upd = projects.updateIdentity(ws, r.project_id, { official_website: 'https://huma.finance', coingecko_id: 'huma-finance', evidence: [{ url: 'https://huma.finance', note: 'test' }] });
  assert.equal(upd.identity_status, 'verified');
});

test('the same token cannot be bound to two projects', (t) => {
  const { ws, cleanup } = tempWorkspace('clash');
  t.after(cleanup);
  projects.addProject(ws, allora);
  const other = projects.addProject(ws, { name: 'Other Project', symbol: 'OTH' });
  assert.throws(() => projects.updateIdentity(ws, other.project_id, { coingecko_id: 'allora-test-id', official_website: 'https://other.example', evidence: [{ url: 'https://other.example' }] }), /already belongs/);
});

test('Cowork request queue: pending until a runner applies it, then a verified result', (t) => {
  const { ws, root, cleanup } = tempWorkspace('queue');
  t.after(cleanup);
  const req = { schema_version: 'cr.request.v1', request_id: 'req_test_0001', created_at: new Date().toISOString(), created_by: 'cowork', utterance: allora.utterance, action: 'add_project', args: allora };
  fs.writeFileSync(path.join(root, 'inbox', 'requests', 'req_test_0001.json'), JSON.stringify(req));
  assert.equal(requests.requestStatus(ws, 'req_test_0001').status, 'pending', 'no runner yet: pending, not saved');
  assert.ok(!fs.existsSync(path.join(root, 'projects', 'allora-network')));
  const out = requests.processRequests(ws);
  assert.equal(out.processed, 1);
  const status = requests.requestStatus(ws, 'req_test_0001');
  assert.equal(status.status, 'done');
  assert.equal(status.result.status, 'created');
  assert.ok(status.result.verified);
  assert.ok(fs.existsSync(path.join(root, 'inbox', 'requests', 'processed', 'req_test_0001.json')));
  // Same request again (new id) does not duplicate.
  fs.writeFileSync(path.join(root, 'inbox', 'requests', 'req_test_0002.json'), JSON.stringify({ ...req, request_id: 'req_test_0002' }));
  requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_test_0002').result.status, 'exists');
  // Invalid requests are refused visibly; nothing is applied and the input is kept in failed/.
  fs.writeFileSync(path.join(root, 'inbox', 'requests', 'req_test_0003.json'), JSON.stringify({ ...req, request_id: 'req_test_0003', action: 'delete_everything' }));
  requests.processRequests(ws);
  assert.equal(requests.requestStatus(ws, 'req_test_0003').status, 'rejected');
  assert.ok(fs.existsSync(path.join(root, 'inbox', 'requests', 'failed', 'req_test_0003.json')));
});

test('conviction note and review date through the shared path', (t) => {
  const { ws, root, cleanup } = tempWorkspace('notes');
  t.after(cleanup);
  projects.addProject(ws, allora);
  const n = notes.setConvictionNote(ws, 'allora-network', 'Test conviction note.', { utterance: 'Update my conviction note' });
  assert.equal(n.status, 'saved');
  assert.equal(notes.setConvictionNote(ws, 'allora-network', 'Test conviction note.').status, 'unchanged');
  const ev = notes.addEvent(ws, 'allora-network', { type: 'review', title: 'Review', due: '2026-10-09' });
  assert.equal(ev.event.due_date, '2026-10-09');
  assert.equal(ev.event.timezone, 'America/New_York');
  assert.equal(notes.addEvent(ws, 'allora-network', { type: 'review', title: 'Review', due: '2026-10-09' }).status, 'exists');
  assert.equal(notes.loadJournal(ws, 'allora-network').length, 1, 'note change kept as a journal entry');
  assert.ok(fs.existsSync(path.join(root, 'projects', 'allora-network', 'notes', 'conviction.md')));
});
