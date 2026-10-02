# Prioritized findings

October 1, 2026. P1 = high priority because a supported operation can duplicate/lose records or produce materially wrong accounting/research output. P2 = significant incorrect behavior, security exposure or workflow failure. P3 = smaller clarity/maintenance issue. No remote code execution, credential compromise or loss of real user data was demonstrated.

Evidence labels: **reproduced** = isolated executable probe; **observed** = browser/runtime result; **code-inspected** = an implementation risk whose full failure scenario was not induced. Artifacts are in [this audit folder](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/README.md). Estimates include focused regression checks, for one engineer familiar with the code. Related estimates overlap and should not be summed mechanically.

## Confirmed defects and implementation limitations

### F01 — P1: a committed queued action can run again after a crash

- **Evidence:** `probe-results.json`, “Queue action committed before receipt then replayed”; `queue-crash-child.cjs` exits 77 after a journal action commits and before its receipt. Restart changes journal count from 1 to **2**; receipt is done. Normal replay with an existing receipt is protected, but this interval is not.
- **Affected:** [requests.js:39](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/requests.js:39), `processOne` / `finish` at 63; action dispatch and receipt/move use separate transactions, and the receipt check is outside those locks.
- **Impact:** a repeated natural-language request can append duplicate journal entries/events and, depending on action-level deduplication, ledger changes. A done receipt cannot prove exactly one action occurred.
- **Fix / effort:** durable action identity committed with the action, or action plus receipt in one transaction; reconcile receipt after restart rather than rerun a committed effect. Do not rely solely on process-local flags. 3–5 days with append actions and regression coverage.
- **Acceptance:** exit at each action/receipt boundary, restart and replay repeatedly; one effect and one stable receipt. Two simultaneous queue processors must also preserve one effect. The original utterance and result remain auditable.

### F02 — P1: transferred older lots violate per-account FIFO

- **Evidence:** buy one unit in A for $10 on September 1; buy one in B for $20 on September 2; transfer A's unit into B; sell one in B for $30. Expected gain **$20** and remaining basis **$20**; actual gain **$10**, basis **$10**. `probe-results.json`, “FIFO lot arrival order.”
- **Affected:** [portfolio.js:370](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js:370), lot insertion/consumption in `computePortfolio`; arrival pushes the original lot after existing lots.
- **Impact:** wrong realized gains, remaining cost basis and lot attribution even though total units are correct.
- **Fix / effort:** order consumable lots by preserved acquisition timestamp with a deterministic original lot identity/tie-breaker; transfers preserve, rather than reset, acquisition metadata. 1–2 days.
- **Acceptance:** this case, multiple hops, partial transferred lots, equal timestamps and selling before/after arrival agree with independently calculated FIFO; existing ordinary FIFO/unknown-basis tests still pass.

### F03 — P1: a repeated transfer ID overwrites an outbound lot

- **Evidence:** two one-unit outbound legs sharing an ID from a two-unit holding produce **one owned unit**, with only one in-transit warning. `probe-results.json`, “Repeated transfer ID.”
- **Affected:** [portfolio.js:441](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js:441), `transit.set`; import validation does not prevent this ambiguous key reuse.
- **Impact:** holdings and basis disappear from calculations. Duplicate labels are a plausible manual/CSV input error.
- **Fix / effort:** unique transfer-leg identity, explicit grouping if multiple legs are supported, and quantity/basis conservation. Reject or quarantine ambiguous matches without dropping either leg. 1–2 days.
- **Acceptance:** reused IDs, duplicate inbound legs, partial arrivals and over-arrivals cannot silently overwrite lots. Opening + inflow − outflow must reconcile across owned and in-transit accounts.

### F04 — P1: lock expiry and read consistency do not guarantee a transaction

