# Phase 10: Kitchen & Bar Fulfillment Implementation Plan

## Purpose

Phase 10 implements Kitchen and Bar fulfillment for submitted restaurant Orders. It consumes the immutable Order Item, Modifier, preparation-routing, and send-batch snapshots created in Phase 9 and turns them into station-specific fulfillment work without implementing payment or Settlement.

Before starting, read completely:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 9 implementation plans
5. This document

`README.md` remains the architectural source of truth.

Derive current application state from source, migrations, tests, and committed documentation rather than assumptions from prior Copilot conversations.

## Approved Phase 10 Policies

Approved 2026-10-08. These decisions replace conflicting recommendations later in this plan and are binding for schema, services, UI, tests, and completion reporting.

1. Fulfillment item states are exactly `NEW`, `PREPARING`, `READY`, `COMPLETED`, and `CANCELLED`. The normal path is `NEW -> PREPARING -> READY -> COMPLETED`. There is no direct `NEW -> READY`; `COMPLETED` and `CANCELLED` are terminal. Do not add `QUEUED` or `IN_PROGRESS` aliases.
2. Create one ticket per Order Submission + Prep Station. Ticket status is derived, never separately mutable: all cancelled => `CANCELLED`; all terminal with at least one completed => `COMPLETED`; all non-cancelled ready/completed with at least one ready => `READY`; otherwise any preparing => `PREPARING`; otherwise => `NEW`.
3. Create one station work item for each station ID in the submitted routing snapshot. An empty routing snapshot creates no station work; Phase 10 does not invent a route or re-resolve Menu configuration. Each created item receives the same immutable Order, item, modifier, special-instruction, route, and submission context. Overall Order Item readiness/completion is derived from all station work across all attempts. Multiple routes never repeat original Inventory consumption.
4. Queue ordering is FIFO by `submitted_at ASC`, then stable ticket/item ID. No priority or Rush workflow is implemented.
5. EXPO is a read-only consolidated view. It is not a preparation hop. Defer Courses and Hold/Fire; submitted work enters `NEW` immediately.
6. `UNPREPARED` is valid only if every fulfillment attempt for the Order Item is `NEW`. Otherwise require `PREPARED_OR_DISCARDED`. For `UNPREPARED`, cancel every active station item and reverse both original and Remake consumption through the trusted Order `SALE_REVERSAL` flow. For `PREPARED_OR_DISCARDED`, retain all consumption, do not create Waste, cancel `NEW`/`PREPARING`/`READY`, and preserve `COMPLETED`/`CANCELLED` history. All participating writes are atomic.
7. Remake is an explicit, reasoned, actor/timestamped, idempotent new attempt linked to the original Order Item and fulfillment attempt. It does not add a charge or alter Order snapshots/totals. Additional `CONSUME` uses the immutable original `order_item_inventory_consumption` snapshot through a narrow trusted capability and Phase 8 rules. Insufficient stock rolls the entire Remake back.
8. No generic Recall/Reopen exists. `READY -> PREPARING`, or transitions out of `COMPLETED`/`CANCELLED`, are rejected. Re-preparation uses Remake.
9. Create tickets and work items inside the Phase 9 Order-submission transaction. Do not introduce an outbox, broker, Redis, cloud pub/sub, or in-memory event handoff for this phase.
10. Do not backfill historical submitted Order Items. Phase 10 work is created for submissions committed after the migration and explicit test/development fixtures only.
11. Preserve Phase 9 snapshots, exact arithmetic, BusinessDateService, location-aware RBAC, Inventory ledger authority, Takeout without a Table Session, Order remaining `OPEN`, and the Table Session `OPEN`-Order completion guard. No Settlement/payment or generic Inventory permissions for Kitchen/Bar users.

---

## 1. Phase 10 Objectives

Implement:

```text
Phase 9 Order Submission
        |
        v
Fulfillment Router
        |
        +-------------------------------+
        |                               |
        v                               v
Prep Station Ticket                 Prep Station Ticket
GRILL / FRY / SALAD / EXPO          BAR
        |                               |
        +-- Ticket Items                +-- Ticket Items
        |                               |
        v                               v
Fulfillment Lifecycle             Fulfillment Lifecycle
```

Phase 10 must deliver:

- Fulfillment Tickets
- Fulfillment Ticket Items
- Station-specific routing
- Kitchen and Bar queues
- Phase 9 send-batch-to-ticket generation
- Ticket/item lifecycle history
- Queue ordering and age indicators
- Item start (`NEW -> PREPARING`) workflow
- Item ready workflow
- Served/completed workflow
- Ticket completion derived from item states
- Submitted Order Item void integration
- Controlled cancel behavior before preparation
- Prepared-item void behavior consistent with Phase 9
- Idempotent Remake operation with additional Inventory consumption
- Takeout fulfillment through the same routing model
- Read-only Expo view
- Kitchen/Bar permissions
- Responsive KDS-style operational UI
- Unit, PostgreSQL integration, concurrency, and Playwright coverage

---

## 2. Scope Boundary

Do not implement during Phase 10:

```text
payment tenders
credit-card processing
cash drawer
Settlement
Order closure through payment
split payments
refund settlement
fiscal receipts
customer-facing order tracking
external delivery integration
SMS/email notifications
full reporting dashboards
```

Phase 11 owns Settlement/payment and Order closure.

Do not weaken the Phase 9 rule that Orders remain `OPEN` until Phase 11 settlement closes them.

---

## 3. Critical Boundary: Submission vs Fulfillment

Phase 9 submission means the Order Item is commercially committed and Inventory consumption has been posted.

Phase 10 fulfillment means staff are preparing/serving that already-submitted item.

```text
Order Item SUBMITTED
        !=
Kitchen Item READY
```
Do not change Phase 9 Inventory-consumption timing merely because fulfillment now exists.

---

## 4. Critical Boundary: Use Submitted Snapshots

Fulfillment routing and display must use the immutable facts captured by Phase 9 submission.

