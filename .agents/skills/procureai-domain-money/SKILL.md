---
name: procureai-domain-money
description: >-
  Enforces ProcureAI deterministic monetary arithmetic, currency/unit rules,
  eligibility-before-ranking comparison logic, and immutable procurement
  revisions. Use for any purchase request, RFQ, quotation, comparison,
  approval payload, or purchase order change.
---

# ProcureAI Domain & Money Rules

Deterministic application code—never an LLM—owns all financial calculations, eligibility checks, currency handling, and approval totals.

## When to use it

- Adding or editing purchase requests, request lines, RFQs, quotation revisions, comparisons, approval packets, or purchase orders.
- Implementing or modifying money types, rounding, tax/freight/discount handling, budget caps, or eligibility rules.

## Minimum context to read

- [GLOSSARY.md](../../../GLOSSARY.md)
- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 12, 13.2, 13.3, 14)

## Inputs and outputs

- **Inputs:** Confirmed `RequestVersion` lines, confirmed `QuoteRevision` line items and commercial terms (`Decimal` strings + ISO 4217 currency code), tenant rounding/tax presentation policy, and configured budget cap.
- **Outputs:** Deterministic `Comparison` totals, explicit component breakdown (item subtotal, discounts, freight, quoted tax, fees), per-constraint results (`pass | fail | unknown`), and canonical commercial payload hashes for approval packets and POs.

## Allowed operations

- Compute totals using PostgreSQL `NUMERIC` and Python `Decimal`.
- Serialize monetary values to TypeScript/JSON as canonical decimal strings with explicit ISO currency codes.
- Evaluate mandatory eligibility checks before sorting eligible offers by total quoted cost.
- Create new immutable versions/revisions when submitted requests, confirmed quotes, or approved POs change.

## Key invariants

1. **No binary floating point:** Never use `float` (Python) or IEEE-754 `number` (JS/TS) for authoritative monetary or quantity math.
2. **Explicit currency & scale:** Store an ISO currency code on every monetary field; respect currency scale rather than assuming 2 decimal places. Do not auto-compare mixed currencies without an explicitly approved, dated conversion basis.
3. **Unknown != zero:** A missing freight, tax, or fee field must be stored and displayed as `unknown`, never coerced to `0`. Explicitly quoted zero (`"0.00"`) is distinct from `unknown`.
4. **Preserve supplier totals:** Store supplier-quoted totals alongside application-computed totals; surface disagreements for human review rather than silently overwriting.
5. **No double-counting:** Never add tax on top of tax-inclusive unit prices, double-count bundled freight, or hide discounts in negative unit prices.
6. **Eligibility before preference:** Check mandatory spec fit, quantity, unit compatibility, delivery deadline, currency, request cap, quote validity, and supplier eligibility first. A partial offer or spec/deadline failure cannot rank as eligible.
7. **Honest commercial labels:** Budget headroom is not "procurement savings." Quoted totals are not "landed cost" unless all components are captured. An exported PO is `approved_ready_for_issue`, not `sent`, `accepted`, `delivered`, or `paid`.

## Relevant tests

- Decimal arithmetic, currency scale, line vs. document rounding, explicit discounts, and tax-inclusive vs. tax-exclusive quotes.
- Missing freight/tax (`unknown`) vs. explicit `"0.00"` handling.
- Partial offers, mixed units/currencies, expired quotes, and no-eligible-quote scenarios.
- Canonical worked 20-laptop scenario (Atlas $18,300 eligible lowest, Vertex $16,900 excluded on 21-day delivery, Northline $18,800 eligible faster).

## Escalation / error behavior

- Mixed currencies or incompatible units: block comparison with `POLICY_BLOCKED` / `unknown` eligibility and prompt human clarification.
- Supplier total mismatch: flag discrepancy in comparison and block unconditional recommendation until human confirms.
- No eligible quotes: return explicit failed/unknown constraints and offer policy-compliant request amendment; never manufacture a winner.

## Worked example

Request cap: `USD 20000.00` (total quoted cost), quantity `20`, required delivery `<= 15 days`.

- **Atlas Computing:** `20 * 850.00 = 17000.00` + freight `300.00` + quoted tax `1000.00` = `USD 18300.00`, delivery `12 days` -> `eligible` (lowest eligible total; budget headroom `USD 1700.00`, labeled *"Not a savings claim"*).
- **Vertex Technologies:** `20 * 790.00 = 15800.00` + freight `200.00` + quoted tax `900.00` = `USD 16900.00`, delivery `21 days` -> `fail` on mandatory delivery deadline (`ineligible`).
- **Northline Systems:** `20 * 880.00 = 17600.00` + freight `200.00` + quoted tax `1000.00` = `USD 18800.00`, delivery `10 days` -> `eligible` (faster delivery).
