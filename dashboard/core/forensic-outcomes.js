'use strict';
// The outcome learning register (cr-forensic-outcome-register@1, 2026-10-17,
// the re-audit's ranked improvement #4).
//
// For each assessment receipt, kept apart:
//   - conditional estimates: what the desk projected at the receipt's frozen
//     origin (scenarios_at_origin: the assumption, the level, the dated
//     crossing), exactly as frozen; never recomputed or moved;
//   - observed: what the stored readings show since the origin, and whether
//     their coverage permits an evaluation at all. A gap longer than the
//     measure allows, readings that start late, or readings taken at another
//     position size or limit make a row unevaluable, never a success;
//   - checkpoint outcomes: every recorded line with the method it was read
//     under and the corrections that follow it. Methods are never pooled, and
//     the four outcomes overlap: each is its own event, never exclusive;
//   - Eric's interpretation: optional notes, append-only, labeled his.
// No probability, calibration claim, ranking or accuracy figure is made from
// these rows. The tally counts coverage (evaluable, unevaluable, not due)
// per scenarios version, never hits.

const { runOp, OpError } = require('./ops');
const { readJsonLines, sha256 } = require('./fsx');

const VERSION = 'cr-forensic-outcome-register@1';
const DAY = 86400000;
const notesRel = (pid) => `${require('./forensics').dirOf(pid)}/outcome-notes.jsonl`;
const readNotes = (ws, pid) => readJsonLines(ws.abs(notesRel(pid))).filter((x) => x && !x._corrupt_line && x.schema_version === 'cr.forensic-outcome-note.v1');
const rowId = (rid, metric, kind) => `or_${sha256(`${rid}|${metric}|${kind}`).slice(0, 16)}`;
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

// points: [{ t, beyond: true | false | null }] (null: a reading that cannot
// say). Coverage over the known readings between from and to; the first
// reading beyond the level and the first within it.
function observe(points, { from, to, maxGapDays }) {
  const known = points.filter((p) => p.beyond !== null && p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
  let gap = 0;
  let prev = from;
  for (const p of known) { gap = Math.max(gap, (p.t - prev) / DAY); prev = p.t; }
  gap = Math.max(gap, (to - prev) / DAY);
  const evaluable = known.length > 0 && gap <= maxGapDays;
  const fb = known.find((p) => p.beyond === true) || null;
  const fw = known.find((p) => p.beyond === false) || null;
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    readings: known.length,
    unknown_readings: points.filter((p) => p.beyond === null && p.t >= from && p.t <= to).length,
    max_gap_days: Math.round(gap * 10) / 10,
    max_gap_allowed_days: maxGapDays,
    evaluable,
    reason: evaluable ? null : known.length ? `a gap of ${Math.round(gap * 10) / 10} days without a usable reading (at most ${maxGapDays} allowed)` : 'no usable reading in the period',
    first_beyond: fb ? { day: dayOf(fb.t), at: new Date(fb.t).toISOString() } : null,
    first_within: fw ? { day: dayOf(fw.t), at: new Date(fw.t).toISOString() } : null,
  };
}

