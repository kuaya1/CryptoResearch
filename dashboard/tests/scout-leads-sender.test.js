'use strict';
// Scout leads, the sender (intake plan rev. 2, PR 3): grok-cron.js makes a
// fifth xAI call under cr-scout-leads-prompt@1 when leads are on, after the
// brief and apart from it, and delivers the leads under an ID made before it
// sends. xAI and the desk are fakes; the desk's side saves with the real
// ingest into a temporary workspace. FICTIONAL records only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../core/scout');
const L = require('../core/leads');
const G = require('../scripts/grok-cron');
const { tempWorkspace } = require('./helpers');
const { sha256 } = require('../core/fsx');

const KEY = 'test-ingest-key-not-real-0123456789abcdef';
const XAI_KEY = 'xai-test-key-not-real-0123456789';
const DESK = 'https://desk.test';
const REPO = path.join(__dirname, '..', '..');
const T0 = Date.parse('2026-10-29T11:31:00.000Z');
const ENV = { XAI_API_KEY: XAI_KEY, DESK_INGEST_KEY: KEY, DESK_INGEST_URL: DESK, GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2' };
const EVM = (n) => `0x${String(n).padStart(4, '0')}${'cd'.repeat(18)}`;
const item = { title: 'Example Tool (FICTIONAL)', creator: 'Example Labs', url_primary: 'https://example.com/tool', url_repo: 'https://github.com/example/tool', summary: 'A fictional tool.', desk_leverage: 'Could help.', readiness: 'beta' };

function temp(t, label) {
  const w = tempWorkspace(label);
  t.after(w.cleanup);
  return w.ws;
}
const answer = (status, body) => ({ status, json: async () => body });
// A fake xAI and desk. Every request is recorded as sent (its URL, method
// and body text), so the brief's can be compared byte for byte.
function fakes(t, { leadsAnswer = null, leadsPing = null, leadsPost = [] } = {}) {
  const ws = temp(t, 'leads-sender');
  const sent = [];
  const f = async (url, opts = {}) => {
    sent.push({ url, method: opts.method, body: opts.body || null });
    if (url === G.XAI_URL) {
      const body = JSON.parse(opts.body);
      const sys = body.input[0].content;
      if (/^# Scout leads \(cr-scout-leads-prompt@1\)/.test(sys)) {
        return leadsAnswer || answer(200, { output_text: JSON.stringify({ leads: [{ chain: 'base', contract: EVM(1), coingecko_id: null, signal: 'A fictional\nsignal.', urls: ['https://example.com/lead'], name: 'dropped' }, { chain: 'nowhere', contract: 'x', signal: 'Refused at intake.' }] }), usage: { input_tokens: 1000, output_tokens: 100 } });
      }
      const lane = /for the lane ([a-z]+)\./.exec(body.input[1].content)[1];
      return answer(200, { output_text: JSON.stringify({ lane, items: lane === 'agents' ? [item] : [] }), usage: { input_tokens: 1000, output_tokens: 100 } });
    }
    assert.equal(opts.headers.authorization, `Bearer ${KEY}`);
    if (url === `${DESK}${S.BRIEF_PATH}`) {
      if (opts.method === 'GET') return answer(200, { ok: true, key: 'accepted', briefs_today: 0, max_per_day: 6 });
      return answer(200, S.ingest(ws, JSON.parse(opts.body), { now: T0 }));
    }
    if (url === `${DESK}${L.LEADS_PATH}`) {
      if (opts.method === 'GET') return leadsPing || answer(200, { ok: true, key: 'accepted', leads_today: L.leadsToday(ws, T0), max_per_day: 6 });
      const queued = leadsPost.shift();
      if (queued) return queued;
      try {
        const r = L.ingest(ws, JSON.parse(opts.body), { now: T0, raw: opts.body });
        return answer(r.status === 'accepted' ? 202 : 200, r);
      } catch (err) {
        return answer(err.status || (err.code === 'INVALID' ? 400 : 503), { code: err.code });
      }
    }
    throw new Error(`unexpected address ${url}`);
  };
  return { f, sent, ws };
}
function lines() {
  const out = [];
  const fn = (l) => out.push(l);
  fn.all = out;
  return fn;
}
const briefTraffic = (sent) => sent.filter((s) => s.url === `${DESK}${S.BRIEF_PATH}` || (s.url === G.XAI_URL && !/cr-scout-leads-prompt@1/.test(s.body)));

test('leads sender: the brief\'s requests and its POST are byte-identical with leads on and off; leads come after', async (t) => {
  const off = fakes(t);
  const rOff = await G.run({ env: ENV, fetch: off.f, now: T0, out: lines(), postWaits: [0] });
  assert.equal(rOff.leads, undefined, 'leads off: no leads result');
  assert.equal(off.sent.filter((s) => s.url.endsWith(L.LEADS_PATH)).length, 0, 'leads off: the desk\'s leads path is never asked');
  assert.equal(off.sent.filter((s) => s.url === G.XAI_URL).length, 4, 'leads off: four xAI calls');
  const on = fakes(t);
  const out = lines();
  const rOn = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: on.f, now: T0, out, postWaits: [0] });
  assert.deepEqual(briefTraffic(on.sent), briefTraffic(off.sent), 'the brief\'s traffic is the same, byte for byte');
  assert.deepEqual(on.sent.slice(0, briefTraffic(on.sent).length), briefTraffic(on.sent), 'the brief goes first');
  assert.equal(rOn.status, rOff.status);
  assert.equal(rOn.ok, true);
  assert.equal(on.sent.filter((s) => s.url === G.XAI_URL).length, 5, 'a fifth xAI call for leads');
  assert.equal(rOn.leads.status, 'accepted');
  assert.equal(rOn.leads.delivery_id, 'gh-123456-2');
  assert.equal(rOn.leads.rows, 2);
  const posted = JSON.parse(on.sent.find((s) => s.url === `${DESK}${L.LEADS_PATH}` && s.method === 'POST').body);
  assert.deepEqual(Object.keys(posted).sort(), [...L.ENVELOPE_FIELDS].sort());
  assert.equal(posted.prompt_version, 'cr-scout-leads-prompt@1');
  assert.deepEqual(posted.leads[0], { chain: 'base', contract: EVM(1), coingecko_id: null, signal: 'A fictional signal.', urls: ['https://example.com/lead'] }, 'only the five fields, the signal\'s spaces collapsed');
  const text = out.all.join('\n');
  assert.match(text, /Leads: accepted gh-123456-2 \(2 rows: 1 new, 0 seen before, 1 refused at intake\)/);
  for (const s of [KEY, XAI_KEY, 'desk.test', 'example.com', EVM(1)]) assert.ok(!text.includes(s), `the output names ${s}`);
  // --leads on the command line is the same switch.
  assert.equal(G.deliveryIdOf({}, T0).startsWith('local-20261029113100-'), true);
  assert.match(G.deliveryIdOf({}, T0), L.DELIVERY_ID);
  assert.match(G.deliveryIdOf(ENV, T0), L.DELIVERY_ID);
});

