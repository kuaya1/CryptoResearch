'use strict';
// The browser app (dashboard/web, React and Vite; Eric, 2026-10-08): the
// committed bundle in public/app is built from the current sources; the page
// runs no inline script or style (the desk's Content-Security-Policy allows
// none); the hosted views' stylesheets are scoped so they never reach a React
// component; tokens.css is the one token layer; the server serves the app at
// / with immutable hashed assets; and the app writes only from explicit
// actions. Read from the files and a FICTIONAL test workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { tempWorkspace, addFixtureProject } = require('./helpers');

const DASH = path.join(__dirname, '..');
const WEB = path.join(DASH, 'web');
const APP = path.join(DASH, 'public', 'app');
const read = (...p) => fs.readFileSync(path.join(DASH, ...p), 'utf8');

function walk(dir, keep, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

test('the committed bundle is built from the current sources (run `npm run build` in dashboard/web after a change)', async () => {
  const { sourceHash, sourceFiles } = await import(pathToFileURL(path.join(WEB, 'scripts', 'source-hash.mjs')).href);
  const info = JSON.parse(fs.readFileSync(path.join(APP, 'build.json'), 'utf8'));
  assert.equal(info.schema_version, 'cr.web-build.v1');
  const files = sourceFiles(WEB);
  assert.ok(files.includes('web/src/main.jsx') && files.includes('public/watchlist-model.js') && files.includes('public/tokens.css'), 'the hash covers the app and the modules it bundles');
  assert.ok(!files.some((f) => f.startsWith('public/app/')), 'never the bundle itself');
  assert.equal(info.source_sha256, sourceHash(WEB), 'public/app is stale: run npm run build in dashboard/web');
  const assets = fs.readdirSync(path.join(APP, 'assets')).sort();
  assert.deepEqual(assets, info.files, 'exactly the files of that build');
});

test('the app page runs no inline script or style; the theme applies before the app; everything is under /app/assets', () => {
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'no inline script');
  assert.doesNotMatch(html, /<style|\sstyle="/, 'no inline style');
  assert.ok(html.indexOf('<script src="/theme.js">') > 0 && html.indexOf('<script src="/theme.js">') < html.indexOf('type="module"'), 'theme.js first');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (['/theme.js', '/favicon.svg', '#main'].includes(m[1])) continue;
    assert.match(m[1], /^\/app\/assets\/[\w.-]+\.(js|css)$/, `${m[1]} is a bundled asset`);
    assert.ok(fs.existsSync(path.join(APP, 'assets', path.basename(m[1]))), `${m[1]} exists`);
  }
  // No bundled script evaluates code from strings or writes a style element.
  for (const f of fs.readdirSync(path.join(APP, 'assets')).filter((x) => x.endsWith('.js'))) {
    const s = fs.readFileSync(path.join(APP, 'assets', f), 'utf8');
    assert.doesNotMatch(s, /\beval\(|new Function\(/, `${f}: code from strings`);
  }
});

test('the hosted views\' stylesheets are scoped under .lg: no rule of theirs can reach a React component', async () => {
  const { scopeSelector } = await import(pathToFileURL(path.join(WEB, 'scope-legacy.js')).href);
  assert.equal(scopeSelector('.card > h2'), '.lg .card > h2');
  assert.equal(scopeSelector('button'), '.lg button');
  assert.equal(scopeSelector(':root[data-theme="dark"] .logo'), ':root[data-theme="dark"] .lg .logo', 'the theme stays on the root');
  assert.equal(scopeSelector(':root'), null, 'tokens belong to tokens.css');
  assert.equal(scopeSelector('html'), null);
  assert.equal(scopeSelector('body'), '.lg', 'the page type applies to the scope itself');
  assert.equal(scopeSelector('body.split .layout'), null, 'the former page frame is gone');
  // In the built stylesheet of the hosted views, every selector is scoped.
  const css = fs.readdirSync(path.join(APP, 'assets')).filter((f) => /^views-.*\.css$/.test(f)).map((f) => fs.readFileSync(path.join(APP, 'assets', f), 'utf8')).join('\n');
  assert.ok(css.length > 50000, 'the hosted views\' stylesheet is built');
  const bridge = read('web', 'src', 'legacy', 'bridge.css');
  // A selector list, split at its top-level commas (never inside :is() or :not()).
  const split = (list) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of list) {
      if (ch === '(' || ch === '[') depth += 1;
      if (ch === ')' || ch === ']') depth -= 1;
      if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    out.push(cur.trim());
    return out.filter(Boolean);
  };
  const scoped = (sel) => /^\.lg\b/.test(sel) || /^:root(\[[^\]]*\]|:not\([^)]*\))*\s+\.lg\b/.test(sel) || /^\.pp-panel \.lg\b/.test(sel)
    // The minifier may merge scoped selectors into one :is(…).
    || (/^:is\(/.test(sel) && sel.endsWith(')') && split(sel.slice(4, -1)).every(scoped));
  const loose = [];
  for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[{}])\s*([^{}@]+)\{/g)) {
    for (const sel of split(m[1])) {
      if (/^(from|to|\d+(\.\d+)?%)$/.test(sel)) continue; // keyframe steps
      if (!scoped(sel)) loose.push(sel);
    }
  }
  assert.deepEqual(loose.slice(0, 5), [], 'every selector starts with .lg');
  assert.match(bridge, /\.lg-view \{/);
});

