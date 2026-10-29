# Post-implementation forensic audit — Scout Leads and Cross-Model Challenge

**Executive verdict: NO-GO (Fixes Required).**

The existing test suite and UI checks pass, and the protected accounting boundary is intact. Six additional adversarial reproductions nevertheless confirm defects in admission replay, dispatch consent, failure isolation, receipt integrity and Solana eligibility. The passing suite does not cover these cases. Fix F1–F6 before treating the pipeline as accepted.

This review changed no application code, settings, production records, credentials or schedules, and sent no model/provider requests. The only checkout addition is this requested report. The repository ignores new files under this audit directory (`.gitignore:77`); the report is saved on disk and has not been staged or committed. Audit scripts, test logs and the isolated source copy are outside the repository.

## 1. Commit pins, scope and merge status

| Item | Pin |
|---|---|
| Audited implementation HEAD | `a7598ba33ad7e3c8a5a80d57d93ded0bfd41f0d1` |
| Audited source tree | `619f86d0d4aab27bb557e604e556e8b0a697509d` |
| Pre-implementation baseline | `ac5fc890918c2b1b94b0abc1874ee1d47602f694` |
| Refreshed `origin/main` | `1d182f25010d7da1df456c572d1d27e1d1c43909` — merge of PR #104 |
| Current main versus audited HEAD | Identical trees; `git diff origin/main HEAD` is empty |

The seven steps are PR #98 (`3b1f712`, lock order), #99 (`02440bd`, delivery), #100 (`bb6a672`, sender), #101 (`83469f5` plus `8dc2152`, eligibility and deadline correction), #102 (`bfae4ec`, admission), #103 (`e04a9c2`, challenge), and #104 (`a7598ba`, integration/docs). Seven steps comprise eight implementation commits.

**All seven PRs are already merged at the refreshed remote-main pin.** Consequently this is also a post-merge defect report; it cannot function as a preventive merge gate for those PRs. Deployment, production configuration and feature activation were not inspected and remain unknown.

The cumulative baseline-to-HEAD diff covers the new modules, sender, routes/tools, schemas, templates, UI source and committed bundle. I also checked the current-main diff and per-path commit history so that an empty current-main diff did not conceal earlier protected-file changes.

### Protected boundary: PASS

There are **zero cumulative changes and zero implementation commits touching**:

- `dashboard/core/paper.js`, `paper-trader.js`, `trade-risk.js`, `decimal.js`;
- `dashboard/core/trader-desk.js`, the desk adapter to the paper engine;
- `templates/schemas/ticket.v1.schema.json` (`cr.ticket.v1`);
- `templates/tickets/ticket-prompt.v1.md` (`cr-ticket-prompt@1`);
- `templates/scout/scout-prompt.v1.md`.

The v1 ticket reader still selects `cr.ticket-receipt.v1` from `tickets/receipts/` ([paper-trader.js:168](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/paper-trader.js:168)). Challenge receipts use the separate `tickets/challenge-receipts/` namespace ([ticket-challenges.js:67](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:67)). No replacement ticket version is injected into that reader.

## 2. Executed verification and exact results

All commands ran against a separate copy of the audited commit. The copy has the exact HEAD and its own Git metadata; test helpers and browser checks use fictional temporary desks. UI dependencies were copied from the installed dependencies, and no package install was performed.

| Verification | Result |
|---|---|
| `node dashboard/cli.js test` — clean rerun | **1,218 tests; 1,218 passed; 0 failed; 0 cancelled/skipped/todo**, exit 0, 157.153 seconds reported by Node |
| `npm run ui:build` | **PASS**, exit 0; 39 generated assets; rebuilt copy is Git-clean |
| `npm --prefix dashboard/web run check` | **PASS**, exit 0 |
| Browser-check phase | **93 printed `ok` assertions, 0 printed failures**, plus the script's aggregate “All browser checks passed” for its other checks |
| Production browser regression phase | **86/86 passed; 0 failed** |
| Additional audit reproductions | **7/7 observation tests passed**: six confirmed defects and one positive recovery control; these are not seven assertions of safe behavior |

There is no root `npm run check` script. The actual package check above is the defined equivalent; a missing command was not counted as test coverage.

