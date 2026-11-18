# Phase 26 Completion Report: Collapsible Navigation

## Summary

Phase 26 makes the left navigation less busy. The five existing groups (Insights, Service, Back of house, People, Admin) are now expandable sections. Each header is a button with a chevron. Only the group that holds the current page starts open, so a user with every permission sees five headers and a handful of links instead of up to 49 links.

It changes no behavior outside the navigation's presentation. No migration, table, column, permission, API field, domain rule or workflow changed, and `navigation.ts` and its unit tests are untouched.

## Environment

| Item | Version |
|---|---|
| Node / npm | 26.13.0 |
| Vitest | 5.1.0 |
| New dependencies | none (uses the existing lucide-react `ChevronDown`) |

## Policies (as built)

- **Default state.** A group is open when the person toggled it open, or when they haven't touched it and it contains the current page (`activeHref`). A group the person closed stays closed, even if it holds the current page.
- **Per-session only.** Toggles live in `AppShell` component state. A full page reload resets them. Nothing is stored in the browser or the database (D2).
- **Semantics.** The header is a `<button id="nav-group-{id}" aria-expanded aria-controls>`; the list is `<ul id="nav-group-items-{id}" aria-labelledby hidden={!open}>`. Collapsed links are not focusable and not in the accessibility tree.
- **Phone drawer.** Same sections and behavior. Open groups persist while the drawer is closed and reopened, because the state belongs to the shell, not the drawer.
- **Permissions.** Unchanged. A group with no permitted link is still dropped on the server; collapsing is usability only and every page and API still checks permission.

## Architectural decisions

D1–D5 are recorded in `docs/Phase-26-Collapsible-Navigation.md`. No change to the architecture contract.

## Migrations

None.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | passes |
| `npm run typecheck` | passes |
| Unit: `src/components/app-shell` | 11 tests pass |
| E2E: ui-shell, auth, menu | 37 pass (one ui-shell test needed a corrected assertion, see below) |
| E2E: ui-shell (re-run) | 7 pass |
| E2E: audit, employees, inventory, orders, recipes, reports, restaurant, scheduling | 69 pass |

Not run for this phase: the integration suite and `npm run build`, because no server code, schema or dependency changed. The remaining e2e specs (kitchen, settlements and others) don't use the main navigation links and were not re-run.

The one failure on the first e2e run was a test assumption: after moving to Orders, the Dashboard link is collapsed away (Insights is no longer the current group), so a role query could not find it. The test now asserts that Insights collapsed.

## Tests executed

- Unit: `navigation.test.ts` unchanged and passing.
- E2E (changed): `ui-shell.spec.ts` now checks that only the current group starts open, that opening a group shows its links, that the current page is marked, that Insights closes behind a navigation, that closing a group hides even the current page's link, and the phone drawer flow including opening Service first.
- E2E (adapted): `audit`, `auth`, `employees`, `inventory`, `menu`, `orders`, `recipes`, `reports`, `restaurant`, `scheduling` call `expandNavGroups(page)` before using a nav link.

## Files changed

- `src/components/app-shell/app-shell.tsx`: toggle state, group header button, hidden list.
- `tests/helpers/e2e-ui.ts`: new `expandNavGroups`; `openNavLink` uses it.
- `tests/e2e/`: `ui-shell`, `audit`, `auth`, `employees`, `inventory`, `menu`, `orders`, `recipes`, `reports`, `restaurant`, `scheduling` specs.
- `docs/Phase-26-Collapsible-Navigation.md`, `docs/Phase-26-Completion-Report.md`, `README.md` (sections 33 and 36), `CLAUDE.md` (phase list).

## Risks

- **Future specs.** A new spec that clicks a nav link must call `expandNavGroups` (or `openNavLink`) first, or it will fail on a collapsed group. The helper's comment says so.
- **Dev E2E timing.** `expandNavGroups` is bounded to 20 clicks so a click lost before hydration under `next dev` cannot loop forever; it relies on the following assertion to fail clearly. This is on top of the existing dev E2E timing issue from Phases 23 and 24.
- **No memory across reloads.** A user who always works in one group re-opens it after each full reload unless it holds the current page.

## Remaining issues

- Optionally remember open groups across reloads (D2).
- Optionally a "collapse all / expand all" control, if the longer groups (People, Back of house) still feel busy.

## Next-phase readiness

No phase is scheduled after 26. Cloud deployment remains on hold by owner decision (2026-11-10).
