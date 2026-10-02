'use strict';
// Exports, the complete package, and sealed local backups.
//
// Three different things, named for what they are (audit F06/F18):
// - Portable data export (export.json + CSV tables): readable structured data
//   for reading elsewhere or in a spreadsheet. Its inventory lists what it
//   leaves out. It is not a backup.
// - Complete package (cryptoresearch-package.json): every record file of the
//   workspace with its SHA-256, so a clean folder can be rebuilt exactly
//   (restore-package). Application code is not in it.
// - Sealed backup (backups/snapshots/<name>/): a consistent copy taken under the
//   workspace lock, including the application code, with a SHA-256 inventory.
//   The default restore writes into an EMPTY folder and is checked file by file
//   and against record totals. Copying a backup over the live folder ("overlay")
//   is a separate, explicitly named option; it is not point-in-time recovery.
// Exports and backups never include secrets: none are stored in the workspace.
// CSV cells that a spreadsheet would run as formulas are neutralized (F09).

const fs = require('fs');
const path = require('path');
const { readJson, readText, listDir, mkdirp, jsonText, exists, rmrf, sha256, writeDurable } = require('./fsx');
const { fileTs } = require('./ids');
const { withLock, renewLock, recoverLocked, logOp, OpError } = require('./ops');
const { listProjects } = require('./projects');
const { loadReports } = require('./reports');
const { gradeAssessment } = require('./rubrics');
const notes = require('./notes');
const portfolio = require('./portfolio');
const market = require('./market');
const { PROVIDERS } = require('./workspace');

