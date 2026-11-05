# Phase 4: Scheduling & Automatic Schedule Generation Implementation Plan

## Purpose

Phase 4 implements employee scheduling, availability, time-off, shift swaps, staffing requirements, manual schedule construction, publishing, and manager-controlled automatic draft schedule generation.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. `docs/Phase-0-Implementation-Plan.md`
5. `docs/Phase-1-Database-Foundation.md`
6. `docs/Phase-2-Organization-Authentication-RBAC.md`
7. `docs/Phase-3-Employees-HR.md`
8. This document

`README.md` remains the architectural source of truth.

Phase 4 must build on the completed Employee/HR model from Phase 3. Scheduling eligibility must rely on Employee status, Employee Location assignments, and Employee Position assignments. Application Security Roles must never substitute for Employee Positions.

---

## 1. Phase 4 Objectives

Implement the Scheduling domain:

```text
Employee
   |
   +-- Employee Locations
   +-- Employee Positions
   +-- Employment Status
   |
   v
Scheduling
   |
   +-- Availability
   +-- Availability Exceptions
   +-- Scheduling Preferences
   +-- Time Off Requests
   +-- Staffing Templates
   +-- Staffing Requirements
   +-- Scheduling Rules
   +-- Schedule Periods
   |      |
   |      +-- Shifts
   |             |
   |             +-- Shift Assignments
   |
   +-- Shift Swap Requests
   +-- Schedule Generation Runs
          |
          v
   Automatic Draft Generator
```

Phase 4 must deliver:

- Schedule periods
- Manual shift creation and assignment
- Employee recurring availability
- Employee availability exceptions
- Scheduling preferences
- Time-off requests and approval
- Shift-swap workflow
- Staffing templates and requirements
- Location scheduling rules
- Draft schedule generation
- Fill-open-shifts generation mode
- Hard scheduling constraints
- Soft candidate scoring
- Coverage/conflict analysis
- Explainable generated assignments
- Manager overrides
- Schedule publishing
- Generation history
- Permission-controlled scheduling UI
- Comprehensive unit, integration, and E2E tests

---

## 2. Scope Boundary

Do not implement these later-phase domains during Phase 4:

```text
restaurant physical tables
seating sessions
reservations
waitlist
menu
recipes
inventory
purchasing
orders
kitchen/bar fulfillment
settlements
full reporting dashboards
full audit domain
```

Do not implement payroll or wage payment.

Do not implement demand forecasting from sales or reservations yet.

Do not use an LLM to generate schedules.

Do not automatically publish a generated schedule.

Do not treat a Security Role as proof that an Employee is qualified to work a restaurant Position.

---

## 3. Critical Scheduling Eligibility Boundary

Scheduling qualification comes from Phase 3 HR data:

```text
Employee ACTIVE
    +
Employee eligible at Location
    +
Employee has required Employee Position
    +
Position assignment effective for shift date
```

It does **not** come from:

```text
User Security Role
```

Required test:

```text
User has BARTENDER Security Role
Employee does not hold BARTENDER Position
        |
        v
Employee is NOT eligible for Bartender shift
```

And the inverse:

```text
Employee holds BARTENDER Position
User lacks BARTENDER Security Role
        |
        v
Employee may still be scheduled as Bartender
```

Software authorization controls who may manage schedules. Employee Positions control who may work shifts.

---

## 4. Review Existing Foundation Before Changes

Before modifying files, inspect and confirm:

- Phase 0 through Phase 3 validations remain green.
- Employee status model is understood.
- Employee-location effective dating is understood.
- Employee-position effective dating is understood.
- Terminated employee behavior is understood.
- Phase 2 location-aware RBAC is understood.
- Existing scheduling permissions seeded in Phase 2 are understood.
- Shared transaction context is understood.
- Optimistic concurrency pattern is understood.
- Exact date/timestamp conventions are understood.
- Seed framework is understood.
- Test DB isolation and reset safeguards remain intact.
- `DEV-001` remains tracked.

Before coding, provide a concise Phase 4 execution plan based on the repository's actual state.

---

## 5. Schedule Periods

Create:

```text
schedule_periods
```

Conceptual fields:

```text
id                UUID PK
location_id       UUID FK
name              required
start_date        DATE required
end_date          DATE required
status            required
published_at      TIMESTAMPTZ nullable
published_by_user_id UUID nullable FK
created_by_user_id UUID FK
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Initial statuses:

```text
DRAFT
PUBLISHED
ARCHIVED
```

Rules:

- `start_date <= end_date`.
- Schedule period belongs to one restaurant location.
- Avoid accidental overlapping published periods for the same location unless explicitly allowed by the domain rules.
- Only DRAFT schedules may be freely edited.
- Publishing is an explicit manager operation.
- Publishing records publisher and timestamp.
- Published schedules are not silently regenerated or destructively replaced.

---

## 6. Shifts

Create:

```text
shifts
```

A Shift represents a staffing requirement, not the employee assignment itself.

Conceptual fields:

```text
id                    UUID PK
schedule_period_id    UUID FK
location_id           UUID FK
position_id           UUID FK
restaurant_area_id    UUID nullable FK
shift_date            DATE required
start_at               TIMESTAMPTZ or local-time/date representation selected consistently
end_at                 TIMESTAMPTZ or local-time/date representation selected consistently
required_employee_count integer default 1
course_or_station_note nullable
notes                  nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

The shift design must correctly support shifts that cross midnight.

Do not independently calculate restaurant business date by truncating timestamps.

Validate that the Position belongs to the relevant Organization and the location/area context is consistent.

---

## 7. Shift Assignments

Create:

```text
shift_assignments
```

Conceptual fields:

```text
id                    UUID PK
shift_id              UUID FK
employee_id           UUID FK
assignment_source     required
assigned_by_user_id   UUID nullable FK
assigned_at           TIMESTAMPTZ
notes                  nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                INTEGER default 1
```

Assignment sources:

