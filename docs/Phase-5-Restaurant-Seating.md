# Phase 5: Restaurant & Seating Implementation Plan

## Purpose

Phase 5 implements the physical restaurant seating model: restaurant tables, table conditions, table sessions, combined tables, server sections, server assignments, seating, moving parties, session completion, and the dirty/clean lifecycle.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 4 implementation plans
5. This document

`README.md` remains the architectural source of truth.

Phase 5 must build on the existing Organization, Location, Restaurant Area, Employee, Position, Scheduling, authentication, and location-aware RBAC foundations without implementing Phase 6 Reservations/Waitlist or Phase 9 Orders prematurely.

---

## 1. Phase 5 Objectives

Implement:

```text
Location
  |
  +-- Restaurant Areas
  |     +-- Dining Room
  |     +-- Bar
  |
  +-- Restaurant Tables
  |     +-- Physical condition
  |     +-- Capacity
  |
  +-- Server Sections
  |     +-- Section Tables
  |     +-- Server Assignments
  |
  +-- Table Sessions
        +-- One or more physical tables
        +-- Party/guest-count context
        +-- Assigned server
```

Deliver:

- Physical table configuration
- Table capacities
- Physical table condition tracking
- Append-oriented table condition history
- Table sessions
- Multi-table combinations
- Server sections
- Section-to-table configuration
- Effective server-section assignments
- Seating workflow
- Party/session movement between tables
- Server assignment/reassignment
- Capacity warnings and controlled override
- Double-seating protection
- Session completion
- Dirty-to-clean lifecycle
- Out-of-service handling
- Responsive host/floor status UI
- Manager configuration UI
- Permission enforcement
- Unit, PostgreSQL integration, and Playwright E2E coverage

---

## 2. Scope Boundary

Do not implement during Phase 5:

```text
reservations
waitlist
reservation table planning
menu
recipes
inventory
orders
split checks
kitchen/bar tickets
settlements
full reporting
full audit domain
```

Phase 6 will connect Reservations/Waitlist/Guest Parties to the seating foundation.

Phase 9 will connect Orders to `table_sessions`.

Do not create fake physical tables for Takeout.

Do not create an Order-to-restaurant-table foreign key.

---

## 3. Critical Model Boundary: Condition vs Occupancy

Physical table condition and table occupancy are separate concepts.

Physical condition:

```text
CLEAN
DIRTY
OUT_OF_SERVICE
```

Occupancy:

```text
Derived from whether an active table session currently occupies the table.
```

Examples:

```text
Table 12
Condition: CLEAN
Occupancy: OCCUPIED
```

is valid.

Do not model a single combined status enum such as:

```text
AVAILABLE
OCCUPIED
DIRTY
OUT_OF_SERVICE
```

Availability for seating is derived from both condition and occupancy.

---

## 4. Review Existing Foundation Before Changes

Before editing, inspect and confirm:

- Phase 0 through Phase 4 tests remain green.
- Location and Restaurant Area schemas are understood.
- Employee status/location/Position eligibility is understood.
- Published scheduling data and assignment provenance are understood.
- Authentication and location-aware RBAC are understood.
- Shared transaction and optimistic-concurrency patterns are understood.
- Business-date conventions are understood.
- Existing permission catalog is understood.
- Seed/reset/test DB infrastructure remains intact.
- `DEV-001` remains tracked.

Before coding, provide a concise Phase 5 execution plan based on actual repository state.

---

## 5. Restaurant Tables

Create:

```text
restaurant_tables
```

Conceptual fields:

```text
id                  UUID PK
location_id         UUID FK
restaurant_area_id  UUID FK
table_number        required
name                nullable
capacity            integer required
minimum_capacity    integer nullable
condition           required
sort_order          integer
active              BOOLEAN default TRUE
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

Required constraints:

```text
UNIQUE (location_id, table_number)
capacity > 0
minimum_capacity > 0 when present
minimum_capacity <= capacity
```

Restaurant Area must belong to the same Location.

A table may be deactivated for configuration purposes without erasing historical sessions.

---

## 6. Table Number and Display Name

Use a stable table number/code for operational identity within a location.

Examples:

```text
1
2
10
BAR-1
HT-3
```

Do not represent combined tables by changing `table_number` to values such as `10+11`.

Combined tables are modeled relationally through table-session membership.

---

## 7. Table Condition History

Create:

```text
table_condition_history
```

Conceptual fields:

```text
id                  UUID PK
restaurant_table_id UUID FK
condition           required
reason              nullable
changed_by_user_id  UUID nullable FK
occurred_at         TIMESTAMPTZ
created_at          TIMESTAMPTZ
```

Treat this as append-oriented history.

Changing current condition should update the table's current condition and append a condition-history row atomically.

Do not rewrite historical condition entries merely to make history look cleaner.

---

## 8. Table Condition Rules

Required rules:

- `OUT_OF_SERVICE` blocks new seating.
- `DIRTY` blocks new seating.
- `CLEAN` is required for normal new seating.
- An occupied table cannot be switched to a condition that contradicts an active operational session unless an explicit manager workflow supports it.
- Completing a table session transitions associated tables to `DIRTY` unless an explicit valid operational rule states otherwise.
- Cleaning transitions `DIRTY -> CLEAN`.
- Condition changes require appropriate permission.

Do not infer occupancy from the physical condition field.

---

## 9. Table Sessions

Create:

```text
table_sessions
```

A Table Session represents the active seating of a party at one or more physical tables.

Conceptual fields:

```text
id                    UUID PK
location_id           UUID FK
party_size            integer required
status                required
assigned_server_employee_id UUID nullable FK
seated_at             TIMESTAMPTZ
completed_at          TIMESTAMPTZ nullable
created_by_user_id    UUID FK
completed_by_user_id  UUID nullable FK
notes                  nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Initial statuses:

```text
ACTIVE
COMPLETED
CANCELLED
```

If a more precise lifecycle is required, stop and document the business need before expanding it.

Phase 6 may add a Guest Party reference once that domain is introduced.

Do not create a fake reservation/guest-party table in Phase 5 solely to satisfy future relationships.

---

## 10. Table Session Tables

Create:

```text
table_session_tables
```

Conceptual fields:

```text
id                UUID PK or composite equivalent
table_session_id  UUID FK
restaurant_table_id UUID FK
joined_at         TIMESTAMPTZ
left_at           TIMESTAMPTZ nullable
created_at        TIMESTAMPTZ
```

This supports combined tables:

```text
Party of 8
   |
   v
Table Session
   +-- Table 10
   +-- Table 11
```

Do not duplicate physical-table records to create combinations.

---

## 11. Active Table Occupancy Protection

A physical table must not participate in two active Table Sessions simultaneously.

This must be protected against concurrency at the database/service transaction level, not only by checking the UI first.

Required scenario:

```text
Host A attempts Table 12
Host B attempts Table 12 concurrently
        |
        v
Exactly one succeeds
Other receives TABLE_ALREADY_OCCUPIED / conflict
```

Use a PostgreSQL-compatible constraint/locking/transaction strategy appropriate to the existing architecture.

Do not rely on a race-prone `SELECT then INSERT` without protection.

---

## 12. Seating Capacity

For one table:

```text
available capacity = table.capacity
```

For combined tables:

```text
combined capacity = sum(active physical table capacities)
```

Initial rule:

```text
party_size <= combined capacity
```

If `minimum_capacity` is used, it may support host guidance but should not create an overly rigid POC rule unless clearly required.

Capacity is a seating business rule, not an authorization rule.

---

## 13. Capacity Override

Managers may need to seat a party exceeding configured nominal capacity due to configuration inaccuracies or legitimate operational judgment.

Recommended Phase 5 behavior:

```text
Normal seat:
party_size <= combined capacity

Over capacity:
regular host -> denied
user with explicit manager seating override permission -> allowed only with override acknowledgement/reason
```

Do not silently ignore capacity.

If implementing an override, persist enough metadata for future auditing, for example an override reason/actor on the session or a dedicated lightweight history record if appropriate.

Do not build the full Audit domain yet.

---

## 14. Seating Workflow

Implement an explicit cross-entity workflow under `src/workflows/seat-party/` or equivalent.

Conceptually:

```text
Authenticate/authorize
        |
        v
Validate location
Validate party size
Validate selected tables
  + active configuration
  + CLEAN condition
  + not occupied
Validate capacity/override
Validate server when supplied
        |
        v
BEGIN TRANSACTION
Recheck/lock selected table availability
Create Table Session
Create Table Session Table rows
Assign server if supplied
Write minimal future-audit-ready metadata
COMMIT
```

The workflow must be concurrency safe.

Phase 6 will extend the workflow to connect a Guest Party/Reservation/Waitlist entry.

---

## 15. Move Table Session

Implement an authorized workflow to move an active Table Session from one table set to another.

Examples:

```text
Table 4 -> Table 8
Tables 10 + 11 -> Table 15
Table 6 -> Tables 7 + 8
```

Rules:

- Target tables must pass seating checks.
- Target tables cannot be occupied by another active session.
- Capacity rules apply.
- Operation is atomic.
- Original table membership is ended/preserved historically.
- Newly occupied target tables remain under the same Table Session.
- Moving must not create a new session unless explicitly dictated by the business operation.

Define whether vacated tables become DIRTY. Recommended POC rule: moving a seated party causes vacated physical tables to become `DIRTY` because they were used, unless a manager explicitly records that they were never used. Keep the initial flow simple and document it.

---

## 16. Add/Remove Combined Table During Active Session

Support manager/host operations, where authorized, to adjust table membership during an active session.

Examples:

```text
Add Table 11 to Session currently at Table 10
Remove Table 11 later
```

Validate:

- Added table CLEAN and unoccupied.
- Capacity remains valid after removals.
- Removal does not leave an impossible party/capacity state unless manager override exists.
- Removed used table becomes DIRTY according to the documented condition policy.
- Membership history preserved through `joined_at` / `left_at` or equivalent.

Do not physically delete historical session-table membership rows.

---

## 17. Complete Table Session

Implement explicit completion.

Conceptually:

```text
ACTIVE Table Session
        |
        v
Guests leave
        |
        v
Complete Session
        |
        +-- status COMPLETED
        +-- completed_at
        +-- completed_by_user_id
        +-- end active table memberships
        +-- associated tables -> DIRTY
        |
        v
COMMIT
```