- **Evidence:** a lock containing the currently live probe PID with mtime 130 seconds old was successfully broken. A rename observer between a two-file operation's replacements read **new/old**, followed by final new/new. Both in `probe-results.json`. The second test instrumented the rename boundary; it did not use an OS racing reader.
- **Affected:** [ops.js:50](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ops.js:50), `tryAcquire` at 74 treats age >120 seconds as stale even when PID is live; `withLock` release has no owner nonce guard; `applyManifest` at 197 replaces files sequentially. Index/export readers do not take a consistent generation snapshot.
- **Impact:** long operations can admit another writer; readers can combine versions into inconsistent projections. Two ordinary child writers did preserve all 40 journals, so this finding does not claim all concurrency is broken.
- **Additional code-inspected risk:** `runOp` removes staging even when verification is false; `recoverLocked` does not require successful verification before deleting staging and reporting roll-forward. Recovery failures are returned/logged without necessarily blocking subsequent writes. This particular corrupt-file path was not forced.
- **Fix / effort:** live ownership checks, unique owner token, safe release/lease renewal and conservative recovery; coherent read snapshots or a committed generation pointer; retain failed staging and fail closed. 3–5 days.
- **Acceptance:** an aged live lock remains exclusive, a dead lock recovers, old owners cannot unlink a new lock, concurrent readers see one generation, and hash/manifest failures preserve evidence and block new writes. Ordinary concurrency and interrupted sealed recovery continue to pass.

### F05 — P1: historical reports are graded against the active rubric

- **Evidence:** a report declaring `cr-grading@1` calculated 52.5 under v1, then **68.5 under v2** after only active weights changed. An `unrecognized@1` report received a firm 80 under `cr-grading@1`. `supplemental-results.json` and `probe-results.json`.
- **Affected:** [reports.js:483](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/reports.js:483), `normalizeAssessment`; [indexer.js:21](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/indexer.js:21), `gradeOf`; `compareProject` in [compare.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/compare.js). Loaded `gradingVersions` are not consistently resolved by the report's reference.
- **Impact:** unchanged originals appear to change investment quality; unknown rubric claims acquire unjustified app grades, and discrepancies/comparisons use the wrong rules.
- **Fix / effort:** one shared resolver for report-declared immutable rubric/profile versions and labels. Unknown/missing versions withhold calculation while preserving raw scores; active rubric governs new prompts only. 2–3 days.
- **Acceptance:** activate v2 and rebuild: every v1 grade, contribution, label and model-total check remains unchanged. Unknown versions show withheld/unsupported. Price refresh and correction of unrelated fields leave historical grades unchanged.

### F06 — P1: backup/restore is an unverified overlay, not point-in-time recovery

- **Evidence:** clean-folder restore preserved report SHA-256, corrected summary, quantity 2 and basis $20. Restoring into a changed workspace retained a journal created after backup. The return explicitly says later files are left in place. `probe-results.json` / `restore-extra-check.json`. This overlay behavior is documented in code; its limitation must be explicit in the product.
- **Affected:** [exporter.js:189](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/exporter.js:189), `createBackup`; `listBackups`; `restoreBackup` at 239. Backup copies are unlocked and use a file count, not a hash inventory. Restore copies in place. Daily snapshots omit price observation history; application files, launchers, `.cr` recovery state and prior version backups are outside the inventory.
- **Impact:** restoring a selected date can leave later reports/history or mix generations. A same-disk data copy is insufficient after disk loss. No concurrent-backup corruption or real disaster was induced.
- **Fix / effort:** name overlay behavior clearly; add consistent sealed capture and checksum manifests; validate completeness before listing/restoring; provide clean-folder restore/reconciliation as the default recovery path and a separate versioned app/runtime recovery recipe. Protect the selected source from pruning. 3–5 days.
- **Acceptance:** incomplete/truncated/hash-mismatched snapshots are rejected; concurrent capture has one committed generation; restore to a fresh folder exactly matches inventory and independent balances. A point-in-time mode removes/quarantines later files only with explicit preview and preservation; overlay remains an explicitly named option.

### F07 — P2: transaction identity and malformed fees cause silent input loss

