# Phase 9: Orders Implementation Plan

## Purpose

Phase 9 implements restaurant Order entry and submission. It connects Phase 5 Table Sessions, Phase 6 Guest Parties, Phase 7 Menu/Pricing/Modifiers/Recipe revisions, and Phase 8 Inventory consumption without prematurely implementing Kitchen/Bar fulfillment or Settlements.

Before starting, read completely:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 8 implementation plans
5. This document

`README.md` remains the architectural source of truth.

Derive current application state from source, migrations, tests, and committed documentation rather than assumptions from previous Copilot conversations.

---

## 1. Phase 9 Objectives

Implement the Order domain:

```text
Table Session / Takeout Context
        |
        v
      Order
        |
        +-- Order Items
        |      |
        |      +-- Menu snapshots
        |      +-- Price snapshots
        |      +-- Modifier selections/snapshots
        |      +-- Recipe revision reference/snapshot
        |
        +-- Status History
        |
        +-- Submission
               |
               +-- Validate Menu/Modifiers/Price
               +-- Resolve Recipe revisions
               +-- Apply Modifier inventory effects
               +-- Post Inventory CONSUME transactions
               |
               +-- Phase 10 later: Kitchen/Bar fulfillment
```

Phase 9 must deliver:

- Dining-room/bar Orders associated with Table Sessions
- Takeout Orders without fake physical tables
- Order lifecycle
- Order Item lifecycle
- Menu Item and monetary snapshots
- Modifier selection snapshots
- Server-side modifier validation
- Exact pricing calculation
- Draft editing
- Incremental submission rounds with deterministic, idempotent send batches
- Inventory consumption on submission
- Recipe-revision-aware consumption
- Modifier ADD/REMOVE/ADJUST consumption effects
- Submitted-item void workflow with compensating Inventory transactions
- Order and item status history
- Order-entry authorization
- Responsive operational Order UI
- Unit, PostgreSQL integration, concurrency, and Playwright tests

---

## 2. Scope Boundary

Do not implement during Phase 9:

```text
Kitchen tickets
Bar tickets
KDS screens
real-time preparation workflow
item firing/ready states owned by fulfillment
payment tenders
credit-card processing
settlements
split payment
cash drawer
refund settlement
receipts/fiscal printing
full tax engine unless explicitly required by README for Order totals
full reporting
customer loyalty
online ordering integrations
third-party delivery integrations
```

Phase 10 owns Kitchen/Bar fulfillment.

Phase 11 owns Settlements.

Do not create payment records or mark an Order paid.

---

## 3. Critical Boundary: Order References Table Session, Not Physical Table

Dining/bar Orders associate with the Phase 5 Table Session.

```text
Physical Table(s)
       |
       v
Table Session
       |
       +-- Order 1
       +-- Order 2
       +-- Order 3
```

Do not add an Order-to-`restaurant_tables` foreign key.

This preserves:

- Combined tables
- Moved parties
- Server reassignment
- Future split checks
- Multiple Orders for one Table Session

---

## 4. Critical Boundary: Takeout Is Not a Physical Table

Takeout Orders must not create a fake Restaurant Table or fake Table Session solely to satisfy a schema relationship.

Use an explicit Order service/context model.

Recommended concept:

```text
order_type
- DINE_IN
- TAKEOUT
```

For `DINE_IN`:

```text
table_session_id required
```

For `TAKEOUT`:

```text
table_session_id null
location_id required
```

If README already defines a different canonical Order service model, README wins.

---

## 5. Critical Boundary: Menu Configuration vs Historical Order Snapshot

Historical Orders must not change when Menu configuration changes.

At the time an Order Item is committed/submitted, preserve the relevant selling facts.

Conceptually snapshot:

```text
Menu Item ID
Menu Item code
Menu Item name
base unit price
selected Modifiers
Modifier names
Modifier price adjustments
calculated unit price
quantity
line total
Recipe revision used for consumption
```

Do not display historical Orders by re-resolving today's Menu Item name, price, or Modifier prices.

---

## 6. Critical Boundary: Recipe Configuration vs Inventory Consumption

Recipe/Modifier configuration describes required consumption.

Actual Inventory movement occurs through Phase 8 Inventory posting.

```text
Recipe Version + Modifier Effects
        |
        v
Consumption Plan
        |
        v
Phase 8 postInventoryTransaction(... CONSUME ...)
```

Do not modify `inventory_balances` directly from Orders.

Do not duplicate the Phase 8 negative-inventory or costing logic inside the Order domain.

---

## 7. Review Existing Foundation Before Changes

Before editing, inspect and confirm:

- Phase 0 through Phase 8 validation remains green.
- README Order lifecycle/state terminology is identified.
- Phase 5 Table Session lifecycle is understood.
- Phase 6 Guest Party linkage is understood.
- Phase 7 operational Menu query and exact pricing helpers are understood.
- Modifier selection validator is understood.
- Recipe effective revision resolution is understood.
- Phase 8 Recipe Version Ingredients and Modifier Inventory Effects are understood.
- Phase 8 Inventory posting/negative-stock rules are understood.
- BusinessDateService is understood.
- Existing transaction context is understood.
- Existing location-aware RBAC is understood.
- Seed/test/reset infrastructure remains intact.
- No Kitchen/Settlement domain exists yet.
- DEV-001 remains tracked.

Before coding, provide a concise Phase 9 execution plan based on actual repository state.

---

## 8. Order Service Types

Use README terminology where present.

At minimum the implementation must distinguish:

```text
DINE_IN
TAKEOUT
```

Future service modes such as delivery may be added later deliberately.

Do not infer service type from whether a physical table happens to exist.

---

## 9. Orders

Create:

```text
orders
```

Conceptual fields:

```text
id                    UUID PK
location_id           UUID FK
table_session_id      UUID nullable FK
guest_party_id        UUID nullable FK
order_type            required
status                required
order_number          required
opened_by_employee_id UUID nullable FK
opened_by_user_id     UUID FK
assigned_server_employee_id UUID nullable FK
business_date         DATE required
opened_at             TIMESTAMPTZ required
submitted_at          TIMESTAMPTZ nullable
closed_at             TIMESTAMPTZ nullable
voided_at             TIMESTAMPTZ nullable
voided_by_user_id     UUID nullable FK
void_reason           nullable
subtotal              NUMERIC(12,2) required default 0.00
version               INTEGER default 1
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
```

Use README fields/state names if they differ.

Do not place settlement/payment state in this table beyond any lifecycle field explicitly required for Phase 9.

---

## 10. Order Number

