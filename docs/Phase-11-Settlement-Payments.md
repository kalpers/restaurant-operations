# Phase 11: Settlement & Payments Design and Implementation Plan

## Purpose

Phase 11 completes the commercial Order lifecycle by implementing Settlement, tender recording, exact amount reconciliation, and Order closure. Closing the final Order removes the Table Session's financial blocker but does not complete its physical departure workflow.

Before starting, read completely:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 10 implementation plans and completion reports
5. This document

`README.md` remains the architectural source of truth.

Derive current state from source, migrations, tests, and committed documentation rather than previous Copilot chat history.

## Approved Phase 11 Policies

Approved 2026-10-08. These decisions replace conflicting recommendations elsewhere in this plan and are binding for schema, services, UI, tests, and reporting.

1. Tax calculation is deferred. Settle the exact Phase 9 post-discount, pre-tax Order amount. Do not infer taxability or display a calculated tax amount.
2. Use exactly these recorded tender types: `CASH`, `EXTERNAL_CARD`, `GIFT_CARD`, `HOUSE_ACCOUNT`, and `OTHER`. Do not process cards, gift-card balances, house-account receivables, or external providers. `OTHER` requires an identifying description/reason. Never persist PAN, CVV/CVC, track data, PIN, or sensitive EMV data.
3. An Order may have multiple historical Settlements but at most one `OPEN` Settlement. Multiple Tenders within that Settlement support partial and split tender. Do not implement multiple partially completed Settlements that cumulatively satisfy one Order. Completion of the exactly reconciled Settlement closes the Order.
4. Separate checks use multiple Orders on a Table Session. Do not move or reassign submitted Order Items between Orders.
5. Tips are separate from the Order obligation and allowed only on `CASH` and `EXTERNAL_CARD`. Tips use exact cents, cannot be negative, and do not change prices, discounts, subtotal, or the Order amount snapshot. Do not allocate tips to Employees/payroll.
6. Do not cash-round. For cash, `change_due = cash_received - order_amount_applied - cash_tip`; any positive excess is change, not Order tender value. Require received cash to cover the applied amount and tip.
7. A `FAILED` `EXTERNAL_CARD` Tender may only record a failure reported from an actual external/manual process. It has no provider call or simulated authorization behavior and contributes zero to reconciliation.
8. A zero-balance Order may complete an explicit zero-amount Settlement without a Tender, preserving closure provenance.
9. A Tender may be voided only while its Settlement is `OPEN`, with permission, reason, actor, and timestamp. A void of an externally handled Tender is an application-record correction only, not an external reversal.
10. Refunds, post-completion reversals, historical sale mutation, and reopening `CLOSED` Orders are deferred. `CLOSED` is terminal in Phase 11.
11. Settlement does not require fulfillment completion and does not change fulfillment or Inventory. Fulfillment does not settle or close an Order.
12. Settlement completion is blocked by any active `DRAFT` Order Item. Every non-void Order Item must be `SUBMITTED`; staff must submit or remove drafts first.
13. Final Order settlement does not complete the Table Session. After all associated Orders are `CLOSED`, the existing explicit physical completion workflow remains required; only it marks used tables `DIRTY`.

---

## 1. Phase 11 Objectives

Implement:

```text
Order OPEN
    |
    v
Settlement
    |
    +-- Amount Due
    +-- Tender(s)
    |    +-- CASH
    |    +-- EXTERNAL_CARD
    |
    +-- Tip
    +-- Change Due for Cash
    +-- Reconciliation
    |
    v
Order CLOSED
```

For dine-in:

```text
Table Session
    |
    +-- Order A CLOSED
    +-- Order B CLOSED
    |
    v
Table Session may complete
    |
    v
Tables -> DIRTY
```

Deliver:

- Settlement records
- Tender records
- Cash tender workflow
- Safe external-card tender abstraction
- Multiple tenders per Settlement
- Exact reconciliation
- Tips
- Cash change
- Zero-balance/fully-comped Orders
- Tender failure/cancellation history where applicable
- Idempotent payment recording
- Order `OPEN -> CLOSED` transition
- Dine-in Table Session completion integration
- Takeout settlement and closure
- Settlement/payment RBAC
- Responsive settlement UI
- Unit, PostgreSQL integration/concurrency, and Playwright tests

---

## 2. Scope Boundary

Do not implement unless explicitly approved during Phase 11:

```text
raw credit/debit card storage
PAN storage
CVV storage
card magnetic-stripe data
EMV cryptograms
real payment-gateway integration
PCI card vault
chargebacks
merchant payout reconciliation
accounting/general ledger
cash-drawer hardware integration
external tax service
loyalty points
online payment links
full reporting dashboards
```

Do not create fake card processing.

A recorded external card tender is not evidence that this application processed raw card credentials.

---

## 3. Critical Boundary: Order vs Settlement

An Order defines what was sold.

A Settlement defines how the financial obligation was satisfied.

```text
Order
  +-- submitted Items
  +-- discounts
  +-- commercial snapshots

        !=

Settlement
  +-- amount due
  +-- tenders
  +-- tips/change
  +-- reconciliation
```

Do not place tender details directly on `orders`.

---

## 4. Critical Boundary: Settlement vs Tender

