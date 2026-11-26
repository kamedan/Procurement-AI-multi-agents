# ProcureAI Vertical Ticket Index (Local Markdown Tracker)

Per `docs/agents/issue-tracker.md` and Section 19.2 of `PROCUREAI_MASTER_PLAN.md`:

| Ticket | Milestone | Title | Blocked By | Status |
| --- | --- | --- | --- | --- |
| [01-m0-bootstrap-skills-and-docker.md](./01-m0-bootstrap-skills-and-docker.md) | M0 | Skills, glossary, ADRs, and Docker stack | None | done |
| [02-m0-compatibility-spike.md](./02-m0-compatibility-spike.md) | M0 | Containerized CopilotKit -> FastAPI -> LangGraph -> OpenRouter spike | 01 | done |
| T03 | M1 | Two-tenant identity, invites, roles, and isolated workspace | 02 | ready-for-agent |
| T04 | M1 | Supplier directory and validated CSV import preview | T03 | pending |
| T05 | M1 | Purchase request creation, confirmation, and immutable amendments | T03 | pending |
| T06 | M2 | Intake & Supplier Discovery roles with typed CopilotKit cards | T04, T05 | pending |
| T07 | M2 | Versioned RFQ preparation, preview, PDF export, and distribution log | T06 | pending |
| T08 | M3 | Private quotation upload, extraction job, and field evidence | T07 | pending |
| T09 | M3 | Attributable human field corrections and confirmed quote revisions | T08 | pending |
| T10 | M3 | Deterministic Decimal comparison, eligibility, and typed comparison UI | T09 | pending |
| T11 | M4 | Version/hash-bound supplier award approval packet and decision API | T10 | pending |
| T12 | M4 | Final PO release approval, unique PO numbering, and approved PDF | T11 | pending |
| T13 | M5 | Recovery, outbox replay, cancellation, and atomic AI usage quotas | T02–T12 | pending |
| T14 | M5 | Final production Docker images, Compose verification, and docs | T13 | pending |
| T15 | M5 | Seeded demo command, backup/restore runbook, and held-out eval report | T13, T14 | pending |
| T16 | M6 | Pilot KPI event instrumentation and cohort reporting | T15 | pending |
