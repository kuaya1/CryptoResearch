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
      return { lead_key: k, eligibility_receipt_id: r.eligibility_receipt_id, eligibility_sha256: r.eligibility_sha256, identity_revision: r.identity_revision };
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
