'use strict';
// The agent lane's backlog (Eric, 2026-10-27; audits/2026-10-27-pm-builder):
// the "Active Backlog" section of DESK_STATE.md, one block per task. A block
// on main is Eric's authorization for that task's build and its automatic
// remediations, as his label on an issue is for an issue (only he updates
// main, by merging a pull request). Pure: text in, data out.
//
//   ### TASK-001 · Paper Book calculator
//   - **Status:** [TODO]
//   - **Template:** eng-backend@1
//   - **Outcome:** …
//   - **Acceptance checks:**
//     - …
//   - **Negative cases:**
//     - …
//   - **Files to change:** (optional hint)
//   - **Regression tests:** (optional hint)
//   - **Notes:** (optional)
//
// A status is exactly [TODO], [IN_PROGRESS: PR #<n>], [DONE] or
// [BLOCKED: <reason>]; anything else is a problem, never guessed. A task's
// version is the SHA-256 of its fields without the status, so a status change
// never makes a new version.
//
// The lane writes statuses only on a candidate's branch (statusTransform), and
// a candidate may change DESK_STATE.md only that way (statusOnly): its own row
// from [TODO] to [IN_PROGRESS: PR #<its pull request>] or to
// [BLOCKED: Needs Human Architect], other rows only from [IN_PROGRESS: PR #m]
// to [DONE] (on main that line can only have arrived by merging PR m), every
// other line byte for byte. A candidate therefore never adds, edits or
// reorders a task, so it never authorizes later work.

const crypto = require('crypto');

