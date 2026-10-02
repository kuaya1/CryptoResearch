# Commands and versions

Run on 2026-10-02 in Git Bash under Claude Code, on Windows 11 Home 10.0.26300.9550 with NTFS on C:.

| Tool | Version |
|---|---|
| Node | v24.21.0 through Volta 2.0.2 (Undici 7.29.1, V8 13.6.233.17-node.53) |
| Git | 2.55.0.windows.4; the system config sets `core.autocrlf=true` |
| Python | 3.12, used for summaries only |
| Browser | Claude desktop built-in Chromium 152.0.7977.130 |

Every Node command ran as `volta run --node 24.21.0 node …`. Test and check processes also had the network guard loaded:

```
NODE_OPTIONS="--require $WORK/tools/no-network-guard.cjs" CR_GUARD_LOG="$WORK/evidence/network-guard.log"
```

The guard refuses any non-loopback `fetch` and logs it. No log file was ever created, so nothing was refused.

The commands use these shorthands:

| Shorthand | Folder |
|---|---|
| `LIVE` | `%USERPROFILE%\Documents\CryptoResearch` |
| `RC` | `%TEMP%\cr-rc` |
| `WORK` | `%TEMP%\cr-rc-work` |
| `R2` | `$LIVE/audits/2026-10-02-claude-integrity-repair-r2` |
| `REC` | `%USERPROFILE%\Documents\CryptoResearch-recovery\20261002T164934Z-pre-integrity-repair-code` |

The scripts in `tools/` are the versions used. `f1-repro.cjs`, `fingerprint.cjs`, `long-check.cjs`, `rollback-capture.cjs` and `preserve-mtime.cjs` are round 2's, unchanged. `serve-instrumented.cjs` and `measure-window.cjs` are round 1's.

## Clone, branch, round 2 commit

```
git clone --no-hardlinks -q "$LIVE" "$RC"
git -C "$RC" remote set-url --push origin PUSH-DISABLED-rc-clone
git -C "$RC" switch -c rc/integrity-r2
git -C "$RC" apply -p1 --check "$R2/integrity-repair-r2.patch"   # printed nothing
git -C "$RC" apply -p1 "$R2/integrity-repair-r2.patch"           # printed nothing
node "$WORK/tools/fingerprint.cjs" "$RC"                         # 59fef28a..., 81 files
git -C "$RC" add -A dashboard
git -C "$RC" commit -F commit-r2.txt                             # 1cc9fee
node tools/git-fingerprint.cjs "$RC" <rev>                       # fingerprint of a committed tree
```

## Full suite

```
cd "$RC" && node dashboard/cli.js test > evidence/suite-rc-windows-run1.txt     # then run2; 1cc9fee: 157/157 twice
cd "$RC" && node dashboard/cli.js test > evidence/suite-rc-665439b-windows-run1.txt   # then run2; 665439b: 160/160 twice
```

`suite-a840ba7-windows.txt` (109/109) was run in the clone before the branch was created.

## Red checks

Two scratch trees were prepared. On the RC checkout, `dashboard/tests` is `dashboard\tests`.

```
git -C "$RC" worktree add --detach "$WORK/red-a840ba7" a840ba7
#   plus the 7 new test files and 3 children, copied from rc/integrity-r2
node tools/scope-tree.cjs <round 1 tree> "$WORK/red-r1"
#   round 1, 4ce11b80, 77 files; plus templates and round 2's research-capture,
#   provider-transport and research-attempts tests, child-lock-holder and child-research-runner
```

Then, inside each tree's `dashboard` folder:

```
cd $WORK/red-a840ba7/dashboard && node --test tests/integrity-reads.test.js tests/integrity-restore.test.js \
  tests/live-updates.test.js tests/research-attempts.test.js tests/research-spend.test.js \
  tests/research-capture.test.js tests/provider-transport.test.js
cd $WORK/red-r1/dashboard && node --test tests/research-capture.test.js tests/research-attempts.test.js tests/provider-transport.test.js
python summarize-red.py <output> <summary>
```

- **Round 2's tests on `a840ba7`:** 48 tests, 44 fail, 4 pass.
- **Round 2's tests on round 1:** 21 tests, 13 fail, 8 pass.
- **The same red check with the final test files from `665439b`, on `a840ba7`:** `evidence/red-new-tests-665439b-on-a840ba7-windows.txt`.

