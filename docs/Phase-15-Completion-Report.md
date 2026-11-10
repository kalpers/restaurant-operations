# Phase 15 Completion Report: UI Look and Feel

## Summary

Phase 15 gives the application a consistent, readable and safer presentation. It changes no behavior.

- **Foundation:** design tokens and the Inter font, and a set of hand-rolled UI primitives in `src/components/ui/` that replaced the copied class strings.
- **Navigation:** grouped, permission-filtered, with a phone drawer, breadcrumbs and one connection badge in the header.
- **Feedback:**
  - Every destructive one-click action now asks first.
  - Success shows a toast.
  - Errors show the request ID, and a version conflict offers Reload.
  - Error and not-found pages are friendly.
- **Readability:** statuses appear as human labels, money is formatted with thousands separators, tables and empty states are improved, and the audit viewer reads as a field-by-field comparison.
- **Screens:** Floor, Kitchen, Bar, Expo, Order, Settlement, Dashboard and Login were upgraded.
- **Accessibility:** an automated axe check now runs on ten screens and passes with no findings.

No migration, table, column, permission, API field, domain rule or workflow changed. The integration suite (1,141 tests) passes unchanged.

## Environment

| Item | Version |
|---|---|
| Node / npm | 26.13.0 / 12.2.0 |
| Next.js / React | 16.4.5 / 19.3.1 |
| Tailwind CSS | 4.3.4 |
| PostgreSQL | 17 (Docker `postgres:17-alpine`) |
| Drizzle ORM / Drizzle Kit | 0.45.4 / 0.31.11 |
| lucide-react (new, dependency) | 1.61.0, exact |
| @axe-core/playwright (new, dev) | 4.14.0, exact |
| Playwright / Vitest | 1.64.1 / 5.1.0 |

## Policies (as built)

- **Tokens and theme.** A `@theme inline` block in `src/app/globals.css` defines these, mapped onto Tailwind's palette:
  - `brand` (teal), `success`, `warning`, `danger` and `info`;
  - `surface` and `canvas`;
  - a `tabular` utility.

  One `focus-visible` ring covers every interactive element. Inter comes through `next/font/google`, self-hosted at build time. The app is light only.
- **Primitives.** `src/components/ui/` holds:
  - `Button` and `ButtonLink` (primary, secondary, danger, ghost; pending state), and `buttonClass`;
  - `Input`, `Select`, `Textarea`, `Field`, `Checkbox`, `INPUT_STYLE` and `INPUT_BASE`;
  - `Card`, `Badge`, the `Table` family, `Dialog`, `ConfirmDialog`, `ToastProvider` and `useToast`;
  - `EmptyState`, `Skeleton`, `PageHeader` and `Breadcrumbs`.

  `Dialog` uses the native `<dialog>` with `showModal()`. It exists only while open, so it is never in the server HTML. Escape closes it, the safe choice is focused first through `data-autofocus`, and focus returns to the opener. No `INPUT_CLASS`/`PRIMARY_CLASS` constant holds a copied class string any more; they are aliases of the shared styles.
- **Navigation groups and permission filtering.**
  - `navigation.ts` adds `group` and `icon` to the same 38 links. `visibleNavigationGroups()` reuses `visibleNavigation()`'s permission filter and drops empty groups.
  - The groups are Insights (Dashboard, Reports, Audit), Service, Back of house, People and Admin. Tables and Sections are under Admin.
  - There is one `<nav aria-label="Main">`: a sticky sidebar at `lg` and up, an off-canvas drawer below it. The drawer opens from a **Menu** button, closes on Escape, on its backdrop and on navigation, and returns focus to the button. The page behind it is `inert` while it is open.
  - `activeHref()` marks the longest matching link `aria-current="page"`. This is usability only; every page and API still checks permission on the server.
- **Confirmation coverage.** The following now confirm first:
  - Roles and users: deactivate role, remove a user's role, disable user, unlink a user from an employee.
  - Inventory: cancel count, return a count for correction, deactivate a conversion.
  - Menu and recipes: stop offering a menu, remove a modifier effect, remove a recipe ingredient, discard a draft revision, retire a revision.
  - Scheduling: withdraw a swap, cancel a time-off request, deny time off, deny a swap, remove a staffing requirement, deactivate a staffing template, publish, archive, remove an assignment, cancel a shift, remove availability (both kinds).
  - Purchasing: remove a purchase-order line, cancel a purchase order.
  - Seating: end a section assignment, take a table out of service.

  Void item, void whole order, remove discount and cancel seating moved from `<details>` disclosures into dialogs, with the same fields, confirm checkboxes and payloads. Cancelling a settlement and voiding a tender already had a reason step, and they're unchanged.
