'use strict';
// cr-forensic-eligibility@1: what the desk itself can check about the
// evidence an assessment cites, and therefore what may feed a derived result
// (coverage, a displayed grade, the headline's attribution, an outcome
// reading). Pure; no network.
//
// Three things are kept apart:
//   - the assistant's report: its findings and scores, kept exactly as saved;
//   - the desk's checks: does each reference resolve, is the source dated,
//     is something preserved that can be re-read (an excerpt, a content
//     hash, a block, commit or transaction), is it tied to this project's
//     identity (its official domain, a chain reference, a repository), and
//     does a measurement name this project's chain, contract or pool;
//   - what stays unresolved: whether the cited content actually says what
//     the finding says. The desk does not read meaning, so passing these
//     checks is never "verified", only "the references hold".
//
// A source that cannot be opened today can still be valid historical
// evidence when its capture (excerpt, hash, block or transaction) was kept.
// A type the report declares ("primary") is the report's own label: it never
// establishes authority by itself.

const D = require('./forensic-defs');
const { chainInfo, addressKey } = require('./chains');

const VERSION = 'cr-forensic-eligibility@1';
const MIN_EXCERPT = 20;

const tOf = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);

function hostOf(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// The registrable part of a host, approximately: its last two labels
// (docs.example.com -> example.com). Good enough to tie a page to the
// project's own site; never used to call a page trustworthy.
function siteOf(host) {
  if (!host) return null;
  const parts = host.replace(/\.$/, '').split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function identityContext(identity) {
  const id = identity || {};
  const site = siteOf(hostOf(id.official_website));
  const chains = [];
  for (const a of id.chains_and_contracts || id.assets || []) {
    const info = chainInfo(a.chain);
    chains.push({ chain: String(a.chain || '').trim().toLowerCase(), chain_id: info ? info.chain_id : null, family: info ? info.family : null, contract: typeof a.contract_address === 'string' ? a.contract_address.trim() : null });
  }
  return { site, chains };
}

// Does a chain name in an observation name one of the identity's chains?
// By the desk's chain table when both are known, else by the exact name.
function chainMatch(ctx, chain) {
  if (typeof chain !== 'string' || !chain.trim()) return null;
  const info = chainInfo(chain);
  const name = chain.trim().toLowerCase();
  return ctx.chains.find((c) => (info && c.chain_id ? c.chain_id === info.chain_id : c.chain === name)) || null;
}

function checkSource(s, ctx) {
  const host = hostOf(s.url);
  const repo = host === 'github.com' || host === 'gitlab.com' ? /^\/[^/]+\/[^/]+/.test(new URL(s.url).pathname) : false;
  const chainRef = Boolean(s.tx_signature || (s.type === 'chain' && s.block_or_commit));
  const capture = s.excerpt && s.excerpt.length >= MIN_EXCERPT ? 'excerpt' : s.content_sha256 ? 'hash' : chainRef ? 'chain_reference' : s.block_or_commit ? 'commit_reference' : 'none';
  const dated = Number.isFinite(tOf(s.retrieved_at)) || Number.isFinite(tOf(s.event_time));
  let attribution = 'not_established';
  if (host && ctx.site && siteOf(host) === ctx.site) attribution = 'official_domain';
  else if (chainRef) attribution = 'chain_reference';
  else if (repo) attribution = 'repository';
  const reasons = [];
  if (!host && !chainRef) reasons.push(s.url_given ? 'its address is not an http(s) address the desk accepts' : 'no address and no chain reference');
  if (!dated) reasons.push('no retrieval or event time');
  if (capture === 'none') reasons.push('nothing preserved to re-read (no excerpt, content hash, block, commit or transaction)');
  const usable = (Boolean(host) || chainRef) && dated && capture !== 'none';
  return {
    source_id: s.source_id,
    declared_type: s.type,
    address: host ? 'http' : chainRef ? 'chain' : 'none',
    dated,
    capture,
    attribution,
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

function checkFinding(f, sources, ctx) {
  const missing = f.source_ids.filter((id) => !sources[id]);
  const usable = f.source_ids.filter((id) => sources[id] && sources[id].usable);
  const ek = effectiveKind(f);
  const reasons = [];
  if (!f.source_ids.length) reasons.push('cites no source');
  if (missing.length) reasons.push(`cites ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the source list`);
  if (f.source_ids.length && !missing.length && !usable.length) reasons.push('none of its sources is dated with something preserved to re-read');
  const dated = Number.isFinite(tOf(f.event_time)) || Number.isFinite(tOf(f.retrieved_at)) || usable.some((id) => sources[id].dated);
  if (ek.kind === 'observation' && !dated) reasons.push('an observation with no time');
  const eligible = !missing.length && usable.length > 0 && (ek.kind !== 'observation' || dated);
  const attributable = eligible && usable.some((id) => ['official_domain', 'chain_reference'].includes(sources[id].attribution));
  return {
    finding_id: f.finding_id,
    standing: eligible ? 'references_hold' : 'report_claim',
    eligible,
    attributable,
    cited: f.source_ids.length,
    missing,
    usable_sources: usable,
    effective_kind: ek.kind,
    kind_note: ek.note,
    reasons,
  };
}

// The whole assessment under cr-forensic-eligibility@1.
function evaluate(a, { identity } = {}) {
  const ctx = identityContext(identity);
  const sources = Object.fromEntries((a.sources || []).map((s) => [s.source_id, checkSource(s, ctx)]));
  const findings = Object.fromEntries((a.findings || []).map((f) => [f.finding_id, checkFinding(f, sources, ctx)]));
  const grades = {};
  for (const [id, g] of Object.entries(a.category_grades || {})) {
    if (g.status !== 'scored') { grades[id] = { usable: false, reported: g.status, reason: null }; continue; }
    const missing = (g.finding_ids || []).filter((x) => !findings[x]);
    const eligible = (g.finding_ids || []).filter((x) => findings[x] && findings[x].eligible);
    const usable = !missing.length && eligible.length > 0;
    grades[id] = { usable, reported: 'scored', reason: usable ? null : missing.length ? `rests on ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not a finding` : 'none of the findings it rests on has references that hold' };
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
    note: 'The share of the seven evidence areas backed by findings whose references hold (resolved, dated, something preserved to re-read). The desk does not check that a source says what a finding says. Not a score and not research progress.',
  };
}

// Binding of a measurement captured in an assessment to the receipt's frozen
// identity and to its own source. Returns { bound, reason }.
function bindLiquidity(o, ev, { savedAt = null } = {}) {
  const c = chainMatch(ev.identity, o.chain);
  if (!c) return { bound: false, reason: `its chain (${o.chain || 'none'}) is not a chain of this project's identity` };
  if (o.contract_address && c.contract && c.family && addressKey(c.family, o.contract_address) !== addressKey(c.family, c.contract)) return { bound: false, reason: 'its contract is not this project\'s contract on that chain' };
  if (o.contract_address && c.contract && !c.family && o.contract_address.trim() !== c.contract) return { bound: false, reason: 'its contract is not this project\'s contract on that chain' };
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
  const host = hostOf(o.url);
  if (!host) return { bound: false, reason: 'no checked address' };
  if (ev.identity.site && siteOf(host) !== ev.identity.site) return { bound: false, reason: `its address (${host}) is not on the project's own site (${ev.identity.site})` };
  return bindSourceAndTime(o, ev, o.observed_at, opts);
}

function bindRepository(o, ev, opts) {
  if (typeof o.repository !== 'string' || !/^(https?:\/\/)?(github\.com|gitlab\.com)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/i.test(o.repository.trim())) return { bound: false, reason: 'the repository is not a github.com or gitlab.com owner/name' };
  return bindSourceAndTime(o, ev, o.observed_at, opts);
}

// A monitor quote belongs to a receipt only when its contract is in that
// receipt's frozen identity.
function monitorQuoteBound(o, ev) {
  const c = ev.identity.chains.find((x) => x.chain_id && String(x.chain_id) === String(o.chain_id));
  if (!c || !c.contract || !o.contract_address) return false;
  return c.family ? addressKey(c.family, c.contract) === addressKey(c.family, o.contract_address) : c.contract === o.contract_address;
}

module.exports = { VERSION, hostOf, siteOf, identityContext, chainMatch, checkSource, effectiveKind, checkFinding, evaluate, coverage, bindLiquidity, bindProduct, bindRepository, monitorQuoteBound };
