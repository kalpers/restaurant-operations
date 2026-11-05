---
description: Plan and implement one project phase from its docs/Phase-N plan
argument-hint: <phase number, e.g. 0, 5, 12>
---

Work on **Phase $ARGUMENTS only**.

1. Read `CLAUDE.md`, `README.md`, `docs/accepted-risks.md` (if present), and `docs/Phase-$ARGUMENTS-*.md` completely. Also read every earlier `docs/Phase-*` plan and any existing completion reports so you understand prior approved policies. If a needed plan file is missing, stop and tell me. Ignore references to `.github/copilot-instructions.md`; `CLAUDE.md` replaces it.
2. Treat the plan's "Approved ... Policies" section as binding. `README.md` is the architectural source of truth. Ignore any "Recommended VS Code Copilot Prompt" section in the plan.
3. Inspect the repository (source, migrations, tests, docs) to establish current state. Do not rely on chat history.
4. Enter plan mode and present a concise execution plan. List any conflicts between the phase plan and `README.md` and wait for my decision before coding.
5. Implement only this phase. Do not build later-phase features or placeholder tables for them.
6. Run the plan's full validation checklist (lint, typecheck, unit, integration, e2e, build, `npm audit --omit=dev`, migration reconstruction, seed idempotency, reset safeguards). Fix failures you introduced.
7. Write `docs/Phase-$ARGUMENTS-Completion-Report.md` using the "Required Phase Completion Report" template from the plan, filled with real results from this repository. Then stop and summarize.

If you hit a new architectural or business-policy conflict, stop at that decision point and explain the options, your recommendation, and the impact before changing anything.