Use:

```text
Order Item identity/snapshot
Menu Item snapshot
Modifier snapshots
special instructions
prep-routing snapshot
submission/send-batch identity
submission timestamp
```

Do not re-resolve current Menu Item names, Modifier labels, prices, or preparation routing for already submitted work.

A later Menu routing change must not move historical submitted work to a different station.

---

## 5. Critical Boundary: Kitchen/Bar State vs Order Commercial State

Fulfillment lifecycle is a separate operational dimension from Phase 9 Order Item state.

Phase 9:

```text
DRAFT
SUBMITTED
VOIDED
```

Phase 10:

```text
fulfillment-specific states
```

Do not replace `SUBMITTED` with Kitchen states in `order_items`.

Do not infer that READY or COMPLETED means the Order is paid or CLOSED.

---

## 6. Review Existing Foundation Before Changes

Before editing, inspect and confirm:

- Phase 0 through Phase 9 validation remains green.
- README fulfillment terminology is identified.
- Phase 7 prep stations and routing are understood.
- Phase 9 routing snapshots are understood.
- Phase 9 incremental send batches are understood.
- Phase 9 Order Item lifecycle is understood.
- Phase 9 void dispositions are understood.
- Phase 8 Inventory posting and provenance are understood.
- Phase 2 location-aware RBAC is understood.
- Shared transaction and concurrency architecture are understood.
- BusinessDateService is understood.
- No Settlement/payment domain exists yet.
- DEV-001 remains tracked.

Before coding, provide a concise Phase 10 execution plan based on actual repository state.

---

## 7. Fulfillment Ticket Model

Create a station-bound fulfillment header, using README names if already defined.

Approved table:

```text
fulfillment_tickets
```

Conceptual fields:

```text
id                    UUID PK
location_id           UUID FK
prep_station_id       UUID FK
order_id              UUID FK
order_submission_id   UUID FK
attempt_number         integer (1 for original; increasing for each Remake attempt)
submitted_at           TIMESTAMPTZ
immutable order/station/table display snapshots
created_at             TIMESTAMPTZ
```

One Order submission may create multiple tickets, one per destination station/routing group.

Do not assume one send batch equals one ticket.

---

## 8. Fulfillment Ticket Items

Create:

```text
fulfillment_ticket_items
```

Conceptual fields:

```text
id                    UUID PK
fulfillment_ticket_id UUID FK
order_item_id         UUID FK
status                NEW | PREPARING | READY | COMPLETED | CANCELLED
quantity              required
menu_item_code_snapshot required
menu_item_name_snapshot required
modifier_snapshots      required structured immutable snapshot
special_instructions_snapshot nullable
routing_snapshot      required/structured
submitted_at_snapshot TIMESTAMPTZ
started_at            TIMESTAMPTZ nullable
ready_at              TIMESTAMPTZ nullable
completed_at          TIMESTAMPTZ nullable
cancelled_at          TIMESTAMPTZ nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Do not require fulfillment clients to join mutable Menu configuration to render submitted items.

---

## 9. Fulfillment Status History

Create append-oriented history for fulfillment item state transitions.

Recommended:

```text
fulfillment_item_status_history
```

Conceptual fields:

```text
id                         UUID PK
fulfillment_ticket_item_id UUID FK
status                     required
reason                     nullable
changed_by_user_id         UUID nullable FK
occurred_at                TIMESTAMPTZ
created_at                 TIMESTAMPTZ
```

Ticket state is derived from its items and is never stored as a separately mutable value. Item history includes the initial `NEW` entry and every transition/cancellation with actor, timestamp, and reason.

---

## 10. Fulfillment Lifecycle Policy

README terminology is authoritative.

Approved item lifecycle:

```text
NEW
PREPARING
READY
COMPLETED
CANCELLED
```

The only normal transitions are `NEW -> PREPARING -> READY -> COMPLETED`; cancellation is performed only by the authorized Order void synchronization. There is no direct `NEW -> READY`, no backward transition, and no aliases.

---

## 11. Ticket Status

Ticket state is derived and not persisted. Apply this exact precedence:

```text
all items CANCELLED -> CANCELLED
all items terminal and at least one COMPLETED -> COMPLETED
all non-CANCELLED items READY or COMPLETED, with at least one READY -> READY
otherwise any PREPARING -> PREPARING
otherwise -> NEW
```

Cancelled items do not prevent remaining active work from advancing.

---

## 12. Routing from Phase 9 Send Batches

Phase 9 stores immutable prep-routing snapshots.

For each newly submitted Order Item:

```text
Order Submission
        |
        v
Create one ticket per Order Submission + destination Prep Station
        |
        +-- GRILL ticket
        +-- FRY ticket
        +-- SALAD ticket
        +-- BAR ticket
```

Do not re-query today's Menu routing.

---

## 13. Ticket Generation Transaction

Phase 10 ticket creation must be reliable and idempotent.

Generate fulfillment tickets/items inside the same PostgreSQL transaction as Phase 9 submission, including Order Item snapshots and Phase 8 Inventory consumption. If generation fails, roll back the entire submission. Database uniqueness/idempotency prevents duplicate work on retry. No historical submitted items are backfilled.

---

## 14. Duplicate Ticket Protection

Retries must not duplicate fulfillment work.

Required invariant:

```text
One Order Submission + Prep Station
        -> one ticket
One submitted Order Item + routing destination + attempt
        -> one fulfillment work item
