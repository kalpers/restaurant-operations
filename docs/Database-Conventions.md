# Database Conventions

These are the conventions every domain follows when it uses PostgreSQL and Drizzle. `README.md` remains the architectural source of truth.

## Column conventions

Helpers live in `src/db/helpers/`.

| Purpose | Helper | PostgreSQL type | TypeScript value |
|---|---|---|---|
| Primary key | `uuidPrimaryKey()` | `UUID`, database-generated | `string` |
| Real-world instant | `timestamptz(name)`, `createdAt()`, `updatedAt()` | `TIMESTAMPTZ` | `Date` |
| Restaurant business date | `businessDate(name?)` | `DATE` | `YYYY-MM-DD` string |
| Calendar date (hire, effective date) | `calendarDate(name)` | `DATE` | `YYYY-MM-DD` string |
| Customer-facing money | `money(name)` | `NUMERIC(12,2)` | decimal string |
| Detailed cost | `cost(name)` | `NUMERIC(14,4)` | decimal string |
| Inventory quantity | `quantity(name)` | `NUMERIC(14,4)` | decimal string |
| Optimistic concurrency | `versionColumn()` | `INTEGER NOT NULL DEFAULT 1` | `number` |
| Deactivation | `activeColumn()` | `BOOLEAN NOT NULL DEFAULT TRUE` | `boolean` |

- **Identifiers:** human-readable numbers such as `order_number` are separate columns, never the primary key.
- **Instants:** store real instants and convert to the location's timezone only for display.
- **Business dates:** a `DATE` is separate from the instant. Its value comes from `BusinessDateService`. Never derive it by truncating a timestamp.
- **`updated_at`:** leave it off append-only tables.
- **`version`:** use it only on mutable high-contention records. See the list in `README.md` §25.
- **`active`:** use it only on configurable records, not on transactional or append-only tables.

## Exact numeric values

`NUMERIC` values travel through Drizzle and application code as **decimal strings**. Do not convert them to JavaScript `number` for authoritative money or inventory arithmetic. Do aggregation in SQL where practical; `SUM` over `NUMERIC` is exact.

No arbitrary-precision library is in use. Any domain that must do decimal arithmetic in TypeScript should raise that decision first.

PostgreSQL **rounds** extra decimal places to the column's scale without an error (`1.005` becomes `1.01` in `NUMERIC(12,2)`) and rejects values too large for the column. Domains must validate input scale themselves.

## Optimistic concurrency

```ts
const rows = await executor
  .update(table)
  .set({ ...changes, version: nextVersion(table.version) })
  .where(and(eq(table.id, id), eq(table.version, expectedVersion)))
  .returning();

return assertVersionMatched(rows, { type: "order", id });
```

No updated row raises `ConcurrencyError`, because the caller's data is stale or the record is gone.

## Transactions

Repositories and domain operations accept a `DatabaseExecutor`, which is either the database or an active transaction. Workflows open one transaction and pass it to every participant:

```ts
await withTransaction(database, async (transaction) => {
  await orders.submit(transaction, input);
  await inventory.consume(transaction, input);
});
```

- The database is always passed explicitly.
- The callback resolving commits; the callback rejecting rolls back everything.
- An operation that opens its own connection is **not** part of the unit of work.
- Do not make uncontrolled network calls inside a transaction.

## Constraints and naming

PostgreSQL constraints are the final integrity layer, in addition to application validation. Express them in the Drizzle schema so they reach migrations.

| Object | Name |
|---|---|
| Table, column | `snake_case` |
| Unique constraint | `<table>_<column>_unique` |
| Foreign key | Drizzle's generated name. If PostgreSQL's 63-character limit would truncate it, name it explicitly |
| Check constraint | `<table>_<rule>`, for example `order_items_quantity_positive` |
| Index | `<table>_<column>_idx` |
| Exclusion constraint | `<table>_no_overlap` |

Add indexes for known access patterns, foreign keys, uniqueness or measured query needs, not by default.

Drizzle's schema language can't express exclusion constraints. Put them in a custom migration (`npm run db:generate -- --custom --name=<short_description>`), and say so in a comment on the table in the schema. Drift checks don't see them, so `tests/integration/database/migrations.test.ts` asserts they exist. `employee_locations`, `employee_positions` and `employee_position_compensation` use one to refuse overlapping effective periods, treating each period as an inclusive `daterange` where a `NULL` end is open-ended. They need the `btree_gist` extension. `schedule_periods` uses a partial one, where `status = 'PUBLISHED'`, to refuse two published periods sharing a date at a location.

