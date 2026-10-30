'use strict';
// `arm-desk` (Eric, 2026-10-30): the baseline settings that let the paper
// desk run end to end, as one settings patch checked by the same
// validateSettingsPatch as Settings: his scout-lead policy, automatic exit
// quotes, the trader's Paper Book funding and venue fee, his trader rules,
// and, when he names them, the contract compute-unit caps. Contract
// observations stay as they are (off by default, the contract gate in
// observe). Nothing here picks a token: the trader's allowlist is only the
// pairs Eric names (--allow), and while it is unset every intent waits.

const LEAD_CHAINS = Object.freeze(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'linea', 'unichain', 'sonic', 'solana']);

// Shares are decimal strings, as the trader reads them (0.03 is a 3% stop,
// 0.20 a notional cap of 20% of NAV).
function armPatch({ dailyCu, monthlyCu, allow = [] } = {}) {
  const patch = {
    leads: { enabled: true, chains: [...LEAD_CHAINS], min_market_cap_usd: 5000000, min_volume_24h_usd: 250000, max_sell_tax_pct: 5, eligibility_hours: 48 },
    automation: { exit_quotes_auto: true },
    trader: {
      book: { cash_usd: '25000', fee_rate: '0.001' },
      rules: { stop_min_pct: '0.03', stop_min_atr: '0.5', notional_max_pct: '0.20', max_validity_minutes: 240, ...(allow.length ? { allowlist: allow } : {}) },
    },
  };
  const contracts = {};
  if (dailyCu !== undefined) contracts.daily_cu_cap = dailyCu;
  if (monthlyCu !== undefined) contracts.monthly_cu_cap = monthlyCu;
  if (Object.keys(contracts).length) patch.contracts = contracts;
  return patch;
}

// What the patch leaves for Eric, in words.
function leftOpen(patch, settings) {
  const c = (settings && settings.contracts) || {};
  const out = [];
  if (!patch.trader.rules.allowlist) out.push('trader.rules.allowlist is unset: every trade intent waits until you name the pairs (--allow=SYM/USDC,...).');
  const caps = { ...c, ...(patch.contracts || {}) };
  if (!Number.isInteger(caps.daily_cu_cap) || !Number.isInteger(caps.monthly_cu_cap)) out.push('Contract compute-unit caps are unset: nothing is asked of the chain (--daily-cu=5000 --monthly-cu=100000).');
  if (c.enabled !== true) out.push('Contract observations stay off (contracts.enabled false); the contract gate stays in observe.');
  return out;
}

// The online desk takes settings only from its signed-in page, so the CLI
// prints what to paste into that page's browser console: the session token,
// then the settings, then the contract defaults (POST /api/contracts/init-defaults,
// which keeps any factory row or fee ceiling already set there).
function onlineScript(patch, { url = 'https://cryptoresearch.onrender.com' } = {}) {
  return [
    `// Sign in at ${url}, open the browser console (F12) on that page, paste this, press Enter.`,
    '(async () => {',
    "  const s = await (await fetch('/api/session', { credentials: 'same-origin' })).json();",
    "  const post = async (p, body) => { const r = await fetch(p, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-cr-token': s.token }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };",
    `  console.log('arm-desk settings', await post('/api/settings', ${JSON.stringify(patch)}));`,
    "  console.log('contract defaults', await post('/api/contracts/init-defaults', {}));",
    '})();',
  ].join('\n');
}

module.exports = { LEAD_CHAINS, armPatch, leftOpen, onlineScript };
