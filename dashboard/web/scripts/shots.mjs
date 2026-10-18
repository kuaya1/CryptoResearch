// Screenshots of the app on the FICTIONAL dev desk at desk, tablet and phone
// sizes, light and dark, for design review.
//   node scripts/shots.mjs --base http://127.0.0.1:5173 --out <dir> [--only name,name]
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg('--base', 'http://127.0.0.1:5173');
const out = arg('--out', path.resolve('shots'));
const only = arg('--only', '') ? arg('--only', '').split(',') : null;

const session = await (await fetch(`${base}/api/session`)).json();
const index = await (await fetch(`${base}/api/index`, { headers: { 'x-cr-token': session.token } })).json();
const pid = (re) => (index.projects.find((p) => re.test(p.name)) || {}).project_id;
const P = {
  relay: pid(/Relay Network/), halcyon: pid(/Halcyon/), withheld: pid(/Ledger Credit/), ranges: pid(/Range Labs/), long: pid(/Extraordinarily Long/),
  waiting: pid(/Waiting Protocol/), none: pid(/Unresearched/), ember: pid(/Ember/), lumen: pid(/Lumen/), tidepool: pid(/Tidepool/),
};

const SHOTS = [
  { name: 'wl-1440', w: 1440, url: '#/watchlist' },
  { name: 'wl-1440-insp', w: 1440, url: `#/watchlist?p=${P.relay}` },
  { name: 'wl-1440-insp-withheld', w: 1440, url: `#/watchlist?p=${P.withheld}` },
  { name: 'wl-1440-insp-ranges', w: 1440, url: `#/watchlist?p=${P.ranges}` },
  { name: 'wl-1440-insp-full', w: 1440, url: `#/watchlist?p=${P.relay}`, insp: true },
  { name: 'wl-1280-insp', w: 1280, url: `#/watchlist?p=${P.halcyon}` },
  { name: 'wl-1024', w: 1024, h: 768, url: '#/watchlist' },
  { name: 'wl-1024-drawer', w: 1024, h: 768, url: `#/watchlist?p=${P.lumen}` },
  { name: 'wl-768', w: 768, h: 1024, url: '#/watchlist' },
  { name: 'wl-390', w: 390, url: '#/watchlist' },
  { name: 'wl-390-full', w: 390, url: '#/watchlist', full: true },
  { name: 'wl-360', w: 360, h: 780, url: '#/watchlist' },
  { name: 'insp-390', w: 390, url: `#/watchlist?p=${P.relay}` },
  { name: 'insp-390-long', w: 390, url: `#/watchlist?p=${P.long}` },
  { name: 'insp-390-withheld', w: 390, url: `#/watchlist?p=${P.withheld}` },
  { name: 'wl-1440-dark', w: 1440, url: `#/watchlist?p=${P.relay}`, theme: 'dark' },
  { name: 'wl-390-dark', w: 390, url: '#/watchlist', theme: 'dark' },
  { name: 'project-1440', w: 1440, url: `#/project/${P.relay}/brief` },
  { name: 'project-390', w: 390, url: `#/project/${P.relay}/brief` },
  { name: 'compare-1440', w: 1440, url: `#/project/${P.relay}/compare` },
  { name: 'evidence-1440', w: 1440, url: `#/project/${P.relay}/evidence` },
  { name: 'portfolio-1440', w: 1440, url: '#/portfolio' },
  { name: 'settings-1440', w: 1440, url: '#/settings' },
  { name: 'new-390', w: 390, url: '#/new' },
  { name: 'portfolio-390', w: 390, url: '#/portfolio', full: true },
  { name: 'evidence-390', w: 390, url: `#/project/${P.relay}/evidence` },
  { name: 'insp-360', w: 360, h: 780, url: `#/watchlist?p=${P.relay}` },
  { name: 'project-360', w: 360, h: 780, url: `#/project/${P.relay}/brief` },
  { name: 'wl-1440-dark-list', w: 1440, url: '#/watchlist', theme: 'dark' },
  { name: 'insp-390-dark', w: 390, url: `#/watchlist?p=${P.relay}`, theme: 'dark' },
  { name: 'project-390-dark', w: 390, url: `#/project/${P.relay}/brief`, theme: 'dark' },
  { name: 'insp-390-full', w: 390, url: `#/watchlist?p=${P.relay}`, insp: true },
  { name: 'insp-390-ember', w: 390, url: `#/watchlist?p=${P.ember}`, insp: true },
  { name: 'review-1440', w: 1440, url: '#/review' },
  { name: 'review-1024', w: 1024, h: 768, url: '#/review' },
  { name: 'review-up-1440', w: 1440, url: '#/review?seg=upcoming' },
  { name: 'review-imp-1440', w: 1440, url: '#/review?seg=imports' },
  { name: 'review-390', w: 390, url: '#/review' },
  { name: 'review-390-open', w: 390, url: `#/review?p=${P.relay}` },
  { name: 'review-1440-dark', w: 1440, url: '#/review', theme: 'dark' },
  { name: 'x1920-desk', w: 1920, h: 1080, url: '#/watchlist' },
  { name: 'x1920-insp', w: 1920, h: 1080, url: `#/watchlist?p=${P.relay}` },
  { name: 'x1920-review', w: 1920, h: 1080, url: '#/review' },
  { name: 'x1920-portfolio', w: 1920, h: 1080, url: '#/portfolio' },
  { name: 'x1920-research', w: 1920, h: 1080, url: '#/research' },
  { name: 'x1440-desk', w: 1440, h: 900, url: '#/watchlist' },
  { name: 'x1440-insp', w: 1440, h: 900, url: `#/watchlist?p=${P.relay}` },
  { name: 'x1440-review', w: 1440, h: 900, url: '#/review' },
  { name: 'x1440-portfolio', w: 1440, h: 900, url: '#/portfolio' },
  { name: 'x1440-research', w: 1440, h: 900, url: '#/research' },
  { name: 'fx-360-long', w: 360, h: 780, url: `#/project/${P.long}/forensics` },
  { name: 'pf-attention-1440', w: 1440, url: '#/portfolio?tab=attention' },
  { name: 'research-ev-1440', w: 1440, url: '#/research?tab=evidence' },
  { name: 'research-1440', w: 1440, url: '#/research' },
  { name: 'prefs-1440-screening', w: 1440, url: '#/watchlist?prefs=screening' },
  { name: 'prefs-1440-models', w: 1440, url: '#/watchlist?prefs=models' },
  { name: 'prefs-1440-data', w: 1440, url: '#/watchlist?prefs=data' },
  { name: 'prefs-1440-dev', w: 1440, url: '#/watchlist?prefs=developer' },
  { name: 'prefs-390', w: 390, url: '#/watchlist?prefs=screening' },
  { name: 'cmdk-1440', w: 1440, url: '#/watchlist', js: "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))" },
  { name: 'cmdk-1440-q', w: 1440, url: '#/watchlist', js: "(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); await new Promise((r) => setTimeout(r, 400)); const i = document.querySelector('.cmdk-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'relay forensics'); i.dispatchEvent(new Event('input', { bubbles: true })); })()" },
  { name: 'cmdk-390', w: 390, url: '#/watchlist', js: "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))" },
  // The Apple HIG pass (2026-10-18): each changed view whole, light and dark.
  { name: 'hig-brief-1440', w: 1440, url: `#/project/${P.relay}/brief`, full: true },
  { name: 'hig-brief-1440-dark', w: 1440, url: `#/project/${P.relay}/brief`, full: true, theme: 'dark' },
  { name: 'hig-brief-ranges-1440', w: 1440, url: `#/project/${P.ranges}/brief`, full: true },
  { name: 'hig-brief-390', w: 390, url: `#/project/${P.relay}/brief`, full: true },
  { name: 'hig-review-1440', w: 1440, url: `#/review?p=${P.relay}` },
  { name: 'hig-review-1440-dark', w: 1440, url: `#/review?p=${P.relay}`, theme: 'dark' },
  { name: 'hig-insp-1440', w: 1440, url: `#/watchlist?p=${P.relay}`, insp: true },
  { name: 'hig-insp-1440-dark', w: 1440, url: `#/watchlist?p=${P.relay}`, insp: true, theme: 'dark' },
  { name: 'hig-insp-390', w: 390, url: `#/watchlist?p=${P.relay}` },
  { name: 'hig-portfolio-1440', w: 1440, url: '#/portfolio', full: true },
  { name: 'hig-portfolio-1440-dark', w: 1440, url: '#/portfolio', full: true, theme: 'dark' },
  { name: 'hig-desk-1440', w: 1440, url: '#/watchlist' },
  { name: 'hig-desk-1440-dark', w: 1440, url: '#/watchlist', theme: 'dark' },
];

const b = await launch();
const results = {};
try {
  for (const s of SHOTS) {
    if (only && !only.some((o) => s.name.startsWith(o))) continue;
    const tab = await b.openTab(base);
    await tab.size(s.w, s.h ? { height: s.h } : {});
    await tab.theme(base, s.theme || 'light');
    await tab.go(`${base}/${s.url}`, 2400);
    if (s.insp) {
      await tab.evalJs("document.querySelectorAll('.inspector details').forEach((d) => { d.open = true; })");
      await sleep(400);
      // The inspector's body, whole: grow the drawer to its content.
      await tab.evalJs("(() => { const i = document.querySelector('.inspector'); const b = i.querySelector('.insp-body'); i.style.height = 'auto'; i.style.position = 'relative'; b.style.overflow = 'visible'; })()");
      await sleep(300);
    }
    if (s.js) {
      await tab.evalJs(s.js);
      await sleep(900);
    }
    await tab.shot(path.join(out, `${s.name}.png`), { full: Boolean(s.full || s.insp) });
    results[s.name] = { errors: [...tab.errors], writes: [...tab.writes] };
    await tab.close();
  }
} finally {
  await b.kill();
}
console.log(JSON.stringify(results, null, 1));
process.exit(0);
