# Restaurant Operations Management System

> Architecture and implementation contract for VS Code Copilot.
>
> **Copilot instruction:** Read this document before generating or modifying application code. Implement only the requested phase. Preserve the architecture, domain boundaries, historical-data rules, security model, and transaction rules defined here. If implementation exposes a conflict, describe it before changing this architecture.

For an operator walkthrough, see the [Restaurant Operations App User Guide](docs/User-Guide.md).

## 1. Project Overview

Build a responsive, web-based restaurant operations system for a full-service bar/restaurant. The initial deployment supports one location but the data model must remain multi-location capable.

Initial operating areas:
- Dining Room
- Bar
- Takeout

Supported devices:
- Desktop
- Tablet
- Mobile phone carried by servers

Core capabilities:
- Authentication and role-based access control
- Employees and HR
- Employee scheduling and automatic draft schedule generation
- Seating and server sections
- Reservations, walk-ins, and waitlist
- Menu, recipes, modifiers, and preparation routing
- Inventory, purchasing, receiving, waste, and physical counts
- Orders and split checks
- Kitchen and bar fulfillment
- Settlement recording only, not payment processing
- Audit history
- Operational reporting
- In-application notifications
- Real-time restaurant operations

## 2. Technology Stack

- Next.js using App Router
- React
- TypeScript
- Node.js runtime through Next.js server functionality
- Tailwind CSS
- PostgreSQL
- Drizzle ORM
- Zod for boundary validation
- Auth.js or a similarly established authentication library, isolated behind the authentication module
- Playwright for browser E2E testing
- Docker Compose for local PostgreSQL

Architecture style: **modular monolith**.

Do not add a separate Express server initially. Do not introduce microservices, Kubernetes, Kafka, or another database unless the architecture is intentionally revised.

## 3. Core Architecture

```text
Desktop / Tablet / Phone
          |
          v
       Next.js
 App Router + React
          |
 Route Handlers / Server
          |
          v
 Application Commands / Queries
          |
          v
 Domain Modules and Workflows
          |
          v
 Repositories / Drizzle ORM
          |
          v
       PostgreSQL
          |
          +-- Transactional Outbox --> Realtime Adapter --> Browsers
```

Dependency direction:

```text
UI
 -> HTTP boundary
 -> command/query or workflow
 -> domain service
 -> repository
 -> Drizzle
 -> PostgreSQL
```

React components must never access Drizzle directly. Route handlers must remain thin.

## 4. Architectural Rules

1. Organize business logic by domain.
2. Domain modules own core mutation rules for their entities.
3. Multi-domain operations use explicit workflows.
4. Server-side authorization is mandatory. Hidden UI is not authorization.
5. Employee positions and application security roles are separate concepts.
6. Historical facts are never recalculated from current configuration.
7. Important operational changes use PostgreSQL transactions.
8. Inventory movement occurs only through the Inventory domain.
9. `inventory_transactions` is the authoritative inventory movement ledger.
10. Inventory reversals use compensating transactions. Never erase historical movement.
11. Submitted order items store immutable pricing, modifier, recipe, and consumption information.
12. Real-time events are emitted only after successful commit, through a transactional outbox.
13. Critical client commands are idempotent.
14. Mutable high-contention records use optimistic concurrency.
15. Reporting is read-only.
16. Audit records are append-only.
17. Files are stored outside PostgreSQL; PostgreSQL stores metadata and storage references.
18. One BusinessDateService determines operational business dates.
19. Use fixed-precision PostgreSQL numerics for money, costs, and inventory quantities.
20. No payment processing is implemented.
21. Never store raw card numbers, CVV, PINs, magnetic-stripe data, bank account numbers, or bank routing numbers.
22. Do not implement full offline mode in the POC. Implement safe retry and clear connection-status behavior.

## 5. Repository Structure

```text
restaurant-ops/
├── .github/
│   └── workflows/
├── docker/
├── drizzle/
│   ├── migrations/
│   └── meta/
├── public/
├── scripts/
├── src/
│   ├── app/
│   ├── components/
│   ├── config/
│   ├── db/
│   ├── infrastructure/
│   ├── modules/
│   ├── shared/
│   ├── types/
│   └── workflows/
├── tests/
│   ├── e2e/
│   ├── fixtures/
│   ├── helpers/
│   └── integration/
├── .env.example
├── docker-compose.yml
├── drizzle.config.ts
├── next.config.ts
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── README.md
```

### Domain modules

```text
src/modules/
├── organization/
├── auth/
├── employees/
├── scheduling/
├── restaurant/
├── reservations/
├── menu/
├── recipes/
├── inventory/
├── orders/
├── kitchen/
├── settlements/
├── auditing/
├── reporting/
└── notifications/
```

Larger modules may use:

```text
commands/
queries/
services/
repositories/
validators/
dto/
events/
errors/
types/
index.ts
```

Do not create empty folders merely to satisfy this pattern.

### Multi-domain workflows

Use `src/workflows/` only for substantial cross-domain orchestration, for example:

```text
submit-order/
void-order-item/
seat-party/
close-order/
receive-purchase-order/
```

Do not move ordinary CRUD operations into workflows.

## 6. Naming Conventions

Files: `kebab-case.ts`

TypeScript types/classes: `PascalCase`

Functions/variables: `camelCase`

PostgreSQL tables/columns: `snake_case`

Permissions: `domain.action`

Examples:

```text
orders.submit
orders.void
inventory.adjust
schedule.publish
hr.compensation.view
```

Application events: `domain.event-name`

Examples:

```text
order.items-submitted
kitchen.item-ready
schedule.published
inventory.low
```

Use `*_employee_id` for business employee relationships and `*_user_id` for authenticated actors.

## 7. Database Conventions

- Primary keys: UUID
- Human-readable numbers such as employee number, PO number, and order number are separate business identifiers.
- Real-world timestamps: `TIMESTAMPTZ`
- Business day: persist a `DATE` where operational reporting requires it.
- Customer-facing money: generally `NUMERIC(12,2)`.
- Detailed unit/ingredient costs: generally `NUMERIC(14,4)`.
- Inventory quantities: fixed precision such as `NUMERIC(14,4)`.
- High-contention mutable records use `version INTEGER` for optimistic concurrency.
- Configurable entities are usually deactivated rather than deleted.
- Historical transactions are not deleted through normal application behavior.
- Configuration codes should have appropriate organization/location-scoped unique constraints.
- PostgreSQL constraints remain required even when Zod validation exists.

Prefer configurable tables for business concepts such as roles, positions, prep stations, and categories. Stable lifecycle states may use constrained string values rather than overusing PostgreSQL native enums.

## 8. Domain 01: Organization and Locations

Tables:

```text
organizations
locations
location_settings
restaurant_areas
```

Relationships:

```text
Organization 1 -> many Locations
Location 1 -> many Restaurant Areas
```

Initial restaurant areas:
- Dining Room
- Bar
- Takeout

Location settings include operational settings such as timezone, business-day cutoff, reservation defaults, and enabled capabilities.

The initial system has one location, but operational tables should be location-aware where appropriate.

## 9. Domain 02: Authentication and RBAC

Tables:

```text
users
roles
permissions
user_roles
role_permissions
```

Authentication identifies the user. RBAC determines authorization.

A user may optionally reference an employee. An employee does not require a login.

Application code must check permissions, not hard-coded role names.

Example role seeds:
- Owner
- General Manager
- Manager
- Server
- Bartender
- Host
- Cook
- Wait Staff
- Inventory Manager

Example permissions:

```text
employees.view
employees.edit
hr.compensation.view
hr.compensation.edit
schedule.view
schedule.edit
schedule.generate
schedule.publish
menu.view
menu.edit
inventory.view
inventory.receive
inventory.adjust
inventory.count
orders.create
orders.submit
orders.void
settlements.complete
reservations.view
reservations.manage

reports.view
reports.sales
reports.orders
reports.inventory
reports.fulfillment
reports.labor
reports.settlements
reports.seating
reports.export

admin.roles
```

## 10. Domain 03: Employees and HR

Tables:

```text
employees
employee_locations
positions
employee_positions
employee_addresses
employee_emergency_contacts
employee_position_compensation
certification_types
employee_certifications
employee_documents
employee_notes
employee_disciplinary_actions
employee_performance_reviews
employee_status_history
```

Employee locations support a primary location plus other eligible work locations.

Employee positions describe work performed. They do not grant software permissions.

Compensation is effective-dated history owned by the Employee + Position pair (`employee_position_compensation`). The Position holds no wage; an employee with several positions has a separate wage for each. Never overwrite the old rate.

HR sensitivity levels:

General:
- Name
- Position
- Schedule
- Work contact
- Availability

Management:
- Attendance
- Certifications
- Employment status
- Performance

Restricted HR:
- Compensation
- Disciplinary information
- Sensitive notes
- Personal address
- Emergency contacts

Authorization must reflect these boundaries.

## 11. Domain 04: Scheduling

Tables:

```text
schedule_periods
shifts
shift_assignments
employee_availability
employee_availability_exceptions
employee_scheduling_preferences
time_off_requests
shift_swap_requests
staffing_templates
staffing_template_requirements
scheduling_rules
schedule_generation_runs
```

Schedule lifecycle:

```text
DRAFT -> PUBLISHED -> ARCHIVED
```

A shift represents a staffing requirement. A shift assignment links an employee to that requirement.

`shift_assignments.assignment_source` supports:

```text
MANUAL
GENERATED
SHIFT_SWAP
```

### Automatic schedule generation

The generator creates a **draft starting point**. It never publishes automatically.

Inputs:
- Staffing templates
- Employee locations
- Employee positions
- Recurring availability
- Availability exceptions
- Approved time off
- Scheduling preferences
- Rules
- Existing assignments

Hard constraints include:
- Active employee
- Employee eligible for location
- Qualified position
- No approved time off
- No overlapping shift
- Mandatory availability restrictions

Soft criteria include:
- Target hours
- Minimize overtime
- Weekend fairness
- Closing-shift fairness
- Employee shift preferences
- Consecutive days
- Rest between shifts

Outputs:
- Draft assignments
- Unfilled shifts
- Coverage analysis
- Warnings
- Employee scheduled hours
- Explanation of why assignments were made

Manager may override generated assignments and use a fill-open-shifts mode.

## 12. Domain 05: Restaurant and Seating

Tables:

```text
restaurant_tables
table_sessions
table_session_tables
server_sections
server_section_tables
server_section_assignments
table_condition_history
table_session_overrides
```

Physical condition is separate from occupancy.

Conditions include:

```text
CLEAN
DIRTY
OUT_OF_SERVICE
```

Occupancy derives from table sessions.

A session can use multiple tables, enabling table combinations.

Orders reference the **table session**, never the physical table directly.

A closed order does not automatically make a table available:

```text
Order Closed
 -> Guests Leave
 -> Table Session Completed
 -> Table DIRTY
 -> Table Cleaned
 -> Table CLEAN / Available
```

## 13. Domain 06: Reservations and Waitlist

Tables:

```text
guest_parties
reservations
reservation_table_assignments
reservation_hold_overrides
waitlist_entries
waitlist_table_assignments
party_status_history
```

`waitlist_table_assignments` keeps the host's planned table selection as replaceable history, and `reservation_hold_overrides` is the append-only record of a manager seating an unrelated party under a hold. Neither is an audit log, and the Guest Party link is a nullable `table_sessions.guest_party_id`.

Guest Party is the common guest concept for reservations and walk-ins.

Flow:

```text
Reservation or Walk-In
 -> Guest Party
 -> Waitlist if needed
 -> Assign table(s)
 -> Table Session
 -> Order(s)
```

A reservation does not own a table session. The guest party participates in both.

Reservation statuses:

```text
PENDING
CONFIRMED
CHECKED_IN
SEATED
COMPLETED
CANCELLED
NO_SHOW
```

Waitlist statuses:

```text
WAITING
NOTIFIED
TABLE_ASSIGNED
SEATED
CANCELLED
LEFT
```

Use `CHECKED_IN` for reservation check-in. Reservation planning does not create physical occupancy; only an active Phase 5 Table Session occupies a physical table. `TABLE_ASSIGNED` is a Waitlist planning state and does not create occupancy.

