#!/usr/bin/env node
'use strict';
// CryptoResearch command line. Every change goes through dashboard/core (the
// same code the dashboard uses). Add --json for machine-readable output.
// Run with no arguments for help.

const fs = require('fs');
const path = require('path');
const { openWorkspace, initWorkspace, resolveRoot, DEFAULT_ROOT, PROVIDERS } = require('./core/workspace');

const HELP = `
CryptoResearch CLI  (node dashboard/cli.js <command> ...)   add --json for JSON output

Setup and health
  init                                   create missing folders/default files (never overwrites)
  doctor                                 verify the folder with a real write, what this session can do, rubrics, server, scheduler
  capabilities                           what this session can do here (write/rename/delete, host, route)
  status                                 counts, freshness, pending work, review queue
  serve [--port 4729] [--open]           start the local dashboard (127.0.0.1 only)
  recover [--status] [--resolve [--force --reason TEXT]]   finish/roll back interrupted writes; inspect or clear a write block

Projects
  project add --name "Allora Network" [--website URL] [--symbol ALLO] [--coingecko-id ID]
              [--asset chain:contract[:standard]]... [--evidence URL]... [--evidence-note TEXT]...
              [--sector "AI/Data"] [--profile network-infrastructure@1] [--horizon "3 months"]
              [--long-term-reason TEXT]   (a horizon above the 4-month planning ceiling needs a reason)
              [--research claude,chatgpt,gemini] [--pending-identity] [--no-watchlist] [--no-prompts]
              [--utterance "spoken text"] [--allow-same-symbol] [--input file.json]
  project list | show <id> | archive <id> --reason TEXT
  project identity <id> [--website URL] [--coingecko-id ID] [--asset ...] [--evidence URL]... [--pending]
  project watch <id> on|off
  project headline <id> --report <report_id> | --decision <entry_id> | --clear
  project set <id> [--sector "PayFi"] [--tags a,b] [--symbol X] [--profile P] [--name N]
  project reviewed <id> [--note TEXT]    move your review cursor ("changes since my last review")
  prompts <id> [--providers claude,chatgpt,gemini]
  query disagreements [--category token_value_capture] [--threshold 20]

Research
  research add <id> [--providers claude,chatgpt,gemini] [--horizon "3 months"] [--same-as-last]
               [--long-term-reason TEXT] [--channel cowork] [--utterance "spoken text"]
                                         default horizon: 4 calendar months from today (position-cycle@1)
  research status <id> [<run_id>]       job states per provider
  research prompt <id> <run_id>          print the run's canonical prompt (identical for every provider)
  research cancel|retry <id> <run_id> --provider chatgpt
  research reconcile <id> <run_id> --provider P [--attempt N] (--charged-usd X | --not-charged) --reason "how you know"
                                         record what the provider charged for an uncertain attempt
  research run                           run queued API jobs now (paid only when configured, bounded and budgeted)
  research providers                     which providers can run by API, and what is missing
  scorecards [<id>]                      latest scorecard per provider
  changes [<id>] [--since 2026-09-01]    what changed since your last review

Reports
  inbox scan [--force]                   import new files from inbox/claude|chatgpt|gemini
  inbox status
  inbox assign <provider/file> --project <id> [--allow-provider-mismatch] [--run <run_id>]
  inbox set-aside <provider/file> [--reason TEXT]
  import <file> --provider chatgpt [--project <id>] [--run <run_id>]
  import-text --provider claude --project <id> --text-file <file> [--run <run_id>]
  report list <project>
  report correct <project> <report_id> --field diagnostic_scores.legitimacy --value '<json>' --reason TEXT
  compare <project>

Your notes and calendar
  note conviction <project> --text TEXT | --text-file FILE [--conviction low|medium|high]
  journal add <project> --type decision --decision watch --text TEXT [--reason R]... [--conviction medium]
  review add <project|portfolio> --due "next friday"|YYYY-MM-DD [--title TEXT]
  event add <project|portfolio> --type catalyst|unlock|alert|other --title TEXT [--due DATE]
              [--alert-kind price_below|price_above --threshold-usd N]
  event done <project|portfolio> <event_id>
  claim review <project> <report_id> <claim_id> [--check source_matches_claim] [--corroboration independently_corroborated] [--note TEXT]
  dispute add <project> --topic "category:token_value_capture" --question TEXT

Portfolio (manual or CSV; never connects to exchanges)
  account add --name "Coinbase" [--kind exchange|self_custody] [--chain C] [--public-address A]
  asset --id ID --symbol S --name N [--coingecko-id ID] [--kind token|stablecoin|btc|cash] [--decimals 18]
  tx add --type buy --account coinbase --asset huma-finance --qty 1000 --price 0.03
         [--fee 1.5 --fee-asset usd] [--date 2026-09-15] [--transfer-id ID] [--btc-price 63000] [--settle-cash] [--tx-id ID]
  tx import <file.csv> [--account default-account] [--allow-identical]
  tx void <tx_id> --reason TEXT
  limits set [--cap 5000] [--max-position-pct 25] [--max-sector-pct 50]
  portfolio show

Data, jobs and maintenance
  market refresh | market status
  market context [--refresh]             market-cycle snapshot: BTC trend, dominance, breadth (descriptive)
  market lookup "<name or ticker>"       CoinGecko listing candidates (never binds anything)
  job run [requests|inbox|market|research|snapshot|reviews|backup]... [--all-due] [--trigger scheduler]
  schedule install|status|run|remove
  requests process | requests status <request_id>
  index rebuild
  templates build                        write standalone grading appendices to templates/appendix/
  rubrics pin                            pin rubric/profile versions by SHA-256 (RUBRIC-LOCK.json)
  export [--out DIR]                     portable data export (JSON + CSV); not a backup
  package [--out FILE]                   complete package: every record file with its hash
  restore-package <FILE> --to <empty folder>
  backup create | backup list | backup verify <name>
  backup restore <name> --to <empty folder>          clean restore, verified (recommended)
  backup restore <name> --point-in-time [--confirm]  preview, then move later files to quarantine
  backup restore <name> --overlay --confirm          copy over current files; later files stay
  demo build                             build the FICTIONAL demo workspace (dashboard/demo-workspace)
  test                                   run the automated tests

Global: --workspace <path> (default: the folder that contains dashboard/)   --actor NAME
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      let key;
      let val;
      if (eq !== -1) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !(next.startsWith('--') && next.length > 2)) {
          val = next;
          i++;
        } else val = true;
      }
      key = key.replace(/-/g, '_');
      flags[key] = key in flags ? [].concat(flags[key], val) : val;
    } else pos.push(a);
  }
  return { pos, flags };
}

const list = (v) => (v === undefined ? [] : [].concat(v)).filter((x) => x !== true);
const one = (v) => (Array.isArray(v) ? v[v.length - 1] : v === true ? undefined : v);

function readTextArg(flags) {
  if (flags.text_file) return fs.readFileSync(path.resolve(one(flags.text_file)), 'utf8');
  if (flags.text !== undefined) return String(one(flags.text));
  return null;
}

function parseAssets(values) {
  return list(values).map((s) => {
    const parts = String(s).split(':');
    return { chain: parts[0], contract_address: parts[1] || null, standard: parts[2] || null };
  });
}

function parseEvidence(flags) {
  const urls = list(flags.evidence);
  const notes = list(flags.evidence_note);
  return urls.map((url, i) => ({ url, note: notes[i] || null, kind: null }));
}

function inputFile(flags) {
  if (flags.input) return JSON.parse(fs.readFileSync(path.resolve(one(flags.input)), 'utf8'));
  if (flags.input_json) return JSON.parse(one(flags.input_json));
  return {};
}

function need(v, msg) {
  if (v === undefined || v === null || v === '' || v === true) {
    const e = new Error(msg);
    e.code = 'USAGE';
    throw e;
  }
  return v;
}

async function afterWrite(ws, projectId = null) {
  const { rebuildIndex } = require('./core/indexer');
  const { serverStatus } = require('./core/doctor');
  let index = null;
  try {
    rebuildIndex(ws);
    index = { rebuilt: true, path: ws.abs('dashboard/index/index.json') };
  } catch (err) {
    index = { rebuilt: false, error: err.message };
  }
  const dashboard = await serverStatus(ws, { projectId, waitMs: projectId ? 4000 : 0 });
  const port = (dashboard && dashboard.url) || `http://127.0.0.1:${ws.settings.server.port || 4729}/`;
  return { index, dashboard, ...(projectId ? { link: `${port.replace(/\/$/, '')}/#/project/${projectId}` } : {}) };
}

