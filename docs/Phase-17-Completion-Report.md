# Phase 17 Completion Report

This report follows the template in `docs/Phase-17-Checks-and-Closeout.md` §10, plus the sections `CLAUDE.md` requires. Results are from this repository on 2026-11-10.

## Summary

Phase 17 adds five things:

- **Tax.** Each item's tax category and rate are frozen on it at SEND. Orders carry a tax total and a total due, and settlement reconciles to the total due.
- **Refunds.** Refunds are recorded on closed checks. The check itself never changes or reopens.
- **Split checks.** Sent and unsent items can move between checks at the same table.
- **Courses with hold/fire.** Later courses wait on the ticket until someone fires them.
- **Cash drawers.** A drawer opens with a float, records paid-ins and paid-outs, and closes with a count and a variance.

Reports now show tax, refunds and drawer sessions.

**Validation is complete.** You committed this work as `869b7b0`, and GitHub Actions passed on it.

Locally:

| Suite | Result |
|---|---|
| Unit | 755 of 755 passed |
| Integration | 1210 of 1210 passed |
| E2E, first full run | 134 of 138 passed |
| E2E, second full run | 136 of 138 passed |

**The E2E failures** (details under Validation results):

- One was mine: test cleanup and the shared E2E drawer. It is fixed.
- The rest were 5-second UI waits under `next dev`, in specs Phase 17 doesn't touch. Every one of them passed when its spec was rerun on its own.
- Every Phase 17 flow passed in both full runs.

**Please review these decisions.**

- **Your decisions in planning:** the four Tier 1 choices; drawer naming; the location switches on their own endpoints; notification recipients after a move; station work following the item; and test locations opting out of drawers.
- **Defaults I chose:**
  - Hold/fire lives on the ticket. There is no new kitchen item state.
  - The composite send-batch foreign key on `order_items` was replaced by a plain one plus a guard trigger, so that a sent item can move.
  - Tax is left off at the main location in E2E.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 |
| New dependencies | None (`npm audit --omit=dev`: 0 vulnerabilities) |

## Policies (as built)

- **Tax configuration, snapshot and calculation:**
  - *Configuration.* `tax_categories` are organization-wide. `tax_rates` belong to one category and one location, are effective-dated and half-open, and an exclusion constraint forbids overlaps. A rate change closes the open row and inserts a new one, and can't start in the past.
  - *Assignment.* `menu_items.tax_category_id` is the only source of taxability.
  - *Location switch.* `location_settings.tax_enabled` is off by default. With it on, SEND refuses the whole round with `TAX_NOT_CONFIGURED` if any item has no category, or no rate in force.
  - *Snapshot.* SEND freezes each item's category ID, code and rate.
  - *Calculation* (`calculateOrderTax`): order discounts are allocated across items in proportion to each item's net, with leftover cents by largest remainder and ties by ID. Then each (category, rate) group is rounded half up once. Tax is exclusive.
- **Order totals and settlement amount:**
  - `orders.tax_total`, plus `orders.total_due`, a generated column equal to subtotal + tax. `subtotal` still means net sales.
  - The `order_tax_lines` projection is rewritten by `recomputeAndBumpOrder`, which all nine callers use.
  - A settlement snapshots `total_due`, plus `tax_total_snapshot` and a generated `subtotal_snapshot`.
  - The replaced `orders_settlement_guard` closes against subtotal + tax, and locks `tax_total` while a settlement is OPEN. It spells out the sum because generated columns aren't yet computed in a BEFORE trigger.
- **Refund records, limits and void:**
  - Records go in `order_refunds`, with optional `order_refund_items` links to the items concerned.
  - A refund needs a CLOSED order and its COMPLETED settlement, checked by the service and by a trigger.
  - Cumulative RECORDED refunds can't exceed `total_due`, nor their tax `tax_total` (`REFUND_EXCEEDS_ORDER`). Recording locks the order row, so two refunds at once can't both pass.
  - Recording is idempotent (`settlements.refund`). Text fields are checked against card numbers.
  - A refund can be voided with a reason; the row stays as VOIDED.
  - The external reference is never copied to the audit trail.
