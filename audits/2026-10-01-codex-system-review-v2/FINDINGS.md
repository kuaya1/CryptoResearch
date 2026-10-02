# Findings — independent review v2

Target fingerprint: `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0`. Line references below refer to the unchanged deployed source, retained in the audit snapshot. P1 requires correction before the affected trust/readiness claim; P2 is a material bounded defect. All destructive reproductions used isolated audit folders or local provider stubs. No paid call or real restoration occurred.

## Confirmed defects

### V2-001 — P1 — Consistent reads return a mixed generation after their retry budget

**Affected:** [ops.js:296](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ops.js:296), `readConsistent`, especially the unconditional return at line 311; [indexer.js:416](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/indexer.js:416), `buildIndex`/`projectDetail`. Related to v1 **F04**.

**Reproduction:** `probes.cjs` creates two old files, starts a child staged operation that replaces the first file, and holds the child before the second rename. The production-default reader gets eight attempts. While generation state is still `applying`, it eventually calls the reader anyway. See [probes-output.txt](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probes-output.txt).

**Observed:** `['new','old']` returned after 1125ms, generation 1 still `applying`. After releasing the writer, both files were `new`. **Expected:** only old/old or new/new, or a truthful busy/unavailable result. Exhausting retries must not authorize an incoherent read.

**Impact:** a dashboard index, report detail or portfolio view can combine different generations during a slow commit. This probe establishes mixed reads, not actual corruption of the user's real records. The existing consistency test uses 40 reader attempts and 25ms rename delays, rather than the production default and this longer pause.

**Minimal fix:** remove fail-open fallbacks, including the path that reads an old `applying` marker. Return a verified coherent snapshot or a bounded explicit busy/error state and retry/catch up appropriately. Preserve quarantined/in-progress evidence.

**Acceptance:** default eight-attempt reader held beyond the retry window never returns a mixed pair; test both an active writer and a writer interrupted between renames. Browser/API must show a truthful recoverable state, then the committed generation, without losing drafts or focus.

### V2-002 — P1 — Windows restore paths escape the empty destination

**Affected:** [exporter.js:376](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/exporter.js:376), `restorePackage` (path validation/writes at 382–397); [exporter.js:471](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/exporter.js:471), `verifyBackup`; [exporter.js:528](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/exporter.js:528), `restoreBackupTo`. Related to **F06/F18**. Existing [workspace.js:104](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/workspace.js:104), `safeRel`, already treats backslashes as separators.

**Reproduction:** append a correctly hashed package entry named `..\\escaped-package.txt`, then restore into an empty audit directory. For backup, create a legitimate sealed backup, append an item `..\\escaped-backup.txt`, supply the matching source file outside `files/`, and recompute the documented unkeyed manifest digest. All source and escaped destinations remained inside the audit folder.

**Observed:** package restore wrote outside `package-dest/` and returned `restored_and_verified`. Backup verification returned `ok:true`, and clean restore also wrote outside `backup-traversal-dest/` and returned `restored_and_verified`. See [probes-output.txt](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probes-output.txt) and [supplement-probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/supplement-probe-results.json). **Expected:** reject unsafe entries before any restoration write. A recomputable checksum verifies bytes; it does not make a supplied path safe.

**Impact:** an imported package or manipulated backup can overwrite files beside its restoration directory with the user's filesystem privileges. A verified message currently conceals the destination-boundary failure. The isolated probe wrote new marker files; it did not overwrite real user files.

**Minimal fix:** preflight the entire inventory using a shared cross-platform relative-path validator and resolved containment check for both source and destination. Reject backslash traversal, rooted/drive/UNC paths, NUL, duplicate normalized targets and other unsafe paths before creating/writing restored files. Apply the rule across the restore family; do not mistake a digest for authentication.

**Acceptance:** legitimate package and sealed-backup round trips still preserve all authoritative records/original bytes. Both demonstrated payloads fail before the first write; sentinel files outside the destination remain unchanged. Verify source containment too. Preserve existing restore safety/default-empty behavior.

### V2-003 — P1 — Interrupted paid attempts are automatically dispatched again

**Affected:** [research.js:430](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:430), `runOneJob` interrupted-running recovery; [research.js:411](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:411), `saveResponse`; dispatch/save/pointer updates at 481–529. Related to **F17**, distinct from locally idempotent Cowork file actions in F01.

**Reproduction:** local provider stubs only. First child exits with code 77 immediately after stub dispatch but before a response is returned. Second child returns a valid answer and exits immediately after `responses/claude-attempt1.json` is durably renamed, before `attempt.response_path` is recorded. Reopen the isolated workspace and run due jobs twice.

**Observed:** both jobs recover `running → queued`, then dispatch again. Each fixture recorded **two dispatches**. In the second case the first valid original response already existed locally. The interrupted attempt says it may have been billed, but the job's error is cleared when it is requeued. [probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probe-results.json)

