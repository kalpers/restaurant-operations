# Phase 29: Seat Numbers and Split by Seat Design and Implementation Plan

## Purpose

Owner request, 2026-11-18: order items carry the seat they are for, and a check can be split into one check per seat in a single step.

Servers in a full-service room ring items "by seat" so food runners know who gets which plate and so the check can be split the way guests ask ("separate checks, please"). Today the app has neither: items have a course but no seat, and splitting means moving items one group at a time.

What already exists (reviewed 2026-11-18):

| Area | What is there | Where |
|---|---|---|
| Course number | `order_items.course_number` (1 to 5), chosen on drafts, frozen at SEND by the freeze trigger | `src/db/schema/orders.ts` line ~281; `drizzle/migrations/0066_*` freeze trigger |
| Freeze trigger | Lists every snapshot column a sent item may not change; a column it doesn't list stays editable | `0066_pricing_forecast_nutrition_guards.sql` |
| Moving items | `POST /api/orders/{id}/items/move` (`orders.move-items`, idempotent): draft and sent items between OPEN checks on one table session, or into a new check; `order_item_transfers` row per move; both orders locked in UUID order and recomputed; not for TAKEOUT; refused while either order has an OPEN settlement | `src/workflows/move-order-items/move-order-items.ts`, `validators/order-validators.ts` `moveItemsSchema` |
| Shared items | One sent item shared 2 to 10 ways between checks on its session (`SPLIT`, `order_item_shares`); kitchen work and consumption stay on the original | `src/workflows/split-order-item/`, `services/share-service.ts` |
| Party size | `table_sessions.party_size`, `guest_parties.party_size` (> 0) | `src/db/schema/restaurant.ts`, `guest-parties.ts` |
| Kitchen ticket items | Snapshots of name, modifiers, instructions and allergy alert; tickets keep their original order; order screens and Expo find station work through the item | `src/db/schema/kitchen.ts` |
| Draft item edit | `PATCH /api/orders/{id}/items/{itemId}` under `orders.edit` (course, quantity, modifiers, instructions) | `src/app/api/orders/[orderId]/items/[itemId]/route.ts`, `draft-item-service.ts` |
| Printed check | None. Checks are shown on screen only | — |
| Order outbox events | `order.items-submitted`, `order.items-moved`, `order.item-split`, `order.closed` | `src/workflows/*` |

