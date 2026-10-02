# Bounded implementation brief

Implement the five actions below in an isolated development copy of CryptoResearch. Start by reading [REVIEW.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/REVIEW.md), [FINDINGS.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/FINDINGS.md), [CLAIM-VERIFICATION.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/CLAIM-VERIFICATION.md) and [VALIDATION.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review-v2/VALIDATION.md). Check applicable workspace instructions and confirm your starting source hash. The audited 70-file fingerprint is `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0`; if source changed, reconcile these findings with the new revision before editing.

The interface and manual workflow improved substantially. Preserve the restrained neutral design, three provider badges, readable preview, selected desktop summary/phone sheet, original report reader, draft/receipt recovery, immutable grades and transaction-only holdings. This request is for integrity, budget and lifecycle repair, with a concrete reviewable patch and evidence. Do not expand into a redesign, new integrations or framework replacement.

## Preservation and scope

- Work in a separate checkout/copy, with its own Test/Demo workspace ID, loopback ports and immutable source baseline. Do not edit the real project's records, config, credentials, runtime pin, task definitions, reports, lots or queue. Do not start/stop the shared real dashboard, dispatch paid analysis, trade, publish or send external messages.
- Keep the audit directories and recovery copies intact. Copy any reproduction script into a new fixture directory; retained scripts deliberately reject existing scenario roots. All crash/path adversarial outputs must stay within owned fixture parents.
- Preserve original report bytes, provider/provenance, rubric/profile/prompt hashes and full horizon intervals. Any new research-attempt state must retain prior attempts, saved output and costs. Do not automatically retry, cancel, complete or migrate real existing runs while preparing the patch.
- Keep the supported Node 24 pin and dependency-free architecture unless a specific demonstrated requirement justifies a small change. No unrelated refactoring, speculative feeds, CoinMarketCap adapter or arbitrary score target.

## 1. Coherent reads at production defaults — V2-001, related F04

Repair readConsistent and its callers so exhausting retries never invokes an unchecked read over applying files. A read may return one verified generation, use a previously verified snapshot with an honest status, or fail temporarily with a bounded busy response. It must not return mixed generations or coerce unavailable records into empty holdings/zero values.

Preserve lock-owner protection, recovery/quarantine evidence and existing durable write behavior. Make reader error handling explicit in the index/project/API/export/backup paths. Use the existing slow-writer fixture as the failure specification, without depending on increased test-only retry counts.

Acceptance: hold a two-file writer between renames beyond the default retry window and assert a coherent result or explicit busy response; never `[new, old]`. Release it and assert a complete new generation. Test invalid generation/quarantine conditions and the affected server snapshot/export paths. Run those cases with actual production defaults.

## 2. Validate restore paths before any copy — V2-002, related F06/F18

Preflight every entry in both JSON packages and sealed backups before creating/copying restoration content. Normalize Windows and POSIX separators, reject traversal, absolute/drive/UNC/rooted paths, NULs and conflicting normalized names, and verify containment of both backup-source and destination paths. Reuse the workspace safe-path logic where appropriate, strengthening it for the separate restore root. A valid SHA-256 seal authenticates bytes only to the supplied manifest; it does not make a path safe or establish trusted origin.

Acceptance: legitimate complete package and clean sealed backup restore still roundtrip hashes and authoritative totals. Correctly hashed/resealed entries containing `..\\escaped.txt`, `../escaped.txt`, drive/UNC/rooted variants and duplicate normalized targets must fail **before any destination or escaped write**. Invalid late entries must not leave a partially restored destination. Preserve useful errors and explicit restore modes.

## 3. Reconcile interrupted paid attempts — V2-003

Add durable dispatch intent/attempt identity and spending reservation before an external request can start. Interrupted attempts with potentially charged/in-flight requests need an explicit uncertain/reconciliation state. Do not automatically requeue them for another provider call. Discover and validate an existing deterministic saved response file when the process died before its pointer was committed; import that original without another dispatch.

Expose a concise owner decision/status only where needed: response recovered, request outcome uncertain, reconciled, or explicit new retry. Keep historical attempt costs/reservations visible and accounted for. Exactly-once external submission cannot be assumed; use documented provider idempotency only where actually supported, and do not invent it.