For the fixes, each test was run on the commit before its fix, using the final test code:

```
git -C "$RC" worktree add --detach "$WORK/red-fix-<rev>" <rev>      # 1cc9fee, 242a098, c9b75b8
git -C "$RC" show rc/integrity-r2:dashboard/tests/research-capture.test.js > .../tests/research-capture.test.js
git -C "$RC" show rc/integrity-r2:dashboard/tests/children/child-research-runner.js > .../tests/children/child-research-runner.js
node --test --test-name-pattern="<EISDIR | read back | during recovery>" tests/research-capture.test.js
```

## Windows checks

```
node tools/f1-repro.cjs "$RC"                          # evidence/f1-repro-rc-windows.json; 665439b: f1-repro-rc-665439b-windows.json
node tools/lock-probe.cjs "$WORK/lockprobe" evidence/windows-lock-probe.json
node tools/errno-probe.cjs evidence/windows-errno-probe.json
node tools/capture-adverse.cjs "$RC" evidence/capture-adverse-rc-windows.json        # 1cc9fee: L1-L3, S1-S7
node tools/capture-adverse.cjs "$RC" evidence/capture-adverse-rc-665439b-windows.json
cd "$RC" && node --test --test-reporter=spec dashboard/tests/integrity-restore.test.js   # evidence/integrity-restore-ntfs-windows.txt
node tools/long-check-rc.cjs "$RC" 320                 # evidence/f2-long-check-rc-windows.json (run in the background, 5 min 20 s)
```

**Capture cases.** In the `S` cases, a real PowerShell process holds the file:

```
[System.IO.File]::Open(<file>, 'Open', 'Read', '<FileShare>')
```

The `L` cases make `fs.linkSync` fail in the runner (`tools/capture-hooks.cjs`, loaded with `--require`).

## Rollback drill (scratch copy)

```
node tools/rollback-drill.cjs "$WORK/drill" "$RC" "$REC" "$R2/integrity-repair-r2.patch" evidence/rollback-drill-windows.json
DRILL_APPLY=plain node tools/rollback-drill.cjs ... evidence/rollback-drill-windows-run1-plain-git-apply-crlf.json   # (as first run, W3)
DRILL_EXPECT_FP=92af2c94... node tools/rollback-drill.cjs "$WORK/drill" "$RC" "$REC" rc-integrity-r2-windows-full.patch evidence/rollback-drill-rc-665439b-windows.json
```

The rollback step runs round 1's documented commands, plus round 2's four extra files:

```powershell
robocopy "$rec\dashboard" "$ws\dashboard" /E /NJH /NJS /NDL /NFL
Copy-Item "$rec\package.json" "$ws\package.json" -Force
<11 added files> | ForEach-Object { Remove-Item (Join-Path $ws $_) -ErrorAction SilentlyContinue }
node "$rec\verify-fingerprint.cjs" "$ws"
```

The roll-forward step runs `git -c core.autocrlf=false apply -p1 <patch>`. Under `DRILL_APPLY=plain` it runs plain `git apply`.

In `rollback-drill-rc-665439b-windows.json` the step's label still reads "integrity-repair-r2.patch", because it is fixed text in the script. Its `command` field shows the patch that was actually applied, `rc-integrity-r2-windows-full.patch`.

Then, with each code version:

```
node dashboard/cli.js research run --json --workspace <scratch>
node dashboard/cli.js job run --all-due --trigger scheduler --workspace <scratch>
node dashboard/cli.js doctor --json --workspace <scratch>
```

## CRLF reproduction (W3)

```
git -C "$RC" archive --format=tar a840ba7 dashboard package.json templates | tar -x -f - -C "$WORK/crlf-check"
cd "$WORK/crlf-check" && git apply -p1 "$R2/integrity-repair-r2.patch"    # outside any repository
node tools/fingerprint.cjs "$WORK/crlf-check"                              # b17ce373..., 81 files
node dashboard/cli.js test                                                 # 157/157
```

## Browser check (criterion 2d)

**Code and workspaces:**

- Code came from `git archive` of `rc/integrity-r2` (then `1cc9fee`) and of `a840ba7`, into `$WORK/browser/code-rc` and `code-base`.
- The workspaces were two copies of `$LIVE/dashboard/demo-workspace` (fictional), without `.cr`, with workspace IDs set to `ws_rcbrowserrc` and `ws_rcbrowserbase`.

