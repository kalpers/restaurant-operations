# Phase 2: Organization, Authentication & RBAC Implementation Plan

## Purpose

Phase 2 implements the first production business domains for the Restaurant Operations Management System: Organization, Locations, Restaurant Areas, Users, Authentication, Sessions, Roles, Permissions, and location-aware Role-Based Access Control (RBAC).

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/Phase-0-Implementation-Plan.md`
4. `docs/Phase-1-Database-Foundation.md`
5. `docs/accepted-risks.md`
6. This document

`README.md` remains the architectural source of truth.

Phase 2 must build on the completed Phase 0 and Phase 1 foundations without weakening the established database, migration, transaction, testing, reset-safety, security, or dependency-risk decisions.

---

## 1. Phase 2 Objectives

Implement the first real restaurant application domains:

```text
Organization
    |
    +-- Location
          |
          +-- Location Settings
          |
          +-- Dining Room
          +-- Bar
          +-- Takeout

Authenticated User
    |
    +-- User Roles
          |
          +-- Role
                |
                +-- Role Permissions
                      |
                      +-- Permission
```

Phase 2 must deliver:

- Organization persistence and management foundation
- Location persistence and management foundation
- Location settings
- Restaurant areas
- Application users
- Authentication
- Session management
- Logout
- Disabled-user enforcement
- Roles
- Permissions
- Role-permission assignments
- Location-aware user-role assignments
- Central permission resolution
- Server-side permission enforcement
- Protected application shell
- Permission-aware navigation
- Secure first-owner bootstrap
- Idempotent Phase 2 seed data
- Authentication and authorization integration tests
- Browser E2E authentication tests

---

## 2. Critical Concept Boundaries

Preserve the following distinctions throughout the implementation:

```text
Authentication
"Who are you?"

        !=

Authorization
"What may you do?"

        !=

Employee Position
"What job do you perform?"
```

A security role is not an employee position.

A user account is not an employee record.

Employee records and employee positions belong to Phase 3.

Do not create an employee table or HR functionality in Phase 2 merely to support user authentication.

---

## 3. Scope Boundary

Do not implement these future domains during Phase 2:

```text
employees
employee_positions
employee_position_compensation
employee_certifications
scheduling
restaurant_tables
table_sessions
reservations
waitlist
menu_items
modifier_groups
recipes
inventory_items
suppliers
purchase_orders
orders
kitchen_tickets
order_settlements
reporting
```

Do not add a public registration flow.

Do not implement payment processing.

Do not implement AWS deployment in Phase 2. AWS POC deployment remains deferred.

---

## 4. Review Existing Foundation Before Changes

Before modifying files, inspect the repository and confirm:

- Phase 0 validation remains green.
- Phase 1 database foundation tests remain green.
- PostgreSQL is healthy.
- Existing database connection handling is understood.
- Existing Drizzle schema exports are understood.
- Existing migration workflow is understood.
- `withTransaction(...)` or the existing transaction helper is understood.
- Development/test database separation remains intact.
- `db:reset` safety rules remain intact.
- Seed framework and `seed_runs` behavior are understood.
- Existing CI workflow is understood.
- `DEV-001` in `docs/accepted-risks.md` is preserved.

Before coding, provide a concise Phase 2 execution plan based on the actual repository state.

---

## 5. Organization Schema

Create the first business table:

```text
organizations
```

Conceptual fields:

```text
id                    UUID PK
name                  required
legal_name            nullable
phone                 nullable
email                 nullable
default_timezone      required
default_currency      required
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Use the Phase 1 UUID, timestamp, active, and concurrency conventions.

Initial development/POC timezone:

```text
America/Detroit
```

Initial currency:

```text
USD
```

Do not implement SaaS tenant switching. The organization boundary exists primarily to support multiple locations in the future.

---

## 6. Location Schema

Create:

```text
locations
```

Conceptual fields:

