# Independent validation record

Audit date: October 1, 2026, America/New_York. Some artifact timestamps use UTC October 2. Working directory: `C:\Users\Kuaya\Documents\CryptoResearch`. All audit-created fixtures, reports, scripts, screenshots and crash outputs are under [this audit directory](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/).

## Target, instructions and isolation

Read the user brief, README, WORKSPACE-MAP, COWORK-INSTRUCTIONS, CLAUDE, v1 review, Claude integrity repair and frontend design-pass documents and raw harnesses. No applicable AGENTS.md was found in the workspace/ancestors or source subtree. Applied the installed Browser skill for actual browser interaction; did not run Claude's retained standalone CDP harness against the user's browser.

The real workspace is `ws_rzn5w5pudi`, kind `real`, home `DESKTOP-IILMFLP`, timezone America/New_York. Resolved Node is **v24.21.0**, executable `C:\Users\Kuaya\AppData\Local\Volta\tools\image\node\24.21.0\node.exe`. The pinned 70-file scope includes application modules, public UI, scripts, tests, fixtures, CLI/server and package.json. SHA-256 of sorted `path + NUL + file hash`, joined with LF, is **9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0**. [Per-file target](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/source-target.json).

Copied source and templates into `code-snapshot` under this audit. All adverse tests use test/demo workspace IDs there. Port 4929 served fictional demo records, port 4989 was a local CoinGecko search stand-in, and port 4949 served a frozen, explicitly Test-labeled copy of real records with market fetching and unattended research disabled. No provider configuration was written in the real root. Fake LOCAL_ONLY values existed only behind replaced/injected local adapters and never went to external model endpoints. Provider request bodies were captured through injected fetch implementations. No paid calls, trades, deployment or external messages occurred.

The real loopback target `http://127.0.0.1:4729/` refused every audit connection attempt, including the final check. Initial marker PID 13960 was stale; the later marker PID 19996 was also absent at final inspection. A transient real dashboard start/refresh is visible in records at 20:35 ET, but there was no successful live browser session by this auditor. The pending request for the user to open the existing launcher received no response. I did not start/stop the shared real server to bypass this limitation. Mirror screenshots establish current-code rendering of copied records, not live real-dashboard validation.

The inspected launcher [Open Dashboard.cmd](<C:/Users/Kuaya/Documents/CryptoResearch/Open Dashboard.cmd>) changes to its own folder and runs `node dashboard/cli.js serve --open` in the titled server window. The scheduled task runs [scheduled-run.cmd](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/scripts/scheduled-run.cmd) through conhost/cmd in this real root. Both resolve the package's Volta pin; the launcher still mentions Node >=20 compatibility in its missing-runtime message. Neither launcher was executed by this audit.

### Implementation and durable flow map

The application uses native Node HTTP, flat files and small shared core modules. The browser, CLI and file queue converge on the same domain functions and staged operations. Indexed/scored/portfolio results are derived; saved originals, identities, transaction records and versioned research metadata are authoritative.

| User action | Traced implementation | Durable and refreshed result |
|---|---|---|
| Add/confirm project | Dialog → POST /api/projects in [server.js:594](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/server.js:594) → [projects.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/projects.js) addProject → runOp | Project identity/watchlist metadata, prompts and history saved; no portfolio transaction created; optional createRun recorded separately |
| Copy/run/import research | [research.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js) createRun persists prompt.md, evidence-packet.json and run.json; provider jobs keep independent attempts/states; POST /api/import/text → [inbox.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/inbox.js) importContent | Input stored before ingest; original + report.json committed; hash dedup and truthful import outcome; saved report linked to manual run; corrections remain separate |
| Cowork/file request | [requests.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/requests.js) validates contract/ID/content → shared project/research/note/portfolio handler | Durable effect identity and logs/requests receipt distinguish pending/applied/conflict/failure; crash recovery discovers committed effect before replay |
| Market refresh | [market.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/market.js) identity registry → provider row validation → latest/observations/status | Last good observations retained, source and fetch times distinct; neither stored grades nor research requests change |
| Read/compare/portfolio | [indexer.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/indexer.js) buildIndex/projectDetail → pinned scoring/comparison and [portfolio.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js) calculations | Server rebuild/watch/poll updates derived index and emits SSE; [app.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/app.js) updates views while retaining draft/route context and explicit Re-sort order |

The browser's saved add/manual import and the regression crash probes were followed through these durable records, not judged solely by success text. The shared reader flaw V2-001 and paid-attempt gaps V2-003 limit the stronger guarantees this architecture otherwise aims to provide.

## Executed commands and suite

Commands below were executed from the stated root, with the resolved Node pin. They are a record, not instructions to rerun against real data. Fixture scripts deliberately refuse to overwrite existing scenario directories; reproduction requires a fresh audit directory/copy or new fixture labels.

