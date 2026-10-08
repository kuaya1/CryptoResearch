// npm run dev: a FICTIONAL, offline desk (dev-desk.cjs) and Vite's dev server
// in front of it, with immediate refresh. Open the URL it prints. Ctrl+C
// stops both and deletes the fictional workspace. Never used in production.
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const deskPort = Number(process.env.CR_DESK_PORT || 4790);

const desk = fork(path.join(here, 'dev-desk.cjs'), ['--port', String(deskPort)], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
const ready = await new Promise((resolve, reject) => {
  desk.on('message', (m) => { if (m && m.ready) resolve(m); });
  desk.on('exit', (code) => reject(new Error(`the dev desk stopped (exit ${code})`)));
});

process.env.CR_DEV_DESK = ready.url;
const server = await createServer({ configFile: path.join(here, '..', 'vite.config.js') });
await server.listen();
server.printUrls();
console.log('  FICTIONAL data only. Ctrl+C stops the app and the dev desk.');

const stop = async () => {
  try { await server.close(); } catch (_) { /* closed */ }
  // Disconnecting lets the desk delete its fictional workspace and exit.
  try {
    const gone = new Promise((r) => { desk.once('exit', r); setTimeout(r, 5000); });
    desk.disconnect();
    await gone;
    if (desk.exitCode === null) desk.kill();
  } catch (_) { /* gone */ }
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
