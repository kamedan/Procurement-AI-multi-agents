from __future__ import annotations

"""
Explicit demo/test fixture seeder (never auto-run in production startup).
Usage inside container:
  docker compose --env-file .env -f infra/compose.yaml run --rm migrate python -m app.seed_demo
"""

import os
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.domain.models import Membership, Supplier, Tenant, User


def seed_demo() -> None:
    env = os.environ.get("PROCUREAI_ENV", "development").lower()
    if env == "production":
        raise RuntimeError("Refusing to seed synthetic demo tenants when PROCUREAI_ENV=production")

    owner_url = os.environ.get("DATABASE_OWNER_URL")
    if not owner_url:
        raise RuntimeError("DATABASE_OWNER_URL is required to seed tenants")

    engine = create_engine(owner_url, pool_pre_ping=True)

    tenants = [
        Tenant(id="tenant_meridian", name="Meridian Works", base_currency="TND", timezone="Africa/Tunis"),
        Tenant(id="tenant_northwind", name="Northwind Labs", base_currency="USD", timezone="UTC"),
    ]
    users = [
        User(id="user_daniel", email="daniel.okafor@meridian.example", display_name="Daniel Okafor", title="Engineering Lead"),
        User(id="user_ada", email="ada.morgan@meridian.example", display_name="Ada Morgan", title="Procurement Manager"),
        User(id="user_samira", email="samira.vance@meridian.example", display_name="Samira Vance", title="Tenant Admin"),
        User(id="user_omar", email="omar.haddad@northwind.example", display_name="Omar Haddad", title="Operations Buyer"),
        User(id="user_claire", email="claire.lin@northwind.example", display_name="Claire Lin", title="Finance Approver"),
    ]
    memberships = [
        Membership(
            id="mem_meridian_daniel",
            tenant_id="tenant_meridian",
            user_id="user_daniel",
            roles_json=["requester", "buyer"],
            approval_limit_usd=None,
            is_active=True,
        ),
        Membership(
            id="mem_meridian_ada",
            tenant_id="tenant_meridian",
            user_id="user_ada",
            roles_json=["buyer", "approver"],
            approval_limit_usd=Decimal("100000.00"),
            is_active=True,
        ),
        # Admin without financial approval authority (verifies admin != approver invariant)
        Membership(
            id="mem_meridian_samira",
            tenant_id="tenant_meridian",
            user_id="user_samira",
            roles_json=["tenant_admin"],
            approval_limit_usd=None,
            is_active=True,
        ),
        Membership(
            id="mem_northwind_omar",
            tenant_id="tenant_northwind",
            user_id="user_omar",
            roles_json=["requester", "buyer"],
            approval_limit_usd=None,
            is_active=True,
        ),
        Membership(
            id="mem_northwind_claire",
            tenant_id="tenant_northwind",
            user_id="user_claire",
            roles_json=["approver"],
            approval_limit_usd=Decimal("100000.00"),
            is_active=True,
        ),
    ]

    with Session(engine) as session:
        with session.begin():
            for t in tenants:
                session.merge(t)
            for u in users:
                session.merge(u)
            for m in memberships:
                session.merge(m)

    engine.dispose()
    print("Seeded isolated dev tenants and users (no fake suppliers seeded; discover real suppliers via Tavily or add your own).", flush=True)


if __name__ == "__main__":
    seed_demo()
