from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import uuid

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel
from sqlalchemy import select

from app.agents.m0_graph import checkpoint_adapter
from app.domain.models import (
    ApprovalRequest,
    ExternalSearchEvent,
    LlmResponseCache,
    PurchaseRequest,
    WorkflowRun,
    new_id,
)
from app.domain.money import canonical_payload_hash, format_money_str, parse_decimal
from app.infrastructure.auth import create_signed_assertion
from app.infrastructure.db import SessionLocal, tenant_session
from app.infrastructure.openrouter import gateway
from app.infrastructure.tavily import _is_safe_public_https_url
from app.main import app

client = TestClient(app)


def _auth_header(tenant_id: str, user_id: str) -> dict[str, str]:
    return {"X-ProcureAI-Assertion": create_signed_assertion(tenant_id, user_id)}


def test_decimal_money_and_canonical_hash_rejects_float() -> None:
    with pytest.raises(ValueError, match="binary float"):
        parse_decimal(18.30, "unit_price")  # type: ignore[arg-type]

    unit = parse_decimal("850.00")
    freight = parse_decimal("300.00")
    tax = parse_decimal("1000.00")
    total = unit * Decimal(20) + freight + tax
    assert format_money_str(total, "USD") == "18300.00"
    assert format_money_str(parse_decimal("2850.5"), "TND") == "2850.500"
    assert format_money_str(parse_decimal("1500"), "JPY") == "1500"

    h1 = canonical_payload_hash({"b": "2", "a": "1"})
    h2 = canonical_payload_hash({"a": "1", "b": "2"})
    assert h1 == h2


def test_rls_fails_closed_without_tenant_context() -> None:
    session = SessionLocal()
    try:
        with session.begin():
            assert session.execute(select(PurchaseRequest)).scalars().all() == []
            assert session.execute(select(ExternalSearchEvent)).scalars().all() == []
            assert session.execute(select(LlmResponseCache)).scalars().all() == []
    finally:
        session.close()


