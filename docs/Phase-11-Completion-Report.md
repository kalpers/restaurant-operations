# Phase 11 Completion Report

This report follows the plan §87 template plus the sections CLAUDE.md requires. Results are from this repository on 2026-11-09.

## Summary

Phase 11 is implemented. Staff open a Settlement from an OPEN order. It snapshots the order's post-discount, pre-tax amount. Staff then record one or more tenders (cash, externally processed card, gift card, house account, other) until nothing remains, and complete it. Completion closes the order in the same transaction. A fully comped order closes with a zero-amount settlement and no tender. Settlement is record only: nothing charges a card or contacts a provider, and no card number, CVV, track data or PIN can be stored. Closing a dine-in order lifts the Table Session's open-order guard but does not end the session. The existing floor action still ends it and marks the tables DIRTY. Takeout closes with no session.

**Validation: one CI fix is pending a CI rerun.** GitHub Actions on the pushed commit `00fa1f8` failed one E2E test: the settlements dine-in test, on all three attempts. The cause was my test isolation, not the application. The settlements spec reused the orders spec's E2E accounts, and the orders spec's `afterAll` cleanup, running on the other worker, disabled those accounts and deleted their roles mid-test. The fix gives the settlements spec its own accounts, roles and tables (see Problems found). Afterwards the full E2E suite passed 109 of 109 locally, and orders, settlements and kitchen passed 11 of 11 together on two workers. The fix is not yet committed or re-run in CI.

**Please review these decisions.** The first two are your answers in planning; the rest are defaults I chose.

1. **The order amount is locked while a settlement is OPEN** (your decision). SEND, item and order voids, and discount changes are refused with `SETTLEMENT_IN_PROGRESS`. Draft edits are still allowed.
2. **Server and Bartender grants** (your decision): `settlements.view`, `.create`, `.tender.cash`, `.tender.external-card`, `.tender.gift-card`, `.complete`. House account, other, void-tender and card metadata are manager-only.
3. **Cancelling a settlement** needs `settlements.create` and a reason, and is allowed only once no RECORDED tender remains (void them first).
4. **Opening is naturally idempotent.** Asking again returns the OPEN settlement.
5. **Card-number guard.** Every tender text field refuses 13 or more consecutive digits, checked by Zod, the service and a check constraint.
6. **References and card metadata** (provider, external reference, brand, last four, authorization code) are returned only with `settlements.view-card-metadata`. Servers can enter them but don't see them afterwards.
7. **`orders.close` stays unused.** There is no generic close. Closure needs `settlements.complete` and a completed settlement.
8. **Audit events are still not written** (carried since Phase 3).

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (Docker) |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| Exact money arithmetic | The shared BigInt decimal helpers (`src/shared/decimal`), with `NUMERIC(12,2)` columns and decimal strings throughout |
| New dependencies | None (no payment SDK) |

## Policies

The plan's Approved Phase 11 Policies 1–13 are binding and implemented as written. README §33 "Phase 11 Settlements" records them as built.

| Policy | Implemented |
|---|---|
| Tax | Deferred. The amount settled is `orders.subtotal` (Phase 9 post-discount, pre-tax). The UI says "Amount due before tax" and "Tax isn't calculated in this version" |
| Tip | A separate, nonnegative, exact-cents amount, only on CASH and EXTERNAL_CARD (service and check constraint). It never changes the order amount or snapshot, and isn't allocated to employees |
| Tender types | Exactly CASH, EXTERNAL_CARD, GIFT_CARD, HOUSE_ACCOUNT and OTHER, all record-only classifications. OTHER needs a description |
| Refunds | Deferred |
| Closed order reopen | Not possible. A trigger refuses any change to a CLOSED order |
| Table Session auto-completion | None. Final settlement only lifts the open-order guard; the explicit floor completion marks tables DIRTY |
| One OPEN settlement; split tender | A partial unique index allows one OPEN (and one COMPLETED) per order; many tenders within it |
| Split checks | Several orders per session (Phase 9); no items move between orders |
| Cash | `change = received − applied − tip`, refused if negative; no rounding; change is never tender value |
| FAILED card | Only EXTERNAL_CARD, with a reported reason, no tip, contributes $0, kept in history |
| Zero balance | Completes with no tender; history reason "Zero-amount order" |
| Tender void | Only RECORDED, only while OPEN; needs permission, reason, actor and time; no row deleted. The UI says nothing is reversed externally |
| Fulfillment and drafts | Settlement neither needs nor changes fulfillment. Completion needs no DRAFT item |

## Architectural decisions

