# Forensics re-audit: corrections and the next five improvements (2026-10-17)

Response to the independent re-check of Forensics & Resilience
(`audits/2026-10-16-codex-forensics-recheck/`, 58 → 73/100), built on `main`
at `a64e21a`. Implemented locally; nothing was committed, pushed or deployed,
no real research was started, no paid or provider call was made, and no real
setting, monitoring target, project, wallet, portfolio or research record was
changed. Every write in the tests and browser checks went to a fictional
temporary workspace with stubbed providers.

## 1. Correctness prerequisites (R01–R08)

Each changed meaning has a new published version; the earlier definitions,
saved receipts and their originals are kept as they were. Outcomes recorded
under the earlier method get a correction line (method@3) on the monitor's
next run, never a rewrite.

| | What was wrong | What it does now | Version |
|---|---|---|---|
| R01 | A source on any domain, or an abbreviated chain reference, could attribute a finding or a discontinuation | Attribution only from a source on the project's own site (exact host, its subdomains, or its path when the site is path-scoped); a chain reference must name the full transaction or address on a chain of the frozen identity; anything else is "not tied to the project" | `cr-forensic-eligibility@2` |
| R02 | A reading without a token contract borrowed the identity's contract | Not counted, with the reason ("names no token contract"); a reading for another contract is not this token | `cr-forensic-eligibility@2` |
| R03 | Any repository read counted as delivery | Only a repository of the identity, one Eric approved, or one named in a capture on the project's own site | `cr-forensic-eligibility@2` |
| R04 | A transfer tax was multiplied into quotes; an unknown tax could read as a complete cost | The quote's own output is used and the tax is subtracted once; a positive tax not reconciled, or an unknown one, makes the cost a lower bound, never complete | `cr-forensic-liquidity@3` |
| R05 | A day's readings counted from noon, so a 03:00 UTC reading could be "in the future" | A day counts from its latest actual reading; the latest day is marked partial | `cr-forensic-scenarios@3` |
| R06 | Whitespace that changes meaning (in JSON strings, HTML) read as cosmetic | JSON is compared in canonical form (formatting only is cosmetic); anything else is compared as bytes | `cr-forensic-normalize@2`, `cr-forensic-review@2` |
| R07 | A stored projection that disagreed with its verified original was still drawn | The receipt is shown by its identity only, with the problems, and nothing on the page, in the case package, the agenda or the board is drawn from it | `cr-forensic-lifecycle@3` |
| R08 | On a phone the main concern's classification could fall below the tab bar | "Main concern", its classification, uncertainty and source sit above the allegation and above the tab bar (measured in the browser checks) | (layout) |

The reading method is `cr-forensic-method@3` (parts listed in Methodology).

## 2. The five improvements

### 2.1 Reproducible case package (`cr.forensic-case.v1`)

- **Download case** on the shown receipt and on each receipt in "Receipts and
  revisions" (`GET /api/projects/<id>/forensics/receipts/<receipt>/case`,
  signed-in). CLI: `node dashboard/cli.js forensics case <project> <receipt>
  [--out FILE]`, `node dashboard/cli.js forensics case-verify --file FILE`
  (offline, no workspace needed beyond the CLI).
- Contains the original report text, the frozen investigator prompt and
  evidence packet, the receipt record, the intact challenge (if any), up to
  2,000 monitor observations with their own hashes, and the exit calculation
  (inputs: chain, contract, decimals, quantity, price, tax, quote or reserves;
  result; basis). A manifest pins every file's SHA-256 and the receipt's text
  and block hashes.
- `missing` lists what is not in it and why: each source page the desk did not
  preserve (a hash is never shown as the page), an unavailable calculation,
  readings not counted with their reasons.
- Verification fails on any altered file, manifest, observation, receipt
  projection or calculation; the replay recomputes the exit from the inputs.
- Excluded: credentials and auth headers (none are stored), settings,
  portfolio, accounts, wallets, other projects. A receipt that disagrees with
  its original makes no package (409).

### 2.2 Disagreement resolution board (`cr-forensic-adjudication@1`)

- Section "Claude and ChatGPT disagree" on the Forensics tab: each finding of
  the shown assessment that ChatGPT's challenge of that exact receipt reviewed
  as overstated, unsupported or needing evidence. Both positions as saved,
  their receipt IDs, their sources (linked), and what would resolve it, taken
  from the two reports' own fields.
- Eric's judgment: Unresolved, Challenge accepted or Challenge rejected, with
  a reason (required). Stored append-only in
  `projects/<id>/forensics/judgments.jsonl` (`cr.forensic-judgment.v1`),
  naming the finding and both receipts with their block hashes. The same
  request ID, or the same judgment and reason again, is `unchanged`.
- A later assessment or challenge is a different disagreement: it inherits
  no judgment (earlier ones are listed apart). Opinions, grades, findings,
  reports and holdings never change. A tampered challenge is not compared and
  cannot be judged.

### 2.3 Fixed-token exit comparison (`cr-forensic-exit-compare@1`)

- Section "Exit at a fixed quantity", per approved exit-quote chain: the
  monitor's quotes at the position size (fixed dollars: the quantity sold
  moves with the price) beside quotes for one fixed quantity (what the
  position size bought at the first quote after the assessment).