```

Use database uniqueness/idempotency protection tied to:

```text
order_item_id
order_submission_id
prep_station/routing identity
```

Do not rely only on UI or process memory.

---

## 15. Multi-Station Routing

Create one fulfillment work item for every Prep Station ID in the immutable Phase 9 routing snapshot. Each station item receives the same submitted Order Item, modifier, special-instruction, order, and send-batch snapshots. Do not invent station-specific component or Recipe breakdowns. Overall Order Item readiness/completion is derived from all station work across all attempts using the approved aggregation rules. Routing to multiple stations never repeats the original Inventory consumption.

---

## 16. Kitchen vs Bar

Kitchen and Bar use the same fulfillment domain model.

Differences come from Prep Station configuration/routing, not separate incompatible ticket systems.

Examples:

```text
GRILL -> Kitchen
FRY -> Kitchen
SALAD -> Kitchen
BAR -> Bar
```

Do not create separate `kitchen_orders` and `bar_orders` with duplicated logic unless README explicitly requires separate domain models.

---

## 17. Expo Foundation

EXPO is a read-only consolidated operational view of station work. It creates no ticket/work item and adds no lifecycle hop. Explicit Course sequencing and Hold/Fire are deferred. Submitted work enters `NEW` immediately.

---

## 18. Takeout Fulfillment

TAKEOUT Orders use the same Phase 9 send-batch and Phase 10 prep-routing pipeline.

```text
TAKEOUT Order
   -> Send Batch
   -> GRILL/BAR/etc.
        -> NEW -> PREPARING -> READY -> COMPLETED
```

Do not require a Table Session.

Order type should be visible to station staff where operationally useful.

---

## 19. Dine-In Fulfillment Context

DINE_IN/BAR station views may display operational context such as:

```text
Order number
Table Session/table display identifiers
server display name
submission age
```

Physical table display is presentation context derived through the Table Session. Fulfillment records should not create a direct Order-to-physical-table ownership relationship.

---

## 20. Queue Ordering

Define deterministic queue ordering.

Approved FIFO order:

```text
submitted_at ascending
then stable ticket/item identifier
```

No priority or Rush workflow is implemented in Phase 10.

---

## 21. Priority

Priority is deferred. FIFO is the only queue ordering policy in Phase 10.

---

## 22. Ticket Age

Calculate age from immutable submission/ticket creation timestamps.

Expose durations such as:

```text
NEW/PREPARING age
total elapsed age
```

Do not persist continuously updating age values.

Use server time/instants consistently.

---

## 23. Start Item Workflow

Authorized station user transitions an eligible item:

```text
NEW -> PREPARING
```

Record actor/time in status history.

Use optimistic concurrency or locking to prevent duplicate conflicting transitions.

Do not change Inventory when preparation starts because Inventory was already consumed at Phase 9 submission.

---

## 24. Mark Ready Workflow

Authorized station user transitions:

```text
PREPARING -> READY
```

Direct `NEW -> READY` is rejected for every station, including simple Bar items.

Record actor/time.

Update/recompute ticket status transactionally.

---

## 25. Complete / Served Workflow

Phase 10 needs an operational final fulfillment state.

Approved transition:

```text
READY -> COMPLETED
```

For dine-in, COMPLETED means the fulfillment work has left the station / been served operationally. It does **not** mean the Order is paid or CLOSED.

For takeout, COMPLETED means prep handoff is complete, not settlement.

`COMPLETED` is the station handoff/served state and does not close the Order.

---

## 26. Ticket Completion

A station ticket completes only when all active ticket items have reached terminal fulfillment states according to policy.

Do not complete a ticket merely because one item is ready.

Keep cancelled/voided items visible in history.

---

## 27. Submitted Order Item Void Integration

Phase 9 permits a submitted item void with disposition:

```text
UNPREPARED
PREPARED_OR_DISCARDED
```

Phase 10 now has actual fulfillment state, so the validity of `UNPREPARED` can be checked.

Approved rule:

```text
all routed attempts NEW -> UNPREPARED allowed
any routed attempt PREPARING/READY/COMPLETED -> UNPREPARED denied
```

For `UNPREPARED`, cancel every active item across all attempts and use the existing Order `SALE_REVERSAL` workflow for both original submission and Remake consumption. For `PREPARED_OR_DISCARDED`, retain all consumption; cancel `NEW`, `PREPARING`, and `READY`; preserve `COMPLETED` and already `CANCELLED`. The disposition does not create Waste.

---

## 28. Void-to-Fulfillment Synchronization

When a submitted Item is voided:

### UNPREPARED

```text
Order Item -> VOIDED
Original and Remake Inventory -> SALE_REVERSAL
All active fulfillment attempts -> CANCELLED
```

### PREPARED_OR_DISCARDED

```text
Order Item -> VOIDED
All original and Remake Inventory consumption retained
NEW/PREPARING/READY -> CANCELLED
COMPLETED/CANCELLED -> preserved
```

Do not physically delete fulfillment rows.

Order void and fulfillment transition should be atomic where they share the same database transaction.

---

## 29. Prepared/Discarded Is Not Automatic Waste

Preserve Phase 9 policy:

```text
PREPARED_OR_DISCARDED
    !=
