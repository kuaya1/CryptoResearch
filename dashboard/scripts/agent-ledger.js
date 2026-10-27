'use strict';
// The paid-attempt ledger of the agent lane (Eric, 2026-10-26;
// audits/2026-10-26-engineering-simplification). Every paid request (a model
// review, a Claude build) is reserved here before it is sent, so a rerun, two
// triggers at once, a cancelled job or a lost runner never sends one the
// ledger does not count.
//
// One file, ledger.jsonl, on the branch agent-ledger, appended by
// compare-and-swap: a commit on the tip read, pushed without force. The
// agent-ledger ruleset refuses a force push or a deletion for everyone, so a
// push either extends the tip that was read or is refused and the decision is
// made again on the new tip. Each line carries its sequence number and the
// SHA-256 of the line before it; a gap or an edited line makes the ledger
// unreadable and every paid request is refused until Eric looks.
//
// Lines (FICTIONAL example):
//   {"seq":1,"prev":"000…","t":"reserve","id":"rv-…","kind":"review","binding":"…","day":"2026-10-26","tokens":42000,"run":"123/1","at":"…"}
//   {"seq":2,"prev":"…","t":"outcome","id":"rv-…","state":"unknown","error":"timeout","at":"…"}
//   {"seq":3,"prev":"…","t":"outcome","id":"rv-…","state":"response","response_id":"chatcmpl-…","verdict":{…},"mac":"…","via":"reconcile","at":"…"}
//   {"seq":4,"prev":"…","t":"posted","id":"rv-…","conclusion":"success","at":"…"}
//   {"seq":5,"prev":"…","t":"publishing","id":"bd-…","commit":"…","branch":"agent/issue-7","predecessor":"absent","at":"…"}
//
// A build's "publishing" line goes up in the same atomic push as its branch
// (agent-guard.js publish): the ledger and the candidate move together or not
// at all, so no reserve can record a build lost while it publishes.
//
// An attempt whose outcome is not recorded, or recorded as unknown, may have
// been sent and paid for; it is reconciled with the provider before anything
// is sent again. The provider's own spending limits stay the second layer.

