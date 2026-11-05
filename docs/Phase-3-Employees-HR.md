# Phase 3: Employees & HR Implementation Plan

## Purpose

Phase 3 implements the Employee and Human Resources foundation for the Restaurant Operations Management System.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/accepted-risks.md`
4. `docs/Phase-0-Implementation-Plan.md`
5. `docs/Phase-1-Database-Foundation.md`
6. `docs/Phase-2-Organization-Authentication-RBAC.md`
7. This document

`README.md` remains the architectural source of truth.

Phase 3 must preserve the completed Phase 0 through Phase 2 foundations, especially the distinction between application identity/security and employment/job position.

---

## 1. Phase 3 Objectives

Implement the Employee and HR domain:

```text
Organization
    |
    +-- Employee
          |
          +-- Employee Locations
          +-- Employee Positions
          |      |
          |      +-- Position
          |
          +-- Addresses
          +-- Emergency Contacts
          +-- Position Compensation History (per Employee + Position)
          +-- Certifications
          |      |
          |      +-- Certification Type
          |
          +-- Documents
          +-- Notes
          +-- Disciplinary Actions
          +-- Performance Reviews
          +-- Employment Status History
          |
          +-- Optional Application User Link
```

Phase 3 must deliver:

- Employee profiles
- Multi-location employee eligibility
- Configurable restaurant positions
- Effective-dated employee position assignments
- Optional one-to-one User-to-Employee linkage
- Personal addresses
- Emergency contacts
- Effective-dated compensation history per Employee and Position (an employee working several positions has a separate wage for each)
- Certification types and employee certifications
- Employee document metadata and file-storage abstraction usage
- Employee notes with sensitivity classification
- Disciplinary actions
- Performance reviews
- Employment status history
- Restricted HR authorization boundaries
- Minimal responsive Employee/HR administration UI
- Idempotent Phase 3 seed data where appropriate
- Database migrations and reconstruction validation
- Unit, integration, authorization, and E2E tests

---

## 2. Critical Identity Boundary

Preserve these distinct concepts:

```text
User
  = application identity

Security Role
  = collection of application permissions

Employee
  = person employed by the restaurant

Position
  = job the employee performs
```

Do not automatically grant application permissions because an employee receives a position.

Examples:

```text
Employee Position: Bartender
```

does not automatically imply:

```text
Security Role: BARTENDER
```

Likewise, assigning a security role must not automatically create or change an employee position.

Any workflow that intentionally changes both concepts must make both changes explicitly and enforce both domains independently.

---

## 3. Phase 3 Scope Boundary

Do not implement these later-phase capabilities:

```text
weekly schedules
shifts
shift assignments
automatic schedule generation
time-off workflow
shift swaps
clock-in / clock-out
restaurant physical tables
reservations
waitlist
menu items
recipes
inventory
orders
kitchen/bar tickets
settlement
reporting dashboards
full audit domain
```

Employee availability belongs primarily to Phase 4 Scheduling. Do not prematurely implement the scheduling domain here unless a minimal HR-owned concept is explicitly required by the existing architecture.

Do not implement payroll processing.

Compensation history is HR data, not payroll.

Compensation is determined by the Employee and Position pair, never by the Position alone and never by the Employee alone. Two employees in the same Position may earn different wages, and one employee working two Positions (for example Server and Cook) may earn a different wage in each.

Do not implement AWS/S3 deployment in Phase 3. File storage must remain behind an abstraction that can support S3 later.

---

## 4. Review Existing Foundation Before Changes

Before modifying files, inspect and confirm:

- Phase 0 foundation remains green.
- Phase 1 database conventions remain unchanged and green.
- Phase 2 organization/auth/RBAC tests remain green.
- `organizations`, `locations`, and Phase 2 security schemas are understood.
- Current permission catalog is understood.
- User/session/current-user implementation is understood.
- Location-aware authorization is understood.
- Shared transaction context is understood.
- Seed framework and seed idempotency are understood.
- Development/test DB separation remains intact.
- `db:reset` safety protections remain intact.
- `DEV-001` remains documented in `docs/accepted-risks.md`.

Before coding, provide a concise Phase 3 execution plan based on the repository's actual state.

---

## 5. Employee Schema

Create:

```text
employees
```

Conceptual fields:

```text
id                    UUID PK
organization_id       UUID FK
employee_number       required
first_name            required
middle_name           nullable
last_name             required
preferred_name        nullable
personal_email        nullable
work_email            nullable
phone                 nullable
hire_date             DATE required
termination_date      DATE nullable
employment_status     required
employment_type       required
primary_location_id   UUID nullable FK
active                BOOLEAN or domain status according to service design
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Use Phase 1 conventions for UUIDs, timestamps, and concurrency.

Required uniqueness:

```text
UNIQUE (organization_id, employee_number)
```

Do not use employee number as the PK.

Do not physically delete employees during normal application behavior.

---

## 6. Employment Status

Initial employment statuses:

```text
ACTIVE
ON_LEAVE
SUSPENDED
TERMINATED
```