```text
id                    UUID PK
organization_id       UUID FK
name                  required
location_code         required
address_line1         nullable or required according to service rules
address_line2         nullable
city                  nullable or required according to service rules
state                 nullable or required according to service rules
postal_code           nullable or required according to service rules
country               required, default US if appropriate
phone                 nullable
email                 nullable
timezone              required
active                BOOLEAN default TRUE
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Relationship:

```text
Organization 1 -> many Locations
```

Required database constraint:

```text
UNIQUE (organization_id, location_code)
```

Initial Phase 2 deployment uses one location but must not hardcode a single-location assumption into the schema or authorization model.

---

## 7. Location Settings Schema

Create:

```text
location_settings
```

Use structured columns rather than an unrestricted generic JSON settings bag.

Initial concepts may include:

```text
location_id                           UUID PK/FK or unique FK
business_day_cutoff                  time-like setting
default_table_turn_minutes           integer
default_reservation_duration_minutes integer
default_wait_quote_minutes           integer
allow_walk_ins                       boolean
allow_reservations                   boolean
allow_takeout                        boolean
inventory_enabled                    boolean
scheduling_enabled                   boolean
kitchen_display_enabled              boolean
created_at                           TIMESTAMPTZ
updated_at                           TIMESTAMPTZ
version                              INTEGER default 1
```

Choose reasonable POC defaults and document them.

Do not add speculative settings unrelated to already approved requirements.

---

## 8. Restaurant Areas Schema

Create:

```text
restaurant_areas
```

Conceptual fields:

```text
id              UUID PK
location_id     UUID FK
code            required
name            required
area_type       required
display_order   integer
active          BOOLEAN default TRUE
created_at      TIMESTAMPTZ
updated_at      TIMESTAMPTZ
```

Required constraint:

```text
UNIQUE (location_id, code)
```

Initial seeded areas:

```text
Code          Name
DINING_ROOM   Dining Room
BAR           Bar
TAKEOUT       Takeout
```

Do not create physical restaurant tables in Phase 2. Physical tables belong to the Restaurant/Seating phase.

---

## 9. Authentication Strategy

Use an established authentication library compatible with the current Next.js App Router, PostgreSQL, and Drizzle stack.

Before installing or configuring authentication packages:

1. Inspect the repository's exact Next.js and Drizzle versions.
2. Verify compatibility with the selected authentication library.
3. Prefer documented current integration patterns.
4. Do not copy an outdated tutorial or introduce an abandoned authentication package.
5. Keep library-specific types and details behind the `auth` module/infrastructure boundary where practical.

Auth.js is consistent with the approved architecture if compatible with the installed stack, but the implementation must verify package/version compatibility before adoption.

Do not replace the application's own RBAC schema simply because the authentication library exposes role-like session metadata.

---

## 10. Authentication vs Application Authorization

The authentication library owns mechanics such as:

```text
credential verification
session creation
session cookie handling
session resolution
logout
```

The application owns:

```text
users
active/disabled status
roles
permissions
role_permissions
user_roles
location scope
```

Conceptually:

```text
Authentication Library
        |
        v
Authenticated Identity
        |
        v
Application User
        |
        v