- **Evidence:** same-date, otherwise identical fills with fees $1 and $2: second is unchanged/duplicate. Two supplied `tx_id: same-id` rows were accepted; voiding the ID voided only the first and left quantity 2 active with the same ID. CSV-style `fee_amount: invalid` was accepted with fee null. `probe-results.json`.
- **Affected:** [portfolio.js:102](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js:102), `fingerprint`; `normalizeTx` at 112; `addTransactions` at 170; `voidTransaction`. Fingerprinting also excludes historical BTC price and truncates date strings to 19 characters; this can erase timestamp distinctions. External-ID deduplication is account-scoped.
- **Impact:** omitted fills/fees, ambiguous corrections and incorrect BTC inputs. Identical legitimate fills also need a way to coexist; adding more fields to a heuristic alone does not resolve this.
- **Fix / effort:** enforce immutable unique internal IDs; scope source IDs by an explicit source/account namespace; compare complete normalized payloads for retries and flag conflicting same-ID content; give manual fills distinct IDs. Parse fee fields before null handling and reject invalid values. 2–3 days.
- **Acceptance:** retries are unchanged, separate fills remain separate, different same-ID payloads report conflict, fee/BTC/timestamp differences are preserved, malformed fees are rejected and voiding addresses exactly one record.

### F08 — P2: a valid PDF report crashes the entire project view

- **Evidence:** a minimal valid 594-byte PDF was ingested and preserved with verified hashes. It produced an assessment with no `sources`/`claims` arrays. Opening that project caused `TypeError` in `claimsTable` (`sources.map`), visible in [the confirmed screenshot](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/11-pdf-project-error-confirmed.jpg). `supplemental-results.json`, browser console evidence in `browser-checks.json`.
- **Affected:** [inbox.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/inbox.js), PDF assessment construction; [project.js:395](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/project.js:395), `claimsTable`, and eager construction of all sections.
- **Impact:** importing a supported report format makes project notes/research controls inaccessible.
- **Fix / effort:** normalize all supported assessment shapes; render PDF preserved/needs-text state safely; guard per-section rendering and construct only the active section. Do not infer PDF scores. 0.5–1 day.
- **Acceptance:** a PDF-only and mixed PDF/text project can open every section, download the original and show unknown/not-extracted fields without console errors or a whole-page failure.

### F09 — P2: CSV exports retain active spreadsheet formulas

- **Evidence:** `toCsv` exports note `=1+1` as a formula-looking cell without neutralization. `probe-results.json`. Spreadsheet execution/exfiltration was not attempted.
- **Affected:** [exporter.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/exporter.js), `toCsv` / `csvTable`.
- **Impact:** untrusted imported text can become executable formulas when a user opens an export in a spreadsheet; ordinary CSV quoting does not stop this.
- **Fix / effort:** neutralize formula prefixes in textual fields, including leading whitespace/control-character variants, with a documented spreadsheet-safe export policy; retain exact originals in JSON/report files. Do not convert true negative numeric fields into strings unnecessarily. 0.5–1 day.
- **Acceptance:** formula-looking titles/notes/URLs open as text in supported spreadsheet tools; comma/quote/newline round-trips remain correct; numeric quantities and negative numeric gains remain usable.

### F10 — P2: invalid successful market responses replace usable prices

- **Evidence:** a valid $100 BTC cache was replaced by a null price from an HTTP-200 mock with `bad-date`; valuation became missing. A −$10 quote with `bad-date` was labeled **fresh**. `probe-results.json` / `supplemental-results.json`. Network-error tests correctly retained last valid observations.
- **Affected:** [market.js:76](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/market.js:76), `toObservation` / `refresh`; [portfolio.js:294](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js:294), `priceFor`.
- **Impact:** portfolio value can disappear or become negative while freshness appears healthy.
- **Fix / effort:** validate tracked identity, non-negative/positive-as-defined price and parseable plausible timestamp per asset; keep prior valid quote on invalid rows; record row errors and stale coverage; reject older completions. Decide explicitly how a genuine zero price is represented. 1–2 days.
- **Acceptance:** null/negative/invalid-date/untracked/stale-out-of-order rows cannot replace a valid quote; missing IDs preserve prior timestamps; the UI displays failure and quote age without claiming full freshness.

### F11 — P2: request receipts can call a failed import done

