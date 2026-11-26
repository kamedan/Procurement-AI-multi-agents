---
name: procureai-tenant-authorization
description: >-
  Enforces multi-tenant isolation, PostgreSQL row-level security, server-derived
  actor context, role/authority checks, and tenant-scoped checkpoint access. Use
  for any API endpoint, database query, file preview/download, SSE stream,
  LangGraph thread, or background job.
---

# ProcureAI Tenant Isolation & Authorization

Every read, write, file access, stream, workflow checkpoint, and background job must enforce server-derived tenant isolation and current actor authority.

## When to use it

- Adding or editing FastAPI routes, Next.js BFF routes, SQLAlchemy models/queries, Alembic migrations, object storage URLs, SSE/AG-UI streams, LangGraph checkpoint adapters, or worker jobs.
- Implementing roles, memberships, invitations, approver assignments, or separation-of-duties checks.

## Minimum context to read

- [GLOSSARY.md](../../../GLOSSARY.md)
- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 9.2, 14.3, 16)

## Inputs and outputs

- **Inputs:** Verified OIDC/session token at Next.js BFF -> signed/verifiable server identity forwarded to FastAPI -> resolved `(tenant_id, actor_id, membership, current_roles, approver_authority)`.
- **Outputs:** Authorized domain result or explicit fail-closed denial (`401`/`403`/`404` without leaking cross-tenant existence).

## Allowed operations

- Derive `tenant_id` and `actor_id` exclusively from server-verified sessions/tokens and active membership records.
- Set trusted PostgreSQL transaction tenant context (`SET LOCAL`) for RLS-protected tables using a non-owner, non-superuser, `NOBYPASSRLS` runtime role.
- Enforce composite `(tenant_id, id)` foreign keys on tenant-owned relations.
- Map every `thread_id` through an authorized `workflow_runs(tenant_id, thread_id)` lookup before touching checkpoints.

## Key invariants

1. **Zero trust in browser claims:** Never trust client-supplied `tenant_id`, roles, CopilotKit forwarded properties, or raw UUIDs as proof of access.
2. **Fail closed on missing context:** Queries without a valid transaction tenant context must return zero rows or fail, never fall back to unscoped reads.
3. **Admin != financial approver:** Tenant administrator status alone never grants supplier-award or PO-release approval authority.
4. **Separation of duties:** Requester cannot approve their own request under default policy; any small-company owner exception must be explicitly configured, visible in the approval packet, and audited.
5. **Revalidate at decision/execution time:** Revoked membership, expired session, or reduced approval limit must fail at the server even if the UI already rendered an approve button.
6. **Runtime agents have zero approval authority:** Background workers and LLM agents cannot approve, grant roles, verify suppliers, or bypass policy.
7. **Protected non-table surfaces:** Document downloads, evidence previews, search hits, audit timelines, SSE streams, and AI usage records require the same tenant/resource authorization as CRUD routes.

## Relevant tests

- Real-PostgreSQL two-tenant isolation suite: Tenant B cannot read, mutate, download, stream, list history, or resume Tenant A's requests, suppliers, documents, quotes, approvals, POs, or graph threads.
- Missing tenant context fails closed under the runtime DB role (`FORCE ROW LEVEL SECURITY` verified).
- Requester self-approval denial, admin-without-authority denial, and revoked-approver race denial.

## Escalation / error behavior

- Missing/invalid session: `401` immediately at BFF/API.
- Cross-tenant resource reference: fail closed (`403`/`404`, never reveal existence or object metadata).
- Authority revoked or policy violation: return `POLICY_BLOCKED` / `APPROVAL_REQUIRED` envelope and record an audit event.

## Worked example

1. User in Tenant B sends `POST /api/v1/decisions/{tenant_a_decision_id}/approve` with a forged `X-Tenant-Id: tenant_a` header.
2. BFF ignores client tenant headers, resolves User B's active membership (`tenant_b`), and opens a DB transaction with `SET LOCAL app.current_tenant_id = 'tenant_b'`.
3. RLS and application scoping find no matching `approval_request` for `tenant_b`, returning `404` without exposing that `tenant_a_decision_id` exists.