Roles + Permissions + Location Scope
```

The rest of the application should depend on an application-facing current-user/auth context rather than scattered direct library calls.

---

## 11. Users Schema

Create:

```text
users
```

Conceptual fields:

```text
id                    UUID PK
email                 required
normalized_email      required unique
username              nullable
password_hash         nullable/required according to chosen credential model
active                BOOLEAN default TRUE
email_verified_at     nullable
last_login_at         nullable
disabled_at           nullable
created_at            TIMESTAMPTZ
updated_at            TIMESTAMPTZ
version               INTEGER default 1
```

Do not create an employee foreign key unless the Phase 3 employee table exists. Add that relationship in Phase 3.

Use email as the primary POC login identifier.

Username may remain optional.

---

## 12. Email Normalization

Establish one consistent service-level normalization rule.

Prevent duplicate accounts caused by email casing differences such as:

```text
Kneale@example.com
kneale@example.com
```

Use PostgreSQL uniqueness as the final integrity boundary.

The normalization strategy must be deterministic and tested.

Do not rely solely on the UI to prevent duplicate identities.

---

## 13. Password and Credential Security

If application-owned credential authentication is used:

- Never store plaintext passwords.
- Use an accepted password-hashing implementation.
- Use a password-hash format that embeds its algorithm/work parameters or otherwise supports secure upgrades.
- Never log passwords.
- Never log password hashes.
- Never include password hashes in DTOs/API responses.
- Never place password hashes into audit metadata.
- Never seed a known default password into source control.

Login error behavior should normally be generic:

```text
Invalid email or password
```

Do not disclose whether an account exists.

Do not implement password-reset/email recovery in Phase 2 unless required to make the chosen authentication library functional. Account recovery can be a later capability.

---

## 14. No Public Registration

Do not implement:

```text
/signup
/register
public account creation
```

This is internal restaurant operations software.

Users are provisioned by authorized administration workflows.

The first user is created using the secure Owner bootstrap mechanism defined later in this plan.

---

## 15. Roles Schema

Create:

```text
roles
```

Conceptual fields:

```text
id                  UUID PK
organization_id     UUID FK
code                required
name                required
description         nullable
system_role         boolean
active              BOOLEAN default TRUE
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
version             INTEGER default 1
```

Required constraint:

```text
UNIQUE (organization_id, code)
```

Initial role codes:

```text
OWNER
GENERAL_MANAGER
MANAGER
SERVER
BARTENDER
HOST
COOK
WAIT_STAFF
INVENTORY_MANAGER
```

Roles are configurable database entities, not PostgreSQL enums.

---

## 16. Permissions Schema

Create:

```text
permissions
```

Conceptual fields:

```text
id            UUID PK
code          required unique
name          required
description   nullable
category      required
created_at    TIMESTAMPTZ
```

Permission codes use:

```text
domain.action
```

Examples:

```text
admin.users.view
admin.users.manage
admin.roles.view
admin.roles.manage
organization.view
organization.manage
locations.view
locations.manage
employees.view
employees.edit
hr.view
hr.compensation.view
hr.compensation.edit
schedule.view
schedule.edit
schedule.generate
schedule.publish
restaurant.view
restaurant.manage
reservations.view
reservations.manage
menu.view
menu.edit
inventory.view
inventory.receive
inventory.adjust
inventory.count
orders.create
orders.submit
orders.void
orders.close
kitchen.view
kitchen.manage
reports.sales.view
reports.inventory.view
reports.labor.view
audit.view
```

It is acceptable to seed planned permission codes before those domains are implemented.

Do not create placeholder domain services merely because a permission exists.

---

## 17. Central Permission Catalog

Create one authoritative permission-code definition used by:

- Seed logic
- Authorization services
- Tests
- Navigation access checks where appropriate

Avoid multiple spellings for the same capability.

Do not independently invent variations such as:

```text
inventory.edit
inventory.modify
inventory.update
```

unless they intentionally represent different capabilities.

Use stable permission codes because role assignments and future audit records depend upon them.

---

## 18. Role Permissions Schema

Create:

```text
role_permissions
```

Conceptual keys:

```text
role_id        UUID FK
permission_id  UUID FK
```

Required uniqueness:

```text
UNIQUE (role_id, permission_id)
```

Relationship:

```text
Role many <-> many Permission
```

Choose explicit FK delete behavior and document it.

Deleting normal business/security history by cascading from an organization should not be casually possible.

---

## 19. User Roles Schema

Create:

```text
user_roles
```

Conceptual fields:

```text
id                        UUID PK if useful
user_id                   UUID FK
role_id                   UUID FK
location_id               UUID FK
assigned_at               TIMESTAMPTZ
assigned_by_user_id       nullable UUID FK
active                    BOOLEAN default TRUE
```

Role assignments are location-aware.

Conceptually:

```text
User Jane
  Location A -> SERVER
  Location B -> BARTENDER
