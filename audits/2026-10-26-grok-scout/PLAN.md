# Grok Scout: plan (2026-10-26)

Status: **built as planned** on `claude/grok-scout` (Eric, 2026-10-26: the four lanes, `grok-4.3`, no X search, one PR he merges by hand). Written against `main` at `ff6d16e`. What was built and what is still Eric's is in [README.md](README.md).

## What it does

Every morning a GitHub Actions job asks Grok (the xAI API) for a short sweep: tools, repositories and write-ups worth knowing about, in four fixed lanes. The job sends the result to the online desk. The desk keeps each delivery on its own disk, beside the engineering inbox, and shows the current list on the Research page.

Supabase is not involved.

Rules:
- **Nothing it delivers is an instruction.** A scout item never becomes backlog, starts research, opens a task or reaches a prompt. Eric reads it, and anything he wants built goes through his usual intake.
- **The key gate.** Nothing uses the xAI key until Eric has seen the exact requests and the cost, then started the first run himself.

## Eric's decisions (defaults in bold; change any before the build)

1. **The four lanes.** Nothing defines them yet, so these are my proposal, picked to serve the North Star:
   - **`agents`**: coding agents, orchestration and review tools (the self-building codebase, Track 1).
   - **`onchain`**: on-chain data, DEX liquidity and exit-measurement tools (Forensics and Exits).
   - **`desk`**: trading-desk risk, paper trading, backtesting and position sizing (Track 2).
   - **`security`**: security for agent pipelines, supply chain and secrets handling.
2. **Model: `grok-4.3`.** It costs about half as much as `grok-4.7`, with a 1M context window. Costs for both are below.
3. **X search: off in the first version.** It is billed per post returned and would roughly double the cost. It can be switched on later for one lane.
4. **xAI billing: buy $20 of prepaid credits and keep the invoiced billing limit at $0, which is xAI's default.** xAI then refuses requests once the credits run out, so $20 is the hard ceiling. xAI doesn't refund prepaid credits.
5. **The build: an ordinary PR Eric merges by hand,** like #22 and #25, not a delegation. It changes protected files (the front door, the workflow and the protected list), so promotion would hold it for him anyway. This is my reading of "my own authorized task".

## xAI cost (estimate, before any run)

xAI's prices, read from docs.x.ai on 2026-10-26, in dollars per million tokens:

| | Input | Cached input | Output |
|---|---|---|---|
| grok-4.3 | 1.25 | 0.20 | 2.50 |
| grok-4.7 | 2.00 | 0.50 | 6.00 |

- **Search fees:** web search is $5 per 1,000 calls. X search is $5 per 1,000 posts returned, or $10 per 1,000 profiles.
- **Large requests:** a request whose prompt reaches 200,000 tokens is billed at double those rates.

### My working assumptions

These are mine, not xAI's:
- **One request per lane, four a day.** Each request stays well under 200,000 tokens, so the doubled rate shouldn't apply.
- **A typical lane:** 10 web searches, about 150,000 input tokens billed across the model's turns (two-thirds of them cached), and about 8,000 output tokens.
- **A heavy lane:** 25 web searches, about 190,000 input tokens (110,000 cached) and 15,000 output tokens.

### Estimated cost

| Web search only | Per lane | Per day (4 lanes) | Per month (30 days) |
|---|---|---|---|
| grok-4.3, typical | $0.15 | $0.61 | **about $18** |
| grok-4.3, heavy | $0.28 | $1.14 | about $34 |
| grok-4.7, typical | $0.25 | $0.99 | about $30 |
| grok-4.7, heavy | $0.43 | $1.72 | about $52 |

Turning X search on for one lane, at about 60 posts a day, adds about $0.30 a day, or $9 a month, plus the tokens to read those posts. For all four lanes it adds about $36 a month.

### Limits

- xAI documents no setting that caps how many searches the model makes in one request. The prepaid balance is the real ceiling, so with $20 of credits the most it can ever spend is $20.
- The job makes exactly one attempt per lane per day and never retries a paid call. A lane that fails is reported as missing.
- Every delivery carries xAI's own usage figures (tokens, cached tokens and tool calls). The desk turns them into a cost using a frozen price table (`cr-scout-prices@1`, dated 2026-10-26) and labels the result an estimate. xAI's Usage page is the bill.

## How it works

