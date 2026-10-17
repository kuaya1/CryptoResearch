'use strict';
// cr-forensic-eligibility@2: what the desk itself can check about the
// evidence an assessment cites, and therefore what may feed a derived result
// (coverage, a displayed grade, the headline's attribution, an outcome
// reading). Pure; no network.
//
// Three things are kept apart:
//   - the assistant's report: its findings and scores, kept exactly as saved;
//   - the desk's checks: does each reference resolve, is the source dated,
//     is something preserved that can be re-read (an excerpt, a content
//     hash, a block or commit, a full transaction ID), is it on the project's
//     own site, and does a measurement name this project's chain and
//     contract, or a repository bound to it;
//   - what stays unresolved: whether the cited content actually says what
//     the finding says. The desk does not read meaning, so passing these
//     checks is never "verified", only "the references hold".
//
// @2 (2026-10-17, after the re-audit R01-R03) replaces @1's rules:
//   - authority is the official website's exact host (with or without www),
//     a subdomain of it, or, for a path-scoped official site (a page on a
//     shared host), that path; never the last two labels of a host, so two
//     tenants of co.uk, github.io or one shared host never share authority;
//   - a transaction ID counts as a preserved chain record only in a full
//     form (an EVM hash, a Solana signature), and confers no attribution: a
//     v1 block cannot bind it to this project's contract;
//   - a finding's references hold only when every cited source is usable;
//   - a measurement binds only when it names this project's contract on that
//     chain (never filled in from the identity), and a repository only when
//     it is exactly one the frozen identity names, Eric approved, or a
//     preserved capture on the official site names.
//
// A source that cannot be opened today can still be valid historical
// evidence when its capture was kept. A type the report declares
// ("primary") is the report's own label: it never establishes authority.

const D = require('./forensic-defs');
const { chainInfo, addressKey } = require('./chains');

const VERSION = 'cr-forensic-eligibility@2';
const MIN_EXCERPT = 20;

const tOf = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);

function hostOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase().replace(/\.$/, '') : null;
  } catch (_) {
    return null;
  }
}

const bareHost = (h) => (h && h.startsWith('www.') ? h.slice(4) : h);

