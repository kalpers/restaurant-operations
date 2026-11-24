# Phase 37 Completion Report: Lot Costing

Plan: `docs/Phase-37-Lot-Costing.md`, approved by the owner on 2026-11-23 with decisions D1–D14 as recommended and contract changes C1–C3 (C4 not taken: supplier invoices stay record only). Nothing has been committed; the owner commits.

## Summary

An inventory item tracked in lots can now be **costed by lot**. Stock leaving such an item is costed from the lots it actually leaves (first to expire, or a named lot), instead of one moving average. A plate's food cost at SEND therefore follows the delivery its ingredients came from, and it is frozen like every other snapshot.

- **Lot value.** Each lot carries a per-unit cost and the exact value of what remains.
- **Ledger cost.** The ledger row's cost is the sum of its lot movements' costs.
- **Reports.** Every cost report already read that ledger cost, so none was rewritten.
- **Switching method.** Value carries over both ways, and each switch writes an append-only record per location.
- **Unchanged.** Weighted average stays the default, and weighted-average items behave exactly as before.

No new permission, no dependency change, two migrations (`0091`, `0092`).

## Environment

| | |
|---|---|
| Node | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker Compose) |
| OS | Windows 11 Pro (tests run in PowerShell) |

## Policies (as built)

### Costing method per item and switching (policies 2 and 3)

**The method.** `inventory_items.costing_method` is `WEIGHTED_AVERAGE` (the default) or `LOT`, and it is organization-wide.
- Two database checks back it: `inventory_items_costing_method_valid`, and `inventory_items_lot_costing_needs_lots` (`LOT` needs `lot_tracked`).
- Turning lot tracking off is refused while an item is `LOT` (`LOT_COSTING_ACTIVE`).

**Changing it.** `changeCostingMethod` is in `src/modules/inventory/services/costing-method-service.ts`.
- Reached through `PUT /api/inventory/items/{id}/costing-method` and the item page's new **Costing** section.
- Needs `inventory.configure` and the item's `version`.
- Refused with `LOT_COSTING_NEEDS_LOTS` when the item isn't lot tracked, and with `COSTING_METHOD_UNCHANGED` when it already uses that method.

**Reason codes.** The reason is a code: `SUPPLIER_PRICES_VARY`, `OWNER_OR_ACCOUNTANT_REQUEST`, `CORRECTION` or `OTHER`. See "Architectural decisions" for why it isn't free text.

**Carry-over.** The change locks the item and every balance of it in location order.
- **To `LOT`:** each open lot is carried at the location's current average. `carrying_unit_cost` is set to the average and `value_remaining` to quantity × average. The lot's received `unit_cost` is kept for information.
- **Back to weighted average:** the average becomes stock value ÷ quantity, half-up to four places, and lot carrying values are cleared.
- **Refused while a shortfall from before is open** (`LOT_COSTING_SHORTFALL_OPEN`). Such a shortfall has no cost, so the lots couldn't carry the stock's value.

**Records.** Each change writes one `inventory_costing_changes` row per location. It holds the quantity, the value before and after, the average after, the last ledger sequence, the reason code, the user and the time. The table is append-only by trigger. No ledger row is posted.

**Audit.** `inventory.costing-method-changed` (category INVENTORY) records the item code, method, reason code and location count, never the values.

### Decreases, increases, reversals and transfers (policies 4, 5 and 7)

**Order of work.** For a `LOT` item, `postInventoryTransaction` reads the method under the balance lock, which a method change also holds. It then calls `planLotCostedPosting` (`lot-costed-posting.ts`) **before** inserting the ledger row. The lots are allocated and updated, the cost is decided, the ledger row and balance are written, and then the lot movements are written with their cost. The weighted-average path is unchanged.

**Decreases.** `CONSUME` (SEND and remakes), `WASTE`, `ADJUST_DECREASE`, `COUNT_DECREASE`, `TRANSFER_OUT` and the transfer-shortage decrease are all costed this way.
- Each lot gives quantity × carrying cost, half-up to four places, and never more than it holds.
- Taking the last of a lot takes all of its remaining value, so a lot's value always reaches zero with its quantity (tested: three takes of 10.00 / 3 cost 3.3333, 3.3333 and 3.3334).
- The ledger's `total_cost` is the sum of the movement costs, and `unit_cost` is that total ÷ quantity, for display.