Prefer constrained strings and configurable tables to native PostgreSQL enums for lifecycle states.

## Deletion and history

- **Configurable or reference data:** deactivate or explicitly archive it when historical records may refer to it.
- **Transactional and history data** (orders, inventory transactions, receipts, settlements, audit events, status histories): do not physically delete it. Corrections use status changes, compensating records, effective dates or the owning domain's explicit archive behavior.

## Schema organization

Each domain gets one file under `src/db/schema/`, re-exported from `src/db/schema/index.ts`. Create a file only when its phase arrives.

## Migration lifecycle

1. Change the Drizzle schema.
2. Run `npm run db:generate -- --name=<short_description>`.
3. Review the generated SQL.
4. Run `npm run db:migrate`.
5. Run the integration tests.
6. Commit the schema, the SQL and the `meta` files together.

- Never hand-edit an applied migration. Add a new one.
- Never use schema push for a persistent environment.
- An empty database must be fully reconstructable from checked-in migrations. `tests/integration/database/migrations.test.ts` checks this on every run, and CI fails if `db:generate` would produce a change.
- `drizzle-kit migrate` prints harmless `NOTICE` objects when its metadata schema already exists. Its output is not configurable.

## Development and test databases

| | Development | Test |
|---|---|---|
| Variable | `DATABASE_URL` | `TEST_DATABASE_URL` |
| Local name | `restaurant_ops` | `restaurant_ops_test` |
| Lifecycle | Persistent; changes only through commands you run | Dropped, recreated, migrated and seeded at the start of every integration or E2E run |

### Test isolation

- Vitest and Playwright both run `tests/helpers/global-setup.ts`, which guards, recreates, migrates and seeds the test database.
- Test processes and the Playwright web server use `TEST_DATABASE_URL` as their `DATABASE_URL`.
- Integration test files run one at a time, and each test clears the tables it uses first. Tests must not depend on order or on another test's data.
- Fixture tables in `tests/fixtures/` exist only in the test database. They are not in `src/db/schema` and never reach a migration.
- Playwright never reuses a running server, because a dev server would use the development database. Stop `npm run dev` before `npm run test:e2e`.

### Test database safety conditions

The test database is recreated only when all of these hold. Otherwise the run stops before connecting.

- `NODE_ENV` is not `production`.
- Its name is exactly `<development database>_test`, using only lowercase letters, digits and underscores.
- It is on the same host and port as `DATABASE_URL`.
- The host is loopback: `localhost`, `127.0.0.1` or `::1`.
- Neither URL has query parameters or multiple hosts.

## Resetting the development database

`npm run db:reset` drops the `public` and `drizzle` schemas and rebuilds from checked-in migrations. It does not seed. It runs only when all of these hold, checked before any connection opens:

- `NODE_ENV` is explicitly `development`. Unset is refused.
- The database is named exactly `restaurant_ops`.
- The host is loopback: `localhost`, `127.0.0.1` or `::1`.
- The URL has no query parameters or multiple hosts, because the driver can read connection options from them.

**Known limit:** the guard sees only the URL. An SSH tunnel that exposes a remote database on a local port, with the same database name, in development mode, would pass. Never run this command with such a tunnel in `DATABASE_URL`.

## Seeds

`npm run db:seed` runs the seeds in `src/db/seeds/registry.ts`, in order.

```ts
export const seeds: readonly Seed[] = [
  {
    key: "organization.initial",
    run: async (transaction) => {
      // Insert stable records using the transaction.
    },
  },
];
```

- Each seed runs in its own transaction, and its key is recorded in `seed_runs` in that same transaction.
- A seed whose key is already recorded does not run.
- A failing seed rolls back its data and key and stops the run, so it can be retried.
- Keys are stable forever. To change seeded data later, add a seed with a new key rather than editing one that has run.

## CI

The workflow provides a PostgreSQL service with throwaway credentials and runs, in order: `npm ci`, `db:migrate`, a schema drift check, lint, typecheck, unit tests, integration tests, and build. It uses the same migrations and commands as local development.
