# Phase 0: Project Bootstrap Implementation Plan

## Purpose

Phase 0 creates the development foundation for the Restaurant Operations Management System. It intentionally implements **no restaurant business functionality**.

The goal is to leave the repository in a clean, reproducible, testable state that is ready for Phase 1 database development.

Before starting, read:

1. `README.md`
2. `.github/copilot-instructions.md`
3. This document

`README.md` remains the architectural source of truth.

---

## 1. Phase 0 Objectives

Create a project that:

- Runs locally with Next.js.
- Uses React and TypeScript.
- Uses the Next.js App Router.
- Uses Tailwind CSS.
- Connects to local PostgreSQL.
- Has Drizzle ORM installed and configured.
- Uses centralized environment validation.
- Has unit, integration, and E2E test infrastructure.
- Uses Docker Compose for local PostgreSQL.
- Contains the agreed architectural folder structure.
- Passes linting, type checking, tests, and production build.
- Remains compatible with the future AWS EC2 + RDS PostgreSQL POC deployment.

### Do not implement in Phase 0

Do not implement:

- Authentication or RBAC
- Employees or HR
- Scheduling
- Restaurant seating
- Reservations or waitlist
- Menu management
- Recipes or modifiers
- Inventory or purchasing
- Orders
- Kitchen or bar workflows
- Settlement functionality
- Auditing or reporting
- AWS deployment

These belong to later project phases.

---

## 2. Target Repository Structure

```text
restaurant-ops/
├── .github/
│   ├── copilot-instructions.md
│   └── workflows/
│       └── ci.yml
├── docker/
│   └── postgres/
├── drizzle/
│   └── migrations/
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
├── .gitignore
├── docker-compose.yml
├── drizzle.config.ts
├── eslint.config.mjs
├── next.config.ts
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── README.md
```

Do not create unnecessary placeholder files or empty abstractions simply to populate every directory.

---

## 3. Initialize Next.js

Create the application using:

- Next.js
- React
- TypeScript
- App Router
- Tailwind CSS
- ESLint
- `src/` source directory
- `@/` path alias for `src`

The initial page should remain simple and identify the project, for example:

```text
Restaurant Operations Management System
Development Environment
```

Do not replace the existing architecture `README.md` with the default Next.js README.

### Required initial files

```text
src/app/layout.tsx
src/app/page.tsx
src/app/globals.css
next.config.ts
tsconfig.json
eslint.config.mjs
package.json
```

### Acceptance criteria

```text
npm run dev
```

must start the application successfully.

---

## 4. Standardize Runtime and Package Management

Use the current appropriate Node.js LTS version supported by the selected Next.js version at implementation time.

Pin or document the runtime using an appropriate mechanism such as:

```text
.nvmrc
package.json engines
```

Use **npm** consistently as the package manager.

Commit:

```text
package-lock.json
```

Do not mix npm, Yarn, and pnpm in the project.

---

## 5. Install Core Dependencies

### Database

```text
drizzle-orm
postgres
```

### Database development tooling

```text
drizzle-kit
```

### Validation

```text
zod
```

### Testing

Use a modern TypeScript-compatible test runner such as:

```text
Vitest
```

Add browser E2E support with:

```text
@playwright/test
```

Do not configure authentication during Phase 0. Authentication belongs to Phase 2.

Do not install packages for future functionality unless Phase 0 actually requires them.

---

## 6. Environment Configuration

Create:

```text
.env.example
```

Initial variables should be limited to actual Phase 0 requirements, for example:

```text
NODE_ENV=
DATABASE_URL=
APP_BASE_URL=
```

Do not add unused future secrets such as payment, SMTP, AWS, or authentication credentials yet.

The real local `.env` file must be ignored by Git.

---

## 7. Central Environment Validation

Create:

```text
src/config/env.ts
```

Use Zod to validate application environment configuration.

Application configuration flow:

```text
process.env
    |
    v
Zod validation
    |
    v
Validated configuration
    |
    v
Application modules
```

Do not scatter direct `process.env` reads throughout the codebase.

Missing or malformed required configuration should fail clearly.

---

## 8. Local PostgreSQL with Docker Compose

Create:

```text
docker-compose.yml
```

Configure one PostgreSQL service for local development.

Conceptually:

```text
Docker Compose
      |
      v
PostgreSQL
      |
      ├── Development database
      ├── Application user
      └── Persistent Docker volume
```