Future Phase 9 Orders may eventually impose additional rules before session completion, but Phase 5 must not invent order dependencies prematurely.

---

## 18. Cancel Table Session

Support cancellation only where operationally valid.

Examples may include accidental seating creation before guests actually use the table.

Document behavior for table conditions:

- If no table was actually used, cancellation may return tables to prior CLEAN state.
- If tables were used, use completion/dirty behavior rather than cancellation as a shortcut.

Keep cancellation authorization stricter than ordinary view access.

---

## 19. Clean Table Workflow

Implement an explicit operation:

```text
DIRTY -> CLEAN
```

Rules:

- Table must not be actively occupied.
- User must have appropriate restaurant/seating permission.
- Condition history appended.
- Operation concurrency/version checked.

Do not automatically clean tables after a timer.

---

## 20. Out-of-Service Workflow

Authorized users can transition tables into/out of `OUT_OF_SERVICE`.

Rules:

- New seating is blocked while out of service.
- Prefer not to mark an actively occupied table out of service through the normal command. Require active session resolution first unless a manager emergency workflow is explicitly implemented.
- Returning to service should require explicit target condition, normally `CLEAN` if verified ready.
- Append condition history.

---

## 21. Server Sections

Create:

```text
server_sections
```

Conceptual fields:

```text
id              UUID PK
location_id     UUID FK
name            required
code            required
restaurant_area_id UUID nullable FK
active          BOOLEAN default TRUE
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
version         INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (location_id, code)
```

Examples:

```text
DINING_A
DINING_B
BAR
```

Do not assume a section permanently belongs to one employee.

---

## 22. Section Tables

Create:

```text
server_section_tables
```

Conceptual fields:

```text
id                    UUID PK or composite equivalent
server_section_id     UUID FK
restaurant_table_id   UUID FK
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
```

A table may belong to a configured section according to the chosen model.

If operationally necessary for sections to overlap, explicitly document the rule. Recommended initial POC behavior: a physical table has at most one active server-section membership at a time to keep ownership understandable.

Use DB/service constraints accordingly.

---

## 23. Server Section Assignments

Create:

```text
server_section_assignments
```

Conceptual fields:

```text
id                  UUID PK
server_section_id   UUID FK
employee_id         UUID FK
business_date       DATE or applicable operational date
effective_from      TIMESTAMPTZ
effective_to        TIMESTAMPTZ nullable
assigned_by_user_id UUID FK
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

This associates a qualified Employee with an operational section for a period.

Do not use Security Role as server qualification.

---

## 24. Server Eligibility

To assign an Employee as a server/section owner, validate HR facts.

At minimum:

```text
Employee ACTIVE
Employee eligible at Location
Employee has an effective server-capable Employee Position
```

Server-capable positions are defined by the approved centralized Restaurant-domain policy. Do not infer qualification from matching text names or Security Roles.

Approved Phase 5 Position-to-area policy:

```text
DINING_ROOM: SERVER, WAIT_STAFF
BAR:         BARTENDER, SERVER, WAIT_STAFF
TAKEOUT:     no Table Session server assignment
```

`BARTENDER` does not qualify for `DINING_ROOM`. `HOST`, `COOK`, `MANAGER`, `GENERAL_MANAGER`, `INVENTORY_MANAGER`, and all other Employee Positions are not qualified unless this policy is explicitly changed in a future phase. The policy is static in Phase 5 but must remain behind a replaceable Restaurant-domain boundary for possible future location-specific configuration.

Employee ACTIVE status, effective Location eligibility, effective Employee Position, and this area-to-Position mapping are hard constraints. A manager schedule override cannot bypass any of them. Security Roles never provide Employee job qualification.

---

## 25. Scheduling-Aware Server Assignment Policy

Phase 4 now provides published schedules, but restaurant operation should not become unusable because a schedule is missing or changed unexpectedly.

Approved Phase 5 schedule policy:

1. HR and Restaurant Position-to-area qualification remain hard requirements.
2. The Employee must have an ACTIVE assignment to a Position-matching shift at the same Location, within a schedule period whose status is `PUBLISHED`.
3. The current server instant must satisfy the half-open shift interval `start_at <= now < end_at`; Phase 4 stores these as timezone-resolved instants.
4. If no matching published shift assignment exists, seating/assignment requires `restaurant.schedule.override` and an explicit reason. This includes the absence of an applicable published schedule.
5. The manager override applies only to schedule matching. It cannot bypass Employee status, Location eligibility, effective Employee Position, or the approved area-to-Position mapping.

This is an explicit rule, not accidental coupling. The approved decisions were recorded on 2026-10-06.

---

## 26. Assign Server to Section

Implement an explicit command/workflow.

Validate:

- Location scope.
- Section active.
- Employee active.
- Location eligibility.
- Server-capable Position effective.
- Scheduling-aware rule above.
- No conflicting assignment according to section policy.

Persist assignment provenance and effective range.

Do not grant the Employee application permissions as part of this workflow.

---

## 27. Assign Server to Table Session

A Table Session may have an assigned server independent of section defaults.

On seating:

```text
Selected table(s)
      |
      v
Determine section/default server if available
      |
      v
