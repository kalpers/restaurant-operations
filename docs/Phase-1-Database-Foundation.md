# Phase 1: Database Foundation Implementation Plan

## Purpose

Phase 1 establishes the shared PostgreSQL and Drizzle foundation that every future restaurant domain will use.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. `docs/Phase-0-Implementation-Plan.md`
4. This document

`README.md` remains the architectural source of truth.

Phase 1 must build on the completed Phase 0 foundation without redesigning it.

---

## 1. Phase 1 Objectives

Establish and test consistent database conventions for:

- UUID primary keys
- Timezone-aware timestamps
- Business-date storage
- Exact monetary values
- Exact detailed cost values
- Exact inventory quantities
- Optimistic concurrency
- Active/inactive configuration records
- Historical/append-only records
- PostgreSQL transactions
- Shared transaction context
- Drizzle schema organization
- Drizzle migration generation and application
- Reconstruction of an empty database from migrations
- Safe development database reset
- Idempotent seed framework
- Isolated integration-test database
- Integration-test database lifecycle
- PostgreSQL-backed CI

Phase 1 answers:

> How will every future business domain safely and consistently use PostgreSQL?

---

## 2. Phase 1 Scope Boundary

Do **not** create restaurant business-domain tables during Phase 1.

Do not create tables such as:

```text
organizations
locations
users
roles
employees
positions
restaurant_tables
reservations
menu_items
recipes
inventory_items
orders
kitchen_tickets
order_settlements
```

Those belong to Phase 2 and later phases.

A small test-only fixture may be used if required to validate database conventions, but it must not become a permanent restaurant business entity.

Do not implement authentication, restaurant workflows, user interfaces, or AWS deployment in Phase 1.

---

## 3. Review the Existing Phase 0 Foundation

Before modifying files, inspect the existing repository and confirm:

- Next.js application builds.
- PostgreSQL Docker service is healthy.
- `/api/health` reaches PostgreSQL through Drizzle.
- Environment variables are centrally validated with Zod.
- Unit, integration, and E2E tests pass.
- Existing Drizzle configuration is understood.
- Existing database connection management is understood.
- Existing CI workflow is understood.
- No Phase 0 behavior is unnecessarily replaced.

Provide a concise execution plan based on the repository as it currently exists before making changes.

---

## 4. Target Database Structure

The exact implementation may be adapted to the existing Phase 0 repository, but the logical organization should remain similar to:

```text
src/db/
├── index.ts
├── schema/
│   └── index.ts
├── helpers/
│   ├── timestamps.ts
│   ├── numeric.ts
│   └── versioning.ts
└── transactions/
    └── transaction-context.ts
```

Supporting scripts may include:

```text
scripts/
├── reset-db.ts
├── seed.ts
└── prepare-test-db.ts
```

Do not create abstractions solely to satisfy this directory tree. Every helper should have a demonstrated purpose and test where appropriate.

---

## 5. UUID Primary-Key Convention

The default entity primary-key strategy is PostgreSQL UUID.

Future entity tables should normally use:

```text
id UUID PRIMARY KEY
```

with database-generated random UUID values.

Do not use auto-incrementing integers as the default entity identity strategy.

Human-readable identifiers remain separate from primary keys, for example:

```text
employee_number
order_number
purchase_order_number
location_code
```

Phase 1 should establish a clear reusable Drizzle convention for UUID primary keys without creating business tables.

---

## 6. Timestamp Convention

Use timezone-aware PostgreSQL timestamps for real-world instants.

The default database type is:

```text
TIMESTAMPTZ
```

Future examples include:

```text
created_at
updated_at
occurred_at
submitted_at
published_at
received_at
approved_at
```

Create a small reusable convention/helper for common timestamps where it makes the schema clearer.

Do not automatically add `updated_at` to append-only tables that should never change.

The system should store instants consistently and perform presentation conversion using the restaurant/location timezone later.

---

