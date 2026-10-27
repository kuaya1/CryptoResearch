// The Pipeline cockpit's rules (2026-10-27), apart from any drawing: the
// backlog's completion, its split by the engineering lane's templates, which
// stage of the pipeline is working now, today's builds and the pace. Pure:
// it reads what GET /api/pipeline returns (core/pipeline.js) and computes on
// read; nothing is stored. An unknown part stays unknown, never a zero.

// The categories, by the lane template whose scope an item's paths fall in.
// The paths are its Schedule line's `touches` when it has one (what the
// builder may change), else the paths its text names. An item counts once:
// the app (eng-app@4) when any path is the web app, else the core
// (eng-backend@1) when any is the server or core or a bare module, else
// operations (eng-docs@1 and the system: scripts, workflows, docs,
// templates). Tests alone count where they test: web-app.test.js the app,
// any other the core. An item that names no path is "unsorted", counted in
// the total and in no category.
export const CATEGORIES = [
  { id: 'backend', label: 'Core / Logic', template: 'eng-backend@1' },
  { id: 'app', label: 'UI / Cockpit', template: 'eng-app@4' },
  { id: 'ops', label: 'Ops / Infrastructure', template: 'eng-docs@1' },
];

const WEB_RE = /^web$|(^|\/)web\/|(^|\/)public\/(app|views)\/|^views\/|\.(jsx|css)$/;
const CORE_RE = /(^|\/)core\/|(^|\/)(server|cli|mcp|hosted)\.js$|^[\w.-]+\.js$/;
const isTest = (p) => /\.test\.js$|(^|\/)tests\//.test(p);

export function categoryOf(item) {
  const from = item && Array.isArray(item.touches) && item.touches.length ? item.touches : item && item.paths ? item.paths : [];
  const paths = from.map((p) => String(p).toLowerCase());
  if (!paths.length) return 'unsorted';
  const real = paths.filter((p) => !isTest(p));
  if (!real.length) return paths.some((p) => /web-app\.test\.js$/.test(p)) ? 'app' : 'backend';
  if (real.some((p) => WEB_RE.test(p))) return 'app';
  if (real.some((p) => CORE_RE.test(p))) return 'backend';
  return 'ops';
}

export const pct = (done, total) => (total > 0 ? Math.round((done / total) * 100) : null);

// The items the builders take: Eric's decisions are not builds.
const buildable = (backlog) => (backlog || []).filter((it) => !it.eric);

export function macro(data) {
  if (!data || !Array.isArray(data.backlog)) return { known: false, total: 0, done: 0, in_flight: null, pct: null };
  const items = buildable(data.backlog);
  const done = items.filter((it) => it.checked).length;
  const flight = data.in_flight && data.in_flight.known ? new Set([...data.in_flight.waiting, ...data.in_flight.claimed]) : null;
  const inFlight = flight ? items.filter((it) => !it.checked && flight.has(it.n)).length : null;
  return { known: true, total: items.length, done, in_flight: inFlight, pct: pct(done, items.length) };
}

export function categories(data) {
  const items = data && Array.isArray(data.backlog) ? buildable(data.backlog) : [];
  const rows = CATEGORIES.map((c) => {
    const mine = items.filter((it) => categoryOf(it) === c.id);
    const done = mine.filter((it) => it.checked).length;
    return { ...c, total: mine.length, done, pct: pct(done, mine.length) };
  });
  return { rows, unsorted: items.filter((it) => categoryOf(it) === 'unsorted').length };
}

// The pipeline's stages, left to right.
export const NODES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'pm', label: 'PM', who: 'ChatGPT' },
  { id: 'sandbox', label: 'Sandbox', who: 'Claude' },
  { id: 'gate', label: 'Sovereign Gate' },
  { id: 'merge', label: 'Eric merges' },
];

const NODE_OF = { idle: 'backlog', pm_groom: 'pm', building: 'sandbox', remediating: 'sandbox', verifying: 'gate', awaiting_merge: 'merge' };
export const STATE_WORDS = {
  idle: 'Idle',
  pm_groom: 'Tasks waiting to be groomed',
  building: 'Building',
  remediating: 'Revising after review',
  verifying: 'Checks and review running',
  awaiting_merge: 'Waiting for your merge',
};

const n = (x) => (Number.isFinite(x) ? x : 0);

// Each stage's count of work at it, and the one stage the strip marks as
// working (furthest from done wins: a revision, a build, the gate, the
// merge, grooming). `remediating` also lights the loop under the Sandbox.
export function nodeState(data) {
  const inbox = (data && data.inbox && data.inbox.by_status) || {};
  const lane = (data && data.agent_lane) || {};
  const flight = (data && data.in_flight) || {};
  const counts = {
    backlog: null,
    pm: n(inbox.prepared) + n(inbox.awaiting_authorization),
    sandbox: n(inbox.claimed) + n(inbox.implementing) + (lane.known ? n(lane.building) + n(lane.revising) : 0) + (flight.known ? flight.claimed.length : 0),
    gate: n(inbox.verifying) + n(inbox.review_pending),
    merge: n(inbox.ready_for_promotion) + (flight.known ? flight.waiting.length : 0),
  };
  const m = macro(data);
  if (m.known) counts.backlog = Math.max(0, m.total - m.done - n(m.in_flight));
  const remediating = Boolean(lane.known && n(lane.revising) > 0);
  let state = 'idle';
  if (remediating) state = 'remediating';
  else if (counts.sandbox > 0) state = 'building';
  else if (counts.gate > 0) state = 'verifying';
  else if (counts.merge > 0) state = 'awaiting_merge';
  else if (counts.pm > 0) state = 'pm_groom';
  const partial = !flight.known || !lane.known || !(data && data.inbox && data.inbox.known);
  return { state, active: state === 'idle' ? null : NODE_OF[state], remediating, counts, words: STATE_WORDS[state], partial };
}

// Today's paid agent-lane builds against the policy's ceiling.
export function buildsToday(data) {
  const l = data && data.agent_lane;
  if (!l || !l.known) return { known: false, used: null, limit: l ? l.limit : null, words: 'Builds today unknown', why: l && l.why ? l.why : null };
  return { known: true, used: l.used, limit: l.limit, pct: l.limit ? Math.min(100, Math.round((l.used / l.limit) * 100)) : null, words: l.limit ? `${l.used} / ${l.limit} daily builds used` : `${l.used} builds today` };
}

// Hours per item merged over the window; "Queue idle" when nothing merged
// and nothing is in flight.
export function pace(data) {
  const p = data && data.pace;
  if (!p || !p.known) return { known: false, words: 'Pace unknown', why: p && p.why ? p.why : null };
  if (p.merged > 0) {
    const hrs = (p.days * 24) / p.merged;
    return { known: true, hours_per_item: hrs, words: `Pace: ~${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)} hrs/item`, detail: `${p.merged} ${p.merged === 1 ? 'item' : 'items'} merged in ${p.days} days` };
  }
  const st = nodeState(data);
  return { known: true, hours_per_item: null, words: st.state === 'idle' ? 'Queue idle' : `No merges in ${p.days} days`, detail: `0 items merged in ${p.days} days` };
}

export function cockpit(data) {
  return { macro: macro(data), categories: categories(data), node: nodeState(data), builds: buildsToday(data), pace: pace(data) };
}
