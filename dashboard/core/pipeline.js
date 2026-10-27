'use strict';
// The build pipeline as it stands (Pipeline cockpit, 2026-10-27): what the
// web app's #/pipeline draws, read from what the repository and the desk
// already hold. Read only: no fetch, no write, no model.
//
//   - the backlog: DESK_STATE.md's numbered checkbox items in this copy
//     (backlog-status.js parseBacklog), each with the paths its text names
//     and its Schedule line's `touches`, which public/pipeline-progress.js sorts into
//     categories;
//   - in flight: the branches waiting for Eric's merge and the builders'
//     claims, from this copy's own remote refs (backlog-status.js and
//     backlog-schedule.js as the last fetch saw them; never fetched here);
//   - the agent lane: today's paid builds and revisions from the ledger's
//     local ref against `.github/agent-policy.json`'s builds_per_day;
//   - the engineering inbox: tasks by status (dashboard/engineering/inbox.js,
//     read as Eric);
//   - pace: the items merged on main in the last seven days, by their
//     Backlog-Item trailers.
// Where git or a ref is not here (the online desk has no checkout), that part
// says so in words and nothing is inferred.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FORMAT = 'cr-pipeline@1';
// A paid attempt with no outcome counts as in flight this long: the ledger's
// own fallback when its run's status cannot be read (agent-ledger.js
// settleOpen). This page asks GitHub nothing, so it never reads that status.
const HOLD_MS = 65 * 60 * 1000;
const PACE_DAYS = 7;

// The paths an item names: backticked text that reads as a path. Its
// Schedule line's `touches`, when it has one, are kept apart: they are what
// the builder may change, where the text may only mention a file.
function pathsOf(block) {
  const out = new Set();
  for (const m of String(block).matchAll(/`([^`\s]+)`/g)) {
    const v = m[1].replace(/\\/g, '/');
    if (/^[#<]|^origin\/|^https?:/.test(v)) continue; // an address or a ref, not a file
    if (/\//.test(v) || /\.(js|jsx|mjs|css|json|md|yml)$/.test(v)) out.add(v.replace(/^\.\//, ''));
  }
  return [...out];
}

function touchesOf(block) {
  const sch = /\*\*Schedule:\*\*\s*(.*)$/m.exec(block);
  const touches = sch ? /touches\s+([^;]*)/i.exec(sch[1]) : null;
  if (!touches) return null;
  return touches[1].split(',').map((raw) => raw.replace(/[`*]/g, '').trim().replace(/\.$/, '')).filter(Boolean);
}

// Each numbered item's whole text: its line and the indented lines under it.
function blocksOf(state) {
  const section = (/^## Autonomous Build Backlog[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(state) || [])[1] || '';
  const blocks = new Map();
  let n = null;
  for (const line of section.split('\n')) {
    const m = /^\s*- \[[ xX]\] (?:\*\([^)]*\)\* )?\*\*(\d+)\./.exec(line);
    if (m) { n = Number(m[1]); blocks.set(n, line); continue; }
    if (n !== null && /^\s+\S/.test(line)) blocks.set(n, `${blocks.get(n)}\n${line}`);
    else if (/^\S/.test(line)) n = null;
  }
  return blocks;
}

function backlogOf(state) {
  const { parseBacklog } = require('../scripts/backlog-status');
  const blocks = blocksOf(state);
  return parseBacklog(state).map((it) => ({ n: it.n, title: it.text.replace(/\.$/, ''), checked: it.checked, eric: it.eric, engineering: Boolean(it.engineering), paths: pathsOf(blocks.get(it.n) || ''), touches: touchesOf(blocks.get(it.n) || '') }));
}

function inFlightOf(root, now) {
  try {
    const status = require('../scripts/backlog-status').status(root, { now });
    const sched = require('../scripts/backlog-schedule');
    const claims = [];
    for (const [n, c] of sched.readClaims(root)) {
      const st = sched.claimState(c, now.getTime(), false).state;
      if (st === 'active') claims.push(n);
    }
    return { known: true, waiting: status.waiting.map((w) => w.item), claimed: claims.sort((a, b) => a - b), window: status.window };
  } catch (e) {
    return { known: false, why: 'This copy has no git remote to read the waiting branches and claims from.' };
  }
}

function git(root, args) {
  const r = require('child_process').spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function ledgerOf(root, now) {
  let limit = null;
  try { limit = JSON.parse(fs.readFileSync(path.join(root, '.github', 'agent-policy.json'), 'utf8')).ceilings.builds_per_day; } catch (_) { limit = null; }
  const text = git(root, ['show', 'refs/remotes/origin/agent-ledger:ledger.jsonl']);
  if (text === null) return { known: false, limit, why: 'No local copy of the agent ledger.' };
  const L = require('../scripts/agent-ledger');
  const p = L.parse(text);
  if (p.broken) return { known: false, limit, why: 'The agent ledger does not read as a chain.' };
  const day = now.toISOString().slice(0, 10);
  const paid = L.attempts(p.entries).filter((a) => L.PAID[a.reserve.kind]);
  const used = paid.filter((a) => a.reserve.day === day).length;
  const open = paid.filter((a) => !a.outcomes.length && now.getTime() - Date.parse(a.reserve.at) < HOLD_MS);
  return { known: true, limit, used, day, building: open.filter((a) => a.reserve.kind === 'build').length, revising: open.filter((a) => a.reserve.kind === 'revise').length };
}

function paceOf(root) {
  const out = git(root, ['log', 'origin/main', `--since=${PACE_DAYS}.days.ago`, '--format=%B']);
  if (out === null) return { known: false, why: 'No git history in this copy.' };
  const { trailers } = require('../scripts/backlog-status');
  return { known: true, days: PACE_DAYS, merged: new Set(trailers(out)).size };
}

function inboxOf(ws) {
  try {
    const r = require('../engineering/inbox').listTasks(ws, { kind: 'owner' }, { limit: 200 });
    const by = {};
    for (const t of r.tasks) if (t.status) by[t.status] = (by[t.status] || 0) + 1;
    return { known: r.complete, paused: r.paused, by_status: by };
  } catch (_) {
    return { known: false, by_status: {} };
  }
}

function read(ws, { root = ROOT, now = new Date() } = {}) {
  let state = null;
  try { state = fs.readFileSync(path.join(root, 'DESK_STATE.md'), 'utf8'); } catch (_) { state = null; }
  return {
    format: FORMAT,
    writes_nothing: true,
    at: now.toISOString(),
    backlog: state === null ? null : backlogOf(state),
    in_flight: inFlightOf(root, now),
    agent_lane: ledgerOf(root, now),
    inbox: inboxOf(ws),
    pace: paceOf(root),
  };
}

module.exports = { read, backlogOf, blocksOf, pathsOf, touchesOf, FORMAT };