A Settlement may contain multiple tenders.

```text
Settlement
    |
    +-- Cash $25.00
    +-- Card $50.00
```

Do not model payment as:

```text
orders.payment_type
```

or another one-tender-only field.

---

## 5. Critical Boundary: Recorded Card Tender vs Card Processing

Phase 11 may record that a card transaction was completed externally.

It must not store sensitive card credentials.

Allowed safe metadata may include, when available:

```text
external provider/reference
token/reference identifier
card brand
last four digits
authorization/reference code
processed timestamp
```

Never store:

```text
full PAN
CVV/CVC
track data
PIN
raw EMV sensitive data
```

Phase 11 has no payment-provider contract or integration.

---

## 6. Review Existing Foundation Before Changes

Before editing, inspect and confirm:

- Phase 0 through Phase 10 validation remains green.
- Phase 9 Order lifecycle is `OPEN`, `CLOSED`, `VOIDED`.
- Phase 9 does not currently close Orders.
- Phase 9 exact money/discount helpers are understood.
- Phase 9 submitted snapshots are immutable.
- Phase 9/Table Session completion guard is understood.
- Phase 10 fulfillment completion leaves Order OPEN.
- BusinessDateService is understood.
- Location-aware RBAC is understood.
- Shared PostgreSQL transaction context is understood.
- No payment/Settlement domain currently exists.
- DEV-001 remains tracked.

Before coding, provide a concise Phase 11 execution plan based on actual repository state.

---

## 7. Policy Decision Gate

The policy questions listed here are resolved by the **Approved Phase 11 Policies** above. Do not reopen those decisions during implementation. If repository evidence conflicts materially with an approved policy or README, stop and report the conflict before coding.

---

## 8. Approved Tax Policy

Tax calculation is deferred in Phase 11. Settle the exact Phase 9 post-discount, pre-tax amount. Do not infer taxability from Menu Item type, Location, Order type, or Food/Alcohol classification, and do not display a calculated tax amount. Do not introduce a tax percentage or tax service.

---

## 9. Settlement

Create:

```text
order_settlements
```

`order_settlements` is the physical PostgreSQL table name required by README. TypeScript domain identifiers may remain `settlements`. Migration `0029` forward-renames the previously generated `settlements` table without dropping/recreating it or rewriting migrations `0027`/`0028`.

Conceptual fields:

```text
id                     UUID PK
order_id               UUID FK
location_id            UUID FK
status                 required
order_amount_snapshot  NUMERIC(12,2) required
tendered_amount        NUMERIC(12,2) required default 0.00
tip_amount              NUMERIC(12,2) required default 0.00
change_due              NUMERIC(12,2) required default 0.00
opened_by_user_id      UUID FK
opened_at               TIMESTAMPTZ
completed_by_user_id   UUID nullable FK
completed_at            TIMESTAMPTZ nullable
cancelled_by_user_id   UUID nullable FK
cancelled_at            TIMESTAMPTZ nullable
version                 INTEGER default 1
created_at              TIMESTAMPTZ
updated_at              TIMESTAMPTZ
```

Use exact monetary representations consistent with Phase 9.

---

## 10. Settlement Lifecycle

Approved Settlement states:

```text
OPEN
COMPLETED
CANCELLED
```

Only `OPEN` Settlements may accept/edit tenders.

`COMPLETED` is immutable. Refunds and post-completion corrections are deferred.

Do not use Settlement `CANCELLED` to reverse an already completed financial event.

---

## 11. One Active Settlement per Order

Approved invariant:

```text
One Order -> at most one OPEN Settlement
```

Use database/transaction protection against concurrent duplicate Settlement creation.

Historical `CANCELLED` Settlements may remain for provenance, followed by at most one completed Settlement. An Order may have at most one OPEN Settlement. Do not use multiple partially completed Settlements to cumulatively satisfy an Order; exact completion closes the Order.

Do not allow one Order to be simultaneously settled by two independent active Settlements.

---

## 12. Order Amount Snapshot

When Settlement begins, derive the current immutable amount payable from Phase 9 Order commercial state.

Conceptually:

```text
submitted non-void item totals
- applied discounts
= Order amount due before tips/tax policy
```

Use the approved existing exact Order subtotal/discount calculations.

Do not re-resolve current Menu prices.

The Settlement captures an exact amount snapshot.

---

## 13. Order Eligibility for Settlement

At minimum:

- Order must be `OPEN`.
- Order must belong to caller's authorized Location.
- No active DRAFT Order Item may remain when Settlement completes; every non-void Item must be SUBMITTED.
- Fulfillment completion is not required for Settlement.
- Order must not be `VOIDED`.

---

## 14. Tender Records

Create:

```text
settlement_tenders
```

Conceptual fields:

```text
id                      UUID PK
settlement_id           UUID FK
tender_type             required
status                  required
amount                  NUMERIC(12,2) required
tip_amount              NUMERIC(12,2) required default 0.00
received_amount         NUMERIC(12,2) nullable
change_amount           NUMERIC(12,2) required default 0.00
external_reference      nullable
provider_name           nullable
card_brand              nullable
card_last_four          nullable
authorization_reference nullable
other_description       nullable
failure_reason          nullable
recorded_by_user_id     UUID FK
recorded_at             TIMESTAMPTZ
voided_by_user_id       UUID nullable FK
voided_at               TIMESTAMPTZ nullable
void_reason             nullable
idempotency_key         required
created_at              TIMESTAMPTZ
```

