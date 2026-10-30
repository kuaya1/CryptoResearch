'use strict';
// Scout leads, stage C: admission by Eric's click, "Confirm and request
// research" (intake plan rev. 2 §5, PR 5; audits/2026-10-29-intake-dialectic/
// PLAN.md). A confirm names the rows and the evidence Eric reviewed; any
// difference is 409 with nothing written; each admission's effects run under
// their own keys, so a replay or the next turn finishes a crash with the
// original IDs. FICTIONAL temporary desks and fake fetch only; no provider or
// model is asked for anything.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const L = require('../core/leads');
const projects = require('../core/projects');
const research = require('../core/research');
const { readJson } = require('../core/fsx');
const { hashTree } = require('./helpers');
const { POLICY, EVM, workspace, eligibleLeads, deliver, fake, coin, CLEAN } = require('./leads-fixtures');

const HOUR = 3600000;
let reqs = 0;
const rid = () => `req_test_${process.pid}_${++reqs}`;

// What the page sends for the rows it drew.
function expectFor(ws, keys) {
  const v = L.reviewView(ws);
  return {
    policy: { version: v.policy.version, sha256: v.policy.sha256 },
    envelope: v.envelope,
    rows: keys.map((k) => {
      const r = v.rows.find((x) => x.lead_key === k);
      return { lead_key: k, eligibility_receipt_id: r.eligibility_receipt_id, eligibility_sha256: r.eligibility_sha256, identity_revision: r.identity_revision, asset_revision: r.asset_revision };
    }),
  };
}
const confirm = (ws, keys, over = {}) => L.confirmLeads(ws, { request_id: rid(), expect: expectFor(ws, keys), ...over });
const refusal = (code, status) => (e) => e.code === code && e.status === status;
const files = (root) => hashTree(root);
// The settings' nested objects may be shared with the defaults: replace, never mutate.
const setResearch = (ws, patch) => { ws.settings = { ...ws.settings, research: { ...ws.settings.research, ...patch } }; };