```text
MANUAL
GENERATED
SHIFT_SWAP
```

Required uniqueness should prevent the same employee from being assigned twice to the same shift.

Generated assignments become ordinary assignments with `GENERATED` provenance. Do not create a parallel generated-assignment system.

---

## 8. Assignment Eligibility Rules

Before creating a shift assignment, validate:

```text
Employee status allows scheduling
Employee belongs to schedule organization
Employee eligible at shift location
Employee Position effective at shift location/date
Employee not on approved time off
Employee availability permits assignment where availability is mandatory
No overlapping assignment
Applicable hard scheduling limits
```

These validations apply to both manual and generated assignments.

A manager override may be supported only for rules explicitly categorized as overridable. Hard identity/qualification and overlapping-shift protections should not be bypassed casually.

Document which constraints are hard and which may be manager-overridden.

---

## 9. Recurring Employee Availability

Create:

```text
employee_availability
```

Conceptual fields:

```text
id              UUID PK
employee_id     UUID FK
location_id     UUID nullable FK
day_of_week     required
start_time      required
end_time        required
availability_type required
effective_from  DATE required
effective_to    DATE nullable
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
version         INTEGER default 1
```

Availability types may include:

```text
AVAILABLE
UNAVAILABLE
```

Approved availability eligibility policy:

- An employee is eligible only when applicable `AVAILABLE` availability covers the entire shift.
- Missing availability is ineligible; never assume an employee is available because no restriction was entered.
- Evaluate exceptions before recurring availability. An applicable exception overrides recurring availability for the portion of the shift it covers; evaluate recurring availability for the remaining portions.
- An applicable `UNAVAILABLE` interval makes the employee ineligible. A partial `AVAILABLE` window does not cover a longer shift.
- If no applicable exception or recurring record exists for the shift, return `AVAILABILITY_NOT_CONFIGURED` and treat the employee as ineligible. Keep this distinct from an explicit `UNAVAILABLE` result and from configured availability that does not cover the entire shift.
- Apply the same availability evaluator to manual assignments, automatic generation, Fill Open Shifts, and shift-swap acceptance. There is no manager override; correct or configure the availability data before assigning the employee.

Availability exceptions take precedence over recurring availability. For an exception that covers only part of a shift, its result applies to that interval and recurring availability must cover the rest of the shift.

The model must support availability windows that cross midnight if required.

Do not conflate availability with scheduling preference.

---

## 10. Availability Exceptions

Create:

```text
employee_availability_exceptions
```

Conceptual fields:

```text
id                UUID PK
employee_id       UUID FK
location_id       UUID nullable FK
exception_date    DATE required
start_time        nullable
end_time          nullable
availability_type required
reason            nullable
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

Examples:

```text
Normally available Tuesday evenings
but unavailable Tuesday Oct 20
```

or:

```text
Normally unavailable Sunday
but available Oct 25 from 4 PM to close
```

Exception logic overrides recurring availability for the applicable day/time context.

Test precedence explicitly.

---

## 11. Scheduling Preferences

Create:

```text
employee_scheduling_preferences
```

Conceptual fields may include:

```text
id                        UUID PK
employee_id               UUID FK
location_id               UUID nullable FK
target_hours_per_week     NUMERIC or fixed precision appropriate for hours nullable
minimum_hours_per_week    nullable
maximum_hours_per_week    nullable
maximum_days_per_week     nullable
maximum_consecutive_days  nullable
preferred_shift_start     nullable
preferred_shift_end       nullable
prefer_weekends           nullable
prefer_opening            nullable
prefer_closing            nullable
created_at                TIMESTAMPTZ
updated_at                TIMESTAMPTZ
version                   INTEGER default 1
```

Preferences are soft criteria unless a field is explicitly mapped to a hard scheduling rule.

Availability and preference remain separate concepts.

---

## 12. Time-Off Requests

Create:

```text
time_off_requests
```

Conceptual fields:

```text
id                    UUID PK
employee_id           UUID FK
start_at               TIMESTAMPTZ or date/time model appropriate to request
end_at                 TIMESTAMPTZ
request_type           required
status                 required
reason                 nullable
employee_note          nullable
manager_note           nullable
requested_at           TIMESTAMPTZ
reviewed_by_user_id    UUID nullable FK
reviewed_at            TIMESTAMPTZ nullable
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
version                 INTEGER default 1
```

Statuses:

```text
PENDING
APPROVED
DENIED
CANCELLED
```

Approved time off is a hard scheduling conflict.

Pending time off may produce a warning but should not automatically be treated as approved unless explicitly configured.

---

## 13. Time-Off Workflow

Implement explicit commands/services for:

```text
requestTimeOff
approveTimeOff
denyTimeOff
cancelTimeOff
```

Rules:

- Employee must belong to the organization/location context.
- Employee may create their own request where application access allows.
- Manager approval requires scheduling/management permission.
- Approved time off should detect existing assignments and either block approval or require explicit conflict resolution according to documented behavior.
- Do not silently delete assigned shifts.
- Changes are history-bearing business operations and should remain ready for future auditing.

Recommended POC behavior: approving time off that conflicts with an existing assignment should fail with a clear conflict and require the manager to resolve the assignment before approval.

---

## 14. Shift Swap Requests

Create:

```text
shift_swap_requests
```

Conceptual fields:

```text
id                        UUID PK
shift_assignment_id       UUID FK
requesting_employee_id    UUID FK
target_employee_id        UUID nullable FK
status                    required
reason                    nullable
requested_at              TIMESTAMPTZ
accepted_at               nullable
approved_by_user_id       nullable UUID FK
approved_at               nullable TIMESTAMPTZ
created_at                TIMESTAMPTZ
updated_at                TIMESTAMPTZ
version                   INTEGER default 1
```

Statuses may include:

```text
PENDING
ACCEPTED
APPROVED
DENIED
CANCELLED
COMPLETED
```

Do not implement complicated marketplace/open-bid shift swapping unless explicitly required.

---

## 15. Shift Swap Validation

Before completing a swap, validate the receiving employee exactly as if assigning them manually:

```text
ACTIVE employee
eligible location
correct Position
availability
approved time off
no overlap
hard hour/day constraints
```

Completing the swap should transactionally:

```text
remove/end original assignment as designed
create replacement assignment with source SHIFT_SWAP
update swap status
preserve history/provenance
```

Do not silently mutate assignment ownership without tracking the swap operation.

---

## 16. Staffing Templates

Create:

```text
staffing_templates
```

Conceptual fields:

```text
id              UUID PK
location_id     UUID FK
name            required
description     nullable
active          BOOLEAN default TRUE
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
version         INTEGER default 1
```

Examples:

```text
Standard Monday
Standard Friday
Standard Saturday
Holiday
Special Event
```

Templates define staffing demand, not specific employees.

---

## 17. Staffing Template Requirements

Create:

```text
staffing_template_requirements
```

Conceptual fields:

```text
id                    UUID PK
staffing_template_id  UUID FK
day_of_week           required
position_id           UUID FK
restaurant_area_id    UUID nullable FK
start_time            required
end_time              required
required_employee_count integer required
priority              integer/default
created_at             TIMESTAMPTZ
updated_at             TIMESTAMPTZ
```

Example:

```text
Friday Dinner
Server       6
Bartender    3
Host         2
Cook         4
```

Validate Position/Area belong to the appropriate organization/location context.

---

## 18. Generate Shifts from Staffing Template

Support an explicit manager operation that uses a staffing template to create draft Shifts for a Schedule Period.

Conceptually:

```text
Schedule Period
     +
