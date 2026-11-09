# Phase 9 Completion Report

This report merges the plan §100 template with the sections required by CLAUDE.md. Results are from this repository on 2026-11-09.

## Summary

Phase 9 is implemented and validated locally. A server can open a dine-in order from a seated party on the floor, a bar order for a party at the bar, or a takeout order with no table. They add menu items with modifiers, which the shared Phase 7 validator checks on the server, and send the unsent items. SEND is one transaction: it re-resolves price, modifiers and the recipe revision, freezes the snapshots, computes consumption once, posts CONSUME through the Phase 8 posting service, and records a numbered send batch. A retry with the same idempotency key changes nothing. Items can be sent in further rounds. A manager can void a sent item as not prepared (stock comes back through a linked `SALE_REVERSAL`) or as prepared or discarded (stock stays used), void a whole order, and apply configured fixed or percentage item and order discounts. A table session can't end while any of its orders is OPEN. No ticket, settlement, payment, tax or close exists.

**Please review these decisions** (the first seven were your answers before coding; the rest were defaults in the approved plan):

1. `BAR` orders, per README §17, need a session in a BAR area. `DINE_IN` needs a DINING area and `TAKEOUT` has no session.
2. README names: `order_send_batches` plus a generic `idempotency_records` table. The plan's template row "order_submissions" is reported as `order_send_batches` below.
3. Outbox and audit are both deferred. Phase 9 emits no realtime event.
4. A discount's applied amount is a projection, recomputed whenever sent items or discounts change. Configured values are immutable snapshots.
5. Discounts come from definitions only.
6. Server and Bartender get view, create, edit and submit. Void and discounts are manager-only.
7. `SALE_REVERSAL` enters at the original CONSUME row's cost.
8. Draft removal deletes the draft row. Item status history starts at SUBMITTED.
9. Cancelling a session is refused while an OPEN order references it, as completion is.
10. Takeout has an optional pickup label and no Guest Party.

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Exact money/quantity arithmetic | The in-repo `BigInt` helpers in `src/shared/decimal/`, reused unchanged. Money is `NUMERIC(12,2)` and quantities `NUMERIC(14,4)`, always as decimal strings. No dependency added |

## Policies

The plan has no single "Approved Policies" heading. The approved policies stated in §11, §21, §23, §27, §36–§37, §42, §46 and §68, and in the definition of done, were treated as binding, together with your answers above. README §33 "Phase 9 Orders" records every policy as built.

| Approved policy | As implemented |
|---|---|
| Order lifecycle `OPEN -> CLOSED (Phase 11) / VOIDED` | Check constraint plus services. No close command or endpoint exists |
| Item lifecycle `DRAFT -> SUBMITTED -> VOIDED` | Check constraint, services, and a freeze trigger on sent items |
| Incremental send rounds | Each SEND takes every current DRAFT item into batch N+1. Sent items are never resubmitted |
| Price at SEND | Drafts hold a preview. SEND re-resolves through the operational menu, then the snapshot is frozen |
| Recipe revision at SEND | `resolveEffectiveRevisionForMenuItem` at the send instant, stored on the item and on each consumption row |
| Modifier effect snapshot (§68) | `order_item_inventory_consumption.source_snapshot` keeps the per-unit recipe requirement and the base-unit effects applied |
| Discounts | Item first, then order; ROUND_HALF_UP to cents; capped; 100% is a comp; no tax |
| Voids | Reason and disposition required. UNPREPARED posts SALE_REVERSAL; PREPARED_OR_DISCARDED keeps consumption and posts no WASTE |
| Session completion | Blocked by any OPEN order. Phase 9 never closes an order to unblock it |
| Trusted consume-only capability | `postOrderConsumption` and `postSaleReversal`. No Inventory permission is granted to floor roles |

### Applied beyond the plan text

