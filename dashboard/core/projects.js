'use strict';
// Project records: creation with duplicate detection, identity, watchlist,
// headline selection, archiving and prompt generation.

const { runOp, OpError } = require('./ops');
const { readJson, listDir, exists } = require('./fsx');
const { slugify, isProjectId, isRecordId } = require('./ids');
const { stageProjectPrompts } = require('./prompts');
const { safeUrl } = require('./reports');
const { validate, loadSchema } = require('./schema');
const { PROVIDERS } = require('./workspace');
const { SECTORS, normalizeSector } = require('./sectors');

const GENERIC_WORDS = new Set(['network', 'protocol', 'finance', 'financial', 'labs', 'foundation', 'token', 'coin', 'dao', 'chain', 'the', 'project', 'official']);

// Sites that list, chart or discuss a token but are not the project's own:
// market data, DEX screeners, block explorers, social networks, link pages and
// code hosts. A page on one of these hosts (or a subdomain of one) is a lead,
// never the official website, and never makes two projects "the same".
const NON_OFFICIAL_HOSTS = new Set([
  'coinmarketcap.com', 'coingecko.com', 'geckoterminal.com', 'dexscreener.com', 'dextools.io', 'defillama.com',
  'etherscan.io', 'bscscan.com', 'basescan.org', 'arbiscan.io', 'polygonscan.com', 'optimistic.etherscan.io', 'snowtrace.io',
  'solscan.io', 'explorer.solana.com', 'solana.fm', 'tronscan.org', 'suiscan.xyz',
  'x.com', 'twitter.com', 't.me', 'discord.gg', 'discord.com', 'medium.com', 'linktr.ee', 'github.com',
]);
// GitBook's own site is not a project's; a project's docs on its own
// gitbook.io subdomain are.
const NON_OFFICIAL_EXACT_HOSTS = new Set(['gitbook.io']);
// Names that are a market-data site or explorer, not a project (the host of a
// pasted link taken as the name).
const AGGREGATOR_NAMES = new Set(['coinmarketcap', 'coingecko', 'geckoterminal', 'dexscreener', 'defillama', 'etherscan', 'bscscan', 'basescan', 'arbiscan', 'polygonscan', 'snowtrace', 'solscan', 'solanafm', 'tronscan', 'suiscan']);
const LISTING_NOTE = 'Market listing or explorer page: a lead, not the official website';
const LISTING_UNKNOWN = 'Official website not confirmed (a market listing page is not the project\'s own site).';

function coreName(name) {
  const words = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const kept = words.filter((w) => !GENERIC_WORDS.has(w));
  return (kept.length ? kept : words).join(' ');
}

// The whole host name without "www.": projecta.gitbook.io and
// projectb.gitbook.io, or foo.co.uk and bar.co.uk, are different sites.
function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') || null;
  } catch (_) {
    return null;
  }
}

function isNonOfficialHost(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  const host = domainOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  if (!host) return false;
  if (NON_OFFICIAL_EXACT_HOSTS.has(host)) return true;
  for (const h of NON_OFFICIAL_HOSTS) if (host === h || host.endsWith(`.${h}`)) return true;
  return false;
}

function isAggregatorName(name) {
  const s = String(name || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\.(com|io|org|xyz|fm)\/?$/, '').replace(/[^a-z0-9]+/g, '');
  return AGGREGATOR_NAMES.has(s);
}

function refuseAggregatorName(name) {
  if (isAggregatorName(name)) throw new OpError('INVALID', 'That is the name of a market-data site, not a project; use the project\'s own name.');
}

// EVM addresses are case-insensitive; others (e.g. Solana) are compared exactly.
function normAddress(addr) {
  if (!addr) return null;
  const a = String(addr).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;
}

function requireProjectId(id) {
  if (!isProjectId(id)) throw new OpError('BAD_ID', `Not a valid project ID: ${JSON.stringify(id)}`);
  return id;
}

function loadProject(ws, id) {
  requireProjectId(id);
  return readJson(ws.abs(`projects/${id}/project.json`), null);
}

function getProject(ws, id) {
  const p = loadProject(ws, id);
  if (!p) throw new OpError('NOT_FOUND', `No project "${id}". Use: node dashboard/cli.js project list`);
  return p;
}

