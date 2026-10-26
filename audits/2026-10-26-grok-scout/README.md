# Grok Scout (2026-10-26)

Eric's own authorized task, built as one PR he merges by hand on `claude/grok-scout` with his defaults: the four lanes, `grok-4.3`, and no X search. The plan, cost table and limits are in [PLAN.md](PLAN.md).

## What was built

- **The sweep, `dashboard/scripts/grok-cron.js`.**
  - It reads the frozen prompt `cr-scout-prompt@1` (`templates/scout/scout-prompt.v1.md`, pinned in `templates/scout/LOCK.json`) and refuses to run if the text differs from its pin.
  - Before any paid call it checks its key with the desk (`GET /api/ingest/scout-brief`), and stops with "Nothing was sent to xAI." when the desk is unreachable, refuses the key or has had six briefs today.
  - It then makes one xAI Responses call per lane (`web_search` only, `max_output_tokens` 8000, `store: false`), with no retry of a paid call. A lane that fails is recorded as missing, along with the usage xAI reported for it.
  - It posts one brief, retrying only on a network error or a 5xx answer.
  - It prints counts only: no item text, URL, key or desk address.
  - `--dry-run` needs no key and makes no network call. It prints the four requests exactly as they would be sent and the estimated cost.
- **The schedule, `.github/workflows/scout-cron.yml`.**
  - It runs at 11:30 UTC, plus a Run workflow button.
  - Scheduled runs happen only while the repository variable `SCOUT_ENABLED` is `true`.
  - The job uses `contents: read`, a checkout that keeps no credentials, one run at a time, a 15-minute limit and no npm install.
- **The route, in the front door (`dashboard/frontdoor.js` → `core/scout.js` `makeScoutRoute`), on the online desk only.**
  - One path, `/api/ingest/scout-brief`. `GET` with the key checks it and today's count, at no cost; `POST` delivers the brief.
  - `/api/ingest/ping` is not part of this route. It stays the signed-in ping from backlog item 66 (PR #29, merged while this was built), behind the sign-in like every other route.
  - `POST /api/ingest/scout-brief` takes `Authorization: Bearer <DESK_INGEST_KEY>`, compared by SHA-256 in constant time. The key needs at least 32 characters; ten refused keys in 15 minutes lock the route for 15 minutes.
  - While the desk has no key set, the route answers 404 "not set up".
  - Refused before the body is read: a browser Origin, anything but JSON, a body over 64 KB, and a seventh brief in one UTC day.
- **The saved records, `core/scout.js` `ingest`.**
  - The brief is checked field by field, with every problem listed and nothing saved.
  - Each brief is kept whole and create-only at `scout/briefs/sb-<YYYYMMDD>-<sha10>.json`.
  - `scout/items.json` is upserted in the same locked, verified save. The key is the normalized repository, else the normalized page.
  - The same brief delivered again is `unchanged` with its first receipt.
  - `scout` is in the backup and offsite package.
- **Reading it.**
  - The Research page has a Scout tab (`#/research?tab=scout`): items newest first, a lane filter, external links in a new tab with no referrer, and text shown as text.
  - `GET /api/scout` sits behind the sign-in. On this PC, use `node dashboard/cli.js scout list` and `scout status`.
  - One `Scout:` line appears in doctor and the start log of the online desk.
- **Protected.** `core/scout.js`, `grok-cron.js`, `scout-ingest.test.js`, `templates/scout/` and the `scout/` records folder are on the protected list. The guard test checks that the front door reaches only protected files.

Nothing the scout delivers becomes backlog, research, a ticket or a prompt. The cost figure on the desk is an estimate from xAI's own usage figures at `cr-scout-prices@1`; xAI's Usage page is the bill.

## The dry run (no key, no network)

`node dashboard/scripts/grok-cron.js --dry-run` printed the four requests (one per lane) and:

```
typical: $0.15 a lane, $0.61 a day, about $18 a month (150,000 input tokens, 100,000 cached, 8,000 output, 10 web searches a lane)
heavy: $0.28 a lane, $1.14 a day, about $34 a month (190,000 input tokens, 110,000 cached, 15,000 output, 25 web searches a lane)
```

These are my assumptions priced at xAI's published rates, not a measurement. The first paid run gives the real figures.

## Eric's steps (none of these values goes into a chat)

1. Merge the PR once its checks pass. Render redeploys `main`.
2. At console.x.ai, create the API key, buy $20 of prepaid credits, and keep the invoiced billing limit at $0. The balance is then the hard ceiling.
3. On this PC, generate the desk's ingest key:
   ```powershell
   [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
   ```
   Put it in Render's environment as `DESK_INGEST_KEY`.
4. In GitHub, add the Actions secrets `XAI_API_KEY`, `DESK_INGEST_KEY` (the same value) and `DESK_INGEST_URL` (the online desk's address).
5. Press Run workflow on `scout-cron` once. Then compare the desk's Scout tab and its cost estimate with xAI's Usage page.
6. To turn on the daily run, set the repository variable `SCOUT_ENABLED` to `true`. Set it to `false`, or remove the xAI key, to stop it.

## Not verified yet

- No call to xAI has been made. The request shape and usage fields follow xAI's documentation as read on 2026-10-26, and the first real run is the test of both.
- The route has run only against temporary FICTIONAL desks in the tests, never on Render.
