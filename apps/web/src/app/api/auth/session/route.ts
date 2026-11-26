import { NextRequest, NextResponse } from "next/server";
import {
  DEV_PERSONAS,
  createSessionCookieHeader,
  getApiInternalUrl,
  getServerSession,
  isAllowedMutationOrigin,
  isDevAuthEnabled,
  signIdentityToken,
} from "@/lib/session";

export async function GET() {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ authenticated: false, dev_auth_enabled: isDevAuthEnabled() }, { status: 401 });
  }

  const assertion = signIdentityToken(session.tenantId, session.userId);
  const res = await fetch(`${getApiInternalUrl()}/api/v1/me`, {
    headers: { "X-ProcureAI-Assertion": assertion },
    cache: "no-store",
  });

  if (!res.ok) {
    return NextResponse.json(
      { authenticated: false, error: "Membership verification failed", dev_auth_enabled: isDevAuthEnabled() },
      { status: res.status }
    );
  }

  const actor = await res.json();
  return NextResponse.json({
    authenticated: true,
    dev_auth_enabled: isDevAuthEnabled(),
    actor,
    personas: isDevAuthEnabled() ? DEV_PERSONAS : [],
  });
}

export async function POST(req: NextRequest) {
  if (!isAllowedMutationOrigin(req)) {
    return NextResponse.json({ code: "CSRF_BLOCKED", message: "Cross-origin mutation denied." }, { status: 403 });
  }
  if (!isDevAuthEnabled()) {
    return NextResponse.json(
      { code: "POLICY_BLOCKED", message: "Dev test auth switcher is disabled in this environment." },
      { status: 403 }
    );
  }
  const body = await req.json().catch(() => ({}));
  const persona = DEV_PERSONAS.find((p) => p.id === body.persona_id);
  if (!persona) {
    return NextResponse.json({ code: "INVALID_PERSONA", message: "Unknown dev persona" }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, persona });
  response.cookies.set(createSessionCookieHeader(persona.tenant_id, persona.user_id));
  return response;
}
