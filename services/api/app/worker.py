from __future__ import annotations

import signal
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg
from sqlalchemy import or_, select

from app.agents.m0_graph import checkpoint_adapter, close_checkpoint_pool
from app.config import settings
from app.domain.models import OutboxEvent
from app.infrastructure.db import worker_dispatch_session

HEARTBEAT_PATH = Path("/tmp/procureai/worker.heartbeat")
_shutdown_requested = False
_last_heartbeat_ts = 0.0


def _handle_signal(signum: int, _frame) -> None:
    global _shutdown_requested
    _shutdown_requested = True
    print(f"Worker received signal {signum}; finishing active lease and exiting cleanly...", flush=True)


def _touch_heartbeat(*, force: bool = False) -> None:
    """Throttled heartbeat writer (once every 10s instead of 2 Hz) to eliminate idle disk churn."""
    global _last_heartbeat_ts
    now_ts = time.time()
    if not force and (now_ts - _last_heartbeat_ts) < 10.0:
        return
    HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
    HEARTBEAT_PATH.write_text(str(int(now_ts)), encoding="utf-8")
    _last_heartbeat_ts = now_ts


def _pg_listen_conninfo() -> str:
    return settings.database_app_url.replace("postgresql+psycopg://", "postgresql://", 1)


def _claim_next_outbox_event() -> OutboxEvent | None:
    now = datetime.now(timezone.utc)
    lease_until = now + timedelta(seconds=120)
    with worker_dispatch_session() as db:
        event = db.execute(
            select(OutboxEvent)
            .where(
                or_(
                    OutboxEvent.status == "pending",
                    (OutboxEvent.status == "processing") & (OutboxEvent.locked_until < now),
                ),
                OutboxEvent.attempts < 5,
            )
            .order_by(OutboxEvent.created_at.asc())
            .with_for_update(skip_locked=True)
            .limit(1)
        ).scalar_one_or_none()
        if event is None:
            return None
        event.status = "processing"
        event.attempts += 1
        event.locked_until = lease_until
        return OutboxEvent(
            id=event.id,
            tenant_id=event.tenant_id,
            event_type=event.event_type,
            aggregate_id=event.aggregate_id,
            payload_json=dict(event.payload_json),
            status=event.status,
            attempts=event.attempts,
        )


def _mark_event_done(event_id: str) -> None:
    with worker_dispatch_session() as db:
        row = db.execute(select(OutboxEvent).where(OutboxEvent.id == event_id)).scalar_one_or_none()
        if row is not None:
            row.status = "processed"
            row.locked_until = None
            row.processed_at = datetime.now(timezone.utc)


def _mark_event_failed(event_id: str, error_text: str) -> None:
    with worker_dispatch_session() as db:
        row = db.execute(select(OutboxEvent).where(OutboxEvent.id == event_id)).scalar_one_or_none()
        if row is not None:
            row.last_error = error_text[:500]
            row.locked_until = None
            row.status = "failed" if row.attempts >= 5 else "pending"


def process_one_event(event: OutboxEvent) -> None:
    payload = event.payload_json
    if event.event_type == "intake_requested":
        checkpoint_adapter.start_intake_run(
            tenant_id=event.tenant_id,
            run_id=payload["run_id"],
            thread_id=payload["thread_id"],
            request_id=payload["request_id"],
            actor_user_id=payload["actor_user_id"],
            raw_prompt=payload["raw_prompt"],
        )
    elif event.event_type == "decision_committed":
        checkpoint_adapter.resume_after_decision(
            tenant_id=event.tenant_id,
            thread_id=payload["thread_id"],
            approval_request_id=payload["approval_request_id"],
            outcome=payload["outcome"],
        )
    else:
        raise ValueError(f"Unsupported outbox event_type: {event.event_type}")


def run_worker_loop() -> None:
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)
    _touch_heartbeat(force=True)
    print("ProcureAI durable worker started (PostgreSQL LISTEN/NOTIFY mode).", flush=True)

    listen_conn: psycopg.Connection | None = None
    try:
        while not _shutdown_requested:
            _touch_heartbeat()
            event = _claim_next_outbox_event()
            if event is not None:
                try:
                    process_one_event(event)
                    _mark_event_done(event.id)
                except Exception as exc:
                    print(f"Worker error processing outbox {event.id} ({event.event_type}): {exc}", flush=True)
                    _mark_event_failed(event.id, str(exc))
                continue

            # Idle path: wait up to 10s on PostgreSQL LISTEN/NOTIFY (`procureai_outbox`) instead of 0.5s busy-polling
            try:
                if listen_conn is None or listen_conn.closed:
                    listen_conn = psycopg.connect(_pg_listen_conninfo(), autocommit=True)
                    listen_conn.execute("LISTEN procureai_outbox")
                gen = listen_conn.notifies(timeout=10.0)
                for _ in gen:
                    break
            except Exception as listen_exc:
                if listen_conn is not None:
                    try:
                        listen_conn.close()
                    except Exception:
                        pass
                    listen_conn = None
                if not _shutdown_requested:
                    print(f"Worker LISTEN reconnect fallback: {listen_exc}", flush=True)
                    time.sleep(2.0)
    finally:
        if listen_conn is not None:
            try:
                listen_conn.close()
            except Exception:
                pass
        close_checkpoint_pool()
        print("ProcureAI durable worker stopped cleanly.", flush=True)


if __name__ == "__main__":
    run_worker_loop()