## 7. Business-Date Convention

A restaurant business date is not necessarily the same as the timestamp's calendar date because the bar may operate after midnight.

Future operational tables may persist:

```text
business_date DATE
```

This Phase does **not** implement `BusinessDateService` restaurant logic.

Phase 1 should only establish the database convention that:

- `TIMESTAMPTZ` represents the actual instant.
- `DATE` may separately represent an operational restaurant business date.
- Individual modules must not infer business date by truncating a timestamp.

The future shared BusinessDateService will be authoritative for calculating this field.

---

## 8. Monetary Precision Convention

Use exact PostgreSQL numeric values for money.

Customer-facing money should generally use:

```text
NUMERIC(12,2)
```

Future examples:

```text
menu price
order subtotal
order discount
settlement amount
tip amount
```

Do not use PostgreSQL floating-point types for authoritative monetary values.

Do not use ordinary JavaScript floating-point arithmetic as the authoritative source for money calculations.

---

## 9. Detailed Cost Precision Convention

Detailed ingredient, inventory, and supplier unit costs require more precision than customer-facing currency.

Use a convention such as:

```text
NUMERIC(14,4)
```

Future examples:

```text
ingredient unit cost
weighted-average inventory cost
supplier unit cost
recipe cost components
```

Avoid rounding these values prematurely to two decimal places.

---

## 10. Inventory Quantity Precision Convention

Inventory quantities must support fractional values.

Use a fixed-precision convention such as:

```text
NUMERIC(14,4)
```

It must support values such as:

```text
8.0000 oz
44.3600 ml
0.2500 lb
3.7500 portions
```

Do not use PostgreSQL floating-point columns for authoritative inventory quantities.

---

## 11. TypeScript Exact-Numeric Strategy

Establish and document how PostgreSQL `NUMERIC` data is handled by Drizzle and application TypeScript code.

The strategy must avoid silently converting exact financial or inventory values into imprecise JavaScript floating-point arithmetic.

Phase 1 must include integration tests demonstrating the chosen representation preserves values such as:

```text
123.4567
0.1000
999999.9999
```

Do not introduce an arbitrary precision library unless it is required by the chosen domain calculation approach. If one is introduced, document the reason before adopting it project-wide.

---

## 12. Optimistic Concurrency Convention

Establish a reusable convention for mutable high-contention records:

```text
version INTEGER NOT NULL DEFAULT 1
```

Future entities that may use this include:

```text
orders
order_items
employees
schedule_periods
reservations
table_sessions
inventory_counts
```

The expected update pattern is conceptually:

```text
Read row with version = 7

Update WHERE:
  id = requested_id
  AND version = 7

Successful update:
  version becomes 8

No matching row:
  concurrency conflict
```

Phase 1 should establish a reusable pattern/helper where useful and include a test demonstrating stale-version detection.

Do not add a `version` column to every table indiscriminately.

---

## 13. Active/Inactive Convention

Configurable entities frequently need lifecycle control without deletion.

The common convention is:

```text
active BOOLEAN NOT NULL DEFAULT TRUE
```

Future examples include:

```text
roles
positions
menu_items
inventory_items
suppliers
prep_stations
```

Do not add `active` to append-only or transactional tables where lifecycle status, reversal, or history is the correct mechanism.

---

## 14. Deletion and History Convention

Document and enforce the project principle:

### Configurable/reference data

Prefer deactivation or explicit archival when historical references may exist.

### Transactional/history data

Do not physically delete normal historical records such as future:

```text
orders
inventory_transactions
receipts
settlements
audit_events
status histories
```

Corrections use status changes, compensating records, effective dates, or explicit archive behavior according to the owning domain.

Phase 1 does not implement those tables. It establishes the convention future phases must follow.

---

## 15. Database Executor / Transaction Context

Create a small shared database execution type/pattern that future repositories/services can use with either:

```text
normal Drizzle database connection
```