- **Moving items and the freeze-trigger guard:**
  - Draft and sent items move to an OPEN order on the same session, or to a new check created in the same transaction (`createOrderInTransaction`).
  - Neither order may have an OPEN settlement, and both orders are locked in UUID order.
  - Item discounts move with the item; order discounts stay on the check they were applied to.
  - `order_items_freeze` lets a SUBMITTED item change `order_id` only if an `order_item_transfers` row exists with `moved_at = now()` (written in the same transaction).
  - The command is idempotent (`orders.move-items`).
- **Courses, held tickets and fire:**
  - `order_items.course_number` (1 to 5) is set on drafts and frozen at SEND.
  - SEND with `fire: FIRST_COURSE` holds the courses above the round's lowest. There is one ticket per (send batch, station, course).
  - `kitchen_tickets` gained `held_at`, `fired_at` and `fired_by_user_id`. A guard replaced the append-only trigger and allows exactly one change: firing.
  - Items on an unfired ticket can't be worked (`TICKET_HELD`, in the service and the trigger). A void can still cancel them.
  - Fire (`POST /api/orders/{id}/courses/{n}/fire`, `orders.fire`) is idempotent by state.
  - Station queues show only fired tickets, and ages count from firing. Expo lists held courses. Remake refuses held work.
- **Cash drawers, expected cash and close:**
  - Tables: `cash_drawers`, `cash_drawer_sessions` and `cash_drawer_movements`.
  - Expected cash = float + RECORDED cash tenders with their tips + paid-ins − paid-outs − RECORDED cash refunds.
  - At close the count, expected amount and variance are snapshotted, and CLOSED is terminal. Close is refused while an OPEN settlement holds cash in the drawer.
  - Triggers allow cash, paid-ins and paid-outs only into an OPEN session at the same location.
  - `cash_drawer_required` was set false for every location that existed at migration time; the column default is true for new ones.
- **Report additions:**
  - Sales: a Tax column, a `tax` section by category and rate, and a `refunds` section with net after refunds, counted on the refund's business date.
  - Settlements: a `refunds` section by type and a `drawers` section.
  - Tenders now reconcile to net sales plus tax.

## Architectural decisions

- **Ownership.**
  - Tax configuration is in the Menu module (`tax-service.ts`).
  - The tax arithmetic is a pure rule in Orders (`order-tax.ts`), so Orders still imports nothing from Settlements.
  - Moving items is a workflow (`src/workflows/move-order-items/`), because it needs Settlements' open-settlement check.
  - Drawers and refunds are in Settlements.
  - Fire is in Kitchen (`course-fire-service.ts`).
- **The composite foreign key `order_items_send_batch_order_fk` was replaced.** A sent item's batch belongs to the order the item came from, so a composite (batch, order) key would refuse the move. In its place:
  - a plain foreign key on the batch;
  - `order_items_batch_order_guard`, which requires the batch to belong to the item's own order, or to an order the item was transferred away from.
- **Station work follows the item.** `fulfillmentForOrder` and `getExpoView` join through `order_items`. Tickets keep their original `order_id`, which their batch foreign key requires. READY notifications still go to the original order's server.
- **Location switches** have their own audited endpoints: `PATCH /api/tax/location` and `PATCH /api/drawers/setting`. They are not part of the generic settings form.
- **Drawer naming.** The domain word is `drawers`, because the audit and outbox name CHECKs refuse a hyphen in the domain part.
- **Idempotency fingerprint.** SEND's fingerprint includes `fire` only when it isn't `ALL`, so a key claimed before Phase 17 still matches its retry.
- **Realtime.** Every new event type was added to the client's `EVENT_TYPES`, along with the settlement events, which had been missing so far.

## Migrations