test('one token layer: tokens.css defines every token; no other stylesheet defines any', () => {
  const tokens = read('public', 'tokens.css');
  for (const t of ['--bg', '--surface', '--text', '--text-3', '--accent', '--pos', '--neg', '--warn', '--t1-fill', '--t5-ink', '--r-control', '--sans', '--figures']) {
    assert.match(tokens, new RegExp(`${t}:`), `${t} is a token`);
  }
  const sheets = [
    ...walk(path.join(DASH, 'public'), (p) => p.endsWith('.css') && !p.split(path.sep).includes('app') && !p.endsWith('tokens.css')),
    ...walk(path.join(WEB, 'src'), (p) => p.endsWith('.css')),
  ];
  for (const f of sheets) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(s, /(^|\})\s*:root(\[[^\]]*\])?\s*\{[^}]*--/m, `${path.relative(DASH, f)} defines tokens`);
  }
  // The React components draw colors from the tokens only.
  for (const f of walk(path.join(WEB, 'src', 'styles'), (p) => p.endsWith('.css'))) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(s, /#[0-9a-f]{3,8}\b/i, `${path.basename(f)}: a raw hex colour`);
  }
});

test('the app shows report text as text: no HTML from strings anywhere in the React sources', () => {
  for (const f of walk(path.join(WEB, 'src'), (p) => /\.(jsx?|mjs)$/.test(p))) {
    const s = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(s, /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML|insertAdjacentHTML|document\.write/, path.relative(DASH, f));
  }
});

