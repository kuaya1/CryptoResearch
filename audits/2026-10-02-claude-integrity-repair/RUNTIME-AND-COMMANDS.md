# Runtime and commands

## Runtime

- **Machine:** Windows 11 Home 10.0.26300, host DESKTOP-IILMFLP.
- **Node:** v24.21.0 through Volta (`volta run --node 24.21.0 node …`), the version `package.json` pins. No npm dependencies were added.
- **Browser:** Claude desktop built-in browser, Chrome/152.0.7977.130 (embedded Chromium).

## Folders

| Folder | Purpose |
|---|---|
| `%TEMP%\crfix\baseline` | Immutable copy of the audited code. Source files are read-only. Demo workspace ID `ws_crfixbase01`. |
| `%TEMP%\crfix\dev` | The repaired copy. Demo workspace ID `ws_crfixdev01`. |
| `%TEMP%\crfix\red` | Writable copy of the original code with the new tests added, to show which tests fail there. |
| `%TEMP%\crfix\browser-ws-dev`, `browser-ws-base` | Fictional demo workspace copies for the browser check. IDs `ws_crfixbrowserdev` and `ws_crfixbrowserbase`. |
| Test workspaces | Created per test under `%TEMP%` (`cr-test-*`, `cr-restore-*`, `cr-rollback-*`) and deleted by the tests. |

**Test ports:**
- 47000–49000: tests.
- 4941: repaired-code browser server.
- 4942: original-code browser server.
- 4729, the real dashboard's port, was never used.

## Commands

All commands run from `%TEMP%\crfix` unless noted. `GUARD` means `NODE_OPTIONS=--require fixtures/no-network-guard.cjs`, which refuses any non-loopback fetch and logs it. No refusals were logged in any run.

| Purpose | Command |
|---|---|
| Fingerprint of the real folder at the start (read only) | `node fixtures/fingerprint.cjs C:\Users\Kuaya\Documents\CryptoResearch --list …\audits\2026-10-01-codex-system-review-v2\source-target.json` → `9ff79de7…`, 70 files, `matches_target: true` |
| Isolated copies | `node fixtures/setup-isolated.cjs` (refuses existing targets) |
| Full suite, repaired | GUARD `node dev/dashboard/cli.js test` → 144/144, twice |
| Full suite, original | GUARD `node baseline/dashboard/cli.js test` → 109/109 |
| New tests on the original code | `node fixtures/make-red-copy.cjs`, then in `red/dashboard`: GUARD `node --test tests/integrity-reads.test.js tests/integrity-restore.test.js tests/research-attempts.test.js tests/research-spend.test.js tests/live-updates.test.js` → 32 fail, 3 pass (`python fixtures/summarize-red.py` builds the table) |
| Cross-version rollback | GUARD `node fixtures/rollback-crossversion.cjs evidence/rollback-crossversion.json` (`fixtures/summarize-rollback.cjs` prints it) |
| Copies of the real records | GUARD `node fixtures/realcopy-check.cjs C:\Users\Kuaya\Documents\CryptoResearch evidence/realcopy-check.json` (reads the real folder; deletes its copies) |
| Rollback copy | `node fixtures/make-rollback-copy.cjs C:\Users\Kuaya\Documents\CryptoResearch C:\Users\Kuaya\Documents\CryptoResearch-recovery 9ff79de7… <dev> <baseline>` |
| Rollback drill | the `ROLLBACK.md` commands with `$ws` set to a scratch copy of the repaired code, then `verify-fingerprint.cjs` → `matches: true` |
| Patch | `node fixtures/scope-tree.cjs baseline patchtree/a`, `… dev patchtree/b`, then in `patchtree`: `git diff --no-index --no-prefix --binary a b > integrity-repair.patch` |
| Patch check | a copy of `patchtree/a`, then `git apply -p1 integrity-repair.patch`, then `node fixtures/fingerprint.cjs <copy>` → `4ce11b80…`, 77 files (the repaired aggregate) |
| Fingerprints | `node fixtures/fingerprint.cjs <root> --out evidence/fingerprint-<name>.json`; `node fixtures/fp-summary.cjs evidence` |

## Browser check

- **Server:** `fixtures/serve-instrumented.cjs <codeRoot> <workspace> <port> <statsFile>`. It uses the review's counting method and refuses a real workspace.
- **How it was started:** through two temporary entries in `.claude/launch.json` (`crfix-dev`, `crfix-base`). The file was restored to its original bytes afterwards (sha256 `6610c708…0a30`; the original is in `evidence/launch.json.before`).
- **Measurement:** request windows were measured with `fixtures/measure-window.cjs`.
- **Fictional paid-attempt states for the screenshots:** `fixtures/demo-uncertain-run.cjs` (demo workspace copy only).
- **Afterwards:** both servers were stopped and nothing listened on 4941 or 4942.
