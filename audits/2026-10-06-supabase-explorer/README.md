# Research Explorer (Supabase), first version — 2026-10-06

Status: built and tested on `main` at 08ff526 (working tree, **not committed, pushed or deployed**, as Eric asked). One owner step remains: a Supabase secret key on this PC (below). Everything else is done.

## What it is

An optional page, **Explorer**, that compares one diagnostic category grade across projects, model by model, from a small Supabase database. It is for learning and comparison only. The desk's Markdown/JSON records (and the online desk on Render) stay the record, and nothing on the desk depends on the Explorer.

Path: browser → `GET /api/explorer` on the desk's own Node server (same sign-in, token, host and cross-site checks as every route) → Supabase REST API with a server-side secret key → JSON → the comparison view. The browser never talks to Supabase and never sees a key. Writes go one way only, from the CLI, through one database function.

## Supabase project

- Project **sandbox-desk** (ref `oflelsyzifreqntfncrm`), organization CryptoResearch, **Free** plan, region **us-west-2** (the Render desk runs in Oregon). It existed and was empty (no tables, users, buckets, functions or migrations) when this work began, so it was used instead of creating a second project. No plan change, no add-on, no other project touched.
- Migrations applied (files in `supabase/migrations/`, same names):
  - `20261007012543_explorer_schema`: four tables, constraints, immutability triggers, `explorer_import()`, RLS, grants.
  - `20261007012617_explorer_lockdown_helpers`: closes the API route to Supabase's pre-installed `rls_auto_enable()` (security advisor warnings 0028/0029). Auto-RLS still fires (checked).
- Data: FICTIONAL fixtures only. 3 projects, 7 reports, 90 category scores, loaded through `public.explorer_import()` as `service_role` with the exact batch `explorer export --fixtures --dry-run` prints. Run twice: the second run inserted nothing (3 projects and 7 reports "unchanged").
- Security advisor afterwards: only "RLS enabled, no policy" (INFO) on the four tables. That is intended: no client role may read them.

## The tables

| Table | One row per | Holds |
|---|---|---|
| `projects` | project | stable ID, name, ticker, identity status; chain and contract only for a verified identity (one project per contract); `dataset` demo or desk |
| `reports` | saved model report | model, research date, save time, horizon, prompt / rubric / profile / format versions, verdict, revision lineage (`revision_of`, kind, basis, note), the desk's calculated grade (firm, range, withheld with coverage and the unscored components), the desk's evidence-check summary, a content hash |
| `category_scores` | category grade of a report | `status` scored / range / unknown / not_applicable, the point or the two ends, confidence, evidence references, rationale, main weakness, why unknown, evidence flags |
| `export_runs` | export | when it ran and what it inserted, left unchanged or refused |

How they connect: `category_scores.report_id` → `reports.report_id`; `reports (project_id, dataset)` → `projects`; `reports (revision_of, project_id, model)` → `reports`, so a revision can only name an earlier report of the same project and model. The six weighted investment components are not in `category_scores`: the report row keeps only the grade the desk calculates from them. Nothing combines models.