Generate a human-usable Order number/code scoped appropriately by Location/business date.

The database UUID remains the technical identity.

Avoid a process that can generate duplicate display Order numbers under concurrency.

Do not use Order number as the primary key.

---

## 11. Order Lifecycle

Approved Phase 9 lifecycle states (2026-10-08):

```text
Orders:      OPEN -> CLOSED (Phase 11 only) or VOIDED
Order Items: DRAFT -> SUBMITTED -> VOIDED
```

Orders remain OPEN through all Phase 9 send batches. Sending Items never closes an Order. Phase 9 has no settlement-free close operation; `CLOSED` is reserved for Phase 11. A Table Session cannot be completed while any associated Order remains OPEN.

---

## 12. Order Status History

Create:

```text
order_status_history
```

Conceptual fields:

```text
id                  UUID PK
order_id            UUID FK
status              required
reason              nullable
changed_by_user_id  UUID nullable FK
occurred_at         TIMESTAMPTZ
created_at          TIMESTAMPTZ
```

Treat as append-oriented domain history.

Lifecycle commands update current status and append history atomically.

---

## 13. Order Items

Create:

```text
order_items
```

Conceptual fields:

```text
id                       UUID PK
order_id                 UUID FK
menu_item_id             UUID FK
recipe_version_id        UUID nullable FK
status                   required
quantity                 integer or exact quantity according to README
menu_item_code_snapshot  required
menu_item_name_snapshot  required
base_price_snapshot      NUMERIC(12,2) required
modifier_total_snapshot  NUMERIC(12,2) required
unit_price_snapshot      NUMERIC(12,2) required
line_total_snapshot      NUMERIC(12,2) required
special_instructions     nullable
added_by_user_id         UUID FK
submitted_at             TIMESTAMPTZ nullable
voided_at                TIMESTAMPTZ nullable
voided_by_user_id        UUID nullable FK
void_reason              nullable
created_at               TIMESTAMPTZ
updated_at               TIMESTAMPTZ
version                  INTEGER default 1
```

Use exact money handling.

Order Item quantity should be positive.

---

## 14. Order Item Status History

Create:

```text
order_item_status_history
```

Conceptual fields:

```text
id                  UUID PK
order_item_id       UUID FK
status              required
reason              nullable
changed_by_user_id  UUID nullable FK
occurred_at         TIMESTAMPTZ
created_at          TIMESTAMPTZ
```

Phase 10 may later extend fulfillment-specific status transitions.

Do not prematurely model Kitchen-specific states if README reserves them for Phase 10.

---

## 15. Order Item Modifiers

Create:

```text
order_item_modifiers
```

Conceptual fields:

```text
id                         UUID PK
order_item_id              UUID FK
modifier_group_id          UUID FK
modifier_id                UUID FK
modifier_group_name_snapshot required
modifier_code_snapshot     required
modifier_name_snapshot     required
price_adjustment_snapshot  NUMERIC(12,2) required
created_at                 TIMESTAMPTZ
```

Selection rows are historical snapshots.

Do not resolve historical modifier name/price from current Modifier configuration.

---

## 16. Draft Order Creation

Create an explicit authorized workflow.

For DINE_IN:

```text
Validate active Table Session
Validate Location
Resolve assigned server/context
Create Order
Append initial status history
```

For TAKEOUT:

```text
Validate Location
No physical table/session required
Create Order with TAKEOUT type
Append initial status history
```

Do not create Inventory movement at Order creation.

---

## 17. Table Session Order Rules

For DINE_IN Orders:

- Table Session must belong to the same Location.
- Table Session must be in a state that allows Order activity.
- Completing a Table Session may later require all Orders to be in an allowed terminal state.
- Phase 9 should add the necessary Table Session completion precondition only if README/order lifecycle makes it definitive.

Do not alter Phase 5 occupancy behavior merely because an Order exists.

---

## 18. Guest Party Linkage

Where a DINE_IN Order references a Table Session already linked to a Guest Party, Order guest context should derive consistently from that relationship.

Do not create conflicting guest identity links.

Takeout may optionally reference a Guest Party if the architecture uses Guest Party for takeout customer context; if README does not establish this, keep Guest Party nullable and do not invent CRM behavior.

---

## 19. Add Order Item Workflow

Adding an item to an editable Order should:

```text
Authorize Order edit
Validate Order editable
Resolve Menu Item through operational Menu query
Resolve current effective exact price for Location/time as a draft preview only
Validate item active/sellable
Validate Modifier selections
Calculate exact price
Resolve applicable Recipe revision for the intended submission semantics
Create Order Item + Modifier snapshots
Recalculate Order subtotal
Increment Order version
```

Do not commit a sale-price snapshot or post Inventory yet. The immutable sale-price snapshot and Inventory consumption are committed at submission time.

---

## 20. Modifier Validation

Reuse the Phase 7 authoritative Modifier selection validator.

Do not implement a separate Order-only interpretation of min/max rules.

Validate:

```text
required group selections
maximum selections
duplicate selection behavior
active Modifier
Modifier attached to Menu Item
item-specific overrides
```

Persist snapshots only after validation succeeds.

---

## 21. Exact Pricing

Reuse Phase 7 exact monetary arithmetic.

Conceptually:

```text
base price
+ modifier adjustments
= exact unit price

unit price * quantity
= exact line total

sum active/non-void line totals
= Order subtotal
```

Do not use JavaScript floating-point arithmetic.

Resolve the approved effective Menu price again at submission time. A Menu price change while the Item is a draft may change its final sale price. Never reprice a submitted Item.

Use exact integer/BigInt minor-unit arithmetic. Item-level discounts apply first, then Order-level discounts against the remaining eligible subtotal. Support `FIXED_AMOUNT` and `PERCENTAGE`; round each percentage calculation with `ROUND_HALF_UP` to two decimal places and cap every discount at its eligible subtotal. A 100% discount is a comp. Persist scope, type, configured value, applied amount, name/reason, and actor provenance as immutable snapshots. Later discount-definition changes do not alter applied history.

Do not calculate tax in Phase 9. Tips, tender, amount due, payment status, and settlement remain Phase 11.

---

## 22. Order Item Editing

Before submission, authorized users may update/remove draft items.

Changing Menu Item/Modifier selections should re-run current validation and snapshot calculation.

Do not mutate a submitted historical snapshot in place to simulate an edit.

Submitted-item modifications require an explicit post-submit workflow such as void/re-add or a new round according to the approved Order policy.

---

## 23. Order Submission Policy

Approved Phase 9 policy:

```text
Inventory consumption occurs when Order Items are SUBMITTED.
```

Not when:

```text
Order created
Item added to draft
Kitchen starts item
Settlement occurs
```

This aligns with the Phase 8 extension contract.

Incremental submission rounds are approved. Each batch processes only currently unsubmitted DRAFT Items. Previously SUBMITTED Items remain unchanged and must never consume Inventory again.

---

## 24. Submission Rounds

Restaurants commonly add items after an initial send.

Phase 9 supports:

```text
A. Incremental submission of new draft Items in multiple rounds
```

Persist deterministic send-batch numbering and an idempotent result snapshot. Only currently unsubmitted Items are processed in each batch.

---

## 25. Order Submissions

Create:

```text
order_submissions
```

Conceptual fields:

```text
id                  UUID PK
order_id            UUID FK
submission_number   integer
submitted_by_user_id UUID FK
submitted_at        TIMESTAMPTZ
created_at          TIMESTAMPTZ
```

Order Items reference the submission that first committed them, directly or through another explicit relation.

A submission is domain history and must not be deleted casually.

---

## 26. Order Submission Transaction

Submission is a critical cross-domain transaction.

Conceptually:

```text
BEGIN
Lock/recheck Order version/status
Load unsubmitted Order Items
Revalidate snapshots/config as required by policy
Resolve Recipe revision for each item
Build Inventory consumption plan
Apply selected Modifier Inventory effects
Validate resulting quantities
Post Phase 8 CONSUME transactions
Mark items submitted
Create submission history
Update Order status/timestamps/subtotal/version
Append histories
COMMIT
```

Any failure rolls back the entire submission round.

Do not leave submitted items without matching Inventory postings, or Inventory consumption without submitted items.

---

## 27. Recipe Revision Resolution at Submission

Use a precise historical rule.

Approved policy:

```text
Recipe revision is resolved at item submission time and then fixed on the Order Item.
```

This prevents a draft item created yesterday from silently consuming against an obsolete/new Recipe without an explicit rule.

Once submitted, the Recipe revision reference/snapshot is immutable.

---

## 28. Missing Recipe Policy

Not every Menu Item requires a Recipe.

Examples:

```text
prepackaged soda
merchandise
non-inventory service item
```

If an item has no effective Recipe, Order submission may proceed without Recipe-derived consumption unless Inventory linkage explicitly requires direct consumption.

Do not invent a fake Recipe solely for every Menu Item.

---

## 29. Inventory Consumption Plan

For each submitted item:

```text
Recipe Version Ingredients
        +
Modifier Inventory Effects
        |
        v
Net Inventory Requirements
        |
        v
Convert to each Inventory Item base stock unit
        |
        v
Multiply by Order Item quantity
```

Consumption quantities use exact decimal arithmetic.

---

## 30. Modifier Consumption Effects

Apply approved semantics:

```text
ADD
REMOVE
ADJUST
```

Substitution remains:

```text
REMOVE old item
ADD new item
```

Effects must be scoped to the Menu Item/Modifier context established in Phase 8.

Do not permit a malformed Modifier effect to consume an unrelated Item.

---

## 31. REMOVE Semantics

A REMOVE effect removes the applicable Recipe requirement for that Inventory Item from the submitted item's consumption plan.

Do not post a positive Inventory transaction for a REMOVE effect.

If the component is absent from the resolved Recipe plan, follow the Phase 8 validation/contract rather than silently creating an inverse quantity.

---

## 32. ADJUST Semantics

ADJUST changes the resolved Recipe requirement by an exact signed amount.

The final net requirement for an Inventory Item must not become negative.

If an adjustment would produce a negative theoretical requirement, reject submission/configuration according to shared validation.

---

## 33. Consumption Transaction Provenance

Every Order-driven `CONSUME` ledger row should include enough provenance to trace it back.

Conceptually:

```text
reference_type = ORDER_ITEM / ORDER_SUBMISSION
reference_id
Order ID accessible through relation/context
```

Use one consistent reference strategy.

Future audit/reporting must be able to connect Inventory consumption to the submitted item.

---

## 34. Negative Inventory

Reuse Phase 8 policy exactly.

```text
allow_negative_inventory = false
 -> CONSUME causing QOH < 0 rejected

allow_negative_inventory = true
 -> authorized CONSUME may go negative
```

Order submission may use the authorized system/domain consumption path, but must not bypass the Location setting.

WASTE/count/manual decrease policies remain unchanged.

---

## 35. Insufficient Inventory Submission Behavior

When negative Inventory is not allowed and one required item lacks stock:

```text
Entire submission round fails atomically.
```

Return structured shortage details appropriate for staff:

```text
Inventory Item
required quantity
available quantity
shortage quantity
```

Do not expose cost unless authorized.

Do not partially submit only the items that happened to have stock unless an explicit future split-submission workflow is approved.

---

## 36. Submitted Item Void

Phase 9 submitted Item void requires `orders.void`, an explicit reason, and physical disposition `UNPREPARED` or `PREPARED_OR_DISCARDED`.

Voiding must preserve Order history.

Do not delete submitted rows.

For `UNPREPARED`, post compensating Inventory transactions through the narrowly scoped trusted Order reversal operation, linked to original Order Item/consumption provenance, then mark the Item VOIDED in the same transaction. For `PREPARED_OR_DISCARDED`, retain the original consumption and do not restore Inventory. Do not create WASTE automatically; record waste separately through the Phase 8 Waste workflow when appropriate.

Conceptually:

```text
Submitted Order Item
      |
      v
Void authorized + reason + disposition
      |
      v
Create compensating Inventory transactions only for UNPREPARED
Mark Item VOIDED
Append status history
Recalculate Order subtotal
COMMIT
```

---

## 37. Inventory Restoration for Voids

Only an `UNPREPARED` submitted-item void reverses the original Order-driven consumption using compensating Inventory postings. `PREPARED_OR_DISCARDED` never restores stock automatically.

Do not delete original `CONSUME` rows.

Use explicit provenance linking each reversal to the original Order Item, submission, and CONSUME transaction. Keep original CONSUME rows immutable. The trusted reversal operation is restricted to Order voids and does not grant `inventory.adjust` or `inventory.receive` to Servers/Bartenders.

---

## 38. Void Before vs After Future Fulfillment

Phase 9 has no Kitchen state yet.

Phase 9 requires the explicit supported disposition. UNPREPARED restores Inventory; PREPARED_OR_DISCARDED retains consumption. Phase 10 may later replace staff-entered disposition with fulfillment-state-aware behavior.

Do not invent Kitchen preparation state now.