**Expected:** no blind replay of an uncertain sent request. Discover and validate an already saved deterministic response and import it without another submission. If dispatch outcome is unknown, hold for reconciliation/explicit user decision. Exactly-once vendor submission cannot be inferred from local receipt idempotency.

**Impact:** duplicate charges or duplicate expensive research after a crash; raw-first persistence is ineffective in the gap before its pointer is saved. No real charge occurred in this audit. The existing restart test interrupts only after `response_path` is already recorded, so it misses both windows.

**Minimal fix:** persist dispatch intent/attempt identity, represent uncertain outcomes explicitly, find sealed saved responses by deterministic attempt path and validate run/provider/prompt/hash metadata. Retain uncertain spend reservation until reconciled. Never automatically retry a potentially accepted paid request merely because the process died.

**Acceptance:** crash before send, after send, after response capture, after durable response rename, after pointer write, and before import are separate tests. An existing valid saved answer completes with zero additional dispatches. An uncertain sent attempt remains held across automatic ticks/restarts until reconciled. Conflicting/tampered raw responses must not be imported.

### V2-004 — P1 — The per-run budget is actually checked per provider call

**Affected:** [research.js:157](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:157), `budgetCheck`; `runOneJob` at 459–477; `spendSoFar` at 136. Related to **F17**.

**Reproduction:** set isolated `per_run_usd:1.1`, daily 10, monthly 100; request all three providers in one run. Each local stub has a $1 estimate and $1 recorded actual cost. No network submission is made.

**Observed:** all three provider calls proceed, the run completes, and the ledger records **$3 for the one run**. The check compares only the next estimate to 1.1, not existing/reserved spend for that run. **Expected:** the aggregate run policy includes all providers and retries; this run cannot spend $3 under a $1.10 limit. [probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/probe-results.json)

**Impact:** a user's stated run limit can be exceeded even in entirely sequential normal operation. Current tests exercise refusal and success for a single provider only.

**Minimal fix:** identify the run in budget checks and maintain aggregate reservations/reconciliation under the workspace lock, including retries and uncertain attempts. Check run/day/month policy as one atomic admission decision; accurately label estimates versus actual/provider-enforced limits.

**Acceptance:** this three-provider fixture admits at most the allowed aggregate; later providers have explicit budget-refused/held outcomes without erasing earlier successful reports. Include retry/uncertain-spend and independent-run cases, plus concurrent admission so new reservations cannot race.

### V2-005 — P1 — Search limits and “maximum cost” assurances do not match adapter requests

**Affected:** [research.js:114](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:114), `estimateCostUsd`; `providerStatus` at 91–109; [research.js:484](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:484), `maxSearches`; [providers.js:108](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/providers.js:108), `callChatgpt`; [providers.js:127](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/providers.js:127), `callGemini`.

**Reproduction:** capture adapter requests with `fetchImpl` returning local recorded responses and `maxSearches:1`. Also configure `max_searches:0` in the per-run fixture. No fake credential is sent to any external service.

**Observed:** Claude sends `max_uses:1`. ChatGPT sends a web_search tool without `max_tool_calls`; Gemini enables google_search with no transmitted query bound. The runner transforms configured zero into **20** using `|| 20`. Missing search prices are treated as zero; prompt-length/tool-result token allowances are estimates, not demonstrated upper bounds. [extended-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/extended-results.json)

**Expected:** preserve zero and enforce supported search controls. A provider mode with no enforceable hard bound must not be advertised as a bounded maximum-cost call. OpenAI documents a total built-in-tool limit; Anthropic documents max_uses. Google's billing unit differs by model generation, so one generic search-call fee needs explicit capability/pricing semantics. [OpenAI Responses reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), [Anthropic web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool), [Gemini grounding pricing](https://ai.google.dev/gemini-api/docs/google-search)

**Impact:** configured budgets can give false assurance when actual tool use exceeds the estimate. The audit proves missing controls/zero override; it does not assert an observed live bill or invent a Gemini hard-cap parameter.

**Minimal fix:** combine with V2-004. Validate finite/nonnegative settings; use nullish/default handling that preserves zero; send supported native caps or disable the tool when zero. Model capability/pricing policy must distinguish enforced bounds from estimates. Refuse unattended hard-budget execution when requisite cost components or bounds are unavailable.

**Acceptance:** captured request tests for zero/one/max limits per provider; missing fee/capability must produce an honest refusal or explicitly configured supported policy. Test high tool usage and usage-unit reconciliation. Do not activate or price real providers as part of this fix.

### V2-006 — P2 — Six visible SSE clients still starve another dashboard document

**Affected:** [app.js:398](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/app.js:398), `connectEvents`; `boot` at 497–515; [app.js:23](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/app.js:23), browser request helper; [server.js:419](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/server.js:419), `sse` on HTTP/1.

