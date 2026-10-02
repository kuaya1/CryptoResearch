# Your original prompts

Save your original research prompts here exactly as you use them. The dashboard never edits your prompt files in this folder.

## What is here

- `huma-finance-run2-diligence.md`: your Huma Finance Run 2 diligence prompt, saved from chat on 2026-10-01. Version label for reports produced from it: `huma-run2-user-prompt@1`. It is PayFi-specific: use it only for payments, credit and receivables projects.

## How research prompts work now

- **Research runs** (dashboard "Research", Cowork, or `node dashboard/cli.js research add`) use the canonical prompt `templates/research-prompt.v2.md` (`cr-research-prompt@2`) with the grading appendix `templates/grading-appendix.v2.md` and the project's own scoring profile. Every model in a run gets the identical prompt text and the same dated evidence packet.
- **Scoring profiles** live in `templates/rubrics/`:
  - `payfi-credit@1` carries the structure of your HUMA prompt: the 11 diagnostic categories, the 6 weighted components, the research sections, the six verdict labels, the [V]/[C]/[I]/[S] evidence tags, and the separation of business activity, LP income and token-holder economics.
  - `network-infrastructure@1` (Allora-type projects) and `general-token@1` cover everything else.

  The PayFi profile is never applied to a project that is not PayFi.
- **Your own prompt, used by hand:** append the matching standalone appendix from `templates/appendix/` so every model returns the same JSON contract. Reports produced without an appendix are still importable as prose reports: clearly labeled scores are extracted and everything else stays unknown. Mark them with `report correct … --field rubric_version --value huma-run2-user-prompt@1` so they are compared only with each other. A rubric version that is not pinned in `templates/rubrics/RUBRIC-LOCK.json` never gets an authoritative app grade; its scores are shown as the model wrote them.

Files in this folder are prompts, not reports. If one is dropped into an inbox by mistake, it is recognized as a prompt and not imported.
