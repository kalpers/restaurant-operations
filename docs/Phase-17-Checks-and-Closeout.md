# Phase 17: Checks and Close-out Design and Implementation Plan

## Purpose

Phase 17 fills the gaps a real service night hits first. Today:

- **No tax.** Settlement reconciles to the post-discount, pre-tax `orders.subtotal` (README section 19). The guest check isn't a complete check.
- **No corrections after close.** A trigger (`orders_settlement_guard`, migration 0020) makes a CLOSED order terminal, and nothing records money returned to a guest.
- **Split checks are only half built.** A Table Session can hold several orders (Phase 9), but an item can't move from one check to another, so a table can't split its bill after ordering.
- **No courses or hold/fire.** Every sent item enters the kitchen queue at once (deferred in Phase 10).
- **No cash accountability.** Cash tenders record received and change, but nothing ties them to a drawer, a starting float or a count at close.

Phase 17 was added by owner decision on 2026-11-10. It changes these written contract points, which the owner approved:

- README section 19: "Tax calculation is deferred" and "Refunds and post-close corrections are deferred" are replaced by policies A and B below. A CLOSED order **stays terminal**: refunds are separate records and nothing reopens an order.
- README section 18: courses and hold/fire move from "deferred" to built (policy D). The kitchen item states in `CLAUDE.md` (`NEW/PREPARING/READY/COMPLETED/CANCELLED`) are unchanged.

Before implementation:

1. Read `CLAUDE.md` and `README.md`, especially sections 17 (Orders), 18 (Kitchen and Bar), 19 (Settlement), 21 (Reporting), 24 (Transaction Boundaries), 25 (Concurrency) and the Phase 9, 10, 11 and 12 notes in section 33.
2. Read the Phase 9, 10 and 11 plans and completion reports: totals and discounts, the SEND transaction, ticket generation and queues, the settlement amount lock and the close-order workflow.
3. Read `docs/accepted-risks.md`. This phase should add no dependency.

## Approved Phase 17 Policies

### A. Tax

1. **Configuration.** Two new tables, owned by the Menu module:
   - `tax_categories`: organization-scoped, `code` (unique per organization), `name`, `description`, `active`. Deactivated, never deleted.
   - `tax_rates`: one rate per category and location, `rate_percent NUMERIC(7,4)` between 0 and 100, effective-dated and half-open `[effective_from, effective_to)` like menu prices. An exclusion constraint forbids two rates in force for one category and location. A change closes the open row and inserts the new one in one transaction, can't start in the past, and takes an optional `expectedCurrentRateId`.
2. **Explicit taxability.** `menu_items.tax_category_id` (nullable). Taxability is never inferred from the item type, category, order type or food/alcohol classification. A zero-rated item uses a category with a 0% rate.
3. **Location switch.** `location_settings.tax_enabled BOOLEAN NOT NULL DEFAULT false`. While false, nothing is taxed and SEND behaves exactly as today. While true, SEND refuses the whole round with `TAX_NOT_CONFIGURED` (`details.items`: item names) if any item has no tax category, or its category has no rate in force at the location.
4. **Snapshot at SEND.** Each submitted item stores `tax_category_id`, `tax_category_code_snapshot` and `tax_rate_snapshot` (null when tax is disabled), resolved at the SEND instant in the same transaction. The `order_items_freeze` trigger adds these columns. A later rate change never changes a sent item (rule 4).
5. **Calculation** (pure rule `calculateOrderTax` in `src/modules/orders/rules/`):
   - Tax applies to the post-discount amount. Each SUBMITTED item's taxable base is its line total minus its item discounts, minus its share of order discounts.
   - Order discounts are allocated across items in proportion to what remains of each line after item discounts. Cents go by largest remainder (ties: item ID), so the shares add up exactly to the order discount amount.
   - Items are grouped by (tax category, rate snapshot). Tax per group = ROUND_HALF_UP(Σ base × rate / 100) to cents, using BigInt decimal arithmetic. Order tax = sum of the groups.
   - Items with a null rate are untaxed. Tax is exclusive (added on top of prices). Tips are never taxed. A fully comped order has zero tax and still closes with no tender.
