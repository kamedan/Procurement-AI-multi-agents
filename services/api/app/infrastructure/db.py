from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine = create_engine(
    settings.database_app_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=10,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@contextmanager
def tenant_session(tenant_id: str) -> Iterator[Session]:
    """Open a transaction with PostgreSQL RLS tenant context bound via SET LOCAL."""
    if not tenant_id or not tenant_id.strip():
        raise ValueError("tenant_id is required to open a tenant-scoped DB session")
    session = SessionLocal()
    try:
        with session.begin():
            session.execute(
                text("SELECT set_config('app.current_tenant_id', :tid, true)"),
                {"tid": tenant_id},
            )
            yield session
    finally:
        session.close()


@contextmanager
def worker_dispatch_session() -> Iterator[Session]:
    """
    Worker poll session with worker dispatch flag set ONLY for claiming pending outbox items.
    All actual workflow execution re-opens a strict single-tenant session via tenant_session().
    """
    session = SessionLocal()
    try:
        with session.begin():
            session.execute(text("SELECT set_config('app.worker_dispatch', 'true', true)"))
            yield session
    finally:
        session.close()