or:

```text
an active Drizzle PostgreSQL transaction
```

The purpose is to enable future cross-domain workflows to coordinate several domain operations inside one database transaction.

Conceptually:

```text
SubmitOrderItemsWorkflow
      |
      v
db.transaction(tx => {
    Orders operation using tx
    Recipe operation using tx
    Inventory operation using tx
    Kitchen operation using tx
    Audit operation using tx
})
```

All participating operations use the same transaction context.

Avoid complicated generic repository frameworks.

Do not create nested independent connections that undermine atomicity.

---

## 16. Transaction Tests

Create integration tests proving transaction behavior.

### Commit test

Perform multiple test-fixture operations inside one transaction and verify all persist after commit.

### Rollback test

Conceptually:

```text
BEGIN
Create fixture record A
Create fixture record B
Throw deliberate error
ROLLBACK
```

Verify neither record remains.

### Shared-context test

Verify multiple repository/helper operations can use the same transaction object and participate in the same atomic unit of work.

These tests must use test-only data rather than restaurant business tables.

---

## 17. Drizzle Schema Organization

Keep the application schema entry point under:

```text
src/db/schema/
```

Phase 1 should establish the export/import convention future domain schema files will use.

Future shape:

```text
src/db/schema/
├── organization.ts
├── auth.ts
├── employees.ts
├── scheduling.ts
├── restaurant.ts
├── reservations.ts
├── menu.ts
├── recipes.ts
├── inventory.ts
├── orders.ts
├── kitchen.ts
├── settlements.ts
├── notifications.ts
├── audit.ts
├── outbox.ts
└── index.ts
```

Do not create all of these files prematurely unless the existing tooling requires an empty export structure.

---

## 18. Migration Lifecycle

Formally establish the migration lifecycle:

```text
Modify Drizzle schema
       |
       v
Generate migration
       |
       v
Review generated SQL
       |
       v
Apply migration
       |
       v
Run integration tests
```

Package scripts should support the actual implementation, conceptually:

```text
npm run db:generate
npm run db:migrate
```

Generated migrations must be committed to source control.

Do not rely on uncontrolled schema synchronization for persistent shared environments.

---

## 19. Empty-Database Reconstruction

Add an automated or scripted verification proving that a completely empty test/development PostgreSQL database can be initialized solely from the checked-in migration history.

Required behavior:

```text
Empty PostgreSQL database
       |
       v
Apply migrations in order
       |
       v
Expected schema state
       |
       v
Integration tests pass
```

No manual SQL changes should be required.

This becomes a permanent project invariant.

---

## 20. Safe Development Database Reset

Create an intentional development-only reset mechanism, conceptually:

```text
npm run db:reset
```

The reset process should:

1. Validate that the target environment is safe to reset.
2. Refuse production-like environments.
3. Reset/recreate the intended development database/schema.
4. Apply all checked-in migrations.
5. Leave the DB in a known state.
6. Optionally invoke seeds only if clearly designed and documented.

### Required safety guard

A reset attempt must fail safely for production environments.

It must not be possible to casually run the reset command against the future AWS POC/production-style RDS environment simply because a `DATABASE_URL` was changed.

Document the exact safety conditions implemented.

---

## 21. Seed Framework

Create a seed framework and working command:

```text
npm run db:seed
```

Phase 1 does not need realistic restaurant records yet.

The framework must be designed so future seed operations are idempotent.

Conceptually:

```text
seed
seed
seed
```

must not create duplicate stable records.

If a tiny seed marker/test fixture is required to prove idempotency, keep it clearly infrastructure/test oriented and do not invent restaurant business entities.

The real organization, roles, location, workers, menu, and inventory seeds arrive in later phases.

---

## 22. Separate Integration-Test Database

Do not run automated integration tests against the developer's normal database.

Use separate configuration such as:

```text
DATABASE_URL
```

for development and:

```text
TEST_DATABASE_URL
```

