# Phase 8 Completion Report

This report merges the plan §83 template with the sections required by CLAUDE.md. Results are from this repository on 2026-11-08.

## Summary

Phase 8 is implemented and validated locally. An authorized manager can configure inventory items with packaging conversions and per-location stock levels, set up suppliers and supplier items, draft and submit a purchase order (which moves no stock), receive it in full or in part (which posts `RECEIVE` ledger rows and updates weighted-average cost), record waste and adjustments, transfer stock between Locations, run a physical count with variance posting, and see low stock with every supplier option. Recipe revisions now list Inventory Item ingredients, and modifiers carry ADD/REMOVE/ADJUST inventory effects per Menu Item. Saving any of that configuration moves no stock. No Orders, Kitchen or Settlement code exists.

**Not yet confirmed:**

- **`db:reset` on your real development database** was deliberately not run, because it would delete your Owner account. The same command was proven on a throwaway PostgreSQL container.

**Please review these decisions** (the first four were your answers before coding; the rest were in the approved plan):

1. Plan model plus an append-only `supplier_item_cost_history`. No storage locations, inventory categories or `waste_records`.
2. Modifier effects follow plan §14 (REMOVE has no quantity; ADJUST is signed), replacing the Phase 7 contract.
3. A separate `inventory.count.approve`.
4. Grants: Owner, General Manager, Manager and Inventory Manager hold every new code; a Cook gets `inventory.view` and `inventory.waste`.
5. The plan's transaction types and table names, not README §16's; README updated.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Exact quantity/cost arithmetic | In-repo `BigInt` helpers (`src/shared/decimal/`), now with `divideRoundHalfUp`, `subtractDecimals`, `negateDecimal`, `multiplyExact`. No dependency added |

## Policies

The six "Approved Phase 8 Business Policies" were treated as binding. README §33 ("Phase 8 Inventory and Purchasing") records every policy as built.

| Approved policy | As implemented |
|---|---|
| Negative inventory | `location_settings.allow_negative_inventory` defaults to `false`. When false, nothing may leave QOH below zero. When true, only `CONSUME` may; `WASTE`, `ADJUST_DECREASE`, `COUNT_DECREASE` and `TRANSFER_OUT` never may. Increases always allowed. Nothing clamps |
| Costing while negative | From QOH at or below zero, a receipt that leaves QOH at or below zero keeps the average; one that lifts it above zero sets the average to that receipt's base-unit cost. The ordinary formula is never used with a zero or negative denominator |
| Weighted-average rounding | Exact `BigInt` arithmetic, ROUND_HALF_UP to four places after each receipt, persisted `NUMERIC(14,4)`, and that persisted value is the next basis |
| Count activity | Lines snapshot expected QOH and the ledger sequence together. Stock isn't frozen. Variance = counted − expected. Later ledger activity requires acknowledgement, whose actor and time are stored. Variances post against current QOH. Approval is atomic |
| Over-receiving | Refused per line, cumulative, with no override |
| Supplier preference | No preferred-supplier field anywhere (a test checks the columns). Purchase orders name their supplier explicitly. Low stock lists every active supplier option |

### Applied beyond the plan text

| Topic | Applied |
|---|---|
| Receipt cost | The receipt enters weighted-average costing as its exact total cost, so a base-unit cost needing more than four places (a $27.99 case of 12,000 mL) isn't rounded twice |
| Stock with no cost basis | Stock that arrived without a cost (an adjustment before any receipt) takes the next receipt's cost as its first average |
| Outgoing valuation | Waste, consumption, decreases and transfers out are valued at the current average and don't change it. Transfers carry the source average to the destination |
| Stock unit | Can't change once an item has ledger history |
| PO lifecycle | Cancel from DRAFT, SUBMITTED or PARTIALLY_RECEIVED; received stock stays. Only drafts are edited; draft lines may be removed |
| Count lifecycle | SUBMITTED → DRAFT ("return for correction") added. A decrease that would take current stock below zero refuses the whole approval |
| Modifier effects | The modifier must be offered on the Menu Item. REMOVE/ADJUST must name an ingredient of the recipe revision in effect when saved. `applyModifierEffects` is the pure Phase 9 rule: REMOVE drops (no-op if absent) and wins over ADJUST; a requirement adjusted to zero or below is dropped |
| Recipe ingredients | A draft may copy another revision's ingredients. Each ingredient change checks and bumps the revision's version |