function listProjects(ws) {
  const out = [];
  for (const id of listDir(ws.abs('projects'), { dirs: true })) {
    if (!isProjectId(id)) continue;
    try {
      const p = readJson(ws.abs(`projects/${id}/project.json`), null);
      if (p) out.push(p);
    } catch (err) {
      out.push({ project_id: id, name: id, broken: true, error: err.message, identity: {}, watchlist: {} });
    }
  }
  return out;
}

function findDuplicates(ws, input, { excludeId = null } = {}) {
  const strong = [];
  const possible = [];
  const inId = slugify(input.name || '');
  const inCore = coreName(input.name);
  const inAliases = (input.aliases || []).map(coreName);
  const inDomain = input.official_website && !isNonOfficialHost(input.official_website) ? domainOf(input.official_website) : null;
  const inCg = input.coingecko_id ? String(input.coingecko_id).toLowerCase() : null;
  const inAddrs = (input.assets || []).map((a) => normAddress(a && a.contract_address)).filter(Boolean);
  const inSym = input.symbol ? String(input.symbol).toUpperCase() : null;
  for (const p of listProjects(ws)) {
    if (p.broken || p.project_id === excludeId) continue;
    const reasons = [];
    if (inId && p.project_id === inId) reasons.push('same project ID');
    const names = [p.name, ...(p.aliases || [])].map(coreName);
    if (input.name && (names.includes(inCore) || inAliases.some((a) => names.includes(a)))) reasons.push('same name');
    const id = p.identity || {};
    const cgs = [id.coingecko_id, ...(id.candidates || []).map((c) => c.coingecko_id)].filter(Boolean).map((s) => s.toLowerCase());
    if (inCg && cgs.includes(inCg)) reasons.push('same CoinGecko ID');
    const addrs = [...(id.assets || []), ...(id.candidates || []).flatMap((c) => c.assets || [])].map((a) => normAddress(a.contract_address)).filter(Boolean);
    if (inAddrs.some((a) => addrs.includes(a))) reasons.push('same contract address');
    const domain = id.official_website && !isNonOfficialHost(id.official_website) ? domainOf(id.official_website) : null;
    if (inDomain && domain && inDomain === domain) reasons.push('same official website');
    if (reasons.length) {
      strong.push({ project_id: p.project_id, name: p.name, status: p.status, reasons });
    } else if (inSym && p.symbol && p.symbol.toUpperCase() === inSym) {
      possible.push({ project_id: p.project_id, name: p.name, reasons: ['same ticker symbol only (tickers are not unique)'] });
    }
  }
  return { strong, possible };
}

function cleanEvidence(list) {
  const now = new Date().toISOString();
  return (list || [])
    .filter((e) => e && safeUrl(e.url))
    .map((e) => ({ kind: e.kind || null, url: safeUrl(e.url), checked_at: e.checked_at || now, note: e.note || null }));
}

function cleanAssets(list) {
  return (list || [])
    .filter((a) => a && a.chain)
    .map((a) => ({
      chain: String(a.chain).trim().toLowerCase(),
      contract_address: a.contract_address ? String(a.contract_address).trim() : null,
      standard: a.standard || null,
      note: a.note || null,
    }));
}

// Decides whether the supplied identity is bound (verified) or stays pending.
// Verified needs an official website, a token binding (CoinGecko ID or contract)
// and at least one evidence URL. Otherwise the binding is kept only as an
// unconfirmed candidate that is never used for prices or holdings.
// Research defaults keep a plain provider list (never null), in canonical names.
function providerList(list) {
  const map = { gpt: 'chatgpt', openai: 'chatgpt', chatgpt: 'chatgpt', claude: 'claude', anthropic: 'claude', gemini: 'gemini', google: 'gemini' };
  const raw = Array.isArray(list) ? list : typeof list === 'string' ? list.split(',') : [];
  return [...new Set(raw.map((s) => map[String(s).trim().toLowerCase()]).filter(Boolean))];
}

