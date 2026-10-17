'use strict';
// The evidence-change review queue (cr-forensic-review@1, 2026-10-16, after
// the independent review's ranked improvement #1).
//
// What it does: compares each monitored target's observations in order (the
// monitor's existing product checks, repository reads and exit quotes; no new
// request of any kind) and lists what changed, each change linked to the
// receipt, finding and source it bears on when that link is on record:
//
//   measurement_changed  a measured value changed (a check's outcome or
//                        status, a repository's latest delivery, release or
//                        state, a quote's answer or its side of your limit)
//   capture_changed      the captured page changed beyond whitespace; what
//                        that means is not established by the desk
//   cosmetic_only        the bytes changed, but the page is the same under
//                        cr-forensic-normalize@1 (whitespace only)
//   read_failed          the read failed or was incomplete: no measurement
//
// and, per target, "no relevant change" since the last change. A raw hash
// change is never called a factual change; the normalization removes no
// number, date or statement (forensic-monitor.js normalizeBody).
//
// Eric's review: an acknowledgment of a target's latest change, with an
// optional note, appended to projects/<id>/forensics/reviews.jsonl. It means
// he reviewed it, never that a claim became true, and it changes no grade,
// allegation, research or model: nothing is asked of anyone. A later relevant
// change on the same target reopens it; a cosmetic change does not. Every
// acknowledgment stays on record. Reading the queue writes nothing.

const { runOp, OpError } = require('./ops');
const { readJsonLines, sha256 } = require('./fsx');

const VERSION = 'cr-forensic-review@1';
const RELEVANT = new Set(['measurement_changed', 'capture_changed', 'read_failed']);
const MEANING = 'Reviewed by Eric. This records that he looked at the change; it does not make any claim true, resolve an allegation or change a grade.';
const CLASS_WORDS = {
  measurement_changed: 'Measurement changed',
  capture_changed: 'Captured page changed; significance not established',
  cosmetic_only: 'Cosmetic only (whitespace)',
  read_failed: 'Read failed or incomplete',
  no_relevant_change: 'No relevant change',
};

const reviewsRel = (pid) => `${require('./forensics').dirOf(pid)}/reviews.jsonl`;

function readReviews(ws, pid) {
  return readJsonLines(ws.abs(reviewsRel(pid))).filter((x) => x && !x._corrupt_line && x.schema_version === 'cr.forensic-review.v1');
}