// ---------------------------------------------------------------------------
// CSV

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return String(v);
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Text that a spreadsheet would evaluate (=, +, -, @, tab, CR, possibly after
  // leading spaces or control characters) is prefixed with an apostrophe.
  // Plain numbers such as -12.5 stay numbers.
  if (!PLAIN_NUMBER.test(s.trim()) && /^[\s\u0000-\u001f]*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Portable structured export

function promptFiles(ws, projectId) {
  const out = [];
  const walk = (rel) => {
    for (const name of listDir(ws.abs(rel), { dirs: null })) {
      const r = `${rel}/${name}`;
      let st;
      try {
        st = fs.statSync(ws.abs(r));
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) walk(r);
      else if (name.endsWith('.md')) {
        const text = fs.readFileSync(ws.abs(r), 'utf8');
        out.push({ path: r, sha256: sha256(text), text });
      }
    }
  };
  walk(`projects/${projectId}/prompts`);
  return out;
}

function collect(ws) {
  const projects = [];
  const reportRows = [];
  const scoreRows = [];
  const claimRows = [];
  const eventRows = [];
  for (const p of listProjects(ws)) {
    if (p.broken) continue;
    const reports = loadReports(ws, p.project_id).filter((r) => !r.broken);
    const full = {
      project: p,
      reports: reports.map((r) => {
        const isText = !/\.pdf$/i.test(r.meta.original_file);
        const bytes = fs.readFileSync(ws.abs(`${r.dir}/${r.meta.original_file}`));
        return {
          meta: r.meta,
          record: r.record,
          corrections: r.corrections,
          effective_assessment: r.assessment,
          citation_integrity: r.integrity,
          original_text: isText ? bytes.toString('utf8') : null,
          original_base64: isText ? null : bytes.toString('base64'),
          original_sha256: sha256(bytes),
        };
      }),
      journal: notes.loadJournal(ws, p.project_id),
      events: notes.loadEvents(ws, p.project_id),
      claim_reviews: notes.loadClaimReviews(ws, p.project_id),
      disputes: notes.loadDisputes(ws, p.project_id),
      conviction_note: notes.readConvictionNote(ws, p.project_id),
      prompts: promptFiles(ws, p.project_id),
      research_runs: researchRuns(ws, p.project_id),
    };
    projects.push(full);
    for (const r of reports) {
      const a = r.assessment;
      const g = gradeAssessment(ws, a);
      reportRows.push({
        project_id: p.project_id,
        report_id: r.report_id,
        provider: r.meta.provider,
        model_version: a.model_version,
        analysis_at: a.analysis_at,
        imported_at: r.meta.imported_at,
        horizon: a.horizon,
        rubric_version: a.rubric_version,
        sector_profile: a.sector_profile,
        verdict: a.verdict,
        app_grade_status: g ? g.status : 'n/a',
        app_grade: g ? g.display : null,
        app_grade_full_precision: g ? (g.status === 'firm' ? g.value : g.status === 'range' ? `${g.low}-${g.high}` : null) : null,
        app_grade_label: g ? g.label : null,
        weight_coverage_pct: g ? g.coverage_pct : null,
        model_reported_overall: a.model_reported_overall_score ? a.model_reported_overall_score.value ?? (a.model_reported_overall_score.low ? `${a.model_reported_overall_score.low}-${a.model_reported_overall_score.high}` : null) : null,
        corrections: r.corrections.length,
        citation_integrity: r.integrity ? r.integrity.status : null,
        original_file: `${r.dir}/${r.meta.original_file}`,
      });
      for (const [panel, key] of [['diagnostic', 'diagnostic_scores'], ['component', 'investment_components'], ['risk', 'risk_scores']]) {
        for (const [id, s] of Object.entries(a[key] || {})) {
          scoreRows.push({ project_id: p.project_id, report_id: r.report_id, provider: r.meta.provider, panel, direction: panel === 'risk' ? 'higher_is_more_risk' : 'higher_is_better', id, status: s.status, value: s.value, low: s.low, high: s.high, rationale: s.rationale, missing_data: s.missing_data });
        }
      }
      for (const c of a.claims || []) {
        claimRows.push({ project_id: p.project_id, report_id: r.report_id, provider: r.meta.provider, claim_id: c.claim_id, evidence_tag: c.evidence_tag, text: c.text, metric_id: c.metric_id, value: c.value, unit: c.unit, period: c.period, definition: c.definition, as_of: c.as_of, limitation: c.limitation, source_ids: (c.source_ids || []).join(' ') });
      }
    }
    for (const e of full.events) eventRows.push({ scope: p.project_id, ...e, alert: e.alert ? JSON.stringify(e.alert) : null });
  }
  for (const e of notes.loadEvents(ws, 'portfolio')) eventRows.push({ scope: 'portfolio', ...e });
  const latest = market.readLatest(ws);
  const pf = portfolio.computePortfolio(ws, { market: latest });
  return { projects, reportRows, scoreRows, claimRows, eventRows, pf, latest };
}

function researchRuns(ws, projectId) {
  try {
    return require('./research').listRuns(ws, projectId);
  } catch (_) {
    return [];
  }
}

const EXPORT_INVENTORY = {
  included: [
    'workspace marker, settings, all rubric and profile versions with their pinned hashes',
    'every project record, with every report: original text (or base64 for PDFs) and its SHA-256, structured record, corrections, effective values, citation check',
    'journal, conviction notes, review events, claim checks, disputes, research runs, prompt files with hashes',
    'portfolio accounts, assets, transactions (including voided), limits, events, and the computed positions',
    'latest market observation per asset and the market status',
  ],
  omitted: [
    'market observation history (market-data/observations): kept in the complete package and backups',
    'operation log, request receipts and job history (logs/): kept in the complete package and backups',
    'files still waiting in the inbox and inbox history: kept in the complete package and backups',
    'application code and launchers: kept in backups only',
  ],
  note: 'A portable data export for reading. To rebuild a workspace use the complete package or a sealed backup.',
};

function exportJson(ws) {
  return withLock(ws, 'export', () => {
    const data = collect(ws);
    return {
      schema_version: 'cr.export.v2',
      kind: 'portable_data_export',
      exported_at: new Date().toISOString(),
      workspace: ws.meta,
      kind_note: ws.kind === 'real' ? 'Real records.' : `This is a ${ws.kind.toUpperCase()} workspace. Its data is not real.`,
      inventory: EXPORT_INVENTORY,
      settings: ws.settings,
      rubrics: { active: ws.rubrics.activeRef, grading_versions: ws.rubrics.gradingVersions, profiles: ws.rubrics.profiles, lock: ws.rubrics.lock, version_status: ws.rubrics.versionStatus },
      projects: data.projects,
      portfolio: {
        accounts: portfolio.loadAccounts(ws),
        assets: readJson(ws.abs('portfolio/assets.json'), {}),
        transactions: portfolio.loadTransactions(ws),
        limits: portfolio.loadLimits(ws),
        events: notes.loadEvents(ws, 'portfolio'),
        computed: data.pf,
      },
      market_data: { latest: data.latest, status: market.readStatus(ws) },
    };
  }, { timeoutMs: 60000 });
}

function tables(ws, data) {
  const txs = portfolio.loadTransactions(ws).map((t) => ({ ...t, fee: t.fee ? JSON.stringify(t.fee) : null }));
  return {
    'projects.csv': [data.projects.map((x) => ({ project_id: x.project.project_id, name: x.project.name, symbol: x.project.symbol, status: x.project.status, sector: x.project.sector ? x.project.sector.primary : null, sector_profile: x.project.sector_profile, identity_status: x.project.identity.status, coingecko_id: x.project.identity.coingecko_id, official_website: x.project.identity.official_website, on_watchlist: x.project.watchlist.on_watchlist, headline: x.project.headline ? JSON.stringify(x.project.headline) : null, created_at: x.project.created_at })), ['project_id', 'name', 'symbol', 'status', 'sector', 'sector_profile', 'identity_status', 'coingecko_id', 'official_website', 'on_watchlist', 'headline', 'created_at']],
    'reports.csv': [data.reportRows, ['project_id', 'report_id', 'provider', 'model_version', 'analysis_at', 'imported_at', 'horizon', 'rubric_version', 'sector_profile', 'verdict', 'app_grade_status', 'app_grade', 'app_grade_full_precision', 'app_grade_label', 'weight_coverage_pct', 'model_reported_overall', 'corrections', 'citation_integrity', 'original_file']],
    'scores.csv': [data.scoreRows, ['project_id', 'report_id', 'provider', 'panel', 'direction', 'id', 'status', 'value', 'low', 'high', 'rationale', 'missing_data']],
    'claims.csv': [data.claimRows, ['project_id', 'report_id', 'provider', 'claim_id', 'evidence_tag', 'text', 'metric_id', 'value', 'unit', 'period', 'definition', 'as_of', 'limitation', 'source_ids']],
    'transactions.csv': [txs, ['tx_id', 'date', 'type', 'account_id', 'asset_id', 'chain', 'quantity', 'price_usd', 'fee', 'transfer_id', 'btc_price_usd', 'external_id', 'note', 'source', 'created_at', 'voided', 'void_reason']],
    'positions.csv': [data.pf.positions.map((p) => ({ ...p, price_usd: p.price.usd, price_status: p.price.status, price_as_of: p.price.as_of || null, by_account: JSON.stringify(p.by_account), btc_relative: p.btc_relative ? JSON.stringify(p.btc_relative) : null })), ['asset_id', 'symbol', 'project_id', 'kind', 'quantity', 'in_transit_quantity', 'quarantined_quantity', 'cost_basis_known_usd', 'unknown_basis_quantity', 'cost_basis_status', 'price_usd', 'price_status', 'price_as_of', 'value_usd', 'allocation_pct', 'unrealized_known_usd', 'realized_known_usd', 'realized_unknown_quantity', 'fees_usd', 'fees_crypto_cost_usd', 'income_usd', 'closed', 'by_account', 'btc_relative']],
    'events.csv': [data.eventRows, ['scope', 'event_id', 'type', 'title', 'due_date', 'timezone', 'status', 'note', 'alert', 'created_at', 'completed_at']],
  };
}

function exportAll(ws, outDir = null) {
  const stamp = fileTs();
  const dir = outDir ? path.resolve(outDir) : path.join(ws.root, 'backups', 'exports', `export-${stamp}`);
  mkdirp(dir);
  const doc = exportJson(ws);
  fs.writeFileSync(path.join(dir, 'export.json'), jsonText(doc));
  const data = { projects: doc.projects, reportRows: [], scoreRows: [], claimRows: [], eventRows: [], pf: doc.portfolio.computed };
  const c = collect(ws);
  Object.assign(data, { reportRows: c.reportRows, scoreRows: c.scoreRows, claimRows: c.claimRows, eventRows: c.eventRows });
  for (const [name, [rows, cols]] of Object.entries(tables(ws, data))) fs.writeFileSync(path.join(dir, name), toCsv(rows, cols));
  for (const p of doc.projects) {
    for (const r of p.reports) {
      if (r.original_base64) {
        const dst = path.join(dir, 'originals', p.project.project_id, `${r.meta.report_id}${path.extname(r.meta.original_file)}`);
        mkdirp(path.dirname(dst));
        fs.writeFileSync(dst, Buffer.from(r.original_base64, 'base64'));
      }
    }
  }
  fs.writeFileSync(path.join(dir, 'README.txt'), [
    'CryptoResearch portable data export (not a backup)',
    `Exported ${doc.exported_at} from ${ws.root}`,
    doc.kind_note,
    '',
    'export.json   structured data. See "inventory" inside for what is included and what is left out.',
    '*.csv         the same data as flat tables. Text that a spreadsheet would run as a formula starts with an apostrophe.',
    'originals/    binary originals (PDF) as files, also embedded in export.json.',
    '',
    'Left out: market history, operation log and request receipts, inbox files, application code.',
    'To rebuild a workspace use the complete package (node dashboard/cli.js package) or a sealed backup.',
    'No API keys or secrets are stored in the workspace, so none are exported.',
    '',
  ].join('\r\n'));
  return { kind: 'portable_data_export', dir, files: listDir(dir), json: path.join(dir, 'export.json'), inventory: EXPORT_INVENTORY };
}

function csvTable(ws, name) {
  const data = collect(ws);
  const t = tables(ws, data);
  const key = `${name}.csv`;
  if (!t[key]) throw new OpError('INVALID', `Unknown table ${name}`);
  return toCsv(...t[key]);
}

// ---------------------------------------------------------------------------
// File inventories

const PACKAGE_INCLUDE = ['workspace.json', 'config', 'templates', 'projects', 'portfolio', 'market-data', 'inbox', 'logs'];
const BACKUP_INCLUDE = [...PACKAGE_INCLUDE, 'README.md', 'COWORK-INSTRUCTIONS.md', 'WORKSPACE-MAP.md', 'CLAUDE.md', 'package.json', 'Open Dashboard.cmd', 'Open Demo Dashboard.cmd', 'dashboard'];

function walkFiles(root, rel, out, skip) {
  const abs = path.join(root, ...rel.split('/'));
  let st;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    return;
  }
  if (st.isFile()) {
    if (!skip(rel)) out.push(rel);
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(abs).sort()) {
    const r = `${rel}/${name}`;
    if (skip(r)) continue;
    walkFiles(root, r, out, skip);
  }
}

function skipTransient(rel) {
  return /(^|\/)\.cr(\/|$)|\.tmp-\d+-|\.json\.stale-|(^|\/)dashboard\/(index|demo-workspace)(\/|$)|(^|\/)node_modules(\/|$)/.test(rel);
}

function inventoryOf(root, include) {
  const files = [];
  for (const item of include) walkFiles(root, item, files, skipTransient);
  return files;
}

// Record totals used to reconcile a restore, independent of file hashes.
function semanticSummary(ws) {
  const projects = listProjects(ws).filter((p) => !p.broken);
  const reports = [];
  let corrections = 0;
  for (const p of projects) {
    for (const r of loadReports(ws, p.project_id)) {
      if (r.broken) continue;
      corrections += r.corrections.length;
      let originalSha = null;
      try {
        originalSha = sha256(fs.readFileSync(ws.abs(`${r.dir}/${r.meta.original_file}`)));
      } catch (_) { /* missing original shows as null */ }
      reports.push({ report_id: r.report_id, project_id: p.project_id, original_sha256: originalSha });
    }
  }
  const txs = portfolio.loadTransactions(ws);
  let positions = [];
  try {
    positions = portfolio.computePortfolio(ws, { market: { assets: {} } }).positions.map((x) => ({ asset_id: x.asset_id, quantity: String(x.quantity), cost_basis_known_usd: x.cost_basis_known_usd === null ? null : String(x.cost_basis_known_usd) }));
  } catch (err) {
    positions = [{ error: err.message }];
  }
  return {
    projects: projects.length,
    reports: reports.sort((a, b) => a.report_id.localeCompare(b.report_id)),
    corrections,
    transactions: txs.length,
    transactions_active: txs.filter((t) => !t.voided).length,
    positions: positions.sort((a, b) => String(a.asset_id).localeCompare(String(b.asset_id))),
  };
}

function compareSummaries(a, b) {
  const diffs = [];
  if (a.projects !== b.projects) diffs.push(`projects ${a.projects} vs ${b.projects}`);
  if (a.corrections !== b.corrections) diffs.push(`corrections ${a.corrections} vs ${b.corrections}`);
  if (a.transactions !== b.transactions) diffs.push(`transactions ${a.transactions} vs ${b.transactions}`);
  if (JSON.stringify(a.reports) !== JSON.stringify(b.reports)) diffs.push('report originals differ');
  if (JSON.stringify(a.positions) !== JSON.stringify(b.positions)) diffs.push('positions (quantity or basis) differ');
  return diffs;
}

// ---------------------------------------------------------------------------
// Complete package

function exportPackage(ws) {
  return withLock(ws, 'package', () => {
    recoverLocked(ws);
    const files = inventoryOf(ws.root, PACKAGE_INCLUDE).map((rel) => {
      const buf = fs.readFileSync(path.join(ws.root, ...rel.split('/')));
      const text = isProbablyText(rel, buf);
      return { path: rel, bytes: buf.length, sha256: sha256(buf), encoding: text ? 'utf8' : 'base64', content: text ? buf.toString('utf8') : buf.toString('base64') };
    });
    return {
      schema_version: 'cr.package.v1',
      kind: 'complete_package',
      created_at: new Date().toISOString(),
      workspace: ws.meta,
      inventory: {
        included: PACKAGE_INCLUDE,
        omitted: ['application code and launchers (in sealed backups)', 'dashboard/index (rebuilt automatically)', '.cr (temporary lock, staging and status files)', 'backups/ and audits/'],
        files: files.length,
        bytes: files.reduce((s, f) => s + f.bytes, 0),
      },
      summary: semanticSummary(ws),
      files,
    };
  }, { timeoutMs: 60000 });
}

function isProbablyText(rel, buf) {
  if (/\.(json|jsonl|md|markdown|txt|csv|cmd|sh|js|css|html|svg)$/i.test(rel)) {
    return !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
  }
  return false;
}

// Rebuilds a workspace from a complete package into an empty folder.
function restorePackage(pkg, destDir) {
  if (!pkg || pkg.schema_version !== 'cr.package.v1' || !Array.isArray(pkg.files)) throw new OpError('INVALID', 'Not a CryptoResearch complete package (cr.package.v1).');
  const dest = path.resolve(destDir);
  if (exists(dest) && listDir(dest).length) throw new OpError('INVALID', `${dest} is not empty. Restore into a new, empty folder.`);
  mkdirp(dest);
  const bad = [];
  for (const f of pkg.files) {
    if (typeof f.path !== 'string' || f.path.split('/').some((s) => !s || s === '.' || s === '..') || /^[a-zA-Z]:|^\//.test(f.path)) {
      bad.push({ path: f.path, error: 'unsafe path' });
      continue;
    }
    const buf = f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8');
    if (sha256(buf) !== f.sha256) {
      bad.push({ path: f.path, error: 'hash mismatch in package' });
      continue;
    }
    writeDurable(path.join(dest, ...f.path.split('/')), buf);
  }
  const verify = pkg.files.filter((f) => !bad.some((b) => b.path === f.path)).filter((f) => {
    try {
      return sha256(fs.readFileSync(path.join(dest, ...f.path.split('/')))) !== f.sha256;
    } catch (_) {
      return true;
    }
  }).map((f) => f.path);
  let reconcile = null;
  try {
    const ws2 = require('./workspace').openWorkspace({ root: dest, actor: 'restore', recover: false });
    reconcile = compareSummaries(pkg.summary, semanticSummary(ws2));
  } catch (err) {
    reconcile = [`could not open restored folder: ${err.message}`];
  }
  return { status: !bad.length && !verify.length && reconcile && !reconcile.length ? 'restored_and_verified' : 'restored_with_problems', dest, files: pkg.files.length, rejected: bad, mismatched_after_write: verify, reconciliation: reconcile && reconcile.length ? reconcile : 'record totals match the package' };
}

// ---------------------------------------------------------------------------
// Sealed backups

function backupDir(ws, name) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new OpError('BAD_ID', 'Invalid backup name');
  return ws.abs(`backups/snapshots/${name}`);
}

