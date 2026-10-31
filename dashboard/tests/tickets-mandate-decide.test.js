'use strict';
// decide() in paper-mandate mode (cr-paper-mandate@1): truthful provenance,
// the Trader Sim book only (never a PM Cohort position), Eric's decisions
// latch a ticket off, and only mandateSweep can pass a mandate.
// FICTIONAL temporary workspaces.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const T = require('../core/tickets');
const paper = require('../core/paper');
const notes = require('../core/notes');
const { mandateDesk, saveTicket, mandateArgs, inDays } = require('./mandate-fixture');

const BY = 'mandate:cr-paper-mandate@1';
const refused = (reason) => (e) => e.code === 'REFUSED' && e.details && e.details.reason === reason;
const positions = (ws) => paper.readRecords(ws).filter((l) => l.event === 'open');
const voids = (ws) => paper.readRecords(ws).filter((l) => l.event === 'void');

test('a mandate halve records the mandate\'s provenance and meaning, asks the trader, and opens no PM Cohort position', (t) => {
  const s = mandateDesk(t, { grade: 52 });
  const r = saveTicket(s.ws, s.pid);
  assert.equal(r.desk.suggested_risk_usd, 500);
  const out = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}`, note: 'Paper mandate, exploratory_50_54, grade 52.', mandate: mandateArgs('exploratory_50_54', 52), by: 'someone-else' });
  const d = out.result.decision;
  assert.equal(out.result.status, 'saved');
  assert.equal(d.decided_by, BY, 'never in Eric\'s name, whatever by says');
  assert.equal(d.meaning, T.MANDATE_MEANING);
  assert.match(d.meaning, /not Eric's decision/);
  assert.equal(d.pm_approved_risk_usd, 250);
  assert.deepEqual({ ...d.mandate, expires_at: typeof d.mandate.expires_at, settings_sha256: d.mandate.settings_sha256.length, authority: { ...d.mandate.authority, armed_at: typeof d.mandate.authority.armed_at } }, { version: 'cr-paper-mandate@1', tier: 'exploratory_50_54', grade_used: 52, expires_at: 'string', settings_sha256: 64, authority: { version: 'cr-mandate-authority@1', generation: 1, armed_at: 'string', policy_sha256: d.mandate.settings_sha256 } });
  assert.equal(d.effects.paper, null);
  assert.equal(d.effects.trader, 'open');
  assert.equal(out.result.paper, null);
  assert.ok(out.result.trader, 'the trader was asked for its order');
  assert.equal(positions(s.ws).length, 0, 'paper/positions.jsonl holds no position');
  const j = notes.loadJournal(s.ws, s.pid).find((e) => e.type === 'decision' && e.reasons.includes(`decision_id: ${d.decision_id}`));
  assert.match(j.text, new RegExp(`^Paper mandate halve on ticket ${r.receipt_id}, approved risk \\$250 \\(exploratory_50_54\\)\\.`));
  assert.ok(j.reasons.includes('mandate_action: halve'));
  assert.ok(j.reasons.includes(`decided_by: ${BY}`));
  assert.ok(!j.reasons.some((x) => x.startsWith('pm_action')));
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.decision.decided_by, BY);
  assert.equal(v.ticket.decision.mandate.tier, 'exploratory_50_54');
  assert.equal(v.ticket.decision.paper, null, 'no "position missing" on the card');
  assert.equal(T.summary(s.ws, s.pid).decision.decided_by, BY);
  // The same request again: unchanged.
  const again = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('exploratory_50_54', 52) });
  assert.equal(again.result.status, 'unchanged');
  // tickets reconcile completes nothing on the PM Cohort book for it.
  const rec = T.reconcileEffects(s.ws);
  assert.ok(!rec.completed.some((c) => c.step === 'paper'));
  assert.equal(positions(s.ws).length, 0);
});

test('Eric\'s undo of a mandate grant voids nothing on the PM Cohort book and latches the ticket off', (t) => {
  const s = mandateDesk(t, { grade: 52 });
  const r = saveTicket(s.ws, s.pid);
  T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('exploratory_50_54', 52) });
  const u = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'undo', by: 'eric' }).result.decision;
  assert.equal(u.decided_by, 'eric');
  assert.equal(u.effects.paper, null);
  assert.equal(u.effects.trader, 'close');
  assert.equal(voids(s.ws).length, 0);
  const j = notes.loadJournal(s.ws, s.pid).find((e) => e.reasons.includes(`decision_id: ${u.decision_id}`));
  assert.match(j.text, /^PM undid the paper mandate's halve on ticket/);
  const v = T.view(s.ws, s.pid);
  assert.equal(v.ticket.decision, null);
  assert.equal(v.ticket.mandate_latched.action, 'halve');
  // Eric's Undo suspends autonomy on the project; rearmed, the ticket is still his.
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}_2`, mandate: mandateArgs('exploratory_50_54', 52) }), refused('MANDATE_SUSPENDED'));
  T.setAutonomy(s.ws, s.pid, { action: 'rearm', request_id: 'req_rearm_decide1', by: 'eric' });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'halve', request_id: `mandate_${r.receipt_id}_3`, mandate: mandateArgs('exploratory_50_54', 52) }), refused('MANDATE_PRIOR_DECISION'));
});

test('a veto that lands first wins over a later mandate call', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid);
  T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'veto', by: 'eric' });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'approve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('standard_55_plus', 60) }), refused('MANDATE_SUSPENDED'));
  T.setAutonomy(s.ws, s.pid, { action: 'rearm', request_id: 'req_rearm_decide2', by: 'eric' });
  assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'approve', request_id: `mandate_${r.receipt_id}_b`, mandate: mandateArgs('standard_55_plus', 60) }), refused('MANDATE_PRIOR_DECISION'));
  assert.equal(T.view(s.ws, s.pid).ticket.decision.action, 'veto');
});