Staffing Template
     |
     v
Generate Required Shifts
```

This operation generates staffing shifts, not employee assignments.

It must be safe against accidental duplicate generation. Use an explicit mode or idempotency strategy to prevent duplicate shifts when invoked repeatedly.

Do not overwrite manager-edited shifts without explicit confirmation/mode.

---

## 19. Scheduling Rules

Create:

```text
scheduling_rules
```

Use structured fields for core known rules rather than an unrestricted JSON rules engine.

Conceptual fields may include:

```text
id                          UUID PK
location_id                 UUID FK
avoid_overtime              BOOLEAN
weekly_overtime_threshold   NUMERIC/fixed hours
minimum_rest_hours          NUMERIC/fixed hours nullable
maximum_days_per_week       integer nullable
maximum_consecutive_days    integer nullable
balance_weekend_shifts      BOOLEAN
balance_closing_shifts      BOOLEAN
prefer_target_hours         BOOLEAN
created_at                  TIMESTAMPTZ
updated_at                  TIMESTAMPTZ
version                     INTEGER default 1
```

Whether a rule is hard or soft must be explicit in the generator implementation.

Do not claim compliance with jurisdiction-specific labor law merely because configurable limits exist. Legal compliance remains a business configuration/responsibility unless explicitly implemented and validated later.

---

## 20. Manual Scheduling First

Before implementing automatic generation, complete and test manual scheduling.

Required workflow:

```text
Manager creates Schedule Period
        |
        v
Creates/imports Shifts
        |
        v
Assigns Employee
        |
        v
Eligibility validation
        |
        v
Coverage/conflict feedback
        |
        v
Manager edits schedule
        |
        v
Publish
```

Automatic generation must not be implemented on top of an unvalidated manual model.

---

## 21. Schedule Publishing

Implement an explicit transactionally safe publish operation.

Before publishing, validate at minimum:

```text
Schedule remains DRAFT
No invalid assignment conflicts
No unresolved hard eligibility violations
Version/concurrency still current
```

Publishing should:

```text
set status PUBLISHED
set published_at
set published_by_user_id
record any required publication metadata
emit future-ready notification/outbox behavior only if Phase 2/architecture already supports it cleanly
```

Do not introduce a new event infrastructure if it is reserved for a later phase and not yet implemented.

Do not automatically publish after generator execution.

---

## 22. Published Schedule Mutation

Define a deliberate policy.

Recommended POC behavior:

- Published schedule assignments are not freely overwritten like draft assignments.
- Authorized manager changes should use explicit schedule-change commands that preserve source/history context and can later support notifications/auditing.
- Do not silently revert a published schedule to DRAFT.

Keep the initial implementation manageable, but do not make published data indistinguishable from an editable draft.

---

## 23. Schedule Generation Runs

Create:

```text
schedule_generation_runs
```

Conceptual fields:

```text
id                        UUID PK
schedule_period_id        UUID FK
started_by_user_id        UUID FK
started_at                TIMESTAMPTZ
completed_at              nullable TIMESTAMPTZ
generation_mode           required
status                    required
rules_snapshot            JSONB or structured snapshot representation
created_assignment_count  integer
unfilled_shift_count      integer
warning_count             integer
created_at                TIMESTAMPTZ
```

Generation modes:

```text
GENERATE_DRAFT
FILL_OPEN_SHIFTS
```

Statuses:

```text
STARTED
COMPLETED
FAILED
```

The rules/settings snapshot exists for traceability, not as a replacement for structured scheduling rules.

Do not store secrets or excessive employee-sensitive data in the snapshot.

---

## 24. Generator Architecture

Keep the automatic generator isolated behind a clear interface, conceptually:

```text
ScheduleGenerator
  generate(input) -> ScheduleProposal
