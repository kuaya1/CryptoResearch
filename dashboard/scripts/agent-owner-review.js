'use strict';
// Eric's review of one pull request head, read from records GitHub
// authenticates (hardening, 2026-10-27; audits/2026-10-27-hardening). Trusted
// code: agent-review.js runs it from main's checkout and reads the pull
// request as data. Nothing in a commit (its author, its branch, its message)
// counts as a review.
//
// A receipt is one of:
//   comment  a comment on the pull request whose first line is exactly
//            "/reviewed <the full 40-character head>", by the repository's
//            owner (a User, association OWNER), never edited
//   approve  an approving review by the owner; GitHub binds it to the
//            commit it was given at (commit_id)
// Either names one exact head. A review of an earlier head covers a later
// one only when every commit since is a merge of main that adds nothing of
// its own (GitHub's "Update branch") and the pull request's own change is
// the same patch (git patch-id --stable on its merge base with main).
//
// The state of a head, in words that say which:
//   owner_override  Eric reviewed this head (or one it carries over from)
//   invalidated     Eric reviewed an earlier head that does not carry over
//   missing         no review of this head at all
// agent-review.js adds the model's own: independent_pass and failed.

const { spawnSync } = require('child_process');

const SHA_RE = /^[0-9a-f]{40}$/;
const REVIEWED_RE = /^\/reviewed[ \t]+([0-9a-f]{40})[ \t]*(?:\r?\n|$)/;
const LOOKS_RE = /^\/reviewed\b/;
const MAX_STEPS = 20;
const short = (s) => String(s || '').slice(0, 12);
const oneLine = (s, n = 200) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error) throw r.error;
  return { status: r.status, out: String(r.stdout || '').trim(), raw: String(r.stdout || '') };
}

const isOwner = (user, association, owner) => Boolean(user && owner && user.login === owner && user.type === 'User' && association === 'OWNER');
const who = (user, association) => `${oneLine(user && user.login, 60) || 'unknown'} (${oneLine(user && user.type, 20) || 'unknown'}, ${oneLine(association, 30) || 'unknown'})`;

// The owner's receipts on a pull request, newest first, and the /reviewed
// comments that are not receipts, with why.
function receiptsOf({ comments = [], reviews = [], owner }) {
  const receipts = [];
  const ignored = [];
  for (const c of comments) {
    const body = String((c && c.body) || '');
    if (!LOOKS_RE.test(body)) continue;
    const m = REVIEWED_RE.exec(body);
    if (!m) { ignored.push({ id: c.id, why: 'its first line is not "/reviewed" and a full 40-character commit' }); continue; }
    if (!isOwner(c.user, c.author_association, owner)) { ignored.push({ id: c.id, why: `it is by ${who(c.user, c.author_association)}, not the repository's owner` }); continue; }
    if (String(c.updated_at || '') !== String(c.created_at || '')) { ignored.push({ id: c.id, why: 'it was edited after it was posted' }); continue; }
    receipts.push({ kind: 'comment', id: c.id, head: m[1], at: String(c.created_at || ''), url: c.html_url || null });
  }
  for (const r of reviews) {
    if (!r || r.state !== 'APPROVED' || !SHA_RE.test(String(r.commit_id || ''))) continue;
    if (!isOwner(r.user, r.author_association, owner)) continue;
    receipts.push({ kind: 'approve', id: r.id, head: r.commit_id, at: String(r.submitted_at || ''), url: r.html_url || null });
  }
  receipts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { receipts, ignored };
}

// The pull request's own change at `head` as one patch ID: its diff on its
// merge base with main. Line numbers and blob IDs do not count; context
// lines do, so a change of main next to the change does.
function patchId(cwd, base, head) {
  const mb = git(cwd, ['merge-base', base, head]).out;
  if (!SHA_RE.test(mb)) return null;
  const d = git(cwd, ['diff', '--no-color', '--no-ext-diff', '--full-index', '--binary', '--no-renames', mb, head]);
  if (d.status !== 0) return null;
  if (!d.raw) return 'empty';
  const id = git(cwd, ['patch-id', '--stable'], d.raw).out.split(/\s+/)[0];
  return SHA_RE.test(id) ? id : null;
}