Use the project's approved stable-state representation strategy rather than creating a configurable table unless the current architecture clearly requires one.

The current employee status is useful for efficient reads, but status changes must also be recorded in `employee_status_history`.

Termination must preserve the employee and all historical references.

---

## 7. Employment Type

Initial employment types:

```text
FULL_TIME
PART_TIME
SEASONAL
TEMPORARY
```

Do not treat employment type as compensation type.

For example, a part-time employee may be hourly, and compensation history is its own domain record keyed by Employee and Position.

---

## 8. Employee Locations

Create:

```text
employee_locations
```

Conceptual fields:

```text
id                  UUID PK
employee_id         UUID FK
location_id         UUID FK
primary_location    BOOLEAN
effective_from      DATE
effective_to        DATE nullable
active              BOOLEAN default TRUE
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
```

Purpose:

```text
Jane
  Primary: Main Restaurant
  Eligible future location: Location B
```

Even though the POC uses one permanent location, the data model must support multiple employee-location assignments.

Prevent duplicate overlapping equivalent assignments where practical.

The employee's `primary_location_id` and the primary employee-location assignment must remain logically consistent through service-level transactional operations.

---

## 9. Employee Location Business Rules

Implement and test rules such as:

- Employee location must belong to the same organization as the employee.
- Primary location must be one of the employee's eligible/active locations.
- Only one active primary location assignment may exist for an employee at a time.
- Deactivating a location assignment must not delete its historical record.
- Future Phase 4 scheduling will use these records to determine location eligibility.

Where multiple rows must change together, use the Phase 1 shared transaction context.

---

## 10. Positions

Create:

```text
positions
```

Conceptual fields:

```text
id                  UUID PK
organization_id     UUID FK
code                required
name                required
description         nullable
active              BOOLEAN default TRUE
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Initial seed positions should represent restaurant jobs:

```text
GENERAL_MANAGER
MANAGER
SERVER
BARTENDER
HOST
COOK
WAIT_STAFF
INVENTORY_MANAGER
```

An Owner security role does not necessarily require an employee position. If a business Owner is also an employee, an Owner position may be added only if intentionally required by the HR model.

Position codes may resemble role codes, but they represent different concepts and must use separate tables/services.

---

## 11. Employee Position Assignments

Create:

```text
employee_positions
```

Conceptual fields:

```text
id                    UUID PK
employee_id           UUID FK
position_id           UUID FK
location_id           UUID FK
primary_position      BOOLEAN
effective_from        DATE
effective_to          DATE nullable
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
```

This enables:

```text
Jane Smith
  Main Restaurant
    Server
    Bartender
```

Future Phase 4 shifts will reference the position being worked for a specific shift.

Do not infer security roles from these records.

---

## 12. Employee Position Rules

Implement and test:

- Employee and position must belong to the same organization.
- Assignment location must be an eligible employee location.
- Position assignment must be effective for the requested date where applicable.
- Avoid duplicate overlapping equivalent position assignments.
- Only one active primary position should exist per relevant employee/location context according to the selected model.
- Ending an assignment preserves history.
- Deactivating a position does not erase historical assignments.

---

## 13. User-to-Employee Link

Phase 3 introduces the optional relationship between Phase 2 `users` and `employees`.

Support:

```text
Employee 0..1 <-> 0..1 User
```

Required scenarios:

```text
Employee without login account
User without employee record
Employee linked to exactly one user account
```

Choose one relational direction that cleanly preserves the existing Phase 2 schema. A nullable `employee_id` on `users` is acceptable if it results in a clean migration and unique constraint.

Required uniqueness:

```text
one employee cannot be linked to multiple users
```

Linking an employee to a user does not automatically synchronize employee positions with security roles.

---

## 14. Employee/User Linking Workflow

Implement an explicit authorized operation for linking/unlinking where needed.

Rules:

- Require appropriate employee/user administration permission.
- Ensure both records belong to the appropriate organizational context.
- Reject attempts to link an employee already linked to another user.
- Reject attempts to link a user already linked to another employee.
- Do not transfer permissions automatically.
- Preserve security behavior if an employee is terminated.

Decide and document whether employee termination automatically disables a linked user or merely warns/requires explicit user deactivation.

Recommended POC behavior: termination workflow should disable the linked user in the same transaction unless an explicit administrative override is part of the approved command. This avoids terminated employees retaining restaurant access.

Do not implement this as an implicit database trigger. Keep this business rule in the domain/service workflow.

---

## 15. Employee Addresses

Create:

```text
employee_addresses
```

Conceptual fields:

```text
id              UUID PK
employee_id     UUID FK
address_type    required
address_line1   required
address_line2   nullable
city            required
state           required
postal_code     required
country         required
effective_from  DATE
effective_to    DATE nullable
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

Initial address types may include:

```text
HOME
MAILING
OTHER
```

Address information is restricted HR/personal data.

Do not expose it to general `employees.view` access by default.

---

## 16. Emergency Contacts

Create:

```text
employee_emergency_contacts
```

Conceptual fields:

