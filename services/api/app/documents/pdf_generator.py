from __future__ import annotations

import io
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

FOREST = colors.HexColor("#285447")
SLATE = colors.HexColor("#1D2935")
MUTED = colors.HexColor("#526170")
BORDER = colors.HexColor("#DEE4E9")
TINT = colors.HexColor("#EDF4F1")
CANVAS = colors.HexColor("#F7F8FA")


def render_rfq_pdf(
    *,
    tenant_name: str,
    rfq_code: str,
    request_ref: str,
    request_version: int,
    request_payload: dict[str, Any],
    supplier_names: list[str],
    response_deadline_days: int,
    lang: str = "en",
) -> bytes:
    is_fr = (lang or "en").lower().startswith("fr")
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("RfqTitle", parent=styles["Heading1"], fontSize=18, textColor=SLATE, spaceAfter=4)
    sub_style = ParagraphStyle("RfqSub", parent=styles["Normal"], fontSize=10, textColor=MUTED, spaceAfter=14)
    h2_style = ParagraphStyle("RfqH2", parent=styles["Heading2"], fontSize=12, textColor=FOREST, spaceBefore=12, spaceAfter=6)
    body_style = ParagraphStyle("RfqBody", parent=styles["Normal"], fontSize=9.5, textColor=SLATE, leading=14)

    now_str = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    currency = str(request_payload.get("currency_code") or "USD")
    loc = str(request_payload.get("location") or ("À confirmer" if is_fr else "To confirm"))
    specs = ", ".join(request_payload.get("mandatory_specs") or []) or (
        "Spécifications commerciales standard" if is_fr else "Standard commercial specification"
    )

    if is_fr:
        story = [
            Paragraph(f"Demande de Prix (RFQ) — {rfq_code}", title_style),
            Paragraph(
                f"Émise par {tenant_name} · Demande source {request_ref} (Version figée v{request_version}) · Exportée le {now_str}",
                sub_style,
            ),
            Paragraph("1. Besoin Confirmé", h2_style),
        ]
        rows = [
            ["Champ", "Exigence confirmée"],
            ["Objet", str(request_payload.get("title") or "")],
            ["Article / Désignation", str(request_payload.get("item_summary") or "")],
            ["Quantité & Unité", f"{request_payload.get('quantity', 1)} {request_payload.get('unit', 'unités')}"],
            ["Spécifications obligatoires", specs],
            ["Lieu de livraison", loc],
            ["Devise requise", currency],
            [
                "Délai de livraison cible",
                f"Sous {request_payload['delivery_window_days']} jours"
                if request_payload.get("delivery_window_days")
                else "Veuillez préciser votre meilleur délai garanti",
            ],
            ["Délai de remise des offres", f"Sous {response_deadline_days} jours calendaires"],
        ]
    else:
        story = [
            Paragraph(f"Request for Quotation — {rfq_code}", title_style),
            Paragraph(
                f"Prepared by {tenant_name} · Source Request {request_ref} (Locked Version v{request_version}) · Exported {now_str}",
                sub_style,
            ),
            Paragraph("1. Confirmed Requirements", h2_style),
        ]
        rows = [
            ["Field", "Confirmed Requirement"],
            ["Title", str(request_payload.get("title") or "")],
            ["Item Description", str(request_payload.get("item_summary") or "")],
            ["Quantity & Unit", f"{request_payload.get('quantity', 1)} {request_payload.get('unit', 'units')}"],
            ["Mandatory Specs", specs],
            ["Delivery Location", loc],
            ["Required Currency", currency],
            [
                "Target Delivery",
                f"Within {request_payload['delivery_window_days']} days"
                if request_payload.get("delivery_window_days")
                else "Please specify earliest guaranteed delivery",
            ],
            ["Quotation Response Window", f"Within {response_deadline_days} calendar days"],
        ]

    req_table = Table(rows, colWidths=[2.1 * inch, 4.9 * inch])
    req_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), TINT),
                ("TEXTCOLOR", (0, 0), (-1, 0), FOREST),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(req_table)
    story.append(Spacer(1, 10))
    if is_fr:
        story.append(Paragraph("2. Décomposition Commerciale Demandée", h2_style))
        story.append(
            Paragraph(
                "Merci de transmettre un devis détaillé précisant : prix unitaire HT, remises éventuelles, frais de transport/livraison, "
                "montant de la TVA (et taux applicable, ex. 19%), timbre fiscal le cas échéant (ex. 1.000 TND), devise, délai de livraison "
                "garanti en jours, durée de garantie, conditions de règlement et durée de validité de l'offre.",
                body_style,
            )
        )
        story.append(Paragraph("3. Fournisseurs Consultés", h2_style))
        story.append(Paragraph(", ".join(supplier_names) or "Aucun", body_style))
        story.append(Spacer(1, 16))
        story.append(
            Paragraph(
                "Note : Cette demande de prix constitue une consultation sans engagement d'achat ni bon de commande.",
                sub_style,
            )
        )
    else:
        story.append(Paragraph("2. Requested Commercial Breakdown", h2_style))
        story.append(
            Paragraph(
                "Please submit an itemized quotation specifying: unit price, explicit discounts, freight/shipping cost, "
                "quoted tax/TVA, applicable fiscal stamp (if any), currency, guaranteed delivery lead time in days, "
                "warranty period, payment terms, and quotation validity date.",
                body_style,
            )
        )
        story.append(Paragraph("3. Selected Recipient Suppliers", h2_style))
        story.append(Paragraph(", ".join(supplier_names) or "None selected", body_style))
        story.append(Spacer(1, 16))
        story.append(
            Paragraph(
                "Notice: This RFQ is an invitation to quote only and does not constitute a purchase order or commercial commitment.",
                sub_style,
            )
        )
    doc.build(story)
    return buf.getvalue()


