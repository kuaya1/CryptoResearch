// Headless Chrome over the DevTools protocol, with Node's own WebSocket and
// fetch (no packages): tabs that record errors, every non-GET request and
// every URL asked for, screenshots, key presses and clicks. Used by the
// browser checks (check.mjs) and the screenshots (shots.mjs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-web-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, '--no-first-run', '--no-default-browser-check', '--force-color-profile=srgb', '--hide-scrollbars', '--font-render-hinting=none', 'about:blank'], { stdio: 'ignore' });
  const json = async (p, method = 'GET') => {
    for (let i = 0; i < 80; i++) {
      try { return await (await fetch(`http://127.0.0.1:${port}${p}`, { method })).json(); } catch (_) { await sleep(250); }
    }
    throw new Error('DevTools did not answer');
  };
  await json('/json/version');
  return {
    async openTab(base) {
      const t = await json('/json/new?about:blank', 'PUT');
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => { ws.onopen = r; });
      let n = 0;
      const waiting = new Map();
      const errors = [];
      const writes = [];
      const requests = [];
      const send = (method, params = {}) => new Promise((res) => { const id = ++n; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
        if (d.method === 'Network.requestWillBeSent') {
          const u = d.params.request.url.replace(base, '');
          requests.push(`${d.params.request.method} ${u}`);
          if (d.params.request.method !== 'GET') writes.push(`${d.params.request.method} ${u}`);
        }
        if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
        if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning')) errors.push(`${d.params.type}: ${d.params.args.map((a) => a.value || a.description).join(' ')}`);
        if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(`log: ${d.params.entry.text} ${d.params.entry.url || ''}`);
      };
      const evalJs = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text };
        return r.result && r.result.result ? r.result.result.value : undefined;
      };
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Network.enable');
      await send('Log.enable');
      const tab = {
        send, evalJs, errors, writes, requests,
        async size(width, { mobile = width < 600, height = mobile ? 844 : 900, scale = mobile ? 2 : 1 } = {}) {
          await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
          if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
          else await send('Emulation.setTouchEmulationEnabled', { enabled: false });
        },
        async media(features) {
          await send('Emulation.setEmulatedMedia', { features });
        },
        async theme(base2, name) {
          await tab.go(`${base2}/#/settings`, 900);
          await evalJs(`localStorage.setItem('cr.theme', ${JSON.stringify(JSON.stringify(name))})`);
        },
        async go(url, wait = 1800) {
          await send('Page.navigate', { url: 'about:blank' });
          await sleep(100);
          await send('Page.navigate', { url });
          await sleep(wait);
        },
        async key(key, { code = key, vk = 0, shift = false, ctrl = false } = {}) {
          const mods = (shift ? 8 : 0) | (ctrl ? 2 : 0);
          const text = key === 'Enter' ? '\r' : key.length === 1 ? key : undefined;
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: mods, ...(text ? { text, unmodifiedText: text } : {}) });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: mods });
        },
        // Types into the focused field as a keyboard would (input events).
        async type(text) {
          await send('Input.insertText', { text });
        },
        async click(selector) {
          const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          if (!box) throw new Error(`no element ${selector}`);
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        },
        async shot(file, { full = false, maxH = 9000 } = {}) {
          const params = { format: 'png' };
          if (full) {
            const h = await evalJs(`Math.min(document.documentElement.scrollHeight, ${maxH})`);
            const w = await evalJs('innerWidth');
            params.clip = { x: 0, y: 0, width: w, height: h, scale: 1 };
            params.captureBeyondViewport = true;
          }
          const r = await send('Page.captureScreenshot', params);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
        },
        async close() { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`).catch(() => {}); },
      };
      return tab;
    },
    // Stops Chrome and deletes its temporary profile.
    async kill() {
      const gone = new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
      proc.kill();
      await gone;
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(userDir, { recursive: true, force: true }); break; } catch (_) { await sleep(300); }
      }
    },
  };
}
