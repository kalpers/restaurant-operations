# Phase 8: Inventory & Purchasing Implementation Plan

## Purpose

Phase 8 implements Inventory and Purchasing for the Restaurant Operations Management System and connects the Phase 7 Recipe model to authoritative stock identities.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 7 implementation plans
5. This document

`README.md` remains the architectural source of truth.

## Approved Phase 8 Business Policies

The following policies were explicitly approved on 2026-10-08. They are binding for schema, services, UI, tests, seeds, and documentation.

### Negative Inventory

`location_settings.allow_negative_inventory` defaults to `false`. When false, reject any transaction that would leave QOH below zero. When true, only an authorized `CONSUME` transaction may make QOH negative. `WASTE`, `ADJUST_DECREASE`, and `COUNT_DECREASE` must not make QOH negative even when consumption is allowed. Positive transactions retain normal validation. This setting is the future Phase 9 Order-consumption contract.

### Costing While Inventory Is Negative

When existing QOH is negative, never apply the ordinary weighted-average formula with a zero or negative denominator. A receipt that leaves QOH at or below zero preserves the existing weighted-average unit cost. A receipt that moves QOH from at-or-below zero to above zero establishes the new weighted-average unit cost at that receipt's actual base-unit cost. Preserve actual receipt costs in receipt and ledger history.

### Weighted-Average Rounding

Use exact integer/BigInt decimal arithmetic. Round weighted-average unit cost `ROUND_HALF_UP` to exactly four decimal places after each receipt and persist it as `NUMERIC(14,4)`. The following receipt calculation uses that persisted four-decimal average as its existing cost basis; do not retain a hidden higher-precision accumulator. Tests cover rounding boundaries and the subsequent persisted-cost basis.

### Inventory Count Activity

Counts snapshot expected quantity; inventory is not frozen while a count is open. Variance is `counted quantity - expected snapshot quantity`. If ledger activity occurs after a line's expected snapshot, approval requires explicit manager acknowledgement. Approval posts the snapshot variance against current QOH, never sets the current balance directly to the physical count. Record acknowledgement actor and timestamp when activity exists. Count state, acknowledgement provenance, ledger entries, and balance projection updates commit atomically.

### Over-Receiving

Over-receiving is rejected. For every PO line, cumulative received quantity must remain less than or equal to the remaining ordered quantity at receipt time. Phase 8 has no manager override. Any future supplier over-shipment policy requires separate approval with explicit authorization and provenance.

### Supplier Preference

Phase 8 has no preferred Supplier policy or preferred-supplier field. Low-stock results expose matching active Supplier Item options where appropriate. Purchase Order creation requires an explicit Supplier selection. Never choose a Supplier implicitly by sort order, last purchase, price, or another heuristic.

Phase 8 must preserve the boundary between theoretical Recipe requirements and actual Inventory state. Inventory history must be ledger-based and reproducible. Purchase Orders do not increase stock until goods are actually received.

### Amendment (Phase 23)

Transfers became records with an in-transit state (`docs/Phase-23-Multiple-Locations-and-Ingredient-Lots.md`, D7): a transfer is sent (TRANSFER_OUT) and later received (TRANSFER_IN, then any shortfall as `TRANSFER_SHORTAGE`), each side under its own `inventory.transfer`. The one-step move described here is kept as "Send and receive now".

---

## 1. Phase 8 Objectives

Implement:

```text
Inventory Item
   |
   +-- Inventory Location Configuration
   +-- Product / Package Conversions
   +-- Supplier Items
   |      |
   |      +-- Supplier
   |
   +-- Inventory Transactions
   +-- Inventory Counts
   |
   +-- Recipe Version Ingredients
   |      |
   |      +-- Recipe Version
   |
   +-- Modifier Inventory Effects

Supplier
   |
   +-- Purchase Order
          |
          +-- Purchase Order Lines
                  |
                  +-- Receiving
                         |
                         +-- Inventory Ledger
```

Deliver:

- Inventory Items
- Location inventory configuration
- Exact stock quantities
- Purchase/stock/consumption units
- Product-specific conversion factors
- Recipe Version Ingredients linked directly to Inventory Items
- Modifier ADD/REMOVE/ADJUST effects linked to Inventory Items
- Append-oriented Inventory transaction ledger
- Derived quantity-on-hand queries
- Weighted-average cost
- Suppliers
- Supplier Items
- Purchase Orders
- Purchase Order Lines
- Submission/cancellation lifecycle
- Full and partial receiving
- Waste transactions
- Manual adjustments
- Paired Location-to-Location Inventory transfers
- Physical inventory counts
- Inventory count variances
- Par/reorder levels
- Low-stock queries
- Inventory/Purchasing permissions
- Responsive administration/operational UI
- Unit, PostgreSQL integration, and Playwright tests

---

## 2. Scope Boundary

Do not implement during Phase 8:

```text
customer Orders
Order Items
Order submission
automatic Recipe consumption from Orders
Kitchen tickets
Bar tickets
settlements
vendor EDI/API integrations
automatic supplier ordering
accounting/AP integration
invoice payment
full reporting dashboards
```

Phase 9 will create Orders and use Phase 8 services to post Recipe-based consumption.

Phase 10 owns Kitchen/Bar fulfillment.

Do not create placeholder Order tables solely to test Inventory consumption.

---

## 3. Critical Boundary: Inventory Item Is Ingredient Identity

Phase 8 fulfills the README contract established in Phase 7:

```text
Recipe Version Ingredient
        |
        v
Inventory Item
```

Do not create a separate Recipe Component identity catalog.

Examples:

```text
GROUND_BEEF
BRIOCHE_BUN
AMERICAN_CHEESE
BACON
TITOS_VODKA
LIME_JUICE
```

An Inventory Item is the stable ingredient/product identity used by Recipes and stock operations.

---

## 4. Critical Boundary: Recipe Requirement vs Stock State

