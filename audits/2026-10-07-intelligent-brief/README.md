# Intelligent UI, pass 1: the project brief's Overview, Compare and Evidence (2026-10-07)

Status: built and tested on `main` (working tree at e52762a plus another session's uncommitted Day Desk CSS), **not committed, pushed or deployed**. Fictional fixtures only; no research started, no model asked, no record written, the Explorer's demo database not touched.

## What changed

The project page's tabs are now **Overview · Compare · Evidence · Full report · Market · Notes**. Overview keeps the address `#/project/<id>/brief`, so every existing link (the inspector's "Claude Brief", the server's links) lands on it; the Brief's former folds redirect to their new homes (`projectRedirect`).

- **Header** (every tab): logo, name, ticker, then price with 24h change, market cap and 24h volume with their own source and age ("Stale price · 3 days ago" in words), apart from any research date. On a phone the breadcrumb is hidden on the brief's views; "Since your last review" is one line naming the changes in words.
- **Overview**: model tabs (each model's grade or state and verdict), then the sheet: the desk's grade (a range as two ends; withheld with the share of the weight scored, beside the verdict on a phone too), verdict, analysis date with research age ("stale" past the freshness limit) and horizon; the warnings that bear on the grade as chips beside it (evidence flag, own total differs, text and data block differ, extraction errors), each jumping to its sentence; strongest sourced risk, would confirm, would break; the 13 category grades as bars with their reasons on demand; then, in a separate well, "What the grade is calculated from" (the six weighted components); thesis, supports/threatens, what to watch, scenarios; one line to the Evidence view; your note.
- **Compare** (`views/brief-compare.js`, `compare-desk.js` over the Second opinion's own `compare-model.js`): the desk's latest eligible Claude and ChatGPT reports by default (`d.comparison.latest`); a missing side says why (quarantined, PDF, excluded, waiting, on hold, none). Each grade as stored, never combined. Scope and authorship as two facts; differing run, prompt, profile, rubric, horizon and research date named. Category grades ordered for inspection (comparable gaps of 5+ first, largest first; evidence missing; close or the same; not compared), numbers only under the same profile, rubric and definition, ranges never midpoints. Each row has **Basis of the difference**: each report's reason, strongest evidence, cited claims (tag, date, source), weakness, what would raise/lower it, desk flags, sources both cite, and the figures the two cite as the desk classifies them (latest pair only). When a side gives no reason and cites nothing: "The stored records cannot explain this difference". Then the six components and downside risk side by side, and the reports not compared. Any eligible report can be picked (redrawn in place, focus and place kept). Reads the project record only: never the Explorer.
- **Evidence**: the conclusion (grade, verdict, date) with its warnings and notices; desk evidence checks (never folded); every claim with ID, tag, date, worst flag and sources; every source with publisher, type and date read; limits and open questions; report provenance with "Open the original report"; the model's reports on the project. Folded: Check the claims yourself, Technical records (normalized data loaded only when opened), Research runs, Token identity.
- `compare-model.js`: one optional argument so the scope can say "not stored with these reports" instead of "in the Explorer" (Explorer default unchanged).
- Removed: the Brief's old "Compare the models" fold on the project page (its descriptive median contradicts "no midpoint"; `comparisonBlock` itself stays for the Research page).

## Before and after (FICTIONAL fixture, document y in px)

| Where | Grade | Verdict | Strongest risk | First category bar |
|---|---|---|---|---|
| 390 px, before (from the inspector) | 1,199 | 1,345 | 1,722 | 4,118 |
| 390 px, after (from the inspector) | **587** | **604** | **745** | **1,704** |
| 390 px, withheld grade, after | 596 | 616 | 780 | 1,800 |
| 1440 px, before | 897 | 892 | 1,123 | 2,698 |
| 1440 px, after | **598** | **635** | **805** | **1,397** |

On a 390 × 844 phone the first screen now holds identity, market with its own time, every model's grade and verdict, the selected grade or withheld state, verdict, research age, the grade's warnings and the strongest sourced risk with its tag and source. Screenshots: `shots/before/`, `shots/after/` (390 and 1440, light and dark).

## Checks

- Full suite: **580 of 580** pass (baseline had no failures). New `dashboard/tests/brief-views.test.js` (10); `ui-logic.test.js` updated for the new redirects and the market line's new home; `brief-fixtures.js` gains ChatGPT's own report for the relay run (designed differences) and a ChatGPT report under later versions for the sparse case.
- Browser (`check.js`, headless Chrome, 390 touch and 1440, light and dark): 0 non-GET requests, 0 research or Explorer requests, 0 console errors, no horizontal overflow on any view of any case, no clipped figure, every visible control named; keyboard: project tabs, model tabs (focus stays on the tab), pickers and order toggle (focus and place kept), basis disclosures; Escape and Back return to the inspector from Overview, Compare and Evidence; the Overview's flag link lands focused on the evidence checks.
- Fixed on the way: after a model-tab switch on a brief opened from the inspector, focus jumped to the sheet title (pre-existing).

## Not verified / remaining

- Real reports on the online desk (Render) were not opened; only fictional fixtures. Real ChatGPT reports are often withheld: Compare shows them as withheld with coverage, untested on real data.
- Screen-reader output was checked by accessible names and roles, not with a real screen reader.
- The inspector's own comparison table still uses the server's spread rule (a point vs a range counts to the far end of the range; threshold 20), while Compare uses the Second opinion's rule (outside the range by N; 5+ listed first). Both are labeled; aligning them is a separate decision.
- The "!" corner mark on a model pill renders as a 7 px dot with no text by design (its words are in the label); the checker lists it as small text.
- "Since your last review" is now one line above the model tabs (the list one tap away), a change to the 2026-10-05 layout made for the phone first screen.

## Second pass: phone hierarchy (same evening, after c8f57ac)

On a phone the Overview now reads: compact identity (name and ticker beside the logo; MC and Vol 24h with their source and age; Run research, Watch and Archive in one 44px "⋯" menu, the inspector's, instead of a row of buttons), the model tabs, the grade or withheld state with the verdict and research age, the grade's warning chips (never hidden), then at once the strongest sourced risk, what would confirm and break it, then the category bars. The sheet's head and its "Claude's verdict" label, which repeat the chosen model tab, are for screen readers only on a phone when the report is the latest (an earlier report keeps its head). A risk over 160 characters reads as its first four lines with an explicit "Show the full risk"; the whole text is always in the page and shows in full on a wide screen. No text was made smaller; desktop is unchanged.

Strongest-risk block, top–bottom (document px), opened from the inspector; FICTIONAL fixture with its 28px "Test workspace" banner (the real desk has none). Before = the deployed c8f57ac exported; after = the staged candidate exported (neither has the Day Desk session's pending CSS).

| Case | 390×844 before | 390×844 after | 360×780 before | 360×780 after |
|---|---|---|---|---|
| Complete | 736–844 | **607–715** | 809–917 | **610–718** |
| Withheld grade | 759–867 | **635–743** | 781–889 | **635–743** |
| Range grade | 722–830 | **600–771** (now a long risk, 4 lines) | 727–835 | **600–771** |
| Sparse legacy | 669–707 | 544–582 | 687–725 | 547–585 |
| Very long name (6 lines) | 829–979 | 674–824 | 905–1055 | 700–850 (grade, verdict, age on screen; risk starts on it) |

Grade top: 578 → 460 px (390), 609 → 461 px (360). Desktop 1440×900: unchanged (risk 808–853).

Checks on the staged candidate: full suite 582/582 (2 new tests); `measure.js` and `check.js` at 390×844 and 360×780 (touch) and 1440×900, light and dark: 0 writes, 0 research or Explorer requests, 0 console errors, no overflow; the "⋯" menu opens on its first item, Up/Down move, Escape closes it and returns focus (the page stays); "Show the full risk" toggles (aria-expanded) with all 211 characters always in the page; Escape and Back return to the inspector; Compare and Evidence unchanged in behavior. Comparison rules, scores, exclusions and reports untouched (no change to `compare-model.js`, `compare-desk.js`, `brief-model.js` or `core/`). Screenshots: `shots/before-p2/`, `shots/after-p2/`, `shots/after-p2-check/`.

Not changed: the model tabs keep each model's verdict under its pill on a phone (Eric, 2026-10-06); with a very long project name the risk starts on the 360px first screen but ends below it. At 360px with the test banner the desk's own top bar wraps its status dot to a second row (pre-existing, top bar; the real desk has no "Test" tag).

## Files

Changed: `dashboard/public/views/{brief,project,inspector,research,watchlist}.js`, `dashboard/public/{compare-model.js,index.html}`, `dashboard/tests/{brief-fixtures,ui-logic.test}.js`, `CLAUDE.md` (the project-page bullet only). New: `dashboard/public/{compare-desk.js,brief-views.css}`, `dashboard/public/views/brief-compare.js`, `dashboard/tests/brief-views.test.js`. Not mine, left untouched: `dashboard/public/{styles,brief}.css` and the Day Desk line in `CLAUDE.md` (another session's uncommitted work). Local only (ignored): `fixture.js`, `cdp.js`, `shoot-before.js`, `check.js`, `peek.js`, `summarize.js`, results JSON, `shots/`.