Do not include raw sensitive card fields.

---

## 15. Tender Types

Approved tender types:

```text
CASH
EXTERNAL_CARD
GIFT_CARD
HOUSE_ACCOUNT
OTHER
```

All five types are recorded classifications only. Do not process cards, gift-card balances, house-account receivables, or external providers. `OTHER` requires a description/reason sufficient to identify what was recorded.

Discounts/comps remain Order commercial adjustments, not tenders.

---

## 16. Tender Lifecycle

Approved Tender status values:

```text
RECORDED
VOIDED
FAILED
```

For CASH, a valid record normally becomes `RECORDED` immediately.

For `EXTERNAL_CARD`, the application records a result reported from a real external/manual process; it never initiates processing. A `FAILED` record is allowed only for an externally/manual reported failure, remains in history, and contributes zero to reconciliation. Do not simulate authorization or decline behavior.

---

## 17. Cash Tender

Cash input distinguishes:

```text
Order amount applied
cash tip
cash received from guest
change due
```

Example:

```text
Remaining due: $18.50
Cash tip:       $1.00
Guest gives:   $20.00
Applied:       $18.50
Change:         $0.50
```

Require `received_amount >= amount_applied + tip_amount`. Change is `received_amount - amount_applied - tip_amount`.

---

## 18. Cash Overpayment

Cash may exceed the remaining Order amount plus tip because change can be returned. Cash rounding is not performed.

Do not count returned change as revenue/tender applied to the Order.

Conceptually:

```text
cash received = 20.00
amount applied = 18.00
cash tip = 1.00
change due = 1.00
```

Settlement reconciliation uses the Order amount applied, not gross cash handed over or the separate tip.

---

## 19. Card Tender

An `EXTERNAL_CARD` Tender records an amount reported as processed externally. This application does not process the card.

Safe recorded fields, when available:

```text
amount applied to the Order
optional tip amount, recorded separately
provider/reference
brand
last4
authorization/reference
processed_at
```

Do not permit the Order amount applied to exceed the remaining Order balance. The separate tip does not increase the Order obligation.

---

## 20. Multiple Tenders

Support multiple successful tenders per Settlement.

Example:

```text
Order amount: $75.00
Cash applied: $25.00
Card applied: $50.00
Remaining:     $0.00
```

Settlement remains OPEN until exact reconciliation succeeds.

Do not require all tenders to be the same type.

---

## 21. Split Tender vs Split Check

Support split tender within one Order using multiple Tender records inside its one OPEN Settlement.

Do not move or reassign submitted Order Items between Orders.

The existing architecture already supports multiple Orders per Table Session, which provides a clean foundation for separate checks.


---

## 22. Tip Policy

Approved model:

- Tip is recorded at Tender time for `CASH` and `EXTERNAL_CARD` only.
- Tip does not change Phase 9 Menu Item prices or discounts.
- Tip is separate from the pre-tip Order amount due.
- Tender reconciliation distinguishes applied Order amount from tip. Cash change is calculated after both the amount applied and cash tip.
- Tip uses exact cents and cannot be negative.

Do not allocate tips to Employees/payroll in Phase 11 unless explicitly required.

---

## 23. Settlement Reconciliation

Centralize exact settlement math.

For the Order obligation:

```text
remaining_order_amount
= order_amount_snapshot
- sum(active successful tender amounts applied to Order)
```

Completion requires:

```text
remaining_order_amount == 0.00
```

Tips are not part of Order-obligation reconciliation. They are separate nonnegative exact values and are permitted only for `CASH` and `EXTERNAL_CARD`.

Do not close on approximate/e‑psilon floating-point comparisons.

---

## 24. Exact Money Arithmetic

Reuse the Phase 9 integer minor-unit/BigInt money functions.

All customer-facing monetary amounts must reconcile exactly to cents.

PostgreSQL authoritative storage remains fixed-precision `NUMERIC`/decimal strings according to existing conventions.

Do not introduce JS floating-point monetary arithmetic.

---

## 25. Settlement Completion Transaction

Completing a Settlement is a critical transaction.

Conceptually:

```text
BEGIN
Lock Settlement
Lock/recheck Order
Validate Settlement OPEN
Validate Order OPEN
Recompute tender reconciliation
Validate exact amount due == 0
Mark Settlement COMPLETED
Mark Order CLOSED
Append Order status history
COMMIT
```

Do not allow Settlement COMPLETED while Order remains accidentally OPEN because of partial persistence.

---

## 26. Order Closure

Phase 11 owns:

```text
Order OPEN -> CLOSED
```

Requirements:

- Settlement successfully COMPLETED, or
- explicitly approved zero-balance/fully-comped closure path.

Do not expose a generic manual `close Order` operation that bypasses financial reconciliation.

`VOIDED` remains the separate Phase 9 commercial cancellation path.

---

## 27. Zero-Balance / Fully-Comped Orders

A 100% comp may produce:

```text
Order amount due = $0.00
```

Approved policy: permit an authorized zero-amount Settlement completion without a Tender.

Record the Settlement and closure provenance so the Order did not simply disappear as financially unresolved.


---

## 28. Settlement Idempotency

All tender-recording and Settlement-completion commands must support safe retries.

A repeated idempotency key must not:

- duplicate tender amount,
- duplicate tip,
- close the Order twice,
- append duplicate status history.

Use database constraints plus transaction checks.

---

## 29. Settlement Concurrency

Protect against two terminals/users trying to settle the same Order simultaneously.

Required scenario:

```text
Terminal A sees $50 due
Terminal B sees $50 due
A records $50
B attempts another $50
```

The second operation must recheck current locked Settlement state and reject/return a conflict rather than over-settle.

---

## 30. Tender Void Before Completion

Permit an explicit Tender void only while Settlement is `OPEN`.

Require:

```text
permission
reason
actor
timestamp
```

Voided tender stops contributing to reconciliation.

Do not physically delete the tender row.

For externally handled Tender types, the void is an application-record correction only. Do not claim an external financial reversal occurred.

---

## 31. Completed Settlement Corrections

Do not allow normal tender editing/void after Settlement is COMPLETED.

Refunds, post-completion reversals, and historical sale mutation are deferred from Phase 11.

---

## 32. Closed Order Reopen

Approved policy:

```text
CLOSED Orders cannot be reopened in Phase 11.
```

Corrections after closure must be handled by an explicit later refund/correction workflow rather than mutating historical sale/Settlement state.

Future post-close changes require a separately approved Refund/Correction workflow.

---

## 33. Table Session Completion After Settlement

Once an Order closes, determine whether its Table Session still has any associated OPEN Orders.

If yes:

```text
leave Table Session ACTIVE
```

If no:

the existing authorized explicit physical Table Session completion action remains required.

Do not automatically mark guests gone or tables DIRTY merely because the final check was paid.

This preserves the distinction between financial closure and physical departure.

---

## 34. Optional Auto-Completion Decision

Approved behavior:

```text
Final Order settlement removes the OPEN-Order guard,
but does not automatically complete the Table Session.
```

Host/server then completes the Table Session when guests actually leave.

Only the existing explicit physical completion workflow marks used tables DIRTY.

---

## 35. Takeout Closure

Takeout has no Table Session.

```text
TAKEOUT Order OPEN
  -> Settlement COMPLETED
  -> Order CLOSED
```

Fulfillment may complete before or after Settlement. Settlement does not require or alter fulfillment.

Do not create fake physical seating.

---

## 36. Settlement and Fulfillment Independence

Settlement and fulfillment are separate operational dimensions.

Approved policy:

- Settlement may complete while fulfillment is unfinished.
- Fulfillment completion does not settle the Order.
- Order closure via Settlement does not change fulfillment or cancel work.

---

## 37. Discounts

Use Phase 9 applied discount snapshots exactly.

Do not re-evaluate current discount definitions during Settlement.

Settlement receives the resulting historical Order amount.

Do not change Item/Order discounts simply to make tenders reconcile.

---

## 38. Tax Boundary

Tax is deferred:

- Settlement amount is based on the Phase 9 post-discount amount.
- UI should not claim tax was calculated.
- Documentation must state tax is intentionally outside the POC settlement calculation.

Do not introduce tax calculation during Phase 11.

---

## 39. Settlement Status History

Create append-oriented history if needed for state transitions:

```text
settlement_status_history
```

Conceptual fields:

```text
id                   UUID PK
settlement_id        UUID FK
status               required
reason               nullable
changed_by_user_id   UUID FK
occurred_at          TIMESTAMPTZ
created_at           TIMESTAMPTZ
```

Do not use generic Audit as a replacement for domain lifecycle history.

---

## 40. Tender Provenance and Security

Persist:

- recorder User
- timestamps
- safe external references
- status
- void reason/actor when applicable

Never log raw card secrets.

Ensure application logs/error payloads do not accidentally include sensitive tender input.

---

## 41. Payment Permissions

Use/extend central RBAC without synonyms.

Expected concepts include:

```text
settlements.view
settlements.create
settlements.tender.cash
settlements.tender.external-card
settlements.tender.gift-card
settlements.tender.house-account
settlements.tender.other
settlements.complete
settlements.void-tender
settlements.view-card-metadata
```

Exact codes should follow the repository's naming conventions.

Do not grant manager-level correction permissions to every Server/Bartender automatically.

---

## 42. Order/Location Scope

Settlement actions require authorization at the Order's Location.

Servers/Bartenders may settle appropriate Orders according to existing Order scope rules if granted tender permissions.

Managers may have broader Location view/manage capabilities.

Do not derive application authorization solely from Employee Position.

---

## 43. Cash Permission

Cash recording has its own permission, separate from every other tender type.

This preserves future ability to restrict tender types by role or terminal.

Do not assume every user who can view an Order can record money.

---

## 44. Card Metadata Visibility

Safe card metadata such as brand/last4 may still be restricted to users who need it.

Do not return provider references or card metadata in broad public/operational APIs unnecessarily.

---

## 45. Settlement UI

