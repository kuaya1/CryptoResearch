'use strict';
// The case package (cr.forensic-case.v1, 2026-10-17, the re-audit's ranked
// improvement #1): one forensic receipt as a self-contained file that a
// second reader can verify and replay offline.
//
// What it holds, all read from records already on the desk (nothing is
// fetched, retrieved or asked of any model or provider):
//   - the verified original report text, the frozen investigator prompt and
//     evidence packet, and the receipt record as saved (originals, byte for
//     byte); the ChatGPT challenge of this receipt and its frozen prompt,
//     when there is one;
//   - the monitor observations bound to the receipt's frozen identity in its
//     horizon (original records, each with its own SHA-256);
//   - a manifest: the exact receipt, audit and project identity, versions,
//     pins, every source with what the desk could check about it, every
//     observation ID, and one deterministic exit calculation with all its
//     inputs (chain, contract, decimals, quantity, valuation time, quote or
//     reserves, and the fee, gas and tax basis);
//   - an explicit list of what is missing: the desk keeps the excerpt and
//     hash a report states, not the pages themselves, so every source page
//     is listed as not preserved, never presented as its hash.
//
// What it never holds: credentials, session tokens or headers, settings,
// holdings, transactions, wallets, notes or other projects. Nothing is
// redacted from an original; the package has no redacted derivatives.
//
// verifyCase() checks every file against its SHA-256 and the manifest's
// pins, checks the receipt's stored projection against its original block,
// and replays the calculation with forensic-model.js: pure, no network.

const { OpError } = require('./ops');
const { sha256 } = require('./fsx');

const FORMAT = 'cr.forensic-case.v1';
const MAX_OBSERVATIONS = 2000;
const PAGE_NOTE = 'The page itself was not preserved by the desk: this release keeps the excerpt, hash, block, commit or transaction the report states, not the page.';

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const manifestHash = (m) => sha256(canonical(m));

const file = (path, role, content, preserved = 'original') => ({ path, role, preserved, content, sha256: sha256(content), bytes: Buffer.byteLength(content) });

