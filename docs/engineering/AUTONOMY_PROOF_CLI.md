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

**A readback verifies evidence; it does not manufacture operating proof.** Each
gate in the canon has a reader over the records of one closed evidence bundle.
A gate with no bound record is UNVERIFIED and listed as not executed. A record
that contradicts a gate is FAIL. An owner decision, a drill or a Render fact
the desk cannot read rests on Eric's own record, and that gate is labeled
`owner_record`, never a desk read. This adds no operating process or store.

A step reads **PASS** only when all of these hold:

1. `--mode=post-merge`, run from a clean checkout at `--expected-revision`, which
   is also `origin/main` as last fetched (`merged_revision`).
2. `/healthz` reports that same revision, so `--offline` never certifies.
3. Every member of `<evidence>/<STEP>/manifest.json` matches its bytes and hash.
4. A receipt merged on `origin/main` under `docs/engineering` names that
   manifest's SHA-256 (`<step>:anchor`). Writing `live_run` in a manifest is only
   a declaration. Eric's merge is what vouches for the bytes; it is not a
   cryptographic attestation.
5. Only `docs/` or `audits/` changed since the bundle's `baseline`, so merging the
   receipt does not stale it. A code change reads UNVERIFIED: refresh the runner
   and repeat from R0 (`baseline_current`). The deployed revision is compared
   with the current merge, never with the baseline.
6. Every earlier step's own records read PASS, and the bundles closed in order
   (`prerequisites`, reported per step in `prerequisite_results`).
7. Every gate reads PASS, and no read record holds a credential-shaped value.

`--evidence=<directory>` is the evidence root; nothing is searched for by default.
Each step's bundle is a folder under it, `R0/`, `B0/`, `B1/`, `B2/`, `B3/`, `cutover/`:

```json
{ "format": "cr-operating-proof-b1-evidence@1", "closed_at": "2026-11-05T17:00:00Z",
  "baseline": "<40-character SHA>", "files": [{ "path": "lineage.json", "bytes": 1, "sha256": "<64 hex>" }] }
```

A member listed but missing or changed is FAIL. A file present but not listed
proves nothing. JSON may be UTF-8 or the UTF-16 PowerShell writes. No script in
a bundle is executed, and a narrative's words are inventoried, never interpreted.

| Step | Run records: the desk's own output, as captured | Eric's records |
|---|---|---|
| R0 | `revision-final.json`, `healthz.txt`, `tasks-final.json`, `pilot-all.final-status.json`, `verification.json`, `doctor-main-workspace.json`, `offsite-readback.json` | none |
| B0 | `revision-final.json`, `healthz.txt`, `tasks-final.json`, `controls.json`, `trader.json`, `dry-run.json`, `dry-run-negative.json`, `isolation.json`, `doctor.json` | `build-deploy.json`, `authority.json`, `heartbeat.json`, `candidate.json`, `B0.txt` |
| B1 | `run-log.json`, `tasks-after.json`, `trader-after-ack.json`, `trader-after-window.json`, `desk-controls-after.json` | `lineage.json`, `window.json`, `B1.txt` |
| B2 | `attribution.json`, `basis.json`, `trader.json` | `lineage.json`, `successor.json`, `lifecycle-evidence.json`, `deploys.json`, `B2.txt` |
| B3 | `trader-before.json`, `trader-after.json`, `trader-restart.json`, `desk-controls-before.json`, `desk-controls-repeat.json`, `desk-controls-restart.json`, `run-log-repeat.json`, `run-log-restart.json` | `B3.txt` |
| cutover | `pc-task.json`, `desk-controls-2h.json`, `desk-controls-6h.json`, `desk-controls-24h.json`, `basis-hosted.json`, `trader-hosted.json` | `approval.json`, `service.json`, `kill-drill.json`, `desk-down.json`, `operations.json`, `healthchecks.json`, `lifecycle.json`, `cutover.txt` |

The exact fields of each are what `READERS` in `dashboard/core/autonomy-proof.js`
reads; a missing field reads UNVERIFIED and names what is missing. Desk captures
are as returned: `GET /api/desk/controls`, `GET /api/paper/trader`,
`GET /api/research/attribution`, `GET /api/doctor`, a `pilot-all.jsonl` line, and
`tickets basis <project_id> <decision_id> --json` from the Render Shell.

