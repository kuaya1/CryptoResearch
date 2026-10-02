<!-- CR-APPENDIX cr-grading@1 :: Append this to any research prompt (Claude, ChatGPT or Gemini). -->
## Grading and output appendix (cr-grading@1)

Write the full report first. Then, at the very end, output **one** fenced code block marked `json` that follows the contract below. Fill in every field. If you do not know a value, use `null` and say why in the matching explanation field. Do not invent URLs, figures, dates or model versions to fill a field.

### Identity of this output

- `provider`: `null` (the dashboard sets it from the inbox folder you drop the report into: claude, chatgpt or gemini)
- `model_self_identification`: state which assistant you are, for example "Claude (Anthropic)", "ChatGPT (OpenAI)" or "Gemini (Google)".
- `model_version`: your exact model name and version only if you actually know it; otherwise `null`, with a note in `model_version_note`.
- `project_id`: `null` unless you were given one
- `sector_profile`: network-infrastructure@1
- `rubric_version`: cr-grading@1
- `prompt_version`: the version of the prompt you were given, or null
- `horizon`: 24 months

### Three separate scoring panels

**A. Diagnostic scorecard. Higher is better.** Score each category below. These are diagnostics. Do not average them into an investment grade.

- `legitimacy` (Legitimacy): Is this a real, accountable organization operating the network it claims: identifiable team or foundation, audits, security history, regulatory posture, and no misrepresentation.
- `builder_operations` (Builder and operational quality): Shipping record, network uptime and incident handling, governance and treasury management.
- `product_usefulness` (Product usefulness): Does the network deliver a service (inference, compute, data, settlement) that real users choose over centralized alternatives, independent of token incentives?
- `organic_demand` (Organic demand): Paid usage and fees that persist net of token incentives, grants and self-dealing between related participants.
- `credit_risk_transparency` (Credit-risk transparency): **not_applicable** in network-infrastructure@1. Not applicable under network-infrastructure@1: the network does not underwrite credit. See technical_risk_transparency, which is a different dimension.
- `technical_risk_transparency` (Technical-risk transparency): Quality of disclosure on technical and network risks: audits and their scope, incident history, admin keys and upgradeability, validator or operator concentration, reliance on centralized components, and security budget.
- `differentiation` (Competitive differentiation): Durable advantages over competing networks and centralized providers (cost, quality, latency, openness, network effects).
- `category_potential` (Category potential): Size and growth of the addressable market for the network's service and how much of it can plausibly use decentralized infrastructure within the horizon.
- `token_value_capture` (Token value capture): Diagnostic view of how network usage reaches token holders as implemented today (fees paid in or burned in the token, staking yield funded by fees, required collateral). Emissions-funded rewards are not value capture. Announced but unimplemented mechanisms are conditional.
- `valuation_supply_attractiveness` (Valuation and supply attractiveness): Current market cap and FDV relative to fees, usage and peers, adjusted for circulating supply, unlocks (potential liquid supply) and emissions.
- `chart_quality` (Chart quality): Quality of market structure: trend, support and resistance, volume confirmation, drawdown from highs, and relative strength versus BTC.
- `evidence_confidence` (Evidence confidence): Quality, recency and independence of the evidence behind this report. It is not a probability of profit and not a multiplier on any grade.

**B. Investment components. Higher is better.** Score all six. My dashboard applies the weights; do not weight them yourself.

- `sustainable_business_demand`: durable demand that persists without token incentives.
- `token_value_capture`: how directly business success accrues to holders, as implemented today.
- `valuation_supply`: valuation versus revenue and peers after supply, unlocks and emissions.
- `risk_resilience`: ability to withstand adverse events. This is a separate judgement and is NOT 100 minus overall downside risk.
- `btc_relative_asymmetry`: probability-weighted upside versus downside relative to holding BTC.
- `timing_executable_liquidity`: whether a spot position can be entered and exited at reasonable cost now, and near-term timing.

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

### Evidence

