'use strict';
// Locating and opening a workspace folder, path safety, settings and rubrics.

const fs = require('fs');
const path = require('path');
const { readJson, exists, mkdirp, jsonText, atomicWrite, listDir, toPosix } = require('./fsx');
const { randomId } = require('./ids');

const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const WORKSPACE_FILE = 'workspace.json';
const CODE_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = path.resolve(CODE_ROOT, '..');

const DEFAULT_SETTINGS = {
  schema_version: 1,
  server: { host: '127.0.0.1', port: 4729 },
  timezone: 'America/New_York',
  comparison: {
    spread_threshold: 20,
    date_window_days: 30,
    show_median: false,
    claim_value_tolerance_pct: 2,
    claim_same_date_days: 7,
  },
  grading: {
    rubric: 'cr-grading@1',
    discrepancy_tolerance: 1.0,
    labels: null,
  },
  freshness: { price_stale_minutes: 90, claim_stale_days: 45, report_stale_days: 60, research_stale_days: 90 },
  market_data: {
    enabled: true,
    provider: 'coingecko',
    api_base: 'https://api.coingecko.com/api/v3',
    foreground_interval_minutes: 5,
    background_interval_minutes: 60,
    observation_interval_minutes: 55,
    timeout_seconds: 20,
    max_ids_per_call: 250,
    monthly_call_budget: 7500,
    backoff_initial_minutes: 2,
    backoff_max_minutes: 60,
    max_source_age_hours: 48,
  },
  // DefiLlama fees, revenue and holders revenue of each project bound to a
  // DefiLlama entity (fundamentals.js): keyless, refreshed per project every
  // refresh_hours, a snapshot older than stale_hours shown as stale.
  fundamentals: {
    enabled: true,
    refresh_hours: 12,
    stale_hours: 36,
    timeout_seconds: 20,
    max_attempts: 2,
    monthly_request_budget: 6000,
    max_projects_per_run: 10,
    backoff_initial_minutes: 5,
    backoff_max_minutes: 360,
  },
  // GoPlus token contract flags for the contracts of each verified identity
  // (screening.js): keyless, refreshed per project every refresh_hours. Alerts
  // only on severe changes (mint, proxy, blacklist or freeze newly present, the
  // sell tax rising above sell_tax_alert_pct), kept in the review queue for
  // alert_days. packet_mode "monitor" keeps the block out of research packets
  // ("include" puts it in).
  screening: {
    enabled: true,
    refresh_hours: 168,
    stale_hours: 336,
    timeout_seconds: 20,
    max_attempts: 2,
    monthly_request_budget: 1500,
    max_contracts_per_run: 24,
    backoff_initial_minutes: 10,
    backoff_max_minutes: 720,
    sell_tax_alert_pct: 10,
    alert_days: 14,
    packet_mode: 'monitor',
  },
  rank_sources: {
    coingecko: { enabled: true, note: 'CoinGecko market-cap rank, from the same /coins/markets call as prices.' },
    coinmarketcap: { enabled: false, note: 'Optional. Needs a CoinMarketCap API key in ~/.cryptoresearch/secrets.json (coinmarketcap_api_key) and a CoinMarketCap ID on each project.' },
  },
  research: {
    default_providers: ['claude', 'chatgpt', 'gemini'],
    default_horizon: '4 months',
    max_attempts: 2,
    timeout_seconds: 600,
    max_concurrent: 1,
    max_output_tokens: 16000,
    unattended_enabled: false,
    budget: { per_run_usd: null, daily_usd: null, monthly_usd: null },
    providers: {
      claude: { model: null, input_usd_per_mtok: null, output_usd_per_mtok: null, search_usd_per_call: null, max_searches: 20 },
      chatgpt: { model: null, input_usd_per_mtok: null, output_usd_per_mtok: null, search_usd_per_call: null, max_searches: 20 },
      gemini: { model: null, input_usd_per_mtok: null, output_usd_per_mtok: null, search_usd_per_call: null, max_searches: 20 },
    },
    schedules: [],
    note: 'Research runs only when you ask, or on a schedule you configure. Paid API calls need a key, a model, prices and a budget; without them each provider falls back to a ready-to-paste prompt.',
  },
  jobs: {
    evidence_watch: {
      enabled: false,
      configured: false,
      note: 'Optional later: a dated "what changed" digest that proposes a review. It never changes grades or your thesis.',
    },
  },
  portfolio: { base_currency: 'USD', accounting_method: 'fifo_per_account' },
  inbox: { settle_seconds: 2 },
  requests: { settle_seconds: 2 },
  backups: { keep_recent: 14, keep_monthly: 12 },
  // Offsite copies of the online desk, pulled by this PC (offsite.js). The
  // backup key itself is never stored here.
  offsite: { desk_url: null, folder: null, keep_recent: 30, keep_monthly: 12 },
};

