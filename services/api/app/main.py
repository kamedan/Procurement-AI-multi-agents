from __future__ import annotations

import asyncio
import json
from pathlib import Path
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import anyio
from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select, text

from app.agents.m0_graph import checkpoint_adapter
from app.api.procurement import router as procurement_router
from app.application.copilot import evaluate_copilot_turn
from app.application.decisions import submit_approval_decision
from app.config import settings
from app.domain.models import (
    AiUsageEvent,
    ApprovalDecision,
    ApprovalRequest,
    AuditEvent,
    Comparison,
    ExternalSearchEvent,
    OutboxEvent,
    PurchaseOrder,
    PurchaseRequest,
    Quotation,
    RunEvent,
    Supplier,
    Tenant,
    WorkflowRun,
    new_id,
)
from app.domain.money import SUPPORTED_CURRENCIES
from app.evals import run_evaluation_suite
from app.infrastructure.auth import ActorContext, get_current_actor
from app.infrastructure.db import SessionLocal, tenant_session, worker_dispatch_session
from app.infrastructure.openrouter import ModelGatewayError
from app.infrastructure.tavily import tavily_search

HEARTBEAT_PATH = Path("/tmp/procureai/worker.heartbeat")

is_prod = settings.procureai_env.lower() == "production"
app = FastAPI(
    title="ProcureAI Domain API & AG-UI Bridge",
    version="0.4.0-showcase",
    docs_url=None if is_prod else "/docs",
    redoc_url=None if is_prod else "/redoc",
    openapi_url=None if is_prod else "/openapi.json",
)
app.include_router(procurement_router)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # Allow same-origin PDF iframe preview inside the Side-by-Side PDF Drawer
    if request.url.path.endswith("/pdf"):
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    else:
        response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


class IntakeRunCreate(BaseModel):
    prompt: str = Field(min_length=4, max_length=4000)
    lang: str | None = Field(default=None, max_length=8)


class DecisionActionBody(BaseModel):
    expected_version: int = Field(ge=1)
    expected_payload_hash: str = Field(min_length=10, max_length=120)
    note: str | None = Field(default=None, max_length=1000)


class TenantSettingsPatch(BaseModel):
    external_search_enabled: bool | None = None
    name: str | None = Field(default=None, min_length=2, max_length=200)
    base_currency: str | None = Field(default=None, min_length=3, max_length=3)
    default_location: str | None = Field(default=None, max_length=200)
    default_language: str | None = Field(default=None, max_length=8)


class ExternalDiscoverBody(BaseModel):
    query: str = Field(min_length=3, max_length=240)
    max_results: int = Field(default=3, ge=1, le=5)
    search_depth: str = Field(default="basic")


class AgUiRunBody(BaseModel):
    threadId: str | None = None
    runId: str | None = None
    requestId: str | None = None
    lang: str | None = Field(default="en", max_length=8)
    messages: list[dict[str, Any]] = Field(default_factory=list)


class EvalRunBody(BaseModel):
    include_live_llm: bool = Field(default=False)


@app.get("/health/live")
def health_live() -> dict[str, str]:
    return {"status": "alive", "env": settings.procureai_env}


@app.get("/health/ready")
def health_ready() -> dict[str, Any]:
    session = SessionLocal()
    try:
        with session.begin():
            row = session.execute(
                text("SELECT version FROM schema_migrations_meta ORDER BY applied_at DESC LIMIT 1")
            ).first()
            if row is None:
                raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Migrations not applied")
            return {
                "status": "ready",
                "migration": row[0],
                "model_extraction": settings.openrouter_model_extraction,
                "model_decision": settings.openrouter_model_decision,
                "model_reasoning": settings.openrouter_model_reasoning,
                "server_external_search_enabled": settings.external_search_enabled,
            }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=f"Database not ready: {exc}") from exc
    finally:
        session.close()


@app.get("/api/v1/me")
def read_me(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    return {
        "tenant_id": actor.tenant_id,
        "tenant_name": actor.tenant_name,
        "base_currency": actor.base_currency,
        "default_location": actor.default_location,
        "default_language": actor.default_language,
        "tenant_external_search_enabled": actor.tenant_external_search_enabled,
        "server_external_search_enabled": settings.external_search_enabled,
        "effective_external_search_enabled": bool(
            settings.external_search_enabled and actor.tenant_external_search_enabled
        ),
        "user_id": actor.user_id,
        "email": actor.email,
        "display_name": actor.display_name,
        "title": actor.title,
        "roles": list(actor.roles),
        "approval_limit_usd": str(actor.approval_limit_usd) if actor.approval_limit_usd is not None else None,
    }


@app.get("/api/v1/tenant/settings")
def get_tenant_settings(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    return {
        "tenant_id": actor.tenant_id,
        "tenant_name": actor.tenant_name,
        "base_currency": actor.base_currency,
        "default_location": actor.default_location,
        "default_language": actor.default_language,
        "external_search_enabled": actor.tenant_external_search_enabled,
        "server_external_search_enabled": settings.external_search_enabled,
        "effective_external_search_enabled": bool(
            settings.external_search_enabled and actor.tenant_external_search_enabled
        ),
        "daily_ai_budget_usd": str(settings.tenant_daily_ai_budget_usd),
        "llm_cache_ttl_seconds": settings.llm_cache_ttl_seconds,
        "tavily_cache_ttl_seconds": settings.tavily_cache_ttl_seconds,
        "tavily_cost_per_credit_usd": str(settings.tavily_cost_per_credit_usd),
        "can_edit_settings": actor.has_role("tenant_admin"),
        "can_edit_company_profile": actor.has_role("tenant_admin") or actor.has_role("buyer"),
    }


@app.patch("/api/v1/tenant/settings")
def update_tenant_settings(
    body: TenantSettingsPatch,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    # Strict admin RBAC on external_search_enabled policy toggle (tested invariant!)
    if body.external_search_enabled is not None and not actor.has_role("tenant_admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "POLICY_BLOCKED",
                "message": "Only a tenant administrator can change workspace external-search settings.",
            },
        )
    if not (actor.has_role("tenant_admin") or actor.has_role("buyer")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "POLICY_BLOCKED", "message": "Admin or buyer role required to update company profile."},
        )

    changes: dict[str, Any] = {}
    with tenant_session(actor.tenant_id) as db:
        tenant = db.execute(select(Tenant).where(Tenant.id == actor.tenant_id)).scalar_one()
        if body.external_search_enabled is not None:
            changes["external_search_enabled"] = [bool(tenant.external_search_enabled), body.external_search_enabled]
            tenant.external_search_enabled = body.external_search_enabled
        if body.name is not None and body.name.strip():
            changes["name"] = [tenant.name, body.name.strip()[:200]]
            tenant.name = body.name.strip()[:200]
        if body.base_currency is not None:
            curr = body.base_currency.strip().upper()
            if curr in SUPPORTED_CURRENCIES:
                changes["base_currency"] = [tenant.base_currency, curr]
                tenant.base_currency = curr
        if body.default_location is not None:
            loc = body.default_location.strip()[:200] or None
            changes["default_location"] = [tenant.default_location, loc]
            tenant.default_location = loc
        if body.default_language is not None:
            lg = "fr" if body.default_language.strip().lower().startswith("fr") else "en"
            changes["default_language"] = [tenant.default_language, lg]
            tenant.default_language = lg

        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="tenant_settings_updated",
                resource_type="tenant",
                resource_id=actor.tenant_id,
                metadata_json=changes,
            )
        )
        updated_ext = bool(tenant.external_search_enabled)
        updated_name = tenant.name
        updated_curr = tenant.base_currency
        updated_loc = tenant.default_location
        updated_lang = tenant.default_language

    return {
        "tenant_id": actor.tenant_id,
        "tenant_name": updated_name,
        "base_currency": updated_curr,
        "default_location": updated_loc,
        "default_language": updated_lang,
        "external_search_enabled": updated_ext,
        "server_external_search_enabled": settings.external_search_enabled,
        "effective_external_search_enabled": bool(settings.external_search_enabled and updated_ext),
    }