def test_two_tenant_isolation_approval_integrity_and_idempotency() -> None:
    req_id = new_id("pr")
    run_id = new_id("run")
    thread_id = f"thr_test_{uuid.uuid4().hex[:10]}"
    apr_id = new_id("apr")
    payload_hash = canonical_payload_hash({"request_id": req_id, "amount": "18300.00", "currency": "USD"})

    with tenant_session("tenant_meridian") as db:
        db.add(
            PurchaseRequest(
                id=req_id,
                tenant_id="tenant_meridian",
                reference_code=f"PR-T-{uuid.uuid4().hex[:4].upper()}",
                requester_user_id="user_daniel",
                title="20 development laptops",
                status="awaiting_approval",
                current_version=1,
                currency_code="USD",
                budget_cap=Decimal("20000.00"),
            )
        )
        db.flush()
        db.add(
            WorkflowRun(
                id=run_id,
                tenant_id="tenant_meridian",
                thread_id=thread_id,
                request_id=req_id,
                actor_user_id="user_daniel",
                phase="awaiting_approval",
                status="waiting_for_approval",
                pending_decision_id=apr_id,
                state_projection_json={},
            )
        )
        db.flush()
        db.add(
            ApprovalRequest(
                id=apr_id,
                tenant_id="tenant_meridian",
                run_id=run_id,
                request_id=req_id,
                decision_type="supplier_award",
                entity_version=1,
                payload_hash=payload_hash,
                amount=Decimal("18300.00"),
                currency_code="USD",
                requester_user_id="user_daniel",
                status="pending",
                packet_json={"title": "20 development laptops"},
                expires_at=datetime.now(timezone.utc) + timedelta(days=2),
            )
        )

    # Cross-tenant isolation
    assert client.get(f"/api/v1/runs/{run_id}", headers=_auth_header("tenant_northwind", "user_claire")).status_code == 404
    assert (
        client.post(
            f"/api/v1/decisions/{apr_id}/approve",
            headers={**_auth_header("tenant_northwind", "user_claire"), "Idempotency-Key": "cross-1"},
            json={"expected_version": 1, "expected_payload_hash": payload_hash},
        ).status_code
        == 404
    )
    with pytest.raises(PermissionError):
        checkpoint_adapter.get_checkpoint_snapshot("tenant_northwind", thread_id)

    # Separation of duties & admin != approver
    assert (
        client.post(
            f"/api/v1/decisions/{apr_id}/approve",
            headers={**_auth_header("tenant_meridian", "user_daniel"), "Idempotency-Key": "self-1"},
            json={"expected_version": 1, "expected_payload_hash": payload_hash},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/decisions/{apr_id}/approve",
            headers={**_auth_header("tenant_meridian", "user_samira"), "Idempotency-Key": "admin-1"},
            json={"expected_version": 1, "expected_payload_hash": payload_hash},
        ).status_code
        == 403
    )

    # Stale payload hash rejected
    r_stale = client.post(
        f"/api/v1/decisions/{apr_id}/approve",
        headers={**_auth_header("tenant_meridian", "user_ada"), "Idempotency-Key": "stale-1"},
        json={"expected_version": 1, "expected_payload_hash": "sha256:0000000000000000"},
    )
    assert r_stale.status_code == 409
    assert r_stale.json()["detail"]["code"] == "STALE_VERSION"

    # Authorized approval + idempotent replay + mismatch rejection
    r_ok = client.post(
        f"/api/v1/decisions/{apr_id}/approve",
        headers={**_auth_header("tenant_meridian", "user_ada"), "Idempotency-Key": "ada-approve-1"},
        json={"expected_version": 1, "expected_payload_hash": payload_hash, "note": "Verified terms"},
    )
    assert r_ok.status_code == 200
    first_body = r_ok.json()

    r_replay = client.post(
        f"/api/v1/decisions/{apr_id}/approve",
        headers={**_auth_header("tenant_meridian", "user_ada"), "Idempotency-Key": "ada-approve-1"},
        json={"expected_version": 1, "expected_payload_hash": payload_hash, "note": "Verified terms"},
    )
    assert r_replay.status_code == 200
    assert r_replay.json()["decision_id"] == first_body["decision_id"]

    r_mismatch = client.post(
        f"/api/v1/decisions/{apr_id}/approve",
        headers={**_auth_header("tenant_meridian", "user_ada"), "Idempotency-Key": "ada-approve-1"},
        json={"expected_version": 1, "expected_payload_hash": payload_hash, "note": "Tampered note"},
    )
    assert r_mismatch.status_code == 409
    assert r_mismatch.json()["detail"]["code"] == "IDEMPOTENCY_PAYLOAD_MISMATCH"


def test_tavily_ssrf_url_filter_blocks_private_and_non_https() -> None:
    assert _is_safe_public_https_url("https://vendor.example.com/catalog") is True
    assert _is_safe_public_https_url("http://vendor.example.com/catalog") is False
    assert _is_safe_public_https_url("https://localhost/admin") is False
    assert _is_safe_public_https_url("https://127.0.0.1:8000/health") is False
    assert _is_safe_public_https_url("https://169.254.169.254/latest/meta-data") is False
    assert _is_safe_public_https_url("https://10.0.0.5/internal") is False
    assert _is_safe_public_https_url("https://192.168.1.10/router") is False
    assert _is_safe_public_https_url("https://api.internal/secrets") is False
    assert _is_safe_public_https_url("file:///etc/passwd") is False


def test_external_search_toggle_rbac_and_policy_enforcement() -> None:
    # Non-admin (Daniel) cannot modify tenant settings
    r_denied = client.patch(
        "/api/v1/tenant/settings",
        headers=_auth_header("tenant_meridian", "user_daniel"),
        json={"external_search_enabled": False},
    )
    assert r_denied.status_code == 403

    # Tenant admin (Samira) disables external search for tenant_meridian
    r_off = client.patch(
        "/api/v1/tenant/settings",
        headers=_auth_header("tenant_meridian", "user_samira"),
        json={"external_search_enabled": False},
    )
    assert r_off.status_code == 200
    assert r_off.json()["external_search_enabled"] is False

    # Direct discovery is blocked with 403 POLICY_BLOCKED when disabled
    r_blocked = client.post(
        "/api/v1/suppliers/discover-external",
        headers=_auth_header("tenant_meridian", "user_daniel"),
        json={"query": "B2B office chairs bulk supplier"},
    )
    assert r_blocked.status_code == 403
    assert r_blocked.json()["detail"]["code"] == "POLICY_BLOCKED"

    # Re-enable for MVP testing
    r_on = client.patch(
        "/api/v1/tenant/settings",
        headers=_auth_header("tenant_meridian", "user_samira"),
        json={"external_search_enabled": True},
    )
    assert r_on.status_code == 200
    assert r_on.json()["external_search_enabled"] is True


