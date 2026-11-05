# Phase 6: Reservations & Waitlist Implementation Plan

## Purpose

Phase 6 implements Guest Parties, Reservations, reservation table planning, walk-ins, Waitlist operations, guest arrival/no-show/cancellation workflows, deterministic table recommendations, and the transition from planned customer arrival to the actual Phase 5 Table Session seating model.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. All Phase 0 through Phase 5 implementation plans
5. This document

`README.md` remains the architectural source of truth.

Phase 6 must preserve the Phase 5 distinction between planned future table allocation and actual physical occupancy.

---

## 1. Phase 6 Objectives

Implement:

```text
Guest Party
   |
   +-- Reservation
   |      |
   |      +-- Planned Table Assignment(s)
   |
   +-- Waitlist Entry
   |
   +-- Party Status History
   |
   v
Seat Party Workflow
   |
   v
Phase 5 Table Session
   |
   +-- Actual physical Table(s)
```

Deliver:

- Guest Party identity and lifecycle
- Reservations
- Reservation modifications
- Reservation cancellation
- Guest arrival/check-in
- No-show handling
- Planned reservation table assignments
- Reservation conflict detection
- Reservation hold rules
- Walk-in Guest Party creation
- Waitlist lifecycle
- Quoted wait times
- Recorded guest notification state
- Deterministic table recommendations
- Combined-table recommendations
- Reservation-to-seating workflow
- Waitlist-to-seating workflow
- Phase 5 Table Session Guest Party linkage
- Concurrency and optimistic version protection
- Host/manager permissions
- Responsive reservation/waitlist/host UI
- Unit, integration, and Playwright E2E coverage

---

## 2. Scope Boundary

Do not implement during Phase 6:

```text
SMS notifications
email notifications
external reservation-service integrations
customer CRM/loyalty
online consumer self-service reservation portal
menu
recipes
inventory
orders
kitchen/bar fulfillment
settlements
full reporting
full audit domain
```

Do not process payments or reservation deposits.

Do not create Orders while seating a party.

Phase 9 will connect one or more Orders to the resulting `table_session`.

## Approved Phase 6 Business Policies

Apply these decisions consistently in the schema, services, UI, tests, and documentation:

- Reservation statuses are exactly `PENDING`, `CONFIRMED`, `CHECKED_IN`, `SEATED`, `COMPLETED`, `CANCELLED`, and `NO_SHOW`.
- Waitlist statuses are exactly `WAITING`, `NOTIFIED`, `TABLE_ASSIGNED`, `SEATED`, `CANCELLED`, and `LEFT`.
- Use `CHECKED_IN`, not `ARRIVED`, for reservation and Guest Party check-in semantics. Record `checked_in_at`.
- `TABLE_ASSIGNED` does not create physical occupancy. Only a successfully committed Phase 5 Table Session creates physical occupancy.
- Reservation planning conflicts use the half-open interval `[reservation_at - reservation_pre_hold_minutes, reservation_at + expected_duration_minutes + reservation_post_grace_minutes)`.
- Walk-in hold protection uses the distinct half-open interval `[reservation_at - reservation_pre_hold_minutes, reservation_at + reservation_post_grace_minutes)`.
- Both intervals use structured Location settings, initially 15 minutes pre-hold and 15 minutes post-grace.
- `NO_SHOW` is manual only. It is allowed only for a `CONFIRMED` reservation when `now >= reservation_at + configured reservation_post_grace_minutes`. Record actor and timestamp, release planned-table holds, and never undo actual seating.
- Combined-table recommendations may contain at most three physical tables, all from the same Restaurant Area.

`README.md` is authoritative for lifecycle terminology. Do not introduce `ARRIVED` or other lifecycle synonyms.

---

## 3. Critical Boundary: Reservation Planning vs Occupancy

A reservation table assignment is a future planning commitment.

A Table Session represents actual physical seating.

```text
Reservation Table Assignment
    = planned table use

Table Session Table Membership
    = actual physical occupancy
```

A reserved table is not automatically physically occupied.

Do not mark a table `OCCUPIED` because a reservation references it.

Phase 5 active Table Sessions remain authoritative for occupancy.

---

## 4. Critical Boundary: Guest Party vs Reservation vs Waitlist

A Guest Party is the customer group being served.

A Reservation is one arrival plan for a Guest Party.

A Waitlist Entry represents waiting for current seating availability.

Do not collapse these into one large status table.

Conceptually:

```text
Guest Party
   +-- may have Reservation
   +-- may have Waitlist Entry
   +-- may eventually have Table Session
```

A walk-in can have a Guest Party and Waitlist Entry without a Reservation.

A Reservation Guest Party may be seated without ever entering the Waitlist.

---

## 5. Review Existing Foundation Before Changes

Before modifying files, inspect and confirm:

- Phase 0 through Phase 5 validations remain green.
- Phase 5 table availability and occupancy queries are understood.
- Phase 5 concurrency-safe seating workflow is understood.
- Table Sessions and combined-table membership are understood.
- Table condition/occupancy separation is preserved.
- Restaurant Areas and physical Tables are understood.
- BusinessDateService is understood.
- Location settings are understood.
- Phase 2 location-aware RBAC is understood.
- Shared transaction and optimistic concurrency systems are understood.
- Existing permission catalog is understood.
- Reset/seed/test DB infrastructure remains intact.
- DEV-001 remains tracked.