function buildIdentity(input) {
  // The DefiLlama binding (fundamentals.js), validated by the caller, is kept as
  // given. It never counts toward verifying the token identity.
  const defillama = input.defillama ? { defillama: input.defillama } : {};
  let website = input.official_website ? safeUrl(input.official_website) : null;
  const assets = cleanAssets(input.assets);
  const evidence = cleanEvidence(input.evidence);
  // A CoinMarketCap, CoinGecko or explorer page given as the website is kept
  // as a lead (evidence), never as the official website.
  const listing = website && isNonOfficialHost(website);
  if (listing) {
    if (!evidence.some((e) => e.url === website)) evidence.push({ kind: 'listing', url: website, checked_at: new Date().toISOString(), note: LISTING_NOTE });
    website = null;
  }
  const cg = input.coingecko_id ? String(input.coingecko_id).trim().toLowerCase() : null;
  const hasBinding = Boolean(cg) || assets.some((a) => a.contract_address);
  const unknowns = [...(input.unknowns || [])];
  let status = 'pending';
  if (input.identity_status === 'ambiguous') status = 'ambiguous';
  else if (input.identity_status !== 'pending' && website && hasBinding && evidence.length) status = 'verified';
  if (status !== 'verified') {
    if (!website) unknowns.push(listing ? LISTING_UNKNOWN : 'Official website not confirmed.');
    if (!hasBinding) unknowns.push('Token not bound to a CoinGecko ID or contract.');
    if (!evidence.length) unknowns.push('No identity evidence URL recorded.');
  }
  if (status === 'verified') {
    return { status, official_website: website, coingecko_id: cg, assets, candidates: [], evidence, unknowns, ...defillama };
  }
  return {
    status,
    official_website: website,
    coingecko_id: null,
    assets: [],
    candidates: hasBinding ? [{ coingecko_id: cg, assets, note: 'Unconfirmed candidate. Not used for prices or holdings until confirmed.' }] : [],
    evidence,
    unknowns: [...new Set(unknowns)],
    ...defillama,
  };
}

// The DefiLlama binding an identity change asks for, validated by
// fundamentals.js: undefined keeps the one on file, null removes it, and a
// binding object (`defillama`) or the flat defillama_* fields set it.
function defillamaChange(ws, input) {
  if (!input) return undefined;
  if (input.defillama === null || input.remove_defillama === true) return null;
  const flat = ['defillama_slug', 'defillama_scope', 'defillama_source_url', 'defillama_note'].some((k) => input[k] !== undefined && input[k] !== null);
  const given = input.defillama && typeof input.defillama === 'object'
    ? input.defillama
    : flat ? { slug: input.defillama_slug, scope: input.defillama_scope, source_url: input.defillama_source_url, note: input.defillama_note } : undefined;
  if (given === undefined) return undefined;
  return require('./fundamentals').normalizeBinding(given, { actor: ws.actor || null });
}

// The binding a change leaves on file: the same entity, scope and source again
// keeps the existing binding (and its cache) as it is.
function nextDefillama(current, change) {
  if (change === undefined) return current || null;
  if (change && require('./fundamentals').sameBinding(current, change)) return current;
  return change;
}

// One DefiLlama entity describes one project.
function refuseSharedDefillama(ws, binding, excludeId) {
  if (!binding) return;
  const other = listProjects(ws).find((p) => !p.broken && p.project_id !== excludeId && p.identity && p.identity.defillama && p.identity.defillama.slug === binding.slug);
  if (other) throw new OpError('CONFLICT', `The DefiLlama entity "${binding.slug}" is already bound to "${other.project_id}". One entity describes one project: if that binding is wrong, remove it there first. Not bound.`);
}

function validateProject(ws, project) {
  const res = validate(loadSchema(ws, 'project.v1'), project);
  if (!res.valid) throw new OpError('INVALID', `Project record failed validation: ${res.errors.slice(0, 5).join('; ')}`);
}