// The one deterministic calculation: the exit at the receipt's position
// size from the latest reading bound to the receipt, with every input.
function calculationOf(F, M, XQ, { receipt, readings, observations }) {
  const prefs = receipt.preferences || {};
  const size = prefs.exit_position_usd;
  const limit = prefs.exit_cost_limit_pct;
  const bound = readings.liqObs.filter((o) => o.kind === 'executable_quote' || o.kind === 'pool_reserves');
  const atSize = bound.map((o) => ({ o, e: M.exitEstimate(o, size, { tax: readings.tax(o) }) })).filter((x) => x.e && (x.e.status === 'estimated' || x.e.status === 'no_route'));
  if (!atSize.length) {
    const why = readings.unbound.filter((u) => u.measure === 'liquidity' || u.measure === 'exit_quote').map((u) => u.reason);
    return { status: 'unavailable', reason: `No reading bound to this receipt speaks to the $${size} position${why.length ? `; not counted: ${why.slice(0, 3).join(' ')}` : '.'}`, size_usd: size };
  }
  atSize.sort((a, b) => String(a.o.retrieved_at).localeCompare(String(b.o.retrieved_at)));
  const { o, e } = atSize[atSize.length - 1];
  const rec = o.source === 'monitor' ? observations.find((x) => x.obs_id === o.obs_id) || null : null;
  const inputs = {
    kind: o.kind,
    captured_by: o.source === 'monitor' ? 'monitor' : 'audit',
    obs_id: o.obs_id || null,
    obs_sha256: rec ? rec.sha256 : null,
    receipt_id: o.receipt_id || (o.source === 'monitor' ? null : receipt.receipt_id),
    chain: o.chain || null,
    chain_id: o.chain_id || null,
    contract_address: o.contract_address || null,
    retrieved_at: o.retrieved_at || null,
    size_usd: size,
    route_scope: o.route_scope || null,
    mechanism: o.mechanism || null,
    quote: o.quote ? { sell_usd: o.quote.sell_usd ?? null, received_usd: o.quote.received_usd ?? null, gas_usd: o.quote.gas_usd ?? null, gas_included: o.quote.gas_included === true, no_route: o.quote.no_route === true } : null,
    reserves: o.kind === 'pool_reserves' ? { base_reserve: o.base_reserve, quote_reserve: o.quote_reserve, quote_usd_price: o.quote_usd_price, fee_bps: o.fee_bps } : null,
    token: o.token ? { decimals: o.token.decimals, platform: o.token.platform || null, checked_at: o.token.checked_at || null } : null,
    amount_in: o.amount_in || null,
    price: o.price ? { usd: o.price.usd, as_of: o.price.as_of } : null,
    tax: e.tax || null,
  };
  return {
    status: 'supported',
    method: e.version,
    limit_pct: limit,
    inputs,
    result: { status: e.status, received_usd: e.received_usd ?? null, net_received_usd: e.net_received_usd ?? null, cost_pct: e.cost_pct ?? null, cost_complete: e.cost_complete ?? null, missing_costs: e.missing_costs || [] },
    basis: { fees: o.kind === 'executable_quote' ? 'route fees and price impact are inside the quoted amount' : `pool fee ${o.fee_bps} bps, price impact from the reserves`, gas: inputs.quote && inputs.quote.gas_included ? 'inside the quote' : inputs.quote && inputs.quote.gas_usd !== null ? `external, $${inputs.quote.gas_usd}` : 'unknown', tax: inputs.tax ? (inputs.tax.pct === 0 ? `0% (${inputs.tax.source})` : `${inputs.tax.pct}% (${inputs.tax.source}); not applied: its mechanism and whether the quote includes it are not known`) : 'unknown', one_way: true },
    quantity_check: inputs.amount_in && inputs.token && inputs.price ? { expected_amount_in: XQ.baseUnitsFor(size, inputs.price.usd, inputs.token.decimals), note: 'The quoted amount is the position size at the stored price, in the token\'s base units for this exact chain and contract.' } : null,
  };
}