```

Suggested internal components:

```text
generator/
├── schedule-generator.ts
├── eligibility-filter.ts
├── constraint-engine.ts
├── candidate-scorer.ts
├── coverage-analyzer.ts
└── explanation-builder.ts
```

Exact filenames may differ.

The generator produces proposals/assignments for a DRAFT schedule. It never publishes.

Do not use an LLM for scheduling correctness.

---

## 25. Generator Input

The generator should consume a normalized domain input assembled by services/queries, including:

```text
Schedule Period
Shifts / open staffing slots
Existing assignments
Employee status
Employee location eligibility
Employee position eligibility
Recurring availability
Availability exceptions
Approved time off
Scheduling preferences
Scheduling rules
Historical/current assignment totals as required for scoring
```

Do not let the generator query random tables throughout its scoring loop if a normalized input model can be assembled first.

Keep pure decision logic independently unit-testable where practical.

---

## 26. Hard Constraints

Hard constraints disqualify a candidate.

At minimum:

```text
Employee must be schedulable/ACTIVE
Employee must be eligible at location
Employee must hold required Position at location/date
Employee must not be on approved time off
Employee must meet mandatory availability
Employee cannot have overlapping assigned shift
Employee cannot violate configured hard maximum limits
Shift assignment must remain inside valid Schedule Period/location context
```

Hard constraints must be shared between manual-assignment validation and automatic generation wherever possible so the two paths cannot disagree.

Do not copy/paste separate business logic for manual and automatic eligibility.

---

## 27. Soft Criteria

Soft criteria influence the candidate score but do not make the employee fundamentally ineligible.

Potential criteria:

```text
Move employee toward target weekly hours
Avoid overtime
Respect preferred shift times
Honor opening/closing preference
Balance weekend assignments
Balance closing assignments
Avoid excessive consecutive days
Prefer adequate rest between shifts
Distribute hours fairly
```

Use explicit constants/configuration for scoring weights rather than mysterious numbers scattered across the codebase.

Document the initial scoring weights.

---

## 28. Overtime Handling

Use configured scheduling rules and effective assignment hours.

The scheduling generator should calculate projected scheduled hours for the applicable week/context.

If overtime avoidance is a soft rule:

```text
candidate remains eligible
but receives a significant scoring penalty
```

If a location rule makes maximum hours a hard limit:

```text
candidate becomes ineligible
```

Do not calculate labor cost in Phase 4.

Do not use employee compensation to rank candidates.

Scheduling should not prefer cheaper employees merely because compensation data exists.

---

## 29. Overlapping Shift Detection

Implement a shared, tested overlap rule.

Conceptually, two shifts overlap when their actual time intervals intersect.

Support shifts crossing midnight.

Do not rely only on shift date equality.

This rule must protect manual assignment, generated assignment, and shift swaps.

---

## 30. Rest Between Shifts

Where configured, calculate the rest interval between the end of one assigned shift and the start of the next.

Use actual instants/timezone-correct representations.

Classify the rule according to configuration as hard or soft.

Example soft explanation:

```text
-20: creates only 7 hours rest after prior shift
```

Do not claim legal compliance without explicit jurisdiction/law implementation.

---

## 31. Consecutive-Day Calculation

Calculate consecutive assigned workdays consistently.

Avoid naive assumptions around overnight shifts.

Document which date is considered the worked day for shift-count/fairness purposes.

Use the schedule/location's operational convention consistently.

---

## 32. Weekend and Closing Fairness

For initial POC scoring, fairness can be deterministic and explainable rather than mathematically perfect.

Examples:

```text
fewer recent weekend assignments -> score bonus
fewer closing shifts -> score bonus
```

Define the lookback scope used by the initial algorithm, such as the current schedule period or available assignment history.

Do not create complex machine-learning fairness models.

---

## 33. Deterministic Scheduling

Given identical input and configuration, the generator should ideally produce deterministic output.

When candidate scores tie, use a stable tie-breaker such as:

```text
employee number
employee UUID
stable candidate ordering
```

Do not use uncontrolled randomness unless a seeded/randomized strategy is explicitly requested later.

Determinism improves testing and manager trust.

---

## 34. Coverage Analysis

Implement coverage analysis for a Schedule Period.

Output should include concepts such as:

```text
Required staffing slots
Filled slots
Open/unfilled slots
Coverage by day
Coverage by Position
Coverage by restaurant area where applicable
Employees over configured targets
Potential overtime warnings
Rest/consecutive-day warnings
```

Coverage analysis is useful for both manual and generated schedules.

Do not wait until reporting phase to provide operational schedule validation.

---

## 35. Explainable Assignments

Generated assignments must retain enough information to explain the decision to the manager.

Conceptual explanation:

```text
Jane Smith
Friday 5 PM - 11 PM
Server

Hard checks
✓ Active employee
✓ Eligible at location
✓ Holds Server Position
✓ Available
✓ No approved time off
✓ No overlap

Scoring
+15 Below target weekly hours
+20 Prefers evening shifts
+10 Weekend distribution
  0 No overtime created
```

Do not expose internal sensitive HR information such as compensation.

Explanations may be generated from structured scoring/constraint results rather than stored as opaque prose only.

---

## 36. Assignment Explanation Persistence

Choose a lightweight strategy.

Recommended:

- Generation run stores rules/settings snapshot.
- Generated assignment may store or associate structured generation rationale sufficient for manager review if needed.
- Do not create excessive permanent logs of every rejected candidate unless required for debugging/audit.

If rejected-candidate details are ephemeral, ensure the manager can still view explanations for assignments and unfilled shifts immediately after generation.

Document the chosen approach.

---

## 37. Unfilled Shift Explanations

When a requirement remains unfilled, provide useful reasons such as:

```text
No qualified employee available
All qualified employees on approved time off
All qualified employees already assigned
Hard maximum hours reached
Mandatory availability prevents assignment
```

Avoid claiming a single reason when multiple constraints eliminated candidates. Use structured summaries where possible.

---

## 38. Generate Draft Mode

`GENERATE_DRAFT` may populate a new/empty draft schedule or an explicitly approved generation context.

Requirements:

- Do not overwrite published schedules.
- Do not silently erase manager assignments.
- Define what happens when the draft already contains assignments.

Recommended initial behavior:

```text
GENERATE_DRAFT requires an empty/unassigned generated scope
or explicit regeneration action
```

Existing manual assignments should be preserved unless the manager explicitly chooses an operation that replaces generated assignments.

---

## 39. Fill Open Shifts Mode

`FILL_OPEN_SHIFTS` is especially important.

Behavior:

```text
Existing assignments
       |
       v