- **Feedback.**
  - `EntityForm` and `ActionButton` show a success toast. The toast region is `role="status"` with `data-testid="toast-region"`.
  - Errors stay inline (`role="alert"`) and show the `requestId` from the error envelope. `sendApiRequest` and `callOrderApi` now return `code` and `requestId`.
  - `CONCURRENCY_CONFLICT` shows a **Reload** button.
- **Route-level states.**
  - `src/app/(app)/error.tsx` shows a generic message, the digest, Try again, and a link to the dashboard. It never shows the error text or a stack trace.
  - `src/app/(app)/not-found.tsx` and `src/app/not-found.tsx` link back to the dashboard.
  - There is **no** route-level `loading.tsx`; see Architectural decisions.
  - Page-level empty lists use `EmptyState` with their exact existing text.
- **Status labels and money display.**
  - **Status labels:** `src/components/format/status-labels.ts` holds a label and tone per status for 17 domains. Unknown values fall back to a humanized form. `StatusBadge` keeps the raw value on `data-status`.
  - **Removed maps:** the old `PO_STATUS_LABELS`, `COUNT_STATUS_LABELS` and `AVAILABILITY_LABELS`, and the reservation and waitlist maps, are gone.
  - **Money:** `formatMoney` in `src/components/format/money.ts` adds `$`, the sign and thousands separators by string manipulation. A unit test checks the source never calls `Number`, `parseFloat` or `Intl`. The three duplicate `formatMoney` copies now re-export it.
  - **Not changed:** inventory cost formatting (`$300.0000`), on purpose.
- **Audit viewer.**
  - **Changes:** **Show** is a native `<details>`, so it works before hydration. It opens a Field, Before and After table with changed rows highlighted (plus a hidden "(changed)" label for screen readers), followed by any details.
  - **Labels:** actions read as "Settlements · Completed", with the code underneath. Entity types read as "Inventory count". Filter options use the same labels and keep the codes as their values.
  - **IDs and links:** an 8-character ID copies the full UUID, and the record links to its page for orders, employees, recipes, counts, inventory items, menu items, purchase orders and schedule periods. Those pages check permission themselves.
  - **Scope:** it uses only fields the audit API already returns.
- **Screen upgrades.**
  - **Floor:**
    - larger tiles in four or five columns at wide widths;
    - availability shown by color, an icon and a text badge;
    - a prominent "Seated N min", a ring on selected tables, and larger buttons.
  - **Kitchen and Bar:**
    - full width, larger type, and a header colored by the **server's** `ageBand`, with a "10+ min" or "Late · 20+ min" label;
    - human status badges and large Start, Ready and Bump buttons;
    - a "New-ticket sound" toggle, off by default, stored per browser in `localStorage` inside try/catch, playing a Web Audio beep with no file.
  - **Expo:** shows how long each order has waited, from the server's age, instead of a browser-local "Updated" clock.
  - **Order:**
    - the check stays in view at `lg` and up, with an "N not sent" badge and a large Send button that shows a toast;
    - pill-style category tabs;
    - a browser-only **Search the menu** filter across categories, with `/` focusing it (ignored while typing).
  - **Settlement:** the server's remaining balance in large type. **Cash – exact** and **Card – exact** buttons only fill the form; the server validates.
  - **Dashboard:** each figure shows "▲/▼ change vs prev. day" from a second `buildDashboard` call. Money uses `subtractDecimals`.
  - **Login:** a branded card and a Show/Hide password toggle (`aria-pressed`). The failure message is unchanged.
- **Accessibility.**
  - axe (WCAG 2.0/2.1 A/AA) on Login, Dashboard, Floor, Order, Kitchen, Settlement, Timeline, Audit, Reservations and Employees reports **no** violations of any impact.
  - The one finding during development: the alerts button's accessible name didn't contain its visible "Alerts" text (`label-content-name-mismatch`). It is now "Alerts, N unread".
  - Status is always shown in words.

## Results

| Check | Result |
|---|---|
| Grouped nav respects permissions | PASS (unit: groups per permission set; E2E: Server vs Owner) |
| Phone drawer | PASS (opens, Escape closes and returns focus, closes on navigation) |
| Every destructive action confirms | PASS (Keep it, Escape and confirm paths tested) |
| Toasts and conflict messages | PASS for toasts (E2E). Conflict Reload is wired to `CONCURRENCY_CONFLICT`, but no E2E forces a conflict |
| Loading / error / not-found | PASS for error and not-found. Loading **not built** at route level (see decisions) |
| Empty states gated by permission | PASS: no new actions added, so no gating needed |
| Status labels with unknown fallback | PASS (unit) |
| Money display without Number | PASS (unit, including a source check) |
| Audit diff view | PASS (unit and E2E) |
| Floor / KDS / Order / Settlement / Dashboard / Login upgrades | PASS (E2E flows, axe) |
| axe: no serious or critical violations | PASS (no violations at all) |
| Phone width, no page horizontal scroll | PASS (Floor, Orders, My schedule, Dashboard at 375px) |