test('paused, expired or off: the mandate records nothing', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid);
  const call = () => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'approve', request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs('standard_55_plus', 60) });
  const a = s.ws.settings.automation;
  s.ws.settings.automation = { ...a, paused: true };
  assert.throws(call, refused('MANDATE_OFF'));
  s.ws.settings.automation = { ...a, mandate: { ...a.mandate, expires_at: new Date(Date.now() - 1000).toISOString() } };
  assert.throws(call, refused('MANDATE_OFF'));
  s.ws.settings.automation = { ...a, autonomous_paper_loop: false };
  assert.throws(call, refused('MANDATE_OFF'));
  assert.equal(T.readDecisions(s.ws, s.pid).length, 0);
  s.ws.settings.automation = { ...a, mandate: { ...a.mandate, expires_at: inDays(3) } };
  assert.equal(call().result.status, 'saved');
});

test('the tier must match the receipt\'s own grade; only approve, halve or reopen; only cr-paper-mandate@1', (t) => {
  const s = mandateDesk(t, { grade: 60.5 });
  const r = saveTicket(s.ws, s.pid);
  const call = (action, tier, version = T.MANDATE_VERSION) => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action, request_id: `mandate_${r.receipt_id}`, mandate: { version, tier, grade_used: 60.5 } });
  assert.throws(() => call('halve', 'exploratory_50_54'), (e) => e.code === 'INVALID' && /gives the paper mandate approve \(standard_55_plus\)/.test(e.message));
  assert.throws(() => call('approve', 'exploratory_50_54'), (e) => e.code === 'INVALID');
  assert.throws(() => call('veto', 'standard_55_plus'), (e) => e.code === 'INVALID' && /approve, halve or reopen only/.test(e.message));
  assert.throws(() => call('approve', 'standard_55_plus', 'cr-paper-mandate@2'), (e) => e.code === 'INVALID');
  assert.equal(T.readDecisions(s.ws, s.pid).length, 0);
  const d = call('approve', 'standard_55_plus').result.decision;
  assert.equal(d.pm_approved_risk_usd, 500);
  assert.equal(d.mandate.tier, 'standard_55_plus');
});

test('a grade under 50 is never granted by the mandate, whatever the floor says', (t) => {
  const s = mandateDesk(t, { grade: 48, settings: { tickets: { sizing: { min_grade_new_entry: 45, pregate_max_grade: 40 } } } });
  const r = saveTicket(s.ws, s.pid);
  assert.equal(r.desk.suggested_risk_usd, 500, 'the gate itself allows it at a floor of 45');
  for (const [action, tier] of [['halve', 'exploratory_50_54'], ['approve', 'standard_55_plus']]) {
    assert.throws(() => T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action, request_id: `mandate_${r.receipt_id}`, mandate: mandateArgs(tier, 48) }), (e) => e.code === 'INVALID' && /gives the paper mandate nothing/.test(e.message));
  }
});

test('a human approve still opens a PM Cohort position, exactly as before', (t) => {
  const s = mandateDesk(t, { grade: 60 });
  const r = saveTicket(s.ws, s.pid);
  const d = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'approve', by: 'eric' }).result.decision;
  assert.equal(d.decided_by, 'eric');
  assert.match(d.meaning, /^Eric's PM decision/);
  assert.equal(d.effects.paper, 'open');
  assert.equal(d.mandate, undefined);
  assert.equal(positions(s.ws).filter((p) => p.decision_id === d.decision_id).length, 1);
  const u = T.decide(s.ws, s.pid, { receipt_id: r.receipt_id, action: 'undo', by: 'eric' }).result.decision;
  assert.equal(u.effects.paper, 'void');
  assert.equal(voids(s.ws).length, 1);
});

// No HTTP route, CLI command, connector tool or script passes a mandate to decide.
test('only mandateSweep can pass a mandate to decide()', () => {
  const root = path.join(__dirname, '..');
  const files = ['server.js', 'cli.js', 'mcp.js', ...fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.js')).map((f) => `scripts/${f}`), ...fs.readdirSync(path.join(root, 'core')).filter((f) => f.endsWith('.js') && f !== 'tickets.js').map((f) => `core/${f}`)];
  const callsOf = (text) => {
    const out = [];
    let i = text.indexOf('decide(');
    while (i !== -1) {
      let depth = 0;
      let j = i + 'decide'.length;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')' && --depth === 0) break;
      }
      out.push(text.slice(i, j + 1));
      i = text.indexOf('decide(', j);
    }
    return out;
  };
  let seen = 0;
  for (const f of files) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const call of callsOf(fs.readFileSync(p, 'utf8'))) {
      seen++;
      assert.doesNotMatch(call, /mandate/, `${f} passes a mandate to decide`);
    }
  }
  assert.ok(seen >= 2, 'the route and the CLI command were read');
  // Inside tickets.js, the only caller passing a mandate is mandateSweep.
  const tk = fs.readFileSync(path.join(root, 'core', 'tickets.js'), 'utf8');
  const withMandate = callsOf(tk).filter((c) => /mandate:/.test(c) && !/^decide\(ws, pid, \{ receipt_id: rid, action, note = null/.test(c));
  for (const c of withMandate) {
    const at = tk.indexOf(c);
    const fn = tk.slice(0, at).match(/\nfunction (\w+)\(/g).pop();
    assert.match(fn, /mandateSweep|sweepProject/, `only the sweep passes a mandate (${fn})`);
  }
});
