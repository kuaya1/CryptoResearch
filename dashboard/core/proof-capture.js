'use strict';
// The owner's paperwork for an operating proof (Eric's ruling on #171). It prints
// the exact commands he runs, writes blank forms and closes a folder he filled.
// It runs no command, reads no desk, opens no workspace and judges nothing: a
// sealed folder proves its bytes stayed put, and only prove-autonomy reads them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('./autonomy-proof');

const SHA = /^[0-9a-f]{40}$/;
const MAX_FILES = 64;
const MAX_TOTAL = 8 * A.MAX_FILE;
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const blank = (...fields) => Object.fromEntries(fields.map((f) => [f, null]));

// Every value starts null, which no gate reads as success and --seal refuses.
const FORMS = Object.freeze({
  r0: {},
  b0: {
    'build-deploy.json': { render_deploy_commit: null, prs: [1, 2, 3, 4].map(() => blank('number', 'merged', 'head_checks')) },
    'authority.json': blank('render_cron', 'scout_enabled'),
    'heartbeat.json': blank('period_minutes', 'grace_minutes', 'alerts_eric_only', 'dry_run_ping_claimed'),
    'candidate.json': blank('project_id', 'chain', 'contract', 'coingecko_id', 'exit_target', 'model_id', 'vetoed', 'held', 'arm_desk_reviewed', 'contract_gate', 'max_grants_per_day'),
  },
});