- **Evidence:** a short queued report received receipt **done**, nested result **failed** (“under 400 characters”). `probe-results.json`. `processOne` treats any non-throwing action return as successful. Requests are parsed immediately without the report inbox's file-settling convention; partial JSON may be failed/moved while still being written (code-inspected, not a timed writer reproduction).
- **Affected:** [requests.js:39](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/requests.js:39), `processOne` / `finish` and job summary consumers.
- **Impact:** Cowork/dashboard can assert a report was saved when it was rejected; partially written requests can be prematurely failed.
- **Fix / effort:** define outcomes for each allowed action: committed/unchanged, rejected/failed, or pending/deferred. Normalize nested results before receipt. Require atomic queue-file publication, or settle/retry incomplete files without erasing evidence. 1–2 days, shared with F01.
- **Acceptance:** short/prompt/provider-mismatched reports receive truthful non-done receipts; a slowly completed or atomically renamed valid request remains pending until usable and commits once. Job summaries match outcomes.

### F12 — P2: comparison windows and horizon normalization admit mismatched reports

- **Evidence:** dates August 1, August 21 and September 10 all compared under a 30-day window, though the span is 40 days. `12–24 months` and `24 months` both normalize to `24m`. `probe-results.json`.
- **Affected:** [compare.js:31](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/compare.js:31), anchor-based `comparability`; [reports.js:442](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/reports.js:442), `normalizeHorizon`.
- **Impact:** tables show comparable spreads/medians for analyses whose time assumptions differ.
- **Fix / effort:** select groups with `max(date)-min(date) <= window`; represent horizon as a validated interval with unit and retain raw text. Include material assumptions and evidence context or explicitly report unknown comparability. 1–2 days.
- **Acceptance:** the 40-day triple is not one comparable set, range and single horizons remain distinct, equivalent explicit units compare correctly, and exclusions explain the actual reason.

### F13 — P2: contradiction/spread flags ignore dates and applicability

- **Evidence:** TVL 100 on August 1 versus 200 on September 1, with one definition unstated, generated a 50% contradiction. General-token credit-risk transparency values 20 and 80 generated spread 60 even though the category is N/A under that profile. `probe-results.json`.
- **Affected:** [compare.js:94](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/compare.js:94), `rowFor`; `claimConflicts` at 161. Parser says inapplicable scores are excluded, but comparison does not enforce that rule.
- **Impact:** false disagreement/conviction signals and PayFi assumptions leak into unrelated sectors.
- **Fix / effort:** exclude inapplicable categories from computed spreads while preserving raw inputs visibly; compare metric entity/chain, definition, unit, period and as-of interval first. Date changes should be labeled changes; missing context should be unresolved. 1–2 days.
- **Acceptance:** these probes produce N/A or date/definition-context labels; genuinely simultaneous incompatible values still flag contradiction; higher-is-worse risk direction stays explicit.

### F14 — P2: evidence references can dangle without validation

- **Evidence:** a claim and component referencing nonexistent IDs yielded validation issues `[]`. `probe-results.json`. URLs are restricted to HTTP(S), which is a positive control.
- **Affected:** [reports.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/reports.js), source/claim/score normalization and schema checks; evidence projection in `indexer`.
- **Impact:** a report can look cited while links resolve to no evidence, and ingestion completeness can be mistaken for corroboration.
- **Fix / effort:** uniqueness and referential-integrity validation for sources, claims, score evidence refs, scenarios and thesis links; preserve errors and make affected fields unsupported rather than silently discarding refs. Add separate corroboration status with dated captures. 1–2 days for structural checks; capture workflow later.
- **Acceptance:** dangling/duplicate IDs are visible with exact paths; broken references cannot earn a “supported” badge; [V]/[C]/[I]/[S] remain unchanged and “imported” never implies verified fact.

### F15 — P2: prose provider claims can conflict with inbox provenance

- **Evidence:** prose beginning `Model: Gemini (Google)` imported successfully through the Claude path. Structured JSON provider mismatches are tested/blocked. `probe-results.json`.
- **Affected:** [inbox.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/inbox.js), claimed-provider checks; prose metadata extraction in `reports`.
- **Impact:** comparison rows can be assigned to the wrong provider; model-version text is also self-reported.
- **Fix / effort:** retain declared provider/model separately from ingestion channel and attested metadata; block or quarantine an explicit conflict; ask for owner correction without modifying the original. Treat absent prose declarations as unverified, not attested. 0.5–1 day.
- **Acceptance:** explicit Gemini-in-Claude prose is surfaced as mismatch; ambiguous/absent labels preserve raw provenance; structured provider matching and cross-provider comparisons remain correct.

### F16 — P2: the live runtime is out of support

