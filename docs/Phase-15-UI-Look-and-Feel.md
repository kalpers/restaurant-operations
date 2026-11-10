# Phase 15: UI Look and Feel Design and Implementation Plan

## Purpose

Phase 15 makes the application consistent, readable and safer to use. It does not change what the application does.

Today every screen is styled with hand-written Tailwind utilities in neutral grays:

- `src/app/globals.css` contains only `@import "tailwindcss";`.
- The same `INPUT_CLASS`/`PRIMARY_CLASS` constants are copied into 12 files.
- There are no shared Button, Dialog, Toast, Badge, Table or EmptyState components, and no icons.
- Navigation is a flat list of 39 permission-filtered links (`src/components/app-shell/navigation.ts`) with no grouping, active state or phone menu.
- Several destructive actions (cancel order, cancel count, deactivate, remove, cancel shift) run on a single click.
- Raw enum values (`PREPARING`) and UUIDs are shown to users.
- There are no route-level `loading.tsx`, `error.tsx` or `not-found.tsx` files.

Phase 15 was inserted by owner decision on 2026-11-10. AWS deployment moves to Phase 16 and AWS acceptance to Phase 17, so the deployed application carries the new UI and the acceptance test covers it on desktop, tablet and phone. Earlier documents that mention "Phase 15" for AWS work (for example `docs/Phase-13-Completion-Report.md`, `docs/Phase-14-Completion-Report.md`) now refer to Phase 16.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially section 30 (Responsive UI) and the Phase 14 Schedule Timeline note in section 33.
2. Read `docs/User-Guide.md` for the operator workflows each screen supports.
3. Read `docs/accepted-risks.md` (new dependencies must keep `npm audit --omit=dev` clean).
4. Inspect `src/components/` (especially `app-shell/`, `forms/`, `realtime/`), `src/app/(app)/layout.tsx`, `src/app/login/`, and `tests/e2e/` for the selectors the specs rely on.

## Approved Phase 15 Policies

1. **Presentation only.** No migration, table, column, permission, domain rule, workflow, API contract or authorization change. Components keep holding no business logic. Hidden or disabled UI is still never authorization, and every page and API keeps its own server-side checks. If an improvement needs new server data (for example a sales-by-hour series), it is out of scope and is listed under Remaining issues instead.
2. **Light theme only.** No dark mode. The Kitchen, Bar and Expo screens get a high-contrast treatment within the light theme.
3. **Design tokens in one place.** A `@theme` block in `src/app/globals.css` defines:
   - the brand and neutral colors;
   - a status palette (success, warning, danger, info, neutral);
   - radii, shadows and the font.

   Components use the token names (`bg-brand-600`, `text-danger-700`) rather than raw palette colors. The font is self-hosted through `next/font`, so no external stylesheet request is made at runtime.
4. **Shared primitives, hand-rolled.** `src/components/ui/` holds the primitives, each a small typed component with Tailwind classes. No shadcn, Radix or Headless UI. The primitives are:
   - `Button` (primary, secondary, danger, ghost; `pending` state; `min-h-11` touch target);
   - `Input`, `Select`, `Textarea` and `Field` (label, hint, error wired with `aria-describedby`);
   - `Card`, `Badge`, `Table` (striped rows, sticky header, numeric alignment, horizontal scroll container);
   - `Dialog` (native `<dialog>` with `showModal()`, focus trap, Escape, focus return) and `ConfirmDialog`;
   - `Toast` (one provider in the app shell, `role="status"`, auto-dismiss, success and error variants);
   - `EmptyState` (icon, title, explanation, optional primary action) and `Skeleton`.

   The copied class constants are replaced by these primitives. A domain component may keep a local class only when no primitive fits.
5. **Icons: `lucide-react`.** One dependency, pinned to an exact version at least two weeks old, imported per icon so the bundle stays small. Decorative icons get `aria-hidden`. An icon is never the only label of a button unless the button has an `aria-label`. Re-run `npm audit --omit=dev` after adding it.
6. **Grouped navigation.** The flat link list becomes a grouped sidebar:
   - **Service:** Floor, Reservations, Waitlist, Orders, Kitchen, Bar, Expo, Discounts.
   - **Back of house:** Menu, Manage menu, Modifiers, Prep stations, Recipes, Inventory, Inventory counts, Inventory items, Purchase orders, Suppliers.
   - **People:** My schedule, Scheduling, Timeline, Scheduling requests, Availability, Staffing & rules, Employees, Positions, Certification types.
   - **Insights:** Dashboard, Reports, Audit.
   - **Admin:** Organization, Locations, Areas, Users, Roles, Permissions, Tables, Sections.

   The current permission filter is reused unchanged, and a group with no visible links is not rendered. The current page is marked with `aria-current="page"` and a visual highlight. Below the `lg` breakpoint the sidebar collapses into a menu drawer opened from the header. Detail pages show breadcrumbs.