automatic WASTE ledger posting
```

If product is physically discarded and additional Waste tracking is desired, use the explicit Phase 8 Waste workflow.

Do not double-decrement Inventory for food already consumed at submission.

---

## 30. Remake / Re-Fire Foundation

Phase 10 implements the approved explicit Remake operation. A Remake is a new linked attempt and never rewinds original work.

---

## 31. Remake Inventory Policy

A true remake normally consumes additional ingredients.

Approved policy:

```text
Remake creates a new fulfillment attempt/work item
and posts additional Inventory CONSUME based on the original submitted Order Item's immutable Recipe/modifier consumption snapshot.
```

The customer is not charged again unless a separate Order Item is intentionally created.

Require reason/actor.

Remake requires `fulfillment.remake`, a reason, actor, timestamp, and idempotency key. It posts additional Inventory `CONSUME` using the immutable original `order_item_inventory_consumption` rows, never current Recipe/Menu configuration. Reuse Phase 8 conversion, costing, ledger, and `allow_negative_inventory` policy through a narrow trusted capability. Insufficient stock fails the entire transaction. Remake does not change Order Item price, discounts, snapshots, or subtotal and creates no new Order Item.

---

## 32. Remake Provenance

Persist enough provenance to connect:

```text
original Order Item
original fulfillment item
remake fulfillment item
reason
actor
additional Inventory CONSUME rows
```

Do not overwrite the original fulfillment attempt.

---

## 33. Recall / Reopen

Do not implement Recall/Reopen. `READY -> PREPARING`, transitions from `COMPLETED`, and transitions from `CANCELLED` are rejected. Re-preparation requires Remake.

---

## 34. Bump Behavior

If using KDS terminology, `bump` must map to one explicit domain transition.

Approved:

```text
READY -> COMPLETED
```

or the README-defined equivalent.

Do not let a UI "bump" button perform different domain actions depending on screen context without clear labeling.

---

## 35. Station Item Ownership

A fulfillment item belongs to its snapshotted prep station/routing destination.

Changing a Menu Item's current prep routing after submission does not move existing work.

If active work must be manually rerouted, require an explicit authorized reroute operation and preserve original/target station history.

Manual reroute is not implemented in Phase 10.

---

## 36. Station Deactivation

Do not allow deactivating a Prep Station in a way that strands active fulfillment work without an explicit operational resolution.

At minimum:

- Existing historical work remains visible.
- New routing stops using inactive station according to Menu configuration validation.
- Active `NEW`/`PREPARING` work must be resolved before structural deactivation where practical.

---

## 37. Fulfillment Query Model

Create purpose-built DTOs for station displays.

Expose only operationally required data:

```text
ticket/item ids
Order number
Order type
Table/session display context
submitted/send-batch time
Menu Item snapshot name
quantity
Modifier snapshot names
special instructions
fulfillment status
age timestamps
authorized action availability
```

Do not expose Menu price, discounts, Inventory costs, HR-sensitive data, or guest contact data to ordinary Kitchen/Bar views.

---

## 38. Kitchen/Bar Permissions

Use/extend centralized RBAC without synonyms.

Expected concepts include:

```text
`kitchen.view`, `kitchen.manage`, `bar.view`, `bar.manage`
fulfillment.start
fulfillment.ready
fulfillment.complete
fulfillment.remake
```

Exact codes should align with existing permission naming.

Do not grant Inventory adjustment permissions merely because a Kitchen user can request a remake.

---

## 39. Employee Qualification vs Application Authorization

Preserve prior boundaries.

Employee Position may determine who is operationally assigned to Kitchen/Bar jobs, but Security Role/permissions determine software actions.

Do not let a `COOK` Employee Position automatically grant KDS permissions.

Do not let a Kitchen Security Role make someone an Employee Cook.

---

## 40. Station Scope

Where appropriate, restrict users to their Location and permitted stations.

A Bar user should not automatically control another Location's Grill queue.

If station-level permission scoping is not implemented by the existing RBAC model, use Location permission plus explicit station action validation rather than inventing a parallel authorization framework.

---

## 41. KDS-Style UI

Create responsive operational views for:

```text
Kitchen Queue
Bar Queue
optional consolidated Expo view
```

Cards/columns should clearly show:

```text
Order number
Dine-in/Takeout
Table context where relevant
elapsed time
Item quantity/name
Modifiers
special instructions
status
submission round
```

Use touch-friendly actions.

Do not add complex graphical animations at the expense of correctness.

---

## 42. Queue Views

At minimum enable useful filters:

```text
Prep Station
Status
Order type
```

Sort by `submitted_at ASC`, then stable ticket/item identifier. No priority is exposed.

Do not allow client-only filters to become authorization boundaries.

---

## 43. Visual Aging

Provide clear UI indications for aging tickets/items using configured presentation thresholds if useful.

Example UI-only thresholds:

```text
normal
warning
late
```

Aging style does not change fulfillment state.

If thresholds become configurable, keep them as display settings rather than mixing them with core lifecycle logic.

---

## 44. Realtime Update Strategy

A KDS benefits from near-real-time updates, but do not introduce new infrastructure casually.

Use the simplest architecture consistent with README/current stack.

Potential approaches:

```text
short polling
server refresh
existing realtime/event mechanism if already implemented
```

Do not add WebSockets, Redis, message brokers, or cloud pub/sub solely for Phase 10 unless architecture explicitly requires it.

Use five-second short polling/server refresh; do not add realtime infrastructure for this phase.

---

## 45. Fulfillment Timing Metrics

Persist timestamps needed for later reporting:

```text
submitted/created
started
ready
completed
```

Do not build reporting dashboards now.

Ensure later phases can calculate:

```text
queue time
prep time
ready-to-complete time
total fulfillment time
```

---

## 46. No Menu Re-resolution

Station rendering must rely on submitted snapshots.

Tests must prove:

```text
Menu Item renamed after send -> old ticket unchanged
Modifier renamed after send -> old ticket unchanged
Routing changed after send -> old ticket still assigned to original station
```

---

## 47. No Inventory Re-resolution for Original Send

The original Phase 9 submission already posted consumption.

Starting, readying, or completing an existing fulfillment item must not post additional Inventory consumption.

Additional consumption occurs only through explicitly approved operations such as a true remake.

---

## 48. Ticket Generation for Existing Submitted Items

Migration/development environments may contain Phase 9 submitted Items before Phase 10 exists.

Do not silently backfill historical fulfillment tickets unless explicitly required.

For development/test fixtures, create Phase 10-suitable submitted data deliberately.

If production migration/backfill is needed later, design it as an explicit migration/operational task.

---

## 49. Concurrency

Use optimistic concurrency and transaction locks for state-changing operations.

Required scenario:

```text
Cook A marks item PREPARING
Cook B concurrently tries the same transition from stale NEW
        |
        v
One succeeds
Other receives conflict/idempotent result as appropriate
```

Do not silently overwrite timestamps/status.

---

## 50. Idempotent State Transitions

Define safe behavior for repeated identical requests caused by touch/double-click/retry.

Where appropriate:

```text
already PREPARING + same logical request
 -> return current success/result
