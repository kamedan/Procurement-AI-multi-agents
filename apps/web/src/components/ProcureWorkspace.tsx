"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Languages,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import AgentsActivityView from "./AgentsActivityView";
import CaseFlowView from "./CaseFlowView";
import { t, type UiLang } from "@/lib/i18n";
import type {
  Actor,
  AgentsActivityData,
  CopilotAction,
  EvalSuiteReport,
  ExternalLead,
  OverviewSummary,
  Persona,
  RunSummary,
  SupplierItem,
  TenantSettings,
  UsageSummary,
  WorkspaceData,
} from "./types";

function StatusBadge({ status, lang }: { status: string; lang: UiLang }) {
  const isFr = lang === "fr";
  const styles: Record<string, { bg: string; text: string; label: string }> = {
    running: { bg: "bg-[#EEF2F6]", text: "text-[#1D2935]", label: isFr ? "En cours" : "Running" },
    waiting_for_approval: {
      bg: "bg-[#FEF6EC]",
      text: "text-[#9A5B13]",
      label: isFr ? "En attente d'approbation" : "Awaiting approval",
    },
    waiting_for_input: {
      bg: "bg-[#EEF2F6]",
      text: "text-[#1D2935]",
      label: isFr ? "En préparation" : "In progress",
    },
    completed: { bg: "bg-[#EDF4F1]", text: "text-[#285447]", label: isFr ? "Terminé" : "Completed" },
    failed: { bg: "bg-[#FDF2F2]", text: "text-[#9B1C1C]", label: isFr ? "Échec" : "Failed" },
  };
  const cfg = styles[status] ?? { bg: "bg-[#F3F4F6]", text: "text-[#526170]", label: status };
  return (
    <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${cfg.bg} ${cfg.text}`}>
      <Clock className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

interface CopilotMsg {
  role: "user" | "assistant";
  text: string;
  action?: CopilotAction | null;
  emailDraft?: { subject: string; body: string } | null;
}

export default function ProcureWorkspace() {
  const [lang, setLang] = useState<UiLang>("en");
  const [actor, setActor] = useState<Actor | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [devAuthEnabled, setDevAuthEnabled] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [overview, setOverview] = useState<OverviewSummary | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierItem[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [workspaceData, setWorkspaceData] = useState<WorkspaceData | null>(null);
  const [agentsData, setAgentsData] = useState<AgentsActivityData | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [evalReport, setEvalReport] = useState<EvalSuiteReport | null>(null);
  const [runningLiveEval, setRunningLiveEval] = useState(false);
  const [tenantSettings, setTenantSettings] = useState<TenantSettings | null>(null);

  // Company profile editable state
  const [profName, setProfName] = useState("");
  const [profLocation, setProfLocation] = useState("");
  const [profCurrency, setProfCurrency] = useState("TND");
  const [profDocLang, setProfDocLang] = useState<UiLang>("fr");
  const [savingProfile, setSavingProfile] = useState(false);

  const [promptInput, setPromptInput] = useState(
    "We need 10 business laptops in Sousse, Tunisia, budget 25000 TND, delivered within 10 days."
  );
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [activeNav, setActiveNav] = useState<"overview" | "suppliers" | "agents" | "usage" | "settings">("overview");
  const [guideOpen, setGuideOpen] = useState(true);

  // Stage jump & Copilot draft prefill bridge into CaseFlowView
  const [stageJump, setStageJump] = useState<{ stage: number; seq: number } | null>(null);
  const [draftPrefill, setDraftPrefill] = useState<{
    patch: NonNullable<CopilotAction["draft_patch"]>;
    seq: number;
  } | null>(null);

  // Suppliers tab state
  const [newSupName, setNewSupName] = useState("");
  const [newSupCategory, setNewSupCategory] = useState("IT Hardware");
  const [newSupEmail, setNewSupEmail] = useState("");
  const [csvText, setCsvText] = useState(
    "name,category,contact_email\nPrime Office Depot,Office Supplies,quotes@primeoffice.example"
  );
  const [csvPreview, setCsvPreview] = useState<{
    valid_count: number;
    duplicates: string[];
    errors: string[];
  } | null>(null);

  // Settings / Tavily tester state
  const [searchQuery, setSearchQuery] = useState("PC portable professionnel Core i7 Sousse Tunisie");
  const [searchLeads, setSearchLeads] = useState<ExternalLead[]>([]);
  const [searchingLeads, setSearchingLeads] = useState(false);
  const [togglingSearch, setTogglingSearch] = useState(false);

  // Copilot drawer state
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotInput, setCopilotInput] = useState("");
  const [copilotLog, setCopilotLog] = useState<CopilotMsg[]>([]);
  const [copilotStreaming, setCopilotStreaming] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("procureai_ui_lang");
      if (saved === "fr" || saved === "en") setLang(saved);
    } catch {
      // ignore storage errors
    }
  }, []);

  const changeUiLang = (next: UiLang) => {
    setLang(next);
    try {
      window.localStorage.setItem("procureai_ui_lang", next);
    } catch {
      // ignore
    }
  };

  const showFeedback = useCallback((kind: "ok" | "error", text: string) => {
    setFeedback({ kind, text });
  }, []);

  const loadSelectedCase = useCallback(async (requestId: string) => {
    const res = await fetch(`/api/v1/requests/${requestId}/workspace`, { cache: "no-store" });
    if (res.ok) {
      setWorkspaceData(await res.json());
    } else if (res.status === 404) {
      setWorkspaceData(null);
      setSelectedRequestId(null);
    }
  }, []);

  const loadAgentsActivity = useCallback(async () => {
    const res = await fetch("/api/v1/agents/activity", { cache: "no-store" });
    if (res.ok) {
      setAgentsData(await res.json());
    }
  }, []);

  const loadUsageAndEvals = useCallback(async () => {
    const [uRes, eRes] = await Promise.all([
      fetch("/api/v1/usage/summary", { cache: "no-store" }),
      fetch("/api/v1/evals/summary", { cache: "no-store" }),
    ]);
    if (uRes.ok) setUsage(await uRes.json());
    if (eRes.ok) setEvalReport(await eRes.json());
  }, []);

  const loadCore = useCallback(async () => {
    const [sessRes, runsRes, ovRes, supRes, settingsRes] = await Promise.all([
      fetch("/api/auth/session", { cache: "no-store" }),
      fetch("/api/v1/runs", { cache: "no-store" }),
      fetch("/api/v1/overview/summary", { cache: "no-store" }),
      fetch("/api/v1/suppliers", { cache: "no-store" }),
      fetch("/api/v1/tenant/settings", { cache: "no-store" }),
    ]);
    if (sessRes.ok) {
      const sData = await sessRes.json();
      setActor(sData.actor);
      setPersonas(sData.personas || []);
      setDevAuthEnabled(Boolean(sData.dev_auth_enabled));
    }
    if (runsRes.ok) {
      const rData = await runsRes.json();
      const loadedRuns: RunSummary[] = rData.runs || [];
      setRuns(loadedRuns);
      setSelectedRequestId((prev) => prev || (loadedRuns.length > 0 ? loadedRuns[0].request_id : null));
    }
    if (ovRes.ok) {
      setOverview(await ovRes.json());
    }
    if (supRes.ok) {
      const sp = await supRes.json();
      setSuppliers(sp.suppliers || []);
    }
    if (settingsRes.ok) {
      const st: TenantSettings = await settingsRes.json();
      setTenantSettings(st);
      setProfName(st.tenant_name || "");
      setProfLocation(st.default_location || "Sousse, Tunisia");
      setProfCurrency(st.base_currency || "TND");
      setProfDocLang(st.default_language === "fr" ? "fr" : "en");
    }
  }, []);

  useEffect(() => {
    void loadCore();
  }, [loadCore]);

  useEffect(() => {
    if (activeNav === "agents") void loadAgentsActivity();
    if (activeNav === "usage") void loadUsageAndEvals();
  }, [activeNav, loadAgentsActivity, loadUsageAndEvals]);

  useEffect(() => {
    if (selectedRequestId) {
      void loadSelectedCase(selectedRequestId);
    } else {
      setWorkspaceData(null);
    }
  }, [selectedRequestId, loadSelectedCase]);

  const refreshActive = useCallback(async () => {
    await loadCore();
    if (selectedRequestId) {
      await loadSelectedCase(selectedRequestId);
    }
    if (activeNav === "agents") await loadAgentsActivity();
    if (activeNav === "usage") await loadUsageAndEvals();
  }, [activeNav, loadAgentsActivity, loadCore, loadSelectedCase, loadUsageAndEvals, selectedRequestId]);

  const switchPersona = async (personaId: string) => {
    const target = personas.find((p) => p.id === personaId);
    const sameTenant = target && actor && target.tenant_id === actor.tenant_id;
    setFeedback(null);
    setSearchLeads([]);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona_id: personaId }),
    });
    if (res.ok) {
      if (!sameTenant) {
        setSelectedRequestId(null);
        setWorkspaceData(null);
      }
      await loadCore();
      if (sameTenant && selectedRequestId) {
        await loadSelectedCase(selectedRequestId);
      }
      if (activeNav === "agents") await loadAgentsActivity();
      if (activeNav === "usage") await loadUsageAndEvals();
      if (target) {
        showFeedback(
          "ok",
          lang === "fr"
            ? `Utilisateur actif : ${target.display_name} (${target.tenant_name} — ${target.roles_label}).`
            : `Switched active user to ${target.display_name} (${target.tenant_name} — ${target.roles_label}).`
        );
      }
    }
  };

  const launchPreset = async (preset: "sousse" | "global") => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const endpoint =
        preset === "sousse" ? "/api/v1/requests/preset-sousse-tnd" : "/api/v1/requests/demo-20-laptops";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        showFeedback("error", data?.detail?.message || "Failed to load preset");
        return;
      }
      if (preset === "sousse") changeUiLang("fr");
      setSelectedRequestId(data.request_id);
      setActiveNav("overview");
      await loadCore();
      await loadSelectedCase(data.request_id);
      showFeedback(
        "ok",
        preset === "sousse"
          ? `Scénario ${data.reference_code} (Sousse · TND · Timbre Fiscal 1.000 TND) prêt à l'Étape 2 !`
          : `Loaded preset ${data.reference_code} (20 Laptops · $20,000 USD) ready for supplier sourcing.`
      );
    } finally {
      setSubmitting(false);
    }
  };

  const startAiIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim()) return;
    setSubmitting(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/v1/runs/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptInput.trim(), lang }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback("error", data?.detail?.message || data?.detail || "Failed to start AI intake");
        return;
      }
      setSelectedRequestId(data.request_id);
      showFeedback(
        "ok",
        lang === "fr"
          ? `Demande ${data.reference_code} lancée — extraction via OpenRouter DeepSeek V4.1 Flash...`
          : `Queued ${data.reference_code} — extracting structured draft via OpenRouter DeepSeek V4.1 Flash...`
      );
      await loadCore();
      const es = new EventSource(`/api/v1/runs/${data.run_id}/stream`);
      const onUpdate = () => {
        void loadCore();
        void loadSelectedCase(data.request_id);
      };
      es.addEventListener("react_step", onUpdate);
      es.addEventListener("card_projected", onUpdate);
      es.addEventListener("run_failed", onUpdate);
      es.addEventListener("stream_closed", () => {
        onUpdate();
        es.close();
      });
      es.onerror = () => {
        onUpdate();
        es.close();
      };
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveCompanyProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await fetch("/api/v1/tenant/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profName.trim(),
          default_location: profLocation.trim(),
          base_currency: profCurrency,
          default_language: profDocLang,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback("error", data?.detail?.message || "Could not update company profile");
        return;
      }
      changeUiLang(profDocLang);
      await loadCore();
      showFeedback(
        "ok",
        lang === "fr"
          ? `Profil entreprise mis à jour : ${data.tenant_name} (${data.base_currency}, ${data.default_language.toUpperCase()}).`
          : `Updated company profile: ${data.tenant_name} (${data.base_currency}, ${data.default_language.toUpperCase()}).`
      );
    } finally {
      setSavingProfile(false);
    }
  };

  const handleRunLiveBenchmark = async () => {
    setRunningLiveEval(true);
    try {
      const res = await fetch("/api/v1/evals/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ include_live_llm: true }),
      });
      if (res.ok) {
        const rep: EvalSuiteReport = await res.json();
        setEvalReport(rep);
        const uRes = await fetch("/api/v1/usage/summary", { cache: "no-store" });
        if (uRes.ok) setUsage(await uRes.json());
        showFeedback(
          "ok",
          `Live Jev Router benchmark completed: ${rep.passed_cases}/${rep.total_cases} passed (${rep.pass_rate_pct}%) · $${rep.live_observed_cost_usd}.`
        );
      }
    } finally {
      setRunningLiveEval(false);
    }
  };

  const handleAddSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSupName.trim()) return;
    const res = await fetch("/api/v1/suppliers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newSupName.trim(),
        category: newSupCategory.trim(),
        contact_email: newSupEmail.trim() || null,
      }),
    });
    if (res.ok) {
      setNewSupName("");
      setNewSupEmail("");
      showFeedback("ok", lang === "fr" ? "Fournisseur candidat ajouté." : "Added new unverified supplier candidate.");
      await loadCore();
    }
  };

  const handleDeleteSupplier = async (supId: string) => {
    const res = await fetch(`/api/v1/suppliers/${supId}`, { method: "DELETE" });
    if (res.ok) {
      showFeedback("ok", lang === "fr" ? "Fournisseur supprimé." : "Removed supplier from directory.");
      await loadCore();
    } else {
      const d = await res.json();
      showFeedback("error", d?.detail?.message || "Could not remove supplier");
    }
  };

  const handleUpdateSupplierEmail = async (supId: string, currentEmail: string | null) => {
    const entered = window.prompt(
      lang === "fr" ? "Adresse email vérifiée du fournisseur :" : "Enter verified supplier email address:",
      currentEmail || ""
    );
    if (entered === null) return;
    const res = await fetch(`/api/v1/suppliers/${supId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_email: entered.trim() }),
    });
    if (res.ok) {
      showFeedback("ok", lang === "fr" ? "Email fournisseur mis à jour." : "Updated supplier contact email.");
      await loadCore();
    }
  };

  const handleVerifySupplier = async (supId: string) => {
    const res = await fetch(`/api/v1/suppliers/${supId}/verify`, { method: "POST" });
    if (res.ok) {
      showFeedback("ok", lang === "fr" ? "Fournisseur vérifié et approuvé." : "Supplier verified and approved.");
      await loadCore();
    } else {
      const d = await res.json();
      showFeedback("error", d?.detail?.message || "Verification denied");
    }
  };

  const handleCsvImport = async (confirm: boolean) => {
    const res = await fetch("/api/v1/suppliers/import-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv_text: csvText, confirm }),
    });
    const data = await res.json();
    if (res.ok) {
      setCsvPreview({
        valid_count: data.valid_count,
        duplicates: data.duplicates || [],
        errors: data.errors || [],
      });
      if (confirm) {
        showFeedback("ok", `Imported ${data.imported_count} supplier(s) from CSV.`);
        await loadCore();
      }
    }
  };

  const toggleExternalSearch = async (nextValue: boolean) => {
    setTogglingSearch(true);
    try {
      const res = await fetch("/api/v1/tenant/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ external_search_enabled: nextValue }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback("error", `${data?.detail?.code || res.status}: ${data?.detail?.message || "Update blocked"}`);
        return;
      }
      showFeedback(
        "ok",
        `External Tavily search ${nextValue ? "enabled" : "disabled"} for ${actor?.tenant_name}.`
      );
      await loadCore();
    } finally {
      setTogglingSearch(false);
    }
  };

  const runManualTavilySearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchingLeads(true);
    try {
      const res = await fetch("/api/v1/suppliers/discover-external", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery.trim(), max_results: 3, search_depth: "basic" }),
      });
      const data = await res.json();
      if (!res.ok) {
        showFeedback("error", `${data?.detail?.code || res.status}: ${data?.detail?.message || "Search blocked"}`);
        setSearchLeads([]);
        return;
      }
      setSearchLeads(data.leads || []);
      showFeedback(
        "ok",
        `Found ${(data.leads || []).length} lead(s) via Tavily ($${data.estimated_cost_usd}${data.cache_hit ? " · cache hit" : ""}).`
      );
      await loadCore();
    } finally {
      setSearchingLeads(false);
    }
  };

  const executeCopilotClientAction = (act: CopilotAction) => {
    setActiveNav("overview");
    if (act.request_id && act.request_id !== selectedRequestId) {
      setSelectedRequestId(act.request_id);
    }
    if (act.action_type === "prefill_draft" && act.draft_patch) {
      setStageJump({ stage: 1, seq: Date.now() });
      setDraftPrefill({ patch: act.draft_patch, seq: Date.now() });
      showFeedback(
        "ok",
        lang === "fr"
          ? "Champs pré-remplis dans le brouillon (Étape 1) — vérifiez et cliquez sur Enregistrer."
          : "Pre-filled Stage 1 draft fields — review and click Save to commit."
      );
    } else if (act.target_stage) {
      setStageJump({ stage: act.target_stage, seq: Date.now() });
    }
  };

  const sendCopilotMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = copilotInput.trim();
    if (!text || copilotStreaming) return;
    setCopilotInput("");
    setCopilotStreaming(true);
    setCopilotLog((prev) => [...prev, { role: "user", text }, { role: "assistant", text: "" }]);
    try {
      const res = await fetch("/api/copilotkit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: selectedRequestId,
          lang,
          messages: [{ role: "user", content: text }],
        }),
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split("\n\n");
        buf = blocks.pop() || "";
        for (const block of blocks) {
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const evt = JSON.parse(line.slice(6));
            if (evt.type === "TEXT_MESSAGE_CONTENT" && evt.delta) {
              setCopilotLog((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = { ...last, role: "assistant", text: (last?.text || "") + evt.delta };
                return copy;
              });
            }
            if (evt.type === "COPILOT_META") {
              setCopilotLog((prev) => {
                const copy = [...prev];
                const last = copy[copy.length - 1];
                copy[copy.length - 1] = {
                  ...last,
                  action: evt.client_action || null,
                  emailDraft: evt.email_draft || null,
                };
                return copy;
              });
            }
            if (evt.type === "STATE_SNAPSHOT" && evt.snapshot?.request_id) {
              setSelectedRequestId(evt.snapshot.request_id);
              void loadCore();
              void loadSelectedCase(evt.snapshot.request_id);
            }
          } catch {
            // ignore keepalives
          }
        }
      }
      await loadCore();
    } finally {
      setCopilotStreaming(false);
    }
  };

  const initials = actor
    ? actor.display_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "PA";

  const checklistSteps = [
    {
      done: Boolean(workspaceData && workspaceData.version_count >= 1),
      label: lang === "fr" ? "1. Confirmer le besoin (TND/USD)" : "1. Confirm Request (TND/USD)",
    },
    {
      done: Boolean(suppliers.length > 0 || (workspaceData?.rfqs.length ?? 0) > 0),
      label: lang === "fr" ? "2. Extraire fournisseurs & DP PDF" : "2. Search Suppliers & RFQ PDF",
    },
    {
      done: Boolean((workspaceData?.quotations.length ?? 0) > 0),
      label: lang === "fr" ? "3. Charger / Simuler 4 Devis" : "3. Upload / Demo 4 Quotes",
    },
    {
      done: Boolean(workspaceData?.latest_comparison),
      label: lang === "fr" ? "4. Comparatif Decimal + Jev" : "4. Decimal + Jev Comparison",
    },
    {
      done: Boolean((workspaceData?.decisions.length ?? 0) > 0),
      label: lang === "fr" ? "5. Approbation Humaine Séparée" : "5. Authorized Human Approval",
    },
    {
      done: Boolean(workspaceData?.purchase_order?.po_number),
      label: lang === "fr" ? "6. Bon de Commande PDF Numéroté" : "6. Numbered Approved PO PDF",
    },
  ];

  return (
    <div className="flex min-h-screen bg-[#F7F8FA] text-[#1D2935]">
      {/* 224px Left Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-[#DEE4E9] bg-white">
        <div className="flex h-16 items-center gap-2.5 border-b border-[#DEE4E9] px-5">
          <img src="/logo.svg" alt="ProcureAI" className="h-6 w-6" />
          <span className="text-[15px] font-semibold tracking-tight">ProcureAI</span>
        </div>

        <div className="border-b border-[#DEE4E9] px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[#526170]">
            {t(lang, "workspace")}
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold">{actor?.tenant_name || "Loading..."}</div>
          <div className="mt-0.5 text-xs text-[#526170]">
            {actor?.base_currency || "USD"} · {t(lang, "webSearch")}{" "}
            {actor?.effective_external_search_enabled ? "ON" : "OFF"}
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-4 text-sm">
          {[
            {
              id: "overview" as const,
              label: t(lang, "navOverview"),
              icon: FileText,
              badge: overview?.kpis.awaiting_approval || 0,
            },
            { id: "suppliers" as const, label: t(lang, "navSuppliers"), icon: Building2, badge: 0 },
            { id: "agents" as const, label: t(lang, "navAgents"), icon: Bot, badge: 0 },
            { id: "usage" as const, label: t(lang, "navUsage"), icon: Activity, badge: 0 },
            { id: "settings" as const, label: t(lang, "navSettings"), icon: Settings, badge: 0 },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveNav(item.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left font-medium ${
                  activeNav === item.id
                    ? "bg-[#EDF4F1] text-[#285447]"
                    : "text-[#526170] hover:bg-[#F7F8FA] hover:text-[#1D2935]"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4" />
                  {item.label}
                </span>
                {item.badge > 0 && (
                  <span className="rounded-full bg-[#FEF6EC] px-1.5 py-0.5 text-[10px] font-semibold text-[#9A5B13]">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-[#DEE4E9] p-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#EDF4F1] text-xs font-semibold text-[#285447]">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{actor?.display_name || "—"}</div>
              <div className="truncate text-xs text-[#526170]">{actor?.title || "—"}</div>
            </div>
          </div>
          {devAuthEnabled && (
            <div className="mt-2 rounded bg-[#F7F8FA] px-2 py-1 text-[11px] text-[#526170]">
              {lang === "fr" ? "Mode démo multi-persona" : "Showcase persona switcher"}
            </div>
          )}
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] bg-white px-6 py-2">
          <div className="text-sm text-[#526170]">
            {t(lang, "workspace")} / <span className="font-medium text-[#1D2935] capitalize">{activeNav}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Global EN | FR Language Switcher */}
            <div
              role="group"
              aria-label="Language switcher"
              className="inline-flex items-center rounded-md border border-[#DEE4E9] bg-[#F7F8FA] p-0.5 text-xs font-semibold"
            >
              <Languages className="mx-1.5 h-3.5 w-3.5 text-[#526170]" />
              <button
                type="button"
                onClick={() => changeUiLang("en")}
                className={`rounded px-2 py-1 transition ${
                  lang === "en" ? "bg-[#285447] text-white" : "text-[#526170] hover:text-[#1D2935]"
                }`}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => changeUiLang("fr")}
                className={`rounded px-2 py-1 transition ${
                  lang === "fr" ? "bg-[#285447] text-white" : "text-[#526170] hover:text-[#1D2935]"
                }`}
              >
                FR
              </button>
            </div>

            {devAuthEnabled && personas.length > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-[#526170]">
                <Users className="h-3.5 w-3.5" />
                <span>{t(lang, "actAs")}</span>
                <select
                  aria-label="Switch dev test persona"
                  className="rounded-md border border-[#DEE4E9] bg-white px-2.5 py-1.5 text-xs font-medium text-[#1D2935]"
                  value={personas.find((p) => p.tenant_id === actor?.tenant_id && p.user_id === actor?.user_id)?.id || ""}
                  onChange={(e) => void switchPersona(e.target.value)}
                >
                  {personas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name} ({p.tenant_name} — {p.roles_label})
                    </option>
                  ))}
                </select>
              </label>
            )}

            <button
              type="button"
              onClick={() => setCopilotOpen((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium ${
                copilotOpen
                  ? "border-[#285447] bg-[#EDF4F1] text-[#285447]"
                  : "border-[#DEE4E9] bg-white text-[#1D2935] hover:bg-[#F7F8FA]"
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5 text-[#285447]" />
              {copilotOpen ? t(lang, "hideCopilot") : t(lang, "copilot")}
            </button>

            <button
              type="button"
              onClick={() => void refreshActive()}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3 py-1.5 text-xs font-medium hover:bg-[#F7F8FA]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t(lang, "refresh")}
            </button>
          </div>
        </header>

        <main className="flex-1 p-6">
          {feedback && (
            <div
              className={`mx-auto mb-5 flex max-w-6xl items-center gap-2 rounded-md border px-4 py-3 text-sm ${
                feedback.kind === "ok"
                  ? "border-[#CBE1D8] bg-[#EDF4F1] text-[#285447]"
                  : "border-[#F3C5C5] bg-[#FDF2F2] text-[#9B1C1C]"
              }`}
            >
              {feedback.kind === "ok" ? (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0" />
              )}
              <span>{feedback.text}</span>
            </div>
          )}

          {/* Persistent Command Copilot Drawer (visible on any tab when opened) */}
          {copilotOpen && (
            <div className="mx-auto mb-6 max-w-6xl rounded-md border border-[#285447]/35 bg-white p-4 shadow-xs">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DEE4E9] pb-2.5">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-[#285447]" />
                  <span>
                    {lang === "fr"
                      ? "Copilote Conversationnel ProcureAI (OpenRouter Jev Router)"
                      : "ProcureAI Command Copilot (OpenRouter Jev Router)"}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {[
                    lang === "fr"
                      ? "Pourquoi les autres devis sont-ils exclus ?"
                      : "Why were the other quotes disqualified?",
                    lang === "fr"
                      ? "Rédige un email de clarification fournisseur en français"
                      : "Draft a supplier clarification email for unconfirmed specs",
                    lang === "fr"
                      ? "Modifie la quantité à 12 dans le brouillon"
                      : "Change quantity to 12 in the request draft",
                  ].map((sample, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setCopilotInput(sample)}
                      className="rounded border border-[#DEE4E9] bg-[#F7F8FA] px-2 py-0.5 text-[#526170] hover:bg-[#EDF4F1] hover:text-[#285447]"
                    >
                      {sample}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-3 max-h-60 space-y-2.5 overflow-y-auto text-xs">
                {copilotLog.length === 0 && (
                  <p className="text-[#526170]">
                    {lang === "fr"
                      ? "Posez une question sur le comparatif, demandez un email de clarification, pré-remplissez une modification ou lancez une nouvelle demande."
                      : "Ask about the active comparison, draft a supplier clarification email, pre-fill Stage 1 edits, or start a new request."}
                  </p>
                )}
                {copilotLog.map((m, i) => (
                  <div
                    key={i}
                    className={`rounded p-3 ${m.role === "user" ? "bg-[#F7F8FA]" : "border border-[#CBE1D8] bg-[#EDF4F1]/60"}`}
                  >
                    <div className="whitespace-pre-wrap">
                      <strong className="text-[10px] uppercase text-[#526170]">{m.role}: </strong>
                      {m.text || "..."}
                    </div>

                    {m.emailDraft && (
                      <div className="mt-2.5 rounded border border-[#DEE4E9] bg-white p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[#1D2935]">{m.emailDraft.subject}</span>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard.writeText(
                                `Subject: ${m.emailDraft!.subject}\n\n${m.emailDraft!.body}`
                              );
                              showFeedback("ok", lang === "fr" ? "Brouillon copié !" : "Email draft copied!");
                            }}
                            className="inline-flex items-center gap-1 rounded border border-[#DEE4E9] px-2 py-0.5 text-[11px] font-medium hover:bg-[#F7F8FA]"
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </button>
                        </div>
                        <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[11px] text-[#526170]">
                          {m.emailDraft.body}
                        </pre>
                      </div>
                    )}

                    {m.action && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => executeCopilotClientAction(m.action!)}
                          className="inline-flex items-center gap-1.5 rounded bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237]"
                        >
                          {m.action.label}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <form onSubmit={sendCopilotMessage} className="mt-3 flex gap-2">
                <input
                  value={copilotInput}
                  onChange={(e) => setCopilotInput(e.target.value)}
                  placeholder={
                    lang === "fr"
                      ? "Posez une question au Copilote ou décrivez une action..."
                      : "Ask Copilot about quotes/specs, draft a follow-up, or edit draft..."
                  }
                  className="flex-1 rounded border border-[#DEE4E9] px-3 py-2 text-xs focus:border-[#285447] focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={copilotStreaming}
                  className="rounded bg-[#285447] px-4 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  {copilotStreaming ? "..." : lang === "fr" ? "Envoyer" : "Send"}
                </button>
              </form>
            </div>
          )}

          {/* OVERVIEW & 6-STAGE PROCUREMENT FLOW */}
          {activeNav === "overview" && (
            <div className="mx-auto max-w-6xl space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 className="text-[28px] font-semibold tracking-tight">{t(lang, "pageTitleOverview")}</h1>
                  <p className="mt-1 text-sm text-[#526170]">{t(lang, "pageSubOverview")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void launchPreset("sousse")}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    {t(lang, "presetSousseBtn")}
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void launchPreset("global")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3.5 py-2 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA] disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5 text-[#285447]" />
                    {t(lang, "presetGlobalBtn")}
                  </button>
                </div>
              </div>

              {/* 4 Inline KPI Metrics (design/screens/01-workspace-overview.png fidelity) */}
              <div className="grid grid-cols-2 divide-x divide-[#DEE4E9] rounded-md border border-[#DEE4E9] bg-white py-3.5 lg:grid-cols-4">
                <div className="px-5">
                  <div className="text-xs text-[#526170]">{t(lang, "kpiOpenRequests")}</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">
                    {overview?.kpis.open_requests ?? runs.length}
                  </div>
                </div>
                <div className="px-5">
                  <div className="text-xs text-[#526170]">{t(lang, "kpiAwaitingApproval")}</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums text-[#9A5B13]">
                    {overview?.kpis.awaiting_approval ?? 0}
                  </div>
                </div>
                <div className="px-5">
                  <div className="text-xs text-[#526170]">{t(lang, "kpiQuotesToReview")}</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums">
                    {overview?.kpis.quotes_to_review ?? 0}
                  </div>
                </div>
                <div className="px-5">
                  <div className="text-xs text-[#526170]">{t(lang, "kpiApprovedPos")}</div>
                  <div className="mt-0.5 text-xl font-semibold tabular-nums text-[#285447]">
                    {overview?.kpis.approved_pos ?? 0}
                  </div>
                </div>
              </div>

              {/* Actionable Pending Approval Inbox Banner */}
              {overview && overview.pending_approvals.length > 0 && (
                <div className="rounded-md border border-[#F5DFC4] bg-[#FEF6EC] p-4">
                  <div className="text-xs font-semibold uppercase tracking-wider text-[#9A5B13]">
                    {t(lang, "inboxTitle")} ({overview.pending_approvals.length})
                  </div>
                  <div className="mt-2 divide-y divide-[#F5DFC4]/70">
                    {overview.pending_approvals.map((pa) => (
                      <div key={pa.approval_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
                        <div>
                          <span className="font-mono font-semibold text-[#1D2935]">{pa.reference_code}</span> ·{" "}
                          <span className="font-medium text-[#1D2935]">{pa.title}</span> ·{" "}
                          <span className="font-semibold text-[#285447]">
                            {pa.currency_code} {pa.amount}
                          </span>{" "}
                          <span className="text-[#526170]">
                            ({pa.decision_type === "po_release" ? "PO Release" : "Supplier Award"})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRequestId(pa.request_id);
                            setStageJump({ stage: 5, seq: Date.now() });
                          }}
                          className="rounded bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237]"
                        >
                          {t(lang, "inboxReviewBtn")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Collapsible 6-Step Showcase Checklist */}
              <div className="rounded-md border border-[#DEE4E9] bg-white px-4 py-3">
                <button
                  type="button"
                  onClick={() => setGuideOpen((v) => !v)}
                  className="flex w-full items-center justify-between text-left text-xs font-semibold text-[#1D2935]"
                >
                  <span>{t(lang, "guideTitle")}</span>
                  {guideOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
                {guideOpen && (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {checklistSteps.map((st, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setStageJump({ stage: idx + 1, seq: Date.now() })}
                        className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-left text-[11px] font-medium ${
                          st.done
                            ? "border-[#CBE1D8] bg-[#EDF4F1] text-[#285447]"
                            : "border-[#DEE4E9] bg-[#F7F8FA] text-[#526170]"
                        }`}
                      >
                        <CheckCircle2 className={`h-3.5 w-3.5 shrink-0 ${st.done ? "text-[#285447]" : "opacity-35"}`} />
                        <span className="truncate">{st.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* AI Natural-Language Intake Bar */}
              <form onSubmit={startAiIntake} className="rounded-md border border-[#DEE4E9] bg-white p-4">
                <div className="flex flex-wrap gap-2">
                  <input
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    placeholder={t(lang, "intakePlaceholder")}
                    className="min-w-[260px] flex-1 rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-sm font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" />
                    {submitting ? t(lang, "working") : t(lang, "draftViaAi")}
                  </button>
                </div>
              </form>

              {/* Request Switcher Strip */}
              {runs.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {runs.slice(0, 10).map((r) => (
                    <button
                      key={r.run_id}
                      type="button"
                      onClick={() => setSelectedRequestId(r.request_id)}
                      className={`shrink-0 rounded-md border px-3 py-2 text-left text-xs ${
                        selectedRequestId === r.request_id
                          ? "border-[#285447] bg-white shadow-xs"
                          : "border-[#DEE4E9] bg-white/70 hover:bg-white"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-[#1D2935]">{r.reference_code}</span>
                        <StatusBadge status={r.status} lang={lang} />
                      </div>
                      <div className="mt-0.5 max-w-[200px] truncate text-[#526170]">{r.title}</div>
                    </button>
                  ))}
                </div>
              )}

              {/* Active 6-Stage Interactive Flow */}
              {workspaceData ? (
                <CaseFlowView
                  workspace={workspaceData}
                  actor={actor}
                  personas={personas}
                  devAuthEnabled={devAuthEnabled}
                  suppliers={suppliers}
                  lang={lang}
                  externalStageRequest={stageJump}
                  copilotDraftPrefill={draftPrefill}
                  onRefresh={refreshActive}
                  onSwitchPersona={switchPersona}
                  onFeedback={showFeedback}
                />
              ) : (
                <div className="rounded-md border border-[#DEE4E9] bg-white p-8 text-center text-sm text-[#526170]">
                  {lang === "fr"
                    ? "Lancez un scénario ci-dessus ou décrivez votre besoin d'achat en TND/EUR/USD."
                    : "Launch a showcase preset above or describe your procurement request to start."}
                </div>
              )}
            </div>
          )}

          {/* AGENTS & BACKGROUND LOG SCREEN */}
          {activeNav === "agents" && (
            <AgentsActivityView
              data={agentsData}
              lang={lang}
              onRefresh={loadAgentsActivity}
              onSelectRequest={(reqId) => {
                setSelectedRequestId(reqId);
                setActiveNav("overview");
              }}
            />
          )}

          {/* SUPPLIERS DIRECTORY TAB */}
          {activeNav === "suppliers" && (
            <div className="mx-auto max-w-5xl space-y-6">
              <div>
                <h1 className="text-[28px] font-semibold tracking-tight">{t(lang, "navSuppliers")}</h1>
                <p className="mt-1 text-sm text-[#526170]">
                  {lang === "fr"
                    ? `Isolé par RLS pour ${actor?.tenant_name}. Les fournisseurs importés ou extraits démarrent non vérifiés.`
                    : `Isolated to ${actor?.tenant_name}. New additions and CSV imports start unverified until a buyer verifies them.`}
                </p>
              </div>
              <div className="overflow-hidden rounded-md border border-[#DEE4E9] bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[#DEE4E9] bg-[#F7F8FA] text-xs text-[#526170]">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">{lang === "fr" ? "Fournisseur" : "Supplier"}</th>
                      <th className="px-4 py-2.5 font-medium">{lang === "fr" ? "Catégorie" : "Category"}</th>
                      <th className="px-4 py-2.5 font-medium">Contact</th>
                      <th className="px-4 py-2.5 font-medium">{lang === "fr" ? "Statut" : "Status"}</th>
                      <th className="px-4 py-2.5 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DEE4E9] text-xs">
                    {suppliers.map((s) => (
                      <tr key={s.id}>
                        <td className="px-4 py-3 font-medium text-[#1D2935]">{s.name}</td>
                        <td className="px-4 py-3 text-[#526170]">{s.category}</td>
                        <td className="px-4 py-3 text-[#526170]">
                          <div>{s.contact_email || "No email"}</div>
                          <div className="text-[11px]">
                            {s.phone || ""} {s.location ? `· ${s.location}` : ""}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded px-2 py-0.5 font-medium ${
                              s.verification_status === "approved"
                                ? "bg-[#EDF4F1] text-[#285447]"
                                : "bg-[#FEF6EC] text-[#9A5B13]"
                            }`}
                          >
                            {s.verification_status}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleUpdateSupplierEmail(s.id, s.contact_email)}
                              className="rounded border border-[#DEE4E9] px-2 py-1 text-[11px] font-medium hover:bg-[#F7F8FA]"
                            >
                              {lang === "fr" ? "Email" : "Edit Email"}
                            </button>
                            {s.verification_status !== "approved" && (
                              <button
                                type="button"
                                onClick={() => void handleVerifySupplier(s.id)}
                                className="rounded border border-[#285447] px-2 py-1 text-[11px] font-medium text-[#285447] hover:bg-[#EDF4F1]"
                              >
                                {lang === "fr" ? "Vérifier" : "Verify"}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleDeleteSupplier(s.id)}
                              className="rounded border border-[#F3C5C5] px-2 py-1 text-[11px] font-medium text-[#9B1C1C] hover:bg-[#FDF2F2]"
                            >
                              {lang === "fr" ? "Supprimer" : "Remove"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <form
                  onSubmit={handleAddSupplier}
                  className="space-y-3 rounded-md border border-[#DEE4E9] bg-white p-5 text-xs"
                >
                  <h2 className="text-sm font-semibold">
                    {lang === "fr" ? "Ajouter un fournisseur manuellement" : "Add Supplier Manually"}
                  </h2>
                  <input
                    value={newSupName}
                    onChange={(e) => setNewSupName(e.target.value)}
                    placeholder="Supplier name"
                    className="w-full rounded border border-[#DEE4E9] px-3 py-2"
                  />
                  <input
                    value={newSupCategory}
                    onChange={(e) => setNewSupCategory(e.target.value)}
                    placeholder="Category"
                    className="w-full rounded border border-[#DEE4E9] px-3 py-2"
                  />
                  <input
                    value={newSupEmail}
                    onChange={(e) => setNewSupEmail(e.target.value)}
                    placeholder="Contact email"
                    className="w-full rounded border border-[#DEE4E9] px-3 py-2"
                  />
                  <button type="submit" className="rounded bg-[#285447] px-4 py-2 font-medium text-white">
                    {lang === "fr" ? "Ajouter" : "Add Candidate"}
                  </button>
                </form>

                <div className="space-y-3 rounded-md border border-[#DEE4E9] bg-white p-5 text-xs">
                  <h2 className="text-sm font-semibold">
                    {lang === "fr" ? "Import CSV Validé (Aperçu & Confirmation)" : "Validated CSV Import (Preview & Confirm)"}
                  </h2>
                  <textarea
                    rows={3}
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                    className="w-full rounded border border-[#DEE4E9] p-2 font-mono text-[11px]"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCsvImport(false)}
                      className="rounded border border-[#DEE4E9] px-3 py-1.5 font-medium"
                    >
                      Preview CSV
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCsvImport(true)}
                      className="rounded bg-[#285447] px-3 py-1.5 font-medium text-white"
                    >
                      Confirm Import
                    </button>
                  </div>
                  {csvPreview && (
                    <div className="rounded bg-[#F7F8FA] p-2 text-[11px]">
                      Valid: {csvPreview.valid_count} · Duplicates: {csvPreview.duplicates.length} · Errors:{" "}
                      {csvPreview.errors.length}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* LLM, TAVILY SPEND & EVALUATION BENCHMARK SCORECARD TAB */}
          {activeNav === "usage" && (
            <div className="mx-auto max-w-6xl space-y-6">
              <div>
                <h1 className="text-[28px] font-semibold tracking-tight">{t(lang, "navUsage")}</h1>
                <p className="mt-1 text-sm text-[#526170]">
                  {lang === "fr"
                    ? "Gouvernance budgétaire OpenRouter (DeepSeek V4.1 Flash + Jev Router) & Tavily + Tableau d'évaluation de sécurité."
                    : "Atomic daily spend governance across OpenRouter (DeepSeek V4.1 Flash + Jev Router) & Tavily, plus Dev/Held-Out Evaluation Scorecard."}
                </p>
              </div>

              <div className="grid grid-cols-2 divide-x divide-[#DEE4E9] rounded-md border border-[#DEE4E9] bg-white p-4 lg:grid-cols-4">
                <div className="px-4">
                  <div className="text-xs text-[#526170]">Combined 24h spend / cap</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    ${usage?.combined_24h_spend_usd || "0.000000"} / ${usage?.daily_budget_usd || "5.00"}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    Remaining: ${usage?.remaining_24h_budget_usd || "5.00"}
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-xs text-[#526170]">OpenRouter (DeepSeek + Jev)</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    ${usage?.llm.observed_cost_usd || "0.000000"}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    {usage?.llm.total_calls ?? 0} calls · {usage?.llm.cache_hits ?? 0} cache hits ($0)
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-xs text-[#526170]">Tavily search spend (est.)</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    ${usage?.tavily.estimated_cost_usd || "0.000000"}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    {usage?.tavily.total_calls ?? 0} searches · {usage?.tavily.total_credits ?? 0} credits
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-xs text-[#526170]">LLM tokens</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {(usage?.llm.prompt_tokens ?? 0) + (usage?.llm.completion_tokens ?? 0)}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    KV cached: {usage?.llm.cached_tokens ?? 0} · Reasoning: {usage?.llm.reasoning_tokens ?? 0}
                  </div>
                </div>
              </div>

              {/* Evaluation & Safety Benchmark Scorecard */}
              <div className="rounded-md border border-[#DEE4E9] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-[#285447]" />
                    <div>
                      <h2 className="text-sm font-semibold">{t(lang, "evalSuiteTitle")}</h2>
                      {evalReport && (
                        <p className="text-xs text-[#526170]">
                          Pass rate: <strong>{evalReport.pass_rate_pct}%</strong> ({evalReport.passed_cases}/
                          {evalReport.total_cases}) · Dev: {evalReport.dev_summary.passed}/
                          {evalReport.dev_summary.total} · Held-out: {evalReport.held_out_summary.passed}/
                          {evalReport.held_out_summary.total}
                          {evalReport.live_model_route ? ` · Live route: ${evalReport.live_model_route}` : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={runningLiveEval}
                    onClick={() => void handleRunLiveBenchmark()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {runningLiveEval ? t(lang, "runningEval") : t(lang, "runLiveEvalBtn")}
                  </button>
                </div>
                {evalReport && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[#DEE4E9] bg-[#F7F8FA] text-[#526170]">
                      <tr>
                        <th className="px-4 py-2">Case</th>
                        <th className="px-4 py-2">Split</th>
                        <th className="px-4 py-2">Invariant / Benchmark</th>
                        <th className="px-4 py-2">Result</th>
                        <th className="px-4 py-2">Evidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#DEE4E9]">
                      {evalReport.cases.map((c) => (
                        <tr key={c.id}>
                          <td className="px-4 py-2 font-mono font-semibold">{c.id}</td>
                          <td className="px-4 py-2">
                            <span className="rounded bg-[#F3F4F6] px-1.5 py-0.5 font-mono text-[10px] uppercase">
                              {c.split}
                            </span>
                          </td>
                          <td className="px-4 py-2 font-medium">{c.category}</td>
                          <td className="px-4 py-2">
                            <span
                              className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                                c.passed ? "bg-[#EDF4F1] text-[#285447]" : "bg-[#FDF2F2] text-[#9B1C1C]"
                              }`}
                            >
                              {c.passed ? "PASS" : "FAIL"}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-[#526170]">{c.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="overflow-hidden rounded-md border border-[#DEE4E9] bg-white">
                <div className="border-b border-[#DEE4E9] px-5 py-3 text-sm font-semibold">
                  Recent OpenRouter LLM & Jev Router Calls
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[#DEE4E9] bg-[#F7F8FA] text-[#526170]">
                    <tr>
                      <th className="px-4 py-2">Profile</th>
                      <th className="px-4 py-2">Model</th>
                      <th className="px-4 py-2">Provider</th>
                      <th className="px-4 py-2">In / Out</th>
                      <th className="px-4 py-2">Cost (USD)</th>
                      <th className="px-4 py-2">Outcome</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DEE4E9] tabular-nums">
                    {(usage?.recent || []).map((u) => (
                      <tr key={u.id}>
                        <td className="px-4 py-2 font-mono text-[11px] text-[#285447]">{u.profile}</td>
                        <td className="px-4 py-2 font-mono">{u.actual_model}</td>
                        <td className="px-4 py-2">{u.provider}</td>
                        <td className="px-4 py-2">
                          {u.prompt_tokens} / {u.completion_tokens}
                        </td>
                        <td className="px-4 py-2">${u.cost_usd || "0"}</td>
                        <td className="px-4 py-2">{u.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SETTINGS, COMPANY PROFILE & EXTERNAL SEARCH TAB */}
          {activeNav === "settings" && (
            <div className="mx-auto max-w-4xl space-y-6">
              <h1 className="text-[28px] font-semibold tracking-tight">{t(lang, "navSettings")}</h1>

              {/* Editable Company Profile Card */}
              <form
                onSubmit={handleSaveCompanyProfile}
                className="space-y-4 rounded-md border border-[#DEE4E9] bg-white p-5 text-xs"
              >
                <div className="border-b border-[#DEE4E9] pb-2.5">
                  <h2 className="text-sm font-semibold">{t(lang, "companyProfileTitle")}</h2>
                  <p className="mt-0.5 text-[#526170]">
                    {lang === "fr"
                      ? "Personnalisez le nom de l'entreprise, la ville, la devise et la langue par défaut affichés sur tous vos PDF (Demande de Prix & Bon de Commande)."
                      : "Customize the company name, default city, base currency, and default document language printed on all exported RFQ & PO PDFs."}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block font-medium text-[#526170]">
                      {lang === "fr" ? "Nom de l'entreprise" : "Company / Organization Name"}
                    </label>
                    <input
                      value={profName}
                      onChange={(e) => setProfName(e.target.value)}
                      className="mt-1 w-full rounded border border-[#DEE4E9] px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-[#526170]">
                      {lang === "fr" ? "Ville / Pays par défaut" : "Default Delivery City / Country"}
                    </label>
                    <input
                      value={profLocation}
                      onChange={(e) => setProfLocation(e.target.value)}
                      placeholder="Sousse, Tunisia"
                      className="mt-1 w-full rounded border border-[#DEE4E9] px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-[#526170]">
                      {lang === "fr" ? "Devise par défaut" : "Base Currency"}
                    </label>
                    <select
                      value={profCurrency}
                      onChange={(e) => setProfCurrency(e.target.value)}
                      className="mt-1 w-full rounded border border-[#DEE4E9] bg-white px-3 py-2 text-sm"
                    >
                      {["TND", "EUR", "USD", "MAD", "DZD", "GBP", "SAR", "AED", "CAD", "CHF"].map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-[#526170]">{t(lang, "docLangLabel")}</label>
                    <select
                      value={profDocLang}
                      onChange={(e) => setProfDocLang(e.target.value as UiLang)}
                      className="mt-1 w-full rounded border border-[#DEE4E9] bg-white px-3 py-2 text-sm"
                    >
                      <option value="fr">Français (Demande de Prix / Bon de Commande)</option>
                      <option value="en">English (RFQ / Purchase Order)</option>
                    </select>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={savingProfile || !tenantSettings?.can_edit_company_profile}
                  className="rounded-md bg-[#285447] px-4 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  {t(lang, "saveProfileBtn")}
                </button>
              </form>

              <div className="rounded-md border border-[#DEE4E9] bg-white p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 font-semibold">
                      <Globe className="h-4 w-4 text-[#285447]" />
                      External supplier lead search (Tavily)
                    </div>
                    <p className="mt-1 text-xs text-[#526170]">
                      Tenant toggle: <strong>{tenantSettings?.external_search_enabled ? "Enabled" : "Disabled"}</strong>
                      . Only Tenant Admins (e.g. Samira Vance) can change this setting.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!tenantSettings?.can_edit_settings || togglingSearch}
                    onClick={() => void toggleExternalSearch(!tenantSettings?.external_search_enabled)}
                    className="rounded-md bg-[#285447] px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {tenantSettings?.external_search_enabled ? "Disable external search" : "Enable external search"}
                  </button>
                </div>
              </div>

              <div className="rounded-md border border-[#DEE4E9] bg-white p-5">
                <h2 className="text-sm font-semibold">Test Tavily External Supplier Lead Discovery</h2>
                <form onSubmit={runManualTavilySearch} className="mt-3 flex gap-2">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="flex-1 rounded border border-[#DEE4E9] px-3 py-2 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={searchingLeads}
                    className="inline-flex items-center gap-1 rounded bg-[#285447] px-4 py-2 text-sm font-medium text-white"
                  >
                    <Search className="h-4 w-4" />
                    Search
                  </button>
                </form>
                {searchLeads.length > 0 && (
                  <div className="mt-4 divide-y divide-[#DEE4E9] rounded border border-[#DEE4E9]">
                    {searchLeads.map((l, i) => (
                      <div key={i} className="p-3 text-xs">
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 font-semibold text-[#285447] hover:underline"
                        >
                          {l.title} <ExternalLink className="h-3 w-3" />
                        </a>
                        <p className="mt-1 text-[#526170]">{l.snippet}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