| File | Kind | Content |
|---|---|---|
| `0026_checks_closeout_tax.sql` | generated | `tax_categories`, `tax_rates`, `order_tax_lines`; tax and course columns on items; `orders.tax_total`/`total_due`; `location_settings.tax_enabled`; settlement tax snapshot columns |
| `0027_checks_closeout_tax_guards.sql` | custom | `tax_rates_no_overlap`; replaced `order_items_freeze`, `orders_settlement_guard`, `order_settlements_guard` |
| `0028_checks_closeout_courses.sql` | generated | Ticket course and fire columns; unique (batch, station, course); held index |
| `0029_checks_closeout_courses_guards.sql` | custom | `kitchen_tickets_guard` (replaces the append-only trigger); backfill `fired_at = submitted_at`; `kitchen_tickets_fire_fields` CHECK; held rule in `kitchen_ticket_items_guard` |
| `0030_checks_closeout_transfers.sql` | generated | `order_item_transfers`; batch FK made plain |
| `0031_checks_closeout_transfer_guards.sql` | custom | Transfers append-only; freeze allows a recorded move; `order_items_batch_order_guard` |
| `0032_checks_closeout_drawers_refunds.sql` | generated | Drawer tables, refund tables, tender drawer link, `cash_drawer_required` |
| `0033_checks_closeout_drawers_refunds_guards.sql` | custom | Existing locations set to not require a drawer; session, open-drawer, movement and refund guards |
| `0034_checks_closeout_fk_names.sql` | generated | Renames three foreign keys whose generated names exceeded 63 characters |

All migrations were applied to the test databases and the dev database. `npm run db:generate` then reports "No schema changes". 0034 exists because the migrations test found the long names. 0032 had been applied only to throwaway test databases, but a follow-up migration was still safer than editing a generated file.

## Validation results

- `npm run lint`: pass.
- `npm run typecheck`: pass.
- `npm run test:unit`: 755 of 755 passed (46 files).
- `npm run test:integration`: 1210 of 1210 passed (73 files), in the final run after all changes. Earlier runs found two things I introduced, both fixed: the foreign key names (0034), and the validation fixture needing a drawer.
- `npm run test:e2e`:
  - **First full run:** 134 passed, 4 failed.
    - Audit spec cleanup was blocked by the shared drawer's idempotency record. **Fixed:** the drawer is now opened by a dedicated disabled "keeper" user.
    - Two menu tests and one reservations test failed on 5-second waits. Audit, menu and reservations then passed 19 of 19 on rerun.
  - **Second full run:** 136 passed, 2 failed, both in `restaurant.spec.ts` and both 5-second waits after a click. That spec then passed 18 of 18 on its own.
  - Every Phase 17 flow passed in both full runs: the extended `restaurant-day.spec.ts`, hold/fire, split, settlements and the new `checks-closeout.spec.ts`.
- **GitHub Actions:** passed on `869b7b0` (reported by you).
- `npm run build`: compiled successfully. The only warning is the known stray `%USERPROFILE%\package-lock.json`.
- `npm audit --omit=dev`: 0 vulnerabilities.
- **Migration reconstruction and upgrade:** pass. This includes the new "upgrades a Phase 16 database" test: existing locations have tax off and need no drawer, the column default is true, the new tables are empty and the triggers are present.
- **Seeds:** `npm run db:seed` twice applied 1, then 0.
- **Reset safeguards:** unchanged; their tests pass.
- **Sensitive data:** no card number, reference or refund metadata reaches logs or audit details. The new services write no logs, refund audit fields exclude the reference, and an integration test checks that the audit payload lacks it.

| Result | Status |
|---|---|
| Canonical Bacon Cheeseburger with tax, idempotent replay | PASS |
| Tax snapshot immune to later rate changes | PASS |
| Settlement reconciles to total due | PASS |
| Refund limits under concurrency; order unchanged | PASS |
| Item move keeps snapshots; trigger refuses unguarded move | PASS |
| Held work hidden until fired; fire idempotent | PASS |
| Cash drawer expected/variance exact; close guard | PASS |
| Reports: tax, refunds, drawers; original dates unchanged | PASS |

## Tests executed

**New tests:**

| File | Tests |
|---|---|
| `src/modules/orders/rules/order-tax.test.ts` (unit) | 9 |
| `src/modules/settlements/rules/drawer-math.test.ts` (unit) | 6 |
| `tests/integration/orders/tax.test.ts` | 7 |
| `tests/integration/kitchen/courses.test.ts` | 7 |
| `tests/integration/orders/move-items.test.ts` | 7 |
| `tests/integration/settlements/drawers-and-refunds.test.ts` | 11 |
| `tests/integration/reporting/checks-closeout-reports.test.ts` | 3 |
| `tests/e2e/checks-closeout.spec.ts` | 2 |
| Two new tests in `tests/e2e/kitchen.spec.ts` | 2 |

**Extended tests:**

- `tests/e2e/restaurant-day.spec.ts`: drawer set up and opened, cash into it, a refund on the closed check, the drawer closed with no variance.
- Migrations: the Phase 16 upgrade test.
- Foundation seeds: the Phase 16 upgrade seed test.