**Increases.**
- **`RECEIVE`** enters at its own cost (carrying cost = the receipt's base-unit cost; value = the exact receipt total).
- **`SALE_REVERSAL`** returns stock to exactly the lots its CONSUME took from, at the value it took. A movement from before lot costing is valued at its ledger row's unit cost.
- **`ADJUST_INCREASE` / `COUNT_INCREASE`** make a found lot at the on-hand cost (stock value ÷ quantity), else the latest lot's carrying cost, else no cost.

**Transfers.** `TRANSFER_OUT` stores the exact `value_sent` on the line, beside `unit_cost_sent`. `TRANSFER_IN` enters at exactly that value and recreates the sent lots at the sender's carrying costs, with the last piece adjusted so the total is exact. Stock the sender didn't hold in lots arrives as a found lot for the remainder. `value_sent` is frozen after send (guard `0092`). Lines sent before Phase 37 still use unit cost × quantity.

### Negative stock and cost differences (policy 6)

A CONSUME beyond the lots (where negative stock is allowed) leaves a shortfall movement. It is costed at the last lot that removal took from, else the latest lot received at the location, else no cost.

When a new lot covers the shortfall:
- the lot gives its own value;
- the shortfall closes at its posted cost;
- the difference is stored on the lot-side settlement movement (`inventory_lot_movements.cost_difference`).

The sale keeps the cost it was sent at. Stock value moves by the difference on the covering posting, so value stays traceable.

### Valuation (policy 8)

A `LOT` item's value is its open lots' `value_remaining` less open shortfalls at their posted cost.
- It is kept in `inventory_balances.stock_value` and on each ledger row as `stock_value_after`, so it can be reproduced from the ledger alone.
- `weighted_average_cost` / `average_cost_after` keep being written for `LOT` items as value ÷ quantity, shown as "average on hand".
- `reconcileLotValues` (`stock-queries.ts`) proves the balance equals the lots and the ledger. Every new test calls it, and it reported no mismatch on the dev demo data.
- Weighted-average items have `stock_value` and `stock_value_after` null and are valued at quantity × average as before.

### Reports (policy 9)

No report was rewritten: usage, waste, count variance, menu item cost, menu engineering, item mix and bundle cost all read the ledger's `total_cost`. Added:

**Usage and variance by item:**
- a **Costing** column. Its key is `method`, and it notes "method changed in this range" when a change falls between two movements inside the range.
- a **Closing value** (cost) column: the ledger's `stock_value_after`, or quantity × average.

**New Inventory sections, for `inventory.cost.view` holders only:**
- **Negative stock cost differences**, by the date the covering lot arrived.
- **Stock value by lot (on hand now)**.

**Lot trace:** each lot's received cost and "Carried at", and each movement's cost (cost columns only with `inventory.cost.view`).

**Screens:**
- **Inventory page:** a Costing column, and "on hand" beside a lot-costed item's average.
- **Lots page:** "received at …" and "carried at …, worth …".

The ledger listing hides `stock_value_after` without `inventory.cost.view`.

### Invoice cost follow-up (policy 10)

Option A: supplier invoices stay record only for both methods. Nothing in Phase 37 reads or writes invoices.

## Results

| Check | Result |
|---|---|
| Removals of LOT items cost exactly the sum of the lots taken | PASS (`lot-costing.test.ts`: 4 at 1.00 + 2 at 2.00 = 8.0000, per-movement costs stored; last-of-lot rounding) |
| Stock value equals open lots less open shortfalls and is reproducible from the ledger | PASS (`reconcileLotValues` empty after every case, the order test and the dev demo data) |
| Switching method changes no past ledger row, movement or plate cost, and no on-hand value | PASS (switch test: value before = value after = 7.0002; back to weighted average 1.7000; shortfall test: the sale keeps 10.0000) |
| Transfer value in equals value out | PASS (14.0000 sent, 14.0000 received, lots recreated at 3.3333 and 2.0000) |
| WEIGHTED_AVERAGE items behave exactly as before | PASS (dedicated test; every existing inventory, order, kitchen, transfer, count and report suite passes unchanged) |
| Canonical Bacon Cheeseburger and Burger Combo with idempotent retries unchanged | PASS (both suites unchanged and green; new `lot-costing-at-send.test.ts` runs the canonical burger with Swiss costed by lot: the slice costs 0.1000 from its lot, a retry posts nothing, a void returns 0.1000) |

## Architectural decisions

- **The lots decide the cost before the ledger row exists.** The ledger is append-only, so the cost can't be filled in afterwards. The planner locks and updates lots first and collects the movements. The movements are inserted once the ledger row exists (a foreign key needs it). The Phase 23 deferred quantity check still runs at commit.
- **Per-lot remaining value, not only a carrying cost.** Storing `value_remaining` makes value conservation exact: a receipt of 27.99 for 12,000 mL leaves the lot worth exactly 27.99, whatever the rounding of each use. The plan's "Σ lots × carrying cost" is computed this way.
- **Settlements inside one posting.** When one posting creates several lots (a transfer-in), the planner remembers what it has already settled, so a shortfall isn't covered twice before its movements are written.
- **Reason code instead of free text (an implementation choice inside D2).** Phase 34 promised that every staff-typed text field joins the guest erase search. A free-text reason on an append-only table would have needed a redaction exception. A fixed code keeps guest text off cost records entirely.
- **Two database guards from the plan were made test checks instead.** The plan listed a deferred trigger for "ledger cost = sum of movement costs" and one for "movement cost present on LOT rows after the switch". Settlement pairs are written under the *original* CONSUME row, and the lot side of a pair can't be told apart from an allocation at the database level without changing a Phase 23 check. So both rules are proved by `reconcileLotValues` and the integration tests instead. The guards that were built are:
  - `inventory_costing_changes` is append-only;
  - `value_sent` is frozen after send;
  - the `LOT`-needs-lots check;
  - non-negative cost checks.
- **"Stock value by lot" shows lots on hand now.** Lot values at a past date can't be replayed exactly, because the switch-over sets values without a movement. The value at the end of a range is shown in the usage section's "Closing value" from the ledger instead.
- **Boundaries.** The inventory boundary test now allows:
  - `lot-costed-posting.ts` to move lots, as part of the posting service;
  - `costing-method-service.ts` to re-value balances and lots. It also checks that this service never changes a quantity and posts no ledger row.

## Migrations

| Migration | Kind | Content |
|---|---|---|
| `0091_phase_37_lot_costing.sql` | generated | `inventory_items.costing_method` (default `WEIGHTED_AVERAGE`) with two checks; `inventory_balances.stock_value`; `inventory_transactions.stock_value_after`; `inventory_lots.carrying_unit_cost`, `value_remaining`; `inventory_lot_movements.unit_cost`, `total_cost`, `cost_difference`; `inventory_transfer_lines.value_sent`; new table `inventory_costing_changes` (reason code checked); non-negative checks |
| `0092_phase_37_lot_costing_guards.sql` | custom | `inventory_costing_changes` append-only trigger; `inventory_transfer_lines_guard` replaced to also freeze `value_sent` after send |

Both were generated before any database applied them. The first draft (with a free-text reason) was deleted and regenerated with the journal edited back. `npm run db:generate` afterwards reports no schema changes. New nullable columns need no backfill: existing rows keep their cost, and existing items stay weighted average (upgrade test).

## Validation results

| Step | Result |
|---|---|
| `npm run lint` | Pass (exit 0) |
| `npm run typecheck` | Pass |
| `npm run test:unit` | 86 files, 1099 / 1099 passed |
| `npm run test:integration` | Full run: 127 files, 1655 / 1656 passed. The one failure was fixed (see below); the affected suites were rerun green (22 files, 202 tests: security matrix, all inventory, all reporting, both lot-at-SEND order suites). |
| `npm run test:e2e` (CI mode, after a fresh `npm run build`) | 196 / 197 passed (11.8 min). The one failure was in the new spec and was fixed; `lot-costing.spec.ts` was rerun in CI mode, 2 / 2 passed. |
| `npm run build` | Pass, no warnings |
| `npm audit --omit=dev` | 0 vulnerabilities (no dependency change) |
| Migration reconstruction and upgrade | Pass: the database suite (117 tests) includes the rebuild test and a new Phase 36 → 37 upgrade test |
| Seed idempotency | Dev database migrated (`db:migrate`). `db:seed` twice: 0 applied, 34 already applied (no new permission or seed). `db:seed:validation`: the first run applied the fixture on this dev database; the second did nothing. `db:seed:demo` twice: the first run switched the mozzarella to lot costing and received two deliveries; the second printed "mozzarella already costed by lot" and added nothing else. |
| `db:reset` safeguards | Unchanged; the reset guard tests in the integration suite pass. `db:reset` was not run. |
| Canonical tests | Bacon Cheeseburger and Burger Combo, with idempotent retries, unchanged and passing |

**Fixed during validation:**
1. **Security matrix.** The full integration run's one failure was the Phase 13 security matrix's "cost columns need `inventory.cost.view`": the new usage column's key `costing` matched `/cost/`, although it holds only a method name. The key became `method`.
2. **E2E assertion.** The E2E failure was the new spec expecting "$2.0000 on hand". The page renders the figure and an "on hand" span with no text space between them, so the assertion now allows optional whitespace.

**Demo data check.** On the dev database the two new mozzarella lots are carried at 0.2438 and 0.2730 (12% more), worth exactly their receipt totals (78.0000 and 87.3600). `reconcileLotValues` found no mismatch.

## Tests executed

| Kind | File | Tests |
|---|---|---|
| Unit | `src/modules/inventory/rules/lot-costing.test.ts` | 15 |
| Integration | `tests/integration/inventory/lot-costing.test.ts` | 9 |
| Integration | `tests/integration/orders/lot-costing-at-send.test.ts` | 1 |
| Integration | `tests/integration/database/migrations.test.ts` (new Phase 36 upgrade case; table list) | +1 |
| Integration | `tests/integration/inventory/authorization.test.ts` (boundary checks for the new files) | extended |
| E2E | `tests/e2e/lot-costing.spec.ts` | 2 |

The integration cases cover:
- the switch: lot tracking needed, carry-over both ways, the records, audit without values, append-only, lot tracking can't be turned off, and refusal while an earlier shortfall is open;
- first-to-expire costing, and the last of a lot taking its whole value;
- shortfall cost and the settlement difference;
- a sale reversal returning to the same lots at the same cost;
- found stock at the on-hand cost;
- exact transfer value, with `value_sent` frozen;
- weighted-average items unchanged.

## Files changed

- **Schema and migrations:**
  - `src/db/schema/inventory.ts`
  - `drizzle/migrations/0091_phase_37_lot_costing.sql` and `0092_phase_37_lot_costing_guards.sql`
  - `meta/0091_snapshot.json`, `meta/0092_snapshot.json`, `meta/_journal.json`
- **Inventory module:**
  - new: `rules/lot-costing.ts` (+ test), `services/lot-costed-posting.ts`, `services/costing-method-service.ts`
  - changed: `services/posting-service.ts`, `lot-posting.ts` (createLot takes carrying cost and value), `lot-service.ts` (refusal while `LOT`, costs in the lots list), `item-service.ts`, `stock-operations.ts`, `transfer-service.ts` (`value_sent`)
  - changed: `queries/stock-queries.ts` (lot-costed valuation, `reconcileLotValues`, hidden `stock_value_after`), `validators/inventory-validators.ts`
- **API and screens:**
  - new: `src/app/api/inventory/items/[itemId]/costing-method/route.ts`
  - changed: `src/app/(app)/inventory/items/[itemId]/page.tsx`, `inventory/page.tsx`, `inventory/lots/page.tsx`, `src/components/inventory/format.ts`
- **Reporting:** `src/modules/reporting/queries/inventory-report.ts`, `services/lot-trace-service.ts`
- **Auditing:** `src/modules/auditing/audit-actions.ts`
- **Tests:**
  - new: `tests/integration/inventory/lot-costing.test.ts`, `tests/integration/orders/lot-costing-at-send.test.ts`, `tests/e2e/lot-costing.spec.ts`
  - changed: `tests/integration/inventory/authorization.test.ts`, `tests/integration/database/migrations.test.ts`
- **Demo:** new `scripts/demo/lot-costing.ts`; changed `scripts/seed-demo.ts`
- **Docs:** `README.md` (sections 16, 21, 33, 36, 39), `CLAUDE.md`, `docs/Demo-Data.md`, `docs/Phase-37-Lot-Costing.md` (plan, approved policies), this report

## Risks

- **Two methods side by side.** A report range spanning a switch mixes methods. The Costing column notes it, and each row keeps the method it was posted under.
- **Negative stock differences land on the covering receipt's date, not on the sale** (D6). Managers need to read the new section to see them.
- **Database guards are partly tests.** The "ledger cost = sum of movements" rule is proved by `reconcileLotValues` and tests, not by a trigger (see "Architectural decisions"). Any future writer of lot movements must keep it, and the boundary test limits which files may.
- **Switch rounding.** Carrying open lots at the average values each lot at quantity × average half-up, so a switch can differ from quantity × average by fractions of a cent. Both values are stored on the change record.
- **Receivers' entered cost is the cost of record** (D10 A). A receiver who enters the PO price instead of the invoiced price leaves the lot at that cost.

## Remaining issues

- None blocking.
- The demo-rerun-on-a-later-day issue noted in the Phase 36 report (an earlier day's "today" tables) is unchanged. Phase 37 didn't touch the history step.
- The Phase 22 manual check of a real SMTP and Twilio send is still open.

## Next-phase readiness

Phase 37 is built and validated: lint, typecheck, unit, integration, CI-mode E2E, build and audit all pass after the two fixes noted. There are no schema differences after the migrations. No later phase is scheduled. Cloud deployment remains on hold by owner decision. When the owner has reviewed this report and committed the work, any next phase needs its own plan and approval.