@app.get("/api/v1/overview/summary")
def get_overview_summary(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """Returns the 4 inline KPI metrics + Pending Approval Inbox items for the Overview header."""
    with tenant_session(actor.tenant_id) as db:
        open_requests = db.execute(
            select(func.count(PurchaseRequest.id)).where(
                PurchaseRequest.tenant_id == actor.tenant_id,
                PurchaseRequest.status.not_in(("po_approved_ready_for_issue", "externally_issued", "rejected")),
            )
        ).scalar_one()
        awaiting_approval = db.execute(
            select(func.count(ApprovalRequest.id)).where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.status == "pending",
            )
        ).scalar_one()
        quotes_to_review = db.execute(
            select(func.count(Quotation.id)).where(Quotation.tenant_id == actor.tenant_id)
        ).scalar_one()
        approved_pos = db.execute(
            select(func.count(PurchaseOrder.id)).where(
                PurchaseOrder.tenant_id == actor.tenant_id,
                PurchaseOrder.po_number.is_not(None),
            )
        ).scalar_one()

        pending_rows = db.execute(
            select(ApprovalRequest, PurchaseRequest)
            .join(PurchaseRequest, ApprovalRequest.request_id == PurchaseRequest.id)
            .where(
                ApprovalRequest.tenant_id == actor.tenant_id,
                ApprovalRequest.status == "pending",
            )
            .order_by(desc(ApprovalRequest.created_at))
            .limit(6)
        ).all()

        inbox = [
            {
                "approval_id": apr.id,
                "request_id": pr.id,
                "reference_code": pr.reference_code,
                "title": pr.title,
                "decision_type": apr.decision_type,
                "amount": str(apr.amount),
                "currency_code": apr.currency_code,
                "supplier_name": (apr.packet_json or {}).get("supplier_name"),
                "can_current_actor_approve": bool(
                    actor.user_id != apr.requester_user_id
                    and actor.can_approve_amount(apr.amount, apr.currency_code)
                ),
                "created_at": apr.created_at.isoformat(),
            }
            for apr, pr in pending_rows
        ]

    return {
        "kpis": {
            "open_requests": int(open_requests),
            "awaiting_approval": int(awaiting_approval),
            "quotes_to_review": int(quotes_to_review),
            "approved_pos": int(approved_pos),
        },
        "pending_approvals": inbox,
    }


