#!/usr/bin/env node
'use strict';
// The Day-30 scorecard (backlog item 29; the blueprint's section 7):
//
//   npm run scorecard [-- --json] [-- --workspace <path>]
//
// Every row of audits/2026-10-24-30-day-blueprint/README.md section 7 is
// computed from the repository and the workspace only: git history and its
// `Backlog-Item` trailers, Actions runs through `gh` when it is signed in,
// ticket receipts and decisions, and paper/. Each row gives its value, its
// target, met / not met / not measurable, and the records it read. A row the
// records cannot answer reads "not measurable from records", never a guess.
// It calls no model and writes nothing: git is only read, `gh` only lists,
// the workspace is only read.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SURGE_END = Date.parse('2026-10-28T03:00:00Z'); // 2026-10-27 23:00 New York
const NM = 'not measurable from records';
const DAY = 86400000;

function run(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, out: '', err: String(r.error.message) };
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const defaultGh = (cwd, args) => run(cwd, 'gh', args);

const row = (id, measure, target, status, value, reads, note = null) => ({ id, measure, target, status, value, reads, note });
const unreadable = (id, measure, target, reads, why) => row(id, measure, target, NM, null, reads, why);

// ---------------------------------------------------------------------------
// Git

function mainRef(cwd) {
  for (const ref of ['origin/main', 'main']) if (run(cwd, 'git', ['rev-parse', '--verify', '-q', ref]).status === 0) return ref;
  return null;
}
const trailers = (text) => [...String(text).matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));