```text
id                  UUID PK
employee_id         UUID FK
name                required
relationship        required
phone               required
alternate_phone     nullable
email               nullable
primary_contact     BOOLEAN
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
```

Emergency contacts are restricted HR data.

Implement service validation for one primary contact where appropriate without destroying historical/secondary contacts.

---

## 17. Position Compensation History

Create:

```text
employee_position_compensation
```

Pay is owned by the Employee + Position pair. The `positions` table must not hold a wage, and there is no single per-employee pay record.

Conceptual fields:

```text
id                    UUID PK
organization_id       UUID FK
employee_id           UUID FK
position_id           UUID FK
compensation_type     required
hourly_rate           NUMERIC(12,2) nullable
annual_salary         NUMERIC(12,2) nullable
effective_from        DATE required
effective_to          DATE nullable
change_reason         nullable
created_by_user_id    UUID FK
created_at            TIMESTAMPTZ
```

Compensation types:

```text
HOURLY
SALARY
```

This enables:

```text
Jane Smith
  Server      -> HOURLY 9.50  (effective 2026-01-01)
  Bartender   -> HOURLY 12.00 (effective 2026-03-01)

Raj Patel
  Server      -> HOURLY 11.25 (effective 2025-06-15)
```

Wage is keyed by (employee_id, position_id) and is not location-specific. An employee who holds the same Position at several locations has one wage for that Position.

An effective `employee_positions` assignment for the same employee and position must exist on the compensation `effective_from` date. Compensation cannot be created for a Position the employee has never been assigned.

Use exact numeric values according to Phase 1 conventions.

Do not overwrite historical compensation.

Do not calculate payroll, taxes, withholding, checks, or direct deposits.

---

## 18. Position Compensation Business Rules

Implement and test:

- Hourly compensation requires hourly rate and no annual salary according to the selected validation model.
- Salary compensation requires annual salary and no hourly rate according to the selected validation model.
- Compensation amounts must be non-negative and within reasonable database constraints.
- Effective periods should not overlap for the same employee unless there is an explicitly documented reason.
- A new compensation change closes the previous active compensation period atomically when applicable.
- Historical compensation records are not edited to simulate a new pay change.
- Compensation access requires restricted HR permissions.
- Compensation is unique per Employee + Position for any effective date: effective periods must not overlap for the same (employee_id, position_id), but periods for different positions of the same employee are independent.
- Employee, Position and compensation row must belong to the same organization.
- Compensation requires an effective employee position assignment for that Employee + Position on the `effective_from` date.
- Changing the wage for one Position must not change the wage for any other Position the employee holds.
- Ending or deactivating a position assignment does not delete compensation history.
- A Position has no wage of its own. Do not add a default or fallback rate to `positions`.
- Phase 4 and Phase 12 must resolve a shift's wage from the Employee + the shift's Position and effective date.

Use PostgreSQL constraints where practical plus domain validation.

---

## 19. Certification Types

Create:

```text
certification_types
```

Conceptual fields:

```text
id                    UUID PK
organization_id       UUID FK
code                  required
name                  required
description           nullable
expiration_required   BOOLEAN
warning_days          integer nullable
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Required uniqueness:

```text
UNIQUE (organization_id, code)
```

Example future/seed types may include:

```text
FOOD_SAFETY
ALCOHOL_SERVICE
```

Use generic names. Do not encode jurisdiction-specific certification requirements unless explicitly configured.

---

## 20. Employee Certifications

Create:

```text
employee_certifications
```

Conceptual fields:

```text
id                      UUID PK
employee_id             UUID FK
certification_type_id   UUID FK
certification_number    nullable
issued_date             DATE nullable
expiration_date         DATE nullable
document_id             nullable FK if relationship is cleanly supported
verified                BOOLEAN default FALSE
verified_by_user_id     nullable UUID FK
verified_at             TIMESTAMPTZ nullable
created_at              TIMESTAMPTZ
updated_at              TIMESTAMPTZ
```

Rules:

- Certification type organization must match employee organization.
- Expiration date is required when certification type requires expiration, unless the workflow explicitly supports incomplete/unverified records.
- Verification metadata cannot claim verification without a verifier/time.
- Expiring certification reporting is not Phase 3 reporting, but the data must support it later.

---

## 21. Employee Documents

Create:

```text
employee_documents
```

Store metadata only in PostgreSQL.

Conceptual fields:

```text
id              UUID PK
employee_id     UUID FK
document_type   required
name            required
description     nullable
storage_key     required
mime_type       required
file_size       numeric/integer appropriate for bytes
sensitive       BOOLEAN default TRUE
uploaded_by_user_id UUID FK
uploaded_at     TIMESTAMPTZ
created_at      TIMESTAMPTZ
```

Do not store large document binaries directly in PostgreSQL.

---

## 22. FileStorageService

Use the architecture's storage abstraction:

```text
Employee HR Domain
        |
        v
FileStorageService
        |
        +-- Local Development Adapter
        |
        +-- Future S3 Adapter
