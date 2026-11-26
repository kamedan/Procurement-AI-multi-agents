from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import desc, select

from app.domain.models import (
    ApprovalRequest,
    Comparison,
    PurchaseOrder,
    PurchaseRequest,
    Quotation,
    RequestVersion,
    Supplier,
)
from app.infrastructure.auth import ActorContext
from app.infrastructure.db import tenant_session
from app.infrastructure.openrouter import ModelGatewayError, gateway


class CopilotDraftPatch(BaseModel):
    title: str | None = Field(default=None, description="Suggested title if user asked to edit draft, else null")
    item_summary: str | None = Field(default=None, description="Suggested item summary if edited, else null")
    quantity: int | None = Field(default=None, description="Suggested integer quantity if edited, else null")
    budget_cap: str | None = Field(default=None, description="Suggested decimal budget string if edited, else null")
    currency_code: str | None = Field(default=None, description="Suggested 3-letter ISO currency if edited, else null")
    location: str | None = Field(default=None, description="Suggested location if edited, else null")
    delivery_window_days: int | None = Field(default=None, description="Suggested delivery days if edited, else null")
    mandatory_specs: list[str] | None = Field(default=None, description="Updated full list of mandatory specs if edited, else null")


class CopilotStructuredReply(BaseModel):
    reply_markdown: str = Field(
        description="Concise, evidence-grounded answer in the requested language (EN or FR). Cite exact numbers, suppliers, and statuses."
    )
    action_type: str = Field(
        description="Safe UI helper action: 'none', 'jump_stage', or 'prefill_draft' (NEVER approve or mutate directly)"
    )
    target_stage: int | None = Field(
        default=None,
        description="Stage 1..6 to jump to when action_type is 'jump_stage' or 'prefill_draft', else null",
    )
    action_label: str | None = Field(
        default=None,
        description="Short button label in the user's language (e.g. 'Open Stage 4 Comparison' or 'Aller à l'étape 4')",
    )
    email_draft_subject: str | None = Field(
        default=None,
        description="Supplier clarification email subject if the user asked to draft an email/message, else null",
    )
    email_draft_body: str | None = Field(
        default=None,
        description="Supplier clarification email body if the user asked to draft an email/message, else null",
    )
    draft_patch: CopilotDraftPatch | None = Field(
        default=None,
        description="Unsubmitted Stage 1 form prefill values ONLY when the user explicitly asked to modify/update the current request draft, else null",
    )


COPILOT_SYSTEM_PROMPT = (
    "You are ProcureAI's grounded Procurement Command Copilot routed via OpenRouter Jev Router. "
    "Rules:\n"
    "1. Ground every commercial number, supplier name, eligibility status, and spec verdict strictly in the provided Active Case Context.\n"
    "2. Respond in French ('fr') if Requested Language is 'fr' or the user writes in French; otherwise respond in English ('en').\n"
    "3. You NEVER approve awards, release POs, verify suppliers, or invent numbers. If asked to approve, explain that an authorized human approver must click Approve in Stage 5 and set action_type='jump_stage', target_stage=5.\n"
    "4. If the user asks to modify/edit the current request draft (e.g. change quantity, budget, location, or add a spec), set action_type='prefill_draft', target_stage=1, and populate draft_patch so the UI pre-fills the unsubmitted form for human confirmation.\n"
    "5. If the user asks to draft a clarification or negotiation email for missing freight, tax/TVA, delivery, or unconfirmed specs, populate email_draft_subject and email_draft_body.\n"
    "Return strict JSON matching the schema."
)

_OUT_OF_SCOPE_KEYWORDS = (
    "paid spend",
    "three-way match",
    "3-way match",
    "stripe",
    "subscription",
    "abonnement",
    "facture payée",
    "dépenses payées",
    "comptabilité générale",
)

_APPROVAL_INTENT_RE = re.compile(
    r"\b(approve|approuver|approuve|valider le bon|release the po|award the order now)\b",
    flags=re.IGNORECASE,
)

_NEW_INTAKE_RE = re.compile(
    r"^(?:create|new|start|draft|créer|creer|nouvelle demande|lancer une demande|we need|i need|nous avons besoin|besoin de)\b",
    flags=re.IGNORECASE,
)


def _detect_fr(user_text: str, ui_lang: str) -> bool:
    if (ui_lang or "").lower().startswith("fr"):
        return True
    low = user_text.lower()
    return any(w in low for w in ("bonjour", "pourquoi", "devis", "fournisseur", "demande", "bon de commande", "étape", "clarification"))


