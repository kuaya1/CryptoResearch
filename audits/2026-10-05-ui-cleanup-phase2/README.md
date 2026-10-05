# UI cleanup, Phase 2: handoff (D1 one page per project, D6 Settings)

Written 2026-10-05 by Claude (cloud session, investigation and Phase 1) for a
fresh session that builds Phase 2. Nothing in Phase 2 is built yet. Phase 1 is
`main` at `dc828d5`.

## 1. Eric's decisions (2026-10-05)

Checked: **D1** and **D6**. D2, D3, D4, D5 are out of scope.

- **D1 One page per project:** the Claude Brief is the default view; Overview,
  Reports and Scorecards merge into it; tabs become Brief, Full report, Market,
  Notes.
- **D6 Settings:** opens on Appearance; technical settings under a collapsed
  "Advanced".

Eric's answers to the questions D1 and D6 left open:

| Question | Eric's answer |
|---|---|
| How do ChatGPT and Gemini appear on the Brief? | **Model tabs**: Claude, ChatGPT, Gemini at the top of the Brief, each brief drawn from that model's own latest report, Claude first. Grades stay separate. |
| Where do Comparison, Evidence and Research runs go (D1's four tabs drop them)? | **All into the Brief**, as folded sections. Notes stays notes and history only. |
| What goes under "Advanced" in Settings? | **Everything except Appearance and "Research models & budget"**: Dashboard settings (thresholds, refresh, CoinGecko budget, grade labels), Market data sources, Rubrics, Backups & exports, System & privacy, Activity. Appearance first; Research models & budget (spend limits, model holds) stays visible. |
| Where is it built? | A fresh session, from this file. When Phase 2 is finished and verified, **commit and push to `main`** (Eric, 2026-10-05). |

## 2. Rules (from Eric's Phase 2 prompt, unchanged)

- Read CLAUDE.md and COWORK-INSTRUCTIONS.md first. Do only the checked
  decisions. Each checked decision overrides the specific CLAUDE.md UI rule it
  contradicts, and nothing else. When you implement one, update that rule in
  CLAUDE.md to match, dated and attributed to Eric, so the next agent does not
  undo it.
- If carrying out a decision would also force a change no decision covers,
  stop and ask. Do not guess.
- Removing a view must not remove information or abilities. Before deleting
  anything, finish the coverage table (section 4). Anything with no new home
  is a blocker: report it and stop.
- Links must keep working: old URLs redirect to the new home (section 5).
  Back, Escape and focus return still behave as the rules describe.
- Only `dashboard/public` and its tests (plus the CLAUDE.md rule edits),
  existing tokens, no dependencies, demo workspace only, no paid research, no
  records touched.
- Process: plan; build one decision at a time with `node dashboard/cli.js test`
  after each; attack your own work (journeys, click counts, 1440px and 390px,
  light and dark, keyboard only, screen-reader names, edge cases); re-read the
  full diff as a hostile reviewer and revert anything outside D1 and D6.
- Report: what changed for each decision, the coverage table, click counts
  before and after, test results, screenshots, CLAUDE.md edits, open questions.

## 3. Starting state (verified 2026-10-05)

- `main` = `dc828d5` (Phase 1). Suite: 481 of 483 pass. The two failures
  depend on the container, not the code: `hosted.test.js:106` (the
  persistent-disk guard fires because the temp folder is on the root disk) and
  `ingest.test.js:54` (the second scan runs inside the inbox's 2-second settle
  window). Both also fail on untouched `main`.
- Known defects on `main`, out of scope unless D1 or D6 touches them: focus on
  a `<summary>` is lost after a live redraw; the phone status strip can cut a
  long label mid-word.

## 4. Coverage table (draft: complete it before deleting anything)

Built from reading `views/project.js`, `views/brief.js` and
`views/settings.js` at `dc828d5`. Rows marked *verify* were listed from the
code's labels, not read in full. "Brief" means the new Brief tab of the project
page, for the model chosen in its model tabs.

### Project header (stays)

| Item | New home |
|---|---|
| Logo, name, symbol, breadcrumb to `#/watchlist?p=<id>` | Project header (unchanged) |
| Run research (primary), Watch/Watching, Archive/Restore with Undo | Project header (unchanged) |
| Sector (change sector dialog), Held, official website link | Project header (unchanged) |
| "Identity verified/pending" link (to the Research runs tab today) | Project header; links to the Brief's Token identity section |

### Overview tab → Brief

| Item | New home |
|---|---|
| Three model cards (grade or Withheld, coverage, why withheld, unscored list, structure notes, verdict, analysis date and age, stale, horizon, timing, summary, evidence-check flag with "see why", route text, newer-run line) | Brief model tabs: each model's Brief verdict and notices. Every listed field must appear for the chosen model. |
| Model card states without a readable report: PDF saved (Open the PDF report, Import the text), waiting job (Copy prompt, Import report), on hold (no run; Phase 1 rule), no report (Run research) | Brief empty state for that model tab, with the same actions. Phase 1 on-hold rule stays: a held model offers no run; a saved report keeps its state. |
| Claude Brief link, Open report, Scorecard buttons on each card | Not needed as links: the Brief tab is the brief; Open report goes to the Full report tab; the scorecard is the Brief's Scorecard section |
| "How the models compare" card (side-by-side grades and verdicts, differences at or above the threshold, conflicting figures, settling questions, independence note), "Open the full comparison" | Brief, folded section "Compare the models" (with the full Comparison content below) |
| "Since your last review" (new reports, grade and verdict changes, run states, price change), Mark reviewed, All changes | Brief, near the top (it is the review digest). All changes goes to the Notes tab. Mark reviewed keeps its toast and the R/Undo behavior where it applies. |
| "Your headline" (text, Change the headline: select, Set headline, Clear) | Brief, folded section "Your headline" |
| "Material risks" table (each model's four risk scores side by side, corrections marked) | Brief, "Compare the models" section |
| "Unresolved questions" (each model's, plus your open dispute questions) | Brief, Evidence section (with Your dispute questions) |

### Scorecards tab → Brief "Scorecard" section (per model tab)

| Item | New home |
|---|---|
| Model switcher (`?provider=`) | Brief model tabs (`?model=`) |
| Explainer callout (three panels never mixed) | Card or section tooltip (no explanatory copy on screen) |
| Grade calculated by this app, model total differs message, withheld block | Brief verdict and "Own total differs by n" (already in the Brief); withheld block in the Brief's withheld notice |
| Model version and attestation, horizon interval, rubric status, citations (claims, sources) | Brief, Scorecard section facts |
| "Rubric and provenance" (rubric, scoring profile, prompt, arrived via, run) | Brief, Scorecard section, folded |
| Investment grade components table (weight, score, corrections, contribution) | Brief "Six weighted components" (already there); add the contribution and correction marks if missing |
| Category grades table (scored count, unknown count, profile, confidence, flags, corrections) | Brief category grades (already there); verify flags and correction marks |
| Downside risk table with rationale per risk | Brief, "What threatens it" (add the four risk scores with rationale if missing) |
| "Open the full report" | Full report tab |
| `positionCard` (the report's position and cycle reading) and `thesisCards` (chart and cycle, scenarios, the model's judgment, code read) | Brief: Scenarios and What to watch sections already draw from these; anything not shown goes in a folded "More from this report" section. *verify* |

### Reports tab → Full report tab

| Item | New home |
|---|---|
| Report list grouped by model (date, grade or Withheld, verdict, latest or earlier, revision) | Full report tab, as the report picker |
| `?report=<id>` selection | Full report tab `?report=<id>` |
| Header meta (grade, verdict, horizon, model and attestation, latest, earlier or excluded), withheld sentence, revision line with link to the earlier save, analysis-time notice, extraction warning | Full report tab (unchanged) |
| At a glance (verdict, grade, horizon, summary, sources, risks, scenarios, unresolved questions, code read) | Full report tab (unchanged) |
| Reader: formatted or exact text, Download original, PDF notice | Full report tab (unchanged) |
| Corrections table and Add a correction form | Full report tab (unchanged) |
| Claims and evidence (claims table, claim review controls) | Full report tab (unchanged) |
| Normalized view, Extraction notes, File and provenance (file, path, SHA-256, imported, channel, run, versions, matching) | Full report tab (unchanged) |
| Broken report callouts | Full report tab (unchanged) |

### Comparison tab → Brief "Compare the models" *verify*

Model comparison table (model, grade, verdict, analysis date, horizon · rubric
· profile), not-comparable callout, difference table (item, gap, difference,
median (descriptive) with its show-median toggle), Numbers across reports
(metric, finding), Questions that would settle the differences, Shared
sources, How each model changed over time.

### Evidence tab → Brief "Evidence and sources" *verify*

The analyst-tag callout (as a tooltip), one card per model's report (claims,
tags, evidence checks), Your dispute questions (table: topic, question,
status; form: Topic, Resolving question, Add question).

### Research runs tab → Brief, folded sections *verify*

Token identity (verified or pending callout, unknowns; form: Chain, Contract
or mint, CoinGecko listing ID, Official website, Evidence URL, Evidence note,
Save identity); Research runs (each run: details, jobs with model, state,
route, attempts, note; Retry, Retry anyway, Cancel, Cancel this run, Copy
prompt, Rebuild with the current prompt, Copy of the assistant sentence,
Reconcile attempt with Record, partial view, exact prompt, links to saved
reports); Standing prompt files. `?run=<id>` scrolls that run into view.

### Notes & history tab → Notes tab

What changed since your last review (type, model, grade, verdict, score
changes); Your conviction note and journal (Conviction, Conviction note, Save
note, Decision, Reasons, Record decision); Reviews, catalysts and alerts
(Title, Due (America/New_York), Add review, Done; Alert type price above or
below, Threshold (USD), Add alert). *verify* that nothing else is there.

### Market tab → Market tab (unchanged)

### The existing Brief page (`#/brief/<id>`) → Brief tab

Identity line, analysis date, horizon, market now with its own time; verdict
and calculated grade; notices; key points; thesis; scorecard; supports and
threatens; what to watch; scenarios; evidence and records; your note; empty
states (quarantined with Why, job state, on hold, archived, PDF with Import the
text, excluded); actions (Run research, latest brief, Open the report,
Research runs, Full research page). The Brief's own bar on a phone (Back) and
its one-history-entry return to the inspector (`ui.js` `briefLink`) must keep
working from the inspector.

### Keyboard

Project tabs: Left, Right, Home, End (`ui.js` `tabStrip`). Brief: Escape and
its Back control return to the inspector when opened from it. Watchlist and
inspector keys (/, J/K, Space, Enter, Escape, R with Undo) are unchanged and
must still pass.

### D6 Settings

| Item | New home |
|---|---|
| Appearance card (Light, Dark, Match this device) | First thing on Settings; the page opens here |
| Research models & budget (routes, Lift the hold, budgets, default horizon, unattended) | Visible below Appearance |
| General: Dashboard settings, Market data sources | Advanced (collapsed) |
| Rubrics, Backups & exports, System & privacy (incl. Run write test), Activity | Advanced (collapsed) |
| `#/settings?tab=<id>` links (e.g. `?tab=research` from the Research page) | Still land on the right section; a link into an Advanced section opens Advanced |

## 5. Redirects (old URL → new home)

| Old | New |
|---|---|
| `#/project/<id>` and `#/project/<id>/overview` | `#/project/<id>/brief` |
| `#/project/<id>/scorecards?provider=<p>` | `#/project/<id>/brief?model=<p>`, Scorecard section |
| `#/project/<id>/reports?report=<r>` | `#/project/<id>/report?report=<r>` |
| `#/project/<id>/comparison` | Brief, Compare the models open |
| `#/project/<id>/evidence` | Brief, Evidence and sources open |
| `#/project/<id>/research[?run=<r>]` | Brief, Research runs open, run scrolled into view |
| `#/project/<id>/history` | `#/project/<id>/notes` |
| `#/brief/<id>[?report=<r>]` | `#/project/<id>/brief?model=claude[&report=<r>]` |
| `#/watchlist?p=<id>` | Unchanged (the inspector) |

Inbound links to update (counts at `dc828d5`): `reports?report=` 10,
`#/project/<id>` 7, `history` 5, `evidence` 5, `scorecards?provider=` 4,
`research` 4 (+1 with `?run=`), `overview` 4, `comparison` 4, `#/brief/` 3.
Links built by the server (`core/indexer.js:184` → `research`, `:560` → the
project) are out of scope and must work through the redirects.

## 6. CLAUDE.md rules D1 and D6 override (edit them, dated, "Eric, 2026-10-05")

- The Claude Brief bullet: "is one decision page drawn from one saved Claude
  report", "On a phone it takes the whole screen with its own bar", "It never
  fetches, posts, screens or starts research", the `#/brief/<id>` route and
  the "Full research page" action. With D1 and Eric's answers the Brief is the
  project page's default tab, one brief per model under model tabs, and it
  holds folded sections that keep their own actions (identity, research runs,
  headline, dispute questions, Mark reviewed).
- The inspector bullet: "Full scorecard" and "Open report" link targets, and
  "Claude Brief beside the inspector's Verdict heading".
- No CLAUDE.md rule describes the Settings layout; add one line for D6.

## 7. Order of work

1. Measure the journeys on `main` first (section 8).
2. D6 (small, isolated). Tests.
3. D1, in steps, tests after each: (a) router redirects with the old tabs
   still present; (b) Brief tab in the project page with model tabs
   (`brief-model.js` already takes `provider`; `views/brief.js` fixes
   `PROVIDER = 'claude'`); (c) Overview items into the Brief; (d) Scorecards
   items; (e) Comparison, Evidence, Research runs as folded sections;
   (f) Full report tab from the Reports tab; (g) Notes tab from Notes &
   history; (h) only when the coverage table has a home for every row, delete
   the old tabs and update inbound links.
4. Attack, hostile review, CLAUDE.md edits, report, then commit and push to
   `main`.

## 8. Journeys to count (clicks and screens, before and after)

Open a project from the list; read the verdict; check a flag; compare models;
mark reviewed with R and with the button; Undo; open an earlier report; record
a note; start New research up to the confirm step without confirming. A
journey that gets longer is a defect.

## 9. Test setup that worked in Phase 1

- `node dashboard/cli.js demo build` builds `dashboard/demo-workspace`
  (gitignored, fictional). Serve:
  `node dashboard/cli.js serve --workspace dashboard/demo-workspace --port 4321`.
- Edge cases set up in the demo for Phase 1 (rebuild resets them): Gemini on
  hold, Example Game archived, Example AI Data with market cap and FDV 0.
  Writes are accepted only from the page: run `fetch('/api/session')` for the
  token, then POST with `x-cr-token` from inside Playwright (`page.evaluate`).
  The demo already has a pending identity (Pending Draft Token), no market
  data (Example DeFi Lend) and a saved Withheld Gemini report (Example PayFi).
- Playwright is global: run scripts with `NODE_PATH=$(npm root -g) node x.cjs`.
  Headless Chromium hides scrollbars; launch with
  `ignoreDefaultArgs: ['--hide-scrollbars']` to see them. The theme is stored
  as JSON: `localStorage.setItem('cr.theme', JSON.stringify('dark'))`.
- On a hash route change, wait for the new page's own content, not a selector
  the old page also has (Phase 1 lost time to that race).

## 10. Usage note

On 2026-10-05 the weekly usage limit was above 90%, resetting 2026-10-06
23:00 EDT. D1 is a large change. Keep tool output out of the conversation
(write it to files and read summaries), and expect to stop at a clean step if
the limit is reached: the order in section 7 leaves the desk working after
every step.