- **Evidence:** `runtime-and-schedule.json` resolves Node **20.20.2** through Volta. Node's official schedule marks v20 EOL April 30, 2026; v24 is LTS at this audit date. [Node release schedule](https://github.com/nodejs/Release).
- **Affected:** launchers, `scheduled-run.cmd`, developer/runtime instructions; all server/CLI execution.
- **Impact:** the otherwise dependency-free application still depends on an unsupported runtime, and PATH resolution can drift between interactive and scheduled use.
- **Fix / effort:** separately approved follow-up to test and pin a patched Node 24 LTS runtime for this project/task. No installation was attempted in the audit. 1–2 days.
- **Acceptance:** all existing/new focused tests pass on the selected runtime; launcher and a disposable scheduled execution report the same executable/version/root; the previous runtime remains available for code rollback until acceptance.

### F17 — P2: independent runners overlap and failure backoff differs

- **Evidence:** `server.js` foreground timer checks each minute and bypasses `jobs.isDue`; after failure it can retry every minute rather than the background ten-minute backoff. Market requests execute outside the workspace lock, then write in response-arrival order. Job due-state is read before execution without a cross-process job lease. These overlap/out-of-order risks are code-inspected; a live provider race was not induced.
- **Affected:** [server.js:318](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/server.js:318), `marketTick`; [jobs.js:29](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/jobs.js:29), `isDue` / `runJob` / `runJobs`; `market.refresh`.
- **Impact:** avoidable provider calls/rate-limit loops, duplicate daily work and potentially older quotes replacing newer ones. Scheduler `IgnoreNew` does not cover foreground/CLI runners.
- **Fix / effort:** per-job cross-process single-flight/lease, consistent due/backoff policy, request budgets, Retry-After plus capped jitter and monotonic per-asset freshness. 2–3 days.
- **Acceptance:** concurrent scheduler/CLI/dashboard attempts perform one due run; mocked 429/timeouts back off identically; delayed responses cannot regress timestamps; daily artifacts are not duplicated.

### F18 — P2: browser “complete” JSON export omits material records

- **Evidence:** browser export keys omit CLI export `settings`, `rubrics`, portfolio `assets` and `events`; browser market export contains latest, not the full history/status package. `probe-results.json`, “Web versus CLI export fields.” CLI export has separate original-copy handling for binary reports; a browser JSON file is not a backup.
- **Affected:** [exporter.js:173](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/exporter.js:173), `exportJson` versus `exportAll`; [imports.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/imports.js), Data/exports tab.
- **Impact:** a user can retain a “complete” download expecting a reconstructible desk and lose registry, settings, event or binary-original context.
- **Fix / effort:** publish an explicit export inventory and distinct names for portable research/portfolio JSON versus verified backup. Offer one complete package with all originals, rubric/prompt versions, registry and required histories. 1–2 days.
- **Acceptance:** a fixture containing PDF, correction, custom asset, event and versioned rubric can be reconstructed in a clean folder from the complete package; partial exports state omissions before download.

### F19 — P2: isolated desk status can report the real installed task

- **Evidence:** isolated doctor reports the globally installed real `\CryptoResearch\Hourly` task; schedule inspection is not scoped to the current workspace/action working directory. `isolated-doctor.json` versus `runtime-and-schedule.json`.
- **Affected:** [schedule.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/schedule.js), status lookup; doctor/API scheduler presentation.
- **Impact:** a demo or moved desk can appear scheduled even when the installed action targets another root. A ready task is not proof it processes the current folder.
- **Fix / effort:** compare task action, working directory and workspace identity against the inspected desk; show installed elsewhere / mismatched rather than healthy. 0.5–1 day.
- **Acceptance:** two roots report accurate task ownership; a copied/moved workspace cannot inherit a green scheduler status; real task definition stays untouched during tests.

### F20 — P2: dust and closed-position fees disappear