| Topic | Applied |
|---|---|
| ADJUST below zero (§32) | The plan says to follow the shared validation. The shared Phase 8 rule `applyModifierEffects` drops a requirement adjusted to zero or below, so nothing is ever consumed negatively; SEND doesn't reject it. The README Phase 8 policy states this rule |
| Shortages | Collected for every Inventory Item in the batch (aggregated across items) before anything posts |
| Session end guard | A database trigger on `table_sessions` refuses COMPLETED/CANCELLED while an OPEN order exists, so the stand-alone Restaurant service can't bypass the workflow |
| Error details | `AppError` gained an optional `details`, so the error shape is `{ error: { code, message, requestId, details? } }`. Only shortages use it |
| Idempotency key binding | The actor is part of the fingerprint, so another user can't replay someone's key |
| Order numbers | Per Location and business date, with `#N` display |

## Architectural decisions

- **One SEND transaction** (`src/workflows/submit-order/submit-order.ts`). Everything is resolved before anything is written, then the batch, snapshots, postings, consumption rows, totals, history and idempotent result are written. Any failure, including a shortage, rolls everything back, including the idempotency claim.
- **Idempotency in the same transaction** (`src/infrastructure/idempotency/`). `INSERT ... ON CONFLICT DO NOTHING` claims the key. A concurrent duplicate blocks on the unique key until the first commits (then replays) or rolls back (then runs).
- **Three layers against double consumption.** The order row lock plus version check; the item's DRAFT → SUBMITTED transition with its batch link (a constraint and a trigger); and a partial unique index on the ledger, one CONSUME per (Order Item, Inventory Item).
- **Orders read Menu, Recipes and Inventory only through their published doors:** `getOperationalMenu`, `resolveSellableItem` and `loadModifierEffectsForItem` (new, `src/modules/menu/queries/order-menu-facts.ts`), the shared selection validator, `resolveEffectiveRevisionForMenuItem`, `resolveRevisionRequirements` and `applyModifierEffects`. The Inventory capabilities live in `src/modules/inventory/services/order-consumption.ts`, and the session facts in `src/modules/restaurant/queries/session-facts.ts`. A test scans the orders module and workflows for direct inventory, price, recipe-ingredient or table access.
- **Lock order.** Order row, then its items, then inventory balances in Inventory Item ID order. Order creation takes the session FOR SHARE; completion and cancellation take it FOR UPDATE.
- **Totals are a stored projection** with a check constraint (`subtotal = item_subtotal - discount_total`, discounts ≤ items). It is recomputed from SUBMITTED snapshots and APPLIED discount snapshots on every change.
- **Phase 10 contract.** Each sent item carries its batch, `kitchen_instructions_snapshot` (modifier preparation instructions, then free text), `prep_station_ids_snapshot`, modifier snapshots and recipe revision. `order_item_inventory_consumption` is the immutable consumption snapshot a Phase 10 remake will need.
- **Phase 11 extension point.** `orders.subtotal` is the post-discount, pre-tax amount to settle. `CLOSED` and `closed_at` exist with constraints but nothing sets them. `orders.close` is unused. A session end waits on OPEN orders.

### Architecture deviations

| Deviation | Reason |
|---|---|
| Outbox not built, although README §24 lists outbox writes in SEND | Your decision: there is no consumer, Phase 9 emits no realtime event, and the Phase 10 plan says no outbox. Needs an explicit decision before Phase 10 (see Remaining issues) |
| Audit events not written, although README §24 lists them | Your decision; the audit domain is still undecided (carried since Phase 3) |
| README §24's "create kitchen/bar tickets" step absent | Phase 10 |
| `order_send_batches` in place of the plan's `order_submissions` | Your decision (README name) |
| `BAR` order type beyond the plan's minimum | README §17; your decision |
| `idempotency_records` added | README §23; your decision |
| Error shape gains optional `details` | Plan §35 requires structured shortage details |
| Trigger on the Phase 5 `table_sessions` table | Makes the open-order block impossible to bypass |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Migration | Contents |
|---|---|
| `0013_orders.sql` | Generated. 12 tables (`idempotency_records`, `order_number_counters`, `orders`, `order_status_history`, `order_send_batches`, `order_items`, `order_item_modifiers`, `order_item_status_history`, `order_item_inventory_consumption`, `order_item_voids`, `discount_definitions`, `order_discounts`, `order_item_discounts`). Composite same-location foreign keys to `table_sessions` and `guest_parties` (no FK to `restaurant_tables`). Check constraints for types, statuses, totals, void/send fields and discount values. On `inventory_transactions`: `SALE_REVERSAL`, `reverses_transaction_id` (self-FK, unique, required for SALE_REVERSAL), and the one-CONSUME-per-order-item partial unique index |
| `0014_orders_constraints.sql` | Custom. Append-only triggers on order and item status history, send batches, consumption snapshots and voids. The sent-item freeze trigger, the modifier freeze trigger, and the open-order guard on `table_sessions` |