Before coding, provide a concise Phase 6 execution plan based on actual repository state.

---

## 6. Guest Parties

Create:

```text
guest_parties
```

Conceptual fields:

```text
id                    UUID PK
location_id           UUID FK
party_size            integer required
guest_name            required
phone                 nullable
email                 nullable
special_requests      nullable
status                required
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Initial statuses may include:

```text
EXPECTED
WAITING
CHECKED_IN
SEATED
COMPLETED
CANCELLED
NO_SHOW
```

Keep the model small and operational.

Do not turn this into a customer CRM profile.

---

## 7. Guest Contact Data

Guest phone/email exist only to support reservation/waitlist operations during the POC.

Rules:

- Do not require email.
- Phone may be optional according to workflow, although a waitlist/reservation should normally capture a usable contact method where available.
- Do not log contact data unnecessarily.
- Do not build marketing consent, loyalty, or customer-history profiling.
- Do not expose guest contact information through unrelated restaurant queries.

---

## 8. Party Status History

Create:

```text
party_status_history
```

Conceptual fields:

```text
id                  UUID PK
guest_party_id      UUID FK
status              required
reason              nullable
changed_by_user_id  UUID nullable FK
occurred_at         TIMESTAMPTZ
created_at          TIMESTAMPTZ
```

Treat as append-oriented domain history.

Guest Party status changes should update current status and append history atomically.

Do not rewrite historical status entries.

---

## 9. Reservations

Create:

```text
reservations
```

Conceptual fields:

```text
id                    UUID PK
guest_party_id        UUID FK
location_id           UUID FK
reservation_at        TIMESTAMPTZ required
expected_duration_minutes integer required
status                required
source                required
notes                  nullable
checked_in_at          TIMESTAMPTZ nullable
cancelled_at           TIMESTAMPTZ nullable
cancelled_by_user_id   UUID nullable FK
no_show_at             TIMESTAMPTZ nullable
created_by_user_id     UUID FK
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Initial statuses:

```text
PENDING
CONFIRMED
CHECKED_IN
SEATED
COMPLETED
CANCELLED
NO_SHOW
```

Do not create consumer/web booking channels in Phase 6.

Initial source values may include:

```text
PHONE
WALK_IN_FUTURE
IN_PERSON
INTERNAL
```

Keep sources simple and extensible.

---

## 10. Reservation Time and Duration

Store the reservation as an actual timezone-resolved instant.

Use the Location timezone when converting host-entered local date/time.

Expected duration is used for planning/conflict detection.

Reservation planning conflicts use the approved half-open interval:

```text
[reservation_at - reservation_pre_hold_minutes,
 reservation_at + expected_duration_minutes + reservation_post_grace_minutes)
```

Do not determine reservation business date by truncating the timestamp.

Use BusinessDateService if a persisted business date is required.

---

## 11. Reservation Table Assignments

Create:

```text
reservation_table_assignments
```

Conceptual fields:

```text
id                    UUID PK
reservation_id        UUID FK
restaurant_table_id   UUID FK
assigned_by_user_id   UUID FK
assigned_at           TIMESTAMPTZ
removed_at            TIMESTAMPTZ nullable
created_at             TIMESTAMPTZ
```

These are planned table assignments.

Support multiple physical tables for one reservation.

Do not physically delete prior table planning history; end/remove assignments explicitly where practical.

---

## 12. Reservation Capacity Planning

Planned table capacity follows Phase 5 physical capacities.

For planned combined tables:

```text
combined planned capacity = sum(table capacities)
```

Normal planning should require:

```text
party_size <= planned combined capacity
```

If Phase 5 manager capacity override semantics are reused for reservation planning, use the same explicit authorization/reason principle rather than silently ignoring capacity.

Do not claim that planned table assignment guarantees final seating at those exact tables.

---

## 13. Reservation Planning Conflicts

A planned table assignment should detect time conflicts with other active/confirmed reservations assigned to the same physical table.

Use reservation intervals and expected duration.

Reservations assigned to the same physical table conflict when their approved reservation planning conflict intervals overlap. Adjacent intervals do not conflict.

Cancelled/No-Show reservations should cease blocking according to lifecycle rules.

Do not treat an expired past reservation as a current planning conflict.

---

## 14. Reservation Hold Policy

Lock in the initial Phase 6 policy unless the user explicitly changes it:

```text
Pre-reservation hold: 15 minutes
Post-reservation grace: 15 minutes
```

These values should be structured Location settings, not magic constants scattered in code.

A walk-in hold interval is:

```text
[reservation_at - reservation_pre_hold_minutes,
 reservation_at + reservation_post_grace_minutes)
```

The reservation planning conflict interval is distinct and includes expected duration:

```text
[reservation_at - reservation_pre_hold_minutes,
 reservation_at + expected_duration_minutes + reservation_post_grace_minutes)
```

Both intervals use half-open semantics and structured Location settings. Seed `reservation_pre_hold_minutes = 15` and `reservation_post_grace_minutes = 15`.

Document the exact interval functions separately for:

1. walk-in hold protection near arrival, and
2. reservation-vs-reservation planning conflicts.

---

## 15. Reservation Hold Is Not Occupancy

During a reservation hold window:

```text
Table condition may be CLEAN
Physical occupancy may be AVAILABLE
Reservation hold may be ACTIVE
```

