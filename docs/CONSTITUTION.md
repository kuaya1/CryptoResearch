# CryptoResearch: Architectural Constitution & Engineering Journal

**Author & Sovereign Architect:** Enkhbayar (Eric) Enkhbaatar  
**Repository:** kuaya1/CryptoResearch  
**Date Established:** October 27, 2026  
**Status:** Canonical Reference & Operating Law  

---

## Part 1: The Core Operating Constitution

### Law 1: The Sovereign Architect Principle
You are the Conductor and Governor, not an unpaid DevOps mechanic. AI writes syntax; you own systems architecture, risk parameters, capital allocation, and final merge decisions. Never delegate merge authority, credential bypasses, or live capital control to an autonomous loop.

### Law 2: No Meta-Machines (The Recursion Rule)
Do not build autonomous machines to build your machine. The value of this project is the **CryptoResearch Desk**—its forensic models, AMM exit physics, tokenomics stress tests, and paper accounting. Building autonomous swarms inside GitHub Actions to automate Git commits is an anti-pattern that drains energy away from the actual product.

### Law 3: Supervised, Bounded Development
All engineering proceeds in a clean, human-supervised loop:
1. One explicit, bite-sized task at a time.
2. Local execution in your terminal via Claude Code on a dedicated branch.
3. Deterministic unit testing verification (`node dashboard/cli.js test`).
4. Human review of the diff on a clean Pull Request.
5. Sovereign manual merge into `main`.

### Law 4: Ground Truth Before Architecture (The Anti-Speculation Rule)
Never allow an AI model to architect solutions against an imagined repository state. Before modifying any file or proposing a design, inspect the live file tree, read effective rulesets, verify line numbers, and cite actual paths. If an endpoint or metric is missing, label it `UNKNOWN`—never assume zero, never hallucinate a default.

### Law 5: Deterministic Core vs. Cognitive Shell
- **Cognitive Shell (Probabilistic LLMs):** Used for qualitative research, analyzing whitepapers, summarizing claims, and adversarial cross-examination (Researcher vs. Prosecutor).
- **Execution Core (Deterministic Code):** Hard mathematical calculations, position sizing, NAV tracking, order states, and stop losses must execute strictly in deterministic JavaScript/TypeScript with decimal precision. Models propose ideas; deterministic code clamps and filters them.

---

## Part 2: The Foundational Invariants

### Invariant 1: Order State Integrity (No Blind Lost Clock)
An order whose submission might have reached an exchange remains `UNKNOWN` or `RECONCILE_REQUIRED`. It never transitions to `LOST` based on a timer, timeout, or elapsed duration (e.g., 65 minutes). Unacknowledged orders must be explicitly reconciled against venue records using `client_order_id` before any replacement order can ever be contemplated.

### Invariant 2: Discrete Risk vs. Notional Exposure
- **NAV** = Marked Cash + Valued Positions - Liabilities.
- **Risk Budget** = NAV * Risk Fraction (e.g., 1–2%).
- **Position Quantity** = Risk Budget / (|Entry - Stop| + Slippage + Fees).
- **Notional Exposure** = Quantity * Entry.
Never confuse planned loss-at-stop with notional position size. Sizing must enforce a minimum stop distance floor so a razor-thin stop cannot inflate gross exposure beyond equity limits.

### Invariant 3: Circuit Breakers & Clean Gating
- Keep only deterministic status checks (like `test`) as required merge gates on `main`.
- Never rely on external paid AI API calls (`agent-review`) as a hard requirement to merge code.
- Protected accounting modules (`dashboard/core/paper.js`, `dashboard/core/trade-risk.js`) require deliberate manual review and cannot be modified unattended.

---

## Part 3: The Engineering Journal & Lessons Learned

### Entry 1: October 25–27, 2026 — The "Autonomous Swarm" Mirage and the Return to Bedrock
- **Context:** Attempted to transition the CryptoResearch pipeline into a fully autonomous, self-scheduling multi-agent engineering factory. The vision was an unattended "ChatGPT General Contractor + Claude Builder" loop running off markdown queues in GitHub.
- **The Failure Mode:** 
  - The meta-tooling outstripped the product. GitHub rulesets blocked merges because required review checks were expecting dormant workflows.
  - Task queues in `DESK_STATE.md` forced task additions to require full PR merges to `main`, turning git into a bottleneck.
  - An AI assistant without repo access began hallucinating file paths (`TASK-001`, `agent-pm.js`), building an architecture that fought against the repo's existing code (`backlog-schedule.js`, `agent-ledger.js`).
  - The user was alienated from their own development flow, spending hours debugging branch permissions and lease timeouts instead of building the crypto research desk.
- **The Breakthrough:** 
  - Performed a ground-truth audit of commit `f5f6532` and `f29e103`.
  - Recognized that `cr-paper@2`, `cr.trade-intent.v2`, and the paper desk invariants were already 90% built and mathematically sound with 66 passing tests.
  - Reclaimed sovereign control: decided to freeze autonomous engineering, silence ghost schedulers, drop complex release-gate apps, and return to simple, supervised local development.
  - Clarified that true senior systems engineering is not writing fast boilerplate syntax; it is setting invariants, testing boundaries, and having the discipline to know what should never be built.

---

## Part 4: The 4-Question Filter for Every New Feature

Before writing any new feature, prompt, or script, run it through this filter:
1. **Does this directly serve the research or trading desk?** (If it's DevOps meta-tooling to manage AI agents, kill it).
2. **Can I explain this architecture on one sheet of paper?** (If it requires distributed lease negotiations or multi-app environments, simplify it). The desk's sheet is [ONE-SHEET.md](ONE-SHEET.md).
3. **What is the failure state when the network drops?** (If the answer is undefined or assumes a timeout, define explicit reconciliation).
4. **Is the deterministic math protected from model hallucination?** (If an LLM can choose position size or alter accounting logic, put a mathematical clamp in front of it).