```

Only one business location is currently seeded, but authorization logic must not assume that will always be true.

Prevent duplicate equivalent role assignments with appropriate constraints.

---

## 20. Permission Resolution Service

Create one authoritative permission service under the Auth/Security domain.

It should support concepts such as:

```text
getUserPermissions(...)
hasPermission(...)
requirePermission(...)
```

Exact names may vary.

Permission resolution should consider:

```text
user active?
user role assignment active?
role active?
role assigned for requested location?
role permissions
```

Inactive users or inactive role assignments must not grant permissions.

---

## 21. Location-Aware Authorization

Authorization must support a location context.

Conceptually:

```text
requirePermission({
  permission: "orders.create",
  locationId
})
```

The single-location POC must not hardcode the seeded location ID into authorization logic.

Integration tests should use temporary second-location fixture data to prove that authorization at Location A does not automatically authorize Location B.

Do not seed a second permanent POC location solely for testing.

---

## 22. Server-Side Authorization Guard

Create a reusable server-side authorization guard.

Protected route handlers, server actions, commands, and queries must enforce permissions server-side.

Do not implement authorization only through navigation visibility.

Bad:

```text
Hide button from Server
but protected API accepts request
```

Correct:

```text
Hide button for usability
AND
server rejects unauthorized request
```

Do not use hard-coded role checks when a permission check is the correct business rule.

Avoid:

```text
if role == MANAGER
```

Prefer:

```text
requirePermission("inventory.adjust")
```

---

## 23. Current User/Application Auth Context

Create an application-facing representation of the signed-in user.

Conceptual safe fields:

```text
id
email
active
roles
permissions
authorized location IDs
```

Do not return:

```text
password_hash
session secrets
raw auth tokens
internal adapter secrets
```

Keep authentication-library-specific details behind the auth boundary where practical.

---

## 24. Session Management

Use the selected authentication library's supported session model.

Requirements:

- Secure session resolution on the server.
- Appropriate cookie security settings for the environment.
- Logout ends application access.
- Protected routes require an authenticated session.
- Disabled users are denied on subsequent protected operations.
- Session logic is compatible with the current Next.js App Router implementation.

Document whether the implementation uses database sessions, JWT-backed sessions, or another supported strategy, and explain why it is appropriate for this POC.

Do not build a custom session-token framework when the selected library already safely provides it.

---

## 25. Disabled User Enforcement

Disabling a user must have meaningful security effect.

Required scenario:

```text
User logs in successfully
        |
        v
Administrator disables user
        |
        v
User attempts next protected operation
        |
        v
ACCESS DENIED
```

The implementation must not rely on a very long-lived client state that remains trusted after account deactivation.

Test the chosen session strategy's behavior explicitly.

---

## 26. Login Page

Create a responsive login page:

```text
/login
```

Fields:

```text
Email
Password
```

Requirements:

- Touch-friendly and desktop-friendly.
- Server-side credential validation.
- Generic invalid-login response.
- No public registration link.
- No password echoed in logs or errors.
- Successful login redirects into the protected application shell.

Do not build the final restaurant visual design yet. Use a polished but simple Phase 2 UI.

---

## 27. Logout

Implement a clear logout action.

After logout:

```text
protected URLs -> authentication required
```

Validate using integration and/or E2E testing as appropriate.

---

## 28. Protected Application Shell

Establish an authenticated application route group, consistent with the approved architecture, for example:

```text
src/app/(app)/
```

Public:

```text
/login
/api/health
```

Protected application area:

```text
dashboard
administration
```

Do not scaffold every future restaurant page.

Create only the minimum Phase 2 shell needed to prove authentication and role-aware navigation.

---

## 29. Permission-Aware Navigation

Navigation should show available features based on resolved permissions.

Example:

```text
admin.users.view
  -> Users administration navigation is visible