```text
Recipe Version Ingredient
"Requires 8.0000 OZ_WEIGHT ground beef"

        !=

Inventory Balance
"Currently 142.5000 OZ_WEIGHT on hand"
```

Recipe definitions never directly change stock.

Actual stock changes are represented by Inventory Transactions.

---

## 5. Critical Boundary: PO vs Receiving

A Purchase Order expresses procurement intent.

It does not increase inventory.

```text
Purchase Order SUBMITTED
        !=
Stock received
```

Only a successful receiving workflow posts positive Inventory ledger transactions.

---

## 6. Review Existing Foundation Before Changes

Before editing, inspect and confirm:

- Phase 0 through Phase 7 validation remains green.
- Phase 7 UOM model/conversion helpers are understood.
- Recipe identity and immutable Recipe revisions are understood.
- Recipe ingredient rows were intentionally deferred.
- Modifier ADD/REMOVE/ADJUST contracts are understood.
- Exact decimal-string and BigInt money strategy is understood.
- Location-aware RBAC is understood.
- Shared transaction context is understood.
- BusinessDateService is available and authoritative.
- Seed/reset/test DB infrastructure remains intact.
- No Order/Kitchen domain exists yet.
- DEV-001 remains tracked.

Before coding, provide a concise Phase 8 execution plan based on actual repository state.

---

## 7. Inventory Items

Create:

```text
inventory_items
```

Conceptual fields:

```text
id                    UUID PK
organization_id       UUID FK
code                  required
name                  required
description           nullable
measurement_type      required
base_stock_unit_id    UUID FK
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

`base_stock_unit_id` must be compatible with the Inventory Item's measurement type.

Do not store authoritative mutable quantity-on-hand directly as the only stock state.

---

## 8. Inventory Location Configuration

Create:

```text
inventory_item_locations
```

Conceptual fields:

```text
id                    UUID PK
inventory_item_id     UUID FK
location_id           UUID FK
active                BOOLEAN default TRUE
par_level             NUMERIC(14,4) nullable
reorder_level         NUMERIC(14,4) nullable
reorder_target        NUMERIC(14,4) nullable
storage_note          nullable
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (inventory_item_id, location_id)
```

Amounts use the Inventory Item's base stock unit unless an explicit field states otherwise.

Validate non-negative thresholds and sensible relationships.

---

## 9. Product-Specific Package Conversions

Generic UOM conversion from Phase 7 is insufficient for product packaging.

Example:

```text
1 CASE of beer
 = 24 BOTTLES

1 BOTTLE
 = 12 FL_OZ
```

Create explicit product/package conversion configuration, conceptually:

```text
inventory_item_unit_conversions
```

Fields may include:

```text
id                  UUID PK
inventory_item_id   UUID FK
from_unit_id        UUID FK
to_unit_id          UUID FK
factor              NUMERIC(14,6) required
active              BOOLEAN default TRUE
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

Do not pretend generic dimensional UOM conversion can infer packaging relationships.

---

## 10. Conversion Rules

Use two explicit conversion mechanisms:

```text
Generic UOM conversion
LB -> OZ_WEIGHT
L -> ML

Product-specific conversion
CASE -> BOTTLE
BOTTLE -> FL_OZ for a specific product
```

Conversion paths must be deterministic and exact.

Reject ambiguous or cyclic product-specific configuration where applicable.

Do not use floating-point quantities.

---

## 11. Recipe Version Ingredients

Create the deferred Phase 7 relationship:

```text
recipe_version_ingredients
```

Conceptual fields:

```text
id                    UUID PK
recipe_version_id     UUID FK
inventory_item_id     UUID FK
quantity              NUMERIC(14,4) required
unit_of_measure_id    UUID FK
preparation_note      nullable
sort_order            integer
created_at            TIMESTAMPTZ
```

Rules:

```text
quantity > 0
Inventory Item organization matches Recipe organization
unit is compatible/convertible to Inventory Item base stock unit
```

Published Recipe revisions remain immutable, including their ingredient rows.

---

## 12. Recipe Ingredient Editing Workflow

Ingredient editing occurs only on a DRAFT Recipe revision.

Conceptually:

```text
Current published Recipe Revision
        |
        v
Create new DRAFT revision
        |
        +-- define Ingredient rows
        +-- quantities and units
        |
        v
Publish revision
```

Do not mutate ingredients attached to an already published revision.

Reuse Phase 7 Recipe publication workflow.

---

## 13. Modifier Inventory Effects

Persist the Phase 7 modifier-effect contracts using real Inventory Item identities.

Create an explicit model, conceptually:

```text
modifier_inventory_effects
```

Fields:

```text
id                  UUID PK
modifier_id         UUID FK
menu_item_id        UUID FK
inventory_item_id   UUID FK
effect_type         required
quantity            NUMERIC(14,4) nullable
unit_of_measure_id  UUID nullable FK
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

Approved effect types:

```text
ADD
REMOVE
ADJUST
```

Substitution remains:

```text
REMOVE old Inventory Item
ADD new Inventory Item
```

---

## 14. Modifier Effect Semantics

Define semantics clearly for future Phase 9 consumption planning:

### ADD

Add the specified Inventory Item quantity to Recipe requirements.

### REMOVE

Remove the Recipe's applicable Inventory Item requirement for the selected Menu Item context.

### ADJUST

Adjust the existing requirement by the signed exact quantity according to the approved representation.

Do not post Inventory Transactions when saving a Modifier or Recipe configuration.

Effects are configuration, not stock movement.

---

## 15. Inventory Transactions

Create:

```text
inventory_transactions
```

This is append-oriented authoritative stock history.

Conceptual fields:

```text
id                    UUID PK
location_id           UUID FK
inventory_item_id     UUID FK
transaction_type      required
quantity_delta        NUMERIC(14,4) required
unit_of_measure_id    UUID FK
base_quantity_delta   NUMERIC(14,4) required
unit_cost             NUMERIC(14,4) nullable
total_cost            NUMERIC(14,4) nullable
business_date         DATE required
occurred_at           TIMESTAMPTZ required
reference_type        nullable
reference_id          nullable
reason_code           nullable
notes                 nullable
created_by_user_id    UUID nullable FK
created_at             TIMESTAMPTZ
```

Do not update/delete normal posted ledger transactions.

Corrections use compensating transactions.

---

## 16. Inventory Transaction Types

Initial types:

```text
RECEIVE
CONSUME
WASTE
ADJUST_INCREASE
ADJUST_DECREASE
COUNT_INCREASE
COUNT_DECREASE
TRANSFER_OUT
TRANSFER_IN
```

Potential future types may be added deliberately.

Do not overload one ambiguous `ADJUST` type if direction/provenance becomes unclear.

Order-driven `CONSUME` posting begins in Phase 9, but the type and ledger support are established/tested in Phase 8 using service-level fixtures.

Location transfers post one `TRANSFER_OUT` and one `TRANSFER_IN` with a shared reference in a single transaction. Both Locations must be active, belong to the same Organization, have the Item configured, and authorize `inventory.transfer`. Transfers cannot create negative stock. Source weighted-average cost is carried to the destination; total restaurant quantity is unchanged.

---

## 17. Canonical Base Quantity

Every Inventory transaction must resolve its entered quantity into the Inventory Item's base stock unit.

Store both when useful:

```text
entered quantity + entered unit
base quantity delta
```

For example:

```text
Receive 1 CASE
Product conversion -> 12 BOTTLES
Base stock unit = BOTTLE
base_quantity_delta = +12.0000
```

This makes ledger summation deterministic.

---

## 18. Quantity-on-Hand

Authoritative quantity-on-hand is derived from the ledger:

```text
QOH(item, location, atTime)
= SUM(base_quantity_delta)
```

Create centralized queries for:

```text
current quantity on hand
quantity on hand as of timestamp/business date where feasible
transaction history
```

Do not allow UI/services to calculate QOH from a mutable field that can drift from ledger history.

A future cached balance can be introduced only as a derived optimization with reconciliation.

---

## 19. Negative Inventory Policy

Approved policy:

```text
location_settings.allow_negative_inventory = false by default
When false, reject any transaction that would make QOH negative.
When true, only authorized CONSUME may make QOH negative.
WASTE, ADJUST_DECREASE, and COUNT_DECREASE may never make QOH negative.
```

This setting is the contract future Phase 9 consumption must use. Do not clamp or silently reset negative values.

---

## 20. Inventory Costing Policy

Use weighted-average cost for the Phase 8 POC unless README specifies otherwise.

Cost uses exact `NUMERIC(14,4)` values.

Do not use JavaScript floating-point arithmetic.

Costing should be calculated in the Inventory Item's base stock unit.

---

## 21. Weighted-Average Cost

Conceptually:

```text
existing quantity = Q_old
existing average unit cost = C_old
receive quantity = Q_new
receive base-unit cost = C_new

new weighted average =
(Q_old * C_old + Q_new * C_new)
/
(Q_old + Q_new)
```

Use exact integer/BigInt arithmetic and `ROUND_HALF_UP` to four decimal places after each receipt. Persist `NUMERIC(14,4)` and use that persisted average as the next receipt's existing cost basis. Do not keep hidden higher-precision state.

If existing quantity is zero, the received unit cost establishes the new average.

If existing QOH is negative, preserve the existing average if a receipt leaves QOH at or below zero. If it moves QOH above zero, set the new average to that receipt's actual base-unit cost. Never use the ordinary formula with a zero or negative denominator.

---

## 22. Cost State

Inventory transaction history must preserve sufficient posted cost information to reproduce valuation behavior.

A derived current cost/balance table may be added only if it is transactionally maintained from the ledger and treated as a projection/cache.

If used, call it something explicit such as:

```text
inventory_balances
```

with reconciliation tests proving:

```text
cached quantity == ledger sum
```

Do not make the cache the only history.

---

## 23. Inventory Balance Projection

Recommended for operational performance:

```text
inventory_balances
```

Conceptual fields:

```text
inventory_item_id       UUID FK
location_id             UUID FK
quantity_on_hand        NUMERIC(14,4)
weighted_average_cost   NUMERIC(14,4) nullable
updated_at              TIMESTAMPTZ
version                 INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (inventory_item_id, location_id)
```

Every ledger posting updates the projection in the same transaction.

Provide reconciliation logic/tests against the ledger.

---

## 24. Inventory Posting Service

Create one authoritative posting service used by all stock-changing workflows.

Conceptually:

```text
postInventoryTransaction(tx, input)
```

Responsibilities:

- Validate item/location.
- Validate unit conversion.
- Convert to base unit.
- Apply negative-stock policy.
- Apply costing policy where relevant.
- Append ledger transaction.
- Update balance projection if used.
- Use business date.
- Return exact resulting balance/cost.

Do not let Receiving, Waste, Count, and Adjustments each implement their own ledger math.

---

## 25. Suppliers

Create:

```text
suppliers
```

Conceptual fields:

```text
id                UUID PK
organization_id   UUID FK
code              required
name              required
phone             nullable
email             nullable
contact_name      nullable
active            BOOLEAN default TRUE
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Do not build AP/payment functionality.

---

## 26. Supplier Items

Create:

```text
supplier_items
```

Conceptual fields:

```text
id                    UUID PK
supplier_id           UUID FK
inventory_item_id     UUID FK
supplier_sku          nullable
purchase_unit_id      UUID FK
units_per_purchase    NUMERIC(14,4) required
base_units_per_purchase NUMERIC(14,4) required
last_unit_cost        NUMERIC(14,4) nullable
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

This defines how a supplier sells an Inventory Item.

Do not treat `last_unit_cost` as authoritative accounting history; receipts/PO lines preserve transaction cost.

---

## 27. Supplier Item Conversion

Supplier purchase units must resolve to Inventory base quantity.

Example:

```text
Supplier Item:
Tito's Vodka Case

