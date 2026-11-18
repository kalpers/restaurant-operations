# Phase 26: Collapsible Navigation

Owner request, 2026-11-18: "clean up the left nav so it is less busy ... grouping the left nav into expanding sections."

## Goal

The left navigation lists up to 49 links at once for a user with every permission. Make it quieter by letting each of its existing groups expand and collapse. Presentation only, like Phase 15.

## Scope

In:

- Each group header (Insights, Service, Back of house, People, Admin) becomes a button that opens and closes that group's links.
- Only the group holding the current page is open by default.
- The same behavior in the phone drawer.
- E2E specs adapted to a navigation whose links may be collapsed.

Out (unchanged):

- The set of links, their grouping, their order and their permissions (`navigation.ts`).
- Server-side authorization. Hiding or collapsing a link is usability only.
- Any schema, API, permission, domain rule or workflow. No migration.
- Remembering open groups across page loads (see decision D2).

## Decisions

| ID | Decision | Reason |
|---|---|---|
| D1 | Default open = the group containing the current page; a group the person toggles keeps that choice while the app stays loaded. | Shows where you are without listing everything. No effect or stored state is needed, so it can't flash or mismatch. |
| D2 | Open groups are not persisted (no localStorage, no cookie). | Avoids a hydration mismatch and a preference store for a small gain. Can be added later if wanted. |
| D3 | The group header is a `<button>` with `aria-expanded` and `aria-controls`; the list is hidden with the `hidden` attribute. | Native semantics. Hidden links leave the accessibility tree and the tab order. |
| D4 | Empty groups stay dropped by `visibleNavigationGroups()`; the header buttons are 44px tall like the links. | Keeps Phase 15 behavior and touch-target size. |
| D5 | E2E specs call a shared `expandNavGroups(page)` helper (opens the drawer on phone widths, then every collapsed group) before using a nav link. | A collapsed link is not visible, so every spec that clicks a link outside the current group would otherwise fail. |

## Steps

1. Add toggle state and the header button to `src/components/app-shell/app-shell.tsx`.
2. Add `expandNavGroups` to `tests/helpers/e2e-ui.ts`; make `openNavLink` use it.
3. Call it before nav use in the affected specs; rewrite the ui-shell navigation tests for open, close and default state.
4. Lint, typecheck, unit tests, then the e2e specs that touch the navigation.
5. Write `docs/Phase-26-Completion-Report.md`.
