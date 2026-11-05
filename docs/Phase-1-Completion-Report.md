# Phase 1 Completion Report

This report merges the plan §36 template with the sections required by README §37. Results are from this repository on 2026-11-05.

## Summary

The database foundation is complete. It is committed and pushed as `83533de`, and the project owner reports the GitHub Actions run passed.

- **Delivered:** shared column conventions, a transaction context, the migration lifecycle, empty-database reconstruction, a guarded `db:reset`, an idempotent seed framework, an isolated test database for integration and E2E tests, and PostgreSQL-backed CI.
- **Tables:** the only migrated table is the infrastructure table `seed_runs`. No restaurant business tables exist.
- **Install warnings:** plan §33 asks for `npm ci` without known unresolved tooling warnings. Install-script warnings are resolved, the audit findings are accepted as DEV-002, and three remaining deprecation warnings are accepted as DEV-003 (see Risks).

## Environment

| Component | Version |
|---|---|
| Node.js | 26.13.0 |
| npm | 12.2.0 |
| Next.js | 16.4.5 |
| PostgreSQL | 17.11 (`postgres:17-alpine`) |
| Drizzle ORM | 0.45.4 |
| Drizzle Kit | 0.31.11 |
| `postgres` driver | 4.0.0 |
| `tsx` | 4.23.15 (new dev dependency) |

## Policies

The Phase 1 plan has no "Approved Policies" section. README §33 supplied the binding specifics. The project owner made these decisions during planning:

| Topic | Decision |
|---|---|
| E2E database | Isolated now. Playwright recreates the test database and starts its own server against it |
| `npm ci` warnings | DEV-002 accepted; DEV-001 kept with a dated note, and its typo and heading fixed; esbuild install scripts explicitly denied |
| Phase 0 CI | Reported by the owner as passing for `9a24795` and `b684ed3`. This environment can't read the runs, so this is the owner's confirmation |
| `npm ci` deprecation warnings | Accepted as DEV-003 at the close of Phase 1 |

## Database conventions

The full reference is `docs/Database-Conventions.md`.

| Convention | Strategy |
|---|---|
| UUID | `UUID` primary key with database-generated `gen_random_uuid()`; business numbers are separate columns |
| Timestamps | `TIMESTAMPTZ`, read and written as JavaScript `Date` |
| Business date | Separate `DATE` as a `YYYY-MM-DD` string; the value will come from `BusinessDateService` |
| Customer money | `NUMERIC(12,2)` |
| Detailed cost | `NUMERIC(14,4)` |
| Inventory quantity | `NUMERIC(14,4)` |
| TypeScript exact numerics | Decimal strings; no arbitrary-precision library |
| Concurrency | `version INTEGER NOT NULL DEFAULT 1`; update with `WHERE id AND version`; no row raises `ConcurrencyError` |

## Architectural decisions

- **Guards are pure functions that run before any connection opens** (`src/db/maintenance/database-safety.ts`), so they can be tested with fake production URLs without network risk.
- **The guards refuse query parameters and multiple hosts.** The `postgres` driver can read connection options from a URL's query string and accepts multiple hosts, so a URL could look local while connecting elsewhere. This goes beyond the README's stated conditions.
- **`db:reset` requires an explicitly set `NODE_ENV=development`.** `getEnv()` defaults an unset value to `development`, so the guard reads the raw value.
- **The test database guard is stricter than the README.** Besides a matching `*_test` name on the same server, it requires a loopback host and non-production mode.
- **Each seed runs in its own transaction** with its key claim. A failure rolls back that seed's data and key, and earlier seeds stay applied.
- **Integration test files run one at a time** against one database that is recreated per run. This is the documented isolation strategy.
- **Fixture tables live only in the test database,** created by raw SQL in `tests/fixtures/`, so they never reach a migration. Helper SQL types are verified separately by unit tests, because the fixture DDL is handwritten.
- **Playwright never reuses a running server.** A reused dev server would run the tests against the development database, so `test:e2e` now fails with a clear error while `npm run dev` is running.
- **`db:migrate` remains `drizzle-kit migrate`,** while reset and test setup use Drizzle's migrator directly. Both read `drizzle/migrations` and the same metadata table.

### Architecture deviations

| Deviation | Reason |
|---|---|
| No `scripts/prepare-test-db.ts` (plan §4); the logic is in `tests/helpers/prepare-test-database.ts` | Vitest and Playwright both call it, and the plan marks the tree as adaptable |
| `.github/copilot-instructions.md` not used | `CLAUDE.md` replaces it, per the `/phase` instruction |

