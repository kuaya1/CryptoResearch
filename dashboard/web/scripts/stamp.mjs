// After `vite build`: records what the committed bundle in ../public/app was
// built from (a SHA-256 over the app's sources, its lockfile and the
// dashboard/public modules and stylesheets it bundles), so the test suite can
// tell when a source changed without a rebuild (dashboard/tests/web-app.test.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHash } from './source-hash.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const out = path.resolve(web, '..', 'public', 'app');
const info = { schema_version: 'cr.web-build.v1', source_sha256: sourceHash(web), files: fs.readdirSync(path.join(out, 'assets')).sort() };
fs.writeFileSync(path.join(out, 'build.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build.json: ${info.source_sha256.slice(0, 16)}… (${info.files.length} assets)`);
