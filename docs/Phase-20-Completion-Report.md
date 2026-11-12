# Phase 20 Completion Report

PHASE 20 COMPLETION REPORT

## Summary

Phase 20 (Service Polish and Deferred Features) closes the work left open by Phases 6 to 19, with the scope the owner chose on 2026-11-11 and decisions D1–D23 approved as recommended. Plan: `docs/Phase-20-Service-Polish-and-Deferred-Features.md`.

Built:

- **Menu and stock:** a category snapshot at SEND, item mix and menu engineering by category, per-location modifier 86, scheduled 86 (start, end, "until close"), a per-location running-low threshold, audited stocked-item and location settings changes, and a sales-by-hour chart.
- **Floor:** moving or combining a seated party onto a held table follows the seating hold rule.
- **Time:** location time zone for every display and `datetime-local` input, and break editing on the manager's time clock.
- **Notifications:** schedule published, shift changed, time off approved or denied, certification expiring, overtime approaching and missed clock-out.
- **Checks:** tax included in prices, tax-exempt checks, one sent item shared between checks, and tip refunds.
- **Labor and tips:** optional daily overtime, and cash tip declarations.
- **Tooling:** the E2E database is prepared before the web server starts, `migrations.test.ts` has a 30 s timeout, root-only `.gitignore` rules are anchored, and report areas and the audit trail stream their data inside `Suspense`.

Nothing in Phase 20 moves inventory. The canonical Bacon Cheeseburger test passes unchanged.

## Environment

- Node 26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17 (Docker `postgres:17-alpine`), Windows 11.
- No dependency added or changed. `npm audit --omit=dev`: 0 vulnerabilities.

## Policies (as built)

- **Menu and stock.** SEND writes `order_items.menu_category_id` and `menu_category_name_snapshot` from the placement `resolveSellableItem` picked (first by menu, then category display order); both are frozen by `order_items_freeze`. Items sent earlier report as "Uncategorized". New report sections are "Item mix by category" (shown without cost too) and "Menu engineering by category" (cost viewers only). `modifier_outages` has the item-outage lifecycle. The operational menu leaves out 86'd modifiers, and leaves out an item whose required group has fewer choices than its minimum. Draft add and SEND refuse an 86'd choice (`MODIFIER_UNAVAILABLE`). Item and modifier outages have `starts_at` and an optional `ends_at` and count only inside that window, worked out on read. "Until close" ends at the next business-day cutoff from `BusinessDateService`. Exclusion constraints (`menu_item_outages_no_overlap`, `modifier_outages_no_overlap`) replace the one-ACTIVE index, so overlapping 86es are refused (`ITEM_ALREADY_86ED` / `MODIFIER_ALREADY_86ED`). The 86 board adds Modifiers 86'd now, Scheduled and Ended today cards and an "86 a modifier" form. `location_settings.running_low_portions` (1–99, default 5) is saved with the auto-86 setting and recorded in its existing audit action. New audits: `inventory.item-location-changed` and `organization.location-settings-changed` (new audit category `ORGANIZATION`). Sales by hour has an inline SVG bar chart above its table.
- **Floor.** `src/workflows/move-table-session` passes a check into `moveSession` / `addTableToSession`. The check runs `checkHoldsForSeating` on the newly taken tables inside the move's transaction, after they are locked, and records overrides with `recordHoldOverrides`. Restaurant still doesn't import Reservations. The floor's move and combine controls have a hold-override reason field for users with `reservations.override-hold`.
- **Time and time clock.** `formatInstant` (in `src/shared/time/`) formats every instant in the location's time zone. The app layout provides the zone to client components (`LocationTimeZoneProvider`), and `EntityForm` reads `datetime-local` values in it. The five browser-local displays were switched. The manager's time clock has a break editor that sends the Phase 18 `breaks` PATCH with a required reason.
- **Notifications.** Seven new kinds. Each has its own link column (`schedule_period_id`, `shift_swap_request_id`, `time_off_request_id`, `employee_certification_id`, `time_entry_id`), enforced by the `notifications_link_matches_type` CHECK, plus a `dedupe_key` that is unique per recipient. `createNotifications` writes them in the caller's transaction, to active users with a role at the location, with `notification.created` outbox events.
  - Schedule publish, swap approval and time-off decisions notify in their own transactions. Time-off denial now runs in a transaction too.
  - `runMaintenance` runs `notifyTimeBasedSignals` under its advisory lock: certifications inside their type's `warning_days`, on-clock employees at the approaching-overtime line this work week, and OPEN entries from an earlier business date. Each location runs in its own transaction, and nothing repeats for a dedupe key.
  - The bell gets each kind's link from one map, and that link depends on what the recipient may open.
