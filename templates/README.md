# Templates

| File | What it is |
|---|---|
| `research-prompt.v1.md` | The research prompt body. `{{PLACEHOLDERS}}` are filled per project, and each project gets its own copy in `projects/<id>/prompts/`. |
| `grading-appendix.v1.md` | The grading and output appendix template. It contains the shared JSON contract every provider must return. |
| `appendix/grading-appendix.<profile>.v1.md` | A ready-to-use appendix for each sector profile. Append it to any prompt of your own (for example your original Huma prompt). Then set `provider`, or leave it null; the inbox folder decides. |
| `rubrics/cr-grading.v1.json` | The six investment components and their weights (20/25/20/15/10/10), the grade labels, the downside-risk panel, the scale anchors and the rules. |
| `rubrics/payfi-credit.v1.json` | The 11 diagnostic categories from the PayFi template, including credit-risk transparency, plus the 10 research sections and the economics fields. |
| `rubrics/network-infrastructure.v1.json` | For AI, DePIN, L1/L2, oracle and compute networks. Credit-risk transparency is N/A here; `technical_risk_transparency` has its own definition and is not comparable with credit scores. |
| `rubrics/general-token.v1.json` | The fallback profile. Credit is N/A; `protocol_risk_transparency` is its own dimension. |
| `schemas/*.schema.json` | JSON Schemas for reports, projects, transactions, requests, journal entries and events. |
| `source-prompts/` | Your original prompts, kept as you wrote them. |

## Versioning

Never edit a published version in place: older reports declare which version they were graded under, and their meaning must not change underneath them. To change wording, weights or categories:

1. Copy the file to the next version (for example `research-prompt.v2.md` or `payfi-credit.v2.json`).
2. Change the `@` reference inside it (for example `payfi-credit@2`).
3. Point new prompts at the new version.

Reports graded under different rubric or profile versions are shown side by side but are never compared numerically.
