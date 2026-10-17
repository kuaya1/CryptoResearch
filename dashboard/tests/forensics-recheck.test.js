'use strict';
// The independent re-audit of Forensics at a64e21a (audits/2026-10-16-codex-
// forensics-recheck, R01-R08), adversarially, through save -> read model, each
// with a valid control that must keep working. Fictional workspaces, stubbed
// providers; no request leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject } = require('./helpers');
const M = require('../core/forensic-model');
const E = require('../core/forensic-eligibility');
const F = require('../core/forensics');
const RV = require('../core/forensic-review');
const monitor = require('../core/forensic-monitor');
const FX = require('./forensic-fixtures');
const { atomicWrite, jsonText, readJson } = require('../core/fsx');

const H = 3600000;
const DAY = 24 * H;
const at = (ms) => new Date(ms).toISOString();
const BASE_TOKEN = '0x1111111111111111111111111111111111111111';

function setup(label, website = null, extra = {}) {
  const t = tempWorkspace(label);
  const p = website
    ? require('../core/projects').addProject(t.ws, { name: 'Forensic Recheck (FICTIONAL)', symbol: 'XFRC', official_website: website, coingecko_id: 'recheck-fictional', assets: [{ chain: 'base', contract_address: BASE_TOKEN }], evidence: [{ url: website, note: 'Fictional identity' }], ...extra })
    : addFixtureProject(t.ws);
  return { ...t, pid: p.project_id };
}
const audit = (t, args = {}) => F.createAudit(t.ws, { project_id: t.pid, assistant: 'claude', ...args }).audit;
const save = (t, a, over = {}, extra = {}) => F.saveReport(t.ws, { project_id: t.pid, audit_id: a.audit_id, provider: 'claude', text: FX.reportText(a, over), ...extra });
function clock(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = real; }
}

// ---------------------------------------------------------------------------
// R01: authority is the exact official host (or its subdomains, or its path).

test('R01: an unrelated co.uk tenant is not the official site and establishes no shutdown; the project\'s own host does', (t) => {
  const x = setup('rc-r01-suffix', 'https://honest-project.co.uk');
  t.after(x.cleanup);
  const a = audit(x);
  const shut = (url) => ({
    sources: [{ source_id: 'EVIL', url, type: 'secondary', retrieved_at: at(Date.now()), excerpt: 'FICTIONAL: the project stopped its service.' }],
    findings: [{ finding_id: 'SHUT', area: 'claims', kind: 'observation', statement: 'FICTIONAL shutdown.', source_ids: ['EVIL'], retrieved_at: at(Date.now()), discontinuation: 'shutdown' }],
    strongest_concern: { finding_id: 'SHUT', statement: 'FICTIONAL shutdown.' },
  });
  save(x, a, shut('https://unrelated-party.co.uk/shutdown'));
  let v = F.view(x.ws, x.pid);
  assert.equal(v.current.sources[0].check.attribution, 'not_established');
  assert.equal(v.states.discontinuation.state, 'not_established');
  for (const [official, other] of [['https://project.github.io', 'https://evil.github.io/notice'], ['https://medium.com/@project', 'https://medium.com/@someone-else/notice']]) {
    const ctx = E.identityContext({ official_website: official });
    assert.equal(E.checkSource({ source_id: 'X', url: other, retrieved_at: at(Date.now()), excerpt: 'FICTIONAL excerpt of twenty characters.' }, ctx).attribution, 'not_established', `${other} is not ${official}`);
  }
  // Valid controls: the official host, a subdomain of it, and a path under a
  // path-scoped official site.
  const ctx = E.identityContext({ official_website: 'https://honest-project.co.uk' });
  const ok = (url, c = ctx) => E.checkSource({ source_id: 'X', url, retrieved_at: at(Date.now()), excerpt: 'FICTIONAL excerpt of twenty characters.' }, c).attribution;
  assert.equal(ok('https://honest-project.co.uk/blog/sunset'), 'official_domain');
  assert.equal(ok('https://docs.honest-project.co.uk/notice'), 'official_domain');
  assert.equal(ok('https://www.honest-project.co.uk/notice'), 'official_domain');
  assert.equal(ok('https://example.com/xmpl/blog', E.identityContext({ official_website: 'https://example.com/xmpl' })), 'official_domain');
  assert.equal(ok('https://example.com/xmplother/blog', E.identityContext({ official_website: 'https://example.com/xmpl' })), 'not_established', 'a path prefix ends at a segment');
  const y = setup('rc-r01-own', 'https://honest-project.co.uk');
  t.after(y.cleanup);
  const b = audit(y);
  save(y, b, shut('https://honest-project.co.uk/blog/sunset'));
  v = F.view(y.ws, y.pid);
  assert.equal(v.states.discontinuation.state, 'occurred', 'the project\'s own announcement still counts');
});