## Migrations

| Check | Result |
|---|---|
| Migration generation | PASS: only `0000_seed_runs.sql` and its metadata |
| Migration application | PASS |
| Empty DB reconstruction | PASS: in an automated test, and in a brand-new PostgreSQL container |
| Unexplained schema drift | NONE: a second `db:generate` reports no changes |

`0000_seed_runs.sql` was reviewed. It creates `seed_runs` with a UUID primary key, `seed_key TEXT NOT NULL`, `applied_at TIMESTAMPTZ NOT NULL`, and the constraint `seed_runs_seed_key_unique`.

`drizzle-kit migrate` prints `NOTICE` objects when its metadata schema already exists. They are harmless, and its output isn't configurable.

## Validation results

### Transactions

| Check | Result |
|---|---|
| Shared transaction context | PASS: work stays invisible to a second connection until commit |
| Commit behavior | PASS |
| Rollback behavior | PASS: on a thrown error and on a constraint failure |

### Development database

| Check | Result |
|---|---|
| `db:reset` | PASS: removed a probe row, rebuilt through migrations |
| Production/RDS safety guard | PASS: see below |
| `db:seed` | PASS |
| Seed idempotency | PASS: see the note below |

Real `npm run db:reset` runs, each exiting 1 with the development probe row intact afterward:

| Attempt | Refused because |
|---|---|
| `NODE_ENV=production` | `NODE_ENV` isn't development |
| `NODE_ENV=test` | `NODE_ENV` isn't development |
| Fake RDS host | Not a loopback host |
| Database `postgres` | Wrong database name |
| Database `restaurant_ops_test` | Wrong database name |
| `?host=<RDS host>` on a local URL | Has query parameters |
| `localhost,<RDS host>` | Not a loopback host |

Error output contained no URLs or credentials. Unit tests also cover an unset `NODE_ENV`, lookalike hosts, encoded names and more.

**Seed idempotency note:** the registry is empty in Phase 1, as the README requires, so `db:seed` twice proves only that the command runs repeatedly (`0 applied`). The real proof is `tests/integration/database/seed-framework.test.ts`, which uses test seeds: three runs execute once, a failure rolls back and can be retried, and two simultaneous runs apply once.

### Integration testing

| Check | Result |
|---|---|
| Separate test database | PASS: a test asserts `current_database()` is `restaurant_ops_test` |
| Test DB migration setup | PASS |
| Test isolation | PASS: a development probe row survived the test run, and no fixture tables appeared in development |
| Numeric precision | PASS |
| TIMESTAMPTZ behavior | PASS: including under a non-UTC session timezone and around a daylight-saving change |
| Transaction commit | PASS |
| Transaction rollback | PASS |
| Shared transaction context | PASS |
| Optimistic concurrency | PASS: including two simultaneous updates, where exactly one wins |
| E2E isolation | PASS: while E2E ran, the only application connection observed was to `restaurant_ops_test` |

### CI

| Check | Result |
|---|---|
| PostgreSQL service | PASS, reported by the owner |
| Migrations | PASS, reported by the owner |
| Integration tests | PASS, reported by the owner |

The project owner reports the GitHub Actions run for `83533de` completed green. This environment can't read the runs, so the result is the owner's confirmation rather than something checked directly.

Before the push, the workflow's steps also passed locally in a clean copy with no `.env`, using CI-style variables and a new, empty PostgreSQL 17 container. That included the drift check against a temporary git repository.

### Validation

| Check | Result |
|---|---|
| PostgreSQL healthy | PASS |
| `npm ci` | PASS, with 3 deprecation warnings accepted as DEV-003 (see Risks) |
| Lint | PASS |
| Typecheck | PASS |
| Unit tests | PASS: 73 of 73 |
| Integration tests | PASS: 59 of 59 |
| E2E tests | PASS: 2 of 2 |
| Production build | PASS |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities |
| `npm audit` (including dev) | 12 moderate, recorded as DEV-002 |

### Restaurant business tables created

NONE. The migrated tables are `public.seed_runs` and Drizzle's `drizzle.__drizzle_migrations`.

## Tests executed

- **Unit (`src/`, 73):** environment validation including `TEST_DATABASE_URL`, health check, column helper SQL types and defaults, `assertVersionMatched`, reset guard and test database guard.
- **Integration (`tests/integration/database/`, 59):**
  - `database-connection.test.ts`: test database identity, connectivity, health check.
  - `database-conventions.test.ts`: UUIDs and defaults, numeric round-trips and limits, `TIMESTAMPTZ`, business dates, constraints by PostgreSQL error code, concurrency.
  - `transactions.test.ts`: commit, rollback, shared context.
  - `seed-framework.test.ts`: idempotency, retry after failure, simultaneous runs, duplicate keys.
  - `migrations.test.ts`: reconstruction from empty, expected tables and columns, re-apply is a no-op, rebuild.