Generated foreign key names over 63 characters were found in review, named explicitly in the schema, and the migration regenerated (never hand-edited).

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS |
| Existing Phase 8 DB → Phase 9 | PASS: your development database upgraded with `db:migrate` and `db:seed`, keeping its 1 user. A new automated test also upgrades a Phase 8 database in place |
| Empty DB reconstruction | PASS: automated test, plus `db:reset` on a new PostgreSQL 17 container (15 migrations applied) |
| Unexplained schema drift | NONE: a further `db:generate` reports "No schema changes" |

**What changed in your development database:** permissions 102 → 106, role grants 355 → 371. No orders, discounts or idempotency records.

## Validation results

### Order schema

| Table | Result |
|---|---|
| orders | PASS |
| order_items | PASS |
| order_item_modifiers | PASS |
| order_status_history | PASS |
| order_item_status_history | PASS |
| order_submissions (built as `order_send_batches`) | PASS |
| order_number_counters | PASS |
| discount_definitions | PASS |
| order_discounts | PASS |
| order_item_discounts | PASS |
| order_item_voids | PASS |
| order_item_inventory_consumption | PASS |
| idempotency_records (README §23) | PASS |

### Order model

| Check | Result |
|---|---|
| DINE_IN → Table Session | PASS |
| BAR → Bar-area Table Session | PASS |
| TAKEOUT without Table Session | PASS: no session or table rows created (integration and E2E) |
| No physical-table FK | PASS |
| Multiple Orders/Table Session | PASS |
| BusinessDateService | PASS |
| Approved Order lifecycle: OPEN / CLOSED (Phase 11 only) / VOIDED | PASS |
| Approved Item lifecycle: DRAFT / SUBMITTED / VOIDED | PASS |
| No settlement-free Order close in Phase 9 | PASS |

### Snapshots and pricing

| Check | Result |
|---|---|
| Menu Item identity snapshot | PASS |
| Menu Item name/code snapshot | PASS |
| Base price snapshot | PASS |
| Modifier snapshots | PASS |
| Exact unit/line totals | PASS |
| Order subtotal | PASS: recomputed from snapshots in tests |
| Current Menu changes do not alter history | PASS: rename, reprice and modifier change after SEND |
| Draft price is preview-only | PASS |
| Price re-resolved and snapshotted at submission | PASS: a price change during draft is picked up |
| Submitted price remains immutable | PASS: service and database trigger |
| Price snapshot timing policy | submission-time / PASS |

### Discounts and tax

| Check | Result |
|---|---|
| ITEM / ORDER scopes | PASS |
| FIXED_AMOUNT / PERCENTAGE types | PASS |
| Item discounts before Order discounts | PASS |
| Percentage ROUND_HALF_UP to cents | PASS: 2.248 → 2.25, 0.999 → 1.00, 6.245 → 6.25 |
| Discounts capped at eligible subtotal | PASS |
| 100% discount marked as comp | PASS |
| Historical scope/value/applied amount/name/reason/actor snapshots | PASS: definition edits change nothing applied |
| No tax calculation | PASS |

### Modifiers

| Check | Result |
|---|---|
| Phase 7 validator reused | PASS |
| Required/min/max | PASS |
| Inactive/unattached rejected | PASS: inactive modifier, inactive membership, group not attached, modifier not in group, duplicate |
| Historical Modifier pricing | PASS |

### Recipe / consumption

| Check | Result |
|---|---|
| Recipe revision resolution timing | At SEND, the revision in effect at the send instant / PASS |
| Submitted Recipe revision fixed | PASS |
| Base Recipe requirements | PASS |
| Modifier ADD | PASS |
| Modifier REMOVE | PASS |
| Modifier ADJUST | PASS: positive and negative |
| Quantity multiplier | PASS |
| UOM/base conversion | PASS: 0.5 LB → 8 OZ_WEIGHT |
| Net negative requirement rejected | PASS: never consumed negatively (the shared rule drops it; see Policies) |
| No-Recipe Item behavior | PASS |

