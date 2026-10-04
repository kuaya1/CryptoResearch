'use strict';
// Request queue: the route for a session (for example a Cowork cloud session)
// that can write files into the folder but cannot run node against it.
//
// Publishing: write inbox/requests/<request_id>.json.tmp, then rename it to
// <request_id>.json. Files that are not *.json are ignored. A file that changed
// in the last few seconds, or that is not yet valid JSON, is left for the next
// pass (deferred), so a slowly written request is never failed half-way.
//
// Applying (audit F01/F11):
// 1. The action's effect commits together with an idempotency record
//    logs/applied/<request_id>--<op type>.json in ONE staged operation.
// 2. The receipt logs/requests/<request_id>.result.json and the move of the
//    request to processed/ (or failed/) commit in a second operation.
// A crash between 1 and 2 leaves the idempotency record, so the next pass
// writes the receipt without applying the effect again. Two processors are
// serialized by the workspace lock; the second finds the record or receipt.
//
// Receipt statuses: done (committed and verified), unchanged (nothing needed to
// change), rejected (refused; nothing saved), conflict (same request ID with
// different content; nothing saved), failed (error; nothing saved).
// Not yet processed = PENDING; there is no receipt until the outcome is known.

const fs = require('fs');
const { runOp, OpError, readApplied } = require('./ops');
const { readJson, listDir, exists, sha256, fileInfo, parseJson } = require('./fsx');
const { validate, loadSchema } = require('./schema');
const projects = require('./projects');
const inbox = require('./inbox');
const notes = require('./notes');
const portfolio = require('./portfolio');

const REQUEST_ID_RE = /^req_[A-Za-z0-9_-]{4,80}$/;

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

const ok = (status, message = null) => ({ status, message });

// Each allowlisted action: how to run it, which committed operation is its
// effect (for replay detection), and how its result maps to a receipt status.
const ACTIONS = {
  add_project: {
    effect: 'add_project',
    run: (ws, a) => projects.addProject(ws, a),
    outcome: (r) => (r.status === 'created' ? ok('done', r.message) : r.status === 'exists' ? ok('unchanged', r.message) : r.status === 'possible_duplicate' ? ok('rejected', r.message) : ok('failed', r.message || 'unexpected result')),
  },
  update_identity: {
    effect: 'update_identity',
    run: (ws, a) => projects.updateIdentity(ws, a.project_id, a),
    outcome: (r) => ok(r.noop ? 'unchanged' : 'done', `Identity is ${r.identity_status}.`),
  },
  set_watchlist: {
    effect: 'set_watchlist',
    run: (ws, a) => projects.setWatchlist(ws, a.project_id, a.on !== false),
    outcome: (r) => ok(r.noop ? 'unchanged' : 'done'),
  },
  set_project_fields: {
    effect: 'update_project',
    run: (ws, a) => projects.updateProjectFields(ws, a.project_id, a.fields || {}),
    outcome: (r) => ok(r.noop ? 'unchanged' : 'done'),
  },
  generate_prompts: {
    effect: 'generate_prompts',
    run: (ws, a) => projects.generatePrompts(ws, a.project_id, a.providers),
    outcome: (r) => ok(r.status === 'unchanged' ? 'unchanged' : 'done'),
  },
  archive_project: {
    effect: 'archive_project',
    run: (ws, a) => projects.archiveProject(ws, a.project_id, a.reason),
    outcome: (r) => ok(r.noop || r.status === 'unchanged' ? 'unchanged' : 'done'),
  },
  import_report_text: {
    effect: 'ingest_report',
    run: (ws, a) => inbox.importContent(ws, a.provider, { content: a.text, filename: a.filename || null, projectId: a.project_id || null, runId: a.run_id || null, channel: 'request_queue' }),
    outcome: (r) => {
      const st = r && r.result ? r.result.status : null;
      if (st === 'ingested') return ok('done', r.result.message);
      if (st === 'duplicate') return ok('unchanged', r.result.message);
      return ok('rejected', `${r && r.result ? r.result.message : 'Import failed.'} The text is kept in the inbox for correction.`);
    },
  },
  scan_inbox: {
    effect: null,
    run: (ws) => inbox.scanInbox(ws),
    outcome: (r) => {
      const c = r.counts || {};
      const problems = (c.failed || 0) + (c.needs_project || 0) + (c.prompt || 0) + (c.provider_mismatch || 0) + (c.run_mismatch || 0) + (c.error || 0);
      return ok((c.ingested || 0) > 0 ? 'done' : 'unchanged', `${c.ingested || 0} imported, ${c.duplicate || 0} duplicate, ${problems} need attention, ${c.waiting || 0} still being written.`);
    },
  },
  set_conviction_note: {
    effect: 'set_conviction_note',
    run: (ws, a) => notes.setConvictionNote(ws, a.project_id, a.text, { utterance: a.utterance || null, conviction: a.conviction || null }),
    outcome: (r) => ok(r.status === 'unchanged' ? 'unchanged' : 'done'),
  },
  add_journal: {
    effect: 'add_journal',
    run: (ws, a) => notes.addJournal(ws, a.project_id, a),
    outcome: () => ok('done'),
  },
  add_event: {
    effect: 'add_event',
    run: (ws, a) => notes.addEvent(ws, a.scope || a.project_id, a),
    outcome: (r) => ok(r.status === 'exists' ? 'unchanged' : 'done', r.due_alternative ? `Due ${r.event.due_date} (${r.due_interpretation}); the other reading would be ${r.due_alternative}.` : null),
  },
  add_transaction: {
    effect: 'add_transactions',
    run: (ws, a) => portfolio.addTransactions(ws, [a], { source: 'request' }),
    outcome: (r) => (r.status === 'saved' ? ok('done') : r.rejected && r.rejected.length ? ok('rejected', r.rejected.map((x) => x.errors.join('; ')).join(' | ')) : ok('unchanged', 'Already recorded.')),
  },
  research_project: {
    effect: 'research_run_create',
    run: (ws, a) => require('./research').createRun(ws, a),
    outcome: (r) => ok(r.status === 'exists' ? 'unchanged' : 'done', r.message),
  },
  cancel_research_job: {
    effect: 'research_job_update',
    run: (ws, a) => require('./research').cancelJob(ws, a.project_id, a.run_id, a.provider, a.reason || null),
    outcome: (r) => ok(r.noop ? 'unchanged' : 'done', r.message),
  },
  retry_research_job: {
    effect: 'research_job_update',
    run: (ws, a) => require('./research').retryJob(ws, a.project_id, a.run_id, a.provider),
    outcome: (r) => ok(r.noop ? 'unchanged' : 'done', r.message),
  },
};

