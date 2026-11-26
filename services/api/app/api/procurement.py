from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from app.application.sourcing import (
    build_rfq_email_drafts,
    discover_and_extract_real_suppliers,
    extract_quotation_from_document,
    send_rfq_email_smtp,
    verify_quotations_mandatory_specs_batch,
)
from app.config import settings
from app.documents.pdf_generator import render_example_quotation_pdf, render_rfq_pdf
from app.domain.comparison import evaluate_comparison
from app.domain.models import (
    ApprovalDecision,
    ApprovalRequest,
    AuditEvent,
    Comparison,
    PurchaseOrder,
    PurchaseRequest,
    Quotation,
    RequestVersion,
    Rfq,
    RunEvent,
    Supplier,
    WorkflowRun,
    new_id,
)
from app.domain.money import (
    SUPPORTED_CURRENCIES,
    canonical_payload_hash,
    format_money_str,
    parse_decimal,
    quantize_money,
)
from app.infrastructure.auth import ActorContext, get_current_actor
from app.infrastructure.db import tenant_session
from app.infrastructure.openrouter import ModelGatewayError
from app.infrastructure.storage import get_private_bytes, put_private_bytes

router = APIRouter(prefix="/api/v1", tags=["procurement"])


class RequestPatchBody(BaseModel):
    title: str = Field(min_length=2, max_length=300)
    item_summary: str = Field(min_length=2, max_length=500)
    quantity: int = Field(ge=1, le=1000000)
    unit: str = Field(min_length=1, max_length=40)
    budget_cap: str | None = None
    currency_code: str = Field(default="TND", min_length=3, max_length=3)
    location: str | None = Field(default=None, max_length=200)
    document_language: str | None = Field(default=None, max_length=8)
    apply_fiscal_stamp: bool = Field(default=False)
    delivery_window_days: int | None = Field(default=None, ge=1, le=365)
    mandatory_specs: list[str] = Field(default_factory=list)
    confirm: bool = Field(default=True)


class SupplierCreateBody(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    category: str = Field(default="General", max_length=120)
    contact_email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    website_url: str | None = Field(default=None, max_length=500)
    source_url: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=1000)


class SupplierPatchBody(BaseModel):
    contact_email: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    notes: str | None = Field(default=None, max_length=1000)


class RealSupplierSearchBody(BaseModel):
    product_query: str = Field(min_length=2, max_length=240)
    location: str | None = Field(default=None, max_length=120)
    currency: str = Field(default="TND", min_length=3, max_length=3)
    max_results: int = Field(default=5, ge=1, le=6)


class RfqSendEmailsBody(BaseModel):
    supplier_ids: list[str] = Field(min_length=1, max_length=20)
    confirm_human_review: bool = Field(default=False)
    lang: str | None = Field(default=None, max_length=8)


class SupplierCsvImportBody(BaseModel):
    csv_text: str = Field(min_length=5, max_length=50000)
    confirm: bool = Field(default=False)


class RfqCreateBody(BaseModel):
    supplier_ids: list[str] = Field(min_length=1, max_length=20)
    response_deadline_days: int = Field(default=5, ge=1, le=60)
    lang: str | None = Field(default=None, max_length=8)


class RfqDistributeBody(BaseModel):
    note: str = Field(default="Exported RFQ PDF shared with selected suppliers via email.", max_length=500)


class QuotationCreateBody(BaseModel):
    supplier_id: str
    quote_code: str | None = None
    currency_code: str = Field(default="USD", min_length=3, max_length=3)
    quantity: int = Field(ge=1)
    unit_price: str
    discount_amount: str = Field(default="0.00")
    freight_amount: str | None = None
    quoted_tax_amount: str | None = None
    fiscal_stamp_amount: str | None = None
    delivery_days: int | None = Field(default=None, ge=1, le=365)
    warranty_months: int | None = Field(default=12, ge=0, le=120)
    payment_terms: str = Field(default="Net 30", max_length=64)
    meets_mandatory_specs: bool = Field(default=True)
    offered_specs_text: str | None = Field(default=None, max_length=600)
    valid_days: int = Field(default=30, ge=-30, le=365)
    source_filename: str | None = None


class QuotationCorrectionBody(BaseModel):
    unit_price: str | None = None
    freight_amount: str | None = None
    quoted_tax_amount: str | None = None
    fiscal_stamp_amount: str | None = None
    delivery_days: int | None = Field(default=None, ge=1, le=365)
    meets_mandatory_specs: bool | None = None
    spec_status_override: str | None = Field(default=None, max_length=32)
    reason: str = Field(min_length=3, max_length=300)


class AwardReviewBody(BaseModel):
    quotation_id: str
    justification: str | None = Field(default=None, max_length=600)


class ExternalIssueBody(BaseModel):
    note: str = Field(min_length=3, max_length=500)


class SeedExampleQuotesBody(BaseModel):
    supplier_ids: list[str] | None = Field(default=None, max_length=10)
    replace_existing_demo_quotes: bool = Field(default=True)
    lang: str | None = Field(default=None, max_length=8)


def _require_buyer_or_requester(actor: ActorContext) -> None:
    if not (actor.has_role("requester") or actor.has_role("buyer") or actor.has_role("tenant_admin")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "POLICY_BLOCKED", "message": "Requester or buyer role required."},
        )


@router.post("/requests/demo-20-laptops", status_code=status.HTTP_201_CREATED)
def create_demo_20_laptops_request(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """Creates a clean, real persisted 20-laptop purchase request ready for immediate end-to-end walkthrough."""
    _require_buyer_or_requester(actor)
    req_id = new_id("pr")
    run_id = new_id("run")
    thread_id = f"thr_{actor.tenant_id}_{uuid.uuid4().hex[:12]}"
    ref_code = f"PR-{uuid.uuid4().hex[:4].upper()}"

    payload = {
        "schema_version": "m1.v1",
        "request_id": req_id,
        "version_number": 1,
        "title": "20 development laptops for Engineering",
        "item_summary": "14-inch business development laptops",
        "quantity": 20,
        "unit": "laptops",
        "currency_code": "USD",
        "budget_cap": "20000.00",
        "delivery_window_days": 15,
        "mandatory_specs": ["Core i7 or equivalent", "16 GB RAM", "512 GB NVMe SSD"],
    }
    p_hash = canonical_payload_hash(payload)

    with tenant_session(actor.tenant_id) as db:
        db.add(
            PurchaseRequest(
                id=req_id,
                tenant_id=actor.tenant_id,
                reference_code=ref_code,
                requester_user_id=actor.user_id,
                title=payload["title"],
                status="confirmed",
                current_version=1,
                currency_code="USD",
                budget_cap=Decimal("20000.00"),
            )
        )
        db.flush()
        db.add(
            RequestVersion(
                id=new_id("prv"),
                tenant_id=actor.tenant_id,
                request_id=req_id,
                version_number=1,
                raw_prompt="20 development laptops for engineering, max budget $20,000, delivered within 15 days (Core i7, 16GB RAM, 512GB SSD).",
                structured_payload_json=payload,
                missing_fields_json=[],
                payload_hash=p_hash,
                created_by_user_id=actor.user_id,
            )
        )
        db.add(
            WorkflowRun(
                id=run_id,
                tenant_id=actor.tenant_id,
                thread_id=thread_id,
                request_id=req_id,
                actor_user_id=actor.user_id,
                schema_version="m1.v1",
                workflow_version="procureai.mvp.1",
                prompt_bundle_version="demo.20laptops.v1",
                phase="sourcing",
                status="waiting_for_input",
                state_projection_json={
                    "draft_card": {
                        "card_type": "RequestDraftCard",
                        "schema_version": "m1.v1",
                        "request_id": req_id,
                        "entity_version": 1,
                        **payload,
                        "missing_fields": [],
                        "clarification_questions": [],
                        "summary_explanation": "Confirmed canonical 20-laptop purchase request ready for supplier selection and RFQ export.",
                    },
                    "react_trace": [
                        {
                            "step": 1,
                            "max_steps": 3,
                            "thought": "Loaded confirmed 20-laptop requirements with explicit specs, $20,000 cap, and 15-day deadline.",
                            "action": "load_confirmed_request",
                            "observation": f"Request {ref_code} v1 confirmed (0 LLM tokens consumed).",
                            "status": "completed",
                        }
                    ],
                    "external_leads": [],
                },
            )
        )
        db.flush()
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="demo_request_created",
                resource_type="purchase_request",
                resource_id=req_id,
                metadata_json={"reference_code": ref_code},
            )
        )
    return {"request_id": req_id, "run_id": run_id, "reference_code": ref_code}