// The official site as the authority test needs it: its host without www,
// and its path when the site is a page rather than a whole host.
function officialOf(url) {
  const host = hostOf(url);
  if (!host) return null;
  let p = '/';
  try { p = new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch (_) { /* host only */ }
  return { host: bareHost(host), path: p === '/' ? null : p };
}

// Is this address on the project's own site? Exact host or a subdomain of
// it; for a path-scoped site, the same host and that path (whole segments).
function onOfficialSite(official, url) {
  if (!official) return false;
  const host = bareHost(hostOf(url));
  if (!host) return false;
  if (official.path) {
    if (host !== official.host) return false;
    let p = '/';
    try { p = new URL(url).pathname; } catch (_) { return false; }
    return p === official.path || p.startsWith(`${official.path}/`);
  }
  return host === official.host || host.endsWith(`.${official.host}`);
}

// Kept for callers of @1 (the tab's links); never used for authority.
function siteOf(host) {
  return bareHost(host || null);
}

const repoKey = (s) => {
  const m = String(s || '').trim().match(/^(?:https?:\/\/)?(github\.com|gitlab\.com)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
};

function identityContext(identity, { approvedRepositories = [] } = {}) {
  const id = identity || {};
  const official = officialOf(id.official_website);
  const chains = [];
  for (const a of id.chains_and_contracts || id.assets || []) {
    const info = chainInfo(a.chain);
    chains.push({ chain: String(a.chain || '').trim().toLowerCase(), chain_id: info ? info.chain_id : null, family: info ? info.family : null, contract: typeof a.contract_address === 'string' && a.contract_address.trim() ? a.contract_address.trim() : null });
  }
  const repositories = [...new Set([...(id.evidence_urls || []), id.official_website].map(repoKey).filter(Boolean).concat(approvedRepositories.map(repoKey).filter(Boolean)))];
  return { site: official ? official.host : null, official, chains, repositories };
}

// The identity's entries on the chain an observation names: by the desk's
// chain table when known, else by the exact name.
function chainEntries(ctx, chain) {
  if (typeof chain !== 'string' || !chain.trim()) return [];
  const info = chainInfo(chain);
  const name = chain.trim().toLowerCase();
  return ctx.chains.filter((c) => (info && c.chain_id ? c.chain_id === info.chain_id : c.chain === name));
}
function chainMatch(ctx, chain) {
  return chainEntries(ctx, chain)[0] || null;
}

// A transaction ID in a form a chain uses, and whether that chain family is
// in the identity. An abbreviated or odd string is no chain record.
function chainRefOf(s, ctx) {
  const tx = typeof s.tx_signature === 'string' ? s.tx_signature.trim() : '';
  if (!tx) return null;
  const shape = /^0x[0-9a-fA-F]{64}$/.test(tx) ? 'evm_tx' : /^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(tx) ? 'solana_signature' : 'unrecognized';
  const fam = shape === 'evm_tx' ? 'evm' : shape === 'solana_signature' ? 'solana' : null;
  return { shape, fits_identity: Boolean(fam && ctx.chains.some((c) => c.family === fam)) };
}

function checkSource(s, ctx) {
  const host = hostOf(s.url);
  const ref = chainRefOf(s, ctx);
  const chainRef = Boolean(ref && ref.shape !== 'unrecognized');
  const capture = s.excerpt && s.excerpt.length >= MIN_EXCERPT ? 'excerpt' : s.content_sha256 ? 'hash' : chainRef ? 'chain_reference' : s.block_or_commit ? 'commit_reference' : 'none';
  const dated = Number.isFinite(tOf(s.retrieved_at)) || Number.isFinite(tOf(s.event_time));
  const official = onOfficialSite(ctx.official, s.url);
  const attribution = official ? 'official_domain' : 'not_established';
  const reasons = [];
  if (!host && !chainRef) reasons.push(s.url_given ? 'its address is not an http(s) address the desk accepts' : 'no address and no full chain reference');
  if (ref && ref.shape === 'unrecognized') reasons.push('its transaction ID is not in a full form a chain uses');
  if (!dated) reasons.push('no retrieval or event time');
  if (capture === 'none') reasons.push('nothing preserved to re-read (no excerpt, content hash, block, commit or full transaction ID)');
  const usable = (Boolean(host) || chainRef) && dated && capture !== 'none';
  return {
    source_id: s.source_id,
    declared_type: s.type,
    address: host ? 'http' : chainRef ? 'chain' : 'none',
    dated,
    capture,
    attribution,
    chain_ref: ref,
    chain_ref_note: chainRef ? 'A chain record is preserved, but a v1 block cannot bind it to this project\'s contract, so it confers no attribution.' : null,
    usable,
    self_labelled_primary: s.type === 'primary' && attribution !== 'official_domain',
    reasons,
  };
}

const WEAK = new Set(D.WEAK_CONTROL_BASES);

// The kind a finding is shown as. Common control of wallets is an inference
// even when the transfers behind it were observed; resting only on weak
// bases it is an unestablished hypothesis.
function effectiveKind(f) {
  if (f.wallet_relation === 'inferred_common_control') {
    if (f.basis && f.basis.length && f.basis.every((b) => WEAK.has(b))) return { kind: 'hypothesis', note: 'Common control is not established: a shared exchange funder, similar balances, similar timing or a zero-balance deployer proves nothing on its own.' };
    return { kind: 'inference', note: f.kind === 'observation' ? 'Stated as an observation; common control of wallets is an inference.' : null };
  }
  return { kind: f.kind, note: null };
}

function checkFinding(f, sources) {
  const missing = f.source_ids.filter((id) => !sources[id]);
  const usable = f.source_ids.filter((id) => sources[id] && sources[id].usable);
  const unusable = f.source_ids.filter((id) => sources[id] && !sources[id].usable);
  const ek = effectiveKind(f);
  const reasons = [];
  if (!f.source_ids.length) reasons.push('cites no source');
  if (missing.length) reasons.push(`cites ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the source list`);
  if (unusable.length) reasons.push(`${unusable.join(', ')} ${unusable.length === 1 ? 'is' : 'are'} not dated with something preserved to re-read`);
  const dated = Number.isFinite(tOf(f.event_time)) || Number.isFinite(tOf(f.retrieved_at)) || usable.some((id) => sources[id].dated);
  if (ek.kind === 'observation' && !dated) reasons.push('an observation with no time');
  const all = f.source_ids.length > 0 && !missing.length && !unusable.length;
  const eligible = all && (ek.kind !== 'observation' || dated);
  const attributable = eligible && usable.some((id) => sources[id].attribution === 'official_domain');
  const standing = eligible ? 'references_hold' : !missing.length && usable.length ? 'references_partly_hold' : 'report_claim';
  return {
    finding_id: f.finding_id,
    standing,
    eligible,
    attributable,
    cited: f.source_ids.length,
    missing,
    usable_sources: usable,
    unusable_sources: unusable,
    effective_kind: ek.kind,
    kind_note: ek.note,
    reasons,
  };
}

// The whole assessment under cr-forensic-eligibility@2.
function evaluate(a, { identity, approvedRepositories = [] } = {}) {
  const ctx = identityContext(identity, { approvedRepositories });
  const sources = Object.fromEntries((a.sources || []).map((s) => [s.source_id, checkSource(s, ctx)]));
  // Repositories a preserved capture on the official site names exactly.
  for (const s of a.sources || []) {
    const k = sources[s.source_id];
    if (!k || !k.usable || k.attribution !== 'official_domain' || !s.excerpt) continue;
    for (const m of String(s.excerpt).matchAll(/(?:https?:\/\/)?(?:github\.com|gitlab\.com)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/gi)) {
      const key = repoKey(m[0].replace(/[.,;:)]+$/, ''));
      if (key && !ctx.repositories.includes(key)) ctx.repositories.push(key);
    }
  }
  const findings = Object.fromEntries((a.findings || []).map((f) => [f.finding_id, checkFinding(f, sources)]));
  const grades = {};
  for (const [id, g] of Object.entries(a.category_grades || {})) {
    if (g.status !== 'scored') { grades[id] = { usable: false, reported: g.status, reason: null }; continue; }
    const missing = (g.finding_ids || []).filter((x) => !findings[x]);
    const held = (g.finding_ids || []).filter((x) => findings[x] && findings[x].eligible);
    const notHeld = (g.finding_ids || []).filter((x) => findings[x] && !findings[x].eligible);
    const usable = !missing.length && held.length > 0 && !notHeld.length;
    grades[id] = { usable, reported: 'scored', reason: usable ? null : missing.length ? `rests on ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a finding` : notHeld.length ? `rests on ${notHeld.join(', ')}, whose references do not all hold` : 'none of the findings it rests on has references that hold' };
  }
  return { version: VERSION, identity: ctx, sources, findings, grades };
}

// Coverage under the eligibility checks: an area is covered only by findings
// whose references hold.
function coverage(a, ev) {
  const out = [];
  for (const [id, label] of D.AREAS) {
    const declared = (a.evidence_coverage && a.evidence_coverage.areas && a.evidence_coverage.areas[id]) || 'unknown';
    const inArea = (a.findings || []).filter((f) => f.area === id);
    const held = inArea.filter((f) => ev.findings[f.finding_id] && ev.findings[f.finding_id].eligible).length;
    const claimed = inArea.length - held;
    let status = 'unknown';
    let note = null;
    if (held && declared === 'covered') status = 'covered';
    else if (held) {
      status = 'partial';
      note = declared === 'unknown' ? 'Declared unknown, with findings whose references hold.' : null;
    } else if (inArea.length && declared !== 'unknown') {
      status = 'partial';
      note = 'Declared covered or partial, but no finding here has references that hold: report claims only.';
    } else if (declared !== 'unknown') {
      note = `Declared ${declared}, with no finding in this area to back it.`;
    }
    out.push({ area: id, label, declared, status, sourced_findings: held, report_claims: claimed, note });
  }
  return {
    version: VERSION,
    of: out.length,
    covered: out.filter((x) => x.status === 'covered').length,
    partial: out.filter((x) => x.status === 'partial').length,
    unknown: out.filter((x) => x.status === 'unknown').length,
    areas: out,
    note: 'The share of the seven evidence areas backed by findings whose references all hold (resolved, dated, something preserved to re-read). The desk does not check that a source says what a finding says. Not a score and not research progress.',
  };
}

// Binding of a measurement captured in an assessment to the receipt's frozen
// identity and to its own source. Returns { bound, reason, chain? }. The
// contract must be named by the measurement itself: it is never filled in.
function bindLiquidity(o, ev, { savedAt = null } = {}) {
  const entries = chainEntries(ev.identity, o.chain);
  if (!entries.length) return { bound: false, reason: `its chain (${o.chain || 'none'}) is not a chain of this project's identity` };
  const named = typeof o.contract_address === 'string' && o.contract_address.trim() ? o.contract_address.trim() : null;
  if (!named) return { bound: false, reason: entries.some((c) => c.contract) ? 'it names no token contract, so it is not known to be this project\'s token' : 'it names no token, and a v1 block cannot name a native coin explicitly' };
  const c = entries.find((x) => x.contract && (x.family ? addressKey(x.family, x.contract) === addressKey(x.family, named) : x.contract === named));
  if (!c) return { bound: false, reason: 'its contract is not this project\'s contract on that chain' };
  const b = bindSourceAndTime(o, ev, o.retrieved_at, { savedAt });
  return b.bound ? { ...b, chain: c } : b;
}

function bindSourceAndTime(o, ev, at, { savedAt = null } = {}) {
  const s = o.source_id ? ev.sources[o.source_id] : null;
  if (!s) return { bound: false, reason: o.source_id ? `its source ${o.source_id} is not in the source list` : 'it cites no source' };
  if (!s.usable) return { bound: false, reason: `its source ${o.source_id} has nothing dated and preserved to re-read` };
  const t = tOf(at);
  if (!Number.isFinite(t)) return { bound: false, reason: 'it has no observation time' };
  if (savedAt && t > tOf(savedAt) + 10 * 60000) return { bound: false, reason: 'its time is after the assessment was saved' };
  return { bound: true, reason: null };
}

function bindProduct(o, ev, opts) {
  if (!hostOf(o.url)) return { bound: false, reason: 'no checked address' };
  if (!onOfficialSite(ev.identity.official, o.url)) return { bound: false, reason: `its address (${hostOf(o.url)}) is not on the project's own site${ev.identity.site ? ` (${ev.identity.site})` : ''}` };
  return bindSourceAndTime(o, ev, o.observed_at, opts);
}

// A repository binds only when it is exactly one the frozen identity names,
// Eric approved for monitoring, or a preserved capture on the official site
// names; a well-formed address alone is not the project's.
function bindRepository(o, ev, opts) {
  const key = repoKey(o.repository);
  if (!key) return { bound: false, reason: 'the repository is not exactly a github.com or gitlab.com owner/name' };
  if (!(ev.identity.repositories || []).includes(key)) return { bound: false, reason: `${key} is not a repository bound to this project (its identity, Eric's approval, or a capture on its own site naming it)` };
  return bindSourceAndTime(o, ev, o.observed_at, opts);
}

// A monitor quote belongs to a receipt only when its contract is in that
// receipt's frozen identity.
function monitorQuoteBound(o, ev) {
  const c = ev.identity.chains.find((x) => x.chain_id && String(x.chain_id) === String(o.chain_id) && x.contract && o.contract_address && (x.family ? addressKey(x.family, x.contract) === addressKey(x.family, o.contract_address) : x.contract === o.contract_address));
  return Boolean(c);
}

module.exports = { VERSION, hostOf, siteOf, officialOf, onOfficialSite, repoKey, identityContext, chainMatch, chainEntries, checkSource, effectiveKind, checkFinding, evaluate, coverage, bindLiquidity, bindProduct, bindRepository, monitorQuoteBound };
