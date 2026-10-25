#!/usr/bin/env node
'use strict';
// The morning visual sanity report (Eric, 2026-10-25; his choices 1a 2a 3a 4a
// in audits/2026-10-25-visual-proof/PLAN.md). Two modes, one renderer:
//
//   node dashboard/scripts/sanity-report.js [--since 24h|<iso>] [--desk <snapshot.json>]
//        [--proof <dir>] [--tests <test-summary.md>] [--json] [--out <file>]
//     On Eric's PC: the backlog items merged into origin/main since --since,
//     the CI test counts and the visual proof of the newest merged head
//     (through `gh` when signed in, else --tests and --proof), and the live
//     desk's state from a snapshot Claude saved through the read-only
//     connector (desk_status and daily_brief, cr.desk-snapshot.v1).
//
//   node dashboard/scripts/sanity-report.js --pr --head <sha> --branch <b>
//        [--base origin/main] [--repo o/r] [--pr-url u --pr-state open|merged]
//        [--run-url u] [--proof <dir>] [--tests <file>] [--images-base <url>]
//        [--images-out <dir>] [--out <file>]
//     In CI (.github/workflows/visual-proof.yml): the comment on a backlog
//     PR, with CI facts only. A desk snapshot is refused here: live records
//     never go to GitHub.
//
// Every value names where it came from; a value nothing measured reads
// "unknown" or "not read", never a number. The visual lines stay unticked
// boxes for Eric: nothing is ever called verified or confirmed, and nothing
// is called a consensus. The visual proof (proof-shots.mjs) is made by the
// branch's own code, so it is read as untrusted data: fixed file names, PNG
// signatures and bounded sizes, numbers and booleans only, text escaped.
// It calls no model and writes only --out and --images-out (and removes the
// temporary folder its `gh` downloads go to).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
// Render service srv-db02t2hsrm7s73dspnn0 ("CryptoResearch"), read 2026-10-25.
const DESK_URL = 'https://cryptoresearch.onrender.com';
const DESK_URL_SOURCE = 'Render service srv-db02t2hsrm7s73dspnn0 (its url), read 2026-10-25';
const MARKER = '<!-- cr-visual-proof -->';
const PROOF_VERSION = 'cr.visual-proof.v1';
const SNAPSHOT_VERSION = 'cr.desk-snapshot.v1';
const SHOTS = ['desk', 'inspector', 'review', 'portfolio'];
const SHOT_LABELS = { desk: 'Desk', inspector: 'Inspector open', review: 'Review, three panes', portfolio: 'Portfolio' };
const PROVIDERS = ['claude', 'chatgpt', 'gemini'];
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const MAX_PNG = 3 * 1024 * 1024;
const MAX_JSON = 256 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// What the desk's own rules say each view should be (CLAUDE.md, executive
// scale, Eric 2026-10-18): Desk rows 60px, names 15px.
const TARGETS = { row_height_px: 60, name_font_px: 15 };
const RAW_ID = /^(?:\d{4}-\d{2}-\d{2}_(?:claude|chatgpt|gemini)_[0-9a-f]{8}|[a-z]{1,8}_\d{4}-\d{2}-\d{2}T\d{6}Z(?:_[a-z0-9-]{2,24})?|[0-9a-f]{40,64})$/;

function run(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, out: '', err: String(r.error.message) };
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const defaultGh = (cwd, args) => run(cwd, 'gh', args);
const git = (cwd, args) => run(cwd, 'git', args);
const short = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');

// ---------------------------------------------------------------------------
// Text from records or from the branch's own output: escaped, one line,
// bounded. With the brackets, angle brackets and backticks escaped no link,
// image, tag or code span can form. Inline code never carries a backtick or a
// line break.

function esc(s, max = 200) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .slice(0, max)
    .replace(/[\\`*_[\]#!|<>~]/g, (c) => `\\${c}`)
    .trim();
}
const code = (s, max = 80) => `\`${String(s).replace(/[`\r\n\u0000-\u001f]/g, ' ').slice(0, max)}\``;
const num = (v, lo = 0, hi = 1e6) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const bool = (v) => (typeof v === 'boolean' ? v : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const trailers = (text) => [...String(text).matchAll(/^Backlog-Item:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));

function itemRange(items) {
  const list = [...new Set(items)].sort((a, b) => a - b);
  if (!list.length) return null;
  const runs = [];
  for (const n of list) {
    const last = runs[runs.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else runs.push([n, n]);
  }
  return runs.map(([a, b]) => (a === b ? `#${a}` : `#${a}–${b}`)).join(', ');
}

function nyDate(ms) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
  return `${day}, ${time}`;
}

function parseSince(v, now) {
  if (v === null || v === undefined || v === '') return now - 24 * 3600000;
  const rel = /^(\d+)\s*([hd])$/i.exec(String(v).trim());
  if (rel) return now - Number(rel[1]) * (rel[2].toLowerCase() === 'd' ? 86400000 : 3600000);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`"${v}" is not a time: give --since as 24h, 2d or an ISO time.`);
  return ms;
}