const REJECT_CODES = new Set(['INVALID', 'BAD_ID', 'BAD_PATH', 'NOT_FOUND', 'CONFLICT', 'REFUSED', 'ALREADY_EXISTS', 'CONFIRM', 'BUDGET', 'UNCONFIGURED']);
const DEFER_CODES = new Set(['WORKSPACE_BUSY', 'APPLY_INTERRUPTED', 'LOCK_LOST', 'WRITES_BLOCKED', 'COMMIT_UNVERIFIED']);

function resultRel(id) {
  return `logs/requests/${id}.result.json`;
}

function strip(result) {
  // Keep result files small: paths and verification, not whole records.
  try {
    return JSON.parse(JSON.stringify(result === undefined ? null : result, (k, v) => (['project', 'raw', 'raw_json', 'assessment', 'record'].includes(k) ? undefined : v)));
  } catch (_) {
    return null;
  }
}

function settleSeconds(ws) {
  return (ws.settings.requests && ws.settings.requests.settle_seconds !== undefined) ? ws.settings.requests.settle_seconds : 2;
}

// Reads and checks one queued file. Returns { req } or { defer } or { reject }.
function readRequest(ws, filename) {
  const rel = `inbox/requests/${filename}`;
  const info = fileInfo(ws.abs(rel));
  if (!info || !info.isFile) return { defer: 'gone' };
  const ageMs = Date.now() - info.mtimeMs;
  const settle = settleSeconds(ws);
  if (settle > 0 && ageMs < settle * 1000) return { defer: 'still being written' };
  let req;
  try {
    req = parseJson(fs.readFileSync(ws.abs(rel), 'utf8'), rel);
  } catch (err) {
    if (ageMs < 60000) return { defer: 'not yet valid JSON; will retry' };
    return { reject: `Unreadable request file: ${err.message}` };
  }
  const res = validate(loadSchema(ws, 'request.v1'), req);
  if (!res.valid) return { req, reject: `Invalid request: ${res.errors.slice(0, 5).join('; ')}` };
  if (`${req.request_id}.json` !== filename) return { req, reject: 'request_id must match the file name' };
  if (!ACTIONS[req.action]) return { req, reject: `Action "${req.action}" is not allowed.` };
  return { req };
}

function payloadHashOf(req) {
  return sha256(stableStringify({ action: req.action, args: req.args || {} }));
}

