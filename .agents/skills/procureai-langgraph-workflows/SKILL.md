---
name: procureai-langgraph-workflows
description: >-
  Governs ProcureAI LangGraph state schemas, bounded agent roles, PostgreSQL
  checkpointing, durable pause/resume interrupts, worker restarts, and stale-run
  reconciliation. Use when creating or modifying graph nodes, edges, tools,
  checkpointers, or run-state projections.
---

# ProcureAI LangGraph Workflows

One bounded LangGraph workflow coordinates five specialized procurement roles over canonical PostgreSQL records.

## When to use it

- Designing or modifying graph state, routing edges, bounded agent role nodes (Purchase Request, Supplier Discovery, RFQ Management, Quotation Analysis, Purchase Order), tools, checkpointer setup, or resume/cancellation flows.

## Minimum context to read

- [GLOSSARY.md](../../../GLOSSARY.md)
- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 9.2, 10, 11, 17.1)

## Inputs and outputs

- **Inputs:** Trusted execution context (`tenant_id`, `actor_id`, current membership, allowed operation), durable `RunCommand`, and versioned `WorkflowState` containing small entity/artifact IDs (never raw document blobs).
- **Outputs:** Structured tool outcomes (`success | needs_input | blocked_by_policy | retryable_error | unknown_external_result`), persisted business mutations via domain services, updated checkpoints, and projected UI events.

## Allowed operations

- Route through explicit graph edges and typed state transitions.
- Persist `waiting_for_input` or `waiting_for_approval` at human checkpoints and terminate the active HTTP/SSE stream cleanly.
- Resume continuation only from an authorized, committed domain command/outbox event.
- Run independent quote extractions with bounded fan-out, merging by `quote_revision_id` and rejecting stale writes.

## Key invariants

1. **Canonical DB is truth; checkpoints are execution state:** Never treat LangGraph checkpoints or memory stores as the purchasing ledger. Re-read authoritative entities or approved snapshots from PostgreSQL.
2. **Five bounded roles, one modular monolith:** Implement Purchase Request, Supplier Discovery, RFQ Management, Quotation Analysis, and Purchase Order as bounded nodes/subgraphs—never 13 independent services or unrestricted chat loops.
3. **No side effects before human pauses:** Never place external dispatch, PO finalization, or non-idempotent mutations inside a node that can re-enter on resume.
4. **Constrained tool allowlist:** Model-facing tools include only scoped reads and draft proposals. Exclude `approve`, `grant_role`, `pay`, arbitrary SQL, arbitrary HTTP, and unrestricted file access.
5. **Isolated checkpointer schema:** Keep checkpoint tables in a private schema accessed exclusively through a tenant-mapped wrapper (`workflow_runs` lookup before every load/save/list/delete).
6. **Versioned state & prompts:** Record `schema_version`, `workflow_version`, and `prompt_bundle_version` on every run so upgrades cannot silently reinterpret prior approvals.
7. **Separate retry layers:** Keep gateway transient retries separate from graph/job retries to prevent multiplicative token burn.

## Relevant tests

- Pause at `waiting_for_approval`, restart worker container, verify state persists, then resume via committed domain approval endpoint.
- Double-resume / duplicate command replay produces no duplicate artifacts or state corruption.
- Cancellation stops eligible jobs cooperatively while preserving already-committed records.
- Stale entity version during continuation triggers reconciliation instead of overwriting newer revisions.

## Escalation / error behavior

- Model timeout or invalid schema after bounded retry: transition run to `failed` with structured error code (`MODEL_CAPABILITY_UNAVAILABLE` or validation code) while keeping the manual UI path usable.
- Disconnected SSE stream: do not roll back committed actions; reconnect by fetching authorized server state.

## Worked example

1. Quotation Analysis node finishes computing `Comparison` v3 and creates `ApprovalRequest` for award.
2. Graph persists `status = waiting_for_approval`, `pending_decision_id`, saves checkpoint, emits `ApprovalDecisionCard` projection, and closes the stream.
3. Worker restarts hours later.
4. Approver calls `POST /api/v1/decisions/{id}/approve`. Transaction commits `ApprovalDecision` and inserts an outbox continuation event.
5. Worker picks up outbox event, revalidates tenant/version, resumes graph into `PODraft` node, and never re-runs comparison or duplicates the award.