function sealOf(items) {
  return sha256(JSON.stringify(items.map((i) => [i.path, i.bytes, i.sha256])));
}

function createBackup(ws, { reason = 'manual' } = {}) {
  const name = `${fileTs()}_${reason}`;
  const dest = backupDir(ws, name);
  const result = withLock(ws, 'backup', () => {
    recoverLocked(ws);
    const files = inventoryOf(ws.root, BACKUP_INCLUDE);
    const items = [];
    let n = 0;
    for (const rel of files) {
      const buf = fs.readFileSync(path.join(ws.root, ...rel.split('/')));
      writeDurable(path.join(dest, 'files', ...rel.split('/')), buf);
      items.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
      if (++n % 200 === 0) renewLock(ws);
    }
    const manifest = {
      schema_version: 'cr.backup.v2',
      name,
      reason,
      created_at: new Date().toISOString(),
      source_root: ws.root,
      workspace: ws.meta,
      node: process.version,
      consistent: 'Captured while holding the workspace write lock: no record write could run during the copy.',
      include: BACKUP_INCLUDE,
      excluded: ['.cr (temporary lock, staging and status files)', 'dashboard/index (derived)', 'dashboard/demo-workspace (fictional, rebuilt on demand)', 'backups/', 'audits/'],
      files: items.length,
      bytes: items.reduce((s, i) => s + i.bytes, 0),
      summary: semanticSummary(ws),
      items,
      seal: sealOf(items),
      complete: true,
    };
    writeDurable(path.join(dest, 'MANIFEST.json'), jsonText(manifest));
    writeDurable(path.join(dest, 'BACKUP-INFO.json'), jsonText({ created_at: manifest.created_at, reason, source: ws.root, files: items.length, sealed: true, restore: `node dashboard/cli.js backup restore ${name} --to <empty folder>` }));
    logOp(ws, { phase: 'backup', name, files: items.length, reason, seal: manifest.seal });
    return { name, path: dest, files: items.length, bytes: manifest.bytes, seal: manifest.seal };
  }, { timeoutMs: 60000 });
  pruneBackups(ws, { protect: [name] });
  return result;
}