**Unchanged by design**

| Check | Result |
|---|---|
| No migration, permission, API shape or domain rule change | PASS (`db:generate`: "No schema changes"; no file under `src/modules`, `src/app/api`, `src/db` or `drizzle/` changed) |
| Integration suite green | PASS (1,141 tests) |

## Architectural decisions

1. **The server's age band is used (amendment).**
   - Kitchen screens show the Phase 10 `ageBand` (warning at 10 minutes, late at 20).
   - The plan's 10/15 thresholds and its "ticket age band" unit test were dropped by owner decision.
2. **The menu search is added (amendment).** A browser-only filter over the loaded items.
3. **There is one connection badge.**
   - The shell reads the existing per-tab `RealtimeProvider` stream. `ConnectionBadge` no longer takes props.
   - The four per-page badges were removed, so `data-testid="connection-status"` stays unique.
4. **There is no route-level `loading.tsx` (deviation from policy 10).**
   - In Next 16, a route `loading.tsx` left two copies of the page in the DOM. This happened after a same-route query change (the audit filter, in dev) and after `router.refresh()` on detail pages (count, purchase order and settlement, in production mode).
   - That caused strict-selector failures, and screen readers would meet the page twice.
   - Both an app-wide and a detail-routes-only version were tried and removed. The existing Suspense fallbacks inside pages stay.
   - Recorded in the plan's amendments and in README §33.
5. **The dialog renders only while open.**
   - A `<dialog>` in server HTML inside a `<p>` or `<span>` is re-parented by the HTML parser. That caused hydration mismatches on the menu pages.
   - Mounting it only while open keeps it out of the server HTML and keeps it in place in the DOM next to its opener, so specs scoped to a card still find its contents.
6. **Toasts replace the inline "Saved."** The text stays "Saved.", and specs use `expectToast`. The routing form's own inline "Saved." is untouched.
7. **There is an account area rather than a dropdown.** The email and a visible **Log out** sit in the header. The location name was dropped from the header because the dashboard already shows it.
8. **There is no sales-by-hour chart.** It would need a new reporting query, which is out of scope.
9. **The restyle was mechanical where safe.** A one-off script replaced class names only (cards, primary buttons, status colors and input constants) across 61 files. It never touched text, roles, labels or test IDs.

## Migrations

None. `npm run db:generate` reports "No schema changes, nothing to migrate".

## Validation results

| Step | Result |
|---|---|
| `npm run lint` | PASS (0 problems) |
| `npm run typecheck` | PASS |
| `npm run test:unit` | PASS (41 files, 708 tests) |
| `npm run test:integration` | PASS (64 files, 1,141 tests) |
| `npm run test:e2e` | PASS: full suite in CI mode (`CI=1`, `next start` on the production build), 129 passed, 0 failed, 0 flaky. An earlier `next dev` run also passed, apart from the issues fixed above |
| `npm run build` | PASS |
| `npm audit --omit=dev` | PASS (0 vulnerabilities) |
| `npm audit` | 11 moderate, the same development-only set as before this phase (`drizzle-kit`/`esbuild`/`@esbuild-kit`, `typescript-eslint`, `minimatch`). DEV-002/DEV-003 still apply; the new packages add none |
| Migration reconstruction | PASS (the integration and E2E global setup recreate the `_test` database from the checked-in migrations on every run) |
| Seed idempotency | PASS (`db:seed` twice: "0 applied, 18 already applied") |
| Reset safeguards | PASS (refuses a non-loopback host and a database not named `restaurant_ops`) |
| Copied style constants | PASS (no constant holds a literal control class string) |

## Tests executed

- **Unit:** 708 (15 new).
  - `src/components/format/format.test.ts`: money, quantity and status labels.
  - `src/components/audit/audit-format.test.ts`: the audit diff and labels.
  - `src/components/reports/dashboard-delta.test.ts`.
  - `navigation.test.ts`, rewritten for groups and `activeHref`.
