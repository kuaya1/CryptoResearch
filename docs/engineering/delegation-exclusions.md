# Delegation exclusions and re-binding (backlog item 65)

Eric's decision, 2026-10-26: `eng-app@4` is a new template. `eng-app@3` is
published and is not edited. Activating a delegation, authorizing a task and
re-binding a task are Eric's own actions on the desk, each behind his
passphrase; no submitter or worker connection can do any of them.

## What `eng-app@4` allows

For the one goal Eric names, each candidate reviewed by ChatGPT from a
connection other than the one that submitted it, and released by promotion:

- `dashboard/web/src/**` (the browser app's source)
- `dashboard/public/**` (public scripts, stylesheets and the committed bundle)
- `dashboard/tests/**` (ordinary tests only; see below)
- `docs/engineering/**`

A task scope names a directory or a file (`dashboard/web/src/**`,
`dashboard/public/app/**`, `dashboard/public/tokens.css`,
`dashboard/tests/screening.test.js`), never `dashboard/web/**`,
`dashboard/public/**` or `dashboard/tests/**` as one glob: those reach files
that stay with Eric, so a version naming them waits for his authorization.

## What no delegation reaches

`DELEGATION_RESTRICTED` (`dashboard/scripts/backlog-promote.js`) holds a path
at the task, at the candidate and at promotion, whatever a task record says.
A rule may carry `lifted`, a map from a template to the paths that template
alone may change. `eng-app@4` and, since 2026-10-26, `eng-backend@1` appear
in it.

| Rule | Held for every other template | Lifted for `eng-app@4` | Lifted for `eng-backend@1` |
|---|---|---|---|
| `dashboard/core/` | everything | nothing | all of it, except its `PROTECTED` files |
| `dashboard/web/` | everything outside `src/` (`vite.config.js`, `scripts/`, `index.html`) | `dashboard/web/src/` | nothing |
| `dashboard/public/app/` | the committed bundle, under `eng-app@3` and earlier | all of it | nothing |
| `dashboard/public/tokens.css`, `styles.css`, `position.css` | served before sign-in, under `eng-app@3` and earlier | those three files | nothing |
| `dashboard/public/favicon.svg` | served before sign-in; an SVG can run script | nothing | nothing |
| `dashboard/tests/engineering-*`, `backlog-*`, `guardrails.test.js`, `web-app.test.js`, `helpers.js` | the tests that guard the lane, the backlog, the guardrails and the browser's writes | nothing | nothing |

`PROTECTED` paths (workflows, `dashboard/engineering/`, `dashboard/scripts/backlog-*`,
`server.js`, `package.json`, the guard test and the rest) stay out of every
delegation's reach, as before. Reading is as Windows reads a path (letter
case and trailing dots), so another spelling reaches the same file.

A bundle change is built from source (`npm run build` in `dashboard/web`), and
`web-app.test.js` fails when `dashboard/public/app` is older than its source.
A task that changes `dashboard/web/src/**` therefore also changes
`dashboard/public/app/**`, which `eng-app@4` allows.

## What `eng-backend@1` allows (2026-10-26)

Eric's direction, 2026-10-26 (`audits/2026-10-26-backend-autonomy`). For the
one goal Eric names, implement only. Each candidate is reviewed by ChatGPT,
and Eric merges every pull request himself (release mode `owner`):