## Architectural decisions

- **One posting service.** `postInventoryTransaction` is the only writer of `inventory_transactions` and `inventory_balances`; a test scans the module to prove it. Receiving, waste, adjustments, transfers, count approval and `postConsumption` (Phase 9) all call it inside their own transaction.
- **Balance lock serializes postings.** Each posting locks (or creates) the item's balance row. Transfers and count approval lock several in a stable order. A test of 20 simultaneous postings shows exact running balances and no lost update.
- **Append-only history in the database.** Triggers refuse UPDATE and DELETE on the ledger, receipts, receipt lines and supplier cost history. A trigger refuses changes to a published recipe revision's ingredients.
- **Reproducible valuation.** Every ledger row stores the entered quantity and unit, the base delta, unit and total cost, and `quantity_after` and `average_cost_after`. `reconcileBalances` compares the projection with ledger sums; `ledgerQuantityOnHand` recomputes QOH as of an instant or a business date.
- **Deterministic conversion.** At most one active outgoing packaging conversion per unit (a partial unique index), and cycles refused on save, so the path to the base unit is unique.
- **History snapshots.** Purchase order lines snapshot supplier item, unit, conversion and price. Receipt lines keep the actual cost beside the ordered price.
- **A read door into Inventory.** Recipes and Menu use only `src/modules/inventory/queries/item-facts.ts` (identity, convertibility, picker lists). Inventory imports neither. Tests check both directions.
- **Cost visibility** is decided in the services and queries, not the UI: cost fields are null without `inventory.cost.view`.

### Architecture deviations