Expose this as a host planning state/warning, not stored occupancy.

Conceptual host status:

```text
AVAILABLE_PHYSICALLY
RESERVATION_HOLD
```

Do not modify the Phase 5 occupancy unique constraint to treat a reservation as an active Table Session.

---

## 16. Walk-In Seating Against Reservation Hold

Initial policy:

- Ordinary Host cannot seat an unrelated walk-in at a table under an active reservation hold.
- Authorized manager may override the reservation hold with explicit permission and reason.
- HR/server/table-condition/occupancy/capacity constraints remain unchanged.
- Reservation record is not automatically cancelled merely because a manager uses another table during its hold.

Store override actor/reason/category for future audit readiness.

Suggested category:

```text
RESERVATION_HOLD_OVERRIDE
```

---

## 17. Reservation Creation Workflow

Implement an authorized command/service.

Conceptually:

```text
Authorize
Validate Location
Validate requested time and party size
Create Guest Party
Create Reservation
Optionally assign planned Table(s)
Validate planning conflicts/capacity
Append party history
COMMIT
```

If table planning is optional, reservation creation must succeed without planned tables.

Do not require host to commit to a physical table far in advance if operations prefer to plan later.

---

## 18. Reservation Modification

Support authorized modification of:

```text
reservation date/time
party size
expected duration
guest contact data
notes/special requests
planned tables
```

Use optimistic concurrency.

Revalidate table capacity and planning conflicts when relevant fields change.

Do not update CANCELLED/NO_SHOW history as though the reservation never had its prior state.

---

## 19. Reservation Cancellation

Implement explicit cancellation.

Cancellation should:

```text
set reservation status CANCELLED
record cancelled_at / actor
update Guest Party status appropriately
release active planned table assignments/holds
append Party status history
```

Do not delete the reservation.

Cancellation of a reservation after actual seating should be disallowed or handled by an explicit exception; do not use cancellation to undo a real Table Session.

---

## 20. Reservation Check-In

Implement:

```text
markReservationCheckedIn
```

or equivalent.

Conceptually:

```text
CONFIRMED
      -> CHECKED_IN
```

Record `checked_in_at`.

Update Guest Party status.

Arrival does not automatically create a Table Session unless an explicit seat operation is performed.

This keeps:

```text
CHECKED_IN but waiting for table
```

valid.

---

## 21. No-Show Handling

Implement an explicit Host/manager no-show operation. No automated job may mark reservations as no-show.

Conceptually:

```text
CONFIRMED
   -> NO_SHOW
```

Permit this transition only when `now >= reservation_at + reservation_post_grace_minutes`.

Record the no-show timestamp and actor, then release planned-table holds.

No-show must never undo actual seating, and no automated job may mark a reservation as no-show.

Host/manager records the operational outcome.

---

## 22. Reservation Completion

When a Reservation-linked Guest Party is seated and its Table Session eventually completes, the reservation/party lifecycle should be able to reach:

```text
COMPLETED
```

Do not create a fragile cross-domain trigger.

Use an explicit workflow/service orchestration when Table Session completion needs to update Guest Party/Reservation status.

Preserve Phase 5 Table Session domain ownership.

---

## 23. Waitlist Entries

Create:

```text
waitlist_entries
```

Conceptual fields:

```text
id                    UUID PK
guest_party_id        UUID FK
location_id           UUID FK
status                required
quoted_wait_minutes   integer nullable
added_at               TIMESTAMPTZ
notified_at            TIMESTAMPTZ nullable
seated_at              TIMESTAMPTZ nullable
removed_at             TIMESTAMPTZ nullable
created_by_user_id     UUID FK
notes                  nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Statuses:

```text
WAITING
NOTIFIED
TABLE_ASSIGNED
SEATED
CANCELLED
LEFT
```

Do not implement external SMS/email notification in Phase 6.

`NOTIFIED` means restaurant staff recorded that the party was notified/contacted.

Create `waitlist_table_assignments` as append-preserving planned selection history. `TABLE_ASSIGNED` records a host selection only; it creates no occupancy and may later be replaced or ended.

---

## 24. Walk-In Workflow

Implement an explicit workflow:

```text
Walk-in arrives
    |
    v
Create Guest Party
    |
    +-- seat immediately if table chosen
    |
    +-- or create Waitlist Entry
```

Avoid duplicate Guest Party creation if a reservation party is moved onto the waitlist due to an unavailable table.

One Guest Party should represent the same group through arrival/waiting/seating.

---

## 25. Waitlist Add Workflow

Validate:

- Party size > 0.
- Location valid.
- Guest Party not already in incompatible terminal state.
- Avoid duplicate active Waitlist Entries for the same Guest Party.

Set initial status `WAITING` and append Party status history.

Quoted wait is an operational estimate, not a promise.

---

## 26. Quoted Wait Time

Allow staff to record/edit:

```text
quoted_wait_minutes
```

Initial Phase 6 may support manual quotes plus a deterministic recommendation helper.

Do not pretend to provide accurate predictive wait-time AI.

If an estimated wait is calculated, base it only on available operational data and present it as an estimate.

---

## 27. Wait-Time Recommendation

Optional but recommended deterministic helper:

```text
current active Table Sessions
+ table capacities
+ party sizes
+ seated elapsed times
+ configured default table-turn duration
+ reservation holds
    |
    v
