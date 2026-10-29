# Fixes for the post-implementation audit (2026-10-29)

Answers [POST_IMPLEMENTATION_AUDIT.md](POST_IMPLEMENTATION_AUDIT.md), Codex's audit of the merged intake dialectic at `a7598ba` (same tree as `origin/main` `1d182f2`), which returned **NO-GO (Fixes Required)** with six defects, F1–F6. All six are fixed on `claude/intake-audit-fixes`, each with regressions that fail on the audited code and pass now, and so is a seventh found by the new browser case. Nothing is committed yet; the commit pins for a re-audit are the ones Eric merges.

No protected file changed (`paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js` and their tests: no diff against `origin/main`). No prompt template, profile, rubric or schema was edited. `screening.js`, `forensics.js` and `ops.js` are unchanged. No provider, model or network was asked for anything: every test and browser case runs on a fictional temporary desk with a fake fetch.

## Before and after

| Check | Before (the audit, at `a7598ba`) | After (this branch) |
|---|---|---|
| `node dashboard/cli.js test` | 1218/1218 | **1230/1230**, 0 failed (12 new) |
| `npm run ui:build` | passed | passed (Review.jsx changed; bundle rebuilt, `build.json` current) |
| `scripts/check.mjs` | 93 printed `ok`, 0 failed | **100 printed `ok`, 0 failed**, "All browser checks passed" (7 new, 2 new pages in its page list) |
| `scripts/regress.mjs` | 86/86 | **86/86** on the seeded dev desk |
| Audit reproductions | 6 defects confirmed (7/7 observations) | 0: each is now a regression asserting the corrected outcome |
| New regressions on the audited code | — | 11 of 12 fail (10 for F1–F6, 1 for the bug the browser case found); the 12th (a held model stays unsent) is a control that passes on both |
| Populated browser cases for leads and the challenge | none | 7 assertions on a seeded fictional desk (below) |

One run of `check.mjs` made while the full suite ran beside it timed out drawing the Evidence page ("evidence never drew"), which this work does not touch; run on its own it passed, as did the run before it.

## F1 — a reused run or project is now recorded under the admission's key

`dashboard/core/research.js`, `projects.js`, `leads.js`.

- `createRun` with an idempotency key resolves a reused recent run inside the lock, as a `research_run_link` operation, and writes a resolution record (`logs/resolutions/<key>.json`, create-only, `projects.js` `stageResolution`), so the key has an applied receipt even when nothing else is staged. The run is re-read under the lock; one gone meanwhile is `CHANGED`. A run created meanwhile by someone else is linked, not doubled. The result names its basis, `created` or `existing_recent`.
- `addProject` does the same for a strong duplicate (`add_project_link`, basis `created` or `existing`); a duplicate that changed or was archived since is `CHANGED`.
- A replay under the key returns the recorded result whatever has happened to the run since (finished, aged out of "recent"); another payload under the key is `CONFLICT`. Unkeyed callers behave as before.
- The admission freezes its effects' payload hashes when it is written (`effect_keys`), so recovery never derives them again. Admissions written before this keep the old derivation.

Regressions: a crash after selecting a recent run, then that run ageing out, still links the original; keyed links to an existing project and a recent run are recorded, replayed, and a different payload is a conflict; the hashes are frozen at write.

## F2 — recovery never changes the route Eric confirmed

`research.js` (`routeOf`, `budgetScope`, `checkConsent`), `intake.js`, `leads.js`.

- The admission passes its frozen envelope to `createRun` as `consent: { routes, budget_scope }`. A model whose route differs from the one confirmed (a connection or pasted prompt then, an API now, or the reverse), or changed spending limits while any route is an API, is `CONSENT_CHANGED` and creates no run and no job.
- The admission's research effect becomes `needs_consent`: not pending, never retried by the job or by Complete, never lapsing. Its words say what changed ("Claude was its connection or a pasted prompt when you confirmed, its API now"). Review offers **Request research**, which confirms again with the routes as they are now (`requestAgain` accepts `lapsed` and `needs_consent`).
- The frozen provider set is unchanged; a model held after the confirm keeps its job, which stays unsent.

Regressions: a manual-to-API change during recovery creates no due API job, Complete does not retry it, Request research completes it; a changed budget with an API route has the same outcome; a held model's job stays unsent (the control).

## F3 — one failed effect no longer aborts the batch or loses its receipts

`leads.js` (`attempt`, `failStep`).

- After the confirm commits, each admission is attempted on its own (`attempt` never throws). Each step (intake, project, run, link) records its own failure in words; the other admissions still complete, and the answer always carries every committed admission.
- A failure that could not itself be recorded is answered as such (`recorded: false`, "this try was not recorded"), never as saved.

Regressions: an intake failure on the first row still answers every admission and the others complete, a replay finishes it once; a middle row whose link failed after its project and run committed is finished by a replay without doubling; an unrecordable failure is said as not recorded.

## F4 — an altered challenge record shows no verdict

