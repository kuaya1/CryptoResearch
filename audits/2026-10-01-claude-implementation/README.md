# 2026-10-01 implementation: evidence

Response to the Codex system review in `../2026-10-01-codex-system-review/`.

| File | What it is |
|---|---|
| [FINDINGS-STATUS.md](FINDINGS-STATUS.md) | Every finding (F01–F22, U01–U04): status, what changed, evidence |
| [VALIDATION.md](VALIDATION.md) | Test results (Node 24 and 20), browser checks, real-folder deployment checks, what was not tested |
| [MIGRATION.md](MIGRATION.md) | Recovery copies, exactly what changed in this folder, how to verify and roll back |
| `screenshots/before/`, `before-overflow.json` | Old interface (fictional demo) |
| `screenshots/after/`, `after-overflow.json` | New interface (fictional demo), measured at 390 / 768 / 1440 px |

## What runs by itself, what you do, what needs setup

| | What |
|---|---|
| **Automatic** | Prices, CoinGecko rank, rolling 7D/30D/24H change, volume, logos (every 5 min while the dashboard is open, hourly otherwise); inbox imports and queued Cowork requests; live dashboard refresh when files change; daily snapshot, review findings and sealed backup; journaled writes and crash recovery; research API jobs you started, once configured |
| **You (manual)** | Choosing projects; asking for research; pasting ChatGPT and Gemini answers while no API is configured; corrections; notes, decisions, reviews; recording transactions; marking projects reviewed |
| **Needs configuration** | Model APIs (key in `%USERPROFILE%\.cryptoresearch\secrets.json`, model ID, token prices, per-run/day/month budget); scheduled or unattended research (off; needs a budget and the unattended switch); CoinMarketCap rank (needs a key and an adapter; not built); liquidity data and evidence watch (no source configured); phone access (not provided: the dashboard is loopback-only by design) |