Suggested development database name:

```text
restaurant_ops
```

Suggested application user name:

```text
restaurant_app
```

Keep credentials in environment configuration.

Do not add Redis, Kafka, RabbitMQ, Elasticsearch, pgAdmin, or other infrastructure during Phase 0 unless there is a demonstrated need.

---

## 9. PostgreSQL Health Check

Configure a Docker health check that verifies PostgreSQL is ready to accept connections.

Distinguish between:

```text
Container running
```

and:

```text
PostgreSQL ready
```

This health check should later support reliable integration-test startup.

---

## 10. Persistent Development Database

Use a named Docker volume for PostgreSQL data.

Normal operations such as:

```text
docker compose down
```

should not automatically destroy development data.

Database destruction/reset must be an intentional development operation introduced through an appropriate reset command.

---

## 11. Configure Drizzle ORM

Create:

```text
src/db/index.ts
```

Responsibilities:

```text
Validated DATABASE_URL
      |
      v
PostgreSQL connection
      |
      v
Drizzle instance
      |
      v
Export database interface
```

Do not create restaurant domain tables during Phase 0.

Phase 1 owns the database foundation and initial schema conventions.

---

## 12. Drizzle Configuration

Create:

```text
drizzle.config.ts
```

Configure:

- PostgreSQL dialect
- Drizzle schema location
- Migration output directory
- Validated database connection configuration as appropriate

Planned locations:

```text
src/db/schema/
drizzle/migrations/
```

Do not create large schema files or business-domain migrations in Phase 0.

---

## 13. Health Endpoint

Create a basic health endpoint:

```text
GET /api/health
```

It should verify the application can successfully communicate with PostgreSQL through the application's database layer.

Example response:

```json
{
  "status": "ok",
  "database": "connected"
}
```

The endpoint must not expose:

- Database hostname
- Database username
- Password
- Connection string
- AWS information
- Internal secrets

Keep the Route Handler thin.

Conceptually:

```text
/api/health
    |
    v
Health query/service
    |
    v
Database connectivity check
```

---

## 14. Test Infrastructure

Create test commands with purposes such as:

```text
npm run test
npm run test:unit
npm run test:integration
npm run test:e2e
```

Only add scripts that actually work.

### Unit test

Create at least one simple, meaningful unit test to prove the TypeScript test infrastructure works.

A suitable candidate is environment/configuration validation or another pure infrastructure helper.

### PostgreSQL integration test

Create a test such as:

```text
tests/integration/database/database-connection.test.ts
```

It should connect to PostgreSQL through the application database layer and execute a harmless query such as:

```sql
SELECT 1;
```

This establishes that future domain integration tests can use real PostgreSQL instead of relying only on mocked persistence.

---

## 15. Playwright E2E Foundation

Create:

```text
playwright.config.ts
```

Add one minimal E2E test that:

1. Opens the application.
2. Verifies the Restaurant Operations Management System title or other stable Phase 0 content.

This proves browser automation works before later restaurant workflows depend on it.

---

## 16. Package Scripts

Provide developer scripts for functions that actually exist.

Expected Phase 0 scripts should cover concepts such as:

```text
dev
build
start
lint
typecheck
test
test:unit
test:integration
test:e2e
db:generate
db:migrate
```

Do not create fake future scripts such as `db:seed` until the seed framework actually exists.

---

## 17. Explicit Type Checking

Provide a dedicated:

```text
npm run typecheck
```

command.

Do not rely exclusively on `next build` to discover TypeScript problems.

---

## 18. `.gitignore`

Ensure appropriate exclusions for:

```text
node_modules
.next
coverage
Playwright output
local environment files
local uploaded files
temporary runtime/editor files
```

The following should remain committed:

```text
.env.example
README.md
.github/copilot-instructions.md
```

Never commit real credentials or secrets.

---

## 19. Initial CI Workflow

Create:

```text
.github/workflows/ci.yml
```

Initial CI should perform approximately:

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
Lint
   |
   v
Typecheck
   |
   v
Unit Tests
   |
   v
Production Build
```

PostgreSQL-backed integration testing can be fully incorporated into CI during Phase 1 when migration/test-database initialization is established.

Do not make CI unnecessarily complex during Phase 0.

---

## 20. Preserve Architecture Documents

The repository must retain:

```text
README.md
.github/copilot-instructions.md
```

The architecture README must not be replaced by generated framework documentation.

Copilot should use the following contextual hierarchy:

```text
.github/copilot-instructions.md
        |
        v