```

but invalid backward/conflicting transitions remain errors.

Do not create duplicate status-history rows for idempotent retries.

---

## 51. Ticket Generation Atomicity

With same-transaction generation:

```text
Order submission + Inventory + fulfillment creation
```

must commit/rollback together.

If a durable outbox is already established instead, test that Order submission cannot permanently lose ticket creation.

Do not accept a state where an Item is submitted but no durable fulfillment work can ever be discovered.

---

## 52. Void Atomicity

Order Item void plus:

```text
Inventory reversal when UNPREPARED
Fulfillment cancellation/terminal update
Order histories
```

must be atomic where possible in the same PostgreSQL transaction.

Avoid partial commercial/fulfillment states.

---

## 53. Remake Atomicity

For the approved Remake operation:

```text
Create remake fulfillment attempt
Post additional Inventory consumption
Record reason/provenance
```

must be one transaction.

If Inventory cannot be consumed under Phase 8 rules, remake creation fails entirely.

---

## 54. Business Date

Fulfillment operational timestamps use actual instants.

Where business date is persisted for fulfillment/reporting, use BusinessDateService.

Do not derive business date by truncating the server timestamp.

---

## 55. Order Closure Remains Phase 11

Fulfillment completion does not close the Order.

```text
All fulfillment COMPLETED
        |
        v
Order still OPEN
        |
        v
Phase 11 Settlement
        |
        v
Order CLOSED
```

Do not add automatic Order closure when all Kitchen/Bar items are complete.

---

## 56. Table Session Completion Remains Guarded

Because Phase 9 blocks Table Session completion while an associated Order is OPEN, Phase 10 must not bypass that guard.

Even if all fulfillment work is completed:

```text
Order OPEN -> Table Session completion blocked
```

until Phase 11 closes/settles the Order.

---

## 57. Takeout Completion Boundary

A Takeout fulfillment item/ticket can reach COMPLETED while its Order remains OPEN pending Phase 11 settlement.

Do not introduce a separate fake Table Session completion concept for Takeout.

---

## 58. Seeds

Do not seed permanent active fulfillment tickets as stable configuration.

Use fixtures for ticket/order operational data.

Phase 10 seeds may update:

```text
permissions
role grants
station display settings if stable/required
```

Do not seed Settlement/payment records.

---

## 59. Unit Tests: Routing

Test:

```text
GRILL routed item -> GRILL ticket
BAR routed item -> BAR ticket
multi-item same station -> grouped according to approved ticket grouping
multi-station send -> separate station tickets
routing snapshot used rather than live Menu routing
inactive/invalid routing behavior
```

---

## 60. Unit Tests: Lifecycle

Test the approved state machine.

Approved transitions:

```text
NEW -> PREPARING
PREPARING -> READY
READY -> COMPLETED
NEW -> READY rejected
backward transition rejected
COMPLETED/CANCELLED are terminal; restart requires Remake
```

---

## 61. Unit Tests: Ticket Aggregation

Test ticket-state derivation from item states, including mixed states and cancelled items.

Examples:

```text
all NEW
one PREPARING
all non-CANCELLED work READY/COMPLETED with at least one READY
mixed CANCELLED and active work
all CANCELLED
all terminal with at least one COMPLETED
```

Lock down exact approved semantics.

---

## 62. Unit Tests: Queue Sorting

Test stable deterministic FIFO ordering for:

```text
submitted_at ascending
stable tie-break
```

No randomness.

---

## 63. Unit Tests: Void Compatibility

Test:

```text
all attempts NEW + UNPREPARED -> allowed
any attempt PREPARING + UNPREPARED -> denied
READY + UNPREPARED -> denied
COMPLETED + UNPREPARED -> denied
PREPARED_OR_DISCARDED cancels NEW/PREPARING/READY and preserves COMPLETED/CANCELLED
```

---

## 64. Unit Tests: Remake

Test:

```text
fulfillment.remake permission and reason required
new linked attempt created for every original routed station
original attempt preserved
same historical Order Item, Modifier, and routing snapshots used
additional exact Inventory CONSUME from original consumption rows
Menu/Recipe changes do not alter Remake quantities
Inventory shortage rejects Remake atomically
same idempotency key returns prior result without duplicate postings
UNPREPARED void reverses original and Remake consumption through SALE_REVERSAL
```

---

## 65. Integration Tests: Ticket Generation

High-value test:

```text
Phase 9 send batch contains:
- Burger -> GRILL
- Fries -> FRY
- Cocktail -> BAR
        |
        v
GRILL ticket
FRY ticket
BAR ticket
```

Verify snapshot names/modifiers/instructions and send-batch provenance.

---

## 66. Integration Tests: Generation Idempotency

Test retry/reprocessing:

```text
same submitted Item/routing
        |
        v
no duplicate fulfillment item/ticket work
```

Verify submission rollback leaves no submitted Order Items, Inventory movements, tickets, work items, or histories.

---

## 67. Integration Tests: Lifecycle Concurrency

Test concurrent start/ready/complete attempts.

Verify:

```text
one valid transition
no duplicate histories
no lost update
correct timestamps
```

---

## 68. Integration Tests: Void Synchronization

Test:

```text
NEW Item
 -> Phase 9 UNPREPARED void
 -> fulfillment CANCELLED
 -> SALE_REVERSAL posted
```

and:

```text
PREPARING Item
 -> UNPREPARED void denied
 -> PREPARED_OR_DISCARDED void allowed according to permission/policy
 -> no Inventory restoration
```

Original CONSUME rows remain.

---

## 69. Integration Tests: Fulfillment Completion

Test:

```text
all Ticket Items READY/COMPLETED
 -> Ticket completion according to policy
 -> Order remains OPEN
 -> no extra Inventory movement
```

---

## 70. Integration Tests: Takeout

Test:

```text
TAKEOUT send batch
 -> station tickets generated
 -> no Table Session required
 -> lifecycle completes normally
 -> Order remains OPEN