async function run(argv) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, sub, ...rest] = pos;
  const root = flags.workspace ? path.resolve(one(flags.workspace)) : undefined;
  const actor = one(flags.actor) || 'cli';

  if (!cmd || cmd === 'help' || flags.help) return { _text: HELP };

  if (cmd === 'init') {
    const r = resolveRoot(root);
    const out = initWorkspace(r, { kind: one(flags.kind) || 'real', templatesFrom: r === DEFAULT_ROOT ? null : path.join(DEFAULT_ROOT, 'templates') });
    return { status: 'ok', ...out };
  }
  if (cmd === 'test') {
    const { spawnSync } = require('child_process');
    const dir = path.join(__dirname, 'tests');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).map((f) => path.join(dir, f));
    const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
    process.exitCode = r.status;
    return { _silent: true };
  }
  if (cmd === 'demo') {
    const { buildDemo } = require('./core/demo');
    return buildDemo();
  }
  if (cmd === 'restore-package') {
    const file = path.resolve(need(sub, 'restore-package <file> --to <empty folder>'));
    const dest = need(one(flags.to), '--to <empty folder> required');
    return require('./core/exporter').restorePackage(JSON.parse(fs.readFileSync(file, 'utf8')), path.resolve(dest));
  }
  if (cmd === 'serve') {
    const ws = openWorkspace({ root, actor: 'dashboard' });
    await require('./server').start(ws, { port: one(flags.port) ? Number(one(flags.port)) : undefined, open: Boolean(flags.open) });
    return { _silent: true, _keepAlive: true };
  }

  const ws = openWorkspace({ root, actor });
  const projects = require('./core/projects');
  const notes = require('./core/notes');
  const inbox = require('./core/inbox');
  const portfolio = require('./core/portfolio');

  switch (cmd) {
    case 'doctor':
      return require('./core/doctor').doctor(ws);
    case 'capabilities':
      return { ...require('./core/doctor').sessionCapabilities(ws), runtime: require('./core/doctor').runtimeInfo(ws) };
    case 'recover': {
      const ops = require('./core/ops');
      if (flags.status) return { blocked: ops.blockedState(ws), pending: ops.pendingRecovery(ws), lock: ops.lockState(ws) };
      if (flags.resolve) return ops.resolveBlock(ws, { force: Boolean(flags.force), reason: one(flags.reason) || null });
      return { status: 'ok', recovered: ops.recover(ws), blocked: ops.blockedState(ws) };
    }
    case 'status': {
      const { buildIndex } = require('./core/indexer');
      const idx = buildIndex(ws, { light: true });
      return {
        workspace: ws.root,
        kind: ws.kind,
        projects: idx.projects.length,
        watchlist: idx.projects.filter((p) => p.on_watchlist).length,
        held: idx.projects.filter((p) => p.held).length,
        reports: idx.projects.reduce((s, p) => s + (p.report_count || 0), 0),
        market: { freshness: idx.freshness.market.freshness, last_success_at: idx.freshness.market.last_success_at, last_error: idx.freshness.market.last_error },
        inbox_waiting: idx.imports.inbox.in_inbox.length,
        requests_pending: idx.imports.requests_pending.length,
        attention: idx.attention.slice(0, 15).map((a) => `[${a.severity}] ${a.title}`),
        jobs: idx.freshness.jobs.jobs,
        scheduler_last_run: idx.freshness.jobs.runner && idx.freshness.jobs.runner.last_scheduler_run_at,
      };
    }
    case 'project': {
      const f = { ...inputFile(flags) };
      if (sub === 'add') {
        const input = {
          name: one(flags.name) || f.name,
          symbol: one(flags.symbol) || f.symbol,
          aliases: list(flags.alias).length ? list(flags.alias) : f.aliases,
          official_website: one(flags.website) || f.official_website,
          coingecko_id: one(flags.coingecko_id) || f.coingecko_id,
          assets: list(flags.asset).length ? parseAssets(flags.asset) : f.assets,
          evidence: list(flags.evidence).length ? parseEvidence(flags) : f.evidence,
          unknowns: list(flags.unknown).length ? list(flags.unknown) : f.unknowns,
          sector: one(flags.sector) || f.sector,
          sector_profile: one(flags.profile) || f.sector_profile,
          sector_note: one(flags.sector_note) || f.sector_note,
          horizon: one(flags.horizon) || f.horizon,
          long_term_reason: one(flags.long_term_reason) || f.long_term_reason,
          identity_status: flags.pending_identity ? 'pending' : one(flags.identity_status) || f.identity_status,
          watchlist: flags.no_watchlist ? false : f.watchlist !== false,
          generate_prompts: !flags.no_prompts && f.generate_prompts !== false,
          utterance: one(flags.utterance) || f.utterance,
          allow_same_symbol: Boolean(flags.allow_same_symbol || f.allow_same_symbol),
          tags: f.tags,
        };
        need(input.name, 'project add needs --name');
        const r = projects.addProject(ws, input);
        let researchOut = null;
        const researchProviders = one(flags.research) || f.research;
        if (researchProviders && ['created', 'exists'].includes(r.status)) {
          researchOut = require('./core/research').createRun(ws, { project_id: r.project_id, providers: researchProviders === true ? undefined : researchProviders, horizon: input.horizon, long_term_reason: input.long_term_reason, channel: one(flags.channel) || actor, utterance: input.utterance });
        }
        return { ...r, research: researchOut ? { status: researchOut.status, run_id: researchOut.run_id, message: researchOut.message, jobs: researchOut.run && Object.fromEntries(Object.entries(researchOut.run.jobs).map(([p, j]) => [p, { state: j.state, mode: j.mode, note: j.note || null }])), prompt_path: researchOut.run && researchOut.run.prompt.path } : null, ...(await afterWrite(ws, r.project_id)) };
      }
      if (sub === 'list') {
        return projects.listProjects(ws).map((p) => ({ project_id: p.project_id, name: p.name, symbol: p.symbol, status: p.status, identity: p.identity && p.identity.status, sector: p.sector && p.sector.primary, profile: p.sector_profile, watchlist: p.watchlist && p.watchlist.on_watchlist }));
      }
      if (sub === 'show') return require('./core/indexer').projectDetail(ws, need(rest[0], 'project show <id>'));
      if (sub === 'archive') {
        const r = projects.archiveProject(ws, need(rest[0], 'project archive <id>'), one(flags.reason));
        return { status: 'archived', ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'identity') {
        const id = need(rest[0], 'project identity <id>');
        const r = projects.updateIdentity(ws, id, {
          official_website: one(flags.website),
          coingecko_id: one(flags.coingecko_id),
          assets: list(flags.asset).length ? parseAssets(flags.asset) : undefined,
          evidence: parseEvidence(flags),
          identity_status: flags.pending ? 'pending' : undefined,
        });
        return { ...r, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'watch') {
        const id = need(rest[0], 'project watch <id> on|off');
        const r = projects.setWatchlist(ws, id, (rest[1] || 'on') !== 'off');
        return { status: r.noop ? 'unchanged' : 'saved', files: r.files, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'headline') {
        const id = need(rest[0], 'project headline <id>');
        const r = projects.setHeadline(ws, id, { report_id: one(flags.report) || null, entry_id: one(flags.decision) || null, note: one(flags.note) || null, clear: Boolean(flags.clear) });
        return { status: r.noop ? 'unchanged' : 'saved', files: r.files, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'set') {
        const id = need(rest[0], 'project set <id>');
        const fields = {};
        if (one(flags.symbol)) fields.symbol = one(flags.symbol);
        if (one(flags.profile)) fields.sector_profile = one(flags.profile);
        if (one(flags.name)) fields.name = one(flags.name);
        if (one(flags.sector) || one(flags.tags)) {
          const current = projects.getProject(ws, id).sector || {};
          fields.sector = { primary: one(flags.sector) || current.primary || 'other', tags: one(flags.tags) ? String(one(flags.tags)).split(',').map((s) => s.trim()).filter(Boolean) : current.tags || [] };
        }
        const r = projects.updateProjectFields(ws, id, fields);
        return { status: r.noop ? 'unchanged' : 'saved', files: r.files, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'reviewed') {
        const id = need(rest[0], 'project reviewed <id>');
        const r = projects.markReviewed(ws, id, { note: one(flags.note) || null });
        return { status: 'saved', files: r.files, ...(await afterWrite(ws, id)) };
      }
      throw Object.assign(new Error('project add|list|show|archive|identity|watch|headline|set|reviewed'), { code: 'USAGE' });
    }
    case 'prompts': {
      const id = need(sub, 'prompts <project_id>');
      const providers = one(flags.providers) ? String(one(flags.providers)).split(',').map((s) => s.trim()) : PROVIDERS;
      const r = projects.generatePrompts(ws, id, providers);
      return { ...r, prompt_files: require('./core/prompts').listPromptFiles(ws, id), ...(await afterWrite(ws, id)) };
    }
    case 'research': {
      const research = require('./core/research');
      if (sub === 'add') {
        const id = need(rest[0], 'research add <project>');
        const r = research.createRun(ws, { project_id: id, providers: one(flags.providers), horizon: one(flags.horizon), long_term_reason: one(flags.long_term_reason), same_as_last: Boolean(flags.same_as_last), channel: one(flags.channel) || actor, utterance: one(flags.utterance) || null, force_new: Boolean(flags.force_new) });
        return { status: r.status, run_id: r.run_id, message: r.message, horizon: r.run.horizon, market_snapshot_id: r.run.evidence_packet.market_snapshot_id || null, jobs: Object.fromEntries(Object.entries(r.run.jobs).map(([p, j]) => [p, { state: j.state, mode: j.mode, note: j.note || null }])), prompt_path: r.run.prompt.path, prompt_sha256: r.run.prompt.sha256, files: r.files, verified: r.verified !== false, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'status') {
        const id = need(rest[0], 'research status <project> [<run_id>]');
        if (rest[1]) return research.loadRun(ws, id, rest[1]) || { status: 'not_found' };
        return { project_id: id, runs: research.listRuns(ws, id).map((r) => ({ run_id: r.run_id, status: r.status, created_at: r.created_at, horizon: r.horizon.text, jobs: Object.fromEntries(Object.entries(r.jobs).map(([p, j]) => [p, { state: j.state, mode: j.mode, report_id: j.report_id, error: j.error, attempts: (j.attempts || []).map((a) => { const c = research.attemptCharge(a); return { n: a.n, phase: a.phase || a.outcome || null, counted_usd: c.usd, counted_as: c.basis }; }) }])) })) };
      }
      if (sub === 'prompt') {
        const id = need(rest[0], 'research prompt <project> <run_id>');
        const runRec = research.loadRun(ws, id, need(rest[1], 'run_id required'));
        if (!runRec) throw Object.assign(new Error('No such run'), { code: 'NOT_FOUND' });
        return { _text: fs.readFileSync(ws.abs(runRec.prompt.path), 'utf8') };
      }
      if (sub === 'cancel' || sub === 'retry') {
        const id = need(rest[0], `research ${sub} <project> <run_id> --provider P`);
        const runId = need(rest[1], 'run_id required');
        const provider = need(one(flags.provider), '--provider required');
        const r = sub === 'cancel' ? research.cancelJob(ws, id, runId, provider, one(flags.reason) || null) : research.retryJob(ws, id, runId, provider);
        return { ...r, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'reconcile') {
        const id = need(rest[0], 'research reconcile <project> <run_id> --provider P (--charged-usd X | --not-charged) --reason "..."');
        const runId = need(rest[1], 'run_id required');
        const provider = need(one(flags.provider), '--provider required');
        const r = research.reconcileAttempt(ws, id, runId, provider, { attempt: one(flags.attempt) || null, charged_usd: one(flags.charged_usd), not_charged: Boolean(flags.not_charged), reason: one(flags.reason) || '' });
        return { ...r, ...(await afterWrite(ws, id)) };
      }
      if (sub === 'run') {
        const r = await research.runDueJobs(ws, { trigger: one(flags.trigger) || 'cli' });
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'providers') return { providers: research.providerStatus(ws), budget: ws.settings.research.budget, spend: research.spendSoFar(ws), unattended_enabled: ws.settings.research.unattended_enabled };
      throw Object.assign(new Error('research add|status|prompt|cancel|retry|reconcile|run|providers'), { code: 'USAGE' });
    }
    case 'scorecards': {
      const { buildIndex } = require('./core/indexer');
      const idx = buildIndex(ws);
      const pick = idx.projects.filter((p) => !sub || p.project_id === sub);
      return pick.map((p) => ({
        project_id: p.project_id,
        name: p.name,
        sector: p.sector && p.sector.label,
        identity: p.identity_status,
        grades: Object.fromEntries(PROVIDERS.map((prov) => {
          const s = p.providers[prov];
          const job = p.research && p.research.providers[prov];
          return [prov, s ? { grade: s.grade ? s.grade.display || s.grade.status : null, label: s.grade ? s.grade.label : null, status: s.grade ? s.grade.status : null, verdict: s.verdict, analysis_at: s.analysis_at, horizon: s.horizon, citation_integrity: s.citation_integrity && s.citation_integrity.status } : { grade: null, status: job ? `research ${job.state}` : 'no report' }];
        })),
        disagreements: p.comparison.flagged,
        changes_since_review: p.changes,
        link: `#/project/${p.project_id}`,
      }));
    }
    case 'changes': {
      const digest = require('./core/digest');
      const latest = require('./core/market').readLatest(ws);
      const ids = sub ? [sub] : projects.listProjects(ws).filter((p) => !p.broken && p.status !== 'archived' && p.watchlist && p.watchlist.on_watchlist).map((p) => p.project_id);
      return ids.map((id) => digest.changesSince(ws, id, { since: one(flags.since) || null, latestMarket: latest }));
    }
    case 'query': {
      if (sub !== 'disagreements') throw Object.assign(new Error('query disagreements [--category id]'), { code: 'USAGE' });
      const { buildIndex } = require('./core/indexer');
      const idx = buildIndex(ws, { light: true });
      const cat = one(flags.category);
      const threshold = one(flags.threshold) ? Number(one(flags.threshold)) : ws.settings.comparison.spread_threshold;
      const out = [];
      for (const p of idx.projects) {
        if (!p.comparison) continue;
        const rows = p.comparison.rows.filter((r) => r.spread !== null && r.spread >= threshold && (!cat || r.id === cat));
        if (rows.length) out.push({ project_id: p.project_id, name: p.name, comparable_providers: p.comparison.comparable_providers, disagreements: rows.map((r) => ({ section: r.section, id: r.id, label: r.label, spread: r.spread })) });
      }
      return {
        threshold,
        category: cat || 'any',
        note: 'Only reports with the same rubric version, profile and horizon, all analyzed within the date window, are compared. Not-applicable categories are excluded. Agreement between models is not independent corroboration.',
        projects: out,
        not_comparable: idx.projects.filter((p) => p.comparison && p.report_count > 1 && p.comparison.comparable_providers.length < 2).map((p) => ({ project_id: p.project_id, reasons: p.comparison.reasons })),
        dashboard_link: cat ? `#/compare?category=${cat}` : '#/compare',
      };
    }
    case 'inbox': {
      if (sub === 'scan') {
        const r = inbox.scanInbox(ws, { force: Boolean(flags.force) });
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'status') return inbox.inboxStatus(ws);
      if (sub === 'assign') {
        const r = inbox.assignAndRetry(ws, need(rest[0], 'inbox assign <provider/file> --project <id>'), one(flags.project), { allowProviderMismatch: Boolean(flags.allow_provider_mismatch), runId: one(flags.run) || null });
        return { ...r, ...(await afterWrite(ws, r.project_id)) };
      }
      if (sub === 'set-aside') {
        const r = inbox.setAside(ws, need(rest[0], 'inbox set-aside <provider/file>'), one(flags.reason) || null);
        return { ...r, ...(await afterWrite(ws)) };
      }
      throw Object.assign(new Error('inbox scan|status|assign|set-aside'), { code: 'USAGE' });
    }
    case 'import': {
      const file = path.resolve(need(sub, 'import <file> --provider <claude|chatgpt|gemini>'));
      const provider = need(one(flags.provider), 'import needs --provider claude|chatgpt|gemini');
      const content = fs.readFileSync(file);
      const r = inbox.importContent(ws, provider, { content, filename: path.basename(file), projectId: one(flags.project) || null, runId: one(flags.run) || null, channel: `cli (${actor})` });
      return { ...r, ...(await afterWrite(ws, r.result.project_id)) };
    }
    case 'import-text': {
      const provider = need(one(flags.provider), 'import-text needs --provider');
      const text = need(readTextArg(flags), 'import-text needs --text-file or --text');
      const r = inbox.importContent(ws, provider, { content: text, filename: one(flags.filename) || null, projectId: one(flags.project) || null, runId: one(flags.run) || null, channel: `cli (${actor})` });
      return { ...r, ...(await afterWrite(ws, r.result.project_id)) };
    }
    case 'report': {
      const { loadReports } = require('./core/reports');
      if (sub === 'list') {
        const id = need(rest[0], 'report list <project>');
        const { reportSummary } = require('./core/indexer');
        return loadReports(ws, id).map((r) => reportSummary(ws, r));
      }
      if (sub === 'correct') {
        const [pid, rid] = rest;
        need(pid, 'report correct <project> <report_id> --field F --value JSON --reason R');
        need(rid, 'report_id required');
        const raw = need(one(flags.value), '--value required (JSON)');
        let value;
        try {
          value = JSON.parse(raw);
        } catch (_) {
          value = raw;
        }
        const r = notes.addCorrection(ws, pid, rid, need(one(flags.field), '--field required'), value, need(one(flags.reason), '--reason required'));
        return { ...r, ...(await afterWrite(ws, pid)) };
      }
      throw Object.assign(new Error('report list|correct'), { code: 'USAGE' });
    }
    case 'compare': {
      const id = need(sub, 'compare <project>');
      const d = require('./core/indexer').projectDetail(ws, id);
      return { project: id, ...d.comparison };
    }
    case 'note': {
      if (sub !== 'conviction') throw Object.assign(new Error('note conviction <project> --text TEXT'), { code: 'USAGE' });
      const id = need(rest[0], 'note conviction <project>');
      const r = notes.setConvictionNote(ws, id, need(readTextArg(flags), '--text or --text-file required'), { utterance: one(flags.utterance) || null, conviction: one(flags.conviction) || null });
      return { ...r, ...(await afterWrite(ws, id)) };
    }
    case 'journal': {
      const id = need(rest[0], 'journal add <project> --type decision ...');
      const r = notes.addJournal(ws, id, { type: one(flags.type) || 'note', decision: one(flags.decision) || null, conviction: one(flags.conviction) || null, text: readTextArg(flags), reasons: list(flags.reason), linked_report_ids: list(flags.report), utterance: one(flags.utterance) || null });
      return { ...r, ...(await afterWrite(ws, id)) };
    }
    case 'review': {
      const scope = need(rest[0], 'review add <project|portfolio> --due DATE');
      const r = notes.addEvent(ws, scope, { type: 'review', title: one(flags.title) || 'Review thesis', due: need(one(flags.due), '--due required'), note: one(flags.note) || null, utterance: one(flags.utterance) || null });
      return { ...r, ...(await afterWrite(ws, scope === 'portfolio' ? null : scope)) };
    }
    case 'event': {
      if (sub === 'done') {
        const r = notes.updateEventStatus(ws, need(rest[0], 'event done <scope> <event_id>'), need(rest[1], 'event_id required'), one(flags.status) || 'done');
        return { ...r, ...(await afterWrite(ws)) };
      }
      const scope = need(rest[0], 'event add <project|portfolio> --type T --title X');
      const r = notes.addEvent(ws, scope, { type: need(one(flags.type), '--type required'), title: one(flags.title), due: one(flags.due) || null, note: one(flags.note) || null, alert_kind: one(flags.alert_kind), threshold_usd: one(flags.threshold_usd), utterance: one(flags.utterance) || null });
      return { ...r, ...(await afterWrite(ws)) };
    }
    case 'claim': {
      const [pid, rid, cid] = rest;
      const r = notes.reviewClaim(ws, need(pid, 'claim review <project> <report_id> <claim_id>'), need(rid, 'report_id'), need(cid, 'claim_id'), { dashboard_check: one(flags.check) || null, corroboration: one(flags.corroboration) || null, corroboration_sources: list(flags.source), note: one(flags.note) || null });
      return { ...r, ...(await afterWrite(ws)) };
    }
    case 'dispute': {
      const pid = need(rest[0], 'dispute add <project> --question TEXT');
      const r = notes.addDispute(ws, pid, { topic: one(flags.topic) || null, question: one(flags.question), dispute_id: one(flags.id) || null, status: one(flags.status) || 'open', resolution: one(flags.resolution) || null });
      return { ...r, ...(await afterWrite(ws)) };
    }
    case 'account': {
      const r = portfolio.addAccount(ws, { account_id: one(flags.id) || null, name: need(one(flags.name), '--name required'), kind: one(flags.kind) || 'exchange', chain: one(flags.chain) || null, public_address: one(flags.public_address) || null, note: one(flags.note) || null });
      return { ...r, ...(await afterWrite(ws)) };
    }
    case 'asset': {
      const r = portfolio.addAsset(ws, { asset_id: need(one(flags.id), '--id required'), symbol: one(flags.symbol), name: one(flags.name), coingecko_id: one(flags.coingecko_id) || null, kind: one(flags.kind) || 'token', decimals: one(flags.decimals) !== undefined ? Number(one(flags.decimals)) : 18 });
      return { ...r, ...(await afterWrite(ws)) };
    }
    case 'tx': {
      if (sub === 'add') {
        const fee = one(flags.fee) !== undefined ? { amount: String(one(flags.fee)), asset_id: one(flags.fee_asset) || 'usd' } : null;
        const r = portfolio.addTransactions(ws, [{
          tx_id: one(flags.tx_id) || null,
          type: need(one(flags.type), '--type required'),
          date: one(flags.date) || new Date().toISOString(),
          account_id: need(one(flags.account), '--account required'),
          asset_id: need(one(flags.asset), '--asset required'),
          quantity: need(one(flags.qty) || one(flags.quantity), '--qty required'),
          price_usd: one(flags.price) !== undefined ? String(one(flags.price)) : null,
          fee,
          transfer_id: one(flags.transfer_id) || null,
          btc_price_usd: one(flags.btc_price) || null,
          settle_cash: Boolean(flags.settle_cash),
          external_id: one(flags.external_id) || null,
          note: one(flags.note) || null,
        }], { source: 'manual' });
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'import') {
        const file = path.resolve(need(rest[0], 'tx import <file.csv>'));
        const r = portfolio.importCsv(ws, fs.readFileSync(file, 'utf8'), { filename: path.basename(file), defaultAccount: one(flags.account) || null, allowIdentical: Boolean(flags.allow_identical) });
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'void') {
        const r = portfolio.voidTransaction(ws, need(rest[0], 'tx void <tx_id> --reason R'), need(one(flags.reason), '--reason required'));
        return { ...r, ...(await afterWrite(ws)) };
      }
      throw Object.assign(new Error('tx add|import|void'), { code: 'USAGE' });
    }
    case 'limits': {
      const r = portfolio.setLimits(ws, { speculative_capital_cap_usd: one(flags.cap), max_position_pct: one(flags.max_position_pct), max_sector_pct: one(flags.max_sector_pct) });
      return { ...r, ...(await afterWrite(ws)) };
    }
    case 'portfolio': {
      const market = require('./core/market');
      return portfolio.computePortfolio(ws, { market: market.readLatest(ws) });
    }
    case 'market': {
      const market = require('./core/market');
      if (sub === 'refresh') {
        const r = await market.refresh(ws, { trigger: one(flags.trigger) || 'cli', force: true });
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'lookup') {
        // Candidates only. Confirm the token on the official site before binding it.
        const q = [...rest, one(flags.query)].filter(Boolean).join(' ');
        return market.searchCoins(ws, q);
      }
      if (sub === 'context') {
        // Market-cycle snapshot: BTC trend, dominance and breadth (descriptive only).
        const cycle = require('./core/cycle');
        const refreshed = flags.refresh ? await cycle.refreshContext(ws, { trigger: one(flags.trigger) || 'cli', force: true }) : null;
        const s = cycle.summary(ws);
        return { ...(refreshed ? { refresh: refreshed } : {}), status: s.status, freshness: s.freshness, line: cycle.describe(cycle.readContext(ws)), snapshot: cycle.readContext(ws), ...(refreshed && refreshed.status === 'ok' ? await afterWrite(ws) : {}) };
      }
      return { status: market.freshness(ws), tracked: market.trackedIds(ws), latest: market.readLatest(ws), context: require('./core/cycle').summary(ws) };
    }
    case 'job': {
      const jobs = require('./core/jobs');
      const names = [sub, ...rest].filter(Boolean).filter((n) => n !== 'run');
      const trigger = one(flags.trigger) || 'cli';
      const results = await jobs.runJobs(ws, names, { trigger, onlyDue: Boolean(flags.all_due) });
      const wrote = results.some((r) => !['noop', 'not_due', 'skipped', 'busy', 'backoff'].includes(r.status));
      return { trigger, node: process.version, host: require('os').hostname(), results, ...(wrote ? await afterWrite(ws) : {}) };
    }
    case 'schedule': {
      const schedule = require('./core/schedule');
      if (sub === 'install') return schedule.install(ws, { minutes: one(flags.minutes) ? Number(one(flags.minutes)) : 60 });
      if (sub === 'remove') return schedule.remove();
      if (sub === 'run') return schedule.runNow();
      return schedule.status(ws);
    }
    case 'requests': {
      const requests = require('./core/requests');
      if (sub === 'status') return requests.requestStatus(ws, need(rest[0], 'requests status <request_id>'));
      const r = requests.processRequests(ws);
      return { ...r, ...(r.processed ? await afterWrite(ws) : {}) };
    }
    case 'index': {
      const { rebuildIndex, INDEX_REL } = require('./core/indexer');
      const idx = rebuildIndex(ws);
      return { status: 'rebuilt', path: ws.abs(INDEX_REL), projects: idx.projects.length, build_ms: idx.build_ms };
    }
    case 'templates': {
      // Writes a ready-to-append grading appendix for every sector profile.
      const { buildAppendixV2 } = require('./core/prompts');
      const { runOp } = require('./core/ops');
      const out = runOp(ws, { type: 'build_appendices', summary: 'Build standalone grading appendices' }, (op) => {
        for (const profile of Object.values(ws.rubrics.profiles)) {
          op.write(`templates/appendix/grading-appendix.${profile.profile_id}.v${profile.version}.prompt-v2.md`, buildAppendixV2(ws, profile, {}));
        }
      });
      return { status: out.noop ? 'unchanged' : 'built', files: out.files.map((f) => f.rel) };
    }
    case 'rubrics': {
      if (sub !== 'pin') throw Object.assign(new Error('rubrics pin'), { code: 'USAGE' });
      return require('./core/rubrics').pinRubrics(ws);
    }
    case 'export':
      return require('./core/exporter').exportAll(ws, one(flags.out) || null);
    case 'package': {
      const pkg = require('./core/exporter').exportPackage(ws);
      const out = path.resolve(one(flags.out) || path.join(ws.root, 'backups', 'exports', `cryptoresearch-package-${require('./core/ids').fileTs()}.json`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(pkg));
      return { kind: 'complete_package', file: out, files: pkg.inventory.files, bytes: pkg.inventory.bytes, omitted: pkg.inventory.omitted, restore: `node dashboard/cli.js restore-package "${out}" --to <empty folder>` };
    }
    case 'backup': {
      const ex = require('./core/exporter');
      if (sub === 'create') return ex.createBackup(ws, { reason: 'manual' });
      if (sub === 'list') return ex.listBackups(ws);
      if (sub === 'verify') return ex.verifyBackup(ws, need(rest[0], 'backup verify <name>'));
      if (sub === 'restore') {
        const name = need(rest[0], 'backup restore <name> --to <empty folder> | --point-in-time [--confirm] | --overlay --confirm');
        const r = ex.restoreBackup(ws, name, { to: one(flags.to) ? path.resolve(one(flags.to)) : null, overlay: Boolean(flags.overlay), pointInTime: Boolean(flags.point_in_time), confirm: Boolean(flags.confirm) });
        return { ...r, ...(r.mode !== 'clean' && r.status !== 'preview' ? await afterWrite(ws) : {}) };
      }
      throw Object.assign(new Error('backup create|list|verify|restore'), { code: 'USAGE' });
    }
    default:
      throw Object.assign(new Error(`Unknown command "${cmd}". Run with no arguments for help.`), { code: 'USAGE' });
  }
}

function human(out) {
  if (out && out._text) return out._text;
  return JSON.stringify(out, (k, v) => (k === 'raw_json' ? undefined : v), 2);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  run(argv.filter((a) => a !== '--json'))
    .then((out) => {
      if (out && out._silent) return;
      process.stdout.write(`${asJson && !(out && out._text) ? JSON.stringify(out, null, 2) : human(out)}\n`);
      if (out && ['possible_duplicate', 'failed', 'needs_project', 'prompt', 'provider_mismatch', 'rejected', 'conflict'].includes(out.status)) process.exitCode = 2;
    })
    .catch((err) => {
      // These errors are raised before anything is committed.
      const beforeCommit = ['USAGE', 'INVALID', 'BAD_ID', 'BAD_PATH', 'NOT_FOUND', 'REFUSED', 'CONFLICT', 'CONFIRM', 'WORKSPACE_UNREACHABLE', 'NOT_A_WORKSPACE', 'WORKSPACE_BUSY', 'ALREADY_EXISTS', 'WRITES_BLOCKED', 'IDEMPOTENCY_CONFLICT', 'AMBIGUOUS', 'UNSAFE_PATH', 'GENERATION_UNWRITABLE'].includes(err.code);
      const payload = { status: 'error', code: err.code || 'ERROR', error: err.message, saved: beforeCommit ? false : 'unknown' };
      if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stderr.write(`Error (${payload.code}): ${err.message}\n${beforeCommit ? 'Nothing was saved by this command.' : 'The command did not finish. Run "node dashboard/cli.js status" to see what was saved.'}\n`);
      process.exitCode = err.code === 'USAGE' ? 64 : 1;
    });
}

module.exports = { run, parseArgs };
