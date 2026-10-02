# Privacy scan

**Tool:** `tools/privacy-scan.cjs`. It only reads.

## What it looks for

**1. Identifiers from the live records.** These were collected in memory from the live workspace and never printed or saved; output masks any match. 23 values in total:

| Kind | Count |
|---|---|
| Workspace ID | 1 |
| Project IDs and names | 3 |
| Symbols | 2 |
| Identity fields (CoinGecko ID, contract addresses, official sites, aliases, headline, origin request) | 11 |
| Event IDs | 1 |
| Report provenance (report ID, file hashes, original file name, inbox path) | 5 |

The portfolio holds no transactions or accounts, so it contributed nothing.

**2. Generic patterns:**

- Anthropic, OpenAI, Google, GitHub, Slack and AWS key shapes
- private-key blocks and bearer tokens
- EVM addresses and 64-hex transaction hashes or keys
- email addresses, Windows profile paths, this PC's name and this Windows user name
- real-looking provider response and request ID shapes (`msg_01…`, `resp_…`, `req_01…`, `chatcmpl-…`)
- seed-phrase hints

Known fictional values are allowed: `test-key-not-real…`, `example.com` and noreply addresses.

## Results

| Scope | Lines scanned | Hits | Evidence |
|---|---|---|---|
| `git diff a840ba7..1cc9fee` (round 2 as applied), added lines | 4,116 | **0** | `evidence/privacy-scan-branch-diff.json` |
| `git diff a840ba7..665439b` (the candidate's code commit), added lines | 4,249 | **0** | `evidence/privacy-scan-branch-diff-665439b.json` |
| The five reports as produced by the validation (committed in `63b60f1`): `README.md`, `REVIEW.md`, `LIMITS.md`, `COMMANDS.md`, `PRIVACY-SCAN.md` | about 470 | **0**: no record identifiers, keys, addresses, user or PC names, profile paths or emails | `evidence/privacy-scan-proposed-files.json` |
| The five reports after review preparation (this version), and `git diff a840ba7..63b60f1` | 691 and 4,721 | **0** | rescanned before the commit that adds this text |

**Complete branch diff.** It is scanned again after the last commit (`a840ba7` to the branch head), together with a reading of the diff and the commit metadata. The result is in the pull request description.

**Positive control.** The scan was run with a scratch file containing one real project ID, a fake key of the Anthropic shape and an EVM-style address. It reported all of them (5 hits across 5 checks), so a clean result means something. The scratch file was deleted afterwards.

**Not proposed for Git.** `evidence/` and `tools/` stay local. They contain this PC's paths, user and host names, process IDs and raw outputs. They were not scanned as Git candidates, and they hold no records, keys or provider responses: only fictional test and demo data.