function backlogBranches(cwd, main) {
  const all = run(cwd, 'git', ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin/claude/backlog-*']).out.split('\n').filter(Boolean).map((l) => { const [ref, sha] = l.split(' '); return { ref, sha, branch: ref.replace(/^origin\//, '') }; });
  const merged = new Set(run(cwd, 'git', ['branch', '-r', '--merged', main, '--list', 'origin/claude/backlog-*']).out.split('\n').map((s) => s.trim()).filter(Boolean));
  return all.map((b) => ({ ...b, merged: merged.has(b.ref) }));
}

function itemsMerged(cwd, main) {
  const reads = [`git log ${main} (Backlog-Item trailers)`, `${main}:DESK_STATE.md (ticked items)`];
  const m = { id: 'items_merged', measure: 'Backlog items merged to main', target: '7 to 20, with those marked (Eric) only where he said go' };
  if (!main) return unreadable(m.id, m.measure, m.target, reads, 'No main branch to read.');
  const items = new Set(trailers(run(cwd, 'git', ['log', main, '--format=%B']).out));
  const state = run(cwd, 'git', ['show', `${main}:DESK_STATE.md`]);
  if (state.status === 0) for (const x of state.out.matchAll(/^- \[x\] \*\*(\d+)\./gm)) items.add(Number(x[1]));
  const n = items.size;
  return row(m.id, m.measure, m.target, n >= 7 && n <= 20 ? 'met' : 'not met', n, reads, `Items: ${[...items].sort((a, b) => a - b).join(', ') || 'none'}. Whether an (Eric) item had his go is not in these records.`);
}

function branchesWaiting(cwd, main, now) {
  const reads = [`git branch -r --merged ${main}`, 'git log of each origin/claude/backlog-* branch'];
  const cap = now < SURGE_END ? 9 : 4;
  const m = { id: 'branches_waiting', measure: 'Branches waiting at any moment', target: `at most 4 (9 items during Eric's surge, until 2026-10-27 23:00 ET); the cap now is ${cap}` };
  if (!main) return unreadable(m.id, m.measure, m.target, reads, 'No main branch to read.');
  const waiting = new Set();
  for (const b of backlogBranches(cwd, main).filter((x) => !x.merged)) for (const i of trailers(run(cwd, 'git', ['log', `${main}..${b.ref}`, '--format=%B']).out)) waiting.add(i);
  const n = waiting.size;
  // Only the present moment is on record: over the cap now is a miss; within
  // it says nothing about the moments before.
  if (n > cap) return row(m.id, m.measure, m.target, 'not met', n, reads, `${n} items wait for merge now (${[...waiting].sort((a, b) => a - b).join(', ')}), over the cap of ${cap}.`);
  return row(m.id, m.measure, m.target, NM, n, reads, `${n} items wait now, within the cap of ${cap}; earlier moments were not recorded.`);
}

// Backlog heads: the second parent of each backlog merge on main (a merge whose
// subject names a claude/backlog-* branch, or whose merged commits carry a
// Backlog-Item trailer) and the head of each waiting branch.
function backlogHeads(cwd, main) {
  const heads = new Map();
  const merges = run(cwd, 'git', ['log', main, '--merges', '--format=%H %P']).out.split('\n').filter(Boolean);
  for (const l of merges) {
    const [, p1, p2] = l.split(' ');
    if (!p2) continue;
    const named = /claude\/backlog-/.test(run(cwd, 'git', ['log', '-1', '--format=%s', l.split(' ')[0]]).out);
    if (named || trailers(run(cwd, 'git', ['log', `${p1}..${p2}`, '--format=%B']).out).length) heads.set(p2, { sha: p2, branch: null, kind: 'merged' });
  }
  for (const b of backlogBranches(cwd, main).filter((x) => !x.merged)) heads.set(b.sha, { sha: b.sha, branch: b.branch, kind: 'waiting' });
  return [...heads.values()];
}

// Backlog heads tested on that exact commit: a head counts as covered only
// with a test.yml run on its SHA. A run on an earlier commit of the branch
// does not cover its head, and a head with no visible run (its branch may be
// deleted) is said not visible, never counted as covered.
function ciCoverage(cwd, main, gh) {
  const reads = ['gh run list --workflow test.yml (headSha)', `git log ${main || 'main'} --merges (backlog merges)`, 'git for-each-ref origin/claude/backlog-*'];
  const m = { id: 'ci_coverage', measure: 'Backlog heads tested on that exact commit', target: '100%' };
  if (!main) return unreadable(m.id, m.measure, m.target, reads, 'No main branch to read.');
  if (gh(cwd, ['auth', 'status']).status !== 0) return unreadable(m.id, m.measure, m.target, reads, 'gh is not signed in.');
  const r = gh(cwd, ['run', 'list', '--workflow', 'test.yml', '--limit', '500', '--json', 'headSha,headBranch,event']);
  if (r.status !== 0) return unreadable(m.id, m.measure, m.target, reads, `gh run list failed: ${r.err.slice(0, 200)}`);
  let runs;
  try { runs = JSON.parse(r.out || '[]'); } catch (_) { return unreadable(m.id, m.measure, m.target, reads, 'gh answered with unreadable JSON.'); }
  if (!Array.isArray(runs)) return unreadable(m.id, m.measure, m.target, reads, 'gh answered with unreadable JSON.');
  const shas = new Set(runs.map((x) => x && x.headSha).filter(Boolean));
  const heads = backlogHeads(cwd, main);
  if (!heads.length) return unreadable(m.id, m.measure, m.target, reads, 'No backlog head is known.');
  const covered = heads.filter((h) => shas.has(h.sha));
  const missing = heads.filter((h) => !shas.has(h.sha));
  const pct = Math.round((covered.length / heads.length) * 1000) / 10;
  const name = (h) => `${(h.branch || 'merged head')} ${h.sha.slice(0, 7)}`;
  return row(m.id, m.measure, m.target, missing.length === 0 ? 'met' : 'not met', pct, reads,
    `${covered.length} of ${heads.length} backlog heads have a test.yml run on that exact commit.${missing.length ? ` No run visible for ${missing.map(name).join(', ')} (a deleted branch or an old run is not visible, so it is not counted as covered).` : ''}`);
}

// Only a structured record counts: audits/*/rollback-drill.json with
// schema_version cr.rollback-drill.v1. Prose never does ("not passed" contains
// "passed").
function rollbackDrill(cwd) {
  const reads = ['audits/*/rollback-drill.json (cr.rollback-drill.v1)'];
  const m = { id: 'rollback_drill', measure: 'Rollback drill', target: 'passed once' };
  const files = run(cwd, 'git', ['ls-files', 'audits']).out.split('\n').filter((f) => /^audits\/[^/]+\/rollback-drill\.json$/.test(f));
  if (!files.length) return unreadable(m.id, m.measure, m.target, reads, 'No rollback-drill.json record is in audits/.');
  const records = [];
  const bad = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(cwd, f), 'utf8'));
      if (rec && rec.schema_version === 'cr.rollback-drill.v1' && (rec.result === 'passed' || rec.result === 'failed')) records.push({ f, rec });
      else bad.push(f);
    } catch (_) { bad.push(f); }
  }
  const passed = records.find((x) => x.rec.result === 'passed');
  if (passed) return row(m.id, m.measure, m.target, 'met', 'passed', [passed.f], `From ${passed.rec.from} to ${passed.rec.to}.`);
  if (records.length) return row(m.id, m.measure, m.target, 'not met', 'recorded, not passed', records.map((x) => x.f), `Latest result: ${records[records.length - 1].rec.result}.`);
  return unreadable(m.id, m.measure, m.target, bad, `The record could not be read as cr.rollback-drill.v1: ${bad.join(', ')}.`);
}

