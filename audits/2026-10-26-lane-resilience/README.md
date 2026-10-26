# Engineering lane: commits proven on GitHub, safe retries, the bundle step (2026-10-26)

Eric's direction (2026-10-26): "once item 65 merges, build the PR that makes the desk prove admission SHAs on GitHub, adds my one-click correction for item 65's record, and adds the retries and the bundle step in the worker's verify."

## 1. What happened to item 65

- Item 65 is `eng-20261026-9c21de` v1, "Add owner-activated UI delegation and explicit task re-binding".
- The admission workflow landed its entry on main as `72094714f88c35fb3906dd3fbfc5fdc9d2290936`: github-actions, titled "admission: backlog item 65 for eng-20261026-9c21de v1".
- The worker then confirmed the admission with `7209471a1b2c3d4e5f60718293a4b5c6d7e8f901`. That commit does not exist. It is the 7-character prefix padded to 40 characters, because the connector's schema accepted only full SHAs.
- The desk checked only the shape, so the record says `confirmed_main_sha` is a commit that is not in the repository.
- Nothing reads that field to decide anything. The record was still false, and neither the worker nor Eric had a way to correct a confirmed admission.

## 2. What changed

| Area | Change | Files |
|---|---|---|
| Proof on GitHub | `admission_confirmed` takes the commit as Git printed it: a full SHA, or a prefix of at least 7 characters. The connector reads GitHub itself (`admissionAt`) and the inbox records the confirmation only when that holds. It holds when: the commit exists (a prefix is resolved to the full SHA); main contains it; and `DESK_STATE.md` at that commit holds the bound entry, byte for byte. Refusals: GitHub unreadable is `GITHUB_UNKNOWN` (409, nothing written, retry); not on main or no entry is `NOT_ON_MAIN`; another entry is `MISMATCH`. The record carries `main_sha_verified` (true; false where no GitHub reader exists; null when recorded before 2026-10-26). | `engineering/github.js`, `engineering/tools.js`, `engineering/inbox.js` |
| One reading of an entry | `engEntryOf(text, task)` in `backlog-promote.js` is how the worker's `admission-status` and the desk's proof read an engineering item. | `scripts/backlog-promote.js`, `scripts/engineering-worker.js` |
| Eric's correction | `POST /api/engineering/tasks/<id>/admission/recheck`, the "Check admission on GitHub" button on a confirmed, unchecked admission (Preferences > Developer > Engineering). It is owner only and needs no passphrase, because it writes only what GitHub proves. Order of checks: (1) The commit on record is proven first; when it holds, the admission is marked checked. (2) Otherwise main's history of `DESK_STATE.md` since the binding is searched for the workflow's title, and the commit found is proven the same way. (3) Only then is `confirmed_main_sha` replaced. The replaced value is kept in `admission.corrections` and the `admission_main_sha_corrected` event. The number, entry, status, lease and original `admission_confirmed` event are untouched. | `engineering/routes.js`, `engineering/inbox.js`, `web/src/shell/Engineering.jsx` |
| Safe replays | The same `admission_confirmed` sent again after a lost answer answers `unchanged` instead of `WRONG_STATE`. If GitHub says that commit does not hold the entry, it is refused instead. | `engineering/inbox.js` |
| Retries | The desk's GitHub reads are asked again after 1 s, 2 s and 4 s when the answer was 502, 503 or 504, or GitHub could not be reached. A timeout, a rate limit or a 404 is not retried. The worker script retries its remote git calls (`fetch`, `ls-remote`, `push`) on a passing network failure only. Before pushing again, it reads the ref back and treats an already-landed push as landed. `CR_ENG_RETRY_DELAYS_MS` overrides the delays (empty means none). The worker's connector guide says the same for its own calls to the desk. | `engineering/github.js`, `scripts/engineering-worker.js`, `engineering/tools.js` |
| Revisions | `engineering-worker.js resolve --rev <rev>` prints the full SHA `git rev-parse --verify <rev>^{commit}` names. `push --sha` and `evidence --head` resolve any revision first. `backlog-promote.js` resolves `--base` and `--head` the same way (`resolveRevs`); the workflows already pass full SHAs. The desk itself resolves only hex prefixes, through GitHub, never a branch or tag name. | `scripts/engineering-worker.js`, `scripts/backlog-promote.js` |
| Bundle step | `engineering-worker.js verify` first compares the bundle's `build.json` stamp with the sources. When it is stale, verify rebuilds the bundle (`npm ci` when `dashboard/web` has no `node_modules`, then `npm run build`). If the rebuild changed tracked files under `dashboard/public/app`, verify stops with `commit_bundle_first` and lists them, because a verification is always of a committed head. `bundle` runs the step alone. `node dashboard/cli.js test` never builds, so CI still fails on a stale committed bundle. | `scripts/engineering-worker.js` |

`mcp-wire.js` is unchanged: it holds protocol versions and log redaction, and makes no network calls.

## 3. After merge and deploy

1. Open Preferences > Developer > Engineering on the online desk.
2. On item 65, choose **Check admission on GitHub**. Expected: "Corrected item 65's admission commit from 7209471a1b2c to 72094714f88c…". The row then reads "checked on GitHub · corrected from 7209471a1b2c".
3. Items 63 and 64 can be checked the same way. A record that holds is only marked checked.

## 4. Tests

- **`engineering-inbox.test.js`.**
  - An invented commit is refused (`NOT_ON_MAIN`), GitHub unreadable is refused (`GITHUB_UNKNOWN`), and another entry is refused (`MISMATCH`). In each case nothing is written.
  - A prefix is recorded as the full commit, checked, and a replay answers unchanged.
  - Without a reader, the record says unverified.
  - The owner recheck corrects the record with history kept, or marks it checked; other roles get `OWNER_ONLY`.
  - The connector asks GitHub itself.
  - The route asks about the recorded commit first and searches main's history only when that commit does not hold; it answers 503 without GitHub.
- **`engineering-flow.test.js`.**
  - GitHub retries happen on 502 and 503 and when GitHub is unreachable, never on 403, 404 or a timeout.
  - `admissionAt` and `findAdmissionCommit`, including the padded SHA from item 65.
  - The worker resolves a SHA, a prefix, a branch and a tag, and pushes and reads evidence by a prefix.
  - The worker retries against an HTTP remote answering 503 (four tries), and does not retry on 404 or with no delays.
  - `verify` stops at `commit_bundle_first` on a stale bundle, then passes once the rebuild is committed; a failing build is `bundle_build_failed`.
- **`engineering-connector.test.js`.** The `main_sha` pattern takes a 7–40 hex prefix and refuses names. The worker guide carries the retry and never-pad rules.
- **`backlog-promote.test.js`.** `engEntryOf`, and `resolveRevs`.
