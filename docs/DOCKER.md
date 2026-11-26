# ProcureAI Docker Packaging & Operations Guide

ProcureAI packages its entire application stack in containers so a clean machine with Docker + Compose can build, migrate, run, restart, and verify the platform without installing host Node.js or Python.

## Services & Internal DNS

| Service | Image / Dockerfile | Purpose | Internal DNS | Published Port |
| --- | --- | --- | --- | --- |
| `web` | `infra/docker/web.Dockerfile` (multi-stage Next.js standalone, non-root `nextjs`) | React workspace, BFF session proxy, `/api/copilotkit` AG-UI SSE route | `web:3000` | `${WEB_PORT:-3000}` |
| `api` | `infra/docker/python.Dockerfile` (multi-stage Python 3.12, non-root `procureai`) | FastAPI domain API, `/api/ag-ui/agent`, PostgreSQL RLS runtime | `api:8000` | Internal only (`compose.dev.yaml` exposes `127.0.0.1:8000`) |
| `worker` | `infra/docker/python.Dockerfile` (`python -m app.worker`) | Durable outbox poller, LangGraph checkpoint runner, OpenRouter calls | internal | None |
| `migrate` | `infra/docker/python.Dockerfile` (`python -m app.migrate`) | One-shot schema + forced PostgreSQL RLS + `langgraph_checkpoints` setup | one-shot | None |
| `db` | `postgres:17.4-alpine` | Authoritative procurement tables, outbox, and private checkpoint schema | `db:5432` | Internal only (`compose.dev.yaml` optionally binds `127.0.0.1:55432`) |
| `objectstore` | `rustfs/rustfs@sha256:ee717072...` (Apache 2.0, non-root UID 10001) | Private S3-compatible document/artifact storage | `objectstore:9000` | Internal only |
| `objectstore-init` | `infra/docker/python.Dockerfile` (`python -m app.init_storage`) | One-shot private bucket creation via S3 boto3 | one-shot | None |

## Quickstart (Clean Checkout)

```powershell
# 1. Create local ignored .env from template and populate secrets
Copy-Item .env.example .env

# 2. Validate Compose syntax without printing secrets
docker compose --env-file .env -f infra/compose.yaml config --quiet

# 3. Build production multi-stage images and start full stack
docker compose --env-file .env -f infra/compose.yaml up --build -d

# 4. Seed synthetic M0 test tenants explicitly (never auto-run in production)
docker compose --env-file .env -f infra/compose.yaml run --rm migrate python -m app.seed_demo

# 5. Check health
docker compose --env-file .env -f infra/compose.yaml ps
```

Open `http://localhost:3100` (configurable via `WEB_PORT` in `.env`).

## Running Automated Real-PostgreSQL Tests in Docker

```powershell
docker compose --env-file .env -f infra/compose.yaml exec api pytest -v
```

## Secret Handling

- `.env` is excluded by both `.gitignore` and `.dockerignore`.
- `OPENROUTER_API_KEY` and `TAVILY_API_KEY` are passed **only** to `api` and `worker` runtime environments—never to `web`, `NEXT_PUBLIC_*`, `build.args`, or Docker image layers.
- For self-hosted production, use `infra/compose.prod.yaml` which disables `PROCUREAI_DEV_AUTH_ENABLED`, removes DB host ports, and mounts secrets from files (`*_FILE`).

## Persistence, Restarts & Backup/Restore

- Named volumes: `procureai_pgdata` (PostgreSQL data + checkpoints) and `procureai_objects` (private documents).
- `docker compose --env-file .env -f infra/compose.yaml restart api worker` preserves paused `waiting_for_approval` LangGraph checkpoints cleanly.
- `docker compose --env-file .env -f infra/compose.yaml down` stops containers while preserving named volumes.
- Database backup:
  ```powershell
  docker compose --env-file .env -f infra/compose.yaml exec -T db pg_dump -U procureai_owner -d procureai > backup.sql
  ```