function addProject(ws, input) {
  const name = String(input.name || '').trim();
  if (!name) throw new OpError('INVALID', 'A project name is required.');
  refuseAggregatorName(name);
  const sectorIn = input.sector ? normalizeSector(input.sector, { source: 'owner' }) : null;
  if (input.sector && !sectorIn) throw new OpError('INVALID', `Unknown sector "${typeof input.sector === 'object' ? input.sector.primary : input.sector}". Use one of: ${SECTORS.map((s) => s.label).join(', ')}.`);
  const profileRef = input.sector_profile || (sectorIn ? SECTORS.find((s) => s.id === sectorIn.primary).suggests_profile : 'general-token@2');
  if (!ws.rubrics.profiles[profileRef]) {
    throw new OpError('INVALID', `Unknown sector profile "${profileRef}". Available: ${Object.keys(ws.rubrics.profiles).join(', ')}`);
  }
  // A research horizon must be readable now, and above the planning ceiling it
  // needs the owner's long-term reason (position.js), not at the first run.
  let horizonCheck = null;
  if (input.horizon) {
    horizonCheck = require('./position').checkHorizon(ws, String(input.horizon), input.long_term_reason);
    if (!horizonCheck.ok) throw new OpError('INVALID', horizonCheck.message);
  }
  const dup = findDuplicates(ws, input);
  if (dup.strong.length) {
    const existing = dup.strong[0];
    // An archived project with this identity is offered back (Restore), never
    // duplicated and never quietly put on the watchlist while still hidden.
    if (existing.status === 'archived') {
      const p = loadProject(ws, existing.project_id) || {};
      const when = p.archive && p.archive.archived_at ? ` on ${String(p.archive.archived_at).slice(0, 10)}` : '';
      return {
        status: 'archived',
        project_id: existing.project_id,
        matched_on: existing.reasons,
        other_matches: dup.strong.slice(1),
        archived_reason: (p.archive && p.archive.reason) || p.archived_reason || null,
        message: `Already in the workspace as "${existing.project_id}" (${existing.reasons.join(', ')}), archived${when}. Nothing was added or changed. Restore it to bring it back with its reports, notes and history.`,
        files: [],
        verified: true,
      };
    }
    let watchlist = null;
    if (input.watchlist !== false) watchlist = setWatchlist(ws, existing.project_id, true);
    return {
      status: 'exists',
      project_id: existing.project_id,
      matched_on: existing.reasons,
      other_matches: dup.strong.slice(1),
      watchlist_changed: Boolean(watchlist && !watchlist.noop),
      message: `Already in the workspace as "${existing.project_id}" (${existing.reasons.join(', ')}). No duplicate was created.`,
      files: watchlist ? watchlist.files : [],
      verified: true,
    };
  }
  if (dup.possible.length && !input.allow_same_symbol) {
    return {
      status: 'possible_duplicate',
      candidates: dup.possible,
      message: 'A project with the same ticker already exists. Tickers are not unique: confirm the identity, then repeat with --allow-same-symbol if this really is a different project.',
      files: [],
      verified: true,
    };
  }
  let id = slugify(name) || 'project';
  if (exists(ws.abs(`projects/${id}`))) {
    let i = 2;
    while (exists(ws.abs(`projects/${id}-${i}`))) i++;
    id = `${id}-${i}`;
  }
  const now = new Date().toISOString();
  const defillama = nextDefillama(null, defillamaChange(ws, input));
  refuseSharedDefillama(ws, defillama, null);
  const identity = buildIdentity({ ...input, defillama });
  const onWatchlist = input.watchlist !== false;
  const project = {
    schema_version: 'cr.project.v1',
    project_id: id,
    name,
    symbol: input.symbol ? String(input.symbol).trim().toUpperCase() : null,
    aliases: (input.aliases || []).map(String),
    status: identity.status === 'verified' ? 'active' : 'pending_identity',
    sector_profile: profileRef,
    sector_note: input.sector_note || null,
    identity,
    watchlist: { on_watchlist: onWatchlist, added_at: onWatchlist ? now : null, removed_at: null },
    headline: null,
    tags: (input.tags || []).map(String),
    sector: sectorIn || normalizeSector(null, { fallbackProfile: profileRef }),
    review: null,
    research_defaults: input.horizon
      ? { horizon: String(input.horizon), providers: providerList(input.providers || input.research_providers), ...(horizonCheck.horizon.mode === 'long_term' ? { long_term_reason: horizonCheck.horizon.exception_reason } : {}) }
      : null,
    created_at: now,
    updated_at: now,
    created_via: ws.actor,
    origin_request: input.utterance || null,
  };
  validateProject(ws, project);
  const out = runOp(ws, { type: 'add_project', summary: `Add project ${id}` }, (op) => {
    op.writeJson(`projects/${id}/project.json`, project, { mode: 'create' });
    op.writeJson(`projects/${id}/events.json`, { schema_version: 'cr.events.v1', events: [] }, { mode: 'create' });
    if (input.generate_prompts !== false) stageProjectPrompts(ws, op, project);
  });
  return {
    status: 'created',
    project_id: id,
    identity_status: identity.status,
    unknowns: identity.unknowns,
    message: identity.status === 'verified'
      ? `Created "${id}" with a verified identity and added it to the watchlist.`
      : `Created "${id}" as a PENDING draft: the token is not bound until its identity is confirmed.`,
    files: out.files,
    verified: out.verified,
    op_id: out.op_id,
  };
}