// Writes the receipt and moves the request file, once. An existing receipt is
// never overwritten: a conflicting resubmission gets its own conflict record
// next to it and the original receipt stays as it was.
function writeReceipt(ws, filename, req, receipt, folder) {
  const id = receipt.request_id;
  return runOp(ws, { type: 'request_result', summary: `Request ${id}: ${receipt.status}` }, (op) => {
    const existing = readJson(ws.abs(resultRel(id)), null);
    let out = receipt;
    if (existing && receipt.status === 'conflict') {
      op.writeJson(`logs/requests/${id}.conflict-${Date.now()}.json`, receipt);
    } else if (existing) {
      out = existing;
    } else {
      op.writeJson(resultRel(id), receipt);
    }
    if (exists(ws.abs(`inbox/requests/${filename}`))) op.move(`inbox/requests/${filename}`, `inbox/requests/${folder}/${filename}`);
    return out;
  }).result;
}

function baseReceipt(ws, req, filename, payloadHash) {
  const stem = filename.replace(/\.json$/i, '');
  const id = req && req.request_id && REQUEST_ID_RE.test(req.request_id) && `${req.request_id}.json` === filename
    ? req.request_id
    : REQUEST_ID_RE.test(stem) ? stem : `invalid_${stem.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}`;
  return {
    schema_version: 'cr.request-result.v2',
    request_id: id,
    action: req ? req.action || null : null,
    utterance: req ? req.utterance || null : null,
    created_by: req ? req.created_by || null : null,
    payload_sha256: payloadHash || null,
    processed_at: new Date().toISOString(),
    processed_by: ws.actor,
  };
}

function receiptFromEffect(effect) {
  if (!effect) return null;
  return { op_id: effect.op_id || null, verified: effect.verified === true, replayed: Boolean(effect.replayed), applied_at: effect.applied_at || null, files: (effect.files || []).map((f) => (typeof f === 'string' ? f : f.rel)) };
}

function processOne(ws, filename) {
  const read = readRequest(ws, filename);
  if (read.defer) return { file: filename, status: 'pending', reason: read.defer };
  const req = read.req || null;
  const payloadHash = req ? payloadHashOf(req) : null;
  const base = baseReceipt(ws, req, filename, payloadHash);
  if (read.reject) {
    return writeReceipt(ws, filename, req, { ...base, status: 'rejected', message: read.reject, effect: null }, 'failed');
  }
  const id = req.request_id;
  // Same ID seen before: a receipt already exists.
  const prior = readJson(ws.abs(resultRel(id)), null);
  if (prior) {
    if (prior.payload_sha256 && prior.payload_sha256 !== payloadHash) {
      return writeReceipt(ws, filename, req, { ...base, status: 'conflict', message: `Request ID ${id} was already used for different content (receipt ${prior.status} at ${prior.processed_at}). Nothing was applied. Use a new request ID.`, effect: null }, 'failed');
    }
    return writeReceipt(ws, filename, req, prior, prior.status === 'rejected' || prior.status === 'failed' || prior.status === 'conflict' ? 'failed' : 'processed');
  }
  const spec = ACTIONS[req.action];
  // Effect already committed (crash before the receipt)? Rebuild the receipt.
  if (spec.effect) {
    const applied = readApplied(ws, `${id}#${spec.effect}`);
    if (applied) {
      if (applied.payload_sha256 && applied.payload_sha256 !== payloadHash) {
        return writeReceipt(ws, filename, req, { ...base, status: 'conflict', message: `Request ID ${id} was already applied with different content. Nothing new was applied.`, effect: null }, 'failed');
      }
      // The effect operation committed and verified earlier (its idempotency
      // record is part of that commit); only the receipt was missing.
      return writeReceipt(ws, filename, req, { ...base, status: 'done', message: `Applied earlier in operation ${applied.op_id} at ${applied.committed_at}; receipt written after a restart. Nothing was applied twice.`, recovered_receipt: true, result: applied.result, effect: { op_id: applied.op_id, verified: true, replayed: true, applied_at: applied.committed_at, files: applied.files } }, 'processed');
    }
  }
  const args = { ...(req.args || {}) };
  if (req.utterance && !args.utterance) args.utterance = req.utterance;
  let out;
  // Key every operation of a single-effect action by request ID. Multi-file
  // scans (effect null) stay unkeyed: each file has its own duplicate checks.
  ws._idem = spec.effect ? { requestId: id, payloadHash } : null;
  try {
    out = spec.run(ws, args);
  } catch (err) {
    ws._idem = null;
    if (DEFER_CODES.has(err.code)) return { file: filename, request_id: id, status: 'pending', reason: `${err.code}: ${err.message}` };
    const status = err.code === 'IDEMPOTENCY_CONFLICT' ? 'conflict' : REJECT_CODES.has(err.code) ? 'rejected' : 'failed';
    return writeReceipt(ws, filename, req, { ...base, status, message: err.message, code: err.code || null, effect: null }, 'failed');
  }
  ws._idem = null;
  const outcome = spec.outcome(out || {});
  const verified = out && (out.verified !== false) && !(out.result && out.result.verified === false);
  const status = ['done', 'unchanged'].includes(outcome.status) && !verified ? 'failed' : outcome.status;
  const effSrc = out && (out.op_id || out.files) ? out : out && out.result && (out.result.op_id || out.result.files) ? out.result : null;
  const effectInfo = effSrc ? receiptFromEffect({ op_id: effSrc.op_id || null, verified: effSrc.verified, files: effSrc.files || [], replayed: effSrc.replayed }) : null;
  return writeReceipt(ws, filename, req, {
    ...base,
    status,
    message: status === 'failed' && outcome.status !== 'failed' ? 'The change did not verify after writing; treat it as not saved.' : outcome.message,
    result: strip(out),
    effect: effectInfo,
  }, ['done', 'unchanged'].includes(status) ? 'processed' : 'failed');
}

