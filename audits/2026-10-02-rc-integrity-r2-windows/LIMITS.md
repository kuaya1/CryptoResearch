# What this validation did not cover

1. **No FAT, exFAT or network-share volume.** Creating one needs administrator rights, which were not used.
   - Missing hard links were simulated by making `fs.linkSync` fail inside the runner process with `EPERM`, `ENOTSUP` or `EISDIR`.
   - The `EISDIR` mapping was verified indirectly: Win32 error 1 from a directory read surfaces as `EISDIR`. What `CreateHardLinkW` itself returns on FAT32 or exFAT was not observed here.
2. **Locks were real but synthetic.** A PowerShell process held the capture file with `System.IO.File.Open(…, FileShare.None | Read | ReadWrite)`. Windows Defender, the only antivirus on this PC, was not provoked, and how it really scans was not measured.
3. **The repository tests simulate Windows conditions; the harness shows the real ones.** The three new tests fake `EBUSY` and link errors inside the runner child, so they also run on Linux. The real NTFS behavior, including the temporary-file delete that fails under a lock, is shown only by `tools/capture-adverse.cjs` on this PC.
4. **The browser check used one embedded Chromium** (the Claude desktop pane, 152.0.7977.130).
   - Visibility was forced by overriding `document.hidden`, and the tabs were not separate OS windows.
   - Background-tab timer throttling may differ from real windows.
   - It ran on `1cc9fee`; the fixes do not touch `server.js` or `public/`.
5. **F2 used local stubs only:** no real provider and no paid call. The long check ran on `1cc9fee`'s `providers.js`, which is unchanged at `665439b`.
6. **F2 depends on Undici internals.** It relies on Undici's internal global-dispatcher symbol and its `Agent` constructor name. It fails safe (nothing is sent, the provider shows "not configured"), but a Node upgrade beyond the pinned 24.21.0 must re-run `tools/long-check-rc.cjs`. A proxy installed as the global dispatcher would also stop paid research (REVIEW R5).
7. **The rollback drill was a scratch copy, not the live folder.**
   - It used the documented `robocopy /E` procedure. A Git-based rollback (checking out `a840ba7` in the live repository) was not drilled.
   - The hourly task itself was not triggered; its command (`job run --all-due --trigger scheduler`) was run directly.
   - Swapping code while a runner is active was not tested; the procedure says to stop everything first.
8. **While rolled back, the original doctor reports `ok`.** It cannot see waiting captures or uncertain attempts. Check `research run` and doctor before rolling back.
9. **The fixes change the expected fingerprint.** Round 2's documents name `59fef28a…`; this release candidate's head is `92af2c94fd8e424fb134084c9c31033541ceeba3ae359a8629b6d40c26af41c3` (81 files).
10. **Line endings.** On this PC any `git apply` outside a repository converts line endings unless `-c core.autocrlf=false` is given (REVIEW W3). Inside the live repository, `.gitattributes` prevents it.
11. **Where the branch lives.** `rc/integrity-r2` exists only in the clone at `%TEMP%\cr-rc`, which Windows may clean. `evidence/rc-integrity-r2.bundle` holds the four RC commits and needs `a840ba7`. The patches are next to it.
12. **Limits of the privacy scan.**
    - It looked for 23 identifiers collected from the live records, plus generic patterns for keys, wallets, transaction hashes, provider IDs and personal data.
    - It cannot prove the absence of reworded private content.
    - The live records were read only to collect those identifiers, in memory.
13. **Round 2's own limits still apply,** notably mixed versions (its item 3) and the research lease against lock waits (its item 13).
14. **States.** Nothing here is independently reviewed, merged or deployed. The live folder still runs `a840ba7`. The live dashboard, the scheduled task, the Node pin, settings and records were not touched. The only change in the live folder is this audit folder.