estimated wait range/minutes
```

Keep this conservative and explainable.

Do not use an LLM or machine-learning forecast.

Manager/host may replace the suggested quote.

---

## 28. Notify Waitlist Party

Implement explicit transition:

```text
WAITING -> NOTIFIED
```

Record:

```text
notified_at
actor if appropriate
```

No external communication is sent by Phase 6 unless an existing notification capability already exists and is explicitly approved.

The application records the operational status only.

---

## 29. Waitlist Cancellation / Left

Support explicit outcomes:

```text
CANCELLED
LEFT
```

Use `LEFT` when the party abandons the wait.

Use `CANCELLED` for an explicit cancellation/removal where appropriate.

Do not delete historical Waitlist Entries.

---

## 30. Table Recommendation Service

Create a deterministic Restaurant/Reservation query/service that recommends physical tables for a Guest Party.

Inputs include:

```text
party size
Location
Restaurant Area preference when provided
Phase 5 table condition
Phase 5 occupancy
active reservation holds
capacity
planned reservation conflicts
combined-table possibilities
```

Output should be a ranked recommendation list, not an automatic seating action.

The host remains responsible for selecting the table(s).

---

## 31. Recommendation Ranking

Initial ranking should be simple and deterministic.

Recommended principles:

1. Only eligible tables/sets first.
2. Prefer smallest adequate capacity to reduce wasted seating capacity.
3. Prefer single table over combined tables when both satisfy the party appropriately.
4. Respect requested Restaurant Area if supplied.
5. Avoid active reservation holds for unrelated parties.
6. Use stable table-number/UUID tie-breaking.

Do not optimize across waiter compensation or restricted HR data.

---

## 32. Combined-Table Recommendations

Support combinations for parties too large for one table.

Avoid combinatorial explosion.

Initial constraints should keep search practical, for example:

```text
maximum 3 tables in a recommended combination
same Restaurant Area
only CLEAN, physically unoccupied, active tables
no active reservation hold conflict
```

Prefer the fewest physical tables needed.

Do not physically combine/configure tables until the Phase 5 seat operation commits.

---

## 33. Recommendation Does Not Reserve

Generating or displaying a recommendation must not create occupancy or table-session membership.

Unless the user explicitly assigns planned reservation tables, a recommendation is ephemeral.

Do not create hidden holds merely because a host viewed a suggested table.

---

## 34. Extend Table Sessions with Guest Party Link

Add the Phase 6 relationship from `table_sessions` to `guest_parties`.

Use a schema/migration approach consistent with existing Phase 5 history.

Desired lifecycle:

```text
Guest Party 1 -> 0..1 active Table Session
```

Historical Guest Parties may have completed sessions.

Ensure one Guest Party cannot accidentally be seated in two simultaneous active Table Sessions.

Use DB/service concurrency protection appropriate to the architecture.

---

## 35. Seat Reservation Party

Extend/orchestrate the Phase 5 seat-party workflow.

Conceptually:

```text
Reservation Guest Party CHECKED_IN/eligible
      |
      v
Host selects actual Table(s)
      |
      +-- actual tables may differ from planned tables
      +-- Phase 5 seating checks
      +-- reservation-hold checks for other parties
      |
      v
BEGIN
Create/attach Table Session to Guest Party
Create actual table memberships
Update Reservation -> SEATED
Update Guest Party -> SEATED
Release/end reservation planning rows as appropriate
Append status history
COMMIT
```

Do not falsify historical planned-table records when actual seating differs.

---

## 36. Seat Waitlist Party

Implement orchestration:

```text
WAITING/NOTIFIED Waitlist Entry
      |
      v
Host selects Table(s)
      |
      v
Phase 5 seating workflow
      |
      v
Table Session linked to Guest Party
Waitlist -> SEATED
Guest Party -> SEATED
seated_at recorded
```

All status/session changes should commit atomically.

Do not allow the same active Waitlist Entry to be seated twice concurrently.

---

## 37. Seat Walk-In Immediately

Support:

```text
Create Guest Party
      |
      v
Seat immediately through Phase 5 workflow
      |
      v
