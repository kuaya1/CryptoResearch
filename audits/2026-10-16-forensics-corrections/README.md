# Forensics corrections and the evidence-change review queue (2026-10-16)

Answers `audits/2026-10-16-codex-forensics-review` (README, FINDINGS, PLAN, VERIFICATION), which reviewed revision `974c6175381bed09f266c30e33e5eb279269c281` and scored the component 58/100. Scope, as asked: correct the review's findings, then deliver only ranked improvement #1, the evidence-change review queue. No rewrite, no storage or hosting change, no new paid or recurring work.

## Baseline and final state

| Item | Baseline | Final |
|---|---|---|
| Branch / revision | `main` · `974c617`, equal to `origin/main`, tree clean | `main` · `974c617` plus these changes, **uncommitted** |
| Deployed (Render `/healthz`) | `974c617…`, started 2026-10-16T06:22:43Z | unchanged: nothing committed, pushed or deployed |
| Later work fixing findings | none (`974c617` changed only backups and disk relief) | n/a |
| Full suite (`node dashboard/cli.js test`) | 662/662 | **690/690** (22 new tests in `tests/forensics-corrections.test.js`; in `tests/forensics.test.js` all 31 kept, 6 updated to the corrected rules; the writer-allowlist test in `tests/web-app.test.js` extended) |
| Browser checks (`npm run check` in `dashboard/web`) | passing | **all pass**, including the new Forensics checks; regression script 78/78 |
| Baseline failures | none | none; no regression open |

One pre-existing timing dependence was found and removed: `forensics.test.js` "the liquidity outcome resolves from the monitor's quotes" relied on the monitor's once-a-day outcome recording falling on a new calendar day during the test, so it passed or failed by the hour it ran. It now records the due outcomes explicitly.

## Finding by finding