```

Phase 3 should implement a safe local-development storage adapter if the current repository does not already have one.

Requirements:

- Store files outside PostgreSQL.
- Generate safe storage keys rather than trusting raw user filenames as paths.
- Prevent directory traversal.
- Enforce configured size limits.
- Validate/allow expected MIME types according to business needs.
- Keep uploaded HR files outside public static web directories.
- Do not expose local filesystem paths through DTOs.
- Make file retrieval pass through authorization checks.

Do not implement S3 in this phase.

---

## 23. Employee Document Access

Document metadata and file download must enforce permissions server-side.

General employee viewers must not automatically retrieve sensitive HR documents.

A document marked `sensitive` requires restricted HR/document permission.

Do not create public file URLs for HR documents.

E2E/integration tests should verify unauthorized access is denied even when a user knows a document ID.

---

## 24. Employee Notes

Create:

```text
employee_notes
```

Conceptual fields:

```text
id                UUID PK
employee_id       UUID FK
note_type         required
title             required
content           required
sensitive         BOOLEAN default FALSE
created_by_user_id UUID FK
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1 if notes are editable
```

Potential note types:

```text
GENERAL
PERFORMANCE
RECOGNITION
TRAINING
MANAGER
```

Do not use ordinary notes as a substitute for formal disciplinary actions or performance reviews.

Sensitive notes require restricted HR access.

---

## 25. Disciplinary Actions

Create:

```text
employee_disciplinary_actions
```

Conceptual fields:

```text
id                UUID PK
employee_id       UUID FK
action_type       required
incident_date     DATE nullable
action_date       DATE required
description       required
action_taken      required
follow_up_date    DATE nullable
created_by_user_id UUID FK
created_at        TIMESTAMPTZ
updated_at        TIMESTAMPTZ
version           INTEGER default 1
```

This is restricted HR data.

Do not expose disciplinary information through general employee queries.

Do not place disciplinary details in logs.

---

## 26. Performance Reviews

Create:

```text
employee_performance_reviews
```

Conceptual fields:

```text
id                    UUID PK
employee_id           UUID FK
reviewer_employee_id  nullable UUID FK
reviewer_user_id      nullable UUID FK
review_period_start   DATE
review_period_end     DATE
review_date           DATE
status                required
overall_rating        nullable
summary               nullable
employee_comments     nullable
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Use a simple rating/status model during Phase 3. Do not build a complex competency framework unless explicitly required.

Performance reviews are management/HR information, not public employee-directory data.

---

## 27. Employee Status History

Create:

```text
employee_status_history
```

Conceptual fields:

```text
id                  UUID PK
employee_id         UUID FK
status              required
effective_at        TIMESTAMPTZ
reason              nullable
changed_by_user_id  UUID FK
created_at          TIMESTAMPTZ
```

Treat this as append-oriented history.

A status workflow should change the employee's current status and append a history record atomically.

Do not update old history entries merely to hide a prior status.

Corrections should be explicit and traceable according to the domain design.

---

## 28. Employee Creation Workflow

Implement an authorized employee creation command/service.

Conceptually:

```text
Validate permission
      |
      v
Validate organization/location
      |
      v
Create employee
      |
      +-- Assign initial employee location
      +-- optionally assign initial employee position
      +-- append initial status history
      |
      v
COMMIT
```

Use the shared transaction context where multiple records are created.

Do not create an application user automatically unless an explicit user-provisioning operation is intentionally requested.

---

## 29. Employment Status Workflow

Create explicit operations such as:

```text
changeEmployeeStatus()
terminateEmployee()
```

or equivalent.

Termination should conceptually:

```text
Employee ACTIVE
      |
      v
Validate HR permission
      |
      v
Set current status TERMINATED
Set termination date
Append status history
End active location/position assignments as appropriate
Disable linked User if present
      |
      v
COMMIT
```

Do not delete the employee or their historical records.

If the implementation chooses not to automatically end all location/position assignments, document the alternative and ensure Phase 4 scheduling cannot treat a terminated employee as eligible.

---

## 30. HR Permission Model

Use the Phase 2 RBAC foundation to enforce differentiated HR access.

At minimum, ensure the permission catalog contains or is extended with clear capabilities such as:

```text
employees.view
employees.create
employees.edit
employees.terminate
employees.positions.manage
employees.locations.manage

hr.view
hr.personal.view
hr.personal.edit
hr.compensation.view
hr.compensation.edit
hr.certifications.view
hr.certifications.manage
hr.documents.view
hr.documents.manage
hr.notes.view
hr.notes.manage
hr.performance.view
hr.performance.manage
hr.disciplinary.view
hr.disciplinary.manage
```

Exact names may be adjusted to remain consistent with the existing Phase 2 catalog, but avoid overly broad permissions that collapse all HR sensitivity into `employees.view`.

Do not introduce duplicate permission synonyms.

---

## 31. HR Security Boundaries

Implement three practical sensitivity tiers.

### General Employee Information

Examples:

```text
Name
Work contact
Employee number
Position
Eligible restaurant location
Employment status
```

Appropriate for `employees.view`.

### Management Information

Examples:

```text
Certifications
Employment history
Performance reviews
Manager notes
```

