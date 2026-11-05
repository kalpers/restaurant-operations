import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { requireTestDatabaseUrl } from "@/config/tooling-env";
import {
  applyMigrations,
  MIGRATIONS_FOLDER,
  rebuildFromMigrations,
} from "@/db/maintenance/apply-migrations";

import {
  dropDatabase,
  recreateEmptyDatabase,
} from "../../helpers/prepare-test-database";

const RECONSTRUCTION_DATABASE = "restaurant_ops_test_reconstruction";

const EXPECTED_TABLES = [
  "drizzle.__drizzle_migrations",
  "public.location_settings",
  "public.locations",
  "public.organizations",
  "public.permissions",
  "public.restaurant_areas",
  "public.role_permissions",
  "public.roles",
  "public.seed_runs",
  "public.user_roles",
  "public.users",
];

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as { entries: unknown[] };

describe("reconstruction from checked-in migrations", () => {
  let databaseUrl: string;

  async function query<Row extends Record<string, unknown>>(
    statement: string,
  ): Promise<Row[]> {
    const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

    try {
      return (await client.unsafe(statement)) as unknown as Row[];
    } finally {
      await client.end();
    }
  }

  const listTables = () =>
    query<{ table_name: string }>(`
      SELECT schemaname || '.' || tablename AS table_name
      FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1
    `).then((rows) => rows.map((row) => row.table_name));

  const countAppliedMigrations = () =>
    query<{ total: string }>(
      "SELECT count(*) AS total FROM drizzle.__drizzle_migrations",
    ).then((rows) => Number(rows[0]?.total));

  beforeEach(async () => {
    databaseUrl = await recreateEmptyDatabase(
      requireTestDatabaseUrl(),
      RECONSTRUCTION_DATABASE,
    );
  });

  afterAll(async () => {
    await dropDatabase(requireTestDatabaseUrl(), RECONSTRUCTION_DATABASE);
  });

  it("starts from a database with no tables", async () => {
    expect(await listTables()).toEqual([]);
  });

  it("creates exactly the expected tables and none from later phases", async () => {
    await applyMigrations(databaseUrl);

    expect(await listTables()).toEqual(EXPECTED_TABLES);
  });

  it("keeps organization and security data from cascading on delete", async () => {
    await applyMigrations(databaseUrl);

    const foreignKeys = await query<{ conname: string; confdeltype: string }>(`
      SELECT conname, confdeltype FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `);

    expect(foreignKeys.length).toBeGreaterThan(0);
    // 'r' is RESTRICT.
    expect(foreignKeys.filter((key) => key.confdeltype !== "r")).toEqual([]);
  });

  it("applies every migration in the journal", async () => {
    await applyMigrations(databaseUrl);

    expect(journal.entries.length).toBeGreaterThan(0);
    expect(await countAppliedMigrations()).toBe(journal.entries.length);
  });

  it("creates seed_runs with the project's column conventions", async () => {
    await applyMigrations(databaseUrl);

    const columns = await query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'seed_runs'
      ORDER BY ordinal_position
    `);

    expect(columns).toEqual([
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "seed_key", data_type: "text", is_nullable: "NO" },
      {
        column_name: "applied_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      },
    ]);
  });

  it("makes seed keys unique", async () => {
    await applyMigrations(databaseUrl);

    const constraints = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'public.seed_runs'::regclass AND contype = 'u'
    `);

    expect(constraints).toEqual([{ conname: "seed_runs_seed_key_unique" }]);
  });

  it("does nothing when migrations are applied again", async () => {
    await applyMigrations(databaseUrl);
    await query("INSERT INTO seed_runs (seed_key) VALUES ('fixture.kept')");

    await applyMigrations(databaseUrl);

    expect(await countAppliedMigrations()).toBe(journal.entries.length);
    expect(await query("SELECT seed_key FROM seed_runs")).toEqual([
      { seed_key: "fixture.kept" },
    ]);
  });

  it("rebuilds to the same state, removing all data and extra tables", async () => {
    await applyMigrations(databaseUrl);
    await query("INSERT INTO seed_runs (seed_key) VALUES ('fixture.removed')");
    await query("CREATE TABLE public.left_behind (id INTEGER)");

    await rebuildFromMigrations(databaseUrl);

    expect(await listTables()).toEqual(EXPECTED_TABLES);
    expect(await query("SELECT seed_key FROM seed_runs")).toEqual([]);
    expect(await countAppliedMigrations()).toBe(journal.entries.length);
  });
});
