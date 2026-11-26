---
name: procureai-copilotkit-ui
description: >-
  Governs ProcureAI Next.js workspace screens, CopilotKit runtime integration,
  AG-UI bridge contracts, typed generative UI cards, SSE streaming reliability,
  and visual design system fidelity. Use for any frontend, BFF, CopilotKit,
  or AG-UI bridge work.
---

# ProcureAI CopilotKit & Agentic UI

ProcureAI is a persistent procurement workspace first, enhanced by a contextual CopilotKit assistant sharing the exact same backend state and authorization.

## When to use it

- Building or editing Next.js App Router pages, BFF routes (`/api/copilotkit`, `/api/v1/*` proxy), AG-UI bridge endpoints, CopilotKit typed cards, or frontend tools.
- Styling components against the ProcureAI visual system (`design/generation-prompts.json` and `design/screens/*.png`).

## Minimum context to read

- [PROCUREAI_MASTER_PLAN.md](../../../PROCUREAI_MASTER_PLAN.md) (Sections 7, 9.2, 9.3, 15)
- [generation-prompts.json](../../../design/generation-prompts.json)
- Installed skill `vercel-react-best-practices`

## Inputs and outputs

- **Inputs:** Generated TypeScript contracts from backend OpenAPI/JSON Schema (`packages/contracts/`), authenticated server session, and AG-UI event streams.
- **Outputs:** Accessible React workspace views + typed CopilotKit cards (`RequestDraftCard`, `SupplierCandidatesCard`, `RFQPreviewCard`, `QuoteComparisonCard`, `ApprovalDecisionCard`, `RunStatusCard`) reflecting persisted server state.

## Allowed operations

- Route all CopilotKit requests through a same-origin authenticated Next.js runtime route to the FastAPI AG-UI bridge.
- Allow frontend tools only for safe UI intents: navigation, tab/filter selection, and populating unsubmitted drafts.
- Stream provisional extraction/progress clearly separated from confirmed persisted values.

## Key invariants

1. **Ordinary UI works without chat:** Every MVP stage (request, suppliers, RFQ, quote upload/correction, comparison, approval, PO export) must remain fully usable via normal forms and tables even when LLM inference is paused.
2. **Approval buttons call the domain API:** Never let chat prompts, frontend tools, or generic graph-resume hooks approve an award, release a PO, verify a supplier, or grant roles. Require explicit human confirmation (e.g., review checkbox + `POST /api/v1/decisions/{id}/approve`).
3. **No approval on provisional data:** Partial streamed output or unconfirmed critical quote fields must keep approval controls disabled.
4. **Stable versioned payloads:** Every card payload includes stable record IDs, `schema_version`, and entity revision; surface `STALE_VERSION` conflicts cleanly with a refresh path.
5. **Distinct run states:** Render `running`, `waiting_for_input`, `waiting_for_approval`, `failed`, `cancelled`, and `completed` with icon + text labels (never color alone).
6. **Safe rendering & no hidden chain-of-thought:** Escape all document text and generated Markdown; never execute generated JS or raw HTML; never display raw hidden reasoning tokens or fabricated confidence scores.
7. **Design system discipline:** Crisp enterprise light theme (`#F7F8FA` canvas, `#DEE4E9` hairline borders, `#1D2935` slate text, `#285447` forest-green primary actions, tabular numbers, no subscriptions/billing/fake savings charts).

## Relevant tests

- React/component tests verifying approval buttons stay disabled on provisional/unconfirmed states and handle `STALE_VERSION` conflicts cleanly.
- Playwright end-to-end tests: chat request opens editable `RequestDraftCard` matching form view; browser refresh during `waiting_for_approval` reconnects without re-triggering work; keyboard navigation on approval review.
- Bundle check verifying `OPENROUTER_API_KEY` and server secrets never enter client bundles or `NEXT_PUBLIC_*`.

## Escalation / error behavior

- Stream drop or SSE timeout: display reconnect state and refetch authoritative server state via REST API; never auto-retry a mutating command with a new idempotency key.
- Unsupported user request (e.g., "analyze paid spend"): respond clearly that paid-spend tracking is outside the MVP and link to supported request/PO views.

## Worked example

User types *"Approve the cheapest option"* in the copilot on `PR-014`.

1. CopilotKit routes the intent through `/api/copilotkit` -> FastAPI AG-UI bridge.
2. Backend checks comparison v3: Vertex ($16,900) is ineligible (21-day delivery); Atlas ($18,300) is lowest eligible.
3. Bridge renders `ApprovalDecisionCard` pointing to the pending award packet for Atlas Computing with a **Review decision** link—it does **not** record an approval.
4. Assigned approver opens the decision packet, checks *"I have reviewed the quotation and commercial terms"*, and clicks **Approve supplier award** -> `POST /api/v1/decisions/{id}/approve`.
