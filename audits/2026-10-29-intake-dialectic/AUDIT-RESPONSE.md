# Response to the final pre-implementation audit (2026-10-29)

**Status: plan amended, nothing built.** No code, settings, schedules or records were changed, no test file was edited, and no model work was sent. Eric's decisions (PLAN §7, L1–L6) and the first PR wait for his word.

## What was reviewed

- Codex's final pre-implementation audit, `C:\Users\Kuaya\.codex\visualizations\2026\10\29\01a185bf-7e81-71a0-8b17-295a96e9a59f\intake-final-preimplementation-audit\README.md`, SHA-256 `05e87b625d4e4263c3e39d49146c514ca41b44e6c9706078385ec4ec264a403b`. Verdict: NO-GO for the complete plan as written, eight blockers (B1–B8), PR 1 independently reviewable.
- It audited revision 1 of [PLAN.md](PLAN.md) at SHA-256 `c802a5394096c54645885450c03665d8d8f5a85c8a66cbdc52679252453b2860`. That hash was confirmed on this disk before any edit; the audit's own frozen copy is `PLAN.snapshot.md` beside its report.
- Source baseline unchanged: `origin/main` `ac5fc890918c2b1b94b0abc1874ee1d47602f694`, local `claude/p-engine-settlement` `d69f56c638ce2f12e290b4d1e8863227addde2bd`, same tree.

Every code claim in the audit was read on that tree before the plan was amended: `research.js` `createRun` (ten-minute, non-terminal dedup only) and `isDueJob` (a `queued` job is due), `ops.js` `runOp` (`requestId#type` only inside the request queue), `chains.js` (aliases and `addressKey`), `server.js` `DAILY_JOBS` (the hosted timer's own list), `jobs.js` `runJob` (leases only daily jobs and research), `screening.js` (20 s per attempt, `max_attempts` 2, a token request), `intake.js` `intakeModels` (Claude always; holds filtered for the other two only), `mcp.js` `guardIndependence` (report reads and compare only), the root `package.json` (no `check`), `scout.js` `PROMPTS` (`cr-scout-prompt@1` only). All held.

## What changed

[PLAN.md](PLAN.md) is now **revision 2**, SHA-256 `6ab57a524b3b4376076eb07807b9e17f92a6757714b0b3ecba30bb5b1d6a60fd`. Its §10 maps each blocker to the section that resolves it and the PR whose acceptance proves it. In short:

| Blocker | Resolution |
|---|---|
| B1 | `expect` carries each reviewed row's eligibility receipt ID and SHA-256, identity revision, the policy version and hash, and the frozen model envelope; a single row is compared with itself only; unrelated arrivals are reported as `since_shown`, never admitted; a failure after admissions commit returns their receipts |
| B2 | one create-only batch record and one deterministic admission per lead before any effect; `runOp` idempotency keys `admission:<id>#intake`, `#project`, `#research` with payload hashes, passed into `addProject` and `createRun` as an optional argument; recovery by replay, by "Complete", and by the `leads` job's turn, with the envelope and a 24-hour start deadline rechecked before an uncommitted effect |
| B3 | `asset_id` = digest of `[chain_id, address_key]`; the full identity kept inside and checked against the filename on every read; the same tuple for row deduplication, lookup and admission; base58 never lowercased |
| B4 | `leads` in an exported `HOSTED_TIMER_JOBS` with its own lease; one due predicate and a transition table including claim reclamation and `INCOMPLETE`; one monotonic 20-second deadline and 10-request counter shared by the token request, attempts, retries and body reads; finite bounds for every setting; expiry from the desk's send time only |
| B5 | "Confirm and request research" (L6): every held model left out, Claude included; models and routes frozen at the click and never re-derived; `NO_MODEL` when none remains; the words say the existing runner sends an API job by itself |
| B6 | `guardIndependence` on `start_challenge` and `save_challenge`; `pending_challenges` lists a blocked project without content; ChatGPT's hold and the read-only rule applied; Gemini `no_role`; no model-facing view carries a challenge's conclusions |
| B7 | `challenge_verdict` gains `insufficient_evidence` with a reason; the verdict must fit the tests; three chip states; "n of 4 assessed" in words, no score |
| B8 | the ticket pattern: `target.json`, `prompt.md` and receipts create-only; `challenge.json` and `drafts/challenger.md` operational; a different final text is a revision beside the first; every read verifies against the pinned target |

The four smaller clarifications are answered in §10: the check command, the brief kept on `cr-scout-prompt@1` with leads on their own `cr-scout-leads-prompt@1`, explicit envelope limits and quota, and full hashes for every input. The architecture is unchanged: no new service, scheduler, queue or policy platform.

## PR 1 readiness

- The fix is specified to the line (PLAN §3 and PR 1): in `core/scout.js` `makeScoutRoute`'s `refused`, test the key before the lock, count only refusals, and answer 429 without counting while locked.
- No branch or pull request for it exists yet; the last scout branch, `claude/grok-scout`, merged as PR #30.
- The baseline is green: `node --test dashboard/tests/scout-ingest.test.js` passed 14 of 14 on 2026-10-29. One of them, "ten refused keys in 15 minutes lock the key check and the brief, the right key included" (line 190), asserts today's behavior and must be rewritten with the fix.
- It touches no protected file and needs no decision from §7.

## Not done here

- No PR was opened and no test was edited; the plan says the first PR waits for Eric's word.
- The follow-up design review the audit asks for, over revision 2, has not run.
- Nothing about deployed configuration, production records or provider access is established by a plan.
