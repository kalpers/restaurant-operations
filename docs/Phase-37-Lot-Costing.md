# Phase 37: Lot Costing Design and Implementation Plan

## Purpose

Phase 37 is the "FIFO lot costing" candidate deferred from Phase 23 (D10), Phase 28 (section 11) and Phase 36 (D1, D28), plus the invoice-cost follow-up that Phase 36 left open ("cost correction is left to a later phase").

**Goal:** for an item that opts in, the cost of stock leaving comes from the lots it actually left, not from one moving average. A plate's food cost then reflects the delivery its ingredients came from.

**Status: approved by the owner on 2026-11-23** (D1–D14 as recommended).

What already exists (reviewed 2026-11-23):

| Area | What is there | Where |
|---|---|---|
| The one posting | `postInventoryTransaction` locks the balance, works out the cost, inserts the ledger row, updates the balance, then posts lot movements and the low-stock alert. Incoming rows with their own cost (`RECEIVE`, `TRANSFER_IN`, `SALE_REVERSAL`) re-average; every other row is valued at the current average and doesn't change it | `src/modules/inventory/services/posting-service.ts` |
| Weighted average | Per item and location, `NUMERIC(14,4)`, half-up after each receipt, special rules at or below zero on hand (Phase 8 policy) | `src/modules/inventory/rules/costing.ts`, README section 16 "Weighted-average cost" |
| Ledger | Append-only `inventory_transactions` with `unit_cost`, `total_cost`, `quantity_after`, `average_cost_after`; a direction check forbids zero-quantity rows; "valuation can be reproduced from history alone" | `src/db/schema/inventory.ts` |
| Lots (Phase 23) | Opt-in per item (`inventory_items.lot_tracked`, organization-wide). `inventory_lots` hold `unit_cost` **for information only** (receipt: the receipt's base-unit cost; increases and the opening lot: the average; transfers: copied from the source lot). Append-only `inventory_lot_movements` (no cost column) sum to their ledger row (deferred trigger, migration 0059). Decreases take lots first to expire (FEFO), or a named lot; a CONSUME beyond the lots leaves a shortfall that the next increase settles; a sale reversal returns stock to the exact lots | `src/modules/inventory/services/lot-posting.ts`, `rules/lot-allocation.ts`, `lot-service.ts` |
| Transfers | `TRANSFER_OUT` freezes the sender's unit cost on the line (`unit_cost_sent`); `TRANSFER_IN` enters at `unit_cost_sent × base quantity` and recreates the sent lots with their costs | `src/modules/inventory/services/transfer-service.ts` |
| Reports | Inventory usage, waste and count variance cost, menu item cost, menu engineering, item mix and the server/void sections all read `total_cost` from the ledger (through `order_item_inventory_consumption` for plates). On-hand value on the Inventory page is `quantity × weighted_average_cost` | `src/modules/reporting/queries/inventory-report.ts`, `menu-report.ts`, `signals-report.ts`, `src/modules/inventory/queries/stock-queries.ts` |
| Supplier invoices (Phase 36) | Record only: never touch the ledger, balances, average cost or supplier cost history; variances against the receipt stored append-only at approval | `src/modules/inventory/services/invoice-service.ts` |
| Sales journal (Phase 28) | Sales, tax, tenders, gift cards; **no cost of goods or inventory lines** | `src/modules/reporting/rules/sales-journal.ts` |

Because every cost report reads the ledger's `total_cost`, a ledger row written at lot cost flows into every report with no report rewritten. The work is in the posting service, the lot sub-ledger and valuation.

Latest migration: `0090`. This phase expects `0091` (generated) and `0092` (custom guards).

## Conflicts with the contract (for the owner's decision)

| # | Contract text | What this phase would need | Decision |
|---|---|---|---|
| C1 | CLAUDE.md "Lots (Phase 23): ... cost stays weighted average"; README section 16 lots paragraph "Cost stays weighted average: a lot's cost is information only"; README section 39 "FIFO costing remains future work" | Lot cost becomes the cost of record for items that opt in. | D1, D2 |
| C2 | CLAUDE.md Inventory "Weighted-average cost"; README section 16 "Use weighted-average costing initially" and the Phase 8 weighted-average policy | Two methods side by side: weighted average stays the default and the only method for items without lots. The Phase 8 rules stay as written for weighted-average items. | D2 |
| C3 | README section 16 "Outgoing movements are valued at the current average"; "Transfers carry the source's average to the destination" | For lot-costed items, outgoing movements are valued at the lots they took, and transfers carry the lots' costs. | D4, D7 |
| C4 | Phase 36 policy 8: invoices change "no ledger, balance, average cost or supplier cost history" | Only if the owner picks D10 option B. The recommendation keeps it. | D10 |

Rule 4 ("historical facts are never recalculated") is **not** loosened by any option here: past ledger rows, plate costs and reports stay as they were posted.

## Decisions for the owner

| ID | Question | Recommendation | Reason |
|---|---|---|---|
| D1 | What does "FIFO" mean here? | **Cost follows the lots actually taken.** Stock already leaves lots first to expire (Phase 23 D9, FEFO, with oldest received as the tie-break) or from a named lot. Each removal is costed at the carrying cost of those lots. There is no separate cost queue apart from the physical lots. Screens and docs call it **"lot costing"**; where expiry follows receipt order (the usual case) it equals FIFO. | One order for stock and cost. A separate FIFO cost queue would disagree with the lot trace whenever FEFO and FIFO differ, and the trace is what a manager checks. |
| D2 | Who opts in (C1, C2)? | **Per inventory item, organization-wide**, as a new `inventory_items.costing_method` (`WEIGHTED_AVERAGE` default, `LOT`). `LOT` needs the item to be lot tracked; turning lot tracking off is refused while the method is `LOT` (`LOT_COSTING_ACTIVE`). Changed under `inventory.configure`, with a reason, audited (`inventory.costing-method-changed`, category INVENTORY). No location-level or organization-level switch. | Lot tracking is already per item and organization-wide; cost per lot can't exist without lots. Items without lots (napkins, ice) keep the average. |
| D3 | What happens to stock on hand when an item switches? | **Value carries over unchanged.** Switching to `LOT`: each open lot's new **carrying cost** is set to the location's current average (so on-hand value doesn't jump); the lot keeps its received cost for information. Switching back: the average becomes on-hand lot value ÷ quantity, rounded half-up to four places. Each switch writes one append-only `inventory_costing_changes` row per location stocking the item (item, location, from, to, quantity, value before, value after, last ledger sequence, user, reason), under each location's balance lock in a stable order. No ledger row is posted. | Revaluing open lots at their receipt costs would change the stock's value with no movement behind it, which the ledger can't record. The carry-over makes the change of method visible without rewriting anything. Lots received after the switch carry their own receipt cost, so the method takes full effect as old stock is used. |
| D4 | How is a decrease costed? | **Allocate lots first, then post.** The posting service works out the lot allocation before inserting the ledger row (the order inside the one transaction changes; the balance and lot locks stay the same). Each lot movement stores its `unit_cost` (the lot's carrying cost) and `total_cost` (extended half-up to four places); the ledger row's `total_cost` is the sum of its movements and `unit_cost` is that total ÷ base quantity (four places, for display). Applies to `CONSUME` (SEND and remakes), `WASTE`, `ADJUST_DECREASE`, `COUNT_DECREASE`, `TRANSFER_OUT`, and the `TRANSFER_SHORTAGE` decrease. | The ledger stays the cost of record; reports need no change. Storing cost on each movement lets the lot trace and audit add up exactly. |
| D5 | How is an increase costed? | **`RECEIVE`:** a new lot at the receipt's base-unit cost (as today). **`SALE_REVERSAL`:** back to the exact lots at the cost they left at, so the reversal's total equals its CONSUME's total. **`ADJUST_INCREASE` / `COUNT_INCREASE`:** a found lot at the item's **current on-hand cost** at that location (open lot value ÷ quantity), or the most recent lot's carrying cost if nothing is on hand, or no cost if the item never had one. **`TRANSFER_IN`:** see D7. | Matches today's rule that found stock comes in at the going cost, without inventing a price. |
| D6 | Negative stock (shortfalls)? | **The shortfall part of a CONSUME is costed at the most recent carrying cost** (the last lot it took from, else the last lot received at that location, else no cost), stored on the shortfall movement. When a new lot settles it, the lot's quantity falls at the lot's cost and the shortfall closes at its posted cost; the **difference is stored on the settling movement** (`cost_difference`) and never posted back to the sale. Inventory report: new section **"Negative stock cost differences"**. | The sale's cost is frozen when sent (rule 4). Recording the gap where it appears keeps the value traceable. The weighted average already treats stock at or below zero specially (Phase 8). |
| D7 | Transfers? | `TRANSFER_OUT` is costed from the lots it took (D4); `unit_cost_sent` stores that total ÷ base quantity for display; a new `value_sent` on the line stores the exact total. `TRANSFER_IN` recreates the lots at the **sender's carrying costs** and enters at exactly the sum, so value in = value out (no rounding gap from `unit_cost × quantity`). A short delivery's `ADJUST_DECREASE` takes from the arrived lots (FEFO) at their costs. Stock the sender didn't hold in lots arrives as a found lot at `unit_cost_sent`. | Value is conserved across the two legs, and the in-transit value is the exact amount sent. |
| D8 | Valuation? | **For `LOT` items, on-hand value = Σ open lots × carrying cost, less open shortfalls at their posted cost.** New `inventory_balances.stock_value` and ledger `stock_value_after` (`NUMERIC(14,4)`, written for `LOT` rows only, so valuation is still reproducible from the ledger alone). `weighted_average_cost` and `average_cost_after` keep being written for `LOT` items as value ÷ quantity, labelled **"average on hand"**, for display only. `WEIGHTED_AVERAGE` items are unchanged (value = quantity × average). The Inventory page shows each item's method and value; Inventory → Lots shows received and carrying cost. Costs still need `inventory.cost.view`. | Two numbers with one meaning per method; nothing about weighted-average items changes. |
| D9 | Reports? | **No report is rewritten**: usage, waste, count variance, menu item cost, menu engineering, item mix and bundle cost already read the ledger's `total_cost`. Added: a "Costing method" column in the inventory usage section with a note when an item's method changed inside the range (from `inventory_costing_changes`); the D6 section; a **"Stock value by lot"** section for `LOT` items at the end of the range; carrying cost in the lot trace. Reports across locations ("All my locations") work per location as today. | Past rows keep the cost they were posted at, so a report spanning the switch shows both methods, each as it happened. |
| D10 | Invoice cost follow-up (C4)? | **Option A, recommended: keep invoices record only.** The cost entered at receiving stays the cost of record for both methods; approved variances stay information. **Option B:** when an approved invoice line's price differs from its receipt line and the item is `LOT`, the **remaining** quantity of the lot that receipt created takes the invoiced cost (new append-only `inventory_lot_cost_corrections`, stock value changes with a new ledger-free value row), and the already-used part is reported as "Invoice variance on used stock" without changing any sale. Weighted-average items would need a zero-quantity cost ledger type, which the direction check forbids, so they stay unchanged under B too. | A changes nothing that's built and keeps "valuation reproducible from the ledger". B corrects only part of the stock, only for `LOT` items, and adds a value change with no movement; it fits better once accounting exports carry inventory value, which they don't today. Receivers can already enter the invoiced cost at receipt. |
| D11 | Permissions and audit? | **No new permission.** `inventory.configure` changes the method; `inventory.cost.view` sees any cost. Audit: `inventory.costing-method-changed` (item, location count, from, to; no values in the audit row beyond method names, values live in `inventory_costing_changes`). | Uses the existing permission split. |
| D12 | Opening balances and history? | **Nothing is backfilled.** Ledger rows and lot movements from before Phase 37 keep their cost and get no movement cost (null). The movement cost columns are required only on movements of `LOT` rows posted after the switch (checked in the guard migration by comparing the ledger row's sequence with the item's switch). | Rule 4. |
| D13 | Demo data? | `db:seed:demo` switches **Mozzarella** to lot costing at MAIN while it isn't yet `LOT`, after receiving two lots at different costs, with a few days of sales across both lots, so the lot trace, plate cost and stock value show the method. Rerun adds nothing. | Lets the owner see it in the pizza demo. |
| D14 | Not built | A per-location or organization-wide switch, pure FIFO apart from lots, LIFO or standard cost, revaluing history, cost-of-goods journal lines, invoice cost correction for weighted-average items, cost layers for items without lots. | Each is its own decision. |

## Approved Phase 37 Policies

Approved by the owner on 2026-11-23: D1–D14 as recommended, contract changes C1–C3; C4 not taken (D10 option A). These are binding.

1. **Meaning (D1).** Cost follows the lots actually taken (first to expire, or a named lot); called "lot costing". No separate FIFO cost queue.
2. **Opt-in (D2, C1, C2).** `inventory_items.costing_method` per item, organization-wide: `WEIGHTED_AVERAGE` (default) or `LOT`, which needs lot tracking; lot tracking can't be turned off while `LOT`. `inventory.configure`, with a reason, audited as `inventory.costing-method-changed`.
3. **Switching (D3).** Value carries over: to `LOT`, open lots take the location's current average as carrying cost (received cost kept); back, the average becomes lot value ÷ quantity. One append-only `inventory_costing_changes` row per location; no ledger row.
4. **Decreases (D4, C3).** Lots are allocated before the ledger row is written; each movement stores its unit and total cost; the ledger total is their sum.
5. **Increases (D5).** Receipts at receipt cost; sale reversals back to the same lots at the same costs; found stock at the current on-hand cost, else the latest lot cost, else none.
6. **Negative stock (D6).** A shortfall is costed at the most recent carrying cost; the settling lot stores the difference (`cost_difference`); never posted back to the sale; reported.
7. **Transfers (D7).** Out at lot cost with exact `value_sent`; in recreates the lots at the sender's carrying costs for exactly that value.
8. **Valuation (D8).** `LOT` items: stock value = open lots × carrying cost less open shortfalls at posted cost (`inventory_balances.stock_value`, ledger `stock_value_after`); average shown as "average on hand". Weighted-average items unchanged.
9. **Reports (D9).** No report rewritten; costing-method column and note, "Negative stock cost differences", "Stock value by lot", carrying cost in the lot trace.
10. **Invoices (D10 A).** Stay record only; no cost change for either method.
11. **Permissions and history (D11, D12).** No new permission; nothing backfilled; past rows keep their cost.
12. **Demo (D13).** Mozzarella at MAIN switched to lot costing with two lots at different costs. Out: D14.

## 1. Objectives

- A manager turns on lot costing for an item that is tracked in lots, and from then on every removal of it is costed from the lots it left.
- A plate's cost at SEND reflects the delivery its ingredients came from, frozen like every other snapshot.
- Stock value for those items is the value of the lots on hand, reproducible from the ledger.
- Items without lots, and items that don't opt in, behave exactly as today.

## 2. Scope Boundary

In: D1–D13 as approved, the migrations, the posting service change, the Inventory and report screens listed, tests and documentation.

Out: everything in D14, D10 option B unless chosen, cloud deployment (on hold), any payment processing.

## 3. Review Existing Foundation Before Changes

- `posting-service.ts`, `lot-posting.ts`, `lot-allocation.ts`, `costing.ts`, and every caller of `postInventoryTransaction` (receiving, waste, adjustments, counts, transfers, order consumption, remakes, sale reversals, lot tracking on/off, lot waste and correction).
- Migration 0059 (lot guards: movements append-only, movements sum to the ledger row) and the ledger append-only trigger.
- `stock-queries.ts` (balances, valuation, ledger listing), `lot-service.ts` (lot list, opening lot), the lot trace service.
- Report sections reading `total_cost`; the transfer report's `unit_cost_sent` value.
- Integration suites `tests/integration/inventory/*` (ledger, lots, transfers, counts, purchasing), the canonical Bacon Cheeseburger and Burger Combo tests, reporting tests reading costs.

## 4. Build Order

1. **Rules (unit-tested first):** lot cost allocation (`costLotAllocation`: per-lot extension, totals, shortfall cost), carry-over on switch (both ways), found-lot cost, settlement difference.
2. **Schema (0091):** `inventory_items.costing_method`; `inventory_lots.carrying_unit_cost`; `inventory_lot_movements.unit_cost`, `total_cost`, `cost_difference`; `inventory_balances.stock_value`; `inventory_transactions.stock_value_after`; `inventory_transfer_lines.value_sent`; `inventory_costing_changes`.
3. **Guards (0092):** `inventory_costing_changes` append-only; `LOT` requires lot tracking (and the reverse refusal); movement cost present on `LOT` rows after the switch; a ledger row's `total_cost` equals the sum of its movements' costs for `LOT` rows (deferred, beside the existing quantity check).
4. **Posting service:** allocate before insert for `LOT` items; costs per D4–D7; stock value per D8. `WEIGHTED_AVERAGE` path unchanged and covered by the existing tests.
5. **Switching:** service + API under Inventory item settings, with the D3 carry-over per location.
6. **Transfers:** `value_sent`, exact transfer-in value.
7. **Screens:** costing method on the item page, method and value on the Inventory page, received and carrying cost on Lots and the lot trace.
8. **Reports:** D9 additions.
9. Demo data (D13), documentation, full validation, completion report.

## 5. Unit Tests

- Allocation costing across one, two and three lots; a named lot; rounding (per-movement half-up, totals exact).
- Shortfall cost from the last lot taken, the last lot received, or none; settlement difference sign both ways.
- Carry-over to `LOT` (value unchanged) and back (average = value ÷ quantity, half-up).
- Found-lot cost from on-hand cost, last lot, or none.

## 6. Integration Tests

- **Switch:** refused without lot tracking; turning tracking off refused while `LOT`; carry-over per location with an `inventory_costing_changes` row and audit; concurrent posting during a switch serializes on the balance lock.
- **SEND across lots:** a `LOT` beef with two lots at different costs; a burger whose consumption spans both lots posts the exact sum; the consumption snapshot and menu item cost report show it; an idempotent retry adds no ledger row, movement or cost.
- **Void unprepared:** the reversal returns the same lots at the same costs; totals equal.
- **Waste, adjustments, counts:** decreases at lot cost; increases as found lots at on-hand cost.
- **Negative stock:** shortfall costed per D6; the next receipt settles it and stores the difference; the report section shows it.
- **Transfers:** value out = value in exactly; short delivery; sender with no lots.
- **Valuation:** `stock_value` equals Σ lots less open shortfalls after every kind of posting; `stock_value_after` reproduces it from the ledger.
- **Unchanged:** every existing inventory, order, kitchen, transfer, count and report test passes for `WEIGHTED_AVERAGE` items; the canonical Bacon Cheeseburger and Burger Combo tests pass unchanged.
- Migration reconstruction and the upgrade test over a database with Phase 36 data (lots with information-only costs).

## 7. E2E Tests (Playwright)

- `lot-costing.spec.ts`: a manager turns on lot costing for a lot-tracked item; receives two lots at different costs; sends an order; the lot trace and the Inventory page show the costs and value.
- Existing specs pass unchanged in CI mode.

## 8. Documentation

- README: section 16 (lots paragraph, costing paragraph, the Phase 8 weighted-average note gains "for weighted-average items"), section 21 (new report sections), section 36 (Phase 37 entry), section 39 (FIFO costing built as lot costing), per the C1–C3 wording.
- CLAUDE.md: the Lots and Inventory lines, a short Phase 37 policy line, Phase 37 in the phase list.
- `docs/Demo-Data.md` (D13). `docs/User-Guide.md` is a historical reference and is not changed.
- `docs/Phase-37-Completion-Report.md`.

## 9. Validation Checklist

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test:unit`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e` in CI mode (run `npm run build` first; stop `npm run dev`)
- [ ] `npm run build` with no new warnings
- [ ] `npm audit --omit=dev` clean (no dependency change expected)
- [ ] Migrations 0091–0092 reviewed; `npm run db:generate` then reports no changes; migration reconstruction and upgrade tests pass
- [ ] `npm run db:seed` twice creates no duplicates (permission count unchanged); `db:seed:demo` and `db:seed:validation` twice create no duplicates
- [ ] `npm run db:reset` safeguards still refuse a non-dev, non-loopback or wrongly named database
- [ ] Canonical Bacon Cheeseburger and Burger Combo, including idempotent retries, pass unchanged
- [ ] No past ledger row, movement or plate cost changes when an item switches method

## 10. Risks

- **The ledger is the most tested part of the system.** The posting service's order changes for `LOT` items only; the weighted-average path must stay byte-for-byte the same, proven by the existing suites.
- **Two methods side by side.** A report spanning a switch mixes methods; the "Costing method" column and note make it visible.
- **Negative stock** leaves cost differences that land on the receipt that settles them, not on the sale (D6).
- **Rounding:** per-movement half-up costing can differ by fractions of a cent from a single extension; totals are always the exact sum of the stored movement costs.
- **Lock order:** allocating before the insert keeps the same locks (balance, then lots by sequence); a switch takes balance locks across locations in a stable order.
- **Invoices stay record only** (D10 A): a receiver who enters the PO price instead of the invoiced price leaves the lot at that cost.

## 11. Required Phase 37 Completion Report

Write `docs/Phase-37-Completion-Report.md`:

```text
PHASE 37 COMPLETION REPORT

Summary

Environment
- Node / npm / Next.js / PostgreSQL

Policies (as built)
- Costing method per item and switching (carry-over, record, audit):
- Decreases, increases, reversals and transfers under lot costing:
- Negative stock and cost differences:
- Valuation (stock value, average on hand):
- Reports:
- Invoice cost follow-up:

Results
- Removals of LOT items cost exactly the sum of the lots taken: PASS / FAIL
- Stock value equals open lots less open shortfalls and is reproducible from the ledger: PASS / FAIL
- Switching method changes no past ledger row, movement or plate cost, and no on-hand value: PASS / FAIL
- Transfer value in equals value out: PASS / FAIL
- WEIGHTED_AVERAGE items behave exactly as before: PASS / FAIL
- Canonical Bacon Cheeseburger and Burger Combo with idempotent retries unchanged: PASS / FAIL

Architectural decisions
Migrations
Validation results (lint, typecheck, unit, integration, e2e CI, build, audit)
Tests executed (counts)
Files changed
Risks
Remaining issues
Next-phase readiness
```