7. **Header and shell.** The header holds the location switcher, notifications bell, connection status and a user menu (email and sign out) in place of the bare email. The realtime connection badge appears in the shell on every page that already opens a realtime connection, and nowhere else. Phase 15 opens no new SSE connections. Content width stays `max-w-6xl` except on Floor, Kitchen, Bar, Expo and the timeline, which use the full width.
8. **Confirm before destructive actions.** Every single-click action that cancels, deactivates, removes or voids opens a `ConfirmDialog` naming the thing affected (for example "Cancel order #1042?"). The dialog has a danger confirm button and a safe default focus on Cancel. The existing reason-required flows (void item, void order, remove discount) keep their reason fields and move into a dialog. The server-side rules and payloads do not change.
9. **Success and failure feedback.**
   - *Success:* a toast replaces the bare "Saved." text.
   - *Errors:* stay inline next to the form that failed (`role="alert"`). An error toast is used only for actions that have no form.
   - *Conflicts:* `ConcurrencyError` and `ConflictError` responses get a plain message ("This order changed since you opened it. Reload to see the latest.") and a Reload button.
   - *Request ID:* the `requestId` from the error envelope is shown in small text so staff can report it.
10. **Route-level states.**
    - `loading.tsx` shows skeletons that match each page's layout.
    - `error.tsx` shows a friendly message, a Try again button and the request ID when known, never a stack trace.
    - `not-found.tsx` links back to the dashboard.
    - Lists with no rows show an `EmptyState` whose primary action appears only when the user holds the permission the action already requires.
11. **Human labels for statuses.** One display map per domain in `src/components/<domain>/status-labels.ts` turns each status into a label and a badge tone, for example `PREPARING` → "Preparing" (warning). Covered domains: order, order item, ticket, settlement, table condition and occupancy, reservation, waitlist, schedule period, purchase order and inventory count. The maps are display-only and never decide behavior. An unknown value falls back to the raw string, so a new status never crashes a page.
12. **Number and money display.** Money stays a decimal string end to end. One display helper in `src/components/format/` adds the currency symbol and thousands separators by string manipulation, never through `Number` or `parseFloat`. Quantities show their unit. Money and quantity columns are right-aligned with tabular numerals.
13. **Readable audit viewer.**
    - *Before/after:* the before and after payloads render as a field-by-field comparison table, with changed fields highlighted, instead of raw JSON.
    - *Entity:* shown as its type plus a short ID (first 8 characters, full UUID in a tooltip and copy button), linking to the entity's page when one exists.
    - *Scope:* the viewer uses only data the audit API already returns. No new query and no change to what is redacted.
14. **Screen upgrades.**
    - *Floor:*
      - table tiles are colored by condition and occupancy, and always show the state as text too (Open, Seated, Dirty, Out of service);
      - seated tiles show elapsed seated time;
      - the existing actions become large tile buttons.

      It stays a card grid. No drag-and-drop floor plan.
    - *Kitchen, Bar, Expo:*
      - full-width, large-type tickets;
      - a ticket's age band (under 10 minutes, 10–15, over 15) is shown by border color and an age label.

      An optional new-ticket sound is off by default and is a per-browser preference stored in `localStorage` (wrapped in try/catch).
    - *Order workspace:*
      - a sticky summary with the running total;
      - an "unsent items" count;
      - a prominent SEND button;
      - a category tab bar over the menu.

      The SEND request, its idempotency key and its version check are unchanged.
    - *Settlement:* the remaining balance in large type, and quick-tender buttons that prefill the remaining amount. They only fill the form; the server still validates every tender.
    - *Dashboard:* each figure tile shows the change against the previous business date. Both dates come from the existing dashboard figures query, called once per date. No chart, because no hourly series exists.
    - *Login:* a branded card and a show/hide password toggle. The failure message stays identical for every login failure.
15. **Accessibility.**
    - *Contrast and focus:* text and status colors meet WCAG 2.1 AA contrast against their background, and every interactive element has a visible `focus-visible` ring.
    - *Color alone:* status is never shown by color alone; there is always a label or an icon.
    - *Keyboard:* dialogs and the drawer trap focus, close on Escape and return focus. Keyboard shortcuts are limited to `/` (focus the menu search on the order workspace) and are ignored while typing in a field.
    - *Automated check:* `@axe-core/playwright` (dev dependency, pinned) runs on the main screens and the suite fails on serious or critical violations.