```powershell
node --version
node dashboard/cli.js test
node audits/2026-10-01-codex-system-review-v2/initialize.cjs
node audits/2026-10-01-codex-system-review-v2/probes.cjs
node audits/2026-10-01-codex-system-review-v2/probes.cjs resume
node audits/2026-10-01-codex-system-review-v2/extended-probes.cjs
node audits/2026-10-01-codex-system-review-v2/serve.cjs
node audits/2026-10-01-codex-system-review-v2/browser-fixture-action.cjs price
node audits/2026-10-01-codex-system-review-v2/browser-fixture-action.cjs manual
node audits/2026-10-01-codex-system-review-v2/final-probes.cjs
node audits/2026-10-01-codex-system-review-v2/supplement-probes.cjs
node audits/2026-10-01-codex-system-review-v2/finish-checks.cjs
```

The initial inventory command ran before fixture writes; it must not be rerun over the saved baseline. The suite ran on deployed code, not only its copy: **109 tests passed, zero failed/cancelled/skipped/todo**, 13,531.5915ms. [Complete suite output](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/baseline-tests.txt). Key assertions were read in the audit regression, ops, research, portfolio, ingestion, market, comparison, server and UI tests.

The rollback suite ran via spawnSync of `process.execPath`, with `rollback-code` as cwd and arguments `dashboard/cli.js test`: **103/103**, zero failed/skipped/cancelled, 12,106.6798ms. [Rollback output](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/rollback-tests.txt). It used only a copied recovery source tree. Old and new indexers, reading copied current records without recovery writes, produced the same project/provider records and portfolio. It does not prove future-schema compatibility or safe replacement of running code.

Read-only task checks used Schedule.Service/GetTask XML and the application's status function, never install/remove/runNow. The real task targets this workspace; the demo copy correctly reports `other_workspace`. XML before and after has identical normalized content; a final trailing CRLF explains the two-byte file difference. [Definition comparison](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/schedule-definition-comparison.json).

## Independent adverse and domain checks

| Check | Outcome | Evidence |
|---|---|---|
| Slow two-file commit at production reader defaults | Returned new/old mixture after about 1.1s, generation still applying; child later committed both new values | Initial probes output; retained writer fixture; V2-001 |
| Package Windows backslash traversal | Restored_and_verified while writing `..\escaped-package.txt` outside destination | Initial probes output; escaped benign audit-owned file; V2-002 |
| Sealed backup backslash traversal | Recomputed legitimate seal; verify ok, 29 files, no mismatches; restore escaped destination | Supplement results; V2-002 |
| Crash at paid stub dispatch before response | Child exit 77; next runner dispatches a second time | Paid probe output/results; V2-003 |
| Crash after durable response file but before saved pointer | Valid first response exists; restart still dispatches a second time | Paid probe output/results; V2-003 |
| Aggregate per-run spend | $1.10 configured run allowance admitted three $1 modeled calls; completed spend $3 | Paid probe output/results; V2-004 |
| Provider search request controls | Requested one search; Claude sent max_uses=1, GPT/Gemini sent no requested native hard cap. Runner transformed configured zero to twenty | Extended captured bodies + source; V2-005 |
| Later market chunk network failure | 251 tracked IDs; two requests; persisted day/month count one | Final probe results; V2-007 |
| FIFO / transfer / fees / dust / closed fees | Correct acquired-lot order; collision refused; distinct fee identities; 5e-10 BTC retained; closed fees retained | Fourteen completed extended observations + meaningful regression assertions |
| Cross-asset bridge | Ambiguous arrival quarantined, not guessed; quantity conserved including in transit | Completed extended observations |
| Market partial/invalid/offline | Kept last good $100 BTC/source time; truthful partial/failed/backoff states; negative signed change valid | Completed extended observations + suite older/rate-limit cases |
| Valid-length hostile original | 11,212 characters retained; real unsafe HTML/script/data/javascript links inert in reader; embedded instructions remained text | Hostile fixture/import results, browser DOM and screenshot |
| Unknown rubric / malformed structured report | Unknown version withheld; malformed long input preserved as prose with explicit parse error, rather than silently graded from malformed JSON | Extended observations |
| Legitimate package and sealed backup | Separate clean restores succeeded, inventory/hashes and record totals matched | Completed extended observations |
| HTTP boundary | No-token 401; foreign Host/cross-site 403; authenticated foreign Origin 403; valid authenticated index 200; disk/traversal/unknown routes 404 | Final + supplement results |
| Session/secret surface | Session returns only token and workspace; source rejects secret-bearing settings and excludes secret file from exports | Supplement results + source inspection; secret values never printed |