function buildCase(ws, pid, rid, { now = Date.now() } = {}) {
  const F = require('./forensics');
  const M = require('./forensic-model');
  const E = require('./forensic-eligibility');
  const D = require('./forensic-defs');
  const XQ = require('./exitquotes');
  const project = require('./projects').getProject(ws, pid);
  const r = F.loadReceipt(ws, pid, rid);
  if (!r || r.kind !== 'assessment') throw new OpError('NOT_FOUND', `No forensic assessment ${rid} for ${pid}.`);
  const integ = F.receiptIntegrity(ws, pid, r);
  if (!integ.ok) throw new OpError('INTEGRITY', `No case package: ${rid} does not agree with its original (${integ.problems.join('; ')}).`);
  const audit = F.loadAudit(ws, pid, r.audit_id);
  const text = F.verifiedFrozen(ws, r.text.path, r.text.sha256, `The saved text of ${rid}`);
  const prompt = F.verifiedFrozen(ws, audit.prompt.path, audit.prompt.sha256, 'The frozen investigator prompt');
  const packet = F.verifiedFrozen(ws, audit.evidence_packet.path, audit.evidence_packet.sha256, 'The frozen evidence packet');
  const record = require('fs').readFileSync(ws.abs(F.receiptRel(pid, rid)), 'utf8');
  const files = [
    file('original/report.md', 'original_report', text),
    file('frozen/prompt.investigator.md', 'frozen_prompt', prompt),
    file('frozen/evidence-packet.json', 'evidence_packet', packet),
    file('receipt/receipt.json', 'receipt_record', record),
  ];
  const missing = [];
  // The challenge of this exact receipt, when one is saved and intact.
  const receipts = F.listReceipts(ws, pid).filter((x) => !x.broken);
  const ch = receipts.filter((x) => x.kind === 'challenge' && x.challenges_receipt_id === rid).sort((a, b) => String(a.saved_at).localeCompare(String(b.saved_at))).pop() || null;
  let challenge = null;
  if (ch) {
    if (!F.receiptIntegrity(ws, pid, ch).ok) missing.push({ what: `challenge ${ch.receipt_id}`, reason: 'It does not agree with its original, so it is not included.' });
    else {
      files.push(file('challenge/challenge.md', 'challenge_original', F.verifiedFrozen(ws, ch.text.path, ch.text.sha256, `The saved text of ${ch.receipt_id}`)));
      files.push(file('challenge/receipt.json', 'challenge_record', require('fs').readFileSync(ws.abs(F.receiptRel(pid, ch.receipt_id)), 'utf8')));
      const crel = `${F.dirOf(pid)}/audits/${r.audit_id}/prompt.challenge.${rid}.md`;
      const ctext = (() => { try { return require('fs').readFileSync(ws.abs(crel), 'utf8'); } catch (_) { return null; } })();
      if (ctext !== null) files.push(file('challenge/prompt.challenge.md', 'challenge_prompt', ctext));
      else missing.push({ what: 'the challenge prompt', reason: 'Not on record for this receipt.' });
      challenge = { receipt_id: ch.receipt_id, saved_at: ch.saved_at, model: ch.model && ch.model.provider, text_sha256: ch.text.sha256, block_sha256: ch.block_sha256, assessment_sha256: ch.assessment_sha256 };
    }
  }
  // The readings bound to this receipt, as the desk derives them now.
  const prof = F.readProfile(ws, pid);
  const readings = F.readingsFor(ws, pid, { receipts, prefs: r.preferences, now, identityReceipt: r, taxOf: F.taxIndex(ws, pid, now), profile: prof });
  const until = Math.min(now, Date.parse((r.deadlines || []).slice(-1)[0] ? r.deadlines.slice(-1)[0].at : r.origin) || now);
  const from = Date.parse(r.origin) - 7 * 86400000;
  const inWindow = readings.observations.filter((o) => Date.parse(o.observed_at) >= from && Date.parse(o.observed_at) <= until);
  const kept = inWindow.slice(-MAX_OBSERVATIONS);
  if (inWindow.length > kept.length) missing.push({ what: `${inWindow.length - kept.length} older monitor observations`, reason: `Only the latest ${MAX_OBSERVATIONS} in the receipt's horizon are included.` });
  files.push(file('observations/monitor.json', 'observation_log', JSON.stringify(kept, null, 2), 'original_records'));
  const ev = F.eligibilityOf(r, (prof.targets.repositories || []).map((t) => `github.com/${t.owner}/${t.repo}`));
  const sources = (r.assessment.sources || []).map((s) => {
    const k = ev.sources[s.source_id];
    missing.push({ what: `source ${s.source_id}${s.url ? ` (${s.url})` : ''}`, reason: PAGE_NOTE });
    return { source_id: s.source_id, url: s.url || null, declared_type: s.type, retrieved_at: s.retrieved_at || null, event_time: s.event_time || null, excerpt: s.excerpt || null, content_sha256: s.content_sha256 || null, block_or_commit: s.block_or_commit || null, tx_signature: s.tx_signature || null, desk_check: k ? { usable: k.usable, capture: k.capture, attribution: k.attribution, reasons: k.reasons } : null, capture_file: null };
  });
  const calculation = calculationOf(F, M, XQ, { receipt: r, readings, observations: kept });
  if (calculation.status !== 'supported') missing.push({ what: 'an exit calculation', reason: calculation.reason });
  const manifest = {
    format: FORMAT,
    built_at: new Date(now).toISOString(),
    note: 'A forensic receipt as saved, for verification and offline replay. Hashes show the files have not changed since they were saved; they do not show that what they say is true.',
    project: { project_id: pid, name: project.name },
    receipt: { receipt_id: rid, audit_id: r.audit_id, kind: r.kind, role: r.role, model: r.model && r.model.provider, saved_at: r.saved_at, assessment_as_of: r.assessment_as_of || r.origin, origin: r.origin, origin_basis: r.origin_basis || null, deadlines: r.deadlines, revision_of: r.revision_of || null, revision: r.revision || null },
    audit: { audit_id: r.audit_id, created_at: audit.created_at, definitions: audit.definitions, preferences: r.preferences },
    versions: { prompt: r.versions && r.versions.prompt, format: r.versions && r.versions.format, method_saved: r.method || 'cr-forensic-method@1', method_now: D.METHOD_VERSION, eligibility: E.VERSION, liquidity: D.LIQUIDITY_VERSION_3, case: FORMAT },
    pins: { text_sha256: r.text.sha256, block_sha256: r.block_sha256, prompt_sha256: audit.prompt.sha256, evidence_packet_sha256: audit.evidence_packet.sha256 },
    integrity_at_build: integ,
    challenge,
    sources,
    observations: kept.map((o) => ({ obs_id: o.obs_id, sha256: o.sha256, kind: o.kind, observed_at: o.observed_at, target_id: o.target_id || null })),
    not_counted: readings.unbound,
    calculation,
    missing,
    redacted: [],
    excluded: ['credentials, session tokens and request headers', 'settings', 'holdings, transactions and accounts', 'tracked wallets', 'notes and the journal', 'other projects'],
    artifacts: files.map(({ path, role, preserved, sha256: h, bytes }) => ({ path, role, preserved, sha256: h, bytes })),
  };
  return { format: FORMAT, manifest, manifest_sha256: manifestHash(manifest), files: files.map(({ path, sha256: h, content }) => ({ path, encoding: 'utf8', sha256: h, content })) };
}