def _build_case_context_text(tenant_id: str, request_id: str | None) -> tuple[str, str | None]:
    with tenant_session(tenant_id) as db:
        pr = None
        if request_id:
            pr = db.execute(
                select(PurchaseRequest).where(PurchaseRequest.tenant_id == tenant_id, PurchaseRequest.id == request_id)
            ).scalar_one_or_none()
        if pr is None:
            pr = db.execute(
                select(PurchaseRequest)
                .where(PurchaseRequest.tenant_id == tenant_id)
                .order_by(desc(PurchaseRequest.created_at))
                .limit(1)
            ).scalar_one_or_none()
        if pr is None:
            return "No active purchase request in workspace yet.", None

        ver = db.execute(
            select(RequestVersion)
            .where(RequestVersion.tenant_id == tenant_id, RequestVersion.request_id == pr.id)
            .order_by(desc(RequestVersion.version_number))
            .limit(1)
        ).scalar_one_or_none()
        vp = (ver.structured_payload_json or {}) if ver else {}

        quotes = db.execute(
            select(Quotation, Supplier)
            .join(Supplier, Quotation.supplier_id == Supplier.id)
            .where(Quotation.tenant_id == tenant_id, Quotation.request_id == pr.id)
            .order_by(Quotation.created_at.asc())
        ).all()

        comp = db.execute(
            select(Comparison)
            .where(Comparison.tenant_id == tenant_id, Comparison.request_id == pr.id)
            .order_by(desc(Comparison.version_number))
            .limit(1)
        ).scalar_one_or_none()

        apr = db.execute(
            select(ApprovalRequest)
            .where(
                ApprovalRequest.tenant_id == tenant_id,
                ApprovalRequest.request_id == pr.id,
                ApprovalRequest.status == "pending",
            )
            .order_by(desc(ApprovalRequest.created_at))
            .limit(1)
        ).scalar_one_or_none()

        po = db.execute(
            select(PurchaseOrder)
            .where(PurchaseOrder.tenant_id == tenant_id, PurchaseOrder.request_id == pr.id)
            .order_by(desc(PurchaseOrder.created_at))
            .limit(1)
        ).scalar_one_or_none()

        lines = [
            f"Active Request: {pr.reference_code} (id={pr.id}, v{pr.current_version}, status={pr.status})",
            f"Title: {pr.title} | Item: {vp.get('item_summary', pr.title)}",
            f"Qty: {vp.get('quantity', 1)} {vp.get('unit', 'units')} | Currency: {pr.currency_code} | Budget Cap: {pr.budget_cap or 'None'} | Timbre Fiscal: {pr.apply_fiscal_stamp}",
            f"Location: {pr.location or 'Unspecified'} | Deadline: {vp.get('delivery_window_days') or 'Unspecified'} days",
            f"Mandatory Specs: {', '.join(vp.get('mandatory_specs') or []) or 'None'}",
        ]

        if comp and comp.result_json:
            cj = comp.result_json
            lines.append(f"Latest Comparison v{comp.version_number}: recommended={cj.get('recommended_supplier_name') or 'None'} | {cj.get('explanation')}")
            for off in (cj.get("offers") or [])[:6]:
                sv = (off.get("spec_verification") or {}).get("overall_status")
                lines.append(
                    f"  - Offer {off['quote_code']} ({off['supplier_name']}): total={off['currency_code']} {off['total_quoted_cost'] or 'Incomplete'}, "
                    f"delivery={off['delivery_days']}d, specs={sv or off['meets_mandatory_specs']}, eligibility={off['eligibility']}, "
                    f"reasons={'; '.join(off.get('failure_reasons') or ['OK'])}"
                )
        elif quotes:
            lines.append(f"Quotations on file ({len(quotes)}, comparison not run yet):")
            for q, s in quotes[:6]:
                lines.append(
                    f"  - {q.quote_code} ({s.name}): unit={q.currency_code} {q.unit_price}, freight={q.freight_amount}, tax={q.quoted_tax_amount}, delivery={q.delivery_days}d"
                )
        else:
            lines.append("Quotations: 0 on file.")

        if apr:
            lines.append(f"Pending Approval: {apr.decision_type} for {apr.currency_code} {apr.amount} (id={apr.id})")
        if po:
            lines.append(f"Purchase Order: {po.po_number or 'Draft'} status={po.status} total={po.currency_code} {po.total_amount}")

        return "\n".join(lines), pr.id


