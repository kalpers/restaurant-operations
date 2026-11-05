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
  "public.certification_types",
  "public.employee_addresses",
  "public.employee_availability",
  "public.employee_availability_exceptions",
  "public.employee_certifications",
  "public.employee_disciplinary_actions",
  "public.employee_documents",
  "public.employee_emergency_contacts",
  "public.employee_locations",
  "public.employee_notes",
  "public.employee_performance_reviews",
  "public.employee_position_compensation",
  "public.employee_positions",
  "public.employee_scheduling_preferences",
  "public.employee_status_history",
  "public.employees",
  "public.location_settings",
  "public.locations",
  "public.organizations",
  "public.permissions",
  "public.positions",
  "public.restaurant_areas",
  "public.role_permissions",
  "public.roles",
  "public.schedule_generation_runs",
  "public.schedule_periods",
  "public.scheduling_rules",
  "public.seed_runs",
  "public.shift_assignments",
  "public.shift_swap_requests",
  "public.shifts",
  "public.staffing_template_requirements",
  "public.staffing_templates",
  "public.time_off_requests",
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

  it("creates the overlap protections that the schema language can't express", async () => {
    await applyMigrations(databaseUrl);

    const constraints = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE contype = 'x' AND connamespace = 'public'::regnamespace
      ORDER BY conname
    `);

    expect(constraints.map((row) => row.conname)).toEqual([
      "employee_locations_no_overlap",
      "employee_position_compensation_no_overlap",
      "employee_positions_no_overlap",
      "schedule_periods_no_overlap",
    ]);
  });

  it("names every foreign key within PostgreSQL's limit, unambiguously", async () => {
    await applyMigrations(databaseUrl);

    const names = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
    `);

    // A truncated name is exactly 63 characters; the generated ones here are shorter.
    expect(names.filter((row) => row.conname.length >= 63)).toEqual([]);
  });

  it("gives positions no wage column", async () => {
    await applyMigrations(databaseUrl);

    const columns = await query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'positions'
    `);

    expect(columns.map((row) => row.column_name).sort()).toEqual([
      "active",
      "code",
      "created_at",
      "description",
      "id",
      "name",
      "organization_id",
      "updated_at",
      "version",
    ]);
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
