# Interface design pass: usability and validation notes

Date: 2026-10-01. Scope: the dashboard's interface and daily workflow. No paid service was activated, no model API was called, and no record changed. Writes during testing went only to throwaway copies of the fictional demo workspace and to temporary test workspaces.

## What changed

**One design system** (`dashboard/public/styles.css`). The palette is neutral: white, near-black and grays. Small color accents back up text: green or red with ▲/▼ and a sign for price direction, red bars for risk, amber for stale data, red "!" for failures. The type is Segoe UI Variable, 12–26 px, with 12 px the smallest. One set of spacing, radius, border, elevation and focus tokens covers every page, along with the states (default, hover, focus, selected, disabled, busy, error). A dark theme follows the Windows setting, and reduced motion turns transitions off.

**Watchlist**
- Layout: a title, one Add project button, and a compact toolbar: search, Show (All / Held / Watching), Filters, Columns, and a sort menu at narrow widths.
- Columns: name and ticker, rank with its source, price, signed rolling 7D and 30D, market cap, 24h volume, and sector. Then come three model grade badges.
- Grade badges:
  - They have a fixed width, so each model's grades line up down the list.
  - Each badge has two short lines: the model, then the grade, a range, or a plain state (None, Queued, Running, Cowork, Manual, Failed, Withheld, PDF).
  - A missing grade is never shown as a number.
  - The analysis age shows on the badge only when it is stale (for example "4mo"). The date and age are always in the scorecard and the panel.
- Sorting and filters:
  - Sort direction is shown by an arrow, `aria-sort` and a "Sorted by …" line.
  - Unknown values sort last in both directions.
  - Active filters appear as removable tokens with "Clear all".
  - An empty watchlist and "no matches" have different messages.
  - The view is saved in `config/ui-state.json`.
- Fitting the width:
  - Columns now step aside by measurement, least essential first, until the table fits. All three grades stay in view at every width tested.
  - Every hidden value stays in the summary panel.
  - Below about 760 px each project becomes a card with name, price movement and all three grades.
- Live updates refresh values in place. If they would reorder rows, the order is kept and a "Re-sort" button is offered.
- Data sources are labeled honestly. Demo data is labeled as fictional demo data, never "CoinGecko". The workspace file path left the top bar; it is in Settings.

**Hover or focus a grade → scorecard**
- Contents: grade or state, verdict, date and age, horizon, weight coverage, top risks (higher is worse), source, and whether models differ.
- It appears after a short pause and never moves focus.
- You can move the pointer onto it. It switches models without blanking when you move along the badges, stays closed after Esc (even through a live update), and is always placed inside the window.

**Select a project → summary panel**
- On windows 1280 px and wider it sits beside the list, which stays usable (not modal). On narrower windows it is a full-height sheet with real modal behavior: `role="dialog"`, `aria-modal`, the page behind made inert, and focus returned on close.
- Order: identity, then market, then each model's scorecard, "how to read these grades", how the models compare, and changes since your last review.
- Selecting a grade badge opens the panel focused on that model. Esc or × closes it and returns focus to what opened it. Back restores the list position, the selected project and the control you used.

**Full research page** (`#/project/<id>/<tab>`)
- The header is simpler. Identity links to the token identity details.
- Overview has one card per model.
- Scorecards shows one model at a time, with the three panels and their directions stated.
- Reports is a list grouped by model beside a reader: 72-character lines at 16 px. It offers "Download original" and "Show exact text". Corrections (the original next to your correction), claims, normalized JSON, extraction notes and provenance open on request.
- Reading position, open sections and typed text survive live updates.

**Adding, researching and importing**
- **Add project:** starts with one field (name or official website).
  - Lookup results:
    - Listings that share a ticker trigger a warning.
    - Several listings found by name come with a note to pick the one the official website links to.
    - "No listing" and a failed lookup both come with a next step.
  - An outcome line previews whether the identity will be verified or stay pending.
  - The receipt separates project, identity, research and holdings ("None created").
  - Repeating the form creates no duplicate.