- List each source you used once in `sources`, with `source_id` S1, S2 and so on. Give the real URL, or null if you have none.
- List each material claim in `claims`, with `claim_id` C1, C2 and so on.
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
{
  "schema_version": "cr.report.v1",
  "report_id": null,
  "project_id": null,
  "project_name": null,
  "project_symbol": null,
  "provider": null,
  "model_self_identification": null,
  "model_version": null,
  "model_version_note": null,
  "analysis_at": null,
  "horizon": "24 months",
  "prompt_version": "cr-research-prompt@1",
  "rubric_version": "cr-grading@1",
  "sector_profile": "network-infrastructure@1",
  "verdict": null,
  "summary": null,
  "diagnostic_scores": {
    "legitimacy": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "builder_operations": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "product_usefulness": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "organic_demand": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "credit_risk_transparency": {
      "status": "not_applicable",
      "value": null,
      "low": null,
      "high": null,
      "rationale": "Not applicable under network-infrastructure@1: the network does not underwrite credit. See technical_risk_transparency, which is a different dimension.",
      "evidence_refs": [],
      "missing_data": null
    },
    "technical_risk_transparency": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "differentiation": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "category_potential": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "token_value_capture": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "valuation_supply_attractiveness": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "chart_quality": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "evidence_confidence": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."}
  },
  "investment_components": {
    "sustainable_business_demand": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "token_value_capture": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "valuation_supply": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "risk_resilience": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "btc_relative_asymmetry": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "timing_executable_liquidity": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."}
  },
  "model_reported_overall_score": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
  "risk_scores": {
    "credit": {"status":"not_applicable","value":null,"low":null,"high":null,"rationale":"No credit underwriting in network-infrastructure@1.","evidence_refs":[],"missing_data":null},
    "dilution": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "liquidity": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."},
    "overall_downside": {"status":"unknown","value":null,"low":null,"high":null,"rationale":"","evidence_refs":[],"missing_data":"Not assessed yet: replace with a score, or explain what is missing."}
  },
  "sources": [{"source_id":"S1","url":null,"title":null,"publisher":null,"source_type":null,"accessed_at":null}],
  "claims": [{"claim_id":"C1","text":"","evidence_tag":"V","source_ids":[],"metric_id":null,"value":null,"unit":null,"definition":null,"period":null,"as_of":null,"limitation":null,"section":null}],
  "bullish_facts": [{"text":"","claim_ids":[]},{"text":"","claim_ids":[]},{"text":"","claim_ids":[]}],
  "bearish_facts": [{"text":"","claim_ids":[]},{"text":"","claim_ids":[]},{"text":"","claim_ids":[]}],
  "conviction_increases": [{"text":"","claim_ids":[]},{"text":"","claim_ids":[]},{"text":"","claim_ids":[]}],
  "invalidators": [{"text":"","claim_ids":[]},{"text":"","claim_ids":[]},{"text":"","claim_ids":[]}],
  "catalysts": [{"title":"","date":null,"date_precision":null,"kind":null,"status":null,"claim_ids":[]}],
  "unlocks": [{"date":null,"amount_tokens":null,"pct_of_supply":null,"recipient_class":null,"note":"Potential liquid supply, not demonstrated sales.","claim_ids":[]}],
  "tokenomics_changes": [{"description":"","status":null,"announced_at":null,"effective_at":null,"claim_ids":[]}],
  "economics": {
    "protocol_revenue": {"status":"unknown","value":null,"unit":null,"period":null,"definition":"Fees paid by users of the network's service over a stated period. Not emissions.","as_of":null,"evidence_tag":null,"claim_ids":[],"note":null},
    "network_usage": {"status":"unknown","value":null,"unit":null,"period":null,"definition":"Requests, jobs or transactions served, with definition and period.","as_of":null,"evidence_tag":null,"claim_ids":[],"note":null},
    "participant_rewards": {
      "status": "unknown",
      "value": null,
      "unit": null,
      "period": null,
      "definition": "Rewards paid to operators, workers or validators, split into fee-funded and emissions-funded.",
      "as_of": null,
      "evidence_tag": null,
      "claim_ids": [],
      "note": null
    },
    "token_holder_distributions": {
      "status": "unknown",
      "value": null,
      "unit": null,
      "period": null,
      "definition": "Value actually distributed to or burned for token holders over a stated period. Emissions are not distributions.",
      "as_of": null,
      "evidence_tag": null,
      "claim_ids": [],
      "note": null
    },
    "staking_yield": {
      "status": "unknown",
      "value": null,
      "unit": null,
      "period": null,
      "definition": "Nominal staking yield and its source (fees versus emissions), and the real yield after dilution.",
      "as_of": null,
      "evidence_tag": null,
      "claim_ids": [],
      "note": null
    }
  },
  "scenarios": {
    "btc_relative_definition": null,
    "items": [
      {
        "case": "bull",
        "probability_pct": null,
        "business_outcome": null,
        "token_capture_assumption": null,
        "supply_assumption": null,
        "price_range_usd": {"low":null,"high":null},
        "btc_assumption": null,
        "relative_return_vs_btc_pct": {"low":null,"high":null},
        "invalidation": null
      },
      {
        "case": "base",
        "probability_pct": null,
        "business_outcome": null,
        "token_capture_assumption": null,
        "supply_assumption": null,
        "price_range_usd": {"low":null,"high":null},
        "btc_assumption": null,
        "relative_return_vs_btc_pct": {"low":null,"high":null},
        "invalidation": null
      },
      {
        "case": "bear",
        "probability_pct": null,
        "business_outcome": null,
        "token_capture_assumption": null,
        "supply_assumption": null,
        "price_range_usd": {"low":null,"high":null},
        "btc_assumption": null,
        "relative_return_vs_btc_pct": {"low":null,"high":null},
        "invalidation": null
      }
    ]
  },
  "next_metric_to_monitor": {"metric":null,"why":null,"threshold":null},
  "final_take": null,
  "unresolved_questions": [],
  "original_report_reference": {"note":"The written report above this JSON block is the original."}
}
```