function readManifest(ws, name) {
  const dir = backupDir(ws, name);
  const m = readJson(path.join(dir, 'MANIFEST.json'), null);
  return { dir, manifest: m };
}

// Full verification: every file present with its recorded hash, sealed manifest.
function verifyBackup(ws, name) {
  const { dir, manifest: m } = readManifest(ws, name);
  if (!exists(dir)) throw new OpError('NOT_FOUND', `No backup ${name}`);
  if (!m) return { name, ok: false, legacy: true, reason: 'No MANIFEST.json: an older unsealed backup. It cannot be verified file by file.' };
  if (!m.complete) return { name, ok: false, reason: 'Backup is incomplete (interrupted while copying).' };
  if (sealOf(m.items || []) !== m.seal) return { name, ok: false, reason: 'Manifest seal does not match its item list.' };
  const missing = [];
  const mismatched = [];
  for (const it of m.items) {
    const abs = path.join(dir, 'files', ...it.path.split('/'));
    if (!exists(abs)) missing.push(it.path);
    else if (sha256(fs.readFileSync(abs)) !== it.sha256) mismatched.push(it.path);
  }
  const listed = new Set(m.items.map((i) => i.path));
  const extra = [];
  const actual = [];
  for (const item of fs.existsSync(path.join(dir, 'files')) ? fs.readdirSync(path.join(dir, 'files')) : []) walkFiles(path.join(dir, 'files'), item, actual, () => false);
  for (const a of actual) if (!listed.has(a)) extra.push(a);
  return { name, ok: !missing.length && !mismatched.length, files: m.items.length, missing, mismatched, extra, created_at: m.created_at, seal: m.seal };
}