test('R01: an abbreviated or unbound transaction string confers no attribution; a full one is kept as a reference only', (t) => {
  const x = setup('rc-r01-tx', 'https://project.example');
  t.after(x.cleanup);
  const a = audit(x);
  save(x, a, {
    sources: [{ source_id: 'TX', url: 'https://unrelated.example/solana/transaction/abc', type: 'secondary', retrieved_at: at(Date.now()), tx_signature: 'abc...123' }],
    findings: [{ finding_id: 'SHUT', area: 'claims', kind: 'observation', statement: 'FICTIONAL shutdown on the wrong chain.', source_ids: ['TX'], retrieved_at: at(Date.now()), discontinuation: 'shutdown' }],
    strongest_concern: { finding_id: 'SHUT', statement: 'FICTIONAL.' },
  });
  const v = F.view(x.ws, x.pid);
  const c = v.current.sources[0].check;
  assert.notEqual(c.capture, 'chain_reference', 'an abbreviated string is not a preserved chain record');
  assert.equal(c.usable, false);
  assert.equal(c.attribution, 'not_established');
  assert.equal(v.states.discontinuation.state, 'not_established');
  // A full EVM transaction hash is a preserved reference, but a v1 block
  // cannot bind it to this project's contract: no attribution from it.
  const full = E.checkSource({ source_id: 'T2', url: 'https://unrelated.example/tx', retrieved_at: at(Date.now()), tx_signature: `0x${'ab'.repeat(32)}` }, E.identityContext({ official_website: 'https://project.example', chains_and_contracts: [{ chain: 'base', contract_address: BASE_TOKEN }] }));
  assert.equal(full.capture, 'chain_reference');
  assert.equal(full.usable, true);
  assert.equal(full.attribution, 'not_established');
  const wrong = E.checkSource({ source_id: 'T3', retrieved_at: at(Date.now()), tx_signature: `0x${'ab'.repeat(32)}` }, E.identityContext({ chains_and_contracts: [{ chain: 'solana', contract_address: 'So11111111111111111111111111111111111111112' }] }));
  assert.equal(wrong.chain_ref.fits_identity, false, 'an EVM hash does not fit a Solana identity');
});

test('R01: a finding citing one usable and one undated source does not claim that its references hold', (t) => {
  const x = setup('rc-r01-mixed');
  t.after(x.cleanup);
  const a = audit(x);
  const b = FX.block(a);
  b.sources.push({ source_id: 'UNDATED', url: 'https://unrelated.example/claim', type: 'secondary' });
  b.findings[0].source_ids = ['S1', 'UNDATED'];
  save(x, a, b);
  const v = F.view(x.ws, x.pid);
  const f1 = v.current.findings.find((f) => f.finding_id === 'F1').eligibility;
  assert.equal(f1.standing, 'references_partly_hold');
  assert.equal(f1.eligible, false);
  assert.match(f1.reasons.join(' '), /UNDATED/);
  assert.equal(v.current.category_grades.product_reality.desk.usable, false, 'the grade resting on it is not used');
  // Control: the same finding with only S1 holds.
  const y = setup('rc-r01-mixed-ok');
  t.after(y.cleanup);
  const a2 = audit(y);
  save(y, a2);
  assert.equal(F.view(y.ws, y.pid).current.findings.find((f) => f.finding_id === 'F1').eligibility.standing, 'references_hold');
});