@router.post("/requests/preset-sousse-tnd", status_code=status.HTTP_201_CREATED)
def create_preset_sousse_tnd_request(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """Creates a confirmed Tunisia Sousse TND showcase request (with 1.000 TND Timbre Fiscal & FR/EN ready)."""
    _require_buyer_or_requester(actor)
    req_id = new_id("pr")
    run_id = new_id("run")
    thread_id = f"thr_{actor.tenant_id}_{uuid.uuid4().hex[:12]}"
    ref_code = f"PR-TN-{uuid.uuid4().hex[:4].upper()}"
    doc_lang = "fr" if (actor.default_language or "fr").lower().startswith("fr") else "fr"

    payload = {
        "schema_version": "m1.v2",
        "request_id": req_id,
        "version_number": 1,
        "title": "10 PC Portables Professionnels — Agence Sousse",
        "item_summary": "PC portable professionnel 14 pouces (Lenovo ThinkPad / Dell Latitude)",
        "quantity": 10,
        "unit": "unités",
        "currency_code": "TND",
        "location": "Sousse, Tunisia",
        "document_language": doc_lang,
        "apply_fiscal_stamp": True,
        "budget_cap": "25000.000",
        "delivery_window_days": 10,
        "mandatory_specs": ["Core i7", "16 GB RAM", "512 GB NVMe SSD"],
    }
    p_hash = canonical_payload_hash(payload)

    with tenant_session(actor.tenant_id) as db:
        db.add(
            PurchaseRequest(
                id=req_id,
                tenant_id=actor.tenant_id,
                reference_code=ref_code,
                requester_user_id=actor.user_id,
                title=payload["title"],
                status="confirmed",
                current_version=1,
                currency_code="TND",
                location="Sousse, Tunisia",
                document_language=doc_lang,
                apply_fiscal_stamp=True,
                budget_cap=Decimal("25000.000"),
            )
        )
        db.flush()
        db.add(
            RequestVersion(
                id=new_id("prv"),
                tenant_id=actor.tenant_id,
                request_id=req_id,
                version_number=1,
                raw_prompt="10 PC portables professionnels à Sousse, Tunisie, budget max 25 000.000 TND, livraison sous 10 jours (Core i7, 16 GB RAM, 512 GB NVMe SSD).",
                structured_payload_json=payload,
                missing_fields_json=[],
                payload_hash=p_hash,
                created_by_user_id=actor.user_id,
            )
        )
        db.add(
            WorkflowRun(
                id=run_id,
                tenant_id=actor.tenant_id,
                thread_id=thread_id,
                request_id=req_id,
                actor_user_id=actor.user_id,
                schema_version="m1.v2",
                workflow_version="procureai.showcase.1",
                prompt_bundle_version="preset.sousse.tnd.v1",
                phase="sourcing",
                status="waiting_for_input",
                state_projection_json={
                    "draft_card": {
                        "card_type": "RequestDraftCard",
                        "schema_version": "m1.v2",
                        "request_id": req_id,
                        "entity_version": 1,
                        **payload,
                        "missing_fields": [],
                        "clarification_questions": [],
                        "summary_explanation": "Demande confirmée (Sousse, Tunisie · TND · Timbre Fiscal 1.000 TND activé).",
                    },
                    "react_trace": [
                        {
                            "step": 1,
                            "max_steps": 3,
                            "thought": "Preset Sousse/Tunisie chargé avec devise TND (millimes), Timbre Fiscal 1.000 TND et spécifications complètes.",
                            "action": "load_sousse_tnd_preset",
                            "observation": f"Demande {ref_code} v1 prête pour la recherche fournisseurs Tavily à Sousse (0 jeton LLM consommé).",
                            "status": "completed",
                        }
                    ],
                    "external_leads": [],
                },
            )
        )
        db.flush()
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="preset_sousse_tnd_created",
                resource_type="purchase_request",
                resource_id=req_id,
                metadata_json={"reference_code": ref_code, "currency": "TND"},
            )
        )
    return {"request_id": req_id, "run_id": run_id, "reference_code": ref_code}


@router.get("/requests/{request_id}/workspace")
def get_request_workspace(request_id: str, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(
                PurchaseRequest.tenant_id == actor.tenant_id,
                PurchaseRequest.id == request_id,
            )
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "Purchase request not found"})

        versions = db.execute(
            select(RequestVersion)
            .where(RequestVersion.tenant_id == actor.tenant_id, RequestVersion.request_id == request_id)
            .order_by(desc(RequestVersion.version_number))
        ).scalars().all()
        latest_ver = versions[0] if versions else None

        run = db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.request_id == request_id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(1)
        ).scalar_one_or_none()

        rfqs = db.execute(
            select(Rfq)
            .where(Rfq.tenant_id == actor.tenant_id, Rfq.request_id == request_id)
            .order_by(desc(Rfq.created_at))
        ).scalars().all()

        quotes = db.execute(
            select(Quotation, Supplier)
            .join(Supplier, Quotation.supplier_id == Supplier.id)
            .where(Quotation.tenant_id == actor.tenant_id, Quotation.request_id == request_id)
            .order_by(Quotation.created_at.asc())
        ).all()

        latest_comp = db.execute(
            select(Comparison)
            .where(Comparison.tenant_id == actor.tenant_id, Comparison.request_id == request_id)
            .order_by(desc(Comparison.version_number))
            .limit(1)
        ).scalar_one_or_none()

        pending_apr = db.execute(
            select(ApprovalRequest)
            .where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.request_id == request_id,
                ApprovalRequest.status == "pending",
            )
            .order_by(desc(ApprovalRequest.created_at))
            .limit(1)
        ).scalar_one_or_none()

        all_decisions = db.execute(
            select(ApprovalDecision, ApprovalRequest)
            .join(ApprovalRequest, ApprovalDecision.approval_request_id == ApprovalRequest.id)
            .where(ApprovalRequest.tenant_id == actor.tenant_id, ApprovalRequest.request_id == request_id)
            .order_by(ApprovalDecision.decided_at.asc())
        ).all()

        po = db.execute(
            select(PurchaseOrder)
            .where(PurchaseOrder.tenant_id == actor.tenant_id, PurchaseOrder.request_id == request_id)
            .order_by(desc(PurchaseOrder.created_at))
            .limit(1)
        ).scalar_one_or_none()

        supplier_map = {
            s.id: s.name
            for s in db.execute(select(Supplier).where(Supplier.tenant_id == actor.tenant_id)).scalars().all()
        }

        return {
            "request": {
                "id": pr.id,
                "reference_code": pr.reference_code,
                "title": pr.title,
                "status": pr.status,
                "current_version": pr.current_version,
                "currency_code": pr.currency_code,
                "location": pr.location,
                "document_language": pr.document_language or "en",
                "apply_fiscal_stamp": bool(pr.apply_fiscal_stamp),
                "budget_cap": str(pr.budget_cap) if pr.budget_cap is not None else None,
                "requester_user_id": pr.requester_user_id,
                "created_at": pr.created_at.isoformat(),
                "updated_at": pr.updated_at.isoformat(),
            },
            "latest_version": {
                "version_number": latest_ver.version_number,
                "payload": latest_ver.structured_payload_json,
                "missing_fields": latest_ver.missing_fields_json,
                "payload_hash": latest_ver.payload_hash,
                "created_at": latest_ver.created_at.isoformat(),
            }
            if latest_ver
            else None,
            "version_count": len(versions),
            "run": {
                "run_id": run.id,
                "phase": run.phase,
                "status": run.status,
                "projection": run.state_projection_json,
                "last_error_code": run.last_error_code,
                "last_error_message": run.last_error_message,
            }
            if run
            else None,
            "rfqs": [
                {
                    "id": r.id,
                    "rfq_code": r.rfq_code,
                    "request_version": r.request_version,
                    "supplier_ids": r.supplier_ids_json,
                    "supplier_names": [supplier_map.get(sid, sid) for sid in (r.supplier_ids_json or [])],
                    "response_deadline_days": r.response_deadline_days,
                    "status": r.status,
                    "has_pdf": bool(r.pdf_object_key),
                    "distribution_note": r.distribution_note,
                    "distributed_at": r.distributed_at.isoformat() if r.distributed_at else None,
                    "created_at": r.created_at.isoformat(),
                }
                for r in rfqs
            ],
            "quotations": [
                {
                    "id": q.id,
                    "quote_code": q.quote_code,
                    "revision_number": q.revision_number,
                    "supplier_id": s.id,
                    "supplier_name": s.name,
                    "currency_code": q.currency_code,
                    "quantity": q.quantity,
                    "unit_price": str(q.unit_price),
                    "discount_amount": str(q.discount_amount),
                    "freight_amount": str(q.freight_amount) if q.freight_amount is not None else None,
                    "quoted_tax_amount": str(q.quoted_tax_amount) if q.quoted_tax_amount is not None else None,
                    "fiscal_stamp_amount": str(q.fiscal_stamp_amount or Decimal("0.000")),
                    "delivery_days": q.delivery_days,
                    "warranty_months": q.warranty_months,
                    "payment_terms": q.payment_terms,
                    "meets_mandatory_specs": q.meets_mandatory_specs,
                    "valid_until": q.valid_until.isoformat(),
                    "source_filename": q.source_filename,
                    "has_source_file": bool(q.source_object_key),
                    "is_demo_example": bool((q.evidence_json or {}).get("is_demo_example")),
                    "offered_specs_text": (q.evidence_json or {}).get("offered_specs_text"),
                    "spec_verification": (q.evidence_json or {}).get("spec_verification"),
                    "corrections": q.corrections_json or [],
                    "confirmed": q.confirmed,
                }
                for q, s in quotes
            ],
            "latest_comparison": {
                "id": latest_comp.id,
                "version_number": latest_comp.version_number,
                "request_version": latest_comp.request_version,
                "recommended_quotation_id": latest_comp.recommended_quotation_id,
                "explanation": latest_comp.explanation,
                "result": latest_comp.result_json,
                "created_at": latest_comp.created_at.isoformat(),
            }
            if latest_comp
            else None,
            "pending_approval": {
                "id": pending_apr.id,
                "decision_type": pending_apr.decision_type,
                "entity_version": pending_apr.entity_version,
                "payload_hash": pending_apr.payload_hash,
                "amount": str(pending_apr.amount),
                "currency_code": pending_apr.currency_code,
                "requester_user_id": pending_apr.requester_user_id,
                "can_current_actor_approve": bool(
                    actor.user_id != pending_apr.requester_user_id
                    and actor.can_approve_amount(pending_apr.amount, pending_apr.currency_code)
                ),
                "status": pending_apr.status,
                "packet": pending_apr.packet_json,
                "expires_at": pending_apr.expires_at.isoformat(),
            }
            if pending_apr
            else None,
            "decisions": [
                {
                    "id": dec.id,
                    "decision_type": apr.decision_type,
                    "outcome": dec.outcome,
                    "actor_user_id": dec.actor_user_id,
                    "authority_basis": dec.authority_basis,
                    "payload_hash": dec.payload_hash,
                    "note": dec.note,
                    "decided_at": dec.decided_at.isoformat(),
                }
                for dec, apr in all_decisions
            ],
            "purchase_order": {
                "id": po.id,
                "po_number": po.po_number,
                "status": po.status,
                "supplier_id": po.supplier_id,
                "supplier_name": supplier_map.get(po.supplier_id, po.supplier_id),
                "currency_code": po.currency_code,
                "total_amount": str(po.total_amount),
                "commercial_payload": po.commercial_payload_json,
                "payload_hash": po.payload_hash,
                "has_pdf": bool(po.pdf_object_key),
                "pdf_sha256": po.pdf_sha256,
                "external_issue_note": po.external_issue_note,
                "externally_issued_at": po.externally_issued_at.isoformat() if po.externally_issued_at else None,
            }
            if po
            else None,
        }


