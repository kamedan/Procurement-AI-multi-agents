# ProcureAI Agent Instructions

## Source of truth

- **Product & engineering specification:** `PROCUREAI_MASTER_PLAN.md`
- **Domain vocabulary:** `GLOSSARY.md`
- **Architecture Decision Records:** `docs/adr/`
- **Skills manifest & review notes:** `docs/SKILLS_MANIFEST.md`
- **Visual design references:** `design/generation-prompts.json` and `design/screens/`

## Non-negotiable workspace rules

1. **MVP scope boundary:** Build the invite-only, multi-tenant validation MVP (request -> tenant suppliers -> reviewed RFQ export -> uploaded quotations -> source-linked comparison -> authorized award -> authorized PO release -> numbered approved PO PDF). Do **not** add subscriptions, checkout, Stripe/payments, customer AI billing, or unrequested Phase 2/3 modules.
2. **LLM routing:** Route every application LLM call exclusively through the server-side OpenRouter gateway configured for the Fixed Hybrid profile split (`deepseek/deepseek-v4.1-flash` for `extraction` and `typesafe/jev-router` with `max_price` + ZDR caps for `decision`/`reasoning`; see `docs/adr/0001-openrouter-deepseek-v4-flash.md` and `docs/adr/0002-openrouter-jev-hybrid-routing.md`). Never add direct calls to other LLM vendors or leak `OPENROUTER_API_KEY` to client bundles or Docker layers.
3. **Deterministic authority:** Deterministic backend code owns money math (`Decimal`/`NUMERIC`), tenant isolation (app checks + PostgreSQL RLS), eligibility checks, approval transactions, and PO numbering. Agents propose only; humans approve via protected domain APIs.
4. **Docker delivery:** The full stack (`web`, `api`, `worker`, `migrate`, `db`, `objectstore`) must build and run via Docker Compose without host Node.js or Python installs.
5. **Local-only side-effect override:** Do **not** automatically commit, push, create remote GitHub/GitLab issues, deploy publicly, or send external emails/messages—even when an installed external skill (such as `implement`) includes a default commit step.

## Agent skills

### Issue tracker

Local Markdown tickets in `docs/tickets/` (no external GitHub/GitLab tracker). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` at repo root and `docs/adr/`). See `docs/agents/domain.md`.

### Skill-selection rules (load by task relevance only)

Load only the skills relevant to the active slice—never inject the entire skill library into one prompt:

- **Domain terms / ADRs:** `domain-modeling`
- **Module interfaces / seams:** `codebase-design`
- **Vertical slicing / ticket breakdown:** `to-tickets`
- **Test-first behavior verification:** `tdd`
- **Two-axis diff review:** `code-review`
- **React / Next.js performance:** `vercel-react-best-practices`
- **Money, comparison, revisions, PO terms:** `procureai-domain-money`
- **APIs, queries, RLS, roles, files, streams, checkpoints:** `procureai-tenant-authorization`
- **LangGraph state, nodes, interrupts, worker restarts:** `procureai-langgraph-workflows`
- **CopilotKit runtime, AG-UI bridge, typed cards:** `procureai-copilotkit-ui`
- **OpenRouter gateway, DeepSeek V4 Flash profiles, privacy/quotas:** `procureai-openrouter-gateway`
- **Document upload, parsing, provenance, corrections, injection defense:** `procureai-document-evidence`
- **Approvals, idempotency, outbox, PO numbering, PDF generation:** `procureai-action-reliability`
- **Evals, held-out corpus, safety suites, pilot KPIs:** `procureai-evaluations`
- **Dockerfiles, Compose, migrations, health checks, persistence:** `procureai-docker-delivery`
