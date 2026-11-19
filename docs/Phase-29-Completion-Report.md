PHASE 29 COMPLETION REPORT

# Summary

Phase 29 (Seat Numbers and Split by Seat) lets servers ring items by seat, shows the seat to the kitchen, and splits a check into one check per seat in one step. The owner requested it on 2026-11-18 and approved the plan the same day (D1–D12 as recommended). Five amendments were decided along the way: three with the execution plan, and two (amendments 4 and 5) by the owner on 2026-11-19 when the freeze trigger turned out to need a change.

- **Seats.** Each order item on a check at a table session may carry a seat number from 1 to 30, or none ("Table"). It is set when the item is added and can be changed at any time while the check is open, even after SEND. Changing it moves no money, stock or kitchen work.
- **Kitchen.** Station queues and Expo show "S2" on each item, read live, so a seat fixed after SEND reaches the pass.
- **Split by seat.** One action leaves the lowest seat and the "Table" items on the check and moves every other seat to its own new check at the table, each as an ordinary Phase 17 move.
- **Order screen.** A seat selector above the menu, a seat picker on every line, a "By seat" view with per-seat subtotals, and "Split by seat".

There are no new permissions (still 149) and no dependency change. There are two migrations, one more than planned (amendment 4).

# Environment

- Node v26.13.0, npm 12.2.0, Next.js 16.4.5, PostgreSQL 17 (Docker Compose, `postgres:17-alpine`), Windows 11.
- `npm audit --omit=dev`: 0 vulnerabilities.

# Policies (as built)

