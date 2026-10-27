// The visual proof for a backlog pull request (Eric, 2026-10-25;
// audits/2026-10-25-visual-proof): the four core views of the built app on
// the FICTIONAL offline desk (dev-desk.cjs), in headless Chrome, at 1440×900
// in the light theme, with what can be measured on that desk:
//   desk       #/watchlist: the first row's height, the project name's size
//              and weight, the columns shown, the consensus marks drawn;
//   inspector  #/watchlist?p=<relay>: the Key metrics strip (cells, one row,
//              any label or figure wrapped, notes under a figure wrapped);
//   review     #/review?p=<relay>: the three panes drawn, and raw record IDs
//              or hashes in their visible text (tooltips are not visible;
//              any visible one fails the proof, L6);
//   portfolio  #/portfolio: the Needs attention count on the rail.
// Every page also records its errors and any request that is not a GET
// (there must be none). Never the live desk and never real records.
//   node scripts/proof-shots.mjs --out <dir> [--base http://127.0.0.1:4790]
// Writes <dir>/<name>.png and <dir>/proof.json (cr.visual-proof.v1).
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = path.resolve(arg('--out', 'proof'));
const W = 1440;
const H = 900;

let desk = null;
let base = arg('--base', null);
if (!base) {
  desk = fork(path.join(here, 'dev-desk.cjs'), ['--port', String(4890 + Math.floor(Math.random() * 90))], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  base = (await new Promise((resolve, reject) => {
    desk.on('message', (m) => { if (m && m.ready) resolve(m); });
    desk.on('exit', (code) => reject(new Error(`the dev desk stopped (exit ${code})`)));
  })).url;
}

const session = await (await fetch(`${base}/api/session`)).json();
const index = await (await fetch(`${base}/api/index`, { headers: { 'x-cr-token': session.token } })).json();
const relay = (index.projects.find((p) => /Relay Network/.test(p.name)) || {}).project_id;

// Raw record IDs as the desk writes them: reports (2026-10-01_claude_56562da0),
// runs and tickets (run_…, tr_… with a compact time), and hex hashes.
const RAW_ID = String.raw`\b\d{4}-\d{2}-\d{2}_(?:claude|chatgpt|gemini)_[0-9a-f]{8}\b|\b[a-z]{1,8}_\d{4}-\d{2}-\d{2}T\d{6}Z(?:_[a-z0-9-]{2,24})?\b|\b[0-9a-f]{40,64}\b`;

const MEASURE = {
  desk: `(() => {
    const row = document.querySelector('.wl-table tbody tr');
    const name = row && row.querySelector('.pname');
    const cs = name ? getComputedStyle(name) : null;
    const marks = {};
    for (const k of ['graded', 'waiting', 'withheld', 'problem', 'hold', 'none']) marks[k] = document.querySelectorAll('.wl-table .cg-dot.is-' + k).length;
    return {
      rows: document.querySelectorAll('.wl-table tbody tr').length,
      row_height_px: row ? Math.round(row.getBoundingClientRect().height * 10) / 10 : null,
      name_font_px: cs ? parseFloat(cs.fontSize) : null,
      name_weight: cs ? Number(cs.fontWeight) : null,
      columns: [...document.querySelectorAll('.wl-table thead th')].filter((th) => th.getBoundingClientRect().width > 0).length,
      consensus_marks: marks,
    };
  })()`,
  // The strip's heads are each cell's label and figure; its notes (the lines
  // under a figure) are prose and may wrap.
  inspector: `(() => {
    const strip = document.querySelector('.inspector .iv-risk .iv-rgrid');
    if (!strip) return { strip: false };
    const cells = [...strip.querySelectorAll(':scope > .iv-rc')];
    const tops = new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top)));
    const lines = (el) => {
      const cs = getComputedStyle(el);
      const lh = cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.25 : parseFloat(cs.lineHeight);
      return Math.round(el.getBoundingClientRect().height / lh);
    };
    const wrappedHeads = cells.filter((c) => [...c.querySelectorAll('.iv-rc-k, .iv-rc-v')].some((el) => lines(el) > 1)).length;
    const wrappedNotes = cells.filter((c) => [...c.querySelectorAll('.iv-rc-s')].some((el) => lines(el) > 1)).length;
    const insp = document.querySelector('.inspector');
    return { strip: true, cells: cells.length, one_row: cells.length > 0 && tops.size === 1, wrapped_heads: wrappedHeads, wrapped_notes: wrappedNotes, inspector_width_px: insp ? Math.round(insp.getBoundingClientRect().width) : null };
  })()`,
  review: `(() => {
    const panes = ['.rv-left', '.rv-mid', '.rv-right'].map((s) => document.querySelector(s)).filter((el) => el && el.getBoundingClientRect().width > 0);
    const text = panes.map((el) => el.innerText || '').join('\\n');
    const found = text.match(new RegExp(${JSON.stringify(RAW_ID)}, 'g')) || [];
    return { panes: panes.length, raw_ids_visible: found.length, raw_id_samples: [...new Set(found)].slice(0, 5) };
  })()`,
  portfolio: `(() => {
    const badge = document.querySelector('a[data-key="nav-portfolio"] .nav-count');
    const n = badge ? Number(String(badge.textContent).trim()) : null;
    return { badge: Boolean(badge), needs_attention: badge ? (Number.isFinite(n) ? n : null) : 0, badge_title: badge ? badge.getAttribute('title') : null };
  })()`,
};

const SHOTS = [
  { name: 'desk', label: 'Desk', route: '#/watchlist', ready: "document.querySelector('.wl-table tbody tr')" },
  // The drawer's head stays in place while its body scrolls: the strip is
  // brought into view under it.
  { name: 'inspector', label: 'Inspector open', route: `#/watchlist?p=${relay}`, ready: "document.querySelector('.inspector .iv-rgrid .iv-rc')", before: "(() => { const b = document.querySelector('.inspector .insp-body'); const el = document.querySelector('.inspector .iv-risk'); if (b && el) b.scrollTop += el.getBoundingClientRect().top - b.getBoundingClientRect().top - 160; })()" },
  { name: 'review', label: 'Review, three panes', route: `#/review?p=${relay}`, ready: "document.querySelector('.rv-left .rv-queue') && document.querySelector('.rv-mid .rv-title') && document.querySelector('.rv-right')" },
  { name: 'portfolio', label: 'Portfolio', route: '#/portfolio', ready: "document.querySelector('a[data-key=\"nav-portfolio\"]') && document.querySelector('main') && document.querySelector('main').innerText.length > 40" },
];

const WAIT = `window.__wait = (test, ms = 8000) => new Promise((resolve) => { const t0 = performance.now(); (function f() { let v = null; try { v = test(); } catch (_) { v = null; } if (v) resolve(true); else if (performance.now() - t0 > ms) resolve(false); else requestAnimationFrame(f); })(); }); true`;

fs.mkdirSync(out, { recursive: true });
const proof = { schema_version: 'cr.visual-proof.v1', desk: 'fictional', theme: 'light', viewport: { width: W, height: H }, taken_at: new Date().toISOString(), shots: [] };
const b = await launch();
let failed = 0;
try {
  for (const s of SHOTS) {
    const tab = await b.openTab(base);
    await tab.size(W, { height: H });
    await tab.go(`${base}/${s.route}`, 300);
    await tab.evalJs(WAIT);
    const ready = await tab.evalJs(`__wait(() => ${s.ready})`);
    if (ready && s.before) await tab.evalJs(s.before);
    await sleep(700); // fonts, logos and the sparklines settle
    const measures = ready ? await tab.evalJs(MEASURE[s.name]) : null;
    await tab.shot(path.join(out, `${s.name}.png`));
    const entry = { name: s.name, label: s.label, route: s.route, file: `${s.name}.png`, ready: Boolean(ready), measures: measures && !measures.error ? measures : null, errors: [...tab.errors].slice(0, 10), writes: [...tab.writes].slice(0, 10) };
    // Raw record IDs on Review's screen fail the proof (L6, 2026-10-26).
    entry.clean = Boolean(entry.ready && entry.measures && !entry.errors.length && !entry.writes.length && !(entry.measures && entry.measures.raw_ids_visible));
    if (!entry.clean) failed++;
    proof.shots.push(entry);
    await tab.close();
  }
} finally {
  await b.kill();
  if (desk) {
    const gone = new Promise((r) => { desk.once('exit', r); setTimeout(r, 5000); });
    desk.disconnect();
    await gone;
    if (desk.exitCode === null) desk.kill();
  }
}
fs.writeFileSync(path.join(out, 'proof.json'), `${JSON.stringify(proof, null, 1)}\n`);
for (const s of proof.shots) console.log(`${s.clean ? 'ok  ' : 'FAIL'} ${s.name} ${JSON.stringify(s.measures)}${s.errors.length ? ` errors: ${s.errors.join(' | ')}` : ''}${s.writes.length ? ` writes: ${s.writes.join(', ')}` : ''}`);
console.log(`\n${proof.shots.length - failed} of ${proof.shots.length} views captured cleanly into ${out}.`);
process.exit(failed ? 1 : 0);
