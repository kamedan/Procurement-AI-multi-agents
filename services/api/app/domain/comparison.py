from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from app.domain.money import format_money_str


def evaluate_comparison(
    *,
    request_payload: dict[str, Any],
    quotations_with_suppliers: list[tuple[Any, Any]],
) -> dict[str, Any]:
    """
    Deterministic procurement comparison engine (PROCUREAI_MASTER_PLAN.md Sections 13.2 & 13.3).
    - Decimal arithmetic only (zero binary float).
    - Missing freight or quoted tax remains `unknown` (never silently treated as 0.00).
    - Mandatory eligibility checks run BEFORE ranking eligible offers by lowest total quoted cost.
    - Budget headroom is explicitly distinguished from procurement savings.
    """
    req_qty = int(request_payload.get("quantity") or 1)
    req_currency = str(request_payload.get("currency_code") or "USD").upper()
    req_budget_raw = request_payload.get("budget_cap")
    req_budget = Decimal(str(req_budget_raw)) if req_budget_raw not in (None, "", "0", "0.00") else None
    req_deadline_days = request_payload.get("delivery_window_days")
    if req_deadline_days is not None:
        req_deadline_days = int(req_deadline_days)
    apply_fiscal_stamp = bool(request_payload.get("apply_fiscal_stamp"))

    now = datetime.now(timezone.utc)
    evaluated_offers: list[dict[str, Any]] = []

    for quote, supplier in quotations_with_suppliers:
        currency = str(quote.currency_code).upper()
        item_subtotal = Decimal(quote.unit_price) * Decimal(quote.quantity)
        discount = Decimal(quote.discount_amount or Decimal("0.00"))
        freight = Decimal(quote.freight_amount) if quote.freight_amount is not None else None
        quoted_tax = Decimal(quote.quoted_tax_amount) if quote.quoted_tax_amount is not None else None
        raw_stamp = Decimal(getattr(quote, "fiscal_stamp_amount", None) or Decimal("0.000"))
        fiscal_stamp = (
            raw_stamp
            if raw_stamp > Decimal("0")
            else (Decimal("1.000") if (apply_fiscal_stamp and currency == "TND") else Decimal("0"))
        )

        missing_cost_components: list[str] = []
        if freight is None:
            missing_cost_components.append("freight")
        if quoted_tax is None:
            missing_cost_components.append("quoted_tax")

        total_known = len(missing_cost_components) == 0
        total_quoted_cost = (
            item_subtotal
            - discount
            + (freight or Decimal("0.00"))
            + (quoted_tax or Decimal("0.00"))
            + fiscal_stamp
        )

        # Mandatory eligibility checks: pass | fail | unknown (3-state Jev spec verifier + human override)
        checks: dict[str, dict[str, str]] = {}
        ev_json = dict(quote.evidence_json or {})
        human_override = ev_json.get("human_spec_override")
        spec_ver = ev_json.get("spec_verification")
        effective_spec_ver: dict[str, Any] | None = None

        if isinstance(human_override, dict) and human_override.get("quote_revision") == quote.revision_number:
            ov_status = str(human_override.get("status") or "needs_clarification")
            ov_reason = str(human_override.get("reason") or "Human spec override")
            mapped_check = "pass" if ov_status == "pass" else ("fail" if ov_status == "fail" else "unknown")
            checks["mandatory_specs"] = {
                "status": mapped_check,
                "reason": f"Human verified ({human_override.get('editor_name', 'Buyer')}): {ov_reason}",
            }
            effective_spec_ver = {
                **(spec_ver if isinstance(spec_ver, dict) else {}),
                "overall_status": ov_status,
                "summary_reason": f"Human override by {human_override.get('editor_name', 'Buyer')}: {ov_reason}",
                "human_override": human_override,
            }
        elif isinstance(spec_ver, dict) and spec_ver.get("overall_status") in ("pass", "needs_clarification", "fail"):
            sv_status = str(spec_ver["overall_status"])
            sv_reason = str(spec_ver.get("summary_reason") or "")
            if sv_status == "pass":
                checks["mandatory_specs"] = {
                    "status": "pass",
                    "reason": sv_reason or "Meets all mandatory specifications (Jev verified)",
                }
            elif sv_status == "fail":
                checks["mandatory_specs"] = {
                    "status": "fail",
                    "reason": sv_reason or "Fails mandatory technical specification check",
                }
            else:
                checks["mandatory_specs"] = {
                    "status": "unknown",
                    "reason": sv_reason or "Mandatory specification compliance needs supplier clarification",
                }
            effective_spec_ver = spec_ver
        else:
            checks["mandatory_specs"] = {
                "status": "pass" if quote.meets_mandatory_specs else "fail",
                "reason": "Meets all mandatory specifications"
                if quote.meets_mandatory_specs
                else "Does not satisfy mandatory technical specifications",
            }
        checks["quantity"] = {
            "status": "pass" if int(quote.quantity) == req_qty else "fail",
            "reason": f"Matches requested quantity ({req_qty})"
            if int(quote.quantity) == req_qty
            else f"Partial or mismatched quantity ({quote.quantity} vs {req_qty} required)",
        }
        checks["currency"] = {
            "status": "pass" if currency == req_currency else "fail",
            "reason": f"Quoted in {req_currency}"
            if currency == req_currency
            else f"Mixed currency ({currency} vs {req_currency} required)",
        }
        if req_deadline_days is None:
            checks["delivery_deadline"] = {
                "status": "pass" if quote.delivery_days is not None else "unknown",
                "reason": f"Delivery in {quote.delivery_days} days (no hard cap set)"
                if quote.delivery_days is not None
                else "Delivery lead time not provided",
            }
        elif quote.delivery_days is None:
            checks["delivery_deadline"] = {
                "status": "unknown",
                "reason": f"Delivery lead time unknown (deadline is {req_deadline_days} days)",
            }
        elif int(quote.delivery_days) <= req_deadline_days:
            checks["delivery_deadline"] = {
                "status": "pass",
                "reason": f"{quote.delivery_days} days meets {req_deadline_days}-day deadline",
            }
        else:
            checks["delivery_deadline"] = {
                "status": "fail",
                "reason": f"{quote.delivery_days}-day delivery exceeds {req_deadline_days}-day deadline",
            }

        if not total_known:
            checks["cost_completeness"] = {
                "status": "unknown",
                "reason": f"Missing {', '.join(missing_cost_components)} (unknown != zero)",
            }
        else:
            checks["cost_completeness"] = {
                "status": "pass",
                "reason": "All quoted cost components present",
            }

        if req_budget is None:
            checks["budget_cap"] = {"status": "pass", "reason": "No hard request budget cap configured"}
        elif currency != req_currency:
            checks["budget_cap"] = {"status": "fail", "reason": "Cannot compare mixed currency against budget cap"}
        elif not total_known:
            checks["budget_cap"] = {"status": "unknown", "reason": "Cannot verify budget cap with missing cost fields"}
        elif total_quoted_cost <= req_budget:
            checks["budget_cap"] = {
                "status": "pass",
                "reason": f"Within budget cap ({req_currency} {format_money_str(req_budget, req_currency)})",
            }
        else:
            checks["budget_cap"] = {
                "status": "fail",
                "reason": f"Exceeds budget cap ({req_currency} {format_money_str(req_budget, req_currency)})",
            }

        valid_until = quote.valid_until
        if valid_until.tzinfo is None:
            valid_until = valid_until.replace(tzinfo=timezone.utc)
        checks["quote_validity"] = {
            "status": "pass" if valid_until >= now else "fail",
            "reason": f"Valid until {valid_until.strftime('%d %b %Y')}"
            if valid_until >= now
            else f"Quotation expired on {valid_until.strftime('%d %b %Y')}",
        }

        statuses = [c["status"] for c in checks.values()]
        if "fail" in statuses:
            eligibility = "ineligible"
        elif "unknown" in statuses:
            eligibility = "needs_clarification"
        else:
            eligibility = "eligible"

        failure_reasons = [c["reason"] for c in checks.values() if c["status"] in ("fail", "unknown")]
        headroom = (
            (req_budget - total_quoted_cost)
            if (req_budget is not None and total_known and currency == req_currency)
            else None
        )

        evaluated_offers.append(
            {
                "quotation_id": quote.id,
                "quote_code": quote.quote_code,
                "revision_number": quote.revision_number,
                "supplier_id": supplier.id,
                "supplier_name": supplier.name,
                "supplier_verification_status": supplier.verification_status,
                "currency_code": currency,
                "quantity": int(quote.quantity),
                "unit_price": format_money_str(Decimal(quote.unit_price), currency),
                "item_subtotal": format_money_str(item_subtotal, currency),
                "discount_amount": format_money_str(discount, currency),
                "freight_amount": format_money_str(freight, currency) if freight is not None else None,
                "quoted_tax_amount": format_money_str(quoted_tax, currency) if quoted_tax is not None else None,
                "fiscal_stamp_amount": format_money_str(fiscal_stamp, currency),
                "total_quoted_cost": format_money_str(total_quoted_cost, currency) if total_known else None,
                "_sort_total": total_quoted_cost if total_known else Decimal("999999999999"),
                "budget_headroom": format_money_str(headroom, currency) if headroom is not None else None,
                "delivery_days": quote.delivery_days,
                "warranty_months": quote.warranty_months,
                "payment_terms": quote.payment_terms,
                "meets_mandatory_specs": checks["mandatory_specs"]["status"] == "pass",
                "spec_verification": effective_spec_ver,
                "valid_until": valid_until.isoformat(),
                "source_filename": quote.source_filename or f"{supplier.name} quote.pdf",
                "confirmed": bool(quote.confirmed),
                "eligibility": eligibility,
                "checks": checks,
                "failure_reasons": failure_reasons,
                "missing_cost_components": missing_cost_components,
                "corrections_count": len(quote.corrections_json or []),
            }
        )

    eligible_sorted = sorted(
        [o for o in evaluated_offers if o["eligibility"] == "eligible"],
        key=lambda x: x["_sort_total"],
    )
    recommended = eligible_sorted[0] if eligible_sorted else None

    for o in evaluated_offers:
        o.pop("_sort_total", None)
        o["is_recommended"] = bool(recommended and o["quotation_id"] == recommended["quotation_id"])

    if recommended:
        ineligible_cheaper = [
            o
            for o in evaluated_offers
            if o["eligibility"] == "ineligible"
            and o["total_quoted_cost"] is not None
            and Decimal(o["total_quoted_cost"]) < Decimal(recommended["total_quoted_cost"])
        ]
        extra = ""
        if ineligible_cheaper:
            cheaper = ineligible_cheaper[0]
            extra = f" {cheaper['supplier_name']} is less expensive ({cheaper['currency_code']} {cheaper['total_quoted_cost']}) but is excluded: {'; '.join(cheaper['failure_reasons'])}."
        explanation = (
            f"Lowest total among offers meeting all mandatory specifications and delivery requirements: "
            f"{recommended['supplier_name']} at {recommended['currency_code']} {recommended['total_quoted_cost']} "
            f"({recommended['delivery_days']} days delivery).{extra}"
        )
    else:
        explanation = (
            "No quotation currently meets all mandatory eligibility requirements. "
            "Review failed or unknown constraints (e.g. missing freight/tax or exceeded delivery deadline) "
            "and clarify with suppliers or amend the purchase request under policy."
        )

    return {
        "request_summary": {
            "quantity": req_qty,
            "currency_code": req_currency,
            "budget_cap": format_money_str(req_budget, req_currency) if req_budget is not None else None,
            "delivery_window_days": req_deadline_days,
            "apply_fiscal_stamp": apply_fiscal_stamp,
        },
        "offers": evaluated_offers,
        "eligible_count": len(eligible_sorted),
        "ineligible_count": sum(1 for o in evaluated_offers if o["eligibility"] == "ineligible"),
        "needs_clarification_count": sum(1 for o in evaluated_offers if o["eligibility"] == "needs_clarification"),
        "recommended_quotation_id": recommended["quotation_id"] if recommended else None,
        "recommended_supplier_name": recommended["supplier_name"] if recommended else None,
        "recommended_budget_headroom": recommended["budget_headroom"] if recommended else None,
        "explanation": explanation,
    }