// ---------------------------------------------------------------------------
// R02: a missing token contract is never filled in.

test('R02: same-chain quotes without a contract are unbound; three no-routes make no episode; the explicit contract still binds', (t) => {
  const x = setup('rc-r02', 'https://project.example');
  t.after(x.cleanup);
  const now = Date.now();
  const a = clock(now - 4 * DAY, () => audit(x));
  const b = FX.block(a);
  b.liquidity = { observations: [now - 80 * H, now - 40 * H, now].map((ms, i) => ({ obs_id: `unbound-${i}`, kind: 'executable_quote', chain: 'base', pool: 'UNRELATED/USDC', source_id: 'S3', route_scope: 'aggregator', retrieved_at: at(ms), quote: { sell_usd: 500, no_route: true } })) };
  save(x, a, b);
  const v = F.view(x.ws, x.pid);
  assert.equal(v.states.liquidity.state, 'unknown');
  assert.equal(v.states.liquidity.episodes.length, 0);
  assert.equal(v.liquidity.exits.find((e) => e.size_usd === 500).status, 'no_supported_estimate');
  assert.ok(v.current.not_counted.filter((n) => n.measure === 'liquidity').length === 3);
  assert.ok(v.current.not_counted.every((n) => n.measure !== 'liquidity' || /names no token contract/.test(n.reason)));
  // Control: the same readings naming the frozen contract bind.
  const y = setup('rc-r02-ok', 'https://project.example');
  t.after(y.cleanup);
  const a2 = clock(now - 4 * DAY, () => audit(y));
  const b2 = FX.block(a2);
  b2.liquidity = { observations: b.liquidity.observations.map((o) => ({ ...o, contract_address: BASE_TOKEN })) };
  save(y, a2, b2);
  const v2 = F.view(y.ws, y.pid);
  assert.equal(v2.states.liquidity.state, 'occurred', 'no route from an aggregator for 80 hours, on this contract');
  // A second contract on the same chain cannot borrow the first one.
  const ctx = E.identityContext({ chains_and_contracts: [{ chain: 'base', contract_address: BASE_TOKEN }, { chain: 'base', contract_address: '0x2222222222222222222222222222222222222222' }] });
  const ev = { identity: ctx, sources: { S3: { usable: true } } };
  assert.equal(E.bindLiquidity({ chain: 'base', contract_address: '0x3333333333333333333333333333333333333333', source_id: 'S3', retrieved_at: at(now) }, ev).bound, false);
  assert.equal(E.bindLiquidity({ chain: 'base', contract_address: '0x2222222222222222222222222222222222222222', source_id: 'S3', retrieved_at: at(now) }, ev).bound, true);
});

// ---------------------------------------------------------------------------
// R03: delivery only from an exact, bound repository.