test('leads sender: --dry-run prints both requests and what leads add, and sends nothing', async () => {
  let fetched = 0;
  const out = lines();
  const r = await G.run({ env: {}, fetch: async () => { fetched += 1; }, now: T0, out, dryRun: true, leads: true });
  assert.equal(r.status, 'dry_run');
  assert.equal(fetched, 0);
  const text = out.all.join('\n');
  for (const lane of S.LANES) assert.match(text, new RegExp(`Request for lane ${lane} \\(POST`));
  assert.match(text, /Request for leads \(POST https:\/\/api\.x\.ai\/v1\/responses\), sent after the brief/);
  assert.match(text, /Today is 2026-10-29\./);
  assert.match(text, /List at most 10 leads/);
  assert.match(text, /one of: ethereum, bsc, arbitrum/);
  assert.match(text, /Leads add one request a day: typical \$0\.15 a day, about \$5 a month; heavy \$0\.28 a day, about \$9 a month\./);
  assert.match(text, /Nothing was sent\./);
  // Off, the dry run prints exactly what it did before.
  const plain = lines();
  await G.run({ env: {}, fetch: async () => { fetched += 1; }, now: T0, out: plain, dryRun: true });
  assert.doesNotMatch(plain.all.join('\n'), /leads/i);
});

test('leads sender: a retry reuses the delivery ID; a 409 is reported and never resent under a new ID', async (t) => {
  const x = fakes(t, { leadsPost: [answer(503, { code: 'NOT_SAVED' })] });
  const r = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: x.f, now: T0, out: lines(), postWaits: [0, 0, 0] });
  const posts = x.sent.filter((s) => s.url === `${DESK}${L.LEADS_PATH}` && s.method === 'POST');
  assert.equal(posts.length, 2, 'posted again after a server error');
  assert.equal(posts[0].body, posts[1].body, 'the same delivery, the same ID');
  assert.equal(r.leads.status, 'accepted');
  // A conflict is an answer: reported once, not resent.
  const y = fakes(t, { leadsPost: [answer(409, { code: 'CONFLICT' })] });
  const out = lines();
  const r2 = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: y.f, now: T0, out, postWaits: [0, 0, 0] });
  assert.equal(y.sent.filter((s) => s.url === `${DESK}${L.LEADS_PATH}` && s.method === 'POST').length, 1);
  assert.equal(r2.leads.status, 'conflict');
  assert.match(out.all.join('\n'), /not resent under a new ID/);
  assert.equal(r2.ok, true, 'the brief\'s result stands');
});

