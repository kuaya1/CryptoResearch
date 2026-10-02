# Example PayFi Protocol (XMPL): investment research

> **FICTIONAL TEST FIXTURE.** Every name, number, score and URL in this file is invented to test the CryptoResearch dashboard. It is not research, was not produced by any AI model, and says nothing about any real project or token.

Analysis date: 2026-09-26 · Horizon: 24 months

## Summary
This fixture is deliberately more bullish than the other two. Its own overall total (72) does not match its component scores, so the dashboard should flag the mismatch. It also reports protocol revenue that contradicts the Claude fixture for the same period.

## 10. Final grading and verdict
Verdict: ATTRACTIVE ASYMMETRY

```json
{
  "schema_version": "cr.report.v1",
  "report_id": null,
  "project_id": "example-payfi-fictional",
  "project_name": "Example PayFi Protocol (FICTIONAL)",
  "project_symbol": "XMPL",
  "provider": "chatgpt",
  "model_self_identification": "FICTIONAL FIXTURE labeled as ChatGPT for testing",
  "model_version": null,
  "model_version_note": "Fixture: no model produced this file.",
  "analysis_at": "2026-09-26",
  "horizon": "24 months",
  "prompt_version": "cr-research-prompt@1",
  "rubric_version": "cr-grading@1",
  "sector_profile": "payfi-credit@1",
  "verdict": "ATTRACTIVE ASYMMETRY",
  "summary": "FICTIONAL: bullish fixture with a deliberately inconsistent overall total.",
  "diagnostic_scores": {
    "legitimacy": {"status": "scored", "value": 75, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["S1"], "missing_data": null},
    "builder_operations": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "product_usefulness": {"status": "scored", "value": 74, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "organic_demand": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": ["C2"], "missing_data": null},
    "credit_risk_transparency": {"status": "scored", "value": 52, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "differentiation": {"status": "scored", "value": 66, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "category_potential": {"status": "scored", "value": 80, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "token_value_capture": {"status": "scored", "value": 72, "low": null, "high": null, "rationale": "Fictional: counts the announced fee switch as likely.", "evidence_refs": [], "missing_data": null},
    "valuation_supply_attractiveness": {"status": "scored", "value": 58, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "chart_quality": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "evidence_confidence": {"status": "scored", "value": 55, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "investment_components": {
    "sustainable_business_demand": {"status": "scored", "value": 75, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "token_value_capture": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "valuation_supply": {"status": "scored", "value": 65, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "risk_resilience": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "btc_relative_asymmetry": {"status": "scored", "value": 70, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "timing_executable_liquidity": {"status": "scored", "value": 55, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "model_reported_overall_score": {"status": "scored", "value": 72, "low": null, "high": null, "rationale": "Fictional total that does not match the components (should be flagged).", "evidence_refs": [], "missing_data": null},
  "risk_scores": {
    "credit": {"status": "scored", "value": 50, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "dilution": {"status": "scored", "value": 60, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "liquidity": {"status": "scored", "value": 45, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null},
    "overall_downside": {"status": "scored", "value": 52, "low": null, "high": null, "rationale": "Fictional.", "evidence_refs": [], "missing_data": null}
  },
  "sources": [
    {"source_id": "S1", "url": "https://example.com/xmpl/docs", "title": "Fictional XMPL docs", "publisher": "Example", "source_type": "official", "accessed_at": "2026-09-26"},
    {"source_id": "S2", "url": "https://example.org/xmpl-dashboard", "title": "Fictional on-chain dashboard", "publisher": "Example", "source_type": "onchain_data", "accessed_at": "2026-09-26"},
    {"source_id": "S3", "url": "https://example.net/news/xmpl-growth", "title": "Fictional news article", "publisher": "Example News", "source_type": "news", "accessed_at": "2026-09-26"}
  ],
  "claims": [
    {"claim_id": "C1", "text": "Fictional: protocol revenue of $650k in the 30 days ending 2026-09-20.", "evidence_tag": "V", "source_ids": ["S3"], "metric_id": "protocol_revenue_usd", "value": 650000, "unit": "USD", "definition": "Fees retained by the protocol", "period": "30d ending 2026-09-20", "as_of": "2026-09-20", "limitation": "News article", "section": "adoption_unit_economics"},
    {"claim_id": "C2", "text": "Fictional: $41.0M of payment financing in the 30 days ending 2026-09-20.", "evidence_tag": "C", "source_ids": ["S2"], "metric_id": "payment_volume_usd", "value": 41000000, "unit": "USD", "definition": "Gross receivables financed", "period": "30d ending 2026-09-20", "as_of": "2026-09-20", "limitation": null, "section": "yield_credit_forensics"},
    {"claim_id": "C3", "text": "Fictional: LP yield of 11.2% APY over 90 days, funded by borrower interest.", "evidence_tag": "V", "source_ids": ["S2"], "metric_id": "lp_yield_apy_pct", "value": 11.2, "unit": "%", "definition": "Annualized LP return net of losses", "period": "90d ending 2026-09-25", "as_of": "2026-09-25", "limitation": null, "section": "yield_credit_forensics"}
  ],
  "bullish_facts": [{"text": "Fictional: fast revenue growth.", "claim_ids": ["C1"]}, {"text": "Fictional: LP yield funded by real borrowers.", "claim_ids": ["C3"]}, {"text": "Fictional: large category.", "claim_ids": []}],
  "bearish_facts": [{"text": "Fictional: fee switch not live.", "claim_ids": []}, {"text": "Fictional: unlock overhang.", "claim_ids": []}, {"text": "Fictional: thin order books.", "claim_ids": []}],
  "conviction_increases": [{"text": "Fictional: fee switch vote passes.", "claim_ids": []}, {"text": "Fictional: new merchant partners.", "claim_ids": []}, {"text": "Fictional: revenue above $1M/month.", "claim_ids": []}],
  "invalidators": [{"text": "Fictional: revenue falls below $300k/month.", "claim_ids": []}, {"text": "Fictional: major default.", "claim_ids": []}, {"text": "Fictional: fee switch rejected.", "claim_ids": []}],
  "catalysts": [{"title": "Fictional fee switch governance vote", "date": "2027-01", "date_precision": "month", "kind": "governance", "status": "announced", "claim_ids": []}],
  "unlocks": [],
  "tokenomics_changes": [{"description": "Fictional fee switch", "status": "announced", "announced_at": "2026-08-30", "effective_at": null, "claim_ids": []}],
  "economics": {
    "business_revenue": {"status": "reported", "value": 650000, "unit": "USD", "period": "30d ending 2026-09-20", "definition": "Fees retained by the protocol", "as_of": "2026-09-20", "evidence_tag": "V", "claim_ids": ["C1"], "note": null},
    "lp_yield": {"status": "reported", "value": 11.2, "unit": "% APY", "period": "90d ending 2026-09-25", "definition": "Annualized LP return net of losses", "as_of": "2026-09-25", "evidence_tag": "V", "claim_ids": ["C3"], "note": null}
  },
  "scenarios": {
    "btc_relative_definition": "Token return minus BTC return over the same 24 months, in percentage points.",
    "items": [
      {"case": "bull", "probability_pct": 35, "business_outcome": "Fictional", "token_capture_assumption": "Fee switch live", "supply_assumption": "Absorbed", "price_range_usd": {"low": 0.8, "high": 1.4}, "btc_assumption": "BTC +40%", "relative_return_vs_btc_pct": {"low": 150, "high": 300}, "invalidation": "Fictional"},
      {"case": "base", "probability_pct": 45, "business_outcome": "Fictional", "token_capture_assumption": "Partial", "supply_assumption": "Some selling", "price_range_usd": {"low": 0.35, "high": 0.6}, "btc_assumption": "BTC +20%", "relative_return_vs_btc_pct": {"low": 10, "high": 60}, "invalidation": "Fictional"},
      {"case": "bear", "probability_pct": 20, "business_outcome": "Fictional", "token_capture_assumption": "None", "supply_assumption": "Heavy selling", "price_range_usd": {"low": 0.08, "high": 0.18}, "btc_assumption": "BTC flat", "relative_return_vs_btc_pct": {"low": -80, "high": -55}, "invalidation": "Fictional"}
    ]
  },
  "next_metric_to_monitor": {"metric": "Fictional: monthly protocol revenue", "why": "Growth thesis", "threshold": "Above $750k"},
  "final_take": "FICTIONAL fixture: optimistic take that leans on an announced mechanism.",
  "unresolved_questions": ["Fictional: is the $650k revenue figure from the same definition as the dashboard's?"],
  "original_report_reference": {"note": "Fixture prose above."}
}
```
