# Issue tracker: Local Markdown

Issues and vertical-slice tickets for ProcureAI live as local Markdown files in `docs/tickets/` (no external GitHub or GitLab issue publishing).

## Conventions

- Vertical-slice tickets are stored as one file per ticket: `docs/tickets/<NN>-<slug>.md` (e.g., `docs/tickets/01-skills-and-glossary.md`, matching T01–T16 in `PROCUREAI_MASTER_PLAN.md`).
- Never combine all tickets into one monolithic file.
- Include `Blocked by:` and `Status:` (`ready-for-agent | in-progress | done | blocked`) near the top of each ticket file.
- Append progress notes or review comments under a `## Comments` heading at the bottom of the ticket file.

## When a skill says "publish to the issue tracker"

Create or update the corresponding local Markdown file under `docs/tickets/` (creating the directory if needed). Do **not** call `gh`, `glab`, or any remote tracker API.

## When a skill says "fetch the relevant ticket"

Read the referenced Markdown file under `docs/tickets/`.
