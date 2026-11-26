from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
import uuid

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKeyConstraint,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


class Base(DeclarativeBase):
    pass


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    base_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="UTC")
    default_location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    default_language: Mapped[str] = mapped_column(String(8), nullable=False, default="en")
    external_search_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False, default="Member")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Membership(Base):
    __tablename__ = "memberships"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    roles_json: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    approval_limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "user_id", name="uq_membership_tenant_user"),
        ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
        ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )


class PurchaseRequest(Base):
    __tablename__ = "purchase_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    reference_code: Mapped[str] = mapped_column(String(32), nullable=False)
    requester_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    status: Mapped[str] = mapped_column(String(48), nullable=False, default="draft")
    current_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False, default="TND")
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    document_language: Mapped[str] = mapped_column(String(8), nullable=False, default="en")
    apply_fiscal_stamp: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    budget_cap: Mapped[Decimal | None] = mapped_column(Numeric(16, 3), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_pr_tenant_id"),
        UniqueConstraint("tenant_id", "reference_code", name="uq_pr_tenant_ref"),
        ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )


class RequestVersion(Base):
    __tablename__ = "request_versions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    structured_payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    missing_fields_json: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    payload_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "request_id", "version_number", name="uq_req_ver"),
        ForeignKeyConstraint(["tenant_id", "request_id"], ["purchase_requests.tenant_id", "purchase_requests.id"], ondelete="CASCADE"),
    )


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    thread_id: Mapped[str] = mapped_column(String(80), nullable=False)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False, default="m0.v1")
    workflow_version: Mapped[str] = mapped_column(String(32), nullable=False, default="procureai.m0.1")
    prompt_bundle_version: Mapped[str] = mapped_column(String(32), nullable=False, default="intake.v1")
    phase: Mapped[str] = mapped_column(String(48), nullable=False, default="intake")
    status: Mapped[str] = mapped_column(String(48), nullable=False, default="running")
    pending_decision_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state_projection_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    last_error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_run_tenant_id"),
        UniqueConstraint("tenant_id", "thread_id", name="uq_run_tenant_thread"),
        UniqueConstraint("thread_id", name="uq_run_thread_global"),
        ForeignKeyConstraint(["tenant_id", "request_id"], ["purchase_requests.tenant_id", "purchase_requests.id"], ondelete="CASCADE"),
        Index("ix_workflow_runs_tenant_created", "tenant_id", "created_at"),
        Index("ix_workflow_runs_tenant_request", "tenant_id", "request_id"),
    )


class RunEvent(Base):
    __tablename__ = "run_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "run_id"], ["workflow_runs.tenant_id", "workflow_runs.id"], ondelete="CASCADE"),
        Index("ix_run_events_tenant_run_id", "tenant_id", "run_id", "id"),
    )


class ApprovalRequest(Base):
    __tablename__ = "approval_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(String(64), nullable=False)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    decision_type: Mapped[str] = mapped_column(String(48), nullable=False, default="request_intake_review")
    entity_version: Mapped[int] = mapped_column(Integer, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(16, 3), nullable=False)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    requester_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    packet_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_approval_req_tenant_id"),
        ForeignKeyConstraint(["tenant_id", "run_id"], ["workflow_runs.tenant_id", "workflow_runs.id"], ondelete="CASCADE"),
        Index("ix_approval_req_tenant_status_created", "tenant_id", "status", "created_at"),
        Index("ix_approval_req_tenant_request", "tenant_id", "request_id"),
    )


class ApprovalDecision(Base):
    __tablename__ = "approval_decisions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    approval_request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    outcome: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    authority_basis: Mapped[str] = mapped_column(String(120), nullable=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "approval_request_id", name="uq_single_decision_per_request"),
        ForeignKeyConstraint(["tenant_id", "approval_request_id"], ["approval_requests.tenant_id", "approval_requests.id"], ondelete="CASCADE"),
    )


class OutboxEvent(Base):
    __tablename__ = "outbox_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    aggregate_id: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_outbox_status_created", "status", "created_at"),
    )


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_records"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(64), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_payload_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_body_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "operation", "resource_id", "idempotency_key", name="uq_idempotency_scope"),
    )


class AiUsageReservation(Base):
    __tablename__ = "ai_usage_reservations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    profile: Mapped[str] = mapped_column(String(32), nullable=False)
    reserved_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="reserved")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        Index("ix_ai_res_tenant_status_created", "tenant_id", "status", "created_at"),
    )


class AiUsageEvent(Base):
    __tablename__ = "ai_usage_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reservation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    profile: Mapped[str] = mapped_column(String(32), nullable=False)
    requested_model: Mapped[str] = mapped_column(String(120), nullable=False)
    actual_model: Mapped[str | None] = mapped_column(String(120), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(120), nullable=True)
    prompt_version: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(64), nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cached_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reasoning_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    cost_status: Mapped[str] = mapped_column(String(32), nullable=False, default="observed")
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    outcome: Mapped[str] = mapped_column(String(32), nullable=False, default="success")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        Index("ix_ai_usage_tenant_created", "tenant_id", "created_at"),
    )


class ExternalSearchEvent(Base):
    __tablename__ = "external_search_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    actor_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False, default="tavily")
    query_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    query_preview: Mapped[str] = mapped_column(String(160), nullable=False)
    search_depth: Mapped[str] = mapped_column(String(32), nullable=False, default="basic")
    results_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    credits_used: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    estimated_cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), nullable=False, default=Decimal("0.008000"))
    cost_status: Mapped[str] = mapped_column(String(32), nullable=False, default="estimated")
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    outcome: Mapped[str] = mapped_column(String(32), nullable=False, default="success")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        Index("ix_ext_search_tenant_created", "tenant_id", "created_at"),
    )