---

## 39. Void Entire Order

Support Order void only when lifecycle rules allow it.

A full void should:

```text
void all eligible active submitted Items with an explicit disposition per Item
reverse Inventory only for UNPREPARED Items
mark draft/unsubmitted items VOIDED without Inventory movement
mark Order VOIDED
record actor/reason
append status history
```

Use one transaction.

Do not delete the Order.

---

## 40. Remove Draft Item vs Void Submitted Item

Preserve the distinction:

```text
Draft/unsubmitted item removal
 -> no Inventory restoration needed

Submitted item void
 -> compensation required
```

UI and APIs should use separate operations/terminology.

---

## 41. Order Closure Foundation

Phase 9 does not implement Order closure. Orders remain OPEN unless explicitly VOIDED. Do not provide a settlement-free close command or endpoint. Phase 11 settlement owns `OPEN -> CLOSED`.

---

## 42. Table Session Completion Integration

Phase 5 originally completed Table Sessions without Orders because Orders did not exist.

Phase 9 should now establish a precondition appropriate to the Order lifecycle.

Approved policy:

```text
An active Table Session cannot be completed while any associated Order is OPEN.
```

Phase 9 does not close Orders to unblock Table Session completion. Phase 11 provides settlement-driven Order closure and completes this workflow.

---

## 43. Multiple Orders per Table Session

Allow:

```text
Table Session
  +-- Order A
  +-- Order B
```

Do not enforce one Order per Table Session.

This prepares for:

- Separate checks
- Multiple guests/checks
- Future split settlement

Phase 9 does not implement payment splitting.

---

## 44. Takeout Order Lifecycle

Takeout Order does not require Table Session occupancy.

It must still have:

```text
Location
Order type TAKEOUT
Order items
submission
Inventory consumption
future Phase 10 prep routing
```

Optional Guest Party context may be associated only where existing architecture supports it cleanly.

Do not create a Takeout Table.

---

## 45. Operational Menu Query

Order entry must consume the Phase 7 operational Menu query rather than joining raw configuration tables independently.

This ensures consistent:

```text
active/sellable rules
current effective pricing
Modifier Groups
selection constraints
prep routing
```

Do not recreate Menu price precedence in Order code.

---

## 46. Price Snapshot Timing

Approved policy:

```text
Draft price is preview-only. At Order Item submission, re-resolve the current approved effective Menu price and create the immutable sale-price snapshot.
```

Menu price changes before submission may change the final submitted price. After submission, the price snapshot is immutable and is never silently recalculated.

---

## 47. Explicit Reprice Operation

No separate draft reprice operation is required: draft preview reads current Menu data and submission re-resolves the approved price. Submitted prices remain immutable.

Do not allow price history edits to mutate existing Order Item snapshots.

Price override/manual price editing is out of scope. The approved fixed/percentage discount workflow is in scope; see Section 21.

---

## 48. Order Subtotal

Order subtotal is derived from active/non-void Order Item line totals.

Use exact money arithmetic.

Maintain a stored subtotal only if transactionally kept consistent and treated as a projection/snapshot.

Tests should recompute/verify stored subtotal from submitted, non-void Item snapshots and immutable applied discount snapshots. Draft previews do not contribute to the Order subtotal.

---

## 49. No Settlement Calculations Yet

Do not implement:

```text
amount due
tendered amount
payment status
tip
change due
refund payment
credit-card authorization
```

Do not calculate tax or fees in Phase 9. Apply approved fixed/percentage ITEM and ORDER discounts, preserve their immutable snapshots, and expose pre-tax totals only.

---

## 50. Server / Employee Context

For DINE_IN Orders, capture the relevant operational Employee/server context where appropriate.

Do not derive Order authorization from Employee Position alone.

Application permissions still determine who may create/edit/submit/void Orders.

Employee Position remains operational job qualification, not software authorization.

---

## 51. Order Permissions

Use/extend central RBAC without synonyms.

Expected capabilities include concepts such as:

```text
orders.view
orders.create
orders.edit
orders.submit
orders.void
orders.close
orders.view-all
```

Reuse existing Phase 2 codes where present.

Potential role behavior:

```text
SERVER / BARTENDER
 -> normal Order entry/submit for appropriate operational context

MANAGER
 -> broader view/void/override capabilities
```

Finalize based on existing role-permission model and README.

---

## 52. Order Authorization Scope

Authorization should consider:

```text
User permission
Location
Order ownership/operational context where required
Table Session Location
```

A Server should not automatically edit an unrelated Location's Order.

If role policy restricts Servers to their assigned Table Sessions/sections, use existing safe operational Employee linkage and explicitly test it.

Do not infer application authority from the Order's assigned Employee alone.

---

## 53. Inventory Consumption Authorization

Authorize the actor at the Order workflow boundary with `orders.submit`. The trusted server-side workflow may invoke a narrow internal Inventory `CONSUME` capability in the same transaction. That capability is consume-only, preserves actor plus Order/Item/submission provenance, enforces the Location negative-stock policy, and reuses Phase 8 conversion, balance, ledger, and costing rules. It must not expose arbitrary Inventory transaction types.

The narrowly scoped `SALE_REVERSAL` operation is callable only from authorized Order void workflows and is limited to UNPREPARED submitted Items with explicit original-transaction provenance. Do not grant Server/Bartender users `inventory.adjust` or `inventory.receive` for either path. `orders.submit` must not authorize arbitrary Inventory postings. Direct Inventory endpoints remain protected by Inventory permissions.

---

## 54. Order Entry UI

Create a responsive staff Order workspace.

For DINE_IN:

```text
Floor/Table Session
 -> Orders
 -> selected Order
 -> Menu/category browser
 -> Item details/modifiers
 -> Current check/order lines
 -> Submit new items
```

For TAKEOUT:

```text
Takeout Orders
 -> Create Order
 -> Menu
 -> Items/Modifiers
 -> Submit
```

Prioritize touch-friendly operation and correctness over elaborate POS graphics.

---

## 55. Order Item UI

Display:

```text
Menu Item snapshot name
quantity
selected Modifiers
special instructions
unit price
line total
submission/draft state
void state
```

Do not expose Recipe ingredient detail or Inventory cost to ordinary order-entry users.

---

## 56. Submission UI

Clearly distinguish:

```text
Draft items
Submitted items
```

The Submit action should indicate which items will be sent/committed.

Phase 10 can later add Kitchen/Bar transmission/fulfillment status.

Do not label Phase 9 submission as "Kitchen accepted" or similar.

---

## 57. Void UI

