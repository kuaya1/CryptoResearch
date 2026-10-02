# Runtime and exact commands

## Where this ran

- **Machine.** This PC (DESKTOP-IILMFLP), inside the Claude desktop app's isolated Linux VM: Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic, 2 vCPU, about 4 GB RAM.
  - The real workspace was only read, to copy code and records. The exceptions were the session-start doctor check and creating this folder.
  - Nothing was uploaded.
- **Development copy.** `~/crdev/work`, a git repository. Baseline commit `9191d3a` holds the 70 audited files plus templates.
- **Baseline copy.** `~/crdev/baseline`, made write-protected after copying.
- **Node.** `v24.21.0`, Linux x64, from the npm package `node-linux-x64@24.21.0`. nodejs.org was not reachable from the VM, so the binary was not checked against the official SHASUMS. The deployed runtime is Node 24.21.0 for Windows via Volta. The `package.json` pin and `engines` field were not changed.
- **Browser.** Headless Chromium 153.0.8010.0 (npm `@sparticuz/chromium@153.0.0`), driven by `playwright-core@1.63.0`.
  - The packaged Lambda flags that disable web security, site isolation and multi-process mode were removed. With those flags on, same-origin POSTs carried no Origin header and were refused (`fixtures/probe-post.mjs`), which would have been a test artifact.
  - No dependency was added to the application. These tools lived outside the workspace.
- **Workspaces.**
  - Tests used `kind: test` folders in the VM's temp directory.
  - Browser checks used the fictional demo workspace `ws_n7587g3f4x` (`kind: demo`) on loopback ports 4931–4953.
  - The baseline browser check used demo workspace `ws_zz3nj6c65i`.
  - Copies of the real records were relabeled `kind: test` with new IDs.

## Commands

All of these ran from the development copy unless a different folder is named.

```sh
# starting fingerprint of the live real root (read only)
python3 fingerprint.py ~/mnt/CryptoResearch fixtures/scope-70.txt      # 9ff79de7...

# suites
node dashboard/cli.js test                                              # baseline copy: 108/109
node dashboard/cli.js test                                              # repaired copy: 138/139
node --test dashboard/tests/v2-*.test.js                                # new tests copied into a baseline copy

# browser acceptance (repaired), then baseline for comparison
node dashboard/cli.js demo build
node browser-acceptance.mjs tabs|layouts|reconcile-ui|lifecycle|live-ux <codeDir> <port> <outDir>
CR_TABS=8 CR_TAB_TIMEOUT=12000 CR_SHORT=1 node browser-acceptance.mjs tabs <baselineCopy> 4941 <outDir>

# rollback compatibility and copied real records
node rollback-compat.js <repairedDir> <baselineDir> <scratch>
node real-copy-check.js ~/mnt/CryptoResearch <repairedDir> <baselineDir> <scratch>

# patch reproducibility
git apply --check PATCH.diff && git apply PATCH.diff                     # on a pristine baseline copy
python3 fingerprint.py <that copy> fixtures/scope-76.txt                 # 0f5e0074...
node rollback-code/verify-manifest.js                                    # 9ff79de7..., ok
```

At the user's standing instruction, `node dashboard/cli.js doctor --json` also ran against the real workspace at the start of the session. It writes and reads back a probe file in `.cr`.
