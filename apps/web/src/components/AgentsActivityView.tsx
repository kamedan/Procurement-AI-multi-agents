"use client";

import React, { useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  Globe,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";
import type { AgentsActivityData } from "./types";
import type { UiLang } from "@/lib/i18n";

interface Props {
  data: AgentsActivityData | null;
  lang: UiLang;
  onRefresh: () => Promise<void>;
  onSelectRequest: (requestId: string) => void;
}

const CATEGORIES = [
  { id: "all", en: "All Events", fr: "Tous les événements" },
  { id: "agent_step", en: "ReAct Steps", fr: "Étapes ReAct" },
  { id: "llm_call", en: "OpenRouter & Jev Calls", fr: "Appels OpenRouter & Jev" },
  { id: "tavily_search", en: "Tavily Web Search", fr: "Recherches Tavily" },
  { id: "worker_outbox", en: "Worker Outbox", fr: "File Worker Outbox" },
  { id: "domain_audit", en: "Domain Audit", fr: "Audit Métier" },
] as const;

export default function AgentsActivityView({ data, lang, onRefresh, onSelectRequest }: Props) {
  const isFr = lang === "fr";
  const [catFilter, setCatFilter] = useState<string>("all");
  const [reqFilter, setReqFilter] = useState<string>("all");
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [refreshing, setRefreshing] = useState(false);

  const uniqueRefs = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of data?.logs || []) {
      if (item.request_id && item.reference_code) {
        map.set(item.request_id, item.reference_code);
      }
    }
    return Array.from(map.entries());
  }, [data?.logs]);

  const filteredLogs = useMemo(() => {
    return (data?.logs || []).filter((item) => {
      if (catFilter !== "all" && item.category !== catFilter) return false;
      if (reqFilter !== "all" && item.request_id !== reqFilter) return false;
      return true;
    });
  }, [data?.logs, catFilter, reqFilter]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const worker = data?.worker;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">
            {isFr ? "Agents Spécialisés & Journal d'Activité" : "Specialized Agents & Background Log"}
          </h1>
          <p className="mt-1 text-sm text-[#526170]">
            {isFr
              ? "État temps réel des 6 rôles d'agents, du worker PostgreSQL LISTEN/NOTIFY et trace complète de chaque action en arrière-plan."
              : "Live status of all 6 bounded agent roles, PostgreSQL LISTEN/NOTIFY durable worker health, and complete background execution trace."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleManualRefresh()}
          className="inline-flex items-center gap-1.5 rounded-md border border-[#DEE4E9] bg-white px-3.5 py-2 text-xs font-medium hover:bg-[#F7F8FA]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {isFr ? "Actualiser les logs" : "Refresh Logs"}
        </button>
      </div>

      {/* Durable Worker & Outbox Queue Strip */}
      <div className="grid grid-cols-2 divide-x divide-[#DEE4E9] rounded-md border border-[#DEE4E9] bg-white p-4 lg:grid-cols-4">
        <div className="px-4">
          <div className="flex items-center gap-1.5 text-xs text-[#526170]">
            <Server className="h-3.5 w-3.5 text-[#285447]" />
            {isFr ? "Worker Durable" : "Durable Worker"}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${
                worker?.status === "healthy" ? "bg-[#EDF4F1] text-[#285447]" : "bg-[#FEF6EC] text-[#9A5B13]"
              }`}
            >
              <CheckCircle2 className="h-3 w-3" />
              {worker?.status || "loading"}
            </span>
            <span className="font-mono text-xs text-[#526170]">
              {worker?.heartbeat_age_seconds != null ? `hb ${worker.heartbeat_age_seconds}s ago` : "—"}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-[#526170]">Mode: PostgreSQL LISTEN/NOTIFY</div>
        </div>

        <div className="px-4">
          <div className="text-xs text-[#526170]">{isFr ? "Exécutions actives" : "Active Workflow Runs"}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">{worker?.active_runs ?? 0}</div>
          <div className="text-[11px] text-[#526170]">
            {isFr ? "Isolées par RLS multi-tenant" : "Tenant-scoped LangGraph checkpoints"}
          </div>
        </div>

        <div className="px-4">
          <div className="text-xs text-[#526170]">{isFr ? "File Outbox (En attente / En cours)" : "Outbox Queue (Pending / Active)"}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums">
            {worker?.outbox.pending ?? 0} / {worker?.outbox.processing ?? 0}
          </div>
          <div className="text-[11px] text-[#526170]">
            {isFr ? "Échecs : " : "Failed: "}
            <strong className={(worker?.outbox.failed ?? 0) > 0 ? "text-[#9B1C1C]" : "text-[#285447]"}>
              {worker?.outbox.failed ?? 0}
            </strong>
          </div>
        </div>

        <div className="px-4">
          <div className="text-xs text-[#526170]">{isFr ? "Événements Outbox traités" : "Processed Outbox Dispatches"}</div>
          <div className="mt-1 text-lg font-semibold tabular-nums text-[#285447]">{worker?.outbox.processed ?? 0}</div>
          <div className="text-[11px] text-[#526170]">
            {isFr ? "Réveil <10ms sans polling intensif" : "<10ms wakeup · throttled 10s heartbeat"}
          </div>
        </div>
      </div>

      {/* All 6 Specialized Agents Roster */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-[#526170]">
          {isFr ? "Catalogue des Agents & Moteurs Actifs (6)" : "Active Agent Roster & Authority Engines (6)"}
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(data?.agents || []).map((ag) => {
            const isRunning = ag.status === "running";
            const isDisabled = ag.status === "disabled_by_policy";
            const badgeStyle = isRunning
              ? "bg-[#EEF2F6] text-[#1D2935]"
              : isDisabled
              ? "bg-[#FEF6EC] text-[#9A5B13]"
              : "bg-[#EDF4F1] text-[#285447]";
            const statusText = isRunning
              ? isFr
                ? "En cours"
                : "Running"
              : isDisabled
              ? isFr
                ? "Désactivé (Politique)"
                : "Policy Disabled"
              : isFr
              ? "Opérationnel"
              : "Ready";

            return (
              <div key={ag.id} className="flex flex-col justify-between rounded-md border border-[#DEE4E9] bg-white p-4 text-xs">
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {ag.profile === "deterministic_authority" ? (
                        <ShieldCheck className="h-4 w-4 shrink-0 text-[#285447]" />
                      ) : ag.id.includes("supplier") ? (
                        <Globe className="h-4 w-4 shrink-0 text-[#285447]" />
                      ) : ag.id.includes("jev") ? (
                        <Cpu className="h-4 w-4 shrink-0 text-[#285447]" />
                      ) : (
                        <Bot className="h-4 w-4 shrink-0 text-[#285447]" />
                      )}
                      <span className="text-sm font-semibold text-[#1D2935]">
                        {isFr ? ag.name_fr : ag.name_en}
                      </span>
                    </div>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${badgeStyle}`}>
                      {statusText}
                    </span>
                  </div>
                  <p className="mt-2 text-[#526170]">{isFr ? ag.role_fr : ag.role_en}</p>
                </div>

                <div className="mt-3 space-y-1.5 border-t border-[#DEE4E9] pt-2.5 tabular-nums">
                  <div className="flex justify-between gap-2">
                    <span className="text-[#526170]">{isFr ? "Modèle / Moteur" : "Backbone"}</span>
                    <span className="truncate font-mono text-[11px] font-medium text-[#1D2935]">{ag.backbone}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#526170]">{isFr ? "Appels / Cache" : "Calls / Cache Hits"}</span>
                    <span className="font-medium">
                      {ag.calls} / <span className="text-[#285447]">{ag.cache_hits}</span>
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#526170]">{isFr ? "Latence moy. · Coût" : "Avg Latency · Spend"}</span>
                    <span className="font-medium">
                      {ag.avg_latency_ms} ms · ${ag.cost_usd}
                    </span>
                  </div>
                  {ag.last_active_at && (
                    <div className="flex justify-between text-[11px] text-[#526170]">
                      <span>{isFr ? "Dernière activité" : "Last active"}</span>
                      <span>{new Date(ag.last_active_at).toLocaleTimeString()}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Unified Chronological Background Log */}
      <div className="rounded-md border border-[#DEE4E9] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#DEE4E9] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-[#285447]" />
            <h2 className="text-sm font-semibold">
              {isFr ? "Journal Complet d'Exécution en Arrière-Plan" : "Complete Background Execution Log"} ({filteredLogs.length})
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <select
              value={reqFilter}
              onChange={(e) => setReqFilter(e.target.value)}
              className="rounded border border-[#DEE4E9] bg-white px-2.5 py-1.5 text-xs"
            >
              <option value="all">{isFr ? "Toutes les demandes" : "All Purchase Requests"}</option>
              {uniqueRefs.map(([rid, code]) => (
                <option key={rid} value={rid}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 border-b border-[#DEE4E9] bg-[#F7F8FA] px-5 py-2.5">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCatFilter(c.id)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                catFilter === c.id
                  ? "bg-[#285447] text-white"
                  : "border border-[#DEE4E9] bg-white text-[#526170] hover:text-[#1D2935]"
              }`}
            >
              {isFr ? c.fr : c.en}
            </button>
          ))}
        </div>

        <div className="divide-y divide-[#DEE4E9] text-xs">
          {filteredLogs.length === 0 ? (
            <div className="p-8 text-center text-[#526170]">
              {isFr ? "Aucun événement trouvé pour ce filtre." : "No background events recorded for this filter yet."}
            </div>
          ) : (
            filteredLogs.map((item) => {
              const isOpen = Boolean(expandedIds[item.id]);
              const catColor =
                item.category === "llm_call"
                  ? "bg-[#EDF4F1] text-[#285447]"
                  : item.category === "tavily_search"
                  ? "bg-[#EEF2F6] text-[#1D2935]"
                  : item.category === "worker_outbox"
                  ? "bg-[#FEF6EC] text-[#9A5B13]"
                  : item.category === "agent_step"
                  ? "bg-[#EDF4F1] text-[#285447]"
                  : "bg-[#F3F4F6] text-[#526170]";

              return (
                <div key={item.id} className="px-5 py-3 hover:bg-[#F7F8FA]/60">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex min-w-0 flex-1 items-start gap-2.5">
                      <button
                        type="button"
                        onClick={() => setExpandedIds((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                        className="mt-0.5 text-[#526170] hover:text-[#1D2935]"
                        aria-label="Toggle event JSON payload"
                      >
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${catColor}`}>
                            {item.source}
                          </span>
                          <span className="font-mono text-[11px] font-semibold text-[#1D2935]">{item.event_type}</span>
                          {item.reference_code && item.request_id && (
                            <button
                              type="button"
                              onClick={() => onSelectRequest(item.request_id!)}
                              className="rounded bg-[#EDF4F1] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[#285447] hover:underline"
                            >
                              {item.reference_code}
                            </button>
                          )}
                          <span className="rounded border border-[#DEE4E9] bg-white px-1.5 py-0.5 text-[10px] text-[#526170]">
                            {item.status}
                          </span>
                        </div>
                        <p className="mt-1 text-[#1D2935]">{item.summary}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-[#526170]">
                      <Clock className="h-3 w-3" />
                      {new Date(item.created_at).toLocaleTimeString()}
                    </div>
                  </div>

                  {isOpen && (
                    <pre className="mt-2 ml-6 max-h-52 overflow-auto rounded border border-[#DEE4E9] bg-[#F7F8FA] p-2.5 font-mono text-[11px] text-[#1D2935]">
                      {JSON.stringify(item.payload, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
