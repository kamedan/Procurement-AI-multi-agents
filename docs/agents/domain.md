# Domain Docs

How engineering and ProcureAI skills consume this repository's domain documentation.

## Before exploring or editing, read these

- **`GLOSSARY.md`** at the repository root (single-context domain vocabulary).
- **`docs/adr/`** for architectural decisions touching the active area.
- **`PROCUREAI_MASTER_PLAN.md`** for the full MVP specification and invariants.

## File structure

Single-context layout:

```text
/
├── GLOSSARY.md
├── AGENTS.md
├── docs/
│   ├── SKILLS_MANIFEST.md
│   ├── adr/
│   │   └── 0001-openrouter-deepseek-v4-flash.md
│   ├── agents/
│   │   ├── domain.md
│   │   └── issue-tracker.md
│   └── tickets/
```

## Use the glossary's vocabulary

Use canonical terms from `GLOSSARY.md` in code, schemas, tests, UI copy, and tickets. Do not drift to synonyms listed under `_Avoid_` (for example, do not call **Budget Headroom** "savings" or an **Approved PO Ready for Issue** "sent").

## Flag ADR conflicts

If a proposed change contradicts an existing ADR, call it out explicitly instead of silently overriding it.