Host may assign qualified server
```

Allow authorized reassignment during an active session.

Changing the session's assigned server does not change floor section configuration.

Do not make server-session assignment dependent on a User account. An Employee can be assigned operationally even if they do not have application login credentials.

---

## 28. Server Section vs Table Session Assignment

Preserve this distinction:

```text
Server Section Assignment
= operational ownership of a group of tables

Table Session Assigned Server
= server responsible for a particular seated party/session
```

Normally the section server may become the default for a new session, but the session may be reassigned without rewriting the section itself.

---

## 29. Section Reconfiguration

Managers may update section-to-table configuration while no conflicting active floor operations prevent it.

Avoid reconfiguration that silently changes responsibility for already active Table Sessions.

Existing sessions retain their assigned server unless explicitly reassigned.

Use optimistic concurrency on section configuration.

---

## 30. Floor Status Query

Create a purpose-built query/DTO for the host/floor UI.

It should expose only operationally appropriate data:

```text
Table id/number/name
Area
Capacity
Condition
Occupancy derived from active session
Current session id if authorized
Party size
Seated time
Assigned server display identity
Section
Warnings
```

Do not load restricted HR details.

Do not expose session/order concepts that do not exist yet.

---

## 31. Table Availability Query

Centralize table seating availability logic.

Conceptual result:

```text
AVAILABLE
DIRTY
OUT_OF_SERVICE
OCCUPIED
INACTIVE
```

These may be view/query statuses even though they are not persisted as one physical table-status enum.

Return structured reason codes useful to UI and workflows.

---

## 32. Host/Floor UI

Create a responsive operational floor view.

Initial implementation may use cards/list/grid rather than a graphical drag-and-drop floor designer.

Display:

```text
Table number
Capacity
Area
Condition
Occupancy
Party size when occupied
Assigned server
Section
Elapsed seated time
```

Use clear visual distinction for:

```text
Available/Clean
Occupied
Dirty
Out of Service
```

Do not create image-based floorplan editing unless explicitly requested later.

---

## 33. Seating UI

Host workflow should allow:

```text
Select one or more CLEAN available tables
Enter party size
Select/confirm server
Review capacity warning
Seat
```

For over-capacity seating:

- Regular host receives denial.
- Authorized manager override flow requires explicit acknowledgement/reason.

The UI is not the security boundary; server workflow enforces all checks.

---

## 34. Move/Combine UI

For active sessions, authorized users should be able to:

```text
Move to another table
Combine with additional table
Remove a table from combination
Reassign server
```

Display consequences clearly, especially:

```text
Vacated table will become DIRTY
Target table must be CLEAN and available
```

Do not physically delete historical table-session membership.

---

## 35. Cleaning UI

Provide a simple operational action to mark a DIRTY table CLEAN.

This should work well on tablet/mobile.

Do not expose a clean action for an occupied table.

Do not automatically clean a table just because an employee clicks session completion.

---

## 36. Table Configuration UI

Authorized managers may configure:

```text
Table number
Display name
Area
Capacity
Minimum capacity optional
Sort order
Active/inactive
```

Do not allow hard deletion of a table with historical references through normal UI.

Use optimistic concurrency.

---

## 37. Section Configuration UI

Authorized managers may configure:

```text
Section code/name
Area
Section table membership
Active/inactive
```

Operational server assignment should be a separate action from structural section configuration.

---

## 38. Permissions

Use or extend central permissions consistently.

Expected capabilities include concepts such as:

```text
restaurant.view
restaurant.manage
restaurant.tables.manage
restaurant.sections.manage
restaurant.seat
restaurant.move
restaurant.complete-session
restaurant.clean-table
restaurant.condition.manage
restaurant.server.assign
restaurant.capacity.override
restaurant.schedule.override
```

Exact codes should align with the existing catalog and avoid duplicate synonyms.

Host/manager role mappings should be updated deliberately through versioned idempotent seeds.

---

## 39. Host Role

The Host security role should generally receive enough permissions for normal front-desk seating operations, such as:

```text
restaurant.view
restaurant.seat
restaurant.move where approved
restaurant.clean-table as appropriate
restaurant.server.assign within standard rules
```

It should not automatically receive:

```text
capacity override
schedule override
structural table configuration
security administration
restricted HR
```

Finalize role mappings deliberately and test representative allow/deny behavior.

---

## 40. Manager Overrides

Manager override is not a generic bypass-everything switch.

Phase 5 override capabilities should be explicit:

```text
capacity override
server schedule override
```

Hard constraints that should generally remain non-overridable:

```text
wrong organization/location
inactive table configuration
table already occupied by another active session
OUT_OF_SERVICE target table without condition resolution
Employee not qualified by Employee Position
```

Document every overridable rule and required reason metadata.

---

## 41. Concurrency and Optimistic Versions

Use Phase 1 versioning on mutable entities such as:

```text
restaurant_tables
table_sessions
server_sections
server_section_assignments
```

Critical seating operations also require transactional occupancy protection beyond optimistic version alone.

Test stale host views and concurrent seat attempts.

---

## 42. Transaction Boundaries

Use shared transaction context for:

```text
Seat party/session
Move session
Add/remove combined table
Complete session + mark tables DIRTY
Clean table + append condition history
Change table condition + history
Assign/reassign server
Server section assignment changes
```

Do not leave half-completed combined-table/session state on failure.

---

## 43. Failure Atomicity

Test deliberate failures during multi-table seating/moving.

Example:

```text
Seat Tables 10 + 11
Table 10 valid
Table 11 becomes occupied concurrently
        |
        v