6. **Order columns.** `orders.tax_total NUMERIC(12,2) NOT NULL DEFAULT 0` and `orders.total_due NUMERIC(12,2) NOT NULL`, with the check `total_due = subtotal + tax_total`. `subtotal` keeps its meaning: post-discount and pre-tax, which is what reports call net sales. `order_tax_lines` (order, category, code and rate snapshots, taxable base, tax amount) is a projection rewritten whenever totals are recomputed, like applied discount amounts. Existing orders are backfilled with `tax_total = 0`, `total_due = subtotal`.
7. **Settlement.** Opening a settlement snapshots `total_due` as `order_amount_snapshot`, plus new `subtotal_snapshot` and `tax_total_snapshot` columns (backfilled from existing rows with `tax_total_snapshot = 0`). Reconciliation, completion and the `orders_settlement_guard` trigger compare against `total_due`. The guard treats changes to `tax_total` and `total_due` as amount changes (refused with `SETTLEMENT_IN_PROGRESS`). The trigger is replaced by a custom migration, never by editing 0020.
8. **Permissions and audit.** `tax.view` and `tax.manage` (categories, rates, the location switch). Assigning a category to a menu item uses the existing menu item edit permission and its `menu.item-updated` audit (the field is added to the allow-list). New audit actions: `tax.category-created`, `tax.category-updated`, `tax.rate-changed`, `tax.location-setting-changed`.

### B. Refunds (record only; the order stays CLOSED)

9. **Records.** `order_refunds`, owned by Settlements:
   - order, the order's COMPLETED settlement, location, `refund_number` per order (1, 2, …);
   - `status` `RECORDED` or `VOIDED`;
   - `tender_type` (the five Phase 11 types), `amount NUMERIC(12,2) > 0` (what was returned, including tax), `tax_amount NUMERIC(12,2)` between 0 and `amount`;
   - `reason` (required), `other_description` (required for `OTHER`), `external_reference`, `cash_drawer_session_id` (policy E);
   - `business_date` (from BusinessDateService when recorded), recorded-by user and time, void fields (by, at, reason), `idempotency_record_id`, `version`.

   `order_refund_items` optionally links the refund to items of the order (informational: which items the guest complained about). Linked items must be SUBMITTED items of that order.
10. **Rules.**
    - Only a CLOSED order can be refunded. The order, its items, snapshots, settlement and tenders are unchanged. The close-order trigger stays as it is.
    - Cumulative RECORDED refunds can't exceed the order's `total_due`, and cumulative refund tax can't exceed its `tax_total` (`REFUND_EXCEEDS_ORDER`). Tips are not refundable through this record.
    - Card safety is the same as for tenders: safe metadata only, and every text field refuses 13 or more consecutive digits (Zod, service and check constraint).
    - Refunds never touch inventory, fulfillment, table sessions or discounts.
    - A RECORDED refund can be voided with a reason (`settlements.refund-void`). It stays as VOIDED, and a trigger keeps refunds append-only apart from that one change.
11. **Concurrency and idempotency.** Recording locks the order row (`FOR UPDATE`; the guard trigger only refuses *changes* to a closed order) so cumulative checks can't race. Recording takes a client idempotency key (scope `settlements.refund`); a retry returns the first refund.
12. **Events.** Outbox `settlement.refund-recorded` and `settlement.refund-voided` (identifiers only). Audit `settlements.refund-recorded` and `settlements.refund-voided` (refund ID, order number, amount, tax amount, tender type; never references or card metadata).
13. **Permissions.** `settlements.refund` and `settlements.refund-void`, held by Owner, General Manager and Manager.

### C. Moving items between checks (split checks)

14. **Command.** `POST /api/orders/{orderId}/items/move` with item IDs, a target (an existing order ID, or "new check"), the expected version of both orders, and an idempotency key (scope `orders.move-items`). Permission `orders.move-items`.
15. **Conditions.**
    - Source and target are both OPEN and on the same ACTIVE Table Session. TAKEOUT orders can't move items.
    - Neither order has an OPEN settlement (`SETTLEMENT_IN_PROGRESS`).
    - Every item belongs to the source and is DRAFT or SUBMITTED. VOIDED items don't move.
    - "New check" creates the target in the same transaction through the existing order-creation service. It copies the session's Guest Party and server, and gets its own order number.
