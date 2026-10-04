'use strict';
// Environment and write verification, plus what this session can actually do.
// Cowork (or any session) should run this first: it proves the folder it sees
// is the real workspace and that a write lands there and reads back, before
// anything is reported as saved. It never needs to delete files to pass.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeDurable, sha256, listDir } = require('./fsx');
const ops = require('./ops');

async function serverStatus(ws, { projectId = null, waitMs = 0 } = {}) {
  const info = readJson(ws.abs('.cr/server.json'), null);
  if (!info || !info.port) return { running: false, reachable: false, message: 'Dashboard is not running. It will show the change on its next launch.' };
  const deadline = Date.now() + waitMs;
  let last = null;
  do {
    try {
      const url = `http://127.0.0.1:${info.port}/api/health${projectId ? `?project=${encodeURIComponent(projectId)}` : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      last = await res.json();
      if (last.workspace_id !== ws.meta.workspace_id) {
        return { running: false, reachable: true, message: `Port ${info.port} answers for a different workspace.` };
      }
      if (!projectId || last.project_present) break;
    } catch (_) {
      const otherHost = info.host_name && info.host_name !== os.hostname();
      return {
        running: null,
        reachable: false,
        url: info.url,
        message: otherHost
          ? `The dashboard runs on ${info.host_name}, which this session (${os.hostname()}) cannot reach. It watches the folder and shows the change within seconds while it is open.`
          : 'Dashboard is not reachable from here (closed, or this session runs in a separate sandbox). It watches the folder and shows the change when it runs.',
      };
    }
    if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 400));
  } while (Date.now() < deadline);
  return {
    running: true,
    reachable: true,
    url: info.url,
    index_built_at: last && last.index_built_at,
    project_visible: projectId ? Boolean(last && last.project_present) : undefined,
    message: projectId
      ? last && last.project_present ? `Dashboard at ${info.url} already lists ${projectId}.` : `Dashboard at ${info.url} has not refreshed yet; it will within a few seconds.`
      : `Dashboard running at ${info.url}.`,
  };
}

const NODE_SUPPORT = {
  // From the Node.js release schedule (checked October 1, 2026).
  20: { status: 'end-of-life', note: 'Node 20 reached end of life in 2026. Use Node 24 LTS.' },
  22: { status: 'lts', note: 'Supported LTS.' },
  24: { status: 'lts', note: 'Supported LTS (recommended).' },
  26: { status: 'current', note: 'Current release line; not yet LTS.' },
};

function runtimeInfo(ws) {
  const major = Number(process.versions.node.split('.')[0]);
  const support = NODE_SUPPORT[major] || (major > 26 ? { status: 'newer', note: 'Newer than this check knows about.' } : { status: 'unsupported', note: 'Too old. Use Node 24 LTS.' });
  const pkg = readJson(path.join(ws.root, 'package.json'), null);
  return { version: process.versions.node, major, exec_path: process.execPath, support: support.status, note: support.note, project_pin: pkg && pkg.volta ? pkg.volta.node || null : null };
}

// What this session can do in this folder, by actually trying it.
function sessionCapabilities(ws) {
  const caps = ops.capabilities(ws);
  const marker = readJson(ws.abs('workspace.json'), {});
  const homeHost = marker.home_host || null;
  const host = os.hostname();
  return {
    host,
    platform: process.platform,
    home_host: homeHost,
    on_home_pc: homeHost ? homeHost.toLowerCase() === host.toLowerCase() : null,
    can_run_node: true,
    can_write: caps.write,
    can_rename: caps.rename,
    can_delete: caps.delete,
    route: caps.write
      ? 'direct: run node dashboard/cli.js commands; every save is verified by reading it back'
      : 'queue: this session cannot write here; nothing can be saved',
    notes: [
      caps.delete ? null : 'This session cannot delete files. Saves still work; temporary files are cleaned up later by your PC.',
      homeHost && homeHost.toLowerCase() !== host.toLowerCase() ? `This session runs on ${host}, not on the PC that owns the workspace (${homeHost}). The PC's dashboard and scheduled task are not reachable from here; they pick up changes from the folder.` : null,
    ].filter(Boolean),
  };
}