// What one observation measured, and what it captured, by kind. null
// measurement: the read failed or was incomplete.
function stateOf(o, ctx) {
  if (o.kind === 'product_check') {
    if (!['pass', 'fail'].includes(o.outcome)) return { failed: true, words: o.outcome === 'incomplete' ? `Incomplete read: ${o.error || 'no reading'}` : o.outcome === 'not_checkable' ? `Not checkable: ${o.error || ''}`.trim() : `Read failed: ${o.error || o.outcome || 'no answer'}` };
    return {
      m: [o.outcome, o.http_status || null, o.expect_met ? o.expect_met.text : null],
      raw: o.body_sha256 || null,
      norm: o.body_norm_sha256 || null,
      words: `${o.outcome === 'pass' ? 'Passed' : 'Failed'} (HTTP ${o.http_status || '?'}${o.expect && o.expect.text ? `; expected text ${o.expect_met && o.expect_met.text ? 'found' : 'not found'}` : ''})`,
      values: { outcome: o.outcome, http_status: o.http_status || null, body_sha256: o.body_sha256 || null, body_norm_sha256: o.body_norm_sha256 || null, excerpt: o.excerpt || null },
    };
  }
  if (o.kind === 'repository_read') {
    if (o.status !== 'ok') {
      if (o.status === 'not_found') return { m: ['not_found'], words: 'GitHub answers 404: gone, renamed or private', values: { status: 'not_found' } };
      return { failed: true, words: `Read failed: ${o.error || o.status}` };
    }
    const c = o.latest_commit || {};
    const r = o.latest_release || {};
    return {
      m: ['ok', o.latest_delivery_at || null, r.tag || null, Boolean(o.archived), o.default_branch || null],
      raw: c.sha || null,
      norm: c.sha || null,
      words: `Latest delivery ${o.latest_delivery_at ? o.latest_delivery_at.slice(0, 10) : 'none'}${r.tag ? `, release ${r.tag}` : ''}${o.archived ? ', archived' : ''}`,
      values: { latest_delivery_at: o.latest_delivery_at || null, latest_commit: c.sha || null, latest_commit_at: c.at || null, latest_release: r.tag || null, archived: Boolean(o.archived) },
    };
  }
  if (o.kind === 'executable_quote') {
    if (o.status === 'no_route') return { m: ['no_route', o.size_usd], words: `No route at $${o.size_usd}`, values: { status: 'no_route', size_usd: o.size_usd } };
    if (o.status !== 'quoted' || !o.quote) return { failed: true, words: o.status === 'not_covered' ? `Not covered by the quote source: ${o.error || ''}`.trim() : `No quote: ${o.error || o.status}` };
    const M = require('./forensic-model');
    const e = M.exitEstimate(o, o.size_usd, { tax: ctx.tax ? ctx.tax(o) : null });
    const cost = e && e.status === 'estimated' ? e.cost_pct : null;
    const side = cost === null || !ctx.limitPct ? null : cost > ctx.limitPct ? 'over' : e.cost_complete ? 'within' : 'lower_bound_within';
    // The signature is the quote's side of the limit only (never the tax
    // knowledge of the day it is read), so a change keeps its identity.
    return { m: ['quoted', o.size_usd, side === 'over' ? 'over' : side ? 'not_over' : null], words: `${cost === null ? 'Quoted' : `${e.cost_complete ? '' : 'at least '}${cost}% at $${o.size_usd}`}${side ? ` (${side === 'over' ? 'over' : side === 'within' ? 'within' : 'a lower bound within'} your ${ctx.limitPct}% limit)` : ''}`, values: { status: 'quoted', size_usd: o.size_usd, cost_pct: cost, cost_complete: e ? e.cost_complete : null, received_usd: o.quote.received_usd } };
  }
  return null;
}

const itemId = (parts) => `eq_${sha256(parts.join('|')).slice(0, 16)}`;

// The changes of one target's observations, oldest first.
function changesOf(target, list, ctx) {
  const items = [];
  let base = null;
  let failing = null;
  for (const o of list) {
    const s = stateOf(o, ctx);
    if (!s) continue;
    if (s.failed) {
      if (failing) {
        failing.count += 1;
        failing.last_at = o.observed_at;
        failing.last_obs_id = o.obs_id;
        continue;
      }
      failing = { item_id: itemId([target.target_id, 'read_failed', base ? base.obs.obs_id : '-', o.obs_id]), class: 'read_failed', at: o.observed_at, previous: base ? obsView(base.obs, base.s) : null, current: { obs_id: o.obs_id, observed_at: o.observed_at, words: s.words, sha256: o.sha256 || null }, count: 1, last_at: o.observed_at, last_obs_id: o.obs_id, ended_at: null };
      items.push(failing);
      continue;
    }
    if (failing) {
      failing.ended_at = o.observed_at;
      failing = null;
    }
    if (!base) {
      base = { obs: o, s };
      continue;
    }
    let cls = null;
    if (JSON.stringify(s.m) !== JSON.stringify(base.s.m)) cls = 'measurement_changed';
    else if (s.norm && base.s.norm && s.norm !== base.s.norm) cls = 'capture_changed';
    else if (s.raw && base.s.raw && s.raw !== base.s.raw) cls = s.norm && base.s.norm ? 'cosmetic_only' : 'capture_changed';
    if (cls) items.push({ item_id: itemId([target.target_id, cls, base.obs.obs_id, o.obs_id]), class: cls, at: o.observed_at, previous: obsView(base.obs, base.s), current: obsView(o, s) });
    base = { obs: o, s };
  }
  return { items, latest: base ? obsView(base.obs, base.s) : null, failing: Boolean(failing) };
}