Guest Party -> SEATED
Table Session linked
```

A Waitlist Entry is not required when the walk-in is seated immediately.

---

## 38. Planned vs Actual Table History

Preserve both:

```text
Reservation planned Table 10
Actual Table Session used Tables 12 + 13
```

Do not rewrite planned history to match actual seating.

This distinction will be valuable later for operational analysis.

---

## 39. Reservation Hold Release

Active hold should cease when appropriate, including as applicable:

```text
Reservation CANCELLED
Reservation NO_SHOW
Reservation SEATED
planned table assignment removed
hold/grace interval naturally expires
```

Do not leave stale holds blocking tables indefinitely.

Centralize hold-state calculation.

---

## 40. Reservation Conflict Query

Create a purpose-built service/query for conflicts.

It should explain:

```text
which reservation conflicts
which physical table(s)
which time interval overlaps
whether capacity/combination is insufficient
```

Do not expose guest private-contact details unnecessarily when showing conflict summaries.

---

## 41. Host Reservation View

Create responsive views for:

```text
Today's Reservations
Upcoming Reservations
Checked-in parties
Cancelled/No-show states where operationally useful
```

Display:

```text
time
guest name
party size
status
planned table(s)
actual seating when seated
special request indicator
```

Do not create a consumer-facing reservation website.

---

## 42. Reservation Create/Edit UI

Authorized staff should be able to:

```text
create reservation
edit time/party/contact/duration/notes
assign/reassign planned table(s)
view planning conflicts
cancel
mark checked in
mark no-show
seat
```

Use optimistic concurrency and real server-side validation.

---

## 43. Waitlist UI

Create an operational host waitlist view.

Display:

```text
party name
party size
time added
elapsed wait
quoted wait
status
area preference if supported
table recommendation summary
```

Actions:

```text
add walk-in
edit quote
mark notified
seat
cancel/remove/left
```

Make the UI touch friendly.

---

## 44. Unified Host Workspace

Where practical, enhance the Phase 5 host/floor workspace so staff can move among:

```text
Floor
Reservations
Waitlist
```

Do not combine all business logic into one giant React component.

Each domain operation remains server/service driven.

---

## 45. Reservation Hold Indicators on Floor

Floor status may display near-term reservation planning information such as:

```text
Reserved at 7:00 PM
Hold begins 6:45 PM
```

Do not label such a table `OCCUPIED` until an actual Table Session exists.

Use a distinct visual indicator like `Reserved Soon` or `Reservation Hold`.

---

## 46. Permissions

Use or extend the central permission catalog.

Expected capabilities include concepts such as:

```text
reservations.view
reservations.manage
reservations.override-hold
waitlist.view
waitlist.manage
waitlist.notify
waitlist.seat
```

Align names to existing codes and avoid duplicates.

The Host role should receive normal reservation/waitlist operational permissions but not manager override/security/configuration capabilities unless explicitly intended.

---

## 47. Reservation Hold Override

An authorized manager override may allow seating an unrelated party at a table under an active reservation hold.

Requirements:

```text
explicit permission
explicit reason
actor
occurred_at
```

This override affects only reservation planning protection.

It does not bypass:

```text
DIRTY table
OUT_OF_SERVICE
active physical occupancy
inactive table
capacity rules unless separate capacity override
location/organization constraints
server qualification
```

Do not create a generic bypass-all-rules operation.

---

## 48. Concurrency

Use optimistic concurrency for:

```text
guest_parties
reservations
waitlist_entries
```

Use transaction/database-level protection for critical transitions such as:

```text
seat reservation party
seat waitlist party
prevent duplicate active Table Sessions for one Guest Party
prevent duplicate seating of one Waitlist Entry
planned-table assignment updates when conflicting
```

Stale host screens must produce conflicts rather than silently overwrite newer decisions.

---

## 49. Seat-Party Transaction Boundary

Cross-domain seating from Reservation/Waitlist must use one PostgreSQL transaction across the relevant Restaurant and Reservations operations where possible.

Conceptually:

```text
BEGIN
Validate Guest Party state/version
Validate Reservation/Waitlist state/version
Invoke Phase 5 seating operations with same tx
Create Table Session / memberships
Update Guest Party
Update Reservation or Waitlist
Append Party status history
COMMIT
```

Any failure returns the system to the prior consistent state.

---

## 50. Avoid External Calls in Transactions

Do not send SMS/email or call external reservation systems inside seating/reservation DB transactions.

Phase 6 has no external notification integration.

Future notification behavior should use the architecture's outbox/event path when that infrastructure is implemented.

---

## 51. Unit Tests: Reservation Holds

Test:

```text
walk-in hold immediately before start -> inactive
walk-in hold at start -> active
walk-in hold during interval -> active
walk-in hold at end -> inactive
CANCELLED -> no active hold
NO_SHOW -> no active hold
SEATED -> planned hold no longer blocks as reservation planning
```

Test the reservation planning conflict interval separately, including its expected-duration extension and half-open start/end boundaries. Both interval calculations must read their durations from Location settings.

---

## 52. Unit Tests: Reservation Conflicts

Test:

```text
same table + overlapping reservation planning conflict intervals -> conflict
same table + adjacent half-open intervals -> allowed
cancelled reservation -> non-blocking
combined planned tables -> each table checked
party exceeds planned capacity -> rejected/warning according to policy
more than three recommended tables -> excluded
combined recommendation crossing Restaurant Areas -> excluded
```

Include cross-midnight reservation duration where practical.

---

## 53. Unit Tests: Table Recommendations

Test deterministic ranking:

```text
smallest adequate table preferred
single table preferred over combination
held table excluded for unrelated walk-in
DIRTY excluded
OUT_OF_SERVICE excluded
occupied excluded
combined tables suggested when necessary
stable tie-break
```

Test reason/explanation codes.

---

## 54. Unit Tests: Wait Quote Helper

If automatic quote recommendation is implemented, test:

```text
no suitable table available -> positive estimated wait
suitable table available now -> zero/immediate recommendation
reservation holds influence estimate
manual quoted wait can differ from suggestion
```

Do not overstate precision.

---

## 55. Integration Tests: Reservation Creation

Test:

```text
create reservation without planned table
create with valid planned table
combined planned tables
capacity validation
planning conflict rejection
cross-location assignments rejected
optimistic concurrency
unauthorized creation denied
```

---

## 56. Integration Tests: Reservation Lifecycle

Test:

```text
CONFIRMED -> CHECKED_IN
CONFIRMED -> CANCELLED
CONFIRMED -> NO_SHOW only at/after the configured post-grace boundary
NO_SHOW before post-grace boundary -> denied
NO_SHOW for a non-CONFIRMED state -> denied
CHECKED_IN -> SEATED
SEATED -> COMPLETED through session lifecycle orchestration
status history appended
planned hold released appropriately
invalid transitions denied
```

---

## 57. Integration Tests: Hold Override

Test:

```text
ordinary Host blocked by active hold
manager with override permission + reason allowed
missing reason denied
override does not bypass DIRTY
redirect/override does not cancel reservation automatically
provenance stored
```

---

## 58. Integration Tests: Waitlist

Test:

```text
create walk-in Guest Party + WAITING entry
prevent duplicate active Waitlist Entry
update quoted wait
WAITING -> NOTIFIED
WAITING/NOTIFIED -> SEATED
CANCELLED/LEFT terminal behavior
status timestamps/history
self-consistent party status
```

---

## 59. Integration Tests: Reservation Seating

Required scenario:

```text
Reservation planned for Table T01
Guest arrives
T01 unavailable or host chooses alternative
Host seats Guest Party at T02 + T03
        |
        v
