# Milestone 1: position research (position-cycle@1)

**Date:** 2026-10-02. **Author:** Claude (Claude Code, Opus 5.5), working in the main folder.

**Status:** implemented and tested in the main folder, and running there: the dashboard, the CLI, Cowork and the hourly task all use it. Not committed to Git yet. The integrity repair (`rc/integrity-r2`) is still **not** merged (see "Integrity repair" below).

## Why

The desk asked every model for a 24-month view with no market context. Eric trades positions: usually a couple of months, planning ceiling four months, read against Bitcoin's trend and whether altcoins take part. So reports could not say anything about timing, catalysts inside the window, or when to look again.

## What it does now

| Piece | What changed | Where |
|---|---|---|
| Market-cycle snapshot | About hourly, with prices: Bitcoin's price and 7D/30D change, BTC and ETH dominance, total market cap, and breadth (how many of the 100 largest coins beat Bitcoin over 7 and 30 days, after leaving out Bitcoin, stablecoins, gold tokens, tokenized funds, and wrapped or staked coins). Dated, append-only, cited by ID. A failed fetch keeps the last snapshot. Two CoinGecko calls each time, counted in the monthly budget. No regime label, no forecast. | `core/cycle.js`, `market-data/context/` |
| Research horizon | New runs use an exact calendar interval: 4 months from the research date by default (e.g. 2026-10-02 to 2027-02-02), fewer on request. Above the ceiling it is a long-term exception that needs Eric's reason (refused without one, from every entry point). "Same as last" keeps the length and reason, re-anchored to today. | `core/position.js`, `core/research.js` |
| Prompt v3 | `cr-research-prompt@3`: position-trading investor context, the snapshot line, 13 sections (adds market cycle, timing and catalysts inside the horizon, review plan), and a `position_context` block in the JSON contract (market view, timing view, review date, catalyst windows and certainty). Scoring is unchanged. | `templates/research-prompt.v3.md`, `templates/grading-appendix.v3.md`, `core/prompts.js` |
| Import | The block is read and checked: unknown words become "unknown" (the original is kept), impossible dates are dropped with a warning, evidence references go through the citation check, and the horizon is compared with the run's. A mismatch is recorded, never hidden. Grades are computed exactly as before. | `core/reports.js`, `core/inbox.js` |
| Dashboard | Watchlist market line with "What is this?". In the summary panel, each model's timing view, market reading, next catalyst and suggested review date, with **Add to my reviews**; the project's 7D and 30D change vs BTC. A position card on the project's Scorecards tab. Run research: 4 months by default, with a reason field above the ceiling. Suggested review dates in the calendar, and in the review queue when close. | `public/position-ui.js`, `public/position.css`, `views/watchlist.js`, `views/project.js`, `views/dialogs.js`, `core/indexer.js` |
| CLI, Cowork, queue | `--long-term-reason` on `research add` and `project add`; `long_term_reason` in requests; `market context [--refresh]`. COWORK-INSTRUCTIONS, README, WORKSPACE-MAP and templates/README updated. | `cli.js`, `server.js`, docs |
| Demo | The fictional demo has a market snapshot, a 4-month position run, a long-term exception with its reason, and mock answers with position blocks. | `core/demo.js` |

Older reports are untouched and show "Not in this report (written before the position recipe)". Nothing is inferred for them.

## How to use it

- **Dashboard:** select a project, then **Run research**. Leave the horizon at 4 months. Copy the prompt into ChatGPT and Gemini as before; Claude can run it through Cowork. Once the answers are imported, each model's timing view and suggested review date appear in the panel. **Add to my reviews** puts a date on your calendar.
- **Cowork / CLI:** `node dashboard/cli.js research add <id> --providers claude,chatgpt,gemini --channel cowork --json`. For a longer horizon: `--horizon "12 months" --long-term-reason "<your reason>"`.
- **Market:** `node dashboard/cli.js market context --json` (add `--refresh` for a new snapshot).

## Tests

- Full suite: **125/125** on Node 24.21.0 (the 109 existing tests, of which 5 were updated for the 4-month policy, plus 16 new).
- `tests/cycle.test.js` (7): the relative-return formula, breadth and exclusions, refusing unusable data, history and interval, failure keeps the last snapshot, every attempted call counted, budget pause, switched off.
- `tests/position.test.js` (9): calendar months (month ends, leap years), the horizon policy from every source, the prompt with dates and snapshot and no private notes, block checks without score changes, binding to the run, the index and calendar, a mock-provider run end to end, the dashboard route with a restart, and the Cowork request queue.
- **In the browser** (demo workspace, 1440 px and 375 px): the market line and its explainer, the panel's timing facts, **Add to my reviews** (saved; then shown as covered), the Scorecards position card, and Run research (4-month default, reason required above 4, a 3-month run answered by the mock adapters). No horizontal scroll on a phone width.
- **Live:** one market-context snapshot in this folder (`mc_2026-10-02T223257Z_439bbcf3`: BTC $84,508, dominance 58.8%, 56 of 74 large coins beat BTC over 30D). Classification of the real top 100 was checked by hand.
- No record file under `projects/`, `portfolio/`, `config/` or `inbox/` changed.

## Limits

- **No real model call and no real Cowork research run happened.** Provider answers came from the fictional mock adapters and from test fixtures.
- **Breadth relies on a classification:** curated IDs plus name and price rules. A new stablecoin or fund could be counted until it is added. The exclusion counts are stored with every snapshot, so you can always see what was left out.
- The block is not correctable with `report correct` yet. A wrong review date is fixed by adding your own review instead.
- The projects' standing prompts (`projects/<id>/prompts/*.md`) were left as they were. New runs use their own v3 prompt; `prompts <id>` rebuilds the standing ones.
- **Integrity repair.** Bringing `rc/integrity-r2` into the running code was blocked by the session's permission system as a production deploy, so it was not done. This milestone is built on `main` (`a840ba7`). Merging the repair later will touch some of the same files (`research.js`, `indexer.js`, `server.js`, `cli.js`, `project.js`); the hooks here are kept small for that. Whether they merge cleanly was not checked.

## Rolling back

The code is plain Git: `git diff` shows every change. `git checkout -- dashboard templates` plus deleting the new files listed above returns to `a840ba7`. The data stays readable by the older code: runs still carry `horizon.text`, the older code ignores `market-data/context/` and `position_context`, and no existing record was rewritten.

## Update, 2026-10-02 evening

Checked against the agreed mission (`CryptoResearch-Mission-and-Architecture-v1.md`): it names a horizon as part of each research recipe but sets no 4-month ceiling. The ceiling and the long-term reason come from the Foundation brief ("usually a couple of months, with a 3–4 month planning ceiling. Longer-term holdings are explicit exceptions") and the Implementation Architecture ("A long-term exception requires a separate reason and horizon"). The foundation kit marks that policy "proposed, not active". So requiring a reason is now **off** until Eric decides (`research.horizon_policy.require_long_term_reason`). The 4-month default stays; a longer horizon is allowed and labeled long-term.

## Next step

**Owner thesis journal.** A dated thesis per project: your intuition and reasons, the signal you expect, what would invalidate it, the planned horizon and review date. Then, at review time, the outcome: what happened, did the thesis hold, what you learned. It links to the model reports it relied on and stays separate from model grades. This is the mission's "owner judgment and learning" record, and the timing views from this milestone feed straight into it.