- **Evidence:** accepted purchase of `5e-10` yields one transaction and **zero positions**. A $10 buy + $1 fee and $12 sale − $1 fee realizes zero and leaves **fees $0**, though $2 was paid. `probe-results.json`.
- **Affected:** [portfolio.js:19](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js:19), global `EPS`; position filter at 527; aggregate fees based on retained positions.
- **Impact:** owned amounts and historical costs are silently omitted. JavaScript Number arithmetic adds a broader precision risk; extreme balances were not exhaustively tested.
- **Fix / effort:** explicit asset decimal quantization and conservation with exact representations; keep transaction-level realized/fee aggregates independent of position visibility. Reject unsupported precision clearly rather than accepting and hiding it. 1 day for fee totals; 3–5 days for a preserved-input decimal migration.
- **Acceptance:** positive supported dust survives or is explicitly rejected; fully closed breakeven/loss/profit positions preserve all fees; decimal split/merge/transfer examples reconcile exactly within the declared precision.

### F21 — P2: bridge and BTC benchmark conventions need explicit incomplete states

- **Evidence:** same transfer ID crossing two different economic asset IDs produced an outbound one-unit in-transit position plus a one-unit unknown-basis inbound position, with mismatch warnings. `supplemental-results.json`. BTC formula/conventions were traced in `portfolio.js`; no full external performance-accounting reference model was established.
- **Affected:** [portfolio.js:441](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/portfolio.js:441), transfer reconciliation and BTC benchmark; portfolio/project presentation.
- **Impact:** unsupported wrapper/conversion input can show two economic exposures, and a capital/proceeds BTC comparison can be read as a time-weighted return or held-BTC counterfactual. The warning and unknown basis are useful, but totals need matching qualification.
- **Fix / effort:** quarantine unmatched conversion pairs from definitive combined exposure; require verified economic equivalence/conversion ratio. Document benchmark cash-flow convention, income/fees and historical BTC-price coverage; withhold an authoritative result when prerequisites are incomplete. 1–2 days for qualification; extended benchmark specification later.
- **Acceptance:** unmatched bridges cannot yield an unqualified total; same-ID bridges preserve basis; independently calculated buys, partial sales, income, fees and cash flows match the named benchmark method. TWR/IRR labels are not used for this formula.

### F22 — P3: source-prompt and workflow documentation has drifted

- **Evidence:** the Huma run-2 source prompt now exists, but README/source-template text still says it was not attached. Run-2 ChatGPT/Gemini prompt files exist under `prompts/run2`, while the dashboard serves the normal provider prompt paths. Cowork instructions contain environment-specific shell assumptions. Current Cowork surfaces are changing under a documented rollout, so capability should be discovered. [Current Cowork documentation](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile).
- **Affected:** [README.md](C:/Users/Kuaya/Documents/CryptoResearch/README.md), [COWORK-INSTRUCTIONS.md](C:/Users/Kuaya/Documents/CryptoResearch/COWORK-INSTRUCTIONS.md), templates/source-prompts and project prompt UI.
- **Impact:** a user/model may choose a different prompt from the imported report's declared version or assert local save capabilities it does not have.
- **Fix / effort:** reconcile docs with actual paths; expose prompt version/hash and selection; provide Windows PowerShell and queued-folder routes selected by verified capability. 0.5–1 day.
- **Acceptance:** a new user can identify the exact source prompt behind a report and run the documented route in the available environment. Inaccessible folder/shell capability is reported as pending/unverified, never saved.

## Observed usability problems

### U01 — P2: tablet and phone tables overflow the whole page

- **Evidence:** settled project page body width **1280 px** at both 768 and 390 px viewports. At 390 px, holdings body width 1175 and evidence 1145. At 768 px, several main views overflowed; see `browser-checks.json`. Verified 1440 desktop body was 1425 (scrollbar accounted for), and main content fit the viewport; no desktop clipping conclusion is made.
- **Affected:** [styles.css:144](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/styles.css:144), responsive grid/main sizing and `.table-wrap`; holdings, evidence and project sections.
- **Impact:** navigation and key actions require whole-page panning; table scroll containers do not contain intrinsic width.
- **Fix / effort:** zero minimum width on grid/content children; use `minmax(0,1fr)` as appropriate; bound table wrappers; prioritize mobile columns and expose row details. 1–2 days.
- **Acceptance:** at 1440/768/390, document width is at most viewport width (allowing rounding), each wide table scrolls inside its own labeled region, and all actions remain reachable by keyboard/touch.

### U02 — P2: import feedback disappears after refresh

