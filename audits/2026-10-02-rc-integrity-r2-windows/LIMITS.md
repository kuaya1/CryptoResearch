# What this validation did not cover

1. **No FAT, exFAT or network-share volume.** Creating one needs administrator rights, which were not used.
   - Missing hard links were simulated by making `fs.linkSync` fail inside the runner process with `EPERM`, `ENOTSUP` or `EISDIR`.
   - The `EISDIR` mapping was verified indirectly: Win32 error 1 from a directory read surfaces as `EISDIR`. What `CreateHardLinkW` itself returns on FAT32 or exFAT was not observed here.
2. **Locks were real but synthetic.** A PowerShell process held the capture file with `System.IO.File.Open(…, FileShare.None | Read | ReadWrite)`. Windows Defender, the only antivirus on this PC, was not provoked, and how it really scans was not measured.
3. **The repository tests simulate Windows conditions; the harness shows the real ones.** The three new tests fake `EBUSY` and link errors inside the runner child, so they also run on Linux. The real NTFS behavior, including the temporary-file delete that fails under a lock, is shown only by `tools/capture-adverse.cjs` on this PC. Which check is real and which is simulated: REVIEW, "Windows test basis".
4. **The browser check used one embedded Chromium** (the Claude desktop pane, 152.0.7977.130).
   - Visibility was forced by overriding `document.hidden`, and the tabs were not separate OS windows.
   - Background-tab timer throttling may differ from real windows.
   - It ran on `1cc9fee`; the fixes, including R8, do not touch `server.js` or `public/`.
5. **F2 used local stubs only:** no real provider and no paid call. The long check ran on `1cc9fee`'s `providers.js`, which is unchanged at `10143c8`.
6. **F2 depends on Undici internals.** It relies on Undici's internal global-dispatcher symbol and its `Agent` constructor name. It fails safe (nothing is sent, the provider shows "not configured"), but a Node upgrade beyond the pinned 24.21.0 must re-run `tools/long-check-rc.cjs`. A proxy installed as the global dispatcher would also stop paid research (REVIEW R5).
7. **The rollback drill was a scratch copy, not the live folder.**
   - It used the documented `robocopy /E` procedure. A Git-based rollback (checking out `a840ba7` in the live repository) was not drilled.
   - The hourly task itself was not triggered; its command (`job run --all-due --trigger scheduler`) was run directly.
   - Swapping code while a runner is active was not tested; the procedure says to stop everything first.
8. **While rolled back, the original doctor reports `ok`.** It cannot see waiting captures or uncertain attempts. Check `research run` and doctor before rolling back.
9. **The fixes change the expected fingerprint.** Round 2's documents name `59fef28a…`, which describes `1cc9fee`. The three Windows fixes (`665439b`) gave `92af2c94…`. The candidate's code commit is now `10143c8a200257008adc06832119a38a76579524` (the R8 fix), with `6db60f392a48ca8378eab6da29031459d12c7feb32a0625ead12a4311204499e` (81 files); the later documentation commits keep it.
10. **Line endings.** On this PC any `git apply` outside a repository converts line endings unless `-c core.autocrlf=false` is given (REVIEW W3). Inside the live repository, `.gitattributes` prevents it.
11. **Where the branch lives.** `rc/integrity-r2` is kept in the CryptoResearch repository (fetched without a checkout) and offered for review on the private GitHub repository. The working clone at `%TEMP%\cr-rc` is no longer needed. `evidence/rc-integrity-r2.bundle` and the patches remain as local copies of the four RC commits.
12. **Limits of the privacy scan.**
    - It looked for 23 identifiers collected from the live records, plus generic patterns for keys, wallets, transaction hashes, provider IDs and personal data.
    - It cannot prove the absence of reworded private content.
    - The live records were read only to collect those identifiers, in memory.
13. **Round 2's own limits still apply,** notably mixed versions (its item 3) and the research lease against lock waits (its item 13).
14. **States.** Nothing here is independently reviewed, merged or deployed. The live folder still runs `a840ba7`; its working tree was not checked out, and the dashboard, the scheduled task, the Node pin, settings and records were not touched. Outside its working tree, three things changed:
    - Its Git repository holds the branch `rc/integrity-r2`.
    - A separate review worktree is registered for it (`%USERPROFILE%\Documents\CryptoResearch-review\rc-integrity-r2`), where the documentation commits were made.
    - The validation added this audit folder, as local untracked files.
15. **Cost lines (R8) are fixed, with a narrow test basis.** The failure is injected inside the runner (the save fails after its build step); a real disk-level failure at that point was not produced. The adjustment path was shown only with an attempt record whose frozen prices were removed, standing in for a record written by older code.
16. **No power-loss test.** The capture's data is flushed before placement; the name's durability rests on NTFS metadata journaling, because `fsyncDir` is a no-op on Windows (REVIEW, item 1.6).