- **Run research:** each model's route is stated: API (model, paid, within budget), Cowork, or manual import with a "Set up API access" link. You choose a horizon. The receipt shows each model's state.
- **Manual jobs:** "Copy prompt" and "Import report" sit side by side in the panel, on the overview cards and on the Research runs tab.
- **Import report:**
  - The pasted text is kept as a draft until it is saved.
  - Errors appear beside the field.
  - The result is kept for the browser tab and links to the saved report.
  - Pasting the same text twice saves one copy (a submission ID derived from the content, plus the server's existing idempotency).
  - Retrying a fixable failure reuses the saved copy.
  - "Recent imports" lists what was imported.

**Elsewhere**
- Portfolio: a quiet summary row. States are in words, form errors appear inline, and the table fits better.
- Settings: Activity (freshness, jobs, write log) moved here from Updates, and routes are stated in words.

**Live updates and sessions**
- A live update keeps focus, the selected project, the open panel, scroll positions, open sections and typed text.
- If you have unsaved input, a "New data is available" bar appears instead of a redraw.
- After a dashboard restart, the page renews its session and the next save works without a reload.

**Back end** (small; no record formats changed)
- `server.js`: report paste and upload accept a submission ID, using the existing idempotency path.
- Inbox retry accepts the research run ID.

## Design decisions

- **Light, calm, neutral.** Color never carries meaning alone. The demo banner is black instead of magenta, so it reads as a label, not an alarm.
- **Grades are aligned, compact and truthful.** The age moved off the badge unless stale: always showing it pushed the third model off screen. The age stays one hover away and in the panel.
- **The list never hides a grade.** Market columns give way first; the panel keeps every value.
- **The panel does not trap you.** It is a side column where there is room, and a proper modal sheet only where it covers the list.
- **Research and holdings stay apart.** The portfolio table no longer shows grades next to positions, so a grade does not read as a trade signal. Select an asset for its research.
- **Low-level details move down a level.** The workspace path went to Settings and contract IDs to the identity card. Normalized JSON and provenance sit behind disclosures.
- **Manual research is a first-class route.** Copy prompt and Import report sit together wherever a model waits for an answer.

## Screenshots

- `screenshots/before/`: the interface before this pass. This includes the earlier hover preview and the panel overlapping the list.
- `screenshots/after/`, fictional demo, final code:
  - `watchlist-1440.png`, `-1024`, `-768`, `-390`, `-320`
  - `hover-scorecard-1440.png`
  - `panel-1440.png`, `panel-provider-gemini-1440.png`, `phone-panel-390.png`
  - `project-overview-1440.png`, `project-report-1440.png`, `project-scorecards-1440.png`, `project-comparison-1440.png`, `project-pending-identity-1440.png`
  - `add-project-1440.png`, `import-1440.png`, `import-failed-1440.png`
  - `portfolio-1440.png`, `research-runs-1440.png`, `settings-research-1440.png`, `settings-activity-1440.png`
  - `dark-watchlist-1440.png`, `dark-panel-1440.png`, `dark-report-1440.png`
  - `phone-watchlist-390.png`, `phone-project-overview-390.png`, `phone-report-390.png`, `phone-import-390.png`
  - `zoom200-watchlist.png`
  - `big-watchlist-1440.png`, `-1024`, `-390` (26 fictional projects with long names)
  - `metrics.json`
- `screenshots/after/interactions/`:
  - hover scorecard
  - panel focused on one model
  - report reader
  - failed import with its receipt
  - saved import
  - phone sheet
  - 200% zoom
- `screenshots/after/add-and-research/`:
  - every add-project state: first field, empty error, shared ticker, verified preview, no listing, failed lookup, receipt, repeat
  - research routes (API, manual) in a test workspace
- `screenshots/after-real/`: your real dashboard, viewed read-only. Watchlist at 1440 and 390, hover scorecard, panel, project overview and reports.

## What was tested

Everything ran on the final, deployed code (`evidence/final-battery-summary.txt`).

- **Automated suite:** 109 of 109 passed, run from this folder (`node dashboard/cli.js test`). The tests use temporary workspaces only. Six tests are new:
  - `tests/ui-logic.test.js` (5): small-price precision, compact amounts, unknown values sorting last, missing grades never shown as numbers, stale age and in-progress flags.
  - `tests/ui-backend.test.js` (1): a repeated paste is saved once, and a fixed retry reuses the saved copy. This test fails on the old server and passes on the new one.
- **Render sweep** of every page and tab, in headless Edge with phone emulation at phone widths. Each render was checked for script errors, failed sections, empty pages, sideways page scroll and frozen pages. All 859 renders were clean:
  - demo at 1440, 1280, 1024, 768 and 390 px: 335 renders
  - 26-project fictional list at 1440 and 390 px: 454
  - real dashboard, read-only, at 1440 and 390 px: 70
- **Grades always visible:** 12 widths from 1600 to 320 px, with and without the panel, on the demo, the 26-project list and the real dashboard. 72 of 72 passed: every badge was fully visible with no sideways table scroll.
- **Interaction checks:** 62 of 62 passed (`evidence/interactions.json`).
  - Hover: shows after a pause, names model and project, keeps focus, fits the window, can be hovered, Esc dismisses, stays dismissed (also through a live update), Esc before it appears cancels it, no blanking when switching badges.
  - Keyboard: focus shows the scorecard, Esc keeps focus, Tab moves on.
  - Panel: Enter opens it on the right model, one history entry per selection, non-modal split view, the selected row is marked, Esc closes, focus returns. A row click selects; a button inside a row does its own job and returns focus.
  - Live update while reading: the panel, typed search text and focus, panel scroll and row order all survive. Report reading position also survives.
  - Back: returns to the same list position with the same selection and focus.
  - Import: errors beside the field, a failed import keeps your text and explains why, a resubmit saves no second copy, draft and receipt survive a reload, a valid report saves with a link, the draft clears.
  - Server restart: the connection loss is shown, and the next save works without a reload.
  - Phone: a modal sheet with an inert page behind it, focus moves in and returns. Cards show name, movement and all three grades. Main targets are at least 24 px.
  - Reduced motion turns transitions off. 200% zoom (640 CSS px) causes no sideways scroll on seven key pages. No script errors.
- **Add-project and research-route checks:** 16 of 16 passed (`evidence/add-and-research-flows.json`). They used a local stand-in for CoinGecko search, so no outside calls were made. The API route was only displayed, with a fake key and $0.01 limits, and nothing was submitted.
- **Copy prompt:** the panel and overview buttons copy the run's full prompt (24,993 characters).
- **Measured on 33 final screenshots:**
  - no text below the WCAG AA contrast thresholds, computed from rendered colors in light and dark
  - no page overflow
  - no controls without a name
  - 12 px smallest text
- **Records:** SHA-256 of all 45 record files (projects, portfolio, templates, inbox, settings, `workspace.json`) were identical before the pass and after deployment (`evidence/records-hashes-*.json`).

## Problems found during verification, and fixed

1. **The page froze after about six page loads.** This was pre-existing: the old interface froze on 26 of 41 phone-width loads in the same test (`evidence/old-ui-phone-freeze-comparison.json`). Cause: pages kept in the browser's back/forward cache held their live-update connections, using up the six connections a browser allows per server. The same would happen with several dashboard tabs open. Hidden or cached pages now release the connection and catch up when shown.
2. Moving the pointer from one grade to another could blank the scorecard without reopening it.
3. Opening the panel from a grade had its focus pulled back by the redraw. That reopened the scorecard and stopped Esc from closing the panel.
4. A live update could reopen a scorecard you had dismissed.
5. Grades scrolled out of view in the split view and at several widths. Column fitting is now measured instead of guessed.
6. A screen-reader-only table label escaped its scroll area and widened one page by 11 px.
7. Project names on phone cards were 21 px tall targets; they are now at least 28 px.
8. Demo data was labeled "CoinGecko".
9. Small link-buttons rendered too tall, and a settings checkbox and save button stretched.
10. Several listings found by name came with no guidance.
11. "1 projects".
12. Re-pasting text you had set aside got an unclear message.

## Remaining limits

- **No screen-reader session was run** (NVDA or Narrator). Accessibility was checked through the browser's accessibility tree, roles and labels, keyboard paths and computed contrast. A screen-reader user may still find gaps. This is not a claim of full WCAG conformance.
- **Contrast of borders and icons** is set by design tokens (control borders #86868b, about 3.6:1 on white) but was not machine-checked element by element. Dark mode was measured on three screens.
- **Touch and phones** were tested by emulation in headless Edge, not on a physical device. The dashboard is loopback-only, so a phone cannot reach it anyway. Scorecards need hover or keyboard focus; on touch, a tap opens the panel.
- **200% zoom** was emulated as a 640-px window at double density, not with the browser's zoom control.
- **Live Cowork and voice** were not exercised.
- **Paid model APIs** are untested. The API route was only displayed.
- **News or evidence watch and liquidity** remain unconfigured. There is no CoinMarketCap adapter.
- The badge shows analysis age only when stale. Exact dates are one hover or one click away.

## Deployment and how to undo it

- **Code snapshot taken before deployment:** `Documents\CryptoResearch-recovery\20261001T233543Z-pre-design-pass-code\`. It has a SHA-256 manifest and `RESTORE.md`, and contains code only, no records.
- **Deployed:** 14 code files, each copied under a temporary name, renamed into place and verified by hash.
  - `dashboard/public/`: `app.js`, `index.html`, `styles.css`, `ui.js`, and `views/` (`dialogs.js`, `portfolio.js`, `project.js`, `research.js`, `settings.js`, `updates.js`, `watchlist.js`)
  - `dashboard/server.js`
  - `dashboard/tests/ui-backend.test.js`
  - `dashboard/tests/ui-logic.test.js` (new)
- **Restart:** the running dashboard was restarted once, in the same titled window, so the server change applies.
- **Documentation updated:** `README.md` ("What you see" and the labels that changed) and one line in `COWORK-INSTRUCTIONS.md`, where "Paste the answer" became "Copy prompt" and "Import report".

## The check scripts

The scripts in `tools/` drive headless Edge over the DevTools protocol. They point at temporary copies under `%TEMP%\crdev`, and their paths are specific to that setup. They are kept as evidence of how each check was run:

- `sweep.js`: every page and tab
- `interactions.js`: hover, keyboard, panel, Back, live updates, import, restart, phone, motion, zoom
- `add-flow.js`: add project and research routes
- `grades-visible.js`: grade visibility across widths
- `capture.js`: screenshots and metrics
- `real-readonly.js`: the read-only look at the real dashboard
- `deploy.js` and `redeploy.js`: the reversible deployment
