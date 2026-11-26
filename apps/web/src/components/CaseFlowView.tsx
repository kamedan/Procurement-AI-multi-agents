"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
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
  X,
  XCircle,
} from "lucide-react";
import { copyTextSafely, formatApiError, readJsonSafe } from "@/lib/errors";
import { t, type UiLang } from "@/lib/i18n";
import PdfPreviewDrawer from "./PdfPreviewDrawer";
import type {
  Actor,
  CopilotAction,
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
  lang?: UiLang;
  externalStageRequest?: { stage: number; seq: number } | null;
  copilotDraftPrefill?: { patch: NonNullable<CopilotAction["draft_patch"]>; seq: number } | null;
  onRefresh: () => Promise<void>;
  onSwitchPersona: (personaId: string) => Promise<void>;
  onFeedback: (kind: "ok" | "error", text: string) => void;
}

const CURRENCIES = ["TND", "EUR", "USD", "MAD", "DZD", "GBP", "SAR", "AED", "CAD", "CHF", "JPY"];
const STAGE_KEYS = ["stage1", "stage2", "stage3", "stage4", "stage5", "stage6"] as const;

function inferStage(ws: WorkspaceData): number {
  if (ws.purchase_order && ws.purchase_order.po_number) return 6;
  if (ws.pending_approval) return 5;
  if (ws.request.status === "award_approved") return 6;
  if (ws.latest_comparison) return 4;
  if (ws.quotations.length > 0) return 3;
  if (ws.rfqs.length > 0 || ws.request.status === "confirmed") return 2;
  return 1;
}

function formatStatusLabel(status: string, isFr: boolean): string {
  const map: Record<string, { en: string; fr: string }> = {
    draft: { en: "Draft", fr: "Brouillon" },
    confirmed: { en: "Confirmed", fr: "Confirmée" },
    rfq_sent: { en: "RFQ Sent", fr: "DP envoyée" },
    quotes_received: { en: "Quotes Received", fr: "Devis reçus" },
    compared: { en: "Compared", fr: "Comparée" },
    pending_award_approval: { en: "Awaiting Award Approval", fr: "Attente approbation attribution" },
    award_approved: { en: "Award Approved", fr: "Attribution approuvée" },
    pending_po_approval: { en: "Awaiting PO Release", fr: "Attente validation BC" },
    po_approved: { en: "PO Approved", fr: "BC approuvé" },
    po_issued: { en: "PO Issued", fr: "BC émis" },
    approved_ready_for_issue: { en: "Approved · Ready to Issue", fr: "Approuvé · Prêt à envoyer" },
    externally_issued: { en: "Externally Issued", fr: "Envoyé au fournisseur" },
    pending_approval: { en: "Pending Release Approval", fr: "Attente validation" },
    changes_requested: { en: "Changes Requested", fr: "Modifications demandées" },
    rejected: { en: "Rejected", fr: "Rejetée" },
  };
  const found = map[status];
  if (found) return isFr ? found.fr : found.en;
  return status.replaceAll("_", " ");
}

