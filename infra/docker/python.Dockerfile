# syntax=docker/dockerfile:1.7

FROM python:3.12.9-slim-bookworm AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY services/api/requirements.txt /build/requirements.txt
RUN pip install --upgrade pip==25.0.1 && pip install -r /build/requirements.txt


FROM python:3.12.9-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    LANGGRAPH_STRICT_MSGPACK=true \
    TMPDIR=/tmp/procureai

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 procureai \
    && useradd --uid 10001 --gid 10001 --shell /usr/sbin/nologin --create-home procureai \
    && mkdir -p /app /tmp/procureai \
    && chown -R procureai:procureai /app /tmp/procureai

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY --chown=procureai:procureai services/api /app

USER procureai

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