Remain unchanged
       |
       +
Open staffing requirements
       |
       v
Generator proposes/creates only missing assignments
```

This allows a manager to manually build most of the schedule and ask the system to finish the gaps.

Test explicitly that existing assignments are untouched.

---

## 40. Manager Override

Managers may adjust generated assignments after generation.

Rules:

- Generated assignment is a normal assignment with source `GENERATED`.
- Reassignment goes through the same eligibility validation as manual assignment.
- Do not silently permit position/location/overlap hard violations.
- Warnings may be acknowledged for soft-rule violations where the UI supports it.

Do not automatically regenerate nearby assignments merely because one manager change occurred.

---

## 41. Generator Concurrency

Protect the schedule from stale generation results.

Scenario:

```text
Generator reads schedule version 8
Manager manually changes schedule -> version 9
Generator attempts to persist result from version 8
        |
        v
CONCURRENCY CONFLICT
```

Do not apply generated assignments based on a stale schedule state.

Use the Phase 1 optimistic concurrency pattern and transaction architecture.

---

## 42. Generator Transaction Boundary

Generation computation may occur outside the write transaction, but persistence must revalidate schedule state before commit.

Conceptually:

```text
Load normalized scheduling input + version
        |
        v
Compute proposal
        |
        v
BEGIN
Recheck schedule/version/status
Revalidate hard constraints as necessary
Persist generation run/result
Persist generated assignments
Update schedule version
COMMIT
```

Do not hold a long-running database transaction open during heavy scoring if unnecessary.

---

## 43. Generation Failure Behavior

If generation computation fails:

- Do not partially create assignments.
- Record a failed generation run where appropriate without leaking sensitive technical information.
- Return a structured application error.
- Existing manual/draft schedule remains intact.

A partially written generated schedule is unacceptable.

---

## 44. Scheduling Permissions

Use or extend the central Phase 2 permission catalog consistently.

Expected capabilities include:

```text
schedule.view
schedule.edit
schedule.generate
schedule.publish
schedule.time-off.request
schedule.time-off.approve
schedule.swap.request
schedule.swap.approve
schedule.rules.manage
schedule.templates.manage
```

Exact names may be adjusted to avoid conflict with existing seeded codes.

Do not create synonyms for existing permissions.

Employee self-service requests must be scoped to the linked Employee identity where applicable.

---

## 45. Employee Self-Service Identity

If a logged-in User is linked to an Employee, self-service operations may use that link for:

```text
view own schedule
submit own time-off request
submit own shift-swap request
edit own availability/preferences if permitted
```

Do not allow a user to supply an arbitrary Employee ID to impersonate another employee's self-service request.

Resolve the linked Employee server-side.

Admin/manager actions may explicitly target employees when authorized.

---

## 46. Scheduling UI

Create responsive Phase 4 scheduling views appropriate to desktop/tablet and useful read-only/self-service views for phone.

Manager scheduling area should support at minimum:

```text
Schedule Period selection
Draft/Published status
Shift list/calendar-like presentation
Assignment editing
Open shift visibility
Coverage warnings
Generate Draft
Fill Open Shifts
Publish
```

Do not build an excessively complex drag-and-drop calendar if a simpler reliable interface satisfies the Phase 4 workflow.

Correctness and clarity take priority over elaborate interaction.

---

## 47. Availability UI

Provide employee/manager workflows as authorized for:

```text
Recurring availability
Availability exceptions
Scheduling preferences
```

Clearly distinguish:

```text
Availability = can/cannot work
Preference   = would prefer to/not prefer to work
```

Do not visually imply preferences are guaranteed.

---

## 48. Time-Off UI

Support:

```text
Employee request
Manager queue/review
Approve/Deny
Conflict feedback
```

Employees should be able to see request status.

Managers should see conflicts with currently assigned shifts before approval.

---

## 49. Shift Swap UI

Keep the initial swap workflow straightforward.

Support:

```text
Employee selects own assignment
Requests swap, optionally identifies target employee
Target accepts if required by chosen workflow
Manager reviews/approves
System validates receiving employee
Swap completes transactionally
```

Do not create open marketplace bidding or notifications beyond existing application capabilities unless explicitly required.

---

## 50. Staffing Template UI

Managers with appropriate permissions should be able to configure reusable staffing templates and requirements.

At minimum:

```text
Template name
Day of week
Position
Area optional
Start/end time
Required employee count
Priority
```

Validate shifts crossing midnight correctly.

---

## 51. Scheduling Rules UI

Expose only approved configurable rules.

Use clear labels such as:

```text
Avoid overtime
Weekly overtime threshold
Minimum rest between shifts
Maximum days per week
Maximum consecutive days
Balance weekend shifts
Balance closing shifts
Prefer employee target hours
```

Clearly identify if a rule is a Hard Limit or Preference where configurable.

Do not expose arbitrary scoring code or JSON editing to managers.

---

## 52. Unit Tests: Eligibility

Create pure/focused tests for candidate eligibility.

At minimum:

```text
ACTIVE + location + Position + availability -> eligible
TERMINATED -> ineligible
ON_LEAVE according to policy -> ineligible where applicable
wrong location -> ineligible
Security Role only, no Employee Position -> ineligible
Position effective after shift -> ineligible
approved time off -> ineligible
mandatory unavailable window -> ineligible
overlapping shift -> ineligible
```

---

## 53. Unit Tests: Availability Precedence

Test recurring availability and exceptions.

Examples:

```text
Recurring AVAILABLE + exception UNAVAILABLE -> unavailable
Recurring UNAVAILABLE + exception AVAILABLE -> available
No applicable availability record -> AVAILABILITY_NOT_CONFIGURED and ineligible
Explicit UNAVAILABLE -> distinct from AVAILABILITY_NOT_CONFIGURED
Partial AVAILABLE window -> ineligible when it does not cover the entire shift
Cross-midnight availability -> correct
Manual and generated assignment -> identical availability result
```

The missing-availability policy is fixed for Phase 4: missing availability is ineligible for all assignment paths. Do not add an availability override.

---

## 54. Unit Tests: Candidate Scoring

Test deterministic scoring.

Examples:

```text
Candidate A below target hours beats equally eligible Candidate B above target
Candidate creating overtime receives configured penalty
Preferred evening candidate receives expected bonus
Employee with fewer weekend assignments receives fairness bonus
Employee with close/open rest concern receives penalty
Tie uses stable deterministic tie-breaker
```

Do not assert implementation-private details unnecessarily, but lock down approved scoring behavior.

---

## 55. Unit Tests: Coverage Analysis

Test:

```text
fully staffed schedule
one missing Server
multiple missing roles
required_employee_count > 1
coverage by Position
coverage by area
warnings for projected overtime/rest/consecutive days
```

Coverage results should be stable and independent of UI presentation.

---

## 56. Unit Tests: Explainability

For generated assignments, verify structured reasons correspond to actual constraints/scores.

Test that explanations do not include compensation or restricted HR data.

Test unfilled-shift reason summaries.

---

## 57. Integration Tests: Manual Scheduling

Test end-to-end database behavior for:

```text
create schedule period
create shift
assign eligible employee
reject wrong Position
reject wrong location
reject inactive/terminated employee
reject approved time-off conflict
reject overlap
preserve assignment source MANUAL
publish valid schedule
reject unauthorized publish
```

---

## 58. Integration Tests: Time Off

Test:

```text
employee-linked User requests own time off
cannot request for another employee through self-service path
manager approves non-conflicting request
manager approval with assignment conflict follows documented policy
approved request blocks later assignment
cancelled/denied request behavior
location/organization authorization
```

---

## 59. Integration Tests: Shift Swap

Test:

```text
requester owns original assignment
receiving employee qualification
receiving employee availability
receiving employee no overlap
transactional assignment replacement
source = SHIFT_SWAP
failed validation leaves original assignment unchanged
unauthorized approval denied
```

---

## 60. Integration Tests: Generator

Create scenarios with known employees and expected result.

Required examples:

### Prefer target hours

```text
Employee A eligible and under target
Employee B eligible and over target
        |
        v
