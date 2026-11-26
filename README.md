# ProcureAI

> **Turn a purchasing request and supplier quotations into a traceable comparison, an authorized human decision, and a numbered approved Purchase Order PDF—in one multi-tenant workspace.**

![ProcureAI System Architecture](docs/architecture-diagram.jpg)

---

## Key Capabilities

- **6-Stage Guided Procurement Flow (`EN | FR`):**
  1. **Editable Purchase Request Draft:** Natural-language AI intake (`OpenRouter DeepSeek V4.1 Flash`) or 1-click presets (`Sousse, Tunisia · TND` & `Global · USD`), immutable versioned drafts (`RequestVersion`), global ISO currencies (`TND` 3-decimal millimes, `EUR`, `USD`, `MAD`, `DZD`, `GBP`, etc.), and optional **Tunisia Fiscal Stamp (*Timbre Fiscal* `+1.000 TND`)**.
  2. **Real Supplier Discovery & Bilingual RFQ:** Live **Tavily** web search (backed by RLS-protected `tavily_search_cache` for `$0.00` repeat lookups) + verbatim contact extraction, version-locked **EN/FR RFQ PDFs** (*Demande de Prix*), `mailto:` drafts, and optional SMTP dispatch.
  3. **Quotations, Inline PDF Preview & Revision Diffs:** Digital PDF/CSV quote parsing (`pypdf` + DeepSeek V4.1 Flash), private **RustFS** object storage with SHA-256 hashes, **Side-by-Side PDF Preview Drawer**, attributable human field corrections (`Rev 1 → Rev 2`), and a **4-Scenario Demo Quote Generator** for instant walkthroughs.
  4. **Deterministic Comparison + Jev Mandatory-Spec Verifier:** Pure Python `Decimal` totals (unknown freight/tax never coerced to zero; mandatory eligibility checked *before* ranking) paired with a single batched **`typesafe/jev-router`** (`decision` profile, ZDR + `max_price` caps) mandatory-spec check (`pass` / `needs_clarification` / `fail`).
  5. **Authorized 2-Checkpoint Human Approvals:** Separation of duties, currency-normalized approval limits, canonical SHA-256 payload locking, and idempotency keys across **Supplier Award** and **Final PO Release**.
  6. **Numbered Approved PO PDF & Evidence Passport:** Concurrency-safe sequential PO numbering (`PO-YYYY-NNNN`) and bilingual **EN/FR Approved PO PDF** (*Bon de Commande Officiel*).
- **Agents & Background Activity Screen (`Agents & Activité`):** Live roster of all 6 specialized agents/engines, PostgreSQL `LISTEN/NOTIFY` durable worker health & outbox queue monitor, and a filterable chronological background log.
- **Contextual Command Copilot (`AG-UI`):** Grounded case Q&A, EN/FR clarification email drafter, safe Stage 1 draft pre-filling, and deterministic refusal of autonomous approvals.
- **Spend Governance & Evaluation Scorecard:** Atomic combined 24h OpenRouter + Tavily spend limits (`pg_advisory_xact_lock`), tenant-isolated LLM & Tavily caches, and a runnable `dev` + `held_out` safety/accuracy evaluation harness (`python -m app.evals`).

---

## Architecture & LLM Routing (Fixed Hybrid)

Every LLM call routes exclusively through the server-side OpenRouter gateway (`services/api/app/infrastructure/openrouter.py`) with `data_collection: "deny"` and `zdr: true` (never exposing API keys to client bundles or Docker layers):

| Profile | Default Model (`ADR-0001` / `ADR-0002`) | Purpose |
| :--- | :--- | :--- |
| `extraction` | `deepseek/deepseek-v4.1-flash` (`reasoning: disabled`) | Structured intake drafts, verbatim supplier contacts, quote PDF fields |
| `decision` | `typesafe/jev-router` (`max_price` capped + DeepSeek fallback) | Batched 3-state Mandatory-Spec Compliance Verification |
| `reasoning` | `typesafe/jev-router` (`max_price` capped + DeepSeek fallback) | Grounded Command Copilot & EN/FR clarification email drafts |
| **Authority Core** | **Python `Decimal` + PostgreSQL 17 `FORCE RLS`** | Money math, `Timbre Fiscal`, eligibility, tenant isolation, approvals, PO numbering |