for integration testing.

Example logical databases:

```text
restaurant_ops
restaurant_ops_test
```

Central environment validation should support the test configuration without weakening production configuration rules.

---

## 23. Integration-Test Database Lifecycle

Establish a predictable lifecycle:

```text
PostgreSQL available
      |
      v
Prepare test database
      |
      v
Apply migrations
      |
      v
Establish clean state
      |
      v
Run integration tests
      |
      v
Clean/reset as needed
```

Tests must not depend on execution order.

One test may not depend on data that another test happened to create.

Prefer transaction rollback, fixture teardown, truncate/reset, or another deterministic strategy appropriate to the test architecture.

Document the chosen isolation strategy.

---

## 24. Numeric Precision Integration Tests

Add tests demonstrating that exact numeric values survive the complete path:

```text
Test code
 -> Drizzle
 -> PostgreSQL NUMERIC
 -> Drizzle
 -> Test assertion
```

Test values should include fractional and boundary-relevant values.

The purpose is to lock down behavior before inventory and pricing domains depend on it.

---

## 25. TIMESTAMPTZ Integration Tests

Add tests proving timezone-aware timestamps preserve the intended instant when written and read through PostgreSQL/Drizzle.

Do not implement restaurant business-date calculation in these tests.

The purpose is to verify the persistence representation and driver behavior only.

---

## 26. Optimistic-Concurrency Integration Test

Use test-only fixture data to prove the versioning convention.

Conceptual scenario:

```text
Record version = 1

Client A updates version 1
 -> succeeds
 -> version = 2

Client B attempts update using expected version 1
 -> no update
 -> concurrency conflict detected
```

This test establishes the pattern future domains will reuse.

---

## 27. PostgreSQL Constraints and Indexing Conventions

Establish how this project expresses and tests:

- Primary keys
- Foreign keys
- Unique constraints
- Check constraints
- Indexes

Use only test/infrastructure fixtures as necessary during Phase 1.

Do not invent permanent domain tables just to demonstrate constraints.

Future database design should prefer real PostgreSQL constraints in addition to application validation.

Do not add indexes indiscriminately. Indexes should support known access patterns, foreign-key relationships, uniqueness, or measured query needs.

---

## 28. PostgreSQL-Enabled CI

Enhance the Phase 0 CI workflow so CI can run PostgreSQL-backed database validation.

The CI lifecycle should conceptually include:

```text
Checkout
   |
   v
Configure Node.js
   |
   v
npm ci
   |
   v
Start/provide PostgreSQL service
   |
   v
Apply migrations
   |
   v
Lint
   |
   v
Typecheck
   |
   v
Unit tests
   |
   v
Integration tests
   |
   v
Production build
```

Reuse the same migration path used locally.

Do not create a CI-only database schema approach that differs from development.

Avoid placing real credentials in the workflow.

---

## 29. E2E Regression

The Phase 0 minimal E2E test must continue to pass.

Phase 1 does not add restaurant browser workflows.

Run:

```text
npm run test:e2e
```

as part of final local validation even if E2E is not yet part of every CI execution.

---

## 30. Database Scripts

At the end of Phase 1, package scripts should support the implemented database lifecycle.

Expected concepts include:

```text
npm run db:generate
npm run db:migrate
npm run db:reset
npm run db:seed
npm run test:integration
```

Optionally add a local inspection command such as Drizzle Studio only if useful and correctly configured.

Every declared script must work.

---

## 31. Documentation Updates

Update project documentation only where Phase 1 additions need to be recorded.

Document:

- Database migration commands
- Safe reset behavior
- Development database versus test database
- Seed command
- Numeric representation decision
- Transaction context pattern
- CI integration-test behavior

Do not replace or significantly rewrite the architecture sections of `README.md` unless a confirmed architecture change is required.

If an architecture conflict is found, stop and report it before implementing the change.

---

## 32. Avoid Premature Abstraction