Submitted-item void requires:

```text
appropriate permission
reason
confirmation
```

Display historical void status rather than removing the line from history.

Draft item removal may use simpler edit behavior.

---

## 58. Order Query Models

Create purpose-built DTOs for:

```text
Order summary
Order detail
Order Item detail
Table Session active Orders
Takeout Order queue/basic list
```

Do not return Inventory cost/ledger internals to Order clients.

Order detail may expose Inventory shortage errors during submission only as operational quantities/reasons, not valuation.

---

## 59. Concurrency

Use optimistic concurrency for mutable Orders/Items.

High-risk operations also use transaction locks/rechecks:

```text
submission
void
full Order void
Table Session completion interaction
```

Required scenario:

```text
Server A edits version 4
Server B submits -> version 5
Server A tries stale change from version 4
        |
        v
CONFLICT
```

Do not silently overwrite submitted state.

---

## 60. Duplicate Submission Protection

A retry or double-click must not double-consume Inventory.

Use one or more appropriate protections:

```text
Order Item submitted marker/submission relation
unique provenance/idempotency key
row locking/version check
Inventory reference uniqueness where appropriate
```

Required invariant:

```text
One submitted Order Item quantity
 -> one logical consumption posting set
```

Do not rely only on disabled UI buttons.

---

## 61. Submission Failure Atomicity

Test deliberate mid-submission errors.

Example:

```text
Item A recipe valid
Item B insufficient Inventory
        |
        v
Entire submission fails
No item marked submitted
No Inventory consumption retained
```

Use one shared transaction across Order and Inventory services.

---

## 62. Void Failure Atomicity

If one compensating Inventory reversal cannot be posted, the submitted-item/full-Order void must fail entirely.

Do not mark Item VOIDED without corresponding reversal when the policy requires reversal.

---

## 63. Business Date

Persist Order business date using BusinessDateService.

Do not calculate by truncating `opened_at`.

Inventory consumption transactions generated by Order submission must use consistent business-date semantics according to their occurrence time/location.

---

## 64. Prep Routing Contract for Phase 10

At submission, preserve enough routing/config context for Phase 10 to deterministically create Kitchen/Bar work from submitted Order Items.

Do not create Kitchen Tickets yet.

Potential data consumed later includes:

```text
Order Item
Menu Item snapshot/identity
selected Modifiers
special instructions
resolved prep station routing
submission timestamp/round
```

Document the contract.

---

## 65. Menu Changes After Submission

After submission, historical Order snapshots remain unchanged if:

```text
Menu Item renamed
price changed
Modifier renamed/deactivated
Recipe revision changes
prep routing changes
```

Inventory consumption uses the Recipe revision resolved for the submitted item.

Do not re-run historical consumption because configuration later changes.

---

## 66. Recipe Revision Preservation

Submitted Order Items should retain a reference to the exact Recipe revision used for consumption when applicable.

That version remains immutable per Phase 7/8.

This supports future reproducibility:

```text
Order Item
 -> Recipe Revision
 -> Recipe Version Ingredients
 -> Inventory consumption provenance
```

---

## 67. Inventory Consumption Snapshot

Consider whether the Order should persist a normalized consumption snapshot in addition to Inventory ledger provenance.

Recommended Phase 9 approach:

- Inventory Transactions are authoritative stock movement.
- Submitted Order Item retains Recipe revision and Modifier snapshots.
- Consumption can be reconstructed from ledger references and immutable configuration.
- Do not add a duplicate consumption-snapshot table unless README requires it or reconstruction would otherwise be ambiguous.

If Copilot identifies ambiguity caused by Modifier configuration changing after submission, stop and propose a minimal immutable snapshot solution before implementing.

---

## 68. Modifier Effect Snapshot

Selected Modifier names/prices are already snapshotted.

Because future Inventory reconstruction also depends on effect semantics, ensure submitted behavior remains reproducible even if Modifier inventory-effect configuration later changes.

Approved policy:

```text
At submission, persist immutable resolved consumption detail snapshots alongside ledger rows with Order Item/submission provenance. Never re-resolve current Modifier Inventory effects to explain historical consumption.
```

Do not re-resolve today's Modifier effect configuration to explain an old submission.

Inventory ledger rows themselves must preserve the actual posted quantities.

---

## 69. Order History

Provide operational history sufficient to understand:

```text
Order opened
Items added
Submission rounds
Items voided
Order voided/closed
```

Full generic application audit remains later.

Domain status histories are not a replacement for the future Audit domain.

---

## 70. Seeds

Do not seed permanent fake customer Orders as stable application configuration.

Use isolated fixtures for Order testing.

Phase 9 seeds may update:

```text
permissions
role grants
stable Order configuration if README requires any
```

Do not seed Kitchen or Settlement records.

---

## 71. Unit Tests: Pricing Snapshots

Test:

```text
resolved base price exact
modifier additions exact
quantity multiplication exact
subtotal exact
subsequent Menu price change does not alter snapshot
subsequent Modifier price change does not alter snapshot
```

No floating-point authoritative money arithmetic.

---

## 72. Unit Tests: Modifier Selection

Reuse/shared validator tests plus Order-specific integration around:

```text
required group
optional group
max selection
duplicate Modifier
inactive Modifier
Modifier not attached to item
item group overrides
```

---

## 73. Unit Tests: Consumption Planning

Test:

```text
base Recipe ingredients
ADD effect
REMOVE effect
ADJUST positive
ADJUST negative
substitution REMOVE + ADD
Order Item quantity multiplier
UOM conversion to Inventory base unit
net requirement cannot be negative
Menu Item without Recipe -> no Recipe consumption
```

Use exact decimal strings.

---

## 74. Unit Tests: Submission Rules

Test:

```text
only draft/unsubmitted items selected
submitted items not resubmitted
duplicate submission retry does not duplicate consumption
insufficient stock policy
negative inventory enabled behavior
Order not editable/submittable in invalid state
```

---

## 75. Unit Tests: Void/Reversal

Test:

```text
draft removal -> no Inventory posting
submitted void -> compensating posting
full Order void -> all required reversals
void requires reason/permission
same Item cannot be voided twice
```

---

## 76. Integration Tests: Order Creation

Test:

```text
create DINE_IN Order for active Table Session
reject wrong-location Table Session
create TAKEOUT without Table Session
no fake Takeout Table
business date
initial status history
unauthorized creation denied
```

---

## 77. Integration Tests: Add/Edit Items

Test:

```text
add sellable Menu Item
snapshot price/name
valid Modifiers
invalid Modifiers rejected
line/subtotal exact
edit draft Item
remove draft Item
stale version conflict
```