purchase unit = CASE
1 CASE = 12 BOTTLES
1 BOTTLE = 1 L
base stock unit = ML
```

The receiving workflow must deterministically calculate base quantity and base-unit cost.

Do not infer package conversion from names such as "case" or "bottle".

---

## 28. Purchase Orders

Create:

```text
purchase_orders
```

Conceptual fields:

```text
id                    UUID PK
location_id           UUID FK
supplier_id           UUID FK
po_number             required
status                required
ordered_at            TIMESTAMPTZ nullable
expected_at           TIMESTAMPTZ nullable
submitted_by_user_id  UUID nullable FK
cancelled_at          TIMESTAMPTZ nullable
cancelled_by_user_id  UUID nullable FK
notes                 nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Required uniqueness should scope `po_number` appropriately, likely by organization/location.

---

## 29. Purchase Order Statuses

Initial lifecycle:

```text
DRAFT
SUBMITTED
PARTIALLY_RECEIVED
RECEIVED
CANCELLED
```

Rules:

- DRAFT can be edited.
- SUBMITTED establishes ordered quantities/prices.
- PARTIALLY_RECEIVED indicates some but not all quantities received.
- RECEIVED indicates all required receiving is complete.
- CANCELLED cannot receive further goods without an explicit reopen workflow, which is out of scope initially.

Do not auto-submit or auto-order.

---

## 30. Purchase Order Lines

Create:

```text
purchase_order_lines
```

Conceptual fields:

```text
id                    UUID PK
purchase_order_id     UUID FK
supplier_item_id      UUID FK
inventory_item_id     UUID FK
ordered_quantity      NUMERIC(14,4)
purchase_unit_id      UUID FK
unit_price            NUMERIC(14,4)
line_total            NUMERIC(14,4)
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Line values are historical snapshots of the order decision.

Do not resolve old PO line price from today's Supplier Item record.

---

## 31. Purchase Order Money

PO costs use detailed `NUMERIC(14,4)` precision according to Phase 1 conventions.

Use exact decimal arithmetic.

PO total is derived from line totals.

Do not implement tax/freight accounting unless README explicitly requires it for Phase 8.

---

## 32. Submit Purchase Order Workflow

Conceptually:

```text
DRAFT PO
  |
  +-- validate Supplier active
  +-- validate lines
  +-- validate Supplier Items / units
  |
  v
SUBMITTED
```

Record submitter and timestamp.

Submitting does not post Inventory Transactions.

Use optimistic concurrency.

---

## 33. Receiving

Create explicit receiving records, conceptually:

```text
purchase_order_receipts
purchase_order_receipt_lines
```

Receipt header fields may include:

```text
id
purchase_order_id
received_at
received_by_user_id
supplier_reference nullable
notes nullable
created_at
```

Receipt line fields may include:

```text
receipt_id
purchase_order_line_id
received_quantity
purchase_unit_id
actual_unit_cost
base_quantity
base_unit_cost
created_at
```

Receiving history must remain immutable/append-oriented after posting.

---

## 34. Receiving Workflow

Conceptually:

```text
SUBMITTED/PARTIALLY_RECEIVED PO
       |
       v
Enter actual received quantities/costs
       |
       v
Validate remaining quantities
Convert purchase quantities to base stock units
       |
       v
BEGIN
Create Receipt + lines
Post RECEIVE Inventory Transactions
Update Inventory balances/cost
Update PO status
COMMIT
```

Do not partially update the ledger if receipt persistence fails.

---

## 35. Partial Receiving

Support:

```text
Ordered: 10 cases
First receipt: 6 cases
PO -> PARTIALLY_RECEIVED
Second receipt: 4 cases
PO -> RECEIVED
```

Reject receiving beyond remaining ordered quantity. No manager over-receipt override exists in Phase 8.

Any future over-receipt exception requires separate approval with explicit authorization and provenance.

---

## 36. Actual Receipt Cost

Actual received cost may differ from PO cost.

The receiving workflow should use the actual receipt cost for Inventory weighted-average costing.

Preserve both:

```text
PO expected/order price
Receipt actual price
```

Do not rewrite the PO line to erase the original ordered cost.

---

## 37. Waste

Implement an authorized Waste posting workflow.

Inputs:

```text
Inventory Item
Location
Quantity
Unit
Reason
Notes optional
Occurred time
```

Posts a negative `WASTE` Inventory Transaction.

Use structured reason codes where practical, for example:

```text
SPOILAGE
BREAKAGE
PREP_WASTE
EXPIRED
OTHER
```

Do not delete stock directly.

---

## 38. Manual Inventory Adjustments

Implement explicit authorized adjustments:

```text
ADJUST_INCREASE
ADJUST_DECREASE
```

Require:

```text
reason code
optional detailed notes
actor
occurred_at
```

Do not provide a generic edit-quantity textbox that bypasses the ledger.

---

## 39. Inventory Counts

Create:

```text
inventory_counts
inventory_count_lines
```

Count header conceptual fields:

```text
id
location_id
status
counted_at
started_by_user_id
approved_by_user_id nullable
approved_at nullable
created_at
updated_at
version
```

Statuses:

```text
DRAFT
SUBMITTED
APPROVED
CANCELLED
```

---

## 40. Inventory Count Lines

Conceptual fields:

```text
id                    UUID PK
inventory_count_id    UUID FK
inventory_item_id     UUID FK
expected_quantity     NUMERIC(14,4)
counted_quantity      NUMERIC(14,4)
variance_quantity     NUMERIC(14,4)
unit_of_measure_id    UUID FK
notes                 nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Expected quantity should be captured/snapshotted according to the chosen count workflow so later transactions do not silently alter what the counter compared against.

---

## 41. Count Approval

Approval posts ledger corrections instead of overwriting stock.

Example:

```text
Expected 10.0000
Counted   8.0000
Variance -2.0000
        |
        v
COUNT_DECREASE -2.0000
```

Or:

```text
Expected 10.0000
Counted  12.0000
Variance +2.0000
        |
        v
COUNT_INCREASE +2.0000
```

