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
alone may change. Today only `eng-app@4` appears in it.

| Rule | Held for every template | Lifted for `eng-app@4` |
|---|---|---|
| `dashboard/core/` | everything | nothing |
| `dashboard/web/` | everything outside `src/` (`vite.config.js`, `scripts/`, `index.html`) | `dashboard/web/src/` |
| `dashboard/public/app/` | the committed bundle, under `eng-app@3` and earlier | all of it |
| `dashboard/public/tokens.css`, `styles.css`, `position.css` | served before sign-in, under `eng-app@3` and earlier | those three files |
| `dashboard/public/favicon.svg` | served before sign-in; an SVG can run script | nothing |
| `dashboard/tests/engineering-*`, `backlog-*`, `guardrails.test.js`, `web-app.test.js`, `helpers.js` | the tests that guard the lane, the backlog, the guardrails and the browser's writes | nothing |

`PROTECTED` paths (workflows, `dashboard/engineering/`, `dashboard/scripts/backlog-*`,
`server.js`, `package.json`, the guard test and the rest) stay out of every
delegation's reach, as before. Reading is as Windows reads a path (letter
case and trailing dots), so another spelling reaches the same file.

A bundle change is built from source (`npm run build` in `dashboard/web`), and
`web-app.test.js` fails when `dashboard/public/app` is older than its source.
A task that changes `dashboard/web/src/**` therefore also changes
`dashboard/public/app/**`, which `eng-app@4` allows.

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

Unchanged: beyond documents, a review by the connection that wrote any
version of the task does not decide it (`same_author`), and a review covers
one head on one base, so a candidate that main has moved past is rebuilt on
current main, verified and reviewed again.