// Read-modify-write of project.json inside one locked operation.
function mutateProject(ws, id, type, summary, mutate) {
  requireProjectId(id);
  return runOp(ws, { type, summary }, (op) => {
    const rel = `projects/${id}/project.json`;
    const project = op.readJson(rel, null);
    if (!project) throw new OpError('NOT_FOUND', `No project "${id}".`);
    const before = JSON.stringify(project);
    const extra = mutate(project, op);
    if (JSON.stringify(project) === before) return extra;
    project.updated_at = new Date().toISOString();
    validateProject(ws, project);
    op.writeJson(rel, project);
    return extra;
  });
}

function setWatchlist(ws, id, on) {
  return mutateProject(ws, id, 'set_watchlist', `${on ? 'Add' : 'Remove'} ${id} ${on ? 'to' : 'from'} watchlist`, (p) => {
    const wl = p.watchlist || {};
    if (Boolean(wl.on_watchlist) === Boolean(on)) return;
    const now = new Date().toISOString();
    p.watchlist = on ? { on_watchlist: true, added_at: now, removed_at: null } : { on_watchlist: false, added_at: wl.added_at || null, removed_at: now };
  });
}

function updateIdentity(ws, id, input) {
  const current = getProject(ws, id);
  // A market listing offered as the website never replaces the project's own
  // site on file; it is kept as a lead.
  const site = current.identity.official_website;
  const keepSite = Boolean(input.official_website && isNonOfficialHost(input.official_website) && site && !isNonOfficialHost(site));
  const evidence = [...(current.identity.evidence || []), ...(input.evidence || [])];
  if (keepSite && !evidence.some((e) => e && safeUrl(e.url) === safeUrl(input.official_website))) evidence.push({ kind: 'listing', url: input.official_website, note: LISTING_NOTE });
  // The DefiLlama binding on file is carried through every identity change;
  // only an explicit binding or removal changes it.
  const defillama = nextDefillama(current.identity.defillama, defillamaChange(ws, input));
  const merged = {
    official_website: input.official_website !== undefined && !keepSite ? input.official_website : site,
    coingecko_id: input.coingecko_id !== undefined ? input.coingecko_id : current.identity.coingecko_id || (current.identity.candidates[0] || {}).coingecko_id,
    assets: input.assets !== undefined ? input.assets : current.identity.assets.length ? current.identity.assets : (current.identity.candidates[0] || {}).assets,
    evidence,
    identity_status: input.identity_status,
    unknowns: input.unknowns || [],
    defillama,
  };
  const clash = findDuplicates(ws, { coingecko_id: merged.coingecko_id, assets: merged.assets, official_website: merged.official_website }, { excludeId: id });
  if (clash.strong.length) {
    throw new OpError('CONFLICT', `That identity already belongs to "${clash.strong[0].project_id}" (${clash.strong[0].reasons.join(', ')}). Not bound.`);
  }
  if (defillama !== (current.identity.defillama || null)) refuseSharedDefillama(ws, defillama, id);
  const identity = buildIdentity(merged);
  const out = mutateProject(ws, id, 'update_identity', `Update identity of ${id}`, (p, op) => {
    p.identity = identity;
    if (p.status !== 'archived') p.status = identity.status === 'verified' ? 'active' : 'pending_identity';
    if (input.regenerate_prompts !== false) stageProjectPrompts(ws, op, p);
  });
  return { status: 'updated', project_id: id, identity_status: identity.status, unknowns: identity.unknowns, files: out.files, verified: out.verified };
}

// Sets or removes only the DefiLlama binding (fundamentals.js); the rest of the
// identity stays exactly as it is, and binding never verifies a token identity.
// Repeating the same binding changes nothing.
function setDefillamaBinding(ws, id, input) {
  const current = getProject(ws, id);
  const change = defillamaChange(ws, input);
  if (change === undefined) throw new OpError('INVALID', 'Give the DefiLlama slug, scope and the URL where you verified the entity, or ask to remove the binding.');
  const before = current.identity.defillama || null;
  const next = nextDefillama(before, change);
  if (next !== before) refuseSharedDefillama(ws, next, id);
  const out = mutateProject(ws, id, 'update_identity', `${next ? 'Bind' : 'Unbind'} the DefiLlama entity of ${id}`, (p) => {
    if (next) {
      p.identity = { ...p.identity, defillama: next };
    } else if (p.identity && p.identity.defillama) {
      const { defillama: _removed, ...rest } = p.identity; // eslint-disable-line no-unused-vars
      p.identity = rest;
    }
  });
  return { status: out.noop ? 'unchanged' : next ? 'bound' : 'unbound', project_id: id, identity_status: current.identity.status, defillama: next, files: out.files, verified: out.verified };
}

