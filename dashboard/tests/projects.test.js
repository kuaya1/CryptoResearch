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
  // The standing prompt is the current one for this kind of project: the
  // record keeps the profile it was added with, and new research uses the
  // current version of that profile (thirteen category grades, prompt @5).
  assert.equal(p.sector_profile, 'network-infrastructure@1', 'the project record is not rewritten');
  assert.match(prompt, /CR-PROMPT cr-research-prompt@6/);
  assert.match(prompt, /Sector profile: network-infrastructure@2/);
  assert.match(prompt, /`development_credibility` \(Development credibility\)/);
  assert.match(prompt, /`btc_relative_opportunity` \(BTC-relative asymmetric opportunity\)/);
  assert.doesNotMatch(prompt, /technical_risk_transparency|credit_risk_transparency/, 'the @1 categories are not asked for any more');
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

test('market listings, explorers and social pages are leads, never the official website (subdomains too; project docs on gitbook.io are the project\'s)', () => {
  for (const u of ['https://coinmarketcap.com/currencies/avantis/', 'https://www.coingecko.com/en/coins/x', 'https://www.geckoterminal.com/base/pools/0x1', 'https://dexscreener.com/base/0x1', 'https://www.dextools.io/app/en/base/pair-explorer/0x1', 'https://defillama.com/protocol/x', 'https://etherscan.io/token/0x1', 'https://bscscan.com/token/0x1', 'https://basescan.org/token/0x1', 'https://arbiscan.io/token/0x1', 'https://polygonscan.com/token/0x1', 'https://optimistic.etherscan.io/token/0x1', 'https://snowtrace.io/token/0x1', 'https://solscan.io/token/x', 'https://explorer.solana.com/address/x', 'https://solana.fm/address/x', 'https://tronscan.org/#/token20/x', 'https://suiscan.xyz/mainnet/coin/x', 'https://x.com/project', 'https://twitter.com/project', 'https://t.me/project', 'https://discord.gg/abc', 'https://discord.com/invite/abc', 'https://medium.com/@project', 'https://project.medium.com/', 'https://linktr.ee/project', 'https://github.com/project', 'https://gitbook.io/', 'coinmarketcap.com/currencies/x']) {
    assert.equal(projects.isNonOfficialHost(u), true, u);
  }
  for (const u of ['https://www.sandbox.game/en/', 'https://projecta.gitbook.io/docs', 'https://solana.com/', 'https://docs.example.org/', 'https://xcom.example/', 'not a url', '']) {
    assert.equal(projects.isNonOfficialHost(u), false, u);
  }
});

test('a CoinMarketCap page given as the official website is kept as evidence only; the identity stays pending and says why', (t) => {
  const { ws, cleanup } = tempWorkspace('listing');
  t.after(cleanup);
  // Everything a verified identity needs, except that the "website" is a market listing.
  const r = projects.addProject(ws, { name: 'Listing Example (FICTIONAL)', official_website: 'https://coinmarketcap.com/currencies/listing-example-fictional/', coingecko_id: 'listing-example-fictional', evidence: [{ url: 'https://listing-example.example/docs', note: 'fictional' }] });
  assert.equal(r.identity_status, 'pending');
  const p = projects.getProject(ws, r.project_id);
  assert.equal(p.identity.official_website, null);
  assert.ok(p.identity.unknowns.includes('Official website not confirmed (a market listing page is not the project\'s own site).'));
  assert.ok(!p.identity.unknowns.includes('Official website not confirmed.'), 'one reason, not two');
  const lead = p.identity.evidence.find((e) => e.url === 'https://coinmarketcap.com/currencies/listing-example-fictional/');
  assert.equal(lead.note, 'Market listing or explorer page: a lead, not the official website');
  // updateIdentity refuses it the same way, without piling up copies of the lead.
  const again = projects.updateIdentity(ws, r.project_id, { official_website: 'https://coinmarketcap.com/currencies/listing-example-fictional/', evidence: [] });
  assert.equal(again.identity_status, 'pending');
  assert.equal(projects.getProject(ws, r.project_id).identity.evidence.filter((e) => /coinmarketcap/.test(e.url)).length, 1);
  // The project's own site completes it.
  assert.equal(projects.updateIdentity(ws, r.project_id, { official_website: 'https://listing-example.example/', evidence: [] }).identity_status, 'verified');
  // A listing offered later never replaces the site on file; it is kept as a lead.
  const later = projects.updateIdentity(ws, r.project_id, { official_website: 'https://www.coingecko.com/en/coins/listing-example-fictional', evidence: [] });
  assert.equal(later.identity_status, 'verified');
  const idn = projects.getProject(ws, r.project_id).identity;
  assert.equal(idn.official_website, 'https://listing-example.example/');
  assert.equal(idn.evidence.find((e) => /coingecko\.com/.test(e.url)).note, 'Market listing or explorer page: a lead, not the official website');
});

test('a market-data site\'s name is not a project name', (t) => {
  const { ws, cleanup } = tempWorkspace('aggregator-name');
  t.after(cleanup);
  for (const name of ['Coinmarketcap', 'CoinMarketCap', 'Coin Market Cap', 'coinmarketcap.com', 'CoinGecko', 'DexScreener', 'Etherscan']) {
    assert.throws(() => projects.addProject(ws, { name, official_website: 'https://coinmarketcap.com/currencies/avantis/' }), /name of a market-data site, not a project/, name);
  }
  assert.equal(fs.readdirSync(path.join(ws.root, 'projects')).length, 0);
  const ok = projects.addProject(ws, { name: 'The Sandbox' });
  assert.equal(ok.status, 'created');
  assert.throws(() => projects.updateProjectFields(ws, ok.project_id, { name: 'CoinGecko' }), /market-data site/);
});

test('duplicates by website compare the whole host name, and never a market listing or explorer host', (t) => {
  const { ws, cleanup } = tempWorkspace('domains');
  t.after(cleanup);
  assert.equal(projects.domainOf('https://www.Foo.co.uk/x'), 'foo.co.uk');
  projects.addProject(ws, { name: 'Project A (FICTIONAL)', official_website: 'https://projecta.gitbook.io/docs' });
  assert.equal(projects.addProject(ws, { name: 'Project B (FICTIONAL)', official_website: 'https://projectb.gitbook.io/docs' }).status, 'created', 'two GitBook subdomains are two sites');
  projects.addProject(ws, { name: 'Foo (FICTIONAL)', official_website: 'https://foo.co.uk/' });
  assert.equal(projects.addProject(ws, { name: 'Bar (FICTIONAL)', official_website: 'https://bar.co.uk/' }).status, 'created', 'foo.co.uk and bar.co.uk are two sites');
  const same = projects.addProject(ws, { name: 'Something Else (FICTIONAL)', official_website: 'https://www.foo.co.uk/token' });
  assert.equal(same.status, 'exists', 'the same host with or without www is the same site');
  assert.deepEqual(same.matched_on, ['same official website']);
  // Two projects pasted as CoinMarketCap links are not "the same official website".
  projects.addProject(ws, { name: 'Listed One (FICTIONAL)', official_website: 'https://coinmarketcap.com/currencies/listed-one-fictional/' });
  assert.equal(projects.addProject(ws, { name: 'Listed Two (FICTIONAL)', official_website: 'https://coinmarketcap.com/currencies/listed-two-fictional/' }).status, 'created');
  assert.equal(projects.findDuplicates(ws, { official_website: 'https://etherscan.io/token/0x1' }).strong.length, 0);
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
