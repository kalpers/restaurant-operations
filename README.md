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
waitlist_entries
party_status_history
```

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
prep_stations
```

A menu item definition may appear in multiple menus/categories using `menu_item_placements`.

A placement may define display order and optional price override.

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
recipes
recipe_ingredients
modifier_ingredient_adjustments
```

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
inventory_categories
inventory_items
units_of_measure
unit_conversions
inventory_storage_locations
inventory_purchase_units
inventory_balances
inventory_transactions
suppliers
supplier_items
supplier_item_cost_history
purchase_orders
purchase_order_items
purchase_receipts
purchase_receipt_items
inventory_counts
inventory_count_items
waste_records
```

### Inventory authority

`inventory_transactions` is authoritative. `inventory_balances` is maintained for efficient current-balance reads.

Every inventory mutation must create ledger movement and update balance in one transaction.

Quantity sign convention:

```text
positive = inventory added
negative = inventory removed
```

Transaction types may include:

```text
RECEIPT
SALE_CONSUMPTION
SALE_REVERSAL
WASTE
COUNT_ADJUSTMENT
MANUAL_ADJUSTMENT
TRANSFER_IN
TRANSFER_OUT
EMPLOYEE_MEAL
COMP
```

Inventory storage locations may include:
- Walk-in Cooler
- Freezer
- Dry Storage
- Liquor Room
- Bar
- Kitchen Line

Transfers use matching transfer-out and transfer-in records and do not change total restaurant inventory.

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

Overall order state and kitchen fulfillment state remain separate.

## 19. Domain 12: Order Settlement

Table:

```text
order_settlements
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
- Restaurant tables/high-tops/bar seats
- Prep stations
- Storage locations
- Suppliers
- Representative food and bar inventory
- Menu categories
- Burger and other sample menu items
- Recipes and modifiers
- Staffing templates

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

Requirements: Node.js 20.9 or newer, npm, and Docker Compose.

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

Employee creation records an initial `ACTIVE` status-history entry and an effective-dated primary location, with an optional independent initial position. Location and position changes require an expected employee version and preserve ended assignments. Employee termination preserves all HR history, ends active location/position eligibility, and disables a linked User in the same PostgreSQL transaction. Terminated employees are not physically deleted.

Compensation is keyed by Employee + Position and uses effective-dated `NUMERIC(12,2)` values read and written as decimal strings. A change closes the prior period for that Employee + Position and creates a new row transactionally; overlapping periods for the same Employee + Position and mixed HOURLY/SALARY fields are rejected. Phase 3 does not perform payroll.

HR queries are purpose-specific: `employees.view` receives general employment data only. Personal addresses/emergency contacts, compensation, certifications, notes, performance reviews, disciplinary actions, and documents require their corresponding `hr.*` permissions. Manager/performance note types and explicitly sensitive notes require the separate `hr.notes.sensitive.*` permissions. APIs independently enforce these boundaries.

Employee document binaries are stored outside PostgreSQL and outside `public/`, under the ignored local `EMPLOYEE_DOCUMENT_STORAGE_PATH` (default `.local/hr-files`). `EMPLOYEE_DOCUMENT_MAX_BYTES` defaults to 10 MiB (maximum 50 MiB). The local adapter accepts PDF, PNG, JPEG, and UTF-8 plain text with signature/content checks, generated UUID keys, and private file/directory modes. Download passes through an authorized Route Handler; no public file URL or deletion endpoint is provided. A failed metadata insert triggers best-effort removal of the just-written file. S3 remains deferred.

The idempotent Phase 3 seed adds the eight configurable restaurant positions and generic FOOD_SAFETY/ALCOHOL_SERVICE certification types; it creates no employee records. `npm run db:seed` upgrades role grants through a versioned seed key. The migration chain contains a follow-up constraint-name migration to replace PostgreSQL's truncated autogenerated performance-review FK names.

### Phase 4 Scheduling

Schedule periods are location-scoped and use the lifecycle `DRAFT -> PUBLISHED -> ARCHIVED`. Only drafts are directly editable. Every schedule mutation compares the expected period version; shift edits also compare the shift version. Publish and archive are explicit manager operations. Publishing revalidates every active assignment and rejects overlapping published periods. Published assignments are changed only through the explicit accepted shift-swap workflow; generated schedules are never automatically published.

Shifts store real instants as `TIMESTAMPTZ`, constructed from the shift date and wall-clock times in the location timezone. Overnight shifts are supported; nonexistent local times during a daylight-saving jump are rejected. A shift's `shift_date` is the location-local date of its start.

Scheduling qualification uses only an ACTIVE Employee, effective employee-location eligibility, the effective Employee Position required by the shift, availability, approved time off, overlap checks, and configured hard limits. Security Roles only authorize software actions and never qualify an Employee to work a Position. Compensation and restricted HR records are not read by eligibility, coverage, or scoring.

**Availability policy:** a shift requires applicable `AVAILABLE` records covering every minute of the entire shift. Missing data returns `AVAILABILITY_NOT_CONFIGURED` and is ineligible; explicit unavailable intervals and configured availability that does not cover the full shift have distinct results. Date exceptions take precedence over recurring windows for the intervals they cover; recurring availability must cover the remaining shift. This same evaluator is used by manual assignment, generation, Fill Open Shifts, and swap acceptance/approval. There is no manager override; employees or authorized managers must correct/configure the data first.

Approved time off is a hard conflict; approval is blocked while conflicting assignments remain. Pending time off is not a hard constraint: it creates a deterministic score penalty and a manager warning. Employee self-service resolves the optional User-to-Employee link on the server and supports availability/preferences, time off, published shifts, and shift-swap requests. It never accepts an arbitrary Employee ID as the self-service identity.

Staffing templates create staffing requirements, not employee assignments. Applying a template to a draft creates each requirement/date shift at most once and does not overwrite existing manager work. Manager scheduling rules make hard limits explicit; maximum days/week, consecutive days, and minimum rest can be configured as hard limits, while soft preferences influence scores and warnings only.

Automatic generation uses the shared eligibility service and deterministic scoring. Initial score adjustments are: below target hours `+20`, at/above target `-10`, crossing the overtime-avoidance threshold `-50`, preferred-time match `+12`/mismatch `-6`, weekend/closing fairness `+8` per shift, short-rest preference `-18`, pending time-off overlap `-24`, exceeding a soft weekly-day preference `-12` per day, and exceeding a soft consecutive-day preference `-15` per day. Ties use employee number then UUID. Generated assignments retain hard-check and score reasons; unfilled slots include structured eligibility codes/reasons. Generation runs snapshot rules/weights and use schedule-version revalidation before an atomic write. `GENERATE_DRAFT` requires an unassigned draft; `FILL_OPEN_SHIFTS` preserves existing assignments and fills only remaining slots.

Scheduling permissions are separate for viewing/editing/generating/publishing, availability/preference management, time-off requests/approval, swaps, templates, and rules. `npm run db:seed` registers default scheduling rules for scheduling-enabled locations; it does not create fake employee or staffing demand records. See `docs/Phase-4-Completion-Report.md` for the implementation and validation checklist.

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

Deliver menus, categories/placements, menu items, availability, modifiers, prep routing, versioned recipes, and ingredient-adjustment logic.

### Phase 8: Inventory + Purchasing

Deliver inventory ledger/balances, units, storage locations, suppliers, purchasing, partial receiving, waste, transfers, counts, variance, and weighted-average cost.

### Phase 9: Orders

Deliver draft orders, split checks, item modifiers, send batches, immutable snapshots, recipe resolution, inventory consumption, discounts, void workflow, idempotency, and concurrency.

### Phase 10: Kitchen + Bar + Realtime

Deliver prep-station queues, ticket lifecycle, cancellation/recall, hold/fire architecture, transactional outbox processing, real-time KDS, and server-ready notifications.

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