- **Seat number (column, range, order types, editing after SEND):**
  - `order_items.seat_number smallint NULL` with `CHECK (seat_number IS NULL OR seat_number BETWEEN 1 AND 30)` (0068).
  - Pure rules are in `src/modules/orders/rules/seats.ts`: `validateSeat` (`INVALID_SEAT`) and `assertSeatAllowed` (`SEAT_NOT_ALLOWED` for TAKEOUT or a check without a table session).
  - Set on add: `addDraftItem` takes an optional `seatNumber` (amendment 3).
  - Every later change goes through `PATCH /api/orders/{id}/items/{itemId}/seat` (`orders.edit`, the order's `expectedVersion`), handled by the workflow `src/workflows/set-item-seat`. It refuses when the check isn't OPEN, has an OPEN settlement (`SETTLEMENT_IN_PROGRESS`) or the item is VOIDED (`ITEM_VOIDED`). The same seat again changes nothing. A real change bumps the item's and the order's version.
  - The `order_items_freeze` trigger (replaced in 0069) lets a SUBMITTED or SPLIT item change only its seat on its own check. Every snapshot is still compared, and VOIDED items stay fully frozen (amendment 4).
  - Not audited (policy 6). A change to a sent item writes `order.item-seat-changed` to the outbox in the same transaction.
  - A move carries the seat unchanged. A shared (SPLIT) original keeps its seat and can still change it.
- **Kitchen display (live seat):** `getStationQueue` looks up the current `seat_number` of the order items on the tickets it shows, and `getExpoView` selects it with its existing join. `kitchen_ticket_items` is unchanged. The KDS and Expo show an "S{n}" badge and refresh on `order.item-seat-changed`.
- **Split by seat (which seat stays, new checks, Table items, idempotency, refusals):**
  - `POST /api/orders/{id}/split-by-seat`, handled by `src/workflows/split-by-seat`. It needs `orders.move-items` and `orders.create` (amendment 2) and uses idempotency scope `orders.split-by-seat`.
  - `planSplitBySeat` keeps the lowest seat and the "Table" items on the source check. Each other seat, in seat order, gets a new check on the session through `moveItemsInTransaction`, which was extracted unchanged from `move-order-items`. Each seat therefore writes its transfer rows, recomputes both checks, emits `order.items-moved` and writes one `orders.items-moved` audit row (amendment 1).
  - Voided items and shared originals never move (amendment 5).
  - Refusals:
    - `TAKEOUT_CANNOT_SPLIT`
    - `NOTHING_TO_SPLIT` (fewer than two seats with items that can move)
    - `SETTLEMENT_IN_PROGRESS`
    - `CONCURRENCY_CONFLICT`
    - `PERMISSION_DENIED`

    A refusal writes nothing.
  - Nothing is shared automatically. Item discounts travel with their items; order discounts stay on the first check.
- **Order screen (selector, chips, by-seat view):**
  - Seat selector: "Table", 1 to the party size (or the highest seat in use), and "+ seat". It is hidden on takeout.
  - Each line has a seat picker, or a seat badge when the user can't edit.
  - "By seat" lists the lines per seat with a subtotal of line totals before check discounts and tax. Shared items count only their shares on this check.
  - The "Split by seat" dialog names what stays and what moves, and notes Table items, shared items and check discounts.
- **Permissions, events and boundaries:** No new permission (149), no new audit action, one new outbox event (`order.item-seat-changed`). Price, tax, discount, settlement, inventory and kitchen state rules are unchanged. The demo seed rings dining room lines by seat; the validation fixture is unchanged.

# Results

- Seat editable after SEND without changing any snapshot, ticket or ledger row: **PASS** (`seats.test.ts`: the whole item row except seat, version and `updated_at` is equal; ticket items, ledger count and audit count are unchanged; one outbox event).
- Split by seat moves through recorded transfers, recomputes every check, and a retry creates nothing: **PASS** (3 transfer rows in 2 groups, totals per check, tickets keep their order, no ledger rows, 2 audit rows; a replayed key returns the first result with no extra check).
- Kitchen queues show the current seat: **PASS** (integration for the station queue and Expo; E2E for the KDS before and after a change).
- Canonical Bacon Cheeseburger and idempotent retry unchanged: **PASS** (the existing canonical test, plus a seat-2 variant: identical price, recipe, instructions, stations and consumption to an unseated burger, one batch, and the retry replayed).

# Architectural decisions

- **Seat changes live in a workflow, not an Orders service.** The integration test "order module boundaries" forbids `src/modules/orders` from importing Settlements. The seat change must ask whether a settlement is OPEN, because the order guard trigger only stops changes to the amount and status. So it runs in `src/workflows/set-item-seat`, as the move, split and void workflows do. A first version put it in an Orders service with a new Settlements facts query; the full integration run caught this, and both were removed.
- **Split by seat reuses the move itself.** `moveItemsInTransaction` was extracted from `move-order-items` without changing its behaviour (the Phase 17 move tests pass unchanged). Split by seat therefore has no move logic of its own.
- **The seat is not a snapshot** (D5). It changes nothing computed at SEND, so rule 7 doesn't apply to it. The freeze trigger had to be widened for it (amendment 4) and still freezes every snapshot.
- **The kitchen reads the seat live** (D8) instead of snapshotting it on the ticket item, so no kitchen migration was needed.

# Migrations

- `0068_seat_numbers.sql` (generated): adds `order_items.seat_number` and the `order_items_seat_range` check.
- `0069_seat_numbers_guards.sql` (custom, amendment 4): `CREATE OR REPLACE FUNCTION order_items_freeze()`, the 0066 function plus the `reseating` case.
- After both, `npm run db:generate` reports "No schema changes". Both are applied to the local development database.

# Validation results

| Check | Result |
|---|---|
| `npm run lint` | Pass, no warnings |
| `npm run typecheck` | Pass |
| `npm run test:unit` | Pass: 70 files, 976 tests |
| `npm run test:integration` | Run 1: 1 failure, the Orders boundary test above, fixed. Run 2: 1483 of 1484 passed; the failure was a 2 ms timing flake in `database-conventions.test.ts` ("advances updated_at on update"), not related to Phase 29, which passed 35/35 when re-run. Every Phase 29, move, share, submission and authorization test passed after the fix. |
| `npm run test:e2e` (CI mode, production build) | Run 1: 178 passed, 1 failed. The new test's steps all passed; the kitchen spec's cleanup (`tests/helpers/e2e-kitchen.ts`) didn't delete item shares, which this is the first kitchen test to create. After the fix, `kitchen.spec.ts` passed 7/7. Full re-run: **179 passed** (5.4 min), no failures or flaky tests. Not run against `next dev`. |
| `npm run build` | Pass, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations | 0068 generated and reviewed, 0069 custom; `db:generate` then reports no changes; migration tests in the integration run pass |
| `npm run db:seed` twice | "0 applied, 27 already applied" both times; 149 permissions |
| `npm run db:seed:demo` twice | The first run added the newest service day (13 closed checks, 42 items rung by seat); the second run added nothing |
| `db:reset` safeguards | Pass (`src/db/maintenance/database-safety.test.ts` in the unit run, plus the database integration tests). Not run against the dev database. |
| Canonical Bacon Cheeseburger | Pass, including the idempotent retry and the seat-2 variant |

# Tests executed

- Unit: new `src/modules/orders/rules/seats.test.ts` (11 tests: seat range, allowed order types, split plan, shared and voided items, per-seat subtotals, labels). Suite total 976.
- Integration: new `tests/integration/orders/seats.test.ts` (10 tests) and one new canonical variant in `submission.test.ts`. Suite total 1484.
- E2E: one new test in `tests/e2e/kitchen.spec.ts`: ring by seat, KDS seats, a seat fix reaching the kitchen, split by seat, then sharing the Table soda.

# Files changed

- Schema and migrations: `src/db/schema/orders.ts`; `drizzle/migrations/0068_seat_numbers.sql`, `0069_seat_numbers_guards.sql`, `meta/_journal.json`, `meta/0068_snapshot.json`, `meta/0069_snapshot.json`.
- Orders: `rules/seats.ts` (new), `services/draft-item-service.ts`, `validators/order-validators.ts`, `queries/order-queries.ts`.
- Workflows: `set-item-seat/set-item-seat.ts` (new), `split-by-seat/split-by-seat.ts` (new), `move-order-items/move-order-items.ts` (extracted `moveItemsInTransaction`).
- Other modules: `kitchen/queries/kitchen-queries.ts`, `restaurant/queries/session-facts.ts` (`partySizeForSession`).
- Routes: `src/app/api/orders/[orderId]/items/[itemId]/seat/route.ts`, `src/app/api/orders/[orderId]/split-by-seat/route.ts`.
- UI: `components/orders/order-workspace.tsx`, `components/kitchen/kds-board.tsx`, `components/kitchen/expo-board.tsx`, `components/realtime/realtime-provider.tsx`.
- Seed: `scripts/demo-service-history.ts`.
- Tests: `src/modules/orders/rules/seats.test.ts`, `tests/integration/orders/seats.test.ts`, `tests/integration/orders/submission.test.ts`, `tests/e2e/kitchen.spec.ts`, `tests/helpers/e2e-kitchen.ts`.
- Docs: `README.md` (sections 17, 18, 33, 36), `CLAUDE.md`, `docs/User-Guide.md`, `docs/Phase-29-Seat-Numbers-and-Split-by-Seat.md` (policies and amendments), this report.

# Risks

- **Seat history isn't kept.** A seat change isn't audited (policy 6), so nobody can see who moved an item between seats. The money is fully recorded by transfers when items change checks.
- **Order discounts on split.** They stay on the first check (the Phase 17 move rule). The dialog says so, but guests may expect them divided.
- **Per-seat subtotals are before check discounts and tax.** They can differ from a new check's total due. The view is labelled that way.
- **The staying seat is the lowest seat with movable items.** If seat 1 has only a shared item, seat 2 stays. This is an edge case, and the dialog names the seat that stays.

# Remaining issues

- Existing dev-database checks from before Phase 29 have no seats; only service days added from now on are rung by seat.
- Carried over and unchanged: the real SMTP and Twilio send (the owner's manual check, Phase 22), and the partial validation-seed data on the dev database (owner decision, Phase 28). The demo tips for 2026-11-17 can't be finalized while the intentional open DEMO time entry exists.
- Nothing is committed. The owner commits after reviewing this report.

# Next-phase readiness

Phase 29 is complete and validated. No later phase is scheduled. The remaining candidates from the 2026-11-18 list are gift card balances, a manager log and pre-shift notes, event and private-dining bookings, guest loyalty and FIFO lot costing (the last two each need a rule changed in the contract).