@router.patch("/requests/{request_id}")
def update_and_confirm_request(
    request_id: str,
    body: RequestPatchBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """
    Persists edits to a Purchase Request as a new immutable RequestVersion (v+1),
    recomputes canonical SHA-256 hash, updates run projection, and invalidates stale pending approvals.
    """
    _require_buyer_or_requester(actor)
    currency = body.currency_code.upper()
    budget_dec = parse_decimal(body.budget_cap, "budget_cap") if body.budget_cap not in (None, "") else None
    budget_str = format_money_str(budget_dec, currency) if budget_dec is not None else None

    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest)
            .where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
            .with_for_update()
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "Request not found"})

        next_version = pr.current_version + 1
        specs = [s.strip() for s in body.mandatory_specs if s and s.strip()]
        doc_lang = "fr" if (body.document_language or pr.document_language or actor.default_language or "en").lower().startswith("fr") else "en"
        use_stamp = bool(body.apply_fiscal_stamp and currency == "TND")
        canonical = {
            "schema_version": "m1.v2",
            "request_id": pr.id,
            "version_number": next_version,
            "title": body.title.strip(),
            "item_summary": body.item_summary.strip(),
            "quantity": body.quantity,
            "unit": body.unit.strip(),
            "currency_code": currency,
            "location": body.location.strip() if body.location else None,
            "document_language": doc_lang,
            "apply_fiscal_stamp": use_stamp,
            "budget_cap": budget_str,
            "delivery_window_days": body.delivery_window_days,
            "mandatory_specs": specs,
        }
        p_hash = canonical_payload_hash(canonical)

        pr.title = body.title.strip()[:300]
        pr.currency_code = currency
        pr.location = body.location.strip()[:200] if body.location else None
        pr.document_language = doc_lang
        pr.apply_fiscal_stamp = use_stamp
        pr.budget_cap = budget_dec
        pr.current_version = next_version
        pr.status = "confirmed" if body.confirm else "draft_ready"

        db.add(
            RequestVersion(
                id=new_id("prv"),
                tenant_id=actor.tenant_id,
                request_id=pr.id,
                version_number=next_version,
                raw_prompt=f"Human edit v{next_version}: {body.title.strip()}",
                structured_payload_json=canonical,
                missing_fields_json=[],
                payload_hash=p_hash,
                created_by_user_id=actor.user_id,
            )
        )

        # Invalidate any pending approvals bound to previous request versions
        stale_aprs = db.execute(
            select(ApprovalRequest).where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.request_id == pr.id,
                ApprovalRequest.status == "pending",
            )
        ).scalars().all()
        for sap in stale_aprs:
            sap.status = "superseded"

        run = db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.request_id == pr.id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(1)
        ).scalar_one_or_none()
        if run is not None:
            proj = dict(run.state_projection_json or {})
            old_draft = dict(proj.get("draft_card") or {})
            proj["draft_card"] = {
                **old_draft,
                "card_type": "RequestDraftCard",
                "schema_version": "m1.v1",
                "request_id": pr.id,
                "entity_version": next_version,
                **canonical,
                "missing_fields": [],
            }
            run.state_projection_json = proj
            run.phase = "sourcing" if body.confirm else "draft_ready"
            run.status = "waiting_for_input"
            run.pending_decision_id = None
            db.add(
                RunEvent(
                    tenant_id=actor.tenant_id,
                    run_id=run.id,
                    event_type="request_amended",
                    payload_json={"version_number": next_version, "payload_hash": p_hash, "confirmed": body.confirm},
                )
            )

        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="request_version_saved",
                resource_type="purchase_request",
                resource_id=pr.id,
                metadata_json={"version_number": next_version, "confirmed": body.confirm, "invalidated_approvals": len(stale_aprs)},
            )
        )

    return {
        "request_id": request_id,
        "version_number": next_version,
        "payload_hash": p_hash,
        "status": "confirmed" if body.confirm else "draft_ready",
        "invalidated_pending_approvals": len(stale_aprs),
    }


@router.get("/suppliers")
def list_suppliers(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    with tenant_session(actor.tenant_id) as db:
        rows = db.execute(
            select(Supplier)
            .where(Supplier.tenant_id == actor.tenant_id)
            .order_by(Supplier.created_at.desc())
        ).scalars().all()
        return {
            "tenant_id": actor.tenant_id,
            "suppliers": [
                {
                    "id": s.id,
                    "name": s.name,
                    "category": s.category,
                    "contact_email": s.contact_email,
                    "phone": s.phone,
                    "location": s.location,
                    "website_url": s.website_url,
                    "source_url": s.source_url,
                    "verification_status": s.verification_status,
                    "notes": s.notes,
                }
                for s in rows
            ],
        }


@router.post("/suppliers/search-extract")
def search_and_extract_suppliers(
    body: RealSupplierSearchBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """Real live Tavily web search + DeepSeek V4.1 Flash extraction for products, suppliers, emails, phones, and local prices."""
    _require_buyer_or_requester(actor)
    try:
        return discover_and_extract_real_suppliers(
            tenant_id=actor.tenant_id,
            actor_user_id=actor.user_id,
            product_query=body.product_query,
            location=body.location,
            currency=body.currency,
            max_results=body.max_results,
        )
    except ModelGatewayError as exc:
        code_status = (
            status.HTTP_403_FORBIDDEN
            if exc.code == "POLICY_BLOCKED"
            else status.HTTP_429_TOO_MANY_REQUESTS
            if exc.code == "USAGE_LIMIT_REACHED"
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(status_code=code_status, detail={"code": exc.code, "message": exc.message}) from exc


@router.post("/suppliers", status_code=status.HTTP_201_CREATED)
def create_supplier(body: SupplierCreateBody, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    sup_id = new_id("sup")
    with tenant_session(actor.tenant_id) as db:
        db.add(
            Supplier(
                id=sup_id,
                tenant_id=actor.tenant_id,
                name=body.name.strip(),
                category=body.category.strip(),
                contact_email=body.contact_email.strip() if body.contact_email else None,
                phone=body.phone.strip() if body.phone else None,
                location=body.location.strip() if body.location else None,
                website_url=body.website_url.strip() if body.website_url else None,
                source_url=body.source_url.strip() if body.source_url else None,
                verification_status="unverified",
                notes=body.notes,
            )
        )
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="supplier_candidate_added",
                resource_type="supplier",
                resource_id=sup_id,
                metadata_json={"name": body.name.strip(), "verification_status": "unverified"},
            )
        )
    return {"id": sup_id, "name": body.name.strip(), "verification_status": "unverified"}


@router.patch("/suppliers/{supplier_id}")
def update_supplier_contact(
    supplier_id: str,
    body: SupplierPatchBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        sup = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id == supplier_id)
        ).scalar_one_or_none()
        if sup is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found")
        if body.contact_email is not None:
            sup.contact_email = body.contact_email.strip() or None
        if body.phone is not None:
            sup.phone = body.phone.strip() or None
        if body.location is not None:
            sup.location = body.location.strip() or None
        if body.notes is not None:
            sup.notes = body.notes.strip() or None
    return {"id": supplier_id, "updated": True}


@router.delete("/suppliers/{supplier_id}")
def delete_supplier(supplier_id: str, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        sup = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id == supplier_id)
        ).scalar_one_or_none()
        if sup is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found")
        has_quotes = db.execute(
            select(Quotation.id).where(Quotation.tenant_id == actor.tenant_id, Quotation.supplier_id == supplier_id).limit(1)
        ).first()
        if has_quotes:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "SUPPLIER_IN_USE", "message": "Cannot delete a supplier referenced by existing quotations."},
            )
        db.delete(sup)
    return {"id": supplier_id, "deleted": True}


@router.post("/suppliers/{supplier_id}/verify")
def verify_supplier(supplier_id: str, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    if not (actor.has_role("buyer") or actor.has_role("tenant_admin")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "POLICY_BLOCKED", "message": "Only a buyer or tenant admin can verify a supplier."},
        )
    with tenant_session(actor.tenant_id) as db:
        sup = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id == supplier_id)
        ).scalar_one_or_none()
        if sup is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "Supplier not found"})
        sup.verification_status = "approved"
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="supplier_verified",
                resource_type="supplier",
                resource_id=supplier_id,
                metadata_json={"name": sup.name},
            )
        )
    return {"id": supplier_id, "verification_status": "approved"}