For transparency, the first archive-only full-suite run was **1,217 passed / 1 failed**. The rollback drill requires a Git checkout and failed because that first isolated archive had no `.git` metadata. I restored the exact commit's Git metadata in the audit copy and reran the entire suite; the clean 1,218/1,218 result above supersedes that environment failure. Both logs are retained.

The browser scripts exercise the general desk and existing regression scenarios. They do not establish a complete populated Scout Leads / Challenge browser journey. The new Node suites and pipeline integration test cover the new data flow, but missed the adversarial cases below.

Evidence: [final suite log](C:/Users/Kuaya/.codex/visualizations/2026/10/29/01a185bf-7e81-71a0-8b17-295a96e9a59f/post-implementation-a7598ba/full-suite-rerun.log), [build log](C:/Users/Kuaya/.codex/visualizations/2026/10/29/01a185bf-7e81-71a0-8b17-295a96e9a59f/post-implementation-a7598ba/ui-build.log), [browser log](C:/Users/Kuaya/.codex/visualizations/2026/10/29/01a185bf-7e81-71a0-8b17-295a96e9a59f/post-implementation-a7598ba/ui-check.log), [reproduction source](C:/Users/Kuaya/.codex/visualizations/2026/10/29/01a185bf-7e81-71a0-8b17-295a96e9a59f/post-implementation-a7598ba/adversarial.test.cjs), [reproduction log](C:/Users/Kuaya/.codex/visualizations/2026/10/29/01a185bf-7e81-71a0-8b17-295a96e9a59f/post-implementation-a7598ba/adversarial.log).

## 3. Eight-blocker verification matrix

`PASS` is bounded to the inspected code and executed evidence, not a mathematical proof of all interleavings or the deployed service.

| Blocker | Result | Actual implementation and evidence |
|---|---|---|
| **B1 — exact reviewed evidence** | **FAIL** | The comparison runs inside `runOp`'s lock and checks cached receipt ID/hash, identity revision, expiry, state and policy ([leads.js:811](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:811), [843](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:843)). However, the actual receipt read at [869](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:869) is only checked for self-consistency; its hash is not compared with the reviewed/cached hash before admission copies it at [880](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:880). **F6 reproduced acceptance of a different, REFUSED receipt under the reviewed ID.** Also, the request binds `identity_revision`, not the mutable asset `revision` expressly requested in the audit directive ([Review.jsx:451](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/web/src/views/review/Review.jsx:451)). Existing changed-receipt/policy/expiry tests pass ([admission test:79](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/scout-leads-admission.test.js:79)), but do not cover F6. |
| **B2 — deterministic admission/effect replay** | **FAIL** | Admission IDs and effect keys are deterministic ([leads.js:757](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:757), [919](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:919)). Already-keyed creations replay before preflight ([research.js:909](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:909)); existing crash tests pass ([admission test:126](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/scout-leads-admission.test.js:126)). **F1 shows that selecting an existing recent run creates no keyed receipt and a delayed replay creates another run. F3 shows that an intake-effect exception aborts the batch response after admissions commit.** |
| **B3 — Windows-safe filenames** | **PASS** | Filename is the first 32 hex SHA-256 characters of canonical `[chain_id,address_key]`; reads recompute identity and filename ([leads.js:60](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:60), [77](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:77)). Base58 case remains intact; EVM keys normalize appropriately. The Windows fixture creates distinct files for case-distinct base58 addresses ([lead test:219](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/scout-leads.test.js:219)); integrity mismatch test passes at line 249. This uses ordinary cryptographic collision assumptions, not an assertion that hash collisions are impossible. |
| **B4 — active timer, due recovery and shared network limits** | **PASS — scope below** | The server uses exported `HOSTED_TIMER_JOBS` ([jobs.js:41](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/jobs.js:41), [server.js:745](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/server.js:745)). `isDue` considers pending admissions before enable/source gates ([leads.js:419](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:419)); expiry/policy/stale claims use one predicate at [391](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:391). One monotonic turn object supplies the deadline, signal and counter ([335](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:335)); selection is capped at five, requests at ten, and token/retry/body paths share it ([screening.js:556](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/screening.js:556), [intake.js:254](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/intake.js:254)). Eligibility tests at [252](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/scout-leads-eligibility.test.js:252), 282, 302 and 347 pass; the audit control confirms pending work remains due with no due asset and a closed source gate. |
| **B5 — holds and dispatch honesty** | **FAIL** | Initial envelope filters every held provider, including Claude ([leads.js:762](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:762)); confirm checks it under the lock. Button words correctly request research. **Recovery passes only the frozen provider names, omits frozen routes/budget checks, and current `providerStatus` determines new jobs. F2 reproduces a reviewed manual/connector route becoming a due API job without a new confirmation.** |
| **B6 — first-pass challenge isolation** | **PASS** | ChatGPT-only role and hold checks at [mcp.js:2048](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/mcp.js:2048); start/save invoke the actual local `guardIndependence` at [2014](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/mcp.js:2014), [2034](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/mcp.js:2034). Pending metadata excludes blocked projects from `next` and carries no prompt/target/draft ([ticket-challenges.js:537](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:537)). Read-only registry excludes the write tools ([mcp.js:509](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/mcp.js:509)). Role, hold, open-first-pass and read-only tests pass ([challenge tests:194](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/ticket-challenges.test.js:194), 222, 262). |
| **B7 — honest all-unknown verdict** | **PASS** | Schema admits `insufficient_evidence` and test-level `cannot_assess`; runtime enforces compatible verdicts ([ticket-challenges.js:318](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:318)). UI has three assessment tones and words ([PMDecisionCard.jsx:137](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/web/src/views/inspector/PMDecisionCard.jsx:137)). All-unknown verdict tests pass ([challenge test:321](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/ticket-challenges.test.js:321)). No challenge gates approval or contributes to sizing. |
| **B8 — immutable receipts, mutable drafts/jobs, integrity** | **FAIL** | Target/prompt/final files are created with `mode:'create'`; jobs and drafts update through verified operations ([ticket-challenges.js:274](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:274), [342](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:342), [425](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:425)); eligibility receipts are create-only at [leads.js:642](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:642). Restart/correction/revision tests pass. **F4 demonstrates that changing the challenge JSON verdict alone survives `receiptHolds` and is displayed as valid.** Existing tamper test changes Markdown or the challenged ticket, not challenge JSON ([challenge test:170](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/ticket-challenges.test.js:170)). |