def evaluate_copilot_turn(
    *,
    actor: ActorContext,
    user_text: str,
    request_id: str | None,
    ui_lang: str = "en",
) -> dict[str, Any]:
    """
    Determines whether a Copilot prompt is:
    1) Out-of-scope ($0 deterministic boundary response),
    2) An autonomous-approval request ($0 governance refusal + Stage 5 jump chip),
    3) An explicit new Purchase Request intake command ('mode': 'intake'), or
    4) A grounded active-case question / clarification email draft / Stage 1 draft prefill via `typesafe/jev-router`.
    """
    is_fr = _detect_fr(user_text, ui_lang)
    lowered = user_text.lower()

    if any(k in lowered for k in _OUT_OF_SCOPE_KEYWORDS):
        reply = (
            "L'analyse des factures payées, le rapprochement à 3 voies et la facturation d'abonnements sont hors du périmètre MVP de ProcureAI. "
            "Je peux analyser votre demande active, expliquer le comparatif des devis, rédiger un email de clarification fournisseur ou pré-remplir une modification."
            if is_fr
            else "Paid-invoice spend analytics, three-way matching, and subscription billing are outside the ProcureAI validation MVP. "
            "I can explain your active quotation comparison, draft supplier clarification emails, pre-fill Stage 1 edits, or start a new purchase request."
        )
        return {"mode": "direct", "reply": reply, "client_action": None, "email_draft": None}

    if _APPROVAL_INTENT_RE.search(user_text) and not any(w in lowered for w in ("why", "pourquoi", "who", "qui", "how", "comment")):
        reply = (
            "Gouvernance ProcureAI : un agent IA ne peut jamais approuver une attribution ni émettre un Bon de Commande. "
            "J'ai préparé un raccourci vers l'Étape 5 afin qu'un approbateur habilité examine le dossier et valide la décision."
            if is_fr
            else "ProcureAI governance rule: an AI agent can never approve a supplier award or release a Purchase Order. "
            "Use the shortcut below to open Stage 5 so an authorized human approver can review and sign off on the immutable packet."
        )
        return {
            "mode": "direct",
            "reply": reply,
            "client_action": {
                "action_type": "jump_stage",
                "target_stage": 5,
                "label": "Ouvrir l'Étape 5 (Approbation)" if is_fr else "Open Stage 5 (Approval Packet)",
            },
            "email_draft": None,
        }

    # Explicit new request creation command (when no edit/question verb targets the current request)
    is_question_or_edit = any(
        w in lowered
        for w in (
            "why",
            "pourquoi",
            "compare",
            "comparatif",
            "email",
            "courriel",
            "clarif",
            "change ",
            "update ",
            "modifier",
            "modifie",
            "set quantity",
            "add spec",
            "explain",
            "explique",
            "which supplier",
            "quel fournisseur",
        )
    )
    if _NEW_INTAKE_RE.search(user_text.strip()) and not is_question_or_edit and len(user_text.strip()) >= 12:
        if actor.has_role("requester") or actor.has_role("buyer"):
            return {"mode": "intake", "prompt": user_text.strip()}

    context_str, resolved_req_id = _build_case_context_text(actor.tenant_id, request_id)
    user_prompt = (
        f"Requested Language: {'fr' if is_fr else 'en'}\n"
        f"Active Actor: {actor.display_name} (roles: {', '.join(actor.roles)})\n\n"
        f"=== Active Case Context ===\n{context_str}\n\n"
        f"=== User Message ===\n{user_text.strip()}"
    )

    try:
        gw = gateway.invoke_structured(
            tenant_id=actor.tenant_id,
            run_id=None,
            profile="reasoning",
            prompt_version="copilot.cmd.v1",
            schema_version="cop.v1",
            schema_cls=CopilotStructuredReply,
            system_prompt=COPILOT_SYSTEM_PROMPT,
            user_prompt=user_prompt,
            max_output_tokens=750,
            max_input_chars=3800,
        )
        parsed: CopilotStructuredReply = gw.parsed  # type: ignore[assignment]
        act_type = (parsed.action_type or "none").strip().lower()
        client_action: dict[str, Any] | None = None
        if act_type in ("jump_stage", "prefill_draft"):
            client_action = {
                "action_type": act_type,
                "request_id": resolved_req_id,
                "target_stage": parsed.target_stage or (1 if act_type == "prefill_draft" else 4),
                "label": parsed.action_label
                or (
                    ("Appliquer au brouillon (Étape 1)" if is_fr else "Pre-fill Stage 1 Draft")
                    if act_type == "prefill_draft"
                    else (f"Aller à l'Étape {parsed.target_stage or 4}" if is_fr else f"Open Stage {parsed.target_stage or 4}")
                ),
                "draft_patch": parsed.draft_patch.model_dump(exclude_none=True) if parsed.draft_patch else None,
            }

        email_draft = None
        if parsed.email_draft_body:
            email_draft = {
                "subject": parsed.email_draft_subject or ("Demande de clarification sur votre devis" if is_fr else "Quotation Clarification Request"),
                "body": parsed.email_draft_body,
            }

        return {
            "mode": "direct",
            "reply": parsed.reply_markdown,
            "client_action": client_action,
            "email_draft": email_draft,
            "model": gw.actual_model,
            "cache_hit": gw.cache_hit,
        }
    except ModelGatewayError as exc:
        fallback_msg = (
            f"Résumé déterministe du dossier ({exc.code}) :\n{context_str}"
            if is_fr
            else f"Deterministic case snapshot ({exc.code}):\n{context_str}"
        )
        return {"mode": "direct", "reply": fallback_msg, "client_action": None, "email_draft": None}