def render_approved_po_pdf(
    *,
    tenant_name: str,
    po_number: str,
    request_ref: str,
    supplier_name: str,
    supplier_email: str | None,
    commercial_payload: dict[str, Any],
    payload_hash: str,
    award_decision_id: str,
    release_decision_id: str,
    approver_name: str,
    authority_basis: str,
    lang: str = "en",
) -> bytes:
    is_fr = (lang or "en").lower().startswith("fr")
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("PoTitle", parent=styles["Heading1"], fontSize=20, textColor=SLATE, spaceAfter=4)
    badge_style = ParagraphStyle("PoBadge", parent=styles["Normal"], fontSize=9.5, textColor=FOREST, fontName="Helvetica-Bold", spaceAfter=12)
    h2_style = ParagraphStyle("PoH2", parent=styles["Heading2"], fontSize=11.5, textColor=FOREST, spaceBefore=12, spaceAfter=6)
    body_style = ParagraphStyle("PoBody", parent=styles["Normal"], fontSize=9.5, textColor=SLATE, leading=14)
    mono_style = ParagraphStyle("PoMono", parent=styles["Normal"], fontSize=8, textColor=MUTED, fontName="Courier", leading=12)

    now_str = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    currency = str(commercial_payload.get("currency_code") or "USD")
    stamp_str = str(commercial_payload.get("fiscal_stamp_amount") or "0")
    has_stamp = False
    try:
        has_stamp = Decimal(stamp_str) > Decimal("0")
    except Exception:
        has_stamp = False

    if is_fr:
        story = [
            Paragraph(f"Bon de Commande {po_number}", title_style),
            Paragraph("STATUT : BON DE COMMANDE APPROUVÉ PRÊT POUR ÉMISSION AUTORISÉE", badge_style),
            Paragraph(f"Acheteur : {tenant_name} · Demande source : {request_ref} · Validé le : {now_str}", body_style),
            Paragraph(f"Fournisseur : {supplier_name} ({supplier_email or 'Email au dossier'})", body_style),
            Spacer(1, 10),
            Paragraph("1. Conditions Commerciales Approuvées (Version Immuable)", h2_style),
        ]
        line_headers = ["Désignation / Spécifications", "Qté", "Prix Unitaire HT", "Sous-total HT"]
    else:
        story = [
            Paragraph(f"Purchase Order {po_number}", title_style),
            Paragraph("STATUS: APPROVED PO READY FOR AUTHORIZED ISSUE", badge_style),
            Paragraph(f"Buyer: {tenant_name} · Source Request: {request_ref} · Finalized: {now_str}", body_style),
            Paragraph(f"Supplier: {supplier_name} ({supplier_email or 'Email on file'})", body_style),
            Spacer(1, 10),
            Paragraph("1. Approved Commercial Terms (Immutable Snapshot)", h2_style),
        ]
        line_headers = ["Item / Specification", "Qty", "Unit Price", "Subtotal"]

    line_table = Table(
        [
            line_headers,
            [
                f"{commercial_payload.get('item_summary', '')}\nSpecs: {', '.join(commercial_payload.get('mandatory_specs') or ['Standard'])}",
                f"{commercial_payload.get('quantity', 1)} {commercial_payload.get('unit', 'units')}",
                f"{currency} {commercial_payload.get('unit_price', '0.00')}",
                f"{currency} {commercial_payload.get('item_subtotal', '0.00')}",
            ],
        ],
        colWidths=[3.4 * inch, 1.0 * inch, 1.3 * inch, 1.3 * inch],
    )
    line_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), TINT),
                ("TEXTCOLOR", (0, 0), (-1, 0), FOREST),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(line_table)
    story.append(Spacer(1, 8))

    totals_rows = [
        ["Sous-total HT" if is_fr else "Item Subtotal", f"{currency} {commercial_payload.get('item_subtotal', '0.00')}"],
        ["Remise" if is_fr else "Discount", f"- {currency} {commercial_payload.get('discount_amount', '0.00')}"],
        ["Frais de transport / livraison" if is_fr else "Freight / Shipping", f"{currency} {commercial_payload.get('freight_amount', '0.00')}"],
        ["TVA / Taxe" if is_fr else "Quoted Tax / TVA", f"{currency} {commercial_payload.get('quoted_tax_amount', '0.00')}"],
    ]
    if has_stamp:
        totals_rows.append(
            ["Timbre Fiscal" if is_fr else "Fiscal Stamp (Timbre Fiscal)", f"{currency} {stamp_str}"]
        )
    totals_rows.append(
        ["Montant Total TTC Approuvé" if is_fr else "Total Approved Amount", f"{currency} {commercial_payload.get('total_quoted_cost', '0.00')}"]
    )

    totals_table = Table(totals_rows, colWidths=[4.8 * inch, 2.2 * inch])
    totals_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, -1), (-1, -1), TINT),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (0, -1), (-1, -1), SLATE),
                ("FONTSIZE", (0, 0), (-1, -1), 9.5),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("LINEABOVE", (0, -1), (-1, -1), 1, FOREST),
                ("LINEBELOW", (0, 0), (-1, -2), 0.4, BORDER),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(totals_table)
    story.append(Spacer(1, 10))
    story.append(Paragraph("2. Livraison, Garantie & Conditions de Règlement" if is_fr else "2. Delivery, Warranty & Payment Terms", h2_style))
    story.append(
        Paragraph(
            (
                f"Délai de livraison : {commercial_payload.get('delivery_days', 'N/A')} jours · "
                f"Garantie : {commercial_payload.get('warranty_months', 'N/A')} mois · "
                f"Règlement : {commercial_payload.get('payment_terms', 'Net 30')} · "
                f"Devis source : {commercial_payload.get('quote_code', '')} (Rév. {commercial_payload.get('quote_revision', 1)})"
            )
            if is_fr
            else (
                f"Delivery Commitment: {commercial_payload.get('delivery_days', 'N/A')} days · "
                f"Warranty: {commercial_payload.get('warranty_months', 'N/A')} months · "
                f"Payment Terms: {commercial_payload.get('payment_terms', 'Net 30')} · "
                f"Source Quote: {commercial_payload.get('quote_code', '')} (Rev {commercial_payload.get('quote_revision', 1)})"
            ),
            body_style,
        )
    )
    story.append(Spacer(1, 12))
    story.append(Paragraph("3. Passeport de Preuve & Audit" if is_fr else "3. PO Evidence Passport (Audit Trail)", h2_style))
    story.append(
        Paragraph(
            f"Award Decision: {award_decision_id}<br/>"
            f"Final PO Release Decision: {release_decision_id}<br/>"
            f"Approved By: {approver_name} ({authority_basis})<br/>"
            f"Canonical Commercial Payload Hash: {payload_hash}",
            mono_style,
        )
    )
    story.append(Spacer(1, 12))
    story.append(
        Paragraph(
            (
                "Note de gouvernance : L'export de ce Bon de Commande approuvé ne vaut pas preuve d'envoi externe, "
                "d'acceptation fournisseur, de réception ni de paiement. L'émission externe est enregistrée séparément."
            )
            if is_fr
            else (
                "Governance Note: Exporting this approved PO PDF does not establish external dispatch, supplier acceptance, "
                "goods delivery, invoicing, or payment. External issue is recorded separately."
            ),
            ParagraphStyle("FooterNote", parent=styles["Normal"], fontSize=8, textColor=MUTED),
        )
    )
    doc.build(story)
    return buf.getvalue()