class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function deepMerge(base, over) {
  if (Array.isArray(base) || Array.isArray(over) || typeof base !== 'object' || base === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = k in base && v !== null && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function resolveRoot(root) {
  return path.resolve(root || process.env.CR_WORKSPACE || DEFAULT_ROOT);
}

// Validates a workspace-relative path. Rejects absolute paths, drive letters,
// empty segments and any '.' or '..' segment.
function safeRel(rel) {
  if (typeof rel !== 'string' || !rel) throw new WorkspaceError('BAD_PATH', 'Empty path');
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.includes('\0')) {
    throw new WorkspaceError('BAD_PATH', `Path must be relative to the workspace: ${rel}`);
  }
  const parts = norm.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new WorkspaceError('BAD_PATH', `Unsafe path: ${rel}`);
  }
  return parts.join('/');
}

// Restore paths come from a package or backup manifest, which is untrusted
// input: a valid SHA-256 seal only ties bytes to that manifest (audit V2-002).
// On top of safeRel this rejects what Windows would silently rewrite (trailing
// dots or spaces turn "..\x20" into ".."), characters Windows cannot store
// (":" also selects alternate data streams), and reserved device names.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function safeRestoreRel(rel) {
  const s = safeRel(rel);
  for (const seg of s.split('/')) {
    if (/[. ]$/.test(seg)) throw new WorkspaceError('BAD_PATH', `Unsafe path (a name ends with a dot or space, which Windows rewrites): ${rel}`);
    if (/[:*?"<>|\u0000-\u001f]/.test(seg)) throw new WorkspaceError('BAD_PATH', `Unsafe path (a character Windows cannot store in a file name): ${rel}`);
    if (WINDOWS_RESERVED.test(seg)) throw new WorkspaceError('BAD_PATH', `Unsafe path (a reserved Windows device name): ${rel}`);
  }
  return s;
}

function within(root, abs) {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  const rel = path.relative(r, a);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Checks a whole restore inventory before anything is written: every path is
// safe, stays inside each root it will be resolved against, and no two
// entries name the same target once case and Unicode form are ignored (as
// Windows would), and no file sits where another entry needs a folder.
// Returns { ok, paths (normalized, same order), rejected: [{ path, error }] }.
function checkRestoreInventory(entries, roots = []) {
  const rejected = [];
  const paths = [];
  const byKey = new Map();
  for (const e of entries) {
    const p = typeof e === 'string' ? e : e && e.path;
    let s;
    try {
      s = safeRestoreRel(p);
    } catch (err) {
      rejected.push({ path: p, error: err.message });
      paths.push(null);
      continue;
    }
    const outside = roots.find((root) => !within(root, path.join(root, ...s.split('/'))));
    if (outside) {
      rejected.push({ path: p, error: `Resolves outside ${outside}` });
      paths.push(null);
      continue;
    }
    const key = s.normalize('NFC').toLowerCase();
    if (byKey.has(key)) {
      rejected.push({ path: p, error: `Same target as ${byKey.get(key)} (names differ only in case or Unicode form)` });
      paths.push(null);
      continue;
    }
    byKey.set(key, p);
    paths.push(s);
  }
  for (const [key, original] of byKey) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      if (byKey.has(prefix)) rejected.push({ path: original, error: `Needs a folder where ${byKey.get(prefix)} is a file` });
    }
  }
  return { ok: rejected.length === 0, paths, rejected };
}

function makeAbs(root) {
  return (rel) => {
    const s = safeRel(rel);
    const abs = path.join(root, ...s.split('/'));
    const back = path.relative(root, abs);
    if (!back || back.startsWith('..') || path.isAbsolute(back)) {
      throw new WorkspaceError('BAD_PATH', `Path escapes the workspace: ${rel}`);
    }
    return abs;
  };
}

function loadSettings(root) {
  const file = readJson(path.join(root, 'config', 'settings.json'), {});
  return deepMerge(DEFAULT_SETTINGS, file);
}

function loadRubrics(root, settings) {
  try {
    return require('./rubrics').loadRubrics(root, settings);
  } catch (err) {
    if (err.code) throw new WorkspaceError(err.code, err.message);
    throw err;
  }
}

