import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { checkDatabaseHealth } from "@/infrastructure/health/check-database-health";

describe("application database layer", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("uses the isolated test database, never the development database", async () => {
    const rows = await getDatabase().execute(
      sql`SELECT current_database() AS name`,
    );

    expect(rows).toEqual([{ name: "restaurant_ops_test" }]);
  });

  it("executes a query against PostgreSQL", async () => {
    const rows = await getDatabase().execute(sql`SELECT 1 AS value`);

    expect(rows).toEqual([{ value: 1 }]);
  });

  it("reports healthy through the health check", async () => {
    await expect(checkDatabaseHealth(getDatabase)).resolves.toEqual({
      status: "ok",
      database: "connected",
    });
  });

  // Later phases rely on these driver behaviors, and `postgres` 4 is a new major version.
  it("returns NUMERIC values as exact decimal strings", async () => {
    const rows = await getDatabase().execute(
      sql`SELECT 1234567890.1234::NUMERIC(14,4) AS quantity`,
    );

    expect(rows).toEqual([{ quantity: "1234567890.1234" }]);
  });

  it("runs Drizzle transactions and rolls back on failure", async () => {
    const database = getDatabase();
    const rollback = new Error("rollback requested by test");

    const findProbe = sql`SELECT to_regclass('public.phase_zero_probe')::text AS probe`;

    await expect(
      database.transaction(async (transaction) => {
        await transaction.execute(
          sql`CREATE TABLE public.phase_zero_probe (id INTEGER)`,
        );
        // Visible inside the transaction, so the check below cannot pass vacuously.
        expect(await transaction.execute(findProbe)).toEqual([
          { probe: "phase_zero_probe" },
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    expect(await database.execute(findProbe)).toEqual([{ probe: null }]);
  });
});