16. **Locking.** Both orders are locked in UUID order (no deadlock) and both versions are checked (`CONCURRENCY_CONFLICT`).
17. **Effects, in one transaction.**
    - Each item's `order_id` changes, and one append-only `order_item_transfers` row is written per item (item, from, to, transfer group, actor, time).
    - Item discounts travel with the item, because they reference it. Order discounts stay on the source order and are recomputed there.
    - Both orders' totals, including tax, are recomputed and both versions are bumped.
    - Snapshots, modifiers, consumption rows and prices are unchanged.
18. **Database guard.** `order_items_freeze` is replaced so that a SUBMITTED item's `order_id` may change only if an `order_item_transfers` row for that item, from `OLD.order_id` to `NEW.order_id`, exists with `moved_at = now()` (the current transaction's timestamp). Every other frozen column stays frozen.
19. **Kitchen.** Tickets and ticket items keep their original `order_id` and snapshots, because they record what was sent and when. Order screens, Expo readiness, voids and Remakes find station work by `order_item_id`. Build step 3 verifies each query that finds station work through `kitchen_ticket_items.order_id`, and switches it to `order_item_id` where the result should follow the item.
20. **Events.** Outbox `order.items-moved` for both orders. Audit `orders.items-moved` (from and to order numbers, item IDs).

### D. Courses and hold/fire

21. **Course on the item.** `order_items.course_number SMALLINT NOT NULL DEFAULT 1`, from 1 to 5. Editable on drafts, frozen at SEND (added to the freeze trigger).
22. **SEND option.** SEND takes an optional `fire`:
    - `ALL` is the default and today's behavior.
    - `FIRST_COURSE` fires the lowest course in the round and sends higher courses **held**.

    Everything else in the canonical SEND transaction is unchanged, including idempotency: price, modifier, recipe and consumption snapshots, and the CONSUME postings all happen at SEND for held items too. Food committed to the order is accounted for once.
23. **Tickets.**
    - `kitchen_tickets` gains `course_number`, `held_at`, `fired_at` and `fired_by_user_id`. There is one ticket per (send batch, station, course): the partial unique index `(send_batch_id, prep_station_id)` becomes `(send_batch_id, prep_station_id, course_number)`. Existing rows get course 1.
    - A non-held ticket has `fired_at = submitted_at`. A held ticket has `held_at` set and `fired_at` null until fired.
    - The ticket freeze trigger allows exactly one change: `fired_at`/`fired_by_user_id` from null to set.
    - There is no new item state. While a ticket is held its items stay `NEW`, and a trigger refuses any item transition while its ticket is unfired (`TICKET_HELD`).
24. **Queues.**
    - Held tickets are hidden from `/kitchen` and `/bar`.
    - `/expo` and the order screen show them under "Held" with their course.
    - Age and the warning/late bands count from `fired_at`, not `submitted_at`.
25. **Fire.**
    - `POST /api/orders/{orderId}/courses/{course}/fire` (permission `orders.fire`) fires every held ticket of that course on the order, at once, in one transaction. It needs an OPEN order and doesn't change the order's amount or version, so it is allowed while a settlement is OPEN.
    - Firing a course with nothing held returns the current state and writes nothing (idempotent by state).
    - Outbox `kitchen.course-fired` refreshes KDS screens.
26. **Voids and Remakes.** A held item is still `NEW`, so an `UNPREPARED` void reverses its stock as today and cancels the held work. Remake is refused on a held ticket's items (`TICKET_HELD`).
27. **Permission.** `orders.fire`: Owner, General Manager, Manager, Server and Bartender.

### E. Cash drawers