function processRequests(ws) {
  const files = listDir(ws.abs('inbox/requests'), { dirs: false }).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  const results = [];
  for (const f of files) {
    try {
      results.push(processOne(ws, f));
    } catch (err) {
      results.push({ file: f, status: 'pending', reason: `${err.code || 'ERROR'}: ${err.message}` });
    }
  }
  const counted = results.filter((r) => r.status !== 'pending');
  return { processed: counted.length, pending: results.length - counted.length, results };
}

function requestStatus(ws, requestId) {
  if (!REQUEST_ID_RE.test(requestId)) throw new OpError('BAD_ID', 'Invalid request ID');
  if (exists(ws.abs(resultRel(requestId)))) return readJson(ws.abs(resultRel(requestId)));
  if (exists(ws.abs(`inbox/requests/${requestId}.json`))) {
    const appliedAny = listDir(ws.abs('logs/applied'), { dirs: false }).some((f) => f.startsWith(`${requestId}--`));
    return {
      request_id: requestId,
      status: 'pending',
      message: appliedAny
        ? 'The change is committed; its receipt is written on the next pass. Not reported as saved until the receipt exists.'
        : 'Waiting for the dashboard (while open) or the hourly scheduled task (while the PC is on and you are logged in) to apply it. Not saved yet.',
    };
  }
  if (exists(ws.abs(`inbox/requests/${requestId}.json.tmp`))) return { request_id: requestId, status: 'pending', message: 'Still being published (.tmp). Rename it to .json when complete.' };
  return { request_id: requestId, status: 'not_found' };
}

function pendingRequests(ws) {
  return listDir(ws.abs('inbox/requests'), { dirs: false })
    .filter((f) => f.endsWith('.json') || f.endsWith('.json.tmp'))
    .map((f) => {
      let req = null;
      try {
        req = readJson(ws.abs(`inbox/requests/${f}`));
      } catch (_) { /* reported when processed */ }
      const info = fileInfo(ws.abs(`inbox/requests/${f}`));
      return { file: f, publishing: f.endsWith('.tmp'), request_id: req && req.request_id, action: req && req.action, utterance: req && req.utterance, waiting_since: info ? new Date(info.mtimeMs).toISOString() : null };
    });
}

function recentResults(ws, limit = 20) {
  return listDir(ws.abs('logs/requests'), { dirs: false })
    .filter((f) => f.endsWith('.result.json'))
    .map((f) => {
      try {
        const r = readJson(ws.abs(`logs/requests/${f}`));
        return { request_id: r.request_id, action: r.action, status: r.status, message: r.message || r.error || null, processed_at: r.processed_at, utterance: r.utterance, project_id: projectOf(r) };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.processed_at).localeCompare(String(a.processed_at)))
    .slice(0, limit);
}

function projectOf(r) {
  const res = r.result || {};
  return res.project_id || (res.result && res.result.project_id) || null;
}

module.exports = { ACTIONS, processRequests, processOne, requestStatus, pendingRequests, recentResults, stableStringify, payloadHashOf, REQUEST_ID_RE };
