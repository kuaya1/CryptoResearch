'use strict';
// What `node dashboard/cli.js test` (the one required check) exits with.
//
// The command finds every *.test.js in dashboard/tests, and in tests/sim when
// it exists, and starts them on one `node --test` command with GitHub
// credentials kept out of the child (cli.js; core/child-env.js). None of that
// is here or changed. This module only decides the exit code, because a run
// that started no test is never a pass (2026-11-10).
//
// Before this, the command's exit code was the launch's `status` as it came,
// and a launch that never happened has none: the command exited 0 in a tenth
// of a second with nothing printed. On Windows a checkout in a long folder
// path reaches that, because the program and every test file go on one
// command line of at most 32,767 characters (ENAMETOOLONG). So:
// - no test file found: exit 1, no launch (with an empty list the runner
//   would go looking for tests of its own from the working folder);
// - started from inside another test run (NODE_TEST_CONTEXT is set, as it is
//   in every process `node --test` starts): exit 1, no launch. There the
//   runner starts no file, warns of recursion and exits 0;
// - the launch failed (the operating system's error): exit 1;
// - the runner ended without an exit status (stopped by a signal): exit 1;
// - otherwise the runner's own exit code, unchanged.
// Each failure says why, in words the command prints on stderr.

const WINDOWS_COMMAND_LINE_MAX = 32767;

// Why the suite is not launched at all, as { code, words }; null when it is.
function refusal(files, env = process.env) {
  if (!files.length) return { code: 1, words: 'No test file (*.test.js) was found, so no test ran. That is a failure, never a pass.' };
  if (env.NODE_TEST_CONTEXT !== undefined) return { code: 1, words: `The suite was started from inside another test run (NODE_TEST_CONTEXT is set). There node --test starts none of the ${files.length} test files and still exits 0, so nothing is launched. Run it from a plain shell.` };
  return null;
}

// The command's exit code from what the launch returned (spawnSync's result).
function outcome(files, r) {
  if (r && r.error) {
    const code = r.error.code || 'error';
    const long = code === 'ENAMETOOLONG' || code === 'E2BIG'
      ? ` The command line that names all ${files.length} test files is too long for this system (Windows allows ${WINDOWS_COMMAND_LINE_MAX} characters). Run the suite from a checkout in a shorter folder path.`
      : '';
    return { code: 1, words: `The test runner could not be started (${code}), so no test ran. That is a failure, never a pass.${long}` };
  }
  if (!r || !Number.isInteger(r.status)) return { code: 1, words: `The test runner ended without an exit status${r && r.signal ? ` (signal ${r.signal})` : ''}, so the suite did not finish. That is a failure, never a pass.` };
  return { code: r.status, words: null };
}

module.exports = { WINDOWS_COMMAND_LINE_MAX, refusal, outcome };
