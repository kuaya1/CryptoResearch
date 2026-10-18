// Measure the Desk's table at a width on the FICTIONAL dev desk: each column's
// width and whether the list scrolls sideways (a phone keeps four columns in
// view). node scripts/measure.mjs --base http://127.0.0.1:4791 [--w 360]
import { launch } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg('--base', 'http://127.0.0.1:5173');
const widths = String(arg('--w', '360,390')).split(',').map(Number);
const hash = arg('--url', '#/watchlist');
const b = await launch();
try {
  for (const w of widths) {
    const tab = await b.openTab(base);
    await tab.size(w, { height: 900 });
    await tab.go(`${base}/${hash}`, 2400);
    const out = await tab.evalJs(`(() => {
      const sc = document.querySelector('.wl-scroll');
      const ths = [...document.querySelectorAll('.wl-table thead th')].map((th) => [th.className.split(' ')[0], Math.round(th.getBoundingClientRect().width)]); const name = Math.max(...[...document.querySelectorAll('.wl-table td.c-name .proj')].map((n) => n.scrollWidth));
      return JSON.stringify({ client: sc && sc.clientWidth, scroll: sc && sc.scrollWidth, ths, name });
    })()`);
    console.log(w, out);
    await tab.close();
  }
} finally {
  await b.kill();
}
