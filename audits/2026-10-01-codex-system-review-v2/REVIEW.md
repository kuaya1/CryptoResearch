# CryptoResearch — independent system review v2

Reviewed October 1, 2026, America/New_York. Audit only; no application fixes implemented.

**The application substantially fulfills the visual and manual research parts of your mission, but does not yet fulfill the reliability standard for the complete research desk.** The new interface is coherent, restrained, and considerably easier to use. Manual research, source-labeled prices, separate provider states, original reports, and the separation of watchlist and holdings work in the tested workflows. Consistent reads, restoration boundaries, paid-call recovery, spending limits, and multiple visible dashboard tabs still have demonstrated defects.

**Mission-weighted assessment: 74.7/100, C.** This is an engineering/product judgment of the inspected code and isolated behavior, with partial operational validation. All ten categories have source and meaningful local evidence; none is silently treated as fully validated. The shared real dashboard was unavailable on every audit connection attempt, paid integrations remain unconfigured, and there was no live Cowork/voice, screen-reader, or physical-phone acceptance session. Those limitations constrain this verdict.

## Readiness

| Intended use | Verdict | Reason |
|---|---|---|
| Daily watchlist and manual research | Conditionally usable | The tested add/filter/preview/panel/report/copy/import workflow works. Fix V2-001 before claiming reliable simultaneous reads and writes. V2-006 also prevents an unconditional multi-window reliability claim. The real server was unavailable during this audit. |
| Authoritative portfolio | Not ready for an authoritative designation | FIFO, fees, transfers, dust, and uncertainty handling improved substantially. Shared readers can still return mixed generations (V2-001). Restoration can escape its destination (V2-002). Correct arithmetic does not remove those integrity blockers. |
| Cowork intake | File/CLI contract verified locally; live acceptance outstanding | Queue crash/idempotency/conflict tests pass. Documentation and manual routes agree with the source. Actual Cowork discovery, execution, voice intent, and completion feedback were unavailable. |
| Unattended multi-model research | Not ready | V2-003 permits replay of potentially charged requests. V2-004/005 undermine the advertised spending bounds. Real keys, model IDs, prices, and budgets are absent and unattended research is off. |

These verdicts take precedence over the aggregate score.

## Mission-weighted scorecard

Letters: A 90–100; B 80–89; C 70–79; D 60–69; F below 60. “Partial” refers to the explicitly missing operational or acceptance evidence, not a missing category. Confidence describes the judgment at this inspected revision.

| Category | Weight | Score | Strongest evidence | Principal deductions | Coverage | Confidence |
|---|---:|---:|---|---|---|---|
| Daily watchlist usability and mission fit | 15% | 84 B | Actual filter/sort, readable persistent preview, selected panel, Back/Esc, saved add, manual prompt/import/dedup, live Re-sort | Some requested market fields disappear at common widths; reliable concurrent reads and many visible windows remain conditional | Source and completed fixture workflows; real deployment UI unavailable | Moderate–high |
| Minimal visual design and responsive layout | 10% | 86 B | Direct visual inspection; all five main views at 320/390/768/1280/1600; eight project sections at 320/1440; sparse copied-record list | Phone research tables require substantial internal scrolling; visual/native 200% enlargement not verified; secondary text remains relatively small | Rendered current code and screenshots; physical device and dark-mode review incomplete | Moderate–high |
| Source-code quality, performance, and lifecycle | 15% | 72 C | Small dependency-free modules, 109 passing tests, bounded reload/connection measurements, lifecycle source trace | Remaining SSE saturation; browser fetches lack bounded cancellation/timeouts; default consistent-read fallback is unsafe. No long-term heap/leak proof | Source, single-window reloads, restart and visible multi-tab exercise; native background/BFCache incomplete | Moderate |
| Imports, durable records, and recovery | 15% | 58 F | Original bytes retained; truthful saved/rejected/duplicate receipts; queue effect/receipt crash tests; successful legitimate sealed backup/package restores | V2-001 mixed generations and V2-002 destination escape are blockers despite successful normal restore | Source, real metadata read-only, isolated adversarial and interrupted operations | High for reproduced failures |
| Research grading, comparison, and evidence | 15% | 87 B | Pinned historical rubrics; unknown-version withholding; horizon/date/metric/citation regressions; separate score panels and provider provenance | No independent live provider research; source references and model agreement still require human corroboration; reported model identity is not attestation | Source, saved records, fixtures, browser scorecards/evidence; live model quality unassessed | High for local rules; moderate overall |
| Market accuracy and freshness | 5% | 84 B | Partial/invalid/offline/older/rate-limit tests preserve last good data; small-price precision; honest fictional and CoinGecko labels | V2-007 understates failed multi-chunk calls; search budgeting is not a comprehensive concurrent reservation system; source data correctness itself not independently certified | Source, recorded real observations, local responses and UI stale states | Moderate–high |
| Cowork workflow and automation | 10% | 55 F | Durable intake/conflict tests; partial provider success; installed task ownership/runtime inspected; manual run completes from import | Paid replay, run-budget and search-bound defects; real providers unconfigured; live Cowork/voice absent; interactive Windows task requires PC on and user logged in | Source and process/queue/provider stubs; operational acceptance partial | High for blockers; moderate for integration |
| Accessibility and input methods | 5% | 76 C | Keyboard preview/Enter/Esc, visible 2px focus, labeled dialog and inert sheet, sort semantics, representative reflow, rendered contrast | Hover detail is aria-hidden; equivalent detail requires opening the panel. No screen-reader, physical touch, or native 200% zoom session; complete status-announcement behavior not certified | Mouse/keyboard and DOM semantics inspected; assistive technology partial | Moderate |
| Security and privacy | 5% | 64 D | Loopback/Host/token/Origin/CSP controls verified; hostile valid-length report inert; CSV injection regression; secrets stored outside workspace | V2-002 permits file writes outside a restore destination. Digest integrity is not proof of a safe path or trusted package | Source plus meaningful local HTTP/content/restore attacks; no external penetration test | High for demonstrated boundary failure |
| Portfolio accounting | 5% | 85 B | Independent transferred-lot FIFO, collisions, fees, dust, closed fees, bridge quarantine and conservation; disclosed BTC capital comparison | Shared snapshot integrity remains blocking; financial summaries are local-record calculations, with explicit unknown basis/valuation limits | Arithmetic/records tested deeply; no live exchange integration expected or claimed | High for tested cases; moderate for general accounting |