// ---------------------------------------------------------------------------
// The workspace

function pilotRows(ws, now) {
  const tickets = require('../core/tickets');
  const projects = require('../core/projects').listProjects(ws).filter((p) => !p.broken);
  const out = [];
  for (const p of projects) {
    let profile = null;
    try { profile = tickets.view(ws, p.project_id, { now }); } catch (_) { profile = null; }
    if (profile) out.push({ project: p, view: profile });
  }
  return out;
}

function workspaceRows(ws, now) {
  const reads = ['projects/*/tickets (receipts, decisions)'];
  if (!ws) {
    return [
      unreadable('pilot_current', 'Pilot projects with a current ticket', 'ETH, ZAMA and at least 3 more', reads, 'No workspace was read.'),
      unreadable('holding_across_gap', 'Tickets reading "holding" across a gap', '0', reads, 'No workspace was read.'),
      unreadable('pm_cards_48h', 'PM cards waiting more than 48 h', 'listed in the brief by name', reads, 'No workspace was read.'),
    ];
  }
  const rows = [];
  let list = null;
  let listError = null;
  try { list = pilotRows(ws, now); } catch (err) { listError = err; }
  if (!list) {
    const why = `The ticket records could not be read: ${listError.message}`;
    return [
      unreadable('pilot_current', 'Pilot projects with a current ticket', 'ETH, ZAMA and at least 3 more', reads, why),
      unreadable('holding_across_gap', 'Tickets reading "holding" across a gap', '0', reads, why),
      unreadable('pm_cards_48h', 'PM cards waiting more than 48 h', 'listed in the brief by name', reads, why),
    ];
  }

  // Pilot projects with a current ticket: a ticket on Claude's current report.
  const pilots = list.filter((x) => x.view.pilot);
  const current = pilots.filter((x) => x.view.ticket && !x.view.ticket.superseded_by_report);
  const has = (sym) => current.some((x) => [x.project.project_id, x.project.name, x.project.symbol].filter(Boolean).some((s) => String(s).toLowerCase() === sym.toLowerCase() || String(s).toLowerCase().split(/[^a-z0-9]+/).includes(sym.toLowerCase())));
  const named = ['ETH', 'ZAMA'].filter(has);
  rows.push(row('pilot_current', 'Pilot projects with a current ticket', 'ETH, ZAMA and at least 3 more', named.length === 2 && current.length >= 5 ? 'met' : 'not met', current.length, reads,
    `${pilots.length} projects are in the pilot; ${current.length} have a ticket on Claude's current report${current.length ? ` (${current.map((x) => x.project.name || x.project.project_id).join(', ')})` : ''}. ETH ${named.includes('ETH') ? 'has' : 'has no'} a current ticket; ZAMA ${named.includes('ZAMA') ? 'has' : 'has no'} one.`));

  // Tickets that read "holding" across a gap the check itself names.
  let breaches = [];
  for (const x of list) {
    const t = x.view.ticket;
    if (!t || t.desk_gate || !t.invalidation) continue;
    for (const c of t.invalidation.checks || []) {
      if (c.kind === 'price' && c.status === 'holding' && c.coverage && Array.isArray(c.coverage.gaps) && c.coverage.gaps.length) breaches.push(x.project.name || x.project.project_id);
    }
  }
  breaches = [...new Set(breaches)];
  rows.push(row('holding_across_gap', 'Tickets reading "holding" across a gap', '0', breaches.length === 0 ? 'met' : 'not met', breaches.length, reads, breaches.length ? `Reading holding across a gap: ${breaches.join(', ')}.` : 'No current ticket reads holding while its check names a gap. Past readings are not kept.'));

  // PM cards waiting more than 48 h must be named in the brief.
  const old = list.filter((x) => x.view.ticket && x.view.ticket.status === 'pending_pm_review' && now - Date.parse(x.view.ticket.saved_at) > 2 * DAY);
  let listed = null;
  let briefError = null;
  try {
    const brief = require('../core/brief-daily').brief(ws, { now });
    const sec = brief.sections.find((s) => s.id === 'pm_cards');
    listed = sec && sec.state === 'ok' ? sec.lines.map((l) => l.text) : null;
    if (!listed) briefError = sec ? sec.error : 'no PM cards section';
  } catch (err) { briefError = err.message; }
  if (listed === null) rows.push(unreadable('pm_cards_48h', 'PM cards waiting more than 48 h', 'listed in the brief by name', ['core/brief-daily.js'], `The brief could not be read: ${briefError}`));
  else {
    const missing = old.filter((x) => !listed.some((t) => t.startsWith(`${x.project.name}:`)));
    rows.push(row('pm_cards_48h', 'PM cards waiting more than 48 h', 'listed in the brief by name', missing.length === 0 ? 'met' : 'not met', old.length, ['projects/*/tickets', 'core/brief-daily.js (pm_cards)'], old.length ? `${old.length} waiting more than 48 h: ${old.map((x) => x.project.name).join(', ')}; ${old.length - missing.length} named in the brief.` : 'None is waiting more than 48 h.'));
  }
  return rows;
}