const REVISION = {
  files: ['revision-final.json', 'healthz.txt'],
  note: 'The revisions, after the runner is on origin/main.',
  run: [
    String.raw`git -C $runner fetch origin`,
    String.raw`$h = Invoke-WebRequest -UseBasicParsing '${A.HEALTHZ}'`,
    String.raw`"$($h.Content)" | Set-Content -NoNewline -Encoding utf8 "$e\healthz.txt"`,
    String.raw`[ordered]@{ observed_at = & $utc; origin_main = "$(git -C $runner rev-parse origin/main)"; runner_head = "$(git -C $runner rev-parse HEAD)"; healthz_status = [int]$h.StatusCode; deployed_sha = ([regex]'revision ([0-9a-f]{40})').Match("$($h.Content)").Groups[1].Value } | ConvertTo-Json | Set-Content -Encoding utf8 "$e\revision-final.json"`,
  ],
};
const TASKS = {
  files: ['tasks-final.json'],
  run: [
    String.raw`$task = { param($t) [ordered]@{ state = "$($t.State)"; enabled = [bool]$t.Settings.Enabled; instances = [int]("$($t.State)" -eq 'Running') } }`,
    String.raw`[ordered]@{ observed_at = & $utc; pilot = & $task (Get-ScheduledTask -TaskName 'CryptoResearch pilot-all'); hourly = & $task (Get-ScheduledTask -TaskPath '\CryptoResearch\' -TaskName 'Hourly') } | ConvertTo-Json | Set-Content -Encoding utf8 "$e\tasks-final.json"`,
  ],
};
const CAPTURES = Object.freeze({
  r0: [
    REVISION,
    { ...TASKS, note: 'The tasks, while both are still Disabled. Do this before you enable Hourly (R0.5).' },
    {
      files: ['pilot-all.final-status.json'],
      note: 'The registration, after -Register.',
      run: [String.raw`& "$runner\dashboard\scripts\pilot-task.ps1" -Status | Set-Content -Encoding utf8 "$e\pilot-all.final-status.json"`],
    },
    {
      files: ['verification.json'],
      note: 'The runner and the Hourly route. The probe runs the real wrapper with a harmless stand-in for node. Its readback must end pass=True and exit=73.',
      run: [
        String.raw`Copy-Item "$HOME\Documents\CryptoResearch-evidence\operating-proof-2026-11-03\R0\hourly-route-probe.ps1" $e`,
        String.raw`& "$e\hourly-route-probe.ps1"`,
        String.raw`$p = Get-Content "$e\hourly-route-probe.txt" -Raw`,
        String.raw`[ordered]@{ runner = [ordered]@{ detached = -not (git -C $runner symbolic-ref -q HEAD); clean = -not (git -C $runner status --porcelain) }; hourly_route = [ordered]@{ stand_in_exit = [int]([regex]'(?m)^exit=(\d+)').Match($p).Groups[1].Value; expected_exit = 73; records_root = ([regex]'(?m)^workspace=(.+?)\r?$').Match($p).Groups[1].Value } } | ConvertTo-Json | Set-Content -Encoding utf8 "$e\verification.json"`,
      ],
    },
    {
      files: ['doctor-main-workspace.json'],
      note: 'The doctor on the real records. It runs its own write test, as R0.5 asks, and the workspace setting lasts only for these lines.',
      run: [
        String.raw`Push-Location $runner; $env:CR_WORKSPACE = "$HOME\Documents\CryptoResearch"`,
        String.raw`node dashboard\cli.js doctor --json | Set-Content -Encoding utf8 "$e\doctor-main-workspace.json"`,
        String.raw`Remove-Item Env:CR_WORKSPACE; Pop-Location`,
      ],
    },
    {
      files: ['offsite-readback.json'],
      note: 'The offsite run. Wait until Hourly has run after you enabled it, then copy its state. The copy changes nothing.',
      run: [String.raw`Copy-Item "$HOME\Documents\CryptoResearch\logs\jobs-state.json" "$e\offsite-readback.json"`],
    },
  ],
  b0: [
    REVISION,
    { ...TASKS, note: 'The tasks, while pilot-all is Disabled.' },
    {
      files: ['controls.json', 'trader.json', 'doctor.json'],
      note: 'The desk\'s own reads. In the signed-in online desk, press F12, open Console and paste the first line; allow the three downloads. It only reads. Then move them here.',
      run: [
        String.raw`// browser: for (const [u, n] of [['/api/desk/controls', 'controls.json'], ['/api/paper/trader', 'trader.json'], ['/api/doctor', 'doctor.json']]) { const a = document.createElement('a'); a.href = URL.createObjectURL(await (await fetch(u)).blob()); a.download = n; a.click(); }`,
        String.raw`'controls.json', 'trader.json', 'doctor.json' | ForEach-Object { Move-Item "$HOME\Downloads\$_" $e }`,
      ],
    },
    {
      files: ['isolation.json'],
      note: 'The launch check. Nothing is claimed, generated or billed.',
      run: [String.raw`Push-Location $runner; node dashboard\scripts\pilot.js --check-isolation | Set-Content -Encoding utf8 "$e\isolation.json"; Pop-Location`],
    },
    {
      files: ['dry-run.json'],
      note: 'The dry run. Put your pinned model in. It reads the queue and starts nothing.',
      run: [
        String.raw`Push-Location $runner; node dashboard\scripts\pilot.js --pilot-all --desk=online --unattended --model=<PINNED_MODEL> --max-agents=1 --dry-run; Pop-Location`,
        String.raw`Get-Content "$HOME\.cryptoresearch\pilot-all.jsonl" -Tail 1 | Set-Content -Encoding utf8 "$e\dry-run.json"`,
      ],
    },
    {
      files: ['dry-run-negative.json'],
      note: 'The refusal. One tracked file is edited on purpose, the dry run must refuse, and the edit is undone. The last line must print nothing.',
      run: [
        String.raw`Add-Content "$runner\package.json" ' '`,
        String.raw`Push-Location $runner; node dashboard\scripts\pilot.js --pilot-all --desk=online --unattended --model=<PINNED_MODEL> --max-agents=1 --dry-run; Pop-Location`,
        String.raw`Get-Content "$HOME\.cryptoresearch\pilot-all.jsonl" -Tail 1 | Set-Content -Encoding utf8 "$e\dry-run-negative.json"`,
        String.raw`git -C $runner restore package.json`,
        String.raw`git -C $runner status --porcelain`,
      ],
    },
  ],
});
// What each blank means, in the owner's hand. Leaving one null stops the seal.
const FILLING = Object.freeze({
  b0: [
    'build-deploy.json: render_deploy_commit, the full commit on Render\'s deploy page. prs, the blueprint\'s PRs 1 to 4: number, merged (true), head_checks ("green").',
    'authority.json: render_cron ("absent" or "suspended"). scout_enabled (false, read from the repository variable).',
    'heartbeat.json: read from Healthchecks: period_minutes (60), grace_minutes (120), alerts_eric_only (true). dry_run_ping_claimed (false).',
    'candidate.json: project_id, chain, contract, coingecko_id, exit_target, model_id (the full ID), vetoed, held, arm_desk_reviewed, contract_gate ("enforce"), max_grants_per_day (1).',
  ],
});