Create a responsive settlement workspace from an Order.

Display:

```text
Order number
Order type
Table context if dine-in
submitted/voided Items summary
item/order discount summary
Order amount
successful tenders
remaining amount
Tip as a separate exact amount, permitted only for CASH and EXTERNAL_CARD
cash received/change where applicable
```

Do not expose Recipe/Inventory internals.

---

## 46. Cash UI

Support:

```text
remaining due
cash received
amount applied
change due
```

Use exact money formatting and validation.

Do not let client-side calculations be authoritative.

---

## 47. External Card UI

Record only approved safe metadata.

Clearly label card as externally processed/recorded if there is no real provider integration.

Do not present a fake card-number entry form that implies this application securely processes cards.

---

## 48. Multiple Tender UI

Allow staff to add tenders until:

```text
remaining order amount == 0
```

Show each tender separately with amount/status.

Before Settlement completion, authorized users may void a mistaken tender with reason according to policy.

---

## 49. Comped Order UI

For a zero-balance Order, permit authorized user to complete a zero-amount Settlement without adding a fake $0 tender.

Display that discounts/comps reduced the amount due to zero.

---

## 50. Settlement Query Models

Create purpose-built DTOs for:

```text
Settlement summary
Settlement detail
Tender detail with safe metadata
Order settlement eligibility
Remaining amount
```

Do not expose full internal provider payloads.

Do not include sensitive data that was never supposed to be persisted.

---

## 51. Business Date

Persist Settlement/Tender business dates where required using BusinessDateService.

Do not derive business date by truncating payment timestamps.

Order and Settlement business dates should remain explainably related even for after-midnight restaurant operations.

---

## 52. No Inventory Changes from Settlement

Settlement records money movement, not product movement.

Do not post Inventory transactions when:

- cash tender recorded,
- card tender recorded,
- Settlement completed,
- Order closed.

Phase 9/10 have already established product-consumption behavior.

---

## 53. No Fulfillment Changes from Settlement

Do not automatically alter fulfillment states merely because payment occurred.

A paid Order can still have unfinished preparation if prepayment is allowed.

Fulfillment remains governed by Phase 10.

---

## 54. No New Customer Order Pricing

Settlement must not reprice Order Items.

Historical submitted prices and discounts are immutable.

Settlement reconciles against those committed values.

---

## 55. Failure Atomicity

Test deliberate failure between Settlement completion and Order closure.

Required invariant:

```text
Settlement COMPLETED
and
Order CLOSED
```

must commit together.

If the transaction fails, neither terminal transition remains partially committed.

---

## 56. Unit Tests: Exact Settlement Math

Test:

```text
single tender exact payment
multiple tenders exact payment
remaining amount
cash change
zero amount Order
discounted Order amount
no floating-point drift
```

---

## 57. Unit Tests: Cash

Test:

```text
exact cash
cash overpayment/change
insufficient cash handling according to tender semantics
negative cash rejected
change exact
```

---

## 58. Unit Tests: External Card

Test:

```text
record approved tender
failed attempt excluded from reconciliation
safe metadata
invalid last4/metadata validation if enforced
no raw PAN/CVV fields
```

---

## 59. Unit Tests: Reconciliation

Test:

```text
underpayment -> cannot complete
over-applied non-cash -> rejected
mixed cash/card -> exact completion
voided tender -> removed from active sum
zero-balance comp -> completion without tender
```

---

## 60. Unit Tests: Lifecycle

Test:

```text
Settlement OPEN -> COMPLETED
Settlement OPEN -> CANCELLED
COMPLETED immutable
Order OPEN -> CLOSED only through approved Settlement path
VOIDED Order cannot settle
```

---

## 61. Integration Tests: Create Settlement

Test:

```text
eligible OPEN Order
one active Settlement per Order
wrong Location denied
VOIDED Order denied
stale version/concurrency
Order amount snapshot exact
```

---

## 62. Integration Tests: Multiple Tenders

Test:

```text
$75 Order
$25 cash applied
$50 external card
Settlement completes
Order closes
```

Verify tender history remains separate.

---

## 63. Integration Tests: Cash Change

Test:

```text
Order remaining 18.50
cash received 20.00
applied 18.50
change 1.50
```

Settlement reconciles using 18.50.

---

## 64. Integration Tests: Failed Card

Test a manually reported external failure:

```text
failed EXTERNAL_CARD attempt reported from an actual external/manual process
 -> retained in history
 -> contributes 0 to reconciliation
 -> Order remains OPEN
```

No fake provider networking required.

---

## 65. Integration Tests: Settlement Concurrency

Required high-value test:

```text
Two clients attempt final payment concurrently
        |
        v
exactly one can consume the remaining obligation
no over-settlement
Order closes once
```

Use locks/version/idempotency constraints.

---

## 66. Integration Tests: Tender Retry

Use identical idempotency key twice.

Verify:

```text
one tender record
one applied value
no duplicated financial amount
```

---

## 67. Integration Tests: Comped Order

Test a Phase 9 100%-discount Order:

```text
amount due 0.00
Settlement completes without fake tender
Order CLOSED
```

Preserve discount snapshots.

---

## 68. Integration Tests: Dine-In Closure

Test:

```text
Table Session
 + Order A OPEN
 + Order B OPEN

Settle A -> CLOSED
Table Session still blocked by B

Settle B -> CLOSED
OPEN-order guard gone
Table Session still remains ACTIVE until existing explicit completion action
```

Then complete Table Session using Phase 5 workflow and verify tables become DIRTY.

---

## 69. Integration Tests: Takeout

Test:

```text
TAKEOUT Order OPEN
 -> cash/card/multiple tender
 -> Settlement COMPLETED
 -> Order CLOSED
 -> no Table Session created
```

---

## 70. Integration Tests: Fulfillment Independence

## 70. Integration Tests: Fulfillment Independence
Test that Settlement does not modify Phase 10 fulfillment state.

Order closure and fulfillment history remain independently correct.

---

## 71. Authorization Integration Tests

Test directly:

```text
settlements.view
settlements.create
cash tender permission
EXTERNAL_CARD tender permission
settlements.complete
tender void permission
Location scope
unauthorized direct API denied
```

Do not rely on disabled UI controls.

---

## 72. E2E: Dine-In Cash Settlement

Playwright scenario:

```text
Open dine-in Order
 -> Settlement
 -> record cash
 -> verify change if any
 -> complete Settlement
 -> Order CLOSED
 -> Table Session completion now allowed when all associated Orders closed
```

---

## 73. E2E: Mixed Tender

Scenario:

```text
Order amount
 -> partial Cash
 -> remaining EXTERNAL_CARD
 -> complete Settlement
 -> Order CLOSED
```

---

## 74. E2E: Comped Order

Scenario:

```text
100% discounted Order
 -> zero-balance Settlement
 -> close without tender
```

---

## 75. E2E: Takeout Settlement

Scenario:

```text
Takeout Order
 -> Settlement
 -> complete
 -> CLOSED
 -> no table/session lifecycle
```

---

## 76. E2E: Authorization

Representative scenario:

```text
view-only user
 -> can see Settlement
 -> cannot record tender/complete
```

Verify direct API denial.

---

## 77. E2E: Card Safety

Verify UI/API does not request or expose raw card PAN/CVV.

Only approved safe external-payment metadata may be entered/displayed.

---

## 78. Migrations

Generate and review Phase 11 migration(s), including the forward-only rename from `settlements` to the README-defined `order_settlements` physical table.

Verify:

```text
Existing Phase 10 DB
 -> Phase 11 migration(s)
 -> success
```

and:

```text
Empty isolated DB
 -> Phase 1-11 migration chain
 -> expected schema
```

Second `db:generate` must report no unexplained drift.

Do not rewrite historical migrations.

---

## 79. Seeds

Do not seed fake financial Settlement/Tender history as stable development configuration.

Use test/E2E fixtures for financial operations.

Phase 11 seeds may update:

```text
permissions
role grants
stable payment configuration if explicitly approved
```

Seed must remain idempotent.

---

## 80. Reset Regression

Use established disposable/safe DB lifecycle.

Verify complete Phase 1-11 schema reconstruction and seed idempotency.

Do not weaken production/remote reset guards.

---

## 81. Prior-Phase Regression

Preserve:

```text
Phase 9 exact Order snapshots
Phase 9 discount snapshots
Phase 9 Order void behavior
Phase 10 fulfillment lifecycle
Phase 10 remake behavior
Phase 8 Inventory ledger
Table Session OPEN-order guard
Takeout no-table model
```

Settlement must not mutate those completed-domain histories.

---

## 82. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Do not add a payment SDK unless a real provider integration is explicitly approved.

Production dependencies must remain clean or new findings require review.

Preserve DEV-001 unless intentionally reevaluated.

---

## 83. Documentation Updates

Document:

- Settlement vs Order boundary
- Settlement vs Tender boundary
- lifecycle states
- supported tender types
- exact reconciliation
- cash received/applied/change
- safe external-card metadata
- explicit no-PAN/no-CVV rule
- multiple-tender behavior
- tip policy: separate exact tip allowed only on CASH and EXTERNAL_CARD
- tax policy: deferred; use the Phase 9 post-discount pre-tax amount
- zero-balance comp closure
- tender idempotency
- concurrency protection
- Order closure
- Table Session financial-to-physical completion boundary
- Takeout closure
- refund/reopen deferral or approved behavior

---

## 84. Validation Checklist

Run:

```text
docker compose up -d
docker compose ps
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:seed
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
npm audit --omit=dev
```

Use isolated disposable DB for destructive reconstruction testing.

Verify:

```text
PostgreSQL health                   PASS
/api/health                         PASS
migration generation                PASS
migration application               PASS
empty DB reconstruction             PASS
schema drift                        NONE
seed idempotency                    PASS
Settlement lifecycle                PASS
Tender lifecycle                    PASS
Cash tender                         PASS
External-card safe metadata         PASS
Multiple tenders                    PASS
Exact remaining amount              PASS
Cash change                         PASS
Tip policy                          PASS / CASH and EXTERNAL_CARD only
Tax policy                          PASS / explicitly deferred
Tender idempotency                  PASS
Settlement concurrency              PASS
Zero-balance comp                   PASS
Order OPEN -> CLOSED                PASS
Table Session guard interaction     PASS
Takeout closure                     PASS
No Inventory movement               PASS
Fulfillment independence            PASS
Authorization                       PASS
prior-phase regressions             PASS
production dependency audit         CLEAN
```

