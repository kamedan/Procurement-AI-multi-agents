---
name: procureai-openrouter-gateway
description: >-
  Governs ProcureAI's server-side OpenRouter model gateway configured for
  DeepSeek V4 Flash (deepseek/deepseek-v4.1-flash), including model profiles,
  JSON Schema structured outputs, provider privacy/ZDR allowlists, atomic usage
  reservations, and fallback rules. Use for any LLM call, prompt change, or
  model/provider configuration.
---

# ProcureAI OpenRouter Gateway (DeepSeek V4 Flash)

Every application LLM call routes through one server-side OpenRouter gateway with strict schema validation, privacy controls, and atomic tenant budget reservations.

## When to use it

- Configuring or modifying OpenRouter clients (`langchain-openrouter` `ChatOpenRouter` or direct HTTP adapter), model profiles, structured output schemas, provider privacy/ZDR routing, fallbacks, retries, or AI usage accounting.

## Minimum context to read

- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 9.4, 11.8, 17.3)
- [ADR-0001-openrouter-deepseek-v4-flash.md](../../../docs/adr/0001-openrouter-deepseek-v4-flash.md)

## Inputs and outputs

- **Inputs:** Trusted `(tenant_id, run_id, actor_id)`, profile (`extraction | reasoning | vision`), `prompt_version`, `schema_version`, Pydantic target schema, bounded input payload, `max_output_tokens`, and timeout.
- **Outputs:** Pydantic-validated structured output + recorded usage metadata (actual resolved model/snapshot, upstream provider, input/output/cached tokens, latency, observed/estimated cost).

## Allowed operations

- Route primary workloads to **DeepSeek V4.1 Flash** on OpenRouter (note: legacy `deepseek/deepseek-v4-flash` aliases to `deepseek/deepseek-v4.1-flash`; pin the exact qualified model/snapshot ID in config after M0 live verification).
- Configure per-profile parameters:
  - `extraction`: low temperature, strict `response_format` JSON Schema + `require_parameters: true`, low/minimal `reasoning_effort` so hidden reasoning never bloats latency or breaks schema output.
  - `reasoning`: concise evidence-linked explanations with bounded `reasoning_effort` and `max_output_tokens`; strip/never display raw chain-of-thought to end users.
  - `vision` (optional, feature-flagged): leverage DeepSeek V4.1 Flash native multimodality only for explicitly approved image/scan trials under the same privacy policy.
- Enforce OpenRouter provider routing controls: `data_collection: "deny"`, `zdr: true` (for sensitive tenant documents), `require_parameters: true`, and an explicit allowlist of audited ZDR providers.

## Key invariants

1. **Single server-side gateway:** Never call another LLM vendor directly and never expose `OPENROUTER_API_KEY` to browser code, `NEXT_PUBLIC_*`, Docker build layers, or logs.
2. **Fail closed on privacy & parameters:** If no upstream provider satisfies `data_collection: "deny"`, `zdr: true`, `require_parameters: true`, and structured outputs, abort with `MODEL_CAPABILITY_UNAVAILABLE` rather than silently falling back to a non-ZDR or unvalidated host.
3. **JSON Schema + Pydantic double validation:** Treat model JSON as untrusted. Validate every response with Pydantic and domain checks (valid tenant entity IDs, Decimal strings, explicit unknowns); route malformed outputs to bounded repair (max 1–2 attempts) or human correction.
4. **Atomic usage reservation:** Reserve an estimated max cost/token allowance in PostgreSQL (`ai_usage_reservations`) before invoking OpenRouter; reconcile actual tokens/cost (`ai_usage_events`) afterward—including failed/retried calls. Unknown/delayed cost stays `pending_reconciliation`, never `$0`.
5. **One retry layer:** Cap transient provider retries (max 2) inside the gateway only; disable redundant SDK/graph transport retries so costs never multiply.
6. **Qualified fallback only:** Any fallback model must pass the same structured-output, tool-calling, privacy/ZDR, and evaluation checks before being enabled.

## Relevant tests

- Unit/contract tests (explicitly labeled test adapter): schema rejection -> bounded repair -> safe failure state; concurrent calls cannot bypass `tenant_usage_limits`; failed calls still record usage.
- M0/release live OpenRouter verification (separate from stub tests): verify `deepseek/deepseek-v4.1-flash` with `response_format` JSON Schema, `require_parameters: true`, `data_collection: "deny"`, `zdr: true`, and actual returned provider/usage fields; report unverified if `OPENROUTER_API_KEY` is absent.

## Escalation / error behavior

- Quota exceeded: reject before calling OpenRouter with `USAGE_LIMIT_REACHED` and preserve manual workflow path.
- Provider/policy mismatch or outage: try qualified fallback within the same privacy allowlist; if none succeeds, return `MODEL_CAPABILITY_UNAVAILABLE` and transition run to recoverable failure state.

## Worked example

Extracting a 2-page PDF quotation for Tenant A:
1. Worker atomically reserves max allowance for `extraction` profile (`max_output_tokens=2048`) under `tenant_a` / `run_42`.
2. Gateway calls OpenRouter with model `deepseek/deepseek-v4.1-flash`, `response_format={"type": "json_schema", ...}`, `provider={"data_collection": "deny", "zdr": true, "require_parameters": true, "allow_fallbacks": false}` (explicit gateway-controlled fallback only).
3. Gateway validates JSON with `RawQuoteExtraction` Pydantic model, verifies freight/tax missing fields remain `null`/`unknown`, reconciles actual token usage + provider name, and returns typed candidates with `prompt_version` and `schema_version`.