@router.post("/suppliers/import-csv")
def import_suppliers_csv(body: SupplierCsvImportBody, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    reader = csv.DictReader(io.StringIO(body.csv_text.strip()))
    valid_rows: list[dict[str, str]] = []
    errors: list[str] = []
    duplicates: list[str] = []

    with tenant_session(actor.tenant_id) as db:
        existing_names = {
            s.name.strip().lower()
            for s in db.execute(select(Supplier).where(Supplier.tenant_id == actor.tenant_id)).scalars().all()
        }
        seen_in_csv: set[str] = set()
        for idx, row in enumerate(reader, start=2):
            name = (row.get("name") or "").strip()
            if not name:
                errors.append(f"Row {idx}: missing required 'name'")
                continue
            low = name.lower()
            if low in existing_names or low in seen_in_csv:
                duplicates.append(f"Row {idx}: duplicate supplier '{name}'")
                continue
            seen_in_csv.add(low)
            valid_rows.append(
                {
                    "name": name[:200],
                    "category": (row.get("category") or "General").strip()[:120],
                    "contact_email": (row.get("contact_email") or "").strip()[:255],
                    "website_url": (row.get("website_url") or "").strip()[:500],
                }
            )

        imported = 0
        if body.confirm and valid_rows:
            for item in valid_rows:
                db.add(
                    Supplier(
                        id=new_id("sup"),
                        tenant_id=actor.tenant_id,
                        name=item["name"],
                        category=item["category"],
                        contact_email=item["contact_email"] or None,
                        website_url=item["website_url"] or None,
                        verification_status="unverified",
                    )
                )
                imported += 1

    return {
        "preview_only": not body.confirm,
        "valid_count": len(valid_rows),
        "imported_count": imported,
        "errors": errors,
        "duplicates": duplicates,
        "valid_rows": valid_rows,
    }


@router.post("/requests/{request_id}/rfqs", status_code=status.HTTP_201_CREATED)
def create_and_export_rfq(
    request_id: str,
    body: RfqCreateBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    rfq_id = new_id("rfq")
    rfq_code = f"RFQ-{uuid.uuid4().hex[:5].upper()}"

    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "Request not found"})

        latest_ver = db.execute(
            select(RequestVersion)
            .where(RequestVersion.tenant_id == actor.tenant_id, RequestVersion.request_id == request_id)
            .order_by(desc(RequestVersion.version_number))
            .limit(1)
        ).scalar_one_or_none()
        if latest_ver is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "MISSING_VERSION", "message": "Confirm request requirements first."})

        suppliers = db.execute(
            select(Supplier).where(
                Supplier.tenant_id == actor.tenant_id,
                Supplier.id.in_(body.supplier_ids),
            )
        ).scalars().all()
        if not suppliers:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail={"code": "INVALID_SUPPLIERS", "message": "Select at least one valid tenant supplier."})

        rfq_lang = "fr" if (body.lang or pr.document_language or actor.default_language or "en").lower().startswith("fr") else "en"
        pdf_bytes = render_rfq_pdf(
            tenant_name=actor.tenant_name,
            rfq_code=rfq_code,
            request_ref=pr.reference_code,
            request_version=latest_ver.version_number,
            request_payload=latest_ver.structured_payload_json,
            supplier_names=[s.name for s in suppliers],
            response_deadline_days=body.response_deadline_days,
            lang=rfq_lang,
        )
        obj_key, _ = put_private_bytes(
            tenant_id=actor.tenant_id,
            category="rfqs",
            resource_id=rfq_id,
            filename=f"{rfq_code}.pdf",
            data=pdf_bytes,
            content_type="application/pdf",
        )

        db.add(
            Rfq(
                id=rfq_id,
                tenant_id=actor.tenant_id,
                request_id=pr.id,
                request_version=latest_ver.version_number,
                rfq_code=rfq_code,
                supplier_ids_json=[s.id for s in suppliers],
                response_deadline_days=body.response_deadline_days,
                status="exported",
                pdf_object_key=obj_key,
                created_by_user_id=actor.user_id,
            )
        )
        pr.status = "rfq_exported"
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="rfq_exported",
                resource_type="rfq",
                resource_id=rfq_id,
                metadata_json={"rfq_code": rfq_code, "request_version": latest_ver.version_number, "supplier_count": len(suppliers)},
            )
        )

    return {"id": rfq_id, "rfq_code": rfq_code, "request_version": latest_ver.version_number, "status": "exported"}


@router.get("/rfqs/{rfq_id}/pdf")
def download_rfq_pdf(
    rfq_id: str,
    inline: bool = False,
    actor: ActorContext = Depends(get_current_actor),
) -> Response:
    with tenant_session(actor.tenant_id) as db:
        rfq = db.execute(
            select(Rfq).where(Rfq.tenant_id == actor.tenant_id, Rfq.id == rfq_id)
        ).scalar_one_or_none()
        if rfq is None or not rfq.pdf_object_key:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RFQ PDF not found")
        key = rfq.pdf_object_key
        code = rfq.rfq_code
    pdf = get_private_bytes(tenant_id=actor.tenant_id, object_key=key)
    disp = "inline" if inline else "attachment"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disp}; filename="{code}.pdf"'},
    )


@router.get("/rfqs/{rfq_id}/emails")
def get_rfq_email_drafts(
    rfq_id: str,
    lang: str | None = None,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """Generates version-bound EN/FR RFQ outreach email drafts + mailto links for every selected real supplier."""
    with tenant_session(actor.tenant_id) as db:
        rfq = db.execute(select(Rfq).where(Rfq.tenant_id == actor.tenant_id, Rfq.id == rfq_id)).scalar_one_or_none()
        if rfq is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RFQ not found")
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == rfq.request_id)
        ).scalar_one()
        ver = db.execute(
            select(RequestVersion).where(
                RequestVersion.tenant_id == actor.tenant_id,
                RequestVersion.request_id == rfq.request_id,
                RequestVersion.version_number == rfq.request_version,
            )
        ).scalar_one()
        suppliers = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id.in_(rfq.supplier_ids_json or []))
        ).scalars().all()

        eff_lang = lang or pr.document_language or actor.default_language or "en"
        drafts = build_rfq_email_drafts(
            tenant_name=actor.tenant_name,
            buyer_name=actor.display_name,
            buyer_email=actor.email,
            rfq_code=rfq.rfq_code,
            request_ref=pr.reference_code,
            request_version=rfq.request_version,
            request_payload=ver.structured_payload_json,
            response_deadline_days=rfq.response_deadline_days,
            suppliers=suppliers,
            lang=eff_lang,
        )
    return {
        "rfq_id": rfq_id,
        "rfq_code": rfq.rfq_code,
        "smtp_configured": bool(settings.smtp_host and settings.smtp_from_email),
        "drafts": drafts,
    }


@router.post("/rfqs/{rfq_id}/send-emails")
def send_rfq_emails(
    rfq_id: str,
    body: RfqSendEmailsBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """Sends real RFQ emails with PDF attachment via configured SMTP only after explicit human review."""
    _require_buyer_or_requester(actor)
    if not body.confirm_human_review:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "HUMAN_REVIEW_REQUIRED", "message": "Explicit human review confirmation is required before sending external emails."},
        )

    with tenant_session(actor.tenant_id) as db:
        rfq = db.execute(select(Rfq).where(Rfq.tenant_id == actor.tenant_id, Rfq.id == rfq_id)).scalar_one_or_none()
        if rfq is None or not rfq.pdf_object_key:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RFQ or PDF not found")
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == rfq.request_id)
        ).scalar_one()
        ver = db.execute(
            select(RequestVersion).where(
                RequestVersion.tenant_id == actor.tenant_id,
                RequestVersion.request_id == rfq.request_id,
                RequestVersion.version_number == rfq.request_version,
            )
        ).scalar_one()
        suppliers = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id.in_(body.supplier_ids))
        ).scalars().all()
        drafts = build_rfq_email_drafts(
            tenant_name=actor.tenant_name,
            buyer_name=actor.display_name,
            buyer_email=actor.email,
            rfq_code=rfq.rfq_code,
            request_ref=pr.reference_code,
            request_version=rfq.request_version,
            request_payload=ver.structured_payload_json,
            response_deadline_days=rfq.response_deadline_days,
            suppliers=suppliers,
            lang=body.lang or pr.document_language or actor.default_language or "en",
        )
        pdf_key = rfq.pdf_object_key
        rfq_code = rfq.rfq_code

    pdf_bytes = get_private_bytes(tenant_id=actor.tenant_id, object_key=pdf_key)
    results = []
    sent_count = 0
    for d in drafts:
        if not d["recipient_email"]:
            results.append({"supplier_id": d["supplier_id"], "supplier_name": d["supplier_name"], "status": "missing_email", "message": "No email address on file for this supplier."})
            continue
        res = send_rfq_email_smtp(
            recipient_email=d["recipient_email"],
            subject=d["subject"],
            body=d["body"],
            pdf_filename=f"{rfq_code}.pdf",
            pdf_bytes=pdf_bytes,
        )
        if res["status"] == "sent":
            sent_count += 1
        results.append({"supplier_id": d["supplier_id"], "supplier_name": d["supplier_name"], "recipient_email": d["recipient_email"], **res})

    if sent_count > 0:
        with tenant_session(actor.tenant_id) as db:
            rfq_row = db.execute(select(Rfq).where(Rfq.tenant_id == actor.tenant_id, Rfq.id == rfq_id)).scalar_one()
            rfq_row.status = "distribution_recorded"
            rfq_row.distribution_note = f"Sent via SMTP to {sent_count} supplier(s)."
            rfq_row.distributed_at = datetime.now(timezone.utc)
            db.add(
                AuditEvent(
                    id=new_id("aud"),
                    tenant_id=actor.tenant_id,
                    actor_user_id=actor.user_id,
                    action="rfq_emails_dispatched_smtp",
                    resource_type="rfq",
                    resource_id=rfq_id,
                    metadata_json={"sent_count": sent_count},
                )
            )

    return {"rfq_id": rfq_id, "sent_count": sent_count, "results": results}


