# BUILD — Visual proof and morning report: plan for Eric

Status: **approved by Eric, 2026-10-25: "build it with the recommended choices 1a, 2a, 3a, 4a."** Built the same day; what was built and checked is in [README.md](README.md). Scope: Eric's request of 2026-10-25 (Phase 1, screenshots on backlog PRs; Phase 2, a morning sanity report).

## What exists already (reused, nothing added)

- Headless Chrome over the DevTools protocol, no packages: `dashboard/web/scripts/cdp.mjs`, used by `shots.mjs`, `check.mjs` and `regress.mjs`. Chrome is on GitHub's Ubuntu runners; the workflow points `CHROME` at it. **No Playwright**, no change to any `package*.json`.
- The FICTIONAL offline desk: `dashboard/web/scripts/dev-desk.cjs` (test fixtures, every provider stubbed off, temp workspace deleted on exit). `check.mjs` already starts it on its own. Screenshots come only from this desk, never from real records.
- Hash routes: Desk `#/watchlist`, inspector `#/watchlist?p=<id>`, Review with a project chosen `#/review?p=<id>` (the three panes), Portfolio `#/portfolio`. There is no `/project/:id` drawer route.
- The live desk's address, confirmed today from Render service `srv-db02t2hsrm7s73dspnn0`: `https://cryptoresearch.onrender.com`.

## What gets built

| File | What it does |
|---|---|
| `dashboard/web/scripts/proof-shots.mjs` (new) | Starts the fictional desk, captures the four views at 1440×900 in the light theme, and measures each one on that desk: the Desk's row height and name size, whether the inspector's four Key metrics sit in one row with nothing wrapped, how many raw IDs or hashes are visible as text in Review, the Portfolio's Needs attention count, plus console errors and writes (must be none). Writes the PNGs and `proof.json`. |
| `dashboard/scripts/sanity-report.js` (new) | Renders the morning report from what it is given: git (`Backlog-Item:` trailers on `origin/main`), `gh` runs when signed in, the CI test counts, `proof.json`, and optionally a saved snapshot of the desk's read-only tools (`desk_status`, `daily_brief`). Every value carries its source; a missing source reads "unknown" or "not read", never a number. Writes only to `--out`. |
| `.github/workflows/visual-proof.yml` (new, protected path, waits for your merge) | After a green `test` run on a `claude/backlog-*` push: **capture** (read-only, runs the branch's code, no secrets) then **publish** (runs only main's own copy of the scripts, never branch code; checks every file is a PNG of fixed name and bounded size; posts or updates one comment on the PR, open or already merged). `backlog-pr.yml` and the promotion scripts are **not touched**. |
| `dashboard/tests/sanity-report.test.js` (new) | Fictional inputs and a temporary git repo: each value names its source, unknowns are said, nothing reads "Verified" or "Confirmed", no "consensus" line, the comment escapes text from the branch. |

Then: `node dashboard/cli.js test`, a local run of `proof-shots.mjs`, and one **sample report from a fictional run** with every value and where it came from. No UI code changes, so the bundle is not rebuilt; if one is needed, `npm run check` runs too.

## Template changes the rules require (tell me if you object)

- **"Status: Ready for Review"** becomes the CI result of the head it describes (passed, failed or unknown).
- **Section 1 stays an unticked checklist for you.** Beside each box, the value measured on the fictional desk ("row height 60px, target 60px"), labeled *fictional desk, headless Chrome on Linux, not the live desk*. Never "Verified".
- **"90 dropped to 9" is dropped.** It becomes the current Needs attention count. In CI that is the fictional desk's count. For the live desk no read-only tool gives that count today, so it reads "unknown" (adding it means a change to `mcp.js`, a protected path: a separate item if you want it).
- **"3-Model Consensus Engine" becomes one line per model**, using the desk's own mark rules (`consensusOf`: graded, waiting (the hollow dot ○), withheld, problem, on hold, none). Gemini reads "on hold"; ChatGPT and Gemini have no API key on Render. Nothing is called a consensus.
- **Waiting jobs** come from `desk_status` and `daily_brief` (files on the desk, no SQLite or Supabase queue). In CI they read "not read: CI has no access to the live desk".
- **Exit quotes refreshed within 12 hours**: no read-only tool reports the monitor's status, so this reads "unknown". `daily_brief`'s "pilot projects missing an exit reading" is shown as what it is.
- **Batch numbers** come from the `Backlog-Item:` trailers; **test counts** from the actual runs ("883/883" is never typed in).

## Your four decisions (my recommendation first)

**1. Where the screenshots live so they show inline.** GitHub's API can't attach an image to a comment, and an Actions artifact is a zip, never shown inline.
- **(a) Recommended:** an orphan branch `visual-proof` in the same private repo, one folder per tested commit; the comment embeds them by address. They show in the browser when you're signed in to GitHub (the GitHub phone app: likely, not tested). Cost: the repo grows by about 0.5–1.5 MB per backlog run, never pruned unless you later allow that branch to be rewritten.
- (b) An artifact only, linked from the comment: no growth, nothing inline, a 14-day zip to download (awkward on a phone).
- (c) An outside image host: needs an account and a secret, and puts screenshots on a third party. Not recommended.

**2. Timing against the auto-merge.** `backlog-pr.yml` merges a green batch within minutes, before any screenshots exist.
- **(a) Recommended:** promotion unchanged. The comment lands on the PR even if it's already merged, and says so. A visual regression can therefore be on main, and possibly live on Render, by the time you read it.
- (b) Make screenshots a gate before the merge: a failed capture blocks the builder.
- (c) Hold every batch that changes `dashboard/web/` or `dashboard/public/app/` for your visual OK (a scope rule in `backlog-promote.js`): the strongest guarantee, but it slows the builder.

**3. Browser checks in CI.** Today CI runs only the unit suite, so there is no CI source for "78/78 browser checks".
- **(a) Recommended:** run `npm run check` (both scripts) in the capture job, **report-only**, never a gate; the counts go into the comment. Adds roughly 3–5 Actions minutes per backlog run; Linux fonts may trip a timing or contrast check, which would show as a reported failure.
- (b) Leave it out; the report says "browser checks: not run in CI".

**4. Where the morning report runs.**
- **(a) Recommended:** CI builds it automatically in the same PR comment, plus the job summary and an artifact, with CI facts only. The same script on your PC renders the live lines from a snapshot Claude saves through the read-only connector, **with no schedule**. The existing `cr-daily-brief@1` stays the source for waiting PM cards; the report links to it and doesn't duplicate it.
- (b) The same, plus a new scheduled morning task on your PC. A new schedule needs your explicit word; say when.

## Caveats you should know

- The CI screenshots use Linux fonts. Sizes in pixels match; the letterforms don't match your Windows PC or your phone.
- Only backlog PRs get the comment, as asked. A BUILD branch like this one gets none.
- The workflow file sits in `.github/`, so it lands only when you merge it. I commit or push nothing unless you ask.