// Replays the calculation from its inputs alone.
function replay(calc) {
  const M = require('./forensic-model');
  const XQ = require('./exitquotes');
  if (!calc || calc.status !== 'supported') return { status: 'unavailable', reason: calc ? calc.reason : 'No calculation in the package.' };
  const i = calc.inputs;
  const obs = i.kind === 'pool_reserves'
    ? { kind: 'pool_reserves', mechanism: i.mechanism, ...i.reserves, retrieved_at: i.retrieved_at }
    : { kind: 'executable_quote', route_scope: i.route_scope, retrieved_at: i.retrieved_at, quote: i.quote, source: i.captured_by === 'monitor' ? 'monitor' : undefined, amount_in: i.amount_in, token: i.token, price: i.price };
  const e = M.exitEstimate(obs, i.size_usd, { tax: i.tax });
  const got = e ? { status: e.status, received_usd: e.received_usd ?? null, net_received_usd: e.net_received_usd ?? null, cost_pct: e.cost_pct ?? null, cost_complete: e.cost_complete ?? null, missing_costs: e.missing_costs || [] } : null;
  const differences = got ? Object.keys(calc.result).filter((k) => JSON.stringify(calc.result[k]) !== JSON.stringify(got[k])) : ['the calculation gave no estimate'];
  let quantity = null;
  if (calc.quantity_check) {
    const again = XQ.baseUnitsFor(i.size_usd, i.price.usd, i.token.decimals);
    quantity = { expected: calc.quantity_check.expected_amount_in, recomputed: again, quoted: i.amount_in, matches: again === i.amount_in && again === calc.quantity_check.expected_amount_in };
  }
  return { status: differences.length || (quantity && !quantity.matches) ? 'differs' : 'reproduced', expected: calc.result, got, differences, quantity };
}

