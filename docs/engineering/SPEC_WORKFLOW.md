# How a change gets made: the spec workflow

Approved by Eric on 2026-11-05. This applies to any change bigger than a small correction. It works under `docs/CONSTITUTION.md` Law 3 and does not change who decides what.

## The seven steps

| Step | What happens | Who |
|---|---|---|
| **1. Understand** | Read the code and records as they are now, at a named revision. Label what can't be read `UNKNOWN` (Law 4). | Agent |
| **2. Specify** | Write the spec below. Eric's approved words set its scope. | Agent, for Eric to approve |
| **3. Implement** | One task, in one clean checkout from a named revision, on its own branch (`CLAUDE.md`). | Agent |
| **4. Verify** | Run the checks the spec names against the exact commit. A code change needs `node dashboard/cli.js test` by itself on the pinned Node, at the exact commit under review. An interrupted or missing result doesn't count as a pass. | Agent |
| **5. Review** | Open a pull request with the commit, the results and the limits. | Agent, then Eric |
| **6. Owner merge** | Eric merges. No agent does, and no agent uses an admin bypass (Law 1). | Eric |
| **7. Verify release** | Read `/healthz` and compare its revision with the merge commit. Record the merge and the deployment separately on `docs/ONE-SHEET.md`, each with its own evidence and time. | Agent or Eric |

Merged is not deployed, and deployed is not operating. Passing tests prove code paths, not operation. As observed for #186, #187 and #188, Render starts a deploy within seconds of a merge to `main`, so plan a merge as a deploy.

## The spec

Every spec answers three questions first. If it can't, it isn't ready.

1. **What behavior changes?**
2. **What must stay true?**
3. **What evidence lets Eric accept the result?**

Save a spec as a dated file in `docs/engineering/`, such as `<NAME>_<YYYY-MM-DD>.md`. State requirements and boundaries, and leave implementation details out unless they are themselves a requirement.

```markdown
# <Short name> (<YYYY-MM-DD>)

**What behavior changes:** <one or two plain sentences>
**What must stay true:** <the rules this must not break>
**What evidence lets Eric accept it:** <the results he will see>

## 1. Problem and intended outcome
## 2. Scope and non-goals
## 3. Current behavior and its evidence
Revision read, file and line, or the receipt. Unknown stays UNKNOWN.

## 4. Required behavior and invariants
## 5. Relevant components and interfaces
## 6. Acceptance criteria and verification
Each criterion names the test or check that shows it, and what would count as failing.

## 7. Failure, recovery and rollback
Where relevant: what happens when the network, the machine or a step stops part way.

## 8. Permissions and owner decisions
What Eric decides, what needs his approval, and what no agent may do.

## 9. Completion evidence and remaining limitations
Filled in at the end: exact commit, commands, counts, exit codes, and what is still not shown.
```

## Example: the restore hold

A short version of the restore-hold work (#187, #188).

- **What behavior changes:** a restored copy holds the Paper Book. It funds nothing, sends no order and applies no hour until Eric rules on what would run.
- **What must stay true:** an interrupted restore must stay held, and a later attempt to write to the book must refuse with `RESTORE_HELD`. The nine protected files named in `docs/CONSTITUTION.md` Invariant 3 don't change.
- **What evidence lets Eric accept it:**
  - Tests that show the hold and the refusal, in `dashboard/tests/restore-hold.test.js`, such as `a clean restore into a new folder is held` and `while held no writer of the book is reached, on any path`.
  - A probe that stops a restore part way, then shows it held, with no later book write and the hour refused.
  - Deliberate breaks of the code, each caught by a test. A break that no test catches is a missing test or a defect until shown otherwise.
  - The full suite alone on the pinned Node, and the protected files compared against the baseline, all at the exact commit.
- **Limits it had to state:** a Render disk restore writes no marker and is not detected, and the Render steps have never run. The procedure is `docs/engineering/PAPER_BOOK_RESTORE.md`.