const FILE = 'DESK_STATE.md';
const SECTION = 'Active Backlog';
const PM_BLOCK = 'Needs Human Architect';
const ID_RE = /^TASK-\d{3,6}$/;
const HEAD_RE = /^### +(TASK-\d{3,6}) *(?:·|—|-|:) *(.+?)\s*$/;
const FIELD_RE = /^- \*\*([A-Za-z ]+):\*\*(?: (.*))?$/;
const STATUS_RE = /^\[(TODO|DONE|IN_PROGRESS: PR #([1-9]\d{0,6})|BLOCKED: ([^\]\n]{1,200}))\]$/;
// The issue form's labels (agent-guard.js FIELDS), in its order.
const FIELDS = [
  ['template', 'Template', true],
  ['outcome', 'Outcome', true],
  ['acceptance', 'Acceptance checks', true],
  ['negative', 'Negative cases', true],
  ['tests', 'Regression tests', false],
  ['paths', 'Files to change', false],
  ['notes', 'Notes', false],
];
const NAMES = new Map([['status', 'status'], ...FIELDS.map(([k, label]) => [label.toLowerCase(), k])]);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const linesOf = (text) => String(text || '').split(/\r?\n/);

function parseStatus(raw) {
  const s = String(raw || '').trim();
  const m = STATUS_RE.exec(s);
  if (!m) return null;
  if (m[1] === 'TODO') return { kind: 'todo', text: s };
  if (m[1] === 'DONE') return { kind: 'done', text: s };
  if (m[2]) return { kind: 'in_progress', pr: Number(m[2]), text: s };
  return { kind: 'blocked', reason: m[3].trim(), text: s };
}
const statusText = (to) => (to.kind === 'todo' ? '[TODO]' : to.kind === 'done' ? '[DONE]' : to.kind === 'in_progress' ? `[IN_PROGRESS: PR #${to.pr}]` : `[BLOCKED: ${to.reason}]`);
const statusLine = (to) => `- **Status:** ${statusText(to)}`;

// A field's value: the words after its name, then its indented lines with
// their common indent removed.
function valueOf(first, rest) {
  const body = rest.slice();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const indents = body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return [first || '', ...body.map((l) => l.slice(Math.min(cut, /^\s*/.exec(l)[0].length)))].join('\n').trim();
}

// The section's tasks, in order, with each one's problems and the index of
// its status line; and the section's own problems.
function parse(text) {
  const lines = linesOf(text);
  const start = lines.findIndex((l) => l.trim() === `## ${SECTION}`);
  if (start < 0) return { found: false, tasks: [], problems: [`${FILE} has no "## ${SECTION}" section`], lines };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^## /.test(lines[i])) { end = i; break; }
  const tasks = [];
  const problems = [];
  let cur = null;
  let field = null;
  const close = () => {
    if (field) { cur.raw[field.key] = valueOf(field.first, field.rest); field = null; }
  };
  for (let i = start + 1; i < end; i += 1) {
    const line = lines[i];
    if (/^### /.test(line)) {
      if (cur) { close(); tasks.push(cur); }
      const h = HEAD_RE.exec(line);
      cur = { id: h ? h[1] : null, title: h ? h[2].trim() : '', line: i, statusLine: null, raw: {}, problems: [] };
      if (!h) cur.problems.push(`line ${i + 1} is not a task heading ("### TASK-001 · Title")`);
      continue;
    }
    if (!cur) continue; // the section's own words, before its first task
    const f = FIELD_RE.exec(line);
    if (f) {
      close();
      const key = NAMES.get(f[1].trim().toLowerCase());
      if (!key) { cur.problems.push(`line ${i + 1} names an unknown field "${f[1].trim()}"`); continue; }
      if (key in cur.raw || (key === 'status' && cur.statusLine !== null)) cur.problems.push(`"${f[1].trim()}" appears twice`);
      if (key === 'status') { cur.statusLine = i; cur.raw.status = (f[2] || '').trim(); continue; }
      field = { key, first: f[2] || '', rest: [] };
      continue;
    }
    if (!line.trim() || /^\s/.test(line)) { if (field) field.rest.push(line); continue; }
    close();
    cur.problems.push(`line ${i + 1} is neither a field nor indented under one`);
  }
  if (cur) { close(); tasks.push(cur); }
  const seen = new Set();
  for (const t of tasks) {
    if (t.id && seen.has(t.id)) t.problems.push(`${t.id} appears twice`);
    if (t.id) seen.add(t.id);
    t.status = parseStatus(t.raw.status);
    if (t.statusLine === null) t.problems.push('no Status');
    else if (!t.status) t.problems.push(`the status "${String(t.raw.status).slice(0, 60)}" is not [TODO], [IN_PROGRESS: PR #<n>], [DONE] or [BLOCKED: <reason>]`);
    t.fields = {};
    for (const [k, label, required] of FIELDS) {
      t.fields[k] = String(t.raw[k] || '').trim();
      if (required && !t.fields[k]) t.problems.push(`"${label}" is empty`);
    }
    t.body = renderBody(t.fields);
    t.version = sha256(t.body);
  }
  return { found: true, tasks, problems, lines, start, end };
}

// The block as the agent task issue form would hold it, so agent-guard.js
// taskOf checks it exactly as it checks an issue.
function renderBody(fields) {
  return FIELDS.map(([k, label]) => `### ${label}\n\n${fields[k] || '_No response_'}`).join('\n\n');
}
const toIssue = (t) => ({ number: t.id, title: t.title, body: t.body, backlog: true });

// The task the lane builds next: the first [TODO] in the list's order, never
// a later one. A first [TODO] with problems is said, not skipped.
function firstTodo(tasks) {
  return tasks.find((t) => t.status && t.status.kind === 'todo') || null;
}

// agent/task-001 for TASK-001.
const branchOf = (id, prefix = 'agent/task-') => `${prefix}${String(id).slice('TASK-'.length)}`;
const idOfBranch = (ref, prefix = 'agent/task-') => (String(ref || '').startsWith(prefix) && ID_RE.test(`TASK-${String(ref).slice(prefix.length)}`) ? `TASK-${String(ref).slice(prefix.length)}` : null);

// The text with this task's status set to `to` and every other
// [IN_PROGRESS: PR #m] read as [DONE]. Null when the task is not there.
function statusTransform(text, { id, to }) {
  const p = parse(text);
  const me = p.tasks.find((t) => t.id === id && t.statusLine !== null);
  if (!me) return null;
  const crlf = /\r\n/.test(String(text));
  const lines = p.lines.slice();
  for (const t of p.tasks) {
    if (t.statusLine === null) continue;
    if (t === me) lines[t.statusLine] = statusLine(to);
    else if (t.status && t.status.kind === 'in_progress') lines[t.statusLine] = statusLine({ kind: 'done' });
  }
  return lines.join(crlf ? '\r\n' : '\n');
}

// Whether `head` differs from `base` only by the status changes a candidate
// of task `id` (pull request `pr`) may carry. `pr` null: none may.
function statusOnly(baseText, headText, { id, pr }) {
  const reasons = [];
  const b = parse(baseText);
  const h = parse(headText);
  if (!b.found || !h.found) return { ok: false, reasons: [`${FILE} must keep its "## ${SECTION}" section`] };
  if (b.lines.length !== h.lines.length) return { ok: false, reasons: [`${FILE} gains or loses lines; a candidate changes only status lines`] };
  const at = (p) => new Map(p.tasks.filter((t) => t.statusLine !== null).map((t) => [t.statusLine, t]));
  const bs = at(b);
  const hs = at(h);
  for (let i = 0; i < b.lines.length; i += 1) {
    if (b.lines[i] === h.lines[i]) continue;
    const bt = bs.get(i);
    const ht = hs.get(i);
    if (!bt || !ht || bt.id !== ht.id || !bt.id) { reasons.push(`${FILE} line ${i + 1} changes, and it is not a task's status line`); continue; }
    const from = bt.status;
    const to = ht.status;
    if (!from || !to) { reasons.push(`${bt.id}'s status is not one the lane writes`); continue; }
    if (bt.id === id) {
      const ok = pr && from.kind === 'todo' && ((to.kind === 'in_progress' && to.pr === pr) || (to.kind === 'blocked' && to.reason === PM_BLOCK));
      if (!ok) reasons.push(`${bt.id} goes from ${from.text} to ${to.text}; its candidate may only set [IN_PROGRESS: PR #${pr || '<its pull request>'}] or [BLOCKED: ${PM_BLOCK}] on a [TODO]`);
    } else if (!(from.kind === 'in_progress' && to.kind === 'done')) {
      reasons.push(`${bt.id} goes from ${from.text} to ${to.text}; a candidate of ${id} may only mark another task [DONE] after its pull request merged`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

module.exports = { FILE, SECTION, PM_BLOCK, ID_RE, STATUS_RE, FIELDS, parseStatus, statusText, statusLine, parse, renderBody, toIssue, firstTodo, branchOf, idOfBranch, statusTransform, statusOnly };
