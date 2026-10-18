// Evaluate one expression on a page of the FICTIONAL dev desk and print the
// answer (design checks while building).
//   node scripts/probe.mjs --base http://127.0.0.1:4791 --url '#/research' --w 1440 --js '<expression>'
import { launch } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg('--base', 'http://127.0.0.1:5173');
const url = arg('--url', '#/watchlist');
const w = Number(arg('--w', '1440'));
const js = arg('--js', 'document.title');
const b = await launch();
try {
  const tab = await b.openTab(base);
  await tab.size(w, { height: 900 });
  await tab.go(`${base}/${url}`, 2600);
  console.log(JSON.stringify(await tab.evalJs(js), null, 1));
  await tab.close();
} finally {
  await b.kill();
}
