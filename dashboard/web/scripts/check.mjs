// npm run check: the built app, in headless Chrome, on a FICTIONAL offline
// desk (dev-desk.cjs) served by the real Node server. Run `npm run build`
// first. Checks what a unit test cannot see:
//   - opening every page writes nothing and logs no error;
//   - keyboard: / search, J/K, Space/Enter, Escape and focus return, R with
//     exactly one write and Undo, the drawer's focus, the More sheet;
//   - Back and deep links (?p=, ?open=), the list's place kept;
//   - on a phone (390×844, 360×780) the strongest sourced risk is whole on
//     the first screen for the complete, withheld and range cases;
//   - no sideways page scroll at 200% zoom (720 and 640 CSS px) or 320px;
//   - rendered text contrast in light and dark, no motion when reduced,
//     every control named;
//   - initial load, navigation timings and the bundle's size.
//   node scripts/check.mjs [--base http://127.0.0.1:4790] [--json <file>]
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..', '..', 'public', 'app');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

let desk = null;
let base = arg('--base', null);
if (!base) {
  desk = fork(path.join(here, 'dev-desk.cjs'), ['--port', String(4890 + Math.floor(Math.random() * 90))], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  base = (await new Promise((resolve, reject) => {
    desk.on('message', (m) => { if (m && m.ready) resolve(m); });
    desk.on('exit', (code) => reject(new Error(`the dev desk stopped (exit ${code})`)));
  })).url;
}

const failures = [];
const report = { base, timings: {}, bundle: {}, phone: {}, overflow: {}, contrast: {}, names: {}, keyboard: [], loads: {} };
const fail = (what, detail) => { failures.push(detail ? `${what}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : what); };
const ok = (cond, what, detail) => { if (!cond) fail(what, detail); report.keyboard.push(`${cond ? 'ok  ' : 'FAIL'} ${what}`); };

// ---- the bundle --------------------------------------------------------------
{
  const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  const first = [...html.matchAll(/(?:src|href)="\/app\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  const size = (f) => { const b = fs.readFileSync(path.join(APP, f)); return { raw: b.length, gzip: zlib.gzipSync(b, { level: 9 }).length }; };
  const all = fs.readdirSync(path.join(APP, 'assets')).filter((f) => /\.(js|css)$/.test(f)).map((f) => `assets/${f}`);
  const sum = (list) => list.map(size).reduce((a, s) => ({ raw: a.raw + s.raw, gzip: a.gzip + s.gzip }), { raw: 0, gzip: 0 });
  report.bundle = { initial: sum(first), total: sum(all), initial_files: first.length, files: all.length };
  if (report.bundle.initial.gzip > 260 * 1024) fail('initial bundle over 260 KB gzip', report.bundle.initial);
}

const session = await (await fetch(`${base}/api/session`)).json();
const index = await (await fetch(`${base}/api/index`, { headers: { 'x-cr-token': session.token } })).json();
const pid = (re) => (index.projects.find((p) => re.test(p.name)) || {}).project_id;
const P = { relay: pid(/Relay Network/), withheld: pid(/Ledger Credit/), ranges: pid(/Range Labs/), long: pid(/Extraordinarily Long/), none: pid(/Unresearched/) };

// Page-side helpers, installed on every check.
const WAIT = `window.__wait = (test, ms = 6000) => new Promise((resolve) => { const t0 = performance.now(); (function f() { let v = null; try { v = test(); } catch (_) { v = null; } if (v) resolve(performance.now()); else if (performance.now() - t0 > ms) resolve(null); else requestAnimationFrame(f); })(); }); true`;

const b = await launch();
const tabFor = async (w, opts = {}) => {
  const tab = await b.openTab(base);
  await tab.size(w, opts);
  if (opts.theme) await tab.theme(base, opts.theme);
  return tab;
};
const go = async (tab, url, ready, wait = 300) => {
  await tab.go(`${base}/${url}`, wait);
  await tab.evalJs(WAIT);
  return tab.evalJs(`__wait(() => ${ready})`);
};

try {
  // ---- initial load, cold then warm ----------------------------------------------
  {
    const tab = await tabFor(1440);
    const cold = await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')", 50);
    const warm = await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')", 50);
    const nav = await tab.evalJs("(() => { const n = performance.getEntriesByType('navigation')[0]; return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) }; })()");
    report.timings.watchlist_rows_cold_ms = cold && Math.round(cold);
    report.timings.watchlist_rows_warm_ms = warm && Math.round(warm);
    report.timings.navigation_warm = nav;
    if (!cold) fail('the watchlist never drew its rows');
    await tab.close();
  }

  // ---- every page: no write, no error, every control named --------------------------
  const PAGES = [
    ['watchlist', '#/watchlist', "document.querySelector('.wl-table tbody tr')"],
    ['inspector', `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector .ov-vlabel, .inspector .verdict, .inspector h2')"],
    ['overview', `#/project/${P.relay}/brief`, "document.querySelector('.ov-verdict')"],
    ['compare', `#/project/${P.relay}/compare`, "document.querySelector('.pp-panel .lg *')"],
    ['evidence', `#/project/${P.relay}/evidence`, "document.querySelector('.pp-panel .lg *')"],
    ['report', `#/project/${P.relay}/report`, "document.querySelector('.pp-panel .lg *')"],
    ['market', `#/project/${P.relay}/market`, "document.querySelector('.pp-panel .lg *')"],
    ['notes', `#/project/${P.relay}/notes`, "document.querySelector('.pp-panel .lg *')"],
    ['withheld', `#/project/${P.withheld}/brief`, "document.querySelector('.ov-verdict')"],
    ['none', `#/project/${P.none}/brief`, "document.querySelector('.pp')"],
    ['portfolio', '#/portfolio', "document.querySelector('.lg-portfolio .page-head')"],
    ['settings', '#/settings', "document.querySelector('.lg-settings .page-head')"],
    ['research', '#/research', "document.querySelector('.lg-research *')"],
    ['updates', '#/updates', "document.querySelector('.lg-updates *')"],
    ['explorer', '#/explorer', "document.querySelector('.lg-explorer *')"],
    ['new', '#/new', "document.querySelector('.lg-new *, .lg-intake *')"],
    ['forensics', `#/project/${P.relay}/forensics`, "document.querySelector('.fx-cps')"],
    ['forensics empty', `#/project/${P.none}/forensics`, "document.querySelector('.fx-empty')"],
  ];
  const FX_PAGES = PAGES.slice(-2);
  const NAMES = `(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden], [inert], [aria-hidden=true]')) continue;
      const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
      const by = (id) => (document.getElementById(id) || {}).textContent || '';
      const name = (el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map(by).join(' ') || (el.labels && [...el.labels].map((l) => l.textContent).join(' ')) || el.textContent || el.title || el.getAttribute('placeholder') || el.value || (el.querySelector('img[alt]') || {}).alt || '').trim();
      if (!name) out.push(el.outerHTML.slice(0, 140));
    }
    return out;
  })()`;
  {
    const tab = await tabFor(1440);
    for (const [name, url, ready] of PAGES) {
      const before = tab.writes.length;
      const errs = tab.errors.length;
      const t = await go(tab, url, ready);
      await sleep(700);
      const unnamed = await tab.evalJs(NAMES);
      report.loads[name] = { drawn_ms: t && Math.round(t), writes: tab.writes.slice(before), errors: tab.errors.slice(errs) };
      report.names[name] = unnamed.length;
      if (!t) fail(`${name} never drew`);
      if (tab.writes.length > before) fail(`${name} wrote on open`, tab.writes.slice(before));
      if (tab.errors.length > errs) fail(`${name} logged errors`, tab.errors.slice(errs));
      if (unnamed.length) fail(`${name}: controls without a name`, unnamed.slice(0, 3));
    }
    await tab.close();
  }

  // ---- keyboard and focus at 1440 (docked inspector) --------------------------------
  {
    const tab = await tabFor(1440);
    await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')");
    const active = () => tab.evalJs("(() => { const a = document.activeElement; return a ? (a.dataset.key || a.className || a.tagName) : null; })()");
    const hashP = () => tab.evalJs("new URLSearchParams(location.hash.split('?')[1] || '').get('p')");
    await tab.key('/', { code: 'Slash', vk: 191 });
    await sleep(150);
    ok(await tab.evalJs("document.activeElement && document.activeElement.type === 'search' || (document.activeElement && document.activeElement.closest('.search'))"), '/ focuses search');
    await tab.evalJs("document.activeElement.blur(); document.querySelector('.pname').focus(); true");
    const firstPid = await tab.evalJs("document.querySelector('.pname').closest('[data-pid]').dataset.pid");
    const t0 = await tab.evalJs('performance.now()');
    await tab.key('j', { code: 'KeyJ', vk: 74 });
    const t1 = await tab.evalJs(`__wait(() => document.querySelector('.inspector') && new URLSearchParams(location.hash.split('?')[1] || '').get('p'))`);
    report.timings.j_peek_ms = t1 && Math.round(t1 - t0);
    const second = await hashP();
    ok(second && second !== firstPid, 'J opens the next project beside the list');
    ok(String(await active()).startsWith('pname-'), 'J keeps focus on the list');
    await tab.key('Escape', { vk: 27 });
    await sleep(250);
    ok(!(await hashP()), 'Escape closes the inspector');
    ok((await active()) === `pname-${second}`, 'focus returns to the row');
    await tab.key('Enter', { vk: 13 });
    await sleep(250);
    ok((await hashP()) === second, 'Enter on a name peeks it');
    await tab.key('Enter', { vk: 13 });
    await sleep(250);
    ok(!(await hashP()), 'Enter again closes it');

    // R: one write, Undo puts it back.
    const target = (index.projects.find((p) => p.project_id === P.relay) || {}).project_id;
    await go(tab, `#/watchlist?p=${target}`, "document.querySelector('.inspector')");
    await sleep(400);
    const reviewable = await tab.evalJs("Boolean([...document.querySelectorAll('.inspector button')].find((x) => /Mark reviewed/.test(x.textContent)))");
    if (reviewable) {
      await tab.evalJs(`document.querySelector('[data-key="pname-${target}"]').focus(); true`);
      const w0 = tab.writes.length;
      await tab.key('r', { code: 'KeyR', vk: 82 });
      await sleep(900);
      const posted = tab.writes.slice(w0);
      ok(posted.length === 1 && /reviewed$/.test(posted[0]), 'R writes exactly one review mark', posted);
      const undo = await tab.evalJs("Boolean([...document.querySelectorAll('#toast button')].find((x) => /Undo/.test(x.textContent)))");
      ok(undo, 'R offers Undo');
      if (undo) {
        await tab.evalJs("[...document.querySelectorAll('#toast button')].find((x) => /Undo/.test(x.textContent)).click(); true");
        await sleep(900);
        const after = tab.writes.slice(w0);
        ok(after.length === 2 && /reviewed\/undo$/.test(after[1]), 'Undo writes exactly one undo', after);
      }
    } else {
      ok(false, 'the relay project has changes to review (fixture)');
    }

    // Open a project page from the inspector and come Back: the list keeps its place.
    await go(tab, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector')");
    await tab.evalJs('window.scrollTo(0, 320); true');
    await sleep(200);
    const y0 = await tab.evalJs('Math.round(scrollY)');
    const brief = await tab.evalJs("(() => { const a = [...document.querySelectorAll('.inspector a, .inspector button')].find((x) => /Claude Brief/.test(x.textContent)); if (!a) return false; window.__t = performance.now(); a.click(); return true; })()");
    ok(brief, 'the inspector links the Claude Brief');
    const tb = await tab.evalJs("__wait(() => document.querySelector('.ov-verdict'))");
    report.timings.inspector_to_overview_ms = tb && Math.round(tb - (await tab.evalJs('window.__t')));
    await tab.evalJs('window.__t = performance.now(); history.back(); true');
    const tback = await tab.evalJs("__wait(() => document.querySelector('.wl-table tbody tr') && document.querySelector('.inspector'))");
    report.timings.back_to_list_ms = tback && Math.round(tback - (await tab.evalJs('window.__t')));
    await sleep(300);
    ok(Boolean(tback), 'Back returns to the list with the inspector open');
    const y1 = await tab.evalJs('Math.round(scrollY)');
    ok(Math.abs(y1 - y0) <= 4, 'the list keeps its place', { before: y0, after: y1 });

    // A deep link to a fold opens it with focus on its heading.
    await go(tab, `#/project/${P.relay}/evidence?open=claims`, "document.querySelector('.pp-panel .lg *')");
    await sleep(900);
    ok(await tab.evalJs("(() => { const a = document.activeElement; const d = a && a.closest('details'); return Boolean(d && d.open); })()"), '?open=claims opens the fold with focus on it');
    await tab.close();
  }

  // ---- the drawer at 1024: focus in, Escape, focus back ------------------------------
  {
    const tab = await tabFor(1024, { height: 768 });
    await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')");
    const pidRow = await tab.evalJs("document.querySelector('.pname').closest('[data-pid]').dataset.pid");
    await tab.evalJs("document.querySelector('.pname').focus(); true");
    await tab.key('Enter', { vk: 13 });
    await tab.evalJs(WAIT);
    await tab.evalJs("__wait(() => document.querySelector('.inspector'))");
    await sleep(400);
    ok(await tab.evalJs("Boolean(document.activeElement && document.activeElement.closest('.inspector'))"), 'the drawer takes focus');
    await tab.key('Escape', { vk: 27 });
    await sleep(400);
    ok(await tab.evalJs(`document.activeElement && document.activeElement.dataset.key === 'pname-${pidRow}'`), 'closing the drawer returns focus to its row');
    await tab.close();
  }

  // ---- phone: the strongest sourced risk on the first screen; the More sheet ---------
  for (const [w, h] of [[390, 844], [360, 780]]) {
    const tab = await tabFor(w, { height: h });
    for (const [k, id] of [['complete', P.relay], ['withheld', P.withheld], ['ranges', P.ranges]]) {
      if (!id) { fail(`fixture ${k} missing`); continue; }
      await go(tab, `#/project/${id}/brief`, "document.querySelector('.ov-verdict')");
      await sleep(400);
      const m = await tab.evalJs("(() => { const r = document.querySelector('.key-risk'); const bar = document.querySelector('.tabbar'); if (!r) return null; const b = r.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), fold: Math.round(bar ? bar.getBoundingClientRect().top : innerHeight) }; })()");
      report.phone[`${w}x${h} ${k}`] = m;
      if (!m) fail(`${w}×${h} ${k}: no strongest-risk block`);
      else if (m.bottom > m.fold) fail(`${w}×${h} ${k}: the strongest risk ends below the first screen`, m);
    }
    if (w === 390) {
      await go(tab, '#/watchlist', "document.querySelector('.wl-cards, .wl-table')");
      const more = await tab.evalJs("(() => { const b = [...document.querySelectorAll('.tabbar button')].find((x) => /More/.test(x.textContent)); if (!b) return false; b.focus(); b.click(); return true; })()");
      await sleep(300);
      ok(more && (await tab.evalJs("Boolean(document.querySelector('dialog.msheet[open]'))")), 'More opens its sheet');
      await tab.key('Escape', { vk: 27 });
      await sleep(300);
      ok(await tab.evalJs("!document.querySelector('dialog.msheet[open]') && /More/.test((document.activeElement || {}).textContent || '')"), 'Escape closes the sheet and returns focus to More');
    }
    await tab.close();
  }

  // ---- no sideways page scroll: 200% zoom (720, 640) and 320 ------------------------
  for (const [w, mobile] of [[720, false], [640, false], [320, true]]) {
    const tab = await tabFor(w, { mobile, height: mobile ? 700 : 450, scale: 2 });
    for (const [name, url, ready] of [PAGES[0], PAGES[1], PAGES[2], PAGES[4], PAGES[10], PAGES[11]]) {
      await go(tab, url, ready);
      await sleep(500);
      const over = await tab.evalJs('document.documentElement.scrollWidth - innerWidth');
      report.overflow[`${w} ${name}`] = over;
      if (over > 1) fail(`${w}px ${name}: the page scrolls sideways by ${over}px`);
    }
    await tab.close();
  }

  // ---- reduced motion: nothing animates ----------------------------------------------
  {
    const tab = await tabFor(1440);
    await tab.media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await go(tab, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector')");
    await sleep(600);
    const running = await tab.evalJs("document.getAnimations().filter((a) => a.playState === 'running' && (a.effect && a.effect.getTiming().duration > 0)).map((a) => (a.effect.target && a.effect.target.className && String(a.effect.target.className)) || a.animationName || 'animation')");
    report.reduced_motion_running = running;
    if (running.length) fail('animations run with reduced motion', running.slice(0, 4));
    await tab.close();
  }

  // ---- rendered text contrast, light and dark -----------------------------------------
  const CONTRAST = `(() => {
    const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const bgOf = (el) => { const stack = []; for (let n = el; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null; const c = parse(cs.backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let c = { r: 255, g: 255, b: 255, a: 1 }; if (!stack.length || stack[stack.length - 1].a < 1) { const root = parse(getComputedStyle(document.body).backgroundColor); if (root) c = root; } for (let i = stack.length - 1; i >= 0; i--) c = over(stack[i], c); return c; };
    const seen = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent.trim()) continue;
      const el = t.parentElement; if (!el || el.closest('svg, [aria-hidden=true], [hidden], .sr-only, .visually-hidden, option, [disabled]')) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight * 3) continue;
      const fg = parse(cs.color); const bg = bgOf(el); if (!fg || !bg) continue;
      const c = over(fg, bg); const L1 = lum(c), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700; const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio + 0.005 < need) { const key = el.className + '|' + cs.color + '|' + cs.backgroundColor; if (!seen.has(key)) seen.set(key, { text: t.textContent.trim().slice(0, 40), cls: String(el.className).slice(0, 60), ratio: Math.round(ratio * 100) / 100, need }); }
    }
    return [...seen.values()];
  })()`;
  for (const theme of ['light', 'dark']) {
    const tab = await tabFor(1440, { theme });
    for (const [name, url, ready] of [PAGES[1], PAGES[2], PAGES[10], PAGES[11]]) {
      await go(tab, url, ready);
      await sleep(700);
      const low = await tab.evalJs(CONTRAST);
      report.contrast[`${theme} ${name}`] = low;
      if (low && low.length) fail(`${theme} ${name}: text below contrast`, low.slice(0, 4));
    }
    await tab.close();
    // A phone: the tab bar, the cards on the canvas, risky contract badges.
    const ph = await tabFor(390, { theme });
    const ember = (index.projects.find((p) => /Ember/.test(p.name)) || {}).project_id;
    for (const [name, url, ready] of [['phone watchlist', '#/watchlist', "document.querySelector('.wl-cards')"], ['phone inspector', `#/watchlist?p=${ember || P.relay}`, "document.querySelector('.inspector .mpanel')"], ['phone overview', `#/project/${P.relay}/brief`, "document.querySelector('.ov-verdict')"], ['phone portfolio', '#/portfolio', "document.querySelector('.lg-portfolio .page-head')"], ['phone new', '#/new', "document.querySelector('.lg-new *, .lg-intake *')"]]) {
      await go(ph, url, ready);
      await sleep(700);
      const low = await ph.evalJs(CONTRAST);
      report.contrast[`${theme} ${name}`] = low;
      if (low && low.length) fail(`${theme} ${name}: text below contrast`, low.slice(0, 4));
    }
    await ph.close();
  }

  // ---- Forensics: the entry flow, keyboard and focus, phones, contrast ----------------
  {
    // Watchlist -> inspector -> project page -> Forensics, by clicks.
    const tab = await tabFor(1440);
    await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')");
    const before = tab.writes.length;
    await tab.evalJs(`(() => { const n = document.querySelector('[data-key="pname-${P.relay}"]'); if (n) n.click(); return Boolean(n); })()`);
    const insp = await tab.evalJs(`__wait(() => /p=${P.relay}/.test(location.hash) && [...document.querySelectorAll('.inspector a, .inspector button')].some((x) => /Claude Brief/.test(x.textContent)), 8000)`);
    ok(Boolean(insp), 'forensics flow: the watchlist row opens the inspector');
    await tab.evalJs("(() => { const a = [...document.querySelectorAll('.inspector a, .inspector button')].find((x) => /Claude Brief/.test(x.textContent)); if (a) a.click(); return Boolean(a); })()");
    const page = await tab.evalJs("__wait(() => document.querySelector('.ov-verdict') && document.querySelector('[data-key=\"tab-forensics\"]'), 8000)");
    ok(Boolean(page), 'forensics flow: the inspector\'s Brief link opens the project page with a Forensics section');
    await tab.evalJs("(() => { const a = document.querySelector('[data-key=\"tab-forensics\"]'); if (a) a.click(); return Boolean(a); })()");
    const drawn = await tab.evalJs("__wait(() => document.querySelector('.fx-cps') && /forensics/.test(location.hash), 8000)");
    ok(Boolean(drawn), 'forensics flow: the project page\'s Forensics tab draws the timeline');
    ok(tab.writes.length === before, 'forensics flow: opening it wrote nothing', tab.writes.slice(before));
    // The order the brief sets: assessment, concern and counterevidence, states, timeline, conditions, details.
    const order = await tab.evalJs("[...document.querySelectorAll('.fx > *')].map((n) => n.className.split(' ').filter((c) => /^fx-(assess|keys|card|details|actions)$/.test(c)).join(' ') + ':' + ((n.querySelector('.fx-h') || {}).textContent || ''))");
    report.forensics_order = order;
    ok(/assess/.test(order[0] || '') && /keys/.test(order[1] || '') && /Current states/.test(order[2] || '') && /Resilience timeline/.test(order[3] || '') && /outlook/.test(order[4] || '') && /details/.test(order[5] || ''), 'forensics: sections in the brief\'s order', order);
    // Observed outcomes and conditional estimates are drawn apart; no percentage.
    const facts = await tab.evalJs("({ past: document.querySelectorAll('.fx-cp.is-past').length, cond: document.querySelectorAll('.fx-cp-cond li').length, label: /not a calibrated probability/.test(document.querySelector('.fx-legend').textContent), pct: /\\d+(\\.\\d+)?\\s?% (chance|probability)/i.test(document.querySelector('.fx').textContent), unknownZero: [...document.querySelectorAll('.fx-exit-cost')].some((n) => n.textContent.trim() === '0.00%') })");
    report.forensics_facts = facts;
    ok(facts.past >= 2 && facts.label && !facts.pct, 'forensics: past checkpoints drawn, conditional label shown, no probability', facts);
    // The monitor's aggregator exit quotes (FICTIONAL): dated estimates marked
    // monitor, the approved chain with its Remove; drawing them wrote nothing.
    const xq = await tab.evalJs("({ monitor: [...document.querySelectorAll('.fx-exit-basis')].filter((n) => / · monitor/.test(n.textContent)).length, dated: [...document.querySelectorAll('.fx-exit-basis')].some((n) => /\\d{4}|\\d:\\d\\d/.test(n.textContent)), target: (document.querySelector('.fx-quote-target') || {}).textContent || null, remove: Boolean(document.querySelector('[data-key^=\"fx-remove-xq_\"]')) })");
    report.forensics_exit_quotes = xq;
    ok(xq.monitor >= 2 && xq.dated && /Exit quotes on Ethereum/.test(xq.target || '') && xq.remove && tab.writes.length === before, 'forensics: the monitor\'s exit quotes are drawn, dated, with the approved chain and its Remove', xq);
    // Keyboard: the Sources fold opens from an evidence chip and focus lands on the source.
    await tab.evalJs("document.querySelector('.fx-src-cap').focus(); true");
    await tab.key('Enter', { vk: 13 });
    await sleep(500);
    const focused = await tab.evalJs("(document.activeElement && document.activeElement.id) || ''");
    ok(/^fx-src-/.test(focused) && await tab.evalJs("document.querySelector('[data-key=\"fx-sources\"]').open"), 'forensics: an evidence chip opens its captured source with focus', { focused });
    // The import dialog (a project with an audit open): Escape closes it and
    // focus returns to its button.
    const emberFx = (index.projects.find((p) => /Ember/.test(p.name)) || {}).project_id;
    await go(tab, `#/project/${emberFx}/forensics`, "document.querySelector('[data-key=\"fx-import\"]')");
    const hasImport = await tab.evalJs("Boolean(document.querySelector('[data-key=\"fx-import-chal\"], [data-key=\"fx-import\"]'))");
    ok(hasImport, 'forensics: an open audit offers Import');
    if (hasImport) {
      await tab.evalJs("(document.querySelector('[data-key=\"fx-import\"]') || document.querySelector('[data-key=\"fx-import-chal\"]')).focus(); true");
      await tab.key('Enter', { vk: 13 });
      await sleep(400);
      ok(await tab.evalJs("Boolean(document.querySelector('dialog.fx-dialog[open]'))"), 'forensics: Import opens its dialog');
      await tab.key('Escape', { vk: 27 });
      await sleep(400);
      ok(await tab.evalJs("!document.querySelector('dialog.fx-dialog[open]') && /fx-import/.test((document.activeElement || {}).dataset ? document.activeElement.dataset.key : '')"), 'forensics: Escape closes the dialog and focus returns to its button');
    }
    ok(tab.writes.length === before, 'forensics: reading, folding and closing wrote nothing', tab.writes.slice(before));
    await tab.close();
  }
  for (const [w, mobile] of [[720, false], [640, false], [390, true], [360, true], [320, true]]) {
    const tab = await tabFor(w, { mobile, height: mobile ? 780 : 450, scale: mobile ? 2 : 2 });
    for (const [name, url, ready] of FX_PAGES) {
      await go(tab, url, ready);
      await sleep(500);
      const over = await tab.evalJs('document.documentElement.scrollWidth - innerWidth');
      report.overflow[`${w} ${name}`] = over;
      if (over > 1) fail(`${w}px ${name}: the page scrolls sideways by ${over}px`);
    }
    if (mobile) {
      const stacked = await tab.evalJs("(() => { const cps = [...document.querySelectorAll('.fx-cp')]; if (cps.length < 2) return null; const a = cps[0].getBoundingClientRect(), b = cps[1].getBoundingClientRect(); return b.top >= a.bottom - 1; })()");
      if (stacked === false) fail(`${w}px forensics: the checkpoint cards do not stack`);
    }
    await tab.close();
  }
  for (const theme of ['light', 'dark']) {
    for (const w of [1440, 390]) {
      const tab = await tabFor(w, { theme });
      for (const [name, url, ready] of FX_PAGES) {
        await go(tab, url, ready);
        await tab.evalJs("document.querySelectorAll('.fx details').forEach((d) => { d.open = true; }); true");
        await sleep(600);
        const low = await tab.evalJs(CONTRAST.replace('r.top > innerHeight * 3', 'r.top > innerHeight * 40'));
        report.contrast[`${theme} ${w} ${name}`] = low;
        if (low && low.length) fail(`${theme} ${w}px ${name}: text below contrast`, low.slice(0, 4));
      }
      await tab.close();
    }
  }
  {
    const tab = await tabFor(1440);
    await tab.media([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await go(tab, FX_PAGES[0][1], FX_PAGES[0][2]);
    await sleep(600);
    const running = await tab.evalJs("document.getAnimations().filter((a) => a.playState === 'running' && (a.effect && a.effect.getTiming().duration > 0)).length");
    if (running) fail('forensics: animations run with reduced motion', running);
    await tab.close();
  }
} finally {
  await b.kill();
  // Disconnecting lets the desk delete its fictional workspace and exit.
  if (desk) {
    const gone = new Promise((r) => { desk.once('exit', r); setTimeout(r, 5000); });
    desk.disconnect();
    await gone;
    if (desk.exitCode === null) desk.kill();
  }
}

const out = arg('--json', null);
if (out) fs.writeFileSync(out, JSON.stringify({ ...report, failures }, null, 2));
console.log(report.keyboard.join('\n'));
console.log(JSON.stringify({ bundle: report.bundle, timings: report.timings, phone: report.phone }, null, 1));
if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll browser checks passed.');
process.exit(0);
