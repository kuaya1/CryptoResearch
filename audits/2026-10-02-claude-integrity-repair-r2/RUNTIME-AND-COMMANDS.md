# Runtime and commands (round 2)

## Runtime

- **Tests, F1 work, red runs:** the Linux VM on Eric's PC (the Cowork workspace on your PC), Node **v24.21.0** with bundled Undici **7.29.1**: the official Linux build of the version `package.json` pins, from the npm registry package `node-linux-x64@24.21.0` (nodejs.org downloads were blocked by the network allowlist). The VM's own Node is v22.23.2 (Undici 6.28.0); it was not used for results.
- **F2 long check:** the same Node 24.21.0 build in Claude's cloud workspace (the VM ends background processes when a command returns, and one command may run at most 180 s). Local stub on 127.0.0.1 only. The script and output were copied into this folder byte for byte (SHA-256 checked).
- **Windows:** not used for round 2. Round 1's Windows results are in its own folder.

## Folders (VM scratch, outside your folders, deleted afterwards)

| Folder | Purpose |
|---|---|
| `~/crfix-r2/baseline` | Copy of the live code + `templates/` (read only from your folder) |
| `~/crfix-r2/r1` | baseline + round 1's `integrity-repair.patch` (fingerprint `4ce11b80…`, matches round 1's report) |
| `~/crfix-r2/dev` | r1 + round 2 changes: the tested tree (`59fef28a…`) |
| `~/crfix-r2/red` | r1 + round 2's new and revised tests and test children only |
| Test workspaces | `cr-test-*`, `cr-runner-*`, `cr-holder-*`, `cr-f1-*` under the OS temp folder, removed by the tests |

## Commands

`GUARD` = `NODE_OPTIONS=--require tools/no-network-guard.cjs` (round 1's guard: refuses any non-loopback fetch and logs it). No refusal was logged in any run.

| Purpose | Command |
|---|---|
| Fingerprints | `node tools/fingerprint.cjs <root>` (round 1's script) |
| Apply round 1 | in `r1`: `git apply -p1 integrity-repair.patch` |
| Full suite | in a tree: GUARD `node dashboard/cli.js test` |
| Full suite, copies keep source mtime | GUARD + `--require tools/preserve-mtime.cjs` |
| Red run | in `red/dashboard`: GUARD `node --test tests/research-capture.test.js tests/research-attempts.test.js tests/provider-transport.test.js` |
| F1 reproduction | GUARD `node tools/f1-repro.cjs <tree>` for `red` (round 1 code) and `dev` |
| Captures across versions | GUARD `node tools/rollback-capture.cjs` (original then round 1), and with `TREES=baseline` (original only). Uses each tree's own `cli.js research run`; the guard refuses any real send. |
| F2 long check | `node tools/long-check.cjs 320` (cloud workspace, Node 24.21.0) |
| Patches | trees copied without `demo-workspace`/`index`, then `git diff --no-index --no-prefix --binary a b` (baseline→dev and r1→dev) |
| Patch check | fresh copy of the live code + `git apply -p1 integrity-repair-r2.patch` → `59fef28a…`; r1 copy + `r2-delta-from-r1.patch` → `59fef28a…` |

## Documentation consulted

- Undici Client options, `headersTimeout` / `bodyTimeout` defaults `300e3`: https://undici.nodejs.org/api/Client
- Undici v7→v8 migration, global dispatcher symbols: https://undici.nodejs.org/best-practices/migrating-from-v7-to-v8
