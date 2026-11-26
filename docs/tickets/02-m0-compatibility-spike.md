# 02: M0 Vertical Compatibility Spike (CopilotKit -> FastAPI -> LangGraph -> OpenRouter)

**What to build:** Prove one authenticated containerized procurement interaction from Next.js/CopilotKit through the FastAPI AG-UI bridge into a checkpointed LangGraph workflow calling OpenRouter (`deepseek/deepseek-v4.1-flash`), streaming a typed UI card, pausing at `waiting_for_approval`, surviving a worker/API container restart, continuing only after an authorized domain approval API call (with idempotency + outbox), and denying a second tenant across API, database RLS, and checkpoint boundaries.

**Blocked by:** 01: M0 Bootstrap — Skills, Glossary, ADRs, and Docker Stack.

**Status:** done

- [x] `docker compose --env-file .env -f infra/compose.yaml config --quiet` and `up --build -d` succeed cleanly
- [x] `migrate` completes Alembic + private `langgraph_checkpoints` schema setup before `api`/`worker` start
- [x] Authenticated React/CopilotKit request reaches FastAPI, runs LangGraph node calling live OpenRouter `deepseek/deepseek-v4.1-flash` with strict JSON Schema + ZDR, and streams typed `RequestDraftCard` / `ApprovalDecisionCard`
- [x] Workflow pauses at `waiting_for_approval` and survives `docker compose restart api worker`
- [x] Protected domain approval (`POST /api/v1/decisions/{id}/approve`) validates version/hash/authority, commits outbox event, resumes graph to completion, and deduplicates replay
- [x] Tenant B is denied read/mutate/stream/resume access to Tenant A's run, decision, and checkpoint (verified by automated real-PostgreSQL tests)
- [x] `docs/STACK_COMPATIBILITY.md` and `docs/DOCKER.md` record exact pinned versions and verified checks