- **Checks.**
  - **Tax included in prices.** `tax_rates.price_includes_tax` is snapshotted on the item (`tax_included_snapshot`). `calculateOrderTax` groups by (category, rate, included). Included tax is price × rate ÷ (100 + rate), half up. It comes off `subtotal` through `orders.included_tax_total`, so `total_due = subtotal + tax_total` holds; the totals CHECK is now `subtotal = item_subtotal − discount_total − included_tax_total`.
  - **Tax exemption.** `orders.tax_exempt` and its fields are set and cleared under the new `tax.exempt` permission. The order guard trigger treats `tax_exempt` and `included_tax_total` as amount changes, so neither can change while a settlement is OPEN. The certificate reference refuses 13 or more digits and is never audited.
  - **Shared items.** `splitOrderItem` (scope `orders.split-item`) locks every check in UUID order. It writes `order_item_shares` (2–10 equal shares, cents by largest remainder, with the original's tax snapshot), then sets the item to `SPLIT`, which the freeze trigger allows only alongside those rows. A share is voided for money only; a SPLIT item can't be voided, moved or split again; a whole check holding shares can't be voided. Reports count a SPLIT item once, with the money from its ACTIVE shares.
  - **Tip refunds.** `order_refunds.tip_amount` is allowed only for CASH and EXTERNAL_CARD, up to the RECORDED tender tips (`REFUND_EXCEEDS_TIPS`). Recording or voiding one is refused while the date's tips are finalized. The tip pool, expected drawer cash and the Tips report subtract tip refunds.
- **Labor and tips.**
  - **Daily overtime.** `scheduling_rules.daily_overtime_threshold` is edited on the scheduling rules form. `allocateOvertime` counts daily overtime first and then weekly overtime on the hours that stayed regular. The actual labor sections, the overtime-by-week figure and the live warnings use the combined result; the daily warning line is one hour.
  - **Cash tip declarations.** `tip_declarations` records one row per employee, location and date. Self declarations need `timeclock.punch` and time worked that date; anyone's need `tips.manage`. They are frozen while the date is finalized, audited only for managers and never with the amount. They appear on My time, the Tips page and the Tips report, and are never in the pool.
- **Permissions.** 139 in all: `tax.exempt` (Owner, General Manager, Manager), seeded by `security.service-polish-permissions`.

## Results

- Category snapshot frozen; reports by category: **PASS**
- Modifier and scheduled 86 only where and when in effect: **PASS**
- Held tables protected on move and combine: **PASS**
- Notifications once per change or dedupe key: **PASS**
- `total_due = subtotal + tax_total` with included tax and exemption: **PASS**
- Shares add up; no ledger rows or tickets from a split: **PASS**
- Tip refunds bounded and blocked once finalized: **PASS**
- Overtime never counts an hour twice: **PASS**
- Canonical Bacon Cheeseburger unchanged: **PASS**

## Architectural decisions

The approved decisions are D1–D23 in the plan. Eight amendments made during the build are recorded in the plan under "Amendments decided at implementation":

1. The existing kitchen and low-stock notification writers weren't moved to the new writer.
2. Each kind's link is a CHECK constraint, not part of the guard trigger.
3. Location settings changes use a new `ORGANIZATION` audit category.
4. A whole check holding shares can't be voided (`ORDER_HAS_SHARES`).
5. Reports count a shared item once, with its share money wherever the shares were settled.
6. The daily overtime warning line is one hour.
7. The periodic check can be scoped to some locations, and maintenance can skip it (used by tests).
8. Loading boundaries are on report areas and the audit trail only. The 86 board and the time clock refresh on a timer, and a skeleton there would flash on every refresh.

Other choices made during the build:

- The periodic notifications live in a workflow (`src/workflows/notify-time-based-signals`), because they read Employees, Scheduling and Auth and write Notifications.
- `findTimeClockSignals` and `loadClockSettings` take a location reference rather than a full actor.
- The E2E web server is `tests/helpers/e2e-web-server.ts`. It prepares the test database with the development `DATABASE_URL`, then starts `next dev` or `next start` with `DATABASE_URL` pointed at the test database. Playwright no longer uses `globalSetup`; Vitest still does.

## Migrations

| Migration | Kind | Contents |
|---|---|---|
| `0039_service_polish_menu` | generated | `modifier_outages`, the outage window, the category snapshot, `running_low_portions`, the `ORGANIZATION` audit category |
| `0040_service_polish_menu_guards` | custom | backfill `starts_at`, exclusion constraints, outage guards, the `order_items_freeze` update |
| `0041_service_polish_notifications` | generated | the notification link and dedupe columns, the kind and link CHECKs |
| `0042_service_polish_notifications_guards` | custom | the notifications guard update |
| `0043_service_polish_tax` | generated | `price_includes_tax`, `included_tax_total`, the exemption fields, tax line and item snapshots |
| `0044_service_polish_tax_guards` | custom | the settlement guard and freeze trigger updates |
| `0045_service_polish_shared_items` | generated | `order_item_shares`, the `SPLIT` status |
| `0046_service_polish_shared_items_guards` | custom | the shares guards, the freeze trigger allowing `SPLIT` |
| `0047_service_polish_labor_tips` | generated | `daily_overtime_threshold`, `order_refunds.tip_amount`, `tip_declarations` |

All of them are applied to the development database. `npm run db:generate` then reports no changes.

## Validation results

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run test:unit` | 822 passed |
| `npm run test:integration` | 1304 passed, 1 failed in the full run. The failure was `database-conventions` "advances updated_at", a 3 ms clock gap between Node and PostgreSQL in a Phase 1 test, and it passed on rerun (with the validation tests, 102/102). The tests changed after that run were rerun on their own and pass. |
| `npm run test:e2e` (CI mode, production build) | 149 passed, 0 flaky, in the final run |
| `npm run build` | succeeds |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migration reconstruction and upgrade | `migrations.test.ts` 23/23, including a new upgrade from Phase 19 |
| `npm run db:seed` twice | "1 applied, 22 already applied", then "0 applied, 23 already applied" |
| `npm run db:reset` safeguards | refuses a non-loopback `DATABASE_URL` ("must use a loopback host"); `database-safety` unit tests pass |
| Canonical Bacon Cheeseburger | passes unchanged |
| No inventory ledger row from a Phase 20 path | the shared-item test asserts no new ledger rows or tickets; tip refund and share void assert the same |

## Tests executed

- **Unit:** 822. New: `format-instant`, `outage-window`, `item-shares`; included-tax and exemption cases in `order-tax`; daily overtime in `time-clock`; the running-low threshold.
- **Integration:** 1305 in 84 files. New files: `menu/service-polish-menu`, `notifications/service-polish-notifications`, `orders/tax-included-exempt`, `orders/shared-items`, `settlements/tip-refunds-declarations`. Extended: holds and seating (move and combine), reports (category), actual labor (daily overtime), organization (settings audit), foundation seeds (139 permissions, Phase 19 upgrade), migrations (Phase 19 upgrade), validation seed (Phase 20 step), restaurant day, tips.
- **E2E:** first full CI-mode run 147 passed and 2 failed. Both failures were from this phase: the scheduling cleanup didn't clear outbox events addressed to its users, and the refund button stayed disabled for a tip-only refund. Both were fixed, and those two specs then passed 22/22. A second full run then failed 1 and had 1 flaky test. In `menu-stock-signals.spec.ts`, a text query matched the hidden copy Next.js streams while the new report `Suspense` boundary resolves; it now uses a role query, which skips hidden elements. The stale-data test sometimes got the other change over realtime before it submitted; its second screen now has realtime blocked, which is the situation Reload is for. **Final full run: 149 passed, 0 failed, 0 flaky (4.5 min)**. New spec `service-polish.spec.ts` covers modifier 86 and scheduled 86, tax included, added and exempt, the stale-data Reload, a shared item settled on two checks, and a tip refund. `labor-tips.spec.ts` gained break editing. The "Outbox batch failed" (42P01) line no longer appears.

## Files changed

About 120 tracked files and 54 new ones. The main areas:

- **Schema:** `menu-outages`, `orders`, `organization`, `notifications`, `tax`, `scheduling`, `settlements`, `tips`, `auditing`.
- **Menu:** `outage-service`, `stock-signals`, `operational-menu`, `order-menu-facts`, `outage-window`.
- **Orders:** `order-tax`, `order-repository`, `tax-exemption-service`, `share-service`, `item-shares`, `order-queries`.
- **Workflows:** `submit-order`, `split-order-item`, `move-table-session`, `notify-time-based-signals`, `void-order-item`.
- **Scheduling:** `schedule-notifications`, the timeclock service and rules, `config-service`.
- **Settlements:** `refund-service`, `tip-service`, `tip-declaration-service`, `drawer-math`.
- **Notifications:** `notification-writer`, `notification-links`.
- **Reporting:** `signals-report`, `menu-report`, `sales-report`, `tips-report`, `actual-labor-report`.
- **UI:** the 86 board, the order workspace, the settlement workspace, the floor board, the time clock, My time, the Tips page, admin taxes, the report view and bar chart, the location time provider.
- **Tooling and docs:** `playwright.config.ts`, `.gitignore`. Docs: README, CLAUDE.md, the User Guide, the Phase 17/18/20 plans.

## Risks

- **Maintenance does more each hour.** It runs a few queries per active location. That's cheap for a few locations; the test database's hundreds of fixture locations made it slow, which is why tests scope it.
- **Notifications from scheduling** add one row and one outbox event per scheduled employee with a login, at publish.
- **Shared items and reporting dates.** A shared item's money is reported with the check it was sent on, from all its ACTIVE shares. If the other checks close on a different business date, item mix and that date's net sales differ by the share amounts.
- **Included tax rounds per group,** as added tax already does, so a single line's included tax may differ by a cent from the line's own calculation.
- **Streaming report pages.** While a report section loads, Next.js briefly holds a hidden copy of it, so a browser test that finds report text with `getByText` can match twice. Use role queries (`getByRole("cell", …)`), which skip hidden elements.
- **Test cleanups** that delete users must clear Phase 20 notifications and their outbox events first. `clearNotificationsFor` does; any new cleanup needs it.

## Remaining issues

- **Flaky dev-server E2E specs** (employees, restaurant). I didn't investigate them; every run in this phase was in CI mode, which is how CI runs.
- **No browser test for the bell showing a published schedule.** Schedule notifications are covered by integration tests only.
- **Not built:** recurring daypart 86, auto-86 for modifiers, compound taxes, service charges, splitting a check evenly by amount, double time (all listed out of scope).
- **Housekeeping outside the repository (D23).** A stray empty `C:\Users\kneal\package.json` (3 bytes) and `package-lock.json` (84 bytes), both from 2026-11-04, and the old `restaurant-ops-postgres-1` container (exited 4 weeks ago). They were left alone, pending the owner's go-ahead.
- **Accepted dev-only risks** DEV-001/002/003 are unchanged.

## Next-phase readiness

Phase 20 is complete once this report is reviewed. No Phase 21 is named or planned. Cloud deployment remains on hold by owner decision, and nothing in this phase affects the app's provider independence.