- **Module layout.** `src/modules/settlements/` holds `types.ts`, the pure `rules/settlement-math.ts`, a repository, services (open, record tender, void tender, cancel), queries (purpose-built DTOs), validators and access. `src/workflows/close-order/complete-settlement.ts` orchestrates completion and order closure (README §5 names `close-order`).
- **Orders keeps ownership of its lifecycle.** The Orders repository has `closeOrderForSettlement` (OPEN → CLOSED, `closed_at`, history, version bump), `lockOrderRow` (lock without a version check) and `countDraftItems`. The Orders module never imports Settlements; a boundary test checks this. The SEND and void workflows call `assertNoOpenSettlement` before any stock moves. Settlement views read the order through the new unchecked `readOrderDetail`, after checking `settlements.view` themselves.
- **Lock order.** Every settlement command locks the order row (FOR UPDATE), then the settlement, and checks the settlement `version`. This is the same order-first lock every Phase 9 order mutation takes, so there are no cycles.
- **Database guards** (migration 0020): the settlement status history is append-only. Settlements must be at their order's location, start OPEN, can never be deleted, and keep their snapshot; COMPLETED and CANCELLED settlements are frozen. A tender can only go RECORDED → VOIDED, only while its settlement is OPEN, and is never deleted. On `orders`: → CLOSED needs a COMPLETED settlement for that amount; CLOSED is frozen; and while a settlement is OPEN the amount and status are locked.
- **Projections.** `tendered_amount`, `tip_amount` and `change_due` are recomputed exactly from the tender rows on every change. A check constraint keeps `tendered_amount ≤ snapshot`, and COMPLETED requires the two to be equal.
- **Business dates** come from `businessDateOf`: settlement `opened_business_date` and `completed_business_date`, and each tender's `business_date`.
- **Outbox events** (identifiers only): `settlement.opened`, `.tender-recorded`, `.tender-voided`, `.completed`, `.cancelled` and `order.closed`. The order and settlement screens refresh on them.

### Plan vs repository

| Plan says | Built as | Why |
|---|---|---|
| Migration `0029` renames `settlements` (from `0027`/`0028`) to `order_settlements` | `order_settlements` created directly in `0019` | The repository ended at `0018` and had no settlements table |
| `settlements` table in deliverables | `order_settlements` (the README name); TypeScript `settlements` | Plan §9 |

### Architecture deviations

| Deviation | Reason |
|---|---|
| Amount lock while OPEN (not in the plan) | Your decision; keeps the snapshot from going stale |
| Triggers on `orders` from the settlement migration | Follows the Phase 9 `table_sessions` and Phase 10 `prep_stations` precedent, so Orders needs no Settlements import |
| No audit events | Still undecided since Phase 3 |
| `.github/copilot-instructions.md` not used | CLAUDE.md replaces it |

## Settlement Schema

| Table | Result |
|---|---|
| order_settlements physical table | PASS |
| settlement_tenders | PASS |
| settlement_status_history | PASS |

## Migrations

| Migration | Contents |
|---|---|
| `0019_order_settlements.sql` | Generated. Three tables, checks for lifecycle fields, amounts, cash, tips, FAILED, OTHER, card fields, the card-number guard and void fields, partial unique OPEN and COMPLETED indexes, and an idempotency FK. I named one FK explicitly because its generated name was 63 characters. That happened before the first apply, so no applied migration was edited |
| `0020_settlement_constraints.sql` | Custom. The guard triggers above |

| Check | Result |
|---|---|
| Generation | PASS |
| Application | PASS (development database upgraded with `db:migrate`) |
| Existing Phase 10 DB → Phase 11 | PASS: your development database, plus a new automated test that upgrades a Phase 10 database (empty settlement tables, guard triggers present) |
| Empty DB reconstruction | PASS: automated test, plus a real `db:reset` on a throwaway PostgreSQL 17 container (21 migrations applied) |
| Unexplained schema drift | NONE: a further `db:generate` reports "No schema changes" |

**What changed in your development database:** permissions 112 → 121, role grants 401 → 438, 1 user kept, no orders, settlements or tenders.

## Validation results

### Settlement

| Check | Result |
|---|---|
| One active Settlement per Order | PASS (concurrent opens return one; the database refuses a second) |
| Order amount snapshot | PASS (exact, post-discount; 18.50 from 12.25 + 6.25) |
| OPEN lifecycle | PASS |
| COMPLETED lifecycle | PASS |
| CANCELLED lifecycle | PASS (only with no RECORDED tender; history kept) |
| Exact reconciliation | PASS |
| Completion atomic with Order close | PASS: a forced failure at order closure left both the settlement and the order OPEN with no history, and the retry then succeeded |
| Idempotent completion | PASS (replay; one CLOSED and one COMPLETED history row) |

