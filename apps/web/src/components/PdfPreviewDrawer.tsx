"use client";

import React, { useEffect } from "react";
import { Download, ExternalLink, X } from "lucide-react";
import { t, type UiLang } from "@/lib/i18n";

interface Props {
  preview: { url: string; title: string } | null;
  lang: UiLang;
  onClose: () => void;
}

export default function PdfPreviewDrawer({ preview, lang, onClose }: Props) {
  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview, onClose]);

  if (!preview) return null;

  const downloadUrl = preview.url.replace("?inline=1", "");

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-[#1D2935]/40 backdrop-blur-[1px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={preview.title}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col border-l border-[#DEE4E9] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DEE4E9] bg-[#F7F8FA] px-4 py-3 text-xs">
          <div className="min-w-0 truncate text-sm font-semibold text-[#1D2935]">{preview.title}</div>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={preview.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-[#DEE4E9] bg-white px-2.5 py-1.5 font-medium text-[#1D2935] hover:bg-[#EDF4F1]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t(lang, "openNewTab")}
            </a>
            <a
              href={downloadUrl}
              className="inline-flex items-center gap-1 rounded-md border border-[#DEE4E9] bg-white px-2.5 py-1.5 font-medium text-[#1D2935] hover:bg-[#EDF4F1]"
            >
              <Download className="h-3.5 w-3.5" />
              {t(lang, "downloadPdf")}
            </a>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-md bg-[#285447] px-2.5 py-1.5 font-medium text-white hover:bg-[#1E4237]"
            >
              <X className="h-3.5 w-3.5" />
              {t(lang, "closePreview")}
            </button>
          </div>
        </div>
        <div className="flex-1 bg-[#E5E9ED]">
          <iframe title={preview.title} src={preview.url} className="h-full w-full border-0" />
        </div>
      </div>
    </div>
  );
}