Location settings define reservation holds, initially `reservation_pre_hold_minutes = 15` and `reservation_post_grace_minutes = 15`. Use half-open intervals:

```text
Reservation planning conflict:
[reservation_at - pre_hold,
 reservation_at + expected_duration + post_grace)

Walk-in hold protection:
[reservation_at - pre_hold,
 reservation_at + post_grace)
```

These are distinct calculations. A `NO_SHOW` is a manual transition allowed only for `CONFIRMED` reservations at or after the configured post-grace time; record actor/time and release planned table assignments. It never undoes actual seating. Combined-table recommendations use at most three tables from one Restaurant Area and never reserve or occupy them.

Takeout must not be represented by a fake table.

## 14. Domain 07: Menu Management

Tables:

```text
menus
menu_locations
menu_availability
menu_categories
menu_items
menu_item_placements
modifier_groups
modifiers
menu_item_modifier_groups
modifier_group_modifiers
menu_item_prices
prep_stations
menu_item_prep_routing
```

A menu item definition may appear in multiple menus/categories using `menu_item_placements`.

A placement defines display order and active state. Placement-level price overrides are deferred: a price is resolved only from `menu_item_prices` (a location price first, then the organization default).

`menu_item_prices` is effective-dated (`[effective_from, effective_to)`) and a price change closes the open row and inserts a new one. `modifier_group_modifiers` lets one modifier belong to several groups. `menu_item_prep_routing` is the location-aware link from an item to its prep stations.

Menu item `active` and `available` are distinct:
- `active`: belongs to the catalog/configuration.
- `available`: can currently be sold.

Prep stations initially include concepts such as:

```text
GRILL
FRY
COLD
KITCHEN
BAR
```

The architecture may later support multiple fulfillment components for a single composite menu item.

## 15. Domain 08: Recipes and Modifiers

Tables:

```text
units_of_measure
unit_conversions
recipes
recipe_versions
recipe_version_ingredients
modifier_inventory_effects
```

Recipe identity (`recipes`), immutable revisions (`recipe_versions`) and the unit vocabulary arrive in Phase 7. `recipe_version_ingredients` (a revision's requirements) and `modifier_inventory_effects` (how a modifier changes one Menu Item's requirements) reference Inventory Items and arrive in Phase 8. See sections 33 (Phase 7 and Phase 8 policies).

Relationship:

```text
Menu Item
 -> versioned Recipe
 -> Recipe Ingredients
 -> Inventory Items
```

Recipes support effective dates/history. Changing a recipe must never change historical order consumption.

Structured modifiers may affect price, inventory, preparation, or any combination.

Free-text instructions never automatically affect inventory.

Modifier inventory adjustments must support menu-item context where quantities differ between products.

Substitution should generally be represented as multiple ingredient adjustments. Example Swiss instead of American:

```text
Remove American Cheese
Add Swiss Cheese
```

## 16. Domain 09: Inventory and Purchasing

Tables:

```text
inventory_items
inventory_item_locations
inventory_item_unit_conversions
inventory_transactions
inventory_balances
suppliers
supplier_items
supplier_item_cost_history
purchase_orders
purchase_order_lines
purchase_order_receipts
purchase_order_receipt_lines
inventory_counts
inventory_count_lines
```

Units of measure and generic conversions are shared with Recipes (section 15). Inventory is tracked per restaurant Location; there are no storage locations or inventory categories within a Location, and waste is a ledger row with a reason code rather than a separate table.

### Inventory authority

`inventory_transactions` is authoritative. `inventory_balances` is maintained for efficient current-balance reads.

Every inventory mutation must create ledger movement and update balance in one transaction.

Quantity sign convention:

```text
positive = inventory added
negative = inventory removed
```

Transaction types:

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
SALE_REVERSAL
```

`SALE_REVERSAL` (Phase 9) restores stock consumed by an Order Item that was voided as never prepared. It must name the `CONSUME` row it compensates (`reverses_transaction_id`, at most one reversal each). Further types are added deliberately in the phase that needs them.

Transfers between Locations of one organization use a matching transfer-out and transfer-in with one shared reference and do not change total inventory.

Creating a purchase order does not increase stock. Receiving does.

Support partial receipts.

Use weighted-average costing initially. Preserve actual received/supplier cost history.

Physical counts snapshot the system quantity, record counted quantity, and create adjustment transactions on completion.

Theoretical versus actual inventory and cost variance are critical reporting capabilities.

## 17. Domain 10: Orders

Tables:

```text
orders
order_items
order_item_modifiers
order_send_batches
order_status_history
order_item_status_history
order_item_voids
discount_definitions
order_discounts
order_item_discounts
order_item_inventory_consumption
order_number_counters
```

Order types:

```text
DINE_IN
BAR
TAKEOUT
```

Table session to orders is one-to-many to support split checks.

An order has a UUID primary key plus a separate human-readable order number.

### Draft versus submitted

Adding or editing a draft item does not consume inventory or create fulfillment tickets.

When the server sends unsent items:

```text
Draft Item
 -> Resolve current approved price
 -> Resolve modifiers
 -> Resolve active recipe version
 -> Calculate final ingredient consumption
 -> Create immutable snapshots
 -> Create send batch
 -> Create inventory movement
 -> Create kitchen/bar fulfillment
```

Submission is item-level because drinks, appetizers, and entrees can be sent in different rounds.

Submitted order items store:
- Menu item reference
- Item-name snapshot
- Price snapshot
- Modifier snapshots
- Recipe ID used
- Consumption snapshot
- Relevant kitchen instructions

Never recalculate historical consumption from the current recipe.

### Voids and physical inventory

A submitted item is never silently deleted.

A void requires reason/authorization as configured.

Inventory reversal depends upon physical disposition:
- Never prepared/consumed: reversal may be appropriate.
- Already prepared/discarded: inventory remains consumed and waste may be recorded.

Discounts and comps do not automatically restore inventory.

## 18. Domain 11: Kitchen and Bar

Tables:

```text
kitchen_tickets
kitchen_ticket_items
kitchen_ticket_item_status_history
kitchen_remakes
kitchen_remake_consumption
```

Bar uses the same fulfillment model as Kitchen. Do not create a separate bar-ticket architecture.

Flow:

```text
Order Send Batch
 -> Ticket(s)
 -> Ticket Items
 -> Prep Station
```

Item statuses:

```text
NEW
PREPARING
READY
COMPLETED
CANCELLED
```

Support architecturally:
- Grill/Fry/Cold/Kitchen/Bar queues
- Real-time ticket creation
- Item start
- Ready
- Completion/bump
- Explicit post-send cancellation
- Ticket/item recall
- Course concept
- Hold/fire concept

As built in Phase 10, the approved Phase 10 policies replace recall with an explicit Remake (a new linked attempt), and defer courses and hold/fire: submitted work enters `NEW` at once, and nothing in the schema precludes adding them later. See section 33.

Overall order state and kitchen fulfillment state remain separate.

## 19. Domain 12: Order Settlement

Tables:

```text
order_settlements
settlement_tenders
settlement_status_history
```

Recorded settlement types initially:

```text
CASH
EXTERNAL_CARD
GIFT_CARD
HOUSE_ACCOUNT
OTHER
```

The application **records settlement only**. It does not authorize or process card payments, gift-card balances, house-account receivables, or external-provider payments. These tender types are financial classifications, not processing integrations. `OTHER` requires a description/reason identifying what was recorded.

Settlement reconciles against the exact Phase 9 post-discount, pre-tax Order amount. Tax calculation is deferred; do not infer taxability from the item, location, Order type, or food/alcohol category. Tips are separate from the Order obligation and may be recorded only for CASH and EXTERNAL_CARD. Cash change is calculated after the Order amount applied and cash tip; no cash rounding is performed.

Support:
- Multiple historical settlements per order, with at most one OPEN settlement
- Multiple tenders within one OPEN settlement for partial/split tender
- Cash tendered/change
- External safe transaction/reference ID
- Tender idempotency and exact reconciliation
- Zero-amount Settlement closure for a fully comped Order, without a fake $0 tender

Do not represent one Order obligation as multiple partially completed Settlements. A fully reconciled Settlement closes the Order atomically; a CLOSED Order is terminal in Phase 11. Refunds and post-close corrections are deferred. Settlement completion does not change Inventory, fulfillment, or Table Session status. Table Sessions still complete only through the explicit physical departure workflow after associated Orders are CLOSED.

Before order closure, valid settlements must cover the amount due, except where legitimate discounts/comps reduce the amount.

## 20. Domain 13: Auditing

Table:

```text
audit_events
```

Audit answers: who did what, when, where, and to which entity.

Domain history remains separate. For example:
- Inventory ledger explains physical inventory movement.
- Audit explains who initiated the movement.

Audit attributes include:
- Organization/location
- User/employee actor or SYSTEM actor
- Action
- Category
- Entity type/ID
- Timestamp
- Request/correlation ID
- Optional filtered before/after JSONB

Audit data is append-only.

Never include passwords, password hashes, session tokens, secrets, prohibited payment information, or unnecessary sensitive HR data.

Audit access is permission controlled.

## 21. Domain 14: Reporting

Reporting is read-only.

Reporting derives operational analytics from authoritative historical
data created by other domains. Reporting is initially served from
PostgreSQL using indexed aggregation queries and reusable views.
Introduce materialized views or summary tables only when justified by
measured performance requirements.

Reporting must never:

- Modify Orders
- Modify Settlements
- Modify Tenders
- Modify Inventory
- Modify Fulfillment
- Modify Reservations
- Modify Table Sessions
- Modify Scheduling data

Reporting should favor indexed aggregation queries before introducing
materialized views or summary tables.

Do not introduce Redis, analytics warehouses, external BI platforms,
or event-streaming infrastructure unless explicitly approved.

### Reporting Areas

Reporting areas include:

- Sales
- Settlement analysis
- Order analytics
- Menu performance
- Theoretical food cost
- Inventory balances
- Theoretical versus actual inventory
- Inventory variance
- Waste
- Purchasing and supplier cost trends
- Labor
- Schedule effectiveness
- Server operational metrics
- Reservations and waitlist metrics
- Table turnover and utilization
- Kitchen and bar performance

### Reporting Filters

Reports should support filtering by:

- Location
- Business Date
- Calendar Date
- Date Range
- Employee
- Order Type
- Tender Type

Business Date calculations must use the shared
BusinessDateService.

### Historical Data Rules

Historical reporting must use immutable snapshots and
effective-dated history.

Historical reports use:

- Historical order price snapshots
- Historical modifier snapshots
- Historical inventory-consumption snapshots
- Settlement history
- Tender history
- Historical supplier cost
- Effective compensation history
- Fulfillment history
- Audit history where appropriate

Do not calculate historical results from:

- Current menu prices
- Current recipes
- Current inventory balances
- Current compensation values
- Current configuration state

Examples:

- Historical item revenue uses submitted Order price snapshots.
- Tender reporting uses Settlement and Tender history.
- Inventory reporting uses inventory ledger history.
- Labor reporting uses the effective compensation of the Employee for the Position worked.
- Fulfillment reporting uses fulfillment status history.

### Exporting

Phase 12 supports:

- CSV Export

Phase 12 does not include:

- Excel generation
- PDF reporting
- Scheduled report delivery
- Email distribution

### Security

Reporting is:

- Read-only
- Permission controlled
- Location aware
- Server authorized

Hidden UI is not authorization.

Reporting APIs must independently enforce authorization.

## 22. Notifications

Table:

```text
notifications
```

POC notifications are in-app only.

Examples:

```text
FOOD_READY
BAR_ORDER_READY
SCHEDULE_PUBLISHED
SHIFT_CHANGED
TIME_OFF_APPROVED
INVENTORY_LOW
CERTIFICATION_EXPIRING
```

Do not introduce SMS/email/push integration during the POC unless intentionally added later.

As built in Phase 10, `notifications` holds `FOOD_READY` and `BAR_ORDER_READY` only (see section 33). The other kinds arrive with the phases that need them.

## 23. Infrastructure Reliability Tables

Tables:

```text
outbox_events
idempotency_records
```

### Transactional outbox

Critical database transactions write an outbox event before commit. An outbox processor publishes committed events to the real-time adapter.

Never send a kitchen/real-time event before the database transaction commits.

### Idempotency

Critical commands such as SEND must accept a client-generated idempotency key. Retrying the same successfully processed request must return/reuse the earlier outcome, never duplicate kitchen tickets or inventory movement.

As built in Phase 9, `idempotency_records` holds (organization, scope, key), the actor, a SHA-256 fingerprint of the canonical request (including the actor) and the stored response. The key is claimed inside the command's own transaction (`src/infrastructure/idempotency/`), so a rolled-back attempt leaves nothing and a concurrent duplicate waits on the unique key. A matching retry returns the stored response; the same key with a different request or actor is refused with `IDEMPOTENCY_KEY_REUSED` (409).

As built in Phase 10, `outbox_events` rows are written inside the transaction that makes the change (SEND, item transitions, voids, Remakes, notifications), carry identifiers only, and are append-only except for their publishing state. One processor per Node.js process, started from `src/instrumentation.ts` (`OUTBOX_POLL_INTERVAL_MS`, default 1000, 0 turns it off), claims unpublished rows in sequence with `FOR UPDATE SKIP LOCKED`, hands them to the in-process realtime adapter, and marks them published; a publisher failure records the attempt and retries. The adapter fans events out to authenticated Server-Sent Events connections (`/api/realtime/stream`), filtered by organization, location and, for notifications, recipient. An event only means "refetch": screens read through their normal authorized queries and fall back to a slow refresh, with a Live/Reconnecting indicator. This fits the single-instance POC; several app instances would each need a feed (for example LISTEN/NOTIFY). Outbox retention is an operational task, not built.

## 24. Transaction Boundaries

Operations that require transactions include:
- Order item submission
- Order item void/reversal
- Order close
- Inventory receipt
- Inventory transfer
- Waste recording
- Physical count completion
- Reservation seating
- Table-session close
- Schedule publishing
- Approved shift swap
- Compensation change
- Role/permission changes

Canonical order submission:

```text
BEGIN

