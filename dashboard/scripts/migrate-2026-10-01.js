'use strict';
// One-time migration for the 2026-10-01 watchlist update. Safe to run twice.
// - Gives each existing project a primary sector, marked source "migration"
//   (your label; change it any time on the watchlist or with `project set`).
// - Records this PC as the workspace's home host, so a session on another
//   host (for example a cloud Cowork task) can tell it is not on this PC.
// Every change goes through the journaled write path; the previous version of
// each changed file is kept in backups/versions/. Nothing else is touched.
// Usage: node dashboard/scripts/migrate-2026-10-01.js [--dry-run]
const os = require('os');
const { openWorkspace } = require('../core/workspace');
const projects = require('../core/projects');
const { runOp } = require('../core/ops');
const { normalizeSector } = require('../core/sectors');

// Known projects get an explicit primary sector; anything else gets the sector
// its scoring profile suggests.
const SECTOR_BY_PROJECT = { 'huma-finance': 'payments', 'allora-network': 'ai_data' };

const dryRun = process.argv.includes('--dry-run');
const ws = openWorkspace({ actor: 'migration-2026-10-01' });
const report = { workspace: ws.root, kind: ws.kind, dry_run: dryRun, projects: [], home_host: null };

for (const p of projects.listProjects(ws)) {
  if (p.broken) {
    report.projects.push({ project_id: p.project_id, skipped: 'unreadable record' });
    continue;
  }
  if (p.sector && p.sector.primary) {
    report.projects.push({ project_id: p.project_id, unchanged: p.sector });
    continue;
  }
  const explicit = SECTOR_BY_PROJECT[p.project_id];
  const sector = explicit
    ? { ...normalizeSector(explicit), source: 'migration' }
    : normalizeSector(null, { fallbackProfile: p.sector_profile });
  const entry = { project_id: p.project_id, before: p.sector || null, after: sector };
  if (!dryRun) {
    const out = projects.mutateProject(ws, p.project_id, 'migrate_sector', `Set sector for ${p.project_id} (migration 2026-10-01)`, (proj) => {
      if (!proj.sector || !proj.sector.primary) proj.sector = sector;
    });
    entry.verified = out.verified;
    entry.files = out.files;
  }
  report.projects.push(entry);
}

const marker = require('../core/fsx').readJson(ws.abs('workspace.json'), {});
if (marker.home_host) {
  report.home_host = { unchanged: marker.home_host };
} else if (dryRun) {
  report.home_host = { would_set: os.hostname() };
} else {
  const out = runOp(ws, { type: 'set_home_host', summary: `Record ${os.hostname()} as this workspace's home PC (migration 2026-10-01)` }, (op) => {
    const m = op.readJson('workspace.json', null);
    if (!m || m.home_host) return;
    op.writeJson('workspace.json', { ...m, home_host: os.hostname() });
  });
  report.home_host = { set: os.hostname(), verified: out.verified, files: out.files };
}

console.log(JSON.stringify(report, null, 2));
