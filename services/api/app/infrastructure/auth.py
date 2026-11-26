from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from decimal import Decimal

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select

from app.config import settings
from app.domain.models import Membership, Tenant, User
from app.domain.money import to_usd_equivalent_for_limit
from app.infrastructure.db import tenant_session


@dataclass(frozen=True)
class ActorContext:
    tenant_id: str
    tenant_name: str
    base_currency: str
    default_location: str | None
    default_language: str
    tenant_external_search_enabled: bool
    user_id: str
    email: str
    display_name: str
    title: str
    roles: tuple[str, ...]
    approval_limit_usd: Decimal | None

    def has_role(self, role: str) -> bool:
        return role in self.roles

    def can_approve_amount(self, amount: Decimal, currency_code: str = "USD") -> bool:
        if not self.has_role("approver") or self.approval_limit_usd is None:
            return False
        usd_equiv = to_usd_equivalent_for_limit(amount, currency_code)
        return usd_equiv <= self.approval_limit_usd


def create_signed_assertion(tenant_id: str, user_id: str, ttl_seconds: int = 300) -> str:
    payload = {
        "tid": tenant_id,
        "uid": user_id,
        "exp": int(time.time()) + ttl_seconds,
    }
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    b64 = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    sig = hmac.new(settings.session_secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{b64}.{sig}"


def verify_signed_assertion(token: str) -> tuple[str, str]:
    if not token or "." not in token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing server identity assertion")
    b64, sig = token.split(".", 1)
    expected = hmac.new(settings.session_secret.encode("utf-8"), b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid server identity signature")
    padded = b64 + "=" * (-len(b64) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed identity assertion") from exc
    if int(payload.get("exp", 0)) < int(time.time()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Expired identity assertion")
    tid = payload.get("tid")
    uid = payload.get("uid")
    if not isinstance(tid, str) or not isinstance(uid, str) or not tid or not uid:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incomplete identity assertion")
    return tid, uid


def resolve_actor_context(tenant_id: str, user_id: str) -> ActorContext:
    with tenant_session(tenant_id) as db:
        tenant = db.execute(select(Tenant).where(Tenant.id == tenant_id)).scalar_one_or_none()
        if tenant is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tenant access denied")
        membership = db.execute(
            select(Membership).where(
                Membership.tenant_id == tenant_id,
                Membership.user_id == user_id,
                Membership.is_active.is_(True),
            )
        ).scalar_one_or_none()
        if membership is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Active tenant membership required")
        user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="User not found")
        return ActorContext(
            tenant_id=tenant.id,
            tenant_name=tenant.name,
            base_currency=tenant.base_currency,
            default_location=tenant.default_location,
            default_language=(tenant.default_language or "en"),
            tenant_external_search_enabled=bool(tenant.external_search_enabled),
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            title=user.title,
            roles=tuple(membership.roles_json or []),
            approval_limit_usd=membership.approval_limit_usd,
        )


def get_current_actor(
    x_procureai_assertion: str | None = Header(default=None, alias="X-ProcureAI-Assertion"),
) -> ActorContext:
    """
    FastAPI dependency: verifies HMAC-signed assertion emitted by the Next.js BFF
    and resolves current membership & authority fresh from PostgreSQL.
    Browser-supplied tenant/role headers are never trusted.
    """
    if not x_procureai_assertion:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
    tid, uid = verify_signed_assertion(x_procureai_assertion)
    return resolve_actor_context(tid, uid)