ENTIRE operation fails
No partial Table Session membership
```

Likewise, moving a session must either move to the complete target table set or remain on the original set.

---

## 44. Business Date

Where `business_date` is required for server section operational assignments or future reporting, use the approved shared business-date policy/service if implemented.

Do not derive it by simply taking the calendar date from a timestamp.

If the BusinessDateService has not yet been implemented despite the architecture, implement the minimal shared authoritative service now only if Phase 5 requires persisted business dates, preserving the README rule that it is the sole calculator.

---

## 45. Condition History and Future Audit

`table_condition_history` is domain history, not the future Audit domain.

It answers:

```text
What physical condition changes occurred to this table?
```

Future audit will answer:

```text
Who performed which application action and from what context?
```

Keep these concerns separate.

---

## 46. No Order Dependency Yet

Phase 5 Table Session completion cannot yet check for open Orders because Orders do not exist until Phase 9.

Do not create placeholder order tables/API calls.

Design the completion workflow so Phase 9 can add an Order-domain precondition later without redesigning Table Sessions.

---

## 47. Phase 6 Extension Point

Phase 6 will introduce:

```text
guest_parties
reservations
reservation_table_assignments
waitlist_entries
party_status_history
```

Phase 5 Table Sessions should therefore be designed so a future nullable/required `guest_party_id` relationship can be added cleanly.

Do not create a fake `guest_parties` table in Phase 5.

---

## 48. Unit Tests: Table Availability

Test pure/domain logic for:

```text
CLEAN + unoccupied -> available
DIRTY + unoccupied -> unavailable
OUT_OF_SERVICE -> unavailable
inactive configuration -> unavailable
CLEAN + active session -> occupied/unavailable
```

Ensure query availability labels remain derived rather than persisted as a conflicting status.

---

## 49. Unit Tests: Capacity

Test:

```text
party equal to capacity -> allowed
party below capacity -> allowed
party above capacity -> standard denial
combined capacity sums tables
manager capacity override -> allowed with reason
regular host capacity override -> denied
```

Do not make capacity override silently available to all managers unless permission mapping explicitly grants it.

---

## 50. Unit Tests: Server Eligibility

Test:

```text
ACTIVE + location + SERVER Position -> qualified
SERVER Security Role only -> not qualified
inactive employee -> not qualified
wrong location -> not qualified
expired/not-effective Position -> not qualified
WAIT_STAFF according to configured mapping -> qualified
published shift match -> standard assignment allowed
qualified but not scheduled -> manager override behavior
no published schedule -> configured override behavior
```

Do not query compensation or restricted HR data.

---

## 51. Integration Tests: Table Configuration

Test:

```text
create table
unique table number per location
same number allowed at different fixture location if desired by schema
area/location mismatch rejected
capacity constraint
condition history initialization if implemented
optimistic concurrency
inactive table cannot be seated
```

---

## 52. Integration Tests: Seating

Test:

```text
seat single CLEAN table
seat combined CLEAN tables
reject DIRTY table
reject OUT_OF_SERVICE table
reject inactive table
reject occupied table
party capacity validation
manager capacity override
regular host capacity override denied
server qualification
session assigned-server storage
```

---

## 53. Integration Tests: Concurrent Seating

Required high-value test:

```text
Two concurrent operations target same CLEAN table
        |
        v
one session created
one operation rejected
no duplicate occupancy
```

Also test combined-table race behavior where practical.

---

## 54. Integration Tests: Move/Combine

Test:

```text
move active session to available table
move to occupied table rejected
move to dirty/out-of-service target rejected
combine additional table
remove combined table
capacity maintained
vacated table becomes DIRTY according to policy
membership history retained
operation atomic on failure
```

---

## 55. Integration Tests: Session Completion

Test:

```text
ACTIVE -> COMPLETED
completed_at/user recorded
all active memberships ended
all used tables become DIRTY
condition history appended
completed session cannot be completed twice
stale version rejected
```

---

## 56. Integration Tests: Clean/Condition

Test:

```text
DIRTY -> CLEAN
occupied table clean attempt rejected
CLEAN -> OUT_OF_SERVICE with permission
OUT_OF_SERVICE blocks seating
return from OUT_OF_SERVICE according to workflow
condition history preserved
unauthorized condition change denied
```

---

## 57. Integration Tests: Server Sections

Test:

```text
create section
assign tables
prevent invalid cross-location table membership
active membership uniqueness according to chosen policy
assign qualified server
Security Role alone insufficient
published-schedule validation/warning/override behavior
session defaults to section server where intended
session server can be independently reassigned
section change does not rewrite active session server
```

---

## 58. Authorization Integration Tests

Test representative permissions directly against server operations:

```text
restaurant.view -> floor query allowed
no restaurant.view -> floor query denied
restaurant.seat -> standard seating allowed
no restaurant.seat -> seating denied
capacity override permission required
schedule override permission required
structural table/section management restricted
unauthenticated direct API denied
cross-location access denied
```

Do not rely on hidden UI actions as proof of authorization.

---

## 59. E2E Tests: Host Seating

Add Playwright workflow:

```text
Host logs in
 -> views floor status
 -> selects CLEAN available table
 -> enters party size
 -> assigns qualified server
 -> seats party
 -> table displays occupied/session details