Require management/HR permissions.

### Restricted HR Information

Examples:

```text
Compensation
Disciplinary records
Personal address
Emergency contacts
Sensitive notes
Sensitive documents
```

Require explicit restricted HR permissions.

A user with `employees.view` must not automatically receive restricted HR data in the same DTO/query.

---

## 32. DTO and Query Separation for Sensitive Data

Do not build one `EmployeeDTO` that always returns every HR field.

Prefer purpose-specific query models, for example conceptually:

```text
EmployeeDirectorySummary
EmployeeManagementDetail
EmployeePersonalDetail
EmployeePositionCompensationHistory
EmployeeDisciplinaryDetail
```

Exact names may differ.

This reduces accidental sensitive-data exposure and simplifies authorization.

Do not rely only on UI hiding fields after the server has already returned them.

---

## 33. Employee Administration UI

Create responsive Phase 3 employee administration views.

At minimum:

```text
Employees
├── Employee List
└── Employee Detail
     ├── Overview
     ├── Locations / Positions
     ├── Certifications
     └── Restricted tabs/sections based on permissions
```

Restricted sections may include:

```text
Personal
Compensation
Documents
Notes
Performance
Disciplinary
```

Do not expose unauthorized data in page loaders/server responses.

Use permission-aware navigation/tabs as a usability layer in addition to server enforcement.

---

## 34. Employee List

The employee list should support useful management fields such as:

```text
employee number
name
preferred name
primary location
primary position
employment status
employment type
```

Do not load compensation, personal address, emergency contacts, disciplinary data, or sensitive documents merely to render the list.

Add basic filtering/search only if it can be implemented cleanly without scope creep.

---

## 35. Employee Detail

The detail screen should present information according to permissions.

General section:

```text
Identity
Employment status/type
Hire date
Work contact
Locations
Positions
```

Management/HR sections appear only when both UI and server authorization permit them.

Do not implement scheduling views within the employee screen during Phase 3.

---

## 36. Employee/User Administration Interaction

Where appropriate, Employee detail can show whether an application User is linked.

Authorized users may be able to:

```text
link existing user
unlink user
navigate to user administration
```

Do not duplicate the Phase 2 User management system inside the Employee module.

Do not silently create a User account when creating an Employee.

---

## 37. Seeds

Extend the idempotent seed framework only where stable reference/configuration records are appropriate.

Recommended Phase 3 seed data:

```text
Positions:
GENERAL_MANAGER
MANAGER
SERVER
BARTENDER
HOST
COOK
WAIT_STAFF
INVENTORY_MANAGER

Certification Types:
FOOD_SAFETY
ALCOHOL_SERVICE
```

Do not seed fake permanent employee records into the normal development/POC seed unless specifically desired.

Use test fixtures for employee data used by automated tests.

Do not use hardcoded UUID values as seed identities.

---

## 38. Certification Expiration Preparation

Phase 3 does not implement alerts/reporting, but certification queries should make future expiration checks straightforward.

Data should support queries such as:

```text
certifications expiring within warning_days
expired certifications
unverified certifications
```

Do not implement scheduled notification jobs yet.

---

## 39. Effective-Dated Data Rules

Effective dates are now important for:

```text
employee locations
employee positions
compensation
addresses where historical tracking is retained
```

Create reusable domain validation where practical for:

```text
effective_from <= effective_to
```

and preventing unintended overlapping active periods.

Do not build a giant generic temporal framework. Keep rules explicit in their owning services.

---

## 40. Concurrency

Use Phase 1 optimistic concurrency for mutable records where appropriate, including:

```text
employees
positions
certification_types
employee_notes if editable
employee_disciplinary_actions if editable
employee_performance_reviews
```

Append-only history records generally do not require optimistic versioning.

Add business-level concurrency tests for employee updates.

---

## 41. Transactions

Use the shared transaction context for operations requiring atomic changes.

Examples:

```text
Create employee + initial location + initial position + status history
Change primary employee location
Change primary position
Change compensation for one Employee + Position and close that pair's previous compensation period
Terminate employee + append history + disable linked user
Verify certification with verifier metadata
```

Do not perform filesystem writes inside a DB transaction in a way that leaves unrecoverable inconsistency if the DB rolls back.

For document upload, coordinate storage and metadata carefully. If file storage succeeds but the DB write fails, clean up the newly stored file where practical.

---

## 42. File Upload Validation

If document upload is implemented in Phase 3 UI/API, establish explicit limits.

At minimum:

- Maximum file size configured centrally.
- Allowed document MIME types configured deliberately.
- Raw filenames sanitized/ignored for storage paths.
- Storage keys generated by the server.
- Authorization performed before accepting upload.
- File contents never executed by the application.
- Files stored outside `public/`.

Do not add broad arbitrary file upload functionality.

---

## 43. Logging and Sensitive Data

Do not log:

```text
personal address
emergency-contact details
compensation amounts unless explicitly necessary in protected audit later
disciplinary descriptions
performance-review narrative
private notes
document contents/passwords/hashes
```

Technical logs should identify operation IDs/entity IDs where useful without copying sensitive content.

