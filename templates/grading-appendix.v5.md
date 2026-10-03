<!-- CR-APPENDIX {{RUBRIC_VERSION}} {{SECTOR_PROFILE}} {{RECIPE_ID}} :: Append this to a cr-research-prompt@5 research prompt (Claude, ChatGPT or Gemini). -->
## Grading and output appendix ({{RUBRIC_VERSION}}, {{SECTOR_PROFILE}}, {{RECIPE_ID}})

Write the full report first. Then, at the very end, output **one** fenced code block marked `json` that follows the contract below. Fill in every field. If you do not know a value, use `null` and say why in the matching explanation field. Do not invent URLs, figures, dates, price levels or model versions to fill a field. The report and the JSON must agree: every score, verdict and date in the JSON is the one the report gives.

Write the JSON compactly, laid out as the skeleton is: one line per score, source, claim or fact, not one line per field. Keep each text field to one or two sentences; the report carries the detail.

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

**A. Category grades. Higher means better quality or opportunity.** Grade each of the {{CATEGORY_COUNT}} categories below, from 1 to 100. They are diagnostics: my dashboard shows them beside the investment grade and never averages them into it. Do not combine them into a total of your own.

{{DIAGNOSTIC_LIST}}

Each category grade is a score object (see below) with these extra fields:

- `confidence`: `high`, `medium` or `low`: how strong the evidence behind this grade is. `high`: it rests on primary sources you opened and dated. `medium`: a mix of primary evidence and secondary sources or project claims. `low`: mostly project claims, inference or thin data. `null` when the grade is unknown.
- `rationale`: the short explanation.
- `strongest_evidence`: the single strongest piece of evidence for this grade.
- `main_weakness`: its main weakness or open question.
- `would_raise` and `would_lower`: the observable development that would raise this grade, and the one that would lower it.
- `evidence_refs`: the claim or source IDs it rests on.

Unknown means unknown: use `"status": "unknown"` with no number, and say in `missing_data` what is missing. Missing evidence is not automatically evidence of failure: a low score needs evidence that points against the project, not merely an absence of evidence. `code_quality` is unknown when you could not read the source; `chart_structure` and `volume_liquidity` are unknown when reliable market data was not available.

**B. Investment components. Higher is better.** Score all six over the assessment horizon, {{HORIZON_START}} to {{HORIZON_END}}. My dashboard applies the weights and calculates the investment grade; do not weight them yourself.

{{COMPONENT_LIST}}

Some components cover ground that a category grade also covers (token value capture, valuation and supply, BTC-relative asymmetry, timing and liquidity). They are scored separately: the category grade is the diagnostic reading, the component is the input to the investment grade. Where the two differ, say why in the component's `rationale`.

If a component cannot be scored from evidence, mark it `unknown`: the dashboard then withholds the investment grade and shows how much of the weight was scored. That is a correct result, not a failure. In particular, when the scenarios carry no probabilities or no price ranges, score `btc_relative_asymmetry` only if the evidence still supports a judgment (a justified `range` is acceptable); otherwise mark it `unknown`. Never invent a probability or a price target to make a grade computable.

If you also give an overall number of your own, put it in `model_reported_overall_score`. It is stored next to the dashboard's calculation, never in place of it.

**C. Downside-risk panel. Higher means MORE risk.** Score `credit`, `dilution`, `liquidity` and `overall_downside`. `credit` is `not_applicable` outside credit and PayFi profiles. This panel is kept apart from panels A and B and is never averaged into them.

### Score objects

Every score uses this shape (category grades add the fields listed under panel A):

```
{"status": "scored", "value": 72, "low": null, "high": null, "rationale": "why", "evidence_refs": ["C3", "S2"], "missing_data": null}
```