@router.post("/requests/{request_id}/quotations/extract-upload")
async def extract_uploaded_quotation_file(
    request_id: str,
    file: UploadFile = File(...),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """
    Uploads a real supplier PDF or CSV quotation privately to RustFS, parses real text via pypdf/UTF-8,
    and extracts structured commercial fields using OpenRouter DeepSeek V4.1 Flash for human confirmation.
    """
    _require_buyer_or_requester(actor)
    raw_bytes = await file.read()
    if len(raw_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds 20 MB limit")

    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")
        default_currency = pr.currency_code

    upload_id = new_id("doc")
    obj_key, sha = put_private_bytes(
        tenant_id=actor.tenant_id,
        category="quotation_uploads",
        resource_id=upload_id,
        filename=file.filename or "quotation.pdf",
        data=raw_bytes,
        content_type=file.content_type or "application/octet-stream",
    )

    extraction = extract_quotation_from_document(
        tenant_id=actor.tenant_id,
        filename=file.filename or "quotation.pdf",
        raw_bytes=raw_bytes,
        default_currency=default_currency,
    )
    return {
        "upload_id": upload_id,
        "filename": file.filename or "quotation.pdf",
        "object_key": obj_key,
        "sha256": sha,
        **extraction,
    }


@router.post("/rfqs/{rfq_id}/distribute")
def record_rfq_distribution(
    rfq_id: str,
    body: RfqDistributeBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        rfq = db.execute(
            select(Rfq).where(Rfq.tenant_id == actor.tenant_id, Rfq.id == rfq_id)
        ).scalar_one_or_none()
        if rfq is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="RFQ not found")
        rfq.status = "distribution_recorded"
        rfq.distribution_note = body.note
        rfq.distributed_at = datetime.now(timezone.utc)
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == rfq.request_id)
        ).scalar_one()
        pr.status = "awaiting_quotations"
    return {"id": rfq_id, "status": "distribution_recorded"}


@router.post("/requests/{request_id}/quotations", status_code=status.HTTP_201_CREATED)
def create_quotation(
    request_id: str,
    body: QuotationCreateBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    q_id = new_id("qt")
    unit_p = parse_decimal(body.unit_price, "unit_price")
    disc = parse_decimal(body.discount_amount, "discount_amount")
    freight = parse_decimal(body.freight_amount, "freight_amount") if body.freight_amount not in (None, "") else None
    tax = parse_decimal(body.quoted_tax_amount, "quoted_tax_amount") if body.quoted_tax_amount not in (None, "") else None
    valid_until = datetime.now(timezone.utc) + timedelta(days=body.valid_days)

    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")
        sup = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id == body.supplier_id)
        ).scalar_one_or_none()
        if sup is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found in tenant directory")

        code = body.quote_code or f"Q-{uuid.uuid4().hex[:5].upper()}"
        db.add(
            Quotation(
                id=q_id,
                tenant_id=actor.tenant_id,
                request_id=pr.id,
                supplier_id=sup.id,
                quote_code=code,
                revision_number=1,
                currency_code=body.currency_code.upper(),
                quantity=body.quantity,
                unit_price=unit_p,
                discount_amount=disc,
                freight_amount=freight,
                quoted_tax_amount=tax,
                delivery_days=body.delivery_days,
                warranty_months=body.warranty_months,
                payment_terms=body.payment_terms,
                meets_mandatory_specs=body.meets_mandatory_specs,
                valid_until=valid_until,
                source_filename=body.source_filename or f"{sup.name} quote.pdf",
                evidence_json={"offered_specs_text": body.offered_specs_text.strip()} if body.offered_specs_text else {},
                confirmed=True,
            )
        )
        pr.status = "quotations_received"
    return {"id": q_id, "quote_code": code, "revision_number": 1}


