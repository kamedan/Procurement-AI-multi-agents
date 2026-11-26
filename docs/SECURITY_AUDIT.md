# ProcureAI Security & Architecture Audit Report

**Audit Date:** 26 November 2026  
**Scope:** Full containerized M0 stack (`apps/web`, `services/api`, `infra/docker/*`, `infra/compose*.yaml`, PostgreSQL RLS, LangGraph checkpoints, OpenRouter gateway, Tavily search adapter).

---

## 1. Executive Summary

All core multi-tenant isolation, approval integrity, SSRF, CSRF, secret-isolation, and combined LLM + Tavily budget controls are implemented and verified against real PostgreSQL and live OpenRouter/Tavily endpoints inside Docker Compose. Five security hardening gaps identified during the audit were remediated immediately; four pre-pilot items remain tracked below before onboarding external pilot customers.

---

## 2. Issues Found During Audit & Remediated

| # | Severity | Finding | Remediation Applied & Verified |
| --- | --- | --- | --- |
| 1 | **High** | Cookie-authenticated Next.js BFF mutation routes (`/api/auth/session`, `/api/v1/[...path]`, `/api/copilotkit`) lacked explicit `Origin` CSRF validation. | Added `isAllowedMutationOrigin()` in `apps/web/src/lib/session.ts` and enforced it on all `POST`/`PATCH` BFF handlers. Verified cross-origin `POST` (`Origin: https://evil.example`) returns **HTTP 403**. |
| 2 | **High** | Next.js `/api/v1/[...path]` proxy forwarded raw dynamic path segments to internal FastAPI without segment validation (potential path traversal / internal route reachability). | Added strict `SAFE_SEGMENT_RE` validation rejecting `.`, `..`, encoded traversal, and invalid chars. Verified `/api/v1/..%2Fhealth/ready` returns **HTTP 400**. |
| 3 | **Medium** | Concurrent tenant budget reservations in `openrouter.py` relied on an uncommitted advisory-lock comment rather than an actual PostgreSQL lock. | Added `SELECT pg_advisory_xact_lock(hashtext(:lock_key))` serializing combined 24h LLM + Tavily reservations per tenant in `check_and_reserve_tenant_budget()`. |
| 4 | **Medium** | Next.js and FastAPI responses lacked explicit baseline browser security headers (`CSP`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`) and FastAPI exposed `/docs` regardless of environment. | Added headers in `apps/web/next.config.ts` and FastAPI middleware in `services/api/app/main.py`, disabled `/docs`/`/redoc`/`/openapi.json` when `PROCUREAI_ENV=production`. Verified live headers on `GET /` and `GET /api/v1/me`. |
| 5 | **Medium** | Tavily URL filter checked only string literals (`localhost`, `127.0.0.1`) rather than full private/link-local/IMDS IP ranges. | Added Python `ipaddress` filtering in `app/infrastructure/tavily.py` blocking non-HTTPS, private, loopback, link-local (`169.254.169.254`), multicast, and reserved IPs. Verified via `test_tavily_ssrf_url_filter_blocks_private_and_non_https`. |

---

## 3. Verified Security Controls (Evidence)

| Control Area | Verification Method | Result |
| --- | --- | --- |
| **PostgreSQL Row-Level Security** | `FORCE ROW LEVEL SECURITY` on `tenants` and all 14 tenant-scoped tables under `NOBYPASSRLS` role `procureai_app`; `test_rls_fails_closed_without_tenant_context` | **PASS** (0 rows returned without `app.current_tenant_id`) |
| **Cross-Tenant API & Checkpoint Isolation** | `test_two_tenant_isolation_approval_integrity_and_idempotency` + live BFF check (Tenant B -> Tenant A run) | **PASS** (`404` on API, `PermissionError` on `TenantScopedCheckpointAdapter`) |
| **Approval Authority & Integrity** | Separation of duties (requester self-approve `403`), admin != approver (`403`), stale hash (`409 STALE_VERSION`), duplicate click idempotency (`200` same ID), payload mismatch (`409`) | **PASS** |
| **Tenant External Search RBAC** | Non-admin toggle attempt -> `403`; `tenant_admin` disable -> `POST /api/v1/suppliers/discover-external` returns `403 POLICY_BLOCKED` | **PASS** |
| **Tenant LLM Cache Isolation** | `test_tenant_llm_cache_hits_at_zero_cost_and_respects_tenant_isolation` | **PASS** (Tenant A `$0.00` hit; Tenant B gets `None`) |
| **Secret Isolation** | Inspected `web` container env, `/app/.next` bundle, `docker history --no-trunc` on both images, and all workspace files outside `.env` | **PASS** (`0` `OPENROUTER`/`TAVILY` env vars in `web`, `0` secret hits in bundles, image layers, or tracked files) |
| **Non-Root Container Execution** | `id` in `api`, `worker`, `web` containers + RustFS UID `10001` | **PASS** (all app containers run as UID `10001`, zero root runtime) |
| **OpenRouter Privacy Routing** | Live `deepseek/deepseek-v4.1-flash` call with `data_collection: "deny"`, `zdr: true`, `require_parameters: true`, `allow_fallbacks: false` | **PASS** (served by ZDR provider `Wafer`, `reasoning_tokens=0`) |
| **Production Compose Config** | `docker compose --env-file .env -f infra/compose.yaml -f infra/compose.prod.yaml config --quiet` | **PASS** (exit `0`, dev auth disabled, file-mounted secrets configured) |

---

## 4. Remaining Pre-Pilot Findings & Recommendations

Track and resolve before onboarding external pilot tenants (M1–M5):

1. **Rotate credentials pasted in chat:** Both `OPENROUTER_API_KEY` and `TAVILY_API_KEY` were supplied in chat during setup. Rotate them in OpenRouter/Tavily dashboards and update `.env` / production secret files before any live pilot.
2. **Replace dev test auth with real OIDC (M1):** `PROCUREAI_DEV_AUTH_ENABLED=true` is strictly a local dev convenience (hard-blocked when `PROCUREAI_ENV=production`). Integrate an OIDC provider with short-lived sessions, issuer/audience verification, and explicit invite acceptance in M1.
3. **Tighten CSP & TLS at ingress (M5):** Production CSP should replace `'unsafe-inline'` scripts/styles with per-request nonces and run behind a TLS-terminating reverse proxy (`Strict-Transport-Security`, trusted `X-Forwarded-*` handling, SSE buffering disabled).
4. **Optional Tavily query caching & rate limiting:** Live M0 spend telemetry showed 1 Tavily basic search (`~$0.0080`) costs ~33× more than 1 DeepSeek V4.1 Flash extraction (`~$0.00024`). Adding a tenant-scoped Tavily result cache (e.g., 1–6h TTL) and per-user rate limiting in M2 will prevent accidental Tavily credit burn on repeat searches.
5. **Local git initialization & dependency scanning (M5):** Initialize git and add CI `pip-audit` / `npm audit` / container CVE scanning (e.g., Trivy) plus pinned `package-lock.json` before pilot launch.