16. **Test selectors survive.** Playwright specs select by role and label. Changed labels or roles are updated in the specs in the same step, and no spec is deleted to make a step pass. A component that sets `data-ready` (the timeline) keeps it.

### Amendments decided at planning (2026-11-10)

These replace the conflicting text in the policies above:

- **Ticket age bands come from the server.** Policy 14 said 10–15 and over 15 minutes. Phase 10 already computes `ageBand` on the server (`AGE_THRESHOLDS_MINUTES`: warning at 10, late at 20), so the screens show that value and don't apply a second rule in the browser. The "ticket age band" unit test is dropped.
- **A menu search box is added.** Policy 15's `/` shortcut needed a menu search, which didn't exist. The order workspace gets a browser-only filter over the menu items already loaded, and `/` focuses it.
- **One connection badge.** `RealtimeProvider` is mounted once for every signed-in page, so the shell badge reads that connection. The per-page badges are removed, and no new connection is opened.
- **Dashboard comparison cost.** Comparing with the previous business date calls `buildDashboard` a second time, so every area query runs twice per dashboard load.

Decided during implementation:

- **No route-level `loading.tsx`.** Policy 10 asked for `loading.tsx` skeletons. With Next 16, a route `loading.tsx` left two copies of the page in the DOM after a same-route query change (the audit filter) or a `router.refresh()` (count, purchase order and settlement pages). That broke strict selectors, and screen readers would meet the page twice. Both an app-wide and a detail-route-only version were tried and removed. Loading placeholders stay inside pages as Suspense fallbacks. `error.tsx` and `not-found.tsx` are built as planned.
- **No sales-by-hour chart** (see Scope Boundary). It needs a new reporting query.
- **Account area, not a dropdown.** The header shows the user's email and a visible **Log out** button rather than hiding sign-out in a menu.

## 1. Objectives

Deliver:

- Design tokens and the `src/components/ui/` primitives, with the copied class constants removed
- Grouped, permission-filtered navigation with active state, phone drawer, breadcrumbs and a user menu
- Confirm dialogs, toasts, route-level loading, error and not-found states, and empty states
- Status label maps, a money and quantity display helper, improved tables, and a readable audit viewer
- The Floor, Kitchen, Bar, Expo, Order, Settlement, Dashboard and Login upgrades
- Accessibility fixes and an automated axe check
- README and CLAUDE.md updates, a refreshed `docs/User-Guide.md`, and `docs/Phase-15-Completion-Report.md`

## 2. Scope Boundary

In scope: presentation, layout, navigation, feedback and accessibility of existing screens.