test('the app writes only from explicit actions, and nothing from the boot or a live update', () => {
  const files = walk(path.join(WEB, 'src'), (p) => /\.(jsx?)$/.test(p)).map((f) => [path.relative(path.join(WEB, 'src'), f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]);
  const writers = files.filter(([, s]) => /api\.post\(/.test(s)).map(([f]) => f).sort();
  assert.deepEqual(writers, ['lib/desk.js', 'views/inspector/Inspector.jsx', 'views/inspector/ModelPanel.jsx', 'views/project/ProjectPage.jsx', 'views/watchlist/StatusStrip.jsx', 'views/watchlist/state.js']);
  // The desk client's own write is the saved view preferences, after a choice.
  const desk = files.find(([f]) => f === 'lib/desk.js')[1];
  assert.deepEqual([...desk.matchAll(/api\.post\('([^']+)'/g)].map((m) => m[1]), ['/api/ui-state']);
  assert.match(desk, /uiTimer = setTimeout\(\(\) => api\.post\('\/api\/ui-state', desk\.ui\)/);
  // Live updates read the version and the index only.
  const poll = desk.slice(desk.indexOf('async function pollVersion'), desk.indexOf('// The connection in words'));
  assert.doesNotMatch(poll, /api\.post|research|refresh\(\)/);
  // Every other write sits in a handler (onClick, onSelect) or an action function.
  for (const [f, s] of files.filter(([n]) => n !== 'lib/desk.js' && n !== 'views/watchlist/state.js')) {
    for (const m of s.matchAll(/api\.post\(/g)) {
      const before = s.slice(Math.max(0, m.index - 900), m.index);
      assert.match(before, /(onClick|onSelect)=\{async|const (mark|doRefresh) = async|async \(\) => \{/, `${f}: a write outside an action`);
    }
  }
  // Nothing starts research: the research dialog is the only way, and it opens on a click.
  for (const [f, s] of files) assert.doesNotMatch(s, /\/research\/run|start_research|\/api\/research'/, f);
});

test('the server serves the app at / with immutable hashed assets; the old shell is gone; no dev server in production', async (t) => {
  const { ws, cleanup } = tempWorkspace('webapp');
  t.after(cleanup);
  addFixtureProject(ws);
  const { start } = require('../server');
  const srv = await start(ws, { port: 49400 + Math.floor(Math.random() * 90), quiet: true });
  t.after(() => { try { srv.shutdown(); } catch (_) { /* stopped */ } });
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.match(root.headers['content-type'], /text\/html/);
  assert.equal(root.headers['cache-control'], 'no-cache');
  assert.match(root.headers['content-security-policy'], /script-src 'self';/);
  assert.match(root.headers['content-security-policy'], /style-src 'self';/);
  assert.equal(root.text, fs.readFileSync(path.join(APP, 'index.html'), 'utf8'));
  assert.equal((await get('/index.html')).text, root.text, 'a saved /index.html opens the app too');
  const js = root.text.match(/src="(\/app\/assets\/index-[\w-]+\.js)"/)[1];
  const asset = await get(js);
  assert.equal(asset.status, 200);
  assert.match(asset.headers['cache-control'], /max-age=31536000, immutable/);
  assert.equal((await get('/app.js')).status, 404, 'the former shell is retired');
  assert.equal((await get('/tokens.css')).status, 200);
  // The server needs no npm package: the dev server and the build tools stay in dashboard/web.
  for (const f of ['server.js', 'hosted.js', 'cli.js']) assert.doesNotMatch(read(f), /require\(['"](vite|react|@vitejs)/, f);
  const pkg = JSON.parse(fs.readFileSync(path.join(DASH, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'the server has no dependencies');
  assert.equal(pkg.scripts.start, 'node server.js', 'Render starts the same server');
});

test('watchlist rules shared by the React list: sort flips, filters count, sources say demo data', async (t) => {
  // The browser modules are ES modules in a CommonJS package: a temporary copy marked as ESM.
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-wl-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(path.join(DASH, 'public'), tmp, { recursive: true, filter: (src) => !src.split(path.sep).includes('app') });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{ "type": "module" }');
  const wl = await import(pathToFileURL(path.join(tmp, 'watchlist-model.js')).href);
  assert.deepEqual(wl.nextSort({ key: 'rank', dir: 'asc' }, 'rank'), { key: 'rank', dir: 'desc' }, 'the same key flips');
  assert.deepEqual(wl.nextSort({ key: 'rank', dir: 'asc' }, 'change7d'), { key: 'change7d', dir: 'desc' }, 'a figure starts highest first');
  assert.deepEqual(wl.nextSort({ key: 'rank', dir: 'desc' }, 'name'), { key: 'name', dir: 'asc' }, 'a name starts A to Z');
  assert.equal(wl.filterCount({ sector: '', coverage: 'any', ret30: 'any', archived: false }), 0);
  assert.equal(wl.filterCount({ sector: 'defi', coverage: 'all3', ret30: 'pos', archived: true }), 4);
  assert.equal(wl.sortDescription({ key: 'rank', dir: 'asc' }), 'Sorted by rank (CoinGecko), highest rank first');
  const demo = wl.sourcesOf({ projects: [{ market: { rank_source_label: 'FICTIONAL demo rank' } }] }, null);
  assert.equal(demo.rank, 'Demo data');
  assert.equal(demo.price, 'fictional demo data');
  assert.equal(wl.sourcesOf({ projects: [{ market: { rank_source_label: 'CoinGecko market-cap rank' } }] }, { workspace: { kind: 'real' } }).price, 'CoinGecko');
  assert.equal(wl.prefsToSave({ columns: ['rank'], sort: { key: 'rank', dir: 'asc' }, filters: {} }).v, wl.PREFS_VERSION);
});

test('no purple or indigo anywhere the desk draws: sources, the sign-in pages, the favicon and the built bundle (Eric, 2026-10-08)', () => {
  const files = [
    ...walk(path.join(DASH, 'public'), (p) => /\.(css|js|svg|html)$/.test(p)),
    ...walk(path.join(WEB, 'src'), (p) => /\.(css|jsx?)$/.test(p)),
    path.join(WEB, 'index.html'), path.join(DASH, 'hosted.js'), path.join(DASH, 'oauth.js'),
  ];
  const hsl = (r, g, b) => {
    const [R, G, B] = [r, g, b].map((v) => v / 255);
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    const d = max - min;
    if (!d) return { h: 0, s: 0, l };
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
    return { h: (h + 360) % 360, s, l };
  };
  const found = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const colors = [];
    for (const m of s.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z_-])/gi)) {
      const x = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
      colors.push([m[0], parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)]);
    }
    for (const m of s.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g)) colors.push([m[0], +m[1], +m[2], +m[3]]);
    for (const [text, r, g, b] of colors) {
      const c = hsl(r, g, b);
      // Indigo, violet and purple: a hue from 228 to 300 degrees with real
      // colour in it (slate greys, navy shadows and the Working blue stay out).
      if (c.h >= 228 && c.h <= 300 && c.s >= 0.25 && c.l > 0.08 && c.l < 0.97) found.push(`${path.relative(DASH, f)}: ${text}`);
    }
  }
  assert.deepEqual(found, [], 'purple or indigo colours');
});
