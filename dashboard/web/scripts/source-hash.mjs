// The SHA-256 the committed bundle is stamped with: every file the build reads
// (the app's sources and config, its lockfile, and the dashboard/public
// modules and stylesheets it bundles), in a fixed order, path and bytes.
// Shared by stamp.mjs and the test suite (which loads it with import()).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, keep, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

export function sourceFiles(web) {
  const pub = path.resolve(web, '..', 'public');
  const files = [
    ...['index.html', 'vite.config.js', 'scope-legacy.js', 'package.json', 'package-lock.json'].map((f) => path.join(web, f)),
    ...walk(path.join(web, 'src'), () => true),
    ...walk(pub, (p) => /\.(js|css)$/.test(p) && !path.relative(pub, p).split(path.sep).includes('app')),
  ];
  return files.map((f) => path.relative(path.resolve(web, '..'), f).split(path.sep).join('/')).sort();
}

export function sourceHash(web) {
  const base = path.resolve(web, '..');
  const h = crypto.createHash('sha256');
  for (const rel of sourceFiles(web)) {
    h.update(`${rel}\0`);
    h.update(fs.readFileSync(path.join(base, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}