function paperRows(ws, now) {
  const reads = ['paper/positions.jsonl', 'portfolio/transactions.json', 'core/paper.js (book)'];
  const cross = { id: 'crossover', measure: 'Paper or ledger crossover', target: '0 records' };
  const edge = { id: 'edge_claims', measure: 'Claims of an edge', target: 'none (no 20 matured outcomes yet)' };
  if (!ws) return [unreadable(cross.id, cross.measure, cross.target, reads, 'No workspace was read.'), unreadable(edge.id, edge.measure, edge.target, reads, 'No workspace was read.')];
  const paper = require('../core/paper');
  const out = [];
  try {
    const recs = paper.readRecords(ws);
    const ids = new Set();
    for (const r of recs) for (const k of ['position_id', 'decision_id', 'receipt_id']) if (r[k]) ids.add(String(r[k]));
    const ledger = require('../core/portfolio').loadTransactions(ws);
    const txIds = new Set(ledger.map((t) => t.tx_id));
    const inLedger = ledger.filter((t) => t.source === 'paper' || [t.tx_id, t.external_id, t.note, t.transfer_id].some((v) => v && [...ids].some((i) => String(v).includes(i))));
    const inPaper = recs.filter((r) => JSON.stringify(r).split(/[^A-Za-z0-9_.:-]+/).some((tok) => txIds.has(tok)));
    const n = inLedger.length + inPaper.length;
    out.push(row(cross.id, cross.measure, cross.target, n === 0 ? 'met' : 'not met', n, reads, `${recs.length} paper records, ${ledger.length} ledger entries; ${inLedger.length} ledger entries name a paper record and ${inPaper.length} paper records name a ledger entry.`));
  } catch (err) { out.push(unreadable(cross.id, cross.measure, cross.target, reads, `Could not be read: ${err.message}`)); }
  try {
    const book = paper.book(ws, { now });
    const shown = Object.keys(book.summary).some((k) => /median|total|beat|hit/.test(k));
    const closed = book.summary.closed;
    out.push(row(edge.id, edge.measure, edge.target, closed < paper.MIN_CLOSED && !shown ? 'met' : closed >= paper.MIN_CLOSED ? NM : 'not met', closed, ['paper/positions.jsonl', 'core/paper.js (book)'],
      closed < paper.MIN_CLOSED ? `${closed} of ${paper.MIN_CLOSED} positions have closed with a measured return; the book shows ${shown ? 'a figure it should not' : 'no total, median or hit rate'}. Claims written outside the records are not read.` : `${closed} positions have closed, so a figure may be shown; whether anyone claimed an edge is not in the records.`));
  } catch (err) { out.push(unreadable(edge.id, edge.measure, edge.target, reads, `Could not be read: ${err.message}`)); }
  return out;
}

