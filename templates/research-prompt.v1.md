<!-- CR-PROMPT cr-research-prompt@1 :: This file is an analysis PROMPT, not a completed report. -->
# Research prompt: {{PROJECT_NAME}} ({{SYMBOL}})

Prompt version: cr-research-prompt@1 · Sector profile: {{SECTOR_PROFILE}} · Grading system: cr-grading@1 · Prepared: {{PREPARED_DATE}}

> Reconstructed from the structure in the dashboard build spec: 11 diagnostic categories, 6 weighted components, 10 research sections, verdict labels and evidence tags. The original Huma Finance prompt was not available when this was written. When it is added to `templates/source-prompts/`, compare the two and publish any merged wording as a new version (cr-research-prompt@2). Do not edit this version in place.

## Role

Act as an independent, skeptical crypto investment analyst. Do research using current sources and write a decision-useful report. Do not cheerlead. "Unknown" is an acceptable answer; an invented number is not.

## Investor context

- US person. Speculative capital is capped. Spot positions only: no leverage, no derivatives, no lending of the position.
- Holding period up to 24 months. Assessment horizon for this report: {{HORIZON}}.
- What matters: legitimacy, a useful product, organic demand, token value capture, valuation, downside risk, and asymmetric return versus simply holding BTC.

## Asset identity (do not substitute another token)

- Project: {{PROJECT_NAME}}
- Official website: {{OFFICIAL_WEBSITE}}
- Token: {{SYMBOL}}
- Chains and contracts: {{ASSET_LIST}}
- CoinGecko ID: {{COINGECKO_ID}}
- Identity status in my records: {{IDENTITY_STATUS}}

If you cannot confirm that the token you are researching matches this identity, say so, explain the conflict, and use the verdict INSUFFICIENT EVIDENCE.

## Ground rules

1. Give the as-of date and the measurement period of every figure.
2. Tag every material claim with exactly one evidence tag:
   - **[V]** Checked in your session (you opened the source and it says this).
   - **[C]** Project-claimed (the project says so; not independently checked).
   - **[I]** Your inference.
   - **[S]** Speculative forecast.
   A [V] tag means you checked the source in this session. Opening an official statement does not verify its underlying substance; say what would.
3. Keep three economic layers separate and never add them together:
   - business activity (volume processed, fees earned by the business),
   - income paid to liquidity providers, users or network participants, and its source,
   - token-holder economics (what actually accrues to the token).
4. For every tokenomics change, say whether it is announced or implemented, with the announcement date and the effective date.
5. Unlocks are potential liquid supply, not demonstrated selling.
6. When two numbers disagree, say whether they truly contradict each other or are measured over different periods or definitions.
7. Never invent URLs, figures, dates, quotes or model names. Cite the sources you actually used.

## Report: write all ten sections, in this order

{{SECTIONS}}

## Section 10 must include

- **Verdict**: exactly one of ATTRACTIVE ASYMMETRY / CONDITIONAL OPPORTUNITY / REAL PRODUCT, WEAK TOKEN / INCENTIVE-DEPENDENT / UNFAVORABLE VALUATION / INSUFFICIENT EVIDENCE.
- The three strongest bullish facts and the three strongest bearish facts.
- Three developments that would increase conviction, and three thesis invalidators.
- The single next metric to monitor.
- Your independent final take.

## Section 9 scenarios

Bull, base and bear cases. For each, give:

- probability (the three must total 100%)
- business outcome
- token value capture assumption
- supply assumption
- price range in USD
- BTC assumption
- return relative to BTC
- what would invalidate it

State the exact definition of "return relative to BTC" that you used. If credible valuation evidence is missing, say that asymmetry is unproven instead of producing a number.

{{GRADING_APPENDIX}}
