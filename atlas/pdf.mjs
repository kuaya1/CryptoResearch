// Renders the atlas's printable document (#/print) to
// atlas/CryptoResearch-System-Atlas.pdf with headless Chrome or Edge over the
// DevTools protocol (local only; no network beyond the browser's own loopback).
//   node atlas/build.mjs && node atlas/pdf.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'CryptoResearch-System-Atlas.pdf');
const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].filter(Boolean);
const browser = candidates.find((p) => fs.existsSync(p));
if (!browser) { console.error('atlas pdf: no Chrome or Edge found; set CHROME_PATH'); process.exit(1); }

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pdf-'));
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
  const f = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100; i++) { if (fs.existsSync(f)) { const [p] = fs.readFileSync(f, 'utf8').split('\n'); if (p) return p; } await sleep(100); }
  throw new Error('browser did not start');
}

try {
  const p = await port();
  const targets = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r, j) => { const n = ++id; waiting.set(n, (d) => (d.error ? j(new Error(d.error.message)) : r(d.result))); ws.send(JSON.stringify({ id: n, method, params })); });

  await send('Page.enable');
  await send('Page.navigate', { url: pathToFileURL(path.join(here, 'index.html')).href + '#/print' });
  for (let i = 0; i < 100; i++) {
    const { result } = await send('Runtime.evaluate', { expression: '!!document.querySelector(".printdoc .pc") && document.fonts.status === "loaded"', returnByValue: true });
    if (result.value) break; await sleep(100);
  }
  await sleep(300);
  const footer = `<div style="width:100%;font:8px -apple-system,'Segoe UI',sans-serif;color:#6a6a66;padding:0 0.75in;display:flex;justify-content:space-between">
    <span>CryptoResearch · The Living System Atlas</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
  const { data } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
    headerTemplate: '<div></div>', footerTemplate: footer, generateTaggedPDF: true });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  ws.close();
  console.log(`atlas pdf: ${path.relative(process.cwd(), out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
} finally {
  child.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
