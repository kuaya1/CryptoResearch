'use strict';
// Desk controls (cr-desk-controls@1; blueprint 2026-11-02 row 2, §6.2).
//
// One read for Preferences > Desk controls. Five facts, kept apart, each
// from the record that already holds it:
//   poll        the server-observed production poll (pilot-sighting.js);
//   dispatch    each pilot project's claim and its outcome (pilot-claims.js),
//               with today's session ledger;
//   reports     each pilot project's latest eligible report per model: when
//               it was saved (meta.imported_at) and its analysis date;
//   freshness   what the trader's book waits on (trader-desk.js waits:
//               rules, funding, fee, prices, ATR);
//   authority   the pause, the paper mandate, automatic admission and each
//               project's stop (mandate-authority.js, lead-admission.js).
// No fact is derived from another: a STALE poll says the poll is overdue,
// never that no report exists or no session runs.
//
// The controls it lists only turn things off: pause, mandate off, admission
// off, project stop. Each names the existing route and body it uses (the
// settings write, POST /api/projects/<id>/autonomy) and how its effect reads
// back here (`done`). Turning anything on stays where it was.
//
// Reconcile is listed per project only for a claim that expired unreleased,
// through the existing signed-in release route with {"reconciled":true}; it
// is Eric's explicit act after he checked the desk, never a retry.
//
// A pilot research job released to manual (research_release per project,
// released_pilot_jobs desk-wide) is said beside the dispatch.
//
// Reads only. A part that does not read says so and the rest stands.

const FORMAT = 'cr-desk-controls@1';
const STALE_NOTE = 'STALE means the production poll is overdue. It is not proof that no grade exists or that no session is running.';

const iso = (ms) => new Date(ms).toISOString();
const errWords = (err) => String((err && err.message) || err).slice(0, 200);
// { ok, value } or { ok: false, words }: one unreadable part never hides the others.
function part(fn, what) {
  try { return { ok: true, value: fn() }; } catch (err) { return { ok: false, words: `${what} could not be read (${errWords(err)}).` }; }
}

function claimOf(rec, peeked, now) {
  if (!rec) return { state: 'none', reconcile: false, words: 'No pilot claim on record.' };
  const base = { attempt_id: rec.attempt_id || null, role: rec.role || null, owner: rec.owner || null, claim_state: rec.state || null, expires_at: rec.expires_at || null, released_at: rec.released_at || null, outcome: rec.outcome || null, run_id: rec.run_id || null, ticket_id: rec.ticket_id || null };
  if (rec.released) return { ...base, state: 'released', reconcile: false, words: `Attempt ${base.attempt_id} was released at ${base.released_at || 'an unrecorded time'}: ${base.outcome || 'no outcome recorded'}.` };
  const exp = Date.parse(rec.expires_at);
  if (Number.isFinite(exp) && exp > now) return { ...base, state: 'claimed', reconcile: false, words: `Claimed by ${base.owner || 'a runner'} until ${base.expires_at}; a runner may be working.` };
  if (peeked === 'reconcile') return { ...base, state: 'reconcile', reconcile: true, words: `Attempt ${base.attempt_id}'s session outcome is not settled. Check the desk for its report or ticket, then release it as reconciled. Nothing retries it by itself.` };
  return { ...base, state: 'expired', reconcile: true, words: `Attempt ${base.attempt_id} expired${base.expires_at ? ` at ${base.expires_at}` : ''} in state ${base.claim_state || 'unknown'} without a release. Check the desk, then release it as reconciled.` };
}

function reportsOf(ws, pid) {
  const C = require('./compare');
  const latest = C.latestByProvider(require('./reports').loadReports(ws, pid));
  const out = {};
  for (const [model, r] of Object.entries(latest)) {
    out[model] = r ? { report_id: r.report_id || null, imported_at: (r.meta && r.meta.imported_at) || null, analysis_at: (r.assessment && r.assessment.analysis_at) || null } : null;
  }
  return out;
}

// The pilot's research job released to manual (blueprint 2026-11-03 §4 PR 2,
// audit S5/E3): the newest Claude job whose last release was from the pilot
// worker's assistant mode (`cowork`) and which has not completed since. Read
// from the job's own released[] record; null when there is none.
function releaseOf(ws, pid) {
  for (const run of require('./research').listRuns(ws, pid)) {
    const j = !run.broken && run.jobs ? run.jobs.claude : null;
    const last = j && Array.isArray(j.released) && j.released.length ? j.released[j.released.length - 1] : null;
    if (!last) continue;
    if (last.from_mode !== 'cowork' || j.state === 'completed') return null;
    return { at: last.at || null, idle_hours: Number.isFinite(last.idle_hours) ? last.idle_hours : null, run_id: run.run_id, words: `Claude's research job on ${pid} was released from the pilot worker to manual at ${last.at || 'an unrecorded time'} after ${Number.isFinite(last.idle_hours) ? last.idle_hours : '?'} h with no runner activity.` };
  }
  return null;
}