Phase 1 must not create an enterprise framework around Drizzle.

Avoid unnecessary constructs such as:

```text
UniversalEntityBase
GenericRepositoryFactory
AbstractDataAccessManager
DatabaseObjectServiceFactory
```

The intent is consistency, not hiding PostgreSQL or Drizzle.

Prefer small, transparent, typed helpers.

---

## 33. Phase 1 Validation Checklist

After implementation, run all applicable checks from a known environment.

### PostgreSQL

```text
docker compose up -d
docker compose ps
```

PostgreSQL must report healthy.

### Clean dependency installation

```text
npm ci
```

Must succeed without known unresolved tooling warnings.

### Migration generation

```text
npm run db:generate
```

Must succeed and generate only expected changes.

A clean second run should not produce unexplained schema drift.

### Migration application

```text
npm run db:migrate
```

Must succeed.

### Empty-database reconstruction

Reset/create an empty safe test/development database and prove all migrations reconstruct it successfully.

### Seed framework

```text
npm run db:seed
npm run db:seed
```

Both runs must succeed and the second run must not create duplicate stable seed state.

### Database reset

```text
npm run db:reset
```

Must succeed against the intended development database and rebuild through migrations.

The production/RDS safety guard must be tested without endangering a real remote database.

### Static validation

```text
npm run lint
npm run typecheck
```

Both must pass.

### Unit tests

```text
npm run test:unit
```

Must pass.

### Integration tests

```text
npm run test:integration
```

Must pass against the isolated test database.

Integration coverage must include:

- DB connectivity
- Numeric precision
- TIMESTAMPTZ round-trip
- Transaction commit
- Transaction rollback
- Shared transaction context
- Optimistic concurrency convention
- Seed idempotency or equivalent seed-framework proof
- Migration initialization behavior

### E2E regression

```text
npm run test:e2e
```

Must pass.

### Production build

```text
npm run build
```

Must pass.

---

## 34. Phase 1 Deliverables

Phase 1 should leave the repository with:

```text
✓ Shared Drizzle database conventions
✓ UUID primary-key convention
✓ TIMESTAMPTZ convention
✓ Business-date persistence convention
✓ Customer-money precision convention
✓ Detailed-cost precision convention
✓ Inventory-quantity precision convention
✓ Tested exact-numeric TypeScript strategy
✓ Optimistic concurrency convention
✓ Active/inactive convention
✓ Historical deletion/reversal convention documented
✓ Shared database/transaction execution context
✓ Commit and rollback tests
✓ Drizzle migration lifecycle
✓ Checked-in migrations
✓ Empty-database reconstruction validation
✓ Safe development DB reset
✓ Production/RDS reset guard
✓ Idempotent seed framework
✓ Separate integration-test database
✓ Deterministic integration-test lifecycle
✓ PostgreSQL-enabled CI
✓ Numeric precision integration tests
✓ TIMESTAMPTZ integration tests
✓ Concurrency integration tests
✓ Phase 0 E2E regression still passing
✓ No restaurant business-domain tables prematurely created
```

---

## 35. Phase 1 Definition of Done

Phase 1 is complete when a developer or CI environment can begin from an empty PostgreSQL database and execute the supported database lifecycle without manual SQL intervention.

Conceptually:

```text
Empty PostgreSQL
       |
       v
npm run db:migrate
       |
       v
Database initialized from checked-in migrations
       |
       v
npm run db:seed
       |
       v
Seed framework succeeds idempotently
       |
       v
npm run test:integration
       |
       v
All database foundation tests pass
```

And the full validation suite passes:

```text
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:e2e
npm run build
```

Phase 1 is **not complete** if database reconstruction depends on undocumented manual changes.

Phase 1 is **not complete** if integration tests share the developer's normal database.

Phase 1 is **not complete** if database reset can target a production-like environment without an explicit safety failure.

---

## 36. Required Phase 1 Completion Report

