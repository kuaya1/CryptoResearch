> **Sample, morning mode (2026-10-25), from FICTIONAL inputs.** Section 1 and the browser checks come from the fictional desk (`proof-shots.mjs`, `check.mjs`, `regress.mjs`) run on this checkout, not on the merged head, because the workflow has not run yet. The desk lines come from a FICTIONAL snapshot: the Claude Brief test fixture, read with the functions behind `desk_status` and `daily_brief`, so its "live desk" figures and revision are the fixture's, not the online desk's. The batch, the unit test counts and the pull request come from git and `gh` (CI facts). Command: `node dashboard/scripts/sanity-report.js --since 24h --desk <fictional-snapshot.json> --proof <sample-proof>`.

# 🌅 CryptoResearch Morning Visual Sanity Report

Date: Sunday, October 25, 2026, 1:13 PM EDT | Build batch: #7–9, #12–19, #21–41 | Status: unit tests passed on 976e6a7

## 1. Core visual surfaces

Measured on the FICTIONAL desk in headless Chrome at 1440×900, light theme, 2026-10-25T17:01:03.711Z: not the live desk. The boxes are yours to tick after looking.

- [ ] **Desk table:** rows 61px (target 60px); names 15px / 600 (target 15px); 7 columns shown; model marks drawn: 18 graded, 3 waiting ○, 2 withheld, 2 problem, 16 hold, 7 none.
- [ ] **Inspector drawer:** Key metrics: 4 cells in one row; no label or figure wraps; the notes under a figure wrap in 2 cells; drawer 620px wide.
- [ ] **Review, three panes:** 3 panes drawn; 9 raw record IDs or hashes in visible text (`fr_2026-10-25T170101Z_hfxsj`, `2026-10-25_claude_45271853`, `2026-10-25_chatgpt_47dca29b`).
- [ ] **Portfolio badge:** no Needs attention badge (0 records need attention) on the fictional desk; the live count has no read-only source.

## 2. Autonomous pipeline and API health

- [ ] **Waiting jobs:** 1 research job waiting, queued or uncertain on the desk (snapshot taken 2026-10-25T17:01:17.405Z; Claude 1, ChatGPT 0, Gemini 0 waiting); PM cards waiting for you: 0.
- [ ] **Exit quotes (KyberSwap, Jupiter):** refresh age unknown: no read-only tool reports the exit-quote monitor's status; pilot projects missing an exit reading: 0.
- [ ] **Models, each on its own (nothing averaged or called a consensus):** Claude: manual, no API key on the desk; 1 waiting ○; ChatGPT: manual, no API key on the desk; nothing waiting; Gemini: manual, no API key on the desk; nothing waiting.
- [ ] **Tests:** unit 910 of 910 passed; browser checks check.mjs passed (0 failures); regress.mjs 78 of 78 passed.
- [ ] **Deploy:** the desk in the snapshot runs `20591e4`; the newest merged head is `976e6a7`.

CI notes: no visual-proof artifact for 976e6a7.

## 3. Quick visual links for Eric

- [Live production desk](https://cryptoresearch.onrender.com)
- [Pull request #12](https://github.com/kuaya1/CryptoResearch/pull/12) (merged)
- [Backlog pull requests](https://github.com/kuaya1/CryptoResearch/pulls?q=is%3Apr+head%3Aclaude%2Fbacklog-)

<details><summary>Where each value comes from</summary>

| Value | Source |
|---|---|
| Date | this script's clock, in America/New_York |
| Build batch | `Backlog-Item:` trailers of the backlog merges on origin/main's first-parent line from 2026-10-24T17:13:23.319Z to 2026-10-25T17:13:23.319Z |
| Unit tests | test-summary artifact of the push test run on 976e6a7 (https://github.com/kuaya1/CryptoResearch/actions/runs/40215091568) |
| Section 1 (visual surfaces) | <temp>/sample-proof/proof.json (proof-shots.mjs on the fictional desk); checked by this script (fixed names, PNG signature, sizes; numbers and booleans only) |
| Browser checks | check.txt and regress.txt beside the visual proof (npm run check's two scripts, report-only) |
| Waiting jobs and models | desk snapshot <temp>/fictional-snapshot.json taken 2026-10-25T17:01:17.405Z: desk_status.research.models (jobs per model, status, key) and daily_brief (cr-daily-brief@1, text SHA-256 638efbf3ec14…) sections pm_cards and pilot_exits |
| Status | the unit test counts above, for the commit named |
| Live desk link | Render service srv-db02t2hsrm7s73dspnn0 (its url), read 2026-10-25 |
| Pull request link | GitHub's pull requests for commit 976e6a7, through gh |

</details>
