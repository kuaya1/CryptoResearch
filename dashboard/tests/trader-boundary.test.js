'use strict';
// The trader's boundary (Junior Trader invariants 1, 3, 4 and 5; the
// pipeline review and the architecture recovery's PR D, 2026-10-27): the risk
// engine, the Paper Books, the arithmetic they compute with, their tests and
// the frozen intent schemas are protected, on the one list below; nothing
// outside them and their tests calls the trader yet (no route, CLI,
// connector tool or UI); no trader module reaches a network, a process or a
// secret; the frozen cr.trade-intent.v3 schema and the engine read the same
// fields, and v2 stays as published; the trader's in-force rule for Eric's
// decisions is the desk's; and the contract in DESK_STATE.md says an order
// never times out to lost. This file is on the list too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validate } = require('../core/schema');
const { sha256 } = require('../core/fsx');
const risk = require('../core/trade-risk');
const PT = require('../core/paper-trader');
const TR = require('../core/trader-rules');

const ROOT = path.join(__dirname, '..', '..');
const DESK = fs.readFileSync(path.join(ROOT, 'DESK_STATE.md'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The protected list (PR-B 5a, Eric 2026-10-28). It was the agent lane's
// admission list (backlog-promote.js PROTECTED), which goes with the lane;
// this is now its one record. A change to any file on it is its own
// supervised pull request, marked [P], that Eric reviews deliberately
// (audits/2026-10-27-de-escalation §4 and §5).
const PROTECTED = Object.freeze([
  'dashboard/core/trade-risk.js', 'dashboard/core/paper.js', 'dashboard/core/paper-trader.js', 'dashboard/core/decimal.js',
  'dashboard/tests/trade-risk.test.js', 'dashboard/tests/paper-trader.test.js', 'dashboard/tests/trader-boundary.test.js',
  'templates/schemas/trade-intent.v2.schema.json', 'templates/schemas/trade-intent.v3.schema.json',
]);
// A path as Eric's Windows PC reads it: letter case ignored, each name's
// trailing dots and spaces dropped, so Paper.JS is paper.js.
const foldPath = (p) => String(p).split('/').map((s) => s.replace(/[. ]+$/, '')).join('/').toLowerCase();
const isProtected = (p) => PROTECTED.some((x) => foldPath(x) === foldPath(p));
const section = (head) => {
  const at = DESK.indexOf(head);
  assert.ok(at >= 0, head);
  const next = DESK.slice(at + head.length).search(/\n##+ /);
  return DESK.slice(at, next < 0 ? undefined : at + head.length + next);
};

test('the protected list: every file on it exists, read as Windows reads a path, and no neighbour by accident', () => {
  for (const p of PROTECTED) assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} exists`);
  for (const p of ['Dashboard/Core/Paper.JS', 'dashboard/core/trade-risk.js.', 'dashboard/core/decimal.js ', 'DASHBOARD/TESTS/TRADER-BOUNDARY.TEST.JS']) assert.ok(isProtected(p), p);
  // The PM Paper Book's status-strip cell and Eric's rules home are not the book.
  for (const p of ['dashboard/core/paper-book.js', 'dashboard/tests/paper-book.test.js', 'dashboard/public/paper-model.js', 'dashboard/core/trader-rules.js', 'dashboard/tests/trader-rules.test.js', 'dashboard/core/paper.json', 'templates/schemas/trade-intent.v4.schema.json']) assert.equal(isProtected(p), false, p);
});

test('the docs that guide Eric\'s review name this list and nothing the lane kept', () => {
  // CLAUDE.md's Junior Trader contract: the four modules and their tests, pointing here.
  const claude = read('CLAUDE.md').split('\n').find((l) => l.startsWith('- The Junior Trader contract'));
  assert.ok(claude, 'CLAUDE.md has the Junior Trader contract');
  assert.match(claude, /`paper\.js`, `paper-trader\.js`, `trade-risk\.js`, `decimal\.js` and their tests are protected \(`dashboard\/tests\/trader-boundary\.test\.js`\)/);
  // DESK_STATE.md's cr-paper@2 section: the same files, on this list, never the lane's.
  const p = section('### Paper Book `cr-paper@2`').split('\n').find((l) => l.startsWith('- **Protected.**'));
  assert.ok(p, 'cr-paper@2 says what is protected');
  for (const f of ['`dashboard/core/paper.js`', '`paper-trader.js`', '`trade-risk.js`', '`decimal.js`', '`trade-risk`, `paper-trader` and `trader-boundary` under `dashboard/tests/`', '`dashboard/tests/trader-boundary.test.js`', '[P]']) assert.ok(p.includes(f), f);
  assert.doesNotMatch(p, /backlog-promote|builder|agent-lane|candidate/);
  // The constitution names only files on this list.
  const c = read('docs/CONSTITUTION.md').split('\n').find((l) => /Protected accounting modules/.test(l));
  assert.ok(c, 'the constitution names protected modules');
  const named = [...c.matchAll(/`([^`]+\.js)`/g)].map((m) => m[1]);
  assert.ok(named.length > 0);
  for (const f of named) assert.ok(isProtected(f), f);
});

test('invariant 4: an order is never recorded lost on a clock; unknown stays unknown until the venue answers', () => {
  const inv = section('### Junior Trader Desk Invariants');
  const four = inv.slice(inv.indexOf('4. **Reconciliation and nonce guard.**'), inv.indexOf('5. **Sovereign capital governance.**'));
  assert.match(four, /never times out to `lost`/);
  assert.match(four, /`INTENT` → `RESERVED`[^\n]*→ `SENT` → `ACKED`, `REJECTED` or `UNKNOWN`/);
  assert.match(four, /`ACKED` → `PARTIAL` → `FILLED`, `CANCELLED` or `EXPIRED`/);
  assert.match(four, /stays `UNKNOWN` until the engine has asked the venue for that `client_order_id`/);
  // What the code does (D9): the venue asked and holding no record, then its window.
  assert.match(four, /`NOT_FOUND` only when the venue, asked for that `client_order_id`, has no record of it and the venue's duplicate-order window has passed/);
  assert.match(four, new RegExp(`window is ${PT.VENUE_DUPLICATE_WINDOW_MINUTES} minutes from the send, on the engine's clock \\(\`paper-trader\\.js\` \`VENUE_DUPLICATE_WINDOW_MINUTES\`\\)`));
  assert.match(four, /A real venue would need its own explicit "unknown order" answer/);
  assert.doesNotMatch(four, /HMAC|MAC under a key/, 'the trader holds no key; its records carry no MAC');
  assert.match(four, /While any order is `RESERVED`, `SENT` or `UNKNOWN`[^\n]*opens no new intent/);
  assert.match(four, /never resends an order under a new `client_order_id`/);
  assert.doesNotMatch(four, /then is recorded `lost`/, 'the build lane\'s timeout is not an order\'s');
});

test('cr.trade-intent.v2: an intent id, decimal strings, an explicit long-only side and a minimum stop distance', () => {
  const s = section('### `TradeIntent` schema (`cr.trade-intent.v2`)');
  const shape = JSON.parse(/```json\n([\s\S]+?)\n```/.exec(s)[1]);
  assert.equal(shape.version, 'cr.trade-intent.v2');
  for (const k of ['intent_id', 'side', 'position_id', 'created_at', 'reference_price', 'reference_at', 'entry_price', 'stop_loss_price', 'take_profit_price', 'risk_ceiling_usd', 'max_slippage_bps', 'valid_until', 'evidence']) assert.ok(k in shape, k);
  assert.equal(shape.side, 'OPEN_LONG | CLOSE_LONG');
  assert.ok(!('action' in shape) && !('allocated_risk_usd' in shape) && !('target_price' in shape), 'v1\'s fields are gone');
  for (const k of ['reference_price', 'entry_price', 'stop_loss_price', 'take_profit_price', 'risk_ceiling_usd']) assert.match(shape[k], /^decimal string/, k);
  assert.match(s, /\*\*Minimum stop distance\.\*\*[^\n]*`STOP_MIN_PCT`[^\n]*`STOP_MIN_ATR`[^\n]*every intent is refused/);
  assert.match(s, /\*\*Size and notional cap\.\*\*[^\n]*`floor_to_lot\(/);
  // The formula the engine computes (D10), not the bare entry − stop.
  assert.match(s, /`floor_to_lot\(risk_ceiling_usd \/ per_unit_loss\)`[^\n]*`per_unit_loss = entry − stop_fill \+ fee\(entry\) \+ fee\(stop_fill\)`[^\n]*`stop_fill = stop × \(1 − STOP_SLIPPAGE_BPS \/ 10,000\)`/);
  for (const head of ['### `TradeIntent` schema (`cr.trade-intent.v2`)', '### Paper Book `cr-paper@2`']) assert.doesNotMatch(section(head), /floor_to_lot\(risk_ceiling(_usd)? \/ \(entry − stop\)\)/, head);
  assert.match(s, /\*\*Fresh price\.\*\*/);
  assert.match(s, /reads none of it for a decision/);
});

test('cr-paper@2: cash NAV, discrete sizing, fees and slippage, high/low stops with the stop first, apart from cr-paper@1', () => {
  const s = section('### Paper Book `cr-paper@2`');
  assert.match(s, /Built in `dashboard\/core\/paper-trader\.js` \(PR #59\) beside `cr-paper@1` \(`dashboard\/core\/paper\.js`, unchanged\)/);
  for (const part of ['**Cash NAV.**', '**Discrete sizing.**', '**Fills through the price.**', '**Fees and slippage.**', '**High/low wick stops.**', '**Long only.**', '**Protected.**']) assert.ok(s.includes(part), part);
  assert.match(s, /the stop is taken: the worse outcome/);
  assert.match(s, /never touches `paper\/positions\.jsonl`/);
});

const TRADER = ['dashboard/core/trade-risk.js', 'dashboard/core/paper-trader.js'];
// The modules that may call the trader: none yet but the trader itself.
const CALLERS = new Set([...TRADER]);
const ALLOWED_REQUIRES = new Set(['./decimal', './trade-risk', './ops', './fsx', './ids', 'fs', 'path', 'crypto']);

function files(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!['node_modules', 'app', 'dist'].includes(e.name)) files(rel, out);
    } else if (/\.(c|m)?jsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('the trader modules and the schemas the engine reads are on the protected list', () => {
  for (const p of [...TRADER, 'templates/schemas/trade-intent.v2.schema.json', `templates/schemas/trade-intent.${risk.INTENT_VERSION.split('.').pop()}.schema.json`]) assert.ok(isProtected(p), `${p} is protected`);
});

test('nothing outside the trader and its tests calls it yet', () => {
  const hits = [];
  for (const rel of files('dashboard')) {
    if (CALLERS.has(rel) || rel.startsWith('dashboard/tests/')) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/(require\(|from|import\()\s*['"][^'"]*(trade-risk|paper-trader)(\.js)?['"]/.test(src)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

test('no trader module reaches a network, a process, the environment or a secret', () => {
  for (const rel of TRADER) {
    if (!fs.existsSync(path.join(ROOT, rel))) continue;
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/require\(\s*'([^']+)'\s*\)/g)) assert.ok(ALLOWED_REQUIRES.has(m[1]), `${rel} requires ${m[1]}`);
    for (const re of [/process\.env/, /\bfetch\(/, /secrets/i, /api[_-]?key/i, /wallet/i]) assert.doesNotMatch(src, re, `${rel} ${re}`);
  }
});

test('D10: the settings home holds every rule the engine refuses without, and none it does not know', () => {
  // The engine's three optional tightenings keep their hard limits when absent.
  const required = risk.RULE_FIELDS.filter((f) => !['risk_per_trade_max', 'daily_drawdown_max', 'slippage_bps_max'].includes(f));
  assert.deepEqual([...TR.FIELDS, 'price_stale_minutes'].sort(), [...required].sort());
  const r = risk.validateTradeIntent({}, {}, {});
  const unset = new Set(r.refusals.filter((x) => x.rule === 'rule_unset').map((x) => x.field));
  for (const f of ['price_stale_minutes', 'max_validity_minutes']) assert.ok(unset.has(`rules.${f}`), f);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'dashboard', 'core', 'trader-rules.js'), 'utf8'), /require\(['"][^'"]*(trade-risk|paper-trader)/, 'the settings home does not call the trader');
});

const schemaText = (v) => fs.readFileSync(path.join(ROOT, 'templates', 'schemas', `trade-intent.${v}.schema.json`), 'utf8').replace(/\r\n/g, '\n');

test('the frozen cr.trade-intent.v3 schema and the engine read the same fields and the same decimals; v2 stays as published', () => {
  const schema = JSON.parse(schemaText('v3'));
  assert.equal(schema.$id, risk.INTENT_VERSION);
  assert.equal(risk.VERSION, 'cr-trade-risk@2');
  assert.deepEqual(Object.keys(schema.properties).sort(), [...risk.INTENT_FIELDS].sort());
  assert.deepEqual([...schema.required].sort(), risk.INTENT_FIELDS.filter((f) => f !== 'position_id').sort());
  for (const f of ['project_id', 'receipt_id', 'decision_id']) assert.ok(risk.TICKET_FIELDS.includes(f) && schema.required.includes(f), f);
  const intent = {
    version: 'cr.trade-intent.v3', intent_id: '01JBXQ5R7Z8Y9W0V1T2S3R4Q5P', thesis_id: 'tr_2026-10-27T000000Z_fict2', project_id: 'fict-project', receipt_id: 'tr_2026-10-27T000000Z_fict2', decision_id: 'td_fict0000000001',
    pair: 'FICT/USDC', side: 'OPEN_LONG', order_type: 'LIMIT',
    created_at: '2026-10-27T11:58:00Z', reference_price: '100', reference_at: '2026-10-27T11:57:00Z', entry_price: '100', stop_loss_price: '95', take_profit_price: '115',
    risk_ceiling_usd: '100', max_slippage_bps: 20, valid_until: '2026-10-27T13:00:00Z', evidence: { catalyst: 'c', metrics_evaluated: ['m'], negative_invalidation: 'n' },
  };
  assert.deepEqual(validate(schema, intent).errors, []);
  assert.deepEqual(validate(schema, { ...intent, side: 'CLOSE_LONG', position_id: 'pos-1' }).errors, []);
  const without = (f) => { const x = { ...intent }; delete x[f]; return x; };
  for (const bad of [{ position_id: 'pos-1' }, { side: 'CLOSE_LONG' }, { entry_price: 100 }, { entry_price: '1e2' }, { max_slippage_bps: 21 }, { client_order_id: 'x' }, { version: 'cr.trade-intent.v1' }, { version: 'cr.trade-intent.v2' }, { project_id: '../config' }, { grant: { pm_approved_risk_usd: '1000' } }]) {
    assert.equal(validate(schema, { ...intent, ...bad }).valid, false, JSON.stringify(bad));
  }
  for (const f of ['project_id', 'receipt_id', 'decision_id']) assert.equal(validate(schema, without(f)).valid, false, f);
  // v2 is never edited: its text is the one published by PR #58.
  assert.equal(sha256(schemaText('v2')), '084e34ddf02f306a90b0295714284eaf9a6ad752b8bd8cd214f26b5e9f921a7f');
});

test('D8: the trader reads Eric\'s grant from his stored decision, by the desk\'s own in-force rule', () => {
  const T = require('../core/tickets');
  const rid = 'tr_2026-10-27T000000Z_fict2';
  const line = (id, action, over = {}) => ({ schema_version: PT.DECISION_VERSION, decision_id: id, project_id: 'fict-project', receipt_id: rid, action, ...over });
  const undo = (id, of) => line(id, 'undo', { undoes: of });
  const seqs = [[], [line('a', 'approve')], [line('a', 'approve'), undo('u', 'a')], [line('a', 'approve'), undo('u', 'a'), line('b', 'halve')], [line('a', 'approve'), line('b', 'reopen')], [undo('u', 'a'), line('a', 'approve')], [line('a', 'approve', { receipt_id: 'tr_other' })]];
  for (const ls of seqs) assert.deepEqual(PT.decisionInForce(ls, rid), T.decisionFor(ls, rid), JSON.stringify(ls));
  // The desk writes the decision schema the trader reads.
  assert.match(fs.readFileSync(path.join(ROOT, 'dashboard', 'core', 'tickets.js'), 'utf8'), new RegExp(`schema_version: '${PT.DECISION_VERSION.replace(/\./g, '\\.')}'`));
  const src = fs.readFileSync(path.join(ROOT, 'dashboard', 'core', 'paper-trader.js'), 'utf8');
  assert.match(src, /projects\/\$\{pid\}\/tickets\/decisions\.jsonl/);
  assert.doesNotMatch(src, /grant: ctx\.grant/, 'the book never carries a caller\'s grant');
});
