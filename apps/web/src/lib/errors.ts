export async function readJsonSafe(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    if (data && typeof data === "object") {
      return data as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function formatApiError(data: unknown, fallback: string, statusCode?: number): string {
  if (!data || typeof data !== "object") {
    return statusCode ? `${statusCode}: ${fallback}` : fallback;
  }
  const obj = data as Record<string, unknown>;
  const detail = obj.detail;

  if (typeof detail === "string" && detail.trim()) {
    return detail.trim();
  }

  if (Array.isArray(detail) && detail.length > 0) {
    const parts = detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          const loc = Array.isArray(rec.loc) ? rec.loc.filter((p) => p !== "body").join(".") : "";
          const msg = typeof rec.msg === "string" ? rec.msg : "";
          if (loc && msg) return `${loc}: ${msg}`;
          if (msg) return msg;
        }
        return null;
      })
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.slice(0, 2).join(" · ");
    }
  }

  if (detail && typeof detail === "object") {
    const rec = detail as Record<string, unknown>;
    const code = typeof rec.code === "string" ? rec.code : "";
    const msg = typeof rec.message === "string" ? rec.message : "";
    if (code && msg) return `${code}: ${msg}`;
    if (msg) return msg;
  }

  if (typeof obj.message === "string" && obj.message.trim()) {
    return obj.message.trim();
  }

  return statusCode ? `${statusCode}: ${fallback}` : fallback;
}

export async function copyTextSafely(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to legacy textarea copy
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