Acceptance with injected local stubs: crash before dispatch intent; after intent/before sending; after stub receipt/before returned response; after saved response file/before pointer; after pointer/before import; and after import/before completion receipt. Each saved valid output is imported once, no uncertain attempt blindly redispatches, and a second runner/restart retains state and spend reservation. Explicitly document the unavoidable ambiguous window rather than marking it completed without evidence.

## 4. Aggregate spending and honest tool bounds — V2-004/V2-005

Treat per_run_usd as an aggregate across all provider attempts in that run. Reserve costs atomically across jobs/runners, including retries and uncertain attempts, and reconcile from recorded provider usage. Enforce day/month allowances through the same policy. Validate nonnegative finite settings; preserve zero rather than applying `|| 20`.

Map requested search limits to supported native provider controls, disabling search when zero. Captured Claude max_uses already works. Verify current official OpenAI Responses max_tool_calls semantics and current Gemini grounding billing/capabilities before choosing policy. Distinguish an enforced upper bound from a heuristic estimate. If a model/tool cannot satisfy a hard-budget policy or required costs are missing, decline unattended dispatch with a clear configuration reason. Do not invent an unsupported Gemini cap or silently replace the selected model. Do not enable/configure live providers to validate this patch.

Acceptance: $1.10 run allowance with three $1 stub jobs admits at most the permitted aggregate; concurrent workers cannot oversubscribe run/day/month. Retry and uncertain reservations remain counted. Zero/one/max search captured requests behave correctly per supported provider. Unsupported/unbounded capability is withheld under a hard-budget policy. Simulated high token/tool use reconciles without clearing spend history or retaining a misleading “maximum” label.

## 5. Bounded multi-window updates and requests — V2-006

Choose a small update strategy that avoids consuming one indefinite HTTP/1 SSE connection for every visible document. Shared-stream ownership with a robust fallback or bounded polling are acceptable; justify the choice for a private local app. Keep loopback/token/Host/Origin/CSP controls. Avoid opening SSE on an initially hidden document. Bound/cancel frontend requests, show meaningful connection/retry state, and retain safe session renewal.

Preserve intentional frozen sort order during live changes; Re-sort must apply current data without losing selected project. Do not overwrite draft text/selection, steal focus, reopen dismissed previews or move a report reader unexpectedly. Preserve Enter/Esc/Back, bookmarked panels, nonmodal desktop behavior and inert phone sheets.

Acceptance on an isolated server: at least seven simultaneously visible clients complete navigation and usable API requests; repeated reloads, native background/foreground, pagehide/BFCache, close/reopen, restart and failed-network recovery settle stream/socket/timer counts. Measure completion/timeouts and counts, rather than inferring success from console silence. Test live updates while reading at nonzero scroll, editing a selected draft and filtering/sorting, including unknown-last semantics. Run representative 320/390/768/1280/1600 layouts with all three provider states and a selected panel. Keep physical touch and native accessibility limits explicit.

## Validation, review and rollback

Run the deployed-equivalent regression suite and add meaningful tests for these concrete failure windows. Keep the existing 109 tests, including queue exactly-once local effects, old lock ownership, quarantine, rubric stability, horizon/metric comparisons, originals, CSV safety, market last-good behavior and portfolio conservation. New tests must prove observed outcomes, not only mirror helpers or enlarge deadlines to conceal failures.

Save the final patch, source fingerprint, exact runtime/commands, per-action results, screenshots and remaining limits in a new dated implementation folder. Report readiness by use case; do not declare all findings closed because aggregate counts increased. A live paid/Cowork/screen-reader acceptance session is separate from local stubs.

V2-007, later-chunk market call undercounting, is the next small repair after these five actions. Do not silently add broader work; if addressed later, cover network/timeout/JSON/HTTP failure counts while retaining last good values.

Create and verify a **new current-code** rollback manifest before a future deployment; the pre-design recovery tree is useful evidence but predates these repairs. Document the exact process/launcher to stop before replacing code, and how to confirm it stopped. Closing a browser alone does not prove the server stopped. If new job schema/state is introduced, preserve backward reading or provide a tested migration/rollback plan: reverting code must not erase uncertain attempts, reservations or saved originals. Test both repaired and rollback code on copied records in separate empty workspaces. Never overlay backups onto the real data as a code rollback.

End with the reviewable patch and concrete validation/rollback evidence. Deployment or changes to the shared real environment are outside this implementation brief.