Full business audit remains Phase 12.

---

## 44. Authentication/RBAC Regression

Phase 3 must retain Phase 2 behavior:

- Valid authentication
- Invalid-login generic error
- Disabled-user enforcement
- Location-aware permission resolution
- Direct API authorization denial
- Permission-aware navigation
- No public registration

Terminating a linked employee must not create a path that bypasses disabled-user enforcement.

---

## 45. General Employee Authorization Tests

Integration tests should prove:

```text
employees.view can retrieve general employee summary
no employee permission -> denied
employees.edit can update permitted general fields
stale version update -> conflict
cross-organization access -> denied
```

Use isolated test fixtures.

---

## 46. HR Restricted Authorization Tests

Required tests should prove:

```text
employees.view alone cannot read compensation
employees.view alone cannot read personal address
employees.view alone cannot read emergency contacts
employees.view alone cannot read disciplinary records
employees.view alone cannot retrieve sensitive document
```

And:

```text
appropriate HR permission -> allowed
```

Test direct API/query access, not only hidden UI.

---

## 47. User/Employee Link Tests

Test:

```text
link employee to available user -> PASS
link same employee to second user -> DENIED
link already-linked user to second employee -> DENIED
unlink according to permission -> PASS
position change does not change security role
security role change does not change employee position
```

This set of tests protects one of the architecture's most important boundaries.

---

## 48. Position Compensation Tests

Test:

```text
create initial hourly compensation for an employee and position
change hourly rate with new effective date
prior period closes correctly for that employee and position only
employee with two positions holds two independent wages
changing one position wage leaves the other position wage unchanged
two employees in the same position hold different wages
compensation rejected for a position the employee is not assigned to
position has no wage field
history remains intact
salary record validates salary field
invalid mixed hourly/salary values rejected
overlapping compensation period for the same employee and position rejected
non-overlapping periods for different positions of the same employee allowed
unauthorized compensation read denied
unauthorized compensation write denied
exact NUMERIC values preserved as decimal strings
```

Do not convert authoritative monetary values to ordinary JavaScript number arithmetic.

---

## 49. Employment Status Tests

Test:

```text
create employee -> initial status history exists
ACTIVE -> ON_LEAVE appends history
ON_LEAVE -> ACTIVE appends history
terminate employee -> TERMINATED current status
termination date recorded
history preserved
linked user disabled according to documented policy
terminated employee not treated as active
```

Do not delete terminated employees.

---

## 50. Position/Location Tests

Test:

```text
assign valid position at eligible location
reject position assignment at ineligible location
multiple positions supported
primary position consistency
primary location consistency
end assignment preserves history
cross-organization assignment rejected
```

These tests prepare Phase 4 scheduling eligibility.

---

## 51. Certification Tests

Test:

```text
certification type seed idempotency
employee certification creation
organization consistency
expiration-required validation
verification metadata
unauthorized certification access/write denied
```

Do not implement external certification verification services.

---

## 52. Document Storage Tests

Test the local FileStorageService adapter and employee document authorization.

Required concepts:

```text
store file -> returns storage key
metadata stored in PostgreSQL
file not placed under public web root
unauthorized retrieval denied
sensitive document requires restricted permission
invalid/path-traversal filename cannot escape storage root
over-size file rejected
unsupported MIME type rejected according to configured policy
file cleanup behavior on failed metadata operation tested where practical
```

Use disposable test storage directories.

Do not write test documents into permanent development HR storage.

---

## 53. E2E Tests

Add focused browser tests for Phase 3.

At minimum:

### Employee Management

```text
Authorized manager/owner logs in
 -> Employees
 -> Create employee
 -> employee appears in list
 -> open employee detail
```

### Restricted HR

```text
User with general employee permission
 -> employee detail
 -> restricted compensation/disciplinary controls absent
```

### Authorized HR Access

```text
Authorized HR/Owner user
 -> employee detail
 -> restricted HR section available
```

### Termination

If safely testable in an isolated E2E fixture:

```text
linked employee/user terminated
 -> linked user's subsequent protected access denied
```

Do not make browser tests the sole proof of security boundaries.

---

## 54. Migration Requirements

Generate and review the Phase 3 migration.

Verify:

```text
Existing Phase 2 DB
 -> Phase 3 migration
 -> success
```

and:

```text
Empty DB
 -> Phase 1 + Phase 2 + Phase 3 migrations
 -> same expected schema
```

A clean second migration-generation run must show no unexplained drift.

Do not manually modify development DB structure outside migrations.

---

## 55. Reset and Seed Regression

Verify:

```text
npm run db:reset
npm run db:seed
```

recreates:

- Phase 1 infrastructure metadata
- Phase 2 organization/auth/RBAC foundation
- Phase 3 positions/certification-type reference data

without duplicate seed records.

Existing remote/production reset protections must remain unchanged and passing.

---

## 56. Production Dependency Audit

Continue requiring:

```text
npm audit --omit=dev
```

Production dependencies must remain clean or any new finding must be reviewed before Phase 3 is approved.

