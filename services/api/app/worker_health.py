import sys
import time
from pathlib import Path

HEARTBEAT_PATH = Path("/tmp/procureai/worker.heartbeat")


def main() -> None:
    if not HEARTBEAT_PATH.is_file():
        sys.exit(1)
    try:
        ts = int(HEARTBEAT_PATH.read_text(encoding="utf-8").strip())
    except Exception:
        sys.exit(1)
    # Bounded local liveness check (no external LLM dependency)
    if (time.time() - ts) > 30:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