28. **Tables**, owned by Settlements:
    - `cash_drawers`: location, `code` unique per location, `name`, `active`. Deactivated, never deleted.
    - `cash_drawer_sessions`:
      - drawer, location, `session_number` per drawer, `business_date`;
      - `status` `OPEN` or `CLOSED`;
      - `opening_float NUMERIC(12,2) >= 0`, opened by and at;
      - at close: closed by and at, `counted_amount`, `expected_amount` and `variance` (snapshots), `close_note`;
      - `version`.

      A partial unique index allows one OPEN session per drawer. CLOSED is terminal (trigger).
    - `cash_drawer_movements`: session, `movement_type` `PAID_IN` or `PAID_OUT`, `amount > 0`, `reason`, recorded by and at, `idempotency_record_id`. Append-only.
29. **Links.** `settlement_tenders.cash_drawer_session_id` (CASH only, check constraint) and `order_refunds.cash_drawer_session_id` (CASH only). The session must be OPEN and at the same location.
30. **Location setting.** `location_settings.cash_drawer_required`. The migration adds it with default false, so existing locations are unaffected, then changes the column default to true, so any location created afterwards (including the foundation seed on a fresh database) requires a drawer. While true, a CASH tender or CASH refund without an OPEN session is refused with `CASH_DRAWER_REQUIRED`. While false, the link is optional. Changing it needs `cash-drawers.manage` and is audited.
31. **Expected cash** = opening float + Σ RECORDED cash tenders in the session (`amount + tip_amount`, which is received minus change) + paid-ins − paid-outs − Σ RECORDED cash refunds in the session. Voided tenders and refunds don't count. Cash tips are listed on the close-out for information. Tip payout isn't built.
32. **Close.**
    - The operator enters the counted amount. The server computes `expected_amount`, stores both, and stores `variance = counted − expected`.
    - Closing is refused while any OPEN settlement has a RECORDED cash tender in that session (`DRAWER_HAS_OPEN_SETTLEMENTS`). Without this, a later tender void could change a closed drawer's figures.
    - After close, nothing can be recorded into or voided out of the session (`DRAWER_SESSION_CLOSED`).
33. **Concurrency.** Tenders, refunds and movements lock the session `FOR SHARE` after the order and settlement locks. Close locks it `FOR UPDATE` and checks `version`. Opening, paid-in/out and close take idempotency keys.
34. **Permissions.**
    - `cash-drawers.view`: Owner, General Manager, Manager, Server and Bartender (to choose a drawer when recording cash).
    - `cash-drawers.operate` (open, close, paid in/out): Owner, General Manager and Manager.
    - `cash-drawers.manage` (drawer setup and the location setting): Owner and General Manager.
35. **Events.** Audit `cash-drawers.session-opened`, `cash-drawers.session-closed` (float, expected, counted, variance), `cash-drawers.paid-in`, `cash-drawers.paid-out`, `cash-drawers.drawer-created`, `cash-drawers.drawer-updated`, plus `cash-drawers.setting-changed` for the location setting. Outbox events for session open, close and movements (identifiers only).

### F. Reporting

36. Reports stay read-only and derive from snapshots and history (rule 11):
    - **Sales:** adds Tax (from `tax_total` of CLOSED orders), Refunds (RECORDED refunds by *refund* business date) and Net after refunds. Gross, discounts and net sales keep their Phase 12 definitions. An original date's figures never change when a later refund is recorded.
    - **Tax** (new section in the sales area): taxable base and tax by business date and tax category/rate, from `order_tax_lines` of CLOSED orders, with refund tax as a separate line.
    - **Settlements:** refunds by tender type. A new **Cash drawers** section lists sessions in the range with float, cash in, paid in, paid out, cash refunds, expected, counted and variance.
    - CSV export covers the new sections. No materialized view.

## Amendments decided at planning

Decided on 2026-11-10, when Phase 17 was planned:

1. **Owner decisions (questions asked):** tax categories with effective-dated location rates (A); refund records only, no reopen (B); move draft and sent items between checks on the same session (C); cash drawers required per location setting (E).
2. **Hold/fire design (recorded, not asked).** Holding is a property of the *ticket* (`held_at`/`fired_at`), not a new kitchen item state, so the item lifecycle in `CLAUDE.md` and README section 18 stays as written.
3. **Cash drawer default and tests.** Because the foundation seed creates the location on a fresh database, the test databases get `cash_drawer_required = true`. Integration and E2E tests that record cash open a drawer session through a shared helper (`tests/helpers`). Tests about something else may switch the setting off in their own setup. The canonical `restaurant-day.spec.ts` opens and closes a drawer as part of the day.