Do not apply `npm audit fix --force` merely to remove DEV-001 development-tool findings.

If a new runtime dependency is introduced for password/file/document processing, it becomes part of the production dependency audit and must be reviewed normally.

---

## 57. Documentation Updates

Update README/project docs only where Phase 3 operational information needs to be recorded.

Document at minimum:

- Employee/User separation
- Position/Role separation
- Termination-linked-user policy
- HR permission boundaries
- Compensation effective-dating rules
- FileStorageService local adapter behavior
- Local HR document storage path/configuration
- File size/type restrictions
- Phase 3 seed records
- Administrative workflow overview

Do not rewrite unrelated architecture sections.

---

## 58. Phase 3 Validation Checklist

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

Verify seed idempotency.

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
PostgreSQL health                 PASS
/api/health                       PASS
migration generation              PASS
migration application             PASS
empty DB reconstruction           PASS
schema drift                      NONE
seed idempotency                  PASS
reset safeguards                  PASS
Phase 2 auth/RBAC regression      PASS
employee creation                 PASS
employee location rules           PASS
employee position rules           PASS
User/Employee unique link         PASS
Position/Role separation          PASS
status history                    PASS
termination workflow              PASS
compensation history              PASS
compensation authorization        PASS
personal-data authorization       PASS
disciplinary authorization       PASS
certification rules               PASS
FileStorageService                PASS
sensitive document authorization PASS
production dependency audit       CLEAN
```

---

## 59. Phase 3 Deliverables

Phase 3 should leave the repository with:

```text
✓ employees
✓ employee_locations
✓ positions
✓ employee_positions
✓ employee_addresses
✓ employee_emergency_contacts
✓ employee_position_compensation
✓ certification_types
✓ employee_certifications
✓ employee_documents
✓ employee_notes
✓ employee_disciplinary_actions
✓ employee_performance_reviews
✓ employee_status_history

✓ optional one-to-one User/Employee relationship
✓ explicit Position != Security Role boundary

✓ employee creation workflow
✓ employee location management
✓ employee position management
✓ status-change workflow
✓ termination workflow
✓ linked-user disable policy
✓ compensation history workflow
✓ certification management foundation
✓ document metadata/storage workflow
✓ performance/disciplinary foundation

✓ granular HR permissions
✓ server-side sensitive-data authorization
✓ purpose-specific employee/HR DTOs
✓ responsive Employee administration UI

✓ local FileStorageService adapter
✓ protected HR document retrieval
✓ upload-size/type/path protections

✓ idempotent Position seeds
✓ idempotent Certification Type seeds

✓ migrations/reconstruction green
✓ authentication/RBAC regressions green
✓ HR integration tests green
✓ Phase 3 E2E tests green
✓ production dependency audit clean
✓ no Phase 4+ functionality prematurely implemented
```

---

## 60. Phase 3 Definition of Done

Phase 3 is complete when an authorized application user can:

```text
Create Employee
      |
      +-- assign eligible restaurant location
      +-- assign one or more employee positions
      +-- preserve initial status history
      |
      v
Manage appropriate HR information
      |
      +-- certifications
      +-- position compensation history if authorized
      +-- personal data if authorized
      +-- documents if authorized
      +-- performance/disciplinary records if authorized
```

and the application proves that:

- A general employee viewer cannot retrieve restricted HR data.
- User and Employee identities remain separate.
- Security Roles and Employee Positions remain separate.
- Employee history is preserved rather than overwritten.
- Compensation is effective-dated.
- Termination does not delete the employee.
- Termination handles linked application access according to the documented policy.
- Files remain outside PostgreSQL and outside public static storage.
- Sensitive file retrieval is authorized server-side.
- Database reconstruction requires no manual SQL.
- Phase 0 through Phase 2 regressions remain green.

Phase 3 is not complete if compensation or disciplinary data is returned to users with only `employees.view`.

Phase 3 is not complete if creating a position assignment silently grants a security role.

Phase 3 is not complete if employee documents are publicly addressable without authorization.

---

## 61. Required Phase 3 Completion Report

When Phase 3 is complete, provide:

```text
PHASE 3 COMPLETION REPORT

Environment
- Node version:
- npm version:
- Next.js version:
- PostgreSQL version:
- Drizzle ORM version:
- Drizzle Kit version:
- Auth library/version:
- File storage adapter:

Employee Schema
- employees: PASS / FAIL
- employee_locations: PASS / FAIL
- positions: PASS / FAIL
- employee_positions: PASS / FAIL
- employee_addresses: PASS / FAIL
- employee_emergency_contacts: PASS / FAIL
- employee_position_compensation: PASS / FAIL
- certification_types: PASS / FAIL
- employee_certifications: PASS / FAIL
- employee_documents: PASS / FAIL
- employee_notes: PASS / FAIL
- employee_disciplinary_actions: PASS / FAIL
- employee_performance_reviews: PASS / FAIL
- employee_status_history: PASS / FAIL

Identity Boundaries
- User/Employee optional 1:1: PASS / FAIL
- Duplicate User/Employee links rejected: PASS / FAIL
- Position does not grant Security Role: PASS / FAIL
- Security Role does not create Position: PASS / FAIL

