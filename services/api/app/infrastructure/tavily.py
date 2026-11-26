from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, ValidationError
from sqlalchemy import select

from app.config import settings
from app.domain.models import ExternalSearchEvent, TavilySearchCache, Tenant, new_id
from app.infrastructure.db import tenant_session
from app.infrastructure.openrouter import (
    ModelGatewayError,
    check_and_reserve_tenant_budget,
    release_reservation,
)

_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,12}\b")
_PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,3}\)?[\s.-]?){3,5}\d{2}")
_IGNORED_EMAIL_DOMAINS = (
    "example.com",
    "example.org",
    "sentry.io",
    "wixpress.com",
    "w3.org",
    "schema.org",
)
_IGNORED_EMAIL_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".js", ".css")


class ExternalLead(BaseModel):
    title: str
    url: str
    domain: str = ""
    snippet: str
    raw_excerpt: str = ""
    found_emails: list[str] = []
    found_phones: list[str] = []
    retrieved_at: str
    verification_status: str = "unverified_external_lead"


@dataclass(frozen=True)
class TavilySearchResult:
    leads: list[ExternalLead]
    credits_used: int
    estimated_cost_usd: Decimal
    latency_ms: int
    search_depth: str
    cache_hit: bool = False


_tavily_http_client: httpx.Client | None = None


def _get_tavily_http_client() -> httpx.Client:
    global _tavily_http_client
    if _tavily_http_client is None or _tavily_http_client.is_closed:
        _tavily_http_client = httpx.Client(
            timeout=20.0,
            limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
        )
    return _tavily_http_client