Decided on 2026-11-10, when `/phase 17` was planned (owner approved the execution plan):

4. **Drawer naming.** The `audit_events_action_format` and `outbox_events_event_type_format` CHECKs (`^[a-z]+[.][a-z-]+$`) refuse a hyphen in the domain part, so `cash-drawers.*` can't be stored. The domain word is `drawers` throughout. The permissions are `drawers.view`, `drawers.operate` and `drawers.manage`. The audit actions are `drawers.session-opened`, `drawers.session-closed`, `drawers.paid-in`, `drawers.paid-out`, `drawers.drawer-created`, `drawers.drawer-updated` and `drawers.setting-changed` (category SETTLEMENTS). The outbox events are `drawer.*`. Wherever this plan says `cash-drawers.*`, read `drawers.*`.
5. **Location switches.** `tax_enabled` and `cash_drawer_required` are changed only through their own endpoints, under `tax.manage` and `drawers.manage`, and every change is audited. They are not changed through the generic location settings form, which shows both read-only.
6. **READY notifications after a move** still go to the server of the ticket's original order (resolved through the send batch). Both checks are on the same session.
7. **Station work follows the item.** The order screen's fulfillment lines and Expo grouping find station work by `order_item_id`, through the item's current order. Tickets keep their original `order_id`, because the `kitchen_tickets_batch_order_fk` foreign key requires it.
8. **Fixtures.** Integration fixture locations set `cash_drawer_required = false` explicitly. E2E uses a shared, idempotent "E2E" drawer session on the seeded main location.
9. **Reconciliation wording.** Net sales plus tax reconcile to RECORDED tenders on completed settlements. Before Phase 17 it was net sales alone.

## 1. Objectives

Deliver:

- Tax categories, location rates, menu item assignment, tax snapshots at SEND, order tax and `total_due`, settlement against `total_due`
- Refund records with optional item links, void, idempotency and reporting
- Moving items between checks on one session, with the guarded freeze trigger and transfer history
- Course numbers, SEND with `FIRST_COURSE`, held tickets, fire, KDS and Expo changes
- Cash drawers, sessions, paid-in/out, close-out with variance, tender and refund links, the location setting
- Report additions (sales, tax, refunds, cash drawers) with CSV
- Nine new permissions (`tax.view`, `tax.manage`, `orders.move-items`, `orders.fire`, `settlements.refund`, `settlements.refund-void`, `cash-drawers.view`, `cash-drawers.operate`, `cash-drawers.manage`; 132 in all), role grants and an idempotent `security.checks-closeout-permissions` seed
- UI: Admin → Taxes, the tax category on menu items, tax lines on order and settlement screens, Move items, the course selector with Send & hold and Fire, Held on Expo, Refund on a closed order, `/cash-drawers`, and the drawer picker on the cash tender form
- README, CLAUDE.md, User Guide updates and `docs/Phase-17-Completion-Report.md`

## 2. Scope Boundary