- `status` is one of `scored`, `range`, `unknown`, `not_applicable`.
- `scored`: an integer from 1 to 100 in `value`.
- `range`: `low` and `high` (1–100), only when the evidence genuinely supports a band; justify it in `rationale`.
- `unknown`: `value` is null, and `missing_data` says what is missing.
- `not_applicable`: `value` is null, and `rationale` says why.

**Scale anchors for panels A and B (use them consistently):**

| Score | Meaning |
|---|---|
| 90–100 | Exceptional: strong, recent, independently checkable evidence |
| 75–89 | Strong: weaknesses identified and bounded |
| 60–74 | Mixed: real positives, material open questions |
| 40–59 | Weak: rests on claims, incentives or assumptions |
| 20–39 | Poor: evidence points against it |
| 1–19 | Severe concerns: disqualifying problems |

**Scale anchors for panel C (risk):**

| Score | Meaning |
|---|---|
| 90–100 | Extreme |
| 75–89 | High |
| 60–74 | Elevated |
| 40–59 | Moderate |
| 20–39 | Low |
| 1–19 | Minimal |

### Summary fields

- `summary`: the verdict's reason in two or three sentences.
- `bullish_facts`: the three strongest positives. `bearish_facts`: the three strongest risks.
- `conviction_increases`: the confirmation conditions: observable evidence that would confirm the opportunity. `invalidators`: what would invalidate it.
- `next_metric_to_monitor`: the single observable development that would most change the thesis (`metric`, `why`, `threshold`).
- `final_take`: your independent final judgment, five to eight sentences.

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
- `timing.next_review_date`: the date (YYYY-MM-DD, on or before {{HORIZON_END}}) to re-check this thesis. `timing.review_trigger`: the conditions that should prompt a review sooner.
- `long_term_note`: your view of the longer-term technology potential (section 3), kept separate from this position assessment; `null` only if you have none.
- Each item in `catalysts` also has `window_start` and `window_end` (YYYY-MM-DD or null), `certainty` (`unknown`, `project_claimed`, `source_documented`, `analyst_inferred`) and `in_horizon` (true, false or null).

### Development and code (`code_review`)

- `source_access`: `public`, `partial`, `none` or `unknown`: whether the code that powers the product can be read.
- `repositories`: every repository you examined: `url`, `role` (what it is in the product), `commit` (the commit or release tag you read; `null` if you read no code there), `files_inspected` (paths) and `observations` (what you found).
- `deployed_link`: `status` is `verified`, `partial`, `not_verified`, `not_applicable` or `unknown`: whether the code you read can be connected to what is deployed. `note`: how you know, or why it cannot be verified.
- `limitations`: what you could not inspect. This is a research assessment, not a security audit.

### Chart, volume and cycle (`chart_cycle`)

- `data`: `source`, `venue`, `pair`, `timeframes` (for example ["1W", "1D"]), `latest_observation_at` (the time of the latest candle or quote you used) and `limitations`. If reliable data was not available, say so in `limitations` and leave the rest `null`.
- `phase`: one of `unknown`, `launch`, `decline`, `base_formation`, `possible_accumulation`, `breakout`, `expansion`, `distribution`, `renewed_decline`. Use `unknown` when the evidence does not single one out. `phase_rationale`: why. `alternative_reading`: the competing interpretation of the same chart.
- `trend_vs_usd` and `trend_vs_btc`: one sentence each.
- `levels`: support and resistance you can show on the chart: `kind` (`support` or `resistance`), `price_usd`, `timeframe` and `basis` (what makes it a level). Leave the list empty rather than invent a level.
- `volume`: `baseline` (the explicit baseline you compared against), `reading` (what volume did relative to it) and `confirms_price` (true, false or null).
- `liquidity`: spot liquidity, spreads, depth and venue concentration, or `null` when not available.
- `confirmation` and `invalidation`: the observable conditions that would confirm a developing advance, and those that would invalidate it.
- `evidence_refs`: the claim or source IDs it rests on.

### Independent judgment (`independent_judgment`)