| Deviation | Reason |
|---|---|
| README §15/§16 table names and transaction types replaced by the plan's | Your decision; README rewritten |
| Phase 7 modifier-effect contract changed | Your decision (plan §14 semantics) |
| `supplier_item_cost_history` added beyond the plan | Your decision; satisfies README/CLAUDE.md "keep supplier cost history" |
| `units_per_purchase` from plan §26 not built | Ambiguous next to `base_units_per_purchase`, which is computed from the item's conversions |
| Packaging units seeded as `COUNT` units | Needed for CASE/BOTTLE packaging; their meaning is per item |
| Many foreign key names set explicitly | The generated names reached 63+ characters; the schema was changed and the migration regenerated, not hand-edited |
| One integration test given a 30-second timeout | The full-rebuild test builds the schema twice and now takes just over 5 seconds |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0011_inventory_purchasing.sql` | Generated. 16 tables, `location_settings.allow_negative_inventory`, composite same-organization foreign keys (all `RESTRICT`), check constraints for signs, statuses, reasons and effect shapes |
| `0012_inventory_constraints.sql` | Custom. Append-only triggers on the ledger, receipts, receipt lines and cost history; the recipe-ingredient freeze trigger |

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 7 database to Phase 8 | PASS: your development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user. An automated test also upgrades Phase 5, 6 and 7 databases in place |
| Empty DB reconstruction | PASS: automated test, plus `db:reset` on a new PostgreSQL 17 container |
| Unexplained schema drift | NONE: a further `db:generate` reports "No schema changes" |

**What changed in your development database:** permissions 93 → 102, role grants 317 → 355, units 8 → 15, plus 6 demo inventory items stocked at MAIN with their conversions and levels, and 1 demo supplier with 6 supplier items. No ledger rows, balances or orders.

## Validation results

### Inventory schema

| Table | Result |
|---|---|
| inventory_items | PASS |
| inventory_item_locations | PASS |
| inventory_item_unit_conversions | PASS |
| recipe_version_ingredients | PASS |
| modifier_inventory_effects | PASS |
| inventory_transactions | PASS |
| inventory_balances | PASS |
| suppliers | PASS |
| supplier_items | PASS |
| supplier_item_cost_history | PASS (added by your decision) |
| purchase_orders | PASS |
| purchase_order_lines | PASS |
| purchase_order_receipts | PASS |
| purchase_order_receipt_lines | PASS |
| inventory_counts | PASS |
| inventory_count_lines | PASS |

### Recipe/Modifier integration

| Check | Result |
|---|---|
| Recipe Version -> Inventory Item | PASS |
| Published Recipe immutability | PASS: service, and the trigger refuses update and delete |
| Exact ingredient quantities | PASS |
| UOM compatibility | PASS: an unconvertible unit is refused, in service and E2E |
| Modifier ADD | PASS |
| Modifier REMOVE | PASS |
| Modifier ADJUST | PASS: positive and negative |
| Configuration creates no stock movement | PASS: tests assert no ledger rows and no balances |

### Ledger

| Check | Result |
|---|---|
| Append-oriented ledger | PASS |
| Base quantity conversion | PASS: 1 CASE → 12,000 mL; 1 LB → 16 OZ_WEIGHT |
| QOH calculation | PASS |
| Balance projection | PASS |
| Ledger/balance reconciliation | PASS |
| Concurrent posting safety | PASS: 20 simultaneous postings |
| Negative stock policy | PASS (see Policies) |
| `allow_negative_inventory` defaults false | PASS |
| Only opted-in `CONSUME` may go negative | PASS |
| `WASTE`/`ADJUST_DECREASE`/`COUNT_DECREASE` cannot go negative | PASS |
| BusinessDateService usage | PASS: 03:30 local before the 4:00 cutoff books to the previous day |

### Costing

| Check | Result |
|---|---|
| Weighted-average policy | PASS: 10 @ 2.0000 + 10 @ 3.0000 → 2.5000 |
| `ROUND_HALF_UP` to persisted `NUMERIC(14,4)` after each receipt | PASS: boundary and next-basis cases |
| Exact `NUMERIC(14,4)` cost | PASS |
| Zero-balance receipt | PASS |
| Multiple receipts | PASS |
| Negative-balance costing policy | PASS: kept while ≤ 0; reset to receipt cost when crossing above zero |
| Cost visibility authorization | PASS: service, query and E2E |

### Purchasing

| Check | Result |
|---|---|
| Supplier configuration | PASS |
| Supplier Item conversion | PASS: base units computed; unconvertible refused |
| Draft PO | PASS |
| Submit PO | PASS |
| PO submit changes no stock | PASS: integration and E2E |
| Partial receipt | PASS |
| Full receipt | PASS |
| Over-receipt policy | PASS: refused, cumulative per line |
| Over-receipt manager override absent | PASS: no override exists in code or schema |
| Preferred Supplier field/implicit selection absent | PASS |
| Actual receipt cost preserved | PASS: ordered price unchanged; actual on the receipt line and in cost history |
| Receiving ledger/cost atomicity | PASS: a bad line rolls back the whole receipt |

### Inventory operations

| Check | Result |
|---|---|
| Paired TRANSFER_OUT/TRANSFER_IN | PASS: one shared reference |
| Transfer same-organization/location authorization | PASS: `inventory.transfer` checked at both locations |
| Transfer source/destination reconciliation | PASS: totals unchanged, cost carried |
| Waste | PASS |
| Manual increase/decrease | PASS |
| Reason/provenance | PASS: reason required in service and by a check constraint; actor recorded |
| Inventory count lifecycle | PASS |
| Expected snapshot | PASS |
| Post-snapshot activity policy | PASS |
| Acknowledgement actor/timestamp stored when activity exists | PASS |
| Count variance posts against current QOH, not direct-set count | PASS: counted 9 vs expected 10 after +3 arrived → 12, not 9 |
| Count approval | PASS: can't approve twice, stale version refused |
| Variance ledger posting | PASS |

### Replenishment

| Check | Result |
|---|---|
| Par level | PASS |
| Reorder level | PASS |
| Reorder target | PASS |
| Low stock query | PASS: above excluded, equal included, below included |
| Suggested reorder | PASS: exact; negative QOH shown as it is |
| No automatic PO submission | PASS |

### Authorization

| Check | Result |
|---|---|
| inventory.view | PASS |
| inventory.receive | PASS |
| inventory.adjust | PASS |
| inventory.count | PASS |
| inventory.count.approve | PASS: a counter can't approve |
| inventory.waste | PASS: a Cook can waste but not adjust |
| Cost access | PASS |
| Purchasing permissions | PASS: drafting separate from submitting |
| Direct unauthorized API denied | PASS: E2E, 401 signed out, 403 for Server and Cook |

### Seeds

| Check | Result |
|---|---|
| Phase 7 to 8 permission upgrade | PASS: adds the nine codes and the Cook's `inventory.view`; restores no grant an administrator removed |
| Seed idempotency | PASS: `15 applied`, then `0 applied, 15 already applied`, with identical counts |
| No seeded stock | PASS: tests assert zero ledger rows, balances and orders |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation | PASS |
| Phase 2 Auth/RBAC | PASS |
| Phase 3 Employees/HR | PASS |
| Phase 4 Scheduling | PASS |
| Phase 5 Restaurant/Seating | PASS |
| Phase 6 Reservations/Waitlist | PASS |
| Phase 7 Menu/Recipes | PASS (two Phase 7 boundary tests updated: they asserted no inventory tables existed) |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: through the E2E suite |

Real `npm run db:reset` refusals on the throwaway container, with a probe row intact afterward: `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, database `restaurant_ops_test`, a fake RDS host, and `?host=` on a local URL. The reset then seed reproduced 102 permissions, 355 role grants, 6 items, 6 supplier items, 15 units, 0 ledger rows.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | Not re-run; no dependency changed |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 531 of 531 (baseline 494) |
| Integration tests | PASS: 868 of 868 (baseline 792) |
| E2E tests | PASS: 98 of 98 (baseline 90) on a clean full run, after one earlier run of 97 of 98 (see below) |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged (DEV-002) |
| GitHub Actions | PASS: reported by the project owner after the work was pushed; I did not see the run |