// Whether a review of `from` covers `to`: `to` reaches `from` through first
// parents, each step a merge whose second parent is on main (`base`) and
// whose tree is the plain merge of its parents, and the patch is the same.
function carriesOver(cwd, { from, to, base }) {
  if (!SHA_RE.test(String(from)) || !SHA_RE.test(String(to))) return { ok: false, why: 'a head is not a full commit' };
  if (from === to) return { ok: true, merges: 0 };
  if (git(cwd, ['cat-file', '-e', `${from}^{commit}`]).status !== 0) return { ok: false, why: `${short(from)} is not in this pull request's history any more` };
  let cur = to;
  let merges = 0;
  while (cur !== from) {
    if (merges >= MAX_STEPS) return { ok: false, why: `more than ${MAX_STEPS} commits since ${short(from)}` };
    const line = git(cwd, ['log', '-1', '--format=%P%x00%T', cur]).out.split('\x00');
    const parents = (line[0] || '').split(' ').filter(Boolean);
    if (parents.length !== 2) return { ok: false, why: `${short(cur)} is a commit of its own, not a merge of main` };
    if (git(cwd, ['merge-base', '--is-ancestor', parents[1], base]).status !== 0) return { ok: false, why: `${short(cur)} merges ${short(parents[1])}, which is not on main` };
    const m = git(cwd, ['merge-tree', '--write-tree', parents[0], parents[1]]);
    if (m.status !== 0 || m.out.split('\n')[0] !== line[1]) return { ok: false, why: `merge ${short(cur)} adds changes of its own` };
    merges += 1;
    cur = parents[0];
  }
  const a = patchId(cwd, base, from);
  const b = patchId(cwd, base, to);
  if (!a || !b) return { ok: false, why: 'the pull request\'s change could not be read' };
  if (a !== b) return { ok: false, why: `the pull request's own change differs (patch ${short(a)} at ${short(from)}, ${short(b)} at ${short(to)})` };
  return { ok: true, merges, patch: a };
}

// The owner's state at `head`, from the receipts (newest first).
function ownerState({ cwd, base, head, receipts }) {
  const exact = receipts.find((r) => r.head === head);
  if (exact) return { state: 'owner_override', receipt: exact };
  const why = [];
  for (const r of receipts) {
    const c = carriesOver(cwd, { from: r.head, to: head, base });
    if (c.ok) return { state: 'owner_override', receipt: r, carried: { from: r.head, merges: c.merges, patch: c.patch } };
    why.push(`${short(r.head)}: ${c.why}`);
  }
  if (receipts.length) return { state: 'invalidated', reviewed: receipts[0].head, why };
  return { state: 'missing' };
}

// Why a review of an earlier head covers this one, in words.
const carriedWords = (c) => `${c.merges === 1 ? 'the one commit since merges main and adds nothing of its own' : `the ${c.merges} commits since merge main and add nothing of their own`}, and the pull request's own change is the same patch (${short(c.patch)})`;
const receiptWords = (r) => (r.kind === 'comment' ? `comment ${r.id}` : `approving review ${r.id}`) + (r.at ? ` at ${r.at}` : '');
const HOW = (head) => `To review this head yourself, comment on the pull request exactly:\n\n\`\`\`\n/reviewed ${head}\n\`\`\`\n\nor approve the pull request at this head (an approval is picked up within 30 minutes). A review names one exact head; a later push needs its own, except a merge of main that leaves the change's own patch the same.`;

// The agent-review check body for an owner state: neutral for an override,
// action_required otherwise. `model` names what a model said, if anything.
function stateCheck({ head, st, owner, runUrl, model = null, ignored = [] }) {
  const note = ignored.length ? `\n\nNot counted: ${ignored.map((i) => `comment ${i.id} (${i.why})`).join('; ')}.` : '';
  const after = model ? `\n\n${model}` : '';
  if (st.state === 'owner_override') {
    const r = st.receipt;
    const title = st.carried ? `Owner override: carried over from ${short(st.carried.from)}` : `Owner override: ${owner} reviewed ${short(head)}`;
    const carried = st.carried ? ` That review covers ${short(head)}: ${carriedWords(st.carried)}.` : '';
    return { conclusion: 'neutral', title, summary: `${owner} reviewed ${st.carried ? short(st.carried.from) : 'this head'} himself (${receiptWords(r)}).${carried} Nothing was merged or approved by this check.${after}${note}` };
  }
  if (st.state === 'invalidated') {
    return { conclusion: 'action_required', title: `Invalidated by a new commit: ${owner} reviewed ${short(st.reviewed)}, the head is ${short(head)}`, summary: `${owner}'s review does not cover this head: ${st.why.join('; ')}.${after}\n\n${HOW(head)}${note}` };
  }
  return { conclusion: 'action_required', title: `Missing: no review of ${short(head)}`, summary: `No review of this head is on record.${after}\n\n${HOW(head)}${note}` };
}

module.exports = { REVIEWED_RE, receiptsOf, patchId, carriesOver, ownerState, stateCheck, carriedWords, HOW };