def test_tenant_llm_cache_hits_at_zero_cost_and_stays_isolated() -> None:
    class TinySchema(BaseModel):
        item: str
        qty: int

    unique_prompt = f"Need 12 monitors cache test {uuid.uuid4().hex[:8]}"
    sys_p = "Static test prefix"
    # Seed cache for tenant_meridian only
    from app.infrastructure.openrouter import _compute_cache_key, _normalize_input_text

    key = _compute_cache_key(
        profile="extraction",
        requested_model="deepseek/deepseek-v4.1-flash",
        prompt_version="test.v1",
        schema_version="test.v1",
        system_prompt=sys_p,
        normalized_user_prompt=_normalize_input_text(unique_prompt),
    )
    gateway._store_cache(
        tenant_id="tenant_meridian",
        cache_key=key,
        profile="extraction",
        requested_model="deepseek/deepseek-v4.1-flash",
        prompt_version="test.v1",
        schema_version="test.v1",
        parsed=TinySchema(item="monitors", qty=12),
    )

    # Same tenant hits cache with $0.00 and 0 tokens (whitespace/case normalized!)
    res = gateway.invoke_structured(
        tenant_id="tenant_meridian",
        run_id=None,
        profile="extraction",
        prompt_version="test.v1",
        schema_version="test.v1",
        schema_cls=TinySchema,
        system_prompt=sys_p,
        user_prompt=f"   {unique_prompt.upper()}   ",
    )
    assert res.cache_hit is True
    assert res.cost_usd == Decimal("0.000000")
    assert res.prompt_tokens == 0
    assert res.parsed.item == "monitors"  # type: ignore[attr-defined]

    # Tenant B cannot read Tenant A's cache entry under RLS
    miss = gateway._lookup_cache(tenant_id="tenant_northwind", cache_key=key, schema_cls=TinySchema)
    assert miss is None


def test_security_headers_and_tampered_assertion_rejected() -> None:
    r_bad = client.get("/api/v1/me", headers={"X-ProcureAI-Assertion": "tampered.signature"})
    assert r_bad.status_code == 401

    r_ok = client.get("/api/v1/me", headers=_auth_header("tenant_meridian", "user_ada"))
    assert r_ok.status_code == 200
    assert r_ok.headers.get("x-content-type-options") == "nosniff"
    assert r_ok.headers.get("x-frame-options") == "DENY"
    assert r_ok.headers.get("cache-control") == "no-store"


def test_tavily_search_cache_hits_at_zero_credits_and_enforces_rls() -> None:
    from app.infrastructure.tavily import ExternalLead, _compute_tavily_cache_key, tavily_search

    q_text = f"lenovo thinkpad i7 sousse tunisia tnd {uuid.uuid4().hex[:6]}"
    ckey = _compute_tavily_cache_key(
        clean_query=q_text,
        depth="basic",
        include_raw_content=True,
        max_results=5,
    )
    tavily_search._store_cache(
        tenant_id="tenant_meridian",
        cache_key=ckey,
        clean_query=q_text,
        depth="basic",
        include_raw_content=True,
        leads=[
            ExternalLead(
                title="Mytek Sousse Pro",
                url="https://www.mytek.tn/laptop-i7",
                domain="www.mytek.tn",
                snippet="Lenovo ThinkPad i7 16GB 512GB at 2150.000 TND",
                raw_excerpt="Contact: devis@mytek.tn",
                found_emails=["devis@mytek.tn"],
                found_phones=["+216 73 000 111"],
                retrieved_at=datetime.now(timezone.utc).isoformat(),
            )
        ],
    )

    hit = tavily_search.search_leads(
        tenant_id="tenant_meridian",
        actor_user_id="user_daniel",
        query=q_text,
        max_results=5,
        search_depth="basic",
        include_raw_content=True,
    )
    assert hit.cache_hit is True
    assert hit.credits_used == 0
    assert hit.estimated_cost_usd == Decimal("0.000000")
    assert len(hit.leads) == 1
    assert hit.leads[0].domain == "www.mytek.tn"

    # Cross-tenant RLS isolation on tavily_search_cache
    assert tavily_search._lookup_cache(tenant_id="tenant_northwind", cache_key=ckey) is None