Your own view, from section 6. Each of `market_misunderstanding`, `overlooked_bull_case`, `overlooked_bear_case`, `technology_without_token`, `within_holding_period` and `advantage_over_btc` is an object:

- `view`: your answer.
- `label`: `judgment` when it is your reasoned reading of the evidence, `speculation` when it is a hypothesis the evidence does not yet support.
- `supporting_evidence`: claim or source IDs.
- `disconfirming_test`: the observation that would prove it wrong.

### Evidence

- List each source you used once in `sources`, with `source_id` S1, S2 and so on. Give the real URL, or null if you have none.
- `source_type` is exactly one of:
  - `official`: the project's own website, docs, blog, repository, governance forum or announcements.
  - `onchain_data`: a block explorer page (contract, transaction, holders) or an on-chain query (for example Dune), with its link.
  - `data_aggregator`: market or protocol data aggregators (CoinGecko, CoinMarketCap's data pages, DefiLlama, Token Terminal and similar).
  - `exchange`: an exchange's own page (listing, order book, announcement).
  - `audit`: an audit report, from the auditor or the project's repository.
  - `news`: journalism and press articles.
  - `research`: analyses and reports by third parties.
  - `social`: posts on X, Discord, Telegram, Reddit and similar.
  - `ai_summary`: an AI-generated summary or chatbot answer. It never supports `V`; avoid citing it.
  - `other`: anything else, including the dated context the dashboard supplied.
- List the material claims in `claims`: the ones a grade, a fact or a scenario rests on, usually 20 to 40, with `claim_id` C1, C2 and so on. Every `source_ids`, `evidence_refs`, `supporting_evidence` and `claim_ids` entry must point to an ID you listed.
  - `evidence_tag` is one of `V`, `C`, `I`, `S`:
    - `V`: verified in this session from a primary source (`official`, `onchain_data`, `audit` or `exchange`), with `as_of` and either `excerpt` (a short quote of the artifact) or `query` (the query, dashboard or explorer view you used). A secondary source supports `V` only for what it measures itself (an aggregator's price or volume). An official statement is `V` only as a statement; its substance is `C`.
    - `C`: project-claimed.
    - `I`: your inference, including what you know only from a secondary source.
    - `S`: speculative forecast.
  - `critical_kind`: for an audit, a deployment, realized fees or revenue, a supply change, live liquidity or a dated catalyst, one of `audit`, `deployment`, `realized_fees`, `supply_change`, `liquidity`, `catalyst`; otherwise `null`. A critical claim tagged `V` must cite a primary source and give `as_of`; realized fees and revenue also need `period` and `query`. If you cannot meet that, tag it `C` or `I` and say in `limitation` what would verify it.
  - For numeric claims, use a stable snake_case `metric_id` such as `revenue_usd`, `tvl_usd` or `payment_volume_usd`. Also give `value`, `unit`, `period`, `definition` and `as_of`.
- Facts, catalysts, unlocks and scenarios point back to claims through `claim_ids`.
- In `economics`, keep these separate: business revenue, volume, LP or participant income, and token-holder distributions.
- `scenarios`: in each case, `observations` lists what is observed today that the case builds on; `token_capture_assumption`, `supply_assumption` and `btc_assumption` are its assumptions; `business_outcome`, `price_range_usd`, `relative_return_vs_btc_pct` and `probability_pct` are forecasts. Probabilities and price ranges are subjective estimates, never verified facts.
  - `probability_pct`: a number only where you can defend it. When all three cases have one, they must total 100. Otherwise `null`, with the reason in `scenarios.probability_note`.
  - `price_range_usd` and `relative_return_vs_btc_pct`: `null` values are allowed, with the reason in `scenarios.target_note`.
  - Never force a total or a target. State `btc_relative_definition`.

### JSON skeleton (fill in every field; keep the keys exactly as written)

```json
{{JSON_SKELETON}}
```