---

## Quick Start (Docker Compose — Zero Host Node/Python Required)

### 1. Configure Local Environment

```bash
cp .env.example .env
```

Edit `.env` (gitignored & dockerignored — **never commit `.env`**) and populate:
- `PROCUREAI_SESSION_SECRET` (32+ random characters)
- `POSTGRES_PASSWORD`, `POSTGRES_APP_PASSWORD`, `OBJECTSTORE_ROOT_PASSWORD`
- `OPENROUTER_API_KEY` (required for live extraction, Jev spec checks, and Copilot)
- `TAVILY_API_KEY` (optional; enables live supplier web search)

### 2. Build & Launch the Complete Stack

```bash
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

The workspace starts at **http://localhost:3100** (configurable via `WEB_PORT` in `.env`).

### 3. Run Automated Safety Tests & Evaluation Benchmarks

```bash
# Multi-tenant RLS, Decimal money, idempotency, Tavily cache, Jev verifier & Copilot tests
docker compose --env-file .env -f infra/compose.yaml exec -T api pytest -q

# Offline dev + held-out deterministic evaluation suite
docker compose --env-file .env -f infra/compose.yaml exec -T api python -m app.evals

# Optional live OpenRouter Jev Router adversarial & French Devis benchmark
docker compose --env-file .env -f infra/compose.yaml exec -T api python -m app.evals --live
```

---

## Repository Structure

```text
.
├── apps/web/                     # Next.js App Router (TypeScript + Tailwind BFF & UI)
│   └── src/
│       ├── app/api/              # Authenticated BFF proxy, session cookie, AG-UI bridge
│       ├── components/           # ProcureWorkspace, CaseFlowView, AgentsActivityView
│       └── lib/                  # Signed session assertions & EN/FR i18n dictionary
├── services/api/                 # FastAPI Domain API, LangGraph Worker & Evaluations
│   ├── app/
│   │   ├── agents/               # Bounded ReAct LangGraph workflow & PG checkpointer
│   │   ├── api/                  # Procurement domain REST routes
│   │   ├── application/          # Sourcing, Jev spec verifier, approvals, Command Copilot
│   │   ├── documents/            # Bilingual EN/FR ReportLab PDF generators (RFQ/Quote/PO)
│   │   ├── domain/               # SQLAlchemy models, Decimal money, comparison engine
│   │   ├── infrastructure/       # RLS DB sessions, OpenRouter gateway, Tavily, RustFS S3
│   │   ├── evals.py              # CLI & API evaluation corpus (dev + held-out)
│   │   ├── migrate.py            # Idempotent schema, composite indexes & FORCE RLS setup
│   │   └── worker.py             # PostgreSQL LISTEN/NOTIFY durable outbox worker
│   └── tests/                    # Pytest safety & multi-tenant invariant suite
├── infra/                        # Multi-stage Dockerfiles, Compose stacks & DB role init
├── docs/                         # ADRs, Security Audit, Docker guide & architecture diagram
├── design/                       # Reference enterprise UI mockups & prompt specs
├── .env.example                  # Secret-free configuration template
├── AGENTS.md                     # Workspace architecture & non-negotiable guardrails
└── GLOSSARY.md                   # Canonical procurement domain vocabulary
```

---

## Documentation Index

- [Architecture Decision Record 0001 — OpenRouter + DeepSeek V4.1 Flash](docs/adr/0001-openrouter-deepseek-v4-flash.md)
- [Architecture Decision Record 0002 — Fixed Hybrid Jev Router](docs/adr/0002-openrouter-jev-hybrid-routing.md)
- [Docker Packaging & Production Guide](docs/DOCKER.md)
- [Security Audit & Remediations](docs/SECURITY_AUDIT.md)
- [Domain Glossary](GLOSSARY.md)
- [Master Product & Engineering Plan](PROCUREAI_MASTER_PLAN.md)
