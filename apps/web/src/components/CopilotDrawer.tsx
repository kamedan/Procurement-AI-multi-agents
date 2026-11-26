"use client";

import React, { useEffect, useRef } from "react";
import { Copy, Send, Sparkles, X } from "lucide-react";
import { copyTextSafely } from "@/lib/errors";
import { t, type UiLang } from "@/lib/i18n";
import type { CopilotAction } from "./types";

export interface CopilotMsg {
  role: "user" | "assistant";
  text: string;
  action?: CopilotAction | null;
  emailDraft?: { subject: string; body: string } | null;
}

interface Props {
  open: boolean;
  lang: UiLang;
  activeRequestRef?: string | null;
  copilotLog: CopilotMsg[];
  copilotInput: string;
  copilotStreaming: boolean;
  onChangeInput: (val: string) => void;
  onSend: (e: React.FormEvent, overrideText?: string) => Promise<void>;
  onExecuteAction: (act: CopilotAction) => void;
  onFeedback: (kind: "ok" | "error", text: string) => void;
  onClose: () => void;
}

export default function CopilotDrawer({
  open,
  lang,
  activeRequestRef,
  copilotLog,
  copilotInput,
  copilotStreaming,
  onChangeInput,
  onSend,
  onExecuteAction,
  onFeedback,
  onClose,
}: Props) {
  const isFr = lang === "fr";
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [copilotLog, open]);

  if (!open) return null;

  const quickPrompts = isFr
    ? [
        "Pourquoi les autres devis sont-ils exclus ?",
        "Rédige un email de clarification fournisseur en français",
        "Modifie la quantité à 12 dans le brouillon",
      ]
    : [
        "Why were the other quotes disqualified?",
        "Draft a supplier clarification email for unconfirmed specs",
        "Change quantity to 12 in the request draft",
      ];

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-[#1D2935]/25"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="ProcureAI Copilot"
    >
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-[#DEE4E9] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#DEE4E9] bg-[#F7F8FA] px-4 py-3.5">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#EDF4F1] text-[#285447]">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-[#1D2935]">
                {isFr ? "Copilote ProcureAI" : "ProcureAI Copilot"}
              </div>
              <div className="text-[11px] text-[#526170]">
                {activeRequestRef
                  ? `${isFr ? "Contexte" : "Active"}: ${activeRequestRef}`
                  : isFr
                  ? "Assistant achats (ne valide jamais seul)"
                  : "Procurement assistant (proposes only)"}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(lang, "closePreview")}
            className="rounded-md p-1.5 text-[#526170] hover:bg-white hover:text-[#1D2935]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quick prompts */}
        <div className="border-b border-[#DEE4E9] bg-white px-4 py-2.5">
          <div className="mb-1.5 text-[11px] font-medium text-[#526170]">
            {isFr ? "Suggestions rapides :" : "Quick questions:"}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {quickPrompts.map((sample, idx) => (
              <button
                key={idx}
                type="button"
                disabled={copilotStreaming}
                onClick={(e) => void onSend(e, sample)}
                className="rounded-full border border-[#DEE4E9] bg-[#F7F8FA] px-2.5 py-1 text-left text-[11px] text-[#1D2935] transition hover:border-[#285447] hover:bg-[#EDF4F1] hover:text-[#285447] disabled:opacity-50"
              >
                {sample}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 text-xs">
          {copilotLog.length === 0 ? (
            <div className="rounded-md border border-[#DEE4E9] bg-[#F7F8FA] p-4 text-[#526170]">
              <p className="font-medium text-[#1D2935]">
                {isFr ? "Comment puis-je vous aider ?" : "How can I help with this purchase?"}
              </p>
              <p className="mt-1">
                {isFr
                  ? "Je peux expliquer le comparatif, rédiger un email fournisseur, ou pré-remplir une modification de demande. Les approbations restent toujours sous votre contrôle."
                  : "Ask why a quote was excluded, draft a supplier follow-up email, or pre-fill edits in Stage 1. Approvals always stay under human control."}
              </p>
            </div>
          ) : (
            copilotLog.map((m, i) => (
              <div
                key={i}
                className={`rounded-md p-3 ${
                  m.role === "user"
                    ? "ml-6 bg-[#F7F8FA] text-[#1D2935]"
                    : "mr-2 border border-[#CBE1D8] bg-[#EDF4F1]/60 text-[#1D2935]"
                }`}
              >
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#526170]">
                  {m.role === "user" ? (isFr ? "Vous" : "You") : "Copilot"}
                </div>
                <div className="whitespace-pre-wrap leading-relaxed">{m.text || "..."}</div>

                {m.emailDraft && (
                  <div className="mt-2.5 rounded border border-[#DEE4E9] bg-white p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-[#1D2935]">{m.emailDraft.subject}</span>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await copyTextSafely(
                            `Subject: ${m.emailDraft!.subject}\n\n${m.emailDraft!.body}`
                          );
                          onFeedback(
                            ok ? "ok" : "error",
                            ok
                              ? isFr
                                ? "Brouillon copié dans le presse-papiers."
                                : "Email draft copied to clipboard."
                              : isFr
                              ? "Impossible de copier automatiquement."
                              : "Could not copy automatically."
                          );
                        }}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-[#DEE4E9] px-2 py-0.5 text-[11px] font-medium hover:bg-[#F7F8FA]"
                      >
                        <Copy className="h-3 w-3" />
                        {t(lang, "copy")}
                      </button>
                    </div>
                    <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[11px] text-[#526170]">
                      {m.emailDraft.body}
                    </pre>
                  </div>
                )}

                {m.action && (
                  <div className="mt-2.5">
                    <button
                      type="button"
                      onClick={() => {
                        onExecuteAction(m.action!);
                        onClose();
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#1E4237]"
                    >
                      {m.action.label}
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Input */}
        <form onSubmit={(e) => void onSend(e)} className="border-t border-[#DEE4E9] bg-white p-3">
          <div className="flex gap-2">
            <input
              value={copilotInput}
              onChange={(e) => onChangeInput(e.target.value)}
              placeholder={
                isFr ? "Posez une question ou demandez une action..." : "Ask a question or describe an edit..."
              }
              className="flex-1 rounded-md border border-[#DEE4E9] px-3 py-2 text-xs focus:border-[#285447] focus:outline-none"
            />
            <button
              type="submit"
              disabled={copilotStreaming || !copilotInput.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#285447] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#1E4237] disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {copilotStreaming ? "..." : isFr ? "Envoyer" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
