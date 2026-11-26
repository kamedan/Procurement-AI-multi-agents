"use client";

import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  FileCheck2,
  Globe,
  Lock,
  Mail,
  MapPin,
  Phone,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
  UserCheck,
  XCircle,
} from "lucide-react";
import type {
  Actor,
  ExtractedSupplierCandidate,
  Persona,
  RfqEmailDraft,
  SupplierItem,
  WorkspaceData,
} from "./types";

interface Props {
  workspace: WorkspaceData;
  actor: Actor | null;
  personas: Persona[];
  devAuthEnabled: boolean;
  suppliers: SupplierItem[];
  onRefresh: () => Promise<void>;
  onSwitchPersona: (personaId: string) => Promise<void>;
  onFeedback: (kind: "ok" | "error", text: string) => void;
}

const CURRENCIES = ["TND", "EUR", "USD", "MAD", "DZD", "GBP", "SAR", "AED", "CAD", "CHF", "JPY"];

const STAGES = [
  { id: 1, label: "1. Request Draft" },
  { id: 2, label: "2. Search Suppliers & RFQ" },
  { id: 3, label: "3. Quotations (PDF/Entry)" },
  { id: 4, label: "4. Comparison" },
  { id: 5, label: "5. Approvals" },
  { id: 6, label: "6. Approved PO" },
];

function inferStage(ws: WorkspaceData): number {
  if (ws.purchase_order && ws.purchase_order.po_number) return 6;
  if (ws.pending_approval) return 5;
  if (ws.request.status === "award_approved") return 6;
  if (ws.latest_comparison) return 4;
  if (ws.quotations.length > 0) return 3;
  if (ws.rfqs.length > 0 || ws.request.status === "confirmed") return 2;
  return 1;
}