function obsView(o, s) {
  return { obs_id: o.obs_id, observed_at: o.observed_at, words: s.words, values: s.values || null, sha256: o.sha256 || null };
}

// The link of a target to the receipt, finding and source it bears on, from
// what is on record: the receipt that proposed it and the source it cited.
// Exit quotes come from the verified identity and cite no source: unmapped.
function mappingOf(target, kind, receiptsById, currentId) {
  if (kind === 'exit_quote') return { status: 'unmapped', reason: 'Exit quotes are read for the contract in the verified identity; no assessment source or finding names them, so no link is made.', receipt_id: currentId || null, finding_ids: [], source_id: null };
  const r = target.proposed_in ? receiptsById.get(target.proposed_in) : null;
  if (!r) return { status: 'unmapped', reason: target.proposed_in ? `The receipt that proposed this check (${target.proposed_in}) is not on record.` : 'No receipt is on record as proposing this check.', receipt_id: null, finding_ids: [], source_id: null };
  const src = target.source_id ? (r.assessment.sources || []).find((s) => s.source_id === target.source_id) : null;
  const findings = src ? (r.assessment.findings || []).filter((f) => f.source_ids.includes(src.source_id)).map((f) => f.finding_id) : [];
  const frozen = src ? { source_id: src.source_id, url: src.url || null, retrieved_at: src.retrieved_at || null, content_sha256: src.content_sha256 || null, excerpt: src.excerpt || null } : null;
  if (!src) return { status: 'receipt_only', reason: target.source_id ? `Proposed in ${r.receipt_id}, citing ${target.source_id}, which is not in its source list.` : `Proposed in ${r.receipt_id} without a source, so no finding is linked.`, receipt_id: r.receipt_id, finding_ids: [], source_id: target.source_id || null, frozen: null };
  return { status: findings.length ? 'mapped' : 'source_only', reason: findings.length ? null : `Source ${src.source_id} of ${r.receipt_id} is cited by no finding.`, receipt_id: r.receipt_id, finding_ids: findings, source_id: src.source_id, frozen, current_receipt_id: currentId && currentId !== r.receipt_id ? currentId : null };
}