Reservation planned history still says T01
Actual Table Session uses T02 + T03
Reservation/Party status SEATED
```

This proves planned vs actual separation.

---

## 60. Integration Tests: Concurrent Seating

Test:

```text
same Guest Party seating requested concurrently
        |
        v
one active Table Session only
```

Also preserve the Phase 5 physical-table race guarantee.

Waitlist seating must not permit the same Waitlist Entry to create two sessions.

---

## 61. E2E: Reservation Workflow

Playwright scenario:

```text
Host logs in
 -> creates reservation
 -> optionally plans table
 -> checks Guest in
 -> seats at suggested/selected table
 -> floor shows actual Table Session
```

Verify planned and actual tables may differ without history corruption.

---

## 62. E2E: Waitlist Workflow

Scenario:

```text
Host adds walk-in to Waitlist
 -> quote shown/entered
 -> mark notified
 -> select recommended table
 -> seat
 -> Waitlist entry SEATED
 -> Floor shows occupied Table Session
```

---

## 63. E2E: Reservation Hold

Scenario:

```text
Upcoming reservation creates hold on planned table
ordinary Host attempts unrelated walk-in seating
 -> denied with clear reason
manager override with reason
 -> allowed when all Phase 5 hard checks pass
```

Do not use a physically occupied table for this test; it must prove reservation hold is distinct from occupancy.

---

## 64. E2E: Cancellation/No-Show

Test at least one lifecycle:

```text
reservation cancelled/no-show
 -> planning hold released
 -> table becomes normally selectable if otherwise available
```

---

## 65. Seed Data

Do not seed permanent fake reservations, waitlist entries, or Guest Parties as ordinary POC business data.

Use isolated test fixtures for operational records.

Phase 6 seed may update stable reservation settings only.

Add location settings for reservation hold windows if they do not already exist:

```text
reservation_pre_hold_minutes = 15
reservation_post_grace_minutes = 15
```

Keep existing `default_reservation_duration_minutes` as the default for new reservations where already present.

Seed/settings changes must be idempotent.

---

## 66. Migration Requirements

Generate and review Phase 6 migration(s).

Verify:

```text
Existing Phase 5 DB
 -> Phase 6 migrations
 -> success
```

and:

```text
Empty test DB
 -> all migrations Phase 1 through Phase 6
 -> expected schema
```

Second clean generation must report no unexplained drift.

Do not rewrite old migrations solely to remove documented non-fatal notices.

---

## 67. Reset/Seed Regression

Verify on safe/disposable DB:

```text
npm run db:reset
npm run db:seed
```

All configuration through Phase 6 reconstructs without duplicate stable rows.

Reset remote/production guards remain intact.

---

## 68. Prior-Phase Regression

Preserve:

```text
Phase 1 DB foundation
Phase 2 auth/RBAC
Phase 3 Employee/HR privacy
Phase 4 Scheduling/availability
Phase 5 seating concurrency and table lifecycle
```

Do not weaken Phase 5 table occupancy protection for reservation planning.

Do not load restricted HR data into recommendations/reservations.

---

## 69. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies must remain clean or new findings require explicit review.

Do not add third-party messaging, CRM, external reservation, or AI packages in Phase 6.

Preserve DEV-001 unless dependency changes justify reevaluation.

---

## 70. Documentation Updates

Document:

- Guest Party concept
- Reservation vs Table Session distinction
- Reservation planned table vs actual table distinction
- Reservation lifecycle
- 15-minute pre-hold and 15-minute post-grace policy
- Reservation conflict interval rules
- Reservation hold override
- Waitlist lifecycle
- Quoted wait semantics
- NOTIFIED meaning
- Table recommendation ranking
- Combined-table recommendation limits
- Reservation seating orchestration
- Waitlist seating orchestration
- Phase 9 Order extension remains Table Session based

---

## 71. Phase 6 Validation Checklist

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

Safe reset regression should also be performed in the established disposable/safe environment.

Verify:

```text
PostgreSQL health                     PASS
/api/health                           PASS
schema generation/drift               PASS / NONE
empty DB reconstruction               PASS
seed idempotency                      PASS
Guest Party lifecycle                 PASS
Reservation lifecycle                 PASS
Reservation planned tables            PASS
Planning conflicts                    PASS
Hold-window calculation               PASS
Hold != occupancy                     PASS
Hold override authorization           PASS
Waitlist lifecycle                    PASS
Quoted wait                           PASS
Notification recording                PASS
Table recommendations                 PASS
Combined-table recommendations        PASS
Reservation -> seating                PASS
Waitlist -> seating                   PASS
planned vs actual history             PASS
Guest Party active-session uniqueness PASS
concurrent seating                    PASS
Phase 5 seating regressions           PASS
prior-phase regressions               PASS
production dependency audit           CLEAN
```

---

## 72. Phase 6 Deliverables

Phase 6 should leave:

```text
✓ guest_parties
✓ reservations
✓ reservation_table_assignments
✓ waitlist_entries
✓ waitlist_table_assignments
✓ party_status_history
✓ reservation_hold_overrides
✓ Table Session Guest Party linkage