export default function CaseFlowView({
  workspace,
  actor,
  personas,
  devAuthEnabled,
  suppliers,
  onRefresh,
  onSwitchPersona,
  onFeedback,
}: Props) {
  const [stage, setStage] = useState<number>(() => inferStage(workspace));
  const [busy, setBusy] = useState(false);

  // Stage 1 editable draft state
  const verPayload = workspace.latest_version?.payload;
  const [title, setTitle] = useState(verPayload?.title || workspace.request.title);
  const [itemSummary, setItemSummary] = useState(verPayload?.item_summary || workspace.request.title);
  const [location, setLocation] = useState(verPayload?.location || workspace.request.location || "Sousse, Tunisia");
  const [quantity, setQuantity] = useState(String(verPayload?.quantity ?? 1));
  const [unit, setUnit] = useState(verPayload?.unit || "units");
  const [budgetCap, setBudgetCap] = useState(verPayload?.budget_cap || workspace.request.budget_cap || "");
  const [currency, setCurrency] = useState(verPayload?.currency_code || workspace.request.currency_code || "TND");
  const [deliveryDays, setDeliveryDays] = useState(
    verPayload?.delivery_window_days != null ? String(verPayload.delivery_window_days) : ""
  );
  const [specsText, setSpecsText] = useState((verPayload?.mandatory_specs || []).join(", "));

  // Stage 2 Real Supplier Search & Extraction + RFQ Emails
  const [liveQuery, setLiveQuery] = useState(verPayload?.item_summary || workspace.request.title);
  const [liveLocation, setLiveLocation] = useState(verPayload?.location || workspace.request.location || "Sousse, Tunisia");
  const [extractedSuppliers, setExtractedSuppliers] = useState<ExtractedSupplierCandidate[]>([]);
  const [manualEmailOverrides, setManualEmailOverrides] = useState<Record<string, string>>({});
  const [searchingReal, setSearchingReal] = useState(false);
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [rfqDeadlineDays, setRfqDeadlineDays] = useState("5");
  const [emailDrafts, setEmailDrafts] = useState<RfqEmailDraft[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [activeRfqIdForEmails, setActiveRfqIdForEmails] = useState<string | null>(null);

  // Stage 3 Real PDF/CSV Quote Upload + Manual Entry + Corrections
  const [qSupplierId, setQSupplierId] = useState("");
  const [qCurrency, setQCurrency] = useState(currency);
  const [qUnitPrice, setQUnitPrice] = useState("");
  const [qFreight, setQFreight] = useState("");
  const [qTax, setQTax] = useState("");
  const [qDelivery, setQDelivery] = useState("");
  const [qWarranty, setQWarranty] = useState("12");
  const [qTerms, setQTerms] = useState("Net 30");
  const [qMeetsSpecs, setQMeetsSpecs] = useState(true);
  const [qSourceFilename, setQSourceFilename] = useState("");
  const [qExcerpt, setQExcerpt] = useState("");
  const [extractingFile, setExtractingFile] = useState(false);

  const [editingQuoteId, setEditingQuoteId] = useState<string | null>(null);
  const [corrUnitPrice, setCorrUnitPrice] = useState("");
  const [corrFreight, setCorrFreight] = useState("");
  const [corrDelivery, setCorrDelivery] = useState("");
  const [corrSpecOverride, setCorrSpecOverride] = useState<"" | "pass" | "needs_clarification" | "fail">("");
  const [corrReason, setCorrReason] = useState("");

  // Stage 5 Decision state
  const [reviewChecked, setReviewChecked] = useState(false);
  const [decisionNote, setDecisionNote] = useState("");

  // Stage 6 External Issue state
  const [issueNote, setIssueNote] = useState("Sent approved PO PDF to supplier contact via email.");

  useEffect(() => {
    const p = workspace.latest_version?.payload;
    setTitle(p?.title || workspace.request.title);
    setItemSummary(p?.item_summary || workspace.request.title);
    setLiveQuery(p?.item_summary || workspace.request.title);
    const loc = p?.location || workspace.request.location || "";
    setLocation(loc);
    setLiveLocation(loc || "Sousse, Tunisia");
    setQuantity(String(p?.quantity ?? 1));
    setUnit(p?.unit || "units");
    setBudgetCap(p?.budget_cap || workspace.request.budget_cap || "");
    const curr = p?.currency_code || workspace.request.currency_code || "TND";
    setCurrency(curr);
    setQCurrency(curr);
    setDeliveryDays(p?.delivery_window_days != null ? String(p.delivery_window_days) : "");
    setSpecsText((p?.mandatory_specs || []).join(", "));

    // P0 Reuse intake leads in Stage 2 without spending an extra Tavily credit
    const intakeLeads = workspace.run?.projection?.external_leads || [];
    if (intakeLeads.length > 0) {
      setExtractedSuppliers((prev) =>
        prev.length > 0
          ? prev
          : intakeLeads.map((ld) => ({
              supplier_name: ld.title || ld.domain || "Discovered Supplier",
              website_url: ld.url,
              source_url: ld.url,
              contact_email: ld.found_emails?.[0] || null,
              phone: ld.found_phones?.[0] || null,
              location: loc || null,
              matched_products: [],
              notes: ld.snippet,
              retrieved_at: ld.retrieved_at,
              verification_status: ld.verification_status,
            }))
      );
    }
  }, [workspace.request.id, workspace.request.current_version, workspace.latest_version?.payload_hash]);

  useEffect(() => {
    setStage(inferStage(workspace));
  }, [
    workspace.request.id,
    workspace.request.status,
    workspace.pending_approval?.id,
    workspace.purchase_order?.po_number,
  ]);

  useEffect(() => {
    if (suppliers.length > 0 && !qSupplierId) {
      setQSupplierId(suppliers[0].id);
    }
  }, [suppliers, qSupplierId]);

  const handleSaveRequest = async (confirm: boolean) => {
    setBusy(true);
    try {
      const specs = specsText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch(`/api/v1/requests/${workspace.request.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          item_summary: itemSummary.trim(),
          quantity: Math.max(1, parseInt(quantity, 10) || 1),
          unit: unit.trim() || "units",
          budget_cap: budgetCap.trim() ? budgetCap.trim() : null,
          currency_code: currency.trim().toUpperCase() || "TND",
          location: location.trim() || null,
          delivery_window_days: deliveryDays.trim() ? parseInt(deliveryDays, 10) : null,
          mandatory_specs: specs,
          confirm,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || data?.detail || "Failed to save modifications");
        return;
      }
      onFeedback(
        "ok",
        `Saved RequestVersion v${data.version_number} (${currency}, ${location || "no location"}) — ${confirm ? "confirmed for supplier search" : "draft updated"}.`
      );
      await onRefresh();
      if (confirm) setStage(2);
    } finally {
      setBusy(false);
    }
  };

  const handleRealSupplierSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!liveQuery.trim()) return;
    setSearchingReal(true);
    try {
      const res = await fetch("/api/v1/suppliers/search-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_query: liveQuery.trim(),
          location: liveLocation.trim() || null,
          currency,
          max_results: 5,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", `${data?.detail?.code || res.status}: ${data?.detail?.message || "Real supplier search failed"}`);
        return;
      }
      setExtractedSuppliers(data.suppliers || []);
      onFeedback(
        "ok",
        `Live search found ${(data.suppliers || []).length} real web supplier(s) for "${liveQuery.trim()}" in ${liveLocation || "global"} (${currency}). Tavily: $${data.tavily_estimated_cost_usd}${data.tavily_cache_hit ? " (cache hit)" : ""} · LLM: $${data.llm_cost_usd}${data.llm_cache_hit ? " (cache hit)" : ""}.`
      );
      await onRefresh();
    } finally {
      setSearchingReal(false);
    }
  };

  const handleSaveExtractedSupplier = async (cand: ExtractedSupplierCandidate) => {
    setBusy(true);
    try {
      const emailToSave = (manualEmailOverrides[cand.website_url] ?? cand.contact_email ?? "").trim() || null;
      const productsSummary = cand.matched_products.length > 0 ? `Products: ${cand.matched_products.join(" | ")}. ` : "";
      const res = await fetch("/api/v1/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cand.supplier_name,
          category: itemSummary.slice(0, 80) || "Sourcing Lead",
          contact_email: emailToSave,
          phone: cand.phone,
          location: cand.location || liveLocation || null,
          website_url: cand.website_url,
          source_url: cand.source_url,
          notes: `${productsSummary}${cand.notes}`.slice(0, 950),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || "Could not save supplier");
        return;
      }
      setSelectedSuppliers((prev) => (prev.includes(data.id) ? prev : [...prev, data.id]));
      onFeedback("ok", `Saved real supplier "${data.name}" to your tenant directory and selected it for RFQ.`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAllExtractedSuppliers = async () => {
    if (extractedSuppliers.length === 0) return;
    setBusy(true);
    try {
      const existingByUrl = new Map(
        suppliers.filter((s) => s.website_url).map((s) => [s.website_url!.toLowerCase(), s.id])
      );
      const newlySelected: string[] = [...selectedSuppliers];
      let savedCount = 0;

      for (const cand of extractedSuppliers) {
        const alreadyId = existingByUrl.get(cand.website_url.toLowerCase());
        if (alreadyId) {
          if (!newlySelected.includes(alreadyId)) newlySelected.push(alreadyId);
          continue;
        }
        const emailToSave = (manualEmailOverrides[cand.website_url] ?? cand.contact_email ?? "").trim() || null;
        const productsSummary = cand.matched_products.length > 0 ? `Products: ${cand.matched_products.join(" | ")}. ` : "";
        const res = await fetch("/api/v1/suppliers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cand.supplier_name,
            category: itemSummary.slice(0, 80) || "Sourcing Lead",
            contact_email: emailToSave,
            phone: cand.phone,
            location: cand.location || liveLocation || null,
            website_url: cand.website_url,
            source_url: cand.source_url,
            notes: `${productsSummary}${cand.notes}`.slice(0, 950),
          }),
        });
        if (res.ok) {
          const data = await res.json();
          newlySelected.push(data.id);
          savedCount += 1;
        }
      }
      setSelectedSuppliers(newlySelected);
      onFeedback("ok", `Saved ${savedCount} new supplier(s) and selected ${newlySelected.length} supplier(s) for RFQ & demo quotes.`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateExampleQuotes = async () => {
    setBusy(true);
    try {
      const targetIds = selectedSuppliers.length > 0 ? selectedSuppliers : undefined;
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/quotations/seed-sample`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_ids: targetIds, replace_existing_demo_quotes: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || data?.detail || "Could not generate example quotations");
        return;
      }
      onFeedback(
        "ok",
        `Generated ${data.count} [DEMO SIMULATION] quotation(s) (${data.currency_code}) with downloadable PDFs from your selected suppliers. Click "Run Deterministic Comparison" to continue!`
      );
      await onRefresh();
      setStage(3);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRfq = async () => {
    if (selectedSuppliers.length === 0) {
      onFeedback("error", "Select at least one real supplier from your directory below before generating an RFQ.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/rfqs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier_ids: selectedSuppliers,
          response_deadline_days: parseInt(rfqDeadlineDays, 10) || 5,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || data?.detail || "Failed to export RFQ");
        return;
      }
      onFeedback("ok", `Created ${data.rfq_code} (locked to Request v${data.request_version}). You can now download the RFQ PDF and prepare supplier emails.`);
      await onRefresh();
      await handleLoadRfqEmails(data.id);
    } finally {
      setBusy(false);
    }
  };

  const handleLoadRfqEmails = async (rfqId: string) => {
    const res = await fetch(`/api/v1/rfqs/${rfqId}/emails`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      setEmailDrafts(data.drafts || []);
      setSmtpConfigured(Boolean(data.smtp_configured));
      setActiveRfqIdForEmails(rfqId);
    }
  };

  const handleSendRfqEmailsSmtp = async (rfqId: string, supplierIds: string[]) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/rfqs/${rfqId}/send-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_ids: supplierIds, confirm_human_review: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || "SMTP send failed");
        return;
      }
      const firstMsg = data.results?.[0]?.message || `Sent ${data.sent_count} email(s).`;
      onFeedback(data.sent_count > 0 ? "ok" : "error", firstMsg);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRecordDistribution = async (rfqId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/rfqs/${rfqId}/distribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Sent RFQ emails & PDF to selected real suppliers." }),
      });
      if (!res.ok) {
        onFeedback("error", "Failed to record distribution");
        return;
      }
      onFeedback("ok", "Distribution recorded. Upload or enter supplier quotations when they reply.");
      await onRefresh();
      setStage(3);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadQuoteFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setExtractingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/quotations/extract-upload`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail || "Document upload failed");
        return;
      }
      setQSourceFilename(data.filename || file.name);
      if (data.status === "extracted" && data.fields) {
        const f = data.fields;
        if (f.currency_code) setQCurrency(f.currency_code);
        if (f.unit_price) setQUnitPrice(String(f.unit_price));
        if (f.freight_amount != null) setQFreight(String(f.freight_amount));
        else setQFreight("");
        if (f.quoted_tax_amount != null) setQTax(String(f.quoted_tax_amount));
        else setQTax("");
        if (f.delivery_days != null) setQDelivery(String(f.delivery_days));
        if (f.warranty_months != null) setQWarranty(String(f.warranty_months));
        if (f.payment_terms) setQTerms(f.payment_terms);
        setQExcerpt(f.source_excerpt || "");
        onFeedback(
          "ok",
          `Stored "${data.filename}" privately in RustFS (${data.sha256.slice(0, 18)}...) and extracted fields via DeepSeek V4.1 Flash ($${data.llm_cost_usd}). Review and confirm below.`
        );
      } else {
        setQExcerpt("");
        onFeedback("error", `${data.status}: ${data.message}`);
      }
      await onRefresh();
    } finally {
      setExtractingFile(false);
    }
  };

  const handleAddManualQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qSupplierId || !qUnitPrice.trim()) {
      onFeedback("error", "Select a supplier and enter the quoted unit price.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/quotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier_id: qSupplierId,
          currency_code: qCurrency,
          quantity: parseInt(quantity, 10) || 1,
          unit_price: qUnitPrice.trim(),
          freight_amount: qFreight.trim() ? qFreight.trim() : null,
          quoted_tax_amount: qTax.trim() ? qTax.trim() : null,
          delivery_days: qDelivery.trim() ? parseInt(qDelivery, 10) : null,
          warranty_months: qWarranty.trim() ? parseInt(qWarranty, 10) : null,
          payment_terms: qTerms.trim() || "Net 30",
          meets_mandatory_specs: qMeetsSpecs,
          source_filename: qSourceFilename || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail || "Failed to save quotation");
        return;
      }
      setQUnitPrice("");
      setQFreight("");
      setQTax("");
      setQDelivery("");
      setQSourceFilename("");
      setQExcerpt("");
      onFeedback("ok", `Saved confirmed quotation ${data.quote_code} (Rev 1).`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCorrection = async (quoteId: string) => {
    if (!corrReason.trim()) {
      onFeedback("error", "A reason is required for attributable human field corrections.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/quotations/${quoteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unit_price: corrUnitPrice.trim() ? corrUnitPrice.trim() : null,
          freight_amount: corrFreight !== "" ? corrFreight.trim() : null,
          delivery_days: corrDelivery.trim() ? parseInt(corrDelivery, 10) : null,
          spec_status_override: corrSpecOverride || null,
          reason: corrReason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail || "Failed to save correction");
        return;
      }
      setEditingQuoteId(null);
      setCorrSpecOverride("");
      setCorrReason("");
      onFeedback("ok", `Saved attributable correction -> Quotation Revision ${data.revision_number}.`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRunComparison = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/compare`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail || "Comparison failed");
        return;
      }
      onFeedback("ok", `Computed deterministic Decimal comparison v${data.version_number} (${currency}).`);
      await onRefresh();
      setStage(4);
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitAward = async (quotationId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/award-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotation_id: quotationId }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || data?.detail || "Could not submit award review");
        return;
      }
      onFeedback("ok", "Submitted Supplier Award packet for authorized human approval (Checkpoint 1 of 2).");
      setReviewChecked(false);
      await onRefresh();
      setStage(5);
    } finally {
      setBusy(false);
    }
  };

  const handleDecision = async (action: "approve" | "reject" | "request-changes") => {
    if (!workspace.pending_approval) return;
    setBusy(true);
    try {
      const pa = workspace.pending_approval;
      const res = await fetch(`/api/v1/decisions/${pa.id}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `flow-${pa.id}-${action}-v${pa.entity_version}-${Date.now()}`,
        },
        body: JSON.stringify({
          expected_version: pa.entity_version,
          expected_payload_hash: pa.payload_hash,
          note: decisionNote.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", `${data?.detail?.code || res.status}: ${data?.detail?.message || "Decision blocked"}`);
        return;
      }
      setReviewChecked(false);
      setDecisionNote("");
      if (data.po_number) {
        onFeedback("ok", `Final PO Release approved! Assigned ${data.po_number} and generated Approved PO PDF.`);
      } else if (action === "approve") {
        onFeedback("ok", "Supplier Award approved! Proceed to Stage 6 to draft and release the Purchase Order.");
      } else {
        onFeedback("ok", `Decision recorded: ${data.outcome}.`);
      }
      await onRefresh();
      if (action === "request-changes") setStage(1);
    } finally {
      setBusy(false);
    }
  };

  const handlePreparePoDraft = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/po-draft`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail?.message || data?.detail || "Failed to prepare PO draft");
        return;
      }
      onFeedback("ok", "Created immutable PO draft and submitted for Final PO Release approval (Checkpoint 2 of 2).");
      setReviewChecked(false);
      await onRefresh();
      setStage(5);
    } finally {
      setBusy(false);
    }
  };

  const handleRecordExternalIssue = async (poId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/purchase-orders/${poId}/record-issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: issueNote.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        onFeedback("error", data?.detail || "Failed to record external issue");
        return;
      }
      onFeedback("ok", `Recorded external issue for ${data.po_number}.`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const sameTenantApproverPersona = personas.find(
    (p) =>
      p.tenant_id === actor?.tenant_id &&
      p.user_id !== workspace.request.requester_user_id &&
      p.roles_label.toLowerCase().includes("approver")
  );
  const canCurrentActorApprove =
    workspace.pending_approval?.can_current_actor_approve !== undefined
      ? workspace.pending_approval.can_current_actor_approve
      : Boolean(actor?.roles.includes("approver")) &&
        Boolean(workspace.pending_approval) &&
        actor?.user_id !== workspace.pending_approval?.requester_user_id &&
        actor?.approval_limit_usd != null &&
        Number(actor.approval_limit_usd) >= Number(workspace.pending_approval?.amount || 0);

  return (
    <div className="space-y-5">
      {/* Header + 6-Stage Stepper */}
      <div className="rounded-md border border-[#DEE4E9] bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#526170]">
              <span className="font-mono font-semibold text-[#285447]">{workspace.request.reference_code}</span>
              <span>·</span>
              <span>Request v{workspace.request.current_version}</span>
              <span>·</span>
              <span className="font-semibold text-[#1D2935]">{workspace.request.currency_code}</span>
              {workspace.request.location && (
                <>
                  <span>·</span>
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {workspace.request.location}
                  </span>
                </>
              )}
              <span>·</span>
              <span className="rounded bg-[#EDF4F1] px-2 py-0.5 font-medium text-[#285447]">
                {workspace.request.status.replaceAll("_", " ")}
              </span>
            </div>
            <h2 className="mt-1 text-xl font-semibold text-[#1D2935]">{workspace.request.title}</h2>
          </div>
          {workspace.purchase_order?.po_number && (
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-[#EDF4F1] px-3 py-1.5 font-mono text-xs font-semibold text-[#285447]">
                {workspace.purchase_order.po_number}
              </span>
              <a
                href={`/api/v1/purchase-orders/${workspace.purchase_order.id}/pdf`}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237]"
              >
                <Download className="h-3.5 w-3.5" />
                Download Approved PO PDF
              </a>
            </div>
          )}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[#DEE4E9] pt-4 sm:grid-cols-3 lg:grid-cols-6">
          {STAGES.map((st) => (
            <button
              key={st.id}
              type="button"
              onClick={() => setStage(st.id)}
              className={`rounded-md border px-2.5 py-2 text-left text-xs font-medium transition ${
                stage === st.id
                  ? "border-[#285447] bg-[#EDF4F1] text-[#285447]"
                  : "border-[#DEE4E9] bg-[#F7F8FA] text-[#526170] hover:bg-white hover:text-[#1D2935]"
              }`}
            >
              {st.label}
            </button>
          ))}
        </div>
      </div>

      {/* STAGE 1: Editable Purchase Request Draft (Any Currency & Location) */}
      {stage === 1 && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <div className="rounded-md border border-[#DEE4E9] bg-white p-5 lg:col-span-7">
            <div className="flex items-center justify-between border-b border-[#DEE4E9] pb-3">
              <div>
                <h3 className="text-base font-semibold">Edit & Confirm Purchase Request (v{workspace.request.current_version})</h3>
                <p className="text-xs text-[#526170]">
                  Supports TND (3 decimals), EUR, USD, MAD, DZD, and local delivery cities (e.g. Sousse, Tunisia).
                </p>
              </div>
              <Edit3 className="h-4 w-4 text-[#285447]" />
            </div>

            <div className="mt-4 space-y-3 text-sm">
              <div>
                <label className="block text-xs font-medium text-[#526170]">Request Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Product / Item Description</label>
                  <input
                    value={itemSummary}
                    onChange={(e) => setItemSummary(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Sourcing & Delivery Location</label>
                  <input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder="e.g. Sousse, Tunisia"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Quantity</label>
                  <input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Unit</label>
                  <input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Delivery Deadline (days)</label>
                  <input
                    type="number"
                    min={1}
                    value={deliveryDays}
                    onChange={(e) => setDeliveryDays(e.target.value)}
                    placeholder="e.g. 10"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Budget Cap (Decimal, e.g. 25000.000)</label>
                  <input
                    value={budgetCap}
                    onChange={(e) => setBudgetCap(e.target.value)}
                    placeholder="e.g. 25000.000"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">Currency</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-sm"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#526170]">Mandatory Specifications (comma-separated)</label>
                <input
                  value={specsText}
                  onChange={(e) => setSpecsText(e.target.value)}
                  placeholder="Core i7, 16 GB RAM, 512 GB SSD"
                  className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                />
              </div>

              {workspace.latest_version?.missing_fields && workspace.latest_version.missing_fields.length > 0 && (
                <div className="rounded border border-[#F5DFC4] bg-[#FEF6EC] p-3 text-xs text-[#9A5B13]">
                  <strong>Agent flagged missing details:</strong> {workspace.latest_version.missing_fields.join(" · ")}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveRequest(false)}
                  className="rounded-md border border-[#DEE4E9] bg-white px-4 py-2 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
                >
                  Save Draft Only
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleSaveRequest(true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  Save Changes & Find Real Suppliers
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:col-span-5">
            {workspace.run?.projection?.react_trace && (
              <div className="rounded-md border border-[#DEE4E9] bg-white p-5">
                <h3 className="text-sm font-semibold">Bounded ReAct Agent Trace</h3>
                <ol className="mt-3 space-y-2.5 text-xs">
                  {workspace.run.projection.react_trace.map((st) => (
                    <li key={st.step} className="rounded border border-[#DEE4E9] bg-[#F7F8FA] p-2.5">
                      <div className="font-medium text-[#285447]">
                        Step {st.step}/{st.max_steps} · <span className="font-mono">{st.action}</span>
                      </div>
                      <div className="mt-1 text-[#526170]"><strong>Thought:</strong> {st.thought}</div>
                      <div className="mt-0.5 text-[#526170]"><strong>Observation:</strong> {st.observation}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STAGE 2: REAL Web Product & Supplier Search (Tavily + DeepSeek) + RFQ PDF & Outreach Emails */}
      {stage === 2 && (
        <div className="space-y-5">
          {/* LIVE TAVILY + DEEPSEEK REAL SUPPLIER EXTRACTOR */}
          <div className="rounded-md border border-[#285447]/30 bg-white p-5">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-[#285447]" />
              <h3 className="text-base font-semibold">Real Web Search: Find Products & Extract Suppliers</h3>
            </div>
            <p className="mt-1 text-xs text-[#526170]">
              Runs a live Tavily web search + DeepSeek V4.1 Flash structured extraction for your exact product, city/country, and currency. Only verbatim emails, phones, websites, and listed prices from real web pages are shown—never fabricated.
            </p>

            <form onSubmit={handleRealSupplierSearch} className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-12">
              <input
                value={liveQuery}
                onChange={(e) => setLiveQuery(e.target.value)}
                placeholder="Product to search (e.g. pc portable Lenovo ThinkPad i7)"
                className="rounded-md border border-[#DEE4E9] px-3 py-2 text-sm md:col-span-5"
              />
              <input
                value={liveLocation}
                onChange={(e) => setLiveLocation(e.target.value)}
                placeholder="Location (e.g. Sousse, Tunisia)"
                className="rounded-md border border-[#DEE4E9] px-3 py-2 text-sm md:col-span-3"
              />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-sm md:col-span-1"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <button
                type="submit"
                disabled={searchingReal}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50 md:col-span-3"
              >
                <Search className="h-3.5 w-3.5" />
                {searchingReal ? "Searching & Extracting..." : "Search & Extract Suppliers"}
              </button>
            </form>

            {extractedSuppliers.length > 0 && (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#CBE1D8] bg-[#EDF4F1]/60 px-3.5 py-2.5 text-xs">
                  <span className="font-medium text-[#1D2935]">
                    Found <strong>{extractedSuppliers.length}</strong> real supplier lead(s). Save the ones you want, or save all to test the full quote-to-PO flow immediately:
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleSaveAllExtractedSuppliers()}
                    className="inline-flex items-center gap-1.5 rounded bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Save & Select All ({extractedSuppliers.length})
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {extractedSuppliers.map((cand) => (
                  <div key={cand.website_url} className="rounded-md border border-[#DEE4E9] bg-[#F7F8FA] p-4 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <a
                          href={cand.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-sm font-semibold text-[#285447] hover:underline"
                        >
                          {cand.supplier_name}
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <div className="mt-0.5 text-[11px] text-[#526170]">
                          {cand.location || liveLocation} · Retrieved {new Date(cand.retrieved_at).toLocaleTimeString()}
                        </div>
                      </div>
                      <span className="shrink-0 rounded bg-[#FEF6EC] px-2 py-0.5 text-[10px] font-medium text-[#9A5B13]">
                        Unverified Lead
                      </span>
                    </div>

                    {cand.matched_products.length > 0 && (
                      <div className="mt-2 rounded border border-[#DEE4E9] bg-white p-2">
                        <div className="text-[11px] font-semibold text-[#1D2935]">Products / Prices found on page:</div>
                        <ul className="mt-1 list-disc pl-4 text-[11px] text-[#526170]">
                          {cand.matched_products.map((mp, idx) => (
                            <li key={idx}>{mp}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <p className="mt-2 text-[#526170]">{cand.notes}</p>

                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px]">
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3 w-3 text-[#526170]" />
                        {cand.phone || "Phone not listed on page"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Mail className="h-3 w-3 text-[#526170]" />
                        {cand.contact_email || "Email not published on page"}
                      </span>
                    </div>

                    <div className="mt-3 flex gap-2">
                      <input
                        value={manualEmailOverrides[cand.website_url] ?? cand.contact_email ?? ""}
                        onChange={(e) =>
                          setManualEmailOverrides((prev) => ({ ...prev, [cand.website_url]: e.target.value }))
                        }
                        placeholder={cand.contact_email ? cand.contact_email : "Enter supplier email if found on contact page..."}
                        className="flex-1 rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 text-xs"
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSaveExtractedSupplier(cand)}
                        className="inline-flex shrink-0 items-center gap-1 rounded bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237]"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        Save & Select
                      </button>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            )}
          </div>

          {/* SAVED SUPPLIERS SELECTION & RFQ GENERATION */}
          <div className="rounded-md border border-[#DEE4E9] bg-white p-5">
            <div className="border-b border-[#DEE4E9] pb-3">
              <h3 className="text-base font-semibold">Saved Suppliers ({suppliers.length}) → Generate RFQ & Outreach Emails</h3>
              <p className="text-xs text-[#526170]">
                Select the real suppliers you want to invite for Request v{workspace.request.current_version} ({currency}).
              </p>
            </div>

            {suppliers.length === 0 ? (
              <div className="py-6 text-center text-xs text-[#526170]">
                No suppliers saved in your directory yet. Use <strong>Search & Extract Suppliers</strong> above to discover real suppliers in {liveLocation || "your region"} and click <strong>Save & Select</strong>.
              </div>
            ) : (
              <div className="mt-3 divide-y divide-[#DEE4E9] rounded border border-[#DEE4E9]">
                {suppliers.map((s) => {
                  const checked = selectedSuppliers.includes(s.id);
                  return (
                    <label key={s.id} className="flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-xs hover:bg-[#F7F8FA]">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedSuppliers((prev) =>
                              e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)
                            )
                          }
                          className="h-4 w-4 accent-[#285447]"
                        />
                        <div>
                          <div className="text-sm font-medium text-[#1D2935]">{s.name}</div>
                          <div className="text-[#526170]">
                            {s.contact_email || "No email set (edit in Supplier Directory)"} · {s.phone || "No phone"} · {s.location || "—"}
                          </div>
                        </div>
                      </div>
                      <span
                        className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                          s.verification_status === "approved"
                            ? "bg-[#EDF4F1] text-[#285447]"
                            : "bg-[#FEF6EC] text-[#9A5B13]"
                        }`}
                      >
                        {s.verification_status}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-[#526170]">Response window (days)</label>
                <input
                  type="number"
                  min={1}
                  value={rfqDeadlineDays}
                  onChange={(e) => setRfqDeadlineDays(e.target.value)}
                  className="mt-1 w-28 rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                />
              </div>
              <button
                type="button"
                disabled={busy || selectedSuppliers.length === 0}
                onClick={() => void handleCreateRfq()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-sm font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
              >
                <FileCheck2 className="h-4 w-4" />
                Generate RFQ PDF & Prepare Emails
              </button>
              <button
                type="button"
                disabled={busy || suppliers.length === 0}
                onClick={() => void handleGenerateExampleQuotes()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#9A5B13]/40 bg-[#FEF6EC] px-3.5 py-2 text-sm font-medium text-[#9A5B13] hover:bg-[#FDEBD2] disabled:opacity-50"
                title="Generates clearly labeled [DEMO SIMULATION] quotations + PDFs from your selected real suppliers so you can test Stage 3 -> Stage 6 immediately"
              >
                <Sparkles className="h-4 w-4" />
                Demonstrate Example Quotes ({(selectedSuppliers.length > 0 ? selectedSuppliers.length : suppliers.length) >= 3 ? 4 : Math.max(1, selectedSuppliers.length || suppliers.length)})
              </button>
              <button
                type="button"
                onClick={() => setStage(3)}
                className="inline-flex items-center gap-1 rounded-md border border-[#DEE4E9] bg-white px-3.5 py-2 text-sm font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
              >
                Next: Quotations
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Exported RFQs + Real Email Drafts */}
            {workspace.rfqs.length > 0 && (
              <div className="mt-5 space-y-3 border-t border-[#DEE4E9] pt-4">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-[#526170]">Exported RFQs & Supplier Outreach Emails</h4>
                {workspace.rfqs.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-[#DEE4E9] bg-[#F7F8FA] p-3 text-xs">
                    <div>
                      <div className="font-mono font-semibold text-[#1D2935]">
                        {r.rfq_code} · Request v{r.request_version} · <span className="text-[#285447]">{r.status}</span>
                      </div>
                      <div className="mt-0.5 text-[#526170]">Suppliers: {r.supplier_names.join(", ")}</div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {r.has_pdf && (
                        <a
                          href={`/api/v1/rfqs/${r.id}/pdf`}
                          className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 font-medium hover:bg-[#EDF4F1]"
                        >
                          <Download className="h-3.5 w-3.5" />
                          RFQ PDF
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleLoadRfqEmails(r.id)}
                        className="inline-flex items-center gap-1 rounded border border-[#285447] bg-[#EDF4F1] px-2.5 py-1.5 font-medium text-[#285447]"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        Prepare Supplier Emails
                      </button>
                      {r.status !== "distribution_recorded" && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleRecordDistribution(r.id)}
                          className="inline-flex items-center gap-1 rounded bg-[#285447] px-2.5 py-1.5 font-medium text-white hover:bg-[#1E4237]"
                        >
                          <Send className="h-3.5 w-3.5" />
                          Record Sent
                        </button>
                      )}
                    </div>
                  </div>
                ))}

                {emailDrafts.length > 0 && activeRfqIdForEmails && (
                  <div className="space-y-3 rounded-md border border-[#CBE1D8] bg-[#EDF4F1]/40 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-semibold text-[#285447]">
                        Ready-to-Send RFQ Emails ({emailDrafts.length} supplier{emailDrafts.length === 1 ? "" : "s"})
                      </div>
                      <div className="text-[11px] text-[#526170]">
                        {smtpConfigured
                          ? "SMTP configured — you can dispatch directly with PDF attached."
                          : "SMTP not configured in .env — use Open in Email Client or Copy Draft (and attach the RFQ PDF)."}
                      </div>
                    </div>
                    {emailDrafts.map((d) => (
                      <div key={d.supplier_id} className="rounded border border-[#DEE4E9] bg-white p-3.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-semibold text-[#1D2935]">{d.supplier_name}</div>
                            <div className="text-[#526170]">
                              To: <strong>{d.recipient_email || "No email on file — edit in Supplier Directory"}</strong>
                              {d.phone ? ` · Tel: ${d.phone}` : ""}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {d.has_email && (
                              <a
                                href={d.mailto_url}
                                className="inline-flex items-center gap-1 rounded bg-[#285447] px-3 py-1.5 font-medium text-white hover:bg-[#1E4237]"
                              >
                                <Mail className="h-3.5 w-3.5" />
                                Open in Mail Client
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                void navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${d.body}`);
                                onFeedback("ok", `Copied RFQ email draft for ${d.supplier_name}.`);
                              }}
                              className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 font-medium hover:bg-[#F7F8FA]"
                            >
                              <Copy className="h-3.5 w-3.5" />
                              Copy
                            </button>
                            {smtpConfigured && d.has_email && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleSendRfqEmailsSmtp(activeRfqIdForEmails, [d.supplier_id])}
                                className="inline-flex items-center gap-1 rounded border border-[#285447] bg-[#EDF4F1] px-2.5 py-1.5 font-medium text-[#285447]"
                              >
                                <Send className="h-3.5 w-3.5" />
                                Send via SMTP (+PDF)
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="mt-2 font-medium text-[#1D2935]">Subject: {d.subject}</div>
                        <pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-[#F7F8FA] p-2.5 font-sans text-[11px] text-[#526170]">
                          {d.body}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* STAGE 3: Real PDF/CSV Quotation Upload & Extraction + Manual Entry */}
      {stage === 3 && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#DEE4E9] bg-white p-5">
            <div>
              <h3 className="text-base font-semibold">Supplier Quotations ({workspace.quotations.length})</h3>
              <p className="text-xs text-[#526170]">
                Upload a real PDF/CSV quote, enter terms manually, or click <strong>Demonstrate Example Quotes</strong> to simulate realistic quotes ({currency}) from your searched suppliers.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || suppliers.length === 0}
                onClick={() => void handleGenerateExampleQuotes()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#9A5B13]/40 bg-[#FEF6EC] px-3.5 py-2 text-xs font-medium text-[#9A5B13] hover:bg-[#FDEBD2] disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Demonstrate Example Quotes
              </button>
              <button
                type="button"
                disabled={busy || workspace.quotations.length === 0}
                onClick={() => void handleRunComparison()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
              >
                Run Deterministic Comparison
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Upload Real Quote PDF/CSV + Confirm Form */}
          <form onSubmit={handleAddManualQuote} className="space-y-4 rounded-md border border-[#DEE4E9] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] pb-3">
              <div>
                <h4 className="text-sm font-semibold">Upload Supplier Quotation Document (PDF/CSV) or Enter Quote</h4>
                <p className="text-xs text-[#526170]">
                  Files are stored privately in RustFS with SHA-256 hash. Missing freight or tax stays Unknown (never zero).
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[#285447] bg-[#EDF4F1] px-3.5 py-2 text-xs font-medium text-[#285447] hover:bg-[#DDECE5]">
                <Upload className="h-3.5 w-3.5" />
                {extractingFile ? "Extracting PDF..." : "Upload & Extract Quote PDF/CSV"}
                <input
                  type="file"
                  accept=".pdf,.csv,.txt"
                  onChange={(e) => void handleUploadQuoteFile(e)}
                  className="hidden"
                />
              </label>
            </div>

            {qExcerpt && (
              <div className="rounded border border-[#CBE1D8] bg-[#EDF4F1] p-3 text-xs text-[#285447]">
                <strong>Extracted Source Evidence ({qSourceFilename}):</strong> &ldquo;{qExcerpt}&rdquo;
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-6">
              <select
                value={qSupplierId}
                onChange={(e) => setQSupplierId(e.target.value)}
                className="rounded border border-[#DEE4E9] bg-white px-2.5 py-2 md:col-span-2"
              >
                {suppliers.length === 0 && <option value="">Save a supplier in Stage 2 first</option>}
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <select
                value={qCurrency}
                onChange={(e) => setQCurrency(e.target.value)}
                className="rounded border border-[#DEE4E9] bg-white px-2.5 py-2"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <input value={qUnitPrice} onChange={(e) => setQUnitPrice(e.target.value)} placeholder={`Unit price (${qCurrency})`} className="rounded border border-[#DEE4E9] px-2.5 py-2" />
              <input value={qFreight} onChange={(e) => setQFreight(e.target.value)} placeholder="Freight (blank=unknown)" className="rounded border border-[#DEE4E9] px-2.5 py-2" />
              <input value={qTax} onChange={(e) => setQTax(e.target.value)} placeholder="Tax/TVA (blank=unknown)" className="rounded border border-[#DEE4E9] px-2.5 py-2" />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-3">
                <input value={qDelivery} onChange={(e) => setQDelivery(e.target.value)} placeholder="Delivery days" className="w-28 rounded border border-[#DEE4E9] px-2.5 py-1.5" />
                <input value={qWarranty} onChange={(e) => setQWarranty(e.target.value)} placeholder="Warranty mo." className="w-28 rounded border border-[#DEE4E9] px-2.5 py-1.5" />
                <input value={qTerms} onChange={(e) => setQTerms(e.target.value)} placeholder="Payment terms" className="w-32 rounded border border-[#DEE4E9] px-2.5 py-1.5" />
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={qMeetsSpecs} onChange={(e) => setQMeetsSpecs(e.target.checked)} className="accent-[#285447]" />
                  Meets mandatory specs
                </label>
              </div>
              <button
                type="submit"
                disabled={busy || !qSupplierId}
                className="inline-flex items-center gap-1 rounded-md bg-[#285447] px-4 py-2 font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                Confirm & Save Quotation
              </button>
            </div>
          </form>

          {workspace.quotations.length > 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {workspace.quotations.map((q) => (
                <div key={q.id} className="rounded-md border border-[#DEE4E9] bg-white p-4 text-xs">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-[#1D2935]">{q.supplier_name}</span>
                        {q.is_demo_example && (
                          <span className="rounded bg-[#FEF6EC] px-1.5 py-0.5 text-[10px] font-semibold text-[#9A5B13]">
                            Demo Example
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-[#526170]">{q.quote_code} · Rev {q.revision_number}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {q.has_source_file && (
                        <a
                          href={`/api/v1/quotations/${q.id}/pdf`}
                          className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] bg-[#F7F8FA] px-2 py-1 text-[11px] font-medium text-[#1D2935] hover:bg-[#EDF4F1]"
                        >
                          <Download className="h-3 w-3" />
                          PDF
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setEditingQuoteId(editingQuoteId === q.id ? null : q.id);
                          setCorrUnitPrice(q.unit_price);
                          setCorrFreight(q.freight_amount ?? "");
                          setCorrDelivery(q.delivery_days != null ? String(q.delivery_days) : "");
                          setCorrSpecOverride("");
                        }}
                        className="rounded border border-[#DEE4E9] px-2 py-1 text-[11px] font-medium text-[#285447] hover:bg-[#EDF4F1]"
                      >
                        Correct fields
                      </button>
                    </div>
                  </div>
                  {q.offered_specs_text && (
                    <p className="mt-2 rounded bg-[#F7F8FA] px-2.5 py-1.5 text-[11px] text-[#526170]">
                      <strong className="text-[#1D2935]">Offered specs:</strong> {q.offered_specs_text}
                    </p>
                  )}
                  <dl className="mt-3 space-y-1.5 border-t border-[#DEE4E9] pt-2.5 tabular-nums">
                    <div className="flex justify-between"><dt className="text-[#526170]">Unit price × {q.quantity}</dt><dd className="font-medium">{q.currency_code} {q.unit_price}</dd></div>
                    <div className="flex justify-between"><dt className="text-[#526170]">Freight</dt><dd className="font-medium">{q.freight_amount ?? "Unknown"}</dd></div>
                    <div className="flex justify-between"><dt className="text-[#526170]">Quoted tax / TVA</dt><dd className="font-medium">{q.quoted_tax_amount ?? "Unknown"}</dd></div>
                    <div className="flex justify-between"><dt className="text-[#526170]">Delivery</dt><dd className="font-medium">{q.delivery_days != null ? `${q.delivery_days} days` : "Unknown"}</dd></div>
                  </dl>
                  {editingQuoteId === q.id && (
                    <div className="mt-3 space-y-2 border-t border-[#DEE4E9] pt-3">
                      <div className="grid grid-cols-3 gap-1.5">
                        <input value={corrUnitPrice} onChange={(e) => setCorrUnitPrice(e.target.value)} placeholder="Unit price" className="rounded border border-[#DEE4E9] px-2 py-1 text-xs" />
                        <input value={corrFreight} onChange={(e) => setCorrFreight(e.target.value)} placeholder="Freight" className="rounded border border-[#DEE4E9] px-2 py-1 text-xs" />
                        <input value={corrDelivery} onChange={(e) => setCorrDelivery(e.target.value)} placeholder="Days" className="rounded border border-[#DEE4E9] px-2 py-1 text-xs" />
                      </div>
                      <select
                        value={corrSpecOverride}
                        onChange={(e) => setCorrSpecOverride(e.target.value as "" | "pass" | "needs_clarification" | "fail")}
                        className="w-full rounded border border-[#DEE4E9] bg-white px-2 py-1 text-xs"
                      >
                        <option value="">Keep current spec verdict (no spec override)</option>
                        <option value="pass">Override Mandatory Specs → Pass (Verified)</option>
                        <option value="needs_clarification">Override Mandatory Specs → Needs Clarification</option>
                        <option value="fail">Override Mandatory Specs → Fail (Non-compliant)</option>
                      </select>
                      <input value={corrReason} onChange={(e) => setCorrReason(e.target.value)} placeholder="Reason / supplier evidence for correction (required)" className="w-full rounded border border-[#DEE4E9] px-2 py-1 text-xs" />
                      <button type="button" disabled={busy} onClick={() => void handleSaveCorrection(q.id)} className="w-full rounded bg-[#285447] py-1.5 text-xs font-medium text-white">
                        Save Correction (Rev {q.revision_number + 1})
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* STAGE 4: Deterministic Commercial Comparison Matrix */}
      {stage === 4 && workspace.latest_comparison && (
        <div className="space-y-5">
          <div className="overflow-x-auto rounded-md border border-[#DEE4E9] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DEE4E9] px-5 py-3.5">
              <div>
                <h3 className="text-base font-semibold">Commercial Comparison Matrix (v{workspace.latest_comparison.version_number})</h3>
                <p className="text-xs text-[#526170]">
                  Deterministic Decimal math ({workspace.latest_comparison.result.request_summary.currency_code}) · Mandatory eligibility checked BEFORE ranking.
                </p>
              </div>
              <button type="button" disabled={busy} onClick={() => void handleRunComparison()} className="rounded border border-[#DEE4E9] bg-white px-3 py-1.5 text-xs font-medium">
                Recompute
              </button>
            </div>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[#DEE4E9]">
                <tr>
                  <th className="w-48 bg-[#F7F8FA] px-4 py-3 text-xs font-medium text-[#526170]">Comparison Field</th>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <th key={o.quotation_id} className={`border-l border-[#DEE4E9] px-4 py-3 align-top ${o.is_recommended ? "bg-[#EDF4F1]/70" : "bg-white"}`}>
                      <div className="text-sm font-semibold">{o.supplier_name}</div>
                      <div className="font-mono text-[11px] font-normal text-[#526170]">{o.quote_code} · Rev {o.revision_number}</div>
                      <div className="mt-1.5">
                        {o.is_recommended ? (
                          <span className="inline-flex items-center gap-1 rounded bg-[#EDF4F1] px-2 py-0.5 text-[11px] font-medium text-[#285447]">
                            <CheckCircle2 className="h-3 w-3" /> Lowest eligible total
                          </span>
                        ) : o.eligibility === "eligible" ? (
                          <span className="rounded bg-[#EEF2F6] px-2 py-0.5 text-[11px] font-medium">Eligible</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded bg-[#FEF6EC] px-2 py-0.5 text-[11px] font-medium text-[#9A5B13]">
                            <AlertTriangle className="h-3 w-3" /> {o.failure_reasons[0] || o.eligibility}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DEE4E9] text-xs tabular-nums">
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">Unit price</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">{o.currency_code} {o.unit_price}</td>
                  ))}
                </tr>
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">Item subtotal (×{workspace.latest_comparison.result.request_summary.quantity})</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">{o.currency_code} {o.item_subtotal}</td>
                  ))}
                </tr>
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">Freight</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">{o.freight_amount !== null ? `${o.currency_code} ${o.freight_amount}` : <span className="text-[#9A5B13]">Unknown</span>}</td>
                  ))}
                </tr>
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">Quoted tax / TVA</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">{o.quoted_tax_amount !== null ? `${o.currency_code} ${o.quoted_tax_amount}` : <span className="text-[#9A5B13]">Unknown</span>}</td>
                  ))}
                </tr>
                <tr className="bg-[#F7F8FA]/80 font-semibold">
                  <td className="px-4 py-3">Total quoted cost</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-3 text-sm">{o.total_quoted_cost !== null ? `${o.currency_code} ${o.total_quoted_cost}` : <span className="text-[#9A5B13]">Incomplete</span>}</td>
                  ))}
                </tr>
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">Delivery</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">{o.delivery_days != null ? `${o.delivery_days} days` : "Unknown"}</td>
                  ))}
                </tr>
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-2.5 align-top font-medium text-[#526170]">
                    <div>Mandatory specs</div>
                    <div className="mt-0.5 text-[10px] font-normal text-[#285447]">Jev Router verified</div>
                  </td>
                  {workspace.latest_comparison.result.offers.map((o) => {
                    const sv = o.spec_verification;
                    return (
                      <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5 align-top font-sans">
                        {sv ? (
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap gap-1">
                              {(sv.specs || []).map((sp, idx) => {
                                const badgeCls =
                                  sp.status === "pass"
                                    ? "bg-[#EDF4F1] text-[#285447]"
                                    : sp.status === "fail"
                                    ? "bg-[#FDF2F2] text-[#9B1C1C]"
                                    : "bg-[#FEF6EC] text-[#9A5B13]";
                                const prefix = sp.status === "pass" ? "✓" : sp.status === "fail" ? "✗" : "?";
                                return (
                                  <span
                                    key={idx}
                                    title={sp.evidence}
                                    className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeCls}`}
                                  >
                                    {prefix} {sp.spec}
                                  </span>
                                );
                              })}
                            </div>
                            <div className="text-[11px] text-[#526170]">{sv.summary_reason}</div>
                            {sv.human_override ? (
                              <div className="text-[10px] font-medium text-[#285447]">
                                Human override ({sv.human_override.editor_name})
                              </div>
                            ) : sv.verified_by_model ? (
                              <div className="font-mono text-[10px] text-[#526170]">
                                {sv.requested_router || "jev-router"} → {sv.verified_by_model}
                                {sv.cache_hit ? " (cache)" : ""}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <span>{o.meets_mandatory_specs ? "Pass" : "Fail"}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
                <tr>
                  <td className="bg-[#F7F8FA] px-4 py-3 font-medium text-[#526170]">Action</td>
                  {workspace.latest_comparison.result.offers.map((o) => (
                    <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-3 font-sans">
                      {o.eligibility === "needs_clarification" ? (
                        <button
                          type="button"
                          onClick={() => {
                            const matchQ = workspace.quotations.find((qt) => qt.id === o.quotation_id);
                            setEditingQuoteId(o.quotation_id);
                            setCorrUnitPrice(matchQ?.unit_price || o.unit_price);
                            setCorrFreight(matchQ?.freight_amount ?? o.freight_amount ?? "");
                            setCorrDelivery(matchQ?.delivery_days != null ? String(matchQ.delivery_days) : "");
                            setCorrSpecOverride("pass");
                            setStage(3);
                          }}
                          className="w-full rounded-md border border-[#9A5B13]/40 bg-[#FEF6EC] px-3 py-2 text-xs font-medium text-[#9A5B13] hover:bg-[#FDEBD2]"
                        >
                          Clarify / Override in Stage 3 →
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy || o.eligibility !== "eligible"}
                          onClick={() => void handleSubmitAward(o.quotation_id)}
                          className="w-full rounded-md bg-[#285447] px-3 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:bg-[#D5DFE4] disabled:text-[#526170]"
                        >
                          {o.eligibility === "eligible" ? "Submit Award for Approval" : "Ineligible (Blocked)"}
                        </button>
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-[#CBE1D8] bg-[#EDF4F1] p-4 text-xs">
            <div className="max-w-2xl">
              <div className="font-semibold text-[#285447]">
                {workspace.latest_comparison.result.recommended_supplier_name
                  ? `Recommended: ${workspace.latest_comparison.result.recommended_supplier_name}`
                  : "No Eligible Winner"}
              </div>
              <p className="mt-1 text-[#1D2935]">{workspace.latest_comparison.explanation}</p>
            </div>
            {workspace.latest_comparison.result.recommended_budget_headroom && (
              <div className="text-right">
                <div className="text-[#526170]">Budget headroom</div>
                <div className="text-lg font-semibold tabular-nums text-[#285447]">
                  {workspace.latest_comparison.result.request_summary.currency_code} {workspace.latest_comparison.result.recommended_budget_headroom}
                </div>
                <div className="text-[11px] text-[#526170]">Not a savings claim</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STAGE 5: Authorized Human Approval */}
      {stage === 5 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-4 rounded-md border border-[#DEE4E9] bg-white p-5 lg:col-span-7">
            <div className="border-b border-[#DEE4E9] pb-3">
              <div className="text-xs font-semibold uppercase tracking-wider text-[#285447]">
                {workspace.pending_approval?.decision_type === "po_release"
                  ? "Checkpoint 2 of 2 · Final Purchase Order Release"
                  : "Checkpoint 1 of 2 · Supplier Award Approval"}
              </div>
              <h3 className="mt-1 text-lg font-semibold">
                {workspace.pending_approval ? String(workspace.pending_approval.packet.supplier_name || workspace.request.title) : "No pending approval packet"}
              </h3>
            </div>
            {workspace.pending_approval ? (
              <div className="space-y-4 text-xs">
                <div className="grid grid-cols-3 divide-x divide-[#DEE4E9] rounded border border-[#DEE4E9] bg-[#F7F8FA] p-3">
                  <div className="px-2">
                    <div className="text-[#526170]">Total approved amount</div>
                    <div className="mt-0.5 text-base font-semibold tabular-nums">
                      {workspace.pending_approval.currency_code} {workspace.pending_approval.amount}
                    </div>
                  </div>
                  <div className="px-2">
                    <div className="text-[#526170]">Delivery</div>
                    <div className="mt-0.5 text-base font-semibold">{String(workspace.pending_approval.packet.delivery_days ?? "—")} days</div>
                  </div>
                  <div className="px-2">
                    <div className="text-[#526170]">Payment / Warranty</div>
                    <div className="mt-0.5 text-sm font-semibold">
                      {String(workspace.pending_approval.packet.payment_terms ?? "Net 30")} · {String(workspace.pending_approval.packet.warranty_months ?? "—")}m
                    </div>
                  </div>
                </div>
                <div className="rounded bg-[#F7F8FA] p-2.5 font-mono text-[11px] text-[#526170]">
                  Canonical Payload Hash: {workspace.pending_approval.payload_hash}
                </div>
              </div>
            ) : (
              <p className="text-xs text-[#526170]">Proceed to Stage 6 to draft or download your PO.</p>
            )}
          </div>

          <div className="rounded-md border border-[#DEE4E9] bg-white p-5 lg:col-span-5">
            <h3 className="text-base font-semibold">Your Decision</h3>
            {workspace.pending_approval ? (
              <div className="mt-3 space-y-4">
                {canCurrentActorApprove ? (
                  <div className="flex items-start gap-2 rounded-md bg-[#EDF4F1] p-3 text-xs text-[#285447]">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <div className="font-semibold">You are an assigned approver</div>
                      <div>{actor?.display_name} · Authority up to {actor?.approval_limit_usd}</div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2.5 rounded-md border border-[#F5DFC4] bg-[#FEF6EC] p-3.5 text-xs text-[#9A5B13]">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <div className="font-semibold">Separation of Duties / Approver Required</div>
                        <p className="mt-0.5">Signed in as <strong>{actor?.display_name}</strong>. Switch to an assigned approver to decide this packet.</p>
                      </div>
                    </div>
                    {devAuthEnabled && sameTenantApproverPersona && (
                      <button
                        type="button"
                        onClick={() => void onSwitchPersona(sameTenantApproverPersona.id)}
                        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-[#285447] px-3 py-2 text-xs font-medium text-white hover:bg-[#1E4237]"
                      >
                        <UserCheck className="h-3.5 w-3.5" />
                        Switch to {sameTenantApproverPersona.display_name} (Assigned Approver)
                      </button>
                    )}
                  </div>
                )}
                <textarea rows={2} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Decision note (optional)..." className="w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-xs" />
                <label className="flex cursor-pointer items-start gap-2 text-xs">
                  <input type="checkbox" checked={reviewChecked} onChange={(e) => setReviewChecked(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#285447]" />
                  <span>I have reviewed the quotation and commercial terms.</span>
                </label>
                <button
                  type="button"
                  disabled={busy || !reviewChecked}
                  onClick={() => void handleDecision("approve")}
                  className="flex w-full items-center justify-center gap-2 rounded-md bg-[#285447] px-4 py-2.5 text-sm font-medium text-white disabled:bg-[#9FB3AC]"
                >
                  <Lock className="h-4 w-4" />
                  {workspace.pending_approval.decision_type === "po_release" ? "Approve Final PO Release" : "Approve Supplier Award"}
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" disabled={busy} onClick={() => void handleDecision("request-changes")} className="rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs font-medium">
                    Request changes
                  </button>
                  <button type="button" disabled={busy} onClick={() => void handleDecision("reject")} className="inline-flex items-center justify-center gap-1 rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs font-medium text-[#9B1C1C]">
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-3 text-xs text-[#526170]">No pending decision on this request.</div>
            )}
          </div>
        </div>
      )}

      {/* STAGE 6: Approved PO PDF */}
      {stage === 6 && (
        <div className="rounded-md border border-[#DEE4E9] bg-white p-5">
          {!workspace.purchase_order ? (
            <div className="space-y-3">
              <h3 className="text-base font-semibold">Prepare Purchase Order from Approved Award</h3>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handlePreparePoDraft()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#1E4237]"
              >
                <FileCheck2 className="h-4 w-4" />
                Prepare PO Draft & Request Final Release
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-semibold">{workspace.purchase_order.po_number || "PO Draft"}</h3>
                    <span className="rounded bg-[#EDF4F1] px-2.5 py-0.5 text-xs font-semibold uppercase text-[#285447]">
                      {workspace.purchase_order.status.replaceAll("_", " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#526170]">
                    Supplier: <strong>{workspace.purchase_order.supplier_name}</strong> · Total: <strong>{workspace.purchase_order.currency_code} {workspace.purchase_order.total_amount}</strong>
                  </p>
                </div>
                {workspace.purchase_order.has_pdf && (
                  <a href={`/api/v1/purchase-orders/${workspace.purchase_order.id}/pdf`} className="inline-flex items-center gap-2 rounded-md bg-[#285447] px-4 py-2.5 text-sm font-medium text-white">
                    <Download className="h-4 w-4" />
                    Download Approved PO PDF
                  </a>
                )}
              </div>
              {workspace.purchase_order.status === "approved_ready_for_issue" && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <input value={issueNote} onChange={(e) => setIssueNote(e.target.value)} className="flex-1 rounded border border-[#DEE4E9] px-3 py-1.5" />
                  <button type="button" disabled={busy} onClick={() => void handleRecordExternalIssue(workspace.purchase_order!.id)} className="rounded bg-[#285447] px-3.5 py-1.5 font-medium text-white">
                    Record External Issue
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