export default function CaseFlowView({
  workspace,
  actor,
  personas,
  devAuthEnabled,
  suppliers,
  lang = "en",
  externalStageRequest,
  copilotDraftPrefill,
  onRefresh,
  onSwitchPersona,
  onFeedback,
}: Props) {
  const isFr = lang === "fr";
  const [stage, setStage] = useState<number>(() => inferStage(workspace));
  const [busy, setBusy] = useState(false);
  const [docLang, setDocLang] = useState<UiLang>(
    workspace.request.document_language === "fr" ? "fr" : workspace.request.document_language === "en" ? "en" : lang
  );
  const [applyStamp, setApplyStamp] = useState<boolean>(Boolean(workspace.request.apply_fiscal_stamp));
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);
  const [showTrace, setShowTrace] = useState(false);

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

  // Stage 2 Supplier Search & RFQ state
  const [liveQuery, setLiveQuery] = useState(verPayload?.item_summary || workspace.request.title);
  const [liveLocation, setLiveLocation] = useState(
    verPayload?.location || workspace.request.location || "Sousse, Tunisia"
  );
  const [extractedSuppliers, setExtractedSuppliers] = useState<ExtractedSupplierCandidate[]>([]);
  const [manualEmailOverrides, setManualEmailOverrides] = useState<Record<string, string>>({});
  const [searchingReal, setSearchingReal] = useState(false);
  const [showWebSearch, setShowWebSearch] = useState<boolean>(suppliers.length === 0);
  const [selectedSuppliers, setSelectedSuppliers] = useState<string[]>([]);
  const [rfqDeadlineDays, setRfqDeadlineDays] = useState("5");
  const [emailDrafts, setEmailDrafts] = useState<RfqEmailDraft[]>([]);
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [activeRfqIdForEmails, setActiveRfqIdForEmails] = useState<string | null>(null);

  // Stage 3 Quote Upload + Manual Entry + Corrections
  const [showQuoteForm, setShowQuoteForm] = useState(false);
  const [qSupplierId, setQSupplierId] = useState("");
  const [qCurrency, setQCurrency] = useState(currency);
  const [qUnitPrice, setQUnitPrice] = useState("");
  const [qFreight, setQFreight] = useState("");
  const [qTax, setQTax] = useState("");
  const [qDelivery, setQDelivery] = useState("");
  const [qWarranty, setQWarranty] = useState("12");
  const [qTerms, setQTerms] = useState("Net 30");
  const [qMeetsSpecs, setQMeetsSpecs] = useState(true);
  const [qOfferedSpecs, setQOfferedSpecs] = useState("");
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
  const [issueNote, setIssueNote] = useState(
    isFr
      ? "Bon de commande PDF approuvé envoyé par email au fournisseur."
      : "Sent approved PO PDF to supplier contact via email."
  );

  // Handle explicit external stage jump (e.g. from Pending Approval Inbox or Copilot)
  useEffect(() => {
    if (externalStageRequest) {
      setStage(externalStageRequest.stage);
    }
  }, [externalStageRequest?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset stage & per-request transient UI state ONLY when switching to a different request ID
  useEffect(() => {
    setStage(inferStage(workspace));
    setPreview(null);
    setEmailDrafts([]);
    setActiveRfqIdForEmails(null);
    setManualEmailOverrides({});
    setEditingQuoteId(null);
    setShowQuoteForm(false);
    setReviewChecked(false);
    setDecisionNote("");
    setShowTrace(false);

    const loc = workspace.latest_version?.payload?.location || workspace.request.location || "";
    const intakeLeads = workspace.run?.projection?.external_leads || [];
    if (intakeLeads.length > 0) {
      setExtractedSuppliers(
        intakeLeads.map((ld) => ({
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
      setShowWebSearch(true);
    } else {
      setExtractedSuppliers([]);
      setShowWebSearch(suppliers.length === 0);
    }
  }, [workspace.request.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep form fields synced with persisted RequestVersion changes
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
    setDocLang(workspace.request.document_language === "fr" ? "fr" : "en");
    setApplyStamp(Boolean(workspace.request.apply_fiscal_stamp));
  }, [
    workspace.request.id,
    workspace.request.current_version,
    workspace.latest_version?.payload_hash,
    workspace.request.document_language,
    workspace.request.apply_fiscal_stamp,
  ]);

  // Apply Copilot draft prefill cleanly
  useEffect(() => {
    if (!copilotDraftPrefill) return;
    const p = copilotDraftPrefill.patch;
    if (p.title) setTitle(p.title);
    if (p.item_summary) setItemSummary(p.item_summary);
    if (p.quantity != null) setQuantity(String(p.quantity));
    if (p.budget_cap) setBudgetCap(p.budget_cap);
    if (p.currency_code) setCurrency(p.currency_code);
    if (p.location) setLocation(p.location);
    if (p.delivery_window_days != null) setDeliveryDays(String(p.delivery_window_days));
    if (p.mandatory_specs) setSpecsText(p.mandatory_specs.join(", "));
    setStage(1);
  }, [copilotDraftPrefill?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Revalidate selectedSuppliers & qSupplierId whenever tenant suppliers or request changes
  useEffect(() => {
    const validIds = new Set(suppliers.map((s) => s.id));
    setSelectedSuppliers((prev) => {
      const kept = prev.filter((id) => validIds.has(id));
      if (kept.length > 0) return kept;
      const rfqSupIds = workspace.rfqs[0]?.supplier_ids.filter((id) => validIds.has(id)) || [];
      if (rfqSupIds.length > 0) return rfqSupIds;
      return suppliers.slice(0, 4).map((s) => s.id);
    });
    setQSupplierId((prev) => (prev && validIds.has(prev) ? prev : suppliers[0]?.id || ""));
  }, [suppliers, workspace.request.id, workspace.rfqs]);

  // Lookup map to detect already-saved web leads (prevents duplicate saves!)
  const savedSupplierLookup = useMemo(() => {
    const byUrl = new Map<string, SupplierItem>();
    const byName = new Map<string, SupplierItem>();
    for (const s of suppliers) {
      if (s.website_url) byUrl.set(s.website_url.trim().toLowerCase(), s);
      byName.set(s.name.trim().toLowerCase(), s);
    }
    return { byUrl, byName };
  }, [suppliers]);

  const findSavedSupplier = (cand: ExtractedSupplierCandidate): SupplierItem | undefined => {
    return (
      savedSupplierLookup.byUrl.get(cand.website_url.trim().toLowerCase()) ||
      savedSupplierLookup.byName.get(cand.supplier_name.trim().toLowerCase())
    );
  };

  // Derived workflow milestone flags
  const isAwardApproved = useMemo(() => {
    return (
      workspace.request.status === "award_approved" ||
      workspace.request.status === "pending_po_approval" ||
      workspace.request.status === "po_approved" ||
      workspace.request.status === "po_issued" ||
      Boolean(workspace.purchase_order) ||
      workspace.decisions.some((d) => d.decision_type === "supplier_award" && d.outcome === "approved")
    );
  }, [workspace.request.status, workspace.purchase_order, workspace.decisions]);

  const stageDone: boolean[] = [
    workspace.request.status !== "draft",
    workspace.rfqs.length > 0 || workspace.quotations.length > 0,
    workspace.quotations.length > 0,
    Boolean(workspace.latest_comparison),
    isAwardApproved && !workspace.pending_approval,
    Boolean(workspace.purchase_order?.po_number),
  ];

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

  // Recommended next-step guidance bar
  const nextStepHint = useMemo(() => {
    if (workspace.purchase_order?.po_number) {
      return {
        targetStage: 6,
        text: isFr
          ? `Terminé ! Le Bon de Commande ${workspace.purchase_order.po_number} est approuvé et prêt à être téléchargé.`
          : `All done! Approved Purchase Order ${workspace.purchase_order.po_number} is ready to preview or download.`,
        cta: isFr ? "Voir le BC (Étape 6)" : "View PO (Stage 6)",
      };
    }
    if (workspace.pending_approval) {
      const isPo = workspace.pending_approval.decision_type === "po_release";
      return {
        targetStage: 5,
        text: isFr
          ? isPo
            ? "Prochaine étape : approuver l'émission finale du Bon de Commande (Point de contrôle 2/2)."
            : "Prochaine étape : approuver l'attribution au fournisseur (Point de contrôle 1/2)."
          : isPo
          ? "Next step: Review and approve Final PO Release (Checkpoint 2 of 2)."
          : "Next step: Review and approve the Supplier Award (Checkpoint 1 of 2).",
        cta: isFr ? "Aller aux Approbations" : "Go to Approvals",
      };
    }
    if (isAwardApproved && !workspace.purchase_order) {
      return {
        targetStage: 6,
        text: isFr
          ? "Attribution approuvée ! Préparez maintenant le Bon de Commande à l'Étape 6."
          : "Supplier Award approved! Prepare the Purchase Order in Stage 6.",
        cta: isFr ? "Préparer le BC (Étape 6)" : "Prepare PO (Stage 6)",
      };
    }
    if (workspace.latest_comparison) {
      return {
        targetStage: 4,
        text: isFr
          ? "Comparatif prêt : sélectionnez le fournisseur éligible recommandé et soumettez l'attribution."
          : "Comparison ready: review the eligible recommendation and submit the award for approval.",
        cta: isFr ? "Voir le Comparatif" : "View Comparison",
      };
    }
    if (workspace.quotations.length > 0) {
      return {
        targetStage: 3,
        text: isFr
          ? `${workspace.quotations.length} devis reçu(s) : vérifiez les offres puis lancez le comparatif.`
          : `${workspace.quotations.length} quote(s) on file: review them and run the comparison.`,
        cta: isFr ? "Aller aux Devis" : "Go to Quotations",
      };
    }
    if (workspace.request.status === "confirmed" || workspace.rfqs.length > 0) {
      return {
        targetStage: 2,
        text: isFr
          ? "Sélectionnez vos fournisseurs pour générer la Demande de Prix PDF — ou générez 4 devis exemples pour tester."
          : "Select suppliers to generate the RFQ PDF & emails — or generate example quotes to test right away.",
        cta: isFr ? "Aller aux Fournisseurs" : "Go to Suppliers",
      };
    }
    return {
      targetStage: 1,
      text: isFr
        ? "Vérifiez le produit, la quantité, le budget et la devise, puis cliquez sur Confirmer."
        : "Review the item, quantity, budget, and currency, then click Confirm & Go to Suppliers.",
      cta: isFr ? "Aller à la Demande" : "Go to Request",
    };
  }, [workspace, isAwardApproved, isFr]);

  // --- Handlers ---

  const handleSaveRequest = async (confirm: boolean) => {
    if (!title.trim() || !itemSummary.trim()) {
      onFeedback("error", isFr ? "Veuillez saisir un titre et une description du produit." : "Please enter a request title and item description.");
      return;
    }
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
          document_language: docLang,
          apply_fiscal_stamp: applyStamp && currency.trim().toUpperCase() === "TND",
          confirm,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de l'enregistrement" : "Failed to save request", res.status));
        return;
      }
      onFeedback(
        "ok",
        isFr
          ? `Demande v${data.version_number} enregistrée (${currency})${confirm ? " et confirmée." : "."}`
          : `Saved Request v${data.version_number} (${currency})${confirm ? " and confirmed." : "."}`
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de la recherche web" : "Supplier web search failed", res.status));
        return;
      }
      const found = (Array.isArray(data.suppliers) ? data.suppliers : []) as ExtractedSupplierCandidate[];
      setExtractedSuppliers(found);
      onFeedback(
        "ok",
        isFr
          ? `${found.length} fournisseur(s) réel(s) trouvé(s) pour « ${liveQuery.trim()} » (${liveLocation || "global"}).`
          : `Found ${found.length} real supplier lead(s) for "${liveQuery.trim()}" (${liveLocation || "global"}).`
      );
      await onRefresh();
    } finally {
      setSearchingReal(false);
    }
  };

  const handleSaveExtractedSupplier = async (cand: ExtractedSupplierCandidate) => {
    const existing = findSavedSupplier(cand);
    if (existing) {
      setSelectedSuppliers((prev) => (prev.includes(existing.id) ? prev : [...prev, existing.id]));
      onFeedback("ok", isFr ? `« ${existing.name} » est déjà enregistré et sélectionné.` : `"${existing.name}" is already saved and selected.`);
      return;
    }
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Impossible d'enregistrer le fournisseur" : "Could not save supplier", res.status));
        return;
      }
      if (typeof data.id === "string") {
        setSelectedSuppliers((prev) => (prev.includes(data.id as string) ? prev : [...prev, data.id as string]));
      }
      onFeedback("ok", isFr ? `Fournisseur « ${data.name} » enregistré et sélectionné.` : `Saved "${data.name}" and selected for RFQ.`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAllExtractedSuppliers = async () => {
    if (extractedSuppliers.length === 0) return;
    setBusy(true);
    try {
      const newlySelected = new Set<string>(selectedSuppliers);
      let savedCount = 0;

      for (const cand of extractedSuppliers) {
        const existing = findSavedSupplier(cand);
        if (existing) {
          newlySelected.add(existing.id);
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
          const data = await readJsonSafe(res);
          if (typeof data.id === "string") {
            newlySelected.add(data.id);
            savedCount += 1;
          }
        }
      }
      setSelectedSuppliers(Array.from(newlySelected));
      onFeedback(
        "ok",
        isFr
          ? `${savedCount} nouveau(x) fournisseur(s) enregistré(s) · ${newlySelected.size} sélectionné(s).`
          : `Saved ${savedCount} new supplier(s) · ${newlySelected.size} selected.`
      );
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRfq = async () => {
    if (selectedSuppliers.length === 0) {
      onFeedback("error", isFr ? "Sélectionnez au moins un fournisseur avant de générer la DP." : "Select at least one supplier before generating an RFQ.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/rfqs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplier_ids: selectedSuppliers,
          response_deadline_days: Math.max(1, parseInt(rfqDeadlineDays, 10) || 5),
          lang: docLang,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de la génération de la DP" : "Failed to generate RFQ", res.status));
        return;
      }
      onFeedback(
        "ok",
        isFr
          ? `Demande de Prix ${data.rfq_code} créée (PDF & emails prêts).`
          : `Created ${data.rfq_code} (PDF & supplier emails ready).`
      );
      await onRefresh();
      if (typeof data.id === "string") {
        await handleLoadRfqEmails(data.id);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleLoadRfqEmails = async (rfqId: string) => {
    const res = await fetch(`/api/v1/rfqs/${rfqId}/emails?lang=${docLang}`, { cache: "no-store" });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      onFeedback("error", formatApiError(data, isFr ? "Impossible de charger les brouillons d'emails" : "Could not load email drafts", res.status));
      return;
    }
    setEmailDrafts((Array.isArray(data.drafts) ? data.drafts : []) as RfqEmailDraft[]);
    setSmtpConfigured(Boolean(data.smtp_configured));
    setActiveRfqIdForEmails(rfqId);
  };

  const handleSendRfqEmailsSmtp = async (rfqId: string, supplierIds: string[]) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/rfqs/${rfqId}/send-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_ids: supplierIds, confirm_human_review: true, lang: docLang }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de l'envoi SMTP" : "SMTP send failed", res.status));
        return;
      }
      const results = Array.isArray(data.results) ? (data.results as Array<{ message?: string }>) : [];
      const firstMsg = results[0]?.message || (isFr ? `${data.sent_count} email(s) envoyé(s).` : `Sent ${data.sent_count} email(s).`);
      onFeedback(Number(data.sent_count || 0) > 0 ? "ok" : "error", firstMsg);
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
        body: JSON.stringify({
          note: isFr ? "DP PDF et emails envoyés aux fournisseurs sélectionnés." : "Sent RFQ PDF and emails to selected suppliers.",
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de l'enregistrement d'envoi" : "Failed to record distribution", res.status));
        return;
      }
      onFeedback("ok", isFr ? "Envoi enregistré. Passez aux devis dès réception." : "Distribution recorded. Add supplier quotes in Stage 3.");
      await onRefresh();
      setStage(3);
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
        body: JSON.stringify({ supplier_ids: targetIds, replace_existing_demo_quotes: true, lang: docLang }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Impossible de générer les devis exemples" : "Could not generate example quotations", res.status));
        return;
      }
      onFeedback(
        "ok",
        isFr
          ? `${data.count} devis exemples (${data.currency_code}) avec PDF générés ! Cliquez sur « Comparer les devis ».`
          : `Generated ${data.count} example quote(s) (${data.currency_code}) with PDFs! Click "Compare Quotations" next.`
      );
      await onRefresh();
      setStage(3);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadQuoteFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    setExtractingFile(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/quotations/extract-upload`, {
        method: "POST",
        body: fd,
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de l'import du fichier" : "Document upload failed", res.status));
        return;
      }
      setQSourceFilename(String(data.filename || file.name));
      setShowQuoteForm(true);
      if (data.status === "extracted" && data.fields && typeof data.fields === "object") {
        const f = data.fields as Record<string, unknown>;
        if (typeof f.currency_code === "string") setQCurrency(f.currency_code);
        if (f.unit_price != null) setQUnitPrice(String(f.unit_price));
        setQFreight(f.freight_amount != null ? String(f.freight_amount) : "");
        setQTax(f.quoted_tax_amount != null ? String(f.quoted_tax_amount) : "");
        if (f.delivery_days != null) setQDelivery(String(f.delivery_days));
        if (f.warranty_months != null) setQWarranty(String(f.warranty_months));
        if (typeof f.payment_terms === "string") setQTerms(f.payment_terms);
        if (typeof f.offered_specs_summary === "string") setQOfferedSpecs(f.offered_specs_summary);
        setQExcerpt(typeof f.source_excerpt === "string" ? f.source_excerpt : "");
        onFeedback(
          "ok",
          isFr
            ? `Fichier « ${data.filename} » extrait via DeepSeek V4.1 Flash. Vérifiez les champs ci-dessous et enregistrez.`
            : `Extracted "${data.filename}" via DeepSeek V4.1 Flash. Verify the fields below and click Save.`
        );
      } else {
        setQExcerpt("");
        onFeedback("error", `${data.status || "Upload"}: ${data.message || (isFr ? "Vérification manuelle requise" : "Manual review needed")}`);
      }
      await onRefresh();
    } finally {
      input.value = "";
      setExtractingFile(false);
    }
  };

  const handleAddManualQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!qSupplierId || !qUnitPrice.trim()) {
      onFeedback(
        "error",
        isFr ? "Sélectionnez un fournisseur et indiquez le prix unitaire." : "Select a supplier and enter the unit price."
      );
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
          quantity: Math.max(1, parseInt(quantity, 10) || 1),
          unit_price: qUnitPrice.trim(),
          freight_amount: qFreight.trim() ? qFreight.trim() : null,
          quoted_tax_amount: qTax.trim() ? qTax.trim() : null,
          delivery_days: qDelivery.trim() ? parseInt(qDelivery, 10) : null,
          warranty_months: qWarranty.trim() ? parseInt(qWarranty, 10) : null,
          payment_terms: qTerms.trim() || "Net 30",
          meets_mandatory_specs: qMeetsSpecs,
          offered_specs_text: qOfferedSpecs.trim() || null,
          source_filename: qSourceFilename || null,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de l'enregistrement du devis" : "Failed to save quotation", res.status));
        return;
      }
      setQUnitPrice("");
      setQFreight("");
      setQTax("");
      setQDelivery("");
      setQOfferedSpecs("");
      setQSourceFilename("");
      setQExcerpt("");
      setShowQuoteForm(false);
      onFeedback("ok", isFr ? `Devis ${data.quote_code} enregistré (Rév. 1).` : `Saved quotation ${data.quote_code} (Rev 1).`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCorrection = async (quoteId: string) => {
    if (!corrReason.trim()) {
      onFeedback(
        "error",
        isFr ? "Veuillez indiquer la raison de cette correction (ex. email fournisseur)." : "Please enter a short reason for this correction."
      );
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de la correction" : "Failed to save correction", res.status));
        return;
      }
      setEditingQuoteId(null);
      setCorrSpecOverride("");
      setCorrReason("");
      onFeedback(
        "ok",
        isFr
          ? `Correction enregistrée → Révision ${data.revision_number}. Vous pouvez recalculer le comparatif.`
          : `Saved correction → Revision ${data.revision_number}. You can now recompute the comparison.`
      );
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const handleRunComparison = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/compare`, { method: "POST" });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec du comparatif" : "Comparison failed", res.status));
        return;
      }
      onFeedback(
        "ok",
        isFr
          ? `Comparatif v${data.version_number} calculé (${currency}) avec vérification des spécifications Jev.`
          : `Computed Comparison v${data.version_number} (${currency}) with Jev spec verification.`
      );
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Impossible de soumettre l'attribution" : "Could not submit award review", res.status));
        return;
      }
      onFeedback(
        "ok",
        isFr
          ? "Dossier d'attribution soumis pour approbation humaine (Point de contrôle 1/2)."
          : "Submitted Supplier Award for authorized approval (Checkpoint 1 of 2)."
      );
      setReviewChecked(false);
      await onRefresh();
      setStage(5);
    } finally {
      setBusy(false);
    }
  };

  const handleDecision = async (action: "approve" | "reject" | "request-changes") => {
    if (!workspace.pending_approval || !canCurrentActorApprove) return;
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Décision bloquée par la politique" : "Decision blocked", res.status));
        return;
      }
      setReviewChecked(false);
      setDecisionNote("");
      if (data.po_number) {
        onFeedback(
          "ok",
          isFr
            ? `Émission du BC approuvée ! Numéro ${data.po_number} attribué et PDF généré.`
            : `Final PO Release approved! Issued ${data.po_number} and generated Approved PO PDF.`
        );
      } else if (action === "approve") {
        onFeedback(
          "ok",
          isFr
            ? "Attribution approuvée ! Passez à l'Étape 6 pour préparer le Bon de Commande."
            : "Supplier Award approved! Prepare the Purchase Order in Stage 6."
        );
      } else {
        onFeedback("ok", isFr ? `Décision enregistrée : ${data.outcome}.` : `Decision recorded: ${data.outcome}.`);
      }
      await onRefresh();
      if (action === "approve") setStage(6);
      else if (action === "request-changes") setStage(1);
    } finally {
      setBusy(false);
    }
  };

  const handlePreparePoDraft = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/requests/${workspace.request.id}/po-draft`, { method: "POST" });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Impossible de préparer le BC" : "Failed to prepare PO draft", res.status));
        return;
      }
      onFeedback(
        "ok",
        isFr
          ? "Brouillon de BC créé et soumis pour validation finale (Point de contrôle 2/2)."
          : "Created immutable PO draft and submitted for Final PO Release approval (Checkpoint 2 of 2)."
      );
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
        body: JSON.stringify({ note: issueNote.trim() || "Issued externally" }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        onFeedback("error", formatApiError(data, isFr ? "Échec de l'enregistrement de l'envoi" : "Failed to record external issue", res.status));
        return;
      }
      onFeedback("ok", isFr ? `Envoi externe enregistré pour ${data.po_number}.` : `Recorded external issue for ${data.po_number}.`);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const recommendedOffer = workspace.latest_comparison?.result.offers.find((o) => o.is_recommended);
  const reactTrace = workspace.run?.projection?.react_trace || [];
  const demoQuoteCount =
    (selectedSuppliers.length > 0 ? selectedSuppliers.length : suppliers.length) >= 3
      ? 4
      : Math.max(1, selectedSuppliers.length || suppliers.length);

  return (
    <div className="space-y-4">
      {/* Slide-over PDF Preview Overlay (works cleanly from any scroll position) */}
      <PdfPreviewDrawer preview={preview} lang={lang} onClose={() => setPreview(null)} />

      {/* Active Case Header + Unified 6-Stage Progress Stepper */}
      <div className="rounded-lg border border-[#DEE4E9] bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#526170]">
              <span className="font-mono font-semibold text-[#285447]">{workspace.request.reference_code}</span>
              <span>·</span>
              <span>v{workspace.request.current_version}</span>
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
              <span className="rounded-full bg-[#EDF4F1] px-2.5 py-0.5 text-[11px] font-medium text-[#285447]">
                {formatStatusLabel(workspace.request.status, isFr)}
              </span>
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold text-[#1D2935]">{workspace.request.title}</h2>
          </div>

          {workspace.purchase_order?.po_number && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-[#EDF4F1] px-2.5 py-1.5 font-mono text-xs font-semibold text-[#285447]">
                {workspace.purchase_order.po_number}
              </span>
              {workspace.purchase_order.has_pdf && (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      setPreview({
                        url: `/api/v1/purchase-orders/${workspace.purchase_order!.id}/pdf?inline=1`,
                        title: workspace.purchase_order!.po_number || "PO",
                      })
                    }
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#285447] bg-white px-3 py-1.5 text-xs font-medium text-[#285447] hover:bg-[#EDF4F1]"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t(lang, "previewPdf")}
                  </button>
                  <a
                    href={`/api/v1/purchase-orders/${workspace.purchase_order.id}/pdf`}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t(lang, "downloadPdf")}
                  </a>
                </>
              )}
            </div>
          )}
        </div>

        {/* 6-Stage Progress Stepper */}
        <div className="mt-4 grid grid-cols-2 gap-2 border-t border-[#DEE4E9] pt-4 sm:grid-cols-3 lg:grid-cols-6">
          {STAGE_KEYS.map((k, idx) => {
            const num = idx + 1;
            const isActive = stage === num;
            const isDone = stageDone[idx];
            return (
              <button
                key={k}
                type="button"
                onClick={() => setStage(num)}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium transition ${
                  isActive
                    ? "border-[#285447] bg-[#285447] text-white shadow-xs"
                    : isDone
                    ? "border-[#CBE1D8] bg-[#EDF4F1]/70 text-[#285447] hover:bg-[#EDF4F1]"
                    : "border-[#DEE4E9] bg-[#F7F8FA] text-[#526170] hover:bg-white hover:text-[#1D2935]"
                }`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                    isActive
                      ? "bg-white text-[#285447]"
                      : isDone
                      ? "bg-[#285447] text-white"
                      : "bg-[#DEE4E9] text-[#526170]"
                  }`}
                >
                  {isDone && !isActive ? <Check className="h-3 w-3" /> : num}
                </span>
                <span className="truncate">{t(lang, k).replace(/^\d+\.\s*/, "")}</span>
              </button>
            );
          })}
        </div>

        {/* Guided 1-Line Next-Action Strip */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-[#F7F8FA] px-3.5 py-2 text-xs">
          <div className="flex items-center gap-2 text-[#1D2935]">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#285447]" />
            <span>{nextStepHint.text}</span>
          </div>
          {stage !== nextStepHint.targetStage && (
            <button
              type="button"
              onClick={() => setStage(nextStepHint.targetStage)}
              className="inline-flex shrink-0 items-center gap-1 rounded bg-[#285447] px-2.5 py-1 text-[11px] font-medium text-white hover:bg-[#1E4237]"
            >
              {nextStepHint.cta}
              <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* ================= STAGE 1: REQUEST DRAFT ================= */}
      {stage === 1 && (
        <div className="space-y-4">
          <div className="rounded-lg border border-[#DEE4E9] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DEE4E9] pb-3">
              <div>
                <h3 className="text-base font-semibold">
                  {isFr
                    ? `1. Vérifier & Confirmer la Demande d'Achat (v${workspace.request.current_version})`
                    : `1. Review & Confirm Purchase Request (v${workspace.request.current_version})`}
                </h3>
                <p className="text-xs text-[#526170]">
                  {isFr
                    ? "Modifiez librement les quantités, le budget, la devise (TND, EUR, USD...) et la ville avant de chercher les fournisseurs."
                    : "Adjust quantities, budget, currency (TND, EUR, USD...), and delivery city before sourcing suppliers."}
                </p>
              </div>
              {reactTrace.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowTrace((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md border border-[#DEE4E9] bg-[#F7F8FA] px-2.5 py-1.5 text-xs font-medium text-[#526170] hover:text-[#1D2935]"
                >
                  {showTrace ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  {showTrace ? t(lang, "hideAiTrace") : `${t(lang, "showAiTrace")} (${reactTrace.length})`}
                </button>
              )}
            </div>

            {workspace.latest_version?.missing_fields && workspace.latest_version.missing_fields.length > 0 && (
              <div className="mt-4 flex items-center gap-2 rounded-md border border-[#F5DFC4] bg-[#FEF6EC] p-3 text-xs text-[#9A5B13]">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <div>
                  <strong>{isFr ? "Informations recommandées manquantes :" : "Recommended missing details:"}</strong>{" "}
                  {workspace.latest_version.missing_fields.join(" · ")}
                </div>
              </div>
            )}

            <div className="mt-4 grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-[#526170]">
                  {isFr ? "Titre de la demande *" : "Request Title *"}
                </label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#526170]">
                  {isFr ? "Produit / Description *" : "Product / Item Description *"}
                </label>
                <input
                  value={itemSummary}
                  onChange={(e) => setItemSummary(e.target.value)}
                  className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#526170]">
                  {isFr ? "Ville / Pays de livraison" : "Delivery City / Country"}
                </label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Sousse, Tunisia"
                  className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#526170]">{isFr ? "Quantité" : "Quantity"}</label>
                  <input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">{isFr ? "Unité" : "Unit"}</label>
                  <input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">{isFr ? "Délai (j)" : "Deadline (d)"}</label>
                  <input
                    type="number"
                    min={1}
                    value={deliveryDays}
                    onChange={(e) => setDeliveryDays(e.target.value)}
                    placeholder="10"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-medium text-[#526170]">
                    {isFr ? "Budget plafond" : "Budget Cap"}
                  </label>
                  <input
                    value={budgetCap}
                    onChange={(e) => setBudgetCap(e.target.value)}
                    placeholder="25000.000"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm tabular-nums"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#526170]">{isFr ? "Devise" : "Currency"}</label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-sm"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-[#526170]">
                  {isFr
                    ? "Spécifications obligatoires (séparées par des virgules — vérifiées par Jev Router)"
                    : "Mandatory Specifications (comma-separated — verified by Jev Router)"}
                </label>
                <input
                  value={specsText}
                  onChange={(e) => setSpecsText(e.target.value)}
                  placeholder="Core i7, 16 GB RAM, 512 GB SSD"
                  className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 rounded-md border border-[#DEE4E9] bg-[#F7F8FA] p-3.5 sm:grid-cols-2 md:col-span-2">
                <div>
                  <label className="block text-xs font-medium text-[#526170]">{t(lang, "docLangLabel")}</label>
                  <select
                    value={docLang}
                    onChange={(e) => setDocLang(e.target.value as UiLang)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs"
                  >
                    <option value="fr">Français (Demande de Prix / Bon de Commande)</option>
                    <option value="en">English (RFQ / Purchase Order)</option>
                  </select>
                </div>
                <label
                  className={`flex cursor-pointer items-center gap-2 pt-5 text-xs ${
                    currency === "TND" ? "text-[#1D2935]" : "cursor-not-allowed text-[#526170] opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={currency !== "TND"}
                    checked={applyStamp && currency === "TND"}
                    onChange={(e) => setApplyStamp(e.target.checked)}
                    className="h-4 w-4 accent-[#285447]"
                  />
                  <span>{t(lang, "timbreFiscalLabel")}</span>
                </label>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#DEE4E9] pt-4">
              <button
                type="button"
                disabled={busy || !title.trim() || !itemSummary.trim()}
                onClick={() => void handleSaveRequest(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-4 py-2 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA] disabled:opacity-50"
              >
                <Edit3 className="h-3.5 w-3.5" />
                {t(lang, "saveDraft")}
              </button>
              <button
                type="button"
                disabled={busy || !title.trim() || !itemSummary.trim()}
                onClick={() => void handleSaveRequest(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
              >
                {t(lang, "confirmAndFindSuppliers")}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {showTrace && reactTrace.length > 0 && (
            <div className="rounded-lg border border-[#DEE4E9] bg-white p-5">
              <h4 className="text-sm font-semibold">
                {isFr ? "Trace de l'Agent d'Extraction (ReAct)" : "AI Intake Extraction Trace (ReAct)"}
              </h4>
              <ol className="mt-3 grid grid-cols-1 gap-2.5 text-xs md:grid-cols-2">
                {reactTrace.map((st) => (
                  <li key={st.step} className="rounded-md border border-[#DEE4E9] bg-[#F7F8FA] p-3">
                    <div className="font-medium text-[#285447]">
                      Step {st.step}/{st.max_steps} · <span className="font-mono">{st.action}</span>
                    </div>
                    <div className="mt-1 text-[#526170]">
                      <strong>{isFr ? "Réflexion :" : "Thought:"}</strong> {st.thought}
                    </div>
                    <div className="mt-0.5 text-[#526170]">
                      <strong>{isFr ? "Résultat :" : "Observation:"}</strong> {st.observation}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {/* ================= STAGE 2: SUPPLIERS & RFQ ================= */}
      {stage === 2 && (
        <div className="space-y-4">
          {/* Card 2A: Select Saved Suppliers + Collapsible Live Web Search */}
          <div className="rounded-lg border border-[#DEE4E9] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DEE4E9] pb-3">
              <div>
                <h3 className="text-base font-semibold">
                  {isFr
                    ? `2. Choisir les Fournisseurs (${selectedSuppliers.length}/${suppliers.length} sélectionnés)`
                    : `2. Choose Suppliers (${selectedSuppliers.length}/${suppliers.length} selected)`}
                </h3>
                <p className="text-xs text-[#526170]">
                  {isFr
                    ? "Cochez les fournisseurs à inviter pour la Demande de Prix, ou recherchez-en de nouveaux sur le web."
                    : "Check the suppliers you want to invite for RFQ, or search the web for more local vendors."}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {suppliers.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedSuppliers(
                        selectedSuppliers.length === suppliers.length ? [] : suppliers.map((s) => s.id)
                      )
                    }
                    className="rounded-md border border-[#DEE4E9] bg-white px-2.5 py-1.5 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
                  >
                    {selectedSuppliers.length === suppliers.length ? t(lang, "clearSelection") : t(lang, "selectAll")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowWebSearch((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#285447] bg-[#EDF4F1] px-3 py-1.5 text-xs font-medium text-[#285447] hover:bg-[#DDECE5]"
                >
                  <Globe className="h-3.5 w-3.5" />
                  {showWebSearch
                    ? isFr
                      ? "Masquer recherche web"
                      : "Hide Web Search"
                    : isFr
                    ? "Rechercher sur le Web (Tavily)"
                    : "Find More on Web (Tavily)"}
                </button>
              </div>
            </div>

            {/* Collapsible Live Web Search */}
            {showWebSearch && (
              <div className="mt-4 rounded-md border border-[#CBE1D8] bg-[#EDF4F1]/40 p-4">
                <div className="text-xs font-semibold text-[#285447]">
                  {isFr
                    ? "Recherche réelle sur le web (Tavily + DeepSeek V4.1 Flash)"
                    : "Live Web Supplier Search (Tavily + DeepSeek V4.1 Flash)"}
                </div>
                <form onSubmit={handleRealSupplierSearch} className="mt-2.5 grid grid-cols-1 gap-2 md:grid-cols-12">
                  <input
                    value={liveQuery}
                    onChange={(e) => setLiveQuery(e.target.value)}
                    placeholder={isFr ? "Produit (ex. pc portable Lenovo i7)" : "Product (e.g. Lenovo ThinkPad i7)"}
                    className="rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs md:col-span-5"
                  />
                  <input
                    value={liveLocation}
                    onChange={(e) => setLiveLocation(e.target.value)}
                    placeholder={isFr ? "Ville / Pays (ex. Sousse, Tunisie)" : "Location (e.g. Sousse, Tunisia)"}
                    className="rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs md:col-span-4"
                  />
                  <button
                    type="submit"
                    disabled={searchingReal || !liveQuery.trim()}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-[#285447] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50 md:col-span-3"
                  >
                    <Search className="h-3.5 w-3.5" />
                    {searchingReal
                      ? isFr
                        ? "Recherche..."
                        : "Searching..."
                      : isFr
                      ? "Chercher fournisseurs"
                      : "Search Suppliers"}
                  </button>
                </form>

                {extractedSuppliers.length > 0 && (
                  <div className="mt-3 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-[#1D2935]">
                        {isFr
                          ? `${extractedSuppliers.length} fournisseur(s) trouvé(s) sur le web :`
                          : `Found ${extractedSuppliers.length} web supplier lead(s):`}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleSaveAllExtractedSuppliers()}
                        className="inline-flex items-center gap-1 rounded bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t(lang, "saveAndSelectAll")} ({extractedSuppliers.length})
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                      {extractedSuppliers.map((cand) => {
                        const existing = findSavedSupplier(cand);
                        return (
                          <div
                            key={cand.website_url}
                            className="rounded-md border border-[#DEE4E9] bg-white p-3.5 text-xs"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <a
                                  href={cand.website_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 font-semibold text-[#285447] hover:underline"
                                >
                                  {cand.supplier_name}
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                                <div className="mt-0.5 text-[11px] text-[#526170]">{cand.location || liveLocation}</div>
                              </div>
                              {existing ? (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded bg-[#EDF4F1] px-2 py-0.5 text-[10px] font-semibold text-[#285447]">
                                  <Check className="h-3 w-3" />
                                  {t(lang, "savedBadge")}
                                </span>
                              ) : (
                                <span className="shrink-0 rounded bg-[#FEF6EC] px-2 py-0.5 text-[10px] font-medium text-[#9A5B13]">
                                  {isFr ? "Nouveau" : "New Lead"}
                                </span>
                              )}
                            </div>

                            {cand.matched_products.length > 0 && (
                              <ul className="mt-2 list-disc pl-4 text-[11px] text-[#526170]">
                                {cand.matched_products.slice(0, 3).map((mp, idx) => (
                                  <li key={idx}>{mp}</li>
                                ))}
                              </ul>
                            )}

                            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-[#526170]">
                              <span className="inline-flex items-center gap-1">
                                <Phone className="h-3 w-3" />
                                {cand.phone || (isFr ? "Tél. non publié" : "No phone listed")}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <Mail className="h-3 w-3" />
                                {cand.contact_email || (isFr ? "Email non publié" : "No email listed")}
                              </span>
                            </div>

                            {!existing && (
                              <div className="mt-2.5 flex gap-2">
                                <input
                                  value={manualEmailOverrides[cand.website_url] ?? cand.contact_email ?? ""}
                                  onChange={(e) =>
                                    setManualEmailOverrides((prev) => ({
                                      ...prev,
                                      [cand.website_url]: e.target.value,
                                    }))
                                  }
                                  placeholder={isFr ? "Email contact (optionnel)" : "Contact email (optional)"}
                                  className="min-w-0 flex-1 rounded border border-[#DEE4E9] px-2.5 py-1.5 text-xs"
                                />
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleSaveExtractedSupplier(cand)}
                                  className="inline-flex shrink-0 items-center gap-1 rounded bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                  {t(lang, "saveAndSelect")}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Saved Directory Checklist */}
            {suppliers.length === 0 ? (
              <div className="mt-4 rounded-md border border-dashed border-[#DEE4E9] bg-[#F7F8FA] p-6 text-center text-xs text-[#526170]">
                {isFr
                  ? "Aucun fournisseur dans votre annuaire. Utilisez la recherche web ci-dessus et cliquez sur « Enregistrer & Sélectionner »."
                  : "No suppliers in your directory yet. Use the web search above and click Save & Select."}
              </div>
            ) : (
              <div className="mt-4 divide-y divide-[#DEE4E9] rounded-md border border-[#DEE4E9]">
                {suppliers.map((s) => {
                  const checked = selectedSuppliers.includes(s.id);
                  return (
                    <label
                      key={s.id}
                      className={`flex cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-xs transition ${
                        checked ? "bg-[#EDF4F1]/50" : "hover:bg-[#F7F8FA]"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedSuppliers((prev) =>
                              e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id)
                            )
                          }
                          className="h-4 w-4 shrink-0 accent-[#285447]"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-[#1D2935]">{s.name}</div>
                          <div className="truncate text-[#526170]">
                            {s.contact_email || (isFr ? "Email non renseigné" : "No email")} ·{" "}
                            {s.location || s.category}
                          </div>
                        </div>
                      </div>
                      <span
                        className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
                          s.verification_status === "approved"
                            ? "bg-[#EDF4F1] text-[#285447]"
                            : "bg-[#FEF6EC] text-[#9A5B13]"
                        }`}
                      >
                        {s.verification_status === "approved"
                          ? isFr
                            ? "Vérifié"
                            : "Verified"
                          : isFr
                          ? "Non vérifié"
                          : "Unverified"}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {/* Primary RFQ Action Bar */}
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-[#DEE4E9] pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#526170]">
                    {isFr ? "Délai réponse (j)" : "Reply deadline (days)"}
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={rfqDeadlineDays}
                    onChange={(e) => setRfqDeadlineDays(e.target.value)}
                    className="mt-1 w-24 rounded-md border border-[#DEE4E9] px-3 py-2 text-xs tabular-nums"
                  />
                </div>
                <button
                  type="button"
                  disabled={busy || selectedSuppliers.length === 0}
                  onClick={() => void handleCreateRfq()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  <FileCheck2 className="h-4 w-4" />
                  {t(lang, "generateRfqBtn")}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setStage(3)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3.5 py-2 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
              >
                {t(lang, "goToQuotesBtn")}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Fast Demo Shortcut Strip */}
          {suppliers.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#F5DFC4] bg-[#FEF6EC] px-4 py-3 text-xs">
              <div className="text-[#9A5B13]">
                <strong>{isFr ? "Mode Démonstration Rapide :" : "Fast Demo Mode:"}</strong>{" "}
                {isFr
                  ? `Générez ${demoQuoteCount} devis réalistes avec PDF filigranés pour tester le comparatif Jev et l'approbation en 1 clic.`
                  : `Generate ${demoQuoteCount} realistic example quotes with watermarked PDFs to test Jev comparison & approval immediately.`}
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleGenerateExampleQuotes()}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-[#9A5B13] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#7D490E] disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t(lang, "generateDemoQuotesBtn")} ({demoQuoteCount})
              </button>
            </div>
          )}

          {/* Exported RFQs & Email Drafts */}
          {workspace.rfqs.length > 0 && (
            <div className="space-y-3 rounded-lg border border-[#DEE4E9] bg-white p-5">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[#526170]">
                {isFr ? "Demandes de Prix (DP) générées" : "Generated RFQs & Outreach Emails"}
              </h4>
              {workspace.rfqs.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[#DEE4E9] bg-[#F7F8FA] p-3 text-xs"
                >
                  <div>
                    <div className="font-mono font-semibold text-[#1D2935]">
                      {r.rfq_code} · v{r.request_version} ·{" "}
                      <span className="text-[#285447]">{formatStatusLabel(r.status, isFr)}</span>
                    </div>
                    <div className="mt-0.5 text-[#526170]">{r.supplier_names.join(", ")}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.has_pdf && (
                      <>
                        <button
                          type="button"
                          onClick={() => setPreview({ url: `/api/v1/rfqs/${r.id}/pdf?inline=1`, title: r.rfq_code })}
                          className="inline-flex items-center gap-1 rounded border border-[#285447] bg-[#EDF4F1] px-2.5 py-1.5 font-medium text-[#285447] hover:bg-[#DDECE5]"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {t(lang, "previewPdf")}
                        </button>
                        <a
                          href={`/api/v1/rfqs/${r.id}/pdf`}
                          className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 font-medium hover:bg-[#EDF4F1]"
                        >
                          <Download className="h-3.5 w-3.5" />
                          PDF
                        </a>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleLoadRfqEmails(r.id)}
                      className="inline-flex items-center gap-1 rounded border border-[#285447] bg-white px-2.5 py-1.5 font-medium text-[#285447] hover:bg-[#EDF4F1]"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      {isFr ? "Emails" : "Emails"}
                    </button>
                    {r.status !== "distribution_recorded" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleRecordDistribution(r.id)}
                        className="inline-flex items-center gap-1 rounded bg-[#285447] px-2.5 py-1.5 font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                      >
                        <Send className="h-3.5 w-3.5" />
                        {isFr ? "Marquer envoyé" : "Mark Sent"}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {emailDrafts.length > 0 && activeRfqIdForEmails && (
                <div className="space-y-3 rounded-md border border-[#CBE1D8] bg-[#EDF4F1]/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-[#285447]">
                      {isFr
                        ? `Brouillons d'emails prêts (${emailDrafts.length})`
                        : `Ready-to-Send RFQ Emails (${emailDrafts.length})`}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEmailDrafts([]);
                        setActiveRfqIdForEmails(null);
                      }}
                      className="text-xs text-[#526170] hover:text-[#1D2935]"
                    >
                      {t(lang, "closePreview")}
                    </button>
                  </div>
                  {emailDrafts.map((d) => (
                    <div key={d.supplier_id} className="rounded-md border border-[#DEE4E9] bg-white p-3.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="font-semibold text-[#1D2935]">{d.supplier_name}</div>
                          <div className="text-[#526170]">
                            {isFr ? "À :" : "To:"}{" "}
                            <strong>
                              {d.recipient_email || (isFr ? "Aucun email (ajoutez dans l'Annuaire)" : "No email on file")}
                            </strong>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {d.has_email && (
                            <a
                              href={d.mailto_url}
                              className="inline-flex items-center gap-1 rounded bg-[#285447] px-2.5 py-1.5 font-medium text-white hover:bg-[#1E4237]"
                            >
                              <Mail className="h-3.5 w-3.5" />
                              {isFr ? "Ouvrir Mail" : "Open Mail"}
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={async () => {
                              const ok = await copyTextSafely(`Subject: ${d.subject}\n\n${d.body}`);
                              onFeedback(
                                ok ? "ok" : "error",
                                ok
                                  ? isFr
                                    ? `Brouillon copié pour ${d.supplier_name}.`
                                    : `Copied email draft for ${d.supplier_name}.`
                                  : isFr
                                  ? "Échec de la copie."
                                  : "Could not copy to clipboard."
                              );
                            }}
                            className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 font-medium hover:bg-[#F7F8FA]"
                          >
                            <Copy className="h-3.5 w-3.5" />
                            {t(lang, "copy")}
                          </button>
                          {smtpConfigured && d.has_email && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleSendRfqEmailsSmtp(activeRfqIdForEmails, [d.supplier_id])}
                              className="inline-flex items-center gap-1 rounded border border-[#285447] bg-[#EDF4F1] px-2.5 py-1.5 font-medium text-[#285447]"
                            >
                              <Send className="h-3.5 w-3.5" />
                              SMTP (+PDF)
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 font-medium text-[#1D2935]">
                        {isFr ? "Objet :" : "Subject:"} {d.subject}
                      </div>
                      <pre className="mt-1.5 max-h-36 overflow-y-auto whitespace-pre-wrap rounded bg-[#F7F8FA] p-2.5 font-sans text-[11px] text-[#526170]">
                        {d.body}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ================= STAGE 3: QUOTATIONS ================= */}
      {stage === 3 && (
        <div className="space-y-4">
          {/* Top Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#DEE4E9] bg-white p-5">
            <div>
              <h3 className="text-base font-semibold">
                {isFr
                  ? `3. Devis Fournisseurs (${workspace.quotations.length})`
                  : `3. Supplier Quotations (${workspace.quotations.length})`}
              </h3>
              <p className="text-xs text-[#526170]">
                {isFr
                  ? "Importez un devis PDF/CSV, générez des exemples ou saisissez manuellement, puis lancez le comparatif."
                  : "Upload a quote PDF/CSV, generate example quotes, or enter one manually — then run the comparison."}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]">
                <Upload className="h-3.5 w-3.5 text-[#285447]" />
                {extractingFile ? t(lang, "extractingFile") : t(lang, "uploadQuoteBtn")}
                <input
                  type="file"
                  accept=".pdf,.csv,.txt"
                  onChange={(e) => void handleUploadQuoteFile(e)}
                  className="hidden"
                />
              </label>

              <button
                type="button"
                onClick={() => setShowQuoteForm((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
              >
                <Plus className="h-3.5 w-3.5" />
                {showQuoteForm ? t(lang, "closePreview") : t(lang, "enterQuoteManually")}
              </button>

              <button
                type="button"
                disabled={busy || suppliers.length === 0}
                onClick={() => void handleGenerateExampleQuotes()}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#F5DFC4] bg-[#FEF6EC] px-3 py-2 text-xs font-medium text-[#9A5B13] hover:bg-[#FDEBD2] disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {t(lang, "generateDemoQuotesBtn")}
              </button>

              <button
                type="button"
                disabled={busy || workspace.quotations.length === 0}
                onClick={() => void handleRunComparison()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
              >
                {t(lang, "runComparisonBtn")}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Collapsible Manual / Extracted Quote Form */}
          {showQuoteForm && (
            <form onSubmit={handleAddManualQuote} className="space-y-4 rounded-lg border border-[#285447]/35 bg-white p-5">
              <div className="flex items-center justify-between border-b border-[#DEE4E9] pb-2.5">
                <div>
                  <h4 className="text-sm font-semibold">
                    {qSourceFilename
                      ? `${isFr ? "Vérifier le devis extrait :" : "Confirm Extracted Quote:"} ${qSourceFilename}`
                      : isFr
                      ? "Saisir un devis fournisseur"
                      : "Enter Supplier Quotation"}
                  </h4>
                  <p className="text-xs text-[#526170]">
                    {isFr
                      ? "Laissez le transport ou la TVA vide si non mentionné (restera « Inconnu », jamais 0)."
                      : "Leave freight or tax blank if missing from the quote (stays Unknown, never coerced to 0)."}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowQuoteForm(false)}
                  className="rounded p-1 text-[#526170] hover:bg-[#F7F8FA]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {qExcerpt && (
                <div className="rounded border border-[#CBE1D8] bg-[#EDF4F1] p-3 text-xs text-[#285447]">
                  <strong>{isFr ? "Extrait source :" : "Source excerpt:"}</strong> &ldquo;{qExcerpt}&rdquo;
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2 md:grid-cols-4">
                <div className="sm:col-span-2">
                  <label className="block font-medium text-[#526170]">{isFr ? "Fournisseur *" : "Supplier *"}</label>
                  <select
                    value={qSupplierId}
                    onChange={(e) => setQSupplierId(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-2.5 py-2"
                  >
                    {suppliers.length === 0 && (
                      <option value="">{isFr ? "Ajoutez un fournisseur à l'Étape 2" : "Save a supplier in Stage 2 first"}</option>
                    )}
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">{isFr ? "Devise" : "Currency"}</label>
                  <select
                    value={qCurrency}
                    onChange={(e) => setQCurrency(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-2.5 py-2"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">
                    {isFr ? `Prix unitaire HT (${qCurrency}) *` : `Unit Price (${qCurrency}) *`}
                  </label>
                  <input
                    value={qUnitPrice}
                    onChange={(e) => setQUnitPrice(e.target.value)}
                    placeholder="1950.000"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">{isFr ? "Transport (optionnel)" : "Freight (optional)"}</label>
                  <input
                    value={qFreight}
                    onChange={(e) => setQFreight(e.target.value)}
                    placeholder={isFr ? "Vide = Inconnu" : "Blank = Unknown"}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">{isFr ? "TVA / Taxe (optionnel)" : "Tax / TVA (optional)"}</label>
                  <input
                    value={qTax}
                    onChange={(e) => setQTax(e.target.value)}
                    placeholder={isFr ? "Vide = Inconnue" : "Blank = Unknown"}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">{isFr ? "Livraison (jours)" : "Delivery (days)"}</label>
                  <input
                    type="number"
                    min={1}
                    value={qDelivery}
                    onChange={(e) => setQDelivery(e.target.value)}
                    placeholder="7"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">{isFr ? "Garantie (mois)" : "Warranty (mo.)"}</label>
                  <input
                    type="number"
                    min={0}
                    value={qWarranty}
                    onChange={(e) => setQWarranty(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2 tabular-nums"
                  />
                </div>
                <div>
                  <label className="block font-medium text-[#526170]">{isFr ? "Conditions paiement" : "Payment Terms"}</label>
                  <input
                    value={qTerms}
                    onChange={(e) => setQTerms(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2"
                  />
                </div>
                <div className="sm:col-span-3">
                  <label className="block font-medium text-[#526170]">
                    {isFr ? "Spécifications proposées dans le devis (optionnel)" : "Offered specs stated on quote (optional)"}
                  </label>
                  <input
                    value={qOfferedSpecs}
                    onChange={(e) => setQOfferedSpecs(e.target.value)}
                    placeholder="Intel Core i7-1355U, 16 GB RAM, 512 GB NVMe SSD"
                    className="mt-1 w-full rounded-md border border-[#DEE4E9] px-2.5 py-2"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#DEE4E9] pt-3 text-xs">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={qMeetsSpecs}
                    onChange={(e) => setQMeetsSpecs(e.target.checked)}
                    className="h-4 w-4 accent-[#285447]"
                  />
                  <span>{isFr ? "Conforme aux spécifications obligatoires" : "Meets mandatory specifications"}</span>
                </label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowQuoteForm(false)}
                    className="rounded-md border border-[#DEE4E9] px-3 py-2 font-medium text-[#526170] hover:bg-[#F7F8FA]"
                  >
                    {t(lang, "cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={busy || !qSupplierId || !qUnitPrice.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {isFr ? "Enregistrer le devis" : "Save Quotation"}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Friendly 3-Option Empty State when 0 quotes exist */}
          {workspace.quotations.length === 0 && !showQuoteForm ? (
            <div className="rounded-lg border border-dashed border-[#DEE4E9] bg-white p-8 text-center">
              <h4 className="text-sm font-semibold text-[#1D2935]">
                {isFr ? "Aucun devis enregistré pour cette demande" : "No quotations recorded yet"}
              </h4>
              <p className="mx-auto mt-1 max-w-md text-xs text-[#526170]">
                {isFr
                  ? "Choisissez la méthode la plus rapide pour ajouter vos offres fournisseurs :"
                  : "Choose the easiest way to add supplier offers for this request:"}
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  disabled={busy || suppliers.length === 0}
                  onClick={() => void handleGenerateExampleQuotes()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  <Sparkles className="h-4 w-4" />
                  {t(lang, "generateDemoQuotesBtn")}
                </button>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[#285447] bg-[#EDF4F1] px-4 py-2.5 text-xs font-medium text-[#285447] hover:bg-[#DDECE5]">
                  <Upload className="h-4 w-4" />
                  {t(lang, "uploadQuoteBtn")}
                  <input
                    type="file"
                    accept=".pdf,.csv,.txt"
                    onChange={(e) => void handleUploadQuoteFile(e)}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setShowQuoteForm(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-4 py-2.5 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
                >
                  <Plus className="h-4 w-4" />
                  {t(lang, "enterQuoteManually")}
                </button>
              </div>
              {suppliers.length === 0 && (
                <button
                  type="button"
                  onClick={() => setStage(2)}
                  className="mt-4 text-xs font-medium text-[#285447] hover:underline"
                >
                  {isFr ? "← Ajouter d'abord des fournisseurs à l'Étape 2" : "← First add suppliers in Stage 2"}
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {workspace.quotations.map((q) => (
                <div key={q.id} className="rounded-lg border border-[#DEE4E9] bg-white p-4 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-semibold text-[#1D2935]">{q.supplier_name}</span>
                        {q.is_demo_example && (
                          <span className="rounded bg-[#FEF6EC] px-1.5 py-0.5 text-[10px] font-semibold text-[#9A5B13]">
                            {isFr ? "Exemple Démo" : "Demo Example"}
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-[#526170]">
                        {q.quote_code} · Rev {q.revision_number}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {q.has_source_file && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setPreview({
                                url: `/api/v1/quotations/${q.id}/pdf?inline=1`,
                                title: `${q.supplier_name} · ${q.quote_code}`,
                              })
                            }
                            className="inline-flex items-center gap-1 rounded border border-[#285447] bg-[#EDF4F1] px-2 py-1 text-[11px] font-medium text-[#285447] hover:bg-[#DDECE5]"
                          >
                            <Eye className="h-3 w-3" />
                            {t(lang, "previewPdf")}
                          </button>
                          <a
                            href={`/api/v1/quotations/${q.id}/pdf`}
                            className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] bg-[#F7F8FA] px-2 py-1 text-[11px] font-medium text-[#1D2935] hover:bg-[#EDF4F1]"
                          >
                            <Download className="h-3 w-3" />
                            PDF
                          </a>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setEditingQuoteId(editingQuoteId === q.id ? null : q.id);
                          setCorrUnitPrice(q.unit_price);
                          setCorrFreight(q.freight_amount ?? "");
                          setCorrDelivery(q.delivery_days != null ? String(q.delivery_days) : "");
                          setCorrSpecOverride("");
                          setCorrReason("");
                        }}
                        className="rounded border border-[#DEE4E9] px-2 py-1 text-[11px] font-medium text-[#285447] hover:bg-[#EDF4F1]"
                      >
                        {editingQuoteId === q.id ? t(lang, "cancel") : t(lang, "editFields")}
                      </button>
                    </div>
                  </div>

                  {q.offered_specs_text && (
                    <p className="mt-2.5 rounded bg-[#F7F8FA] px-2.5 py-1.5 text-[11px] text-[#526170]">
                      <strong className="text-[#1D2935]">{isFr ? "Spécifications :" : "Offered specs:"}</strong>{" "}
                      {q.offered_specs_text}
                    </p>
                  )}

                  <dl className="mt-3 space-y-1.5 border-t border-[#DEE4E9] pt-2.5 tabular-nums">
                    <div className="flex justify-between">
                      <dt className="text-[#526170]">
                        {isFr ? "Prix unitaire" : "Unit price"} × {q.quantity}
                      </dt>
                      <dd className="font-medium">
                        {q.currency_code} {q.unit_price}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#526170]">{isFr ? "Transport" : "Freight"}</dt>
                      <dd className="font-medium">
                        {q.freight_amount !== null ? (
                          `${q.currency_code} ${q.freight_amount}`
                        ) : (
                          <span className="text-[#9A5B13]">{isFr ? "Inconnu" : "Unknown"}</span>
                        )}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-[#526170]">{isFr ? "TVA / Taxe" : "Tax / TVA"}</dt>
                      <dd className="font-medium">
                        {q.quoted_tax_amount !== null ? (
                          `${q.currency_code} ${q.quoted_tax_amount}`
                        ) : (
                          <span className="text-[#9A5B13]">{isFr ? "Inconnue" : "Unknown"}</span>
                        )}
                      </dd>
                    </div>
                    {q.fiscal_stamp_amount && Number(q.fiscal_stamp_amount) > 0 && (
                      <div className="flex justify-between">
                        <dt className="text-[#526170]">Timbre fiscal</dt>
                        <dd className="font-medium">
                          {q.currency_code} {q.fiscal_stamp_amount}
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <dt className="text-[#526170]">{isFr ? "Livraison" : "Delivery"}</dt>
                      <dd className="font-medium">
                        {q.delivery_days != null
                          ? `${q.delivery_days} ${isFr ? "jours" : "days"}`
                          : isFr
                          ? "Inconnu"
                          : "Unknown"}
                      </dd>
                    </div>
                  </dl>

                  {q.corrections && q.corrections.length > 0 && (
                    <div className="mt-3 rounded border border-[#CBE1D8] bg-[#EDF4F1]/50 p-2.5 text-[11px]">
                      <div className="font-semibold text-[#285447]">
                        {t(lang, "revisionHistory")} ({q.corrections.length})
                      </div>
                      <ul className="mt-1 space-y-1">
                        {q.corrections.slice(-3).map((c, cIdx) => (
                          <li key={cIdx} className="text-[#1D2935]">
                            <span className="font-mono text-[10px] text-[#526170]">{c.field}:</span>{" "}
                            <span className="text-[#9B1C1C] line-through">{c.old_value ?? "—"}</span> →{" "}
                            <span className="font-semibold text-[#285447]">{c.new_value ?? "—"}</span>
                            <div className="text-[10px] text-[#526170]">
                              {c.editor_name} · {c.reason}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {editingQuoteId === q.id && (
                    <div className="mt-3 space-y-2.5 rounded-md border border-[#285447]/30 bg-[#F7F8FA] p-3">
                      <div className="font-semibold text-[#1D2935]">
                        {isFr
                          ? `Modifier le devis (créera la Révision ${q.revision_number + 1})`
                          : `Correct fields (creates Revision ${q.revision_number + 1})`}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[10px] text-[#526170]">{isFr ? "Prix unit." : "Unit price"}</label>
                          <input
                            value={corrUnitPrice}
                            onChange={(e) => setCorrUnitPrice(e.target.value)}
                            className="mt-0.5 w-full rounded border border-[#DEE4E9] bg-white px-2 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-[#526170]">{isFr ? "Transport" : "Freight"}</label>
                          <input
                            value={corrFreight}
                            onChange={(e) => setCorrFreight(e.target.value)}
                            className="mt-0.5 w-full rounded border border-[#DEE4E9] bg-white px-2 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] text-[#526170]">{isFr ? "Délai (j)" : "Days"}</label>
                          <input
                            value={corrDelivery}
                            onChange={(e) => setCorrDelivery(e.target.value)}
                            className="mt-0.5 w-full rounded border border-[#DEE4E9] bg-white px-2 py-1 text-xs"
                          />
                        </div>
                      </div>
                      <select
                        value={corrSpecOverride}
                        onChange={(e) =>
                          setCorrSpecOverride(e.target.value as "" | "pass" | "needs_clarification" | "fail")
                        }
                        className="w-full rounded border border-[#DEE4E9] bg-white px-2 py-1.5 text-xs"
                      >
                        <option value="">
                          {isFr ? "Conserver le verdict spécifications actuel" : "Keep current spec verdict"}
                        </option>
                        <option value="pass">
                          {isFr ? "Valider spécifications → Conforme (Pass)" : "Override Specs → Pass (Verified)"}
                        </option>
                        <option value="needs_clarification">
                          {isFr ? "Marquer → Clarification requise" : "Override Specs → Needs Clarification"}
                        </option>
                        <option value="fail">
                          {isFr ? "Marquer → Non conforme (Fail)" : "Override Specs → Fail (Non-compliant)"}
                        </option>
                      </select>
                      <input
                        value={corrReason}
                        onChange={(e) => setCorrReason(e.target.value)}
                        placeholder={
                          isFr
                            ? "Raison de la correction (obligatoire, ex. confirmé par email)"
                            : "Reason / supplier evidence (required)"
                        }
                        className="w-full rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 text-xs"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingQuoteId(null)}
                          className="rounded border border-[#DEE4E9] bg-white px-3 py-1.5 text-xs font-medium text-[#526170]"
                        >
                          {t(lang, "cancel")}
                        </button>
                        <button
                          type="button"
                          disabled={busy || !corrReason.trim()}
                          onClick={() => void handleSaveCorrection(q.id)}
                          className="flex-1 rounded bg-[#285447] py-1.5 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                        >
                          {isFr
                            ? `Enregistrer (Rév. ${q.revision_number + 1})`
                            : `Save Correction (Rev ${q.revision_number + 1})`}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================= STAGE 4: COMPARISON ================= */}
      {stage === 4 && (
        <div className="space-y-4">
          {!workspace.latest_comparison ? (
            <div className="rounded-lg border border-dashed border-[#DEE4E9] bg-white p-8 text-center">
              <h3 className="text-sm font-semibold text-[#1D2935]">
                {isFr ? "Aucun comparatif calculé pour l'instant" : "No comparison computed yet"}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-xs text-[#526170]">
                {workspace.quotations.length > 0
                  ? isFr
                    ? `Vous avez ${workspace.quotations.length} devis prêt(s). Lancez le calcul déterministe Decimal + vérification Jev Router.`
                    : `You have ${workspace.quotations.length} quotation(s) ready. Run deterministic Decimal comparison + Jev Router spec verification now.`
                  : isFr
                  ? "Ajoutez ou générez d'abord des devis fournisseurs à l'Étape 3."
                  : "First add or generate supplier quotations in Stage 3."}
              </p>
              <div className="mt-4">
                {workspace.quotations.length > 0 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRunComparison()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    {t(lang, "runComparisonBtn")}
                    <ArrowRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStage(3)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237]"
                  >
                    {isFr ? "← Aller aux Devis (Étape 3)" : "← Go to Stage 3 Quotations"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Highlighted Recommendation Bar */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#CBE1D8] bg-[#EDF4F1] p-4 text-xs">
                <div className="max-w-2xl">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-[#285447]">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    {workspace.latest_comparison.result.recommended_supplier_name
                      ? `${isFr ? "Recommandé :" : "Recommended:"} ${workspace.latest_comparison.result.recommended_supplier_name}`
                      : isFr
                      ? "Aucun gagnant éligible"
                      : "No Eligible Winner"}
                  </div>
                  <p className="mt-1 text-[#1D2935]">{workspace.latest_comparison.explanation}</p>
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  {workspace.latest_comparison.result.recommended_budget_headroom && (
                    <div className="text-right">
                      <div className="text-[11px] text-[#526170]">{isFr ? "Marge budget" : "Budget headroom"}</div>
                      <div className="text-base font-semibold tabular-nums text-[#285447]">
                        {workspace.latest_comparison.result.request_summary.currency_code}{" "}
                        {workspace.latest_comparison.result.recommended_budget_headroom}
                      </div>
                    </div>
                  )}
                  {recommendedOffer && !workspace.pending_approval && !isAwardApproved && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleSubmitAward(recommendedOffer.quotation_id)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                    >
                      {t(lang, "submitAwardBtn")}
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Comparison Table */}
              <div className="overflow-x-auto rounded-lg border border-[#DEE4E9] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DEE4E9] px-5 py-3.5">
                  <div>
                    <h3 className="text-base font-semibold">
                      {isFr
                        ? `4. Matrice Comparative (v${workspace.latest_comparison.version_number})`
                        : `4. Comparison Matrix (v${workspace.latest_comparison.version_number})`}
                    </h3>
                    <p className="text-xs text-[#526170]">
                      {isFr
                        ? `Calcul Decimal exact (${workspace.latest_comparison.result.request_summary.currency_code}) · Éligibilité vérifiée avant classement.`
                        : `Exact Decimal math (${workspace.latest_comparison.result.request_summary.currency_code}) · Eligibility verified before ranking.`}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleRunComparison()}
                    className="rounded-md border border-[#DEE4E9] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[#F7F8FA] disabled:opacity-50"
                  >
                    {t(lang, "recomputeBtn")}
                  </button>
                </div>

                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[#DEE4E9]">
                    <tr>
                      <th className="w-44 bg-[#F7F8FA] px-4 py-3 text-xs font-medium text-[#526170]">
                        {isFr ? "Critère" : "Field"}
                      </th>
                      {workspace.latest_comparison.result.offers.map((o) => {
                        const matchQuote = workspace.quotations.find((qt) => qt.id === o.quotation_id);
                        return (
                          <th
                            key={o.quotation_id}
                            className={`min-w-[200px] border-l border-[#DEE4E9] px-4 py-3 align-top ${
                              o.is_recommended ? "bg-[#EDF4F1]/70" : "bg-white"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <div className="text-sm font-semibold">{o.supplier_name}</div>
                                <div className="font-mono text-[11px] font-normal text-[#526170]">
                                  {o.quote_code} · Rev {o.revision_number}
                                </div>
                              </div>
                              {matchQuote?.has_source_file && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setPreview({
                                      url: `/api/v1/quotations/${o.quotation_id}/pdf?inline=1`,
                                      title: `${o.supplier_name} · ${o.quote_code}`,
                                    })
                                  }
                                  className="inline-flex shrink-0 items-center gap-1 rounded border border-[#DEE4E9] bg-white px-2 py-0.5 text-[10px] font-medium text-[#285447] hover:bg-[#EDF4F1]"
                                >
                                  <Eye className="h-3 w-3" />
                                  PDF
                                </button>
                              )}
                            </div>
                            <div className="mt-2">
                              {o.is_recommended ? (
                                <span className="inline-flex items-center gap-1 rounded bg-[#285447] px-2 py-0.5 text-[10px] font-semibold text-white">
                                  <CheckCircle2 className="h-3 w-3" />
                                  {isFr ? "Meilleur total éligible" : "Lowest eligible total"}
                                </span>
                              ) : o.eligibility === "eligible" ? (
                                <span className="rounded bg-[#EEF2F6] px-2 py-0.5 text-[10px] font-medium text-[#1D2935]">
                                  {isFr ? "Éligible" : "Eligible"}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded bg-[#FEF6EC] px-2 py-0.5 text-[10px] font-medium text-[#9A5B13]">
                                  <AlertTriangle className="h-3 w-3 shrink-0" />
                                  {o.failure_reasons[0] || o.eligibility}
                                </span>
                              )}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-[#DEE4E9] text-xs tabular-nums">
                    <tr>
                      <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">
                        {isFr ? "Prix unitaire HT" : "Unit price"}
                      </td>
                      {workspace.latest_comparison.result.offers.map((o) => (
                        <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">
                          {o.currency_code} {o.unit_price}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">
                        {isFr ? "Sous-total HT" : "Item subtotal"} (×
                        {workspace.latest_comparison.result.request_summary.quantity})
                      </td>
                      {workspace.latest_comparison.result.offers.map((o) => (
                        <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">
                          {o.currency_code} {o.item_subtotal}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">
                        {isFr ? "Transport" : "Freight"}
                      </td>
                      {workspace.latest_comparison.result.offers.map((o) => (
                        <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">
                          {o.freight_amount !== null ? (
                            `${o.currency_code} ${o.freight_amount}`
                          ) : (
                            <span className="text-[#9A5B13]">{isFr ? "Inconnu" : "Unknown"}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">
                        {isFr ? "TVA / Taxes" : "Tax / TVA"}
                      </td>
                      {workspace.latest_comparison.result.offers.map((o) => (
                        <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">
                          {o.quoted_tax_amount !== null ? (
                            `${o.currency_code} ${o.quoted_tax_amount}`
                          ) : (
                            <span className="text-[#9A5B13]">{isFr ? "Inconnue" : "Unknown"}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                    {workspace.latest_comparison.result.request_summary.apply_fiscal_stamp && (
                      <tr>
                        <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">
                          {isFr ? "Timbre fiscal" : "Timbre Fiscal"}
                        </td>
                        {workspace.latest_comparison.result.offers.map((o) => (
                          <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">
                            {o.currency_code} {o.fiscal_stamp_amount ?? "1.000"}
                          </td>
                        ))}
                      </tr>
                    )}
                    <tr className="bg-[#F7F8FA]/80 font-semibold">
                      <td className="px-4 py-3">{isFr ? "Coût total TTC" : "Total quoted cost"}</td>
                      {workspace.latest_comparison.result.offers.map((o) => (
                        <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-3 text-sm">
                          {o.total_quoted_cost !== null ? (
                            `${o.currency_code} ${o.total_quoted_cost}`
                          ) : (
                            <span className="text-[#9A5B13]">{isFr ? "Incomplet" : "Incomplete"}</span>
                          )}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="bg-[#F7F8FA] px-4 py-2.5 font-medium text-[#526170]">
                        {isFr ? "Délai de livraison" : "Delivery"}
                      </td>
                      {workspace.latest_comparison.result.offers.map((o) => (
                        <td key={o.quotation_id} className="border-l border-[#DEE4E9] px-4 py-2.5">
                          {o.delivery_days != null
                            ? `${o.delivery_days} ${isFr ? "jours" : "days"}`
                            : isFr
                            ? "Inconnu"
                            : "Unknown"}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="bg-[#F7F8FA] px-4 py-2.5 align-top font-medium text-[#526170]">
                        <div>{isFr ? "Spécifications" : "Mandatory specs"}</div>
                        <div className="mt-0.5 text-[10px] font-normal text-[#285447]">
                          {isFr ? "Vérifié par Jev Router" : "Jev Router verified"}
                        </div>
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
                                    {isFr ? "Validation humaine" : "Human override"} ({sv.human_override.editor_name})
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
                                setCorrReason("");
                                setStage(3);
                              }}
                              className="w-full rounded-md border border-[#F5DFC4] bg-[#FEF6EC] px-3 py-2 text-xs font-medium text-[#9A5B13] hover:bg-[#FDEBD2]"
                            >
                              {t(lang, "clarifyInStage3")} →
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy || o.eligibility !== "eligible"}
                              onClick={() => void handleSubmitAward(o.quotation_id)}
                              className="w-full rounded-md bg-[#285447] px-3 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:bg-[#D5DFE4] disabled:text-[#526170]"
                            >
                              {o.eligibility === "eligible" ? t(lang, "submitAwardBtn") : t(lang, "ineligibleBlocked")}
                            </button>
                          )}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================= STAGE 5: APPROVALS ================= */}
      {stage === 5 && (
        <div className="space-y-4">
          {!workspace.pending_approval ? (
            <div className="rounded-lg border border-dashed border-[#DEE4E9] bg-white p-8 text-center">
              <h3 className="text-sm font-semibold text-[#1D2935]">
                {workspace.purchase_order?.po_number
                  ? isFr
                    ? `Toutes les approbations sont terminées (${workspace.purchase_order.po_number})`
                    : `All approvals completed (${workspace.purchase_order.po_number})`
                  : isAwardApproved
                  ? isFr
                    ? "Attribution approuvée ! Prêt pour le Bon de Commande"
                    : "Supplier Award Approved! Ready to prepare Purchase Order"
                  : isFr
                  ? "Aucune demande d'approbation en attente"
                  : "No pending approval on this request"}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-xs text-[#526170]">
                {workspace.purchase_order?.po_number
                  ? isFr
                    ? "Téléchargez ou prévisualisez le Bon de Commande PDF numéroté à l'Étape 6."
                    : "Preview or download your numbered Purchase Order PDF in Stage 6."
                  : isAwardApproved
                  ? isFr
                    ? "Passez à l'Étape 6 pour générer le brouillon du Bon de Commande et demander sa validation finale."
                    : "Go to Stage 6 to generate the PO draft and request Final PO Release approval."
                  : isFr
                  ? "Sélectionnez d'abord une offre éligible dans le comparatif (Étape 4) puis cliquez sur « Soumettre pour approbation »."
                  : "First select an eligible quote in Stage 4 Comparison and click Submit Award for Approval."}
              </p>
              <div className="mt-4">
                {workspace.purchase_order?.po_number || isAwardApproved ? (
                  <button
                    type="button"
                    onClick={() => setStage(6)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237]"
                  >
                    {isFr ? "Aller au Bon de Commande (Étape 6)" : "Go to Stage 6 Approved PO"}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStage(workspace.latest_comparison ? 4 : 3)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237]"
                  >
                    {workspace.latest_comparison
                      ? isFr
                        ? "← Aller au Comparatif (Étape 4)"
                        : "← Go to Stage 4 Comparison"
                      : isFr
                      ? "← Aller aux Devis (Étape 3)"
                      : "← Go to Stage 3 Quotations"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
              <div className="space-y-4 rounded-lg border border-[#DEE4E9] bg-white p-5 lg:col-span-7">
                <div className="border-b border-[#DEE4E9] pb-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-[#285447]">
                    {workspace.pending_approval.decision_type === "po_release"
                      ? isFr
                        ? "Point de contrôle 2/2 · Émission finale du Bon de Commande"
                        : "Checkpoint 2 of 2 · Final Purchase Order Release"
                      : isFr
                      ? "Point de contrôle 1/2 · Approbation d'attribution fournisseur"
                      : "Checkpoint 1 of 2 · Supplier Award Approval"}
                  </div>
                  <h3 className="mt-1 text-lg font-semibold">
                    {String(workspace.pending_approval.packet.supplier_name || workspace.request.title)}
                  </h3>
                </div>

                <div className="grid grid-cols-1 divide-y divide-[#DEE4E9] rounded-md border border-[#DEE4E9] bg-[#F7F8FA] text-xs sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                  <div className="p-3">
                    <div className="text-[#526170]">{isFr ? "Montant total TTC" : "Total approved amount"}</div>
                    <div className="mt-0.5 text-base font-semibold tabular-nums text-[#285447]">
                      {workspace.pending_approval.currency_code} {workspace.pending_approval.amount}
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-[#526170]">{isFr ? "Livraison" : "Delivery"}</div>
                    <div className="mt-0.5 text-base font-semibold">
                      {String(workspace.pending_approval.packet.delivery_days ?? "—")} {isFr ? "jours" : "days"}
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="text-[#526170]">{isFr ? "Paiement / Garantie" : "Payment / Warranty"}</div>
                    <div className="mt-0.5 text-sm font-semibold">
                      {String(workspace.pending_approval.packet.payment_terms ?? "Net 30")} ·{" "}
                      {String(workspace.pending_approval.packet.warranty_months ?? "—")}m
                    </div>
                  </div>
                </div>

                <div className="rounded-md bg-[#F7F8FA] p-2.5 font-mono text-[11px] text-[#526170] break-all">
                  {isFr ? "Empreinte canonique SHA-256 :" : "Canonical Payload Hash:"}{" "}
                  {workspace.pending_approval.payload_hash}
                </div>
              </div>

              <div className="rounded-lg border border-[#DEE4E9] bg-white p-5 lg:col-span-5">
                <h3 className="text-base font-semibold">{isFr ? "Votre Décision" : "Your Decision"}</h3>
                <div className="mt-3 space-y-4">
                  {canCurrentActorApprove ? (
                    <div className="flex items-start gap-2 rounded-md bg-[#EDF4F1] p-3 text-xs text-[#285447]">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                      <div>
                        <div className="font-semibold">
                          {isFr ? "Vous êtes approbateur autorisé" : "You are an assigned approver"}
                        </div>
                        <div>
                          {actor?.display_name} · {isFr ? "Plafond" : "Limit"} ${actor?.approval_limit_usd} USD
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3 rounded-md border border-[#F5DFC4] bg-[#FEF6EC] p-3.5 text-xs text-[#9A5B13]">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          <div className="font-semibold">
                            {isFr ? "Séparation des tâches requise" : "Separation of Duties Required"}
                          </div>
                          <p className="mt-0.5">
                            {isFr
                              ? `Connecté en tant que ${actor?.display_name}. Un approbateur différent du demandeur doit valider ce dossier.`
                              : `Signed in as ${actor?.display_name}. Switch to an assigned approver to unlock decision buttons.`}
                          </p>
                        </div>
                      </div>
                      {devAuthEnabled && sameTenantApproverPersona && (
                        <button
                          type="button"
                          onClick={() => void onSwitchPersona(sameTenantApproverPersona.id)}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-[#285447] px-3 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237]"
                        >
                          <UserCheck className="h-4 w-4" />
                          {isFr
                            ? `Basculer vers ${sameTenantApproverPersona.display_name} (Approbateur)`
                            : `Switch to ${sameTenantApproverPersona.display_name} (Approver)`}
                        </button>
                      )}
                    </div>
                  )}

                  <textarea
                    rows={2}
                    disabled={!canCurrentActorApprove}
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    placeholder={isFr ? "Note de décision (optionnelle)..." : "Decision note (optional)..."}
                    className="w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-xs disabled:bg-[#F7F8FA] disabled:opacity-60"
                  />

                  <label
                    className={`flex items-start gap-2 text-xs ${
                      canCurrentActorApprove ? "cursor-pointer" : "cursor-not-allowed opacity-60"
                    }`}
                  >
                    <input
                      type="checkbox"
                      disabled={!canCurrentActorApprove}
                      checked={reviewChecked}
                      onChange={(e) => setReviewChecked(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-[#285447]"
                    />
                    <span>
                      {isFr
                        ? "J'ai vérifié le devis, les spécifications et les conditions commerciales."
                        : "I have reviewed the quotation, mandatory specs, and commercial terms."}
                    </span>
                  </label>

                  <button
                    type="button"
                    disabled={busy || !canCurrentActorApprove || !reviewChecked}
                    onClick={() => void handleDecision("approve")}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-[#285447] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#1E4237] disabled:bg-[#A6B8B2] disabled:cursor-not-allowed"
                  >
                    <Lock className="h-4 w-4" />
                    {workspace.pending_approval.decision_type === "po_release"
                      ? t(lang, "approvePoReleaseBtn")
                      : t(lang, "approveAwardBtn")}
                  </button>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={busy || !canCurrentActorApprove}
                      onClick={() => void handleDecision("request-changes")}
                      className="rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-xs font-medium hover:bg-[#F7F8FA] disabled:opacity-50"
                    >
                      {t(lang, "requestChangesBtn")}
                    </button>
                    <button
                      type="button"
                      disabled={busy || !canCurrentActorApprove}
                      onClick={() => void handleDecision("reject")}
                      className="inline-flex items-center justify-center gap-1 rounded-md border border-[#F3C5C5] bg-white px-3 py-2 text-xs font-medium text-[#9B1C1C] hover:bg-[#FDF2F2] disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      {t(lang, "rejectBtn")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Decision Audit History */}
          {workspace.decisions.length > 0 && (
            <div className="rounded-lg border border-[#DEE4E9] bg-white p-4 text-xs">
              <div className="font-semibold text-[#1D2935]">
                {isFr ? "Historique des décisions approuvées" : "Recorded Approval Decisions"}
              </div>
              <div className="mt-2 divide-y divide-[#DEE4E9]">
                {workspace.decisions.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          d.outcome === "approved"
                            ? "bg-[#EDF4F1] text-[#285447]"
                            : "bg-[#FDF2F2] text-[#9B1C1C]"
                        }`}
                      >
                        {d.outcome}
                      </span>
                      <span className="font-medium text-[#1D2935]">
                        {d.decision_type === "po_release"
                          ? isFr
                            ? "Émission BC (2/2)"
                            : "PO Release (2/2)"
                          : isFr
                          ? "Attribution fournisseur (1/2)"
                          : "Supplier Award (1/2)"}
                      </span>
                      {d.note && <span className="text-[#526170]">· &ldquo;{d.note}&rdquo;</span>}
                    </div>
                    <span className="font-mono text-[11px] text-[#526170]">
                      {new Date(d.decided_at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ================= STAGE 6: APPROVED PO ================= */}
      {stage === 6 && (
        <div className="rounded-lg border border-[#DEE4E9] bg-white p-6">
          {!workspace.purchase_order ? (
            !isAwardApproved ? (
              <div className="py-4 text-center">
                <h3 className="text-sm font-semibold text-[#1D2935]">
                  {isFr
                    ? "Approuvez d'abord l'attribution fournisseur avant de créer le Bon de Commande"
                    : "Approve a Supplier Award first before creating the Purchase Order"}
                </h3>
                <p className="mx-auto mt-1 max-w-md text-xs text-[#526170]">
                  {workspace.pending_approval
                    ? isFr
                      ? "Une demande d'approbation est prête à l'Étape 5."
                      : "A Supplier Award approval packet is waiting for decision in Stage 5."
                    : isFr
                    ? "Comparez les devis à l'Étape 4 et soumettez le fournisseur retenu pour approbation."
                    : "Compare quotes in Stage 4 and submit the winning supplier for approval."}
                </p>
                <div className="mt-4">
                  <button
                    type="button"
                    onClick={() => setStage(workspace.pending_approval ? 5 : workspace.latest_comparison ? 4 : 3)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237]"
                  >
                    {workspace.pending_approval
                      ? isFr
                        ? "Aller aux Approbations (Étape 5)"
                        : "Go to Stage 5 Approvals"
                      : workspace.latest_comparison
                      ? isFr
                        ? "Aller au Comparatif (Étape 4)"
                        : "Go to Stage 4 Comparison"
                      : isFr
                      ? "Aller aux Devis (Étape 3)"
                      : "Go to Stage 3 Quotations"}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <h3 className="text-base font-semibold">
                  {isFr
                    ? "6. Préparer le Bon de Commande à partir de l'attribution approuvée"
                    : "6. Prepare Purchase Order from Approved Award"}
                </h3>
                <p className="text-xs text-[#526170]">
                  {isFr
                    ? "Crée un brouillon de BC immuable et ouvre le Point de contrôle 2/2 (Approbation d'émission finale) qui attribuera un numéro unique."
                    : "Creates an immutable PO draft and opens Checkpoint 2 of 2 (Final PO Release Approval) to assign a unique PO number."}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handlePreparePoDraft()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  <FileCheck2 className="h-4 w-4" />
                  {t(lang, "preparePoBtn")}
                </button>
              </div>
            )
          ) : !workspace.purchase_order.po_number ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[#FEF6EC] px-2.5 py-0.5 text-xs font-semibold text-[#9A5B13]">
                  {isFr ? "Point de contrôle 2/2 en attente" : "Checkpoint 2 of 2 Pending"}
                </span>
              </div>
              <h3 className="text-base font-semibold">
                {isFr
                  ? "Brouillon de Bon de Commande créé — en attente de validation finale"
                  : "PO Draft Created — Awaiting Final PO Release Approval"}
              </h3>
              <p className="text-xs text-[#526170]">
                {isFr
                  ? `Fournisseur : ${workspace.purchase_order.supplier_name} · Total : ${workspace.purchase_order.currency_code} ${workspace.purchase_order.total_amount}. Validez le dossier à l'Étape 5 pour générer le numéro de BC et le PDF officiel.`
                  : `Supplier: ${workspace.purchase_order.supplier_name} · Total: ${workspace.purchase_order.currency_code} ${workspace.purchase_order.total_amount}. Approve Final PO Release in Stage 5 to issue the PO number and official PDF.`}
              </p>
              <button
                type="button"
                onClick={() => setStage(5)}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237]"
              >
                {isFr ? "Approuver l'émission finale (Étape 5)" : "Approve Final PO Release (Stage 5)"}
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#DEE4E9] pb-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-mono text-2xl font-semibold text-[#285447]">
                      {workspace.purchase_order.po_number}
                    </h3>
                    <span className="rounded-full bg-[#EDF4F1] px-2.5 py-0.5 text-xs font-semibold text-[#285447]">
                      {formatStatusLabel(workspace.purchase_order.status, isFr)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#526170]">
                    {isFr ? "Fournisseur :" : "Supplier:"}{" "}
                    <strong className="text-[#1D2935]">{workspace.purchase_order.supplier_name}</strong> · Total:{" "}
                    <strong className="tabular-nums text-[#1D2935]">
                      {workspace.purchase_order.currency_code} {workspace.purchase_order.total_amount}
                    </strong>
                  </p>
                  {workspace.purchase_order.pdf_sha256 && (
                    <div className="mt-1 font-mono text-[11px] text-[#526170]">
                      PDF SHA-256: {workspace.purchase_order.pdf_sha256.slice(0, 24)}...
                    </div>
                  )}
                </div>

                {workspace.purchase_order.has_pdf && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setPreview({
                          url: `/api/v1/purchase-orders/${workspace.purchase_order!.id}/pdf?inline=1`,
                          title: workspace.purchase_order!.po_number || "PO",
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#285447] bg-[#EDF4F1] px-3.5 py-2.5 text-xs font-semibold text-[#285447] hover:bg-[#DDECE5]"
                    >
                      <Eye className="h-4 w-4" />
                      {t(lang, "previewPdf")}
                    </button>
                    <a
                      href={`/api/v1/purchase-orders/${workspace.purchase_order.id}/pdf`}
                      className="inline-flex items-center gap-2 rounded-md bg-[#285447] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E4237]"
                    >
                      <Download className="h-4 w-4" />
                      {t(lang, "downloadApprovedPo")}
                    </a>
                  </div>
                )}
              </div>

              {workspace.purchase_order.status === "approved_ready_for_issue" ? (
                <div className="space-y-2 text-xs">
                  <div className="font-medium text-[#1D2935]">
                    {isFr ? "Enregistrer l'envoi externe au fournisseur" : "Record external dispatch to supplier"}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={issueNote}
                      onChange={(e) => setIssueNote(e.target.value)}
                      className="min-w-[240px] flex-1 rounded-md border border-[#DEE4E9] px-3 py-2"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRecordExternalIssue(workspace.purchase_order!.id)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                    >
                      <Send className="h-3.5 w-3.5" />
                      {t(lang, "recordExternalIssue")}
                    </button>
                  </div>
                </div>
              ) : (
                workspace.purchase_order.externally_issued_at && (
                  <div className="flex items-center gap-2 rounded-md bg-[#EDF4F1] px-3.5 py-2.5 text-xs text-[#285447]">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>
                      {isFr ? "Envoyé au fournisseur le" : "Issued externally on"}{" "}
                      {new Date(workspace.purchase_order.externally_issued_at).toLocaleString()}
                      {workspace.purchase_order.external_issue_note
                        ? ` — ${workspace.purchase_order.external_issue_note}`
                        : ""}
                    </span>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
