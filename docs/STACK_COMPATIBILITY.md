# ProcureAI Stack Compatibility Matrix

**Verified:** 26 November 2026 (Milestone M0)

## Container Base Images

| Component | Pinned Base Image | Notes |
| --- | --- | --- |
| PostgreSQL | `postgres:17.4-alpine` | Enforces `FORCE ROW LEVEL SECURITY` with non-owner `NOBYPASSRLS` role `procureai_app` |
| Object Storage | `rustfs/rustfs@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a` | Apache 2.0 S3-compatible server (non-root UID 10001); private bucket created via `python -m app.init_storage` |
| Python Services (`api`, `worker`, `migrate`) | `python:3.12.9-slim-bookworm` | Multi-stage venv build, non-root UID 10001, `LANGGRAPH_STRICT_MSGPACK=true` |
| Web Frontend (`web`) | `node:22.18.0-bookworm-slim` | Multi-stage Next.js `output: "standalone"`, non-root UID 10001 |

## Application Packages

| Layer | Package | Pinned Version |
| --- | --- | --- |
| Web Framework | `next` / `react` / `react-dom` | `16.4.6` / `19.3.1` / `19.3.1` |
| Styling | `tailwindcss` / `@tailwindcss/postcss` | `4.3.5` |
| Agentic UI / AG-UI | `@copilotkit/react-core`, `@copilotkit/react-ui`, `@copilotkit/runtime`, `@ag-ui/client` | `1.90.2` / `1.0.5` |
| Backend API | `fastapi` / `uvicorn[standard]` / `pydantic` | `0.115.12` / `0.34.0` / `2.11.3` |
| Persistence | `sqlalchemy` / `alembic` / `psycopg[binary,pool]` | `2.0.40` / `1.15.2` / `3.2.6` |
| Workflow Orchestration | `langgraph` / `langgraph-checkpoint-postgres` | `0.4.5` / `2.0.21` |
| Model Gateway Transport | `httpx` (direct OpenRouter adapter) | `0.28.1` |

## OpenRouter & DeepSeek V4 Flash Qualification

- **Primary model route:** `deepseek/deepseek-v4.1-flash` (legacy `deepseek/deepseek-v4-flash` routes to `4.1-flash`).
- **Gateway implementation note (per Section 9.4):** Uses a small direct `httpx` OpenRouter client behind our `OpenRouterGateway` seam instead of a higher-level LangChain wrapper because live M0 qualification revealed two critical OpenRouter-native parameters required for DeepSeek V4.1 Flash:
  1. `reasoning: { "enabled": false }` on the `extraction` profile — otherwise DeepSeek V4.1 Flash enables reasoning by default and can exhaust `max_tokens` inside reasoning tokens, returning empty JSON `content`.
  2. Explicit `provider: { "data_collection": "deny", "zdr": true, "require_parameters": true, "allow_fallbacks": false }` + extraction of exact returned `provider`, `usage.cost`, `cached_tokens`, and `reasoning_tokens`.
- **Live provider observed on 2026-11-26:** `Wafer` (satisfied `zdr: true`, `data_collection: "deny"`, `require_parameters: true`, and strict `json_schema`).
- **Optional external search adapter:** `TavilySearchAdapter` (`PROCUREAI_EXTERNAL_SEARCH_ENABLED=false` by default in MVP; returns HTTPS `unverified_external_lead` records only when explicitly enabled).