test('one confirm admits the rows named: a project and a run each, the words naming the evidence', async (t) => {
  const { ws } = workspace(t, 'adm-basic');
  const [a, b, c] = await eligibleLeads(ws, [EVM(1), EVM(2), EVM(3)]);
  const out = confirm(ws, [a, b]);
  assert.equal(out.status, 'admitted');
  assert.equal(out.admissions.length, 2);
  assert.deepEqual(out.since_shown, { eligible_new: 1 }, 'the third is reported, never admitted');
  assert.equal(L.getAsset(ws, c).state, 'ELIGIBLE');
  const [x, y] = out.admissions;
  assert.equal(x.state, 'complete');
  assert.notEqual(x.project_id, y.project_id);
  assert.notEqual(x.run_id, y.run_id);
  for (const adm of out.admissions) {
    assert.equal(L.getAsset(ws, adm.lead_key).state, 'ADMITTED');
    const p = projects.getProject(ws, adm.project_id);
    assert.equal(p.identity.status, 'verified');
    const note = p.identity.evidence.find((e) => /Listed by Grok Scout/.test(e.note)).note;
    for (const re of [/delivery test-/, /eligible under cr-lead-eligibility@1 \(receipt le_/, /policy cr-lead-policy@1/, /confirmed by Eric in a batch of 2 \(request req_/, /research requested from Claude/]) assert.match(note, re);
    assert.doesNotMatch(note, /chosen and confirmed by Eric/);
    const run = research.loadRun(ws, adm.project_id, adm.run_id);
    assert.deepEqual(run.providers, ['claude']);
    assert.equal(run.channel, 'scout-leads');
    assert.equal(run.owner_instructions, null);
    const prompt = fs.readFileSync(ws.abs(run.prompt.path), 'utf8');
    assert.doesNotMatch(prompt, /A fictional lead for these tests/, 'the scout\'s signal never enters the prompt');
    // The intake record follows the run like a research request.
    const adm2 = L.readAdmission(ws, adm.admission_id);
    const doc = readJson(ws.abs(`inbox/intake/${adm2.intake_id}.json`));
    assert.equal(doc.status, 'researching');
    assert.equal(doc.confirmed.run_id, adm.run_id);
    assert.equal(doc.input.instructions, null);
  }
  // Distinct effect keys per admission.
  const applied = fs.readdirSync(ws.abs('logs/applied')).filter((f) => f.startsWith('admission--'));
  assert.equal(applied.length, 6);
});

test('a changed receipt, policy, expiry or envelope is 409 naming what changed, nothing written', async (t) => {
  const { ws, root } = workspace(t, 'adm-changed');
  const T = Date.now();
  const [a, b] = await eligibleLeads(ws, [EVM(10), EVM(11)], { now: T });
  // R1 -> R2: the receipt changes under the same lead key.
  const reviewed = expectFor(ws, [a]);
  ws.settings.leads = { ...POLICY, min_market_cap_usd: 999999 };
  await L.refresh(ws, { fetchImpl: fake(), clock: () => T + 1000 });
  ws.settings.leads = POLICY;
  await L.refresh(ws, { fetchImpl: fake(), clock: () => T + 2000 });
  const before = files(root);
  assert.throws(() => L.confirmLeads(ws, { request_id: rid(), expect: reviewed }), (e) => {
    assert.equal(e.code, 'CHANGED');
    assert.equal(e.status, 409);
    const row = e.details.rows.find((r) => r.lead_key === a);
    assert.ok(row.fields.some((f) => f.field === 'eligibility_receipt_id'));
    assert.ok(row.fields.some((f) => f.field === 'eligibility_sha256'));
    return true;
  });
  assert.deepEqual(files(root), before, 'nothing written');
  // A policy value changed under the same version.
  const r2 = expectFor(ws, [b]);
  ws.settings.leads = { ...POLICY, eligibility_hours: 48 };
  assert.throws(() => L.confirmLeads(ws, { request_id: rid(), expect: r2 }), (e) => e.code === 'CHANGED' && e.details.policy !== null);
  ws.settings.leads = POLICY;
  // An expired receipt.
  assert.throws(() => L.confirmLeads(ws, { request_id: rid(), expect: r2 }, { now: T + 25 * HOUR }), (e) => e.code === 'CHANGED' && e.details.rows[0].fields.some((f) => f.field === 'expires_at'));
  // A hold placed between the drawing and the click.
  setResearch(ws, { on_hold: { ...(ws.settings.research.on_hold || {}), chatgpt: { since: '2026-10-29', reason: 'test' } }, providers: { ...(ws.settings.research.providers || {}), gemini: { mock: 'ok' } } });
  assert.throws(() => L.confirmLeads(ws, { request_id: rid(), expect: r2 }), (e) => e.code === 'CHANGED' && e.details.envelope && e.details.envelope.now.models.includes('gemini'));
  assert.deepEqual(files(root), before);
});

test('a replay returns the batch; altered content under the same request is CONFLICT', async (t) => {
  const { ws, root } = workspace(t, 'adm-replay');
  const [a, b] = await eligibleLeads(ws, [EVM(20), EVM(21)]);
  const request_id = rid();
  const expect = expectFor(ws, [a]);
  const first = L.confirmLeads(ws, { request_id, expect });
  const again = L.confirmLeads(ws, { request_id, expect });
  assert.equal(again.status, 'unchanged');
  assert.deepEqual(again.admissions.map((x) => [x.project_id, x.run_id]), first.admissions.map((x) => [x.project_id, x.run_id]));
  const before = files(root);
  assert.throws(() => L.confirmLeads(ws, { request_id, expect: expectFor(ws, [b]) }), refusal('CONFLICT', 409));
  assert.deepEqual(files(root), before);
});

test('a crash after the intake, after the project and after the run finishes with the original IDs', async (t) => {
  const { ws } = workspace(t, 'adm-crash');
  const [a, b, c] = await eligibleLeads(ws, [EVM(30), EVM(31), EVM(32)]);
  // After the intake record: the project's step dies before it starts.
  const addProject = projects.addProject;
  let mode = 'before-project';
  t.mock.method(projects, 'addProject', function (...args) {
    if (mode === 'before-project') throw new Error('crash before the project');
    const r = addProject.apply(this, args);
    if (mode === 'after-project') throw new Error('crash after the project');
    return r;
  });
  const createRun = research.createRun;
  t.mock.method(research, 'createRun', function (...args) {
    const r = createRun.apply(this, args);
    if (mode === 'after-run') throw new Error('crash after the run');
    return r;
  });
  const request_id = rid();
  const expect = expectFor(ws, [a]);
  const one = L.confirmLeads(ws, { request_id, expect });
  assert.equal(one.admissions[0].effects.intake, 'done');
  assert.notEqual(one.admissions[0].state, 'complete');
  mode = 'after-project';
  const two = L.confirmLeads(ws, { request_id, expect });
  assert.equal(two.admissions[0].effects.project, 'done');
  const projectId = two.admissions[0].project_id;
  mode = 'after-run';
  const three = L.confirmLeads(ws, { request_id, expect });
  assert.equal(three.admissions[0].project_id, projectId);
  assert.notEqual(three.admissions[0].effects.research, 'done');
  const runs = research.listRuns(ws, projectId);
  assert.equal(runs.length, 1);
  // The run looks eleven minutes old: the replay still links that run.
  const runFile = ws.abs(`projects/${projectId}/research/${runs[0].run_id}/run.json`);
  if (fs.existsSync(runFile)) fs.writeFileSync(runFile, JSON.stringify({ ...readJson(runFile), created_at: new Date(Date.now() - 11 * 60000).toISOString() }));
  mode = 'ok';
  const four = L.confirmLeads(ws, { request_id, expect });
  assert.equal(four.admissions[0].state, 'complete');
  assert.equal(four.admissions[0].project_id, projectId);
  assert.equal(four.admissions[0].run_id, runs[0].run_id);
  assert.equal(research.listRuns(ws, projectId).length, 1);
  // The next turn, with no replay, finishes another crashed admission.
  mode = 'after-run';
  const other = L.confirmLeads(ws, { request_id: rid(), expect: expectFor(ws, [b]) });
  assert.notEqual(other.admissions[0].state, 'complete');
  mode = 'ok';
  assert.equal(L.isDue(ws), true, 'a pending admission makes the job due');
  const turn = await L.refresh(ws, { fetchImpl: fake() });
  assert.equal(turn.recovered.length, 1);
  const done = L.readAdmission(ws, other.admissions[0].admission_id);
  assert.equal(done.state, 'complete');
  assert.equal(research.listRuns(ws, done.project_id).length, 1);
  // A replay after completion creates nothing.
  const again = L.confirmLeads(ws, { request_id, expect });
  assert.equal(again.status, 'unchanged');
  assert.equal(research.listRuns(ws, projectId).length, 1);
  // One failed admission leaves the others admitted, with their receipts.
  mode = 'before-project';
  const ab = L.confirmLeads(ws, { request_id: rid(), expect: expectFor(ws, [c]) });
  assert.equal(ab.admissions[0].state, 'failed');
  assert.match(ab.admissions[0].errors[0].words, /crash before the project/);
});

test('one failed admission leaves the others in the batch admitted and visible', async (t) => {
  const { ws } = workspace(t, 'adm-partial');
  const [a, b] = await eligibleLeads(ws, [EVM(40), EVM(41)]);
  // The second's project is archived between the reading and the confirm: its
  // admission fails in words; the first completes.
  const addProject = projects.addProject;
  t.mock.method(projects, 'addProject', function (w, input, opts) {
    if (input.name === coin(EVM(41)).name) throw Object.assign(new Error('Fictional failure for this lead.'), { code: 'CONFLICT' });
    return addProject.call(this, w, input, opts);
  });
  const out = confirm(ws, [a, b]);
  assert.equal(out.status, 'admitted');
  const byKey = Object.fromEntries(out.admissions.map((x) => [x.lead_key, x]));
  assert.equal(byKey[a].state, 'complete');
  assert.ok(byKey[a].run_id);
  assert.equal(byKey[b].state, 'failed');
  assert.match(byKey[b].words, /Fictional failure/);
});

test('an effect not started within 24 hours lapses; Request research makes a new admission', async (t) => {
  const { ws } = workspace(t, 'adm-lapse');
  const [a] = await eligibleLeads(ws, [EVM(50)]);
  const createRun = research.createRun;
  let fail = true;
  t.mock.method(research, 'createRun', function (...args) {
    if (fail) throw new Error('crash before the run');
    return createRun.apply(this, args);
  });
  const out = confirm(ws, [a]);
  const id = out.admissions[0].admission_id;
  assert.equal(out.admissions[0].effects.project, 'done');
  fail = false;
  const late = L.completeAdmission(ws, id, { now: Date.now() + 25 * HOUR });
  assert.equal(late.state, 'lapsed');
  assert.equal(late.effects.research, 'lapsed');
  assert.match(late.words, /Project added; research not requested: the confirmation lapsed at/);
  assert.equal(research.listRuns(ws, late.project_id).length, 0, 'not started');
  assert.equal(L.isDue(ws), false, 'a lapsed admission is not pending');
  const again = L.requestAgain(ws, { admission_id: id, request_id: rid(), expect_envelope: L.envelope(ws) });
  assert.equal(again.state, 'complete');
  assert.equal(again.project_id, late.project_id);
  assert.notEqual(again.admission_id, id);
  assert.equal(research.listRuns(ws, late.project_id).length, 1);
});

test('held models are left out; every model held is NO_MODEL; an API route gets a queued job', async (t) => {
  const { ws, root } = workspace(t, 'adm-models', { research: { providers: { chatgpt: { mock: 'ok' } } } });
  const [a, b, c] = await eligibleLeads(ws, [EVM(60), EVM(61), EVM(62)]);
  let env = L.envelope(ws);
  assert.deepEqual(env.models, ['claude', 'chatgpt']);
  assert.deepEqual(env.routes, { claude: 'connector_or_manual', chatgpt: 'api' });
  const one = confirm(ws, [a]);
  const run = research.loadRun(ws, one.admissions[0].project_id, one.admissions[0].run_id);
  assert.deepEqual(run.providers, ['claude', 'chatgpt']);
  assert.equal(run.jobs.chatgpt.state, 'queued');
  assert.equal(run.jobs.claude.state, 'unconfigured');
  assert.equal(research.hasDueWork(ws), true);
  // Claude held.
  setResearch(ws, { on_hold: { claude: { since: '2026-10-29', reason: 'test' } } });
  env = L.envelope(ws);
  assert.deepEqual(env.models, ['chatgpt']);
  const two = confirm(ws, [b]);
  assert.deepEqual(research.loadRun(ws, two.admissions[0].project_id, two.admissions[0].run_id).providers, ['chatgpt']);
  // Every model held.
  setResearch(ws, { on_hold: { claude: { since: 'x' }, chatgpt: { since: 'x' }, gemini: { since: 'x' } } });
  assert.deepEqual(L.envelope(ws).models, []);
  const before = files(root);
  assert.throws(() => confirm(ws, [c]), refusal('NO_MODEL', 409));
  assert.deepEqual(files(root), before);
  assert.equal(L.getAsset(ws, c).state, 'ELIGIBLE');
});

test('dismissal stays; KNOWN and archived leads are never re-added; the view writes nothing', async (t) => {
  const { ws, root } = workspace(t, 'adm-dismiss');
  const [a, b] = await eligibleLeads(ws, [EVM(70), EVM(71)]);
  const d = L.dismissLead(ws, { lead_key: a, request_id: rid(), reason: 'Not for me.' });
  assert.equal(d.status, 'dismissed');
  deliver(ws, [{ contract: EVM(70) }]);
  const dismissed = L.getAsset(ws, a);
  assert.equal(dismissed.state, 'DISMISSED');
  assert.equal(dismissed.sightings.length, 2, 'a new sighting is only appended');
  assert.throws(() => confirm(ws, [a]), (e) => e.code === 'CHANGED' && e.details.rows[0].fields.some((f) => f.field === 'state' && f.now === 'DISMISSED'));
  // Admitted, then archived: a new sighting is not a new lead.
  const out = confirm(ws, [b]);
  projects.archiveProject(ws, out.admissions[0].project_id, 'test');
  deliver(ws, [{ contract: EVM(71) }]);
  assert.equal(L.getAsset(ws, b).state, 'ADMITTED');
  assert.throws(() => L.dismissLead(ws, { lead_key: b, request_id: rid() }), refusal('CONFLICT', 409));
  // A new lead for a contract an archived project holds reads KNOWN.
  const [k] = deliver(ws, [{ contract: EVM(71).toUpperCase().replace('0X', '0x'), chain: 'base' }]);
  assert.equal(k, b, 'the same identity is the same lead');
  const before = files(root);
  L.reviewView(ws);
  L.envelope(ws);
  assert.deepEqual(files(root), before);
});

// ---------------------------------------------------------------------------
// The post-implementation audit's findings (audits/2026-10-29-intake-dialectic/
// POST_IMPLEMENTATION_AUDIT.md), each reproduced and held to the corrected
// outcome. FICTIONAL desks, fake fetch and mock routes only.

const { readApplied } = require('../core/ops');
const ageRun = (ws, projectId, runId, minutes) => {
  const file = ws.abs(research.loadRun(ws, projectId, runId).prompt.path.replace(/prompt\.md$/, 'run.json'));
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), created_at: new Date(Date.now() - minutes * 60000).toISOString() }, null, 2));
};