// One frozen scenario against what was observed. beyondAtOrigin: the
// measure was already past the level when the estimate was made.
function evaluateRow(s, obs, { now, beyondAtOrigin }) {
  const due = s.crosses_at ? Date.parse(`${s.crosses_at}T23:59:59Z`) : null;
  if (due !== null && due > now) return { state: 'not_due', words: `Not due: the conditional date is ${s.crosses_at}.` };
  if (!obs.evaluable) return { state: 'unevaluable', words: `Unevaluable: ${obs.reason}.` };
  if (s.direction === 'back' || (beyondAtOrigin && !s.crosses_at)) {
    const back = obs.first_within;
    if (s.crosses_at) return back && Date.parse(back.at) <= due ? { state: 'back_by_date', words: `Observed back within the level on ${back.day}, by the conditional date ${s.crosses_at}.` } : back ? { state: 'back_after_date', words: `Observed back within the level on ${back.day}, after the conditional date ${s.crosses_at}.` } : { state: 'not_back_by_date', words: `Not observed back within the level by ${s.crosses_at}.` };
    return back ? { state: 'back_without_date', words: `Past the level at the origin; observed back within it on ${back.day}, though this assumption projected no return.` } : { state: 'stayed_beyond', words: 'Past the level at the origin; no reading back within it in the period.' };
  }
  const hit = obs.first_beyond;
  if (!s.crosses_at) return hit ? { state: 'crossed_without_date', words: `Observed past the level on ${hit.day}, though this assumption projected no crossing.` } : { state: 'not_crossed', words: 'No reading past the level in the period.' };
  if (hit && Date.parse(hit.at) <= due) return { state: 'crossed_by_date', words: `Observed past the level on ${hit.day}, by the conditional date ${s.crosses_at}.` };
  if (hit) return { state: 'crossed_after_date', words: `Observed past the level on ${hit.day}, after the conditional date ${s.crosses_at}.` };
  return { state: 'not_crossed_by_date', words: `No reading past the level by the conditional date ${s.crosses_at}.` };
}

const STATE_WORDS = Object.freeze({
  not_due: 'Not due',
  unevaluable: 'Unevaluable',
  not_estimated: 'Not estimated',
  crossed_by_date: 'Crossed by the date',
  crossed_after_date: 'Crossed after the date',
  not_crossed_by_date: 'Not crossed by the date',
  crossed_without_date: 'Crossed, no date projected',
  not_crossed: 'Not crossed',
  back_by_date: 'Back by the date',
  back_after_date: 'Back after the date',
  not_back_by_date: 'Not back by the date',
  back_without_date: 'Back, no return projected',
  stayed_beyond: 'Stayed past the level',
  delivered: 'Delivery observed',
  not_delivered: 'No delivery observed',
});