```

Use isolated test fixtures and clean them deterministically.

---

## 60. E2E Tests: Combined Tables

Test:

```text
Host selects two compatible CLEAN tables
 -> seats larger party
 -> both show same active session
```

Then complete/move as useful to prove membership behavior.

---

## 61. E2E Tests: Dirty/Clean Lifecycle

Test:

```text
Seat party
 -> complete session
 -> table DIRTY
 -> cannot seat while DIRTY
 -> authorized clean action
 -> table CLEAN/available
```

This is a core Phase 5 acceptance scenario.

---

## 62. E2E Tests: Out of Service

Test:

```text
Manager marks table OUT_OF_SERVICE
 -> host cannot seat it
 -> authorized manager returns table to service/CLEAN
 -> table available again
```

---

## 63. E2E Tests: Move Session

Test:

```text
Seat at Table A
 -> move to CLEAN Table B
 -> Table A becomes DIRTY
 -> Table B occupied by same Table Session
```

Verify no new session was silently created.

---

## 64. E2E Tests: Authorization

Test a representative host/manager difference:

```text
Host over-capacity seat -> denied
Manager with explicit override -> allowed with reason
```

And verify direct API denial for an unauthorized user.

---

## 65. Seed Data

Use idempotent Phase 5 seed data for development/POC configuration only.

Recommended Main Restaurant seed configuration may include a modest set of physical tables, for example:

```text
Dining Room:
  T01 capacity 4
  T02 capacity 4
  T03 capacity 2
  T04 capacity 6

Bar:
  B01 capacity 2
  B02 capacity 2
```

The exact count/capacities may be adjusted if the user already has a desired floor configuration.

Do not seed Takeout as a physical table.

Seed one or two simple server sections only if useful for demonstrating the Phase 5 workflow.

Do not seed fake active table sessions as permanent development seed data.

---

## 66. Seed Idempotency

Run:

```text
npm run db:seed
npm run db:seed
```

Verify no duplicate:

```text
restaurant tables
server sections
section/table mappings
```

Use stable business codes/table numbers rather than fixed UUIDs.

---

## 67. Migration Requirements

Generate and review the Phase 5 migration.

Verify:

```text
Existing Phase 4 DB
 -> Phase 5 migration
 -> success
```

and:

```text
Empty test DB
 -> all migrations Phase 1 through Phase 5
 -> expected final schema
```

A second `db:generate` must show no unexplained schema drift.

Keep historical earlier migrations immutable despite non-fatal name-truncation notices already documented.

---

## 68. Reset Regression

Verify on a safe/disposable environment:

```text
npm run db:reset
npm run db:seed
```

reconstructs Phase 1 through Phase 5 state.

Do not weaken remote/production reset protections.

---

## 69. Prior-Phase Regression

Phase 5 must preserve:

```text
authentication
location-aware RBAC
Employee/HR privacy
User != Employee
Security Role != Employee Position
scheduling availability policy
scheduling generator behavior
termination-linked-user behavior
file storage security
```

Phase 5 restaurant queries must not load restricted HR data.

Server display information should use safe employee summary fields only.

---

## 70. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies must remain clean or new findings must be reviewed before Phase 5 approval.

Avoid adding unnecessary floorplan/graphics libraries for the initial host UI.

Preserve `DEV-001` unless intentionally reviewed due to dependency changes.

---

## 71. Documentation Updates

Document:

- Physical condition vs occupancy model
- Table availability derivation
- Table session lifecycle
- Combined-table behavior
- Capacity rule and override
- Move-session dirty-table policy
- Cleaning workflow
- Out-of-service behavior
- Server section model
- Server eligibility policy
- Scheduling-aware server assignment policy
- Manager override permissions
- Seeded POC table/section configuration
- Phase 6 Guest Party extension point
- Phase 9 Order-to-Table-Session extension point

Do not rewrite unrelated architecture sections.

---

## 72. Phase 5 Validation Checklist

Start/confirm PostgreSQL:

```text
docker compose up -d
docker compose ps
```

Clean install:

```text
npm ci
```

Database lifecycle:

```text
npm run db:generate
npm run db:migrate
npm run db:seed
npm run db:seed
```

Safe reset regression as appropriate:

```text
npm run db:reset
npm run db:seed
```

Static validation:

```text
npm run lint
npm run typecheck
```

Tests:

```text
npm run test:unit
npm run test:integration
npm run test:e2e
```

Production build:

```text
npm run build
```

Production dependency audit:

```text
npm audit --omit=dev
```

Also verify:

```text
PostgreSQL health                    PASS
/api/health                          PASS
migration generation                 PASS
migration application                PASS
empty DB reconstruction              PASS
schema drift                         NONE
seed idempotency                     PASS
reset safeguards                     PASS
prior phase regressions              PASS
condition vs occupancy separation    PASS
table availability                   PASS
single-table seating                 PASS
combined-table seating               PASS
capacity checks                      PASS
capacity override permission         PASS
concurrent double-seat prevention    PASS
move session                         PASS
combine/remove table                 PASS
session completion                   PASS
DIRTY lifecycle                      PASS
clean workflow                       PASS
OUT_OF_SERVICE blocking              PASS
condition history                    PASS
server sections                      PASS
Employee Position qualification      PASS
Security Role not qualification      PASS
schedule-aware server assignment     PASS
server reassignment                  PASS
host/manager authorization           PASS
production dependency audit          CLEAN
```

---

## 73. Phase 5 Deliverables

Phase 5 should leave the repository with:

```text
✓ restaurant_tables
✓ table_sessions
✓ table_session_tables
✓ server_sections
✓ server_section_tables
✓ server_section_assignments
✓ table_condition_history