A selected when other scoring is equal
```

### Approved time off

```text
Employee A strongest score but approved time off
        |
        v
A never considered eligible
```

### Position vs Role

```text
User has BARTENDER Security Role
Employee lacks Bartender Position
        |
        v
never assigned Bartender shift
```

### Overtime avoidance

```text
A causes overtime
B does not
avoid_overtime = true
        |
        v
B preferred
```

### Unfilled requirement

```text
No qualified candidate
        |
        v
shift remains open
coverage reports shortage
explanation provided
```

### Fill Open Shifts

```text
Existing manual assignments
        |
        v
remain unchanged
only missing assignments generated
```

### Idempotence/concurrency

Repeated/stale generation must not duplicate assignments or overwrite manager changes.

---

## 61. Integration Tests: Publishing

Test:

```text
DRAFT -> PUBLISHED
publisher/timestamp recorded
unauthorized publish denied
stale version publish rejected
invalid hard-conflict schedule rejected
published schedule not regenerated
```

If post-publish changes are supported in Phase 4, test their explicit workflow separately.

---

## 62. E2E Tests

Add focused Playwright scenarios.

### Manager Manual Schedule

```text
Login as authorized manager
 -> create/open draft period
 -> create/view shift
 -> assign employee
 -> coverage updates
```

### Automatic Draft

```text
Manager opens draft schedule
 -> Generate Draft
 -> generated assignments appear
 -> open/unfilled shifts visible
 -> explanation available
 -> manager changes assignment
```

### Fill Open Shifts

```text
Schedule contains manual assignments + open requirements
 -> Fill Open Shifts
 -> manual assignments unchanged
 -> open assignments filled where possible
```

### Publish

```text
Authorized manager publishes valid schedule
 -> status PUBLISHED
```

### Employee Self-Service

```text
Linked employee logs in
 -> views own schedule
 -> requests time off
 -> cannot target another employee
```

### Permission Boundary

```text
User with schedule.view only
 -> can view
 -> cannot generate/publish
```

Do not rely solely on browser tests for authorization correctness.

---

## 63. Seed Data

Extend idempotent seed configuration only where stable Phase 4 configuration is appropriate.

Recommended seed data may include:

```text
Default Scheduling Rules for MAIN
Standard staffing templates sufficient for development/demo
```

Do not seed permanent fake employee availability/time-off as normal POC business data unless intentionally desired.

Use isolated fixtures for automated scheduling tests.

Keep staffing template seeds modest and clearly development oriented.

---

## 64. Migration Requirements

Generate and review the Phase 4 migration.

Verify:

```text
Existing Phase 3 DB
 -> Phase 4 migration
 -> success
```

and:

```text
Empty DB
 -> Phase 1 + 2 + 3 + 4 migrations
 -> same expected schema
