# ProcureAI Skills Manifest

**Prepared:** 26 November 2026  
**Skill root:** `.agents/skills/` (auto-discovered by Antigravity, Codex, Gemini CLI, and GitHub Copilot)  
**Lockfile:** `skills-lock.json`

## 1. Installed External Skills

Installed project-locally with `--copy` (no Windows symlinks required) after verifying available catalog names via `npx skills add <repo> --list`.

| Skill | Source | Skill Path | SHA-256 (`skills-lock.json`) | Review Notes & Local Overrides |
| --- | --- | --- | --- | --- |
| `setup-matt-pocock-skills` | `mattpocock/skills` | `skills/engineering/setup-matt-pocock-skills/SKILL.md` | `a7107058cd22442215320bb4282a7d8623aeabc7fbf9817b560c5464f34efd51` | Interactive setup skill (`disable-model-invocation: true`). Defaults to GitHub Issues; configured locally in `docs/agents/` for a local Markdown tracker (`docs/tickets/`) and single-context domain docs. |
| `domain-modeling` | `mattpocock/skills` | `skills/engineering/domain-modeling/SKILL.md` | `79ca63d8b60840500f1e0ca89a6f00366593adf6a3d8048a9fec860deb703e71` | Safe local-only doc discipline for `GLOSSARY.md` and `docs/adr/`. No external writes or auto-commits. |
| `codebase-design` | `mattpocock/skills` | `skills/engineering/codebase-design/SKILL.md` | `417e3ea96ab3fbe2b7a4279ce3e59202fb7106ad688c12f2d577c9219803de8d` | Reference vocabulary for deep modules and seams. No external writes or auto-commits. |
| `tdd` | `mattpocock/skills` | `skills/engineering/tdd/SKILL.md` | `535d1a6f3bd5bded8971e7e4ea76538907cbff6b6d32c39cf97b669869dcd383` | Red-green-refactor loop at pre-agreed seams. Requires confirming seams before writing tests. No external writes. |
| `to-tickets` | `mattpocock/skills` | `skills/engineering/to-tickets/SKILL.md` | `f7d1bca83f85e4880eec5ed4fe0bff5b8ad1ba14f1e0b17dd0f6d9235a461ec4` | `disable-model-invocation: true`. **Override:** Publish strictly to local Markdown (`docs/tickets/`) per `docs/agents/issue-tracker.md`; never publish to remote GitHub/GitLab trackers. |
| `implement` | `mattpocock/skills` | `skills/engineering/implement/SKILL.md` | `141e77647388ad7d716a8f992b604872df0cbf6cdfbc8fa2a02cbc9fe67160fc` | `disable-model-invocation: true`. **Override:** Line 17 instructs `"Commit your work to the current branch."` Per `AGENTS.md` and `PROCUREAI_MASTER_PLAN.md`, do **not** auto-commit or push unless explicitly requested by the user. |
| `code-review` | `mattpocock/skills` | `skills/engineering/code-review/SKILL.md` | `c2e0695f4d6bb9e1cc0b4c68d9965d062271cff387000fa59c1c2d31a18c25b8` | Spawns two parallel sub-agents (Standards + Spec) against a `git diff <fixed-point>...HEAD`. Requires initializing a local git repo before invoking. |
| `vercel-react-best-practices` | `vercel-labs/agent-skills` | `skills/react-best-practices/SKILL.md` | `ca7b0c0c6e5f2750043f7f0cd72d16ac4e2abc48f9b5500d047a4b77a2506212` | MIT-licensed reference rules (70 rules across 8 categories) for React/Next.js performance. Read-only reference; no external writes. |

**Deliberately excluded:** Unvetted third-party LangGraph, CopilotKit, Docker, or OpenRouter community skills (per Section 8.1 of `PROCUREAI_MASTER_PLAN.md`, official docs + focused local ProcureAI skills are used instead).

## 2. Authored Local ProcureAI Skills

Stored under `.agents/skills/<name>/SKILL.md` and maintained in this repository.

| Local Skill | Path | Responsibility |
| --- | --- | --- |
| `procureai-domain-money` | `.agents/skills/procureai-domain-money/SKILL.md` | Decimal arithmetic, ISO currencies, unknown-vs-zero rules, eligibility before ranking, immutable revisions |
| `procureai-tenant-authorization` | `.agents/skills/procureai-tenant-authorization/SKILL.md` | Server-derived tenant/actor context, PostgreSQL RLS (`FORCE ROW LEVEL SECURITY`), role/authority separation, protected checkpoints |
| `procureai-langgraph-workflows` | `.agents/skills/procureai-langgraph-workflows/SKILL.md` | Bounded 5-role workflow, versioned state contract, durable interrupts, worker restarts, stale-run reconciliation |
| `procureai-copilotkit-ui` | `.agents/skills/procureai-copilotkit-ui/SKILL.md` | Next.js + CopilotKit runtime + AG-UI bridge, typed cards, SSE resilience, safe UI actions, visual design system |
| `procureai-openrouter-gateway` | `.agents/skills/procureai-openrouter-gateway/SKILL.md` | Server-side OpenRouter gateway configured for DeepSeek V4 Flash (`deepseek/deepseek-v4.1-flash`), JSON Schema + Pydantic, ZDR/privacy fail-closed policy, atomic usage reservations |
| `procureai-document-evidence` | `.agents/skills/procureai-document-evidence/SKILL.md` | Private S3 uploads, parser limits, field provenance, attributable corrections, prompt-injection containment, optional OCR boundary |
| `procureai-action-reliability` | `.agents/skills/procureai-action-reliability/SKILL.md` | Transactional approval commits, canonical payload hashing, scoped idempotency, transactional outbox, unique PO numbering, unknown external states |
| `procureai-evaluations` | `.agents/skills/procureai-evaluations/SKILL.md` | Deterministic safety suites, dev/held-out extraction corpus, DeepSeek V4 Flash quality/cost tracking, pilot KPI instrumentation |
| `procureai-docker-delivery` | `.agents/skills/procureai-docker-delivery/SKILL.md` | Multi-stage web/Python Dockerfiles, Compose stack, one-shot migrations, service DNS, secret isolation, persistence & restart verification |

## 3. Update & Loading Policy

- Pin external skills via `skills-lock.json`; do not run blind bulk updates mid-milestone.
- Load skills selectively per task/slice as listed in `AGENTS.md`.
- Keep API keys, live supplier records, and tenant documents out of all skill files.
