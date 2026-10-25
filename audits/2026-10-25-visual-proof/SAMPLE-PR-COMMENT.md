> **Sample, pull request mode (2026-10-25): what the workflow posts on a backlog PR, from FICTIONAL inputs.** Head `20591e4` (this checkout) over base `b9e7b14`, so the batch reads items 33–35; the screenshots and browser checks are of this checkout on the fictional desk; the unit counts are this checkout's suite (20591e4 plus this BUILD's uncommitted files). In the real comment the images load from the `visual-proof` branch; here they point at `sample-images/`, kept on this PC only. No pull request is linked.

<!-- cr-visual-proof -->
# 🌅 CryptoResearch Morning Visual Sanity Report

Date: Sunday, October 25, 2026, 1:13 PM EDT | Build batch: #33–35 | Status: unit tests passed on 20591e4

Branch `claude/backlog-batch-items-33-34-35`, tested head `20591e4`.

## 1. Core visual surfaces

Measured on the FICTIONAL desk in headless Chrome at 1440×900, light theme, 2026-10-25T17:01:03.711Z: not the live desk. The boxes are yours to tick after looking.

- [ ] **Desk table:** rows 61px (target 60px); names 15px / 600 (target 15px); 7 columns shown; model marks drawn: 18 graded, 3 waiting ○, 2 withheld, 2 problem, 16 hold, 7 none.
- [ ] **Inspector drawer:** Key metrics: 4 cells in one row; no label or figure wraps; the notes under a figure wrap in 2 cells; drawer 620px wide.
- [ ] **Review, three panes:** 3 panes drawn; 9 raw record IDs or hashes in visible text (`fr_2026-10-25T170101Z_hfxsj`, `2026-10-25_claude_45271853`, `2026-10-25_chatgpt_47dca29b`).
- [ ] **Portfolio badge:** no Needs attention badge (0 records need attention) on the fictional desk; the live count has no read-only source.

**Desk** (fictional desk)

<img src="sample-images/desk.png" alt="Desk, fictional desk" width="720">

**Inspector open** (fictional desk)

<img src="sample-images/inspector.png" alt="Inspector open, fictional desk" width="720">

**Review, three panes** (fictional desk)

<img src="sample-images/review.png" alt="Review, three panes, fictional desk" width="720">

**Portfolio** (fictional desk)

<img src="sample-images/portfolio.png" alt="Portfolio, fictional desk" width="720">

## 2. Autonomous pipeline and API health

- [ ] **Waiting jobs:** not read: CI has no access to the live desk.
- [ ] **Exit quotes (KyberSwap, Jupiter):** unknown: CI has no access to the live desk, and no read-only tool reports the exit-quote monitor's status.
- [ ] **Models, each on its own (nothing averaged or called a consensus):** not read: CI has no access to the live desk. As recorded on 2026-10-25, not read now: Gemini on hold on the online desk; ChatGPT and Gemini with no API key on Render.
- [ ] **Tests:** unit 910 of 910 passed; browser checks check.mjs passed (0 failures); regress.mjs 78 of 78 passed.

## 3. Quick visual links for Eric

- [Live production desk](https://cryptoresearch.onrender.com)
- [Backlog pull requests](https://github.com/kuaya1/CryptoResearch/pulls?q=is%3Apr+head%3Aclaude%2Fbacklog-)

<details><summary>Where each value comes from</summary>

| Value | Source |
|---|---|
| Date | this script's clock, in America/New_York |
| Build batch | `Backlog-Item:` trailers in `git log b9e7b14..20591e4` |
| Unit tests | <temp>/test-summary.md (test.yml's test-summary) |
| Section 1 (visual surfaces) | <temp>/sample-proof/proof.json (proof-shots.mjs on the fictional desk); checked by this script (fixed names, PNG signature, sizes; numbers and booleans only) |
| Browser checks | check.txt and regress.txt beside the visual proof (npm run check's two scripts, report-only) |
| Waiting jobs and models | not read in CI; the hold and keys line is the desk's record as of 2026-10-25 (CLAUDE.md), not a reading |
| Status | the unit test counts above, for the commit named |
| Live desk link | Render service srv-db02t2hsrm7s73dspnn0 (its url), read 2026-10-25 |

</details>
