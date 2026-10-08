# The desk's browser app (React + Vite)

The browser app for CryptoResearch: the watchlist, the project inspector and
the project page, and the shell (sidebar, phone top bar and tab bar) around
every other page. React, a component library and a dev server with immediate
refresh were approved by Eric on 2026-10-08.

The Node server (`dashboard/server.js`) needs **no** npm packages. This folder
is build tooling only: its production build is committed to
`dashboard/public/app/`, which the server serves at `/` behind the same sign-in,
host/origin checks and API protections as before. Render deploys `main` as it
always has (`node server.js`); it never runs Vite or `npm install` here.

## Commands

Run from this folder (or `npm run ui` / `npm run ui:build` at the repo root):

| Command | What it does |
|---|---|
| `npm install` | Once, from the lockfile (`package-lock.json`). Node 24. |
| `npm run dev` | A FICTIONAL offline desk (`scripts/dev-desk.cjs`) and Vite in front of it with immediate refresh. Open the URL it prints. Nothing leaves this PC: research runners, prices, DefiLlama, GoPlus and wallets are stubbed off; no key is set. Ctrl+C stops both and deletes the fictional workspace. |
| `npm run build` | The production bundle into `../public/app/` with `build.json` (a hash of every source file). Commit it with the source: the test suite fails when the bundle is older than its source. |
| `npm run check` | Headless Chrome on the built app over a fictional desk: no write or error on opening any page, keyboard and focus, Back and deep links, the phone first screen, 200% zoom, rendered contrast in light and dark, reduced motion, accessible names, load and navigation timings, bundle size (`scripts/check.mjs`); then the React review's reproductions behind a fault proxy (`scripts/regress.mjs`, `scripts/fault-proxy.mjs`): no mixed-report render under delayed reads, refreshes and 20+ rapid switches; startup and route failures recoverable; the chosen model and report kept across sections and Back; section and model-tab keyboard; the real phone entry; the inspector's risk right after the verdict; no writes. |
| `npm run check:dev` | The same regression checks against the Vite dev server. |

The dev server is never used in production: `dashboard/server.js` loads
nothing from this folder.

## Structure

- `src/lib/` the desk store (`desk.js`: one read of `/api/index`, the bounded
  live poll, API calls), the hash router (`router.js`: Back, deep links, scroll
  and focus memory) and hooks.
- `src/shell/` the sidebar, the phone top bar and tab bar, the More sheet.
- `src/components/` the small component library: grade pills, the metric header and
  score bars, figures, logos, menus (Radix), the `Dom` adapter for parts the
  app still hosts.
- `src/views/` the watchlist, the inspector and the project page (Overview in
  React; Compare, Evidence, Full report, Market and Notes hosted).
- `src/legacy/` hosts the views not yet ported (Portfolio and wallets, New
  research, Research, Updates, Explorer, Settings, and the project page's
  other tabs) inside the shell, unchanged in behaviour. Their stylesheets are
  scoped under `.lg` at build time (`scope-legacy.js`).
- `src/styles/` the app's CSS. The one token layer is
  `dashboard/public/tokens.css` (light, dark, reduced motion, icons), shared
  with the hosted views, the sign-in page and the OAuth consent page.

The pure rules stay in `dashboard/public` and are shared by both sides:
`ui.js` (formatters, states, tiers), `brief-model.js`, `thesis-ui.js`,
`compare-desk.js` / `compare-model.js`, `watchlist-model.js` (sorting,
filters, readiness, contract checks) and `project-routes.js`.

## Rules

- Opening a page, drawing a component or a dev refresh never writes, starts
  research or asks a paid provider. Writes are explicit actions only
  (`tests/web-app.test.js` lists the files allowed to write).
- No inline scripts or styles (the page's CSP is `'self'`); no secrets in the
  bundle (the tests scan it).
- Dependencies are pinned exactly; add one only for a real need.

## Dependencies

| Package | Why |
|---|---|
| `react`, `react-dom` 19.3 | Components and state for the list, inspector and project page. |
| `@radix-ui/react-dropdown-menu`, `@radix-ui/react-tabs` | Accessible menus and tabs (focus, keys, roles) without writing them by hand. |
| `lucide-react` | Icons as local inline SVG (no requests). |
| `vite`, `@vitejs/plugin-react` (dev) | Dev server with immediate refresh; the production build. |
