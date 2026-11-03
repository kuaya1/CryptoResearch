'use strict';
// The last server-observed production poll (cr-pilot-sighting@1; blueprint
// 2026-11-02 §6.2, row 6). The unattended runner polls through the worker
// route `poll` (POST, worker bearer; pilot-worker.js). Only after the desk
// has computed the queue snapshot it answers with is one bounded record
// written: { last_polled_at, runner_id, invocation_id, max_agents }, the
// time from the desk's own clock. A time in the request is never read, so
// a forged clock cannot freshen the record, and a snapshot that failed
// writes nothing. GET /api/pilot/queue stays read-only and never writes it.
//
// STALE means the production poll is overdue. It is not proof that no grade
// exists or that no session is running. The threshold is 120 min at hourly
// cron and --max-agents=1 (Q2, ratified 2026-11-03). The desk enforces it:
// the threshold is max(120, agents × 95 + 15) with agents bounded by the
// desk's own cap (DESK_MAX_AGENTS, 1), so a runner that declares more (up to
// 10, 965 min) can no longer stretch STALE to hide an outage (audit E4/S1,
// blueprint 2026-11-03 §4 PR 1). Raising the cap is a code change Eric
// merges, never a value a runner sends. A record that does not
// read, does not hold its shape, or stands ahead of the desk's clock by any
// amount is unknown, never fresh and never "never polled" (audit F9,
// 2026-11-02: a record a minute ahead used to read fresh).
//
// One file under .cr/ (runner state, not a research record), replaced
// atomically inside the workspace lock; it never moves backward: a poll at
// a desk clock behind the record keeps the record as it is, however far
// ahead it stands, and the view says unknown until the clock passes it.

const path = require('path');
const { withLock } = require('./ops');
const { readJson, atomicWrite, mkdirp } = require('./fsx');

const FORMAT = 'cr-pilot-sighting@1';
const REL = '.cr/pilot-sighting.json';
const STALE_MIN = 120;
const PER_AGENT_MIN = 95;
const MARGIN_MIN = 15;
const MAX_AGENTS = 10;
// The desk's cap on the agents a runner may count toward STALE (Q2).
const DESK_MAX_AGENTS = 1;
const RUNNER_RE = /^[A-Za-z0-9 ._:@-]{1,80}$/;
const INVOCATION_RE = /^[A-Za-z0-9-]{8,64}$/;

const staleAfterMin = (maxAgents) => Math.max(STALE_MIN, Math.min(Number.isInteger(maxAgents) ? maxAgents : 1, DESK_MAX_AGENTS) * PER_AGENT_MIN + MARGIN_MIN);
const capWords = (declared) => (Number.isInteger(declared) && declared > DESK_MAX_AGENTS ? ` The runner declared ${declared} agents, above the desk's cap of ${DESK_MAX_AGENTS}; STALE stays at ${staleAfterMin(declared)} min.` : '');

// The request's fields, checked; anything else in it is ignored.
function fieldsOf(body) {
  const b = body && typeof body === 'object' ? body : {};
  const runner_id = typeof b.runner_id === 'string' && RUNNER_RE.test(b.runner_id) ? b.runner_id : null;
  const invocation_id = typeof b.invocation_id === 'string' && INVOCATION_RE.test(b.invocation_id) ? b.invocation_id : null;
  const max_agents = Number.isInteger(b.max_agents) && b.max_agents >= 0 && b.max_agents <= MAX_AGENTS ? b.max_agents : null;
  return { runner_id, invocation_id, max_agents };
}

// A stored record that holds its shape, else null.
function wellFormed(rec) {
  if (!rec || typeof rec !== 'object' || rec.format !== FORMAT) return null;
  const at = Date.parse(rec.last_polled_at);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== rec.last_polled_at) return null;
  if (typeof rec.runner_id !== 'string' || !RUNNER_RE.test(rec.runner_id)) return null;
  if (typeof rec.invocation_id !== 'string' || !INVOCATION_RE.test(rec.invocation_id)) return null;
  if (!Number.isInteger(rec.max_agents) || rec.max_agents < 0 || rec.max_agents > MAX_AGENTS) return null;
  return { rec, at };
}

function readRecord(ws) {
  try { return { rec: readJson(ws.abs(REL), null) }; } catch (err) { return { error: err.code || 'unreadable' }; }
}

// Called by the worker route after the snapshot is computed, with the
// route's own clock. The record never moves backward: one ahead of the
// clock is kept as it is; one that does not read is replaced by this real
// sighting.
function record(ws, body, { now = Date.now() } = {}) {
  const f = fieldsOf(body);
  if (!f.runner_id || !f.invocation_id || f.max_agents === null) return null;
  return withLock(ws, 'pilot sighting', () => {
    const cur = readRecord(ws);
    const ok = cur.rec ? wellFormed(cur.rec) : null;
    if (ok && ok.at > now) return ok.rec;
    const rec = { format: FORMAT, last_polled_at: new Date(now).toISOString(), runner_id: f.runner_id, invocation_id: f.invocation_id, max_agents: f.max_agents };
    const abs = ws.abs(REL);
    mkdirp(path.dirname(abs));
    atomicWrite(abs, `${JSON.stringify(rec, null, 2)}\n`);
    return rec;
  });
}

const aheadWords = (ms) => (ms < 60000 ? `${Math.ceil(ms / 1000)} s` : `${Math.floor(ms / 60000)} min`);

// What the desk can say about the production poll, read only.
function view(ws, { now = Date.now() } = {}) {
  const base = { format: FORMAT, writes_nothing: true, last_polled_at: null, runner_id: null, invocation_id: null, max_agents: null, desk_max_agents: DESK_MAX_AGENTS, age_min: null, stale_after_min: null };
  const cur = readRecord(ws);
  if (cur.error) return { ...base, state: 'unknown', words: `The production poll's record does not read (${cur.error}); whether the runner is polling is unknown.` };
  if (!cur.rec) return { ...base, state: 'never', words: 'No production poll has reached this desk.' };
  const ok = wellFormed(cur.rec);
  if (!ok) return { ...base, state: 'unknown', words: 'The production poll\'s record does not hold its shape; whether the runner is polling is unknown.' };
  const facts = { last_polled_at: ok.rec.last_polled_at, runner_id: ok.rec.runner_id, invocation_id: ok.rec.invocation_id, max_agents: ok.rec.max_agents, stale_after_min: staleAfterMin(ok.rec.max_agents) };
  if (ok.at > now) return { ...base, ...facts, state: 'unknown', ahead_ms: ok.at - now, words: `The production poll's record (${ok.rec.last_polled_at}) is ahead of the desk's clock by ${aheadWords(ok.at - now)}; whether the runner is polling is unknown. A later poll does not move it back.` };
  const age = Math.floor((now - ok.at) / 60000);
  if (age > facts.stale_after_min) return { ...base, ...facts, age_min: age, state: 'stale', words: `STALE: the production poll is overdue. Last seen ${ok.rec.last_polled_at} (${age} min ago; stale after ${facts.stale_after_min} min). This is not proof that no grade exists or that no session is running.${capWords(ok.rec.max_agents)}` };
  return { ...base, ...facts, age_min: age, state: 'fresh', words: `The production poll last reached the desk ${age} min ago (${ok.rec.last_polled_at}).${capWords(ok.rec.max_agents)}` };
}

module.exports = { FORMAT, REL, STALE_MIN, PER_AGENT_MIN, MARGIN_MIN, DESK_MAX_AGENTS, staleAfterMin, fieldsOf, record, view };
