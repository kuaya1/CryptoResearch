# ChatGPT and Gemini connector handoff: audit and fixes (2026-10-08)

Scope: the online desk's MCP connector (`dashboard/mcp.js`, `dashboard/oauth.js`) as ChatGPT and Gemini use it, with Claude in Cowork as the reference. Baseline: `main` at `4911a31`, the same revision live on Render (deploy `dep-db3eiog473hc73beqvp0`, live 2026-10-08 00:53 UTC), clean tree, suite 584/584. Evidence: 30 days of the desk's own log lines on Render (read only), current official provider documentation, and adversarial tests against the real handlers on fictional workspaces (`dashboard/tests/connector-handoff.test.js`). No paid research was started and no real record was changed.

## How each assistant's path actually ran

| Stage | ChatGPT (observed) | Gemini (observed) |
|---|---|---|
| Sign-in | Connected 2026-10-03; refreshes every day through 2026-10-08 10:04 UTC; no refused token request in 30 days | Connected 2026-10-03 03:40 UTC after the consent-page fix; refreshes through 2026-10-08 10:39 UTC |
| Tool discovery | `tools/list` called **once**, 2026-10-03 02:42 UTC (15 tools). It has used that cached list since; each session only calls `initialize` | `initialize` twice and `tools/list` (client "mcp 0.1.0") at the start of each session; client "Gemini 1.0.0" makes the tool calls |
| Tool calls | `pending_research` → `get_research` → `save_report`, about 30 saves since 2026-10-03, the latest 2026-10-08 10:15 UTC (11 minutes of research, report `2026-10-08_chatgpt_9b5995d0`, grade withheld at 60%) | Full cycle on 2026-10-03 (start_research, drafts, four saves). One job (run `…120247Z_wxa57`) stopped after a draft at 14:49 UTC that day. On hold since 2026-10-04. Since then: reads on 10-05 (`pending_research` → `on_hold`) and 10-07 (`find_projects`), and dozens of sessions that listed the tools and called none |
| Where it stops today | Works. It took the **oldest** waiting job (an Oct 6 run) right after Eric had asked Claude for OpenGradient and Velodrome with all three models | Stops at the hold (Eric's decision, kept). Most sessions end after the tool list with no call |

## Provider documentation (checked 2026-10-08)

Documented:
- OpenAI: tools without `readOnlyHint` are treated as writes, and writes need the user's confirmation by default (approval can be remembered per conversation). ChatGPT runs DCR once per connection, needs PKCE S256 and `iss` in every authorization response, and sends `resource` on authorization and token requests; a 401 with `WWW-Authenticate` makes it sign in again ([Authentication](https://developers.openai.com/plugins/build/auth)). After tools change, the connector is refreshed in ChatGPT's settings ([Connect from ChatGPT](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)).
- Google: custom apps are connected in the Gemini web app (personal account, 18+, US, English, Keep Activity on); "To make sure Gemini uses your connected custom app for a prompt, enter @ and select the custom app"; "Gemini requires manual confirmation for any write actions" ([Connect & manage custom apps](https://support.google.com/gemini/answer/17209137)). Some Google pages and third-party guides tie custom apps to Gemini Spark tasks; the English page does not settle it.

Observed: above. Inferred: Gemini's sessions with no call are its app loading tools at the start of a chat (or one where the app was not @-mentioned); the desk cannot tell those apart. Untested: Gemini Spark tasks, ChatGPT on mobile, ChatGPT's behavior when its refresh token is refused.

## Findings

| # | Severity | Finding | Reproduction | Status |
|---|---|---|---|---|
| 1 | High | ChatGPT and Gemini read the prompt without taking the job (to keep Eric's approvals to one), but `save_research_draft` only worked on a taken job: on their path it answered NOT_FOUND. So their research in progress was invisible (the job read "waiting" for its whole length), could never show as paused, and could not resume from a draft. The dashboard's own Resume toast already promised "shows Working again only when ChatGPT saves a draft". | test "a draft from ChatGPT claims its waiting job…": `run_… has no ChatGPT job taken by ChatGPT. (NOT_FOUND)` | Fixed |
| 2 | High (seen live) | "Do my waiting research" always handed out the oldest job and could not take a project: on 2026-10-08 10:04 UTC ChatGPT did an Oct 6 job while Eric had just asked for OpenGradient and Velodrome. The next task carried no model, execution-note version, prompt hash or exact calls. | test "on <project> hands ChatGPT that project's job…": `next.model` undefined; live logs 10:04:38 | Fixed |
| 3 | Medium | A save repeated after a lost answer returned `validation.warnings: 0` although the report has warnings, and no compact receipt (completion, eligibility, what remains). | test "a lost acknowledgement retried…": `actual 0, expected 2` | Fixed |
| 4 | Medium | For a model on hold, `pending_research` said nothing about the job it had started before the hold (Gemini's run `wxa57` with its draft). | test "a model on hold claims nothing…"; live 2026-10-05 11:57 UTC | Fixed (hold kept) |
| 5 | Medium | Nothing said per assistant whether it is connected, whether it called any tool, or what Eric does next; a connection that listed tools and called none was indistinguishable from one at work. | test "desk_status says, per assistant…" | Fixed |
| 6 | Medium | Log lines had no reference or connection key and no handoff stage (prompt delivered, draft, save), errors could not be matched to a line, a refused `/mcp` request logged nothing, and an error echoing an argument logged addresses as given. | test "logs: each call is logged once…" | Fixed |
| 7 | Low | A prompt cut off on its way to the assistant could not be told from a whole one in the text form. | test "prompt delivery: … end-of-prompt line…" | Fixed |
| 8 | Low | A draft save answered `status: "saved"`, readable as a saved report. | as 1 | Fixed (`draft_saved`, `report_saved: false`) |
| 9 | Info | ChatGPT's tool list is cached since 2026-10-03 (15 tools). It still followed the desk's replies (it passed `revision` on 10-04, which its cached schema lacked). | live logs | Eric refreshes the app once |
| 10 | Info | 2026-10-04 20:17–20:19 UTC: ChatGPT saved about 25 revisions in two minutes. They were at Eric's request ("a single numeric grade per project"); the desk labeled each as ranges narrowed to midpoints with no new source. | live `get_report heima` | No change: the revision rules worked |

Held under attack (tests pass before and after): reports cut off inside the JSON block, without a JSON block, naming another run, or sent to another project's run are refused and nothing is saved; malformed arguments, an unknown tool and an unreadable body are refused; a report imported for no run completes no job; every read-only tool, called by every model (one on hold), writes no file and starts nothing; two simultaneous `start_research` calls resume the same run; an access token that expires mid-session gets a 401 `invalid_token` challenge naming the resource metadata, and the refreshed token continues the same job across a restart.

## Changes

- `core/research.js` `saveAssistantDraft(…, { claim })`: a first draft for a job still waiting for this model takes it in the same verified save; refused for a model on hold; never a job a paid API has or one already finished.
- `mcp.js`:
  - `pending_research` takes `project` (name, ticker or ID). Work the model started comes first, then the oldest waiting job. `next` is the full task: project, model, run, state (waiting, started, interrupted), prompt version and hash, execution note, draft, `next_action`, `say_first`. A named project with nothing waiting gets `none_for_project` or `no_match` and nothing else. On hold: `held` names every kept job.
  - `save_research_draft` answers `draft_saved`, `report_saved: false`, `claimed`.
  - `save_report` adds `receipt` (report, run, completion, eligibility, grade, warning and error counts as saved, revision, what remains) and counts from the saved report on a repeat.
  - `desk_status.assistants`: per assistant, connection, last use, sessions and tool calls since the desk restarted (memory only), route, waiting and started work, the next step for Eric, and the manual fallback.
  - The text form of a prompt ends with `--- End of the research prompt for <run>: <n> characters, SHA-256 <hash> ---`; the structured `run.prompt` is unchanged.
  - Log lines: `ref` per request (also in every error the assistant receives), `conn` per connection, handoff stages, `redactLog` (bearer tokens, 0x and bech32 addresses, long mixed-case strings).
  - ChatGPT's and Gemini's instructions: name the project, say it first, check the end-of-prompt line, never substitute a project, reconnect wording.
- `oauth.js` `refusal(req)` and `server.js`: a refused `/mcp` request is logged with its reason (no token, unknown token, expired, disconnected), never the token.
- Gemini's hold is unchanged. Scoring, binding, revision rules and the prompt are unchanged. No dependency, migration or new tool.

## Tests

`dashboard/tests/connector-handoff.test.js`, 12 tests: 10 failed on `4911a31` (findings 1–8), 2 held (history imports, read-only tools); all 12 pass now. Existing connector tests updated only for the new wording (draft status, instructions, prompt pointer).

## Not tested in the real clients

No ChatGPT or Gemini session was driven from here: connecting either to a test desk needs Eric's own accounts and his passphrase on the consent page. The fixtures above prove the desk's side only. The live check after deploy is read-only (`/healthz`, startup logs, `desk_status` through Claude's own connection).

## For Eric

- ChatGPT, once: Settings → Apps (Connectors) → CryptoResearch → Refresh. Then, in a chat with the app on: "Do my waiting CryptoResearch research on Velodrome".
- Gemini: on hold (your decision). When you lift it in Settings: type @, pick CryptoResearch, then "Do my waiting CryptoResearch research on <project>". If it lists the tools and calls none, use the manual route: the project's Evidence → Research runs → Copy prompt, paste into Gemini, then Import report for Gemini on that run.

## Remaining limits and next step

- ChatGPT and Gemini still receive the frozen prompt twice in one answer (structured and text, for clients that read only one); about 2 × 15,000 tokens. No truncation was observed, so it stays.
- The desk cannot see inside an assistant: a session that never calls a tool, or research abandoned before a draft, leaves no record. A draft is the first sign of work.
- Next: a per-assistant line in Settings → Connected apps from `desk_status.assistants`, so Eric sees it without asking an assistant.