Out of scope (don't build):

- Reopening a closed order, cancelling a completed settlement, or changing anything on a CLOSED order
- Tax-inclusive pricing, compound or stacked taxes, per-order tax exemption, tax on tips or fees, service charges
- Sharing one item across several checks (fractional splits) or splitting evenly by amount
- Tip pooling, tip payout, time clock and payroll (candidate Phase 18)
- Refunding tips; refund processing of any kind (record only)
- New kitchen item states; automatic course timing (fire is always manual)
- Card, bank or payment processing columns; cloud deployment (on hold)

## 3. Review Existing Foundation Before Changes

Confirm from code rather than memory:

- `calculateOrderTotals` and `recomputeAndBumpOrder` (`src/modules/orders/`): where tax and `order_tax_lines` fit so every caller (SEND, voids, discounts, moves) recomputes them.
- Every reader of `orders.subtotal` as "the amount due": settlement open and complete, `settlement-math`, the order and settlement screens, the dashboard and reports. Each must use `total_due` where it means the amount owed, and keep `subtotal` where it means pre-tax net sales.
- The `orders_settlement_guard` and `order_items_freeze` functions (migrations 0014 and 0020), replaced in custom migrations.
- `createTicketsForSendBatch`, the kitchen queue queries, the readiness derivation, `void-sync.ts` and the Remake workflow: how station work is found (by order or by order item), and the ticket freeze trigger (migration 0016).
- `recordTender` and `voidTender`: where the drawer lock and the CASH link fit in the lock order.
- The order creation service, so "new check" reuses it inside the move transaction.
- `src/modules/auditing/audit-actions.ts`: register each new action, its category, entity type, scope and allow-listed fields.
- The demo and validation seeds and `tests/helpers`: what records cash today and must open a drawer.
- `tests/integration/database/migrations.test.ts`: the new migrations must pass the upgrade checks.

If any of these conflicts with the policies above, stop and explain before changing it.

## 4. Build Order

Each step generates its own migration with `npm run db:generate` (plus custom migrations for triggers), reviewed before applying. Each step leaves lint, typecheck, and unit and integration tests green before the next starts.

1. **Tax:** tables, `menu_items.tax_category_id`, `location_settings.tax_enabled`, item tax snapshots, `orders.tax_total`/`total_due`, `order_tax_lines`, settlement snapshot columns, replaced guard trigger. Tax rule, SEND resolution, totals recompute, settlement on `total_due`. Permissions seed (all nine codes at once).
2. **Courses and hold/fire:** `course_number`, ticket columns and index, trigger changes, SEND `fire` option, fire command, queue and Expo queries.
3. **Move items:** `order_item_transfers`, replaced item freeze trigger, move command and the kitchen query review (policy 19).
4. **Cash drawers:** tables, links, location setting, sessions, movements, close, tender integration, test helper.
5. **Refunds:** tables, record and void, drawer integration.
6. **Reporting:** sales, tax, refunds, cash drawers, CSV.
7. **UI and E2E.**
8. **Documentation and the completion report.**

## 5. Unit Tests

- *Tax:* allocation of order discounts by largest remainder (exact sum, tie by ID); grouping by rate; ROUND_HALF_UP at the half-cent; a 0% category; null rates untaxed; fully comped orders; item plus order discounts together; many items at one rate (rounding per group, not per item).
- *Totals:* `total_due = subtotal + tax_total` for every case above.
- *Refund limits:* cumulative amount and tax limits, including voided refunds not counting.
- *Drawer math:* expected cash with tenders, tips, change, paid in/out, refunds and voided rows; variance sign.
- *Course split:* `FIRST_COURSE` holds exactly the courses above the lowest in the round; `ALL` holds nothing.
- *Ticket age:* bands from `fired_at`.
- *Config and validators:* course range, rate range, money strings, card-number refusal on refund fields.

## 6. Integration Tests

- **Canonical scenario with tax:** the Bacon Cheeseburger (Medium, No Onion, Extra Pickles, Swiss instead of American) at a location with tax enabled: the item snapshots its tax category and rate; `tax_total` and `total_due` are exact; the settlement snapshot is `total_due`; the same idempotency key replayed adds no ticket, inventory movement, snapshot or tax line. All the existing canonical assertions still pass.
- **Tax:**
  - SEND refuses an item with no category or no rate in force, writing nothing;
  - a rate change after SEND changes nothing sent;
  - discounts change tax exactly;
  - settlement can't complete for the pre-tax amount;
  - the guard trigger refuses a tax change while a settlement is OPEN;
  - existing orders keep `total_due = subtotal`;
  - tax disabled behaves exactly as Phase 11.
- **Refunds:**
  - refused on a non-CLOSED order or over the limits;
  - the order, items, settlement and inventory are unchanged;
  - concurrent refunds can't exceed the total;
  - a retry with the same key returns the first refund;
  - void keeps the row;
  - permissions are enforced;
  - audit details hold no reference or card metadata.
- **Move items:**
  - draft and sent items move with their discounts, and both totals and taxes recompute exactly;
  - refused across sessions, for takeout, with a settlement open, for voided items, or with a stale version;
  - "new check" creates a numbered order on the session;
  - a direct `UPDATE` of a sent item's `order_id` without a transfer row is refused by the trigger;
  - kitchen work and readiness follow the item;
  - a void after a move reverses stock correctly.
- **Courses and hold/fire:**
  - `FIRST_COURSE` creates held tickets for later courses with consumption already posted;
  - held work is absent from station queues and present on Expo;
  - start/ready on held work is refused by the service and the trigger;
  - fire releases every held ticket of the course once, and firing again writes nothing;
  - an `UNPREPARED` void of a held item reverses stock;
  - a SEND retry creates no extra held ticket.
- **Cash drawers:**
  - with the setting on, a cash tender without a session is refused;
  - expected, counted and variance are exact;
  - close is refused with an open settlement holding a cash tender in the session;
  - nothing records into a closed session;
  - a concurrent tender and close serialize correctly;
  - one OPEN session per drawer;
  - with the setting off, cash works without a drawer.
- **Reports:** tax, refunds and drawer sections match the fixture exactly; a refund on a later date doesn't change the original date's figures; permission and location scoping hold.
- **Migrations:** reconstruction from all migrations and the upgrade-from-Phase-16 checks pass; backfilled `total_due` and settlement snapshot columns are correct.

## 7. E2E Tests (Playwright)

- **`restaurant-day.spec.ts` (extended):**
  - the manager opens a cash drawer;
  - with tax enabled, the server sends drinks, then sends appetizers and entrees with "Send & hold";
  - the entree course is fired from the order screen, and Kitchen sees it only after firing;
  - the table splits: two items move to a new check;
  - each check settles to its total including tax, one in cash into the drawer;
  - the manager records a partial refund on one closed check;
  - the manager closes the drawer with the counted amount and sees the variance;
  - the reports show the tax, the refund and the drawer.
- An Admin → Taxes flow: create a category and a rate, assign it to a menu item, enable tax for the location.
- A Server can't see Refund, Admin → Taxes or drawer operations; the APIs refuse them.
- Every existing spec still passes, with drawer setup added where cash is recorded.

## 8. Documentation

- **README section 17:** moving items between checks, courses.
- **README section 18:** held and fired tickets.
- **README section 19:** tax in the amount due, refunds and cash drawers. Replace the "deferred" sentences.
- **README section 21:** the new report sections.
- **README section 33:** a "Phase 17 Checks and Close-out" note with the policies as built.
- **README section 36 and the `CLAUDE.md` phase list and settlement policy summary:** Phase 17 (added when this plan was written; the policy summary is updated at completion).
- **`docs/User-Guide.md`:** taxes setup, Send & hold and Fire, moving items, refunds, opening and closing a drawer.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` (stop `npm run dev` first)
- [ ] `npm run build`
- [ ] `npm audit --omit=dev` clean (no dependency added)
- [ ] Migrations generated, reviewed and committed; `npm run db:generate` then reports no changes
- [ ] Migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants
- [ ] The canonical Bacon Cheeseburger test passes with tax enabled and an idempotent replay
- [ ] `grep` confirms no card number, reference or refund metadata reaches logs or audit details

## 10. Required Phase 17 Completion Report

Write `docs/Phase-17-Completion-Report.md`:

```text
PHASE 17 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Tax configuration, snapshot and calculation:
- Order totals and settlement amount:
- Refund records, limits and void:
- Moving items and the freeze-trigger guard:
- Courses, held tickets and fire:
- Cash drawers, expected cash and close:
- Report additions:

Results
- Canonical Bacon Cheeseburger with tax, idempotent replay: PASS / FAIL
- Tax snapshot immune to later rate changes: PASS / FAIL
- Settlement reconciles to total due: PASS / FAIL
- Refund limits under concurrency; order unchanged: PASS / FAIL
- Item move keeps snapshots; trigger refuses unguarded move: PASS / FAIL
- Held work hidden until fired; fire idempotent: PASS / FAIL
- Cash drawer expected/variance exact; close guard: PASS / FAIL
- Reports: tax, refunds, drawers; original dates unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
