'use strict';
// The disagreement resolution board (cr-forensic-adjudication@1, 2026-10-17,
// the re-audit's ranked improvement #2).
//
// A disagreement is one finding of Claude's assessment that ChatGPT's
// challenge of that exact receipt reviewed as overstated, unsupported or
// needing evidence. Each is shown with both positions as saved, their exact
// receipts and sources, and what evidence would resolve it, drawn from the
// two reports' own fields (never inferred).
//
// Eric's judgment: unresolved, challenge accepted or challenge rejected, with
// a reason, appended to projects/<id>/forensics/judgments.jsonl. It names the
// finding and both receipts with their block pins, so a later revision of
// either opinion is a different disagreement and never inherits it (earlier
// judgments on the same finding are listed as history, apart). A judgment is
// a workflow decision: never independent verification, never a consensus,
// and it changes no grade, finding, report or holding. Both original
// opinions stay as saved. The same request again is "unchanged".

const { runOp, OpError } = require('./ops');
const { readJsonLines, sha256 } = require('./fsx');

const VERSION = 'cr-forensic-adjudication@1';
const DISAGREE = new Set(['overstated', 'unsupported', 'needs_evidence']);
const JUDGMENTS = Object.freeze({ unresolved: 'Unresolved', challenge_accepted: 'Challenge accepted', challenge_rejected: 'Challenge rejected' });
const MEANING = 'Eric\'s workflow decision on how to treat this disagreement. It is not independent verification and not a consensus; no grade, finding, report or holding changes.';

const judgmentsRel = (pid) => `${require('./forensics').dirOf(pid)}/judgments.jsonl`;
const idOf = (aid, cid, fid) => `dg_${sha256(`${aid}|${cid}|${fid}`).slice(0, 16)}`;

function readJudgments(ws, pid) {
  return readJsonLines(ws.abs(judgmentsRel(pid))).filter((x) => x && !x._corrupt_line && x.schema_version === 'cr.forensic-judgment.v1');
}

// The board for one assessment receipt and the challenge of it. findings:
// the view's finding index (shown kind, standing); both receipts intact.
function board(ws, pid, { assessment, challenge, findings = [] }) {
  if (!assessment) return { version: VERSION, status: 'no_assessment', items: [] };
  if (!challenge) return { version: VERSION, status: 'no_challenge', items: [], note: 'No ChatGPT challenge of this receipt: nothing to compare.' };
  const all = readJudgments(ws, pid);
  const byId = new Map(findings.map((f) => [f.finding_id, f]));
  const ch = challenge.challenge || {};
  const items = [];
  const unchecked = [];
  for (const fr of ch.finding_reviews || []) {
    if (!DISAGREE.has(fr.verdict)) {
      if (fr.verdict === 'not_checked') unchecked.push(fr.finding_id);
      continue;
    }
    const f = byId.get(fr.finding_id) || null;
    const id = idOf(assessment.receipt_id, challenge.receipt_id, fr.finding_id);
    const mine = all.filter((j) => j.disagreement_id === id);
    const earlier = all.filter((j) => j.finding_id === fr.finding_id && j.disagreement_id !== id);
    const benign = (ch.benign_explanations || []).filter((b) => b.for_finding_id === fr.finding_id);
    const resolve = [
      f && f.would_confirm ? { by: 'claude', what: 'Would confirm it', text: f.would_confirm } : null,
      f && f.would_overturn ? { by: 'claude', what: 'Would overturn it', text: f.would_overturn } : null,
      f && f.missing_evidence ? { by: 'claude', what: 'Missing evidence', text: f.missing_evidence } : null,
      fr.omitted_evidence ? { by: 'chatgpt', what: 'Omitted evidence the challenge names', text: fr.omitted_evidence } : null,
    ].filter(Boolean);
    const latest = mine[mine.length - 1] || null;
    items.push({
      disagreement_id: id,
      finding_id: fr.finding_id,
      claude: f ? { receipt_id: assessment.receipt_id, block_sha256: assessment.block_sha256, statement: f.statement, shown_kind: f.shown_kind, original_kind: f.original_kind, standing: f.eligibility ? f.eligibility.standing : null, confidence: f.confidence, severity: f.severity, source_ids: f.source_ids, alternative_explanation: f.alternative_explanation || null } : { receipt_id: assessment.receipt_id, block_sha256: assessment.block_sha256, missing: true, statement: null, source_ids: [] },
      challenge: { receipt_id: challenge.receipt_id, block_sha256: challenge.block_sha256, verdict: fr.verdict, attribution_check: fr.attribution_check || null, calculation_check: fr.calculation_check || null, benign_explanation: fr.benign_explanation || null, omitted_evidence: fr.omitted_evidence || null, source_ids: fr.source_ids || [], benign_explanations: benign.map((b) => ({ explanation: b.explanation, plausibility: b.plausibility })) },
      resolve_with: resolve,
      judgment: latest ? { judgment: latest.judgment, words: JUDGMENTS[latest.judgment], reason: latest.reason, judged_at: latest.judged_at, judgment_id: latest.judgment_id } : null,
      state: latest ? latest.judgment : 'unjudged',
      history: mine.map((j) => ({ judgment_id: j.judgment_id, judgment: j.judgment, words: JUDGMENTS[j.judgment], reason: j.reason, judged_at: j.judged_at })),
      earlier: earlier.map((j) => ({ judgment_id: j.judgment_id, judgment: j.judgment, words: JUDGMENTS[j.judgment], reason: j.reason, judged_at: j.judged_at, assessment_receipt_id: j.assessment && j.assessment.receipt_id, challenge_receipt_id: j.challenge && j.challenge.receipt_id })),
    });
  }
  return {
    version: VERSION,
    status: 'compared',
    assessment_receipt_id: assessment.receipt_id,
    challenge_receipt_id: challenge.receipt_id,
    items,
    open: items.filter((i) => i.state === 'unjudged' || i.state === 'unresolved').length,
    unchecked,
    supported: (ch.finding_reviews || []).filter((r) => r.verdict === 'supported').length,
    judgments: JUDGMENTS,
    meaning: MEANING,
  };
}

