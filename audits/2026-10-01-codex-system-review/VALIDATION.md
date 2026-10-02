# Validation record

October 1, 2026 · Windows PowerShell · all intentional record/job mutations in synthetic workspaces beneath this audit folder

## Environment and scope

Actual root, marker, executable, PID/port and scheduler details are retained in [runtime-and-schedule.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/runtime-and-schedule.json). Node was 20.20.2. The task XML is saved before and after inspection. No AGENTS.md was found at the workspace, applicable ancestors or within inspected descendants. CLAUDE.md, COWORK-INSTRUCTIONS, README, WORKSPACE-MAP, settings, schemas, all grading/profile rubrics, shared and sector prompts, core modules, browser views/styles and relevant tests were read. The user's audit-only preservation instruction governed conflicting operational advice such as running a real write-test doctor.

Browser and current OpenAI documentation skills were used. Browser work used the in-app browser's supported Node REPL runtime, DOM/Playwright-like controls, viewport emulation, snapshots, console and screenshots. No Chrome-profile access, actual Cowork session, microphone test or external message sending occurred.

## Commands and executable evidence

Working directory for these commands: `C:\Users\Kuaya\Documents\CryptoResearch`.

| Command / operation | Result and artifact |
|---|---|
| `node dashboard/cli.js test` | Exit 0; 59 pass, 50 top-level, 0 fail/cancel/skip/todo, about 2.03 s. Full TAP output: `baseline-tests.txt`. |
| `node audits/2026-10-01-codex-system-review/setup-isolated.cjs` | Created fictional demo and empty test roots; read the real workspace with recovery disabled and saved index/runtime/schedule evidence. No real record/job mutation. |
| `node dashboard/cli.js doctor --workspace audits/2026-10-01-codex-system-review/isolated-demo` | Doctor's write/readback check and index validation in demo; saved `isolated-doctor.json`. Its green scheduler check is inaccurate for that root (F19). |
| `node audits/2026-10-01-codex-system-review/reproduce.cjs` | Initial harness run stopped on a wrong expected raw-report filename (`original.json` instead of the application's `original.md`); retained `probe-console.txt`. Harness corrected, fresh namespace used, rerun exit 0 with 24 named results in `probe-results.json` / `probe-console-v2.txt`. |
| `node audits/2026-10-01-codex-system-review/supplemental.cjs` | Exit 0; five additional results in `supplemental-results.json` / `supplemental-console.txt`. Includes two truly concurrent child writers and the valid PDF fixture. |
| `node audits/2026-10-01-codex-system-review/state-fixtures.cjs` | Created synthetic unpriced/stale/failure states; `state-fixture-results.json`. No forced outage against the live provider. |
| Isolated server configuration | Same CLI entry point, `serve --workspace <isolated-demo> --port 4829` and `serve --workspace <isolated-empty> --port 4849`. Test instances only. Empty server was stopped/restarted during persistence check; `restart-check.json` records changed PID and persisted data. |
| Restore/hash reconciliation | Scripted clean restore and explicit readback of raw original/correction/balances; `probe-results.json` and `restore-extra-check.json`. |
| Preservation check | SHA-256 inventories before/after outside `audits/`, task XML comparison; `preservation-check.json`. |
| Live health observation | Original PID 34464 remained listening at `127.0.0.1:4729`, same workspace marker, healthy after isolated-server cleanup. Real server/task were never stopped or reconfigured. |

The server configurations above describe the tested CLI arguments; launch/process inspection was also used to verify the processes before cleanup. Only the isolated PIDs whose command lines matched the audit roots/ports were stopped. Both browser tabs were closed and the viewport override reset.

For a fresh repeat of the primary probes, use a **new unused namespace**:

```powershell
node audits/2026-10-01-codex-system-review/reproduce.cjs probes-repeat-01
```

The script refuses to reuse an existing fixture root. Its output JSON filename is fixed, so copy the script/output to a separate review folder if preserving this original audit's evidence. `supplemental.cjs` also refuses existing supplemental roots and additionally writes the demo PDF fixture; do not blindly rerun it. It is a reproduction source, not an idempotent maintenance job. Queue child exit 77 is intentional; it demonstrates an application crash interval. The scripts assert isolation by constructing synthetic roots, but inspect them before reuse in a different directory layout.

## Functional and data checks

| Area | Verified result | Limits |
|---|---|---|
| Existing test suite | Scoring/ranges/coverage, reports, project identity, dates, ordinary FIFO/fees/unknown basis/transfers, market mocks, staged operations, API host/origin/token/traversal/live refresh/restart passed | No numerical coverage report. Nine `.test.js` files; `helpers.js` is not a test file. Passing existing tests did not cover the new counterexamples. |
| Immutable reports/corrections | Imported synthetic raw bytes retained; clean restore raw SHA-256 identical; corrected effective summary identical | Original Huma claim truth was not independently fact-checked. PDF preserves bytes but has a UI-shape defect. |
| Ordinary writer concurrency | Two simultaneous child processes, 20 journal writes each; 40 records, both exit 0 | Does not establish long-running lease safety; old live-lock counterexample fails. |
| Interrupted operation | Rename interruption after one applied file generated `APPLY_INTERRUPTED`; recovery rolled forward to new/new | Instrumented filesystem exception; not full machine power loss, disk-full sweep or hardware flush validation. |
| Reader consistency | Rename observer read new/old during two-file apply | Instrumented boundary rather than a racing independent reader; demonstrates a real visible interval in lock-free reads. |
| Request crash replay | Actual child termination after effect/before receipt; journal 1→2 after restart | Stable receipt replay alone works; the crash gap does not. |
| Import outcomes | Valid JSON/prose ingestion exercised; short import nested failed but queue done; provider-conflicting prose accepted | Structured provider mismatch is tested in baseline. No actual Cowork dictation run. |
| Portfolio | Independently expected FIFO gain/basis, transfer quantity, fee totals, dust and IDs checked; specific failures saved | Real ledger is empty; no real investment balance was altered. Broad external tax/performance-accounting conformance is unverified. |
| Research | Weights/range/withholding arithmetic passed; old/unknown rubric, comparison span/horizon, N/A and date/context probes failed | Model independence and evidence corroboration cannot be established from labels or imported scores. |
| Market | Live original status showed successful CoinGecko refresh; error mocks retain cache; invalid successful-response probes fail | Keys not inspected. Actual DEX/chain/fundamental/unlock coverage of Huma/Allora not queried. |
| Backup | Clean restored quantity 2, basis $20, raw hashes, correction and project count match; dirty restore retains later journal | Copy consistency under concurrent backup and disk-loss recovery not induced. Overlay is documented behavior, not an exact point-in-time restore. |
| Restart | Browser-created pending project and failed import survived actual empty-instance restart | Existing server tests cover SSE/restart; not a prolonged reconnect/packet-loss experiment. |

## Browser coverage

Viewport targets were **1440×1000**, **768×1024**, and **390×844**. These emulate screen widths in the PC browser; they do not verify remote phone access or touch-device hardware. All data shown was synthetic and labeled demo/test.

- Main views: Overview; Holdings & watchlist; Project research; Model comparison; Evidence & disputes; Review calendar; Imports & settings.
- Imports tabs: Import reports; Inbox & requests; Portfolio records; Settings & rubrics; Exports & backups; Privacy & schedules.
- Populated project sections: Summary; Comparison; Findings; Economics; Market; Scenarios; Reports; Journal; Prompts. Review/event and identity controls are embedded within those sections.
- States: populated demo; empty desk; pending identity/project; failed report; PDF needs-text/error; missing price; stale cached price plus provider failure; transient loading; live server connection; actual restart persistence.
- Actions: browser project creation, failed paste import, section/tab navigation, search filtering, keyboard Tab/focus, opening a PDF project's route. Other forms were inspected rather than every destructive or data-changing control being submitted.

Initial tab snapshots sometimes preceded async navigation/scroll completion. Selected-tab/heading state was checked and meaningful routes were revisited after settling; saved screenshots with `confirmed`, width-specific settled project captures and the final desktop capture are preferred. Some first-attempt PDF click/clipboard targeting did not act on the intended page/control; direct navigation and fresh snapshots established the confirmed outcome. Those automation issues are not presented as application defects.

The settled width observations were:

| View | 768 px viewport: body width | 390 px viewport: body width |
|---|---:|---:|
| Overview | 975 | 975 |
| Holdings/watchlist | 1175 | 1175 |
| Project research list | 759 | 759 |
| Model comparison | 753 | 705 |
| Evidence/disputes | 1145 | 1145 |
| Review calendar | 828 | 828 |
| Imports main content | 753 | 375 |
| Populated project, all sections present | **1280** | **1280** |

At **1440 px**, the final settled Overview had body width **1425 px** (vertical scrollbar), main left 210 and right approximately 1424.67; no main-content outside element was found in that check. Earlier provisional wording about desktop clipping was corrected. Wider tables overflowing a wrapper at a narrow width are distinct from whole-document overflow; the reported widths measure the latter.

Typography/keyboard inspection found visible native focus and functioning search. Faint text contrast was computed from measured RGB values and checked against current W3C guidance. No comprehensive WCAG, screen reader, touch interaction, dark-mode or cross-browser certification was performed. Existing score/allocation bars are readable basic bars; the app does not provide an independently verified historical price or performance chart suite.

## Representative screenshots

Prefer these captures, with their actual states:

| Capture | Verified meaning |
|---|---|
| [18-overview-desktop-settled.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/18-overview-desktop-settled.jpg) | Final settled 1440 desktop demo; stale/failure data, priorities and daily-review hierarchy; content fits. |
| [Holdings-watchlist-tablet.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/Holdings-watchlist-tablet.jpg) | 768 tablet holdings overflow. |
| [Holdings-watchlist-narrow.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/Holdings-watchlist-narrow.jpg) | 390 phone-width holdings. |
| [Evidence-disputes-narrow.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/Evidence-disputes-narrow.jpg) | 390 evidence table overflow. |
| [project-summary-768.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/project-summary-768.jpg) | Settled tablet project summary. |
| [project-comparison-390.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/project-comparison-390.jpg) | Settled phone-width project comparison. |
| [project-economics-390.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/project-economics-390.jpg) | Settled phone-width economics. |
| [project-reports-390.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/project-reports-390.jpg) | Settled phone-width reports. |
| [11-pdf-project-error-confirmed.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/11-pdf-project-error-confirmed.jpg) | Confirmed route failure after a valid PDF import; console stack retained separately. |
| [12-empty-desktop.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/12-empty-desktop.jpg) | Empty desk before browser mutation. |
| [13-browser-project-created.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/13-browser-project-created.jpg) | Synthetic project created through the browser; restart checked on disk/index. |
| [14-failed-import-inbox.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/14-failed-import-inbox.jpg) | Retained failed import in inbox state. |
| [16-unpriced-total-desktop.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/16-unpriced-total-desktop.jpg) | Verified 1440 unpriced-holding $0 header. |
| [19-pending-project-desktop.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/19-pending-project-desktop.jpg) | Pending project, no bound token/market feed, unknown research panels. |

Other captures are retained as intermediate evidence. In particular, filenames `15-overview-final-desktop.jpg` and `17-stale-desktop.jpg` were captured while the viewport was still 390 px; the filename alone is not a width claim. `11-pdf-project-error.jpg` is provisional; use the confirmed capture. Desktop smooth-scroll intermediates are not substitutes for the settled width-specific project images. `browser-checks.json` contains 85 evidence entries including provisional and confirmed observations, DOM snapshots, widths and console records; it is deliberately verbose.

## Preservation result

[preservation-check.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/preservation-check.json) at 16:28:28 UTC records:

- 285 files before and after outside `audits/`.
- `ProtectedChanged: []`; no changes to application code, original project/report files, portfolio, config, templates, launchers or instructions.
- `AddedOutsideAudit: []`.
- `ScheduleDefinitionUnchanged: true`; before/after task XML identical.
- Six expected mutable operational files changed: derived index, jobs state/log, market latest/status and October observations. The pre-existing dashboard/task continued running, so a byte-identical whole root was neither expected nor claimed.

All new artifacts and synthetic records are under `audits/2026-10-01-codex-system-review/`. PDF test bytes were preserved in the audit's PDF fixture directories when removed from the test project's active state for subsequent browser checks. The original live server remained active; the two isolated servers and browser tabs were cleaned up. No schedules were installed/deleted, no credentials opened/changed, no paid calls enabled and no deployment/trade/OS change made.

At delivery, [preservation-final.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/preservation-final.json) rechecked all 285 baseline file hashes at 17:02:34 UTC: no protected changes, the same six mutable operational paths, identical task definition, HTTP 200 health and original PID 34464 listening on loopback. The final-check helper's initial path filter used forward slashes against Windows paths; it was corrected before the successful recheck. This was an audit-helper classification error, not a new application change. [artifact-check.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/artifact-check.json) verifies saved Markdown local-link targets/line bounds, score arithmetic and evidence counts. The proposed SVG also parsed as valid XML; it is a static design diagram, not implemented UI.

## Confidence limits

High confidence: deterministic synthetic outputs, raw hash/correction reconciliation, verified runtime/task definition, measured settled widths and confirmed PDF route failure. Moderate confidence: code-inspected overlap, long-operation ownership and backup consistency risks; their full production failure conditions were not induced. Unverified: actual Cowork-to-connected-folder dictation, cloud/local availability for this account, Node 24 execution, actual PC-off/login/sleep/DST job behavior, hardware power loss, disk-full/corrupt-manifest matrix, comprehensive accessibility and live asset coverage/licensing of proposed providers. The audit did not turn unavailable checks into passing claims.