const requiredFiles = (step) => [...new Set([
  ...Object.values(A.READERS[step]).flatMap((r) => r.files),
  ...(step === 'r0' ? [] : [A.NARRATIVES[step]]),
])];
const blanksIn = (value, at) => {
  if (value === null) return [at];
  if (typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => blanksIn(v, at ? `${at}.${k}` : k));
};

function captureText(step, root) {
  const folder = path.join(root, A.FOLDERS[step]);
  const narrative = step === 'r0' ? [] : [`Write ${A.NARRATIVES[step]} in that folder yourself: what you saw, in your words.`, ''];
  return [
    `${step.toUpperCase()} evidence. You run every line, in one PowerShell window. A new window needs the first three again.`,
    'These lines save what the runbook steps left behind. They do not do the runbook steps.',
    '',
    String.raw`$runner = "$HOME\Documents\CryptoResearch-runner"`,
    `$e = '${folder.replace(/'/g, "''")}'`,
    String.raw`$utc = { (Get-Date).ToUniversalTime().ToString('o') }`,
    '',
    ...CAPTURES[step].flatMap((c) => [`# ${c.files.join(', ')}. ${c.note}`, ...c.run, '']),
    ...(FILLING[step] ? ['Fill in these forms in that folder. Replace every null with what you read yourself:', ...FILLING[step], ''] : []),
    ...narrative,
    'When the folder is complete, close it. A closed folder cannot be sealed twice.',
    `node "$runner\\dashboard\\cli.js" prove-autonomy ${step} --seal --baseline=<origin/main SHA> --evidence='${root.replace(/'/g, "''")}'`,
    '',
  ].join('\n');
}