Canonical Bacon Cheeseburger (Medium, No Onion, Extra Pickles, Swiss instead of American): price 17.49; four modifier snapshots; recipe and revision IDs; kitchen instructions "Cook medium; No onion; Extra pickles; Swiss, not American"; consumption beef 8, bun 1, Swiss 1, pickles 5, bacon 2, with no American and no onion; exact CONSUME rows referencing the item; balances reconcile with the ledger; one batch. A retry with the same key adds no batch, ledger row or consumption snapshot.

### Submission

| Check | Result |
|---|---|
| Inventory consumption occurs on submission | PASS |
| Incremental send rounds | PASS: three rounds |
| Deterministic batch numbering | PASS |
| Only unsubmitted Items processed | PASS |
| Order/Inventory shared transaction | PASS |
| Insufficient-stock failure atomic | PASS: items stay DRAFT, no ledger rows, no batch |
| Negative-stock Location policy reused | PASS: allowed location goes to −4 |
| Duplicate/retry consumption prevented | PASS: retry, concurrent double send, database index |
| Idempotent retry returns original result snapshot | PASS |
| Inventory provenance | PASS: `ORDER_ITEM` reference plus consumption row |
| Trusted consume-only capability enforces orders.submit | PASS |
| Trusted capability preserves actor and Order/Item/submission references | PASS |
| No generic Inventory permission granted to Servers/Bartenders | PASS |
| Shortage details expose required/available/shortage quantities without cost | PASS |

### Voids

| Check | Result |
|---|---|
| Draft removal posts no Inventory | PASS |
| Submitted void requires permission/reason | PASS |
| Submitted void requires physical disposition | PASS |
| Original CONSUME retained | PASS |
| UNPREPARED posts SALE_REVERSAL | PASS |
| PREPARED_OR_DISCARDED does not restore Inventory | PASS |
| No automatic WASTE from prepared/discarded void | PASS |
| Reversal provenance links original consumption | PASS: `reverses_transaction_id` plus `ORDER_ITEM_VOID` reference |
| Item history retained | PASS |
| Full Order void | PASS |
| Double void rejected | PASS: service, plus a unique index on reversals |
| Void failure atomicity | PASS: a refused reversal leaves the item SUBMITTED and stock unchanged |

### Table session / takeout

| Check | Result |
|---|---|
| Table Session lifecycle validation | PASS: wrong location, ended session, wrong area type |
| Table Session completion blocked while any associated Order is OPEN | PASS: workflow, cancellation, and the stand-alone Restaurant service (database trigger) |
| No Order closure added to unblock Table Session | PASS |
| Moved Table Session retains Orders | PASS |
| TAKEOUT creates no physical seating | PASS |

### Authorization

| Check | Result |
|---|---|
| orders.view | PASS |
| orders.create | PASS |
| orders.edit | PASS |
| orders.submit | PASS |
| orders.void | PASS |
| orders.discount.apply | PASS |
| orders.discount.manage | PASS |
| Location scope | PASS: another location's order is not found |
| Order submission does not grant generic Inventory rights | PASS: a server who just sent is refused adjustment and waste |
| Direct unauthorized API denied | PASS: E2E 403 for a view-only user, 401 signed out |

### Future contracts

| Check | Result |
|---|---|
| Phase 10 prep-routing contract | PASS (see Architectural decisions) |
| No Kitchen/Bar tickets | PASS: a test asserts no ticket or fulfillment tables |
| Phase 11 settlement extension documented | PASS |
| Order closure deferred to Phase 11 settlement | PASS |
| No tax/payment/settlement records | PASS |
| No payment records | PASS |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation | PASS |
| Phase 2 Auth/RBAC | PASS |
| Phase 3 Employees/HR | PASS |
| Phase 4 Scheduling | PASS |
| Phase 5 Restaurant/Seating | PASS |
| Phase 6 Reservations/Waitlist | PASS |
| Phase 7 Menu/Recipes | PASS (two boundary tests updated: they asserted no order tables existed) |
| Phase 8 Inventory/Purchasing | PASS (the permission-scan allowlist names the two trusted capabilities) |
| `db:reset` safeguards | PASS |
| `/api/health` | PASS: through the E2E suite |