No Inventory movement before submission.

---

## 78. Integration Tests: Submission + Inventory

High-value scenario:

```text
Create draft Order
Add Burger
Submit
        |
        v
Order Item marked submitted
Recipe revision stored
Inventory CONSUME rows created
Inventory balances decrease
Order/Inventory writes atomic
```

Verify ledger reference to Order Item/submission.

---

## 79. Integration Tests: Modifier Consumption

Example:

```text
Burger Recipe:
Beef 8 OZ
Cheese 1 EACH
Onion 1 EACH

Modifiers:
Add Bacon -> ADD Bacon 2 EACH
No Onion -> REMOVE Onion
Extra Cheese -> ADJUST Cheese +1 EACH

Submit
        |
        v
Beef   -8
Cheese -2
Bacon  -2
Onion   0 consumption
```

Use actual seeded/test UOMs and exact units.

---

## 80. Integration Tests: Insufficient Stock

With negative stock disabled:

```text
one required ingredient insufficient
        |
        v
submission rejected
no Order Item changed to submitted
no partial Inventory ledger entries
balance unchanged
```

With negative consumption enabled:

```text
submission allowed according to Phase 8 policy
QOH may become negative
```

---

## 81. Integration Tests: Multiple Submission Rounds

Required:

```text
Add drinks -> submit round 1
Add entrees -> submit round 2
Add dessert -> submit round 3
```

Verify:

```text
prior submitted Items unchanged
only new Items consumed in each round
submission numbers/history deterministic
no duplicate consumption
```

---

## 82. Integration Tests: Submitted Void

Test:

```text
submit Item
inventory decreases
void UNPREPARED Item with reason/disposition
compensating SALE_REVERSAL posts
Item VOIDED
subtotal updates
original CONSUME retained
```

Also void a PREPARED_OR_DISCARDED Item and verify no Inventory reversal is created and no WASTE is automatically posted.

---

## 83. Integration Tests: Full Order Void

Test entire atomic workflow including:

```text
draft Items
submitted Items
Inventory reversals
status histories
Order state
```

Unauthorized void denied.

---

## 84. Integration Tests: Table Session

Test:

```text
multiple Orders for one Table Session
moving Table Session does not alter Order association
Table Session completion is blocked while any associated Order is OPEN
completed/cancelled Table Session cannot receive new DINE_IN Order if prohibited
```

---

## 85. Integration Tests: Takeout

Test:

```text
TAKEOUT Order without Table Session
Menu pricing/modifiers
submission
Inventory consumption
no physical occupancy/table records created
```

---

## 86. Authorization Integration Tests

Test directly:

```text
orders.view
orders.create
orders.edit
orders.submit
orders.void
location scope
server/manager differences if configured
unauthenticated direct API denied
Inventory endpoints remain separately protected
```

Order submission's internal Inventory consumption must work without granting the waiter generic inventory-adjust rights.

---

## 87. E2E: Dine-In Order

Playwright scenario:

```text
Seat Guest Party
 -> open Table Session Order
 -> add Menu Item
 -> choose required Modifiers
 -> verify exact price
 -> submit
 -> Item shows submitted
```

Do not require Kitchen ticket UI.

---

## 88. E2E: Multiple Rounds

Required:

```text
submit first items
 -> add another item
 -> submit second round
 -> first submission remains unchanged
```

---

## 89. E2E: Takeout

Scenario:

```text
Create Takeout Order
 -> add Menu Item/Modifiers
 -> submit
 -> no physical Table Session created
```

---

## 90. E2E: Submitted Void

Scenario:

```text
Manager/authorized user
 -> void submitted Item with reason and physical disposition
 -> Item remains visible as VOIDED
 -> Order subtotal updated
```

Inventory result should be asserted at integration level; E2E may show operational confirmation/history.

---

## 91. E2E: Authorization

Representative scenario:

```text
User with view-only Order permission
 -> can view
 -> cannot submit/void
```

Verify direct API denial.

---

## 92. Migration Requirements

Generate/review Phase 9 migrations.

Verify:

```text
Existing Phase 8 DB
 -> Phase 9 migration(s)
 -> success
```

and:

```text
Empty isolated DB
 -> all Phase 1-9 migrations
 -> expected schema
```

Second `db:generate` reports no unexplained drift.

Do not rewrite old migrations.

---

## 93. Reset/Seed Regression

Run the established safe/disposable lifecycle:

```text
npm run db:reset
npm run db:seed
```

Verify all Phase 1-9 stable configuration reconstructs idempotently.

Do not put permanent operational Orders into normal seed data.

---

## 94. Prior-Phase Regression

Preserve all Phase 1-8 functionality, especially:

```text
location-aware RBAC
Employee Position vs Security Role
scheduling availability
Table Session concurrency
Reservation/Waitlist seating
Menu price history
Modifier validation
Recipe revision immutability
Inventory ledger/balance reconciliation
negative inventory policy
```

Order functionality must reuse these foundations rather than bypass them.

---

## 95. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies remain clean or new findings require explicit review.

Do not add payment/Kitchen/realtime/third-party POS dependencies in Phase 9.

Preserve DEV-001 unless intentionally reevaluated.

---

## 96. Documentation Updates

Document:

- Order service types
- Order lifecycle
- Order Item lifecycle
- DINE_IN Table Session relationship
- TAKEOUT no-table rule
- Price snapshot timing
- Modifier snapshot behavior
- Recipe revision resolution timing
- Submission inventory-consumption timing
- incremental submission-round policy once approved
- Inventory shortage behavior
- negative-stock reuse
- submitted void/reversal behavior
- Order subtotal semantics
- Table Session completion interaction
- Phase 10 prep-routing contract
- Phase 11 settlement extension point

---

## 97. Phase 9 Validation Checklist

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

Use the established disposable DB for destructive reset/reconstruction tests.

Verify:

```text
PostgreSQL health                    PASS
/api/health                          PASS
migration generation                 PASS
migration application                PASS
empty DB reconstruction              PASS
schema drift                         NONE
seed idempotency                     PASS
DINE_IN Order                        PASS
TAKEOUT Order                        PASS
Menu Item snapshots                  PASS
Modifier validation/snapshots        PASS
exact pricing                        PASS
Order subtotal                       PASS
Recipe revision resolution           PASS
inventory consumption planning       PASS
Inventory CONSUME posting            PASS
negative stock policy reuse          PASS
submission atomicity                 PASS
duplicate submission prevention      PASS
submitted Item void/reversal         PASS
full Order void                      PASS
multiple Table Session Orders        PASS
multiple submission rounds           PASS / policy-dependent
authorization                        PASS
prior-phase regressions              PASS
production dependency audit          CLEAN
```

