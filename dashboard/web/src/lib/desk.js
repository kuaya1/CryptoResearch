// The desk client: the session, the API, the index and project records, saved
// view preferences, and live updates. React reads it through useDesk(); the
// views the app still hosts get the same through legacyCtx() (legacy.js).
//
// Ported from the former app shell (public/app.js) with its rules intact:
// - every request is bounded: a read gives up after 20 s, a write after
//   120 s and then says its outcome is unknown (audit V2-006);
// - a 401 renews the per-launch token once (the PC dashboard) or goes to
//   sign-in (the online desk); never a retry loop;
// - a read that meets a save in progress (503 READ_BUSY) waits as long as the
//   server asks and tries again, a few times;
// - a visible page asks GET /api/version every 2.5 s with one short request,
//   a hidden one asks nothing; on a change the index is fetched again and
//   only the project records that changed are dropped.
// Nothing here starts research, refreshes prices or writes on its own.
import { toast, store as browserStore, announce } from '../../../public/ui.js';

const GET_TIMEOUT_MS = 20000;
const WRITE_TIMEOUT_MS = 120000;
const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 8000;
const BROAD_AREAS = ['portfolio', 'market-data', 'config', 'templates', 'all', 'poll', 'api', 'startup', 'logs', 'request'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const desk = {
  token: null,
  session: null,
  index: null,
  ui: {},
  projects: new Map(),
  projectGen: new Map(),   // project ID -> how often its cached record was dropped
  live: { mode: null, seq: null, instance: null, timer: null, ctrl: null, failures: 0, retryIn: null, saving: false, read: null, readCode: null, polls: 0 },
  // Why the last change happened: 'boot', 'live' (a change on the server),
  // 'refresh' (after a write here).
  reason: 'boot',
  error: null,
  version: 0,
};

const listeners = new Set();
export function emit(reason = null) {
  if (reason) desk.reason = reason;
  desk.version += 1;
  for (const fn of [...listeners]) fn();
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const getVersion = () => desk.version;

// ---- the API -----------------------------------------------------------------

async function parse(res) {
  const type = res.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body && body.error ? body.error : `Request failed (${res.status})`);
    err.code = body && body.code;
    err.saved = body && body.saved;
    err.status = res.status;
    err.retryAfterMs = body && typeof body.retry_after_ms === 'number' ? body.retry_after_ms : (Number(res.headers.get('retry-after')) * 1000 || null);
    throw err;
  }
  return body;
}

const toLogin = () => location.assign('/login');