@router.post("/requests/{request_id}/quotations/upload", status_code=status.HTTP_201_CREATED)
async def upload_quotation_document(
    request_id: str,
    supplier_id: str = Form(...),
    unit_price: str = Form(...),
    quantity: int = Form(...),
    freight_amount: str | None = Form(default=None),
    quoted_tax_amount: str | None = Form(default=None),
    delivery_days: int | None = Form(default=None),
    payment_terms: str = Form(default="Net 30"),
    file: UploadFile = File(...),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    raw_bytes = await file.read()
    if len(raw_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File exceeds 20 MB limit")

    q_id = new_id("qt")
    obj_key, sha = put_private_bytes(
        tenant_id=actor.tenant_id,
        category="quotations",
        resource_id=q_id,
        filename=file.filename or "quotation.pdf",
        data=raw_bytes,
        content_type=file.content_type or "application/octet-stream",
    )

    unit_p = parse_decimal(unit_price, "unit_price")
    freight = parse_decimal(freight_amount, "freight_amount") if freight_amount not in (None, "") else None
    tax = parse_decimal(quoted_tax_amount, "quoted_tax_amount") if quoted_tax_amount not in (None, "") else None

    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")
        sup = db.execute(
            select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id == supplier_id)
        ).scalar_one_or_none()
        if sup is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found")

        code = f"Q-{uuid.uuid4().hex[:5].upper()}"
        db.add(
            Quotation(
                id=q_id,
                tenant_id=actor.tenant_id,
                request_id=pr.id,
                supplier_id=sup.id,
                quote_code=code,
                revision_number=1,
                currency_code=pr.currency_code,
                quantity=quantity,
                unit_price=unit_p,
                discount_amount=Decimal("0.00"),
                freight_amount=freight,
                quoted_tax_amount=tax,
                delivery_days=delivery_days,
                warranty_months=24,
                payment_terms=payment_terms,
                meets_mandatory_specs=True,
                valid_until=datetime.now(timezone.utc) + timedelta(days=30),
                source_filename=file.filename or "quotation.pdf",
                source_object_key=obj_key,
                source_sha256=sha,
                confirmed=True,
            )
        )
        pr.status = "quotations_received"
    return {"id": q_id, "quote_code": code, "source_sha256": sha}


def _extract_listed_price_from_notes(notes: str | None, target_unit: Decimal) -> Decimal | None:
    """Extracts a real listed product price from supplier search notes when within a realistic band of target_unit."""
    if not notes:
        return None
    for m in re.finditer(r"(\d[\d\s.,]{1,12}\d)\s*(?:TND|DT|DINARS?|EUR|USD|MAD|DZD|GBP|\$|€)", notes, flags=re.IGNORECASE):
        raw_num = m.group(1).replace(" ", "").replace("\u00a0", "")
        if "," in raw_num and "." not in raw_num:
            parts = raw_num.split(",")
            if len(parts[-1]) in (2, 3):
                raw_num = "".join(parts[:-1]) + "." + parts[-1]
            else:
                raw_num = "".join(parts)
        else:
            raw_num = raw_num.replace(",", "")
        try:
            val = Decimal(raw_num)
            if val > 0 and (target_unit * Decimal("0.30")) <= val <= (target_unit * Decimal("1.35")):
                return val
        except Exception:
            continue
    return None


@router.get("/quotations/{quotation_id}/pdf")
def download_quotation_pdf(
    quotation_id: str,
    inline: bool = False,
    actor: ActorContext = Depends(get_current_actor),
) -> Response:
    with tenant_session(actor.tenant_id) as db:
        q = db.execute(
            select(Quotation).where(Quotation.tenant_id == actor.tenant_id, Quotation.id == quotation_id)
        ).scalar_one_or_none()
        if q is None or not q.source_object_key:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quotation source file not found")
        key = q.source_object_key
        fname = (q.source_filename or f"{q.quote_code}.pdf").replace('"', "")
    raw = get_private_bytes(tenant_id=actor.tenant_id, object_key=key)
    media = "application/pdf" if fname.lower().endswith(".pdf") else "application/octet-stream"
    disp = "inline" if inline else "attachment"
    return Response(
        content=raw,
        media_type=media,
        headers={"Content-Disposition": f'{disp}; filename="{fname}"'},
    )


@router.post("/requests/{request_id}/quotations/seed-sample", status_code=status.HTTP_201_CREATED)
def seed_sample_quotations(
    request_id: str,
    body: SeedExampleQuotesBody | None = Body(default=None),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """
    Generates clearly labeled `[DEMO SIMULATION]` example quotations (with downloadable PDFs in RustFS)
    directly from the user's searched/selected real suppliers and exact request currency (TND, EUR, USD, etc.)
    so buyers can demonstrate Stage 3 -> Stage 6 workflow continuation immediately after supplier discovery.
    """
    _require_buyer_or_requester(actor)
    requested_ids = [sid for sid in (body.supplier_ids or []) if sid] if body else []
    replace_demo = body.replace_existing_demo_quotes if body is not None else True

    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")

        latest_ver = db.execute(
            select(RequestVersion)
            .where(RequestVersion.tenant_id == actor.tenant_id, RequestVersion.request_id == request_id)
            .order_by(desc(RequestVersion.version_number))
            .limit(1)
        ).scalar_one_or_none()
        ver_payload = (latest_ver.structured_payload_json or {}) if latest_ver else {}
        qty = max(1, int(ver_payload.get("quantity") or 10))
        unit_label = str(ver_payload.get("unit") or "units")
        item_summary = str(ver_payload.get("item_summary") or pr.title)
        mandatory_specs = list(ver_payload.get("mandatory_specs") or [])
        deadline = max(2, int(ver_payload.get("delivery_window_days") or 12))
        currency = (pr.currency_code or "TND").upper()

        # Resolve target suppliers: 1) explicit selection, 2) latest RFQ suppliers, 3) most recent tenant suppliers
        suppliers: list[Supplier] = []
        if requested_ids:
            found = db.execute(
                select(Supplier).where(Supplier.tenant_id == actor.tenant_id, Supplier.id.in_(requested_ids))
            ).scalars().all()
            by_id = {s.id: s for s in found}
            suppliers = [by_id[sid] for sid in requested_ids if sid in by_id]

        if not suppliers:
            latest_rfq = db.execute(
                select(Rfq)
                .where(Rfq.tenant_id == actor.tenant_id, Rfq.request_id == request_id)
                .order_by(desc(Rfq.created_at))
                .limit(1)
            ).scalar_one_or_none()
            if latest_rfq and latest_rfq.supplier_ids_json:
                found = db.execute(
                    select(Supplier).where(
                        Supplier.tenant_id == actor.tenant_id,
                        Supplier.id.in_(latest_rfq.supplier_ids_json),
                    )
                ).scalars().all()
                by_id = {s.id: s for s in found}
                suppliers = [by_id[sid] for sid in latest_rfq.supplier_ids_json if sid in by_id]

        if not suppliers:
            suppliers = db.execute(
                select(Supplier)
                .where(Supplier.tenant_id == actor.tenant_id)
                .order_by(Supplier.created_at.desc())
                .limit(3)
            ).scalars().all()

        if not suppliers:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "NO_SUPPLIERS", "message": "Search and save at least one supplier in Stage 2 first."},
            )

        # Locked Q6 behavior: when 3+ suppliers exist, emit 4 example quotes covering:
        # 1) Full spec pass winner, 2) Late delivery (ineligible), 3) Spec mismatch (fail), 4) Unstated spec (needs_clarification)
        if len(suppliers) >= 4:
            quote_suppliers = suppliers[:4]
        elif len(suppliers) == 3:
            quote_suppliers = [suppliers[0], suppliers[1], suppliers[2], suppliers[2]]
        else:
            quote_suppliers = suppliers

        if replace_demo:
            existing_quotes = db.execute(
                select(Quotation).where(Quotation.tenant_id == actor.tenant_id, Quotation.request_id == pr.id)
            ).scalars().all()
            has_po = db.execute(
                select(PurchaseOrder.id).where(PurchaseOrder.tenant_id == actor.tenant_id, PurchaseOrder.request_id == pr.id).limit(1)
            ).first()
            if not has_po:
                for eq in existing_quotes:
                    if (eq.evidence_json or {}).get("is_demo_example"):
                        db.delete(eq)
                db.flush()

        eff_specs = [s.strip() for s in mandatory_specs if s and s.strip()] or ["Commercial business grade", "12-month warranty"]
        first_spec = eff_specs[0]
        last_spec = eff_specs[-1]
        earlier_specs = eff_specs[:-1]

        spec_variants = [
            # 0: Full pass
            (True, f"Confirmed compliant with all requested specs: {', '.join(eff_specs)}."),
            # 1: Full spec pass, but late delivery
            (True, f"Full technical compliance confirmed: {', '.join(eff_specs)}."),
            # 2: Explicit spec mismatch (fail)
            (
                False,
                f"Alternate budget model: DOES NOT include '{first_spec}' (substituted lower-tier standard unit; other specs: {', '.join(eff_specs[1:]) or 'standard'}).",
            ),
            # 3: Unstated mandatory spec (needs_clarification)
            (
                True,
                (
                    f"Includes {', '.join(earlier_specs)}; '{last_spec}' is NOT mentioned on the vendor datasheet (requires supplier clarification)."
                    if earlier_specs
                    else f"Standard commercial unit quoted; '{last_spec}' is NOT stated anywhere on this quote (requires clarification)."
                ),
            ),
        ]

        default_unit_by_curr = Decimal("2200.000") if currency == "TND" else Decimal("850.00")
        target_total = Decimal(pr.budget_cap) if (pr.budget_cap and Decimal(pr.budget_cap) > 0) else (default_unit_by_curr * Decimal(qty) * Decimal("1.15"))
        per_unit_cap = target_total / Decimal(qty)
        is_tunisia_tva = currency == "TND" or (pr.location and "tunis" in pr.location.lower())
        tax_rate = Decimal("0.19") if is_tunisia_tva else Decimal("0.06")

        profiles = [
            # 0: Competitive eligible winner (full spec pass, within budget cap & deadline)
            {"mult": Decimal("0.74") if is_tunisia_tva else Decimal("0.82"), "freight_pct": Decimal("0.012"), "days": max(1, deadline - 3), "war": 24, "pay": "Net 30"},
            # 1: Lower unit price, exceeds delivery deadline -> ineligible
            {"mult": Decimal("0.70") if is_tunisia_tva else Decimal("0.77"), "freight_pct": Decimal("0.010"), "days": deadline + 5, "war": 12, "pay": "Net 15"},
            # 2: Spec mismatch downgrade -> fail / ineligible
            {"mult": Decimal("0.68") if is_tunisia_tva else Decimal("0.75"), "freight_pct": Decimal("0.010"), "days": max(1, deadline - 2), "war": 12, "pay": "Net 30"},
            # 3: Unstated mandatory spec -> needs_clarification
            {"mult": Decimal("0.72") if is_tunisia_tva else Decimal("0.80"), "freight_pct": Decimal("0.011"), "days": max(1, deadline - 4), "war": 24, "pay": "Net 30"},
        ]

        created_ids: list[str] = []
        created_codes: list[str] = []
        for idx, sup in enumerate(quote_suppliers):
            qid = new_id("qt")
            prof = profiles[min(idx, len(profiles) - 1)]
            meets_bool, offered_specs_text = spec_variants[min(idx, len(spec_variants) - 1)]
            code_letter = chr(ord("A") + idx)
            quote_code = f"DEMO-Q{code_letter}-{uuid.uuid4().hex[:3].upper()}"

            listed = _extract_listed_price_from_notes(sup.notes, per_unit_cap)
            if listed is not None and idx == 0:
                max_eligible_unit = per_unit_cap / (Decimal("1.0") + tax_rate + Decimal("0.02"))
                raw_u = min(listed, max_eligible_unit) if pr.budget_cap else listed
            else:
                raw_u = per_unit_cap * prof["mult"]
            u_price = quantize_money(raw_u, currency)
            subtotal_est = u_price * Decimal(qty)
            freight = quantize_money(max(Decimal("15"), target_total * prof["freight_pct"]), currency)
            tax = quantize_money(subtotal_est * tax_rate, currency)
            d_days = prof["days"]
            war = prof["war"]
            pay = prof["pay"]

            subtotal = quantize_money(u_price * Decimal(qty), currency)
            stamp_dec = Decimal("1.000") if (pr.apply_fiscal_stamp and currency == "TND") else quantize_money(Decimal("0"), currency)
            total_val = subtotal + freight + tax + stamp_dec
            slug = re.sub(r"[^a-z0-9]+", "-", sup.name.lower()).strip("-")[:32] or "supplier"
            fname = f"demo-example-{slug}-{quote_code.lower()}.pdf"
            q_lang = (body.lang if body and body.lang else None) or pr.document_language or actor.default_language or "en"

            pdf_bytes = render_example_quotation_pdf(
                quote_code=quote_code,
                supplier_name=sup.name,
                supplier_email=sup.contact_email,
                supplier_location=sup.location,
                buyer_tenant_name=actor.tenant_name,
                request_ref=pr.reference_code,
                item_summary=item_summary,
                mandatory_specs=mandatory_specs,
                currency_code=currency,
                quantity=qty,
                unit=unit_label,
                unit_price_str=format_money_str(u_price, currency) or str(u_price),
                subtotal_str=format_money_str(subtotal, currency) or str(subtotal),
                freight_str=format_money_str(freight, currency),
                tax_str=format_money_str(tax, currency),
                total_str=format_money_str(total_val, currency),
                delivery_days=d_days,
                warranty_months=war,
                payment_terms=pay,
                offered_specs_text=offered_specs_text,
                fiscal_stamp_str=format_money_str(stamp_dec, currency) if stamp_dec > Decimal("0") else None,
                lang=q_lang,
            )
            obj_key, sha = put_private_bytes(
                tenant_id=actor.tenant_id,
                category="quotations",
                resource_id=qid,
                filename=fname,
                data=pdf_bytes,
                content_type="application/pdf",
            )

            db.add(
                Quotation(
                    id=qid,
                    tenant_id=actor.tenant_id,
                    request_id=pr.id,
                    supplier_id=sup.id,
                    quote_code=quote_code,
                    revision_number=1,
                    currency_code=currency,
                    quantity=qty,
                    unit_price=u_price,
                    discount_amount=quantize_money(Decimal("0"), currency),
                    freight_amount=freight,
                    quoted_tax_amount=tax,
                    fiscal_stamp_amount=stamp_dec,
                    delivery_days=d_days,
                    warranty_months=war,
                    payment_terms=pay,
                    meets_mandatory_specs=meets_bool,
                    valid_until=datetime.now(timezone.utc) + timedelta(days=30),
                    source_filename=fname,
                    source_object_key=obj_key,
                    source_sha256=sha,
                    evidence_json={
                        "is_demo_example": True,
                        "offered_specs_text": offered_specs_text,
                        "disclaimer": "Simulated example quotation generated from selected directory supplier for workflow demonstration.",
                        "supplier_source_url": sup.source_url or sup.website_url,
                    },
                    confirmed=True,
                )
            )
            created_ids.append(qid)
            created_codes.append(quote_code)

        pr.status = "quotations_received"
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="demo_example_quotations_generated",
                resource_type="purchase_request",
                resource_id=pr.id,
                metadata_json={"count": len(created_ids), "currency_code": currency, "quote_codes": created_codes},
            )
        )

    return {
        "created_quotation_ids": created_ids,
        "quote_codes": created_codes,
        "currency_code": currency,
        "count": len(created_ids),
    }