✓ reservation creation/edit/cancel
✓ check-in (`CHECKED_IN`)
✓ no-show
✓ reservation completion linkage
✓ planned table assignment
✓ reservation conflict detection
✓ reservation hold calculation
✓ manager hold override

✓ walk-in creation
✓ waitlist lifecycle
✓ quoted waits
✓ recorded notification
✓ waitlist seating

✓ deterministic table recommendation
✓ combined-table recommendation
✓ planned tables distinct from actual seating
✓ reservation-to-table-session workflow
✓ waitlist-to-table-session workflow
✓ concurrency protection

✓ responsive Reservations/Waitlist/Host UI
✓ Phase 6 permissions
✓ location hold settings

✓ unit tests
✓ PostgreSQL integration tests
✓ Playwright E2E tests
✓ Phase 0-5 regressions green
✓ production audit clean
✓ no Phase 7+ domains prematurely added
```

---

## 73. Phase 6 Definition of Done

Phase 6 is complete when an authorized Host can perform:

```text
Reservation
  -> plan future tables optionally
  -> Guest arrives
  -> choose actual available table(s)
  -> seat
  -> Table Session linked to Guest Party
```

and:

```text
Walk-in
  -> Guest Party
  -> Waitlist
  -> quote/notified
  -> recommended/selected table(s)
  -> seat
  -> Table Session linked
```

The system proves:

- Reservations do not create physical occupancy.
- Reservation holds are distinct from occupancy.
- Planned tables may differ from actual seated tables without history loss.
- An ordinary Host cannot bypass an active reservation hold for an unrelated party.
- Manager reservation-hold overrides require explicit permission and reason.
- Hold override cannot bypass Phase 5 hard seating constraints.
- Waitlist and reservation seating reuse Phase 5 concurrency-safe Table Session behavior.
- One Guest Party cannot be seated into two simultaneous active sessions.
- Table recommendations are deterministic suggestions, not automatic seating.
- Reservation/Waitlist history is preserved.
- No external messaging integration is required.
- Database reconstruction requires no manual SQL.
- Prior-phase regressions remain green.

---

## 74. Required Phase 6 Completion Report

Provide:

```text
PHASE 6 COMPLETION REPORT

Environment
- Node:
- npm:
- Next.js:
- PostgreSQL:
- Drizzle ORM:
- Drizzle Kit:

Reservation Schema
- guest_parties: PASS / FAIL
- reservations: PASS / FAIL
- reservation_table_assignments: PASS / FAIL
- reservation_hold_overrides: PASS / FAIL
- waitlist_entries: PASS / FAIL
- waitlist_table_assignments: PASS / FAIL
- party_status_history: PASS / FAIL
- Table Session Guest Party link: PASS / FAIL

Guest Party
- Current status: PASS / FAIL
- Append status history: PASS / FAIL
- Contact-data protection: PASS / FAIL
- Active Table Session uniqueness: PASS / FAIL