// ---------------------------------------------------------------------------
// CI facts

// The counts test.yml writes (test-summary.md): "- tests 902", "- pass 902"…
function parseTestSummary(text) {
  if (typeof text !== 'string') return null;
  const out = {};
  for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const m = new RegExp(`^- ${k} (\\d+)\\s*$`, 'm').exec(text);
    out[k] = m ? Number(m[1]) : null;
  }
  return out.tests === null && out.pass === null ? null : out;
}

function testWords(t) {
  if (!t) return null;
  if (t.tests === null || t.pass === null) return 'counts incomplete';
  const extra = [t.fail ? `${t.fail} failed` : null, t.cancelled ? `${t.cancelled} cancelled` : null, t.skipped ? `${t.skipped} skipped` : null, t.todo ? `${t.todo} todo` : null].filter(Boolean);
  return `${t.pass} of ${t.tests} passed${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

// The two browser check scripts' own output (npm run check), saved by the
// capture job as check.txt and regress.txt. Numbers only.
function parseBrowserChecks(dir) {
  const read = (f) => {
    const p = dir ? path.join(dir, f) : null;
    if (!p || !fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_JSON * 4) return null;
    return fs.readFileSync(p, 'utf8');
  };
  const c = read('check.txt');
  const r = read('regress.txt');
  let check = null;
  if (c !== null) {
    const failed = /^(\d+) check\(s\) failed:/m.exec(c);
    const passed = /^All browser checks passed\.$/m.test(c);
    check = { ran: true, passed: passed && !failed, failures: failed ? Number(failed[1]) : passed ? 0 : null, ok_lines: (c.match(/^ok {2}/gm) || []).length };
  }
  let regress = null;
  if (r !== null) {
    const m = /^(\d+) of (\d+) regression checks passed/m.exec(r);
    regress = m ? { ran: true, passed: Number(m[1]), total: Number(m[2]) } : { ran: true, passed: null, total: null };
  }
  return { check, regress };
}

function browserWords(b) {
  const parts = [];
  if (!b || (!b.check && !b.regress)) return null;
  if (b.check) parts.push(b.check.passed ? 'check.mjs passed (0 failures)' : b.check.failures !== null ? `check.mjs: ${plural(b.check.failures, 'failure')}` : 'check.mjs: stopped before its result (no pass or failure line)');
  else parts.push('check.mjs: not run');
  if (b.regress) parts.push(b.regress.total !== null ? `regress.mjs ${b.regress.passed} of ${b.regress.total} passed` : 'regress.mjs: stopped before its count');
  else parts.push('regress.mjs: not run');
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// The visual proof (proof-shots.mjs), read as untrusted data.

function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIG) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const MEASURE_KEYS = {
  desk: { rows: num, row_height_px: num, name_font_px: num, name_weight: num, columns: num },
  inspector: { strip: bool, cells: num, one_row: bool, wrapped_heads: num, wrapped_notes: num, inspector_width_px: num },
  review: { panes: num, raw_ids_visible: num },
  portfolio: { badge: bool, needs_attention: num },
};

function cleanMeasures(name, m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const [k, f] of Object.entries(MEASURE_KEYS[name])) out[k] = f(m[k]);
  if (name === 'desk' && m.consensus_marks && typeof m.consensus_marks === 'object') {
    out.consensus_marks = {};
    for (const k of ['graded', 'waiting', 'withheld', 'problem', 'hold', 'none']) out.consensus_marks[k] = num(m.consensus_marks[k]);
  }
  if (name === 'review') out.raw_id_samples = Array.isArray(m.raw_id_samples) ? m.raw_id_samples.filter((s) => typeof s === 'string' && RAW_ID.test(s)).slice(0, 5) : [];
  return out;
}

function validateProof(dir, { imagesOut = null } = {}) {
  const problems = [];
  const file = dir ? path.join(dir, 'proof.json') : null;
  if (!file || !fs.existsSync(file)) return { present: false, shots: [], problems: ['No visual proof was found.'] };
  let proof;
  try {
    if (fs.statSync(file).size > MAX_JSON) throw new Error('proof.json is larger than 256 KB');
    proof = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { present: false, shots: [], problems: [`proof.json could not be read: ${err.message}`] };
  }
  if (!proof || proof.schema_version !== PROOF_VERSION || proof.desk !== 'fictional') return { present: false, shots: [], problems: [`proof.json is not ${PROOF_VERSION} from the fictional desk.`] };
  const vp = proof.viewport || {};
  const shots = [];
  for (const name of SHOTS) {
    const s = (Array.isArray(proof.shots) ? proof.shots : []).find((x) => x && x.name === name);
    if (!s) { problems.push(`${SHOT_LABELS[name]}: not captured.`); continue; }
    const png = path.join(dir, `${name}.png`);
    let image = null;
    if (fs.existsSync(png) && fs.statSync(png).isFile() && fs.statSync(png).size <= MAX_PNG) {
      const buf = fs.readFileSync(png);
      const size = pngSize(buf);
      if (size && size.width > 0 && size.width <= 4000 && size.height > 0 && size.height <= 10000) {
        image = { file: `${name}.png`, bytes: buf.length, ...size };
        if (imagesOut) { fs.mkdirSync(imagesOut, { recursive: true }); fs.writeFileSync(path.join(imagesOut, `${name}.png`), buf); }
      }
    }
    if (!image) problems.push(`${SHOT_LABELS[name]}: no usable PNG (missing, not a PNG, or too large).`);
    const errors = Array.isArray(s.errors) ? s.errors.filter((e) => typeof e === 'string') : [];
    const writes = Array.isArray(s.writes) ? s.writes.filter((e) => typeof e === 'string') : [];
    shots.push({ name, label: SHOT_LABELS[name], ready: s.ready === true, image, measures: cleanMeasures(name, s.measures), errors: errors.length, error_samples: errors.slice(0, 3), writes: writes.length, write_samples: writes.slice(0, 3) });
  }
  return { present: true, viewport: { width: num(vp.width, 1, 10000), height: num(vp.height, 1, 10000) }, theme: proof.theme === 'dark' ? 'dark' : 'light', taken_at: typeof proof.taken_at === 'string' && Number.isFinite(Date.parse(proof.taken_at)) ? new Date(Date.parse(proof.taken_at)).toISOString() : null, shots, problems };
}

// One line per view, with the measured value beside its target.
function visualLines(proof) {
  const shot = (name) => (proof && proof.present ? proof.shots.find((s) => s.name === name) : null) || null;
  const notMeasured = (name) => `not measured: ${proof && proof.present ? `the ${SHOT_LABELS[name].toLowerCase()} view was not captured` : 'no visual proof for this commit'}`;
  const pageNote = (s) => [s.errors ? `${plural(s.errors, 'console error')} (${s.error_samples.map((e) => code(e)).join(', ')})` : null, s.writes ? `${plural(s.writes, 'write')} on opening (${s.write_samples.map((e) => code(e)).join(', ')})` : null].filter(Boolean).join('; ');
  const lines = [];
  {
    const s = shot('desk');
    const m = s && s.measures;
    let words = notMeasured('desk');
    if (m) {
      const marks = m.consensus_marks ? Object.entries(m.consensus_marks).filter(([, n]) => n).map(([k, n]) => `${n} ${k === 'waiting' ? 'waiting ○' : k}`).join(', ') : null;
      words = [
        m.row_height_px !== null ? `rows ${m.row_height_px}px (target ${TARGETS.row_height_px}px)` : 'row height not measured',
        m.name_font_px !== null ? `names ${m.name_font_px}px${m.name_weight !== null ? ` / ${m.name_weight}` : ''} (target ${TARGETS.name_font_px}px)` : 'name size not measured',
        m.columns !== null ? `${plural(m.columns, 'column')} shown` : null,
        marks ? `model marks drawn: ${marks}` : null,
      ].filter(Boolean).join('; ');
    }
    lines.push({ id: 'desk', title: 'Desk table', words, page: s ? pageNote(s) : '' });
  }
  {
    const s = shot('inspector');
    const m = s && s.measures;
    let words = notMeasured('inspector');
    if (m && m.strip === false) words = 'the Key metrics strip was not found in the drawer';
    else if (m) {
      words = [
        m.cells !== null ? `Key metrics: ${plural(m.cells, 'cell')}${m.one_row === true ? ' in one row' : m.one_row === false ? ' on more than one row' : ''}` : null,
        m.wrapped_heads !== null ? (m.wrapped_heads ? `a label or figure wraps in ${plural(m.wrapped_heads, 'cell')}` : 'no label or figure wraps') : null,
        m.wrapped_notes ? `the notes under a figure wrap in ${plural(m.wrapped_notes, 'cell')}` : null,
        m.inspector_width_px !== null ? `drawer ${m.inspector_width_px}px wide` : null,
      ].filter(Boolean).join('; ');
    }
    lines.push({ id: 'inspector', title: 'Inspector drawer', words, page: s ? pageNote(s) : '' });
  }
  {
    const s = shot('review');
    const m = s && s.measures;
    let words = notMeasured('review');
    if (m) {
      words = [
        m.panes !== null ? `${plural(m.panes, 'pane')} drawn` : null,
        m.raw_ids_visible === null ? 'raw IDs not counted' : m.raw_ids_visible ? `${plural(m.raw_ids_visible, 'raw record ID or hash', 'raw record IDs or hashes')} in visible text (${m.raw_id_samples.map((x) => code(x)).join(', ')})` : 'no raw record ID or hash in visible text',
      ].filter(Boolean).join('; ');
    }
    lines.push({ id: 'review', title: 'Review, three panes', words, page: s ? pageNote(s) : '' });
  }
  {
    const s = shot('portfolio');
    const m = s && s.measures;
    let words = notMeasured('portfolio');
    if (m) words = `${m.badge ? `Needs attention badge reads ${m.needs_attention === null ? 'something that is not a number' : m.needs_attention}` : 'no Needs attention badge (0 records need attention)'} on the fictional desk`;
    lines.push({ id: 'portfolio', title: 'Portfolio badge', words: `${words}; the live count has no read-only source`, page: s ? pageNote(s) : '' });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// The live desk, from a snapshot of the read-only connector tools.

function readSnapshot(file) {
  const st = fs.statSync(file);
  if (st.size > 8 * MAX_JSON) throw new Error('the desk snapshot is larger than 2 MB');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!s || s.schema_version !== SNAPSHOT_VERSION) throw new Error(`the desk snapshot is not ${SNAPSHOT_VERSION}`);
  return s;
}

function deskFacts(snap) {
  if (!snap) return null;
  const ds = snap.desk_status || null;
  const brief = snap.daily_brief || null;
  const models = {};
  const rm = ds && ds.research && ds.research.models;
  for (const p of PROVIDERS) {
    const m = rm && rm[p];
    if (!m) { models[p] = null; continue; }
    const j = m.jobs || {};
    models[p] = {
      status: typeof m.status === 'string' ? m.status : null,
      key: m.key && typeof m.key.present === 'boolean' ? m.key.present : null,
      waiting: num(j.waiting), queued: num(j.queued), on_api: num(j.on_api), with_assistant: num(j.with_assistant), uncertain: num(j.uncertain),
    };
  }
  const section = (id) => {
    const s = brief && Array.isArray(brief.sections) ? brief.sections.find((x) => x && x.id === id) : null;
    if (!s) return null;
    return { state: s.state, count: num(s.count), count_read: num(s.count_read), unreadable: num(s.unreadable_count) };
  };
  return {
    taken_at: typeof snap.taken_at === 'string' ? snap.taken_at : null,
    revision: ds && ds.revision && typeof ds.revision.short === 'string' ? ds.revision.short : null,
    prices: ds && ds.prices && typeof ds.prices.freshness === 'string' ? ds.prices.freshness : null,
    models,
    pm_cards: section('pm_cards'),
    invalidated: section('invalidated'),
    pilot_exits: section('pilot_exits'),
    brief_format: brief && typeof brief.format === 'string' ? brief.format : null,
    brief_sha: brief && typeof brief.text_sha256 === 'string' ? brief.text_sha256 : null,
  };
}

const sectionWords = (s, what) => {
  if (!s) return `${what}: not in the snapshot`;
  if (s.state === 'ok') return `${what}: ${s.count}`;
  if (s.state === 'partial') return `${what}: ${s.count_read} read, ${s.unreadable} could not be read, so the count is unknown`;
  return `${what}: could not be read on the desk`;
};

const STATUS_WORDS = { automatic: 'automatic (API)', manual: 'manual', on_hold: 'on hold', demo: 'demo fixtures' };
function modelWords(p, m) {
  if (!m) return `${PROVIDER_LABELS[p]}: not in the snapshot`;
  const jobs = [m.waiting ? `${m.waiting} waiting ○` : null, m.queued ? `${m.queued} queued` : null, m.on_api ? `${m.on_api} on the API` : null, m.with_assistant ? `${m.with_assistant} with its assistant` : null, m.uncertain ? `${m.uncertain} uncertain` : null].filter(Boolean);
  return `${PROVIDER_LABELS[p]}: ${STATUS_WORDS[m.status] || m.status || 'state unknown'}${m.key === false ? ', no API key on the desk' : m.key === true ? ', API key set' : ''}; ${jobs.length ? jobs.join(', ') : 'nothing waiting'}`;
}

// ---------------------------------------------------------------------------
// Git and GitHub

function originRepo(cwd) {
  const url = git(cwd, ['remote', 'get-url', 'origin']).out;
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
  return m ? m[1] : null;
}

function batchOfPr(cwd, base, head) {
  const r = git(cwd, ['log', `${base}..${head}`, '--format=%B']);
  if (r.status !== 0) return { items: null, why: `git could not read ${base}..${short(head)}` };
  return { items: [...new Set(trailers(r.out))].sort((a, b) => a - b) };
}

// The backlog merges on main's first-parent line between two times: each
// merge's second parent is the head that was tested.
function batchSince(cwd, main, sinceMs, untilMs = Date.now()) {
  const r = git(cwd, ['log', '--first-parent', `--since=${new Date(sinceMs).toISOString()}`, `--until=${new Date(untilMs).toISOString()}`, '--format=%H %P', main]);
  if (r.status !== 0) return { items: null, heads: [], why: `git could not read ${main}` };
  const items = new Set();
  const heads = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [sha, p1, p2] = line.split(' ');
    const body = p2 ? git(cwd, ['log', `${p1}..${p2}`, '--format=%B']).out : git(cwd, ['log', '-1', '--format=%B', sha]).out;
    const found = trailers(body);
    if (!found.length) continue;
    for (const i of found) items.add(i);
    heads.push({ merge: sha, head: p2 || sha, items: [...new Set(found)].sort((a, b) => a - b) });
  }
  return { items: [...items].sort((a, b) => a - b), heads };
}

function mainRef(cwd) {
  for (const ref of ['origin/main', 'main']) if (git(cwd, ['rev-parse', '--verify', '-q', ref]).status === 0) return ref;
  return null;
}

const ghJson = (gh, cwd, args) => {
  const r = gh(cwd, args);
  if (r.status !== 0) return { error: r.err || `gh exited ${r.status}` };
  try { return { value: JSON.parse(r.out || 'null') }; } catch (_) { return { error: 'gh gave no JSON' }; }
};

// The test run on that exact commit and its counts, and the visual proof
// artifact named for it, downloaded into a temporary folder. The push run is
// the one backlog-pr.yml gates on; a pull_request run on the same commit can
// end without a job once the branch is deleted, so it is read only when no
// push run finished.
function ciForHead(cwd, gh, repo, sha, tmp) {
  const out = { test: null, test_source: null, proof_dir: null, proof_source: null, pr: null, notes: [] };
  const runs = ghJson(gh, cwd, ['run', 'list', '--workflow', 'test.yml', '--commit', sha, '--json', 'databaseId,conclusion,status,event,url', '--limit', '10']);
  if (runs.error) out.notes.push(`gh could not list the test runs (${runs.error})`);
  else {
    const completed = (runs.value || []).filter((x) => x && x.status === 'completed');
    const done = completed.find((x) => x.event === 'push') || completed[0];
    if (!done) out.notes.push(`no completed test run on ${short(sha)}`);
    else {
      out.test_run = { conclusion: done.conclusion, event: done.event || null, url: done.url };
      const dir = path.join(tmp, `tests-${done.databaseId}`);
      const dl = gh(cwd, ['run', 'download', String(done.databaseId), '-n', 'test-summary', '-D', dir]);
      const f = path.join(dir, 'test-summary.md');
      if (dl.status === 0 && fs.existsSync(f)) { out.test = parseTestSummary(fs.readFileSync(f, 'utf8')); out.test_source = `test-summary artifact of the ${done.event || ''} test run on ${short(sha)} (${done.url})`.replace('  ', ' '); } else out.notes.push(`the test run on ${short(sha)} has no test-summary artifact`);
    }
  }
  if (repo) {
    const art = ghJson(gh, cwd, ['api', `repos/${repo}/actions/artifacts?name=visual-proof-${sha}&per_page=5`]);
    const a = art.value && Array.isArray(art.value.artifacts) ? art.value.artifacts.find((x) => x && !x.expired && x.workflow_run) : null;
    if (a) {
      const dir = path.join(tmp, `proof-${a.id}`);
      const dl = gh(cwd, ['run', 'download', String(a.workflow_run.id), '-n', `visual-proof-${sha}`, '-D', dir]);
      if (dl.status === 0) { out.proof_dir = dir; out.proof_source = `visual-proof-${short(sha)} artifact of visual-proof.yml run ${a.workflow_run.id}`; }
    } else out.notes.push(`no visual-proof artifact for ${short(sha)}${art.error ? ` (${art.error})` : ''}`);
    const prs = ghJson(gh, cwd, ['api', `repos/${repo}/commits/${sha}/pulls`]);
    const pr = prs.value && Array.isArray(prs.value) ? prs.value[0] : null;
    if (pr && typeof pr.html_url === 'string') out.pr = { url: pr.html_url, number: pr.number, state: pr.merged_at ? 'merged' : pr.state };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The report

function build(opts) {
  const { cwd = ROOT, now = Date.now(), gh = defaultGh } = opts;
  const sources = [];
  const src = (value, source) => { sources.push({ value, source }); };
  const repo = opts.repo || originRepo(cwd);
  const r = { mode: opts.pr ? 'pr' : 'morning', generated_at: new Date(now).toISOString(), date: nyDate(now), repo, sources };
  src('Date', "this script's clock, in America/New_York");

  let proofDir = opts.proof || null;
  let proofSource = proofDir ? `${proofDir}/proof.json (proof-shots.mjs on the fictional desk)` : null;
  let tests = opts.tests ? parseTestSummary(fs.existsSync(opts.tests) ? fs.readFileSync(opts.tests, 'utf8') : null) : null;
  let testSource = opts.tests ? `${opts.tests} (test.yml's test-summary)` : null;
  let tmp = null;

  if (opts.pr) {
    if (opts.desk) throw new Error('A desk snapshot is never rendered into a pull request comment: live records stay off GitHub.');
    const base = opts.base || 'origin/main';
    const b = batchOfPr(cwd, base, opts.head);
    r.batch = { items: b.items, words: b.items === null ? `unknown (${b.why})` : itemRange(b.items) || 'no Backlog-Item trailers' };
    r.head = opts.head;
    r.branch = opts.branch || null;
    r.pr = opts.prUrl ? { url: opts.prUrl, state: opts.prState === 'merged' ? 'merged' : opts.prState === 'open' ? 'open' : null } : null;
    r.run_url = opts.runUrl || null;
    src('Build batch', `\`Backlog-Item:\` trailers in \`git log ${/^[0-9a-f]{40}$/i.test(base) ? short(base) : base}..${short(opts.head)}\``);
  } else {
    const main = mainRef(cwd);
    const sinceMs = parseSince(opts.since, now);
    r.since = new Date(sinceMs).toISOString();
    const b = main ? batchSince(cwd, main, sinceMs, now) : { items: null, heads: [], why: 'no main branch to read' };
    r.batch = { items: b.items, heads: b.heads, words: b.items === null ? `unknown (${b.why})` : itemRange(b.items) || `nothing merged since ${nyDate(sinceMs)}` };
    src('Build batch', `\`Backlog-Item:\` trailers of the backlog merges on ${main || 'main'}'s first-parent line from ${r.since} to ${r.generated_at}`);
    const newest = b.heads[0] || null;
    r.head = newest ? newest.head : null;
    if (newest && (!opts.tests || !opts.proof)) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-sanity-'));
      const ci = ciForHead(cwd, gh, repo, newest.head, tmp);
      r.ci_notes = ci.notes;
      r.test_run = ci.test_run || null;
      if (!opts.tests && ci.test) { tests = ci.test; testSource = ci.test_source; }
      if (!opts.proof && ci.proof_dir) { proofDir = ci.proof_dir; proofSource = ci.proof_source; }
      r.pr = ci.pr;
    }
  }

  try {
    r.tests = { counts: tests, words: testWords(tests) || 'unknown: no test counts were given or found' };
    src('Unit tests', testSource || 'none given or found');
    const proof = validateProof(proofDir, { imagesOut: opts.imagesOut || null });
    r.proof = proof;
    r.visual = visualLines(proof);
    src('Section 1 (visual surfaces)', proofSource ? `${proofSource}; checked by this script (fixed names, PNG signature, sizes; numbers and booleans only)` : 'no visual proof given or found');
    r.browser = parseBrowserChecks(proof.present ? proofDir : null);
    r.browser_words = browserWords(r.browser) || 'not run: no browser check output was given or found';
    src('Browser checks', proof.present && (r.browser.check || r.browser.regress) ? `check.txt and regress.txt beside the visual proof (npm run check's two scripts, report-only)` : 'none given or found');
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }

  const desk = opts.desk ? deskFacts(readSnapshot(opts.desk)) : null;
  r.desk = desk;
  if (desk) {
    r.models = PROVIDERS.map((p) => modelWords(p, desk.models[p]));
    const waiting = PROVIDERS.map((p) => desk.models[p]).filter(Boolean);
    const total = waiting.length === PROVIDERS.length && waiting.every((m) => m.waiting !== null) ? waiting.reduce((s, m) => s + m.waiting + (m.queued || 0) + (m.uncertain || 0), 0) : null;
    r.waiting_words = `${total === null ? 'unknown' : total} research ${total === 1 ? 'job' : 'jobs'} waiting, queued or uncertain on the desk (snapshot taken ${desk.taken_at || 'at an unknown time'}; ${PROVIDERS.map((p) => `${PROVIDER_LABELS[p]} ${desk.models[p] && desk.models[p].waiting !== null ? desk.models[p].waiting : '?'}`).join(', ')} waiting); ${sectionWords(desk.pm_cards, 'PM cards waiting for you')}`;
    r.exit_words = `refresh age unknown: no read-only tool reports the exit-quote monitor's status; ${sectionWords(desk.pilot_exits, 'pilot projects missing an exit reading')}`;
    src('Waiting jobs and models', `desk snapshot ${opts.desk} taken ${desk.taken_at || 'at an unknown time'}: desk_status.research.models (jobs per model, status, key) and daily_brief (${desk.brief_format || 'format unknown'}${desk.brief_sha ? `, text SHA-256 ${desk.brief_sha.slice(0, 12)}…` : ''}) sections pm_cards and pilot_exits`);
  } else {
    const why = opts.pr ? 'CI has no access to the live desk' : 'no desk snapshot given (--desk)';
    r.models = [`not read: ${why}. As recorded on 2026-10-25, not read now: Gemini on hold on the online desk; ChatGPT and Gemini with no API key on Render`];
    r.waiting_words = `not read: ${why}`;
    r.exit_words = `unknown: ${why}, and no read-only tool reports the exit-quote monitor's status`;
    src('Waiting jobs and models', opts.pr ? "not read in CI; the hold and keys line is the desk's record as of 2026-10-25 (CLAUDE.md), not a reading" : 'not read; the hold and keys line is the record as of 2026-10-25 (CLAUDE.md), not a reading');
  }

  // The status line: what CI said about the commit this report describes.
  const t = r.tests.counts;
  const ciPassed = t && t.tests !== null && t.pass === t.tests && !t.fail;
  r.status = !r.head ? 'no backlog merge in the window' : t ? `${ciPassed ? 'unit tests passed' : 'unit tests did not all pass'} on ${short(r.head)}` : r.test_run ? `test run ${r.test_run.conclusion || 'unfinished'} on ${short(r.head)} (counts not found)` : `CI result unknown for ${short(r.head)}`;
  src('Status', 'the unit test counts above, for the commit named');
  src('Live desk link', DESK_URL_SOURCE);
  if (r.pr) src('Pull request link', opts.pr ? 'the pull request the workflow found for this branch' : `GitHub's pull requests for commit ${short(r.head)}, through gh`);
  return r;
}

