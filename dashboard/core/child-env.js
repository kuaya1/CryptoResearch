'use strict';
// Law 1 (docs/CONSTITUTION.md Part 1; Stage 1.5, PR B1): merge authority and
// credential bypasses are never delegated to an autonomous loop, so a GitHub
// credential in this process's environment does not pass to a child it starts.
//
// This closes the environment path only. A stored `gh` login (the system
// keyring, or a file under the profile) is reachable by any process running as
// the same user, whatever its environment holds. `readGithubAccess` measures
// that and says so; nothing here can remove it.

const { spawnSync } = require('child_process');

const REPO = 'kuaya1/CryptoResearch';
const GH_TIMEOUT_MS = 8000;

const NAMES = new Set(['GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK']);
const SHAPES = [/(^|_)(GH|GITHUB)_(.*_)?(TOKEN|PAT|SECRET|PASSWORD|PRIVATE_KEY)$/, /^ACTIONS_.*TOKEN$/];
const DESK_READER = 'CR_GITHUB_TOKEN';

// Any case: Windows environment names are not case-sensitive. CR_GITHUB_TOKEN
// is not one of these: it is the desk's own optional reader for the forensic
// monitor, kept for the desk's commands and never on a session's allowlist.
function isGithubCredentialName(name) {
  const u = String(name).toUpperCase();
  if (u === DESK_READER) return false;
  return NAMES.has(u) || SHAPES.some((re) => re.test(u));
}

function withoutGithubCredentials(parent = process.env) {
  const out = {};
  for (const k of Object.keys(parent)) if (!isGithubCredentialName(k)) out[k] = parent[k];
  return out;
}

// Fixed words only: gh's own output is classified, never repeated.
function readAccess(env, run) {
  const unknown = (why) => ({ auth: 'unknown', admin: null, why });
  let r;
  try {
    r = run('gh', ['api', `repos/${REPO}`, '--jq', '.permissions.admin'], { env: { ...env, GH_PROMPT_DISABLED: '1' }, encoding: 'utf8', timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch (_) { return unknown('gh did not run'); }
  if (!r) return unknown('gh did not answer');
  if (r.error) return unknown(r.error.code === 'ENOENT' ? 'gh is not installed' : r.error.code === 'ETIMEDOUT' ? 'gh timed out' : 'gh did not run');
  if (r.status === 4) return { auth: 'none', admin: null, why: 'gh is not signed in' };
  if (r.status === 0) {
    const said = String(r.stdout || '').trim();
    if (said === 'true' || said === 'false') return { auth: 'available', admin: said === 'true', why: null };
    return unknown('GitHub did not state a permission');
  }
  if (/HTTP 401|Bad credentials/i.test(String(r.stderr || ''))) return { auth: 'none', admin: null, why: 'GitHub rejected the credential' };
  return unknown('GitHub could not be read, which is expected offline');
}

const MARK = 'cr-credential-probe-not-a-token';
function holdsCredential(env) {
  return Object.keys(env).some((k) => isGithubCredentialName(k) || env[k] === MARK);
}

// What this shell holds and what its children would get. `sessionEnv` is the
// runner's own builder, so this reads the code that runs. `network: false`
// makes no GitHub read, and nothing here can throw on a failed one.
function readGithubAccess({ env = process.env, run = spawnSync, sessionEnv, deskEnv = withoutGithubCredentials, network = true } = {}) {
  const marked = { ...env, GH_TOKEN: MARK, GITHUB_TOKEN: MARK, gh_token: MARK };
  const notRead = { auth: 'not_read', admin: null, why: 'not read in a test or demo workspace' };
  const shell = network ? readAccess(env, run) : notRead;
  // Offline, a second read would only wait out another timeout.
  const session = !network ? notRead : shell.auth === 'unknown' ? { ...shell } : readAccess(sessionEnv(env), run);
  return {
    format: 'cr-github-access@1',
    repo: REPO,
    shell_token_names: [...new Set(Object.keys(env).filter(isGithubCredentialName).map((k) => k.toUpperCase()))].sort(),
    desk_reader_token: Object.keys(env).some((k) => k.toUpperCase() === DESK_READER),
    children_exclude: { session: !holdsCredential(sessionEnv(marked)), desk_command: !holdsCredential(deskEnv(marked)) },
    shell,
    session,
  };
}

// One doctor line, in words. A leak is a failure. A stored login that a child
// can still use is a warning: it is the true state of Law 1 on this machine.
// Anything unread is information, so an offline doctor never fails on it.
function credentialLine(a) {
  const clean = a.children_exclude.session && a.children_exclude.desk_command;
  const authWords = { available: 'available', none: 'none', unknown: 'unknown', not_read: 'not read' }[a.shell.auth];
  const adminWords = a.shell.admin === true ? 'yes' : a.shell.admin === false ? 'no' : 'unknown';
  const parts = [
    `GitHub auth in this shell: ${authWords}${a.shell.why ? ` (${a.shell.why})` : ''}.`,
    `Admin on ${a.repo}: ${adminWords}.`,
    `Token variables in this shell: ${a.shell_token_names.length ? a.shell_token_names.join(', ') : 'none'}.`,
    clean ? 'Child environments exclude them: yes, checked with a marker on the session and desk-command builders.' : `Child environments exclude them: NO (session ${a.children_exclude.session ? 'clean' : 'leaks'}, desk command ${a.children_exclude.desk_command ? 'clean' : 'leaks'}).`,
  ];
  if (a.desk_reader_token) parts.push('CR_GITHUB_TOKEN is set; the desk\'s commands keep it for the forensic monitor, and sessions do not get it.');
  // Only with a clean builder can the session's read be put down to the stored
  // login; a leak is already the failure this line reports.
  if (clean && a.session.admin === true) parts.push('A process with a session\'s environment still reached admin, through the stored gh login. Removing variables cannot stop that, so Law 1 is procedural on this machine.');
  else if (clean && a.session.auth === 'available') parts.push('A process with a session\'s environment can still read GitHub through the stored gh login, without admin.');
  return { ok: clean, level: !clean ? 'fail' : a.session.admin === true ? 'warn' : 'info', detail: parts.join(' ') };
}

module.exports = { REPO, GH_TIMEOUT_MS, isGithubCredentialName, withoutGithubCredentials, readGithubAccess, credentialLine };