```

---

## 71. Integration Tests: Snapshot Immutability

After send:

```text
rename Menu Item
rename Modifier
change prep routing
```

Verify existing fulfillment work remains unchanged.

New submissions use new configuration according to Phase 9 submission rules.

---

## 72. Integration Tests: Remake + Inventory

Test:

```text
original Item already consumed inventory
request remake
additional CONSUME postings created
new fulfillment attempt created
original Order Item price unchanged
Order subtotal unchanged
```

Ensure retry cannot double-consume remake Inventory.

---

## 73. Authorization Integration Tests

Test directly:

```text
kitchen.view / bar.view
fulfillment.start
fulfillment.ready
fulfillment.complete
fulfillment.remake
location scope
station scope where implemented
unauthorized direct API denied
```

Do not rely on hidden buttons.

---

## 74. E2E: Kitchen Queue

Playwright scenario:

```text
Create/submit Order with GRILL item
 -> Kitchen user sees NEW item
 -> Start
 -> Ready
 -> Complete/Bump
 -> item leaves active queue / appears completed according to UI
```

Order remains OPEN.

---

## 75. E2E: Bar Queue

Scenario:

```text
Submit cocktail
 -> Bar queue
 -> start
 -> ready
 -> complete
```

Verify Kitchen queue does not receive Bar-routed work.

---

## 76. E2E: Multi-Station Send

Scenario:

```text
One send batch contains food + drink
 -> food appears Kitchen
 -> drink appears Bar
 -> both retain same Order/send context
```

---

## 77. E2E: Void Before Preparation

Scenario:

```text
Submit Item
 -> fulfillment NEW
 -> authorized void UNPREPARED
 -> fulfillment cancelled
 -> Item visibly VOIDED in Order history
```

Inventory compensation should be asserted at integration level.

---

## 78. E2E: Takeout Fulfillment

Scenario:

```text
Takeout Order submitted
 -> station queue
 -> ready/complete
 -> no Table Session exists
```

---

## 79. E2E: Authorization

Representative scenario:

```text
view-only Kitchen user
 -> sees queue
 -> cannot start/ready/complete
```

Verify direct API denial.

---

## 80. Migration Requirements

Generate/review Phase 10 migration(s).

Verify:

```text
Existing Phase 9 DB
 -> Phase 10 migration(s)
 -> success
```

and:

```text
Empty isolated DB
 -> all Phase 1-10 migrations
 -> expected schema
```

Second `db:generate` reports no unexplained drift.

Do not rewrite historical migrations.

---

## 81. Reset/Seed Regression

Use the established safe/disposable lifecycle:

```text
npm run db:reset
npm run db:seed
```

Verify Phase 1-10 stable configuration reconstructs idempotently.

Do not seed active fulfillment work into normal development reference seeds.

---

## 82. Prior-Phase Regression

Preserve all Phase 1-9 behavior, especially:

```text
Order submission idempotency
Order pricing/discount snapshots
Recipe revision snapshots
Inventory CONSUME provenance
Order void dispositions
SALE_REVERSAL behavior
Table Session OPEN-Order completion guard
Takeout no-table behavior
```

Phase 10 must extend these workflows, not fork them into competing interpretations.

---

## 83. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies remain clean or findings require review.

Do not add Redis, message brokers, cloud pub/sub, or specialized realtime infrastructure solely for Phase 10 unless approved architecture requires it.

Preserve DEV-001 unless intentionally reevaluated.

---

## 84. Documentation Updates

Document:

- Fulfillment Ticket and Ticket Item model
- Kitchen/Bar unified domain
- exact item states: `NEW`, `PREPARING`, `READY`, `COMPLETED`, `CANCELLED`
- ticket aggregation precedence; ticket state is derived, never separately mutable
- Phase 9 send-batch routing
- immutable routing snapshot usage
- same-transaction ticket-generation durability/idempotency
- FIFO queue ordering; no priority/Rush
- ticket aging semantics
- void/fulfillment compatibility
- all-attempt prepared vs unprepared void behavior
- explicit idempotent Remake and its Inventory/reversal provenance
- no Recall/Reopen; terminal states remain terminal
- read-only EXPO; Courses and Hold/Fire deferred
- realtime/polling strategy
- Takeout fulfillment
- Phase 11 Order-closure boundary

---

## 85. Phase 10 Validation Checklist

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

Use the established disposable DB for destructive reset/reconstruction.

Verify:

```text
PostgreSQL health                    PASS
/api/health                          PASS
migration generation                 PASS
migration application                PASS
empty DB reconstruction              PASS
schema drift                         NONE
seed idempotency                     PASS
send-batch routing                   PASS
Kitchen routing                      PASS
Bar routing                          PASS
routing snapshot immutability        PASS
same-transaction ticket generation  PASS
ticket generation idempotency        PASS
fulfillment lifecycle                PASS
ticket aggregation                   PASS
FIFO queue ordering                  PASS
concurrency                          PASS
void synchronization                 PASS
UNPREPARED reversal integration      PASS
PREPARED_OR_DISCARDED behavior       PASS
all-attempt void cancellation        PASS
Remake idempotency                   PASS
Remake additional Inventory CONSUME  PASS
Remake shortage atomic rollback      PASS
Remake SALE_REVERSAL on UNPREPARED    PASS
Takeout fulfillment                  PASS
EXPO read-only aggregation           PASS
Order remains OPEN                   PASS
Table Session guard preserved        PASS
authorization                        PASS
prior-phase regressions              PASS
production dependency audit          CLEAN
```

---

## 86. Phase 10 Deliverables

Phase 10 should leave:

```text
✓ fulfillment_tickets
✓ fulfillment_ticket_items
✓ fulfillment_item_status_history