### The sweep: `dashboard/scripts/grok-cron.js`
- Reads the frozen prompt `templates/scout/scout-prompt.v1.md` (`cr-scout-prompt@1`). A published prompt is never edited; it gets a new version.
- Sends one request per lane to `https://api.x.ai/v1/responses` with the `web_search` tool and a capped `max_output_tokens`.
- Asks for JSON only and checks every item before sending anything to the desk.
- Then posts one brief to the desk.
- `--dry-run` needs no key and makes no network call. It prints each request exactly as it would be sent, its estimated tokens and the cost range above.
- In GitHub's public logs it prints only counts and the desk's receipt status: no item text, no URLs, no key and no desk address.

### The schedule: `.github/workflows/scout-cron.yml`
- Cron `30 11 * * *` in UTC. That is 06:30 Eastern from November 1, and 07:30 until then. GitHub can start scheduled jobs late when it is busy.
- It also has a manual Run button (`workflow_dispatch`).
- Scheduled runs happen only while the repository variable `SCOUT_ENABLED` is `true`. Eric turns the daily run on and off in GitHub's settings, without a PR.
- Settings: `permissions: contents: read`, a 15-minute timeout (four lanes of at most 3 minutes each, plus the desk), one run at a time, and no npm install. The script uses Node's own `fetch`.
- Secrets, which Eric enters in GitHub himself: `XAI_API_KEY`, `DESK_INGEST_KEY` and `DESK_INGEST_URL`.

### The route: `POST /api/ingest/scout-brief`
- Mounted in the protected front door, `dashboard/frontdoor.js`. Like the offsite package, it sits after the host check and before sign-in, and it exists only on the online desk.
- **Key:** `Authorization: Bearer <DESK_INGEST_KEY>`, compared in constant time.
  - The key needs at least 32 characters.
  - Without one, the route answers 404 "not set up".
  - Ten refused keys in 15 minutes lock it for 15 minutes.
  - The key is read from Render's environment on every request and is never written down or logged.
- **Refused before the body is read:**
  - a request carrying a browser Origin;
  - anything but `application/json`;
  - a body over 64 KB;
  - a seventh delivery in one day.
- **The brief's checks,** field by field; one bad field refuses the whole brief and nothing is saved:
  - format `cr.scout-brief.v1`, with `generated_at`, `prompt`, `model`, `lanes_run`, `items` (at most 40) and `usage`;
  - `lane` is one of the four;
  - `readiness` is one of `production`, `beta`, `experimental` or `research`;
  - `title`, `creator`, `summary` and `desk_leverage` are each one plain line with a length cap, and the invisible-mark screen from the engineering lane (N10) applies;
  - `url_primary` and `url_repo` must be `https://` with a host name, no IP address and no username or password in them. `url_repo` may be empty.
- **Receipt:** `{ brief_id, status: saved | unchanged, items_new, items_updated }`. The same brief delivered again is `unchanged`, with the same receipt.