### Problems found during validation

- **I broke one E2E run myself.** While it was running, I re-ran two integration files, which recreate the shared test database. E2E tests then failed with missing tables. Later in that run the machine ran out of memory and the run was stopped. Those results were discarded; the suite was re-run alone.
- **One real E2E failure, mine.** The Phase 7 recipe spec checked for a sentence ("Ingredients … are added when Inventory …") I deliberately rewrote. The assertion now checks the new text, and the full suite then passed 98 of 98.
- **Two of my E2E tests had timing bugs.** One clicked Submit before the page refreshed with a new line, so the stale version was correctly refused. Another read the URL before navigation finished. Both fixed.
- **A fixture used two different users** where a transfer needs one user at both locations; the service was right to refuse.
- **Generated foreign key names were too long.** Fixed in the schema, then regenerated.

## Tests executed

- **Unit (new, 37 more than baseline):** exact division and rounding; unit resolution, packaging paths, cycles and ambiguity; weighted-average cost including rounding boundaries, persisted basis and both negative-balance cases; stock policy for every type; PO totals, remaining quantities, over-receipt and transitions; count variance, posting type and approvability; replenishment and threshold validation; the rewritten modifier-effect contract and `applyModifierEffects`.
- **Integration (new, 76 more than baseline):**
  - `inventory/ledger`: every type's sign and exact balance, packaging conversion, missing conversion, append-only triggers, refused posting writes nothing, concurrency, item/location integrity, business date, negative policy, weighted average, cost visibility, stock-unit lock, threshold and stale-edit checks.
  - `inventory/purchasing`: supplier items, cost history, no preferred supplier, PO lifecycle and numbering, snapshots, receiving partial and full, actual cost, over-receipt, atomicity, cancellation, authorization, low-stock options.
  - `inventory/operations`: waste, adjustments, transfers, low stock.
  - `inventory/counts`: snapshot, variance posting, double approval, stale version, activity acknowledgement, negative refusal, cancellation, separation of duties.
  - `inventory/authorization`: role matrix, module boundaries, single writer, permission checks.
  - `recipes/recipe-inventory`: ingredients and modifier effects, including immutability, copy, discard and no stock movement.
- **Integration (updated):** migrations (16 tables, Phase 7 upgrade), foundation seeds (Phase 7 upgrade, demo catalog, units), seed registry, Phase 7 boundary and table-list tests.
- **E2E (`inventory.spec.ts`, 8):** PO submit changes no stock, partial then full receipt with exact quantities and cost, over-receipt refused, waste with ledger row, Cook and Server authorization, cost hidden from a viewer, signed-out refused, count with variance posting, recipe ingredients on a draft then read-only after publishing with no stock change.

**Partly covered:**

