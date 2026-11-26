from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select, text

from app.documents.pdf_generator import render_approved_po_pdf
from app.domain.models import (
    ApprovalDecision,
    ApprovalRequest,
    AuditEvent,
    IdempotencyRecord,
    OutboxEvent,
    PurchaseOrder,
    PurchaseRequest,
    RunEvent,
    Supplier,
    WorkflowRun,
    new_id,
)
from app.domain.money import canonical_payload_hash
from app.infrastructure.auth import ActorContext
from app.infrastructure.db import tenant_session
from app.infrastructure.storage import put_private_bytes


def _allocate_next_po_number(db, tenant_id: str) -> str:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
        {"lock_key": f"po_num:{tenant_id}"},
    )
    count = db.execute(
        select(func.count(PurchaseOrder.id)).where(
            PurchaseOrder.tenant_id == tenant_id,
            PurchaseOrder.po_number.is_not(None),
        )
    ).scalar_one()
    year = datetime.now(timezone.utc).year
    return f"PO-{year}-{int(count) + 1:04d}"


def submit_approval_decision(
    *,
    actor: ActorContext,
    decision_id: str,
    outcome: str,
    expected_version: int,
    expected_payload_hash: str,
    idempotency_key: str,
    note: str | None = None,
) -> dict[str, Any]:
    """
    Transactional, version-bound, hash-bound, idempotent human decision commit.
    Supports both authoritative checkpoints:
      1. `supplier_award`: unlocks Purchase Order drafting
      2. `po_release`: atomically assigns unique PO number & generates approved PO PDF in private RustFS
    """
    if outcome not in ("approved", "rejected", "changes_requested"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid decision outcome")
    if not idempotency_key or len(idempotency_key) > 128:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "IDEMPOTENCY_KEY_REQUIRED", "message": "Idempotency-Key header is required"},
        )

    operation = f"decision:{outcome}"
    req_hash = canonical_payload_hash(
        {
            "decision_id": decision_id,
            "outcome": outcome,
            "expected_version": expected_version,
            "expected_payload_hash": expected_payload_hash,
            "note": note or "",
        }
    )

    with tenant_session(actor.tenant_id) as db:
        existing_idem = db.execute(
            select(IdempotencyRecord).where(
                IdempotencyRecord.tenant_id == actor.tenant_id,
                IdempotencyRecord.operation == operation,
                IdempotencyRecord.resource_id == decision_id,
                IdempotencyRecord.idempotency_key == idempotency_key,
            )
        ).scalar_one_or_none()
        if existing_idem is not None:
            if existing_idem.request_payload_hash != req_hash:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "IDEMPOTENCY_PAYLOAD_MISMATCH",
                        "message": "Idempotency key was already used with a different payload.",
                    },
                )
            return dict(existing_idem.response_body_json)

        apr = db.execute(
            select(ApprovalRequest)
            .where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.id == decision_id,
            )
            .with_for_update()
        ).scalar_one_or_none()
        if apr is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"code": "NOT_FOUND", "message": "Approval request not found"},
            )

        if outcome == "approved":
            if apr.requester_user_id == actor.user_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "code": "POLICY_BLOCKED",
                        "message": "Separation of duties: requester cannot self-approve under default policy.",
                    },
                )
            if not actor.can_approve_amount(apr.amount, apr.currency_code):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "code": "POLICY_BLOCKED",
                        "message": "Current membership lacks active approver authority for this amount.",
                    },
                )
        else:
            if not actor.has_role("approver"):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "code": "POLICY_BLOCKED",
                        "message": "Approver role required to decide this packet.",
                    },
                )

        now = datetime.now(timezone.utc)
        if apr.expires_at < now:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "APPROVAL_EXPIRED", "message": "Approval request has expired; generate a fresh packet."},
            )
        if apr.status != "pending":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "ALREADY_DECIDED", "message": f"Approval request is already {apr.status}."},
            )
        if apr.entity_version != expected_version or apr.payload_hash != expected_payload_hash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "STALE_VERSION",
                    "message": "Commercial terms or entity version changed; review the updated packet before deciding.",
                },
            )

        run = db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.id == apr.run_id)
            .with_for_update()
        ).scalar_one()
        pr = db.execute(
            select(PurchaseRequest)
            .where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == apr.request_id)
            .with_for_update()
        ).scalar_one()

        decision_rec = ApprovalDecision(
            id=new_id("dec"),
            tenant_id=actor.tenant_id,
            approval_request_id=apr.id,
            actor_user_id=actor.user_id,
            outcome=outcome,
            note=note,
            payload_hash=apr.payload_hash,
            authority_basis=f"approver_limit_usd={actor.approval_limit_usd}",
        )
        db.add(decision_rec)
        db.flush()
        apr.status = outcome

        po_number: str | None = None
        po_id: str | None = None

        # Update business state immediately inside the same atomic transaction
        if apr.decision_type == "supplier_award":
            if outcome == "approved":
                pr.status = "award_approved"
                run.phase = "po_preparation"
                run.status = "waiting_for_input"
                run.pending_decision_id = None
            elif outcome == "rejected":
                pr.status = "rejected"
                run.phase = "rejected"
                run.status = "completed"
                run.pending_decision_id = None
            else:
                pr.status = "changes_requested"
                run.phase = "comparison"
                run.status = "waiting_for_input"
                run.pending_decision_id = None
        elif apr.decision_type == "po_release":
            po_id = (apr.packet_json or {}).get("po_id")
            po = (
                db.execute(
                    select(PurchaseOrder)
                    .where(PurchaseOrder.tenant_id == actor.tenant_id, PurchaseOrder.id == po_id)
                    .with_for_update()
                ).scalar_one_or_none()
                if po_id
                else None
            )
            if outcome == "approved" and po is not None:
                if not po.po_number:
                    po.po_number = _allocate_next_po_number(db, actor.tenant_id)
                po_number = po.po_number
                po.release_decision_id = decision_rec.id
                supplier = db.execute(
                    select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id == po.supplier_id)
                ).scalar_one()
                po_lang = str(
                    (po.commercial_payload_json or {}).get("document_language")
                    or getattr(pr, "document_language", None)
                    or actor.default_language
                    or "en"
                )
                pdf_bytes = render_approved_po_pdf(
                    tenant_name=actor.tenant_name,
                    po_number=po.po_number,
                    request_ref=pr.reference_code,
                    supplier_name=supplier.name,
                    supplier_email=supplier.contact_email,
                    commercial_payload=po.commercial_payload_json,
                    payload_hash=po.payload_hash,
                    award_decision_id=po.award_decision_id,
                    release_decision_id=decision_rec.id,
                    approver_name=actor.display_name,
                    authority_basis=decision_rec.authority_basis,
                    lang=po_lang,
                )
                obj_key, pdf_hash = put_private_bytes(
                    tenant_id=actor.tenant_id,
                    category="purchase_orders",
                    resource_id=po.id,
                    filename=f"{po.po_number}.pdf",
                    data=pdf_bytes,
                    content_type="application/pdf",
                )
                po.pdf_object_key = obj_key
                po.pdf_sha256 = pdf_hash
                po.status = "approved_ready_for_issue"
                pr.status = "po_approved_ready_for_issue"
                run.phase = "completed"
                run.status = "completed"
                run.pending_decision_id = None
            elif outcome == "rejected" and po is not None:
                po.status = "rejected"
                pr.status = "rejected"
                run.phase = "rejected"
                run.status = "completed"
                run.pending_decision_id = None
            elif po is not None:
                po.status = "changes_requested"
                pr.status = "award_approved"
                run.phase = "po_preparation"
                run.status = "waiting_for_input"
                run.pending_decision_id = None
        else:
            if outcome == "approved":
                pr.status = "confirmed"
                run.phase = "sourcing"
                run.status = "waiting_for_input"
                run.pending_decision_id = None
            elif outcome == "rejected":
                pr.status = "rejected"
                run.status = "completed"
                run.pending_decision_id = None
            else:
                pr.status = "changes_requested"
                run.status = "waiting_for_input"
                run.pending_decision_id = None

        outbox_id = new_id("obx")
        db.add(
            OutboxEvent(
                id=outbox_id,
                tenant_id=actor.tenant_id,
                event_type="decision_committed",
                aggregate_id=run.id,
                payload_json={
                    "tenant_id": actor.tenant_id,
                    "run_id": run.id,
                    "thread_id": run.thread_id,
                    "approval_request_id": apr.id,
                    "decision_id": decision_rec.id,
                    "decision_type": apr.decision_type,
                    "outcome": outcome,
                    "po_number": po_number,
                },
                status="pending",
            )
        )
        db.execute(text("SELECT pg_notify('procureai_outbox', :eid)"), {"eid": outbox_id})

        db.add(
            RunEvent(
                tenant_id=actor.tenant_id,
                run_id=run.id,
                event_type="approval_decided",
                payload_json={
                    "approval_request_id": apr.id,
                    "decision_id": decision_rec.id,
                    "decision_type": apr.decision_type,
                    "outcome": outcome,
                    "po_number": po_number,
                    "actor_user_id": actor.user_id,
                    "actor_display_name": actor.display_name,
                    "note": note,
                },
            )
        )

        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action=f"approval_{apr.decision_type}_{outcome}",
                resource_type="approval_request",
                resource_id=apr.id,
                metadata_json={
                    "decision_id": decision_rec.id,
                    "payload_hash": apr.payload_hash,
                    "entity_version": apr.entity_version,
                    "outbox_id": outbox_id,
                    "po_number": po_number,
                },
            )
        )

        response_body = {
            "decision_id": decision_rec.id,
            "approval_request_id": apr.id,
            "decision_type": apr.decision_type,
            "run_id": run.id,
            "outcome": outcome,
            "payload_hash": apr.payload_hash,
            "outbox_event_id": outbox_id,
            "decided_by": actor.display_name,
            "authority_basis": decision_rec.authority_basis,
            "po_id": po_id,
            "po_number": po_number,
        }

        db.add(
            IdempotencyRecord(
                id=new_id("idm"),
                tenant_id=actor.tenant_id,
                operation=operation,
                resource_id=decision_id,
                idempotency_key=idempotency_key,
                request_payload_hash=req_hash,
                response_status=200,
                response_body_json=response_body,
            )
        )
        return response_body