Reservations
- Approved Reservation status set (`PENDING`, `CONFIRMED`, `CHECKED_IN`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`): PASS / FAIL
- Creation: PASS / FAIL
- Edit/version concurrency: PASS / FAIL
- Cancellation: PASS / FAIL
- Check-in (`CONFIRMED -> CHECKED_IN`): PASS / FAIL
- `PENDING` lifecycle state: PASS / FAIL
- Manual no-show after configured post-grace: PASS / FAIL
- No-show actor/timestamp and planned-hold release: PASS / FAIL
- Completion linkage: PASS / FAIL
- Planned tables: PASS / FAIL
- Combined planned tables: PASS / FAIL
- Capacity validation: PASS / FAIL
- Planning conflict detection: PASS / FAIL

Reservation Holds
- Pre-hold setting: PASS / FAIL
- Post-grace setting: PASS / FAIL
- Reservation planning conflict interval: PASS / FAIL
- Walk-in hold interval: PASS / FAIL
- Half-open interval boundaries: PASS / FAIL
- PENDING reservations block planned-table conflicts and active holds: PASS / FAIL
- Hold distinct from occupancy: PASS / FAIL
- Ordinary Host blocked: PASS / FAIL
- Manager override permission: PASS / FAIL
- Override reason/provenance: PASS / FAIL
- Override does not bypass hard seating rules: PASS / FAIL
- Hold release lifecycle: PASS / FAIL

Waitlist
- Approved Waitlist status set (`WAITING`, `NOTIFIED`, `TABLE_ASSIGNED`, `SEATED`, `CANCELLED`, `LEFT`): PASS / FAIL
- `TABLE_ASSIGNED` does not create occupancy: PASS / FAIL
- Add walk-in: PASS / FAIL
- Duplicate active entry prevention: PASS / FAIL
- Quoted wait: PASS / FAIL
- WAITING -> NOTIFIED: PASS / FAIL
- Seat: PASS / FAIL
- CANCELLED/LEFT: PASS / FAIL
- Notification is recorded-only: PASS / FAIL

Recommendations
- Deterministic ranking: PASS / FAIL
- Smallest adequate capacity: PASS / FAIL
- Single table preference: PASS / FAIL
- Combined tables (maximum three, same Restaurant Area): PASS / FAIL
- Reservation holds respected: PASS / FAIL
- Dirty/out-of-service/occupied excluded: PASS / FAIL
- Stable tie-break: PASS / FAIL

Seating Integration
- Reservation -> Table Session: PASS / FAIL
- Waitlist -> Table Session: PASS / FAIL
- Immediate walk-in -> Table Session: PASS / FAIL
- Planned vs actual table history: PASS / FAIL
- Atomic status/session writes: PASS / FAIL
- Concurrent duplicate seating prevented: PASS / FAIL
- Phase 5 physical table race protection preserved: PASS / FAIL

Authorization
- reservations.view: PASS / FAIL
- reservations.manage: PASS / FAIL
- reservations.override-hold: PASS / FAIL
- waitlist.view/manage: PASS / FAIL
- direct unauthorized API denied: PASS / FAIL
- cross-location authorization: PASS / FAIL

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
- Phase 5 Restaurant/Seating: PASS / FAIL
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

Business Domains Created Beyond Phase 6
- NONE expected

Created / Modified
- Summarize schema, migrations, Reservation/Waitlist modules/workflows, permissions, UI, settings, tests, and docs.

Architecture Deviations
- None / describe

Outstanding Phase 6 Issues
- None / describe and blocking status

Phase 7 Readiness
- READY / NOT READY
```

---

## 75. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-6-Reservations-Waitlist.md`, start a fresh Copilot chat and use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 6 implementation plans completely. Treat `README.md` as the architectural source of truth. Derive current state from the repository, migrations, tests, and documentation rather than relying on previous chat history.
>
> Review the completed Phase 0 through Phase 5 implementation before modifying files. Implement Phase 6 only: Guest Parties, Reservations, planned reservation table assignments, reservation lifecycle, planning conflicts, reservation hold rules and explicit manager overrides, walk-ins, Waitlist, quoted waits, recorded notification status, deterministic table and combined-table recommendations, Guest Party linkage to Phase 5 Table Sessions, Reservation-to-seating and Waitlist-to-seating workflows, permissions, responsive Host/Reservations/Waitlist UI, migrations, settings, and required automated tests.
>
> Preserve these boundaries: Reservation planning is not physical occupancy; only active Phase 5 Table Sessions establish table occupancy. Planned reservation tables may differ from actual seated tables and both histories must be preserved. Recommendations do not reserve or occupy tables. Takeout is not a physical restaurant table. Orders do not exist yet and must not be added in Phase 6.
>
> Use the approved structured Location settings `reservation_pre_hold_minutes = 15` and `reservation_post_grace_minutes = 15`. Reservation planning conflicts use `[reservation_at - pre_hold, reservation_at + expected_duration + post_grace)`; walk-in holds use `[reservation_at - pre_hold, reservation_at + post_grace)`. Both intervals are half-open and must be calculated separately. An ordinary Host may not seat an unrelated walk-in at a table under an active hold. A manager with explicit override permission may do so only with a reason, and that override never bypasses Phase 5 hard seating constraints.
>
> Reuse Phase 5 concurrency-safe seating through shared transactions so a Guest Party, Reservation, or Waitlist entry cannot produce duplicate active seating. Preserve all Phase 1-5 database, migration, transaction, RBAC, HR privacy, scheduling, seating, reset-safety, and DEV-001 decisions.
>
> Use only the README Reservation states (`PENDING`, `CONFIRMED`, `CHECKED_IN`, `SEATED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`) and Waitlist states (`WAITING`, `NOTIFIED`, `TABLE_ASSIGNED`, `SEATED`, `CANCELLED`, `LEFT`). `TABLE_ASSIGNED` does not create occupancy; only a successfully committed Phase 5 Table Session does. No-show is manual only, for `CONFIRMED` reservations at or after the configured post-grace boundary, with actor/timestamp recorded and planned holds released; no-show never undoes actual seating. Limit combined-table recommendations to at most three tables in the same Restaurant Area.
>
> Before modifying files, inspect the repository and provide a concise Phase 6 execution plan. Follow the approved business policies in this document and stop only if a new material architecture conflict is discovered.
>
> After implementation, run the complete Phase 6 validation suite and provide the full Phase 6 Completion Report. Stop before changing approved architecture when a material conflict is discovered.

---

## Final Guardrail

Phase 6 plans and manages guest arrival while preserving Phase 5 as the source of truth for actual seating.

```text
Reservation / Waitlist
       |
       v
Guest Party
       |
       v
Host chooses actual Table(s)
       |
       v
Phase 5 Table Session
       |
       +-- Phase 9 Orders later
```

Do not collapse planned future table use into actual occupancy for implementation convenience.
