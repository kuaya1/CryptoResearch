# CryptoResearch independent system review

Audit date: October 1, 2026. Workspace: `C:\Users\Kuaya\Documents\CryptoResearch`. This folder contains the review and synthetic verification artifacts. Application implementation was left for a follow-up task.

Start with [REVIEW.md](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/REVIEW.md). Supporting documents:

- [Prioritized findings](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/FINDINGS.md): reproduction, affected code, impact, fix, effort, acceptance checks.
- [Validation record](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/VALIDATION.md): commands, browser coverage, screenshots, preservation and confidence limits.
- [Design recommendations](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/DESIGN.md): concrete screen changes and proposed desk layout.
- [Integration roadmap](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/INTEGRATIONS.md): current primary documentation, access, costs, exposure, fallbacks and validation.
- [Bounded implementation prompt](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/FOLLOW-UP-IMPLEMENTATION-PROMPT.md): queue replay and receipt integrity, preservation and rollback.

Evidence files include `baseline-tests.txt`, `probe-results.json`, `supplemental-results.json`, `browser-checks.json`, `runtime-and-schedule.json`, `restart-check.json`, `restore-extra-check.json`, `preservation-check.json`, scheduler XML before/after, and `screenshots/`. The scripts `reproduce.cjs` and `supplemental.cjs` show how the synthetic probes were produced. See the validation record before rerunning them: some fixtures deliberately interrupt a child process or refuse to overwrite an existing test root.

Delivery checks are saved in `preservation-final.json` and `artifact-check.json`. The latter checks artifact links and evidence counts, not application correctness. The [source register](C:/Users/Kuaya/Documents/CryptoResearch/audits/2026-10-01-codex-system-review/source-register.json) indexes current primary documentation used in the recommendations.

The isolated workspaces and raw index evidence may contain copies of research metadata. Keep the audit folder within the same privacy boundary as the research desk. No external sharing or deployment was performed.
