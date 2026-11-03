# Read-only autonomy evidence verifier (A1)

`node dashboard/cli.js prove-autonomy r0|b0|b1|b2|b3|cutover`

The command never initiates a drill, opens/recover-writes a desk workspace,
queries a scheduler, runs the pilot, or changes a record. The only network read
is an unauthenticated, bounded GET of the fixed online desk's `/healthz`.
`--offline` disables it. No provider, Render mutation or heartbeat is called.

```powershell
node dashboard/cli.js prove-autonomy b0 --desk=online --offline --json
node dashboard/cli.js prove-autonomy r0 --evidence "$HOME\Documents\CryptoResearch-evidence\operating-proof-2026-11-03" --offline --json
node dashboard/cli.js prove-autonomy b0 --mode=post-merge --expected-revision=<full-merge-sha> --project=<stored-id> --out=<directory> --json
```

Results and exit codes: **PASS / 0**, **FAIL / 1**, **UNVERIFIED / 2**. Usage
errors exit 64. A failed check dominates the aggregate. Missing evidence cannot
pass. Feature HEAD differing from main or deployment is expected in development;
`--base=<full-sha>` records/checks its base, defaulting to the locally available
merge base with `origin/main`. No fetch is performed. Post-merge mode requires
an explicit expected deployment SHA. `/healthz` proves only availability and
the revision the application reports, never pipeline health.

## Scope and limits

Acceptance criteria come from the merged
`AUTONOMY_COMPLETION_BLUEPRINT_2026-11-03.md` §5–§6, its referenced
`BOUNDED_PAPER_READINESS.md` B0–B3, and `OPS1_RENDER_CRON.md` §5–§7.
The report records their committed source hashes and the audited application
revision. Earlier gates remain prerequisites; a saved report is not proof.

**A1 cannot certify a complete operating gate.** It verifies revision readbacks,
the preserved R0 bundle below, and partial B0 controls. Requirements without a
complete authoritative reader are explicitly UNVERIFIED, including scheduler
state, owner review, meters, actual drills, ledger lineage, restart comparison,
heartbeat history, and the five separate hosted mission outcomes. This is an
evidence foundation, not a replacement for Eric's operating runbook. No command
in A1 prints an overall operating PASS. Subsequent readers require their own
bounded implementation and review; this PR adds no operating process or store.

`--evidence=<directory>` selects existing offline evidence. Optional narratives
`R0.txt`, `B0.txt`, `B1.txt`, `B2.txt`, `B3.txt`, `cutover.txt` are hashed, never
interpreted as success. Their original text is not copied to output.

- For R0, the command reads `R0/manifest.json`, matches its SHA-256 to the
  **committed** `OPERATING_PROOF_R0_2026-11-03.md` receipt, and verifies every
  member's bytes and digest before using any member. It checks recorded
  revision alignment, quiet tasks and registration from the existing JSON
  readbacks. It executes none of the bundle's scripts. The #167 routing
  stand-in and passing suite do not prove a later real Hourly/offsite run.
- For B0, `B0/controls.json` may contain the original `GET /api/desk/controls`
  JSON (`cr-desk-controls@1`, including `at`). Only admission off, claim
  readability/reconciliation and optional project coverage are inspected.
  These facts do not discharge the complete B0 requirement. An enabled
  admission or unresolved claim contradicts B0 and returns FAIL.
- All imported files are labeled **offline_record**, never live. Hashes bind
  bytes, not authenticity. `--fixture` explicitly labels synthetic inputs,
  suppresses network reads, and prevents an operating PASS. An input's own
  `origin`, `result`, or `PASS` assertion conveys no authority. Unrecognized
  evidence is not reconstructed, repaired or treated as a successful event.

## Output

The default output root is the actual home directory's
`Documents/CryptoResearch-evidence/operating-proof-<New-York-date>/`.
`--out=<directory>` selects another local root outside desk workspaces and
application checkouts. Paths with traversal, symlinks/junctions, Windows device
aliases or alternate streams are refused. Roots must be owner-controlled; this
is not an OS sandbox against another process replacing ancestor directories.

Each invocation creates a unique `proof-<step>-<UUID>/` directory containing the
requested human-readable filename (`R0.txt`, `B0.txt`, …, `cutover.txt`),
`metadata.json`, and a hash manifest. Files are durably written then atomically
created without replacement. **Only the final `manifest.json` marks a complete
bundle.** A crash may leave an incomplete directory; nothing resumes, repairs
or overwrites it. Repeated/concurrent invocations use different directories.
These are verification reports, never original operating records.

Metadata records each criterion, result, reason, observation kind and timestamp,
source paths/hashes, executed and unexecuted checks, and missing evidence. Raw
records, credentials and command error text are excluded. Environment secret
values are redacted as a second boundary. Git readers inherit only basic OS
variables, disable optional locks/global config and never invoke credential
helpers. This does not claim credential isolation for other runner paths (B1).

## Verification

This is new functionality, so no historical defect or red–green baseline is
claimed. Deterministic acceptance and negative controls are in
`dashboard/tests/autonomy-proof.test.js`. They use fictional evidence only.
Run the targeted test and `node dashboard/cli.js test`; neither establishes a
real operating milestone. A1 changes none of the nine protected files.
