# Example PayFi Protocol (XMPL)

> **FICTIONAL TEST FIXTURE.** Every name, number, score and URL in this file is invented to test the CryptoResearch dashboard. It is not research, was not produced by any AI model, and says nothing about any real project or token.

Analysis date: 2026-09-28 · Horizon: 24 months

This fixture is the most bearish. It leaves BTC-relative asymmetry unscored (no credible valuation evidence), so the dashboard must withhold the investment grade and show 90% weight coverage. Its scenario probabilities total 95% on purpose, which should be flagged. It reports payment volume over 90 days instead of 30 days, which is a different measurement period and not a contradiction.

Verdict: REAL PRODUCT, WEAK TOKEN

```json
{
  "schema_version": "cr.report.v1",
  "report_id": null,
  "project_id": "example-payfi-fictional",
  "project_name": "Example PayFi Protocol (FICTIONAL)",
  "project_symbol": "XMPL",
  "provider": "gemini",
  "model_self_identification": "FICTIONAL FIXTURE labeled as Gemini for testing",
  "model_version": null,
  "model_version_note": "Fixture: no model produced this file.",
  "analysis_at": "2026-09-28",
  "horizon": "24 months",
  "prompt_version": "cr-research-prompt@1",
  "rubric_version": "cr-grading@1",
  "sector_profile": "payfi-credit@1",
  "verdict": "REAL PRODUCT, WEAK TOKEN",
  "summary": "FICTIONAL: bearish fixture with an unscored component.",
  "diagnostic_scores": {
    "legitimacy": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "builder_operations": {"status": "range", "value": null, "low": 55, "high": 65, "rationale": "Fictional: limited operating history, so a band.", "evidence_refs": [], "missing_data": null},
    "product_usefulness": {"status": "scored", "value": 66, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "organic_demand": {"status": "scored", "value": 40, "low": null, "high": null, "rationale": "Fictional: most volume is incentivized.", "evidence_refs": ["C1"], "missing_data": null},
    "credit_risk_transparency": {"status": "scored", "value": 45, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C2"], "missing_data": null},
    "differentiation": {"status": "scored", "value": 58, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "category_potential": {"status": "scored", "value": 72, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "token_value_capture": {"status": "scored", "value": 30, "low": null, "high": null, "rationale": "Fictional: nothing implemented; announcements do not count.", "evidence_refs": ["C3"], "missing_data": null},
    "valuation_supply_attractiveness": {"status": "scored", "value": 42, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "chart_quality": {"status": "scored", "value": 40, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "evidence_confidence": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "investment_components": {
    "sustainable_business_demand": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "token_value_capture": {"status": "scored", "value": 35, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C3"], "missing_data": null},
    "valuation_supply": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "risk_resilience": {"status": "scored", "value": 55, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "btc_relative_asymmetry": {"status": "unknown", "value": null, "low": null, "high": null, "rationale": "", "evidence_refs": [], "missing_data": "Fictional: no credible valuation evidence, so asymmetry is unproven."},
    "timing_executable_liquidity": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "model_reported_overall_score": {"status": "unknown", "value": null, "low": null, "high": null, "rationale": "", "evidence_refs": [], "missing_data": "Fictional: no overall given because a component is unknown."},
  "risk_scores": {
    "credit": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C2"], "missing_data": null},
    "dilution": {"status": "scored", "value": 75, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "liquidity": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "overall_downside": {"status": "scored", "value": 68, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "sources": [
    {"source_id": "S1", "url": "https://example.com/xmpl/docs", "title": "Fictional XMPL docs", "publisher": "Example", "source_type": "official", "accessed_at": "2026-09-28"},
    {"source_id": "S4", "url": "https://example.edu/credit-study", "title": "Fictional credit study", "publisher": "Example University", "source_type": "research", "accessed_at": "2026-09-28"}
  ],
  "claims": [
    {"claim_id": "C1", "text": "Fictional: $118M of payment financing over the 90 days ending 2026-09-25.", "evidence_tag": "C", "source_ids": ["S1"], "metric_id": "payment_volume_usd", "value": 118000000, "unit": "USD", "definition": "Gross receivables financed", "period": "90d ending 2026-09-25", "as_of": "2026-09-25", "limitation": "Project-reported", "section": "adoption_unit_economics"},
    {"claim_id": "C2", "text": "Fictional: default rate of 1.9% of originated volume since launch.", "evidence_tag": "V", "source_ids": ["S4"], "metric_id": "default_rate_pct", "value": 1.9, "unit": "%", "definition": "Defaults / originated volume", "period": "since launch", "as_of": "2026-09-25", "limitation": null, "section": "yield_credit_forensics"},
    {"claim_id": "C3", "text": "Fictional: the fee switch is announced, not implemented.", "evidence_tag": "V", "source_ids": ["S1"], "metric_id": null, "value": null, "unit": null, "definition": null, "period": null, "as_of": "2026-09-28", "limitation": null, "section": "token_capture_valuation"},
    {"claim_id": "C4", "text": "Fictional: a 2025 audit flagged an admin key that can pause withdrawals.", "evidence_tag": "V", "source_ids": ["S1"], "metric_id": null, "value": null, "unit": null, "definition": null, "period": null, "as_of": "2025-06-01", "limitation": "Old finding; status of fix unknown", "section": "legitimacy_security"}
  ],
  "bullish_facts": [{"text": "Fictional: real borrowers repay.", "claim_ids": ["C2"]}, {"text": "Fictional: steady origination.", "claim_ids": ["C1"]}, {"text": "Fictional: credible team.", "claim_ids": []}],
  "bearish_facts": [{"text": "Fictional: token captures nothing today.", "claim_ids": ["C3"]}, {"text": "Fictional: admin pause key.", "claim_ids": ["C4"]}, {"text": "Fictional: heavy unlocks.", "claim_ids": []}],
  "conviction_increases": [{"text": "Fictional: fee switch live with on-chain distributions.", "claim_ids": []}, {"text": "Fictional: admin key removed.", "claim_ids": []}, {"text": "Fictional: organic share of volume above 70%.", "claim_ids": []}],
  "invalidators": [{"text": "Fictional: a pool default above 5%.", "claim_ids": []}, {"text": "Fictional: incentives extended indefinitely.", "claim_ids": []}, {"text": "Fictional: treasury sells into unlocks.", "claim_ids": []}],
  "catalysts": [],
  "unlocks": [{"date": "2026-11-15", "amount_tokens": 80000000, "pct_of_supply": 8, "recipient_class": "team", "note": "Potential liquid supply, not demonstrated sales.", "claim_ids": []}],
  "tokenomics_changes": [{"description": "Fictional fee switch", "status": "announced", "announced_at": "2026-08-30", "effective_at": null, "claim_ids": ["C3"]}],
  "economics": {
    "payment_volume": {"status": "reported", "value": 118000000, "unit": "USD", "period": "90d ending 2026-09-25", "definition": "Gross receivables financed", "as_of": "2026-09-25", "evidence_tag": "C", "claim_ids": ["C1"], "note": "Different period from the other fixtures."},
    "credit_losses": {"status": "reported", "value": 1.9, "unit": "% of originated", "period": "since launch", "definition": "Defaults / originated volume", "as_of": "2026-09-25", "evidence_tag": "V", "claim_ids": ["C2"], "note": null},
    "token_holder_distributions": {"status": "reported", "value": 0, "unit": "USD", "period": "since launch", "definition": "Value distributed to holders", "as_of": "2026-09-28", "evidence_tag": "V", "claim_ids": ["C3"], "note": null}
  },
  "scenarios": {
    "btc_relative_definition": "Token return minus BTC return over 24 months, percentage points.",
    "items": [
      {"case": "bull", "probability_pct": 25, "business_outcome": "Fictional", "token_capture_assumption": "Fee switch live", "supply_assumption": "Absorbed", "price_range_usd": {"low": 0.5, "high": 0.8}, "btc_assumption": "BTC +40%", "relative_return_vs_btc_pct": {"low": 40, "high": 120}, "invalidation": "Fictional"},
      {"case": "base", "probability_pct": 50, "business_outcome": "Fictional", "token_capture_assumption": "None yet", "supply_assumption": "Selling", "price_range_usd": {"low": 0.15, "high": 0.3}, "btc_assumption": "BTC +20%", "relative_return_vs_btc_pct": {"low": -60, "high": -10}, "invalidation": "Fictional"},
      {"case": "bear", "probability_pct": 20, "business_outcome": "Fictional", "token_capture_assumption": "None", "supply_assumption": "Heavy selling", "price_range_usd": {"low": 0.03, "high": 0.1}, "btc_assumption": "BTC flat", "relative_return_vs_btc_pct": {"low": -95, "high": -75}, "invalidation": "Fictional"}
    ]
  },
  "next_metric_to_monitor": {"metric": "Fictional: share of volume without incentives", "why": "Organic demand test", "threshold": "Above 60%"},
  "final_take": "FICTIONAL fixture: useful product, token not yet investable on value capture.",
  "unresolved_questions": ["Fictional: has the admin pause key been removed?", "Fictional: what is volume excluding incentive programs?"],
  "original_report_reference": {"note": "Fixture prose above."}
}
```