// The queue (writes nothing). opts: { receipts, observations, profile,
// limitPct, tax, currentId }.
function queue(ws, pid, { receipts, observations, profile, limitPct = null, tax = null, currentId = null } = {}) {
  const reviews = readReviews(ws, pid);
  const receiptsById = new Map((receipts || []).filter((r) => r.kind === 'assessment').map((r) => [r.receipt_id, r]));
  const targets = [
    ...(profile.targets.product_checks || []).map((t) => ({ t, kind: 'product_check', label: t.label || t.url, obsKind: 'product_check' })),
    ...(profile.targets.repositories || []).map((t) => ({ t, kind: 'repository', label: `github.com/${t.owner}/${t.repo}`, obsKind: 'repository_read' })),
    ...(profile.targets.exit_quotes || []).map((t) => ({ t, kind: 'exit_quote', label: `Exit quotes, ${t.chain_label || t.chain} (${t.provider})`, obsKind: 'executable_quote' })),
    ...(profile.removed || []).map((t) => ({ t, kind: t.owner ? 'repository' : t.url ? 'product_check' : 'exit_quote', label: t.label || t.url || (t.owner ? `github.com/${t.owner}/${t.repo}` : `Exit quotes, ${t.chain_label || t.chain}`), obsKind: t.owner ? 'repository_read' : t.url ? 'product_check' : 'executable_quote', removed: true })),
  ];
  const seen = new Set();
  const threads = [];
  for (const x of targets) {
    if (seen.has(x.t.target_id)) continue;
    seen.add(x.t.target_id);
    const obs = (observations || []).filter((o) => o.target_id === x.t.target_id && o.kind === x.obsKind);
    // Exit quotes: each size is its own series.
    const series = x.kind === 'exit_quote' ? [...new Set(obs.map((o) => o.size_usd))].map((size) => ({ key: `${x.t.target_id}:${size}`, list: obs.filter((o) => o.size_usd === size) })) : [{ key: x.t.target_id, list: obs }];
    let items = [];
    let latest = null;
    let failing = false;
    for (const s of series) {
      const c = changesOf({ target_id: s.key }, s.list, { limitPct, tax });
      items = items.concat(c.items);
      if (c.latest && (!latest || c.latest.observed_at > latest.observed_at)) latest = c.latest;
      failing = failing || c.failing;
    }
    items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const mine = reviews.filter((r) => r.target_id === x.t.target_id);
    const lastReview = mine[mine.length - 1] || null;
    const reviewedIdx = lastReview ? items.findIndex((i) => i.item_id === lastReview.item_id) : -1;
    const after = items.slice(reviewedIdx + 1);
    const open = after.filter((i) => RELEVANT.has(i.class));
    const lastRelevant = [...items].reverse().find((i) => RELEVANT.has(i.class)) || null;
    const state = open.length ? (lastReview ? 'reopened' : 'open') : lastReview ? 'reviewed' : items.length ? 'cosmetic_only' : 'no_relevant_change';
    // Shown grouped: consecutive page changes (or cosmetic ones) are one row
    // with a count; each measurement change and each failed stretch is its
    // own row. Every item keeps its own ID; a review names the latest.
    const groups = [];
    for (const i of after) {
      const g = groups[groups.length - 1];
      if (g && g.class === i.class && (i.class === 'capture_changed' || i.class === 'cosmetic_only')) {
        Object.assign(g, { count: g.count + 1, last_at: i.at, current: i.current, item_id: i.item_id });
      } else groups.push({ item_id: i.item_id, class: i.class, class_words: CLASS_WORDS[i.class], count: i.count && i.class === 'read_failed' ? i.count : 1, first_at: i.at, last_at: i.class === 'read_failed' ? i.last_at : i.at, ended_at: i.ended_at || null, previous: i.previous, current: i.current, relevant: RELEVANT.has(i.class) });
    }
    threads.push({
      target_id: x.t.target_id,
      kind: x.kind,
      label: x.label,
      removed: Boolean(x.removed),
      state,
      state_words: { open: 'Changed, to review', reopened: 'Changed again since your review', reviewed: 'Reviewed', cosmetic_only: 'Only cosmetic changes', no_relevant_change: 'No relevant change' }[state],
      unavailable: failing,
      readings: obs.length,
      latest,
      latest_relevant_item_id: lastRelevant ? lastRelevant.item_id : null,
      open_count: open.length,
      since_review: groups,
      items_total: items.length,
      // The latest changes, newest last, each marked reviewed or not.
      items: items.slice(-30).map((i) => ({ ...i, class_words: CLASS_WORDS[i.class], reviewed: reviewedIdx >= 0 && items.indexOf(i) <= reviewedIdx })),
      latest_relevant: lastRelevant ? { item_id: lastRelevant.item_id, class: lastRelevant.class, class_words: CLASS_WORDS[lastRelevant.class], at: lastRelevant.at, obs_id: lastRelevant.current ? lastRelevant.current.obs_id : null } : null,
      mapping: mappingOf(x.t, x.kind, receiptsById, currentId),
      reviews: mine.map((r) => ({ review_id: r.review_id, item_id: r.item_id, item_class: r.item_class, note: r.note || null, reviewed_at: r.reviewed_at, reviewed_by: r.reviewed_by || null })),
    });
  }
  const order = { reopened: 0, open: 1, reviewed: 2, cosmetic_only: 3, no_relevant_change: 4 };
  threads.sort((a, b) => order[a.state] - order[b.state] || String((b.latest || {}).observed_at || '').localeCompare(String((a.latest || {}).observed_at || '')));
  const toReview = threads.filter((t) => t.state === 'open' || t.state === 'reopened');
  return {
    version: VERSION,
    normalization: require('./forensic-monitor').NORMALIZE_VERSION,
    meaning: MEANING,
    classes: CLASS_WORDS,
    to_review: toReview.length,
    unavailable: threads.filter((t) => t.unavailable).length,
    threads,
    note: 'Built from the monitor\'s existing observations; the saved receipts and their captured sources are unchanged. A change here is not a finding, and reviewing it changes no grade, allegation or research.',
  };
}

