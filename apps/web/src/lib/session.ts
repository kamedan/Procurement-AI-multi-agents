import crypto from "node:crypto";
import fs from "node:fs";
import { cookies } from "next/headers";

export interface DevPersona {
  id: string;
  tenant_id: string;
  tenant_name: string;
  user_id: string;
  display_name: string;
  title: string;
  roles_label: string;
}

export const DEV_PERSONAS: DevPersona[] = [
  {
    id: "meridian-daniel",
    tenant_id: "tenant_meridian",
    tenant_name: "Meridian Works",
    user_id: "user_daniel",
    display_name: "Daniel Okafor",
    title: "Engineering Lead",
    roles_label: "Requester · Buyer (No approval limit)",
  },
  {
    id: "meridian-ada",
    tenant_id: "tenant_meridian",
    tenant_name: "Meridian Works",
    user_id: "user_ada",
    display_name: "Ada Morgan",
    title: "Procurement Manager",
    roles_label: "Buyer · Approver up to $25,000",
  },
  {
    id: "meridian-samira",
    tenant_id: "tenant_meridian",
    tenant_name: "Meridian Works",
    user_id: "user_samira",
    display_name: "Samira Vance",
    title: "Tenant Admin",
    roles_label: "Tenant Admin (No approval authority)",
  },
  {
    id: "northwind-omar",
    tenant_id: "tenant_northwind",
    tenant_name: "Northwind Labs",
    user_id: "user_omar",
    display_name: "Omar Haddad",
    title: "Operations Buyer",
    roles_label: "Tenant B · Requester · Buyer",
  },
  {
    id: "northwind-claire",
    tenant_id: "tenant_northwind",
    tenant_name: "Northwind Labs",
    user_id: "user_claire",
    display_name: "Claire Lin",
    title: "Finance Approver",
    roles_label: "Tenant B · Approver up to $50,000",
  },
];

const COOKIE_NAME = "procureai_session";

function getSessionSecret(): string {
  const file = process.env.PROCUREAI_SESSION_SECRET_FILE;
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8").trim();
  }
  return process.env.PROCUREAI_SESSION_SECRET || "";
}

export function isDevAuthEnabled(): boolean {
  return (
    process.env.PROCUREAI_ENV !== "production" &&
    process.env.PROCUREAI_DEV_AUTH_ENABLED === "true"
  );
}

export function getApiInternalUrl(): string {
  return (process.env.API_INTERNAL_URL || "http://api:8000").replace(/\/$/, "");
}

/**
 * CSRF defense for cookie-authenticated mutations:
 * If Origin (or Referer) is present, it must match the request host or configured NEXT_PUBLIC_APP_URL.
 */
export function isAllowedMutationOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // Allow non-browser / same-origin CLI tests without Origin header; browsers always send Origin on cross-site POST/PATCH.
    return true;
  }
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  const host = req.headers.get("host");
  try {
    const parsedOrigin = new URL(origin);
    if (configured) {
      const parsedConfigured = new URL(configured);
      if (parsedOrigin.origin === parsedConfigured.origin) return true;
    }
    if (host && parsedOrigin.host === host) return true;
  } catch {
    return false;
  }
  return false;
}

export function signIdentityToken(tenantId: string, userId: string, ttlSeconds = 300): string {
  const secret = getSessionSecret();
  if (!secret) {
    throw new Error("PROCUREAI_SESSION_SECRET is not configured on web server");
  }
  const payload = JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    tid: tenantId,
    uid: userId,
  });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

export function verifySessionCookie(raw: string | undefined): { tenantId: string; userId: string } | null {
  if (!raw || !raw.includes(".")) return null;
  const secret = getSessionSecret();
  if (!secret) return null;
  const [b64, sig] = raw.split(".", 2);
  const expected = crypto.createHmac("sha256", secret).update(b64).digest("hex");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof parsed.tid !== "string" || typeof parsed.uid !== "string") return null;
    return { tenantId: parsed.tid, userId: parsed.uid };
  } catch {
    return null;
  }
}

export async function getServerSession(): Promise<{ tenantId: string; userId: string } | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE_NAME)?.value;
  const verified = verifySessionCookie(raw);
  if (verified) return verified;

  // Explicitly labeled dev-only default persona when no cookie is set yet
  if (isDevAuthEnabled()) {
    return { tenantId: "tenant_meridian", userId: "user_daniel" };
  }
  return null;
}

export function createSessionCookieHeader(tenantId: string, userId: string): {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    name: COOKIE_NAME,
    value: signIdentityToken(tenantId, userId, 60 * 60 * 12),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.PROCUREAI_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  };
}