```

But navigation filtering is only a usability layer.

The protected server operation must independently enforce authorization.

Use one authorization vocabulary between server-side behavior and UI access decisions.

---

## 30. Phase 2 Administration UI

Implement minimal useful Phase 2 administration views as justified by the existing application structure.

Potential sections:

```text
Administration
├── Organization
├── Locations
├── Restaurant Areas
├── Users
├── Roles
└── Permissions
```

Prioritize:

1. Correctness
2. Server-side authorization
3. Responsive usability
4. Clear validation/errors

Do not spend Phase 2 building a large design system or implementing later-domain screens.

---

## 31. Secure Owner Bootstrap

Provide a controlled way to create the first Owner application account.

Use a script/command conceptually such as:

```text
npm run bootstrap:owner
```

or another clear equivalent.

Requirements:

- Accept or request an explicit owner email.
- Obtain the password securely for the chosen environment.
- Do not commit the password.
- Hash the password if using application-owned credentials.
- Do not print plaintext password or hash.
- Locate the seeded organization and main location.
- Create or safely handle an existing user.
- Assign the Owner role at the main location.
- Be safe to retry without creating duplicate users or role assignments.
- Fail clearly if the organization/location/role seed foundation is missing.

Do not create a permanent default owner password.

---

## 32. Initial Organization Seed

Use the Phase 1 idempotent seed framework.

Seed one stable initial organization.

Suggested development/POC name:

```text
Restaurant Operations POC
```

Use stable seed keys/codes rather than depending on fixed UUID values.

Initial values:

```text
default_timezone = America/Detroit
default_currency = USD
active = true
```

The name should remain configuration/seed data, not hardcoded into domain logic.

---

## 33. Initial Location Seed

Seed one main location:

```text
name = Main Restaurant
location_code = MAIN
timezone = America/Detroit
active = true
```

Use appropriate POC address defaults only if they are intentionally configured. Do not invent a real street address.

Location seed must be idempotent.

---

## 34. Initial Location Settings Seed

Seed the main location's settings with documented POC defaults.

Examples that should be intentionally chosen and documented:

```text
business_day_cutoff
default_table_turn_minutes
default_reservation_duration_minutes
default_wait_quote_minutes
allow_walk_ins
allow_reservations
allow_takeout
inventory_enabled
scheduling_enabled
kitchen_display_enabled
```

The exact defaults should align with the architecture and upcoming phases.

---

## 35. Initial Restaurant Area Seed

Seed exactly these initial areas:

```text
DINING_ROOM -> Dining Room
BAR         -> Bar
TAKEOUT     -> Takeout
```

Each belongs to the Main Restaurant location.

Repeated seed execution must not duplicate areas.

---

## 36. Initial Role Seed

Seed these stable role codes:

```text
OWNER
GENERAL_MANAGER
MANAGER
SERVER
BARTENDER
HOST
COOK
WAIT_STAFF
INVENTORY_MANAGER
```

Role IDs may differ across databases. Stable `code` values are the business identity used by the seed process.

Do not use roles as a replacement for employee positions later.

---

## 37. Initial Permission Seed

Seed a centralized permission catalog sufficient for the planned application.

At minimum include Phase 2 permissions plus stable planned permissions needed by the approved architecture.

Group/category permissions logically, for example:

```text
Administration
Organization
Employees / HR
Scheduling
Restaurant / Seating
Reservations
Menu
Inventory
Orders
Kitchen
Reports
Audit
```

Permission seed must be idempotent.

Do not create feature implementations for later permissions.

---

## 38. Initial Role-Permission Matrix

Create an explicit, source-controlled seed mapping.

### Owner

Grant all seeded application permissions.

### General Manager

Grant broad restaurant operational, scheduling, employee-management, order, menu, inventory, reservation, and reporting capabilities according to the architecture. Keep intentionally owner-only administrative/security capabilities limited if the permission model supports that distinction.

### Manager

Grant day-to-day operational permissions without automatically granting restricted HR/security administration.

### Server

Plan permissions such as:

```text
restaurant.view
menu.view
orders.create
orders.submit
schedule.view
```

### Bartender

Grant appropriate bar/order/menu/schedule access according to the same permission-based model.

### Host

Plan permissions such as:

```text
restaurant.view
restaurant.manage
reservations.view
reservations.manage
```

### Cook

Plan permissions such as:

```text
kitchen.view
kitchen.manage
schedule.view
```

### Wait Staff

Grant the deliberately chosen operational subset; do not simply duplicate another role without documenting why.

### Inventory Manager

Plan permissions such as:

```text
inventory.view
inventory.receive
inventory.adjust
inventory.count
```

Document the final Phase 2 starting matrix in seed definitions and/or project documentation.

Tests should verify representative allow/deny behavior rather than only counting rows.

---

## 39. Planned Permissions vs Implemented Features

It is acceptable for the Phase 2 permission catalog to include future application capabilities such as:

```text
inventory.adjust
orders.submit
schedule.publish
```

before those modules are implemented.

Do not create empty modules, APIs, or UI pages simply so every seeded permission has a Phase 2 feature.

---

## 40. Database Constraints

Use PostgreSQL constraints as the final integrity layer.

Required concepts include:

```text
locations:
  FK organization_id
  UNIQUE organization_id + location_code

restaurant_areas:
  FK location_id
  UNIQUE location_id + code

users:
  UNIQUE normalized_email