When Phase 1 is complete, provide the following report:

```text
PHASE 1 COMPLETION REPORT

Environment
- Node version:
- npm version:
- Next.js version:
- PostgreSQL version:
- Drizzle ORM version:
- Drizzle Kit version:

Database Conventions
- UUID strategy:
- Timestamp strategy:
- Business-date storage strategy:
- Customer money strategy:
- Detailed cost strategy:
- Inventory quantity strategy:
- TypeScript exact-numeric strategy:
- Concurrency strategy:

Migrations
- Migration generation: PASS / FAIL
- Migration application: PASS / FAIL
- Empty DB reconstruction: PASS / FAIL
- Unexplained schema drift: NONE / describe

Transactions
- Shared transaction context: PASS / FAIL
- Commit behavior: PASS / FAIL
- Rollback behavior: PASS / FAIL

Development Database
- db:reset: PASS / FAIL
- production/RDS safety guard: PASS / FAIL
- db:seed: PASS / FAIL
- seed idempotency: PASS / FAIL

Integration Testing
- Separate test database: PASS / FAIL
- Test DB migration setup: PASS / FAIL
- Test isolation: PASS / FAIL
- Numeric precision: PASS / FAIL
- TIMESTAMPTZ behavior: PASS / FAIL
- Transaction commit: PASS / FAIL
- Transaction rollback: PASS / FAIL
- Shared transaction context: PASS / FAIL
- Optimistic concurrency: PASS / FAIL

CI
- PostgreSQL service: PASS / FAIL
- Migrations: PASS / FAIL
- Integration tests: PASS / FAIL

Validation
- npm ci: PASS / FAIL
- lint: PASS / FAIL
- typecheck: PASS / FAIL
- unit tests: PASS / FAIL
- integration tests: PASS / FAIL
- E2E tests: PASS / FAIL
- production build: PASS / FAIL

Restaurant Business Tables Created
- NONE expected

Created / Modified
- Summarize files, scripts, migrations, and CI changes.

Architecture Deviations
- None
  OR
- Describe each deviation and why it was necessary.

Outstanding Phase 1 Issues
- None
  OR
- List every unresolved issue.

Phase 2 Readiness
- READY / NOT READY
```

---

## 37. Recommended VS Code Copilot Prompt

Use the following prompt after this document is placed in `docs/Phase-1-Database-Foundation.md`:

> Read `README.md`, `.github/copilot-instructions.md`, `docs/Phase-0-Implementation-Plan.md`, and `docs/Phase-1-Database-Foundation.md` completely. Treat `README.md` as the architectural source of truth. Review the existing Phase 0 implementation before making changes.
>
> Implement Phase 1 only. Establish the shared PostgreSQL and Drizzle database foundation, including UUID/timestamp/numeric/concurrency conventions, a shared transaction context, the migration lifecycle, empty-database reconstruction, a safe development database reset, an idempotent seed framework, an isolated integration-test database lifecycle, database foundation integration tests, and PostgreSQL-enabled CI.
>
> Do not create restaurant-domain tables such as organizations, users, employees, menu items, recipes, inventory items, orders, reservations, restaurant tables, kitchen tickets, or settlements during Phase 1.
>
> Before modifying files, inspect the repository and provide a concise execution plan based on the current implementation. Preserve the existing working Phase 0 functionality and architectural boundaries. After implementation, run all Phase 1 validation checks and provide the required Phase 1 Completion Report. If you encounter an architectural conflict, stop at that decision point and explain it before changing the architecture.

---

## Final Guardrail

Phase 1 creates the **database foundation**, not the restaurant database model.

The correct result is a small, reliable, repeatable PostgreSQL/Drizzle platform upon which Phase 2 can safely create the first real domains:

```text
Organization
Locations
Authentication
RBAC
```

Do not sacrifice database correctness or the migration/test lifecycle to reach domain implementation sooner.