function view(ws, { now = Date.now() } = {}) {
  const T = require('./tickets');
  const PC = require('./pilot-claims');
  const MA = require('./mandate-authority');
  const LA = require('./lead-admission');
  const at = iso(now);

  // 1. The production poll.
  const pollPart = part(() => require('./pilot-sighting').view(ws, { now }), 'The production poll\'s record');
  const poll = pollPart.ok ? { ...pollPart.value, note: STALE_NOTE } : { state: 'unknown', words: pollPart.words, note: STALE_NOTE };

  // Authority, read once for the whole desk.
  const automation = (ws.settings && ws.settings.automation) || {};
  const paused = automation.paused === true;
  const mPart = part(() => T.mandateOf(ws, now), 'The paper mandate\'s settings');
  const loopOn = automation.autonomous_paper_loop === true;
  const mandate = mPart.ok
    ? { on: Boolean(mPart.value.on), loop_on: loopOn, generation: mPart.value.generation, expires_at: mPart.value.expires_at, revoked_at: mPart.value.revoked_at || null, why: mPart.value.on ? null : mPart.value.why || null }
    : { on: null, loop_on: loopOn, words: mPart.words };
  const aPart = part(() => LA.authorityOf(ws, now), 'Automatic admission\'s settings');
  const admission = aPart.ok
    ? { on: Boolean(aPart.value.on), enabled: aPart.value.values.enabled, daily_limit: aPart.value.values.daily_limit, expires_at: aPart.value.values.expires_at, generation: aPart.value.generation, code: aPart.value.code, why: aPart.value.why }
    : { on: null, enabled: null, words: aPart.words };

  // 2-3. The pilot's projects: dispatch, report dates and each project's stop.
  const stepsPart = part(() => T.pilotQueue(ws, { now }), 'The pilot\'s projects');
  const names = new Map();
  try { for (const p of require('./projects').listProjects(ws)) names.set(p.project_id, p.name || p.project_id); } catch (_) { /* names are a courtesy */ }
  const projects = stepsPart.ok ? stepsPart.value.map((s) => {
    const pid = s.project_id;
    const c = part(() => claimOf(PC.read(ws, pid), PC.peek(ws, pid, s, now), now), 'The pilot claim');
    const rp = part(() => reportsOf(ws, pid), 'The project\'s reports');
    // The project's stop, read through the one shared gate (cr-automation-gate@1).
    const au = MA.automationGate(ws, pid).autonomy;
    const claim = c.ok ? c.value : { state: 'unreadable', reconcile: false, words: c.words };
    const rel = part(() => releaseOf(ws, pid), 'The project\'s research job');
    return {
      project_id: pid,
      name: names.get(pid) || pid,
      next_step: s.step,
      dispatch: claim,
      research_release: rel.ok ? rel.value : { unreadable: true, words: rel.words },
      reports: rp.ok ? rp.value : { unreadable: true, words: rp.words },
      stop: { stopped: au.suspended === true, unreadable: au.unreadable === true, words: au.words || null },
      controls: {
        stop: { available: au.suspended !== true, method: 'POST', path: `/api/projects/${pid}/autonomy`, body: { action: 'stop' }, done: au.suspended === true },
        reconcile: { available: claim.reconcile === true, method: 'POST', path: `/api/projects/${pid}/pilot-claim/release`, body: { reconciled: true, attempt_id: claim.attempt_id || null }, attempt_id: claim.attempt_id || null },
      },
    };
  }) : [];
  const sessions = PC.sessionsView(ws, now);

  // 4. Data freshness: what the trader's book waits on, in its own words.
  const fPart = part(() => {
    const rq = require('./trader-desk').requests(ws, { now: at });
    return {
      book_waits: rq.waits || [],
      waiting: rq.requests.filter((r) => r.phase === 'waiting').map((r) => ({ project_id: r.project_id, decision_id: r.decision_id, pair: r.pair || null, words: r.words })),
    };
  }, 'The trader\'s book');
  const freshness = fPart.ok ? fPart.value : { unreadable: true, words: fPart.words };

  // Desk-wide controls, off only.
  const controls = {
    pause: { available: !paused, label: 'Pause automation', method: 'POST', path: '/api/settings', body: { automation: { paused: true } }, done: paused },
    mandate_off: { available: loopOn, label: 'Turn the paper mandate off', method: 'POST', path: '/api/settings', body: { automation: { autonomous_paper_loop: false } }, done: !loopOn },
    admission_off: { available: admission.enabled === true, label: 'Turn automatic admission off', method: 'POST', path: '/api/settings', body: { automation: { lead_admission: { enabled: false } } }, done: admission.enabled === false },
  };

  return {
    format: FORMAT,
    at,
    writes_nothing: true,
    poll,
    dispatch: { sessions, projects_unreadable: stepsPart.ok ? null : stepsPart.words, released_pilot_jobs: stepsPart.ok ? projects.filter((p) => p.research_release && !p.research_release.unreadable).length : null },
    freshness,
    authority: { paused, mandate, admission },
    controls,
    projects,
  };
}

module.exports = { FORMAT, STALE_NOTE, claimOf, releaseOf, view };
