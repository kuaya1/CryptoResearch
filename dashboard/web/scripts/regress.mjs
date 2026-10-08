// Regression checks for the React integration review of 2026-10-08
// (audits/2026-10-08-codex-react-review): the built app (or, with --dev, the
// Vite dev server) in headless Chrome, on a FICTIONAL offline desk behind a
// fault proxy (fault-proxy.mjs). Each section reproduces one finding and
// asserts on what is drawn: text, links and positions, not internal state.
//   F1 one report per displayed opinion, under delayed reads, refreshes and
//      20+ rapid project and model switches;
//   F2 startup: HTML 503, a session that never answers, an unreadable
//      session, a failed index, sign-in expiry on the online desk;
//   F3 a missing app chunk, a failed hosted part, a failed project read,
//      an unhandled asynchronous error;
//   F4 the chosen model and report kept from the Overview through Evidence,
//      the original report and Back (revisions, missing reports, Compare);
//   F5 the real phone entry (watchlist -> inspector -> Brief) at 360x780 and
//      390x844: the strongest-risk block above the tab bar;
//   F6 the project's section navigation and the model tabs by keyboard;
//   F7 the inspector: the risk, confirm and break right after the verdict.
//   node scripts/regress.mjs [--dev] [--only F1,F4] [--json <file>] [--shots <dir>]
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';
import { startFaultProxy, NEW_REPORT_ID, NEW_RISK } from './fault-proxy.mjs';
import { keyPoints } from '../../public/brief-model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const DEV = process.argv.includes('--dev');
const ONLY = arg('--only', '') ? arg('--only', '').split(',').map((s) => s.trim().toUpperCase()) : null;
const SHOTS = arg('--shots', null);
const want = (k) => !ONLY || ONLY.includes(k);

