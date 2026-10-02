# Integrity, budget and live-update repair (audit v2 actions V2-001 to V2-006)

**Date:** 2026-10-02. **Author:** Claude (Claude Code), working from Eric's bounded implementation brief.

**Status: implemented and validated in an isolated copy. NOT deployed.**
- The real workspace's code is unchanged. Its fingerprint at the end of the work was `9ff79de7f31aaf92c92822c1e092782c7a49493b84292ad38840516a86087fd0`, the same as at the start and the same as the audited target.
- No records, settings, keys, task definition or runtime pin were touched.
- No paid call was made.
- Nothing was sent anywhere. A network guard refused every non-loopback request in all test runs and logged none.

## What is in this folder

| File | What it is |
|---|---|
| `integrity-repair.patch` | The reviewable patch. Unified diff of the 70 audited code files. It changes 16 files and adds 7 test files, giving 77. Apply from the workspace root with `git apply -p1 integrity-repair.patch`. Verified: it applies cleanly to the original 70 files and reproduces the repaired fingerprint exactly. |
| `fingerprints.json` | The real folder, the original and the repaired code, all by the review's method. |
| `RESULTS.md` | Per action: what changed, which tests prove it, and what was observed. |
| `LIMITS.md` | What this does not do or could not be shown. |
| `ROLLBACK.md` | The rollback copy, how to stop the dashboard and confirm it stopped, and the tested evidence that rolling back and forward is safe. |
| `RUNTIME-AND-COMMANDS.md` | Node version, folders, and every command used to produce the evidence. |
| `DOC-CHANGES-PROPOSED.md` | Wording for README and COWORK-INSTRUCTIONS. These are part of deployment, so they were not applied. |
| `PLAN.md` | The implementation plan written before coding. |
| `evidence/` | Test outputs, the run of the new tests against the original code, rollback and real-record checks, browser measurements, screenshots. |
| `fixtures/` | Every script used here: isolation setup, network guard, instrumented server, rollback drills. |

## Readiness by use case

| Use case | Ready? | Basis |
|---|---|---|
| **Reading** (dashboard, CLI, Cowork) while another process saves | **Yes** | A held two-file save gives: wait, then "busy" (CLI after 1.5 s; dashboard serves the last verified view marked stale, or 503 + Retry-After). A killed save is refused until recovery rolls it forward, which the server does by itself. An unreadable marker and a quarantined save are detected. Never a mixed pair: the original code returned `["A new","Second Example (FICTIONAL)"]` in the same test. |
| **Exports, CSV, backups and the daily snapshot** during a save | **Yes** | They wait for the save and capture one generation. Portable exports are refused while a save is unverified. Byte copies are still made but marked unverified. |
| **Restoring** a package or backup from an untrusted source | **Yes** | 18 hostile path forms, case and Unicode duplicates, and file/folder conflicts are refused before anything is written, even with valid SHA-256s. A damaged last entry or a mid-write failure leaves no partial folder. Junctions are not followed. Legitimate round trips still verify, including on a copy of your real records. |
| **Paid research after a crash**, at any point | **Yes, with one documented ambiguous window** | All six crash windows were run with real killed processes. Nothing is ever resent automatically. An attempt that may have been billed becomes **uncertain**, and you reconcile it or retry it. Between "about to send" and "answer saved", a crash cannot tell "never left" from "sent and billed". That window is held for you, never guessed. |
| **Spending limits** (per run, daily, monthly) | **Yes** | The per-run limit covers the whole run. Admission is atomic across processes. Retries, provider errors and uncertain attempts count until reconciled. Zero stays zero. On the original code, three $1 calls went out under a $1.10 limit, and four runners together exceeded the daily limit. Now one call is sent. |
| **Search caps sent to providers** | **Yes for Claude and ChatGPT. Gemini only without search, or with declared per-request billing.** | Claude gets `max_uses`, ChatGPT gets `max_tool_calls`, and 0 sends no search tool (request bodies were captured). The Gemini API has no search cap, so none was invented: Gemini with search on is not dispatched unless you declare per-request billing. |
| **Many dashboard windows** | **Yes** | 8 visible windows: 0 held connections, 50 short polls in 20 s, the eighth window's project page in 6 ms. Hidden windows make no requests. Outages back off to 20 s and recover after a restart. On the original code, six background tabs held all six connections and a visible tab's request did not finish in 8 s. |
| **Unattended (scheduled) paid research** | **Ready to use once configured.** It stays off and declines while any bound or price is missing. | Tested: a schedule with the default 20 searches and no search price creates no run, and does once search is off. |
| **Deploying to the real folder** | **Not done** (out of scope) | Use the stop procedure in `ROLLBACK.md`, apply the patch, run `node dashboard/cli.js test` and `doctor`. Then apply the proposed doc wording. |

Every finding counts as closed only for the use cases above. The limits that remain are in `LIMITS.md`.

## Tests

| Run | Result | File |
|---|---|---|
| Repaired code, full suite (109 existing + 35 new) | **144 / 144 pass**, run twice | `evidence/dev-full-suite-run1.txt`, `evidence/dev-full-suite-run2.txt` |
| Repaired code, an earlier run | 143 / 144: the existing F04 test's reader child crashed on the new honest "busy" error under load | `evidence/dev-full-suite-before-child-fix.txt` |
| Original code, its own suite | 109 / 109 pass | `evidence/baseline-full-suite.txt` |
| The 35 new tests run against the original code | **32 fail, 3 pass**. The 3 cover behavior the original already had right. | `evidence/red-baseline-new-tests.txt`, `evidence/red-baseline-summary.txt` |

The F04 fix changes only the test's child: it now counts "busy" refusals instead of crashing on them. The test's assertion (no mixed read) is unchanged. It is listed in `RESULTS.md`.

## What changes for you once deployed

- **Paid research has new states:**
  - **Dispatching:** a call is reserved or in flight.
  - **Uncertain:** it may have been billed with no answer saved. You see **Reconcile** (charged amount or not charged, plus how you know) and **Retry anyway**.
  - The CLI has the same: `research reconcile`.
  - Doctor warns while any attempt is uncertain.
- **Costs are labeled honestly:**
  - "reserved (estimate)", "actual", "above its reservation".
  - The word "maximum" is gone, because the input and search-result tokens cannot be capped.
- **Settings are stricter about bounds:**
  - With search on (the default is 20 searches), a provider also needs a search price; 0 searches turns search off.
  - Gemini with search needs **Gemini search billing: per request**. Otherwise set its searches to 0.
  - The per-run limit now means the whole run.
- **The status line shows the live-update state:** Live, Paused while hidden, Reconnecting (next try in N s), or Saving in progress.
- **Path refusals:** restores refuse unsafe names, including on Windows names ending in a dot or space and reserved device names. Legitimate data has none.

## Next

**V2-007** (a network failure in a later market chunk undercounts calls) is the next finding. It was deliberately **not** added here.

A pre-existing server behavior found during testing is also listed in `LIMITS.md` and not changed: the dashboard can stall up to 20 s while another process holds the workspace lock.