| ID | Status | What changed | Proved by |
|---|---|---|---|
| F01 | Reproduced → corrected | One eligibility pass, `cr-forensic-eligibility@1` (`core/forensic-eligibility.js`), feeds coverage, the grades the desk uses, the headline's kind, outcome inputs and discontinuation. A source is usable only with an address or chain reference, a time and something preserved to re-read (excerpt, content hash, block, commit, transaction); attribution is the project's own domain or a chain record; "primary" is the report's label only. A finding's references hold only when all resolve and one is usable; an observation needs a time. Captured measurements must name a chain of the receipt's frozen identity (and its contract when given), cite a usable source and be dated no later than the save. Report values are kept and shown beside the desk's reading ("the report says 99; not used: …"). Passing reads "References hold", never verified. | F01 tests (three), queue mapping tests |
| F02 | Reproduced → corrected | `exitquotes.js`: the CoinGecko platform is chosen by the exact chain (`CG_PLATFORM`, ids checked against the live `/asset_platforms` list 2026-10-16), then its address compared; missing or mismatched means no quote, never another chain's decimals; zero decimals valid; recorded decimals are reused only for the same chain, contract and platform (older records without a platform are not reused). Amounts are exact integer arithmetic from the stored price (`baseUnitsFor`). Each request is checked before sending (`outboundProblem`: origin, chain path, token, quote currency, amount, and that it sells the size asked). | F02 tests: unit and full monitor run (Base $500 at $2 → `250000000`) |
| F03 | Reproduced → corrected | The headline, the finding detail, the liquidity panel and the view share one finding index: `shown_kind` from the eligibility pass, `original_kind` kept, `kind_note` shown beside the headline. Common control on weak bases only reads "Hypothesis, unestablished". The JSON export carries the same reading beside each saved assessment (`desk_reading`). | F03 test, export assertion in the queue backup test |
| F04 | Reproduced → corrected | `verifiedFrozen()` checks the packet and prompt on every handoff (`promptFor`), before every save (both roles) and before a challenge is frozen; `receiptText()` checks a saved text and its JSON block. A mismatch is an `INTEGRITY` refusal (HTTP 409): nothing written, the job not completed, no challenge frozen, the text kept as the job's draft; frozen files are never rebuilt. | F04 test, F12 test (409) |
| F05 | Reproduced → corrected | A revision keeps the origin, deadlines, preferences, thresholds and origin estimates of what it revises (`origin_basis: inherited`, `origin_of`); a format fix also keeps the assessment date, so its age; the block's own time is `block_as_of`. Only a new audit starts a new origin, linked by `predecessor`. | F05 test |
| F06 | Reproduced → corrected | Lifecycle@2: an assessment's repository list is one batch; "no delivery" needs every repository in scope (approved ones and those read in the freshness window) read successfully in that window; any known delivery in the window is "delivered"; otherwise unknown. Same-time readings collapse. | F06 test (both orders, genuine inactivity, first monitor run) |
| F07 | Reproduced → corrected | `cr-forensic-scenarios@2`: every valid reading counts, zero included; the latest decides the current state; rates use positive readings only and no date is projected from a zero (`projection: unavailable_at_zero`); missing days stay missing. Baselines include zeros. | F07 test through save → view |
| F08 | Reproduced → corrected | `cr-forensic-liquidity@2`: each route scope's latest answer within the freshness window is current; earlier answers are history; a stale latest reads "Stale". Each reading time is evaluated over the current routes. | F08 test |
| F09 | Reproduced → corrected | A cost is complete only with the network fee (stated or inside the quote) and the transfer tax (GoPlus screen within 7 days of the reading) known; otherwise "at least", with what is unknown said first, in the cell. A lower bound can show over the limit, never within. Reserve calculations say they are a calculation, not a quote; fees inside a quote are not added twice; every estimate is labeled one-way. | F09 test, updated forensic tests |
| F10 | Reproduced → corrected | `productCheck` records `read` (complete, cut_at_cap, timed_out, bad_encoding, read_error) and `scope`; broken encoding, a broken stream, a time-out or a text not found in a cut answer is `incomplete` (no reading); a status-only check passes on its status with the cut said. | F10 test |
| F11 | Reproduced → corrected | Evidence identity is the case-preserving address plus what was preserved; a new capture at the same address is new evidence (`change: new_capture_same_address`); a new retrieval time alone is not. | F11 test |
| F12 | Reproduced → corrected | `GET /forensics/receipts/<id>/text` returns JSON through the signed-in client with the pin checked; the tab opens it in an in-app viewer, checks the SHA-256 again in the browser, and downloads from the same bytes. No token in any address. | F12/F13 test, browser check |
| F13 | Reproduced → corrected | `?receipt=<id>` shows one receipt whole (its findings, grades, sources, timeline, challenge), marked as history, with the current states kept apart; slow answers for another receipt are dropped. Import offers "Import a revision of <id>" with kind and reason. The challenge shows its own sources (checked), source chips and calculation checks. | F12/F13 test, browser checks (select, reload, Back, delayed answer) |
| F14 | Reproduced → corrected | Order: summary and age with the receipt ID → strongest concern with its kind, references and source → next action → counterevidence → receipt details and one-line coverage (areas behind Details) → evidence changes → states. Long concerns clamp to four lines on phones with "Show the whole concern". | Browser check: concern's essential block ends at 579 px (390×844, tab bar 783) and 629 px (360×780, tab bar 719), both themes; the long, warning-heavy case (the extraordinarily long name, a long concern on a weak basis, a missing reference) keeps its qualification and opens with "Show the whole concern". Phones were reached by address; the click-through entry flow (watchlist → inspector → project → Forensics) was run at 1440. |
| P3 | Inferred → hardened | `netguard.readBodyBounded`: quote and GitHub answers are counted as they stream and cut over the cap; a declared size over the cap is refused unread; the timer covers the read. | P3 test |

## What changed, by file