function setHeadline(ws, id, { report_id = null, entry_id = null, note = null, clear = false }) {
  if (!clear) {
    if (report_id && !isRecordId(report_id)) throw new OpError('BAD_ID', 'Invalid report ID');
    if (entry_id && !isRecordId(entry_id)) throw new OpError('BAD_ID', 'Invalid journal entry ID');
    if (report_id && !exists(ws.abs(`projects/${id}/reports/${report_id}/report.json`))) throw new OpError('NOT_FOUND', `No report ${report_id} in ${id}.`);
    if (entry_id && !exists(ws.abs(`projects/${id}/journal/${entry_id}.json`))) throw new OpError('NOT_FOUND', `No journal entry ${entry_id} in ${id}.`);
    if (!report_id && !entry_id) throw new OpError('INVALID', 'Choose a report or one of your decision entries as the headline, or clear it.');
  }
  return mutateProject(ws, id, 'set_headline', `Set headline of ${id}`, (p) => {
    p.headline = clear ? null : report_id
      ? { type: 'report', report_id, entry_id: null, selected_at: new Date().toISOString(), note }
      : { type: 'decision', report_id: null, entry_id, selected_at: new Date().toISOString(), note };
  });
}

// Archiving hides a project from the watchlist, the discovery and waiting
// queues and its research reminders. Nothing is deleted: its reports, notes,
// runs and transactions stay, a token still held stays in Portfolio with its
// price, and Restore brings it back under the same ID. Research that was never
// sent is held (research.holdUnsentJobs) and stays held after a restore until
// Eric sends it; a request already sent to a paid model can still finish, be
// saved and be billed. What it was before (status, watching) is kept on the
// record, so Restore returns it as it was.
function archiveProject(ws, id, reason) {
  const out = mutateProject(ws, id, 'archive_project', `Archive ${id}`, (p) => {
    if (p.status === 'archived') return { already: true };
    const now = new Date().toISOString();
    p.archive = { archived_at: now, reason: reason || null, by: ws.actor || null, prior_status: p.status || null, prior_on_watchlist: Boolean(p.watchlist && p.watchlist.on_watchlist) };
    p.status = 'archived';
    p.archived_reason = reason || null;
    p.watchlist = { ...(p.watchlist || {}), on_watchlist: false, removed_at: now };
    return { already: false };
  });
  if (out.result && out.result.already) return { status: 'unchanged', project_id: id, message: 'Already archived.', files: [], verified: true };
  const research = require('./research');
  const held = research.holdUnsentJobs(ws, id, 'archived');
  const inFlight = research.listRuns(ws, id).flatMap((r) => (r.broken ? [] : Object.values(r.jobs || {}).filter((j) => ['dispatching', 'uncertain'].includes(j.state)).map((j) => ({ run_id: r.run_id, provider: j.provider, state: j.state }))));
  return { ...out, status: 'archived', project_id: id, held_jobs: held, sent_jobs: inFlight };
}

// Restore: the same project, ID and history, back as it was before it was
// archived (its identity decides active or pending; watching as you had it).
// It starts nothing: research held while it was archived stays held until
// you send it, and nothing paid is sent again.
function restoreProject(ws, id) {
  const out = mutateProject(ws, id, 'restore_project', `Restore ${id}`, (p) => {
    if (p.status !== 'archived') return { already: true };
    const now = new Date().toISOString();
    const a = p.archive || { archived_at: (p.watchlist && p.watchlist.removed_at) || null, reason: p.archived_reason || null, prior_on_watchlist: true };
    p.archive_history = [...(p.archive_history || []), { archived_at: a.archived_at || null, reason: a.reason || null, by: a.by || null, restored_at: now, restored_by: ws.actor || null }];
    delete p.archive;
    delete p.archived_reason;
    p.status = p.identity && p.identity.status === 'verified' ? 'active' : 'pending_identity';
    const watch = a.prior_on_watchlist !== false;
    p.watchlist = watch ? { on_watchlist: true, added_at: (p.watchlist && p.watchlist.added_at) || now, removed_at: null } : { ...(p.watchlist || {}), on_watchlist: false };
    return { already: false, watching: watch };
  });
  if (out.result && out.result.already) return { status: 'unchanged', project_id: id, message: 'Not archived.', files: [], verified: true };
  const held = require('./research').heldJobsOf(ws, id);
  return { ...out, status: 'restored', project_id: id, on_watchlist: out.result.watching, held_jobs: held };
}