// Keeps the newest N backups plus the newest backup of each of the last M
// months. Never removes a protected backup (for example one being restored)
// or a pre-restore backup.
function pruneBackups(ws, { protect = [] } = {}) {
  const keepRecent = (ws.settings.backups && ws.settings.backups.keep_recent) || 14;
  const keepMonthly = (ws.settings.backups && ws.settings.backups.keep_monthly) || 12;
  const all = listDir(ws.abs('backups/snapshots'), { dirs: true }).sort().reverse();
  const keep = new Set([...all.slice(0, keepRecent), ...protect]);
  const months = new Map();
  for (const n of all) {
    const m = n.slice(0, 7);
    if (!months.has(m)) months.set(m, n);
  }
  [...months.values()].slice(0, keepMonthly).forEach((n) => keep.add(n));
  const removed = [];
  for (const n of all) {
    if (keep.has(n) || n.includes('pre-restore')) continue;
    try {
      rmrf(ws.abs(`backups/snapshots/${n}`));
      removed.push(n);
    } catch (_) { /* cannot delete here; kept */ }
  }
  return removed;
}

function listBackups(ws) {
  return listDir(ws.abs('backups/snapshots'), { dirs: true }).sort().reverse().map((n) => {
    const m = readJson(ws.abs(`backups/snapshots/${n}/MANIFEST.json`), null);
    const info = readJson(ws.abs(`backups/snapshots/${n}/BACKUP-INFO.json`), {});
    if (!m) return { name: n, created_at: info.created_at || null, files: info.files || null, reason: info.reason || null, sealed: false, status: 'legacy (unsealed; cannot be verified)' };
    const sealOk = m.complete && sealOf(m.items || []) === m.seal;
    return { name: n, created_at: m.created_at, files: m.files, bytes: m.bytes, reason: m.reason, sealed: true, status: sealOk ? 'sealed (run verify for a full file check)' : 'damaged manifest' };
  });
}