- `dashboard/server.js` (the server's routes)
- `dashboard/core/**` (core logic and data stores)
- `dashboard/tests/**` (ordinary tests only)

It never reaches the paths below. `forbidden_paths` refuses each one at the
task, at the candidate and in the delegation record:

- `dashboard/engineering/**`
- `dashboard/frontdoor.js`
- `.github/workflows/**`
- the root `server.js` and `dashboard/hosted.js`
- `dashboard/oauth.js`, `dashboard/mcp.js` and `dashboard/mcp-wire.js`
- the ledger and wallets: `dashboard/core/portfolio.js`, `wallets.js`, `walletsync.js` and `alchemy.js`

The core files the gate is computed with stay `PROTECTED`, as do the guard
tests. A `dashboard/server.js` line that mounts the engineering routes or the
front door is held at the candidate (`PROTECTED_LINES`), as it is at
promotion.

Every task names, in `scope.paths`, the `dashboard/tests/**/*.test.js` file it
adds or changes. Every candidate adds or changes one (`requires_tests`).
Before any paid call, the unattended reviewer also checks that a changed test
requires a changed server or core module.

A scope names core files one by one. `dashboard/core/**` as one glob reaches
protected files, so a version naming it waits for Eric. There is no
`data/**`: the folder does not exist, and records are never committed.

## The unattended review (2026-10-26)

`.github/workflows/candidate-review.yml` runs `dashboard/engineering/reviewer.js`
from main. It starts once GitHub's `test` run passes on a push to
`claude/candidate-eng-<n>`, or when a pull request from such a branch opens or
is updated.

1. The reviewer asks the desk for the candidate's packet
   (`POST /engineering/reviewer/packet`, with the token in
   `CR_ENG_REVIEWER_TOKEN`).
2. It checks the branch in Git against the packet: the merge base, the exact
   diff and its files, commit authors and trailers, and test coverage.
3. It asks ChatGPT through the OpenAI API.
4. It saves the answer (`POST /engineering/reviewer/reviews`).

The desk checks all of it again before anything is saved. The review is saved
as ChatGPT's (`reviewer.automated`, its own identity `candidate-review@1`,
never an OAuth connection). It is refused:

- when a builder of the task is a ChatGPT connection, or a commit names one
  (Rule N4, `self_review`);
- when GitHub's check runs on the head have not passed, as the desk reads
  them;
- after the first review of that head;
- after 10 unattended reviews in one UTC day.

A pass only makes the task `ready_for_promotion`. The attestation then says
`owner_merges_unattended_review`, so backlog-pr never promotes it, and Eric
merges the candidate's pull request himself. The 30-minute sweep records the
merge from GitHub's proof.

## Activation

`POST /api/engineering/policies` with a template, a goal and Eric's
passphrase. A retired template (`eng-app@1`, `eng-app@2`) is refused, and a
delegation activated from one matches nothing. The activation is one
journaled operation (`engineering_policy_activate`) and is create-only. This
change adds no automatic activation: `eng-app@4` is offered, and Eric turns
it on.

## Re-binding

`POST /api/engineering/tasks/<id>/rebind` with `version`, `content_sha256`,
optional `policy_id`, `explicit`, `reason` and Eric's passphrase. It does not
touch the task's content, versions, hash, admission (number, entry, branch) or
its history.

1. GitHub is asked first whether main already holds the candidate's head
   (`contains(head, 'main')`). An unread or unknown answer refuses the
   request. If main holds it, the task is settled as `merged`
   (`reconciled_merged` event); nothing is re-promoted or re-bound.
2. A task whose authorization still holds, Eric's own included, keeps it
   unless he passes `explicit: true`.
3. Otherwise the version is matched to the active delegations as at
   submission (`cr-eng-match@1`, or the one he names), and if it fits, the
   authorization is replaced. The earlier authorization is kept in
   `rebindings` with why it no longer held, and a `rebound` event records
   Eric, the version and hash, from and to.

A task 63-style item already merged is reconciled, not re-bound. Task 63's
direct authorization by Eric stays unless he selects re-binding. A task whose
delegation was retired (such as 64) or the white-card task can be given a
valid new binding.

## Review independence

Two things are unchanged. Beyond documents, a review by the connection that
wrote any version of the task does not decide it (`same_author`). And a review
covers one head on one base: a candidate that main has moved past is rebuilt
on current main, verified and reviewed again.

Added on 2026-10-26: a review by a connection that built a candidate of the
task never decides it, documents included (`same_builder`, Rule N4). Neither
does an unattended review when the builder was the same kind of assistant as
the reviewer.