Validate authentication/authorization
Validate idempotency
Validate order and optimistic version
Resolve menu price
Resolve modifier selections
Resolve approved recipe version
Calculate final ingredient consumption
Create send batch
Snapshot item/price/modifiers/recipe
Create inventory-consumption snapshots
Create inventory ledger movement
Update inventory balance
Create kitchen/bar tickets
Write order/item histories
Write audit events
Write outbox events
Persist idempotency result

COMMIT
```

Any failure rolls back the unit of work.

Do not perform uncontrolled network calls inside the database transaction.

## 25. Concurrency

Use optimistic concurrency on high-contention mutable records such as:

```text
orders
order_items
schedule_periods
reservations
table_sessions
inventory_counts
employees
```

An update includes the expected version. A version mismatch returns a conflict rather than silently overwriting another user's changes.

## 26. Error Handling

Use structured application error classes/codes for concepts such as:

```text
AuthenticationError
AuthorizationError
ValidationError
NotFoundError
ConflictError
BusinessRuleError
ConcurrencyError
```

Example API shape:

```json
{
  "error": {
    "code": "TABLE_ALREADY_OCCUPIED",
    "message": "Table 12 currently has an active session.",
    "requestId": "..."
  }
}
```

Never expose SQL, credentials, stack traces, or internal secrets to clients.

## 27. Validation

Use Zod for request/input structure validation.

Examples:
- UUID syntax
- Required fields
- Numeric shape
- Positive guest count

Business rules remain in domain services/workflows.

Examples:
- Cannot seat an occupied table.
- Cannot submit a voided item.
- Employee must be qualified for assigned position.
- Cannot consume using an invalid recipe version.

PostgreSQL constraints provide the final integrity layer.

## 28. Logging and Request Context

Technical logs and business audits remain separate.

Structured logging should include fields such as:
- requestId
- module
- operation
- entity ID where useful
- severity
- message

Do not log passwords, authentication tokens, prohibited settlement/payment data, or unnecessary sensitive HR data.

Use request/correlation IDs across logs, audit events, and related operational records where useful.

## 29. Business Date

Bars can operate after midnight. Calendar date and restaurant business date can differ.

Example with a 4:00 AM cutoff:

```text
Saturday 1:15 AM calendar time
 -> Friday restaurant business date
```

`BusinessDateService` accepts timestamp + location settings and returns the authoritative business date.

Modules must not implement independent business-date logic.

Business date applies where useful to orders, inventory movement, counts, receipts, waste, settlement/reporting, and labor operations.

## 30. Responsive UI

One application supports all device classes.

Desktop emphasis:
- Owner/manager dashboard
- HR
- Menu configuration
- Inventory
- Scheduling
- Reporting

Tablet emphasis:
- Host
- Manager
- Kitchen display
- Bartender
- Inventory count

Phone emphasis:
- Server tables
- Order entry
- Modifiers
- Food-ready alerts
- Schedule
- Time off

Do not create separate desktop/tablet/mobile codebases.

Operational controls should be touch friendly.

## 31. Testing Strategy

### Unit tests

Prioritize deterministic business rules:
- Recipe resolution
- Modifier ingredient adjustment
- Unit conversion
- Money calculations
- Business date
- Schedule constraints/scoring
- Settlement balance rules

### Integration tests

Run against PostgreSQL and validate cross-domain behavior.

Canonical integration test:

```text
Bacon Cheeseburger
- Medium
- No Onion
- Extra Pickles
- Swiss instead of American
```

Assert:
- Correct price
- Modifier snapshots
- Recipe ID
- Kitchen instructions
- Ingredient resolution
- Consumption snapshot
- Exact inventory movement
- One fulfillment submission

Retry with the identical idempotency key and assert:
- No additional kitchen ticket
- No additional inventory transaction
- No additional consumption snapshot

### E2E tests

Use Playwright for complete guest/restaurant workflows:

```text
login
 -> reservation/walk-in
 -> seating
 -> ordering
 -> kitchen/bar
 -> ready notification
 -> settlement record
 -> close order
 -> end session
 -> dirty/clean table
```

## 32. Seed Data

Seed realistic, idempotent development data.

Include:
- One organization
- One location
- Dining Room, Bar, Takeout
- Owner, GM, manager, servers, bartenders, hosts, cooks, inventory manager
- Roles and permissions
- Restaurant tables/high-tops/bar seats (as of Phase 5, a modest floor at `MAIN`; see section 33)
- Prep stations
- Storage locations
- Suppliers
- Representative food and bar inventory
- Menu categories
- Burger and other sample menu items
- Recipes and modifiers
- Staffing templates (as of Phase 4, the normal seed creates default scheduling rules and no staffing demand; see section 33. Managers create templates in the application.)

Running seeds repeatedly must not create duplicates.

## 33. Local Development

POC local environment:

```text
Next.js on developer machine
        |
        v
Docker Compose PostgreSQL
```

Application database access is controlled by `DATABASE_URL`.

Environment variables are parsed and validated centrally under `src/config/`. Do not scatter direct `process.env` access across the codebase.

### Phase 0 setup

Requirements: Node.js 26 (current LTS, pinned in `.nvmrc`; `package.json` `engines` floor is `>=22.12.0`), npm, and Docker Compose.

```text
npm ci
copy .env.example .env
docker compose up -d
npm run dev
```

The PostgreSQL container uses a persistent named volume. `docker compose down` preserves its data; remove the volume only when an intentional database reset is needed. Run `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:integration`, `npm run test:e2e`, and `npm run build` to validate the bootstrap.

### Phase 1 database foundation

The shared Drizzle schema lives under `src/db/schema/`; generated migrations are committed under `drizzle/migrations/`. Use `npm run db:generate` to generate and review a migration, then `npm run db:migrate` to apply it. Do not use schema push/synchronization for persistent environments.

Database helpers establish UUID primary keys (`defaultRandom()`), `TIMESTAMPTZ` instants, separate `DATE` business-date columns, customer money as `NUMERIC(12,2)`, and detailed costs and inventory quantities as `NUMERIC(14,4)`. Drizzle maps `NUMERIC` to strings; keep values as decimal strings and do not use JavaScript `number` for authoritative money or inventory arithmetic. Timestamp helpers return JavaScript `Date` instants. Version columns support selected concurrency-sensitive records, and active flags are for configurable records. `withTransaction(database, callback)` passes one typed transaction context to all participating operations; pass the database explicitly so development and test transactions cannot be confused.

`npm run db:reset` is destructive and is restricted to `NODE_ENV=development` with a loopback PostgreSQL URL whose database is exactly `restaurant_ops`. It drops and rebuilds the `public` schema and Drizzle migration metadata from checked-in migrations. It refuses production mode, non-loopback hosts, and other database names.

Integration tests use `TEST_DATABASE_URL`, separate from `DATABASE_URL`. The test lifecycle accepts only a matching `*_test` database on the same server and recreates it before applying migrations. Local `.env.example` uses `restaurant_ops_test`; CI supplies the same two logical databases on its PostgreSQL service. Never point `TEST_DATABASE_URL` at a shared or production database.

`npm run db:seed` runs registered seeds transactionally. Each stable seed key is recorded once in the infrastructure-only `seed_runs` table; seed callbacks run only when their key is first inserted. Phase 1 registers no restaurant business seeds.

### Phase 2 identity and access

Auth.js (`next-auth` Credentials provider) handles sign-in, encrypted JWT-backed eight-hour sessions, CSRF protection, and logout. The application stores only Argon2id password hashes. A JWT contains the authenticated user ID; every protected request resolves the active user, active organization/location, active location-scoped role assignments, and current role permissions from PostgreSQL. This makes account disablement and permission changes effective on the next protected request without trusting stale client authorization state. Production requires `NEXTAUTH_SECRET`; generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` and configure it through the deployment secret environment. Do not commit it.

Emails are normalized using Unicode NFKC normalization, trimming, and lowercase before lookup or uniqueness checks. Authentication failures use the same `Invalid email or password` message for unknown, disabled, and incorrect-password accounts. There is no public registration route.

`npm run bootstrap:owner` is an interactive operator command. It prompts for the Owner email and reads the password without echo; use a password with at least 14 characters. It requires the Phase 2 organization, `MAIN` location, and `OWNER` role seeds, hashes with Argon2id, assigns the Owner role transactionally, and can be retried without replacing an existing account password. Do not pass the password as a command-line argument or store it in source control.

Authorized administrators can provision a user from the Users page by selecting a role at the currently authorized location and supplying an initial password (14 or more characters). The account and location-specific role assignment are created atomically. User enable/disable updates require `admin.users.manage`, a matching expected record version, and an existing location assignment; self-disable is rejected. User-list responses expose neither password hashes nor credential fields.

The initial seed creates the `Restaurant Operations POC` organization (`America/Detroit`, `USD`), `Main Restaurant` (`MAIN`), and exactly Dining Room, Bar, and Takeout areas. Location settings default to a 4:00 AM business-day cutoff, 90-minute table turns/reservations, a 15-minute wait quote, and enabled walk-ins, reservations, takeout, inventory, scheduling, and kitchen display. The 9 stable security roles and centralized permission catalog live in `src/modules/auth/permission-catalog.ts`; Employee Positions remain a separate Phase 3 concept. The Owner receives every catalog permission; the General Manager and Manager receive operational subsets; Server, Bartender, Host, Cook, Wait Staff, and Inventory Manager receive role-specific least-privilege subsets.

CI generates an ephemeral `NEXTAUTH_SECRET`, runs migrations and integration tests against its PostgreSQL service, installs Chromium for the authentication E2E suite, and requires `npm audit --omit=dev` to remain clean. The accepted development-only advisory `DEV-001` remains unchanged; do not use forced incompatible dependency remediation.

`npm run test:integration` and `npm run test:e2e` recreate and seed only the isolated `TEST_DATABASE_URL` database. Browser tests create unique accounts with runtime-generated passwords in that database and remove them afterward. They do not use a known/default password or the normal development database.

### Phase 3 Employees and HR