- Transfers, item configuration, supplier management and the low-stock page are covered by integration tests, not E2E.
- A fault injected partway through a receipt isn't tested; atomicity is shown by a refused second line.
- Phone-width layout of the new pages was not tested.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/inventory.ts`, `src/db/schema/inventory-links.ts`, `drizzle/migrations/0011_inventory_purchasing.sql`, `0012_inventory_constraints.sql` and snapshots
- Seed: `src/db/seeds/inventory-foundation.ts`
- Inventory module: `src/modules/inventory/` (`rules`, `services`, `queries`, `repositories`, `validators`, `types.ts`)
- Recipes: `src/modules/recipes/services/ingredient-service.ts`
- Menu: `src/modules/menu/services/modifier-effect-service.ts`
- API: 35 Route Handlers under `src/app/api/inventory/`, `purchasing/`, `suppliers/`, `supplier-items/`, plus recipe-ingredient and modifier-effect routes
- UI: `src/app/(app)/inventory/` (on hand, low stock, transactions, movements, items, counts), `src/app/(app)/purchasing/` (orders, suppliers), `src/components/inventory/`
- Tests: `tests/integration/inventory/`, `tests/integration/recipes/recipe-inventory.test.ts`, `tests/e2e/inventory.spec.ts`, `tests/fixtures/inventory-fixtures.ts`, `tests/helpers/e2e-inventory.ts`, `src/modules/inventory/rules/inventory-rules.test.ts`
- Docs: this report

**Modified**

- Schema: `src/db/schema/index.ts`, `organization.ts`, `drizzle/migrations/meta/_journal.json`
- Decimal: `src/shared/decimal/decimal.ts` and its test
- Auth: `permission-catalog.ts` (102 codes), `role-catalog.ts`
- Seeds: `registry.ts`
- Recipes: `recipe-service.ts` (ingredients in detail, draft discard), `modifier-recipe-effects.ts` and its test, `recipe-validators.ts`
- Menu: `menu-validators.ts`
- UI: recipe detail page (ingredients), modifiers page (effects), `navigation.ts`
- Tests: `navigation.test.ts`, `auth.test.ts`, `tests/e2e/auth.spec.ts`, `tests/e2e/recipes.spec.ts`, database seed and migration tests, `tests/integration/menu/authorization.test.ts`, `menu-config.test.ts`, `recipes/recipes.test.ts`
- Docs: `README.md` §15, §16, §33 (Phase 7 extension note and Phase 8 policies), §36; `docs/Phase-7-Completion-Report.md` (GitHub Actions line, from the previous session)

## Risks

- **Every posting for one item and location serializes on one row.** Correct and fine for one restaurant; very busy items under Phase 9 order load should be measured.
- **The E2E cleanup disables append-only triggers** inside its own transaction to remove test history. It touches only the test database, but it takes table locks briefly.
- **Entered times use the browser's local time; displays use UTC dates.** The same caveat as Phase 7.
- **REMOVE/ADJUST effects are validated against the recipe in effect when saved.** A later revision can drop the ingredient; Phase 9 then treats the effect as a no-op, by the documented rule.
- **No audit trail beyond provenance columns** (who posted, received, approved, acknowledged). The audit-domain decision is still open.
- **Memory:** the full E2E suite was stopped twice by low memory on this machine before running cleanly. Close other heavy apps before running it.
- **`btree_gist` on RDS** remains untested (Phases 3, 5–7); Phase 8 adds no exclusion constraint.

## Remaining issues

None block Phase 9.

1. **Where does the audit domain get built? Still your decision,** carried from Phase 3. Inventory adjustments and count approvals add to the list.
2. **No UI to cancel a scheduled supplier price or to edit a received receipt.** Corrections are compensating adjustments, by design.
3. **Carried over:** the Phase 6 held-table move gap, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json`, and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted risks

DEV-001, DEV-002 and DEV-003: unchanged. No dependencies were added.

## Business domains created beyond Phase 8

NONE. Tests assert there are no order, ticket, settlement or fulfillment tables. `postConsumption` exists for Phase 9 and is exercised only by service-level fixtures.

## Next-phase readiness

**Phase 9 readiness: READY,** subject to review of this report. Order SEND will call `resolveEffectiveRevisionForMenuItem`, `resolveRevisionRequirements`, `applyModifierEffects` and `postConsumption` inside its transaction, with its own reference for idempotency.
