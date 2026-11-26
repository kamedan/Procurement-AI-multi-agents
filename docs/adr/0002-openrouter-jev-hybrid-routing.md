---
status: accepted
date: 2026-11-26
---

# ADR-0002: Fixed Hybrid OpenRouter Routing with Jev Router for Decision & Reasoning Profiles

ProcureAI extends the server-side OpenRouter gateway (`ADR-0001`) with a **Fixed Hybrid** profile configuration: bulk structured extraction remains pinned to `deepseek/deepseek-v4.1-flash` (`OPENROUTER_MODEL_EXTRACTION`), while bounded compliance decisions and reasoning (`OPENROUTER_MODEL_DECISION` and `OPENROUTER_MODEL_REASONING`) route through TypeSafe AI's System One router on OpenRouter (`typesafe/jev-router`) under strict ZDR, data-collection denial, and per-million-token `max_price` ceilings.

## Context

- `ADR-0001` established a single server-side OpenRouter gateway (`OPENROUTER_API_KEY`) with separate model profiles (`extraction`, `reasoning`, `vision`), strict Pydantic JSON Schema validation, `data_collection: "deny"`, and `zdr: true`.
- Procurement quotation comparison requires evaluating free-text supplier offers against mandatory technical specifications (`pass` / `needs_clarification` / `fail`) rather than trusting a binary boolean flag.
- Live verification against OpenRouter confirmed that `typesafe/jev-router` supports strict `json_schema` structured outputs, `zdr: true`, `data_collection: "deny"`, `require_parameters: true`, and `provider.max_price` guardrails while reporting exact routed `model`, `provider`, and observed USD cost.

## Consequences

- **Fixed Hybrid profile boundary:**
  - `extraction` stays pinned to `deepseek/deepseek-v4.1-flash` with `reasoning: {"enabled": false}` for predictable sub-cent extraction (`~$0.0002/call`) and KV-cache prefix reuse.
  - `decision` and `reasoning` default to `typesafe/jev-router` via `.env` configuration (no client-side model switcher).
- **Explicit price ceiling & resilient fallback:** Router requests attach `provider.max_price` (`$0.50/1M` prompt tokens, `$1.50/1M` completion tokens by default) and omit `allow_fallbacks: false` so `jev-router` can select compliant ZDR endpoints. On transient router failure (`429`/`5xx`), the gateway retries once against `deepseek/deepseek-v4.1-flash`.
- **Deterministic comparison safety on total LLM outage:** If OpenRouter is completely unreachable or the tenant's daily AI budget cap is exhausted during `Run Comparison`, deterministic `Decimal` cost, deadline, currency, and budget-cap checks still execute, and unverified mandatory specs degrade safely to `needs_clarification` (never silently `pass`).
- **Batched version-bound spec caching & human authority:** Mandatory-spec verification runs as a single batched `decision` call per comparison across unverified `(request_version, quote_revision)` pairs, storing per-spec evidence in `quotations.evidence_json`, while buyers retain attributable human override (`reason` required, bumping `revision_number`).