roles:
  FK organization_id
  UNIQUE organization_id + code

permissions:
  UNIQUE code

role_permissions:
  FK role_id
  FK permission_id
  UNIQUE role_id + permission_id

user_roles:
  FK user_id
  FK role_id
  FK location_id
  prevent duplicate equivalent assignment
```

Add indexes for demonstrated authorization/query access patterns, not indiscriminately.

---

## 41. Referential Delete Behavior

Choose foreign-key delete behavior deliberately.

Major business/security entities should usually be deactivated rather than hard-deleted.

Do not configure a delete on `organizations` to casually cascade through all location/security data.

Join records may use carefully selected cascade behavior where deletion is intentional and safe, but document meaningful cascade decisions.

Historical and security-sensitive data should not disappear unexpectedly.

---

## 42. Concurrency

Use the Phase 1 optimistic concurrency convention on mutable entities where defined by this plan, including as appropriate:

```text
organizations
locations
location_settings
users
roles
```

Service updates should compare the expected version and increment on successful changes where concurrency protection is required.

Add focused tests for at least one Phase 2 business entity in addition to the Phase 1 fixture-level concurrency coverage.

---

## 43. Transactions

Use Phase 1's shared transaction context for multi-record security operations.

Examples that should be atomic where applicable:

```text
Create user + assign initial role
Role permission replacement/update
Owner bootstrap user + owner role assignment
Organization seed + related location/settings/area seed steps where appropriate
```

Do not bypass the established transaction executor.

---

## 44. Audit Readiness

Full audit implementation remains Phase 12.

Phase 2 service/command boundaries should nevertheless make future auditing straightforward for events such as:

```text
user created
user disabled
user enabled
role created
role assigned
role removed
role permissions changed
organization changed
location changed
```

Do not implement a parallel ad-hoc audit table in Phase 2.

Do not log sensitive credential data while preparing for future auditing.

---

## 45. Authentication Unit/Integration Tests

Cover at least:

```text
valid credentials
invalid password
unknown email
disabled user
session creation/session retrieval
logout
protected route without session
protected route with valid session
```

If exact authentication-library mechanics make a test more appropriate at E2E level, retain strong server-side integration coverage for the application authorization layer.

---

## 46. Authorization Integration Tests

Test concrete permission behavior, including:

```text
Owner receives expected permissions
Server does not receive owner-only administration permissions
Role permission grant becomes effective
Role permission removal becomes effective
Inactive role does not grant permissions
Inactive user is denied
Inactive user-role assignment is ignored
Location-scoped role applies at Location A
Same role does not automatically apply at Location B
```

Use isolated fixture locations/users for cross-location tests.

---

## 47. Direct API Authorization Test

Protect at least one real Phase 2 server operation and test direct unauthorized access.

Required scenario:

```text
Unauthorized authenticated user
       |
       v
Directly invokes protected endpoint/action
       |
       v
Server rejects request
```

The test must not rely on the navigation link being hidden.

---

## 48. E2E Tests

Expand Playwright coverage while preserving the Phase 0 health/basic regression test.

### Valid Login

```text
Open /login
Enter owner credentials
Authenticate
Reach protected application shell
```

### Invalid Login

```text
Enter invalid credentials
Receive generic authentication error
Remain unauthenticated
```

### Logout

```text
Authenticated
 -> logout
 -> protected page requires authentication
```

### Permission-Aware Navigation

Use representative accounts/roles to verify navigation differences.

Do not treat this test as the only authorization test.

---

## 49. Seed Idempotency Validation

Run:

```text
npm run db:seed
npm run db:seed
```

Verify there are no duplicates.

Expected stable business data includes:

```text
1 initial organization
1 main location
1 location-settings row
3 initial restaurant areas
9 initial role definitions
expected permission count
expected role-permission mappings
```

Do not assert hardcoded UUID values.

---

## 50. Migration Lifecycle

Generate and review the first substantial business-domain migration.

Verify:

```text
Existing Phase 1 database
   -> Phase 2 migration
   -> success
```

and:

```text
Empty database
   -> all Phase 1 + Phase 2 migrations
   -> same expected schema