✓ Phase 9 send-batch routing
✓ Kitchen/Bar station queues
✓ immutable submitted snapshot display
✓ FIFO queue ordering
✓ queue age metrics
✓ NEW/PREPARING/READY/COMPLETED/CANCELLED lifecycle
✓ ticket-state aggregation
✓ idempotent ticket generation
✓ concurrency-safe transitions

✓ UNPREPARED void -> all active attempt cancellation + SALE_REVERSAL for original and Remake consumption
✓ prepared-state void validation
✓ no automatic Waste from void
✓ idempotent Remake attempts and additional Inventory CONSUME
✓ no Recall/Reopen workflow

✓ Dine-in fulfillment
✓ Takeout fulfillment
✓ read-only Expo view with overall multi-station readiness
✓ Kitchen/Bar RBAC
✓ responsive KDS-style UI
✓ simple POC update strategy without unnecessary infrastructure

✓ unit tests
✓ PostgreSQL integration/concurrency tests
✓ Playwright tests
✓ Phase 0-9 regressions green
✓ production audit clean
✓ no Settlement/payment domain prematurely implemented
```

---

## 87. Phase 10 Definition of Done

Phase 10 is complete when a submitted Order can flow:

```text
Phase 9 Send Batch
       |
       +-- Burger -> GRILL
       +-- Fries -> FRY
       +-- Cocktail -> BAR
       |
       v
Station Queues
       |
       v
NEW
       |
       v
PREPARING
       |
       v
READY
       |
       v
COMPLETED
```

while proving:

- Fulfillment uses immutable Phase 9 snapshots.
- Kitchen and Bar are station routes inside one fulfillment model.
- Ticket generation is durable and idempotent.
- No submitted work is silently lost after Order submission.
- Menu/routing changes do not alter existing fulfillment work.
- Fulfillment transitions do not create duplicate Inventory consumption.
- `UNPREPARED` is accepted only when every station work item across every attempt is `NEW`; the atomic Order void reverses original and Remake consumption through `SALE_REVERSAL`.
- `PREPARED_OR_DISCARDED` retains original and Remake consumption, posts no Waste, cancels `NEW`/`PREPARING`/`READY`, and preserves `COMPLETED`/`CANCELLED` history.
- Remakes are explicit, idempotent new attempts using the immutable original consumption snapshot and additional Inventory `CONSUME`.
- Remake shortages roll back the Remake and all additional Inventory postings.
- No Recall/Reopen or direct `NEW -> READY` transition exists.
- Takeout uses the same station pipeline without physical tables.
- Order remains OPEN after fulfillment completes.
- Table Session completion remains blocked while an OPEN Order exists.
- No payment or Settlement records are created.
- Database reconstruction requires no manual SQL.
- Prior phases remain green.

Phase 10 is not complete if tickets re-resolve current Menu routing after submission.

Phase 10 is not complete if a retry creates duplicate fulfillment work.

Phase 10 is not complete if completing fulfillment closes the commercial Order.

---

## 88. Required Phase 10 Completion Report

Provide:

```text
PHASE 10 COMPLETION REPORT

Environment
- Node: 24.21.0
- npm: 12.2.0
- Next.js: 16.3.8
- PostgreSQL: 17.11
- Drizzle ORM: 0.45.3
- Drizzle Kit: 0.31.11
- Queue update strategy: 5-second short polling; no additional realtime infrastructure

Fulfillment Schema
- fulfillment_tickets: PASS
- fulfillment_ticket_items: PASS
- fulfillment_item_status_history: PASS
- fulfillment_remakes: PASS
- fulfillment_remake_tickets: PASS
- fulfillment_remake_consumption: PASS
- ticket history: N/A; ticket status is derived from its items

Routing
- Phase 9 send-batch integration: PASS; same PostgreSQL submission transaction
- Immutable prep-routing snapshot used: PASS
- GRILL/Kitchen routing: PASS
- BAR routing: PASS
- Multi-station send: PASS
- Duplicate generation prevention: PASS; database uniqueness plus transactional submission idempotency
- Ticket generation durability: PASS; submission rolls back if required ticket work fails; no historical backfill

Lifecycle
- Exact states: NEW / PREPARING / READY / COMPLETED / CANCELLED
- NEW -> PREPARING: PASS
- Direct NEW -> READY rejected: PASS
- PREPARING -> READY: PASS
- READY -> COMPLETED: PASS
- COMPLETED/served behavior: PASS; station handoff only
- Terminal COMPLETED/CANCELLED: PASS
- Invalid transitions rejected: PASS
- Idempotent retries: PASS; repeated target transition creates no duplicate history
- Status history: PASS
- Ticket aggregation: PASS; approved precedence and cancellation behavior

Queue
- Deterministic sort: PASS
- FIFO by submitted_at then stable ID; no priority: PASS
- Age calculation: PASS; computed from immutable ticket submission time
- Location/station/status/order-type filtering: PASS

Voids
- All attempts NEW + UNPREPARED: PASS
- Any started attempt rejects UNPREPARED: PASS
- PREPARED_OR_DISCARDED behavior: PASS
- Fulfillment cancellation/history: PASS
- Phase 9 SALE_REVERSAL integration: PASS
- Remake CONSUME SALE_REVERSAL on UNPREPARED: PASS
- No automatic WASTE: PASS

Remakes
- Explicit new linked attempt: PASS
- Original history and snapshots preserved: PASS
- Additional CONSUME from original snapshot: PASS
- Negative inventory policy reused: PASS
- Shortage rollback: PASS
- Idempotent retry: PASS
- Actor/reason/time/ledger provenance: PASS

Expo
- Read-only consolidated view: PASS
- Overall multi-station readiness: PASS
- No EXPO work item or preparation hop: PASS

Takeout
- Takeout routes to stations: PASS
- No Table Session required: PASS
- Fulfillment completion leaves Order OPEN: PASS

Authorization
- kitchen.view/manage and bar.view/manage: PASS
- start permission: PASS
- ready permission: PASS
- complete permission: PASS
- fulfillment.remake: PASS
- location/station scope: PASS
- direct unauthorized API denied: PASS

