# Desk clarity: evidence meaning, text against data, first view, route wording (2026-10-06)

A bounded pass on REVIEW3 (the product review of `fa05f99`). No framework, database, provider, prompt, profile, rubric or weight change; Gemini stays on hold; fictional workspaces only; no paid call; nothing on the online desk was changed.

## Baseline

| | |
|---|---|
| Source | `C:\Users\Kuaya\Documents\CryptoResearch`, branch `main` |
| Deployed | `dd07c0b` (Render `/healthz` and the connector's `desk_status`, started 2026-10-06 02:34 UTC) |
| Local before this pass | `14d0e84`, six commits behind `origin/main`, with an uncommitted local version of UI cleanup phase 1 that `dc828d5` had already done differently and deployed. It is kept, unapplied, in `git stash` ("local UI cleanup phase 1 on 14d0e84, superseded by dc828d5…") and as `superseded-local-phase1.patch` here (git-ignored). Local `main` was then fast-forwarded to `dd07c0b`. |
| Suite on the baseline | 484 of 485 on Node 24.21.0. The failure is environmental: the hosted first-boot test reads a Windows temp folder as "not a persistent disk". |

Already resolved before this pass (by `78b758e`, then `dc828d5`–`dd07c0b`): history-only code evidence and "no depth retrieved" flagged; price observations not checked as catalyst evidence; "No inconsistencies detected by these checks" with coverage; [V] labeled the researcher's classification; strongest sourced risk in the inspector thesis and the Brief's key points; manual/optional-API/on-hold wording in Settings, New research and the connector; CoinMarketCap links in intake; `GET /api/doctor` writes nothing; restored-copy hold and `offsite drill`; held models never retried.

## What changed

| Item | Change | Evidence |
|---|---|---|
| Liquidity evidence | A spread alone is not depth or executable size (a low note; still material without a volume baseline). A dated depth, order-book, slippage or pool figure in a claim the liquidity grade, the chart reading or the timing component cites counts as structured evidence. A reading that says depth is missing while a cited claim gives a depth figure is flagged as a contradiction, never resolved. | `evidence-meaning.test.js` (spread, structured claim, undated claim, contradiction) |
| Catalyst evidence | A dated catalyst given as documented (source documented, project claimed, announced or implemented) that cites only past price, volume or chart observations is a low note: market history never counts as evidence of the event. Conditional or inferred catalysts are not flagged. | `evidence-meaning.test.js` |
| Binding and scores | A report saved through the connector for its run completes the job; range endpoints, an unknown with its reason, the withheld coverage and a flagged grade stay as saved; the original is byte for byte. | `evidence-meaning.test.js` (connector `save_report` path) |
| Text against data block | `core/textscores.js`, read-time only: a component or category score the written report states (its name followed directly by the score, in a table or a line) that differs from the data block is said in the Brief's notices, under the inspector's verdict, on the Full report tab and in the connector's `get_report` (`text_vs_data`). The grade stays the data block's as saved; nothing is chosen or rewritten. On a saved desk report it found the three leftover ranges REVIEW3 described; on another it compared 25 statements and found none. Wording-level leftovers ("all six are ranges") are not parsed. | `text-scores.test.js` (unit, import path, connector) |
| Original and revision | A completed job its model saved again shows "Completed by its first save, X. The run now links Y, a revision using existing evidence. Both are kept." with Open the original and Open the latest revision; the connector's progress says the same; the Brief's report history labels First report, New research (another run) or the revision. | `text-scores.test.js` |
| First view | Brief: grade or withheld reason, then a serious evidence flag, then the key points (strongest sourced risk, would confirm, would break), then the other notices. A missing point says "Not reported in <model>'s report" (Brief) or "Not reported" (inspector), never inferred. | Headless Chrome at 390 px and 1440 px, below |
| Route wording | The Research page's routes table now matches Settings: "Manual · ready through its assistant" (or "by paste and import"), the optional automatic route as a quiet second line, never a warning; On hold for a held model. Job states: "Held by archive, not sent… restoring the project does not send it"; "Check · answer quarantined…". The connector's progress for a quarantined answer and a held job says the same. | `ui-logic.test.js` |
| Instructions | The liquidity evidence standard in `COWORK-INSTRUCTIONS.md` and the connector's instructions now reads "a dated depth, order-book or slippage reading (a list of venues, aggregate volume or a spread alone does not measure how much can be traded)". The frozen prompt and execution notes are unchanged. | |

## Tests

`node dashboard/cli.js test` on Node 24.21.0: 493 of 494 pass (484 of 485 on the baseline). The one failure is the same environmental hosted first-boot test as on the baseline. New: 9 tests (evidence meaning, text against data, original and revision).

## Viewport checks (headless Chrome, measured `innerWidth` 390 and 1440)

Fictional fixture (`fixture.js`, git-ignored): the Brief fixtures plus a text-vs-data project with a Cowork original and revision, a stale price and a partial contract screen. Cases: revision with differing own total and a serious flag, withheld, ranges, sparse legacy, quarantined only, waiting, long and hostile text, stale price, partial security.

- No horizontal overflow in any Brief or inspector, at either width; no console errors.
- Opening any Brief or inspector sent no write request (no POST; no research started).
- 390 px, first screen: identity, the selected model's pill (grade or "Withheld") with its verdict, and "Analysis today". The Brief's strongest risk moved from about 1,950 px to about 1,700 px on the revised fixture; sparse legacy shows "Not reported" for the three key points.
- Escape closes the inspector and returns focus to the row; the inspector's Claude Brief link, then Escape or Back, returns to the inspector; `?open=runs` opens the section, brings it into view and focuses its heading; the original's direct address opens that original.
- The Code-tab browser pane paints no frames (`requestAnimationFrame` never fires there), so frame-dependent checks were run in headless Chrome.

Not established: a physical phone, touch scrolling, the virtual keyboard and a screen reader. The owner check below covers the phone.

## Independent recovery: waiting on Eric

`desk_status` (2026-10-06 04:22 UTC): same-disk snapshots only; no `CR_BACKUP_KEY` on the desk; no `desk_backup_key` on this PC; no verified independent copy. Steps, with the existing mechanism (`core/offsite.js`):

1. Create a key of at least 32 characters and keep it out of chats.
2. Render > CryptoResearch > Environment: add `CR_BACKUP_KEY` with that value (the desk restarts).
3. On this PC: put the same value in `%USERPROFILE%\.cryptoresearch\secrets.json` as `"desk_backup_key"`.
4. `node dashboard/cli.js offsite setup --desk https://cryptoresearch.onrender.com`, then `offsite pull`, then `offsite drill`.

The drill verifies the pulled package's hashes, restores it into a new folder as a restored copy (research held, zero provider calls), checks records, originals and research states (unsent, sent, uncertain, quarantined, held) and records itself in the offsite folder's `OFFSITE-DRILLS.json`.

## Pilot: prepared, not run

Prerequisites, in order: this pass deployed (commit and push to `main`, Eric's call); the drill above passing; Eric naming one project (a CoinMarketCap link is fine).

Then, in Cowork: "Research <link> with Claude and ChatGPT and add it to my watchlist", and in ChatGPT (CryptoResearch app on): "Do my waiting CryptoResearch research". Record per model: run ID, prompt SHA-256 (`prompt_delivery`), ChatGPT's execution note (`cr-execution-chatgpt@2`, hash on the job), report ID and save receipt. Interrupt one client after a `save_research_draft`, then "Resume my CryptoResearch research on <project>" (same run, same draft). Repeat the original request: it must return `in_progress`/`resumed`, never a second run. Check five claims against primary sources (implementation file at a commit, holder economics, in-window supply, control, market depth); any that cannot be opened stay unresolved. Archive, Undo, then confirm the same project ID, reports and history, and no job sent. A withheld grade passes; matching verdicts are not required.

Owner phone check (Eric, on the phone, after deploy): open the project; within 30 seconds find the grade or why it is withheld, the strongest risk, what would confirm or break it, and the research age.

## Deploy

Eric said "commit push" on 2026-10-06. This README ships in that commit on `main`; Render deploys `main` in about a minute, and `/healthz` then names the revision.
