'use strict';
// `arm-desk` (Eric, 2026-10-30): the baseline settings that let the paper
// desk run end to end, as one settings patch checked by the same
// validateSettingsPatch as Settings: his scout-lead policy, automatic exit
// quotes, the trader's Paper Book funding and venue fee, his trader rules,
// and, when he names them, the contract compute-unit caps. Contract
// observations stay as they are (off by default, the contract gate in
// observe). Nothing here picks a token: the trader's saved allowlist is only
// the pairs Eric names (--allow); the trader also trades the pairs of grants
// in force and of positions it holds (trader-desk.js allowlistOf).
//
// Autonomous paper playbook, Stage 12: the floor for a new entry at 50, an
// intent's life (--intent-life, default 1440 minutes), contract observations
// on (--contracts-on, only with both compute-unit caps), the paper mandate for
// N days (--mandate-days) or off (--mandate-off), and the pilot-all schedule
// printed, never run (--print-schedule).

const LEAD_CHAINS = Object.freeze(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'linea', 'unichain', 'sonic', 'solana']);
const INTENT_LIFE_DEFAULT = 1440;
const DAY = 86400000;
const fail = (code, message) => Object.assign(new Error(message), { code });

// Shares are decimal strings, as the trader reads them (0.03 is a 3% stop,
// 0.20 a notional cap of 20% of NAV).
// settings: the desk's settings the caps may already be in (locally); null
// online, where only the flags count.
//
// Automatic admission of scout leads (lead-admission.js) is its own flag and
// never rides on the mandate's: --admission-days=N arms it for N days (1 to
// 30) with --admission-daily=N admissions a New York day (0 to 3, default 1),
// --admission-off turns it off. Without them the patch leaves it as it is.
function armPatch({ dailyCu, monthlyCu, allow = [], intentLife = INTENT_LIFE_DEFAULT, contractsOn = false, mandateDays, mandateOff = false, admissionDays, admissionDaily, admissionOff = false, settings = null, now = Date.now() } = {}) {
  if (!Number.isInteger(intentLife) || intentLife < 1 || intentLife > 10080) throw fail('USAGE', '--intent-life takes whole minutes from 1 to 10080.');
  if (mandateDays !== undefined && mandateOff) throw fail('USAGE', '--mandate-days and --mandate-off cannot both be given.');
  if (mandateDays !== undefined && !(Number.isInteger(mandateDays) && mandateDays >= 1 && mandateDays <= 30)) throw fail('USAGE', '--mandate-days takes whole days from 1 to 30.');
  if (admissionDays !== undefined && admissionOff) throw fail('USAGE', '--admission-days and --admission-off cannot both be given.');
  if (admissionDays !== undefined && !(Number.isInteger(admissionDays) && admissionDays >= 1 && admissionDays <= 30)) throw fail('USAGE', '--admission-days takes whole days from 1 to 30.');
  if (admissionDaily !== undefined && !(Number.isInteger(admissionDaily) && admissionDaily >= 0 && admissionDaily <= 3)) throw fail('USAGE', '--admission-daily takes a whole number from 0 to 3.');
  if (admissionDaily !== undefined && admissionDays === undefined) throw fail('USAGE', '--admission-daily goes with --admission-days=N (automatic admission is armed only with an expiry).');
  const automation = { exit_quotes_auto: true };
  if (mandateDays !== undefined) Object.assign(automation, { autonomous_paper_loop: true, mandate: { expires_at: new Date(now + mandateDays * DAY).toISOString() } });
  if (mandateOff) automation.autonomous_paper_loop = false;
  if (admissionDays !== undefined) automation.lead_admission = { enabled: true, daily_limit: admissionDaily === undefined ? 1 : admissionDaily, expires_at: new Date(now + admissionDays * DAY).toISOString() };
  if (admissionOff) automation.lead_admission = { enabled: false };
  const patch = {
    leads: { enabled: true, chains: [...LEAD_CHAINS], min_market_cap_usd: 5000000, min_volume_24h_usd: 250000, max_sell_tax_pct: 5, eligibility_hours: 48 },
    automation,
    tickets: { sizing: { min_grade_new_entry: 50 } },
    trader: {
      book: { cash_usd: '25000', fee_rate: '0.001' },
      rules: { stop_min_pct: '0.03', stop_min_atr: '0.5', notional_max_pct: '0.20', max_validity_minutes: intentLife, ...(allow.length ? { allowlist: allow } : {}) },
    },
  };
  const contracts = {};
  if (dailyCu !== undefined) contracts.daily_cu_cap = dailyCu;
  if (monthlyCu !== undefined) contracts.monthly_cu_cap = monthlyCu;
  if (contractsOn) {
    // Contract observations never run uncapped: both caps, named now or saved.
    const caps = { ...((settings && settings.contracts) || {}), ...contracts };
    if (!Number.isInteger(caps.daily_cu_cap) || !Number.isInteger(caps.monthly_cu_cap)) throw fail('REFUSED', '--contracts-on needs both compute-unit caps (--daily-cu=5000 --monthly-cu=100000): contract observations never run uncapped.');
    contracts.enabled = true;
  }
  if (Object.keys(contracts).length) patch.contracts = contracts;
  return patch;
}