**B4 qualification:** the 20-second bound covers the shared asynchronous eligibility network phase, not the complete job or HTTP request. Admission recovery and claim writes occur before `makeTurn`; commits happen after it ([leads.js:669–689](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:669)). Lock waits, synchronous I/O and event-loop stalls prevent a strict whole-turn wall-clock guarantee. Revision 2 explicitly scoped that promise to network time; if the audit directive literally requires the entire job to finish within 20 seconds, that stronger requirement is **not satisfied**, and B4 must be marked FAIL under that interpretation. The scheduler/network-budget contract itself passes.

## 4. Confirmed defects and exact correction list

### F1 — P1: reused runs bypass durable effect recording

**Locations:** [research.js:933–935](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:933), [projects.js:307](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/projects.js:307), [leads.js:1004](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:1004).

The new early applied-key lookup correctly fixes replay of *created* runs. It does not fix the first call that returns `exists`: that path still exits before `runOp`. The analogous existing-project path also lacks the admission's applied receipt.

**Reproduced:** create a matching manual run A during an admission, let the keyed request reuse A, and inject a crash before linking. No `admission:<id>#research` receipt exists. Age A by eleven minutes and recover: run B is created, and the project now has two matching runs. No paid request was made by the reproduction.

**Minimal correction:** make keyed creation **and reuse** resolve under the workspace lock, consult the applied key first, and persist the selected result/hash atomically with any effect. A reuse/no-op needs an explicit staged resolution record: `runOp` otherwise skips applied-receipt creation when there are no staged entries ([ops.js:694](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ops.js:694)). Preserve unkeyed caller behavior. Cover existing-project resolution as well as existing-run resolution; freeze inputs used by the payload hash rather than silently deriving them again.

**Required regression:** crash after `exists` selection; complete or age out A; replay still returns A. Also assert a durable key for reused projects/runs and a payload conflict on their reuse branches.

