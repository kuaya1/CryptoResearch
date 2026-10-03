'use strict';
// Named single-flight leases shared by every runner (dashboard, CLI, scheduled
// task, Cowork session). A lease held by a live process on this PC is respected;
// a lease from another host, or one whose owner died, expires after its TTL.
// Used for market refreshes, daily jobs and research jobs (audit F17).
//
// "Live process" is checked by process ID, which a later process can reuse
// (a container restarted in place, a PC after a reboot). Each lease therefore
// also records this process's boot token: a lease with this process's own ID
// but another boot token belongs to an earlier process and is free. A lease on
// this host held past its expiry for longer than STALE_SAME_HOST_MS (its owner
// would have finished or died long before) is free too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { mkdirp, writeDurable } = require('./fsx');

const BOOT = crypto.randomBytes(8).toString('hex');
const STALE_SAME_HOST_MS = 6 * 3600000;

function leasePath(ws, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(name)) throw new Error(`Bad lease name ${name}`);
  return path.join(ws.root, '.cr', 'leases', `${name}.json`);
}

// Whether the owner of a lease recorded on this host may still be running.
function ownerAlive(cur) {
  if (cur.pid === process.pid && cur.boot && cur.boot !== BOOT) return false;
  if (!pidAlive(cur.pid)) return false;
  const exp = Date.parse(cur.expires_at || 0);
  return !(Number.isFinite(exp) && Date.now() - exp > STALE_SAME_HOST_MS);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function read(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function leaseInfo(ws, name) {
  const p = leasePath(ws, name);
  const cur = read(p);
  if (!cur || cur.released) return { held: false };
  const expired = Date.parse(cur.expires_at || 0) < Date.now();
  const sameHost = cur.host === os.hostname();
  const alive = sameHost ? ownerAlive(cur) : !expired;
  return { held: alive, ...cur, expired };
}

// Returns a token when acquired, or null when someone else holds it.
function acquireLease(ws, name, ttlMs, { label = null } = {}) {
  const p = leasePath(ws, name);
  mkdirp(path.dirname(p));
  const rec = { token: crypto.randomBytes(10).toString('hex'), name, pid: process.pid, boot: BOOT, host: os.hostname(), actor: ws.actor, label, acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + ttlMs).toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(rec));
      } finally {
        fs.closeSync(fd);
      }
      return rec.token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const cur = read(p);
    const sameHost = cur && cur.host === os.hostname();
    const free = !cur || cur.released || (sameHost ? !ownerAlive(cur) : Date.parse(cur.expires_at || 0) < Date.now());
    if (!free) return null;
    // Take a free lease: rename it aside (atomic), or overwrite where renames are not allowed.
    try {
      fs.renameSync(p, `${p}.stale-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
      try { fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(`${name}.json.stale-`)).forEach((f) => fs.unlinkSync(path.join(path.dirname(p), f))); } catch (_) { /* best effort */ }
    } catch (_) {
      // Cannot rename here: overwrite, then confirm we won.
      if (JSON.stringify(cur) !== JSON.stringify(read(p))) return null;
      writeDurable(p, JSON.stringify(rec));
      const back = read(p);
      return back && back.token === rec.token ? rec.token : null;
    }
  }
  return null;
}

function releaseLease(ws, name, token) {
  const p = leasePath(ws, name);
  const cur = read(p);
  if (!cur || cur.token !== token) return false;
  try {
    fs.unlinkSync(p);
  } catch (_) {
    try { writeDurable(p, JSON.stringify({ ...cur, released: true, released_at: new Date().toISOString() })); } catch (__) { /* ignore */ }
  }
  return true;
}

// The online desk is the only process on its disk: Render stops the old
// instance before a service with a persistent disk starts the new one (no
// overlapping deploys). Leases another host (an earlier instance) left are
// therefore free at start, instead of blocking research for their whole TTL.
// Returns the names released. Never used on the PC, where the dashboard, the
// CLI and the scheduled task do run side by side.
function releaseForeignLeases(ws) {
  const dir = path.join(ws.root, '.cr', 'leases');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    return out;
  }
  for (const f of names) {
    const p = path.join(dir, f);
    const cur = read(p);
    if (!cur || cur.released || cur.host === os.hostname()) continue;
    try {
      writeDurable(p, JSON.stringify({ ...cur, released: true, released_at: new Date().toISOString(), released_by: `start of ${os.hostname()} (single instance on this disk)` }));
      out.push(cur.name || f.replace(/\.json$/, ''));
    } catch (_) { /* left to expire */ }
  }
  return out;
}

async function withLease(ws, name, ttlMs, fn, opts = {}) {
  const token = acquireLease(ws, name, ttlMs, opts);
  if (!token) return { status: 'busy', lease: leaseInfo(ws, name) };
  try {
    return await fn();
  } finally {
    releaseLease(ws, name, token);
  }
}

module.exports = { acquireLease, releaseLease, withLease, leaseInfo, releaseForeignLeases, BOOT };