function openWorkspace({ root, actor = 'cli', recover = true } = {}) {
  const r = resolveRoot(root);
  if (!exists(r)) {
    throw new WorkspaceError('WORKSPACE_UNREACHABLE', `Workspace folder is not reachable: ${r}. Nothing was saved.`);
  }
  const markerPath = path.join(r, WORKSPACE_FILE);
  if (!exists(markerPath)) {
    throw new WorkspaceError(
      'NOT_A_WORKSPACE',
      `${r} is not a CryptoResearch workspace (no ${WORKSPACE_FILE}). Nothing was saved. If this is the right folder, run: node dashboard/cli.js init`
    );
  }
  const meta = readJson(markerPath);
  const settings = loadSettings(r);
  const ws = {
    root: r,
    meta,
    kind: meta.kind || 'real',
    actor,
    settings,
    abs: makeAbs(r),
    rel: (abs) => toPosix(path.relative(r, abs)),
    _rubrics: null,
  };
  Object.defineProperty(ws, 'rubrics', {
    get() {
      if (!this._rubrics) this._rubrics = loadRubrics(r, settings);
      return this._rubrics;
    },
  });
  ws.reloadSettings = () => {
    ws.settings = loadSettings(r);
    ws._rubrics = null;
  };
  if (recover) require('./ops').recover(ws);
  return ws;
}

const SKELETON_DIRS = [
  'templates',
  'inbox/claude/processed',
  'inbox/chatgpt/processed',
  'inbox/gemini/processed',
  'inbox/requests/processed',
  'inbox/requests/failed',
  'projects',
  'portfolio/imports',
  'portfolio/snapshots',
  'market-data/observations',
  'logs/requests',
  'backups/snapshots',
  'backups/versions',
  'config',
  'dashboard/index',
];

const DEFAULT_ASSETS = {
  schema_version: 'cr.assets.v1',
  note: 'Reference and non-project assets. Assets for researched projects come from each project identity once it is verified.',
  assets: [
    { asset_id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', coingecko_id: 'bitcoin', kind: 'btc', deployments: [] },
    { asset_id: 'usd-coin', symbol: 'USDC', name: 'USDC', coingecko_id: 'usd-coin', kind: 'stablecoin', deployments: [] },
    { asset_id: 'tether', symbol: 'USDT', name: 'Tether', coingecko_id: 'tether', kind: 'stablecoin', deployments: [] },
    { asset_id: 'usd', symbol: 'USD', name: 'US dollar cash', coingecko_id: null, kind: 'cash', deployments: [] },
  ],
};

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false });
}

// Creates any missing folders and default files. Never overwrites an existing file.
function initWorkspace(root, { kind = 'real', name = 'CryptoResearch', templatesFrom = null } = {}) {
  const r = path.resolve(root);
  mkdirp(r);
  const created = [];
  for (const d of SKELETON_DIRS) {
    const abs = path.join(r, ...d.split('/'));
    if (!exists(abs)) {
      mkdirp(abs);
      created.push(d + '/');
    }
  }
  if (templatesFrom && path.resolve(templatesFrom) !== path.join(r, 'templates')) {
    const rubricDir = path.join(r, 'templates', 'rubrics');
    if (!exists(rubricDir)) {
      copyDir(templatesFrom, path.join(r, 'templates'));
      created.push('templates/ (copied)');
    }
  }
  const files = [
    [WORKSPACE_FILE, () => ({
      workspace_format: 'cryptoresearch.workspace.v1',
      workspace_id: `ws_${randomId(10)}`,
      name,
      kind,
      created_at: new Date().toISOString(),
      timezone: 'America/New_York',
      note: 'Marks this folder as a CryptoResearch workspace. The dashboard refuses to write to a folder without this file.',
    })],
    ['config/settings.json', () => ({ schema_version: 1, note: 'Overrides for dashboard/core/workspace.js DEFAULT_SETTINGS. Only list what you change.' })],
    ['portfolio/accounts.json', () => ({ schema_version: 'cr.accounts.v1', accounts: [] })],
    ['portfolio/assets.json', () => DEFAULT_ASSETS],
    ['portfolio/transactions.json', () => ({ schema_version: 'cr.transactions.v1', accounting_method: 'fifo_per_account', transactions: [] })],
    ['portfolio/limits.json', () => ({
      schema_version: 'cr.limits.v1',
      speculative_capital_cap_usd: null,
      max_position_pct: null,
      max_sector_pct: null,
      note: 'Limits only raise flags in the dashboard. They never place or suggest trades.',
    })],
    ['portfolio/events.json', () => ({ schema_version: 'cr.events.v1', events: [] })],
  ];
  for (const [rel, make] of files) {
    const abs = path.join(r, ...rel.split('/'));
    if (!exists(abs)) {
      atomicWrite(abs, jsonText(make()));
      created.push(rel);
    }
  }
  return { root: r, created };
}

module.exports = {
  PROVIDERS,
  PROVIDER_LABELS,
  CODE_ROOT,
  DEFAULT_ROOT,
  DEFAULT_SETTINGS,
  WorkspaceError,
  resolveRoot,
  safeRel,
  safeRestoreRel,
  checkRestoreInventory,
  within,
  openWorkspace,
  initWorkspace,
  loadRubrics,
  deepMerge,
};
