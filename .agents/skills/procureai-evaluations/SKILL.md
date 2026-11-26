---
name: procureai-evaluations
description: >-
  Governs ProcureAI's deterministic safety tests, labeled extraction/comparison
  evaluation corpus (development vs held-out splits), DeepSeek V4 Flash quality
  and cost measurement, and pilot KPI instrumentation. Use when changing agent
  prompts, models, schemas, parsers, or release gates.
---

# ProcureAI Evaluations & Pilot Quality Gates

Measure model quality, cost, and safety honestly with versioned fixtures—never rely on ad-hoc demos or average scores to justify unsafe automation.

## When to use it

- Modifying agent prompts, output schemas, document parsers, OpenRouter model/snapshot/provider routing, comparison explanations, or pilot KPI event instrumentation.
- Running release gates before advancing milestones (M0, M3, M5, M6).

## Minimum context to read

- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 18, 20)
- [procureai-openrouter-gateway](../procureai-openrouter-gateway/SKILL.md)

## Inputs and outputs

- **Inputs:** Labeled synthetic or explicitly permitted redacted fixtures under `evals/fixtures/` + expected outputs under `evals/expected/`, split by supplier/document template into development and held-out sets.
- **Outputs:** Reproducible evaluation report separating deterministic/stub results from live OpenRouter (`deepseek/deepseek-v4.1-flash`) runs, with per-field accuracy, safety pass/fail, latency, token counts, and observed/estimated cost.

## Allowed operations

- Run deterministic pytest/Vitest/Playwright suites against real PostgreSQL for isolation, money, approval, and recovery invariants.
- Run structured extraction and recommendation evals against the labeled corpus whenever prompts, schemas, parsers, or models change.
- Emit metadata-only server-side pilot KPI events (`request_submitted`, `rfq_exported`, `distribution_recorded`, `quote_uploaded`, `quote_confirmed`, `comparison_completed`, `approval_requested`, `approval_decided`, `po_release_approved`, `po_finalized`, `workflow_cancelled`, `agent_failed`).

## Key invariants

1. **100% deterministic safety gate:** Authorization, tenant isolation, Decimal math, eligibility filtering, and duplicate-action prevention must pass 100%; never soften them with LLM judges.
2. **Never pass mocks as live proof:** Always report deterministic/stub adapter checks separately from live OpenRouter model evaluations. If live credentials are absent, mark live evals `UNVERIFIED`.
3. **Prevent template leakage:** Split development and held-out evaluation fixtures by originating supplier/document template (target 30–50 cases covering clean quotes, missing freight/tax, contradictory totals, partial offers, expired validity, mixed currencies, prompt injection, and unreadable scans).
4. **Per-field metrics with sample counts:** Report accuracy separately for supplier, currency, quantity, unit price, total, and delivery alongside exact sample counts and error types—never hide critical failures in an overall average.
5. **No raw supplier text in analytics:** Keep product KPI events free of raw document text and exclude synthetic/demo tenants from pilot cohorts.

## Relevant tests

- Deterministic safety suite (all 10 areas in Master Plan Section 18.1).
- Prompt-injection eval cases verifying zero tool misuse or constraint bypass.
- Held-out extraction/comparison suite comparing candidate prompt/model revisions on critical errors, unsupported claims, latency, and cost per case.

## Escalation / error behavior

- Any critical safety regression (isolation leak, approval bypass, fabricated supplier, wrong eligibility): block release immediately.
- Model/provider quality drop on held-out set: halt model/prompt promotion and retain human confirmation gate for all critical fields.

## Worked example

Before upgrading `prompt_bundle_version` from `v1` to `v2` on `deepseek/deepseek-v4.1-flash`:
1. Run deterministic suite (`pytest` on real Postgres) -> 100% pass.
2. Run held-out extraction & comparison eval (15 unseen supplier templates) -> report per-field accuracy (e.g., unit price 15/15, freight/unknown 14/15, delivery 15/15), 0 injection violations, median latency, and actual OpenRouter cost.
3. Compare against `v1` baseline in the evaluation report before promoting `v2`.