test('R03: an unrelated active repository cannot clear inactivity or move a deadline; a bound one can', (t) => {
  const x = setup('rc-r03', 'https://project.example');
  t.after(x.cleanup);
  const a = audit(x);
  const now = Date.now();
  save(x, a, { delivery: { observations: [{ obs_id: 'OTHER', repository: 'github.com/unrelated-owner/unrelated-product', source_id: 'S1', observed_at: at(now), latest_commit_at: at(now - H), latest_commit: 'abc1234' }] } });
  let v = F.view(x.ws, x.pid);
  assert.equal(v.states.delivery.state, 'unknown');
  assert.equal(v.scenarios.delivery.status, 'insufficient', 'no delivery date from an unrelated repository');
  assert.ok(v.current.not_counted.some((n) => n.measure === 'delivery'));
  // A suffix after owner/repo is not the same repository.
  assert.equal(E.bindRepository({ repository: 'github.com/project/core-evil', source_id: 'S1', observed_at: at(now) }, { identity: { site: null, repositories: ['github.com/project/core'] }, sources: { S1: { usable: true } } }).bound, false);
  // Control: the repository the official site's own capture names.
  const y = setup('rc-r03-ok', 'https://project.example');
  t.after(y.cleanup);
  const b = audit(y);
  const blk = FX.block(b);
  save(y, b, {
    sources: [...blk.sources, { source_id: 'S9', url: 'https://project.example/developers', type: 'primary', retrieved_at: at(now), excerpt: 'FICTIONAL: our code lives at github.com/project-example/core.' }],
    delivery: { observations: [{ obs_id: 'OWN', repository: 'github.com/project-example/core', source_id: 'S9', observed_at: at(now), latest_commit_at: at(now - H), latest_commit: 'def5678' }] },
  });
  v = F.view(y.ws, y.pid);
  assert.equal(v.states.delivery.state, 'within');
  // And one Eric approved for monitoring from an assessment is bound too.
  const z = setup('rc-r03-approved', 'https://project.example');
  t.after(z.cleanup);
  const c = audit(z);
  const s = save(z, c, { monitoring_targets: { product_checks: [], repositories: [{ host: 'github', owner: 'approved-owner', repo: 'approved-repo', source_id: 'S4' }] }, delivery: { observations: [{ obs_id: 'APP', repository: 'github.com/approved-owner/approved-repo', source_id: 'S4', observed_at: at(now), latest_commit_at: at(now - H) }] } });
  assert.equal(F.view(z.ws, z.pid).states.delivery.state, 'unknown', 'not yet approved');
  F.setMonitoring(z.ws, z.pid, { approve: { receipt_id: s.receipt_id } });
  assert.equal(F.view(z.ws, z.pid).states.delivery.state, 'within', 'approved by Eric');
});

// ---------------------------------------------------------------------------
// R04: a positive tax is never applied as a universal multiplier.

test('R04: with a positive transfer tax, costs reconcile with proceeds and are only a lower bound; zero tax and gas-included stay complete', () => {
  const tax10 = { pct: 10, source: 'FICTIONAL screen', checked_at: at(Date.now()) };
  const q = M.exitEstimate({ kind: 'executable_quote', route_scope: 'aggregator', quote: { sell_usd: 500, received_usd: 490, gas_usd: 10 } }, 500, { tax: tax10 });
  assert.equal(q.cost_complete, false, 'whether the quote includes the tax is not known');
  assert.equal(q.received_usd, 490);
  assert.equal(q.net_received_usd, 480, 'proceeds after the external network fee');
  assert.equal(q.cost_pct, 4, 'cost = (sell - receives + gas) / sell; it reconciles with the proceeds shown');
  assert.match(q.missing_costs.join(' '), /transfer tax/);
  assert.equal(q.tax.pct, 10);
  assert.equal(q.tax.checked_at, tax10.checked_at, 'the tax used is frozen with the estimate');
  // A lower bound must be valid: the reserve case below the true input-tax cost.
  const r = M.exitEstimate({ kind: 'pool_reserves', mechanism: 'constant_product', base_reserve: 1000, quote_reserve: 1000, quote_usd_price: 1, fee_bps: 0 }, 500, { tax: tax10 });
  const trueCost = (1 - (450 * 1000) / 1450 / 500) * 100;
  assert.ok(r.cost_pct <= trueCost + 1e-9, `a lower bound ${r.cost_pct} must not exceed the input-tax cost ${trueCost}`);
  assert.equal(r.cost_complete, false);
  assert.ok(Math.abs(r.cost_pct - (1 - 333.3333333 / 500) * 100) < 1e-3);
  // Zero tax: complete, unchanged.
  const z = M.exitEstimate({ kind: 'executable_quote', route_scope: 'aggregator', quote: { sell_usd: 500, received_usd: 490, gas_usd: 10 } }, 500, { tax: { pct: 0, source: 'FICTIONAL' } });
  assert.equal(z.cost_complete, true);
  assert.equal(z.cost_pct, 4);
  // Gas inside the quote: not added; complete with zero tax.
  const gi = M.exitEstimate({ kind: 'executable_quote', route_scope: 'aggregator', quote: { sell_usd: 500, received_usd: 490, gas_usd: 10, gas_included: true } }, 500, { tax: { pct: 0, source: 'FICTIONAL' } });
  assert.equal(gi.cost_pct, 2);
  assert.equal(gi.net_received_usd, 490);
  // Unknown tax: a lower bound.
  assert.equal(M.exitEstimate({ kind: 'executable_quote', route_scope: 'aggregator', quote: { sell_usd: 500, received_usd: 490, gas_usd: 10 } }, 500).cost_complete, false);
  // A taxed lower bound within the limit is not "within"; over it, it is over.
  const rd = M.liquidityReadings([{ kind: 'executable_quote', route_scope: 'aggregator', retrieved_at: at(Date.now()), quote: { sell_usd: 500, received_usd: 495, gas_usd: 0 } }], { positionUsd: 500, limitPct: 5, taxOf: () => tax10 });
  assert.equal(rd[0].beyond, null);
});