- **E2E (`tests/e2e/home.spec.ts`, 2):** the Phase 0 regression tests, now against the test database.

## Files changed

**Created**

- Helpers and transactions: `src/db/helpers/{columns,timestamps,numeric,versioning}.ts`, `src/db/transactions/transaction-context.ts`, `src/shared/errors/concurrency-error.ts`
- Schema and migration: `src/db/schema/seed-runs.ts`, `drizzle/migrations/0000_seed_runs.sql`, `drizzle/migrations/meta/0000_snapshot.json`
- Seeds and maintenance: `src/db/seeds/{run-seeds,registry}.ts`, `src/db/maintenance/{database-safety,apply-migrations}.ts`, `scripts/{seed,reset-db}.ts`
- Tests: `src/db/helpers/helpers.test.ts`, `src/db/maintenance/database-safety.test.ts`, `tests/fixtures/convention-fixtures.ts`, `tests/helpers/{global-setup,prepare-test-database}.ts`, `tests/integration/database/{database-conventions,transactions,seed-framework,migrations}.test.ts`
- Docs: `docs/Database-Conventions.md`, this report

**Modified**

- `package.json` and `package-lock.json`: `db:reset`, `db:seed`, `tsx`, `allowScripts`
- `.github/workflows/ci.yml`: PostgreSQL service, migrations, drift check, integration tests
- `.env.example`, `src/config/env.ts` and its test, `src/config/tooling-env.ts`: `TEST_DATABASE_URL` and tooling helpers
- `vitest.config.mts`, `playwright.config.ts`, `tests/helpers/integration-setup.ts`, `tests/integration/database/database-connection.test.ts`: test database isolation
- `src/db/schema/index.ts`, `drizzle/migrations/meta/_journal.json`
- `src/infrastructure/health/check-database-health.ts`: exported `readErrorCode` for reuse in tests
- `docs/accepted-risks.md`: DEV-002 added; DEV-001 note, heading and typo
- `CLAUDE.md`: a note to stop `npm run dev` before `test:e2e`

**Removed:** the `.gitkeep` files in `src/shared` and `tests/fixtures`, which now have content.

**Local only (gitignored):** `TEST_DATABASE_URL` added to `.env`.

`README.md` is unchanged. Its Phase 1 section already describes this design.

## Risks

**`npm ci` deprecation warnings, accepted as DEV-003.** Plan §33 asks for no known unresolved tooling warnings. These three remain, tracked in `docs/accepted-risks.md`:

| Package | Warning | Why it remains |
|---|---|---|
| `eslint@9.39.5` | "no longer supported" | Direct dependency. `eslint-plugin-react`, `-import` and `-jsx-a11y`, required by `eslint-config-next`, don't accept ESLint 10 |
| `@esbuild-kit/esm-loader@2.6.5` | Merged into `tsx` | Transitive, through `drizzle-kit` 0.31.11 |
| `@esbuild-kit/core-utils@3.3.2` | Merged into `tsx` | Transitive, through `drizzle-kit` 0.31.11 |

All three are development-only. Phase 0 had the same warnings, but its report didn't mention them because the output was filtered during validation.

**Other risks**

- **Reset guard limit:** the guard sees only the URL, so an SSH tunnel exposing a remote database on a local port, with a matching name, in development mode, would pass. This is documented in `docs/Database-Conventions.md`.
- **Handwritten fixture DDL** could drift from the Drizzle fixture definitions. It's test-only, and the helpers' SQL types are checked separately.
- **`postgres` 4.0.0** is still a new major version, but it has now passed real numeric, timestamp, transaction, concurrency and migration tests.

## Remaining issues

No Phase 1 functionality is outstanding.

**Carried over from Phase 0, both optional:** the old `restaurant-ops-postgres-1` container and volume, and the stray `C:\Users\kneal\package-lock.json`.

## Next-phase readiness

**Phase 2 readiness: READY.** All checks in plan §33 pass, with the clean-install warnings tracked as DEV-002 and DEV-003. The plan §35 lifecycle (empty database, `db:migrate`, `db:seed`, `test:integration`) runs with no manual SQL, and the owner reports CI passed for `83533de`.
