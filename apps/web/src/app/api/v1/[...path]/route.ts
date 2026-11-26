import { NextRequest, NextResponse } from "next/server";
import {
  getApiInternalUrl,
  getServerSession,
  isAllowedMutationOrigin,
  signIdentityToken,
} from "@/lib/session";

export const dynamic = "force-dynamic";

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function validatePathSegments(segments: string[]): string | null {
  if (!segments || segments.length === 0 || segments.length > 8) return null;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || !SAFE_SEGMENT_RE.test(seg)) {
      return null;
    }
  }
  return segments.join("/");
}

async function proxyToApi(req: NextRequest, pathSegments: string[]) {
  if (req.method !== "GET" && req.method !== "HEAD" && !isAllowedMutationOrigin(req)) {
    return NextResponse.json({ code: "CSRF_BLOCKED", message: "Cross-origin mutation denied." }, { status: 403 });
  }

  const safePath = validatePathSegments(pathSegments);
  if (!safePath) {
    return NextResponse.json({ code: "INVALID_PATH", message: "Invalid API resource path." }, { status: 400 });
  }

  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
  }

  const search = req.nextUrl.search || "";
  const url = `${getApiInternalUrl()}/api/v1/${safePath}${search}`;

  const headers = new Headers();
  headers.set("X-ProcureAI-Assertion", signIdentityToken(session.tenantId, session.userId));

  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const idemKey = req.headers.get("idempotency-key");
  if (idemKey) headers.set("idempotency-key", idemKey);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);

  const method = req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(url, {
    method,
    headers,
    body,
    cache: "no-store",
  });

  const respHeaders = new Headers();
  const upstreamType = upstream.headers.get("content-type") || "application/json";
  respHeaders.set("content-type", upstreamType);
  respHeaders.set("x-content-type-options", "nosniff");
  const contentDisposition = upstream.headers.get("content-disposition");
  if (contentDisposition) {
    respHeaders.set("content-disposition", contentDisposition);
  }

  if (upstreamType.includes("text/event-stream")) {
    respHeaders.set("cache-control", "no-cache, no-transform");
    respHeaders.set("connection", "keep-alive");
    respHeaders.set("x-accel-buffering", "no");
    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  }

  const rawBody = await upstream.arrayBuffer();
  return new Response(rawBody, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export async function GET(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyToApi(req, path);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyToApi(req, path);
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyToApi(req, path);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyToApi(req, path);
}