Approval and resulting ledger postings occur atomically.

---

## 42. Count Concurrency Policy

Approved policy:

```text
Inventory remains mutable while a count is open.
Expected QOH is captured as a line snapshot.
Variance = counted quantity - expected snapshot quantity.
Post-snapshot ledger activity requires manager acknowledgement at approval.
Post the variance against current QOH; never set current QOH directly to the count.
Record acknowledgement actor and timestamp when activity exists.
Approval and variance posting are atomic.
```

Detect activity from append-only ledger rows created after each line's snapshot timestamp. Approval serializes against posting so activity cannot race the acknowledgement decision.

---

## 43. Par/Reorder Queries

Provide operational queries:

```text
quantity on hand
par level
reorder level
reorder target
shortage to par
suggested reorder quantity
```

Conceptually:

```text
if QOH <= reorder_level
suggest max(reorder_target - QOH, 0)
```

Do not automatically create/submit a Purchase Order from this query.

It is a recommendation only.

---

## 44. Low-Stock Query

Create a purpose-built query for items at/below reorder threshold.

Output safe operational fields:

```text
Inventory Item
Location
Base stock unit
QOH
Reorder threshold
Par/reorder target
Suggested quantity
Preferred/active Supplier Item where one is deterministically chosen
```

Do not overstate available quantities if negative inventory exists.

---

## 45. Supplier Selection

Phase 8 may support multiple Suppliers per Inventory Item.

Do not automatically presume one supplier forever.

Do not create a preferred Supplier field or implicit-selection policy in Phase 8. Low-stock results may list all active Supplier Items. Purchase Order creation always requires explicit Supplier selection.

Do not implement dynamic supplier-bid optimization.

---

## 46. Inventory Permissions

Use/extend central RBAC without synonyms.

Expected capabilities include concepts such as:

```text
inventory.view
inventory.receive
inventory.adjust
inventory.count
inventory.waste
inventory.configure
inventory.cost.view
purchasing.view
purchasing.manage
purchasing.submit
suppliers.manage
```

Reuse existing Phase 2 permission codes where already defined.

Update role seeds deliberately.

---

## 47. Inventory Security Boundaries

Operational inventory viewers may see:

```text
item identity
quantity on hand
stock unit
par/reorder values
```

Cost visibility may require a more restricted permission such as:

```text
inventory.cost.view
```

Do not return supplier cost/valuation fields to users who only need physical stock counts if the permission model distinguishes them.

---

## 48. Purchasing Authorization

Representative rules:

```text
purchasing.view
 -> view POs

purchasing.manage
 -> create/edit Draft PO

purchasing.submit
 -> submit PO

inventory.receive
 -> receive against PO

inventory.adjust
 -> manual adjustment

inventory.count
 -> inventory count workflow
```

Direct API/server operations enforce permissions independently of UI.

---

## 49. Inventory Administration UI

Create responsive views:

```text
Inventory
├── Items
├── Stock / On Hand
├── Transactions
├── Low Stock
├── Counts
├── Waste / Adjustments
└── Suppliers / Purchasing
```

Keep cost columns permission-aware.

Do not create Order/Kitchen consumption UI in this phase.

---

## 50. Inventory Item Editor

Allow authorized users to configure:

```text
code/name/description
measurement type
base stock unit
location activation
par/reorder thresholds
product-specific unit conversions
Supplier Items
```

Use optimistic concurrency.

Do not allow direct QOH editing.

---

## 51. Recipe Editor Extension

Extend Phase 7 Recipe revision UI for DRAFT revisions to manage:

```text
Inventory Item
Quantity
UOM
Preparation note
```

Published revision ingredient rows remain immutable.

Do not allow stock changes from Recipe editor.

---

## 52. Modifier Effect Editor Extension

Extend Phase 7 Modifier configuration so authorized users can bind approved `ADD`, `REMOVE`, and `ADJUST` effects to real Inventory Items.

Validate against Menu Item/Recipe context.

Do not post stock transactions when configuring effects.

---

## 53. Purchasing UI

Support:

```text
Supplier management
Supplier Item mapping
Draft PO creation
PO line editing
Submit PO
View receiving progress
Receive shipment
```

Show ordered vs received quantities.

Keep expected PO cost and actual receiving cost distinct.

---

## 54. Inventory Count UI

Support:

```text
Start count
Enter physical quantities
Review expected vs counted
Submit count
Manager approval
Post variances
```

Do not let editing count lines directly mutate Inventory balances before approval.

---

## 55. Transaction History UI

Provide a read-only operational ledger view with filters such as:

```text
Location
Inventory Item
Transaction type
Business date/date range
Reference
```

Display exact quantities/units and cost information only when authorized.

No editing/deleting of posted transactions.

---

## 56. Unit Tests: Product Conversions

Test:

```text
generic UOM conversion
product-specific package conversion
multi-step deterministic path where approved
incompatible conversion rejected
missing conversion rejected
exact quantity preservation
cycle/invalid conversion configuration rejected
```

Do not use floating point.

---

## 57. Unit Tests: Recipe Ingredients

Test:

```text
DRAFT revision ingredient creation
published revision ingredient immutability
positive exact quantity
unit compatibility
cross-organization Inventory Item rejected
current/effective Recipe revision retains correct ingredients
```

---

## 58. Unit Tests: Modifier Inventory Effects

Test:

```text
ADD effect
REMOVE effect
ADJUST positive
ADJUST negative
substitution as REMOVE + ADD
invalid item/context rejected
unit incompatibility rejected
no ledger posting from configuration
```

---

## 59. Unit Tests: Inventory Posting

Test:

```text
RECEIVE positive delta
CONSUME negative delta
WASTE negative delta
ADJUST_INCREASE
ADJUST_DECREASE
COUNT_INCREASE
COUNT_DECREASE
business date resolution
base quantity conversion
negative inventory policy
```

Test exact resulting balance.

---

## 60. Unit Tests: Weighted Average Cost