// One receipt's register.
//   observed: { volume: daily series ({ t, last_t, value }), exitCost: the
//     liquidity readings ({ at, beyond }) at observed.positionUsd and
//     observed.limitPct, delivery: the delivery readings ({ at, beyond,
//     latest_delivery_at }) };
//   resolutions: its recorded lines; notes: the project's outcome notes.
function receiptRegister(r, { observed, resolutions = [], notes = [], now = Date.now() }) {
  const sao = r.scenarios_at_origin || null;
  const O = Date.parse(r.origin);
  const end = Math.min(now, O + 120 * DAY);
  const rows = [];
  const fp = r.preferences || {};
  const sizeDiffers = observed.positionUsd !== fp.exit_position_usd || observed.limitPct !== fp.exit_cost_limit_pct;
  const pointsFor = (metric, threshold) => (metric === 'volume'
    ? (observed.volume || []).map((p) => ({ t: p.last_t || p.t, beyond: typeof p.value === 'number' ? p.value < threshold : null }))
    : (observed.exitCost || []).map((p) => ({ t: Date.parse(p.at), beyond: p.beyond })));
  const add = (metric, label, est, maxGapDays) => {
    if (!est) return;
    if (est.status !== 'estimated' || !Array.isArray(est.scenarios)) {
      rows.push({ row_id: rowId(r.receipt_id, metric, 'none'), metric, label, kind: null, frozen: { status: est.status, words: est.words || null, threshold: est.threshold ?? null }, observed: null, evaluation: { state: 'not_estimated', words: est.words || 'Not estimated at the origin.' } });
      return;
    }
    for (const s of est.scenarios) {
      const to = s.crosses_at ? Math.min(end, Date.parse(`${s.crosses_at}T23:59:59Z`)) : end;
      const frozen = { assumption: s.assumption, rate_pct_per_week: s.rate_pct_per_week ?? null, crosses_at: s.crosses_at || null, direction: s.direction || null, within_horizon: Boolean(s.within_horizon), words: s.words, threshold: est.threshold, worse: est.worse, unit: est.unit || null, beyond_at_origin: Boolean(est.beyond_now), latest_at_origin: est.latest || null };
      if (metric === 'exit_cost' && sizeDiffers) {
        rows.push({ row_id: rowId(r.receipt_id, metric, s.kind), metric, label, kind: s.kind, frozen, observed: null, evaluation: { state: 'unevaluable', words: `Unevaluable here: this receipt froze $${fp.exit_position_usd} at a ${fp.exit_cost_limit_pct}% limit, and the readings on this page are at $${observed.positionUsd} and ${observed.limitPct}%. Open this receipt to read it under its own terms.` } });
        continue;
      }
      const obs = observe(pointsFor(metric, est.threshold), { from: O, to, maxGapDays });
      rows.push({ row_id: rowId(r.receipt_id, metric, s.kind), metric, label, kind: s.kind, frozen, observed: obs, evaluation: evaluateRow(s, obs, { now, beyondAtOrigin: Boolean(est.beyond_now) }) });
    }
  };
  if (sao) {
    add('volume', 'Volume against the review level', sao.volume, 2);
    add('exit_cost', 'Exit cost against your limit', sao.exit_cost, 3);
    const d = sao.delivery;
    if (d) {
      const id = rowId(r.receipt_id, 'delivery', 'no_new_delivery');
      if (d.status !== 'estimated') rows.push({ row_id: id, metric: 'delivery', label: 'Delivery window', kind: 'no_new_delivery', frozen: { status: d.status, words: d.words }, observed: null, evaluation: { state: 'not_estimated', words: d.words } });
      else {
        const due = Date.parse(`${d.crosses_at}T23:59:59Z`);
        const to = Math.min(end, due);
        const reads = (observed.delivery || []).filter((x) => Date.parse(x.at) >= O && Date.parse(x.at) <= to);
        const hit = reads.find((x) => x.latest_delivery_at && Date.parse(x.latest_delivery_at) > O) || null;
        const obs = observe(reads.map((x) => ({ t: Date.parse(x.at), beyond: x.beyond })), { from: O, to, maxGapDays: 7 });
        const ev = due > now && !hit ? { state: 'not_due', words: `Not due: the window passes on ${d.crosses_at} if nothing is delivered.` }
          : hit ? { state: 'delivered', words: `A delivery dated ${hit.latest_delivery_at.slice(0, 10)} was observed, so the window did not pass on that assumption.` }
            : !obs.evaluable ? { state: 'unevaluable', words: `Unevaluable: ${obs.reason}.` }
              : { state: 'not_delivered', words: `No delivery observed by ${d.crosses_at}.` };
        rows.push({ row_id: id, metric: 'delivery', label: 'Delivery window', kind: 'no_new_delivery', frozen: { assumption: d.assumption || null, crosses_at: d.crosses_at, within_horizon: Boolean(d.within_horizon), words: d.words }, observed: obs, evaluation: ev });
      }
    }
  }
  // Checkpoint outcomes: each checkpoint's recorded lines per event, with the
  // method each was read under; a correction follows the line it corrects.
  const lines = (event, cp) => resolutions.filter((l) => l.checkpoint === cp && l.event === event).map((l) => ({ entry_id: l.entry_id, outcome: l.outcome, method: l.method || 'cr-forensic-method@1', corrects: l.corrects || null, previous_method: l.previous_method || null, reason: l.reason || null, recorded_at: l.recorded_at || null, manual: Boolean(l.corrects && !l.method) }));
  const events = [...new Set(resolutions.map((l) => l.event))];
  const checkpoints = (r.deadlines || []).map((c) => ({ checkpoint: c.id, label: c.label, deadline: c.at, due: Date.parse(c.at) <= now, events: events.map((e) => ({ event: e, lines: lines(e, c.id) })).filter((x) => x.lines.length) }));
  const mine = notes.filter((n) => n.receipt_id === r.receipt_id);
  for (const row of rows) {
    const list = mine.filter((n) => n.row_id === row.row_id);
    row.owner = list.length ? { note: list[list.length - 1].note, noted_at: list[list.length - 1].noted_at, history: list.map((n) => ({ note_id: n.note_id, note: n.note, noted_at: n.noted_at })) } : null;
    row.evaluation.short = STATE_WORDS[row.evaluation.state] || row.evaluation.state;
  }
  return {
    receipt_id: r.receipt_id,
    origin: r.origin,
    origin_basis: r.origin_basis || null,
    scenarios_version: sao ? sao.version || null : null,
    method_at_origin: (sao && sao.method) || r.method || 'cr-forensic-method@1',
    frozen: Boolean(sao),
    rows,
    checkpoints,
    methods_recorded: [...new Set(resolutions.map((l) => l.method || 'cr-forensic-method@1'))],
    note: sao ? null : 'This receipt holds no conditional estimates from its origin.',
  };
}

