# Pipeline review alignment (2026-10-27)

Eric attached an architectural review of the build pipeline ("CryptoResearch pipeline architecture review.pdf"; not committed). He asked for two things:
- align the repository to the code running on `main`;
- carry out the review's plan from its page 10, in order.

This branch starts from `main` at `abb7740`, which is `f5f6532` plus #53. Eric merges it; nothing here merges, applies a ruleset or creates a label.

## What was left out as speculative

**PR #54, the PM builder.** It carries TASK-### blocks, `cr-agent-diagnose@1`, `agent/task-*` branches and an LLM project manager. It contradicts the plan's step 3, under which Eric's label on an issue authorizes a task and no model picks work. Nothing of it is on `main`. Closing #54 is Eric's call.

**`TASK-004` and `TASK-005` labels.** #53 attached them to items 73 and 74. They are the PM builder's IDs, so they are removed.

**The never-built fill harness.** Item 74 described it: `paper-fills.js`, `cr-paper-fill@1`, a fill harness kept out of `PROTECTED`. It is replaced by `cr-paper@2` in the protected `paper.js` (step 5).

**The `ready`-label intake.** `backlog-intake.yml`, `backlog-intake.js` and its test are deleted. The issue queue replaces them.

## The plan, step by step

### 1. Rulesets and credentials

`automation-branches.json` now excludes `refs/heads/claude/backlog-*` and `refs/heads/claude/claims/**`. Without these two excludes the backlog builders could not push.

A new test, "builders push only with the builder App's token…" (`dashboard/tests/agent-workflows.test.js`), checks the workflows' credentials:
- every GitHub credential a workflow holds is its own job token or the builder App's (`BUILDER_APP_KEY`);
- every secret is one of a known list;
- the agent lane's candidate and its pull request go up with the App's token.

The cloud routines are not workflows. Backlog builders A and B push `claude/backlog-*` as Eric's own account, and moving them to the App is Eric's change.

### 2. Run liveness and atomic publish

`dashboard/scripts/agent-ledger.js` now settles a paid attempt with no outcome by asking GitHub for the status of its Actions run (`/actions/runs/<id>/attempts/<n>`). Age is the last thing it uses:

| What GitHub says about the run | What the ledger does |
|---|---|
| Completed | The attempt is settled now. |
| Still running | The issue is held, up to 360 minutes. |
| Status cannot be read | The 65-minute age fallback applies. |

An attempt whose `publishing` line is in the ledger settles as published and is never recorded `lost`.

Publish (`agent-guard.js publish --reservation`) makes one push:

```
git push --atomic --force-with-lease=<branch>:<recorded head> --force-with-lease=refs/heads/agent-ledger:<tip> origin <commit>:<branch> <ledger commit>:refs/heads/agent-ledger
```

The candidate branch and its ledger line land together or not at all. A branch moved since reserve makes the build `stale`, and nothing is pushed.

Tests: `agent-ledger`, `agent-guard`, `agent-revise`.

### 3. Task authorization through issues

A new issue form, `.github/ISSUE_TEMPLATE/backlog-task.yml`, has fields Outcome, Acceptance checks, Touches, After and Notes. A new issue opens labeled `agent:draft`.

When Eric adds `agent:ready` himself, `backlog-queue.yml` runs main's `dashboard/scripts/backlog-queue.js`:
1. It reads the issue again: still open, still labeled, with the same text.
2. It appends an `authorize` record to the agent ledger: the issue, the item number, the text and its SHA-256, the schedule, and who labeled it and when.
3. The number comes after main's backlog, the open admission branches and every number the queue ever gave. Numbers are never reused.

If someone else adds the label, it is taken off and nothing is recorded. An edit, removing the label, or closing the issue appends a `withdraw` record. A text labeled again gets a new number.

The scripts that read the queue:
- `backlog-status.js` and `backlog-schedule.js` read queue items after main's items, under the same rules. A collision with main is reported, never merged.
- `backlog-queue.js task --item <n>` gives a builder its task as data.
- `backlog-promote.js` (scope checks, admission numbers) and `engineering-worker.js` read the queue instead of intake branches.

Authorizing a task no longer needs a merge to `main`. Every builder pull request still waits for Eric's merge.

Tests: `backlog-queue`, `backlog-status`, `backlog-schedule`, `backlog-promote`, `engineering-flow`, `agent-workflows`.

### 4. Invariant 4 and `cr.trade-intent.v2` (DESK_STATE.md)

**Invariant 4.** An order never times out to `lost`. Its states:
- `INTENT` → `RESERVED` → `SENT` → `ACKED`, `REJECTED` or `UNKNOWN`;
- `ACKED` → `PARTIAL` → `FILLED`, `CANCELLED` or `EXPIRED`.

`UNKNOWN` stays `UNKNOWN` until the engine asks the venue about that `client_order_id`. It becomes `NOT_FOUND` only on the venue's answer, after the venue's own duplicate-order window has passed. While any order is `UNKNOWN`, no new intent opens. An order is never resent under a new ID.

**`cr.trade-intent.v2`.** The intent now carries:
- `intent_id`, from which the engine derives the `client_order_id`;
- decimal strings for every price and amount;
- an explicit side, `OPEN_LONG` or `CLOSE_LONG`, with `position_id` on a close;
- `created_at`, a reference price with its time, and `risk_ceiling_usd`.

The engine holds every intent to these rules:
- a minimum stop distance: the larger of a percentage of entry and a multiple of the 14-hour ATR;
- sizing by `floor_to_lot`, under a notional cap tied to NAV and to the desk's exit measurement;
- refusal of a stale price;
- a clipped `valid_until`;
- `evidence` kept for the record only.

The figures that are Eric's to set are unset, so every intent is refused until he sets them. `v1` was never published or built.

### 5. `cr-paper@2` blueprint and protected files

DESK_STATE gains a section, "Paper Book `cr-paper@2` (blueprint, not built)". It specifies:
- a cash NAV;
- discrete sizing;
- fills only when the price trades through, with partial fills;
- maker and taker fees;
- stop slippage;
- stops checked on each hour's high and low, with the stop taken first when one hour reaches both;
- long only.

Its records live apart from `cr-paper@1`'s.

`PROTECTED` (`backlog-promote.js`, with its samples in `engineering/policy.js`) now covers:
- `dashboard/core/paper.js` and `dashboard/core/trade-risk.js`;
- the tests `trade-risk`, `paper-trader` and `trader-boundary`.

Items 73 and 74 are now `*(Eric)*` and rewritten for v2 and `cr-paper@2`, so no builder takes them. `dashboard/tests/trader-boundary.test.js` pins:
- the protection;
- invariant 4's wording;
- the v2 fields;
- the blueprint's parts;
- the two items' marks.

## Not verified live

**The App and the ledger branch.** Whether the builder App's token may fast-forward `agent-ledger` in the atomic push has not been tried on GitHub. The rulesets allow it by construction. If GitHub refuses, nothing is written: publish fails, and the build is settled by its run.

**The labels.** `agent:draft` and `agent:ready` do not exist in the repository yet. The queue workflow has never run.

## Eric's steps

1. Review and merge this pull request.
2. Re-apply `automation-branches.json` from `.github/rulesets/` (the two new excludes).
3. Create the labels `agent:draft` and `agent:ready`.
4. Decide on PR #54 (close it, or keep it for later).
5. Move the backlog routines off his own account, if he wants the App-only rule to cover them. Their prompts would also need to read queue items with `backlog-queue.js task`.
6. Before this merges, builder A can still claim items 73 and 74 from `main`. Pausing it, or releasing those claims, is his call.