- **Integration:** 1,141, unchanged.
- **E2E:** 129. New:
  - `accessibility.spec.ts`: 2 tests covering 10 screens.
  - `ui-shell.spec.ts`: 7 tests.

  Updated specs: auth, audit, employees, inventory, kitchen, menu, recipes, restaurant, restaurant-day, scheduling and settlements. The changes cover:
  - confirm clicks;
  - toast checks;
  - human status labels ("Preparing", "Ready", "New", "Cancelled", "Closed");
  - drawer-aware navigation, through the new `tests/helpers/e2e-ui.ts`.

  No spec was deleted.

## Files changed

105 files modified plus 17 new paths. Representative:

- **New:**
  - `src/components/ui/*` (12 files), `src/components/format/*`, `src/components/audit/*`;
  - `src/components/app-shell/app-shell.tsx` and `nav-icons.tsx`;
  - `src/components/forms/api-error-message.tsx`, `src/components/kitchen/ticket-age.tsx`, `src/components/reports/dashboard-delta.ts`;
  - `src/app/(app)/error.tsx`, `src/app/(app)/not-found.tsx`, `src/app/not-found.tsx`;
  - `tests/e2e/accessibility.spec.ts`, `tests/e2e/ui-shell.spec.ts`, `tests/helpers/e2e-ui.ts`.
- **Rewritten:**
  - `src/app/(app)/layout.tsx`, `src/app/layout.tsx`, `src/app/globals.css`;
  - `src/components/orders/order-workspace.tsx`, `kitchen/kds-board.tsx`, `kitchen/expo-board.tsx`, `login-form.tsx`;
  - `src/app/(app)/audit/page.tsx`, `reports/dashboard-overview.tsx`.
- **Edited:** `restaurant/floor-board.tsx`, `settlements/settlement-workspace.tsx`, `forms/*`, `app-shell/navigation.ts`, `notifications/notification-bell.tsx`, and about 50 pages (restyle, confirmations, badges, breadcrumbs, empty states).
- **Test helper:** `tests/helpers/e2e-orders.ts` gains `UI_SCOPE` and `SHELL_SCOPE`.
- **Docs:**
  - `docs/Phase-15-UI-Look-and-Feel.md` (amendments);
  - `README.md` §30 (UI rules), §33 (Phase 15 note) and §36 (phase list);
  - `CLAUDE.md` (phase list), `docs/User-Guide.md`, `docs/accepted-risks.md`, `docs/Phase-13-Validation-Seed-Data.md`.
- **Dependencies:** `package.json` and `package-lock.json` (`lucide-react` 1.61.0, `@axe-core/playwright` 4.14.0).

## Risks

- **Spec churn hides regressions only if the new assertions are weaker.**
  - *Changed:* status checks moved from raw enums to labels, and "Saved." moved to the toast region.
  - *Still visible:* raw values remain on `data-status` and `data-age-band` for stricter checks if wanted.
- **The dashboard cost doubled.** Each dashboard load runs every area query twice to compare with the previous business date. This is acceptable for the POC; time it on the validation fixture before AWS.
- **Mechanical restyle.** The class-name sweep touched 61 files. Lint, typecheck, axe and the full E2E suite pass, but small visual issues may remain on screens without E2E coverage, such as some admin pages.
- **`next/font/google` needs network access at build time.** CI and local builds have it. An offline build would fail at font download.

## Remaining issues

1. **Browser-local times.**
   - *Affected:* the settlement "Settled and closed at …" line and the notification panel times use the browser's time zone, not the location's.
   - *Why left:* neither component receives the location time zone, so fixing it needs a server-side change (out of scope).
2. **No route-level loading skeletons** (decision 4). Revisit if Next fixes the duplicate-tree behavior, or add Suspense boundaries inside slow pages.
3. **The conflict Reload has no E2E test.** It is wired to `CONCURRENCY_CONFLICT`, but no end-to-end test forces a stale version through the UI.
4. **Sales-by-hour chart.** It needs a new reporting query and is a candidate for a later reporting phase.
5. **Recurring outbox log line.** Every E2E run logs "Outbox batch failed; it will be retried", most likely while specs clean up data. It is server-side, outside this phase's scope, and its cause wasn't investigated.
6. **Carried over:**
   - The intermittent 5 s timeout in `tests/integration/database/migrations.test.ts` remains an open owner decision. It didn't recur in this phase's run.
   - The development-only audit findings (DEV-002, DEV-003) are unchanged.

## Next-phase readiness

**Phase 16 (AWS POC Deployment): READY**, subject to review of this report, and especially the policy 10 deviation (decision 4). Phase 17's acceptance test should cover the new navigation drawer, confirmations and toasts on desktop, tablet and phone. `tests/e2e/ui-shell.spec.ts` and `tests/e2e/accessibility.spec.ts` can run against the AWS URL alongside `restaurant-day.spec.ts`.