Primary raw artifacts: [probes-output.txt](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probes-output.txt), [probes-paid-output.txt](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probes-paid-output.txt), [probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probe-results.json), [extended-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/extended-results.json), [extended-output-complete.txt](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/extended-output-complete.txt), [final-probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/final-probe-results.json), [supplement-probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/supplement-probe-results.json).

## Browser workflows and lifecycle

Used the in-app Browser through its supported client, with ordinary UI actions and DOM/style/geometry observations. No internal application state, cookie, localStorage or browser-profile inspection was used. Clipboard inspection was limited to the fictional research prompt deliberately copied by the tested UI.

- Filtered projects, cleared filters, sorted known/unknown values both ways; price changed while row order stayed fixed; explicit Re-sort applied new order and retained selected project.
- Hovered/focused ChatGPT's scorecard, moved pointer into it without dismissal, used Esc, Enter and provider selection, opened original report and returned via Back to the same panel/provider context. Wide summary remained nonmodal. At 390px the sheet was a labeled modal dialog with background inert; keyboard cycling and Esc worked.
- Added an ambiguous local listing with explicit choice, ran three fictional outcomes (two complete, one failed), preserved a failed lookup, and saved an unlisted pending identity. Nine projects survived a later isolated restart; existing holdings remained the original four assets. Adding a project did not create holdings.
- Completed the actual manual pair: copied a 24,632-character stored prompt, SHA `202af20a08269bfbc105c037b83cce418fe57d93fa04163bd0b7a235456db431`; imported a 9,518-byte fictional answer into its intended ChatGPT run. Original SHA `e716cfbf5d8c5973bc52cae5ba9ca9e79c2186e8efd150f4b9cfe454c215e805`, exact grade 56.45, displayed 56.4 F; run completed in manual mode with no paid attempts. Same answer again returned Already saved.
- Rejected short text truthfully, retaining its inbox original/draft/receipt. During a live update, focused text and selection remained stable. Explicit Show updates preserved draft text. A 63-character note draft retained focus, selection `[0,1]` and scroll 342.6667px through an independent update. A separate final original-reader check retained nonzero scroll 80.6667px and the same report URL/heading after another update.
- Checked all five main views at 320, 390, 768, 1280 and 1600px: **25 layouts, zero outer overflow**. Checked all eight project sections at 320/1440: **16 more section layouts**, correct selected tabs/URLs. Research/evidence tables use intentional internal scrolling. Actual rendered widths, rather than requested viewport settings alone, were used for geometry conclusions.
- Inspected empty copied-record portfolio, populated demo portfolio, stale prices, unknown/PDF/manual/failed grades, price ranges, pending identity and failure receipts. Sparse copied real records looked intentional at 320/1280/1600; that workspace was explicitly labeled Test.
- Measured actual hover text: near-black on white 16.83:1, secondary gray on white 6.35:1. Selected provider's text/focus-border colors and the rendered identity-error callout were also captured. These are scoped rendered samples, not a complete color or WCAG audit.
- Fifteen full reloads completed in about 145–178ms with peak SSE one. Six simultaneously visible documents held six streams/sockets; a seventh navigation timed out at about 23s. Closing loaded extras released streams and fresh navigation worked. Source closes pagehide/hidden subscriptions and clears server ping/client state. Native background/BFCache behavior remains unverified because browser emulation kept documents visible.
- Two deliberate restarts affected only the audit server. Saved records reappeared and live connection recovered; representative post-restart console error/warning logs were empty. No long-duration heap or CPU profile was taken. Bounded socket counts are not proof of no leaks.

[browser-checks.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/browser-checks.json) retains early interaction/lifecycle observations; [browser-layout-checks.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/browser-layout-checks.json) retains the 25 main-view measurements; [browser-final-checks.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/browser-final-checks.json) retains later draft/reader/reflow/error/style/restart observations. Some middle-run in-memory observations were lost when browser-control sessions reset; those conclusions rely on tool transcripts, saved screenshots and durable fixture records, not an invented complete JSON log.

Connection evidence: [seven-tab stats](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/server-stats-seven-tabs.json), [post-tab cleanup](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/server-stats-after-tabs-cleanup.json), [before final restart](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/server-stats-final-before-restart.json), [before process cleanup](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/server-stats-at-cleanup.json).

## Failures, corrected harness errors and blocked checks

The first paid probe supplied the wrong shape for the key-status stub and never dispatched; corrected local stub shape and fresh fixtures produced the completed results. The first bridge fixture used an unregistered asset; adding an explicitly fictional verified asset corrected it. The first sealed-backup fixture used a prohibited name with spaces; safe naming and the actual seal algorithm corrected it. Initial outputs are retained, not counted as successful product checks.