An Employee is a person employed by the restaurant; a User is an application identity. The optional unique `employees.user_id` link does not synchronize permissions. Employee Positions are maintained in `positions`/`employee_positions`; Security Roles and Permissions remain exclusively in the Auth/RBAC domain. Changing either assignment never changes the other.

Employee creation records an initial `ACTIVE` status-history entry and an effective-dated primary location, with an optional independent initial position. Location and position changes require an expected employee version and preserve ended assignments. An employee is reachable only from a location where they have a current or ended assignment; anywhere else, and from any other organization, they look absent. Assigning at another location needs the permission at both the current and the target location. Effective end dates are inclusive and can't be in the future, because an ended row stops being active at once.

Employee termination preserves all HR history, ends active location/position eligibility, and disables a linked User in the same PostgreSQL transaction, through the `terminate-employee` workflow. It needs `employees.terminate` and applies the Phase 2 safeguards: if the linked User is the actor, the organization's last Owner, or holds permissions the actor lacks, the whole termination is refused, and an Owner's termination must be done by another Owner. `TERMINATED` is final, so a rehire gets a new Employee record, and terminated employees are not physically deleted. A User linked to a terminated employee can't be re-enabled; an administrator must first unlink it as a deliberate step. Linking and unlinking need both `employees.edit` and `admin.users.manage`. `ON_LEAVE` and `SUSPENDED` don't affect the linked User.

Compensation is keyed by Employee + Position and uses effective-dated `NUMERIC(12,2)` values read and written as decimal strings. A change closes the prior period for that Employee + Position the day before and creates a new row transactionally; overlapping periods for the same Employee + Position and mixed HOURLY/SALARY fields are rejected. The employee must hold the position on the wage's effective date. Termination leaves compensation history as it is. Phase 3 does not perform payroll.

HR queries are purpose-specific and each service enforces its own permission: `employees.view` receives general employment data only (name, number, work email, employment type, hire date, current locations and positions). Current employment status, termination date, status history and ended assignments need `hr.view`, the Management tier in section 10. Personal email, phone, addresses and emergency contacts need `hr.personal.*`. Compensation, certifications, notes, performance reviews, disciplinary actions, and documents require their corresponding `hr.*` permissions. Manager/performance note types and explicitly sensitive notes require the separate `hr.notes.sensitive.*` permissions, and documents flagged sensitive (the default) require `hr.documents.sensitive.*`. APIs independently enforce these boundaries. The Manager role holds the Management tier: `hr.view` and `hr.certifications.*`, `hr.performance.*` and `hr.notes.*`, without the sensitive permissions.

Employee document binaries are stored outside PostgreSQL and outside `public/`, under the ignored local `EMPLOYEE_DOCUMENT_STORAGE_PATH` (default `.local/hr-files`). `EMPLOYEE_DOCUMENT_MAX_BYTES` defaults to 10 MiB (maximum 50 MiB). The local adapter accepts PDF, PNG, JPEG, and UTF-8 plain text with signature/content checks, generated UUID keys, and private file/directory modes. Download passes through an authorized Route Handler; no public file URL or deletion endpoint is provided. A failed metadata insert triggers best-effort removal of the just-written file. S3 remains deferred.

The idempotent Phase 3 seed adds the eight configurable restaurant positions and generic FOOD_SAFETY/ALCOHOL_SERVICE certification types; it creates no employee records. `npm run db:seed` upgrades role grants through a versioned seed key. Effective-period overlap is enforced by PostgreSQL exclusion constraints, in a custom migration that also enables the `btree_gist` extension.

### Phase 4 Scheduling

Schedule periods are location-scoped and use the lifecycle `DRAFT -> PUBLISHED -> ARCHIVED`. Only drafts are directly editable. Every schedule mutation compares the expected period version; shift edits also compare the shift version. Publish and archive are explicit manager operations. Publishing revalidates every active assignment and rejects overlapping published periods, using an exclusion constraint as the final check; open slots warn but don't block. Published assignments are changed only through the explicit accepted shift-swap workflow; generated schedules are never automatically published. Assignment rows are never deleted: a removal ends them as `REMOVED` and a completed swap as `SWAPPED`. A cancelled draft shift keeps its row.

An employee who becomes ineligible after being scheduled (terminated, on leave or suspended) keeps their assignments, and the termination workflow doesn't touch Scheduling. Coverage reports each as a hard violation, a draft can't publish until it's removed, and a published one moves by swap.

Shifts store real instants as `TIMESTAMPTZ`, constructed from the shift date and wall-clock times in the location timezone. Overnight shifts are supported; nonexistent local times during a daylight-saving jump are rejected. A shift's `shift_date` is the location-local date of its start.

Scheduling qualification uses only an ACTIVE Employee, effective employee-location eligibility, the effective Employee Position required by the shift, availability, approved time off, overlap checks, and configured hard limits. Security Roles only authorize software actions and never qualify an Employee to work a Position. Compensation and restricted HR records are not read by eligibility, coverage, or scoring.

**Availability policy:** a shift requires applicable `AVAILABLE` records covering every minute of the entire shift. Missing data returns `AVAILABILITY_NOT_CONFIGURED` and is ineligible; explicit unavailable intervals and configured availability that does not cover the full shift have distinct results. Date exceptions take precedence over recurring windows for the intervals they cover; recurring availability must cover the remaining shift. This same evaluator is used by manual assignment, generation, Fill Open Shifts, and swap acceptance/approval. There is no manager override; employees or authorized managers must correct/configure the data first.

Approved time off is a hard conflict; approval is blocked while conflicting assignments remain. Pending time off is not a hard constraint: it creates a deterministic score penalty and a manager warning. Employee self-service resolves the optional User-to-Employee link on the server and supports availability/preferences, time off, published shifts, and shift-swap requests. It never accepts an arbitrary Employee ID as the self-service identity.

Shift swaps run `PENDING -> ACCEPTED -> COMPLETED`, with `DENIED` and `CANCELLED`, on published shifts that haven't started. The receiving employee faces the shared eligibility rules at acceptance and again at approval. Approval, in one transaction, ends the original assignment, creates a `SHIFT_SWAP` assignment and records the approver. A holder of `schedule.swap.approve` can open a swap, name the receiving employee or record acceptance on an employee's behalf, because someone with no login, or who has left, can't do so themselves. There is no open marketplace.

Staffing templates create staffing requirements, not employee assignments. Applying a template to a draft creates each requirement/date shift at most once and does not overwrite existing manager work, including a shift the manager cancelled. Manager scheduling rules make hard limits explicit; maximum days/week, consecutive days, and minimum rest can be configured as hard limits, and a maximum weekly hours value is always hard, while soft preferences influence scores and warnings only. Rules also set the first day of the scheduling week (default Monday). They are business configuration and do not establish labor-law compliance.

Definitions used by rules and scoring: the worked day is `shift_date`, including for a shift past midnight; a weekend shift falls on a Saturday or Sunday; an opening shift starts before 11:00 local; a closing shift ends at or after 22:00 local or past midnight; the fairness lookback is the current period.

Employment status is Management-tier data, so scheduling reports every non-`ACTIVE` status as one code, `EMPLOYEE_NOT_SCHEDULABLE`. Users without `schedule.edit`, `schedule.generate` or `schedule.publish` see only published and archived periods, and no coverage or explanations. Time-off reasons are visible only to the requester and to `schedule.time-off.approve` holders.

Automatic generation uses the shared eligibility service and deterministic scoring. Initial score adjustments are: below target hours `+20`, at/above target `-10`, crossing the overtime-avoidance threshold `-50`, preferred-time match `+12`/mismatch `-6`, weekend/closing fairness `+8` per shift, short-rest preference `-18`, pending time-off overlap `-24`, exceeding a soft weekly-day preference `-12` per day, and exceeding a soft consecutive-day preference `-15` per day. Fairness is `+8` per shift fewer than the most loaded candidate. Ties use employee number then UUID. Generated assignments retain hard-check and score reasons in `shift_assignments.generation_rationale`; unfilled slots keep structured eligibility codes and counts on the generation run, without employee identity, and rejected candidates aren't stored individually. Generation runs snapshot rules/weights and use schedule-version revalidation before an atomic write: the computation happens outside the transaction, and the write rechecks the version and all hard constraints on fresh data. A stale version or changed data writes no assignments and records the run as `FAILED` with a safe code. `GENERATE_DRAFT` requires an unassigned draft; `FILL_OPEN_SHIFTS` preserves existing assignments and fills only remaining slots. A generated assignment is an ordinary assignment with `GENERATED` provenance, changed by a manager through the same validation as a manual one.

Scheduling permissions are separate for viewing/editing/generating/publishing (`schedule.view`, `.edit`, `.generate`, `.publish`), availability/preference management (`schedule.availability.self`, `.manage`), time-off requests/approval (`schedule.time-off.request`, `.approve`), swaps (`schedule.swap.request`, `.approve`), templates (`schedule.templates.manage`), and rules (`schedule.rules.manage`). `npm run db:seed` registers default scheduling rules for scheduling-enabled locations; it does not create fake employee or staffing demand records. See `docs/Phase-4-Completion-Report.md` for the implementation and validation checklist.

### Phase 5 Restaurant and Seating

**Condition and occupancy are separate facts.** `restaurant_tables.condition` is `CLEAN`, `DIRTY` or `OUT_OF_SERVICE`, and nothing else. Occupancy derives from open rows in `table_session_tables`, so a clean, occupied table is normal. The labels `AVAILABLE`, `OCCUPIED`, `DIRTY`, `OUT_OF_SERVICE` and `INACTIVE` are derived for screens and stored nowhere. A table is inactive if it, or its area, is. Takeout is never a table: a table or section can't be created in a Takeout area.

**Table sessions** run `ACTIVE -> COMPLETED` or `ACTIVE -> CANCELLED`. A partial unique index allows one open membership per physical table, and every operation locks the session and then its tables, sorted by ID, before reading availability, so two hosts can't take one table. Combined tables are relational membership rows; table numbers never encode a combination. All tables in a session must be in one area, so server qualification has one answer, and there is no cap on how many. The three-table limit in section 13 applies to Phase 6 recommendations and planned reservation tables, not to real sessions.

**Capacity.** A party fits if it's no larger than the sum of its tables' capacities. `minimum_capacity` is guidance only. Going over needs `restaurant.capacity.override` and a reason, and it's checked again on each move and removal. Each override writes a row to the append-only `table_session_overrides`, which holds overrides only and isn't an audit log.

**Moving and condition.** A move is a set difference within the same session: tables in both sets stay, new tables must be clean and free, and vacated tables always become `DIRTY`. Removing a combined table does the same; a session's last table can't be removed. Completion ends all memberships and marks every table `DIRTY` in one transaction. Cancellation is for a mistaken seating, needs `restaurant.cancel-session` and a reason, and leaves tables as they are. Cleaning is the explicit `DIRTY -> CLEAN` step, never automatic. An occupied table can't change condition, be deactivated or change area; its session has to end first. Returning from `OUT_OF_SERVICE` names its target condition. Each change appends to `table_condition_history`, which is domain history, not the audit domain.

**Server qualification** is an `ACTIVE` Employee, effective at the location, holding an effective position allowed in the area: `DINING` takes `SERVER` or `WAIT_STAFF`, `BAR` takes `BARTENDER`, `SERVER` or `WAIT_STAFF`, and Takeout takes nobody. The policy is one replaceable function in `src/modules/restaurant/rules/server-area-policy.ts`. Security Roles have no input to it. Effective dates use the location-local calendar date. Status, location and position failures share one code, `SERVER_NOT_QUALIFIED`, because employment status is Management-tier. No override reaches this rule.

**Schedule match.** The server must also have an `ACTIVE` assignment on an uncancelled shift in a `PUBLISHED` period, at this location, in a position they hold and the area allows, with `start_at <= now < end_at`. Otherwise assignment needs `restaurant.schedule.override` and a reason, including when no schedule is published. It's evaluated at the moment of assignment, so assigning someone just before their shift needs the override. A server who later stops qualifying keeps the session and is flagged on the floor; a move into an area they can't work is refused until they're reassigned.