test('F1: a run linked minutes after one Eric started is recorded under the key; after a crash, and that run ageing out, the replay still links it', async (t) => {
  const { ws } = workspace(t, 'adm-f1-run');
  const [a] = await eligibleLeads(ws, [EVM(901)]);
  const createRun = research.createRun;
  let mode = 'crash';
  let manual = null;
  t.mock.method(research, 'createRun', function (w, args, options) {
    if (mode === 'crash') {
      manual = createRun.call(this, w, { ...args, channel: 'dashboard' });
      const linked = createRun.call(this, w, args, options);
      assert.equal(linked.status, 'exists');
      assert.equal(linked.run_id, manual.run_id);
      throw new Error('crash after linking the recent run, before the admission recorded it');
    }
    return createRun.call(this, w, args, options);
  });
  const adm = confirm(ws, [a]).admissions[0];
  assert.equal(adm.state, 'failed');
  const rec = readApplied(ws, `admission:${adm.admission_id}#research`);
  assert.ok(rec, 'the link is recorded under the run key');
  assert.deepEqual([rec.result.run_id, rec.result.basis], [manual.run_id, 'existing_recent']);
  ageRun(ws, manual.project_id, manual.run_id, 11);
  mode = 'ok';
  const done = L.completeAdmission(ws, adm.admission_id);
  assert.equal(done.state, 'complete');
  assert.equal(done.run_id, manual.run_id, 'the replay links the same run');
  assert.equal(done.run_basis, 'existing_recent');
  assert.equal(research.listRuns(ws, manual.project_id).length, 1, 'no second run');
});