**Reproduction:** current snapshot, isolated port 4929. Fifteen full reloads succeed. Then open six visible dashboard documents, each reporting `document.hidden:false` in this browser environment. Attempt a seventh. Server instrumentation records requests, socket starts/closes, active/peak SSE and rebuilds.

**Observed:** six loaded documents hold six active streams/sockets; seventh Page.navigate times out after about 23 seconds. Closing a loaded tab releases a stream; cleaning up live extras and opening a fresh tab succeeds. [server-stats-seven-tabs.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/server-stats-seven-tabs.json), [browser-checks.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/browser-checks.json)

**Expected:** additional supported dashboard windows should load, or fail in a bounded, understandable manner without exhausting their ordinary HTTP request capacity.

**Impact:** a remaining hang/load failure with several visible dashboard windows. Ordinary Chrome hidden tabs may close after 15 seconds; this probe does not disprove that cleanup or identify the historical freeze's exact cause. HTTP/1 SSE connections share a small per-browser/domain limit. [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)

**Minimal fix:** use a bounded multi-window strategy, such as a shared update stream with robust ownership/fallback or polling, preserving local authentication and nondisruptive refresh. Avoid initial hidden-page SSE subscription. Bound/cancel browser fetches and surface recovery state. Changing server maxConnections alone does not remove the browser constraint.

**Acceptance:** at least seven visible clients complete, plus real hidden/foreground, pagehide/BFCache, close/reopen, restart and failed-network tests. SSE/socket counts settle after close/navigation. Selected row, draft, focus, reading position and Re-sort semantics survive. Do not certify a leak-free lifecycle from zero console errors.

### V2-007 — P2 — Network failure in a later market chunk undercounts calls

**Affected:** [market.js:82](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/market.js:82), `fetchMarkets`; [market.js:284](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/market.js:284), `refreshLocked` error handling.

**Reproduction:** isolated registry with 251 tracked IDs; local fetch returns success on chunk one and throws a network error on chunk two. Run the complete refresh path.

**Observed:** two requests were made, but persisted day_count/month_count were **1**. HTTP-status failures carry `err.calls`; rejected fetch or JSON parsing does not. The catch assumes `err.calls || 1`. [final-probe-results.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/final-probe-results.json)

**Expected:** account for all attempted requests, even if a later chunk throws before yielding a response.

**Impact:** call-budget/failure history understates usage on larger tracked lists or smaller configured chunk sizes. The current two-project real list does not itself reproduce the multi-chunk case.

**Minimal fix:** propagate the cumulative attempted count for fetch/parse failures, with the original error/backoff/Retry-After information retained.

**Acceptance:** second/third-chunk network, timeout, malformed-JSON and HTTP-status failures all persist the exact attempted count and retain last good values. This is after the five higher-value actions.

## Usability observations, not reproduced integrity defects

### V2-U01 — Market columns yield early to preserve the three model badges

**Affected:** [watchlist.js:15](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/watchlist.js:15), column catalog and measured fit; render at 772–946.

At 1440/1600 with enough room the default market columns are available. At 1280, volume/sector can step aside; opening the desktop panel hides more columns. Phone cards prioritize name, price, 7D and three providers; 30D/rank/cap/volume require the summary. This avoids overflow and keeps grades readable, but limits simultaneous scanning of the mission's requested fields. Every value remained in the summary. Consider a small explanation of hidden fields and selective column priority/pinning only if daily use warrants it. Acceptance should protect all three providers and whole-page reflow.

### V2-U02 — Focus previews are visual; their details are excluded from accessibility output

**Affected:** [watchlist.js:442](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/watchlist.js:442), `ensurePreview` sets aria-hidden permanently.

Keyboard focus visibly opens a readable scorecard and gives a 2px dark outline, but the preview remains `aria-hidden:true`. The badge announces provider/grade/date/status; Enter opens a labeled panel containing equivalent detail. This is an accessibility limitation/acceptance item, not proof that the full workflow is inaccessible. Validate a screen-reader session and provide an appropriate concise accessible description or discoverable Enter instruction without duplicate/continuous announcements.

## Optional maintenance and acceptance work

- Tighten engine/fallback documentation to supported Node releases. Actual deployed runtime is already Node 24.21.0; do not undo the pin or require a dependency migration.
- Embed source hashes, workspace kind/ID, actual viewport/zoom method and route/content assertions in future browser evidence. The retained Claude working copy currently matches deployed code, but old screenshots/results did not pin their source bytes at capture time.
- Complete native 200% enlargement, assistive-technology, physical-touch and live Cowork acceptance after the confirmed blockers. Do not replace those sessions with larger render counts or add paid integrations merely to close an audit checklist.

No additional portfolio arithmetic or incorrect-grade defect was reproduced beyond the shared snapshot risk. The seven confirmed findings above are platform findings, not judgments about any sample project's investment merit.