README.md
        |
        v
Current Phase Plan
        |
        v
Implementation
```

---

## 21. Phase 0 Validation Checklist

After implementation, run every applicable validation check.

### Start PostgreSQL

```text
docker compose up -d
```

Verify PostgreSQL becomes healthy.

### Development server

```text
npm run dev
```

Verify the application loads successfully.

### Health endpoint

Verify:

```text
Next.js
 -> Drizzle
 -> PostgreSQL
```

and confirm `/api/health` reports a successful database connection without exposing sensitive configuration.

### Lint

```text
npm run lint
```

Must pass.

### Type checking

```text
npm run typecheck
```

Must pass.

### Unit tests

```text
npm run test:unit
```

Must pass.

### Integration tests

```text
npm run test:integration
```

Must pass against PostgreSQL.

### E2E tests

```text
npm run test:e2e
```

The minimal browser test must pass.

### Production build

```text
npm run build
```

Must succeed.

---

## 22. Phase 0 Deliverables

Phase 0 should leave the project with:

```text
✓ Next.js application
✓ React
✓ TypeScript
✓ Tailwind CSS
✓ App Router
✓ npm dependency management

✓ Docker Compose PostgreSQL
✓ Persistent PostgreSQL volume
✓ PostgreSQL health check

✓ Drizzle ORM
✓ Drizzle Kit configuration
✓ PostgreSQL application connectivity

✓ Zod
✓ Central environment validation

✓ Unit test infrastructure
✓ PostgreSQL integration-test foundation
✓ Playwright E2E foundation

✓ ESLint
✓ Explicit TypeScript checking
✓ Initial GitHub Actions CI

✓ Approved folder architecture
✓ Architecture README preserved
✓ Copilot instructions preserved

✓ No restaurant-domain features implemented prematurely
```

---

## 23. Definition of Done

Phase 0 is complete when a new developer can:

```text
git clone
   |
   v
npm install
   |
   v
configure .env
   |
   v
docker compose up -d
   |
   v
npm run dev
```

and obtain a working development environment without modifying application source code.

Additionally:

- PostgreSQL becomes healthy.
- The health endpoint verifies PostgreSQL connectivity.
- Lint passes.
- Typecheck passes.
- Unit tests pass.
- PostgreSQL integration tests pass.
- The minimal Playwright test passes.
- Production build succeeds.

Do not begin Phase 1 until these conditions are satisfied or any exception is explicitly documented and accepted.

---

## 24. Required Phase 0 Completion Report

When Phase 0 implementation is finished, provide:

```text
PHASE 0 COMPLETION REPORT

Environment
- Node version:
- npm version:
- Next.js version:
- PostgreSQL version:
- Drizzle version:

Created
- ...

Modified
- ...

Configuration
- ...

Database
- PostgreSQL healthy: PASS / FAIL
- Application DB connection: PASS / FAIL
- Integration DB test: PASS / FAIL

Validation
- Lint: PASS / FAIL
- Typecheck: PASS / FAIL
- Unit tests: PASS / FAIL
- Integration tests: PASS / FAIL
- E2E tests: PASS / FAIL
- Production build: PASS / FAIL

Architecture deviations
- None
  OR
- Describe each deviation and why it was necessary.

Outstanding Phase 0 issues
- None
  OR
- List every unresolved issue.

Phase 1 readiness
- READY / NOT READY
```

---

## 25. Recommended VS Code Copilot Prompt

After placing this file in the local repository, use a prompt similar to:

> Read `README.md`, `.github/copilot-instructions.md`, and this Phase 0 implementation plan completely. Treat `README.md` as the architectural source of truth and this file as the execution plan for the current phase. Inspect the repository before modifying files, then provide a concise Phase 0 execution plan based on what already exists. Implement Phase 0 only and do not implement restaurant business functionality from later phases. Preserve the defined architecture and domain boundaries. When implementation is complete, run every applicable Phase 0 validation check and provide the required Phase 0 completion report. If an architectural conflict is encountered, stop at that decision point and explain it before changing the architecture.

---

## Final Guardrail

Phase 0 is infrastructure bootstrap only.

Do not use this phase as an opportunity to begin implementing restaurant features, authentication, domain schemas, AWS deployment, or future services.

The desired result is a **small, clean, reproducible, testable development foundation** that makes Phase 1 predictable.