### F2 — P1: recovery silently changes the authorized execution route

**Locations:** [leads.js:1004–1013](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:1004), [intake.js:658](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/intake.js:658), [research.js:948](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/research.js:948).

`completeAdmission` neither passes the frozen routes to run creation nor checks them before an uncommitted effect. New jobs use current provider configuration. Frozen `budget_scope` is likewise not rechecked there.

**Reproduced:** confirm Claude with `connector_or_manual`, fail before creating the run, enable a mock API route, and Complete. The admission still records manual consent, while the run is `queued` and `research.hasDueWork` is true. A real configured route would be eligible for the existing paid runner.

**Minimal correction:** carry the reviewed execution envelope through `admitListing`/`createRun` and construct jobs from its authorized routes, or refuse an uncommitted effect when a route/budget change requires fresh consent. Keep the frozen provider set; a later hold must continue to prevent dispatch. Reading a completed effect's original keyed result should not require new consent.

**Required regression:** manual-to-API configuration change during recovery cannot create a due API job from manual consent; changed spending scope has an explicit outcome; held jobs remain unsent. Use mocks only.

### F3 — P2: one intake failure aborts independent admissions and loses the committed-receipt response

**Locations:** [leads.js:907](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:907), [981–991](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:981). The catch at line 1014 covers only later project/run work.

**Reproduced:** inject one `StagedOp.writeJson` exception on the first intake save of a two-row confirm. Both admissions and both `ADMITTED` states have already committed. `confirmLeads` throws, returns no batch/admission receipts, and never attempts the second independent admission. This is a recoverable partial failure, not rollback of the confirmed batch.

**Minimal correction:** isolate the entire per-admission completion path, including intake creation and final linking. After confirmation commits, collect each result/error and return the committed batch/admission identifiers even if progress/error persistence fails. Do not report unsaved progress as saved. Continue attempting other independent admissions; a global storage failure may leave them pending with named errors.

**Required regression:** first or middle intake/link failure still returns all committed admission receipts; unaffected rows complete; replay finishes pending work once.

### F4 — P2: altered challenge JSON can display a false verified verdict

**Locations:** [ticket-challenges.js:449–456](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:449), [485–495](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/ticket-challenges.js:485).

`receiptHolds` verifies Markdown against the JSON's text hash and verifies the target. It does not authenticate the challenge JSON's own displayed verdict/tests against an external receipt pin or the verified answer block. `block_sha256` is stored but not used to validate that displayed projection.

**Reproduced:** save `material_objection`, change only `challenge_verdict` and `verdict_reason` in its JSON, and leave Markdown untouched. The card returns `saved`/`concur`; the route says `holds:true`. The saved answer actually disagrees. This is an integrity/corruption-detection failure; no public filesystem-write exploit is asserted.

**Minimal correction:** pin final receipt JSON bytes in the job's receipt references during the same commit and verify that pin on every read; bind the displayed projection to the verified Markdown block (or derive it from that block). Suppress verdict/tests on mismatch. Do not rewrite historical final receipts during a GET.

**Required regression:** independently alter JSON verdict, tests, assessed count or reason; card/route must show integrity failure and no verdict. Existing Markdown/target tamper tests must remain green.

### F5 — P2: Solana eligibility drops known transfer restrictions and scheduled fees

**Locations:** [leads.js:465–469](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:465), [505](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:505). Compare the existing conservative rule at [forensics.js:1182](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/forensics.js:1182).

**Reproduced:** the real normalizer reads current fee 0%, scheduled fee 25%, a present transfer hook and `non_transferable:present`. `screenFacts` discards the latter facts, and `judge` returns `ELIGIBLE` under a 5% limit. The UI also omits those Solana restrictions from its check words ([Review.jsx:402](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/web/src/views/review/Review.jsx:402)). Eligibility is only a review filter, so this is not a claim of unsafe accounting execution; it is a false policy result.

**Minimal correction:** preserve scheduled fees, hooks and transferability in the facts. Use `max(current_fee, scheduled_max_fee)` only with the complete supported basis; unknown basis is `INCOMPLETE`, known non-transferability does not pass, and hooks require an explicit conservative outcome. Alternatively exclude Solana from this first lead-policy implementation. No new RPC reader is needed.

