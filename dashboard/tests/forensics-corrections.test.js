'use strict';
// The independent review of Forensics & Resilience (2026-10-16, audits/
// 2026-10-16-codex-forensics-review), adversarially: each finding's
// reproduction now fails safely, a valid control still works, and the
// evidence-change review queue behaves as documented. Fictional workspaces,
// fictional reports and stubbed networks only; no request leaves the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');
const { tempWorkspace, addFixtureProject, hashTree } = require('./helpers');
const D = require('../core/forensic-defs');
const M = require('../core/forensic-model');
const E = require('../core/forensic-eligibility');
const F = require('../core/forensics');
const RV = require('../core/forensic-review');
const XQ = require('../core/exitquotes');
const monitor = require('../core/forensic-monitor');
const netguard = require('../core/netguard');
const FX = require('./forensic-fixtures');
const { sha256, atomicWrite, jsonText, readJson } = require('../core/fsx');

const H = 3600000;
const DAY = 24 * H;
const at = (ms) => new Date(ms).toISOString();

function setup(label, settings) {
  const t = tempWorkspace(label, settings);
  const p = addFixtureProject(t.ws);
  return { ...t, pid: p.project_id };
}

async function noNetwork(fn) {
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('network is off in this test'); };
  try {
    await fn();
  } finally {
    global.fetch = real;
  }
  return calls;
}

// An audit opened `daysAgo` days ago (its creation time set back on the
// fictional record), so an assessment can be dated in the past.
function backdatedAudit(ws, pid, daysAgo, args = {}) {
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude', ...args });
  const file = ws.abs(F.auditRel(pid, a.audit_id));
  const audit = readJson(file);
  audit.created_at = at(Date.now() - daysAgo * DAY - H);
  atomicWrite(file, jsonText(audit));
  return F.loadAudit(ws, pid, a.audit_id);
}

const save = (ws, pid, audit, over = {}, extra = {}) => F.saveReport(ws, { project_id: pid, audit_id: audit.audit_id, provider: 'claude', text: FX.reportText(audit, over), ...extra });

