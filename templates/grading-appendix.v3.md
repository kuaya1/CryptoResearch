<!-- CR-APPENDIX {{RUBRIC_VERSION}} {{RECIPE_ID}} :: Append this to a cr-research-prompt@3 research prompt (Claude, ChatGPT or Gemini). -->
## Grading and output appendix ({{RUBRIC_VERSION}}, {{RECIPE_ID}})

Write the full report first. Then, at the very end, output **one** fenced code block marked `json` that follows the contract below. Fill in every field. If you do not know a value, use `null` and say why in the matching explanation field. Do not invent URLs, figures, dates or model versions to fill a field.

### Identity of this output

- `provider`: {{PROVIDER_VALUE}}
- `model_self_identification`: state which assistant you are, for example "Claude (Anthropic)", "ChatGPT (OpenAI)" or "Gemini (Google)".
- `model_version`: your exact model name and version only if you actually know it; otherwise `null`, with a note in `model_version_note`.
- `project_id`: {{PROJECT_ID_VALUE}}
- `research_run_id`: {{RUN_ID_VALUE}}
- `sector_profile`: {{SECTOR_PROFILE}}
- `rubric_version`: {{RUBRIC_VERSION}}
- `prompt_version`: {{PROMPT_VERSION}}
- `horizon`: {{HORIZON}}

### Three separate scoring panels

**A. Diagnostic scorecard. Higher is better.** Score each category below. These are diagnostics. Do not average them into an investment grade.

{{DIAGNOSTIC_LIST}}

**B. Investment components. Higher is better.** Score all six. My dashboard applies the weights; do not weight them yourself. Score them over the assessment horizon.

{{COMPONENT_LIST}}

If you also give an overall number of your own, put it in `model_reported_overall_score`. It is stored next to the dashboard's calculation, never in place of it.

**C. Downside-risk panel. Higher means MORE risk.** Score `credit`, `dilution`, `liquidity` and `overall_downside`. `credit` is `not_applicable` outside credit and PayFi profiles.

### Score objects

Every score uses this shape:

```
{"status": "scored", "value": 72, "low": null, "high": null, "rationale": "why", "evidence_refs": ["C3", "S2"], "missing_data": null}
```

- `status` is one of `scored`, `range`, `unknown`, `not_applicable`.
- `scored`: an integer from 1 to 100 in `value`.
- `range`: `low` and `high` (1–100), only when the evidence genuinely supports a band; justify it in `rationale`.
- `unknown`: `value` is null, and `missing_data` says what is missing.
- `not_applicable`: `value` is null, and `rationale` says why.

**Scale anchors for panels A and B:**

| Score | Meaning |
|---|---|
| 90–100 | Exceptional: strong, recent, independently checkable evidence |
| 75–89 | Strong: weaknesses identified and bounded |
| 60–74 | Mixed: real positives, material open questions |
| 40–59 | Weak: rests on claims, incentives or assumptions |
| 20–39 | Poor: evidence points against it |
| 1–19 | Severe: disqualifying problems |

**Scale anchors for panel C (risk):**

| Score | Meaning |
|---|---|
| 90–100 | Extreme |
| 75–89 | High |
| 60–74 | Elevated |
| 40–59 | Moderate |
| 20–39 | Low |
| 1–19 | Minimal |

### Position and timing (`position_context`)

Your own reading for this position horizon. It is shown next to your scores and changes none of them.

- `recipe`: "{{RECIPE_ID}}".
- `horizon`: copy exactly: mode "{{HORIZON_MODE}}", start "{{HORIZON_START}}", end "{{HORIZON_END}}".
- `market.state`: one of `unknown`, `bitcoin_led`, `broad_altcoin_participation`, `mixed`, `contracting`: how the market looks now, from dated evidence. Give `rationale` and `evidence_refs` (claim or source IDs). Use `unknown` when the evidence does not support a reading.
- `timing.state`: one of `unknown`, `early`, `developing`, `extended`, `thesis_impaired`.
  - `early`: the thesis has not started to play out; its catalysts lie ahead.
  - `developing`: evidence inside the horizon is starting to confirm it.
  - `extended`: much of the expected move or news already looks priced in.
  - `thesis_impaired`: evidence against the thesis has appeared.
  Give `rationale` and `evidence_refs`. This qualitative view is not a score.
- `timing.next_review_date`: the date (YYYY-MM-DD, on or before {{HORIZON_END}}) to re-check this thesis. `timing.review_trigger`: the condition that should prompt a review sooner.
- `long_term_note`: optional, any longer-term structural merit, kept separate from this position assessment; otherwise `null`.
- Each item in `catalysts` also has `window_start` and `window_end` (YYYY-MM-DD or null), `certainty` (`unknown`, `project_claimed`, `source_documented`, `analyst_inferred`) and `in_horizon` (true, false or null).

### Evidence

- List each source you used once in `sources`, with `source_id` S1, S2 and so on. Give the real URL, or null if you have none.
- List each material claim in `claims`, with `claim_id` C1, C2 and so on. Every `source_ids`, `evidence_refs` and `claim_ids` entry must point to an ID you listed.
  - `evidence_tag` is one of `V`, `C`, `I`, `S`:
    - `V`: checked in this session.
    - `C`: project-claimed.
    - `I`: your inference.
    - `S`: speculative forecast.
  - For numeric claims, use a stable snake_case `metric_id` such as `revenue_usd`, `tvl_usd` or `payment_volume_usd`. Also give `value`, `unit`, `period`, `definition` and `as_of`.
- Facts, catalysts and scenarios point back to claims through `claim_ids`.
- In `economics`, keep these separate: business revenue, volume, LP or participant income, and token-holder distributions.
- `scenarios.items`: probabilities must total 100. State `btc_relative_definition`.

### JSON skeleton (fill in every field; keep the keys exactly as written)

```json
{{JSON_SKELETON}}
```