// Eric's judgment of one disagreement. Re-derives the board under the lock
// so the IDs and receipts are the ones on record; the same request again,
// or the same judgment and reason as the latest, is "unchanged".
function judge(ws, pid, { disagreement_id: did, judgment, reason, request_id: requestId = null, by = null }) {
  const F = require('./forensics');
  if (typeof did !== 'string' || !/^dg_[0-9a-f]{16}$/.test(did)) throw new OpError('INVALID', 'Name the disagreement to judge.');
  if (!Object.prototype.hasOwnProperty.call(JUDGMENTS, judgment)) throw new OpError('INVALID', `The judgment must be ${Object.keys(JUDGMENTS).join(', ')}.`);
  const why = typeof reason === 'string' ? reason.replace(/\r\n/g, '\n').trim().slice(0, 1500) : '';
  if (why.length < 10) throw new OpError('INVALID', 'Say why, in a sentence (unresolved included).');
  const rid = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const rel = judgmentsRel(pid);
  return runOp(ws, { type: 'forensic_judgment', summary: `Judge disagreement ${did} for ${pid}` }, (op) => {
    const cur = op.readText(rel, '');
    const lines = cur.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const prior = rid ? lines.find((l) => l.request_id === rid) : null;
    if (prior) return { status: 'unchanged', judgment: prior };
    // The disagreement as it stands: any assessment receipt with an intact
    // challenge of it.
    const receipts = F.listReceipts(ws, pid).filter((r) => !r.broken && F.receiptIntegrity(ws, pid, r).ok);
    let found = null;
    for (const c of receipts.filter((r) => r.kind === 'challenge')) {
      const a = receipts.find((r) => r.kind === 'assessment' && r.receipt_id === c.challenges_receipt_id);
      if (!a) continue;
      for (const fr of (c.challenge.finding_reviews || []).filter((x) => DISAGREE.has(x.verdict))) {
        if (idOf(a.receipt_id, c.receipt_id, fr.finding_id) === did) found = { a, c, fr };
      }
    }
    if (!found) throw new OpError('NOT_FOUND', `No disagreement ${did} on record for ${pid}.`);
    const last = lines.filter((l) => l.disagreement_id === did).pop() || null;
    if (last && last.judgment === judgment && last.reason === why) return { status: 'unchanged', judgment: last };
    const at = new Date().toISOString();
    const line = {
      schema_version: 'cr.forensic-judgment.v1',
      judgment_id: `fj_${sha256(`${did}:${judgment}:${at}`).slice(0, 14)}`,
      version: VERSION,
      project_id: pid,
      disagreement_id: did,
      finding_id: found.fr.finding_id,
      assessment: { receipt_id: found.a.receipt_id, block_sha256: found.a.block_sha256 },
      challenge: { receipt_id: found.c.receipt_id, block_sha256: found.c.block_sha256, verdict: found.fr.verdict },
      judgment,
      reason: why,
      judged_at: at,
      judged_by: by || ws.actor || null,
      request_id: rid,
      supersedes: last ? last.judgment_id : null,
      meaning: MEANING,
    };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`);
    return { status: 'saved', judgment: line };
  });
}

module.exports = { VERSION, JUDGMENTS, MEANING, judgmentsRel, readJudgments, board, judge, idOf };