// Default restore: into an empty folder, then verify files and reconcile totals.
function restoreBackupTo(ws, name, destDir) {
  const v = verifyBackup(ws, name);
  if (!v.ok) throw new OpError('INVALID', `Backup ${name} did not verify: ${v.reason || `${v.missing.length} missing, ${v.mismatched.length} changed file(s)`}. Choose another backup.`);
  const { dir, manifest: m } = readManifest(ws, name);
  const dest = path.resolve(destDir);
  if (dest.toLowerCase().startsWith(path.resolve(ws.root).toLowerCase() + path.sep) || dest.toLowerCase() === path.resolve(ws.root).toLowerCase()) {
    throw new OpError('INVALID', 'Restore into a separate folder outside this workspace.');
  }
  if (exists(dest) && listDir(dest).length) throw new OpError('INVALID', `${dest} is not empty. Restore into a new, empty folder.`);
  for (const it of m.items) {
    const buf = fs.readFileSync(path.join(dir, 'files', ...it.path.split('/')));
    writeDurable(path.join(dest, ...it.path.split('/')), buf);
  }
  const mismatched = m.items.filter((it) => {
    try {
      return sha256(fs.readFileSync(path.join(dest, ...it.path.split('/')))) !== it.sha256;
    } catch (_) {
      return true;
    }
  }).map((it) => it.path);
  let reconcile;
  try {
    const ws2 = require('./workspace').openWorkspace({ root: dest, actor: 'restore', recover: false });
    reconcile = compareSummaries(m.summary, semanticSummary(ws2));
  } catch (err) {
    reconcile = [`could not open restored folder: ${err.message}`];
  }
  const report = { mode: 'clean', restored_from: name, created_at: m.created_at, dest, files: m.items.length, mismatched_after_copy: mismatched, reconciliation: reconcile.length ? reconcile : 'record totals match the backup', status: !mismatched.length && !reconcile.length ? 'restored_and_verified' : 'restored_with_problems' };
  writeDurable(path.join(dest, 'RESTORE-REPORT.json'), jsonText(report));
  logOp(ws, { phase: 'restore_clean', from: name, dest, status: report.status });
  return report;
}