```

A clean second `db:generate` must report no unexplained drift.

Do not rewrite established older migrations merely to cosmetically remove prior non-fatal notices.

---

## 65. Reset and Seed Regression

Verify:

```text
npm run db:reset
npm run db:seed
```

reconstructs all prior phase configuration plus Phase 4 stable scheduling configuration.

No duplicate rule/template records after repeated seed runs.

Reset safeguards against production/remote DB targets remain mandatory.

---

## 66. Regression Requirements

Phase 4 must preserve:

```text
Phase 1 database foundation
Phase 2 authentication/RBAC
Phase 3 Employee/HR security boundaries
FileStorageService behavior
User/Employee optional link
Employee Position / Security Role separation
Termination-linked-user behavior
```

Do not weaken HR permissions to simplify scheduling queries.

Scheduling queries should consume only HR fields needed for eligibility.

The generator must not load compensation, disciplinary, personal address, emergency contacts, or sensitive document information.

---

## 67. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies must remain clean or new findings must be reviewed before Phase 4 approval.

Do not add a large optimization/AI dependency unless justified. The initial scheduler should be deterministic application logic.

Preserve `DEV-001` unless a compatible dependency update changes its status.

---

## 68. Documentation Updates

Update documentation with:

- Scheduling domain model
- Manual scheduling workflow
- Availability semantics and default behavior
- Time-off workflow
- Shift swap workflow
- Staffing template model
- Scheduling rules
- Hard vs soft constraints
- Initial scoring weights
- Tie-break strategy
- Generate Draft behavior
- Fill Open Shifts behavior
- Publishing rules
- Generated-assignment explanations
- Generation concurrency behavior
- Manager override rules
- Scheduling permissions

Do not rewrite unrelated architecture sections.

---

## 69. Phase 4 Validation Checklist

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

Safe reset regression:

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
PostgreSQL health                     PASS
/api/health                           PASS
migration generation                  PASS
migration application                 PASS
empty DB reconstruction               PASS
schema drift                          NONE
seed idempotency                      PASS
reset safeguards                      PASS
Phase 2 auth/RBAC regression          PASS
Phase 3 Employee/HR regression        PASS
manual scheduling                     PASS
availability/exception precedence     PASS
time-off workflow                     PASS
shift swap workflow                   PASS
position/location eligibility         PASS
Security Role != Position             PASS
overlap detection                     PASS
coverage analysis                     PASS
hard constraint engine                PASS
soft candidate scoring                PASS
deterministic generation              PASS
Generate Draft                        PASS
Fill Open Shifts                      PASS
assignment explanations               PASS
unfilled-shift explanations           PASS
generation concurrency                PASS
manager override                      PASS
schedule publishing                   PASS
employee self-service scoping         PASS
production dependency audit           CLEAN
```

---

## 70. Phase 4 Deliverables

Phase 4 should leave the repository with:

```text
✓ schedule_periods
✓ shifts
✓ shift_assignments
✓ employee_availability
✓ employee_availability_exceptions
✓ employee_scheduling_preferences
✓ time_off_requests
✓ shift_swap_requests
✓ staffing_templates
✓ staffing_template_requirements
✓ scheduling_rules
✓ schedule_generation_runs

✓ manual schedule creation/editing
✓ employee assignment validation
✓ schedule coverage analysis
✓ schedule publishing

✓ recurring availability
✓ availability exceptions
✓ preferences
✓ time-off request/review
✓ shift swaps

✓ staffing templates
✓ template-to-shift generation
✓ structured scheduling rules

✓ deterministic ScheduleGenerator
✓ hard constraint filtering
✓ soft scoring
✓ overtime avoidance scoring
✓ rest/consecutive-day handling
✓ weekend/closing fairness
✓ stable tie-breaking

✓ Generate Draft mode
✓ Fill Open Shifts mode
✓ manager overrides
✓ generated assignment provenance
✓ generation history
✓ assignment explanations
✓ unfilled-shift reasons
✓ concurrency protection

✓ manager scheduling UI
✓ employee schedule/self-service UI
✓ Phase 4 authorization

✓ unit tests for generator logic
✓ PostgreSQL integration tests
✓ Playwright scheduling tests
✓ prior-phase regressions green
✓ production dependency audit clean
✓ no Phase 5+ domains prematurely implemented
```

---

## 71. Phase 4 Definition of Done

Phase 4 is complete when an authorized manager can:

```text
Create Schedule Period
        |
        v
Create/import staffing Shifts
        |
        v
Assign Employees manually
        |
        +-- eligibility validation
        +-- conflict detection
        +-- coverage analysis
        |
        v
Generate Draft or Fill Open Shifts
        |
        +-- hard constraints enforced
        +-- soft criteria scored
        +-- explanations available
        +-- open shortages visible
        |
        v
Manager reviews/overrides
        |
        v
Publish Schedule
```

And an employee-linked User can, according to permissions:

```text
View own schedule
Maintain/request allowed availability data
Request time off
Request shift swap
```

The application must prove:

- A Security Role cannot substitute for an Employee Position.
- Terminated/ineligible employees are never scheduled.
- Approved time off is respected.
- Existing manual assignments survive Fill Open Shifts.
- Generated schedules are never automatically published.
- Generation is deterministic for identical input.
- Stale generation cannot overwrite manager changes.
- Explanations reflect actual constraint/scoring results.
- Sensitive HR data is not loaded or exposed to scheduling logic/UI.
- Database reconstruction requires no manual SQL.
- Prior phase regressions remain green.

Phase 4 is not complete if the generator and manual assignment paths use inconsistent eligibility logic.

Phase 4 is not complete if Generate Draft can overwrite a published schedule.

Phase 4 is not complete if the generator uses employee compensation as a cost-minimization signal.

---

## 72. Required Phase 4 Completion Report

When Phase 4 is complete, provide:

```text
PHASE 4 COMPLETION REPORT

Environment
- Node version:
- npm version:
- Next.js version:
- PostgreSQL version:
- Drizzle ORM version:
- Drizzle Kit version:

Scheduling Schema
- schedule_periods: PASS / FAIL
- shifts: PASS / FAIL
- shift_assignments: PASS / FAIL
- employee_availability: PASS / FAIL
- employee_availability_exceptions: PASS / FAIL
- employee_scheduling_preferences: PASS / FAIL
- time_off_requests: PASS / FAIL
- shift_swap_requests: PASS / FAIL
- staffing_templates: PASS / FAIL
- staffing_template_requirements: PASS / FAIL
- scheduling_rules: PASS / FAIL
- schedule_generation_runs: PASS / FAIL

Manual Scheduling
- Schedule period lifecycle: PASS / FAIL
- Shift creation: PASS / FAIL
- Manual assignment: PASS / FAIL
- Employee status eligibility: PASS / FAIL
- Location eligibility: PASS / FAIL
- Employee Position eligibility: PASS / FAIL
- Security Role cannot substitute for Position: PASS / FAIL
- Availability validation: PASS / FAIL
- Approved time-off validation: PASS / FAIL
- Overlap detection: PASS / FAIL
- Coverage analysis: PASS / FAIL
- Publishing: PASS / FAIL

Employee Scheduling Inputs
- Recurring availability: PASS / FAIL
- Availability exceptions: PASS / FAIL
- Exception precedence: PASS / FAIL
- Preferences: PASS / FAIL
- Time-off workflow: PASS / FAIL
- Shift swaps: PASS / FAIL
- Self-service Employee scoping: PASS / FAIL

Staffing Configuration
- Staffing templates: PASS / FAIL
- Staffing requirements: PASS / FAIL
- Template-to-shift generation: PASS / FAIL
- Scheduling rules: PASS / FAIL
- Seed idempotency: PASS / FAIL

Automatic Generator
- Deterministic output: PASS / FAIL
- Shared hard eligibility logic: PASS / FAIL
- Hard constraints: PASS / FAIL
- Soft scoring: PASS / FAIL
- Target-hours scoring: PASS / FAIL
- Overtime avoidance: PASS / FAIL
- Rest handling: PASS / FAIL
- Consecutive-day handling: PASS / FAIL
- Weekend fairness: PASS / FAIL
- Closing fairness: PASS / FAIL
- Stable tie-breaking: PASS / FAIL
- Generate Draft: PASS / FAIL
- Fill Open Shifts: PASS / FAIL
- Manual assignments preserved: PASS / FAIL
- Manager overrides: PASS / FAIL
- No automatic publish: PASS / FAIL
- Generation concurrency: PASS / FAIL
- Failure atomicity: PASS / FAIL

Explainability
- Assignment hard-check reasons: PASS / FAIL
- Scoring reasons: PASS / FAIL
- Unfilled-shift explanations: PASS / FAIL
- Restricted HR data excluded: PASS / FAIL
- Generation rules snapshot: PASS / FAIL

Authorization
- schedule.view: PASS / FAIL
- schedule.edit: PASS / FAIL
- schedule.generate: PASS / FAIL
- schedule.publish: PASS / FAIL
- time-off self-service scoping: PASS / FAIL
- swap self-service scoping: PASS / FAIL
- direct unauthorized API access denied: PASS / FAIL

Migrations
- Generation: PASS / FAIL
- Application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Regression
- Phase 1 foundation tests: PASS / FAIL
- Phase 2 auth/RBAC tests: PASS / FAIL
- Phase 3 Employee/HR tests: PASS / FAIL
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

Business Domains Created Beyond Phase 4
- NONE expected

Created / Modified
- Summarize schema, migration, scheduling module, generator, permissions, UI, seeds, tests, and documentation.

Architecture Deviations
- None
  OR
- Describe each deviation and why it was necessary.

Outstanding Phase 4 Issues
- None
  OR
- List each unresolved issue and whether it blocks Phase 5.

Phase 5 Readiness
- READY / NOT READY
```

---

## 73. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-4-Scheduling.md`, use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 4 implementation plans completely. Treat `README.md` as the architectural source of truth.
>
> Review the completed Phase 0 through Phase 3 implementation before modifying files. Implement Phase 4 only: Scheduling, including schedule periods, shifts, assignments, recurring availability, availability exceptions, scheduling preferences, time-off requests, shift swaps, staffing templates and requirements, scheduling rules, manual scheduling, coverage/conflict analysis, publishing, automatic draft generation, Fill Open Shifts, hard constraints, deterministic soft scoring, explainable assignments, generation history, concurrency protection, Phase 4 permissions, responsive scheduling/self-service UI, seeds, and required automated tests.
>
> Preserve the critical Phase 3 boundary: Employee Position determines job qualification; Security Role determines application authorization. A Security Role must never make an Employee eligible to work a Position. Do not use compensation or restricted HR data as a scheduling optimization signal.
>
> Build and validate manual scheduling before automatic generation. The generator must never automatically publish, must preserve existing manual assignments in Fill Open Shifts mode, must use the same hard eligibility rules as manual assignment, and must not overwrite manager changes from a stale schedule version.
>
> Do not implement physical seating, reservations, menu, recipes, inventory, purchasing, orders, kitchen/bar fulfillment, settlements, full reporting, payroll, sales-demand forecasting, AI/LLM scheduling, or later-phase functionality.
>
> Preserve the Phase 1 database/migration/transaction/test architecture, Phase 2 authentication/location-aware RBAC, Phase 3 Employee/HR privacy boundaries, reset safeguards, exact numeric conventions, and DEV-001 accepted-risk decision.
>
> Before modifying files, inspect the current repository and provide a concise Phase 4 execution plan. If the default behavior for missing employee availability or another material scheduling policy is not already clearly established by the architecture, stop and identify the ambiguity, available options, recommendation, and impact before implementing it.
>
> After implementation, run the complete Phase 4 validation suite and provide the full Phase 4 Completion Report. If an architectural conflict or significant scheduling-policy decision is encountered, stop at that decision point and explain the conflict, options, recommendation, and architectural impact before altering the approved architecture.

---


## Final Guardrail

Phase 4 creates a manager-controlled scheduling system, not an autonomous workforce-management engine.

The architecture remains:

```text
Employee HR Facts
  + Status
  + Location Eligibility
  + Position Qualification
        |
        v
Availability / Time Off / Preferences
        |
        v
Scheduling Rules + Staffing Requirements
        |
        v
Manual Scheduling + Deterministic Generator
        |
        v
DRAFT Schedule
        |
        v
Manager Review / Override
        |
        v
PUBLISHED Schedule
```

The Manager remains responsible for publication.

Phase 5 Restaurant & Seating will consume employee/server information and published operational staffing without changing the scheduling architecture defined here.