def render_example_quotation_pdf(
    *,
    quote_code: str,
    supplier_name: str,
    supplier_email: str | None,
    supplier_location: str | None,
    buyer_tenant_name: str,
    request_ref: str,
    item_summary: str,
    mandatory_specs: list[str],
    currency_code: str,
    quantity: int,
    unit: str,
    unit_price_str: str,
    subtotal_str: str,
    freight_str: str | None,
    tax_str: str | None,
    total_str: str | None,
    delivery_days: int,
    warranty_months: int,
    payment_terms: str,
    offered_specs_text: str | None = None,
    fiscal_stamp_str: str | None = None,
    lang: str = "en",
) -> bytes:
    """Renders a clearly watermarked EN/FR example supplier quotation PDF for end-to-end workflow demonstration."""
    is_fr = (lang or "en").lower().startswith("fr")
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.7 * inch,
        bottomMargin=0.7 * inch,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("QtTitle", parent=styles["Heading1"], fontSize=17, textColor=SLATE, spaceAfter=4)
    warn_style = ParagraphStyle(
        "QtWarn",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#9A5B13"),
        fontName="Helvetica-Bold",
        spaceAfter=10,
    )
    h2_style = ParagraphStyle("QtH2", parent=styles["Heading2"], fontSize=11.5, textColor=FOREST, spaceBefore=10, spaceAfter=6)
    body_style = ParagraphStyle("QtBody", parent=styles["Normal"], fontSize=9.5, textColor=SLATE, leading=14)

    now_str = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")
    specs = offered_specs_text or (", ".join(mandatory_specs) if mandatory_specs else "Standard commercial specification")

    story = [
        Paragraph(f"{'Devis Fournisseur' if is_fr else 'Supplier Quotation'} — {quote_code}", title_style),
        Paragraph(
            (
                "DEVIS DE SIMULATION DÉMO — GÉNÉRÉ POUR DÉMONTRER LE FLUX (NON CONTRACTUEL)"
                if is_fr
                else "DEMO SIMULATION QUOTATION — GENERATED TO DEMONSTRATE WORKFLOW CONTINUATION (NOT AN OFFICIAL VENDOR BINDING OFFER)"
            ),
            warn_style,
        ),
        Paragraph(
            f"{'Fournisseur' if is_fr else 'From Supplier'}: {supplier_name} ({supplier_location or 'Directory'}) · Contact: {supplier_email or 'N/A'}",
            body_style,
        ),
        Paragraph(f"{'Client' if is_fr else 'Prepared For'}: {buyer_tenant_name} · Ref: {request_ref} · Date: {now_str}", body_style),
        Spacer(1, 10),
        Paragraph("1. Détail Technique & Financier" if is_fr else "1. Quoted Line Item & Commercial Breakdown", h2_style),
    ]

    rows = [
        ["Champ" if is_fr else "Field", "Valeur proposée" if is_fr else "Quoted Value"],
        ["Article & Spécifications" if is_fr else "Item Offered", f"{item_summary} — {specs}"],
        ["Quantité" if is_fr else "Quantity", f"{quantity} {unit}"],
        ["Devise" if is_fr else "Currency", currency_code],
        ["Prix Unitaire HT" if is_fr else "Unit Price", f"{currency_code} {unit_price_str}"],
        ["Sous-total HT" if is_fr else "Item Subtotal", f"{currency_code} {subtotal_str}"],
        [
            "Frais de livraison" if is_fr else "Freight / Delivery Charge",
            f"{currency_code} {freight_str}" if freight_str is not None else ("Non précisé (Inconnu)" if is_fr else "Not specified (Unknown)"),
        ],
        [
            "TVA" if is_fr else "Quoted Tax / TVA",
            f"{currency_code} {tax_str}" if tax_str is not None else ("Non précisée (Inconnue)" if is_fr else "Not specified (Unknown)"),
        ],
    ]
    if fiscal_stamp_str and Decimal(fiscal_stamp_str) > Decimal("0"):
        rows.append(["Timbre Fiscal" if is_fr else "Fiscal Stamp (Timbre Fiscal)", f"{currency_code} {fiscal_stamp_str}"])
    rows.extend(
        [
            [
                "Montant Total TTC" if is_fr else "Total Quoted Cost",
                f"{currency_code} {total_str}" if total_str is not None else ("Incomplet (Clarification requise)" if is_fr else "Incomplete (Pending Clarification)"),
            ],
            ["Délai de livraison" if is_fr else "Delivery Lead Time", f"{delivery_days} {'jours calendaires' if is_fr else 'calendar days'}"],
            ["Garantie" if is_fr else "Warranty Period", f"{warranty_months} {'mois' if is_fr else 'months'}"],
            ["Conditions de paiement" if is_fr else "Payment Terms", payment_terms],
            ["Validité de l'offre" if is_fr else "Quotation Validity", "30 jours" if is_fr else "30 calendar days"],
        ]
    )

    tbl = Table(rows, colWidths=[2.3 * inch, 4.7 * inch])
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), TINT),
                ("TEXTCOLOR", (0, 0), (-1, 0), FOREST),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.append(tbl)
    doc.build(story)
    return buf.getvalue()
