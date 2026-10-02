'use strict';
// Test child: one queue processor. Started twice at once to check that two
// processors apply a request exactly once (audit F01).
const path = require('path');
const base = path.resolve(__dirname, '..', '..');
const [root, label] = process.argv.slice(2);
const ws = require(path.join(base, 'core', 'workspace')).openWorkspace({ root, actor: `runner-${label}` });
const out = require(path.join(base, 'core', 'requests')).processRequests(ws);
process.stdout.write(JSON.stringify(out.results.map((r) => ({ id: r.request_id || r.file, status: r.status }))));