**Sections.** A table has at most one active section, and a section's tables must be in its area when it has one. `server_section_assignments` records operational ownership for one business date, from `BusinessDateService` (`src/shared/time/business-date-service.ts`, the sole calculator). A section has one server per business date, and the current one must be ended before another is assigned. A section's server is separate from a session's server: a new session defaults to the section's server only if every selected table resolves to the same person and that person needs no override. Reassigning a session or changing a section never alters the other.

**Permissions.** `restaurant.view`, `.tables.manage`, `.sections.manage`, `.seat`, `.move`, `.complete-session`, `.cancel-session`, `.clean-table`, `.condition.manage`, `.server.assign`, `.capacity.override` and `.schedule.override`. Phase 2's `restaurant.manage` was never enforced and is retired by the `security.restaurant-permissions` seed. Owner, General Manager and Manager hold all of them. Host holds `view`, `seat`, `move`, `complete-session`, `clean-table` and `server.assign`. Server and Bartender add `complete-session` and `clean-table`; Wait Staff adds `clean-table`. Only capacity and schedule matching can be overridden. Location, inactive, occupied, dirty, out-of-service and position rules cannot.

The development seed adds tables T01 to T04 in the Dining Room and B01 and B02 at the Bar, with sections `DINING_A` and `BAR`, at `MAIN`. It creates no sessions. Phase 9 added orders that reference a session, and a session can't be completed or cancelled while any of its orders is OPEN (see the Phase 9 policies). The floor refreshes every 30 seconds; Phase 10's realtime covers kitchen, bar, order and notification events, and floor events are not yet published.

### Phase 6 Reservations and Waitlist

**Guest Party, Reservation and Waitlist Entry are three records.** A Guest Party is the group served. A Reservation is one arrival plan for it (at most one per party), and a Waitlist Entry is a wait for a table (at most one open per party). A walk-in has a party and perhaps an entry, with no reservation. A reservation party seated at once never joins the waitlist, and one that has to wait joins it without a second party. `party_status_history` is append-only and each status change writes it in the same transaction. Contact fields (`phone`, `email`) exist only to run the two lists: they are never logged, never appear in conflict summaries, recommendations or the floor, and come back only to holders of `reservations.view` or `waitlist.view`.

**Reservation statuses** are `PENDING`, `CONFIRMED`, `CHECKED_IN`, `SEATED`, `COMPLETED`, `CANCELLED` and `NO_SHOW`. Staff-created reservations are `CONFIRMED` unless entered as `PENDING`; `PENDING -> CONFIRMED` is an explicit step, a pending reservation can be cancelled but cannot check in, be seated or be a no-show, and it still blocks planned-table conflicts and holds. `CONFIRMED -> CHECKED_IN` records `checked_in_at`, and check-in creates no session. A confirmed or checked-in party can be seated, and seating from `CONFIRMED` records the arrival. `SEATED -> COMPLETED` is done by the `completeTableSession` workflow in the same transaction as the Table Session, with no trigger between domains. Cancelling a reservation after seating is refused. Cancelling a mistaken seating (`cancelTableSession`) returns the party to `CHECKED_IN` (or its waitlist entry to `WAITING`/`NOTIFIED`) and the history says so. Reservation times are entered as location-local date and time and converted with the location time zone; `business_date` comes from `BusinessDateService`.

**Holds.** `location_settings.reservation_pre_hold_minutes` and `reservation_post_grace_minutes` (both 15 by default) define two separate half-open intervals, computed only in `src/modules/reservations/rules/hold-intervals.ts`: reservation planning conflicts use `[reservation_at - pre_hold, reservation_at + expected_duration + post_grace)` and walk-in hold protection uses `[reservation_at - pre_hold, reservation_at + post_grace)`. Adjacent intervals do not conflict. `PENDING`, `CONFIRMED` and `CHECKED_IN` reservations block and hold; `SEATED`, `COMPLETED`, `CANCELLED` and `NO_SHOW` do not, and a reservation whose window has ended is history rather than a conflict. A hold is a planning protection and never occupancy: a held table is physically `AVAILABLE`, and the floor shows it with a separate "Reservation hold" or "Reserved soon" indicator. No automated job changes a reservation.

**Planned tables** (`reservation_table_assignments`) are ended, never deleted, when replaced, cancelled, marked no-show or seated, so what was planned stays beside what was used. At most three tables in one area may be planned, their combined capacity must seat the party (planning has no capacity override; the Phase 5 override applies when seating), and every table is locked before conflicts are checked so two hosts can't plan one table. Seating may use different tables, and the planned rows are not rewritten.

**No-show** is manual, only for a `CONFIRMED` reservation, at or after `reservation_at + reservation_post_grace_minutes`. It records the actor and time, releases the planned tables, and never touches seating.

**Waitlist statuses** are `WAITING`, `NOTIFIED`, `TABLE_ASSIGNED`, `SEATED`, `CANCELLED` and `LEFT`. `NOTIFIED` records that staff contacted the party; nothing is sent. `TABLE_ASSIGNED` is the host's saved selection and creates no occupancy. A quoted wait is an estimate staff may type or replace. The suggestion is a conservative function of what is seated now, the usual turn time (`default_table_turn_minutes`), active holds and the parties ahead, and it learns nothing from history. `LEFT` is the party giving up; `CANCELLED` is a removal. Neither deletes anything.

**Recommendations** are a pure ranked list, never an action. Only `AVAILABLE` tables with no hold for another party qualify. One table ranks before a combination, then fewer tables, then the preferred Restaurant Area, then the smallest surplus of seats, then natural table number and ID. Combinations have at most three tables in one area and no table that isn't needed. Excluded tables come back with a reason. Viewing a suggestion reserves nothing.

**Seating orchestration.** `seatReservationParty`, `seatWaitlistParty` and `seatWalkIn` (`src/workflows/seat-guest-party/`) lock the party, its reservation and its open waitlist entry in that order, check the version the host saw, then run the Phase 5 seating (`seatPartyInTransaction`) on the same transaction, then move the party, reservation and waitlist entry to `SEATED` and end the planned tables. A unique index allows one `ACTIVE` session per Guest Party. Reservation holds are checked after the Phase 5 rules: an ordinary host can't seat an unrelated party at a held table. A holder of `reservations.override-hold` can with a reason, which appends a `reservation_hold_overrides` row; the override never bypasses dirty, out-of-service, occupied, inactive, capacity, location or server rules, and never cancels the reservation. Orders in Phase 9 still reference the Table Session, not the reservation.

**Permissions.** `reservations.view`, `.manage`, `.override-hold` and `waitlist.view`, `.manage`, `.notify`, `.seat`. Owner, General Manager and Manager hold all of them. Host holds all except `reservations.override-hold`. Seating a reservation or waitlist party needs `restaurant.seat` as well. The `security.reservations-permissions` seed adds the new codes. No reservation, party or waitlist data is seeded.

### Phase 7 Menu and Recipes

**Menu Item is not Recipe, and Recipe is not Inventory.** A Menu Item is what is sold and has no category column: it reaches a Category through `menu_item_placements` (menu, category, item, display order, active), and one item may have many placements. A Recipe is a durable identity (optionally linked to one Menu Item) with immutable revisions. Neither stores stock. Recipe revisions carry yield and preparation notes only. **Recipe ingredients, quantities and persisted modifier ingredient effects are Phase 8**, when a revision can reference an Inventory Item. Phase 7 builds no ingredient catalog.

**Active versus available.** `active` keeps an item in the catalog and its history. `available` says it can be sold now. The operational menu returns an item only when the menu is active and offered at the location (and inside an availability window, if it has any), the category, placement and item are active, the item is available, and a price is in effect. Nothing infers availability from stock or recipes.

**Prices** are `NUMERIC(12,2)` decimal strings, effective-dated and half-open `[effective_from, effective_to)`. A location price wins over the organization default (`location_id` null). An exclusion constraint forbids two prices in force in one scope. A change takes the item row lock, closes the open row where the new one begins and inserts the new row, in one transaction; an optional `expectedCurrentPriceId` rejects a stale editor. A new price can't start in the past, can't start at or before the one it replaces, and can't jump ahead of one already scheduled. `resolveMenuItemPrice` is the only lookup; Orders will call it, not read the rows. Placement price overrides are deferred.

**Exact arithmetic without a library.** `src/shared/decimal/` does addition, comparison, scale checks and multiplication on decimal strings with `BigInt`. It refuses extra precision instead of rounding, and nothing converts a price or quantity to a JavaScript `number`. No dependency was added.

**Modifier groups** have four selection types (`OPTIONAL_SINGLE`, `REQUIRED_SINGLE`, `OPTIONAL_MULTIPLE`, `REQUIRED_MULTIPLE`) with minimum and maximum counts that the type constrains, in the service and in a check constraint. An item's attachment can override: `required_override` true means at least one, false means none, and explicit minimum or maximum overrides win; a single-choice group never allows more than one. `validateSelection` (pure) and `validateModifierSelection` (loads an item's groups) are the one server-side validator Phase 9 will reuse. Selections name the group and the modifier, so a modifier in two groups is unambiguous. Inactive groups are not required; inactive modifiers are refused. `calculateItemAmount` adds the resolved base price and each chosen adjustment exactly; it has no tax, discount or order total.

**Modifier behavior has three separate kinds.** Price effect (`price_adjustment`), preparation effect (`preparation_effect_type` plus an instruction, which never affects inventory) and recipe effect. Recipe effects are a typed contract only: `ADD`, `REMOVE` and `ADJUST` with a positive exact quantity and an Inventory Item ID, and a substitution is a `REMOVE` plus an `ADD`. A preparation-only effect can't become an ingredient delta. Nothing is persisted and no Inventory Item or unit compatibility is checked until Phase 8.

**Prep stations** are location-scoped configuration (`GRILL`, `FRY`, `SALAD`, `BAR`, `EXPO` are seeded). `menu_item_prep_routing` links an item to one or more stations at a location, for Phase 10 to read. No ticket, claim or fire exists.

**Units of measure.** `units_of_measure` (`EACH`, `OZ_WEIGHT`, `LB`, `G`, `KG`, `FL_OZ`, `ML`, `L`; never an ambiguous `OZ`) and explicit `unit_conversions` with a positive `NUMERIC(14,6)` factor. A conversion is allowed only within one measurement type (a composite foreign key enforces it), is never chained, uses no density, and is refused if its exact result needs more than four decimal places. Only exact conversions are seeded (`LB`/`OZ_WEIGHT`, `G`/`KG`, `ML`/`L`); fluid ounces to milliliters is not approved.

**Recipe revisions.** `DRAFT -> PUBLISHED -> RETIRED`, numbered from 1 per recipe. A draft is editable and has no interval. Publishing (under a recipe row lock) closes the earlier revision where the new one begins and sets the new interval, `[effective_from, effective_to)`; it can't start in the past or at or before an earlier revision. An exclusion constraint allows at most one revision in effect at any instant. Content (yield `NUMERIC(14,4)` and unit, notes, number) is frozen by a trigger once a revision leaves `DRAFT`, and published revisions can't be deleted. Retiring ends the interval now, or gives a never-effective revision an empty one. `resolveEffectiveRevision` and `resolveEffectiveRevisionForMenuItem` return the revision in effect at an instant, which Phases 8 and 9 will use.

**Permissions.** Six new codes (93 in all): `menu.pricing.view`, `menu.pricing.edit`, `menu.modifiers.manage`, `prep-stations.manage`, `recipes.view`, `recipes.edit`. Owner, General Manager and Manager hold them. Servers, bartenders, hosts, cooks and wait staff hold `menu.view` only. `menu.edit` covers categories, menus, items, placements and attaching groups; `menu.modifiers.manage` covers group and modifier definitions. The `security.menu-permissions` seed adds the codes; the `recipes.units-of-measure` and `menu.initial-configuration` seeds add the units, conversions, categories, stations and an empty Main Menu offered at MAIN. No menu item, price or recipe is seeded.

**Extension points.** Phase 8 added `recipe_version_ingredients` and `modifier_inventory_effects` (see the Phase 8 policies, which also changed the effect semantics). Phase 9 snapshots the operational menu query's item, price and modifier choices into order items. Phase 10 reads `menu_item_prep_routing` and `prep_stations`.

