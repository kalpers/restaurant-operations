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

As built in Phase 16, sign-in and password lifecycle are hardened:

- **Throttling and lockout.**
  - *Storage:* failures are counted in PostgreSQL (`login_throttles`), never in memory or Redis. Keys are HMAC-SHA256 of the normalized email and, only when `AUTH_CLIENT_IP_HEADER` names a trusted proxy's header, of the client IP. The typed email and IP are never stored.
  - *Limits:* `AUTH_LOCKOUT_THRESHOLD` (5) failures within `AUTH_LOCKOUT_WINDOW_MINUTES` (15) lock the key for `AUTH_LOCKOUT_DURATION_MINUTES` (15). Unknown emails are counted the same way, so a lock reveals nothing.
  - *Counting:* each failure is one atomic upsert. A success deletes the account key's row in the login transaction.
  - *Outcome while locked:* the same `null` and "Invalid email or password", after the same dummy Argon2 verification. The password is not checked.
  - *Audit:* a known account's lock records `auth.account-locked`, deferred like `auth.sign-in-failed`.
  - *Unlock:* a holder of `admin.users.manage` can unlock from the Users page, under the no-escalation rule (`auth.account-unlocked`).
- **Password change.** Any signed-in user can change their own password at `/account/password` (`POST /api/account/password`, linked from the header).
  - *Rules:* the current password is required, a wrong one counts toward the lockout, and the new one must meet the length rules and differ.
  - *Effects:* the hash is replaced, `password_changed_at` set, `must_change_password` cleared and `version` bumped, with `auth.password-changed`, in one transaction.
- **Administrator reset.** `POST /api/admin/users/{id}/password-reset` requires `admin.users.manage`, the no-escalation rule and the user's `version`, and refuses the actor's own account.
  - *Temporary password:* the server returns a random 16-character password once. It is never logged, audited or stored except as a hash.
  - *Effects:* it sets `must_change_password` and `password_changed_at`, clears any lockout, and records `admin.user-password-reset`.
- **Forced change.** While `must_change_password` is set, every page guard redirects to `/account/password` and every API guard returns 403 `PASSWORD_CHANGE_REQUIRED`. The only exceptions are the change page and endpoint and next-auth's own session and sign-out endpoints.
- **Sessions end on a change.**
  - *The claim:* the JWT carries `authTime`, the sign-in instant, set at sign-in and carried unchanged on refresh.
  - *The check:* resolving the auth context rejects a session whose `authTime` is earlier than `password_changed_at`, like a disabled user's. Tokens from before Phase 16 have no `authTime`, so they are valid until the user's first change.
  - *The changer:* after a self-service change, the server sets a fresh session cookie.
- **No email, reset links or MFA.** Recovery is an administrator's reset, or `bootstrap:owner` for the last Owner.

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

A read-only day timeline (Gantt) shows the schedule by employee or by position; see "Phase 14 Schedule Timeline" in section 33.

### Time clock (Phase 18)

Tables:

```text
time_entries
time_entry_breaks
time_entry_adjustments
```

A time entry is one stretch of work in one Position, on the business date of its clock-in. Employees punch on their own login (`/my-time`, `timeclock.punch`); a manager (`timeclock.manage`) can punch for anyone eligible, including staff with no login. There is no PIN or kiosk mode. A clock-in is matched to the employee's published shift for that Position starting within 60 minutes either way; otherwise it is unscheduled, which is allowed and flagged. Effective times can be corrected later with a reason, but the original punch instants never change, and every correction is kept in `time_entry_adjustments`. A forgotten clock-out stays OPEN and counts no hours until a manager closes it. Weekly overtime uses `scheduling_rules.weekly_overtime_threshold`, `week_start_day` and `overtime_multiplier`; it only warns, never blocks. Since Phase 20 an optional `daily_overtime_threshold` counts each business date's hours past it first, and weekly overtime counts only the rest; managers edit breaks on the time clock. See "Phase 18 Labor and Tips" and "Phase 20" in section 33.

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
guest_profiles
guest_profile_number_counters
guest_profile_allergies
guest_profile_merges
guest_party_allergies
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

Phase 21 adds guest profiles, owned by this domain: a guest known across visits, organization-wide, with optional phone and email (normalized for lookup, not unique), a VIP flag, preferences, notes and allergies. A Guest Party links to a profile by hand (`guest_parties.guest_profile_id`); suggestions match phone, email or name, but nothing links itself. Linking copies the profile's allergies onto the visit (`guest_party_allergies`, source `PROFILE`); staff may add allergies for the visit only (`RECORDED`). Duplicates are merged by a manager (the duplicate becomes `MERGED`, never undone, with a `guest_profile_merges` row). Erasing a profile clears its personal data, that of profiles merged into it and the contact details of its visits, and keeps orders and history. Visit history is worked out on read from linked parties and order snapshots. Contact details need `guests.contact.view`; audit rows name fields and allergen codes only. Loyalty and marketing consent are not built. See section 33.

Phase 22 adds online booking and guest messaging to this domain. A location may take bookings on a public, signed-out page (`/book/{location code}`): off until a manager turns it on, times offered from booking hours (`online_booking_periods`) every 15, 30 or 60 minutes, limited by lead time, a booking window, a party size limit and pacing (covers starting per slot), checked again under a location lock when the booking is made. Online bookings are `source = 'ONLINE'` with no creating user (a `GUEST` actor in audit), `CONFIRMED` or, when the location requires approval, `PENDING`; tables are still planned by the host, and a booking is never linked to a profile automatically. Guests view or cancel through a private link whose token is stored only as a SHA-256 hash (`reservation_manage_links`). Service messages (confirmed, received, changed, cancelled, reminder, table ready) go by email or SMS only with the visit's consent per channel (`guest_party_message_consents`) and never to an address on the opt-out list (`message_suppressions`, a keyed hash). Erase also clears consents, message addresses and bodies, and manage links. See sections 22 and 33.

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

Phase 19 adds per-location sellability next to `available`, which stays organization-wide:
- `menu_item_outages`: a manual 86 of one item at one location, with a reason, until restored.
- Auto-86 (opt-in per location, `location_settings.auto_86_from_stock`): an item whose current recipe can't cover one more portion from on-hand stock isn't sellable there. Portions remaining are worked out on every read and never stored.
- `menu_item_stock_overrides`: "sell anyway" for one business date, lifting auto-86 only.

An item is sellable at a location when it is active, available, not 86'd there, and not auto-86'd without an override. `getOperationalMenu` applies this, so draft add and SEND share one check.

Phase 20 adds `modifier_outages` (a modifier 86'd at one location, left out of the operational menu; an item whose required group then has too few choices isn't sellable), a window on every 86 (`starts_at`, optional `ends_at`, in effect only inside it), and `location_settings.running_low_portions`. SEND snapshots the menu category each item was sold under. See section 33.

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
allergens
inventory_item_allergens
ingredient_allergen_reviews
menu_item_allergens
menu_item_allergen_reviews
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

Phase 21 adds allergen labels. Ingredients are tagged with what they contain from the organization's allergen list (seeded with the nine major US allergens), and each ingredient's tags carry a review mark. A menu item's label is worked out on read from the ingredients left after its current recipe and the chosen modifiers, plus allergens the item declares by hand (`CONTAINS`, or `MAY_CONTAIN` for cross-contact). A label is incomplete while any ingredient is unreviewed, or, for an item with no ingredients, until its declarations are reviewed; an incomplete label is never shown as allergen free. SEND snapshots the label. See section 33.

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

Phase 19 adds `inventory_stock_alerts`: the posting service opens one when a posting takes stock from above the reorder level to at or below it, and resolves it when stock rises above again, in the same transaction, with in-app `INVENTORY_LOW` notifications to `purchasing.manage` holders at the location. A stocked item may name a preferred supplier item (`inventory_item_locations.preferred_supplier_item_id`), from which suggested purchase orders are built as DRAFTs, never submitted.

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

Table session to orders is one-to-many to support split checks. Since Phase 17, draft and sent items can move between OPEN orders on one session (or into a new check there); each move is recorded in `order_item_transfers`, and an item's snapshots, consumption and kitchen work move with it. Since Phase 20 one sent item can be shared between checks on its session: it becomes `SPLIT` and its `order_item_shares` carry the money, while its kitchen work and consumption stay with it. Items carry a course number (1 to 5); see section 18 for hold and fire.

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
- Allergen label (Phase 21: `order_item_allergens`, and whether it was incomplete)

Never recalculate historical consumption from the current recipe.