function template(step, flags, deps) {
  if (flags.baseline) refuse('USAGE', '--baseline belongs with --seal.');
  if (!CAPTURES[step]) refuse('USAGE', 'Forms and commands exist for r0 and b0 only.');
  const root = A.outputRoot(flags.evidence);
  const folder = path.join(root, A.FOLDERS[step]);
  try { fs.mkdirSync(folder, { mode: 0o700 }); } catch (_) { refuse('ALREADY_EXISTS', `${A.FOLDERS[step]} already exists here, so nothing was written. Use a new evidence folder.`); }
  const text = captureText(step, root);
  const captureFile = path.join(root, `CAPTURE-${A.FOLDERS[step]}.txt`);
  fs.writeFileSync(captureFile, text, { flag: 'wx', mode: 0o600 });
  for (const [name, form] of Object.entries(FORMS[step])) fs.writeFileSync(path.join(folder, name), `${JSON.stringify(form, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { status: 'ok', step, folder, forms: Object.keys(FORMS[step]), capture_file: captureFile, _text: text };
}

function membersOf(folder) {
  const members = [];
  const notBound = [];
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isSymbolicLink()) refuse('BAD_PATH', `${entry.name} is a link, so nothing was sealed.`);
    if (entry.isFile()) members.push(entry.name); else notBound.push(entry.name);
  }
  if (members.length > MAX_FILES) refuse('INVALID', `More than ${MAX_FILES} files, so nothing was sealed.`);
  return { members, notBound };
}

function seal(step, flags, deps) {
  if (typeof flags.baseline !== 'string' || !SHA.test(flags.baseline)) refuse('USAGE', '--seal needs --baseline=<the 40-character origin/main SHA>.');
  const given = A.absolute(flags.evidence);
  const folder = path.join(given, A.FOLDERS[step]);
  if (!fs.existsSync(folder)) refuse('MISSING', `There is no ${A.FOLDERS[step]} folder here.`);
  A.outputRoot(given);
  A.noLinks(folder);
  const manifestPath = path.join(folder, 'manifest.json');
  if (fs.existsSync(manifestPath)) refuse('ALREADY_EXISTS', 'This folder is already sealed. Its manifest was not changed.');

  const { members, notBound } = membersOf(folder);
  const missing = requiredFiles(step).filter((f) => !members.includes(f));
  if (missing.length) refuse('MISSING', `Not sealed. Still missing: ${missing.join(', ')}.`);

  const bytes = new Map();
  let total = 0;
  for (const name of members) {
    let b;
    try { b = A.readBounded(folder, name); } catch (_) { refuse('INVALID', `${name} cannot be read as a bounded regular file, so nothing was sealed.`); }
    total += b.length;
    if (total > MAX_TOTAL) refuse('INVALID', 'The folder is larger than the verifier reads, so nothing was sealed.');
    bytes.set(name, b);
  }
  const parsed = new Map();
  for (const name of members.filter((n) => n.endsWith('.json'))) {
    try { parsed.set(name, A.jsonOf(bytes.get(name))); } catch (_) { refuse('INVALID', `${name} is not valid JSON, so nothing was sealed.`); }
  }
  const unfilled = members.filter((n) => A.OWNER_RECORDS.has(n) && parsed.has(n)).flatMap((n) => blanksIn(parsed.get(n), '').map((f) => `${n}: ${f}`));
  if (unfilled.length) refuse('UNFILLED', `Not sealed. Still blank: ${unfilled.join('; ')}.`);

  const env = deps.env || process.env;
  const secretValues = Object.entries(env).filter(([k, v]) => A.SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 8).map(([, v]) => v);
  const secretIn = members.filter((n) => { const t = A.textOf(bytes.get(n)); return A.SECRET_SHAPES.some((re) => re.test(t)) || secretValues.some((v) => t.includes(v)); });
  if (secretIn.length) refuse('SECRET', `Not sealed. A credential-shaped value is in: ${secretIn.join(', ')}. It is not repeated here; rotate it and rewrite the record.`);
  // The same files the verifier screens: a saved test log rightly mentions markers.
  const fictional = requiredFiles(step).filter((n) => A.FICTION.test(A.textOf(bytes.get(n))));
  if (fictional.length) refuse('FICTIONAL', `Not sealed. Fictional markers are in: ${fictional.join(', ')}.`);
  const revision = parsed.get('revision-final.json');
  if (revision && revision.origin_main !== flags.baseline) refuse('MISMATCH', 'Not sealed. --baseline differs from origin_main in revision-final.json.');

  const now = deps.now ? new Date(deps.now()) : new Date();
  const manifest = {
    format: `cr-operating-proof-${step}-evidence@1`,
    closed_at: now.toISOString(),
    baseline: flags.baseline,
    files: members.map((name) => ({ path: name, bytes: bytes.get(name).length, sha256: sha256(bytes.get(name)) })),
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  // Created whole without replacement: a crash leaves no partial manifest.
  const tmp = path.join(folder, `.manifest.tmp-${crypto.randomUUID()}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, manifestPath); } finally { fs.unlinkSync(tmp); }
  return {
    status: 'ok',
    step,
    manifest: manifestPath,
    manifest_sha256: sha256(text),
    members: members.length,
    not_bound: notBound,
    note: 'Sealed means these bytes can no longer change unnoticed. It does not mean they are true. A receipt merged under docs/engineering must name this hash, and only prove-autonomy judges the step.',
  };
}

function command(step, flags, deps = {}) {
  if (!A.STEPS.includes(step)) refuse('USAGE', `Name one step: ${A.STEPS.join(', ')}.`);
  const allowed = new Set(['template', 'seal', 'evidence', 'baseline']);
  for (const [key, value] of Object.entries(flags)) {
    if (!allowed.has(key) || Array.isArray(value)) refuse('USAGE', 'Unsupported or repeated flag.');
    if ((key === 'template' || key === 'seal') !== (value === true)) refuse('USAGE', `--${key} is written wrong.`);
  }
  if (flags.template && flags.seal) refuse('USAGE', 'Choose --template or --seal.');
  if (typeof flags.evidence !== 'string' || !flags.evidence) refuse('USAGE', 'Name the evidence folder: --evidence=<folder>.');
  return flags.seal ? seal(step, flags, deps) : template(step, flags, deps);
}

module.exports = { FORMS, CAPTURES, FILLING, requiredFiles, captureText, template, seal, command };