async function doctor(ws) {
  const checks = [];
  const add = (name, ok, detail, level = ok ? 'ok' : 'fail') => checks.push({ name, status: level, detail });
  const rt = runtimeInfo(ws);
  add('Node.js', rt.major >= 20, `v${rt.version} (${rt.exec_path}) — ${rt.note}${rt.project_pin ? ` Project pin: node ${rt.project_pin}.` : ''}`, rt.major < 20 ? 'fail' : rt.support === 'end-of-life' ? 'warn' : 'ok');
  add('Operating system', true, `${os.type()} ${os.release()} (${process.platform}), host ${os.hostname()}`, 'ok');
  const sandboxHint = process.platform === 'linux' && /^\/(sessions|mnt|workspace)\b/.test(ws.root);
  add('Workspace folder', ws.kind === 'real' || ws.kind === 'demo' || ws.kind === 'test', `${ws.root} (kind: ${ws.kind}, id: ${ws.meta.workspace_id})${sandboxHint ? ' — looks like a mounted folder inside a sandbox; writes are verified by reading them back' : ''}`, 'ok');
  if (/[\\/]OneDrive[\\/]/i.test(ws.root)) add('Cloud sync', false, 'This folder is inside OneDrive, so portfolio data syncs to the cloud. Move it if that is not intended.', 'warn');

  // Write verification: overwrite a fixed probe file, read it back, compare.
  // Uses one fixed name, so it never needs to delete anything.
  const probeRel = '.cr/doctor.probe';
  const payload = `doctor ${new Date().toISOString()} ${crypto.randomBytes(8).toString('hex')}`;
  try {
    writeDurable(ws.abs(probeRel), payload);
    const back = fs.readFileSync(ws.abs(probeRel), 'utf8');
    const ok = sha256(back) === sha256(payload);
    add('Write test', ok, ok ? 'Wrote, read back and matched a test file in the workspace.' : 'Read-back did not match. Do not report saves as successful.');
  } catch (err) {
    add('Write test', false, `Could not write to the workspace: ${err.message}. Nothing can be saved here.`);
  }
  const caps = sessionCapabilities(ws);
  add('This session', caps.can_write, `${caps.route}. Rename ${caps.can_rename ? 'allowed' : 'not allowed'}, delete ${caps.can_delete ? 'allowed' : 'not allowed'}.${caps.notes.length ? ` ${caps.notes.join(' ')}` : ''}`, caps.can_write ? 'ok' : 'fail');

  const blocked = ops.blockedState(ws);
  if (blocked) add('Writes', false, `BLOCKED since ${blocked.blocked_at}: ${blocked.reason} (op ${blocked.op_id}). Evidence: ${blocked.evidence}. Inspect, then: node dashboard/cli.js recover --resolve`, 'fail');
  else add('Writes', true, 'Not blocked.', 'ok');
  const pending = ops.pendingRecovery(ws);
  if (pending.length) {
    const sealed = pending.filter((p) => p.state === 'sealed').length;
    add('Interrupted writes', !sealed, `${pending.length} staging folder(s): ${pending.map((p) => `${p.op_id} (${p.state})`).join(', ')}.${sealed ? ' Run: node dashboard/cli.js recover' : ' Only cleanup is pending.'}`, sealed ? 'warn' : 'info');
  }
  const lock = ops.lockState(ws);
  if (lock.present && !lock.stale && !lock.mine) add('Workspace lock', true, `Held right now: ${lock.reason}.`, 'info');

  try {
    const r = ws.rubrics;
    const altered = Object.entries(r.versionStatus).filter(([, v]) => v.status === 'altered').map(([k]) => k);
    const unpinned = Object.entries(r.versionStatus).filter(([, v]) => v.status === 'unpinned').map(([k]) => k);
    add('Rubrics', !altered.length, `Active ${r.activeRef}; versions: ${Object.keys(r.gradingVersions).join(', ')}; profiles: ${Object.keys(r.profiles).join(', ')}.${altered.length ? ` CHANGED AFTER PUBLICATION: ${altered.join(', ')} (grades that use them are withheld).` : ''}${unpinned.length ? ` Not pinned yet: ${unpinned.join(', ')}.` : ''}`, altered.length ? 'fail' : unpinned.length ? 'warn' : 'ok');
  } catch (err) {
    add('Rubrics', false, err.message);
  }
  const schemas = listDir(ws.abs('templates/schemas'), { dirs: false });
  add('Schemas', schemas.includes('report.v1.schema.json'), schemas.join(', ') || 'missing');

  try {
    const t = Date.now();
    const { buildIndex } = require('./indexer');
    const idx = buildIndex(ws);
    add('Index build', true, `${idx.projects.length} project(s), ${idx.portfolio.positions.filter((p) => !p.closed).length} open position(s), built in ${Date.now() - t} ms`);
  } catch (err) {
    add('Index build', false, err.message);
  }

  const srv = await serverStatus(ws);
  add('Dashboard server', true, srv.message, srv.running ? 'ok' : 'info');

  if (ws.hosted) {
    // The online desk does its own background work; there is no Windows task.
    add('Background work', true, 'The online desk refreshes prices and runs queued research by itself while it runs; no scheduled task on a PC is involved.', 'ok');
  } else if (process.platform === 'win32') {
    const s = require('./schedule').status(ws);
    if (s.installed && s.ownership === 'this_workspace') add('Scheduled task', true, `\\CryptoResearch\\Hourly is ${s.state} and runs this folder; last run ${s.last_run_time || 'never'} (${s.last_task_result_meaning || '?'}); next ${s.next_run_time || '?'}`);
    else if (s.installed) add('Scheduled task', false, `Installed, but it runs ${s.targets}, not this folder. It does not update this workspace.`, ws.kind === 'real' ? 'warn' : 'info');
    else add('Scheduled task', false, 'Not installed. Background updates only happen while the dashboard is open. Install: node dashboard/cli.js schedule install', ws.kind === 'real' ? 'warn' : 'info');
  } else {
    add('Scheduled task', false, 'Not managed from this OS or session. The PC that owns the workspace runs it.', 'info');
  }

  const m = require('./market').freshness(ws);
  add('Market data', ['fresh', 'fresh_partial', 'fresh_last_failed'].includes(m.freshness), m.last_success_at ? `Last success ${m.last_success_at} (${m.age_minutes} min ago)${m.last_error ? `; last issue: ${m.last_error}` : ''}; CoinGecko requests this month ${m.calls.month_count}${m.calls.budget_monthly ? ` of ${m.calls.budget_monthly}` : ''}${typeof m.calls.month_answered === 'number' ? ` (${m.calls.month_answered} answered${m.calls.answered_counted_since ? ` since ${m.calls.answered_counted_since}` : ''})` : ''}` : ws.settings.market_data.enabled ? 'Never fetched' : 'Turned off in settings', ['fresh'].includes(m.freshness) || !ws.settings.market_data.enabled ? 'ok' : 'warn');

  try {
    // DefiLlama fundamentals: what is bound and saved, the last refresh, the gate.
    const fo = require('./fundamentals').overview(ws);
    const states = Object.entries(fo.states).filter(([s]) => s !== 'unmapped').map(([s, n]) => `${n} ${s.replace(/_/g, ' ')}`).join(', ');
    const problems = ['unavailable', 'not_found', 'scope_mismatch', 'entity_mismatch', 'unidentified'].reduce((a, s) => a + (fo.states[s] || 0), 0);
    const detail = !fo.enabled
      ? 'Turned off in settings.'
      : fo.bound
        ? `${fo.bound} project(s) bound to DefiLlama (${states}); last refresh ${fo.last_run ? `${fo.last_run.at} (${fo.last_run.status})` : 'never'}; requests this month ${fo.calls.month_count}${fo.budget_monthly ? ` of ${fo.budget_monthly}` : ''}${fo.rate_limited ? `; rate-limited until ${fo.retry_at}` : ''}.`
        : 'No project is bound to a DefiLlama entity, so no fees or revenue are supplied (node dashboard/cli.js project identity <id> --defillama-slug ...).';
    add('Fundamentals', !problems, detail, problems ? 'warn' : 'info');
  } catch (_) { /* fundamentals module optional */ }

  try {
    // Contract integrity: GoPlus screens of the contracts on record, recent
    // alerts, and identity records whose contracts cannot be screened.
    const so = require('./screening').overview(ws);
    const st = so.states;
    const alerts = so.alerts;
    const bad = so.identity_issues;
    const parts = [];
    if (so.screened) parts.push(`${so.screened} project(s) screened`);
    for (const k of ['pending', 'unavailable', 'stale', 'unsupported', 'native_chain', 'no_contract']) if (st[k]) parts.push(`${st[k]} ${k.replace(/_/g, ' ')}`);
    const detail = !so.enabled
      ? 'Turned off in settings.'
      : [
        `${parts.join(', ') || 'No verified contracts on record'}; last run ${so.last_run ? `${so.last_run.at} (${so.last_run.status})` : 'never'}; requests this month ${so.calls.month_count}${so.budget_monthly ? ` of ${so.budget_monthly}` : ''}${so.rate_limited ? `; rate-limited until ${so.retry_at}` : ''}; research packets: ${so.packet_mode}; ${so.credential === 'app_key' ? 'GoPlus key present' : 'GoPlus keyless'}.`,
        so.credential_note || '',
        alerts ? `${alerts} contract change alert(s) in the review queue.` : '',
        bad.length ? `Contracts that cannot be screened: ${bad.slice(0, 5).map((b) => `${b.project_id} (${b.reason})`).join('; ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}.` : '',
      ].filter(Boolean).join(' ');
    const warn = so.enabled && (alerts > 0 || (st.unavailable || 0) > 0 || bad.some((b) => b.kind === 'invalid_address'));
    add('Contract screening', !warn, detail, warn ? 'warn' : 'info');
  } catch (_) { /* screening module optional */ }

  const pendingReq = require('./requests').pendingRequests(ws);
  add('Queued requests', pendingReq.length === 0, pendingReq.length ? `${pendingReq.length} pending (not saved yet)` : 'None pending', pendingReq.length ? 'warn' : 'ok');
  const inboxSt = require('./inbox').inboxStatus(ws);
  const failed = inboxSt.in_inbox.filter((f) => !['new'].includes(f.status));
  add('Inbox', failed.length === 0, inboxSt.in_inbox.length ? `${inboxSt.in_inbox.length} file(s) waiting, ${failed.length} need attention` : 'Empty', failed.length ? 'warn' : 'ok');
  try {
    // Backups in three separate parts (offsite.js backupStatus): same-disk
    // snapshots, whether offsite copies are set up, and a verified copy on
    // another machine. The desk serves copies; this PC pulls them once a day
    // once set up. Only a verified copy that is not overdue is "ok" here; a
    // scheduled task that ran without making one is not.
    const b = require('./offsite').backupStatus(ws);
    const ok = ws.hosted ? b.offsite.configured : b.independent_copy.verified && !b.independent_copy.overdue;
    add('Offsite backup', ok, `${b.summary}${!ws.hosted && b.offsite.configured && !b.independent_copy.verified ? ` Pull one now: node dashboard/cli.js offsite pull (saves to ${b.offsite.folder}).` : ''}`, ok ? 'ok' : 'warn');
  } catch (_) { /* offsite module optional */ }
  try {
    const rs = require('./research').providerStatus(ws);
    add('Research providers', true, Object.entries(rs).map(([p, s]) => `${p}: ${s.mode}${s.reason ? ` (${s.reason})` : ''}`).join('; '), 'info');
  } catch (_) { /* research module optional */ }
  try {
    // Paid attempts that may have been billed without a saved answer (V2-003).
    const sp = require('./research').spendSoFar(ws);
    // Paid answers captured but not yet saved into the records (audit F1).
    const cs = require('./research').sweepCaptures(ws, { remove: false });
    const ids = cs.pending.filter((p) => p.kind === 'background request ID');
    const answers = cs.pending.length - ids.length;
    if (answers) add('Research captures', false, `${answers} paid answer(s) arrived and were captured in .cr/captures but are not saved into the records yet. They are saved by the next research run (dashboard, hourly task, or node dashboard/cli.js research run) without asking the provider again.`, 'warn');
    if (ids.length) add('Research captures', false, `${ids.length} background request(s) were accepted by the provider and their ID captured in .cr/captures, but the ID is not in the records yet. The next research run records it and collects the answer by that ID, without sending the request again.`, 'warn');
    if (cs.busy.length) add('Research captures', false, `${cs.busy.length} capture file(s) in .cr/captures are open in another program and cannot be read right now (${cs.busy.map((b) => b.rel).join('; ')}). Nothing is lost; the next research run tries again.`, 'warn');
    if (cs.unmatched.length) add('Research captures', false, `${cs.unmatched.length} capture file(s) in .cr/captures do not match an attempt that is waiting for its answer (${cs.unmatched.map((u) => `${u.rel}: ${u.reason}`).join('; ')}). They are kept for inspection and never imported automatically.`, 'warn');
    if (sp.uncertain_attempts) add('Research spend', false, `${sp.uncertain_attempts} paid attempt(s) have an uncertain outcome: they may have been billed, are never resent automatically, and count at their reservation until you reconcile them (project, Research tab; or node dashboard/cli.js research reconcile).`, 'warn');
  } catch (_) { /* research module optional */ }

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  add('Time zone', true, `System ${tz}; review dates use America/New_York`, 'ok');
  const worst = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, verified_write: checks.find((c) => c.name === 'Write test').status === 'ok', checked_at: new Date().toISOString(), runtime: rt, session: caps, checks };
}

module.exports = { doctor, serverStatus, sessionCapabilities, runtimeInfo };