// The register over receipts (oldest first in), newest first out, with a
// coverage tally per scenarios version (never pooled, never a hit rate).
function register(receipts, opts) {
  const items = receipts.map((r) => receiptRegister(r, { ...opts, resolutions: opts.resolutionsOf ? opts.resolutionsOf(r.receipt_id) : [] })).reverse();
  const tally = {};
  for (const it of items) {
    const v = it.scenarios_version || 'none';
    const t = tally[v] || (tally[v] = { version: v, rows: 0, evaluable: 0, unevaluable: 0, not_due: 0, not_estimated: 0 });
    for (const row of it.rows) {
      t.rows += 1;
      if (row.evaluation.state === 'unevaluable') t.unevaluable += 1;
      else if (row.evaluation.state === 'not_due') t.not_due += 1;
      else if (row.evaluation.state === 'not_estimated') t.not_estimated += 1;
      else t.evaluable += 1;
    }
  }
  return {
    version: VERSION,
    items,
    tally: Object.values(tally),
    meaning: 'Each row sets one frozen conditional estimate beside what the stored readings show. A crossing that happened does not make the estimate right, and one that did not does not make it wrong: each estimate is conditional on its assumption, not a prediction. Overlapping outcomes are separate events. Nothing here is a probability, a calibration, a ranking or an accuracy figure.',
  };
}

// Eric's interpretation of one row: an append-only note.
function addNote(ws, pid, { receipt_id: rid, row_id: row, note, request_id: requestId = null, by = null }) {
  const F = require('./forensics');
  if (!F.RECEIPT_RE.test(String(rid))) throw new OpError('INVALID', 'Name the receipt.');
  if (typeof row !== 'string' || !/^or_[0-9a-f]{16}$/.test(row)) throw new OpError('INVALID', 'Name the register row.');
  const text = typeof note === 'string' ? note.replace(/\r\n/g, '\n').trim().slice(0, 1500) : '';
  if (text.length < 3) throw new OpError('INVALID', 'Write the note.');
  const reqId = typeof requestId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : null;
  const rel = notesRel(pid);
  return runOp(ws, { type: 'forensic_outcome_note', summary: `Outcome note for ${rid}` }, (op) => {
    const cur = op.readText(rel, '');
    const lines = cur.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const prior = reqId ? lines.find((l) => l.request_id === reqId) : null;
    if (prior) return { status: 'unchanged', note: prior };
    const r = F.loadReceipt(ws, pid, rid);
    if (!r || r.kind !== 'assessment') throw new OpError('NOT_FOUND', `No forensic assessment ${rid}.`);
    const last = lines.filter((l) => l.receipt_id === rid && l.row_id === row).pop();
    if (last && last.note === text) return { status: 'unchanged', note: last };
    const at = new Date().toISOString();
    const line = { schema_version: 'cr.forensic-outcome-note.v1', note_id: `fn_${sha256(`${rid}:${row}:${at}`).slice(0, 14)}`, version: VERSION, project_id: pid, receipt_id: rid, row_id: row, note: text, noted_at: at, noted_by: by || ws.actor || null, request_id: reqId, meaning: 'Eric\'s interpretation: not an observed outcome and not an evaluation.' };
    op.write(rel, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`);
    return { status: 'saved', note: line };
  });
}

module.exports = { VERSION, STATE_WORDS, notesRel, readNotes, observe, evaluateRow, receiptRegister, register, addNote };