async function call(path, init = {}, read = (res) => res, { timeoutMs = null, signal = null } = {}) {
  const write = (init.method || 'GET') !== 'GET';
  const ms = timeoutMs || (write ? WRITE_TIMEOUT_MS : GET_TIMEOUT_MS);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, ms);
  const relay = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', relay, { once: true });
  }
  const go = () => fetch(path, { ...init, signal: ctrl.signal, headers: { ...(init.headers || {}), 'x-cr-token': desk.token } });
  try {
    let res = await go();
    if (res.status === 401) {
      try {
        const sres = await fetch('/api/session', { signal: ctrl.signal });
        if (sres.status === 401 && desk.session && desk.session.hosted) {
          toLogin();
          return await read(res);
        }
        const s = await sres.json();
        if (s && s.token && s.workspace && desk.session && s.workspace.workspace_id === desk.session.workspace.workspace_id) {
          desk.token = s.token;
          res = await go();
        }
        if (res.status === 401 && desk.session && desk.session.hosted) {
          toLogin();
          return await read(res);
        }
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
      }
    }
    return await read(res);
  } catch (err) {
    if (timedOut) {
      const e = new Error(write
        ? `No answer from the dashboard server within ${Math.round(ms / 1000)} seconds. The change may or may not have been saved: reload the page and check before trying again.`
        : `The dashboard server did not answer within ${Math.round(ms / 1000)} seconds.`);
      e.code = 'CLIENT_TIMEOUT';
      e.saved = write ? 'unknown' : false;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

function setSaving(on) {
  if (desk.live.saving === on) return;
  desk.live.saving = on;
  emit();
}

async function getWithRetry(path, opts, read) {
  for (let i = 0; ; i++) {
    try {
      const out = await call(path, {}, read, opts);
      if (i) setSaving(false);
      return out;
    } catch (err) {
      if (!['READ_BUSY', 'READ_INTERRUPTED'].includes(err.code) || i >= 4 || (opts.signal && opts.signal.aborted)) {
        if (i) setSaving(false);
        throw err;
      }
      setSaving(true);
      await sleep(Math.min(Math.max(err.retryAfterMs || 1000, 250), 4000));
    }
  }
}

const readText = async (res) => {
  if (!res.ok) await parse(res);
  return res.text();
};

export const api = {
  get(path, opts = {}) {
    return getWithRetry(path, opts, parse);
  },
  post(path, body, opts = {}) {
    return call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }, parse, opts);
  },
  text(path, opts = {}) {
    return getWithRetry(path, opts, readText);
  },
  async download(path, filename) {
    const blob = await getWithRetry(path, { timeoutMs: WRITE_TIMEOUT_MS }, async (res) => {
      if (!res.ok) await parse(res);
      return res.blob();
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },
};

// ---- records -------------------------------------------------------------------

export async function loadIndex() {
  desk.index = await api.get('/api/index');
  if (desk.index.live) {
    desk.live.seq = desk.index.live.seq;
    desk.live.instance = desk.index.live.instance;
  }
  if (desk.index.read_status) desk.live.read = desk.index.read_status;
  return desk.index;
}

const inflight = new Map();
export async function projectDetail(id, { fresh = false } = {}) {
  if (!fresh && desk.projects.has(id)) return desk.projects.get(id);
  const gen = desk.projectGen.get(id) || 0;
  const key = `${id}#${gen}`;
  if (!fresh && inflight.has(key)) return inflight.get(key);
  const p = api.get(`/api/projects/${encodeURIComponent(id)}`).then((d) => {
    // A newer change dropped this record while it was on its way: keep it
    // only if nothing changed since.
    if ((desk.projectGen.get(id) || 0) === gen) desk.projects.set(id, d);
    return d;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function dropProject(id) {
  desk.projects.delete(id);
  desk.projectGen.set(id, (desk.projectGen.get(id) || 0) + 1);
}
function dropAllProjects() {
  for (const id of [...desk.projects.keys(), ...desk.projectGen.keys()]) dropProject(id);
}

// After a write: reload and redraw in place.
export async function refresh() {
  dropAllProjects();
  await loadIndex();
  emit('refresh');
}

// ---- saved view preferences ------------------------------------------------------
// Kept in the workspace's config/ui-state.json so they follow the folder, with
// a browser copy as a fallback when the server cannot be reached.
let uiTimer = null;
export const ui = {
  get(key, fallback) {
    const v = desk.ui[key];
    return v === undefined ? fallback : v;
  },
  set(key, value) {
    desk.ui[key] = value;
    browserStore.set('ui', desk.ui);
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => api.post('/api/ui-state', desk.ui).catch(() => {}), 600);
  },
};

// ---- live updates ------------------------------------------------------------------

function stopPolling() {
  clearTimeout(desk.live.timer);
  desk.live.timer = null;
  const c = desk.live.ctrl;
  desk.live.ctrl = null;
  if (c) c.abort();
}

function schedulePoll(ms) {
  clearTimeout(desk.live.timer);
  desk.live.timer = null;
  if (document.hidden) {
    desk.live.mode = 'paused';
    emit();
    return;
  }
  desk.live.timer = setTimeout(pollVersion, ms);
}

function startPolling() {
  stopPolling();
  if (document.hidden) {
    desk.live.mode = 'paused';
    emit();
    return;
  }
  pollVersion();
}

async function applyChanges(changes) {
  const before = desk.index;
  try {
    await loadIndex();
  } catch (_) {
    return false;
  }
  const broad = !changes || changes.some((c) => c.projects === null || (c.areas || []).some((a) => BROAD_AREAS.includes(a)));
  if (broad) dropAllProjects();
  else for (const c of changes) for (const id of c.projects || []) dropProject(id);
  const added = (desk.index.projects || []).filter((p) => before && !before.projects.some((q) => q.project_id === p.project_id));
  if (added.length) announce(`${added.map((p) => p.name).join(', ')} added.`);
  emit('live');
  return true;
}

async function pollVersion() {
  const live = desk.live;
  live.timer = null;
  if (document.hidden) {
    live.mode = 'paused';
    emit();
    return;
  }
  if (live.ctrl) return;
  const ctrl = new AbortController();
  live.ctrl = ctrl;
  live.polls += 1;
  let v;
  try {
    v = await api.get(`/api/version${live.seq !== null ? `?since=${live.seq}` : ''}`, { signal: ctrl.signal, timeoutMs: POLL_TIMEOUT_MS });
  } catch (err) {
    if (live.ctrl !== ctrl) return;
    live.ctrl = null;
    if (err && err.status === 401) {
      live.mode = 'signed_out';
      emit();
      if (!desk.session || !desk.session.hosted) toast('This dashboard was restarted with another session. Reload the page to continue.', 'bad');
      return;
    }
    live.failures += 1;
    live.retryIn = Math.min(POLL_MS * 2 ** live.failures, 30000);
    live.mode = 'reconnecting';
    emit();
    schedulePoll(live.retryIn);
    return;
  }
  if (live.ctrl !== ctrl) return;
  live.ctrl = null;
  live.failures = 0;
  live.retryIn = null;
  const wasMode = live.mode;
  live.mode = 'live';
  live.read = v.read_status || null;
  const code = live.read && live.read.status !== 'current' ? live.read.code : null;
  if (code && code !== live.readCode && !['READ_BUSY', 'READ_INTERRUPTED'].includes(code)) toast(`The view may be out of date: ${live.read.reason}`, 'bad');
  live.readCode = code;
  const restarted = live.instance !== null && v.instance !== live.instance;
  if (live.seq === null) {
    live.seq = v.seq;
    live.instance = v.instance;
    if (wasMode !== 'live') emit();
  } else if (restarted || v.seq !== live.seq) {
    if (!(await applyChanges(restarted ? null : v.changes))) live.failures += 1;
    else if (restarted) live.instance = v.instance;
  } else if (wasMode !== 'live') emit();
  schedulePoll(POLL_MS);
}

// The connection in words, for the status line.
export function liveStatus() {
  const live = desk.live;
  const read = live.read && live.read.status !== 'current' ? live.read : null;
  if (live.mode === 'paused') return { label: 'Paused while hidden', tone: 'paused' };
  if (live.mode === 'signed_out') return { label: 'Signed out: reload', tone: 'off' };
  if (live.mode === 'reconnecting') return { label: live.retryIn ? `Reconnecting… next try in ${Math.round(live.retryIn / 1000)} s` : 'Reconnecting…', tone: 'off' };
  if (live.saving || (read && ['READ_BUSY', 'READ_INTERRUPTED'].includes(read.code))) return { label: 'Saving in progress', tone: 'wait' };
  if (read) return { label: read.status === 'stale' ? 'Showing the last verified view' : 'Not verified yet', tone: 'wait', title: read.reason };
  if (live.mode === 'live') return { label: 'Live', tone: 'on' };
  return { label: 'Connecting', tone: '' };
}

// ---- start ---------------------------------------------------------------------------

export async function boot() {
  let sres;
  try {
    sres = await fetch('/api/session');
  } catch (_) {
    desk.error = location.protocol === 'https:' ? 'Could not reach the research desk. Check your connection and reload.' : 'Could not reach the local dashboard server. Start it with "Open Dashboard.cmd".';
    emit('boot');
    return false;
  }
  if (sres.status === 401) {
    toLogin();
    return false;
  }
  desk.session = await sres.json();
  desk.token = desk.session.token;
  try {
    desk.ui = await api.get('/api/ui-state');
  } catch (_) {
    desk.ui = browserStore.get('ui', {}) || {};
  }
  if (!desk.ui || typeof desk.ui !== 'object') desk.ui = {};
  try {
    await loadIndex();
  } catch (err) {
    desk.error = `Could not load your workspace: ${err.message}`;
    emit('boot');
    return false;
  }
  emit('boot');
  startPolling();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
      desk.live.mode = 'paused';
      emit();
    } else startPolling();
  });
  window.addEventListener('pagehide', stopPolling);
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) startPolling();
  });
  window.addEventListener('online', () => {
    if (desk.live.mode === 'reconnecting') startPolling();
  });
  return true;
}

export const hosted = () => Boolean(desk.session && desk.session.hosted);