@router.patch("/quotations/{quotation_id}")
def correct_quotation_fields(
    quotation_id: str,
    body: QuotationCorrectionBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """Attributable human field correction preserving original values and bumping revision number."""
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        q = db.execute(
            select(Quotation)
            .where(Quotation.tenant_id == actor.tenant_id, Quotation.id == quotation_id)
            .with_for_update()
        ).scalar_one_or_none()
        if q is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quotation not found")

        corrections = list(q.corrections_json or [])
        now_iso = datetime.now(timezone.utc).isoformat()

        def _record(field: str, old_val: Any, new_val: Any) -> None:
            corrections.append(
                {
                    "field": field,
                    "old_value": str(old_val) if old_val is not None else None,
                    "new_value": str(new_val) if new_val is not None else None,
                    "editor_user_id": actor.user_id,
                    "editor_name": actor.display_name,
                    "reason": body.reason,
                    "corrected_at": now_iso,
                }
            )

        if body.unit_price is not None:
            new_u = parse_decimal(body.unit_price, "unit_price")
            _record("unit_price", q.unit_price, new_u)
            q.unit_price = new_u
        if body.freight_amount is not None:
            new_f = parse_decimal(body.freight_amount, "freight_amount") if body.freight_amount != "" else None
            _record("freight_amount", q.freight_amount, new_f)
            q.freight_amount = new_f
        if body.quoted_tax_amount is not None:
            new_t = parse_decimal(body.quoted_tax_amount, "quoted_tax_amount") if body.quoted_tax_amount != "" else None
            _record("quoted_tax_amount", q.quoted_tax_amount, new_t)
            q.quoted_tax_amount = new_t
        if body.delivery_days is not None:
            _record("delivery_days", q.delivery_days, body.delivery_days)
            q.delivery_days = body.delivery_days
        if body.meets_mandatory_specs is not None:
            _record("meets_mandatory_specs", q.meets_mandatory_specs, body.meets_mandatory_specs)
            q.meets_mandatory_specs = body.meets_mandatory_specs

        next_rev = q.revision_number + 1
        ev_json = dict(q.evidence_json or {})
        if body.spec_status_override is not None:
            ov = body.spec_status_override.strip().lower()
            if ov not in ("pass", "needs_clarification", "fail"):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid spec_status_override")
            prev_ov = (ev_json.get("human_spec_override") or {}).get("status") or (ev_json.get("spec_verification") or {}).get("overall_status")
            _record("mandatory_spec_compliance", prev_ov, ov)
            q.meets_mandatory_specs = ov == "pass"
            ev_json["human_spec_override"] = {
                "status": ov,
                "reason": body.reason,
                "editor_user_id": actor.user_id,
                "editor_name": actor.display_name,
                "quote_revision": next_rev,
                "overridden_at": now_iso,
            }
            q.evidence_json = ev_json

        q.revision_number = next_rev
        q.corrections_json = corrections

        # Invalidate any pending award approvals on this request since quote terms changed
        stale = db.execute(
            select(ApprovalRequest).where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.request_id == q.request_id,
                ApprovalRequest.status == "pending",
            )
        ).scalars().all()
        for sap in stale:
            sap.status = "superseded"

    return {"id": quotation_id, "revision_number": q.revision_number, "corrections_count": len(corrections)}


@router.post("/requests/{request_id}/compare")
def compute_request_comparison(request_id: str, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")
        latest_ver = db.execute(
            select(RequestVersion)
            .where(RequestVersion.tenant_id == actor.tenant_id, RequestVersion.request_id == request_id)
            .order_by(desc(RequestVersion.version_number))
            .limit(1)
        ).scalar_one_or_none()
        if latest_ver is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Request version missing")

        quotes_with_sup = db.execute(
            select(Quotation, Supplier)
            .join(Supplier, Quotation.supplier_id == Supplier.id)
            .where(Quotation.tenant_id == actor.tenant_id, Quotation.request_id == request_id)
            .order_by(Quotation.created_at.asc())
        ).all()
        if not quotes_with_sup:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Add or load at least one quotation before comparing.")

        run = db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.request_id == request_id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(1)
        ).scalar_one_or_none()

        ver_payload = dict(latest_ver.structured_payload_json or {})
        ver_payload.setdefault("apply_fiscal_stamp", bool(pr.apply_fiscal_stamp))
        mandatory_specs = [str(s).strip() for s in (ver_payload.get("mandatory_specs") or []) if str(s).strip()]

        # Single batched Jev Router (`profile="decision"`) call for quotes unverified on (request_version, quote_revision)
        quotes_needing_jev: list[dict[str, Any]] = []
        if mandatory_specs:
            for q_row, sup_row in quotes_with_sup:
                ev_j = dict(q_row.evidence_json or {})
                human_ov = ev_j.get("human_spec_override")
                if isinstance(human_ov, dict) and human_ov.get("quote_revision") == q_row.revision_number:
                    continue
                cached_sv = ev_j.get("spec_verification")
                if (
                    isinstance(cached_sv, dict)
                    and cached_sv.get("request_version") == latest_ver.version_number
                    and cached_sv.get("quote_revision") == q_row.revision_number
                ):
                    continue
                offered_txt = (
                    ev_j.get("offered_specs_text")
                    or ev_j.get("source_excerpt")
                    or (
                        f"Confirmed compliant with requested specs ({', '.join(mandatory_specs)})"
                        if q_row.meets_mandatory_specs
                        else "Supplier indicated quotation does NOT meet mandatory specifications."
                    )
                )
                quotes_needing_jev.append(
                    {
                        "quotation_id": q_row.id,
                        "quote_code": q_row.quote_code,
                        "revision_number": q_row.revision_number,
                        "supplier_name": sup_row.name,
                        "offered_text": str(offered_txt),
                    }
                )

        if quotes_needing_jev:
            batch_verdicts = verify_quotations_mandatory_specs_batch(
                tenant_id=actor.tenant_id,
                run_id=run.id if run else None,
                request_version=latest_ver.version_number,
                item_summary=str(ver_payload.get("item_summary") or pr.title),
                mandatory_specs=mandatory_specs,
                quotes_to_verify=quotes_needing_jev,
            )
            for q_row, _ in quotes_with_sup:
                if q_row.id in batch_verdicts:
                    ev_j = dict(q_row.evidence_json or {})
                    ev_j["spec_verification"] = batch_verdicts[q_row.id]
                    q_row.evidence_json = ev_j
                    q_row.meets_mandatory_specs = batch_verdicts[q_row.id]["overall_status"] == "pass"
            db.flush()

        result = evaluate_comparison(
            request_payload=ver_payload,
            quotations_with_suppliers=quotes_with_sup,
        )

        prev_comp = db.execute(
            select(Comparison)
            .where(Comparison.tenant_id == actor.tenant_id, Comparison.request_id == request_id)
            .order_by(desc(Comparison.version_number))
            .limit(1)
        ).scalar_one_or_none()
        next_ver = (prev_comp.version_number + 1) if prev_comp else 1
        comp_id = new_id("cmp")
        db.add(
            Comparison(
                id=comp_id,
                tenant_id=actor.tenant_id,
                request_id=pr.id,
                request_version=latest_ver.version_number,
                version_number=next_ver,
                result_json=result,
                recommended_quotation_id=result["recommended_quotation_id"],
                explanation=result["explanation"],
                created_by_user_id=actor.user_id,
            )
        )
        pr.status = "compared"
    return {"id": comp_id, "version_number": next_ver, "result": result}