### Phase 8 Inventory and Purchasing

The six approved Phase 8 policies (negative inventory, negative-balance costing, weighted-average rounding, count activity, over-receiving, supplier preference) are implemented as stated below. Each has focused automated tests.

**Inventory Item is ingredient identity.** Recipes and stock use the same `inventory_items` row; there is no separate component catalog. An item has a measurement type and a base stock unit of that type (a composite foreign key enforces it); the stock unit can't change once the item has ledger history. `inventory_item_locations` says where it is stocked and holds par, reorder level and reorder target in base units (non-negative; reorder level at or below par and target).

**Two conversion mechanisms.** Generic conversions (`unit_conversions`, same measurement type, e.g. LB to OZ_WEIGHT) and per-item packaging (`inventory_item_unit_conversions`, e.g. 1 CASE = 12 BOTTLE, 1 BOTTLE = 1 L). Packaging may cross measurement types for one item. Each unit has at most one active outgoing packaging conversion (a partial unique index) and saving refuses cycles, so the path to the base unit is unique: same unit, else a generic step, else follow the item's chain, optionally ending with one generic step. Results are exact and refused beyond four decimal places. Packaging units (`CASE`, `BOTTLE`, `CAN`, `BAG`, `BOX`, `PACK`, `SLICE`) are COUNT units; what they hold is always per item.

**One posting service.** `postInventoryTransaction` (`src/modules/inventory/services/posting-service.ts`) is the only writer of `inventory_transactions` and `inventory_balances`; a test scans the module to prove it. It locks the item's balance row (created at zero if new), converts the entered quantity to base units, applies the negative policy and costing, appends the ledger row with `quantity_after` and `average_cost_after`, updates the balance, and returns the result, inside its caller's transaction. Business dates come from `BusinessDateService`. A trigger makes the ledger, receipts, receipt lines and supplier cost history append-only; corrections are compensating rows. `reconcileBalances` compares the projection with ledger sums, and `ledgerQuantityOnHand` recomputes QOH as of an instant or a business date. Concurrent postings for one item and Location serialize on the balance lock; a test of 20 simultaneous postings proves no lost update.

**Negative inventory.** `location_settings.allow_negative_inventory` defaults to false. When false nothing may leave QOH below zero. When true, only `CONSUME` may; `WASTE`, `ADJUST_DECREASE`, `COUNT_DECREASE` and `TRANSFER_OUT` never may. Increases are always allowed. Nothing clamps. `postConsumption` is the Phase 9 entry point.

**Weighted-average cost.** Per base unit, `NUMERIC(14,4)`, computed with exact `BigInt` arithmetic (`divideRoundHalfUp` in `src/shared/decimal/`) and rounded ROUND_HALF_UP to four places after each receipt; the persisted value is the next receipt's basis, with no hidden precision. A receipt enters as its exact total cost, so a base-unit cost needing more than four places isn't rounded twice. From QOH at or below zero the ordinary formula is never used: a receipt that leaves QOH at or below zero keeps the average, and one that lifts it above zero sets the average to that receipt's base-unit cost. Stock that arrived with no cost (an adjustment before any receipt) takes the next receipt's cost as its first average. Outgoing movements are valued at the current average and don't change it. Transfers carry the source's average to the destination. Costs and valuation are returned only to holders of `inventory.cost.view`.

**Suppliers and purchasing.** `supplier_items` says how a supplier sells an item: a purchase unit and `base_units_per_purchase`, computed from the item's conversions when saved and refused if the unit can't convert. There is no preferred-supplier field and nothing chooses a supplier: an order names one explicitly, and low-stock results list every active supplier option. Listed costs and every receipt price are appended to `supplier_item_cost_history`. Purchase orders are numbered per Location (`PO-000001`) and move `DRAFT -> SUBMITTED -> PARTIALLY_RECEIVED -> RECEIVED`, or to `CANCELLED` from any but `RECEIVED`. Only drafts are edited. Lines snapshot the supplier item, unit, conversion and price; the order total is the exact sum of line totals; no tax or freight. Submitting moves no stock.

**Receiving** locks the order, refuses over-receiving per line (no override), and in one transaction writes the receipt and its lines, posts a `RECEIVE` per line through the posting service at the actual cost, appends cost history, and sets the order status. The ordered price is never rewritten; the actual price lives on the receipt line. Any refused line rolls back the whole receipt. A cancelled order can't receive; stock already received stays.

**Waste and adjustments.** Waste posts `WASTE` with a structured reason (`SPOILAGE`, `BREAKAGE`, `PREP_WASTE`, `EXPIRED`, `OTHER`). Adjustments post `ADJUST_INCREASE` or `ADJUST_DECREASE` with a reason (`RECEIVING_CORRECTION`, `FOUND_STOCK`, `THEFT_OR_LOSS`, `DATA_CORRECTION`, `OTHER`); a check constraint requires the reason. There is no "set quantity" field anywhere.

**Transfers** post `TRANSFER_OUT` and `TRANSFER_IN` with a shared reference in one transaction, locking both balances in a stable order. The actor needs `inventory.transfer` at both Locations (the destination is re-checked against the database); both must stock the item; a transfer can't create negative stock.

**Counts.** `DRAFT -> SUBMITTED -> APPROVED`, with `SUBMITTED -> DRAFT` to correct and `CANCELLED` from either. Starting a count snapshots each line's expected quantity and the item's latest ledger sequence together under the balance lock. Stock stays live while a count is open. Variance is counted minus expected. Approval locks the balances, so no posting can slip in, and if any ledger row has a higher sequence than a line's snapshot it requires an explicit acknowledgement, recording the actor and time. It then posts each non-zero variance as `COUNT_INCREASE` or `COUNT_DECREASE` against current stock (never setting stock to the count) and approves, atomically. A decrease that would take current stock below zero refuses the whole approval.

**Replenishment** is a recommendation: an item is low when QOH is at or below its reorder level, and the suggestion is reorder target (else par) minus QOH, never below zero. Negative QOH is shown as it is. Nothing creates or submits an order.

**Recipe ingredients.** `recipe_version_ingredients` reference Inventory Items with a positive quantity in any unit convertible to the item's base. They change only on a `DRAFT` revision (a trigger refuses changes to a published revision's rows); each change checks and bumps the revision's version. A draft may copy another revision's ingredients. `resolveRevisionRequirements` returns base-unit requirements for Phase 9. Saving moves no stock.

**Modifier inventory effects** (approved Phase 8 semantics, replacing the Phase 7 contract). Each effect belongs to one modifier and one Menu Item. `ADD` adds a positive quantity; `REMOVE` has no quantity and drops the Menu Item recipe's requirement entirely; `ADJUST` changes it by a signed, non-zero quantity. A substitution is a `REMOVE` plus an `ADD`. The modifier must be offered on the Menu Item, and `REMOVE`/`ADJUST` must name an ingredient of the Menu Item's recipe revision in effect when saved. `applyModifierEffects` (pure) is the Phase 9 rule: `ADD` merges, `REMOVE` drops (a no-op if the recipe no longer has it) and wins over `ADJUST`, and a requirement adjusted to zero or below is dropped. Saving an effect moves no stock.

**Permissions.** Nine new codes (102 in all): `inventory.count.approve`, `inventory.waste`, `inventory.transfer`, `inventory.configure`, `inventory.cost.view`, `purchasing.view`, `purchasing.manage`, `purchasing.submit`, `suppliers.manage`, alongside the older `inventory.view`, `.receive`, `.adjust` and `.count`. Owner, General Manager, Manager and Inventory Manager hold all of them. A Cook holds `inventory.view` and `inventory.waste`. Floor roles hold none. Counting and approving are separate. The `security.inventory-permissions`, `inventory.packaging-units` and `inventory.demo-catalog` seeds add the codes, packaging units, and six demo items stocked at MAIN with one demo supplier; no stock, ledger rows or orders are seeded.

**Phase 9 extension points.** Order SEND resolves the Menu Item's effective revision (`resolveEffectiveRevisionForMenuItem`), its requirements (`resolveRevisionRequirements`), applies the selected modifiers' effects (`applyModifierEffects`), and posts each result with `postConsumption` in the SEND transaction, with its own reference for idempotency.

### Phase 9 Orders

**Orders reference a session, never a table.** `DINE_IN` needs an ACTIVE Table Session whose tables are in a `DINING` area and `BAR` one in a `BAR` area; `TAKEOUT` has no session, no table and no Guest Party, only an optional pickup label. The type is checked against the area, not guessed from it. A session may have many orders; moving it keeps them. DINE_IN and BAR orders copy the session's Guest Party and server. Each order has a UUID and a per-Location, per-business-date number (`order_number_counters`, incremented under a row lock), and its `business_date` comes from `BusinessDateService`.