### Storage on the desk's disk, under `scout/`
- **Each delivery is kept whole and never rewritten:** `scout/briefs/sb-<YYYYMMDD>-<sha10>.json`, with its SHA-256.
- **The current list:** `scout/items.json`, replaced in the same locked, verified save (`core/ops` `runOp`, the inbox's pattern).
  - There is one item per key. The key is `url_repo`, normalized: lower-case host, no `www.`, no `.git`, trailing slash, query or fragment, and GitHub owner and repository names compared without case. Without `url_repo`, the key is the normalized `url_primary`.
  - **Upsert:**
    - A new key adds an item.
    - A key already on the list updates its fields and its `last_seen` and adds one to `times_seen`.
    - `first_seen` and the earlier briefs stay as they are.
    - Nothing is deleted.
- **Backups:** `scout` is added to the backup and offsite package list (`core/exporter.js` `PACKAGE_INCLUDE`), so this PC's daily pull carries it. It is a few KB a day.

### Where Eric reads it
- A Scout part on the Research page: items by lane, the latest first, readiness as a badge, each title an external link that opens in a new tab with no referrer. Text is shown as text, never as HTML.
- `GET /api/scout` behind the sign-in.
- `node dashboard/cli.js scout list` on this PC.
- One `Scout:` line in doctor and the start log: not set up, or the last brief, its age and the estimated cost to date.

## Files

| File | Change | Protected |
|---|---|---|
| `dashboard/core/scout.js` | new: checks, normalizing, save, read | yes, added (reached before sign-in) |
| `dashboard/frontdoor.js` | mount the route | already |
| `dashboard/scripts/grok-cron.js` | new: the sweep, with `--dry-run` | yes, added |
| `templates/scout/scout-prompt.v1.md`, `templates/scout/LOCK.json` | new: the frozen prompt and its hash | under the templates rule |
| `.github/workflows/scout-cron.yml` | new | already (`.github/`) |
| `dashboard/tests/scout-ingest.test.js` | new | yes, added |
| `dashboard/tests/engineering-guard.test.js` | the front door's one new public route | already |
| `dashboard/scripts/backlog-promote.js` | protect the new files and the `scout/` records folder | already |
| `dashboard/core/exporter.js` | `scout` in `PACKAGE_INCLUDE` | no |
| `dashboard/server.js` | `GET /api/scout` behind the sign-in | no (no line names engineering) |
| `dashboard/cli.js` | `scout list` | no |
| the Research page and a bundle rebuild | the Scout part | no |
| `CLAUDE.md` | one bullet describing the scout | already |
| `.gitignore` | allow this folder's README and PLAN | no |

`dashboard/core/scout.js` may require only files already on the protected list. The guard test checks every file the front door reaches.

## Tests (`dashboard/tests/scout-ingest.test.js`, a FICTIONAL temporary desk, no network)

- **Refused requests:**
  - no key, a wrong key and a short desk key, each refused with nothing written;
  - the lockout after ten refusals;
  - not set up (404);
  - wrong method, wrong content type, a browser Origin, a body too large, and a seventh brief in a day.
- **Invalid briefs:** each field's own refusal, all of them listed in the answer, with nothing saved. That includes the wrong format, an unknown lane or readiness, over-long text, a line break, an invisible mark, an `http://` URL, an IP-address host, a URL with a username and password in it, and too many items.
- **Saving and the upsert:**
  - a new item; the same repository spelled differently (case, `.git`, a trailing slash) becomes one item;
  - an update keeps `first_seen` and counts `times_seen`;
  - an item with no repository is keyed by its primary URL;
  - the same brief twice is `unchanged` with the same receipt;
  - an interrupted save leaves the earlier list intact.
- **Reads:** `GET /api/scout` refuses without the sign-in, and reading writes nothing.
- **Backup:** the backup package includes `scout/`.
- **The sweep script, against a fake xAI and a fake desk:**
  - `--dry-run` sends nothing;
  - a malformed answer from Grok is never posted;
  - a failed lane is reported missing and not retried;
  - nothing the script prints contains an item's text, a URL or a key.
- **The guard:** the front door's guard test passes with the one new route, and nothing else answers before the sign-in.

Then the full suite (`node dashboard/cli.js test`), `npm run check`, and CI green on the PR's head before Eric merges.

## Order, with Eric's steps

1. **Build (no key exists yet).** One PR from `claude/grok-scout`. It waits for Eric's merge.
2. **The cost check before the key.** `node dashboard/scripts/grok-cron.js --dry-run` prints the exact four requests and the estimated cost. Eric sees it before anything else happens.
3. **Eric, in his own browsers.** None of these values is ever pasted into a chat.
   - At console.x.ai: create the API key, buy the credits, and keep the invoiced limit at $0.
   - Generate `DESK_INGEST_KEY` on this PC with:
     ```powershell
     [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36))
     ```
   - Put `DESK_INGEST_KEY` in Render's environment.
   - Put `XAI_API_KEY`, `DESK_INGEST_KEY` and `DESK_INGEST_URL` in GitHub's Actions secrets.
4. **The first paid run, started by Eric.** He presses Run on the workflow. Then I read the desk's record of the run (the figures xAI reported and the cost estimated from them) and his xAI Usage page, and show him the real cost against the estimate above.
5. **The daily schedule.** Eric sets `SCOUT_ENABLED` to `true` in GitHub's repository variables. Setting it back to `false`, or removing the xAI key, stops the run.

## What stays out

- **No Supabase.**
- **No connection to the backlog, the engineering inbox, research or tickets.** A scout item is something Eric reads.
- **No automatic retries,** and no more than one sweep a day unless Eric runs one by hand.
- **No item text in GitHub's public logs.**

## Known limits

- **The model decides how many searches to make.** The prepaid balance is the only hard cap.
- **What Grok returns is web content.** It can be wrong, out of date or written to persuade. The desk checks the shape and screens the text; it does not check whether the content is true.
- **The scout serves Track 1 at most.** It is not a Track 2 item.