No new permission is expected (149 stays), and one generated migration.

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | Scope? | **A seat number on each order item, editing it, showing it, and "Split by seat".** Out: a seat map or seat positions on the floor plan, seat-level reports, guest names per seat, a printed check, and linking seats to guest profiles. | These are what a server needs during service. The rest has no request behind it and would need its own rules. |
| D2 | Where does the seat live? | **`order_items.seat_number`, a nullable `smallint`, 1 to 30 (check constraint).** Null means "Table" (shared, or not assigned). No seats table, and nothing stored on the session or party. | A number on the item is all that splitting and delivery need. A seats table would have to be kept in step with party size changes, moves and combines, for no gain. |
| D3 | Must the seat fit the party size? | **No hard limit beyond 1 to 30.** The order screen offers seats 1 to party size (at least 1) plus "Table", and a "+ seat" button for one more; the server accepts any seat in range. | Party size is often wrong (a late arrival, a child). Refusing an item because of it would get in the way during service. 30 covers a long banquet table. |
| D4 | Which orders use seats? | **DINE_IN and BAR orders on a table session.** TAKEOUT and bar tabs with no session can't have a seat (`SEAT_NOT_ALLOWED`), and the seat control is hidden there. | Splitting by seat runs through moves, which already need a table session. A takeout bag has no seats. |
| D5 | Is the seat frozen at SEND? | **No. It stays editable after SEND**, while the item's order is OPEN with no OPEN settlement and the item is not VOIDED. `PATCH .../items/{itemId}/seat` under `orders.edit` takes the order's `expectedVersion` and bumps it. The freeze trigger is unchanged, because it doesn't list the new column. Unlike the course, the seat doesn't change price, stock, tax, tickets or timing. | Servers fix seats after the food has gone out ("that was seat 3, not 2"). Rule 7 freezes price, modifier, recipe and consumption facts; the seat is none of these and changes nothing that was computed from it. |
| D6 | Is a seat change audited? | **Not in the audit trail.** A change after SEND emits `order.item-seat-changed` after commit (outbox), so Expo and the order screen refresh. The order's `version` covers concurrency. | The audit trail holds sensitive and money actions (audit decision). A seat moves no money. |
| D7 | Shared items (SPLIT)? | **A `SPLIT` original keeps its seat; shares have none.** Moving an item carries its seat unchanged (to the other check). | Shares already belong to separate checks, so a seat on them adds nothing. |
| D8 | Kitchen and bar tickets? | **Ticket items show the item's current seat ("S2"), read from the order item when the ticket is shown, not snapshotted.** No kitchen schema change. Station queues, Expo and the order screen show it. | The seat tells a runner where the plate goes, so a fix after SEND should reach the pass. Nothing historical depends on it, and Expo already reads station work through the item. |
| D9 | What does "Split by seat" do? | **One action, `POST /api/orders/{id}/split-by-seat` (`orders.move-items`, idempotency scope `orders.split-by-seat`).** The source check keeps its "Table" items and its lowest seat; every other seat with items on the check moves to a new check on the same session, one check per seat, in seat order. It runs in one transaction through the same move rules (`order_item_transfers` row per item, both orders locked, totals recomputed, the same refusals). It is refused when fewer than two seats have items (`NOTHING_TO_SPLIT`). Draft items move as well as sent ones. | One step for the common request, with no new way of moving items. Keeping the lowest seat on the source check means a two-seat table ends with two checks, not three. |
| D10 | And the "Table" items? | **They stay on the source check.** After the split the screen lists them with the existing Share action (Phase 20), so the server can share each one across the new checks or leave it. The split itself never shares anything. | Whether the shared appetizer is shared or paid by one guest is the guests' choice. An automatic share would also share items still in draft, which Phase 20 doesn't allow. |
| D11 | Order screen? | **A seat selector above the item list ("Table, 1, 2, … +").** New items take the selected seat. Each item line has a seat chip that opens a small picker. A "By seat" view groups the lines by seat with a subtotal per seat. The "By seat" subtotal is a sum of the line totals before order discounts and tax, and it is labelled that way. "Split by seat" is in the check menu, with a confirm dialog naming the checks it will create. | It follows how servers ring: pick a seat, add that guest's items. A per-seat subtotal before discounts and tax avoids a second allocation rule for order discounts. |
| D12 | Reports, seeds and leftovers? | **No report changes.** The demo seed gives seats to the items of some demo dine-in checks (idempotent, local dev DB only); the validation fixture is unchanged. The Phase 28 leftovers stay as decided (manual SMTP/Twilio check, dev DB validation-seed cleanup is the owner's call). | Seat-level reporting has no use case yet. Demo data shows the feature. |

## Approved Phase 29 Policies

Approved by the owner on 2026-11-18: D1–D12 as recommended. These are binding.

1. **Scope (D1).** A seat number on order items, editing and showing it, and split by seat. A seat map, seat-level reports, names or profiles per seat and a printed check stay out.
2. **Column (D2).** `order_items.seat_number`, nullable `smallint`, `CHECK (seat_number BETWEEN 1 AND 30)`; null means "Table". No seats table; nothing on the session or party.
3. **Range (D3).** Any seat 1 to 30 is accepted; party size only shapes the screen's offered seats.
4. **Order types (D4).** DINE_IN and BAR orders on a table session only; otherwise `SEAT_NOT_ALLOWED`.
5. **Editable after SEND (D5).** While the order is OPEN with no OPEN settlement and the item is not VOIDED; `PATCH /api/orders/{id}/items/{itemId}/seat` under `orders.edit` with the order's `expectedVersion`, bumping it. The freeze trigger does not list the column.
6. **Not audited (D6).** A change after SEND emits `order.item-seat-changed` through the outbox; concurrency by the order's `version`.
7. **Shares and moves (D7).** A `SPLIT` original keeps its seat, shares have none; a move carries the seat unchanged.
8. **Tickets (D8).** Station queues, Expo and the order screen show the item's current seat, read from the order item; no kitchen schema change.
9. **Split by seat (D9).** `POST /api/orders/{id}/split-by-seat` under `orders.move-items`, idempotency scope `orders.split-by-seat`. The source keeps "Table" items and its lowest seat; each other seat with items moves to a new check on the session, in seat order, in one transaction through the move rules (transfer rows, locks, recompute, refusals). Fewer than two seats: `NOTHING_TO_SPLIT`. Drafts move with sent items.
10. **Table items (D10).** Stay on the source check; the screen then offers the existing Share action. The split never shares.
11. **Order screen (D11).** Seat selector (Table, 1 to party size, +), seat chip per line, a "By seat" view with per-seat subtotals of line totals before order discounts and tax (labelled so), and the split in the check menu with a confirm dialog.
12. **Reports and seeds (D12).** No report change. The demo seed gives seats to some demo dine-in items; the validation fixture is unchanged.
13. **Boundaries.** Two migrations (0068 generated, 0069 custom; amendment 4), no new permission (149), no change to price, tax, discount, settlement, inventory or kitchen state rules.

## Amendments decided at implementation

Approved by the owner on 2026-11-18 with the execution plan.

1. **Audit and events for split by seat (policy 9).** Each seat moved is one Phase 17 move: one `orders.items-moved` audit row and the two `order.items-moved` outbox events per new check. No new audit action.
2. **Permission for new checks (policy 9).** Split by seat needs `orders.create` as well as `orders.move-items`, like any move into a new check.
3. **Seats on drafts (policy 5).** Adding an item takes an optional `seatNumber`; every later change, draft or sent, goes through the one seat route. The draft edit request is unchanged.
4. **A custom migration, `0069` (found while building; owner decision 2026-11-19).** The `order_items` freeze trigger refused every change to a sent item other than a recorded move, a split into shares or a void, so policy 5 couldn't hold with the trigger unchanged (the plan's D5 and policy 13 were wrong on this). `0069` replaces `order_items_freeze`: a SUBMITTED or SPLIT item may change only its `seat_number` (with `version` and `updated_at`) on its own check; every snapshot is still compared; VOIDED items stay fully frozen. Two migrations in all (`0068` generated, `0069` custom), as in every phase since 17.
5. **Shared items in a split by seat (policy 9; owner decision 2026-11-19).** The freeze trigger doesn't let a SPLIT original move, and its money is already on its share checks, so split by seat leaves it on the source check like a voided item. The split dialog says so.