test('F1: a keyed link to an existing project or a recent run is recorded; a replay returns it; another payload under the key is a conflict', (t) => {
  const { ws } = workspace(t, 'adm-f1-keys');
  const { addFixtureProject } = require('./helpers');
  const made = addFixtureProject(ws);
  const input = { name: 'Example PayFi (FICTIONAL)', symbol: 'XMPL', official_website: 'https://example.com/xmpl', coingecko_id: 'example-payfi-fictional', assets: [{ chain: 'example-chain', contract_address: 'FICTIONAL-CONTRACT-XMPL' }], evidence: [], sector_profile: 'payfi-credit@1' };
  const pkey = { key: 'admission:la_00000000000001#project', payload_sha256: 'a'.repeat(64) };
  const linked = projects.addProject(ws, input, { idempotency: pkey });
  assert.equal(linked.status, 'exists');
  assert.equal(linked.project_id, made.project_id);
  const prec = readApplied(ws, pkey.key);
  assert.deepEqual([prec.result.project_id, prec.result.basis], [made.project_id, 'existing']);
  const again = projects.addProject(ws, input, { idempotency: pkey });
  assert.deepEqual([again.status, again.project_id, again.replayed], ['exists', made.project_id, true]);
  assert.throws(() => projects.addProject(ws, input, { idempotency: { ...pkey, payload_sha256: 'b'.repeat(64) } }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  const first = research.createRun(ws, { project_id: made.project_id, providers: ['claude'] });
  const rkey = { key: 'admission:la_00000000000001#research', payload_sha256: 'c'.repeat(64) };
  const link = research.createRun(ws, { project_id: made.project_id, providers: ['claude'] }, { idempotency: rkey });
  assert.deepEqual([link.status, link.run_id, link.basis], ['exists', first.run_id, 'existing_recent']);
  ageRun(ws, made.project_id, first.run_id, 30);
  const replay = research.createRun(ws, { project_id: made.project_id, providers: ['claude'] }, { idempotency: rkey });
  assert.deepEqual([replay.status, replay.run_id, replay.replayed], ['exists', first.run_id, true]);
  assert.throws(() => research.createRun(ws, { project_id: made.project_id, providers: ['claude'] }, { idempotency: { ...rkey, payload_sha256: 'd'.repeat(64) } }), (e) => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(research.listRuns(ws, made.project_id).length, 1);
  const unkeyed = research.createRun(ws, { project_id: made.project_id, providers: ['claude'] });
  assert.equal(unkeyed.status, 'created', 'without a key nothing changes: past the window a new run is made');
});

test('F1: the admission freezes its effects\' payload hashes when it is written', async (t) => {
  const { ws } = workspace(t, 'adm-f1-frozen');
  const [a] = await eligibleLeads(ws, [EVM(915)]);
  const adm = L.readAdmission(ws, confirm(ws, [a]).admissions[0].admission_id);
  assert.match(adm.effect_keys.intake_sha256, /^[0-9a-f]{64}$/);
  assert.match(adm.effect_keys.project_sha256, /^[0-9a-f]{64}$/);
  assert.match(adm.effect_keys.research_base_sha256, /^[0-9a-f]{64}$/);
  assert.equal(readApplied(ws, `admission:${adm.admission_id}#project`).payload_sha256, adm.effect_keys.project_sha256);
});

test('F2: a route that moved to an API since the confirm creates no job; Complete does not retry it; Request research confirms again', async (t) => {
  const { ws, root } = workspace(t, 'adm-f2');
  const [a, b] = await eligibleLeads(ws, [EVM(902), EVM(903)]);
  const createRun = research.createRun;
  let fail = true;
  t.mock.method(research, 'createRun', function (...args) {
    if (fail) throw new Error('crash before the run');
    return createRun.apply(this, args);
  });
  const body = { request_id: rid(), expect: expectFor(ws, [a]) };
  assert.equal(body.expect.envelope.routes.claude, 'connector_or_manual');
  const first = L.confirmLeads(ws, body).admissions[0];
  assert.equal(first.state, 'failed');
  // Claude gains an API route (a fictional mock) before the recovery.
  setResearch(ws, { providers: { ...ws.settings.research.providers, claude: { mock: 'ok' } } });
  fail = false;
  const after = L.completeAdmission(ws, first.admission_id);
  assert.equal(after.state, 'needs_consent');
  assert.equal(after.effects.research, 'needs_consent');
  assert.equal(after.effects.project, 'done');
  assert.match(after.words, /research not requested: Changed since you confirmed: Claude was its connection or a pasted prompt when you confirmed, its API now/);
  assert.equal(research.listRuns(ws, after.project_id).length, 0, 'no run, so no due API job');
  assert.equal(research.hasDueWork(ws), false);
  assert.equal(L.isDue(ws), false, 'it waits for Eric, not for the next turn');
  const before = files(root);
  assert.equal(L.completeAdmission(ws, first.admission_id).state, 'needs_consent');
  assert.deepEqual(files(root), before, 'Complete does not retry it');
  // Eric requests research again with the routes as they are now.
  const again = L.requestAgain(ws, { admission_id: first.admission_id, request_id: rid(), expect_envelope: L.envelope(ws) });
  assert.equal(again.state, 'complete');
  assert.equal(research.loadRun(ws, again.project_id, again.run_id).jobs.claude.state, 'queued');
  // Changed spending limits with an API route are the same outcome.
  fail = true;
  const second = confirm(ws, [b]).admissions[0];
  assert.equal(second.state, 'failed');
  setResearch(ws, { budget: { ...(ws.settings.research.budget || {}), per_run_usd: 3 } });
  fail = false;
  const limits = L.completeAdmission(ws, second.admission_id);
  assert.equal(limits.state, 'needs_consent');
  assert.match(limits.words, /the research spending limits changed/);
});

test('F2: a model held after the confirm keeps its job in the frozen set and the job stays unsent', async (t) => {
  const { ws } = workspace(t, 'adm-f2-hold', { research: { providers: { chatgpt: { mock: 'ok' } } } });
  const [a] = await eligibleLeads(ws, [EVM(904)]);
  const createRun = research.createRun;
  let fail = true;
  t.mock.method(research, 'createRun', function (...args) {
    if (fail) throw new Error('crash before the run');
    return createRun.apply(this, args);
  });
  const first = confirm(ws, [a]).admissions[0];
  assert.deepEqual(L.readAdmission(ws, first.admission_id).envelope.models, ['claude', 'chatgpt']);
  setResearch(ws, { on_hold: { chatgpt: { since: '2026-10-29', reason: 'test' } } });
  fail = false;
  const done = L.completeAdmission(ws, first.admission_id);
  assert.equal(done.state, 'complete');
  assert.deepEqual(research.loadRun(ws, done.project_id, done.run_id).providers, ['claude', 'chatgpt'], 'the frozen set');
  assert.equal(research.hasDueWork(ws), false, 'the held model job is not sent');
});

test('F3: an intake failure on the first row still answers every committed admission; the others complete; a replay finishes it once', async (t) => {
  const { ws } = workspace(t, 'adm-f3');
  const ops = require('../core/ops');
  const keys = await eligibleLeads(ws, [EVM(905), EVM(906), EVM(907)]);
  const writeJson = ops.StagedOp.prototype.writeJson;
  let fail = true;
  t.mock.method(ops.StagedOp.prototype, 'writeJson', function (rel, ...args) {
    if (fail && String(rel).startsWith('inbox/intake/')) { fail = false; throw new Error('fictional intake save failure'); }
    return writeJson.call(this, rel, ...args);
  });
  const request_id = rid();
  const expect = expectFor(ws, keys);
  const out = L.confirmLeads(ws, { request_id, expect });
  assert.equal(out.status, 'admitted');
  assert.equal(out.admissions.length, 3, 'every committed admission is answered');
  assert.deepEqual(out.admissions.map((x) => x.state), ['failed', 'complete', 'complete']);
  assert.equal(out.admissions[0].effects.intake, 'failed');
  assert.match(out.admissions[0].words, /fictional intake save failure/);
  assert.equal(out.batch.admission_ids.length, 3);
  const replay = L.confirmLeads(ws, { request_id, expect });
  assert.equal(replay.status, 'unchanged');
  assert.ok(replay.admissions.every((x) => x.state === 'complete'));
  assert.deepEqual(replay.admissions.map((x) => research.listRuns(ws, x.project_id).length), [1, 1, 1], 'each once');
});

test('F3: a middle row whose link fails after its project and run committed is finished by a replay, not doubled', async (t) => {
  const { ws } = workspace(t, 'adm-f3-link');
  const ops = require('../core/ops');
  const keys = await eligibleLeads(ws, [EVM(908), EVM(909), EVM(910)]);
  const writeJson = ops.StagedOp.prototype.writeJson;
  let fails = 0;
  t.mock.method(ops.StagedOp.prototype, 'writeJson', function (rel, obj, ...args) {
    if (String(rel).startsWith(`${L.ADMISSIONS}/`) && obj && obj.lead_key === keys[1] && obj.run_id && fails++ === 0) throw new Error('fictional link failure');
    return writeJson.call(this, rel, obj, ...args);
  });
  const out = confirm(ws, keys);
  assert.deepEqual(out.admissions.map((x) => x.state), ['complete', 'failed', 'complete']);
  assert.match(out.admissions[1].words, /fictional link failure/);
  const fixed = L.completeAdmission(ws, out.admissions[1].admission_id);
  assert.equal(fixed.state, 'complete');
  assert.equal(research.listRuns(ws, fixed.project_id).length, 1, 'the run made before the link failed is linked');
});

test('F3: a failure that cannot be recorded is answered as not recorded, never as saved', async (t) => {
  const { ws } = workspace(t, 'adm-f3-unrecorded');
  const ops = require('../core/ops');
  const keys = await eligibleLeads(ws, [EVM(911), EVM(912)]);
  const writeJson = ops.StagedOp.prototype.writeJson;
  t.mock.method(ops.StagedOp.prototype, 'writeJson', function (rel, obj, ...args) {
    // After the confirm commits, no write for the first admission succeeds.
    const mine = obj && (obj.lead_key === keys[0] || (obj.scout_admission && obj.scout_admission.lead_key === keys[0]));
    if (mine && (String(rel).startsWith('inbox/intake/') || (String(rel).startsWith(`${L.ADMISSIONS}/`) && obj.errors && obj.errors.length))) throw new Error('fictional disk failure');
    return writeJson.call(this, rel, obj, ...args);
  });
  const out = confirm(ws, keys);
  assert.equal(out.admissions.length, 2);
  const [x, y] = out.admissions;
  assert.equal(x.state, 'pending', 'its stored state, not progress it never saved');
  assert.equal(x.errors[x.errors.length - 1].recorded, false);
  assert.match(x.words, /this try was not recorded/);
  assert.equal(L.readAdmission(ws, x.admission_id).effects.intake, 'pending');
  assert.equal(y.state, 'complete');
});

test('F6: a receipt replaced under the same ID with a valid self-hash, or a new claim since the review, is 409 with nothing written; a new sighting is not', async (t) => {
  const { ws, root } = workspace(t, 'adm-f6');
  const [a, b] = await eligibleLeads(ws, [EVM(913), EVM(914)]);
  const body = { request_id: rid(), expect: expectFor(ws, [a]) };
  const row = body.expect.rows[0];
  assert.equal(typeof row.asset_revision, 'number', 'the view gives the asset revision and the page sends it');
  const rel = ws.abs(`${L.ELIGIBILITY}/${row.eligibility_receipt_id}.json`);
  const original = fs.readFileSync(rel, 'utf8');
  const cases = {
    'another reading': (r) => { r.observations.find((o) => o.source === 'coingecko').facts.name = 'Unreviewed name (FICTIONAL)'; },
    'refused content': (r) => { r.state = 'REFUSED'; r.reasons = ['never reviewed (FICTIONAL)']; },
    'another policy': (r) => { r.policy = { ...r.policy, sha256: 'e'.repeat(64) }; },
    'already expired': (r) => { r.expires_at = new Date(Date.now() - 60000).toISOString(); },
    'another asset revision': (r) => { r.asset_revision += 5; },
  };
  for (const [name, edit] of Object.entries(cases)) {
    const r = JSON.parse(original);
    edit(r);
    r.eligibility_sha256 = L.receiptSha(r);
    fs.writeFileSync(rel, JSON.stringify(r, null, 2));
    assert.notEqual(r.eligibility_sha256, row.eligibility_sha256, name);
    const before = files(root);
    assert.throws(() => L.confirmLeads(ws, body), (e) => e.code === 'CHANGED' && e.status === 409 && e.details.rows[0].fields.some((f) => /eligibility_receipt|receipt_/.test(f.field)), name);
    assert.deepEqual(files(root), before, `${name}: nothing written`);
  }
  fs.writeFileSync(rel, original);
  // The asset claimed again for a new reading since the review.
  const assetFile = ws.abs(`${L.ASSETS}/${a}.json`);
  const asset = readJson(assetFile);
  fs.writeFileSync(assetFile, JSON.stringify({ ...asset, revision: asset.revision + 1 }, null, 2));
  assert.throws(() => L.confirmLeads(ws, body), (e) => e.code === 'CHANGED' && e.details.rows[0].fields.some((f) => f.field === 'asset_revision'));
  fs.writeFileSync(assetFile, JSON.stringify(asset, null, 2));
  // A new sighting changes no revision: the reviewed row still confirms.
  deliver(ws, [{ contract: EVM(913) }]);
  const out = L.confirmLeads(ws, body);
  assert.equal(out.admissions[0].state, 'complete');
  assert.equal(L.readAdmission(ws, out.admissions[0].admission_id).eligibility_sha256, row.eligibility_sha256);
  assert.equal(L.getAsset(ws, b).state, 'ELIGIBLE');
});

// Found by the populated browser check: a lead's row showed whichever
// admission sorted last by ID, so after Request research it could keep the
// superseded one and offer the button again.
test('after Request research the lead shows the new admission; the superseded one cannot request again', async (t) => {
  const { ws, root } = workspace(t, 'adm-follows');
  const [k] = await eligibleLeads(ws, [EVM(940)]);
  const createRun = research.createRun;
  let fail = true;
  t.mock.method(research, 'createRun', function (...args) {
    if (fail) throw new Error('crash before the run');
    return createRun.apply(this, args);
  });
  const first = confirm(ws, [k]).admissions[0];
  fail = false;
  assert.equal(L.completeAdmission(ws, first.admission_id, { now: Date.now() + 25 * HOUR }).state, 'lapsed');
  // A request whose new admission sorts before the one it follows.
  const { sha256 } = require('../core/fsx');
  const { stableStringify } = require('../core/requests');
  let reqId = rid();
  while (`la_${sha256(stableStringify([reqId, k])).slice(0, 14)}` > first.admission_id) reqId = rid();
  const again = L.requestAgain(ws, { admission_id: first.admission_id, request_id: reqId, expect_envelope: L.envelope(ws) });
  assert.ok(again.admission_id < first.admission_id);
  const row = L.reviewView(ws).rows.find((r) => r.lead_key === k);
  assert.equal(row.admission.admission_id, again.admission_id, 'the row shows the admission that follows');
  assert.equal(row.admission.state, 'complete');
  const before = files(root);
  assert.throws(() => L.requestAgain(ws, { admission_id: first.admission_id, request_id: rid(), expect_envelope: L.envelope(ws) }), (e) => e.code === 'CONFLICT' && e.status === 409 && e.details.admission_id === again.admission_id);
  assert.deepEqual(files(root), before, 'nothing written');
  assert.equal(research.listRuns(ws, again.project_id).length, 1, 'one run');
});

// Remedy verification (2026-10-29), F5 upgrade: a Solana receipt the pre-fix
// worker wrote kept only the fee now, so an answer with a 25% scheduled fee
// read ELIGIBLE. Opened by the current code, that unedited receipt must not
// be confirmed: the confirm is 409 CHANGED with nothing written, the lead is
// due at once, and the next turn asks again (never reusing the old reading)
// and decides under the rules in force. A fully known zero-fee receipt still
// confirms.
test('F5 upgrade: a pre-fix ELIGIBLE Solana receipt without the fee schedule or hook is refused at confirm and read again', async (t) => {
  const { reply } = require('./leads-fixtures');
  const { ws, root } = workspace(t, 'adm-f5-upgrade', { leads: { ...POLICY, chains: ['8453', 'solana'] } });
  const OLD = `2${'A'.repeat(42)}B`;
  const CTRL = `3${'C'.repeat(42)}D`;
  const now = Date.now();
  const [oldKey, ctrlKey] = deliver(ws, [{ chain: 'solana', contract: OLD }, { chain: 'solana', contract: CTRL }], now);
  const fee = (scheduled) => ({ current_fee_rate: { fee_rate: '0' }, scheduled_fee_rate: scheduled });
  let answers = { [OLD]: { transfer_fee: fee([]), transfer_hook: [], non_transferable: '0' }, [CTRL]: { transfer_fee: fee([]), transfer_hook: [], non_transferable: '0' } };
  const f = fake({ onCall: (url) => {
    const cg = /\/coins\/solana\/contract\/([1-9A-HJ-NP-Za-km-z]+)/.exec(url);
    if (cg) return reply(200, { ...coin(`0x${cg[1].slice(0, 4)}`), detail_platforms: { solana: { contract_address: cg[1], decimal_place: 9 } } });
    const gp = /\/solana\/token_security\?contract_addresses=([1-9A-HJ-NP-Za-km-z]+)/.exec(url);
    if (gp) return reply(200, { code: 1, message: 'OK', result: { [gp[1]]: answers[gp[1]] } });
    return null;
  } });
  await L.refresh(ws, { fetchImpl: f, clock: () => now });
  for (const k of [oldKey, ctrlKey]) assert.equal(L.getAsset(ws, k).state, 'ELIGIBLE');
  // The pre-fix worker's receipt for OLD: the GoPlus facts as it stored them
  // (fee now only), self-hashed as it wrote them; the asset pins that hash.
  const asset = L.getAsset(ws, oldKey);
  const rel = ws.abs(`${L.ELIGIBILITY}/${asset.eligibility.receipt_id}.json`);
  const r = readJson(rel);
  const gpObs = r.observations.find((o) => o.source === 'goplus');
  gpObs.facts = { transfer_fee_pct: 0, severe: [], watch: [] };
  r.criteria = r.criteria.filter((c) => c.name === 'market_cap_usd' || c.name === 'volume_24h_usd' || c.name === 'transfer_fee_pct');
  r.eligibility_sha256 = L.receiptSha(r);
  fs.writeFileSync(rel, JSON.stringify(r, null, 2));
  const assetFile = ws.abs(`${L.ASSETS}/${oldKey}.json`);
  const raw = readJson(assetFile);
  fs.writeFileSync(assetFile, JSON.stringify({ ...raw, eligibility: { ...raw.eligibility, eligibility_sha256: r.eligibility_sha256 } }, null, 2));
  const legacy = fs.readFileSync(rel, 'utf8');
  // Intact and ELIGIBLE as stored, INCOMPLETE under the rule in force.
  assert.equal(L.getReceipt(ws, r.receipt_id).state, 'ELIGIBLE');
  assert.equal(L.judge(asset.identity, [], r.observations, L.policyOf(ws)).state, 'INCOMPLETE');
  assert.equal(L.factsCurrent(r.observations, 'solana'), false);
  // The review shows it as being read again, never confirmable.
  const row = L.reviewView(ws).rows.find((x) => x.lead_key === oldKey);
  assert.equal(row.rescreen_due, true);
  assert.equal(row.expired, true);
  assert.match(row.reasons.join(' '), /schedule of transfer fees|transferability|transfer hook/);
  // Confirming with the exact receipt and revision the view gives: 409, nothing written.
  const body = { request_id: rid(), expect: expectFor(ws, [oldKey]) };
  const before = files(root);
  assert.throws(() => L.confirmLeads(ws, body), (e) => {
    assert.equal(e.code, 'CHANGED');
    assert.equal(e.status, 409);
    const field = e.details.rows[0].fields.find((x) => x.field === 'eligibility_rule');
    assert.ok(field, 'the obsolete rule is named');
    assert.equal(field.now, 'INCOMPLETE');
    return true;
  });
  assert.deepEqual(files(root), before, 'nothing written');
  assert.equal(projects.listProjects(ws).length, 0, 'no project was made');
  // Due at once, though unexpired and under the same policy.
  assert.ok(Date.parse(asset.eligibility.expires_at) > Date.now());
  assert.deepEqual(L.dueAssets(ws).map((a) => a.asset_id), [oldKey], 'only the obsolete reading is due; the control is not');
  assert.equal(L.isDue(ws), true);
  // The next turn asks GoPlus again (the 25% schedule the old worker missed)
  // and decides under the rules in force; the kept receipt is untouched.
  answers = { ...answers, [OLD]: { transfer_fee: fee([{ epoch: '42', fee_rate: '0.25' }]), transfer_hook: [], non_transferable: '0' } };
  const calls = f.calls.length;
  await L.refresh(ws, { fetchImpl: f, clock: () => Date.now() });
  assert.ok(f.calls.slice(calls).some((u) => u.includes('/solana/token_security') && u.includes(OLD)), 'a fresh screen, not the old reading reused');
  const after = L.getAsset(ws, oldKey);
  assert.equal(after.state, 'REFUSED');
  assert.notEqual(after.eligibility.receipt_id, r.receipt_id);
  assert.match(after.eligibility.reasons.join(' '), /transfer fee 25%/);
  assert.equal(fs.readFileSync(rel, 'utf8'), legacy, 'the kept receipt is never rewritten');
  // The fully known zero-fee control still confirms.
  const out = confirm(ws, [ctrlKey]);
  assert.equal(out.admissions[0].state, 'complete');
});
