// Screenshots of the Forensics tab on the FICTIONAL dev desk: desktop light
// and dark, tablet, and phones at 390 and 360, the whole page.
//   node scripts/fx-shots.mjs --out <dir>
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const out = path.resolve(arg('--out', 'shots'));
const desk = fork(path.join(here, 'dev-desk.cjs'), ['--port', String(4980 + Math.floor(Math.random() * 15))], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const base = (await new Promise((resolve, reject) => {
  desk.on('message', (m) => { if (m && m.ready) resolve(m); });
  desk.on('exit', (code) => reject(new Error(`the dev desk stopped (exit ${code})`)));
})).url;
const session = await (await fetch(`${base}/api/session`)).json();
const index = await (await fetch(`${base}/api/index`, { headers: { 'x-cr-token': session.token } })).json();
const relay = index.projects.find((p) => /Relay Network/.test(p.name)).project_id;
const none = index.projects.find((p) => /Unresearched/.test(p.name)).project_id;
const b = await launch();
try {
  for (const s of [
    // Light first: a chosen theme stays in the browser profile.
    { name: 'fx-1440-light', w: 1440, pid: relay },
    { name: 'fx-1024', w: 1024, pid: relay },
    { name: 'fx-390', w: 390, pid: relay, mobile: true },
    { name: 'fx-360', w: 360, pid: relay, mobile: true },
    { name: 'fx-1440-empty', w: 1440, pid: none },
    { name: 'fx-1440-open', w: 1440, pid: relay, open: true },
    { name: 'fx-1440-dark', w: 1440, pid: relay, theme: 'dark' },
    { name: 'fx-390-dark', w: 390, pid: relay, mobile: true, theme: 'dark' },
  ]) {
    const tab = await b.openTab(base);
    await tab.size(s.w, { mobile: Boolean(s.mobile) });
    if (s.theme) await tab.theme(base, s.theme);
    await tab.go(`${base}/#/project/${s.pid}/forensics`, 1500);
    await sleep(800);
    if (s.open) await tab.evalJs("document.querySelectorAll('.fx details').forEach((d) => { d.open = true; }); true");
    await sleep(300);
    await tab.shot(path.join(out, `${s.name}.png`), { full: true, maxH: 12000 });
    if (s.mobile) {
      // A phone, screen by screen: each section scrolled to the top.
      const n = await tab.evalJs("document.querySelectorAll('.fx > *').length");
      for (let i = 0; i < n; i++) {
        await tab.evalJs(`(() => { const el = document.querySelectorAll('.fx > *')[${i}]; window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 60); return true; })()`);
        await sleep(250);
        await tab.shot(path.join(out, `${s.name}-s${i}.png`));
      }
    }
    await tab.close();
  }
} finally {
  await b.kill();
  desk.disconnect();
}
console.log(`shots in ${out}`);