### Tenders

| Check | Result |
|---|---|
| CASH | PASS |
| EXTERNAL_CARD | PASS |
| GIFT_CARD | PASS |
| HOUSE_ACCOUNT | PASS |
| OTHER description/reason | PASS |
| Multiple tenders | PASS ($75 = $25 cash + $50 card, kept as separate rows) |
| Cash received/applied/change | PASS (18.50 of 20.00 → 1.50; with a 1.00 tip → 0.50) |
| Failed tender history | PASS (kept, $0, order stays OPEN) |
| Tender void before completion | PASS |
| Tender idempotency | PASS (one row; the same key with a different request is refused) |
| Concurrent over-settlement prevented | PASS (two terminals, one wins; a reload then gets `AMOUNT_EXCEEDS_REMAINING`) |

### Security

| Check | Result |
|---|---|
| No PAN storage | PASS (no column; 13+ digits refused in Zod, the service and the database; E2E checks the stored rows) |
| No CVV storage | PASS (no column or field; E2E finds no card-number, CVV or PIN input) |
| Safe card metadata only | PASS (last four exactly four digits; metadata hidden without `view-card-metadata`) |
| Logs/errors exclude prohibited card data | PASS (`apiRoute` logs only the error name and code, and validation errors name fields, never values) |

### Money

| Check | Result |
|---|---|
| BigInt/minor-unit arithmetic | PASS (unit test: 0.10 + 0.20 settles 0.30 exactly) |
| Discount snapshots reused | PASS (the snapshot is `orders.subtotal`; discounts unchanged) |
| Zero-balance comp | PASS (integration and E2E) |
| Tax arithmetic | Deferred |
| Tip arithmetic | PASS |

### Order Closure

| Check | Result |
|---|---|
| OPEN → CLOSED via Settlement | PASS |
| Generic close bypass absent | PASS (no endpoint; a direct SQL close is refused) |
| VOIDED Order cannot settle | PASS |
| CLOSED immutable/no reopen | PASS (service and trigger) |

### Table Session

| Check | Result |
|---|---|
| One OPEN Order keeps completion blocked | PASS (integration `ORDERS_OPEN`; E2E floor alert) |
| All Orders CLOSED removes financial guard | PASS |
| Settlement does not auto-dirty tables | PASS (session ACTIVE, table CLEAN after both checks closed) |
| Existing explicit completion makes tables DIRTY | PASS (integration and E2E) |

### Takeout

| Check | Result |
|---|---|
| No Table Session required | PASS (no session created) |
| Settlement → Order CLOSED | PASS (integration and E2E) |

### Authorization