Test examples including:

```text
10 @ 2.0000 + receive 10 @ 3.0000 -> 20 @ 2.5000
zero existing quantity -> receipt cost establishes average
multiple receipts
high precision cost
rounding policy
```

Test both approved negative-balance receipt cases: preserve average while QOH remains nonpositive, and use actual receipt base-unit cost when a receipt crosses above zero.

---

## 61. Unit Tests: Purchasing

Test:

```text
PO line exact total
PO total exact sum
supplier purchase conversion
remaining quantity after partial receipts
over-receipt handling
status transitions
```

---

## 62. Unit Tests: Counts

Test:

```text
expected snapshot
counted quantity
positive variance
negative variance
zero variance
approval transaction types
post-snapshot activity policy
```

---

## 63. Integration Tests: Ledger and Balance

Test:

```text
post transaction
ledger immutable row created
balance projection updated atomically
balance equals ledger sum
failed posting leaves neither ledger nor balance partial write
location/item integrity
optimistic/concurrency behavior
```

High-value concurrency test: simultaneous postings for the same Item/Location produce a correct final balance with no lost updates.

---

## 64. Integration Tests: Receiving

Test:

```text
submit PO does not change stock
receive full PO
receive partial PO
second receipt completes PO
actual receipt cost preserved
RECEIVE ledger entries posted
weighted-average cost updated
failure atomicity
unauthorized receive denied
```

---

## 65. Integration Tests: Waste/Adjustments

Test:

```text
waste decreases stock
reason required
manual increase/decrease
permission enforcement
exact units/conversion
negative-stock rule
history remains append-only
```

---

## 66. Integration Tests: Inventory Counts

Test:

```text
start DRAFT count
capture expected quantities
enter counts
submit
approve
variances post ledger rows
balance reconciles
count cannot approve twice
stale version rejected
post-snapshot ledger activity follows approved policy
```

---

## 67. Integration Tests: Recipe Linkage

Test:

```text
Recipe DRAFT revision links Inventory Items
publish revision
ingredient rows become immutable
new DRAFT revision may change ingredients
previous published version preserved
Modifier effects bind only valid Inventory Items
```

No stock movement should result from these configuration actions.

---

## 68. Integration Tests: Low Stock

Test:

```text
QOH above reorder threshold -> excluded
QOH equal threshold -> included according to approved <= rule
QOH below -> included
suggested quantity exact
negative QOH handled
location-specific configuration
```

---

## 69. E2E: Inventory Receiving

Playwright scenario:

```text
Authorized manager
 -> create/open PO
 -> submit
 -> receive partial/full shipment
 -> inventory on-hand changes only after receipt
 -> PO status updates
```

Verify exact quantities in UI.

---

## 70. E2E: Waste/Adjustment

Scenario:

```text
Authorized inventory user
 -> select item
 -> record waste/reason
 -> QOH decreases
 -> ledger history shows WASTE
```

Unauthorized role cannot post adjustment.

---

## 71. E2E: Inventory Count

Scenario:

```text
Start count
 -> enter physical quantity
 -> submit
 -> approve
 -> variance ledger transaction appears
 -> balance equals approved physical result according to count policy
```

---

## 72. E2E: Recipe Ingredient Editing

Scenario:

```text
Authorized Recipe editor
 -> create DRAFT Recipe revision
 -> add Inventory Item ingredients with quantities/units
 -> publish
 -> published revision read-only
```

Verify no Inventory balance changes.

---

## 73. Seed Data

Use idempotent Phase 8 seeds for a modest Inventory demonstration.

Recommended examples should correspond to Phase 7 demo Recipe/Menu data without creating a giant fictional catalog.

Potential Items:

```text
GROUND_BEEF
BRIOCHE_BUN
AMERICAN_CHEESE
BACON
TITOS_VODKA
LIME_JUICE
```

Seed Suppliers/Supplier Items only as needed for demo purchasing.

Do not seed fake posted Inventory transactions as permanent stable configuration unless explicitly needed. Operational ledger test data belongs in fixtures.

---

## 74. Seed Idempotency

Repeated seed must not duplicate:

```text
Inventory Items
Item/Location configuration
product conversions
Suppliers
Supplier Items
```

Stable business codes identify reference seed rows rather than fixed UUIDs.

---

## 75. Migration Requirements

Generate and review Phase 8 migrations.

Verify:

```text
Existing Phase 7 DB
 -> Phase 8 migrations
 -> success
```

and:

```text
Empty test DB
 -> all Phase 1-8 migrations
 -> expected schema
```

Second `db:generate` must report no unexplained drift.

Do not rewrite historical migrations.

---

## 76. Reset/Seed Regression

Use the established safe/disposable database lifecycle:

```text
npm run db:reset
npm run db:seed
```

Verify Phase 1-8 stable configuration reconstructs idempotently.

Do not weaken remote/production reset protections.

---

## 77. Prior-Phase Regression

Preserve all Phase 1-7 functionality, including:

```text
Auth/RBAC
HR privacy
Scheduling
Seating
Reservations/Waitlist
Menu/Recipe pricing/modifier contracts
Recipe history
```

Do not expose guest or HR data through Inventory queries.

Do not create customer Orders.

---

## 78. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies must remain clean or findings require review.

Do not add unnecessary accounting, ERP, supplier API, AI, or forecasting libraries.

Preserve DEV-001 unless intentionally reevaluated.

---

## 79. Documentation Updates

Document:

- Inventory Item as Recipe ingredient identity
- Generic vs product-specific UOM conversion
- Inventory ledger authority
- Balance projection/reconciliation
- Approved negative inventory policy
- Weighted-average costing and rounding policy
- Recipe Version Ingredient behavior
- Modifier Inventory effects
- Supplier/Supplier Item model
- PO lifecycle
- Receiving/partial receiving
- Actual vs ordered cost
- Waste/adjustments
- Approved Inventory Count snapshot/activity policy
- Par/reorder semantics
- Phase 9 Order consumption extension point