**Required regression:** scheduled fee above limit, missing schedule, unknown/present hook, non-transferable token and fully known zero-fee token.

### F6 — P2: actual receipt contents are not bound back to the reviewed hash

**Locations:** [leads.js:821–825](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:821), [869–884](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:869).

The first comparison checks the asset's cached receipt hash. The later read checks whether the receipt matches *its own* embedded hash. There is no equality check between those two hashes before using the receipt's listing and freezing its new hash into the admission.

**Reproduced:** replace one eligibility JSON under its existing ID, change it to `REFUSED` and give its listing an unreviewed name, then recompute its canonical self-hash. Leave the asset's pinned hash and the submitted reviewed hash unchanged. Confirmation succeeds, creates the unreviewed project name, and writes an admission hash different from the batch's `expect`. This single-file mutation is exactly the kind of inconsistency the receipt binding should reject; it is not an authenticated-ingest exploit claim.

**Minimal correction:** inside the confirmation lock, verify the loaded receipt's ID/hash against both `expect.rows[i]` and the asset pin; verify its asset/identity, state, policy and expiry before deriving a listing or staging an admission. Use the actual lock-time clock for expiry. For the audit directive's explicit asset-revision requirement, expose/send/check `asset_revision` in addition to `identity_revision`; do not count sighting-only appends as eligibility changes.

**Required regression:** same-ID replacement with a valid but different self-hash returns `409 CHANGED`/named integrity failure and writes nothing. Bind the actual receipt's state/policy/expiry too; cover asset-revision change under the reviewed key.

## 5. Other requested checks

- **Front-door lock order — PASS.** Correct key is accepted before checking the refusal lock ([scout.js:430](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/scout.js:430)). The revised test sends eleven wrong attempts, then the correct key, and checks refusal throttling/expiry ([scout-ingest.test.js:190](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/scout-ingest.test.js:190)). It passes.
- **Prompt-injection separation — PASS for scout `signal`/`urls`.** Sightings retain these as provenance; admission constructs a listing from CoinGecko, sets intake `instructions:null` and run `owner_instructions:null`, and passes no scout signal/URL into research or ticket prompts ([leads.js:794](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:794), [926](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:926), [1004](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:1004)). The admission and pipeline tests pass. This is not a general guarantee against malicious prose in every external research source.
- **v1 Scout compatibility — PASS.** The implementation does not add `scout-prompt.v2.md`; that filename in the task is stale. It adds `leads-prompt.v1.md` / `cr-scout-leads-prompt@1`, while the original brief prompt and allowed `cr-scout-prompt@1` stay intact. Sender tests prove byte-identical brief traffic with leads enabled/disabled and no brief blockage from leads failures ([sender test:78](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/tests/scout-leads-sender.test.js:78), 145).
- **Optional challenge degradation — PASS as architecture.** The challenge makes no model API calls and never alters the ticket, decision, sizing or trader output. Existing tests compare ticket/decision/book state before and after a challenge. Lack of a ChatGPT challenge remains a named absence, not a hard blocker. F4 still requires correcting the truthfulness of a displayed saved challenge.
- **Immutable versus operational records.** Create-only batches retain reviewed consent; admission progress is mutable through `updateAdmission` ([leads.js:901](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:901), [950](C:/Users/Kuaya/Documents/CryptoResearch/dashboard/core/leads.js:950)). This is a workable operational distinction, but PLAN revision 2 still calls each admission JSON create-only and should be corrected with the fixes. The response record is a design response, not implementation acceptance evidence.

## 6. Acceptance to close this audit

Implement F1–F6 in supervised, reviewable changes; turn the six audit observations into regressions asserting the corrected outcomes. Re-run the full suite, build and UI/package checks, with focused populated browser cases for lead confirmation/recovery and challenge integrity states. Preserve the protected-file boundary and existing unkeyed intake behavior.

Re-audit the resulting commit pins. Until then, **NO-GO (Fixes Required)** applies to acceptance/activation of the audited pipeline, even though its implementation PRs have already merged. Nothing in this report establishes deployment or production-data state.