**Lifecycles.** Orders are `OPEN -> VOIDED`, with `CLOSED` reserved for Phase 11 settlement: Phase 9 has no close operation (Phase 11 closes an order only by completing its Settlement). Items are `DRAFT -> SUBMITTED -> VOIDED`. `order_status_history` and `order_item_status_history` are append-only (item history starts at SUBMITTED; drafts aren't history). Every mutation locks the order row and checks its `version`, so a stale screen gets `CONCURRENCY_CONFLICT`.

**Drafts are previews.** Adding or editing a draft resolves the item through the operational menu and the shared modifier validator and stores preview prices, but consumes nothing and doesn't count toward the order total. Drafts can be edited or removed (removal deletes the row). Sent items are only voided.

**SEND** (`src/workflows/submit-order/`) commits every DRAFT item of an order in one transaction, as one numbered send batch (`order_send_batches`, 1, 2, 3 per order). In order: it authorizes `orders.submit`, claims the idempotency key, locks the order and checks its version. Then, for each item, it re-resolves the item, price and modifiers through `getOperationalMenu`, `resolveSellableItem` and the shared validator, resolves the recipe revision in effect now, and applies the selected modifiers' effects with `applyModifierEffects`, which drops a requirement adjusted to zero or below. It then creates the batch, freezes the snapshots, posts CONSUME rows and writes `order_item_inventory_consumption` (per item and Inventory Item: base quantity, recipe revision, per-unit recipe requirement and the effects applied, and the ledger row), recomputes totals, writes histories and stores the idempotent result. Snapshots include the item code and name, base price, modifier names and prices, unit and line totals, recipe and revision, kitchen instructions (modifier preparation instructions, then free text) and the routed prep station IDs, which is the Phase 10 contract. A trigger freezes a sent item's snapshot and modifier rows. The price is resolved at SEND, so a menu price change while an item is a draft changes what it sells for, and nothing changes afterwards. Free text never affects inventory. An item with no recipe sends with no consumption.

**Stock.** Consumption goes through the narrow trusted capability `postOrderConsumption` (`src/modules/inventory/services/order-consumption.ts`). It is consume-only, references each Order Item, and calls the one posting service, so conversion, costing, balances and the negative-stock policy are Phase 8's. It locks balances in Inventory Item order and, when negative stock isn't allowed, collects every shortage in the batch before posting anything. The whole round fails with `INSUFFICIENT_STOCK` and `details.shortages` (item, required, available, shortage, in base units, never cost). A partial unique index allows one CONSUME per Order Item and Inventory Item. Servers and bartenders hold no Inventory permission; `orders.submit` grants no Inventory endpoint.

**Voids** need `orders.void`, a reason and a disposition. `UNPREPARED` posts `SALE_REVERSAL` rows through `postSaleReversal`, each linked to its original CONSUME, entering at that row's cost through weighted-average costing. `PREPARED_OR_DISCARDED` keeps the consumption and records no waste; staff use the Inventory waste workflow if they want to. The row stays, marked VOIDED, with an append-only `order_item_voids` record. A refused reversal rolls the whole void back. A full order void needs a disposition for every sent item, voids drafts with no movement, and marks the order VOIDED, in one transaction.

**Totals and discounts.** The order stores `item_subtotal` (SUBMITTED line totals), `discount_total` and `subtotal` (post-discount, pre-tax, what Phase 11 settles); a check constraint keeps them consistent. Discounts come only from `discount_definitions` (`ITEM` or `ORDER`, `FIXED_AMOUNT` or `PERCENTAGE`), apply only to sent items, and need a reason. Applying one snapshots its code, name, type and value with the actor; later definition edits change nothing applied. Item discounts apply first, then order discounts, each in application order against what remains, percentages ROUND_HALF_UP to cents, each capped. A 100% discount is marked a comp. The applied amount is a projection recomputed exactly whenever sent items or discounts change; a voided item's discounts become VOIDED, and removal is recorded, never deleted. Discounts never restore inventory. No tax, tip or payment is calculated.

**Table sessions.** A session can't be completed or cancelled while any order on it is OPEN. Order creation locks the session FOR SHARE, the end-session workflow maps the result to `ORDERS_OPEN`, and a database trigger on `table_sessions` is the final guard for any path. Phase 9 never closes an order to unblock this; Phase 11 settlement does.

**Permissions.** New: `orders.view`, `orders.edit`, `orders.discount.apply`, `orders.discount.manage` (106 in all). Owner, General Manager and Manager hold every orders code. Server and Bartender hold view, create, edit and submit. Host, Cook, Wait Staff and Inventory Manager hold none. Orders are location-scoped, with no per-server ownership rule. `orders.close` stays unused until Phase 11. The `security.orders-permissions` seed adds the codes; no orders or discounts are seeded.

**Deferred.** Settlement and closure (Phase 11) and `audit_events` (domain histories and actor columns give provenance). Kitchen and bar tickets and `outbox_events` arrived in Phase 10.

### Phase 10 Kitchen, Bar and Realtime

**One fulfillment model.** Kitchen and Bar are station types, not separate systems. SEND creates, in its own transaction and after the CONSUME postings, one `kitchen_tickets` row per send batch and prep station, and one `kitchen_ticket_items` row per routed Order Item, each with an initial `NEW` history row (`kitchen_ticket_item_status_history`, append-only). Routing comes only from the item's `prep_station_ids_snapshot`; an item routed to several stations gets work at each, an empty route gets none, and an `EXPO`-type station gets none, because Expo is a view and not a preparation hop. Station code, name and type, order number and type, round, table numbers (through the Table Session), takeout pickup label and server name are snapshotted on the ticket, and item name, quantity, modifiers and kitchen instructions on the item, so a later Menu, routing or table change never moves or renames submitted work. A trigger freezes those snapshots and allows no delete. Uniqueness on (batch, station) and (Order Item, station, attempt), plus SEND's idempotency, means a retry creates nothing. Phase 9 items sent before this migration get no tickets (no backfill).

**Lifecycle.** Items are exactly `NEW -> PREPARING -> READY -> COMPLETED`, with `CANCELLED` only from a void; there is no `NEW -> READY`, no going back and no recall, and a trigger enforces the edges. Each action (start, ready, complete/bump) locks the item and checks its `version`; repeating an action that already happened returns the current state and writes no history, and a stale version for a real move is `CONCURRENCY_CONFLICT`. Ticket status is never stored: all cancelled is `CANCELLED`; all terminal with one completed is `COMPLETED`; all non-cancelled ready or completed with one ready is `READY`; otherwise any preparing is `PREPARING`; otherwise `NEW`. The same rule gives an Order Item's overall readiness across stations and attempts. Fulfillment never touches Inventory, never closes the Order, and never bypasses the Table Session open-order guard; takeout runs the same pipeline with no session.

**Queues.** `/kitchen` and `/bar` list tickets with active work, FIFO by submission instant then ticket and item ID, filterable by station, status and order type, plus recently completed tickets. Age is computed from the submission instant at read time and shown with display-only warning (10 min) and late (20 min) bands. `/expo` is read-only and groups work by order. The DTOs carry no price, discount, cost, HR or guest-contact field.

**Voids.** The void workflow locks every station item of the Order Item before any reversal. `UNPREPARED` is allowed only while every item of every attempt is `NEW` (`FULFILLMENT_ALREADY_STARTED` otherwise) and cancels them all, and the `SALE_REVERSAL` covers the original and every Remake CONSUME. `PREPARED_OR_DISCARDED` cancels `NEW`, `PREPARING` and `READY`, keeps `COMPLETED` and `CANCELLED` rows, retains all consumption and posts no waste.

**Remake.** `POST /api/orders/{id}/items/{itemId}/remake` with a reason and an idempotency key (`kitchen.remake` scope). In one transaction it records `kitchen_remakes` (attempt number, reason, actor, time, the previous attempt's item), creates a new ticket and `NEW` item at every station of the original routing with the original snapshots, and posts additional CONSUME, referenced `KITCHEN_REMAKE`, through the trusted `postRemakeConsumption` from the item's immutable `order_item_inventory_consumption` rows, never the current Recipe, with Phase 8's conversion, costing and negative-stock policy. `kitchen_remake_consumption` links each posting to its source row. A shortage rolls the whole Remake back. Price, discounts, totals, the Order version and Order Items are unchanged.

**Notifications and realtime.** When a ticket's derived status becomes `READY`, the same transaction writes one notification (`FOOD_READY` for kitchen stations, `BAR_ORDER_READY` for bar) for the order's server's linked active user, else whoever sent the batch; a ticket notifies at most once. Only the recipient can list or mark it read. Every change writes outbox events that reach screens through the processor and Server-Sent Events (section 23). The app header has an Alerts bell; KDS and order screens refresh on events and show the connection state.

**Permissions.** New: `bar.view`, `bar.manage`, `fulfillment.start`, `.ready`, `.complete`, `.remake` (112 in all). Viewing a station needs `kitchen.view` (KITCHEN stations) or `bar.view` (BAR stations); each action needs its `fulfillment.*` code and `kitchen.manage` or `bar.manage` for the station's type, at the actor's location. Owner, General Manager and Manager hold all of them. Cook: `kitchen.view`, `kitchen.manage` and the four actions. Bartender: `bar.manage` and the four actions, and loses the Phase 2 `kitchen.manage` (never enforced). Server, Bartender and Wait Staff hold `kitchen.view` and `bar.view` for Expo context. No kitchen role gains an Inventory permission. The `security.kitchen-permissions` seed applies this to existing databases; no tickets or notifications are seeded.

**Stations.** A trigger refuses deactivating a prep station that still has `NEW`, `PREPARING` or `READY` work (`STATION_HAS_ACTIVE_WORK`). Renaming is allowed and changes no ticket.

### Phase 11 Settlements

**Order vs Settlement vs Tender.** An Order says what was sold; a Settlement (`order_settlements`) says how that obligation was satisfied; Tenders (`settlement_tenders`) are the individual cash, card or other records inside it. No tender or payment field is on `orders`. Settlement is **record only**: nothing authorizes, charges, refunds or contacts a provider, and no payment SDK is installed.

**Lifecycle.** Settlements are `OPEN -> COMPLETED` or `OPEN -> CANCELLED`, with append-only `settlement_status_history`; both end states are terminal and a trigger freezes them. A partial unique index allows one OPEN and one COMPLETED settlement per order; cancelled ones stay as history. Opening needs an OPEN order, locks the order row, snapshots `orders.subtotal` (the Phase 9 post-discount, pre-tax amount, never re-priced) as `order_amount_snapshot`, and asking again returns the open one. A settlement can be cancelled (with a reason) only once no RECORDED tender remains. Business dates (`opened_business_date`, `completed_business_date`, tender `business_date`) come from BusinessDateService.

**Amount lock.** While a settlement is OPEN the order's amount and status can't change: SEND, item and order voids, and discount changes are refused with `SETTLEMENT_IN_PROGRESS` (the SEND and void workflows check first; an `orders` trigger is the final guard). Draft edits are allowed, but completion needs no DRAFT item. To change the check, void the tenders and cancel the settlement.

**Tenders.** `CASH`, `EXTERNAL_CARD`, `GIFT_CARD`, `HOUSE_ACCOUNT` and `OTHER`, each with its own permission. Status is `RECORDED`, `VOIDED` or `FAILED`; only RECORDED counts. The amount applied is positive and never more than what remains, so nothing over-settles. Tips are separate, nonnegative, exact cents, and only on CASH and EXTERNAL_CARD; they never change prices, discounts or the snapshot, and aren't allocated to employees. Cash records `received_amount`, and `change_amount = received - applied - tip` must be zero or more (no rounding); change is never tender value. `OTHER` needs a description. `FAILED` is only an externally reported EXTERNAL_CARD failure with a reason, kept at zero. A RECORDED tender can be voided (reason, actor, time) only while the settlement is OPEN; for an external tender that corrects this record only. Tenders are never deleted or edited otherwise.

**Card safety.** Safe metadata only: provider, external reference, card brand, last four (exactly four digits) and authorization reference. There is no column for a card number, CVV/CVC, track data, PIN or bank details, and every text field refuses 13 or more consecutive digits (Zod, service and a check constraint). References and card metadata are returned only with `settlements.view-card-metadata`. Request logs carry no submitted values.

**Completion** (`src/workflows/close-order/`) is one transaction: idempotency claim, lock order then settlement, version check, both OPEN, no DRAFT items, snapshot equal to the order amount, remaining exactly `0.00` (BigInt decimal arithmetic), settlement COMPLETED with history, order CLOSED with `closed_at` and history, outbox events, stored result. A fully comped order completes the same way with no tender. A trigger refuses `orders -> CLOSED` without a COMPLETED settlement for that amount and refuses any change to a CLOSED order, so there is no close bypass and no reopen. `orders.close` stays unused. Refunds, post-completion corrections and reopening are deferred.

**Idempotency and concurrency.** Tender recording (`settlements.tender`) and completion (`settlements.complete`) take client idempotency keys; a retry returns the first result. Every command locks the order row, then the settlement, and checks the settlement `version`, so two terminals can't both take the last of the balance or close an order twice.

**Boundaries.** Settlement writes no inventory transaction, changes no fulfillment, order item or snapshot, and doesn't end a Table Session. Closing the last order on a session only lifts the open-order guard; the explicit physical completion still ends the session and marks tables DIRTY. Takeout settles and closes with no session. Fulfillment never settles or closes an order. Outbox events (identifiers only): `settlement.opened`, `.tender-recorded`, `.tender-voided`, `.completed`, `.cancelled`, `order.closed`.

**Tax** is deliberately not calculated; the UI says the amount due is before tax.

**Permissions.** New: `settlements.view`, `.create` (open and cancel), `.tender.cash`, `.tender.external-card`, `.tender.gift-card`, `.tender.house-account`, `.tender.other`, `.void-tender`, `.view-card-metadata` (121 in all, with the Phase 2 `settlements.complete`). Owner, General Manager and Manager hold all ten. Server and Bartender hold view, create, cash, external card, gift card and complete. Host, Cook, Wait Staff and Inventory Manager hold none. The `security.settlement-permissions` seed applies this to existing databases; no settlements or tenders are seeded.

### Phase 12 Reporting

**Read-only by construction.** `src/modules/reporting/` runs every report inside `withReadOnlySnapshot` (a `REPEATABLE READ, READ ONLY` transaction), so PostgreSQL refuses any write and every figure in a report comes from one snapshot. It imports no other module's services, has no tables of its own, and uses indexed aggregation queries, with no views, summary tables or caches. Each report is for one Location and an inclusive business-date range of at most 92 days. Sources with a `business_date` column filter on it. Sources stored only as instants (kitchen items, Table Sessions, reservations, waitlist, settlement cancellations, supplier costs) use `businessDateRangeBounds` from BusinessDateService, which always agrees with `businessDateOf`, including across DST gaps. There is no calendar-date filter.

**Approved policies.** *Sales* are CLOSED orders by `orders.business_date`, from the stored totals that Phase 9 derives from price and discount snapshots. Open checks and voids are separate figures, and net sales reconcile exactly to RECORDED tenders on completed settlements. *Labor* is scheduled, not clocked: ACTIVE assignments on non-cancelled shifts in PUBLISHED (or ARCHIVED) periods, by `shift_date`. Each is costed at the HOURLY `employee_position_compensation` rate in effect on that date for the Employee and the Position worked. SALARY work and work with no rate show hours only. *Audit* viewing is not built; `audit_events` remains an open decision.

**Areas.**
- *Sales*: by order type and date; covers count once per Table Session.
- *Menu performance*: item and modifier snapshots on closed orders. Theoretical food cost is the posted cost of each item's SEND consumption ledger rows.
- *Settlements*: tenders by type with tips, cash received and change; voided and failed tenders; cancellations. Card metadata is never read.
- *Orders*: lifecycle, open-to-close time, voids by disposition and reason, discounts by snapshot, results by server.
- *Inventory*: ledger usage, waste, count variance, adjustments and transfers. The closing quantity is the ledger's `quantity_after` at period end. Also receipts by supplier and supplier cost changes.
- *Fulfillment*: per station, send-to-ready average, median and 90th percentile, ready-to-completed, late (over 20 minutes), cancellations and remakes.
- *Labor*: by position and date, plus coverage of required vs assigned.
- *Seating*: sessions, covers, duration and turns per table used; reservation statuses and no-show rate; waitlist outcomes and waits.

**Authorization.** Each report needs `reports.view` plus its area's code (`reports.sales` covers menu performance). The actor is resolved at the requested Location, so another location's figures are refused. CSV export also needs `reports.export`. Cost columns also need `inventory.cost.view`; per-employee labor cost also needs `hr.compensation.view`; labor % of sales also needs `reports.sales`. Grants are unchanged from Phase 2: Owner and General Manager hold every reports code; Manager holds all but `reports.labor` and `reports.export`; Inventory Manager holds `reports.view` and `reports.inventory`. No permission or seed was added.

**Surfaces.**
- APIs: `GET /api/reports/{area}` (JSON), `GET /api/reports/{area}/export` (RFC 4180 CSV with a header block; spreadsheet formulas neutralized), `GET /api/reports/dashboard`.
- Pages: `/reports` and `/reports/{area}`, with filters for location, dates, order type, tender type and employee.
- `/dashboard` is the operational overview. Holders of `reports.view` see one business date's headline figures per permitted area, streamed so the page never waits on them.

**Indexes.** Migration `0021` adds `kitchen_ticket_items (location_id, submitted_at)` and `table_sessions (location_id, seated_at)`, the two report filters that sequential-scanned in a 5,000-order measurement.

## 34. AWS POC Deployment Target

The POC must be deployable to AWS while keeping application code cloud-provider independent.

Initial target:

```text
Internet
   |
   v
EC2
Next.js / Node.js
   |
   v
RDS PostgreSQL
```

POC priorities:
- Keep infrastructure simple
- Use a small Free Tier/credit-eligible EC2 instance appropriate to the AWS account
- Use a small Free Tier/credit-eligible RDS PostgreSQL instance appropriate to the AWS account
- Single-AZ is acceptable for POC
- Do not introduce an Application Load Balancer solely for the POC unless required
- No ECS/EKS/Kubernetes for the initial POC
- Configure AWS Budget/cost alerts
- RDS must not be broadly exposed to the Internet
- Allow DB access only from approved sources/application security groups as practical
- Prefer encrypted database connectivity
- Use environment/secrets configuration rather than hardcoded credentials
- Run Drizzle migrations during controlled deployment
- Seed only POC data
- Configure basic backups/logging

AWS Free Tier terms change over time. Verify current Free Tier and credit eligibility at deployment time rather than assuming resources will remain permanently free.

The application must not contain AWS-specific database branches. Local Docker PostgreSQL and RDS PostgreSQL both use the same Drizzle/PostgreSQL code path.

## 35. File Storage Strategy

Employee documents and menu images are stored through a `FileStorageService` abstraction.

Local development may use a local adapter.

AWS deployment may use an S3-backed adapter later without changing the domain API.

Do not store large document/image binaries directly in PostgreSQL.

## 36. Implementation Phases

### Phase 0: Bootstrap

Deliver:
- Next.js/TypeScript/Tailwind
- ESLint
- Drizzle
- PostgreSQL driver
- Zod
- Authentication dependencies
- Unit/integration test runner
- Playwright
- Docker PostgreSQL
- Folder structure
- Environment validation

Complete when lint, typecheck, tests, and production build work.

### Phase 1: Database Foundation

Deliver:
- Shared Drizzle conventions
- Migration pipeline
- Seed framework
- Transaction utilities
- Integration test DB initialization

Complete when an empty DB can be recreated entirely from checked-in migrations.

### Phase 2: Organization + Auth + RBAC

Deliver organization/location, login/session, users, roles, permissions, permission guards, initial role seeds, and permission-aware navigation.

### Phase 3: Employees + HR

Deliver employee profiles, locations, positions, compensation history, contacts, certifications, documents, HR records, and permission boundaries.

### Phase 4: Scheduling

Deliver manual scheduling first, then automatic draft generation, coverage analysis, explanations, fill-open-shifts, manager override, and publishing.

### Phase 5: Restaurant + Seating

Deliver physical tables, table combinations, table conditions, table sessions, server sections, and seating workflows.

### Phase 6: Reservations + Waitlist

Deliver reservations, walk-ins, check-in, waitlist, table planning, seating integration, cancellations, and no-shows.

### Phase 7: Menu + Recipes

Deliver menus, categories/placements, menu items, availability, modifiers, prep routing, versioned recipe identity and immutable revisions, the unit vocabulary, and typed modifier recipe-effect contracts. Recipe ingredient rows and ingredient-adjustment persistence are delivered in Phase 8, when Inventory Items exist.

### Phase 8: Inventory + Purchasing

Deliver inventory items and location stocking, product packaging conversions, the inventory ledger and balances, suppliers and supplier items, purchasing, partial receiving, waste, adjustments, Location transfers, counts and variance, par/reorder queries, weighted-average cost, recipe-version ingredients and modifier inventory effects.

### Phase 9: Orders

Deliver draft orders, split checks (as several orders per Table Session; split payment is Phase 11), item modifiers, send batches, immutable snapshots, recipe resolution, inventory consumption, discounts, void workflow, idempotency, and concurrency.

### Phase 10: Kitchen + Bar + Realtime

Deliver prep-station queues, ticket lifecycle, cancellation/recall, hold/fire architecture, transactional outbox processing, real-time KDS, and server-ready notifications.

As built: recall is replaced by Remake and hold/fire and courses are deferred, per the approved Phase 10 policies (section 33).

### Phase 11: Settlements

Deliver historical Settlement records (at most one OPEN per Order), multiple/split Tenders within one OPEN Settlement, cash/change, safe external references, tip separation, and exact closure validation. No payment processing.

### Phase 12: Reporting + Analytics

Deliver:
- Reporting module
- Sales reporting
- Settlement reporting
- Order analytics
- Menu performance analytics
- Inventory analytics
- Fulfillment analytics
- Labor analytics
- Seating analytics
- Reporting dashboards
- CSV export
- Reporting RBAC
- Reporting APIs
- Reporting tests
- Phase 12 Completion Report

Reporting must remain read-only and derive results from:
- historical Order snapshots
- Settlement and Tender history
- Inventory ledger history
- Fulfillment history
- BusinessDateService-derived business dates

### Phase 13: Full Integration/E2E

Run a complete simulated restaurant day without manually altering the DB.

### Phase 14: AWS POC Deployment

Deliver EC2-hosted Next.js, RDS PostgreSQL, secure configuration, migrations, POC seed data, cost alerts, basic logging/backups, and connectivity validation.

### Phase 15: AWS POC Acceptance Test

Repeat the major E2E workflow against AWS from desktop, tablet, and phone-sized clients.

## 37. Copilot Phase Protocol

Before making changes, Copilot must:

1. Read this README.
2. Identify the requested phase.
3. Review relevant domain rules and existing implementation.
4. Do not implement future phases prematurely.
5. Preserve module ownership and dependency direction.
6. Create/review migrations for schema changes.
7. Put business logic in services/commands/workflows, not UI or Route Handlers.
8. Add tests for business and integration behavior.
9. Run the available lint, typecheck, unit/integration tests, and production build.
10. Fix failures introduced by the change.
11. Summarize files changed, migrations, tests, architectural issues, and remaining work.
12. Produce a Phase Completion Report when a phase is completed.

Completion reports must include:

- Summary
- Environment
- Policies
- Architectural decisions
- Migrations
- Validation results
- Tests executed
- Files changed
- Risks
- Remaining issues
- Next-phase readiness

Completion reports become part of the project's architectural record
and must be reviewed before beginning the next phase.

Copilot must not independently redesign the architecture simply to make implementation easier.

Specifically, do not:
- Replace Drizzle with Prisma.
- Replace PostgreSQL with SQLite or another DB.
- Add a separate Express API without an approved reason.
- Merge employee positions with security roles.
- Bypass server authorization.
- Put meaningful business logic into React components.
- Update inventory balances without corresponding ledger movement.
- Remove recipe versioning or historical snapshots.
- Recalculate historical data from current configuration.
- Process credit cards.
- Add sensitive card/bank columns.
- Introduce microservices or Kubernetes for the POC.
- Emit real-time events before database commit.
- Skip idempotency on critical retryable commands.

If implementation reveals a conflict with this architecture, stop at that decision point and explain the conflict before altering the architectural contract.

## 38. Canonical End-to-End Scenario

Use this scenario throughout development to validate the architectural chain.

```text
1. Manager publishes schedule.
2. Host checks in a reservation or adds a walk-in.
3. Party is placed on waitlist if necessary.
4. Host seats party and creates table session.
5. Server opens an order.
6. Server adds drinks and sends them to Bar.
7. Server adds appetizers and sends them.
8. Server adds Bacon Cheeseburger:
   - Medium
   - No Onion
   - Extra Pickles
   - Swiss instead of American
9. Server sends unsent items.
10. System snapshots price/modifiers/recipe.
11. System calculates inventory consumption once.
12. Inventory ledger and balance update atomically.
13. Kitchen/bar tickets are created atomically.
14. Realtime events are published after commit.
15. Kitchen marks items READY.
16. Server receives in-app ready notification.
17. Settlement is recorded without processing payment.
18. Order closes after settlement validation.
19. Guests leave and table session completes.
20. Table becomes DIRTY.
21. Staff marks table CLEAN.
22. Reports and audit reflect the completed operation.
```

The same idempotency key sent twice for step 9 must produce only one set of operational side effects.

## 39. Future Capabilities, Not POC Requirements

Architect for, but do not implement unless specifically requested:
- Multiple active restaurant locations
- Customer CRM/loyalty
- Delivery integrations
- DoorDash/Uber Eats integrations
- External reservation integrations
- Payment processing
- Payroll processing
- Accounting integrations
- SMS/email notifications
- Full offline synchronization
- Demand forecasting based on historical sales/reservations
- Ingredient lots/FIFO/expiration-by-lot
- Vendor EDI
- Nutritional analysis
- Separate analytics warehouse
- AI restaurant assistant

If AI is later added, it must access approved application services/tools rather than unrestricted direct database access.

## 40. Definition of POC Success

The POC is successful when:

- A restaurant user can authenticate with appropriate role permissions.
- Employees and schedules can be managed.
- A manager can generate an automatic draft schedule and modify/publish it.
- Hosts can manage reservations, waitlist, and seating.
- Servers can use a responsive phone UI to create and submit orders.
- Menu modifiers correctly change both preparation instructions and inventory consumption.
- Kitchen/bar users receive and update tickets in real time.
- Inventory movement is exact, traceable, and idempotent.
- Purchasing, receiving, counts, transfers, and waste are operational.
- Settlement can be recorded without processing payments.
- Tables correctly transition through session, dirty, and clean states.
- Audit and core operational reporting reconcile with transaction data.
- Operational dashboards provide historical reporting for Sales,
  Settlements, Orders, Inventory, Fulfillment, Labor, and Seating.
- Reporting is location-aware and business-date aware.
- CSV export is supported for reporting workflows.
- Historical analytics reconcile with immutable operational history.
- The full application runs locally with Docker PostgreSQL.
- The same application deploys as a POC to AWS on EC2 + RDS PostgreSQL without AWS-specific business code.