```

A second clean `db:generate` should report no unexplained drift.

No manual SQL repair steps are allowed.

---

## 51. Development Reset Regression

After Phase 2 implementation, verify the local lifecycle:

```text
npm run db:reset
npm run db:seed
```

The result should contain the Phase 2 organization/security seed foundation.

Then the Owner bootstrap should create the initial authenticated administrator safely.

The Phase 1 reset guard must still reject production-like/remote targets.

---

## 52. Accepted Risk Handling

Preserve:

```text
DEV-001: Development Tooling Dependency Advisory
```

Do not run incompatible forced dependency remediation simply to obtain a clean development-only audit result.

Continue requiring:

```text
npm audit --omit=dev
```

to remain clean for production dependencies.

If dependency upgrades change the advisory state, update `docs/accepted-risks.md` intentionally.

---

## 53. Documentation Updates

Update project documentation for Phase 2 operational needs, including as appropriate:

- Authentication model chosen
- Session strategy chosen
- Owner bootstrap command
- Login/logout behavior
- Permission naming convention
- Location-aware authorization behavior
- Initial role list
- Initial permission catalog/matrix
- Seed behavior
- User provisioning boundaries

Do not replace or substantially rewrite the architectural source-of-truth sections unless an explicitly approved architecture change is necessary.

---

## 54. Phase 2 Validation Checklist

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

Verify the second seed run remains idempotent.

Run local reset regression in the safe development environment:

```text
npm run db:reset
npm run db:seed
```

Run Owner bootstrap using the documented secure process.

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
PostgreSQL health              PASS
/api/health                    PASS
migration generation           PASS
migration application          PASS
empty DB reconstruction        PASS
schema drift                   NONE
seed idempotency               PASS
reset safeguards               PASS
owner bootstrap                PASS
login                          PASS
invalid login                  PASS
logout                         PASS
disabled user denial           PASS
permission resolution          PASS
direct API authorization       PASS
location-aware RBAC            PASS
permission-aware navigation    PASS
production dependency audit    CLEAN
```

---

## 55. Phase 2 Deliverables

Phase 2 should leave the repository with:

```text
✓ organizations
✓ locations
✓ location_settings
✓ restaurant_areas

✓ users
✓ roles
✓ permissions
✓ role_permissions
✓ user_roles

✓ authentication-library integration
✓ current-user/application auth context
✓ login
✓ logout
✓ session validation
✓ disabled-account enforcement

✓ centralized permission catalog
✓ permission resolution service
✓ server-side permission guard
✓ location-aware authorization

✓ protected application shell
✓ permission-aware navigation
✓ minimal Phase 2 administration UI

✓ idempotent organization seed
✓ idempotent main-location seed
✓ idempotent location-settings seed
✓ Dining Room / Bar / Takeout seeds
✓ initial roles
✓ initial permission catalog
✓ initial role-permission matrix

✓ secure owner bootstrap
✓ no public registration
✓ no hardcoded default password

✓ authentication tests
✓ authorization tests
✓ location-scope tests
✓ security E2E tests

✓ Phase 0/1 regressions remain green
✓ production dependency audit remains clean
✓ DEV-001 remains tracked
✓ no Employees/HR or later domains prematurely implemented
```

---

## 56. Phase 2 Definition of Done

Phase 2 is complete when a fresh safe local database can execute:

```text
Empty PostgreSQL
       |
       v
All migrations
       |
       v
Phase 2 seeds
       |
       v
Secure Owner bootstrap
       |
       v
Owner login
       |
       v
Authenticated application shell
       |
       v
Roles and permissions resolved
       |
       v
Protected server operations enforced
```

Additionally:

- An unauthorized authenticated user cannot bypass permissions by directly calling a protected operation.
- A role assigned at one fixture location does not automatically authorize another location.
- Disabling a user prevents subsequent protected access.
- Re-running seed commands creates no duplicate stable records.
- Database reconstruction requires no manual SQL.
- Phase 1 reset safeguards remain effective.
- Production dependency audit remains clean.

Phase 2 is not complete if UI visibility is the only authorization mechanism.

Phase 2 is not complete if public registration exists.

Phase 2 is not complete if employee positions and security roles are merged.

---

## 57. Required Phase 2 Completion Report

When Phase 2 implementation is complete, provide:

```text
PHASE 2 COMPLETION REPORT

Environment
- Node version:
- npm version:
- Next.js version:
- PostgreSQL version:
- Drizzle ORM version:
- Drizzle Kit version:
- Authentication library/version:
- Password hashing implementation/version if applicable:

Organization Domain
- organizations: PASS / FAIL
- locations: PASS / FAIL
- location_settings: PASS / FAIL
- restaurant_areas: PASS / FAIL
- tenant/location constraints: PASS / FAIL

Security Schema
- users: PASS / FAIL
- roles: PASS / FAIL
- permissions: PASS / FAIL
- role_permissions: PASS / FAIL
- user_roles: PASS / FAIL

Authentication
- Email normalization: PASS / FAIL
- Password hashing/verification: PASS / FAIL / N/A
- Valid login: PASS / FAIL
- Invalid login generic response: PASS / FAIL
- Session resolution: PASS / FAIL
- Logout: PASS / FAIL
- Disabled-user enforcement: PASS / FAIL
- Public registration absent: PASS / FAIL

Authorization
- Central permission catalog: PASS / FAIL
- Permission resolution: PASS / FAIL
- Server-side permission guard: PASS / FAIL
- Direct protected-operation denial: PASS / FAIL
- Inactive roles ignored: PASS / FAIL
- Inactive role assignments ignored: PASS / FAIL
- Location-aware authorization: PASS / FAIL

Seed Data
- Organization: PASS / FAIL
- Main location: PASS / FAIL
- Location settings: PASS / FAIL
- Dining Room: PASS / FAIL
- Bar: PASS / FAIL
- Takeout: PASS / FAIL
- Roles: PASS / FAIL
- Permissions: PASS / FAIL
- Role-permission mappings: PASS / FAIL
- Seed idempotency: PASS / FAIL

Owner Bootstrap
- Secure account creation: PASS / FAIL
- No hardcoded password: PASS / FAIL
- No credential leakage: PASS / FAIL
- Owner role assignment: PASS / FAIL
- Retry/duplicate handling: PASS / FAIL

Migrations
- Generation: PASS / FAIL
- Application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Regression
- Phase 1 database foundation tests: PASS / FAIL
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

Business Domains Created Beyond Phase 2
- NONE expected

Created / Modified
- Summarize schema, migrations, modules, auth configuration, UI, tests, scripts, and documentation.

Architecture Deviations
- None
  OR
- Describe each deviation and why it was necessary.

Outstanding Phase 2 Issues
- None
  OR
- List each unresolved issue and whether it blocks Phase 3.

Phase 3 Readiness
- READY / NOT READY
```

---

## 58. Recommended VS Code Copilot Prompt

After placing this file at `docs/Phase-2-Organization-Authentication-RBAC.md`, use:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/accepted-risks.md`, and all Phase 0 through Phase 2 implementation plans completely. Treat `README.md` as the architectural source of truth.
>
> Review the completed Phase 0 and Phase 1 implementation before modifying files. Implement Phase 2 only: Organization, Locations, Location Settings, Restaurant Areas, Authentication, Sessions, Users, Roles, Permissions, Role Permissions, location-aware User Roles, centralized permission resolution, server-side authorization, secure Owner bootstrap, Phase 2 seed data, protected application shell, permission-aware navigation, and the required automated tests.
>
> Do not implement Employees/HR or later restaurant domains. Do not merge Employee Positions with Security Roles. Do not add public registration. Preserve the Phase 1 database conventions, transaction context, migration lifecycle, exact numeric strategy, test database isolation, reset safeguards, CI behavior, and accepted-risk decisions.
>
> Before changing files, inspect the current repository and provide a concise Phase 2 execution plan. Verify current compatibility before selecting authentication package versions. After implementation, run the complete Phase 2 validation suite and provide the required Phase 2 Completion Report. If an architectural conflict is encountered, stop at that decision point and explain it before altering the architecture.

---

## Final Guardrail

Phase 2 establishes identity and authorization for the restaurant application.

It does **not** establish employment or HR identity.

The successful result is:

```text
Organization and Location foundation
          +
Secure authenticated users
          +
Permission-based authorization
          +
Location-aware role assignments
          +
Protected application shell
```

This foundation must be trustworthy before Phase 3 begins Employees and HR.
