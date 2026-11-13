# B0: arming and dry-run proof at 8738bcc (2026-11-13)

**Status when written: sealed, not certified.** B0 at this revision is certified once this docs-only receipt merges to main and prove-autonomy b0 --mode=post-merge reads PASS.

- **Revision:** `8738bcc3d0fbab65995e1526ccfab8d3395b4169` (PR #195 merge).
- **Bundle:** `C:\Users\Kuaya\Documents\CryptoResearch-evidence\operating-proof-2026-11-12-b0-8738bcc\B0`.
- **Seal:** `B0/manifest.json` binds 14 files, closed `2026-11-13T12:39:40.209Z`. Its SHA-256 is `e369c9b72a8099f9e031b2f3df961bac21e18d94ecd9393da595a46d7a9c7f12`.
- **Prior gate (R0):** `R0/manifest.json` (SHA-256 `6d2a3c49fa68c14ee40a00b93e63583d4381171ebc16112c59abf61c454c85a7`) verified `PASS`.

## What the records show

- **Build & deploy:** `origin/main`, dedicated runner `HEAD`, Render deploy record, and live `/healthz` (HTTP 200) all read `8738bcc3d0fbab65995e1526ccfab8d3395b4169`; Blueprint PRs #163–#166 are merged with green head checks.
- **Quiet authority:** PC task `CryptoResearch pilot-all` is `Disabled`, Render cron is `absent`, automatic lead admission is off, repository scout variable is `false`, and 0 claims require reconciliation across 5 pilot projects.
- **Dry run & negative control:** `pilot.js --check-isolation` passed (`ok: true`); pinned unattended `--max-agents=1 --model=claude-opus-5-5 --dry-run` exited `0` cleanly on a clean worktree without claiming or pinging; dirty-tree negative control refused before polling (exit `1`).
- **Heartbeat configuration:** Healthchecks configured with `period_minutes: 60`, `grace_minutes: 120`, `alerts_eric_only: true`, and `dry_run_ping_claimed: false`.
- **Meters:** Online `doctor.json` (Market data, Contract screening, Forensics) and `trader.json` candle/order meters read valid with no unknown meter or `RECONCILE_REQUIRED` order.
- **Arming identity:** Candidate `uniswap` (`ethereum`, contract `0x1f9840a85d5af5bf1d1762f925bdaddc4201f984`, fresh observation `co_ff837453065a3d95`) is enrolled in the pilot, `contract_gate` is `enforce`, paper mandate generation `2` is active (expires `2026-11-19T12:48:46.473Z`, 1 grant/day), `paused: false`, `vetoed: false`, `held: false`.