Meaning kept: a point has only `score`; a range only `score_low`/`score_high` (never a midpoint); unknown and N/A carry no number at all (a check constraint refuses one). Zero is a valid number (0–100 allowed; the desk's rubric cr-grading@1 itself scores 1–100, so desk reports never contain 0). A withheld grade has no number, only coverage.

Immutability: a stored report and its scores never change (a trigger refuses UPDATE and DELETE, even for the owner). Only the desk's evidence readings on an unchanged report may refresh, because evidence checks are read-time and change no score. A changed report under a stored ID is refused as a conflict; a change is a new report that names the old one in `revision_of`.

## Security

- RLS on all four tables with no policies, and every privilege of `anon` and `authenticated` revoked (tables and functions). `service_role` (the secret key) may SELECT, INSERT, update only the listed identity and evidence-reading columns, and execute `explorer_import()`. No DELETE or TRUNCATE.
- A secret key bypasses RLS, so the desk checks its own sign-in on every Explorer request: the route sits behind the token (and, online, the passphrase cookie), host check and cross-site refusal like every other route.
- Key handling: `supabase_secret_key` in `%USERPROFILE%\.cryptoresearch\secrets.json` or `CR_SUPABASE_SECRET_KEY`; never in settings (the settings writer refuses key-like names), the page, `/api/session`, logs, errors or Git. Sent only in the `apikey` header (never the URL). Publishable and anon keys are refused by the desk. The URL must be `https://<ref>.supabase.co`, so a changed setting cannot send the key elsewhere. Test and demo workspaces never read the secrets file.

## Verification

- Database (live, inside rolled-back transactions): import inserts a report whole; a repeat is "unchanged"; changed content is "conflict"; a report with one bad score is refused with zero partial rows; `service_role` cannot update or delete; the owner's UPDATE is refused by the trigger; 0 is stored as a score, unknown stays NULL; `anon` and `authenticated` (with JWT claims set) get "permission denied" on tables and the import function.
- Live direct requests to the REST API: with no key (401 "No API key found"), with the publishable key and with the legacy anon key (401, 42501 permission denied) on all four tables, embedded selects, the import RPC, inserts, deletes and `rls_auto_enable`; GraphQL is not enabled. Nothing readable.
- Repeated export: on the real database, two runs of the same batch leave 3 / 7 / 90 rows with no duplicate (report, category) pair.
- Meaning on the real database: 70 point scores (each with a point only), 9 ranges (ends only), 10 unknown and 1 N/A (no numbers); grades and revision lineage as the desk calculates them.
- Tests: `dashboard/tests/explorer.test.js`, 14 tests, all pass (adapter meaning, components kept out, revisions, evidence flags, zero, malformed grades refused, desk export refused, key handling, export idempotency and conflicts against a stand-in REST API, unavailable/stale/empty states, the route's token, cross-site, host and method checks, the online desk's sign-in, no writes and no research on read, failure isolation, the view's sorting and grouping).
- Full suite: 508 tests, 506 pass. The 2 failures are the same tests with the same messages as before this work (baseline 494 / 492): the hosted first-boot test (Windows temp is not a persistent disk) and the offsite readiness test (this PC now has `CR_BACKUP_KEY`, so the expected "missing key" wording no longer appears).
- Browser (headless Chrome, `check.js` against `harness.js`, a TEST workspace with a local stand-in for Supabase seeded through the real export path), 1440 and 390 px: no horizontal overflow, no text under 12 px, no page errors; "Demo data", sync line, four scoring-version groups with the comparability notice; unknown, range, N/A, withheld, revision and evidence-flag states in words; the page made no request to Supabase or the stand-in and sent no write; the key is not in the page; with Supabase hanging the Explorer says "Supabase unavailable" (showing the copy read earlier, with its time) and the watchlist still loads. Screenshots in `shots/` (local).
- Not yet exercised: the desk's own HTTP call to the real Supabase with the secret key (it needs the key on this PC). The same requests were checked against the stand-in, and the same import ran on the real database through the connector.

## Live verification with the secret key (2026-10-07)

Eric put the secret key in `secrets.json` and ran `explorer export --fixtures` twice (both runs: 7 reports unchanged, 0 refused). Then `live-check.js` (local, read-only) ran the desk server on a temporary FICTIONAL test workspace pointed at the real project, with the real key passed through its environment and never printed. Results in `live-check-results.json`:

- `GET /api/explorer` with the token: 200, `no-store`, served from Supabase. It returned 3 projects, 7 reports and 90 grades, all demo data, with the last export time. Unknown grades came back null.
- Refusals: no token 401, wrong token 401, cross-site 403, other host 403.
- The key, a long piece of it, or any `sb_secret_` string appears nowhere it was looked for:
  - the API response and its headers;
  - `/api/session`;
  - the refusals;
  - all 28 files under `dashboard/public` (served and on disk);
  - all 107 response bodies the browser loaded;
  - the page HTML, `localStorage`, `sessionStorage` and cookies;
  - the server's log.
- Server to Supabase: GETs only, to `/projects`, `/reports` and `/export_runs`. The key went only in the `apikey` header: no `Authorization` header, never in a URL, no write.
- Browser: no request to Supabase or any other origin, no write, no page error. Both 1440 and 390 px were checked with no overflow, showing "Demo data", "Synced · last export …", 4 version groups and 6 latest rows.
- Timeout (simulated in front of the server's fetch, with the read limit at 2 s): "Supabase unavailable · showing the copy read <time>" with the rows kept, and "Supabase did not answer within 2 seconds."
- Refused connection with no earlier copy: "Supabase could not be reached (ECONNREFUSED)" with no stale rows. The watchlist still loads.
- Recovery: Refresh returns to "Synced".
- Tests: 508 of 508. The two earlier failures were test isolation, not platform limits:
  - The offsite test read the PC's real `secrets.json`. It now points the offsite key lookup at a file that does not exist.
  - The hosted first-boot test wrote its fake mount table with a Windows path. It now writes it the way the guard reads paths; on Linux that is unchanged.
- Unchanged in this pass:
  - the database schema (the same two migrations);
  - the database rows: 3 / 7 / 90, all demo;
  - real-record export, still refused.

## Single-project canary (2026-10-07)

- **The command:** `node dashboard/cli.js explorer export --project <project_id> --dry-run`.
- **What it does:** reads that one project through the same adapter (`deskSourceFor`) and prints the exact body `explorer_import()` would receive, `{ batch }`. It adds the SHA-256 of that body and of each report row, so two previews of unchanged records match byte for byte.
- **What it does not do:** it reads no key, makes no network call and writes nothing.
- **What stays refused:**
  - the same command without `--dry-run`;
  - `--desk` (every project at once);
  - an archived project.
- **The fixtures:** `--fixtures` is unchanged.
- **Hashes:** the ones printed are of the JSON as sent. Supabase computes its own `content_sha256` from the stored values, so the two differ.
- **On this PC, with every network call blocked by a preloaded guard (none was attempted):**
  - `huma-finance`: 1 report (2026-10-01, Claude, payfi-credit@1, range grade 30.25–31.75), 11 category grades, a 5,693-byte body.
  - `allora-network`: the project row and no reports.
  - No file in the workspace changed.
  - The online desk's 37 projects are on Render's disk, not on this PC.
- **Tests:** 509 of 509 (one new test for the canary).

## Second opinion (2026-10-07)

**Compare opinions** on any Explorer row opens one project's saved reports side by side, category by category. It asks no model anything, starts no research and writes nothing.

- **Default pair:** the latest Claude report and the latest ChatGPT report, by the desk's own rule (`reports.js` `reportSortKey`, run on the server over the stored analysis day and save time and sent as `order_key`). Gemini's saved reports can be chosen; it is never the default. When a model has no report, its side says so and stays empty; nothing older or from another model is put in its place.
- **Choosing:** two pickers list every saved report by model, newest first by the same rule, marked "latest", "revision · <reason>" or "revised later" from the desk's own revision link (`revisions.js` `revisionOf`, stored at export). An original beside its revision reads "Claude (original)" and "Claude (revision)" ("earlier revision" and "later revision" along a chain); two unrelated reports by one model read "Claude (first)" and "Claude (second)".
- **Summary first:** each report's analysis and save dates, scoring profile and rubric, prompt, horizon, what it revises, and its grade as stored (a figure, a range, or withheld with its coverage and what was not scored). Then whether the two answered the same request:
  - **Research scope matches:** both state the same research run, prompt version, scoring profile, rubric and horizon, and the same frozen prompt and evidence packet hashes where stored. The Explorer does not store those hashes yet: they are listed as "Not stored in the Explorer · not compared", never assumed to match. Under a matching scope: "A matching scope means the same request, not a correct answer: it does not certify that either report is accurate."
  - **Research scope differs:** a fact both state differs. **Scope not confirmed:** nothing differs, but a fact is missing ("ChatGPT states no horizon", or a hash stored for one report only). Either way the facts are listed (≠ for a difference) and "Read side by side; this is not a controlled comparison."
  - **Authorship, a separate fact:** "Independent authorship" for two models; "Original and revision" when one report revises the other ("the same model's judgment again, not an independent second opinion"); "Same model" for two unrelated reports by one model. A revision can match the scope and still not be independent.
  - **Scoring versions:** a number is compared only when both reports state the same profile and rubric versions and define the category the same way (the same stored ID and label). Otherwise the row reads "Different scoring versions", "Scoring version not stated" or "Category definitions differ", with both values shown; a category only one profile has says so.
- **Each category:** two 0–100 bars (a range as its span, Unknown dashed, N/A empty), the value and the confidence, and one label:
  - two points: "Same score" or "n-point difference";
  - a point and a range: "Inside the range" or "Outside the range by n points";
  - two ranges: "Scores overlap" or "Separated by n points";
  - Unknown: "Evidence missing"; N/A: "N/A for <model>" (never 0, never compared);
  - no grade: "Not graded by <model>".
- **Evidence (per row):** each model's reason (or why N/A, or why unknown), evidence references, main weakness and the desk's evidence-check flags, as exported. "What would change it" reads "Not available in Explorer": the report's raise/lower conditions are not exported, and nothing is invented in their place.
- **Order:** "For inspection" (comparable differences of 5+ points, then missing evidence, then close, then the rest; "Not an investment ranking") or "Profile order". Nothing is averaged, combined, turned into a midpoint or declared right.
- **How the data is read (the join):** `GET /api/explorer/compare?project=<id>`, behind the same sign-in, token, Host and Origin checks. The server asks Supabase for that project's row and its reports (`reports.project_id = <id>`), then the category grades of those reports (`category_scores.report_id in (<those report IDs>)`, up to 100 IDs a request, one request per page, never one per category), and files each grade under its report. Every request is paged with a `Range` header and an exact count; a short or inconsistent count is refused as incomplete, never shown as complete. A Supabase failure shows its reason in the panel; the rest of the desk carries on.
- **Fixtures:** three new FICTIONAL projects (`demo-meridian-ledger`, `demo-corvid-bridge`, `demo-sable-grid`), six reports; the seven earlier reports are byte for byte unchanged. Locally: 6 projects, 13 reports, 167 category grades. They are not in the Supabase demo project yet: `explorer export --fixtures` inserts the 6 new reports and leaves the 7 unchanged.
- **Checked** (stand-in Supabase capped at 4 rows per answer, headless Chrome at 1440 px and 390 px): every acceptance case (two points; a point inside a range; overlapping and separated ranges; unknown, N/A and withheld; different scoring versions; a report without scope; an original and its revision; one model only; a Supabase failure; Meridian's grades read in 7 pages). No horizontal overflow, every control named, nothing under 12 px, Enter and Escape with focus returned to the row's button, 7 comparison reads and no write, no request to another origin. Screenshots: `shots/compare-*.png` (local only).
- **Tests:** 512 of 512 (three new: the rules, the fixtures, the paged endpoint).

### Hardening before real records (2026-10-07)

- **The list is never cut off.** The main Explorer read had stopped at 1,000 rows. It now reads every row in pages: the reports first, then the projects and the category grades (an export stores a report with its project and grades in one transaction, so nothing listed lacks its grades), each query in a unique order that ends with the table's key (`saved_at.desc,report_id.asc`, `name.asc,project_id.asc`, `report_id.asc,category_id.asc`), with an exact count. A row that comes back twice, or a count that changes between pages (an export landing mid-read), makes the read "unavailable" with the reason and "Refresh to read it again"; a short read is never shown as complete. Counts, the category list and every filter run over all rows. The "Only the first 1,000 rows" notice is gone with the cap.
- **One rule for "latest".** The list's "Latest" and Compare opinions' pickers both use the desk's own `reportSortKey` (the same code). A stated analysis date more than a day after the save sorts at the save time, so it can never keep a report "latest"; a report saved later is still the latest by its save time, as on the desk. Checked against the desk's own `latestByProvider` and `revisionOf` on the same FICTIONAL desk records (a future-dated report saved before and after the current one; Halcyon's original and revision).
- **Tests:** 515 of 515 (three new: the desk's rules; scope, authorship and definitions; the list past 1,000 grade rows: 90 extra FICTIONAL projects, 1,337 grades, two pages at Supabase's 1,000-row cap and 191 pages at 7 rows, the same rows either way; a repeated page and a mid-read export refused). The browser checks were run again (no overflow, every control named, nothing under 12 px, reads only).

## Owner step (the only one)

1. Supabase → project **sandbox-desk** → Project Settings → **API Keys** → Secret keys → **Add new secret key**, named `cryptoresearch-pc`. Reveal and copy it. Never paste it into a chat.
2. Open the secrets file: `notepad $env:USERPROFILE\.cryptoresearch\secrets.json`. Add `"supabase_secret_key": "sb_secret_..."` as one more entry: a comma after the entry before it, none after the last. Save.
3. `node dashboard/cli.js explorer status` should say `configured` and a live read of 3 projects and 7 reports. (If the file stops parsing it says so.)
4. `node dashboard/cli.js explorer export --fixtures`, twice: the second run reports every report "unchanged" (13 since the Second opinion fixtures; the first run after them inserts the 6 new ones).
5. Open the dashboard → **Explorer**.

The online desk is unchanged until a deploy; to use it there later, add `CR_SUPABASE_URL` and `CR_SUPABASE_SECRET_KEY` (a separate key, e.g. `cryptoresearch-render`) in Render → Environment.

## Switching it off

`node dashboard/cli.js explorer configure --off` (or `CR_EXPLORER=off`, or remove the key). `--on` brings it back. Removing everything: drop the four tables and two functions in Supabase, or pause the project.

## Limitations

- Real records are not exported (prepared in `deskSources`, refused by the command). A desk correction to an exported report would be refused as a conflict; a later version should export it as an explicit corrected revision.
- Every list read is complete or refused as incomplete (no row cap). One read is several requests, not one snapshot: an export landing between them is caught by the counts, and Refresh reads again.
- Compare opinions: "What would change it" is not exported ("Not available in Explorer"); the six weighted components are not compared, only the diagnostic categories.
- "Latest" is the desk's rule over what the Explorer stores, the analysis day: two reports by one model analyzed the same day order by save time (the desk also uses the time of day). A report stored without a day sorts at its save time: that covers a time the desk would not use (it does the same) and a report that states no time at all (the desk sorts that one before dated reports; the Explorer cannot tell the two apart).
- The frozen prompt and evidence packet hashes are not exported, so the scope check lists them as not stored. Storing them needs a migration (two nullable columns) and a content hash that leaves them out while empty, or the 7 stored demo reports would read as changed: a later export enhancement, like "What would change it".
- The "Demo data" label is page-wide; with real and demo rows mixed, rows would need their own label.
- The server keeps the last good read in memory for 30 seconds (Refresh asks Supabase at most every 5 seconds).
- Evidence flags are the desk's readings at export time; a later export refreshes them.
- No realtime, no schedule, no Supabase Auth, no second sign-in.

## Files

New: `supabase/migrations/20261007012543_explorer_schema.sql`, `supabase/migrations/20261007012617_explorer_lockdown_helpers.sql`, `dashboard/core/explorer.js`, `dashboard/core/explorer-adapter.js`, `dashboard/fixtures/explorer/fictional-records.json`, `dashboard/public/views/explorer.js`, `dashboard/public/views/explorer-compare.js` and `dashboard/public/compare-model.js` (Second opinion), `dashboard/public/explorer.css`, `dashboard/tests/explorer.test.js`, this README. Changed: `dashboard/server.js` (one route, one session field), `dashboard/cli.js` (`explorer` command and help), `dashboard/core/workspace.js` (settings default), `dashboard/public/app.js` (route and nav item), `dashboard/public/index.html` (stylesheet), `.gitignore` (allowlist `supabase/` and this README), `README.md`, `WORKSPACE-MAP.md`, `CLAUDE.md`. Local only (ignored): `harness.js`, `check.js`, `check-compare.js`, `check-results.json`, `compare-results.json`, `harness-info.json`, `shots/`. Workspace config: `config/settings.json` gained `explorer.supabase_url` (through the CLI, verified).

## SQL to try (Supabase → SQL Editor; all read-only)

```sql
-- 1. One category across projects; each model keeps its own row
select p.name, r.model, r.profile_version, s.status, s.score, s.score_low, s.score_high, s.confidence
from category_scores s
join reports r on r.report_id = s.report_id
join projects p on p.project_id = r.project_id
where s.category_id = 'legitimacy'
order by r.profile_version, coalesce(s.score, s.score_low) desc nulls last;

-- 2. What kind of grade each report gave, and its overall grade status
select r.report_id, r.model, r.grade_status, r.grade_coverage_pct,
       count(*) filter (where s.status = 'scored')         as points,
       count(*) filter (where s.status = 'range')          as ranges,
       count(*) filter (where s.status = 'unknown')        as unknowns,
       count(*) filter (where s.status = 'not_applicable') as not_applicable
from reports r
join category_scores s on s.report_id = r.report_id
group by r.report_id, r.model, r.grade_status, r.grade_coverage_pct, r.saved_at
order by r.saved_at;

-- 3. A revision beside the report it revises: which grades changed
select rev.report_id as revision, rev.revision_kind, rev.revision_basis, orig.report_id as original,
       a.category_id,
       coalesce(a.score::text, a.score_low || '–' || a.score_high, a.status) as before,
       coalesce(b.score::text, b.score_low || '–' || b.score_high, b.status) as after
from reports rev
join reports orig on orig.report_id = rev.revision_of
join category_scores a on a.report_id = orig.report_id
join category_scores b on b.report_id = rev.report_id and b.category_id = a.category_id
where (a.status, a.score, a.score_low, a.score_high) is distinct from (b.status, b.score, b.score_low, b.score_high);
```

## Hands-on exercise: try to break it (nothing changes; each is refused)

Run each on its own in the SQL Editor and read the error:

```sql
-- a) Change a stored score. Refused by the immutability trigger, even though the SQL Editor is the owner.
update category_scores set score = 99 where report_id = '2026-10-02_claude_demo0001' and category_id = 'legitimacy';

-- b) Give an unknown grade a number. Refused by the check constraint category_scores_shape.
insert into category_scores (report_id, category_id, category_label, position, status, score)
values ('2026-10-02_claude_demo0001', 'practice', 'Practice', 40, 'unknown', 0);

-- c) Read as the public (the publishable key's role). Refused: permission denied.
begin; set local role anon; select count(*) from reports; commit;
```

Then answer for yourself: which of the three would still be refused for the secret key (`service_role`), which bypasses RLS? (a: yes, the trigger and the missing UPDATE grant; b: yes, constraints apply to every role; c: not refused, which is why the desk checks its own sign-in before using that key.) Error (c) suggests `GRANT SELECT ... TO anon`: do not follow it, that would publish the table.
