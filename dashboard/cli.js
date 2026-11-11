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
  prove-autonomy r0|b0|b1|b2|b3|cutover --desk=online [--project ID] [--out DIR]
                 [--evidence DIR] [--offline] [--fixture] [--base SHA]
                 [--mode development|post-merge] [--expected-revision SHA]
                                         read-only evidence verifier; writes a new report bundle only
  prove-autonomy r0|b0 --template --evidence=DIR
                                         blank forms and the exact commands for you to run; runs none
  prove-autonomy <step> --seal --baseline=SHA --evidence=DIR
                                         close a filled folder with its manifest; judges nothing
  serve [--port 4729] [--open]           start the local dashboard (127.0.0.1 only)
  recover [--status] [--resolve [--force --reason TEXT]]   finish/roll back interrupted writes; inspect or clear a write block

Projects
  project add --name "Allora Network" [--website URL] [--symbol ALLO] [--coingecko-id ID]
              [--asset chain:contract[:standard]]... [--evidence URL]... [--evidence-note TEXT]...
              [--sector "AI/Data"] [--profile network-infrastructure@2] [--horizon "3 months"]
              [--long-term-reason TEXT]   (a horizon above the 4-month planning ceiling needs a reason)
              [--research claude,chatgpt,gemini] [--pending-identity] [--no-watchlist] [--no-prompts]
              [--utterance "spoken text"] [--allow-same-symbol] [--input file.json]
              [--defillama-slug S --defillama-scope product|parent|chain --defillama-source URL]
  project list | show <id> | archive <id> --reason TEXT | restore <id>
  project identity <id> [--website URL] [--coingecko-id ID] [--asset ...] [--evidence URL]... [--pending]
                    [--native-chain | --no-native-chain]   state that the token is (or is not) its chain's
                                         own coin; never inferred from a missing contract
  project identity <id> --defillama-slug S --defillama-scope product|parent|chain --defillama-source URL [--no-refresh]
                                         bind the DefiLlama entity whose fees describe the project (verified
                                         from the source URL; never by name or ticker), then fetch it once
  project identity <id> --no-defillama   remove that binding
  project watch <id> on|off
  project headline <id> --report <report_id> | --decision <entry_id> | --clear
  project set <id> [--sector "PayFi"] [--tags a,b] [--symbol X] [--profile P] [--name N]
              [--chart-symbol BINANCE:ONDOUSDT | --chart-symbol none]   the inspector's TradingView chart
  project reviewed <id> [--note TEXT]    move your review cursor ("changes since my last review")
  prompts <id> [--providers claude,chatgpt,gemini]
  query disagreements [--category token_value_capture] [--threshold 20]

Research
  research add <id> [--providers claude,chatgpt,gemini] [--horizon "3 months"] [--same-as-last]
               [--long-term-reason TEXT] [--channel cowork] [--utterance "spoken text"]
               [--refresh] [--allow-pending-identity]
                                         default horizon: 4 calendar months from today (position-cycle@1)
                                         needs a verified identity (--allow-pending-identity only on
                                         Eric's word); a model with an open job, or a report in the
                                         last 24 h (unless --refresh), is left out
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

Forensics & Resilience (no paid model call; Claude investigates, ChatGPT may challenge; Gemini has no role)
  forensics view <id>                    the Forensics tab's read model (writes nothing)
  forensics quote-candidates [--limit 15] [--dry-run] [--json]   ask the $500 and $2,000 exit quotes for pilot candidates graded 40+ with no current reading (approved chains only; never approves one)
  forensics start <id> [--challenge] [--channel cowork] [--focus TEXT] [--restart] [--refresh]
                                         open (or resume) a forensic audit: frozen prompt and evidence packet
  forensics prompt <id> <audit_id> [--role challenge]   print a role's frozen prompt
  forensics import <id> <audit_id> --provider claude|chatgpt --text-file FILE
                   [--revision-kind format_fix|reassessment|new_evidence|other --revision-note TEXT]
  forensics challenge <id> <audit_id>    ask ChatGPT to challenge the latest assessment
  forensics cancel <id> <audit_id> [--reason TEXT]
  forensics monitor <id> [--approve <receipt_id> [--check URL]... [--repo owner/repo]...] [--quote <chain_id:contract>]...
                   [--remove <target_id>]... [--on | --off]
                                         Eric's opt-in: approve proposed targets and exit-quote chains (keys from
                                         forensics view: monitoring.proposed.exit_quotes), then turn monitoring on
  forensics run [<id>] [--force]         product checks, repository reads, exit quotes and due checkpoint outcomes now
  forensics correct <id> <receipt_id> --checkpoint 30d --event delivery_inactivity --outcome unresolved --reason TEXT
                                         a recorded outcome is never rewritten: this appends a correction
  forensics case <id> <receipt_id> [--out FILE]
                                         one receipt as a verifiable case package (originals, pins, observations,
                                         one replayable exit calculation, what is missing); reads only
  forensics case-verify --file FILE      checks a case package offline and replays its calculation (no network)

Contract state (read-only chain reads at a finalized block; nothing is read while your caps are unset)
  contracts status                       caps, compute units used, the gate, networks, and contracts on unread chains (writes nothing)
  contracts show <id>                    the stored observations of a project's contracts (writes nothing, asks nothing)
  contracts observe <id> [--dry-run]     observe each contract now; --dry-run prints the planned reads and compute units, sends nothing
  contracts probe [<chain_id>]           what a network answers (finalized tag, block-hash pinning), recorded; none named: every unprobed chain your projects need
  contracts init-defaults [--dry-run]    add the published Uniswap V2/V3 factories, Safe singletons and network-fee ceilings; yours are kept
  arm-desk [--desk=online] [--dry-run] [--daily-cu=N --monthly-cu=N] [--allow=SYM/USDC,...] [--intent-life=MIN] [--contracts-on]
           [--mandate-days=N | --mandate-off] [--admission-days=N [--admission-daily=N] | --admission-off] [--print-schedule]
                                         the paper desk's baseline settings (scout leads, automatic exit quotes, Paper Book, trader rules,
                                         the floor for a new entry at 50); --contracts-on needs both caps; --mandate-days=N (1-30) turns the
                                         paper mandate on; --admission-days=N (1-30) arms automatic admission of ELIGIBLE scout leads
                                         (--admission-daily 0-3 a day, default 1; the mandate flags never do); --mandate-off and
                                         --admission-off are off-only, alone or together: they write only those switches (and revoke the
                                         authority in force), nothing else, and refuse any other flag beside them; --desk=online prints what to
                                         paste into the signed-in desk's browser console;
                                         --print-schedule prints the pilot-task.ps1 commands that register pilot-all every 30 minutes (never runs them)