✓ condition distinct from occupancy
✓ derived table-availability query
✓ capacity validation
✓ explicit manager capacity override
✓ concurrency-safe seating
✓ combined table support
✓ move-session workflow
✓ add/remove table workflow
✓ session completion
✓ DIRTY -> CLEAN lifecycle
✓ OUT_OF_SERVICE workflow
✓ historical condition tracking

✓ server-section configuration
✓ server-section assignments
✓ HR-based server qualification
✓ scheduling-aware server validation/override
✓ independent Table Session server assignment

✓ responsive host/floor UI
✓ table configuration UI
✓ section configuration UI
✓ seating/move/clean operational UI

✓ Phase 5 permissions and role mappings
✓ idempotent table/section development seeds

✓ domain unit tests
✓ PostgreSQL concurrency/integration tests
✓ Playwright restaurant-seating tests
✓ prior-phase regressions green
✓ production dependency audit clean
✓ no Phase 6+ business domains prematurely implemented
```

---

## 74. Phase 5 Definition of Done

Phase 5 is complete when an authorized host/manager can perform this lifecycle:

```text
View floor
   |
   v
Find CLEAN available table(s)
   |
   v
Seat party
   +-- capacity checked
   +-- server qualification checked
   +-- concurrency protected
   |
   v
ACTIVE Table Session
   +-- one or multiple physical tables
   +-- assigned server
   |
   +-- optional move/combine/reassign
   |
   v
Guests leave
   |
   v
Complete Table Session
   |
   v
Used tables become DIRTY
   |
   v
Clean tables
   |
   v
CLEAN / available again
```

And the application proves:

- A physical table cannot be double-seated.
- Physical condition is distinct from occupancy.
- Combined tables use relational membership rather than fake table identifiers.
- An out-of-service table cannot be seated.
- Dirty tables cannot be seated.
- Capacity overrides require explicit permission and reason.
- A Security Role does not prove an Employee is qualified as a Server.
- HR qualification remains mandatory.
- Scheduling-aware server exceptions require explicit manager authority where configured.
- Table Session server assignment is distinct from Server Section configuration.
- Session moves are atomic and preserve membership history.
- Used vacated/completed tables become DIRTY according to the documented policy.
- Sensitive HR data is not exposed to host/floor queries.
- Database reconstruction requires no manual SQL.
- Prior phase regressions remain green.

Phase 5 is not complete if table occupancy is persisted only as a table status flag without active Table Session protection.

Phase 5 is not complete if concurrent hosts can create two active sessions on the same physical table.

Phase 5 is not complete if Takeout is modeled as a fake restaurant table.

---

## 75. Required Phase 5 Completion Report

When Phase 5 is complete, provide:

```text
PHASE 5 COMPLETION REPORT

Environment
- Node version:
- npm version:
- Next.js version:
- PostgreSQL version:
- Drizzle ORM version:
- Drizzle Kit version:

Restaurant Schema
- restaurant_tables: PASS / FAIL
- table_sessions: PASS / FAIL
- table_session_tables: PASS / FAIL
- server_sections: PASS / FAIL
- server_section_tables: PASS / FAIL
- server_section_assignments: PASS / FAIL
- table_condition_history: PASS / FAIL

Table Model
- Condition/occupancy separation: PASS / FAIL
- Derived availability: PASS / FAIL
- Capacity constraints: PASS / FAIL
- Area/location consistency: PASS / FAIL
- Table configuration concurrency: PASS / FAIL

Seating
- Single table seating: PASS / FAIL
- Combined table seating: PASS / FAIL
- Double-seating prevention: PASS / FAIL
- Concurrent seating race test: PASS / FAIL
- Capacity validation: PASS / FAIL
- Capacity override: PASS / FAIL
- Override reason/provenance: PASS / FAIL
- DIRTY table rejected: PASS / FAIL
- OUT_OF_SERVICE rejected: PASS / FAIL
- Inactive table rejected: PASS / FAIL

Table Sessions
- ACTIVE lifecycle: PASS / FAIL
- Move session: PASS / FAIL
- Add combined table: PASS / FAIL
- Remove combined table: PASS / FAIL
- Membership history: PASS / FAIL
- Move failure atomicity: PASS / FAIL
- Completion: PASS / FAIL
- Completion makes used tables DIRTY: PASS / FAIL
- Cancellation behavior: PASS / FAIL