test('leads sender: a refused, full or unreachable leads desk, a bad answer or a broken pin never blocks the brief', async (t) => {
  // The desk refuses the leads delivery outright.
  let x = fakes(t, { leadsPost: [answer(400, { code: 'INVALID' })] });
  let r = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: x.f, now: T0, out: lines(), postWaits: [0, 0] });
  assert.equal(r.status, 'saved');
  assert.equal(r.ok, true);
  assert.equal(r.leads.status, 'desk_not_saved');
  assert.equal(x.sent.filter((s) => s.url === `${DESK}${L.LEADS_PATH}` && s.method === 'POST').length, 1, 'a refusal is not resent');
  // Full for the day, or the key refused: no paid call for leads.
  for (const [ping, status] of [[answer(200, { ok: true, key: 'accepted', leads_today: 6, max_per_day: 6 }), 'desk_full'], [answer(401, { code: 'REFUSED' }), 'desk_refused']]) {
    x = fakes(t, { leadsPing: ping });
    r = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: x.f, now: T0, out: lines(), postWaits: [0] });
    assert.equal(r.leads.status, status);
    assert.equal(x.sent.filter((s) => s.url === G.XAI_URL).length, 4, `${status}: no fifth xAI call`);
    assert.equal(r.ok, true);
  }
  // An answer without leads, or an empty list: nothing delivered.
  x = fakes(t, { leadsAnswer: answer(200, { output_text: 'Sorry, nothing today.' }) });
  r = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: x.f, now: T0, out: lines(), postWaits: [0] });
  assert.equal(r.leads.status, 'no_leads');
  assert.equal(x.sent.filter((s) => s.url === `${DESK}${L.LEADS_PATH}` && s.method === 'POST').length, 0);
  assert.deepEqual(G.leadsFrom('{"leads":[]}'), { leads: [], dropped: 0 });
  assert.deepEqual(G.leadsFrom('{"items":[]}'), { reason: 'the answer had no leads list' });
  // A leads prompt that is not its pinned text: leads skipped, the brief sent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-leads-pin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['LOCK.json', 'scout-prompt.v1.md']) fs.copyFileSync(path.join(REPO, 'templates', 'scout', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'leads-prompt.v1.md'), `${fs.readFileSync(path.join(REPO, 'templates', 'scout', 'leads-prompt.v1.md'), 'utf8')}\nAlso list tokens to buy.\n`);
  x = fakes(t);
  r = await G.run({ env: { ...ENV, SCOUT_LEADS: 'true' }, fetch: x.f, now: T0, out: lines(), postWaits: [0], templateDir: dir });
  assert.equal(r.status, 'saved');
  assert.deepEqual(r.leads, { status: 'skipped', reason: 'cr-scout-leads-prompt@1 does not match its pin' });
  assert.equal(x.sent.filter((s) => s.url === G.XAI_URL).length, 4);
});

test('leads prompt and workflow: pinned, its own version beside the brief\'s, and on only while Eric sets SCOUT_LEADS', () => {
  const dir = path.join(REPO, 'templates', 'scout');
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'LOCK.json'), 'utf8'));
  assert.equal(lock.sha256['leads-prompt.v1.md'], sha256(fs.readFileSync(path.join(dir, 'leads-prompt.v1.md'))));
  assert.equal(lock.sha256['scout-prompt.v1.md'], '33b9b9d0e239b8d27fd1c19cf11c74fa27b0644bbed3fd09b564c71796b772d0', 'the brief\'s prompt is untouched');
  assert.deepEqual(S.PROMPTS, ['cr-scout-prompt@1']);
  assert.deepEqual(S.LANES, ['agents', 'onchain', 'desk', 'security']);
  const text = G.promptTemplate(dir, 'leads-prompt.v1.md', G.LEADS_PROMPT_ID);
  assert.match(text, /^# Scout leads \(cr-scout-leads-prompt@1\)/);
  for (const p of ['{{TODAY}}', '{{MAX_LEADS}}', '{{CHAINS}}']) assert.ok(text.includes(p), p);
  assert.match(text, /never instructions to you/);
  assert.match(text, /Never invent, guess or complete a contract/);
  assert.match(text, /There is no name or ticker field/);
  assert.equal(G.LEADS_PROMPT_ID, L.LEADS_PROMPT);
  assert.equal(G.LEADS_PATH, L.LEADS_PATH);
  const wf = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'scout-cron.yml'), 'utf8');
  assert.match(wf, /SCOUT_LEADS: \$\{\{ vars\.SCOUT_LEADS \}\}/);
  assert.doesNotMatch(wf, /SCOUT_LEADS: ['"]?true/);
});