**Temporary launch entries.** Two entries were added to `$LIVE/.claude/launch.json`, after saving the original bytes:

```
volta run --node 24.21.0 node serve-instrumented.cjs <code> <workspace> <port> <stats.json>   # ports 4951 (RC), 4952 (baseline)
```

The servers were started with the browser pane's `preview_start`.

**Repaired code (port 4951):**

- Eight tabs were opened on `http://localhost:4951/`. Each was forced visible with:

  ```js
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
  document.dispatchEvent(new Event('visibilitychange'))
  ```

- The traffic was measured with `measure-window.cjs stats-rc.json 20 evidence/browser-rc-8-visible-window.json`.
- In-app navigation and API fetches (`/api/session`, `/api/index`, `/api/projects/<id>`) were timed in the eighth tab.
- A CLI change was made during a 10 s window:

  ```
  node code-rc/dashboard/cli.js project reviewed example-game-fictional --workspace ws-rc
  ```

**Baseline (port 4952):**

- Six tabs were opened on `http://localhost:4952/`.
- From the first tab, `fetch('/api/health', {signal: AbortSignal.timeout(8000)})` was run.
- The seventh window was started from a 4951 page with `location.href = 'http://localhost:4952/'`.
- Server counts were read 15 s and 53 s later. One baseline tab was then closed and the counts read again.

**Cleanup:** both servers stopped, all tabs closed, and `launch.json` restored from the saved bytes (sha256 `6610c708…0a30`). See `evidence/cleanup-windows.txt`.

## Fix commits, patches, bundle

```
git -C "$RC" commit -F commit-fix-A.txt     # 242a098
git -C "$RC" commit -F commit-fix-B.txt     # c9b75b8
git -C "$RC" commit -F commit-fix-C.txt     # 665439b
git -C "$RC" -c core.autocrlf=false diff --binary a840ba7 rc/integrity-r2 > evidence/rc-integrity-r2-windows-full.patch
git -C "$RC" -c core.autocrlf=false diff --binary 1cc9fee rc/integrity-r2 > evidence/rc-windows-fixes-on-r2.patch
git -C "$RC" bundle create evidence/rc-integrity-r2.bundle a840ba7..rc/integrity-r2
git -C "$RC" bundle verify evidence/rc-integrity-r2.bundle
```

## Privacy scan

```
node tools/privacy-scan.cjs "$LIVE" "$RC" a840ba7 rc/integrity-r2 evidence/privacy-scan-branch-diff.json [files proposed for Git ...]
```

The positive control planted a project ID, a fake key pattern and an EVM-style address in a scratch file. All three were flagged; the file was then deleted.

## Review preparation (after validation)

One more shorthand: `REVIEW` = `%USERPROFILE%\Documents\CryptoResearch-review\rc-integrity-r2`.

**Preserve the branch in the CryptoResearch repository, without a checkout.** The branch ref was already present when this preparation started. It came from the fetch below, recorded in the branch's reflog at 20:35 UTC:

```
git -C "$LIVE" fetch --no-tags "$RC" refs/heads/rc/integrity-r2:refs/heads/rc/integrity-r2
```

**Verify the commit.** All three must print `665439b494a7486f6037688e7a727dcbb00fbaf0`:

```
git -C "$RC" rev-parse rc/integrity-r2
git -C "$RC" bundle list-heads evidence/rc-integrity-r2.bundle
git -C "$LIVE" rev-parse rc/integrity-r2
```

**Create the separate worktree.** The live folder stays on `main` and is not checked out:

```
git -C "$LIVE" worktree add "$REVIEW" rc/integrity-r2
```

**Fingerprint, from the checkout and from the commit.** Both give `92af2c94…` (81 files), and every file is LF:

```
node tools/fingerprint.cjs "$REVIEW"
node tools/git-fingerprint.cjs "$LIVE" 665439b494a7486f6037688e7a727dcbb00fbaf0
git -C "$REVIEW" ls-files --eol dashboard package.json
```

**Allowlist.** Add the five `!/audits/2026-10-02-rc-integrity-r2-windows/<file>` lines to `.gitignore`, then check them. The five reports are re-included, while `evidence/` and `tools/` stay ignored by `/audits/*/*`:

```
git -C "$REVIEW" check-ignore -v --no-index <paths>
```

**Documentation commits:**