function briefsDelivered() {
  return unreadable('briefs_delivered', 'Briefs delivered', 'every day from day 15 (at least 14)', ['core/brief-daily.js'], 'The brief writes nothing, so no record says a brief was delivered on a day.');
}

// ---------------------------------------------------------------------------

function scorecard({ cwd = ROOT, ws = null, now = Date.now(), gh = defaultGh } = {}) {
  const main = mainRef(cwd);
  const gitOk = run(cwd, 'git', ['rev-parse', '--git-dir']).status === 0;
  const git = (fn, id, measure, target) => {
    if (!gitOk) return unreadable(id, measure, target, ['git'], 'This folder is not a git repository.');
    try { return fn(); } catch (err) { return unreadable(id, measure, target, ['git'], `Could not be read: ${err.message}`); }
  };
  const w = workspaceRows(ws, now);
  const p = paperRows(ws, now);
  const rows = [
    git(() => itemsMerged(cwd, main), 'items_merged', 'Backlog items merged to main', '7 to 20'),
    git(() => branchesWaiting(cwd, main, now), 'branches_waiting', 'Branches waiting at any moment', 'at most 4'),
    git(() => ciCoverage(cwd, main, gh), 'ci_coverage', 'Backlog pushes with a CI run', '100%'),
    w.find((r) => r.id === 'pilot_current'),
    w.find((r) => r.id === 'holding_across_gap'),
    w.find((r) => r.id === 'pm_cards_48h'),
    briefsDelivered(),
    git(() => rollbackDrill(cwd), 'rollback_drill', 'Rollback drill', 'passed once'),
    p.find((r) => r.id === 'crossover'),
    p.find((r) => r.id === 'edge_claims'),
  ];
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { format: 'cr-blitz-scorecard@1', as_of: new Date(now).toISOString(), source: 'audits/2026-10-24-30-day-blueprint/README.md section 7', summary: { rows: rows.length, met: count('met'), not_met: count('not met'), not_measurable: count(NM) }, rows, writes_nothing: true };
}

function render(card) {
  const lines = [`Day-30 scorecard (${card.format}), as of ${card.as_of}`, `${card.summary.met} met, ${card.summary.not_met} not met, ${card.summary.not_measurable} not measurable from records`, ''];
  for (const r of card.rows) {
    lines.push(`${r.status === 'met' ? '[met]' : r.status === 'not met' ? '[NOT MET]' : '[?]'} ${r.measure}`);
    lines.push(`    value: ${r.value === null ? NM : r.value}   target: ${r.target}`);
    if (r.note) lines.push(`    ${r.note}`);
    lines.push(`    read: ${r.reads.join('; ')}`);
  }
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const wi = args.indexOf('--workspace');
  let ws = null;
  try {
    const { openWorkspace } = require('../core/workspace');
    // Read-only: no recovery, so opening it repairs and writes nothing.
    ws = openWorkspace({ root: wi >= 0 ? path.resolve(args[wi + 1]) : undefined, actor: 'scorecard', recover: false });
  } catch (_) { ws = null; }
  const card = scorecard({ ws });
  process.stdout.write(`${json ? JSON.stringify(card, null, 2) : render(card)}\n`);
}

module.exports = { scorecard, render, trailers, SURGE_END };
