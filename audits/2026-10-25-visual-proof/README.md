# BUILD — Visual proof and morning report

Eric's request, 2026-10-25: screenshots of the core views on every autonomous batch PR, and a morning sanity report. The plan and his four choices are in [PLAN.md](PLAN.md) (approved: "build it with the recommended choices 1a, 2a, 3a, 4a").

**Nothing is committed or pushed.** The workflow sits in `.github/`, a protected path, so it lands only when Eric merges it.

## What was built

| File | What it does |
|---|---|
| `dashboard/web/scripts/proof-shots.mjs` | Starts the FICTIONAL offline desk (`dev-desk.cjs`) and opens the built app in headless Chrome through the existing `cdp.mjs` (no new package). Captures Desk `#/watchlist`, inspector `#/watchlist?p=<relay>` (its body scrolled to Key metrics), Review `#/review?p=<relay>` and Portfolio `#/portfolio` at 1440×900, light theme. On each page it measures what the template asks about, and records console errors and any request that is not a GET. Writes `<dir>/*.png` and `proof.json` (`cr.visual-proof.v1`). |
| `dashboard/scripts/sanity-report.js` | The report, in Eric's template. `--pr` for the CI comment; morning mode (the default) for his PC. Every value names its source in a "Where each value comes from" table; a value nothing measured reads "unknown" or "not read". |
| `.github/workflows/visual-proof.yml` | After a green `test` push run on `claude/backlog-*`: **capture** checks out the tested head, runs `proof-shots.mjs`, then `check.mjs` and `regress.mjs` (report-only), with a read-only token and no secret. Then **publish** runs no branch code: main's own `sanity-report.js` reads the artifact as data, commits the PNGs to the orphan branch `visual-proof` under `<sha>/`, and posts or updates one comment (marker `<!-- cr-visual-proof -->`) on the PR whose head is that commit, open or already merged. The report also goes to the job summary and the `morning-report-<sha>` artifact. `backlog-pr.yml` and the promotion scripts are untouched. |
| `dashboard/tests/sanity-report.test.js` | 8 tests on a temporary git repo, a stubbed `gh` and fictional files. |
| `dashboard/web/README.md` | One row for the new script. |
| `.gitignore` | Allowlists this folder's four write-ups. |

## The template, as the rules require

- **Never "Verified" or "Confirmed".** Every line is an unticked box for Eric, with the measured value beside it. The tests fail if a box is ticked or either word appears.
- **"Status: Ready for Review"** became the CI result for the commit the report describes.
- **"90 dropped to 9"** became the current count. On the fictional desk it is measured from the rail badge. The live count has no read-only source, so it reads "unknown".
- **"3-Model Consensus Engine"** became one line per model: route, API key, and jobs waiting (the hollow dot ○). It is never averaged or called a consensus.
- **Waiting jobs** come from `desk_status.research.models` plus `daily_brief`'s PM cards section. There is no SQLite or Supabase queue.
- **Exit quotes refreshed within 12 hours** reads "unknown": no read-only tool reports the monitor's status. `daily_brief`'s "pilot projects missing an exit reading" is shown instead, as what it is.
- **Batch numbers** come from `Backlog-Item:` trailers. **Test counts** come from the runs themselves: test.yml's `test-summary`, taken from the **push** run, the one promotion gates on.
- **Live desk link** `https://cryptoresearch.onrender.com`, read from Render service `srv-db02t2hsrm7s73dspnn0` on 2026-10-25.
- **A desk snapshot is refused in `--pr` mode**, so live records never reach GitHub.

## Running it on the PC (morning mode)

1. In a Claude session with the CryptoResearch connector, call `desk_status` and `daily_brief`. Save them as one JSON file outside the repo, for example in the OS temp folder:
   `{ "schema_version": "cr.desk-snapshot.v1", "taken_at": "<now>", "desk_status": {…}, "daily_brief": {…} }`
2. Then run:

```
node dashboard/scripts/sanity-report.js --since 24h --desk <snapshot.json> --out <report.md>
```

The script reads git, plus `gh` when it is signed in: the push test run and the `visual-proof-<sha>` artifact of the newest merged head. Downloads go to a temporary folder that is then deleted. Keep the output off GitHub: with a snapshot, it describes the live desk. There is no schedule; a scheduled task needs Eric's word.

## Checked on this PC, 2026-10-25

The runs below are on this checkout: local `main` at `20591e4` plus this BUILD's files. This shared folder was not pulled. The commit itself sits on `origin/main` as of 2026-10-25 (`6a4eb28`, with PRs #11 and #12, items 36–41). The suite was run again on that exact tree before committing; the pull request gives those counts.

- **`node dashboard/cli.js test`: 910 of 910 passed**, run twice: the 902 already on `main` plus the 8 new ones. `sanity-report.test.js` alone: 8 of 8, run four times.
- **`node dashboard/web/scripts/proof-shots.mjs`: 4 of 4 views captured cleanly**, with no console error and no write on any page. It took 11 s, and the four PNGs come to about 720 KB.
- **The browser checks, as the workflow runs them:**
  - `check.mjs`: "All browser checks passed." (202 s);
  - `regress.mjs`: 78 of 78 passed (122 s).

  So on this PC the capture job does about 5.6 minutes of work, plus checkout and setup.
- **The bundle:** no UI source changed, and the scripts aren't part of its hash, so it was not rebuilt.
- **The workflow:** its YAML parses and its shell steps pass `bash -n`. It has **not run**: it needs Eric's merge.
- **Two samples:** [SAMPLE-REPORT.md](SAMPLE-REPORT.md) (morning mode) and [SAMPLE-PR-COMMENT.md](SAMPLE-PR-COMMENT.md) (what a backlog PR gets). Each says at its top which inputs are fictional. Their screenshots are in `sample-images/`, on this PC only.
- **Real CI facts the morning sample read through `gh`:**
  - PR #11's head `a7a4f30`: the push test run passed, 907 of 907;
  - its pull_request run failed with no job (below).

## Found on the fictional desk (not fixed: outside this BUILD)

- **Desk rows measure 61px against the 60px target.** The 15px/600 names match. The extra pixel is probably the row's hairline. Check whether 60px was meant to include it.
- **Review shows raw record IDs as visible text.** Nine in the three panes: a forensic receipt ID (`fr_…`) in Scheduled reviews, and report IDs (`2026-10-25_claude_…`). The template's line expects them hidden behind tooltips.
- **The PR-event `test` run on PR #11's head (a7a4f30) failed with no job.** The push run passed (907 of 907). The `pull_request` run likely started after the branch was deleted. The report reads the push run. Nothing else depends on the failed run.

## Open

- **First real run.** The workflow has never run: it needs Eric's merge and the next backlog push. The first run will show three things:
  - whether Chrome is found on the runner;
  - whether the comment's images render inline (signed in, in a browser; the GitHub phone app is untested);
  - how many Actions minutes it adds (check.mjs and regress.mjs are the slow part).
- **Linux fonts.** CI screenshots use them: sizes in pixels match, letterforms don't.
- **Repo growth.** The `visual-proof` branch grows by about 0.7 MB per backlog run (four PNGs measured locally) and is never pruned unless Eric allows a rewrite of that branch.
- **Live counts.** A live Needs attention count and the exit-quote monitor's freshness would need new fields in a read-only connector tool (`mcp.js`, protected): a backlog item if Eric wants them.
