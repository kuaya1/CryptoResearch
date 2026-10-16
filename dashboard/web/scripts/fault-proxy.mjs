// A fault-injecting reverse proxy in front of the FICTIONAL dev desk, for the
// regression checks (regress.mjs). It forwards only to a loopback desk and is
// steered from the check through `set()`: delays, failures, a session that
// hangs or answers HTML, a missing app chunk, a forced live change, and a
// "new report" snapshot of one opinion (a renamed report with another grade,
// verdict and risks, consistent in the index and the project record, so a
// mixed render is detectable). For the review check-in: a POST forwarded to
// the desk whose answer is then dropped (the desk wrote, the page never
// hears), a POST refused with 503 (never forwarded), and the live change
// notice held back so a report saved meanwhile is not redrawn. POST bodies
// are kept in the log for the checks.
import http from 'node:http';

export const NEW_REPORT_ID = 'fictional-new-revision';
export const NEW_RISK = 'FICTIONAL NEW REPORT: new risk, distinct from the prior snapshot';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startFaultProxy({ target, port = 0, project = null, provider = 'claude' }) {
  const t = new URL(target);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(t.hostname)) throw new Error('the fault proxy forwards only to a loopback desk');
  const cfg = {
    session: 'normal', // normal | hang | html | expired | badjson | hosted
    projectDelay: 0, indexDelay: 0, projectFail: false, indexFail: false,
    blockChunk: '', bump: 0, snapshot: 'original', signedOut: false,
    dropPost: '', failPost: '', holdVersion: null,
  };
  const log = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const entry = { method: req.method, path: p, at: Date.now() };
    log.push(entry);
    if (p === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Sign in</title><h1>FICTIONAL sign-in page</h1>'); }
    if (cfg.blockChunk && p.startsWith('/app/assets/') && p.includes(cfg.blockChunk)) { entry.status = 404; return json(res, 404, { error: 'FICTIONAL retired chunk' }); }
    if (cfg.signedOut && p.startsWith('/api/')) { entry.status = 401; return json(res, 401, { error: 'FICTIONAL session expired' }); }
    if (p === '/api/session') {
      if (cfg.session === 'hang') return undefined;
      if (cfg.session === 'html') { entry.status = 503; res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<h1>503 FICTIONAL upstream unavailable</h1>'); }
      if (cfg.session === 'expired') { entry.status = 401; return json(res, 401, { error: 'FICTIONAL session expired' }); }
      if (cfg.session === 'badjson') { entry.status = 200; return json(res, 200, { hello: 'not a session' }); }
    }
    if (p === '/api/index' && cfg.indexFail) { entry.status = 503; return json(res, 503, { error: 'FICTIONAL index unavailable' }); }
    if (p.startsWith('/api/projects/') && cfg.projectFail && req.method === 'GET') { entry.status = 503; return json(res, 503, { error: 'FICTIONAL project unavailable' }); }
    try {
      let body = '';
      for await (const b of req) body += b;
      if (req.method === 'POST') entry.body = body.slice(0, 4000);
      if (req.method === 'POST' && cfg.failPost && p.includes(cfg.failPost)) { entry.status = 503; entry.forwarded = false; return json(res, 503, { error: 'FICTIONAL desk unavailable' }); }
      const headers = { ...req.headers, host: t.host };
      delete headers.connection;
      if (headers.origin) headers.origin = t.origin;
      if (headers.referer) headers.referer = headers.referer.replace(/^http:\/\/[^/]+/, t.origin);
      const out = await fetch(`${t.origin}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' });
      let buf = Buffer.from(await out.arrayBuffer());
      const isJson = (out.headers.get('content-type') || '').includes('application/json');
      if (isJson && out.ok) {
        let v = null;
        try { v = JSON.parse(buf); } catch (_) { v = null; }
        if (v) {
          if (p === '/api/session' && cfg.session === 'hosted') v.hosted = true;
          if (p === '/api/version' && cfg.bump) { v.seq += cfg.bump; v.changes = [{ areas: ['all'], projects: null }]; }
          if (p === '/api/version' && cfg.holdVersion !== null) { v.seq = cfg.holdVersion; v.changes = []; }
          if (p === '/api/index') {
            if (cfg.bump && v.live) v.live.seq += cfg.bump;
            if (cfg.snapshot === 'new' && project) {
              const row = v.projects.find((x) => x.project_id === project);
              const r = row && row.providers && row.providers[provider];
              if (r) {
                r.report_id = NEW_REPORT_ID;
                r.verdict = 'AVOID';
                r.grade = { ...r.grade, status: 'firm', value: 90.4, display: '90.4', label: 'A', low: null, high: null, coverage_pct: 100 };
                r.model_total = null;
              }
            }
          }
          if (project && p === `/api/projects/${encodeURIComponent(project)}` && cfg.snapshot === 'new') {
            const old = v.comparison && v.comparison.latest && v.comparison.latest[provider] ? v.comparison.latest[provider].report_id : null;
            const r = old ? v.reports.find((x) => x.report_id === old) : null;
            if (r) {
              r.report_id = NEW_REPORT_ID;
              if (r.meta) r.meta.report_id = NEW_REPORT_ID;
              r.assessment.verdict = 'AVOID';
              r.grade = { ...r.grade, status: 'firm', value: 90.4, display: '90.4', label: 'A', low: null, high: null };
              r.model_total = null;
              for (const f of r.assessment.bearish_facts || []) f.text = NEW_RISK;
              v.comparison.latest[provider].report_id = NEW_REPORT_ID;
              v.comparison.latest[provider].verdict = 'AVOID';
            }
          }
          buf = Buffer.from(JSON.stringify(v));
        }
      }
      // A held answer is released early when the check turns the delay off.
      const which = p.startsWith('/api/projects/') && req.method === 'GET' ? 'projectDelay' : p === '/api/index' ? 'indexDelay' : null;
      const delay = which ? cfg[which] : 0;
      if (delay) {
        const t0 = Date.now();
        while (Date.now() - t0 < delay && cfg[which] > 0) await new Promise((r) => setTimeout(r, 50));
      }
      // The desk answered; the page never hears it.
      if (req.method === 'POST' && cfg.dropPost && p.includes(cfg.dropPost)) {
        entry.status = out.status;
        entry.dropped = true;
        res.socket.destroy();
        return undefined;
      }
      const h = Object.fromEntries(out.headers);
      delete h['content-length'];
      delete h['content-encoding'];
      delete h['transfer-encoding'];
      entry.status = out.status;
      res.writeHead(out.status, h);
      res.end(buf);
    } catch (err) {
      if (!res.headersSent) json(res, 502, { error: err.message });
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    cfg,
    log,
    set(next) { Object.assign(cfg, next); },
    reset() { Object.assign(cfg, { session: 'normal', projectDelay: 0, indexDelay: 0, projectFail: false, indexFail: false, blockChunk: '', bump: 0, snapshot: 'original', signedOut: false, dropPost: '', failPost: '', holdVersion: null }); },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}
