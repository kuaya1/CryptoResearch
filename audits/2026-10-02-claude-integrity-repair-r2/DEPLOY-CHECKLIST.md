# Before deploying round 2

> **SUPERSEDED (2026-10-02).** Do not follow this checklist. The current deployment and rollback instructions are in [the Windows release-candidate report](../2026-10-02-rc-integrity-r2-windows/README.md#deployment-instructions-current) ([rollback](../2026-10-02-rc-integrity-r2-windows/README.md#rollback-current)). They name the reviewed code commit and its fingerprint, which replace `integrity-repair-r2.patch` and `59fef28a…` below. Two steps here are wrong on Windows: blocker 1 applies the patch with plain `git apply` outside a repository, which writes CRLF on that PC (W3), and "antivirus locks (`EBUSY` falls back to exclusive create)" does not hold on NTFS, where a hard link succeeds under any share mode (W4). The text below is kept unchanged as historical evidence.

Nothing here has been done. Each step needs your go-ahead.

## Blockers

1. **Run the suite on Windows** in an isolated copy, not the real folder: copy `dashboard\` (without `demo-workspace` and `index`), `package.json` and `templates\` into a new folder under `%TEMP%`, `git apply -p1 integrity-repair-r2.patch` there, then `node dashboard\cli.js test` with Node 24.21.0. Expect 157/157. This covers what Linux could not: NTFS hard links for captures, antivirus locks (`EBUSY` falls back to exclusive create), junctions and Windows path rules in the restore tests. Rationale: round 2 ran on Linux only.
2. **Stop the dashboard and confirm it stopped.** On 2026-10-02 `.cr\server.json` named pid 15168, started 17:44 UTC. Use the procedure in `../2026-10-02-claude-integrity-repair/ROLLBACK.md` ("Stop the dashboard first, and confirm it stopped"), including the hourly task and the lock check.
3. **Recovery copy.** Round 1 made `Documents\CryptoResearch-recovery\20261002T164934Z-pre-integrity-repair-code\` with the live code (`9ff79de7…`). The live code is still `9ff79de7…`, so that copy still matches. This session could not open it (outside the connected folder). Run its `verify-fingerprint.cjs` against it, or make a new one, before applying.

## Apply

The folder is now a Git repository (`main` at `a840ba7`, which matches the live code). Applying on a branch keeps the original one `git checkout` away, in addition to the recovery copy. To track this folder's reports, add them to the `.gitignore` allowlist the way round 1's are listed; the evidence and tools can stay local.

From the workspace root: `git apply -p1 audits\2026-10-02-claude-integrity-repair-r2\integrity-repair-r2.patch`, then confirm the fingerprint is `59fef28aaf35be04bba288fe0825b1c7f7218a47a903d313b830e89424b07a73` (81 files), then `node dashboard\cli.js test`, then `doctor` (it writes a probe file), then apply `DOC-CHANGES-PROPOSED.md`, then reload every open dashboard tab (old tabs keep the old page code).

## Rollback changes from round 1

Round 1's `ROLLBACK.md` applies, with two changes:

- The list of files to remove gains `dashboard\core\captures.js`, `dashboard\tests\research-capture.test.js`, `dashboard\tests\provider-transport.test.js`, `dashboard\tests\children\child-lock-holder.js`.
- Before rolling back, run `node dashboard\cli.js research run` and check that doctor shows no **Research captures**. The original code leaves a pending capture alone (tested), and rolling forward again saves it; but while rolled back, that answer is not in the records.
