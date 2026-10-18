'use strict';
// The type floor (Eric, 2026-10-18, the typography, scale and polish pass):
// nothing a person can read is smaller than 12.5px, anywhere the desk draws,
// and the executive scale's sizes are the tokens the Desk, the rail, the
// inspector and Review read at. Static checks over the stylesheets and the
// React sources.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..');
const walk = (dir, keep) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'app' ? [] : walk(p, keep);
  return keep(p) ? [p] : [];
});
const css = () => [
  ...walk(path.join(DASH, 'public'), (p) => p.endsWith('.css')),
  ...walk(path.join(DASH, 'web', 'src'), (p) => p.endsWith('.css')),
].map((f) => [path.relative(DASH, f), fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]);
const FLOOR = 12.5;

test('type floor: the smallest token is 12.5px, and every size token is at or above it', () => {
  const tokens = fs.readFileSync(path.join(DASH, 'public', 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(tokens, /--fs-xs:\s*12\.5px;/);
  for (const m of tokens.matchAll(/--fs-[a-z0-9-]+:\s*([0-9.]+)px;/g)) assert.ok(Number(m[1]) >= FLOOR, `${m[0]} is under ${FLOOR}px`);
  // The executive scale (2026-10-18).
  for (const [k, v] of [['--fs-ui-sm', '13.5px'], ['--fs-body-lg', '14.5px'], ['--fs-ui', '15px'], ['--fs-head', '22px'], ['--fs-kpi', '26px'], ['--fs-kpi-lg', '28px'], ['--fs-page', '32px'], ['--sidebar-w', '232px'], ['--wl-row-h', '60px'], ['--inspector-w', '620px'], ['--inspector-w-wide', '680px'], ['--badge-h-lg', '26px']]) {
    assert.match(tokens, new RegExp(`${k}:\\s*${v.replace('.', '\\.')};`), `${k} is ${v}`);
  }
});

test('type floor: no stylesheet sets a font size under 12.5px, in pixels or relative units', () => {
  for (const [f, s] of css()) {
    for (const m of s.matchAll(/font-size:\s*([0-9.]+)(px|em|rem|%)/g)) {
      const n = Number(m[1]);
      const px = m[2] === 'px' ? n : m[2] === '%' ? (n / 100) * 16 : n * 16;
      assert.ok(m[2] === 'px' ? n >= FLOOR : n >= (m[2] === '%' ? 100 : 1) || px >= FLOOR, `${f}: ${m[0]}`);
    }
    for (const m of s.matchAll(/(^|[;{\s])font:\s*[^;{}]*?([0-9.]+)px/g)) assert.ok(Number(m[2]) >= FLOOR, `${f}: ${m[0].trim()}`);
  }
});

test('type floor: no React source draws text under 12.5px; monograms start at 13px', () => {
  for (const f of walk(path.join(DASH, 'web', 'src'), (p) => /\.(jsx?|mjs)$/.test(p))) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/fontSize:\s*([0-9.]+)\b/g)) assert.ok(Number(m[1]) >= FLOOR, `${path.relative(DASH, f)}: ${m[0]}`);
    for (const m of s.matchAll(/fontSize:\s*Math\.max\(([0-9.]+)/g)) assert.ok(Number(m[1]) >= 13, `${path.relative(DASH, f)}: ${m[0]}`);
  }
  assert.match(fs.readFileSync(path.join(DASH, 'public', 'ui.js'), 'utf8'), /fontSize: `\$\{Math\.max\(13, Math\.round\(size \* 0\.38\)\)\}px`/);
});

test('the Desk at the executive scale: 15px rows, 26px badges, balanced columns; the inspector\'s risk is a 2x2 grid', () => {
  const wl = fs.readFileSync(path.join(DASH, 'web', 'src', 'styles', 'watchlist.css'), 'utf8');
  assert.match(wl, /\.wl-table td \{\s*height: var\(--wl-row-h\); padding: 8px 16px;[\s\S]*?font-size: var\(--fs-ui\);/);
  assert.match(wl, /\.wl-table \.risk-badge, \.wl-table \.gcell-band, \.wl-table \.gcell-wh \{ height: var\(--badge-h-lg\); padding: 0 10px; border-radius: var\(--r-badge-lg\); font-size: var\(--fs-sm\);/);
  // Every default column has a share, so no one column takes the slack.
  for (const c of ['c-name', 'c-priceStack', 'c-spark', 'c-grade', 'c-risk', 'c-lastResearch', 'c-act']) assert.match(wl, new RegExp(`\\.wl-table \\.${c} \\{ width: \\d+%; \\}`), c);
  assert.doesNotMatch(wl, /\.c-(name|grade|spark)[^{]*\{[^}]*width: 1%/, 'no column shrinks to 1% and pushes the slack elsewhere');
  const insp = fs.readFileSync(path.join(DASH, 'web', 'src', 'styles', 'inspector.css'), 'utf8');
  assert.match(insp, /\.iv-rgrid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  const mp = fs.readFileSync(path.join(DASH, 'web', 'src', 'views', 'inspector', 'ModelPanel.jsx'), 'utf8');
  for (const part of ['forensic', 'downside', 'exit', 'pool']) assert.match(mp, new RegExp(`className="iv-rc" data-part="${part}"`), part);
});