const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REF = 'refs/heads/agent-ledger';
const FILE = 'ledger.jsonl';
const ZERO = '0'.repeat(64);
const IDENTITY = { GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
// States after which an attempt is settled: it was paid for or definitely
// not, and nothing about it is left to find out.
const FINAL = new Set(['response', 'failed', 'lost']);
// A build reserved with no outcome is alive while GitHub says its run is
// (pipeline review, 2026-10-27): a completed run frees its issue at once, a
// running one holds it up to GitHub's six-hour limit for a hosted job. Only
// when the run's status cannot be read does age decide: the build's timeout
// and this grace (65 minutes at a 45-minute timeout).
const BUILD_GRACE_MINUTES = 20;
const HARD_MAX_MINUTES = 360;
// "123/1" (GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT) as numbers, or null.
function runIdOf(run) {
  const m = /^(\d{1,20})\/(\d{1,6})$/.exec(String(run || ''));
  return m ? { id: Number(m[1]), attempt: Number(m[2]) } : null;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const bindingOf = (fields) => sha256(canonical(fields));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const ID_PREFIX = { build: 'bd', revise: 'rs' };
const newId = (kind) => `${ID_PREFIX[kind] || 'rv'}-${crypto.randomBytes(8).toString('hex')}`;

// A verdict kept in the ledger is reused only with its MAC, made with a key
// derived from the provider's API key: a line written by anyone without it
// is never taken as a review.
const macKey = (secret) => (secret ? crypto.createHmac('sha256', 'cr-agent-ledger@1').update(String(secret)).digest() : null);
// The ledger's own key (Engineering v3, change 4): AGENT_LEDGER_KEY, a
// repository secret of at least 32 characters, held only by the jobs that
// record or read verdicts. It used to be derived from the OpenAI key, so the
// holder of that key could sign a verdict, and rotating it orphaned every
// verdict held. Missing or short: null, and nothing is posted from the ledger.
const LEDGER_KEY_MIN = 32;
const ledgerKey = (env = process.env) => {
  const s = String((env && env.AGENT_LEDGER_KEY) || '');
  return s.length >= LEDGER_KEY_MIN ? macKey(s) : null;
};
const macOf = (key, r) => crypto.createHmac('sha256', key).update(canonical({ binding: r.binding, id: r.id, verdict: r.verdict, response_id: r.response_id || null })).digest('hex');
function macOk(key, r) {
  if (!key || typeof r.mac !== 'string' || !/^[0-9a-f]{64}$/.test(r.mac)) return false;
  return crypto.timingSafeEqual(Buffer.from(r.mac, 'hex'), Buffer.from(macOf(key, r), 'hex'));
}

function git(cwd, args, { input, env = {} } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0', ...env } });
  if (r.error) throw r.error;
  return { status: r.status, out: String(r.stdout || '').trim(), raw: String(r.stdout || ''), err: String(r.stderr || '').trim() };
}

// The chain: line n has seq n and the SHA-256 of line n-1 (zeros for the
// first). Returns the entries, or where the chain breaks.
function parse(text) {
  const lines = String(text || '').split('\n').filter((l) => l.length);
  const entries = [];
  let prev = ZERO;
  for (let i = 0; i < lines.length; i += 1) {
    let e = null;
    try { e = JSON.parse(lines[i]); } catch (_) { return { broken: `line ${i + 1} is not JSON` }; }
    if (!e || e.seq !== i + 1 || e.prev !== prev) return { broken: `line ${i + 1} does not follow line ${i} (sequence or hash)` };
    entries.push(e);
    prev = sha256(lines[i]);
  }
  return { entries, last: prev };
}

// The ledger as the remote holds it now.
function read(cwd, { remote = 'origin' } = {}) {
  const local = `refs/remotes/${remote}/agent-ledger`;
  const ls = git(cwd, ['ls-remote', remote, REF]);
  if (ls.status !== 0) return { error: `the ledger could not be read: ${ls.err.slice(0, 160) || 'remote unreachable'}` };
  if (!ls.out) return { tip: null, text: '', entries: [], last: ZERO };
  const f = git(cwd, ['fetch', '-q', '--no-tags', remote, `+${REF}:${local}`]);
  if (f.status !== 0) return { error: `the ledger could not be fetched: ${f.err.slice(0, 160)}` };
  const tip = git(cwd, ['rev-parse', '--verify', '-q', `${local}^{commit}`]).out;
  const show = git(cwd, ['show', `${tip}:${FILE}`]);
  if (show.status !== 0) return { error: `the ledger branch has no ${FILE}` };
  const p = parse(show.raw);
  if (p.broken) return { error: `the ledger is broken: ${p.broken}; nothing paid is sent until Eric looks` };
  return { tip, text: show.raw, entries: p.entries, last: p.last };
}

// One commit on `tip` adding `recs`, not pushed: append pushes it alone, and
// publish pushes it atomically with a candidate branch.
function stage(cwd, { tip, text, entries, last, recs, message = 'ledger' }) {
  let body = text;
  let prev = last;
  let seq = entries.length;
  const added = [];
  for (const rec of recs) {
    seq += 1;
    const lineText = JSON.stringify({ seq, prev, ...rec });
    body += `${lineText}\n`;
    prev = sha256(lineText);
    added.push({ seq, ...rec });
  }
  const blob = git(cwd, ['hash-object', '-w', '--stdin'], { input: body }).out;
  const tree = git(cwd, ['mktree'], { input: `100644 blob ${blob}\t${FILE}\n` }).out;
  const commit = git(cwd, ['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', message]).out;
  return { commit, added };
}

// One commit on `tip` adding `recs`, pushed without force. False when the
// remote moved (or refused); the caller reads again and decides again.
function append(cwd, { remote = 'origin', tip, text, entries, last, recs, message = 'ledger', beforePush = null }) {
  const { commit, added } = stage(cwd, { tip, text, entries, last, recs, message });
  if (beforePush) beforePush();
  const p = git(cwd, ['push', '-q', '--porcelain', remote, `${commit}:${REF}`]);
  if (p.status !== 0) return { ok: false, error: p.err.slice(0, 200) };
  return { ok: true, commit, added };
}

// Read, decide, append; again on a moved tip. `decide(entries)` returns
// { append: [records], ... } or a result with nothing to write.
function transact(cwd, { remote = 'origin', decide, tries = 6, message, beforePush = null }) {
  for (let i = 0; i < tries; i += 1) {
    const l = read(cwd, { remote });
    if (l.error) return { error: l.error };
    const d = decide(l.entries) || {};
    if (!d.append || !d.append.length) return { ...d, entries: l.entries };
    const a = append(cwd, { remote, ...l, recs: d.append, message: message || d.message || 'ledger', beforePush: i === 0 ? beforePush : null });
    if (a.ok) return { ...d, committed: true, commit: a.commit };
  }
  return { error: 'the ledger kept moving; nothing was reserved or sent' };
}

// Each reservation with what is known of it since.
function attempts(entries) {
  const by = new Map();
  for (const e of entries) {
    if (e.t === 'reserve') by.set(e.id, { id: e.id, reserve: e, outcomes: [], posted: [], publishing: [] });
    else if (by.has(e.id)) (e.t === 'posted' ? by.get(e.id).posted : e.t === 'publishing' ? by.get(e.id).publishing : by.get(e.id).outcomes).push(e);
  }
  for (const a of by.values()) {
    const last = a.outcomes[a.outcomes.length - 1] || null;
    a.state = last ? last.state : 'pending';
    a.final = FINAL.has(a.state);
    a.response = a.outcomes.find((o) => o.state === 'response') || null;
  }
  return [...by.values()];
}

function usage(entries, { kind, day }) {
  const rs = entries.filter((e) => e.t === 'reserve' && e.kind === kind && e.day === day);
  return { count: rs.length, tokens: rs.reduce((s, e) => s + (Number(e.tokens) || 0), 0), usd: rs.reduce((s, e) => s + (Number(e.usd) || 0), 0) };
}

// What a review run does for one binding (task version, head, merge base,
// diff and review configuration), from the ledger alone.
//   post       a verdict for this binding is held (MAC checked): post it, send nothing
//   reconcile  an attempt may have been sent and its outcome is not known:
//              ask the provider for it before anything is sent again
//   refuse     a ceiling is reached (or a held verdict fails its check)
//   send       reserve (the append) and send one request
function decideReview(entries, { binding, bind, ceilings, now, key, tokens, run }) {
  const atts = attempts(entries).filter((a) => a.reserve.kind === 'review' && a.reserve.binding === binding);
  for (const a of [...atts].reverse()) {
    if (!a.response || !a.response.verdict) continue;
    if (!macOk(key, { ...a.response, binding })) return { action: 'refuse', why: `the verdict the ledger holds for attempt ${a.id} fails its check; no review is posted or sent until Eric looks` };
    return { action: 'post', attempt: a, verdict: a.response.verdict, model: a.response.model || null, reused: true };
  }
  const open = atts.find((a) => !a.final);
  if (open) return { action: 'reconcile', attempt: open };
  if (atts.length >= ceilings.review_attempts_per_binding) return { action: 'refuse', why: `${atts.length} paid ${atts.length === 1 ? 'attempt' : 'attempts'} for this exact head, diff and task already (ceiling ${ceilings.review_attempts_per_binding}); a new head or Eric's own review` };
  const day = dayOf(now);
  const u = usage(entries, { kind: 'review', day });
  if (u.count >= ceilings.reviews_per_day) return { action: 'refuse', why: `${u.count} paid review attempts today (UTC ${day}; ceiling ${ceilings.reviews_per_day})` };
  if (u.tokens + tokens > ceilings.review_tokens_per_day) return { action: 'refuse', why: `this review would reserve ${tokens} tokens on top of ${u.tokens} today (UTC ${day}; ceiling ${ceilings.review_tokens_per_day})` };
  const id = newId('review');
  return { action: 'send', id, append: [{ t: 'reserve', kind: 'review', id, binding, bind, day, tokens, run, at: new Date(now).toISOString() }] };
}

// What a build or revision run may do for one task version, from the ledger
// alone. A run (id and attempt) reserves once; a rerun of a job inside it
// reserves nothing and builds nothing. Attempts of one version (issue and
// task hash) count together whichever commit of main they started from
// (Engineering v3: a moved main used to start the count again).
const sameVersion = (r, { binding, bind }) => r.binding === binding || Boolean(bind && bind.task_sha256 && r.bind && r.bind.issue === bind.issue && r.bind.task_sha256 === bind.task_sha256);
// The two paid kinds that run Claude (Engineering v3, change 5: a revision is
// a build from the candidate's head with Eric's authenticated feedback). Each
// has its own ceiling per task version; they share the issue, the daily
// count and the daily dollars.
const PAID = {
  build: { ceiling: 'builds_per_task_version', one: 'build', many: 'builds', instead: 'edit the task or build it yourself' },
  revise: { ceiling: 'revisions_per_task_version', one: 'revision', many: 'revisions', instead: 'edit the task and label it again, or revise it yourself' },
};
//
// One paid attempt per issue at a time (Engineering v3, change 3), a build or
// a revision. An attempt with no outcome is settled from its run first
// (pipeline review, 2026-10-27; `runs`: reserve.run -> the run attempt as
// GitHub reports it, read by the caller so this stays pure):
//   - the run completed: closed now, in the same append as the new
//     reservation. Its outcome is "lost" (its reservation still counts),
//     or, when its "publishing" line is in the ledger, "response": that
//     push carried its branch, so it published whatever its record job did.
//   - any other status (queued, waiting, in progress): it holds the issue, up to
//     GitHub's six-hour limit for a hosted job (`hardMaxMs`).
//   - GitHub gave no status: the age fallback, `holdMs` from the reservation.
// An attempt whose outcome was recorded, even "unknown", has finished running.
function settleOpen(a, { now, holdMs, hardMaxMs, runs }) {
  const st = runs && runs.get(a.reserve.run);
  const at = new Date(now).toISOString();
  const pub = a.publishing[a.publishing.length - 1] || null;
  const close = (why, via) => (pub
    ? { t: 'outcome', id: a.id, state: 'response', job: 'unrecorded', publish: 'published', commit: pub.commit, via, note: why, at }
    : { t: 'outcome', id: a.id, state: 'lost', via, error: why, at });
  const mins = (ms) => Math.round(ms / 60000);
  const age = now - Date.parse((st && (st.run_started_at || st.created_at)) || a.reserve.at);
  if (st && st.status === 'completed') return { close: close(`its run ${a.reserve.run} completed (${st.conclusion || 'no conclusion'}) with no outcome recorded`, 'run-status') };
  if (st) {
    if (!(age >= hardMaxMs)) return { hold: `its run is ${st.status}${Number.isFinite(age) ? ` (${mins(age)} min)` : ''}` };
    return { close: close(`its run ${a.reserve.run} was still ${st.status} ${mins(age)} min after it started, past GitHub's ${mins(hardMaxMs)}-minute limit for a hosted job`, 'run-status') };
  }
  if (!(age >= holdMs)) return { hold: `its run's status could not be read${Number.isFinite(age) ? ` and it is ${mins(age)} min old` : ''}, so it is held up to ${mins(holdMs)} min` };
  return { close: close(`no outcome ${mins(age)} min after it was reserved, and its run's status could not be read`, 'age') };
}

// The runs of the paid attempts that hold `issue`, read from GitHub now:
// reserve.run -> { status, conclusion, created_at, run_started_at }. A run
// that cannot be read is left out, so its attempt falls back to its age.
async function runStatuses(entries, { issue, readRun }) {
  const out = new Map();
  for (const a of attempts(entries)) {
    if (!PAID[a.reserve.kind] || !a.reserve.bind || a.reserve.bind.issue !== issue || a.outcomes.length) continue;
    const r = runIdOf(a.reserve.run);
    if (!r) continue;
    let st = null;
    try { st = await readRun(r.id, r.attempt); } catch (_) { st = null; }
    if (st && typeof st.status === 'string') out.set(a.reserve.run, { status: st.status, conclusion: st.conclusion || null, created_at: st.created_at || null, run_started_at: st.run_started_at || null });
  }
  return out;
}

function decidePaid(kind, entries, { binding, bind, ceilings, now, usd, run, holdMs = 65 * 60000, hardMaxMs = HARD_MAX_MINUTES * 60000, runs = null }) {
  const k = PAID[kind];
  if (!k) return { action: 'refuse', why: `${String(kind)} is not a paid kind the ledger reserves` };
  const paid = attempts(entries).filter((a) => PAID[a.reserve.kind]);
  const mine = paid.find((a) => a.reserve.run === run);
  if (mine) return { action: 'refuse', why: `run ${run} already holds ${mine.reserve.kind} reservation ${mine.id}`, attempt: mine };
  const closed = [];
  if (bind && Number.isInteger(bind.issue)) {
    for (const a of paid) {
      if (!a.reserve.bind || a.reserve.bind.issue !== bind.issue || a.outcomes.length) continue;
      const s = settleOpen(a, { now, holdMs, hardMaxMs, runs });
      if (s.hold) return { action: 'refuse', why: `${PAID[a.reserve.kind].one} ${a.id} of issue #${bind.issue} (run ${a.reserve.run}) has no outcome yet: ${s.hold}; one build or revision per issue at a time`, attempt: a };
      closed.push(s.close);
    }
  }
  const lost = closed.filter((o) => o.state === 'lost');
  // A ceiling the policy does not set refuses: nothing is reserved on a default.
  const ceiling = ceilings && ceilings[k.ceiling];
  if (!Number.isInteger(ceiling) || ceiling < 0) return { action: 'refuse', why: `the policy sets no ${k.ceiling}; no ${k.one} is reserved` };
  const atts = paid.filter((a) => a.reserve.kind === kind && sameVersion(a.reserve, { binding, bind }));
  if (atts.length >= ceiling) return { action: 'refuse', why: `${atts.length} paid ${atts.length === 1 ? k.one : k.many} for this version of the task already (ceiling ${ceiling}); ${k.instead}` };
  const day = dayOf(now);
  const u = Object.keys(PAID).map((x) => usage(entries, { kind: x, day })).reduce((s, x) => ({ count: s.count + x.count, usd: s.usd + x.usd }), { count: 0, usd: 0 });
  if (u.count >= ceilings.builds_per_day) return { action: 'refuse', why: `${u.count} paid builds today, revisions included (UTC ${day}; ceiling ${ceilings.builds_per_day})` };
  if (u.usd + usd > ceilings.build_usd_per_day) return { action: 'refuse', why: `this ${k.one} would reserve $${usd} on top of $${u.usd} today, builds and revisions (UTC ${day}; ceiling $${ceilings.build_usd_per_day})` };
  const id = newId(kind);
  return { action: kind, id, lost: lost.map((x) => x.id), published: closed.filter((o) => o.state === 'response').map((x) => x.id), closed, append: [...closed, { t: 'reserve', kind, id, binding, bind, day, usd, run, at: new Date(now).toISOString() }] };
}
const decideBuild = (entries, o) => decidePaid('build', entries, o);
const decideRevise = (entries, o) => decidePaid('revise', entries, o);

module.exports = { REF, FILE, ZERO, FINAL, BUILD_GRACE_MINUTES, HARD_MAX_MINUTES, runIdOf, sha256, canonical, bindingOf, dayOf, macKey, LEDGER_KEY_MIN, ledgerKey, macOf, macOk, parse, read, stage, append, transact, attempts, usage, decideReview, PAID, settleOpen, runStatuses, decidePaid, decideBuild, decideRevise };