Real `npm run db:reset` refusals on a throwaway PostgreSQL 17 container, with a probe row intact afterwards: `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, database `restaurant_ops_test`, a fake RDS host, and `?host=` on a local URL. The reset, then seeding twice, gave `16 applied`, then `0 applied, 16 already applied`, with 106 permissions, 371 role grants and 0 orders, discounts or ledger rows. The container was removed.

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| `npm ci` | Not re-run; no dependency changed |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 546 of 546 (baseline 531) |
| Integration tests | PASS: 913 of 913 (baseline 868) |
| E2E tests | PASS: 101 of 101 (baseline 98) on a clean full run, after one earlier run of 100 of 101 (see below) |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, unchanged (DEV-002) |
| Seed idempotency | PASS |
| GitHub Actions | PASS: reported by the project owner after the work was pushed; I did not see the run |

### Problems found during validation

- **Generated foreign key names were too long.** Fixed in the schema, then regenerated.
- **Expected regressions**, updated deliberately: the migration table list, the permission count (102 → 106), the seed list and counts, two Phase 7 boundary tests that forbade order tables, the navigation list, and the inventory permission-scan allowlist.
- **One E2E failure, an expected count.** The Phase 2 Roles spec looked for "102 permissions" on the Owner role; it now has 106. The assertion was updated, and the full suite then passed 101 of 101.
- **A table-list ordering slip** in my own test edit, and one fixture that created a table at location B as the location A owner. Both were mine and are fixed.
- **Shell heredocs mangled scripts containing backticks**, so generator scripts were written to the scratchpad instead. There was no effect on the code.

## Tests executed

- **Unit (new, 15):** line amounts (exact, negative refused, precision, quantity); discount rounding, caps, ordering, comp; consumption planning (base, ADD, REMOVE, ±ADJUST, substitution, quantity, zero/negative dropped, no recipe, precision); lifecycle guards; kitchen instructions; idempotency fingerprint.
- **Integration (new, 42 in `tests/integration/orders/`):**
  - `submission`: the canonical burger, replay, key reuse, concurrent send, three rounds, price timing and history immutability, shortage atomicity and details, negative allowed, stale version, no-recipe item.
  - `orders`: creation for all three types, numbering under concurrency, area mismatch, wrong location, ended session, takeout disabled, multiple orders and move, draft preview, edit and remove, every modifier violation, stale version, unsellable item, session-end block on all paths, detail without cost.
  - `voids-and-discounts`: UNPREPARED reversal with cost and links, PREPARED with no waste, double, draft and stale voids, reversal failure atomicity, full void, item-then-order discounts with recompute after void, caps, comp, removal, refusals, append-only checks.
  - `authorization`: role matrix, each operation's permission, server SEND without inventory rights, view-only, location scope, reversal restricted, database freeze, module boundary scans.
- **Integration (updated):** migrations (table list plus a Phase 8 upgrade test), foundation seeds (counts, list, plus a Phase 8 → 9 permission upgrade test and a "no orders seeded" test), seed registry, Phase 7 boundary tests, inventory permission scan.
- **E2E (`orders.spec.ts`, 3):**
  - Floor to dine-in order, with the required modifier refused, an exact $12.75, send, stock decreased, a second round, and no void control for a server.
  - Takeout with no session, then a manager void as not prepared that stays visible, with the total updated and SALE_REVERSAL posted.
  - A view-only user reads but can't send; the API refuses with 403, and with 401 signed out.

**Partly covered:**

- The discount and discount-definition screens, quantity buttons and full-order void have integration coverage but no E2E.
- Phone-width layout of the order screen was built mobile-first but not tested at phone size.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/orders.ts`, `src/db/schema/infrastructure.ts`, `drizzle/migrations/0013_orders.sql`, `0014_orders_constraints.sql` and snapshots
- Orders module: `src/modules/orders/` (`rules`, `services`, `repositories`, `queries`, `validators`, `types.ts`)
- Workflows: `src/workflows/submit-order/`, `src/workflows/void-order-item/`
- Infrastructure: `src/infrastructure/idempotency/idempotency-service.ts`
- Inventory: `src/modules/inventory/services/order-consumption.ts`
- Menu: `src/modules/menu/queries/order-menu-facts.ts`
- Restaurant: `src/modules/restaurant/queries/session-facts.ts`
- Seed: `src/db/seeds/orders-foundation.ts`
- API: 12 Route Handlers under `src/app/api/orders/` and `src/app/api/discount-definitions/`
- UI: `src/app/(app)/orders/` (list, workspace, discounts), `src/components/orders/`
- Tests: `tests/integration/orders/` (4 files), `src/modules/orders/rules/order-rules.test.ts`, `tests/fixtures/order-fixtures.ts`, `tests/fixtures/order-cleanup.ts`, `tests/e2e/orders.spec.ts`, `tests/helpers/e2e-orders.ts`
- Docs: this report