def _compute_tavily_cache_key(
    *,
    clean_query: str,
    depth: str,
    include_raw_content: bool,
    max_results: int,
) -> str:
    payload = json.dumps(
        {
            "q": clean_query.lower(),
            "d": depth,
            "raw": bool(include_raw_content),
            "max": int(max_results),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _is_safe_public_https_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower().strip(".")
    if host in ("localhost", "ip6-localhost") or host.endswith((".local", ".internal", ".localhost")):
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            return False
    except ValueError:
        pass
    return True


def _sanitize_untrusted_text(raw: str, max_len: int) -> str:
    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", str(raw or ""))
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:max_len]


def extract_real_emails(text: str) -> list[str]:
    seen: list[str] = []
    for match in _EMAIL_RE.findall(text or ""):
        low = match.lower()
        if any(low.endswith(ext) for ext in _IGNORED_EMAIL_EXTS):
            continue
        domain = low.split("@", 1)[-1]
        if any(domain == bad or domain.endswith("." + bad) for bad in _IGNORED_EMAIL_DOMAINS):
            continue
        if low not in seen:
            seen.append(low)
    return seen[:5]


def extract_real_phones(text: str) -> list[str]:
    seen: list[str] = []
    for match in _PHONE_RE.findall(text or ""):
        digits = re.sub(r"\D", "", match)
        if 8 <= len(digits) <= 14:
            cleaned = re.sub(r"\s+", " ", match.strip())
            if cleaned not in seen:
                seen.append(cleaned)
    return seen[:4]


class TavilySearchAdapter:
    ENDPOINT = "https://api.tavily.com/search"

    def is_enabled_for_tenant(self, tenant_id: str) -> tuple[bool, str]:
        if not settings.external_search_enabled:
            return False, "External search is disabled at server level (PROCUREAI_EXTERNAL_SEARCH_ENABLED=false)."
        if not settings.tavily_api_key or settings.tavily_api_key.startswith("tvly-replace"):
            return False, "TAVILY_API_KEY is not configured."
        with tenant_session(tenant_id) as db:
            tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one_or_none()
            if tenant is None or not tenant.external_search_enabled:
                return False, "External search is disabled in this tenant's workspace settings."
        return True, "enabled"

    def _lookup_cache(self, *, tenant_id: str, cache_key: str) -> list[ExternalLead] | None:
        if settings.tavily_cache_ttl_seconds <= 0:
            return None
        now = datetime.now(timezone.utc)
        with tenant_session(tenant_id) as db:
            row = db.execute(
                select(TavilySearchCache).where(
                    TavilySearchCache.tenant_id == tenant_id,
                    TavilySearchCache.cache_key == cache_key,
                    TavilySearchCache.expires_at > now,
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            try:
                leads = [ExternalLead.model_validate(item) for item in (row.leads_json or [])]
            except ValidationError:
                return None
            row.hit_count += 1
            return leads

    def _store_cache(
        self,
        *,
        tenant_id: str,
        cache_key: str,
        clean_query: str,
        depth: str,
        include_raw_content: bool,
        leads: list[ExternalLead],
    ) -> None:
        if settings.tavily_cache_ttl_seconds <= 0:
            return
        expires = datetime.now(timezone.utc) + timedelta(seconds=settings.tavily_cache_ttl_seconds)
        serialized = [lead.model_dump(mode="json") for lead in leads]
        with tenant_session(tenant_id) as db:
            existing = db.execute(
                select(TavilySearchCache).where(
                    TavilySearchCache.tenant_id == tenant_id,
                    TavilySearchCache.cache_key == cache_key,
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.leads_json = serialized
                existing.expires_at = expires
            else:
                db.add(
                    TavilySearchCache(
                        id=new_id("tvc"),
                        tenant_id=tenant_id,
                        cache_key=cache_key,
                        query_preview=clean_query[:160],
                        search_depth=depth,
                        include_raw_content=bool(include_raw_content),
                        leads_json=serialized,
                        hit_count=0,
                        expires_at=expires,
                    )
                )

    def search_leads(
        self,
        *,
        tenant_id: str,
        actor_user_id: str,
        query: str,
        run_id: str | None = None,
        max_results: int = 5,
        search_depth: str = "basic",
        include_raw_content: bool = False,
        use_cache: bool = True,
    ) -> TavilySearchResult:
        enabled, reason = self.is_enabled_for_tenant(tenant_id)
        if not enabled:
            raise ModelGatewayError("POLICY_BLOCKED", reason)

        depth = "advanced" if search_depth == "advanced" else "basic"
        credits = 2 if depth == "advanced" else 1
        est_cost = (Decimal(credits) * settings.tavily_cost_per_credit_usd).quantize(Decimal("0.000001"))

        clean_query = _sanitize_untrusted_text(query, 280)
        if not clean_query:
            raise ModelGatewayError("INVALID_QUERY", "Search query must not be empty.")
        bounded = max(1, min(max_results, 6))
        query_hash = "sha256:" + hashlib.sha256(clean_query.lower().encode("utf-8")).hexdigest()
        cache_key = _compute_tavily_cache_key(
            clean_query=clean_query,
            depth=depth,
            include_raw_content=include_raw_content,
            max_results=bounded,
        )

        # 1. Tenant-scoped RLS-protected Tavily cache ($0.000000 / 0 credits on hit!)
        if use_cache and settings.tavily_cache_ttl_seconds > 0:
            t0 = time.perf_counter()
            cached_leads = self._lookup_cache(tenant_id=tenant_id, cache_key=cache_key)
            if cached_leads is not None:
                hit_ms = max(1, int((time.perf_counter() - t0) * 1000))
                with tenant_session(tenant_id) as db:
                    db.add(
                        ExternalSearchEvent(
                            id=new_id("tsv"),
                            tenant_id=tenant_id,
                            run_id=run_id,
                            actor_user_id=actor_user_id,
                            provider="tavily_cache",
                            query_hash=query_hash,
                            query_preview=clean_query[:160],
                            search_depth=depth,
                            results_count=len(cached_leads),
                            credits_used=0,
                            estimated_cost_usd=Decimal("0.000000"),
                            cost_status="observed",
                            latency_ms=hit_ms,
                            outcome="cache_hit",
                        )
                    )
                return TavilySearchResult(
                    leads=cached_leads,
                    credits_used=0,
                    estimated_cost_usd=Decimal("0.000000"),
                    latency_ms=hit_ms,
                    search_depth=depth,
                    cache_hit=True,
                )

        reservation_id = check_and_reserve_tenant_budget(
            tenant_id=tenant_id,
            run_id=run_id,
            profile="tavily_search",
            estimated_usd=est_cost,
        )

        payload = {
            "api_key": settings.tavily_api_key,
            "query": clean_query,
            "search_depth": depth,
            "max_results": bounded,
            "include_answer": False,
            "include_raw_content": include_raw_content,
        }

        started = time.perf_counter()
        outcome = "success"
        leads: list[ExternalLead] = []
        err_to_raise: Exception | None = None

        try:
            client = _get_tavily_http_client()
            resp = client.post(self.ENDPOINT, json=payload)
            if resp.status_code >= 400:
                raise ModelGatewayError("EXTERNAL_SEARCH_FAILED", f"Tavily returned HTTP {resp.status_code}")
            data = resp.json()

            now_iso = datetime.now(timezone.utc).isoformat()
            for item in data.get("results") or []:
                url = str(item.get("url") or "").strip()
                if not _is_safe_public_https_url(url):
                    continue
                domain = (urlparse(url).hostname or "").lower()
                snippet = _sanitize_untrusted_text(item.get("content") or "", 400)
                raw_full = str(item.get("raw_content") or "")
                combined_for_contacts = f"{snippet}\n{raw_full[:12000]}"
                leads.append(
                    ExternalLead(
                        title=_sanitize_untrusted_text(item.get("title") or domain or "Untitled lead", 180),
                        url=url[:500],
                        domain=domain,
                        snippet=snippet,
                        raw_excerpt=_sanitize_untrusted_text(raw_full, 1200),
                        found_emails=extract_real_emails(combined_for_contacts),
                        found_phones=extract_real_phones(combined_for_contacts),
                        retrieved_at=now_iso,
                        verification_status="unverified_external_lead",
                    )
                )
        except ModelGatewayError as exc:
            outcome = "failed"
            err_to_raise = exc
        except Exception as exc:
            outcome = "failed"
            err_to_raise = ModelGatewayError("EXTERNAL_SEARCH_FAILED", f"Tavily transport error: {exc}")
        finally:
            latency_ms = int((time.perf_counter() - started) * 1000)
            release_reservation(tenant_id, reservation_id)
            with tenant_session(tenant_id) as db:
                db.add(
                    ExternalSearchEvent(
                        id=new_id("tsv"),
                        tenant_id=tenant_id,
                        run_id=run_id,
                        actor_user_id=actor_user_id,
                        provider="tavily",
                        query_hash=query_hash,
                        query_preview=clean_query[:160],
                        search_depth=depth,
                        results_count=len(leads),
                        credits_used=credits,
                        estimated_cost_usd=est_cost,
                        cost_status="estimated",
                        latency_ms=latency_ms,
                        outcome=outcome,
                    )
                )

        if err_to_raise is not None:
            raise err_to_raise

        if use_cache:
            self._store_cache(
                tenant_id=tenant_id,
                cache_key=cache_key,
                clean_query=clean_query,
                depth=depth,
                include_raw_content=include_raw_content,
                leads=leads,
            )

        return TavilySearchResult(
            leads=leads,
            credits_used=credits,
            estimated_cost_usd=est_cost,
            latency_ms=latency_ms,
            search_depth=depth,
            cache_hit=False,
        )


tavily_search = TavilySearchAdapter()
