---
status: proposed
date: 2026-11-26
---

# ADR-0001: Use OpenRouter with DeepSeek V4 Flash as Primary Inference Backbone

ProcureAI will route all application LLM inference through one server-side OpenRouter gateway using DeepSeek V4 Flash—specifically the current OpenRouter route `deepseek/deepseek-v4.1-flash` (to which the legacy `deepseek/deepseek-v4-flash` alias routes)—configured behind three distinct model profiles (`extraction`, `reasoning`, and optional `vision`) with strict JSON Schema validation, explicit provider privacy controls (`data_collection: "deny"`, `zdr: true`, `require_parameters: true`), and a qualified fallback within the same privacy/capability allowlist.

## Context

- `PROCUREAI_MASTER_PLAN.md` requires OpenRouter for all application LLM calls, three configurable profiles (`extraction`, `reasoning`, optional `vision`), strict structured outputs validated by Pydantic, fail-closed privacy routing for confidential supplier quotations, and low unit operating costs during the free validation pilot.
- The founder selected **OpenRouter + DeepSeek V4 Flash** as the primary model choice.
- Research on 2026-11-26 confirmed that legacy `deepseek/deepseek-v4-flash` on OpenRouter has transitioned to `deepseek/deepseek-v4.1-flash` (552B MoE Causal Encoder-Decoder activating 8B input / 16B output parameters, 1M context window, compressed KV cache, native multimodality, controllable `reasoning_effort`, OpenAI-format tool calling, and `response_format` JSON Schema support).

## Consequences

- **Pin exact snapshot in M0:** Do not rely on floating aliases in production or evaluations; verify and pin the exact qualified model/snapshot ID (e.g., `deepseek/deepseek-v4.1-flash` or its dated snapshot) and audited ZDR provider list in `docs/STACK_COMPATIBILITY.md` during M0 live testing.
- **Profile separation remains mandatory:** Even though DeepSeek V4.1 Flash supports text, reasoning, and native vision in one model family, keep `extraction`, `reasoning`, and `vision` as separate configuration profiles with distinct `reasoning_effort`, `max_output_tokens`, timeouts, and evaluation suites.
- **Privacy & quantization risk mitigation:** Because OpenRouter serves DeepSeek V4.1 Flash across multiple third-party hosts with differing retention policies and quantization levels (unquantized vs. fp8/fp4), the gateway must set `data_collection: "deny"`, `zdr: true`, `require_parameters: true`, and `allow_fallbacks: false` (managing qualified fallbacks explicitly in our gateway) and fail closed if no compliant provider is available.
- **No hidden chain-of-thought leakage:** Keep `reasoning_effort` minimal/disabled for strict JSON extraction and never expose raw reasoning traces to end users.
- **Live gate required:** M0 must execute a live OpenRouter smoke check (separate from stub tests) proving structured JSON Schema output, tool calling, streaming, ZDR routing, and usage/cost reconciliation with `OPENROUTER_API_KEY`.