const results = [];
const evidence = {};
const record = (finding, name, pass, detail = null) => {
  results.push({ finding, name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${finding} ${name}${!pass && detail ? `: ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
};

// ---- the fictional desk, the proxy and (with --dev) Vite -------------------------------
const desk = fork(path.join(here, 'dev-desk.cjs'), ['--port', String(4700 + Math.floor(Math.random() * 80))], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const deskInfo = await new Promise((resolve, reject) => {
  desk.on('message', (m) => { if (m && m.ready) resolve(m); });
  desk.on('exit', (code) => reject(new Error(`the dev desk stopped (exit ${code})`)));
});
const s0 = await (await fetch(`${deskInfo.url}/api/session`)).json();
const H = { headers: { 'x-cr-token': s0.token } };
const index0 = await (await fetch(`${deskInfo.url}/api/index`, H)).json();
const pidOf = (re) => (index0.projects.find((p) => re.test(p.name)) || {}).project_id;
const P = { relay: pidOf(/Relay Network/), withheld: pidOf(/Ledger Credit/), ranges: pidOf(/Range Labs/), long: pidOf(/Extraordinarily Long/), halcyon: pidOf(/Halcyon/) };
const proxy = await startFaultProxy({ target: deskInfo.url, project: P.relay, provider: 'claude' });
let vite = null;
let base = proxy.url;
if (DEV) {
  process.env.CR_DEV_DESK = proxy.url;
  process.env.CR_DEV_PORT = String(5300 + Math.floor(Math.random() * 90));
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: path.join(here, '..', 'vite.config.js'), logLevel: 'error' });
  await vite.listen();
  base = `http://127.0.0.1:${vite.config.server.port}`;
}

// What each opinion looks like when drawn from one report: its project and
// model, grade, verdict and strongest risk (the desk's own keyPoints).
const fmtVerdict = (v) => (v ? `${v.charAt(0)}${v.slice(1).toLowerCase()}` : null);
const SIG = {};
const details = {};
for (const p of index0.projects) {
  const d = await (await fetch(`${deskInfo.url}/api/projects/${encodeURIComponent(p.project_id)}`, H)).json();
  details[p.project_id] = d;
  for (const prov of ['claude', 'chatgpt', 'gemini']) {
    const sum = p.providers && p.providers[prov];
    if (!sum) continue;
    const r = d.reports.find((x) => x.report_id === sum.report_id);
    const k = r && r.assessment ? keyPoints(r.assessment) : null;
    SIG[sum.report_id] = { project: p.project_id, provider: prov, grade: sum.grade && ['firm', 'range'].includes(sum.grade.status) ? sum.grade.display : null, verdict: fmtVerdict(sum.verdict), risk: k && k.risk ? k.risk.text : null };
  }
}
SIG[NEW_REPORT_ID] = { project: P.relay, provider: 'claude', grade: '90.4', verdict: 'Avoid', risk: NEW_RISK };
const relayD = details[P.relay];
const claudeReports = relayD.reports.filter((r) => r.meta && r.meta.provider === 'claude' && !r.broken);
const latestClaude = relayD.comparison.latest.claude.report_id;
const latestGpt = relayD.comparison.latest.chatgpt.report_id;
const olderClaude = (claudeReports.find((r) => r.report_id !== latestClaude && r.eligible !== false && (!r.revision || r.revision.kind !== 'revision')) || claudeReports.find((r) => r.report_id !== latestClaude) || {}).report_id;

// ---- page helpers -------------------------------------------------------------------------
const WAIT = 'window.__wait = (test, ms = 6000) => new Promise((resolve) => { const t0 = performance.now(); (function f() { let v = null; try { v = test(); } catch (_) { v = null; } if (v) resolve(Math.round(performance.now() - t0)); else if (performance.now() - t0 > ms) resolve(null); else requestAnimationFrame(f); })(); }); true';
// The mixed-report monitor: on every change to the page, the inspector's
// grade, verdict and strongest risk must belong to the report its "Open
// report" link names, and that report to the project and model on screen.
const MONITOR = (sig) => `(() => {
  if (window.__mix) return true;
  const SIG = ${JSON.stringify(sig)};
  window.__mix = { checks: 0, violations: [], seen: {} };
  const txt = (el) => (el ? el.textContent.trim() : null);
  const check = () => {
    const insp = document.querySelector('.inspector');
    if (!insp) return;
    const pid = new URLSearchParams(location.hash.split('?')[1] || '').get('p');
    const tab = insp.querySelector('[data-key^="insp-tab-"][aria-selected="true"]');
    const prov = tab ? tab.dataset.key.replace('insp-tab-', '') : null;
    const link = insp.querySelector('.insp-foot [data-key^="report-"]');
    const id = link ? new URLSearchParams((link.getAttribute('href') || '').split('?')[1] || '').get('report') : null;
    const gauge = insp.querySelector('.mpanel .gauge');
    const label = gauge ? gauge.getAttribute('aria-label') || '' : '';
    const verdict = txt(insp.querySelector('.mpanel .v-verdict'));
    const risk = txt(insp.querySelector('.mpanel [data-part="risk-text"]') || insp.querySelector('.mpanel .tl-risk-text'));
    window.__mix.checks += 1;
    const v = [];
    const s = id ? SIG[id] : null;
    if (id && !s) v.push('unknown report ' + id);
    if (!id && risk) v.push('a risk with no report');
    if (s) {
      if (s.project !== pid) v.push('report of ' + s.project + ' under ' + pid);
      if (prov && s.provider !== prov) v.push('report of ' + s.provider + ' under the ' + prov + ' tab');
      if (s.grade && label && label.indexOf('grade ' + s.grade + ' of') < 0) v.push('grade [' + label + '] is not ' + s.grade);
      if (verdict && s.verdict && verdict !== s.verdict) v.push('verdict ' + verdict + ' is not ' + s.verdict);
      if (risk && s.risk && risk !== s.risk) v.push('risk [' + risk.slice(0, 60) + '] is not [' + s.risk.slice(0, 60) + ']');
      if (risk && !s.risk) v.push('a risk the report does not give');
    }
    if (id) window.__mix.seen[id] = (window.__mix.seen[id] || 0) + 1;
    if (v.length) window.__mix.violations.push({ at: Math.round(performance.now()), pid, prov, id, label, verdict, risk: risk && risk.slice(0, 80), v });
  };
  new MutationObserver(() => queueMicrotask(check)).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  check();
  return true;
})()`;

const b = await launch();
const openTab = async (w, opts = {}) => {
  const tab = await b.openTab(base);
  await tab.size(w, opts);
  if (opts.theme) await tab.theme(base, opts.theme);
  tab.navs = 0;
  return tab;
};
const go = async (tab, url, ready, ms = 8000) => {
  await tab.go(`${base}/${url}`, 200);
  await tab.evalJs(WAIT);
  return tab.evalJs(`__wait(() => ${ready}, ${ms})`);
};
const waitFor = async (tab, cond, ms = 6000) => {
  await tab.evalJs(WAIT);
  return tab.evalJs(`__wait(() => ${cond}, ${ms})`);
};
const text = (tab, sel) => tab.evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.textContent.trim() : null; })()`);
const hashQ = (tab, k) => tab.evalJs(`new URLSearchParams(location.hash.split('?')[1] || '').get(${JSON.stringify(k)})`);

try {
  // ---------------------------------------------------------------------------------------
  if (want('F1')) {
    proxy.reset();
    // F1a: the review's case. A loaded opinion, then the index names another
    // report while its record takes 15 s to arrive.
    {
      const tab = await openTab(1440);
      await go(tab, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector .mpanel')");
      await tab.evalJs(MONITOR(SIG));
      await waitFor(tab, "document.querySelector('.mpanel [data-part=\"risk-text\"], .mpanel .tl-risk-text')", 8000);
      proxy.set({ projectDelay: 15000, snapshot: 'new', bump: proxy.cfg.bump + 1 });
      const t0 = Date.now();
      // The index changes within a poll (2.5 s); the record is held 15 s.
      await waitFor(tab, `document.querySelector('.insp-foot [data-key^="report-"]') && document.querySelector('.insp-foot [data-key^="report-"]').getAttribute('href').includes(${JSON.stringify(NEW_REPORT_ID)})`, 9000);
      const during = await tab.evalJs("({ link: (document.querySelector('.insp-foot [data-key^=\"report-\"]') || {}).href || null, gauge: (document.querySelector('.mpanel .gauge') || { getAttribute: () => null }).getAttribute('aria-label'), risk: (document.querySelector('.mpanel [data-part=\"risk-text\"], .mpanel .tl-risk-text') || {}).textContent || null, loading: Boolean(document.querySelector('.mpanel [role=\"status\"]')) })");
      evidence.f1_during_delay = during;
      await sleep(Math.max(0, 16500 - (Date.now() - t0)));
      proxy.set({ projectDelay: 0 });
      await waitFor(tab, `(document.querySelector('.mpanel [data-part="risk-text"], .mpanel .tl-risk-text') || {}).textContent === ${JSON.stringify(NEW_RISK)}`, 8000);
      const mix = await tab.evalJs('window.__mix');
      evidence.f1_delayed = { checks: mix.checks, violations: mix.violations.slice(0, 5), count: mix.violations.length };
      record('F1', 'a 15 s delayed record never mixes two reports', mix.violations.length === 0 && mix.checks > 0, evidence.f1_delayed);
      const after = await tab.evalJs("({ link: (document.querySelector('.insp-foot [data-key^=\"report-\"]') || {}).getAttribute ? document.querySelector('.insp-foot [data-key^=\"report-\"]').getAttribute('href') : null, risk: (document.querySelector('.mpanel [data-part=\"risk-text\"], .mpanel .tl-risk-text') || {}).textContent || null })");
      record('F1', 'the new opinion arrives whole after the delay', after.link && after.link.includes(NEW_REPORT_ID) && after.risk === NEW_RISK, after);
      await tab.close();
    }
    // F1b: 24 rapid switches of project and model, with refreshes landing
    // while a record is still on its way.
    {
      proxy.reset();
      const tab = await openTab(1440);
      await go(tab, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector .mpanel')");
      await tab.evalJs(MONITOR(SIG));
      await sleep(800);
      proxy.set({ projectDelay: 1200 });
      const actions = [];
      let snap = 'original';
      const seq = ['tab:chatgpt', 'j', 'tab:claude', 'refresh', 'k', 'tab:gemini', 'tab:claude', 'j', 'refresh', 'k', 'tab:chatgpt', 'tab:claude', 'j', 'j', 'refresh', 'k', 'k', 'tab:chatgpt', 'refresh', 'tab:claude', 'j', 'k', 'tab:gemini', 'tab:claude', 'refresh', 'j', 'k'];
      for (const [i, a] of seq.entries()) {
        if (a.startsWith('tab:')) {
          try { await tab.click(`[data-key="insp-tab-${a.slice(4)}"]`); } catch (_) { /* that tab is not drawn for this project */ }
        } else if (a === 'refresh') {
          snap = snap === 'original' ? 'new' : 'original';
          proxy.set({ snapshot: snap, bump: proxy.cfg.bump + 1 });
        } else {
          await tab.key(a, { code: `Key${a.toUpperCase()}`, vk: a === 'j' ? 74 : 75 });
        }
        actions.push(a);
        await sleep(90 + ((i * 137) % 420));
      }
      proxy.set({ projectDelay: 0 });
      // Back to the relay project's Claude opinion in the same page, settled.
      await tab.evalJs(`location.hash = '#/watchlist?p=${P.relay}'; true`);
      await waitFor(tab, "document.querySelector('.inspector .mpanel')", 6000);
      await tab.click('[data-key="insp-tab-claude"]').catch(() => {});
      const trace = [];
      const t0 = Date.now();
      let settled = null;
      while (Date.now() - t0 < 30000) {
        const st = await tab.evalJs("(() => { const m = document.querySelector('.mpanel'); return { opinion: m && m.dataset.opinion, loading: [...document.querySelectorAll('.mpanel .part-loading')].map((x) => (x.textContent || '').trim()).join('|'), risk: Boolean(document.querySelector('.mpanel [data-part=\"risk-text\"]')) }; })()");
        trace.push({ ms: Date.now() - t0, ...st });
        if (st.risk && !st.loading) { settled = Date.now() - t0; break; }
        await sleep(250);
      }
      evidence.f1_settle_trace = trace.filter((x, i) => i === 0 || JSON.stringify({ ...x, ms: 0 }) !== JSON.stringify({ ...trace[i - 1], ms: 0 }));
      const mix = await tab.evalJs('window.__mix');
      evidence.f1_rapid = { actions: actions.length, checks: mix.checks, reports_seen: Object.keys(mix.seen).length, violations: mix.violations.slice(0, 5), count: mix.violations.length };
      record('F1', `${actions.filter((a) => a !== 'refresh').length} rapid switches and ${actions.filter((a) => a === 'refresh').length} refreshes never mix reports`, mix.violations.length === 0 && mix.checks > 20, evidence.f1_rapid);
      const final = await tab.evalJs("(() => { const m = document.querySelector('.mpanel'); return { hash: location.hash, opinion: m && m.dataset.opinion, report: m && m.dataset.report, wait: ((document.querySelector('.mp-wait') || {}).textContent || '').slice(0, 160), risk: ((document.querySelector('.mpanel [data-part=\"risk-text\"]') || {}).textContent || '').slice(0, 80), tab: (document.querySelector('[data-key^=\"insp-tab-\"][aria-selected=\"true\"]') || {}).dataset ? document.querySelector('[data-key^=\"insp-tab-\"][aria-selected=\"true\"]').dataset.key : null }; })()");
      evidence.f1_settled = final;
      record('F1', 'after the switches the opinion settles whole (not stuck loading)', settled !== null && settled <= 6000, { settled_ms: settled, final, trace: evidence.f1_settle_trace });
      await tab.close();
      proxy.reset();
    }
  }

  // ---------------------------------------------------------------------------------------
  if (want('F2')) {
    const bootCase = async (name, cfg, { within = 4000 } = {}) => {
      proxy.reset();
      proxy.set(cfg);
      const tab = await openTab(1440);
      const t0 = Date.now();
      await tab.go(`${base}/#/watchlist`, 100);
      await tab.evalJs(WAIT);
      const alert = await tab.evalJs(`__wait(() => { const a = document.querySelector('[role="alert"]'); return a && /\\S/.test(a.textContent) && a; }, ${within})`);
      const elapsed = Date.now() - t0;
      const info = await tab.evalJs("(() => { const a = document.querySelector('[role=\"alert\"]'); return a ? { text: a.textContent.trim().slice(0, 200), buttons: [...a.querySelectorAll('button, a')].map((x) => x.textContent.trim()) } : { text: document.body.innerText.slice(0, 120) }; })()");
      evidence[`f2_${name}`] = { elapsed, ...info };
      return { tab, alert: alert !== null, elapsed, info };
    };
    {
      const c = await bootCase('html503', { session: 'html' });
      record('F2', 'HTML 503 from the session: an error with Try again, not endless loading', c.alert && c.info.buttons.some((x) => /try again/i.test(x)), c.info);
      proxy.reset();
      await c.tab.evalJs("(() => { const bt = [...document.querySelectorAll('[role=\"alert\"] button')].find((x) => /try again/i.test(x.textContent)); if (bt) bt.click(); return Boolean(bt); })()");
      const rows = await waitFor(c.tab, "document.querySelector('.wl-table tbody tr, .wl-cards')", 8000);
      record('F2', 'Try again recovers once the desk answers', rows !== null);
      await c.tab.close();
    }
    {
      const c = await bootCase('hang', { session: 'hang' }, { within: 24000 });
      record('F2', 'a session that never answers ends within 20 s with Try again', c.alert && c.elapsed <= 21500 && c.info.buttons.some((x) => /try again/i.test(x)), { elapsed: c.elapsed, ...c.info });
      await c.tab.close();
    }
    {
      const c = await bootCase('badjson', { session: 'badjson' });
      record('F2', 'an unreadable session answer is an error, not a half-started desk', c.alert, c.info);
      await c.tab.close();
    }
    {
      const c = await bootCase('index503', { indexFail: true });
      record('F2', 'a failed workspace read at start offers Try again', c.alert && c.info.buttons.some((x) => /try again/i.test(x)), c.info);
      proxy.reset();
      await c.tab.evalJs("(() => { const bt = [...document.querySelectorAll('[role=\"alert\"] button')].find((x) => /try again/i.test(x.textContent)); if (bt) bt.click(); return Boolean(bt); })()");
      record('F2', 'and recovers', (await waitFor(c.tab, "document.querySelector('.wl-table tbody tr')", 8000)) !== null);
      await c.tab.close();
    }
    {
      proxy.reset();
      proxy.set({ session: 'expired' });
      const tab = await openTab(1440);
      await tab.go(`${base}/#/watchlist`, 2500);
      const where = await tab.evalJs('location.pathname');
      record('F2', 'an expired session goes to sign-in', where === '/login', { where });
      await tab.close();
    }
    if (!DEV) {
      // The online desk: signed out while it is open.
      proxy.reset();
      proxy.set({ session: 'hosted' });
      const tab = await openTab(1440);
      await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')");
      proxy.set({ signedOut: true });
      await sleep(6500);
      const where = await tab.evalJs('location.pathname');
      const shown = await tab.evalJs("Boolean(document.querySelector('.wl-table tbody tr'))");
      evidence.f2_signout = { where, protected_rows_visible: shown };
      record('F2', 'signed out on the online desk: protected data leaves the screen and sign-in opens', where === '/login' && !shown, evidence.f2_signout);
      await tab.close();
      proxy.reset();
    }
  }

  // ---------------------------------------------------------------------------------------
  if (want('F3')) {
    if (!DEV) {
      proxy.reset();
      // A retired project chunk (a deploy replaced it while the tab was open).
      proxy.set({ blockChunk: 'ProjectPage-' });
      const tab = await openTab(1440);
      // Not from the browser's cache: as a tab that never loaded the chunk.
      await tab.send('Network.setCacheDisabled', { cacheDisabled: true });
      await go(tab, '#/watchlist', "document.querySelector('.wl-table tbody tr')");
      await tab.evalJs('window.__marker = 1; true');
      await tab.evalJs(`location.hash = '#/project/${P.relay}/brief'; true`);
      await sleep(2500);
      const st = await tab.evalJs("(() => { const a = document.querySelector('main [role=\"alert\"]'); return { alert: a ? a.textContent.trim().slice(0, 200) : null, buttons: a ? [...a.querySelectorAll('button, a')].map((x) => x.textContent.trim()) : [], nav: Boolean(document.querySelector('.sidebar a[href=\"#/watchlist\"]')), marker: window.__marker === 1, root: document.getElementById('root').innerText.length }; })()");
      evidence.f3_chunk = st;
      record('F3', 'a missing project chunk shows a recoverable error, the desk around it intact', Boolean(st.alert) && st.nav && st.root > 0 && st.buttons.some((x) => /reload/i.test(x)), st);
      record('F3', 'no automatic reload', st.marker);
      proxy.set({ blockChunk: '' });
      await tab.evalJs("(() => { const bt = [...document.querySelectorAll('main [role=\"alert\"] button')].find((x) => /try again/i.test(x.textContent)); if (bt) bt.click(); return Boolean(bt); })()");
      const back = await waitFor(tab, "document.querySelector('.ov-verdict')", 8000);
      record('F3', 'Try again opens the project once the chunk is back', back !== null);
      await tab.evalJs("location.hash = '#/watchlist'; true");
      record('F3', 'navigation stays usable', (await waitFor(tab, "document.querySelector('.wl-table tbody tr')", 5000)) !== null);
      await tab.close();
      // A hosted page's chunk missing (Portfolio after a deploy).
      proxy.set({ blockChunk: 'portfolio-' });
      const t3 = await openTab(1440);
      await t3.send('Network.setCacheDisabled', { cacheDisabled: true });
      await go(t3, '#/watchlist', "document.querySelector('.wl-table tbody tr')");
      await t3.evalJs("location.hash = '#/portfolio'; true");
      await sleep(2000);
      const pf = await t3.evalJs("(() => { const a = document.querySelector('main [role=\"alert\"]'); return { alert: a ? a.textContent.trim().slice(0, 200) : null, buttons: a ? [...a.querySelectorAll('button')].map((x) => x.textContent.trim()) : [], nav: Boolean(document.querySelector('.sidebar a[href=\"#/watchlist\"]')) }; })()");
      evidence.f3_hosted_page = pf;
      record('F3', 'a missing hosted-page chunk says so with Try again and Reload', Boolean(pf.alert) && pf.nav && pf.buttons.some((x) => /try again/i.test(x)) && pf.buttons.some((x) => /reload/i.test(x)), pf);
      proxy.set({ blockChunk: '' });
      await t3.evalJs("(() => { const bt = [...document.querySelectorAll('main [role=\"alert\"] button')].find((x) => /try again/i.test(x.textContent)); if (bt) bt.click(); return Boolean(bt); })()");
      record('F3', 'and Try again opens it once the chunk is back', (await waitFor(t3, "document.querySelector('.lg-portfolio .page-head')", 8000)) !== null);
      await t3.close();
      // The hosted parts' chunk missing: the inspector still opens.
      proxy.set({ blockChunk: 'parts-' });
      const t2 = await openTab(1440);
      await t2.send('Network.setCacheDisabled', { cacheDisabled: true });
      await go(t2, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector .mpanel')");
      await sleep(1500);
      const parts = await t2.evalJs("({ verdict: Boolean(document.querySelector('.inspector .vgauge, .inspector .vblock')), partError: [...document.querySelectorAll('.inspector .lg-part-error')].length, rows: Boolean(document.querySelector('.wl-table tbody tr')) })");
      evidence.f3_parts = parts;
      record('F3', 'a missing hosted-parts chunk leaves the inspector and list working, with a retry', parts.verdict && parts.rows && parts.partError > 0, parts);
      await t2.close();
      proxy.reset();
    }
    // A failed project read: an error with Try again, then the project.
    {
      proxy.reset();
      proxy.set({ projectFail: true });
      const tab = await openTab(1440);
      await go(tab, `#/project/${P.relay}/brief`, "document.querySelector('.pp')");
      await sleep(1500);
      const st = await tab.evalJs("(() => { const n = document.querySelector('.pp .note-bad, .pp [role=\"alert\"]'); return { text: n ? n.textContent.trim().slice(0, 160) : null, retry: Boolean(n && [...(n.closest('.pp') || document).querySelectorAll('button')].some((x) => /try again/i.test(x.textContent))) }; })()");
      record('F3', 'a failed project read says so and offers Try again', Boolean(st.text) && st.retry, st);
      proxy.reset();
      await tab.evalJs("(() => { const bt = [...document.querySelectorAll('.pp button')].find((x) => /try again/i.test(x.textContent)); if (bt) bt.click(); return Boolean(bt); })()");
      record('F3', 'and recovers', (await waitFor(tab, "document.querySelector('.ov-verdict')", 8000)) !== null);
      // An asynchronous failure nobody handled: said, not silent.
      await tab.evalJs("setTimeout(() => Promise.reject(new Error('FICTIONAL asynchronous failure')), 0); true");
      const said = await waitFor(tab, "/FICTIONAL asynchronous failure/.test((document.getElementById('toast') || {}).textContent || '')", 3000);
      record('F3', 'an unhandled asynchronous error is said, the page keeps working', said !== null);
      await tab.close();
    }
  }

  // ---------------------------------------------------------------------------------------
  if (want('F4')) {
    proxy.reset();
    const tab = await openTab(1440);
    const sectionLink = (t) => `[data-key="tab-${t}"]`;
    const originalHref = "(() => { const a = [...document.querySelectorAll('.pp-panel a')].find((x) => /original report/i.test(x.textContent)); return a ? a.getAttribute('href') : null; })()";
    // Overview, ChatGPT chosen.
    await go(tab, `#/project/${P.relay}/brief`, "document.querySelector('.ov-verdict')");
    await tab.click('[data-key="pb-tab-chatgpt"]');
    await waitFor(tab, "location.hash.includes('model=chatgpt') && document.querySelector('.ov-verdict')");
    await tab.click(sectionLink('evidence'));
    await waitFor(tab, "location.hash.includes('/evidence')", 5000);
    await waitFor(tab, `${originalHref}`, 6000);
    const ev = { url: await tab.evalJs('location.hash'), selected: await tab.evalJs("(document.querySelector('[role=\"tab\"][aria-selected=\"true\"][data-key^=\"pb-tab-\"]') || {}).dataset ? document.querySelector('[role=\"tab\"][aria-selected=\"true\"][data-key^=\"pb-tab-\"]').dataset.key : null"), original: await tab.evalJs(originalHref) };
    evidence.f4_evidence = ev;
    record('F4', 'Overview (ChatGPT) -> Evidence keeps ChatGPT', /model=chatgpt/.test(ev.url) && ev.selected === 'pb-tab-chatgpt' && ev.original && ev.original.includes(latestGpt), ev);
    // The original report, then Back twice.
    await tab.evalJs("(() => { const a = [...document.querySelectorAll('.pp-panel a')].find((x) => /original report/i.test(x.textContent)); if (a) a.click(); return Boolean(a); })()");
    await waitFor(tab, "location.hash.includes('/report')", 5000);
    await waitFor(tab, "document.getElementById('report-title')", 6000);
    const rep = { url: await tab.evalJs('location.hash'), title: await text(tab, '#report-title') };
    record('F4', 'the original report is ChatGPT\'s', rep.url.includes(encodeURIComponent(latestGpt)) && /^ChatGPT report/.test(rep.title || ''), rep);
    await tab.evalJs('history.back(); true');
    await waitFor(tab, `location.hash.includes('/evidence') && ${originalHref}`, 6000);
    const back1 = { url: await tab.evalJs('location.hash'), original: await tab.evalJs(originalHref) };
    record('F4', 'Back returns to ChatGPT\'s evidence', /model=chatgpt/.test(back1.url) && back1.original && back1.original.includes(latestGpt), back1);
    await tab.evalJs('history.back(); true');
    await waitFor(tab, "location.hash.includes('/brief') && document.querySelector('.ov-verdict')", 6000);
    const back2 = { url: await tab.evalJs('location.hash'), tab: await tab.evalJs("(document.querySelector('[data-key^=\"pb-tab-\"][aria-selected=\"true\"]') || {}).dataset.key") };
    record('F4', 'Back again returns to the ChatGPT Overview', /model=chatgpt/.test(back2.url) && back2.tab === 'pb-tab-chatgpt', back2);
    // An earlier report chosen explicitly stays chosen across the tabs.
    if (olderClaude) {
      await go(tab, `#/project/${P.relay}/brief?model=claude&report=${encodeURIComponent(olderClaude)}`, "document.querySelector('.ov-verdict')");
      await tab.click(sectionLink('evidence'));
      await waitFor(tab, `location.hash.includes('/evidence') && ${originalHref}`, 6000);
      const e2 = { url: await tab.evalJs('location.hash'), original: await tab.evalJs(originalHref) };
      record('F4', 'an earlier report chosen in the Overview stays chosen in Evidence', e2.url.includes(encodeURIComponent(olderClaude)) && e2.original && e2.original.includes(olderClaude), e2);
      await tab.click(sectionLink('report'));
      await waitFor(tab, "document.getElementById('report-title')", 6000);
      const r2 = { url: await tab.evalJs('location.hash'), current: await tab.evalJs("(document.querySelector('.report-list a[aria-current=\"true\"]') || {}).getAttribute ? document.querySelector('.report-list a[aria-current=\"true\"]').getAttribute('href') : null") };
      record('F4', 'and in Full report', (r2.current || '').includes(olderClaude), r2);
      await tab.click(sectionLink('brief'));
      await waitFor(tab, "location.hash.includes('/brief') && document.querySelector('.ov-verdict')", 6000);
      const o2 = { url: await tab.evalJs('location.hash') };
      record('F4', 'and back on the Overview, not replaced by the latest', o2.url.includes(encodeURIComponent(olderClaude)), o2);
    }
    // The latest report is not pinned by visiting Full report.
    await go(tab, `#/project/${P.relay}/brief?model=claude`, "document.querySelector('.ov-verdict')");
    await tab.click(sectionLink('report'));
    await waitFor(tab, "document.getElementById('report-title')", 6000);
    const r3 = { url: await tab.evalJs('location.hash'), current: await tab.evalJs("(document.querySelector('.report-list a[aria-current=\"true\"]') || {}).getAttribute ? document.querySelector('.report-list a[aria-current=\"true\"]').getAttribute('href') : null") };
    record('F4', 'Full report from Claude\'s latest opens that report', (r3.current || '').includes(latestClaude), r3);
    await tab.click(sectionLink('brief'));
    await waitFor(tab, "location.hash.includes('/brief') && document.querySelector('.ov-verdict')", 6000);
    const o3 = await tab.evalJs('location.hash');
    record('F4', 'back on the Overview it is still the latest, not pinned', /model=claude/.test(o3) && !/report=/.test(o3), { url: o3 });
    // A model with no report stays that model.
    await go(tab, `#/project/${P.relay}/brief?model=gemini`, "document.querySelector('.pp-panel')");
    await tab.click(sectionLink('evidence'));
    await waitFor(tab, "location.hash.includes('/evidence')", 5000);
    await sleep(800);
    const g = { url: await tab.evalJs('location.hash'), tab: await tab.evalJs("(document.querySelector('[data-key^=\"pb-tab-\"][aria-selected=\"true\"]') || {}).dataset.key"), claudeShown: await tab.evalJs("/Claude's evidence/.test(document.querySelector('.pp-panel').textContent)") };
    record('F4', 'a model without a report stays chosen and shows no other model\'s report', /model=gemini/.test(g.url) && g.tab === 'pb-tab-gemini' && !g.claudeShown, g);
    // Compare keeps the opinion for the way back.
    await go(tab, `#/project/${P.relay}/brief?model=chatgpt`, "document.querySelector('.ov-verdict')");
    await tab.click(sectionLink('compare'));
    await waitFor(tab, "location.hash.includes('/compare')", 5000);
    await sleep(600);
    await tab.click(sectionLink('brief'));
    await waitFor(tab, "location.hash.includes('/brief') && document.querySelector('.ov-verdict')", 6000);
    const c = { url: await tab.evalJs('location.hash'), tab: await tab.evalJs("(document.querySelector('[data-key^=\"pb-tab-\"][aria-selected=\"true\"]') || {}).dataset.key") };
    record('F4', 'Overview -> Compare -> Overview keeps ChatGPT', /model=chatgpt/.test(c.url) && c.tab === 'pb-tab-chatgpt', c);
    await tab.close();
  }

  // ---------------------------------------------------------------------------------------
  if (want('F6')) {
    proxy.reset();
    const tab = await openTab(1440);
    await go(tab, `#/project/${P.relay}/brief`, "document.querySelector('.ov-verdict')");
    const kind = await tab.evalJs("(() => { const n = document.querySelector('[aria-label=\"Project sections\"]'); return n ? { tag: n.tagName, role: n.getAttribute('role'), tabs: n.querySelectorAll('[role=\"tab\"]').length, links: n.querySelectorAll('a[href]').length, current: (n.querySelector('[aria-current=\"page\"]') || {}).textContent || null } : null; })()");
    evidence.f6_sections = kind;
    if (kind && kind.role === 'tablist') {
      await tab.evalJs("document.querySelector('[data-key=\"tab-evidence\"]').focus(); true");
      await tab.key('ArrowRight', { vk: 39 });
      await sleep(250);
      const f = await tab.evalJs("(document.activeElement || {}).dataset ? document.activeElement.dataset.key : null");
      record('F6', 'section tabs: Right Arrow moves to the next section', f === 'tab-report', { focus: f, ...kind });
    } else {
      record('F6', 'sections are navigation links: a nav with aria-current, no tab roles', kind && kind.tag === 'NAV' && kind.tabs === 0 && kind.links >= 6 && /Overview/.test(kind.current || ''), kind);
      await tab.evalJs("document.querySelector('[data-key=\"tab-evidence\"]').focus(); true");
      await tab.key('Enter', { vk: 13 });
      const went = await waitFor(tab, "location.hash.includes('/evidence')", 4000);
      record('F6', 'Enter on a section link opens it', went !== null);
      await waitFor(tab, "/Evidence/.test((document.querySelector('[aria-label=\"Project sections\"] [aria-current=\"page\"]') || {}).textContent || '')", 4000);
      const cur = await tab.evalJs("(document.querySelector('[aria-label=\"Project sections\"] [aria-current=\"page\"]') || {}).textContent");
      record('F6', 'the current section is marked', /Evidence/.test(cur || ''), { cur });
    }
    // The model tabs are real tabs: arrows, Home and End move the choice and focus.
    await go(tab, `#/project/${P.relay}/brief?model=claude`, "document.querySelector('.ov-verdict')");
    await tab.evalJs("document.querySelector('[data-key=\"pb-tab-claude\"]').focus(); true");
    const step = async (key, vk) => {
      await tab.key(key, { vk });
      await sleep(350);
      return tab.evalJs("({ focus: (document.activeElement || {}).dataset ? document.activeElement.dataset.key : null, selected: (document.querySelector('[data-key^=\"pb-tab-\"][aria-selected=\"true\"]') || {}).dataset.key, url: location.hash })");
    };
    const r1 = await step('ArrowRight', 39);
    const r2 = await step('End', 35);
    const r3 = await step('Home', 36);
    const r4 = await step('ArrowLeft', 37);
    evidence.f6_model_tabs = [r1, r2, r3, r4];
    record('F6', 'model tabs: Right, End, Home, Left move choice and focus', r1.focus === 'pb-tab-chatgpt' && r1.selected === 'pb-tab-chatgpt' && r2.focus === 'pb-tab-gemini' && r3.focus === 'pb-tab-claude' && r4.focus === 'pb-tab-gemini' && /model=gemini/.test(r4.url), evidence.f6_model_tabs);
    // Escape closes a brief opened from the inspector and focus returns.
    await go(tab, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector .mpanel')");
    await tab.evalJs("(() => { const a = document.querySelector('[data-key^=\"brief-\"]'); if (a) a.click(); return Boolean(a); })()");
    await waitFor(tab, "document.querySelector('.ov-verdict')", 6000);
    await tab.click('[data-key="tab-evidence"]');
    await waitFor(tab, "location.hash.includes('/evidence')", 4000);
    await sleep(500);
    await tab.evalJs('document.activeElement && document.activeElement.blur(); true');
    await tab.key('Escape', { vk: 27 });
    const back = await waitFor(tab, "document.querySelector('.inspector') && !location.hash.includes('/project/')", 5000);
    record('F6', 'Escape from the brief (after moving to Evidence) returns to the inspector', back !== null);
    await tab.close();
  }

  // ---------------------------------------------------------------------------------------
  if (want('F7') || want('F5')) {
    proxy.reset();
    const riskSel = "document.querySelector('.inspector [data-part=\"keypoints\"]') || document.querySelector('.inspector .tl-risk')";
    for (const [w, h] of [[1440, 900], [390, 844]]) {
      if (!want('F7')) break;
      const tab = await openTab(w, { height: h });
      await go(tab, `#/watchlist?p=${P.relay}`, "document.querySelector('.inspector .mpanel')");
      await waitFor(tab, "document.querySelector('.inspector [data-part=\"risk-text\"], .inspector .tl-risk-text')", 8000);
      await sleep(400);
      const geo = await tab.evalJs(`(() => {
        const body = document.querySelector('.insp-body').getBoundingClientRect();
        const risk = ${riskSel};
        const r = risk.getBoundingClientRect();
        const before = (sel) => { const el = document.querySelector('.inspector ' + sel); return el ? Boolean(risk.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : null; };
        const ik = document.querySelector('.inspector .ik-risk');
        const brk = document.querySelector('.inspector .ik-break dt');
        return { bodyBottom: Math.round(body.bottom), riskTop: Math.round(r.top), riskBottom: Math.round(r.bottom), riskItemBottom: ik ? Math.round(ik.getBoundingClientRect().bottom) : null, breakTop: brk ? Math.round(brk.getBoundingClientRect().top) : null, beforeParts: before('.fold-parts'), beforeTake: before('.take'), beforeCats: before('.cats'), beforeItems: before('.insp-items'), beforeRev: before('.rev') };
      })()`);
      evidence[`f7_${w}`] = geo;
      const order = [geo.beforeParts, geo.beforeTake, geo.beforeCats, geo.beforeRev].every((x) => x !== false);
      record('F7', `${w}x${h}: the risk, confirm and break come right after the verdict`, order, geo);
      record('F7', `${w}x${h}: the strongest risk starts on the inspector's first screen`, geo.riskTop < geo.bodyBottom - 40, geo);
      if (w === 1440) record('F7', '1440x900: the strongest risk is whole and "Would confirm" and "Would break it" begin without scrolling', geo.riskItemBottom !== null && geo.riskItemBottom <= geo.bodyBottom && geo.breakTop !== null && geo.breakTop < geo.bodyBottom - 16, geo);
      if (SHOTS) await tab.shot(path.join(SHOTS, `inspector-${w}.png`));
      await tab.close();
    }
    if (want('F5')) {
      const cases = [['complete', P.relay], ['withheld', P.withheld], ['ranges', P.ranges], ['long-name', P.long]];
      evidence.f5 = {};
      for (const [w, h] of [[360, 780], [390, 844]]) {
        for (const [k, id] of cases) {
          const tab = await openTab(w, { height: h });
          await go(tab, '#/watchlist', "document.querySelector('.wl-cards [data-pid], .wl-table tbody tr')");
          // The real entry: the card's name opens the inspector, its Claude
          // Brief link opens the Overview.
          await tab.click(`[data-pid="${id}"] .pname`);
          await waitFor(tab, "document.querySelector('.inspector.is-modal [data-key^=\"brief-\"]')", 8000);
          await sleep(300);
          await tab.click(`.inspector [data-key="brief-${id}"]`);
          const ok = await waitFor(tab, "document.querySelector('.ov-verdict, .pp .empty-brief, .pp-panel')", 8000);
          await sleep(700);
          const m = await tab.evalJs(`(() => {
            const r = document.querySelector('.key-risk');
            const bar = document.querySelector('.tabbar');
            const back = document.querySelector('.backbar');
            const fold = bar ? bar.getBoundingClientRect().top : innerHeight;
            const v = document.querySelector('.ov-verdict');
            return { url: location.hash.split('?')[0], backbar: Boolean(back), verdictTop: v ? Math.round(v.getBoundingClientRect().top) : null, riskTop: r ? Math.round(r.getBoundingClientRect().top) : null, riskBottom: r ? Math.round(r.getBoundingClientRect().bottom) : null, fold: Math.round(fold), scrollW: document.documentElement.scrollWidth - innerWidth };
          })()`);
          evidence.f5[`${w}x${h} ${k}`] = m;
          record('F5', `${w}x${h} ${k}: through watchlist -> inspector -> Brief the whole strongest-risk block is above the tab bar`, ok !== null && m.backbar && m.riskBottom !== null && m.riskBottom <= m.fold && m.scrollW <= 1, m);
          if (SHOTS) await tab.shot(path.join(SHOTS, `phone-${w}-${k}.png`));
          await tab.close();
        }
      }
    }
  }
  // Nothing above may write or start research, except the one explicit
  // sign-in redirect; every request the desk saw is in the proxy's log.
  const writes = proxy.log.filter((e) => e.method !== 'GET' && e.method !== 'HEAD');
  const research = proxy.log.filter((e) => /\/research|\/retry|\/market\/refresh|\/reviewed/.test(e.path) && e.method !== 'GET');
  evidence.writes = writes.map((e) => `${e.method} ${e.path}`);
  record('ALL', 'no write, research start, refresh or review mark during any of these checks', writes.length === 0 && research.length === 0, evidence.writes);
} finally {
  await b.kill();
  await proxy.close();
  if (vite) await vite.close();
  const gone = new Promise((r) => { desk.once('exit', r); setTimeout(r, 5000); });
  desk.disconnect();
  await gone;
  if (desk.exitCode === null) desk.kill();
}

const failed = results.filter((r) => !r.pass);
const out = arg('--json', null);
if (out) fs.writeFileSync(out, JSON.stringify({ mode: DEV ? 'dev' : 'production', results, evidence }, null, 2));
console.log(`\n${results.length - failed.length} of ${results.length} regression checks passed (${DEV ? 'Vite dev server' : 'production build'}).`);
process.exit(failed.length ? 1 : 0);
