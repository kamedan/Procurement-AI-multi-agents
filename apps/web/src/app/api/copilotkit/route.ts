import { NextRequest, NextResponse } from "next/server";
import {
  getApiInternalUrl,
  getServerSession,
  isAllowedMutationOrigin,
  signIdentityToken,
} from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!isAllowedMutationOrigin(req)) {
    return NextResponse.json({ code: "CSRF_BLOCKED", message: "Cross-origin mutation denied." }, { status: 403 });
  }
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
  }

  const bodyText = await req.text();
  const upstream = await fetch(`${getApiInternalUrl()}/api/ag-ui/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-ProcureAI-Assertion": signIdentityToken(session.tenantId, session.userId),
    },
    body: bodyText,
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "AG-UI upstream error");
    return NextResponse.json(
      { code: "AG_UI_UPSTREAM_ERROR", message: errText },
      { status: upstream.status || 502 }
    );
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
