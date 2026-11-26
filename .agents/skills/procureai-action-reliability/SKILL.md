---
name: procureai-action-reliability
description: >-
  Governs ProcureAI transactional approval commits, canonical payload hashing,
  idempotency keys, transactional outbox events, unique PO numbering, and
  explicit unknown-result reconciliation. Use for approvals, PO finalization,
  exports, retries, cancellations, or any external side effect.
---

# ProcureAI Action Reliability & Idempotency

Consequential procurement actions—approvals, PO release, numbering, PDF generation, and future external dispatch—must be transactional, version-bound, idempotent, and safely recoverable.

## When to use it

- Implementing or modifying award approvals, PO release approvals, PO numbering, PDF artifact generation, durable job leases, outbox publishing, command deduplication, cancellations, or optional email dispatch.

## Minimum context to read

- [GLOSSARY.md](../../../GLOSSARY.md)
- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 14.3, 16.3, 17.1, 17.2)

## Inputs and outputs

- **Inputs:** Idempotency key scoped to `(tenant_id, operation, resource_id, payload_hash)`, expected entity version, canonical commercial payload hash, and authorized actor context.
- **Outputs:** Committed database state + transactional outbox event (`outbox_events`), deterministic replay response on duplicate key with identical payload, or conflict error on mismatch/stale version.

## Allowed operations

- Lock pending `ApprovalRequest` and target entity version inside one PostgreSQL transaction, re-verify authority/expiry/sources/hash, write `ApprovalDecision`, reserve optional budget, and insert the outbox continuation event atomically.
- Assign unique PO numbers per `(tenant_id, legal_entity_id)` only upon authorized final PO release, recording the PO number as finalization metadata without mutating approved commercial terms.
- Retry failed PDF rendering against the exact immutable approved PO payload (`approved_artifact_pending` -> `approved_ready_for_issue`).

## Key invariants

1. **Two distinct approval checkpoints initially:** Supplier award approval and final PO release approval are separate decisions unless policy explicitly covers a complete final PO payload.
2. **Stale terms invalidate approvals:** Any change to quantity, price, supplier, delivery, payment terms, or expired quote invalidates pending/prior approvals and returns `STALE_VERSION`.
3. **Scoped idempotency:** Replaying an idempotency key with the same payload returns the existing committed outcome; reusing a key with a different payload must fail.
4. **No duplicate POs:** Concurrent approve clicks, double submissions, worker crashes after commit, or outbox replays can never create a second PO or second PO number.
5. **Honest external uncertainty:** Never claim exactly-once delivery across external systems. If an optional provider call times out after submission, record `EXTERNAL_RESULT_UNKNOWN` and require reconciliation before resending.
6. **PDF hash != commercial payload hash:** Store the rendered PDF SHA-256 separately from the approved commercial payload hash.

## Relevant tests

- Concurrent approvals on the same packet (two parallel transactions) allow only required distinct decisions and create at most one PO.
- Duplicate approval click with same idempotency key returns original decision; reused key with altered payload fails.
- Quote revision update while approval packet is open forces `STALE_VERSION` rejection.
- Worker crash immediately after DB approval commit recovers cleanly via outbox replay.
- PDF renderer failure preserves `approved_artifact_pending` and retries cleanly on the exact same payload without re-numbering.

## Escalation / error behavior

- Version/hash mismatch: reject with `STALE_VERSION` and prompt regeneration of a fresh decision packet.
- Renderer failure: keep approval intact, mark artifact pending, alert operator after bounded retries, and allow safe idempotent retry.
- External timeout (future email/ERP): mark `EXTERNAL_RESULT_UNKNOWN`; block automatic resend until reconciled.

## Worked example

1. Approver submits `POST /api/v1/decisions/dec_9/approve` with `Idempotency-Key: k_123`, `expected_version: 3`, `payload_hash: sha256:abc`.
2. In one DB transaction: verify authority & separation of duties -> `SELECT ... FOR UPDATE` on `dec_9` -> confirm quote revisions unexpired and hash matches `sha256:abc` -> insert `ApprovalDecision` -> insert `outbox_events(type="po_release_approved")`.
3. Network drops before response reaches browser; client retries with `Idempotency-Key: k_123`.
4. Server finds existing `idempotency_records` match with identical payload hash and returns the exact original `200` response—no duplicate decision or PO.