The first durable report filter looked at `report.provider` instead of `report.meta.provider`; its empty `ai_chatgpt_reports` list is a harness error. Supplement results establish the actual saved report. The HTTP probe named “valid local read” omitted the session token and correctly received 401; an authenticated follow-up received 200. A foreign-Origin probe without a token primarily tested token rejection; a later valid-token foreign-Origin request independently received 403.

Native Ctrl-plus enlargement and a subsequent command to that tab timed out in browser control. A fresh tab loaded normally, so this is not counted as a new application-wide freeze. Native **200% enlargement remains unverified**. Independent 640-CSS-pixel reflow passed, with DPR 1 and viewport scale 1; it must not be described as native zoom. Original Claude evidence explicitly used density emulation. No native screen-reader, physical phone/touch, live Cowork/voice or paid model session was available. No server was exposed to a network to work around these limits. Reduced-motion source and original emulated transition assertion were inspected, without an independent native OS preference session.

Initial zero-scroll reader checks were inconclusive; the final nonzero before/after check above supplies the narrower successful evidence. DOM selectors that initially searched for a literal article or complementary role at the wrong location were corrected to actual rendered elements; empty preliminary measurements are not accessibility successes.

## Screenshots

All independent images are local JPEGs in [screenshots](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/). Selected evidence:

| Screen | Artifact |
|---|---|
| Final watchlist, 1440 | [18-final-watchlist-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/18-final-watchlist-1440.jpg) |
| Readable hover | [02-hover-scorecard-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/02-hover-scorecard-1440.jpg) |
| Selected beside-list summary | [03-panel-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/03-panel-1440.jpg) |
| Full original reader | [04-report-reader-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/04-report-reader-1440.jpg) |
| Add flow | [05-add-project-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/05-add-project-1440.jpg) |
| Rejected import | [07-import-rejected-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/07-import-rejected-1440.jpg) |
| Hostile original, inert | [08-hostile-report-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/08-hostile-report-1440.jpg) |
| Manual import receipt | [09-manual-import-saved-1440.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/09-manual-import-saved-1440.jpg) |
| Phone summary sheet | [11-summary-sheet-390.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/11-summary-sheet-390.jpg) |
| Copied sparse real records, Test label | [12-real-record-mirror-1280.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/12-real-record-mirror-1280.jpg) |
| Empty copied-record portfolio | [13-empty-portfolio-mirror.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/13-empty-portfolio-mirror.jpg) |
| Range grade + panel | [14-range-panel-mirror-1600.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/14-range-panel-mirror-1600.jpg) |
| Reflow, not native zoom | [16-reflow-640.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/16-reflow-640.jpg) |
| Identity failure | [17-lookup-failure.jpg](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/17-lookup-failure.jpg) |

The same folder retains `layout-{view}-{width}.jpg` and `project-{section}-{width}.jpg` evidence. `01-watchlist-1440.jpg` was a provisional capture before measured column fitting settled; use the final/settled captures for layout conclusions. The mirror screenshot was renamed from a requested 1440 label to the **actual measured 1280** width.

The reported missing Claude hover image was found and visually inspected at [hover-scorecard-1440.png](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-claude-design-pass/screenshots/after/hover-scorecard-1440.png), with another retained copy under after/interactions. It is earlier evidence; the independent hover above is the new interaction evidence.

## Preservation and cleanup

Initial inventory: **176 real-root files**, excluding audits, .git and dashboard/demo-workspace. Final inventory: **176**, no added or removed files. All **70 source targets match** the initial fingerprint. Workspace identity, configuration, templates, research originals/metadata/corrections, portfolio, intake records and operation journal remained unchanged by hash.

Eight files differ: `.cr/server.json`, derived `dashboard/index/index.json`, three market-data files, and three job/scheduler log files. The real records show a **dashboard-triggered** price refresh at 20:35:47 ET and an ordinary hourly scheduler run at 21:25:44 ET (result 0; requests/inbox empty, other work not due). The changed server marker says PID 19996 started at 20:35:45 ET; that process was absent at final inspection. The initiator of that transient dashboard start is not independently established. These are observed real background/runtime changes, distinct from audit fixtures; this audit did not initiate the real refresh or task run. It would be inaccurate to claim every real file stayed byte-identical.

[Before inventory](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/preservation-before.json), [after inventory](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/preservation-after.json), [delta and final task/server status](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/preservation-delta.json). The task XML was unchanged after normalizing exterior newline formatting. Credentials were not read for their values or modified.

Closed all audit-created browser tabs and reset viewport emulation. After verifying each PID's command line contained this audit and its specific server/stub script, stopped only isolated demo PID 37204, mirror PID 16564 and local stub PID 48012. Earlier isolated restart PIDs were likewise checked before stopping. No user/shared process was killed. [Cleanup record](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/cleanup.json). Fixtures and crash evidence remain recoverable under the audit directory.