function render(r, { imagesBase = null } = {}) {
  const L = [];
  if (r.mode === 'pr') L.push(MARKER);
  L.push('# 🌅 CryptoResearch Morning Visual Sanity Report', '');
  L.push(`Date: ${r.date} | Build batch: ${r.batch.words} | Status: ${r.status}`, '');
  if (r.mode === 'pr') {
    const prState = r.pr && r.pr.state === 'merged' ? ' This pull request was already merged when these screenshots were posted: anything they show may already be on main, and possibly live.' : '';
    L.push(`Branch ${code(r.branch || 'unknown')}, tested head ${code(short(r.head))}${r.run_url ? ` ([the test run](${r.run_url}))` : ''}.${prState}`, '');
  }
  L.push('## 1. Core visual surfaces', '');
  const vp = r.proof.present && r.proof.viewport ? `${r.proof.viewport.width}×${r.proof.viewport.height}` : 'unknown size';
  L.push(r.proof.present
    ? `Measured on the FICTIONAL desk in headless Chrome at ${vp}, ${r.proof.theme} theme${r.proof.taken_at ? `, ${r.proof.taken_at}` : ''}: not the live desk. The boxes are yours to tick after looking.`
    : 'Nothing measured: no visual proof for this commit. The boxes are yours to tick after looking at the desk.', '');
  for (const v of r.visual) {
    L.push(`- [ ] **${v.title}:** ${v.words}.${v.page ? ` ${v.page}.` : ''}`);
  }
  if (r.proof.present && r.proof.problems.length) L.push('', `Capture problems: ${r.proof.problems.map((p) => esc(p)).join(' ')}`);
  if (imagesBase && r.proof.present) {
    for (const s of r.proof.shots.filter((x) => x.image)) {
      L.push('', `**${s.label}** (fictional desk)`, '', `<img src="${imagesBase}/${s.image.file}" alt="${s.label}, fictional desk" width="720">`);
    }
  }
  L.push('', '## 2. Autonomous pipeline and API health', '');
  L.push(`- [ ] **Waiting jobs:** ${r.waiting_words}.`);
  L.push(`- [ ] **Exit quotes (KyberSwap, Jupiter):** ${r.exit_words}.`);
  L.push(`- [ ] **Models, each on its own (nothing averaged or called a consensus):** ${r.models.join('; ')}.`);
  L.push(`- [ ] **Tests:** unit ${r.tests.words}; browser checks ${r.browser_words}.`);
  if (r.desk && r.desk.revision) L.push(`- [ ] **Deploy:** the desk in the snapshot runs ${code(r.desk.revision)}${r.head ? `; the newest merged head is ${code(short(r.head))}` : ''}.`);
  if (r.ci_notes && r.ci_notes.length) L.push('', `CI notes: ${r.ci_notes.map((n) => esc(n)).join('; ')}.`);
  L.push('', '## 3. Quick visual links for Eric', '');
  L.push(`- [Live production desk](${DESK_URL})`);
  if (r.pr && r.pr.url) L.push(`- [${r.mode === 'pr' ? 'This pull request' : `Pull request${r.pr.number ? ` #${r.pr.number}` : ''}`}](${r.pr.url})${r.pr.state ? ` (${r.pr.state})` : ''}`);
  if (r.repo) L.push(`- [Backlog pull requests](https://github.com/${r.repo}/pulls?q=is%3Apr+head%3Aclaude%2Fbacklog-)`);
  L.push('', '<details><summary>Where each value comes from</summary>', '', '| Value | Source |', '|---|---|');
  for (const s of r.sources) L.push(`| ${s.value} | ${String(s.source).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  L.push('', '</details>', '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {};
  const take = (k) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };
  for (const [flag, key] of [['--since', 'since'], ['--desk', 'desk'], ['--proof', 'proof'], ['--tests', 'tests'], ['--out', 'out'], ['--head', 'head'], ['--branch', 'branch'], ['--base', 'base'], ['--repo', 'repo'], ['--pr-url', 'prUrl'], ['--pr-state', 'prState'], ['--run-url', 'runUrl'], ['--images-base', 'imagesBase'], ['--images-out', 'imagesOut']]) {
    const v = take(flag);
    if (v !== null) o[key] = v;
  }
  o.pr = argv.includes('--pr');
  o.json = argv.includes('--json');
  return o;
}

function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.pr && !/^[0-9a-f]{7,40}$/i.test(o.head || '')) throw new Error('--pr needs --head <sha>.');
  if (o.imagesBase && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/raw\/[\w./-]+$/.test(o.imagesBase)) throw new Error('--images-base must be a https://github.com/<owner>/<repo>/raw/... address.');
  const r = build(o);
  const text = o.json ? `${JSON.stringify({ ...r, markdown: render(r, { imagesBase: o.imagesBase }) }, null, 1)}\n` : render(r, { imagesBase: o.imagesBase });
  if (o.out) fs.writeFileSync(o.out, text); else process.stdout.write(text);
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); } catch (err) { process.stderr.write(`${err.message}\n`); process.exit(1); }
}

module.exports = { build, render, main, parseArgs, parseTestSummary, parseBrowserChecks, validateProof, visualLines, deskFacts, itemRange, batchOfPr, batchSince, esc, MARKER, DESK_URL };
