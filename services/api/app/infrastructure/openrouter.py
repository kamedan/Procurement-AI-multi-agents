from __future__ import annotations

import copy
import hashlib
import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from functools import lru_cache
from typing import TypeVar

import httpx
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select, text

from app.config import settings
from app.domain.models import (
    AiUsageEvent,
    AiUsageReservation,
    ExternalSearchEvent,
    LlmResponseCache,
    new_id,
)
from app.infrastructure.db import tenant_session

T = TypeVar("T", bound=BaseModel)


class ModelGatewayError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class GatewayResult:
    parsed: BaseModel
    requested_model: str
    actual_model: str
    provider: str | None
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    reasoning_tokens: int
    cost_usd: Decimal | None
    cost_status: str
    latency_ms: int
    cache_hit: bool = False


def _normalize_input_text(raw: str, max_chars: int = 2400) -> str:
    """Compact whitespace and cap prompt length to avoid wasted tokens."""
    collapsed = re.sub(r"\s+", " ", raw.strip())
    return collapsed[:max_chars]


def _compute_cache_key(
    *,
    profile: str,
    requested_model: str,
    prompt_version: str,
    schema_version: str,
    system_prompt: str,
    normalized_user_prompt: str,
) -> str:
    payload = json.dumps(
        {
            "p": profile,
            "m": requested_model,
            "pv": prompt_version,
            "sv": schema_version,
            "sys": system_prompt,
            "u": normalized_user_prompt.lower(),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


_http_client: httpx.Client | None = None


def _get_openrouter_http_client() -> httpx.Client:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.Client(
            timeout=settings.openrouter_timeout_seconds,
            limits=httpx.Limits(max_keepalive_connections=16, max_connections=32),
        )
    return _http_client


def _is_router_model(model_id: str) -> bool:
    low = (model_id or "").lower()
    return "router" in low or low.startswith("typesafe/")


@lru_cache(maxsize=64)
def _strict_schema_cached(schema_cls: type[BaseModel]) -> dict:
    raw = schema_cls.model_json_schema()

    def _close_objects(node: dict) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "object" and "properties" in node:
            node["additionalProperties"] = False
            node["required"] = list(node["properties"].keys())
            for prop in node["properties"].values():
                _close_objects(prop)
        if "$defs" in node:
            for d in node["$defs"].values():
                _close_objects(d)
        if "items" in node and isinstance(node["items"], dict):
            _close_objects(node["items"])
        for branch_key in ("anyOf", "oneOf", "allOf"):
            if branch_key in node and isinstance(node[branch_key], list):
                for item in node[branch_key]:
                    _close_objects(item)

    _close_objects(raw)
    return raw


def _strict_schema_for_model(schema_cls: type[BaseModel]) -> dict:
    return copy.deepcopy(_strict_schema_cached(schema_cls))


def check_and_reserve_tenant_budget(
    *,
    tenant_id: str,
    run_id: str | None,
    profile: str,
    estimated_usd: Decimal,
) -> str:
    """
    Atomically checks combined 24h spend (OpenRouter LLM + Tavily external search + pending reservations)
    under a PostgreSQL transaction-scoped advisory lock so concurrent workers cannot overspend.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    with tenant_session(tenant_id) as db:
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:lock_key))"),
            {"lock_key": f"budget:{tenant_id}"},
        )
        llm_sum = db.execute(
            select(func.coalesce(func.sum(AiUsageEvent.cost_usd), Decimal("0"))).where(
                AiUsageEvent.tenant_id == tenant_id,
                AiUsageEvent.created_at >= since,
            )
        ).scalar_one()
        tavily_sum = db.execute(
            select(func.coalesce(func.sum(ExternalSearchEvent.estimated_cost_usd), Decimal("0"))).where(
                ExternalSearchEvent.tenant_id == tenant_id,
                ExternalSearchEvent.created_at >= since,
            )
        ).scalar_one()
        pending_sum = db.execute(
            select(func.coalesce(func.sum(AiUsageReservation.reserved_usd), Decimal("0"))).where(
                AiUsageReservation.tenant_id == tenant_id,
                AiUsageReservation.status == "reserved",
                AiUsageReservation.created_at >= since,
            )
        ).scalar_one()

        projected = Decimal(llm_sum) + Decimal(tavily_sum) + Decimal(pending_sum) + estimated_usd
        if projected > settings.tenant_daily_ai_budget_usd:
            raise ModelGatewayError(
                "USAGE_LIMIT_REACHED",
                f"Combined daily tenant spend limit (${settings.tenant_daily_ai_budget_usd} USD) reached.",
            )

        reservation_id = new_id("res")
        db.add(
            AiUsageReservation(
                id=reservation_id,
                tenant_id=tenant_id,
                run_id=run_id,
                profile=profile,
                reserved_usd=estimated_usd,
                status="reserved",
            )
        )
        return reservation_id


def release_reservation(tenant_id: str, reservation_id: str) -> None:
    with tenant_session(tenant_id) as db:
        res = db.execute(
            select(AiUsageReservation).where(
                AiUsageReservation.tenant_id == tenant_id,
                AiUsageReservation.id == reservation_id,
            )
        ).scalar_one_or_none()
        if res is not None:
            res.status = "reconciled"


class OpenRouterGateway:
    """
    Single server-side OpenRouter gateway configured for DeepSeek V4.1 Flash.
    LLM Cost & Token Optimizations:
    - Tenant-scoped RLS-protected exact normalized response cache ($0.00 / 0 tokens on repeat)
    - Byte-identical static system prompt prefix to maximize DeepSeek V4.1 Flash KV-cache hits
    - Whitespace normalization & bounded prompt length
    - Tight max_output_tokens + reasoning disabled on strict extraction
    - Combined LLM + Tavily atomic daily budget enforcement via PostgreSQL advisory lock
    - Provider privacy controls (data_collection=deny, zdr, require_parameters, allow_fallbacks=false)
    """

    def _model_for_profile(self, profile: str) -> str:
        if profile == "extraction":
            return settings.openrouter_model_extraction
        if profile == "decision":
            return settings.openrouter_model_decision
        if profile == "reasoning":
            return settings.openrouter_model_reasoning
        if profile == "vision":
            return settings.openrouter_model_vision
        raise ModelGatewayError("MODEL_CAPABILITY_UNAVAILABLE", f"Unknown model profile: {profile}")

    def _lookup_cache(
        self,
        *,
        tenant_id: str,
        cache_key: str,
        schema_cls: type[T],
    ) -> T | None:
        now = datetime.now(timezone.utc)
        with tenant_session(tenant_id) as db:
            row = db.execute(
                select(LlmResponseCache).where(
                    LlmResponseCache.tenant_id == tenant_id,
                    LlmResponseCache.cache_key == cache_key,
                    LlmResponseCache.expires_at > now,
                )
            ).scalar_one_or_none()
            if row is None:
                return None
            try:
                parsed = schema_cls.model_validate(row.response_json)
            except ValidationError:
                return None
            row.hit_count += 1
            return parsed

    def _store_cache(
        self,
        *,
        tenant_id: str,
        cache_key: str,
        profile: str,
        requested_model: str,
        prompt_version: str,
        schema_version: str,
        parsed: BaseModel,
    ) -> None:
        if settings.llm_cache_ttl_seconds <= 0:
            return
        expires = datetime.now(timezone.utc) + timedelta(seconds=settings.llm_cache_ttl_seconds)
        payload = parsed.model_dump(mode="json")
        with tenant_session(tenant_id) as db:
            existing = db.execute(
                select(LlmResponseCache).where(
                    LlmResponseCache.tenant_id == tenant_id,
                    LlmResponseCache.cache_key == cache_key,
                )
            ).scalar_one_or_none()
            if existing is not None:
                existing.response_json = payload
                existing.expires_at = expires
            else:
                db.add(
                    LlmResponseCache(
                        id=new_id("lrc"),
                        tenant_id=tenant_id,
                        cache_key=cache_key,
                        profile=profile,
                        requested_model=requested_model,
                        prompt_version=prompt_version,
                        schema_version=schema_version,
                        response_json=payload,
                        hit_count=0,
                        expires_at=expires,
                    )
                )

    def _reconcile_usage(
        self,
        *,
        tenant_id: str,
        run_id: str | None,
        reservation_id: str | None,
        profile: str,
        requested_model: str,
        actual_model: str | None,
        provider: str | None,
        prompt_version: str,
        schema_version: str,
        prompt_tokens: int,
        completion_tokens: int,
        cached_tokens: int,
        reasoning_tokens: int,
        cost_usd: Decimal | None,
        cost_status: str,
        latency_ms: int,
        outcome: str,
    ) -> None:
        with tenant_session(tenant_id) as db:
            if reservation_id:
                res = db.execute(
                    select(AiUsageReservation).where(
                        AiUsageReservation.tenant_id == tenant_id,
                        AiUsageReservation.id == reservation_id,
                    )
                ).scalar_one_or_none()
                if res is not None:
                    res.status = "reconciled"
            db.add(
                AiUsageEvent(
                    id=new_id("aiu"),
                    tenant_id=tenant_id,
                    run_id=run_id,
                    reservation_id=reservation_id,
                    profile=profile,
                    requested_model=requested_model,
                    actual_model=actual_model,
                    provider=provider,
                    prompt_version=prompt_version,
                    schema_version=schema_version,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    cached_tokens=cached_tokens,
                    reasoning_tokens=reasoning_tokens,
                    cost_usd=cost_usd,
                    cost_status=cost_status,
                    latency_ms=latency_ms,
                    outcome=outcome,
                )
            )

    def invoke_structured(
        self,
        *,
        tenant_id: str,
        run_id: str | None,
        profile: str,
        prompt_version: str,
        schema_version: str,
        schema_cls: type[T],
        system_prompt: str,
        user_prompt: str,
        max_output_tokens: int = 512,
        max_input_chars: int = 2800,
        use_cache: bool = True,
    ) -> GatewayResult:
        requested_model = self._model_for_profile(profile)
        normalized_user = _normalize_input_text(user_prompt, max_chars=max_input_chars)
        cache_key = _compute_cache_key(
            profile=profile,
            requested_model=requested_model,
            prompt_version=prompt_version,
            schema_version=schema_version,
            system_prompt=system_prompt,
            normalized_user_prompt=normalized_user,
        )

        # 1. Tenant-scoped exact normalized response cache ($0.00 / 0 tokens)
        if use_cache and settings.llm_cache_ttl_seconds > 0:
            t0 = time.perf_counter()
            cached = self._lookup_cache(tenant_id=tenant_id, cache_key=cache_key, schema_cls=schema_cls)
            if cached is not None:
                latency_ms = max(1, int((time.perf_counter() - t0) * 1000))
                self._reconcile_usage(
                    tenant_id=tenant_id,
                    run_id=run_id,
                    reservation_id=None,
                    profile=profile,
                    requested_model=requested_model,
                    actual_model=requested_model,
                    provider="tenant_cache",
                    prompt_version=prompt_version,
                    schema_version=schema_version,
                    prompt_tokens=0,
                    completion_tokens=0,
                    cached_tokens=0,
                    reasoning_tokens=0,
                    cost_usd=Decimal("0.000000"),
                    cost_status="observed",
                    latency_ms=latency_ms,
                    outcome="cache_hit",
                )
                return GatewayResult(
                    parsed=cached,
                    requested_model=requested_model,
                    actual_model=requested_model,
                    provider="tenant_cache",
                    prompt_tokens=0,
                    completion_tokens=0,
                    cached_tokens=0,
                    reasoning_tokens=0,
                    cost_usd=Decimal("0.000000"),
                    cost_status="observed",
                    latency_ms=latency_ms,
                    cache_hit=True,
                )

        if not settings.openrouter_api_key or settings.openrouter_api_key.startswith("sk-or-v1-replace"):
            raise ModelGatewayError(
                "MODEL_CAPABILITY_UNAVAILABLE",
                "OPENROUTER_API_KEY is not configured; live inference is unavailable.",
            )

        est_usd = Decimal("0.005000")
        reservation_id = check_and_reserve_tenant_budget(
            tenant_id=tenant_id,
            run_id=run_id,
            profile=profile,
            estimated_usd=est_usd,
        )

        json_schema = _strict_schema_for_model(schema_cls)

        def _build_body(target_model: str) -> dict[str, object]:
            is_router = _is_router_model(target_model)
            provider_policy: dict[str, object] = {
                "data_collection": settings.openrouter_data_collection,
                "require_parameters": settings.openrouter_require_parameters,
            }
            if settings.openrouter_require_zdr:
                provider_policy["zdr"] = True
            if is_router:
                provider_policy["max_price"] = {
                    "prompt": settings.openrouter_jev_max_prompt_usd_per_m,
                    "completion": settings.openrouter_jev_max_completion_usd_per_m,
                }
            else:
                provider_policy["allow_fallbacks"] = False

            req_body: dict[str, object] = {
                "model": target_model,
                "temperature": 0,
                "max_tokens": max_output_tokens,
                "provider": provider_policy,
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": schema_cls.__name__,
                        "strict": True,
                        "schema": json_schema,
                    },
                },
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": normalized_user},
                ],
            }
            if not is_router:
                if profile == "extraction":
                    req_body["reasoning"] = {"enabled": False}
                else:
                    req_body["reasoning"] = {"effort": "low"}
            return req_body

        headers = {
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": settings.openrouter_app_url,
            "X-Title": settings.openrouter_app_title,
        }

        last_err: Exception | None = None
        started = time.perf_counter()
        prompt_tokens = 0
        completion_tokens = 0
        cached_tokens = 0
        reasoning_tokens = 0
        actual_model: str | None = None
        provider_name: str | None = None
        cost_usd: Decimal | None = None
        cost_status = "pending_reconciliation"

        primary_attempts = max(1, settings.openrouter_max_retries + 1)
        fallback_model = (settings.openrouter_model_fallback or settings.openrouter_model_extraction).strip()
        model_plan: list[str] = [requested_model] * primary_attempts
        if _is_router_model(requested_model) and fallback_model and fallback_model != requested_model:
            model_plan.append(fallback_model)

        client = _get_openrouter_http_client()
        for attempt, candidate_model in enumerate(model_plan):
            try:
                body = _build_body(candidate_model)
                resp = client.post(f"{settings.openrouter_base_url}/chat/completions", headers=headers, json=body)
                if resp.status_code >= 500 or resp.status_code == 429 or (
                    resp.status_code == 404 and _is_router_model(candidate_model)
                ):
                    last_err = ModelGatewayError(
                        "MODEL_CAPABILITY_UNAVAILABLE",
                        f"OpenRouter transient/routing status {resp.status_code} on {candidate_model}",
                    )
                    if attempt < len(model_plan) - 1:
                        time.sleep(0.4 * (min(attempt, 2) + 1))
                        continue
                    raise last_err
                if resp.status_code >= 400:
                    last_err = ModelGatewayError(
                        "MODEL_CAPABILITY_UNAVAILABLE",
                        f"OpenRouter rejected request ({resp.status_code}): {resp.text[:240]}",
                    )
                    if _is_router_model(candidate_model) and attempt < len(model_plan) - 1:
                        continue
                    raise last_err

                data = resp.json()
                actual_model = data.get("model") or requested_model
                provider_name = data.get("provider")
                usage = data.get("usage") or {}
                prompt_tokens += int(usage.get("prompt_tokens") or 0)
                completion_tokens += int(usage.get("completion_tokens") or 0)
                cached_tokens += int((usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
                reasoning_tokens += int((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
                if usage.get("cost") is not None:
                    cost_usd = Decimal(str(usage["cost"]))
                    cost_status = "observed"

                content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
                parsed = schema_cls.model_validate_json(content)
                latency_ms = int((time.perf_counter() - started) * 1000)

                if use_cache:
                    self._store_cache(
                        tenant_id=tenant_id,
                        cache_key=cache_key,
                        profile=profile,
                        requested_model=requested_model,
                        prompt_version=prompt_version,
                        schema_version=schema_version,
                        parsed=parsed,
                    )

                self._reconcile_usage(
                    tenant_id=tenant_id,
                    run_id=run_id,
                    reservation_id=reservation_id,
                    profile=profile,
                    requested_model=requested_model,
                    actual_model=actual_model,
                    provider=provider_name,
                    prompt_version=prompt_version,
                    schema_version=schema_version,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    cached_tokens=cached_tokens,
                    reasoning_tokens=reasoning_tokens,
                    cost_usd=cost_usd,
                    cost_status=cost_status,
                    latency_ms=latency_ms,
                    outcome="success",
                )
                return GatewayResult(
                    parsed=parsed,
                    requested_model=requested_model,
                    actual_model=actual_model,
                    provider=provider_name,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    cached_tokens=cached_tokens,
                    reasoning_tokens=reasoning_tokens,
                    cost_usd=cost_usd,
                    cost_status=cost_status,
                    latency_ms=latency_ms,
                    cache_hit=False,
                )
            except (ValidationError, json.JSONDecodeError) as exc:
                last_err = ModelGatewayError("MODEL_SCHEMA_INVALID", f"Invalid structured output: {exc}")
                if attempt < len(model_plan) - 1:
                    continue
                break
            except ModelGatewayError as exc:
                last_err = exc
                break
            except Exception as exc:
                last_err = ModelGatewayError("MODEL_CAPABILITY_UNAVAILABLE", f"OpenRouter transport error: {exc}")
                if attempt < len(model_plan) - 1:
                    time.sleep(0.4 * (min(attempt, 2) + 1))
                    continue
                break

        latency_ms = int((time.perf_counter() - started) * 1000)
        self._reconcile_usage(
            tenant_id=tenant_id,
            run_id=run_id,
            reservation_id=reservation_id,
            profile=profile,
            requested_model=requested_model,
            actual_model=actual_model,
            provider=provider_name,
            prompt_version=prompt_version,
            schema_version=schema_version,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            cost_usd=cost_usd,
            cost_status=cost_status,
            latency_ms=latency_ms,
            outcome="failed",
        )
        assert last_err is not None
        raise last_err


gateway = OpenRouterGateway()