---

## 98. Phase 9 Deliverables

Phase 9 should leave:

```text
✓ orders
✓ order_items
✓ order_item_modifiers
✓ order_status_history
✓ order_item_status_history
✓ deterministic order_submissions/send-batch history and idempotent retries

✓ DINE_IN orders linked to Table Sessions
✓ TAKEOUT orders without fake tables
✓ multiple Orders per Table Session

✓ exact historical Menu/price snapshots
✓ exact Modifier snapshots
✓ exact Order subtotal
✓ server-side Modifier validation reuse
✓ Recipe revision resolution/snapshot
✓ Inventory consumption-plan generation
✓ Phase 8 CONSUME posting
✓ Phase 8 negative-stock policy reuse
✓ duplicate submission protection
✓ atomic Order + Inventory submission

✓ draft item removal
✓ submitted item void with reason
✓ compensating Inventory restoration
✓ full Order void foundation
✓ lifecycle/status history

✓ responsive Order-entry UI
✓ Order RBAC
✓ future Phase 10 preparation-routing contract
✓ future Phase 11 settlement extension point

✓ unit tests
✓ PostgreSQL integration/concurrency tests
✓ Playwright tests
✓ Phase 0-8 regressions green
✓ production audit clean
✓ no Kitchen/Bar fulfillment or Settlements prematurely implemented
```

---

## 99. Phase 9 Definition of Done

Phase 9 is complete when authorized staff can perform:

```text
DINE_IN
Table Session
  -> Create/Open Order
  -> Add Menu Items
  -> Select Modifiers
  -> Exact price snapshot
  -> Submit
  -> Recipe revision fixed
  -> Inventory CONSUME posted atomically
```

and:

```text
TAKEOUT
  -> Create Order without physical table
  -> Add Menu Items/Modifiers
  -> Submit
  -> Inventory consumed
```

and:

```text
Submitted Item
  -> Authorized void with reason
  -> Item remains in history
  -> Compensating Inventory posting
```

The system proves:

- DINE_IN Orders reference Table Sessions, not physical tables.
- Takeout does not use fake tables.
- Historical Order price/name/Modifier facts do not change when current Menu configuration changes.
- Recipe revision used for submitted consumption is historically identifiable.
- Order submission is the approved Inventory-consumption boundary.
- Failed submission leaves both Order and Inventory unchanged.
- Retry/double submit cannot duplicate Inventory consumption.
- `OPEN`, `CLOSED`, `VOIDED` Order and `DRAFT`, `SUBMITTED`, `VOIDED` Item states are enforced; Phase 9 provides no Order close action.
- Incremental submissions are supported and process only unsubmitted DRAFT Items.
- Price is resolved and snapshotted at submission; draft price is preview-only.
- Fixed and percentage ITEM/ORDER discounts use exact arithmetic and immutable snapshots; no tax is calculated.
- UNPREPARED void posts a provenance-linked SALE_REVERSAL; PREPARED_OR_DISCARDED void retains consumption and creates no automatic WASTE.
- Table Session completion is blocked while any associated Order remains OPEN.
- Order submission preserves the trusted consume-only authorization boundary and requires no generic Inventory permissions.
- Phase 8 negative-stock rules are honored.
- No Kitchen tickets or Settlement/payment records are created.
- Database reconstruction requires no manual SQL.
- Prior phases remain green.

Phase 9 is not complete if historical Order prices are dynamically resolved from current Menu prices.

Phase 9 is not complete if Inventory consumption is posted outside the Order submission transaction.

Phase 9 is not complete if submitted Items are physically deleted to represent voids.

Phase 9 is not complete if an OPEN Order can be bypassed by completing its Table Session or if Phase 9 exposes a settlement-free Order close operation.

---

## 100. Required Phase 9 Completion Report

Provide:

```text
PHASE 9 COMPLETION REPORT

Environment
- Node:
- npm:
- Next.js:
- PostgreSQL:
- Drizzle ORM:
- Drizzle Kit:
- Exact money/quantity arithmetic approach:

Order Schema
- orders: PASS / FAIL
- order_items: PASS / FAIL
- order_item_modifiers: PASS / FAIL
- order_status_history: PASS / FAIL
- order_item_status_history: PASS / FAIL
- order_submissions: PASS / FAIL
- order_number_counters: PASS / FAIL
- discount_definitions: PASS / FAIL
- order_discounts: PASS / FAIL
- order_item_discounts: PASS / FAIL
- order_item_voids: PASS / FAIL
- order_item_inventory_consumption: PASS / FAIL

Order Model
- DINE_IN -> Table Session: PASS / FAIL
- TAKEOUT without Table Session: PASS / FAIL
- No physical-table FK: PASS / FAIL
- Multiple Orders/Table Session: PASS / FAIL
- BusinessDateService: PASS / FAIL
- Approved Order lifecycle: OPEN / CLOSED (Phase 11 only) / VOIDED: PASS / FAIL
- Approved Item lifecycle: DRAFT / SUBMITTED / VOIDED: PASS / FAIL
- No settlement-free Order close in Phase 9: PASS / FAIL

Snapshots and Pricing
- Menu Item identity snapshot: PASS / FAIL
- Menu Item name/code snapshot: PASS / FAIL
- Base price snapshot: PASS / FAIL
- Modifier snapshots: PASS / FAIL
- Exact unit/line totals: PASS / FAIL
- Order subtotal: PASS / FAIL
- Current Menu changes do not alter history: PASS / FAIL
- Draft price is preview-only: PASS / FAIL
- Price re-resolved and snapshotted at submission: PASS / FAIL
- Submitted price remains immutable: PASS / FAIL
- Price snapshot timing policy: submission-time / PASS / FAIL

Discounts and Tax
- ITEM / ORDER scopes: PASS / FAIL
- FIXED_AMOUNT / PERCENTAGE types: PASS / FAIL
- Item discounts before Order discounts: PASS / FAIL
- Percentage ROUND_HALF_UP to cents: PASS / FAIL
- Discounts capped at eligible subtotal: PASS / FAIL
- 100% discount marked as comp: PASS / FAIL
- Historical scope/value/applied amount/name/reason/actor snapshots: PASS / FAIL
- No tax calculation: PASS / FAIL

Modifiers
- Phase 7 validator reused: PASS / FAIL
- Required/min/max: PASS / FAIL
- Inactive/unattached rejected: PASS / FAIL
- Historical Modifier pricing: PASS / FAIL

Recipe / Consumption
- Recipe revision resolution timing: describe / PASS / FAIL
- Submitted Recipe revision fixed: PASS / FAIL
- Base Recipe requirements: PASS / FAIL
- Modifier ADD: PASS / FAIL
- Modifier REMOVE: PASS / FAIL
- Modifier ADJUST: PASS / FAIL
- Quantity multiplier: PASS / FAIL
- UOM/base conversion: PASS / FAIL
- Net negative requirement rejected: PASS / FAIL
- No-Recipe Item behavior: PASS / FAIL

Submission
- Inventory consumption occurs on submission: PASS / FAIL
- Incremental send rounds: PASS / FAIL
- Deterministic batch numbering: PASS / FAIL
- Only unsubmitted Items processed: PASS / FAIL
- Order/Inventory shared transaction: PASS / FAIL
- Insufficient-stock failure atomic: PASS / FAIL
- Negative-stock Location policy reused: PASS / FAIL
- Duplicate/retry consumption prevented: PASS / FAIL
- Idempotent retry returns original result snapshot: PASS / FAIL
- Inventory provenance: PASS / FAIL
- Trusted consume-only capability enforces orders.submit: PASS / FAIL
- Trusted capability preserves actor and Order/Item/submission references: PASS / FAIL
- No generic Inventory permission granted to Servers/Bartenders: PASS / FAIL
- Shortage details expose required/available/shortage quantities without cost: PASS / FAIL

Voids
- Draft removal posts no Inventory: PASS / FAIL
- Submitted void requires permission/reason: PASS / FAIL
- Submitted void requires physical disposition: PASS / FAIL
- Original CONSUME retained: PASS / FAIL
- UNPREPARED posts SALE_REVERSAL: PASS / FAIL
- PREPARED_OR_DISCARDED does not restore Inventory: PASS / FAIL
- No automatic WASTE from prepared/discarded void: PASS / FAIL
- Reversal provenance links original consumption: PASS / FAIL
- Item history retained: PASS / FAIL
- Full Order void: PASS / FAIL
- Double void rejected: PASS / FAIL

Table Session / Takeout
- Table Session lifecycle validation: PASS / FAIL
- Table Session completion blocked while any associated Order is OPEN: PASS / FAIL
- No Order closure added to unblock Table Session: PASS / FAIL
- Moved Table Session retains Orders: PASS / FAIL
- TAKEOUT creates no physical seating: PASS / FAIL

Authorization
- orders.view: PASS / FAIL
- orders.create: PASS / FAIL
- orders.edit: PASS / FAIL
- orders.submit: PASS / FAIL
- orders.void: PASS / FAIL
- orders.discount.apply: PASS / FAIL
- orders.discount.manage: PASS / FAIL
- location scope: PASS / FAIL
- Order submission does not grant generic Inventory rights: PASS / FAIL
- direct unauthorized API denied: PASS / FAIL

Future Contracts
- Phase 10 prep-routing contract: PASS / FAIL
- No Kitchen/Bar tickets: PASS / FAIL
- Phase 11 settlement extension documented: PASS / FAIL
- Order closure deferred to Phase 11 settlement: PASS / FAIL
- No tax/payment/settlement records: PASS / FAIL
- No payment records: PASS / FAIL

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

Business Domains Created Beyond Phase 9
- NONE expected

Created / Modified
- Summarize schema, migrations, Order services/workflows, Inventory integration, permissions, UI, tests, seeds, and docs.

Architecture Deviations
- None / describe

Outstanding Phase 9 Issues
- None / describe and blocking status

Phase 10 Readiness
- READY / NOT READY
```

---

## 101. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-9-Orders.md`, start a fresh Copilot chat and use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 9 implementation plans completely. Treat `README.md` as the architectural source of truth. Derive current state from repository source, migrations, tests, and documentation rather than prior chat history.
>
> Review the completed Phase 0 through Phase 8 implementation before modifying files. Implement Phase 9 only: Orders, including DINE_IN Orders linked to Phase 5 Table Sessions, TAKEOUT Orders without fake tables, Order Items, historical Menu/price/Modifier snapshots, exact pricing/subtotals, item/order discounts, server-side Modifier validation, Order/submission histories, Recipe-revision-aware Inventory consumption planning, Phase 8 CONSUME posting in the same submission transaction, negative-stock policy reuse, duplicate-submission protection, draft removal, disposition-aware submitted-item voids with compensating Inventory transactions only for UNPREPARED Items, Order authorization, responsive Order-entry UI, migrations, tests, and documentation.
>
> Preserve these boundaries: Orders reference Table Sessions rather than physical tables; Takeout does not require a physical Table Session; historical snapshots must not change when current Menu/Modifier/Recipe configuration changes; Order submission is the Inventory-consumption boundary unless README explicitly says otherwise; Inventory posting must go through the Phase 8 posting service; Kitchen/Bar fulfillment is Phase 10; payment/settlement is Phase 11.
>
> Preserve exact money/quantity arithmetic, BusinessDateService, Phase 1 transaction/migration/test architecture, Phase 2 RBAC, Phase 3 HR boundaries, Phase 4 Scheduling, Phase 5 Seating, Phase 6 Reservations/Waitlist, Phase 7 Menu/Recipe contracts, Phase 8 Inventory ledger/cost/negative-stock policies, reset safeguards, and DEV-001.
>
> Apply the approved policies recorded above in this plan: Orders remain OPEN in Phase 9; incremental send batches; submission-time Menu price and Recipe revision resolution; discounts apply before tax (which is not calculated); disposition-aware voids; and Table Session completion is blocked by any OPEN Order. Before modifying files, inspect the repository and provide a concise Phase 9 execution plan. Stop only if a new material architecture conflict is discovered.
>
> After implementation, run the complete Phase 9 validation suite and provide the full Phase 9 Completion Report. Stop before changing approved architecture if a material conflict is discovered.

---

## Final Guardrail

Phase 9 introduces commercial Order intent and Inventory consumption without implementing fulfillment or payment.

```text
Table Session / Takeout
        |
        v
      Order
        |
        +-- Historical Menu/Modifier price snapshots
        +-- Submitted Recipe revision
        |
        v
  Order Submission
        |
        +-- Inventory CONSUME
        |
        +-- Phase 10 Kitchen/Bar later
        |
        +-- Phase 11 Settlement later
```

Do not collapse Order entry, fulfillment, Inventory ledger posting, and Settlement into one domain for implementation convenience.