`dashboard/core/ticket-challenges.js`.

- The challenge receipt's exact bytes are pinned in its job (`job.receipt_sha256[<receipt>]`) in the same save. Every read checks the pin, the Markdown's hash, the target, and the answer block re-found in the Markdown (`block_sha256`), then re-checks that block and compares what is shown (tests, assessed count, critique, verdict, reason, sources, model version) with it.
- Any difference is `integrity`, "Challenge not shown: its record does not match the ticket receipt.", with no verdict or tests. Reading never rewrites anything. Saving the same text again while its record does not hold is `INTEGRITY`.

Regression: a receipt JSON altered in its verdict, its tests, its assessed count or its reason, with its pin rewritten to match or not, shows no verdict; a receipt with no pin is not shown; reading writes nothing.

**Residual, by design:** a challenge receipt saved before the pin existed has no pin and is not shown. Whether the online desk holds any was not checked; production records were not read.

## F5 — Solana eligibility keeps scheduled fees, hooks and transferability

`leads.js` (`screenFacts`, `judge`), `web/src/views/review/Review.jsx`.

- The facts keep `transfer_fee_scheduled_max_pct`, `transfer_hook` and `non_transferable`. The fee judged is the higher of the fee now and every scheduled fee, only when both are known; otherwise `INCOMPLETE`. A token that cannot be transferred is `REFUSED`; unknown is `INCOMPLETE`. A transfer hook is `NEEDS_REVIEW`; unknown is `INCOMPLETE`. This matches `forensics.js` `solanaTaxPct`; the shared normalizer is unchanged.
- Review says it: "Transfer fee now 0%, highest scheduled 3%" and "Not transferable: No · Transfer hook: Yes".

Regression: a scheduled fee above the limit at zero now is refused; a partial or missing schedule is incomplete; non-transferable is refused and unknown is incomplete; a hook needs review and unknown is incomplete; a fully known zero-fee token is eligible.

## F6 — the receipt admitted is the one Eric reviewed

`leads.js` (`rowCheck`), `Review.jsx`.

- Inside the confirm's lock, the receipt actually read is checked against both the reviewed row and the asset's pin (ID and SHA-256), and for its asset and identity, the asset revision it was made at, `ELIGIBLE`, the policy version and hash, and expiry against the lock-time clock. The admission is written from that checked receipt.
- The page now sends `asset_revision` beside `identity_revision`, and the confirm requires it; a new claim since the review is a difference. A new sighting of the same lead does not change the revision, so it is not.

Regression: a receipt replaced under the same ID with a valid self-hash, a different state and an unreviewed name, and a new claim since the review, are each `409 CHANGED` naming the field, with nothing written; a new sighting confirms.

## Found by the populated browser case: Request research showed the old admission

Not in the audit; present at `a7598ba` for a lapsed admission and reached by `needs_consent` too. `leads.js` `reviewView` chose a lead's admission by the last file in ID order, which says nothing about time. After Request research, whose new admission's ID can sort before the one it follows, the row could keep the superseded admission and its Request research button; a second click made a third admission.

- A lead's row now shows its current admission: the one no later request follows, else the latest made.
- `requestAgain` on an admission already followed is `409 CONFLICT` naming the one that follows, with nothing written.

Regression: a request whose new admission sorts before its predecessor; the row shows the new one, complete; asking again on the old one is a conflict that writes nothing; one run. It fails with these two changes reverted ("the row shows the admission that follows") and passes with them.

## Punch list

- **PLAN.md** (revision 2.1 note at its head): an admission is written once and then records only its effects' progress through `updateAdmission`; its frozen fields never change (§5, was "create-only"). Admission recovery and claim writes run outside the 20-second network phase (§4, B4).
- **`.gitignore`:** this file and the audit are tracked beside README, PLAN and AUDIT-RESPONSE.
- **Populated browser cases** (`dashboard/web/scripts/dev-desk.cjs`, `check.mjs`): the fictional dev desk now has a lead policy and six scout leads read by the real eligibility turn over a fake fetch (one complete, one failed, one needing consent, two eligible, a Solana lead needing review) and two Prosecutor tickets with a saved ChatGPT challenge (Northwind's holds, Atlas's record was altered). `check.mjs` opens Review > Imports > Scout leads and the ticket inspector among its pages (no writes or errors on opening, names, contrast), then asserts:
  1. each admission state in words with its one action (Complete for the failed one, Request research and never Complete for the one needing consent), nothing written on opening;
  2. the Solana row names its fee now, its highest scheduled fee and its hook;
  3. Complete, 4. Request research and 5. Confirm each send exactly one request and the admission reads complete (4 failed until the fix above);
  6. the PM card's ChatGPT row reads the saved verdict with its four tests on Northwind, and 7. "Challenge not shown" with no verdict on Atlas, each writing nothing.

## What this does not establish

The online desk's records, deployment and production state were not read or changed. The re-audit of the resulting commit pins is Codex's; until then the audit's NO-GO stands for activating the pipeline.