| Check | Result |
|---|---|
| settlements.view | PASS |
| create permission | PASS |
| cash tender permission | PASS |
| external-card tender permission | PASS |
| gift-card tender permission | PASS |
| house-account tender permission | PASS |
| other tender permission | PASS |
| complete permission | PASS |
| tender void permission | PASS (servers refused) |
| Location scope | PASS (another location's settlement looks absent) |
| Direct unauthorized API denied | PASS (E2E 403 for view-only, 401 signed out) |

### Boundaries

| Check | Result |
|---|---|
| No Inventory transactions from Settlement | PASS (ledger identical before and after; E2E checks it too) |
| Fulfillment unchanged by Settlement | PASS (ticket items and history identical; fulfillment continues after closure) |
| Order snapshots unchanged | PASS (order item rows identical) |
| No payment gateway falsely implemented | PASS (no provider code or SDK; the UI says "Record only") |

### Regression

| Check | Result |
|---|---|
| Phase 1 foundation | PASS |
| Phase 2 Auth/RBAC | PASS |
| Phase 3 Employees/HR | PASS |
| Phase 4 Scheduling | PASS |
| Phase 5 Restaurant/Seating | PASS (integration, and E2E in CI on `00fa1f8`). Locally: one flaky failure in the first full run, then 18/18 alone and 109/109 in the final full run |
| Phase 6 Reservations/Waitlist | PASS |
| Phase 7 Menu/Recipes | PASS |
| Phase 8 Inventory/Purchasing | PASS |
| Phase 9 Orders | PASS |
| Phase 10 Kitchen/Bar Fulfillment | PASS |
| db:reset safeguards | PASS. On a throwaway container, real `db:reset` refused `NODE_ENV=production`, `NODE_ENV=test`, database `postgres`, database `restaurant_ops_test`, a fake RDS host and `?host=`; the probe row survived. Then a real reset and two seeds gave `18 applied`, then `0 applied, 18 already applied`, with 121 permissions, 438 grants and no orders, settlements or tenders. The container was removed |
| /api/health | Not separately re-run; every E2E sign-in exercised the app against the database |

### Validation

| Check | Result |
|---|---|
| PostgreSQL health | PASS |
| npm ci | Not re-run; no dependency changed |
| lint | PASS (0 errors, 0 warnings) |
| typecheck | PASS |
| unit tests | PASS: 605 of 605 (baseline 576) |
| integration tests | PASS: 1009 of 1009 in 54 files (baseline 961) |
| E2E tests | **CI on `00fa1f8`: FAIL**, reported by the project owner (107 passed, 1 failed, 1 flaky). The failure was `settlements.spec.ts` dine-in, on all three attempts, caused by shared E2E accounts (see Problems found). The flaky test was `scheduling.spec.ts` swap approval, which passed on retry and touches no Phase 11 code. After the fix, locally: full suite **109 of 109**, and the three order-related specs 11 of 11 on two workers. Still needs a CI rerun. Before the fix, locally: full run 108 passed, 1 failed. The failure was `restaurant.spec.ts` "configures a table and a section, and assigns a server": an "Assign server" button wasn't found within 5 s. It touches no Phase 11 code, and the restaurant spec then passed 18 of 18 alone. I'm treating it as load-related flakiness, which this machine also showed in Phase 10, but I have not proven that. The settlements spec passed 4 of 4 in both runs |
| production build | PASS |
| npm audit --omit=dev | PASS: 0 vulnerabilities |
| npm audit (including dev) | 12 moderate, unchanged (DEV-002) |
| Seed idempotency | PASS (development database: `1 applied`, then `0 applied, 18 already applied`; throwaway container as above) |

### Problems found during validation

- **A 63-character generated FK name**, found before the first apply. I named it explicitly and regenerated 0019.
- **Expected regressions**, updated deliberately: permission counts (112 → 121) in unit, seed and E2E tests; the seed list and run counts; the migration table list (plus a new Phase 10 upgrade test); the Phase 9 Orders boundary scan (Orders may now name settlement but still may not import the Settlements module or touch tender or ticket data); and the Phase 7 "no settlement tables" check, which now expects exactly the three Phase 11 tables.
- **My own slip:** I placed `order_settlements` out of alphabetical order in the expected table list. Fixed.
- **Shared E2E accounts (found by CI).** My settlements spec reused the orders spec's account markers (`@orders-e2e.example.test`, `ORDERS_E2E_` roles, `ORD-` tables). Playwright runs specs on two workers, so the orders spec's `afterAll` (`removeOrdersE2eData`) could disable those users and delete their roles while a settlements test ran. In CI, sign-in then went back to `/login`, or a page lost its permission mid-test. Locally the two specs never overlapped. Fix: `e2e-orders.ts` now takes an `E2eScope` (email domain, role prefix, table prefix), with `ORDERS_SCOPE` as the default, so the orders spec is unchanged. The settlements spec uses `SETTLEMENTS_SCOPE` for its accounts, tables and cleanup, as the kitchen spec already did with its own helper.
- **Observed, not caused here:** each E2E run logs one `Outbox batch failed; it will be retried` at dev-server start. It appears to happen while global setup recreates the test database. It retries and no test depends on it. I did not investigate it further.

## Tests executed

- **Unit (new, 29, `src/modules/settlements/rules/settlement-math.test.ts`):** single, multiple and remaining amounts; floating-point drift; VOIDED/FAILED excluded; zero amount; discounted snapshot; exact cash, change, change after tip, insufficient, negative and sub-cent cash; received required; over-application; external card with tip; failed card; tip types; OTHER description; card-number refusal; completion refusals (underpaid, voided, drafts); lifecycle; money normalization.
- **Integration (new, 45, `tests/integration/settlements/`):**
  - `settlements` (28): opening and snapshot, one OPEN (concurrent and DB), location, VOIDED; $75 mixed tender; cash change and tip; refusals; gift/house/other; failed card; void; card-number refusal (service and DB); no sensitive columns; tender retry; concurrent final tender; concurrent completion; completion replay; stale version; comp; drafts; amount lock and unlock; cancel rules; terminal states and DB guards; no close bypass; failure atomicity; outbox; nothing stored on refusal.
  - `closure` (4): split checks and the session guard through to DIRTY; takeout; no inventory, fulfillment or snapshot change, with fulfillment continuing after closure; fulfillment never closes an order.
  - `authorization` (13): view-only, view, create, each of five tender permissions, complete, void, card-metadata visibility, location scope, the role matrix.
- **Integration (updated):** migrations (table list, Phase 10 upgrade), foundation seeds (counts, list, Phase 10 → 11 upgrade, no settlements seeded), seed framework, the Orders boundary scan, the Phase 7 table check.
- **E2E (new, `tests/e2e/settlements.spec.ts`, 4):** dine-in cash with tip and change, session blocked then completed to Dirty, no stock moved; takeout partial cash plus external card with a refused card number and stored-data check; comp at $0.00; view-only on screen and by API (200/403/401).

**Partly covered:** tender void and settlement cancel have integration but no E2E coverage. The settlement screen wasn't checked at phone width.

## Files changed

**Created**

- Schema and migrations: `src/db/schema/settlements.ts`, `drizzle/migrations/0019_order_settlements.sql`, `0020_settlement_constraints.sql` and snapshots
- Settlements: `src/modules/settlements/` (`types.ts`, `rules/settlement-math.ts` and its test, `repositories/settlement-repository.ts`, `services/settlement-service.ts`, `services/access.ts`, `queries/settlement-queries.ts`, `validators/settlement-validators.ts`)
- Workflow: `src/workflows/close-order/complete-settlement.ts`
- Seed: `src/db/seeds/settlement-foundation.ts`
- API: `src/app/api/orders/[orderId]/settlement` (GET), `src/app/api/orders/[orderId]/settlements` (POST), `src/app/api/settlements/[settlementId]/tenders`, `.../tenders/[tenderId]/void`, `.../complete`, `.../cancel`
- UI: `src/app/(app)/orders/[orderId]/settlement/page.tsx`, `src/components/settlements/settlement-workspace.tsx`
- Tests: `tests/integration/settlements/` (3 files), `tests/fixtures/settlement-fixtures.ts`, `tests/e2e/settlements.spec.ts`
- Docs: this report

**Modified**

- Orders: `order-repository.ts` (close, unversioned lock, draft count, guard mapping), `order-queries.ts` (unchecked reads for other domains)
- Workflows: `submit-order.ts`, `void-order-item.ts` (early `SETTLEMENT_IN_PROGRESS`)
- Auth: `permission-catalog.ts` (121 codes), `role-catalog.ts`
- Schema index, seed registry, migration journal
- UI: the order page and workspace ("Settle check" / "View settlement" link, refresh on settlement events)
- Tests: `order-cleanup.ts`, `e2e-orders.ts` (helpers, settlement cleanup, per-spec `E2eScope`), `auth.test.ts`, `tests/e2e/auth.spec.ts`, and the integration tests listed above
- Docs: `README.md` §19 (tables), §33 (Phase 9 note, new "Phase 11 Settlements")

## Risks

- **Locked checks.** Once a tender is recorded, changing the check means voiding tenders (manager-only) and cancelling. That's deliberate, but servers will need a manager for late additions.
- **No refunds or post-close corrections.** A closing mistake can't be fixed in the app until a correction workflow is approved.
- **Card metadata is self-reported.** The last four, brand and references are whatever staff type; the app verifies nothing externally.
- **Single-process realtime and outbox growth** (carried from Phase 10).
- **Test cleanup lifts triggers** in the test database only (carried, now including the settlement guards).
- **Full E2E flakiness on this machine** under load (Phase 10 and here).

## Remaining issues

1. **CI failure in `settlements.spec.ts`: fixed, needs commit and a CI rerun.** See Problems found. The earlier local `restaurant.spec.ts` failure passed in CI on `00fa1f8`; that was local load flakiness. CI's flaky scheduling swap test passed on retry and is outside Phase 11.
2. **Audit domain:** still your decision (carried since Phase 3). Settlement actions now add to the unaudited actions.
3. **Committed:** Phase 11 was pushed in `00fa1f8`. The E2E isolation fix (`tests/helpers/e2e-orders.ts`, `tests/e2e/settlements.spec.ts`) and this report update are uncommitted.
4. **Carried over:** the Phase 6 held-table move gap, the old `restaurant-ops-postgres-1` container and volume, the stray `C:\Users\kneal\package-lock.json`, and the unanchored `out/` and `uploads/` rules in `.gitignore`.

## Accepted Risks

- DEV-001: unchanged. DEV-002 and DEV-003: unchanged. No dependencies were added.

## Business Domains Created Beyond Phase 11

NONE. No reporting, refund, tax, payment-processing or audit table exists.

## Next-Phase Readiness

**Phase 12 readiness: READY once CI passes** with the E2E isolation fix, and subject to review of this report. Reporting can read settlement and tender history (`completed_business_date`, tender `business_date`, the separate tip and change columns) without recalculating anything.
