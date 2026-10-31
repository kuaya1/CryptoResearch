'use strict';
// The contract RPC budget fails closed (cr-contract-rpc@1): an unreadable
// budget file is never counted from zero and never written over. FICTIONAL
// temporary workspaces and a fictional node; no network, no key, no provider.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { tempWorkspace } = require('./helpers');
const rpc = require('../core/contract-rpc');

const KEY = 'FICTIONALkey_0123456789';
const NOW = Date.parse('2026-10-30T12:00:00Z');
const clock = () => NOW;

function setup(t, caps = { daily_cu_cap: 100000, monthly_cu_cap: 1000000 }) {
  const w = tempWorkspace('rpc-budget', { contracts: caps });
  t.after(w.cleanup);
  return w.ws;
}

// A fictional node: answers any read with one result and counts what it was sent.
function node() {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body).method);
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }) };
    },
  };
}

function writeState(ws, text) {
  const file = ws.abs(rpc.STATE_REL);
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

test('a corrupt budget file stops the session before anything is sent, and the file stays byte for byte', async (t) => {
  const ws = setup(t);
  const corrupt = '{"schema_version":"cr.contract-rpc-state.v1","calls":{"month":"2026-10","month_cu":99';
  const file = writeState(ws, corrupt);
  const n = node();
  assert.throws(
    () => rpc.openSession(ws, { chainId: '8453', fetchImpl: n.fetch, key: KEY, now: clock }),
    (e) => e instanceof rpc.Stop && e.kind === 'budget_unreadable' && /could not be read; nothing is sent until it is repaired/.test(e.message),
  );
  assert.equal(n.calls.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
});

test('a budget file that goes unreadable mid-session stops the next request with its own reason, not "cap would be passed"', async (t) => {
  const ws = setup(t);
  const n = node();
  const session = rpc.openSession(ws, { chainId: '8453', fetchImpl: n.fetch, key: KEY, now: clock });
  const ok = await session.call('eth_getBlockByNumber', ['finalized', false]);
  assert.equal(ok.ok, true);
  assert.equal(n.calls.length, 1);
  const corrupt = 'not json at all';
  const file = writeState(ws, corrupt);
  await assert.rejects(session.call('eth_getBlockByNumber', ['finalized', false]), (e) => e instanceof rpc.Stop && e.kind === 'budget_unreadable' && !/would be passed/.test(e.message));
  assert.equal(n.calls.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
});

test('an unreadable budget file is never replaced by a state update (probe notes included)', (t) => {
  const ws = setup(t);
  const corrupt = '[[[';
  const file = writeState(ws, corrupt);
  assert.equal(rpc.readState(ws).unreadable, true);
  assert.throws(() => rpc.noteProbe(ws, '8453', NOW, { words: 'x', initial_minutes: 5, max_minutes: 60 }), (e) => e.code === 'INTEGRITY' && e.message === rpc.UNREADABLE_WORDS);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
});

test('a readable budget still reserves before each request and counts it', async (t) => {
  const ws = setup(t);
  const n = node();
  const session = rpc.openSession(ws, { chainId: '8453', fetchImpl: n.fetch, key: KEY, now: clock });
  await session.call('eth_getBlockByNumber', ['finalized', false]);
  await session.call('eth_getBlockByNumber', ['finalized', false]);
  const st = rpc.readState(ws);
  assert.equal(st.unreadable, undefined);
  assert.equal(st.calls.day_count, 2);
  assert.equal(st.calls.day_cu, 2 * rpc.CU.eth_getBlockByNumber);
  assert.equal(n.calls.length, 2);
});

test('a cap that would be passed still refuses with the budget reason and sends nothing more', async (t) => {
  const cu = rpc.CU.eth_getBlockByNumber;
  const ws = setup(t, { daily_cu_cap: cu, monthly_cu_cap: 1000000 });
  const n = node();
  const session = rpc.openSession(ws, { chainId: '8453', fetchImpl: n.fetch, key: KEY, now: clock });
  await session.call('eth_getBlockByNumber', ['finalized', false]);
  await assert.rejects(session.call('eth_getBlockByNumber', ['finalized', false]), (e) => e instanceof rpc.Stop && e.kind === 'budget' && /would be passed/.test(e.message));
  assert.equal(n.calls.length, 1);
  assert.equal(rpc.readState(ws).calls.day_cu, cu);
});
