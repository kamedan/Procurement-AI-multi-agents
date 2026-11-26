"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Building2,
  Check,
  CheckCircle2,
  Clock,
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
  X,
} from "lucide-react";
import { formatApiError, readJsonSafe } from "@/lib/errors";
import { t, type I18nKey, type UiLang } from "@/lib/i18n";
import AgentsActivityView from "./AgentsActivityView";
import CaseFlowView from "./CaseFlowView";
import CopilotDrawer, { type CopilotMsg } from "./CopilotDrawer";
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
      label: isFr ? "À approuver" : "Approval",
    },
    waiting_for_input: {
      bg: "bg-[#EEF2F6]",
      text: "text-[#1D2935]",
      label: isFr ? "En cours" : "In progress",
    },
    completed: { bg: "bg-[#EDF4F1]", text: "text-[#285447]", label: isFr ? "Terminé" : "Done" },
    failed: { bg: "bg-[#FDF2F2]", text: "text-[#9B1C1C]", label: isFr ? "Échec" : "Failed" },
  };
  const cfg = styles[status] ?? { bg: "bg-[#F3F4F6]", text: "text-[#526170]", label: status };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${cfg.bg} ${cfg.text}`}>
      <Clock className="h-2.5 w-2.5" />
      {cfg.label}
    </span>
  );
}

const NAV_I18N: Record<"overview" | "suppliers" | "agents" | "usage" | "settings", I18nKey> = {
  overview: "navOverview",
  suppliers: "navSuppliers",
  agents: "navAgents",
  usage: "navUsage",
  settings: "navSettings",
};

export default function ProcureWorkspace() {
  const [lang, setLang] = useState<UiLang>("en");
  const isFr = lang === "fr";

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

  // New Request Launcher panel (collapsed when requests already exist so Overview stays super clean!)
  const [newReqOpen, setNewReqOpen] = useState(false);
  const [promptInput, setPromptInput] = useState(
    "We need 10 business laptops in Sousse, Tunisia, budget 25000 TND, delivered within 10 days."
  );
  const [submitting, setSubmitting] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "error"; text: string; id: number } | null>(null);
  const [activeNav, setActiveNav] = useState<"overview" | "suppliers" | "agents" | "usage" | "settings">("overview");

  // Stage jump & Copilot draft prefill bridge into CaseFlowView
  const [stageJump, setStageJump] = useState<{ stage: number; seq: number } | null>(null);
  const [draftPrefill, setDraftPrefill] = useState<{
    patch: NonNullable<CopilotAction["draft_patch"]>;
    seq: number;
  } | null>(null);

  // Suppliers tab state (replaces window.prompt with inline row editor!)
  const [editingEmailSupId, setEditingEmailSupId] = useState<string | null>(null);
  const [editingEmailVal, setEditingEmailVal] = useState("");
  const [showCsvPanel, setShowCsvPanel] = useState(false);
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

  // Copilot slide-over drawer state
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

  // Auto-dismiss success toasts after 6s (keep errors visible until dismissed)
  useEffect(() => {
    if (!feedback || feedback.kind !== "ok") return;
    const timer = window.setTimeout(() => {
      setFeedback((cur) => (cur?.id === feedback.id ? null : cur));
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const changeUiLang = (next: UiLang) => {
    setLang(next);
    try {
      window.localStorage.setItem("procureai_ui_lang", next);
    } catch {
      // ignore
    }
  };

  const showFeedback = useCallback((kind: "ok" | "error", text: string) => {
    setFeedback({ kind, text: String(text || ""), id: Date.now() });
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
      setSelectedRequestId((prev) =>
        prev && loadedRuns.some((r) => r.request_id === prev)
          ? prev
          : loadedRuns.length > 0
          ? loadedRuns[0].request_id
          : null
      );
      if (loadedRuns.length === 0) setNewReqOpen(true);
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
    setRefreshingAll(true);
    try {
      await loadCore();
      if (selectedRequestId) {
        await loadSelectedCase(selectedRequestId);
      }
      if (activeNav === "agents") await loadAgentsActivity();
      if (activeNav === "usage") await loadUsageAndEvals();
    } finally {
      setRefreshingAll(false);
    }
  }, [activeNav, loadAgentsActivity, loadCore, loadSelectedCase, loadUsageAndEvals, selectedRequestId]);

  const switchPersona = async (personaId: string) => {
    const target = personas.find((p) => p.id === personaId);
    const sameTenant = target && actor && target.tenant_id === actor.tenant_id;
    setFeedback(null);
    setSearchLeads([]);
    setEditingEmailSupId(null);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona_id: personaId }),
    });
    if (!res.ok) {
      const data = await readJsonSafe(res);
      showFeedback("error", formatApiError(data, isFr ? "Impossible de changer d'utilisateur" : "Could not switch persona", res.status));
      return;
    }
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
        isFr
          ? `Utilisateur actif : ${target.display_name} (${target.roles_label}).`
          : `Switched user to ${target.display_name} (${target.roles_label}).`
      );
    }
  };

  const launchPreset = async (preset: "sousse" | "global") => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const endpoint =
        preset === "sousse" ? "/api/v1/requests/preset-sousse-tnd" : "/api/v1/requests/demo-20-laptops";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        showFeedback("error", formatApiError(data, isFr ? "Échec du lancement du scénario" : "Failed to load preset", res.status));
        return;
      }
      if (preset === "sousse") changeUiLang("fr");
      const reqId = String(data.request_id || "");
      setSelectedRequestId(reqId);
      setNewReqOpen(false);
      setActiveNav("overview");
      await loadCore();
      if (reqId) await loadSelectedCase(reqId);
      showFeedback(
        "ok",
        preset === "sousse"
          ? `Scénario ${data.reference_code} (Sousse · TND · Timbre Fiscal) prêt !`
          : `Loaded ${data.reference_code} (20 Laptops · $20,000 USD) ready for suppliers.`
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        showFeedback("error", formatApiError(data, isFr ? "Échec de l'analyse IA" : "Failed to start AI intake", res.status));
        return;
      }
      const reqId = String(data.request_id || "");
      setSelectedRequestId(reqId);
      setNewReqOpen(false);
      showFeedback(
        "ok",
        isFr
          ? `Demande ${data.reference_code} créée — extraction par DeepSeek V4.1 Flash...`
          : `Created ${data.reference_code} — extracting structured fields via DeepSeek V4.1 Flash...`
      );
      await loadCore();
      const es = new EventSource(`/api/v1/runs/${data.run_id}/stream`);
      const onUpdate = () => {
        void loadCore();
        if (reqId) void loadSelectedCase(reqId);
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        showFeedback("error", formatApiError(data, isFr ? "Échec de la mise à jour du profil" : "Could not update company profile", res.status));
        return;
      }
      changeUiLang(profDocLang);
      await loadCore();
      showFeedback(
        "ok",
        isFr
          ? `Profil entreprise enregistré : ${data.tenant_name} (${data.base_currency}).`
          : `Saved company profile: ${data.tenant_name} (${data.base_currency}).`
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        showFeedback("error", formatApiError(data, isFr ? "Échec du benchmark" : "Benchmark run failed", res.status));
        return;
      }
      const rep = data as unknown as EvalSuiteReport;
      setEvalReport(rep);
      const uRes = await fetch("/api/v1/usage/summary", { cache: "no-store" });
      if (uRes.ok) setUsage(await uRes.json());
      showFeedback(
        "ok",
        isFr
          ? `Benchmark Jev terminé : ${rep.passed_cases}/${rep.total_cases} (${rep.pass_rate_pct}%) · $${rep.live_observed_cost_usd}.`
          : `Live Jev benchmark completed: ${rep.passed_cases}/${rep.total_cases} passed (${rep.pass_rate_pct}%) · $${rep.live_observed_cost_usd}.`
      );
    } finally {
      setRunningLiveEval(false);
    }
  };

  const handleAddSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSupName.trim()) {
      showFeedback("error", isFr ? "Veuillez indiquer le nom du fournisseur." : "Please enter a supplier name.");
      return;
    }
    const res = await fetch("/api/v1/suppliers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: newSupName.trim(),
        category: newSupCategory.trim() || "General",
        contact_email: newSupEmail.trim() || null,
      }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      showFeedback("error", formatApiError(data, isFr ? "Impossible d'ajouter le fournisseur" : "Could not add supplier", res.status));
      return;
    }
    setNewSupName("");
    setNewSupEmail("");
    showFeedback("ok", isFr ? "Fournisseur ajouté à l'annuaire." : "Supplier added to directory.");
    await loadCore();
  };

  const handleDeleteSupplier = async (supId: string) => {
    const res = await fetch(`/api/v1/suppliers/${supId}`, { method: "DELETE" });
    if (res.ok) {
      showFeedback("ok", isFr ? "Fournisseur supprimé." : "Removed supplier from directory.");
      await loadCore();
    } else {
      const data = await readJsonSafe(res);
      showFeedback("error", formatApiError(data, isFr ? "Impossible de supprimer ce fournisseur" : "Could not remove supplier", res.status));
    }
  };

  const handleSaveSupplierEmail = async (supId: string) => {
    const res = await fetch(`/api/v1/suppliers/${supId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_email: editingEmailVal.trim() || null }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      showFeedback("error", formatApiError(data, isFr ? "Impossible de mettre à jour l'email" : "Could not update email", res.status));
      return;
    }
    setEditingEmailSupId(null);
    setEditingEmailVal("");
    showFeedback("ok", isFr ? "Email fournisseur mis à jour." : "Updated supplier contact email.");
    await loadCore();
  };

  const handleVerifySupplier = async (supId: string) => {
    const res = await fetch(`/api/v1/suppliers/${supId}/verify`, { method: "POST" });
    if (res.ok) {
      showFeedback("ok", isFr ? "Fournisseur vérifié." : "Supplier verified.");
      await loadCore();
    } else {
      const data = await readJsonSafe(res);
      showFeedback("error", formatApiError(data, isFr ? "Vérification refusée" : "Verification denied", res.status));
    }
  };

  const handleCsvImport = async (confirm: boolean) => {
    const res = await fetch("/api/v1/suppliers/import-csv", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv_text: csvText, confirm }),
    });
    const data = await readJsonSafe(res);
    if (!res.ok) {
      showFeedback("error", formatApiError(data, isFr ? "Échec de l'import CSV" : "CSV import failed", res.status));
      return;
    }
    setCsvPreview({
      valid_count: Number(data.valid_count || 0),
      duplicates: Array.isArray(data.duplicates) ? (data.duplicates as string[]) : [],
      errors: Array.isArray(data.errors) ? (data.errors as string[]) : [],
    });
    if (confirm) {
      showFeedback(
        "ok",
        isFr
          ? `${data.imported_count} fournisseur(s) importé(s) depuis le CSV.`
          : `Imported ${data.imported_count} supplier(s) from CSV.`
      );
      await loadCore();
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        showFeedback("error", formatApiError(data, isFr ? "Modification refusée" : "Update blocked", res.status));
        return;
      }
      showFeedback(
        "ok",
        isFr
          ? `Recherche web Tavily ${nextValue ? "activée" : "désactivée"} pour ${actor?.tenant_name}.`
          : `External Tavily search ${nextValue ? "enabled" : "disabled"} for ${actor?.tenant_name}.`
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
      const data = await readJsonSafe(res);
      if (!res.ok) {
        showFeedback("error", formatApiError(data, isFr ? "Recherche bloquée" : "Search blocked", res.status));
        setSearchLeads([]);
        return;
      }
      const leads = Array.isArray(data.leads) ? (data.leads as ExternalLead[]) : [];
      setSearchLeads(leads);
      showFeedback(
        "ok",
        isFr
          ? `${leads.length} résultat(s) trouvé(s) via Tavily ($${data.estimated_cost_usd}${data.cache_hit ? " · cache" : ""}).`
          : `Found ${leads.length} lead(s) via Tavily ($${data.estimated_cost_usd}${data.cache_hit ? " · cache hit" : ""}).`
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
        isFr
          ? "Champs pré-remplis dans le brouillon (Étape 1) — vérifiez et cliquez sur Enregistrer."
          : "Pre-filled Stage 1 draft fields — review and click Save."
      );
    } else if (act.target_stage) {
      setStageJump({ stage: act.target_stage, seq: Date.now() });
    }
  };

  const sendCopilotMessage = async (e: React.FormEvent, overrideText?: string) => {
    e.preventDefault();
    const text = (overrideText ?? copilotInput).trim();
    if (!text || copilotStreaming) return;
    if (!overrideText) setCopilotInput("");
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
      if (!res.ok || !res.body) {
        const errData = await readJsonSafe(res);
        const msg = formatApiError(errData, isFr ? "Le Copilote est temporairement indisponible." : "Copilot request failed.", res.status);
        setCopilotLog((prev) => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: "assistant", text: msg };
          return copy;
        });
        return;
      }
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

  const firstPendingApproval = overview?.pending_approvals?.[0] || null;

  return (
    <div className="flex min-h-screen bg-[#F7F8FA] text-[#1D2935]">
      {/* Fixed Toast Feedback Notification (always visible regardless of scroll!) */}
      {feedback && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2.5 rounded-lg border px-4 py-3 text-xs shadow-lg ${
            feedback.kind === "ok"
              ? "border-[#CBE1D8] bg-[#EDF4F1] text-[#285447]"
              : "border-[#F3C5C5] bg-[#FDF2F2] text-[#9B1C1C]"
          }`}
        >
          {feedback.kind === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="flex-1 leading-relaxed">{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Slide-Over Command Copilot Drawer */}
      <CopilotDrawer
        open={copilotOpen}
        lang={lang}
        activeRequestRef={workspaceData?.request.reference_code}
        copilotLog={copilotLog}
        copilotInput={copilotInput}
        copilotStreaming={copilotStreaming}
        onChangeInput={setCopilotInput}
        onSend={sendCopilotMessage}
        onExecuteAction={executeCopilotClientAction}
        onFeedback={showFeedback}
        onClose={() => setCopilotOpen(false)}
      />

      {/* 224px Left Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-[#DEE4E9] bg-white">
        <div className="flex h-16 items-center gap-2.5 border-b border-[#DEE4E9] px-5">
          <img src="/logo.svg" alt="ProcureAI" className="h-6 w-6" />
          <span className="text-[15px] font-semibold tracking-tight">ProcureAI</span>
        </div>

        <div className="border-b border-[#DEE4E9] px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[#526170]">{t(lang, "workspace")}</div>
          <div className="mt-0.5 truncate text-sm font-semibold">{actor?.tenant_name || "..."}</div>
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
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left font-medium transition ${
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
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#EDF4F1] text-xs font-semibold text-[#285447]">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{actor?.display_name || "—"}</div>
              <div className="truncate text-xs text-[#526170]">{actor?.title || "—"}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] bg-white px-6 py-2">
          <div className="text-sm text-[#526170]">
            {t(lang, "workspace")} / <span className="font-medium text-[#1D2935]">{t(lang, NAV_I18N[activeNav])}</span>
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
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
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
              <RefreshCw className={`h-3.5 w-3.5 ${refreshingAll ? "animate-spin" : ""}`} />
              {t(lang, "refresh")}
            </button>
          </div>
        </header>

        <main className="flex-1 p-6">
          {/* ================= OVERVIEW & 6-STAGE PROCUREMENT FLOW ================= */}
          {activeNav === "overview" && (
            <div className="mx-auto max-w-6xl space-y-4">
              {/* Clean Header Row */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">{t(lang, "pageTitleOverview")}</h1>
                  <p className="mt-0.5 text-xs text-[#526170]">{t(lang, "pageSubOverview")}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setNewReqOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237]"
                >
                  {newReqOpen ? <X className="h-3.5 w-3.5" /> : <Plus className="h-4 w-4" />}
                  {newReqOpen ? t(lang, "closeNewRequest") : t(lang, "newRequest")}
                </button>
              </div>

              {/* Collapsible New Request Panel (AI Prompt + 2 Ready Scenarios) */}
              {newReqOpen && (
                <div className="rounded-lg border border-[#285447]/35 bg-white p-4 shadow-xs">
                  <form onSubmit={startAiIntake} className="flex flex-wrap gap-2">
                    <input
                      value={promptInput}
                      onChange={(e) => setPromptInput(e.target.value)}
                      placeholder={t(lang, "intakePlaceholder")}
                      className="min-w-[260px] flex-1 rounded-md border border-[#DEE4E9] px-3 py-2 text-sm focus:border-[#285447] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={submitting || !promptInput.trim()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {submitting ? t(lang, "working") : t(lang, "draftViaAi")}
                    </button>
                  </form>
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#DEE4E9] pt-3 text-xs">
                    <span className="text-[#526170]">{t(lang, "quickStartLabel")}</span>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void launchPreset("sousse")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#285447] bg-[#EDF4F1] px-3 py-1.5 font-medium text-[#285447] hover:bg-[#DDECE5] disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" />
                      {t(lang, "presetSousseBtn")}
                    </button>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => void launchPreset("global")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3 py-1.5 font-medium text-[#1D2935] hover:bg-[#F7F8FA] disabled:opacity-50"
                    >
                      <Play className="h-3 w-3 text-[#285447]" />
                      {t(lang, "presetGlobalBtn")}
                    </button>
                  </div>
                </div>
              )}

              {/* Compact 4-KPI Strip */}
              <div className="grid grid-cols-2 divide-x divide-[#DEE4E9] rounded-lg border border-[#DEE4E9] bg-white py-3 lg:grid-cols-4">
                <div className="px-4">
                  <div className="text-[11px] text-[#526170]">{t(lang, "kpiOpenRequests")}</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">
                    {overview?.kpis.open_requests ?? runs.length}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!firstPendingApproval}
                  onClick={() => {
                    if (!firstPendingApproval) return;
                    setSelectedRequestId(firstPendingApproval.request_id);
                    setStageJump({ stage: 5, seq: Date.now() });
                  }}
                  className={`px-4 text-left ${firstPendingApproval ? "hover:bg-[#FEF6EC]/50" : "cursor-default"}`}
                >
                  <div className="text-[11px] text-[#526170]">{t(lang, "kpiAwaitingApproval")}</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums text-[#9A5B13]">
                    {overview?.kpis.awaiting_approval ?? 0}
                  </div>
                </button>
                <div className="px-4">
                  <div className="text-[11px] text-[#526170]">{t(lang, "kpiQuotesToReview")}</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums">
                    {overview?.kpis.quotes_to_review ?? 0}
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-[11px] text-[#526170]">{t(lang, "kpiApprovedPos")}</div>
                  <div className="mt-0.5 text-lg font-semibold tabular-nums text-[#285447]">
                    {overview?.kpis.approved_pos ?? 0}
                  </div>
                </div>
              </div>

              {/* Compact Pending Approval Inbox (only shown when action is needed) */}
              {overview && overview.pending_approvals.length > 0 && (
                <div className="rounded-lg border border-[#F5DFC4] bg-[#FEF6EC] px-4 py-3">
                  <div className="divide-y divide-[#F5DFC4]/70">
                    {overview.pending_approvals.map((pa) => (
                      <div key={pa.approval_id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-[#9A5B13] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                            {t(lang, "inboxTitle")}
                          </span>
                          <span className="font-mono font-semibold text-[#1D2935]">{pa.reference_code}</span>
                          <span>·</span>
                          <span className="font-medium text-[#1D2935]">{pa.title}</span>
                          <span>·</span>
                          <span className="font-semibold text-[#285447]">
                            {pa.currency_code} {pa.amount}
                          </span>
                          <span className="text-[#526170]">
                            ({pa.decision_type === "po_release" ? (isFr ? "Émission BC" : "PO Release") : isFr ? "Attribution" : "Award"})
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRequestId(pa.request_id);
                            setStageJump({ stage: 5, seq: Date.now() });
                          }}
                          className="rounded-md bg-[#285447] px-3 py-1 text-xs font-semibold text-white hover:bg-[#1E4237]"
                        >
                          {t(lang, "inboxReviewBtn")}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Compact Request Selector Bar */}
              {runs.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  {runs.slice(0, 10).map((r) => {
                    const active = selectedRequestId === r.request_id;
                    return (
                      <button
                        key={r.run_id}
                        type="button"
                        onClick={() => setSelectedRequestId(r.request_id)}
                        className={`shrink-0 rounded-md border px-3 py-1.5 text-left text-xs transition ${
                          active
                            ? "border-[#285447] bg-white shadow-xs ring-1 ring-[#285447]/20"
                            : "border-[#DEE4E9] bg-white/70 hover:bg-white"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-[#1D2935]">{r.reference_code}</span>
                          <StatusBadge status={r.status} lang={lang} />
                        </div>
                        <div className="mt-0.5 max-w-[190px] truncate text-[11px] text-[#526170]">{r.title}</div>
                      </button>
                    );
                  })}
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
                <div className="rounded-lg border border-dashed border-[#DEE4E9] bg-white p-8 text-center text-sm text-[#526170]">
                  {isFr
                    ? "Cliquez sur « Nouvelle Demande » ou choisissez un scénario ci-dessus pour démarrer."
                    : "Click New Request or launch a ready demo scenario above to get started."}
                </div>
              )}
            </div>
          )}

          {/* ================= AGENTS & BACKGROUND LOG SCREEN ================= */}
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

          {/* ================= SUPPLIERS DIRECTORY TAB ================= */}
          {activeNav === "suppliers" && (
            <div className="mx-auto max-w-5xl space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight">{t(lang, "navSuppliers")}</h1>
                  <p className="mt-0.5 text-xs text-[#526170]">
                    {isFr
                      ? `Annuaire isolé pour ${actor?.tenant_name}. Les nouveaux fournisseurs démarrent non vérifiés jusqu'à validation.`
                      : `Isolated to ${actor?.tenant_name}. New suppliers start unverified until a buyer verifies them.`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCsvPanel((v) => !v)}
                  className="rounded-md border border-[#DEE4E9] bg-white px-3 py-1.5 text-xs font-medium text-[#1D2935] hover:bg-[#F7F8FA]"
                >
                  {showCsvPanel
                    ? t(lang, "closePreview")
                    : isFr
                    ? "Importer un CSV"
                    : "Import CSV"}
                </button>
              </div>

              {/* Inline Add Supplier Bar */}
              <form
                onSubmit={handleAddSupplier}
                className="grid grid-cols-1 gap-2 rounded-lg border border-[#DEE4E9] bg-white p-4 text-xs sm:grid-cols-12"
              >
                <input
                  value={newSupName}
                  onChange={(e) => setNewSupName(e.target.value)}
                  placeholder={isFr ? "Nom du fournisseur *" : "Supplier name *"}
                  className="rounded-md border border-[#DEE4E9] px-3 py-2 sm:col-span-4"
                />
                <input
                  value={newSupCategory}
                  onChange={(e) => setNewSupCategory(e.target.value)}
                  placeholder={isFr ? "Catégorie" : "Category"}
                  className="rounded-md border border-[#DEE4E9] px-3 py-2 sm:col-span-3"
                />
                <input
                  value={newSupEmail}
                  onChange={(e) => setNewSupEmail(e.target.value)}
                  placeholder={isFr ? "Email contact (optionnel)" : "Contact email (optional)"}
                  className="rounded-md border border-[#DEE4E9] px-3 py-2 sm:col-span-3"
                />
                <button
                  type="submit"
                  disabled={!newSupName.trim()}
                  className="inline-flex items-center justify-center gap-1 rounded-md bg-[#285447] px-3 py-2 font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50 sm:col-span-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {isFr ? "Ajouter" : "Add"}
                </button>
              </form>

              {/* Collapsible CSV Import */}
              {showCsvPanel && (
                <div className="space-y-3 rounded-lg border border-[#DEE4E9] bg-white p-4 text-xs">
                  <div className="font-semibold">
                    {isFr ? "Import CSV Validé (Aperçu & Confirmation)" : "Validated CSV Import (Preview & Confirm)"}
                  </div>
                  <textarea
                    rows={3}
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                    className="w-full rounded-md border border-[#DEE4E9] p-2 font-mono text-[11px]"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleCsvImport(false)}
                      className="rounded-md border border-[#DEE4E9] px-3 py-1.5 font-medium hover:bg-[#F7F8FA]"
                    >
                      {isFr ? "Aperçu CSV" : "Preview CSV"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCsvImport(true)}
                      className="rounded-md bg-[#285447] px-3 py-1.5 font-semibold text-white hover:bg-[#1E4237]"
                    >
                      {isFr ? "Confirmer l'import" : "Confirm Import"}
                    </button>
                    {csvPreview && (
                      <span className="rounded bg-[#F7F8FA] px-2.5 py-1 text-[11px] text-[#526170]">
                        {isFr ? "Valides" : "Valid"}: {csvPreview.valid_count} · {isFr ? "Doublons" : "Duplicates"}:{" "}
                        {csvPreview.duplicates.length} · {isFr ? "Erreurs" : "Errors"}: {csvPreview.errors.length}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Suppliers Table with Inline Email Editing (no window.prompt!) */}
              <div className="overflow-hidden rounded-lg border border-[#DEE4E9] bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-[#DEE4E9] bg-[#F7F8FA] text-xs text-[#526170]">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">{isFr ? "Fournisseur" : "Supplier"}</th>
                      <th className="px-4 py-2.5 font-medium">{isFr ? "Catégorie" : "Category"}</th>
                      <th className="px-4 py-2.5 font-medium">Contact</th>
                      <th className="px-4 py-2.5 font-medium">{isFr ? "Statut" : "Status"}</th>
                      <th className="px-4 py-2.5 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DEE4E9] text-xs">
                    {suppliers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-[#526170]">
                          {isFr ? "Aucun fournisseur enregistré." : "No suppliers in this workspace yet."}
                        </td>
                      </tr>
                    ) : (
                      suppliers.map((s) => (
                        <tr key={s.id}>
                          <td className="px-4 py-3 font-medium text-[#1D2935]">{s.name}</td>
                          <td className="px-4 py-3 text-[#526170]">{s.category}</td>
                          <td className="px-4 py-3 text-[#526170]">
                            {editingEmailSupId === s.id ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  value={editingEmailVal}
                                  onChange={(e) => setEditingEmailVal(e.target.value)}
                                  placeholder="contact@supplier.com"
                                  className="w-48 rounded border border-[#285447] px-2 py-1 text-xs text-[#1D2935]"
                                />
                                <button
                                  type="button"
                                  onClick={() => void handleSaveSupplierEmail(s.id)}
                                  className="rounded bg-[#285447] px-2 py-1 text-[11px] font-medium text-white"
                                >
                                  <Check className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingEmailSupId(null)}
                                  className="rounded border border-[#DEE4E9] px-2 py-1 text-[11px]"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ) : (
                              <>
                                <div>{s.contact_email || (isFr ? "Aucun email" : "No email")}</div>
                                <div className="text-[11px]">
                                  {s.phone || ""} {s.location ? `· ${s.location}` : ""}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded px-2 py-0.5 font-medium ${
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
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingEmailSupId(s.id);
                                  setEditingEmailVal(s.contact_email || "");
                                }}
                                className="rounded border border-[#DEE4E9] px-2 py-1 text-[11px] font-medium hover:bg-[#F7F8FA]"
                              >
                                {isFr ? "Email" : "Edit Email"}
                              </button>
                              {s.verification_status !== "approved" && (
                                <button
                                  type="button"
                                  onClick={() => void handleVerifySupplier(s.id)}
                                  className="rounded border border-[#285447] px-2 py-1 text-[11px] font-medium text-[#285447] hover:bg-[#EDF4F1]"
                                >
                                  {isFr ? "Vérifier" : "Verify"}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleDeleteSupplier(s.id)}
                                className="rounded border border-[#F3C5C5] px-2 py-1 text-[11px] font-medium text-[#9B1C1C] hover:bg-[#FDF2F2]"
                              >
                                {isFr ? "Supprimer" : "Remove"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ================= SPEND & EVALUATIONS TAB ================= */}
          {activeNav === "usage" && (
            <div className="mx-auto max-w-6xl space-y-5">
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{t(lang, "navUsage")}</h1>
                <p className="mt-0.5 text-xs text-[#526170]">
                  {isFr
                    ? "Gouvernance budgétaire OpenRouter (DeepSeek V4.1 Flash + Jev Router) & Tavily + Évaluation de sécurité."
                    : "Daily spend governance across OpenRouter (DeepSeek V4.1 Flash + Jev Router) & Tavily, plus Dev/Held-Out Evaluation Scorecard."}
                </p>
              </div>

              <div className="grid grid-cols-2 divide-x divide-[#DEE4E9] rounded-lg border border-[#DEE4E9] bg-white p-4 lg:grid-cols-4">
                <div className="px-4">
                  <div className="text-xs text-[#526170]">{isFr ? "Dépense 24h / plafond" : "Combined 24h spend / cap"}</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    ${usage?.combined_24h_spend_usd || "0.000000"} / ${usage?.daily_budget_usd || "5.00"}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    {isFr ? "Restant :" : "Remaining:"} ${usage?.remaining_24h_budget_usd || "5.00"}
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-xs text-[#526170]">OpenRouter (DeepSeek + Jev)</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    ${usage?.llm.observed_cost_usd || "0.000000"}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    {usage?.llm.total_calls ?? 0} {isFr ? "appels" : "calls"} · {usage?.llm.cache_hits ?? 0} cache ($0)
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-xs text-[#526170]">{isFr ? "Coût recherche Tavily" : "Tavily search spend"}</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    ${usage?.tavily.estimated_cost_usd || "0.000000"}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    {usage?.tavily.total_calls ?? 0} {isFr ? "recherches" : "searches"} · {usage?.tavily.total_credits ?? 0}{" "}
                    {isFr ? "crédits" : "credits"}
                  </div>
                </div>
                <div className="px-4">
                  <div className="text-xs text-[#526170]">{isFr ? "Jetons LLM" : "LLM tokens"}</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {(usage?.llm.prompt_tokens ?? 0) + (usage?.llm.completion_tokens ?? 0)}
                  </div>
                  <div className="text-[11px] text-[#526170]">
                    KV cache: {usage?.llm.cached_tokens ?? 0} · Reasoning: {usage?.llm.reasoning_tokens ?? 0}
                  </div>
                </div>
              </div>

              {/* Evaluation & Safety Benchmark Scorecard */}
              <div className="overflow-hidden rounded-lg border border-[#DEE4E9] bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-[#285447]" />
                    <div>
                      <h2 className="text-sm font-semibold">{t(lang, "evalSuiteTitle")}</h2>
                      {evalReport && (
                        <p className="text-xs text-[#526170]">
                          {isFr ? "Taux de réussite :" : "Pass rate:"} <strong>{evalReport.pass_rate_pct}%</strong> (
                          {evalReport.passed_cases}/{evalReport.total_cases}) · Dev: {evalReport.dev_summary.passed}/
                          {evalReport.dev_summary.total} · Held-out: {evalReport.held_out_summary.passed}/
                          {evalReport.held_out_summary.total}
                          {evalReport.live_model_route ? ` · Live: ${evalReport.live_model_route}` : ""}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={runningLiveEval}
                    onClick={() => void handleRunLiveBenchmark()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {runningLiveEval ? t(lang, "runningEval") : t(lang, "runLiveEvalBtn")}
                  </button>
                </div>
                {evalReport && (
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-[#DEE4E9] bg-[#F7F8FA] text-[#526170]">
                      <tr>
                        <th className="px-4 py-2">{isFr ? "Cas" : "Case"}</th>
                        <th className="px-4 py-2">Split</th>
                        <th className="px-4 py-2">{isFr ? "Catégorie" : "Invariant"}</th>
                        <th className="px-4 py-2">{isFr ? "Résultat" : "Result"}</th>
                        <th className="px-4 py-2">{isFr ? "Preuve" : "Evidence"}</th>
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

              <div className="overflow-hidden rounded-lg border border-[#DEE4E9] bg-white">
                <div className="border-b border-[#DEE4E9] px-5 py-3 text-sm font-semibold">
                  {isFr ? "Derniers appels OpenRouter (DeepSeek + Jev)" : "Recent OpenRouter LLM & Jev Router Calls"}
                </div>
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-[#DEE4E9] bg-[#F7F8FA] text-[#526170]">
                    <tr>
                      <th className="px-4 py-2">{isFr ? "Profil" : "Profile"}</th>
                      <th className="px-4 py-2">{isFr ? "Modèle" : "Model"}</th>
                      <th className="px-4 py-2">{isFr ? "Fournisseur" : "Provider"}</th>
                      <th className="px-4 py-2">In / Out</th>
                      <th className="px-4 py-2">{isFr ? "Coût (USD)" : "Cost (USD)"}</th>
                      <th className="px-4 py-2">{isFr ? "Statut" : "Outcome"}</th>
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

          {/* ================= SETTINGS, COMPANY PROFILE & EXTERNAL SEARCH TAB ================= */}
          {activeNav === "settings" && (
            <div className="mx-auto max-w-4xl space-y-5">
              <h1 className="text-2xl font-semibold tracking-tight">{t(lang, "navSettings")}</h1>

              {/* Editable Company Profile Card */}
              <form
                onSubmit={handleSaveCompanyProfile}
                className="space-y-4 rounded-lg border border-[#DEE4E9] bg-white p-5 text-xs"
              >
                <div className="border-b border-[#DEE4E9] pb-2.5">
                  <h2 className="text-sm font-semibold">{t(lang, "companyProfileTitle")}</h2>
                  <p className="mt-0.5 text-[#526170]">
                    {isFr
                      ? "Personnalisez le nom de l'entreprise, la ville, la devise et la langue affichés sur tous vos PDF."
                      : "Customize the company name, default city, base currency, and default language printed on all PDFs."}
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block font-medium text-[#526170]">
                      {isFr ? "Nom de l'entreprise" : "Company / Organization Name"}
                    </label>
                    <input
                      value={profName}
                      onChange={(e) => setProfName(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-[#526170]">
                      {isFr ? "Ville / Pays par défaut" : "Default Delivery City / Country"}
                    </label>
                    <input
                      value={profLocation}
                      onChange={(e) => setProfLocation(e.target.value)}
                      placeholder="Sousse, Tunisia"
                      className="mt-1 w-full rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-[#526170]">
                      {isFr ? "Devise par défaut" : "Base Currency"}
                    </label>
                    <select
                      value={profCurrency}
                      onChange={(e) => setProfCurrency(e.target.value)}
                      className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-sm"
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
                      className="mt-1 w-full rounded-md border border-[#DEE4E9] bg-white px-3 py-2 text-sm"
                    >
                      <option value="fr">Français (Demande de Prix / Bon de Commande)</option>
                      <option value="en">English (RFQ / Purchase Order)</option>
                    </select>
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={savingProfile || !tenantSettings?.can_edit_company_profile}
                  className="rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                >
                  {t(lang, "saveProfileBtn")}
                </button>
              </form>

              <div className="rounded-lg border border-[#DEE4E9] bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 font-semibold">
                      <Globe className="h-4 w-4 text-[#285447]" />
                      {isFr ? "Recherche externe de fournisseurs (Tavily)" : "External supplier lead search (Tavily)"}
                    </div>
                    <p className="mt-1 text-xs text-[#526170]">
                      {isFr ? "État :" : "Tenant toggle:"}{" "}
                      <strong>
                        {tenantSettings?.external_search_enabled
                          ? isFr
                            ? "Activée"
                            : "Enabled"
                          : isFr
                          ? "Désactivée"
                          : "Disabled"}
                      </strong>
                      .{" "}
                      {isFr
                        ? "Seul un administrateur (ex. Samira Vance) peut modifier ce paramètre."
                        : "Only Tenant Admins (e.g. Samira Vance) can change this setting."}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={!tenantSettings?.can_edit_settings || togglingSearch}
                    onClick={() => void toggleExternalSearch(!tenantSettings?.external_search_enabled)}
                    className="rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    {tenantSettings?.external_search_enabled
                      ? isFr
                        ? "Désactiver la recherche"
                        : "Disable external search"
                      : isFr
                      ? "Activer la recherche"
                      : "Enable external search"}
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-[#DEE4E9] bg-white p-5">
                <h2 className="text-sm font-semibold">
                  {isFr ? "Tester la découverte fournisseurs Tavily" : "Test Tavily External Supplier Discovery"}
                </h2>
                <form onSubmit={runManualTavilySearch} className="mt-3 flex gap-2">
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="flex-1 rounded-md border border-[#DEE4E9] px-3 py-2 text-sm"
                  />
                  <button
                    type="submit"
                    disabled={searchingLeads || !searchQuery.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E4237] disabled:opacity-50"
                  >
                    <Search className="h-4 w-4" />
                    {isFr ? "Rechercher" : "Search"}
                  </button>
                </form>
                {searchLeads.length > 0 && (
                  <div className="mt-4 divide-y divide-[#DEE4E9] rounded-md border border-[#DEE4E9]">
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