// Verifies a package: pure, no network, no workspace needed.
function verifyCase(pkg) {
  const problems = [];
  const corrupt = [];
  const present = [];
  if (!pkg || pkg.format !== FORMAT || !pkg.manifest) return { status: 'failed', problems: [`Not a ${FORMAT} package.`], present, corrupt, missing: [] };
  const m = pkg.manifest;
  if (manifestHash(m) !== pkg.manifest_sha256) problems.push('The manifest does not match its SHA-256: it changed after the package was built.');
  const byPath = new Map((pkg.files || []).map((f) => [f.path, f]));
  for (const a of m.artifacts || []) {
    const f = byPath.get(a.path);
    if (!f || typeof f.content !== 'string') { corrupt.push({ path: a.path, reason: 'listed in the manifest but not in the package' }); continue; }
    const h = sha256(f.content);
    if (h !== a.sha256 || h !== f.sha256) corrupt.push({ path: a.path, reason: 'its content does not match its SHA-256' });
    else present.push({ path: a.path, role: a.role, sha256: h });
  }
  for (const f of pkg.files || []) if (!(m.artifacts || []).some((a) => a.path === f.path)) corrupt.push({ path: f.path, reason: 'in the package but not in the manifest' });
  const get = (p) => { const f = byPath.get(p); return f && typeof f.content === 'string' ? f.content : null; };
  const report = get('original/report.md');
  if (report !== null) {
    if (sha256(report) !== m.pins.text_sha256) problems.push('The original report does not match the receipt\'s text pin.');
    const F = require('./forensics');
    const M = require('./forensic-model');
    const found = F.findBlock(report, require('./forensic-defs').REPORT_FORMAT);
    if (!found.obj || sha256(JSON.stringify(found.obj)) !== m.pins.block_sha256) problems.push('The report\'s JSON block does not match the receipt\'s block pin.');
    const rec = get('receipt/receipt.json');
    if (rec !== null && found.obj) {
      let r = null;
      try { r = JSON.parse(rec); } catch (_) { problems.push('The receipt record is not readable JSON.'); }
      if (r) {
        if (r.receipt_id !== m.receipt.receipt_id) problems.push('The receipt record names another receipt.');
        if (!r.text || r.text.sha256 !== m.pins.text_sha256 || r.block_sha256 !== m.pins.block_sha256) problems.push('The receipt record\'s pins differ from the manifest\'s.');
        const d = F.firstDifference(r.assessment, M.normalizeAssessment(found.obj).assessment);
        if (d) problems.push(`The receipt's stored assessment does not match its original block (at ${d}).`);
      }
    }
  } else problems.push('The original report is not in the package.');
  const promptText = get('frozen/prompt.investigator.md');
  if (promptText !== null && sha256(promptText) !== m.pins.prompt_sha256) problems.push('The frozen prompt does not match its pin.');
  const packetText = get('frozen/evidence-packet.json');
  if (packetText !== null && sha256(packetText) !== m.pins.evidence_packet_sha256) problems.push('The evidence packet does not match its pin.');
  // Observations: each record's own SHA-256 over its fields, as written.
  const obsText = get('observations/monitor.json');
  if (obsText !== null) {
    let list = [];
    try { list = JSON.parse(obsText); } catch (_) { problems.push('The observation log is not readable JSON.'); }
    for (const o of list) {
      const { obs_id: _id, sha256: h, ...fields } = o;
      if (sha256(JSON.stringify(fields)) !== h) problems.push(`Observation ${o.obs_id} does not match its own SHA-256.`);
    }
  }
  const calc = replay(m.calculation);
  if (calc.status === 'differs') problems.push(`The calculation does not reproduce: ${calc.differences.join(', ') || 'the quantity differs'}.`);
  const ok = !problems.length && !corrupt.length;
  return { status: ok ? 'verified' : 'failed', receipt_id: m.receipt && m.receipt.receipt_id, problems, corrupt, present, missing: m.missing || [], calculation: calc, note: 'Verified means the files match their hashes and the calculation reproduces. It does not mean what the files say is true.' };
}

module.exports = { FORMAT, buildCase, verifyCase, replay, manifestHash };