Phase 9 Boundaries
- Submitted Order snapshots unchanged: PASS
- Existing CONSUME not duplicated: PASS
- Order remains OPEN: PASS
- Table Session OPEN-Order guard preserved: PASS
- No Settlement/payment records: PASS

Migrations
- Generation: PASS; `npm run db:generate` reports no schema changes
- Application: PASS; migrations `0024_breezy_mother_askani.sql`, `0025_low_human_fly.sql`, `0026_bitter_white_tiger.sql`
- Empty DB reconstruction: PASS; isolated integration/E2E databases were recreated from the full migration chain
- Unexplained schema drift: NONE

Regression
- Phase 1 foundation: PASS
- Phase 2 Auth/RBAC: PASS
- Phase 3 Employees/HR: PASS
- Phase 4 Scheduling: PASS
- Phase 5 Restaurant/Seating: PASS
- Phase 6 Reservations/Waitlist: PASS
- Phase 7 Menu/Recipes: PASS
- Phase 8 Inventory/Purchasing: PASS
- Phase 9 Orders: PASS
- db:reset safeguards: PASS by existing regression tests; destructive reset was not run against the persistent development DB
- /api/health: PASS; `status: ok`, `database: connected`

Validation
- npm ci: PASS; five development-only advisories remain under DEV-001
- lint: PASS
- typecheck: PASS
- unit tests: PASS; 97 tests in 18 files
- integration tests: PASS; 75 tests across 10 files
- E2E tests: PASS; 22 tests
- production build: PASS
- npm audit --omit=dev: PASS; zero production vulnerabilities

Accepted Risks
- DEV-001: unchanged and accepted; no forced dependency remediation

Business Domains Created Beyond Phase 10
- NONE expected

Created / Modified
- Added six fulfillment/remake tables and migrations `0024`-`0026`; integrated ticket generation and void synchronization into Phase 9 transactions; added a narrow Phase 8-backed Remake consume/reversal capability.
- Added Kitchen/Bar/Expo queues and responsive KDS UI, centralized permissions/role grants, state/aggregation logic, unit/PostgreSQL integration/Playwright tests, and this approved-policy completion report.
- Development seed ran twice successfully. No active fulfillment records were seeded.

Architecture Deviations
- None. No outbox/broker or Settlement/payment domain was added; Phase 9 remains the Inventory-consumption boundary for original submissions.

Outstanding Phase 10 Issues
- None. Empty Phase 9 routing snapshots create no station work; Phase 10 does not invent or re-resolve routes.

Phase 11 Readiness
- READY
```

---

## 89. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-10-Kitchen-Bar-Fulfillment.md`, start a fresh Copilot chat and use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 10 implementation plans completely. Treat `README.md` as the architectural source of truth. Derive current state from repository source, migrations, tests, and documentation rather than prior chat history.
>
> Review the completed Phase 0 through Phase 9 implementation before modifying files. Implement Phase 10 only: Kitchen & Bar Fulfillment, including durable/idempotent transformation of Phase 9 Order send batches into station-specific fulfillment tickets/items, immutable routing/item/modifier/special-instruction snapshots, Kitchen and Bar queues, fulfillment lifecycle/state history, ticket aggregation, deterministic queue ordering/age, concurrency-safe transitions, submitted-item void synchronization, Takeout fulfillment, Kitchen/Bar RBAC, responsive KDS-style UI, migrations, tests, and documentation.
>
> Preserve these boundaries: Phase 9 submission already consumed Inventory; starting/readying/completing existing fulfillment work must not consume Inventory again. Use immutable Phase 9 routing snapshots rather than current Menu routing. Kitchen/Bar fulfillment status is separate from Phase 9 Order Item commercial state. Fulfillment completion does not close the Order. Phase 11 owns Settlement and Order closure. Table Session completion remains blocked while an associated Order is OPEN.
>
> Preserve the approved Phase 10 policies in the “Approved Phase 10 Policies” section. `UNPREPARED` requires every station item across every attempt to remain `NEW` and reverses original plus Remake consumption through the trusted Order `SALE_REVERSAL` flow. `PREPARED_OR_DISCARDED` retains consumption, cancels only active work, preserves terminal history, and never posts Waste automatically. Do not grant Kitchen/Bar users generic Inventory permissions.
>
> Preserve exact arithmetic, BusinessDateService, Phase 1 transaction/migration/test architecture, Phase 2 RBAC, Phase 3 HR boundaries, Phase 4 Scheduling, Phase 5 Seating, Phase 6 Reservations/Waitlist, Phase 7 Menu/Recipe contracts, Phase 8 Inventory ledger/cost rules, Phase 9 Order snapshots/submission/void/idempotency policies, reset safeguards, and DEV-001.
>
> Before modifying files, inspect the repository and provide a concise Phase 10 execution plan. Apply the Approved Phase 10 Policies in this plan: exact README item states and ticket aggregation; one ticket per submission/station; one work item per snapshotted route; FIFO only; read-only Expo; same-transaction generation; all-attempt void compatibility; idempotent Remake from immutable consumption snapshots; no Recall/Reopen; and no historical backfill. Stop only if implementation reveals a new material architecture or business-policy conflict.
>
> After implementation, run the complete Phase 10 validation suite and provide the full Phase 10 Completion Report. Stop before changing approved architecture if a material conflict is discovered.

---

## Final Guardrail

Phase 10 converts submitted commercial intent into operational preparation work while preserving the Order and Inventory history already established.

```text
Phase 9 Submitted Item
        |
        v
Immutable Fulfillment Routing
        |
        +-- Kitchen Stations
        +-- Bar Station
        |
        v
Preparation Lifecycle
        |
        v
Completed Fulfillment
        |
        +-- Order remains OPEN
        |
        +-- Phase 11 Settlement later
```

Do not collapse fulfillment, Inventory consumption, Order closure, and Settlement into one operation for implementation convenience.