// What the patch leaves for Eric, in words.
function leftOpen(patch, settings) {
  const c = (settings && settings.contracts) || {};
  const a = (settings && settings.automation) || {};
  const out = [];
  if (!patch.trader.rules.allowlist) out.push('trader.rules.allowlist is unset: the trader opens only the pairs of grants in force and closes the pairs it holds; name more with --allow=SYM/USDC,...');
  const caps = { ...c, ...(patch.contracts || {}) };
  if (!Number.isInteger(caps.daily_cu_cap) || !Number.isInteger(caps.monthly_cu_cap)) out.push('Contract compute-unit caps are unset: nothing is asked of the chain (--daily-cu=5000 --monthly-cu=100000).');
  const on = (patch.contracts && patch.contracts.enabled === true) || (!(patch.contracts && patch.contracts.enabled === false) && c.enabled === true);
  if (!on) out.push('Contract observations stay off (contracts.enabled false); the contract gate stays in observe, and the paper mandate grants nothing without a live contract observation.');
  else out.push('Contract observations need ALCHEMY_API_KEY in Render > Environment (never in settings), then each chain probed (contracts probe) before an observation counts.');
  const pm = patch.automation || {};
  const loop = pm.autonomous_paper_loop !== undefined ? pm.autonomous_paper_loop : a.autonomous_paper_loop;
  const expires = (pm.mandate && pm.mandate.expires_at) || (a.mandate && a.mandate.expires_at) || null;
  if (loop === true) out.push(`The paper mandate is on until ${expires || 'no expiry (it grants nothing)'}: pilot projects only, grade 50 or more, 1 grant a day and 2 open by default; undo any grant on its card. Run arm-desk --mandate-days=N again to extend it (at most 30).`);
  else out.push('The paper mandate is off: every grant is yours (--mandate-days=N turns it on for N days).');
  const la = pm.lead_admission !== undefined ? { ...(a.lead_admission || {}), ...pm.lead_admission } : a.lead_admission || {};
  if (la.enabled === true) out.push(`Automatic admission of scout leads is on until ${la.expires_at || 'no expiry (it admits nothing)'}: at most ${la.daily_limit === undefined ? 1 : la.daily_limit} a New York day, one pipeline at a time, each a research request (never a trade); --admission-off turns it off.`);
  else out.push('Automatic admission of scout leads is off: an ELIGIBLE lead waits for your confirm (--admission-days=N turns it on for N days; the mandate flags never do).');
  out.push('The pilot-all pre-poll of the online desk needs CR_PILOT_POLL_TOKEN_SHA256 in Render > Environment; its token stays in %USERPROFILE%\\.cryptoresearch\\secrets.json (pilot_poll_token).');
  return out;
}

// The online desk takes settings only from its signed-in page, so the CLI
// prints what to paste into that page's browser console: the session token,
// then the settings, then the contract defaults (POST /api/contracts/init-defaults,
// which keeps any factory row or fee ceiling already set there).
// Then the pilot projects' exit-quote targets (POST /api/forensics/exit-quotes/auto,
// under the standing policy the settings just turned on). `left`: what is
// still Eric's, as comment lines on top.
function onlineScript(patch, { url = 'https://cryptoresearch.onrender.com', left = [] } = {}) {
  return [
    `// Sign in at ${url}, open the browser console (F12) on that page, paste this, press Enter.`,
    ...left.map((l) => `// Left for you: ${l}`),
    '(async () => {',
    "  const s = await (await fetch('/api/session', { credentials: 'same-origin' })).json();",
    "  const post = async (p, body) => { const r = await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-cr-token': s.token }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };",
    `  console.log('arm-desk settings', await post('/api/settings', ${JSON.stringify(patch)}));`,
    "  console.log('exit-quote targets', await post('/api/forensics/exit-quotes/auto', {}));",
    "  console.log('contract defaults', await post('/api/contracts/init-defaults', {}));",
    '})();',
  ].join('\n');
}

// The Windows Task Scheduler task for --pilot-all every 30 minutes, through
// dashboard/scripts/pilot-task.ps1 (readiness PR, 2026-10-31), printed and
// never run: registered disabled for the signed-in user, the verified Node
// binary and pilot.js in the repository folder, no window, IgnoreNew, a
// 3-hour limit; it never replaces a task it did not make.
const TASK_NAME = 'CryptoResearch pilot-all';
function scheduleText(root) {
  const ps = `powershell -NoProfile -ExecutionPolicy Bypass -File "${root}\\dashboard\\scripts\\pilot-task.ps1"`;
  return [
    'Paste into PowerShell or a Command Prompt to register the pilot every 30 minutes, disabled until you enable it. Nothing was run.',
    `${ps} -Register -MaxAgents 1`,
    `${ps} -Status`,
    `${ps} -Enable`,
    'Only while you are signed in; if a run is still going the next is skipped; a missed start runs once when the PC is available; the PC is not woken. The runner\'s result is the last line of %USERPROFILE%\\.cryptoresearch\\pilot-all.jsonl (exit 3: a project needs you).',
    `To stop it: ${ps} -Disable (or -Remove).`,
  ].join('\n');
}

module.exports = { LEAD_CHAINS, INTENT_LIFE_DEFAULT, TASK_NAME, armPatch, leftOpen, onlineScript, scheduleText };