**Updated tests** (new counts or labels): permission counts (123 → 132), seed lists, the role matrices, navigation, the report CSV row, the "before tax" UI assertions, and the snapshot = subtotal checks (now total due).

## Files changed

About 68 modified and 45 new files (`869b7b0`). Main areas:

| Area | Files |
|---|---|
| Schema | `src/db/schema/` `tax.ts`, `drawers.ts` (new); `orders.ts`, `kitchen.ts`, `settlements.ts`, `menu.ts`, `organization.ts`, `index.ts` |
| Services | `src/modules/menu/services/tax-service.ts`; `src/modules/settlements/services/drawer-service.ts`, `refund-service.ts`; `src/modules/kitchen/services/course-fire-service.ts`; `src/workflows/move-order-items/` |
| Rules | `src/modules/orders/rules/order-tax.ts`, `src/modules/settlements/rules/drawer-math.ts` |
| Changed workflows and repositories | `submit-order`, `remake-order-item`, `complete-settlement`, `order-repository`, `settlement-service`, `ticket-generation`, `fulfillment-service`, `kitchen-queries` |
| APIs | `src/app/api/tax/*`, `drawers/*`, `drawer-sessions/*`, `refunds/*`; `orders/[orderId]/items/move`, `courses/[course]/fire`, `refunds` |
| UI | `/admin/taxes` and `/cash-drawers` (new); order workspace (course, Send & hold, Fire, Move items, Subtotal/Tax/Total due); settlement workspace (drawer picker, tax rows, refunds); Expo and KDS; menu item tax category; navigation |
| Reporting | `sales-report.ts`, `settlement-report.ts`, `fulfillment-report.ts`, `report-service.ts` |
| RBAC and seeds | `permission-catalog.ts`, `role-catalog.ts`, `src/db/seeds/checks-closeout-permissions.ts`, `registry.ts`; `audit-actions.ts` |
| Tests and helpers | `tests/fixtures/tax-fixtures.ts`; `tests/helpers/e2e-drawers.ts`, `e2e-order-extras.ts`; updated cleanups and fixtures |
| Documentation | `README.md` §17, 18, 19, 33 (Phase 12 reconciliation sentence and a new Phase 17 note), 36; `CLAUDE.md` phase list and domain policies; `docs/User-Guide.md`; `docs/Phase-17-Checks-and-Closeout.md` (plan, with amendments 4–9) |

## Risks

- **Local E2E timing.** Under `next dev`, some untouched specs sometimes miss the 5-second assertion wait under load. Every failure passed when its spec was rerun, and CI (`next start`) passed. Each new Phase 17 page adds a route that `next dev` compiles on its first request.
- **Tax isn't exercised end to end in a browser.** The main location is shared by both E2E workers, so switching tax on there would refuse other specs' SENDs. Tax-on behaviour is covered by integration tests, including the canonical burger.
- **The shared E2E drawer** lives on the main location. Cleanup never removes it, and the test database is rebuilt each run, so it can't leak beyond a run.
- **Notifications after a split.** READY notifications go to the original check's server. Both checks are on one session, so they are normally the same person.

## Remaining issues

1. **Your decision: an E2E tax-on browser test.** It would need a location of its own (and accounts there). Not built.
2. **Not built, by plan scope:** reopening checks, tax-inclusive pricing, exemptions, sharing one item across checks, tip pooling and payout, refunding tips.
3. **Carried over:**
   - the stray `%USERPROFILE%\package-lock.json`;
   - the old `restaurant-ops-postgres-1` container;
   - the unanchored `.gitignore` rules;
   - the Phase 6 held-table move gap;
   - browser-local times in the settlement and notification panels;
   - the "Outbox batch failed" (`42P01`) E2E harness line;
   - DEV-001, DEV-002 and DEV-003.
4. **Your development server was stopped for the E2E runs.** The dev database is migrated and seeded for Phase 17; restart `npm run dev`.

## Next-phase readiness

Phase 17 is complete and validated, and CI passed on `869b7b0`. No Phase 18 is scheduled. The candidate from the 2026-11-10 list is a time clock with tip pooling, which would need your approval and a plan first. Cloud deployment stays on hold.