@app.get("/api/v1/agents/activity")
def get_agents_and_activity(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """
    Live roster of all specialized ProcureAI agents, durable worker heartbeat + outbox queue health,
    and unified chronological background event log across RunEvents, OutboxEvents, LLM/Jev calls, Tavily, and Audits.
    """
    # 1. Worker heartbeat health (shared /tmp or DB outbox freshness)
    hb_age_sec: int | None = None
    worker_status = "healthy"
    if HEARTBEAT_PATH.is_file():
        try:
            hb_ts = int(HEARTBEAT_PATH.read_text(encoding="utf-8").strip())
            hb_age_sec = max(0, int(time.time()) - hb_ts)
            worker_status = "healthy" if hb_age_sec <= 35 else "stale"
        except Exception:
            worker_status = "unknown"

    with tenant_session(actor.tenant_id) as db:
        # Outbox queue counts for this tenant
        obx_counts_rows = db.execute(
            select(OutboxEvent.status, func.count(OutboxEvent.id))
            .where(OutboxEvent.tenant_id == actor.tenant_id)
            .group_by(OutboxEvent.status)
        ).all()
        obx_map = {st: int(cnt) for st, cnt in obx_counts_rows}

        running_runs = db.execute(
            select(func.count(WorkflowRun.id)).where(
                WorkflowRun.tenant_id == actor.tenant_id,
                WorkflowRun.status == "running",
            )
        ).scalar_one()

        # Per-profile LLM stats
        llm_rows = db.execute(
            select(
                AiUsageEvent.prompt_version,
                AiUsageEvent.profile,
                func.count(AiUsageEvent.id),
                func.count(AiUsageEvent.id).filter(AiUsageEvent.outcome == "cache_hit"),
                func.coalesce(func.avg(AiUsageEvent.latency_ms), 0),
                func.coalesce(func.sum(AiUsageEvent.cost_usd), Decimal("0")),
                func.max(AiUsageEvent.created_at),
            )
            .where(AiUsageEvent.tenant_id == actor.tenant_id)
            .group_by(AiUsageEvent.prompt_version, AiUsageEvent.profile)
        ).all()

        def _agg_prefix(prefix: str) -> dict[str, Any]:
            calls = 0
            hits = 0
            lat_sum = 0.0
            cost = Decimal("0")
            last_dt = None
            for pv, _prof, cnt, h, avg_l, c_sum, m_dt in llm_rows:
                if (pv or "").startswith(prefix):
                    calls += int(cnt)
                    hits += int(h)
                    lat_sum += float(avg_l or 0) * int(cnt)
                    cost += Decimal(c_sum or 0)
                    if m_dt and (last_dt is None or m_dt > last_dt):
                        last_dt = m_dt
            return {
                "calls": calls,
                "cache_hits": hits,
                "avg_latency_ms": int(lat_sum / calls) if calls > 0 else 0,
                "cost_usd": str(cost.quantize(Decimal("0.000001"))),
                "last_active_at": last_dt.isoformat() if last_dt else None,
            }

        intake_stats = _agg_prefix("intake.")
        sup_llm_stats = _agg_prefix("supplier.")
        quote_stats = _agg_prefix("quote.")
        jev_spec_stats = _agg_prefix("spec.")
        jev_eval_stats = _agg_prefix("eval.")
        copilot_stats = _agg_prefix("copilot.")

        tav_row = db.execute(
            select(
                func.count(ExternalSearchEvent.id),
                func.count(ExternalSearchEvent.id).filter(ExternalSearchEvent.outcome == "cache_hit"),
                func.coalesce(func.avg(ExternalSearchEvent.latency_ms), 0),
                func.coalesce(func.sum(ExternalSearchEvent.estimated_cost_usd), Decimal("0")),
                func.max(ExternalSearchEvent.created_at),
            ).where(ExternalSearchEvent.tenant_id == actor.tenant_id)
        ).one()

        comp_count = db.execute(
            select(func.count(Comparison.id)).where(Comparison.tenant_id == actor.tenant_id)
        ).scalar_one()
        dec_count = db.execute(
            select(func.count(ApprovalDecision.id)).where(ApprovalDecision.tenant_id == actor.tenant_id)
        ).scalar_one()
        po_count = db.execute(
            select(func.count(PurchaseOrder.id)).where(
                PurchaseOrder.tenant_id == actor.tenant_id,
                PurchaseOrder.po_number.is_not(None),
            )
        ).scalar_one()

        search_eff = bool(settings.external_search_enabled and actor.tenant_external_search_enabled)

        agents = [
            {
                "id": "agent_intake_react",
                "name_en": "Purchase Request Intake Agent (ReAct)",
                "name_fr": "Agent d'Analyse des Demandes d'Achat (ReAct)",
                "role_en": "Extracts structured requirements, currency, city & missing specs (3-step cap)",
                "role_fr": "Extrait les besoins structurés, la devise, la ville et les champs manquants (max 3 étapes)",
                "backbone": settings.openrouter_model_extraction,
                "profile": "extraction",
                "status": "running" if int(running_runs) > 0 else "ready",
                **intake_stats,
            },
            {
                "id": "agent_supplier_discovery",
                "name_en": "Real Supplier & Contact Discovery Agent",
                "name_fr": "Agent de Recherche Fournisseurs & Contacts Réels",
                "role_en": "Live Tavily web search + anti-hallucination email/phone/price extraction",
                "role_fr": "Recherche web Tavily + extraction vérifiée d'emails, téléphones et prix locaux",
                "backbone": f"Tavily + {settings.openrouter_model_extraction}",
                "profile": "tavily + extraction",
                "status": "ready" if search_eff else "disabled_by_policy",
                "calls": int(tav_row[0]) + sup_llm_stats["calls"],
                "cache_hits": int(tav_row[1]) + sup_llm_stats["cache_hits"],
                "avg_latency_ms": int(tav_row[2] or 0),
                "cost_usd": str((Decimal(tav_row[3] or 0) + Decimal(sup_llm_stats["cost_usd"])).quantize(Decimal("0.000001"))),
                "last_active_at": tav_row[4].isoformat() if tav_row[4] else sup_llm_stats["last_active_at"],
            },
            {
                "id": "agent_quote_parser",
                "name_en": "Quotation Document Evidence Parser",
                "name_fr": "Agent d'Extraction de Devis PDF/CSV",
                "role_en": "Parses digital PDF/CSV quotes from private RustFS storage with SHA-256 provenance",
                "role_fr": "Extrait les devis PDF/CSV stockés dans RustFS avec empreinte SHA-256",
                "backbone": f"pypdf + {settings.openrouter_model_extraction}",
                "profile": "extraction",
                "status": "ready",
                **quote_stats,
            },
            {
                "id": "agent_jev_spec_verifier",
                "name_en": "Jev Mandatory-Spec Compliance Verifier",
                "name_fr": "Vérificateur de Conformité Technique (Jev System One)",
                "role_en": "Batched System One decision gate evaluating pass / needs_clarification / fail per spec",
                "role_fr": "Évaluation groupée System One (conforme / à clarifier / non conforme) par spécification",
                "backbone": settings.openrouter_model_decision,
                "profile": "decision (ZDR + max_price)",
                "status": "ready",
                "calls": jev_spec_stats["calls"] + jev_eval_stats["calls"],
                "cache_hits": jev_spec_stats["cache_hits"] + jev_eval_stats["cache_hits"],
                "avg_latency_ms": jev_spec_stats["avg_latency_ms"],
                "cost_usd": str(
                    (Decimal(jev_spec_stats["cost_usd"]) + Decimal(jev_eval_stats["cost_usd"])).quantize(Decimal("0.000001"))
                ),
                "last_active_at": jev_spec_stats["last_active_at"] or jev_eval_stats["last_active_at"],
            },
            {
                "id": "agent_deterministic_core",
                "name_en": "Deterministic Money, Eligibility & PO Engine",
                "name_fr": "Moteur Déterministe Devises, Éligibilité & BC",
                "role_en": "Authoritative Decimal/TND math, Timbre Fiscal, RLS, idempotent approvals & PO PDFs",
                "role_fr": "Calculs exacts Decimal/TND, Timbre Fiscal, RLS, approbations idempotentes & PDF BC",
                "backbone": "Python Decimal + PostgreSQL 17 RLS",
                "profile": "deterministic_authority",
                "status": "ready",
                "calls": int(comp_count) + int(dec_count) + int(po_count),
                "cache_hits": 0,
                "avg_latency_ms": 4,
                "cost_usd": "0.000000",
                "last_active_at": None,
            },
            {
                "id": "agent_command_copilot",
                "name_en": "Contextual Command Copilot",
                "name_fr": "Copilote Conversationnel Contextuel",
                "role_en": "Grounded Q&A, EN/FR clarification email drafter & safe UI draft/stage helper",
                "role_fr": "Questions-réponses ancrées, brouillons d'emails EN/FR et navigation assistée",
                "backbone": settings.openrouter_model_reasoning,
                "profile": "reasoning",
                "status": "ready",
                **copilot_stats,
            },
        ]

        # Unified chronological background event log (up to 80 recent items across all 5 event sources)
        pr_map = {
            p.id: p.reference_code
            for p in db.execute(select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id)).scalars().all()
        }
        run_to_req = {
            r.id: r.request_id
            for r in db.execute(select(WorkflowRun).where(WorkflowRun.tenant_id == actor.tenant_id)).scalars().all()
        }

        logs: list[dict[str, Any]] = []

        for ev in (
            db.execute(
                select(RunEvent).where(RunEvent.tenant_id == actor.tenant_id).order_by(desc(RunEvent.id)).limit(30)
            )
            .scalars()
            .all()
        ):
            req_id = run_to_req.get(ev.run_id)
            p = ev.payload_json or {}
            summary = (
                f"Step {p.get('step')}/{p.get('max_steps')} [{p.get('action')}]: {p.get('observation')}"
                if ev.event_type == "react_step"
                else p.get("message") or f"{ev.event_type}"
            )
            logs.append({
                "id": f"re_{ev.id}",
                "category": "agent_step",
                "source": "LangGraph ReAct",
                "event_type": ev.event_type,
                "status": str(p.get("status") or "ok"),
                "reference_code": pr_map.get(req_id) if req_id else None,
                "request_id": req_id,
                "summary": str(summary)[:260],
                "payload": p,
                "created_at": ev.created_at.isoformat(),
            })

        for ob in (
            db.execute(
                select(OutboxEvent)
                .where(OutboxEvent.tenant_id == actor.tenant_id)
                .order_by(desc(OutboxEvent.created_at))
                .limit(20)
            )
            .scalars()
            .all()
        ):
            req_id = (ob.payload_json or {}).get("request_id") or run_to_req.get(ob.aggregate_id)
            logs.append({
                "id": ob.id,
                "category": "worker_outbox",
                "source": "Durable Worker (LISTEN/NOTIFY)",
                "event_type": ob.event_type,
                "status": ob.status,
                "reference_code": pr_map.get(req_id) if req_id else None,
                "request_id": req_id,
                "summary": f"Outbox {ob.event_type} -> {ob.status} (attempts={ob.attempts})",
                "payload": {
                    "attempts": ob.attempts,
                    "processed_at": ob.processed_at.isoformat() if ob.processed_at else None,
                    "last_error": ob.last_error,
                    **(ob.payload_json or {}),
                },
                "created_at": (ob.processed_at or ob.created_at).isoformat(),
            })

        for au in (
            db.execute(
                select(AiUsageEvent)
                .where(AiUsageEvent.tenant_id == actor.tenant_id)
                .order_by(desc(AiUsageEvent.created_at))
                .limit(25)
            )
            .scalars()
            .all()
        ):
            req_id = run_to_req.get(au.run_id) if au.run_id else None
            logs.append({
                "id": au.id,
                "category": "llm_call",
                "source": f"OpenRouter ({au.profile})",
                "event_type": au.prompt_version,
                "status": au.outcome,
                "reference_code": pr_map.get(req_id) if req_id else None,
                "request_id": req_id,
                "summary": (
                    f"{au.requested_model} -> {au.actual_model} ({au.provider}) · "
                    f"{au.prompt_tokens} in / {au.completion_tokens} out · ${au.cost_usd or '0.000000'} · {au.latency_ms} ms"
                ),
                "payload": {
                    "requested_model": au.requested_model,
                    "actual_model": au.actual_model,
                    "provider": au.provider,
                    "prompt_tokens": au.prompt_tokens,
                    "completion_tokens": au.completion_tokens,
                    "cached_tokens": au.cached_tokens,
                    "cost_usd": str(au.cost_usd) if au.cost_usd is not None else "0.000000",
                    "latency_ms": au.latency_ms,
                    "outcome": au.outcome,
                },
                "created_at": au.created_at.isoformat(),
            })

        for ts in (
            db.execute(
                select(ExternalSearchEvent)
                .where(ExternalSearchEvent.tenant_id == actor.tenant_id)
                .order_by(desc(ExternalSearchEvent.created_at))
                .limit(20)
            )
            .scalars()
            .all()
        ):
            req_id = run_to_req.get(ts.run_id) if ts.run_id else None
            logs.append({
                "id": ts.id,
                "category": "tavily_search",
                "source": f"Tavily ({ts.provider})",
                "event_type": f"search_{ts.search_depth}",
                "status": ts.outcome,
                "reference_code": pr_map.get(req_id) if req_id else None,
                "request_id": req_id,
                "summary": (
                    f"Query \"{ts.query_preview}\" -> {ts.results_count} lead(s), "
                    f"{ts.credits_used} credit(s), ${ts.estimated_cost_usd} ({ts.latency_ms} ms)"
                ),
                "payload": {
                    "query_preview": ts.query_preview,
                    "results_count": ts.results_count,
                    "credits_used": ts.credits_used,
                    "estimated_cost_usd": str(ts.estimated_cost_usd),
                    "latency_ms": ts.latency_ms,
                    "outcome": ts.outcome,
                },
                "created_at": ts.created_at.isoformat(),
            })

        for ad in (
            db.execute(
                select(AuditEvent)
                .where(AuditEvent.tenant_id == actor.tenant_id)
                .order_by(desc(AuditEvent.created_at))
                .limit(25)
            )
            .scalars()
            .all()
        ):
            req_id = ad.resource_id if ad.resource_type == "purchase_request" else (ad.metadata_json or {}).get("request_id")
            logs.append({
                "id": ad.id,
                "category": "domain_audit",
                "source": "Deterministic Domain Core",
                "event_type": ad.action,
                "status": "committed",
                "reference_code": pr_map.get(req_id) if req_id else None,
                "request_id": req_id,
                "summary": f"{ad.action} on {ad.resource_type} ({ad.resource_id})",
                "payload": ad.metadata_json or {},
                "created_at": ad.created_at.isoformat(),
            })

    logs.sort(key=lambda x: x["created_at"], reverse=True)

    return {
        "worker": {
            "status": worker_status,
            "mode": "postgresql_listen_notify",
            "heartbeat_age_seconds": hb_age_sec,
            "active_runs": int(running_runs),
            "outbox": {
                "pending": obx_map.get("pending", 0),
                "processing": obx_map.get("processing", 0),
                "processed": obx_map.get("processed", 0),
                "failed": obx_map.get("failed", 0),
            },
        },
        "agents": agents,
        "logs": logs[:80],
    }