## 1. Objectives

Servers ring items by seat, food runners see the seat on the ticket, and a check is split into one check per seat in one step without losing any of the Phase 17 move guarantees.

## 2. Scope Boundary

In: the `seat_number` column and constraint; setting it on drafts and changing it after SEND; showing it on the order screen, station queues and Expo; the "By seat" view; the split-by-seat workflow and API; the outbox event; migrations, tests, the demo seed and documentation for these.

Out: a seat map or floor positions; seat-level reports; names or guest profiles per seat; a printed check; automatic sharing of "Table" items; any change to price, tax, discount, settlement, inventory or kitchen state rules; cloud deployment.

## 3. Review Existing Foundation Before Changes

- `src/db/schema/orders.ts` (`order_items`), the freeze trigger in `0066`, and the order guards on CLOSED orders.
- `orders/services/draft-item-service.ts`, `order-service.ts`, `validators/order-validators.ts`, the item `PATCH` route.
- `src/workflows/move-order-items/move-order-items.ts` (locking, transfer rows, recompute, refusals, idempotency) and `split-order-item/` (shares).
- `orders/queries/order-queries.ts` (order screen read), kitchen station and Expo queries, and the realtime subscription for `order.*` events.
- `src/components/orders/order-workspace.tsx` and `order-api.ts`.
- `src/infrastructure` outbox event name check (the regex and the domain word), and the idempotency scopes.

## 4. Build Order

1. **Migration 0068** (generated and reviewed): `order_items.seat_number smallint NULL` with a `CHECK (seat_number BETWEEN 1 AND 30)`. No custom migration is expected, since the freeze trigger stays as it is (D5). If a database guard turns out to be needed (for example, no seat change on a CLOSED order beyond what the order guards give), add it as a custom `0069` and record it as an amendment.
2. **Seat on drafts**: `seatNumber` on add and draft edit (Zod shape; `SEAT_NOT_ALLOWED` in the service for TAKEOUT or no session).
3. **Seat change after SEND** (D5, D6): service, route, version bump, outbox event.
4. **Split by seat** (D9, D10): pure rule that plans the checks from the items (which seat stays, which seats move, in what order), then the workflow built on the move internals, the route, and idempotency.
5. **Kitchen display** (D8): station queue, Expo and order screen reads add the item's current seat.
6. **Order screen** (D11): seat selector, chips, "By seat" view, split dialog, Share prompt for "Table" items.
7. Demo seed (D12).
8. Tests (sections 5–7), docs (section 8), validation (section 9), completion report.