Out of scope (don't build):

- Dark mode or user-selectable themes
- Any new server query, report, API field, permission or migration
- A spatial or drag-and-drop floor plan
- Charts that need new reporting data (sales by hour, trends over many days)
- Offline mode, push, SMS or email notifications
- Internationalization or multiple currencies
- A component library (shadcn, Radix, Headless UI, MUI)
- Rewriting domain components' logic; a large component may be split into smaller presentational parts, with behavior unchanged

## 3. Review Existing Foundation Before Changes

Confirm, from code rather than memory:

- `src/components/app-shell/navigation.ts` and how the layout filters links by permission. The grouping must reuse that filter.
- `ActionButton`, `EntityForm` and `api-request.ts` in `src/components/forms/`, including how they surface the error envelope and `requestId`.
- `ConnectionBadge` and the realtime provider, and which pages open a realtime connection.
- Every one-click destructive `ActionButton` (cancel order, cancel count, deactivate, remove, cancel shift) and the `<details>`-based void and discount flows.
- Where status strings are rendered raw, and where money strings are formatted today.
- The dashboard figures query, and whether calling it for the previous business date needs anything beyond a second call.
- Which Playwright specs depend on text that will change (for example "Saved.").

If any of these conflicts with the policies above, stop and explain before changing it.

## 4. Build Order

Each step leaves lint, typecheck, unit tests and the affected E2E specs green before the next starts.

1. **Foundation:** tokens, font and the `ui/` primitives, with unit tests for the money display helper and the status-label fallback.
2. **Shell:** grouped navigation, drawer, active state, breadcrumbs, user menu and shell connection badge.
3. **Feedback:** the toast provider, `ConfirmDialog` on every destructive action, route-level states and empty states.
4. **Migration of screens to primitives:** one domain at a time (admin, employees, scheduling, restaurant and host, menu and recipes, inventory and purchasing, orders and settlements, kitchen, reports and audit), each with its specs updated.
5. **Screen upgrades:** Floor, Kitchen/Bar/Expo, Order, Settlement, Dashboard, Login, Audit viewer.
6. **Accessibility pass:** the axe suite, focus and contrast fixes.
7. **Documentation and report.**

## 5. Unit Tests

- *Money display helper:* `"1234.50"` → `$1,234.50`, `"0.00"`, negative amounts, `"1000000.00"`, and an input that isn't a decimal string (falls back to the raw value). It never calls `Number`.
- *Status labels:* every known status of each covered domain has a label and tone, and an unknown status falls back to the raw string.
- *Navigation grouping:* the visible groups and links for a given permission set, and that an empty group is dropped.
- *Ticket age band:* boundaries at 10 and 15 minutes.
- *Audit diff:* the changed-field computation for added, removed and changed keys.

## 6. Integration Tests

No new server behavior, so no new integration tests are expected. The full integration suite must stay green to prove nothing below the UI changed.

## 7. E2E Tests (Playwright)

- **Navigation:**
  - a Server sees only the Service group links it holds permission for;
  - an Owner sees all groups;
  - the current page is marked `aria-current="page"`;
  - at phone width the drawer opens, navigates and closes.
- **Confirmation:** cancelling an order needs a confirm. Choosing Cancel in the dialog leaves the order unchanged, and confirming cancels it.
- **Feedback:** saving a form shows a success toast, and a version conflict shows the reload message.
- **Route states:** an unknown order ID shows the not-found page.
- **Empty state:** a location with no inventory counts shows the empty state, and the Start a count action appears only for `inventory.count` holders.
- **Screens:**
  - Floor tiles show the state text;
  - a kitchen ticket shows its human status label;
  - the order workspace shows the unsent count before SEND and zero after;
  - settlement quick-tender fills the remaining amount.
- **Accessibility:** axe on Dashboard, Floor, Order, Kitchen, Settlement, Timeline, Audit and Login reports no serious or critical violations.
- **Phones:** no horizontal page scroll at phone width on Floor, Order and My schedule.
- **Existing specs:** `restaurant-day.spec.ts` and every other spec still pass.

## 8. Documentation

Already done when this plan was written:

- README section 36 lists Phase 15 and renumbers AWS to Phases 16 and 17.
- The `CLAUDE.md` phase list matches.
- The review triggers in `docs/accepted-risks.md` and the Phase 13 seed doc say Phase 16.

At completion:

- **README section 30:** add the design-token and primitive rules (use `src/components/ui/`, token colors, status label maps, no color-only status).
- **README section 33:** add a "Phase 15 UI Look and Feel" note with the policies as built.
- **`docs/User-Guide.md`:** update navigation and confirmation steps and refresh screen descriptions.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` (stop `npm run dev` first), including the axe suite
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean after adding `lucide-react`, and `npm audit` re-run after adding `@axe-core/playwright`
- [ ] No migration generated (`npm run db:generate` reports no changes)
- [ ] No API response shape changed (integration suite green, no route handler diffs beyond imports)
- [ ] Manual check in the browser at desktop, tablet and phone widths on Dashboard, Floor, Reservations, Order, Kitchen, Settlement, Timeline and Audit
- [ ] No raw `INPUT_CLASS`/`PRIMARY_CLASS` copies remain (`grep`)

## 10. Required Phase 15 Completion Report

Write `docs/Phase-15-Completion-Report.md`:

```text
PHASE 15 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / React / Tailwind / lucide-react / @axe-core/playwright

Policies (as built)
- Tokens and theme:
- Primitives:
- Navigation groups and permission filtering:
- Confirmation coverage (list every destructive action):
- Feedback (toasts, conflicts, request ID):
- Route-level states:
- Status labels and money display:
- Audit viewer:
- Screen upgrades:
- Accessibility:

Results
- Grouped nav respects permissions: PASS / FAIL
- Phone drawer: PASS / FAIL
- Every destructive action confirms: PASS / FAIL
- Toasts and conflict messages: PASS / FAIL
- Loading / error / not-found: PASS / FAIL
- Empty states gated by permission: PASS / FAIL
- Status labels with unknown fallback: PASS / FAIL
- Money display without Number: PASS / FAIL
- Audit diff view: PASS / FAIL
- Floor / KDS / Order / Settlement / Dashboard / Login upgrades: PASS / FAIL
- axe: no serious or critical violations: PASS / FAIL
- Phone width, no page horizontal scroll: PASS / FAIL

Unchanged by design
- No migration, permission, API shape or domain rule change: PASS / FAIL
- Integration suite green: PASS / FAIL

Architectural decisions
Migrations (expected: none)
Dependencies added (versions, audit results)
Validation results (lint, typecheck, unit, integration, e2e, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness (Phase 16 AWS POC Deployment)
```