// Overlay: copies a backup's files over this workspace. Later files are LEFT IN
// PLACE, so this is not point-in-time recovery. A pre-restore backup is made first.
function restoreBackupOverlay(ws, name, { confirm = false } = {}) {
  const v = verifyBackup(ws, name);
  if (!v.ok && !v.legacy) throw new OpError('INVALID', `Backup ${name} did not verify: ${v.reason || 'files missing or changed'}.`);
  if (!confirm) throw new OpError('CONFIRM', `Overlay restore copies ${name} over the current files and leaves files created later in place (not point-in-time). Re-run with --overlay --confirm. A pre-restore backup is made first. The safer default is: backup restore ${name} --to <empty folder>`);
  const pre = createBackup(ws, { reason: 'pre-restore' });
  const { dir, manifest: m } = readManifest(ws, name);
  return withLock(ws, 'restore', () => {
    let restored = 0;
    if (m) {
      for (const it of m.items) {
        if (/^dashboard\//.test(it.path) || /\.cmd$/.test(it.path)) continue; // records only; code is not overlaid
        writeDurable(ws.abs(it.path), fs.readFileSync(path.join(dir, 'files', ...it.path.split('/'))));
        restored++;
      }
    } else {
      for (const item of PACKAGE_INCLUDE) {
        const from = path.join(dir, item);
        if (!exists(from)) continue;
        fs.cpSync(from, path.join(ws.root, item), { recursive: true, force: true });
        restored++;
      }
    }
    logOp(ws, { phase: 'restore_overlay', from: name, pre_restore_backup: pre.name, restored });
    return { mode: 'overlay', restored_from: name, pre_restore_backup: pre.name, items: restored, note: 'Overlay restore: files created after the backup were left in place. This is not point-in-time recovery.' };
  }, { timeoutMs: 60000 });
}

// Point-in-time: preview first; on confirm, files that did not exist in the
// backup are MOVED to backups/quarantine/<time>/ (kept, not deleted), then the
// backup's records are copied over. Application code is not touched.
function restoreBackupPointInTime(ws, name, { confirm = false } = {}) {
  const v = verifyBackup(ws, name);
  if (!v.ok) throw new OpError('INVALID', `Backup ${name} did not verify: ${v.reason || 'files missing or changed'}.`);
  const { dir, manifest: m } = readManifest(ws, name);
  const inBackup = new Map(m.items.filter((i) => PACKAGE_INCLUDE.some((p) => i.path === p || i.path.startsWith(`${p}/`))).map((i) => [i.path, i]));
  const current = inventoryOf(ws.root, PACKAGE_INCLUDE);
  const later = current.filter((rel) => !inBackup.has(rel));
  const changed = current.filter((rel) => inBackup.has(rel) && sha256(fs.readFileSync(ws.abs(rel))) !== inBackup.get(rel).sha256);
  const missingNow = [...inBackup.keys()].filter((rel) => !current.includes(rel));
  const preview = { mode: 'point_in_time', backup: name, backup_created_at: m.created_at, files_to_quarantine: later, files_to_replace: changed, files_to_restore: missingNow };
  if (!confirm) return { ...preview, status: 'preview', note: 'Nothing changed. Re-run with --point-in-time --confirm to apply. Quarantined files are moved, not deleted.' };
  const pre = createBackup(ws, { reason: 'pre-restore' });
  return withLock(ws, 'restore', () => {
    const qdir = `backups/quarantine/${fileTs()}`;
    for (const rel of later) {
      const to = ws.abs(`${qdir}/${rel}`);
      mkdirp(path.dirname(to));
      fs.renameSync(ws.abs(rel), to);
    }
    for (const rel of [...changed, ...missingNow]) writeDurable(ws.abs(rel), fs.readFileSync(path.join(dir, 'files', ...rel.split('/'))));
    logOp(ws, { phase: 'restore_point_in_time', from: name, pre_restore_backup: pre.name, quarantined: later.length, replaced: changed.length, restored: missingNow.length, quarantine: qdir });
    return { ...preview, status: 'restored', pre_restore_backup: pre.name, quarantine_folder: qdir };
  }, { timeoutMs: 60000 });
}

// Backwards-compatible entry: restore with no mode is refused with guidance.
function restoreBackup(ws, name, { confirm = false, to = null, overlay = false, pointInTime = false } = {}) {
  if (to) return restoreBackupTo(ws, name, to);
  if (overlay) return restoreBackupOverlay(ws, name, { confirm });
  if (pointInTime) return restoreBackupPointInTime(ws, name, { confirm });
  throw new OpError('CONFIRM', `Choose how to restore ${name}: --to <empty folder> (recommended: clean, verified copy), --point-in-time [--confirm] (preview, then quarantine later files), or --overlay --confirm (copy over current files; later files stay).`);
}

module.exports = {
  exportAll, exportJson, exportPackage, restorePackage, csvTable, toCsv, csvCell,
  createBackup, listBackups, verifyBackup, restoreBackup, restoreBackupTo, restoreBackupOverlay, restoreBackupPointInTime, pruneBackups,
  semanticSummary, PROVIDERS, EXPORT_INVENTORY,
};
