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

## Owner step (the only one)

1. Supabase → project **sandbox-desk** → Project Settings → **API Keys** → Secret keys → **Add new secret key**, named `cryptoresearch-pc`. Reveal and copy it. Never paste it into a chat.
2. Open the secrets file: `notepad $env:USERPROFILE\.cryptoresearch\secrets.json`. Add `"supabase_secret_key": "sb_secret_..."` as one more entry: a comma after the entry before it, none after the last. Save.
3. `node dashboard/cli.js explorer status` should say `configured` and a live read of 3 projects and 7 reports. (If the file stops parsing it says so.)
4. `node dashboard/cli.js explorer export --fixtures`, twice: both report 7 reports "unchanged".
5. Open the dashboard → **Explorer**.

The online desk is unchanged until a deploy; to use it there later, add `CR_SUPABASE_URL` and `CR_SUPABASE_SECRET_KEY` (a separate key, e.g. `cryptoresearch-render`) in Render → Environment.

## Switching it off

`node dashboard/cli.js explorer configure --off` (or `CR_EXPLORER=off`, or remove the key). `--on` brings it back. Removing everything: drop the four tables and two functions in Supabase, or pause the project.

## Limitations

- Real records are not exported (prepared in `deskSources`, refused by the command). A desk correction to an exported report would be refused as a conflict; a later version should export it as an explicit corrected revision.
- Reads return at most 1,000 reports and 1,000 projects (said on screen when reached).
- The "Demo data" label is page-wide; with real and demo rows mixed, rows would need their own label.
- The server keeps the last good read in memory for 30 seconds (Refresh asks Supabase at most every 5 seconds).
- Evidence flags are the desk's readings at export time; a later export refreshes them.
- No realtime, no schedule, no Supabase Auth, no second sign-in.

## Files

New: `supabase/migrations/20261007012543_explorer_schema.sql`, `supabase/migrations/20261007012617_explorer_lockdown_helpers.sql`, `dashboard/core/explorer.js`, `dashboard/core/explorer-adapter.js`, `dashboard/fixtures/explorer/fictional-records.json`, `dashboard/public/views/explorer.js`, `dashboard/public/explorer.css`, `dashboard/tests/explorer.test.js`, this README. Changed: `dashboard/server.js` (one route, one session field), `dashboard/cli.js` (`explorer` command and help), `dashboard/core/workspace.js` (settings default), `dashboard/public/app.js` (route and nav item), `dashboard/public/index.html` (stylesheet), `.gitignore` (allowlist `supabase/` and this README), `README.md`, `WORKSPACE-MAP.md`, `CLAUDE.md`. Local only (ignored): `harness.js`, `check.js`, `check-results.json`, `harness-info.json`, `shots/`. Workspace config: `config/settings.json` gained `explorer.supabase_url` (through the CLI, verified).

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