Phase 21: an item whose label matches the order's recorded allergies (the guest party's, or the check's own `order_allergies` for takeout and bar tabs), or whose label is incomplete while the order has any allergy, is refused at SEND with `ALLERGEN_ACKNOWLEDGMENT_REQUIRED` until the request names it as acknowledged. The refusal writes nothing, so the confirmed retry may reuse its idempotency key. The acknowledgment (who, when, what) is frozen on the item and its kitchen ticket shows an allergy alert.

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

As built in Phase 10, the approved Phase 10 policies replace recall with an explicit Remake (a new linked attempt). Phase 17 added courses and hold/fire without a new item state: a ticket holds one course of one send batch, and SEND can hold the courses above the round's lowest. A held ticket's items stay `NEW`, off the station queues, until its course is fired; inventory was already consumed at SEND. See section 33.

Overall order state and kitchen fulfillment state remain separate.

Phase 21: a ticket item sent after an allergy acknowledgment carries `allergy_alert_snapshot` ("ALLERGY: Peanuts (severe)"), shown at the top of the item; a remake keeps it.

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

Settlement reconciles against the Order's amount due: since Phase 17, `orders.total_due`, the post-discount subtotal plus tax. Tax comes only from the Tax Category explicitly assigned to a Menu Item and the rate in force at the location, snapshotted at SEND; taxability is never inferred from the item, location, Order type, or food/alcohol category. A location with tax switched off charges none. Since Phase 20 a rate may be included in the menu price (taken out of the subtotal, so total due is still subtotal plus tax), and a check can be tax exempt. Tips are separate from the Order obligation and may be recorded only for CASH and EXTERNAL_CARD. Cash change is calculated after the Order amount applied and cash tip; no cash rounding is performed.

Support:
- Multiple historical settlements per order, with at most one OPEN settlement
- Multiple tenders within one OPEN settlement for partial/split tender
- Cash tendered/change
- External safe transaction/reference ID
- Tender idempotency and exact reconciliation
- Zero-amount Settlement closure for a fully comped Order, without a fake $0 tender
- Cash drawers (Phase 17): sessions with a float, paid-in/out and a count at close; cash tenders and cash refunds go into an OPEN session where the location requires it
- Refund records on CLOSED orders (Phase 17), record only
- Tip pools (Phase 18), record only: one pool per location and business date (`tip_pool_rules`, `tip_pool_rule_positions`, `tip_distributions`, `tip_distribution_lines`), shared by worked hours × position points and finalized as an immutable snapshot

Do not represent one Order obligation as multiple partially completed Settlements. A fully reconciled Settlement closes the Order atomically; a CLOSED Order is terminal. Money returned afterwards is a separate refund record (Phase 17): the Order, its Settlement and tenders never change, nothing reopens a check, and a refund counts on the business date it is recorded. Since Phase 20 a refund may return a tip, which leaves that business date's tip pool. Settlement completion does not change Inventory, fulfillment, or Table Session status. Table Sessions still complete only through the explicit physical departure workflow after associated Orders are CLOSED.

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

Never include passwords, password hashes, session tokens, secrets, prohibited payment information, or unnecessary sensitive HR data. Phase 21 adds the `GUESTS` category: guest audit rows name changed fields and allergen codes, never contact details, notes, preferences or allergy notes.

Phase 22 adds the `MESSAGING` category (consent, resends, opt-outs, online booking settings, online bookings and guest cancellations) and a third actor type, `GUEST`: a guest acting on the public booking page, with no user. Messaging audit rows name channels, kinds and reasons, never an address, a message body, a manage or unsubscribe token, or provider credentials.

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

Phase 19 adds, inside the existing areas and permissions: sales by hour (Sales), item mix and menu engineering (Menu), server performance and voids, comps and discounts by employee (Orders), and 86 history (Inventory). Phase 20 adds a sales-by-hour chart, item mix and menu engineering by category, tax included in prices and tax-exempt checks (Sales), tip refunds and declared cash tips (Tips), and daily overtime in actual labor. See section 33.

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
- Labor reporting uses the effective compensation of the Employee for the Position worked: scheduled labor on the shift date, and (since Phase 18) actual labor on each time entry's business date.
- Tip reporting (Phase 18) uses tender tips of CLOSED orders and finalized distribution snapshots.
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

Phase 21: the seating report counts seated parties linked to a guest profile and returning guests. Reports never show or export guest names or contact details.

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

Staff notifications stay in-app only: no SMS, email or push to staff.

Phase 22 intentionally adds email and SMS **to guests**, for service messages only (no marketing). The design:

- **Port and adapters** (`src/infrastructure/messaging/`). `MessageSender` sends one message and returns a result, never throwing and never logging an address or body. Adapters: `capture` (writes JSON files under `MESSAGING_CAPTURE_PATH`, sends nothing; the default in development and tests, refused in production unless `MESSAGING_ALLOW_CAPTURE_IN_PRODUCTION=true`, which only the Playwright config sets), `smtp` (nodemailer, any SMTP service; see `docs/accepted-risks.md` DEV-004) and `twilio` (Twilio's REST API over fetch). Either channel can be `off`. Settings are parsed in `src/config/` and checked when messaging starts.
- **Message outbox.** The change a message reports writes a `guest_messages` row in its own transaction (kind, channel, recipient address, rendered subject and body, a unique dedupe key per trigger). The dispatcher (`startMessageDispatcher`, from `src/instrumentation.ts`) claims due rows with `SKIP LOCKED`, sends with no transaction open, and records `SENT`, a retry (5 s doubling to 15 min), `FAILED` after `MESSAGE_MAX_ATTEMPTS`, or `SUPPRESSED` for a provider opt-out. `outbox_events` isn't used for messages: its payloads stay free of contact data.
- **Consent and opt-out.** Nothing is queued without the visit's consent for the channel; nothing is sent to an address on the opt-out list (an HMAC of channel and address with `MESSAGING_SUPPRESSION_KEY`, never rotated). Emails carry a one-click unsubscribe link; texts say "Reply STOP", which Twilio enforces and reports.
- **Retention.** The hourly maintenance run queues due reminders (09:00 to 21:00 local only) and clears the address and body of finished messages older than `MESSAGE_RETENTION_DAYS` (90).

As built in Phase 10, `notifications` holds `FOOD_READY` and `BAR_ORDER_READY` (see section 33). Phase 19 adds `INVENTORY_LOW`, linked to its low-stock alert. Phase 20 adds the other example kinds and `TIME_OFF_DENIED`, `OVERTIME_APPROACHING` and `MISSED_CLOCK_OUT`: the schedule and time-off kinds are written with the change they report, and the time-based kinds by the hourly maintenance run, once per dedupe key and recipient.

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

As built in Phase 10, `outbox_events` rows are written inside the transaction that makes the change (SEND, item transitions, voids, Remakes, notifications), carry identifiers only, and are append-only except for their publishing state. One processor per Node.js process, started from `src/instrumentation.ts` (`OUTBOX_POLL_INTERVAL_MS`, default 1000, 0 turns it off), claims unpublished rows in sequence with `FOR UPDATE SKIP LOCKED`, hands them to the in-process realtime adapter, and marks them published; a publisher failure records the attempt and retries. The adapter fans events out to authenticated Server-Sent Events connections (`/api/realtime/stream`), filtered by organization, location and, for notifications, recipient. An event only means "refetch": screens read through their normal authorized queries and fall back to a slow refresh, with a Live/Reconnecting indicator. This fits the single-instance POC; several app instances would each need a feed (for example LISTEN/NOTIFY).

As built in Phase 16:

- **Backoff.** A failed publish sets `next_attempt_at` to now + 1 s × 2^(attempts−1), capped at 5 minutes. The processor claims only rows that are unpublished, not dead-lettered, and due.
- **Dead letter.** At `OUTBOX_MAX_ATTEMPTS` (10) attempts, `failed_at` is set and the row is never claimed again automatically. It is logged once at `error`, with identifiers only. Events only mean "refetch", so a backed-off or dead-lettered event never blocks later ones.
- **System health.** **Admin → System health** (`/admin/system`, `GET /api/admin/system/health`, `admin.system.view`) shows the unpublished count, the oldest unpublished age, the dead-lettered count and the 50 most recent dead-lettered events: type, aggregate, attempts, last error name and times, never payloads.
  - *Retry* (`admin.system.manage`) clears `failed_at` and `next_attempt_at`, resets `attempts`, and records `system.outbox-event-retried` (category `SYSTEM`).
  - *Grants:* both permissions go to Owner and General Manager.
- **Retention.** `runMaintenance` (`src/infrastructure/maintenance/`) deletes published outbox events older than `OUTBOX_RETENTION_DAYS` (7), and sign-in throttle rows whose window and lock have both expired.
  - *How it runs:* in batches of 1,000, under a `pg_try_advisory_lock`, so only one runner works at a time. It runs from `npm run maintenance` (counts only) and from an in-process timer started in `src/instrumentation.ts` (`MAINTENANCE_INTERVAL_MS`, default one hour, 0 turns it off). A failure is logged and never stops the server.
  - *The guard:* the outbox guard trigger allows deleting only published, non-dead-lettered rows.
  - *Never purged:* unpublished and dead-lettered events, `idempotency_records` (send batches, Remakes and tenders reference them), audit events, ledgers, snapshots and all other history.

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

**UI rules (Phase 15).** Light theme only.
- *Tokens:* colors, the font and focus rings are defined once in `src/app/globals.css`. Use the token names (`brand`, `success`, `warning`, `danger`, `info`) rather than raw palette colors.
- *Primitives:* build screens from `src/components/ui/` (Button, Field/Input/Select, Card, Badge, Table, Dialog, ConfirmDialog, Toast, EmptyState, Skeleton, Breadcrumbs). Don't copy class strings between files.
- *Statuses:* show them through `StatusBadge` with the labels in `src/components/format/status-labels.ts`. Never show raw enum values, and never convey a status by color alone.
- *Money:* display it with `formatMoney` from `src/components/format/money.ts`, which only rearranges the decimal string.
- *Confirmation:* every action that cancels, removes, deactivates, disables, archives, voids or publishes asks first, through `ActionButton`'s `confirm` or a Dialog.
- *Feedback:* success shows a toast. Errors stay beside the control and show the request ID, and a version conflict offers Reload.

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

Emails are normalized using Unicode NFKC normalization, trimming, and lowercase before lookup or uniqueness checks. Authentication failures use the same `Invalid email or password` message for unknown, disabled, and incorrect-password accounts. There is no public registration route. Phase 22 adds the first public, signed-out business endpoints, for online booking only (`/api/public/...` and the `/book` and `/messages/unsubscribe` pages): they act as a `GUEST` with no permissions at one location, return nothing about staff, tables or other guests, and are throttled per contact and, behind the trusted proxy header, per IP (`public_throttles`).

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

**Active versus available.** `active` keeps an item in the catalog and its history. `available` says it can be sold now. The operational menu returns an item only when the menu is active and offered at the location (and inside an availability window, if it has any), the category, placement and item are active, the item is available, and a price is in effect. Nothing infers availability from stock or recipes, except where a location turns on Phase 19 auto-86.

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

**Suppliers and purchasing.** `supplier_items` says how a supplier sells an item: a purchase unit and `base_units_per_purchase`, computed from the item's conversions when saved and refused if the unit can't convert. As built in Phase 8 there was no preferred-supplier field and nothing chose a supplier: an order names one explicitly, and low-stock results list every active supplier option. Phase 19 (owner decision D8) adds an optional preferred supplier item per stocked item and location, used only to build suggested DRAFT orders. Listed costs and every receipt price are appended to `supplier_item_cost_history`. Purchase orders are numbered per Location (`PO-000001`) and move `DRAFT -> SUBMITTED -> PARTIALLY_RECEIVED -> RECEIVED`, or to `CANCELLED` from any but `RECEIVED`. Only drafts are edited. Lines snapshot the supplier item, unit, conversion and price; the order total is the exact sum of line totals; no tax or freight. Submitting moves no stock.

**Receiving** locks the order, refuses over-receiving per line (no override), and in one transaction writes the receipt and its lines, posts a `RECEIVE` per line through the posting service at the actual cost, appends cost history, and sets the order status. The ordered price is never rewritten; the actual price lives on the receipt line. Any refused line rolls back the whole receipt. A cancelled order can't receive; stock already received stays.

**Waste and adjustments.** Waste posts `WASTE` with a structured reason (`SPOILAGE`, `BREAKAGE`, `PREP_WASTE`, `EXPIRED`, `OTHER`). Adjustments post `ADJUST_INCREASE` or `ADJUST_DECREASE` with a reason (`RECEIVING_CORRECTION`, `FOUND_STOCK`, `THEFT_OR_LOSS`, `DATA_CORRECTION`, `OTHER`); a check constraint requires the reason. There is no "set quantity" field anywhere.

**Transfers** post `TRANSFER_OUT` and `TRANSFER_IN` with a shared reference in one transaction, locking both balances in a stable order. The actor needs `inventory.transfer` at both Locations (the destination is re-checked against the database); both must stock the item; a transfer can't create negative stock.

**Counts.** `DRAFT -> SUBMITTED -> APPROVED`, with `SUBMITTED -> DRAFT` to correct and `CANCELLED` from either. Starting a count snapshots each line's expected quantity and the item's latest ledger sequence together under the balance lock. Stock stays live while a count is open. Variance is counted minus expected. Approval locks the balances, so no posting can slip in, and if any ledger row has a higher sequence than a line's snapshot it requires an explicit acknowledgement, recording the actor and time. It then posts each non-zero variance as `COUNT_INCREASE` or `COUNT_DECREASE` against current stock (never setting stock to the count) and approves, atomically. A decrease that would take current stock below zero refuses the whole approval.

**Replenishment** is a recommendation: an item is low when QOH is at or below its reorder level, and the suggestion is reorder target (else par) minus QOH, never below zero. Negative QOH is shown as it is. Nothing submits an order; since Phase 19 a manager can turn the shortfall into DRAFT orders.

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

**Approved policies.** *Sales* are CLOSED orders by `orders.business_date`, from the stored totals that Phase 9 derives from price and discount snapshots. Open checks and voids are separate figures, and net sales plus tax reconcile exactly to RECORDED tenders on completed settlements (before Phase 17, tax was always zero). *Labor* is scheduled, not clocked: ACTIVE assignments on non-cancelled shifts in PUBLISHED (or ARCHIVED) periods, by `shift_date`. Each is costed at the HOURLY `employee_position_compensation` rate in effect on that date for the Employee and the Position worked. SALARY work and work with no rate show hours only. *Audit* viewing was not built in Phase 12; see Audit Domain below.

**Areas.**
- *Sales*: by order type and date; covers count once per Table Session.
- *Menu performance*: item and modifier snapshots on closed orders. Theoretical food cost is the posted cost of each item's SEND consumption ledger rows.
- *Settlements*: tenders by type with tips, cash received and change; voided and failed tenders; cancellations. Card metadata is never read.
- *Orders*: lifecycle, open-to-close time, voids by disposition and reason, discounts by snapshot, results by server.
- *Inventory*: ledger usage, waste, count variance, adjustments and transfers. The closing quantity is the ledger's `quantity_after` at period end. Also receipts by supplier and supplier cost changes.
- *Fulfillment*: per station, send-to-ready average, median and 90th percentile, ready-to-completed, late (over 20 minutes), cancellations and remakes.
- *Labor*: by position and date, plus coverage of required vs assigned.
- *Seating*: sessions, covers, duration and turns per table used; reservation statuses and no-show rate; waitlist outcomes and waits.

**Authorization.** Each report needs `reports.view` plus its area's code (`reports.sales` covers menu performance). The actor is resolved at the requested Location, so another location's figures are refused. CSV export also needs `reports.export`. Cost columns also need `inventory.cost.view`; every labor cost figure (totals, by position, by date, per employee, and the dashboard tile) also needs `hr.compensation.view`, because a position or day with one person scheduled reveals their rate as cost ÷ hours; without it labor shows hours only. Labor % of sales needs both `hr.compensation.view` and `reports.sales`. Grants are unchanged from Phase 2: Owner and General Manager hold every reports code; Manager holds all but `reports.labor` and `reports.export`; Inventory Manager holds `reports.view` and `reports.inventory`. No permission or seed was added.

**Surfaces.**
- APIs: `GET /api/reports/{area}` (JSON), `GET /api/reports/{area}/export` (RFC 4180 CSV with a header block; spreadsheet formulas neutralized), `GET /api/reports/dashboard`.
- Pages: `/reports` and `/reports/{area}`, with filters for location, dates, order type, tender type and employee.
- `/dashboard` is the operational overview. Holders of `reports.view` see one business date's headline figures per permitted area, streamed so the page never waits on them.

**Indexes.** Migration `0021` adds `kitchen_ticket_items (location_id, submitted_at)` and `table_sessions (location_id, seated_at)`, the two report filters that sequential-scanned in a 5,000-order measurement.

### Audit Domain

Built as its own step between Phase 12 and Phase 13 (owner decision, 2026-11-09), closing the question open since Phase 3. Report: `docs/Audit-Domain-Completion-Report.md`.

**Table.** `audit_events` (migrations `0022`, `0023`) holds organization, location (null for organization-level events), actor type (`USER` or `SYSTEM`), acting user, the employee linked to that user at the time, action (`domain.action-name`), category, entity type and ID, time, request ID, and optional `before`, `after` and `details` JSONB. It is append-only: a trigger refuses UPDATE, DELETE and TRUNCATE. Domain histories (ledger, status histories, price and compensation history) stay separate and remain the source of truth for values.

**Written with the action.** `recordAudit` in `src/modules/auditing/` takes the caller's transaction, so an event exists only if its action committed. SEND writes one event inside its idempotent block, so a replay writes none. The request ID comes from request context set by `apiRoute`; pages, Auth.js callbacks and CLI scripts record none.

**Allow-listed fields.** `src/modules/auditing/audit-actions.ts` lists every audited action with the only fields it may keep; anything else is dropped, and nested objects are never stored. A unit test refuses any listed field named like a password, hash, token, secret, card, CVV, PIN, account, routing number, SSN, birth date, address, phone, email, rate, wage or salary. Wage changes record only that the rate changed (`rate: true`), never an amount. Personal and restricted HR changes record changed field names only, never values. Free-text HR reasons and inventory notes are not copied. Tender card, provider and authorization details are not copied.

**What is recorded.**
- *Access*: sign-in success, and failure with reason `BAD_PASSWORD` or `DISABLED` for a known account (an unknown email writes nothing; the typed email is never stored). A failure's event is written after the sign-in response is sent (Next.js `after`), so a wrong password on a real account answers in the same time as an unknown email; sign-out (best effort, after the session ends).
- *Security*: owner bootstrap (SYSTEM), role create, activate and deactivate, permission changes (added and removed codes), user create, enable and disable (including by termination), role assignment and removal.
- *HR*: employee create and edit, status changes, termination, position and location assignments, compensation changes, personal data, notes, reviews, disciplinary records, documents and certifications. Reads of personal data, compensation, sensitive notes, reviews and disciplinary records, and document downloads, are recorded in the same transaction as the read: if the event can't be written, no data is returned.
- *Scheduling*: publish, archive, swap accepted, approved and denied.
- *Orders*: SEND, item and order voids, discounts and comps applied and removed.
- *Menu*: price changes, item create and update, recipe revisions created, published and retired.
- *Inventory*: adjustments, waste, transfers, count approvals, purchase-order receipts.
- *Settlements*: opened, tender recorded and voided, completed, cancelled.
- *Reporting*: CSV exports (area, range, row count), written in a short transaction after the READ ONLY report; if it can't be written, the export is refused.

Not recorded: viewing the audit trail, ordinary reads, draft order edits and kitchen status changes (which have their own history).

**Viewing.** `GET /api/audit` and the `/audit` page need `audit.view` (Owner and General Manager). They show the current location's events plus organization-level ones, newest first, filtered by business-date range (at most 92 days), category, action, actor and entity, 100 per page with a cursor. There is no export of the audit trail. No permission or seed was added.

### Phase 13 Validation

Phase 13 added no domain, table, permission or migration. It validates Phases 1–12 and the Audit Domain together. Report: `docs/Phase-13-Completion-Report.md`.

**The simulated day.** `tests/fixtures/restaurant-day.ts` runs README section 38 as one connected day through services and workflows only. The steps:

- a manager publishes the schedule;
- a reservation is confirmed, checked in and seated, and a walk-in is seated from the waitlist;
- drinks go to the Bar, an appetizer is sent, and the canonical Bacon Cheeseburger is sent;
- kitchen and bar run their tickets and the server is notified;
- the checks settle by cash and external card;
- sessions complete, tables go DIRTY and then CLEAN;
- a late check settles at 00:30, before the cutoff.

Only identity scaffolding (organization, location, areas, positions, role-holding actors) comes from fixtures, because no service creates an organization. No step writes an operational row directly. `tests/integration/validation/` checks the day against:

- its snapshots, ledger and balances;
- the reports in every area, which must reconcile exactly;
- the audit trail.

It also checks that changing the price, the recipe, a modifier effect and a wage afterwards changes neither the day's stored history nor its reports.

**Clock.** Scheduling refuses past shifts, so the day runs on a faked `Date`: Vitest `useFakeTimers({ toFake: ["Date"] })`, with timers left real. Every business timestamp the services write comes from `new Date()`; PostgreSQL `now()` is only a column default. The business-date tests use the same clock to run complete sales at the following instants, and check that every domain, report and audit filter places each one on the same business date:

- one second before the cutoff;
- exactly at the cutoff;
- one second after the cutoff;
- both 1:30 AMs of a fall-back night.

**Playwright.** `tests/e2e/restaurant-day.spec.ts` runs the same day on screen, with one browser per role: publish, reservation, seating, three sends, bar and kitchen, notifications, a split settlement, dirty and clean, reports with CSV export, and audit. Its setup uses services, and its cleanup only disables its accounts, which takes no table lock.

**Opt-in validation data.** `npm run db:seed:validation` (`scripts/seed-validation.ts`) loads the fixture in `docs/Phase-13-Validation-Seed-Data.md` into a local development database only (loopback `DATABASE_URL`, non-production `NODE_ENV`), acting as the bootstrapped Owner through the services. It is not in the default seed list, so it never reaches a shared or cloud database. It records `phase13.validation-fixtures` in `seed_runs` when done; a rerun changes nothing.

**Fix.** The settlements report's all-tenders row showed a blank amount on a day with no tenders; it now shows `0.00`, so it reconciles exactly with net sales.

### Phase 14 Schedule Timeline

Phase 14 added a read-only Gantt view of one day's schedule at the current Location. It added no table, column, permission, migration or dependency. Plan: `docs/Phase-14-Schedule-Timeline.md`. Report: `docs/Phase-14-Completion-Report.md`.

**Where.** The `/scheduling/timeline` page and `GET /api/scheduling/timeline?date=YYYY-MM-DD&includeDrafts=true|false` both call `getDayTimeline` in `src/modules/scheduling/services/timeline-service.ts`. Layout rules are pure functions in `rules/timeline-layout.ts`, and the reads are in `repositories/timeline-repository.ts`. Both page and API need `schedule.view`. The API answers `Cache-Control: private, no-store`.

**The day.** A day is every uncancelled shift whose `shift_date` is that date. That's the local date the shift starts, the same worked day Phase 4 uses, not a business date. A shift past midnight shows in full on its start day, marked "ends next day", and isn't repeated the next day. The axis runs in the location's time zone from the hour at or before the earliest start to the hour at or after the latest end, never narrower than 06:00 to midnight. It's built from real instants, so a daylight-saving day has 23 or 25 hours.

**What appears.**
- *Assignments and open slots:* only `ACTIVE` assignments appear, so after a swap the bar shows the new holder. Each unfilled place is a hatched **Open** bar.
- *Groupings:* By employee, with an Open shifts section, or By position, with an Open row per position.
- *Ordering:* employees sort by name, then number, then UUID. Positions sort by name, then code, then UUID, and their colors follow that order.
- *Overlaps:* overlapping bars in one row stack in lanes.
- *Totals:* a headcount strip counts assigned people per position per hour, and each row shows its scheduled time as `h:mm`. No money appears.

**Visibility.** It follows the period page.
- *Staff:* everyone with `schedule.view` sees PUBLISHED and ARCHIVED periods. A draft-only day looks empty, not forbidden.
- *Reviewers:* holders of `schedule.edit`, `.generate` or `.publish` also see DRAFT periods (Include drafts, on by default) and receive extra `reviewer` and `timeOff` fields. Those fields cover:
  - the assignment source and when it was assigned;
  - the generation rationale;
  - station and shift notes;
  - current hard violations, computed with the period's own violation check;
  - whether a swap is open;
  - scheduled minutes for the period;
  - the latest run's unfilled summary;
  - approved and pending time-off spans, with no type or reason.
- *Redaction:* for everyone else, the `reviewer` and `timeOff` keys are absent, not null. No response contains a wage, employment status, contact detail or reason, and a test scans every key to check this. Who made an assignment isn't shown, because users have only an email.

**Selection.** Selecting a bar (click, tap, Enter or Space) opens a details panel: a side panel on desktop, a bottom sheet on a phone. The selection is kept in the URL as `?selected=`. Escape closes the panel and returns focus to the bar. The date, grouping and draft toggle are in the URL too.

**Read-only and cost.** The timeline writes nothing and isn't audited, because ordinary reads aren't. It doesn't subscribe to realtime updates. A day costs a fixed number of queries whatever the staff count; the reviewer violation check adds a fixed set per period covering the day. It uses the existing indexes on `schedule_periods (location_id, start_date)`, `shifts (schedule_period_id, shift_date)` and `shift_assignments (shift_id, status)`. The app has no dark mode, so the timeline is light-only.

**E2E in CI.** In CI, Playwright runs against `next start` on the build the workflow already makes, not `next dev`. Local runs keep `next dev`; `npm run build` then `CI=1 npm run test:e2e` reproduces CI mode. When the E2E step fails, CI uploads `test-results/`, kept for 7 days. The timeline sets `data-ready="true"` once hydrated, and its tests wait for that before clicking.

### Phase 15 UI Look and Feel

Phase 15 changed presentation only. It added no table, column, permission, migration, API field or domain rule. Plan: `docs/Phase-15-UI-Look-and-Feel.md`. Report: `docs/Phase-15-Completion-Report.md`.

**Foundation.**
- *Tokens and font:* design tokens are in a `@theme` block in `src/app/globals.css`. Inter is loaded through `next/font`, which self-hosts it at build time.
- *Primitives:* shared, hand-rolled Tailwind components live in `src/components/ui/`. The only UI dependency added is `lucide-react` for icons, and `@axe-core/playwright` was added for tests.
- *Dialogs:* built on the native `<dialog>` with `showModal()`. Escape closes them and focus returns to the opener. The safe choice is focused first, through `data-autofocus`.

**Shell.**
- *Navigation:* `navigation.ts` groups the existing permission-filtered links into Insights, Service, Back of house, People and Admin, and drops empty groups. There is one `<nav aria-label="Main">`: a sidebar from `lg` up, an off-canvas drawer with a Menu button below it. The current page is marked `aria-current="page"`.
- *Header:* it shows the single realtime connection badge, which reads the existing per-tab SSE connection and opens no new one, plus the location switcher, alerts and Log out. Detail pages show breadcrumbs.
- *Width:* Floor, Kitchen, Bar, Expo and the timeline use the full width.

**Feedback.**
- *Confirmations:* `ActionButton` takes `confirm` and shows a toast on success. Every destructive one-click action asks first, as does Publish. The void item, void order, remove discount and cancel seating flows moved from disclosures into dialogs, with the same fields and payloads.
- *Errors:* the client error helpers read `code` and `requestId` from the error envelope. `CONCURRENCY_CONFLICT` offers Reload.
- *Route states:* there are friendly `error.tsx` and `not-found.tsx` pages. There is no route-level `loading.tsx`. With Next 16 a route `loading.tsx` left two copies of the page in the DOM after a query change or a `router.refresh()`. Loading placeholders stay inside pages as Suspense fallbacks, such as the dashboard figures, and `Skeleton`/`PageSkeleton` are available for those.
- *Empty states:* page-level empty lists use `EmptyState`.

**Screens.**
- *Kitchen, Bar, Expo:* tickets show the server's `ageBand` (Phase 10 rule, warning at 10 minutes and late at 20) as border, header color and a text label. They don't compute it again. An optional new-ticket chime is off by default and stored per browser in `localStorage`.
- *Order workspace:* the check stays in view, with an unsent count and a large Send button. A browser-only menu search filters the items already loaded, and `/` focuses it.
- *Settlement:* the server's remaining balance is shown in large type. Exact cash and exact card buttons only fill the form.
- *Dashboard:* each figure is compared with the previous business date, by calling the same read-only `buildDashboard` a second time. Money is compared with exact decimal subtraction.
- *Audit viewer:* shows a field-by-field before and after table from the data the API already returns, readable action labels, and short copyable IDs linking to the record's page.

**Accessibility.**
- *Axe:* `tests/e2e/accessibility.spec.ts` runs axe (WCAG 2.1 A/AA) on Login, Dashboard, Floor, Order, Kitchen, Settlement, Timeline, Audit, Reservations and Employees. It fails on serious or critical issues.
- *Shell:* `tests/e2e/ui-shell.spec.ts` covers grouped navigation, the phone drawer, confirmations, toasts, not-found and the menu search. Specs use `tests/helpers/e2e-ui.ts` (`openNavLink`, `confirmDialog`, `expectToast`).

### Phase 16 Hardening

Phase 16 closed four reliability and security gaps and added no restaurant feature or dependency. Plan: `docs/Phase-16-Hardening.md`. Report: `docs/Phase-16-Completion-Report.md`. The policies as built are under section 9 (throttling, lockout, password change, reset, forced change, session invalidation) and section 23 (outbox backoff, dead letter, System health, retention).

- **Schema:**
  - `login_throttles`;
  - `users.must_change_password` and `users.password_changed_at`;
  - `outbox_events.next_attempt_at` and `failed_at`, with the unpublished partial index rebuilt to exclude dead-lettered rows;
  - the `SYSTEM` audit category;
  - the outbox guard trigger now allows deleting published, non-dead-lettered rows only.
  - Migrations: `0024_hardening.sql` (generated) and `0025_outbox_retention_guard.sql` (custom).
- **Permissions:** `admin.system.view` and `admin.system.manage`, for Owner and General Manager (owner decision: no separate administrator role exists). Seeded by `security.system-permissions`.
- **Audit actions:** `auth.account-locked`, `auth.account-unlocked`, `auth.password-changed` and `admin.user-password-reset`, all SECURITY with no details, and `system.outbox-event-retried` (SYSTEM). None holds an email, password, IP or payload.
- **Configuration** (`src/config/env.ts`, defaults in `.env.example`):
  - `AUTH_LOCKOUT_THRESHOLD`, `AUTH_LOCKOUT_WINDOW_MINUTES`, `AUTH_LOCKOUT_DURATION_MINUTES`;
  - `AUTH_CLIENT_IP_HEADER`, `AUTH_IP_THRESHOLD`;
  - `OUTBOX_MAX_ATTEMPTS`, `OUTBOX_RETENTION_DAYS`, `MAINTENANCE_INTERVAL_MS`.
- **Commands:** `npm run maintenance` runs one retention pass and prints counts only.

### Phase 17 Checks and Close-out

Phase 17 completed the guest check and the end of the night. Plan: `docs/Phase-17-Checks-and-Closeout.md`. Report: `docs/Phase-17-Completion-Report.md`.

- **Tax.** Tax categories are organization-wide; their rates are effective-dated per location (`tax_rates`, half-open, with an exclusion constraint). A menu item is taxed only through its explicit `tax_category_id`. `location_settings.tax_enabled` (default off) switches tax on; then SEND refuses an item with no category or no rate in force (`TAX_NOT_CONFIGURED`). SEND snapshots each item's category and rate. Tax is added on top of prices, on the amount after discounts: order discounts are allocated to items in proportion, cents by largest remainder; each (category, rate) group is rounded half up once. `orders.tax_total` and the generated `orders.total_due` (subtotal plus tax) are recomputed with the other totals, with the `order_tax_lines` projection. Settlement snapshots `total_due` (and its tax part), and the order guards lock the tax while a settlement is open.
- **Courses and hold/fire.** `order_items.course_number` (1 to 5) is chosen on drafts and frozen at SEND. SEND with `fire: FIRST_COURSE` creates held tickets (`held_at` set, `fired_at` null) for the courses above the round's lowest; one ticket per send batch, station and course. Firing (`orders.fire`) sets `fired_at` once and is idempotent by state. Station queues show only fired tickets; Expo shows held courses. Age and the fulfillment report count from firing. A trigger refuses working held items; an unprepared void still cancels them and returns their stock.
- **Split checks.** `POST /api/orders/{id}/items/move` (`orders.move-items`, idempotent) moves draft and sent items between OPEN orders on one session, or into a new check there, with neither order being settled. Both orders are locked in UUID order and recomputed. The `order_items` freeze trigger lets a sent item change order only alongside an `order_item_transfers` row written in the same transaction, and a guard keeps its send batch tied to its own order or one it was transferred from. Order screens and Expo find station work through the item; tickets keep their original order, and READY notifications still go to that order's server.
- **Refunds.** `order_refunds` records money returned after a check CLOSED (`settlements.refund`; void with `settlements.refund-void`). Cumulative refunds can't exceed the order's total due, nor their tax its tax. Card-safety checks match tenders. Refunds never touch the order, settlement, tenders, inventory or fulfillment.
- **Cash drawers.** `cash_drawers`, `cash_drawer_sessions` and `cash_drawer_movements` (paid in and out). Expected cash = float + cash tenders with tips + paid in − paid out − cash refunds; the count and the variance are snapshotted at close, and a closed session never changes. Closing is refused while an open settlement holds cash in the drawer. `location_settings.cash_drawer_required` is false for locations that existed before Phase 17 and true for new ones; when true, cash needs an open session (`CASH_DRAWER_REQUIRED`).
- **Reports.** Sales adds tax, a tax-by-category section and refunds with net after refunds (by the refund's business date). Settlements adds refunds by type and a cash drawers section.
- **Permissions** (132 in all): `tax.view`, `tax.manage`, `orders.move-items`, `orders.fire`, `settlements.refund`, `settlements.refund-void`, `drawers.view`, `drawers.operate`, `drawers.manage`, seeded by `security.checks-closeout-permissions`. Servers and bartenders hold move, fire and drawer view; managers also hold tax view, refunds and drawer operation; drawer setup and tax management are Owner and General Manager.
- **Audit and events.** `tax.*`, `orders.items-moved`, `settlements.refund-*` and `drawers.*` audit actions; `kitchen.course-fired`, `order.items-moved`, `settlement.refund-*` and `drawer.*` outbox events. The audit and outbox name CHECKs forbid a hyphen in the domain part, so the drawer domain word is `drawers`.
- **Migrations:** `0026` to `0034` (generated and custom pairs per area, plus `0034` naming three foreign keys within PostgreSQL's 63-character limit).

### Phase 18 Labor and Tips

Phase 18 records the hours people actually work and how tips are shared. Record only: no payroll, pay periods or payouts (section 39). Plan: `docs/Phase-18-Labor-and-Tips.md`. Report: `docs/Phase-18-Completion-Report.md`.

- **Time clock** (Scheduling module). `time_entries` hold the effective `clock_in_at`/`clock_out_at` beside the original `clock_in_recorded_at`/`clock_out_recorded_at`, which a trigger freezes; a clock-out set later by a manager has source `ADJUSTMENT` and no recorded instant. One OPEN entry per employee (partial unique index) and no overlapping non-voided entries (exclusion constraint). Breaks lie inside their entry (deferred constraint trigger); unpaid breaks are subtracted. Clock-in, clock-out and breaks take idempotency keys. Eligibility (ACTIVE, at the location, holding the position on the business date) uses the Employees module's scheduling facts. Terminating someone on the clock is refused (`EMPLOYEE_ON_CLOCK`). Manager punches, adjustments and voids are audited (category `SCHEDULING`); self punches aren't.
- **Overtime.** Weekly only, by business date: hours past the threshold in a work week, allocated to the latest work first and computed over whole weeks, so a date's figures don't depend on the report range. Overtime is costed at the hourly rate × `scheduling_rules.overtime_multiplier` (default 1.50). Warnings (`NONE`, `APPROACHING` within 4 hours, `OVERTIME`) show on `/my-time` and the manager's time clock.
- **Tips** (Settlements module, finalize in `src/workflows/finalize-tip-distribution`). The pool is all RECORDED tender tips on COMPLETED settlements of CLOSED orders on the business date. Shares are worked hours × points per participating Position, in whole cents by largest remainder (ties: employee number, then UUID, then position code). Finalize is refused while the date has OPEN checks, OPEN settlements or OPEN time entries; one FINALIZED distribution per location and date; voiding allows a redo. While a date is finalized its time entries can't be created, corrected or voided (`TIP_DISTRIBUTION_FINALIZED`).
- **Reports.** Labor keeps the Phase 12 scheduled sections unchanged and adds actual labor (overall and by employee), scheduled vs. actual (late and early-out by `late_clock_in_grace_minutes`, unscheduled, no-show, over 16 hours), overtime by week and time clock exceptions. Every cost figure still needs `hr.compensation.view`. A new Tips area (`reports.tips`) shows tips by date and tender, direct tips by server, and finalized shares.
- **Permissions** (137 in all): `timeclock.punch` (every role), `timeclock.view`, `timeclock.manage`, `tips.manage` and `reports.tips` (Owner, General Manager, Manager), seeded by `security.labor-tips-permissions`.
- **Migrations:** `0035` (tables and the two `scheduling_rules` columns) and `0036` (custom: overlap exclusion, freeze, break and append-only triggers).

### Phase 19 Menu and Stock Signals

Phase 19 turns recorded stock and sales into signals for service. Nothing in it moves inventory. Plan: `docs/Phase-19-Menu-and-Stock-Signals.md`. Report: `docs/Phase-19-Completion-Report.md`.

- **86 board** (Menu module). `menu_item_outages` (manual 86 with a reason, then restore; one ACTIVE per item and location; frozen once RESTORED) and `menu_item_stock_overrides` (sell anyway for one business date; one uncleared per item, location and date). Portions remaining = the lowest whole `on hand / per-portion requirement` over the current recipe's ingredients, from a bulk Recipes query that gives exactly what SEND resolves; modifiers are ignored, and an item with no recipe has no figure. Auto-86 is opt-in per location (`auto_86_from_stock`, default off) and worked out on every read, never stored. `getOperationalMenu` leaves out unsellable items, so draft add and SEND refuse them with `ITEM_NOT_SELLABLE`. `/menu/86` shows what is 86'd, running low (1 to 5 portions), sold anyway and restored today; the order screen shows "N left" and what is 86'd. Changes are audited (category `MENU`) and emit `menu.availability-changed` after commit.
- **Low-stock alerts** (Inventory module). `postInventoryTransaction` opens an alert when a posting takes stock from above the reorder level to at or below it, and resolves it on the way back above, under the balance lock, writing `INVENTORY_LOW` notifications to active `purchasing.manage` holders at the location. Changing the reorder level opens or closes nothing until the next posting.
- **Suggested orders.** Need = the Phase 8 suggested quantity minus what is outstanding on DRAFT, SUBMITTED and PARTIALLY_RECEIVED orders, in whole purchase units rounded up, from the stocked item's preferred supplier item. `POST /api/purchasing/suggested-orders` (idempotency scope `purchasing.suggest`) creates one DRAFT per supplier; nothing is submitted.
- **Reports**, in the existing areas after their unchanged sections: sales by hour opened (Sales); item mix and menu engineering across the whole menu (Menu; engineering only with cost); server performance, with tips only for tip viewers, and voids, comps and discounts by the employee who did them (Orders); 86 history (Inventory).
- **Permission** (138 in all): `menu.availability.manage` (Owner, General Manager, Manager, Cook, Bartender), seeded by `security.menu-stock-permissions`. The auto-86 setting needs `locations.manage`.
- **Migrations:** `0037` (tables and columns) and `0038` (custom: outage, override and alert guards; the notifications guard now covers the alert link).

### Phase 22 Online Reservations and Guest Messaging

Phase 22 builds the guest messaging and online booking group of section 39, with the Phase 21 leftovers, by owner decision on 2026-11-12 (plan approved with D1–D16 as recommended; nodemailer through a peer override, accepted as DEV-004). Marketing, two-way messaging, external reservation networks, deposits and staff email or SMS stay out. Plan: `docs/Phase-22-Online-Reservations-and-Guest-Messaging.md` (16 amendments). Report: `docs/Phase-22-Completion-Report.md`. It supersedes section 22's "no SMS/email" line for guest service messages, and the Phase 6 and Phase 21 plans' bans on guest messaging; the ban on marketing stays.

- **Messaging** (section 22): `guest_messages`, `message_suppressions`, `guest_party_message_consents`, the port and adapters, the dispatcher, and counts on Admin → System health. Staff record consent with two unticked boxes on the reservation and waitlist forms; a changed phone or email withdraws that channel.
- **Staff messages.** Creating a confirmed reservation, confirming one, changing its date, time or party size, and cancelling it queue the matching message; no-shows and seating cancel what is waiting. Notify on the waitlist queues the table-ready message (SMS first, else email); "Text again" repeats it at most once a minute. Each reservation and waitlist card has a Messages panel: consent state, history (addresses masked without `guests.contact.view`), retry and send-again.
- **Online booking** (section 13): `online_booking_settings`, `online_booking_periods`, `public_throttles`; `reservations.source` gains `ONLINE`, `created_by_user_id` is null only for it, `online_request_key_hash` makes a retried booking return the first one, and `cancelled_by_guest` marks a cancel through the link. Settings and hours at **Host → Online booking**. A filled spam-trap field gets a normal-looking answer and stores nothing; at most two upcoming online bookings per phone or email.
- **Erase.** Erasing a profile also clears its visits' consents, message content and manage links; a visit with no profile can be erased on its own (`POST /api/guest-parties/{id}/erase`, `guests.erase`, audit `guests.visit-erased`).
- **Permissions** (148 in all): `reservations.online.manage` (Owner, General Manager, Manager), `messages.view` and `messages.resend` (Owner, General Manager, Manager, Host), seeded by `security.guest-messaging-permissions`.
- **Phase 21 leftovers.** The validation seed (`phase21.validation-guests-allergens`) and the demo seed add allergen tags, a declared `MAY_CONTAIN` and guest profiles; an integration test moves and shares an acknowledged item; `src/instrumentation.ts` tests `NEXT_RUNTIME` inline, so the Edge build no longer traces `node:crypto`.
- **Migrations:** `0051`–`0052` (messages and suppressions, guards), `0053`–`0054` (consents and manage links, guards), `0055` (online booking settings, hours, throttles, the `ONLINE` source and `GUEST` actor).

### Phase 21 Guest Profiles and Allergens

Phase 21 builds the CRM part of section 39 with allergen labeling, by owner decision on 2026-11-12 (plan approved with D1–D16 as recommended). Loyalty, marketing consent, guest messaging, online reservations, nutrition facts and per-seat allergies stay out. Plan: `docs/Phase-21-Guest-Profiles-and-Allergens.md`. Report: `docs/Phase-21-Completion-Report.md`. It supersedes the Phase 6 plan's "no customer profile" lines (sections 6 and 7); the bans on loyalty and marketing consent stay.

- **Guest profiles (Reservations).** `guest_profiles` (organization-wide; human-readable `profile_number` from a per-organization counter; ACTIVE, MERGED or ERASED, guarded by a trigger), `guest_profile_allergies` (allergen, `SEVERE` or `ALLERGY`, note). A party links by hand at reservation or walk-in creation, or later (`PUT/DELETE /api/guest-parties/{id}/profile`), while it isn't finished. Search: an exact phone or email match first (only with `guests.contact.view`), then names. Editing a profile's allergies refreshes the `PROFILE` allergies of its unfinished visits. Merge moves visits and missing allergies (the more severe wins); erase clears the profile, every profile merged into it (a MERGED profile may change once more, only to be erased) and its visits' contact details and allergies. Free text refuses 13 or more digits in a row.
- **Allergen labels (Recipes).** `allergens` (seeded by `recipes.allergen-foundation`), `inventory_item_allergens` with `ingredient_allergen_reviews`, `menu_item_allergens` with `menu_item_allergen_reviews` (the review marks live in Recipes tables, so `inventory_items` stays Inventory's). `resolveItemAllergens` builds every label from the requirements SEND consumes (`applyModifierEffects`), so the order screen, the menu item page and SEND agree. The Allergens page lists ingredients in current or draft recipes still to review.
- **Allergies on an order.** The visit's (`guest_party_allergies`, recorded by hosts under `guests.manage` or servers under `orders.edit`) or, for a check with no party, the check's (`order_allergies`). The order screen shows them, each item's label and any conflict. `guest.allergies-changed` refreshes open screens.
- **SEND.** After recipe and modifier resolution, conflicts are found with `findAllergenConflicts`; unacknowledged ones refuse the round before any write. Acknowledged items get `allergy_acknowledged_by_user_id`, `allergy_acknowledged_at` and `allergy_conflict_snapshot`; every sent item gets `allergen_label_incomplete_snapshot` and its `order_item_allergens` rows (insert-only, while its send batch is created). Ticket items get the alert. Audit: `orders.allergen-acknowledged`. All frozen; moves and shares keep them.
- **Permissions** (145 in all): `guests.view`, `guests.contact.view`, `guests.manage`, `guests.merge`, `guests.erase`, `recipes.allergens.manage`, seeded by `security.guest-profiles-permissions`.
- **Migrations:** `0048` (allergen tables), `0049` (guest profiles, visit and check allergies, SEND snapshots, the `GUESTS` audit category), `0050` (guards).

### Phase 20 Service Polish and Deferred Features

Phase 20 closed the work left open by Phases 6 to 19, by owner decision on 2026-11-11 (plan approved with D1–D23 as recommended). Reopening a CLOSED check, payments, the section 39 capabilities and cloud deployment stay out. Plan: `docs/Phase-20-Service-Polish-and-Deferred-Features.md`. Report: `docs/Phase-20-Completion-Report.md`.

- **Menu and stock.** SEND snapshots the item's menu category (`order_items.menu_category_id`, `menu_category_name_snapshot`) from the placement the operational menu resolved; older items report as "Uncategorized", and item mix and menu engineering also run within each category. `modifier_outages` 86es a modifier at one location; an item whose required group is left with fewer choices than its minimum isn't sellable there, and SEND refuses an 86'd choice (`MODIFIER_UNAVAILABLE`). Item and modifier 86es take `starts_at` and an optional `ends_at` ("until close" ends at the next business-day cutoff); they're in effect only inside that window, worked out on read, and an exclusion constraint replaces the one-ACTIVE index. `location_settings.running_low_portions` (default 5) sets "running low". Stocked-item level changes and general location settings changes are audited (`inventory.item-location-changed`, `organization.location-settings-changed`, new audit category `ORGANIZATION`). Sales by hour has an inline SVG bar chart above its table.
- **Floor.** Moving or combining a seated party onto another party's held table runs the seating hold rule in the move's own transaction (`src/workflows/move-table-session`): refused, or allowed with `reservations.override-hold` and a reason, which is recorded.
- **Time.** Every screen shows instants in the location's time zone (`formatInstant`), and `datetime-local` inputs are read in it. The manager's time clock edits breaks through the Phase 18 adjust API.
- **Notifications.** `SCHEDULE_PUBLISHED`, `SHIFT_CHANGED`, `TIME_OFF_APPROVED` and `TIME_OFF_DENIED` are written in the transaction of the change; `CERTIFICATION_EXPIRING`, `OVERTIME_APPROACHING` and `MISSED_CLOCK_OUT` come from the hourly maintenance run, once per dedupe key and recipient. Each kind has its own link column, checked by a constraint; recipients are active users at the location.
- **Checks.** A tax rate may say the menu price includes it (`tax_rates.price_includes_tax`, snapshotted on the item): the tax inside is price × rate ÷ (100 + rate), half up, and comes out of `subtotal` through `orders.included_tax_total`, so `total_due = subtotal + tax_total` still holds. A check can be tax exempt (`tax.exempt`, Owner, General Manager, Manager; OPEN with no OPEN settlement; reason and an optional reference that refuses card-like digits): it pays no tax. One sent item can be shared 2 to 10 ways between checks on its session: it becomes `SPLIT`, `order_item_shares` carry equal amounts (cents by largest remainder) with its tax snapshot, and kitchen work, consumption and modifiers stay on the original; reports count the item once. A refund may return a tip (`order_refunds.tip_amount`, CASH or EXTERNAL_CARD, up to the recorded tips; refused while the date's tips are finalized); the pool and expected drawer cash subtract it.
- **Labor and tips.** `scheduling_rules.daily_overtime_threshold` (null is off): hours past it on a business date are overtime first, and weekly overtime counts only the hours that stayed regular. `tip_declarations` record cash tips an employee says they kept (self under `timeclock.punch` for a worked date, anyone under `tips.manage`); never in the pool; frozen while the date is finalized; shown in the Tips report.
- **Loading and tooling.** Report areas and the audit trail stream their data inside `Suspense` with a skeleton. The E2E web server command prepares the test database before starting the app. `migrations.test.ts` runs with a 30 s timeout; root-only `.gitignore` rules are anchored.
- **Permission** (139 in all): `tax.exempt`, seeded by `security.service-polish-permissions`.
- **Migrations:** `0039` to `0047` (generated and custom pairs per area: menu, notifications, tax, shared items; then labor and tips).

## 34. Cloud Deployment (On Hold)

Cloud deployment is on hold by owner decision (2026-11-10). No deployment phase is scheduled. `docs/Cloud-Deployment-Guide.md` describes what a deployment would take on AWS or Azure.

While it is on hold, the application must stay cloud-provider independent:
- No provider-specific database branches. Local Docker PostgreSQL and a managed PostgreSQL service use the same Drizzle/PostgreSQL code path.
- No provider SDKs in domain code. Provider integrations (for example object storage) go behind infrastructure abstractions such as `FileStorageService`.
- Configuration comes only from environment variables validated in `src/config/`, so a deployment supplies them from its own secret store.

Principles for a future deployment, whichever provider is chosen:
- Keep infrastructure simple: one VM or app host running Next.js/Node.js plus a managed PostgreSQL server. No Kubernetes for the POC.
- Do not expose the database to the Internet. Allow access only from the app host or approved sources.
- Encrypt database connections, and serve the app over HTTPS.
- Keep credentials in a secret store or environment configuration, never in code.
- Run Drizzle migrations as a controlled deployment step. Seed only POC data.
- Configure cost alerts, backups and basic logging.

## 35. File Storage Strategy

Employee documents and menu images are stored through a `FileStorageService` abstraction.

Local development may use a local adapter.

A cloud deployment may add an object-storage adapter (for example Amazon S3 or Azure Blob Storage) later without changing the domain API.

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

### Audit Domain (before Phase 13)

Deliver:
- `audit_events`, append-only, written in the same transaction as each audited action
- The audit registry with per-action allow-listed fields
- Audit events for access, security administration, HR changes and restricted reads, scheduling, orders, menu and recipes, inventory, settlements and CSV export
- Audit viewing API and page, controlled by `audit.view`
- Audit tests
- Audit Domain Completion Report (`docs/Audit-Domain-Completion-Report.md`)

### Phase 13: Full Integration/E2E

Run a complete simulated restaurant day without manually altering the DB.

### Phase 14: Schedule Timeline

Deliver a read-only, day-by-day Gantt view of the schedule at the current Location, grouped by Employee or by Position, with open slots, a per-hour headcount strip, and a details panel for the selected shift and assignment. It follows the existing schedule visibility rules and adds no table or permission. Plan: `docs/Phase-14-Schedule-Timeline.md`.

Inserted by owner decision on 2026-11-10. AWS deployment and acceptance moved from Phases 14 and 15 to 15 and 16. Completion reports written before then that mention "Phase 14" for AWS work mean Phase 15.

### Phase 15: UI Look and Feel

Deliver a consistent, accessible presentation layer without changing behavior: design tokens and shared UI primitives in `src/components/ui/`, grouped permission-filtered navigation with a phone drawer, confirmation before destructive actions, toasts, route-level loading/error/not-found states, empty states, human status labels, a readable audit viewer, upgraded Floor, Kitchen/Bar/Expo, Order, Settlement, Dashboard and Login screens, and an automated accessibility check. Light theme only. No migration, permission, API or domain rule change. Plan: `docs/Phase-15-UI-Look-and-Feel.md`.

Inserted by owner decision on 2026-11-10. AWS deployment and acceptance moved from Phases 15 and 16 to 16 and 17. Documents written before then that mention "Phase 15" for AWS work mean Phase 16.

### Phase 16: Hardening

Close reliability and security gaps without adding restaurant features: Postgres-backed sign-in throttling with temporary lockout and admin unlock (identical failure message and timing preserved), outbox backoff and dead letter with an Admin → System health page and audited retry, a maintenance runner that purges published outbox rows past retention and expired throttle rows (idempotency records and all history are kept), and a password lifecycle: self-service change, admin reset with a one-time temporary password, forced change at next sign-in, and ending older sessions after a change. No email, reset links or MFA. Plan: `docs/Phase-16-Hardening.md`.

Added by owner decision on 2026-11-10. It is not a deployment phase; cloud deployment stays on hold.

### Phase 17: Checks and Close-out

Complete the guest check and the end of the night. Five areas: tax by explicitly assigned tax category with effective-dated location rates, snapshotted at SEND, with settlement reconciling to `total_due`; refund records on CLOSED orders (record only; the order stays CLOSED and nothing reopens it); moving draft and sent items between checks on one Table Session; course numbers with Send & hold and a manual Fire, using held tickets rather than a new kitchen item state; and cash drawers with float, paid-in/out, count and variance, required for cash per a location setting. Plan: `docs/Phase-17-Checks-and-Closeout.md`.

Added by owner decision on 2026-11-10. It replaces the README section 19 deferrals for tax and refunds, and the section 18 deferral of courses and hold/fire.

### Phase 18: Labor and Tips

Record the hours people actually work and what happens to tips. Four areas: a time clock (self punches on the user's own login and manager punches for staff without one, breaks, shift matching, idempotent retries, and audited adjustments that keep the original punch times); weekly overtime from the existing scheduling rules with an overtime multiplier and live warnings; actual labor reports next to the unchanged scheduled ones (scheduled vs. actual, overtime, exceptions, cost behind `hr.compensation.view`); and one daily tip pool per location split by hours worked × position points, previewed then finalized as an immutable snapshot, with a Tips report. Record only: no payroll, pay periods or tip payouts. Plan: `docs/Phase-18-Labor-and-Tips.md`.

Added by owner decision on 2026-11-10. It adds actual labor next to the Phase 12 scheduled labor policy; payroll processing stays a future capability (section 39).

### Phase 19: Menu and Stock Signals

Turn recorded stock and sales into signals for service. Four areas: a per-location 86 board (manual 86 with a reason and restore, read-time portions remaining, opt-in auto-86 from stock, and a "sell anyway" override for the business date), checked in one place for both draft add and SEND; low-stock alerts opened and resolved by inventory postings, with in-app `INVENTORY_LOW` notifications; suggested DRAFT purchase orders per preferred supplier, never submitted; and report sections for sales by hour, item mix and menu engineering, server performance, voids/comps/discounts by employee, and 86 history. Nothing in this phase moves inventory. Plan: `docs/Phase-19-Menu-and-Stock-Signals.md`.

Approved by the owner on 2026-11-11, with decisions D1–D10 as recommended in the plan. Item mix and menu engineering compare items across the whole menu (amendment 7: order items carry no category snapshot).

### Phase 20: Service Polish and Deferred Features

Close the work left open by Phases 6 to 19. Menu and stock: a category snapshot at SEND for item mix and menu engineering by category, modifier 86 and scheduled 86, a per-location running-low threshold, audited stocked-item and location settings changes, and a sales-by-hour chart. Floor: the seating hold rule on move and combine. Time and notifications: location time zones everywhere, break editing, and the schedule, time-off, certification, overtime and missed clock-out notifications. Checks: tax included in prices, tax-exempt checks, one item shared between checks, and tip refunds. Labor and tips: daily overtime and cash tip declarations. Plus loading boundaries and test tooling fixes. Plan: `docs/Phase-20-Service-Polish-and-Deferred-Features.md`.

Approved by the owner on 2026-11-11, with decisions D1–D23 as recommended in the plan. It supersedes the Phase 17 and 18 scope lines for tax-inclusive pricing, exemptions, shared items, tip refunds, daily overtime, cash tip declarations and overtime/missed clock-out notifications.

### Phase 21: Guest Profiles and Allergens

Guest profiles linked to Guest Parties by hand (contact details tiered, merge and erase), visit history from snapshots, allergies on the visit or check, allergen labels worked out from recipes and modifiers with an ingredient review mark, and an allergy warning that SEND refuses until acknowledged, with the acknowledgment frozen on the item and shown on the kitchen ticket. Plan: `docs/Phase-21-Guest-Profiles-and-Allergens.md`.

Approved by the owner on 2026-11-12, with decisions D1–D16 as recommended in the plan. It supersedes the Phase 6 plan's lines against customer profiles and visit history.

### Phase 22: Online Reservations and Guest Messaging

A public online booking page per location (booking hours, pacing, a private view-or-cancel link), and email and SMS service messages to guests (confirmations, changes, cancellations, reminders and "table ready") through a provider-neutral port behind a message outbox, only with per-visit consent and never to an opted-out address. Plus the Phase 21 leftovers: seed data, the move-and-share test and the Edge build warning. Plan: `docs/Phase-22-Online-Reservations-and-Guest-Messaging.md`.

Approved by the owner on 2026-11-12, with decisions D1–D16 as recommended in the plan. It supersedes section 22's "no SMS/email" line for guest service messages and the Phase 6 and Phase 21 plans' bans on guest messaging.

### Cloud Deployment: On Hold

The AWS deployment and acceptance phases (formerly Phases 16 and 17) were removed by owner decision on 2026-11-10. Cloud deployment is on hold; `docs/Cloud-Deployment-Guide.md` describes what a deployment would take on AWS or Azure. If deployment resumes, it is planned as a new phase with the owner's approval, followed by an acceptance run of the major E2E workflow against the deployed URL from desktop, tablet, and phone-sized clients. Earlier documents that mention Phase 14, 15, 16 or 17 for AWS work refer to this deferred work.

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
- Customer loyalty (guest profiles were built in Phase 21)
- Delivery integrations
- DoorDash/Uber Eats integrations
- External reservation integrations (OpenTable, Resy and the like; the restaurant's own online booking page was built in Phase 22)
- Payment processing
- Payroll processing
- Accounting integrations
- SMS/email notifications to staff (guest service messages were built in Phase 22)
- Full offline synchronization
- Demand forecasting based on historical sales/reservations
- Ingredient lots/FIFO/expiration-by-lot
- Vendor EDI
- Nutritional analysis (allergen labeling was built in Phase 21)
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
- The application stays cloud-provider independent, so it can later deploy to AWS or Azure with managed PostgreSQL without provider-specific business code (deployment is on hold; see `docs/Cloud-Deployment-Guide.md`).

## License

Copyright (c) 2026 Kneale Alpers. Released under the [PolyForm Noncommercial License 1.0.0](LICENSE).

- **Noncommercial use is free.** Personal projects, study, research, testing, and use by charities, schools, public research bodies and government institutions are allowed. You may copy, modify and share the code for those purposes.
- **Credit is required.** Anyone who shares the code, changed or not, must include the license terms and the `Required Notice:` lines at the top of [LICENSE](LICENSE), which credit the original developer.
- **Commercial use needs a separate license.** Running this application in a business, selling it, offering it as a service, or building it into a commercial product requires a commercial license from the developer. To ask for one, email **restaurantops.licensing@gmail.com**. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for what to include.

The software comes as is, without warranty.