Calculation: `84×.15 + 86×.10 + 72×.15 + 58×.15 + 87×.15 + 84×.05 + 55×.10 + 76×.05 + 64×.05 + 85×.05 = 74.7`.

## What to keep, improve, add, and remove

**Keep** the neutral design, measured column fitting, three distinct provider badges, explicit manual/failed/withheld/PDF states, beside-the-list desktop panel, phone sheet, grouped report list/reader, preserved originals, immutable scoring versions, explicit owner thesis, and transaction-only holdings. These are useful platform improvements, independent of HUMA or Allora's investment merits.

**Improve** integrity and lifecycle behavior before another redesign. Normal import receipts and historical rubric handling are substantially stronger than v1, but read consistency and restoration need the same care as writes. Paid jobs require an explicit uncertain/reconciliation state and enforceable aggregate spending policy.

**Add** the specific regression cases in FINDINGS and a native accessibility/integration acceptance session after those fixes. **Remove** unconditional “estimated maximum/within budget” assurances until they correspond to actual provider controls, and remove blind automatic replay of uncertain paid attempts. New news feeds, liquidity providers, CoinMarketCap integration, themes, and broad framework changes are not the next priority.

Next five concrete actions:

1. Make production consistent reads fail closed or return a previously verified generation (V2-001).
2. Preflight and contain every package/backup path before restoring any file (V2-002).
3. Reconcile interrupted paid attempts and discover already saved responses without dispatching again (V2-003).
4. Enforce aggregate run spending and truthful provider/search bounds together (V2-004/005).
5. Prevent visible-tab SSE connection starvation and bound browser requests while retaining nondisruptive updates (V2-006).

## Lifecycle conclusion

The latest code closes its EventSource on pagehide and after 15 seconds hidden, reconnects with catch-up on foreground/BFCache return, and removes server ping timers and client entries on disconnect. It does not merely raise a connection limit. Fifteen independent full reloads completed in roughly 145–178ms with no growing SSE count. Hash-route navigation, live updates, and isolated server restart also worked.

However, six simultaneously visible dashboard documents held six SSE connections. The seventh navigation timed out while instrumentation showed exactly six active streams and six sockets. Closing live extra tabs freed streams; a fresh tab then loaded normally. This supports HTTP/1 connection starvation in that tested scenario. It does **not** establish a CPU loop or prove the historical BFCache cause. The browser-control environment kept these documents visible, so ordinary hidden-tab behavior is not inferred from this result. The HTTP/1 SSE connection limitation is documented by [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).