- `core/forensic-eligibility.js` (new): the eligibility pass and the measurement bindings.
- `core/forensic-review.js` (new): the review queue and acknowledgments.
- `core/forensic-defs.js`: `cr-forensic-liquidity@2`, `cr-forensic-scenarios@2`, `cr-forensic-method@2` (published versions untouched).
- `core/forensic-model.js`: liquidity@2 (`scopeOf`, completeness, `exitTable`, `liquidityReadings`), scenarios@2, `contract_address` on captured liquidity readings.
- `core/forensics.js`: frozen-file checks, revision inheritance, evidence identity, readings bound to identity, tax index, delivery batches, method@2 correction lines, `?receipt=` view, queue in the view, `receiptText`.
- `core/exitquotes.js`, `core/forensic-monitor.js`, `core/netguard.js`: F02, F10, P3.
- `core/exporter.js`: reviews in the JSON export. `server.js`: `?receipt=`, JSON text route, `POST …/forensics/reviews`, `INTEGRITY` → 409.
- `web/src/views/project/Forensics.jsx`, `styles/forensics.css`, `styles/project.css`, `ProjectPage.jsx`: the tab; bundle rebuilt into `public/app`.
- Tests: `tests/forensics-corrections.test.js` (new), `tests/forensics.test.js`, `tests/web-app.test.js`; `web/scripts/check.mjs`, `web/scripts/dev-desk.cjs` (FICTIONAL fixtures: a format-fix revision, page hashes).
- `CLAUDE.md`, `COWORK-INSTRUCTIONS.md`: the corrected rules in a few sentences.

## The evidence-change review queue

`cr-forensic-review@1`. Built on read from the monitor's existing observations (no new request, no new schedule):

- Per monitored target (product check, repository, exit quotes per size) consecutive observations are compared. Classes: **measurement changed** (outcome or status; latest delivery, release or archived state; a quote's answer or side of the limit), **captured page changed — significance not established** (body changed beyond whitespace), **cosmetic only** (bytes changed, equal under `cr-forensic-normalize@1`: line endings and runs of whitespace only; no number, date, word, case or markup removed), **read failed** (one item per failing stretch, with its count and whether it ended), and per target **no relevant change**. A raw hash change is never called a factual change.
- Each target is linked to what is on record: the receipt that proposed it and the source it cited, and the findings citing that source, with the receipt's frozen capture shown unchanged. Without that link it reads "Unmapped", "Receipt only" or "No finding linked" with the reason; exit quotes are always unmapped. Nothing is inferred.
- Item IDs are deterministic (same observations, same IDs), so changes are not duplicated.
- **Mark reviewed** (optional note) names the target's latest relevant change; a newer one is refused with 409 naming it; the same request or change again is `unchanged`. It appends to `projects/<id>/forensics/reviews.jsonl` (in backups, packages and the JSON export) and means only that Eric looked: it changes no grade, allegation, research or model, and asks no one anything. A later relevant change reopens the target; a cosmetic one does not. Every review stays on record.

## Historical compatibility and recovery

- No receipt, text, block, packet, prompt or observation was rewritten. New fields are additive; earlier receipts read as before (their `origin` stands in for the assessment date; `method` reads `cr-forensic-method@1`).
- Outcomes recorded under method@1 stay. The monitor's next daily step appends one correction line where method@2 reads differently (`corrects`, `method`, `previous_method`, reason); until then the timeline says the difference beside the recorded outcome. Eric's own corrections are never overridden.
- The tab may now read differently on existing data, by design: liquidity "Within" needs a complete cost (Solana quotes from Jupiter state no network fee, so they are lower bounds and can show over the limit, never within); findings whose references do not hold no longer cover areas or feed grades and discontinuation; captured measurements on another chain no longer count.
- Older product observations have no normalized hash, so their page changes read "captured page changed", never cosmetic.
- Decimals recorded before this change carry no platform and are looked up again once per target (one CoinGecko call, inside the existing budget).
- Recovery: revert these files with Git; all records stay readable by the earlier code, and `reviews.jsonl` is simply ignored by it.

## Limitations and setup

- The desk does not read meaning: "References hold" never says a source supports its finding. The queue says what changed, not whether it matters.
- Dynamic pages (timestamps, tokens in the HTML) will show frequent "captured page changed" items; there is no per-target ignore rule, deliberately.
- Transfer tax is known only from a GoPlus screen within 7 days of a reading.
- Not tested: native screen readers and physical phones (accessibility names, keyboard paths, focus, contrast, reduced motion and phone widths were checked in headless Chrome only).
- Setup: none. No new secret, setting or provider; the review queue needs monitoring that Eric already turns on per project.

## Screenshots (local, not tracked)

`screenshots/before/` from `974c617` and `screenshots/after/` from this tree, on the FICTIONAL dev desk: phone first screens at 390×844 and 360×780 in light and dark, the whole page at 1440 (light, dark) and 390, and the review queue at 390 (`after/fx-390-s2.png`).