- **Evidence:** submitting a short paste showed no persistent result and cleared the form after the refresh; the failed item was later visible in Inbox/Requests. `14-failed-import-inbox.jpg` and browser state logs. The result is written into a node replaced by `ctx.refresh`.
- **Affected:** [imports.js:47](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/imports.js:47), report paste/upload result and refresh sequence.
- **Impact:** a user cannot tell whether content was saved or rejected, and may repeat the request or lose the text needed to correct it.
- **Fix / effort:** persistent result/draft state, receipt link and status announcement; clear input only on verified successful commit; retain rejected text with reason. 0.5–1 day.
- **Acceptance:** success/failure/pending messages survive rerender, failed text remains recoverable, and the displayed result agrees with the durable receipt/import state.

### U03 — P2: unpriced holdings produce a prominent $0.00 total

- **Evidence:** synthetic 10-unit holding with $50 known cost and no price showed “Portfolio value $0.00,” with a small unpriced count. Core value was a priced subtotal 0, not an actual known zero value. [Desktop screenshot](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/screenshots/16-unpriced-total-desktop.jpg), `restart-check.json`.
- **Affected:** [overview.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/overview.js), valuation header, allocation and coverage labels.
- **Impact:** missing data looks like a total loss or an empty portfolio, and allocation percentages can appear complete while excluding positions.
- **Fix / effort:** “priced subtotal” plus prominent coverage/unknown count; with all assets unpriced, show value unknown, not $0. Distinguish no holdings from holdings awaiting prices; qualify allocations and cost coverage. 0.5–1 day.
- **Acceptance:** empty, all-unpriced, partly priced, stale-priced and genuinely zero-valued states have distinct truthful headers and denominators.

### U04 — P3: hierarchy, navigation and contrast slow review

- **Evidence:** priorities and daily review repeat issues; project sections form an approximately 7000-pixel page and section clicks smooth-scroll without distinct URLs. Native Tab focus was visible, and project search successfully filtered pending projects. Measured faint text `#8a929d`: approximately **3.14:1** on white, **2.88:1** on `#f4f5f7`; normal small text falls below 4.5:1. [W3C contrast requirement](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Full screen-reader/WCAG conformance was not tested.
- **Affected:** [project.js](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/public/views/project.js), navigation and eager sections; public styles; tab semantics and overview density.
- **Impact:** important review actions compete with repeated status cards; context cannot be bookmarked; low-contrast small labels are harder to read.
- **Fix / effort:** one ranked review queue, changes-since-review block, lazy addressable sections, stronger text contrast and proper tab/region keyboard semantics. 2–3 days.
- **Acceptance:** a user can answer owned/watchlisted/changed/review/disagreement/evidence questions without scanning duplicate blocks; section URLs/back restore context; contrast passes on actual backgrounds; keyboard traversal and status announcements work. See [DESIGN.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/DESIGN.md).

## Optional enhancements — separate from defects

| ID | Opportunity | Benefit / effort | Acceptance before promotion |
|---|---|---|---|
| E01 | Changes since the owner's last review, with old/new claim links | A daily desk instead of a collection of latest reports; 2–3 days | Stable review cursor, historical evidence retained, no implicit thesis replacement. |
| E02 | Small sector-specific evidence adapters | Fill liquidity, usage, value-capture and unlock gaps; 1–3 days per initial adapter | Contract/entity matching, dated raw payload, definitions, stale fallback and cost cap. Roadmap has current sources. |
| E03 | Owner review queue for proposed thesis changes | Keep model output separate from conviction and decisions; 2–3 days | Proposals cite report IDs and unresolved conflicts; only an explicit owner action selects/changes thesis. |
| E04 | Independent-location verified backup and periodic restore drill | Recovery from disk loss; 1–2 days after F06 | User-selected destination, no external upload during audit, checksum and reconciliation success. |
| E05 | Capped, scheduled model evidence watch after core repairs | Reduced manual collection with visible provenance; 3–5 days for one provider | Persist prompt/original/attested metadata, hard spend ceiling, abort control and owner review; no trades. |
| E06 | Focused diagnostic bundle and repeatable UI smoke checks | Lower maintenance effort; 1–2 days | No secrets/private content in shareable diagnostics; deterministic coverage of supported formats and width/state matrix. |