The old raw sweep has 41 saved route entries and 26 problem records covering **13 distinct width/route pairs**. “26 of 41 loads froze” overstates what those records establish. Many frozen checks could not pause the page for a stack. The new sweep and this audit support a useful single-window improvement, with a remaining multi-visible-window problem.

## Operational reality and target

Actual workspace: `ws_rzn5w5pudi`, kind `real`, home host `DESKTOP-IILMFLP`, America/New_York. Resolved Node: `v24.21.0`, through the Volta pin. The exact 70-file application/test/fixture/script/package fingerprint is `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0`; individual hashes and scope are in [source-target.json](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/source-target.json).

The launch target is loopback `http://127.0.0.1:4729/`. Its initial saved marker was stale: PID 13960 was not serving. Repeated read-only connections were refused. A later marker and job records show a transient real dashboard start/price refresh at 20:35 ET; its PID 19996 was also absent at final inspection. The initiator was not independently established. A user request to open the existing launcher received no answer during the audit; I did not start or stop the shared server. The real-record visual inspection therefore used a clearly labeled, frozen **test copy** on port 4949. It is not evidence of a live real-dashboard session.

The installed `\CryptoResearch\Hourly` task executes the current workspace's scheduled-run.cmd through conhost/cmd, with an interactive logon principal. Its observed run result was 0. It is a local logged-in-PC task, not an always-on cloud worker. Real Claude/ChatGPT/Gemini API capability was manual/unconfigured; unattended runs and budgets were off/unset. News, liquidity, and literal CoinMarketCap rank were unconfigured. Node 24 is a supported release line; the old Node 20 fallback wording should be tightened because its support ended April 30, 2026. [Node release schedule](https://github.com/nodejs/Release)

## Comparison with review v1

These are the original eight equally weighted domains, assessed under their old scope. They are not the ten-category mission-weighted score above.

| Domain | v1 | v2 | Explanation |
|---|---:|---:|---|
| Code/architecture | 74 C | 79 C | Clearer module/UI structure and meaningful tests; lifecycle and consistency defects remain. |
| Reliability/data integrity | 52 F | 58 F | Queue receipts, locks, quarantine and hashes improved; new read/restore reproductions remain blocking. |
| Security | 78 C | 64 D | Local API/content controls work, but a confirmed Windows restore escape warrants a material deduction. |
| Interface/usability | 63 D | 85 B | Directly verified substantial improvement in hierarchy, previews, panels, manual actions and responsive layout. |
| Research/scoring | 75 C | 87 B | Historical grading, horizons, comparisons, reference checks and provider honesty improved. |
| Portfolio accounting | 48 F | 85 B | FIFO, collisions, fee identities, dust and ambiguous bridge handling fixed in tested cases. Integrity readiness remains separate. |
| Automation/recovery | 64 D | 55 F | Legitimate restores and intake improved; deeper paid-dispatch/budget probes found serious untested windows. |
| Maintainability | 72 C | 78 C | Small codebase, documented workflows, supported pin and recovery copy; need regression evidence at actual production defaults. |

v1 mean `65.75`, reported as **66/100**. v2 mean `73.875`, reported as **74/100**. Improvement is approximately eight points on this comparable domain mean; the new weighted **74.7** uses different weights and must not be presented as the same measurement.

## Evidence and limits

The independent deployed suite passed **109/109**, with no failures, skips or cancellations. The recovery copy passed **103/103** in a separate checkout and produced matching project/provider and portfolio results from copied current records. That establishes compatibility with these current formats, not arbitrary future schema changes or a safe overwrite of code while an old server keeps running.

Final preservation checks matched all 70 source files and the unchanged research/portfolio/configuration records. Eight runtime/index/market/log files changed, with a dashboard refresh and the normal hourly task recorded separately in VALIDATION. No real files were added or removed; scheduled-task XML was unchanged. Audit-created browser tabs and local servers were closed.

Read [FINDINGS.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/FINDINGS.md), [CLAIM-VERIFICATION.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/CLAIM-VERIFICATION.md), and [VALIDATION.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/VALIDATION.md) for reproductions, old-finding closures, exact commands, preservation checks and limitations. [NEXT-IMPLEMENTATION-PROMPT.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/NEXT-IMPLEMENTATION-PROMPT.md) scopes the follow-up to the five actions above.

Independent current-code hover screenshot, using fictional records:

![Independent hover scorecard](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/screenshots/02-hover-scorecard-1440.jpg)