def test_jev_batch_spec_verifier_4_demo_quotes_fallback_and_human_override(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.application.sourcing import (
        BatchQuoteSpecVerification,
        QuoteSpecVerificationItem,
        SpecItemVerdict,
    )
    from app.infrastructure.openrouter import GatewayResult, ModelGatewayError

    hdr = _auth_header("tenant_meridian", "user_daniel")
    pr = client.post("/api/v1/requests/demo-20-laptops", headers=hdr).json()
    req_id = pr["request_id"]

    r_patch = client.patch(
        f"/api/v1/requests/{req_id}",
        headers=hdr,
        json={
            "title": "10 Business Laptops Sousse",
            "item_summary": "14-inch business laptops",
            "quantity": 10,
            "unit": "laptops",
            "budget_cap": "25000.000",
            "currency_code": "TND",
            "location": "Sousse, Tunisia",
            "delivery_window_days": 10,
            "mandatory_specs": ["Core i7", "16 GB RAM", "512 GB SSD"],
            "confirm": True,
        },
    )
    assert r_patch.status_code == 200

    sup_ids = []
    for sname in ("Sousse IT Alpha", "Carthage Tech Beta", "Sahel Compute Gamma"):
        sr = client.post(
            "/api/v1/suppliers",
            headers=hdr,
            json={"name": f"{sname} {uuid.uuid4().hex[:4]}", "category": "IT Hardware", "location": "Sousse, Tunisia"},
        )
        assert sr.status_code == 201
        sup_ids.append(sr.json()["id"])

    # 3 suppliers -> 4 demo quotes (pass, late delivery, spec fail, unstated spec)
    seed = client.post(
        f"/api/v1/requests/{req_id}/quotations/seed-sample",
        headers=hdr,
        json={"supplier_ids": sup_ids},
    )
    assert seed.status_code == 201
    q_ids = seed.json()["created_quotation_ids"]
    assert len(q_ids) == 4

    # 1) Test graceful fallback when OpenRouter is unavailable: comparison still runs & marks specs needs_clarification
    def _raise_unavailable(**kwargs):
        raise ModelGatewayError("MODEL_CAPABILITY_UNAVAILABLE", "Simulated outage")

    monkeypatch.setattr(gateway, "invoke_structured", _raise_unavailable)
    cmp_degraded = client.post(f"/api/v1/requests/{req_id}/compare", headers=hdr)
    assert cmp_degraded.status_code == 200
    deg_offers = cmp_degraded.json()["result"]["offers"]
    assert deg_offers[0]["eligibility"] == "needs_clarification"

    # Bump request version so quotes re-verify cleanly under mocked Jev Router verdicts
    client.patch(
        f"/api/v1/requests/{req_id}",
        headers=hdr,
        json={
            "title": "10 Business Laptops Sousse v3",
            "item_summary": "14-inch business laptops",
            "quantity": 10,
            "unit": "laptops",
            "budget_cap": "25000.000",
            "currency_code": "TND",
            "location": "Sousse, Tunisia",
            "delivery_window_days": 10,
            "mandatory_specs": ["Core i7", "16 GB RAM", "512 GB SSD"],
            "confirm": True,
        },
    )

    def _mock_jev_batch(**kwargs):
        assert kwargs["profile"] == "decision"
        parsed = BatchQuoteSpecVerification(
            evaluations=[
                QuoteSpecVerificationItem(
                    quotation_id=q_ids[0],
                    overall_status="pass",
                    summary_reason="All 3 mandatory specs explicitly satisfied.",
                    specs=[
                        SpecItemVerdict(spec="Core i7", status="pass", evidence="Core i7 stated"),
                        SpecItemVerdict(spec="16 GB RAM", status="pass", evidence="16 GB RAM stated"),
                        SpecItemVerdict(spec="512 GB SSD", status="pass", evidence="512 GB SSD stated"),
                    ],
                ),
                QuoteSpecVerificationItem(
                    quotation_id=q_ids[1],
                    overall_status="pass",
                    summary_reason="Specs satisfied (delivery checked separately).",
                    specs=[
                        SpecItemVerdict(spec="Core i7", status="pass", evidence="Core i7 stated"),
                        SpecItemVerdict(spec="16 GB RAM", status="pass", evidence="16 GB RAM stated"),
                        SpecItemVerdict(spec="512 GB SSD", status="pass", evidence="512 GB SSD stated"),
                    ],
                ),
                QuoteSpecVerificationItem(
                    quotation_id=q_ids[2],
                    overall_status="fail",
                    summary_reason="Substituted lower-tier CPU instead of Core i7.",
                    specs=[
                        SpecItemVerdict(spec="Core i7", status="fail", evidence="Does not include Core i7"),
                        SpecItemVerdict(spec="16 GB RAM", status="pass", evidence="16 GB RAM stated"),
                        SpecItemVerdict(spec="512 GB SSD", status="pass", evidence="512 GB SSD stated"),
                    ],
                ),
                QuoteSpecVerificationItem(
                    quotation_id=q_ids[3],
                    overall_status="needs_clarification",
                    summary_reason="512 GB SSD omitted from vendor datasheet.",
                    specs=[
                        SpecItemVerdict(spec="Core i7", status="pass", evidence="Core i7 stated"),
                        SpecItemVerdict(spec="16 GB RAM", status="pass", evidence="16 GB RAM stated"),
                        SpecItemVerdict(spec="512 GB SSD", status="needs_clarification", evidence="SSD size unstated"),
                    ],
                ),
            ]
        )
        return GatewayResult(
            parsed=parsed,
            requested_model="typesafe/jev-router",
            actual_model="openai/gpt-6-luna",
            provider="Azure",
            prompt_tokens=210,
            completion_tokens=160,
            cached_tokens=0,
            reasoning_tokens=0,
            cost_usd=Decimal("0.000320"),
            cost_status="observed",
            latency_ms=390,
            cache_hit=False,
        )

    monkeypatch.setattr(gateway, "invoke_structured", _mock_jev_batch)
    cmp_ok = client.post(f"/api/v1/requests/{req_id}/compare", headers=hdr)
    assert cmp_ok.status_code == 200
    offers = {o["quotation_id"]: o for o in cmp_ok.json()["result"]["offers"]}
    assert offers[q_ids[0]]["eligibility"] == "eligible"
    assert offers[q_ids[1]]["eligibility"] == "ineligible"  # late delivery
    assert offers[q_ids[2]]["eligibility"] == "ineligible"  # spec fail
    assert offers[q_ids[3]]["eligibility"] == "needs_clarification"  # unstated spec

    # 2) Attributable human spec override resolves Quote D from needs_clarification -> eligible (and wins on lower price!)
    ov_res = client.patch(
        f"/api/v1/quotations/{q_ids[3]}",
        headers=hdr,
        json={
            "spec_status_override": "pass",
            "reason": "Supplier emailed signed Lenovo datasheet confirming 512 GB NVMe SSD.",
        },
    )
    assert ov_res.status_code == 200
    assert ov_res.json()["revision_number"] == 2

    cmp_after = client.post(f"/api/v1/requests/{req_id}/compare", headers=hdr)
    assert cmp_after.status_code == 200
    offers_after = {o["quotation_id"]: o for o in cmp_after.json()["result"]["offers"]}
    assert offers_after[q_ids[3]]["eligibility"] == "eligible"
    assert cmp_after.json()["result"]["recommended_quotation_id"] == q_ids[3]


def test_sousse_tnd_preset_timbre_fiscal_inline_pdfs_agents_and_evals() -> None:
    buyer_hdr = _auth_header("tenant_meridian", "user_daniel")

    # 1. Sousse TND preset (Timbre Fiscal 1.000 TND + FR document language)
    pr = client.post("/api/v1/requests/preset-sousse-tnd", headers=buyer_hdr)
    assert pr.status_code == 201, pr.text
    req_id = pr.json()["request_id"]
    ws = client.get(f"/api/v1/requests/{req_id}/workspace", headers=buyer_hdr).json()
    assert ws["request"]["currency_code"] == "TND"
    assert ws["request"]["apply_fiscal_stamp"] is True
    assert ws["request"]["document_language"] == "fr"

    # 2. Export French RFQ PDF & check ?inline=1 header + SAMEORIGIN framing header
    sup = client.post(
        "/api/v1/suppliers",
        headers=buyer_hdr,
        json={"name": f"Mytek Sousse Test {uuid.uuid4().hex[:4]}", "category": "IT Hardware", "location": "Sousse, Tunisia"},
    ).json()
    rfq = client.post(
        f"/api/v1/requests/{req_id}/rfqs",
        headers=buyer_hdr,
        json={"supplier_ids": [sup["id"]], "response_deadline_days": 5, "lang": "fr"},
    )
    assert rfq.status_code == 201
    rfq_id = rfq.json()["id"]

    pdf_inline = client.get(f"/api/v1/rfqs/{rfq_id}/pdf?inline=1", headers=buyer_hdr)
    assert pdf_inline.status_code == 200
    assert pdf_inline.headers.get("content-disposition", "").startswith("inline;")
    assert pdf_inline.headers.get("x-frame-options") == "SAMEORIGIN"

    emails_fr = client.get(f"/api/v1/rfqs/{rfq_id}/emails?lang=fr", headers=buyer_hdr).json()
    assert "Demande de Prix" in emails_fr["drafts"][0]["subject"]

    # 3. Overview KPIs, Agents & Activity screen API, and Evaluation Scorecard API
    ov = client.get("/api/v1/overview/summary", headers=buyer_hdr)
    assert ov.status_code == 200
    assert "kpis" in ov.json() and "pending_approvals" in ov.json()

    ag = client.get("/api/v1/agents/activity", headers=buyer_hdr)
    assert ag.status_code == 200
    ag_json = ag.json()
    assert ag_json["worker"]["mode"] == "postgresql_listen_notify"
    assert len(ag_json["agents"]) == 6
    assert isinstance(ag_json["logs"], list)

    ev = client.get("/api/v1/evals/summary", headers=buyer_hdr)
    assert ev.status_code == 200
    ev_json = ev.json()
    assert ev_json["pass_rate_pct"] == 100.0
    assert ev_json["dev_summary"]["passed"] == ev_json["dev_summary"]["total"]
    assert ev_json["held_out_summary"]["passed"] == ev_json["held_out_summary"]["total"]


def test_command_copilot_deterministic_governance_and_out_of_scope() -> None:
    from app.application.copilot import evaluate_copilot_turn
    from app.infrastructure.auth import resolve_actor_context

    actor = resolve_actor_context("tenant_meridian", "user_daniel")

    # Paid spend / Stripe stays out of MVP scope ($0 deterministic response)
    r_oos = evaluate_copilot_turn(actor=actor, user_text="Analyze our Q3 paid spend and Stripe invoices", request_id=None, ui_lang="en")
    assert r_oos["mode"] == "direct"
    assert "outside the ProcureAI validation MVP" in r_oos["reply"]

    # Autonomous approval is refused in French and emits a safe Stage 5 jump chip
    r_apr = evaluate_copilot_turn(actor=actor, user_text="Approuve le devis le moins cher maintenant", request_id=None, ui_lang="fr")
    assert r_apr["mode"] == "direct"
    assert r_apr["client_action"] is not None
    assert r_apr["client_action"]["action_type"] == "jump_stage"
    assert r_apr["client_action"]["target_stage"] == 5