function request(port, token, { method = 'GET', path: p = '/', body = null, auth = true } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: `127.0.0.1:${port}`, ...(auth ? { 'x-cr-token': token } : {}), ...(body ? { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` } : {}) };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// F01 / F03: one eligibility pass for coverage, grades, headline, outcomes.

test('F01: a missing reference, a ghost finding and a foreign chain give no coverage, no grade and no exit; originals stay', (t) => {
  const { ws, pid, cleanup } = setup('fc-f01');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const b = FX.block(a.audit);
  const bad = {
    sources: [],
    findings: [{ ...b.findings[0], finding_id: 'F1', area: 'product', source_ids: ['MISSING'] }],
    category_grades: { ...b.category_grades, product_reality: { score: 99, confidence: 'high', finding_ids: ['GHOST'], reason: 'FICTIONAL claim.' } },
    evidence_coverage: { areas: { ...b.evidence_coverage.areas, product: 'covered' }, notes: '' },
    strongest_concern: { finding_id: 'F1', statement: 'FICTIONAL.' },
    strongest_counterevidence: null,
    liquidity: { observations: [{ obs_id: 'L9', kind: 'executable_quote', source_id: 'NOPE', venue: 'Unrelated', chain: 'ANOTHER-CHAIN', pool: 'UNRELATED/USDC', mechanism: 'aggregator', route_scope: 'aggregator', retrieved_at: at(Date.now()), quote: { sell_usd: 500, received_usd: 495, gas_usd: 0.1, gas_included: false, route: 'x', no_route: false } }], notes: '' },
  };
  const s = save(ws, pid, a.audit, bad);
  assert.equal(s.status, 'saved', 'the raw report is saved as the assistant gave it');
  assert.equal(s.receipt.assessment.category_grades.product_reality.score, 99, 'its own grade is kept');
  assert.match(s.message, /report's claims and feed no coverage, grade or outcome/);
  const v = F.view(ws, pid);
  const g = v.current.category_grades.product_reality;
  assert.equal(g.score, 99);
  assert.equal(g.desk.usable, false, 'the desk does not use a grade resting on a ghost finding');
  assert.match(g.desk.reason, /GHOST/);
  const prod = v.current.coverage.areas.find((x) => x.area === 'product');
  assert.notEqual(prod.status, 'covered');
  assert.equal(v.current.findings[0].eligibility.standing, 'report_claim');
  assert.match(v.current.findings[0].eligibility.reasons.join(' '), /MISSING/);
  assert.equal(v.states.liquidity.state, 'unknown', 'a quote on another chain is not an exit for this project');
  assert.ok(v.current.not_counted.some((x) => x.obs_id === 'L9' && /ANOTHER-CHAIN/.test(x.reason)));
  // The valid control: the fictional fixture's references hold.
  const b2 = setup('fc-f01-ok');
  t.after(b2.cleanup);
  const a2 = F.createAudit(b2.ws, { project_id: b2.pid, assistant: 'claude' });
  save(b2.ws, b2.pid, a2.audit);
  const v2 = F.view(b2.ws, b2.pid);
  assert.equal(v2.current.category_grades.control_transparency.desk.usable, true);
  assert.equal(v2.current.coverage.areas.find((x) => x.area === 'controls').status, 'covered');
  assert.ok(v2.current.findings.every((f) => f.eligibility.eligible));
});

test('F01: a source labelled primary proves nothing by its label; a preserved historical capture still counts', (t) => {
  const { ws, pid, cleanup } = setup('fc-primary');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const b = FX.block(a.audit);
  // A shutdown "observation" whose only source is labelled primary, with a
  // javascript: address, no time, no excerpt and no attribution.
  const s1 = save(ws, pid, a.audit, {
    sources: [...b.sources, { source_id: 'S9', url: 'javascript:alert(1)', publisher: 'Anonymous', type: 'primary' }],
    findings: [...b.findings, { finding_id: 'F9', area: 'claims', kind: 'observation', statement: 'FICTIONAL: the project shut down.', source_ids: ['S9'], discontinuation: 'shutdown' }],
  });
  let v = F.view(ws, pid);
  assert.equal(v.states.discontinuation.state, 'not_established');
  assert.ok(v.states.discontinuation.not_counted.some((x) => x.finding_id === 'F9'));
  const s9 = v.current.sources.find((s) => s.source_id === 'S9');
  assert.equal(s9.check.usable, false);
  assert.equal(s9.check.self_labelled_primary, true);
  // A third-party page labelled primary: dated and excerpted, but not tied
  // to the project, so it cannot establish discontinuation either.
  const b3 = setup('fc-primary-3p');
  t.after(b3.cleanup);
  const a3 = F.createAudit(b3.ws, { project_id: b3.pid, assistant: 'claude' });
  const blk = FX.block(a3.audit);
  save(b3.ws, b3.pid, a3.audit, {
    sources: [...blk.sources, { source_id: 'S8', url: 'https://news.example.net/xmpl-closed', publisher: 'A news site', type: 'primary', retrieved_at: at(Date.now()), excerpt: 'FICTIONAL: sources say Example PayFi is closing.' }],
    findings: [...blk.findings, { finding_id: 'F8', area: 'claims', kind: 'observation', statement: 'FICTIONAL: closing, per a news page.', source_ids: ['S8'], retrieved_at: at(Date.now()), discontinuation: 'shutdown' }],
  });
  v = F.view(b3.ws, b3.pid);
  assert.equal(v.states.discontinuation.state, 'not_established', 'a primary label on someone else\'s page is not attribution');
  // The project's own announcement, preserved (the page may be gone now):
  // a dated excerpt on its own domain counts as historical evidence.
  const b4 = setup('fc-primary-own');
  t.after(b4.cleanup);
  const a4 = F.createAudit(b4.ws, { project_id: b4.pid, assistant: 'claude' });
  const blk4 = FX.block(a4.audit);
  save(b4.ws, b4.pid, a4.audit, {
    sources: [...blk4.sources, { source_id: 'S7', url: 'https://example.com/xmpl/blog/sunset', publisher: 'Example PayFi', type: 'primary', retrieved_at: at(Date.now()), excerpt: 'FICTIONAL: we are winding down the service on 1 December.', content_sha256: sha256('FICTIONAL sunset page') }],
    findings: [...blk4.findings, { finding_id: 'F7', area: 'claims', kind: 'observation', statement: 'FICTIONAL: the project announced its shutdown.', source_ids: ['S7'], retrieved_at: at(Date.now()), discontinuation: 'shutdown' }],
  });
  v = F.view(b4.ws, b4.pid);
  assert.equal(v.states.discontinuation.state, 'occurred', 'an attributable, preserved capture establishes it, even if the page is gone today');
  assert.equal(s1.status, 'saved');
});

test('F01: a finding citing a real but unrelated source "holds" only as references; the desk never calls it verified', (t) => {
  const { ws, pid, cleanup } = setup('fc-meaning');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const b = FX.block(a.audit);
  save(ws, pid, a.audit, { findings: [...b.findings, { finding_id: 'F6', area: 'allocations', kind: 'inference', statement: 'FICTIONAL: insiders received 40% of supply.', source_ids: ['S1'] }] });
  const v = F.view(ws, pid);
  const f6 = v.current.findings.find((f) => f.finding_id === 'F6');
  assert.equal(f6.eligibility.standing, 'references_hold', 'S1 exists and is preserved; whether it says this is not read by the desk');
  assert.match(v.current.eligibility.note, /does not check that a source says what a finding says/);
  assert.match(v.current.coverage.note, /does not check that a source says what a finding says/);
  assert.ok(!JSON.stringify(v).match(/"verified safe"|verified_safe/), 'nothing is called verified safe');
});

test('F03: the headline and the detail give the same kind for weak common-control attribution', (t) => {
  const { ws, pid, cleanup } = setup('fc-f03');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const b = FX.block(a.audit);
  const f2 = { ...b.findings[1], area: 'wallets', kind: 'observation', wallet_relation: 'inferred_common_control', basis: ['shared_exchange_funder'], statement: 'FICTIONAL: the deployer and wallet W share a funder.' };
  save(ws, pid, a.audit, { findings: [b.findings[0], f2, b.findings[2]] });
  const v = F.view(ws, pid);
  const head = v.current.strongest_concern.finding;
  const detail = v.current.findings.find((f) => f.finding_id === 'F2');
  assert.equal(head.shown_kind, 'hypothesis');
  assert.equal(detail.shown_kind, head.shown_kind, 'one finding index for both');
  assert.equal(head.original_kind, 'observation', 'the author\'s kind is kept as metadata');
  assert.match(head.kind_note, /Common control is not established/);
  // A stronger basis reads as an inference, never an observation.
  assert.equal(E.effectiveKind({ ...f2, basis: ['direct_transfer'] }).kind, 'inference');
});

// ---------------------------------------------------------------------------
// F02: decimals from the exact chain; exact amounts; the request checked.

const BASE = '0x1111111111111111111111111111111111111111';
test('F02: the same address with other decimals on another chain never sets the amount; zero decimals are valid', async (t) => {
  const coin = (dp) => ({ id: 'fictional-base-token', detail_platforms: dp });
  const look = (dp, chainId = '8453') => XQ.lookupDecimals(null, { coingeckoId: 'fictional-base-token', chainId, family: 'evm', address: BASE, cgGetImpl: async () => coin(dp) });
  const eth18 = { decimal_place: 18, contract_address: BASE };
  const base6 = { decimal_place: 6, contract_address: BASE.toUpperCase().replace('0X', '0x') };
  assert.equal((await look({ ethereum: eth18, base: base6 })).decimals, 6, 'Ethereum listed first: Base still reads 6');
  assert.equal((await look({ base: base6, ethereum: eth18 })).decimals, 6, 'any order');
  assert.equal((await look({ ethereum: eth18, base: base6 }, '1')).decimals, 18, 'Ethereum reads its own 18');
  const none = await look({ ethereum: eth18 });
  assert.equal(none.decimals, null, 'no Base entry: no quote, never another chain\'s decimals');
  assert.match(none.reason, /never used/);
  assert.equal((await look({ base: { decimal_place: 6, contract_address: '0x2222222222222222222222222222222222222222' } })).decimals, null, 'another address on Base: unknown');
  assert.equal((await look({ base: { decimal_place: 0, contract_address: BASE } })).decimals, 0, 'zero decimals is a valid token');
  // Exact amounts: integer arithmetic from the stored price.
  assert.equal(XQ.baseUnitsFor(500, 2, 6), '250000000');
  assert.equal(XQ.baseUnitsFor(500, 2, 18), `250${'0'.repeat(18)}`);
  assert.equal(XQ.baseUnitsFor(500, 2, 0), '250');
  assert.equal(XQ.baseUnitsFor(500, 0.3, 18), '1666666666666666666666', 'cut, never rounded up');
  assert.equal(XQ.baseUnitsFor(1, 3, 0), null, 'less than one unit sells nothing');
  assert.equal(XQ.unitsText('250000000', 6), '250');
  assert.equal(XQ.unitsText('5', 0), '5');
  // The request is checked before sending: a changed token, amount or chain is not sent.
  const p = XQ.PROVIDERS.kyberswap;
  const chain = p.chains[8453];
  const url = XQ.requestUrl(p, chain, { token: BASE, amountIn: '250000000' });
  const ok = { token: BASE, amountIn: '250000000', decimals: 6, priceUsd: 2, sizeUsd: 500 };
  assert.equal(XQ.outboundProblem(p, chain, url, ok), null);
  assert.match(XQ.outboundProblem(p, chain, url, { ...ok, decimals: 18 }), /sells \$0\.0000|not the \$500/, '18 decimals on a 6-decimal amount sells nothing like $500');
  assert.match(XQ.outboundProblem(p, chain, url.replace('/base/', '/ethereum/'), ok), /another chain/);
  assert.match(XQ.outboundProblem(p, chain, url.replace(BASE, '0x2222222222222222222222222222222222222222'), ok), /another token/);
});

test('F02: through the monitor, a Base exit of $500 at $2 asks for 250 tokens of 6 decimals, and records why', async (t) => {
  const tw = tempWorkspace('fc-f02-run');
  t.after(tw.cleanup);
  const ws = tw.ws;
  const p = require('../core/projects').addProject(ws, { name: 'Base Example (FICTIONAL)', symbol: 'XBAS', official_website: 'https://example.org/xbas', coingecko_id: 'fictional-base-token', assets: [{ chain: 'base', contract_address: BASE }], evidence: [{ url: 'https://example.org/xbas', note: 'fictional' }] });
  const now = Date.now();
  fs.mkdirSync(path.join(ws.root, 'market-data'), { recursive: true });
  atomicWrite(path.join(ws.root, 'market-data', 'latest.json'), jsonText({ provider: 'coingecko', assets: { 'fictional-base-token': { id: 'fictional-base-token', price_usd: 2, source_last_updated_at: at(now - 60000), fetched_at: at(now - 60000) } } }));
  const v0 = F.view(ws, p.project_id);
  const key = v0.monitoring.proposed.exit_quotes.find((o) => o.chain === 'base').key;
  F.setMonitoring(ws, p.project_id, { approve_quotes: [key], enabled: true });
  const asked = [];
  const fetchImpl = async (u) => {
    const url = new URL(u);
    asked.push(url);
    const amountIn = url.searchParams.get('amountIn');
    const body = { code: 0, data: { routeSummary: { tokenIn: url.searchParams.get('tokenIn'), tokenOut: url.searchParams.get('tokenOut'), amountIn, amountOut: String(Math.floor((Number(amountIn) / 1e6) * 2 * 0.98 * 1e6)), amountInUsd: '500', amountOutUsd: '490', gasUsd: '0.02', route: [[{ exchange: 'fictional-dex' }]] } } };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const cgGetImpl = async () => ({ id: 'fictional-base-token', detail_platforms: { ethereum: { decimal_place: 18, contract_address: BASE }, base: { decimal_place: 6, contract_address: BASE } } });
  const r = await monitor.refresh(ws, { now, fetchImpl, cgGetImpl, sleep: async () => {} });
  assert.equal(r.counts.quotes, 3, r.message);
  const amounts = asked.map((u) => u.searchParams.get('amountIn'));
  assert.ok(amounts.includes('250000000'), `asked ${amounts.join(', ')}`);
  assert.ok(!amounts.some((x) => x.length > 12), 'never the 18-decimal amount');
  const o = F.readObservations(ws, p.project_id, { to: now + H }).find((x) => x.size_usd === 500);
  assert.equal(o.token.decimals, 6);
  assert.equal(o.token.platform, 'base');
  assert.equal(o.amount_tokens, '250');
});

// ---------------------------------------------------------------------------
// F04: frozen pins are verified on every handoff, save and read.

test('F04: a changed evidence packet or prompt is an integrity failure; nothing is handed out, saved or frozen', (t) => {
  const { ws, pid, root, cleanup } = setup('fc-f04');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude', challenge: true });
  const audit = a.audit;
  const packetFile = path.join(root, audit.evidence_packet.path);
  const original = fs.readFileSync(packetFile, 'utf8');
  assert.ok(F.promptFor(ws, F.loadAudit(ws, pid, audit.audit_id), 'investigator').text, 'unchanged files hand off byte for byte');
  fs.writeFileSync(packetFile, original.replace('"captured_at"', '"captured_at" ')); // one byte
  const p = F.promptFor(ws, F.loadAudit(ws, pid, audit.audit_id), 'investigator');
  assert.equal(p.text, null);
  assert.equal(p.code, 'INTEGRITY');
  // A draft first (the job is open), then the save: refused, nothing written,
  // the text kept as the draft.
  const receipts = () => (fs.existsSync(path.join(root, 'projects', pid, 'forensics', 'receipts')) ? fs.readdirSync(path.join(root, 'projects', pid, 'forensics', 'receipts')) : []);
  const text = FX.reportText(audit);
  assert.throws(() => F.saveReport(ws, { project_id: pid, audit_id: audit.audit_id, provider: 'claude', text }), (e) => e.code === 'INTEGRITY' && /kept as this job's draft/.test(e.message));
  assert.deepEqual(receipts(), []);
  assert.equal(F.readDraft(ws, pid, audit.audit_id, 'investigator'), text, 'the result is recoverable');
  const after = F.loadAudit(ws, pid, audit.audit_id);
  assert.equal(after.jobs.investigator.state, 'running', 'the job is not completed');
  assert.equal(after.jobs.challenge.state, 'blocked', 'no challenge was frozen');
  // Restored, the same text saves, and the challenge is frozen from the pinned packet.
  fs.writeFileSync(packetFile, original);
  const s = F.saveReport(ws, { project_id: pid, audit_id: audit.audit_id, provider: 'claude', text });
  assert.equal(s.status, 'saved');
  const chal = F.promptFor(ws, F.loadAudit(ws, pid, audit.audit_id), 'challenge');
  assert.ok(chal.text.includes(original.trim()), 'the challenger gets the captured packet the pin names');
  // A changed receipt text is never served as the original.
  const textFile = path.join(root, s.receipt.text.path);
  assert.equal(F.receiptText(ws, pid, s.receipt_id).verified, true);
  fs.appendFileSync(textFile, ' ');
  assert.throws(() => F.receiptText(ws, pid, s.receipt_id), (e) => e.code === 'INTEGRITY');
  // A changed packet stops a later challenge request too.
  fs.writeFileSync(packetFile, `${original} `);
  const a2 = backdatedAudit(ws, pid, 0, { refresh: true });
  fs.writeFileSync(path.join(root, a2.evidence_packet.path), 'tampered');
  assert.throws(() => F.saveReport(ws, { project_id: pid, audit_id: a2.audit_id, provider: 'claude', text: FX.reportText(a2) }), (e) => e.code === 'INTEGRITY');
});

// ---------------------------------------------------------------------------
// F05: a revision keeps its forecast; only a new audit starts a new origin.

test('F05: a format-fix revision 20 days later keeps the origin, deadlines, thresholds and origin estimates', (t) => {
  const { ws, pid, cleanup } = setup('fc-f05');
  t.after(cleanup);
  const audit = backdatedAudit(ws, pid, 21);
  const s1 = save(ws, pid, audit, { assessment_as_of: at(Date.now() - 20 * DAY) });
  const s2 = save(ws, pid, audit, { assessment_as_of: at(Date.now() - 60000), plain_assessment: 'FICTIONAL. Same assessment, a typo fixed.' }, { revision: { kind: 'format_fix', note: 'A typo in the summary was fixed; nothing else changed.' } });
  assert.equal(s2.status, 'saved');
  for (const k of ['origin', 'deadlines', 'thresholds', 'scenarios_at_origin', 'preferences']) assert.deepEqual(s2.receipt[k], s1.receipt[k], k);
  assert.equal(s2.receipt.origin_basis, 'inherited');
  assert.equal(s2.receipt.origin_of, s1.receipt_id);
  assert.equal(s2.receipt.assessment_as_of, s1.receipt.assessment_as_of, 'a format fix does not make the research younger');
  assert.ok(Date.parse(s2.receipt.block_as_of) > Date.parse(s1.receipt.origin) + 19 * DAY, 'its own block time is kept apart');
  const v = F.view(ws, pid);
  assert.equal(v.current.receipt_id, s2.receipt_id);
  assert.equal(v.current.origin, s1.receipt.origin, 'the active timeline did not move');
  assert.ok(v.current.age_hours >= 20 * 24 - 1, 'the age shown is the assessment\'s, not the fix\'s');
  // A reassessment revision has its own assessment date, and still keeps
  // the forecast's origin: only a new audit starts a new one.
  const s2b = save(ws, pid, audit, { assessment_as_of: at(Date.now() - 30000), plain_assessment: 'FICTIONAL. Read again.' }, { revision: { kind: 'reassessment', note: 'The same evidence read again after a question from Eric.' } });
  assert.equal(s2b.receipt.origin, s1.receipt.origin);
  assert.ok(Date.parse(s2b.receipt.assessment_as_of) > Date.parse(s1.receipt.origin) + 19 * DAY);
  // An explicit new audit is a new forecast, linked to the one before.
  const a3 = F.createAudit(ws, { project_id: pid, assistant: 'claude', refresh: true });
  const s3 = save(ws, pid, a3.audit);
  assert.ok(Date.parse(s3.receipt.origin) > Date.parse(s1.receipt.origin) + 19 * DAY);
  assert.equal(s3.receipt.predecessor.receipt_id, s2b.receipt_id, 'linked to the latest receipt of the forecast before it');
  assert.deepEqual(F.loadReceipt(ws, pid, s1.receipt_id).deadlines, s1.receipt.deadlines, 'the earlier timeline is untouched');
  assert.equal(F.view(ws, pid, { receipt: s1.receipt_id }).current.origin, s1.receipt.origin);
});

// ---------------------------------------------------------------------------
// F06: repository order manufactures nothing; genuine inactivity still resolves.

test('F06: an active repository listed after a stale one is no inactivity episode, in either order', (t) => {
  // Both repositories bound to the project: its own docs page names them
  // (eligibility@2 binds a repository only so, or by identity or approval).
  const named = FX.block({ audit_id: 'fa_x', project_id: 'x' }).sources.map((s) => (s.source_id === 'S4' ? { ...s, excerpt: 'FICTIONAL: our code is at github.com/example/xmpl and github.com/example/old.' } : s));
  const repos = (first, second) => ({ sources: named, delivery: { observations: [first, second] } });
  const now = Date.now();
  const stale = { obs_id: 'R1', repository: 'github.com/example/old', observed_at: at(now - 60000), latest_commit_at: at(now - 100 * DAY), source_id: 'S4' };
  const active = { obs_id: 'R2', repository: 'github.com/example/xmpl', observed_at: at(now - 60000), latest_commit_at: at(now - DAY), source_id: 'S4' };
  for (const [label, over] of [['stale first', repos(stale, active)], ['active first', repos(active, stale)]]) {
    const { ws, pid, cleanup } = setup(`fc-f06-${label.replace(' ', '')}`);
    t.after(cleanup);
    const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
    const s = save(ws, pid, a.audit, over);
    const r = F.readingsFor(ws, pid, { receipts: F.listReceipts(ws, pid), prefs: s.receipt.preferences, identityReceipt: s.receipt });
    assert.equal(r.delivery.length, 1, `${label}: one batch, one reading`);
    assert.equal(r.delivery[0].beyond, false, label);
    const due = F.resolveReceipt(ws, pid, s.receipt, { receipts: F.listReceipts(ws, pid), now: Date.parse(s.receipt.origin) + 72 * H + 8 * DAY });
    const cp = due.find((x) => x.checkpoint === '72h' && x.event === 'delivery_inactivity');
    assert.notEqual(cp.result.outcome, 'occurred', `${label}: no episode from array order`);
  }
  // Both stale: genuine inactivity is still read.
  const g = setup('fc-f06-genuine');
  t.after(g.cleanup);
  const a = F.createAudit(g.ws, { project_id: g.pid, assistant: 'claude' });
  const s = save(g.ws, g.pid, a.audit, repos(stale, { ...active, latest_commit_at: at(now - 90 * DAY) }));
  const r = F.readingsFor(g.ws, g.pid, { receipts: F.listReceipts(g.ws, g.pid), prefs: s.receipt.preferences, identityReceipt: s.receipt });
  assert.equal(r.delivery[0].beyond, true);
  // The monitor's first run: two approved repositories read seconds apart.
  const m = setup('fc-f06-monitor');
  t.after(m.cleanup);
  const am = F.createAudit(m.ws, { project_id: m.pid, assistant: 'claude' });
  const sm = save(m.ws, m.pid, am.audit, { delivery: { observations: [] }, monitoring_targets: { product_checks: [], repositories: [{ host: 'github', owner: 'example', repo: 'old', source_id: 'S4' }, { host: 'github', owner: 'example', repo: 'xmpl', source_id: 'S4' }] } });
  F.setMonitoring(m.ws, m.pid, { approve: { receipt_id: sm.receipt_id } });
  const prof = F.readProfile(m.ws, m.pid);
  const T = Date.now();
  F.appendObservation(m.ws, m.pid, { kind: 'repository_read', target_id: prof.targets.repositories[0].target_id, repository: 'github.com/example/old', observed_at: at(T), status: 'ok', latest_delivery_at: at(T - 100 * DAY) });
  F.appendObservation(m.ws, m.pid, { kind: 'repository_read', target_id: prof.targets.repositories[1].target_id, repository: 'github.com/example/xmpl', observed_at: at(T + 2000), status: 'ok', latest_delivery_at: at(T - DAY) });
  const rm = F.readingsFor(m.ws, m.pid, { receipts: F.listReceipts(m.ws, m.pid), prefs: sm.receipt.preferences, identityReceipt: sm.receipt, now: T + 5000 });
  assert.deepEqual(rm.delivery.map((x) => x.beyond), [null, false], 'the first stale read alone is not enough coverage to say no delivery');
  assert.equal(M.evaluateEvent(D.EVENTS.delivery_inactivity, rm.delivery, { now: T + 5000 }).episodes.length, 0);
});

// ---------------------------------------------------------------------------
// F07: a valid zero is a reading; missing stays missing.

function storeVolume(ws, cgId, values, { endDay = 1 } = {}) {
  // values oldest first; the last at `endDay` days ago (noon UTC); null = missing day.
  const byMonth = new Map();
  const today = Date.parse(`${at(Date.now()).slice(0, 10)}T12:00:00Z`);
  values.forEach((v, i) => {
    if (v === null) return;
    const t = today - (values.length - 1 - i + endDay) * DAY;
    const line = { fetched_at: at(t), provider: 'fictional', trigger: 'test', assets: [{ id: cgId, source_last_updated_at: at(t), price_usd: 1, volume_24h_usd: v }] };
    const m = at(t).slice(0, 7);
    byMonth.set(m, [...(byMonth.get(m) || []), JSON.stringify(line)]);
  });
  fs.mkdirSync(ws.abs('market-data/observations'), { recursive: true });
  for (const [m, lines] of byMonth) fs.appendFileSync(ws.abs(`market-data/observations/${m}.jsonl`), `${lines.join('\n')}\n`);
}

test('F07: a latest zero volume is shown and is past a positive level; no date is projected from it; missing is unknown', (t) => {
  const cg = 'example-payfi-fictional';
  const z = setup('fc-f07-zero');
  t.after(z.cleanup);
  storeVolume(z.ws, cg, [...Array(30).fill(1000), 0]);
  const a = F.createAudit(z.ws, { project_id: z.pid, assistant: 'claude' });
  const s = save(z.ws, z.pid, a.audit);
  assert.equal(s.receipt.thresholds.volume_review_usd, 500);
  const v = F.view(z.ws, z.pid);
  assert.equal(v.liquidity.observed_volume.latest.value, 0, 'the panel shows the zero');
  const sc = v.scenarios.volume;
  assert.equal(sc.latest.value, 0, 'the scenario reads the same latest value');
  assert.equal(sc.beyond_now, true, 'zero is below a positive volume level');
  assert.equal(sc.projection, 'unavailable_at_zero');
  assert.ok(sc.scenarios.every((x) => x.crosses_at === null));
  assert.equal(sc.version, D.SCENARIOS_VERSION_3);
  // Missing: the last three days absent. Nothing is filled in as zero; the
  // latest real reading is older than the freshness window, so: unknown.
  const m = setup('fc-f07-missing');
  t.after(m.cleanup);
  storeVolume(m.ws, cg, Array(30).fill(1000), { endDay: 3 });
  const am = F.createAudit(m.ws, { project_id: m.pid, assistant: 'claude' });
  save(m.ws, m.pid, am.audit);
  const vm = F.view(m.ws, m.pid);
  assert.equal(vm.scenarios.volume.status, 'insufficient');
  assert.equal(vm.scenarios.volume.latest.value, 1000, 'never a synthesized zero');
  // Recovery from a non-zero low still projects.
  const rec = M.scenarioEstimates(Array.from({ length: 21 }, (_, i) => ({ day: at(Date.now() - (20 - i) * DAY).slice(0, 10), t: Date.now() - (20 - i) * DAY - H, value: 300 * 1.04 ** i })), { threshold: 1000, worse: 'lower', origin: at(Date.now()), now: Date.now() });
  assert.ok(rec.scenarios.find((x) => x.kind === 'recovery').crosses_at);
});

// ---------------------------------------------------------------------------
// F08 / F09: the latest answer per route scope; costs complete or "at least".

test('F08: a later "no route" supersedes an earlier cheap quote of the same scope; another route stays visible; stale is said', () => {
  const base = Date.parse('2026-10-16T13:00:00Z');
  const q = (min, extra = {}, quote = {}) => ({ obs_id: `Q${min}`, kind: 'executable_quote', route_scope: 'aggregator', venue: 'Example aggregator', chain: 'example-chain', retrieved_at: at(base + min * 60000), ...extra, quote: { sell_usd: 500, received_usd: 499, gas_usd: 0.1, ...quote } });
  const tax0 = () => ({ pct: 0, source: 'GoPlus' });
  const cheap = q(1);
  const gone = q(50, {}, { received_usd: null, no_route: true });
  let tbl = M.exitTable([cheap, gone], [500], { taxOf: tax0, now: base + 55 * 60000 })[0];
  assert.equal(tbl.status, 'no_route', 'the latest answer of the scope is the current one');
  assert.equal(tbl.best, null);
  assert.equal(tbl.earlier, 1);
  let rd = M.liquidityReadings([cheap, gone], { positionUsd: 500, limitPct: 5, taxOf: tax0 });
  assert.deepEqual(rd.map((x) => x.beyond), [false, true], 'distinct times, each read on its own');
  // An independent route, still valid, is visible and counted.
  const venue = q(5, { obs_id: 'V5', route_scope: 'single_venue', venue: 'Example DEX' });
  tbl = M.exitTable([cheap, gone, venue], [500], { taxOf: tax0, now: base + 55 * 60000 })[0];
  assert.equal(tbl.routes.length, 2);
  assert.equal(tbl.best.venue, 'Example DEX');
  assert.ok(tbl.routes.some((r) => r.status === 'no_route' && r.venue === 'Example aggregator'));
  rd = M.liquidityReadings([cheap, gone, venue], { positionUsd: 500, limitPct: 5, taxOf: tax0 });
  assert.equal(rd[rd.length - 1].beyond, false, 'a complete cost within the limit on any current route');
  // Older than the freshness window: stale, not a current estimate.
  const old = M.exitTable([cheap], [500], { taxOf: tax0, now: base + 100 * H })[0];
  assert.equal(old.status, 'stale');
  assert.equal(old.best, null);
  assert.match(old.note, /older than 72 hours/);
});

test('F09: a missing network fee is "at least", said first; a lower bound over the limit counts, within it does not', () => {
  const now = Date.now();
  const q = { obs_id: 'Q', kind: 'executable_quote', route_scope: 'aggregator', retrieved_at: at(now), quote: { sell_usd: 500, received_usd: 499, gas_usd: null } };
  const e = M.exitEstimate(q, 500, { tax: { pct: 0, source: 'GoPlus' } });
  assert.equal(e.cost_complete, false);
  assert.deepEqual(e.missing_costs, ['network fee']);
  assert.match(e.limitations[0], /^Cost incomplete: network fee unknown/);
  const row = M.exitTable([q], [500], { taxOf: () => ({ pct: 0, source: 'GoPlus' }), now })[0];
  assert.equal(row.best_words, 'at least 0.2%; network fee unknown');
  const within = M.liquidityReadings([q], { positionUsd: 500, limitPct: 5, taxOf: () => ({ pct: 0, source: 'GoPlus' }) });
  assert.equal(within[0].beyond, null);
  const cp = M.exitEstimate({ kind: 'pool_reserves', mechanism: 'constant_product', base_reserve: 1e7, quote_reserve: 1e6, quote_usd_price: 1, fee_bps: 30, retrieved_at: at(now) }, 500);
  assert.equal(cp.cost_complete, false);
  assert.match(cp.limitations.join(' '), /A calculation from one pool's reserves at one moment, not a quote/);
  assert.ok(cp.included_costs.some((x) => /pool fee/.test(x)), 'the pool fee is counted once, in the calculation');
  const included = M.exitEstimate({ ...q, quote: { sell_usd: 500, received_usd: 499, gas_usd: 0.5, gas_included: true } }, 500, { tax: { pct: 0, source: 'GoPlus' } });
  assert.equal(included.cost_complete, true);
  assert.equal(included.cost_pct, 0.2, 'a fee already inside the quote is not added twice');
  assert.equal(e.one_way, true);
});

// ---------------------------------------------------------------------------
// F10: incomplete product reads are no reading.

function transportFor({ status = 200, headers = { 'content-type': 'text/html' }, chunks = [], fail = null, hang = false }) {
  return async (url, { lookup }) => {
    await new Promise((resolve, reject) => lookup(url.hostname, {}, (err) => (err ? reject(err) : resolve())));
    let stream;
    if (hang) stream = new Readable({ read() {} });
    else if (fail) {
      stream = new Readable({ read() {} });
      setImmediate(() => { for (const c of chunks) stream.push(c); stream.destroy(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); });
    } else stream = Readable.from(chunks);
    return { status, headers, stream, abort() { stream.destroy(); } };
  };
}
const publicLookup = (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);

test('F10: broken compression, a broken stream, a cut answer and a time-out are incomplete; a complete answer passes or fails', async (t) => {
  const tw = tempWorkspace('fc-f10');
  t.after(tw.cleanup);
  const cfg = { timeout_seconds: 0.4, max_bytes: 64 };
  const run = (target, tr) => monitor.productCheck(tw.ws, { target_id: 'pc_000000000000', label: 'x', url: 'https://example.com/status', ...target }, { cfg, lookupImpl: publicLookup, transport: tr, now: Date.now });
  const textTarget = { expect_status: 200, expect_text: 'operational' };
  const statusOnly = { expect_status: 200, expect_text: null };
  const gz = await run(statusOnly, transportFor({ headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, chunks: [Buffer.from('this is not gzip')] }));
  assert.equal(gz.outcome, 'incomplete');
  assert.equal(gz.read, 'bad_encoding');
  assert.ok(gz.error, 'the read error is kept, never "no error"');
  const broken = await run(textTarget, transportFor({ chunks: [Buffer.from('<p>All systems')], fail: true }));
  assert.equal(broken.outcome, 'incomplete');
  assert.equal(broken.read, 'read_error');
  const cut = await run(textTarget, transportFor({ chunks: [Buffer.from(`${'x'.repeat(100)} operational`)] }));
  assert.equal(cut.outcome, 'incomplete', 'not found in a cut answer is not absent');
  assert.equal(cut.read, 'cut_at_cap');
  const cutFound = await run(textTarget, transportFor({ chunks: [Buffer.from(`operational ${'x'.repeat(100)}`)] }));
  assert.equal(cutFound.outcome, 'pass', 'found before the cut');
  const slow = await run(textTarget, transportFor({ hang: true }));
  assert.equal(slow.outcome, 'incomplete');
  assert.equal(slow.read, 'timed_out');
  const absent = await run(textTarget, transportFor({ chunks: [Buffer.from('<p>Down for maintenance</p>')] }));
  assert.equal(absent.outcome, 'fail', 'a complete answer without the text is a failure');
  const good = await run(textTarget, transportFor({ chunks: [zlib.gzipSync('<p>All systems operational</p>')], headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } }));
  assert.equal(good.outcome, 'pass');
  assert.equal(good.read, 'complete');
  assert.match(good.body_norm_sha256, /^[0-9a-f]{64}$/);
  const cutStatus = await run(statusOnly, transportFor({ chunks: [Buffer.from('y'.repeat(500))] }));
  assert.equal(cutStatus.outcome, 'pass', 'only the status was tested; a cap is expected');
  assert.equal(cutStatus.scope, 'status_only');
  // Incomplete reads are no reading: they never confirm failure or recovery.
  const readings = [gz, broken, cut, slow].map((o, i) => ({ at: at(Date.now() + i * H), beyond: o.outcome === 'fail' ? true : o.outcome === 'pass' ? false : null }));
  assert.ok(readings.every((r) => r.beyond === null));
});

// ---------------------------------------------------------------------------
// F11: new evidence at the same address; case-distinct paths.

test('F11: a new capture at the same address is new evidence; an unchanged duplicate is idempotent; case-distinct paths stay apart', (t) => {
  const { ws, pid, cleanup } = setup('fc-f11');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const b = FX.block(a.audit);
  const s1 = save(ws, pid, a.audit);
  const again = save(ws, pid, a.audit, { assessment_as_of: s1.receipt.assessment.assessment_as_of });
  assert.equal(again.status, 'unchanged');
  const newer = b.sources.map((s) => (s.source_id === 'S1' ? { ...s, excerpt: 'POST /v1/transfers now settles in two blocks (FICTIONAL).', content_sha256: sha256('FICTIONAL new capture'), retrieved_at: at(Date.now()) } : s));
  const s2 = save(ws, pid, a.audit, { sources: newer, plain_assessment: 'FICTIONAL. Settlement now takes two blocks.' }, { revision: { kind: 'new_evidence', note: 'The API page now says two blocks; recaptured.' } });
  assert.equal(s2.status, 'saved');
  assert.deepEqual(s2.receipt.evidence_added.map((x) => [x.source_id, x.change]), [['S1', 'new_capture_same_address']]);
  assert.equal(F.urlKey('https://EXAMPLE.com/Docs/API/'), 'https://example.com/Docs/API', 'host in lower case, path as written');
  assert.notEqual(F.urlKey('https://example.com/xmpl/Docs/api'), F.urlKey('https://example.com/xmpl/docs/api'));
  const caseDistinct = [...newer, { source_id: 'S6', url: 'https://example.com/xmpl/Docs/API', publisher: 'Example PayFi', type: 'primary', retrieved_at: at(Date.now()), excerpt: 'FICTIONAL: a different page at a case-distinct path.' }];
  const s3 = save(ws, pid, a.audit, { sources: caseDistinct, plain_assessment: 'FICTIONAL. One more page.' }, { revision: { kind: 'new_evidence', note: 'A second page at a case-distinct path was read.' } });
  assert.deepEqual(s3.receipt.evidence_added.map((x) => [x.source_id, x.change]), [['S6', 'new_address']]);
});

// ---------------------------------------------------------------------------
// F12 / F13: the original over the signed-in API; historical selection.

test('F12/F13: originals open over the signed-in API with their pins; an earlier receipt is shown whole and apart', async (t) => {
  const { ws, pid, root, cleanup } = setup('fc-f12');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude', challenge: true });
  const s1 = save(ws, pid, a.audit);
  const c = F.saveReport(ws, { project_id: pid, audit_id: a.audit_id, provider: 'chatgpt', text: FX.challengeText(F.loadAudit(ws, pid, a.audit_id), s1.receipt) });
  const s2 = save(ws, pid, a.audit, { plain_assessment: 'FICTIONAL. Revised wording.' }, { revision: { kind: 'format_fix', note: 'The summary was reworded only.' } });
  const { start } = require('../server');
  const srv = await start(ws, { port: 49600 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  await new Promise((r) => setTimeout(r, 300));
  const before = hashTree(path.join(root, 'projects'));
  let txt;
  let hist;
  const calls = await noNetwork(async () => {
    txt = await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics/receipts/${s1.receipt_id}/text` });
    hist = await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics?receipt=${s1.receipt_id}` });
  });
  assert.equal(calls, 0);
  assert.equal(txt.status, 200);
  assert.equal(txt.json.verified, true);
  assert.equal(sha256(txt.json.text), s1.receipt.text.sha256, 'the text is the original, byte for byte');
  assert.equal((await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics/receipts/${s1.receipt_id}/text`, auth: false })).status, 401, 'no session, no text; the token is never in the address');
  const v = hist.json;
  assert.equal(v.current.receipt_id, s1.receipt_id);
  assert.equal(v.current.is_latest, false);
  assert.equal(v.selected.latest_receipt_id, s2.receipt_id);
  assert.equal(v.current.plain_assessment, s1.receipt.assessment.plain_assessment, 'the earlier receipt\'s own words, never mixed with the latest');
  assert.equal(v.challenge.receipt_id, c.receipt_id, 'the challenge of that receipt');
  assert.ok(v.challenge.sources.find((s) => s.source_id === 'X1').check, 'the challenger\'s own source, with what the desk could check');
  assert.equal(v.challenge.calculation_checks.length, 1);
  assert.ok(v.receipts.find((r) => r.receipt_id === s1.receipt_id).selected);
  assert.equal((await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics?receipt=fr_2026-01-01T000000Z_aaaaa` })).status, 404);
  assert.equal((await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics?receipt=nope` })).status, 400);
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'reading wrote nothing');
  fs.appendFileSync(path.join(root, s1.receipt.text.path), 'x');
  const bad = await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics/receipts/${s1.receipt_id}/text` });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.code, 'INTEGRITY');
});

// ---------------------------------------------------------------------------
// P3: provider answers are bounded while they are read.

test('P3: an oversized answer is cut while it streams; a declared size over the cap is refused unread; a slow one times out', async () => {
  const chunk = new Uint8Array(64 * 1024);
  let pulled = 0;
  const big = new ReadableStream({ pull(c) { pulled += chunk.byteLength; c.enqueue(chunk); } });
  await assert.rejects(netguard.readBodyBounded({ headers: { get: () => null }, body: big }, 256 * 1024), (e) => e.code === 'CR_TOO_LARGE');
  assert.ok(pulled <= 256 * 1024 + 3 * chunk.byteLength, `read ${pulled} bytes for a 256 KB cap`);
  let read = false;
  const declared = { headers: { get: (k) => (k === 'content-length' ? String(10 * 1024 * 1024) : null) }, body: { getReader: () => { read = true; return { read: async () => ({ done: true }) }; } } };
  await assert.rejects(netguard.readBodyBounded(declared, 512 * 1024), (e) => e.code === 'CR_TOO_LARGE');
  assert.equal(read, false);
  // Through the quote reader: a body that never ends is stopped by the time limit.
  const slowFetch = async (url, init) => ({ status: 200, headers: { get: () => null }, body: new ReadableStream({ start(c) { init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))); } }) });
  const tw = tempWorkspace('fc-p3');
  try {
    const p = require('../core/projects').addProject(tw.ws, { name: 'Slow Example (FICTIONAL)', symbol: 'XSLO', official_website: 'https://example.org/xslo', coingecko_id: 'fictional-slow', assets: [{ chain: 'base', contract_address: BASE }], evidence: [{ url: 'https://example.org/xslo', note: 'fictional' }] });
    const now = Date.now();
    fs.mkdirSync(path.join(tw.ws.root, 'market-data'), { recursive: true });
    atomicWrite(path.join(tw.ws.root, 'market-data', 'latest.json'), jsonText({ provider: 'coingecko', assets: { 'fictional-slow': { id: 'fictional-slow', price_usd: 2, source_last_updated_at: at(now), fetched_at: at(now) } } }));
    const target = XQ.quoteOptions(require('../core/projects').getProject(tw.ws, p.project_id)).find((o) => o.supported);
    const out = await XQ.quoteTarget(tw.ws, { project: require('../core/projects').getProject(tw.ws, p.project_id), target: { ...target }, sizes: [500], cfg: { timeout_seconds: 0.3, quote_price_max_age_hours: 6 }, fetchImpl: slowFetch, now: () => now, reserve: () => true, sleep: async () => {}, observations: [], cgGetImpl: async () => ({ detail_platforms: { base: { decimal_place: 6, contract_address: BASE } } }) });
    assert.equal(out.observations[0].status, 'error');
    assert.match(out.observations[0].error, /timeout|aborted/i);
    assert.equal(out.observations[0].quote, null, 'no reading');
  } finally {
    tw.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The evidence-change review queue.

function queueSetup(label) {
  const x = setup(label);
  const a = F.createAudit(x.ws, { project_id: x.pid, assistant: 'claude' });
  const s = save(x.ws, x.pid, a.audit);
  F.setMonitoring(x.ws, x.pid, { approve: { receipt_id: s.receipt_id } });
  const prof = F.readProfile(x.ws, x.pid);
  return { ...x, s, pc: prof.targets.product_checks[0], gh: prof.targets.repositories[0] };
}

// One product-check observation as the monitor records it (normalize@2:
// a JSON answer canonicalized, anything else its bytes).
function check(ws, pid, pc, t, { outcome = 'pass', page = '{"status":"A"}', status = null, read = 'complete', error = null } = {}) {
  const ok = outcome === 'pass' || outcome === 'fail';
  const type = page.trim().startsWith('{') ? 'application/json' : 'text/html';
  return F.appendObservation(ws, pid, { kind: 'product_check', target_id: pc.target_id, label: pc.label, url: pc.url, observed_at: at(t), outcome, read, http_status: status || (outcome === 'fail' ? 503 : outcome === 'pass' ? 200 : null), content_type: type, error, body_sha256: ok && outcome === 'pass' ? sha256(page) : null, body_norm_sha256: ok && outcome === 'pass' ? sha256(monitor.normalizeBody(page, type)) : null, normalization: monitor.NORMALIZE_VERSION, expect_met: { status: outcome === 'pass', text: outcome === 'pass' ? true : null } });
}

test('queue: each change is classified, linked to its receipt, finding and source, and the receipt\'s capture is unchanged', (t) => {
  const { ws, pid, root, s, pc, cleanup } = queueSetup('fc-q1');
  t.after(cleanup);
  const T = Date.now() - 10 * H;
  check(ws, pid, pc, T, { page: '{"status":"operational","date":"2026-10-01","version":"1.2"}' });
  check(ws, pid, pc, T + H, { page: '{\n  "version": "1.2",\n  "status": "operational",\n  "date": "2026-10-01"\n}' }); // JSON formatting and key order only
  check(ws, pid, pc, T + 2 * H, { page: '{"status":"operational","date":"2026-10-02","version":"1.3"}' }); // a date and a number changed
  check(ws, pid, pc, T + 3 * H, { outcome: 'fail' });
  check(ws, pid, pc, T + 4 * H, { outcome: 'incomplete', error: 'cut' });
  check(ws, pid, pc, T + 5 * H, { outcome: 'incomplete', error: 'cut' });
  const before = hashTree(path.join(root, 'projects'));
  const v = F.view(ws, pid);
  assert.deepEqual(hashTree(path.join(root, 'projects')), before, 'reading the queue writes nothing');
  const th = v.evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  assert.deepEqual(th.items.map((i) => i.class), ['cosmetic_only', 'capture_changed', 'measurement_changed', 'read_failed']);
  const failed = th.items.find((i) => i.class === 'read_failed');
  assert.equal(failed.count, 2, 'one failed stretch, not one item per failure');
  assert.equal(failed.ended_at, null, 'still failing: said, not hidden');
  assert.equal(th.unavailable, true);
  assert.equal(th.state, 'open');
  assert.equal(th.mapping.status, 'mapped');
  assert.deepEqual(th.mapping.finding_ids, ['F1']);
  assert.equal(th.mapping.source_id, 'S1');
  assert.equal(th.mapping.frozen.excerpt, s.receipt.assessment.sources.find((x) => x.source_id === 'S1').excerpt, 'the frozen capture is shown as saved');
  const cap = th.items.find((i) => i.class === 'capture_changed');
  assert.ok(cap.previous && cap.current && cap.previous.observed_at < cap.current.observed_at, 'previous and new observations with their dates');
  assert.notEqual(monitor.normalizeBody('{"v":"1.2","d":"2026-10-01"}', 'application/json'), monitor.normalizeBody('{"v":"1.3","d":"2026-10-02"}', 'application/json'), 'the normalization keeps numbers and dates');
  assert.notEqual(monitor.normalizeBody(' a \r\n\r\n b ', 'text/html'), monitor.normalizeBody('a b', 'text/html'), 'HTML and text: every byte counts');
  // The same observations give the same item IDs on every read.
  assert.deepEqual(F.view(ws, pid).evidence_changes.threads.find((x) => x.target_id === pc.target_id).items.map((i) => i.item_id), th.items.map((i) => i.item_id));
  assert.equal(v.evidence_changes.to_review, 1);
  const repo = v.evidence_changes.threads.find((x) => x.kind === 'repository');
  assert.equal(repo.state, 'no_relevant_change');
});

test('queue: a review names the latest change (a newer one is refused), keeps a note and its history, and a later change reopens it', (t) => {
  const { ws, pid, root, pc, cleanup } = queueSetup('fc-q2');
  t.after(cleanup);
  const T = Date.now() - 10 * H;
  check(ws, pid, pc, T);
  check(ws, pid, pc, T + H, { outcome: 'fail' });
  check(ws, pid, pc, T + 2 * H);
  let th = F.view(ws, pid).evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  const [first, latest] = th.items;
  const gradesBefore = JSON.stringify(F.view(ws, pid).current.category_grades);
  const reviews = () => (fs.existsSync(path.join(root, RV.reviewsRel(pid))) ? fs.readFileSync(path.join(root, RV.reviewsRel(pid)), 'utf8') : '');
  assert.throws(() => RV.acknowledge(ws, pid, { target_id: pc.target_id, item_id: first.item_id }), (e) => e.code === 'NEWER_REPORT');
  assert.equal(reviews(), '', 'nothing written for a refused review');
  let calls = 0;
  let out;
  calls = await_(() => { out = RV.acknowledge(ws, pid, { target_id: pc.target_id, item_id: latest.item_id, note: 'FICTIONAL: looked at the outage and the recovery.', request_id: 'req_fictional_1' }); });
  assert.equal(calls, 0, 'no request of any kind');
  assert.equal(out.result.status, 'saved');
  assert.match(out.result.review.meaning, /does not make any claim true/);
  assert.equal(RV.acknowledge(ws, pid, { target_id: pc.target_id, item_id: latest.item_id, request_id: 'req_fictional_1' }).result.status, 'unchanged');
  assert.equal(RV.acknowledge(ws, pid, { target_id: pc.target_id, item_id: latest.item_id }).result.status, 'unchanged', 'the same change twice is one review');
  th = F.view(ws, pid).evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  assert.equal(th.state, 'reviewed');
  assert.equal(th.reviews[0].note, 'FICTIONAL: looked at the outage and the recovery.');
  assert.equal(JSON.stringify(F.view(ws, pid).current.category_grades), gradesBefore, 'a review changes no grade');
  // Formatting only (the same JSON): it stays reviewed. A failed read: reopened.
  check(ws, pid, pc, T + 3 * H, { page: '{ "status" : "A" }' });
  assert.equal(F.view(ws, pid).evidence_changes.threads.find((x) => x.target_id === pc.target_id).state, 'reviewed');
  check(ws, pid, pc, T + 4 * H, { outcome: 'incomplete', error: 'cut' });
  th = F.view(ws, pid).evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  assert.equal(th.state, 'reopened');
  assert.equal(th.since_review.filter((g) => g.relevant).length, 1);
  const lines = reviews().trim().split('\n');
  assert.equal(lines.length, 1, 'history is append-only, one line per review');
  RV.acknowledge(ws, pid, { target_id: pc.target_id, item_id: th.latest_relevant.item_id });
  assert.ok(reviews().startsWith(lines[0]), 'the earlier review is kept');
  assert.equal(reviews().trim().split('\n').length, 2);
});

function await_(fn) {
  const real = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('off'); };
  try { fn(); } finally { global.fetch = real; }
  return calls;
}

test('queue: exit quotes show as unmapped; an unmapped source is never linked to a finding by guess', (t) => {
  const { ws, pid, cleanup } = setup('fc-q3');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const s = save(ws, pid, a.audit, { monitoring_targets: { product_checks: [{ label: 'Docs', url: 'https://example.com/xmpl/docs', expect_status: 200, capability: 'docs up', source_id: 'S3' }, { label: 'Home', url: 'https://example.com/xmpl', expect_status: 200, capability: 'home', source_id: null }], repositories: [] } });
  F.setMonitoring(ws, pid, { approve: { receipt_id: s.receipt_id } });
  const prof = F.readProfile(ws, pid);
  // A fictional exit-quote target written as the profile holds one.
  const pf = path.join(ws.root, F.profileRel(pid));
  const doc = JSON.parse(fs.readFileSync(pf, 'utf8'));
  doc.targets.exit_quotes = [{ target_id: 'xq_000000000001', chain: 'example-chain', chain_id: null, chain_label: 'Example chain', contract_address: 'FICTIONAL-CONTRACT-XMPL', provider: 'kyberswap', quote_symbol: 'USDC' }];
  fs.writeFileSync(pf, JSON.stringify(doc));
  const q = F.view(ws, pid).evidence_changes;
  const docs = q.threads.find((x) => x.target_id === prof.targets.product_checks[0].target_id);
  const home = q.threads.find((x) => x.target_id === prof.targets.product_checks[1].target_id);
  const xq = q.threads.find((x) => x.kind === 'exit_quote');
  assert.equal(docs.mapping.status, 'source_only', 'S3 is cited by no finding');
  assert.deepEqual(docs.mapping.finding_ids, []);
  assert.equal(home.mapping.status, 'receipt_only');
  assert.equal(xq.mapping.status, 'unmapped');
  assert.match(xq.mapping.reason, /no link is made/);
});

test('queue, receipts and deadlines survive a backup and an isolated restore, which sends and dispatches nothing', async (t) => {
  const { ws, pid, root, pc, s, cleanup } = queueSetup('fc-q4');
  t.after(cleanup);
  const T = Date.now() - 5 * H;
  check(ws, pid, pc, T);
  check(ws, pid, pc, T + H, { outcome: 'fail' });
  const th = F.view(ws, pid).evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  RV.acknowledge(ws, pid, { target_id: pc.target_id, item_id: th.latest_relevant.item_id, note: 'FICTIONAL note' });
  const exporter = require('../core/exporter');
  const doc = exporter.exportJson(ws);
  const fx = doc.projects.find((x) => x.project.project_id === pid).forensics;
  assert.equal(fx.evidence_reviews.length, 1, 'the export carries the reviews');
  const er = fx.receipts.find((x) => x.receipt_id === s.receipt_id);
  assert.equal(er.desk_reading.version, E.VERSION, 'and the desk\'s reading beside the saved assessment');
  assert.equal(er.desk_reading.findings.F2.shown_kind, 'observation');
  assert.equal(er.assessment.findings[1].kind, 'observation', 'the saved assessment itself is unchanged');
  const b = exporter.createBackup(ws, { reason: 'test' });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-test-fc-restored-'));
  t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  fs.rmSync(dest, { recursive: true, force: true });
  assert.equal(exporter.restoreBackup(ws, b.name, { to: dest }).status, 'restored_and_verified');
  const ws2 = require('../core/workspace').openWorkspace({ root: dest, actor: 'test' });
  let v2;
  const calls = await noNetwork(async () => { v2 = F.view(ws2, pid); });
  assert.equal(calls, 0);
  assert.deepEqual(v2.current.deadlines, s.receipt.deadlines, 'deadlines restored as frozen');
  const th2 = v2.evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  assert.equal(th2.state, 'reviewed');
  assert.equal(th2.reviews[0].note, 'FICTIONAL note');
  assert.equal(F.receiptText(ws2, pid, s.receipt_id).verified, true, 'the restored original still matches its pin');
  // Nothing is sent or redispatched in the restored copy: the monitor is
  // held, and a retry of the same save is "unchanged", not a new receipt.
  let sent = 0;
  const r = await monitor.refresh(ws2, { fetchImpl: async () => { sent += 1; throw new Error('no'); }, transport: async () => { sent += 1; throw new Error('no'); } });
  assert.equal(r.status, 'held');
  assert.equal(sent, 0);
  const same = F.saveReport(ws2, { project_id: pid, audit_id: s.receipt.audit_id, provider: 'claude', text: fs.readFileSync(path.join(root, s.receipt.text.path), 'utf8') });
  assert.equal(same.status, 'unchanged');
});

test('method@2: an outcome the desk recorded under the earlier method is corrected by a traceable line; Eric\'s own correction stands', (t) => {
  const { ws, pid, cleanup } = setup('fc-method');
  t.after(cleanup);
  const a = F.createAudit(ws, { project_id: pid, assistant: 'claude' });
  const now = Date.now();
  const stale = { obs_id: 'R1', repository: 'github.com/example/old', observed_at: at(now - 60000), latest_commit_at: at(now - 100 * DAY), source_id: 'S4' };
  const active = { obs_id: 'R2', repository: 'github.com/example/xmpl', observed_at: at(now - 60000), latest_commit_at: at(now - DAY), source_id: 'S4' };
  const s = save(ws, pid, a.audit, { delivery: { observations: [stale, active] } });
  // A line as cr-forensic-method@1 recorded it (no method named): Occurred.
  const rel = path.join(ws.root, 'projects', pid, 'forensics', 'resolutions', `${s.receipt_id}.jsonl`);
  fs.mkdirSync(path.dirname(rel), { recursive: true });
  const old = { schema_version: 'cr.forensic-resolution.v1', entry_id: 'rs_fictional0001', receipt_id: s.receipt_id, checkpoint: '72h', deadline: s.receipt.deadlines[0].at, event: 'delivery_inactivity', event_version: D.EVENTS_VERSION, outcome: 'occurred', reason: null, recorded_at: at(now), recorded_by: 'forensics', corrects: null };
  fs.writeFileSync(rel, `${JSON.stringify(old)}\n`);
  const when = Date.parse(s.receipt.origin) + 72 * H + 8 * DAY;
  const vBefore = F.view(ws, pid, { now: when });
  const cp = vBefore.timeline.checkpoints.find((c) => c.id === '72h').observed.delivery_inactivity;
  assert.equal(cp.outcome, 'occurred', 'the recorded line is what is on record');
  assert.equal(cp.differs_now.method, D.METHOD_VERSION, 'and the difference is said before anything is written');
  const r = F.recordDueResolutions(ws, pid, { now: when });
  assert.ok(r.corrected >= 1);
  const lines = fs.readFileSync(rel, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], old, 'the earlier line is never rewritten');
  const corr = lines.find((l) => l.corrects === 'rs_fictional0001');
  assert.equal(corr.method, D.METHOD_VERSION);
  assert.equal(corr.previous_method, 'cr-forensic-method@1');
  assert.notEqual(corr.outcome, 'occurred');
  assert.equal(F.recordDueResolutions(ws, pid, { now: when + H }).corrected, 0, 'corrected once');
  // Eric's own correction is never overridden by a re-read.
  F.correctResolution(ws, pid, s.receipt_id, { checkpoint: '72h', event: 'delivery_inactivity', outcome: 'occurred', reason: 'FICTIONAL: I know the active repository is a mirror.' });
  assert.equal(F.recordDueResolutions(ws, pid, { now: when + 2 * H }).corrected, 0);
  assert.equal(F.view(ws, pid, { now: when + 2 * H }).timeline.checkpoints.find((c) => c.id === '72h').observed.delivery_inactivity.outcome, 'occurred');
});

test('queue over HTTP: a review is an explicit POST; a newer change is a 409 naming it; opening writes nothing', async (t) => {
  const { ws, pid, root, pc, cleanup } = queueSetup('fc-q5');
  t.after(cleanup);
  const T = Date.now() - 5 * H;
  check(ws, pid, pc, T);
  check(ws, pid, pc, T + H, { outcome: 'fail' });
  check(ws, pid, pc, T + 2 * H);
  const { start } = require('../server');
  const srv = await start(ws, { port: 49700 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  await new Promise((r) => setTimeout(r, 300));
  const before = hashTree(path.join(root, 'projects'));
  const v = (await request(srv.port, srv.token, { path: `/api/projects/${pid}/forensics` })).json;
  assert.deepEqual(hashTree(path.join(root, 'projects')), before);
  const th = v.evidence_changes.threads.find((x) => x.target_id === pc.target_id);
  const older = await request(srv.port, srv.token, { method: 'POST', path: `/api/projects/${pid}/forensics/reviews`, body: { target_id: pc.target_id, item_id: th.items[0].item_id } });
  assert.equal(older.status, 409);
  assert.equal(older.json.code, 'NEWER_REPORT');
  assert.equal(older.json.newer[0].item_id, th.latest_relevant.item_id);
  const ok = await request(srv.port, srv.token, { method: 'POST', path: `/api/projects/${pid}/forensics/reviews`, body: { target_id: pc.target_id, item_id: th.latest_relevant.item_id, note: 'FICTIONAL', request_id: 'req_fictional_http' } });
  assert.equal(ok.status, 200);
  const again = await request(srv.port, srv.token, { method: 'POST', path: `/api/projects/${pid}/forensics/reviews`, body: { target_id: pc.target_id, item_id: th.latest_relevant.item_id, note: 'FICTIONAL', request_id: 'req_fictional_http' } });
  assert.equal(again.json.result.status, 'unchanged');
  assert.equal(fs.readFileSync(path.join(root, RV.reviewsRel(pid)), 'utf8').trim().split('\n').length, 1);
  assert.equal((await request(srv.port, srv.token, { method: 'POST', path: `/api/projects/${pid}/forensics/reviews`, body: { target_id: 'bad', item_id: 'bad' } })).status, 400);
});