// ---------------------------------------------------------------------------
// R05: today's observed points count before noon UTC.

function storeVolume(ws, cg, endMs, days) {
  const months = new Map();
  for (let d = days; d >= 0; d--) {
    const t = endMs - d * DAY;
    const line = { fetched_at: at(t), provider: 'fictional', assets: [{ id: cg, source_last_updated_at: at(t), price_usd: 1, volume_24h_usd: d === 0 ? 0 : 1000 }] };
    const m = at(t).slice(0, 7);
    months.set(m, [...(months.get(m) || []), JSON.stringify(line)]);
  }
  fs.mkdirSync(ws.abs('market-data/observations'), { recursive: true });
  for (const [m, rows] of months) fs.writeFileSync(ws.abs(`market-data/observations/${m}.jsonl`), `${rows.join('\n')}\n`);
}

test('R05: a zero observed at 03:00 UTC is the current reading at 03:00 and at 15:00 alike, labeled a partial day', (t) => {
  const x = setup('rc-r05');
  t.after(x.cleanup);
  const early = Date.parse('2026-10-17T03:00:00Z');
  const late = Date.parse('2026-10-17T15:00:00Z');
  storeVolume(x.ws, 'example-payfi-fictional', early, 30);
  const a = clock(early, () => audit(x));
  clock(early, () => save(x, a, { assessment_as_of: at(early) }));
  const read = (now) => F.view(x.ws, x.pid, { now }).scenarios.volume;
  const s1 = read(early);
  const s2 = read(late);
  assert.equal(s1.latest.value, 0);
  assert.equal(s1.beyond_now, true);
  assert.equal(s2.beyond_now, true);
  assert.equal(s1.latest.partial, true, 'today so far, said');
  assert.equal(s1.latest.at, at(early), 'with the time of the reading, not a noon label');
  // A truly future reading stays out.
  const future = M.dailySeries([{ at: at(early + 2 * H), value: 5 }]);
  assert.equal(M.scenarioEstimates(future, { threshold: 1, origin: at(early), now: early }).status, 'insufficient');
});

// ---------------------------------------------------------------------------
// R06: changed bytes are not cosmetic without a parser that proves it.