PM trade tickets (Claude researches, Claude prosecutes; the desk sizes; you decide, or the paper mandate grants inside a generation you armed; paper orders only, never a real one)
  paper [--json]                         the paper book: PM-approved tickets as paper positions, apart from the portfolio (writes nothing)
  tickets candidates [--json]           who could go in the pilot: held first, then by grade, with today's gate (writes nothing)
  tickets auto-pilot-sync [--min 45] [--dry-run] [--json]   opt in verified projects whose current Claude report is cr-research-prompt@6 graded 45+ (never opts out)
  tickets digest [--days 7] [--json]    the week's pilot in numbers: @6 reports, Prosecutor tickets against desk gates, grade spreads, fired triggers, provider budget (writes nothing; an unreadable part is said, never zero)
  tickets run-cycle [--limit 10] [--dry-run] [--json]   the Track 2 pipeline in one pass: auto-pilot-sync, batch-gate, exit quotes for candidates (up to --limit), then the pilot queue; one receipt with the counts and the next steps for Agent 1 and Agent 2 (no model, no order)
  tickets decide-gates --action pass|watch [--dry-run] [--request-id <id>] [--note <text>] [--json]   decide every desk-gate card waiting for you, one decision each (pass archives unheld projects; held ones never)
  tickets batch-gate [--below 40] [--dry-run] [--json]   desk gate receipts for every unheld, verified project graded under 40 (no exit quote, no Prosecutor, no model)
  tickets exit-matrix [--json]         every verified active project by grade: exit cost at each of your exit sizes (Preferences > Screening), completeness, chain, quote age, native L1 status (writes nothing)
  tickets basis <id> <decision_id> [--json]   what a decision stood on (cr.decision-basis.v1), the basis itself and each record it names checked by their SHA-256 (the basis's own in the project's digest ledger; a digest missing, null or malformed is refused; a report original that carried none at the decision reads "unverified"), beside its execution in the trader's book, read through the book's own integrity checks (a journal it refuses reads "integrity", with no values); a decision from before it reads "reconstructed", and a basis written before the ledger "unverified"; a veto, an Undo or a pass that archives whose basis could not be built reads "unavailable" (writes nothing)
  tickets reconcile [<id>] [--dry-run] [--json]   complete a recorded decision's missing paper position or journal entry (never archives, voids or edits a decision)
  tickets queue [<id>]                   the autonomous pilot's next step per project (research, ticket, your review)
  tickets claim|bind|release <id>        the pilot runner's one execution claim per project (release --reconciled --attempt <pa_…> after an expired dispatch you checked)
  tickets pilot <id> --on|--off          put a project in the autonomous pilot (your opt-in)
  tickets start <id> [--refresh] [--reopen] [--restart] [--force-prosecution] [--assistant]
                                         open (or resume) the Prosecutor's ticket on Claude's current report
  tickets prompt <id> <ticket_id>        print the frozen Prosecutor prompt (cr-ticket-prompt@1)
  tickets import <id> <ticket_id> --text-file FILE [--revision-note TEXT]
  brief daily [--json] [--since ISO]                     the daily brief (cr-daily-brief@2): what needs you today, each line with its #/ link, the SHA-256 of its text (writes nothing)
  brief attention                                        the one attention contract (cr-attention@1): PM decisions, exceptions with their recovery action, progress since yesterday (writes nothing)
  tickets view <id> [--receipt tr_…] [--include-text]  the ticket in force (or that receipt): status, desk sizing, invalidation with every check, history (writes nothing)
  tickets decide <id> <receipt_id> --action approve|halve|veto|pass|watch|trim|reopen|undo [--note TEXT]
  tickets cancel <id> <ticket_id> [--reason TEXT]
  npm run pilot -- --project=<id> [--desk local|online] [--dry-run]
                                         the whole chain with Claude Code (claude -p) on your subscription

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
  portfolio set-cost <asset> --account ID --avg-cost-usd X [--acquired-at DATE] [--tx-id ID] [--reason TEXT]
  limits set [--cap 5000] [--max-position-pct 25] [--max-sector-pct 50]
  portfolio show

Tracked wallets (public addresses, read-only through Alchemy, twice daily; key in ALCHEMY_API_KEY, never here)
  wallet add --label "MetaMask" --address 0x... --networks eth,base [--account ID]
                                         never a private key or seed phrase; nothing is scanned
                                         without networks; the first read is not a purchase
  wallet list | wallet status            sync state per network | holdings, activity, reconciliation
  wallet sync [<wallet_id>]              read now (same lease, rate limit and compute-unit budget)
  wallet pause|resume <wallet_id>
  wallet remove <wallet_id> [--reason TEXT]   stops following; events and ledger entries stay
  wallet networks <wallet_id> --networks eth,base
  wallet resolve <wallet_id> <network> <event_key> --record | --skip [--note TEXT]
                                         your decision on a held import ("--skip" = already recorded)