- `63b60f17449db86a7a25aa994a263c4ca68f87b5` adds the five reports as produced by the validation, plus the allowlist lines.
- The next commit adds the current deployment and rollback instructions, the design notes and test basis in REVIEW, and corrections W3 and W4. It also marks round 2's checklist as superseded.

**Checks for those changes:**

```
git -C "$REVIEW" diff --stat 665439b494a7486f6037688e7a727dcbb00fbaf0 HEAD -- dashboard package.json    # empty
node tools/git-fingerprint.cjs "$LIVE" HEAD                                                             # 92af2c94..., 81 files
cd "$REVIEW" && node dashboard/cli.js test        # 160/160, evidence/suite-review-worktree-windows.txt (local)
```

- **Line endings and control characters:** a byte-level check of the five reports and `.gitignore` found no CR or other control characters.
- **Privacy:** `node tools/privacy-scan.cjs "$LIVE" "$REVIEW" a840ba7 HEAD <out> <the five reports>`, plus reading the complete branch diff and the commit metadata.

**Push and draft pull request.** The account is `kuaya1`; the repository is private. The push uses the existing GitHub CLI sign-in:

```
git -C "$REVIEW" -c credential.helper= -c "credential.helper=!gh auth git-credential" push origin rc/integrity-r2
gh pr create --repo kuaya1/CryptoResearch --draft --base main --head rc/integrity-r2 --title "..." --body-file <body>
```

## Spend-log fix (R8) and tracked round-2 reports

**Failure injection.** The runner child now accepts `crash: { op: 'research_response', when: 'fail_after_build' }`: it runs that operation's build step, which appends the spend-log line, then fails the save. Two regressions in `research-capture.test.js` use it.

```
cd "$REVIEW/dashboard" && node --test --test-name-pattern="spend log" tests/research-capture.test.js
#   before the fix (working tree): evidence/fix-D-red-before-fix.txt, 2 actual lines for one attempt
git -C "$LIVE" worktree add --detach <scratch> 33e72304fbc2256af944dcd0cb97792655d1a606
#   + the final research-capture.test.js and child-research-runner.js copied in
cd <scratch>/dashboard && node --test --test-name-pattern="spend log" tests/research-capture.test.js
#   evidence/fix-D-red-final-tests-on-33e7230.txt: 2 fail ("2 !== 1"); the scratch worktree was removed afterwards
```

**After the fix:**

```
cd "$REVIEW/dashboard" && node --test tests/research-capture.test.js tests/research-spend.test.js tests/research-attempts.test.js tests/research.test.js
#   41/41, evidence/fix-D-green-after-fix.txt
cd "$REVIEW" && node dashboard/cli.js test        # 162/162 twice: evidence/suite-ledger-fix-windows-run{1,2}.txt
git -C "$REVIEW" commit ...                        # 10143c8a200257008adc06832119a38a76579524
node tools/git-fingerprint.cjs "$REVIEW" HEAD      # 6db60f39..., 81 files
node tools/capture-adverse.cjs "$REVIEW" evidence/capture-adverse-ledger-fix-windows.json
node tools/f1-repro.cjs "$REVIEW"                  # evidence/f1-repro-ledger-fix-windows.json
git -C "$LIVE" -c core.autocrlf=false diff --binary a840ba7 10143c8a200257008adc06832119a38a76579524 -- dashboard package.json > rc-10143c8-code.patch
DRILL_EXPECT_FP=6db60f39... node tools/rollback-drill.cjs <drill dir> "$LIVE" "$REC" rc-10143c8-code.patch evidence/rollback-drill-ledger-fix-windows.json
```

**Local drafts preserved before tracking.** The five RC report drafts and round 2's six reports were copied from the live folder, as they were, to `evidence/preserved-local-drafts-2026-10-02/`, with `MANIFEST.sha256`. That folder is ignored by Git, so no merge or checkout replaces it.

**Round 2's reports.** `README.md`, `RESULTS.md`, `LIMITS.md`, `DEPLOY-CHECKLIST.md`, `DOC-CHANGES-PROPOSED.md` and `RUNTIME-AND-COMMANDS.md` were copied into the review worktree and changed in three ways:

- The PC's name is replaced by "Eric's PC" (it was in three files).
- `DEPLOY-CHECKLIST.md` gets a **SUPERSEDED** note at its top, linking to the current deployment and rollback instructions.
- `README.md` gets a historical-status note.

Those six paths are allowlisted. Round 2's patches, evidence and tools stay ignored.
