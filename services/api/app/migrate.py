from __future__ import annotations

import os
import sys

from langgraph.checkpoint.postgres import PostgresSaver
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from sqlalchemy import create_engine, text

from app.domain.models import Base, TENANT_SCOPED_TABLES


def run_migrations() -> None:
    owner_url = os.environ.get("DATABASE_OWNER_URL")
    checkpoint_owner_url = os.environ.get("DATABASE_CHECKPOINT_OWNER_URL")
    app_user = os.environ.get("POSTGRES_APP_USER", "procureai_app")
    app_password = os.environ.get("POSTGRES_APP_PASSWORD", "")

    if not owner_url or not checkpoint_owner_url:
        raise RuntimeError("DATABASE_OWNER_URL and DATABASE_CHECKPOINT_OWNER_URL are required for migrate")

    engine = create_engine(owner_url, pool_pre_ping=True)

    # 1. Ensure runtime role exists with NOBYPASSRLS and synced password (PostgreSQL DDL requires SQL literal)
    with engine.begin() as conn:
        conn.execute(text("CREATE SCHEMA IF NOT EXISTS langgraph_checkpoints"))
        role_exists = conn.execute(
            text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": app_user}
        ).scalar_one_or_none()
        raw_cur = conn.connection.cursor()
        if not role_exists:
            raw_cur.execute(
                sql.SQL(
                    "CREATE ROLE {} LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
                ).format(sql.Identifier(app_user), sql.Literal(app_password))
            )
        elif app_password:
            raw_cur.execute(
                sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD {} NOSUPERUSER NOBYPASSRLS").format(
                    sql.Identifier(app_user), sql.Literal(app_password)
                )
            )
        raw_cur.close()

    # 2. Create canonical application tables & idempotent column upgrades
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE tenants "
                "ADD COLUMN IF NOT EXISTS external_search_enabled BOOLEAN NOT NULL DEFAULT true"
            )
        )
        conn.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_location VARCHAR(200)"))
        conn.execute(text("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_language VARCHAR(8) NOT NULL DEFAULT 'en'"))
        conn.execute(text("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS location VARCHAR(200)"))
        conn.execute(text("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS document_language VARCHAR(8) NOT NULL DEFAULT 'en'"))
        conn.execute(text("ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS apply_fiscal_stamp BOOLEAN NOT NULL DEFAULT false"))
        conn.execute(text("ALTER TABLE purchase_requests ALTER COLUMN budget_cap TYPE NUMERIC(16, 3)"))
        conn.execute(text("ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone VARCHAR(64)"))
        conn.execute(text("ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS location VARCHAR(200)"))
        conn.execute(text("ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS source_url VARCHAR(500)"))
        conn.execute(text("ALTER TABLE quotations ALTER COLUMN unit_price TYPE NUMERIC(16, 3)"))
        conn.execute(text("ALTER TABLE quotations ALTER COLUMN discount_amount TYPE NUMERIC(16, 3)"))
        conn.execute(text("ALTER TABLE quotations ALTER COLUMN freight_amount TYPE NUMERIC(16, 3)"))
        conn.execute(text("ALTER TABLE quotations ALTER COLUMN quoted_tax_amount TYPE NUMERIC(16, 3)"))
        conn.execute(text("ALTER TABLE quotations ADD COLUMN IF NOT EXISTS fiscal_stamp_amount NUMERIC(16, 3) NOT NULL DEFAULT 0.000"))
        conn.execute(text("ALTER TABLE approval_requests ALTER COLUMN amount TYPE NUMERIC(16, 3)"))
        conn.execute(text("ALTER TABLE purchase_orders ALTER COLUMN total_amount TYPE NUMERIC(16, 3)"))

        # P1 Composite hot-path indexes for tenant queries & sorts
        for ddl in (
            "CREATE INDEX IF NOT EXISTS ix_workflow_runs_tenant_created ON workflow_runs (tenant_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_workflow_runs_tenant_request ON workflow_runs (tenant_id, request_id)",
            "CREATE INDEX IF NOT EXISTS ix_approval_req_tenant_status_created ON approval_requests (tenant_id, status, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_approval_req_tenant_request ON approval_requests (tenant_id, request_id)",
            "CREATE INDEX IF NOT EXISTS ix_ai_res_tenant_status_created ON ai_usage_reservations (tenant_id, status, created_at)",
            "CREATE INDEX IF NOT EXISTS ix_ai_usage_tenant_created ON ai_usage_events (tenant_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_ext_search_tenant_created ON external_search_events (tenant_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_audit_tenant_created ON audit_events (tenant_id, created_at DESC)",
            "CREATE INDEX IF NOT EXISTS ix_rfqs_tenant_request ON rfqs (tenant_id, request_id)",
            "CREATE INDEX IF NOT EXISTS ix_quotations_tenant_request ON quotations (tenant_id, request_id)",
            "CREATE INDEX IF NOT EXISTS ix_comparisons_tenant_request ON comparisons (tenant_id, request_id)",
            "CREATE INDEX IF NOT EXISTS ix_purchase_orders_tenant_request ON purchase_orders (tenant_id, request_id)",
        ):
            conn.execute(text(ddl))

    # 3. Apply forced Row-Level Security (fail-closed when app.current_tenant_id is unset)
    with engine.begin() as conn:
        # Track migration completion marker for readiness check
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    version VARCHAR(64) PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
        )

        # Tenants table RLS: a tenant session can see only its own tenant row
        conn.execute(text("ALTER TABLE tenants ENABLE ROW LEVEL SECURITY"))
        conn.execute(text("ALTER TABLE tenants FORCE ROW LEVEL SECURITY"))
        conn.execute(text("DROP POLICY IF EXISTS p_tenants_isolation ON tenants"))
        conn.execute(
            text(
                """
                CREATE POLICY p_tenants_isolation ON tenants
                USING (id = NULLIF(current_setting('app.current_tenant_id', true), ''))
                WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), ''))
                """
            )
        )

        for table in TENANT_SCOPED_TABLES:
            conn.execute(text(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY"))
            conn.execute(text(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY"))
            conn.execute(text(f"DROP POLICY IF EXISTS p_{table}_tenant_isolation ON {table}"))
            if table == "outbox_events":
                # Outbox allows tenant-scoped access plus narrow worker dispatch claim mode
                conn.execute(
                    text(
                        f"""
                        CREATE POLICY p_{table}_tenant_isolation ON {table}
                        USING (
                            tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')
                            OR current_setting('app.worker_dispatch', true) = 'true'
                        )
                        WITH CHECK (
                            tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')
                            OR current_setting('app.worker_dispatch', true) = 'true'
                        )
                        """
                    )
                )
            else:
                conn.execute(
                    text(
                        f"""
                        CREATE POLICY p_{table}_tenant_isolation ON {table}
                        USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
                        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), ''))
                        """
                    )
                )

        # Grant minimal DML privileges to runtime role (never DDL/ownership)
        conn.execute(text(f"GRANT USAGE ON SCHEMA public TO {app_user}"))
        conn.execute(text(f"GRANT USAGE ON SCHEMA langgraph_checkpoints TO {app_user}"))
        conn.execute(text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {app_user}"))
        conn.execute(text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {app_user}"))
        conn.execute(
            text(
                """
                INSERT INTO schema_migrations_meta (version)
                VALUES ('20261126_0005_showcase_bilingual_p1')
                ON CONFLICT (version) DO NOTHING
                """
            )
        )

    # 4. Initialize LangGraph Postgres checkpointer tables inside private langgraph_checkpoints schema
    pool = ConnectionPool(
        conninfo=checkpoint_owner_url,
        min_size=1,
        max_size=4,
        kwargs={"autocommit": True, "row_factory": dict_row},
    )
    try:
        saver = PostgresSaver(pool)
        saver.setup()
    finally:
        pool.close()

    with engine.begin() as conn:
        conn.execute(
            text(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph_checkpoints TO {app_user}")
        )
        conn.execute(
            text(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA langgraph_checkpoints TO {app_user}")
        )

    engine.dispose()
    print("ProcureAI migrations, RLS policies, and private checkpoint schema complete.", flush=True)


if __name__ == "__main__":
    try:
        run_migrations()
    except Exception as exc:
        print(f"Migration failed: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