Table Condition
- DIRTY -> CLEAN: PASS / FAIL
- Occupied clean attempt rejected: PASS / FAIL
- OUT_OF_SERVICE workflow: PASS / FAIL
- Condition history: PASS / FAIL
- Unauthorized change denied: PASS / FAIL

Server Sections
- Section configuration: PASS / FAIL
- Table membership: PASS / FAIL
- Cross-location membership rejected: PASS / FAIL
- Section assignment: PASS / FAIL
- Employee ACTIVE requirement: PASS / FAIL
- Employee Location requirement: PASS / FAIL
- Employee Position qualification: PASS / FAIL
- Security Role does not qualify Employee: PASS / FAIL
- Published-schedule validation: PASS / FAIL
- Schedule override behavior: PASS / FAIL
- Table Session server assignment: PASS / FAIL
- Session server reassignment: PASS / FAIL
- Section change does not rewrite active session server: PASS / FAIL

Authorization
- Floor view: PASS / FAIL
- Standard seating: PASS / FAIL
- Move permission: PASS / FAIL
- Clean permission: PASS / FAIL
- Capacity override permission: PASS / FAIL
- Schedule override permission: PASS / FAIL
- Structural table management permission: PASS / FAIL
- Structural section management permission: PASS / FAIL
- Direct unauthorized API denied: PASS / FAIL
- Cross-location authorization: PASS / FAIL

Seeds
- Restaurant tables: PASS / FAIL
- Server sections: PASS / FAIL
- Section memberships: PASS / FAIL
- Seed idempotency: PASS / FAIL
- No fake Takeout table: PASS / FAIL

Migrations
- Generation: PASS / FAIL
- Application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Regression
- Phase 1 foundation: PASS / FAIL
- Phase 2 auth/RBAC: PASS / FAIL
- Phase 3 Employees/HR: PASS / FAIL
- Phase 4 Scheduling: PASS / FAIL
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

Business Domains Created Beyond Phase 5
- NONE expected

Created / Modified
- Summarize schema, migration, restaurant module/workflows, server sections, permissions, UI, seeds, tests, and documentation.

Architecture Deviations
- None
  OR
- Describe each deviation and why it was necessary.

Outstanding Phase 5 Issues
- None
  OR
- List each unresolved issue and whether it blocks Phase 6.

Phase 6 Readiness
- READY / NOT READY
```

---

## 76. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-5-Restaurant-Seating.md`, use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 5 implementation plans completely. Treat `README.md` as the architectural source of truth.
>
> Review the completed Phase 0 through Phase 4 implementation before modifying files. Implement Phase 5 only: Restaurant & Seating, including physical restaurant tables, capacities, physical table conditions and append-oriented condition history, Table Sessions, concurrency-safe single/combined-table seating, Table Session table membership history, move/combine/remove-table workflows, completion and dirty/clean lifecycle, out-of-service handling, Server Sections, section/table configuration, qualified Employee server assignments, scheduling-aware server validation and explicit overrides, Table Session server assignment/reassignment, host/floor queries and responsive operational UI, permissions, idempotent development seeds, migrations, and required automated tests.
>
> Preserve these boundaries: table condition is separate from occupancy; occupancy derives from active Table Sessions; combined tables use relational membership; Security Role does not qualify an Employee to work as a Server; Employee Position and Location eligibility remain authoritative; Table Session server assignment is separate from Server Section configuration; Takeout is not a physical restaurant table.
>
> Do not implement Reservations, Waitlist, Guest Party persistence, Menu, Recipes, Inventory, Orders, Kitchen/Bar fulfillment, Settlements, full Reporting, or later-phase functionality. Do not create placeholder Order tables or an Order-to-physical-table relationship. Design Table Sessions so Phase 6 can later add Guest Party linkage and Phase 9 can later add one-to-many Orders without redesigning the seating model.
>
> Use database/transaction-level concurrency protection so two hosts cannot simultaneously seat the same physical table. Preserve the Phase 1 migration/transaction/test architecture, Phase 2 location-aware RBAC, Phase 3 HR privacy and Position/Role boundaries, Phase 4 scheduling rules and locked availability policy, reset safeguards, exact numeric conventions, and DEV-001 accepted-risk decision.
>
> Before modifying files, inspect the current repository and provide a concise Phase 5 execution plan. If the exact policy for matching current restaurant time to a published Phase 4 server shift, server-capable Employee Positions, or another material seating rule is ambiguous, stop and explain the ambiguity, options, recommendation, and impact before implementing it.
>
> After implementation, run the complete Phase 5 validation suite and provide the full Phase 5 Completion Report. If an architectural conflict or significant seating-policy decision is encountered, stop at that decision point and explain the conflict, options, recommendation, and architectural impact before altering the approved architecture.

---


## Final Guardrail

Phase 5 models physical restaurant occupancy safely and prepares the system for Reservations/Waitlist and Orders without implementing either prematurely.

The core architecture remains:

```text
Physical Restaurant Table
   + Condition
   + Capacity
        |
        v
Table Session
   + one or more Tables
   + qualified assigned Server
        |
        +-- Phase 6: Guest Party / Reservation / Waitlist
        |
        +-- Phase 9: one or more Orders
```

Do not collapse these layers for implementation convenience.
