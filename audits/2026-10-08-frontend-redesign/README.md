# Frontend redesign and modernization (2026-10-08)

Eric authorized a substantial redesign and a modern frontend: React, a
component library and a dev server with immediate refresh, superseding the
earlier rules that required dependency-free code, unchanged desktop layouts or
fixed dimensions where they prevented the redesign. The records, the research
engine, the MCP connector, the server's protections and the Render service are
unchanged.

## What changed

- **Architecture.** `dashboard/web` (React 19, Vite 8, Radix menus and tabs,
  lucide icons; pinned lockfile) builds into `dashboard/public/app`, committed
  with `build.json` (a hash of every source). The Node server serves it at `/`
  behind the same sign-in, host/origin checks, CSP and API protections and
  still needs no npm packages. One token layer, `dashboard/public/tokens.css`,
  shared by the app, the hosted views, the sign-in and the consent page.
- **Shell.** A sidebar (New research, Watchlist, Portfolio, Research, Updates,
  Explorer, Settings, the connection, Sign out), an icon rail on a tablet, and
  on a phone a top bar with a bottom tab bar (Watchlist, New research,
  Portfolio, More). Each page is one white panel beside the sidebar.
- **Watchlist** (React): the title and Add project, the status strip under it,
  search, Watching / Not watching / All, Filters, Sort and Columns menus, a
  denser table with each model's grade in its own column, cards on a phone.
  Selection, scroll and keyboard (/, Ctrl/Cmd+K, J/K, Space/Enter, R with
  Undo, Escape) kept; live updates never reorder rows while you read.
- **Inspector** (React): docked from 1280px, a modal drawer below, full screen
  on a phone; header, four figures, verdict with model tabs and the gauge,
  thesis, categories, risks, market structure and contract chips, folded
  details; the chart, DEX card and timing facts hosted from `views/`.
- **Project page**: header, model tabs and the Overview in React (identity,
  then the grade or withheld state, verdict and research age, the strongest
  sourced risk, confirm and break; then categories, the six components apart,
  thesis, watch, scenarios). Compare, Evidence, Full report, Market and Notes
  are hosted unchanged.
- **Hosted views** (Portfolio and wallets, New research, Research, Updates,
  Explorer, Settings) run inside the shell unchanged in behaviour, their CSS
  scoped under `.lg` at build time.

## Design decisions

- Light, Linear-inspired: slate canvas, white panels, one quiet indigo accent
  for the current page, links and the one primary action; green, red and
  amber only where a figure or state earns them. Dark is the same desk at
  night.
- Grades stay separate per model, never combined; ranges stay two numbers;
  unknown stays "—" with its reason; withheld shows the share of the weight
  scored. Presentation reads the same shared rules as before (`ui.js`,
  `brief-model.js`, `compare-desk.js`, `watchlist-model.js`).
- On a phone the project Overview puts the strongest sourced risk on the first
  screen: the model tabs show name and grade (the chosen verdict heads the
  sheet), the review line keeps to one line, the gauge's word sits under it,
  and the Test notice lives in the top bar's tag.

## Verification (local, fictional desk)

- `node dashboard/cli.js test`: full suite passed (fictional temp workspaces).
- `npm run check` (dashboard/web) on the production build served by the Node
  server: all checks passed. Opening 16 pages wrote nothing and logged no
  error; every control named; keyboard and focus (/, J, Enter, Escape, R with
  exactly one write and Undo with exactly one), drawer focus in and back, the
  More sheet, Back keeping the list's place, `?open=` deep links; no sideways
  scroll at 720, 640 and 320 CSS px; rendered text contrast passed in light
  and dark; nothing animates with reduced motion; the strongest-risk block is
  whole above the tab bar at 390×844 and 360×780 (complete, withheld, ranges).
- Timings (headless, this PC): watchlist rows drawn 190 ms cold, 140 ms warm;
  J to the next project 94 ms; inspector to Overview 319 ms; Back to the list
  64 ms.
- Bundle: first load 8 files, 159 KB gzip (529 KB raw); everything 370 KB
  gzip, the project page and hosted views loaded on demand.

## Limits

- The hosted views keep their own layouts inside the shell until they are
  ported; `styles.css` still carries rules for the replaced watchlist until
  they are pruned.
- Screenshots were taken on fictional data only; the live desk was not opened
  with Eric's records.
