# Example PayFi Protocol (XMPL): research report

> **FICTIONAL TEST FIXTURE.** Every name, number, score and URL in this file is invented to test the CryptoResearch dashboard. It is not research, was not produced by any AI model, and says nothing about any real project or token.

Analysis date: 2026-09-24 · Horizon: 24 months · Profile: payfi-credit@1

## 1. Legitimacy and security
Fictional team with a named operating entity [C]. Two audits listed in the docs [C]; one audit report opened and its scope covers the lending pools [V].

## 2. Product mechanics
Liquidity providers fund short-dated receivables; borrowers repay in stablecoins.

## 3. Yield and credit forensics
Business activity, LP income and token-holder economics are separate here. Payment financing volume was $41.0M over 30 days [C]. Protocol revenue was $410k over the same period [V]. Nothing currently flows to token holders [V].

## 4–8. (abbreviated in this fixture)

## 9. BTC-relative scenarios
Bull 25%, base 50%, bear 25%. Definition: token return minus BTC return over 24 months, in percentage points.

## 10. Final grading and verdict
Verdict: CONDITIONAL OPPORTUNITY

```json
{
  "schema_version": "cr.report.v1",
  "report_id": null,
  "project_id": "example-payfi-fictional",
  "project_name": "Example PayFi Protocol (FICTIONAL)",
  "project_symbol": "XMPL",
  "provider": "claude",
  "model_self_identification": "FICTIONAL FIXTURE labeled as Claude for testing",
  "model_version": null,
  "model_version_note": "Fixture: no model produced this file.",
  "analysis_at": "2026-09-24",
  "horizon": "24 months",
  "prompt_version": "cr-research-prompt@1",
  "rubric_version": "cr-grading@1",
  "sector_profile": "payfi-credit@1",
  "verdict": "CONDITIONAL OPPORTUNITY",
  "summary": "FICTIONAL: real product with a weakly connected token; fee switch only announced.",
  "diagnostic_scores": {
    "legitimacy": {"status": "scored", "value": 72, "low": null, "high": null, "rationale": "Fictional: audits exist, entity named.", "evidence_refs": ["S1"], "missing_data": null},
    "builder_operations": {"status": "scored", "value": 68, "low": null, "high": null, "rationale": "Fictional: steady shipping.", "evidence_refs": [], "missing_data": null},
    "product_usefulness": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional: receivables financing used by merchants.", "evidence_refs": ["C1"], "missing_data": null},
    "organic_demand": {"status": "scored", "value": 55, "low": null, "high": null, "rationale": "Fictional: volume partly incentive-driven.", "evidence_refs": ["C1"], "missing_data": null},
    "credit_risk_transparency": {"status": "scored", "value": 58, "low": null, "high": null, "rationale": "Fictional: default data published monthly.", "evidence_refs": [], "missing_data": null},
    "differentiation": {"status": "scored", "value": 62, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "category_potential": {"status": "scored", "value": 75, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "token_value_capture": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional: no implemented capture; fee switch announced.", "evidence_refs": ["C3"], "missing_data": null},
    "valuation_supply_attractiveness": {"status": "scored", "value": 48, "low": null, "high": null, "rationale": "Fictional: large unlock ahead.", "evidence_refs": ["C4"], "missing_data": null},
    "chart_quality": {"status": "scored", "value": 45, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "evidence_confidence": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional: mix of checked and claimed data.", "evidence_refs": [], "missing_data": null}
  },
  "investment_components": {
    "sustainable_business_demand": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C1"], "missing_data": null},
    "token_value_capture": {"status": "scored", "value": 55, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C3"], "missing_data": null},
    "valuation_supply": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C4"], "missing_data": null},
    "risk_resilience": {"status": "scored", "value": 65, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "btc_relative_asymmetry": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "timing_executable_liquidity": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "model_reported_overall_score": {"status": "scored", "value": 61, "low": null, "high": null, "rationale": "Fictional model total.", "evidence_refs": [], "missing_data": null},
  "risk_scores": {
    "credit": {"status": "scored", "value": 55, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "dilution": {"status": "scored", "value": 65, "low": null, "high": null, "rationale": "Fictional: 8% unlock in November.", "evidence_refs": ["C4"], "missing_data": null},
    "liquidity": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "overall_downside": {"status": "scored", "value": 58, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "sources": [
    {"source_id": "S1", "url": "https://example.com/xmpl/docs", "title": "Fictional XMPL docs", "publisher": "Example", "source_type": "official", "accessed_at": "2026-09-24"},
    {"source_id": "S2", "url": "https://example.org/xmpl-dashboard", "title": "Fictional on-chain dashboard", "publisher": "Example", "source_type": "onchain_data", "accessed_at": "2026-09-24"}
  ],
  "claims": [
    {"claim_id": "C1", "text": "Fictional: $41.0M of payment financing processed in the 30 days ending 2026-09-20.", "evidence_tag": "C", "source_ids": ["S2"], "metric_id": "payment_volume_usd", "value": 41000000, "unit": "USD", "definition": "Gross receivables financed", "period": "30d ending 2026-09-20", "as_of": "2026-09-20", "limitation": "Project dashboard", "section": "yield_credit_forensics"},
    {"claim_id": "C2", "text": "Fictional: protocol revenue of $410k over the same 30 days.", "evidence_tag": "V", "source_ids": ["S2"], "metric_id": "protocol_revenue_usd", "value": 410000, "unit": "USD", "definition": "Fees retained by the protocol", "period": "30d ending 2026-09-20", "as_of": "2026-09-20", "limitation": null, "section": "yield_credit_forensics"},
    {"claim_id": "C3", "text": "Fictional: no buyback or fee share is implemented; a fee switch is announced for Q1 2027.", "evidence_tag": "V", "source_ids": ["S1"], "metric_id": null, "value": null, "unit": null, "definition": null, "period": null, "as_of": "2026-09-24", "limitation": null, "section": "token_capture_valuation"},
    {"claim_id": "C4", "text": "Fictional: team unlock of 8% of supply on 2026-11-15.", "evidence_tag": "C", "source_ids": ["S1"], "metric_id": "unlock_pct_supply", "value": 8, "unit": "% of supply", "definition": "Scheduled unlock", "period": "2026-11-15", "as_of": "2026-09-24", "limitation": "Potential liquid supply, not demonstrated sales", "section": "current_tokenomics"}
  ],
  "bullish_facts": [{"text": "Fictional: revenue-generating product.", "claim_ids": ["C2"]}, {"text": "Fictional: audits cover the pools.", "claim_ids": []}, {"text": "Fictional: growing category.", "claim_ids": []}],
  "bearish_facts": [{"text": "Fictional: no implemented token capture.", "claim_ids": ["C3"]}, {"text": "Fictional: 8% unlock in November.", "claim_ids": ["C4"]}, {"text": "Fictional: weak chart.", "claim_ids": []}],
  "conviction_increases": [{"text": "Fictional: fee switch implemented on-chain.", "claim_ids": []}, {"text": "Fictional: volume grows without incentives.", "claim_ids": []}, {"text": "Fictional: default rate stays below 2%.", "claim_ids": []}],
  "invalidators": [{"text": "Fictional: default rate above 5% in any quarter.", "claim_ids": []}, {"text": "Fictional: fee switch cancelled.", "claim_ids": []}, {"text": "Fictional: volume falls 50% after incentives end.", "claim_ids": []}],
  "catalysts": [{"title": "Fictional team unlock (8% of supply)", "date": "2026-11-15", "date_precision": "day", "kind": "unlock", "status": "announced", "claim_ids": ["C4"]}],
  "unlocks": [{"date": "2026-11-15", "amount_tokens": 80000000, "pct_of_supply": 8, "recipient_class": "team", "note": "Potential liquid supply, not demonstrated sales.", "claim_ids": ["C4"]}],
  "tokenomics_changes": [{"description": "Fictional fee switch sending 20% of fees to stakers", "status": "announced", "announced_at": "2026-08-30", "effective_at": null, "claim_ids": ["C3"]}],
  "economics": {
    "business_revenue": {"status": "reported", "value": 410000, "unit": "USD", "period": "30d ending 2026-09-20", "definition": "Fees retained by the protocol", "as_of": "2026-09-20", "evidence_tag": "V", "claim_ids": ["C2"], "note": null},
    "payment_volume": {"status": "reported", "value": 41000000, "unit": "USD", "period": "30d ending 2026-09-20", "definition": "Gross receivables financed", "as_of": "2026-09-20", "evidence_tag": "C", "claim_ids": ["C1"], "note": "Volume is not revenue."},
    "lp_yield": {"status": "unknown", "value": null, "unit": null, "period": null, "definition": "Return paid to LPs", "as_of": null, "evidence_tag": null, "claim_ids": [], "note": "Not found in a checkable source."},
    "token_holder_distributions": {"status": "reported", "value": 0, "unit": "USD", "period": "since launch", "definition": "Value distributed to token holders", "as_of": "2026-09-24", "evidence_tag": "V", "claim_ids": ["C3"], "note": "No mechanism implemented."}
  },
  "scenarios": {
    "btc_relative_definition": "Token return minus BTC return over the same 24 months, in percentage points.",
    "items": [
      {"case": "bull", "probability_pct": 25, "business_outcome": "Fictional: volume triples", "token_capture_assumption": "Fee switch live", "supply_assumption": "Unlocks absorbed", "price_range_usd": {"low": 0.6, "high": 1.0}, "btc_assumption": "BTC +40%", "relative_return_vs_btc_pct": {"low": 80, "high": 200}, "invalidation": "Fee switch cancelled"},
      {"case": "base", "probability_pct": 50, "business_outcome": "Fictional: steady growth", "token_capture_assumption": "Fee switch late", "supply_assumption": "Some unlock selling", "price_range_usd": {"low": 0.25, "high": 0.45}, "btc_assumption": "BTC +20%", "relative_return_vs_btc_pct": {"low": -20, "high": 30}, "invalidation": "Volume decline"},
      {"case": "bear", "probability_pct": 25, "business_outcome": "Fictional: credit event", "token_capture_assumption": "None", "supply_assumption": "Heavy unlock selling", "price_range_usd": {"low": 0.05, "high": 0.15}, "btc_assumption": "BTC flat", "relative_return_vs_btc_pct": {"low": -85, "high": -60}, "invalidation": "Defaults stay low"}
    ]
  },
  "next_metric_to_monitor": {"metric": "Fictional: 30-day protocol revenue net of incentives", "why": "Tests organic demand", "threshold": "Above $500k"},
  "final_take": "FICTIONAL fixture: a working product whose token does not yet capture value.",
  "unresolved_questions": ["Fictional: will the fee switch pass governance?", "Fictional: what share of volume is incentivized?"],
  "original_report_reference": {"note": "Fixture prose above."}
}
```