test('R06: a changed JSON string reopens; JSON formatting alone is formatting-only; HTML whitespace is not called cosmetic', async (t) => {
  const x = setup('rc-r06');
  t.after(x.cleanup);
  const a = audit(x);
  const s = save(x, a);
  F.setMonitoring(x.ws, x.pid, { approve: { receipt_id: s.receipt_id } });
  const pc = F.readProfile(x.ws, x.pid).targets.product_checks[0];
  const now = Date.now();
  const read = async (body, i, type = 'application/json') => {
    const o = await monitor.productCheck(x.ws, { ...pc, expect_text: null }, { cfg: { timeout_seconds: 1, max_bytes: 10000 }, transport: async (url, { lookup }) => { await new Promise((r) => lookup(url.hostname, {}, r)); return { status: 200, headers: { 'content-type': type }, stream: Readable.from([Buffer.from(body)]), abort() {} }; }, lookupImpl: (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]), now: () => now - (10 - i) * H });
    F.appendObservation(x.ws, x.pid, o);
    return o;
  };
  const thread = () => F.view(x.ws, x.pid).evidence_changes.threads.find((th) => th.target_id === pc.target_id);
  await read('{"operational":true,"payoutMemo":"alpha"}', 0);
  await read('{"operational":true,"payoutMemo":"alpha  beta"}', 1);
  RV.acknowledge(x.ws, x.pid, { target_id: pc.target_id, item_id: thread().latest_relevant.item_id, request_id: 'req_fictional_r06a' });
  await read('{"operational":true,"payoutMemo":"alpha beta"}', 2);
  let th = thread();
  assert.equal(th.items[th.items.length - 1].class, 'capture_changed', 'a changed string value is a change');
  assert.equal(th.state, 'reopened');
  RV.acknowledge(x.ws, x.pid, { target_id: pc.target_id, item_id: th.latest_relevant.item_id, request_id: 'req_fictional_r06b' });
  await read('{\n  "payoutMemo": "alpha beta",\n  "operational": true\n}', 3);
  th = thread();
  assert.equal(th.items[th.items.length - 1].class, 'cosmetic_only', 'JSON formatting and key order only');
  assert.equal(th.state, 'reviewed');
  await read('{\n  "payoutMemo": "alpha beta",\n  "operational": true\n}', 4);
  assert.equal(thread().items.length, th.items.length, 'identical bytes again: no item');
  // HTML: any change of bytes is a change whose significance is not assessed.
  const y = setup('rc-r06-html');
  t.after(y.cleanup);
  const n1 = monitor.normalizeBody('<pre>a  b</pre>', 'text/html');
  const n2 = monitor.normalizeBody('<pre>a b</pre>', 'text/html');
  assert.notEqual(n1, n2);
  assert.equal(monitor.normalizeBody('{"a": "x  y"}', 'application/json') === monitor.normalizeBody('{"a":"x y"}', 'application/json'), false);
  assert.equal(monitor.normalizeBody('{ "a" : 1 }', 'application/json'), monitor.normalizeBody('{"a":1}', 'application/json'));
  assert.equal(F.view(x.ws, x.pid).current.category_grades.product_reality.score, 72, 'no grade changes');
});

// ---------------------------------------------------------------------------
// R07: the displayed assessment must agree with its verified original.

test('R07: a changed stored projection is an integrity error, never a clean contradictory view; untouched receipts read as before', (t) => {
  const x = setup('rc-r07');
  t.after(x.cleanup);
  const a = audit(x);
  const s = save(x, a);
  const file = x.ws.abs(F.receiptRel(x.pid, s.receipt_id));
  const clean = F.view(x.ws, x.pid);
  assert.equal(clean.current.integrity.ok, true);
  const r = readJson(file);
  r.assessment.plain_assessment = 'FICTIONAL TAMPER: a different assessment';
  r.assessment.category_grades.product_reality.score = 99;
  atomicWrite(file, jsonText(r));
  const v = F.view(x.ws, x.pid);
  assert.equal(v.current.integrity.ok, false);
  assert.match(v.current.integrity.problems.join(' '), /does not match its original/);
  assert.equal(v.current.plain_assessment, undefined, 'no headline from a projection that disagrees with its original');
  assert.equal(v.current.category_grades, undefined);
  // Identity and binding metadata too.
  const y = setup('rc-r07-id');
  t.after(y.cleanup);
  const b = audit(y);
  const s2 = save(y, b);
  const f2 = y.ws.abs(F.receiptRel(y.pid, s2.receipt_id));
  const r2 = readJson(f2);
  r2.identity = { ...r2.identity, official_website: 'https://elsewhere.example' };
  atomicWrite(f2, jsonText(r2));
  assert.equal(F.view(y.ws, y.pid).current.integrity.ok, false);
  // A changed Markdown original is caught on an ordinary read too.
  const z = setup('rc-r07-md');
  t.after(z.cleanup);
  const c = audit(z);
  const s3 = save(z, c);
  fs.appendFileSync(z.ws.abs(s3.receipt.text.path), ' ');
  assert.equal(F.view(z.ws, z.pid).current.integrity.ok, false);
});