Data, jobs and maintenance
  market refresh | market status
  market context [--refresh]             market-cycle snapshot: BTC trend, dominance, breadth (descriptive)
  market lookup "<name or ticker>"       CoinGecko listing candidates (never binds anything)
  fundamentals refresh [<id>...]         fetch DefiLlama fees, revenue and holders revenue now (bound projects)
  fundamentals status [<id>]             saved fundamentals: state, window, totals and coverage
  screen refresh [<id>...]               GoPlus contract flags now (contracts of verified identities;
                                         skips the failure backoff, never GoPlus's rate limit)
  screen status [<id>]                   saved contract screens: flags, taxes, alerts, what is not screenable
  job run [requests|inbox|market|fundamentals|screening|wallets|forensics|research|snapshot|reviews|backup|offsite]... [--all-due] [--trigger scheduler]
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
  trader bootstrap --cash-usd N --confirm "FUND NEW PAPER BOOK N"
                                         Eric's first funding of a new Paper Book; nothing routine can do it
  offsite setup --desk https://<desk> [--to FOLDER]  pull verified copies of the online desk to this PC (daily)
  offsite pull [--to FOLDER] | offsite status | offsite verify <FILE>
  offsite drill [<FILE>] [--to <empty folder>]
                                         verify the latest pulled copy (or FILE), restore it into a new
                                         folder, check records, originals and research state; no provider
                                         is asked for anything (the restored copy holds research)
  scout list | scout status              Grok Scout's items and its last brief (read only)
  scout leads list | scout leads status <delivery_id>
                                         Grok Scout's leads and one delivery's outcome (read only)
  scout leads run | scout leads receipt <receipt_id>
                                         One eligibility turn (CoinGecko listing + GoPlus screen,
                                         at most 5 leads, 10 requests, 20 s); one receipt
  restored-copy status | restored-copy hold --confirm --from <what was restored> | restored-copy release --confirm [--accept <decision_id>]...
                                         a restored copy holds research until released here
                                         the backup key is CR_BACKUP_KEY on the desk and on this PC
                                         (or "desk_backup_key" in ~/.cryptoresearch/secrets.json)
  explorer status                        the optional Research Explorer (Supabase): set-up and a live read;
                                         never shows the key
  explorer configure --url https://<ref>.supabase.co | --off | --on
                                         the project URL (the secret key goes in CR_SUPABASE_SECRET_KEY or
                                         "supabase_secret_key" in ~/.cryptoresearch/secrets.json)
  explorer export --fixtures [--dry-run] [--complete-existing]
                                         send the FICTIONAL demo records one way to Supabase; repeatable,
                                         nothing duplicated, changed content refused; --complete-existing
                                         also adds, once, the exact order and values that reports stored
                                         before 2026-10-07 lack (only where they agree with what is stored)
  explorer export --project <id> --dry-run
                                         preview one real project: the exact request body, its SHA-256
                                         hashes, the destination and its confirm_sha256; no network,
                                         nothing written
  explorer export --project <id> --confirm <confirm_sha256>
                                         send that one project, from your own terminal: only the exact
                                         bytes the preview showed, to its destination; any change since
                                         sends nothing
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

// --native-chain / --no-native-chain: true, false, or undefined (not given,
// so the identity keeps what it states). Never inferred.
function nativeChainFlag(flags) {
  if (flags.no_native_chain) return false;
  if (flags.native_chain === undefined) return undefined;
  const v = flags.native_chain === true ? true : String(one(flags.native_chain)).toLowerCase();
  if (v === true || v === 'true' || v === 'yes') return true;
  if (v === 'false' || v === 'no') return false;
  throw Object.assign(new Error('--native-chain takes no value (or true / false)'), { code: 'USAGE' });
}

// The DefiLlama binding the flags ask for: undefined (none given), null
// (--no-defillama) or { slug, scope, source_url }, validated by the core.
function defillamaFlags(flags) {
  if (flags.no_defillama) return null;
  const slug = one(flags.defillama_slug);
  const scope = one(flags.defillama_scope);
  const source = one(flags.defillama_source);
  if (slug === undefined && scope === undefined && source === undefined) return undefined;
  return { slug, scope, source_url: source };
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

// N2 (post-remediation audit, 2026-11-02): the local pilot runner saves a
// session's answer through this CLI under its claim (--token). Eric's stop is
// then asked inside the save's own locked operation (pilot-claims stopGuard),
// as the worker's complete is (pilot-worker.js), so a stop that lands after
// the runner's `tickets check` and before the commit leaves nothing saved: an
// inbox copy is set aside, the claim is let go as stopped, and the answer is
// { status: 'stopped', saved: false } with the stop's words. Without --token
// the import is unchanged. null when no token is given.
function claimedSave(ws, flags, usage) {
  const token = one(flags.token);
  if (token === undefined) return null;
  const pid = need(one(flags.project), usage);
  const PC = require('./core/pilot-claims');
  return {
    guard: () => PC.stopGuard(ws, pid),
    stopped(err) {
      if (!err || err.code !== 'STOPPED' || !(err.details && err.details.stop_guard)) throw err;
      const key = err.details.inbox_key;
      if (key && fs.existsSync(ws.abs(`inbox/${key}`))) require('./core/inbox').setAside(ws, key, `Eric's stop landed before this answer was saved. ${err.message}`);
      const after = PC.stopIfHalted(ws, pid, token);
      if (after.status !== 'stopped') throw err;
      return { status: 'stopped', saved: false, verified: false, project_id: pid, code: after.code || err.details.gate_code || null, words: after.words, message: `Not saved: ${after.words}`, claim: after.claim };
    },
  };
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

  // Before openWorkspace: even opening it normally may recover interrupted writes.
  if (cmd === 'prove-autonomy') {
    if (rest.length) throw Object.assign(new Error('prove-autonomy accepts exactly one step.'), { code: 'USAGE' });
    if (flags.template || flags.seal) return require('./core/proof-capture').command(sub, flags);
    return require('./core/autonomy-proof').command(sub, flags);
  }

  if (cmd === 'init') {
    const r = resolveRoot(root);
    const out = initWorkspace(r, { kind: one(flags.kind) || 'real', templatesFrom: r === DEFAULT_ROOT ? null : path.join(DEFAULT_ROOT, 'templates') });
    return { status: 'ok', ...out };
  }
  if (cmd === 'test') {
    const { spawnSync } = require('child_process');
    const { withoutGithubCredentials } = require('./core/child-env');
    const launch = require('./core/test-launch');
    const dir = path.join(__dirname, 'tests');
    const sim = path.join(dir, 'sim');
    const files = [dir, sim].filter((d) => fs.existsSync(d)).flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith('.test.js')).map((f) => path.join(d, f)));
    // A run that started no test, or did not finish, is never a pass
    // (core/test-launch.js): it exits 1 and says why. Otherwise the runner's
    // own exit code, as before.
    const refused = launch.refusal(files, process.env);
    const r = refused ? null : spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: withoutGithubCredentials(process.env) });
    const out = refused || launch.outcome(files, r);
    if (out.words) console.error(out.words);
    process.exitCode = out.code;
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
      // The explicit diagnostic: it includes the write test and the GitHub access
      // read, which asks GitHub only for a real workspace. The desk's /api/doctor
      // has neither, so a web request never starts gh.
      return require('./core/doctor').doctor(ws, { writeProbe: true, credentials: () => {
        const { readGithubAccess, credentialLine } = require('./core/child-env');
        return credentialLine(readGithubAccess({ sessionEnv: require('./scripts/pilot').launchEnv, network: ws.kind === 'real' }));
      } });
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
          defillama: defillamaFlags(flags) || f.defillama || undefined,
          native_chain: nativeChainFlag(flags) !== undefined ? nativeChainFlag(flags) : f.native_chain,
        };
        need(input.name, 'project add needs --name');
        const r = projects.addProject(ws, input);
        let researchOut = null;
        const researchProviders = one(flags.research) || f.research;
        if (researchProviders && ['created', 'exists'].includes(r.status)) {
          // The project is saved either way; research the desk refuses to start is said.
          try {
            researchOut = require('./core/research').createRun(ws, { project_id: r.project_id, providers: researchProviders === true ? undefined : researchProviders, horizon: input.horizon, long_term_reason: input.long_term_reason, channel: one(flags.channel) || actor, utterance: input.utterance });
          } catch (err) {
            if (!err.code) throw err;
            researchOut = { status: 'not_started', run_id: null, message: err.message, run: null };
          }
        }
        return { ...r, research: researchOut ? { status: researchOut.status, run_id: researchOut.run_id, message: researchOut.message, jobs: researchOut.run && Object.fromEntries(Object.entries(researchOut.run.jobs).map(([p, j]) => [p, { state: j.state, mode: j.mode, note: j.note || null }])), prompt_path: researchOut.run && researchOut.run.prompt.path } : null, ...(await afterWrite(ws, r.project_id)) };
      }
      if (sub === 'list') {
        return projects.listProjects(ws).map((p) => ({ project_id: p.project_id, name: p.name, symbol: p.symbol, status: p.status, identity: p.identity && p.identity.status, sector: p.sector && p.sector.primary, profile: p.sector_profile, watchlist: p.watchlist && p.watchlist.on_watchlist }));
      }
      if (sub === 'show') return require('./core/indexer').projectDetail(ws, need(rest[0], 'project show <id>'));
      if (sub === 'archive') {
        const r = projects.archiveProject(ws, need(rest[0], 'project archive <id>'), one(flags.reason));
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'restore') {
        const r = projects.restoreProject(ws, need(rest[0], 'project restore <id>'));
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'identity') {
        const id = need(rest[0], 'project identity <id>');
        const defillama = defillamaFlags(flags);
        const native = nativeChainFlag(flags);
        const identityGiven = [flags.website, flags.coingecko_id, flags.asset, flags.evidence, flags.pending, native].some((v) => v !== undefined);
        // Only the DefiLlama binding: the rest of the identity is left exactly
        // as it is.
        const r = defillama !== undefined && !identityGiven
          ? projects.setDefillamaBinding(ws, id, { defillama })
          : projects.updateIdentity(ws, id, {
            official_website: one(flags.website),
            coingecko_id: one(flags.coingecko_id),
            assets: list(flags.asset).length ? parseAssets(flags.asset) : undefined,
            evidence: parseEvidence(flags),
            identity_status: flags.pending ? 'pending' : undefined,
            ...(native !== undefined ? { native_chain: native } : {}),
            ...(defillama !== undefined ? { defillama } : {}),
          });
        // A new binding is fetched once right away (the same lease, gate and
        // backoff as the scheduled refresh), so a wrong slug or scope shows now.
        let fundamentals = null;
        if (defillama && !flags.no_refresh) {
          const f = require('./core/fundamentals');
          const refreshed = await f.refresh(ws, { trigger: 'binding', force: true, projectIds: [id] });
          fundamentals = { refresh: { status: refreshed.status, message: refreshed.message }, ...f.summary(ws, projects.getProject(ws, id)) };
        }
        return { ...r, ...(fundamentals ? { fundamentals } : {}), ...(await afterWrite(ws, id)) };
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
        if (one(flags.chart_symbol)) fields.chart_symbol = /^none$/i.test(one(flags.chart_symbol)) ? null : one(flags.chart_symbol);
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
      throw Object.assign(new Error('project add|list|show|archive|restore|identity|watch|headline|set|reviewed'), { code: 'USAGE' });
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
        const r = research.createRun(ws, { project_id: id, providers: one(flags.providers), horizon: one(flags.horizon), long_term_reason: one(flags.long_term_reason), same_as_last: Boolean(flags.same_as_last), channel: one(flags.channel) || actor, utterance: one(flags.utterance) || null, force_new: Boolean(flags.force_new), refresh: Boolean(flags.refresh), allow_pending_identity: Boolean(flags.allow_pending_identity) });
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
      if (sub === 'providers') return { providers: research.providerStatus(ws), readiness: research.readiness(ws), budget: ws.settings.research.budget, spend: research.spendSoFar(ws), unattended_enabled: ws.settings.research.unattended_enabled };
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
      // The local pilot runner's save under its claim (--token, N2): Eric's
      // stop is checked inside the import's own lock, as the worker's is.
      const claimed = claimedSave(ws, flags, 'import-text --project P --token T');
      try {
        const r = inbox.importContent(ws, provider, { content: text, filename: one(flags.filename) || null, projectId: one(flags.project) || null, runId: one(flags.run) || null, channel: `cli (${actor})`, guard: claimed ? claimed.guard : null });
        return { ...r, ...(await afterWrite(ws, r.result.project_id)) };
      } catch (err) {
        if (!claimed) throw err;
        return claimed.stopped(err);
      }
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
      if (sub === 'set-cost') {
        const r = portfolio.setCost(ws, { asset_id: need(rest[0], 'portfolio set-cost <asset> --account ID --avg-cost-usd X [--acquired-at DATE] [--tx-id ID] [--reason R]'), account_id: need(one(flags.account), '--account required'), avg_cost_usd: need(one(flags['avg-cost-usd']) !== undefined ? one(flags['avg-cost-usd']) : one(flags.avg_cost_usd), '--avg-cost-usd required'), acquired_at: one(flags['acquired-at']) || one(flags.acquired_at) || null, tx_id: one(flags['tx-id']) || one(flags.tx_id) || null, reason: one(flags.reason) || null });
        Object.assign(r, require('./core/setcost-words').costDateWords(portfolio.loadTransactions(ws), r));
        return { ...r, ...(await afterWrite(ws)) };
      }
      const market = require('./core/market');
      return portfolio.computePortfolio(ws, { market: market.readLatest(ws) });
    }
    case 'wallet': {
      // Tracked wallets: public addresses, read-only (core/wallets.js).
      const wallets = require('./core/wallets');
      const sync = require('./core/walletsync');
      const id = rest[0];
      if (sub === 'add') {
        const r = wallets.addWallet(ws, { label: need(one(flags.label), '--label required'), address: need(one(flags.address), '--address 0x... required (public address only)'), networks: need(one(flags.networks), `--networks required (${Object.keys(wallets.NETWORKS).join(', ')})`), account_id: one(flags.account) || null });
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (['pause', 'resume', 'remove', 'networks'].includes(sub)) {
        need(id, `wallet ${sub} <wallet_id>`);
        const r = sub === 'pause' ? wallets.pauseWallet(ws, id) : sub === 'resume' ? wallets.resumeWallet(ws, id) : sub === 'remove' ? wallets.removeWallet(ws, id, one(flags.reason) || null) : wallets.setWalletNetworks(ws, id, need(one(flags.networks), '--networks required'));
        return { ...r, ...(await afterWrite(ws)) };
      }
      if (sub === 'sync') {
        // Asks for a read and runs it now, under the same lease, gate and budget.
        const asked = id ? sync.requestSync(ws, id) : null;
        if (asked && asked.status !== 'queued') return asked;
        const r = await sync.refresh(ws, { trigger: one(flags.trigger) || 'cli', walletIds: id ? [id] : null, force: !id });
        const wrote = !['noop', 'busy', 'backoff', 'skipped', 'not_configured', 'held'].includes(r.status);
        return { ...r, ...(wrote ? await afterWrite(ws) : {}) };
      }
      if (sub === 'resolve') {
        const choice = flags.record ? 'record' : flags.skip ? 'skip' : null;
        const r = wallets.resolveEvent(ws, { wallet_id: need(id, 'wallet resolve <wallet_id> <network> <event_key> --record|--skip'), network: need(rest[1], 'network required'), event_key: need(rest[2], 'event key required'), decision: need(choice, '--record or --skip required'), note: one(flags.note) || null });
        const ledger = wallets.importReady(ws);
        return { ...r, ledger, ...(await afterWrite(ws)) };
      }
      if (sub === 'status') return wallets.overview(ws);
      if (sub === 'list' || !sub) {
        const st = sync.statusOf(ws);
        return { sync: st.summary, estimate: sync.estimateUsage(ws), wallets: wallets.listWallets(ws).map((w) => ({ wallet_id: w.wallet_id, label: w.label, address: w.address, account_id: w.account_id, status: w.status, networks: w.networks.map((n) => ({ network: n, ...st.networks[`${w.wallet_id}:${n}`] })) })) };
      }
      throw Object.assign(new Error('wallet list|status|add|pause|resume|remove|networks|sync|resolve'), { code: 'USAGE' });
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
    case 'fundamentals': {
      const f = require('./core/fundamentals');
      const ids = rest.filter(Boolean);
      if (sub === 'refresh') {
        // A manual refresh skips the failure backoff, never DefiLlama's rate limit.
        const r = await f.refresh(ws, { trigger: one(flags.trigger) || 'cli', force: true, projectIds: ids.length ? ids : null });
        const wrote = !['noop', 'busy', 'backoff', 'skipped', 'budget_paused'].includes(r.status);
        return { ...r, ...(wrote ? await afterWrite(ws) : {}) };
      }
      if (sub === 'status' || !sub) {
        if (ids.length) return f.view(ws, projects.getProject(ws, ids[0]));
        const list = projects.listProjects(ws).filter((p) => !p.broken && p.status !== 'archived');
        return { overview: f.overview(ws), projects: list.map((p) => ({ project_id: p.project_id, ...f.summary(ws, p) })) };
      }
      throw Object.assign(new Error('fundamentals refresh [<id>...] | fundamentals status [<id>]'), { code: 'USAGE' });
    }
    case 'screen': {
      const sc = require('./core/screening');
      const ids = rest.filter(Boolean);
      if (sub === 'refresh') {
        // A manual run skips the failure backoff, never GoPlus's rate limit.
        const r = await sc.refresh(ws, { trigger: one(flags.trigger) || 'cli', force: true, projectIds: ids.length ? ids : null });
        const wrote = !['noop', 'busy', 'backoff', 'skipped', 'budget_paused'].includes(r.status);
        return { ...r, ...(wrote ? await afterWrite(ws) : {}) };
      }
      if (sub === 'status' || !sub) {
        if (ids.length) return sc.view(ws, projects.getProject(ws, ids[0]));
        const list = projects.listProjects(ws).filter((p) => !p.broken && p.status !== 'archived');
        return { overview: sc.overview(ws), projects: list.map((p) => ({ project_id: p.project_id, ...sc.summary(ws, p) })) };
      }
      throw Object.assign(new Error('screen refresh [<id>...] | screen status [<id>]'), { code: 'USAGE' });
    }
    case 'forensics': {
      const fo = require('./core/forensics');
      const pid = rest[0];
      const aid = rest[1];
      if (sub === 'quote-candidates') {
        const lim = one(flags.limit);
        const r = await require('./core/tickets').quoteCandidates(ws, { limit: lim === undefined ? 15 : Number(lim), dryRun: Boolean(flags['dry-run'] || flags.dry_run) });
        return r.dry_run || !r.quoted.length ? r : { ...r, ...(await afterWrite(ws, null)) };
      }
      if (sub === 'view' || sub === 'status') return fo.view(ws, need(pid, `forensics ${sub} <project>`));
      if (sub === 'start') {
        const r = fo.createAudit(ws, { project_id: need(pid, 'forensics start <project> [--challenge]'), challenge: Boolean(flags.challenge), channel: one(flags.channel) || actor, assistant: /cowork/i.test(String(one(flags.channel) || '')) ? 'claude' : null, utterance: one(flags.utterance) || null, owner_focus: one(flags.focus) || null, restart: Boolean(flags.restart), refresh: Boolean(flags.refresh), allow_pending_identity: Boolean(flags.allow_pending_identity) });
        return { ...r, audit: undefined, ...(['created', 'restarted', 'resumed'].includes(r.status) ? await afterWrite(ws, pid) : {}) };
      }
      if (sub === 'prompt') {
        const a = fo.loadAudit(ws, need(pid, 'forensics prompt <project> <audit_id> [--role challenge]'), need(aid, 'forensics prompt <project> <audit_id>'));
        if (!a) throw Object.assign(new Error(`No forensic audit ${aid}`), { code: 'NOT_FOUND' });
        const p = fo.promptFor(ws, a, one(flags.role) === 'challenge' ? 'challenge' : 'investigator');
        if (!p || !p.text) throw Object.assign(new Error(p ? p.error : 'That role has no frozen prompt yet.'), { code: 'NOT_FOUND' });
        return flags.json ? p : { _text: p.text };
      }
      if (sub === 'import') {
        const text = need(readTextArg(flags), 'forensics import <project> <audit_id> --provider claude|chatgpt --text-file FILE');
        const kind = one(flags.revision_kind);
        const r = fo.saveReport(ws, { project_id: need(pid, 'project'), audit_id: need(aid, 'audit_id'), provider: need(one(flags.provider), '--provider claude|chatgpt'), text, revision: kind ? { kind, note: one(flags.revision_note) || '' } : null, channel: one(flags.channel) || 'cli import' });
        return { status: r.status, receipt_id: r.receipt_id, verified: r.verified, message: r.message, ...(r.status === 'saved' ? await afterWrite(ws, pid) : {}) };
      }
      if (sub === 'challenge') {
        const r = fo.requestChallenge(ws, need(pid, 'forensics challenge <project> <audit_id>'), need(aid, 'audit_id'));
        return { status: r.noop ? 'unchanged' : 'saved', ...r.result, verified: r.verified };
      }
      if (sub === 'cancel') return fo.cancelAudit(ws, need(pid, 'project'), need(aid, 'audit_id'), one(flags.reason) || null);
      if (sub === 'monitor') {
        const enabled = flags.on ? true : flags.off ? false : undefined;
        const approve = one(flags.approve) ? { receipt_id: one(flags.approve), product_checks: list(flags.check).length ? list(flags.check) : undefined, repositories: list(flags.repo).length ? list(flags.repo) : undefined } : null;
        const r = fo.setMonitoring(ws, need(pid, 'forensics monitor <project> [--approve <receipt_id> [--check URL]... [--repo owner/repo]...] [--quote <chain_id:contract>]... [--remove <target_id>]... [--on|--off]'), { enabled, approve, approve_quotes: list(flags.quote), remove: list(flags.remove), by: actor });
        return { status: r.noop ? 'unchanged' : 'saved', ...r.result, verified: r.verified };
      }
      if (sub === 'run') {
        const r = await require('./core/forensic-monitor').refresh(ws, { trigger: one(flags.trigger) || 'cli', force: Boolean(flags.force), projectIds: pid ? [pid] : null });
        return r;
      }
      if (sub === 'correct') {
        const r = fo.correctResolution(ws, need(pid, 'project'), need(aid, 'receipt_id'), { checkpoint: one(flags.checkpoint), event: one(flags.event), outcome: one(flags.outcome), reason: one(flags.reason) });
        return { status: 'saved', ...r.result, verified: r.verified };
      }
      // The case package of one receipt, and its offline verification.
      if (sub === 'case') {
        const pkg = require('./core/forensic-case').buildCase(ws, need(pid, 'forensics case <project> <receipt_id> [--out FILE]'), need(aid, 'receipt_id'));
        const out = one(flags.out);
        if (!out) return pkg;
        fs.writeFileSync(out, JSON.stringify(pkg, null, 2));
        return { status: 'written', file: out, receipt_id: aid, artifacts: pkg.manifest.artifacts.length, missing: pkg.manifest.missing.length, calculation: pkg.manifest.calculation.status };
      }
      if (sub === 'case-verify') {
        const f = need(one(flags.file) || pid, 'forensics case-verify --file FILE');
        return require('./core/forensic-case').verifyCase(JSON.parse(fs.readFileSync(f, 'utf8')));
      }
      throw Object.assign(new Error('forensics view|start|quote-candidates|prompt|import|challenge|cancel|monitor|run|correct|case|case-verify (see help)'), { code: 'USAGE' });
    }
    case 'brief': {
      // The one attention contract (cr-attention@1): decisions, exceptions, progress.
      if (sub === 'attention') return require('./core/brief-daily').attention(ws);
      if (sub !== 'daily') throw Object.assign(new Error('brief daily|attention [--json] [--since ISO] (see help)'), { code: 'USAGE' });
      const out = require('./core/brief-daily').brief(ws, { since: one(flags.since) || null });
      // main strips --json before run(), so it is read from argv here.
      return flags.json || process.argv.includes('--json') ? out : { _text: `${out.text}\n\nSHA-256 of this text: ${out.text_sha256}\n` };
    }
    case 'paper': return require('./core/paper').book(ws);
    case 'tickets': {
      const tk = require('./core/tickets');
      const pid = rest[0];
      const tid = rest[1];
      if (sub === 'view' || sub === 'status') return tk.read(ws, need(pid, `tickets ${sub} <project>`), { receiptId: one(flags.receipt) || null, includeText: Boolean(flags['include-text'] || flags.include_text) });
      if (sub === 'exit-matrix') return tk.exitMatrix(ws);
      if (sub === 'basis') return require('./core/decision-basis').viewOf(ws, need(pid, 'tickets basis <project> <decision_id>'), need(tid, 'tickets basis <project> <decision_id>'));
      if (sub === 'reconcile') {
        const one = pid && !String(pid).startsWith('--') ? pid : null;
        const dryRun = Boolean(flags['dry-run'] || flags.dry_run);
        return one ? tk.reconcileEffects(ws, { project: one, dryRun }) : tk.reconcileDesk(ws, { dryRun });
      }
      if (sub === 'candidates') return { candidates: tk.pilotCandidates(ws) };
      if (sub === 'digest') {
        const days = one(flags.days);
        const d = tk.digest(ws, { days: days === undefined || days === null || days === true ? 7 : Number(days) });
        return flags.json || process.argv.includes('--json') ? d : { _text: `${tk.digestText(d)}\n` };
      }
      if (sub === 'batch-gate') {
        const below = one(flags.below);
        const r = tk.batchGate(ws, { below: below === undefined || below === null || below === true ? null : Number(below), dryRun: Boolean(flags['dry-run'] || flags.dry_run) });
        return r.made.length && !r.dry_run ? { ...r, ...(await afterWrite(ws, r.made[0].project_id)) } : r;
      }
      if (sub === 'decide-gates') {
        const r = tk.decideDeskGates(ws, { action: one(flags.action), request_id: one(flags['request-id'] || flags.request_id) || null, note: one(flags.note) || null, dryRun: Boolean(flags['dry-run'] || flags.dry_run), by: actor });
        return r.decided.length && !r.dry_run ? { ...r, ...(await afterWrite(ws, r.decided[0].project_id)) } : r;
      }
      if (sub === 'auto-pilot-sync') {
        const min = one(flags.min);
        return tk.autoPilotSync(ws, { min: min === undefined || min === null || min === true ? null : Number(min), dryRun: Boolean(flags['dry-run'] || flags.dry_run) });
      }
      if (sub === 'run-cycle') {
        const lim = one(flags.limit);
        const r = await tk.runCycle(ws, { limit: lim === undefined || lim === null || lim === true ? 10 : Number(lim), dryRun: Boolean(flags['dry-run'] || flags.dry_run) });
        const wrote = !r.dry_run && (r.counts.opted_in || r.counts.gates_made || r.counts.quoted);
        return wrote ? { ...r, ...(await afterWrite(ws, null)) } : r;
      }
      if (sub === 'queue') {
        // The pause and each step's claim state ride along for the pilot-all
        // pre-poll (scripts/pilot.js), as the online poll gives them.
        const steps = tk.pilotQueue(ws, { project: pid || null });
        const PC = require('./core/pilot-claims');
        const claims = {};
        for (const s of steps) { const c = PC.peek(ws, s.project_id, s); if (c) claims[s.project_id] = c; }
        const sessions = PC.sessionsView(ws);
        // Each project's next action, blocker, authority, claim and IDs.
        const status = require('./core/mandate-authority').statusRows(ws, steps, { sessions });
        return { steps, pending: tk.pendingFor(ws), paused: require('./core/workspace').automationPaused(ws), claims, sessions, status };
      }
      // The pilot runner's execution claim (cr-pilot-claim@1, stage 5.4).
      if (sub === 'claim') return require('./core/pilot-claims').claim(ws, need(pid, 'tickets claim <project> [--expect KEY] [--owner NAME]'), { owner: one(flags.owner) || actor, expect: one(flags.expect) || null, force: Boolean(flags['force-prosecution'] || flags.force_prosecution) });
      if (sub === 'bind') return require('./core/pilot-claims').bind(ws, need(pid, 'tickets bind <project> --token T [--run R] [--ticket K]'), need(one(flags.token), '--token'), { run_id: one(flags.run) || null, ticket_id: one(flags.ticket) || null });
      if (sub === 'release') return require('./core/pilot-claims').release(ws, need(pid, 'tickets release <project> --token T | --reconciled --attempt <pa_…>'), { token: one(flags.token) || null, reconciled: Boolean(flags.reconciled), attempt_id: one(flags.attempt) || null, outcome: one(flags.outcome) || null });
      // Before the local runner saves a session's answer: Eric's stop since
      // the dispatch lets the claim go as autonomy_stopped and nothing is saved.
      if (sub === 'check') return require('./core/pilot-claims').stopIfHalted(ws, need(pid, 'tickets check <project> --token T'), need(one(flags.token), '--token'));
      // Eric's latch on every automated effect on the project (mandate-
      // authority.js automationGate): --stop halts the pilot's sessions and
      // claims, the paper mandate's grants and openings, and automatic
      // admission's remaining effects; --rearm clears it.
      if (sub === 'autonomy') {
        const usage = 'tickets autonomy <project> --stop|--rearm [--note TEXT]';
        const p = need(pid, usage);
        if (!flags.stop && !flags.rearm) return { project_id: p, autonomy: tk.autonomyOf(ws, p) };
        if (flags.stop && flags.rearm) throw Object.assign(new Error(usage), { code: 'USAGE' });
        const r = tk.setAutonomy(ws, p, { action: flags.stop ? 'stop' : 'rearm', note: one(flags.note) || null, by: actor });
        return { ...r, ...(r.status === 'saved' ? await afterWrite(ws, p) : {}) };
      }
      if (sub === 'start') {
        const exit_quote = await tk.prepareExitQuote(ws, need(pid, 'tickets start <project> [--refresh] [--restart]')).catch(() => null);
        const r = tk.createTicket(ws, { exit_quote, project_id: need(pid, 'tickets start <project> [--refresh] [--restart]'), channel: one(flags.channel) || actor, assistant: Boolean(flags.assistant), mode: one(flags.mode) || 'cli', utterance: one(flags.utterance) || null, refresh: Boolean(flags.refresh), reopen: Boolean(flags.reopen), restart: Boolean(flags.restart), force_prosecution: Boolean(flags['force-prosecution'] || flags.force_prosecution) });
        return { status: r.status, gate_closed: r.gate_closed === true, ticket_id: r.ticket_id || null, receipt_id: r.receipt_id || null, message: r.message, prompt_path: r.ticket ? r.ticket.prompt.path : null, ...(['created', 'resumed', 'gate_closed'].includes(r.status) ? await afterWrite(ws, pid) : {}) };
      }
      if (sub === 'prompt') {
        const t = tk.loadTicket(ws, need(pid, 'tickets prompt <project> <ticket_id>'), need(tid, 'tickets prompt <project> <ticket_id>'));
        if (!t) throw Object.assign(new Error(`No ticket ${tid}`), { code: 'NOT_FOUND' });
        const p = tk.promptFor(ws, t);
        if (!p.text) throw Object.assign(new Error(p.error), { code: 'INTEGRITY' });
        return flags.json ? p : { _text: p.text };
      }
      if (sub === 'import') {
        const text = need(readTextArg(flags), 'tickets import <project> <ticket_id> --text-file FILE [--revision-note TEXT] [--token T]');
        // The local pilot runner's save under its claim (--token, N2): Eric's
        // stop is checked inside the save's own lock, as the worker's is.
        const claimed = claimedSave(ws, { ...flags, project: need(pid, 'project') }, 'tickets import <project> <ticket_id> --token T');
        let r;
        try {
          r = tk.saveTicket(ws, { project_id: pid, ticket_id: need(tid, 'ticket_id'), text, revision: one(flags.revision_note) ? { note: one(flags.revision_note) } : null, channel: one(flags.channel) || 'cli import', guard: claimed ? claimed.guard : null });
        } catch (err) {
          if (claimed) return claimed.stopped(err);
          throw err;
        }
        return { status: r.status, receipt_id: r.receipt_id, verified: r.verified, message: r.message, ...(r.status === 'saved' ? await afterWrite(ws, pid) : {}) };
      }
      if (sub === 'decide') {
        const r = tk.decide(ws, need(pid, 'tickets decide <project> <receipt_id> --action approve|halve|veto|pass|watch|trim|reopen|undo'), { receipt_id: need(tid, 'receipt_id'), action: need(one(flags.action), '--action approve|halve|veto|pass|watch|trim|reopen|undo'), note: one(flags.note) || null, by: actor });
        return { ...r.result, verified: r.verified, ...(await afterWrite(ws, pid)) };
      }
      if (sub === 'pilot') {
        const r = tk.setPilot(ws, need(pid, 'tickets pilot <project> --on|--off'), !flags.off, { by: actor });
        return { status: r.noop ? 'unchanged' : 'saved', pilot: !flags.off, verified: r.verified, ...(r.exit_quote ? { exit_quote: r.exit_quote } : {}), ...(await afterWrite(ws, pid)) };
      }
      if (sub === 'cancel') return tk.cancelTicket(ws, need(pid, 'project'), need(tid, 'ticket_id'), one(flags.reason) || null);
      throw Object.assign(new Error('tickets view|queue|claim|bind|release|reconcile|exit-matrix|candidates|digest|batch-gate|decide-gates|auto-pilot-sync|run-cycle|start|prompt|import|decide|pilot|cancel (see help)'), { code: 'USAGE' });
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
      // Writes a ready-to-append grading appendix for every sector profile that
      // can stand alone. A profile written for cr-research-prompt@5 has none:
      // its appendix needs a run's exact horizon dates, so the project's own
      // prompt (prompts <id>, or a research run's prompt) is the one to use.
      const { buildAppendixV2 } = require('./core/prompts');
      const { runOp } = require('./core/ops');
      const standalone = Object.values(ws.rubrics.profiles).filter((profile) => !profile.written_for);
      const skipped = Object.values(ws.rubrics.profiles).filter((profile) => profile.written_for).map((profile) => profile.profile_ref);
      const out = runOp(ws, { type: 'build_appendices', summary: 'Build standalone grading appendices' }, (op) => {
        for (const profile of standalone) {
          op.write(`templates/appendix/grading-appendix.${profile.profile_id}.v${profile.version}.prompt-v2.md`, buildAppendixV2(ws, profile, {}));
        }
      });
      return { status: out.noop ? 'unchanged' : 'built', files: out.files.map((f) => f.rel), ...(skipped.length ? { skipped, note: `No standalone appendix for ${skipped.join(', ')}: they are written for a run's prompt (research prompt <id> <run_id>, or prompts <id>).` } : {}) };
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
    case 'trader': {
      // Eric's own command, and the only way a real Paper Book starts (trader-desk.js).
      if (sub !== 'bootstrap') throw Object.assign(new Error('trader bootstrap --cash-usd <amount> --confirm "FUND NEW PAPER BOOK <amount>"'), { code: 'USAGE' });
      return require('./core/trader-desk').bootstrapBook(ws, { cash_usd: one(flags.cash_usd), confirm: one(flags.confirm) });
    }
    case 'offsite': {
      const off = require('./core/offsite');
      if (sub === 'setup') {
        const desk = one(flags.desk) ? String(one(flags.desk)).replace(/\/+$/, '') : null;
        const to = one(flags.to) ? path.resolve(one(flags.to)) : null;
        if (!desk && !to) throw Object.assign(new Error('offsite setup --desk https://<your desk> [--to <folder>]'), { code: 'USAGE' });
        if (desk) {
          let u;
          try { u = new URL(desk); } catch (_) { throw Object.assign(new Error(`"${desk}" is not a URL.`), { code: 'INVALID' }); }
          if (u.protocol !== 'https:' || u.pathname !== '/' || u.search) throw Object.assign(new Error('The desk address is its https origin only, for example https://your-desk.onrender.com'), { code: 'INVALID' });
        }
        const { runOp } = require('./core/ops');
        const out = runOp(ws, { type: 'update_settings', summary: 'Set up offsite copies of the online desk' }, (op) => {
          const cur = op.readJson('config/settings.json', { schema_version: 1 });
          cur.offsite = { ...(cur.offsite || {}), ...(desk ? { desk_url: desk } : {}), ...(to ? { folder: to } : {}) };
          op.writeJson('config/settings.json', cur);
        });
        ws.reloadSettings();
        const r = off.readiness(ws);
        return { status: 'saved', verified: out.verified, ...r, next: r.configured ? 'node dashboard/cli.js offsite pull' : `Still missing: ${r.missing.join('; ')}` };
      }
      if (sub === 'pull') return off.pull(ws, { to: one(flags.to) ? path.resolve(one(flags.to)) : null, deskUrl: one(flags.desk) || null });
      if (sub === 'status') return off.status(ws);
      if (sub === 'verify') return off.verifyFile(path.resolve(need(rest[0], 'offsite verify <file>')));
      if (sub === 'drill') return off.drill(ws, { file: rest[0] ? path.resolve(rest[0]) : null, to: one(flags.to) ? path.resolve(one(flags.to)) : null });
      throw Object.assign(new Error('offsite setup|pull|status|verify|drill'), { code: 'USAGE' });
    }
    case 'contracts': {
      // Contract state observations (core/contract-forensics.js, Pillar 1).
      // show and status read stored files only; observe and probe read the
      // chain within Eric's compute-unit caps; --dry-run sends nothing.
      const CF = require('./core/contract-forensics');
      if (sub === 'status') return CF.deskStatus(ws);
      if (sub === 'show') return CF.view(ws, need(rest[0], 'contracts show <project>'));
      // With no chain named, every chain the active projects need that is not
      // probed yet (the job's own first probe, within the caps).
      if (sub === 'probe') return rest[0] ? CF.probeNetwork(ws, rest[0]) : CF.probeChains(ws);
      if (sub === 'observe') {
        const pid = need(rest[0], 'contracts observe <project> [--dry-run]');
        if (flags['dry-run'] || flags.dry_run) return CF.observeProject(ws, pid, { dryRun: true });
        const r = await CF.observeProject(ws, pid, { trigger: 'cli' });
        return r.results.some((x) => x.status === 'saved') ? { ...r, ...(await afterWrite(ws, pid)) } : r;
      }
      if (sub === 'gate') {
        // The contract gate's mode (observe by default). Enforce is refused
        // until both contract compute caps and a probed network are set
        // (server.js validateSettingsPatch, the same check as Settings).
        const modeNow = () => (ws.settings.tickets && ws.settings.tickets.contract_gate && ws.settings.tickets.contract_gate.mode) || 'observe';
        if (!rest[0]) return { mode: modeNow() };
        const patch = require('./server').validateSettingsPatch({ tickets: { contract_gate: { mode: rest[0] } } }, ws);
        const { runOp } = require('./core/ops');
        const out = runOp(ws, { type: 'update_settings', summary: `Contract gate mode ${patch.tickets.contract_gate.mode}` }, (op) => {
          const cur = op.readJson('config/settings.json', { schema_version: 1 });
          cur.tickets = { ...(cur.tickets || {}), contract_gate: patch.tickets.contract_gate };
          op.writeJson('config/settings.json', cur);
        });
        ws.reloadSettings();
        return { status: 'saved', verified: out.verified, mode: modeNow() };
      }
      if (sub === 'init-defaults') {
        // The published Uniswap V2/V3 factories, Safe singletons and network-fee
        // ceilings (core/contract-presets.js), added to the contracts settings;
        // rows and ceilings already set are kept. --dry-run writes nothing.
        const S = require('./server');
        const p = require('./core/contract-presets').plan(ws.settings);
        const checked = p.patch ? S.validateSettingsPatch(p.patch, ws) : null;
        if (!p.patch || flags.dry_run) return { status: p.patch ? 'planned' : 'unchanged', dry_run: Boolean(flags.dry_run), added: p.added, kept: p.kept, patch: checked };
        const { out } = S.applySettings(ws, p.patch, 'Contract defaults (init-defaults)');
        return { status: 'saved', verified: out.verified, added: p.added, kept: p.kept };
      }
      throw Object.assign(new Error('contracts status | show <project> | observe <project> [--dry-run] | probe [<chain_id>] | gate [observe|enforce] | init-defaults [--dry-run]'), { code: 'USAGE' });
    }
    case 'arm-desk': {
      // The paper desk's baseline settings (core/arm-desk.js), checked by the
      // same validateSettingsPatch as Settings. Locally they are written with
      // the contract defaults; --desk=online prints what to paste into the
      // signed-in desk's browser console (the CLI holds no online sign-in).
      const A = require('./core/arm-desk');
      const S = require('./server');
      const desk = one(flags.desk) || 'local';
      if (!['local', 'online'].includes(desk)) throw Object.assign(new Error('arm-desk [--desk=local|online] [--dry-run] [--daily-cu=N --monthly-cu=N] [--allow=SYM/USDC,...] [--intent-life=MIN] [--contracts-on] [--mandate-days=N | --mandate-off] [--admission-days=N [--admission-daily=N] | --admission-off] [--print-schedule]'), { code: 'USAGE' });
      if (flags.print_schedule && (flags.mandate_off || flags.admission_off)) throw Object.assign(new Error('--print-schedule prints the task commands and writes nothing; --mandate-off and --admission-off are settings writes. Run them as separate commands.'), { code: 'USAGE' });
      if (flags.print_schedule) return { _text: `${A.scheduleText(path.join(__dirname, '..'))}\n` };
      const whole = (v, name) => {
        if (v === undefined) return undefined;
        if (!/^\d+$/.test(String(v))) throw Object.assign(new Error(`--${name} takes a whole number`), { code: 'USAGE' });
        return Number(v);
      };
      const allow = list(flags.allow).flatMap((s) => String(s).split(',')).map((s) => s.trim()).filter(Boolean);
      const life = whole(one(flags.intent_life), 'intent-life');
      const days = whole(one(flags.mandate_days), 'mandate-days');
      const patch = A.armPatch({
        dailyCu: whole(one(flags.daily_cu), 'daily-cu'),
        monthlyCu: whole(one(flags.monthly_cu), 'monthly-cu'),
        allow,
        ...(life !== undefined ? { intentLife: life } : {}),
        contractsOn: Boolean(flags.contracts_on),
        mandateDays: days,
        mandateOff: Boolean(flags.mandate_off),
        admissionDays: whole(one(flags.admission_days), 'admission-days'),
        admissionDaily: whole(one(flags.admission_daily), 'admission-daily'),
        admissionOff: Boolean(flags.admission_off),
        settings: desk === 'local' ? ws.settings : null,
      });
      const checked = S.validateSettingsPatch(patch, ws);
      // Off-only (A5): only the requested switches, no contract defaults, no
      // other endpoint; locally the write is read back.
      const offOnly = A.offOnlyOf(patch);
      if (desk === 'online') {
        const left = A.leftOpen(patch, null);
        const script = A.onlineScript(patch, { left });
        return process.argv.includes('--json') ? { desk: 'online', valid: true, ...(offOnly ? { mode: 'off_only' } : {}), patch, script, left_for_you: left } : { _text: `${script}\n` };
      }
      if (offOnly) {
        const left = A.leftOpen(patch, ws.settings);
        if (flags.dry_run) return { status: 'planned', dry_run: true, desk: 'local', mode: 'off_only', valid: true, patch: checked, left_for_you: left };
        const { out } = S.applySettings(ws, patch, 'Turn off (arm-desk off-only)');
        const a = ws.settings.automation || {};
        const au = (x) => (x && x.authority ? { generation: x.authority.generation, revoked_at: x.authority.revoked_at || null, revoked_because: x.authority.revoked_because || null } : null);
        const readback = {
          autonomous_paper_loop: a.autonomous_paper_loop,
          mandate_on: require('./core/tickets').mandateOf(ws).on,
          mandate_authority: au(a.mandate),
          lead_admission_enabled: a.lead_admission ? a.lead_admission.enabled : undefined,
          admission_on: require('./core/lead-admission').authorityOf(ws).on,
          admission_authority: au(a.lead_admission),
        };
        const held = (patch.automation.autonomous_paper_loop !== false || (readback.autonomous_paper_loop === false && readback.mandate_on === false))
          && (!patch.automation.lead_admission || (readback.lead_admission_enabled === false && readback.admission_on === false));
        return { status: 'saved', verified: Boolean(out.verified && held), desk: 'local', mode: 'off_only', applied: checked, readback, left_for_you: left };
      }
      const presets = require('./core/contract-presets').plan(ws.settings);
      const left = A.leftOpen(patch, ws.settings);
      if (flags.dry_run) return { status: 'planned', dry_run: true, desk: 'local', valid: true, patch: checked, contract_defaults: presets.added, left_for_you: left };
      const { out } = S.applySettings(ws, patch, 'Arm the paper desk (arm-desk)');
      const defaults = presets.patch ? S.applySettings(ws, presets.patch, 'Contract defaults (init-defaults)').out : null;
      return { status: 'saved', verified: out.verified && (!defaults || defaults.verified), desk: 'local', applied: checked, contract_defaults: presets.added, left_for_you: left };
    }
    case 'scout': {
      // Grok Scout's list as the desk keeps it (core/scout.js); read only.
      const S = require('./core/scout');
      if (!sub || sub === 'list') return S.view(ws);
      if (sub === 'status') return { status: S.statusLine(ws) };
      if (sub === 'leads') {
        // Its leads (core/leads.js); read only, except run: one eligibility
        // turn (job leads), the same as the server's timer.
        const L = require('./core/leads');
        if (!rest[0] || rest[0] === 'list') return L.view(ws);
        if (rest[0] === 'status') return L.status(ws, L.SOURCE, need(rest[1], 'scout leads status <delivery_id>'));
        if (rest[0] === 'run') return L.refresh(ws, { trigger: 'cli' });
        if (rest[0] === 'receipt') return L.getReceipt(ws, need(rest[1], 'scout leads receipt <receipt_id>'));
        // Automatic admission's authority, today's capacity, what holds it and
        // its admissions (core/lead-admission.js); read only.
        if (rest[0] === 'auto') return require('./core/lead-admission').statusView(ws);
        throw Object.assign(new Error('scout leads list|status <delivery_id>|run|receipt <receipt_id>|auto'), { code: 'USAGE' });
      }
      throw Object.assign(new Error('scout list|status|leads'), { code: 'USAGE' });
    }
    case 'explorer': {
      // The optional Research Explorer (core/explorer.js). Exports go one way,
      // to Supabase only; nothing here changes the desk's records.
      const xp = require('./core/explorer');
      if (sub === 'status') {
        const st = xp.status(ws);
        if (st.state !== 'configured') return { ...st, next: st.state === 'off' ? 'node dashboard/cli.js explorer configure --on' : `Still missing: ${[...st.problems, ...st.missing].join('; ')}` };
        const live = await xp.read(ws, { refresh: true });
        const scores = (live.reports || []).reduce((n, r) => n + r.category_scores.length, 0);
        return { ...st, live: { state: live.state, reason: live.reason || null, demo: live.demo || false, projects: (live.projects || []).length, reports: (live.reports || []).length, category_scores: scores, last_export: live.last_export || null } };
      }
      if (sub === 'configure') {
        const url = one(flags.url) ? String(one(flags.url)).trim().replace(/\/+$/, '') : null;
        if (!url && !flags.off && !flags.on) throw Object.assign(new Error('explorer configure --url https://<ref>.supabase.co | --off | --on'), { code: 'USAGE' });
        if (url && !xp.URL_RE.test(url)) throw Object.assign(new Error('The Supabase URL is the project address only, https://<20-character ref>.supabase.co (Supabase > Project Settings > Data API).'), { code: 'INVALID' });
        const { runOp } = require('./core/ops');
        const out = runOp(ws, { type: 'update_settings', summary: 'Set up the Research Explorer' }, (op) => {
          const cur = op.readJson('config/settings.json', { schema_version: 1 });
          cur.explorer = { ...(cur.explorer || {}), ...(url ? { supabase_url: url } : {}), ...(flags.off ? { enabled: false } : flags.on ? { enabled: true } : {}) };
          op.writeJson('config/settings.json', cur);
        });
        ws.reloadSettings();
        const st = xp.status(ws);
        return { status: 'saved', verified: out.verified, ...st, next: st.state === 'configured' ? 'node dashboard/cli.js explorer status' : st.state === 'off' ? 'Switched off.' : `Still missing: ${[...st.problems, ...st.missing].join('; ')}` };
      }
      if (sub === 'export') {
        const usage = 'explorer export --fixtures [--dry-run] | --project <project_id> --dry-run | --project <project_id> --confirm <confirm_sha256 from its preview>';
        if ([flags.fixtures, flags.project, flags.desk].filter(Boolean).length > 1) throw Object.assign(new Error(`Choose one of --fixtures, --project <id> or --desk. ${usage}`), { code: 'USAGE' });
        // Exporting every real record at once is not a command (subtraction stage 6.1).
        if (flags.desk) throw Object.assign(new Error(`Exporting all real desk records is not a command; nothing was sent. ${usage}`), { code: 'USAGE' });
        if (flags.project !== undefined) {
          const id = one(flags.project);
          if (typeof id !== 'string' || !id.trim()) throw Object.assign(new Error(`--project needs a project ID. ${usage}`), { code: 'USAGE' });
          if (Array.isArray(flags.project)) throw Object.assign(new Error(`One project at a time; nothing was sent. ${usage}`), { code: 'USAGE' });
          if (flags.confirm !== undefined) {
            if (flags.dry_run) throw Object.assign(new Error(`Choose --dry-run or --confirm; nothing was sent. ${usage}`), { code: 'USAGE' });
            if (typeof flags.confirm !== 'string') throw Object.assign(new Error(`A bare --confirm proves nothing, and one value only; nothing was sent. ${usage}`), { code: 'USAGE' });
            if (!process.stdin.isTTY || !process.stdout.isTTY) throw Object.assign(new Error('Sending real records runs from your own terminal, not a script, a pipe or an assistant. Nothing was sent.'), { code: 'NOT_INTERACTIVE' });
            return xp.sendProject(ws, id.trim(), { confirm: flags.confirm });
          }
          return xp.exportProject(ws, id.trim(), { dryRun: Boolean(flags.dry_run) });
        }
        if (!flags.fixtures) throw Object.assign(new Error(usage), { code: 'USAGE' });
        return xp.exportFixtures(ws, { dryRun: Boolean(flags.dry_run), completeExisting: Boolean(flags.complete_existing) });
      }
      throw Object.assign(new Error('explorer status | configure --url <url> | --off | --on | export --fixtures [--dry-run] | export --project <id> --dry-run | export --project <id> --confirm <confirm_sha256>'), { code: 'USAGE' });
    }
    case 'restored-copy': {
      // A restored copy holds research (no provider asked for anything) until
      // Eric releases it; releasing lets queued jobs be sent and accepted
      // requests be collected by their ID, within the limits.
      const research = require('./core/research');
      const rel = research.RESTORED_REL;
      let cur;
      // A marker that does not read holds, and hold can still write it again.
      try { cur = research.restoredHold(ws) || require('./core/fsx').readJson(ws.abs(rel), null); } catch (err) { if (sub !== 'hold') throw err; cur = { unreadable: true }; }
      if (sub === 'status') {
        if (!cur) return { restored_copy: false, message: 'This workspace is not a restored copy.' };
        const out = { restored_copy: true, research_held: cur.research_held !== false, ...cur };
        if (out.research_held) { try { out.rulings_needed = require('./core/trader-desk').rulingsNeeded(ws).map((x) => (x.decision_id ? { ...x, basis: research.basisRulingOf(ws, x) } : x)); } catch (err) { out.rulings_needed = null; out.rulings_unreadable = err.message; } }
        return out;
      }
      if (sub === 'hold') {
        if (!flags.confirm) throw Object.assign(new Error('Holding stops research and every write of the Paper Book in this workspace until it is released. Re-run with --confirm --from <what was restored>.'), { code: 'CONFIRM' });
        return research.holdRestoredCopy(ws, { from: one(flags.from) });
      }
      if (sub === 'release') {
        if (cur && cur.research_held !== false && !flags.confirm) throw Object.assign(new Error('Releasing lets this copy send its queued research jobs and collect accepted requests by their ID, within the limits, and resumes the Paper Book. Read restored-copy status first. Re-run with --confirm.'), { code: 'CONFIRM' });
        return research.releaseRestoredCopy(ws, { accept: [].concat(flags.accept || []).filter((x) => typeof x === 'string'), basisRulings: [].concat(flags.basis_ruling || []), because: one(flags.because) || null });
      }
      throw Object.assign(new Error('restored-copy status|hold --confirm --from <what was restored>|release --confirm [--accept <decision_id>]... [--basis-ruling <decision_id>:<ruling_token>... --because <words>]'), { code: 'USAGE' });
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
      if (out && out.format === 'cr-autonomy-proof@1') process.exitCode = out.exit_code;
      if (out && ['possible_duplicate', 'failed', 'needs_project', 'prompt', 'provider_mismatch', 'run_mismatch', 'rejected', 'conflict'].includes(out.status)) process.exitCode = 2;
    })
    .catch((err) => {
      // These errors are raised before anything is committed.
      const beforeCommit = ['USAGE', 'INVALID', 'BAD_ID', 'BAD_PATH', 'NOT_FOUND', 'REFUSED', 'CONFLICT', 'CONFIRM', 'BAD_CONFIRM', 'CONFIRM_MISMATCH', 'NOT_INTERACTIVE', 'WORKSPACE_UNREACHABLE', 'NOT_A_WORKSPACE', 'WORKSPACE_BUSY', 'ALREADY_EXISTS', 'WRITES_BLOCKED', 'IDEMPOTENCY_CONFLICT', 'AMBIGUOUS', 'UNSAFE_PATH', 'GENERATION_UNWRITABLE'].includes(err.code);
      const payload = { status: 'error', code: err.code || 'ERROR', error: err.message, saved: beforeCommit ? false : 'unknown' };
      if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else process.stderr.write(`Error (${payload.code}): ${err.message}\n${beforeCommit ? 'Nothing was saved by this command.' : 'The command did not finish. Run "node dashboard/cli.js status" to see what was saved.'}\n`);
      process.exitCode = err.code === 'USAGE' ? 64 : 1;
    });
}

module.exports = { run, parseArgs };