// The chart symbol on a project record: EXCHANGE:PAIR as TradingView writes it
// (for example BINANCE:ONDOUSDT). The same rule as the inspector's chart
// (public/views/chart.js).
const CHART_SYMBOL_RE = /^[A-Z0-9_]{1,20}:[A-Z0-9_.!-]{1,40}$/;

function updateProjectFields(ws, id, fields) {
  const allowed = ['symbol', 'aliases', 'tags', 'sector_profile', 'sector_note', 'name', 'sector', 'research_defaults', 'chart_symbol'];
  for (const k of Object.keys(fields)) if (!allowed.includes(k)) throw new OpError('INVALID', `Field ${k} cannot be changed here.`);
  // A chart symbol is the one your chart shows instead of the ticker guess;
  // null or empty clears it.
  let chartSymbol;
  if (fields.chart_symbol !== undefined) {
    chartSymbol = fields.chart_symbol === null || String(fields.chart_symbol).trim() === '' ? null : String(fields.chart_symbol).trim().toUpperCase();
    if (chartSymbol !== null && !CHART_SYMBOL_RE.test(chartSymbol)) throw new OpError('INVALID', 'A chart symbol is EXCHANGE:PAIR as TradingView writes it, for example BINANCE:ONDOUSDT.');
  }
  if (fields.name !== undefined) refuseAggregatorName(fields.name);
  if (fields.sector_profile && !ws.rubrics.profiles[fields.sector_profile]) throw new OpError('INVALID', `Unknown sector profile ${fields.sector_profile}`);
  let sector;
  if (fields.sector !== undefined) {
    sector = fields.sector === null ? null : normalizeSector(fields.sector, { source: 'owner' });
    if (fields.sector !== null && !sector) throw new OpError('INVALID', `Unknown sector. Use one of: ${SECTORS.map((s) => s.label).join(', ')}.`);
    if (sector) sector.source = 'owner';
  }
  return mutateProject(ws, id, 'update_project', `Update ${id}`, (p, op) => {
    const { sector: _s, chart_symbol: _c, ...rest } = fields; // eslint-disable-line no-unused-vars
    Object.assign(p, rest);
    if (chartSymbol !== undefined) {
      if (chartSymbol) p.chart_symbol = chartSymbol;
      else delete p.chart_symbol;
    }
    if (fields.sector !== undefined) {
      const same = p.sector && sector && p.sector.primary === sector.primary && JSON.stringify(p.sector.tags || []) === JSON.stringify(sector.tags || []) && p.sector.source === 'owner';
      if (!same) p.sector = sector;
    }
    if (fields.symbol) p.symbol = String(fields.symbol).toUpperCase();
    if (fields.sector_profile) stageProjectPrompts(ws, op, p);
  });
}

// Your review cursor: "changes since my last review" are measured from here.
function markReviewed(ws, id, { note = null } = {}) {
  return mutateProject(ws, id, 'mark_reviewed', `Reviewed ${id}`, (p) => {
    p.review = { last_reviewed_at: new Date().toISOString(), note: note || null };
  });
}

function generatePrompts(ws, id, providers = PROVIDERS) {
  const project = getProject(ws, id);
  const bad = providers.filter((p) => !PROVIDERS.includes(p));
  if (bad.length) throw new OpError('INVALID', `Unknown provider(s): ${bad.join(', ')}`);
  const out = runOp(ws, { type: 'generate_prompts', summary: `Generate prompts for ${id}` }, (op) => stageProjectPrompts(ws, op, project, providers));
  return { status: out.noop ? 'unchanged' : 'generated', project_id: id, files: out.files, verified: out.verified };
}

module.exports = {
  coreName,
  domainOf,
  isNonOfficialHost,
  isAggregatorName,
  NON_OFFICIAL_HOSTS,
  loadProject,
  getProject,
  listProjects,
  findDuplicates,
  addProject,
  setWatchlist,
  updateIdentity,
  setDefillamaBinding,
  setHeadline,
  archiveProject,
  restoreProject,
  updateProjectFields,
  markReviewed,
  generatePrompts,
  mutateProject,
  requireProjectId,
};
