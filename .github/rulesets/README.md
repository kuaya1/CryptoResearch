# Merge boundary rulesets

These three files are the GitHub repository rulesets on `main` and the
ledger branch. Eric applies them; no workflow does. Until he applies a
change, it is only a file.

Since the agent lane was retired (Eric, 2026-10-27; `docs/CONSTITUTION.md`,
`audits/2026-10-27-de-escalation`), `test` is the one required check. The
`automation-branches` ruleset, which fenced the builder App and the workflow
token off every other branch, is gone with them.

| File | What it enforces | Bypass |
|---|---|---|
| `main-merge-authority.json` | Nobody may update `main` (the `update` rule). | Repository admin role, **pull request only**. That is Eric, merging a pull request. |
| `main-merge-requirements.json` | Every change to `main` comes through a pull request. Only merge commits are allowed. The head must be up to date with `main` (strict). `test` must pass, from GitHub Actions (app 15368). No force push and no deletion. Zero approvals required. | None, not even Eric. |
| `agent-ledger.json` | The ledger branch of the retired lane's paid attempts can be appended to, but never rewritten or deleted. It stays as history. | None |

Conditions:

- **Public, or private on GitHub Pro.** On GitHub Free a private repository
  gets HTTP 403 "Upgrade to GitHub Pro or make this repository public" from
  the rulesets API, and the rulesets are not enforced. `kuaya1` is on GitHub
  Pro since 2026-10-27, and the repository is private.
- **Eric stays the only admin.** Any other admin, or any token holding Eric's
  admin access, can merge. That includes local Claude sessions using his `gh`
  login, which is why they never merge.

## Apply (Eric)

A changed file goes up by its ruleset's ID, never as a second ruleset. Keep
the live copy first, out of the repository, for the rollback:

```powershell
gh api repos/kuaya1/CryptoResearch/rulesets --jq '.[] | [.id, .name] | @tsv'
gh api repos/kuaya1/CryptoResearch/rulesets/<id> --jq '{name,target,enforcement,conditions,rules,bypass_actors}' > <name>.before.json
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/<id> --input .github/rulesets/<name>.json
```

## Roll back (Eric)

```powershell
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/<id> --input <name>.before.json
gh api -X PUT repos/kuaya1/CryptoResearch/rulesets/<id> -f enforcement=disabled
```

Disabling keeps the ruleset for re-enabling (`-f enforcement=active`).