---

## 80. Phase 8 Validation Checklist

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

Perform safe reset/reconstruction in the established disposable environment.

Verify:

```text
PostgreSQL health                  PASS
/api/health                        PASS
migration generation               PASS
migration application              PASS
empty DB reconstruction            PASS
schema drift                       NONE
seed idempotency                   PASS
Inventory Item integrity           PASS
product conversions                PASS
Recipe Version Ingredients         PASS
Modifier Inventory effects         PASS
ledger posting                     PASS
ledger/balance reconciliation      PASS
posting concurrency                PASS
weighted-average cost              PASS
Supplier/Supplier Item             PASS
PO lifecycle                       PASS
PO submit != stock                 PASS
full receiving                     PASS
partial receiving                  PASS
actual receipt cost                PASS
waste                              PASS
manual adjustments                 PASS
paired location transfers          PASS
Inventory count                    PASS
count variance ledger              PASS
low-stock/reorder query            PASS
prior-phase regressions            PASS
production dependency audit        CLEAN
allow_negative_inventory default false                 PASS
only opted-in CONSUME may post below zero              PASS
WASTE/ADJUST_DECREASE/COUNT_DECREASE remain nonnegative PASS
negative-balance receipt costing                       PASS
ROUND_HALF_UP persisted-cost basis                     PASS
count activity acknowledgement and current-QOH variance PASS
over-receipt rejected without override                 PASS
no preferred Supplier or implicit selection            PASS
```

---

## 81. Phase 8 Deliverables

Phase 8 should leave:

```text
✓ inventory_items
✓ inventory_item_locations
✓ inventory_item_unit_conversions
✓ recipe_version_ingredients
✓ modifier_inventory_effects
✓ inventory_transactions
✓ inventory_balances if projection approved
✓ suppliers
✓ supplier_items
✓ purchase_orders
✓ purchase_order_lines
✓ purchase_order_receipts
✓ purchase_order_receipt_lines
✓ inventory_counts
✓ inventory_count_lines

✓ authoritative append-only stock ledger
✓ exact QOH calculations
✓ ledger/balance reconciliation
✓ product/package conversions
✓ weighted-average costing
✓ Recipe revisions linked directly to Inventory Items
✓ Modifier ADD/REMOVE/ADJUST tied to Inventory Items

✓ PO lifecycle
✓ no stock change on PO submission
✓ partial/full receiving
✓ actual receipt cost preservation
✓ RECEIVE ledger posting
✓ waste
✓ manual adjustments
✓ paired Location transfer movements
✓ physical count and variance posting
✓ par/reorder/low-stock queries

✓ Inventory/Purchasing RBAC
✓ responsive Inventory/Purchasing UI
✓ idempotent reference configuration seeds

✓ unit tests
✓ PostgreSQL concurrency/integration tests
✓ Playwright tests
✓ Phase 0-7 regressions green
✓ production dependency audit clean
✓ no Orders/Kitchen/Settlement domain prematurely added
```

---

## 82. Phase 8 Definition of Done

Phase 8 is complete when the application can demonstrate:

```text
Supplier PO
   -> SUBMITTED
   -> no stock change
   -> Receive goods
   -> RECEIVE ledger transaction
   -> QOH increases
   -> weighted-average cost updates
```

and:

```text
Recipe Revision
   -> Inventory Item ingredient requirements
   -> exact quantities/UOM
   -> no stock change until a future operational consumption event
```

and:

```text
Physical Count
   -> expected snapshot
   -> counted quantity
   -> approved variance
   -> compensating COUNT ledger transaction
   -> reconciled QOH
```

The system proves:

- Inventory ledger is authoritative history.
- Posted ledger rows are not edited/deleted normally.
- QOH derives from/reconciles with the ledger.
- PO submission does not increase stock.
- Receiving is atomic with ledger/balance/cost updates.
- Recipe configuration does not consume stock.
- Exact quantity/cost arithmetic is preserved.
- Published Recipe revisions remain immutable.
- Inventory Item identity is used directly by Recipe ingredients.
- No customer Orders exist yet.
- Database reconstruction requires no manual SQL.
- Prior phases remain green.
- Each of the six approved policies has focused automated coverage and matches implementation behavior.

---

## 83. Required Phase 8 Completion Report

Provide:

```text
PHASE 8 COMPLETION REPORT

Environment
- Node:
- npm:
- Next.js:
- PostgreSQL:
- Drizzle ORM:
- Drizzle Kit:
- Exact quantity/cost arithmetic approach:

Inventory Schema
- inventory_items: PASS / FAIL
- inventory_item_locations: PASS / FAIL
- inventory_item_unit_conversions: PASS / FAIL
- recipe_version_ingredients: PASS / FAIL
- modifier_inventory_effects: PASS / FAIL
- inventory_transactions: PASS / FAIL
- inventory_balances: PASS / FAIL / N/A
- suppliers: PASS / FAIL
- supplier_items: PASS / FAIL
- purchase_orders: PASS / FAIL
- purchase_order_lines: PASS / FAIL
- purchase_order_receipts: PASS / FAIL
- purchase_order_receipt_lines: PASS / FAIL
- inventory_counts: PASS / FAIL
- inventory_count_lines: PASS / FAIL

Recipe/Modifier Integration
- Recipe Version -> Inventory Item: PASS / FAIL
- Published Recipe immutability: PASS / FAIL
- Exact ingredient quantities: PASS / FAIL
- UOM compatibility: PASS / FAIL
- Modifier ADD: PASS / FAIL
- Modifier REMOVE: PASS / FAIL
- Modifier ADJUST: PASS / FAIL
- Configuration creates no stock movement: PASS / FAIL

Ledger
- Append-oriented ledger: PASS / FAIL
- Base quantity conversion: PASS / FAIL
- QOH calculation: PASS / FAIL
- Balance projection: PASS / FAIL / N/A
- Ledger/balance reconciliation: PASS / FAIL
- Concurrent posting safety: PASS / FAIL
- Negative stock policy: describe / PASS / FAIL
- `allow_negative_inventory` defaults false: PASS / FAIL
- Only opted-in `CONSUME` may go negative: PASS / FAIL
- `WASTE`/`ADJUST_DECREASE`/`COUNT_DECREASE` cannot go negative: PASS / FAIL
- BusinessDateService usage: PASS / FAIL

Costing
- Weighted-average policy: PASS / FAIL
- `ROUND_HALF_UP` to persisted `NUMERIC(14,4)` after each receipt: PASS / FAIL
- Exact `NUMERIC(14,4)` cost: PASS / FAIL
- Zero-balance receipt: PASS / FAIL
- Multiple receipts: PASS / FAIL
- Negative-balance costing policy: describe / N/A / PASS / FAIL
- Cost visibility authorization: PASS / FAIL

Purchasing
- Supplier configuration: PASS / FAIL
- Supplier Item conversion: PASS / FAIL
- Draft PO: PASS / FAIL
- Submit PO: PASS / FAIL
- PO submit changes no stock: PASS / FAIL
- Partial receipt: PASS / FAIL
- Full receipt: PASS / FAIL
- Over-receipt policy: describe / PASS / FAIL
- Over-receipt manager override absent: PASS / FAIL
- Preferred Supplier field/implicit selection absent: PASS / FAIL
- Actual receipt cost preserved: PASS / FAIL
- Receiving ledger/cost atomicity: PASS / FAIL

Inventory Operations
- Paired TRANSFER_OUT/TRANSFER_IN: PASS / FAIL
- Transfer same-Organization/location authorization: PASS / FAIL
- Transfer source/destination reconciliation: PASS / FAIL
- Waste: PASS / FAIL
- Manual increase/decrease: PASS / FAIL
- Reason/provenance: PASS / FAIL
- Inventory count lifecycle: PASS / FAIL
- Expected snapshot: PASS / FAIL
- Post-snapshot activity policy: describe / PASS / FAIL
- Acknowledgement actor/timestamp stored when activity exists: PASS / FAIL
- Count variance posts against current QOH, not direct-set count: PASS / FAIL
- Count approval: PASS / FAIL
- Variance ledger posting: PASS / FAIL

Replenishment
- Par level: PASS / FAIL
- Reorder level: PASS / FAIL
- Reorder target: PASS / FAIL
- Low stock query: PASS / FAIL
- Suggested reorder: PASS / FAIL
- No automatic PO submission: PASS / FAIL

Authorization
- inventory.view: PASS / FAIL
- inventory.receive: PASS / FAIL
- inventory.adjust: PASS / FAIL
- inventory.count: PASS / FAIL
- inventory.waste: PASS / FAIL
- cost access: PASS / FAIL
- purchasing permissions: PASS / FAIL
- direct unauthorized API denied: PASS / FAIL

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

Business Domains Created Beyond Phase 8
- NONE expected

Created / Modified
- Summarize schema, migrations, Inventory/Purchasing modules, Recipe integration, permissions, UI, seeds, tests, and documentation.

Architecture Deviations
- None / describe

Outstanding Phase 8 Issues
- None / describe and blocking status

Phase 9 Readiness
- READY / NOT READY
```

---

## 84. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-8-Inventory-Purchasing.md`, start a fresh Copilot chat and use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 8 implementation plans completely. Treat `README.md` as the architectural source of truth. Derive current state from repository source, migrations, tests, and documentation rather than prior chat history.
>
> Review the completed Phase 0 through Phase 7 implementation before modifying files. Implement Phase 8 only: Inventory & Purchasing, including Inventory Items, location stock configuration, product-specific package conversions, the deferred Recipe-Version-to-Inventory-Item ingredient relationship, persisted Modifier ADD/REMOVE/ADJUST effects using Inventory Items, append-oriented Inventory ledger transactions, exact quantity-on-hand, balance projection/reconciliation if approved, weighted-average cost, Suppliers, Supplier Items, Purchase Orders, PO lines, partial/full receiving, actual receipt costs, waste, manual adjustments, Inventory Counts and variance postings, par/reorder/low-stock queries, Inventory/Purchasing RBAC, responsive UI, seeds, migrations, and required tests.
>
> Preserve these boundaries: Recipe requirement is not stock; saving Recipe/Modifier configuration never changes Inventory; PO submission does not increase stock; only receiving posts RECEIVE transactions; posted Inventory history is append-oriented; customer Orders do not exist until Phase 9; Kitchen/Bar tickets do not exist until Phase 10.
>
> Use exact decimal arithmetic and Phase 7 UOM concepts. Recipes must reference Inventory Items directly, not a duplicate ingredient/component catalog. Published Recipe revisions remain immutable. Preserve Phase 1 migration/transaction/test architecture, Phase 2 RBAC, Phase 3 HR privacy, Phase 4 Scheduling, Phase 5 Seating, Phase 6 Reservations/Waitlist, Phase 7 Menu/Recipe contracts, reset safeguards, and DEV-001.
>
> Before modifying files, inspect the repository and provide a concise Phase 8 execution plan. If README does not clearly settle negative inventory, weighted-average rounding/negative-balance costing, Inventory Count activity during a count, over-receiving, preferred Supplier selection, or another material Inventory policy, stop and explain the ambiguity, options, recommendation, and impact before implementing it.
>
> After implementation, run the complete Phase 8 validation suite and provide the full Phase 8 Completion Report. Stop before changing approved architecture if a material conflict is discovered.

---

## Final Guardrail

Phase 8 creates authoritative stock and purchasing history without implementing customer Orders.

```text
Recipe Version
   + Ingredient requirements
        |
        v
Inventory Items
   + Supplier/package configuration
   + Ledger transactions
   + QOH/cost projection
        |
        +-- Receiving/Waste/Counts now
        |
        +-- Phase 9 Order consumption later
```

Do not collapse procurement intent, stock movement, Recipe configuration, and future Order consumption into one operation.