@app.get("/api/v1/evals/summary")
def get_evals_summary(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    return run_evaluation_suite(include_live_llm=False, tenant_id=actor.tenant_id)


@app.post("/api/v1/evals/run")
def run_evals_endpoint(
    body: EvalRunBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    return run_evaluation_suite(include_live_llm=body.include_live_llm, tenant_id=actor.tenant_id)


@app.post("/api/v1/suppliers/discover-external")
def discover_external_suppliers(
    body: ExternalDiscoverBody,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    if not (actor.has_role("buyer") or actor.has_role("requester") or actor.has_role("tenant_admin")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "POLICY_BLOCKED", "message": "Role not permitted for supplier discovery."},
        )
    try:
        res = tavily_search.search_leads(
            tenant_id=actor.tenant_id,
            actor_user_id=actor.user_id,
            query=body.query,
            max_results=body.max_results,
            search_depth=body.search_depth,
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

    return {
        "tenant_id": actor.tenant_id,
        "provider": "tavily",
        "search_depth": res.search_depth,
        "cache_hit": res.cache_hit,
        "credits_used": res.credits_used,
        "estimated_cost_usd": str(res.estimated_cost_usd),
        "latency_ms": res.latency_ms,
        "notice": "External search results are unverified leads only; human verification is required before inviting to an RFQ.",
        "leads": [lead.model_dump() for lead in res.leads],
    }


def _enqueue_intake_run(actor: ActorContext, prompt: str, lang: str | None = None) -> dict[str, Any]:
    if not (actor.has_role("requester") or actor.has_role("buyer")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "POLICY_BLOCKED", "message": "Requester or buyer role required to initiate a purchase request."},
        )

    request_id = new_id("pr")
    run_id = new_id("run")
    outbox_id = new_id("obx")
    thread_id = f"thr_{actor.tenant_id}_{uuid.uuid4().hex[:12]}"
    ref_code = f"PR-{uuid.uuid4().hex[:6].upper()}"
    doc_lang = "fr" if (lang or actor.default_language or "en").lower().startswith("fr") else "en"

    with tenant_session(actor.tenant_id) as db:
        db.add(
            PurchaseRequest(
                id=request_id,
                tenant_id=actor.tenant_id,
                reference_code=ref_code,
                requester_user_id=actor.user_id,
                title=prompt[:120],
                status="draft",
                current_version=1,
                currency_code=actor.base_currency,
                location=actor.default_location,
                document_language=doc_lang,
                apply_fiscal_stamp=(actor.base_currency == "TND"),
            )
        )
        db.flush()
        db.add(
            WorkflowRun(
                id=run_id,
                tenant_id=actor.tenant_id,
                thread_id=thread_id,
                request_id=request_id,
                actor_user_id=actor.user_id,
                schema_version="m0.v2",
                workflow_version="procureai.react.m0.2",
                prompt_bundle_version="intake.react.v2",
                phase="intake",
                status="running",
                state_projection_json={},
            )
        )
        db.flush()
        db.add(
            RunEvent(
                tenant_id=actor.tenant_id,
                run_id=run_id,
                event_type="run_queued",
                payload_json={"request_id": request_id, "reference_code": ref_code},
            )
        )
        db.add(
            OutboxEvent(
                id=outbox_id,
                tenant_id=actor.tenant_id,
                event_type="intake_requested",
                aggregate_id=run_id,
                payload_json={
                    "tenant_id": actor.tenant_id,
                    "run_id": run_id,
                    "thread_id": thread_id,
                    "request_id": request_id,
                    "actor_user_id": actor.user_id,
                    "raw_prompt": prompt,
                },
                status="pending",
            )
        )
        db.execute(text("SELECT pg_notify('procureai_outbox', :eid)"), {"eid": outbox_id})
        db.add(
            AuditEvent(
                id=new_id("aud"),
                tenant_id=actor.tenant_id,
                actor_user_id=actor.user_id,
                action="intake_run_created",
                resource_type="workflow_run",
                resource_id=run_id,
                metadata_json={"request_id": request_id, "reference_code": ref_code},
            )
        )

    return {
        "run_id": run_id,
        "thread_id": thread_id,
        "request_id": request_id,
        "reference_code": ref_code,
        "status": "running",
    }


@app.post("/api/v1/runs/intake", status_code=status.HTTP_202_ACCEPTED)
def create_intake_run(
    body: IntakeRunCreate,
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    return _enqueue_intake_run(actor, body.prompt.strip(), lang=body.lang)


@app.get("/api/v1/runs")
def list_runs(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """P1 optimization: single outer-JOIN query instead of 1+N (26) separate SELECTs."""
    with tenant_session(actor.tenant_id) as db:
        rows = db.execute(
            select(WorkflowRun, PurchaseRequest)
            .outerjoin(
                PurchaseRequest,
                (WorkflowRun.tenant_id == PurchaseRequest.tenant_id)
                & (WorkflowRun.request_id == PurchaseRequest.id),
            )
            .where(WorkflowRun.tenant_id == actor.tenant_id)
            .order_by(desc(WorkflowRun.created_at))
            .limit(25)
        ).all()
        items = [
            {
                "run_id": r.id,
                "thread_id": r.thread_id,
                "request_id": r.request_id,
                "reference_code": pr.reference_code if pr else None,
                "title": pr.title if pr else None,
                "phase": r.phase,
                "status": r.status,
                "pending_decision_id": r.pending_decision_id,
                "projection": r.state_projection_json,
                "last_error_code": r.last_error_code,
                "last_error_message": r.last_error_message,
                "created_at": r.created_at.isoformat(),
                "updated_at": r.updated_at.isoformat(),
            }
            for r, pr in rows
        ]
        return {"tenant_id": actor.tenant_id, "runs": items}


@app.get("/api/v1/runs/{run_id}")
def get_run(run_id: str, actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    with tenant_session(actor.tenant_id) as db:
        run = db.execute(
            select(WorkflowRun).where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.id == run_id)
        ).scalar_one_or_none()
        if run is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "Run not found"})

        pr = db.execute(
            select(PurchaseRequest).where(PurchaseRequest.tenant_id == actor.tenant_id, PurchaseRequest.id == run.request_id)
        ).scalar_one()

        events = db.execute(
            select(RunEvent)
            .where(RunEvent.tenant_id == actor.tenant_id, RunEvent.run_id == run_id)
            .order_by(RunEvent.id.asc())
        ).scalars().all()

        approval = None
        if run.pending_decision_id:
            apr = db.execute(
                select(ApprovalRequest).where(
                    ApprovalRequest.tenant_id == actor.tenant_id,
                    ApprovalRequest.id == run.pending_decision_id,
                )
            ).scalar_one_or_none()
            if apr is not None:
                approval = {
                    "id": apr.id,
                    "status": apr.status,
                    "decision_type": apr.decision_type,
                    "entity_version": apr.entity_version,
                    "payload_hash": apr.payload_hash,
                    "amount": str(apr.amount),
                    "currency_code": apr.currency_code,
                    "requester_user_id": apr.requester_user_id,
                    "expires_at": apr.expires_at.isoformat(),
                    "packet": apr.packet_json,
                }

        decisions = db.execute(
            select(ApprovalDecision)
            .join(ApprovalRequest, ApprovalDecision.approval_request_id == ApprovalRequest.id)
            .where(ApprovalRequest.tenant_id == actor.tenant_id, ApprovalRequest.run_id == run_id)
        ).scalars().all()

    checkpoint_info = checkpoint_adapter.get_checkpoint_snapshot(actor.tenant_id, run.thread_id)
    return {
        "run_id": run.id,
        "thread_id": run.thread_id,
        "request_id": run.request_id,
        "reference_code": pr.reference_code,
        "title": pr.title,
        "request_status": pr.status,
        "phase": run.phase,
        "status": run.status,
        "schema_version": run.schema_version,
        "workflow_version": run.workflow_version,
        "prompt_bundle_version": run.prompt_bundle_version,
        "pending_decision": approval,
        "decisions": [
            {
                "id": d.id,
                "outcome": d.outcome,
                "actor_user_id": d.actor_user_id,
                "authority_basis": d.authority_basis,
                "payload_hash": d.payload_hash,
                "note": d.note,
                "decided_at": d.decided_at.isoformat(),
            }
            for d in decisions
        ],
        "projection": run.state_projection_json,
        "checkpoint": checkpoint_info,
        "events": [
            {
                "id": e.id,
                "event_type": e.event_type,
                "payload": e.payload_json,
                "created_at": e.created_at.isoformat(),
            }
            for e in events
        ],
        "last_error_code": run.last_error_code,
        "last_error_message": run.last_error_message,
    }


def _poll_run_events_sync(tenant_id: str, run_id: str, last_id: int) -> tuple[list[dict[str, Any]], str]:
    with tenant_session(tenant_id) as db:
        new_events = db.execute(
            select(RunEvent)
            .where(
                RunEvent.tenant_id == tenant_id,
                RunEvent.run_id == run_id,
                RunEvent.id > last_id,
            )
            .order_by(RunEvent.id.asc())
        ).scalars().all()
        current_run = db.execute(
            select(WorkflowRun).where(WorkflowRun.tenant_id == tenant_id, WorkflowRun.id == run_id)
        ).scalar_one()
        serialized = [
            {
                "id": ev.id,
                "event_type": ev.event_type,
                "payload": ev.payload_json,
                "created_at": ev.created_at.isoformat(),
            }
            for ev in new_events
        ]
        return serialized, current_run.status


@app.get("/api/v1/runs/{run_id}/stream")
async def stream_run_events(run_id: str, actor: ActorContext = Depends(get_current_actor)) -> StreamingResponse:
    def _verify_exists() -> bool:
        with tenant_session(actor.tenant_id) as db:
            return (
                db.execute(
                    select(WorkflowRun.id).where(WorkflowRun.tenant_id == actor.tenant_id, WorkflowRun.id == run_id)
                ).first()
                is not None
            )

    if not await anyio.to_thread.run_sync(_verify_exists):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail={"code": "NOT_FOUND", "message": "Run not found"})

    async def event_gen():
        last_id = 0
        for _ in range(120):
            new_events, run_status = await anyio.to_thread.run_sync(
                _poll_run_events_sync, actor.tenant_id, run_id, last_id
            )
            for ev in new_events:
                last_id = ev["id"]
                yield f"id: {ev['id']}\nevent: {ev['event_type']}\ndata: {json.dumps(ev)}\n\n"

            if run_status in ("waiting_for_approval", "waiting_for_input", "completed", "failed", "cancelled"):
                yield f"event: stream_closed\ndata: {json.dumps({'run_id': run_id, 'status': run_status})}\n\n"
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/v1/decisions/{decision_id}/approve")
def approve_decision(
    decision_id: str,
    body: DecisionActionBody,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    return submit_approval_decision(
        actor=actor,
        decision_id=decision_id,
        outcome="approved",
        expected_version=body.expected_version,
        expected_payload_hash=body.expected_payload_hash,
        idempotency_key=idempotency_key,
        note=body.note,
    )


@app.post("/api/v1/decisions/{decision_id}/reject")
def reject_decision(
    decision_id: str,
    body: DecisionActionBody,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    return submit_approval_decision(
        actor=actor,
        decision_id=decision_id,
        outcome="rejected",
        expected_version=body.expected_version,
        expected_payload_hash=body.expected_payload_hash,
        idempotency_key=idempotency_key,
        note=body.note,
    )


@app.post("/api/v1/decisions/{decision_id}/request-changes")
def request_changes_decision(
    decision_id: str,
    body: DecisionActionBody,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    return submit_approval_decision(
        actor=actor,
        decision_id=decision_id,
        outcome="changes_requested",
        expected_version=body.expected_version,
        expected_payload_hash=body.expected_payload_hash,
        idempotency_key=idempotency_key,
        note=body.note,
    )


@app.get("/api/v1/usage/summary")
def usage_summary(actor: ActorContext = Depends(get_current_actor)) -> dict[str, Any]:
    """P1 optimization: single-pass SQL FILTER aggregates (8 queries -> 4 queries)."""
    since_24h = datetime.now(timezone.utc) - timedelta(hours=24)
    with tenant_session(actor.tenant_id) as db:
        llm_agg = db.execute(
            select(
                func.count(AiUsageEvent.id),
                func.count(AiUsageEvent.id).filter(AiUsageEvent.outcome == "cache_hit"),
                func.coalesce(func.sum(AiUsageEvent.cost_usd), Decimal("0")),
                func.coalesce(
                    func.sum(AiUsageEvent.cost_usd).filter(AiUsageEvent.created_at >= since_24h),
                    Decimal("0"),
                ),
                func.coalesce(func.sum(AiUsageEvent.prompt_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.completion_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.cached_tokens), 0),
                func.coalesce(func.sum(AiUsageEvent.reasoning_tokens), 0),
            ).where(AiUsageEvent.tenant_id == actor.tenant_id)
        ).one()

        tav_agg = db.execute(
            select(
                func.count(ExternalSearchEvent.id),
                func.count(ExternalSearchEvent.id).filter(ExternalSearchEvent.outcome == "cache_hit"),
                func.coalesce(func.sum(ExternalSearchEvent.credits_used), 0),
                func.coalesce(func.sum(ExternalSearchEvent.estimated_cost_usd), Decimal("0")),
                func.coalesce(
                    func.sum(ExternalSearchEvent.estimated_cost_usd).filter(
                        ExternalSearchEvent.created_at >= since_24h
                    ),
                    Decimal("0"),
                ),
            ).where(ExternalSearchEvent.tenant_id == actor.tenant_id)
        ).one()

        recent_llm = db.execute(
            select(AiUsageEvent)
            .where(AiUsageEvent.tenant_id == actor.tenant_id)
            .order_by(desc(AiUsageEvent.created_at))
            .limit(15)
        ).scalars().all()
        recent_tavily = db.execute(
            select(ExternalSearchEvent)
            .where(ExternalSearchEvent.tenant_id == actor.tenant_id)
            .order_by(desc(ExternalSearchEvent.created_at))
            .limit(15)
        ).scalars().all()

        llm_calls = int(llm_agg[0])
        llm_cache_hits = int(llm_agg[1])
        llm_cost_total = Decimal(llm_agg[2])
        llm_cost_24h = Decimal(llm_agg[3])

        tavily_calls = int(tav_agg[0])
        tavily_cache_hits = int(tav_agg[1])
        tavily_credits = int(tav_agg[2])
        tavily_cost_total = Decimal(tav_agg[3])
        tavily_cost_24h = Decimal(tav_agg[4])

        combined_total = llm_cost_total + tavily_cost_total
        combined_24h = llm_cost_24h + tavily_cost_24h
        remaining_24h = max(Decimal("0"), settings.tenant_daily_ai_budget_usd - combined_24h)

        return {
            "tenant_id": actor.tenant_id,
            "daily_budget_usd": str(settings.tenant_daily_ai_budget_usd),
            "combined_24h_spend_usd": str(combined_24h.quantize(Decimal("0.000001"))),
            "remaining_24h_budget_usd": str(remaining_24h.quantize(Decimal("0.000001"))),
            "total_combined_spend_usd": str(combined_total.quantize(Decimal("0.000001"))),
            "total_calls": llm_calls,
            "total_observed_cost_usd": str(llm_cost_total.quantize(Decimal("0.000001"))),
            "llm": {
                "total_calls": llm_calls,
                "cache_hits": llm_cache_hits,
                "observed_cost_usd": str(llm_cost_total.quantize(Decimal("0.000001"))),
                "cost_24h_usd": str(llm_cost_24h.quantize(Decimal("0.000001"))),
                "prompt_tokens": int(llm_agg[4]),
                "completion_tokens": int(llm_agg[5]),
                "cached_tokens": int(llm_agg[6]),
                "reasoning_tokens": int(llm_agg[7]),
            },
            "tavily": {
                "total_calls": tavily_calls,
                "cache_hits": tavily_cache_hits,
                "total_credits": tavily_credits,
                "estimated_cost_usd": str(tavily_cost_total.quantize(Decimal("0.000001"))),
                "cost_24h_usd": str(tavily_cost_24h.quantize(Decimal("0.000001"))),
                "cost_per_credit_usd": str(settings.tavily_cost_per_credit_usd),
            },
            "recent": [
                {
                    "id": r.id,
                    "run_id": r.run_id,
                    "profile": r.profile,
                    "actual_model": r.actual_model,
                    "provider": r.provider,
                    "prompt_tokens": r.prompt_tokens,
                    "completion_tokens": r.completion_tokens,
                    "cached_tokens": r.cached_tokens,
                    "reasoning_tokens": r.reasoning_tokens,
                    "cost_usd": str(r.cost_usd) if r.cost_usd is not None else None,
                    "cost_status": r.cost_status,
                    "latency_ms": r.latency_ms,
                    "outcome": r.outcome,
                    "created_at": r.created_at.isoformat(),
                }
                for r in recent_llm
            ],
            "recent_tavily": [
                {
                    "id": t.id,
                    "run_id": t.run_id,
                    "query_preview": t.query_preview,
                    "search_depth": t.search_depth,
                    "results_count": t.results_count,
                    "credits_used": t.credits_used,
                    "estimated_cost_usd": str(t.estimated_cost_usd),
                    "cost_status": t.cost_status,
                    "latency_ms": t.latency_ms,
                    "outcome": t.outcome,
                    "created_at": t.created_at.isoformat(),
                }
                for t in recent_tavily
            ],
        }


def _poll_run_snapshot_sync(tenant_id: str, run_id: str) -> tuple[str, dict[str, Any], str | None]:
    with tenant_session(tenant_id) as db:
        run = db.execute(
            select(WorkflowRun).where(WorkflowRun.tenant_id == tenant_id, WorkflowRun.id == run_id)
        ).scalar_one()
        return run.status, dict(run.state_projection_json or {}), run.last_error_message


@app.post("/api/ag-ui/agent")
async def ag_ui_bridge(
    body: AgUiRunBody,
    actor: ActorContext = Depends(get_current_actor),
) -> StreamingResponse:
    user_text = ""
    for msg in reversed(body.messages):
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str):
                user_text = content.strip()
                break
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
                user_text = " ".join(parts).strip()
                break

    if not user_text:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User message required")

    ui_lang = body.lang or actor.default_language or "en"
    turn = await anyio.to_thread.run_sync(
        lambda: evaluate_copilot_turn(
            actor=actor,
            user_text=user_text,
            request_id=body.requestId,
            ui_lang=ui_lang,
        )
    )

    if turn.get("mode") == "direct":
        async def direct_stream():
            run_id = body.runId or new_id("agui")
            thread_id = body.threadId or new_id("thr")
            msg_id = new_id("msg")
            yield f"data: {json.dumps({'type': 'RUN_STARTED', 'threadId': thread_id, 'runId': run_id})}\n\n"
            yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_START', 'messageId': msg_id, 'role': 'assistant'})}\n\n"
            yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': msg_id, 'delta': turn['reply']})}\n\n"
            if turn.get("client_action") or turn.get("email_draft"):
                yield f"data: {json.dumps({'type': 'COPILOT_META', 'client_action': turn.get('client_action'), 'email_draft': turn.get('email_draft')})}\n\n"
            yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_END', 'messageId': msg_id})}\n\n"
            yield f"data: {json.dumps({'type': 'RUN_FINISHED', 'threadId': thread_id, 'runId': run_id})}\n\n"

        return StreamingResponse(
            direct_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    created = await anyio.to_thread.run_sync(
        lambda: _enqueue_intake_run(actor, turn["prompt"], lang=ui_lang)
    )
    run_id = created["run_id"]
    thread_id = created["thread_id"]
    ref_code = created["reference_code"]
    is_fr = (ui_lang or "").lower().startswith("fr")

    async def ag_ui_stream():
        msg_id = new_id("msg")
        start_delta = (
            f"Analyse ReAct démarrée pour {ref_code} (OpenRouter DeepSeek V4.1 Flash)..."
            if is_fr
            else f"Started bounded ReAct run {ref_code} (OpenRouter DeepSeek V4.1 Flash)..."
        )
        yield f"data: {json.dumps({'type': 'RUN_STARTED', 'threadId': thread_id, 'runId': run_id})}\n\n"
        yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_START', 'messageId': msg_id, 'role': 'assistant'})}\n\n"
        yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': msg_id, 'delta': start_delta})}\n\n"

        for _ in range(90):
            status_val, proj, err_msg = await anyio.to_thread.run_sync(
                _poll_run_snapshot_sync, actor.tenant_id, run_id
            )
            if status_val in ("waiting_for_input", "waiting_for_approval"):
                draft = proj.get("draft_card") or {}
                summary = draft.get("summary_explanation") or "Draft extracted and ready for review."
                leads_count = len(proj.get("external_leads") or [])
                leads_note = (
                    (f" {leads_count} fournisseur(s) identifié(s) via Tavily." if is_fr else f" Found {leads_count} unverified external lead(s) via Tavily.")
                    if leads_count > 0
                    else ""
                )
                paused_delta = (
                    f"\n\n{summary}{leads_note}\n\nLe brouillon v1 est prêt dans l'espace de travail (Étape 1)."
                    if is_fr
                    else f"\n\n{summary}{leads_note}\n\nRequest draft v1 is ready in Stage 1 for review and confirmation."
                )
                yield f"data: {json.dumps({'type': 'STATE_SNAPSHOT', 'snapshot': {'run_id': run_id, 'request_id': created['request_id'], 'status': status_val, **proj}})}\n\n"
                yield f"data: {json.dumps({'type': 'COPILOT_META', 'client_action': {'action_type': 'jump_stage', 'request_id': created['request_id'], 'target_stage': 1, 'label': 'Ouvrir Étape 1' if is_fr else 'Open Stage 1 Draft'}, 'email_draft': None})}\n\n"
                yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': msg_id, 'delta': paused_delta})}\n\n"
                yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_END', 'messageId': msg_id})}\n\n"
                yield f"data: {json.dumps({'type': 'RUN_FINISHED', 'threadId': thread_id, 'runId': run_id})}\n\n"
                return
            if status_val == "failed":
                fail_delta = f"\n\nExtraction failed safely: {err_msg}"
                yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_CONTENT', 'messageId': msg_id, 'delta': fail_delta})}\n\n"
                yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_END', 'messageId': msg_id})}\n\n"
                yield f"data: {json.dumps({'type': 'RUN_FINISHED', 'threadId': thread_id, 'runId': run_id})}\n\n"
                return
            await asyncio.sleep(0.4)

        yield f"data: {json.dumps({'type': 'TEXT_MESSAGE_END', 'messageId': msg_id})}\n\n"
        yield f"data: {json.dumps({'type': 'RUN_FINISHED', 'threadId': thread_id, 'runId': run_id})}\n\n"

    return StreamingResponse(
        ag_ui_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