**Modified**

- Schema: `inventory.ts` (SALE_REVERSAL, reversal link, consumption index), `index.ts`, migration journal
- Inventory: `types.ts`, `posting-service.ts` (reversal passthrough; exported settings reader)
- Shared: `app-error.ts` and `api-route.ts` (optional `details`)
- Auth: `permission-catalog.ts` (106 codes), `role-catalog.ts`
- Seeds: `registry.ts`
- Workflow: `end-table-session.ts` (open-order guard and mapping)
- UI: `floor-board.tsx` and the floor page ("Orders" link), `navigation.ts`
- Tests: `auth.test.ts`, `tests/e2e/auth.spec.ts`, `navigation.test.ts`, `employee-fixtures.ts` (clears orders first), migration, seed, seed-framework, inventory authorization, menu-config and recipes tests
- Docs: `README.md` §16, §17, §23, §33 (Phase 5 note; new Phase 9 policies), §36

## Risks

- **Outbox gap before Phase 10.** README §24 requires outbox writes in SEND, and the Phase 10 plan forbids an outbox. Phase 10 must resolve this before any realtime event is published.
- **SEND reads the whole operational menu once per send.** This is fine for one restaurant; measure it under load.
- **Balance-row serialization** (carried from Phase 8): concurrent sends that use the same ingredient queue on one row.
- **Test cleanup lifts append-only and freeze triggers** inside its own transaction, in the test database only.
- **The stand-alone Restaurant `completeSession` surfaces the trigger refusal as an unmapped error (500).** No route uses it; the workflow maps it to `ORDERS_OPEN`.
- **Displays use UTC/locale formatting** as in earlier phases. Order numbers restart each business date, so a number is unique only with its date.
- **`btree_gist` on RDS** remains untested (carried).

## Remaining issues

None block Phase 10.

1. **Outbox for Phase 10: decided 2026-11-09.** README/CLAUDE.md rule 8 says realtime events go through `outbox_events` after commit, while the Phase 10 plan says to add no outbox. The project owner chose the README contract: Phase 10 builds `outbox_events`, written in the SEND (and fulfillment) transactions, and a processor that publishes committed events. This overrides the Phase 10 plan's "no outbox" instruction (its item 9).
2. **Audit domain: still your decision** (carried since Phase 3). Order sends, voids and discounts now add to the list of actions without audit events.
3. **No E2E for discounts or the full-order void,** which have integration coverage.
4. **Carried over:** the Phase 6 held-table move gap, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json` (Next.js warns about it on every start), and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted risks

DEV-001, DEV-002 and DEV-003: unchanged. No dependencies were added.

## Business domains created beyond Phase 9

NONE. No ticket, fulfillment, settlement, tender, tax, payment, outbox or audit table exists, and tests assert there are no ticket, fulfillment or settlement tables.

## Next-phase readiness

**Phase 10 readiness: READY,** subject to review of this report. Phase 10 builds the transactional outbox (Remaining issue 1). Phase 10 creates tickets inside `sendOrderItems`' transaction from each sent item's batch, `prep_station_ids_snapshot`, `kitchen_instructions_snapshot` and modifier snapshots, and a remake can consume from `order_item_inventory_consumption`.