- **R0** is pinned first by `OPERATING_PROOF_R0_2026-11-03.md`. A repeated R0
  reads once a merged receipt names its own hash; until then, a bundle that
  differs from the pin is FAIL. The #167 routing stand-in and passing suite do
  not prove a later real Hourly/offsite run: `r0:offsite_run` needs
  `offsite-readback.json`, showing a run after the repointing.
- **B0** `B0/controls.json` also gets the admission, claim and project checks
  (`b0:admission`, `b0:claims`, `b0:project`), bound or not. An enabled admission
  or an unresolved claim is FAIL. Those facts alone never discharge B0.
- **B1** follows the lineage to the acknowledged buy, checks the control came
  before the first eligible hour was usable (a send at 14:20 is usable at 16:10),
  and reads the order cancelled, with no fill and no position, after that time.
  The lineage also reads the order's opening receipt (`cr.opening-guard.v1`) from
  its own row of `trader-after-ack.json` (`orders[].opening_receipt`, as
  `GET /api/paper/trader` returns it): it must read `bound`, for this decision,
  intent and reserved quantity, with the gate enforced and the guard's result
  `pass`. No reading, or one the desk could not check, is UNVERIFIED; `missing`,
  `not_checked`, `unreadable` or `mismatch` is FAIL.
- **B2** needs `inputs.label === 'decision_time'` on the attribution row, an
  unrefused view, `digest: 'verified'` with every named original checked by its
  SHA-256 (`format: cr-decision-view@1`, the view of `cr.decision-basis.v1`), and
  a fill whose hour starts at or after the send. No fill reads **Fill pending**:
  UNVERIFIED, never FAIL. Closure pending blocks nothing; a close must be natural.
- **B3** compares run, report, receipt, decision, intent, order and fill IDs,
  claims and `sessions_today` before, after and after the restart. An uncertain
  attempt that was released is FAIL. `separate_results` reports cancellation,
  live fill, risk reduction, closure and restart apart. Hosted restart stays
  UNVERIFIED unless separately authorized and observed, and does not block.
- **Cutover** keeps `host_installed`, `runner_alive`, `lifecycle_proven`,
  `fill_proven` and `closed_outcome_proven` apart in `separate_results`, each
  proven, pending or failed. A later one never stands in for an earlier one. The
  last two read the bound basis and Paper Book records, never the record's own
  word. A pending fill or close keeps the overall cutover at UNVERIFIED: a
  correct no-trade outcome is reported as such, and is never passed.
- Imported files are labeled **offline_record** or **owner_record**, never live.
  Hashes bind bytes, not authenticity. `--fixture`, a manifest `provenance` of
  `fixture`, `synthetic`, `test`, `demo` or `fictional`, or a fictional marker in
  a read record prevents an operating PASS. A marker under a merged receipt is
  FAIL. An input's own `origin`, `result`, or `PASS` assertion conveys no
  authority. Unrecognized evidence is not reconstructed or repaired.

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
source paths/hashes, executed and unexecuted checks, missing evidence, the
manifest's provenance, earlier steps' results and any separate results. Raw
records, credentials and command error text are excluded; a reason repeats a
record's value only when it is a number, a boolean, a SHA or a short word. Records
a gate reads are scanned for credential shapes, and a hit is FAIL without repeating
the value. Saved test logs in a bundle are hashed but not scanned, since they
rightly mention fixtures. Environment secret
values are redacted as a second boundary. Git readers inherit only basic OS
variables, disable optional locks/global config and never invoke credential
helpers. This does not claim credential isolation for other runner paths (B1).

## Verification

This is new functionality, so no historical defect or red–green baseline is
claimed. Deterministic acceptance and negative controls are in
`dashboard/tests/autonomy-proof.test.js` and
`dashboard/tests/autonomy-proof-records.test.js`. They use synthetic evidence
only, so a PASS there proves the classifier, never a milestone. One runs real git
through a receipt merge; only `/healthz` is stubbed there.
Run the targeted tests and `node dashboard/cli.js test`; neither establishes a
real operating milestone. A1 changes none of the nine protected files.
