# 01: M0 Bootstrap — Skills, Glossary, ADRs, and Docker Stack

**What to build:** Prepare the local engineering skills, nine ProcureAI skills, canonical `GLOSSARY.md`, `AGENTS.md`, `ADR-0001`, and complete multi-stage Docker + Compose packaging (`web`, `api`, `worker`, `migrate`, `db`, `objectstore`, `objectstore-init`).

**Blocked by:** None (can start immediately).

**Status:** done

- [x] External skills installed via `--copy` and locked in `skills-lock.json`
- [x] Nine local ProcureAI skills authored under `.agents/skills/` with verified links
- [x] `AGENTS.md`, `GLOSSARY.md`, `docs/SKILLS_MANIFEST.md`, `docs/agents/*`, and `docs/adr/0001-openrouter-deepseek-v4-flash.md` created
- [x] Multi-stage Dockerfiles (`web.Dockerfile`, `python.Dockerfile`) and `compose.yaml` + `compose.dev.yaml` + `compose.prod.yaml` authored
