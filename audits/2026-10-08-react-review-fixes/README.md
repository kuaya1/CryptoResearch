# React review fixes (2026-10-08)

Corrections for the five areas Eric asked to fix from the review of the React
frontend (`audits/2026-10-08-codex-react-review/REPORT.md`, local): report
identity (F1), startup and route recovery (F2, F3), the selected opinion (F4),
keyboard and the real phone entry (F6, F5), and the risk beside the verdict
(F7). Every finding was
reproduced on the deployed revision `2a9408e` before any edit, by new checks
that assert on what is drawn (text, links, positions), then fixed. FICTIONAL
workspaces only; no record, grade, ledger entry, API protection or connector
behaviour changed.

## How it is checked

- `dashboard/web/scripts/regress.mjs` (in `npm run check`; `npm run check:dev`
  against the Vite dev server): headless Chrome on the fictional dev desk
  behind `scripts/fault-proxy.mjs`, a loopback-only proxy that delays and
  fails reads, hangs or garbles the session, removes a chunk, forces a live
  change, and swaps one opinion for a renamed report with another grade,
  verdict and risk in both the index and the project record.
- `dashboard/tests/web-store.test.js`: the store in Node with a fake fetch.
- Result on `2a9408e` (before): 16 of 47 browser checks passed; the store
  tests failed 3 of 3 that ran and the hung-session test never finished.
  After: 52 of 52 (production build), 44 of 44 (dev server; the chunk and
  online sign-out cases need the built app), store tests 10 of 10, full suite
  614 of 614, `scripts/check.mjs` all passed. No request other than GET
  reached the desk during the regression run.

## Findings, reproduction, correction

**F1 · one report per displayed opinion.** Reproduced: the index named a new
report while its record took 15 s; the inspector showed the new grade 90.4,
verdict Avoid and the new report's link beside the previous report's risk
("Fictional: the token captures none of the fees today…"). Also in 22 rapid
project and model switches with 5 refreshes during 1.2 s delayed reads, and in
the store: a first read in flight during a broad refresh was cached as
current. Cause: grade, verdict and link came from the index summary, the
risk, categories and evidence from `latestOf`, which fell back to another
report when the record lacked the summary's; `dropAllProjects` skipped reads
still in flight. Correction: `web/src/lib/opinion.js` identifies an opinion by
the summary's report and accepts the record only when it holds that report
with the same grade, verdict and date; the inspector's report-derived parts,
its evidence fold and the project page draw only from it, else show a loading
state, or after one more read a note that the list and record differ, never
another report's words; Compare the models waits until every model agrees.
`projectDetail` shares a read among readers, cancels it when they all leave,
and marks reads obsolete on any drop, so a late answer is neither cached nor
handed out; `useProject` aborts on leave and ignores late answers. After: 0
mixed renders in 9 checks over the 15 s case and 44 over the rapid case.

**F2 · startup and route recovery.** Reproduced: HTML 503 from the session
left "Loading your workspace…"; a session that never answered had no message
after 24 s; a failed index offered no retry. Correction: the session read is
bounded to 20 s and checks status, type and shape; every failure (HTTP,
unreadable, network, timeout, failed index) shows what happened with Try again
(reads again, no write) and Reload, never an automatic reload; a 401 goes to
sign-in. On the online desk a 401 while open clears the workspace from memory
and the screen before sign-in, and a page restored from the back/forward
cache re-checks its session with the records hidden. After: HTML 503 said in
0.2 s, the hang said at 20.2 s, both recover by Try again.

**F3 · failure containment** (with F2). Reproduced: a missing project chunk
showed no error and no recovery; a missing hosted-parts chunk left empty
slots; a failed project read had no retry; an unhandled asynchronous error
was silent. Correction: each page, the inspector and each hosted part has its
own error boundary with Try again and Reload, the sidebar and list staying
usable; browsers keep a failed module fetch, so Try again asks for the file
again under a fresh query (pages, hosted pages, parts); project read errors
have Try again in the project page and the inspector; unhandled errors are
said in a toast. An open tab across a deploy whose chunks were retired gets
the same message, and Reload brings the new version; old assets are not kept.

**F4 · selected model and report.** Reproduced: ChatGPT chosen in the
Overview became Claude on Evidence; its "original report" was Claude's; an
earlier report chosen explicitly was replaced by the latest on every section;
a model with no report showed Claude's evidence. Correction: section links
carry `?model=` and an explicitly chosen `&report=`
(`project-routes.js` `selectionOf`, `sectionHref`); Full report opens the
chosen report or the model's latest and never pins the latest when you
return; a model with no report stays chosen and Full report says it has none;
Compare keeps its own pair; the inspector's Brief link opens the model chosen
there. After: Overview → Evidence → original report → Back → Back keeps
ChatGPT and its report throughout; revisions and missing reports as above.

**F5 · the real phone entry.** Measured watchlist → inspector → Brief, the
strongest-risk block (CSS px) against the top of the tab bar:

| Case | 360×780 before | after | 390×844 before | after |
|---|---|---|---|---|
| Complete | 542–683 | 484–625 | 551–692 | 493–634 |
| Withheld | 563–704 | 505–646 | 563–704 | 505–646 |
| Ranges | 560–**769** | 502–711 | 569–778 | 511–720 |
| Long name | 638–**846** | 499–708 | 647–**833** | 508–694 |
| Tab bar top | 719 | 719 | 783 | 783 |

Correction: on a phone the brief's back bar takes the top bar's place (with
the Test or Demo tag); a name over 48 characters reads in two lines with
Whole name to open it. Full text, warnings and controls are kept.

**F6 · keyboard.** Reproduced: the project's sections were declared tabs but
Right Arrow did nothing. Correction: they are page navigation, links in a
`nav` with `aria-current="page"`, matching what they are (addresses with Back);
the model tabs keep tab roles with Arrow, Home and End moving choice and
focus. Escape from a brief returns to the inspector.

**F7 · the risk beside the verdict.** Before: the inspector's risk started at
y921 at 1440×900 (body ends 815) and y1067 at 390×844 (ends 758). After: the
strongest sourced risk, then what would confirm and break, come directly
under the verdict (warnings as chips beside it), before the components,
revision, review items, take and categories; risk at y530–637 (1440) and
y609–716 (390). Missing items say "Not reported"; market time stays in the
header.

## Not verified

- Signed-in screens on the live desk: no authorized browser session was
  available, so the deployed check covers the revision, the start log and
  that pages and API still require sign-in.
- A real deploy with a tab left open (simulated by removing chunks behind the
  proxy), native screen readers and physical phones.
