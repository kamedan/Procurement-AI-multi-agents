---
name: procureai-docker-delivery
description: >-
  Governs ProcureAI's multi-stage Docker images, Compose stack, one-shot
  migrations, service DNS, non-root execution, secret handling, SSE forwarding,
  persistence, and containerized acceptance checks. Use for any Dockerfile,
  Compose, environment config, or deployment packaging change.
---

# ProcureAI Docker Packaging & Delivery

The complete ProcureAI application (`web`, `api`, `worker`, `migrate`, `db`, `objectstore`) must build and run via Docker Compose from a clean checkout without requiring host Node.js or Python installations.

## When to use it

- Creating or editing `infra/docker/web.Dockerfile`, `infra/docker/python.Dockerfile`, `.dockerignore`, `.env.example`, `infra/compose.yaml`, `infra/compose.dev.yaml`, `infra/compose.prod.yaml`, or `docs/DOCKER.md`.
- Debugging container networking, SSE streaming, migrations, health checks, volumes, or secret mounts.

## Minimum context to read

- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 9.5, 9.6, 18.1, 25 Docker Definition of Done)

## Inputs and outputs

- **Inputs:** Pinned lockfiles (`package-lock.json`/`pnpm-lock.yaml`, Python lockfile), pinned base images, and local `.env` (copied from `.env.example`) or file-mounted production secrets.
- **Outputs:** Reproducible production multi-stage images (non-root, secret-free), validated Compose stack with ordered startup, persistent named volumes, and `docs/DOCKER.md` operations guide.

## Allowed operations

- Build production `web` (Next.js standalone output verified) and shared Python (`api`, `worker`, `migrate` targets/commands) images using multi-stage builds.
- Run `migrate` as a one-shot dependency (`service_completed_successfully`) before `api` and `worker` start.
- Use Compose service DNS (`api`, `db`, `objectstore`) for container-to-container URLs; reserve public origin URLs for browser traffic.
- Provide separate `compose.dev.yaml` (optional bind mounts/hot reload) and `compose.prod.yaml` (internal-only DB/object-store admin, file-mounted secrets, minimal published ingress).

## Key invariants

1. **No host-runtime dependency:** Running `docker compose --env-file .env -f infra/compose.yaml up --build -d` must launch the entire app stack on a clean machine with only Docker/Compose.
2. **Zero secrets in images or tracked files:** `.dockerignore` excludes `.env`, `.git`, local uploads, logs, and caches. `OPENROUTER_API_KEY` is injected at runtime into Python services only—never `web`, `NEXT_PUBLIC_*`, build args, or image layers.
3. **Production images stay clean:** No dev servers, source bind mounts, test tools, or unnecessary compilers in final runtime stages; run as non-root users with explicit writable temp/cache dirs.
4. **Distinct liveness & readiness:** `api` readiness checks DB + completed migrations; `worker` heartbeat checks lease loop health without requiring a live OpenRouter call (avoid restart loops during LLM outages).
5. **SSE streaming intact:** Configure web runtime/proxy headers and timeouts so AG-UI SSE streams flow cleanly without buffering or exposing an unauthenticated backend port.
6. **Graceful shutdown & volume persistence:** On `SIGTERM`, worker stops claiming new jobs and finishes/releases current leases cleanly. Database records, checkpoints, uploaded documents, and approved PDFs survive `docker compose down && up`.
7. **Explicit seeding only:** Demo/seed data runs only via an explicit command or profile—never automatically on startup in live environments.

## Relevant tests

- `docker compose --env-file .env -f infra/compose.yaml config --quiet` succeeds without printing secrets.
- Clean build + `up --build -d` -> `migrate` exits 0 -> `api`, `worker`, `web` report healthy.
- Restart `api` and `worker` during `waiting_for_approval`; recreate containers preserving named volumes -> uploads, checkpoints, approvals, and approved PDFs remain intact and replay creates no second PO.
- Image inspection confirms non-root user and zero secret leakage in layers or Next.js static bundles.

## Escalation / error behavior

- Migration failure: abort `api`/`worker` startup (`depends_on: condition: service_completed_successfully`); never serve traffic against an unmigrated schema.
- Missing `.env` or required secret: fail fast on startup with safe error naming the missing key (never printing values).

## Worked example

Containerized acceptance check from repository root:
```powershell
Copy-Item .env.example .env
# Populate local test/OIDC and OPENROUTER_API_KEY values in .env
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up --build -d
docker compose --env-file .env -f infra/compose.yaml ps
docker compose --env-file .env -f infra/compose.yaml restart api worker
docker compose --env-file .env -f infra/compose.yaml down
```