## 5. Unit Tests

- Split plan: lowest seat and "Table" items stay; each other seat gets one new check in seat order; voided and `SPLIT` items are handled as the move rules handle them; fewer than two seats gives `NOTHING_TO_SPLIT`.
- Seat validation: 1 to 30 or null; refused for TAKEOUT and orders with no session.
- Per-seat subtotal: the sum of line totals per seat, "Table" separate, decimal strings.

## 6. Integration Tests

- **Canonical Bacon Cheeseburger** passes unchanged, with no seat. A variant with seat 2: SEND snapshots are identical apart from the seat, and the idempotent retry adds nothing.
- Changing the seat of a sent item succeeds while OPEN; it is refused on a CLOSED order, with an OPEN settlement, on a VOIDED item and with a stale `version`; no snapshot, ticket, ledger or audit row changes; `order.item-seat-changed` is written to the outbox in the same transaction.
- Split by seat on a check with seats 1, 2, 3 and "Table" items, drafts and sent items, an item discount and an order discount: seat 1 and "Table" stay; two new checks hold seats 2 and 3; one `order_item_transfers` row per moved item; totals recomputed on every check; tickets keep their order; inventory and kitchen state untouched; a retry with the same key creates no extra check or transfer.
- Split by seat is refused for TAKEOUT, with an OPEN settlement, with fewer than two seats, and with a stale version; a refusal writes nothing.
- Station queue and Expo reads show the current seat after a change.
- A `SPLIT` original keeps its seat; moving an item keeps its seat.

## 7. E2E Tests (Playwright)

- A server seats a party of three, rings items on seats 1, 2 and 3 and one "Table" appetizer, sends, sees "S2" on the kitchen queue, changes one item's seat and sees it update.
- The server chooses "Split by seat": three checks result, the appetizer stays on the first, and sharing it across the three checks works.

## 8. Documentation

- README: section 17 (Orders: seat number, editable after SEND, split by seat), section 18 (seat shown on tickets, read live), and Phase 29 entries in sections 33 and 36.
- CLAUDE.md: add Phase 29 to the phase list and a short seat line under Orders.
- `docs/User-Guide.md`: ringing by seat and splitting by seat.
- `docs/Phase-29-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (stop `npm run dev` first); a dev-server run is advisory
- [ ] `npm run build`, with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migration 0068 generated and reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicate permissions or grants (149); `db:seed:validation` and `db:seed:demo` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger, including the idempotent retry, passes unchanged

## 10. Risks

- **Seat is mutable after SEND (D5).** A seat change isn't in the audit trail, so the history of who moved an item between seats isn't kept. The money it ends up on is still fully recorded by transfers.
- **Order discounts on split.** By the Phase 17 move rules, item discounts travel with their item but order discounts stay on the source check, and every check is recomputed. Servers may expect an order discount to divide across the seats, so the split dialog says it stays on the first check (the server can remove it and apply discounts per check).
- **Per-seat subtotal is before discounts and tax (D11).** It may differ from the new check's total due after the split. The label says so.

## 11. Required Phase 29 Completion Report

Write `docs/Phase-29-Completion-Report.md`:

```text
PHASE 29 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Seat number (column, range, order types, editing after SEND):
- Kitchen display (live seat):
- Split by seat (which seat stays, new checks, Table items, idempotency, refusals):
- Order screen (selector, chips, by-seat view):
- Permissions, events and boundaries:

Results
- Seat editable after SEND without changing any snapshot, ticket or ledger row: PASS / FAIL
- Split by seat moves through recorded transfers, recomputes every check, retries create nothing: PASS / FAIL
- Kitchen queues show the current seat: PASS / FAIL
- Canonical Bacon Cheeseburger and idempotent retry unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI and dev, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