Employee Workflows
- Employee creation: PASS / FAIL
- Initial status history: PASS / FAIL
- Location assignment: PASS / FAIL
- Position assignment: PASS / FAIL
- Primary location consistency: PASS / FAIL
- Primary position consistency: PASS / FAIL
- Status changes: PASS / FAIL
- Termination: PASS / FAIL
- Linked-user termination policy: PASS / FAIL

Compensation
- Effective-dated history: PASS / FAIL
- Previous period closure: PASS / FAIL
- Per Employee + Position wage independence: PASS / FAIL
- Assignment-required rule: PASS / FAIL
- Overlap validation: PASS / FAIL
- HOURLY validation: PASS / FAIL
- SALARY validation: PASS / FAIL
- Exact NUMERIC handling: PASS / FAIL
- Restricted read authorization: PASS / FAIL
- Restricted write authorization: PASS / FAIL

HR Security
- General employee DTO excludes restricted HR data: PASS / FAIL
- Personal data authorization: PASS / FAIL
- Emergency contact authorization: PASS / FAIL
- Compensation authorization: PASS / FAIL
- Disciplinary authorization: PASS / FAIL
- Performance authorization: PASS / FAIL
- Sensitive notes authorization: PASS / FAIL
- Sensitive document authorization: PASS / FAIL
- Direct API unauthorized access denied: PASS / FAIL

Certifications
- Certification type seed: PASS / FAIL
- Employee certification creation: PASS / FAIL
- Expiration-required validation: PASS / FAIL
- Verification metadata: PASS / FAIL

File Storage
- Local FileStorageService: PASS / FAIL
- Files outside PostgreSQL: PASS / FAIL
- Files outside public web root: PASS / FAIL
- Safe generated storage keys: PASS / FAIL
- Path traversal protections: PASS / FAIL
- File size validation: PASS / FAIL
- MIME type validation: PASS / FAIL
- Authorized retrieval: PASS / FAIL
- Sensitive retrieval denial: PASS / FAIL

Seed Data
- Positions: PASS / FAIL
- Certification types: PASS / FAIL
- Seed idempotency: PASS / FAIL

Migrations
- Generation: PASS / FAIL
- Application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Regression
- Phase 1 foundation tests: PASS / FAIL
- Phase 2 auth/RBAC tests: PASS / FAIL
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

Business Domains Created Beyond Phase 3
- NONE expected

Created / Modified
- Summarize schemas, migration, employee/HR modules, storage adapter, permissions, UI, tests, seeds, and documentation.

Architecture Deviations
- None
  OR
- Describe each deviation and why it was necessary.

Outstanding Phase 3 Issues
- None
  OR
- List each unresolved issue and whether it blocks Phase 4.

Phase 4 Readiness
- READY / NOT READY
```

---

## 62. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-3-Employees-HR.md`, use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 3 implementation plans completely. Treat `README.md` as the architectural source of truth.
>
> Review the completed Phase 0, Phase 1, and Phase 2 implementation before modifying files. Implement Phase 3 only: Employees and HR, including employees, employee locations, configurable positions, employee position assignments, the optional one-to-one User/Employee link, addresses, emergency contacts, effective-dated compensation per Employee and Position, certification types and employee certifications, employee document metadata and local FileStorageService integration, notes, disciplinary actions, performance reviews, employee status history, HR permission boundaries, minimal responsive Employee administration UI, Phase 3 seeds, and the required automated tests.
>
> Preserve the critical boundaries: User is not Employee; Security Role is not Employee Position. Creating or changing an Employee Position must not automatically create or change a Security Role, and changing a Security Role must not automatically create or change an Employee Position.
>
> Do not implement Scheduling, shifts, automatic schedule generation, physical seating, reservations, menu, recipes, inventory, orders, kitchen, settlements, reporting, AWS/S3 deployment, payroll, or other later-phase functionality.
>
> Preserve Phase 1 database conventions, exact numeric handling, migration lifecycle, transaction context, isolated integration database, reset safeguards, and Phase 2 authentication/location-aware RBAC. Preserve DEV-001 unless dependency changes justify an intentional review.
>
> Before modifying files, inspect the current repository and provide a concise Phase 3 execution plan. After implementation, run the complete Phase 3 validation suite and provide the full Phase 3 Completion Report. If an architectural conflict or significant security/data-retention decision is encountered, stop at that decision point and explain the conflict, options, recommendation, and architectural impact before altering the approved architecture.

---


## Final Guardrail

Phase 3 establishes the restaurant's workforce and HR data foundation.

The successful architecture remains:

```text
Employee
   |
   +-- Employment / HR information
   +-- Employee Location eligibility
   +-- Employee Position assignments
   |
   +-- Optional link to User

User
   |
   +-- Authentication
   +-- Security Roles
   +-- Permissions
```

These concepts collaborate but remain independently governed.

Phase 4 Scheduling will build on Employee Locations, Employee Positions, Employment Status, and the HR foundation created here.