// Eric's acknowledgment of a target's latest relevant change. item_id must
// be that change: a newer one is refused (409), so nothing unseen is marked.
// The same request_id, or the same change already reviewed, is "unchanged".
function acknowledge(ws, pid, { target_id: targetId, item_id: itemIdIn, note = null, request_id: requestId = null, by = null }) {
  const F = require('./forensics');
  if (typeof targetId !== 'string' || !/^[a-z]{2}_[0-9a-f]{12}$/.test(targetId)) throw new OpError('INVALID', 'Name the monitored target to mark reviewed.');
  if (typeof itemIdIn !== 'string' || !/^eq_[0-9a-f]{16}$/.test(itemIdIn)) throw new OpError('INVALID', 'Name the change you reviewed (its item ID).');
  const text = note === null || note === undefined ? null : String(note).replace(/\r\n/g, '\n').trim().slice(0, 1000) || null;
  const rid = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const rel = reviewsRel(pid);
  const now = Date.now();
  return runOp(ws, { type: 'forensic_review', summary: `Review evidence change ${itemIdIn} for ${pid}` }, (op) => {
    // Under the lock: the queue as it stands now.
    const v = F.view(ws, pid, { now });
    const thread = (v.evidence_changes.threads || []).find((t) => t.target_id === targetId);
    if (!thread) throw new OpError('NOT_FOUND', `No monitored target ${targetId} for ${pid}.`);
    const cur = op.readText(rel, '');
    const lines = cur.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const prior = rid ? lines.find((l) => l.request_id === rid) : null;
    if (prior) return { status: 'unchanged', review: prior };
    const last = lines.filter((l) => l.target_id === targetId).pop() || null;
    if (last && last.item_id === itemIdIn) return { status: 'unchanged', review: last };
    const item = thread.latest_relevant;
    if (!item) throw new OpError('CONFLICT', 'This target has no change to review.');
    if (item.item_id !== itemIdIn) throw new OpError('NEWER_REPORT', `Not marked: a newer change was observed (${item.class_words}, ${item.at}). Look at it, then mark that one.`, { newer: [{ item_id: item.item_id, at: item.at }] });
    const at = new Date(now).toISOString();
    const line = { schema_version: 'cr.forensic-review.v1', review_id: `fq_${sha256(`${pid}:${targetId}:${itemIdIn}:${at}`).slice(0, 14)}`, project_id: pid, target_id: targetId, item_id: itemIdIn, item_class: item.class, item_at: item.at, item_obs_id: item.obs_id || null, mapping: { receipt_id: thread.mapping.receipt_id || null, finding_ids: thread.mapping.finding_ids || [], source_id: thread.mapping.source_id || null }, note: text, reviewed_at: at, reviewed_by: by || ws.actor || null, request_id: rid, review_version: VERSION, meaning: MEANING };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`);
    return { status: 'saved', review: line };
  });
}

module.exports = { VERSION, MEANING, CLASS_WORDS, reviewsRel, readReviews, stateOf, changesOf, queue, acknowledge };