class LlmResponseCache(Base):
    __tablename__ = "llm_response_cache"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    cache_key: Mapped[str] = mapped_column(String(80), nullable=False)
    profile: Mapped[str] = mapped_column(String(32), nullable=False)
    requested_model: Mapped[str] = mapped_column(String(120), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(64), nullable=False)
    schema_version: Mapped[str] = mapped_column(String(64), nullable=False)
    response_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    hit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "cache_key", name="uq_llm_cache_tenant_key"),
    )


class TavilySearchCache(Base):
    __tablename__ = "tavily_search_cache"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    cache_key: Mapped[str] = mapped_column(String(80), nullable=False)
    query_preview: Mapped[str] = mapped_column(String(160), nullable=False)
    search_depth: Mapped[str] = mapped_column(String(32), nullable=False, default="basic")
    include_raw_content: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    leads_json: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    hit_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "cache_key", name="uq_tavily_cache_tenant_key"),
    )


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    actor_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(64), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(64), nullable=False)
    metadata_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        Index("ix_audit_tenant_created", "tenant_id", "created_at"),
    )


class Supplier(Base):
    __tablename__ = "suppliers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str] = mapped_column(String(120), nullable=False, default="General")
    contact_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)
    website_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    source_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    verification_status: Mapped[str] = mapped_column(String(32), nullable=False, default="unverified")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_supplier_tenant_id"),
        ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE"),
    )


class Rfq(Base):
    __tablename__ = "rfqs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    request_version: Mapped[int] = mapped_column(Integer, nullable=False)
    rfq_code: Mapped[str] = mapped_column(String(32), nullable=False)
    supplier_ids_json: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    response_deadline_days: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="exported")
    pdf_object_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    distribution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    distributed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_by_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_rfq_tenant_id"),
        ForeignKeyConstraint(["tenant_id", "request_id"], ["purchase_requests.tenant_id", "purchase_requests.id"], ondelete="CASCADE"),
        Index("ix_rfqs_tenant_request", "tenant_id", "request_id"),
    )


class Quotation(Base):
    __tablename__ = "quotations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    supplier_id: Mapped[str] = mapped_column(String(64), nullable=False)
    quote_code: Mapped[str] = mapped_column(String(32), nullable=False)
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(16, 3), nullable=False)
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(16, 3), nullable=False, default=Decimal("0.000"))
    freight_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 3), nullable=True)
    quoted_tax_amount: Mapped[Decimal | None] = mapped_column(Numeric(16, 3), nullable=True)
    fiscal_stamp_amount: Mapped[Decimal] = mapped_column(Numeric(16, 3), nullable=False, default=Decimal("0.000"))
    delivery_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    warranty_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    payment_terms: Mapped[str] = mapped_column(String(64), nullable=False, default="Net 30")
    meets_mandatory_specs: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    valid_until: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_object_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    source_sha256: Mapped[str | None] = mapped_column(String(80), nullable=True)
    evidence_json: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    corrections_json: Mapped[list[dict]] = mapped_column(JSONB, nullable=False, default=list)
    confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "id", name="uq_quotation_tenant_id"),
        ForeignKeyConstraint(["tenant_id", "request_id"], ["purchase_requests.tenant_id", "purchase_requests.id"], ondelete="CASCADE"),
        ForeignKeyConstraint(["tenant_id", "supplier_id"], ["suppliers.tenant_id", "suppliers.id"], ondelete="RESTRICT"),
        Index("ix_quotations_tenant_request", "tenant_id", "request_id"),
    )


class Comparison(Base):
    __tablename__ = "comparisons"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    request_version: Mapped[int] = mapped_column(Integer, nullable=False)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    result_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    recommended_quotation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    explanation: Mapped[str] = mapped_column(Text, nullable=False)
    created_by_user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(["tenant_id", "request_id"], ["purchase_requests.tenant_id", "purchase_requests.id"], ondelete="CASCADE"),
        Index("ix_comparisons_tenant_request", "tenant_id", "request_id"),
    )


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    supplier_id: Mapped[str] = mapped_column(String(64), nullable=False)
    quotation_id: Mapped[str] = mapped_column(String(64), nullable=False)
    award_decision_id: Mapped[str] = mapped_column(String(64), nullable=False)
    release_decision_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    po_number: Mapped[str | None] = mapped_column(String(48), nullable=True)
    status: Mapped[str] = mapped_column(String(48), nullable=False, default="draft_pending_release")
    version_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    currency_code: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    total_amount: Mapped[Decimal] = mapped_column(Numeric(16, 3), nullable=False)
    commercial_payload_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(80), nullable=False)
    pdf_object_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    pdf_sha256: Mapped[str | None] = mapped_column(String(80), nullable=True)
    external_issue_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    externally_issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    __table_args__ = (
        UniqueConstraint("tenant_id", "po_number", name="uq_po_tenant_number"),
        ForeignKeyConstraint(["tenant_id", "request_id"], ["purchase_requests.tenant_id", "purchase_requests.id"], ondelete="CASCADE"),
        ForeignKeyConstraint(["tenant_id", "supplier_id"], ["suppliers.tenant_id", "suppliers.id"], ondelete="RESTRICT"),
        Index("ix_purchase_orders_tenant_request", "tenant_id", "request_id"),
    )


TENANT_SCOPED_TABLES: tuple[str, ...] = (
    "memberships",
    "purchase_requests",
    "request_versions",
    "workflow_runs",
    "run_events",
    "approval_requests",
    "approval_decisions",
    "outbox_events",
    "idempotency_records",
    "ai_usage_reservations",
    "ai_usage_events",
    "external_search_events",
    "llm_response_cache",
    "tavily_search_cache",
    "audit_events",
    "suppliers",
    "rfqs",
    "quotations",
    "comparisons",
    "purchase_orders",
)