@router.post("/requests/{request_id}/award-review", status_code=status.HTTP_201_CREATED)
def submit_supplier_award_review(
    request_id: str,
    body: AwardReviewBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest)
            .where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
            .with_for_update()
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")

        latest_comp = db.execute(
            select(Comparison)
            .where(Comparison.tenant_id == actor.tenant_id, Comparison.request_id == request_id)
            .order_by(desc(Comparison.version_number))
            .limit(1)
        ).scalar_one_or_none()
        if latest_comp is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Run deterministic comparison first.")

        offers = (latest_comp.result_json or {}).get("offers") or []
        chosen = next((o for o in offers if o["quotation_id"] == body.quotation_id), None)
        if chosen is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Quotation not present in latest comparison")
        if chosen["eligibility"] != "eligible":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "code": "POLICY_BLOCKED",
                    "message": f"Cannot submit an ineligible quotation for award: {'; '.join(chosen.get('failure_reasons') or [])}",
                },
            )

        run = db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.request_id == pr.id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(1)
        ).scalar_one()

        # Supersede any older pending approval requests for this PR
        old_pending = db.execute(
            select(ApprovalRequest).where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.request_id == pr.id,
                ApprovalRequest.status == "pending",
            )
        ).scalars().all()
        for old in old_pending:
            old.status = "superseded"

        canonical_award = {
            "decision_type": "supplier_award",
            "request_id": pr.id,
            "request_version": latest_comp.request_version,
            "comparison_version": latest_comp.version_number,
            "quotation_id": chosen["quotation_id"],
            "quote_revision": chosen["revision_number"],
            "supplier_id": chosen["supplier_id"],
            "supplier_name": chosen["supplier_name"],
            "currency_code": chosen["currency_code"],
            "total_quoted_cost": chosen["total_quoted_cost"],
            "delivery_days": chosen["delivery_days"],
            "payment_terms": chosen["payment_terms"],
            "warranty_months": chosen["warranty_months"],
        }
        p_hash = canonical_payload_hash(canonical_award)
        apr_id = new_id("apr")

        alternatives = [
            {
                "supplier_name": o["supplier_name"],
                "total_quoted_cost": o["total_quoted_cost"],
                "currency_code": o["currency_code"],
                "eligibility": o["eligibility"],
                "reason": "; ".join(o["failure_reasons"]) if o["failure_reasons"] else f"Eligible · {o['delivery_days']}d delivery",
            }
            for o in offers
            if o["quotation_id"] != chosen["quotation_id"]
        ]

        packet = {
            **canonical_award,
            "reference_code": pr.reference_code,
            "title": pr.title,
            "budget_headroom": chosen.get("budget_headroom"),
            "justification": body.justification or latest_comp.explanation,
            "alternatives": alternatives,
            "source_filename": chosen.get("source_filename"),
        }

        db.add(
            ApprovalRequest(
                id=apr_id,
                tenant_id=actor.tenant_id,
                run_id=run.id,
                request_id=pr.id,
                decision_type="supplier_award",
                entity_version=latest_comp.version_number,
                payload_hash=p_hash,
                amount=Decimal(chosen["total_quoted_cost"]),
                currency_code=chosen["currency_code"],
                requester_user_id=pr.requester_user_id,
                status="pending",
                packet_json=packet,
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
        )
        pr.status = "awaiting_award_approval"
        run.phase = "awaiting_award_approval"
        run.status = "waiting_for_approval"
        run.pending_decision_id = apr_id

    return {"approval_request_id": apr_id, "payload_hash": p_hash, "entity_version": latest_comp.version_number}


@router.post("/requests/{request_id}/po-draft", status_code=status.HTTP_201_CREATED)
def prepare_po_draft_for_release(request_id: str, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """Creates an immutable Purchase Order draft from an approved Supplier Award and opens Checkpoint #2 (PO Release)."""
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        pr = db.execute(
            select(PurchaseRequest)
            .where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == request_id)
            .with_for_update()
        ).scalar_one_or_none()
        if pr is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Request not found")

        award_pair = db.execute(
            select(ApprovalDecision, ApprovalRequest)
            .join(ApprovalRequest, ApprovalDecision.approval_request_id == ApprovalRequest.id)
            .where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.request_id == pr.id,
                ApprovalRequest.decision_type == "supplier_award",
                ApprovalDecision.outcome == "approved",
            )
            .order_by(desc(ApprovalDecision.decided_at))
            .limit(1)
        ).first()
        if award_pair is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "APPROVAL_REQUIRED", "message": "An approved supplier award is required before drafting a PO."},
            )
        award_dec, award_apr = award_pair
        pkt = award_apr.packet_json or {}

        quote = db.execute(
            select(Quotation).where(Quotation.tenant_id == actor.tenant_id, Quotation.id == pkt["quotation_id"])
        ).scalar_one()
        latest_ver = db.execute(
            select(RequestVersion)
            .where(RequestVersion.tenant_id == actor.tenant_id, RequestVersion.request_id == pr.id)
            .order_by(desc(RequestVersion.version_number))
            .limit(1)
        ).scalar_one()
        run = db.execute(
            select(WorkflowRun)
            .where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.request_id == pr.id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(1)
        ).scalar_one()

        item_subtotal = Decimal(quote.unit_price) * Decimal(quote.quantity)
        freight = Decimal(quote.freight_amount or Decimal("0.00"))
        tax = Decimal(quote.quoted_tax_amount or Decimal("0.00"))
        discount = Decimal(quote.discount_amount or Decimal("0.00"))
        raw_stamp = Decimal(quote.fiscal_stamp_amount or Decimal("0.000"))
        stamp = (
            raw_stamp
            if raw_stamp > Decimal("0")
            else (Decimal("1.000") if (pr.apply_fiscal_stamp and quote.currency_code == "TND") else Decimal("0"))
        )
        total = item_subtotal - discount + freight + tax + stamp

        commercial_payload = {
            "request_id": pr.id,
            "reference_code": pr.reference_code,
            "document_language": pr.document_language or actor.default_language or "en",
            "supplier_id": quote.supplier_id,
            "supplier_name": pkt.get("supplier_name"),
            "quotation_id": quote.id,
            "quote_code": quote.quote_code,
            "quote_revision": quote.revision_number,
            "item_summary": (latest_ver.structured_payload_json or {}).get("item_summary") or pr.title,
            "mandatory_specs": (latest_ver.structured_payload_json or {}).get("mandatory_specs") or [],
            "quantity": quote.quantity,
            "unit": (latest_ver.structured_payload_json or {}).get("unit") or "units",
            "currency_code": quote.currency_code,
            "unit_price": format_money_str(Decimal(quote.unit_price), quote.currency_code),
            "item_subtotal": format_money_str(item_subtotal, quote.currency_code),
            "discount_amount": format_money_str(discount, quote.currency_code),
            "freight_amount": format_money_str(freight, quote.currency_code),
            "quoted_tax_amount": format_money_str(tax, quote.currency_code),
            "fiscal_stamp_amount": format_money_str(stamp, quote.currency_code),
            "total_quoted_cost": format_money_str(total, quote.currency_code),
            "delivery_days": quote.delivery_days,
            "warranty_months": quote.warranty_months,
            "payment_terms": quote.payment_terms,
        }
        p_hash = canonical_payload_hash(commercial_payload)

        po_id = new_id("po")
        db.add(
            PurchaseOrder(
                id=po_id,
                tenant_id=actor.tenant_id,
                request_id=pr.id,
                supplier_id=quote.supplier_id,
                quotation_id=quote.id,
                award_decision_id=award_dec.id,
                status="draft_pending_release",
                version_number=1,
                currency_code=quote.currency_code,
                total_amount=total,
                commercial_payload_json=commercial_payload,
                payload_hash=p_hash,
            )
        )
        db.flush()

        apr_id = new_id("apr")
        db.add(
            ApprovalRequest(
                id=apr_id,
                tenant_id=actor.tenant_id,
                run_id=run.id,
                request_id=pr.id,
                decision_type="po_release",
                entity_version=1,
                payload_hash=p_hash,
                amount=total,
                currency_code=quote.currency_code,
                requester_user_id=pr.requester_user_id,
                status="pending",
                packet_json={
                    "po_id": po_id,
                    "award_decision_id": award_dec.id,
                    **commercial_payload,
                },
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
        )
        pr.status = "awaiting_po_release"
        run.phase = "awaiting_po_release"
        run.status = "waiting_for_approval"
        run.pending_decision_id = apr_id

    return {"po_id": po_id, "approval_request_id": apr_id, "payload_hash": p_hash}


@router.get("/purchase-orders/{po_id}/pdf")
def download_approved_po_pdf(
    po_id: str,
    inline: bool = False,
    actor: ActorContext = Depends(get_current_actor),
) -> Response:
    with tenant_session(actor.tenant_id) as db:
        po = db.execute(
            select(PurchaseOrder).where(PurchaseOrder.tenant_id == actor.tenant_id, PurchaseOrder.id == po_id)
        ).scalar_one_or_none()
        if po is None or not po.pdf_object_key or not po.po_number:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Approved PO PDF not found")
        key = po.pdf_object_key
        po_num = po.po_number
    pdf = get_private_bytes(tenant_id=actor.tenant_id, object_key=key)
    disp = "inline" if inline else "attachment"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'{disp}; filename="{po_num}.pdf"'},
    )


@router.post("/purchase-orders/{po_id}/record-issue")
def record_po_external_issue(
    po_id: str,
    body: ExternalIssueBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    _require_buyer_or_requester(actor)
    with tenant_session(actor.tenant_id) as db:
        po = db.execute(
            select(PurchaseOrder).where(PurchaseOrder.tenant_id == actor.tenant_id, PurchaseOrder.id == po_id)
        ).scalar_one_or_none()
        if po is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Purchase order not found")
        if po.status != "approved_ready_for_issue":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only an approved PO ready for issue can be marked externally issued.")
        po.external_issue_note = body.note
        po.externally_issued_at = datetime.now(timezone.utc)
        po.status = "externally_issued"
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="po_external_issue_recorded",
                resource_type="purchase_order",
                resource_id=po.id,
                metadata_json={"po_number": po.po_number, "note": body.note},
            )
        )
    return {"id": po_id, "po_number": po.po_number, "status": "externally_issued"}