- **Quote this quantity now** (`POST .../forensics/exit-compare/quote`) asks
  for that exact quantity once, through the existing adapter, request budget,
  provider gate, lease and restored-copy hold. Only the reference quantity can
  be asked. One request ID per click; a retry is `unchanged` with no second
  request. Saved as an `executable_quote` observation with `source:
  "explicit"`, `basis_kind: "fixed_token"`; it never enters the liquidity
  readings, the evidence-change queue or the packet's monitoring summary.
- Each row: quantity (exact base units and decimals for that chain and
  contract), price and its time, worth, received, cost, completeness. Value
  less net received reconciles to the cost; an unknown tax or network fee is
  "at least", never complete. Never a transaction, signature or wallet.

### 2.4 Outcome learning register (`cr-forensic-outcome-register@1`)

- Fold "Outcome register" on the Forensics tab, per intact receipt: each
  conditional estimate as frozen at its origin (assumption, level, date),
  what the stored readings show since, and whether their coverage permits a
  reading at all. A gap longer than the measure allows (volume 2 days, exit
  cost 3, delivery 7), readings that start late, or readings at another
  position size or limit make a row **Unevaluable**, never a success.
- States are words (Crossed by the date, Not crossed by the date, Crossed,
  no date projected, Not due, Unevaluable…). Checkpoint lines show the method
  each was recorded under; corrections follow the line they correct; methods
  are never pooled. Every episode on record, recovered ones included, is
  listed per outcome; the four outcomes overlap.
- The tally counts coverage per scenarios version (readable, unevaluable, not
  due), never hits. No probability, calibration, ranking or accuracy figure.
- Eric's interpretation: an optional note per row
  (`projects/<id>/forensics/outcome-notes.jsonl`), labeled his, append-only,
  replay-safe; it changes no evaluation.

### 2.5 Review agenda (`cr-review-agenda@1`)

- New page **Agenda** (`#/agenda`, sidebar and the phone's More sheet; `GET
  /api/agenda`): one primary next action per active project, with why it is
  due, the receipt, report or record behind it, and its basis in words:
  *Sourced* (a receipt's frozen checkpoint, a model's suggested review or
  horizon end, an open disagreement, an unreviewed evidence change, a receipt
  that disagrees with its original), *Conditional estimate* (a crossing frozen
  at a receipt's origin, never a forecast) or *Your choice* (a review date
  Eric set). Undated items are listed, never made primary.
- Always read from the latest intact receipt and the latest eligible reports:
  browsing an earlier receipt does not change it.
- Done, Snooze (until a date) and Reopen (`POST /api/projects/<id>/agenda`) are
  lines in `projects/<id>/forensics/agenda.jsonl`; a snooze survives a reload
  and ends on its date; the same request ID is `unchanged`. No notification,
  research, grade or monitoring change.

## 3. Storage, versions and compatibility

- New append-only files under `projects/<id>/forensics/`: `judgments.jsonl`,
  `outcome-notes.jsonl`, `agenda.jsonl`. They are in backups (the whole
  `projects/` tree), the complete package and the portable export
  (`forensics.judgments`, `outcome_notes`, `agenda_actions`). No schema of an
  existing record changed; old receipts read as before.
- New observation fields on explicit quotes only (`source: "explicit"`,
  `basis_kind`, `request_ref`); monitor quotes gain `basis_kind: "fixed_usd"`.
- Published definitions kept: eligibility@1, liquidity@1/@2, scenarios@1/@2,
  lifecycle@1/@2, method@1/@2, normalize@1, review@1 are unchanged; the view
  names the version each reading used.
- No new dependency, hosting change, recurring job or AI call. The features
  are deterministic and complete without a model.

## 4. Tests and checks run (fictional workspaces, stubbed providers)

- `node dashboard/cli.js test`: 724 tests. Last full run 723 passed; the one
  failure was Windows refusing a reserved local port (`EACCES 127.0.0.1:49664`)
  in `forensics-corrections`, which passed 22/22 when run again alone.
- New suites: `forensics-recheck` (R01–R07), `forensics-case`,
  `forensics-board`, `forensics-exitcompare`, `forensics-outcomes`,
  `forensics-agenda`. They cover writes and replays (duplicate and lost
  responses by request ID), stale selections (a later revision, an earlier
  receipt), tampered records, unavailable providers (gate, budget, restored
  copy, turned off), export and package restore, and that reading writes
  nothing and asks nothing.
- Strengthened, not weakened: `web-app.test.js` pins each new component's one
  POST path and checks that the agenda's read and the case download never
  post; existing tests that asserted the defective semantics (R04 tax
  multiplier, R06 whitespace) now assert the corrected ones.
- `npm run build` and `npm run check` (headless Chrome on the built app over
  the fictional dev desk): all browser checks passed and 78 of 78 regression
  checks passed (production build). Every page including Agenda opens with no write,
  error or unnamed control; the five parts' one-write-per-click flows (quote,
  judgment, snooze, reopen) with reload; Download case is a read; keyboard
  and focus return (judgment choices, Snooze date field and Escape); phones at
  390×844 and 360×780 in both themes (first screen, stacking, 44px controls,
  no sideways scroll); contrast in light and dark with every fold open;
  reduced motion.

## 5. Not verified here

- Nothing ran against the online desk (Render) or a real workspace; the
  real records were only read where a test needed none of them.
- No real KyberSwap or Jupiter request was made: the explicit quote ran its
  real path against a fictional quote source.
- The Agenda has no count in the navigation (it would need a read of every
  project on each index load; it is read when the page opens).