---

## 85. Deliverables

Phase 11 should leave:

```text
✓ settlements
✓ settlement_tenders
✓ settlement_status_history if required

✓ exact Order amount snapshot
✓ CASH tender
✓ EXTERNAL_CARD safe record
✓ multiple tenders
✓ exact remaining amount
✓ exact cash change
✓ tips separate from the obligation, CASH/EXTERNAL_CARD only
✓ zero-balance comp path
✓ tender idempotency
✓ Settlement completion idempotency
✓ concurrency protection

✓ Order OPEN -> CLOSED through Settlement
✓ no generic close bypass
✓ Dine-in OPEN-order guard resolves after all Orders close
✓ explicit Table Session completion remains physical departure action
✓ Takeout settlement/closure

✓ no raw PAN/CVV storage
✓ no fake payment-gateway processing
✓ Settlement RBAC
✓ responsive Settlement UI

✓ unit tests
✓ PostgreSQL integration/concurrency tests
✓ Playwright tests
✓ Phase 0-10 regressions green
✓ production audit clean
```

---

## 86. Definition of Done

Phase 11 is complete when the system demonstrates:

```text
DINE_IN Order OPEN
   -> Settlement
   -> one or more tenders
   -> exact reconciliation
   -> Settlement COMPLETED
   -> Order CLOSED
```

and:

```text
Multiple Orders on Table Session
   -> close independently
   -> Table Session remains blocked while any Order OPEN
   -> after all CLOSED, host/server may complete Table Session
   -> tables become DIRTY
```

and:

```text
TAKEOUT Order OPEN
   -> Settlement
   -> CLOSED
   -> no Table Session
```

The system proves:

- Settlement and Tender are separate entities.
- Multiple tenders are supported.
- Cash overpayment is represented as change, not extra applied revenue.
- External-card recording stores no prohibited raw card secrets.
- Exact money arithmetic is used throughout.
- Retry/concurrency cannot duplicate tender value or over-settle an Order.
- Order closes only through approved Settlement/zero-balance financial reconciliation.
- Settlement does not change Inventory or fulfillment history.
- Table Session completion remains a physical operational action after financial blockers are removed.
- No historical Order price/discount snapshot is recalculated.
- Database reconstruction requires no manual SQL.
- Prior phases remain green.

Phase 11 is not complete if a generic Order-close API can bypass Settlement reconciliation.

Phase 11 is not complete if raw PAN/CVV is persisted.

Phase 11 is not complete if concurrent tenders can over-settle the same Order.

---

## 87. Required Phase 11 Completion Report

Provide:

```text
PHASE 11 COMPLETION REPORT

Environment
- Node:
- npm:
- Next.js:
- PostgreSQL:
- Drizzle ORM:
- Drizzle Kit:
- Exact money arithmetic:

Settlement Schema
- order_settlements physical table: PASS / FAIL
- settlement_tenders: PASS / FAIL
- settlement_status_history: PASS / FAIL / N/A

Policies
- Tax policy: describe
- Tip policy: describe
- Tender types: describe
- Refund policy: describe / deferred
- Closed Order reopen: describe / deferred
- Table Session auto-completion: describe

Settlement
- One active Settlement/Order: PASS / FAIL
- Order amount snapshot: PASS / FAIL
- OPEN lifecycle: PASS / FAIL
- COMPLETED lifecycle: PASS / FAIL
- CANCELLED lifecycle: PASS / FAIL
- Exact reconciliation: PASS / FAIL
- Completion atomic with Order close: PASS / FAIL
- Idempotent completion: PASS / FAIL

Tenders
- CASH: PASS / FAIL
- EXTERNAL_CARD: PASS / FAIL
- GIFT_CARD: PASS / FAIL
- HOUSE_ACCOUNT: PASS / FAIL
- OTHER description/reason: PASS / FAIL
- Multiple tenders: PASS / FAIL
- Cash received/applied/change: PASS / FAIL
- Failed tender history: PASS / FAIL / N/A
- Tender void before completion: PASS / FAIL / N/A
- Tender idempotency: PASS / FAIL
- Concurrent over-settlement prevented: PASS / FAIL

Security
- No PAN storage: PASS / FAIL
- No CVV storage: PASS / FAIL
- Safe card metadata only: PASS / FAIL
- Logs/errors exclude prohibited card data: PASS / FAIL

Money
- BigInt/minor-unit arithmetic: PASS / FAIL
- Discount snapshots reused: PASS / FAIL
- Zero-balance comp: PASS / FAIL
- Tax arithmetic: PASS / FAIL / deferred
- Tip arithmetic: PASS / FAIL / N/A

Order Closure
- OPEN -> CLOSED via Settlement: PASS / FAIL
- Generic close bypass absent: PASS / FAIL
- VOIDED Order cannot settle: PASS / FAIL
- CLOSED immutable/no reopen: PASS / FAIL

Table Session
- One OPEN Order keeps completion blocked: PASS / FAIL
- All Orders CLOSED removes financial guard: PASS / FAIL
- Settlement does not auto-dirty tables unless approved: PASS / FAIL
- Existing explicit completion makes tables DIRTY: PASS / FAIL

Takeout
- No Table Session required: PASS / FAIL
- Settlement -> Order CLOSED: PASS / FAIL

Authorization
- settlements.view: PASS / FAIL
- create permission: PASS / FAIL
- cash tender permission: PASS / FAIL
- external-card tender permission: PASS / FAIL
- gift-card tender permission: PASS / FAIL
- house-account tender permission: PASS / FAIL
- other tender permission: PASS / FAIL
- complete permission: PASS / FAIL
- tender void permission: PASS / FAIL / N/A
- Location scope: PASS / FAIL
- direct unauthorized API denied: PASS / FAIL

Boundaries
- No Inventory transactions from Settlement: PASS / FAIL
- Fulfillment unchanged by Settlement: PASS / FAIL
- Order snapshots unchanged: PASS / FAIL
- No payment gateway falsely implemented: PASS / FAIL

Migrations
- Generation: PASS / FAIL
- Application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Regression
- Phase 1 foundation: PASS / FAIL
- Phase 2 Auth/RBAC: PASS / FAIL
- Phase 3 Employees/HR: PASS / FAIL
- Phase 4 Scheduling: PASS / FAIL
- Phase 5 Restaurant/Seating: PASS / FAIL
- Phase 6 Reservations/Waitlist: PASS / FAIL
- Phase 7 Menu/Recipes: PASS / FAIL
- Phase 8 Inventory/Purchasing: PASS / FAIL
- Phase 9 Orders: PASS / FAIL
- Phase 10 Kitchen/Bar Fulfillment: PASS / FAIL
- db:reset safeguards: PASS / FAIL
- /api/health: PASS / FAIL

Validation
- npm ci: PASS / FAIL
- lint: PASS / FAIL
- typecheck: PASS / FAIL
- unit tests: PASS / FAIL
- integration tests: PASS / FAIL
- E2E tests: PASS / FAIL
- production build: PASS / FAIL
- npm audit --omit=dev: PASS / FAIL

Accepted Risks
- DEV-001: unchanged / updated / resolved

Business Domains Created Beyond Phase 11
- NONE expected

Created / Modified
- Summarize schema, migrations, Settlement/Tender services, Order/Table Session integration, permissions, UI, tests, seeds, and documentation.

Architecture Deviations
- None / describe

Outstanding Phase 11 Issues
- None / describe and blocking status

Next-Phase Readiness
- READY / NOT READY
```

---

## 88. VS Code Copilot Prompt

After placing this file at `docs/Phase-11-Settlement-Payments.md`, start a fresh Copilot chat and use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 11 implementation plans completely. Review all completed Phase 0 through Phase 10 completion reports. Treat `README.md` as the architectural source of truth and derive current state from source, migrations, tests, and committed documentation rather than prior chat history.
>
> Review the current repository before modifying files. Implement Phase 11 only: Settlement & Payments, including Settlement/Tender records, exact reconciliation, the approved `CASH`, `EXTERNAL_CARD`, `GIFT_CARD`, `HOUSE_ACCOUNT`, and `OTHER` recorded tender types, multiple tenders, approved tips, cash change, zero-balance comp closure, idempotency/concurrency, Order `OPEN -> CLOSED` through successful Settlement, Table Session financial-guard integration, Takeout closure, RBAC, responsive UI, migrations, tests, and documentation.
>
> Preserve these boundaries: Settlement is separate from Order; Tender is separate from Settlement; no raw PAN/CVV/track data may be persisted; do not pretend external card processing occurred if no provider integration exists; Settlement does not change Inventory or fulfillment; Phase 9 price/discount snapshots remain immutable; Phase 10 fulfillment completion does not close Orders; Table Session completion remains a physical operation after all associated Orders are CLOSED.
>
> Preserve exact money arithmetic, BusinessDateService, Phase 1 transaction/migration/test architecture, Phase 2 RBAC, Phase 3 HR boundaries, Phase 4 Scheduling, Phase 5 Seating, Phase 6 Reservations/Waitlist, Phase 7 Menu/Recipes, Phase 8 Inventory/Purchasing, Phase 9 Orders, Phase 10 Fulfillment, reset safeguards, and DEV-001.
>
> Apply the Approved Phase 11 Policies in this plan without reopening those decisions. Before coding, provide a concise execution plan based on the current repository. If repository evidence reveals a material conflict with an approved policy or README, stop and report it before coding.
>
> After implementation, run the complete Phase 11 validation suite and provide the full Phase 11 Completion Report. Stop before changing approved architecture if a material conflict is discovered.

---

## Final Guardrail

Phase 11 closes the commercial sale without corrupting the operational histories established in previous phases.

```text
Order OPEN
    |
    v
Settlement + Tenders
    |
    v
Exact Financial Reconciliation
    |
    v
Order CLOSED
    |
    +-- Dine-in: financial blocker removed; physical Table Session completes separately
    |
    +-- Takeout: no Table Session
```

Do not collapse pricing, fulfillment, Inventory, payment security, Order closure, and physical table turnover into one operation for implementation convenience.
